'use strict';

const Itask = require('./itask.js');
const { Msgs, createMsgs } = require('./msgs.js');
const { Store, DynamoBackend } = require('./store.js');
const { Saico } = require('./saico.js');
const { DynamoDBAdapter } = require('./dynamo.js');

/**
 * Initialize Saico with storage configuration.
 * Sets up the Store singleton and optionally initializes Redis.
 *
 * @param {Object} config - Configuration options
 * @param {boolean} config.redis - Whether to initialize Redis
 * @param {Object} config.dynamodb - DynamoDB backend config {table, aws}
 * @returns {Store} The initialized Store instance
 */
async function init(config = {}) {
    const store = Store.init(config);

    if (config.redis) {
        const redis = require('./redis.js');
        await redis.init();
        store.setRedis(redis.rclient);
    }

    return store;
}

module.exports = {
    // Master class (external users extend this)
    Saico,
    DynamoDBAdapter,

    // Core classes
    Itask,
    Msgs,
    Store,
    DynamoBackend,

    // Initialization
    init,

    // Factory
    createMsgs,

    // Utilities (re-export from util.js)
    util: require('./util.js'),

    // OpenAI wrapper (re-export)
    openai: require('./openai.js'),

    // Redis persistence (re-export)
    redis: require('./redis.js'),
};
