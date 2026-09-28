# Build, Test, and Publish Guide

How to build, verify and publish `anydb-mcp`.

## Prerequisites

- Node.js 20.19 or newer. The floor comes from the drivers, not a preference.
- npm. The SQLite notes below apply from npm 12, which blocks install scripts
  by default.
- Git, and an npm account with 2FA enabled.

## 1. Development setup

```bash
npm install
```

## 2. Testing

```bash
npm test           # unit, integration and end-to-end
npm run test:coverage
```

`npm test -- --coverage` does not work from npm 12 on: the flag is taken as an
npm option and the run fails with `EUNKNOWNCONFIG`, so coverage has its own
script.

## 3. Verifying the packed package

```bash
npm run verify:package
```

This is not a repeat of `npm test`. The unit suite runs against the working
tree, where this package's own `allowScripts` entry applies, so it cannot see
anything that only breaks once the package is installed somewhere else. That
gap shipped 2.0.0: every test passed, and every consumer whose npm blocked the
sqlite3 install script got a server that died on startup.

`verify:package` packs the tarball, installs it into an empty directory, and
drives the installed server over stdio the way a client does. It checks that the
server starts, that both tools are listed, that the read-only guard and the
`db_schema` timeout check still hold, and that SQLite either answers or reports
how to install its binding. CI runs it as its own job.

## 4. Preparing a release

1. Update `CHANGELOG.md` with what changed and why.
2. Bump the version in `package.json`, and the two version fields at the top of
   `package-lock.json`:
   ```bash
   npm version patch --no-git-tag-version   # or minor / major
   ```
   `--no-git-tag-version` keeps the commit under your control, so the release
   commit can describe the change. Do not let `npm version` create the tag: the
   annotated tag is made after the commit it points at.
3. Run the checks:
   ```bash
   npm test
   npm run verify:package
   ```
   `prepublishOnly` runs both, so a publish that reaches npm has already passed
   them. It does not protect you from a stale commit, though, so run them first.

## 5. Publishing

```bash
npm publish
```

The account has 2FA, so npm prints a URL and waits for you to press Enter.
Approve it in the browser. Only one maintainer exists on this package, so the
account's own 2FA is required even for a version you are publishing yourself.

## 6. Post-publish verification

This is the step that matters, and `npm view` alone does not do it. It confirms
the version exists; it does not confirm the package runs.

```bash
# What is on the registry
npm view anydb-mcp dist-tags
npm view anydb-mcp versions

# What a consumer actually gets, installed clean
node scripts/verify-package.mjs --from-registry
```

Registry propagation can take a few minutes, so a 404 straight after a publish
is not by itself a failure. Check again before assuming the publish did not land.

To inspect a specific published version by hand:

```bash
mkdir /tmp/check && cd /tmp/check && npm init -y
npm install anydb-mcp@<version>
node -e "console.log(require('anydb-mcp/package.json').version)"
```

## 7. If a published version is broken

`npm unpublish anydb-mcp@<version>` works within 72 hours of publishing, and
leaves the previous version as `latest`. Beyond that the version can only be
deprecated.

Prefer fixing forward over unpublishing unless the version is genuinely
unusable, because an unpublish also removes the version from everyone who
already has it in a lockfile.

## 8. Git workflow

```bash
git add -A
git commit -m "fix: what changed and why"
git tag -a v<version> -m "v<version>

One line on the change."
git push origin main
git push origin v<version>
```

Push the commit before the tag, so the tag always points at something on the
remote.
