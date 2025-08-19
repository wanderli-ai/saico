const chai = require('chai');
const sinon = require('sinon');
const crypto = require('crypto');
const openai = require('./openai.js');
const saico = require('./saico.js');
const util = require('./util.js');

const expect = chai.expect;

describe('Messages', function () {
    let sandbox;
    let messages;
    let fakePrompt = 'You are a helpful assistant.';
    let fakeTokenLimit = 1000;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        if (process.env.PROD)
			sandbox.stub(console, 'log');
        sandbox.stub(util, 'countTokens').callsFake((msgs) => {
            if (Array.isArray(msgs)) return msgs.length * 10;
            return 10;
        });
        sandbox.stub(openai, 'send').resolves({ content: 'summary content' });
        sandbox.stub(crypto, 'randomBytes').returns(Buffer.from('abcd', 'hex'));
        messages = saico.createQ(fakePrompt, null, 'test', fakeTokenLimit);
    });

    afterEach(() => {
        sandbox.restore();
    });

    describe('constructor', () => {
        it('should initialize with default values', () => {
            expect(messages.prompt).to.equal(fakePrompt);
            expect(messages.token_limit).to.equal(fakeTokenLimit);
            expect(messages.lower_limit).to.equal(fakeTokenLimit * 0.85);
            expect(messages.upper_limit).to.equal(fakeTokenLimit * 0.98);
            expect(messages.length).to.equal(0);
            });
        });

    describe('messages getter/setter', () => {
        it('should set and get messages properly', () => {
            messages.messages = [{ role: 'user', content: 'Hi' }];
            expect(messages.messages).to.deep.equal([{ role: 'user', content: 'Hi' }]);
            });

        it('should throw if messages is not an array', () => {
            expect(() => {
                messages.messages = 'invalid';
                }).to.throw('messages must be assigned an array');
            });
        });

    describe('push', () => {
        it('should push a message', () => {
            messages.push({ role: 'user', content: 'Hello' });
            expect(messages.length).to.equal(1);
            expect(messages.messages[0]).to.deep.equal({ role: 'user', content: 'Hello' });
            });
        });

    describe('pushSummary', () => {
        it('should push a summary message', () => {
            messages.pushSummary('summary text');
            const last = messages._msgs[messages._msgs.length - 1];
            expect(last.msg).to.deep.equal({ role: 'user', content: '[SUMMARY]: summary text' });
            expect(last.opts.summary).to.be.true;
            });
        });

    describe('toJSON', () => {
        it('should return messages', () => {
            messages.push({ role: 'user', content: 'Hello' });
            expect(messages.toJSON()).to.deep.equal([{ role: 'user', content: 'Hello' }]);
            });
        });

    describe('filter, concat, slice, reverse', () => {
        beforeEach(() => {
            messages.messages = [
            { role: 'user', content: 'A' },
            { role: 'assistant', content: 'B' },
            { role: 'user', content: 'C' }
            ];
        });

        it('should filter messages', () => {
            const filtered = messages.filter(m => m.role === 'user');
            expect(filtered.length).to.equal(2);
        });

        it('should concat messages', () => {
            const newMsgs = [{ role: 'system', content: 'Z' }];
            const result = messages.concat(newMsgs);
            expect(result.length).to.equal(4);
        });

        it('should slice messages', () => {
            const sliced = messages.slice(0, 2);
            expect(sliced.length).to.equal(2);
        });

        it('should reverse messages', () => {
            messages.reverse();
            expect(messages.messages[0].content).to.equal('C');
        });
    });

    describe('iterator', () => {
        it('should iterate over messages', () => {
            messages.messages = [
            { role: 'user', content: 'A' },
            { role: 'assistant', content: 'B' }
            ];
            const result = [...messages];
            expect(result.length).to.equal(2);
            expect(result[0].content).to.equal('A');
            });
        });

    describe('serialize', () => {
        it('should serialize the object', () => {
            messages.push({ role: 'user', content: 'Hi' });
            const json = messages.serialize();
            expect(json).to.be.a('string');
            expect(JSON.parse(json)).to.not.have.property('prompt');
            });
        });

    describe('getSummaries', () => {
        it('should return summary messages', () => {
            messages.push({ role: 'user', content: 'Hi' });
            messages.pushSummary('summary');
            const summaries = messages.getSummaries();
            expect(summaries.length).to.equal(1);
            });
        });

    describe('getMsgContext', () => {
        it('should return prompt and summaries if no parent', () => {
            messages.pushSummary('summary text');
            const context = messages.getMsgContext();
            expect(context[0]).to.deep.equal({ role: 'system', content: fakePrompt });
            expect(context[1]).to.deep.equal({ role: 'user', content: '[SUMMARY]: summary text' });
            });

        it('should include parent context if parent exists', () => {
            const parent = saico.createQ('Parent prompt', null, 'parent');
            parent.pushSummary('parent summary');
            const child = parent.spawnChild(fakePrompt, 'child');

            child.pushSummary('child summary');
            const context = child.getMsgContext();

            expect(context).to.deep.equal([
                { role: 'system', content: 'Parent prompt' },
                { role: 'user', content: '[SUMMARY]: parent summary' },
                { role: 'system', content: fakePrompt },
                { role: 'user', content: '[SUMMARY]: child summary' }
            ]);
        });
    });

    describe('summarizeMessages', () => {
        it('should skip if token count is low', async () => {
            const spy = sandbox.spy(messages, '_summarizeContext');
            util.countTokens.returns(1);
            await messages.summarizeMessages();
            sinon.assert.notCalled(spy);
        });

        it('should call _summarizeContext if token count is high', async () => {
            util.countTokens.returns(1000);
            const spy = sandbox.spy(messages, '_summarizeContext');
            await messages.summarizeMessages();
            sinon.assert.calledOnce(spy);
        });
    });

    describe('close', () => {
        it('should call _summarizeContext with true', async () => {
            const spy = sandbox.spy(messages, '_summarizeContext');
            await messages.close();
            // Use setTimeout to allow setImmediate to execute
            await new Promise(resolve => setTimeout(resolve, 10));
            sinon.assert.calledWith(spy, true, null);
        });
    });

    describe('sendMessage', () => {
        it('should send a message and receive a reply with correct context', async () => {
            messages.pushSummary('summary 1');
            const reply = await messages.sendMessage('user', 'Hello', null, {});

            expect(reply).to.have.property('content', 'summary content');

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs[0]).to.deep.equal({ role: 'system', content: fakePrompt });
            expect(sentArgs.some(m => m.content === '[SUMMARY]: summary 1')).to.be.true;
            });

        it('should include parent context in openai.send', async () => {
            const parent = saico.createQ('Parent prompt', null, 'parent');
            parent.pushSummary('parent summary');
            messages = saico.createQ(fakePrompt, parent, 'child');

            messages.pushSummary('child summary');
            await messages.sendMessage('user', 'Hi', null, {});

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs).to.deep.include.members([
                { role: 'system', content: 'Parent prompt' },
                { role: 'user', content: '[SUMMARY]: parent summary' },
                { role: 'system', content: fakePrompt },
                { role: 'user', content: '[SUMMARY]: child summary' }
            ]);
        });

        it('should skip if no content', async () => {
            const spy = sandbox.spy(console, 'error');
            await messages.sendMessage('user', '', null, {});
            sinon.assert.called(spy);
        });
    });

    describe('_processSendMessage', () => {
        it('should call openai.send with full context including parent and summaries', async () => {
            const parent = saico.createQ('Parent prompt', null, 'parent');
            parent.pushSummary('parent summary');
            messages = parent.spawnChild(fakePrompt, 'child');
            messages.pushSummary('child summary');

            const o = {
                msg: { role: 'user', content: 'Hi' },
                opts: {},
                functions: null,
                msgid: 'abcd',
                replied: 0
            };

            const reply = await messages._processSendMessage(o, 1);
            expect(reply).to.have.property('content', 'summary content');

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs).to.deep.include.members([
                { role: 'system', content: 'Parent prompt' },
                { role: 'user', content: '[SUMMARY]: parent summary' },
                { role: 'system', content: fakePrompt },
                { role: 'user', content: '[SUMMARY]: child summary' }
            ]);
        });

        it('should remove tool_calls if nofunc is set', async () => {
            openai.send.resolves({ content: 'reply', tool_calls: [{ id: 'test', function: { name: 'test', arguments: '{}' } }] });

            const o = {
                msg: { role: 'user', content: 'Hi' },
                opts: { nofunc: true },
                functions: null,
                msgid: 'abcd',
                replied: 0
            };

            const reply = await messages._processSendMessage(o, 1);
            expect(reply.tool_calls).to.be.undefined;
        });
    });

    describe('Proxy behavior', () => {
        it('should access message by index', () => {
            messages.push({ role: 'user', content: 'Hello' });
            expect(messages[0]).to.deep.equal({ role: 'user', content: 'Hello' });
        });

        it('should set message by index', () => {
            messages[0] = { role: 'assistant', content: 'Hi' };
            expect(messages[0]).to.deep.equal({ role: 'assistant', content: 'Hi' });
        });

        it('should expose length', () => {
            messages.push({ role: 'user', content: 'Hello' });
            expect(messages.length).to.equal(1);
        });

        it('should allow Object.keys to include message indexes', () => {
            messages.push({ role: 'user', content: 'Hello' });
            const keys = Object.keys(messages);
            expect(keys).to.include('0');
        });
    });

    describe('Tool Calls Functionality', () => {
        let mockToolHandler;
        
        beforeEach(() => {
            mockToolHandler = sandbox.stub().resolves('tool result');
            messages = saico.createQ(fakePrompt, null, 'test', fakeTokenLimit, null, mockToolHandler);
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
            
            const reply = await messages.sendMessage('user', 'Test message', null, {});
            
            expect(mockToolHandler.calledOnce).to.be.true;
            expect(mockToolHandler.firstCall.args[0]).to.equal('test_tool');
            expect(reply.content).to.include('I will help you');
        });
        
        it('should track tool call sequences and prevent excessive repetition', () => {
            messages._trackToolCall('test_tool');
            messages._trackToolCall('test_tool');
            messages._trackToolCall('test_tool');
            
            expect(messages._tool_call_sequence).to.deep.equal(['test_tool', 'test_tool', 'test_tool']);
            
            // Fill up to max repetition
            for (let i = 0; i < messages.max_tool_repetition - 3; i++) {
                messages._trackToolCall('test_tool');
            }
            
            expect(messages._shouldDropToolCall('test_tool')).to.be.true;
        });
        
        it('should reset tool sequence for different tools', () => {
            messages._trackToolCall('tool_a');
            messages._trackToolCall('tool_a');
            
            messages._resetToolSequenceIfDifferent(['tool_b']);
            
            expect(messages._tool_call_sequence).to.deep.equal([]);
        });
        
        it('should filter excessive tool calls', () => {
            // Fill up tool call sequence to max
            for (let i = 0; i < messages.max_tool_repetition; i++) {
                messages._trackToolCall('test_tool');
            }
            
            const toolCalls = [{
                id: 'call_123',
                function: { name: 'test_tool', arguments: '{}' }
            }];
            
            const filtered = messages._filterExcessiveToolCalls(toolCalls);
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
            
            messages._trackActiveToolCall(call1);
            
            expect(messages._isDuplicateToolCall(call2)).to.be.true;
            expect(messages._isDuplicateToolCall({ 
                id: 'call_3',
                function: { name: 'test_tool', arguments: '{"param": "different"}' }
            })).to.be.false;
        });
        
        it('should defer tool calls when max depth is reached', async () => {
            messages.max_depth = 2;
            
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
            
            const o = messages._createMsgObj('user', 'Test', null, {});
            await messages._processSendMessage(o, 3); // Depth > max_depth
            
            expect(messages._deferred_tool_calls).to.have.length(1);
            expect(messages._deferred_tool_calls[0].call.id).to.equal('call_123');
        });
        
        it('should handle pending tool calls and queue messages', async () => {
            // Create a message with tool calls but don't provide tool responses
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
            
            messages._msgs.push(toolCallMsg);
            
            expect(messages._hasPendingToolCalls()).to.be.true;
            
            const result = await messages.sendMessage('user', 'Another message', null, {});
            expect(result.queued).to.be.true;
            expect(messages._waitingQueue).to.have.length(1);
        });
        
        it('should process waiting queue when tool calls complete', () => {
            messages._waitingQueue.push(
                { role: 'user', content: 'Message 1', functions: null, opts: {} },
                { role: 'user', content: 'Message 2', functions: null, opts: {} }
            );
            
            const originalLength = messages._msgs.length;
            messages._processWaitingQueue();
            
            expect(messages._waitingQueue).to.have.length(0);
            expect(messages._msgs.length).to.equal(originalLength + 2);
        });
        
        it('should handle tool call timeouts', async () => {
            const slowHandler = sandbox.stub().returns(new Promise(resolve => {
                setTimeout(() => resolve('slow result'), 6000); // 6 seconds, longer than default timeout
            }));
            
            const call = {
                id: 'call_123',
                function: { name: 'slow_tool', arguments: '{}' }
            };
            
            const result = await messages._executeToolCallWithTimeout(call, slowHandler, 1000);
            expect(result).to.include('timed out');
        });
        
        it('should move unresponded tool calls from parent to child', () => {
            const parent = saico.createQ('Parent', null, 'parent');
            
            // Add a tool call message to parent without response
            parent._msgs.push({
                msg: {
                    role: 'assistant',
                    content: 'Calling tool',
                    tool_calls: [{ id: 'call_123', function: { name: 'test', arguments: '{}' } }]
                },
                msgid: 'parent_msg',
                opts: {},
                replied: 3
            });
            
            const child = parent.spawnChild('Child', 'child');
            
            // Tool call should be moved to child
            expect(child._msgs).to.have.length(1);
            expect(child._msgs[0].msg.tool_calls).to.exist;
            expect(parent._msgs).to.have.length(0); // Should be moved out of parent
        });
    });
});
