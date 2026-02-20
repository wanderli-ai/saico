/* itask.js
 *
 * Node.js-only lightweight Etask-like task runner with:
 *     - E.root registry
 *     - named state parsing (try, catch, finally, cancel)
 *     - id generation and ps() debug output
 *     - cooperative cancel via _ecancel()
 *
 * Usage:
 *     const Itask = require('./itask');
 *     const t = new Itask({name:'root'}, [stateFn1, stateFn2_cancel$label]);
 *     await t; // thenable
 */

'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const crypto = require('crypto');
const util = require('./util.js');
const { Store } = require('./store.js');

const { _log, lerr , _ldbg, daysSince, minSince, shallowEqual, filterArray, logEvent } = util;

/* ---------- utility ---------- */
function makeId(len = 12){
    return crypto.randomBytes(Math.ceil(len/2)).toString('hex').slice(0, len);
}

/* ---------- state type parser ---------- */
function parse_state_type(fn){
    // returns { label, try_catch, catch, finally, cancel, sig, aux }
    const type = { label: undefined, try_catch: false, catch: false,
        finally: false, cancel: false, sig: false, aux: false };
    if (!fn || typeof fn.name !== 'string' || fn.name.length === 0){
        return type;
    }
    // original etask used name split by '$' where left side may contain
    // modifiers separated by '_' and right part is label
    const parts = fn.name.split('$');
    if (parts.length === 1){
        type.label = parts[0] || undefined;
    } else {
        if (parts[1].length) type.label = parts[1];
        const left = parts[0].split('_');
        for (let j = 0; j < left.length; j++){
            const f = left[j];
            if (f === 'try'){
                type.try_catch = true;
                if (left[j+1] === 'catch') j++;
            } else if (f === 'catch') {
                type.catch = true;
            } else if (f === 'finally' || f === 'ensure') {
                type.finally = true;
            } else if (f === 'cancel') {
                type.cancel = true;
            } else {
                // unknown token -> ignore (keeps compatibility)
            }
        }
    }
    if (type.catch || type.finally || type.cancel) type.sig = true;
    type.aux = type.catch || type.finally || type.cancel;
    return type;
}

/* ---------- constructor / prototype ---------- */
function Itask(opt, states){
    if (!(this instanceof Itask)){
        if (Array.isArray(opt) || typeof opt === 'function'){
            states = opt;
            opt = {};
        }
        if (typeof opt === 'string') opt = { name: opt };
        if (typeof states === 'function') states = [states];
        return new Itask(opt || {}, states || []);
    }

    EventEmitter.call(this);
    opt = opt || {};
    this.id = makeId(10);
    this.name = opt.name;
    this.cancelable = !!opt.cancel;
    this.info = opt.info || {};
    this.bind = opt.bind; // optional bind context for state functions
    this.funcs = Array.isArray(states) ? states.slice() : [];
    this.states = this.funcs.map(fn => parse_state_type(fn));
    this.cur_state = 0;
    this.running = false;
    this.tm_create = Date.now();
    this.tm_completed = null;
    this.error = undefined;
    this.retval = undefined;
    this.parent = undefined;
    this.child = new Set();
    this._finally_cbs = [];
    this._oncomplete = [];
    this._completed = false;
    this._cancel_state_idx = this.states.findIndex(s => s.cancel);
    this._root_registered = false;

    // Context support - optional conversation context attached to this task
    this.context = null;
    this._contextConfig = opt.contextConfig || {};

    // Storage persistence
    this.context_id = opt.context_id || null;
    this._store = opt.store || Store.instance || null;

    // Store options for context creation (prompt, functions, etc.)
    this.prompt = opt.prompt;
    this.functions = opt.functions;
    this.tool_handler = opt.tool_handler;

    // register root if no explicit spawn_parent provided
    // If opt.spawn_parent provided, spawn under it
    if (opt.spawn_parent && opt.spawn_parent instanceof Itask){
        opt.spawn_parent.spawn(this);
    } else {
        Itask.root.add(this);
        this._root_registered = true;
    }

    // async option defers immediate run
    if (!opt.async){
        process.nextTick(()=> {
            // don't throw, run safely
            try { this._run(); } catch (e){ lerr.perr(e); }
        });
    }
}
Itask.prototype = Object.create(EventEmitter.prototype);
Itask.prototype.constructor = Itask;

/* root registry */
Itask.root = new Set();

/* ---------- core run loop (named-state aware) ---------- */
Itask.prototype._run = async function _run(){
    if (this._completed) return;
    if (this.running) return;
    this.running = true;

    while (!this._completed && this.cur_state < this.funcs.length){
        const fn = this.funcs[this.cur_state];
        const stateInfo = this.states[this.cur_state] || {};
        _ldbg(`[ITASK ${this.name}] Running state ${this.cur_state}: ${stateInfo.label || 'unnamed'}, ` +
            `catch=${stateInfo.catch}, finally=${stateInfo.finally}, cancel=${stateInfo.cancel}`);
        let rv;
        try {
            // Use bind context if provided, otherwise use itask instance
            const context = this.bind || this;
            rv = fn.call(context, this.error || this.retval);
        } catch (err) {
            _ldbg(`[ITASK ${this.name}] State threw synchronously: ${err.message}`);
            this.error = err;
            // on error, advance to appropriate recovery state below
            // do not throw here
        }

        // handle Itask child returned
        if (rv instanceof Itask){
            this.spawn(rv);
            try {
                const res = await rv;
                this.retval = res;
                this.error = undefined;
            } catch (err){
                this.error = err;
            }
            // Handle state advancement
            if (this.error === undefined){
                // advance to next non-aux state
                this.cur_state = this._next_non_aux(this.cur_state);
            } else {
                // Check if this is a cancellation error and we have a cancel state (that we haven't passed yet)
                if (this.error.message === 'cancelled' && this._cancel_state_idx !== -1
                    && this.cur_state < this._cancel_state_idx){
                    this.cur_state = this._cancel_state_idx;
                } else {
                    // on error: find next catch; if none -> complete (finally will still run)
                    const nextErrIdx = this._next_error_handler(this.cur_state);
                    if (nextErrIdx === -1){
                        // no handler; complete
                        break;
                    }
                    this.cur_state = nextErrIdx;
                }
            }
            continue;
        }

        // handle promise-like
        if (rv && typeof rv.then === 'function'){
            _ldbg(`[ITASK ${this.name}] State returned promise, awaiting...`);
            try {
                const res = await rv;
                _ldbg(`[ITASK ${this.name}] Promise resolved successfully`);
                this.retval = res;
                this.error = undefined;
            } catch (err){
                _ldbg(`[ITASK ${this.name}] Promise rejected with: ${err.message}`);
                this.error = err;
            }
            // Handle state advancement
            if (this.error === undefined){
                // advance to next non-aux state
                this.cur_state = this._next_non_aux(this.cur_state);
            } else {
                // Check if this is a cancellation error and we have a cancel state (that we haven't passed yet)
                if (this.error.message === 'cancelled' && this._cancel_state_idx !== -1
                    && this.cur_state < this._cancel_state_idx){
                    this.cur_state = this._cancel_state_idx;
                } else {
                    // on error: find next catch; if none -> complete (finally will still run)
                    const nextErrIdx = this._next_error_handler(this.cur_state);
                    if (nextErrIdx === -1){
                        // no handler; complete
                        break;
                    }
                    this.cur_state = nextErrIdx;
                }
            }
            continue;
        }

        // synchronous value
        if (stateInfo.catch)
            this.error = undefined;
        // Cancel state clears the error after handling (like catch does)
        if (stateInfo.cancel)
            this.error = undefined;
        if (this.error === undefined){
            this.retval = rv;
            // advance to next non-aux state
            this.cur_state = this._next_non_aux(this.cur_state);
        } else {
            // Check if this is a cancellation error and we have a cancel state (that we haven't passed yet)
            if (this.error.message === 'cancelled' && this._cancel_state_idx !== -1
                && this.cur_state < this._cancel_state_idx){
                this.cur_state = this._cancel_state_idx;
            } else {
                // on error: find next catch; if none -> complete (finally will still run)
                const nextErrIdx = this._next_error_handler(this.cur_state);
                if (nextErrIdx === -1){
                    // no handler; complete
                    break;
                }
                this.cur_state = nextErrIdx;
            }
        }
        // loop continues
    }

    // finished loop -> execute finally state if exists (always runs)
    const finallyIdx = this.states.findIndex(s => s.finally);
    _ldbg(`[ITASK ${this.name}] Finished main loop, finallyIdx=${finallyIdx}, e=${this.error?.message}`);
    if (finallyIdx !== -1 && !this._completed)
    {
        _ldbg(`[ITASK ${this.name}] Running finally state`);
        const fn = this.funcs[finallyIdx];
        try
        {
            // Use bind context if provided, otherwise use itask instance
            const context = this.bind || this;
            const rv = fn.call(context, this.error || this.retval);
            if (rv instanceof Itask)
            {
                this.spawn(rv);
                await rv;
            }
            else if (rv && typeof rv.then === 'function')
                await rv;
            _ldbg(`[ITASK ${this.name}] Finally state completed`);
        }
        catch (err)
        {
            _ldbg(`[ITASK ${this.name}] Finally state threw: ${err.message}`);
            // finally errors override existing error
            this.error = err;
        }
    }

    // Wait for all children to complete first (bottom-up completion)
    if (this.child && this.child.size > 0) {
        _ldbg(`[ITASK ${this.name}] Waiting for ${this.child.size} children to complete`);
        const children = Array.from(this.child);
        try {
            // Wait for children with a configurable timeout (default 5000ms)
            const timeoutMs = this.child_completion_timeout ?? 5000;
            const childPromises = children.map(c => new Promise((resolve) => {
                if (c._completed) {
                    resolve();
                } else {
                    c._oncomplete.push(() => resolve());
                }
            }));
            const timeout = new Promise((resolve) => setTimeout(() => {
                _ldbg(`[ITASK ${this.name}] Timeout waiting for children after ${timeoutMs}ms, forcing completion`);
                resolve();
            }, timeoutMs));
            await Promise.race([Promise.all(childPromises), timeout]);
        } catch (e) { lerr.perr(e); }
        _ldbg(`[ITASK ${this.name}] Done waiting for children`);
    }

    // complete - error will propagate to parent if uncaught
    _ldbg(`[ITASK ${this.name}] Calling _complete_internal, e=${this.error?.message}`);
    this._complete_internal();
};

// find next index > cur that is NOT aux (aux = catch/finally/cancel)
Itask.prototype._next_non_aux = function _next_non_aux(cur){
    let i = cur + 1;
    while (i < this.states.length && (this.states[i].catch || this.states[i].finally || this.states[i].cancel)) i++;
    return i;
};

// on error, find next catch state that handles error
Itask.prototype._next_error_handler = function _next_error_handler(cur){
    for (let i = cur + 1; i < this.states.length; i++){
        if (this.states[i].catch) return i;
    }
    return -1;
};

/* ---------- finalization ---------- */
Itask.prototype._complete_internal = function _complete_internal(){
    if (this._completed) return;
    _ldbg(`[ITASK ${this.name}] _complete_internal called, e=${this.error?.message}`);
    this._completed = true;
    this.tm_completed = Date.now();
    this.running = false;

    // run finally callbacks
    try {
        const context = this.bind || this;
        for (const cb of this._finally_cbs){
            try { cb.call(context, this.error, this.retval); } catch (e){ lerr.perr(e); }
        }
    } catch (e){ lerr.perr(e); }

    // emit event
    try { this.emit('finally', this.error, this.retval); } catch (e){ lerr.perr(e); }

    // notify promise consumers
    for (const cb of this._oncomplete){
        try { cb(this.error, this.retval); } catch (e){ lerr.perr(e); }
    }

    // remove from parent's child set
    if (this.parent) {
        this.parent.child.delete(this);
    }

    // cleanup from root registry if present and no parent
    if (this._root_registered && this.parent === undefined){
        Itask.root.delete(this);
        this._root_registered = false;
    }
};

/* ---------- spawn / parent-child ---------- */
Itask.prototype.spawn = function spawn(child){
    if (!child) return;
    if (child instanceof Itask){
        // attach as child
        if (child.parent && child.parent !== this){
            child.parent.child.delete(child);
        }
        child.parent = this;
        this.child.add(child);
        // if child was previously registered as root, remove it
        if (child._root_registered){
            Itask.root.delete(child);
            child._root_registered = false;
        }
        // Auto-wrap with redis observable for live state persistence
        if (child.context_id) {
            try {
                const redis = require('./redis.js');
                if (redis.rclient) {
                    redis.createObservableForRedis('saico:' + child.context_id, child);
                }
            } catch (e) { /* redis not available */ }
        }
        // ensure async-created children begin execution
        if (!child.running && !child._completed){
            process.nextTick(() => {
                try { child._run(); } catch (e){ lerr.perr(e); }
            });
        }
        return child;
    }
    if (typeof child.then === 'function'){
        // wrap promise into an Itask
        const wrap = new Itask({ name: 'promise-wrap', cancel: false }, [function(){ return child; }]);
        this.spawn(wrap);
        return wrap;
    }
    throw new Error('spawn accepts Itask or Promise-like');
};

/* ---------- cancellation (cooperative) ---------- */
Itask.prototype._ecancel = function _ecancel(arg){
    _ldbg(`[ITASK ${this.name}] _ecancel called, running=${this.running}, completed=${this._completed}, ` +
        `cancel_state_idx=${this._cancel_state_idx}`);
    this.cancel_arg = arg;
    // if cancel state exists, jump to it
    if (!this._completed){
        this.error = new Error('cancelled');
        _ldbg(`[ITASK ${this.name}] Set error to 'cancelled'`);
        if (this._cancel_state_idx !== -1){
            // ensure next iteration runs the cancel state
            this.cur_state = Math.max(0, this._cancel_state_idx);
            _ldbg(`[ITASK ${this.name}] Jumped to cancel state at index ${this.cur_state}`);
        }
        // if task is waiting on wait(), reject to unblock it
        this._cancel_wait(this.error);
        _ldbg(`[ITASK ${this.name}] Called _cancel_wait`);
    }
    // cancel children
    this._ecancel_child();
    // if idle (not running) finalize
    if (!this.running) {
        _ldbg(`[ITASK ${this.name}] Task not running, will complete after children`);
        // Wait for children to complete, then call _complete_internal
        setImmediate(async () => {
            if (this.child && this.child.size > 0) {
                _ldbg(`[ITASK ${this.name}] Waiting for ${this.child.size} children to complete`);
                const children = Array.from(this.child);
                try {
                    // Wait for children with a configurable timeout (default 5000ms)
                    const timeoutMs = this.child_completion_timeout ?? 5000;
                    const childPromises = children.map(c => new Promise((resolve) => {
                        if (c._completed) {
                            resolve();
                        } else {
                            c._oncomplete.push(() => resolve());
                        }
                    }));
                    const timeout = new Promise((resolve) => setTimeout(() => {
                        _ldbg(`[ITASK ${this.name}] Timeout waiting for children after ${timeoutMs}ms, `+
                            `forcing completion`);
                        resolve();
                    }, timeoutMs));
                    await Promise.race([Promise.all(childPromises), timeout]);
                } catch (e) { lerr.perr(e); }
                _ldbg(`[ITASK ${this.name}] Done waiting for children`);
            }
            this._complete_internal();
        });
    } else {
        _ldbg(`[ITASK ${this.name}] Task still running, will complete naturally`);
    }
};

Itask.prototype._ecancel_child = function _ecancel_child(){
    if (!this.child || !this.child.size) return;
    const children = Array.from(this.child);
    for (const c of children){
        try { c._ecancel(); } catch (e){ lerr.perr(e); }
    }
};

/* ---------- thenable / promise interop ---------- */
Itask.prototype.then = function then(onRes, onErr){
    return new Promise((resolve, reject) => {
        if (this._completed){
            return this.error ? reject(this.error) : resolve(this.retval);
        }
        this._oncomplete.push((err, res) => {
            if (err) return reject(err);
            return resolve(res);
        });
    }).then(onRes, onErr);
};
Itask.prototype.catch = function(onErr){ return this.then(undefined, onErr); };
Itask.prototype.finally = function finally_(cb, name){
    if (typeof cb === 'function'){
        if (this._completed) {
            const context = this.bind || this;
            try { cb.call(context, this.error, this.retval); } catch (e){ lerr.perr(e); }
        } else {
            this._finally_cbs.push(cb);
        }
    }
    return this;
};

/* ---------- utilities ---------- */
Itask.sleep = function sleep(ms){
    return new Itask({ name: 'sleep', cancel: true }, [function(){
        return new Promise((resolve) => {
            const t = setTimeout(() => resolve(), ms);
            this.finally(()=> clearTimeout(t));
        });
    }]);
};

Itask.all = function all(arr){
    if (!Array.isArray(arr)) throw new Error('Itask.all expects array');
    return new Itask({ name: 'all', cancel: true }, [function(){
        const tasks = arr.map(x => (x instanceof Itask) ? x : new Itask({ name: 'wrap' }, [function(){ return x; }]));
        for (const t of tasks) this.spawn(t);
        return Promise.all(tasks.map(t => t));
    }]);
};

/* ---------- convenience: external completion ---------- */
Itask.prototype.return = function(ret){
    if (this._completed) return this;
    this.retval = ret;
    this.error = undefined;
    this._complete_internal();
    return this;
};
Itask.prototype.throw = function(err){
    if (this._completed) return this;
    this.error = (err instanceof Error) ? err : new Error(String(err));
    this._complete_internal();
    return this;
};
Itask.prototype.wait = function(){
    return new Promise((resolve, reject) => {
        this._continue_resolve = resolve;
        this._continue_reject = reject;
    });
};
Itask.prototype._cancel_wait = function(err){
    if (this._continue_reject){
        _ldbg(`[ITASK ${this.name}] _cancel_wait: rejecting pending wait() with error`);
        const reject = this._continue_reject;
        this._continue_resolve = null;
        this._continue_reject = null;
        reject(err || new Error('cancelled'));
    } else if (this._continue_resolve){
        _ldbg(`[ITASK ${this.name}] _cancel_wait: resolving pending wait() with undefined`);
        const resolve = this._continue_resolve;
        this._continue_resolve = null;
        this._continue_reject = null;
        resolve(undefined);
    } else {
        _ldbg(`[ITASK ${this.name}] _cancel_wait: no pending wait()`);
    }
};
Itask.prototype.continue = function(ret){
    if (this._completed)
        return this;
    this.retval = ret;
    this.error = undefined;
    if (this._continue_resolve)
    {
        const resolve = this._continue_resolve;
        this._continue_resolve = null;
        this._continue_reject = null;
        resolve(ret);
    }
    return this;
};

/* ---------- introspection / ps ---------- */
Itask.prototype.is_running = function(){ return this.running && !this._completed; };
Itask.prototype.is_completed = function(){ return this._completed; };
Itask.prototype.shortname = function(){ return this.name || ('itask#'+this.id); };

Itask.prototype._ps_lines = function(prefix, last){
    const parts = [];
    const marker = last ? '\\_ ' : '|\\_ ';
    const own = prefix + (last ? '\\_ ' : '|\\_ ') + this.shortname() +
        (this._completed ? ' (done)' : '') + ' [' + this.id + ']';
    parts.push(own);
    const kids = Array.from(this.child);
    for (let i = 0; i < kids.length; i++){
        const isLast = i === kids.length - 1;
        const child = kids[i];
        const childPrefix = prefix + (last ? '   ' : '|   ');
        parts.push(...child._ps_lines(childPrefix, isLast));
    }
    return parts;
};

Itask.ps = function ps(){
    let out = '';
    const roots = Array.from(Itask.root);
    for (let i = 0; i < roots.length; i++){
        const r = roots[i];
        const lines = r._ps_lines('', i === roots.length - 1);
        out += lines.join('\n') + (i < roots.length - 1 ? '\n' : '');
    }
    return out || '<no roots>';
};

/* ---------- context management ---------- */
// [BACKEND] explanation text appended to context prompts
Itask.BACKEND_EXPLANATION = '\nNote: Messages prefixed with [BACKEND] are from the backend ' +
    'server, not the user. They contain server instructions, data updates, or system context. ' +
    'Treat them as authoritative system-level information.';

// Get the context for this task, optionally creating one if needed
Itask.prototype.getContext = function getContext(createIfMissing = false){
    if (this.context)
        return this.context;
    if (createIfMissing && this.prompt){
        // Lazy context creation - requires Context class to be set
        if (Itask.Context){
            const augmentedPrompt = this.prompt + Itask.BACKEND_EXPLANATION;
            this.context = new Itask.Context(augmentedPrompt, this, this._contextConfig);
            this.setContext(this.context);
            return this.context;
        }
    }
    return null;
};

// Set context for this task
Itask.prototype.setContext = function setContext(context){
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
            context.setTask(this);
    }
    return this;
};

// Get all ancestor contexts (walking up the task hierarchy)
Itask.prototype.getAncestorContexts = function getAncestorContexts(){
    const contexts = [];
    let task = this;
    while (task){
        if (task.context)
            contexts.unshift(task.context); // Add to front so ancestors come first
        task = task.parent;
    }
    return contexts;
};

// Find the nearest context in the hierarchy (this task or ancestors)
Itask.prototype.findContext = function findContext(){
    let task = this;
    while (task){
        if (task.context)
            return task.context;
        task = task.parent;
    }
    return null;
};

// Send a backend message using the context hierarchy
// New signature: sendMessage(content, functions, opts)
// Always sends as role='user' with '[BACKEND] ' prefix
Itask.prototype.sendMessage = async function sendMessage(content, functions, opts){
    // First try our own context
    let ctx = this.getContext();
    if (!ctx){
        // Walk up to find a context
        ctx = this.findContext();
    }
    if (!ctx){
        throw new Error('No context available in task hierarchy to send message');
    }
    opts = Object.assign({}, opts, { tag: this.context_id });
    return ctx.sendMessage('user', '[BACKEND] ' + content, functions, opts);
};

// Receive a user chat message (no [BACKEND] prefix)
Itask.prototype.recvChatMessage = async function recvChatMessage(content, opts){
    let ctx = this.getContext();
    if (!ctx){
        ctx = this.findContext();
    }
    if (!ctx){
        throw new Error('No context available in task hierarchy to receive message');
    }
    opts = Object.assign({}, opts, { tag: this.context_id });
    return ctx.sendMessage('user', content, null, opts);
};

// Aggregate functions from all contexts in the hierarchy
Itask.prototype.getHierarchyFunctions = function getHierarchyFunctions(){
    const allFunctions = [];
    const contexts = this.getAncestorContexts();
    for (const ctx of contexts){
        if (ctx.functions && Array.isArray(ctx.functions))
            allFunctions.push(...ctx.functions);
    }
    // Add this task's own functions if not already in a context
    if (this.functions && !this.context)
        allFunctions.push(...this.functions);
    return allFunctions;
};

// Close this task's context (if any) and bubble summary to parent
Itask.prototype.closeContext = async function closeContext(){
    if (!this.context)
        return;

    // Clean tool call messages tagged with this context_id
    if (this.context_id && typeof this.context.cleanToolCallsByTag === 'function')
        this.context.cleanToolCallsByTag(this.context_id);

    // Filter out tool calls and [BACKEND] messages, compress remaining as chat_history
    const cleanedMsgs = this.context._msgs.filter(m => {
        if (m.msg.tool_calls)
            return false;
        if (m.msg.role === 'tool')
            return false;
        if (typeof m.msg.content === 'string' && m.msg.content.startsWith('[BACKEND]'))
            return false;
        return true;
    }).map(m => m.msg);

    if (cleanedMsgs.length > 0) {
        const chat_history = await util.compressMessages(cleanedMsgs);
        this.context.chat_history = chat_history;

        // Persist to store
        const store = this._store || Store.instance;
        if (store && this.context_id) {
            await store.save(this.context_id, {
                chat_history,
                prompt: this.context.prompt,
                tag: this.context.tag,
                tm_closed: Date.now()
            });
        }
    }

    await this.context.close();
};

// Reference to Context class (set by index.js to avoid circular dependency)
Itask.Context = null;

/* ---------- export ---------- */
module.exports = Itask;

/* ---------- notes ----------
 * - Named states: function names can carry modifiers and labels:
 *     e.g. function try_catch$mylabel(){}  -> parsed as try_catch with label mylabel
 *     supported modifiers: try, catch, finally, cancel
 * - _ecancel() will attempt to jump to a cancel state if declared; otherwise it
 *   sets error='cancelled' and propagates cancellation to children.
 * - Itask.root contains root tasks (tasks with no parent).
 * - ps() returns a readable hierarchical snapshot for debugging.
 */
