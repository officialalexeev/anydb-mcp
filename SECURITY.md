# Security Policy

`anydb-mcp` reads database credentials and executes model-generated SQL against
whatever database it is pointed at. Treat it as a component with the privileges
of the database role you give it, not as a sandbox.

## Supported versions

Security fixes land on the latest release only, and only for 3.x.

| Version | Supported |
|---------|-----------|
| 3.x      | yes       |
| 2.x      | no        |
| < 2.0    | no        |

There is no LTS line and no backport policy. If you are on 2.x, the supported
upgrade path is 3.0.0, and it is a breaking release: the tool set changed,
`db_query` and `db_schema` return a response envelope, `uri` is no longer the
only way to name a database, and the MongoDB and Redis result shapes changed.

## Reporting a vulnerability

**Do not open a public issue.** A public issue is world-readable before anyone
can take it down, and a credential-disclosure or injection bug needs to be
fixed before it is described.

Use GitHub's private reporting on the Security tab of the repository:

> https://github.com/officialalexeev/anydb-mcp/security/advisories/new

If that form is unavailable to you, email the maintainer at the address in
`package.json` with the subject line `SECURITY`. Do not put the details in a
public issue, a gist, a paste site, or a social post.

Please include:

- the version (`npm ls anydb-mcp`, or the output of `db_health`, which reports it),
- the tool you called (`db_query`, `db_schema`, `db_explain`, `db_health`, `db_list`),
- the driver and URI scheme, with **the password removed**,
- the argument you passed, and the result you got,
- `ANYDB_DEBUG=1` stderr, which carries the stack. Credentials are masked in
  every log record, but read the output before you send it.

### What to expect

| Stage | Target |
|-------|--------|
| Acknowledgement that the report was received | 72 hours |
| Assessment, and a severity judgement | 7 days |
| Fix released, for a confirmed high or critical issue | 14 days |
| Fix released, for everything else | Next release |

The first reply will say whether the report is accepted, needs more
information, or is not a vulnerability. "Not a vulnerability" is a real answer
and you will get it; the common ones are a mistake in configuration, a
behaviour the documentation already describes, or a finding about a database
server rather than about this package.

Fixes are released as a new version, not as a re-publish, because a version on
npm cannot be replaced once consumers have it. Fixes also go in
`CHANGELOG.md`, so a fix that is not in the changelog did not happen.

There is no bug bounty and no paid support.

## Hardening for operators

Ordered by how much they actually buy you.

### 1. Give the server a database role that cannot write

This is the boundary. Everything else below is a guard rail on top of it.

- Create a role with only `SELECT`, and grant it only on the schemas the agent
  needs.
- Do not let that role own its tables. An agent that can `ALTER TABLE` a table
  it can only read is an agent that can rewrite a constraint.
- For PostgreSQL, do not grant `CREATE` on the database. For MySQL, do not grant
  `FILE` or `SUPER`. For MongoDB, use a role with only `read` on the namespaces
  in question.

Why it is first: `readOnly: false` is a request to *this server*. If the role
holds `INSERT` or `DELETE`, the write succeeds whatever this server's flags say;
if it does not, the write fails however many are set. A flag is a value in a
JSON-RPC frame from a model. A grant is a decision your database made.

### 2. Use `profile`, not `uri`

Put your connections in `~/.anydb/db.json` and call `db_query` with
`{"profile": "name"}` rather than `{"uri": "postgres://user:password@host/db"}`.

With a URI, the password is in the JSON-RPC frame, in the client's context
window, and in the conversation transcript — which most hosts persist to disk.
With a profile, only the name travels; the credential is resolved from
`db.json` on this side and is never serialised towards the model.

### 3. Make `db.json` unreadable by anyone else

```bash
chmod 600 ~/.anydb/db.json
chmod 700 ~/.anydb
```

`db.json` is plaintext, on a single-user machine, readable by every process
running as you. The directory is created `0700` and the file `0600` on a POSIX
system the first time this server writes it, but a file you created yourself
keeps whatever mode you gave it.

### 4. `ANYDB_ALLOW_ADHOC_URI=0`

Turns off the `uri` argument entirely, so every call has to name a profile from
`db_list`. This is the same effect as step 2, enforced by the server rather than
by the model remembering to do it.

```
ANYDB_ALLOW_ADHOC_URI=0
```

**What it does not do:** it does not stop a model from connecting anywhere if a
profile points there. It removes the ad-hoc path; it does not review the
profiles you wrote.

### 5. `ANYDB_STRICT_SQLITE_PATHS=1`

By default, a `sqlite://` URI is *allowed* and a `readOnly: false` call on it
can open any file the process can read, as a database. The server logs a warning
when it does. Strict mode inverts that: every SQLite path has to be named in
advance.

```
ANYDB_STRICT_SQLITE_PATHS=1
ANYDB_ALLOWED_SQLITE_PATHS=/srv/app,/var/lib/app
```

**What it does not do:** it does not make SQLite itself read-only. A handle
opened on an allowed file can still be written to if the tool call asks for it.
Use a read-only file mode, or a copy, for the files you care about.

### 6. Point the connection at a host, not at a network

`checkConnectionPolicy` refuses by default to connect to a private or
loopback address, a link-local address, or a cloud metadata endpoint
(`169.254.169.254`), and `ANYDB_ALLOWED_HOSTS` is an allowlist on top of that.
This is a floor, not a ceiling: `ANYDB_ALLOW_PRIVATE_HOSTS=1` lifts all of it,
because the most common deployment is a database on the same machine.

**What it does not do:** it does not stop a model from reaching a public host it
has no business reaching. There is no egress policy here; that is a firewall's
job, and the firewall is a better one.

### 7. `readOnly` and `allowDestructive`, understood precisely

`readOnly: false` is required for any write. `allowDestructive: true` is
additionally required for a statement that changes schema or grants. Both come
from the same caller in the same call, which stops a single mistaken call and
not a determined one.

`ANYDB_DEFAULT_READ_ONLY=0` turns the default off, so every statement is
permitted unless something else refuses it. `ANYDB_ALLOW_DESTRUCTIVE=1` does
the same for schema changes. Leave both unset.

### 8. Know what is logged

Every log record goes to stderr as one `[anydb]` line. Connection strings are
masked, including the username, and query text is summarised rather than
copied. `ANYDB_DEBUG=1` raises the level to include the statement and the full
stack.

**What it does not do:** `ANYDB_DEBUG=1` writes query text, and a query text
routinely contains a literal that is somebody's personal data. Do not leave it
on in a shared or recorded environment.

Credentials are held in memory for the lifetime of the connection cache. A cache
cannot hold a connection without holding its credentials. `ANYDB_CACHE=0` turns
the cache off, at the cost of a new connection per call.

## What this package has fixed before

Recorded because a list of past defects is the best available evidence of where
this codebase's weak points are. The full list is in `CHANGELOG.md`.

- **A read-only bypass on PostgreSQL and SQLite.** The statement scanner treated
  a backslash as escaping the next character inside a literal, which MySQL does
  and PostgreSQL and SQLite do not. A crafted string was read as one statement,
  passed the multiple-statement check, and was then executed as two — a
  `DROP` against a real database.
- **Credentials in the logs.** The logger did not mask the username of a
  connection string. In an IAM setup the username is the secret half of the
  credential.
- **Dead connections handed to the next caller.** The cache handed out a
  connection without asking the server whether it was still alive, so a dropped
  connection surfaced as the next caller's failure.

## Scope

In scope: this package — the server in `src/`, the entry points it exports, and
the npm tarball it publishes.

Out of scope, and not fixed here even if it is reported:

- A database server that accepts a statement this server refused to send.
- A model that talks to this server through some other channel.
- Anything the operating system, the network, or the database does.
