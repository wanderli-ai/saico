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
        messages = saico.createQ(fakePrompt, {tag: 'test', token_limit: fakeTokenLimit});
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
            const parent = saico.createQ('Parent prompt', {tag: 'parent'});
            parent.pushSummary('parent summary');
            parent.spawnChild(fakePrompt, {tag: 'child'});

            parent.child.pushSummary('child summary');
            const context = parent.child.getMsgContext();

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
            sinon.assert.calledWith(spy, true);
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
            const parent = saico.createQ('Parent prompt', {tag: 'parent'});
            parent.pushSummary('parent summary');
            messages = saico.createQ(fakePrompt, {tag: 'child'}, null, parent);

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

    describe('_sendMessageInternal', () => {
        it('should call openai.send with full context including parent and summaries', async () => {
            const parent = saico.createQ('Parent prompt', {tag: 'parent'});
            parent.pushSummary('parent summary');
            messages = parent.spawnChild(fakePrompt, {tag: 'child'});
            messages.pushSummary('child summary');

            const o = {
                msg: { role: 'user', content: 'Hi' },
                opts: {},
                functions: null,
                msgid: 'abcd',
                replied: 0
            };

            const reply = await messages._sendMessageInternal(o);
            expect(reply).to.have.property('content', 'summary content');

            const sentArgs = openai.send.getCall(0).args[0];
            expect(sentArgs).to.deep.include.members([
                { role: 'system', content: 'Parent prompt' },
                { role: 'user', content: '[SUMMARY]: parent summary' },
                { role: 'system', content: fakePrompt },
                { role: 'user', content: '[SUMMARY]: child summary' }
            ]);
        });

        it('should remove function_call if nofunc is set', async () => {
            openai.send.resolves({ content: 'reply', function_call: { name: 'test' } });

            const o = {
                msg: { role: 'user', content: 'Hi' },
                opts: { nofunc: true },
                functions: null,
                msgid: 'abcd',
                replied: 0
            };

            const reply = await messages._sendMessageInternal(o);
            expect(reply.function_call).to.be.undefined;
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
});
