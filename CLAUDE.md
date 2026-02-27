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
|  |    Itask     |    |    Msgs      |                               |
|  |  (Base Task) |<---|  (msgs.js)   |                               |
|  +--------------+    +--------------+                               |
|                                                                     |
|  +-------------------+    +-------------------+                     |
|  |      Store        |    | DynamoDBAdapter   |                     |
|  | (Redis helper)    |    |  (dynamo.js)      |                     |
|  +-------------------+    +-------------------+                     |
|                                                                     |
+---------------------------------------------------------------------+
```

1. **index.js** - Thin barrel file exporting all classes
   - `Saico` - Master class (external users extend this)
   - `DynamoDBAdapter` - DynamoDB storage adapter
   - `Itask` - Base task class
   - `Msgs` - Message queue class
   - `createMsgs()` - Factory for standalone message queues
   - `init()` - Redis initialization + backend registration

2. **saico.js** - Master class for building AI-powered services
   - External users extend this instead of Itask
   - Constructor returns Redis observable proxy when Redis is available
   - **Msgs ownership**: `this.msgs` and `this.msgs_id` live directly on Saico (not on Itask)
   - `activate(opts)` creates internal Itask and optional message Q; defaults to wait state when no states defined
   - `createQ` can be set via constructor opts, subclass property, or `activate({ createQ })` override
   - `states` (task functions) can be set as `this.states` on the class or via `activate({ states })` override
   - `opts.prompt` appends to class-level prompt (NOT a trigger for msgs Q creation)
   - **sendMessage orchestration**: walks Saico parent chain to build preamble (prompts, state summaries, tool digests) and aggregated functions, passes to Msgs via `_preamble` and `_aggregatedFunctions` opts
   - **recvChatMessage routing**: routes DOWN to deepest descendant with a msg Q
   - `opt.isolate` stops ancestor aggregation at this Saico boundary
   - Generic DB methods (`dbPutItem`, `dbGetItem`, `dbQuery`, etc.) delegate to pluggable backend; table name required on every call
   - `_getDb()` searches up parent Saico chain when no local `_db`; falls back to `Saico._backend`; throws if none found
   - DB retrieval methods (`dbGetItem`, `dbQuery`, `dbGetAll`) call `_deserializeRecord()` hook
   - `opt.dynamodb = { region, credentials }` auto-creates DynamoDBAdapter; `opt.db` accepts any adapter; `Saico.registerBackend('dynamodb', config)` for library-level registration
   - `opt.store` — table name string for instance persistence (used by `closeSession`/`rehydrate`)
   - Child spawning: `spawn(child)` and `spawnAndRun(child)` — parent must be activated; child is auto-activated if needed
   - Msgs methods: `findMsgs()`, `findDeepestMsgs()`
   - `_findToolImpl(toolName)` — searches Saico hierarchy (up then down) for `TOOL_<name>` method
   - Overridable `getStateSummary()` hook
   - `getRecentMessages(n)` — user/assistant messages (no tool calls, no BACKEND)
   - `_getStateSummary(activeMsgs)` — includes recent messages when msgs Q is not the active Q
   - **deactivate**: bubbles cleaned messages to parent Q, then closes msgs Q
   - User data: `userData`, `setUserData()`, `getUserData()`, `clearUserData()`
   - `this.id` — unique instance ID (not underscore-prefixed, persisted to Redis)
   - Session info: `getSessionInfo()`, `closeSession()`, `static rehydrate()`, `sessionConfig`
   - `prepareForStorage()` — creates clean snapshot: strips `_` props, skips functions/states, compresses msgs
   - Serialization: `async serialize()` calls `prepareForStorage()` then `JSON.stringify`; `static async Saico.deserialize()`
   - Static backend: `Saico.registerBackend(type, config)`, `Saico.getBackend()`, `Saico._backend`
   - `Saico.BACKEND_EXPLANATION` — static text appended to msgs Q prompts

3. **itask.js** - Pure task runner for hierarchical task management
   - Named state parsing (try, catch, finally, cancel)
   - Parent-child task hierarchy (Set-based children)
   - Cooperative cancellation
   - Promise/thenable interface
   - `spawn()` to attach child tasks
   - All tasks register as root; parent set via `itask.spawn()`
   - No context/message handling — that lives on Saico

4. **msgs.js** - Pure message queue (`Msgs` class)
   - Message queue management with Proxy wrapper (`createMsgs()`)
   - Tool call handling (depth control, deferred execution, duplicate detection)
   - `_findToolImplementation(toolName)` — delegates to `_findToolImpl` callback set by Saico
   - `interpretAndApplyChanges(call)` — finds matching `TOOL_` method, JSON.parses args, invokes
   - Callback hooks set by Saico: `_findToolImpl` (tool search), `_getSnapshot` (dirty detection)
   - Message queueing for pending tool calls
   - Summarization support
   - `_createMsgQ(preamble, add_tag, tag_filter)` — when preamble is provided (by Saico), it is prepended as-is and does NOT count against QUEUE_LIMIT. Otherwise falls back to standalone behavior (own prompt + tool digest)
   - `_processSendMessage` uses `_preamble` and `_aggregatedFunctions` from opts when available
   - Standalone fallback uses own `this.functions` (no hierarchy traversal)
   - `prepareForStorage()` — filters/trims/compresses _msgs for durable persistence
   - `initHistory()` — decompresses `_chat_history` into `_msgs` (called by `Saico.rehydrate`)
   - No task/store references — Msgs is a pure message queue

5. **dynamo.js** - DynamoDB storage adapter (generalized from backend/aws.js)
   - `DynamoDBAdapter` class with full CRUD: `put`, `get`, `delete`, `query`, `getAll`
   - Update operations: `update`, `updatePath`, `listAppend`, `listAppendPath`
   - Counter operations: `nextCounterId`, `getCounterValue`, `setCounterValue`
   - Utility: `countItems`
   - Table name required on every method call (no default table)
   - Constructor: `{ region, credentials: { accessKeyId, secretAccessKey }, client }`
   - AWS SDK v3 packages are optional peer dependencies (loaded only when needed)
   - Injectable client for testing

6. **openai.js** - OpenAI API wrapper with retry logic
   - Handles rate limiting (429 errors) with automatic retry
   - Supports modern tools API
   - Requires OPENAI_API_KEY environment variable

7. **store.js** - Minimal storage shell
   - `Store` singleton with Redis helper and ID generation
   - No backends — durable persistence handled by `Saico._backend` directly

8. **redis.js** - Optional Redis persistence layer
   - Creates observable proxies for automatic state persistence
   - Debounced saves with change detection
   - Properties prefixed with `_` are internal and not persisted

9. **util.js** - Utilities including token counting and logging

### Key Patterns

**Saico Lifecycle**: Separate construction from activation:
- `new Saico(opt)` — creates instance with Redis proxy + DB access. No Itask yet. `opt.createQ` and `this.states` can be set here.
- `instance.activate()` — creates internal Itask + optional message Q (uses `this.createQ` and `this.states` from class; defaults to wait state when no states defined)
- `instance.deactivate()` — bubbles cleaned messages to parent, closes msgs Q, cancels task
- `instance.closeSession()` — calls `prepareForStorage()`, saves to registered backend under `_storeName`, cancels task
- `Saico.rehydrate(id, { store })` — loads from registered backend, decompresses msgs, returns restored Saico
- DB methods (`dbGetItem`, etc.) work before and after activation

**Pluggable DB Backend**: The Saico class has generic DB methods that delegate to `_getDb()`:
- Library-level: `Saico.registerBackend('dynamodb', config)` — registers one shared backend
- Instance-level: `opt.dynamodb = { region, credentials }` (auto-creates DynamoDBAdapter) or `opt.db` (any adapter)
- `_getDb()` searches own `_db` first, then walks UP the parent Saico chain, then falls back to `Saico._backend`; throws if none found
- Table name is required on every `db*` call (no default table)
- DB retrieval methods call `_deserializeRecord()` hook — override to restore class instances
- Any adapter implementing the same interface (put/get/delete/query/getAll/update/updatePath/listAppend/listAppendPath/nextCounterId/getCounterValue/setCounterValue/countItems) can be used

**Task Hierarchy**: Parent-child relationship where:
- Msgs Q instances are owned by Saico instances (not by Itask)
- Child Saico instances are spawned via `parent.spawn(child)` (parent must be activated; child auto-activated if needed)
- `TOOL_` methods are discovered by searching the Saico hierarchy via `task._saico`
- Child Saico instances inherit DB access from parents via `_getDb()` parent chain search (falls back to `Saico._backend`)
- `findMsgs()` walks UP via `task._saico?.msgs` to find nearest msgs Q
- `findDeepestMsgs()` walks DOWN via `task.child` checking `child._saico?.msgs`

**Message Flow (Saico orchestration)**:
```
sendMessage() on Saico instance:

Saico A (root, with Msgs)
  +- Saico B (with Msgs)
       +- Saico C (current, with Msgs)
            sendMessage('hello')
                 |
                 v
    1. Walk Saico parent chain (_getSaicoAncestors):
       A -> B -> C  (stop at isolate boundary)

    2. For each Saico in chain, collect:
       - prompt (system message)
       - _getStateSummary(activeCtx) — own summary + recent msgs if not active Q
       - tool_digest (if msgs Q has entries)
       - functions

    3. Build preamble array: [A.prompt, A.summary, A.digest, B.prompt, ...]

    4. Pass preamble + aggregated functions to Msgs via opts:
       msgs.sendMessage('user', content, null, { _preamble, _aggregatedFunctions })

    5. Msgs._createMsgQ prepends preamble, appends own Q messages (QUEUE_LIMIT applies only to Q)

    6. Send to LLM with aggregated functions

    7. Handle tool calls with depth control
```

**recvChatMessage routing**: routes DOWN to `findDeepestMsgs()` — the deepest active descendant with a message Q receives the user message.

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
            createQ: true,  // message Q created on activate()
            dynamodb: { region: 'us-east-1', credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' } },
            functions: [{ name: 'lookup', ... }],
            userData: { userId },
        });

        // States defined on the class — activate() picks them up automatically
        this.states = [
            async function main() {
                const user = await this.dbGetItem('id', this.getUserData('userId'));
                return await this.sendMessage(`User ${user.name} loaded`);
            }
        ];
    }

    async start() {
        // DB works BEFORE activate
        const user = await this.dbGetItem('id', this.getUserData('userId'));

        // activate creates Itask + message Q (from this.createQ) with states (from this.states)
        this.activate({ prompt: `User: ${this.getUserData('userId')}` });
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

**Saico DB methods** (backend-agnostic, table required on every call):
```javascript
// CRUD
await this.dbPutItem({ id: '123', name: 'test' }, 'my-table');
const item = await this.dbGetItem('id', '123', 'my-table');  // calls _deserializeRecord()
await this.dbDeleteItem('id', '123', 'my-table');
const items = await this.dbQuery('email-index', 'email', 'user@test.com', 'my-table');  // calls _deserializeRecord()
const all = await this.dbGetAll('my-table');  // calls _deserializeRecord()

// Updates
await this.dbUpdate('id', '123', 'status', 'active', 'my-table');
await this.dbUpdatePath('id', '123', [{key: 'nested'}], 'field', 'value', 'my-table');
await this.dbListAppend('id', '123', 'tags', 'new-tag', 'my-table');

// Counters
const nextId = await this.dbNextCounterId('OrderId', 'counters');
const count = await this.dbGetCounterValue('OrderId', 'counters');
await this.dbSetCounterValue('OrderId', 100, 'counters');

// Utility
const total = await this.dbCountItems('my-table');
```

**Backend registration** (one-time, library-level):
```javascript
const { Saico, init } = require('saico');

// Option A: via init()
await init({ dynamodb: { region: 'us-east-1', credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' } } });

// Option B: direct registration
Saico.registerBackend('dynamodb', { region: 'us-east-1', credentials: { ... } });
```

**Session management**:
```javascript
const session = new Saico({
    name: 'my-session',
    prompt: 'You are a helpful assistant',
    functions: [{ name: 'myFunc', ... }],
    userData: { userId: '123' },
    store: 'sessions',  // table name for instance persistence
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

// Close — prepareForStorage + save to registered backend under 'sessions' table, cancels task
await session.closeSession();

// Rehydrate — restore from registered backend
const restored = await Saico.rehydrate(session.id, { store: 'sessions' });
```

**Spawning Child Saico Instances**:
```javascript
// Child with its own msgs Q (auto-activated by spawn)
const child = new Saico({
    name: 'subtask',
    prompt: 'Handling a specific sub-task',
    createQ: true,
});
session.spawn(child);  // auto-activates child, attaches under parent

// Send message from child (preamble aggregated from parent chain)
await child.sendMessage('Working...');

// Child without msgs Q (uses parent's msgs Q via findMsgs())
const simple = new Saico({ name: 'simple' });
session.spawn(simple);
await simple.sendMessage('Quick operation');  // finds parent's msgs Q

// spawnAndRun: spawn + schedule child._task._run() on nextTick
const runner = new Saico({ name: 'runner' });
runner.states = [async function() { return await this.sendMessage('Go'); }];
session.spawnAndRun(runner);
```

**Isolate (stop ancestor aggregation)**:
```javascript
const isolated = new Saico({
    name: 'isolated-agent',
    prompt: 'Independent agent prompt',
    createQ: true,
    isolate: true,  // parent prompts/tools/digests not included
});
parentSaico.spawn(isolated);
```

**Serialization / Persistence**:
```javascript
// prepareForStorage — clean snapshot (strips _ props, compresses msgs)
const data = await session.prepareForStorage();

// serialize — calls prepareForStorage() then JSON.stringify
const json = await session.serialize();
const restored = await Saico.deserialize(json);

// Durable persistence (uses registered backend)
await session.closeSession();  // prepareForStorage + save to backend under opt.store table
const restored2 = await Saico.rehydrate(id, { store: 'sessions' });
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

Tool implementations are defined as methods on Saico subclasses with a `TOOL_` prefix. When the LLM returns a tool call (e.g., `get_weather`), Msgs delegates to its `_findToolImpl` callback (set by Saico), which searches the Saico hierarchy (up and down) for a `TOOL_get_weather(args)` method and invokes it with the parsed arguments object.

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
+-- index.js          # Thin barrel file (exports Saico, DynamoDBAdapter, Itask, Msgs, etc.)
+-- saico.js          # Master class (extend this) — owns msgs Q, spawn, DB, orchestration
+-- itask.js          # Pure task runner — hierarchy, states, cancellation, promises
+-- msgs.js           # Message/conversation context
+-- dynamo.js         # DynamoDB storage adapter
+-- store.js          # Minimal storage shell (Redis helper + ID generation)
+-- openai.js         # OpenAI wrapper
+-- util.js           # Utilities
+-- redis.js          # Redis persistence
+-- test/
    +-- saico.test.js       # Saico class tests
    +-- dynamo.test.js      # DynamoDB adapter tests
    +-- itask.test.js       # Pure task hierarchy tests
    +-- context.test.js     # Message handling tests
    +-- integration.test.js # Full hierarchy flow tests
    +-- storage.test.js    # Storage layer integration tests (stubbed AWS client)
```

### Testing Framework

Uses Mocha with Chai and Sinon for:
- Saico class lifecycle, msgs Q ownership, spawn/spawnAndRun, DB delegation, subclass extension, Redis proxy, sendMessage orchestration, recvChatMessage routing, preamble building, opt.isolate, deactivate bubbling, userData, sessionConfig, async serialize/deserialize, prepareForStorage, registerBackend, closeSession/rehydrate via registered backend, DB deserialize hook, getSessionInfo (saico.test.js)
- DynamoDB adapter with mocked client (dynamo.test.js)
- Pure task hierarchy, states, cancellation, wait/continue (itask.test.js)
- Msgs class, tool calls, _createMsgQ with preamble support, prepareForStorage, initHistory, callback hooks (context.test.js)
- Full hierarchy message flow, tool calls, serialization (integration.test.js)
- Storage layer end-to-end: registerBackend, closeSession/rehydrate round-trip, db* API through registered backend (storage.test.js)

Test files mock external dependencies (OpenAI API, token counting, DynamoDB client) for isolated unit testing. DB adapter tests inject a mock client via `opt.client`.
