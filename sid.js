'use strict';

const Itask = require('./itask.js');
const { Context, createContext } = require('./context.js');

/**
 * Sid - Session/User Context root task.
 *
 * Extends Itask to serve as the root of task hierarchies.
 * Always has a conversation context attached.
 * Provides serialization support for persistence.
 */
class Sid extends Itask {
    constructor(opt = {}, states = []) {
        // Normalize options
        if (typeof opt === 'string')
            opt = { name: opt };

        // Set defaults for a session root task
        const name = opt.name || 'session';
        const prompt = opt.prompt || '';

        // Call parent constructor with async:true to control context creation
        super({
            ...opt,
            name,
            prompt,
            async: true // We'll manage running ourselves
        }, states);

        // User data storage
        this.userData = opt.userData || {};

        // Session-specific configuration
        this.sessionConfig = {
            token_limit: opt.token_limit,
            max_depth: opt.max_depth,
            max_tool_repetition: opt.max_tool_repetition,
            ...opt.sessionConfig
        };

        // Always create a context for Sid (root session task)
        const contextConfig = {
            tag: opt.tag || this.id,
            token_limit: this.sessionConfig.token_limit,
            max_depth: this.sessionConfig.max_depth,
            max_tool_repetition: this.sessionConfig.max_tool_repetition,
            tool_handler: opt.tool_handler,
            functions: opt.functions,
            sequential_mode: opt.sequential_mode,
            msgs: opt.msgs
        };

        this.context = new Context(prompt, this, contextConfig);

        // Start running if not explicitly set to async
        if (opt.async !== true && states.length > 0) {
            process.nextTick(() => {
                try { this._run(); } catch (e) { console.error(e); }
            });
        }
    }

    // Override sendMessage to always use our context
    async sendMessage(role, content, functions, opts) {
        return this.context.sendMessage(role, content, functions || this.functions, opts);
    }

    // Serialize the session for persistence
    serialize() {
        return JSON.stringify({
            id: this.id,
            name: this.name,
            prompt: this.prompt,
            userData: this.userData,
            sessionConfig: this.sessionConfig,
            context: {
                tag: this.context.tag,
                msgs: this.context._msgs,
                functions: this.context.functions
            },
            tm_create: this.tm_create
        });
    }

    // Deserialize a session from stored data
    static deserialize(data, opt = {}) {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;

        const sid = new Sid({
            name: parsed.name,
            prompt: parsed.prompt,
            userData: parsed.userData,
            sessionConfig: parsed.sessionConfig,
            tag: parsed.context?.tag,
            tool_handler: opt.tool_handler,
            functions: opt.functions || parsed.context?.functions,
            async: true, // Don't auto-run states
            ...opt
        }, opt.states || []);

        // Restore the original ID and timestamps
        sid.id = parsed.id;
        sid.tm_create = parsed.tm_create;

        // Restore messages to context
        if (parsed.context?.msgs) {
            sid.context._msgs = parsed.context.msgs;
        }

        return sid;
    }

    // Create a child task with its own context
    spawnTaskWithContext(opt, states = []) {
        if (typeof opt === 'string')
            opt = { name: opt };

        const childTask = new Itask({
            ...opt,
            spawn_parent: this,
            async: true
        }, states);

        if (opt.prompt) {
            const childContext = new Context(opt.prompt, childTask, {
                tag: opt.tag || childTask.id,
                token_limit: opt.token_limit || this.sessionConfig.token_limit,
                max_depth: opt.max_depth || this.sessionConfig.max_depth,
                max_tool_repetition: opt.max_tool_repetition || this.sessionConfig.max_tool_repetition,
                tool_handler: opt.tool_handler || this.tool_handler,
                functions: opt.functions || this.functions
            });
            childTask.setContext(childContext);
        }

        // Start the child task
        process.nextTick(() => {
            try { childTask._run(); } catch (e) { console.error(e); }
        });

        return childTask;
    }

    // Create a child task without its own context (uses parent's context)
    spawnTask(opt, states = []) {
        if (typeof opt === 'string')
            opt = { name: opt };

        const childTask = new Itask({
            ...opt,
            spawn_parent: this,
            async: true
        }, states);

        // Start the child task
        process.nextTick(() => {
            try { childTask._run(); } catch (e) { console.error(e); }
        });

        return childTask;
    }

    // Close the session - summarize context and cleanup
    async closeSession() {
        await this.context.close();
        this._ecancel();
    }

    // Get session info for debugging/monitoring
    getSessionInfo() {
        return {
            id: this.id,
            name: this.name,
            running: this.running,
            completed: this._completed,
            messageCount: this.context.length,
            childCount: this.child.size,
            userData: this.userData,
            uptime: Date.now() - this.tm_create
        };
    }

    // Store user data
    setUserData(key, value) {
        this.userData[key] = value;
        return this;
    }

    // Get user data
    getUserData(key) {
        return key ? this.userData[key] : this.userData;
    }

    // Clear user data
    clearUserData() {
        this.userData = {};
        return this;
    }
}

// Factory function to create a Sid instance
function createSid(opt = {}, states = []) {
    return new Sid(opt, states);
}

module.exports = { Sid, createSid };
