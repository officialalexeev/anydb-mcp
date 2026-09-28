# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-09-28

### Breaking

- **Node 18 is no longer supported.** `engines` was `>=18.0.0`, which the
  upgraded drivers cannot honour: mongodb 7 requires `>=20.19.0` and sqlite3 6
  requires `>=20.17.0`. The floor is now `>=20.19.0`, and CI runs 20, 22 and 24.
- **`db_query` always returns an array.** MySQL returned a bare object for
  `INSERT` and an array for `SELECT`, so `result[0].id` worked or failed
  depending on the statement. Non-row statements now return a one-element array
  holding a status object, PostgreSQL included, where `CREATE TABLE` previously
  returned an empty array indistinguishable from a no-op.

### Added

- **`db_schema` tool.** Tables, columns, keys and views for SQL, collections with
  their indexes for MongoDB, version and keyspace statistics for Redis. Caller
  input is bound as a parameter wherever the driver allows it, so the tool is
  read-only by construction. Bounded to 500 tables and 100 columns per table,
  with a `truncated` flag when a limit is hit.
- **MongoDB actions beyond `find`.** `count`, `distinct`, `aggregate`,
  `explain`, `insert`, `update` and `delete`, chosen with the `action` argument.
  The action decides what counts as a write, not the shape of the payload.
- **Connection reuse.** Connections are pooled and cached per connection string,
  controlled by `ANYDB_CACHE`, `ANYDB_CACHE_MAX` and `ANYDB_CACHE_TTL_MS`. A
  cached connection is verified before reuse, and the caller's `timeout` is
  re-applied on checkout. Closed cleanly on SIGINT and SIGTERM.
  `ANYDB_CACHE=0` restores the previous behaviour. A side effect: `sqlite://:memory:`
  now persists between calls.
- **`isHealthy()` and `abort()` on the adapter interface.** `isHealthy()` is what
  the cache calls before handing a connection out; `abort()` is what stops a
  statement the caller has given up on.
- **Read-only mode, on by default.** A rejected statement is caught before a
  socket is opened. The check is an allowlist that ignores string literals,
  quoted identifiers and comments, so `SELECT * FROM created_orders` and
  `SELECT 'DROP TABLE t'` both pass. MySQL conditional comments are refused,
  since the server executes them. Redis `KEYS` is refused along with writes,
  because it blocks the server on a large keyspace.
- **Tests for the whole surface**, including an end-to-end suite that drives the
  server as a child process over stdio.

### Fixed

- **A timed-out statement no longer blocks the next query.** An adapter timeout
  was treated as an ordinary error, so `abort()` was never called and the
  connection stayed cached. The abandoned statement kept running and every
  later query queued behind it. Any timeout now discards the connection.
- **Multiple SQL statements in one call are rejected.** PostgreSQL's simple query
  protocol runs every statement in the string, so `SELECT 1; DROP TABLE t` passed
  a read-only check that reads only the leading keyword. Checked after literals
  and comments are stripped, and independently of `readOnly`.
- **The read-only guard walked the whole aggregation pipeline.** `$merge` nested
  inside `$facet` or `$unionWith` was allowed through. The adapter repeats the
  walk, since the guard is skipped when `readOnly` is false.
- **`rediss://` and SQLAlchemy-style URIs now route.** `rediss://` and
  `mysql+pymysql://` were documented but rejected as unsupported protocols,
  even though the MySQL adapter had code to normalise them.
- **An evicted connection is no longer orphaned.** The LRU sweep dropped an entry
  that was still in use from the map without closing it, so the connection could
  never be closed afterwards. A release that arrived after its entry had been
  replaced could also close a connection a different caller was using.
- **`ANYDB_CACHE=0` no longer leaks.** With the cache off, nothing tracked the
  connection, so `close()` was never called.
- **A bad SQLite path no longer kills the server.** sqlite3 reports
  `SQLITE_CANTOPEN` by emitting `error` and never calling back; with no listener
  that event was an uncaught exception, which ended the process.
- **PostgreSQL applies `statement_timeout` to the connection that runs the
  query.** Two `pool.query()` calls could land on different clients and leave the
  timeout unenforced.
- **MySQL timeouts are enforced.** The timeout was passed as the `values`
  argument of `query()`, where mysql2 ignores it. SELECT now carries a
  server-side `MAX_EXECUTION_TIME` hint, placed after the keyword because MySQL
  silently ignores one placed before it.
- **MySQL error messages name the actual failure.** A missing table, a denied
  login and a refused connection all read as a syntax error, which points the
  caller at the wrong thing.
- **Malformed tool arguments return a tool error** rather than escaping as
  `MCP error -32603`, because logging ran before validation.
- **Credentials are no longer written to stderr**, and query text is only logged
  under `ANYDB_DEBUG=1`.
- **The MongoDB read-only guard walked the whole pipeline.** `$merge` nested
  inside `$facet` or `$unionWith` was allowed through.
- **`timeout: 0` is rejected.** It passed validation, then became the default in
  one place and meant "no timeout" in another.
- **The two timeout layers no longer race.** Both used the same value, so which
  one reported the error was arbitrary. The outer guard now runs 500 ms later,
  leaving the database-level error to name the real cause first.
- **`limit` reaches MongoDB.** The adapter read `options.limit`, but nothing
  passed one and the tool schema omitted it, so the limit was permanently 50.
- **MySQL uses a pool rather than one connection**, since a cached connection
  serves concurrent requests.
- **A hostile table name cannot break out of the SQLite `PRAGMA`.** The name is
  quoted and embedded quotes doubled.
- **MySQL URIs with encoded credentials decode**, as do percent-encoded database
  names and the `mysql+pymysql` / `mysql+asyncmy` dialect prefixes.
- **Windows SQLite paths resolve.** `sqlite:///C:/data.db` produced `/C:/data.db`.
- **The advertised server version matches the package**, rather than a literal
  that went stale at 1.0.0.

### Changed

- **Dependencies updated to current majors:** mongodb 6 to 7, redis 5 to 6,
  sqlite3 5 to 6, MCP SDK to 1.30.1. `npm audit` reports zero vulnerabilities,
  including a cross-client data leak in the SDK that was fixed upstream.
- **MySQL uses `query()` instead of `execute()`.** Prepared statements are
  rejected for a number of legal single-statement forms, and no values are
  bound, so they bought nothing.
- **Redis uses one code path for every command** instead of a hand-rolled switch
  over nine commands with a fallback, which returned inconsistent shapes.
- **MongoDB write results report a fixed field list**, so the shape does not
  depend on driver internals.
- **Error messages say what to do next**, and carry the server error code.
- **CI audits the production dependencies** and runs with coverage.
- **`jest.config.mjs` removed.** It duplicated `jest.config.cjs` with a
  conflicting transform config, and only the `.cjs` one was ever used.
- **Test files renamed to `*.test.js`**, so `testMatch` means what it says.
- **`docs/` is no longer git-ignored**, so the files this changelog links to
  exist in the repository.

### Known limitations

- A statement SQLite cannot interrupt stays on its thread pool. `db.interrupt()`
  handles most statements, but a long recursive CTE in SQLite's C code may run
  to completion. The connection is discarded either way, so nothing queues
  behind it.
- Multi-statement input is rejected, which keeps every statement individually
  visible to the read-only check.
- Cached connections hold their credentials in memory for the cache's lifetime.

## [1.0.1] - 2026-04-13

### Added
- **Query timeout system** - multi-layer protection against hanging database queries
  - Global operation timeout (`timeout` parameter in `db_query`)
  - Database connection timeout (5 seconds by default)
  - Query execution timeout (30 seconds by default)
- **`TimeoutError` class** - specialized error for timeout operations
- **`withTimeout()` utility** - Promise wrapper with timeout support
- **`callbackWithTimeout()` utility** - wrapper for callback-based operations
- **AbortController** for SQLite operations
- **Database-specific timeout handling** for each adapter:
  - PostgreSQL: `SET statement_timeout`
  - MySQL: `timeout` parameter in query
  - MongoDB: `maxTimeMS()` in query
  - SQLite: Promise.race with AbortController
  - Redis: `socket.timeout` in configuration

### Changed
- All adapters now accept `timeout` parameter in constructor
- `AdapterRegistry.run()` wraps entire operation in global timeout
- MCP server now returns human-readable messages on timeouts
- Improved connection error handling for all adapters

### Documentation
- Added timeout configuration guide (`docs/timeout-configuration.md`)

### Tests
- Added `test_timeout_handling.js` - 8 tests for timeout utilities
- Updated all adapter tests to work with new constructors
- Added timeout error handling tests for each database
- Total tests: **78 passed, 3 skipped**

## [1.0.0] - 2026-04-13

### Added
- Initial release of AnyDB MCP Server
- Support for 5 databases: PostgreSQL, MySQL, SQLite, MongoDB, Redis
- Adapter pattern for universal interface
- Dependency Injection for testability
- Zero-config approach
- CI/CD via GitHub Actions
- 59 unit tests
