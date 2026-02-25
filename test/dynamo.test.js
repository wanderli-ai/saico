'use strict';

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;

const { DynamoDBAdapter } = require('../dynamo.js');

describe('DynamoDBAdapter', function () {
    let sandbox;
    let mockClient;
    let adapter;

    beforeEach(() => {
        sandbox = sinon.createSandbox();

        // Mock DynamoDB client
        mockClient = {
            send: sandbox.stub(),
        };

        adapter = new DynamoDBAdapter({
            client: mockClient,
        });
        // Mock the doc client separately (lazy getter won't work with mock client)
        adapter.__docClient = { send: mockClient.send };
    });

    afterEach(() => {
        sandbox.restore();
    });

    describe('constructor', () => {
        it('should default region to us-east-1', () => {
            expect(adapter._region).to.equal('us-east-1');
        });

        it('should accept custom region', () => {
            const a = new DynamoDBAdapter({ region: 'eu-west-1', client: mockClient });
            expect(a._region).to.equal('eu-west-1');
        });

        it('should use injected client', () => {
            expect(adapter._client).to.equal(mockClient);
        });

        it('should accept credentials', () => {
            const creds = { accessKeyId: 'AK', secretAccessKey: 'SK' };
            const a = new DynamoDBAdapter({ credentials: creds, client: mockClient });
            expect(a._client).to.equal(mockClient);
        });
    });

    describe('_table', () => {
        it('should return table when provided', () => {
            expect(adapter._table('my-table')).to.equal('my-table');
        });

        it('should throw when no table provided', () => {
            expect(() => adapter._table()).to.throw('table name required');
        });
    });

    describe('put', () => {
        it('should send PutItemCommand with marshalled item', async () => {
            mockClient.send.resolves({});
            await adapter.put({ id: '123', name: 'test' }, 'test-table');
            expect(mockClient.send.calledOnce).to.be.true;
            const cmd = mockClient.send.firstCall.args[0];
            expect(cmd.input.TableName).to.equal('test-table');
            expect(cmd.input.Item).to.be.an('object');
        });

        it('should throw when no table provided', async () => {
            try {
                await adapter.put({ id: '1' });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('table name required');
            }
        });
    });

    describe('get', () => {
        it('should return unmarshalled item', async () => {
            mockClient.send.resolves({
                Item: { id: { S: '123' }, name: { S: 'test' } },
            });
            const item = await adapter.get('id', '123', 'test-table');
            expect(item).to.deep.equal({ id: '123', name: 'test' });
        });

        it('should return undefined when item not found', async () => {
            mockClient.send.resolves({ Item: undefined });
            const item = await adapter.get('id', '999', 'test-table');
            expect(item).to.be.undefined;
        });
    });

    describe('delete', () => {
        it('should send DeleteItemCommand', async () => {
            mockClient.send.resolves({});
            await adapter.delete('id', '123', 'test-table');
            expect(mockClient.send.calledOnce).to.be.true;
            const cmd = mockClient.send.firstCall.args[0];
            expect(cmd.input.TableName).to.equal('test-table');
        });
    });

    describe('query', () => {
        it('should return unmarshalled items', async () => {
            mockClient.send.resolves({
                Items: [
                    { id: { S: '1' }, email: { S: 'a@b.com' } },
                    { id: { S: '2' }, email: { S: 'a@b.com' } },
                ],
            });
            const items = await adapter.query('email-index', 'email', 'a@b.com', 'test-table');
            expect(items).to.have.lengthOf(2);
            expect(items[0].email).to.equal('a@b.com');
        });

        it('should return undefined when no items', async () => {
            mockClient.send.resolves({ Items: undefined });
            const items = await adapter.query('idx', 'k', 'v', 'test-table');
            expect(items).to.be.undefined;
        });
    });

    describe('getAll', () => {
        it('should return all items', async () => {
            mockClient.send.resolves({
                Items: [
                    { id: { S: '1' } },
                    { id: { S: '2' } },
                ],
            });
            const items = await adapter.getAll('test-table');
            expect(items).to.have.lengthOf(2);
        });

        it('should return empty array when no items', async () => {
            mockClient.send.resolves({ Items: [] });
            const items = await adapter.getAll('test-table');
            expect(items).to.deep.equal([]);
        });
    });

    describe('update', () => {
        it('should delegate to updatePath with empty path', async () => {
            // Mock the get call for _getItemPath
            mockClient.send.onFirstCall().resolves({
                Item: { id: { S: '1' }, status: { S: 'old' } },
            });
            // Mock the UpdateCommand
            mockClient.send.onSecondCall().resolves({ Attributes: {} });

            await adapter.update('id', '1', 'status', 'new', 'test-table');
            expect(mockClient.send.calledTwice).to.be.true;
        });
    });

    describe('listAppend', () => {
        it('should delegate to listAppendPath with empty path', async () => {
            mockClient.send.onFirstCall().resolves({
                Item: { id: { S: '1' }, items: { L: [] } },
            });
            mockClient.send.onSecondCall().resolves({ Attributes: {} });

            await adapter.listAppend('id', '1', 'items', { name: 'new' }, 'test-table');
            expect(mockClient.send.calledTwice).to.be.true;
        });
    });

    describe('nextCounterId', () => {
        it('should return incremented counter value', async () => {
            mockClient.send.resolves({
                Attributes: { CounterValue: { N: '42' } },
            });
            const id = await adapter.nextCounterId('MyCounter');
            expect(id).to.equal('42');
            const cmd = mockClient.send.firstCall.args[0];
            expect(cmd.input.TableName).to.equal('counters');
        });

        it('should use custom counters table', async () => {
            mockClient.send.resolves({
                Attributes: { CounterValue: { N: '1' } },
            });
            await adapter.nextCounterId('MyCounter', 'my-counters');
            const cmd = mockClient.send.firstCall.args[0];
            expect(cmd.input.TableName).to.equal('my-counters');
        });
    });

    describe('getCounterValue', () => {
        it('should return current counter value', async () => {
            mockClient.send.resolves({
                Item: { CounterName: { S: 'MyCounter' }, CounterValue: { N: '10' } },
            });
            const val = await adapter.getCounterValue('MyCounter');
            expect(val).to.equal(10);
        });

        it('should initialize counter to 0 when not found', async () => {
            // First call: get returns no item
            mockClient.send.onFirstCall().resolves({ Item: undefined });
            // Second call: put to initialize
            mockClient.send.onSecondCall().resolves({});
            const val = await adapter.getCounterValue('NewCounter');
            expect(val).to.equal(0);
        });
    });

    describe('setCounterValue', () => {
        it('should put counter value', async () => {
            mockClient.send.resolves({});
            await adapter.setCounterValue('MyCounter', 50);
            expect(mockClient.send.calledOnce).to.be.true;
        });
    });

    describe('countItems', () => {
        it('should count all items with pagination', async () => {
            // First page
            mockClient.send.onFirstCall().resolves({
                Count: 100,
                LastEvaluatedKey: { id: { S: '100' } },
            });
            // Second page (last)
            mockClient.send.onSecondCall().resolves({
                Count: 50,
                LastEvaluatedKey: undefined,
            });
            const count = await adapter.countItems('test-table');
            expect(count).to.equal(150);
            expect(mockClient.send.calledTwice).to.be.true;
        });

        it('should handle single page', async () => {
            mockClient.send.resolves({ Count: 25 });
            const count = await adapter.countItems('test-table');
            expect(count).to.equal(25);
        });
    });

    describe('error handling', () => {
        it('should propagate errors from put', async () => {
            mockClient.send.rejects(new Error('DynamoDB error'));
            try {
                await adapter.put({ id: '1' }, 'test-table');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('DynamoDB error');
            }
        });

        it('should propagate errors from get', async () => {
            mockClient.send.rejects(new Error('DynamoDB error'));
            try {
                await adapter.get('id', '1', 'test-table');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('DynamoDB error');
            }
        });
    });
});
