'use strict';

const crypto = require('crypto');
const openai = require('./openai.js');
const util = require('./util.js');

const { _log, _lerr, _ldbg } = util;
const debug = 0;

/**
 * Context - Conversation context that can be attached to any Itask.
 *
 * Key differences from the old Messages class:
 * - Uses task hierarchy instead of parent/child messages
 * - task reference replaces parent reference
 * - getMsgContext() traverses task hierarchy
 * - _createMsgQ() aggregates from task ancestors
 */
class Context {
    constructor(prompt, task, config = {}) {
        this.prompt = prompt;
        this.task = task; // Reference to owning Itask (replaces parent)
        this.tag = config.tag || crypto.randomBytes(4).toString('hex');
        this.token_limit = config.token_limit || 1000000000;
        this.lower_limit = this.token_limit * 0.85;
        this.upper_limit = this.token_limit * 0.98;
        this.tool_handler = config.tool_handler || task?.tool_handler;
        this.functions = config.functions || task?.functions || null;

        // Recursive depth and repetition control
        this.max_depth = config.max_depth || 5;
        this.max_tool_repetition = config.max_tool_repetition || 20;
        this._current_depth = 0;
        this._deferred_tool_calls = [];
        this._tool_call_sequence = [];

        // Chat history persistence
        this.chat_history = config.chat_history || null;

        this._msgs = [];
        this._waitingQueue = [];
        this._active_tool_calls = new Map();

        // Sequential mode support
        this._sequential_queue = [];
        this._processing_sequential = false;
        this._sequential_mode = config.sequential_mode || false;

        // Initialize messages if provided
        (config.msgs || []).forEach(m => this.push(m));

        _log('created Context for tag', this.tag);
    }

    // Set the task reference (used when context is created separately)
    setTask(task) {
        this.task = task;
        if (!this.tool_handler)
            this.tool_handler = task?.tool_handler;
        if (!this.functions)
            this.functions = task?.functions;
    }

    // Get the parent context by traversing task hierarchy
    getParentContext() {
        if (!this.task || !this.task.parent)
            return null;
        return this.task.parent.findContext ? this.task.parent.findContext() : null;
    }

    // Get all ancestor contexts via task hierarchy
    getAncestorContexts() {
        if (!this.task)
            return [];
        return this.task.getAncestorContexts().filter(ctx => ctx !== this);
    }

    _hasPendingToolCalls() {
        const toolCallMsgs = this._msgs.filter(m => m.msg.tool_calls);

        for (const toolCallMsg of toolCallMsgs) {
            const toolCalls = toolCallMsg.msg.tool_calls;
            const toolCallIds = toolCalls.map(tc => tc.id);

            const toolReplies = this._msgs.filter(m =>
                m.msg.role === 'tool' &&
                toolCallIds.includes(m.msg.tool_call_id)
            );

            const repliedCallIds = new Set(toolReplies.map(r => r.msg.tool_call_id));
            const deferredCallIds = new Set(this._deferred_tool_calls.map(d => d.call.id));
            const unRepliedCalls = toolCalls.filter(tc =>
                !repliedCallIds.has(tc.id) && !deferredCallIds.has(tc.id)
            );

            if (unRepliedCalls.length > 0)
                return true;
        }

        return false;
    }

    _processWaitingQueue() {
        _log('Processing waiting queue,', this._waitingQueue.length, 'messages waiting');

        this._waitingQueue.forEach(waitingMessage => {
            _log('Adding queued message to queue:', waitingMessage.role,
                waitingMessage.content?.slice(0, 50));
            this._createMsgObj(
                waitingMessage.role,
                waitingMessage.content,
                waitingMessage.functions,
                waitingMessage.opts
            );
        });

        this._waitingQueue = [];
    }

    async _processSequentialQueue() {
        if (this._processing_sequential || this._sequential_queue.length === 0)
            return;

        _ldbg('[' + this.tag + '] Starting sequential queue processing');
        this._processing_sequential = true;

        try {
            while (this._sequential_queue.length > 0) {
                const queuedMsg = this._sequential_queue.shift();
                _ldbg('Processing sequential message:', queuedMsg.role,
                    queuedMsg.content?.slice(0, 50));

                try {
                    const result = await this._sendMessageInternal(
                        queuedMsg.role,
                        queuedMsg.content,
                        queuedMsg.functions,
                        queuedMsg.opts
                    );

                    if (queuedMsg.resolve)
                        queuedMsg.resolve(result);
                } catch (err) {
                    if (queuedMsg.reject)
                        queuedMsg.reject(err);
                    else
                        _lerr('Error processing queued message:', err);
                }
            }
            _ldbg('[' + this.tag + '] Sequential queue processing completed');
        } catch (err) {
            _lerr('Error processing sequential queue:', err);
        } finally {
            _ldbg('[' + this.tag + '] Setting _processing_sequential = false');
            this._processing_sequential = false;
        }
    }

    _trackToolCall(toolName) {
        this._tool_call_sequence.push(toolName);

        if (this._tool_call_sequence.length > this.max_tool_repetition * 2) {
            this._tool_call_sequence = this._tool_call_sequence.slice(-this.max_tool_repetition);
        }
    }

    _shouldDropToolCall(toolName) {
        if (this._tool_call_sequence.length < this.max_tool_repetition)
            return false;

        let consecutiveCount = 0;
        for (let i = this._tool_call_sequence.length - 1; i >= 0; i--) {
            if (this._tool_call_sequence[i] === toolName) {
                consecutiveCount++;
            } else {
                break;
            }
        }

        return consecutiveCount >= this.max_tool_repetition;
    }

    _resetToolSequenceIfDifferent(newToolNames) {
        if (!newToolNames || newToolNames.length === 0) {
            this._tool_call_sequence = [];
            return;
        }

        const lastTool = this._tool_call_sequence[this._tool_call_sequence.length - 1];
        if (!lastTool || !newToolNames.includes(lastTool)) {
            this._tool_call_sequence = [];
        }
    }

    _filterExcessiveToolCalls(toolCalls) {
        if (!toolCalls || toolCalls.length === 0) return toolCalls;

        return toolCalls.filter(call => {
            const toolName = call.function.name;
            if (this._shouldDropToolCall(toolName)) {
                _log('Dropping excessive tool call:', toolName,
                    '(hit max_tool_repetition=' + this.max_tool_repetition + ')');
                return false;
            }
            return true;
        });
    }

    async _processDeferredToolCalls() {
        if (this._deferred_tool_calls.length === 0) return;

        _log('Processing deferred tool calls:', this._deferred_tool_calls.length);

        const deferredCalls = [...this._deferred_tool_calls];
        this._deferred_tool_calls = [];

        const callsByMessage = new Map();
        for (const deferred of deferredCalls) {
            const key = deferred.originalMessage.msgid;
            if (!callsByMessage.has(key)) {
                callsByMessage.set(key, []);
            }
            callsByMessage.get(key).push(deferred);
        }

        for (const [msgid, deferredGroup] of callsByMessage) {
            _log('Processing deferred group for message', msgid + ':', deferredGroup.length, 'calls');

            const toolCalls = deferredGroup.map(d => d.call);
            const toolNames = toolCalls.map(call => call.function.name);
            this._resetToolSequenceIfDifferent(toolNames);

            const filteredToolCalls = this._filterExcessiveToolCalls(toolCalls);

            let reply2 = {};
            for (const [i, call] of filteredToolCalls.entries()) {
                const toolName = call.function.name;
                this._trackToolCall(toolName);

                let result;

                if (this._isDuplicateToolCall(call)) {
                    _log('Duplicate deferred tool call detected:', call.function.name);
                    result = {
                        content: `Duplicate call detected. An identical "${call.function.name}" ` +
                            `tool call with the same arguments is already running.`,
                        functions: null
                    };
                } else {
                    this._trackActiveToolCall(call);

                    try {
                        const correspondingDeferred = deferredGroup.find(d => d.call.id === call.id);
                        const handler = correspondingDeferred?.originalMessage.opts.handler || this.tool_handler;
                        const timeout = correspondingDeferred?.originalMessage.opts.timeout;

                        result = await this._executeToolCallWithTimeout(call, handler, timeout);
                    } finally {
                        this._completeActiveToolCall(call);
                    }
                }

                const correspondingDeferred = deferredGroup.find(d => d.call.id === call.id);
                const opts = {
                    name: call.function.name,
                    tool_call_id: call.id,
                    _recursive_depth: 1,
                    model: correspondingDeferred?.originalMessage.opts.model
                };
                const content = result ? (result.content || result) : '';
                const functions = (i === filteredToolCalls.length - 1 && result && result.functions)
                    ? result.functions : null;

                if (i === filteredToolCalls.length - 1) {
                    reply2 = await this.sendMessage('tool', content, functions, opts);
                } else {
                    const toolResponse = this._createMsgObj('tool', content, null, opts);
                    toolResponse.replied = 1;
                    this._insertToolResponseAtCorrectPosition(toolResponse, call.id);
                }
            }
        }
    }

    get messages() {
        return this.__msgs;
    }

    set messages(value) {
        if (Array.isArray(value)) {
            this._msgs = value.map(m => m.msg ? m : {msg: m, opts: {}, replied: 1});
        } else {
            throw new Error("messages must be assigned an array");
        }
    }

    push(msg) {
        const m = {msg: msg.msg || msg, opts: msg.opts || {}, msgid: msg.msgid || 0, replied: msg.replied || 2};
        return this._msgs.push(m);
    }

    pushSummary(summary) {
        const idx = this.push({role: 'user', content: '[SUMMARY]: ' + summary});
        this._msgs[idx - 1].opts.summary = true;
    }

    toJSON() {
        return this.__msgs;
    }

    filter(callback) {
        return this.__msgs.filter(callback);
    }

    concat(arr) {
        return this.__msgs.concat(arr);
    }

    slice(start, end) {
        return this.__msgs.slice(start, end);
    }

    reverse() {
        this._msgs.reverse();
        return this;
    }

    [Symbol.iterator]() {
        return (function* () {
            for (const item of this._msgs) {
                yield item.msg;
            }
        }).call(this);
    }

    get __msgs() { return this._msgs.map(m => m.msg); }

    get length() {
        return this._msgs.length;
    }

    serialize() { return JSON.stringify(this._msgs); }

    getSummaries() { return this._msgs.filter(m => m.opts.summary); }

    // Get functions aggregated from this context and all ancestor contexts
    getFunctions() {
        const allFunctions = [];

        // Get functions from ancestor contexts via task hierarchy
        const ancestorContexts = this.getAncestorContexts();
        for (const ctx of ancestorContexts) {
            if (ctx.functions && Array.isArray(ctx.functions))
                allFunctions.push(...ctx.functions);
        }

        // Add our own functions
        if (this.functions && Array.isArray(this.functions))
            allFunctions.push(...this.functions);

        return allFunctions.length > 0 ? allFunctions : null;
    }

    async summarizeMessages() {
        const tokens = util.countTokens(this.__msgs);
        if (tokens < this.lower_limit)
            return;
        await this._summarizeContext();
    }

    async close() {
        _log('Closing Context tag', this.tag);

        if (this._sequential_mode && this._processing_sequential) {
            _ldbg('Sequential mode: waiting for current message to complete before closing tag', this.tag);
            let waitCount = 0;
            while (this._processing_sequential) {
                await new Promise(resolve => setTimeout(resolve, 100));
                waitCount++;
                if (waitCount % 10 === 0)
                    _ldbg('Sequential mode: still waiting for tag', this.tag, 'after', waitCount, 'iterations');
            }
        }

        // Move waiting messages to parent context via task hierarchy
        const parentCtx = this.getParentContext();
        if (parentCtx && this._waitingQueue.length > 0) {
            _log('Moving', this._waitingQueue.length, 'waiting messages to parent context');
            parentCtx._waitingQueue.push(...this._waitingQueue);
            this._waitingQueue = [];
        }

        if (parentCtx && this._sequential_queue.length > 0) {
            _log('Moving', this._sequential_queue.length, 'sequential queue messages to parent context');
            parentCtx._sequential_queue.push(...this._sequential_queue);
            this._sequential_queue = [];
        }

        await this._summarizeContext(true, parentCtx);
        _log('Finished closing Context tag', this.tag);
    }

    // Load chat history from store into message queue
    async loadHistory(store) {
        if (!store || !this.tag)
            return;
        const data = await store.load(this.tag);
        if (!data || !data.chat_history)
            return;
        const messages = await util.decompressMessages(data.chat_history);
        if (!Array.isArray(messages) || messages.length === 0)
            return;
        // Find the index after the last system message to insert history
        let insertIdx = 0;
        for (let i = 0; i < this._msgs.length; i++) {
            if (this._msgs[i].msg.role === 'system')
                insertIdx = i + 1;
        }
        const historyMsgs = messages.map(m => ({
            msg: m,
            opts: {},
            msgid: crypto.randomBytes(2).toString('hex'),
            replied: 1
        }));
        this._msgs.splice(insertIdx, 0, ...historyMsgs);
    }

    // Remove tool-related messages tagged with a specific tag
    cleanToolCallsByTag(tag) {
        this._msgs = this._msgs.filter(m => {
            if (m.opts.tag !== tag)
                return true;
            if (m.msg.tool_calls)
                return false;
            if (m.msg.role === 'tool')
                return false;
            return true;
        });
    }

    async _summarizeContext(close, targetCtx) {
        const keep = this._msgs.filter(m => !close && m.summary);
        const summarize = this._msgs.filter(m => (!close || !m.summary) && m.replied);
        const not_replied = this._msgs.filter(m => !m.replied);
        _ldbg('Start summarize messages. # messages', summarize.length, '(total msgs:', this._msgs.length + ')');

        if (!summarize.length) {
            _ldbg('[' + this.tag + '] No messages to summarize');
            return;
        }

        const msgs = (close ? [{role: 'system', content: this.prompt}] : []).concat(summarize.map(m => m.msg));
        const summary = await this._summarizeMessages(msgs);
        this._msgs = keep;

        if (summary) {
            if (close && targetCtx)
                targetCtx.pushSummary(summary);
            else
                this.pushSummary(summary);
        }

        this._msgs.push(...not_replied);
        _log('Summarized', this.tag, '(close', close + ') conversation to', util.countTokens(this.__msgs),
            'tokens # messages', this._msgs.length);
    }

    async _summarizeMessages(msgs) {
        let chunks = [msgs];
        const tokens = util.countTokens(chunks[0]);

        if (tokens > this.upper_limit) {
            chunks = [];
            let chunk_msgs = [];
            let chunk = '';

            msgs.forEach(m => {
                if (typeof m !== 'object' || Array.isArray(m))
                    return _lerr('discarding msg with corrupt structure', m);
                const keys = Object.keys(m);
                for (const k of keys) {
                    if (!['role', 'content', 'refusal', 'name', 'tool', 'tool_calls'].includes(k))
                        return _lerr('discarding msg with corrupt key', k);
                }
                if (util.countTokens(m) > this.upper_limit)
                    return _lerr('discard abnormal size message', tokens, 'tokens\n' + m.content?.slice(0, 1500));
                if (m.function)
                    m.content = '<function data>';
                const str = `${m.role.toUpperCase()}: ${m.content || JSON.stringify(m.tool_calls)}`;
                if (util.countTokens(chunk + str + '\n') < this.token_limit / 2) {
                    chunk += str + '\n';
                    chunk_msgs.push(m);
                } else {
                    chunks.push(chunk_msgs);
                    chunk = '';
                    chunk_msgs = [];
                }
            });
            if (chunk_msgs.length)
                chunks.push(chunk_msgs);
        }

        if (!chunks.length)
            return _log('No msgs for summary found');

        _log('Summarizing messages. tokens', tokens, 'messages', msgs.length, 'using', chunks.length, 'chunks');

        let reply = await openai.send([{role: 'system', content:
            'Please summarize the following conversation. The summary should be one or two paragraphs as follows:' +
            '- First paragraph: the purpose of the conversation and the outcome' +
            '- Second paragraph (optional): next steps or pending requests that should be considered' +
            '- Do not include system errors in the summary.\n' +
            '- Formulate the summary from the AI agent\'s perspective\n' +
            '\nConversation:\n' +
            (chunks.length > 1 ? 'The conversation will be uploaded in ' + chunks.length +
                ' chunks. Wait for the last one then summarize all.\nChunk 1:\n'
                : 'The conversation to summarize:\n') + JSON.stringify(chunks[0])}]);

        let summary = reply.content;
        for (let i = 1; i < chunks.length; i++) {
            reply = await openai.send([{role: 'system', content:
                'Chunk ' + (i === chunks.length ? 'last' : i) + ':\n' + JSON.stringify(chunks[i])}]);
            summary = 'Summary of ' + this.tag + ' conversation:\n' + reply.content;
        }
        return summary;
    }

    // Get message context - walks up task hierarchy to collect prompts and summaries
    getMsgContext(add_tag) {
        const msgs = [];

        // Get context from ancestor tasks via task hierarchy
        const ancestorContexts = this.getAncestorContexts();
        for (const ctx of ancestorContexts) {
            if (ctx.prompt)
                msgs.push({role: 'system', content: ctx.prompt});
            // Add summaries from ancestor contexts
            const summaries = ctx._msgs.filter(m => m.opts.summary || m.msg.role === 'system').map(m => {
                if (add_tag)
                    m.msg.tag = ctx.tag;
                return m.msg;
            });
            msgs.push(...summaries);
        }

        // Add this context's prompt
        if (this.prompt)
            msgs.push({role: 'system', content: this.prompt});

        // Add this context's summaries
        const mySummaries = this._msgs.filter(m => m.opts.summary || m.msg.role === 'system').map(m => {
            if (add_tag)
                m.msg.tag = this.tag;
            return m.msg;
        });

        return msgs.concat(mySummaries);
    }

    _createMsgObj(role, content, functions, opts) {
        const name = opts?.name;
        const tool_call_id = opts?.tool_call_id;
        const msg = { role, content, ...(name && { name }), ...(tool_call_id && { tool_call_id }) };
        const msgid = crypto.randomBytes(2).toString('hex');
        const o = {msg, opts: opts || {}, functions, msgid, replied: 0};
        this._msgs.forEach(m => m.opts.noreply ||= !m.replied);
        this._msgs.push(o);
        return o;
    }

    _insertToolResponseAtCorrectPosition(toolResponseObj, tool_call_id) {
        let insertIndex = -1;
        let originalInsertIndex = -1;

        for (let i = this._msgs.length - 1; i >= 0; i--) {
            const msg = this._msgs[i];
            if (msg.msg.tool_calls) {
                const hasMatchingCall = msg.msg.tool_calls.some(call => call.id === tool_call_id);
                if (hasMatchingCall) {
                    if (insertIndex === -1)
                        insertIndex = i + 1;

                    if (msg.msg.content !== 'Processing deferred tool calls') {
                        originalInsertIndex = i + 1;
                        break;
                    }
                }
            }
        }

        const finalInsertIndex = originalInsertIndex !== -1 ? originalInsertIndex : insertIndex;

        if (finalInsertIndex !== -1 && finalInsertIndex < this._msgs.length) {
            const lastIndex = this._msgs.length - 1;
            if (this._msgs[lastIndex] === toolResponseObj) {
                this._msgs.pop();
                this._msgs.splice(finalInsertIndex, 0, toolResponseObj);
            }
        }
    }

    _getToolCallKey(call) {
        return `${call.function.name}:${call.function.arguments}`;
    }

    _isDuplicateToolCall(call) {
        const key = this._getToolCallKey(call);
        return this._active_tool_calls.has(key);
    }

    _trackActiveToolCall(call) {
        const key = this._getToolCallKey(call);
        this._active_tool_calls.set(key, {
            call_id: call.id,
            started_at: Date.now(),
            function_name: call.function.name
        });
        _log('Tracking active tool call:', key);
    }

    _completeActiveToolCall(call) {
        const key = this._getToolCallKey(call);
        if (this._active_tool_calls.has(key)) {
            this._active_tool_calls.delete(key);
            _log('Completed active tool call:', key);
        }
    }

    async _executeToolCallWithTimeout(call, handler, customTimeoutMs = null) {
        const timeoutMs = customTimeoutMs || 5000;

        return new Promise(async (resolve) => {
            let timeoutId;
            let completed = false;

            timeoutId = setTimeout(() => {
                if (!completed) {
                    completed = true;
                    _log('Tool call timed out after', timeoutMs + 'ms:', call.function.name);
                    resolve({
                        content: `Tool call "${call.function.name}" timed out after ${timeoutMs/1000} seconds.`,
                        functions: null
                    });
                }
            }, timeoutMs);

            try {
                const result = await this.interpretAndApplyChanges(call, handler);

                if (!completed) {
                    completed = true;
                    clearTimeout(timeoutId);
                    resolve(result);
                }
            } catch (error) {
                if (!completed) {
                    completed = true;
                    clearTimeout(timeoutId);
                    _lerr('Tool call failed with error:', call.function.name, error.message);
                    resolve({
                        content: `Tool call "${call.function.name}" failed with error: ${error.message}`,
                        functions: null
                    });
                }
            }
        });
    }

    _validateToolResponses(msgs) {
        const toolCallIds = new Set();
        const toolResponseIds = new Set();

        for (const msg of msgs) {
            if (msg.tool_calls) {
                for (const toolCall of msg.tool_calls)
                    toolCallIds.add(toolCall.id);
            }
            if (msg.role === 'tool' && msg.tool_call_id)
                toolResponseIds.add(msg.tool_call_id);
        }

        const validatedMsgs = [];
        const orphanedCalls = [];

        for (const msg of msgs) {
            if (msg.role === 'tool' && msg.tool_call_id) {
                if (toolCallIds.has(msg.tool_call_id))
                    validatedMsgs.push(msg);
                else
                    _log('Removing orphaned tool response with tool_call_id:', msg.tool_call_id);
            } else if (msg.role === 'assistant' && msg.tool_calls) {
                const validToolCalls = [];
                for (const toolCall of msg.tool_calls) {
                    if (toolResponseIds.has(toolCall.id))
                        validToolCalls.push(toolCall);
                    else
                        orphanedCalls.push({
                            tool_call_id: toolCall.id,
                            function_name: toolCall.function?.name
                        });
                }

                if (validToolCalls.length > 0)
                    validatedMsgs.push({...msg, tool_calls: validToolCalls});
                else if (msg.content && msg.content.trim() !== '') {
                    const cleanedMsg = {...msg};
                    delete cleanedMsg.tool_calls;
                    validatedMsgs.push(cleanedMsg);
                }
            } else {
                validatedMsgs.push(msg);
            }
        }

        if (orphanedCalls.length > 0)
            _lerr('Removed tool calls without responses:', JSON.stringify(orphanedCalls, null, 2));

        return validatedMsgs;
    }

    // Build message queue - aggregates from task hierarchy
    _createMsgQ(add_tag, tag_filter) {
        const fullQueue = [];

        // Get messages from ancestor contexts via task hierarchy
        const ancestorContexts = this.getAncestorContexts();
        for (const ctx of ancestorContexts) {
            if (ctx.prompt) {
                const prompt = {role: 'system', content: ctx.prompt};
                if (add_tag)
                    prompt.tag = ctx.tag;
                fullQueue.push(prompt);
            }

            let ctxMsgs;
            if (tag_filter !== undefined) {
                ctxMsgs = ctx._msgs.filter(m => {
                    if (m.msg.role === 'system') return true;
                    if (m.opts.summary) return true;
                    if (m.opts.tag === tag_filter) return true;
                    return false;
                }).map(m => m.msg);
            } else {
                ctxMsgs = ctx.__msgs;
            }

            if (add_tag)
                ctxMsgs = ctxMsgs.map(m => Object.assign({tag: ctx.tag}, m));

            fullQueue.push(...ctxMsgs);
        }

        // Add this context's prompt and messages
        if (this.prompt) {
            const prompt = {role: 'system', content: this.prompt};
            if (add_tag)
                prompt.tag = this.tag;
            fullQueue.push(prompt);
        }

        let my_msgs;
        if (tag_filter !== undefined) {
            my_msgs = this._msgs.filter(m => {
                if (m.msg.role === 'system') return true;
                if (m.opts.summary) return true;
                if (m.opts.tag === tag_filter) return true;
                return false;
            }).map(m => m.msg);
        } else {
            my_msgs = this.__msgs;
        }

        if (add_tag)
            my_msgs = my_msgs.map(m => Object.assign({tag: this.tag}, m));

        fullQueue.push(...my_msgs);

        return this._validateToolResponses(fullQueue);
    }

    async sendMessage(role, content, functions, opts) {
        if (!content)
            return console.error('trying to send a message with no content');

        const isRecursiveCall = opts?._recursive_depth !== undefined;

        if (this._sequential_mode && this._processing_sequential && !isRecursiveCall) {
            _log('Sequential mode: queueing message:', role, content?.slice(0, 50));
            return new Promise((resolve, reject) => {
                this._sequential_queue.push({ role, content, functions, opts, resolve, reject });
            });
        }

        return await this._sendMessageInternal(role, content, functions, opts);
    }

    async _sendMessageInternal(role, content, functions, opts) {
        const isRecursiveCall = opts?._recursive_depth !== undefined;

        if (!isRecursiveCall)
            this._current_depth++;

        const currentDepth = isRecursiveCall ? opts._recursive_depth : this._current_depth;

        const wasProcessing = this._processing_sequential;
        if (this._sequential_mode && !isRecursiveCall) {
            _ldbg('[' + this.tag + '] _sendMessageInternal setting _processing_sequential = true');
            this._processing_sequential = true;
        }

        try {
            if (this._hasPendingToolCalls() && role !== 'tool') {
                _log('Tool calls pending, queueing message:', role, content?.slice(0, 50));
                this._waitingQueue.push({ role, content, functions, opts });
                return { content: '', queued: true };
            }

            const o = this._createMsgObj(role, content, functions, opts);

            if (role === 'tool' && opts?.tool_call_id)
                this._insertToolResponseAtCorrectPosition(o, opts.tool_call_id);

            return await this._processSendMessage(o, currentDepth);
        } finally {
            if (!isRecursiveCall) {
                this._current_depth--;

                if (this._sequential_mode) {
                    _ldbg('[' + this.tag + '] restoring _processing_sequential to:', wasProcessing);
                    this._processing_sequential = wasProcessing;
                }

                if (this._sequential_mode && !wasProcessing)
                    setImmediate(() => this._processSequentialQueue());
            }
        }
    }

    _debugQDump(Q, functions) {
        if (util.is_mocha && process.env.PROD)
            return;
        const dbgQ = Q || this._createMsgQ(true);
        if (debug) {
            console.log('MSGQDEBUG - Q:', JSON.stringify(dbgQ.map(m => ({
                role: m.role,
                content: m.content?.substring?.(0, 50),
                tool_calls: m.tool_calls,
                tool_call_id: m.tool_call_id,
                tag: m.tag
            })), 0, 4), functions?.map?.(f => f.name));
        }
    }

    async _processSendMessage(o, depth) {
        let Q;
        try {
            const name = o.opts?.name;
            _log('@@@@@@@@@ [>>(' + depth + ') ' + o.msgid + (o.opts?.tag ? '-' + o.opts.tag : '') +
                (name ? ' F(' + name + ')' : '') + ' ] SEND-AI', o.msg.role,
                o.msg.content.slice(0, 2000) + (o.msg.content?.length > 2000 ? '... ' : ''));

            if (this._waitingQueue.length > 0 && !this._hasPendingToolCalls()) {
                _log('Processing waiting queue before OpenAI call:', this._waitingQueue.length, 'messages');
                this._processWaitingQueue();
            }

            await this.summarizeMessages();
            Q = this._createMsgQ(false, o.opts?.tag);

            // Aggregate functions from hierarchy and merge with message-specific functions
            const hierarchyFuncs = this.getFunctions() || [];
            const messageFuncs = o.functions || [];
            const funcs = [...hierarchyFuncs, ...messageFuncs].length > 0
                ? [...hierarchyFuncs, ...messageFuncs]
                : null;

            if (debug)
                this._debugQDump(Q, funcs);

            const reply = await openai.send(Q, funcs, o.opts?.model);

            _log('@@@@@@@@@ [<<', o.msgid + (reply.tool_calls ? ' TC:' + (reply.tool_calls?.length || 0) : '') +
                ' ] REPLY-AI', reply.role,
                (reply.content && !o.opts?.noreply ? ' Content: ' + reply.content.slice(0, 2000) : '') +
                (reply.content?.length > 2000 ? '... ' : '') +
                (reply.tool_calls && !o.opts?.nofunc ? '\nCall tools ' + JSON.stringify(reply.tool_calls, 0, 4) : ''));

            o.replied = 1;
            delete o.functions;

            if (o.opts?.nofunc)
                delete reply.tool_calls;
            if (o.opts?.debug_empty && !reply.content)
                this._debugQDump(Q, o.functions);

            this._msgs.push({msg: reply, msgid: o.msgid, opts: o.opts || {}, replied: 3});

            let reply2 = {};
            if (reply?.tool_calls) {
                const toolNames = reply.tool_calls.map(call => call.function.name);
                this._resetToolSequenceIfDifferent(toolNames);

                const filteredToolCalls = this._filterExcessiveToolCalls(reply.tool_calls);

                let toolCallsToProcess = filteredToolCalls;
                let deferredToolCalls = [];

                if (depth >= this.max_depth && filteredToolCalls.length > 0) {
                    _log('Max depth', this.max_depth, 'reached at depth', depth, ', deferring',
                        filteredToolCalls.length, 'tool calls');
                    deferredToolCalls = filteredToolCalls;
                    toolCallsToProcess = [];

                    this._deferred_tool_calls.push(...deferredToolCalls.map(call => ({
                        call,
                        originalMessage: o,
                        depth: depth
                    })));
                }

                const toolCallsWithResults = [];
                for (const call of toolCallsToProcess) {
                    const toolName = call.function.name;
                    this._trackToolCall(toolName);

                    if (this._isDuplicateToolCall(call)) {
                        _log('Duplicate tool call detected:', call.function.name);
                        const result = {
                            content: `Duplicate call detected. An identical "${call.function.name}" ` +
                                `tool call with the same arguments is already running.`,
                            functions: null
                        };
                        toolCallsWithResults.push({ call, result, isDuplicate: true });
                    } else {
                        this._trackActiveToolCall(call);
                        toolCallsWithResults.push({ call, result: null, isDuplicate: false });
                    }
                }

                for (const { call, isDuplicate } of toolCallsWithResults) {
                    if (!isDuplicate) {
                        try {
                            const result = await this._executeToolCallWithTimeout(
                                call, o.opts?.handler, o.opts?.timeout);
                            const item = toolCallsWithResults.find(item => item.call.id === call.id);
                            if (item) item.result = result;
                        } finally {
                            this._completeActiveToolCall(call);
                        }
                    }
                }

                for (const [i, { call, result }] of toolCallsWithResults.entries()) {
                    const opts = {
                        name: call.function.name,
                        tool_call_id: call.id,
                        _recursive_depth: depth + 1,
                        model: o.opts?.model
                    };
                    const content = result ? (result.content || result) : '';
                    const functions = (i === toolCallsWithResults.length - 1 && result && result.functions)
                        ? result.functions : null;

                    if (i === toolCallsWithResults.length - 1)
                        reply2 = await this.sendMessage('tool', content, functions, opts);
                    else {
                        const toolResponse = this._createMsgObj('tool', content, null, opts);
                        toolResponse.replied = 1;
                        this._insertToolResponseAtCorrectPosition(toolResponse, call.id);
                    }
                }
            }

            reply.content ||= '';
            reply.content += reply2?.content ? '\n' + reply2.content : '';

            const hasPending = this._hasPendingToolCalls();
            const queueLength = this._waitingQueue.length;

            if (!hasPending && queueLength > 0) {
                _log('No more pending tool calls, processing', queueLength, 'waiting messages');
                this._processWaitingQueue();
            }

            const isRecursiveCall = o.opts?._recursive_depth !== undefined;
            if (!isRecursiveCall && this._current_depth === 1 && !this._hasPendingToolCalls()
                && this._waitingQueue.length === 0 && this._deferred_tool_calls.length > 0) {
                _log('Processing', this._deferred_tool_calls.length, 'deferred tool calls');
                await this._processDeferredToolCalls();
            }

            return reply;
        } catch (err) {
            console.error('sendMessage error:', err);
            this._debugQDump(Q, o?.functions);
            throw err;
        }
    }

    async interpretAndApplyChanges(call, handler) {
        _log('apply tool', call.function.name, 'have handler', !!handler, !!this.tool_handler);
        if (!call)
            return { content: '', functions: null };

        _log('invoking function', call.function.name);
        handler ||= this.tool_handler;
        let result = await handler(call.function.name, call.function.arguments);

        let content = result?.content || result || '';
        let functions = result?.functions || null;

        if (content && typeof content !== 'string')
            content = JSON.stringify(content);
        else if (!content)
        {
            content = `tool call ${call.function.name} ${call.id} completed. do not reply. wait for the next msg `
                +`from the user`;
        }

        _log('FUNCTION RESULT', call.function.name, call.id, content.substring(0, 50) + '...',
            functions ? 'with functions' : 'no functions');
        return { content, functions };
    }

    // Spawn child context (creates a child task with its own context)
    spawnChild(prompt, tag, config = {}) {
        if (!this.task) {
            // If no task, create a standalone context (legacy mode)
            return createContext(prompt, null, { ...config, tag });
        }

        // Create a child task with its own context
        const Itask = require('./itask.js');
        const childTask = new Itask({
            name: tag || 'child-context',
            prompt,
            async: true,
            spawn_parent: this.task,
            contextConfig: config
        }, []);

        const childContext = new Context(prompt, childTask, { ...config, tag });
        childTask.setContext(childContext);

        return childContext;
    }
}

// Factory function to create a Context with Proxy wrapper
function createContext(prompt, task, config = {}) {
    const instance = new Context(prompt, task, config);

    return new Proxy(instance, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && !isNaN(prop)) {
                return target._msgs[Number(prop)]?.msg;
            }

            if (typeof target._msgs[prop] === 'function') {
                return target[prop].bind(target);
            }

            if (prop === 'length') {
                return target._msgs.length;
            }

            return Reflect.get(target, prop, receiver);
        },

        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && !isNaN(prop)) {
                target._msgs[Number(prop)] = {msg: value};
                return true;
            }

            return Reflect.set(target, prop, value, receiver);
        },

        has(target, prop) {
            if (typeof prop === 'string' && !isNaN(prop)) return true;
            if (prop in target._msgs) return true;
            return prop in target;
        },

        ownKeys(target) {
            const keys = Reflect.ownKeys(target);
            const msgKeys = Object.keys(target._msgs);
            return [...new Set([...msgKeys, ...keys])];
        },

        getOwnPropertyDescriptor(target, prop) {
            if (typeof prop === 'string' && !isNaN(prop)) {
                return Object.getOwnPropertyDescriptor(target._msgs, prop);
            }
            return Object.getOwnPropertyDescriptor(target, prop);
        }
    });
}

module.exports = { Context, createContext };
