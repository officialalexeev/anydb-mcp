# Configuration

Every `ANYDB_*` variable, where each file lives, and the order they are read in.

- [Environment variables](#environment-variables)
- [Where files live](#where-files-live)
- [Precedence](#precedence)
- [`.env` files](#env-files)
- [Worked example: a `db.json` walkthrough](#worked-example-a-dbjson-walkthrough)
- [Related](#related)

---

## Environment variables

There are **41** of them. They are read fresh at the moment they matter — nothing
is snapshotted at startup except the connection cache's own bounds — so a value
changed in the environment of a running process is picked up by the next call.
Not all of them can be changed that way, though: see the note under
[the server](#the-server-and-the-process).

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`. A value that is
not one of those falls back to the documented default rather than being guessed
at, so a typo in a hardening switch never silently reads as a decision.

Integers go through a guard that rejects `0`, `-1`, `1e9` and `abc` and falls
back to the default. An environment variable must never be able to remove a bound
the code depends on.

### Profiles and config location

| Variable | Default | Effect |
|----------|---------|--------|
| `ANYDB_CONFIG` | unset | An explicit path to `db.json`. Wins over every other location. A path that does not exist is a warning on stderr and an empty profile list, **not** a fatal error: a server with no profiles still works for anyone passing an ad-hoc `uri`. |
| `ANYDB_HOME` | `~/.anydb` | The directory `db.json` is read from, unless `ANYDB_CONFIG` says otherwise. Set it to keep the config out of `$HOME` entirely — a read-only container, a per-project config, a test fixture. |
| `ANYDB_ENV_FILE` | unset | Path to a dotenv file, or one of `off` `0` `false` `no` `none` `-` `disable` to turn dotenv loading off. Unset means "try `~/.env`, then `./.env`". |

### Credential sources

| Variable | Default | Effect |
|----------|---------|--------|
| `ANYDB_KEYCHAIN_CMD` | unset | A command template for a `{"password": {"keychain": …}}` reference. `{service}` and `{account}` are substituted, the template is split on whitespace, and the result is run with `execFile` — no shell, so nothing in `db.json` can become a second command. The per-reference `timeoutMs` applies, and it defaults to 5000 ms. |

The command template is deliberately not settable from `db.json`: a writable
config file must not be able to choose what this server executes. Embedding the
package and supplying a `keychainProvider` is the other route, and it is the only
one that can read a native keychain.

### Policy defaults

These are the fallbacks for a profile that says nothing. A profile field wins over
them; a per-call argument wins over both.

| Variable | Default | Effect |
|----------|---------|--------|
| `ANYDB_DEFAULT_READ_ONLY` | `true` | The read-only default for a profile that does not set `readOnly`. |
| `ANYDB_DEFAULT_MAX_ROWS` | `1000` | Rows returned when nothing else says otherwise. |
| `ANYDB_DEFAULT_MAX_BYTES` | `262144` | Bytes of result returned when nothing else says otherwise. 256 KiB. |
| `ANYDB_DEFAULT_QUERY_TIMEOUT_MS` | `30000` | Statement budget. |
| `ANYDB_DEFAULT_CONNECT_TIMEOUT_MS` | `5000` | Connect budget for PostgreSQL, MySQL, MongoDB and Redis. SQLite has none: it is a local file. |
| `ANYDB_ALLOW_DESTRUCTIVE` | `false` | Whether a *destructive* statement may run at all, before the per-call `allowDestructive` and the profile field are considered. |
| `ANYDB_MAX_ROWS` | unset | Direct fallback for `clampResult` when a caller passes no limit. In a running server `ANYDB_DEFAULT_MAX_ROWS` is what actually takes effect, because `evaluatePolicy` is the layer that supplies the number; this pair is the fallback for a direct caller of `clampResult`. Both names exist so neither is a mystery. |
| `ANYDB_MAX_BYTES` | unset | The same relationship to `ANYDB_DEFAULT_MAX_BYTES` for the byte cap. |

### Connection policy

The SSRF, host and local-file gates. See [docs/security.md](security.md) for
what each one is and is not.

| Variable | Default | Effect |
|----------|---------|--------|
| `ANYDB_ALLOW_ADHOC_URI` | `true` | Whether a call may pass a raw `uri` instead of naming a profile. Set `0` and every statement has to name a profile, which is the lock-down switch. |
| `ANYDB_ALLOWED_SCHEMES` | 20 schemes, listed below | A comma-separated allowlist of URI schemes. An allowlist, so anything unlisted is refused. |
| `ANYDB_ALLOWED_HOSTS` | unset | A comma-separated host allowlist. Two wildcards are honoured and only two: `*` matches everything, and a leading `*.` matches subdomains but **not** the bare domain. |
| `ANYDB_ALLOW_PRIVATE_HOSTS` | `false` | `1` lifts every blocked private range and skips the DNS lookup entirely. The normal setting for a database on `localhost` or in a Docker network. |
| `ANYDB_STRICT_SQLITE_PATHS` | `false` | `1` inverts the SQLite default: a path must be named in advance, in a profile's `allowedPaths` or in `ANYDB_ALLOWED_SQLITE_PATHS`. |
| `ANYDB_ALLOWED_SQLITE_PATHS` | unset | A comma-separated list of directories a `sqlite://` URI may open. A path matches only when it is the directory itself or sits inside it on a path-segment boundary. |

The default scheme allowlist, which is also what a profile's `"uri"` is validated
against. Twenty schemes, in the order `DEFAULT_ALLOWED_SCHEMES` holds them —
which is also the order a refusal message prints them in:

```
postgres  postgresql
mysql     mariadb
sqlite    sqlite+pysqlite
mongodb   mongodb+srv
redis     rediss  redis-cluster  redis-sentinel
mysql+pymysql  mysql+mysqldb  mysql+asyncmy  mysql+aiohttp  mysql+aiomysql  mysql+cymysql
mariadb+pymysql  mariadb+mariadbconnector
```

**All twenty route, all twenty validate in a `db.json`, and all twenty are
enforced by the read-only guard.** A scheme has to be in three lists to be real —
`ROUTES` in `src/core/registry.js`, `DEFAULT_ALLOWED_SCHEMES` here, and
`SCHEME_ALIASES` in `src/core/profiles.js` — and a fourth one that is easy to
forget: `isSqlProtocol` in `src/core/safety.js` has to accept every scheme on a
SQL route, or `assertSqlAllowlist` returns early and `allowedSchemas` /
`allowedTables` are never checked. A scheme in this list but missing from the
router used to be the worst case available, because it validated and was then
refused at the last moment with `Protocol "…" is not supported`. That is now a
test failure (`__tests__/test_schemes.test.js` and `__tests__/test_safety.test.js`)
rather than something a user discovers.

`redis-cluster://` and `redis-sentinel://` were in this list and **not** in the
router, which is the same failure with the opposite polarity: the adapter had
`createCluster` and `createSentinel` code with no caller, because
`checkConnectionPolicy` refused the connection before the adapter was constructed.
Both are ordinary production topologies, so the schemes are allowed and routed
rather than the code deleted — but neither has been run against a real cluster or
sentinel set. See [docs/connections.md](connections.md) and
[__tests__/README.md](../__tests__/README.md).

### Connection cache

| Variable | Default | Effect |
|----------|---------|--------|
| `ANYDB_CACHE` | on | `0` opens a connection per call, as 2.0.0 and earlier did. |
| `ANYDB_CACHE_MAX` | `8` | Cached connections to keep. The least recently used **idle** one is closed beyond this; a connection in use is exempt, so the cache can sit briefly above the limit. |
| `ANYDB_CACHE_TTL_MS` | `300000` | Close a connection idle for longer than this. Capped at one hour. Also sets the PostgreSQL pool's `idleTimeoutMillis`, so a warm socket survives the whole window the cache is willing to keep the entry. |

The cache key is a driver name plus a truncated SHA-256 of the resolved URI, not
the URI itself: a long-lived map that nobody thinks of as a secret store is where
credentials end up in a core dump. The credential stays in the digest, so a
rotated password produces a different key and therefore a new connection rather
than a silent reuse of one authenticated with the old value.

### Logging

Every record is written to **stderr** as one `[anydb]` line. The file sink is
additional, and turning it off does not turn off stderr.

| Variable | Default | Effect |
|----------|---------|--------|
| `ANYDB_LOG_LEVEL` | `info` | One of `error`, `warn`, `info`, `debug`, `trace`. `error` is the most severe; a record is emitted when its level is at or below the threshold. |
| `ANYDB_LOG_FORMAT` | `text` | `text` renders `[anydb] <ts> <level> <event> <msg> k=v …`; `json` renders the same record as one JSON object per line. |
| `ANYDB_LOG_FILE` | resolved per platform, `anydb.log` | An absolute or relative path is used as given; a bare name goes in the resolved log directory. The values `stderr`, `console`, `-` mean stderr, and `off`, `none`, `null`, `0`, `no`, `disable`, `disabled` mean no file at all. |
| `ANYDB_LOG_DIR` | platform default | The log directory. Overrides the whole per-platform resolution. |
| `ANYDB_LOG_MAX_BYTES` | `5242880` | Rotate at 5 MiB. Checked on the way in, so the active file never exceeds the cap by more than one record. |
| `ANYDB_LOG_BACKUPS` | `3` | Rotated files kept: `anydb.log.1` … `anydb.log.3`. Rotation is a rename per slot, never a compression, so a crash mid-rotation can lose at most the file being rotated. |
| `ANYDB_LOG_TTL_DAYS` | `30` | Rotated files older than this are swept. At most once an hour. |
| `ANYDB_LOG_MAX_VALUE` | `512` | Characters a single top-level string field is cut at. `query`, `sql`, `statement`, `error` and `stack` are exempt: those are the event, not an annotation on it. |
| `ANYDB_LOG_QUERY_TEXT` | `false` | `1` puts the **full statement text** in the log *file* as well as stderr. Off by default because a statement routinely carries a literal that is somebody's personal data, and a retained file is a liability. |
| `ANYDB_DEBUG` | `false` | `1` raises the effective level to `debug` whatever `ANYDB_LOG_LEVEL` says, and is what the `SUGGESTION:` line means when it offers you a stack trace. It is a different knob from the level: one says how much to keep, the other says whether you are debugging now. |

### The server and the process

| Variable | Default | Effect |
|----------|---------|--------|
| `ANYDB_PROGRESS_MS` | `2000` | After this many milliseconds, start sending `notifications/progress` — but only for calls that sent a progress token, that are expected to take longer than the threshold, and that have a transport to send on. A query that finishes in 40 ms should not pay for a frame. |

This one is read **per server**, from the environment handed to `createServer()`,
not per record. Everything else in this table is read at the moment it is used.

### Adapters

| Variable | Default | Effect |
|----------|---------|--------|
| `ANYDB_PG_POOL_MAX` | `4` | PostgreSQL pool size. Concurrent statements one cached connection may have in flight. |
| `ANYDB_MYSQL_POOL_MAX` | `4` | The same for MySQL's `connectionLimit`. |
| `ANYDB_MONGO_POOL_MAX` | `4` | MongoDB `maxPoolSize`. The driver's own default is 100 per server, which for a cached adapter shared by concurrent callers is a socket storm waiting for a burst. |
| `ANYDB_MONGO_POOL_MIN` | `0` | MongoDB `minPoolSize`. |
| `ANYDB_MONGO_WAIT_QUEUE_MS` | `ANYDB_MONGO_POOL_MAX * 1000` = `4000` | How long a caller may wait for a pooled socket. The driver's default of 0 is "wait forever". |
| `ANYDB_MONGO_SOCKET_TIMEOUT_MS` | the call's own `queryTimeout`, so `30000` | `socketTimeoutMS`. Bounds an individual operation, which `serverSelectionTimeoutMS` does not. |
| `ANYDB_REDIS_SOCKET_TIMEOUT_MS` | `0`, meaning no socket timeout | A backstop for a connection that has gone quiet. node-redis has no per-command timeout, so this is deliberately *not* the query budget: a client created by a first call with `timeout: 1000` once kept that socket timeout for the life of the cache entry, cutting off every later call at a limit the caller never set. |
| `ANYDB_SQLITE_BUSY_TIMEOUT_MS` | `5000` | How long a contended statement waits for the write lock. sqlite3's own default is 1000 ms, and `PRAGMA busy_timeout` is on the read-only blocklist, so an agent could never raise it. |
| `ANYDB_SCHEMA_FAN_OUT` | `8`, capped at `32` | How many per-object `db_schema` round trips may be in flight at once. Unbounded fan-out against one server is the socket storm the pool sizes exist to prevent. |

---

## Where files live

| What | POSIX | macOS | Windows |
|------|-------|-------|---------|
| Config directory | `~/.anydb` | `~/.anydb` | `%USERPROFILE%\.anydb` |
| Config file | `~/.anydb/db.json` | `~/.anydb/db.json` | `%USERPROFILE%\.anydb\db.json` |
| Config file, XDG | `$XDG_CONFIG_HOME/anydb/db.json`, else `~/.config/anydb/db.json` | same | same |
| Log directory | `$XDG_STATE_HOME/anydb`, else `~/.local/state/anydb` | `~/Library/Logs/anydb` | `%LOCALAPPDATA%\anydb\logs` |
| Log file | `…/anydb.log` | `…/anydb.log` | `…\anydb.log` |

`ANYDB_CONFIG`, `ANYDB_HOME`, `ANYDB_LOG_DIR` and `ANYDB_LOG_FILE` override the
corresponding row. `ANYDB_CONFIG` is a file path, not a directory; a trailing
separator makes the rest of the code treat it as a directory and write
`db.json` inside it.

**The XDG path is a secondary lookup, not a write target.** anydb's dotfile
predates the convention, so the reader may consult `$XDG_CONFIG_HOME` and the
writer still uses `~/.anydb`. The rule is *first existing one wins*, not *first
one wins*: a machine following the XDG spec may well have an empty `~/.anydb`
directory, and an absent default that shadows a real config is the worse failure.

**Permissions.** The config directory is created `0700` and the config file
`0600` when this server writes either one, and the log directory and file the
same way. A file you created yourself keeps whatever mode you gave it, which is
why `chmod 600` is in the hardening checklist rather than assumed.

---

## Precedence

For the policy a call runs under, lowest to highest:

1. The built-in defaults in `POLICY_DEFAULTS`.
2. The `ANYDB_DEFAULT_*` environment variables.
3. The profile entry in `db.json`.
4. The arguments of the call itself.

The environment sits **under** the profile on purpose: a profile is a file
somebody wrote on purpose, and an operator debugging a shared install should be
able to loosen a limit without editing every profile. A per-call argument that is
present wins; one that is absent — including `null` — does not, which is why a
profile that deliberately sets `readOnly: false` is not silently overridden by a
resolved `true` on the way in.

For the config file itself:

1. `ANYDB_CONFIG`, if it is set to a non-empty value.
2. The `ANYDB_HOME`/`~/.anydb` `db.json`, if it exists.
3. The XDG `anydb/db.json`, if it exists.
4. The `ANYDB_HOME`/`~/.anydb` path, reported as the place a file *would* be
   read from, so the message telling somebody to create one is a real path.

A missing config file is not an error. `db_list` says so in as many words and
tells the caller to use `uri` instead, because "the list is empty" and "there is
no config file" have different next steps and a model that cannot tell them apart
either invents a profile name or gives up.

---

## `.env` files

A `.env` is read once, lazily, at the first log record or policy check, and it is
not fatal: a bad `.env` is a degraded configuration, not a reason to refuse to
run.

Two rules, both load-bearing:

1. **A variable already set in the real environment always wins.** Cursor, Claude
   Desktop and Zed launch an MCP server with whatever environment their own
   process happened to have, and the file on disk is a default, not an override.
   Overwriting it would silently defeat a deliberate `ANYDB_DEBUG=1` in the
   server's launch configuration.
2. **Only `ANYDB_*` is applied**, and the contents are never logged. The file
   exists to hold connection URIs and tokens; it is not a general dotenv.

The file it looks for is `ANYDB_ENV_FILE` if set, otherwise `~/.env`, otherwise
`./.env` — the working directory of the *server process*, which is set by the MCP
client. Accepted syntax is `KEY=value` lines, `#` comments, an optional `export`
prefix, single or double quotes, and an unquoted value ending at a ` #`.

---

## Worked example: a `db.json` walkthrough

A profile that is doing the work in a real deployment:

```json
{
  "default": "app-readonly",
  "profiles": {
    "app-readonly": {
      "description": "Application database, read-only.",
      "uri": "postgres://app_ro@db.example.com:5432/appdb",
      "password": { "env": "APP_DB_PASSWORD" },
      "maxRows": 500,
      "maxBytes": 131072,
      "queryTimeoutMs": 15000,
      "hosts": ["*.example.com"],
      "allowedSchemas": ["public"]
    }
  }
}
```

What each line does, in the order they matter at run time.

**`default`.** The profile an unqualified `profile` resolves to, and the one
`db_list` lists first — followed by the rest alphabetically, so a transcript does
not change order between calls. It must name a profile that exists or the file is
refused.

**`description`.** The only part of the file the model reads. Capped at 500
characters, control characters stripped, and truncated with a warning past that.
It is a context cost and a prompt-injection surface: anyone who can write this
file can say something in it.

**`uri` without a password.** The scheme is validated against the same allowlist
the connection policy uses, and the profile is refused at load time for one that
is not there. The host is the real host. What is *not* in this string is the
password, which is the whole point of the next line.

**`password: {"env": "APP_DB_PASSWORD"}`.** Read here, on this side of the
JSON-RPC frame. The tool call carries `{"profile": "app-readonly"}` — a name —
and the credential is materialised into a connection string that is never
serialised towards the model. An unset or empty variable is a named error, not a
silent empty password.

**`maxRows` / `maxBytes` / `queryTimeoutMs`.** Per-profile, and they override the
`ANYDB_DEFAULT_*` variables while a per-call argument still overrides both.
`maxRows` is a ceiling, not a request: the response says whether anything was
dropped, and a `truncated: true` result is a **prefix** of the answer.

**`hosts`.** Checked before any socket is opened, and against *every* address the
name resolves to, not just the first. A per-profile list and
`ANYDB_ALLOWED_HOSTS` both apply; the tighter one wins. `*.example.com` permits
`db.example.com` and not `example.com`.

**`allowedSchemas`.** A heuristic over identifiers, not a parser and not a
boundary: it reads table names out of the statement text, so a dynamically
constructed name defeats it, `EXTRACT(x FROM y)` over-refuses, and it cannot see
`search_path`, a synonym, a view or a `TEMP` table. With it set, an unqualified
table name is **refused** rather than resolved against a `search_path` the check
cannot read. The database role is the control that holds.

Then the call the model makes, which is what actually crosses the wire:

```json
{ "profile": "app-readonly", "query": "SELECT count(*) FROM users WHERE created_at > $1", "params": ["2026-01-01"] }
```

No host, no username, no password, no database name. `db_health` on the same
profile reports the role, the server version and whether the role looks
read-only, so the thing worth knowing about a connection is something a call
returns rather than something an operator has to go and look up.

---

## Related

- [docs/connections.md](connections.md) — profiles, the four credential
  references, and the ad-hoc `uri` escape hatch.
- [docs/security.md](security.md) — the threat model, including what each of
  these switches does *not* do.
- [docs/timeout-configuration.md](timeout-configuration.md) — the timeout layers
  and the per-adapter mechanisms.
- [SECURITY.md](../SECURITY.md) — how to report a vulnerability, and the operator
  hardening checklist.
