'use strict';

const crypto = require('crypto');
const Itask = require('./itask.js');
const { Context } = require('./msgs.js');
const { Store } = require('./store.js');

/**
 * Saico — Master class for building AI-powered services.
 *
 * External users extend this class instead of Itask. It separates object
 * lifecycle from task activation:
 *
 *   - Construction: sets up storage (Redis observable + optional DynamoDB),
 *     class-level prompt, tool config. No Itask is created yet.
 *   - activate(opts): creates the internal Itask and optionally attaches a
 *     message Q context (when opts.createQ is true).
 *   - DB access works before and after activation.
 *
 * `new Saico(opt)` returns a Redis observable proxy of the instance when
 * Redis is available, enabling automatic persistence of public properties.
 */
class Saico {
    /**
     * @param {Object} opt
     * @param {string} [opt.id] - Instance ID (auto-generated if omitted)
     * @param {string} [opt.name] - Instance name (defaults to class name)
     * @param {string} [opt.prompt] - Class-level system prompt
     * @param {Function} [opt.tool_handler] - Tool handler function
     * @param {Array} [opt.functions] - Available AI functions
     * @param {string} [opt.key] - Redis key override (default: 'saico:<id>')
     * @param {boolean} [opt.redis=true] - Set false to skip Redis proxy
     * @param {string} [opt.dynamodb_table] - DynamoDB table name (enables db accessor)
     * @param {string} [opt.dynamodb_region] - AWS region for DynamoDB
     * @param {Object} [opt.dynamodb_client] - Injectable DynamoDB client (for testing)
     * @param {Object} [opt.store] - Store instance override
     */
    constructor(opt = {}) {
        // Internal properties (underscore-prefixed, not persisted to Redis)
        this._id = opt.id || crypto.randomBytes(8).toString('hex');
        this._task = null;
        this._store = opt.store || Store.instance || null;
        this._opt = opt;

        // Public configuration
        this.name = opt.name || this.constructor.name || 'saico';
        this.prompt = opt.prompt || '';
        this.tool_handler = opt.tool_handler || null;
        this.functions = opt.functions || null;

        // DB backend — pluggable storage adapter.
        // Any adapter that implements the same interface (put/get/delete/query/
        // getAll/update/updatePath/listAppend/listAppendPath/nextCounterId/
        // getCounterValue/setCounterValue/countItems) can be used.
        this._db = opt.db || null;
        if (!this._db && opt.dynamodb_table) {
            const { DynamoDBAdapter } = require('./dynamo.js');
            this._db = new DynamoDBAdapter({
                table: opt.dynamodb_table,
                region: opt.dynamodb_region,
                client: opt.dynamodb_client,
            });
        }

        // Return Redis observable proxy (must be last in constructor).
        // Subclasses calling super() will receive the proxy as `this`.
        try {
            const redis = require('./redis.js');
            if (redis.rclient && opt.redis !== false) {
                const key = 'saico:' + (opt.key || this._id);
                return redis.createObservableForRedis(key, this);
            }
        } catch (e) { /* redis not available */ }
    }

    /**
     * Create the internal Itask and optionally a message Q context.
     *
     * @param {Object} opts
     * @param {boolean} [opts.createQ] - If true, attach a message Q (Context)
     * @param {string} [opts.prompt] - Additional prompt (appended to class-level)
     * @param {Function} [opts.tool_handler] - Override tool handler
     * @param {Array} [opts.functions] - Override functions
     * @param {Array} [opts.states] - Task state functions
     * @param {Itask} [opts.parent] - Parent task to spawn under
     * @param {string} [opts.taskId] - Custom task ID
     * @param {number} [opts.token_limit] - Token limit for context
     * @param {number} [opts.max_depth] - Max tool call depth
     * @param {number} [opts.max_tool_repetition] - Max tool repetition
     * @param {number} [opts.queue_limit] - Message queue limit
     * @param {number} [opts.min_chat_messages] - Min chat messages in queue
     * @param {boolean} [opts.sequential_mode] - Sequential message processing
     * @param {Array} [opts.msgs] - Initial messages
     * @param {*} [opts.chat_history] - Chat history to restore
     * @param {Object} [opts.contextConfig] - Additional Context config overrides
     * @returns {Saico} this instance (for chaining)
     */
    activate(opts = {}) {
        if (this._task)
            throw new Error('Already activated. Call deactivate() first.');

        const states = opts.states || [];

        // Build effective prompt: class-level + activation-level
        const effectivePrompt = [this.prompt, opts.prompt].filter(Boolean).join('\n');

        const taskOpt = {
            name: this.name,
            id: opts.taskId,
            async: true,
            store: this._store,
            tool_handler: opts.tool_handler || this.tool_handler,
            functions: opts.functions || this.functions,
            bind: this, // State functions run with Saico instance as `this`
        };

        if (opts.parent)
            taskOpt.spawn_parent = opts.parent;

        this._task = new Itask(taskOpt, states);

        // Delegate getStateSummary from task to this Saico instance
        const saicoInstance = this;
        this._task.getStateSummary = function () {
            return saicoInstance.getStateSummary();
        };

        // Create message Q context if requested (only via createQ flag, NOT prompt)
        if (opts.createQ) {
            const contextConfig = {
                tag: opts.tag || this._task.id,
                token_limit: opts.token_limit,
                max_depth: opts.max_depth,
                max_tool_repetition: opts.max_tool_repetition,
                queue_limit: opts.queue_limit,
                min_chat_messages: opts.min_chat_messages,
                tool_handler: taskOpt.tool_handler,
                functions: taskOpt.functions,
                sequential_mode: opts.sequential_mode,
                msgs: opts.msgs,
                chat_history: opts.chat_history,
                ...opts.contextConfig,
            };

            const augmentedPrompt = effectivePrompt
                ? effectivePrompt + Itask.BACKEND_EXPLANATION
                : '';
            const context = new Context(augmentedPrompt, this._task, contextConfig);
            this._task.setContext(context);
        }

        return this;
    }

    /**
     * Deactivate — close context, cancel task, clean up.
     */
    async deactivate() {
        if (!this._task) return;
        if (this._task.context)
            await this._task.closeContext();
        this._task._ecancel();
        this._task = null;
    }

    // ---- Message relay ----

    async sendMessage(content, functions, opts) {
        if (!this._task)
            throw new Error('Not activated. Call activate() first.');
        return this._task.sendMessage(content, functions, opts);
    }

    async recvChatMessage(content, opts) {
        if (!this._task)
            throw new Error('Not activated. Call activate() first.');
        return this._task.recvChatMessage(content, opts);
    }

    // ---- Task delegation ----

    get task() { return this._task; }
    get context() { return this._task?.context || null; }
    get context_id() { return this._task?.context_id || null; }
    get isActive() { return !!this._task && !this._task._completed; }

    spawnTaskWithContext(opt, states) {
        if (!this._task)
            throw new Error('Not activated. Call activate() first.');
        if (typeof opt === 'string')
            opt = { name: opt };

        const childTask = new Itask({
            ...opt,
            spawn_parent: this._task,
            store: this._store,
            async: true,
        }, states || []);

        if (opt.prompt) {
            const childContext = new Context(opt.prompt, childTask, {
                tag: opt.tag || childTask.id,
                token_limit: opt.token_limit,
                max_depth: opt.max_depth,
                max_tool_repetition: opt.max_tool_repetition,
                queue_limit: opt.queue_limit,
                min_chat_messages: opt.min_chat_messages,
                tool_handler: opt.tool_handler || this.tool_handler,
                functions: opt.functions || this.functions,
            });
            childTask.setContext(childContext);
        }

        process.nextTick(() => {
            try { childTask._run(); } catch (e) { console.error(e); }
        });

        return childTask;
    }

    spawnTask(opt, states) {
        if (!this._task)
            throw new Error('Not activated. Call activate() first.');
        if (typeof opt === 'string')
            opt = { name: opt };

        const childTask = new Itask({
            ...opt,
            spawn_parent: this._task,
            store: this._store,
            async: true,
        }, states || []);

        process.nextTick(() => {
            try { childTask._run(); } catch (e) { console.error(e); }
        });

        return childTask;
    }

    // ---- Generic DB access ----
    // These delegate to whatever _db backend was configured (DynamoDB, MongoDB,
    // etc). Upper layers call these and don't care about the storage impl.
    // All are no-ops (return undefined) when no backend is configured.

    async dbPutItem(item, table) {
        if (!this._db) return;
        return this._db.put(item, table);
    }

    async dbGetItem(key, value, table) {
        if (!this._db) return;
        return this._db.get(key, value, table);
    }

    async dbDeleteItem(key, value, table) {
        if (!this._db) return;
        return this._db.delete(key, value, table);
    }

    async dbQuery(index, key, value, table) {
        if (!this._db) return;
        return this._db.query(index, key, value, table);
    }

    async dbGetAll(table) {
        if (!this._db) return;
        return this._db.getAll(table);
    }

    async dbUpdate(key, keyValue, setKey, item, table) {
        if (!this._db) return;
        return this._db.update(key, keyValue, setKey, item, table);
    }

    async dbUpdatePath(key, keyValue, path, setKey, item, table) {
        if (!this._db) return;
        return this._db.updatePath(key, keyValue, path, setKey, item, table);
    }

    async dbListAppend(key, keyValue, setKey, item, table) {
        if (!this._db) return;
        return this._db.listAppend(key, keyValue, setKey, item, table);
    }

    async dbListAppendPath(key, keyValue, path, setKey, item, table) {
        if (!this._db) return;
        return this._db.listAppendPath(key, keyValue, path, setKey, item, table);
    }

    async dbNextCounterId(counter, table) {
        if (!this._db) return;
        return this._db.nextCounterId(counter, table);
    }

    async dbGetCounterValue(counter, table) {
        if (!this._db) return;
        return this._db.getCounterValue(counter, table);
    }

    async dbSetCounterValue(counter, value, table) {
        if (!this._db) return;
        return this._db.setCounterValue(counter, value, table);
    }

    async dbCountItems(table) {
        if (!this._db) return;
        return this._db.countItems(table);
    }

    // ---- Overridable hooks ----

    /**
     * Override in subclasses to provide a state summary that appears
     * in the message queue sent to the AI model.
     * @returns {string}
     */
    getStateSummary() { return ''; }

    // ---- Serialization ----

    serialize() {
        const data = {
            id: this._id,
            name: this.name,
            prompt: this.prompt,
        };
        if (this._task) {
            data.task = {
                id: this._task.id,
                context_id: this._task.context_id,
                context: this._task.context ? {
                    tag: this._task.context.tag,
                    msgs: this._task.context._msgs,
                    functions: this._task.context.functions,
                    chat_history: this._task.context.chat_history,
                    tool_digest: this._task.context.tool_digest,
                } : null,
            };
        }
        return JSON.stringify(data);
    }
}

module.exports = { Saico };
