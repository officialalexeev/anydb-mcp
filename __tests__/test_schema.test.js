import { EventEmitter } from 'node:events';
import {
  PostgresSchemaAdapter, MySQLSchemaAdapter,
  SQLiteSchemaAdapter, MongoSchemaAdapter, RedisSchemaAdapter
} from '../src/core/schema.js';

describe('PostgresSchemaAdapter', () => {
  let adapter;
  let query;

  beforeEach(() => {
    query = jest.fn();
    adapter = new PostgresSchemaAdapter();
    adapter.pool = { query };
  });

  const rows = (tables, columns) => {
    query
      .mockResolvedValueOnce({ rows: tables })
      .mockResolvedValueOnce({ rows: columns });
  };

  test('groups columns under their table', async () => {
    rows(
      [{ table_schema: 'public', table_name: 'users', table_type: 'BASE TABLE' },
       { table_schema: 'public', table_name: 'orders', table_type: 'BASE TABLE' }],
      [
        { table_name: 'users', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
        { table_name: 'users', column_name: 'email', data_type: 'text', is_nullable: 'YES', column_default: "''" },
        { table_name: 'orders', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null }
      ]
    );

    const out = await adapter.describe({});

    expect(out.database).toBe('postgresql');
    expect(out.tables).toHaveLength(2);
    expect(out.tables[0].columns.map(c => c.name)).toEqual(['id', 'email']);
    expect(out.tables[1].columns.map(c => c.name)).toEqual(['id']);
    expect(out.tables[0].columns[1]).toMatchObject({ nullable: true, default: "''" });
  });

  test('skips system schemas', async () => {
    query.mockResolvedValue({ rows: [] });
    await adapter.describe({});
    expect(query.mock.calls[0][0]).toMatch(/table_schema NOT IN \('pg_catalog', 'information_schema'\)/);
  });

  test('binds a requested table name as a parameter', async () => {
    rows([{ table_schema: 'public', table_name: 'users', table_type: 'BASE TABLE' }], []);
    await adapter.describe({ table: 'users' });

    expect(query.mock.calls[0][0]).toContain('AND table_name = $1');
    expect(query.mock.calls[0][1]).toEqual(['users']);
  });

  test('queries columns only when there are tables', async () => {
    query.mockResolvedValue({ rows: [] });
    const out = await adapter.describe({});

    expect(out.tables).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('MySQLSchemaAdapter', () => {
  let adapter;
  let query;

  beforeEach(() => {
    query = jest.fn();
    adapter = new MySQLSchemaAdapter();
    adapter.pool = { query };
  });

  test('reads the upper-case information_schema column names', async () => {
    // information_schema labels its columns in upper case, and the driver
    // hands the keys back verbatim.
    query
      .mockResolvedValueOnce([[
        { TABLE_NAME: 'users', TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 3, ENGINE: 'InnoDB' }
      ], []])
      .mockResolvedValueOnce([[
        { TABLE_NAME: 'users', COLUMN_NAME: 'id', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI', COLUMN_DEFAULT: null, EXTRA: 'auto_increment' },
        { TABLE_NAME: 'users', COLUMN_NAME: 'email', COLUMN_TYPE: 'varchar(80)', IS_NULLABLE: 'YES', COLUMN_KEY: 'MUL', COLUMN_DEFAULT: null, EXTRA: '' }
      ], []]);

    const out = await adapter.describe({});

    expect(out.tables[0].name).toBe('users');
    expect(out.tables[0].approximateRows).toBe(3);
    expect(out.tables[0].columns).toEqual([
      { name: 'id', type: 'int', nullable: false, key: 'PRI', default: null, extra: 'auto_increment' },
      { name: 'email', type: 'varchar(80)', nullable: true, key: 'MUL', default: null, extra: null }
    ]);
  });

  test('scopes to the selected database and binds the table name', async () => {
    query.mockResolvedValue([[], []]);
    await adapter.describe({ table: 'users' });

    expect(query.mock.calls[0][0]).toContain('TABLE_SCHEMA = DATABASE()');
    expect(query.mock.calls[0][0]).toContain('AND TABLE_NAME = ?');
    expect(query.mock.calls[0][1]).toEqual(['users']);
  });
});

describe('SQLiteSchemaAdapter', () => {
  let adapter;
  let db;

  beforeEach(() => {
    db = new EventEmitter();
    db.all = jest.fn();
    db.close = jest.fn();
    adapter = new SQLiteSchemaAdapter();
    adapter.db = db;
  });

  test('reads the catalogue and PRAGMA per table', async () => {
    db.all
      .mockImplementationOnce((sql, params, cb) => cb(null, [
        { name: 'users', type: 'table', sql: 'CREATE TABLE users (id INTEGER)' },
        { name: 'active_users', type: 'view', sql: 'CREATE VIEW active_users AS SELECT 1' }
      ]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [
        { name: 'id', type: 'INTEGER', notnull: 1, pk: 1, dflt_value: null },
        { name: 'email', type: 'TEXT', notnull: 0, pk: 0, dflt_value: "''" }
      ]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [
        { name: 'id', type: 'INTEGER', notnull: 0, pk: 1, dflt_value: null }
      ]));

    const out = await adapter.describe({});

    expect(out.database).toBe('sqlite');
    expect(out.tables.map(t => t.name)).toEqual(['users', 'active_users']);
    expect(out.tables[0].columns).toEqual([
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, default: null },
      { name: 'email', type: 'TEXT', nullable: true, primaryKey: false, default: "''" }
    ]);
    expect(out.tables[0].sql).toContain('CREATE TABLE users');
  });

  test('excludes internal tables', async () => {
    db.all.mockImplementationOnce((sql, params, cb) => cb(null, []));
    await adapter.describe({});
    expect(db.all.mock.calls[0][0]).toContain("name NOT LIKE 'sqlite_%'");
  });

  test('quotes a hostile table name so it cannot break out of the PRAGMA', async () => {
    db.all
      .mockImplementationOnce((sql, params, cb) => cb(null, [
        { name: 'books"; DROP TABLE authors; --', type: 'table', sql: 'x' }
      ]))
      // The quoted identifier matches nothing, so the PRAGMA yields no rows.
      .mockImplementationOnce((sql, params, cb) => cb(null, []));

    const out = await adapter.describe({});

    expect(db.all.mock.calls[1][0])
      .toBe('PRAGMA table_info("books""; DROP TABLE authors; --")');
    expect(out.tables[0].columns).toEqual([]);
  });

  test('lists a table whose name contains a quote', async () => {
    db.all
      .mockImplementationOnce((sql, params, cb) => cb(null, [
        { name: 'we"ird', type: 'table', sql: 'x' }
      ]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [
        { name: 'id', type: 'INTEGER', notnull: 1, pk: 1, dflt_value: null }
      ]));

    const out = await adapter.describe({});

    expect(db.all.mock.calls[1][0]).toBe('PRAGMA table_info("we""ird")');
    expect(out.tables[0].columns).toHaveLength(1);
  });

  test('lists a table whose name contains a space', async () => {
    db.all
      .mockImplementationOnce((sql, params, cb) => cb(null, [
        { name: 'my table', type: 'table', sql: 'x' }
      ]))
      .mockImplementationOnce((sql, params, cb) => cb(null, [
        { name: 'id', type: 'INTEGER', notnull: 1, pk: 1, dflt_value: null }
      ]));

    const out = await adapter.describe({});

    expect(db.all.mock.calls[1][0]).toBe('PRAGMA table_info("my table")');
    expect(out.tables[0].columns).toHaveLength(1);
  });

  test('refuses a name containing a NUL, which would truncate the statement', async () => {
    db.all
      .mockImplementationOnce((sql, params, cb) => cb(null, [
        { name: 'a\0DROP TABLE t', type: 'table', sql: 'x' }
      ]));

    const out = await adapter.describe({});

    expect(db.all).toHaveBeenCalledTimes(1);
    expect(out.tables[0].columns).toEqual([]);
  });

  test('reports a read that fails', async () => {
    db.all.mockImplementationOnce((sql, params, cb) => cb(new Error('SQLITE_BUSY: database is locked')));
    await expect(adapter.describe({})).rejects.toThrow('[SQLite schema]');
  });

  test('returns an empty list for an empty database', async () => {
    db.all.mockImplementationOnce((sql, params, cb) => cb(null, []));
    await expect(adapter.describe({})).resolves.toEqual({
      database: 'sqlite', tables: [], truncated: false
    });
  });
});

describe('MongoSchemaAdapter', () => {
  let adapter;
  let client;

  beforeEach(() => {
    client = {
      options: { dbName: 'shop' },
      db: {
        listCollections: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([{ name: 'orders' }, { name: 'users' }]) })),
        command: jest.fn().mockResolvedValue({ count: 42 }),
        collection: jest.fn(() => ({ indexes: jest.fn().mockResolvedValue([{ name: '_id_', key: { _id: 1 }, unique: true }]) }))
      }
    };
    adapter = new MongoSchemaAdapter();
    adapter.client = client;
  });

  test('lists collections with document counts and indexes', async () => {
    const out = await adapter.describe({});

    expect(out.database).toBe('mongodb');
    expect(out.databaseName).toBe('shop');
    expect(out.collections.map(c => c.name)).toEqual(['orders', 'users']);
    expect(out.collections[0].documents).toBe(42);
    expect(out.collections[0].indexes).toEqual([{ name: '_id_', key: { _id: 1 }, unique: true }]);
  });

  test('describes only the requested collection', async () => {
    client.db.listCollections = jest.fn();
    const out = await adapter.describe({ collection: 'users' });

    expect(client.db.listCollections).not.toHaveBeenCalled();
    expect(out.collections.map(c => c.name)).toEqual(['users']);
  });

  test('still lists a collection whose stats cannot be read', async () => {
    client.db.command = jest.fn().mockRejectedValue(new Error('not authorized'));
    const out = await adapter.describe({});
    expect(out.collections[0].documents).toBeNull();
  });

  test('still lists a collection whose indexes cannot be read', async () => {
    client.db.collection = jest.fn(() => ({ indexes: jest.fn().mockRejectedValue(new Error('not authorized')) }));
    const out = await adapter.describe({});
    expect(out.collections[0].indexes).toEqual([]);
  });
});

describe('RedisSchemaAdapter', () => {
  let adapter;
  let client;

  beforeEach(() => {
    client = {
      info: jest.fn(),
      scanIterator: jest.fn()
    };
    adapter = new RedisSchemaAdapter();
    adapter.client = client;
  });

  const keyspace = { keyspace: 'db0:keys=12,expires=3,avg_ttl=45000\r\ndb1:keys=1,expires=0,avg_ttl=0\r\n' };

  test('parses keyspace statistics and a version', async () => {
    client.info = jest.fn()
      .mockResolvedValueOnce(keyspace)
      .mockResolvedValueOnce('redis_version:7.2.4\r\n');
    client.scanIterator = jest.fn().mockReturnValue((async function* () {
      yield 'user:1';
      yield 'user:2';
    })());

    const out = await adapter.describe({});

    expect(out.database).toBe('redis');
    expect(out.version).toBe('7.2.4');
    expect(out.keyspace).toEqual([
      { database: 0, keys: 12, withExpiry: 3, averageTtlMs: 45000 },
      { database: 1, keys: 1, withExpiry: 0, averageTtlMs: 0 }
    ]);
    expect(out.sampleKeys).toEqual(['user:1', 'user:2']);
  });

  test('reads the version from a raw INFO string', async () => {
    // node-redis returns INFO as a string, not a parsed object.
    client.info = jest.fn()
      .mockResolvedValueOnce({ keyspace: '' })
      .mockResolvedValueOnce('redis_version:8.0.1\r\nos:Linux\r\n');
    client.scanIterator = jest.fn().mockReturnValue((async function* () {})());

    const out = await adapter.describe({});
    expect(out.version).toBe('8.0.1');
  });

  test('degrades to an empty report when INFO is refused', async () => {
    // A managed Redis often disables INFO; the report must still come back.
    client.info = jest.fn().mockRejectedValue(new Error('NOPERM'));
    client.scanIterator = jest.fn().mockReturnValue((async function* () {})());

    const out = await adapter.describe({});

    expect(out.keyspace).toEqual([]);
    expect(out.sampleKeys).toEqual([]);
    expect(out.note).toMatch(/schemaless/);
  });

  test('caps the key sample', async () => {
    client.info = jest.fn().mockResolvedValue('');
    client.scanIterator = jest.fn().mockReturnValue((async function* () {
      for (let i = 0; i < 200; i++) yield `key:${i}`;
    })());

    const out = await adapter.describe({});
    expect(out.sampleKeys).toHaveLength(20);
  });
});
