````markdown
# Saico - Simple AI-agent Conversation Orchestrator

`Saico` is a minimal yet powerful JavaScript/Node.js library for managing AI conversations with hierarchical context, token-aware summarization, and fine-grained control over message flow. It’s designed to support complex nested conversations while maintaining clean summaries and parent context, making it ideal for AI agents, assistants, and customer support bots.

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
npm install messages-ai-thread --save
````

Or clone manually:

```bash
git clone https://github.com/yourusername/messages
cd messages
```

---

## 🧑‍💻 Usage

### Basic Setup

```js
const { createQ } = require('messages');
const openai = require('./openai'); // must expose `send(msgs, functions?)`

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

Summaries trigger when total token count exceeds 85% of the limit and are always triggered when `close()` is called. Summaries are:

* Injected as special `[SUMMARY]: ...` messages
* Bubbled up into the parent context
* Excluded from re-summarization unless explicitly kept

---

## 🔌 OpenAI Integration

This library expects an `openai.send(messages, functions)` method that:

* Accepts an array of messages in `{role, content}` format
* Optionally supports function calling

You must implement this externally. Example stub:

```js
async function send(messages, functions) {
    return await openai.chat.completions.create({ messages, functions });
}
```

---

## 📁 Project Structure

```
.
├── messages.js         # Core implementation
├── openai.js           # Your own wrapper for OpenAI (or any LLM)
├── util.js             # Utilities: token counting, logging, etc.
└── README.md
```

---

## 🔐 License

MIT License © \[Your Name or Org]

---

## 🙌 Contributing

Pull requests, issues, and suggestions welcome! Please fork the repo and open a PR, or submit issues directly.

---

## 📣 Acknowledgements

This project was inspired by the need for a lightweight, non-opinionated alternative to LangChain’s memory modules, with full support for real-world LLM conversation flows.

```

---

Let me know if you'd like:
- a sample `openai.js`
- GitHub Actions CI badge
- NPM publishing support
- Docs site or typedoc config
```

