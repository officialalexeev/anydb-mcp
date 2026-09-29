# Build, verify and publish

The maintainer runbook for `anydb-mcp`. It describes the flow that exists today:
the release is a **tag**, and `.github/workflows/release.yml` takes it from there.

This document is not shipped in the npm tarball.

- [Prerequisites](#prerequisites)
- [1. Development setup](#1-development-setup)
- [2. Testing](#2-testing)
- [3. Verifying the packed package](#3-verifying-the-packed-package)
- [4. Preparing a release](#4-preparing-a-release)
- [5. Publishing: the tag](#5-publishing-the-tag)
- [What release.yml does](#what-releaseyml-does)
- [6. Dist-tags](#6-dist-tags)
  - [6a. What to do after a 3.0.0 publish](#6a-what-to-do-after-a-300-publish)
  - [6b. Rolling `latest` back, recovery only](#6b-rolling-latest-back-recovery-only)
- [7. After a publish](#7-after-a-publish)
- [8. If a published version is broken](#8-if-a-published-version-is-broken)
- [9. The SQLite install script](#9-the-sqlite-install-script)
- [10. Git workflow](#10-git-workflow)

---

## Prerequisites

- **Node.js 20.19 or newer.** The floor comes from the drivers, not a preference:
  mongodb 7 requires `>=20.19.0` and sqlite3 6 requires `>=20.17.0`.
- **npm.** The SQLite notes below apply from npm 12, which blocks install scripts
  by default.
- **Git**, and an npm account with 2FA still enabled. 2FA is **not** on the
  publish path once trusted publishing is configured (below), but
  `npm deprecate`, `npm dist-tag`, `npm unpublish` and `npm owner add` are all
  writes that still want it.
- **A GitHub environment named `npm`.** The publish job declares
  `environment: npm`, so a reviewer can be required there before anything is
  published.
- **A trusted publisher on npmjs.com, configured once.** The publish job mints an
  OIDC token from the workflow's identity (`id-token: write`) and npm exchanges
  it for a short-lived publish token, which is what takes 2FA off the release
  path and what makes `--provenance` attest to this repository and this commit.
  npm only honours that exchange for a workflow it has been told to trust, so
  before the first 3.0.0 tag:

  ```
  npmjs.com → Packages → anydb-mcp → Settings → Trusted Publisher
    Organization or user : officialalexeev
    Repository          : anydb-mcp
    Workflow filename   : release.yml          (the filename only, not a path)
    Environment name    : npm                  (must match the job's `environment:`)
    Allowed actions     : allow `npm publish`  (`npm stage publish` is always allowed)
  ```

  npm does not validate this when you save it — a mismatch is only visible when a
  publish fails with `ENEEDAUTH` — so check the spelling, and check it before you
  push the tag rather than after.
- **Nothing else.** The publish step deliberately sets `NODE_AUTH_TOKEN=` (empty).
  npm prefers a real token over the OIDC exchange, and an unset secret still
  arrives as an empty string, so passing `secrets.NPM_TOKEN` there is the
  documented way to defeat trusted publishing — and doing so is what produced
  every `ENEEDAUTH` failure in 3.0.2. There is no token route in the workflow,
  and no `secrets.NPM_TOKEN` in the repository. The OIDC identity is the only
  credential the publish job has.

---

## 1. Development setup

```bash
npm install
```

That is all. `.npmrc` is committed with `allow-scripts=sqlite3`, which is what
makes this repository's own `npm ci` build the SQLite native binding. It is a
repository file, not a consumer one: npm reads `allow-scripts` from the project
root, the user home and the npm prefix, and **not** from a dependency's own
directory. See [section 9](#9-the-sqlite-install-script).

---

## 2. Testing

```bash
npm test
npm run test:coverage
```

`npm test -- --coverage` does not work from npm 12 on: the flag is taken as an
npm option and the run fails with `EUNKNOWNCONFIG`, so coverage has its own
script. The coverage threshold (85% of lines, globally) lives in
`jest.config.cjs`, so `test:coverage` fails on a regression rather than printing a
number nobody reads.

`jest.config.cjs` also collects coverage from **all** of `src/`, `src/index.js`
included. It used to carry an `!src/index.js` exclusion on the grounds that the
file connects stdio on import; that has been untrue for two versions, a child
process's coverage is never collected, and the exclusion meant the largest file in
the package was quietly outside the number.

---

## 3. Verifying the packed package

```bash
npm run verify:package
```

**This is not a repeat of `npm test`.** The unit suite runs against the working
tree, where this repository's own `.npmrc` allow-scripts applies, so it cannot see
anything that only breaks once the package is installed somewhere else. That gap
shipped 2.0.0: every test passed, and every consumer whose npm blocked the sqlite3
install script got a server that died on startup.

`scripts/verify-package.mjs` packs the tarball, inspects the file list, scans the
packed output for credentials, then installs it into an empty directory and drives
the **installed** server over stdio the way a client does — starting it through the
`bin` shim, and checking that the five tools are listed, that importing the
package root has no side effects, that the read-only and timeout checks still hold,
and that SQLite either answers or explains how to install its binding.

It also refuses a tarball that would be a problem later:

- **must contain** the runtime files the server actually needs,
- **must not contain** the test suite, coverage output, CI configuration, the
  maintainer scripts, a dotenv file, an `.npmrc`, or the two maintainer runbooks,
- **must not contain** a private key block, an AWS key id, a GitHub or Slack or
  OpenAI-style token, or a credential assigned a literal — under either an
  unquoted or a `"quoted"` key, so the `"password": "…"` shape a JSON config has
  is visible to it. Every packed file is scanned, on content rather than on a
  list of extensions, and the only exemptions are a small set of documented
  placeholder *values* (currently exactly one,
  `some-plaintext-password`, which `examples/db.json.example` and
  `docs/connections.md` use to document the feature). The per-file allowlist is
  **empty**, deliberately: it used to carry four entries that suppressed nothing,
  and a suppression that suppresses nothing is worse than none, because it
  invites the next reader to trust it. Re-adding one means reading the match and
  writing down why that text is in that file.

That is the check to run whenever you change `files`, `exports`, `bin`, or add a
dependency with an install script. It runs as its own CI job on Linux **and
macOS** — macOS because the bin shim is executed and `isDirectRun()` compares two
`realpath`s, and a case-insensitive filesystem is the only place that comparison
can silently disagree.

Note that it is not in the tarball (`scripts/` is on the must-not-contain list),
so it only works from a clone.

---

## 4. Preparing a release

Three things, and all three are a maintainer's job by hand. The workflow starts at
the tag.

1. **Update `CHANGELOG.md`** with what changed and why. This is the first thing a
   person reads when they arrive with "why did this stop working".
2. **Bump the version**, in `package.json` and in the two `version` fields at the
   top of `package-lock.json`:

   ```bash
   npm version patch --no-git-tag-version   # or minor / major
   ```

   `--no-git-tag-version` is required. Without it `npm version` creates a commit
   *and* an annotated tag by itself, and the release commit describes nothing while
   the tag points at the wrong thing.
3. **Run the checks locally**, so a green CI is confirmation rather than discovery:

   ```bash
   npm test
   npm run verify:package
   ```

   `prepublishOnly` is `npm test && npm run verify:package`, so **the publish
   job runs both again** even though the `verify` job already did: `npm publish`
   fires that lifecycle hook, so the tree that reaches npm has been tested and
   packed on the machine that published it. It does not protect you from a stale
   commit, though.

---

## 5. Publishing: the tag

Substitute the version you are releasing; for this one it is `3.0.0`, and the tag
must match `package.json` exactly or the publish job stops before npm is touched.

```bash
git add -A
git commit -m "release: 3.0.0 — what changed and why"
git tag -a v3.0.0 -m "v3.0.0

One line on the change."
git push origin main
git push origin v3.0.0
```

Push the commit **before** the tag, so the tag always points at something already
on the remote. Then watch the **Actions** tab. The publish is a workflow, not a
terminal.

---

## What release.yml does

`.github/workflows/release.yml`, on a `v*` push or a manual dispatch.

**Permissions.** `contents: read` for the workflow; `id-token: write` for the
publish job alone, so a test job cannot mint a token and npm can attach provenance
to the tarball.

**Concurrency.** Group `npm-publish`, `cancel-in-progress: false`. One publish at
a time, and a run in flight is *not* cancelled: cancelling halfway through
`npm publish` is how you get a half-published release.

**Job 1 — `verify`.** Checks out `github.ref`, i.e. **the tag's commit**, not the
default branch, so `v3.0.0` publishes the tree `v3.0.0` points at. Then `npm ci`,
`npm test`, `npm run verify:package`. Nothing has been published at this point and
nothing can be: this job has no registry credential.

**Job 2 — `publish`,** behind `environment: npm`. Two refusals first, both cheap
and both before npm is touched:

- the version in `package.json` must equal the tag with its `v` removed, or
  nothing is published;
- `anydb-mcp@<version>` must not already be on the registry, or the run stops
  here rather than failing at npm.

Then `npm publish --provenance --access public`. Provenance is not decoration for a
package that handles database credentials: it is the difference between "npm says
this is anydb-mcp 3.0.0" and "npm says this is anydb-mcp 3.0.0, built from commit
X in this repository by a workflow with these permissions".

**Job 3 — `verify-published`.** It checks out `github.ref` — the tag's commit —
because `verify-package.mjs` reads this repository's `package.json` and
`src/index.js` to assert the file list and the shebang, and a job with no
checkout at all cannot do either. What it *installs and drives* is the published
artefact: `anydb-mcp` from the registry, into an empty directory, started from
the `bin` shim. So the thing under test is the tarball npm actually serves, not
the tree it was published from. It waits up to 10 minutes for the registry to
serve the version (propagation takes a few minutes, and a 404 immediately after
a publish is not a failure), then runs
`verify-package.mjs --from-registry --version=<tag>`.

### Two things that will bite you

**The release is the tag. That is the whole publish path.** Push
`v3.0.0` and let the workflow publish it. Do **not** also run `npm publish` at a
terminal: a manual publish followed by the workflow's publish step fails with
`E403 Cannot publish over the previously published version`, and the second
failure is the confusing one because the first publish actually worked. If the
workflow genuinely cannot run — the runner is unavailable, the environment is
misconfigured — a manual `npm publish --provenance --access public` is the
documented fallback, and it is a *substitute* for the workflow, never an
addition to it. One publish per version, from one place.

**`workflow_dispatch` publishes whatever the tag says,** not whatever the form
said — the version is read from the checked-out ref. It exists for the "the tag
was wrong" case.

---

## 6. Dist-tags

`latest` is the version `npm install anydb-mcp` and `npx anydb-mcp` resolve to.
It is **not** necessarily the newest version, and it should not be: a
`dist-tag` pointing at a version with a known defect is how everybody who runs
`npx` gets that defect.

### 6a. What to do after a 3.0.0 publish

```bash
npm dist-tag ls anydb-mcp                                   # read it first
npm dist-tag add anydb-mcp@3.0.0 latest                     # point latest at the release
npm deprecate anydb-mcp@"2.0.1 - 2.0.2" "Superseded: the read-only bypass these versions carry was fixed in 2.0.3, and 2.0.4 is the last 2.x. Upgrade to 3.0.0."
```

`npm publish` sets `latest` itself, so the second command is a no-op after a
normal release; it is here because it is the *only* way to move the tag
deliberately, and because a maintainer who wants `latest` to stay on 2.0.4 for
a while needs to say so explicitly rather than hope.

The third command is the fix for the stale deprecation text on 2.0.1 and 2.0.2,
which reads *"Upgrade to 2.0.3"* and sends a reader to a version that is two
behind. **It is `npm deprecate`, not `npm dist-tag`** — a dist-tag has nothing
to do with the message npm prints when someone installs an old version, and a
version already on npm cannot be replaced by re-publishing. It is a write to
the registry, so it wants 2FA (or an automation token), and it works on a range
so one command covers both versions.

### 6b. Rolling `latest` back, recovery only

> **Do not run these while 3.0.0 is the release you are shipping.** They point
> `latest` at 2.0.4, so `npx anydb-mcp` would hand every new user the old
> major. Use 6a.

`npm dist-tag rm` does not "restore the previous version" — it only clears the
tag, and nothing documents a registry-side re-assignment, so the version
`npx` resolves becomes a thing you verify rather than assume. Both halves are
therefore explicit:

```bash
npm dist-tag ls anydb-mcp                 # what is on the registry right now
npm dist-tag rm anydb-mcp latest          # only if a bad release took the tag
npm dist-tag add anydb-mcp@2.0.4 latest   # and only to the version you mean
npm dist-tag ls anydb-mcp                 # confirm, do not assume
```

Prefer fixing forward: publish a patch and point `latest` at it. An unpublish
(see section 8) takes the version away from everyone who already has it in a
lockfile.

---

## 7. After a publish

The workflow does this for you, which is the point. To check by hand:

```bash
npm view anydb-mcp dist-tags
npm view anydb-mcp versions

# what a consumer actually gets, installed clean
node scripts/verify-package.mjs --from-registry --version=3.0.0
```

`npm view` confirms the version exists; it does not confirm the package runs. Only
the second command installs the registry copy and starts it.

To inspect a specific published version by hand:

```bash
mkdir /tmp/check && cd /tmp/check && npm init -y
npm install anydb-mcp@3.0.0
node -e "console.log(require('anydb-mcp/package.json').version)"
```

---

## 8. If a published version is broken

`npm unpublish anydb-mcp@<version>` works within 72 hours of publishing; past
that, only if nothing on the registry depends on it, it is under 300 downloads a
week, and it has a single maintainer. It is a registry write, so it needs 2FA
(or an automation token) — which is why 2FA is still on the account. Beyond the
policy, the version can only be deprecated.

**Check `latest` yourself afterwards.** npm's documentation does not say what
happens to the tag when the version carrying it is unpublished, so treat it as
unknown and verify:

```bash
npm dist-tag ls anydb-mcp
npm dist-tag add anydb-mcp@<the version you want> latest   # if the tag is not where you meant
```

Prefer fixing forward unless the version is genuinely unusable: an unpublish also
removes the version from everyone who already has it in a lockfile, and their next
`npm install` gets something they did not ask for.

**A semver-major release is the right answer for a breaking change,** and the
`dist-tag` is the lever: publish the major, point `latest` at it, and deprecate the
line that is no longer supported. `SECURITY.md` is the statement of which line gets
fixes, and it should be updated in the same commit as the release.

---

## 9. The SQLite install script

`sqlite3` ships a prebuilt native binding through an install script, and npm 12
blocks install scripts unless they are allow-listed.

**This repository** commits `.npmrc` with `allow-scripts=sqlite3`, so its own
`npm ci` builds the binding. `.npmrc` is committed on purpose and it is the only
thing that makes this true.

**A consumer** gets nothing from that file — npm does not read a dependency's
`.npmrc` — so a consumer whose npm blocks install scripts has to approve it
themselves:

```bash
npm install-scripts approve sqlite3
npm rebuild sqlite3
```

`approve` writes an `allowScripts` field into the *consuming* project's
`package.json`. `.npmrc.example` documents the `allow-scripts=sqlite3` route for a
consumer who would rather not add a field — but npm's precedence rule makes the
two mutually exclusive: a `package.json` `allowScripts` field **suppresses** the
`.npmrc` setting. A project that already has the field and follows the `.npmrc`
advice gets "`.npmrc` allow-scripts setting is being ignored" with no way out,
which is why `approve` is the documented default.

Until 2.0.4 this package carried its own `allowScripts` field. It was published to
every consumer, where it did nothing — npm reads the *installing* project's field —
and it suppressed the `.npmrc` route for anyone who had one. It is gone, and
`verify:package` now fails if it comes back.

The other four databases are unaffected. `sqlite3` is loaded lazily, on the first
SQLite connection, so a blocked binding is an error on that one tool call rather
than a server that will not start — which is what 2.0.1 fixed.

---

## 10. Git workflow

```bash
git checkout -b <short-branch-name>
git commit -m "fix: what changed and why"
git push origin <short-branch-name>
```

CI runs on Node 20.19, 22 and 24 on Linux (plus the newest 20.x), and on Node 22
on Windows, which is not a cosmetic second target: the SQLite URI handling
rewrites drive-rooted paths, so Windows exercises a branch no Linux run reaches.
It computes coverage with a threshold, drives all four non-SQLite databases
against real containers through `scripts/live-adapters.mjs`, verifies the packed
package on Linux and macOS, and fails on a high-severity advisory in the
production dependencies. CodeQL runs on its own schedule. Dependabot watches the
runtime dependencies.
