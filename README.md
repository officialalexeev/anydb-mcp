# AnyDB MCP Server

<div align="center">

![AnyDB MCP Banner](https://capsule-render.vercel.app/api?type=waving&color=auto&height=200&section=header&text=AnyDB%20MCP&fontSize=80&animation=fadeIn)

**The Universal Database Connector for AI Agents**

[![npm version](https://img.shields.io/npm/v/anydb-mcp.svg?style=flat-square)](https://www.npmjs.com/package/anydb-mcp)
[![Downloads](https://img.shields.io/npm/dm/anydb-mcp.svg?style=flat-square)](https://www.npmjs.com/package/anydb-mcp)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

</div>

**`anydb-mcp`** is a Model Context Protocol (MCP) server that lets AI agents query SQL and NoSQL databases through a single interface.

Requires Node 20.19 or newer; that floor comes from the database drivers.

---

## Features

- Five databases out of the box: PostgreSQL, MySQL, SQLite, MongoDB, Redis.
- `db_schema` reports tables, columns and keyspace statistics, so a table name
  does not have to be guessed. MongoDB also reports collection indexes.
- Read-only by default; writes need an explicit `readOnly: false`.
- Connections are pooled and cached, so a follow-up query costs milliseconds.
- Timeouts are enforced by the database where it can, and the connection is torn
  down when they fire.
- Connection strings are masked in logs, and query text is not written to stderr
  unless `ANYDB_DEBUG=1` is set.

---

## Quick Start

### Choose your client

All of these run the same command; only the config file differs.

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
<summary><strong>Claude Desktop, Gemini CLI, VS Code</strong></summary>

Add this to `claude_desktop_config.json`, `mcp_servers.json`, or the VS Code MCP
config. On Windows use `npx.cmd`.

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


---

## Connection URIs

| Database | Protocol | Example URI |
|----------|----------|-------------|
| **PostgreSQL** | `postgres://`, `postgresql://` | `postgres://user:pass@localhost:5432/mydb` |
| **MySQL** | `mysql://`, `mysql+pymysql://`, `mysql+asyncmy://` | `mysql://user:pass@localhost:3306/mydb` |
| **SQLite** | `sqlite://`, `sqlite+pysqlite://` | `sqlite:///var/data/app.db` |
| **MongoDB** | `mongodb://` | `mongodb://user:pass@localhost:27017` |
| **Redis** | `redis://`, `rediss://` | `redis://:pass@localhost:6379` |

---

## Tools

### `db_query`

Executes a query. The database type is detected from the URI.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `uri` | string | yes | Connection string. |
| `query` | string | yes | SQL, MongoDB filter or pipeline (JSON), or Redis command. One statement only. |
| `collection` | string | MongoDB | The collection to query. |
| `action` | string | no | MongoDB only. `find` (default), `count`, `distinct`, `aggregate`, `explain`, `insert`, `update`, `delete`. |
| `update` | string | no | MongoDB only. Update document for the `update` action, e.g. `{"$set":{"seen":true}}`. |
| `field` | string | no | MongoDB only. Field name for the `distinct` action. |
| `sort` / `projection` | string | no | MongoDB only, JSON documents for `find`. |
| `upsert` | boolean | no | MongoDB only. Insert on `update` when nothing matches. |
| `allowWriteStages` | boolean | no | MongoDB only. Permit the `$out` and `$merge` aggregation stages. |
| `limit` | number | no | MongoDB only. Documents to return. Default 50, max 1000. |
| `readOnly` | boolean | no | Defaults to `true`. Set `false` to allow writes. |
| `timeout` | number | no | Query timeout in ms. Default `30000`, max `86400000`. |

### `db_schema`

Describes the structure of a database. Call this before writing a query, so
table and column names come from the catalogue rather than from a guess.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `uri` | string | yes | Connection string. |
| `table` | string | no | SQL only: describe just this table. |
| `collection` | string | no | MongoDB only: describe just this collection. |
| `timeout` | number | no | Timeout in ms. |

It reports, per database:

- **PostgreSQL / MySQL**: tables and views with column types, nullability and
  defaults. MySQL adds a `key` field reporting `PRI`, `MUL` or `UNI`. System
  schemas are excluded. Index definitions are not returned; only MongoDB reports
  those.
- **SQLite**: tables and views with column types, primary keys, and the
  original `CREATE` statement.
- **MongoDB**: collections with document counts and their indexes.
- **Redis**: server version, per-database key counts, and a sample of key names.

It runs introspection statements only, with caller input bound as a parameter
wherever the driver allows it, so it is read-only regardless of the `readOnly`
setting.

### Result shape

Results from `db_query` are **always a JSON array**, whatever the statement was:

- `SELECT` returns an array of row objects.
- `INSERT` / `UPDATE` / `DELETE` / DDL return a single-element array with a status object:

```json
[{ "affectedRows": 3, "insertId": 7, "changedRows": 1, "warningStatus": 0, "info": "" }]
```

Postgres uses `{ "affectedRows": n, "command": "INSERT", "oid": 16400 }` instead.
MongoDB writes report their own fields (`insertedCount`, `matchedCount`, `deletedCount`).

### Examples

**SQL (Postgres/MySQL/SQLite):**
```sql
SELECT id, email FROM users WHERE created_at > '2024-01-01' LIMIT 5;
```

**MongoDB:**
```json
{ "status": "active", "age": { "$gt": 21 } }
```

```json
[{"$match": {"age": {"$gte": 21}}}, {"$group": {"_id": "$city", "n": {"$sum": 1}}}]
```

**Redis:**
```redis
GET session:12345
```

---

## Read-only mode

Every query is checked before a connection is opened. Only statements that
cannot modify data get through:

- **SQL:** only read commands are allowed. `INTO OUTFILE`, `FOR UPDATE` and
  row-locking clauses are refused too.
- **MongoDB:** the action decides, not the payload. `insert`, `update` and
  `delete` modify data, and the `$out` and `$merge` stages replace a collection.
  The whole pipeline is walked, so a write stage nested inside `$facet` is caught.
  Operators that run server-side JavaScript (`$where`, `$function`,
  `$accumulator`) are refused.
- **Redis:** only read commands are allowed. `KEYS` is refused along with writes,
  because it blocks the server on a large keyspace; use `SCAN`.

The SQL check ignores string literals, quoted identifiers and comments, so
ordinary reads are not caught by accident:

```sql
SELECT * FROM created_orders            -- allowed
SELECT 'DROP TABLE t' AS example        -- allowed
SELECT 1 -- DROP TABLE t                -- allowed
```

To run a write, set `readOnly: false`. See [Allowing writes](#allowing-writes).

The `find` action returns at most `limit` documents, 50 by default. A document
larger than 1 MB is replaced by a stub naming its keys, so one oversized document
cannot overflow the caller's context.

---

## Allowing writes

Read-only mode is a guard against an agent guessing wrong, not a substitute for
database permissions. If you do need writes, create a dedicated user, then pass
`readOnly: false` on the specific call:

```json
{
  "uri": "postgres://user:pass@localhost:5432/mydb",
  "query": "UPDATE users SET seen_at = now() WHERE id = 42",
  "readOnly": false
}
```

```sql
-- Postgres: read-only user
CREATE USER ai_readonly WITH PASSWORD '...';
GRANT USAGE ON SCHEMA public TO ai_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;

-- MySQL: read-only user
CREATE USER 'ai_readonly'@'%' IDENTIFIED BY '...';
GRANT SELECT ON mydb.* TO 'ai_readonly'@'%';
```

---

## Timeouts

`timeout` bounds the whole operation, enforced in two places:

| Database | Query-level mechanism | Whole-operation guard |
|----------|------------------------|----------------------|
| **PostgreSQL** | `SET statement_timeout` on the same connection | `timeout` + 500 ms |
| **MySQL** | `MAX_EXECUTION_TIME` hint | `timeout` + 500 ms |
| **MongoDB** | `maxTimeMS` | `timeout` + 500 ms |
| **SQLite** | none; the guard calls `db.interrupt()` | `timeout` + 500 ms |
| **Redis** | `socket.timeout` | `timeout` + 500 ms |

The database-level limit fires first and names the real cause. The outer guard
catches what the driver cannot interrupt, and **tears the connection down** so the
server stops working on a query the caller has abandoned. That teardown also
happens when the driver reports the timeout itself, because a statement that
overran its budget may still be running.

The guard adds 500 ms of headroom on purpose, so a `timeout` of 1000 can take up
to 1500 ms to resolve.

---

## Connection reuse

Connections are pooled and cached per connection string, so a follow-up query
does not pay for a new handshake. On a local MySQL the difference is about an
order of magnitude, but the exact figure depends on the network.

- A cached connection is **verified before reuse**, never assumed alive, because
  a server can close an idle socket at any time. An unhealthy one is rebuilt.
- A connection that **timed out or lost its socket is discarded**, not reused: a
  statement that overran its budget may still be executing on it.
- Each call's `timeout` is re-applied on checkout, so a cached connection never
  runs with a stale budget. The one exception is Redis, whose socket timeout is
  fixed when the client is created, so a cached client keeps its first budget.
- MySQL and PostgreSQL use a bounded pool, so concurrent calls are multiplexed
  rather than queued behind one socket.

| Variable | Default | Effect |
|----------|---------|--------|
| `ANYDB_CACHE` | on | Set to `0` to open a connection per call, as earlier versions did. |
| `ANYDB_CACHE_MAX` | `8` | Cached connections to keep. The least recently used idle one is closed beyond this. Connections in use are exempt, so the cache can sit briefly above the limit. |
| `ANYDB_CACHE_TTL_MS` | `300000` | Close a connection idle for longer than this. Capped at one hour. |

With `ANYDB_CACHE=0` nothing is kept, so every call opens and closes its own
connection. Connections are closed on `SIGINT` and `SIGTERM`.

A side effect worth knowing: `sqlite://:memory:` now **persists between calls**,
because the same handle is reused. That is the intended behaviour, and it is the
reason the memory form is now useful.

---

## Known limitations

- **SQLite needs its native binding built.** `sqlite3` ships a prebuilt binary
  through an install script, and npm 12 blocks install scripts unless they are
  allow-listed. If you hit `SQLite support is unavailable`, run this once in
  your project:

  ```bash
  npm install-scripts approve sqlite3
  npm rebuild sqlite3
  ```

  Or add `allow-scripts=sqlite3` to your `.npmrc`. The other four databases work
  either way.

- **A statement SQLite cannot interrupt stays on the thread pool.** `db.interrupt()`
  stops most statements, but a long recursive CTE in SQLite's C code may run to
  completion. The connection is torn down so nothing queues behind it, but the
  work itself is not cancelled. Put a `LIMIT` on recursive queries.
- **Multi-statement input is rejected,** for SQL. PostgreSQL's simple query
  protocol would otherwise run every statement in the string, so a trailing write
  could slip past a check that reads only the first keyword. A semicolon inside a
  literal or comment is fine; one inside a PostgreSQL dollar-quoted body is not,
  and such a statement is refused.
- **A large result set can overflow an agent's context.** Put a `LIMIT` in the
  query.
- **`db_schema` is bounded, not complete.** SQL returns at most 500 tables and
  caps the column query at 50 000 rows; SQLite returns at most 100 columns per
  table. `truncated: true` marks a result that hit one of those limits.
- **Credentials stay in memory for the cache's lifetime.** A connection cache
  cannot hold a connection without holding its credentials.

---

## Debugging

Set `ANYDB_DEBUG=1` to log the full query text. Query text can contain sensitive
literals, so it is off by default. Connection strings are masked either way.

```
ANYDB_DEBUG=1 npx anydb-mcp
```

Errors come back as `DATABASE_ERROR: <cause>` followed by a `SUGGESTION` line. SQL
errors are replaced by a plain description, so `42P01` arrives as "table does not
exist" rather than as a code; MongoDB keeps its numeric code because the driver
errors are not mapped.

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

1.  Fork the repo.
2.  `npm install`
3.  `npm test`
4.  Submit a Pull Request.

## License

MIT © [Alexeev Alexandr](https://github.com/officialalexeev)
