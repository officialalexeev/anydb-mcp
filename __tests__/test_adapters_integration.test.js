import { EventEmitter } from 'node:events';

import { PostgresAdapter } from '../src/adapters/postgres.js';
import { MySQLAdapter } from '../src/adapters/mysql.js';
import { SQLiteAdapter, loadSqlite3 } from '../src/adapters/sqlite.js';
import { MongoAdapter } from '../src/adapters/mongodb.js';
import { RedisAdapter } from '../src/adapters/redis.js';

/**
 * The five adapters, side by side.
 *
 * Each adapter's own suite covers its own behaviour against a faithful double of
 * its driver. What a double per adapter cannot check is the part that has to hold
 * for *all five* or the tool is inconsistent rather than merely uneven: the same
 * failure reads the same way from `db_query` and `db_schema` and keeps the driver
 * error as its cause; `isHealthy` asks the server rather than assume; `close()`
 * never throws; a truncated result is a fact about the answer, carried
 * non-enumerably so it survives to the envelope without appearing as a field in
 * the JSON; and a statement that changes the state of a shared connection is
 * refused by every backend that shares one.
 *
 * What this file cannot do is talk to a real server. SQLite's driver is installed
 * and local, so that one runs for real; the other four are driven through the
 * documented shape of their own driver. `test_policy_live.test.js` is the suite
 * that talks to live servers, and only when they are there.
 */

// Driver doubles, each in the shape the installed driver actually uses

  /**
   * pg's `Query`, in the two forms the adapter builds it.
   *
   * With a callback, pg accumulates the rows itself and reports errors through that
   * callback; without one, it emits `row` per row and keeps nothing. The capped
   * path depends on the second, so this class delivers asynchronously: the adapter
   * attaches its listeners after `pool.connect()` has returned the client.
   */
class ScriptedQuery {
  constructor(text, values, callback) {
    this.text = text;
    this.values = values;
    this.callback = callback;
    this.handlers = new Map();
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return this;
  }

  once(event, fn) { return this.on(event, fn); }

  emit(event, ...args) {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
  }
}

/** A pg client that answers `rows` for any Query object and nothing for a string. */
function pgClientDelivering(rows) {
  return {
    release: jest.fn(),
    query(query) {
      if (typeof query === 'string') {
        return Promise.resolve({ rows: [], rowCount: 0, command: '' });
      }
      setTimeout(() => {
        for (const row of rows) query.emit('row', row, null);
        query.emit('end', { rows: [], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] });
      }, 0);
      return query;
    }
  };
}

  /**
   * mysql2's query command, in the streaming shape.
   *
   * `connection.query({ sql, values, timeout })` with no callback returns a command
   * whose `stream()` is an object-mode Readable of one row per `result` emission,
   * and whose `fields` event says which of those are rows: `readField` emits the
   * field list before any row, `doneInsert` emits `'fields', void 0` before the
   * status packet. A row is a plain object, so the event is the only thing that
   * separates the two.
   */
function mysqlCommandDelivering(rows) {
  const command = new EventEmitter();
  command.stream = () => (async function* () {
    command.emit('fields', [{ name: 'id' }]);
    for (const row of rows) yield row;
  })();
  return command;
}

/** A Mongo cursor: `next()` until it answers null, then `close()`. */
function mongoCursorDelivering(docs) {
  let at = 0;
  return {
    limit: () => {},
    skip: () => {},
    sort: () => {},
    project: () => {},
    maxTimeMS: () => {},
    close: () => Promise.resolve(),
    next: () => Promise.resolve(at < docs.length ? docs[at++] : null)
  };
}

/** A node-redis client, for the paths that only need `sendCommand` and `isReady`. */
function redisClient(reply) {
  return {
    isReady: true,
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn(),
    sendCommand: jest.fn().mockResolvedValue(reply)
  };
}

describe('adapters side by side', () => {
  describe('db_schema reports a failure in the same words as db_query', () => {
    // The schema scan is built by `src/core/schema.js` and knows nothing about
    // the adapter it was called from. What makes the two tools agree is that the
    // adapter hands the schema adapter its own `describeError`, so a missing
    // relation is a sentence from `db_query` and the same sentence from
    // `db_schema`, instead of a bare driver code from one of them.
    const cases = [
      {
        backend: 'postgres',
        prefix: /^\[Postgres /,
        build: async (err) => {
          const adapter = new PostgresAdapter(function RejectingPool() {
            return {
              // The schema scan takes a client of its own and sets
              // `statement_timeout` on it first, so the refusal has to come from
              // the client rather than from the pool shortcut.
              connect: async () => ({ query: () => Promise.reject(err), release: jest.fn() }),
              query: jest.fn(() => Promise.reject(err)),
              end: jest.fn()
            };
          }, 30000);
          await adapter.connect('postgres://u:p@h:5432/d');
          return adapter;
        }
      },
      {
        backend: 'mysql',
        prefix: /^\[MySQL /,
        build: async (err) => {
          const adapter = new MySQLAdapter(() => ({
            getConnection: async () => ({
              connection: { query: (_options, callback) => callback(err) },
              release: jest.fn()
            }),
            releaseConnection: jest.fn(),
            query: jest.fn(() => Promise.reject(err)),
            end: jest.fn()
          }), 30000);
          await adapter.connect('mysql://u:p@h:3306/d');
          return adapter;
        }
      },
      {
        backend: 'mongodb',
        prefix: /^\[MongoDB /,
        build: async (err) => {
          const adapter = new MongoAdapter(function RejectingClient() {
            return {
              connect: jest.fn().mockResolvedValue(undefined),
              close: jest.fn().mockResolvedValue(undefined),
              topology: { isConnected: () => true },
              // `db` is a method on MongoClient, and it is the pinned Db the
              // schema scan is handed.
              db: () => ({
                databaseName: 'd',
                listCollections: () => ({ toArray: () => Promise.reject(err) })
              })
            };
          }, 30000);
          await adapter.connect('mongodb://h:27017/d');
          return adapter;
        }
      },
      {
        backend: 'redis',
        prefix: /^\[Redis /,
  // Redis is the one backend whose schema scan does not fail: every `INFO` section
  // is read through `safeSection`, so a refusal costs that section and names it in
  // `unavailable`. The empty keyspace it leaves behind is a *reported* empty, which
  // is a deliberate difference from the other four.
        build: async (err) => {
          const client = redisClient(null);
          client.info = jest.fn(() => Promise.reject(err));
          client.scanIterator = jest.fn(() => (async function* () {})());
          const adapter = new RedisAdapter(() => client, 30000);
          await adapter.connect('redis://h:6379');
          return adapter;
        }
      }
    ];

    test.each(cases.filter((c) => c.backend !== 'redis'))(
      '$backend routes a schema failure through describeError', async ({ prefix, build }) => {
        const driver = Object.assign(new Error('the server said no'), { code: 'XX000', name: 'Error' });
        const adapter = await build(driver);

        const error = await adapter.describe({}).catch(e => e);

        expect(error.message).toMatch(prefix);
        // The driver's own message survives: the prefix says which database, the
        // detail says what the server actually said.
        expect(error.message).toContain('the server said no');
      }
    );

    test('redis names the INFO section it could not read', async () => {
      const err = new Error('ERR unknown command');
      const adapter = await cases.find((c) => c.backend === 'redis').build(err);

      const out = await adapter.describe({});

      expect(out.keyspace).toEqual({});
      // The two sections a summary asks for, and the reason for each. An empty
      // keyspace reads exactly like a server with no keys unless it says so.
      expect(out.unavailable.map(u => u.section).sort()).toEqual(['keyspace', 'server']);
      expect(out.unavailable.every(u => u.error.includes('unknown command'))).toBe(true);
    });

    // pg and MySQL keep the driver error as `cause`, which is what lets the
    // registry classify the failure and the logger print a stack that leads
    // somewhere. Dropping it would turn a diagnosable error into a string.
    test.each([
      ['postgres', async (driver) => {
        const a = new PostgresAdapter(function RejectingPool() {
          return {
            connect: async () => ({ query: () => Promise.reject(driver), release: jest.fn() }),
            query: jest.fn(() => Promise.reject(driver)),
            end: jest.fn()
          };
        }, 30000);
        await a.connect('postgres://h/d');
        return a;
      }],
      ['mysql', async (driver) => {
        const a = new MySQLAdapter(() => ({
          getConnection: async () => ({
            connection: { query: (_options, callback) => callback(driver) },
            release: jest.fn()
          }),
          releaseConnection: jest.fn(),
          query: jest.fn(() => Promise.reject(driver)),
          end: jest.fn()
        }), 30000);
        await a.connect('mysql://h/d');
        return a;
      }]
    ])('%backend keeps the driver error as the cause', async (_backend, make) => {
      const driver = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      const adapter = await make(driver);

      const error = await adapter.describe({}).catch(e => e);

      expect(error.cause).toBe(driver);
    });
  });

  describe('against the real SQLite driver', () => {
    // Everything else in this file is a double. SQLite is a local file and its
    // driver is installed, so one backend can be checked for real end to end:
    // a write through `db_query`, then the same handle's `db_schema`, with the
    // statements the adapters actually write.
    let adapter;

    beforeEach(async () => {
      adapter = new SQLiteAdapter();
      await adapter.connect('sqlite://:memory:');
    });

    afterEach(async () => {
      await adapter.close();
    });

    test('a table written through db_query is described by db_schema', async () => {
      await adapter.execute(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, score INTEGER DEFAULT 0)'
      );

      const out = await adapter.describe({ detail: 'full' });

      expect(out.database).toBe('sqlite');
      expect(out.detail).toBe('full');
      expect(out.tables.map(t => t.name)).toEqual(['users']);
      const users = out.tables[0];
      // The table's own DDL, which is the shortest complete description of a
      // SQLite table: there is no server-side view of it to ask for.
      expect(users.sql).toContain('CREATE TABLE users');
      expect(users.columns.map(c => c.name)).toEqual(['id', 'email', 'score']);
      expect(users.columns.find(c => c.name === 'id')).toMatchObject({
        type: 'INTEGER', nullable: true, primaryKey: true
      });
      expect(users.columns.find(c => c.name === 'email')).toMatchObject({
        type: 'TEXT', nullable: false, primaryKey: false
      });
      // The UNIQUE constraint is a real index in SQLite, and it is the one thing
      // about the table that is not visible in its columns.
      expect(users.indexes).toEqual([{
        name: 'sqlite_autoindex_users_1',
        columns: ['email'],
        unique: true,
        origin: 'u',
        partial: false
      }]);
    });

    test('a capped read is a prefix, and says so', async () => {
      await adapter.execute('CREATE TABLE t (id INTEGER)');
      for (let i = 0; i < 10; i++) await adapter.execute('INSERT INTO t VALUES (?)', { params: [i] });

      const rows = await adapter.execute('SELECT id FROM t ORDER BY id', { maxRows: 3 });

      expect(rows.map(r => r.id)).toEqual([0, 1, 2]);
      expect(rows.truncated).toBe(true);
      // Non-enumerable on purpose: the marker is a fact about the answer, and a
      // `truncated` key inside the first row object would be a column of the
      // user's table.
      expect(JSON.parse(JSON.stringify(rows))).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
    });

    test('a bound value is a value', async () => {
      await adapter.execute('CREATE TABLE t (email TEXT)');
      await adapter.execute('INSERT INTO t (email) VALUES (?)', { params: ["a'b; DROP TABLE t"] });

      const rows = await adapter.execute('SELECT email FROM t');

      expect(rows).toEqual([{ email: "a'b; DROP TABLE t" }]);
    });

    test('refuses a transaction rather than leaving one open on the handle', async () => {
      const error = await adapter.execute('BEGIN', { readOnly: false }).catch(e => e);

      expect(error.message).toContain('[SQLite transactions are not supported]');
      // The refusal costs no round trip, so the handle is untouched and the next
      // statement still sees an empty database.
      await expect(adapter.execute('SELECT COUNT(*) AS n FROM sqlite_master'))
        .resolves.toEqual([{ n: 0 }]);
    });

    test('isHealthy asks the handle, and says no once it is closed', async () => {
      expect(await adapter.isHealthy()).toBe(true);
      await adapter.close();
      expect(await adapter.isHealthy()).toBe(false);
    });

    test('a closed handle cannot be written to, and the message says which database', async () => {
      await adapter.close();

      await expect(adapter.execute('SELECT 1')).rejects.toThrow(/^\[SQLite /);
    });
  });

  describe('isHealthy', () => {
    // The cache's contract: an adapter that assumes it is alive hands a dead
    // connection to the next caller, and the failure surfaces there as somebody
    // else's bug. Each backend has to learn it from its driver.
    test('postgres asks the pool', async () => {
      const ok = new PostgresAdapter(function Pool() {
        return { query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }), end: jest.fn() };
      }, 30000);
      await ok.connect('postgres://h/d');
      expect(await ok.isHealthy()).toBe(true);

      const dead = new PostgresAdapter(function Pool() {
        return { query: jest.fn().mockRejectedValue(new Error('terminating connection')), end: jest.fn() };
      }, 30000);
      await dead.connect('postgres://h/d');
      expect(await dead.isHealthy()).toBe(false);

      // Never connected, and given up on: both are "not healthy", not a crash.
      expect(await new PostgresAdapter().isHealthy()).toBe(false);
    });

    test('mysql asks the pool', async () => {
      const ok = new MySQLAdapter(() => ({
        query: jest.fn().mockResolvedValue([[{ 1: 1 }], []]),
        getConnection: jest.fn(),
        end: jest.fn()
      }), 30000);
      await ok.connect('mysql://h/d');
      expect(await ok.isHealthy()).toBe(true);

      const dead = new MySQLAdapter(() => ({
        query: jest.fn().mockRejectedValue(new Error('PROTOCOL_CONNECTION_LOST')),
        getConnection: jest.fn(),
        end: jest.fn()
      }), 30000);
      await dead.connect('mysql://h/d');
      expect(await dead.isHealthy()).toBe(false);

      expect(await new MySQLAdapter().isHealthy()).toBe(false);
    });

    test('mongodb reads the driver topology, so it costs no round trip', async () => {
      const clientFor = (connected) => function Client() {
        return {
          connect: jest.fn().mockResolvedValue(undefined),
          close: jest.fn().mockResolvedValue(undefined),
          topology: { isConnected: () => connected },
          db: () => ({})
        };
      };

      const up = new MongoAdapter(clientFor(true), 30000);
      await up.connect('mongodb://h:27017/d');
      expect(up.isHealthy()).toBe(true);

      const down = new MongoAdapter(clientFor(false), 30000);
      await down.connect('mongodb://h:27017/d');
      expect(down.isHealthy()).toBe(false);

      expect(new MongoAdapter().isHealthy()).toBe(false);
    });

    test('redis reads the socket state, so it costs no round trip', async () => {
      const client = redisClient('OK');
      const adapter = new RedisAdapter(() => client, 30000);
      await adapter.connect('redis://h:6379');

      expect(adapter.isHealthy()).toBe(true);
      client.isReady = false;
      expect(adapter.isHealthy()).toBe(false);
      // Given up on, whatever the socket says.
      client.isReady = true;
      adapter.abort();
      expect(adapter.isHealthy()).toBe(false);
      expect(new RedisAdapter().isHealthy()).toBe(false);
    });
  });

  describe('close', () => {
    // The close path runs while a request is already failing or already
    // answered, so it is the last place a throw can turn a degraded connection
    // into a failed call - and the last chance to record why.
    test.each([
      ['postgres', () => {
        const adapter = new PostgresAdapter(function Pool() {
          return { query: jest.fn(), end: jest.fn().mockRejectedValue(new Error('pool is closed')) };
        }, 30000);
        return adapter.connect('postgres://h/d').then(() => adapter);
      }],
      ['mysql', () => {
        const adapter = new MySQLAdapter(() => ({
          query: jest.fn(),
          getConnection: jest.fn(),
          end: jest.fn().mockRejectedValue(new Error('pool is closed'))
        }), 30000);
        return adapter.connect('mysql://h/d').then(() => adapter);
      }],
      ['sqlite', () => {
        // A handle that never opened: sqlite3's `close` calls back with an error
        // rather than throwing, and the adapter has to swallow it.
        const adapter = new SQLiteAdapter(undefined, 30000);
        return Promise.resolve(adapter);
      }],
      ['mongodb', async () => {
        const adapter = new MongoAdapter(function Client() {
          return {
            connect: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockRejectedValue(new Error('client is closed')),
            topology: { isConnected: () => false },
            db: () => ({})
          };
        }, 30000);
        await adapter.connect('mongodb://h:27017/d');
        return adapter;
      }],
      ['redis', async () => {
        const client = redisClient('OK');
        client.quit = jest.fn().mockRejectedValue(new Error('The client is closed'));
        const adapter = new RedisAdapter(() => client, 30000);
        await adapter.connect('redis://h:6379');
        return adapter;
      }]
    ])('%s close() resolves even when the driver refuses', async (_backend, make) => {
      const adapter = await make();

      await expect(adapter.close()).resolves.not.toThrow();
      // And twice: a second close is a no-op, not a second failure.
      await expect(adapter.close()).resolves.not.toThrow();
    });
  });

  describe('a cap is a prefix, and it is marked as a fact', () => {
    // The marker is how the answer says "this is part of it". It is defined
    // non-enumerably on every backend, for the same reason on every backend: it
    // is a property of the *result*, not a field in a row, and a JSON consumer
    // that sees `truncated` inside the first object has been handed a column
    // that does not exist in the user's table.
    test('postgres stops accumulating and keeps the prefix', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
      const adapter = new PostgresAdapter(function Pool() {
        return { connect: async () => pgClientDelivering(rows), query: jest.fn(), end: jest.fn() };
      }, 30000, undefined, ScriptedQuery);
      await adapter.connect('postgres://h/d');

      const answer = await adapter.execute('SELECT id FROM t', { maxRows: 3 });

      expect(answer.map(r => r.id)).toEqual([1, 2, 3]);
      expect(answer.truncated).toBe(true);
      expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
    });

    test('mysql drains the result but keeps only the cap', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
      const released = [];
      const adapter = new MySQLAdapter(() => ({
        query: jest.fn(),
        getConnection: async () => ({
          connection: { query: () => mysqlCommandDelivering(rows) },
          release: () => released.push(true)
        }),
        releaseConnection: jest.fn(),
        end: jest.fn()
      }), 30000);
      await adapter.connect('mysql://h/d');

      const answer = await adapter.execute('SELECT id FROM t', { maxRows: 3 });

      expect(answer.map(r => r.id)).toEqual([1, 2, 3]);
      expect(answer.truncated).toBe(true);
      expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
    });

    test('mongodb reads maxRows + 1 documents and stops', async () => {
      const docs = Array.from({ length: 50 }, (_, i) => ({ _id: i }));
      const adapter = new MongoAdapter(function Client() {
        return {
          connect: jest.fn().mockResolvedValue(undefined),
          close: jest.fn().mockResolvedValue(undefined),
          topology: { isConnected: () => true },
          db: () => ({ collection: () => ({ find: () => mongoCursorDelivering(docs) }) })
        };
      }, 30000);
      await adapter.connect('mongodb://h:27017/d');

      const answer = await adapter.execute('{}', { collection: 'c', maxRows: 3 });

      expect(answer.map(d => d._id)).toEqual([0, 1, 2]);
      expect(answer.truncated).toBe(true);
      expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
    });

    test('redis caps a collection read that has no limit of its own', async () => {
      const values = Array.from({ length: 50 }, (_, i) => `member:${i}`);
      const client = redisClient(values);
      const adapter = new RedisAdapter(() => client, 30000);
      await adapter.connect('redis://h:6379');

      const answer = await adapter.execute('SMEMBERS myset', { maxRows: 3 });

      expect(answer).toEqual(values.slice(0, 3));
      expect(answer.truncated).toBe(true);
      expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
    });

    test('a complete answer is not marked', async () => {
      const client = redisClient(['a', 'b']);
      const adapter = new RedisAdapter(() => client, 30000);
      await adapter.connect('redis://h:6379');

      const answer = await adapter.execute('SMEMBERS small', { maxRows: 10 });

      expect(answer.truncated).toBeUndefined();
    });
  });

  describe('a statement that changes the connection is refused', () => {
    // All four of these adapters hand the *same* connection to the next caller.
    // A `BEGIN`, a `SELECT 1` or an empty `deleteMany` does not change the
    // database, it changes the connection, and nothing in the response says so -
    // so the next call inherits it and the failure lands on somebody else.
    test.each([
      ['postgres', '[Postgres transactions are not supported]', 'BEGIN'],
      ['mysql', '[MySQL transactions are not supported]', 'BEGIN'],
      ['redis', '[Redis connection state]', 'SELECT 1']
    ])('%s refuses %p', async (_backend, expected, command) => {
      let adapter;
      if (expected.startsWith('[Postgres')) {
        adapter = new PostgresAdapter(function Pool() {
          return { connect: async () => pgClientDelivering([]), query: jest.fn(), end: jest.fn() };
        }, 30000, undefined, ScriptedQuery);
        await adapter.connect('postgres://h/d');
      } else if (expected.startsWith('[MySQL')) {
        const sent = [];
        adapter = new MySQLAdapter(() => ({
          query: jest.fn((...args) => { sent.push(args); return Promise.resolve([[], []]); }),
          getConnection: jest.fn(),
          end: jest.fn()
        }), 30000);
        await adapter.connect('mysql://h/d');
        adapter.sent = sent;
      } else {
        const client = redisClient('OK');
        adapter = new RedisAdapter(() => client, 30000);
        await adapter.connect('redis://h:6379');
        adapter.client = client;
      }

      const error = await adapter.execute(command, { readOnly: false }).catch(e => e);

      expect(error.message).toContain(expected);
      // And it says what a real transaction would need, rather than only that
      // this one is not allowed.
      expect(error.message).toMatch(/pins one (connection|handle) across calls/);
    });

    test('mongodb refuses a filter that would match every document', async () => {
      const find = jest.fn();
      const adapter = new MongoAdapter(function Client() {
        return {
          connect: jest.fn().mockResolvedValue(undefined),
          close: jest.fn().mockResolvedValue(undefined),
          topology: { isConnected: () => true },
          db: () => ({ collection: () => ({ find, deleteMany: jest.fn() }) })
        };
      }, 30000);
      await adapter.connect('mongodb://h:27017/d');

      const error = await adapter.execute('{}', { collection: 'c', action: 'delete', readOnly: false })
        .catch(e => e);

      expect(error.message).toMatch(/matches every document/);
      expect(find).not.toHaveBeenCalled();
    });
  });

  describe('loadSqlite3', () => {
    test('loads the real driver, once, and reuses it', async () => {
      const first = await loadSqlite3();
      const second = await loadSqlite3();

      expect(typeof first.default.Database).toBe('function');
      // The same promise, not a second import: the driver is a native binding
      // and importing it again is not free.
      expect(second).toBe(first);
    });

    // The failure branch a consumer actually hits: npm blocks the sqlite3
    // install script, so the import rejects. A fresh module registry is needed
    // because a *successful* load is memoised for the life of the module, and
    // this assertion is about the other path.
    test('says how to fix a missing native binding', async () => {
      let message;
      await jest.isolateModulesAsync(async () => {
        jest.doMock('sqlite3', () => {
          throw new Error('Cannot find module \'./build/Release/node_sqlite3.node\'');
        });
        try {
          const { loadSqlite3: load } = require('../src/adapters/sqlite.js');
          await load();
        } catch (err) {
          message = err.message;
        } finally {
          jest.dontMock('sqlite3');
        }
      });

      expect(message).toMatch(/sqlite3 native binding was not built/);
      // Both repairs, because there are two, and the second is the one npm's
      // own error message never mentions.
      expect(message).toMatch(/install-scripts approve sqlite3/);
      expect(message).toMatch(/npm rebuild sqlite3/);
      // And the scope of the damage: the other four are unaffected.
      expect(message).toMatch(/other four databases are unaffected/);
    });
  });
});
