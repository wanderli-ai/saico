'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const { Saico } = require('../saico.js');
const { DynamoDBAdapter } = require('../dynamo.js');
const Itask = require('../itask.js');
const { Store } = require('../store.js');
const openai = require('../openai.js');
const util = require('../util.js');
const redis = require('../redis.js');
const { marshall } = require('@aws-sdk/util-dynamodb');

describe('Storage Integration', function () {
    let sandbox;
    let mockClient;

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

        // Create mock DynamoDB client
        mockClient = { send: sandbox.stub() };
        Saico._backend = null;
    });

    afterEach(() => {
        sandbox.restore();
        Itask.root.clear();
        Store.instance = null;
        Saico._backend = null;
        redis.rclient = undefined;
    });

    describe('registerBackend with DynamoDB', () => {
        it('should create a DynamoDBAdapter and set it as backend', () => {
            Saico.registerBackend('dynamodb', { client: mockClient });
            const backend = Saico.getBackend();
            expect(backend).to.be.instanceOf(DynamoDBAdapter);
            expect(backend._client).to.equal(mockClient);
        });

        it('should throw for unknown backend type', () => {
            expect(() => Saico.registerBackend('postgres', {})).to.throw('Unknown backend');
        });
    });

    describe('closeSession saves to DynamoDB', () => {
        it('should put marshalled data to the correct table', async () => {
            Saico.registerBackend('dynamodb', { client: mockClient });
            mockClient.send.resolves({});

            const session = new Saico({
                id: 'sess-123',
                name: 'test-session',
                prompt: 'Be helpful',
                store: 'sessions',
            });
            session.activate({ createQ: true });
            session.msgs.push({ role: 'user', content: 'Hello' });
            session.msgs.push({ role: 'assistant', content: 'Hi!' });

            await session.closeSession();

            expect(mockClient.send.calledOnce).to.be.true;
            const cmd = mockClient.send.firstCall.args[0];
            expect(cmd.input.TableName).to.equal('sessions');
            expect(cmd.input.Item).to.be.an('object');
            // Item is marshalled — verify id is present
            expect(cmd.input.Item.id).to.deep.equal({ S: 'sess-123' });
            expect(cmd.input.Item.name).to.deep.equal({ S: 'test-session' });
            // msgs should be a Map with chat_history
            expect(cmd.input.Item.msgs).to.be.an('object');
        });

        it('should not save when storeName is not set', async () => {
            Saico.registerBackend('dynamodb', { client: mockClient });
            mockClient.send.resolves({});

            const session = new Saico({ id: 'no-store', name: 'test' });
            session.activate({ createQ: true });
            await session.closeSession();

            expect(mockClient.send.called).to.be.false;
        });

        it('should not save when no backend registered', async () => {
            const session = new Saico({ id: 'no-backend', name: 'test', store: 'my-table' });
            session.activate({ createQ: true });
            await session.closeSession();
            // No error thrown, just silently skips
        });
    });

    describe('rehydrate restores from DynamoDB', () => {
        it('should get by id and restore full Saico instance', async () => {
            Saico.registerBackend('dynamodb', { client: mockClient });

            // Create and prepare test data
            const original = new Saico({
                id: 'rh-456',
                name: 'rehydrate-test',
                prompt: 'Test prompt',
                userData: { role: 'admin' },
            });
            original.activate({ createQ: true });
            original.msgs.push({ role: 'user', content: 'Question' });
            original.msgs.push({ role: 'assistant', content: 'Answer' });

            const prepared = await original.prepareForStorage();

            // Stub get to return marshalled data
            mockClient.send.resolves({
                Item: marshall(prepared, { removeUndefinedValues: true, convertClassInstanceToMap: true }),
            });

            const restored = await Saico.rehydrate('rh-456', { store: 'sessions' });

            expect(restored).to.be.instanceOf(Saico);
            expect(restored.id).to.equal('rh-456');
            expect(restored.name).to.equal('rehydrate-test');
            expect(restored.prompt).to.equal('Test prompt');
            expect(restored.userData).to.deep.equal({ role: 'admin' });
            expect(restored.isActive).to.be.true;
            expect(restored.msgs._msgs).to.have.length(2);
            expect(restored.msgs._msgs[0].msg.content).to.equal('Question');
            expect(restored.msgs._msgs[1].msg.content).to.equal('Answer');

            // Verify the correct DynamoDB call was made
            const cmd = mockClient.send.firstCall.args[0];
            expect(cmd.input.TableName).to.equal('sessions');
            expect(cmd.input.Key).to.deep.equal({ id: { S: 'rh-456' } });
        });

        it('should return null when item not found', async () => {
            Saico.registerBackend('dynamodb', { client: mockClient });
            mockClient.send.resolves({ Item: undefined });

            const result = await Saico.rehydrate('missing', { store: 'sessions' });
            expect(result).to.be.null;
        });
    });

    describe('full round-trip: create → messages → close → rehydrate', () => {
        it('should preserve state through DynamoDB save and restore', async () => {
            Saico.registerBackend('dynamodb', { client: mockClient });

            // Capture what gets saved
            let savedItem = null;
            mockClient.send.callsFake((cmd) => {
                if (cmd.input.Item) {
                    // PutItemCommand — capture the marshalled item
                    savedItem = cmd.input.Item;
                    return {};
                }
                if (cmd.input.Key) {
                    // GetItemCommand — return what was saved
                    return { Item: savedItem };
                }
                return {};
            });

            // Create session with messages
            const session = new Saico({
                id: 'round-trip-id',
                name: 'round-trip',
                prompt: 'System prompt',
                userData: { userId: '42' },
                store: 'sessions',
            });
            session.activate({ createQ: true });

            // Send messages
            await session.sendMessage('Backend instruction');
            await session.recvChatMessage('User question');

            // Close — saves to DynamoDB
            await session.closeSession();

            expect(savedItem).to.not.be.null;

            // Rehydrate — reads from DynamoDB
            const restored = await Saico.rehydrate('round-trip-id', { store: 'sessions' });

            expect(restored.id).to.equal('round-trip-id');
            expect(restored.name).to.equal('round-trip');
            expect(restored.prompt).to.equal('System prompt');
            expect(restored.userData).to.deep.equal({ userId: '42' });
            expect(restored.msgs).to.exist;

            // User messages survive, backend messages filtered
            const userMsg = restored.msgs._msgs.find(m =>
                m.msg.content === 'User question');
            expect(userMsg).to.exist;

            const backendMsg = restored.msgs._msgs.find(m =>
                m.msg.content && m.msg.content.includes('[BACKEND]'));
            expect(backendMsg).to.not.exist;
        });
    });

    describe('db* API through registered backend', () => {
        it('should use registered backend for dbPutItem', async () => {
            Saico.registerBackend('dynamodb', { client: mockClient });
            mockClient.send.resolves({});

            const s = new Saico({ name: 'db-test' });
            await s.dbPutItem({ id: 'item-1', name: 'Test' }, 'items');

            expect(mockClient.send.calledOnce).to.be.true;
            const cmd = mockClient.send.firstCall.args[0];
            expect(cmd.input.TableName).to.equal('items');
        });

        it('should use registered backend for dbGetItem', async () => {
            Saico.registerBackend('dynamodb', { client: mockClient });
            mockClient.send.resolves({
                Item: { id: { S: 'item-1' }, name: { S: 'Test' } },
            });

            const s = new Saico({ name: 'db-test' });
            const item = await s.dbGetItem('id', 'item-1', 'items');

            expect(item).to.deep.equal({ id: 'item-1', name: 'Test' });
        });

        it('should use registered backend for dbDeleteItem', async () => {
            Saico.registerBackend('dynamodb', { client: mockClient });
            mockClient.send.resolves({});

            const s = new Saico({ name: 'db-test' });
            await s.dbDeleteItem('id', 'item-1', 'items');

            expect(mockClient.send.calledOnce).to.be.true;
        });

        it('should use registered backend for dbQuery', async () => {
            Saico.registerBackend('dynamodb', { client: mockClient });
            mockClient.send.resolves({
                Items: [
                    { id: { S: '1' }, email: { S: 'a@b.com' } },
                    { id: { S: '2' }, email: { S: 'a@b.com' } },
                ],
            });

            const s = new Saico({ name: 'db-test' });
            const items = await s.dbQuery('email-index', 'email', 'a@b.com', 'items');

            expect(items).to.have.length(2);
            expect(items[0].email).to.equal('a@b.com');
        });

        it('should prefer local db over registered backend', async () => {
            Saico.registerBackend('dynamodb', { client: mockClient });
            const localDb = { get: sandbox.stub().resolves({ id: '1', source: 'local' }) };

            const s = new Saico({ name: 'db-test', db: localDb });
            const item = await s.dbGetItem('id', '1', 'items');

            expect(item.source).to.equal('local');
            expect(mockClient.send.called).to.be.false;
        });
    });

    describe('_getDb fallback to registered backend', () => {
        it('should find registered backend when no local or parent db', () => {
            Saico.registerBackend('dynamodb', { client: mockClient });

            const s = new Saico({ name: 'test' });
            const db = s._getDb();
            expect(db).to.be.instanceOf(DynamoDBAdapter);
        });

        it('should throw when nothing available', () => {
            const s = new Saico({ name: 'test' });
            expect(() => s._getDb()).to.throw('No DB backend');
        });
    });
});
