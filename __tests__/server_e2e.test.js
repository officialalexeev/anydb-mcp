import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = join(process.cwd(), 'src', 'index.js');
const tmpUri = (name) => `sqlite://${join(process.cwd(), name).replace(/\\/g, '/')}`;

describe('MCP server end to end', () => {
  let client;
  let stderr;

  beforeAll(async () => {
    stderr = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      cwd: process.cwd(),
      stderr: 'pipe'
    });
    transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client?.close();
  });

  const call = async (args) => {
    const res = await client.callTool({ name: 'db_query', arguments: args });
    return { isError: !!res.isError, text: res.content?.[0]?.text ?? '' };
  };

  const schemaCall = async (args) => {
    const res = await client.callTool({ name: 'db_schema', arguments: args });
    return { isError: !!res.isError, text: res.content?.[0]?.text ?? '' };
  };

  const tool = async (name) => (await client.listTools()).tools.find(t => t.name === name);

  describe('handshake', () => {
    test('advertises both tools', async () => {
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name).sort()).toEqual(['db_query', 'db_schema']);
    });

    test('reports the package version', async () => {
      const { version } = require('../package.json');
      expect(client.getServerVersion().version).toBe(version);
    });

    test('db_query declares every argument', async () => {
      const q = await tool('db_query');
      expect(Object.keys(q.inputSchema.properties).sort()).toEqual([
        'action', 'allowWriteStages', 'collection', 'field', 'limit', 'projection',
        'query', 'readOnly', 'sort', 'timeout', 'update', 'upsert', 'uri'
      ]);
      expect(q.inputSchema.required.sort()).toEqual(['query', 'uri']);
    });

    test('db_schema declares every argument', async () => {
      const s = await tool('db_schema');
      expect(Object.keys(s.inputSchema.properties).sort())
        .toEqual(['collection', 'table', 'timeout', 'uri']);
      expect(s.inputSchema.required).toEqual(['uri']);
    });

    test('enumerates the MongoDB actions', async () => {
      const q = await tool('db_query');
      expect(q.inputSchema.properties.action.enum).toEqual([
        'find', 'count', 'distinct', 'aggregate', 'explain', 'insert', 'update', 'delete'
      ]);
    });

    test('marks read-only as the default', async () => {
      expect((await tool('db_query')).description).toMatch(/read-only by default/i);
    });
  });

  describe('malformed arguments', () => {
    // Each of these used to escape the handler as an internal error.
    test.each([
      ['a missing query', { uri: 'sqlite://:memory:' }],
      ['a numeric query', { uri: 'sqlite://:memory:', query: 123 }],
      ['a null query', { uri: 'sqlite://:memory:', query: null }],
      ['a missing uri', { query: 'SELECT 1' }],
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

  describe('resilience', () => {
    test('an unopenable SQLite path does not kill the server', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'anydb-'));
      const bad = join(dir, 'no-such-dir', 'x.db');
      try {
        const { isError, text } = await call({
          uri: `sqlite:///${bad.replace(/\\/g, '/')}`, query: 'SELECT 1'
        });
        expect(isError).toBe(true);
        expect(text).toMatch(/cannot open|CANTOPEN/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }

      const after = await call({ uri: 'sqlite://:memory:', query: 'SELECT 2 AS alive' });
      expect(after.isError).toBe(false);
      expect(JSON.parse(after.text)).toEqual([{ alive: 2 }]);
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
      for (const args of [
        { uri: 'nope', query: 'SELECT 1' },
        { uri: 'sqlite://no-such-dir-xyz/a.db', query: 'SELECT 1' },
        { uri: 'sqlite://:memory:' },
        { uri: 'sqlite://:memory:', query: 'DROP TABLE t' },
        { uri: 'sqlite://:memory:', query: 'SELECT bad syntax FROM' }
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
      ['above the cap', 86400001],
      ['a string', '5000']
    ])('rejects %s', async (_label, timeout) => {
      const { isError, text } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1', timeout });
      expect(isError).toBe(true);
      expect(text).toMatch(/[Tt]imeout must be/);
    });

    test('treats an explicit null as the default', async () => {
      const { isError } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: null });
      expect(isError).toBe(false);
    });

    test('accepts a valid timeout', async () => {
      const { isError } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: 5000 });
      expect(isError).toBe(false);
    });

    test('times out a long query and suggests a next step', async () => {
      const { isError, text } = await call({
        uri: 'sqlite://:memory:',
        query: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 80000000) SELECT count(*) FROM c',
        timeout: 200
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/timeout/i);
      expect(text).toMatch(/SUGGESTION:/);
    });

    test('the next query is not blocked by one that timed out', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'anydb-starve-'));
      const uri = `sqlite://${join(dir, 's.db').replace(/\\/g, '/')}`;
      const long = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 80000000) SELECT count(*) AS n FROM c';

      try {
        await call({ uri, query: long, timeout: 200 });

        const after = await call({ uri, query: 'SELECT 1 AS still_here' });
        expect(after.isError).toBe(false);
        expect(JSON.parse(after.text)).toEqual([{ still_here: 1 }]);
      } finally {
        // The server still holds the cached connection, so the file stays
        // locked until it exits. A leftover in the temp directory is harmless.
        await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    });
  });

  describe('result shape', () => {
    test('a SELECT returns an array', async () => {
      const { text } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1 AS a UNION ALL SELECT 2' });
      const parsed = JSON.parse(text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    });

    test('ignores unknown arguments', async () => {
      const { isError } = await call({ uri: 'sqlite://:memory:', query: 'SELECT 1', bogus: 'x' });
      expect(isError).toBe(false);
    });
  });

  describe('db_schema', () => {
    test('describes a SQLite database', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'anydb-schema-'));
      const uri = `sqlite://${join(dir, 's.db').replace(/\\/g, '/')}`;

      try {
        await call({ uri, query: 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)', readOnly: false });
        await call({ uri, query: 'CREATE VIEW v AS SELECT id FROM t', readOnly: false });

        const { isError, text } = await schemaCall({ uri });
        expect(isError).toBe(false);

        const parsed = JSON.parse(text);
        expect(parsed.database).toBe('sqlite');
        const table = parsed.tables.find(t => t.name === 't');
        expect(table.columns.map(c => c.name)).toEqual(['id', 'name']);
        expect(table.columns[1]).toMatchObject({ nullable: false });
        expect(table.columns[0]).toMatchObject({ primaryKey: true });
        expect(parsed.tables.map(t => t.name)).toEqual(expect.arrayContaining(['v']));
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    });

    test('describes a single table', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'anydb-schema-'));
      const uri = `sqlite://${join(dir, 's.db').replace(/\\/g, '/')}`;

      try {
        await call({ uri, query: 'CREATE TABLE a (x INT)', readOnly: false });
        await call({ uri, query: 'CREATE TABLE b (y INT)', readOnly: false });

        const { text } = await schemaCall({ uri, table: 'a' });
        expect(JSON.parse(text).tables.map(t => t.name)).toEqual(['a']);
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    });

    test('an empty database yields an empty report', async () => {
      const { isError, text } = await schemaCall({ uri: 'sqlite://:memory:' });
      expect(isError).toBe(false);
      expect(JSON.parse(text)).toMatchObject({ database: 'sqlite', tables: [] });
    });

    test.each([
      ['a missing uri', {}],
      ['an unsupported protocol', { uri: 'oracle://h' }],
      ['a non-string table', { uri: 'sqlite://:memory:', table: 5 }]
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

  describe('MongoDB arguments', () => {
    test('requires a collection', async () => {
      const { isError, text } = await call({
        uri: 'mongodb://127.0.0.1:27017/x', query: '{}', action: 'count'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/collection/i);
    });

    test('rejects an unknown action before connecting', async () => {
      const { isError, text } = await call({
        uri: 'mongodb://127.0.0.1:27017/x', query: '{}', collection: 'c', action: 'drop'
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/Unknown MongoDB action/);
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

  describe('logging', () => {
    test('does not write credentials to stderr', async () => {
      const { isError } = await call({
        uri: 'mysql://user:sup3rs3cret@127.0.0.1:3999/db',
        query: 'SELECT 1',
        timeout: 1000
      });
      expect(isError).toBe(true);
      await new Promise(r => setTimeout(r, 100));

      expect(stderr.join('')).not.toContain('sup3rs3cret');
    });

    test('does not echo query text to stderr', async () => {
      await call({ uri: 'sqlite://:memory:', query: "SELECT 'a-very-secret-literal' AS v" });
      await new Promise(r => setTimeout(r, 100));
      expect(stderr.join('')).not.toContain('a-very-secret-literal');
    });
  });
});
