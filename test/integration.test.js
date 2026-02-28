'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const saico = require('../index.js');
const { Itask, Msgs, Saico, Store, createMsgs, DynamoDBAdapter } = saico;
const openai = require('../openai.js');
const util = require('../util.js');

describe('Integration Tests', function () {
    let sandbox;

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
    });

    afterEach(() => {
        sandbox.restore();
        Itask.root.clear();
        Store.instance = null;
        Saico._backend = null;
    });

    describe('Module exports', () => {
        it('should export all core classes', () => {
            expect(Itask).to.be.a('function');
            expect(Msgs).to.be.a('function');
            expect(Saico).to.be.a('function');
            expect(Store).to.be.a('function');
        });

        it('should export init function', () => {
            expect(saico.init).to.be.a('function');
        });

        it('should export createMsgs factory', () => {
            expect(createMsgs).to.be.a('function');
        });

        it('should not export legacy createTask or createQ', () => {
            expect(saico.createTask).to.be.undefined;
            expect(saico.createQ).to.be.undefined;
        });

        it('should not export Sid or createSid', () => {
            expect(saico.Sid).to.be.undefined;
            expect(saico.createSid).to.be.undefined;
        });

        it('should export utilities', () => {
            expect(saico.util).to.exist;
            expect(saico.openai).to.exist;
            expect(saico.redis).to.exist;
        });
    });

    describe('Hierarchical Message Flow', () => {
        it('should aggregate messages from Saico hierarchy', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'You are a helpful assistant.',
            });
            session.activate({ createQ: true });

            // Add summary to session context
            session.msgs.pushSummary('Previous conversation summary');

            // Create child Saico with context
            const child = new Saico({
                name: 'subtask',
                prompt: 'You are handling a specific subtask.',
            });
            child.activate({ createQ: true });
            session.spawn(child);

            // Send message from child via Saico orchestration
            await child.sendMessage('Working on subtask');

            const sentArgs = openai.send.getCall(0).args[0];

            // Saico orchestration: parent prompt + child prompt in preamble
            expect(sentArgs.some(m => m.content === 'You are a helpful assistant.')).to.be.true;
            expect(sentArgs.some(m => m.content === 'You are handling a specific subtask.')).to.be.true;
            expect(sentArgs.some(m => m.content === '[BACKEND] Working on subtask')).to.be.true;
        });

        it('should aggregate functions from hierarchy', async () => {
            const parentFunc = { name: 'parent_func', description: 'Parent function' };
            const childFunc = { name: 'child_func', description: 'Child function' };

            const session = new Saico({
                name: 'session',
                prompt: 'Root prompt',
                functions: [parentFunc],
            });
            session.activate({ createQ: true });

            const child = new Saico({
                name: 'child',
                prompt: 'Child prompt',
                functions: [childFunc],
            });
            child.activate({ createQ: true });
            session.spawn(child);

            // Saico.sendMessage aggregates functions from chain
            await child.sendMessage('Test message');

            const sentFunctions = openai.send.getCall(0).args[1];
            expect(sentFunctions).to.exist;
            expect(sentFunctions).to.have.length(2);
            const funcNames = sentFunctions.map(f => f.name);
            expect(funcNames).to.include('parent_func');
            expect(funcNames).to.include('child_func');
        });

        it('should handle multi-level hierarchy', async () => {
            const root = new Saico({
                name: 'root',
                prompt: 'Level 0',
            });
            root.activate({ createQ: true });

            const level1 = new Saico({
                name: 'level1',
                prompt: 'Level 1',
            });
            level1.activate({ createQ: true });
            root.spawn(level1);

            const level2 = new Saico({
                name: 'level2',
                prompt: 'Level 2',
            });
            level2.activate({ createQ: true });
            level1.spawn(level2);

            await level2.sendMessage('Deep message');

            const sentArgs = openai.send.getCall(0).args[0];

            // Saico orchestration: all ancestor prompts in preamble
            expect(sentArgs.some(m => m.content === 'Level 0')).to.be.true;
            expect(sentArgs.some(m => m.content === 'Level 1')).to.be.true;
            expect(sentArgs.some(m => m.content === 'Level 2')).to.be.true;
        });
    });

    describe('Task without Context', () => {
        it('should use ancestor context for sendMessage', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            // Child Saico without context (no createQ)
            const child = new Saico({ name: 'simple' });
            child.activate();
            session.spawn(child);

            // sendMessage on child without own context should find parent's context
            await child.sendMessage('Simple task message');

            expect(openai.send.calledOnce).to.be.true;
        });
    });

    describe('Tool Calls with Hierarchy', () => {
        it('should execute tool calls in hierarchical context', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.TOOL_test_tool = sandbox.stub().resolves({ content: 'tool result', functions: null });
            session.activate({ createQ: true });

            const toolCallReply = {
                content: 'Calling tool',
                tool_calls: [{
                    id: 'call_123',
                    type: 'function',
                    function: {
                        name: 'test_tool',
                        arguments: JSON.stringify({ action: 'test' })
                    }
                }]
            };

            openai.send.onFirstCall().resolves(toolCallReply);
            openai.send.onSecondCall().resolves({ content: 'Tool processed' });

            const reply = await session.sendMessage('Use a tool');

            expect(session.TOOL_test_tool.calledOnce).to.be.true;
            expect(session.TOOL_test_tool.firstCall.args[0]).to.deep.equal({ action: 'test' });
            expect(reply.content).to.include('Calling tool');
        });

        it('should find TOOL_ method from parent Saico', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.TOOL_child_tool = sandbox.stub().resolves({ content: 'tool result', functions: null });
            session.activate({ createQ: true });

            const child = new Saico({
                name: 'child',
                prompt: 'Child prompt',
            });
            child.activate({ createQ: true });
            session.spawn(child);

            const toolCallReply = {
                content: 'Calling tool',
                tool_calls: [{
                    id: 'call_456',
                    type: 'function',
                    function: {
                        name: 'child_tool',
                        arguments: '{}'
                    }
                }]
            };

            openai.send.onFirstCall().resolves(toolCallReply);
            openai.send.onSecondCall().resolves({ content: 'Done' });

            await child.sendMessage('Use tool from child');

            expect(session.TOOL_child_tool.calledOnce).to.be.true;
        });
    });

    describe('Deactivate and Message Bubbling', () => {
        it('should bubble cleaned messages to parent when deactivating', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            const child = new Saico({
                name: 'child',
                prompt: 'Child prompt',
            });
            child.activate({ createQ: true });
            session.spawn(child);

            // Add some conversation to child
            child.msgs._msgs.push({
                msg: { role: 'user', content: 'Hello from child' },
                opts: {},
                replied: 1
            });
            child.msgs._msgs.push({
                msg: { role: 'assistant', content: 'Hi there!' },
                opts: {},
                replied: 3
            });

            const parentMsgsBefore = session.msgs._msgs.length;
            await child.deactivate();

            // Parent should have gained the user and assistant messages
            const newMsgs = session.msgs._msgs.slice(parentMsgsBefore);
            expect(newMsgs.length).to.equal(2);
            expect(newMsgs[0].msg.content).to.equal('Hello from child');
            expect(newMsgs[1].msg.content).to.equal('Hi there!');
        });
    });

    describe('Serialization Round-Trip', () => {
        it('should preserve state through serialization', async () => {
            const original = new Saico({
                name: 'test-session',
                prompt: 'Test prompt',
                userData: { userId: '123', preferences: { theme: 'dark' } },
            });
            original.activate({ createQ: true });

            original.msgs.push({ role: 'user', content: 'Hello' });
            original.msgs.push({ role: 'assistant', content: 'Hi!' });
            original.msgs.pushSummary('Previous summary');

            const serialized = await original.serialize();
            const restored = await Saico.deserialize(serialized);

            expect(restored.name).to.equal(original.name);
            expect(restored.prompt).to.equal(original.prompt);
            expect(restored.id).to.equal(original.id);
            expect(restored.userData).to.deep.equal(original.userData);
            expect(restored.msgs).to.exist;
        });
    });

    describe('Concurrent Operations', () => {
        it('should handle multiple concurrent sendMessage calls', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            openai.send.resolves({ content: 'Response' });

            const promises = [
                session.sendMessage('Message 1'),
                session.sendMessage('Message 2'),
                session.sendMessage('Message 3')
            ];

            const results = await Promise.all(promises);

            expect(results).to.have.length(3);
            expect(results.filter(r => r.content === 'Response' || r.queued).length).to.equal(3);
        });

        it('should handle multiple child Saico instances', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            const children = [];
            for (let i = 0; i < 3; i++) {
                const child = new Saico({ name: `child-${i}` });
                child.activate({ states: [function() { return this.name; }] });
                session.spawn(child);
                children.push(child._task);
            }

            // Start all children
            children.forEach(c => c._run());

            const results = await Promise.all(children);

            expect(results).to.have.length(3);
        });
    });

    describe('Error Handling', () => {
        it('should handle sendMessage errors gracefully', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            openai.send.rejects(new Error('API Error'));

            try {
                await session.sendMessage('Hello');
                expect.fail('Should have thrown');
            } catch (err) {
                expect(err.message).to.equal('API Error');
            }
        });

        it('should handle recvChatMessage errors gracefully', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            openai.send.rejects(new Error('API Error'));

            try {
                await session.recvChatMessage('Hello');
                expect.fail('Should have thrown');
            } catch (err) {
                expect(err.message).to.equal('API Error');
            }
        });

        it('should handle tool handler errors', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.TOOL_failing_tool = sandbox.stub().rejects(new Error('Tool failed'));
            session.activate({ createQ: true });

            const toolCallReply = {
                content: 'Calling tool',
                tool_calls: [{
                    id: 'call_err',
                    type: 'function',
                    function: { name: 'failing_tool', arguments: '{}' }
                }]
            };

            openai.send.onFirstCall().resolves(toolCallReply);
            openai.send.onSecondCall().resolves({ content: 'Handled error' });

            const reply = await session.sendMessage('Use failing tool');

            // Should have continued with error message
            expect(reply).to.exist;
        });
    });

    describe('Msgs ID and Message Tagging', () => {
        it('should generate msgs_id for Saico with msgs Q', () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            expect(session.msgs_id).to.be.a('string');
            expect(session.msgs_id.length).to.be.greaterThan(0);
            expect(session.msgs.tag).to.equal(session.msgs_id);
        });

        it('should generate distinct msgs_id for child', () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            const child = new Saico({
                name: 'child',
                prompt: 'Child prompt',
            });
            child.activate({ createQ: true });
            session.spawn(child);

            expect(child.msgs_id).to.be.a('string');
            expect(child.msgs_id).to.not.equal(session.msgs_id);
        });

        it('should tag messages with msgs_id via sendMessage', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            await session.sendMessage('Backend instruction');

            const backendMsg = session.msgs._msgs.find(m =>
                m.msg.content === '[BACKEND] Backend instruction');
            expect(backendMsg).to.exist;
            expect(backendMsg.opts.tag).to.equal(session.msgs_id);
        });

        it('should tag messages with msgs_id via recvChatMessage', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            await session.recvChatMessage('User chat message');

            const chatMsg = session.msgs._msgs.find(m =>
                m.msg.content === 'User chat message');
            expect(chatMsg).to.exist;
            expect(chatMsg.opts.tag).to.equal(session.msgs.tag);
        });
    });

    describe('Context cleanToolCallsByTag', () => {
        it('should remove tool-related messages by tag', () => {
            const ctx = createMsgs('Test prompt', {});
            const testTag = 'test-tag-123';

            ctx._msgs.push({
                msg: { role: 'user', content: 'Hello' },
                opts: { tag: testTag },
                msgid: 'msg1',
                replied: 1
            });

            ctx._msgs.push({
                msg: {
                    role: 'assistant',
                    content: 'Calling tool',
                    tool_calls: [{ id: 'tc1', function: { name: 'test', arguments: '{}' } }]
                },
                opts: { tag: testTag },
                msgid: 'msg2',
                replied: 3
            });

            ctx._msgs.push({
                msg: { role: 'tool', content: 'result', tool_call_id: 'tc1' },
                opts: { tag: testTag },
                msgid: 'msg3',
                replied: 1
            });

            ctx._msgs.push({
                msg: { role: 'user', content: 'Other message' },
                opts: { tag: 'other-tag' },
                msgid: 'msg4',
                replied: 1
            });

            ctx.cleanToolCallsByTag(testTag);

            expect(ctx._msgs).to.have.length(2);
            expect(ctx._msgs[0].msg.content).to.equal('Hello');
            expect(ctx._msgs[1].msg.content).to.equal('Other message');
        });
    });

    describe('Context initHistory', () => {
        it('should decompress chat_history into _msgs', async () => {
            const compressed = await util.compressMessages([
                { role: 'user', content: 'Previous question' },
                { role: 'assistant', content: 'Previous answer' }
            ]);

            const ctx = createMsgs('System prompt', { tag: 'test-tag', chat_history: compressed });
            await ctx.initHistory();

            expect(ctx._msgs).to.have.length(2);
            expect(ctx._msgs[0].msg.content).to.equal('Previous question');
            expect(ctx._msgs[1].msg.content).to.equal('Previous answer');
        });

        it('should accept plain JSON chat_history', async () => {
            const json = JSON.stringify([
                { role: 'user', content: 'Plain question' },
                { role: 'assistant', content: 'Plain answer' }
            ]);

            const ctx = createMsgs('System prompt', { tag: 'test-tag', chat_history: json });
            await ctx.initHistory();

            expect(ctx._msgs).to.have.length(2);
            expect(ctx._msgs[0].msg.content).to.equal('Plain question');
        });
    });

    describe('Tool Digest Flow', () => {
        it('should populate tool_digest when handler mutates task public properties', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.TOOL_dirty_tool = sandbox.stub().callsFake(async () => {
                session.userData = { updated: true }; // mutates a non-_ property
                return { content: 'dirty result' };
            });
            session.activate({ createQ: true });

            const toolCallReply = {
                content: 'Calling tool',
                tool_calls: [{
                    id: 'call_dirty',
                    type: 'function',
                    function: { name: 'dirty_tool', arguments: '{}' }
                }]
            };
            openai.send.onFirstCall().resolves(toolCallReply);
            openai.send.onSecondCall().resolves({ content: 'Done' });

            await session.recvChatMessage('Do something dirty');

            expect(session.msgs.tool_digest).to.have.length(1);
            expect(session.msgs.tool_digest[0].tool).to.equal('dirty_tool');
            expect(session.msgs.tool_digest[0].result).to.equal('dirty result');
        });

        it('should not populate tool_digest when handler mutates nothing on the task', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.TOOL_normal_tool = sandbox.stub().resolves({ content: 'regular result' });
            session.activate({ createQ: true });

            const toolCallReply = {
                content: 'Calling tool',
                tool_calls: [{
                    id: 'call_normal',
                    type: 'function',
                    function: { name: 'normal_tool', arguments: '{}' }
                }]
            };
            openai.send.onFirstCall().resolves(toolCallReply);
            openai.send.onSecondCall().resolves({ content: 'Done' });

            await session.recvChatMessage('Do something normal');

            expect(session.msgs.tool_digest).to.have.length(0);
        });

        it('should include tool digest in subsequent OpenAI calls', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });

            // Pre-populate tool_digest
            session.msgs._appendToolDigest('prev_tool', 'previous result');

            await session.recvChatMessage('Hello');

            const sentArgs = openai.send.getCall(0).args[0];
            const digestMsg = sentArgs.find(m =>
                m.role === 'system' && m.content && m.content.includes('[Tool Activity Log]')
            );
            expect(digestMsg).to.exist;
            expect(digestMsg.content).to.include('prev_tool');
            expect(digestMsg.content).to.include('previous result');
        });
    });

    describe('Queue Limit', () => {
        it('should send at most QUEUE_LIMIT messages to OpenAI', async () => {
            const session = new Saico({
                name: 'session',
                prompt: 'Session prompt',
            });
            session.activate({ createQ: true });
            session.msgs.QUEUE_LIMIT = 10;
            session.msgs.MIN_CHAT_MESSAGES = 0;

            // Push 20 messages directly
            for (let i = 0; i < 20; i++) {
                session.msgs._msgs.push({
                    msg: { role: 'user', content: `old msg ${i}` },
                    opts: {},
                    msgid: `old${i}`,
                    replied: 1
                });
            }

            await session.recvChatMessage('New message');

            const sentArgs = openai.send.getCall(0).args[0];
            const userMsgs = sentArgs.filter(m => m.role === 'user');
            // Should have at most 10 user messages (the queue limit)
            expect(userMsgs.length).to.be.at.most(10);
        });
    });

    describe('Full Persistence Flow', () => {
        it('should create session, send messages, close, and restore', async () => {
            const saved = {};
            const mockBackend = {
                put: sinon.stub().callsFake((data, table) => { saved[data.id] = data; }),
                get: sinon.stub().callsFake((key, id, table) => saved[id] || undefined),
            };
            Saico._backend = mockBackend;

            const session = new Saico({
                id: 'persist-id',
                name: 'persist-session',
                prompt: 'Session prompt',
                store: 'sessions-table',
            });
            session.activate({ createQ: true });

            // Send backend message
            await session.sendMessage('Check booking');

            // Send user chat message
            await session.recvChatMessage('I want to book a hotel');

            // Verify both types are in the msgs Q
            const backendMsg = session.msgs._msgs.find(m =>
                m.msg.content === '[BACKEND] Check booking');
            expect(backendMsg).to.exist;

            const chatMsg = session.msgs._msgs.find(m =>
                m.msg.content === 'I want to book a hotel');
            expect(chatMsg).to.exist;

            // Close — saves compressed state to registered backend
            await session.closeSession();

            expect(mockBackend.put.calledOnce).to.be.true;
            const [data, table] = mockBackend.put.firstCall.args;
            expect(table).to.equal('sessions-table');
            expect(data.id).to.equal('persist-id');
            expect(data.msgs.chat_history).to.be.a('string');

            // Restore from registered backend
            const restored = await Saico.restore('persist-id', { store: 'sessions-table' });
            expect(restored.id).to.equal('persist-id');
            expect(restored.name).to.equal('persist-session');
            expect(restored.msgs).to.exist;

            // Verify chat msg survived (backend msgs are filtered out by prepareForStorage)
            const restoredChat = restored.msgs._msgs.find(m =>
                m.msg.content === 'I want to book a hotel');
            expect(restoredChat).to.exist;

            // Backend msg should not be in restored (filtered by prepareForStorage)
            const restoredBackend = restored.msgs._msgs.find(m =>
                m.msg.content && m.msg.content.includes('[BACKEND]'));
            expect(restoredBackend).to.not.exist;
        });
    });
});
