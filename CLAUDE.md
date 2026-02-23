# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Testing
- `npm test` - Run Mocha test suite (test/**/*.test.js)
- Set `NODE_ENV=test` to enable test mode utilities

### Development
- `npm start` - Run the main application (server.js)
- No lint or build commands currently configured

## Architecture Overview

Saico is a hierarchical AI conversation orchestrator library. The **Saico** master class is the primary abstraction external users extend. It separates object lifecycle from task activation — instances can be created with DB access and Redis persistence, extended with custom methods, and activated into running Itask instances when ready.

### Core Components

```
+---------------------------------------------------------------------+
|                          Saico Library                               |
+---------------------------------------------------------------------+
|                                                                     |
|  +-------------------+                                              |
|  |      Saico        |  <-- External users extend this              |
|  | (Master Class)    |                                              |
|  | - Redis Proxy     |                                              |
|  | - DB methods      |                                              |
|  | - activate()      |                                              |
|  +--------+----------+                                              |
|           | creates via activate()                                  |
|           v                                                         |
|  +--------------+    +--------------+    +--------------+          |
|  |    Itask     |    |   Context    |    |     Sid      |          |
|  |  (Base Task) |<---|  (msgs.js)   |    | (Root Task)  |          |
|  +--------------+    +--------------+    +--------------+          |
|         ^                                       |                   |
|         +---------------------------------------+                   |
|                    extends                                          |
|                                                                     |
|  +-------------------+    +-------------------+                     |
|  |      Store        |    | DynamoDBAdapter   |                     |
|  | (Redis + Backend) |    |  (dynamo.js)      |                     |
|  +-------------------+    +-------------------+                     |
|                                                                     |
+---------------------------------------------------------------------+
```

1. **index.js** - Main entry point exporting all classes and factory functions
   - `Saico` - Master class (external users extend this)
   - `DynamoDBAdapter` - DynamoDB storage adapter
   - `Itask` - Base task class
   - `Context` - Conversation context class
   - `Sid` - Session root task class
   - `createTask()` - Factory for tasks with optional context
   - `createSid()` - Factory for session root tasks
   - `createContext()` - Factory for standalone contexts
   - `createQ()` - Legacy compatibility factory

2. **saico.js** - Master class for building AI-powered services
   - External users extend this instead of Itask
   - Constructor returns Redis observable proxy when Redis is available
   - `activate(opts)` creates internal Itask; `opts.createQ` flag attaches message Q context
   - `opts.prompt` appends to class-level prompt (NOT a trigger for context creation)
   - Generic DB methods (`dbPutItem`, `dbGetItem`, `dbQuery`, etc.) delegate to pluggable backend
   - `opt.dynamodb_table` auto-creates DynamoDBAdapter; `opt.db` accepts any adapter
   - Message relay: `sendMessage()`, `recvChatMessage()` delegate to internal task
   - Child spawning: `spawnTaskWithContext()`, `spawnTask()`
   - Overridable `getStateSummary()` hook
   - Serialization support

3. **itask.js** - Base task class for hierarchical task management
   - Named state parsing (try, catch, finally, cancel)
   - Parent-child task hierarchy (Set-based children)
   - Cooperative cancellation
   - Promise/thenable interface
   - Context support for AI conversations
   - `sendMessage()` delegates to context hierarchy

4. **msgs.js** - Conversation context with message handling (renamed from context.js)
   - Message queue management with Proxy wrapper
   - Tool call handling (depth control, deferred execution, duplicate detection)
   - Message queueing for pending tool calls
   - Summarization support
   - Hierarchical context gathering via task hierarchy
   - `getFunctions()` aggregates from ancestor contexts
   - `context.js` still exists as a backward-compatibility shim re-exporting from `msgs.js`

5. **dynamo.js** - DynamoDB storage adapter (generalized from backend/aws.js)
   - `DynamoDBAdapter` class with full CRUD: `put`, `get`, `delete`, `query`, `getAll`
   - Update operations: `update`, `updatePath`, `listAppend`, `listAppendPath`
   - Counter operations: `nextCounterId`, `getCounterValue`, `setCounterValue`
   - Utility: `countItems`
   - All methods accept optional `table` override (defaults to constructor table)
   - AWS SDK v3 packages are optional peer dependencies (loaded only when needed)
   - Injectable client for testing

6. **sid.js** - Session/User root task (extends Itask)
   - Always has a conversation context
   - JSON serialization for persistence
   - User data storage
   - Helper methods for spawning child tasks

7. **openai.js** - OpenAI API wrapper with retry logic
   - Handles rate limiting (429 errors) with automatic retry
   - Supports modern tools API
   - Requires OPENAI_API_KEY environment variable

8. **store.js** - Storage abstraction layer
   - `Store` singleton with Redis cache + pluggable backends
   - `DynamoBackend` for Store's internal persistence (save/load/delete by ID)

9. **redis.js** - Optional Redis persistence layer
   - Creates observable proxies for automatic state persistence
   - Debounced saves with change detection
   - Properties prefixed with `_` are internal and not persisted

10. **util.js** - Utilities including token counting and logging

### Key Patterns

**Saico Lifecycle**: Separate construction from activation:
- `new Saico(opt)` — creates instance with Redis proxy + DB access. No Itask yet.
- `instance.activate({ createQ: true })` — creates internal Itask + optional message Q context
- `instance.deactivate()` — closes context, cancels task
- DB methods (`dbGetItem`, etc.) work before and after activation

**Pluggable DB Backend**: The Saico class has generic DB methods that delegate to `this._db`:
- Configure via `opt.dynamodb_table` (auto-creates DynamoDBAdapter) or `opt.db` (any adapter)
- All `db*` methods are no-ops when no backend is configured
- Any adapter implementing the same interface (put/get/delete/query/getAll/update/updatePath/listAppend/listAppendPath/nextCounterId/getCounterValue/setCounterValue/countItems) can be used

**Task Hierarchy**: Parent-child relationship where:
- Tasks can have contexts attached (optional)
- Child tasks inherit tool_handler and functions from parents
- Context gathering walks up the task hierarchy
- Summaries bubble up to parent contexts when tasks close

**Message Flow**:
```
sendMessage() call on any task:

Task A (root/Sid with Context)
  +- Task B (with Context)
       +- Task C (current task with Context)
            sendMessage()
                 |
                 v
    1. Gather context from hierarchy:
       - Walk up: C -> B -> A
       - Collect prompts, summaries, messages from each context
       - Aggregate functions from each level

    2. Build message queue:
       [A.prompt, A.summaries, B.prompt, B.summaries, C.prompt, C.messages]

    3. Send to model with aggregated functions

    4. Handle tool calls with depth control
```

**Tool Calls Management**:
- **Depth Control**: `max_depth` (default: 5) prevents infinite recursion
- **Repetition Prevention**: `max_tool_repetition` (default: 20) blocks excessive repeated calls
- **Deferred Execution**: Tool calls defer when max depth reached, execute later
- **Message Queuing**: Messages queue when tool calls pending
- **Duplicate Detection**: Identical tool calls blocked while active
- **Timeout Handling**: Configurable timeout (default: 5s)

**Message Structure**:
```js
{
  msg: { role, content, name?, tool_call_id?, tool_calls? },
  opts: { summary?, noreply?, nofunc?, handler?, timeout? },
  msgid: String,
  replied: 0 | 1 | 3  // 0=pending, 1=user sent, 3=AI replied
}
```

### API Usage

**Extending Saico (recommended)**:
```javascript
const { Saico } = require('saico');

class MyAgent extends Saico {
    constructor(userId) {
        super({
            name: 'my-agent',
            prompt: 'You are a helpful assistant.',
            dynamodb_table: 'my_data',
            tool_handler: (name, args) => this.handleTool(name, args),
            functions: [{ name: 'lookup', ... }]
        });
        this.userId = userId;  // triggers Redis save via proxy
    }

    async start() {
        // DB works BEFORE activate
        const user = await this.dbGetItem('id', this.userId);

        // activate creates Itask + message Q
        this.activate({ createQ: true, prompt: `User: ${this.userId}` });
        return this;
    }

    getStateSummary() {
        return `Active user: ${this.userId}`;
    }

    async handleTool(name, args) { /* ... */ }
}

const agent = new MyAgent('user-123');
await agent.start();
const reply = await agent.recvChatMessage('Hello!');
```

**Saico DB methods** (backend-agnostic):
```javascript
// CRUD
await this.dbPutItem({ id: '123', name: 'test' });
const item = await this.dbGetItem('id', '123');
await this.dbDeleteItem('id', '123');
const items = await this.dbQuery('email-index', 'email', 'user@test.com');
const all = await this.dbGetAll();

// Updates
await this.dbUpdate('id', '123', 'status', 'active');
await this.dbUpdatePath('id', '123', [{key: 'nested'}], 'field', 'value');
await this.dbListAppend('id', '123', 'tags', 'new-tag');

// Counters
const nextId = await this.dbNextCounterId('OrderId');
const count = await this.dbGetCounterValue('OrderId');
await this.dbSetCounterValue('OrderId', 100);

// Utility
const total = await this.dbCountItems();
```

**Creating a Session (Sid)**:
```javascript
const { createSid } = require('saico');

const session = createSid({
    name: 'my-session',
    prompt: 'You are a helpful assistant',
    tool_handler: async (name, args) => { /* ... */ },
    functions: [{ name: 'myFunc', ... }]
});

const reply = await session.sendMessage('Hello!');
```

**Spawning Child Tasks**:
```javascript
// Task with its own context
const childTask = session.spawnTaskWithContext({
    name: 'subtask',
    prompt: 'Handling a specific sub-task'
}, [
    async function main() {
        return await this.sendMessage('Working...');
    }
]);

// Task without context (uses parent's context)
const simpleTask = session.spawnTask({
    name: 'simple'
}, [
    async function() {
        await this.sendMessage('Quick operation');
    }
]);
```

**Legacy createQ (backward compatibility)**:
```javascript
const { createQ } = require('saico');

const ctx = createQ('You are a helpful assistant', null, 'my-tag', 1000, null, toolHandler);
const reply = await ctx.sendMessage('user', 'Hello', functions);
```

**Serialization**:
```javascript
// Save session
const serialized = session.serialize();

// Restore session
const restored = Sid.deserialize(serialized, {
    tool_handler: myHandler
});
```

### Tool Handler Interface

Tool handlers should follow this pattern:
```js
async function toolHandler(toolName, argumentsString) {
  const args = JSON.parse(argumentsString);
  // Execute tool logic
  return result; // string or { content: string, functions?: [] }
}
```

### File Structure

```
/saico
+-- index.js          # Main entry point (exports Saico, DynamoDBAdapter, Itask, Context, Sid, etc.)
+-- saico.js          # Master class (extend this)
+-- itask.js          # Base task class
+-- msgs.js           # Message/conversation context (renamed from context.js)
+-- context.js        # Backward-compat shim re-exporting from msgs.js
+-- dynamo.js         # DynamoDB storage adapter
+-- sid.js            # Session root task
+-- store.js          # Store abstraction (Redis + backends)
+-- openai.js         # OpenAI wrapper
+-- util.js           # Utilities
+-- redis.js          # Redis persistence
+-- test/
    +-- saico.test.js       # Saico class tests
    +-- dynamo.test.js      # DynamoDB adapter tests
    +-- itask.test.js       # Task hierarchy tests
    +-- context.test.js     # Message handling tests
    +-- sid.test.js         # Session management tests
    +-- integration.test.js # Full hierarchy flow tests
```

### Testing Framework

Uses Mocha with Chai and Sinon for:
- Saico class lifecycle, DB delegation, subclass extension, Redis proxy (saico.test.js)
- DynamoDB adapter with mocked client (dynamo.test.js)
- Task hierarchy, states, cancellation (itask.test.js)
- Message handling, tool calls, context aggregation (context.test.js)
- Session management, serialization, user data (sid.test.js)
- Full hierarchy message flow, legacy compatibility (integration.test.js)

Test files mock external dependencies (OpenAI API, token counting, DynamoDB client) for isolated unit testing. DB adapter tests inject a mock client via `opt.client`.
