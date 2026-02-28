'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const { Saico } = require('../saico.js');
const { Msgs } = require('../msgs.js');
const Itask = require('../itask.js');
const { Store } = require('../store.js');
const openai = require('../openai.js');
const util = require('../util.js');
const redis = require('../redis.js');

describe('Saico', function () {
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
        Store.instance = null;
        // Ensure redis.rclient is null for most tests (no redis proxy)
        redis.rclient = undefined;
    });

    afterEach(() => {
        sandbox.restore();
        Itask.root.clear();
        Store.instance = null;
        Saico._backend = null;
        redis.rclient = undefined;
    });

    describe('constructor', () => {
        it('should create instance with default values', () => {
            const s = new Saico();
            expect(s.id).to.be.a('string').with.lengthOf(16);
            expect(s._task).to.be.null;
            expect(s.name).to.equal('Saico');
            expect(s.prompt).to.equal('');
            expect(s.functions).to.be.null;
            expect(s._db).to.be.null;
            expect(s.userData).to.deep.equal({});
            expect(s.tm_create).to.be.a('number');
            expect(s.isolate).to.be.false;
            expect(s.sessionConfig).to.be.an('object');
            expect(s.msgs).to.be.null;
            expect(s.msgs_id).to.be.null;
        });

        it('should accept options', () => {
            const funcs = [{ name: 'test' }];
            const s = new Saico({
                id: 'my-id',
                name: 'my-service',
                prompt: fakePrompt,
                functions: funcs,
                userData: { key: 'val' },
                isolate: true,
            });
            expect(s.id).to.equal('my-id');
            expect(s.name).to.equal('my-service');
            expect(s.prompt).to.equal(fakePrompt);
            expect(s.functions).to.equal(funcs);
            expect(s.userData).to.deep.equal({ key: 'val' });
            expect(s.isolate).to.be.true;
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
            expect(s.id).to.equal('test-id');
            expect(s.name).to.equal('Saico');
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

        it('should not have _db when no dynamodb config', () => {
            const s = new Saico();
            expect(s._db).to.be.null;
        });

        it('should accept injected db backend via opt.db', () => {
            const fakeDb = { put: sandbox.stub(), get: sandbox.stub() };
            const s = new Saico({ db: fakeDb });
            expect(s._db).to.equal(fakeDb);
        });

        it('should merge sessionConfig from opt', () => {
            const s = new Saico({
                max_depth: 10,
                queue_limit: 50,
                sessionConfig: { min_chat_messages: 3 },
            });
            expect(s.sessionConfig.max_depth).to.equal(10);
            expect(s.sessionConfig.queue_limit).to.equal(50);
            expect(s.sessionConfig.min_chat_messages).to.equal(3);
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

        it('should NOT create msgs Q when prompt is provided but createQ is false', () => {
            const s = new Saico({ prompt: fakePrompt });
            s.activate({ prompt: 'additional prompt' });
            expect(s.msgs).to.be.null;
        });

        it('should create msgs Q only when createQ is true', () => {
            const s = new Saico({ prompt: fakePrompt });
            s.activate({ createQ: true });
            expect(s.msgs).to.be.instanceOf(Msgs);
        });

        it('should combine class-level and activation-level prompts', () => {
            const s = new Saico({ prompt: 'Class prompt.' });
            s.activate({ createQ: true, prompt: 'Activation prompt.' });
            expect(s.msgs.prompt).to.include('Class prompt.');
            expect(s.msgs.prompt).to.include('Activation prompt.');
        });

        it('should create msgs Q without prompts when createQ is true', () => {
            const s = new Saico();
            s.activate({ createQ: true });
            expect(s.msgs).to.be.instanceOf(Msgs);
            expect(s.msgs.prompt).to.equal('');
        });

        it('should bind Saico instance as this for state functions', () => {
            const s = new Saico({ name: 'test' });
            s.activate();
            expect(s._task.bind).to.equal(s);
        });

        it('should store _saico reference on task', () => {
            const s = new Saico({ name: 'test' });
            s.activate();
            expect(s._task._saico).to.equal(s);
        });

        it('should accept states option', () => {
            const stateFn = sandbox.stub();
            const s = new Saico();
            s.activate({ states: [stateFn] });
            expect(s._task.funcs).to.have.lengthOf(1);
        });

        it('should use this.states when opts.states not provided', () => {
            const stateFn = sandbox.stub();
            class MyAgent extends Saico {
                constructor() {
                    super();
                    this.states = [stateFn];
                }
            }
            const agent = new MyAgent();
            agent.activate();
            expect(agent._task.funcs).to.have.lengthOf(1);
            expect(agent._task.funcs[0]).to.equal(stateFn);
        });

        it('should prefer opts.states over this.states', () => {
            const classFn = sandbox.stub();
            const optsFn = sandbox.stub();
            class MyAgent extends Saico {
                constructor() {
                    super();
                    this.states = [classFn];
                }
            }
            const agent = new MyAgent();
            agent.activate({ states: [optsFn] });
            expect(agent._task.funcs).to.have.lengthOf(1);
            expect(agent._task.funcs[0]).to.equal(optsFn);
        });

        it('should use this.createQ from constructor opts', () => {
            const s = new Saico({ prompt: 'test', createQ: true });
            s.activate();
            expect(s.msgs).to.be.instanceOf(Msgs);
        });

        it('should prefer opts.createQ over this.createQ', () => {
            const s = new Saico({ prompt: 'test', createQ: true });
            s.activate({ createQ: false });
            expect(s.msgs).to.be.null;
        });

        it('should allow subclass to set createQ in constructor', () => {
            class MyAgent extends Saico {
                constructor() {
                    super({ prompt: 'test' });
                    this.createQ = true;
                }
            }
            const agent = new MyAgent();
            agent.activate();
            expect(agent.msgs).to.be.instanceOf(Msgs);
        });

        it('should pass msgs config options', () => {
            const s = new Saico();
            s.activate({
                createQ: true,
                max_depth: 3,
                queue_limit: 20,
                min_chat_messages: 5,
            });
            expect(s.msgs.max_depth).to.equal(3);
            expect(s.msgs.QUEUE_LIMIT).to.equal(20);
            expect(s.msgs.MIN_CHAT_MESSAGES).to.equal(5);
        });

        it('should use sessionConfig as defaults for msgs config', () => {
            const s = new Saico({
                sessionConfig: { max_depth: 7, queue_limit: 40 },
            });
            s.activate({ createQ: true });
            expect(s.msgs.max_depth).to.equal(7);
            expect(s.msgs.QUEUE_LIMIT).to.equal(40);
        });
    });

    describe('msgs management', () => {
        it('should store msgs directly on Saico', () => {
            const s = new Saico({ prompt: fakePrompt });
            s.activate({ createQ: true });
            expect(s.msgs).to.be.instanceOf(Msgs);
            expect(s.msgs_id).to.be.a('string');
            expect(s.msgs_id.length).to.be.greaterThan(0);
        });

        it('findMsgs should walk up Saico hierarchy', () => {
            const parent = new Saico({ name: 'parent' });
            parent.activate({ createQ: true });
            const child = new Saico({ name: 'child' });
            child.activate();
            parent.spawn(child);

            expect(child.findMsgs()).to.equal(parent.msgs);
        });

        it('findDeepestMsgs should walk down to deepest msgs Q', () => {
            const parent = new Saico({ name: 'parent' });
            parent.activate({ createQ: true });
            const child = new Saico({ name: 'child' });
            child.activate({ createQ: true });
            parent.spawn(child);

            expect(parent.findDeepestMsgs()).to.equal(child.msgs);
        });

        it('findDeepestMsgs should return own msgs Q when no children', () => {
            const s = new Saico({ name: 'test' });
            s.activate({ createQ: true });
            expect(s.findDeepestMsgs()).to.equal(s.msgs);
        });

        it('findDeepestMsgs should skip completed children', () => {
            const parent = new Saico({ name: 'parent' });
            parent.activate({ createQ: true });
            const child = new Saico({ name: 'child' });
            child.activate({ createQ: true });
            parent.spawn(child);
            child._task._completed = true;

            expect(parent.findDeepestMsgs()).to.equal(parent.msgs);
        });
    });

    describe('spawn', () => {
        it('should throw when not activated', () => {
            const parent = new Saico();
            const child = new Saico();
            child.activate();
            expect(() => parent.spawn(child)).to.throw('Not activated');
        });

        it('should auto-activate child if not activated', () => {
            const parent = new Saico({ name: 'parent' });
            parent.activate();
            const child = new Saico({ name: 'child', createQ: true });
            parent.spawn(child);
            expect(child._task).to.exist;
            expect(child._task.parent).to.equal(parent._task);
            expect(child.msgs).to.exist;
        });

        it('should spawn child under parent task', () => {
            const parent = new Saico({ name: 'parent' });
            parent.activate();
            const child = new Saico({ name: 'child' });
            child.activate();
            parent.spawn(child);

            expect(child._task.parent).to.equal(parent._task);
            expect(parent._task.child.has(child._task)).to.be.true;
        });

        it('should return child for chaining', () => {
            const parent = new Saico({ name: 'parent' });
            parent.activate();
            const child = new Saico({ name: 'child' });
            child.activate();
            const ret = parent.spawn(child);
            expect(ret).to.equal(child);
        });
    });

    describe('spawnAndRun', () => {
        it('should spawn and schedule child to run', (done) => {
            const parent = new Saico({ name: 'parent' });
            parent.activate();
            let ran = false;
            const child = new Saico({ name: 'child' });
            child.activate({ states: [function() { ran = true; return 42; }] });
            parent.spawnAndRun(child);

            expect(child._task.parent).to.equal(parent._task);
            // The run is scheduled via nextTick
            setTimeout(() => {
                expect(ran).to.be.true;
                done();
            }, 50);
        });

        it('should return child for chaining', () => {
            const parent = new Saico({ name: 'parent' });
            parent.activate();
            const child = new Saico({ name: 'child' });
            child.activate();
            const ret = parent.spawnAndRun(child);
            expect(ret).to.equal(child);
        });
    });

    describe('deactivate', () => {
        it('should cancel task and clean up', async () => {
            const s = new Saico();
            s.activate();
            await s.deactivate();
            expect(s._task).to.be.null;
            expect(s.isActive).to.be.false;
        });

        it('should be safe to call when not activated', async () => {
            const s = new Saico();
            await s.deactivate();
            expect(s._task).to.be.null;
        });

        it('should bubble cleaned messages to parent msgs Q', async () => {
            const parent = new Saico({ name: 'parent' });
            parent.activate({ createQ: true });

            const child = new Saico({ name: 'child' });
            child.activate({ createQ: true });
            parent.spawn(child);

            // Add some messages to child
            child.msgs._msgs.push({
                msg: { role: 'user', content: 'User msg' },
                opts: {}, msgid: 'c1', replied: 1,
            });
            child.msgs._msgs.push({
                msg: { role: 'assistant', content: 'Agent reply' },
                opts: {}, msgid: 'c2', replied: 3,
            });
            // Also add a BACKEND msg that should be filtered
            child.msgs._msgs.push({
                msg: { role: 'user', content: '[BACKEND] internal' },
                opts: {}, msgid: 'c3', replied: 1,
            });

            const parentMsgsBefore = parent.msgs._msgs.length;
            await child.deactivate();

            // Parent should have gained the user and assistant messages (not BACKEND)
            const newMsgs = parent.msgs._msgs.slice(parentMsgsBefore);
            expect(newMsgs.length).to.equal(2);
            expect(newMsgs[0].msg.content).to.equal('User msg');
            expect(newMsgs[1].msg.content).to.equal('Agent reply');
        });

        it('should clear msgs and msgs_id', async () => {
            const s = new Saico();
            s.activate({ createQ: true });
            expect(s.msgs).to.not.be.null;
            expect(s.msgs_id).to.not.be.null;
            await s.deactivate();
            expect(s.msgs).to.be.null;
            expect(s.msgs_id).to.be.null;
        });
    });

    describe('sendMessage orchestration', () => {
        it('should throw when not activated', async () => {
            const s = new Saico();
            try {
                await s.sendMessage('hello');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Not activated');
            }
        });

        it('should build preamble and pass to msgs Q', async () => {
            const s = new Saico({
                prompt: fakePrompt,
            });
            s.activate({ createQ: true });

            await s.sendMessage('hello');

            const sentArgs = openai.send.getCall(0).args[0];
            // The preamble should include the prompt
            expect(sentArgs.some(m => m.content === fakePrompt)).to.be.true;
            // And the user message
            expect(sentArgs.some(m => m.content === '[BACKEND] hello')).to.be.true;
        });

        it('should include state summary in preamble', async () => {
            class MyApp extends Saico {
                getStateSummary() { return 'my state'; }
            }
            const app = new MyApp({ prompt: 'test' });
            app.activate({ createQ: true });

            await app.sendMessage('hello');

            const sentArgs = openai.send.getCall(0).args[0];
            const summaryMsg = sentArgs.find(m =>
                m.role === 'system' && m.content?.includes('[State Summary]'));
            expect(summaryMsg).to.exist;
            expect(summaryMsg.content).to.include('my state');
        });

        it('should include tool digest from msgs Q in preamble', async () => {
            const s = new Saico({ prompt: 'test' });
            s.activate({ createQ: true });
            s.msgs._appendToolDigest('myTool', 'tool result');

            await s.sendMessage('hello');

            const sentArgs = openai.send.getCall(0).args[0];
            const digestMsg = sentArgs.find(m =>
                m.role === 'system' && m.content?.includes('[Tool Activity Log]'));
            expect(digestMsg).to.exist;
            expect(digestMsg.content).to.include('myTool');
        });

        it('should aggregate functions from Saico and pass via opts', async () => {
            const s = new Saico({
                prompt: 'test',
                functions: [{ name: 'func1' }],
            });
            s.activate({ createQ: true });

            await s.sendMessage('hello', [{ name: 'func2' }]);

            const sentFunctions = openai.send.getCall(0).args[1];
            expect(sentFunctions).to.have.length(2);
            expect(sentFunctions.map(f => f.name)).to.include.members(['func1', 'func2']);
        });

        it('should aggregate preamble from parent Saico chain', async () => {
            const parent = new Saico({
                name: 'parent',
                prompt: 'Parent prompt',
                functions: [{ name: 'parent_func' }],
            });
            parent.activate({ createQ: true });

            const child = new Saico({
                name: 'child',
                prompt: 'Child prompt',
                functions: [{ name: 'child_func' }],
            });
            child.activate({ createQ: true });
            parent.spawn(child);

            await child.sendMessage('hello');

            const sentArgs = openai.send.getCall(0).args[0];
            const sentFunctions = openai.send.getCall(0).args[1];

            // Both prompts should be in the preamble
            expect(sentArgs.some(m => m.content === 'Parent prompt')).to.be.true;
            expect(sentArgs.some(m => m.content === 'Child prompt')).to.be.true;

            // Both function sets should be aggregated
            expect(sentFunctions).to.have.length(2);
            expect(sentFunctions.map(f => f.name)).to.include.members(['parent_func', 'child_func']);
        });
    });

    describe('opt.isolate', () => {
        it('should stop ancestor aggregation at isolate boundary', async () => {
            const parent = new Saico({
                name: 'parent',
                prompt: 'Parent prompt',
                functions: [{ name: 'parent_func' }],
            });
            parent.activate({ createQ: true });

            const child = new Saico({
                name: 'child',
                prompt: 'Child prompt',
                functions: [{ name: 'child_func' }],
                isolate: true,
            });
            child.activate({ createQ: true });
            parent.spawn(child);

            await child.sendMessage('hello');

            const sentArgs = openai.send.getCall(0).args[0];
            const sentFunctions = openai.send.getCall(0).args[1];

            // Parent prompt should NOT be in the preamble
            expect(sentArgs.some(m => m.content === 'Parent prompt')).to.be.false;
            // Only child prompt
            expect(sentArgs.some(m => m.content === 'Child prompt')).to.be.true;
            // Only child functions
            expect(sentFunctions).to.have.length(1);
            expect(sentFunctions[0].name).to.equal('child_func');
        });

        it('should set isolate from constructor', () => {
            const s = new Saico({ isolate: true });
            expect(s.isolate).to.be.true;
        });
    });

    describe('recvChatMessage routing', () => {
        it('should throw when not activated', async () => {
            const s = new Saico();
            try {
                await s.recvChatMessage('hello');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Not activated');
            }
        });

        it('should route to own msgs Q', async () => {
            const s = new Saico({
                prompt: fakePrompt,
            });
            s.activate({ createQ: true });
            const reply = await s.recvChatMessage('hello');
            expect(reply.content).to.include('AI response');
        });

        it('should route DOWN to deepest child with msg Q', async () => {
            const parent = new Saico({
                name: 'parent',
                prompt: 'Parent prompt',
            });
            parent.activate({ createQ: true });

            const child = new Saico({
                name: 'child',
                prompt: 'Child prompt',
            });
            child.activate({ createQ: true });
            parent.spawn(child);

            // recvChatMessage on parent should route to child msgs Q
            await parent.recvChatMessage('hello from user');

            const childMsg = child.msgs._msgs.find(m =>
                m.msg.content === 'hello from user');
            expect(childMsg).to.exist;
        });

        it('should build preamble from full Saico chain', async () => {
            const parent = new Saico({
                name: 'parent',
                prompt: 'Parent prompt',
            });
            parent.activate({ createQ: true });

            await parent.recvChatMessage('hello');

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs.some(m => m.content === 'Parent prompt')).to.be.true;
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

    describe('getRecentMessages', () => {
        it('should return empty array when not activated', () => {
            const s = new Saico();
            expect(s.getRecentMessages()).to.deep.equal([]);
        });

        it('should return user/assistant messages only', () => {
            const s = new Saico();
            s.activate({ createQ: true });

            s.msgs._msgs.push(
                { msg: { role: 'user', content: 'Hello' }, opts: {}, replied: 1 },
                { msg: { role: 'assistant', content: 'Hi!' }, opts: {}, replied: 3 },
                { msg: { role: 'tool', content: 'result' }, opts: {}, replied: 1 },
                { msg: { role: 'user', content: '[BACKEND] internal' }, opts: {}, replied: 1 },
                { msg: { role: 'assistant', content: 'Done', tool_calls: [{}] }, opts: {}, replied: 3 },
            );

            const recent = s.getRecentMessages(10);
            expect(recent).to.have.length(2);
            expect(recent[0]).to.deep.equal({ role: 'user', content: 'Hello' });
            expect(recent[1]).to.deep.equal({ role: 'assistant', content: 'Hi!' });
        });

        it('should limit to N messages', () => {
            const s = new Saico();
            s.activate({ createQ: true });

            for (let i = 0; i < 10; i++) {
                s.msgs._msgs.push({
                    msg: { role: 'user', content: `msg ${i}` },
                    opts: {}, replied: 1,
                });
            }

            const recent = s.getRecentMessages(3);
            expect(recent).to.have.length(3);
            expect(recent[0].content).to.equal('msg 7');
        });
    });

    describe('_getStateSummary', () => {
        it('should include recent messages when msgs Q is not the active Q', () => {
            const parent = new Saico({ name: 'parent' });
            parent.activate({ createQ: true });

            parent.msgs._msgs.push(
                { msg: { role: 'user', content: 'Hello' }, opts: {}, replied: 1 },
                { msg: { role: 'assistant', content: 'Hi!' }, opts: {}, replied: 3 },
            );

            // Create a child msgs Q to make parent NOT the deepest
            const child = new Saico({ name: 'child' });
            child.activate({ createQ: true });
            parent.spawn(child);

            const summary = parent._getStateSummary(child.msgs);
            // Summary should include recent messages since parent is not the active Q
            expect(summary).to.be.an('array');
            const hasMessages = summary.some(item =>
                typeof item === 'object' && item.role === 'user' && item.content === 'Hello');
            expect(hasMessages).to.be.true;
        });

        it('should NOT include recent messages when msgs Q IS the active Q', () => {
            const s = new Saico({ name: 'test' });
            s.activate({ createQ: true });

            s.msgs._msgs.push(
                { msg: { role: 'user', content: 'Hello' }, opts: {}, replied: 1 },
            );

            // Pass own msgs Q as activeCtx
            const summary = s._getStateSummary(s.msgs);
            // Should be null (no state summary override, no recent messages since it IS active)
            expect(summary).to.be.null;
        });
    });

    describe('userData', () => {
        it('should initialize with empty userData', () => {
            const s = new Saico();
            expect(s.userData).to.deep.equal({});
        });

        it('should accept initial userData', () => {
            const s = new Saico({ userData: { key: 'val' } });
            expect(s.userData).to.deep.equal({ key: 'val' });
        });

        it('setUserData should set and return this', () => {
            const s = new Saico();
            const ret = s.setUserData('key', 'val');
            expect(ret).to.equal(s);
            expect(s.userData.key).to.equal('val');
        });

        it('getUserData should return specific key or all', () => {
            const s = new Saico({ userData: { a: 1, b: 2 } });
            expect(s.getUserData('a')).to.equal(1);
            expect(s.getUserData()).to.deep.equal({ a: 1, b: 2 });
        });

        it('clearUserData should reset and return this', () => {
            const s = new Saico({ userData: { a: 1 } });
            const ret = s.clearUserData();
            expect(ret).to.equal(s);
            expect(s.userData).to.deep.equal({});
        });
    });

    describe('getSessionInfo', () => {
        it('should return session info when not activated', () => {
            const s = new Saico({ name: 'test' });
            const info = s.getSessionInfo();
            expect(info.name).to.equal('test');
            expect(info.running).to.be.false;
            expect(info.completed).to.be.false;
            expect(info.messageCount).to.equal(0);
            expect(info.childCount).to.equal(0);
            expect(info.uptime).to.be.a('number');
        });

        it('should return session info when activated', () => {
            const s = new Saico({ name: 'test', userData: { x: 1 } });
            s.activate({ createQ: true });
            const info = s.getSessionInfo();
            expect(info.name).to.equal('test');
            expect(info.userData).to.deep.equal({ x: 1 });
            expect(info.messageCount).to.equal(0);
        });
    });

    describe('closeSession', () => {
        it('should cancel task', async () => {
            const s = new Saico({ name: 'test' });
            s.activate({ createQ: true });
            const task = s._task;
            await s.closeSession();
            await new Promise(resolve => setImmediate(resolve));
            expect(task._completed).to.be.true;
        });

        it('should save to registered backend when storeName is set', async () => {
            const mockBackend = { put: sandbox.stub().resolves(), get: sandbox.stub() };
            Saico._backend = mockBackend;

            const s = new Saico({ id: 'test-id', name: 'test', prompt: 'p', store: 'my-table' });
            s.activate({ createQ: true });
            s.msgs.push({ role: 'user', content: 'Hello' });
            s.msgs.push({ role: 'assistant', content: 'Hi there' });

            await s.closeSession();

            expect(mockBackend.put.calledOnce).to.be.true;
            const [data, table] = mockBackend.put.firstCall.args;
            expect(table).to.equal('my-table');
            expect(data.id).to.equal('test-id');
            expect(data.name).to.equal('test');
            expect(data.msgs).to.be.an('object');
            expect(data.msgs.chat_history).to.be.a('string'); // compressed
            expect(data.msgs.tool_digest).to.be.an('array');
        });

        it('should not save when no storeName', async () => {
            const mockBackend = { put: sandbox.stub().resolves() };
            Saico._backend = mockBackend;

            const s = new Saico({ id: 'test-id', name: 'test' });
            s.activate({ createQ: true });
            await s.closeSession();

            expect(mockBackend.put.called).to.be.false;
        });

        it('should be safe to call when not activated', async () => {
            const s = new Saico();
            await s.closeSession(); // should not throw
        });
    });

    describe('static restore', () => {
        it('should restore from backend with table name', async () => {
            const original = new Saico({ id: 'rh-id', name: 'rh-test', prompt: 'p' });
            original.activate({ createQ: true });
            original.msgs.push({ role: 'user', content: 'Hello' });
            original.msgs.push({ role: 'assistant', content: 'Hi' });

            const { chat_history, tool_digest } = await original.msgs.prepareForStorage();
            const storeData = {
                id: 'rh-id',
                name: 'rh-test',
                prompt: 'p',
                userData: {},
                sessionConfig: original.sessionConfig,
                tm_create: original.tm_create,
                isolate: false,
                taskId: original._task.id,
                msgs_id: original.msgs_id,
                msgs: {
                    tag: original.msgs.tag,
                    chat_history,
                    tool_digest,
                    functions: null,
                },
            };

            const mockBackend = {
                get: sandbox.stub().resolves(storeData),
                put: sandbox.stub().resolves(),
            };
            Saico._backend = mockBackend;

            const restored = await Saico.restore('rh-id', { store: 'my-table' });

            expect(restored).to.be.instanceOf(Saico);
            expect(restored.id).to.equal('rh-id');
            expect(restored.msgs).to.be.instanceOf(Msgs);
            expect(restored.msgs._msgs).to.have.length(2);
            expect(restored.msgs._msgs[0].msg.content).to.equal('Hello');
            expect(restored.msgs._msgs[1].msg.content).to.equal('Hi');
            expect(mockBackend.get.calledWith('id', 'rh-id', 'my-table')).to.be.true;
        });

        it('should return null when not found', async () => {
            const mockBackend = { get: sandbox.stub().resolves(undefined) };
            Saico._backend = mockBackend;
            const result = await Saico.restore('missing', { store: 'tbl' });
            expect(result).to.be.null;
        });

        it('should throw when no backend registered', async () => {
            try {
                await Saico.restore('id', { store: 'tbl' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('No backend');
            }
        });

        it('should throw when no table specified', async () => {
            Saico._backend = { get: sandbox.stub() };
            try {
                await Saico.restore('id');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('No table');
            }
        });
    });

    describe('accessors', () => {
        it('should return null for task/msgs/msgs_id when not activated', () => {
            const s = new Saico();
            expect(s.task).to.be.null;
            expect(s.msgs).to.be.null;
            expect(s.msgs_id).to.be.null;
            expect(s.isActive).to.be.false;
        });

        it('should return task/msgs after activation', () => {
            const s = new Saico();
            s.activate({ createQ: true });
            expect(s.task).to.be.instanceOf(Itask);
            expect(s.msgs).to.be.instanceOf(Msgs);
            expect(s.msgs_id).to.be.a('string');
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

            svc.counter = 5;
            expect(svc.counter).to.equal(5);
        });

        it('should be activatable after subclass construction', () => {
            class MyService extends Saico {
                constructor() {
                    super({ prompt: 'Base prompt' });
                }
            }

            const svc = new MyService();
            svc.activate({ createQ: true, prompt: 'Extra context' });
            expect(svc.isActive).to.be.true;
            expect(svc.msgs.prompt).to.include('Base prompt');
            expect(svc.msgs.prompt).to.include('Extra context');
        });
    });

    describe('serialize', () => {
        it('should serialize without task', async () => {
            const s = new Saico({ id: 'test-id', name: 'test', prompt: 'p' });
            const json = await s.serialize();
            const data = JSON.parse(json);
            expect(data.id).to.equal('test-id');
            expect(data.name).to.equal('test');
            expect(data.prompt).to.equal('p');
            expect(data.msgs).to.be.null;
            expect(data.msgs_id).to.be.null;
            expect(data.userData).to.deep.equal({});
            expect(data.sessionConfig).to.be.an('object');
            expect(data.tm_create).to.be.a('number');
            expect(data.isolate).to.be.false;
        });

        it('should serialize with activated task and compressed msgs', async () => {
            const s = new Saico({ id: 'test-id', name: 'test', prompt: 'p' });
            s.activate({ createQ: true });
            s.msgs.push({ role: 'user', content: 'Hello' });
            const json = await s.serialize();
            const data = JSON.parse(json);
            expect(data.msgs_id).to.be.a('string');
            expect(data.msgs).to.be.an('object');
            expect(data.msgs.tag).to.be.a('string');
            expect(data.msgs.chat_history).to.be.a('string'); // compressed
            expect(data.msgs.tool_digest).to.be.an('array');
        });

        it('should serialize activated task without msgs Q', async () => {
            const s = new Saico({ id: 'test-id' });
            s.activate();
            const json = await s.serialize();
            const data = JSON.parse(json);
            expect(data.msgs).to.be.null;
        });

        it('should include userData and sessionConfig', async () => {
            const s = new Saico({
                userData: { name: 'Ron' },
                sessionConfig: { max_depth: 3 },
            });
            const json = await s.serialize();
            const data = JSON.parse(json);
            expect(data.userData).to.deep.equal({ name: 'Ron' });
            expect(data.sessionConfig.max_depth).to.equal(3);
        });
    });

    describe('prepareForStorage', () => {
        it('should strip underscore-prefixed properties', async () => {
            const s = new Saico({ id: 'test-id', name: 'test' });
            s._secret = 'should-not-appear';
            const data = await s.prepareForStorage();
            expect(data._secret).to.be.undefined;
            expect(data._task).to.be.undefined;
            expect(data._db).to.be.undefined;
            expect(data._storeName).to.be.undefined;
        });

        it('should include public properties', async () => {
            const s = new Saico({ id: 'test-id', name: 'test', prompt: 'p', userData: { k: 'v' } });
            const data = await s.prepareForStorage();
            expect(data.id).to.equal('test-id');
            expect(data.name).to.equal('test');
            expect(data.prompt).to.equal('p');
            expect(data.userData).to.deep.equal({ k: 'v' });
        });

        it('should compress msgs via Msgs.prepareForStorage', async () => {
            const s = new Saico({ id: 'test-id' });
            s.activate({ createQ: true });
            s.msgs.push({ role: 'user', content: 'Hello' });
            const data = await s.prepareForStorage();
            expect(data.msgs.chat_history).to.be.a('string');
            expect(data.msgs.tool_digest).to.be.an('array');
            expect(data.msgs.tag).to.be.a('string');
        });

        it('should include taskId from internal task', async () => {
            const s = new Saico();
            s.activate();
            const data = await s.prepareForStorage();
            expect(data.taskId).to.equal(s._task.id);
        });

        it('should not include states', async () => {
            const s = new Saico();
            s.activate();
            const data = await s.prepareForStorage();
            expect(data.states).to.be.undefined;
        });
    });

    describe('registerBackend', () => {
        it('should throw for unknown type', () => {
            expect(() => Saico.registerBackend('mysql', {})).to.throw('Unknown backend');
        });

        it('should set and get backend', () => {
            const mockBackend = { put: sandbox.stub() };
            Saico._backend = mockBackend;
            expect(Saico.getBackend()).to.equal(mockBackend);
        });
    });

    describe('static deserialize', () => {
        it('should restore instance from serialized data', async () => {
            const original = new Saico({
                id: 'test-id',
                name: 'test',
                prompt: 'p',
                userData: { key: 'val' },
            });
            original.activate({ createQ: true });
            original.msgs.push({ role: 'user', content: 'Hello' });

            const serialized = await original.serialize();
            const restored = await Saico.deserialize(serialized);

            expect(restored.id).to.equal('test-id');
            expect(restored.name).to.equal('test');
            expect(restored.prompt).to.equal('p');
            expect(restored.userData).to.deep.equal({ key: 'val' });
            expect(restored.isActive).to.be.true;
            expect(restored.msgs).to.be.instanceOf(Msgs);
            expect(restored.msgs._msgs).to.have.length(1);
        });

        it('should restore without task data', async () => {
            const data = JSON.stringify({
                id: 'test-id',
                name: 'test',
                prompt: 'p',
            });
            const restored = await Saico.deserialize(data);
            expect(restored.id).to.equal('test-id');
            expect(restored.isActive).to.be.false;
        });

        it('should accept parsed object', async () => {
            const data = {
                id: 'test-id',
                name: 'test',
                prompt: 'p',
                tm_create: 1000,
            };
            const restored = await Saico.deserialize(data);
            expect(restored.id).to.equal('test-id');
            expect(restored.tm_create).to.equal(1000);
        });

        it('should restore tool_digest', async () => {
            const original = new Saico({ name: 'test' });
            original.activate({ createQ: true });
            original.msgs._appendToolDigest('myTool', 'result');

            const serialized = await original.serialize();
            const restored = await Saico.deserialize(serialized);

            expect(restored.msgs.tool_digest).to.have.length(1);
            expect(restored.msgs.tool_digest[0].tool).to.equal('myTool');
        });
    });

    describe('_deserializeRecord hook', () => {
        it('should return raw by default', () => {
            const s = new Saico();
            const raw = { id: '1', name: 'test' };
            expect(s._deserializeRecord(raw)).to.equal(raw);
        });

        it('should be called by dbGetItem', async () => {
            class MyService extends Saico {
                _deserializeRecord(raw) {
                    return { ...raw, deserialized: true };
                }
            }
            const fakeDb = { get: sandbox.stub().resolves({ id: '1' }) };
            const s = new MyService({ db: fakeDb });
            const result = await s.dbGetItem('id', '1', 'tbl');
            expect(result.deserialized).to.be.true;
        });

        it('should be called by dbQuery for each item', async () => {
            class MyService extends Saico {
                _deserializeRecord(raw) {
                    return { ...raw, deserialized: true };
                }
            }
            const fakeDb = {
                query: sandbox.stub().resolves([{ id: '1' }, { id: '2' }]),
            };
            const s = new MyService({ db: fakeDb });
            const results = await s.dbQuery('idx', 'k', 'v', 'tbl');
            expect(results).to.have.length(2);
            expect(results[0].deserialized).to.be.true;
            expect(results[1].deserialized).to.be.true;
        });

        it('should be called by dbGetAll for each item', async () => {
            class MyService extends Saico {
                _deserializeRecord(raw) {
                    return { ...raw, deserialized: true };
                }
            }
            const fakeDb = {
                getAll: sandbox.stub().resolves([{ id: '1' }]),
            };
            const s = new MyService({ db: fakeDb });
            const results = await s.dbGetAll('tbl');
            expect(results[0].deserialized).to.be.true;
        });
    });

    describe('_getSaicoAncestors', () => {
        it('should return just this when no parent', () => {
            const s = new Saico({ name: 'root' });
            s.activate();
            const chain = s._getSaicoAncestors();
            expect(chain).to.have.length(1);
            expect(chain[0]).to.equal(s);
        });

        it('should return parent chain ordered root→this', () => {
            const root = new Saico({ name: 'root' });
            root.activate();
            const child = new Saico({ name: 'child' });
            child.activate();
            root.spawn(child);

            const chain = child._getSaicoAncestors();
            expect(chain).to.have.length(2);
            expect(chain[0]).to.equal(root);
            expect(chain[1]).to.equal(child);
        });

        it('should stop at isolate boundary', () => {
            const root = new Saico({ name: 'root' });
            root.activate();
            const child = new Saico({ name: 'child', isolate: true });
            child.activate();
            root.spawn(child);

            const chain = child._getSaicoAncestors();
            expect(chain).to.have.length(1);
            expect(chain[0]).to.equal(child);
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

        it('should throw when no backend configured', async () => {
            const s = new Saico();
            try {
                await s.dbPutItem({ id: '1' }, 'tbl');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('No DB backend configured');
            }
        });

        it('_getDb should search parent chain', async () => {
            const parent = new Saico({ db: fakeDb });
            parent.activate();
            const child = new Saico();
            child.activate();
            parent.spawn(child);
            const item = await child.dbGetItem('id', '1', 'tbl');
            expect(item).to.deep.equal({ id: '1', name: 'test' });
            expect(fakeDb.get.calledOnce).to.be.true;
        });

        it('_getDb should throw when no db in chain and no registered backend', () => {
            const parent = new Saico();
            parent.activate();
            const child = new Saico();
            child.activate();
            parent.spawn(child);
            expect(() => child._getDb()).to.throw('No DB backend configured');
        });

        it('_getDb should fall back to registered backend', () => {
            const mockBackend = { put: sandbox.stub(), get: sandbox.stub() };
            Saico._backend = mockBackend;
            const s = new Saico();
            expect(s._getDb()).to.equal(mockBackend);
        });

        it('dbPutItem should delegate to backend.put', async () => {
            const s = new Saico({ db: fakeDb });
            await s.dbPutItem({ id: '1', name: 'test' });
            expect(fakeDb.put.calledOnce).to.be.true;
            expect(fakeDb.put.firstCall.args[0]).to.deep.equal({ id: '1', name: 'test' });
        });

        it('dbGetItem should delegate to backend.get and call _deserializeRecord', async () => {
            const s = new Saico({ db: fakeDb });
            const item = await s.dbGetItem('id', '1');
            expect(item).to.deep.equal({ id: '1', name: 'test' });
            expect(fakeDb.get.calledOnce).to.be.true;
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

        it('should pass table to backend', async () => {
            const s = new Saico({ db: fakeDb });
            await s.dbGetItem('id', '1', 'my-table');
            expect(fakeDb.get.firstCall.args[2]).to.equal('my-table');
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

        it('should not export Sid or createSid', () => {
            const saico = require('../index.js');
            expect(saico.Sid).to.be.undefined;
            expect(saico.createSid).to.be.undefined;
        });

        it('should not export legacy createQ or createTask', () => {
            const saico = require('../index.js');
            expect(saico.createQ).to.be.undefined;
            expect(saico.createTask).to.be.undefined;
        });
    });
});
