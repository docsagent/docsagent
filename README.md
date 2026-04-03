# DocsAgent 🛡️

**The High-Performance Local Intelligence Layer for AI Agents.**

DocsAgent is a professional, local-first document intelligence engine and MCP (Model Context Protocol) server. It provides a secure, near-instant bridge between your private local files and advanced agentic platforms like **OpenClaw**, **Claude Code**, and **Cursor**.

**100% Local. 100% Private. Zero Data Leakage.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![OS: macOS / Windows / Linux](https://img.shields.io/badge/OS-macOS%20|%20Windows%20|%20Linux-black.svg)](#)

---

### 🔥 Why DocsAgent?

Modern AI Agents are incredibly smart, but they are "blind" to your private desktop documents. DocsAgent acts as a **High-Performance Intelligence Engine** that indexes your local data, allowing agents to search, read, and analyze thousands of files (1,000+) with absolute privacy.

*   **🔒 Absolute Privacy:** All document parsing, indexing, and vector storage happen strictly on your own hardware. Your data never leaves your machine.
*   **⚡ High-Performance Core:** Powered by a native C++ engine. Experience millisecond-level retrieval even across massive document libraries.
*   **🔌 MCP Native:** Built-in support for the **Model Context Protocol (MCP)**, making it instantly compatible with the latest AI tools.
*   **📂 Format Mastery:** Native parsing for PDF, Word (.docx), Excel (.xlsx), PPTX, Markdown, and TXT.
*   **🤖 Local LLM Ready:** Works seamlessly with Claude 3.5/GPT-4o or run completely air-gapped with local models via Ollama.

---

### 🚀 Quick Start

#### 1. Install via NPM
```bash
npm install -g @docsagent/docsagent
```

#### 2. CLI Usage (Local Indexing & Search)
DocsAgent provides a powerful CLI for managing your local knowledge base.

*   **Index your folders:**
    ```bash
    # Add one or more directories or files to the index
    docsagent add ~/Documents/Legal_Archive ~/Documents/Research
    ```
*   **Search your documents:**
    ```bash
    # Perform a semantic search directly from the terminal
    docsagent search "What are the key terms in the Barclays contract?"
    ```

#### 3. MCP Usage (Connect to AI Agents)
DocsAgent is a native **Model Context Protocol (MCP)** server. This allows AI agents to "see" your local documents.

**Start the MCP server:**
```bash
docsagent server
```

---

### 🔌 Agent Integration Examples

Connect DocsAgent to your favorite tools using the following configurations:

#### **OpenClaw (Recommended)**
OpenClaw is the most powerful UI for local-first agents. Add DocsAgent in your `config.yaml`:
```yaml
mcpServers:
  docsagent:
    command: "docsagent"
    args: ["server"]
```

#### **Claude Code**
Integrate with Anthropic's CLI tool:
```bash
claude code mcp add docsagent -- docsagent server
```

#### **Cursor / Windsurf**
1. Open **Settings** > **Features** > **MCP Servers**.
2. Click **+ Add New MCP Server**.
3. Name: `DocsAgent`
4. Type: `command`
5. Command: `docsagent server`

---

### 🛠️ Agent Tools (via MCP)

Once integrated, your AI agent gains professional-grade document capabilities through these tools:

- **`search`**: Perform deep semantic search across your entire local library to find relevant snippets.
- **`add_docs`**: Instantly index new local folders or files during a conversation.
- *(More tools coming soon: `list_documents`, `remove_document`, `status`)*

---

### 💻 CLI Reference

DocsAgent provides a powerful CLI with convenient aliases (`dag`, `da`):

| Command | Alias Example | Description |
| :--- | :--- | :--- |
| `server` | `da server` | Start the MCP server service |
| `add` | `dag add <path>` | Add directories or files to the index |
| `search` | `da search "query"`| Search for documents directly from CLI |
| `status`| `dag status` | Check engine and indexing status |
| `stop`  | `da stop` | Stop the background engine service |

---

### 📂 Support Matrix

| Format | Status | Features |
| :--- | :--- | :--- |
| **PDF** | ✅ Full | Deep layout analysis & high-speed parsing |
| **Word (.docx)** | ✅ Full | Table extraction & heading hierarchy preserved |
| **PPTX** | ✅ Full | Extracts slides, shapes, and speaker notes |

---

### 🤝 Community & Contributing

We are building the open standard for Local RAG. Join us in making AI respect personal data sovereignty!

- **GitHub Issues:** Found a bug? Have a feature request? Open an issue.
- **Star the Repo:** If DocsAgent improved your workflow, please give us a ⭐ to help others find the project!

---

### ⚖️ License

DocsAgent is open-source under the **Apache-2.0 License**.

---
**Desktop Sovereignty is here. Empower your Agents with DocsAgent.**
