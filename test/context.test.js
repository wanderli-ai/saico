'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const { Msgs, createMsgs } = require('../msgs.js');
const Itask = require('../itask.js');
const { Saico } = require('../saico.js');
const { Store } = require('../store.js');
const openai = require('../openai.js');
const util = require('../util.js');
const redis = require('../redis.js');

describe('Msgs', function () {
    let sandbox;
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
        Itask.root.clear();
        Store.instance = null;
        redis.rclient = undefined;
    });

    afterEach(() => {
        sandbox.restore();
        Itask.root.clear();
        Store.instance = null;
        redis.rclient = undefined;
    });

    describe('constructor', () => {
        it('should initialize with default values', () => {
            const ctx = new Msgs(fakePrompt, { token_limit: fakeTokenLimit });
            expect(ctx.prompt).to.equal(fakePrompt);
            expect(ctx.token_limit).to.equal(fakeTokenLimit);
            expect(ctx.lower_limit).to.equal(fakeTokenLimit * 0.85);
            expect(ctx.upper_limit).to.equal(fakeTokenLimit * 0.98);
            expect(ctx.length).to.equal(0);
        });

        it('should generate a tag if not provided', () => {
            const ctx = new Msgs(fakePrompt, {});
            expect(ctx.tag).to.be.a('string');
            expect(ctx.tag.length).to.be.greaterThan(0);
        });

        it('should have null callback hooks by default', () => {
            const ctx = new Msgs(fakePrompt, {});
            expect(ctx._findToolImpl).to.be.null;
            expect(ctx._getSnapshot).to.be.null;
        });
    });

    describe('messages getter/setter', () => {
        it('should set and get messages properly', () => {
            const ctx = createMsgs(fakePrompt, {});
            ctx.messages = [{ role: 'user', content: 'Hi' }];
            expect(ctx.messages).to.deep.equal([{ role: 'user', content: 'Hi' }]);
        });

        it('should throw if messages is not an array', () => {
            const ctx = createMsgs(fakePrompt, {});
            expect(() => {
                ctx.messages = 'invalid';
            }).to.throw('messages must be assigned an array');
        });
    });

    describe('push', () => {
        it('should push a message', () => {
            const ctx = createMsgs(fakePrompt, {});
            ctx.push({ role: 'user', content: 'Hello' });
            expect(ctx.length).to.equal(1);
            expect(ctx.messages[0]).to.deep.equal({ role: 'user', content: 'Hello' });
        });
    });

    describe('pushSummary', () => {
        it('should push a summary message', () => {
            const ctx = createMsgs(fakePrompt, {});
            ctx.pushSummary('summary text');
            const last = ctx._msgs[ctx._msgs.length - 1];
            expect(last.msg).to.deep.equal({ role: 'user', content: '[SUMMARY]: summary text' });
            expect(last.opts.summary).to.be.true;
        });
    });

    describe('array methods', () => {
        let ctx;

        beforeEach(() => {
            ctx = createMsgs(fakePrompt, {});
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
        it('should serialize the object', async () => {
            const ctx = createMsgs(fakePrompt, {});
            ctx.push({ role: 'user', content: 'Hi' });
            const json = await ctx.serialize();
            expect(json).to.be.a('string');
            const parsed = JSON.parse(json);
            expect(parsed).to.have.property('chat_history');
            expect(parsed).to.have.property('tool_digest');
        });
    });

    describe('sendMessage', () => {
        it('should send a message and receive a reply', async () => {
            const ctx = createMsgs(fakePrompt, {});
            ctx.pushSummary('summary 1');

            const reply = await ctx.sendMessage('user', 'Hello', null, {});

            expect(reply).to.have.property('content', 'AI response');

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs[0]).to.deep.equal({ role: 'system', content: fakePrompt });
        });

        it('should include own prompt in standalone mode', async () => {
            const ctx = createMsgs(fakePrompt, {});
            ctx.pushSummary('child summary');

            await ctx.sendMessage('user', 'Hi', null, {});

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs[0]).to.deep.equal({ role: 'system', content: fakePrompt });
            expect(sentArgs.some(m => m.content?.includes('child summary'))).to.be.true;
        });

        it('should use preamble when passed through opts', async () => {
            const ctx = createMsgs(fakePrompt, {});

            const preamble = [
                { role: 'system', content: 'Root prompt' },
                { role: 'system', content: 'Child prompt' },
            ];

            await ctx.sendMessage('user', 'Hi', null, {
                _preamble: preamble,
                _aggregatedFunctions: [{ name: 'test_func' }],
            });

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs[0]).to.deep.equal({ role: 'system', content: 'Root prompt' });
            expect(sentArgs[1]).to.deep.equal({ role: 'system', content: 'Child prompt' });

            const sentFuncs = openai.send.getCall(0).args[1];
            expect(sentFuncs).to.have.length(1);
            expect(sentFuncs[0].name).to.equal('test_func');
        });

        it('should skip if no content', async () => {
            const ctx = createMsgs(fakePrompt, {});
            const result = await ctx.sendMessage('user', '', null, {});
            expect(result).to.be.undefined;
        });
    });

    describe('tool calls', () => {
        let ctx;
        let mockSaico;

        beforeEach(() => {
            mockSaico = {
                name: 'test-saico',
                TOOL_test_tool: sandbox.stub().resolves({ content: 'tool result', functions: null }),
                TOOL_slow_tool: sandbox.stub().returns(new Promise(resolve => {
                    setTimeout(() => resolve({ content: 'slow result' }), 6000);
                })),
            };
            ctx = createMsgs(fakePrompt, {});
            ctx._findToolImpl = (toolName) => {
                const methodName = 'TOOL_' + toolName;
                if (typeof mockSaico[methodName] === 'function')
                    return { saico: mockSaico, methodName };
                return null;
            };
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

            expect(mockSaico.TOOL_test_tool.calledOnce).to.be.true;
            expect(mockSaico.TOOL_test_tool.firstCall.args[0]).to.deep.equal({ param: 'value' });
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
            const call = {
                id: 'call_123',
                function: { name: 'slow_tool', arguments: '{}' }
            };

            const result = await ctx._executeToolCallWithTimeout(call, 100);
            expect(result.content).to.include('timed out');
        });
    });

    describe('Proxy behavior', () => {
        let ctx;

        beforeEach(() => {
            ctx = createMsgs(fakePrompt, {});
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
        it('should summarize own messages', async () => {
            const ctx = createMsgs(fakePrompt, {});

            ctx._msgs.push({
                msg: { role: 'user', content: 'Hello' },
                opts: {},
                replied: 1
            });
            ctx._msgs.push({
                msg: { role: 'assistant', content: 'Hi there' },
                opts: {},
                replied: 3
            });

            await ctx.close();

            const summaries = ctx.getSummaries();
            expect(summaries.length).to.be.greaterThan(0);
        });
    });

    describe('chat_history', () => {
        it('should accept chat_history in config', () => {
            const ctx = new Msgs(fakePrompt, { chat_history: 'some-data' });
            expect(ctx._chat_history).to.equal('some-data');
        });

        it('should default chat_history to null', () => {
            const ctx = new Msgs(fakePrompt, {});
            expect(ctx._chat_history).to.be.null;
        });
    });

    describe('cleanToolCallsByTag', () => {
        it('should remove tool-related messages with matching tag', () => {
            const ctx = new Msgs(fakePrompt, {});
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
            const ctx = new Msgs(fakePrompt, {});

            ctx._msgs.push(
                { msg: { role: 'assistant', content: 'Tool call', tool_calls: [{ id: 'tc1' }] }, opts: { tag: 'other' }, msgid: '1', replied: 3 },
                { msg: { role: 'tool', content: 'result' }, opts: { tag: 'other' }, msgid: '2', replied: 1 }
            );

            ctx.cleanToolCallsByTag('test-tag');

            expect(ctx._msgs).to.have.length(2);
        });
    });

    describe('initHistory', () => {
        it('should decompress chat_history into _msgs', async () => {
            const compressed = await util.compressMessages([
                { role: 'user', content: 'Old message' },
                { role: 'assistant', content: 'Old reply' }
            ]);
            const ctx = new Msgs(fakePrompt, { chat_history: compressed });
            await ctx.initHistory();

            expect(ctx._msgs).to.have.length(2);
            expect(ctx._msgs[0].msg.content).to.equal('Old message');
            expect(ctx._msgs[1].msg.content).to.equal('Old reply');
            expect(ctx._msgs[0].replied).to.equal(1);
        });

        it('should accept plain JSON chat_history', async () => {
            const json = JSON.stringify([
                { role: 'user', content: 'Plain msg' }
            ]);
            const ctx = new Msgs(fakePrompt, { chat_history: json });
            await ctx.initHistory();

            expect(ctx._msgs).to.have.length(1);
            expect(ctx._msgs[0].msg.content).to.equal('Plain msg');
        });

        it('should no-op when no chat_history', async () => {
            const ctx = new Msgs(fakePrompt, {});
            await ctx.initHistory();
            expect(ctx._msgs).to.have.length(0);
        });

        it('should no-op when _msgs already populated', async () => {
            const compressed = await util.compressMessages([
                { role: 'user', content: 'Should not appear' }
            ]);
            const ctx = new Msgs(fakePrompt, {
                chat_history: compressed,
                msgs: [{ role: 'user', content: 'Existing msg' }],
            });
            await ctx.initHistory();

            expect(ctx._msgs).to.have.length(1);
            expect(ctx._msgs[0].msg.content).to.equal('Existing msg');
        });
    });

    describe('prepareForStorage', () => {
        it('should filter and compress messages', async () => {
            const ctx = new Msgs(fakePrompt, {});
            ctx._msgs.push(
                { msg: { role: 'user', content: 'Hello' }, opts: {}, msgid: '1', replied: 1 },
                { msg: { role: 'assistant', content: 'Hi', tool_calls: [{}] }, opts: {}, msgid: '2', replied: 3 },
                { msg: { role: 'tool', content: 'result' }, opts: {}, msgid: '3', replied: 1 },
                { msg: { role: 'user', content: '[BACKEND] instruction' }, opts: {}, msgid: '4', replied: 1 },
                { msg: { role: 'assistant', content: 'Reply' }, opts: {}, msgid: '5', replied: 3 },
            );

            const { chat_history, tool_digest } = await ctx.prepareForStorage();

            expect(chat_history).to.be.a('string');
            const restored = await util.decompressMessages(chat_history);
            expect(restored).to.have.length(2);
            expect(restored[0].content).to.equal('Hello');
            expect(restored[1].content).to.equal('Reply');
            expect(tool_digest).to.deep.equal([]);
        });

        it('should trim to QUEUE_LIMIT', async () => {
            const ctx = new Msgs(fakePrompt, { queue_limit: 3 });
            for (let i = 0; i < 10; i++) {
                ctx._msgs.push({
                    msg: { role: 'user', content: `msg${i}` },
                    opts: {}, msgid: `m${i}`, replied: 1,
                });
            }

            const { chat_history } = await ctx.prepareForStorage();
            const restored = await util.decompressMessages(chat_history);
            expect(restored).to.have.length(3);
            expect(restored[0].content).to.equal('msg7');
        });

        it('should return null chat_history when no messages', async () => {
            const ctx = new Msgs(fakePrompt, {});
            const { chat_history } = await ctx.prepareForStorage();
            expect(chat_history).to.be.null;
        });

        it('should include tool_digest', async () => {
            const ctx = new Msgs(fakePrompt, {});
            ctx.tool_digest = [{ tool: 'myTool', result: 'r', tm: 1 }];
            ctx._msgs.push({ msg: { role: 'user', content: 'x' }, opts: {}, msgid: '1', replied: 1 });

            const { tool_digest } = await ctx.prepareForStorage();
            expect(tool_digest).to.have.length(1);
            expect(tool_digest[0].tool).to.equal('myTool');
        });
    });

    describe('tool_digest', () => {
        it('should initialize tool_digest as empty array', () => {
            const ctx = new Msgs(fakePrompt, {});
            expect(ctx.tool_digest).to.deep.equal([]);
        });

        it('_appendToolDigest() should add an entry', () => {
            const ctx = new Msgs(fakePrompt, {});
            ctx._appendToolDigest('myTool', 'result content');
            expect(ctx.tool_digest).to.have.length(1);
            expect(ctx.tool_digest[0].tool).to.equal('myTool');
            expect(ctx.tool_digest[0].result).to.equal('result content');
            expect(ctx.tool_digest[0].tm).to.be.a('number');
        });

        it('_appendToolDigest() should truncate result to 500 chars', () => {
            const ctx = new Msgs(fakePrompt, {});
            const longResult = 'x'.repeat(600);
            ctx._appendToolDigest('myTool', longResult);
            expect(ctx.tool_digest[0].result.length).to.equal(500);
        });

        it('_appendToolDigest() should trim to TOOL_DIGEST_LIMIT (FIFO)', () => {
            const ctx = new Msgs(fakePrompt, { tool_digest_limit: 3 });
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
            const ctx = new Msgs(fakePrompt, {});
            const obj = { name: 'test', value: 42, _internal: 'skip' };
            const snap = ctx._snapshotPublicProps(obj);
            expect(snap).to.have.property('name', 'test');
            expect(snap).to.have.property('value', 42);
            expect(snap).to.not.have.property('_internal');
        });

        it('should skip functions', () => {
            const ctx = new Msgs(fakePrompt, {});
            const obj = { name: 'test', fn: () => {} };
            const snap = ctx._snapshotPublicProps(obj);
            expect(snap).to.not.have.property('fn');
        });

        it('should handle circular references without throwing', () => {
            const ctx = new Msgs(fakePrompt, {});
            const obj = { name: 'test' };
            obj.self = obj;
            expect(() => JSON.stringify(ctx._snapshotPublicProps(obj))).to.not.throw();
        });

        it('should recurse into objects even when serialize() is present', () => {
            const ctx = new Msgs(fakePrompt, {});
            const obj = { name: 'test', serialize: () => 'ignored' };
            const snap = ctx._snapshotPublicProps(obj);
            expect(snap).to.have.property('name', 'test');
            expect(snap).to.not.have.property('serialize'); // function — skipped
        });
    });

    describe('_getQueueSlice', () => {
        it('should return all messages when fewer than limit', () => {
            const ctx = new Msgs(fakePrompt, {});
            const msgs = [
                { role: 'user', content: 'a' },
                { role: 'assistant', content: 'b' }
            ];
            const result = ctx._getQueueSlice(msgs, 30);
            expect(result).to.deep.equal(msgs);
        });

        it('should return last limit messages when more exist', () => {
            const ctx = new Msgs(fakePrompt, { min_chat_messages: 0 });
            const msgs = Array.from({ length: 10 }, (_, i) =>
                ({ role: 'user', content: `msg ${i}` })
            );
            const result = ctx._getQueueSlice(msgs, 5);
            expect(result).to.have.length(5);
            expect(result[0].content).to.equal('msg 5');
        });

        it('should not orphan a tool response at start of slice', () => {
            const ctx = new Msgs(fakePrompt, { min_chat_messages: 0 });
            const msgs = [];
            msgs.push({ role: 'assistant', content: 'calling', tool_calls: [{ id: 'tc1' }] });
            msgs.push({ role: 'tool', content: 'result', tool_call_id: 'tc1' });
            for (let i = 0; i < 30; i++)
                msgs.push({ role: 'user', content: `u${i}` });
            const result = ctx._getQueueSlice(msgs, 30);
            expect(result[0].role).to.not.equal('tool');
        });

        it('should expand window to guarantee MIN_CHAT_MESSAGES', () => {
            const ctx = new Msgs(fakePrompt, { queue_limit: 30, min_chat_messages: 10 });
            const msgs2 = [];
            for (let i = 0; i < 28; i++)
                msgs2.push({ role: 'tool', content: `tool ${i}`, tool_call_id: `tc${i}` });
            for (let i = 0; i < 2; i++) {
                msgs2.push({ role: 'user', content: `user ${i}` });
                msgs2.push({ role: 'assistant', content: `assistant ${i}` });
            }
            const result = ctx._getQueueSlice(msgs2, 30);
            const chatCount = result.filter(m => m.role === 'user' || m.role === 'assistant').length;
            expect(chatCount).to.be.at.least(4);
        });
    });

    describe('_createMsgQ layered structure', () => {
        it('should have system prompt as first element (standalone fallback)', () => {
            const ctx = createMsgs(fakePrompt, {});
            ctx._msgs.push({ msg: { role: 'user', content: 'Hello' }, opts: {}, msgid: '1', replied: 1 });
            const q = ctx._createMsgQ(null, false);
            expect(q[0]).to.deep.equal({ role: 'system', content: fakePrompt });
        });

        it('should include tool digest in standalone fallback', () => {
            const ctx = createMsgs(fakePrompt, {});
            ctx._appendToolDigest('myTool', 'some result');
            const q = ctx._createMsgQ(null, false);
            const digestMsg = q.find(m => m.role === 'system' && m.content.includes('[Tool Activity Log]'));
            expect(digestMsg).to.exist;
            expect(digestMsg.content).to.include('myTool');
            expect(digestMsg.content).to.include('some result');
        });

        it('should not include tool digest when empty (standalone fallback)', () => {
            const ctx = createMsgs(fakePrompt, {});
            const q = ctx._createMsgQ(null, false);
            const digestMsg = q.find(m => m.role === 'system' && m.content?.includes('[Tool Activity Log]'));
            expect(digestMsg).to.not.exist;
        });

        it('should use preamble when provided (Saico orchestration)', () => {
            const ctx = createMsgs(fakePrompt, {});
            ctx._msgs.push({ msg: { role: 'user', content: 'Hello' }, opts: {}, msgid: '1', replied: 1 });

            const preamble = [
                { role: 'system', content: 'Root prompt' },
                { role: 'system', content: '[State Summary]\nRoot state' },
                { role: 'system', content: 'Child prompt' },
            ];

            const q = ctx._createMsgQ(preamble, false);

            expect(q[0]).to.deep.equal({ role: 'system', content: 'Root prompt' });
            expect(q[1]).to.deep.equal({ role: 'system', content: '[State Summary]\nRoot state' });
            expect(q[2]).to.deep.equal({ role: 'system', content: 'Child prompt' });
            expect(q[3]).to.deep.equal({ role: 'user', content: 'Hello' });
        });

        it('should NOT include own prompt/digest when preamble is provided', () => {
            const ctx = createMsgs(fakePrompt, {});
            ctx._appendToolDigest('myTool', 'some result');

            const preamble = [{ role: 'system', content: 'Saico prompt' }];
            const q = ctx._createMsgQ(preamble, false);

            expect(q.filter(m => m.content === fakePrompt)).to.have.length(0);
            const digestFromStandalone = q.filter(m =>
                m.role === 'system' && m.content?.includes('[Tool Activity Log]'));
            expect(digestFromStandalone).to.have.length(0);
        });

        it('should limit queue to QUEUE_LIMIT own messages', () => {
            const ctx = createMsgs(fakePrompt, { queue_limit: 5, min_chat_messages: 0 });
            for (let i = 0; i < 10; i++) {
                ctx._msgs.push({
                    msg: { role: 'user', content: `msg ${i}` },
                    opts: {},
                    msgid: `m${i}`,
                    replied: 1
                });
            }
            const q = ctx._createMsgQ(null, false);
            const userMsgs = q.filter(m => m.role === 'user');
            expect(userMsgs).to.have.length(5);
            expect(userMsgs[0].content).to.equal('msg 5');
        });

        it('QUEUE_LIMIT should not count preamble messages', () => {
            const ctx = createMsgs(fakePrompt, { queue_limit: 5, min_chat_messages: 0 });
            for (let i = 0; i < 10; i++) {
                ctx._msgs.push({
                    msg: { role: 'user', content: `msg ${i}` },
                    opts: {},
                    msgid: `m${i}`,
                    replied: 1
                });
            }
            const preamble = [
                { role: 'system', content: 'Prompt 1' },
                { role: 'system', content: 'Prompt 2' },
                { role: 'system', content: 'Prompt 3' },
            ];
            const q = ctx._createMsgQ(preamble, false);

            expect(q).to.have.length(8);
            const userMsgs = q.filter(m => m.role === 'user');
            expect(userMsgs).to.have.length(5);
        });
    });

    describe('constructor with tool_digest', () => {
        it('should accept tool_digest in config', () => {
            const digest = [{ tool: 'myTool', result: 'result', tm: Date.now() }];
            const ctx = new Msgs(fakePrompt, { tool_digest: digest });
            expect(ctx.tool_digest).to.deep.equal(digest);
        });

        it('should default tool_digest to empty array', () => {
            const ctx = new Msgs(fakePrompt, {});
            expect(ctx.tool_digest).to.deep.equal([]);
        });
    });

});
