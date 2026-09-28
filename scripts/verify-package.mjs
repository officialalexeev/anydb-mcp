#!/usr/bin/env node
/**
 * Install the packed tarball into an empty directory and drive the server the
 * way a consumer would.
 *
 * The unit suite runs against the working tree, where this package's own
 * allowScripts entry applies. That is how 2.0.0 passed every test and still
 * shipped a server that died on startup for anyone whose npm blocked the
 * sqlite3 install script. Only an installed copy shows that.
 *
 *   node scripts/verify-package.mjs                 verify what would be published
 *   node scripts/verify-package.mjs --from-registry verify what is published
 *
 * The two are not the same. After a publish, only the second one tells you
 * whether the registry copy runs.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = '@modelcontextprotocol/sdk@1.30.1';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

// Windows cannot execFile a .cmd, and the repo path here contains a space, so
// quoting is not optional either.
async function npmRun(args, cwd) {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const options = { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
  if (process.platform === 'win32') {
    return exec(cmd, args.map(a => (/\s/.test(a) ? `"${a}"` : a)), { ...options, shell: true });
  }
  return exec(cmd, args, options);
}

async function tryNpm(args, cwd) {
  try {
    return { ok: true, ...(await npmRun(args, cwd)) };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
  }
}

function runNode(script, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => resolve({ code: 1, stdout, stderr: String(err) }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const fromRegistry = process.argv.includes('--from-registry');
const wanted = process.argv.find(a => a.startsWith('--version='))?.slice('--version='.length);

let version;
let tarball = null;
let spec;

if (fromRegistry) {
  spec = wanted ? `anydb-mcp@${wanted}` : 'anydb-mcp';
  const viewed = await tryNpm(['view', spec, 'version'], root);
  if (!viewed.ok) {
    console.error(`Cannot read ${spec} from the registry. Propagation can take a few minutes.`);
    process.exit(1);
  }
  version = viewed.stdout.trim();
  console.log(`verifying the published ${spec} (${version})`);
} else {
  console.log('packing');
  const packed = await tryNpm(['pack', '--json', '--pack-destination', root], root);
  if (!packed.ok) {
    console.error(packed.stderr);
    process.exit(1);
  }
  // npm reports `pack --json` as an array on some versions and as an object
  // keyed by package name on others.
  const reported = JSON.parse(packed.stdout);
  const { filename, version: packedVersion } =
    Array.isArray(reported) ? reported[0] : reported[Object.keys(reported)[0]];
  version = packedVersion;
  spec = tarball = join(root, filename);
  console.log(`  ${filename} (${version})`);
}

const dir = await mkdtemp(join(tmpdir(), 'anydb-verify-'));

try {
  console.log('installing into an empty directory');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'anydb-verify', version: '1.0.0', private: true })
  );
  const installed = await tryNpm(['install', spec, '--no-fund', '--no-audit', '--silent'], dir);
  if (!installed.ok) {
    console.error(installed.stderr);
    process.exit(1);
  }

  const target = join(dir, 'node_modules', 'anydb-mcp');
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  check('installed version is the one under test', manifest.version === version, manifest.version);

  const binPath = join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'anydb-mcp.cmd' : 'anydb-mcp');
  check('bin is installed', existsSync(binPath), binPath);

  // A tool that reads the installed version must not be locked out by exports.
  await writeFile(
    join(dir, 'version.mjs'),
    "import { createRequire } from 'node:module';\n" +
    "const require = createRequire(import.meta.url);\n" +
    "console.log(require('anydb-mcp/package.json').version);\n"
  );
  const subpath = await runNode(join(dir, 'version.mjs'), dir);
  check('anydb-mcp/package.json is exported', subpath.code === 0 && subpath.stdout.trim() === version,
    subpath.code ? 'ERR_PACKAGE_PATH_NOT_EXPORTED' : '');

  // The MCP client used to drive the server. It is a devDependency here, so it
  // is not inside the tarball and has to be added to the consumer.
  const withSdk = await tryNpm(['install', SDK, '--no-fund', '--no-audit', '--silent'], dir);
  if (!withSdk.ok) {
    console.error(withSdk.stderr);
    process.exit(1);
  }

  // A read-only guarantee that only holds in the working tree is no guarantee.
  // The entry point is located by path rather than through the package export,
  // so the script can also be pointed at a version that predates the export.
  const drive = `
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const entry = 'node_modules/anydb-mcp/src/index.js';

const client = new Client({ name: 'verify', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry] }));

const text = async (name, args) =>
  (await client.callTool({ name, arguments: args })).content?.[0]?.text ?? '';

console.log(JSON.stringify({
  tools: (await client.listTools()).tools.map(t => t.name),
  bypass: await text('db_query', { uri: 'sqlite://:memory:', query: "SELECT 'a\\\\'; DROP TABLE t; --'" }),
  badTimeout: await text('db_schema', { uri: 'sqlite://:memory:', timeout: -5 }),
  read: await text('db_query', { uri: 'sqlite://:memory:', query: 'SELECT 1 AS ok' })
}));
await client.close();
`;
  await writeFile(join(dir, 'drive.mjs'), drive);

  console.log('driving the installed server');
  const result = await runNode(join(dir, 'drive.mjs'), dir);

  let payload = {};
  try {
    payload = JSON.parse(result.stdout.trim().split('\n').pop());
  } catch {
    // Fall through to the per-check output below.
  }

  if (result.code !== 0) {
    console.error(result.stderr.split('\n').filter(l => !l.startsWith('[anydb]')).slice(0, 12).join('\n'));
  }

  check('server starts from the installed package', result.code === 0, result.code ? `exit ${result.code}` : '');
  check('both tools are listed', payload.tools?.length === 2, (payload.tools || []).join(','));
  check('multi-statement check survives a backslash', /Multiple statements/.test(payload.bypass || ''),
    (payload.bypass || '').slice(0, 72));
  check('db_schema rejects a negative timeout', /must be between 1 and 86400000/.test(payload.badTimeout || ''),
    (payload.badTimeout || '').slice(0, 72));

  // SQLite may be unavailable when the install script was blocked, and that is
  // a documented state as long as the server still runs and says so.
  const answered = /"ok":\s*1/.test(payload.read || '');
  const explained = /SQLite support is unavailable/.test(payload.read || '');
  check('sqlite answers or explains how to install it', answered || explained,
    answered ? 'query answered' : (payload.read || '').slice(0, 60));
} finally {
  // Nothing was written next to the repo in registry mode.
  if (tarball) await rm(tarball, { force: true });
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
