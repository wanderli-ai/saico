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
     * @param {Function} [opt.tool_handler] - Tool handler function
     * @param {Array} [opt.functions] - Available AI functions
     * @param {string} [opt.key] - Redis key override (default: 'saico:<id>')
     * @param {boolean} [opt.redis=true] - Set false to skip Redis proxy
     * @param {boolean} [opt.isolate] - Isolate: don't aggregate from ancestors
     * @param {string} [opt.dynamodb_table] - DynamoDB table name (enables db accessor)
     * @param {string} [opt.dynamodb_region] - AWS region for DynamoDB
     * @param {Object} [opt.dynamodb_client] - Injectable DynamoDB client (for testing)
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

        // Public configuration
        this.name = opt.name || this.constructor.name || 'saico';
        this.prompt = opt.prompt || '';
        this.tool_handler = opt.tool_handler || null;
        this.functions = opt.functions || null;

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

        // Store Saico reference on task for parent chain traversal
        this._task._saico = this;

        // Create message Q context if requested (only via createQ flag, NOT prompt)
        if (opts.createQ) {
            const contextConfig = {
                tag: opts.tag || this._task.id,
                token_limit: opts.token_limit ?? this.sessionConfig.token_limit,
                max_depth: opts.max_depth ?? this.sessionConfig.max_depth,
                max_tool_repetition: opts.max_tool_repetition ?? this.sessionConfig.max_tool_repetition,
                queue_limit: opts.queue_limit ?? this.sessionConfig.queue_limit,
                min_chat_messages: opts.min_chat_messages ?? this.sessionConfig.min_chat_messages,
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
     * Deactivate — bubble cleaned messages to parent, close context, cancel task.
     * Pushes cleaned messages (no tool calls, no BACKEND) into the parent's Q,
     * then closes the context without the default summary bubbling.
     */
    async deactivate() {
        if (!this._task) return;
        if (this._task.context) {
            // Find parent context to bubble cleaned messages
            let parentTask = this._task.parent;
            let parentCtx = null;
            while (parentTask) {
                if (parentTask.context) { parentCtx = parentTask.context; break; }
                parentTask = parentTask.parent;
            }
            if (parentCtx) {
                const cleaned = this.getRecentMessages(Infinity);
                for (const msg of cleaned)
                    parentCtx.push(msg);
            }
            // Clean tool calls and close context without additional summary bubbling.
            // We already pushed cleaned messages above — closeContext's own
            // summarization would double-bubble.
            if (this._task.context_id && typeof this._task.context.cleanToolCallsByTag === 'function')
                this._task.context.cleanToolCallsByTag(this._task.context_id);
            this._task.context = null;
        }
        this._task._ecancel();
        this._task = null;
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
        let ctx = this._task.getContext() || this._task.findContext();
        if (!ctx)
            throw new Error('No context available');

        // Build preamble by walking Saico chain
        const activeCtx = this._task.findDeepestContext() || ctx;
        const { preamble, allFunctions } = this._buildPreamble(activeCtx);

        // Merge with call-specific functions
        if (functions) allFunctions.push(...(Array.isArray(functions) ? functions : [functions]));

        opts = Object.assign({}, opts, {
            tag: this._task.context_id,
            _preamble: preamble,
            _aggregatedFunctions: allFunctions.length > 0 ? allFunctions : null,
        });
        return ctx.sendMessage('user', '[BACKEND] ' + content, null, opts);
    }

    async recvChatMessage(content, opts) {
        if (!this._task)
            throw new Error('Not activated. Call activate() first.');

        // Route DOWN to deepest descendant with a msg Q
        const ctx = this._task.findDeepestContext();
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
                token_limit: opt.token_limit ?? this.sessionConfig.token_limit,
                max_depth: opt.max_depth ?? this.sessionConfig.max_depth,
                max_tool_repetition: opt.max_tool_repetition ?? this.sessionConfig.max_tool_repetition,
                queue_limit: opt.queue_limit ?? this.sessionConfig.queue_limit,
                min_chat_messages: opt.min_chat_messages ?? this.sessionConfig.min_chat_messages,
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

    async closeSession() {
        if (!this._task) return;
        if (this._task.context)
            await this._task.context.close();
        this._task._ecancel();
    }

    // ---- Generic DB access ----

    async dbPutItem(item, table) {
        if (!this._db) return;
        return this._db.put(item, table);
    }

    async dbGetItem(key, value, table) {
        if (!this._db) return;
        const result = await this._db.get(key, value, table);
        return result ? this._deserializeRecord(result) : result;
    }

    async dbDeleteItem(key, value, table) {
        if (!this._db) return;
        return this._db.delete(key, value, table);
    }

    async dbQuery(index, key, value, table) {
        if (!this._db) return;
        const results = await this._db.query(index, key, value, table);
        return Array.isArray(results)
            ? results.map(r => this._deserializeRecord(r))
            : results;
    }

    async dbGetAll(table) {
        if (!this._db) return;
        const results = await this._db.getAll(table);
        return Array.isArray(results)
            ? results.map(r => this._deserializeRecord(r))
            : results;
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

    // ---- DB deserialization hook ----

    /**
     * Override in subclasses to transform raw DB records (e.g. restore class instances).
     * Called by dbGetItem, dbQuery, dbGetAll.
     * @param {Object} raw - Raw record from DB
     * @returns {Object} Transformed record
     */
    _deserializeRecord(raw) { return raw; }

    // ---- Serialization ----

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

    /**
     * Restore a Saico instance from serialized data.
     * @param {string|Object} data - Serialized data (JSON string or object)
     * @param {Object} opt - Options (tool_handler, functions, store, states, etc.)
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
            tool_handler: opt.tool_handler,
            functions: opt.functions || parsed.task?.context?.functions,
            store: opt.store,
            redis: false, // No Redis proxy during deserialization
        });

        instance.tm_create = parsed.tm_create || instance.tm_create;

        // Activate with restored context if task data exists
        if (parsed.task) {
            instance.activate({
                createQ: !!parsed.task.context,
                taskId: parsed.task.id,
                tag: parsed.task.context?.tag,
                chat_history: parsed.task.context?.chat_history,
                tool_handler: opt.tool_handler,
                functions: opt.functions || parsed.task.context?.functions,
                states: opt.states || [],
                ...opt,
            });

            // Restore messages to context
            if (parsed.task.context?.msgs && instance._task.context) {
                instance._task.context._msgs = parsed.task.context.msgs;
            }

            // Restore tool_digest
            if (Array.isArray(parsed.task.context?.tool_digest) && instance._task.context) {
                instance._task.context.tool_digest = parsed.task.context.tool_digest;
            }
        }

        return instance;
    }
}

module.exports = { Saico };
