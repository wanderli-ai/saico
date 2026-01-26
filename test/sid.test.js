'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const { Sid, createSid } = require('../sid.js');
const Itask = require('../itask.js');
const openai = require('../openai.js');
const util = require('../util.js');

describe('Sid', function () {
    let sandbox;
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
        Itask.root.clear();
    });

    afterEach(() => {
        sandbox.restore();
        Itask.root.clear();
    });

    describe('constructor', () => {
        it('should create a Sid with default values', () => {
            const sid = createSid({ name: 'test-session', prompt: fakePrompt });
            expect(sid.name).to.equal('test-session');
            expect(sid.prompt).to.equal(fakePrompt);
            expect(sid.context).to.exist;
            expect(sid.userData).to.deep.equal({});
        });

        it('should accept string as options', () => {
            const sid = createSid('my-session');
            expect(sid.name).to.equal('my-session');
        });

        it('should always create a context', () => {
            const sid = createSid({ name: 'session' });
            expect(sid.context).to.exist;
        });

        it('should initialize with provided userData', () => {
            const sid = createSid({
                name: 'session',
                userData: { userId: '123', role: 'admin' }
            });
            expect(sid.userData).to.deep.equal({ userId: '123', role: 'admin' });
        });

        it('should register in root registry', () => {
            const sid = createSid({ name: 'session' });
            expect(Itask.root.has(sid)).to.be.true;
        });
    });

    describe('sendMessage', () => {
        it('should send message using context', async () => {
            const sid = createSid({ name: 'session', prompt: fakePrompt });

            const reply = await sid.sendMessage('user', 'Hello');

            expect(reply).to.have.property('content', 'AI response');
            expect(openai.send.calledOnce).to.be.true;
        });

        it('should include prompt in message queue', async () => {
            const sid = createSid({ name: 'session', prompt: fakePrompt });

            await sid.sendMessage('user', 'Hello');

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs[0]).to.deep.equal({ role: 'system', content: fakePrompt });
        });
    });

    describe('serialization', () => {
        it('should serialize session state', () => {
            const sid = createSid({
                name: 'test-session',
                prompt: fakePrompt,
                userData: { userId: '123' }
            });

            sid.context.push({ role: 'user', content: 'Hello' });

            const serialized = sid.serialize();
            expect(serialized).to.be.a('string');

            const parsed = JSON.parse(serialized);
            expect(parsed.name).to.equal('test-session');
            expect(parsed.prompt).to.equal(fakePrompt);
            expect(parsed.userData).to.deep.equal({ userId: '123' });
            expect(parsed.context.msgs).to.have.length(1);
        });

        it('should deserialize session state', () => {
            const original = createSid({
                name: 'test-session',
                prompt: fakePrompt,
                userData: { userId: '123' }
            });

            original.context.push({ role: 'user', content: 'Hello' });
            original.context.push({ role: 'assistant', content: 'Hi there' });

            const serialized = original.serialize();
            const restored = Sid.deserialize(serialized);

            expect(restored.name).to.equal('test-session');
            expect(restored.prompt).to.equal(fakePrompt);
            expect(restored.userData).to.deep.equal({ userId: '123' });
            expect(restored.context.length).to.equal(2);
            expect(restored.id).to.equal(original.id);
        });

        it('should accept options when deserializing', () => {
            const mockHandler = sandbox.stub();
            const original = createSid({
                name: 'session',
                prompt: fakePrompt
            });

            const serialized = original.serialize();
            const restored = Sid.deserialize(serialized, {
                tool_handler: mockHandler
            });

            expect(restored.tool_handler).to.equal(mockHandler);
        });
    });

    describe('userData management', () => {
        it('should set and get user data', () => {
            const sid = createSid({ name: 'session' });

            sid.setUserData('key1', 'value1');
            sid.setUserData('key2', { nested: 'object' });

            expect(sid.getUserData('key1')).to.equal('value1');
            expect(sid.getUserData('key2')).to.deep.equal({ nested: 'object' });
        });

        it('should get all user data when no key provided', () => {
            const sid = createSid({ name: 'session' });

            sid.setUserData('key1', 'value1');
            sid.setUserData('key2', 'value2');

            const allData = sid.getUserData();
            expect(allData).to.deep.equal({
                key1: 'value1',
                key2: 'value2'
            });
        });

        it('should clear user data', () => {
            const sid = createSid({ name: 'session' });

            sid.setUserData('key1', 'value1');
            sid.clearUserData();

            expect(sid.userData).to.deep.equal({});
        });

        it('should chain setUserData calls', () => {
            const sid = createSid({ name: 'session' });

            sid.setUserData('a', 1)
               .setUserData('b', 2)
               .setUserData('c', 3);

            expect(sid.userData).to.deep.equal({ a: 1, b: 2, c: 3 });
        });
    });

    describe('child task spawning', () => {
        it('should spawn child task with context', async () => {
            const sid = createSid({ name: 'session', prompt: fakePrompt });

            const child = sid.spawnTaskWithContext({
                name: 'child-task',
                prompt: 'Child prompt'
            }, [
                function() { return 'done'; }
            ]);

            expect(child).to.be.instanceOf(Itask);
            expect(child.parent).to.equal(sid);
            expect(child.context).to.exist;
            expect(child.context.prompt).to.equal('Child prompt');

            await child;
        });

        it('should spawn child task without context', async () => {
            const sid = createSid({ name: 'session', prompt: fakePrompt });

            const child = sid.spawnTask({
                name: 'simple-child'
            }, [
                function() { return 42; }
            ]);

            expect(child).to.be.instanceOf(Itask);
            expect(child.parent).to.equal(sid);
            expect(child.context).to.be.null;

            const result = await child;
            expect(result).to.equal(42);
        });

        it('should inherit configuration in child context', async () => {
            const sid = createSid({
                name: 'session',
                prompt: fakePrompt,
                max_depth: 3,
                token_limit: 5000
            });

            const child = sid.spawnTaskWithContext({
                name: 'child',
                prompt: 'Child prompt'
            }, []);

            expect(child.context.max_depth).to.equal(3);
            expect(child.context.token_limit).to.equal(5000);
        });
    });

    describe('getSessionInfo', () => {
        it('should return session information', () => {
            const sid = createSid({ name: 'test-session', prompt: fakePrompt });
            sid.context.push({ role: 'user', content: 'Hello' });

            const info = sid.getSessionInfo();

            expect(info.id).to.equal(sid.id);
            expect(info.name).to.equal('test-session');
            expect(info.running).to.be.false;
            expect(info.completed).to.be.false;
            expect(info.messageCount).to.equal(1);
            expect(info.childCount).to.equal(0);
            expect(info.uptime).to.be.a('number');
        });
    });

    describe('closeSession', () => {
        it('should close context and cancel task', async () => {
            const sid = createSid({
                name: 'session',
                prompt: fakePrompt
            }, [
                function() { return this.wait(); }
            ]);

            // Let it start
            await new Promise(r => setTimeout(r, 50));

            await sid.closeSession();

            // Wait for cancellation to complete
            await new Promise(r => setTimeout(r, 200));

            expect(sid._completed).to.be.true;
        });
    });

    describe('inheritance from Itask', () => {
        it('should be instance of Itask', () => {
            const sid = createSid({ name: 'session' });
            expect(sid).to.be.instanceOf(Itask);
        });

        it('should have Itask methods', () => {
            const sid = createSid({ name: 'session' });

            expect(typeof sid.spawn).to.equal('function');
            expect(typeof sid._ecancel).to.equal('function');
            expect(typeof sid.then).to.equal('function');
            expect(typeof sid.finally).to.equal('function');
        });

        it('should run states like Itask', async () => {
            let stateRan = false;

            const sid = createSid({
                name: 'session',
                prompt: fakePrompt,
                async: true
            }, [
                function() { stateRan = true; return 'done'; }
            ]);

            // Manually run since async: true
            sid._run();
            await sid;

            expect(stateRan).to.be.true;
        });

        it('should handle errors like Itask', async () => {
            const sid = createSid({
                name: 'session',
                async: true
            }, [
                function() { throw new Error('test error'); },
                function catch$handler() { return 'caught'; }
            ]);

            sid._run();
            await sid;

            expect(sid.retval).to.equal('caught');
        });
    });
});
