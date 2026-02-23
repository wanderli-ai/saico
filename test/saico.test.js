'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const { Saico } = require('../saico.js');
const { Context } = require('../msgs.js');
const Itask = require('../itask.js');
const { Store } = require('../store.js');
const openai = require('../openai.js');
const util = require('../util.js');
const redis = require('../redis.js');

describe('Saico', function () {
    let sandbox;
    let mockToolHandler;
    const fakePrompt = 'You are a helpful assistant.';

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        if (process.env.PROD)
            sandbox.stub(console, 'log');
        sandbox.stub(util, 'countTokens').callsFake((msgs) => {
            if (Array.isArray(msgs)) return msgs.length * 10;
            return 10;
        });
        sandbox.stub(openai, 'send').resolves({ content: 'AI response' });
        mockToolHandler = sandbox.stub().resolves({ content: 'tool result', functions: null });
        Itask.root.clear();
        Store.instance = null;
        // Ensure redis.rclient is null for most tests (no redis proxy)
        redis.rclient = undefined;
    });

    afterEach(() => {
        sandbox.restore();
        Itask.root.clear();
        Store.instance = null;
        redis.rclient = undefined;
    });

    describe('constructor', () => {
        it('should create instance with default values', () => {
            const s = new Saico();
            expect(s._id).to.be.a('string').with.lengthOf(16);
            expect(s._task).to.be.null;
            expect(s.name).to.equal('Saico');
            expect(s.prompt).to.equal('');
            expect(s.tool_handler).to.be.null;
            expect(s.functions).to.be.null;
            expect(s._db).to.be.null;
        });

        it('should accept options', () => {
            const handler = () => {};
            const funcs = [{ name: 'test' }];
            const s = new Saico({
                id: 'my-id',
                name: 'my-service',
                prompt: fakePrompt,
                tool_handler: handler,
                functions: funcs,
            });
            expect(s._id).to.equal('my-id');
            expect(s.name).to.equal('my-service');
            expect(s.prompt).to.equal(fakePrompt);
            expect(s.tool_handler).to.equal(handler);
            expect(s.functions).to.equal(funcs);
        });

        it('should use constructor.name as default name', () => {
            class MyApp extends Saico {}
            const app = new MyApp();
            expect(app.name).to.equal('MyApp');
        });

        it('should return redis observable proxy when redis is available', () => {
            const fakeRclient = {
                set: sandbox.stub().resolves(),
            };
            redis.rclient = fakeRclient;

            const s = new Saico({ id: 'test-id', redis: true });
            // The proxy should still expose instance properties
            expect(s._id).to.equal('test-id');
            expect(s.name).to.equal('Saico');
            // lastMod should be available (from createObservableForRedis)
            expect(typeof s.lastMod).to.equal('function');
        });

        it('should return plain instance when redis is disabled', () => {
            const fakeRclient = {
                set: sandbox.stub().resolves(),
            };
            redis.rclient = fakeRclient;

            const s = new Saico({ redis: false });
            expect(typeof s.lastMod).to.equal('undefined');
        });

        it('should not have _db when no dynamodb_table', () => {
            const s = new Saico();
            expect(s._db).to.be.null;
        });

        it('should accept injected db backend via opt.db', () => {
            const fakeDb = { put: sandbox.stub(), get: sandbox.stub() };
            const s = new Saico({ db: fakeDb });
            expect(s._db).to.equal(fakeDb);
        });
    });

    describe('activate', () => {
        it('should create internal Itask', () => {
            const s = new Saico({ name: 'test' });
            s.activate();
            expect(s._task).to.be.instanceOf(Itask);
            expect(s.task).to.be.instanceOf(Itask);
            expect(s.isActive).to.be.true;
        });

        it('should return this for chaining', () => {
            const s = new Saico();
            const ret = s.activate();
            expect(ret).to.equal(s);
        });

        it('should throw when already activated', () => {
            const s = new Saico();
            s.activate();
            expect(() => s.activate()).to.throw('Already activated');
        });

        it('should NOT create context when prompt is provided but createQ is false', () => {
            const s = new Saico({ prompt: fakePrompt });
            s.activate({ prompt: 'additional prompt' });
            expect(s._task.context).to.be.null;
            expect(s.context).to.be.null;
        });

        it('should create context only when createQ is true', () => {
            const s = new Saico({ prompt: fakePrompt });
            s.activate({ createQ: true });
            expect(s._task.context).to.be.instanceOf(Context);
            expect(s.context).to.be.instanceOf(Context);
        });

        it('should combine class-level and activation-level prompts', () => {
            const s = new Saico({ prompt: 'Class prompt.' });
            s.activate({ createQ: true, prompt: 'Activation prompt.' });
            // The context prompt should contain both
            expect(s.context.prompt).to.include('Class prompt.');
            expect(s.context.prompt).to.include('Activation prompt.');
        });

        it('should create context without prompts when createQ is true', () => {
            const s = new Saico();
            s.activate({ createQ: true });
            expect(s.context).to.be.instanceOf(Context);
            expect(s.context.prompt).to.equal('');
        });

        it('should pass tool_handler and functions to task', () => {
            const handler = sandbox.stub();
            const funcs = [{ name: 'f1' }];
            const s = new Saico({ tool_handler: handler, functions: funcs });
            s.activate();
            expect(s._task.tool_handler).to.equal(handler);
            expect(s._task.functions).to.deep.equal(funcs);
        });

        it('should allow overriding tool_handler and functions on activate', () => {
            const handler1 = sandbox.stub();
            const handler2 = sandbox.stub();
            const s = new Saico({ tool_handler: handler1 });
            s.activate({ tool_handler: handler2 });
            expect(s._task.tool_handler).to.equal(handler2);
        });

        it('should bind Saico instance as this for state functions', () => {
            const s = new Saico({ name: 'test' });
            s.activate();
            expect(s._task.bind).to.equal(s);
        });

        it('should delegate getStateSummary from task to Saico', () => {
            class MyApp extends Saico {
                getStateSummary() { return 'my summary'; }
            }
            const app = new MyApp();
            app.activate();
            expect(app._task.getStateSummary()).to.equal('my summary');
        });

        it('should accept states option', () => {
            const stateFn = sandbox.stub();
            const s = new Saico();
            s.activate({ states: [stateFn] });
            expect(s._task.funcs).to.have.lengthOf(1);
        });

        it('should accept parent option', () => {
            const parent = new Itask({ name: 'parent', async: true }, []);
            const s = new Saico();
            s.activate({ parent });
            expect(s._task.parent).to.equal(parent);
            expect(parent.child.has(s._task)).to.be.true;
        });

        it('should pass context config options', () => {
            const s = new Saico();
            s.activate({
                createQ: true,
                max_depth: 3,
                queue_limit: 20,
                min_chat_messages: 5,
            });
            expect(s.context.max_depth).to.equal(3);
            expect(s.context.QUEUE_LIMIT).to.equal(20);
            expect(s.context.MIN_CHAT_MESSAGES).to.equal(5);
        });
    });

    describe('deactivate', () => {
        it('should cancel task and clean up', async () => {
            const s = new Saico();
            s.activate();
            const task = s._task;
            await s.deactivate();
            expect(s._task).to.be.null;
            expect(s.isActive).to.be.false;
        });

        it('should be safe to call when not activated', async () => {
            const s = new Saico();
            await s.deactivate(); // should not throw
            expect(s._task).to.be.null;
        });
    });

    describe('sendMessage', () => {
        it('should throw when not activated', async () => {
            const s = new Saico();
            try {
                await s.sendMessage('hello');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('Not activated. Call activate() first.');
            }
        });

        it('should delegate to task sendMessage', async () => {
            const s = new Saico({
                prompt: fakePrompt,
                tool_handler: mockToolHandler,
            });
            s.activate({ createQ: true });
            const reply = await s.sendMessage('hello');
            expect(reply.content).to.include('AI response');
        });
    });

    describe('recvChatMessage', () => {
        it('should throw when not activated', async () => {
            const s = new Saico();
            try {
                await s.recvChatMessage('hello');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('Not activated. Call activate() first.');
            }
        });

        it('should delegate to task recvChatMessage', async () => {
            const s = new Saico({
                prompt: fakePrompt,
                tool_handler: mockToolHandler,
            });
            s.activate({ createQ: true });
            const reply = await s.recvChatMessage('hello');
            expect(reply.content).to.include('AI response');
        });
    });

    describe('spawnTaskWithContext', () => {
        it('should throw when not activated', () => {
            const s = new Saico();
            expect(() => s.spawnTaskWithContext({ name: 'child' })).to.throw('Not activated');
        });

        it('should create child task with context', () => {
            const s = new Saico({ tool_handler: mockToolHandler });
            s.activate();
            const child = s.spawnTaskWithContext({
                name: 'child',
                prompt: 'Child prompt',
            });
            expect(child).to.be.instanceOf(Itask);
            expect(child.parent).to.equal(s._task);
            expect(child.context).to.be.instanceOf(Context);
            expect(child.context.prompt).to.equal('Child prompt');
        });

        it('should accept string opt', () => {
            const s = new Saico();
            s.activate();
            const child = s.spawnTaskWithContext('child-name');
            expect(child).to.be.instanceOf(Itask);
            expect(child.name).to.equal('child-name');
        });
    });

    describe('spawnTask', () => {
        it('should throw when not activated', () => {
            const s = new Saico();
            expect(() => s.spawnTask({ name: 'child' })).to.throw('Not activated');
        });

        it('should create child task without context', () => {
            const s = new Saico();
            s.activate();
            const child = s.spawnTask({ name: 'child' });
            expect(child).to.be.instanceOf(Itask);
            expect(child.parent).to.equal(s._task);
            expect(child.context).to.be.null;
        });
    });

    describe('getStateSummary', () => {
        it('should return empty string by default', () => {
            const s = new Saico();
            expect(s.getStateSummary()).to.equal('');
        });

        it('should be overridable in subclasses', () => {
            class MyApp extends Saico {
                getStateSummary() { return 'custom summary'; }
            }
            const app = new MyApp();
            expect(app.getStateSummary()).to.equal('custom summary');
        });
    });

    describe('accessors', () => {
        it('should return null for task/context/context_id when not activated', () => {
            const s = new Saico();
            expect(s.task).to.be.null;
            expect(s.context).to.be.null;
            expect(s.context_id).to.be.null;
            expect(s.isActive).to.be.false;
        });

        it('should return task/context after activation', () => {
            const s = new Saico();
            s.activate({ createQ: true });
            expect(s.task).to.be.instanceOf(Itask);
            expect(s.context).to.be.instanceOf(Context);
            expect(s.context_id).to.be.a('string');
            expect(s.isActive).to.be.true;
        });
    });

    describe('subclass extension', () => {
        it('should work correctly through constructor', () => {
            class MyService extends Saico {
                constructor(userId) {
                    super({
                        name: 'my-service',
                        prompt: 'You are a service.',
                    });
                    this.userId = userId;
                    this.data = [];
                }

                getStateSummary() {
                    return `User: ${this.userId}, items: ${this.data.length}`;
                }
            }

            const svc = new MyService('user-123');
            expect(svc.userId).to.equal('user-123');
            expect(svc.data).to.deep.equal([]);
            expect(svc.name).to.equal('my-service');
            expect(svc.getStateSummary()).to.equal('User: user-123, items: 0');
        });

        it('should work through redis proxy', () => {
            const fakeRclient = { set: sandbox.stub().resolves() };
            redis.rclient = fakeRclient;

            class MyService extends Saico {
                constructor() {
                    super({ name: 'proxied-service' });
                    this.counter = 0;
                }
            }

            const svc = new MyService();
            expect(svc.name).to.equal('proxied-service');
            expect(svc.counter).to.equal(0);

            // Setting property should work through proxy
            svc.counter = 5;
            expect(svc.counter).to.equal(5);
        });

        it('should be activatable after subclass construction', () => {
            class MyService extends Saico {
                constructor() {
                    super({ prompt: 'Base prompt', tool_handler: () => {} });
                }
            }

            const svc = new MyService();
            svc.activate({ createQ: true, prompt: 'Extra context' });
            expect(svc.isActive).to.be.true;
            expect(svc.context.prompt).to.include('Base prompt');
            expect(svc.context.prompt).to.include('Extra context');
        });
    });

    describe('serialize', () => {
        it('should serialize without task', () => {
            const s = new Saico({ id: 'test-id', name: 'test', prompt: 'p' });
            const json = s.serialize();
            const data = JSON.parse(json);
            expect(data.id).to.equal('test-id');
            expect(data.name).to.equal('test');
            expect(data.prompt).to.equal('p');
            expect(data.task).to.be.undefined;
        });

        it('should serialize with activated task', () => {
            const s = new Saico({ id: 'test-id', name: 'test', prompt: 'p' });
            s.activate({ createQ: true });
            const json = s.serialize();
            const data = JSON.parse(json);
            expect(data.task).to.be.an('object');
            expect(data.task.context_id).to.be.a('string');
            expect(data.task.context).to.be.an('object');
            expect(data.task.context.tag).to.be.a('string');
        });

        it('should serialize activated task without context', () => {
            const s = new Saico({ id: 'test-id' });
            s.activate();
            const json = s.serialize();
            const data = JSON.parse(json);
            expect(data.task).to.be.an('object');
            expect(data.task.context).to.be.null;
        });
    });

    describe('generic DB access', () => {
        let fakeDb;

        beforeEach(() => {
            fakeDb = {
                put: sandbox.stub().resolves(),
                get: sandbox.stub().resolves({ id: '1', name: 'test' }),
                delete: sandbox.stub().resolves(),
                query: sandbox.stub().resolves([{ id: '1' }]),
                getAll: sandbox.stub().resolves([{ id: '1' }, { id: '2' }]),
                update: sandbox.stub().resolves(),
                updatePath: sandbox.stub().resolves(),
                listAppend: sandbox.stub().resolves(),
                listAppendPath: sandbox.stub().resolves(),
                nextCounterId: sandbox.stub().resolves('42'),
                getCounterValue: sandbox.stub().resolves(10),
                setCounterValue: sandbox.stub().resolves(),
                countItems: sandbox.stub().resolves(100),
            };
        });

        it('should return undefined when no backend configured', async () => {
            const s = new Saico();
            expect(await s.dbPutItem({ id: '1' })).to.be.undefined;
            expect(await s.dbGetItem('id', '1')).to.be.undefined;
            expect(await s.dbDeleteItem('id', '1')).to.be.undefined;
            expect(await s.dbQuery('idx', 'k', 'v')).to.be.undefined;
            expect(await s.dbGetAll()).to.be.undefined;
            expect(await s.dbUpdate('id', '1', 'k', 'v')).to.be.undefined;
            expect(await s.dbUpdatePath('id', '1', [], 'k', 'v')).to.be.undefined;
            expect(await s.dbListAppend('id', '1', 'k', 'v')).to.be.undefined;
            expect(await s.dbListAppendPath('id', '1', [], 'k', 'v')).to.be.undefined;
            expect(await s.dbNextCounterId('c')).to.be.undefined;
            expect(await s.dbGetCounterValue('c')).to.be.undefined;
            expect(await s.dbSetCounterValue('c', 1)).to.be.undefined;
            expect(await s.dbCountItems()).to.be.undefined;
        });

        it('dbPutItem should delegate to backend.put', async () => {
            const s = new Saico({ db: fakeDb });
            await s.dbPutItem({ id: '1', name: 'test' });
            expect(fakeDb.put.calledOnce).to.be.true;
            expect(fakeDb.put.firstCall.args[0]).to.deep.equal({ id: '1', name: 'test' });
        });

        it('dbGetItem should delegate to backend.get', async () => {
            const s = new Saico({ db: fakeDb });
            const item = await s.dbGetItem('id', '1');
            expect(item).to.deep.equal({ id: '1', name: 'test' });
            expect(fakeDb.get.calledOnce).to.be.true;
            expect(fakeDb.get.firstCall.args).to.deep.equal(['id', '1', undefined]);
        });

        it('dbDeleteItem should delegate to backend.delete', async () => {
            const s = new Saico({ db: fakeDb });
            await s.dbDeleteItem('id', '1');
            expect(fakeDb.delete.calledOnce).to.be.true;
        });

        it('dbQuery should delegate to backend.query', async () => {
            const s = new Saico({ db: fakeDb });
            const items = await s.dbQuery('email-index', 'email', 'a@b.com');
            expect(items).to.deep.equal([{ id: '1' }]);
            expect(fakeDb.query.calledOnce).to.be.true;
        });

        it('dbGetAll should delegate to backend.getAll', async () => {
            const s = new Saico({ db: fakeDb });
            const items = await s.dbGetAll();
            expect(items).to.have.lengthOf(2);
        });

        it('dbUpdate should delegate to backend.update', async () => {
            const s = new Saico({ db: fakeDb });
            await s.dbUpdate('id', '1', 'status', 'active');
            expect(fakeDb.update.calledOnce).to.be.true;
            expect(fakeDb.update.firstCall.args).to.deep.equal(['id', '1', 'status', 'active', undefined]);
        });

        it('dbUpdatePath should delegate to backend.updatePath', async () => {
            const s = new Saico({ db: fakeDb });
            const path = [{ key: 'items' }];
            await s.dbUpdatePath('id', '1', path, 'name', 'val');
            expect(fakeDb.updatePath.calledOnce).to.be.true;
        });

        it('dbListAppend should delegate to backend.listAppend', async () => {
            const s = new Saico({ db: fakeDb });
            await s.dbListAppend('id', '1', 'items', { name: 'new' });
            expect(fakeDb.listAppend.calledOnce).to.be.true;
        });

        it('dbListAppendPath should delegate to backend.listAppendPath', async () => {
            const s = new Saico({ db: fakeDb });
            await s.dbListAppendPath('id', '1', [], 'items', { name: 'new' });
            expect(fakeDb.listAppendPath.calledOnce).to.be.true;
        });

        it('dbNextCounterId should delegate to backend.nextCounterId', async () => {
            const s = new Saico({ db: fakeDb });
            const id = await s.dbNextCounterId('OrderId');
            expect(id).to.equal('42');
            expect(fakeDb.nextCounterId.calledOnce).to.be.true;
        });

        it('dbGetCounterValue should delegate to backend.getCounterValue', async () => {
            const s = new Saico({ db: fakeDb });
            const val = await s.dbGetCounterValue('OrderId');
            expect(val).to.equal(10);
        });

        it('dbSetCounterValue should delegate to backend.setCounterValue', async () => {
            const s = new Saico({ db: fakeDb });
            await s.dbSetCounterValue('OrderId', 50);
            expect(fakeDb.setCounterValue.calledOnce).to.be.true;
            expect(fakeDb.setCounterValue.firstCall.args).to.deep.equal(['OrderId', 50, undefined]);
        });

        it('dbCountItems should delegate to backend.countItems', async () => {
            const s = new Saico({ db: fakeDb });
            const count = await s.dbCountItems();
            expect(count).to.equal(100);
        });

        it('should pass table override to backend', async () => {
            const s = new Saico({ db: fakeDb });
            await s.dbGetItem('id', '1', 'other-table');
            expect(fakeDb.get.firstCall.args[2]).to.equal('other-table');
        });

        it('should work with subclass that has db', () => {
            class MyService extends Saico {
                constructor() {
                    super({ db: fakeDb });
                }
            }
            const svc = new MyService();
            expect(svc._db).to.equal(fakeDb);
        });

        it('db methods should work before activate', async () => {
            const s = new Saico({ db: fakeDb });
            // no activate() call
            const item = await s.dbGetItem('id', '1');
            expect(item).to.deep.equal({ id: '1', name: 'test' });
        });

        it('db methods should work after activate', async () => {
            const s = new Saico({ db: fakeDb });
            s.activate();
            const item = await s.dbGetItem('id', '1');
            expect(item).to.deep.equal({ id: '1', name: 'test' });
        });
    });

    describe('module exports', () => {
        it('should export Saico from index.js', () => {
            const saico = require('../index.js');
            expect(saico.Saico).to.equal(Saico);
        });

        it('should export DynamoDBAdapter from index.js', () => {
            const saico = require('../index.js');
            expect(saico.DynamoDBAdapter).to.be.a('function');
        });

        it('should export Context from both context.js and msgs.js', () => {
            const fromContext = require('../context.js');
            const fromMsgs = require('../msgs.js');
            expect(fromContext.Context).to.equal(fromMsgs.Context);
            expect(fromContext.createContext).to.equal(fromMsgs.createContext);
        });
    });
});
