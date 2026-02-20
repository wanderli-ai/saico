'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const { Store, DynamoBackend } = require('../store.js');
const util = require('../util.js');

describe('Store', function () {
    let sandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
        if (process.env.PROD)
            sandbox.stub(console, 'log');
        // Reset singleton
        Store.instance = null;
    });

    afterEach(() => {
        sandbox.restore();
        Store.instance = null;
    });

    describe('constructor', () => {
        it('should create a store with default config', () => {
            const store = new Store();
            expect(store._redis).to.be.null;
            expect(store._backends).to.deep.equal({});
        });

        it('should configure DynamoDB backend when provided', () => {
            const mockAws = { dynamoPutItem: sinon.stub(), dynamoGetItem: sinon.stub(), dynamoDeleteItem: sinon.stub() };
            const store = new Store({ dynamodb: { table: 'test-table', aws: mockAws } });
            expect(store._backends.dynamodb).to.be.instanceOf(DynamoBackend);
        });
    });

    describe('singleton', () => {
        it('should initialize singleton via Store.init', () => {
            const store = Store.init();
            expect(Store.instance).to.equal(store);
        });

        it('should return singleton via Store.instance', () => {
            Store.init();
            expect(Store.instance).to.be.instanceOf(Store);
        });
    });

    describe('generateId', () => {
        it('should generate a hex string of 16 chars', () => {
            const store = new Store();
            const id = store.generateId();
            expect(id).to.be.a('string');
            expect(id).to.have.length(16);
            expect(/^[0-9a-f]+$/.test(id)).to.be.true;
        });

        it('should generate unique IDs', () => {
            const store = new Store();
            const ids = new Set(Array.from({ length: 100 }, () => store.generateId()));
            expect(ids.size).to.equal(100);
        });
    });

    describe('save', () => {
        it('should save to Redis when available', async () => {
            const store = new Store();
            const mockRedis = { set: sinon.stub().resolves(), get: sinon.stub(), del: sinon.stub() };
            store.setRedis(mockRedis);

            await store.save('test-id', { foo: 'bar' });

            expect(mockRedis.set.calledOnce).to.be.true;
            expect(mockRedis.set.firstCall.args[0]).to.equal('saico:test-id');
            expect(JSON.parse(mockRedis.set.firstCall.args[1])).to.deep.equal({ foo: 'bar' });
        });

        it('should save to backends when configured', async () => {
            const mockBackend = { save: sinon.stub().resolves(), load: sinon.stub(), delete: sinon.stub() };
            const store = new Store();
            store.addBackend('test', mockBackend);

            await store.save('test-id', { foo: 'bar' });

            expect(mockBackend.save.calledOnce).to.be.true;
            expect(mockBackend.save.firstCall.args[0]).to.equal('test-id');
        });

        it('should save to both Redis and backends', async () => {
            const mockRedis = { set: sinon.stub().resolves(), get: sinon.stub(), del: sinon.stub() };
            const mockBackend = { save: sinon.stub().resolves(), load: sinon.stub(), delete: sinon.stub() };

            const store = new Store();
            store.setRedis(mockRedis);
            store.addBackend('test', mockBackend);

            await store.save('test-id', { data: 'value' });

            expect(mockRedis.set.calledOnce).to.be.true;
            expect(mockBackend.save.calledOnce).to.be.true;
        });

        it('should handle Redis save errors gracefully', async () => {
            const mockRedis = { set: sinon.stub().rejects(new Error('Redis down')), get: sinon.stub(), del: sinon.stub() };
            const store = new Store();
            store.setRedis(mockRedis);

            // Should not throw
            await store.save('test-id', { data: 'value' });
        });
    });

    describe('load', () => {
        it('should load from Redis first', async () => {
            const mockRedis = {
                set: sinon.stub().resolves(),
                get: sinon.stub().resolves(JSON.stringify({ foo: 'bar' })),
                del: sinon.stub()
            };

            const store = new Store();
            store.setRedis(mockRedis);

            const result = await store.load('test-id');
            expect(result).to.deep.equal({ foo: 'bar' });
            expect(mockRedis.get.firstCall.args[0]).to.equal('saico:test-id');
        });

        it('should fall back to backend on Redis miss', async () => {
            const mockRedis = {
                set: sinon.stub().resolves(),
                get: sinon.stub().resolves(null),
                del: sinon.stub()
            };
            const mockBackend = {
                save: sinon.stub().resolves(),
                load: sinon.stub().resolves({ from: 'backend' }),
                delete: sinon.stub()
            };

            const store = new Store();
            store.setRedis(mockRedis);
            store.addBackend('test', mockBackend);

            const result = await store.load('test-id');
            expect(result).to.deep.equal({ from: 'backend' });
            // Should cache back to Redis
            expect(mockRedis.set.calledOnce).to.be.true;
        });

        it('should return null when not found anywhere', async () => {
            const mockRedis = {
                set: sinon.stub().resolves(),
                get: sinon.stub().resolves(null),
                del: sinon.stub()
            };

            const store = new Store();
            store.setRedis(mockRedis);

            const result = await store.load('nonexistent');
            expect(result).to.be.null;
        });

        it('should load without Redis', async () => {
            const mockBackend = {
                save: sinon.stub().resolves(),
                load: sinon.stub().resolves({ data: 'value' }),
                delete: sinon.stub()
            };

            const store = new Store();
            store.addBackend('test', mockBackend);

            const result = await store.load('test-id');
            expect(result).to.deep.equal({ data: 'value' });
        });
    });

    describe('delete', () => {
        it('should delete from Redis and backends', async () => {
            const mockRedis = { set: sinon.stub(), get: sinon.stub(), del: sinon.stub().resolves() };
            const mockBackend = { save: sinon.stub(), load: sinon.stub(), delete: sinon.stub().resolves() };

            const store = new Store();
            store.setRedis(mockRedis);
            store.addBackend('test', mockBackend);

            await store.delete('test-id');

            expect(mockRedis.del.calledOnce).to.be.true;
            expect(mockRedis.del.firstCall.args[0]).to.equal('saico:test-id');
            expect(mockBackend.delete.calledOnce).to.be.true;
        });
    });

    describe('addBackend', () => {
        it('should register a custom backend', async () => {
            const customBackend = {
                save: sinon.stub().resolves(),
                load: sinon.stub().resolves({ custom: true }),
                delete: sinon.stub().resolves()
            };

            const store = new Store();
            store.addBackend('custom', customBackend);

            const result = await store.load('test-id');
            expect(result).to.deep.equal({ custom: true });
        });
    });
});

describe('DynamoBackend', function () {
    let sandbox;

    beforeEach(() => {
        sandbox = sinon.createSandbox();
    });

    afterEach(() => {
        sandbox.restore();
    });

    it('should save items to DynamoDB', async () => {
        const mockAws = {
            dynamoPutItem: sinon.stub().resolves(),
            dynamoGetItem: sinon.stub(),
            dynamoDeleteItem: sinon.stub()
        };

        const backend = new DynamoBackend({ table: 'test-table', aws: mockAws });
        await backend.save('id-123', { data: 'value' });

        expect(mockAws.dynamoPutItem.calledOnce).to.be.true;
        expect(mockAws.dynamoPutItem.firstCall.args[0]).to.equal('test-table');
        const item = mockAws.dynamoPutItem.firstCall.args[1];
        expect(item.id).to.equal('id-123');
        expect(item.updated_at).to.be.a('number');
    });

    it('should load items from DynamoDB', async () => {
        const mockAws = {
            dynamoPutItem: sinon.stub(),
            dynamoGetItem: sinon.stub().resolves({ data: JSON.stringify({ foo: 'bar' }) }),
            dynamoDeleteItem: sinon.stub()
        };

        const backend = new DynamoBackend({ table: 'test-table', aws: mockAws });
        const result = await backend.load('id-123');

        expect(mockAws.dynamoGetItem.calledOnce).to.be.true;
        expect(result).to.deep.equal({ foo: 'bar' });
    });

    it('should return null for missing items', async () => {
        const mockAws = {
            dynamoPutItem: sinon.stub(),
            dynamoGetItem: sinon.stub().resolves(null),
            dynamoDeleteItem: sinon.stub()
        };

        const backend = new DynamoBackend({ table: 'test-table', aws: mockAws });
        const result = await backend.load('missing');

        expect(result).to.be.null;
    });

    it('should delete items from DynamoDB', async () => {
        const mockAws = {
            dynamoPutItem: sinon.stub(),
            dynamoGetItem: sinon.stub(),
            dynamoDeleteItem: sinon.stub().resolves()
        };

        const backend = new DynamoBackend({ table: 'test-table', aws: mockAws });
        await backend.delete('id-123');

        expect(mockAws.dynamoDeleteItem.calledOnce).to.be.true;
        expect(mockAws.dynamoDeleteItem.firstCall.args[1]).to.equal('id');
        expect(mockAws.dynamoDeleteItem.firstCall.args[2]).to.equal('id-123');
    });
});

describe('Compress/Decompress Messages', function () {
    it('should compress and decompress messages', async () => {
        const messages = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' }
        ];

        const compressed = await util.compressMessages(messages);
        expect(compressed).to.be.a('string');
        expect(compressed.length).to.be.greaterThan(0);

        const decompressed = await util.decompressMessages(compressed);
        expect(decompressed).to.deep.equal(messages);
    });

    it('should pass through arrays', async () => {
        const messages = [{ role: 'user', content: 'Test' }];
        const result = await util.decompressMessages(messages);
        expect(result).to.deep.equal(messages);
    });

    it('should decompress JSON strings', async () => {
        const messages = [{ role: 'user', content: 'Test' }];
        const jsonStr = JSON.stringify(messages);
        const result = await util.decompressMessages(jsonStr);
        expect(result).to.deep.equal(messages);
    });

    it('should throw on invalid data type', async () => {
        try {
            await util.decompressMessages(12345);
            expect.fail('Should have thrown');
        } catch (err) {
            expect(err.message).to.include('unsupported data type');
        }
    });

    it('should throw on invalid string data', async () => {
        try {
            await util.decompressMessages('not-valid-base64-or-json!!!');
            expect.fail('Should have thrown');
        } catch (err) {
            expect(err.message).to.include('unable to decompress');
        }
    });
});
