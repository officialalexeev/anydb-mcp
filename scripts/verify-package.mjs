#!/usr/bin/env node
/**
 * Install the packed tarball into an empty directory and drive the server the
 * way a consumer would.
 *
 * The unit suite runs against the working tree, where this repository's own
 * `.npmrc` allow-scripts applies. That is how 2.0.0 passed every test and still
 * shipped a server that died on startup for anyone whose npm blocked the sqlite3
 * install script. Only an installed copy shows that.
 *
 *   node scripts/verify-package.mjs                 verify what would be published
 *   node scripts/verify-package.mjs --from-registry verify what is published
 *
 * The two are not the same. After a publish, only the second one tells you
 * whether the registry copy runs.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE IS HERE
 * -----------------------------------------
 * An earlier version of this file had four checks and gaps that mattered more
 * than the checks:
 *
 *   - It never looked at the tarball's *file list*. The `files` allowlist in
 *     `package.json` is the only thing keeping `__tests__/`, `jest.config.cjs`,
 *     `scripts/`, `.github/`, `coverage/` and `.env` out of the package, so
 *     deleting it shipped all of them and nothing failed. Deleting it now fails.
 *   - It never *ran* the `bin` shim, only `existsSync`-ed it, and then started the
 *     server by path so as to dodge it. A shim with a broken shebang, a CRLF line
 *     ending, or no execute bit shipped undetected. The shim is executed now.
 *   - It pinned the MCP SDK to the floor (`1.30.1`) while `package.json` declares
 *     `^1.30.1`. The one job whose purpose is to catch consumer-visible breakage
 *     tested the *minimum*, so a regression in the version everybody actually
 *     installs was invisible. Both ends of the range are driven now.
 *   - Its SQLite check was `answered || explained`, which cannot fail: on npm 12,
 *     where install scripts are blocked by default, the `explained` branch is
 *     always taken and CI is green while SQLite is broken for every consumer.
 *     That is the entire class of outage 2.0.0 was. It fails now, unless the
 *     opt-in is set -- and it says which branch it took.
 *   - `runNode` had no timeout and never killed its child, so a hung server hung
 *     the job until GitHub's own limit killed the whole run.
 *   - It parsed the *last* line of stdout as the result payload, so any trailing
 *     noise turned four checks into failures with empty details.
 *   - It filtered `[anydb]`-prefixed lines out of the error report. Every
 *     diagnostic this server emits starts with `[anydb]`, so the filter hid
 *     exactly the lines most likely to explain a failure.
 *   - Its secret scan decided which files to read from an extension allowlist
 *     (`js|cjs|mjs|json|md|txt`). `examples/db.json.example` ends in `.example`,
 *     so when `examples/` was added to `files` the scan reported a clean result
 *     for a file it had never opened -- a check that reads as coverage and is not.
 *     Every packed file is read now, and content is what stops a scan.
 *   - Its credential rule needed an *unquoted* key, so `"password": "..."` -- the
 *     only shape a JSON config can have, in a package whose README calls `db.json`
 *     a credential store -- could not match. There is a second rule for the
 *     quoted form now, with the documented placeholder exempted by *value* rather
 *     than by file.
 *   - It took only the first match per pattern per file, and reused a global
 *     regex across files, so `lastIndex` leaked from one file into the next.
 *   - Its `SECRET_ALLOWLIST` carried four entries that suppressed nothing. The
 *     redaction and policy modules write `password: null` — unquoted — which
 *     neither scan rule matches, so the four entries were reached zero times.
 *     They are gone; see the comment on the map for why a dead suppression is
 *     worse than none.
 *
 * The tarball is packed into a temporary directory rather than the repository
 * root, so an interrupt cannot leave a `.tgz` next to `package.json` at all.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The floor `package.json` declares. Asserted against the manifest, not assumed. */
const SDK_FLOOR_SPEC = '@modelcontextprotocol/sdk@1.30.1';
/** The range `package.json` declares, so a floor bump is a test failure and not a comment. */
const SDK_RANGE = '^1.30.1';

/** A child that outlives this is a hang, not a slow test. */
const CHILD_TIMEOUT_MS = Number(process.env.ANYDB_VERIFY_TIMEOUT_MS ?? 120000);
/** An `npm install` of five drivers on a cold cache is not fast. */
const NPM_TIMEOUT_MS = Number(process.env.ANYDB_VERIFY_NPM_TIMEOUT_MS ?? 600000);

/** Where the driver's JSON lands on its stdout, one JSON object per line. */
const MARKER = '##anydb-verify##';

/** The five tools this server promises, in the order `tools/list` returns them. */
const TOOL_NAMES = ['db_list', 'db_query', 'db_schema', 'db_explain', 'db_health'];

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

function note(text) {
  console.log(`       ${text}`);
}

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

// Windows cannot execFile a .cmd, and the repo path here contains a space, so
// quoting is not optional either.
async function npmRun(args, cwd, timeout = NPM_TIMEOUT_MS) {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const options = { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout };
  if (process.platform === 'win32') {
    return exec(cmd, args.map(a => (/\s/.test(a) ? `"${a}"` : a)), { ...options, shell: true });
  }
  return exec(cmd, args, options);
}

async function tryNpm(args, cwd, timeout) {
  try {
    return { ok: true, ...(await npmRun(args, cwd, timeout)) };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
  }
}

/**
 * Run a child to completion, or kill it.
 *
 * Every child here is a *server*, and a server that does not exit is the normal
 * shape of the failure we are looking for. The previous version had no timeout
 * and never killed anything, so a server that hung on connect hung the CI job
 * until GitHub killed the whole run, and the only evidence was a timeout with no
 * stderr in it.
 *
 * `SIGTERM` first so a child with a shutdown handler gets to close its
 * connections, then `SIGKILL` after a second, because a child that has wedged
 * itself will not act on `SIGTERM` either.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.input] - Written to stdin and then closed
 * @param {(stdoutSoFar: string) => boolean} [options.killWhen] - Kill once this
 *   is true. A stdio server is *supposed* to stay alive, so waiting for exit would
 *   wait for the timeout every time.
 * @param {(chunk: string) => void} [options.onStderr]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, killed: boolean }>}
 */
function runCommand(command, args, options = {}) {
  const { cwd, timeoutMs = CHILD_TIMEOUT_MS, input, killWhen, onStderr } = options;
  return new Promise((resolve) => {
    // `shell: true` is needed on Windows only to execute a `.cmd`, which is what
    // npm's bin shim is. It is *not* safe to use for anything else: Node installs
    // on Windows live under `C:\Program Files`, and with a shell the executable
    // path is not quoted, so `spawn` ends up trying to run `C:\Program`.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, { cwd, shell: needsShell });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let settled = false;

    const hardKill = () => { killed = true; child.kill('SIGKILL'); };
    const softKill = () => {
      child.kill('SIGTERM');
      setTimeout(hardKill, 1000).unref?.();
    };

    const timer = setTimeout(() => { timedOut = true; softKill(); }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
      if (killWhen?.(stdout)) softKill();
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
      onStderr?.(d.toString());
    });
    child.on('error', (err) => { stderr += String(err); });

    if (input !== undefined) {
      child.stdin?.on('error', () => { /* the child may exit before reading it */ });
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, killed });
    };

    child.on('close', finish);
    // `error` with no `close` is possible in principle; never hang on it.
    child.on('error', () => finish(1));
  });
}

const runNode = (script, options = {}) => runCommand(process.execPath, [script], options);

/**
 * Parse the driver's out-of-band results.
 *
 * Every stdout line is examined, and only the ones carrying the marker are
 * parsed. The previous version took the *last* line of stdout and JSON-parsed
 * it, which meant one stray line -- a deprecation notice, a progress write, a
 * Node warning -- turned every check below it into a failure with an empty
 * detail, and the detail was the only thing explaining the failure.
 *
 * @param {string} stdout
 * @returns {Record<string, any>} Keyed by the `key` each payload declared
 */
function parsePayload(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(MARKER);
    if (at === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(at + MARKER.length));
      if (parsed && typeof parsed.key === 'string') out[parsed.key] = parsed;
    } catch {
      /* a malformed marker line is not a result; the checks report the absence */
    }
  }
  return out;
}

/** The JSON-RPC responses on stdout, keyed by id. This is a server, not a script. */
function parseRpc(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('{');
    if (at === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(at));
      if (parsed && parsed.jsonrpc && parsed.id !== undefined) out[parsed.id] = parsed;
    } catch {
      /* not a frame */
    }
  }
  return out;
}

/** The first `count` lines of a diagnostic, unfiltered and unedited. */
const head = (text, count = 14) => text.split('\n').filter(Boolean).slice(0, count).join('\n');

// ---------------------------------------------------------------------------
// The file list
// ---------------------------------------------------------------------------

/**
 * Files the package must contain.
 *
 * Written out rather than derived from `package.json`'s `files`, so a `files`
 * entry that is quietly broadened does not silently widen the assertion with it.
 */
const MUST_CONTAIN = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'src/index.js',
  'src/lib.js',
  'src/core/registry.js',
  'src/core/profiles.js',
  'src/core/policy.js',
  'src/core/safety.js',
  'src/core/result-limits.js',
  'src/core/tools.js',
  'src/core/connection-cache.js',
  'src/core/base-adapter.js',
  'src/core/logging.js',
  'src/adapters/postgres.js',
  'src/adapters/mysql.js',
  'src/adapters/sqlite.js',
  'src/adapters/mongodb.js',
  'src/adapters/redis.js',
  'docs/timeout-configuration.md',
  'docs/configuration.md',
  'docs/connections.md',
  'docs/security.md',
  // The config-file examples. `db.json` runs on a fresh machine with nothing
  // installed, and `db.json.example` is the template that documents all four
  // credential-reference forms; both are the first thing a new user copies, so
  // an `examples/` that does not ship is an `examples/` nobody has.
  'examples/db.json',
  'examples/db.json.example',
];

/**
 * Nothing matching these may be in the tarball.
 *
 * The point of the list is that the `files` allowlist is the *only* thing keeping
 * them out, so if the allowlist is deleted -- or a new entry is added that sweeps
 * them in -- this is what notices. The first two are the ones that would actually
 * hurt: a package that ships its test suite ships the fixtures, and a package that
 * ships `.env` ships somebody's credentials.
 */
const MUST_NOT_MATCH = [
  { pattern: /(^|\/)__tests__(\/|$)/, why: 'the test suite' },
  { pattern: /\.test\.js$/, why: 'a test file' },
  { pattern: /(^|\/)coverage(\/|$)/, why: 'a coverage report' },
  { pattern: /(^|\/)\.github(\/|$)/, why: 'CI configuration' },
  { pattern: /(^|\/)scripts(\/|$)/, why: 'the maintainer scripts' },
  { pattern: /(^|\/)jest\.config\.cjs$/, why: 'the test configuration' },
  { pattern: /(^|\/)babel\.config\.cjs$/, why: 'the test configuration' },
  { pattern: /(^|\/)\.env(\.|$)/, why: 'a dotenv file' },
  { pattern: /(^|\/)\.npmrc$/, why: 'npm configuration' },
  { pattern: /(^|\/)\.DS_Store$/, why: 'a macOS artefact' },
  { pattern: /(^|\/)Thumbs\.db$/, why: 'a Windows artefact' },
  { pattern: /\.tgz$/, why: 'a tarball' },
  { pattern: /(^|\/)\.editorconfig$/, why: 'a repository file' },
  { pattern: /(^|\/)\.gitattributes$/, why: 'a repository file' },
  { pattern: /(^|\/)\.nvmrc$/, why: 'a repository file' },
  { pattern: /(^|\/)\.gitignore$/, why: 'a repository file' },
  { pattern: /(^|\/)docs\/(build-and-publish|publication_guide_ru)\.md$/, why: 'a maintainer runbook' },
  { pattern: /(^|\/)CONTRIBUTING\.md$/, why: 'a contributor document' },
];

// ---------------------------------------------------------------------------
// The secret scan
// ---------------------------------------------------------------------------

/**
 * Patterns for a credential that was committed by accident.
 *
 * The first five are unambiguous: no source file contains a private key block or
 * an AWS key id. The sixth is the one that fires on real code, so it is written
 * to match an *assignment of a value* rather than the word: a module that lists
 * `"password"` as a credential key it strips is not leaking a password, and a
 * scan that cannot tell the difference is a scan everybody learns to ignore.
 *
 * The seventh exists because the package now ships `examples/db.json` and
 * `examples/db.json.example`, and this package's own README calls `db.json` a
 * credential store. The sixth rule needs an *unquoted* key, so `"password":
 * "…"` -- the only shape a JSON config file can have -- was invisible to it: the
 * single most likely way for this package to ship a real credential was the one
 * form the scan could not see. The seventh is that form, and it is matched
 * separately so a match in it can be checked against
 * `PLACEHOLDER_VALUES` below.
 */
const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'aws access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github token', re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: 'openai-style key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/ },
  {
    name: 'credential assigned a value',
    re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\b\s*[:=]\s*["'][^"'\s]{6,}["']/i,
  },
  {
    name: 'credential assigned a value under a quoted key',
    re: /["'](?:api[_-]?key|apikey|secret|token|password|passwd|pwd)["']\s*:\s*["']([^"']{6,})["']/i,
    // The captured value, so the scan can ask whether it is a documented
    // placeholder before calling it a leak. Absent on the other patterns, which
    // have no single "the value" to look at.
    //
    // NAMED `capturedValue` AND NOT `valueOf`, and the second half is the point.
    // A pattern entry is a plain object, so `valueOf` is inherited from
    // `Object.prototype`; destructuring one read the inherited method for the six
    // patterns that do not declare their own, and calling it bare in an ES module
    // means `this` is undefined, which `Object.prototype.valueOf` reports as
    // "Cannot convert undefined or null to object". The scan therefore *threw* on
    // the first hit of any of those six -- so the check that exists to report a
    // credential in the tarball had, as far as anyone could tell, never reported
    // one. Found by planting a `password` in a packed file and expecting a FAIL
    // line: what came out was a stack trace.
    capturedValue: (hit) => hit[1],
  },
];

/**
 * Values that are placeholders because they say so.
 *
 * A *documented* placeholder is not a secret, and a scan that cannot tell the
 * difference forces one of two bad choices: delete the documentation of a feature
 * that is supported, or maintain a growing file allowlist in which every file
 * added for one placeholder hides the next credential in it. This is the third
 * option, and it is keyed by the *value* rather than by the file -- so it holds
 * in any file, including one added later, and it cannot hide anything: only
 * these exact strings are exempt, and an attacker who knew the rule could not get
 * a credential past it because the exempt string is not a credential.
 *
 * Every entry has to be a string that could not plausibly be a working password
 * and has to be *visible as a placeholder to a reader*, which is the test for
 * adding one. A value that is merely weak (`hunter2`, `changeme`, `password`) is
 * not a placeholder -- those are the credentials that get guessed -- so a
 * placeholder must announce itself.
 */
const PLACEHOLDER_VALUES = new Set([
  // `examples/db.json.example` and `docs/connections.md` both document that
  // `"password": "<literal>"` is accepted, and both write the same line to say
  // so. The word is the placeholder: it names the thing it stands for.
  'some-plaintext-password',
]);

/**
 * Findings that are not findings.
 *
 * Keyed by the file that raises them, so a match in a *new* file still fails, and
 * never by pattern or directory: an entry that covers a whole folder suppresses
 * every credential anyone ever adds under it. Every entry has to name why the
 * text is there, because an allowlist nobody can justify is an allowlist that
 * hides the next credential too.
 *
 * IT IS CURRENTLY EMPTY, and that is a fact worth reading rather than a thing to
 * fix. It previously carried four entries — `src/core/profiles.js`,
 * `src/core/logging.js`, `src/core/policy.js` and `src/core/registry.js` — each
 * covering the credential field names those modules quote as keys, and a scan of
 * the packed tree produced **zero** matches under any of them. The quoted-key
 * rule above needs `["']key["']\s*:\s*["']value["']` with a value of at least six
 * characters, and those four modules write `password: null`: an unquoted `null`,
 * which matches neither rule and is not a credential in the first place.
 *
 * They were removed rather than kept "in case they are needed again", because a
 * dead allowlist entry is worse than no entry. It is a suppression that is
 * suppressing nothing, and it invites the next reader to trust it — so when a
 * real match appears in one of those files, the person who finds it has to read
 * the match and decide, which is the only thing an allowlist should ever cost.
 *
 * Re-adding one is cheap and must be a deliberate act: run the scan, read the
 * actual match, and write down why that text is in that file.
 */
const SECRET_ALLOWLIST = new Map();

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const fromRegistry = process.argv.includes('--from-registry');
const wanted = process.argv.find(a => a.startsWith('--version='))?.slice('--version='.length);

/**
 * Whether a missing sqlite3 binding is a failure.
 *
 * `answered || explained` was unfailable: npm 12 blocks the install script by
 * default, so `explained` was always true and CI was green while SQLite was
 * broken for every consumer. That is the 2.0.0 outage exactly, and a check that
 * cannot fail is worse than no check, because it is read as coverage.
 *
 * The escape hatch exists for the one situation where the answer really is
 * "expected": deliberately testing a blocked install. It is opt-in, and the
 * result line says which branch was taken, so a green run cannot be mistaken for
 * a working one.
 */
const allowMissingSqlite = process.env.ANYDB_VERIFY_ALLOW_MISSING_SQLITE === '1';

let version;
let tarball = null;
let spec;

// The temp directory is created first so the tarball has somewhere to live that
// is not the repository root, and so the interrupt handlers below have something
// to clean up before anything has been written.
const dir = await mkdtemp(join(tmpdir(), 'anydb-verify-'));
const packDir = join(dir, 'pack');
await mkdir(packDir, { recursive: true });

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (tarball) await rm(tarball, { force: true });
  await rm(dir, { recursive: true, force: true });
}

// A `.tgz` in the repository root was previously only removed by a `finally`,
// which an interrupt skips. `*.tgz` is also gitignored now; this is the half that
// deletes the file rather than hiding it, and the `exit` handler is the last line
// of defence for a path the signals did not reach.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void cleanup().then(() => process.exit(130));
  });
}
process.on('exit', () => {
  if (!cleaned && tarball) {
    try { rmSync(tarball, { force: true }); } catch { /* best effort */ }
  }
});

if (fromRegistry) {
  spec = wanted ? `anydb-mcp@${wanted}` : 'anydb-mcp';
  const viewed = await tryNpm(['view', spec, 'version'], root, 120000);
  if (!viewed.ok) {
    console.error(`Cannot read ${spec} from the registry. Propagation can take a few minutes.`);
    await cleanup();
    process.exit(1);
  }
  version = viewed.stdout.trim();
  console.log(`verifying the published ${spec} (${version})`);
} else {
  console.log('packing');
  const packed = await tryNpm(['pack', '--json', '--pack-destination', packDir], root);
  if (!packed.ok) {
    console.error(packed.stderr);
    await cleanup();
    process.exit(1);
  }
  // npm reports `pack --json` as an array on some versions and as an object
  // keyed by package name on others.
  const reported = JSON.parse(packed.stdout);
  const entry = Array.isArray(reported) ? reported[0] : reported[Object.keys(reported)[0]];
  version = entry.version;
  tarball = join(packDir, entry.filename);
  spec = tarball;
  console.log(`  ${entry.filename} (${version})  ->  ${packDir}, not the repository root`);
}

try {
  // -------------------------------------------------------------------------
  // The manifest
  // -------------------------------------------------------------------------
  console.log('\nmanifest');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

  check('the manifest is the version under test', manifest.version === version, manifest.version);
  check('the SDK range is what the floor check assumes', manifest.dependencies['@modelcontextprotocol/sdk'] === SDK_RANGE,
    manifest.dependencies['@modelcontextprotocol/sdk']);
  // The reason the floor is now read from the manifest rather than trusted.
  check('the manifest does not ship an allowScripts field to every consumer',
    manifest.allowScripts === undefined, JSON.stringify(manifest.allowScripts ?? null));

  // -------------------------------------------------------------------------
  // The file list
  // -------------------------------------------------------------------------
  console.log('\ntarball contents');
  const packed = await tryNpm(['pack', '--dry-run', '--json'], root, NPM_TIMEOUT_MS);
  let paths = [];
  if (packed.ok) {
    const reported = JSON.parse(packed.stdout);
    const entry = Array.isArray(reported) ? reported[0] : reported[Object.keys(reported)[0]];
    paths = (entry.files ?? []).map(f => f.path);
  }
  check('npm reports the packed file list', paths.length > 0, `${paths.length} entries`);

  const present = new Set(paths);
  const missing = MUST_CONTAIN.filter(p => !present.has(p));
  check('everything the package needs is in the tarball', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${MUST_CONTAIN.length} expected entries`);

  const smuggled = paths.filter(p => MUST_NOT_MATCH.some(({ pattern }) => pattern.test(p)));
  check('no test, CI, coverage, dotenv or repository file is in the tarball', smuggled.length === 0,
    smuggled.length ? smuggled.join(', ') : 'files allowlist honoured');

  // -------------------------------------------------------------------------
  // The secret scan
  // -------------------------------------------------------------------------
  console.log('\nsecret scan');
  const findings = [];
  let placeholders = 0;
  let scanned = 0;
  const unreadable = [];
  for (const path of paths) {
    // Every packed file is read, and the only thing that stops a scan is content
    // that is not text. The previous version filtered on an extension list
    // (`js|cjs|mjs|json|md|txt`), and `examples/db.json.example` -- added to
    // `files` in this change -- ends in `.example`, so the scan silently never
    // looked at it and reported a clean result for a file it had not opened. A
    // filter that can fall out of date is worse than no filter: it is a check
    // that reads as coverage. A NUL byte is the test for "this is not text",
    // which needs no list to maintain.
    let bytes;
    try {
      bytes = await readFile(join(root, path));
    } catch {
      // A file npm lists but cannot read here is npm's problem, not a leak --
      // but it is counted and printed, so a run of them is visible.
      unreadable.push(path);
      continue;
    }
    if (bytes.length === 0 || bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    scanned++;

    // `hasOwn` rather than a truthiness test, for the reason on `capturedValue`
    // above: a key that happens to exist on `Object.prototype` would otherwise be
    // picked up here as though the pattern had declared it.
    for (const entry of SECRET_PATTERNS) {
      const { name, re } = entry;
      const capturedValue = Object.hasOwn(entry, 'capturedValue') ? entry.capturedValue : null;
      // Every match, not the first, and on a *fresh* regex per file: a global
      // regex carries `lastIndex` between files, so the second file in the
      // tarball would silently start its search wherever the last one stopped.
      // The first-match-only behaviour also meant one allowlisted hit in a file
      // hid every later hit in it.
      const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      for (let hit = scan.exec(text); hit !== null; hit = scan.exec(text)) {
        const value = capturedValue ? capturedValue(hit) : null;
        if (value !== null && PLACEHOLDER_VALUES.has(value.toLowerCase())) {
          placeholders++;
          continue;
        }
        findings.push({
          path,
          name,
          match: hit[0].slice(0, 60),
          line: text.slice(0, hit.index).split('\n').length,
        });
      }
    }
  }
  const unexpected = findings.filter(f => !SECRET_ALLOWLIST.has(f.path));
  check('no credential in the packed output', unexpected.length === 0,
    unexpected.length
      ? unexpected.map(f => `${f.path}:${f.line} ${f.name}`).join('; ')
      : `${scanned} file(s) scanned, ${findings.length} allowlisted match(es), `
        + `${SECRET_ALLOWLIST.size} allowlist entries, ${placeholders} documented placeholder(s)`);
  if (unreadable.length) note(`unreadable, so unscanned: ${unreadable.join(', ')}`);

  // The bin shim is the one file whose *content* is behaviour: a CRLF shebang
  // works on Windows and fails on every other platform, and nothing in the file
  // list would notice.
  const binSource = await readFile(join(root, 'src', 'index.js'), 'utf8');
  check('the bin starts with a node shebang', binSource.startsWith('#!/usr/bin/env node\n'),
    JSON.stringify(binSource.split('\n')[0]));
  check('the bin has no CRLF line endings', !binSource.includes('\r'),
    binSource.includes('\r') ? 'CRLF found: a CRLF shebang fails on Linux and macOS' : 'LF only');

  // -------------------------------------------------------------------------
  // Install it the way a consumer would
  // -------------------------------------------------------------------------
  console.log('\ninstalling into an empty directory');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'anydb-verify', version: '1.0.0', private: true })
  );
  // The install script is approved here, and this is the part worth reading twice.
  //
  // npm 12 blocks install scripts by default, so a bare `npm install anydb-mcp`
  // leaves the sqlite3 native binding unbuilt -- and the server starts, lists its
  // tools, and answers every other database, so nothing fails loudly. That is
  // exactly the 2.0.0 outage. The old check passed anyway, because
  // `answered || explained` is true whenever SQLite explains itself.
  //
  // So the consumer here is put in the state the README tells people to be in
  // (`npm install-scripts approve sqlite3`, or this file, which is what
  // `.npmrc.example` is for), and the SQLite assertion below is then a real one:
  // the binding has to work, or the check fails. A consumer who has *not* approved
  // it still gets a working server and four working databases; that state is
  // asserted separately, and it is the only thing
  // ANYDB_VERIFY_ALLOW_MISSING_SQLITE is for.
  await writeFile(join(dir, '.npmrc'), [
    '# The state README.md tells a consumer to be in. See .npmrc.example.',
    'allow-scripts=sqlite3',
    '',
  ].join('\n'));
  const installed = await tryNpm(['install', spec, '--no-fund', '--no-audit', '--silent'], dir);
  if (!installed.ok) {
    console.error(installed.stderr);
    await cleanup();
    process.exit(1);
  }

  const target = join(dir, 'node_modules', 'anydb-mcp');
  const installedManifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  check('installed version is the one under test', installedManifest.version === version, installedManifest.version);

  // A tool that reads the installed version must not be locked out by exports.
  await writeFile(
    join(dir, 'version.mjs'),
    "import { createRequire } from 'node:module';\n" +
    "const require = createRequire(import.meta.url);\n" +
    "console.log(require('anydb-mcp/package.json').version);\n"
  );
  const subpath = await runNode(join(dir, 'version.mjs'), { cwd: dir });
  check('anydb-mcp/package.json is exported', subpath.code === 0 && subpath.stdout.trim() === version,
    subpath.timedOut ? 'timed out' : (subpath.code ? head(subpath.stderr) : ''));

  // -------------------------------------------------------------------------
  // The library entry point
  // -------------------------------------------------------------------------
  console.log('\nlibrary entry point');
  const installedRoot = await readdir(target);

  check('the tarball ships src/lib.js', existsSync(join(target, 'src', 'lib.js')));
  check('the root export is lib.js, not the server', installedManifest.main === 'src/lib.js', installedManifest.main);
  check('the ./server subpath is exported', installedManifest.exports['./server'] === './src/index.js',
    JSON.stringify(installedManifest.exports));

  // The regression test for the bug this file fixes: importing the package used to
  // start a server. A child that imports it and then does nothing has to *exit*,
  // because the old import left a live reaper interval and a stdin reader behind.
  // If it does not exit, `runNode` times out and this fails.
  const sideEffectProbe = [
    "const before = {",
    "  sigint: process.listenerCount('SIGINT'),",
    "  sigterm: process.listenerCount('SIGTERM'),",
    "  beforeExit: process.listenerCount('beforeExit'),",
    "  uncaught: process.listenerCount('uncaughtException'),",
    "  unhandled: process.listenerCount('unhandledRejection'),",
    "  stdinData: process.stdin.listenerCount('data'),",
    "  stdinReadable: process.stdin.listenerCount('readable'),",
    "  timeouts: process.getActiveResourcesInfo().filter(r => r === 'Timeout').length,",
    "};",
    "const started = process.hrtime.bigint();",
    "const lib = await import('anydb-mcp');",
    "const ms = Number(process.hrtime.bigint() - started) / 1e6;",
    "const after = {",
    "  sigint: process.listenerCount('SIGINT'),",
    "  sigterm: process.listenerCount('SIGTERM'),",
    "  beforeExit: process.listenerCount('beforeExit'),",
    "  uncaught: process.listenerCount('uncaughtException'),",
    "  unhandled: process.listenerCount('unhandledRejection'),",
    "  stdinData: process.stdin.listenerCount('data'),",
    "  stdinReadable: process.stdin.listenerCount('readable'),",
    "  timeouts: process.getActiveResourcesInfo().filter(r => r === 'Timeout').length,",
    "};",
    `console.log('${MARKER}' + JSON.stringify({ key: 'lib', before, after, ms, names: Object.keys(lib).length }));`,
    // Deliberately no process.exit, and nothing after this line: the assertion
    // that matters is that the process ends by itself.
  ].join('\n');
  await writeFile(join(dir, 'sideeffects.mjs'), sideEffectProbe);

  const probe = await runNode(join(dir, 'sideeffects.mjs'), { cwd: dir, timeoutMs: 120000 });
  const libPayload = parsePayload(probe.stdout)['lib'];

  check("import('anydb-mcp') has no side effects", probe.code === 0 && !probe.timedOut && !!libPayload,
    probe.timedOut
      ? 'the process did not exit within 120s: something is holding the event loop open'
      : (probe.code ? head(probe.stderr) : (libPayload ? '' : `no answer on stdout: ${head(probe.stdout + probe.stderr, 4)}`)));
  if (libPayload) {
    check("import('anydb-mcp') registers no process handler",
      libPayload.after.sigint === libPayload.before.sigint
      && libPayload.after.sigterm === libPayload.before.sigterm
      && libPayload.after.beforeExit === libPayload.before.beforeExit
      && libPayload.after.uncaught === libPayload.before.uncaught
      && libPayload.after.unhandled === libPayload.before.unhandled,
      `${libPayload.before.sigint}->${libPayload.after.sigint} SIGINT, `
      + `${libPayload.before.sigterm}->${libPayload.after.sigterm} SIGTERM, `
      + `${libPayload.before.beforeExit}->${libPayload.after.beforeExit} beforeExit`);
    check("import('anydb-mcp') does not read stdin, so no stdio transport was attached",
      libPayload.after.stdinData === libPayload.before.stdinData
      && libPayload.after.stdinReadable === libPayload.before.stdinReadable,
      `data ${libPayload.before.stdinData}->${libPayload.after.stdinData}, `
      + `readable ${libPayload.before.stdinReadable}->${libPayload.after.stdinReadable}`);
    check("import('anydb-mcp') starts no timer, so no reaper is running",
      libPayload.after.timeouts <= libPayload.before.timeouts,
      `${libPayload.before.timeouts}->${libPayload.after.timeouts} timers`);
    // A HANG GUARD, NOT A PERFORMANCE TARGET -- PLEASE DO NOT TIGHTEN IT
    // --------------------------------------------------------------------
    // The bound is 60 seconds and it is deliberately far above any plausible
    // measurement. Three reasons, and the second is the important one:
    //
    //   1. Wall clock on a *cold* module cache is machine-dependent to a degree
    //      no threshold survives. The same import measured 2.9s, 3.2s, 3.4s and
    //      3.0s on four consecutive runs of one idle machine, and 11s-29s in the
    //      installed copy on a loaded one. A number tight enough to be a
    //      performance claim fails on a busy CI runner, and a check that fails on
    //      a busy CI runner is a check everybody learns to retry.
    //   2. What this actually has to catch is a *hang* -- an import that never
    //      resolves, or one that opens something the process cannot close. Those
    //      are measured in minutes or not at all. 60s is short enough to fail the
    //      check before the CI job's own 30-minute ceiling and long enough to
    //      never fire on a slow machine.
    //   3. The *number* is printed on every run, pass or fail, so a regression is
    //      visible in the log without any threshold having to be chosen for it.
    //      Reading the trend in the log is the intended way to use this check.
    //
    // If this line is ever "improved" by lowering 60000, the result is a flaky
    // assertion, not a better one. If the number in the log starts climbing, the
    // fix is in what gets imported, not in this bound.
    //
    // WHAT A CLIMBING NUMBER MEANS: every adapter's driver is now resolved inside
    // `connect()` rather than at module scope, so the number measures *this
    // package's own* source and nothing else. A number that climbs back towards
    // the 2.8-4.1s it used to sit at says a module-scope `import` of a driver has
    // come back somewhere -- one of the five adapters, or a dependency of
    // `src/core/**` -- and that is the thing to look for, not a threshold to
    // raise. A number that climbs in proportion to the dependency count, with no
    // new import, is the machine, which is what point 1 above is about.
    //
    // WHERE IT HAS BEEN: 4082ms and 2757ms before the drivers were made lazy, and
    // 890ms and 613ms after. The same ordering on the installed copy, where the
    // module cache is cold either way. It did not go to zero -- `src/lib.js` is
    // still eight source files and the MCP SDK is still a real dependency -- but
    // none of the five drivers is loaded by an import any more, which is the part
    // that was being paid on every stdio spawn.
    const COLD_IMPORT_HANG_MS = Number(process.env.ANYDB_VERIFY_IMPORT_HANG_MS ?? 60000);
    const coldImportMs = Math.round(libPayload.ms);
    note(`cold import('anydb-mcp'): ${coldImportMs}ms (hang guard ${COLD_IMPORT_HANG_MS}ms, not a target)`);
    check('a cold import(\'anydb-mcp\') returns instead of hanging',
      coldImportMs < COLD_IMPORT_HANG_MS,
      `${coldImportMs}ms`);
    check('import("anydb-mcp") exports the testable core', libPayload.names > 90, `${libPayload.names} names`);
  }

  // The names a consumer is promised, read from the installed copy.
  const namesProbe = [
    "const lib = await import('anydb-mcp');",
    `console.log('${MARKER}' + JSON.stringify({`,
    "  key: 'names',",
    "  required: ['AdapterRegistry','ProfileStore','checkConnectionPolicy','inspectQuery','clampResult','formatRows','ConnectionCache']",
    "    .filter(n => lib[n] === undefined),",
    "  namespaces: ['registry','profiles','policy','safety','resultLimits','tools','connectionCache','baseAdapter','logging']",
    "    .filter(n => lib[n] === undefined),",
    '}));',
  ].join('\n');
  await writeFile(join(dir, 'names.mjs'), namesProbe);
  const names = parsePayload((await runNode(join(dir, 'names.mjs'), { cwd: dir })).stdout)['names'];
  check('every documented top-level export is present', !!names && names.required.length === 0 && names.namespaces.length === 0,
    names ? [...names.required, ...names.namespaces].join(', ') || 'all present' : 'probe did not answer');
  check('the tarball ships no test files', !installedRoot.includes('__tests__'),
    installedRoot.includes('__tests__') ? installedRoot.join(' ') : `${installedRoot.length} top-level entries`);

  // -------------------------------------------------------------------------
  // The bin shim, executed
  // -------------------------------------------------------------------------
  console.log('\nbin shim');
  const binName = 'anydb-mcp';
  const binPath = join(dir, 'node_modules', '.bin', process.platform === 'win32' ? `${binName}.cmd` : binName);
  check('bin is installed', existsSync(binPath), binPath);
  if (process.platform !== 'win32') {
    const mode = statSync(binPath).mode;
    check('bin is executable', (mode & 0o111) !== 0, `mode ${(mode & 0o777).toString(8)}`);
  }

  // The previous version checked `existsSync` and then started the server by path
  // instead, so nothing ever proved the shim itself works. Here it is executed,
  // with a real handshake down its stdin and a real `tools/list` back.
  const handshake = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1.0.0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n') + '\n';

  // A stdio server is supposed to stay alive, so the shim is killed as soon as
  // the `tools/list` answer has arrived. That is also the assertion: if the shim
  // never answers, `killWhen` never fires and the timeout is what fails.
  const shim = await runCommand(binPath, [], {
    cwd: dir,
    input: handshake,
    timeoutMs: 45000,
    killWhen: (soFar) => Object.keys(parseRpc(soFar)).includes('2'),
  });
  const shimFrames = parseRpc(shim.stdout);
  const shimTools = shimFrames['2']?.result?.tools?.map(t => t.name) ?? [];

  check('the bin shim starts a server and answers initialize',
    !!shimFrames['1']?.result?.serverInfo, shimFrames['1'] ? '' : head(shim.stderr));
  check('the bin shim reports the version under test',
    shimFrames['1']?.result?.serverInfo?.version === version,
    shimFrames['1']?.result?.serverInfo?.version ?? 'no serverInfo');
  check('the bin shim lists all five tools',
    JSON.stringify(shimTools) === JSON.stringify(TOOL_NAMES), shimTools.join(',') || 'no tools/list answer');

  // -------------------------------------------------------------------------
  // The installed server, driven by a client
  // -------------------------------------------------------------------------
  // The newest 1.x first. `package.json` declares `^1.30.1`, so the newest 1.x
  // is what nearly every consumer gets, and the version a regression would land
  // in. The floor is driven afterwards.
  const newest = await tryNpm(['view', `@modelcontextprotocol/sdk${SDK_RANGE.replace('^', '@^')}`, 'version'], dir, 120000);
  const newestVersion = newest.ok
    ? [...newest.stdout.matchAll(/\b\d+\.\d+\.\d+[\w.+-]*/g)].map(m => m[0]).pop()
    : null;
  const latestSpec = newestVersion ? `@modelcontextprotocol/sdk@${newestVersion}` : SDK_FLOOR_SPEC;
  const withSdk = await tryNpm(['install', latestSpec, '--no-fund', '--no-audit', '--silent'], dir);
  if (!withSdk.ok) {
    console.error(withSdk.stderr);
    await cleanup();
    process.exit(1);
  }
  const installedSdk = JSON.parse(
    await readFile(join(dir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8')
  ).version;
  note(`MCP SDK ${installedSdk} (${latestSpec}; range is ${SDK_RANGE}, floor is ${SDK_FLOOR_SPEC})`);

  // The entry point is located by path rather than through the package export, so
  // the script can also be pointed at a version that predates the export.
  const drive = `
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOLS, LIMITS } from 'anydb-mcp';
const entry = 'node_modules/anydb-mcp/src/index.js';
const mark = (key, value) => console.log('${MARKER}' + JSON.stringify({ key, ...value }));

const client = new Client({ name: 'verify', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry] }));

const text = async (name, args) =>
  (await client.callTool({ name, arguments: args })).content?.[0]?.text ?? '';

mark('tools', { names: (await client.listTools()).tools.map(t => t.name) });
mark('bypass', { text: await text('db_query', { uri: 'sqlite://:memory:', query: "SELECT 'a\\\\'; DROP TABLE t; --'" }) });
mark('badTimeout', { text: await text('db_query', { uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: -5 }) });
mark('bigTimeout', { text: await text('db_query', { uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: LIMITS.timeout.max + 1 }) });
mark('unknownTool', { text: await text('db_exec', { uri: 'sqlite://:memory:', query: 'CREATE TABLE t (a INT)' }) });
mark('write', { text: await text('db_query', { uri: 'sqlite://:memory:', query: 'DROP TABLE t' }) });
mark('read', { text: await text('db_query', { uri: 'sqlite://:memory:', query: 'SELECT 1 AS ok' }) });
await client.close();
`;

  const driveResult = (await writeFile(join(dir, 'drive.mjs'), drive), await runNode(join(dir, 'drive.mjs'), { cwd: dir }));

  const payload = parsePayload(driveResult.stdout);

  if (driveResult.code !== 0 || driveResult.timedOut) {
    // Not filtered. Every diagnostic this server emits starts with `[anydb]`, so
    // the previous filter removed precisely the lines that explain a failure.
    console.error(head(driveResult.stderr, 20));
  }

  check('server starts from the installed package',
    driveResult.code === 0 && !driveResult.timedOut,
    driveResult.timedOut ? `did not exit within ${CHILD_TIMEOUT_MS}ms` : (driveResult.code ? `exit ${driveResult.code}` : ''));
  check('all five tools are listed',
    JSON.stringify(payload.tools?.names ?? []) === JSON.stringify(TOOL_NAMES),
    (payload.tools?.names ?? []).join(',') || 'no tools/list answer');
  check('multi-statement check survives a backslash', /Multiple statements/.test(payload.bypass?.text ?? ''),
    (payload.bypass?.text ?? '').slice(0, 72) || 'no answer');
  // Built from the installed package's own limits, because the message names the
  // bound and a hard-coded one goes stale the moment `LIMITS` moves.
  check('db_query rejects a timeout below the floor', /must be at least 1, got -5/.test(payload.badTimeout?.text ?? ''),
    (payload.badTimeout?.text ?? '').slice(0, 72) || 'no answer');
  check('db_query rejects a timeout above the ceiling', /must be at most 86400000/.test(payload.bigTimeout?.text ?? ''),
    (payload.bigTimeout?.text ?? '').slice(0, 72) || 'no answer');
  check('an unknown tool is refused, not executed', /UNKNOWN_TOOL/.test(payload.unknownTool?.text ?? ''),
    (payload.unknownTool?.text ?? '').slice(0, 72) || 'no answer');
  check('read-only mode still refuses a write', /Read-only mode/.test(payload.write?.text ?? ''),
    (payload.write?.text ?? '').slice(0, 72) || 'no answer');

  // The one that used to be unfailable.
  const readText = payload.read?.text ?? '';
  const answered = /"ok"\s*:\s*1/.test(readText);
  const explained = /SQLite support is unavailable/.test(readText);
  if (answered) {
    check('sqlite answers a query in the installed copy', true, 'query answered');
  } else if (explained) {
    check('sqlite answers a query in the installed copy', allowMissingSqlite,
      allowMissingSqlite
        ? 'MISSING BINDING, accepted because ANYDB_VERIFY_ALLOW_MISSING_SQLITE=1'
        : 'MISSING BINDING: the install script was blocked despite allow-scripts=sqlite3, so SQLite is '
          + 'broken for every consumer of this build. Run `npm rebuild sqlite3` in the install directory, '
          + 'or set ANYDB_VERIFY_ALLOW_MISSING_SQLITE=1 if a missing binding is expected here.');
  } else {
    check('sqlite answers a query in the installed copy', false, `neither answered nor explained: ${readText.slice(0, 72)}`);
  }

  // The degraded state, asserted on its own terms rather than as a way to pass the
  // check above. A missing binding must not take the other four databases with it,
  // and the server must still start -- that is a documented, supported state.
  if (explained && !answered) {
    check('a missing sqlite3 binding is reported rather than fatal', true,
      'the server ran and named the fix; this is the documented degraded state');
  }

  // -------------------------------------------------------------------------
  // The floor of the declared range
  // -------------------------------------------------------------------------
  console.log('\nSDK floor');
  const withFloor = await tryNpm(['install', SDK_FLOOR_SPEC, '--no-fund', '--no-audit', '--silent'], dir);
  if (!withFloor.ok) {
    check(`the SDK floor (${SDK_FLOOR_SPEC}) installs`, false, head(withFloor.stderr, 6));
  } else {
    const floorVersion = JSON.parse(
      await readFile(join(dir, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8')
    ).version;
    note(`MCP SDK ${floorVersion} (the declared floor)`);
    const floorRun = await runNode(join(dir, 'drive.mjs'), { cwd: dir });
    const floorPayload = parsePayload(floorRun.stdout);
    check('the server also works on the SDK floor',
      floorRun.code === 0 && !floorRun.timedOut
      && JSON.stringify(floorPayload.tools?.names ?? []) === JSON.stringify(TOOL_NAMES)
      && /Read-only mode/.test(floorPayload.write?.text ?? ''),
      floorRun.timedOut ? 'timed out' : (floorRun.code ? head(floorRun.stderr, 6) : ''));
  }
} finally {
  await cleanup();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
