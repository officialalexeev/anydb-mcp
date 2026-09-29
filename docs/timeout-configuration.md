# Timeouts in anydb-mcp

> **Русская версия — внизу документа**, в разделе
> [Русский](#русский). The Russian translation is at the bottom of this file.

A timeout bounds the whole operation, from connection to result. It is set with
the `timeout` argument on `db_query`, `db_schema`, `db_explain` and `db_health`,
and per profile with `queryTimeoutMs` and `connectTimeoutMs`.

- [The three layers](#the-three-layers)
- [Connect timeouts](#connect-timeouts)
- [Valid values](#valid-values)
- [Teardown: what actually stops](#teardown-what-actually-stops)
- [Error messages](#error-messages)
- [Architecture](#architecture)
- [Recommendations](#recommendations)
- [Known limitations](#known-limitations)
- [Compatibility](#compatibility)
- [Русский](#русский)

---

## The three layers

### 1. The database-level limit

Fires first, and names the real cause.

| Database | Mechanism | Notes |
|----------|-----------|-------|
| **PostgreSQL** | `SET statement_timeout = N` | Sent on the **same client** as the statement. `statement_timeout` is a session setting, so two `pool.query()` calls can land on two different backends and leave the timeout unenforced — which is why one `pool.connect()` client carries both. `db_schema` does the same thing. |
| **MySQL / MariaDB** | `/*+ MAX_EXECUTION_TIME(N) */` | Injected after the leading `SELECT` keyword, because MySQL silently ignores a hint placed before it, and **only** on `SELECT`, because MySQL ignores it elsewhere and a CTE's top-level `SELECT` is not at a fixed offset. A non-`SELECT` statement is bounded only by the outer guard. |
| **MongoDB** | `maxTimeMS` | On the cursor, on `aggregate`, and on `distinct`. A real server-side kill switch, not a suggestion. It is a separate bound from `serverSelectionTimeoutMS`, which bounds *picking a server* and says nothing about how long a statement may then run. |
| **SQLite** | none | There is no server-side budget. A timer races the driver callback, and `db.interrupt()` is what actually stops a running statement. |
| **Redis** | none per command | node-redis has no per-command timeout. `ANYDB_REDIS_SOCKET_TIMEOUT_MS` is a **socket** backstop for a connection that has gone quiet, and it defaults to `0` — no socket timeout at all. It is deliberately *not* the query budget: a client created by a first call with `timeout: 1000` once kept that socket timeout for the whole life of the cache entry, so every later call, including one that asked for thirty seconds, was cut off at one second by a limit the caller never set and cannot see. |

### 2. The whole-operation guard

Fires at `timeout + 500 ms` (`TIMEOUT_GRACE_MS`). The headroom is the point: the
database-level error arrives first, and it names the real cause. When both layers
had the same value, which one reported was arbitrary.

`withTimeout` in `src/core/registry.js` wraps the whole of `withConnection`, which
means it covers acquiring a connection, running the statement, and clamping the
result. On fire it evicts the cache entry and calls `adapter.abort()`.

The guard also fires when the **driver** reports a timeout rather than the guard
itself. How that is decided matters, because the wrong rule here is expensive.

**Classification is by class and by code, not by prose.** A timeout this process
raises is a `TimeoutError`; `callbackWithTimeout` in `src/core/timeout-utils.js`
builds a real one, so `error instanceof TimeoutError` is a positive signal rather
than a guess. A timeout the *server* raises carries a code: `57014` for
PostgreSQL's `statement_timeout`, `ER_QUERY_TIMEOUT` for MySQL's
`max_execution_time`, `50` for MongoDB's `maxTimeMS`, `SQLITE_INTERRUPT` for an
interrupted SQLite statement.

The subtlety is that **all three SQL and Mongo adapters replace the driver's error
with a fresh `Error`** to write a better sentence, keeping the original only as
`cause`. A PostgreSQL `57014` therefore reaches the classifier as an `Error` with
no `code` of its own. That is why there is a bounded, cycle-safe `cause` walker
(four links deep) between the error and the code lookup, and why the phrase list
that used to stand in for it could be deleted without losing coverage: the
**reduction is structural, not a deletion** — the phrasings went, the codes went
in, and the walker finds them where the rewrite put them.

The obvious test ("does the message mention `timeout`?") would also have torn down
a live pool for a PostgreSQL error reading `column "timeout" does not exist` and
for a MongoDB `E11000` on a unique index named `timeout_1`. Prose is what these
adapters rewrite the error *for*, so matching it was matching a sentence this
codebase chooses.

**Eviction after a timeout is per-database, and MongoDB is the deliberate
exception.** A server-side statement timeout leaves the connection demonstrably
fine: PostgreSQL cancels one statement and answers the next, and MongoDB's
`maxTimeMS` aborts one operation without touching the socket. PostgreSQL `57014`
and MySQL `ER_QUERY_TIMEOUT` still evict, kept from 2.x. MongoDB's `50` **no longer
does** — the old pattern matched a sentence `mongodb.js` itself wrote, so every
slow aggregation paid a pool teardown and a reconnect, with no safety behind it.
The full per-database table is in the [README](../README.md#connection-reuse).

### 3. The connect timeout

Different from the query timeout, because a connect that has not finished is a
hang rather than a slow database.

---

## Connect timeouts

`POLICY_DEFAULTS.connectTimeoutMs` is **5000 ms**, overridable per profile with
`connectTimeoutMs` (1 … 60000) and process-wide with
`ANYDB_DEFAULT_CONNECT_TIMEOUT_MS`.

| Database | Timeout | Mechanism |
|----------|---------|-----------|
| **PostgreSQL** | 5000 ms | `connectionTimeoutMillis` |
| **MySQL / MariaDB** | 5000 ms | `connectTimeout`; a `?connect_timeout=` in the URI wins |
| **MongoDB** | 5000 ms | `serverSelectionTimeoutMS` **and** `connectTimeoutMS`. For `mongodb+srv://` the DNS SRV lookup happens *before* the socket is opened, so this budget covers it, and the outer guard is what bounds a resolver that never answers. |
| **SQLite** | not applicable | A local file. The *open* is bounded instead: `min(timeout, 10000)` with a 50 ms floor, so a caller who asked for 5 s is not held for 10, and `timeout: 1` does not abort before the driver has had a turn of the event loop. |
| **Redis** | 5000 ms | `socket.connectTimeout` |

---

## Valid values

`timeout` must be an **integer** from `1` to `86400000` (24 hours) inclusive. An
omitted value, or `null`, means **30000 ms**.

- `0` is refused, so "no timeout" cannot be obtained by accident.
- A non-integer is refused. The value is written into a
  `SET statement_timeout` by string interpolation on PostgreSQL, and a fractional
  one is truncated differently by each driver.
- Two gates enforce this independently: the tool's JSON Schema produces a message
  a model can act on, and the registry's own `validateTimeout` is the one still in
  force if something reaches the registry without going through the schema.

A profile's `queryTimeoutMs` and a call's `timeout` are merged, not exclusive —
`evaluatePolicy` reconciles defaults, environment, profile and call arguments in
that order, with a *present* call argument winning.

---

## Teardown: what actually stops

When **this server's own guard** fires, the adapter is aborted and the cache entry
is evicted. What `abort()` does differs per driver, and saying "the connection is
torn down" hides the differences that matter.

| Database | `abort()` | Is it a guarantee? |
|----------|-----------|-------------------|
| **PostgreSQL** | Sends a **CancelRequest** on a *second* connection: for every in-flight `(client, query)` pair it constructs a new `Client` and calls `client.cancel(client, query)`. | **No.** It is a request. A statement the server has not started receiving, or one inside a non-interruptible operation, keeps going. If the cancel connection cannot be opened, nothing is cancelled and the original statement runs to completion. A cancel can also arrive after the caller's own guard gave up, so it must not be relied on to end the wait. What it *does* guarantee is that the pool is not handed out again (`isHealthy` reports false) and that `close()` will not wait for the statement. |
| **MySQL** | Destroys every socket the pool has opened, tracked through the pool's public `connection` event. The pool object is deliberately **kept**, so `end()` still releases its bookkeeping and its idle reaper; `aborted` marks the adapter dead instead, and the tracking listener destroys any socket opened from then on. | Effectively yes for MySQL — a destroyed socket cannot keep serving the statement. `close()` calls `pool.end()` but does **not** await it after an abort, because the `Quit` commands it enqueues can never be answered. |
| **MongoDB** | `client.close(true)` — a force close, which cancels in-flight operations — and nulls the client. | Yes, for this client. A separate pinned client on the same server is unaffected. |
| **SQLite** | `db.interrupt()`, i.e. `sqlite3_interrupt`. It cancels the running statement and **leaves the handle open**. | Only for statements SQLite can interrupt. A long recursive CTE in SQLite's own C code runs to completion; nothing on the JavaScript side can stop it. `close()` still closes the handle afterwards, which matters: the old code skipped it on an abort and leaked the handle and its file descriptor for the life of the process. The one case that is genuinely not closeable is a handle whose open never completed, and that case is tracked separately. |
| **Redis** | `client.destroy()`, and nulls the client. | Yes, for this client. `close()` calls `client.quit()`, which on a destroyed client is skipped. |

**Teardown and eviction are two different questions, and only the first one is
answered by the table above.** Teardown is what this server does about a statement
it gave up on. Eviction is whether the *connection* is thrown away afterwards
because it might still be running something. For a guard fire the answer is yes
everywhere. For a **driver-reported** timeout it is not, and the per-database
answer is:

| Database | Driver code | Evicts? | Why |
|----------|-------------|---------|-----|
| PostgreSQL | `57014` | **yes** | Kept from 2.x: a half-cancelled statement is not a state this server wants to reason about. |
| MySQL / MariaDB | `ER_QUERY_TIMEOUT` | **yes** | Same reasoning. |
| SQLite | `SQLITE_INTERRUPT` | **yes** | The driver's own code, not a matched message. |
| MongoDB | `50` | **no** | A `maxTimeMS` abort leaves the socket untouched and the next command answers on it. The old pattern matched a sentence `mongodb.js` itself wrote, so every slow aggregation paid a teardown and a reconnect with no safety behind it. |
| Redis | — | **no** | node-redis has no per-command timeout; a query timeout is this server's own `TimeoutError` and the socket is demonstrably fine. |

**Client cancellation** is a separate path and behaves the same way: when the host
sends `notifications/cancelled`, the server abandons the *await* so the caller
gets an answer now, and aborts and evicts the connection so the statement does not
keep running against a pooled socket with the pool slot checked out. A cancelled
call is reported as `kind: "timeout"` — the advice that applies is that the next
call has to be cheaper or given longer — and the message says which of the two it
was, so a model is not sent looking for a slow query it already abandoned.

---

## Error messages

Every failure is an in-band tool error, not a protocol failure, and reads:

```
DATABASE_ERROR: <cause> [<CODE>]
SUGGESTION: <what to do next>
```

The `[<CODE>]` suffix is present whenever there is a code, on the same line as the
message and after it, so the first token a model reads is still `DATABASE_ERROR:`
and the `SUGGESTION:` line is still the last. It is a driver's own code
(`42P01`, `50`, `ER_QUERY_TIMEOUT`, `SQLITE_BUSY`, `11000`) or one of this
server's (`READ_ONLY`, `CODE_EXECUTION`, `DESTRUCTIVE`, `SCHEMA_NOT_ALLOWED`,
`TABLE_NOT_ALLOWED`, `CONNECTION_POLICY`, `ADHOC_URI_DISABLED`, `INVALID_TIMEOUT`,
`PROFILE_UNAVAILABLE`).

**A code is the one fact about a failure that does not get translated.** It is
documented by the driver, stable across versions and locales, and it answers
"does this retry?" where the sentence around it does not. Before it was surfaced,
the only way to recover it was substring-matching English driver prose — and that
is exactly how `column "timeout" does not exist` came to be classified as a
connection failure: a classifier that reads sentences cannot tell a missing column
from an unreachable host when both are English. `[...]` is also the shape every
driver document and every log aggregator uses, so it is unsurprising to parse.

The code appears in the text block as well as in `structuredContent.error.code`,
which is the field to *branch* on and which is `null` when there is none. A client
reading only `code` has nothing for two classes of failures, not one: every refusal
this server raised before touching a database, and every driver error that arrives
without a code of its own. Redis is the one that matters in practice — `redis@6`
builds each server reply into a `SimpleError` from the wire string and sets no `code`
on it, so `WRONGTYPE`, `NOAUTH`, `MOVED` and `CLUSTERDOWN` all arrive with
`code: null` and the server's word only in the message. For Redis, branch on the
message, or on the first token after `[Redis`. Socket errors such as `ECONNRESET` and
`ETIMEDOUT` do carry a code on every backend. That is why the text is not a duplicate
but a second channel.

| Message | Cause | Do |
|---------|-------|----|
| `[Postgres timeout] Query exceeded 30000ms (statement_timeout)` | PostgreSQL cancelled it, and blamed the timeout | Narrow the query, add a `LIMIT`, or raise `timeout` |
| `[Postgres cancelled] …` | SQLSTATE `57014` from something other than the timeout — a manual cancel. The two are told apart, so this one does not claim a timeout that did not happen. | Check whether something else cancelled the query |
| `[Postgres relation (table or view) does not exist] …` | SQLSTATE `42P01` | Call `db_schema`; the code is mapped to a sentence, not passed through |
| `[MySQL query exceeded 30000ms timeout: …` | The driver or the outer guard. `ER_QUERY_TIMEOUT` and `ER_OPTION_PREVENTS_STATEMENT` are both recognised. | Add an index or narrow the selection |
| `[MongoDB timeout] Query exceeded 30000ms (maxTimeMS)` | `maxTimeMS` expired, or driver code `50` | Add an index, or raise `timeout` |
| `[MongoDB sort failed] Sort exceeded the 32MB memory limit. …` | The in-memory sort cap, not a timeout | Add an index, or narrow the filter |
| `SQLite query exceeded 30000ms timeout. The database is probably locked by another process or transaction.` | The driver's callback did not arrive — usually contention | Retry, or write from the process holding the lock |
| `[SQLite locked] … Another process holds a lock on the database.` | `SQLITE_BUSY` | SQLite is single-writer; retry |
| `[SQLite cannot open] …` | `SQLITE_CANTOPEN`, or the driver never reported the file open inside the budget | Check the path in the URI. The message includes the path the driver was actually given |
| `[Redis error] … (client timeout was 30000ms)` | Socket-level timeout or a dropped connection | The client timeout named is the call's budget, for context; node-redis has no per-command timeout |
| `Operation "db_query (postgres)" timed out after 30500ms` | The **outer guard** fired: the driver could not interrupt it, or did not report it | Narrow the query, add a `LIMIT`, or raise `timeout` |

The last row is the *uncommon* path, not the ordinary one. The ordinary path is
a driver-level message, because that is the one that names the real cause.

Two more classifications worth knowing about, because they used to be reported as
something they are not:

- A **serialization** failure (`error.kind: "serialization"`) is a result that
  could not go on the wire — a `BigInt`, a circular structure, a `Buffer` — not a
  syntax error. Its suggestion says so, and says that rewriting the SQL will not
  fix it.
- A **SQLite timeout** used to be reported as a syntax problem, because
  `callbackWithTimeout` rejected with a plain `Error` that no `instanceof
  TimeoutError` could see. It rejects with a real `TimeoutError` now.

`error.code` is on the structured result as well: the driver's own (`42P01`,
`11000`, `SQLITE_BUSY`) or this server's (`READ_ONLY`, `CODE_EXECUTION`,
`DESTRUCTIVE`, `SCHEMA_NOT_ALLOWED`, `TABLE_NOT_ALLOWED`, `CONNECTION_POLICY`,
`ADHOC_URI_DISABLED`, `INVALID_TIMEOUT`, `PROFILE_UNAVAILABLE`). Branch on that
rather than on English prose.

---

## Architecture

```
withTimeout(timeout + 500 ms, onTimeout: cache.evict + adapter.abort)
 └─ cache.acquire(driver::<sha256 of the resolved URI>, timeout)
      ├─ isHealthy() on a cached entry, and re-stamp its budget
      └─ adapter.connect(uri)                  if there is no entry
 └─ the ten gates                            all before any socket
 └─ adapter.execute(query)                    [the database-level timeout]
 └─ clampResult + buildEnvelope
 └─ cache.release(entry)                      [the connection stays cached]

on a real timeout signal, or a dead socket:
  cache.evict(key) + adapter.abort()
```

Notes on the diagram, three of which changed and one of which never was right:

- **The cache key is a driver name plus the first 32 hex characters of the
  URI's SHA-256.** Not `protocol::uri`. The scheme is collapsed through the same
  alias table the router uses, so `postgres://h/d` and `postgresql://h/d` are
  **one** entry and one pool to the same server, as are `mysql://` and
  `mysql+pymysql://`. And the password is not in the key as a plaintext `Map`
  key: a long-lived structure nobody thinks of as a secret store is where
  credentials end up in a core dump and a heap snapshot. The credential *is* in
  the digest, so a rotated password gets a new connection rather than a silent
  reuse of one authenticated with the old value.
- **`release()` takes the entry, not the key.** A release that arrives after its
  entry was evicted and replaced must not decrement the newer one, and a
  key-existence check passes just as well against a replacement.
- **`isHealthy()` is not a round trip for every driver.** PostgreSQL, MySQL and
  SQLite each spend one statement on it — `SELECT 1`, `SELECT 1`,
  `SELECT 1 AS ok` — because a server can close an idle socket at any time and
  the alternatives are wrong or slow. MongoDB and Redis read local client state
  instead (`topology.isConnected()`, `client.isReady`): a topology flag and a
  socket-readiness flag, with no query. Neither is proof the server is healthy;
  both are much better than assuming.
- The read-only gate runs **before** `acquire`, so a refused statement opens no
  socket.

A connection is not closed after each call. It lives in the cache until its TTL
expires, it is evicted by LRU, it is discarded on a guard fire, on a dead socket,
or on a **driver-reported** timeout for the databases listed above — and *not* on
a MongoDB `maxTimeMS` abort or a Redis query timeout, which leave the connection
demonstrably usable — or it is closed at process exit. `ANYDB_CACHE=0` returns to
one connection per call.

---

## Recommendations

**Raise `timeout` for:** complex joins, bulk operations, large MongoDB
aggregations, slow networks, and a cold connection whose first query pays for the
handshake.

**Lower it for:** simple indexed `SELECT`s, fast Redis commands, availability
probes, and interactive sessions with a human watching — where a call that has
not finished in a few seconds is a question about the query, not about patience.

**Do not use a timeout to bound a result.** `maxRows` and `maxBytes` are for that,
and they are the right tool: a timeout produces an error, a cap produces a prefix
of the answer with `truncated: true` saying so.

---

## Known limitations

- **A statement SQLite cannot interrupt keeps running.** `db.interrupt()` stops
  most statements, but a long recursive CTE inside SQLite's C code may run to
  completion. The connection is torn down so nothing queues behind it and the
  handle is still closed, but the work itself is not cancelled. Put a `LIMIT` on
  recursive queries.
- **A PostgreSQL cancel is a request.** See the table above.
- **MySQL's `MAX_EXECUTION_TIME` is a hint, and only on `SELECT`.** MySQL may
  ignore it and MariaDB does; the outer guard is the backstop.
- **Redis has no per-command timeout at all.** The call is bounded by the outer
  guard and, only if you ask for it, the socket backstop. `ANYDB_REDIS_SOCKET_TIMEOUT_MS`
  defaults to none and is deliberately not the query budget.
- **The two socket backstops are not exercised by a test.** `ANYDB_MONGO_SOCKET_TIMEOUT_MS`
  and `ANYDB_REDIS_SOCKET_TIMEOUT_MS` only fire under load — a slow query on a busy
  server — so the live suite does not set either. They are wired, and the MongoDB
  default (the call's `queryTimeout`) is read, but the abort path is unverified
  against a real server.
- **MongoDB's `maxTimeMS` no longer evicts the connection**, deliberately, because
  the old behaviour tore the pool down on every slow aggregation with no safety
  behind it. If a driver ever left a `maxTimeMS` abort in a state where the socket
  was *not* reusable, that would now be a leak rather than a reconnect — the
  `isHealthy()` check on next reuse is what covers it, and for MongoDB that check
  reads `topology.isConnected()` with no round trip.
- **Multi-statement input is rejected** for SQL, which is what keeps every
  statement individually visible to the read-only check. A semicolon inside a
  literal, a comment or a PostgreSQL dollar-quoted body is fine, because all three
  are stripped before the count. The last one is load-bearing rather than tidy:
  `$$…$$` is PostgreSQL's other string form and the only one whose body may hold
  an *unquoted* single quote, so a scanner that did not know about it read that
  quote, looked for a partner, and swallowed the rest of the statement — semicolons
  included. `SELECT $tag$ ' $tag$ ; DELETE FROM users; --` passed both the
  multi-statement scan and the read-only gate, and `pg` sends the whole string as a
  simple query whenever a call carries no `params`.
- **The result caps bound this process, not the server.** For PostgreSQL the
  statement still runs to completion and every row is still read off the socket;
  what is bounded is the array of parsed rows. MongoDB is the exception: a cursor
  is read and stopped early. This is documented per adapter in the code.
- **The cache holds credentials in memory** for the lifetime of the cache entry. A
  cache cannot hold a connection without holding its credentials.
- **An unopenable SQLite path used to hold a call for its whole budget.** It is
  bounded twice now — by the call's own budget and by 10 s — because one typo in a
  path, repeated, was a cheap way to burn a caller's entire allowance.

---

## Compatibility

The `timeout` argument is unchanged in 3.0. It was refused at `0` from 2.0.0, and
since then:

- The teardown behaviour has changed. A PostgreSQL call has an `abort()` it did not
  have in 2.0, and the MySQL, MongoDB, SQLite and Redis paths have their
  socket/client/handle teardown documented above rather than assumed.
- `TIMEOUT_GRACE_MS` is unchanged at 500.
- A cancelled call is now an in-band error with a `SUGGESTION` line rather than a
  wait.
- The `instructions` string now tells a model to put a `LIMIT` in every query,
  because a cap the caller did not ask for is how a table gets half-read.

---

<a id="русский"></a>

## Русский

### Слои таймаутов

**1. Таймаут на стороне базы.** Срабатывает первым и называет настоящую причину.

| База | Механизм |
|------|----------|
| PostgreSQL | `SET statement_timeout = N` на **том же** соединении, что и запрос: это сессионная настройка, и два вызова `pool.query()` могут попасть на разные бэкенды, оставив таймаут неприменённым. `db_schema` делает то же самое. |
| MySQL / MariaDB | Хинт `/*+ MAX_EXECUTION_TIME(N) */` сразу после ключевого слова `SELECT`. Только `SELECT`: в других операторах MySQL его игнорирует, а у `WITH … SELECT` верхний `SELECT` не на фиксированной позиции. |
| MongoDB | `maxTimeMS` — на курсоре, на `aggregate` и на `distinct`. Это настоящий серверный выключатель, а не рекомендация. |
| SQLite | Серверного лимита нет. Работает таймер, состязающийся с колбэком драйвера, и `db.interrupt()`. |
| Redis | Per-command таймаута в node-redis нет вообще. `ANYDB_REDIS_SOCKET_TIMEOUT_MS` — это страховка на уровне сокета для молчащего соединения, по умолчанию `0`. Это намеренно **не** бюджет запроса. |

**2. Guard на всю операцию.** Срабатывает через `timeout + 500 мс`
(`TIMEOUT_GRACE_MS`). Запас нужен, чтобы сообщение базы успело выйти первым и
назвать настоящую причину. Покрывает всё: получение соединения, выполнение
запроса и формирование ответа. При срабатывании запись кэша выбрасывается и
вызывается `adapter.abort()`.

То же происходит, когда таймаут сообщает сам драйвер, но решение принимается **по
классу и по коду, а не по прозе**. Таймаут, который поднимает сам процесс, — это
`TimeoutError`, и `callbackWithTimeout` создаёт настоящий, так что
`error instanceof TimeoutError` — положительный признак, а не догадка. Таймаут,
который поднял сервер, несёт код: `57014` у PostgreSQL, `ER_QUERY_TIMEOUT` у
MySQL, `50` у MongoDB, `SQLITE_INTERRUPT` у прерванного оператора SQLite.

Тонкость в том, что **все три SQL/Mongo-адаптера заменяют ошибку драйвера новым
`Error`**, чтобы написать понятную фразу, и сохраняют исходную только как
`cause`. Поэтому PostgreSQL `57014` доходит до классификатора вообще без `code`.
Именно поэтому между ошибкой и поиском кода стоит ограниченный по глубине (четыре
звена) и защищённый от циклов обход `cause`, и поэтому список фраз, который его
заменял, можно было удалить, не потеряв покрытия: **сокращение структурное, а не
вычитание** — формулировки ушли, коды пришли, а обход находит их там, куда их
положил переписывающий адаптер. Был один регулярное выражение из 16 альтернатив —
стало 7 шаблонов плюс поиск по кодам.

Наивная проверка «есть ли в сообщении слово `timeout`» рвала живое соединение на
ошибке PostgreSQL `column "timeout" does not exist`. Проза — это ровно то, ради
чего адаптеры переписывают ошибку, поэтому её сопоставление было сопоставлением с
фразой, которую выбирает сам этот код.

**Выбрасывание соединения после таймаута различается по базам, и MongoDB — здесь
осознанное исключение.** Серверный таймаут оставляет соединение заведомо
рабочим: PostgreSQL отменяет один оператор и отвечает на следующий, а `maxTimeMS`
MongoDB прерывает одну операцию, не трогая сокет. PostgreSQL `57014` и MySQL
`ER_QUERY_TIMEOUT` по-прежнему выбрасывают соединение — так было в 2.x. MongoDB
`50` — **больше нет**: прежний шаблон совпадал с фразой, которую сам же писал
`mongodb.js`, поэтому каждая медленная агрегация платила разрывом пула и
переподключением без всякой причины. Полная таблица — в
[README](../README.md#connection-reuse).

**3. Таймаут подключения.** По умолчанию 5000 мс; переопределяется профилем
(`connectTimeoutMs`, 1…60000) и переменной `ANYDB_DEFAULT_CONNECT_TIMEOUT_MS`.

| База | Таймаут | Механизм |
|------|---------|-----------|
| PostgreSQL | 5000 мс | `connectionTimeoutMillis` |
| MySQL / MariaDB | 5000 мс | `connectTimeout`; `?connect_timeout=` в URI важнее |
| MongoDB | 5000 мс | `serverSelectionTimeoutMS` и `connectTimeoutMS`. Для `mongodb+srv://` DNS-поиск SRV происходит **до** открытия сокета, поэтому бюджет покрывает и его |
| SQLite | не применяется | Локальный файл. Открытие файла ограничено отдельно: `min(timeout, 10000)` с нижней границей 50 мс |
| Redis | 5000 мс | `socket.connectTimeout` |

### Допустимые значения

`timeout` — **целое** число от 1 до 86400000 (24 часа) включительно. Отсутствует
или `null` — 30000 мс. `0` отклоняется, чтобы «без таймаута» нельзя было
получить случайно. Дробное значение отклоняется: оно попадает в
`SET statement_timeout` строковой подстановкой, и каждый драйвер обрезает его по
своему.

### Что именно прерывается

При срабатывании **собственного guard** сервера вызывается `adapter.abort()` и
запись кэша выбрасывается. Различия существенны, и фраза «соединение разрывается»
их скрывает.

| База | `abort()` | Это гарантия? |
|------|-----------|---------------|
| **PostgreSQL** | Отправляет **CancelRequest** по *второму* соединению: для каждой выполняющейся пары `(client, query)` создаётся новый `Client` и вызывается `client.cancel(client, query)`. | **Нет.** Это запрос. Оператор, который сервер ещё не начал принимать, или операция, не прерываемая снаружи, продолжит выполняться. Если соединение для отмены открыть не удалось, не отменяется ничего, и исходный оператор отрабатывает до конца. Гарантировано другое: пул не выдаётся снова, и `close()` не ждёт этот оператор. |
| **MySQL** | Уничтожает все сокеты пула, отслеживаемые через публичное событие `connection`. Объект пула намеренно **сохраняется**, чтобы `end()` освободил его бухгалтерию и таймер; вместо этого адаптер помечается как мёртвый, а слушатель уничтожает любой сокет, открытый после этого. | Для MySQL — практически да: уничтоженный сокет не может больше обслуживать оператор. `close()` вызывает `pool.end()`, но после `abort()` его **не** ждёт: команды `Quit`, которые он ставит в очередь, никогда не будут отвечены. |
| **MongoDB** | `client.close(true)` — принудительное закрытие, отменяющее операции в полёте. | Да, для этого клиента. |
| **SQLite** | `db.interrupt()` — отменяет выполняющийся оператор, но **оставляет дескриптор открытым**. | Только для того, что SQLite умеет прерывать. Длинный рекурсивный CTE внутри C-кода SQLite отрабатывает до конца. `close()` закрывает дескриптор после этого — старый код этого не делал и утекал дескриптор вместе с файловым дескриптором. |
| **Redis** | `client.destroy()`. | Да, для этого клиента. |

**Разрыв соединения и его выбрасывание — два разных вопроса, и на первый отвечает
таблица выше.** Разрыв — что сервер делает с оператором, от которого отказался.
Выбрасывание — нужно ли потом выбросить само соединение, потому что на нём может
ещё что-то выполняться. Для срабатывания guard ответ «да» везде. Для
**сообщённого драйвером** таймаута — нет, и ответ различается по базам:
PostgreSQL `57014`, MySQL `ER_QUERY_TIMEOUT` и SQLite `SQLITE_INTERRUPT`
выбрасывают; MongoDB `50` — **нет** (прерывание `maxTimeMS` оставляет сокет
рабочим, а прежний шаблон совпадал с фразой, которую писал сам `mongodb.js`, так
что каждая медленная агрегация платила переподключением); Redis — тоже нет,
потому что per-command таймаута у него нет вовсе.

Отмена самим клиентом (`notifications/cancelled`) идёт тем же путём: сервер
прекращает ждать, чтобы вызывающий получил ответ сейчас, и одновременно
прерывает и выбрасывает соединение, чтобы оператор не работал на занятом слоте
пула. Такая отмена сообщается как `kind: "timeout"` — именно этот совет
применим: следующий вызов должен быть дешевле или получить больше времени, — и
в тексте сказано, что именно произошло.

### Обработка ошибок

Сообщение всегда содержит `DATABASE_ERROR:` и строку `SUGGESTION:`, а между ними
код драйвера в квадратных скобках:

```
DATABASE_ERROR: <причина> [<КОД>]
SUGGESTION: <что делать дальше>
```

Код — единственный факт об отказе, который не переводится: он документирован
драйвером, стабилен между версиями и локалями и отвечает на вопрос «повторять
ли», на который сама фраза не отвечает. До его появления единственным способом
достать код было сопоставление с английским текстом драйвера — и именно так
ошибка PostgreSQL `column "timeout" does not exist` классифицировалась как
проблема соединения. Код дублируется в `structuredContent.error.code`: там по
нему стоит **ветвиться**, и он равен `null`, когда кода нет.

| Сообщение | Причина | Что делать |
|-----------|---------|-----------|
| `[Postgres timeout] Query exceeded 30000ms (statement_timeout)` | PostgreSQL отменил запрос по таймауту | Сузить запрос, добавить `LIMIT`, поднять `timeout` |
| `[Postgres cancelled] …` | SQLSTATE `57014` не от таймаута, а от чужой отмены — эти два случая различаются | Проверить, не отменил ли запрос кто-то ещё |
| `[Postgres relation (table or view) does not exist] …` | SQLSTATE `42P01` | Вызвать `db_schema`: код переводится в фразу, а не пробрасывается |
| `[MySQL query exceeded 30000ms timeout: …` | Драйвер или внешний guard; распознаются `ER_QUERY_TIMEOUT` и `ER_OPTION_PREVENTS_STATEMENT` | Добавить индекс или сузить выборку |
| `[MongoDB timeout] Query exceeded 30000ms (maxTimeMS)` | Истёк `maxTimeMS` или код драйвера `50` | Добавить индекс или поднять `timeout` |
| `[MongoDB sort failed] Sort exceeded the 32MB memory limit. …` | Лимит сортировки в памяти, а не таймаут | Добавить индекс или сузить фильтр |
| `SQLite query exceeded 30000ms timeout. The database is probably locked…` | Колбэк драйвера не пришёл, обычно из-за блокировки | Повторить или писать из процесса, который держит блокировку |
| `[SQLite locked] …` | `SQLITE_BUSY` | SQLite однопользовательский на запись; повторить |
| `[SQLite cannot open] …` | `SQLITE_CANTOPEN` или драйвер не сообщил об открытии в бюджет | Проверить путь в URI; сообщение содержит именно тот путь, который получил драйвер |
| `[Redis error] … (client timeout was 30000ms)` | Таймаут сокета или оборванное соединение | Период клиента назван для контекста; per-command таймаута у node-redis нет |
| `Operation "db_query (postgres)" timed out after 30500ms` | Сработал **внешний guard**: драйвер не смог прервать операцию или не сообщил об этом | Сузить запрос, добавить `LIMIT`, поднять `timeout` |

Последнее сообщение — **не** обычный путь. Обычный путь — сообщение уровня
драйвера, потому что именно оно называет настоящую причину.

Ещё две классификации, которые раньше сообщались не о том, чем являются:
ошибка **serialization** — это результат, который не удалось положить на провод
(`BigInt`, циклическая структура, `Buffer`), а не синтаксическая ошибка; и
таймаут SQLite раньше попадал в «проблему с синтаксисом», потому что
`callbackWithTimeout` отклонялся обычным `Error`, который не видел ни один
`instanceof TimeoutError`. Теперь отклоняется настоящим `TimeoutError`.

### Архитектура

```
withTimeout(timeout + 500 мс, onTimeout: cache.evict + adapter.abort)
 └─ cache.acquire(driver::<sha256 от resolved URI>, timeout)
      ├─ isHealthy() для записи в кэше и повторное проставление бюджета
      └─ adapter.connect(uri)                  если записи нет
 └─ десять проверок                            все до открытия сокета
 └─ adapter.execute(query)                     [таймаут базы]
 └─ clampResult + buildEnvelope
 └─ cache.release(entry)                       [соединение остаётся в кэше]
```

Три замечания к схеме, два из которых изменились, а одно было неверным всегда:

- **Ключ кэша — имя драйвера плюс первые 32 hex-символа SHA-256 от URI.** Не
  `protocol::uri`. Схема приводится к драйверу через ту же таблицу алиасов, что
  и маршрутизация, поэтому `postgres://h/d` и `postgresql://h/d` — **одна** запись
  и один пул к одному серверу. И пароля в ключе нет: долгоживущая структура,
  которую никто не считает хранилищем секретов, — это место, где учётные данные
  оказываются в core dump. Пароль остаётся *внутри* дайджеста, поэтому
  ротированный пароль даёт новое соединение, а не тихое повторное
  использование старого.
- **`release()` принимает запись, а не ключ.** Освобождение, пришедшее после
  вытеснения и замены записи, не должно уменьшать счётчик новой.
- **`isHealthy()` — не всегда круговой запрос.** PostgreSQL, MySQL и SQLite
  тратят по одному оператору (`SELECT 1`, `SELECT 1`, `SELECT 1 AS ok`).
  MongoDB и Redis читают локальное состояние клиента
  (`topology.isConnected()`, `client.isReady`). Ни то, ни другое не доказывает,
  что сервер здоров, — но оба варианта лучше, чем предполагать.
- Проверка read-only выполняется **до** `acquire`, поэтому отклонённый запрос не
  открывает сокет.

### Известные ограничения

- Оператор, который SQLite не способен прервать, продолжает выполняться.
  `db.interrupt()` останавливает большинство запросов, но длинный рекурсивный
  CTE внутри C-кода SQLite может отработать до конца. Соединение разрывается, так
  что никто не встаёт в очередь, и дескриптор закрывается, но сама работа не
  отменяется. Ставьте `LIMIT` на рекурсивные запросы.
- Отмена PostgreSQL — это запрос, а не команда.
- `MAX_EXECUTION_TIME` — хинт, и только на `SELECT`. MySQL может его
  проигнорировать, MariaDB игнорирует.
- У Redis нет per-command таймаута. Вызов ограничен внешним guard'ом и, только
  если вы его включили, страховкой на сокете. `ANYDB_REDIS_SOCKET_TIMEOUT_MS` по
  умолчанию не задан и намеренно не является бюджетом запроса.
- Обе страховки на сокете не проверены тестом. `ANYDB_MONGO_SOCKET_TIMEOUT_MS` и
  `ANYDB_REDIS_SOCKET_TIMEOUT_MS` срабатывают только под нагрузкой — на медленном
  запросе к занятому серверу, — поэтому живой набор их не выставляет. Они подключены
  и читаются, но путь прерывания не подтверждён на настоящем сервере.
- Прерывание по `maxTimeMS` у MongoDB **больше не выбрасывает соединение** — намеренно,
  потому что прежнее поведение рвало пул на каждой медленной агрегации без всякой
  причины. Если бы драйвер когда-нибудь оставлял сокет непригодным, это стало бы
  утечкой, а не переподключением; прикрывает проверка `isHealthy()` при следующем
  использовании, а у MongoDB она читает `topology.isConnected()` без запроса.
- Ввод из нескольких операторов отклоняется, и это именно то, что держит каждое
  выражение видимым для проверки read-only по отдельности.
- Лимиты результата ограничивают **этот процесс**, а не сервер: для PostgreSQL
  оператор всё равно выполняется до конца и все строки читаются из сокета;
  ограничивается массив разобранных строк. Исключение — MongoDB, где курсор
  читается и останавливается рано.
- Кэш соединений держит учётные данные в памяти в течение всего срока жизни
  записи; избавиться от этого, не разорвав соединение, нельзя.
- Неоткрываемый путь SQLite раньше удерживал вызов на весь его бюджет. Сейчас он
  ограничен дважды: бюджетом вызова и 10 с.

### Совместимость

Аргумент `timeout` в 3.0 не изменился. Значение `0` отклоняется начиная с 2.0.0.
Изменилось поведение при разрыве: у вызова PostgreSQL появился `abort()`,
которого в 2.0 не было, а для MySQL, MongoDB, SQLite и Redis разрыв теперь
описан явно, а не подразумевается. `TIMEOUT_GRACE_MS` остался 500 мс.
