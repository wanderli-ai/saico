const crypto = require('crypto');
const openai = require('./openai.js');
const util = require('./util.js');

const debug = 0;

class Messages {
    constructor(prompt, parent, tag, token_limit, msgs, tool_handler, config = {}) {
        this.prompt = prompt;
        this.parent = parent;
        this.tag = tag || crypto.randomBytes(4).toString('hex');
        this.token_limit = token_limit || parent?.token_limit || 1000000000;
        this.lower_limit = this.token_limit * 0.85;
        this.upper_limit = this.token_limit * 0.98;
        this.tool_handler = tool_handler || parent?.tool_handler;
        
        // Recursive depth and repetition control
        this.max_depth = config.max_depth || parent?.max_depth || 5;
        this.max_tool_repetition = config.max_tool_repetition || parent?.max_tool_repetition || 20;
        this._current_depth = 0;
        this._deferred_tool_calls = []; // Tool calls deferred when max_depth reached
        this._tool_call_sequence = []; // Track sequence of tool calls for repetition detection
        
        this._msgs = [];
        this._waitingQueue = []; // Queue for messages waiting for tool calls to complete
        this._active_tool_calls = new Map(); // Track active tool calls for duplication protection
        if (this.parent)
        {
            if (this.parent.child)
                throw new Error('messages parent already has a child '+this.parent.tag+' -> '+this.parent.child.tag);
            this.parent.child = this;
            
            // Move unresponded tool calls and their partial replies from parent
            this._moveUnrespondedToolCalls();
        }
        (msgs||[]).forEach(m => this.push(m));
        console.log('created Q for tag ', this.tag);
    }

    spawnChild(prompt, tag, token_limit, msgs, tool_handler, config) {
        return createQ(prompt, this, tag, token_limit, msgs, tool_handler, config);
    }

    _moveUnrespondedToolCalls() {
        if (!this.parent || !this.parent._msgs) return;
        
        const toolCallMsgs = this.parent._msgs.filter(m => m.msg.tool_calls);
        const toMove = [];
        
        for (const toolCallMsg of toolCallMsgs) {
            const toolCalls = toolCallMsg.msg.tool_calls;
            const toolCallIds = toolCalls.map(tc => tc.id);
            
            // Find all tool call replies for this message
            const toolReplies = this.parent._msgs.filter(m => 
                m.msg.role === 'tool' && 
                toolCallIds.includes(m.msg.tool_call_id)
            );
            
            const repliedCallIds = new Set(toolReplies.map(r => r.msg.tool_call_id));
            const unRepliedCalls = toolCalls.filter(tc => !repliedCallIds.has(tc.id));
            
            // If there are unreplied tool calls, move the tool_calls message and existing replies
            if (unRepliedCalls.length > 0) {
                toMove.push(toolCallMsg);
                toMove.push(...toolReplies);
            }
        }
        
        // Remove moved messages from parent and add to this instance
        if (toMove.length > 0) {
            this.parent._msgs = this.parent._msgs.filter(m => !toMove.includes(m));
            this._msgs.push(...toMove);
        }
    }

    _hasPendingToolCalls() {
        // Find all tool call messages
        const toolCallMsgs = this._msgs.filter(m => m.msg.tool_calls);
        
        for (const toolCallMsg of toolCallMsgs) {
            const toolCalls = toolCallMsg.msg.tool_calls;
            const toolCallIds = toolCalls.map(tc => tc.id);
            
            // Find all tool call replies for this message
            const toolReplies = this._msgs.filter(m => 
                m.msg.role === 'tool' && 
                toolCallIds.includes(m.msg.tool_call_id)
            );
            
            const repliedCallIds = new Set(toolReplies.map(r => r.msg.tool_call_id));
            const deferredCallIds = new Set(this._deferred_tool_calls.map(d => d.call.id));
            const unRepliedCalls = toolCalls.filter(tc => !repliedCallIds.has(tc.id) && !deferredCallIds.has(tc.id));
            
            // If there are unreplied tool calls that are not deferred, we have pending tool calls
            if (unRepliedCalls.length > 0) {
                return true;
            }
        }
        
        return false;
    }

    _processWaitingQueue() {
        console.log('Processing waiting queue, ' + this._waitingQueue.length + ' messages waiting');
        
        // Add all waiting messages directly to the message queue using _createMsgObj
        this._waitingQueue.forEach(waitingMessage => {
            console.log('Adding queued message to queue: ' + waitingMessage.role + ' ' + waitingMessage.content?.slice(0, 50));
            this._createMsgObj(
                waitingMessage.role, 
                waitingMessage.content, 
                waitingMessage.functions, 
                waitingMessage.opts
            );
        });
        
        // Clear the waiting queue
        this._waitingQueue = [];
    }

    _trackToolCall(toolName) {
        // Add to sequence tracking
        this._tool_call_sequence.push(toolName);
        
        // Keep only recent history to avoid memory issues
        if (this._tool_call_sequence.length > this.max_tool_repetition * 2) {
            this._tool_call_sequence = this._tool_call_sequence.slice(-this.max_tool_repetition);
        }
    }

    _shouldDropToolCall(toolName) {
        // Check if this tool has been called too many times in a row
        if (this._tool_call_sequence.length < this.max_tool_repetition) {
            return false;
        }
        
        // Count recent consecutive calls to this tool
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
        // Reset sequence counter if we see different tools or no tools
        if (!newToolNames || newToolNames.length === 0) {
            this._tool_call_sequence = [];
            return;
        }
        
        // If any new tool is different from the last one, reset the sequence
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
                console.log('Dropping excessive tool call: ' + toolName + ' (hit max_tool_repetition=' + this.max_tool_repetition + ')');
                return false;
            }
            return true;
        });
    }

    get messages() {
        return this.__msgs;
    }

    set messages(value) {
        if (Array.isArray(value)) {
            this._msgs = value.map(m => {return m.msg ? m : {msg: m, opts: {}, replied: 1}});
        } else {
            throw new Error("messages must be assigned an array");
        }
    }

    push(msg) {
        const m = {msg: msg.msg||msg, opts: msg.opts||{}, msgid: msg.msgid||0, replied: msg.replied||2};
        return this._msgs.push(m);
    }

    pushSummary(summary) {
        const idx = this.push({role: 'user', content: '[SUMMARY]: '+summary});
        this._msgs[idx-1].opts.summary = true;
    }

    toJSON() {
        return this.__msgs;
    }

    filter(callback) {
        return this.__msgs.filter(callback); // Custom filter method
    }

    concat(arr) {
        return this.__msgs.concat(arr);
    }

    slice(start, end) {
        return this.__msgs.slice(start, end); // Copy sliced messages
    }

    reverse() {
        this._msgs.reverse(); // Reverse the internal array in place
        return this; // Return `this` to allow method chaining
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
        return this._msgs.length; // Return the length of the internal array
    }

    serialize() { return JSON.stringify(this._msgs); }

    getSummaries() { return this._msgs.filter(m => m.opts.summary); }

    async summarizeMessages() {
        const tokens = util.countTokens(this.__msgs);
        if (tokens < this.lower_limit)
            return;
        await this._summarizeContext();
    }

    async close() {
        console.log('Closing message Q tag '+this.tag);
        const parent = this.parent;
        const child = this.child;
        delete parent?.child;
        delete this.child;
        
        // Before closing, move any waiting messages to the parent context
        if (parent && this._waitingQueue.length > 0) {
            console.log('Moving ' + this._waitingQueue.length + ' waiting messages to parent context');
            parent._waitingQueue.push(...this._waitingQueue);
            this._waitingQueue = [];
        }
        
        if (child)
            await child.close();
        setImmediate(() => this._summarizeContext(true, parent));
    }

    async _summarizeContext(close, Q) {
        const keep = this._msgs.filter(m => !close && m.summary);
        const summarize = this._msgs.filter(m => (!close || !m.summary) && m.replied);
        const not_replied = this._msgs.filter(m => !m.replied);
        console.log('Start summarize messages. # messages '+summarize.length);
        if (!summarize.length)
            return;
        const msgs = (close ? [{role: 'system', content: this.prompt}] : []).concat(summarize.map(m => m.msg));
        const summary = await this._summarizeMessages(msgs);
        this._msgs = keep;
        if (summary)
        {
            if (close && Q)
                Q.pushSummary(summary);
            else
                this.pushSummary(summary);
        }
        this._msgs.push(...not_replied);
        console.log('Summarized '+this.tag+' (close '+close+') conversation to '+util.countTokens(this.__msgs)
            +' tokens # messages '+this._msgs.length+'\n receiving Q: '+(this.parent?.tag||this.tag)+'\n summary\n'
            +summary);
    }

    async _summarizeMessages(msgs) {
        let chunks = [msgs];
        const tokens = util.countTokens(chunks[0]);
        if (tokens > this.upper_limit)
        {
            chunks = [];
            let chunk_msgs = [];
            let chunk = '';
            msgs.forEach(m => {
                if (typeof m != 'object' || Array.isArray(m))
                    return console.error('discarding msg with corrupt structure ', m);
                const keys = Object.keys(m);
                for (const k of keys) {
                    if (!['role', 'content', 'refusal', 'name', 'tool', 'tool_calls'].includes(k))
                        return console.error('discarding msg with corrupt key '+k);
                }
                if (util.countTokens(m) > this.upper_limit)
                    return console.error('discard abnormal size message '+tokens+' tokens\n'+m.content.slice(0, 1500));
                if (m.function)
                    m.content = '<function data>';
                const str = `${m.role.toUpperCase()}: ${m.content||JSON.stringify(m.tool_calls)}`;
                if (util.countTokens(chunk+str+'\n') < this.token_limit / 2)
                {
                    chunk += str+'\n';
                    chunk_msgs.push(m);
                }
                else
                {
                    chunks.push(chunk_msgs);
                    chunk = '';
                    chunk_msgs = [];
                }
            });
            if (chunk_msgs.length)
                chunks.push(chunk_msgs);
        }
        if (!chunks.length)
            return console.log('No msgs for summary found');
        console.log('Summarizing messages. tokens '+tokens+' messages '+msgs.length+' using '+chunks.length+' chunks');
        let reply = await openai.send([{role: 'system', content: 'Please summarize the following conversation between '+
			'a customer and an AI agent. The summary should be one or two paragraphs as follows:'+
            '- First paragraph will include the purpose of the conversation and bottom line outcome of it'+
            '- second paragraph is optional and will include next steps or requests the user had during this '+
            ' conversation that were not handled yet and should be taken into consideration for future action.'+
            '- Do not add system errors into the summary.\n'+
            '- Formulate the summary as if the AI agent itself summarized it\n'+
            '- Summaries should be in english regardless of the summarized conversation language\n'+
            '\nConversation:\n'+
			(chunks.length > 1 ? 'The conversation will be uploaded in '+chunks.length+' chunks. wait for the last '+
			 'one and then summarize all of them into one summary as requested.\nChunk 1:\n'
			 : 'The conversaion to summarize:\n')+JSON.stringify(chunks[0])}]);
        let summary = reply.content;
        for (let i = 1; i < chunks.length; i++) {
            reply = await openai.send([{role: 'system', content: 'Chunk '+(i==chunks.length ? 'last' : i)+':\n'
                    +JSON.stringify(chunks[i])}]);
            summary = 'Summary of '+this.tag+' conversation:\n'+reply.content;
        }
        return summary;
    }

    getMsgContext(add_tag) {
		const msgs = this.parent ? this.parent.getMsgContext(add_tag) : [];
		msgs.push({role: 'system', content: this.prompt});
		return msgs.concat(this._msgs.filter(m => m.opts.summary || m.role == 'system').map(m => {
            if (add_tag)
                m.msg.tag = this.tag;
            return m.msg;
        }));
	}

    _createMsgObj(role, content, functions, opts) {
        const name = opts.name;
        const tool_call_id = opts.tool_call_id;
        const msg = { role, content, ...(name && { name }), ...(tool_call_id && { tool_call_id }) };
        const msgid = crypto.randomBytes(2).toString('hex');
        const o = {msg, opts: opts||{}, functions, msgid, replied: 0};
        this._msgs.forEach(m => m.opts.noreply ||= !m.replied);
        this._msgs.push(o);
        return o;
    }
    
    _insertToolResponseAtCorrectPosition(toolResponseObj, tool_call_id) {
        // Find the position of the ORIGINAL tool call message that contains this tool_call_id
        // Search backwards to find the most recent occurrence, but prefer non-synthetic messages
        let insertIndex = -1;
        let originalInsertIndex = -1;
        
        for (let i = this._msgs.length - 1; i >= 0; i--) {
            const msg = this._msgs[i];
            if (msg.msg.tool_calls) {
                const hasMatchingCall = msg.msg.tool_calls.some(call => call.id === tool_call_id);
                if (hasMatchingCall) {
                    // Always set this as a fallback
                    if (insertIndex === -1) {
                        insertIndex = i + 1;
                    }
                    
                    // Prefer original messages (not synthetic deferred processing messages)
                    if (msg.msg.content !== 'Processing deferred tool calls') {
                        originalInsertIndex = i + 1;
                        break; // Found original, stop searching
                    }
                }
            }
        }
        
        // Use original message position if found, otherwise use the fallback
        const finalInsertIndex = originalInsertIndex !== -1 ? originalInsertIndex : insertIndex;
        
        if (finalInsertIndex !== -1 && finalInsertIndex < this._msgs.length) {
            // Remove the tool response from its current position (end of array)
            const lastIndex = this._msgs.length - 1;
            if (this._msgs[lastIndex] === toolResponseObj) {
                this._msgs.pop();
                // Insert at the correct position
                this._msgs.splice(finalInsertIndex, 0, toolResponseObj);
            }
        }
    }

    _getToolCallKey(call) {
        // Create a unique key based on tool name and arguments for duplication detection
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
        console.log('Tracking active tool call:', key);
    }

    _completeActiveToolCall(call) {
        const key = this._getToolCallKey(call);
        if (this._active_tool_calls.has(key)) {
            this._active_tool_calls.delete(key);
            console.log('Completed active tool call:', key);
        }
    }

    async _executeToolCallWithTimeout(call, handler, customTimeoutMs = null) {
        const timeoutMs = customTimeoutMs || 5000; // Use custom timeout or default 5 seconds
        
        return new Promise(async (resolve) => {
            let timeoutId;
            let completed = false;
            
            // Set up timeout
            timeoutId = setTimeout(() => {
                if (!completed) {
                    completed = true;
                    console.log('Tool call timed out after', timeoutMs + 'ms:', call.function.name);
                    resolve(`Tool call "${call.function.name}" timed out after ${timeoutMs/1000} seconds. The operation took too long to complete.`);
                }
            }, timeoutMs);
            
            try {
                // Execute the tool call
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
                    console.log('Tool call failed with error:', call.function.name, error.message);
                    resolve(`Tool call "${call.function.name}" failed with error: ${error.message}`);
                }
            }
        });
    }

    _createMsgQ(add_tag, tag_filter) {
        const parent_msgs = this.parent ? this.parent._createMsgQ(add_tag, tag_filter) : [];
        const prompt = {role: 'system', content: this.prompt};
        let my_msgs;
        
        // Apply tag filtering if tag_filter is specified
        if (tag_filter !== undefined) {
            my_msgs = this._msgs.filter(m => {
                // Include system role messages
                if (m.msg.role === 'system') return true;
                // Include messages with summary option
                if (m.opts.summary) return true;
                // Include messages with matching tag
                if (m.opts.tag === tag_filter) return true;
                return false;
            }).map(m => m.msg);
        } else {
            my_msgs = this.__msgs;
        }
        
        if (add_tag)
        {
            prompt.tag = this.tag;
            my_msgs = my_msgs.map(m => Object.assign({tag: this.tag}, m)); 
        }
        return [...parent_msgs, prompt, ...my_msgs];
    }

    async sendMessage(role, content, functions, opts) {
        if (!content)
            return console.error('trying to send a message with no content');
        
        // Track recursion depth
        const isRecursiveCall = opts?._recursive_depth !== undefined;
        
        if (!isRecursiveCall) {
            this._current_depth++;
        }
        
        const currentDepth = isRecursiveCall ? opts._recursive_depth : this._current_depth;
        
        try {
            // Check if there are pending tool calls - if so, queue this message
            // But don't queue tool responses as they complete the pending tool calls
            if (this._hasPendingToolCalls() && role !== 'tool') {
                console.log('Tool calls pending, queueing message: ' + role + ' ' + content?.slice(0, 50));
                this._waitingQueue.push({ role, content, functions, opts });
                return { content: '', queued: true }; // Return indication that message was queued
            }
            
            const o = this._createMsgObj(role, content, functions, opts);
            
            // For tool responses, reposition them correctly after creation
            if (role === 'tool' && opts.tool_call_id) {
                this._insertToolResponseAtCorrectPosition(o, opts.tool_call_id);
            }
            
            return await this._processSendMessage(o, currentDepth);
            
        } finally {
            if (!isRecursiveCall) {
                this._current_depth--;
            }
        }
    }

    _debugQDump(functions) {
        const dbgQ = this._createMsgQ(true);
        console.log('MSGQDEBUG - Q:', JSON.stringify(dbgQ.map(m => { return {role: m.role,
            content: m.content?.substring?.(0, 50), tool_calls: m.tool_calls, tool_call_id: m.tool_call_id,
            tag: m.tag}; }), 0, 4), functions?.map?.(f => f.name));
    }

    async _processSendMessage(o, depth) {
        try {
            const name = o.opts.name;
            const no_store = o.opts.no_store;
            console.log('[>> '+o.msgid+'] SEND-AI '+o.msg.role+' '+o.msg.content.slice(0, 2000)+'... '+' fname '+name,
                'Q tag', this.tag, 'depth', depth);
            
            // Process any waiting messages before creating the message queue for OpenAI
            if (this._waitingQueue.length > 0 && !this._hasPendingToolCalls()) {
                console.log('Processing waiting queue before OpenAI call: ' + this._waitingQueue.length + ' messages');
                this._processWaitingQueue();
            }
            
            await this.summarizeMessages();
            const Q = this._createMsgQ(false, o.opts.tag);
            if (debug)
                this._debugQDump(o.functions);
            const reply = await openai.send(Q, o.functions);
            console.log('[<< '+o.msgid+'] REPLY-AI '+o.role+' '+(reply.tool_calls && !o.opts?.nofunc ? 'Call tools '
                +JSON.stringify(reply.tool_calls) : '')+(reply.content && !o.opts?.noreply ? ' Content: '
                +reply.content.slice(0, 2000)
                : '')+'... '+(name ? 'fname '+name : ''));
            o.replied = 1;
            if (o.opts.nofunc)
                delete reply.tool_calls;
            this._msgs.push({msg: reply, msgid: o.msgid, opts: o.opts, replied: 3});
            let reply2 = {};
            if (reply?.tool_calls)
            {
                // Reset tool sequence if we have different tools or no tools
                const toolNames = reply.tool_calls.map(call => call.function.name);
                this._resetToolSequenceIfDifferent(toolNames);
                
                // Filter out excessive tool calls
                const filteredToolCalls = this._filterExcessiveToolCalls(reply.tool_calls);
                
                // Check depth limits and defer tools if needed
                let toolCallsToProcess = filteredToolCalls;
                let deferredToolCalls = [];
                
                if (depth >= this.max_depth && filteredToolCalls.length > 0)
                {
                    console.log('Max depth ' + this.max_depth + ' reached at depth ' + depth + ', deferring ' 
                        + filteredToolCalls.length + ' tool calls');
                    deferredToolCalls = filteredToolCalls;
                    toolCallsToProcess = [];
                    
                    // Add deferred tool calls to the deferred queue
                    this._deferred_tool_calls.push(...deferredToolCalls.map(call => ({
                        call,
                        originalMessage: o,
                        depth: depth
                    })));
                }
                
                // Pre-process tool calls to detect duplicates and track active ones
                const toolCallsWithResults = [];
                for (const call of toolCallsToProcess) {
                    const toolName = call.function.name;
                    this._trackToolCall(toolName);
                    
                    // Check for duplicate tool call
                    if (this._isDuplicateToolCall(call)) {
                        console.log('Duplicate tool call detected:', call.function.name, 'with args:', call.function.arguments.slice(0, 100));
                        const result = `Duplicate call detected. An identical "${call.function.name}" tool call with the same arguments is already running. Please wait for the previous call to complete.`;
                        toolCallsWithResults.push({ call, result, isDuplicate: true });
                    } else {
                        // Track this tool call as active but don't execute yet
                        this._trackActiveToolCall(call);
                        toolCallsWithResults.push({ call, result: null, isDuplicate: false });
                    }
                }
                
                // Now execute non-duplicate tool calls
                for (const { call, isDuplicate } of toolCallsWithResults) {
                    if (!isDuplicate) {
                        try {
                            const result = await this._executeToolCallWithTimeout(call, o.opts.handler, o.opts.timeout);
                            // Update the result in the array
                            const item = toolCallsWithResults.find(item => item.call.id === call.id);
                            if (item) item.result = result;
                        } finally {
                            // Always complete tracking, even if the tool call failed or timed out
                            this._completeActiveToolCall(call);
                        }
                    }
                }
                
                // Process responses for all tool calls
                for (const [i, { call, result }] of toolCallsWithResults.entries()) {
                    const opts = {name: call.function.name, tool_call_id: call.id, _recursive_depth: depth + 1};
                    
                    if (i === toolCallsWithResults.length - 1)
                        reply2 = await this.sendMessage('tool', result, null, opts)
                    else {
                        const toolResponse = this._createMsgObj('tool', result, null, opts);
                        toolResponse.replied = 1; // Mark non-last tool responses as replied
                        this._insertToolResponseAtCorrectPosition(toolResponse, call.id);
                    }
                }
            }
            reply.content ||= '';
            reply.content += reply2?.content ? '\n'+reply2.content : '';
            
            // After completing this message (including any tool calls), check if we should process waiting queue
            const hasPending = this._hasPendingToolCalls();
            const queueLength = this._waitingQueue.length;
            const deferredLength = this._deferred_tool_calls.length;
            
            if (!hasPending && queueLength > 0)
            {
                console.log('No more pending tool calls, processing ' + queueLength + ' waiting messages');
                this._processWaitingQueue();
            }
            
            // Process deferred tool calls if we're back at the instance root level and no pending work
            const isRecursiveCall = o.opts._recursive_depth !== undefined;
            if (!isRecursiveCall && this._current_depth === 1 && !this._hasPendingToolCalls()
                && this._waitingQueue.length === 0 && this._deferred_tool_calls.length > 0)
            {
                console.log('Processing ' + this._deferred_tool_calls.length + ' deferred tool calls');
                await this._processDeferredToolCalls();
            }
            
            return reply;
        } catch (err) {
            console.error('sendMessage error:', err);
            this._debugQDump(o?.functions);
        }
    }

    async interpretAndApplyChanges(call, handler) {
        console.log('apply tool', call.function.name, 'have handler', !!handler, !!this.tool_handler);
        if (!call)
            return;
        console.log('invoking function ', call.function.name);
        handler ||= this.tool_handler;
        let result = await handler(call.function.name, call.function.arguments);
        if (result && typeof result != 'string')
            result = JSON.stringify(result);
        else if (!result)
            result = 'done. do not reply to this message. not even with tool_calls';
        console.log('FUNCTION RESULT', call.function.name, call.id, result.substring(0,50)+'...');
        return result;
    }

    async _processDeferredToolCalls() {
        if (this._deferred_tool_calls.length === 0) return;
        
        console.log('Processing deferred tool calls: ' + this._deferred_tool_calls.length);
        
        // Take all deferred tool calls and clear the queue
        const deferredCalls = [...this._deferred_tool_calls];
        this._deferred_tool_calls = [];
        
        // Group by original message to process them together
        const callsByMessage = new Map();
        for (const deferred of deferredCalls) {
            const key = deferred.originalMessage.msgid;
            if (!callsByMessage.has(key)) {
                callsByMessage.set(key, []);
            }
            callsByMessage.get(key).push(deferred);
        }
        
        // Process each group of deferred calls
        for (const [msgid, deferredGroup] of callsByMessage) {
            console.log('Processing deferred group for message ' + msgid + ': ' + deferredGroup.length + ' calls');
            
            // Create a synthetic message to trigger tool processing
            const syntheticReply = {
                content: 'Processing deferred tool calls',
                tool_calls: deferredGroup.map(d => d.call)
            };
            
            // Create a message object for the synthetic reply
            const syntheticMsgObj = this._createMsgObj('assistant', syntheticReply.content, null, {});
            this._msgs.push({msg: syntheticReply, msgid: syntheticMsgObj.msgid, opts: {}, replied: 3});
            
            // Process the deferred tool calls at depth 0 (reset recursion)
            let reply2 = {};
            const toolNames = syntheticReply.tool_calls.map(call => call.function.name);
            this._resetToolSequenceIfDifferent(toolNames);
            
            // Filter again in case conditions changed
            const filteredToolCalls = this._filterExcessiveToolCalls(syntheticReply.tool_calls);
            
            for (const [i, call] of filteredToolCalls.entries()) {
                const toolName = call.function.name;
                this._trackToolCall(toolName);
                
                let result;
                
                // Check for duplicate tool call in deferred processing
                if (this._isDuplicateToolCall(call)) {
                    console.log('Duplicate deferred tool call detected:', call.function.name, 'with args:', call.function.arguments.slice(0, 100));
                    result = `Duplicate call detected. An identical "${call.function.name}" tool call with the same arguments is already running. Please wait for the previous call to complete.`;
                } else {
                    // Track this tool call as active
                    this._trackActiveToolCall(call);
                    
                    try {
                        // Find the corresponding deferred call for this tool call
                        const correspondingDeferred = deferredGroup.find(d => d.call.id === call.id);
                        const handler = correspondingDeferred?.originalMessage.opts.handler || this.tool_handler;
                        const timeout = correspondingDeferred?.originalMessage.opts.timeout;
                        
                        result = await this._executeToolCallWithTimeout(call, handler, timeout);
                    } finally {
                        // Always complete tracking, even if the tool call failed or timed out
                        this._completeActiveToolCall(call);
                    }
                }
                
                const opts = {name: call.function.name, tool_call_id: call.id, _recursive_depth: 1};
                
                if (i === filteredToolCalls.length - 1) {
                    reply2 = await this.sendMessage('tool', result, null, opts);
                } else {
                    const toolResponse = this._createMsgObj('tool', result, null, opts);
                    toolResponse.replied = 1;
                    // Insert deferred tool response at correct position after its original tool call
                    this._insertToolResponseAtCorrectPosition(toolResponse, call.id);
                }
            }
        }
    }
}

function createQ(prompt, parent, tag, token_limit, msgs, tool_handler, config) {
    const instance = new Messages(prompt, parent, tag, token_limit, msgs, tool_handler, config);

    return new Proxy(instance, {
        get(target, prop, receiver) {
            // Handle numeric index: msg[0], msg[1], etc.
            if (typeof prop === 'string' && !isNaN(prop)) {
                return target._msgs[Number(prop)]?.msg;
            }

            // Forward array methods like .map(), .filter(), etc.
            if (typeof target._msgs[prop] === 'function') {
                return target[prop].bind(target);
            }

            // Handle .length
            if (prop === 'length') {
                return target._msgs.length;
            }

            // Forward everything else to the instance itself
            return Reflect.get(target, prop, receiver);
        },

        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && !isNaN(prop)) {
                target._msgs[Number(prop)] = {msg: value};
                return true;
            }

            // Make absolutely sure we're setting on the real object
            //if (prop in target || typeof prop === 'string') {
            //	target[prop] = value;
            //	return true;
            //}

            return Reflect.set(target, prop, value, receiver);
        },

        has(target, prop) {
            // Allow `0 in obj`, `length in obj`, etc.
            if (typeof prop === 'string' && !isNaN(prop)) return true;
            if (prop in target._msgs) return true;
            return prop in target;
        },

        ownKeys(target) {
            // Make Object.keys(), for...in, etc. behave like an array
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

module.exports = {createQ};
