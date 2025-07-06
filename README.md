````markdown
# Saico - Simple AI-agent Conversation Orchestrator

`Saico` is a minimal yet powerful JavaScript/Node.js library for managing AI conversations with hierarchical context,
token-aware summarization, and fine-grained control over message flow. It’s designed to support complex nested 
conversations while maintaining clean summaries and parent context, making it ideal for AI agents, assistants, and 
customer support bots.

---

## ✨ Features

- 📚 **Hierarchical Conversations** — Track parent-child chat contexts with summary propagation.
- 🧵 **Scoped Memory** — Manage sub-conversations independently while maintaining parent relevance.
- 🔁 **Token-Aware Summarization** — Automatically summarize message history based on token thresholds.
- 💬 **Message-Level Metadata** — Track reply state, summaries, and custom flags.
- 🛠️ **OpenAI-Compatible Format** — Built for seamless interaction with OpenAI-compatible APIs.
- 🧰 **Proxy-Based Interface** — Interact with message history like an array, with extra powers.

---

## 📦 Installation

```bash
npm install saico-ai-thread --save
````

Or clone manually:

```bash
git clone https://github.com/wanderli-ai/saico
cd saico
```

---

## 🧑‍💻 Usage

### Basic Setup

```js
const { createQ } = require('saico');
const openai = require('./openai');

const q = createQ("You are a helpful assistant.", null, "main", 4000);

// Push a message
await q.sendMessage('user', 'What’s the weather like tomorrow?', [], {});
```

### Create a Sub-Conversation

```js
const subQ = createQ("Now focus only on the user's hotel bookings.", q, "hotels");

await subQ.sendMessage('user', 'Book me something in Rome.');
await subQ.close(); // Automatically summarizes and passes back to `q`
```

### Hierarchy Example

```text
[Main]
 └── [hotels] ➜ summarized & returned to [Main]
```

---

## 🧠 Message API

Each message is stored as:

```js
{
  msg: { role, content, name? },
  opts: { summary?, noreply?, nofunc? },
  msgid: String,
  replied: 0 | 1 | 3
}
```

The conversation history is internally managed and can be accessed via:

* `q[0]` — Access nth message
* `q.length` — Total messages
* `q.pushSummary(summary)` — Manually inject a summary
* `q.getMsgContext()` — Get summarized parent chain
* `q.serialize()` — Export current state

---

## 🧪 Summary Behavior

Summaries trigger when total token count exceeds 85% of the limit and are always triggered when `close()` is called.
Summaries are:

* Injected as special `[SUMMARY]: ...` messages
* Bubbled up into the parent context
* Excluded from re-summarization unless explicitly kept

Here’s an updated `README.md` section to document the new Redis integration with observable storage:

---

## 🔄 Redis Integration (Persistent Observable State)

This library includes an optional Redis-based persistence layer to automatically store and update conversation objects (or any JS object) using a **proxy-based observable**.

It supports:

* 🔄 **Auto-saving on change** (with debounce)
* 🧠 **Selective serialization** (skips internal/private `_` properties)
* 🗃️ **Support for serializing `Messages` class**
* 🔍 **Efficient diff-checking** (saves only when changed)

### 🔧 Setup

1. Install `redis`:

```bash
npm install redis
```

2. Initialize Redis:

```js
const { init, createObservableForRedis } = require('./redis-store'); // adjust path if needed
await init(); // connects to redis://localhost:6379
```

3. Wrap an object to persist changes:

```js
const { createQ } = require('./messages');
const q = createQ("You're a travel assistant.", null, "flights", 3000);

// Wrap with Redis observable
const obsQ = createObservableForRedis("q:session:12345", q);
```

Now, any changes to `obsQ` (e.g., sending messages, updating properties) are **automatically saved** to Redis.

### 💡 Use Case: Full User Context

You can also persist a full user session context:

```js
const userContext = {
  userId: 'abc123',
  trip: {},
  q: createQ("Trip assistant", null, "trip", 3000)
};

const observableUser = createObservableForRedis(`user:abc123`, userContext);
```

### 🔍 Inspecting Last Save

You can retrieve the last save timestamp:

```js
console.log("Last Redis save:", observableUser.lastMod?.());
```

---

## 🧼 Auto-Sanitization Rules

When saving to Redis:

* All keys starting with `_` are ignored.
* Custom `.serialize()` methods (like on `Messages`) are respected.
* Object updates are **debounced (1s)** and only saved if actual changes are detected.

---

## 🧪 Example Redis Dump (for a `Messages` instance)

```json
{
  "0": { "role": "user", "content": "What’s my itinerary?" },
  "1": { "role": "assistant", "content": "Here's your plan..." },
  "lastSave": 1720371212345
}
```
---

## 🔌 OpenAI Integration

This library expects you to have openai credentials. Support for other model types will be added soon.

* Accepts an array of messages in `{role, content}` format
* Optionally supports function calling

---

## 📁 Project Structure

```
.
├── saico.js         # Core implementation
├── openai.js        # Openai api wrapper
├── redis.js         # Saico compatible redis wrapper
├── util.js          # Utilities: token counting, etc.
└── README.md
```

---

## 🔐 License

MIT License © \[Wanderli.ai]

---

## 🙌 Contributing

Pull requests, issues, and suggestions welcome! Please fork the repo and open a PR, or submit issues directly.

---

## 📣 Acknowledgements

This project was inspired by the need for a lightweight, non-opinionated alternative to LangChain’s memory modules, 
with full support for real-world LLM conversation flows.

```

---

Let me know if you'd like:
- GitHub Actions CI badge
- NPM publishing support
- Docs site or typedoc config
```

