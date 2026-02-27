'use strict';

const crypto = require('crypto');
const Itask = require('./itask.js');
const { Context } = require('./msgs.js');
const { Store } = require('./store.js');
const util = require('./util.js');

function makeId(len = 12){
    return crypto.randomBytes(Math.ceil(len/2)).toString('hex').slice(0, len);
}

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
 * Saico orchestrates the full message payload sent to the LLM by walking its
 * parent chain to aggregate prompts, tools, digests, and state summaries.
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
     * @param {Array} [opt.functions] - Available AI functions
     * @param {string} [opt.key] - Redis key override (default: 'saico:<id>')
     * @param {boolean} [opt.redis=true] - Set false to skip Redis proxy
     * @param {boolean} [opt.createQ] - Create message Q context on activate()
     * @param {boolean} [opt.isolate] - Isolate: don't aggregate from ancestors
     * @param {Object} [opt.dynamodb] - DynamoDB config { region, credentials: { accessKeyId, secretAccessKey }, client }
     * @param {Object} [opt.db] - Pluggable DB backend
     * @param {Object} [opt.store] - Store instance override
     * @param {Object} [opt.userData] - Initial user data
     * @param {Object} [opt.sessionConfig] - Session config overrides
     */
    constructor(opt = {}) {
        // Internal properties (underscore-prefixed, not persisted to Redis)
        this._id = opt.id || crypto.randomBytes(8).toString('hex');
        this._task = null;
        this._store = opt.store || Store.instance || null;
        this._opt = opt;
        this._isolate = opt.isolate || false;

        // Context owned directly by Saico (not Itask)
        this.context = null;
        this.context_id = null;

        // Public configuration
        this.name = opt.name || this.constructor.name || 'saico';
        this.prompt = opt.prompt || '';
        this.functions = opt.functions || null;
        this.createQ = opt.createQ || false;

        // Absorbed from Sid
        this.userData = opt.userData || {};
        this.tm_create = Date.now();
        this.sessionConfig = {
            token_limit: opt.token_limit,
            max_depth: opt.max_depth,
            max_tool_repetition: opt.max_tool_repetition,
            queue_limit: opt.queue_limit,
            min_chat_messages: opt.min_chat_messages,
            ...opt.sessionConfig,
        };

        // DB backend — pluggable storage adapter.
        this._db = opt.db || null;
        if (!this._db && opt.dynamodb) {
            const { DynamoDBAdapter } = require('./dynamo.js');
            this._db = new DynamoDBAdapter({
                region: opt.dynamodb.region,
                credentials: opt.dynamodb.credentials,
                client: opt.dynamodb.client,
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
     * @param {boolean} [opts.createQ] - Override this.createQ for this activation
     * @param {string} [opts.prompt] - Additional prompt (appended to class-level)
     * @param {Array} [opts.functions] - Override functions
     * @param {Array} [opts.states] - Override this.states for this activation
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

        const states = opts.states || this.states || [];

        // Build effective prompt: class-level + activation-level
        const effectivePrompt = [this.prompt, opts.prompt].filter(Boolean).join('\n');

        const taskOpt = {
            name: this.name,
            id: opts.taskId,
            async: true,
            bind: this, // State functions run with Saico instance as `this`
        };

        this._task = new Itask(taskOpt, states);

        // Store Saico reference on task for parent chain traversal
        this._task._saico = this;

        // Create message Q context if requested (class-level or activate-level)
        if (opts.createQ ?? this.createQ) {
            const functions = opts.functions || this.functions;
            const contextConfig = {
                tag: opts.tag || this._task.id,
                token_limit: opts.token_limit ?? this.sessionConfig.token_limit,
                max_depth: opts.max_depth ?? this.sessionConfig.max_depth,
                max_tool_repetition: opts.max_tool_repetition ?? this.sessionConfig.max_tool_repetition,
                queue_limit: opts.queue_limit ?? this.sessionConfig.queue_limit,
                min_chat_messages: opts.min_chat_messages ?? this.sessionConfig.min_chat_messages,
                functions,
                sequential_mode: opts.sequential_mode,
                msgs: opts.msgs,
                chat_history: opts.chat_history,
                tool_digest: opts.tool_digest,
                ...opts.contextConfig,
            };

            const augmentedPrompt = effectivePrompt
                ? effectivePrompt + Saico.BACKEND_EXPLANATION
                : '';
            const context = new Context(augmentedPrompt, this._task, contextConfig);
            this.setContext(context);
        }

        return this;
    }

    // ---- Context management (owned by Saico, not Itask) ----

    /**
     * Set context on this Saico instance.
     * Generates context_id, sets context.tag, and calls context.setTask().
     */
    setContext(context) {
        this.context = context;
        // Generate context_id if not already set
        if (!this.context_id) {
            if (this._store)
                this.context_id = this._store.generateId();
            else if (Store.instance)
                this.context_id = Store.instance.generateId();
            else
                this.context_id = makeId(16);
        }
        if (context) {
            context.tag = this.context_id;
            if (typeof context.setTask === 'function')
                context.setTask(this._task);
        }
        return this;
    }

    /**
     * Find the nearest context walking UP the Saico/task hierarchy.
     */
    findContext() {
        if (this.context) return this.context;
        let task = this._task?.parent;
        while (task) {
            if (task._saico?.context) return task._saico.context;
            task = task.parent;
        }
        return null;
    }

    /**
     * Walk DOWN to find the deepest active descendant with a context.
     */
    findDeepestContext() {
        if (!this._task) return this.context || null;
        let deepest = this.context ? { context: this.context, depth: 0 } : null;
        const search = (task, depth) => {
            for (const child of task.child) {
                if (child._completed) continue;
                if (child._saico?.context) {
                    if (!deepest || depth + 1 >= deepest.depth)
                        deepest = { context: child._saico.context, depth: depth + 1 };
                }
                search(child, depth + 1);
            }
        };
        search(this._task, 0);
        return deepest ? deepest.context : null;
    }

    /**
     * Deactivate — bubble cleaned messages to parent, close context, cancel task.
     * Pushes cleaned messages (no tool calls, no BACKEND) into the parent's Q,
     * then closes the context without the default summary bubbling.
     */
    async deactivate() {
        if (!this._task) return;
        if (this.context) {
            // Find parent context to bubble cleaned messages
            let parentTask = this._task.parent;
            let parentCtx = null;
            while (parentTask) {
                if (parentTask._saico?.context) { parentCtx = parentTask._saico.context; break; }
                parentTask = parentTask.parent;
            }
            if (parentCtx) {
                const cleaned = this.getRecentMessages(Infinity);
                for (const msg of cleaned)
                    parentCtx.push(msg);
            }
            // Clean tool calls and close context without additional summary bubbling.
            if (this.context_id && typeof this.context.cleanToolCallsByTag === 'function')
                this.context.cleanToolCallsByTag(this.context_id);
            this.context = null;
            this.context_id = null;
        }
        this._task._ecancel();
        this._task = null;
    }

    // ---- Spawn ----

    /**
     * Spawn a child Saico under this Saico's task hierarchy.
     * Both parent and child must be activated.
     * @param {Saico} child - An activated Saico instance
     * @returns {Saico} the child (for chaining)
     */
    spawn(child) {
        if (!this._task)
            throw new Error('Not activated. Call activate() first.');
        if (!(child instanceof Saico))
            throw new Error('Child must be a Saico instance.');
        if (!child._task) child.activate();
        this._task.spawn(child._task);
        return child;
    }

    /**
     * Spawn a child Saico and start its task running.
     * @param {Saico} child - A Saico instance (auto-activated if needed)
     * @returns {Saico} the child (for chaining)
     */
    spawnAndRun(child) {
        this.spawn(child);
        process.nextTick(() => {
            try { child._task._run(); } catch (e) { console.error(e); }
        });
        return child;
    }

    // ---- Saico parent chain traversal ----

    /**
     * Walk up the Saico parent chain (stop at isolate boundary or root).
     * Returns array ordered root -> ... -> this.
     */
    _getSaicoAncestors() {
        const chain = [this];
        if (this._isolate) return chain;
        let task = this._task?.parent;
        while (task) {
            if (task._saico) {
                chain.unshift(task._saico);
                if (task._saico._isolate) break;
            }
            task = task.parent;
        }
        return chain; // root -> ... -> this
    }

    /**
     * Build preamble and aggregated functions by walking the Saico chain.
     * @param {Context} activeCtx - The deepest active context (for state summary logic)
     * @returns {{ preamble: Array, allFunctions: Array }}
     */
    _buildPreamble(activeCtx) {
        const chain = this._getSaicoAncestors();
        const preamble = [];
        const allFunctions = [];

        for (const saico of chain) {
            // Prompt
            if (saico.prompt)
                preamble.push({ role: 'system', content: saico.prompt });

            // State summary (can return array)
            const summary = saico._getStateSummary(activeCtx);
            if (Array.isArray(summary)) {
                for (const item of summary) {
                    if (typeof item === 'string')
                        preamble.push({ role: 'system', content: '[State Summary]\n' + item });
                    else
                        preamble.push(item); // {role, content} message object
                }
            } else if (summary) {
                preamble.push({ role: 'system', content: '[State Summary]\n' + summary });
            }

            // Tools digest
            if (saico.context?.tool_digest?.length > 0) {
                const digestText = saico.context.tool_digest.map(entry =>
                    `[${new Date(entry.tm).toISOString()}] ${entry.tool}: ${entry.result}`
                ).join('\n');
                preamble.push({ role: 'system', content: '[Tool Activity Log]\n' + digestText });
            }

            // Collect functions
            if (saico.functions) allFunctions.push(...saico.functions);
        }

        return { preamble, allFunctions };
    }

    // ---- Message orchestration ----

    async sendMessage(content, functions, opts) {
        if (!this._task)
            throw new Error('Not activated. Call activate() first.');

        // Find the active context (own or walk up)
        let ctx = this.findContext();
        if (!ctx)
            throw new Error('No context available');

        // Build preamble by walking Saico chain
        const activeCtx = this.findDeepestContext() || ctx;
        const { preamble, allFunctions } = this._buildPreamble(activeCtx);

        // Merge with call-specific functions
        if (functions) allFunctions.push(...(Array.isArray(functions) ? functions : [functions]));

        opts = Object.assign({}, opts, {
            tag: this.context_id,
            _preamble: preamble,
            _aggregatedFunctions: allFunctions.length > 0 ? allFunctions : null,
        });
        return ctx.sendMessage('user', '[BACKEND] ' + content, null, opts);
    }

    async recvChatMessage(content, opts) {
        if (!this._task)
            throw new Error('Not activated. Call activate() first.');

        // Route DOWN to deepest descendant with a msg Q
        const ctx = this.findDeepestContext();
        if (!ctx)
            throw new Error('No context available');

        // Build preamble by walking Saico chain
        const { preamble, allFunctions } = this._buildPreamble(ctx);

        opts = Object.assign({}, opts, {
            tag: ctx.tag,
            _preamble: preamble,
            _aggregatedFunctions: allFunctions.length > 0 ? allFunctions : null,
        });
        return ctx.sendMessage('user', content, null, opts);
    }

    // ---- Task delegation ----

    get task() { return this._task; }
    get isActive() { return !!this._task && !this._task._completed; }

    // ---- State Summary ----

    /**
     * Override in subclasses to provide a state summary.
     * @returns {string}
     */
    getStateSummary() { return ''; }

    /**
     * Get recent user/assistant messages (filtering out tool calls and BACKEND msgs).
     * @param {number} n - Max number of messages to return
     * @returns {Array<{role: string, content: string}>}
     */
    getRecentMessages(n = 5) {
        if (!this.context) return [];
        return this.context._msgs
            .filter(m => {
                if (m.msg.role === 'tool' || m.msg.tool_calls) return false;
                if (typeof m.msg.content === 'string' && m.msg.content.startsWith('[BACKEND]')) return false;
                return m.msg.role === 'user' || m.msg.role === 'assistant';
            })
            .slice(-n)
            .map(m => ({ role: m.msg.role, content: m.msg.content }));
    }

    /**
     * Internal state summary builder. Includes own getStateSummary() and,
     * if this context is NOT the active (deepest) Q, includes recent messages.
     * @param {Context} activeCtx - The deepest active context
     * @returns {Array|string|null}
     */
    _getStateSummary(activeCtx) {
        const parts = [];
        const own = this.getStateSummary();
        if (own) parts.push(own);

        // If this context is NOT the active (deepest) Q, include recent messages
        if (this.context && activeCtx && this.context !== activeCtx) {
            const recent = this.getRecentMessages(5);
            if (recent.length > 0) parts.push(...recent);
        }

        return parts.length > 0 ? parts : null;
    }

    // ---- User Data (absorbed from Sid) ----

    setUserData(key, value) {
        this.userData[key] = value;
        return this;
    }

    getUserData(key) {
        return key ? this.userData[key] : this.userData;
    }

    clearUserData() {
        this.userData = {};
        return this;
    }

    // ---- Session Info ----

    getSessionInfo() {
        return {
            id: this._id,
            name: this.name,
            running: this._task?.running || false,
            completed: this._task?._completed || false,
            messageCount: this.context?.length || 0,
            childCount: this._task?.child?.size || 0,
            userData: this.userData,
            uptime: Date.now() - this.tm_create,
        };
    }

    /**
     * Close the session — compress msgs, save full state to Store, cancel task.
     * The saved object has the same shape as serialize() but with compressed
     * context messages (chat_history) instead of raw _msgs.
     */
    async closeSession() {
        if (!this._task) return;

        // Save full state to Store with compressed msgs
        const store = this._store || Store.instance;
        if (store && this.context) {
            const { chat_history, tool_digest } = await this.context.prepareForStorage();
            const data = {
                id: this._id,
                name: this.name,
                prompt: this.prompt,
                userData: this.userData,
                sessionConfig: this.sessionConfig,
                tm_create: this.tm_create,
                isolate: this._isolate,
                taskId: this._task.id,
                context_id: this.context_id,
                context: {
                    tag: this.context.tag,
                    chat_history,
                    tool_digest,
                    functions: this.context.functions,
                },
            };
            await store.save(this._id, data);
        }

        this._task._ecancel();
    }

    // ---- Generic DB access ----

    /**
     * Find a DB backend — own _db first, then walk UP the parent Saico chain.
     * Throws if no backend found anywhere.
     */
    _getDb() {
        if (this._db) return this._db;
        let task = this._task?.parent;
        while (task) {
            if (task._saico?._db) return task._saico._db;
            task = task.parent;
        }
        throw new Error('No DB backend configured. Set opt.dynamodb or opt.db on this Saico or an ancestor.');
    }

    async dbPutItem(item, table) {
        const db = this._getDb();
        return db.put(item, table);
    }

    async dbGetItem(key, value, table) {
        const db = this._getDb();
        const result = await db.get(key, value, table);
        return result ? this._deserializeRecord(result) : result;
    }

    async dbDeleteItem(key, value, table) {
        const db = this._getDb();
        return db.delete(key, value, table);
    }

    async dbQuery(index, key, value, table) {
        const db = this._getDb();
        const results = await db.query(index, key, value, table);
        return Array.isArray(results)
            ? results.map(r => this._deserializeRecord(r))
            : results;
    }

    async dbGetAll(table) {
        const db = this._getDb();
        const results = await db.getAll(table);
        return Array.isArray(results)
            ? results.map(r => this._deserializeRecord(r))
            : results;
    }

    async dbUpdate(key, keyValue, setKey, item, table) {
        const db = this._getDb();
        return db.update(key, keyValue, setKey, item, table);
    }

    async dbUpdatePath(key, keyValue, path, setKey, item, table) {
        const db = this._getDb();
        return db.updatePath(key, keyValue, path, setKey, item, table);
    }

    async dbListAppend(key, keyValue, setKey, item, table) {
        const db = this._getDb();
        return db.listAppend(key, keyValue, setKey, item, table);
    }

    async dbListAppendPath(key, keyValue, path, setKey, item, table) {
        const db = this._getDb();
        return db.listAppendPath(key, keyValue, path, setKey, item, table);
    }

    async dbNextCounterId(counter, table) {
        const db = this._getDb();
        return db.nextCounterId(counter, table);
    }

    async dbGetCounterValue(counter, table) {
        const db = this._getDb();
        return db.getCounterValue(counter, table);
    }

    async dbSetCounterValue(counter, value, table) {
        const db = this._getDb();
        return db.setCounterValue(counter, value, table);
    }

    async dbCountItems(table) {
        const db = this._getDb();
        return db.countItems(table);
    }

    // ---- DB deserialization hook ----

    /**
     * Override in subclasses to transform raw DB records (e.g. restore class instances).
     * Called by dbGetItem, dbQuery, dbGetAll.
     * @param {Object} raw - Raw record from DB
     * @returns {Object} Transformed record
     */
    _deserializeRecord(raw) { return raw; }

    // ---- Serialization ----

    /**
     * Serialize the Saico instance to a JSON string.
     * Context messages are included as raw _msgs (for Redis / in-memory use).
     * For durable storage with compressed msgs, use closeSession().
     */
    serialize() {
        const data = {
            id: this._id,
            name: this.name,
            prompt: this.prompt,
            userData: this.userData,
            sessionConfig: this.sessionConfig,
            tm_create: this.tm_create,
            isolate: this._isolate,
        };
        data.taskId = this._task?.id || null;
        data.context_id = this.context_id || null;
        data.context = this.context ? {
            tag: this.context.tag,
            msgs: this.context._msgs,
            functions: this.context.functions,
            tool_digest: this.context.tool_digest,
        } : null;
        return JSON.stringify(data);
    }

    /**
     * Restore a Saico instance from serialized data.
     * Supports both raw msgs (from serialize/Redis) and compressed
     * chat_history (from closeSession/Store).
     * @param {string|Object} data - Serialized data (JSON string or object)
     * @param {Object} opt - Options (functions, store, states, etc.)
     * @returns {Saico}
     */
    static deserialize(data, opt = {}) {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;

        const instance = new Saico({
            id: parsed.id,
            name: parsed.name,
            prompt: parsed.prompt,
            userData: parsed.userData,
            sessionConfig: parsed.sessionConfig,
            isolate: parsed.isolate,
            functions: opt.functions || parsed.context?.functions,
            store: opt.store,
            redis: false, // No Redis proxy during deserialization
        });

        instance.tm_create = parsed.tm_create || instance.tm_create;

        // Activate with restored state if taskId exists
        if (parsed.taskId) {
            const ctx = parsed.context;
            instance.activate({
                createQ: !!ctx,
                taskId: parsed.taskId,
                tag: ctx?.tag,
                chat_history: ctx?.chat_history,
                functions: opt.functions || ctx?.functions,
                tool_digest: ctx?.tool_digest,
                states: opt.states || [],
                ...opt,
            });

            // Restore raw msgs (from serialize/Redis) — takes priority over chat_history
            if (ctx?.msgs && instance.context) {
                instance.context._msgs = ctx.msgs;
            }
        }

        return instance;
    }

    /**
     * Load a Saico instance from Store by id.
     * @param {string} id - The Saico instance id
     * @param {Object} opt - Options (store, functions, states, etc.)
     * @returns {Promise<Saico|null>}
     */
    static async rehydrate(id, opt = {}) {
        const store = opt.store || Store.instance;
        if (!store)
            throw new Error('No store available for rehydrate');
        const data = await store.load(id);
        if (!data) return null;
        const instance = Saico.deserialize(data, opt);
        // Decompress chat_history into _msgs if present
        if (instance.context)
            await instance.context.initHistory();
        return instance;
    }
}

// [BACKEND] explanation text appended to context prompts
Saico.BACKEND_EXPLANATION = '\nNote: Messages prefixed with [BACKEND] are from the backend ' +
    'server, not the user. They contain server instructions, data updates, or system context. ' +
    'Treat them as authoritative system-level information.';

module.exports = { Saico };
