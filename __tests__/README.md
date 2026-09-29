# Tests

The suite for `anydb-mcp`: **25 files, 2,599 tests.** This file is honest about
what that covers and, at more length, about what it does not.

> Русское резюме — внизу файла. A Russian summary is at the bottom, in
> [Резюме на русском](#резюме-на-русском).

## Running

```bash
npm test
npm run test:coverage
npm run verify:package
```

`verify:package` is **not** a repeat of `npm test`. The unit suite runs against the
working tree, where this repository's own `.npmrc` allow-scripts applies, so it
cannot see anything that only breaks once the package is installed somewhere else.
The script packs the tarball, checks the file list, scans the packed output for
credentials, installs it into an empty directory and drives the installed server
over stdio the way a client does.

Coverage has its own script because `npm test -- --coverage` fails on npm 12 with
`EUNKNOWNCONFIG`. The threshold — 85% of lines, globally — is in
`jest.config.cjs`, so `test:coverage` fails on a regression rather than printing a
number nobody reads.

## What is covered

| File | Tests | What it covers |
|------|-------|----------------|
| `test_policy.test.js` | 370 | Address maths and the notations a string comparison misses (`0177.0.0.1`, `0x7f.1`, `127.1`, `::ffff:127.0.0.1`, IPv4-mapped/compatible/NAT64), **which of those are a literal and which have to be resolved**, CIDR matching, URI splitting, the scheme and host allowlists, private-range blocking **after** resolution, the SQLite path policy with its path-segment boundary and its **symlink** check, the ad-hoc-URI switch, destructive classification per backend, and the precedence in `evaluatePolicy` |
| `test_safety.test.js` | 310 | `stripSqlNoise` per dialect, `inspectSql`, `EXPLAIN ANALYZE` in both spellings, `SELECT … INTO` in each form, data-modifying CTEs including the `REPLACE()`/`TRUNCATE()` function exclusions, **PostgreSQL dollar-quoted strings** (the bypass they were, and that `$1` and `a$tag$` are not one), `inspectRedisCommand`, `inspectMongoOperation` and the payload walks, `inspectQuery` routing, `inspectDangerousOperators`, `hasMultipleStatements`, the MariaDB dialect identity, and the assertion that **every** scheme the registry routes to SQL is one `isSqlProtocol` accepts |
| `test_logging.test.js` | 273 | `resolveAnyDbPaths` on win32/darwin/posix, the config and log file targets, `ensureDir` and `writableCheck`, `maskUri` (whole userinfo, the query string, the scheme-less form), `describeQuery`, `statementVerb`, `statementHash`, `statementSummary`, the text and JSON renderers, value truncation, log injection, the levels, the file sink, rotation, retention, degrading to stderr, and the `.env` parser and loader |
| `test_registry.test.js` | 263 | Constants, `extractProtocol`, routing, `validate`, timeout and read-only resolution, `run` end to end, result clamping and the envelope, `describe`, read-only enforcement (including a write hidden behind a dollar-quoted body, refused in read-only *and* write mode), code execution refused in every mode, the destructive gate, profile resolution, the cache key, `allowedSchemas`/`allowedTables` and the table reference a dollar-quoted body used to hide, error classification, the `cause`-chain code read behind `isTimeoutError` / `isDeadConnectionError`, `describeConfiguration`, and the constructor's six-positional compatibility form |
| `test_profiles.test.js` | 154 | The `db.json` schema end to end: file resolution order, validation of every field, unknown keys as a warning rather than a failure, the default profile, path resolution against the config directory, `list()`, `getEntry()`, `injectCredentials`, `stripCredentialFromUri`, `toUri`, atomic writing with modes, **all four credential references**, a literal password, reference validation, and that a secret never leaks into an error, a log line, or `db_health` — including an **inline** password in a `uri` a validation message used to quote back |
| `test_tools.test.js` | 134 | The whole `tools/list` payload: exactly the five documented tools, frozen, name/title/description/schema present, all four annotations per tool and that they say what each tool does, `additionalProperties: false` agreeing with the validator, every `enum` value described in prose, **no number in a description that is not an enforced constant**, the timeout bounds agreeing with the registry's, the `action` enum agreeing with `safety.js`'s `MONGO_ACTIONS`, the `document` and `collection` arguments, the error object's shape and its `kind` vocabulary, `findTool` for names the server does not have, the 21,500-byte budget, and `validateArgs` for accepts / unknown properties / missing required / wrong type / outside an enum / out of range / whitespace-only / the `profile`–`uri` xor / all-problems-at-once |
| `test_result_limits.test.js` | 120 | `normalizeForJson` for every scalar JSON cannot express, binary, BSON, `Date` (including "what pg actually hands back for a timestamp"), structure and cycles, `measureBytes`, `clampResult` by row count and by byte count, non-array payloads, **an adapter's own truncation markers**, every renderer, the byte budget on rendered text, and `buildEnvelope` |
| `test_mysql_adapter.test.js` | 108 | The driver shape, `connect`, the honoured and unrecognised query-string parameters, the `ssl` family including verifying versus encrypted, `execute`, bound parameters and a bind failure explained, error classification, `maxRows`, the session-state refusal, `withExecutionLimit` and where the hint is placed, `isHealthy`, `describe`, `abort`, `close` |
| `server_e2e.test.js` | 104 | The server as a **child process over a real stdio pipe**: handshake, unknown tool names and unknown arguments, choosing a target, `db_list`, malformed arguments, read-only enforcement, the destructive second gate, resilience, the `timeout` argument, result shape, `params`, each of `db_schema`/`db_explain`/`db_health`, MongoDB arguments including the eleven actions, driver availability, and logging |
| `test_redis_adapter.test.js` | 85 | The driver shape, `connect`, cluster and sentinel construction, `execute`, `HGETALL` under both RESP protocols, the result caps, the connection-state refusal, `parseCommand` and its binary/escape limits, `isHealthy`, `describe`, `abort`, `close` |
| `test_schemes.test.js` | 85 | **The durable fix for a scheme failing in three places.** Every scheme the policy allows is routed or explicitly pending, the pending list holds nothing since routed, the policy and the router do not disagree in either direction, a profile may name every scheme the policy allows, the adapter is driven with every SQLAlchemy spelling rather than trusting the reasoning, and the destructive verdict is not protocol-blind — including the MariaDB backslash-escape behaviour |
| `test_schema.test.js` | 84 | All five schema adapters: `summary`, pagination, the per-table column cap, `detail: 'full'`, and — for SQLite — both the table-valued-function path and the pre-3.16 fallback, plus a real in-memory database |
| `test_mongodb_actions.test.js` | 83 | **All eleven actions the tool exposes** — reads, the five writes, the three single-document forms, and `replace`'s `document` argument — plus an **empty filter on a write on both sides of the asymmetry** (refused for `update`/`delete`, permitted for the `*One` forms), a *missing* filter on a write, filter validation, error classification, health |
| `test_postgres_adapter.test.js` | 81 | The driver shape, the lazy `pg` load and its three states, `connect`, `execute`, bound parameters, `maxRows`, the session-state refusal, `abort`, `isHealthy`, `describe`, `close` |
| `test_sqlite_adapter.test.js` | 86 | The driver shape, lazy `loadSqlite3`, `connect`, `?mode=ro` reaching `sqlite3_open_v2` as `SQLITE_OPEN_READONLY` and an unreadable `mode=` **refusing** the connect rather than opening read-write, an unopenable path and its bounded open, concurrent calls on one shared handle, `maxRows`, `isHealthy`, `abort`, `close`, `describe`, and a leg **against the real driver** |
| `package_entry.test.js` | 52 | That `package.json`'s root export is the library and not the server, that `src/lib.js` is a pure barrel, that importing it **starts nothing, registers no process handler, does not read stdin and lets the process exit**, that every re-exported name belongs to the module it claims, that the server module imported rather than executed builds a server without starting one, and that the request handlers, `db_explain`, `db_health` and `main` are reachable in-process |
| `test_connection_cache.test.js` | 44 | Reuse, timeout propagation, concurrent first use, capacity, expiry, eviction, shutdown, the disabled cache, and configuration |
| `test_mongodb_adapter.test.js` | 32 | The connection lifecycle, the driver shape, `connect`, the limits, `isHealthy`, `abort`, `close`, `describe` |
| `test_adapters_integration.test.js` | 32 | All five adapters side by side: `db_schema` reporting a failure in the same words as `db_query`, a cap being a prefix and marked as a fact, a session-state statement refused, and a leg **against the real SQLite driver** |
| `registry_integration.test.js` | 27 | Protocol routing, unsupported protocols, and read-only applying to every adapter |
| `test_base_adapter.test.js` | 21 | `BaseAdapter`, `TimeoutError`, `withTimeout`, `TIMEOUT_GRACE_MS` |
| `test_timeout_utils.test.js` | 18 | `callbackWithTimeout` **and the class it rejects with**, a custom timeout message, real timings, and `createTimeoutController` |
| `test_timeout_handling.test.js` | 14 | `createTimeoutController` and `callbackWithTimeout` from the other side |
| `test_policy_live.test.js` | 14 | See [the live suite](#1-the-live-suite) below. With no `ANYDB_TEST_*` variable set this file is **14 tests of mostly non-configuration**: one per backend saying it did not run, the two Redis-topology routing assertions, and the SQLite harness block. The other four blocks are not registered at all. |
| `server_timeouts.test.js` | 5 | A statement that runs past its timeout, a call the client **cancels**, and progress notifications — all over a real child process, with a real four-million-row recursive CTE |

## What is **not** covered

This is the section that matters, and it is longer than the one above.

### 1. The live suite

`__tests__/test_policy_live.test.js` is the half of the suite that talks to real
servers, and it is new. Every other file here runs against a double: the adapters
take their driver class as a constructor argument, `registry_integration.test.js`
replaces `registry.mapping` with stubs, and
`test_adapters_integration.test.js` reads no environment variable. A faithful
double of `pg` proves the adapter *calls* `pg` correctly. It cannot prove that
`SET statement_timeout = 30000` is spelled the way the server spells it, that `?`
is MySQL's placeholder rather than PostgreSQL's, that a MongoDB cursor actually
yields, that `mongodb+srv` resolves, or that a driver error carries the code
`classifyError` reads off the `cause` chain.

**The gate.** Four variables, one per backend, and the value *is* the URI:

| Variable | Value in the `live` CI job |
|----------|----------------------------|
| `ANYDB_TEST_POSTGRES` | `postgres://anydb:anydb@127.0.0.1:5432/anydb` |
| `ANYDB_TEST_MYSQL` | `mysql://root:anydb@127.0.0.1:3306/anydb` |
| `ANYDB_TEST_MONGODB` | `mongodb://127.0.0.1:27017/anydb` |
| `ANYDB_TEST_REDIS` | `redis://127.0.0.1:6379` |

No `_URI` suffix: the URI is the whole value, and a suffix on a variable that *is*
a URI says nothing. To run one locally:

```bash
ANYDB_TEST_POSTGRES=postgres://u:p@127.0.0.1:5432/db npx jest test_policy_live
```

Absent variable: the backend's block is **not registered at all**, so it costs
nothing and cannot report a false pass through a `skip` marker. Present but
unreachable: the tests **fail**, because "I configured it" and "it did not work"
are different answers and only the first of them is a skip. With no variable set
the file still contributes one test per backend asserting that it is not
configured — so a green run of this file is never silently indistinguishable from
a green run against four databases.

**What each live block covers**, against a real server and a real fixture:

- connect, and report the driver that answered
- `db_schema` against the fixture — asserted by shape (the named table, its
  column names and types), not merely truthy, because a double returning `{}`
  satisfies a round trip and proves nothing about a real introspection query
- a **parameterised** read, which is the class of bug a double cannot catch: the
  double records the call, the server rejects the wrong placeholder
- a value containing a quote inside a bound parameter, the injection case
- a write behind **both** gates, then a read-back
- cache reuse, proved by the cache size not moving across a second call
- a refusal: read-only mode against a live server, and `DESTRUCTIVE` behind
  `readOnly: false` alone — for the SQL backends. MongoDB is the exception and has
  its own case: a data write needs `readOnly: false` and *nothing else*, because
  `classifiesAsDestructive` covers only `drop`, `dropDatabase`, `create` and
  `createIndex`, none of which `db_query` exposes
- a statement the server refuses, asserting the **driver code survives** - `42P01`
  on PostgreSQL, `SQLITE_ERROR` on SQLite - which is the only place the `cause`
  chain is tested end to end
- `db_explain` returning a plan and not running the statement
- MongoDB only, because it is the backend where a mock is least like the truth:
  the four write actions this file drives (`insert`, `updateOne`, `delete`,
  `deleteOne`; `update` and `replace` are not exercised), `updateOne` changing one
  document and leaving the rest alone, `deleteOne` removing exactly one, **an
  empty filter refused on `delete` and accepted on `deleteOne`**, server-side
  JavaScript refused even with both gates set, a bounded aggregation, and a
  MongoDB `explain` that returns planner output
- Redis only: a command that changes connection state refused, and `db_explain`
  refusing Redis in words rather than by accident
- every backend: that the policy is on and is what stops the loopback address

**The harness self-test.** The last block in the file runs the same eight steps
against `sqlite://:memory:`, which needs no container and therefore runs on
**every** invocation. It is not a substitute for the four containers and does not
pretend to be: it validates the *test*, so that a red `live` job means a red
driver rather than a red assertion. It is the reason the helper for reading a
`db_schema` report out of the envelope was caught — `describe()` returns the
report as a single object, not an array of rows, and the obvious reader yields
`tables: undefined` and a test that passes for the wrong reason.

**What the live suite still does not cover.** Stated in the file as well as here,
because the gap is the useful part:

- **MariaDB as a server.** `mariadb`, `mariadb+pymysql` and
  `mariadb+mariadbconnector` route to the MySQL adapter and collapse to the same
  `mysql://` form, so a live MySQL covers the *wiring* and nothing else. It says
  nothing about MariaDB's own parser, its `information_schema` shape, or its
  backslash-in-literal behaviour against a real server — which is the one that
  matters, because getting that wrong is a read-only bypass class bug. That needs
  a `mariadb:11` service container.
- **Redis Cluster and Sentinel.** The two schemes are routed and allowed, and
  `test_redis_adapter.test.js` asserts the policy admits them and that
  `createCluster` / `createSentinel` are called with the right options. A
  single-node Redis 7 container is not a cluster and not a sentinel set. That
  needs a `redis-stack` cluster or a hand-built one.
- **`mongodb+srv`.** It is a DNS SRV lookup against a real Atlas deployment. The
  scheme is routed and the adapter hands it to the driver untouched, which the
  unit suites assert; a live `mongodb://` container does not exercise the lookup.
- **TLS.** `rediss://` and `sslmode=require` need certificates, and `requireTLS`
  is not on by default.
- **The two load-only socket timeouts.** `ANYDB_MONGO_SOCKET_TIMEOUT_MS` and
  `ANYDB_REDIS_SOCKET_TIMEOUT_MS` need a slow query on a busy server.
- **The concurrent-caller paths.** The cache's pending-entry dedup and its
  idle-TTL eviction both want a real latency to race against; they are covered
  only against stubs.

**In CI.** A `live` job with `services:` for PostgreSQL 16, MySQL 8.4, MongoDB 7
and Redis 7 sets all four variables and runs two steps: `node
scripts/live-adapters.mjs`, which drives the real `AdapterRegistry` through a
read / write / read-back / describe round trip, and then
`__tests__/test_policy_live.test.js` itself against the same containers. The
script is the smoke test and the suite is the assertion: a driver that answers a
round trip and is still wrong — a misspelled placeholder, a code that does not
survive the adapter's rewrite, a `db_explain` that returns nothing — fails on
the second step. The jest step was the one this file previously said was missing
from that job; it is there, and this is now the only place the live suite runs
without anybody setting the variables locally.

`server_e2e.test.js` runs on `sqlite://:memory:` and deliberately points at
`127.0.0.1:1` and `127.0.0.1:3999` to assert *failure* paths, so starting real
services on the default ports would not help it and could make those assertions
lie.

### 2. Only SQLite runs against its real driver by default

Three files open a real in-memory database **directly**:
`test_sqlite_adapter.test.js` and `test_adapters_integration.test.js` through
`adapter.connect('sqlite://:memory:')`, and `test_schema.test.js` through
`new sqlite3.Database(':memory:')`. Two more reach the same real driver
*indirectly*, through a real registry and a real `query` call rather than a
driver double: `package_entry.test.js` drives the request handlers in-process,
and `server_e2e.test.js` and `server_timeouts.test.js` drive a child process
over stdio. That is seven files in all, and it is worth naming them because
"only SQLite" otherwise reads as "one test opens a real database" — the caches
in `registry_integration.test.js` and `test_registry.test.js` are exercised
against `sqlite://:memory:` too, with the driver stubbed. With no
`ANYDB_TEST_*` set, nothing else in the suite opens a socket.

### 3. The connection cache's liveness check is per driver, not uniform

`test_connection_cache.test.js` covers reuse, capacity, expiry, eviction and
shutdown against **stubs** whose `isHealthy()` the test controls. It proves the
cache calls `isHealthy()`, honours the answer, and does not double-connect on a
race. It does not prove any driver's own `isHealthy()` is correct.

The real implementations are covered separately, and they are not the same shape:

| Driver | What `isHealthy()` does | Round trip? |
|--------|------------------------|-------------|
| PostgreSQL | `SELECT 1` on the pool | yes |
| MySQL | `SELECT 1` on the pool | yes |
| SQLite | latched fatal error, the driver's `open` flag, then `SELECT 1 AS ok` | yes |
| MongoDB | `client.topology.isConnected()` | **no** |
| Redis | `client.isReady` | **no** |

An earlier version of this file claimed the cache tests covered "проверка живости"
— a liveness check — which was only true of a stub. SQLite in particular used to
*assume* alive with `!!this.db && !this.aborted`, which reported a handle that had
just failed a write as healthy and directly violated the contract
`base-adapter.js` documents; that is fixed and tested. The two flag-reading drivers
are still not a proof of anything beyond "the client object says it is connected",
and the live suite's cache-reuse assertions do not change that.

### 4. What a real server does with an allowed statement

The read-only and destructive gates are exercised against doubles, an in-memory
SQLite, and — for the gates themselves — the four live backends. What a real
server does with a statement the guard *allowed* is still not covered and is not
coverable by a keyword-level test: a `SELECT` that a view expands into a write, a
function with side effects, a foreign table. The live suite asserts the gates
**refuse**; it does not assert that a `SELECT` is harmless.

### 5. `process.exit` paths are not covered

`server_e2e` drives a real child process, so the transport-death handler, the
`uncaughtException` and `unhandledRejection` handlers and the SIGINT/SIGTERM
shutdown path are asserted through the *server's own behaviour* — a clean exit, an
in-band error — rather than by stubbing `process.exit`.

### 6. The packaged verification is not part of `npm test`

`verify:package` is a separate script, runs as its own CI job on Linux **and**
macOS, and is the only check that sees the tarball. macOS is there because the bin
shim is executed and the entry-point check compares two `realpath`s; a
case-insensitive filesystem is the only place that comparison can silently
disagree with itself.

## Notes

- The adapters take their driver as a constructor argument, so most of the suite
  needs no running database. That is also why the live suite exists.
- `server_e2e.test.js` runs a real server and works on in-memory SQLite. The
  connection cache means `:memory:` persists between calls, so `readOnly: false`
  writes are available in that file.
- `test_safety.test.js` checks literal parsing separately per dialect. A backslash
  escapes a quote only in MySQL **and MariaDB**; PostgreSQL and SQLite run with
  `standard_conforming_strings`, where `\` is an ordinary character. Removing that
  difference lets `SELECT 'a\'; DROP TABLE t; --'` past the check again — which is
  what happened, and was fixed in 2.0.3 for PostgreSQL and SQLite. It was the
  *same* bug again for MariaDB, in the opposite direction, and that one was
  subtler: `mariadb` had no entry in the guard's dialect table at all, so
  `isSqlProtocol('mariadb')` was `false` and every gate that begins with it
  returned early — a per-profile `allowedSchemas` / `allowedTables` was silently
  skipped for every MariaDB connection. Both are fixed, and the durable guard is an
  assertion that every scheme the registry routes to SQL is one `isSqlProtocol`
  accepts.
- `jest.config.cjs` collects coverage from **all** of `src/`, `src/index.js`
  included. It used to carry an `!src/index.js` exclusion on the grounds that the
  file connected stdio on import. That has been untrue since the entry point was
  split, a child process's coverage is never collected, and the exclusion meant the
  largest file in the package was quietly outside the number. `package_entry.test.js`
  covers it.
- The suite grew from **15 files and 587 tests at 2.0.4** to **25 files and
  2,599 tests** during the 3.0 rebuild. Ten files are new —
  `test_policy`, `test_profiles`, `test_result_limits`, `test_tools`,
  `test_schemes`, `test_timeout_utils`, `test_policy_live`, `test_adapters_integration`,
  `server_timeouts` and `package_entry` — and the 2.0.4 figures above are
  measured, not remembered: the earlier draft of this file compared against "21
  files and 2,177 tests", which was a mid-rebuild state and described no
  release. `test_mongodb_actions` grew from 52 tests against the adapter's own
  action sets to 83 against all eleven actions the tool now exposes.
- With no `ANYDB_TEST_*` set, `test_policy_live.test.js` is 14 tests: four
  "not configured" assertions, two Redis-topology routing assertions, and the
  eight-step SQLite harness. Set all four variables and the file is 57 — the
  four "not configured" assertions are **replaced** by the real blocks, not
  added to: 12 PostgreSQL, 10 MySQL, 16 MongoDB and 9 Redis, plus the same two
  topology and eight harness tests, which are registered either way.

---

<a id="резюме-на-русском"></a>

## Резюме на русском

**25 файлов, 2 599 тестов.** Раздел «Что покрыто» — в таблице выше.

### Живой набор

`__tests__/test_policy_live.test.js` — половина набора, которая говорит с
настоящими серверами. Все остальные файлы работают на двойниках: адаптеры
принимают класс драйвера конструктором, `registry_integration.test.js` подменяет
`registry.mapping` заглушками. Убедительный двойник `pg` доказывает, что адаптер
*правильно вызывает* `pg`. Он не может доказать, что `SET statement_timeout =
30000` написан так, как это пишет сервер, что `?` — это плейсхолдер MySQL, а не
PostgreSQL, что курсор MongoDB действительно выдаёт документы, что `mongodb+srv`
резолвится, или что ошибка драйвера несёт код, который `classifyError` читает по
цепочке `cause`.

**Ворота.** Четыре переменные, по одной на бэкенд, и значение переменной *есть*
URI: `ANYDB_TEST_POSTGRES`, `ANYDB_TEST_MYSQL`, `ANYDB_TEST_MONGODB`,
`ANYDB_TEST_REDIS`. Суффикса `_URI` нет: значение уже является URI, и суффикс
ничего не добавляет. Переменной нет — блок бэкенда **вообще не регистрируется**,
поэтому он ничего не стоит и не может сообщить ложный успех через маркер `skip`.
Переменная есть, сервер недостижим — тесты **падают**, потому что «я это
настроил» и «это не работает» — разные ответы, и пропуском является только первый.
Переменных нет — файл всё равно даёт по одному тесту на бэкенд, утверждающему,
что переменной нет, так что зелёный прогон этого файла никогда не путается с
зелёным прогоном против четырёх баз.

**Что покрывает каждый живой блок**, против настоящего сервера и настоящей
фикстуры: подключение и имя ответившего драйвера; `db_schema` по фикстуре —
проверяется по форме (нужная таблица, имена и типы её столбцов), а не просто на
непустоту; параметризованное чтение — тот класс ошибок, который двойник поймать не
может: двойник записывает вызов, а сервер отклоняет неверный плейсхолдер; значение
с кавычкой внутри связанного параметра, то есть случай инъекции; запись за **обоими**
воротами и чтение назад; повторное использование соединения, доказанное тем, что
размер кэша не меняется; отказ — read-only против живого сервера и `DESTRUCTIVE`
с одним лишь `readOnly: false`; отклонённый сервером оператор с проверкой, что
**код драйвера дожил** (`42P01` у PostgreSQL, `SQLITE_ERROR` у SQLite) — единственное
место, где цепочка `cause` проверена от начала до конца; `db_explain`, возвращающий
план и не исполняющий оператор. Только MongoDB, потому что там заглушка меньше
всего похожа на правду: пять операций записи, `updateOne`, меняющий один документ и
не трогающий остальные, `deleteOne`, удаляющий ровно один, **пустой фильтр,
отклонённый на `delete` и принятый на `deleteOne`**, серверный JavaScript,
отклонённый даже с обоими флагами, ограниченная агрегация, и `explain`, который
возвращает план. Только Redis: отказ команды, меняющей состояние соединения, и
`db_explain`, отказывающий Redis словами, а не по случайности. Все бэкенды:
политика включена и именно она останавливает loopback-адрес.

**Самопроверка оснастки.** Последний блок файла прогоняет те же восемь шагов на
`sqlite://:memory:`, которому контейнер не нужен, поэтому он выполняется при
**каждом** запуске. Это не замена четырём контейнерам и не притворяется ею: он
проверяет *сам тест*, чтобы красная задача `live` означала красный драйвер, а не
красное утверждение. Именно он поймал чтение отчёта `db_schema` из конверта:
`describe()` возвращает отчёт одним объектом, а не массивом строк, и очевидный
читатель даёт `tables: undefined` и тест, проходящий по неверной причине.

**Чего живой набор всё ещё не покрывает.** Это важная часть, и она написана в самом
файле:

- **MariaDB как сервер.** `mariadb`, `mariadb+pymysql` и
  `mariadb+mariadbconnector` идут на адаптер MySQL и сворачиваются в ту же форму
  `mysql://`, поэтому живой MySQL покрывает только *связность* — и ничего больше. Он
  ничего не говорит о собственном парсере MariaDB, о форме её `information_schema`
  и о поведении обратного слэша в литерале против настоящего сервера, а именно это
  и важно, потому что ошибка здесь — класс обхода read-only. Нужен контейнер
  `mariadb:11`.
- **Redis Cluster и Sentinel.** Обе схемы маршрутизированы и разрешены, и
  `test_redis_adapter.test.js` проверяет, что политика их впускает и что
  `createCluster` / `createSentinel` вызываются с правильными параметрами. Одноузловой
  контейнер Redis 7 — это не кластер и не сторож. Нужен кластер `redis-stack` или
  собранный вручную.
- **`mongodb+srv`.** Это DNS-поиск SRV против настоящего развёртывания Atlas. Схема
  маршрутизирована и передаётся драйверу нетронутой, что проверяют юнит-наборы;
  живой контейнер `mongodb://` этот поиск не выполняет.
- **TLS.** `rediss://` и `sslmode=require` требуют сертификатов, а `requireTLS` по
  умолчанию не включён.
- **Две таймаут-страховки, срабатывающие только под нагрузкой.**
  `ANYDB_MONGO_SOCKET_TIMEOUT_MS` и `ANYDB_REDIS_SOCKET_TIMEOUT_MS` требуют медленного
  запроса к занятому серверу.
- **Пути конкурентных вызовов.** Дедупликация висящихся записей кэша и вытеснение
  по простою нуждаются в настоящей задержке, с которой можно посоревноваться; они
  покрыты только на заглушках.

**В CI.** Задача `live` с `services:` для PostgreSQL 16, MySQL 8.4, MongoDB 7 и
Redis 7 задаёт все четыре переменные и выполняет два шага:
`node scripts/live-adapters.mjs` — дымовой тест, — и затем сам
`__tests__/test_policy_live.test.js` против тех же контейнеров. Скрипт проверяет
round trip, набор — утверждения: драйвер, который отвечает, но неправ, падает на
втором шаге. Шаг jest — это как раз то, чего этот файл раньше объявлял
недостающим в задаче; он там есть, и теперь живой набор запускается без того,
чтобы кто-то локально выставлял переменные.

### Что НЕ покрыто

1. **Только SQLite работает на настоящем драйвере по умолчанию.** Три файла
   открывают настоящую базу в памяти напрямую: `test_sqlite_adapter.test.js` и
   `test_adapters_integration.test.js` через `adapter.connect('sqlite://:memory:')`,
   `test_schema.test.js` через `new sqlite3.Database(':memory:')`. Ещё два
   файла достигают того же настоящего драйвера **косвенно** — через настоящий
   реестр и настоящий вызов: `package_entry.test.js` гоняет обработчики в том же
   процессе, а `server_e2e.test.js` и `server_timeouts.test.js` — дочерний процесс
   через stdio. Всего семь файлов, и стоит назвать их явно, потому что «только
   SQLite» иначе читается как «один тест открывает настоящую базу»: кэш в
   `registry_integration.test.js` и `test_registry.test.js` тоже прогоняется на
   `sqlite://:memory:`, но с заглушкой драйвера. Без `ANYDB_TEST_*` больше в
   наборе не открывается ни один сокет.
2. **Проверка живости соединения в кэше — разная для каждого драйвера.** Тесты кэша
   проверяют, что он вызывает `isHealthy()`, слушается ответа и не открывает второе
   соединение при гонке, но не проверяют, что реализация `isHealthy()` у какого-либо
   драйвера верна. Реальные реализации покрыты отдельно и они неодинаковы:
   PostgreSQL, MySQL и SQLite делают настоящий круговой запрос (`SELECT 1`), а
   MongoDB и Redis читают локальное состояние клиента (`topology.isConnected()`,
   `client.isReady`) — без запроса. Прежняя версия этого файла утверждала, что тесты
   кэша покрывают «проверку живости», и это было верно только про заглушку. SQLite
   раньше *предполагал* соединение живым и отвечал `true` для дескриптора, который
   только что не прошёл запись, — прямо вопреки контракту в `base-adapter.js`. Это
   исправлено и покрыто.
3. **Что настоящий сервер делает с разрешённым оператором.** Ворота проверяются на
   двойниках, на SQLite в памяти и — сами ворота — против четырёх живых бэкендов. Что
   сервер делает с оператором, который гард **пропустил**, всё ещё не покрыто и не
   покрываемо тестом уровня ключевых слов: `SELECT`, который разворачивается во
   представление с записью, функция с побочным эффектом, внешняя таблица. Живой
   набор проверяет, что ворота **отказывают**; он не проверяет, что `SELECT`
   безобиден.
4. **Проверка распакованного пакета не входит в `npm test`.** Это отдельный скрипт
   и отдельная задача CI на Linux и macOS; macOS — потому, что bin-шим реально
   запускается, а проверка точки входа сравнивает два `realpath`.
5. **Пути `process.exit` не покрыты.** `server_e2e` запускает настоящий дочерний
   процесс, поэтому обработчик смерти транспорта, обработчики `uncaughtException` и
   `unhandledRejection` и путь остановки SIGINT/SIGTERM утверждаются через *поведение
   самого сервера*, а не через подмену `process.exit`.

### Замечания

- Адаптеры принимают драйвер конструктором, поэтому большинству набора не нужна
  работающая база — и именно поэтому существует живой набор.
- `server_e2e.test.js` запускает настоящий сервер и работает на SQLite в памяти.
  Благодаря кэшу соединений `:memory:` сохраняет данные между вызовами, поэтому в
  этом файле доступны записи с `readOnly: false`.
- `test_safety.test.js` проверяет разбор литералов отдельно для каждого диалекта.
  Обратный слэш экранирует кавычку только в MySQL **и MariaDB**; PostgreSQL и SQLite
  работают с `standard_conforming_strings`, где `\` обычный символ. Если это
  различие убрать, `SELECT 'a\'; DROP TABLE t; --'` снова пройдёт проверку — именно
  так и было, исправлено в 2.0.3 для PostgreSQL и SQLite. Для MariaDB это была **та
  же** ошибка в противоположную сторону, и куда более коварная: у `mariadb` вообще не
  было записи в таблице диалектов, поэтому `isSqlProtocol('mariadb')` был `false` и
  каждый барьер, начинающийся с него, выходил раньше — `allowedSchemas` /
  `allowedTables` профиля молча пропускались для каждого соединения с MariaDB. Обе
  исправлены, а прочная защита — утверждение, что каждая схема, которую
  маршрутизирует реестр в SQL, принимается `isSqlProtocol`.
- `jest.config.cjs` собирает покрытие по **всему** `src/`, включая
  `src/index.js`. Раньше там стояло исключение `!src/index.js` на том основании,
  что файл подключает stdio при импорте; это неправда уже две версии, покрытие
  дочернего процесса не собирается вовсе, и самое большое исключение из отчёта
  было вне числа.
- Набор вырос с **15 файлов и 587 тестов в 2.0.4** до **25 файлов и 2 599
  тестов** за время пересборки 3.0. Десять файлов новые: `test_policy`,
  `test_profiles`, `test_result_limits`, `test_tools`, `test_schemes`,
  `test_timeout_utils`, `test_policy_live`, `test_adapters_integration`,
  `server_timeouts` и `package_entry`. Цифры за 2.0.4 измерены, а не вспомнены:
  прежняя редакция этого файла сравнивала с «21 файлом и 2 177 тестами», что было
  состоянием посреди пересборки и не описывало ни одного релиза.
  `test_mongodb_actions` вырос с 52 тестов против собственных наборов действий
  адаптера до 83 против всех одиннадцати действий, которые теперь отдаёт
  инструмент.
- Без `ANYDB_TEST_*` файл `test_policy_live.test.js` даёт 14 тестов: четыре
  утверждения «не настроено», две проверки маршрутизации топологий Redis и
  восьмишаговая оснастка на SQLite. Заданы все четыре переменные — файл даёт 57:
  четыре утверждения «не настроено» при этом **заменяются** настоящими блоками, а
  не добавляются к ним, — это 12 тестов PostgreSQL, 10 MySQL, 16 MongoDB и
  9 Redis плюс те же две проверки топологий и восемь шагов оснастки, которые
  регистрируются в любом случае.
