const crypto = require('crypto');
const openai = require('./openai.js');
const util = require('./util.js');

class Messages {
    constructor(prompt, opts, msgs, parent) {
        this.prompt = prompt;
        this.parent = parent;
        this.id = crypto.randomBytes(4).toString('hex');
        this.tag = opts?.tag||this.id;
        this.token_limit = opts?.token_limit || parent?.token_limit || 1000000000;
        this.lower_limit = this.token_limit * 0.85;
        this.upper_limit = this.token_limit * 0.98;
        this._msgs = [];
        if (this.parent)
        {
            if (this.parent.child)
                throw new Error('messages parent already has a child');
            this.parent.child = this;
        }
        (msgs||[]).forEach(m => this.push(m));
        this._log('created Q for tag ', this.tag);
    }

    spawnChild(prompt, opts, msgs) {
        return createQ(prompt, opts, msgs, this);
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
        this._log('Closing message Q tag '+this.tag);
        await this._summarizeContext(true);
        if (this.parent)
            this.parent.child = undefined;
    }

    async _summarizeContext(close) {
        if (close && this.child)
            await this.child.close();
        const keep = this._msgs.filter(m => !close && m.summary);
        const summarize = this._msgs.filter(m => (!close || !m.summary) && m.replied);
        const not_replied = this._msgs.filter(m => !m.replied);
        this._log('Start summarize messages. # messages '+summarize.length);
        if (!summarize.length)
            return;
        const msgs = (close ? [{role: 'system', content: this.prompt}] : []).concat(summarize.map(m => m.msg));
        const summary = await this._summarizeMessages(msgs);
        this._msgs = keep;
        if (summary)
        {
            if (close && this.parent)
                this.parent.pushSummary(summary);
            else
                this.pushSummary(summary);
        }
        this._msgs.push(...not_replied);
        this._log('Summarized '+this.tag+' (close '+close+') conversation to '+util.countTokens(this.__msgs)
            +' tokens # messages '+this._msgs.length+'\n summary\n'+summary);
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
                    return this._error('discarding msg with corrupt structure ', m);
                const keys = Object.keys(m);
                for (const k of keys) {
                    if (!['role', 'content', 'refusal', 'name', 'function', 'function_call'].includes(k))
                        return this._error('discarding msg with corrupt key '+k);
                }
                if (util.countTokens(m) > this.upper_limit)
                    return this._error('discard abnormal size message '+tokens+' tokens\n'+m.content.slice(0, 1500));
                if (m.function)
                    m.content = '<function data>';
                const str = `${m.role.toUpperCase()}: ${m.content||JSON.stringify(m.function_call)}`;
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
            return this._log('No msgs for summary found');
        this._log('Summarizing messages. tokens '+tokens+' messages '+msgs.length+' using '+chunks.length+' chunks');
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

    getMsgContext() {
		const msgs = this.parent ? this.parent.getMsgContext() : [];
		msgs.push({role: 'system', content: this.prompt});
		return msgs.concat(this._msgs.filter(m => m.opts.summary).map(m => m.msg));
	}

    async sendMessage(role, content, functions, opts) {
        if (!content)
            return this._error('trying to send a message with no content');
        const name = opts.name;
        const msg = { role, content, ...(name && { name }) };
        const msgid = crypto.randomBytes(2).toString('hex');
        const o = {msg, opts: opts||{}, functions, msgid, replied: 0};
        this._msgs.forEach(m => m.opts.noreply ||= !m.replied);
        this._msgs.push(o);
        const reply = await this._sendMessageInternal(o);
        this._msgs.push({msg: reply, msgid, opts, replied: 3});
        o.replied = 1;
        return reply;
    }

    async _sendMessageInternal(o) {
        const name = o.opts.name;
        const no_store = o.opts.no_store;
        this._log('[>> '+o.msgid+'] SEND-AI '+o.msg.role+' '+o.msg.content.slice(0, 2000)+'... '+' fname '+name,
            o.opts);
        await this.summarizeMessages();
        const parent_msgs = this.parent ? this.parent.getMsgContext() : [];
        const Q = [...parent_msgs, {role: 'system', content: this.prompt}, ...this.__msgs];
        const reply = await openai.send(Q, o.functions);
        this._log('[<< '+o.msgid+'] REPLY-AI '+o.role+' '+(reply.function_call && !o.opts?.nofunc ? 'Call function '
            +reply.function_call.name : '')+(reply.content && !o.opts?.noreply ? ' Content: '
            +reply.content.slice(0, 2000)
            : '')+'... '+(name ? 'fname '+name : ''));
        if (o.opts.nofunc)
            delete reply.function_call;
        return reply;
    }

    _tagsStr() {
        const tagList = [];
        let current = this;
        while (current) {
            tagList.unshift(`[${current.tag}]`);
            current = current.parent;
        }
        return tagList.join('');
    }

    _log(msg, ...args) { console.log(this._tagsStr()+' '+msg, ...args); }
    _error(msg, ...args) { console.error(this._tagsStr()+' '+msg, ...args); }
}

function createQ(...args) {
    const instance = new Messages(...args);

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
