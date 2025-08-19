# Saico - Simple AI-agent Conversation Orchestrator

`Saico` is a minimal yet powerful JavaScript/Node.js library for managing AI conversations with hierarchical context, token-aware summarization, and **enterprise-grade tool calling capabilities**. It's designed to support complex nested conversations while maintaining clean summaries and parent context, making it ideal for AI agents, assistants, and customer support bots.

---

## ✨ Features

- 📚 **Hierarchical Conversations** — Track parent-child chat contexts with summary propagation.
- 🧵 **Scoped Memory** — Manage sub-conversations independently while maintaining parent relevance.
- 🔁 **Token-Aware Summarization** — Automatically summarize message history based on token thresholds.
- 💬 **Message-Level Metadata** — Track reply state, summaries, and custom flags.
- 🛠️ **OpenAI-Compatible Format** — Built for seamless interaction with OpenAI-compatible APIs.
- 🧰 **Proxy-Based Interface** — Interact with message history like an array, with extra powers.
- **🚀 NEW: Tool Calls** — Complete tool calling system with depth control, deferred execution, and safety features.

---

## 🔧 Tool Calls System

Saico now includes a sophisticated tool calling system with enterprise-grade safety and control features:

### Key Features:
- **🎛️ Depth Control** — Prevent infinite recursion with configurable depth limits
- **🔄 Deferred Execution** — Tool calls automatically defer and resume when depth limits reached
- **🚫 Duplicate Protection** — Identical tool calls blocked while active to prevent resource waste
- **⏱️ Timeout Handling** — Configurable timeouts (default: 5s) with graceful failure
- **🔁 Repetition Prevention** — Block excessive repeated tool calls (default: 20 max)
- **📥 Message Queuing** — Messages automatically queue when tool calls are pending
- **👨‍👩‍👧‍👦 Parent-Child Inheritance** — Unresponded tool calls move from parent to child contexts

---

## 📦 Installation

```bash
npm install saico-ai-thread --save
```

Or clone manually:

```bash
git clone https://github.com/wanderli-ai/saico
cd saico
```

---

## 🧑‍💻 Usage

### Basic Setup with Tool Handler

```js
const { createQ } = require('saico');

// Define your tool handler
async function toolHandler(toolName, argumentsString) {
  const args = JSON.parse(argumentsString);
  
  switch (toolName) {
    case 'get_weather':
      return `Weather in ${args.location}: 72°F, sunny`;
    case 'book_hotel':
      return `Booked ${args.hotel} for ${args.nights} nights`;
    default:
      return 'Tool not found';
  }
}

// Create conversation with tool support
const q = createQ(
  "You are a helpful assistant.",  // prompt
  null,                            // parent (null for root)
  "main",                         // tag
  4000,                           // token limit  
  null,                           // initial messages
  toolHandler,                    // tool handler function
  { max_depth: 5, max_tool_repetition: 20 } // config
);

// Send a message that might trigger tool calls
await q.sendMessage('user', 'What\'s the weather in New York?');
```

### Create a Sub-Conversation with Tool Inheritance

```js
const subQ = q.spawnChild(
  "Now focus only on hotel bookings.", // prompt
  "hotels",                           // tag
  null,                              // token limit (inherits from parent)
  null,                              // initial messages
  null,                              // tool handler (inherits from parent)
  { max_depth: 3 }                   // custom config
);

await subQ.sendMessage('user', 'Book me something in Rome.');
await subQ.close(); // Automatically summarizes and passes back to parent
```

### Advanced Tool Configuration

```js
const q = createQ(
  "You are a travel assistant.",
  null,
  "travel",
  8000,
  null,
  toolHandler,
  {
    max_depth: 8,              // Allow deeper tool call chains
    max_tool_repetition: 10    // Be more strict about repetitions
  }
);

// Send message with custom tool options
await q.sendMessage('user', 'Plan my trip', null, {
  handler: customToolHandler,    // Override default tool handler
  timeout: 10000,               // 10 second timeout for this message's tools
  nofunc: false                 // Ensure tool calls are enabled
});
```

### Hierarchy Example with Tool Calls

```text
[Main] (toolHandler: generalTools)
 ├── [hotels] (inherits generalTools) ➜ tool calls + summary returned to [Main]  
 └── [flights] (inherits generalTools) ➜ tool calls + summary returned to [Main]
```

---

## 🧠 Enhanced Message API

Each message is stored with enhanced tool call support:

```js
{
  msg: { 
    role,           // 'user', 'assistant', 'tool', 'system'
    content,        // Message content
    name?,          // Optional name for user/tool messages
    tool_calls?,    // Array of tool calls from assistant
    tool_call_id?   // ID linking tool responses to calls
  },
  opts: { 
    summary?,       // Is this a summary message?
    noreply?,       // Skip AI reply for this message
    nofunc?,        // Disable tool calls for this message  
    handler?,       // Custom tool handler override
    timeout?        // Custom timeout for tool calls
  },
  msgid: String,    // Unique message identifier
  replied: 0 | 1 | 3 // 0=pending, 1=user sent, 3=AI replied
}
```

### Enhanced API Methods

* `q[0]` — Access nth message
* `q.length` — Total messages
* `q.pushSummary(summary)` — Manually inject a summary
* `q.getMsgContext()` — Get summarized parent chain
* `q.serialize()` — Export current state
* **NEW**: `q._hasPendingToolCalls()` — Check for pending tool executions
* **NEW**: `q._processWaitingQueue()` — Manually process queued messages

---

## 🛡️ Tool Call Safety Features

### Depth Control & Deferred Execution
```js
const q = createQ("Assistant", null, "main", 4000, null, toolHandler, {
  max_depth: 3  // Tool calls defer at depth 4+
});

// When max depth reached:
// 1. Tool calls are deferred (not executed immediately)
// 2. Conversation continues normally  
// 3. Deferred tools execute when depth reduces
// 4. Results are seamlessly integrated back
```

### Repetition Prevention
```js
const q = createQ("Assistant", null, "main", 4000, null, toolHandler, {
  max_tool_repetition: 5  // Block tools called >5 times consecutively
});

// Automatically filters excessive repeated tool calls
// Logs: "Dropping excessive tool call: get_weather (hit max_tool_repetition=5)"
```

### Duplicate Detection
```js
// If two identical tool calls (same name + arguments) are active:
// Second call returns: "Duplicate call detected. Please wait for previous call to complete."
```

### Timeout Handling
```js
// Tool calls automatically timeout (default: 5s)
// Returns: "Tool call 'slow_function' timed out after 5 seconds"

// Custom timeout per message:
await q.sendMessage('user', 'Run slow analysis', null, { timeout: 30000 });
```

---

## 🧪 Summary Behavior

Summaries trigger when total token count exceeds 85% of the limit and are always triggered when `close()` is called.
Summaries are:

* Injected as special `[SUMMARY]: ...` messages
* Bubbled up into the parent context
* Excluded from re-summarization unless explicitly kept
* **NEW**: Include tool call results in summarization context

---

## 🔄 Redis Integration (Persistent Observable State)

This library includes an optional Redis-based persistence layer to automatically store and update conversation objects (or any JS object) using a **proxy-based observable**.

It supports:

* 🔄 **Auto-saving on change** (with debounce)
* 🧠 **Selective serialization** (skips internal/private `_` properties)  
* 🗃️ **Support for serializing `Messages` class**
* 🔍 **Efficient diff-checking** (saves only when changed)
* **NEW**: **Tool call state persistence** (active calls, deferred calls, waiting queues)

### 🔧 Setup

1. Install `redis`:

```bash
npm install redis
```

2. Initialize Redis:

```js
const { init, createObservableForRedis } = require('./redis-store');
await init(); // connects to redis://localhost:6379
```

3. Wrap a tool-enabled conversation:

```js
const { createQ } = require('./saico');
const q = createQ("Travel assistant", null, "flights", 3000, null, toolHandler);

// Wrap with Redis observable - tool states auto-persist
const obsQ = createObservableForRedis("q:session:12345", q);
```

Now, any changes to `obsQ` including tool call states, deferred calls, and message queues are **automatically saved** to Redis.

---

## 🧼 Auto-Sanitization Rules

When saving to Redis:

* All keys starting with `_` are ignored.
* Custom `.serialize()` methods (like on `Messages`) are respected.
* Object updates are **debounced (1s)** and only saved if actual changes are detected.
* **NEW**: Tool call tracking data is sanitized automatically

---

## 🔌 OpenAI Integration

This library supports the modern OpenAI Tools API:

* **NEW**: Native `tool_calls` support (OpenAI's current standard)
* Backward compatibility with legacy `functions` format
* Automatic format conversion in openai.js
* Built-in retry logic with exponential backoff for rate limits

```js
// OpenAI will return tool_calls in responses:
{
  role: 'assistant',
  content: 'I need to check the weather',
  tool_calls: [{
    id: 'call_abc123',
    type: 'function', 
    function: {
      name: 'get_weather',
      arguments: '{"location": "New York"}'
    }
  }]
}

// Saico handles the complete tool execution cycle automatically
```

---

## 🧪 Testing

Comprehensive test suite with **37 tests** covering:

* Core conversation management (25 tests)
* **NEW**: Tool calls functionality (12 tests):
  - Basic tool execution
  - Depth limits and deferred execution
  - Repetition prevention and filtering
  - Duplicate detection
  - Message queuing systems
  - Timeout handling
  - Parent-child tool inheritance

```bash
npm test  # Run full test suite
```

---

## 📁 Project Structure

```
.
├── saico.js         # Core implementation with tool calls
├── openai.js        # OpenAI API wrapper with tools support
├── redis.js         # Saico compatible redis wrapper  
├── util.js          # Utilities: token counting, etc.
├── test.js          # Comprehensive test suite
├── msgs.js          # Original enhanced version (reference)
└── README.md        # This file
```

---

## 🚀 Migration Guide

If upgrading from older versions:

### Old API:
```js
const q = createQ(prompt, opts, msgs, parent);
```

### New API:  
```js
const q = createQ(prompt, parent, tag, token_limit, msgs, tool_handler, config);
```

### Breaking Changes:
- Constructor parameter order changed
- `opts.tag` → `tag` parameter
- `opts.token_limit` → `token_limit` parameter  
- Added `tool_handler` and `config` parameters
- `function_call` → `tool_calls` in OpenAI responses

---

## 🔐 License

MIT License © [Wanderli.ai]

---

## 🙌 Contributing

Pull requests, issues, and suggestions welcome! Please fork the repo and open a PR, or submit issues directly.

Areas where contributions are especially welcome:
- Additional tool call safety features
- Performance optimizations for large conversations
- Extended test coverage
- Documentation improvements

---

## 📣 Acknowledgements

This project was inspired by the need for a lightweight, non-opinionated alternative to LangChain's memory modules, with full support for real-world LLM conversation flows and enterprise-grade tool calling capabilities.

---

## 🔮 Roadmap

- [ ] **Multi-model support** (Anthropic, Google, etc.)
- [ ] **Advanced tool call analytics** and monitoring
- [ ] **Custom summarization strategies** 
- [ ] **Tool call result caching**
- [ ] **Streaming tool call responses**
- [ ] **Tool call permission systems**

Let me know if you'd like to see any of these features prioritized!
