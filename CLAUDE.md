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

Saico is a hierarchical AI conversation orchestrator library. The **Saico** master class is the single primary abstraction external users extend. It separates object lifecycle from task activation — instances can be created with DB access and Redis persistence, extended with custom methods, and activated into running Itask instances when ready. Saico orchestrates the full message payload sent to the LLM by walking its parent chain to aggregate prompts, tools, digests, and state summaries.

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
|  | - sendMessage()   |  <-- Orchestrates preamble from chain        |
|  | - recvChatMessage |  <-- Routes to deepest child Q               |
|  | - userData        |                                              |
|  | - serialize()     |                                              |
|  +--------+----------+                                              |
|           | creates via activate()                                  |
|           v                                                         |
|  +--------------+    +--------------+                               |
|  |    Itask     |    |   Context    |                               |
|  |  (Base Task) |<---|  (msgs.js)   |                               |
|  +--------------+    +--------------+                               |
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
   - `createTask()` - Factory for tasks with optional context
   - `createContext()` - Factory for standalone contexts
   - `createQ()` - Legacy compatibility factory

2. **saico.js** - Master class for building AI-powered services
   - External users extend this instead of Itask
   - Constructor returns Redis observable proxy when Redis is available
   - `activate(opts)` creates internal Itask; `opts.createQ` flag attaches message Q context
   - `opts.prompt` appends to class-level prompt (NOT a trigger for context creation)
   - **sendMessage orchestration**: walks Saico parent chain to build preamble (prompts, state summaries, tool digests) and aggregated functions, passes to Context via `_preamble` and `_aggregatedFunctions` opts
   - **recvChatMessage routing**: routes DOWN to deepest descendant with a msg Q
   - `opt.isolate` stops ancestor aggregation at this Saico boundary
   - Generic DB methods (`dbPutItem`, `dbGetItem`, `dbQuery`, etc.) delegate to pluggable backend
   - DB retrieval methods (`dbGetItem`, `dbQuery`, `dbGetAll`) call `_deserializeRecord()` hook
   - `opt.dynamodb_table` auto-creates DynamoDBAdapter; `opt.db` accepts any adapter
   - Child spawning: `spawnTaskWithContext()`, `spawnTask()` — inherit `sessionConfig` defaults
   - Overridable `getStateSummary()` hook
   - `getRecentMessages(n)` — user/assistant messages (no tool calls, no BACKEND)
   - `_getStateSummary(activeCtx)` — includes recent messages when context is not the active Q
   - **deactivate**: bubbles cleaned messages to parent Q, then closes context
   - User data: `userData`, `setUserData()`, `getUserData()`, `clearUserData()`
   - Session info: `getSessionInfo()`, `closeSession()`, `sessionConfig`
   - Serialization: `serialize()`, `static Saico.deserialize()`

3. **itask.js** - Base task class for hierarchical task management
   - Named state parsing (try, catch, finally, cancel)
   - Parent-child task hierarchy (Set-based children)
   - Cooperative cancellation
   - Promise/thenable interface
   - Context support for AI conversations
   - `sendMessage()` delegates to context hierarchy
   - `findDeepestContext()` walks DOWN to find deepest active descendant with a context

4. **msgs.js** - Conversation context with message handling (renamed from context.js)
   - Message queue management with Proxy wrapper
   - Tool call handling (depth control, deferred execution, duplicate detection)
   - `_findToolImplementation(toolName)` — searches Saico hierarchy (up then down) for `TOOL_<name>` method
   - `interpretAndApplyChanges(call)` — finds matching `TOOL_` method, JSON.parses args, invokes
   - Message queueing for pending tool calls
   - Summarization support
   - `_createMsgQ(preamble, add_tag, tag_filter)` — when preamble is provided (by Saico), it is prepended as-is and does NOT count against QUEUE_LIMIT. Otherwise falls back to standalone behavior (own prompt + tool digest)
   - `_processSendMessage` uses `_preamble` and `_aggregatedFunctions` from opts when available
   - `getFunctions()` aggregates from ancestor contexts (standalone fallback)
   - `context.js` still exists as a backward-compatibility shim re-exporting from `msgs.js`

5. **dynamo.js** - DynamoDB storage adapter (generalized from backend/aws.js)
   - `DynamoDBAdapter` class with full CRUD: `put`, `get`, `delete`, `query`, `getAll`
   - Update operations: `update`, `updatePath`, `listAppend`, `listAppendPath`
   - Counter operations: `nextCounterId`, `getCounterValue`, `setCounterValue`
   - Utility: `countItems`
   - All methods accept optional `table` override (defaults to constructor table)
   - AWS SDK v3 packages are optional peer dependencies (loaded only when needed)
   - Injectable client for testing

6. **openai.js** - OpenAI API wrapper with retry logic
   - Handles rate limiting (429 errors) with automatic retry
   - Supports modern tools API
   - Requires OPENAI_API_KEY environment variable

7. **store.js** - Storage abstraction layer
   - `Store` singleton with Redis cache + pluggable backends
   - `DynamoBackend` for Store's internal persistence (save/load/delete by ID)

8. **redis.js** - Optional Redis persistence layer
   - Creates observable proxies for automatic state persistence
   - Debounced saves with change detection
   - Properties prefixed with `_` are internal and not persisted

9. **util.js** - Utilities including token counting and logging

### Key Patterns

**Saico Lifecycle**: Separate construction from activation:
- `new Saico(opt)` — creates instance with Redis proxy + DB access. No Itask yet.
- `instance.activate({ createQ: true })` — creates internal Itask + optional message Q context
- `instance.deactivate()` — bubbles cleaned messages to parent, closes context, cancels task
- `instance.closeSession()` — closes context and cancels task
- DB methods (`dbGetItem`, etc.) work before and after activation

**Pluggable DB Backend**: The Saico class has generic DB methods that delegate to `this._db`:
- Configure via `opt.dynamodb_table` (auto-creates DynamoDBAdapter) or `opt.db` (any adapter)
- All `db*` methods are no-ops when no backend is configured
- DB retrieval methods call `_deserializeRecord()` hook — override to restore class instances
- Any adapter implementing the same interface (put/get/delete/query/getAll/update/updatePath/listAppend/listAppendPath/nextCounterId/getCounterValue/setCounterValue/countItems) can be used

**Task Hierarchy**: Parent-child relationship where:
- Tasks can have contexts attached (optional)
- Child tasks inherit functions from parents; `TOOL_` methods are discovered by searching the Saico hierarchy
- `findDeepestContext()` walks down to find the deepest active descendant with a context

**Message Flow (Saico orchestration)**:
```
sendMessage() on Saico instance:

Saico A (root, with Context)
  +- Saico B (with Context)
       +- Saico C (current, with Context)
            sendMessage('hello')
                 |
                 v
    1. Walk Saico parent chain (_getSaicoAncestors):
       A -> B -> C  (stop at isolate boundary)

    2. For each Saico in chain, collect:
       - prompt (system message)
       - _getStateSummary(activeCtx) — own summary + recent msgs if not active Q
       - tool_digest (if context has entries)
       - functions

    3. Build preamble array: [A.prompt, A.summary, A.digest, B.prompt, ...]

    4. Pass preamble + aggregated functions to Context via opts:
       ctx.sendMessage('user', content, null, { _preamble, _aggregatedFunctions })

    5. Context._createMsgQ prepends preamble, appends own Q messages (QUEUE_LIMIT applies only to Q)

    6. Send to LLM with aggregated functions

    7. Handle tool calls with depth control
```

**recvChatMessage routing**: routes DOWN to `findDeepestContext()` — the deepest active descendant with a message Q receives the user message.

**opt.isolate**: When a Saico is created with `isolate: true`, its `_getSaicoAncestors()` returns only itself — parent prompts, tools, digests, and summaries are NOT aggregated above this point.

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
  opts: { summary?, noreply?, nofunc?, timeout?, _preamble?, _aggregatedFunctions? },
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
            functions: [{ name: 'lookup', ... }],
            userData: { userId },
        });
    }

    async start() {
        // DB works BEFORE activate
        const user = await this.dbGetItem('id', this.getUserData('userId'));

        // activate creates Itask + message Q
        this.activate({ createQ: true, prompt: `User: ${this.getUserData('userId')}` });
        return this;
    }

    getStateSummary() {
        return `Active user: ${this.getUserData('userId')}`;
    }

    // Tool implementations — TOOL_ prefix + tool name
    async TOOL_lookup(args) {
        const result = await this.dbGetItem('id', args.id);
        return result ? JSON.stringify(result) : 'Not found';
    }
}

const agent = new MyAgent('user-123');
await agent.start();
const reply = await agent.recvChatMessage('Hello!');
```

**Saico DB methods** (backend-agnostic):
```javascript
// CRUD
await this.dbPutItem({ id: '123', name: 'test' });
const item = await this.dbGetItem('id', '123');  // calls _deserializeRecord()
await this.dbDeleteItem('id', '123');
const items = await this.dbQuery('email-index', 'email', 'user@test.com');  // calls _deserializeRecord()
const all = await this.dbGetAll();  // calls _deserializeRecord()

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

**Session management**:
```javascript
const session = new Saico({
    name: 'my-session',
    prompt: 'You are a helpful assistant',
    functions: [{ name: 'myFunc', ... }],
    userData: { userId: '123' },
    sessionConfig: { max_depth: 3, queue_limit: 50 },
});
session.activate({ createQ: true });

// Send messages
const reply = await session.sendMessage('Backend instruction');  // [BACKEND] prefixed
const chatReply = await session.recvChatMessage('Hello!');       // user message, routes to deepest Q

// User data
session.setUserData('role', 'admin');
session.getUserData('role');  // 'admin'

// Session info
session.getSessionInfo();  // { id, name, running, completed, messageCount, ... }

// Close
await session.closeSession();
```

**Spawning Child Tasks**:
```javascript
// Task with its own context (inherits sessionConfig defaults)
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

**Isolate (stop ancestor aggregation)**:
```javascript
const isolated = new Saico({
    name: 'isolated-agent',
    prompt: 'Independent agent prompt',
    isolate: true,  // parent prompts/tools/digests not included
});
isolated.activate({ createQ: true, parent: parentSaico._task });
```

**Legacy createQ (backward compatibility)**:
```javascript
const { createQ } = require('saico');

const ctx = createQ('You are a helpful assistant', null, 'my-tag', 1000);
const reply = await ctx.sendMessage('user', 'Hello', functions);
```

**Serialization**:
```javascript
// Save session
const serialized = session.serialize();

// Restore session
const restored = Saico.deserialize(serialized);
```

**DB deserialization hook**:
```javascript
class MyService extends Saico {
    _deserializeRecord(raw) {
        // Transform raw DB records, e.g. restore class instances
        if (raw.type === 'order') return new Order(raw);
        return raw;
    }
}
```

### Tool Implementation (TOOL_ methods)

Tool implementations are defined as methods on Saico subclasses with a `TOOL_` prefix. When the LLM returns a tool call (e.g., `get_weather`), Context searches the Saico hierarchy (up and down) for a `TOOL_get_weather(args)` method and invokes it with the parsed arguments object.

```js
class MyAgent extends Saico {
    async TOOL_get_weather(args) {
        // args is already parsed (JSON.parse'd)
        const weather = await fetchWeather(args.location);
        return weather;  // string or { content: string, functions?: [] }
    }
}
```

Search order: current Saico → walk UP parents → walk DOWN children (BFS). First match wins.

### File Structure

```
/saico
+-- index.js          # Main entry point (exports Saico, DynamoDBAdapter, Itask, Context, etc.)
+-- saico.js          # Master class (extend this)
+-- itask.js          # Base task class
+-- msgs.js           # Message/conversation context (renamed from context.js)
+-- context.js        # Backward-compat shim re-exporting from msgs.js
+-- dynamo.js         # DynamoDB storage adapter
+-- store.js          # Store abstraction (Redis + backends)
+-- openai.js         # OpenAI wrapper
+-- util.js           # Utilities
+-- redis.js          # Redis persistence
+-- test/
    +-- saico.test.js       # Saico class tests
    +-- dynamo.test.js      # DynamoDB adapter tests
    +-- itask.test.js       # Task hierarchy tests
    +-- context.test.js     # Message handling tests
    +-- integration.test.js # Full hierarchy flow tests
```

### Testing Framework

Uses Mocha with Chai and Sinon for:
- Saico class lifecycle, DB delegation, subclass extension, Redis proxy, sendMessage orchestration, recvChatMessage routing, preamble building, opt.isolate, deactivate bubbling, userData, sessionConfig, serialize/deserialize, DB deserialize hook, closeSession, getSessionInfo (saico.test.js)
- DynamoDB adapter with mocked client (dynamo.test.js)
- Task hierarchy, states, cancellation, findDeepestContext (itask.test.js)
- Message handling, tool calls, _createMsgQ with preamble support (context.test.js)
- Full hierarchy message flow, legacy compatibility (integration.test.js)

Test files mock external dependencies (OpenAI API, token counting, DynamoDB client) for isolated unit testing. DB adapter tests inject a mock client via `opt.client`.
