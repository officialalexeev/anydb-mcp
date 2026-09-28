import { AdapterRegistry, TimeoutError, DEFAULT_TIMEOUT, TIMEOUT_GRACE_MS } from '../src/core/registry.js';

describe('AdapterRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  /**
   * Registry wired to a scriptable adapter. The protocol is a real one, since
   * the read-only guard fails closed on schemes it does not recognise.
   */
  const registryWith = (adapter, protocol = 'postgres') => {
    const r = new AdapterRegistry();
    r.mapping = { [protocol]: () => adapter };
    r.extractProtocol = () => protocol;
    return r;
  };

  const stubAdapter = (overrides = {}) => ({
    connect: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue([{ ok: 1 }]),
    close: jest.fn().mockResolvedValue(undefined),
    abort: jest.fn(),
    isHealthy: jest.fn().mockResolvedValue(true),
    ...overrides
  });

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
      'postgres://test', 'postgresql://test', 'mongodb://test', 'mongo://test',
      'sqlite://test', 'redis://test', 'rediss://test', 'mysql://test',
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

    test('requires a collection for MongoDB', () => {
      expect(() => registry.validate('{}', 'mongodb', {}))
        .toThrow("Missing 'collection' parameter for MongoDB query.");
      expect(() => registry.validate('{}', 'mongodb', { collection: 'users' })).not.toThrow();
    });

    test.each([0, -1, -1000, 86400001])('rejects out-of-range timeout %p', (timeout) => {
      expect(() => registry.validate('SELECT 1', 'postgres', { timeout }))
        .toThrow(/Timeout must be between/);
    });

    test.each(['5000', true, {}, [], NaN, Infinity])('rejects non-finite timeout %p', (timeout) => {
      expect(() => registry.validate('SELECT 1', 'postgres', { timeout }))
        .toThrow(/Timeout must be a number/);
    });

    test.each([1, 1000, 30000, 86400000])('accepts timeout %p', (timeout) => {
      expect(() => registry.validate('SELECT 1', 'postgres', { timeout })).not.toThrow();
    });

    test('rejects a non-boolean readOnly', () => {
      expect(() => registry.validate('SELECT 1', 'postgres', { readOnly: 'yes' }))
        .toThrow('readOnly must be a boolean.');
    });

    test('accepts a boolean readOnly', () => {
      expect(() => registry.validate('SELECT 1', 'postgres', { readOnly: false })).not.toThrow();
      expect(() => registry.validate('SELECT 1', 'postgres', { readOnly: true })).not.toThrow();
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
  });

  describe('read-only resolution', () => {
    test('defaults to read-only', () => {
      expect(registry.resolveReadOnly({})).toBe(true);
      expect(registry.resolveReadOnly({ readOnly: true })).toBe(true);
    });

    test('opts out only on an explicit false', () => {
      expect(registry.resolveReadOnly({ readOnly: false })).toBe(false);
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
      'sqlite+pysqlite:///path.db'
    ])('routes %s', async (uri) => {
      // These appear in the README and in SQLAlchemy connection strings, so the
      // registry has to reach them before the adapter normalises the scheme.
      const factory = jest.fn(() => stubAdapter());
      const r = new AdapterRegistry();
      r.mapping = { [registry.extractProtocol(uri)]: factory };
      r.extractProtocol = () => registry.extractProtocol(uri);

      expect(Object.keys(r.mapping)).toHaveLength(1);
      await r.run(uri, 'SELECT 1', { readOnly: false });
      expect(factory).toHaveBeenCalled();
    });

    test('rejects a missing or non-string uri', async () => {
      await expect(registry.run(undefined, 'SELECT 1'))
        .rejects.toThrow("Missing 'uri' argument");
      await expect(registry.run(42, 'SELECT 1'))
        .rejects.toThrow("Missing 'uri' argument");
    });

    test('rejects an empty uri', async () => {
      await expect(registry.run('', 'SELECT 1')).rejects.toThrow("Missing 'uri' argument");
    });

    test('keeps the connection for reuse', async () => {
      const adapter = stubAdapter();

      await expect(registryWith(adapter).run('postgres://x', 'SELECT 1'))
        .resolves.toEqual([{ ok: 1 }]);
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
      // SQLite keeps running a statement the caller has given up on, so a
      // cached connection that timed out would make every later query queue
      // behind it.
      const adapter = stubAdapter({
        execute: jest.fn().mockRejectedValue(new Error('SQLite query exceeded 200ms timeout'))
      });
      const r = registryWith(adapter);

      await expect(r.run('postgres://x', 'SELECT 1')).rejects.toThrow(/timeout/);
      expect(adapter.abort).toHaveBeenCalled();
      expect(r.cache.size).toBe(0);
    });

    test.each([
      'Query exceeded 30000ms timeout (statement_timeout)',
      'ER_QUERY_TIMEOUT: maximum statement execution time exceeded',
      '[MongoDB timeout] Query exceeded 30000ms (maxTimeMS)',
      'Operation "db_query (mysql)" timed out after 1000ms',
      'the operation was interrupted'
    ])('discards the connection for %p', async (message) => {
      const adapter = stubAdapter({ execute: jest.fn().mockRejectedValue(new Error(message)) });
      const r = registryWith(adapter);

      await expect(r.run('postgres://x', 'SELECT 1')).rejects.toThrow();
      expect(adapter.abort).toHaveBeenCalled();
      expect(r.cache.size).toBe(0);
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
      r.extractProtocol = () => 'postgres';

      await r.run('postgres://x', 'SELECT 1', { timeout: 1234 });
      expect(factory).toHaveBeenCalledWith(1234);
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

  describe('describe', () => {
    test('returns a schema without running caller SQL', async () => {
      const adapter = stubAdapter({
        describe: jest.fn().mockResolvedValue({ database: 'postgresql', tables: [] })
      });

      await expect(registryWith(adapter).describe('postgres://x'))
        .resolves.toEqual({ database: 'postgresql', tables: [] });
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    test('rejects a missing uri', async () => {
      await expect(registry.describe()).rejects.toThrow("Missing 'uri' argument");
      await expect(registry.describe('')).rejects.toThrow("Missing 'uri' argument");
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

    test('times out like db_query does', async () => {
      const adapter = stubAdapter({ describe: jest.fn(() => new Promise(() => {})) });

      await expect(registryWith(adapter).describe('postgres://x', { timeout: 60 }))
        .rejects.toThrow(/db_schema \(postgres\).*timed out/);
    });

    // describe() skips validate(), so an unchecked timeout used to reach
    // setTimeout. A negative value turned the guard off entirely, and a huge one
    // overflowed Node's 32-bit timer and fired on the next tick, so every call
    // reported a timeout it never had.
    test.each([
      ['abc', /must be a number of milliseconds, got abc/],
      [-5, /must be between 1 and 86400000/],
      [0, /must be between 1 and 86400000/],
      [1e18, /must be between 1 and 86400000/],
      [NaN, /must be a number of milliseconds, got NaN/],
      [Infinity, /must be a number of milliseconds, got Infinity/]
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

    test('allows a write when readOnly is explicitly false', async () => {
      const adapter = stubAdapter({ execute: jest.fn().mockResolvedValue([{ affectedRows: 1 }]) });
      await expect(registryWith(adapter).run('postgres://x', 'DROP TABLE users', { readOnly: false }))
        .resolves.toEqual([{ affectedRows: 1 }]);
    });

    test('the rejection names the way out', async () => {
      await expect(registryWith(stubAdapter()).run('postgres://x', 'DROP TABLE users'))
        .rejects.toThrow(/readOnly:\s*false/);
    });

    test('blocks a Redis write for a redis URI', async () => {
      const r = new AdapterRegistry();
      r.mapping = { redis: () => stubAdapter() };
      r.extractProtocol = () => 'redis';
      await expect(r.run('redis://x', 'FLUSHDB')).rejects.toThrow(/Read-only mode/);
    });

    // The read-only verdict looks only at the leading keyword, which is SELECT
    // here. What stops the DROP is the multiple-statement check, and it only
    // works if the scanner ends the literal where the server ends it.
    test.each(['postgres://x', 'postgresql://x', 'sqlite://:memory:'])(
      'refuses a statement hidden behind a backslash on %s',
      async (uri) => {
        const adapter = stubAdapter();
        await expect(registryWith(adapter).run(uri, "SELECT 'a\\'; DROP TABLE t; --'"))
          .rejects.toThrow(/Multiple statements/);
        expect(adapter.connect).not.toHaveBeenCalled();
      }
    );
  });
});
