'use strict';

/**
 * Saico Library - Hierarchical AI Conversation Orchestrator
 *
 * Combines task hierarchy (Itask) with conversation contexts (Context) to create
 * a unified system for managing AI conversations with:
 * - Task-based organizational structure
 * - Optional conversation contexts attached to tasks
 * - Hierarchical message aggregation with function collection
 * - Full tool_calls support with depth control
 * - Storage persistence (Redis cache + optional DB backend)
 *
 * Main Components:
 * - Itask: Base task class for all tasks (supports states, cancellation, promises)
 * - Context: Conversation context with message handling and tool calls
 * - Sid: Session root task (extends Itask, always has a context)
 * - Store: Storage abstraction layer (Redis + optional backends like DynamoDB)
 */

const Itask = require('./itask.js');
const { Context, createContext } = require('./context.js');
const { Sid, createSid } = require('./sid.js');
const { Store, DynamoBackend } = require('./store.js');

// Wire up Context class reference in Itask to avoid circular dependency
Itask.Context = Context;

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

/**
 * Create a new task with optional context.
 *
 * @param {Object|string} opt - Task options or name string
 * @param {string} opt.name - Task name
 * @param {string} opt.prompt - System prompt (if provided, creates a context)
 * @param {Function} opt.tool_handler - Tool handler function
 * @param {Array} opt.functions - Available functions for AI
 * @param {boolean} opt.cancel - Whether task is cancelable
 * @param {Object} opt.bind - Bind context for state functions
 * @param {Itask} opt.spawn_parent - Parent task to spawn under
 * @param {boolean} opt.async - If true, don't auto-run
 * @param {Object} opt.store - Store instance for persistence
 * @param {Array} states - Array of state functions
 * @returns {Itask} The created task
 */
function createTask(opt, states = []) {
    if (typeof opt === 'string')
        opt = { name: opt };

    if (!opt.store)
        opt.store = Store.instance;

    const task = new Itask(opt, states);

    // Auto-create context if prompt is provided
    if (opt.prompt) {
        const context = new Context(opt.prompt, task, {
            tag: opt.tag || task.id,
            token_limit: opt.token_limit,
            max_depth: opt.max_depth,
            max_tool_repetition: opt.max_tool_repetition,
            tool_handler: opt.tool_handler,
            functions: opt.functions,
            sequential_mode: opt.sequential_mode
        });
        task.setContext(context);
    }

    return task;
}

/**
 * Legacy createQ function for backward compatibility.
 * Creates a standalone Context (not attached to a task).
 *
 * @param {string} prompt - System prompt
 * @param {Context} parent - Parent context (legacy, will be converted to task-based)
 * @param {string} tag - Context tag identifier
 * @param {number} token_limit - Token limit for summarization
 * @param {Array} msgs - Initial messages
 * @param {Function} tool_handler - Tool handler function
 * @param {Object} config - Additional configuration
 * @returns {Context} Proxied Context instance
 */
function createQ(prompt, parent, tag, token_limit, msgs, tool_handler, config = {}) {
    // For backward compatibility, if parent is a Context, get its task
    let task = null;
    if (parent && parent.task) {
        task = parent.task;
    }

    const context = createContext(prompt, task, {
        tag,
        token_limit,
        msgs,
        tool_handler,
        ...config
    });

    // If there's a parent context, set up the relationship via tasks
    if (parent && parent.task) {
        // Create a child task to hold this context
        const childTask = new Itask({
            name: tag || 'child-context',
            async: true,
            spawn_parent: parent.task,
            store: Store.instance
        }, []);
        context.setTask(childTask);
        childTask.setContext(context);
    }

    return context;
}

// Export all components
module.exports = {
    // Core classes
    Itask,
    Context,
    Sid,
    Store,
    DynamoBackend,

    // Initialization
    init,

    // Factory functions
    createTask,
    createSid,
    createContext,

    // Legacy compatibility
    createQ,

    // Utilities (re-export from util.js)
    util: require('./util.js'),

    // OpenAI wrapper (re-export)
    openai: require('./openai.js'),

    // Redis persistence (re-export)
    redis: require('./redis.js')
};
