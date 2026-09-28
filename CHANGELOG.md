# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.3] - 2026-09-28

### Fixed

- **The read-only guard could be walked past on PostgreSQL and SQLite.** The
  scanner treated a backslash as escaping the next character inside a string
  literal, which MySQL does and PostgreSQL and SQLite do not: those run with
  standard-conforming strings, where `\'` is a complete literal. So
  `SELECT 'a\'; DROP TABLE t; --'` was read as one statement, passed the
  multiple-statement check, and was then executed as two — through the simple
  query protocol, which is exactly why that check exists. The `DROP` ran
  against a real database. Literal scanning is now dialect-aware, and MySQL
  keeps the permissive reading it needs, so a legal `'it\'s fine'` is still
  not mistaken for two statements.
- **`db_schema` ignored its own `timeout` bounds.** It does not go through
  `validate()`, so a non-numeric value reached `setTimeout` and produced
  `timed out after abc500ms`; a negative value silently switched the timeout
  guard off for the whole call; and a value above `2^31` overflowed Node's
  32-bit timer, which clamped it to 1 ms and made every `db_schema` call report
  a timeout it never had. `db_query` validated all three correctly, and
  `docs/timeout-configuration.md` already documented the bound for both. Both
  tools now share one `validateTimeout`.
- **`anydb-mcp/package.json` is exported.** `exports` allowed only the root
  entry, so anything reading a package's installed version through
  `require('anydb-mcp/package.json')` got `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- **`mysql+aiohttp://` now routes.** The MySQL adapter already normalised the
  scheme, but the registry rejected it as unsupported, and `mysql+mysqldb://` was
  routed without appearing in the README's protocol table.

### Changed

- **A SQLite binding error no longer suggests checking the query.** The message
  already explains how to install the binding, and the trailing `SUGGESTION` line
  used to contradict it with "Check the sqlite syntax".
- **CI verifies the packed package.** 2.0.0 passed every test and still shipped
  a server that could not start for anyone whose npm blocked the sqlite3 install
  script, because the suite runs where this package's own `allowScripts` entry
  applies. `npm run verify:package` packs the tarball, installs it into an empty
  directory and drives the installed server over stdio. It runs as its own CI
  job and as part of `prepublishOnly`.
- **CI runs on Windows as well.** The SQLite URI handling rewrites drive-rooted
  paths, so Windows exercises a branch no Linux run reaches.
- **The publish guide describes the real workflow**, including 2FA, the
  difference between verifying a local pack and verifying the registry copy, and
  when unpublishing is the right call.

## [2.0.2] - 2026-09-28

### Fixed

- **The SQLite installation instructions were half right.** 2.0.1 pointed at two
  interchangeable fixes, but `npm install-scripts approve` writes an `allowScripts`
  entry into the installing project's `package.json`, and npm then ignores a
  `.npmrc` `allow-scripts` setting in favour of it. Anyone whose `package.json`
  already declared `allowScripts` would follow the `.npmrc` advice and get
  "`.npmrc` allow-scripts setting is being ignored" with no way out. The
  `approve` route is now the documented default, with the `.npmrc` caveat
  stated. Confirmed against a clean install: `approve` plus `npm rebuild` brings
  SQLite up, and `db_query` then answers.

## [2.0.1] - 2026-09-28

### Fixed

- **The package no longer fails to start for consumers whose npm blocks install
  scripts.** 2.0.0 imported sqlite3 at module scope, so a consumer whose install
  script was blocked got a sqlite3 with no native binding, and the server died on
  startup before any tool was called. Found by installing 2.0.0 from the registry
  into a clean directory and running it. The driver is now loaded on first use,
  so PostgreSQL, MySQL, MongoDB and Redis are unaffected, and a SQLite request
  returns an error naming both ways to fix it: `npm install-scripts approve
  sqlite3`, or `allow-scripts=sqlite3` in the installing project's `.npmrc`.

## [2.0.0] - 2026-09-28 (withdrawn)

**Not published.** This version was on the registry for a few minutes and then
withdrawn, because installing it broke the server for every consumer whose npm
blocked the sqlite3 install script. It was never installed by anyone, so npm has
no `2.0.0` and the `v2.0.0` tag points at the commit rather than a release you
can fetch. The description below is kept because those changes are what the rest
of the 2.x line is made of; they are all present in 2.0.1 and later.

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
