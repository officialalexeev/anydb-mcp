# Contributing

## Setup

```bash
nvm use          # reads .nvmrc; Node 22.x is the development line
npm ci
npm test
```

Node 20.19 or newer is required; that floor comes from the drivers, not a
preference. CI proves the floor still works on `20.19.0` and develops on 22.x.

There is no linter and no formatter. `.editorconfig` and `.gitattributes` are the
only tooling, so they are followed by hand: 2 spaces, LF, a final newline, no
trailing whitespace outside Markdown.

## The shape of the source

| Path | What lives there |
|------|------------------|
| `src/lib.js` | The package entry point. A pure barrel: no side effects on import. |
| `src/index.js` | The MCP server. `createServer(deps)`, `main(deps)`, and the guarded bin entry. |
| `src/core/registry.js` | Routing, the connection cache, the response envelope, error classification. |
| `src/core/profiles.js` | Reading, resolving and writing `db.json`. |
| `src/core/policy.js` | The read-only policy, the host allowlist, the ad-hoc-URI switch. |
| `src/core/paths.js` | Where `db.json` and the log live, per platform, and the two permissions. |
| `src/core/safety.js` | The statement inspector: what counts as a write, per dialect. |
| `src/core/result-limits.js` | Row and byte caps, `buildEnvelope`, the renderers. |
| `src/core/tools.js` | The five tool schemas and the argument validator. |
| `src/core/connection-cache.js` | The LRU/TTL cache and the shutdown wiring. |
| `src/core/base-adapter.js` | The adapter contract and the deadline helpers. |
| `src/core/logging.js` | Records, redaction, and the file sink. |
| `src/core/schema.js` | The catalogue scanner behind `db_schema`. |
| `src/core/timeout-utils.js` | The deadline helpers the adapters share. |
| `src/adapters/*.js` | One per database. |

`src/index.js` contains no logic that is worth a module boundary of its own: it
decides what a model sees, and everything that *does* something is in `src/core/`
precisely so that it can be unit tested without a process.

### One file per module, not one file per idea

The rule used to be one test file per module, and the tree has not kept to it.
`__tests__/test_adapters_integration.test.js` is not about one module: it is about
the five adapters agreeing with each other, which is a property no single module
has. That is the right reason to add a file. "It is getting long" is not.

## Adding a database

1. Create `src/adapters/<name>.js` extending `BaseAdapter`.
2. Implement `connect(uri)`, `execute(query, options)` and `close()`.
3. `isHealthy()` and `abort()` have defaults in `BaseAdapter` — `isHealthy()`
   returns `true` and `abort()` is a no-op — so implement them only if your driver
   can answer the question.

   `isHealthy()` is what the connection cache calls before handing a connection
   out, so a driver that can check its own state should report it there rather
   than by pinging. `abort()` has to stop the in-flight statement, and a
   connection that survives being aborted must not be reusable, so set a flag that
   `isHealthy()` reads. Postgres and MySQL implement both; Redis reads its socket
   state; MongoDB reads the driver topology; SQLite asks the handle.
4. Implement `describe(options)` in `src/core/schema.js` and delegate to it
   from the adapter. A schema failure has to be routed through the adapter's own
   `describeError`, so `db_schema` and `db_query` say the same thing about the
   same failure.
5. Add the scheme to `ROUTES` in `src/core/registry.js`. The routing table and the
   cache key are built from the same constant, so a scheme that is not in it
   cannot connect and cannot be cached.
6. If the database is not SQL, add it to `inspectQuery` in `src/core/safety.js`
   along with its tests. **A protocol the guard does not recognise fails closed**,
   which is the property that keeps a new driver from being a new hole.
7. Add a test file named `__tests__/test_<name>_adapter.test.js` and pass the
   driver into the constructor, so the tests need no running server. Then add the
   real one to `scripts/live-adapters.mjs`, which is what CI runs against a
   container.

## The new subsystems

Six modules are new since 2.0 — `profiles.js`, `policy.js`, `paths.js`,
`result-limits.js`, `tools.js` and the `lib.js` barrel — and they are the ones a
change is most likely to belong in.

### `profiles.js` — why a call should not carry a connection string

A profile is a named entry in `~/.anydb/db.json`. The name travels in the
JSON-RPC frame; the credential is resolved on this side and is never serialised
towards the model. With a URI, the password is in the frame, in the client's
context window, and in the conversation transcript, which most hosts persist to
disk. This is the single most important privacy property in the package, so a
change that makes the resolved target travel back to the registry — instead of
the `{ profile }` the caller sent — undoes it. `src/index.js` has a comment at
`targetSpecOf` explaining the shape of the mistake.

A profile is also where `readOnly`, `maxRows`, `maxBytes`, `queryTimeoutMs` and
`allowDestructive` come from, so a profile change is a policy change and is
reviewed as one.

### `policy.js` — the boundary, and where it is not

The policy decides what a statement may be. `ANYDB_ALLOW_ADHOC_URI=0` removes the
`uri` argument; `ANYDB_ALLOWED_HOSTS` and `ANYDB_STRICT_SQLITE_PATHS` are
allowlists; `checkConnectionPolicy` refuses private and loopback addresses by
default.

Every message it writes is read by a model, so the wording is the contract: it
names the switch that relaxes the refusal and says plainly that nothing was
executed. A refusal that leaves a model to guess gets retried.

The policy is **not** the security boundary — the database role is. `readOnly:
false` is a request to this server, and a role with `INSERT` honours it. Do not
write a comment, a test name, or a tool description that implies the flags are
the boundary; `SECURITY.md` is explicit about this and should be too.

### `paths.js` — where the files are, and what mode they get

One module answers "where does this go" for every platform, with the environment,
the platform and the home lookup all injectable, so a test can ask what Windows
or macOS would do without being one. It owns the config directory and file, the
XDG secondary lookup, the log directory and file, and the two permission bits
(`0700` a directory, `0600` a file). It creates nothing at import time — a module
that creates directories as a side effect of being imported surprises whoever
imports it second — and `ensureDir`/`writableCheck` are separate so a read-only
filesystem is a degraded log, not a startup crash. The rule that catches people:
**the XDG path is a lookup, not a write target.** The dotfile predates the
convention, so the reader may consult `$XDG_CONFIG_HOME` and the writer still uses
`~/.anydb`, and the choice is *first existing one wins* rather than *first one
wins*.

### `result-limits.js` — the envelope

`buildEnvelope` and `clampResult` produce the one response shape every tool
returns: `ok`, `rows`, `rowCount`, `truncated`, `bytes`, `elapsedMs`, `driver`,
`profile`, `limitReason`, `hint`, `format`, and `error` when `ok` is false. A cap
is a **prefix**, never a sample, and `truncated: true` is a fact about the answer
rather than a field in a row — the adapters mark it non-enumerably for exactly
that reason.

`src/index.js` accepts two shapes of result while `registry.js` is being revised,
recognising the envelope by the presence of `rows` *and* `rowCount`. When only
one shape exists, `unwrapEnvelope` can go.

### `tools.js` — the schemas

The five tools, their arguments, their bounds, and `validateArgs`. Two things
matter more than they look:

- `validateArgs` is the only thing between a model and the registry. The SDK
  validates the request envelope and never the tool name, which is why
  `callTool` checks `findTool` first and refuses an unknown name.
- A handler that supports an argument the schema does not declare is dead code,
  because `additionalProperties: false` refuses it before the handler runs. If
  you add a branch, add the property, and add the e2e assertion for it.

## Tests

- `__tests__/**/*.test.js`, named after what it covers.
- Assert on observable behaviour, not on internal calls, except where the call
  itself is the contract (a specific SQL statement, a specific argument).
- A comment should say why an assertion matters. If it only restates the
  assertion, delete it.
- **A file containing `import.meta` cannot be imported by the test suite.** The
  harness compiles to CommonJS with babel, and `import.meta` is a syntax error in
  that transform, so the whole suite fails to load with `Must use import to load ES
  Module`. `src/index.js` and `src/core/registry.js` both avoid it, with a comment
  saying why; that is not a style preference, it is the reason the request
  handlers can be tested in this process at all.
- `src/lib.js` must stay side-effect free. `__tests__/package_entry.test.js` runs
  a child that imports it and then does nothing; the child has to *exit*. That is
  the regression test for the bug where `import 'anydb-mcp'` started a server.

## Before opening a pull request

```bash
npm test
npm run verify:package
```

The second one installs the packed tarball into an empty directory and drives the
installed server, the installed `bin` shim, and `import('anydb-mcp')`. It exists
because the unit suite cannot see installation-time problems: it runs where this
repository's own `.npmrc` allow-scripts applies. If you add a dependency with an
install script, or change `files`, `exports` or `bin`, this is the check that will
notice.

It also asserts the tarball's own file list, so deleting the `files` allowlist
fails the build rather than shipping `__tests__`, `.github/` and `coverage/`.

`files` is `["src/", "docs/", "!docs/build-and-publish.md",
"!docs/publication_guide_ru.md", ...]`. **Add a new document to `docs/` and it
ships**, which is what you want; **add a new maintainer runbook to `docs/` and it
ships too**, which is what you do not want — the two excluded files are the 2FA
and unpublish procedures, and they were being published to every consumer. A
third runbook needs a third `!` line, and
`scripts/verify-package.mjs` is where that should be asserted as well.

## Commit messages

Conventional Commits, which is what the history already uses:

```
fix: what was wrong
feat: what is new
feat!: what is new, and what breaks
test: what is now covered
docs: what changed in the documentation
chore: dependencies, formatting, CI
ci: the workflows themselves
```

A `!` after the type, or a `BREAKING CHANGE:` paragraph in the body, marks a
breaking release. **A change to a tool's arguments, a result's shape, or a
refusal's wording is breaking** if anybody could have depended on it: a model
that read `db_query`'s answer as an array now gets an object, and that is a
client-visible change whether or not it is a `Schema` violation.

`CHANGELOG.md` is written for somebody who arrives asking "why did this stop
working". Say what changed and what it means for them, not what you did.

## Pull requests

```bash
git checkout -b <short-branch-name>
git commit -m 'fix: what changed and why'
git push origin <short-branch-name>
```

CI runs the suite on Node 20.19.0, 22.x, 24.x and the newest 20.x on Linux, plus
Node 22 on Windows; measures coverage on one leg against a global line threshold;
drives the four non-SQLite databases against service containers; verifies the
packed package on Linux and macOS; and fails on a high-severity advisory in the
production dependencies.

## Reporting a security problem

Not in an issue. See [`SECURITY.md`](SECURITY.md) — there is a private advisory
form, and a public issue is world-readable before anyone can take it down.
