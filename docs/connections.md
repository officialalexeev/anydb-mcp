# Connections

How a database is named, where the credential comes from, and what each option
costs you.

- [Why profiles](#why-profiles)
- [The `db.json` shape](#the-dbjson-shape)
- [Credential references](#credential-references)
- [How a call resolves](#how-a-call-resolves)
- [Per-profile policy](#per-profile-policy)
- [The ad-hoc `uri` escape hatch](#the-ad-hoc-uri-escape-hatch)
- [Schemes](#schemes)
- [Trade-offs](#trade-offs)
- [Related](#related)

---

## Why profiles

The single most important sentence in this project, and the one that is easiest
to get wrong:

> A URI argument puts a plaintext password in the model's context window, in the
> JSON-RPC frame on stdout, in the client's persisted transcript, and in every
> host's log — once per call, for the life of the session.

That is not a theoretical exposure. Every MCP host persists the conversation
somewhere, and the tool call is in it. Every host captures the server's stderr
into its own log. The credential is in all three, and it is there for as long as
the transcript is kept.

OWASP names the class `MCP01:2025 Token Mismanagement & Secret Exposure`, rates
it **Critical**, and the instruction attached to it is that a secret must never
pass through an LLM context window.

A profile fixes it. The model sends `{"profile": "app-readonly"}` — a name, and
sometimes a description it was already shown by `db_list`. The credential is
resolved from `db.json` on this side of the frame, injected into a connection
string, and never serialised towards the model. There is no code path that puts
it in a tool result.

Two further things fall out of the same design, which is why it is worth the
effort:

- **A model cannot mistype a credential.** It cannot reproduce one. With five
  databases it used to have to produce five full connection strings, and a
  transcription error was silent — the failure surfaced as an authentication
  error some minutes later.
- **Policy travels with the connection.** A profile can say `readOnly: true`,
  `maxRows: 500`, `allowedSchemas: ["public"]` and `hosts: ["*.example.com"]`,
  and those are properties of the database rather than of a call a model
  composed. See [per-profile policy](#per-profile-policy).

---

## The `db.json` shape

Two top-level keys and one optional:

```json
{
  "$schema": "https://anydb.dev/schema/db.json",
  "default": "app-readonly",
  "profiles": {
    "app-readonly": {
      "description": "Application database, read-only.",
      "uri": "postgres://app_ro@db.example.com:5432/appdb",
      "password": { "env": "APP_DB_PASSWORD" }
    }
  }
}
```

| Key | Required | Meaning |
|-----|----------|---------|
| `profiles` | yes | An object of named connections. At most 256, and a profile that sorts after that is not listed. |
| `default` | no | The profile an unqualified `profile` resolves to, and the one `db_list` lists first. Must name a profile that exists. |
| `$schema` | no | Ignored by this server, used by editors. |

Every recognised profile field:

| Field | Type | Meaning |
|-------|------|---------|
| `description` | string | The only part the model reads. Capped at 500 characters; control characters are stripped. |
| `driver` | string | One of `postgres`, `postgresql`, `mysql`, `mariadb`, `sqlite`, `mongodb`, `redis`, `rediss`. Optional when the `uri` scheme already says it; a mismatch is a warning, not an error. |
| `uri` | string | A connection string. Its scheme must be on the allowlist. |
| `path` | string | A SQLite file, **relative to the directory holding `db.json`**. Requires `driver: sqlite`. |
| `username` | string | Used to attach a password to a URI that has no userinfo. A `password` with no username anywhere is refused rather than guessed at. |
| `password` | string or object | A literal, or one of the four reference forms below. |
| `readOnly` | boolean | Default `true`. |
| `allowDestructive` | boolean | Default `false`. |
| `maxRows` | integer | 1 … 1000000. |
| `maxBytes` | integer | 1 … 67108864. |
| `queryTimeoutMs` | integer | 1 … 86400000. |
| `connectTimeoutMs` | integer | 1 … 60000. A connect that has not finished in a minute is a hang, not a slow database. |
| `allowedSchemas` | string[] | SQL only. At most 128 entries, 256 characters each. |
| `allowedTables` | string[] | SQL only. Same limits. |
| `hosts` | string[] | A host allowlist for this profile. `*` and a leading `*.` are the only wildcards. |
| `allowedPaths` | string[] | SQLite only, resolved against the config directory. Directory allowlist. |
| `options` | object | Driver options passed through verbatim. At most 64 keys, each a string, number or boolean. |

Rules worth stating because they are load-time errors rather than surprises:

- A profile must have **either** `uri` **or** `path`. There is nothing to connect
  to without one, and the message says what to write for SQLite.
- `path` with a driver other than `sqlite` is refused. A `path` and a `uri`
  together is a warning, and `uri` wins.
- A `password` next to a `path` is refused: a SQLite file is opened with this
  process's filesystem permissions and has no credentials.
- The names `__proto__`, `constructor` and `prototype` are refused. A profile
  name becomes a key in a plain object, and those three are how a config file
  becomes a prototype-pollution gadget.
- An **unrecognised key is ignored with a warning, not obeyed**, and the warning
  is once per profile per process. A config written for a newer version still
  loads here; the alternative is that a server stops working because of a key it
  was told to add, and the natural response to that is to delete the key.
- An empty file is not an error. `db_list` reports zero profiles and explains
  what to do instead.

`examples/db.json.example` is a fully commented template covering all five
databases, all four credential forms, and the policy fields.
`examples/db.json` is a runnable, credential-free file: copy it to
`~/.anydb/db.json` and `db_list` works on a machine that has nothing installed.

---

## Credential references

The answer to "the file holds secrets" is not "then don't have a file". It is the
same answer AWS and 1Password converged on: keep the *reference* in the file and
the *secret* somewhere else. Exactly one source, no unrecognised fields — a
misspelled `{"environment": …}` would otherwise resolve to no credential at all,
and the failure would surface as an authentication error at the database instead
of as a typo in a config file.

### `{"env": "NAME"}`

```json
"password": { "env": "APP_DB_PASSWORD" }
```

Read from this process's environment. An unset **or empty** variable is a named
error naming the variable — no fallback, because a profile that says "the password
is in this variable" and does not find it is a misconfiguration, and quietly
using the literal left next to it would turn a visible failure into a mysterious
one.

### `{"file": "/run/secrets/db_password"}`

```json
"password": { "file": "/run/secrets/db_password" }
```

One trailing newline is removed, because every way of writing a secret file ends
one and a password with a newline fails authentication at the server. Refused if
the path is not a regular file, or is larger than 64 KiB — a file holding a
password is small, and something else being in there is worth saying out loud.
A file readable beyond its owner is warned about **once** and not refused: POSIX
mode bits on a network mount, in a container, or under a fuse layer report values
that mean nothing, and refusing a working configuration over an unreliable check
is worse than saying so.

### `{"exec": ["op", "read", "op://vault/db/password"]}`

```json
"password": { "exec": ["op", "read", "op://vault/db/password"], "timeoutMs": 5000 }
```

An argv array, run with `execFile` and **no shell anywhere in the path**. That is
the whole reason for the array: `exec` hands its string to `/bin/sh`, where a
service name or a key name from the config file could carry `; rm -rf ~` and have
it run. Here every element arrives at the child process as one argv entry and
nothing is ever re-parsed. `windowsHide` is set, because a console window per
credential lookup is noise on Windows and a hint to anything watching the desktop.

stdout is the secret, trimmed of one trailing newline. On failure the message
reports the exit code, the signal, or "the program was not found on PATH" — and
deliberately **not** the captured output, because stderr from a credential helper
can be the credential: `op` echoes a partial secret on a locked-vault error, and
a shell script may well `echo "$PASSWORD"` while debugging.

### `{"keychain": "anydb/redis", "account": "default"}`

```json
"password": { "keychain": "anydb/redis", "account": "default" }
```

There is no cross-platform keychain reader in Node's standard library, and this
project takes no runtime dependency beyond database drivers, so one is not built
in. There are two ways to supply it, and the error message names both:

1. **Embed the package** and pass a `keychainProvider(service, account)` to
   `createServer()`. This is the only route that can read macOS
   Security.framework, Windows Credential Manager or libsecret.
2. **Set `ANYDB_KEYCHAIN_CMD`** to a command template:

   ```
   ANYDB_KEYCHAIN_CMD=op read op://{service}/{account}
   ANYDB_KEYCHAIN_CMD=security find-generic-password -s {service} -a {account} -w
   ```

   `{service}` and `{account}` are substituted, the template is split on
   whitespace, and the result runs through `execFile` — no shell. A quoted token
   is unwrapped, because a value copied out of a `.env` often still has them on.

   The template is **not** settable from `db.json`, and that is the point: a
   writable config file must not be able to choose what this server executes. It
   costs you the ability to express a service or account name containing a space,
   which is what a `keychainProvider` is for.

### A literal, too

```json
"password": "some-plaintext-password"
```

Accepted, and warned about once per profile. It is the ordinary case — a password
in a 0600 file is what `~/.pgpass` has always been — and refusing it would break
most people's first hour. But it makes the file itself the secret, and a crash
report, a backup or a `git add -A` is then a leak.

---

## How a call resolves

1. `db_list` re-reads the config file and returns
   `{ name, description, driver, default, readOnly }` per profile. No URI, no
   host, no username, no password, no path — **not masked, absent**, because a
   masked connection string still discloses the host and the database name, and
   this text goes into a context window and gets quoted back in a conversation.
2. The model calls `db_query` with `{"profile": "<name>", …}`. Exactly one of
   `profile` or `uri`; both is refused, neither is refused, and both messages say
   which.
3. `ProfileStore.resolve()` reads the entry, materialises the credential into a
   connection string, and builds the merged policy.
4. `checkConnectionPolicy()` decides whether that string may be opened at all.
5. The cache is keyed on a driver name plus a truncated SHA-256 of the resolved
   URI, so two spellings of the same server share one pool and a rotated password
   gets a new connection.

The resolved credential-bearing URI is never logged, never returned, and never
attached to an error. The value handed back to the registry is the *name* the
model sent, not the connection it resolved to — otherwise a profile call would
look ad-hoc to `resolveTarget`, the profile's own `readOnly` and `maxRows` would
be dropped on the way in, and the envelope would report no profile.

The file is re-read on every `db_list`, so a config somebody has just written is
visible without restarting the server.

---

## Per-profile policy

Every policy field in a profile is a **default that a call can override**, except
`hosts` and `allowedPaths`, which are gates rather than defaults. A per-call
argument that is present wins; one that is absent — including `null` — does not.

| Field | What it does | Is it a boundary? |
|-------|--------------|-------------------|
| `readOnly` | The read-only default for this profile. | No. See below. |
| `allowDestructive` | Whether a schema change may run on this profile at all. | No. |
| `maxRows` / `maxBytes` | The result caps for this profile. | A cost control, not correctness. |
| `queryTimeoutMs` / `connectTimeoutMs` | The budgets for this profile. | A cost control. |
| `allowedSchemas` / `allowedTables` | A heuristic over table names in the statement text. | **No.** See below. |
| `hosts` | A host allowlist for this profile. | A real gate, checked before a socket is opened. |
| `allowedPaths` | A directory allowlist for SQLite paths. | A real gate. |

### The two that are not boundaries

**`readOnly` and `allowDestructive` are a request to this server.** Both come from
the same agent in the same call:

```json
{ "profile": "app", "query": "DROP TABLE users", "readOnly": false, "allowDestructive": true }
```

That is a sentence, not a control. It stops one thing — the model that meant
`DELETE FROM drafts` and wrote `DROP TABLE drafts` — and it does that well. It
does not stop a model that has been talked into setting both flags, and nothing
in this project will. The control that holds is a database role that cannot run
the statement at all: a login without `DROP` cannot be made to `DROP` by any
value in a JSON-RPC frame.

**`allowedSchemas` is a scanner, not a parser.** It reads table references out of
the statement text with a regular expression and checks them against the list. So:

- A dynamically constructed name defeats it completely. A table name arriving as
  a bound parameter is not an identifier the scanner can see.
- It over-refuses. `EXTRACT(x FROM y)` names something that is not a table,
  `SELECT 1 FROM DUAL` names a table that does not exist, and `FROM ONLY t` is
  read as `ONLY`.
- It sees the statement, not the session. A `search_path`, a synonym, a view, a
  foreign table and a `TEMP` table all resolve to something else.

With `allowedSchemas` set, an unqualified table name is **refused** rather than
resolved against a `search_path` this check cannot read, and the message names
the fix. The alternative this rejects — enforcing the list by setting
`search_path` per call — needs a per-call session setting on a pooled connection,
which is a much larger change than a heuristic.

Both of these are documented in the code where they are implemented, with the
same warning, because the failure mode of a heuristic described as a boundary is
a false sense of security rather than a wrong answer.

---

## The ad-hoc `uri` escape hatch

`uri` still works, and it is what you use when there is no config file. It is
**on by default**, which is a compatibility decision: 2.x only had raw URIs, and
turning it off in a patch release would break every existing configuration
overnight. It belongs in a major version, which is the version `db.json` exists
and the migration path is documented in.

```json
{ "uri": "sqlite:///path/to/app.db", "query": "SELECT 1" }
```

When to use it:

- There is no config file and you are evaluating the server.
- The database is a local SQLite file for a one-off question.
- You are writing a test, and a file would be ceremony.

When to turn it off:

```bash
ANYDB_ALLOW_ADHOC_URI=0
```

After that every statement has to name a profile, which means every connection is
something a human wrote rather than something a model composed. It is the same
effect as documenting the rule, enforced by the server instead of remembered by
the model.

**What it does not do:** it does not stop a model from connecting anywhere a
profile points. It removes the ad-hoc path; it does not review the profiles you
wrote.

The two are genuinely equivalent for a determined attacker who can already write
`db.json`, which is stated rather than glossed over. The difference is that
`db.json` is a file with permissions, and a JSON-RPC frame is not.

---

## Schemes

| Database | Schemes |
|----------|---------|
| PostgreSQL | `postgres://`, `postgresql://` |
| MySQL / MariaDB | `mysql://`, `mariadb://`, `mysql+pymysql://`, `mysql+mysqldb://`, `mysql+asyncmy://`, `mysql+aiohttp://`, `mysql+aiomysql://`, `mysql+cymysql://`, `mariadb+pymysql://`, `mariadb+mariadbconnector://` |
| SQLite | `sqlite://`, `sqlite+pysqlite://` |
| MongoDB | `mongodb://`, `mongodb+srv://` |
| Redis | `redis://`, `rediss://`, `redis-cluster://`, `redis-sentinel://` |

All twenty are on the policy allowlist, all twenty route, and all twenty validate in
a `db.json`. **A scheme is only as real as all three lists.** Adding one means
adding it in three places — `ROUTES` in `src/core/registry.js` (or the connection
is unroutable), `DEFAULT_ALLOWED_SCHEMES` in `src/core/policy.js` (or the policy
refuses it), and `SCHEME_ALIASES` in `src/core/profiles.js` (or a profile naming
that scheme will not validate) — and a fourth, quieter one: `isSqlProtocol` in
`src/core/safety.js` must accept every scheme on a SQL route, or the gates that
*begin* with it return early and enforce nothing. `__tests__/test_schemes.test.js`
walks the policy list and fails if a scheme is allowed but not routed, and
`__tests__/test_safety.test.js` asserts the `isSqlProtocol` coverage for the whole
table, so a scheme cannot be added to three of four places and pass.

**What used to be broken, and why it produced two different messages.**
`mysql+aiomysql`, `mysql+cymysql`, `mariadb+pymysql` and `mariadb+mariadbconnector`
were in the policy allowlist and in the profile validator the whole time, so a
`db.json` naming one validated and then died in the router with `Protocol "…" is not
supported`. Each was missing from a different list, which is why the fix is a test
over the list rather than another edit. `mariadb://` itself was worse: it is a
`package.json` keyword, so it was a `driver` value people reasonably expected to
work, and it did not route either. `mongodb+srv://` — the connection string almost
everybody pastes out of Atlas — was rejected outright.

**Redis Cluster and Sentinel are now reachable.** `redis-cluster://` builds a
`createCluster` client with `rootNodes`, and `redis-sentinel://` builds a
`createSentinel` client with the master's name taken from the path
(`redis-sentinel://:pass@sentinel:26379/mymaster`). Both existed in the adapter
long before the policy allowlist did, and without a policy entry
`checkConnectionPolicy` refused the connection before the adapter was ever
constructed — so the code had no caller. Cluster and Sentinel are ordinary
production topologies, so the schemes are allowed and routed rather than the code
deleted. **Neither is exercised against a live server**; see
[__tests__/README.md](../__tests__/README.md).

**One caveat worth knowing before you rely on the SQLAlchemy spellings.**
`src/adapters/mysql.js` rewrites exactly four `mysql+<dialect>` forms to `mysql://` —
`pymysql`, `mysqldb`, `asyncmy`, `aiohttp` — and does not touch `mysql+aiomysql`,
`mysql+cymysql` or any `mariadb+` form. Those six work anyway, because the adapter
builds its `mysql2` config from the URL's `hostname`, `port`, `username` and
`pathname` and never passes the scheme on, and `new URL()` is indifferent to a
legal scheme token. That is an implicit dependency on driver behaviour rather than
a contract this project states; it is recorded as a known limitation in the
[README](../README.md#known-limitations) so the next maintainer does not have to
rediscover why the obvious normalisation is absent.

**MariaDB is a dialect, not just a scheme.** `"driver": "mariadb"` was always a
valid value in `db.json`; what it lacked was a dialect identity in the guard. That
is fixed — see [docs/security.md](security.md) for what it was costing — so a
per-profile `allowedSchemas` / `allowedTables` now genuinely applies to a MariaDB
connection, and MariaDB's string literals are parsed with the backslash-escape
rules the server actually has.

---

## Trade-offs

**What a profile costs you.** One file to keep, at 0600, in a directory at 0700.
The credential reference has to point at something — an environment variable, a
file, a command, a keychain reader — and that is a thing to set up. For a single
local SQLite file, `uri` is genuinely simpler and the difference does not matter,
because there is no credential in it.

**What it buys.** The credential never enters a context window, a transcript, or a
host log. A model cannot mistype or leak a password it never sees. Policy is a
property of the database rather than of a call. And the failure mode when a config
is wrong is a named, actionable error — the message names the file, the JSON
pointer, the field, what it got and what it wanted — rather than an authentication
error some minutes later.

**What it does not buy.** A writable `db.json` is a writable connection. And a
profile whose `readOnly` is `true` is a request, not a control. Both of those are
closed with filesystem permissions and database grants, in that order.

---

## Related

- [docs/configuration.md](configuration.md) — every `ANYDB_*` variable, the
  platform paths, and the precedence order.
- [docs/security.md](security.md) — the threat model, SSRF, local file disclosure,
  and the operator hardening checklist.
- [SECURITY.md](../SECURITY.md) — disclosure, and the checklist in the order that
  actually buys something.
- [examples/db.json.example](../examples/db.json.example) — a commented template
  with all four credential forms.
