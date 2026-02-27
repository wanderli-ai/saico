'use strict';

const Itask = require('./itask.js');
const { Msgs, createMsgs } = require('./msgs.js');
const { Store } = require('./store.js');
const { Saico } = require('./saico.js');
const { DynamoDBAdapter } = require('./dynamo.js');

/**
 * Initialize Saico with storage configuration.
 * Registers the backend and optionally initializes Redis.
 *
 * @param {Object} config - Configuration options
 * @param {boolean} [config.redis=true] - Set false to skip Redis init
 * @param {Object} [config.dynamodb] - DynamoDB config { region, credentials, client }
 * @returns {Store} The initialized Store instance
 */
async function init(config = {}) {
    if (config.redis !== false) {
        const redis = require('./redis.js');
        await redis.init();
    }

    if (config.dynamodb)
        Saico.registerBackend('dynamodb', config.dynamodb);

    // Legacy: still init Store shell
    const store = Store.init(config);
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
