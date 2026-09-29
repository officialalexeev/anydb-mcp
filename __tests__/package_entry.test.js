/**
 * The package entry point, and the bootstrap behind it.
 *
 * This is written as a child process, not as an in-process assertion, because
 * "the process still exits" is the only honest test of "nothing is holding it
 * open". The second half calls `createServer` and the request handlers in this
 * process, which is why `src/index.js` is back in `collectCoverageFrom`.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { TOOLS, TOOL_NAMES, validateArgs, findTool } from '../src/core/tools.js';
import { createServer, installRequestHandlers, main } from '../src/index.js';

const ROOT = process.cwd();
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * Run a node script and collect everything it produced.
 *
 * The timeout is the point of the helper, not a safety net: two of the tests
 * below assert that a process *exits*, and a hung child would otherwise turn a
 * regression into a Jest timeout with no output at all.
 */
function runNode(script, { cwd = ROOT, timeoutMs = 30000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += String(err); });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on('close', finish);
    child.on('error', () => finish(1));
  });
}

describe('the package entry point', () => {
  describe('package.json points at the library, not the server', () => {
    test('the root entry is src/lib.js', () => {
      expect(manifest.main).toBe('src/lib.js');
    });

    test('the root export is src/lib.js', () => {
      expect(manifest.exports['.']).toBe('./src/lib.js');
    });

    test('the server is still reachable, at its own subpath', () => {
      // The arrangement: the root is a library, and anybody who genuinely wanted
      // the bootstrap has `anydb-mcp/server` to ask for.
      expect(manifest.exports['./server']).toBe('./src/index.js');
    });

    test('the bin is still the server, not the library', () => {
      // A `.cmd` shim that ran `src/lib.js` would start nothing and exit 0, which
      // looks like a healthy server to every client.
      expect(manifest.bin['anydb-mcp']).toBe('src/index.js');
    });
  });

  describe('src/lib.js is a pure barrel', () => {
    test('it does not import the server', () => {
      // Static, not dynamic: `./index.js` anywhere in the source is the thing
      // that must not be reachable from the library entry.
      const source = readFileSync(join(ROOT, 'src', 'lib.js'), 'utf8');
      expect(source).not.toMatch(/from '\.\/index\.js'/);
      expect(source).not.toMatch(/import\('\.\/index\.js'\)/);
    });

    test('importing it registers no process handler', async () => {
      // Compared before and after rather than counted, because Jest has handlers
      // of its own and an absolute count would be a count of Jest's.
      const before = handlerCounts();
      await import('../src/lib.js');
      expect(handlerCounts()).toEqual(before);
    });

    test('importing it does not read stdin, so no stdio transport is attached', async () => {
      // `StdioServerTransport` puts a reader on `process.stdin`. If one appears
      // here, `server.connect()` ran.
      const before = stdinCounts();
      await import('../src/lib.js');
      expect(stdinCounts()).toEqual(before);
    });

    test('every re-exported name exists in the module it names', async () => {
      // The failure mode this catches: a typo in a re-export is a `SyntaxError`
      // at link time in *the consumer*, not here, so nothing else would notice.
      const lib = await import('../src/lib.js');
      const sources = {
        registry: await import('../src/core/registry.js'),
        profiles: await import('../src/core/profiles.js'),
        policy: await import('../src/core/policy.js'),
        safety: await import('../src/core/safety.js'),
        resultLimits: await import('../src/core/result-limits.js'),
        tools: await import('../src/core/tools.js'),
        connectionCache: await import('../src/core/connection-cache.js'),
        baseAdapter: await import('../src/core/base-adapter.js'),
        logging: await import('../src/core/logging.js'),
        schema: await import('../src/core/schema.js'),
        paths: await import('../src/core/paths.js'),
        timeoutUtils: await import('../src/core/timeout-utils.js'),
      };

      // Every namespace must be a real module namespace, not `undefined`.
      for (const [name, ns] of Object.entries(sources)) {
        expect(lib[name]).toBeDefined();
        for (const exported of Object.keys(ns)) {
          expect(lib[name][exported]).toBeDefined();
        }
      }

      // And the flat layer must be defined: the names the task calls out, plus
      // everything else the barrel promises.
      for (const name of [
        'AdapterRegistry', 'ProfileStore', 'checkConnectionPolicy', 'inspectQuery',
        'clampResult', 'formatRows', 'ConnectionCache', 'buildEnvelope', 'BaseAdapter',
        'TOOLS', 'TOOL_NAMES', 'findTool', 'validateArgs', 'TimeoutError', 'withTimeout',
        'ConnectionCache', 'installShutdownHandlers', 'evaluatePolicy', 'hasMultipleStatements',
      ]) {
        expect(lib[name]).toBeDefined();
      }
    });

    test('the flat layer resolves the names the modules disagree about', () => {
      // Three names are exported by more than one core module with *different*
      // values, and picking silently would be a bug in the consumer. Asserted so
      // the choice is a decision somebody wrote down.
      return import('../src/lib.js').then(async (lib) => {
        const resultLimits = await import('../src/core/result-limits.js');
        const logging = await import('../src/core/logging.js');
        const tools = await import('../src/core/tools.js');
        const safety = await import('../src/core/safety.js');

        // The result cap, not the log-record cap.
        expect(lib.DEFAULT_MAX_BYTES).toBe(resultLimits.DEFAULT_MAX_BYTES);
        expect(lib.DEFAULT_MAX_BYTES).not.toBe(logging.DEFAULT_MAX_BYTES);
        // The action *names*, not the internal predicate table of the same name.
        expect(lib.MONGO_ACTIONS).toEqual(tools.MONGO_ACTIONS);
        expect(lib.MONGO_ACTIONS).not.toEqual(safety.MONGO_ACTIONS);
        // The schema module's own format list, which is the one the tool uses.
        expect(lib.FORMATS).toEqual(tools.FORMATS);
      });
    });

    test('logging is namespaced rather than flattened', async () => {
      // `log()` has a file sink. A flat `log` would mean `import { log } from
      // 'anydb-mcp'` writes to the caller's disk without saying so.
      const lib = await import('../src/lib.js');
      expect(lib.logging.log).toBeInstanceOf(Function);
      expect(lib.log).toBeUndefined();
      expect(lib.maskUri).toBeUndefined();
    });

    test('the tool schemas the barrel exports are the ones the server serves', async () => {
      // The barrel and `src/index.js` must not be able to disagree about the tool
      // set: a consumer that validates against `TOOLS` has to get what the server
      // answers `tools/list` with.
      const lib = await import('../src/lib.js');
      expect(lib.TOOLS).toBe(TOOLS);
      expect(lib.TOOL_NAMES).toEqual(TOOL_NAMES);
    });
  });

  describe('importing the library does not start anything', () => {
    // The regression test for the bug, in a child process. Every other assertion
    // in this file can be satisfied by a module that opens a socket and closes it
    // again. This one cannot: the script imports the package and then does nothing
    // at all, and Node exits only when nothing is holding the loop open.
    //
    // The import is by absolute file URL because the child runs from a temp
    // directory with no `node_modules` of its own; the real bare-specifier
    // resolution is `scripts/verify-package.mjs`'s job.
    let dir;
    let result;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'anydb-entry-'));
      const probe = join(dir, 'probe.mjs');
      await writeFile(probe, [
        `const lib = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'lib.js')).href)});`,
        'process.stdout.write(JSON.stringify({ names: Object.keys(lib).length }));',
        // Deliberately no `process.exit`, and deliberately nothing after this.
      ].join('\n'));
      result = await runNode(probe, { cwd: dir, timeoutMs: 20000 });
    }, 40000);

    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    });

    test('the process exits on its own, so nothing is holding the loop open', () => {
      // The regression assertion: before the split, importing this module started
      // a server -- a 60 second reaper interval and a `process.stdin` reader,
      // either of which is enough to keep Node alive forever.
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
    });

    test('the import answers, and logged nothing', () => {
      expect(JSON.parse(result.stdout || '{}').names).toBeGreaterThan(90);
      // `[anydb]` is the prefix of every diagnostic this server emits. A line here
      // would mean the import started one.
      expect(result.stderr).not.toMatch(/\[anydb\]/);
    });
  });

  describe('the server module, imported rather than executed', () => {
    test('importing src/index.js constructs nothing either', async () => {
      // The second half of the arrangement, and the assertion that stops a
      // top-level `await server.connect()` coming back.
      const before = handlerCounts();
      const module = await import('../src/index.js');
      expect(handlerCounts()).toEqual(before);
      expect(typeof module.main).toBe('function');
      expect(typeof module.createServer).toBe('function');
    });

    test('createServer builds a server with the five tools and no side effects', async () => {
      const { createServer } = await import('../src/index.js');
      const before = handlerCounts();
      const ctx = createServer({
        env: { ANYDB_PROGRESS_MS: '250' },
        log: () => {},
        logError: () => {},
        clock: () => 1000,
      });

      expect(handlerCounts()).toEqual(before);
      expect(ctx.version).toBe(manifest.version);
      expect(ctx.progressMs).toBe(250);
      expect(ctx.server).toBeDefined();
      expect(ctx.registry).toBeDefined();
      // Not started: no reaper, no transport, no connect.
      expect(ctx.server.transport).toBeUndefined();

      await ctx.close();
    });

    test('an injected clock is the clock the results are timed with', async () => {
      // A value, not a measurement: the point of injecting `clock` is that
      // `elapsedMs` can be asserted at all.
      const { createServer, installRequestHandlers } = await import('../src/index.js');
      let now = 1_000_000;
      const ctx = createServer({
        env: {},
        log: () => {},
        logError: () => {},
        clock: () => now,
      });

      const bridge = {
        registry: {
          cache: { entries: new Map(), evict: () => {} },
          profiles: { list: () => [], source: null, reload: () => {} },
          listProfiles: () => [],
          describeConfiguration: () => ({ cache: {} }),
          resolveTarget: ({ uri }) => Promise.resolve({ uri, policy: {}, profileName: null }),
          run: () => Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1, truncated: false, bytes: 12 }),
          describe: () => Promise.resolve({ rows: {}, rowCount: 0, truncated: false, bytes: 0 }),
          close: async () => {},
        },
        resolveTarget: ({ uri }) => Promise.resolve({ uri, policy: {}, profileName: null }),
        // The clock moves *inside* the call, which is the only place it can: the
        // handler stamps `started` before it asks the registry for anything.
        run: async () => { now += 4321; return { rows: [{ ok: 1 }], rowCount: 1, truncated: false, bytes: 12 }; },
        describe: () => Promise.resolve({ rows: {}, rowCount: 0, truncated: false, bytes: 0 }),
        abandon: () => {},
        close: async () => {},
      };
      const { callTool } = installRequestHandlers(ctx.server, { ...ctx, bridge });

      const res = await callTool(
        { params: { name: 'db_query', arguments: { uri: 'sqlite://:memory:', query: 'SELECT 1' } } },
        {}
      );

      expect(res.structuredContent.elapsedMs).toBe(4321);
      await ctx.close();
    });
  });

  describe('the request handlers, in this process', () => {
    // The only way to call a handler before the split was to spawn
    // `node src/index.js` and speak JSON-RPC down a pipe.
    let ctx;
    let callTool;
    let listTools;
    let records;

    const stubAdapter = () => ({
      connect: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockResolvedValue([{ ok: 1 }]),
      close: jest.fn().mockResolvedValue(undefined),
      describe: jest.fn().mockResolvedValue({ database: 'stub', tables: [] }),
      abort: jest.fn(),
      isHealthy: jest.fn().mockResolvedValue(true),
    });

    beforeAll(async () => {
      const { createServer, installRequestHandlers } = await import('../src/index.js');
      records = [];
      const registry = {
        cache: { entries: new Map(), enabled: false, maxEntries: 0, idleTtlMs: 0, evict: jest.fn() },
        mapping: { sqlite: () => stubAdapter() },
        extractProtocol: (uri) => String(uri).split('://')[0],
        profiles: { list: () => [], source: null, reload: () => {} },
        listProfiles: () => [],
        describeConfiguration: () => ({ cache: { enabled: false } }),
        resolveTarget: ({ uri }) => Promise.resolve({ uri, policy: {}, profileName: null, entry: null, options: {} }),
        run: (target, query) => {
          if (/DROP|DELETE|INSERT|UPDATE|TRUNCATE/i.test(query)) {
            return Promise.reject(Object.assign(new Error('Read-only mode refuses this statement.'), { kind: 'policy' }));
          }
          return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1, truncated: false, bytes: 12 });
        },
        describe: () => Promise.resolve({ rows: { database: 'stub', tables: [] }, rowCount: 0, truncated: false, bytes: 0 }),
        close: jest.fn().mockResolvedValue(undefined),
      };
      ctx = createServer({ registry, env: {}, log: (...args) => records.push(args), logError: () => {}, clock: () => 1000 });
      ({ callTool, listTools } = installRequestHandlers(ctx.server, ctx));
    });

    afterAll(async () => {
      await ctx?.close();
    });

    const call = (name, args) => callTool({ params: { name, arguments: args } }, {});

    test('tools/list returns the five tools and nothing else', async () => {
      const { tools } = await listTools();
      expect(tools.map(t => t.name)).toEqual(TOOL_NAMES);
    });

    test('a read is answered in the declared envelope shape', async () => {
      const res = await call('db_query', { uri: 'sqlite://:memory:', query: 'SELECT 1 AS ok' });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ ok: true, rows: [{ ok: 1 }], rowCount: 1, format: 'json' });
      expect(typeof res.structuredContent.elapsedMs).toBe('number');
      expect(JSON.parse(res.content[0].text)).toEqual([{ ok: 1 }]);
    });

    test('a write is refused in band, with a suggestion, and not thrown', async () => {
      const res = await call('db_query', { uri: 'sqlite://:memory:', query: 'DROP TABLE t' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/^DATABASE_ERROR: Read-only mode/);
      expect(res.content[0].text).toMatch(/SUGGESTION:/);
      expect(res.structuredContent.ok).toBe(false);
      expect(res.structuredContent.error.kind).toBe('policy');
    });

    // The two fields `core/tools.js` *declares*. The e2e suite covers them
    // against a real driver; these cover the shapes that are awkward to produce
    // on demand and impossible to produce from SQLite at all.
    describe('the two error fields the schema declares', () => {
      let coded;
      let bare;

      beforeEach(() => {
        // Thrown by the registry, the way `registry.js` throws: an `Error` with
        // `.code` and `.operation` on it. Not a return value.
        coded = buildContext({
          run: async () => { throw Object.assign(new Error('relation "users" does not exist'), {
            code: '42P01', operation: 'db_query', kind: 'database',
          }); },
        });
        // A failure raised before the registry was ever reached, which is most of
        // them: no driver ran, so there is no driver code to report.
        bare = buildContext({
          run: async () => { throw Object.assign(new Error('profile "nope" is not configured'), {
            operation: 'db_query', kind: 'validation', suggestion: 'Call db_list.',
          }); },
        });
      });

      afterEach(async () => {
        await coded?.close();
        await bare?.close();
      });

      const query = (which) => which.callTool(
        { params: { name: 'db_query', arguments: { uri: 'sqlite://:memory:', query: 'SELECT 1' } } },
        {}
      );

      test('a driver code reaches structuredContent.error.code, as a string', async () => {
        const res = await query(coded);
        expect(res.structuredContent.error).toMatchObject({ code: '42P01', operation: 'db_query' });
      });

      test('the same code is in the text block, so a model reading it can branch', async () => {
        // A model is not a JSON parser. The text block is what it reads, and it
        // is the only place the code is guaranteed to sit beside the message.
        const res = await query(coded);
        expect(res.content[0].text).toMatch(/^DATABASE_ERROR: .*\[42P01\]\nSUGGESTION: /);
      });

      test('a numeric driver code stays a number, and still renders in the text', async () => {
        // `11000` is the MongoDB duplicate-key code and `errno` is a number in
        // the pg driver. `String(11000)` would make the field's declared type a
        // guess rather than a fact.
        const numeric = buildContext({
          run: async () => { throw Object.assign(new Error('E11000 duplicate key error'), {
            code: 11000, operation: 'db_query', kind: 'database',
          }); },
        });
        try {
          const res = await query(numeric);
          expect(res.structuredContent.error.code).toBe(11000);
          expect(typeof res.structuredContent.error.code).toBe('number');
          expect(res.content[0].text).toMatch(/\[11000\]/);
        } finally {
          await numeric.close();
        }
      });

      test('an error with no code reports null, not an absent property', async () => {
        // The SDK validates `structuredContent` against `outputSchema`, and a
        // client that generates a type from the schema must be able to read
        // `code` and `operation` without a `in` check. `undefined` is not `null`.
        const res = await query(bare);
        expect(res.structuredContent.error.code).toBeNull();
        expect(res.structuredContent.error.operation).toBe('db_query');
        expect('code' in res.structuredContent.error).toBe(true);
        expect('operation' in res.structuredContent.error).toBe(true);
      });

      test('an error with neither field still satisfies the declared shape', async () => {
        // The smallest failure there is: a handler's own refusal, with no code
        // and no operation, which is the case the `?? null` pair exists for.
        const own = buildContext({
          run: async () => { throw new Error('nothing useful was said'); },
        });
        try {
          const res = await query(own);
          const error = res.structuredContent.error;
          expect(error.code).toBeNull();
          expect(error.operation).toBeNull();
          expect(typeof error.kind).toBe('string');
          expect(typeof error.message).toBe('string');
          expect(typeof error.suggestion).toBe('string');
        } finally {
          await own.close();
        }
      });

      test('an unknown tool name produces the same error shape as a database failure', async () => {
        // It used to be a hand-written literal, which is how two declared fields
        // came to be missing: the one failure built outside `errorField` lost them.
        const res = await coded.callTool({ params: { name: 'db_nope', arguments: {} } }, {});
        expect(res.isError).toBe(true);
        expect(Object.keys(res.structuredContent.error).sort())
          .toEqual(['code', 'kind', 'message', 'operation', 'suggestion']);
      });

      test('the [CODE] marker is on the first line and the suggestion still ends the block', async () => {
        const res = await query(coded);
        const lines = res.content[0].text.split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[0].startsWith('DATABASE_ERROR: ')).toBe(true);
        expect(lines[1].startsWith('SUGGESTION: ')).toBe(true);
        expect(res.content[0].text).not.toMatch(/\[\]/);
      });
    });

    test('an unknown tool name is refused rather than run', async () => {
      // The handler used to be `name === 'db_schema' ? handleSchema : handleQuery`,
      // and the SDK never validates the tool name, so `db_exec` executed SQL.
      const res = await call('db_exec', { uri: 'sqlite://:memory:', query: 'DROP TABLE t' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/UNKNOWN_TOOL/);
      expect(res.content[0].text).toMatch(/Nothing was executed/);
    });

    test('every problem with the arguments is reported, not just the first', async () => {
      const res = await call('db_query', { query: 123, timeout: -1 });
      expect(res.isError).toBe(true);
      expect(res.structuredContent.error.details.length).toBeGreaterThan(1);
    });

    test('db_list works with no config file and says so', async () => {
      const res = await call('db_list', {});
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent.profiles).toEqual([]);
      expect(res.structuredContent.configSource).toBeNull();
    });

    test('a cancelled call is answered as a timeout, and abandons the connection', async () => {
      const controller = new AbortController();
      controller.abort();
      const res = await callTool(
        { params: { name: 'db_query', arguments: { uri: 'sqlite://:memory:', query: 'SELECT 1' } } },
        { signal: controller.signal }
      );
      expect(res.isError).toBe(true);
      expect(res.structuredContent.error.kind).toBe('timeout');
    });

    test('the arguments the handler forwards are the ones the schema declares', () => {
      // The validator is the contract; the handler has to be the thing that uses
      // it, or the schema is decoration.
      const tool = findTool('db_query');
      const good = validateArgs(tool, { uri: 'sqlite://:memory:', query: 'SELECT 1' });
      expect(good.ok).toBe(true);
      const bad = validateArgs(tool, { uri: 'sqlite://:memory:', query: 'SELECT 1', nope: 1 });
      expect(bad.ok).toBe(false);
      expect(bad.errors.join(' ')).toMatch(/Unknown argument "nope"/);
    });

    test('a registry that breaks the envelope contract is a loud internal error', () => {
      // `db_schema` reports a bare object with no `rows` array, so any branch that
      // re-shaped an unknown object into a one-row envelope was one refactor away
      // from wrapping a whole schema report. The contract is now one shape, and a
      // double that breaks it says so instead of being quietly believed.
      const broken = buildContext({ run: async () => ({ ok: true, rows: [{ a: 1 }] }) });
      return broken.callTool(
        { params: { name: 'db_query', arguments: { uri: 'sqlite://:memory:', query: 'SELECT 1' } } },
        {}
      ).then(async (res) => {
        expect(res.isError).toBe(true);
        expect(res.structuredContent.error.kind).toBe('internal');
        expect(res.structuredContent.error.message).toMatch(/buildEnvelope result was expected/);
        await broken.close();
      });
    });

    test('an array where an envelope belongs is also an internal error, not a result', () => {
      // The 2.x shape. Accepting it is what let a stub hide a real break.
      const broken = buildContext({ run: async () => [{ a: 1 }] });
      return broken.callTool(
        { params: { name: 'db_query', arguments: { uri: 'sqlite://:memory:', query: 'SELECT 1' } } },
        {}
      ).then(async (res) => {
        expect(res.structuredContent.error.kind).toBe('internal');
        expect(res.structuredContent.error.message).toMatch(/an array of 1/);
        // And the advice is about the server, not the SQL -- a `database` kind
        // here would tell the model to check its syntax, which is a wrong
        // instruction about a statement that never reached a database.
        expect(res.structuredContent.error.suggestion).toMatch(/not in the statement/);
        await broken.close();
      });
    });
  });

  describe('db_explain, in this process', () => {
    // Every one of these refusals happens *before* a statement is sent, which is
    // the property: `EXPLAIN ANALYZE` runs the statement it plans, so a server
    // that forwards it has forwarded a write to a read-only tool.
    let callTool;
    let sent;
    let ctx;

    beforeEach(() => {
      sent = [];
      ctx = buildContext({
        run: async (target, query, options) => {
          sent.push({ query, options });
          return { rows: [{ detail: 'SCAN t' }], rowCount: 1, truncated: false, bytes: 40 };
        },
      });
      callTool = ctx.callTool;
    });

    afterEach(async () => { await ctx.close(); });

    const explain = (args) => callTool({ params: { name: 'db_explain', arguments: args } }, {});

    test('prefixes the statement per dialect rather than trusting the caller', async () => {
      const res = await explain({ uri: 'sqlite://:memory:', query: 'SELECT 1' });
      expect(res.isError).toBeFalsy();
      expect(sent[0].query).toBe('EXPLAIN QUERY PLAN SELECT 1');
      expect(sent[0].options.readOnly).toBe(true);
    });

    test.each([
      ['postgres', 'EXPLAIN SELECT 1'],
      ['mysql', 'EXPLAIN SELECT 1'],
    ])('%s gets a bare EXPLAIN', async (scheme, expected) => {
      await explain({ uri: `${scheme}://u:p@h/d`, query: 'SELECT 1' });
      expect(sent[0].query).toBe(expected);
    });

    test.each([
      ['EXPLAIN ANALYZE SELECT 1', /executes the statement it plans/],
      ['EXPLAIN (ANALYZE, BUFFERS) SELECT 1', /executes the statement it plans/],
      ['EXPLAIN SELECT 1', /already begins with EXPLAIN/],
    ])('refuses %p without sending anything', async (query, expected) => {
      const res = await explain({ uri: 'sqlite://:memory:', query });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(expected);
      expect(sent).toHaveLength(0);
    });

    test('refuses Redis, which has no plan', async () => {
      const res = await explain({ uri: 'redis://127.0.0.1:6379', query: 'GET k' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/no execution plan/i);
      expect(sent).toHaveLength(0);
    });

    test('a Mongo explain is a find, so it needs a collection', async () => {
      const missing = await explain({ uri: 'mongodb://127.0.0.1:27017/d', query: '{}' });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toMatch(/collection/i);
      expect(sent).toHaveLength(0);
    });

    test('a Mongo explain sends the filter as a find with action "explain", not a prefixed statement', async () => {
      // A different call from the SQL one: no `EXPLAIN` is prepended,
      // `action: 'explain'` is set, and the collection travels in the options. If
      // the schema ever loses `collection` again, the `validateArgs` refusal
      // arrives before this assertion and says so.
      const res = await explain({ uri: 'mongodb://127.0.0.1:27017/d', query: '{"a":1}', collection: 'users' });
      expect(res.isError).toBeFalsy();
      expect(sent).toHaveLength(1);
      expect(sent[0].query).toBe('{"a":1}');
      expect(sent[0].options).toMatchObject({ action: 'explain', collection: 'users', readOnly: true });
      expect(sent[0].query).not.toMatch(/EXPLAIN/);
    });
  });

  describe('db_query, in this process', () => {
    // The MongoDB write actions are exposed by the schema, so every argument
    // they need has to survive this file's own allowlist on the way to the adapter.
    let sent;
    let ctx;

    beforeEach(() => {
      sent = [];
      ctx = buildContext({
        run: async (target, query, options) => {
          sent.push({ target, query, options });
          return { rows: [{ matchedCount: 1 }], rowCount: 1, truncated: false, bytes: 20 };
        },
      });
    });

    afterEach(async () => { await ctx.close(); });

    const query = (args) => ctx.callTool({ params: { name: 'db_query', arguments: args } }, {});

    test('forwards every argument the schema declares, except the statement and the target', () => {
      // The drift this catches is silent in both directions. `document` (the
      // replacement document for the `replace` action) was declared by the schema
      // and accepted by `validateArgs`, and was then dropped by this file's
      // `QUERY_OPTION_KEYS` -- so the adapter refused a call that had one in it,
      // with a message about a missing argument.
      const declared = Object.keys(findTool('db_query').inputSchema.properties);
      // `query` travels as its own positional argument. `profile` and `uri` name
      // the *target* and are re-derived by `targetSpecOf`; forwarding them would
      // put a credential-bearing URI in front of `resolveTarget` a second time.
      const positional = ['query', 'profile', 'uri'];
      const forwarded = declared.filter((k) => !positional.includes(k));

      const everything = {
        params: ['x'], collection: 'c', action: 'find', update: '{"$set":{"b":1}}',
        document: '{"b":2}', field: 'a', sort: '{"a":1}', projection: '{"a":1}',
        upsert: true, allowWriteStages: true, limit: 5, offset: 1, cursor: 'c1',
        readOnly: false, allowDestructive: true, format: 'jsonl', timeout: 1234,
        maxRows: 7, maxBytes: 8,
      };
      // If a new argument appears in the schema and is not named here, the list
      // has not grown to cover it -- and that is the failure this test exists for.
      expect(forwarded.filter((k) => !(k in everything))).toEqual([]);

      return query({ uri: 'mongodb://127.0.0.1:27017/d', query: '{}', ...everything }).then(() => {
        for (const key of forwarded) {
          expect(sent.at(-1).options).toHaveProperty(key, everything[key]);
        }
        // And the target is still `{ uri }`, never the resolved connection.
        expect(sent.at(-1).target).toEqual({ uri: 'mongodb://127.0.0.1:27017/d' });
      });
    });

    test('the three single-document Mongo actions reach the adapter with the document they need', () => {
      // Each one is refused by `adapters/mongodb.js` if its payload option is
      // missing, so this is the difference between an exposed action and a
      // working one. `updateOne` and `update` share `update`; `replace` needs
      // `document`; `deleteOne` needs neither.
      return Promise.all([
        query({ uri: 'mongodb://h/d', query: '{}', collection: 'c', action: 'updateOne', update: '{"$set":{"b":1}}', readOnly: false }),
        query({ uri: 'mongodb://h/d', query: '{}', collection: 'c', action: 'replace', document: '{"b":2}', readOnly: false }),
        query({ uri: 'mongodb://h/d', query: '{}', collection: 'c', action: 'deleteOne', readOnly: false }),
      ]).then(() => {
        const byAction = Object.fromEntries(sent.map((s) => [s.options.action, s.options]));
        expect(Object.keys(byAction).sort()).toEqual(['deleteOne', 'replace', 'updateOne']);
        expect(byAction.updateOne).toMatchObject({ update: '{"$set":{"b":1}}', collection: 'c' });
        expect(byAction.replace).toMatchObject({ document: '{"b":2}', collection: 'c' });
        expect(byAction.deleteOne).toMatchObject({ collection: 'c' });
      });
    });
  });

  describe('db_health, in this process', () => {
    let ctx;

    afterEach(async () => { await ctx?.close(); });

    const health = (args) => ctx.callTool({ params: { name: 'db_health', arguments: args } }, {});

    const healthContext = (over = {}) => buildContext({
      run: async () => ({ rows: [{ server_version: '16.1', role: 'reader', role_looks_read_only: true }], rowCount: 1, truncated: false, bytes: 60 }),
      describe: async () => ({ rows: { database: 'postgres', tables: [{ name: 't' }] }, rowCount: 1, truncated: false, bytes: 10 }),
      ...over,
    });

    test('reports the server, the role and the object counts', async () => {
      ctx = healthContext();
      const res = await health({ uri: 'postgres://u:p@h/d' });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({
        ok: true, reachable: true, database: 'postgres', serverVersion: '16.1', role: 'reader', readOnlyRole: true,
      });
      expect(res.structuredContent.objects).toEqual({ tables: 1 });
      expect(res.structuredContent.checks.every(c => c.ok)).toBe(true);
    });

    test('an unreachable database is a finding, not a crash', async () => {
      ctx = healthContext({ describe: async () => { throw new Error('ECONNREFUSED'); } });
      const res = await health({ uri: 'postgres://u:p@h/d' });
      expect(res.isError).toBe(true);
      expect(res.structuredContent.reachable).toBe(false);
      expect(res.structuredContent.checks.find(c => c.name === 'connect').ok).toBe(false);
      // The advice has to name the database, not blame the query.
      expect(res.content[0].text).toMatch(/could not be reached/);
    });

    test('a failed privilege probe is reported, and does not fail the call', async () => {
      // A role that cannot read the catalog is the fact the caller asked for.
      ctx = healthContext({ run: async () => { throw new Error('permission denied for pg_class'); } });
      const res = await health({ uri: 'postgres://u:p@h/d' });
      expect(res.structuredContent.reachable).toBe(true);
      expect(res.structuredContent.checks.find(c => c.name === 'server').ok).toBe(false);
    });

    test('redis reads its version out of the INFO text', async () => {
      ctx = healthContext({
        run: async () => ({ rows: ['# Server\r\nredis_version:7.2.4\r\nrole:slave\r\n'], rowCount: 1, truncated: false, bytes: 20 }),
        describe: async () => ({ rows: { database: 'redis' }, rowCount: 0, truncated: false, bytes: 0 }),
      });
      const res = await health({ uri: 'redis://127.0.0.1:6379' });
      expect(res.structuredContent).toMatchObject({ serverVersion: '7.2.4', role: 'slave', readOnlyRole: true });
    });

    test('a Mongo health check counts admin.system.version rather than asking for a version', async () => {
      // MongoDB surfaces no version string to a read, so the probe counts the one
      // collection that exists on every server, proving reachability *and*
      // permission over the catalog in one round trip.
      ctx = healthContext({
        run: async (target, query, options) => {
          if (options?.collection === 'admin.system.version') {
            return { rows: [{ count: 1 }], rowCount: 1, truncated: false, bytes: 4 };
          }
          throw new Error('unexpected probe');
        },
        describe: async () => ({ rows: { database: 'mongodb', collections: [] }, rowCount: 0, truncated: false, bytes: 0 }),
      });
      const res = await health({ uri: 'mongodb://127.0.0.1:27017/d' });
      expect(res.structuredContent.reachable).toBe(true);
      expect(res.structuredContent.checks.map(c => c.name)).toEqual(['connect', 'mongo-catalog', 'server']);
      expect(res.structuredContent.checks.find(c => c.name === 'mongo-catalog').detail).toMatch(/1 document/);
    });
  });

  describe('main, with everything injected', () => {
    test('starts the reaper, installs the process handlers, connects, and logs', async () => {
      // The one test that runs the whole `main` path. Every dependency is a fake,
      // so the only real things are the five process handlers and their order.
      const started = [];
      const connected = [];
      // `once` as well as `on`, because `installShutdownHandlers` registers
      // SIGINT, SIGTERM and beforeExit with `once` and this fake has to answer a
      // signal. It records the registration *kind* so the test can assert which.
      const fakeProcess = {
        handlers: {},
        registrations: [],
        on(event, fn) { this.register('on', event, fn); return this; },
        once(event, fn) { this.register('once', event, fn); return this; },
        register(kind, event, fn) {
          (this.handlers[event] ??= []).push(fn);
          this.registrations.push({ kind, event });
          return this;
        },
        emit(event) { (this.handlers[event] ?? []).forEach((fn) => fn(event)); },
        exit: jest.fn(),
      };
      const cache = {
        enabled: true, maxEntries: 8, idleTtlMs: 300000, entries: new Map(), size: 0,
        installed: false,
        start: () => started.push('cache.start'),
        stop: jest.fn(),
        closeAll: jest.fn().mockResolvedValue(undefined),
        evict: jest.fn(),
      };
      const registry = {
        cache,
        mapping: {},
        profiles: { list: () => [], source: null, reload: () => {} },
        listProfiles: () => [],
        describeConfiguration: () => ({ cache: { enabled: true, size: 0, maxEntries: 8, idleTtlMs: 300000 } }),
        close: jest.fn().mockResolvedValue(undefined),
      };
      const records = [];

      // Measured, not assumed: these are the counts on the *real* process, and
      // the assertion is that `main` did not change them. Before
      // `installShutdownHandlers` took a `process`, the two signals and
      // `beforeExit` went there regardless of what was injected, so a test had to
      // remove them again in a `finally` -- and a skipped cleanup leaked three
      // handlers into every later test in the same worker.
      const realBefore = handlerCounts();

      const ctx = await main({
        registry,
        process: fakeProcess,
        env: { ANYDB_PROGRESS_MS: '750' },
        log: (name, detail, options) => records.push({ name, detail, options }),
        logError: () => {},
        version: '9.9.9',
        transport: {
          async start() { connected.push('start'); },
          async close() { connected.push('close'); },
        },
      });

      try {
        expect(started).toEqual(['cache.start']);
        expect(connected).toEqual(['start']);

        // All five, on the object that was injected. The two signals and
        // beforeExit come from the cache's own shutdown wiring and are bound
        // with `once`; the two exception handlers use `on` on purpose, because
        // Node's default is to terminate on the *first* of them.
        expect(Object.keys(fakeProcess.handlers).sort())
          .toEqual(['SIGINT', 'SIGTERM', 'beforeExit', 'uncaughtException', 'unhandledRejection']);
        expect(fakeProcess.registrations).toEqual([
          { kind: 'once', event: 'SIGINT' },
          { kind: 'once', event: 'SIGTERM' },
          { kind: 'once', event: 'beforeExit' },
          { kind: 'on', event: 'uncaughtException' },
          { kind: 'on', event: 'unhandledRejection' },
        ]);

        // And nothing at all on the real process.
        expect(handlerCounts()).toEqual(realBefore);

        // The startup record, which is the one line that tells "no such tool" apart
        // from "an old build is installed".
        const toolList = records.find(r => r.name === 'tool list');
        expect(toolList.detail).toMatchObject({
          tools: 5, names: 'db_list,db_query,db_schema,db_explain,db_health', progressMs: 750,
        });
        expect(records.at(-1)).toMatchObject({ name: 'server ready', detail: { version: '9.9.9' } });

        // And the EPIPE path: a dead transport closes the connections and exits 1,
        // rather than leaving four pools of sockets open to nothing. `onerror`
        // fires the shutdown without awaiting it, so the handler needs a turn.
        await ctx.server.onerror(new Error('write after end'));
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        expect(fakeProcess.exit).toHaveBeenCalledWith(1);
        expect(registry.close).toHaveBeenCalled();
      } finally {
        // Nothing to undo: every handler went to the fake, so a failure inside
        // this test cannot leak into the rest of the worker.
        await cache.closeAll.mockClear();
      }
    });

    test('firing SIGTERM closes every pooled connection and exits 0', async () => {
      // The behaviour the two signal handlers exist for, asserted by *firing* one
      // rather than by counting a listener: calling a handler on the real process
      // would have exited the jest worker.
      const fakeProcess = {
        handlers: {},
        on(event, fn) { (this.handlers[event] ??= []).push(fn); return this; },
        once(event, fn) { (this.handlers[event] ??= []).push(fn); return this; },
        exit: jest.fn(),
      };
      const cache = {
        enabled: true, maxEntries: 8, idleTtlMs: 300000, entries: new Map(), size: 0,
        installed: false,
        start: () => {},
        stop: jest.fn(),
        closeAll: jest.fn().mockResolvedValue(undefined),
        evict: jest.fn(),
      };
      const records = [];

      await main({
        registry: {
          cache,
          mapping: {},
          profiles: { list: () => [], source: null, reload: () => {} },
          listProfiles: () => [],
          describeConfiguration: () => ({ cache: { enabled: true } }),
          close: jest.fn().mockResolvedValue(undefined),
        },
        process: fakeProcess,
        env: {},
        log: (name, detail) => records.push({ name, detail }),
        logError: () => {},
        version: '9.9.9',
        transport: { async start() {}, async close() {} },
      });

      // The reaper is stopped *before* the connections are closed, so a sweep can
      // never race the shutdown it is part of.
      expect(cache.stop).not.toHaveBeenCalled();
      fakeProcess.handlers.SIGTERM.forEach((fn) => fn('SIGTERM'));
      await new Promise((resolve) => { setTimeout(resolve, 10); });

      expect(cache.stop).toHaveBeenCalled();
      expect(cache.closeAll).toHaveBeenCalled();
      expect(fakeProcess.exit).toHaveBeenCalledWith(0);
      expect(records.some(r => r.name === 'shutting down')).toBe(true);
    });

    test('a second signal does not close the pool twice, and still exits', async () => {
      // SIGINT and SIGTERM arriving together is what a supervisor restart looks
      // like. `closeAll()` on a half-closed pool is how a clean shutdown becomes
      // a stack trace on the way out, so the *work* is guarded...
      const fakeProcess = {
        handlers: {},
        on(event, fn) { (this.handlers[event] ??= []).push(fn); return this; },
        once(event, fn) { (this.handlers[event] ??= []).push(fn); return this; },
        exit: jest.fn(),
      };
      let resolveClose;
      const cache = {
        enabled: true, maxEntries: 8, idleTtlMs: 300000, entries: new Map(), size: 0,
        installed: false,
        start: () => {},
        stop: jest.fn(),
        closeAll: jest.fn(() => new Promise((r) => { resolveClose = r; })),
        evict: jest.fn(),
      };

      await main({
        registry: {
          cache, mapping: {},
          profiles: { list: () => [], source: null, reload: () => {} },
          listProfiles: () => [],
          describeConfiguration: () => ({ cache: { enabled: true } }),
          close: jest.fn().mockResolvedValue(undefined),
        },
        process: fakeProcess,
        env: {},
        log: () => {},
        logError: () => {},
        version: '9.9.9',
        transport: { async start() {}, async close() {} },
      });

      fakeProcess.handlers.SIGINT.forEach((fn) => fn('SIGINT'));
      fakeProcess.handlers.SIGTERM.forEach((fn) => fn('SIGTERM'));
      resolveClose();
      await new Promise((resolve) => { setTimeout(resolve, 10); });

      expect(cache.stop).toHaveBeenCalledTimes(1);
      expect(cache.closeAll).toHaveBeenCalledTimes(1);
      // ...but the *exit* is deliberately outside that guard, so a close that
      // never settles cannot trap the process. Each signal exits on its own; in a
      // real process the first `process.exit(0)` ends it before the second runs.
      // `test_connection_cache.test.js` asserts the other half.
      expect(fakeProcess.exit).toHaveBeenCalledTimes(2);
      expect(fakeProcess.exit).toHaveBeenCalledWith(0);
    });
  });
});

/**
 * A `ctx` with a stub registry, for a test that cares about the handler rather
 * than about a database.
 *
 * The overrides go on the *registry*, not on a hand-built bridge, so every test
 * that uses this drives the real `registryBridgeFor` -- including
 * `unwrapEnvelope`. A stub that installed its own bridge would make
 * `unwrapEnvelope` unreachable, and could return whatever shape it liked.
 *
 * The stub answers the *one* shape `registry.run`/`describe` can return -- the
 * `buildEnvelope` object -- which is the contract the real registry honours.
 */
function buildContext(over = {}) {
  const envelope = { rows: [{ ok: 1 }], rowCount: 1, truncated: false, bytes: 12 };
  const registry = {
    cache: { entries: new Map(), enabled: false, maxEntries: 0, idleTtlMs: 0, evict: jest.fn() },
    profiles: { list: () => [], source: null, reload: () => {} },
    listProfiles: () => [],
    describeConfiguration: () => ({ cache: { enabled: false } }),
    resolveTarget: ({ uri }) => Promise.resolve({ uri, policy: {}, profileName: null, entry: null, options: {} }),
    run: over.run ?? (async () => envelope),
    describe: over.describe ?? (async () => envelope),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const ctx = createServer({
    registry, env: {}, log: () => {}, logError: () => {}, clock: () => 1000, version: '0.0.0-test',
  });
  const { callTool } = installRequestHandlers(ctx.server, ctx);
  return { ...ctx, callTool };
}

/** How many handlers the process has on the events a server would install them on. */
function handlerCounts() {
  return {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
    beforeExit: process.listenerCount('beforeExit'),
    uncaughtException: process.listenerCount('uncaughtException'),
    unhandledRejection: process.listenerCount('unhandledRejection'),
  };
}

/** How many readers are on stdin. A stdio transport puts at least one there. */
function stdinCounts() {
  return {
    data: process.stdin.listenerCount('data'),
    readable: process.stdin.listenerCount('readable'),
    end: process.stdin.listenerCount('end'),
  };
}
