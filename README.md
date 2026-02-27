# Saico - Hierarchical AI Conversation Orchestrator

Saico is a Node.js library for building AI agents with hierarchical conversations, automatic context aggregation, and enterprise-grade tool calling. It manages nested task trees where each node can have its own message queue, system prompt, tools, and state — and the library automatically assembles the full payload sent to the LLM by walking the tree.

## Features

- **Hierarchical conversations** — Parent-child task trees with automatic prompt, tool, and state summary aggregation
- **Token-aware summarization** — Automatic summarization when message history approaches token limits
- **Tool calling** — Depth control, deferred execution, duplicate detection, repetition prevention, and timeout handling
- **Pluggable storage** — Optional Redis persistence (auto-save via proxy), library-level backend registration (`Saico.registerBackend`), and pluggable DB backends (DynamoDB adapter included)
- **Isolation boundaries** — `opt.isolate` stops ancestor aggregation at any node in the tree
- **Serialization** — Full state save/restore for long-running agents

## Installation

```bash
npm install saico
```

## Quick Start

```js
const { Saico } = require('saico');

class MyAgent extends Saico {
    constructor() {
        super({
            name: 'my-agent',
            prompt: 'You are a helpful assistant.',
            functions: [{
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get weather for a location',
                    parameters: {
                        type: 'object',
                        properties: { location: { type: 'string' } },
                        required: ['location']
                    }
                }
            }]
        });
    }

    // Tool implementations — define TOOL_ prefix methods
    async TOOL_get_weather(args) {
        return `Weather in ${args.location}: 72F, sunny`;
    }
}

const agent = new MyAgent();
agent.activate({ createQ: true });

// Backend message (prefixed with [BACKEND] automatically)
const reply = await agent.sendMessage('What is the weather in Tokyo?');

// User-facing chat message (routed to deepest active msgs Q)
const chatReply = await agent.recvChatMessage('Hello!');
```

## Core Concepts

### Saico Lifecycle

Saico separates construction from activation:

```js
// 1. Construct — sets up config, Redis proxy, DB access. No task yet.
const agent = new Saico({
    name: 'agent',
    prompt: 'System prompt here',
    createQ: true,  // message Q created on activate()
    dynamodb: { region: 'us-east-1', credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' } },
});

// DB methods work before activation
const item = await agent.dbGetItem('id', '123');

// 2. Activate — creates internal task + message Q (from this.createQ)
agent.activate();

// 3. Use — send messages, spawn children
await agent.sendMessage('Do something');
await agent.recvChatMessage('User says hello');

// 4. Deactivate — bubbles cleaned messages to parent, closes msgs Q
await agent.deactivate();
```

Subclasses can also define `this.states` (task functions) in the constructor — `activate()` picks them up automatically:

```js
class MyAgent extends Saico {
    constructor() {
        super({ name: 'agent', prompt: 'You are helpful', createQ: true });
        this.states = [
            async function main() {
                return await this.sendMessage('Starting...');
            }
        ];
    }
}
const agent = new MyAgent();
agent.activate();  // no params needed — uses this.createQ and this.states
```

### Message Orchestration

When `sendMessage()` or `recvChatMessage()` is called, Saico walks the parent chain to build the full LLM payload:

```
Root Saico (prompt: "You are a manager")
  +-- Child Saico (prompt: "Handle bookings")
       +-- Grandchild Saico (prompt: "Process payment")
            sendMessage("Charge $50")
                 |
                 v
    Preamble built automatically:
    [Root prompt] [Root state summary] [Root tool digest]
    [Child prompt] [Child state summary + recent msgs] [Child tool digest]
    [Grandchild prompt] [Grandchild state summary]
    ... then the actual message queue messages ...

    Functions aggregated from all levels.
```

- **`sendMessage(content, functions, opts)`** — Sends a backend message (auto-prefixed `[BACKEND]`). Uses the current or nearest ancestor msgs Q.
- **`recvChatMessage(content, opts)`** — Routes a user chat message DOWN to the deepest descendant with a message queue.

### Isolation

Set `isolate: true` to prevent ancestor aggregation:

```js
const isolated = new Saico({
    name: 'isolated-agent',
    prompt: 'Independent context',
    isolate: true  // won't include parent prompts/tools/summaries
});
```

### State Summaries

Override `getStateSummary()` in your subclass to provide dynamic state context:

```js
class OrderAgent extends Saico {
    getStateSummary() {
        return `Active order: #${this.orderId}, items: ${this.items.length}`;
    }
}
```

When a Saico's msgs Q is not the deepest active one, its last 5 user/assistant messages are also included in the state summary automatically.

### Spawning Child Saico Instances

```js
// Child with its own msgs Q (auto-activated by spawn)
const child = new Saico({
    name: 'subtask',
    prompt: 'Handle this specific sub-task',
    createQ: true,
    functions: [/* child-specific tools */],
});
agent.spawn(child);
await child.sendMessage('Working on subtask...');

// Child without msgs Q (uses parent's via findMsgs())
const simple = new Saico({ name: 'simple' });
agent.spawn(simple);
await simple.sendMessage('Quick operation');

// spawnAndRun: spawn + schedule child task to run on nextTick
const runner = new Saico({ name: 'runner' });
runner.states = [async function() { return await this.sendMessage('Go'); }];
agent.spawnAndRun(runner);
```

Parent must be activated before calling `spawn()` or `spawnAndRun()`. Children are auto-activated if needed.

### Deactivation and Message Bubbling

When a Saico deactivates, cleaned messages (no tool calls, no `[BACKEND]` messages) are pushed into the parent's message queue, preserving conversation continuity.

## Constructor Options

```js
new Saico({
    // Identity
    id: 'custom-id',           // Auto-generated if omitted
    name: 'my-agent',          // Defaults to class name

    // AI config
    prompt: 'System prompt',
    functions: [],             // OpenAI function definitions
    createQ: false,            // Create message Q on activate() (also settable as this.createQ)

    // Behavior
    isolate: false,            // Stop ancestor aggregation

    // Session config (defaults for this agent and its children)
    token_limit: 4000,
    max_depth: 5,              // Max tool call recursion depth
    max_tool_repetition: 20,   // Max consecutive repeated tool calls
    queue_limit: 100,          // Message queue limit
    min_chat_messages: 5,      // Min messages to keep in queue
    sessionConfig: {},         // Override any of the above

    // Storage
    redis: true,               // Set false to skip Redis proxy
    key: 'custom-redis-key',
    store: 'my-table',         // Table name for instance persistence (closeSession/rehydrate)
    dynamodb: {                // DynamoDB config (creates instance-level adapter)
        region: 'us-east-1',
        credentials: { accessKeyId: '...', secretAccessKey: '...' },
    },
    db: customAdapter,         // Any adapter with put/get/delete/query interface

    // User data
    userData: {},              // Arbitrary user metadata
});
```

## Activate Options

```js
agent.activate({
    createQ: true,             // Override this.createQ for this activation
    prompt: 'Extra prompt',    // Appended to class-level prompt
    states: [],                // Override this.states for this activation
    taskId: 'custom-id',
    sequential_mode: true,     // Process messages sequentially

    // Override session config for this activation
    token_limit: 8000,
    max_depth: 10,
    queue_limit: 200,
});
```

## User Data

```js
agent.setUserData('preference', 'dark-mode');  // returns this (chainable)
agent.getUserData('preference');                // 'dark-mode'
agent.getUserData();                            // { preference: 'dark-mode' }
agent.clearUserData();                          // returns this
```

## Session Info

```js
agent.getSessionInfo();
// {
//   id, name, running, completed,
//   messageCount, childCount,
//   userData, uptime
// }

await agent.closeSession();  // prepareForStorage + save to registered backend, cancels task

// Restore from registered backend
const restored = await Saico.rehydrate(agent.id, { store: 'sessions' });
```

## Database Access

Saico provides backend-agnostic DB methods. Configure via `Saico.registerBackend('dynamodb', config)` (library-level), `opt.dynamodb` (instance-level auto-creates adapter), or `opt.db` (any adapter). Table name is required on every call. Child Saico instances without their own DB inherit the parent's adapter automatically via `_getDb()`, which also falls back to the registered backend.

```js
// CRUD — table name required on every call
await agent.dbPutItem({ id: '123', name: 'test' }, 'my-table');
const item = await agent.dbGetItem('id', '123', 'my-table');
await agent.dbDeleteItem('id', '123', 'my-table');
const items = await agent.dbQuery('email-index', 'email', 'user@test.com', 'my-table');
const all = await agent.dbGetAll('my-table');

// Updates
await agent.dbUpdate('id', '123', 'status', 'active', 'my-table');
await agent.dbUpdatePath('id', '123', [{ key: 'nested' }], 'field', 'value', 'my-table');
await agent.dbListAppend('id', '123', 'tags', 'new-tag', 'my-table');

// Counters
const nextId = await agent.dbNextCounterId('OrderId', 'counters');
const count = await agent.dbGetCounterValue('OrderId', 'counters');
await agent.dbSetCounterValue('OrderId', 100, 'counters');
const total = await agent.dbCountItems('my-table');
```

Override `_deserializeRecord(raw)` to transform raw DB records on retrieval (e.g., restore class instances):

```js
class MyAgent extends Saico {
    _deserializeRecord(raw) {
        if (raw.type === 'order') return new Order(raw);
        return raw;
    }
}
```

## Serialization

Both `serialize()` and `Saico.deserialize()` are async. `serialize()` calls `prepareForStorage()` first (strips `_` props, skips functions/states, compresses msgs) then `JSON.stringify`s the result.

```js
// prepareForStorage — clean snapshot
const data = await agent.prepareForStorage();

// serialize/deserialize
const json = await agent.serialize();
const restored = await Saico.deserialize(json);

// Durable persistence (uses registered backend + opt.store table name)
await agent.closeSession();
const restored2 = await Saico.rehydrate(agent.id, { store: 'sessions' });
```

`prepareForStorage()` automatically picks up all non-underscore properties (id, name, prompt, userData, sessionConfig, tm_create, isolate, etc.) and produces compressed chat_history for the msgs Q.

## Initialization

```js
const { Saico, init } = require('saico');

// Initialize Redis (default: enabled) and register DynamoDB backend
await init({
    dynamodb: { region: 'us-east-1', credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' } },
});

// Or register backend directly
Saico.registerBackend('dynamodb', { region: 'us-east-1', credentials: { ... } });
```

## Redis Persistence

When Redis is initialized (default: enabled via `init()`), Saico instances are automatically wrapped in an observable proxy. Any property change triggers a debounced save to Redis.

```js
const agent = new Saico({ name: 'persistent-agent' });
agent.someProperty = 'value';  // Auto-saved to Redis
```

Properties prefixed with `_` are internal and not persisted.

## Tool Implementation (TOOL_ methods)

Define tool implementations as `TOOL_`-prefixed methods on your Saico subclass. When the LLM returns a tool call, Saico automatically searches the task hierarchy (current → up parents → down children) to find and invoke the matching method with parsed arguments.

```js
class MyAgent extends Saico {
    async TOOL_get_weather(args) {
        // args is already JSON.parse'd
        return `Weather in ${args.location}: 72F, sunny`;
    }

    async TOOL_search(args) {
        const results = await search(args.query);
        return { content: JSON.stringify(results), functions: updatedTools };
    }
}
```

Return a string or `{ content: string, functions?: [] }`.

### Tool Safety Features

- **Depth control** — `max_depth` (default: 5) prevents infinite tool call recursion
- **Deferred execution** — Tool calls defer when max depth is reached, resume when depth reduces
- **Duplicate detection** — Identical active tool calls are blocked
- **Repetition prevention** — `max_tool_repetition` (default: 20) blocks excessive repeated calls
- **Timeout handling** — Configurable timeout (default: 5s) with graceful failure
- **Message queuing** — Messages queue automatically when tool calls are pending

## Low-Level API

For cases where you need a standalone message queue without the Saico master class:

```js
const { createMsgs } = require('saico');

// Standalone message queue
const ctx = createMsgs('System prompt', { tag: 'my-tag', token_limit: 4000 });
const reply = await ctx.sendMessage('user', 'Hello', functions);
```

## Project Structure

```
saico/
+-- index.js      # Thin barrel file, exports all components
+-- saico.js      # Saico master class — owns msgs Q, spawn, DB, orchestration
+-- itask.js      # Pure task runner — hierarchy, states, cancellation, promises
+-- msgs.js       # Conversation context (message queue, tool calls, summarization)
+-- dynamo.js     # DynamoDB storage adapter
+-- store.js      # Minimal storage shell (Redis helper + ID generation)
+-- openai.js     # OpenAI API wrapper with retry logic
+-- redis.js      # Redis persistence with observable proxy
+-- util.js       # Utilities (token counting, logging)
```

## Testing

```bash
npm test
```

300 tests covering Saico lifecycle, msgs Q ownership, spawn/spawnAndRun, task hierarchy, message handling, tool calls, DB adapters, async serialization, prepareForStorage, backend registration, persistence (closeSession/rehydrate via registered backend), storage integration, and full hierarchy flows.

## Requirements

- Node.js >= 16.0.0
- `OPENAI_API_KEY` environment variable for LLM calls
- Redis (optional, for auto-persistence)
- AWS SDK v3 (optional peer dependency, for DynamoDB)

## License

ISC
