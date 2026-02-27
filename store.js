'use strict';

const crypto = require('crypto');

let _instance = null;

class Store {
    constructor(config = {}) {
        this._redis = null;
        this._config = config;
    }

    static get instance() {
        return _instance;
    }

    static set instance(val) {
        _instance = val;
    }

    static init(config = {}) {
        _instance = new Store(config);
        const redis = require('./redis.js');
        if (redis.rclient)
            _instance._redis = redis.rclient;
        return _instance;
    }

    setRedis(rclient) {
        this._redis = rclient;
    }

    generateId() {
        return crypto.randomBytes(8).toString('hex');
    }
}

module.exports = { Store };
