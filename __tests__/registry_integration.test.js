import { AdapterRegistry } from '../src/core/registry.js';

/**
 * Covers routing and the read-only guard without needing a live database.
 * Live-database behaviour is exercised by the end-to-end suite.
 */
describe('AdapterRegistry integration', () => {
  let registry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  describe('protocol routing', () => {
    test.each([
      ['postgres://test', 'postgres'],
      ['postgresql://test', 'postgresql'],
      ['mongodb://test', 'mongodb'],
      ['sqlite://test', 'sqlite'],
      ['redis://test', 'redis'],
      ['rediss://test', 'rediss'],
      ['mysql://test', 'mysql'],
      ['mysql+pymysql://test', 'mysql+pymysql'],
    ])('extracts %s as %s', (uri, expected) => {
      expect(registry.extractProtocol(uri)).toBe(expected);
    });

    test('every scheme produces a real adapter class', () => {
      const seen = new Set();
      // Several schemes deliberately share an adapter: rediss with redis,
      // mysql+pymysql and friends with mysql. BaseAdapter's own methods throw, so a
      // real subclass is the proof that the scheme is wired up.
      const aliases = new Map();

      for (const [scheme, factory] of Object.entries(registry.mapping)) {
        const adapter = factory(1000);
        const name = adapter.constructor.name;

        expect(name).toMatch(/Adapter$/);
        expect(name).not.toBe('BaseAdapter');
        aliases.set(scheme, name);
        seen.add(name);

        for (const method of ['connect', 'execute', 'close', 'abort', 'isHealthy', 'describe']) {
          expect(typeof adapter[method]).toBe('function');
        }
        expect(scheme).toBeTruthy();
      }

      // Five distinct adapters behind the whole scheme list.
      expect(seen.size).toBe(5);
      expect(aliases.get('rediss')).toBe(aliases.get('redis'));
      expect(aliases.get('mysql+pymysql')).toBe(aliases.get('mysql'));
      expect(aliases.get('postgresql')).toBe(aliases.get('postgres'));
    });

    test('adapters receive the requested timeout', () => {
      expect(registry.mapping.postgres(1234).queryTimeout).toBe(1234);
      expect(registry.mapping.mysql(1234).queryTimeout).toBe(1234);
      expect(registry.mapping.mongodb(1234).queryTimeout).toBe(1234);
      expect(registry.mapping.redis(1234).queryTimeout).toBe(1234);
    });

    test('sqlite has no connect timeout', () => {
      expect(registry.mapping.sqlite(1234).connectTimeout).toBe(0);
      expect(registry.mapping.sqlite(1234).queryTimeout).toBe(1234);
    });
  });

  describe('unsupported protocols', () => {
    test('lists the supported protocols', async () => {
      await expect(registry.run('mssql://h', 'SELECT 1'))
        .rejects.toThrow(/Protocol "mssql" is not supported/);
      await expect(registry.run('mssql://h', 'SELECT 1'))
        .rejects.toThrow(/rediss/);
    });

    test('rejects a URI with no scheme', async () => {
      await expect(registry.run('localhost:5432', 'SELECT 1'))
        .rejects.toThrow("Invalid URI format");
    });
  });

  describe('read-only applies to every adapter', () => {
    // Stub adapters, so the guard runs through the real registry without a driver
    // resolving a hostname. Real adapters against fake hosts leave pools that get
    // disposed after the suite has finished.
    const stubAdapter = () => ({
      connect: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn().mockResolvedValue([{ ok: 1 }]),
      close: jest.fn().mockResolvedValue(undefined),
      describe: jest.fn().mockResolvedValue({ tables: [] }),
      abort: jest.fn(),
      isHealthy: jest.fn().mockResolvedValue(true)
    });

    /** A registry whose only scheme is the one under test, backed by a stub. */
    const registryFor = (protocol) => {
      const r = new AdapterRegistry();
      r.mapping = { [protocol]: () => stubAdapter() };
      return r;
    };

    test.each([
      ['postgres', 'postgres://u:p@h/d', 'SELECT 1'],
      ['mysql', 'mysql://u:p@h/d', 'SELECT 1'],
      ['sqlite', 'sqlite://:memory:', 'SELECT 1'],
      ['redis', 'redis://h:6379', 'GET k']
    ])('%s allows a read', async (protocol, uri, query) => {
      const r = registryFor(protocol);
      await expect(r.run(uri, query, { timeout: 300 })).resolves.toBeDefined();
    });

    test.each([
      ['postgres', 'postgres://u:p@h/d', 'DELETE FROM users'],
      ['mysql', 'mysql://u:p@h/d', 'TRUNCATE users'],
      ['sqlite', 'sqlite://:memory:', 'DROP TABLE users'],
      ['redis', 'redis://h:6379', 'SET a b'],
      ['redis', 'redis://h:6379', 'FLUSHDB']
    ])('%s blocks a write without connecting', async (protocol, uri, query) => {
      const r = registryFor(protocol);
      await expect(r.run(uri, query, { timeout: 300 }))
        .rejects.toThrow(/Read-only mode/);
    });

    test.each([
      ['postgres', 'postgres://u:p@h/d'],
      ['mysql', 'mysql://u:p@h/d'],
      ['sqlite', 'sqlite://:memory:']
    ])('%s blocks a write before opening a socket', async (protocol, uri) => {
      const adapter = stubAdapter();
      const r = new AdapterRegistry();
      r.mapping = { [protocol]: () => adapter };

      await expect(r.run(uri, 'DROP TABLE t', { timeout: 300 }))
        .rejects.toThrow(/Read-only mode/);
      expect(adapter.connect).not.toHaveBeenCalled();
    });

    test('a MongoDB read needs a collection', async () => {
      await expect(registryFor('mongodb').run('mongodb://h:27017/d', '{}', { timeout: 300 }))
        .rejects.toThrow("Missing 'collection'");
    });

    test('a MongoDB server-side JavaScript filter is blocked', async () => {
      await expect(
        registryFor('mongodb').run('mongodb://h:27017/d', '{"$where":"1"}', { collection: 'c' })
      ).rejects.toThrow(/Read-only mode/);
    });
  });
});
