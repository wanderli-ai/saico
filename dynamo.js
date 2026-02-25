'use strict';

/**
 * DynamoDBAdapter — Generic DynamoDB access layer.
 *
 * Provides CRUD, update, list-append, counter, and scan operations.
 * Table name is required on every call.
 *
 * AWS SDK v3 packages are required only when this module is loaded.
 */

const { DynamoDBClient, UpdateItemCommand, QueryCommand, DeleteItemCommand,
    GetItemCommand, PutItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { unmarshall, marshall } = require('@aws-sdk/util-dynamodb');

class DynamoDBAdapter {
    /**
     * @param {Object} opt
     * @param {string} [opt.region='us-east-1'] - AWS region
     * @param {Object} [opt.credentials] - AWS credentials { accessKeyId, secretAccessKey }
     * @param {DynamoDBClient} [opt.client] - Injectable DynamoDB client (for testing)
     */
    constructor(opt = {}) {
        this._region = opt.region || 'us-east-1';
        this._client = opt.client || new DynamoDBClient({
            region: this._region,
            ...(opt.credentials && { credentials: opt.credentials }),
        });
        this.__docClient = null;
    }

    get _docClient() {
        if (!this.__docClient)
            this.__docClient = DynamoDBDocumentClient.from(this._client);
        return this.__docClient;
    }

    _table(table) {
        if (!table) throw new Error('DynamoDBAdapter: table name required');
        return table;
    }

    _unmarshall(item) {
        if (!item) return undefined;
        if (Array.isArray(item))
            return item.map(i => unmarshall(i));
        return unmarshall(item);
    }

    _removeUndefined(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    // ---- Core CRUD ----

    async put(item, table) {
        const params = {
            TableName: this._table(table),
            Item: marshall(item, { removeUndefinedValues: true, convertClassInstanceToMap: true }),
        };
        await this._client.send(new PutItemCommand(params));
    }

    async get(key, value, table) {
        const _key = {};
        _key[key] = { S: value };
        const params = {
            TableName: this._table(table),
            Key: _key,
        };
        const data = await this._client.send(new GetItemCommand(params));
        return this._unmarshall(data.Item);
    }

    async delete(key, value, table) {
        const _key = {};
        _key[key] = { S: value };
        const params = {
            TableName: this._table(table),
            Key: _key,
        };
        const data = await this._client.send(new DeleteItemCommand(params));
        return data;
    }

    async query(index, key, value, table) {
        const params = {
            TableName: this._table(table),
            IndexName: index,
            KeyConditionExpression: '#k = :key',
            ExpressionAttributeNames: { '#k': key },
            ExpressionAttributeValues: { ':key': { S: value } },
        };
        const data = await this._client.send(new QueryCommand(params));
        return this._unmarshall(data.Items);
    }

    async getAll(table) {
        const params = {
            TableName: this._table(table),
        };
        const response = await this._client.send(new ScanCommand(params));
        if (!response.Items || response.Items.length === 0)
            return [];
        return this._unmarshall(response.Items);
    }

    // ---- Update operations ----

    async update(key, keyValue, setKey, item, table) {
        return this.updatePath(key, keyValue, [], setKey, item, table);
    }

    async updatePath(key, keyValue, path, setKey, item, table) {
        const _key = {};
        _key[key] = keyValue;
        path = path || [];
        const res = await this._getItemPath(key, keyValue, path, table);
        const sanitizedItem = this._removeUndefined(item);
        const params = {
            TableName: this._table(table),
            Key: _key,
            UpdateExpression: `SET ${res.path}#k = :e`,
            ExpressionAttributeNames: { '#k': setKey.replace('.', '') },
            ExpressionAttributeValues: { ':e': sanitizedItem },
            ReturnValues: 'UPDATED_NEW',
        };
        return await this._docClient.send(new UpdateCommand(params));
    }

    async listAppend(key, keyValue, setKey, item, table) {
        return this.listAppendPath(key, keyValue, [], setKey, item, table);
    }

    async listAppendPath(key, keyValue, path, setKey, item, table) {
        const _key = {};
        _key[key] = keyValue;
        path = path || [];
        const res = await this._getItemPath(key, keyValue, path, table);
        const sanitizedItem = this._removeUndefined(item);
        const params = {
            TableName: this._table(table),
            Key: _key,
            UpdateExpression:
                `SET ${res.path}${setKey} = list_append(if_not_exists(${res.path}${setKey}, :emptyList), :e)`,
            ConditionExpression: 'NOT contains(myList, :check_item)',
            ExpressionAttributeValues: {
                ':emptyList': [],
                ':e': [sanitizedItem],
                ':check_item': sanitizedItem,
            },
            ReturnValues: 'UPDATED_NEW',
        };
        return await this._docClient.send(new UpdateCommand(params));
    }

    // ---- Counter operations ----

    async nextCounterId(counter, table) {
        const params = {
            TableName: table || 'counters',
            Key: { CounterName: { S: counter } },
            UpdateExpression: 'SET #val = if_not_exists(#val, :zero) + :incr',
            ExpressionAttributeNames: { '#val': 'CounterValue' },
            ExpressionAttributeValues: { ':incr': { N: '1' }, ':zero': { N: '0' } },
            ReturnValues: 'UPDATED_NEW',
        };
        const result = await this._client.send(new UpdateItemCommand(params));
        return String(result.Attributes.CounterValue.N);
    }

    async getCounterValue(counter, table) {
        const item = await this.get('CounterName', counter, table || 'counters');
        if (!item) {
            await this.put({ CounterName: counter, CounterValue: 0 }, table || 'counters');
            return 0;
        }
        return Number(item.CounterValue || 0);
    }

    async setCounterValue(counter, value, table) {
        await this.put(
            { CounterName: counter, CounterValue: Number(value) || 0 },
            table || 'counters'
        );
    }

    // ---- Utility ----

    async countItems(table) {
        let total = 0;
        let lastEvaluatedKey;
        do {
            const params = {
                TableName: this._table(table),
                Select: 'COUNT',
                ExclusiveStartKey: lastEvaluatedKey,
            };
            const response = await this._client.send(new ScanCommand(params));
            total += response.Count || 0;
            lastEvaluatedKey = response.LastEvaluatedKey;
        } while (lastEvaluatedKey);
        return total;
    }

    // ---- Internal helpers ----

    async _getItemPath(key, keyValue, path, table) {
        let item = await this.get(key, keyValue, table);
        let indexedPath = '';
        for (const p of path) {
            item = item[p.key];
            indexedPath += p.key + (!p.skey ? '.' : '');
            if (!p.skey)
                continue;
            const idx = item.findIndex(b => b[p.skey] == p.svalue);
            if (idx < 0)
                throw new Error('_getItemPath: cannot find item with key ' + p.skey + '=' + p.svalue);
            item = item[idx];
            indexedPath += '[' + idx + '].';
        }
        return { item, path: indexedPath };
    }
}

module.exports = { DynamoDBAdapter };
