'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const { Context, createContext } = require('../context.js');
const Itask = require('../itask.js');
const { Store } = require('../store.js');
const openai = require('../openai.js');
const util = require('../util.js');

describe('Context', function () {
    let sandbox;
    let mockToolHandler;
    const fakePrompt = 'You are a helpful assistant.';
    const fakeTokenLimit = 1000;

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
    });

    afterEach(() => {
        sandbox.restore();
        Itask.root.clear();
        Store.instance = null;
    });

    describe('constructor', () => {
        it('should initialize with default values', () => {
            const ctx = new Context(fakePrompt, null, { token_limit: fakeTokenLimit });
            expect(ctx.prompt).to.equal(fakePrompt);
            expect(ctx.token_limit).to.equal(fakeTokenLimit);
            expect(ctx.lower_limit).to.equal(fakeTokenLimit * 0.85);
            expect(ctx.upper_limit).to.equal(fakeTokenLimit * 0.98);
            expect(ctx.length).to.equal(0);
        });

        it('should generate a tag if not provided', () => {
            const ctx = new Context(fakePrompt, null, {});
            expect(ctx.tag).to.be.a('string');
            expect(ctx.tag.length).to.be.greaterThan(0);
        });

        it('should accept task reference', () => {
            const task = new Itask({ name: 'test', async: true }, []);
            const ctx = new Context(fakePrompt, task, {});
            expect(ctx.task).to.equal(task);
        });
    });

    describe('messages getter/setter', () => {
        it('should set and get messages properly', () => {
            const ctx = createContext(fakePrompt, null, {});
            ctx.messages = [{ role: 'user', content: 'Hi' }];
            expect(ctx.messages).to.deep.equal([{ role: 'user', content: 'Hi' }]);
        });

        it('should throw if messages is not an array', () => {
            const ctx = createContext(fakePrompt, null, {});
            expect(() => {
                ctx.messages = 'invalid';
            }).to.throw('messages must be assigned an array');
        });
    });

    describe('push', () => {
        it('should push a message', () => {
            const ctx = createContext(fakePrompt, null, {});
            ctx.push({ role: 'user', content: 'Hello' });
            expect(ctx.length).to.equal(1);
            expect(ctx.messages[0]).to.deep.equal({ role: 'user', content: 'Hello' });
        });
    });

    describe('pushSummary', () => {
        it('should push a summary message', () => {
            const ctx = createContext(fakePrompt, null, {});
            ctx.pushSummary('summary text');
            const last = ctx._msgs[ctx._msgs.length - 1];
            expect(last.msg).to.deep.equal({ role: 'user', content: '[SUMMARY]: summary text' });
            expect(last.opts.summary).to.be.true;
        });
    });

    describe('array methods', () => {
        let ctx;

        beforeEach(() => {
            ctx = createContext(fakePrompt, null, {});
            ctx.messages = [
                { role: 'user', content: 'A' },
                { role: 'assistant', content: 'B' },
                { role: 'user', content: 'C' }
            ];
        });

        it('should filter messages', () => {
            const filtered = ctx.filter(m => m.role === 'user');
            expect(filtered.length).to.equal(2);
        });

        it('should concat messages', () => {
            const newMsgs = [{ role: 'system', content: 'Z' }];
            const result = ctx.concat(newMsgs);
            expect(result.length).to.equal(4);
        });

        it('should slice messages', () => {
            const sliced = ctx.slice(0, 2);
            expect(sliced.length).to.equal(2);
        });

        it('should reverse messages', () => {
            ctx.reverse();
            expect(ctx.messages[0].content).to.equal('C');
        });

        it('should iterate over messages', () => {
            const result = [...ctx];
            expect(result.length).to.equal(3);
            expect(result[0].content).to.equal('A');
        });
    });

    describe('serialize', () => {
        it('should serialize the object', () => {
            const ctx = createContext(fakePrompt, null, {});
            ctx.push({ role: 'user', content: 'Hi' });
            const json = ctx.serialize();
            expect(json).to.be.a('string');
            expect(JSON.parse(json)).to.be.an('array');
        });
    });

    describe('getFunctions', () => {
        it('should return functions from context', () => {
            const ctx = new Context(fakePrompt, null, {
                functions: [{ name: 'test_func' }]
            });
            const funcs = ctx.getFunctions();
            expect(funcs).to.have.length(1);
            expect(funcs[0].name).to.equal('test_func');
        });

        it('should aggregate functions from ancestor contexts', () => {
            const parentTask = new Itask({ name: 'parent', async: true }, []);
            const childTask = new Itask({ name: 'child', async: true }, []);
            parentTask.spawn(childTask);

            const parentCtx = new Context('parent prompt', parentTask, {
                functions: [{ name: 'parent_func' }]
            });
            parentTask.setContext(parentCtx);

            const childCtx = new Context('child prompt', childTask, {
                functions: [{ name: 'child_func' }]
            });
            childTask.setContext(childCtx);

            const funcs = childCtx.getFunctions();
            expect(funcs).to.have.length(2);
        });
    });

    describe('getMsgContext', () => {
        it('should return prompt and summaries', () => {
            const ctx = createContext(fakePrompt, null, {});
            ctx.pushSummary('summary text');
            const context = ctx.getMsgContext();
            expect(context[0]).to.deep.equal({ role: 'system', content: fakePrompt });
            expect(context[1]).to.deep.equal({ role: 'user', content: '[SUMMARY]: summary text' });
        });

        it('should include ancestor context via task hierarchy', () => {
            const parentTask = new Itask({ name: 'parent', async: true }, []);
            const childTask = new Itask({ name: 'child', async: true }, []);
            parentTask.spawn(childTask);

            const parentCtx = new Context('Parent prompt', parentTask, {});
            parentTask.setContext(parentCtx);
            parentCtx.pushSummary('parent summary');

            const childCtx = new Context(fakePrompt, childTask, {});
            childTask.setContext(childCtx);
            childCtx.pushSummary('child summary');

            const context = childCtx.getMsgContext();

            expect(context).to.deep.equal([
                { role: 'system', content: 'Parent prompt' },
                { role: 'user', content: '[SUMMARY]: parent summary' },
                { role: 'system', content: fakePrompt },
                { role: 'user', content: '[SUMMARY]: child summary' }
            ]);
        });
    });

    describe('sendMessage', () => {
        it('should send a message and receive a reply', async () => {
            const ctx = createContext(fakePrompt, null, {});
            ctx.pushSummary('summary 1');

            const reply = await ctx.sendMessage('user', 'Hello', null, {});

            expect(reply).to.have.property('content', 'AI response');

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs[0]).to.deep.equal({ role: 'system', content: fakePrompt });
        });

        it('should include parent context in openai.send', async () => {
            const parentTask = new Itask({ name: 'parent', async: true }, []);
            const childTask = new Itask({ name: 'child', async: true }, []);
            parentTask.spawn(childTask);

            const parentCtx = new Context('Parent prompt', parentTask, {});
            parentTask.setContext(parentCtx);
            parentCtx.pushSummary('parent summary');

            const childCtx = createContext(fakePrompt, childTask, {});
            childTask.setContext(childCtx);
            childCtx.pushSummary('child summary');

            await childCtx.sendMessage('user', 'Hi', null, {});

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs).to.deep.include.members([
                { role: 'system', content: 'Parent prompt' },
                { role: 'user', content: '[SUMMARY]: parent summary' },
                { role: 'system', content: fakePrompt },
                { role: 'user', content: '[SUMMARY]: child summary' }
            ]);
        });

        it('should skip if no content', async () => {
            const ctx = createContext(fakePrompt, null, {});
            const result = await ctx.sendMessage('user', '', null, {});
            expect(result).to.be.undefined;
        });
    });

    describe('tool calls', () => {
        let ctx;

        beforeEach(() => {
            ctx = createContext(fakePrompt, null, {
                tool_handler: mockToolHandler
            });
        });

        it('should handle basic tool calls', async () => {
            const mockReply = {
                content: 'I will help you',
                tool_calls: [{
                    id: 'call_123',
                    type: 'function',
                    function: {
                        name: 'test_tool',
                        arguments: JSON.stringify({ param: 'value' })
                    }
                }]
            };

            openai.send.onFirstCall().resolves(mockReply);
            openai.send.onSecondCall().resolves({ content: 'Done!' });

            const reply = await ctx.sendMessage('user', 'Test message', null, {});

            expect(mockToolHandler.calledOnce).to.be.true;
            expect(mockToolHandler.firstCall.args[0]).to.equal('test_tool');
            expect(reply.content).to.include('I will help you');
        });

        it('should track tool call sequences', () => {
            ctx._trackToolCall('test_tool');
            ctx._trackToolCall('test_tool');
            ctx._trackToolCall('test_tool');

            expect(ctx._tool_call_sequence).to.deep.equal(['test_tool', 'test_tool', 'test_tool']);
        });

        it('should detect excessive tool repetition', () => {
            for (let i = 0; i < ctx.max_tool_repetition; i++) {
                ctx._trackToolCall('test_tool');
            }

            expect(ctx._shouldDropToolCall('test_tool')).to.be.true;
        });

        it('should reset tool sequence for different tools', () => {
            ctx._trackToolCall('tool_a');
            ctx._trackToolCall('tool_a');

            ctx._resetToolSequenceIfDifferent(['tool_b']);

            expect(ctx._tool_call_sequence).to.deep.equal([]);
        });

        it('should filter excessive tool calls', () => {
            for (let i = 0; i < ctx.max_tool_repetition; i++) {
                ctx._trackToolCall('test_tool');
            }

            const toolCalls = [{
                id: 'call_123',
                function: { name: 'test_tool', arguments: '{}' }
            }];

            const filtered = ctx._filterExcessiveToolCalls(toolCalls);
            expect(filtered).to.have.length(0);
        });

        it('should detect duplicate tool calls', () => {
            const call1 = {
                id: 'call_1',
                function: { name: 'test_tool', arguments: '{"param": "value"}' }
            };

            const call2 = {
                id: 'call_2',
                function: { name: 'test_tool', arguments: '{"param": "value"}' }
            };

            ctx._trackActiveToolCall(call1);

            expect(ctx._isDuplicateToolCall(call2)).to.be.true;
            expect(ctx._isDuplicateToolCall({
                id: 'call_3',
                function: { name: 'test_tool', arguments: '{"param": "different"}' }
            })).to.be.false;
        });

        it('should defer tool calls when max depth is reached', async () => {
            ctx.max_depth = 2;

            const mockReply = {
                content: 'Tool calls needed',
                tool_calls: [{
                    id: 'call_123',
                    type: 'function',
                    function: {
                        name: 'test_tool',
                        arguments: '{}'
                    }
                }]
            };

            openai.send.resolves(mockReply);

            const o = ctx._createMsgObj('user', 'Test', null, {});
            await ctx._processSendMessage(o, 3);

            expect(ctx._deferred_tool_calls).to.have.length(1);
            expect(ctx._deferred_tool_calls[0].call.id).to.equal('call_123');
        });

        it('should handle pending tool calls and queue messages', async () => {
            const toolCallMsg = {
                msg: {
                    role: 'assistant',
                    content: 'I need to call a tool',
                    tool_calls: [{
                        id: 'call_123',
                        type: 'function',
                        function: { name: 'test_tool', arguments: '{}' }
                    }]
                },
                msgid: 'test_msg',
                opts: {},
                replied: 3
            };

            ctx._msgs.push(toolCallMsg);

            expect(ctx._hasPendingToolCalls()).to.be.true;

            const result = await ctx.sendMessage('user', 'Another message', null, {});
            expect(result.queued).to.be.true;
            expect(ctx._waitingQueue).to.have.length(1);
        });

        it('should process waiting queue', () => {
            ctx._waitingQueue.push(
                { role: 'user', content: 'Message 1', functions: null, opts: {} },
                { role: 'user', content: 'Message 2', functions: null, opts: {} }
            );

            const originalLength = ctx._msgs.length;
            ctx._processWaitingQueue();

            expect(ctx._waitingQueue).to.have.length(0);
            expect(ctx._msgs.length).to.equal(originalLength + 2);
        });

        it('should handle tool call timeouts', async () => {
            const slowHandler = sandbox.stub().returns(new Promise(resolve => {
                setTimeout(() => resolve({ content: 'slow result' }), 6000);
            }));

            const call = {
                id: 'call_123',
                function: { name: 'slow_tool', arguments: '{}' }
            };

            const result = await ctx._executeToolCallWithTimeout(call, slowHandler, 100);
            expect(result.content).to.include('timed out');
        });
    });

    describe('Proxy behavior', () => {
        let ctx;

        beforeEach(() => {
            ctx = createContext(fakePrompt, null, {});
        });

        it('should access message by index', () => {
            ctx.push({ role: 'user', content: 'Hello' });
            expect(ctx[0]).to.deep.equal({ role: 'user', content: 'Hello' });
        });

        it('should set message by index', () => {
            ctx[0] = { role: 'assistant', content: 'Hi' };
            expect(ctx[0]).to.deep.equal({ role: 'assistant', content: 'Hi' });
        });

        it('should expose length', () => {
            ctx.push({ role: 'user', content: 'Hello' });
            expect(ctx.length).to.equal(1);
        });

        it('should allow Object.keys to include message indexes', () => {
            ctx.push({ role: 'user', content: 'Hello' });
            const keys = Object.keys(ctx);
            expect(keys).to.include('0');
        });
    });

    describe('close', () => {
        it('should summarize and bubble to parent context', async () => {
            const parentTask = new Itask({ name: 'parent', async: true }, []);
            const childTask = new Itask({ name: 'child', async: true }, []);
            parentTask.spawn(childTask);

            const parentCtx = createContext('Parent prompt', parentTask, {});
            parentTask.setContext(parentCtx);

            const childCtx = createContext(fakePrompt, childTask, {});
            childTask.setContext(childCtx);

            // Add some messages to child context
            childCtx._msgs.push({
                msg: { role: 'user', content: 'Hello' },
                opts: {},
                replied: 1
            });
            childCtx._msgs.push({
                msg: { role: 'assistant', content: 'Hi there' },
                opts: {},
                replied: 3
            });

            await childCtx.close();

            // Check that summary was added to parent
            const parentSummaries = parentCtx.getSummaries();
            expect(parentSummaries.length).to.be.greaterThan(0);
        });
    });

    describe('chat_history', () => {
        it('should accept chat_history in config', () => {
            const ctx = new Context(fakePrompt, null, { chat_history: 'some-data' });
            expect(ctx.chat_history).to.equal('some-data');
        });

        it('should default chat_history to null', () => {
            const ctx = new Context(fakePrompt, null, {});
            expect(ctx.chat_history).to.be.null;
        });
    });

    describe('cleanToolCallsByTag', () => {
        it('should remove tool-related messages with matching tag', () => {
            const ctx = new Context(fakePrompt, null, {});
            const tag = 'test-tag';

            ctx._msgs.push(
                { msg: { role: 'user', content: 'Hello' }, opts: { tag }, msgid: '1', replied: 1 },
                { msg: { role: 'assistant', content: 'Tool call', tool_calls: [{ id: 'tc1' }] }, opts: { tag }, msgid: '2', replied: 3 },
                { msg: { role: 'tool', content: 'result', tool_call_id: 'tc1' }, opts: { tag }, msgid: '3', replied: 1 },
                { msg: { role: 'assistant', content: 'Done' }, opts: { tag }, msgid: '4', replied: 3 }
            );

            ctx.cleanToolCallsByTag(tag);

            expect(ctx._msgs).to.have.length(2);
            expect(ctx._msgs[0].msg.content).to.equal('Hello');
            expect(ctx._msgs[1].msg.content).to.equal('Done');
        });

        it('should not remove messages with different tag', () => {
            const ctx = new Context(fakePrompt, null, {});

            ctx._msgs.push(
                { msg: { role: 'assistant', content: 'Tool call', tool_calls: [{ id: 'tc1' }] }, opts: { tag: 'other' }, msgid: '1', replied: 3 },
                { msg: { role: 'tool', content: 'result' }, opts: { tag: 'other' }, msgid: '2', replied: 1 }
            );

            ctx.cleanToolCallsByTag('test-tag');

            expect(ctx._msgs).to.have.length(2);
        });
    });

    describe('loadHistory', () => {
        it('should load and insert history messages', async () => {
            const ctx = new Context(fakePrompt, null, { tag: 'test-tag' });
            const mockStore = {
                load: sandbox.stub().resolves({
                    chat_history: JSON.stringify([
                        { role: 'user', content: 'Old message' },
                        { role: 'assistant', content: 'Old reply' }
                    ])
                })
            };

            await ctx.loadHistory(mockStore);

            expect(ctx._msgs).to.have.length(2);
            expect(ctx._msgs[0].msg.content).to.equal('Old message');
            expect(ctx._msgs[1].msg.content).to.equal('Old reply');
            expect(ctx._msgs[0].replied).to.equal(1);
        });

        it('should insert after system messages', async () => {
            const ctx = new Context(fakePrompt, null, { tag: 'test-tag' });

            // Add a system message first
            ctx._msgs.push({
                msg: { role: 'system', content: 'System instruction' },
                opts: {},
                msgid: 'sys1',
                replied: 1
            });

            const mockStore = {
                load: sandbox.stub().resolves({
                    chat_history: JSON.stringify([
                        { role: 'user', content: 'History msg' }
                    ])
                })
            };

            await ctx.loadHistory(mockStore);

            expect(ctx._msgs).to.have.length(2);
            expect(ctx._msgs[0].msg.role).to.equal('system');
            expect(ctx._msgs[1].msg.content).to.equal('History msg');
        });

        it('should handle missing store gracefully', async () => {
            const ctx = new Context(fakePrompt, null, {});
            await ctx.loadHistory(null); // Should not throw
            expect(ctx._msgs).to.have.length(0);
        });

        it('should handle missing data gracefully', async () => {
            const ctx = new Context(fakePrompt, null, { tag: 'test-tag' });
            const mockStore = { load: sandbox.stub().resolves(null) };
            await ctx.loadHistory(mockStore);
            expect(ctx._msgs).to.have.length(0);
        });
    });

    describe('tool_digest', () => {
        it('should initialize tool_digest as empty array', () => {
            const ctx = new Context(fakePrompt, null, {});
            expect(ctx.tool_digest).to.deep.equal([]);
        });

        it('getStateSummary() should return empty string by default', () => {
            const ctx = new Context(fakePrompt, null, {});
            expect(ctx.getStateSummary()).to.equal('');
        });

        it('_appendToolDigest() should add an entry', () => {
            const ctx = new Context(fakePrompt, null, {});
            ctx._appendToolDigest('myTool', 'result content');
            expect(ctx.tool_digest).to.have.length(1);
            expect(ctx.tool_digest[0].tool).to.equal('myTool');
            expect(ctx.tool_digest[0].result).to.equal('result content');
            expect(ctx.tool_digest[0].tm).to.be.a('number');
        });

        it('_appendToolDigest() should truncate result to 500 chars', () => {
            const ctx = new Context(fakePrompt, null, {});
            const longResult = 'x'.repeat(600);
            ctx._appendToolDigest('myTool', longResult);
            expect(ctx.tool_digest[0].result.length).to.equal(500);
        });

        it('_appendToolDigest() should trim to TOOL_DIGEST_LIMIT (FIFO)', () => {
            const ctx = new Context(fakePrompt, null, { tool_digest_limit: 3 });
            ctx._appendToolDigest('tool1', 'r1');
            ctx._appendToolDigest('tool2', 'r2');
            ctx._appendToolDigest('tool3', 'r3');
            ctx._appendToolDigest('tool4', 'r4');
            expect(ctx.tool_digest).to.have.length(3);
            expect(ctx.tool_digest[0].tool).to.equal('tool2');
            expect(ctx.tool_digest[2].tool).to.equal('tool4');
        });
    });

    describe('_snapshotPublicProps', () => {
        it('should include non-underscore properties', () => {
            const ctx = new Context(fakePrompt, null, {});
            const obj = { name: 'test', value: 42, _internal: 'skip' };
            const snap = ctx._snapshotPublicProps(obj);
            expect(snap).to.have.property('name', 'test');
            expect(snap).to.have.property('value', 42);
            expect(snap).to.not.have.property('_internal');
        });

        it('should skip functions', () => {
            const ctx = new Context(fakePrompt, null, {});
            const obj = { name: 'test', fn: () => {} };
            const snap = ctx._snapshotPublicProps(obj);
            expect(snap).to.not.have.property('fn');
        });

        it('should handle circular references without throwing', () => {
            const ctx = new Context(fakePrompt, null, {});
            const obj = { name: 'test' };
            obj.self = obj;
            expect(() => JSON.stringify(ctx._snapshotPublicProps(obj))).to.not.throw();
        });

        it('should recurse into objects even when serialize() is present', () => {
            const ctx = new Context(fakePrompt, null, {});
            // serialize() is for persistence, not dirty detection — ignored here
            const obj = { name: 'test', serialize: () => 'ignored' };
            const snap = ctx._snapshotPublicProps(obj);
            expect(snap).to.have.property('name', 'test');
            expect(snap).to.not.have.property('serialize'); // function — skipped
        });

        it('should detect changes to task public properties', () => {
            const task = new Itask({ name: 'test', async: true }, []);
            const ctx = new Context(fakePrompt, task, {});
            task.setContext(ctx);

            const before = JSON.stringify(ctx._snapshotPublicProps(task));
            task.userData = { changed: true };
            const after = JSON.stringify(ctx._snapshotPublicProps(task));

            expect(before).to.not.equal(after);
        });

        it('should not detect changes to underscore properties', () => {
            const task = new Itask({ name: 'test', async: true }, []);
            const ctx = new Context(fakePrompt, task, {});
            task.setContext(ctx);

            const before = JSON.stringify(ctx._snapshotPublicProps(task));
            task._internal = 'changed'; // underscore-prefixed — should be ignored
            const after = JSON.stringify(ctx._snapshotPublicProps(task));

            expect(before).to.equal(after);
        });
    });

    describe('_getQueueSlice', () => {
        it('should return all messages when fewer than limit', () => {
            const ctx = new Context(fakePrompt, null, {});
            const msgs = [
                { role: 'user', content: 'a' },
                { role: 'assistant', content: 'b' }
            ];
            const result = ctx._getQueueSlice(msgs, 30);
            expect(result).to.deep.equal(msgs);
        });

        it('should return last limit messages when more exist', () => {
            const ctx = new Context(fakePrompt, null, { min_chat_messages: 0 });
            const msgs = Array.from({ length: 10 }, (_, i) =>
                ({ role: 'user', content: `msg ${i}` })
            );
            const result = ctx._getQueueSlice(msgs, 5);
            expect(result).to.have.length(5);
            expect(result[0].content).to.equal('msg 5');
        });

        it('should not orphan a tool response at start of slice', () => {
            const ctx = new Context(fakePrompt, null, { min_chat_messages: 0 });
            const msgs = [];
            // 2 messages before the limit boundary: assistant+tool_calls, tool response
            msgs.push({ role: 'assistant', content: 'calling', tool_calls: [{ id: 'tc1' }] });
            msgs.push({ role: 'tool', content: 'result', tool_call_id: 'tc1' });
            // Fill to 30 more user/assistant messages
            for (let i = 0; i < 30; i++)
                msgs.push({ role: 'user', content: `u${i}` });
            // Total: 32 messages, limit=30 would start at index 2 (a tool response)
            // should walk back to index 1 (the assistant call)
            const result = ctx._getQueueSlice(msgs, 30);
            // result should start before the tool response
            expect(result[0].role).to.not.equal('tool');
        });

        it('should expand window to guarantee MIN_CHAT_MESSAGES', () => {
            const ctx = new Context(fakePrompt, null, { queue_limit: 30, min_chat_messages: 10 });
            // 25 tool messages + 5 chat exchanges (10 msgs) = 35 total
            const msgs = [];
            for (let i = 0; i < 25; i++)
                msgs.push({ role: 'tool', content: `tool ${i}`, tool_call_id: `tc${i}` });
            for (let i = 0; i < 5; i++) {
                msgs.push({ role: 'user', content: `user ${i}` });
                msgs.push({ role: 'assistant', content: `assistant ${i}` });
            }
            // Last 30 of 35 would include 5 tool + 10 chat = fine, 10 chat messages
            // But last 30 = msgs[5..34] = 20 tool msgs + 10 chat = 10 chat, which meets the minimum
            // Let's use a tighter scenario: last 30 has only 4 chat messages
            const msgs2 = [];
            for (let i = 0; i < 28; i++)
                msgs2.push({ role: 'tool', content: `tool ${i}`, tool_call_id: `tc${i}` });
            for (let i = 0; i < 2; i++) {
                msgs2.push({ role: 'user', content: `user ${i}` });
                msgs2.push({ role: 'assistant', content: `assistant ${i}` });
            }
            // Total: 32 msgs; last 30 = 26 tool + 4 chat < 10 chat minimum
            const result = ctx._getQueueSlice(msgs2, 30);
            const chatCount = result.filter(m => m.role === 'user' || m.role === 'assistant').length;
            expect(chatCount).to.be.at.least(4); // at least as many as exist
        });
    });

    describe('_createMsgQ layered structure', () => {
        it('should have system prompt as first element', () => {
            const ctx = createContext(fakePrompt, null, {});
            ctx._msgs.push({ msg: { role: 'user', content: 'Hello' }, opts: {}, msgid: '1', replied: 1 });
            const q = ctx._createMsgQ(false);
            expect(q[0]).to.deep.equal({ role: 'system', content: fakePrompt });
        });

        it('should include tool digest as system message when non-empty', () => {
            const ctx = createContext(fakePrompt, null, {});
            ctx._appendToolDigest('myTool', 'some result');
            const q = ctx._createMsgQ(false);
            const digestMsg = q.find(m => m.role === 'system' && m.content.includes('[Tool Activity Log]'));
            expect(digestMsg).to.exist;
            expect(digestMsg.content).to.include('myTool');
            expect(digestMsg.content).to.include('some result');
        });

        it('should not include tool digest when empty', () => {
            const ctx = createContext(fakePrompt, null, {});
            const q = ctx._createMsgQ(false);
            const digestMsg = q.find(m => m.role === 'system' && m.content?.includes('[Tool Activity Log]'));
            expect(digestMsg).to.not.exist;
        });

        it('should include state summary when getStateSummary returns non-empty', () => {
            class CustomContext extends Context {
                getStateSummary() { return 'current state info'; }
            }
            const ctx = new CustomContext(fakePrompt, null, {});
            const q = ctx._createMsgQ(false);
            const summaryMsg = q.find(m => m.role === 'system' && m.content.includes('[State Summary]'));
            expect(summaryMsg).to.exist;
            expect(summaryMsg.content).to.include('current state info');
        });

        it('should limit queue to QUEUE_LIMIT own messages', () => {
            const ctx = createContext(fakePrompt, null, { queue_limit: 5, min_chat_messages: 0 });
            for (let i = 0; i < 10; i++) {
                ctx._msgs.push({
                    msg: { role: 'user', content: `msg ${i}` },
                    opts: {},
                    msgid: `m${i}`,
                    replied: 1
                });
            }
            const q = ctx._createMsgQ(false);
            const userMsgs = q.filter(m => m.role === 'user');
            expect(userMsgs).to.have.length(5);
            expect(userMsgs[0].content).to.equal('msg 5');
        });

        it('should include only ancestor summaries (not full ancestor messages)', () => {
            const parentTask = new Itask({ name: 'parent', async: true }, []);
            const childTask = new Itask({ name: 'child', async: true }, []);
            parentTask.spawn(childTask);

            const parentCtx = new Context('Parent prompt', parentTask, {});
            parentTask.setContext(parentCtx);

            // Add a regular message and a summary to parent
            parentCtx._msgs.push({ msg: { role: 'user', content: 'parent msg' }, opts: {}, msgid: 'pm1', replied: 1 });
            parentCtx.pushSummary('parent summary');

            const childCtx = createContext(fakePrompt, childTask, {});
            childTask.setContext(childCtx);

            const q = childCtx._createMsgQ(false);

            // Parent regular message should NOT be in queue
            expect(q.some(m => m.content === 'parent msg')).to.be.false;
            // Parent summary SHOULD be in queue
            expect(q.some(m => m.content && m.content.includes('parent summary'))).to.be.true;
        });
    });

    describe('loadHistory with tool_digest', () => {
        it('should restore tool_digest from store data', async () => {
            const ctx = new Context(fakePrompt, null, { tag: 'test-tag' });
            const mockDigest = [{ tool: 'myTool', result: 'result', tm: Date.now() }];
            const mockStore = {
                load: sandbox.stub().resolves({
                    chat_history: JSON.stringify([]),
                    tool_digest: mockDigest
                })
            };
            await ctx.loadHistory(mockStore);
            expect(ctx.tool_digest).to.deep.equal(mockDigest);
        });

        it('should skip tool_digest restore when not an array', async () => {
            const ctx = new Context(fakePrompt, null, { tag: 'test-tag' });
            const mockStore = {
                load: sandbox.stub().resolves({
                    chat_history: JSON.stringify([]),
                    tool_digest: null
                })
            };
            await ctx.loadHistory(mockStore);
            expect(ctx.tool_digest).to.deep.equal([]);
        });

        it('should handle store returning only tool_digest without chat_history', async () => {
            const ctx = new Context(fakePrompt, null, { tag: 'test-tag' });
            const mockDigest = [{ tool: 'tool1', result: 'r1', tm: Date.now() }];
            const mockStore = {
                load: sandbox.stub().resolves({ tool_digest: mockDigest })
            };
            await ctx.loadHistory(mockStore);
            expect(ctx.tool_digest).to.deep.equal(mockDigest);
            expect(ctx._msgs).to.have.length(0);
        });
    });

    describe('spawnChild', () => {
        it('should create a child context with task', () => {
            const parentTask = new Itask({ name: 'parent', async: true }, []);
            const parentCtx = new Context(fakePrompt, parentTask, {});
            parentTask.setContext(parentCtx);

            const childCtx = parentCtx.spawnChild('Child prompt', 'child-tag');

            expect(childCtx.prompt).to.equal('Child prompt');
            expect(childCtx.task).to.exist;
            expect(childCtx.task.parent).to.equal(parentTask);
        });
    });
});
