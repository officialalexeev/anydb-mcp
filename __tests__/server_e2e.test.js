import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = join(process.cwd(), 'src', 'index.js');
const sqliteUri = (name) => `sqlite://${join(process.cwd(), name).replace(/\\/g, '/')}`;

/**
 * The tool names this server exposes, in the order `tools/list` returns them.
 * Written out rather than imported: the point of these tests is to pin the
 * public surface, and a test that reads its expectation out of the same constant
 * it is checking cannot fail when that constant changes.
 */
const TOOL_NAMES = ['db_list', 'db_query', 'db_schema', 'db_explain', 'db_health'];

describe('MCP server end to end', () => {
  let client;
  let stderr;
  let tempDirs;

  beforeAll(async () => {
    stderr = [];
    tempDirs = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      cwd: process.cwd(),
      stderr: 'pipe'
    });
    transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
    } catch (error) {
      // A handshake that failed must not leave the child running for the rest of
      // the run, holding a reaper and every connection it has cached. Closing the
      // transport is enough: `StdioClientTransport` owns the child.
      await transport.close().catch(() => {});
      throw error;
    }
    // 60s, and the reason is measured rather than guessed. Spawning this child
    // is a `node src/index.js` cold start whose cost is dominated by loading the
    // `pg`, `mongodb` and `redis` drivers for five tools that answer from SQLite
    // and never open a socket. On a 4-core box that handshake measured 1.3s idle
    // and 5.5s with 8 competing processes. It is a budget for "a cold start on a
    // busy CI runner", not a performance target.
  }, 60000);

  afterAll(async () => {
    // The child is closed first, so every SQLite handle it holds is released
    // before the directories are removed. On Windows the other order leaves the
    // files locked and `rm` fails, which is how temp directories accumulate.
    await client?.close();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })
      .catch(() => {})));
  });

  /** A temp directory that is removed when the suite ends, however it ends. */
  const tempDir = async (prefix) => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  const call = async (args) => {
    const res = await client.callTool({ name: 'db_query', arguments: args });
    return { isError: !!res.isError, text: res.content?.[0]?.text ?? '', structured: res.structuredContent };
  };

  const schemaCall = async (args) => {
    const res = await client.callTool({ name: 'db_schema', arguments: args });
    return { isError: !!res.isError, text: res.content?.[0]?.text ?? '', structured: res.structuredContent };
  };

  const toolCall = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, text: res.content?.[0]?.text ?? '', structured: res.structuredContent };
  };

  const tool = async (name) => (await client.listTools()).tools.find((t) => t.name === name);

  describe('handshake', () => {
    test('advertises all five tools', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    });

    test('reports the package version', async () => {
      const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
      expect(client.getServerVersion().version).toBe(version);
    });

    test('sends instructions in the initialize result', () => {
      // The one piece of text every model is guaranteed to read.
      const instructions = client.getInstructions();
      expect(typeof instructions).toBe('string');
      expect(instructions.length).toBeGreaterThan(200);
      expect(instructions).toMatch(/read-only by default/i);
      expect(instructions).toMatch(/db_list/);
      expect(instructions).toMatch(/db_schema/);
      expect(instructions).toMatch(/profile/i);
      expect(instructions).toMatch(/params/i);
      expect(instructions).toMatch(/LIMIT/);
    });

    test('every tool has a title, annotations and an outputSchema', async () => {
      const { tools } = await client.listTools();
      for (const t of tools) {
        expect(typeof t.title).toBe('string');
        expect(t.title.length).toBeGreaterThan(0);
        expect(t.outputSchema).toMatchObject({ type: 'object' });
        expect(t.annotations).toMatchObject({
          readOnlyHint: expect.any(Boolean),
          destructiveHint: expect.any(Boolean),
          idempotentHint: expect.any(Boolean),
          openWorldHint: expect.any(Boolean),
        });
      }
    });

    test('the read-only tools say so and db_query does not', async () => {
      const byName = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
      for (const name of ['db_list', 'db_schema', 'db_explain', 'db_health']) {
        expect(byName[name].annotations.readOnlyHint).toBe(true);
      }
      expect(byName.db_query.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
    });

    test('db_query declares every argument', async () => {
      const q = await tool('db_query');
      expect(Object.keys(q.inputSchema.properties).sort()).toEqual([
        'action', 'allowDestructive', 'allowWriteStages', 'collection', 'cursor', 'document', 'field', 'format',
        'limit', 'maxBytes', 'maxRows', 'offset', 'params', 'profile', 'projection', 'query', 'readOnly',
        'sort', 'timeout', 'update', 'upsert', 'uri'
      ]);
      // `profile` and `uri` are "exactly one of", which `required` cannot express,
      // so only `query` is listed.
      expect(q.inputSchema.required).toEqual(['query']);
      expect(q.inputSchema.additionalProperties).toBe(false);
    });

    test('db_schema, db_explain and db_health declare only what they use', async () => {
      expect(Object.keys((await tool('db_schema')).inputSchema.properties).sort())
        .toEqual(['collection', 'detail', 'profile', 'table', 'timeout', 'uri']);
      // `collection` is here for MongoDB: an explain is a find on one collection,
      // and without it `db_explain` had a MongoDB branch that could never be
      // reached -- `validateArgs` refused the argument before the handler saw it.
      expect(Object.keys((await tool('db_explain')).inputSchema.properties).sort())
        .toEqual(['collection', 'params', 'profile', 'query', 'timeout', 'uri']);
      expect(Object.keys((await tool('db_health')).inputSchema.properties).sort())
        .toEqual(['profile', 'timeout', 'uri']);
      expect((await tool('db_list')).inputSchema.properties).toEqual({});
    });

    test('enumerates every MongoDB action the tool exposes', async () => {
      const q = await tool('db_query');
      // Eleven, in one order, matching `core/tools.js`. The single-document
      // actions (`updateOne`, `replace`, `deleteOne`) were implemented in the
      // adapter but unreachable from the tool, so the safety argument for
      // `deleteOne` over `deleteMany({})` never reached a model.
      expect(q.inputSchema.properties.action.enum).toEqual([
        'find', 'count', 'distinct', 'aggregate', 'explain', 'insert', 'update', 'updateOne', 'replace',
        'delete', 'deleteOne'
      ]);
      // Every enum value has to be *described* too; `test_tools.test.js` is the
      // other half of this.
      expect(q.description).toMatch(/explain/);
      for (const action of ['updateOne', 'replace', 'deleteOne']) {
        expect(q.description).toContain(action);
      }
    });

    test('states the result formats and the two write gates', async () => {
      const q = await tool('db_query');
      expect(q.inputSchema.properties.format.enum).toEqual(['json', 'jsonl', 'csv', 'tsv', 'markdown']);
      expect(q.inputSchema.properties.readOnly.default).toBe(true);
      expect(q.inputSchema.properties.allowDestructive.default).toBe(false);
      expect(q.description).toMatch(/read-?only by default/i);
    });
  });

  describe('unknown names and unknown arguments', () => {
    // The SDK validates the request envelope but never the tool name, so an
    // unknown name has to be refused explicitly.
    test('an unknown tool name is refused, not executed', async () => {
      const dir = await tempDir('anydb-unknown-tool-');
      const uri = `sqlite://${join(dir, 'u.db').replace(/\\/g, '/')}`;

      const { isError, text, structured } = await toolCall('db_exec', {
        uri,
        query: 'CREATE TABLE should_not_exist (a INT)'
      });

      expect(isError).toBe(true);
      expect(text).toMatch(/UNKNOWN_TOOL/);
      expect(text).toMatch(/Nothing was executed/);
      expect(structured.error.kind).toBe('validation');

      // The proof that nothing ran: the table the statement would have created is
      // not there. A file database rather than `:memory:`, so a `CREATE TABLE`
      // that *did* run would persist and be visible to `db_schema`.
      const described = await schemaCall({ uri });
      expect(described.isError).toBe(false);
      expect(JSON.parse(described.text).tables).toEqual([]);
    });

    test('an unknown argument is refused', async () => {
      // `additionalProperties: false` is declared on the schema; this asserts it
      // is also enforced.
      const { isError, text, structured } = await call({
        uri: 'sqlite://:memory:', query: 'SELECT 1', bogus: 'x'
      });

      expect(isError).toBe(true);
      expect(text).toMatch(/^DATABASE_ERROR:/);
      expect(text).toMatch(/Unknown argument "bogus"/);
      expect(text).toMatch(/It takes: /);
      expect(structured.error.kind).toBe('validation');
    });

    test('db_list takes no arguments at all', async () => {
      const { isError, text } = await toolCall('db_list', { anything: 1 });
      expect(isError).toBe(true);
      expect(text).toMatch(/Unknown argument "anything"/);
    });

    test('every problem is reported, not just the first', async () => {
      const { text, structured } = await call({ query: 123, timeout: -1 });
      expect(structured.error.details.length).toBeGreaterThan(1);
      expect(text).toMatch(/"query"/);
      expect(text).toMatch(/"timeout"/);
    });
  });

  describe('choosing a target', () => {
    test('both profile and uri is an error', async () => {
      const { isError, text } = await call({
        uri: 'sqlite://:memory:', profile: 'anything', query: 'SELECT 1'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/not both/);
    });

    test('neither profile nor uri is an error', async () => {
      const { isError, text } = await call({ query: 'SELECT 1' });
      expect(isError).toBe(true);
      expect(text).toMatch(/Give one of "profile" or "uri"/);
    });

    test('a profile name that does not exist names the ones that do', async () => {
      const { isError, text } = await call({ profile: 'nope', query: 'SELECT 1' });
      expect(isError).toBe(true);
      expect(text).toMatch(/^DATABASE_ERROR:/);
    });
  });

  describe('db_list', () => {
    test('works with no config file and says so', async () => {
      const { isError, text, structured } = await toolCall('db_list', {});

      // The suite runs with no `~/.anydb/db.json` unless one is on the machine,
      // so this asserts the *shape* of the answer and, where the list is empty,
      // that the model is told what to do instead.
      expect(isError).toBe(false);
      expect(Array.isArray(structured.profiles)).toBe(true);
      expect('configSource' in structured).toBe(true);

      if (structured.profiles.length === 0) {
        expect(text).toMatch(/no profiles/i);
        expect(text).toMatch(/"uri"/);
        expect(structured.configSource).toBeNull();
      }
    });

    test('never carries a connection string, a host or a credential', async () => {
      const { structured } = await toolCall('db_list', {});
      for (const profile of structured.profiles) {
        expect(Object.keys(profile).sort()).toEqual(['default', 'description', 'driver', 'name', 'readOnly']);
        const text = JSON.stringify(profile);
        expect(text).not.toMatch(/:\/\//);
        expect(text).not.toMatch(/@/);
      }
    });

    test('lists a profile without disclosing its URI', async () => {
      const dir = await tempDir('anydb-profiles-');
      const config = join(dir, 'db.json');
      await writeFile(config, JSON.stringify({
        default: 'local',
        profiles: {
          local: { driver: 'sqlite', path: 'app.db', description: 'a local file', readOnly: true },
        },
      }));

      // A second server, started against this config: the one in `beforeAll` was
      // launched before the file existed, and reloading it there would race the
      // rest of the suite.
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        cwd: process.cwd(),
        stderr: 'pipe',
        env: { ...process.env, ANYDB_CONFIG: config }
      });
      const scoped = new Client({ name: 'profile-client', version: '1.0.0' }, { capabilities: {} });
      // `connect` is INSIDE the try, and that is the point of the test. Outside,
      // a failed or timed-out handshake left the child running for the rest of
      // the suite: a `node src/index.js` with a live cache reaper and a SQLite
      // handle on `app.db`, inside a temp directory `afterAll` then cannot
      // remove. Every such failure leaks one more server. `Client.connect`
      // assigns `_transport` before it can throw, so `close()` reaches the child
      // even when the handshake never completed.
      try {
        await scoped.connect(transport);

        const listed = await scoped.callTool({ name: 'db_list', arguments: {} });
        const body = listed.structuredContent;
        expect(body.configSource).toBe(config);
        expect(body.profiles).toEqual([{
          name: 'local',
          description: 'a local file',
          driver: 'sqlite',
          default: true,
          readOnly: true,
        }]);
        expect(JSON.stringify(body)).not.toContain('sqlite://');

        // And the profile is usable, by name, with no URI in the transcript.
        const viaProfile = await scoped.callTool({
          name: 'db_query', arguments: { profile: 'local', query: 'SELECT 1 AS ok' }
        });
        expect(viaProfile.isError).toBeFalsy();
        expect(JSON.parse(viaProfile.content[0].text)).toEqual([{ ok: 1 }]);
        expect(viaProfile.structuredContent.profile).toBe('local');

        const unknown = await scoped.callTool({
          name: 'db_query', arguments: { profile: 'missing', query: 'SELECT 1' }
        });
        expect(!!unknown.isError).toBe(true);
        expect(unknown.content[0].text).toMatch(/local/);
      } finally {
        await scoped.close().catch(() => {});
      }
    }, 60000);
  });

  describe('malformed arguments', () => {
    // Each of these used to escape the handler as an internal error.
    test.each([
      ['a missing query', { uri: 'sqlite://:memory:' }],
      ['a numeric query', { uri: 'sqlite://:memory:', query: 123 }],
      ['a null query', { uri: 'sqlite://:memory:', query: null }],
      ['a missing target', { query: 'SELECT 1' }],
      ['a numeric uri', { uri: 5, query: 'SELECT 1' }],
      ['a null uri', { uri: null, query: 'SELECT 1' }],
      ['an empty uri', { uri: '', query: 'SELECT 1' }],
      ['a whitespace query', { uri: 'sqlite://:memory:', query: '   ' }],
      ['no arguments at all', {}]
    ])('reports %s as a tool error', async (_label, args) => {
      const { isError, text } = await call(args);
      expect(isError).toBe(true);
      expect(text).toMatch(/^DATABASE_ERROR:/);
    });

    test('survives a malformed request', async () => {
      await call({ uri: 'sqlite://:memory:' });
      const { isError, text } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1 AS ok' });
      expect(isError).toBe(false);
      expect(JSON.parse(text)).toEqual([{ ok: 1 }]);
    });
  });

  describe('read-only enforcement', () => {
    test.each([
      ['sqlite://:memory:', 'DROP TABLE users'],
      ['sqlite://:memory:', 'INSERT INTO t (a) VALUES (1)'],
      ['sqlite://:memory:', 'DELETE FROM t'],
      ['sqlite://:memory:', 'UPDATE t SET a = 1'],
      ['sqlite://:memory:', 'CREATE TABLE t (a INT)'],
      ['sqlite://:memory:', 'ALTER TABLE t ADD COLUMN b INT'],
      ['postgres://u:p@h:5432/d', 'TRUNCATE users']
    ])('blocks %s %s', async (uri, query) => {
      const { isError, text } = await call({ uri, query });
      expect(isError).toBe(true);
      expect(text).toMatch(/Read-only mode/);
    });

    test('names the way out', async () => {
      const { text } = await call({ uri: 'sqlite://:memory:', query: 'DROP TABLE t' });
      expect(text).toMatch(/readOnly:\s*false/);
    });

    test('allows a read', async () => {
      const { isError, text } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1 AS a' });
      expect(isError).toBe(false);
      expect(JSON.parse(text)).toEqual([{ a: 1 }]);
    });

    test('does not read a write keyword in a table name as a write', async () => {
      const { text } = await call({ uri: 'sqlite://:memory:', query: 'SELECT * FROM created_orders' });
      expect(text).not.toMatch(/Read-only mode/);
      expect(text).toMatch(/no such table/i);
    });

    test('does not read a write keyword in a literal as a write', async () => {
      const { isError, text } = await call({
        uri: 'sqlite://:memory:', query: "SELECT 'DROP TABLE t' AS s"
      });
      expect(isError).toBe(false);
      expect(JSON.parse(text)).toEqual([{ s: 'DROP TABLE t' }]);
    });
  });

  describe('the destructive second gate', () => {
    // Two flags from the same caller in the same call is a weak boundary, and the
    // tool description says so. What it must do is name the flag that is missing.
    //
    // A file database, not `:memory:`: the whole suite shares one `:memory:`
    // connection, and a test that creates a table there changes the answer to
    // every later test that describes an "empty" database.
    let uri;
    beforeAll(async () => {
      const dir = await tempDir('anydb-gate-');
      uri = `sqlite://${join(dir, 'g.db').replace(/\\/g, '/')}`;
    });

    test('readOnly alone is not enough for DDL', async () => {
      const { isError, text, structured } = await call({
        uri, query: 'CREATE TABLE t (a INT)', readOnly: false
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/allowDestructive/);
      expect(structured.error.kind).toBe('destructive');
    });

    test('both flags run it', async () => {
      const { isError } = await call({
        uri, query: 'CREATE TABLE gate_t (a INT)', readOnly: false, allowDestructive: true
      });
      expect(isError).toBe(false);
    });

    test('a plain write needs only readOnly', async () => {
      await call({
        uri, query: 'CREATE TABLE gate_w (a INT)', readOnly: false, allowDestructive: true
      });
      const insert = await call({
        uri, query: 'INSERT INTO gate_w (a) VALUES (1)', readOnly: false
      });
      expect(insert.isError).toBe(false);
    });
  });

  describe('resilience', () => {
    // `src/adapters/sqlite.js` fails an unopenable path with SQLITE_CANTOPEN
    // naming the path and bounds the wait, so this original test is not
    // reinstated to time out at the 30s default.
    test('an unopenable SQLite path does not kill the server', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'anydb-'));
      const bad = join(dir, 'no-such-dir', 'x.db');
      const startedAt = Date.now();
      try {
        const { isError, text } = await call({
          uri: `sqlite:///${bad.replace(/\\/g, '/')}`, query: 'SELECT 1'
        });
        const elapsed = Date.now() - startedAt;

        expect(isError).toBe(true);
        expect(text).toMatch(/cannot open|CANTOPEN/i);

        // A *slow* failure here is a denial-of-service shape, not a slow test.
        // The one thing every caller can do with a bad path is send the statement
        // anyway, so a call costing the full 30s default budget per attempt turns
        // a typo into a 30x amplification. The failure should cost about what the
        // `open(2)` that produces it costs.
        //
        // The bound is loose on purpose: a *regression* guard against the hang,
        // not a performance target. The loopback filesystem, the CI runner and a
        // machine under a full jest fan-out are all slower than the developer's,
        // and a tight number would flake on exactly the loaded runs where a hang
        // is most likely to be mistaken for slowness. 5s is ~150x the measured
        // 41ms, so a return to the old behaviour cannot fit inside it.
        expect(elapsed).toBeLessThan(5000);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('a SQLite URI with no path is reported', async () => {
      const { isError } = await call({ uri: 'sqlite://', query: 'SELECT 1' });
      expect(isError).toBe(true);
      const after = await call({ uri: 'sqlite://:memory:', query: 'SELECT 3 AS alive' });
      expect(after.isError).toBe(false);
    });

    test('an unsupported protocol is reported', async () => {
      const { isError, text } = await call({ uri: 'oracle://host', query: 'SELECT 1' });
      expect(isError).toBe(true);
      expect(text).toMatch(/not supported/);
    });

    test('repeated failures leave the server usable', async () => {
      const dir = await tempDir('anydb-repeat-');
      const notADb = join(dir, 'nope.txt');
      await writeFile(notADb, 'text\n');

      for (const args of [
        { uri: 'nope', query: 'SELECT 1' },
        { uri: `sqlite:///${notADb.replace(/\\/g, '/')}`, query: 'SELECT name FROM sqlite_master' },
        { uri: 'sqlite://:memory:' },
        { uri: 'sqlite://:memory:', query: 'DROP TABLE t' },
        { uri: 'sqlite://:memory:', query: 'SELECT bad syntax FROM' },
        { uri: 'sqlite://:memory:', query: 'SELECT 1', nope: true },
        { uri: 'oracle://host', query: 'SELECT 1' }
      ]) {
        await call(args);
      }
      const { isError } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 9 AS ok' });
      expect(isError).toBe(false);
    });
  });

  describe('timeout argument', () => {
    test.each([
      ['zero', 0],
      ['negative', -1],
      ['above the cap', 86400001]
    ])('rejects %s', async (_label, timeout) => {
      const { isError, text } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1', timeout });
      expect(isError).toBe(true);
      // The schema now enforces the bound, and its message names the argument, the
      // bound and what arrived.
      expect(text).toMatch(/"timeout"/);
      expect(text).toMatch(new RegExp(String(Math.abs(timeout))));
    });

    test('rejects a string', async () => {
      const { isError, text } = await call({
        uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: '5000'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/"timeout"/);
      expect(text).toMatch(/whole number/);
    });

    test('treats an explicit null as the default', async () => {
      const { isError } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: null });
      expect(isError).toBe(false);
    });

    test('accepts a valid timeout', async () => {
      const { isError } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: 5000 });
      expect(isError).toBe(false);
    });

    // The statement that outruns its budget lives in `server_timeouts.test.js`,
    // in a server process of its own: SQLite cannot cancel a statement already
    // running in C, so an abandoned one taxes every test that follows it.
    test('refuses a timeout it cannot honour rather than pretending to', async () => {
      const { isError, text } = await call({
        uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: 86400000
      });
      expect(isError).toBe(false);
      expect(text).toBeDefined();
    });
  });

  describe('result shape', () => {
    test('a SELECT returns an array as text', async () => {
      const { text } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1 AS a UNION ALL SELECT 2' });
      const parsed = JSON.parse(text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    });

    test('the response carries structuredContent matching the outputSchema', async () => {
      const q = await tool('db_query');
      const { structured } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1 AS a' });

      // An object, not a bare array: the spec requires `structuredContent` to be
      // an object whenever a tool declares an `outputSchema`, and
      // `CallToolResultSchema` types it as a record.
      expect(structured).toBeInstanceOf(Object);
      expect(Array.isArray(structured)).toBe(false);
      for (const key of q.outputSchema.required) {
        expect(structured).toHaveProperty(key);
      }
      expect(structured.rows).toEqual([{ a: 1 }]);
      expect(structured.ok).toBe(true);
      expect(structured.format).toBe('json');
      expect(typeof structured.elapsedMs).toBe('number');
    });

    test('a failure also satisfies the outputSchema', async () => {
      const q = await tool('db_query');
      const { structured } = await call({ uri: 'sqlite://:memory:', query: 'DROP TABLE t' });
      for (const key of q.outputSchema.required) {
        expect(structured).toHaveProperty(key);
      }
      expect(structured.ok).toBe(false);
      expect(structured.error.kind).toBe('policy');
    });

    // The two error properties the schema declares. `ERROR_FIELD` in
    // `core/tools.js` promises `code` and `operation`; `errorField()` returns
    // `{ kind, message, suggestion }`, so a client that generated a type from
    // `outputSchema` had two fields that were `undefined` in every real response.
    test('the error object carries the two fields the schema declares', async () => {
      const q = await tool('db_query');
      const declared = Object.keys(q.outputSchema.properties.error.properties).sort();
      // A guard on the schema itself: if `ERROR_FIELD` grows or loses a field,
      // the next assertion below stops proving what it says it proves.
      expect(declared).toEqual(['code', 'details', 'kind', 'message', 'operation', 'suggestion']);

      // A policy refusal, which is the commonest failure and the one with a code.
      const refused = await call({ uri: 'sqlite://:memory:', query: 'DROP TABLE t' });
      expect(refused.structured.error).toMatchObject({ code: 'READ_ONLY', operation: 'db_query' });

      // And a driver failure, where the code is the driver's own and is the
      // whole point: `SQLITE_ERROR` is stable, the message is not.
      const { isError, text, structured } = await call({
        uri: 'sqlite://:memory:', query: 'SELECT * FROM no_such_table'
      });
      expect(isError).toBe(true);
      expect(structured.error.code).toBe('SQLITE_ERROR');
      expect(structured.error.operation).toBe('db_query');
      // Present on the object rather than absent, so a client reads it directly.
      expect('code' in structured.error).toBe(true);
      expect('operation' in structured.error).toBe(true);
    });

    test('the code is in the text block, in brackets, after the message', async () => {
      // `structuredContent` is a machine field. A model reads the text block, and
      // the driver code is the one part of an error that is the same in every
      // language, every driver version and every translation of the prose around
      // it -- so it has to be there too.
      const { text, structured } = await call({ uri: 'sqlite://:memory:', query: 'DROP TABLE t' });
      expect(text).toMatch(/^DATABASE_ERROR: Read-only mode[\s\S]*\[READ_ONLY\]/);
      expect(text).toMatch(/^DATABASE_ERROR: ([^\n]*\[READ_ONLY\])\nSUGGESTION: /);
      // Appended, not hoisted, so a client that splits on the newline and reads
      // line 1 gets the message and the code together.
      const [first, second] = text.split('\n');
      expect(first.startsWith('DATABASE_ERROR: ')).toBe(true);
      expect(first.endsWith('[READ_ONLY]')).toBe(true);
      expect(second).toMatch(/^SUGGESTION: /);
      expect(structured.error.code).toBe('READ_ONLY');
    });

    test('every failure path reports both fields, whichever way it failed', async () => {
      // Six different refusals, six different places to raise them, one shape. A
      // per-path check is what stops one path quietly building its own error
      // object again.
      const failures = [
        ['db_query', { uri: 'sqlite://:memory:', query: 'DROP TABLE t' }],
        ['db_query', { uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: -1 }],
        ['db_query', { query: 123, timeout: -1 }],
        ['db_query', { uri: 'sqlite://:memory:' }],
        ['db_query', { uri: 'sqlite://:memory:', query: 'SELECT * FROM missing_table' }],
        ['db_query', { uri: 'oracle://host', query: 'SELECT 1' }],
        ['db_schema', { uri: 'sqlite://:memory:', table: 't', detail: 'nope' }],
        ['db_explain', { uri: 'redis://127.0.0.1:1', query: 'GET k' }],
        ['db_health', { uri: 'mysql://root:root@127.0.0.1:3999/x', timeout: 2000 }],
      ];

      for (const [name, args] of failures) {
        const { isError, structured } = await toolCall(name, args);
        expect(isError).toBe(true);
        const error = structured.error;
        expect(error).toBeDefined();
        // Declared, present, and of the declared shape. `null` is a value;
        // `undefined` is an absent property, which is the bug.
        expect('code' in error).toBe(true);
        expect('operation' in error).toBe(true);
        expect(error.code === null || typeof error.code === 'string' || typeof error.code === 'number').toBe(true);
        expect(error.operation === null || typeof error.operation === 'string').toBe(true);
      }
    });

    test('a validation failure the schema catches reports null, not a missing field', async () => {
      // Nothing reached a database, so there is no driver code and no registry
      // operation to name. Both fields are still *there*.
      const { structured } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1', bogus: 'x' });
      expect(structured.error.kind).toBe('validation');
      expect(structured.error.code).toBeNull();
      expect(structured.error.operation).toBeNull();
    });

    test('an unknown tool name produces the same error shape as a database failure', async () => {
      // It was a hand-written literal, which is how two declared fields came to be
      // missing from every response: the one failure built outside `errorField`.
      const { structured } = await toolCall('db_exec', { uri: 'sqlite://:memory:', query: 'SELECT 1' });
      expect(Object.keys(structured.error).sort())
        .toEqual(['code', 'kind', 'message', 'operation', 'suggestion']);
      expect(structured.error.code).toBeNull();
      expect(structured.error.operation).toBeNull();
    });

    test.each([
      ['csv', '1,2'],
      ['tsv', '1\t2'],
      ['jsonl', '{"a":1,"b":2}']
    ])('format %s renders as text', async (format, expected) => {
      const { text, structured } = await call({
        uri: 'sqlite://:memory:', query: 'SELECT 1 AS a, 2 AS b', format
      });
      expect(text).toContain(expected);
      expect(structured.format).toBe(format);
      // The structured result is identical whatever the rendering: the format
      // changes how it is presented, not what it says.
      expect(structured.rows).toEqual([{ a: 1, b: 2 }]);
    });

    test('an unknown format is refused rather than ignored', async () => {
      const { isError, text } = await call({
        uri: 'sqlite://:memory:', query: 'SELECT 1', format: 'yaml'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/format/);
    });

    test('a result limit says whether it cut anything', async () => {
      const { structured } = await call({
        uri: 'sqlite://:memory:',
        query: 'SELECT 1 AS a UNION ALL SELECT 2 UNION ALL SELECT 3',
        // A byte limit rather than a row limit, because the row cap is applied by
        // the adapter before the registry sees the rows, and a result that
        // arrived already short is indistinguishable from a complete one. The
        // byte cap is applied by `clampResult`, so `truncated` is a fact.
        maxBytes: 1
      });

      expect(structured.truncated).toBe(true);
      expect(structured.limitReason).toBe('maxBytes');
      expect(typeof structured.hint).toBe('string');
      expect(structured.hint).toMatch(/prefix of the answer/);
      expect(structured.rowCount).toBe(structured.rows.length);
    });

    test('maxRows caps the rows that come back', async () => {
      const { structured } = await call({
        uri: 'sqlite://:memory:',
        query: 'SELECT 1 AS a UNION ALL SELECT 2 UNION ALL SELECT 3',
        maxRows: 2
      });
      expect(structured.rows).toHaveLength(2);
      expect(structured.rowCount).toBe(2);
    });
  });

  describe('params', () => {
    test('a bound value round-trips without entering the statement', async () => {
      const { isError, text, structured } = await call({
        uri: 'sqlite://:memory:',
        query: 'SELECT ? AS bound',
        params: ['a-very-distinctive-value']
      });

      expect(isError).toBe(false);
      expect(JSON.parse(text)).toEqual([{ bound: 'a-very-distinctive-value' }]);
      expect(structured.rows).toEqual([{ bound: 'a-very-distinctive-value' }]);
    });

    test('a bound value is not pasted into the statement', async () => {
      // If the server interpolated, this would be a syntax error or a different
      // result, because the literal is not valid SQL on its own.
      const { isError, text } = await call({
        uri: 'sqlite://:memory:',
        query: 'SELECT ? AS bound',
        params: ["'; DROP TABLE t; --"]
      });
      expect(isError).toBe(false);
      expect(JSON.parse(text)).toEqual([{ bound: "'; DROP TABLE t; --" }]);

      const after = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1 AS alive' });
      expect(after.isError).toBe(false);
    });

    test('params that are not an array are refused', async () => {
      const { isError, text } = await call({
        uri: 'sqlite://:memory:', query: 'SELECT 1', params: 'nope'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/params/);
    });
  });

  describe('db_schema', () => {
    test('describes a SQLite database', async () => {
      const dir = await tempDir('anydb-schema-');
      const uri = `sqlite://${join(dir, 's.db').replace(/\\/g, '/')}`;

      await call({
        uri, query: 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
        readOnly: false, allowDestructive: true
      });
      await call({
        uri, query: 'CREATE VIEW v AS SELECT id FROM t',
        readOnly: false, allowDestructive: true
      });

      const { isError, text } = await schemaCall({ uri });
      expect(isError).toBe(false);

      const parsed = JSON.parse(text);
      expect(parsed.database).toBe('sqlite');
      const table = parsed.tables.find((t) => t.name === 't');
      expect(table.columns.map((c) => c.name)).toEqual(['id', 'name']);
      expect(table.columns[1]).toMatchObject({ nullable: false });
      expect(table.columns[0]).toMatchObject({ primaryKey: true });
      expect(parsed.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['v']));
    });

    // `detail` is `schema.js`'s two-level contract, and it validates the argument
    // itself, so what is asserted here is that this server declares, forwards and
    // accepts it. Producing the `full` catalogue is `src/core/schema.js`'s to own.
    test('accepts and forwards the detail argument', async () => {
      const dir = await tempDir('anydb-schema-detail-');
      const uri = `sqlite://${join(dir, 's.db').replace(/\\/g, '/')}`;
      await call({
        uri, query: 'CREATE TABLE full_t (id INTEGER PRIMARY KEY)', readOnly: false, allowDestructive: true
      });

      const { isError, structured, text } = await schemaCall({ uri, table: 'full_t', detail: 'summary' });
      expect(isError).toBe(false);
      expect(structured.detail).toBe('summary');
      // The value reached the driver, not just this server: the description
      // echoes it back.
      expect(JSON.parse(text).detail).toBe('summary');
    });

    test('rejects an unknown detail', async () => {
      const { isError, text } = await schemaCall({ uri: 'sqlite://:memory:', detail: 'everything' });
      expect(isError).toBe(true);
      expect(text).toMatch(/"detail"/);
      expect(text).toMatch(/summary, full/);
    });

    test('describes a single table', async () => {
      const dir = await tempDir('anydb-schema-');
      const uri = `sqlite://${join(dir, 's.db').replace(/\\/g, '/')}`;

      await call({ uri, query: 'CREATE TABLE a (x INT)', readOnly: false, allowDestructive: true });
      await call({ uri, query: 'CREATE TABLE b (y INT)', readOnly: false, allowDestructive: true });

      const { text } = await schemaCall({ uri, table: 'a' });
      expect(JSON.parse(text).tables.map((t) => t.name)).toEqual(['a']);
    });

    test('an empty database yields an empty report', async () => {
      const { isError, text } = await schemaCall({ uri: 'sqlite://:memory:' });
      expect(isError).toBe(false);
      expect(JSON.parse(text)).toMatchObject({ database: 'sqlite', tables: [] });
    });

    test.each([
      ['a missing target', {}],
      ['an unsupported protocol', { uri: 'oracle://h' }],
      ['a non-string table', { uri: 'sqlite://:memory:', table: 5 }],
      ['an unknown argument', { uri: 'sqlite://:memory:', nope: 1 }]
    ])('reports %s as a tool error', async (_label, args) => {
      const { isError, text } = await schemaCall(args);
      expect(isError).toBe(true);
      expect(text).toMatch(/^DATABASE_ERROR:/);
    });

    test('an unreachable database does not take the server down', async () => {
      const { isError } = await schemaCall({ uri: 'mysql://root:root@127.0.0.1:3999/x', timeout: 2000 });
      expect(isError).toBe(true);

      const after = await call({ uri: 'sqlite://:memory:', query: 'SELECT 7 AS alive' });
      expect(after.isError).toBe(false);
    });

    test('ignores a table name that is not a real identifier', async () => {
      const { isError, text } = await schemaCall({ uri: 'sqlite://:memory:', table: 'DROP TABLE x' });
      expect(isError).toBe(false);
      expect(text).not.toMatch(/Read-only mode/);
      expect(JSON.parse(text).tables).toEqual([]);
    });
  });

  describe('db_explain', () => {
    test('returns a plan without running the statement', async () => {
      const { isError, text, structured } = await toolCall('db_explain', {
        uri: 'sqlite://:memory:', query: 'SELECT 1 AS a'
      });
      expect(isError).toBe(false);
      expect(Array.isArray(structured.rows)).toBe(true);
      expect(structured.rows.length).toBeGreaterThan(0);
      expect(text).toMatch(/detail/);
    });

    test('refuses EXPLAIN ANALYZE, which executes what it plans', async () => {
      for (const query of ['EXPLAIN ANALYZE SELECT 1', 'EXPLAIN (ANALYZE, BUFFERS) SELECT 1']) {
        const { isError, text } = await toolCall('db_explain', { uri: 'sqlite://:memory:', query });
        expect(isError).toBe(true);
        expect(text).toMatch(/ANALYZE/);
        expect(text).toMatch(/executes the statement it plans/);
      }
    });

    test('refuses a statement that already carries the prefix', async () => {
      const { isError, text } = await toolCall('db_explain', {
        uri: 'sqlite://:memory:', query: 'EXPLAIN SELECT 1'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/already begins with EXPLAIN/);
    });

    test('refuses Redis, which has no plan', async () => {
      const { isError, text } = await toolCall('db_explain', {
        uri: 'redis://127.0.0.1:1', query: 'GET k'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/no execution plan/i);
    });

    test('a Mongo explain is now reachable: collection is accepted and nothing is prefixed', async () => {
      // The `db_explain` MongoDB branch reads `args.collection`, and `collection`
      // was not in this tool's schema, so `validateArgs` refused the argument
      // before the handler saw it. The observable proof is that the *schema* no
      // longer refuses it and the call gets as far as the connect. There is no
      // MongoDB server here, so the call fails at connect -- which is the point:
      // it is a database failure now, not an argument failure, and the two have
      // different advice.
      const { isError, text, structured } = await toolCall('db_explain', {
        uri: 'mongodb://127.0.0.1:1/x', query: '{"a":1}', collection: 'users', timeout: 2000
      });
      expect(isError).toBe(true);
      // Not "Unknown argument \"collection\"" any more.
      expect(text).not.toMatch(/Unknown argument/);
      expect(structured.error.kind).not.toBe('validation');
      // And the collection requirement is still enforced when it is absent.
      const missing = await toolCall('db_explain', {
        uri: 'mongodb://127.0.0.1:1/x', query: '{"a":1}', timeout: 2000
      });
      expect(missing.isError).toBe(true);
      expect(missing.text).toMatch(/collection/i);
      expect(missing.structured.error.kind).toBe('validation');
    });
  });

  describe('db_health', () => {
    test('reports on a reachable database', async () => {
      const { isError, text, structured } = await toolCall('db_health', { uri: 'sqlite://:memory:' });

      expect(isError).toBe(false);
      expect(structured.reachable).toBe(true);
      expect(structured.database).toBe('sqlite');
      expect(typeof structured.serverVersion).toBe('string');
      expect(structured.pool).toMatchObject({ enabled: expect.any(Boolean) });
      expect(structured.checks.length).toBeGreaterThan(0);
      for (const check of structured.checks) {
        expect(check).toMatchObject({ name: expect.any(String), ok: expect.any(Boolean), detail: expect.any(String) });
      }
      expect(text).toMatch(/"checks"/);
    });

    test('reports an unreachable one without throwing', async () => {
      const { isError, structured } = await toolCall('db_health', {
        uri: 'mysql://root:root@127.0.0.1:3999/x', timeout: 2000
      });
      expect(isError).toBe(true);
      expect(structured.reachable).toBe(false);
      expect(structured.checks.some((c) => !c.ok)).toBe(true);

      const after = await call({ uri: 'sqlite://:memory:', query: 'SELECT 8 AS alive' });
      expect(after.isError).toBe(false);
    });
  });

  describe('MongoDB arguments', () => {
    test('requires a collection', async () => {
      const { isError, text } = await call({
        uri: 'mongodb://127.0.0.1:27017/x', query: '{}', action: 'count'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/collection/i);
    });

    test('rejects an unknown action before connecting', async () => {
      // The schema's `enum` catches this, which is a better message than the
      // registry's and arrives before any file or socket is touched. The whole
      // list is in the message, so the model is told what it could have sent.
      const { isError, text } = await call({
        uri: 'mongodb://127.0.0.1:27017/x', query: '{}', collection: 'c', action: 'drop'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/"action"/);
      expect(text).toMatch(/find, count, distinct, aggregate, explain, insert, update, updateOne, replace, delete, deleteOne/);
    });

    test.each(['insert', 'update', 'delete'])('blocks the %s action', async (action) => {
      const { isError, text } = await call({
        uri: 'mongodb://127.0.0.1:27017/x', query: '{"a":1}',
        collection: 'c', action, update: '{"$set":{"b":1}}'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/Read-only mode/);
    });

    test('blocks a $merge stage nested in a pipeline', async () => {
      const { isError, text } = await call({
        uri: 'mongodb://127.0.0.1:27017/x',
        query: '[{"$facet":{"all":[{"$merge":{"into":"copy"}}]}}]',
        collection: 'c', action: 'aggregate'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/Read-only mode/);
    });

    test('blocks a bare $out stage', async () => {
      const { isError } = await call({
        uri: 'mongodb://127.0.0.1:27017/x',
        query: '[{"$match":{}},{"$out":"copy"}]',
        collection: 'c', action: 'aggregate'
      });
      expect(isError).toBe(true);
    });

    test('lets a read action through the guard', async () => {
      // No server is listening, so this fails at connect. What matters is that
      // the guard did not block it.
      const { text } = await call({
        uri: 'mongodb://127.0.0.1:1/x', query: '{}', collection: 'c', action: 'count', timeout: 2000
      });
      expect(text).not.toMatch(/Read-only mode/);
    });
  });

  describe('driver availability', () => {
    // A published consumer can end up with a sqlite3 whose native binding was
    // never built, because npm blocks install scripts and the allow-list lives
    // in the installing project, not here. That must not take the other four
    // databases down with it, so sqlite3 is loaded lazily.
    test('the registry does not import sqlite3 at module scope', async () => {
      const registrySource = readFileSync(join(process.cwd(), 'src', 'core', 'registry.js'), 'utf8');
      const adapterSource = readFileSync(join(process.cwd(), 'src', 'adapters', 'sqlite.js'), 'utf8');

      expect(registrySource).toMatch(/from '\.\.\/adapters\/sqlite\.js'/);
      // A static import here would abort startup for every consumer.
      expect(adapterSource).not.toMatch(/^import sqlite3/m);
      expect(adapterSource).toMatch(/import\('sqlite3'\)/);
    });

    test('the server still starts and serves the other adapters', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

      const pg = await call({
        uri: 'postgres://u:p@127.0.0.1:1/x', query: 'SELECT 1', timeout: 2000
      });
      expect(pg.isError).toBe(true);
      expect(pg.text).not.toMatch(/bindings/i);
    });
  });

  describe('logging', () => {
    /**
     * How many collected stderr lines match `pattern` so far.
     *
     * Counted rather than sliced: the stream arrives in chunks that do not line up
     * with line boundaries, so "the lines since I looked" is not a well-defined
     * thing, and an off-by-one there reads as "the server logged nothing".
     */
    const countLines = (pattern) => stderr.join('').split('\n')
      .filter((line) => pattern.test(line)).length;

    /**
     * Wait until `atLeast` lines matching `pattern` have arrived, then give up.
     *
     * A fixed `setTimeout(250)` was the wrong primitive. The server has already
     * answered the tool call -- that is what awaiting the RPC guarantees -- and
     * *then* writes the log line, and this process only learns about that write
     * after it crosses a pipe and arrives as a `data` event. On an idle machine
     * 250ms is an eternity; on a loaded one, with three jest workers and a child
     * process competing for four cores, that hop can take longer than the whole
     * wait. The test then reads a count that has not moved and reports "the
     * server logged nothing", which is a false accusation and the hardest kind of
     * failure to chase.
     *
     * So: wait for the *condition*, not for a duration.
     *
     * The deadline is 2s and it is NOT generous on purpose. 2s is 8x the delay
     * it replaces, so the race it exists to beat cannot win; and it caps what a
     * machine stall can cost this describe at 2s per test instead of unbounded.
     * Past the deadline the *assertion* decides, which is the right place for
     * that decision: a log line that never arrives is a real failure and is
     * reported as one. A longer deadline here would only convert a slow machine
     * into a slow suite -- measured on a 4-core box under 8 competing processes,
     * a stall long enough to blow a 10s deadline added 10s per test here and
     * nothing else, because the assertion passed either way.
     *
     * This is not a retry and it cannot hide a missing log line.
     */
    const settle = async (pattern, atLeast) => {
      const deadline = Date.now() + 2000;
      while (countLines(pattern) < atLeast && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    test('does not write credentials to stderr', async () => {
      const { isError } = await call({
        uri: 'mysql://user:sup3rs3cret@127.0.0.1:3999/db',
        query: 'SELECT 1',
        timeout: 1000
      });
      expect(isError).toBe(true);
      // `tool_result` is the last line this server writes for a call, so waiting
      // for it means everything this call produced has been read.
      await settle(/\btool_result\b/, countLines(/\btool_result\b/) + 1);

      const text = stderr.join('');
      expect(text).not.toContain('sup3rs3cret');
      // The username is masked too, deliberately: in an IAM setup it is the
      // secret half of the credential.
      expect(text).not.toMatch(/mysql:\/\/user:/);
    });

    test('does not echo query text to stderr', async () => {
      const before = countLines(/\btool_result\b/);
      await call({ uri: 'sqlite://:memory:', query: "SELECT 'a-very-secret-literal' AS v" });
      await settle(/\btool_result\b/, before + 1);
      expect(stderr.join('')).not.toContain('a-very-secret-literal');
    });

    test('records one tool_call and one tool_result per call, with an id', async () => {
      const before = { calls: countLines(/\btool_call\b/), results: countLines(/\btool_result\b/) };
      await call({ uri: 'sqlite://:memory:', query: 'SELECT 1' });
      await settle(/\btool_result\b/, before.results + 1);

      const lines = stderr.join('').split('\n');
      const calls = lines.filter((l) => /\btool_call\b/.test(l));
      const results = lines.filter((l) => /\btool_result\b/.test(l));
      expect(calls.length - before.calls).toBe(1);
      expect(results.length - before.results).toBe(1);

      const record = calls[calls.length - 1];
      const id = /callId=(\S+)/.exec(record)?.[1];
      expect(id).toBeTruthy();
      expect(results[results.length - 1]).toContain(`callId=${id}`);
      // The *resolved* timeout, not the requested one: the effective 30000 was
      // never visible before.
      expect(record).toMatch(/timeout=30000/);
      expect(results[results.length - 1]).toMatch(/ok=true/);
      // And a duration and a row count, which the old single pre-query record had
      // neither of.
      expect(results[results.length - 1]).toMatch(/elapsedMs=/);
      expect(results[results.length - 1]).toMatch(/rowCount=/);
    });

    test('logs the failure as well as the attempt', async () => {
      const before = countLines(/\bok=false\b/);
      await call({ uri: 'sqlite://:memory:', query: 'DROP TABLE t' });
      await settle(/\bok=false\b/, before + 1);

      const lines = stderr.join('').split('\n');
      expect(lines.filter((l) => /\btool_call\b/.test(l)).length).toBeGreaterThan(0);
      expect(countLines(/\bok=false\b/) - before).toBeGreaterThan(0);
      expect(countLines(/\bkind=policy\b/)).toBeGreaterThan(0);
    });

    test('records the tool list once at startup', () => {
      const line = stderr.join('').split('\n').find((l) => /tool list/.test(l));
      expect(line).toBeDefined();
      expect(line).toMatch(`tools=${TOOL_NAMES.length}`);
      expect(line).toContain(TOOL_NAMES.join(','));
    });
  });
});
