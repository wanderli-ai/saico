'use strict';

const crypto = require('crypto');

let _instance = null;

class DynamoBackend {
    constructor({ table, aws }) {
        this.table = table;
        this.aws = aws;
    }

    async save(id, data) {
        await this.aws.dynamoPutItem(this.table, {
            id,
            data: typeof data === 'string' ? data : JSON.stringify(data),
            updated_at: Date.now()
        });
    }

    async load(id) {
        const item = await this.aws.dynamoGetItem(this.table, 'id', id);
        if (!item)
            return null;
        const data = item.data;
        if (typeof data === 'string') {
            try { return JSON.parse(data); }
            catch (e) { return data; }
        }
        return data;
    }

    async delete(id) {
        await this.aws.dynamoDeleteItem(this.table, 'id', id);
    }
}

class Store {
    constructor(config = {}) {
        this._redis = null;
        this._backends = {};
        this._config = config;

        if (config.dynamodb) {
            this._backends.dynamodb = new DynamoBackend(config.dynamodb);
        }
    }

    static get instance() {
        return _instance;
    }

    static set instance(val) {
        _instance = val;
    }

    static init(config = {}) {
        _instance = new Store(config);
        // If redis module provided or redis is already initialized, grab the client
        const redis = require('./redis.js');
        if (redis.rclient)
            _instance._redis = redis.rclient;
        return _instance;
    }

    setRedis(rclient) {
        this._redis = rclient;
    }

    addBackend(name, backend) {
        this._backends[name] = backend;
    }

    generateId() {
        return crypto.randomBytes(8).toString('hex');
    }

    async save(id, data) {
        const key = 'saico:' + id;
        const serialized = typeof data === 'string' ? data : JSON.stringify(data);

        // Always save to Redis if available
        if (this._redis) {
            try {
                await this._redis.set(key, serialized);
            } catch (e) {
                console.error('Store: Redis save error:', e.message);
            }
        }

        // Save to all configured backends
        for (const [name, backend] of Object.entries(this._backends)) {
            try {
                await backend.save(id, data);
            } catch (e) {
                console.error(`Store: ${name} backend save error:`, e.message);
            }
        }
    }

    async load(id) {
        const key = 'saico:' + id;

        // Try Redis first
        if (this._redis) {
            try {
                const cached = await this._redis.get(key);
                if (cached) {
                    try { return JSON.parse(cached); }
                    catch (e) { return cached; }
                }
            } catch (e) {
                console.error('Store: Redis load error:', e.message);
            }
        }

        // Fall back to backends
        for (const [name, backend] of Object.entries(this._backends)) {
            try {
                const data = await backend.load(id);
                if (data) {
                    // Cache to Redis for next time
                    if (this._redis) {
                        try {
                            const serialized = typeof data === 'string'
                                ? data : JSON.stringify(data);
                            await this._redis.set(key, serialized);
                        } catch (e) {
                            console.error('Store: Redis cache-back error:', e.message);
                        }
                    }
                    return data;
                }
            } catch (e) {
                console.error(`Store: ${name} backend load error:`, e.message);
            }
        }

        return null;
    }

    async delete(id) {
        const key = 'saico:' + id;

        if (this._redis) {
            try {
                await this._redis.del(key);
            } catch (e) {
                console.error('Store: Redis delete error:', e.message);
            }
        }

        for (const [name, backend] of Object.entries(this._backends)) {
            try {
                await backend.delete(id);
            } catch (e) {
                console.error(`Store: ${name} backend delete error:`, e.message);
            }
        }
    }
}

module.exports = { Store, DynamoBackend };
