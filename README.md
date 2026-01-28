# AnyDB MCP Server

<div align="center">

![AnyDB MCP Banner](https://capsule-render.vercel.app/api?type=waving&color=auto&height=200&section=header&text=AnyDB%20MCP&fontSize=80&animation=fadeIn)

**The Universal Database Connector for AI Agents**

[![npm version](https://img.shields.io/npm/v/anydb-mcp.svg?style=flat-square)](https://www.npmjs.com/package/anydb-mcp)
[![Downloads](https://img.shields.io/npm/dm/anydb-mcp.svg?style=flat-square)](https://www.npmjs.com/package/anydb-mcp)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

</div>

**`anydb-mcp`** is a professional, zero-config Model Context Protocol (MCP) server that empowers AI agents to safely query SQL and NoSQL databases. 

It acts as a universal bridge, allowing tools like **Cursor**, **Claude**, **Gemini**, and **Zed** to interact with your data effortlessly using a single unified interface.

---

## ✨ Features

- 🔌 **Universal Support:** Works with PostgreSQL, MySQL, SQLite, MongoDB, and Redis out of the box.
- 🚀 **Zero Config:** No configuration files required. Just run it via `npx`.
- ⚡ **Stateless & Fast:** Connections are created on-demand and closed immediately.
- 🛡️ **Secure:** Designed for read-only access (enforceable via DB users).
- 🧠 **Smart Parsing:** Automatically detects database types from standard connection URIs.

---

## 📦 Quick Start

You can run this server directly using `npx` without installing anything manually.

### 🤖 Choose Your Client

<details open>
<summary><strong>Cursor</strong> (Recommended)</summary>

1. Open **Cursor Settings** > **Features** > **MCP**.
2. Click **+ Add New MCP Server**.
3. Enter the following details:
   - **Name:** `anydb`
   - **Type:** `command`
   - **Command:** `npx`
   - **Args:** `-y anydb-mcp`

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "anydb": {
      "command": "npx",
      "args": ["-y", "anydb-mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>Zed Editor</strong></summary>

Edit your `settings.json` (Cmd/Ctrl + ,):

```json
{
  "context_servers": {
    "anydb": {
      "command": {
        "path": "npx",
        "args": ["-y", "anydb-mcp"]
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Add to your `mcp_servers.json`:

```json
{
  "mcpServers": {
    "anydb": {
      "command": "npx",
      "args": ["-y", "anydb-mcp"]
    }
  }
}
```
*Note: On Windows, explicitly use `npx.cmd`.*
</details>

<details>
<summary><strong>VS Code (Cline / Roo Cline)</strong></summary>

1. Open the **MCP Servers** tab (usually in the sidebar or settings).
2. Select **Configure MCP Servers**.
3. Add the configuration:
```json
"anydb": {
  "command": "npx",
  "args": ["-y", "anydb-mcp"]
}
```
</details>

---

## 🔗 Connection URIs

The AI agent will provide these URIs automatically, or you can provide them in the chat context.

| Database | Protocol | Example URI |
|----------|----------|-------------|
| **PostgreSQL** | `postgres://` | `postgres://user:pass@localhost:5432/mydb` |
| **MySQL** | `mysql://` | `mysql://user:pass@localhost:3306/mydb` |
| **SQLite** | `sqlite://` | `sqlite:///Users/alex/data.db` (Absolute path) |
| **MongoDB** | `mongodb://` | `mongodb://user:pass@localhost:27017` |
| **Redis** | `redis://` | `redis://:pass@localhost:6379` |

---

## 🛠️ Tool Usage

The server exposes one powerful tool: **`db_query`**.

#### Arguments:
- **`uri`** (string, required): The connection string.
- **`query`** (string, required): The SQL query, MongoDB filter (JSON), or Redis command.
- **`collection`** (string, optional): Required only for MongoDB.

#### Examples:

**SQL (Postgres/MySQL/SQLite):**
```sql
SELECT id, email FROM users WHERE created_at > '2024-01-01' LIMIT 5;
```

**MongoDB:**
```json
{ "status": "active", "age": { "$gt": 21 } }
```

**Redis:**
```redis
GET session:12345
```

---

## 🔒 Security Best Practices

1.  **Read-Only User:** ALWAYS create a dedicated database user with **SELECT-only** permissions (or equivalent) for the AI.
    -   *Postgres:* `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_user;`
    -   *MySQL:* `GRANT SELECT ON mydb.* TO 'ai_user'@'%';`
2.  **Network:** Ensure the database host is accessible from the machine running the MCP server.
3.  **Data Privacy:** Be cautious. The AI has access to whatever data the query returns.

---

## 👨‍💻 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

1.  Fork the repo.
2.  `npm install`
3.  `npm test`
4.  Submit a Pull Request.

## License

MIT © [Alexeev Alexandr](https://github.com/officialalexeev)
