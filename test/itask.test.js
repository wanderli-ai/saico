'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const Itask = require('../itask.js');
const { Store } = require('../store.js');

describe('Itask', function () {
    let sandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        if (process.env.PROD)
            sandbox.stub(console, 'log');
        // Clear root registry before each test
        Itask.root.clear();
        Store.instance = null;
    });

    afterEach(() => {
        sandbox.restore();
        Itask.root.clear();
        Store.instance = null;
    });

    describe('constructor', () => {
        it('should create a task with default values', () => {
            const task = new Itask({ name: 'test', async: true }, []);
            expect(task.name).to.equal('test');
            expect(task.running).to.be.false;
            expect(task._completed).to.be.false;
            expect(task.id).to.be.a('string');
        });

        it('should register task in root if no parent', () => {
            const task = new Itask({ name: 'root-task', async: true }, []);
            expect(Itask.root.has(task)).to.be.true;
        });

        it('should accept string as options', () => {
            const task = Itask('my-task');
            expect(task.name).to.equal('my-task');
        });

        it('should accept function as states', () => {
            const fn = function test() { return 42; };
            const task = new Itask({ name: 'test', async: true }, [fn]);
            expect(task.funcs).to.have.length(1);
        });

        it('should initialize context-related properties', () => {
            const task = new Itask({
                name: 'ctx-task',
                prompt: 'Test prompt',
                async: true
            }, []);
            expect(task.prompt).to.equal('Test prompt');
            expect(task.context).to.be.null;
        });

        it('should initialize context_id as null by default', () => {
            const task = new Itask({ name: 'test', async: true }, []);
            expect(task.context_id).to.be.null;
        });

        it('should accept explicit context_id', () => {
            const task = new Itask({ name: 'test', context_id: 'custom-id', async: true }, []);
            expect(task.context_id).to.equal('custom-id');
        });

        it('should accept store option', () => {
            const mockStore = { generateId: () => 'mock-id', save: () => {}, load: () => {} };
            const task = new Itask({ name: 'test', store: mockStore, async: true }, []);
            expect(task._store).to.equal(mockStore);
        });
    });

    describe('state parsing', () => {
        it('should parse catch state', async () => {
            const task = new Itask({ name: 'catch-test' }, [
                function main() { throw new Error('test'); },
                function catch$handler() { return 'caught'; }
            ]);

            await task;
            expect(task.retval).to.equal('caught');
            expect(task.error).to.be.undefined;
        });

        it('should parse finally state', async () => {
            let finallyCalled = false;
            const task = new Itask({ name: 'finally-test' }, [
                function main() { return 'done'; },
                function finally$cleanup() { finallyCalled = true; }
            ]);

            await task;
            expect(finallyCalled).to.be.true;
        });

        it('should parse cancel state', () => {
            const task = new Itask({ name: 'cancel-test', cancel: true, async: true }, [
                function main() { return 42; },
                function cancel$cleanup() { return 'cleanup'; }
            ]);

            // Verify cancel state is properly parsed
            expect(task._cancel_state_idx).to.equal(1);
            expect(task.states[1].cancel).to.be.true;
            expect(task.states[1].aux).to.be.true;
            expect(task.states[0].cancel).to.be.false;
        });
    });

    describe('spawn', () => {
        it('should spawn child task', async () => {
            const parent = new Itask({ name: 'parent', async: true }, []);
            const child = new Itask({ name: 'child', async: true }, []);

            parent.spawn(child);

            expect(child.parent).to.equal(parent);
            expect(parent.child.has(child)).to.be.true;
        });

        it('should remove child from root registry when spawned', () => {
            const parent = new Itask({ name: 'parent', async: true }, []);
            const child = new Itask({ name: 'child', async: true }, []);

            expect(Itask.root.has(child)).to.be.true;

            parent.spawn(child);

            expect(Itask.root.has(child)).to.be.false;
        });

        it('should wrap promise in task when spawning', () => {
            const parent = new Itask({ name: 'parent', async: true }, []);
            const promise = Promise.resolve(42);

            const wrapped = parent.spawn(promise);

            expect(wrapped).to.be.instanceOf(Itask);
            expect(parent.child.has(wrapped)).to.be.true;
        });
    });

    describe('thenable interface', () => {
        it('should resolve with return value', async () => {
            const task = new Itask({ name: 'resolve-test' }, [
                function() { return 42; }
            ]);

            const result = await task;
            expect(result).to.equal(42);
        });

        it('should reject with error', async () => {
            const task = new Itask({ name: 'reject-test' }, [
                function() { throw new Error('test error'); }
            ]);

            try {
                await task;
                expect.fail('Should have thrown');
            } catch (err) {
                expect(err.message).to.equal('test error');
            }
        });

        it('should handle async functions', async () => {
            const task = new Itask({ name: 'async-test' }, [
                async function() {
                    await new Promise(r => setTimeout(r, 10));
                    return 'async result';
                }
            ]);

            const result = await task;
            expect(result).to.equal('async result');
        });
    });

    describe('cancellation', () => {
        it('should cancel task', async () => {
            const task = new Itask({ name: 'cancelable', async: true, cancel: true }, [
                function() { return this.wait(); }
            ]);

            await new Promise(resolve => setTimeout(resolve, 10));
            task._ecancel();
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(task.error).to.be.instanceOf(Error);
            expect(task.error.message).to.equal('cancelled');
        });

        it('should cancel child tasks', async () => {
            const parent = new Itask({ name: 'parent', async: true }, [
                function() { return this.wait(); }
            ]);
            const child = new Itask({ name: 'child', async: true }, [
                function() { return this.wait(); }
            ]);

            parent.spawn(child);
            await new Promise(resolve => setTimeout(resolve, 10));

            parent._ecancel();
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(child.error).to.be.instanceOf(Error);
        });
    });

    describe('context management', () => {
        it('should return null for getContext when no context', () => {
            const task = new Itask({ name: 'test', async: true }, []);
            expect(task.getContext()).to.be.null;
        });

        it('should set and get context', () => {
            const task = new Itask({ name: 'test', async: true }, []);
            const mockContext = { prompt: 'test' };

            task.setContext(mockContext);

            expect(task.context).to.equal(mockContext);
        });

        it('should generate context_id when setting context', () => {
            const task = new Itask({ name: 'test', async: true }, []);
            const mockContext = { prompt: 'test' };

            task.setContext(mockContext);

            expect(task.context_id).to.be.a('string');
            expect(task.context_id.length).to.be.greaterThan(0);
        });

        it('should set context tag to context_id', () => {
            const task = new Itask({ name: 'test', async: true }, []);
            const mockContext = { prompt: 'test', tag: null };

            task.setContext(mockContext);

            expect(mockContext.tag).to.equal(task.context_id);
        });

        it('should get ancestor contexts', () => {
            const parent = new Itask({ name: 'parent', async: true }, []);
            const child = new Itask({ name: 'child', async: true }, []);
            parent.spawn(child);

            parent.context = { prompt: 'parent' };
            child.context = { prompt: 'child' };

            const ancestors = child.getAncestorContexts();
            expect(ancestors).to.have.length(2);
            expect(ancestors[0].prompt).to.equal('parent');
            expect(ancestors[1].prompt).to.equal('child');
        });

        it('should find nearest context in hierarchy', () => {
            const parent = new Itask({ name: 'parent', async: true }, []);
            const child = new Itask({ name: 'child', async: true }, []);
            parent.spawn(child);

            parent.context = { prompt: 'parent' };

            expect(child.findContext()).to.equal(parent.context);
        });

        it('should aggregate functions from hierarchy', () => {
            const parent = new Itask({ name: 'parent', async: true, functions: [{ name: 'a' }] }, []);
            const child = new Itask({ name: 'child', async: true, functions: [{ name: 'b' }] }, []);
            parent.spawn(child);

            parent.context = { functions: [{ name: 'a' }] };
            child.context = { functions: [{ name: 'b' }] };

            const funcs = child.getHierarchyFunctions();
            expect(funcs).to.have.length(2);
        });
    });

    describe('utilities', () => {
        it('should sleep for specified duration', async () => {
            const start = Date.now();
            await Itask.sleep(50);
            const elapsed = Date.now() - start;
            expect(elapsed).to.be.at.least(45);
        });

        it('should wait for all tasks with Itask.all', async () => {
            const results = await Itask.all([
                Promise.resolve(1),
                Promise.resolve(2),
                Promise.resolve(3)
            ]);

            expect(results).to.deep.equal([1, 2, 3]);
        });

        it('should generate ps output', () => {
            const parent = new Itask({ name: 'parent', async: true }, []);
            const child = new Itask({ name: 'child', async: true }, []);
            parent.spawn(child);

            const ps = Itask.ps();
            expect(ps).to.include('parent');
            expect(ps).to.include('child');
        });
    });

    describe('wait/continue', () => {
        it('should wait and continue', async () => {
            let continued = false;
            const task = new Itask({ name: 'wait-test' }, [
                async function() {
                    const result = await this.wait();
                    continued = true;
                    return result;
                }
            ]);

            await new Promise(r => setTimeout(r, 50));
            task.continue(42);
            await task;

            expect(continued).to.be.true;
            expect(task.retval).to.equal(42);
        });

        it('should handle return method', async () => {
            const task = new Itask({ name: 'return-test' }, [
                function() { return this.wait(); }
            ]);

            await new Promise(r => setTimeout(r, 20));
            task.return('early-return');
            expect(task._completed).to.be.true;
            expect(task.retval).to.equal('early-return');
        });

        it('should handle throw method', async () => {
            const task = new Itask({ name: 'throw-test' }, [
                function() { return this.wait(); }
            ]);

            await new Promise(r => setTimeout(r, 20));
            task.throw('forced-error');
            expect(task._completed).to.be.true;
            expect(task.error.message).to.equal('forced-error');
        });
    });

    describe('finally callbacks', () => {
        it('should call finally callback when complete', async () => {
            let called = false;
            const task = new Itask({ name: 'finally-cb-test' }, [
                function() { return 42; }
            ]);

            task.finally(() => { called = true; });
            await task;

            expect(called).to.be.true;
        });

        it('should call finally callback immediately if already complete', async () => {
            const task = new Itask({ name: 'finally-immediate-test' }, [
                function() { return 42; }
            ]);

            await task;

            let called = false;
            task.finally(() => { called = true; });

            expect(called).to.be.true;
        });
    });
});
