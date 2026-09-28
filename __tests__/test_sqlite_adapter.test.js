import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQLiteAdapter } from '../src/adapters/sqlite.js';

// Read from the working directory rather than import.meta, which babel cannot
// compile to CommonJS.
const ADAPTER_SOURCE = readFileSync(join(process.cwd(), 'src', 'adapters', 'sqlite.js'), 'utf8');

/** A stand-in for a sqlite3 Database handle. */
class MockDatabase extends EventEmitter {
  constructor() {
    super();
    this.all = jest.fn();
    this.close = jest.fn((cb) => cb(null));
    this.interrupt = jest.fn();
  }
}

describe('SQLiteAdapter', () => {
  let adapter;
  let mockDb;
  let mockDatabaseConstructor;

  beforeEach(() => {
    mockDb = new MockDatabase();
    mockDatabaseConstructor = jest.fn(() => mockDb);
    adapter = new SQLiteAdapter(mockDatabaseConstructor, 30000);
  });

  const connect = (uri = 'sqlite:///path/to/database.db') => adapter.connect(uri);

  describe('connect', () => {
    test('opens the file path from the URI', async () => {
      await connect('sqlite:///C:/databases/test.db');
      expect(mockDatabaseConstructor).toHaveBeenCalledWith('C:/databases/test.db');
    });

    test('strips a query string from the path', async () => {
      await connect('sqlite:///path/to/db.sqlite?mode=ro');
      expect(mockDatabaseConstructor).toHaveBeenCalledWith('/path/to/db.sqlite');
    });

    test('accepts the in-memory form', async () => {
      await connect('sqlite://:memory:');
      expect(mockDatabaseConstructor).toHaveBeenCalledWith(':memory:');
    });

    test('rejects a URI with no path', async () => {
      await expect(connect('sqlite://')).rejects.toThrow('must include a file path');
    });

    test('registers an error listener', async () => {
      // Without one, sqlite3's 'error' event is an uncaught exception and takes
      // the whole MCP server process down.
      await connect();
      expect(mockDb.listenerCount('error')).toBeGreaterThan(0);
    });
  });

  describe('execute', () => {
    beforeEach(() => connect());

    test('returns rows', async () => {
      mockDb.all.mockImplementation((sql, params, cb) => cb(null, [{ id: 1 }]));
      await expect(adapter.execute('SELECT 1')).resolves.toEqual([{ id: 1 }]);
    });

    test('reports a missing table', async () => {
      mockDb.all.mockImplementation((sql, params, cb) =>
        cb(Object.assign(new Error('SQLITE_ERROR: no such table: t'), { code: 'SQLITE_ERROR' })));

      await expect(adapter.execute('SELECT * FROM t'))
        .rejects.toThrow('[SQLite error] no such table: t');
    });

    test('reports a lock distinctly', async () => {
      mockDb.all.mockImplementation((sql, params, cb) =>
        cb(Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' })));

      await expect(adapter.execute('SELECT 1'))
        .rejects.toThrow('[SQLite locked]');
    });

    test('reports an unopenable database', async () => {
      // The real driver never calls back for SQLITE_CANTOPEN; it only emits
      // 'error'. Relying on the callback alone means waiting out the full timeout.
      mockDb.all.mockImplementation(() => {
        setImmediate(() => mockDb.emit('error',
          Object.assign(new Error('SQLITE_CANTOPEN: unable to open database file'), {
            code: 'SQLITE_CANTOPEN'
          })));
      });

      await expect(adapter.execute('SELECT 1'))
        .rejects.toThrow('[SQLite cannot open]');
    });

    test('gives up after the query timeout', async () => {
      const slow = new SQLiteAdapter(mockDatabaseConstructor, 60);
      await slow.connect('sqlite:///path/to/database.db');
      mockDb.all.mockImplementation(() => { /* never calls back */ });

      await expect(slow.execute('SELECT 1')).rejects.toThrow(/exceeded 60ms timeout/);
    });
  });

  describe('driver loading', () => {
    test('reports an actionable error when the native binding is missing', async () => {
      // What a consumer sees once npm blocks the sqlite3 install script.
      const lazy = new SQLiteAdapter();
      lazy.loadDatabase = () => Promise.reject(new Error(
        'SQLite support is unavailable because the sqlite3 native binding was not built.'
      ));

      await expect(lazy.connect('sqlite://:memory:')).rejects.toThrow(
        /SQLite support is unavailable/
      );
    });

    test('names both ways to fix a missing binding', () => {
      expect(ADAPTER_SOURCE).toMatch(/install-scripts approve sqlite3/);
      expect(ADAPTER_SOURCE).toMatch(/allow-scripts=sqlite3/);
      // A static import would abort startup for every consumer, not just SQLite.
      expect(ADAPTER_SOURCE).not.toMatch(/^import sqlite3 from/m);
      expect(ADAPTER_SOURCE).toMatch(/import\('sqlite3'\)/);
    });

    test('uses an injected Database class without loading the driver', async () => {
      const injected = new SQLiteAdapter(MockDatabase, 30000);
      await injected.connect('sqlite://:memory:');
      expect(injected.db).toBeInstanceOf(MockDatabase);
    });
  });

  describe('abort', () => {
    test('interrupts the running statement', async () => {
      await connect();
      adapter.abort();
      expect(mockDb.interrupt).toHaveBeenCalled();
    });

    test('is safe with no handle', () => {
      expect(() => adapter.abort()).not.toThrow();
    });

    test('tolerates a driver without interrupt()', async () => {
      await connect();
      delete mockDb.interrupt;
      expect(() => adapter.abort()).not.toThrow();
    });
  });

  describe('close', () => {
    test('closes an open handle', async () => {
      await connect();
      await adapter.close();
      expect(mockDb.close).toHaveBeenCalled();
    });

    test('does not wait on a handle that never opened', async () => {
      await connect();
      mockDb.emit('error', new Error('SQLITE_CANTOPEN: unable to open database file'));
      mockDb.close.mockImplementation(() => { /* never calls back */ });

      await expect(adapter.close()).resolves.not.toThrow();
    });

    test('does not throw when close fails', async () => {
      await connect();
      mockDb.close.mockImplementation((cb) => cb(new Error('failed to close')));
      await expect(adapter.close()).resolves.not.toThrow();
    });

    test('is a no-op with no handle', async () => {
      await expect(adapter.close()).resolves.not.toThrow();
    });
  });
});
