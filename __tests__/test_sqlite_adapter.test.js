import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import realSqlite3 from 'sqlite3';
import { SQLiteAdapter, OPEN, loadSqlite3 } from '../src/adapters/sqlite.js';
import { TimeoutError } from '../src/core/base-adapter.js';

// Read from the working directory rather than import.meta, which babel cannot
// compile to CommonJS.
const ADAPTER_SOURCE = readFileSync(join(process.cwd(), 'src', 'adapters', 'sqlite.js'), 'utf8');

const OPEN_FLAGS = {
  READONLY: realSqlite3.OPEN_READONLY,
  READWRITE: realSqlite3.OPEN_READWRITE,
  CREATE: realSqlite3.OPEN_CREATE,
  URI: realSqlite3.OPEN_URI,
  FULLMUTEX: realSqlite3.OPEN_FULLMUTEX,
  SHAREDCACHE: realSqlite3.OPEN_SHAREDCACHE,
  PRIVATECACHE: realSqlite3.OPEN_PRIVATECACHE,
};

/** A stand-in for a sqlite3 Database handle. */
class MockDatabase extends EventEmitter {
  constructor(path, mode, openCallback) {
    super();
    this.path = path;
    this.mode = mode;
    this.all = jest.fn((sql, params, cb) => cb(null, []));
    this.each = jest.fn((sql, params, rowCb, done) => done(null));
    this.get = jest.fn((sql, params, cb) => cb(null, { ok: 1 }));
  // `db.run`'s callback is invoked with the Statement as `this`, which is where the
  // driver puts `changes` and `lastID`. Reading them off the handle instead
  // reliably answers zero, because `Database.prototype.run` finalises the statement
  // before the callback runs.
    this.run = jest.fn((sql, params, cb) => {
      if (typeof params === 'function') { cb = params; params = []; }
      cb.call({ changes: 1, lastID: 7 }, null);
      return this;
    });
    this.close = jest.fn((cb) => cb(null));
    this.interrupt = jest.fn();
    this.configure = jest.fn();
    this.open = true;
    // The driver opens the file asynchronously and reports it through this
    // callback, which is why `connect()` waits for it: a double that never
    // called back would make every connect here look like a hung driver.
    if (typeof openCallback === 'function') setImmediate(() => openCallback(null));
  }
}

/**
 * A `Database` constructor double that answers the open callback the adapter
 * passes and waits for.
 *
 * `sqlite3_open_v2` is asynchronous, so `connect()` resolves when the driver
 * reports the file open. A double that ignored that callback would leave every
 * connect here looking like a hung driver, so the callback is delivered the way
 * the driver delivers it: on a later turn, never synchronously.
 */
const constructorFor = (db) => jest.fn((path, mode, openCallback) => {
  db.path = path;
  db.mode = mode;
  if (typeof openCallback === 'function') setImmediate(() => openCallback(null));
  return db;
});

describe('SQLiteAdapter', () => {
  let adapter;
  let mockDb;
  let mockDatabaseConstructor;
  let stderr;

  beforeEach(() => {
    mockDb = new MockDatabase();
    mockDatabaseConstructor = constructorFor(mockDb);
    adapter = new SQLiteAdapter(mockDatabaseConstructor, 30000);
    stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  const connect = (uri = 'sqlite:///path/to/database.db') => adapter.connect(uri);

  /** The flags the adapter asked sqlite3_open_v2 for. */
  const mode = () => mockDatabaseConstructor.mock.calls[0][1];

  describe('driver shape', () => {
    // The driver facts the URI handling and the health check depend on, read
    // rather than assumed.
    test('the real Database takes a path, a mode, and an open callback', () => {
      const source = readFileSync(
        join(process.cwd(), 'node_modules', 'sqlite3', 'src', 'database.cc'),
        'utf8'
      );
      expect(source).toContain('Database::Database(const Napi::CallbackInfo& info)');
      expect(source).toContain('mode = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX;');
      expect(source).toContain('sqlite3_open_v2(');
      // 1s, which is what made a contended database give up before the caller's
      // budget was a tenth spent.
      expect(source).toContain('sqlite3_busy_timeout(db->_handle, 1000);');
      expect(source).toContain('InstanceAccessor("open"');
    });

    // There is no `stmt.iterate()` in node-sqlite3: it is better-sqlite3's API.
    // The instance method list at the top of statement.cc is the whole surface.
    test('node-sqlite3 has each but not iterate, and each cannot stop early', () => {
      const methods = readFileSync(
        join(process.cwd(), 'node_modules', 'sqlite3', 'src', 'statement.cc'),
        'utf8'
      );
      expect(methods).toContain('InstanceMethod("each", &Statement::Each');
      expect(methods).not.toContain('InstanceMethod("iterate"');

      // `Work_Each` steps to SQLITE_DONE before any row reaches JavaScript, so
      // a cap on this side bounds the JS heap and not the database's work.
      const work = methods.slice(methods.indexOf('void Statement::Work_Each'));
      expect(work).toContain('while (true)');
      expect(work.slice(0, 1200)).toContain('stmt->status != SQLITE_DONE');
    });

    test('an array first argument is expanded into the bind list', () => {
      const bind = readFileSync(
        join(process.cwd(), 'node_modules', 'sqlite3', 'src', 'statement.cc'),
        'utf8'
      );
      expect(bind).toContain('if (info[start].IsArray()) {');
    });
  });

  describe('loadSqlite3', () => {
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

    // The whole failure branch of loadSqlite3, which the e2e suite used to be
    // the only cover of — and which runs in an uninstrumented child process, so
    // it contributed nothing to the metric.
    test('loads the real driver on first use', async () => {
      const lazy = new SQLiteAdapter();
      const Database = await lazy.loadDatabase();
      expect(Database).toBe(realSqlite3.Database);
      // Cached, so a second call does not import again.
      expect(await lazy.loadDatabase()).toBe(Database);
    });


  });

  describe('connect', () => {
    test('opens the file path from the URI', async () => {
      await connect('sqlite:///C:/databases/test.db');
      expect(mockDatabaseConstructor).toHaveBeenCalledWith('C:/databases/test.db', expect.any(Number), expect.any(Function));
    });

    test('accepts the in-memory form', async () => {
      await connect('sqlite://:memory:');
      expect(mockDatabaseConstructor).toHaveBeenCalledWith(':memory:', expect.any(Number), expect.any(Function));
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

    // The query string used to be cut off at the `?`, so this opened the file
    // read-write: a caller who explicitly asked for read-only got the opposite,
    // silently.
    test('opens read-only for ?mode=ro instead of silently opening read-write', async () => {
      await connect('sqlite:///app.db?mode=ro');

      expect(mockDatabaseConstructor).toHaveBeenCalledWith('/app.db', expect.any(Number), expect.any(Function));
      expect(mode() & OPEN_FLAGS.READONLY).toBeTruthy();
      expect(mode() & OPEN_FLAGS.READWRITE).toBe(0);
      expect(mode() & OPEN_FLAGS.CREATE).toBe(0);
    });

    test('opens read-write for ?mode=rwc', async () => {
      await connect('sqlite:///app.db?mode=rwc');
      expect(mode() & OPEN_FLAGS.READWRITE).toBeTruthy();
      expect(mode() & OPEN_FLAGS.CREATE).toBeTruthy();
      expect(mode() & OPEN_FLAGS.READONLY).toBe(0);
    });

  // A `mode` this module cannot read is a constraint it cannot honour, and the
  // only safe reading of "I asked for roo" is not "then you get write". It used to
  // fall through to `unknown`, which logged one line and opened read-write.
  // `mode=RO` is deliberately not here: SQLite's own URI parser compares the value
  // case-insensitively, so upper case is a spelling and not a typo.
    test.each(['roo', 'readonly', 'read-only', 'rwx', 'w', ''])('refuses an unreadable mode rather than opening read-write: ?mode=%s', async (value) => {
      await expect(connect(`sqlite:///app.db?mode=${value}`)).rejects.toThrow(/\[SQLite mode\]/);
      await expect(connect(`sqlite:///app.db?mode=${value}`)).rejects.toThrow(/mode=ro/);
      expect(mockDatabaseConstructor).not.toHaveBeenCalled();
    });

    // And the distinction is deliberate: an unknown *non-security* parameter is
    // still only warned about, because refusing a connection over `?foo=1`
    // would be a worse failure than saying so.
    test('still only warns about an unknown parameter that is not a mode', async () => {
      await connect('sqlite:///app.db?notaproduct=1');
      expect(mode() & OPEN_FLAGS.READWRITE).toBeTruthy();
    });

    test('reads only a path when the URI names no mode', async () => {
      await connect('sqlite:///path/to/db.sqlite');
      expect(mockDatabaseConstructor.mock.calls[0][0]).toBe('/path/to/db.sqlite');
      expect(mode() & OPEN_FLAGS.READWRITE).toBeTruthy();
    });

    // SQLite documents `immutable` as "the file cannot change", so a write
    // through such a handle is undefined behaviour rather than an error.
    test('treats immutable=1 as read-only', async () => {
      await connect('sqlite:///app.db?immutable=1');
      expect(mode() & OPEN_FLAGS.READONLY).toBeTruthy();
    });

    test('honours ?cache=shared and ?cache=private', async () => {
      // Two adapters, each with its own constructor spy: the second connect() on
      // one adapter reuses the driver class it already resolved, so the mode
      // would be read off the first call.
      const sharedDb = new MockDatabase();
      const sharedCtor = constructorFor(sharedDb);
      await new SQLiteAdapter(sharedCtor, 30000).connect('sqlite:///a.db?cache=shared');
      expect(sharedCtor.mock.calls[0][1] & OPEN_FLAGS.SHAREDCACHE).toBeTruthy();

      const privateDb = new MockDatabase();
      const privateCtor = constructorFor(privateDb);
      await new SQLiteAdapter(privateCtor, 30000).connect('sqlite:///a.db?cache=private');
      expect(privateCtor.mock.calls[0][1] & OPEN_FLAGS.PRIVATECACHE).toBeTruthy();
    });

    test('sets OPEN_URI and OPEN_FULLMUTEX, because the handle is shared', async () => {
      await connect();
      // The connection cache permits concurrent use of one adapter, and a
      // SQLITE_OPEN_NOMUTEX handle is not safe to use from two threads.
      expect(mode() & OPEN_FLAGS.URI).toBeTruthy();
      expect(mode() & OPEN_FLAGS.FULLMUTEX).toBeTruthy();
    });

    test('the mode constants are the real sqlite3 ones', () => {
      expect(OPEN.READONLY).toBe(realSqlite3.OPEN_READONLY);
      expect(OPEN.READWRITE).toBe(realSqlite3.OPEN_READWRITE);
      expect(OPEN.CREATE).toBe(realSqlite3.OPEN_CREATE);
      expect(OPEN.URI).toBe(realSqlite3.OPEN_URI);
      expect(OPEN.FULLMUTEX).toBe(realSqlite3.OPEN_FULLMUTEX);
      expect(OPEN.SHAREDCACHE).toBe(realSqlite3.OPEN_SHAREDCACHE);
      expect(OPEN.PRIVATECACHE).toBe(realSqlite3.OPEN_PRIVATECACHE);
    });

    // PRAGMA is on the read-only blocklist, so the agent can never ask for these.
    test('asks for a longer lock wait than sqlite3\'s one-second default', async () => {
      await connect();
      expect(mockDb.configure).toHaveBeenCalledWith('busyTimeout', 5000);
    });

    test('takes the lock wait from the environment, and falls back for nonsense', async () => {
      const saved = process.env.ANYDB_SQLITE_BUSY_TIMEOUT_MS;
      process.env.ANYDB_SQLITE_BUSY_TIMEOUT_MS = '9000';
      const a = new SQLiteAdapter(MockDatabase, 30000);
      const db = new MockDatabase();
      await a.connect('sqlite://:memory:');
      expect(db.configure).toBeTruthy();

      process.env.ANYDB_SQLITE_BUSY_TIMEOUT_MS = 'soon';
      const b = new SQLiteAdapter(MockDatabase, 30000);
      const db2 = new MockDatabase();
      b.DatabaseClass = constructorFor(db2);
      await b.connect('sqlite://:memory:');
      expect(db2.configure).toHaveBeenCalledWith('busyTimeout', 5000);

      if (saved === undefined) delete process.env.ANYDB_SQLITE_BUSY_TIMEOUT_MS;
      else process.env.ANYDB_SQLITE_BUSY_TIMEOUT_MS = saved;
    });

    test('puts the journal in WAL, which the agent could never ask for', async () => {
      await connect('sqlite:///app.db');
      await new Promise(resolve => setImmediate(resolve));
      expect(mockDb.all.mock.calls.some(call => /journal_mode = WAL/.test(call[0]))).toBe(true);
    });

    test('does not ask for WAL on a read-only handle or an in-memory database', async () => {
      await connect('sqlite:///app.db?mode=ro');
      await connect('sqlite://:memory:');
      await new Promise(resolve => setImmediate(resolve));
      expect(mockDb.all.mock.calls.some(call => /journal_mode = WAL/.test(call[0]))).toBe(false);
    });

    // A parameter on a URI whose payload is a file path is the one place where
    // being wrong is destructive rather than merely inconvenient.
    test('warns about a parameter it does not honour', async () => {
      await connect('sqlite:///app.db?vfs=unix-dotfile');
      const logged = stderr.mock.calls.map(call => String(call[0])).join('\n');
      expect(logged).toContain('vfs=unix-dotfile');
      expect(logged).toContain('not honoured');
    });

    test('says nothing when every parameter was honoured', async () => {
      await connect('sqlite:///app.db?mode=ro&immutable=1&cache=shared');
      const logged = stderr.mock.calls.map(call => String(call[0])).join('\n');
      expect(logged).not.toContain('not honoured');
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      await connect();
      // The WAL PRAGMA connect() fires is a real statement on the same handle.
      mockDb.all.mockClear();
      mockDb.run.mockClear();
    });

    test('returns rows', async () => {
      mockDb.all.mockImplementation((sql, params, cb) => cb(null, [{ id: 1 }]));
      await expect(adapter.execute('SELECT 1')).resolves.toEqual([{ id: 1 }]);
    });

    // The hardcoded `[]` this replaced meant an agent had to inline every value
    // into the statement text.
    test('binds ? placeholders to the values array', async () => {
      mockDb.all.mockImplementation((sql, params, cb) => cb(null, [{ id: 1 }]));

      await adapter.execute('SELECT * FROM t WHERE a = ? AND b = ?', { params: [1, 'x'] });

      const call = mockDb.all.mock.calls.find(call => /SELECT/.test(call[0]));
      expect(call[1]).toEqual([1, 'x']);
    });

    test('binds values for a write as well, through db.run', async () => {
      await adapter.execute('DELETE FROM t WHERE a = ?', { params: [3] });

      expect(mockDb.run.mock.calls[0][1]).toEqual([3]);
    });

    test('refuses a params value that is not an array', async () => {
      await expect(adapter.execute('SELECT ?', { params: 'nope' }))
        .rejects.toThrow("'params' must be an array");
    });

    test('refuses undefined rather than sending it as NULL', async () => {
      await expect(adapter.execute('SELECT ?', { params: [undefined] }))
        .rejects.toThrow('contains undefined');
    });

    // db.all() answers `[]` for a successful UPDATE, where Postgres returns
    // {affectedRows, command} and MySQL {affectedRows, insertId}. The unified
    // shape is what lets a model treat all five databases the same way.
    test('reports a write the way the other backends do', async () => {
      await expect(adapter.execute('UPDATE t SET a = 1 WHERE b = 2'))
        .resolves.toEqual([{ affectedRows: 1, lastId: 7, command: 'UPDATE' }]);
      expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('reports an insert with its last row id', async () => {
      await expect(adapter.execute('INSERT INTO t (a) VALUES (1)'))
        .resolves.toEqual([{ affectedRows: 1, lastId: 7, command: 'INSERT' }]);
    });

    test('reads the leading keyword past a comment', async () => {
      const rows = await adapter.execute('-- fix later\nUPDATE t SET a = 1');
      expect(rows[0].command).toBe('UPDATE');
    });

    test('leaves a SELECT as rows, not a status', async () => {
      mockDb.all.mockImplementation((sql, params, cb) => cb(null, [{ id: 1 }]));
      await expect(adapter.execute('SELECT 1')).resolves.toEqual([{ id: 1 }]);
    });

    test('reports a missing table', async () => {
      mockDb.all.mockImplementation((sql, params, cb) =>
        cb(Object.assign(new Error('SQLITE_ERROR: no such table: t'), { code: 'SQLITE_ERROR' })));

      await expect(adapter.execute('SELECT * FROM t'))
        .rejects.toThrow('[SQLite error] no such table: t');
    });

    test('reports a missing table from a write too', async () => {
      mockDb.run.mockImplementation((sql, params, cb) => {
        cb.call({}, Object.assign(new Error('SQLITE_ERROR: no such table: t'), { code: 'SQLITE_ERROR' }));
      });

      await expect(adapter.execute('DELETE FROM t'))
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

    test('explains a write to a handle the URI opened read-only', async () => {
      mockDb.run.mockImplementation((sql, params, cb) => {
        cb.call({}, Object.assign(new Error('SQLITE_READONLY: attempt to write a readonly database'), {
          code: 'SQLITE_READONLY'
        }));
      });

      await expect(adapter.execute('UPDATE t SET a = 1'))
        .rejects.toThrow('opened the database read-only');
    });

    test('gives up after the query timeout', async () => {
      const db = new MockDatabase();
      const slow = new SQLiteAdapter(constructorFor(db), 60);
      await slow.connect('sqlite:///path/to/database.db');
      db.all.mockImplementation(() => { /* never calls back */ });

      await expect(slow.execute('SELECT 1')).rejects.toThrow(/exceeded 60ms timeout/);
    });

    test('takes its budget from the call, not from a field on the shared adapter', async () => {
      const db = new MockDatabase();
      const slow = new SQLiteAdapter(constructorFor(db), 30000);
      await slow.connect('sqlite:///path/to/database.db');
      db.all.mockImplementation(() => { /* never calls back */ });

      await expect(slow.execute('SELECT 1', { timeout: 60 }))
        .rejects.toThrow(/exceeded 60ms timeout/);
    });

    // The timeout path is a `TimeoutError`, not a plain `Error`, so
    // `error instanceof TimeoutError` in `src/index.js` sees it and the caller
    // is told the statement ran out of time rather than that the SQL was wrong.
    // The class is imported rather than matched on the message because the
    // message is exactly what the assertion below is not supposed to rely on.
    test('a query timeout is a TimeoutError, so the timeout advice is reachable', async () => {
      const db = new MockDatabase();
      const slow = new SQLiteAdapter(constructorFor(db), 60);
      await slow.connect('sqlite:///path/to/database.db');
      db.all.mockImplementation(() => { /* never calls back */ });

      await expect(slow.execute('SELECT 1')).rejects.toBeInstanceOf(TimeoutError);
    });

    // A health check has its own message and is reached through the same guard,
    // so the promotion to a real class is not a statement-timeout-only change.
    test('the guard rejects with a TimeoutError whatever the operation was', async () => {
      const db = new MockDatabase();
      const live = new SQLiteAdapter(constructorFor(db), 60);
      await live.connect('sqlite:///path/to/database.db');
      db.get.mockImplementation(() => { /* never calls back */ });

      // `run()` is the shared path both `execute()` and `isHealthy()` go through.
      await expect(live.run((cb) => db.get('SELECT 1', [], cb), 60, 'health', 'custom health message'))
        .rejects.toBeInstanceOf(TimeoutError);
    });
  });

  // An unopenable path must fail fast, name itself, and not leave a timer behind
  // it. `connect()` awaits the driver's open callback, which is right, but the
  // wait was bounded by a constant and nothing marked the handle un-openable when
  // the failure arrived through the *callback* rather than an 'error' event — which
  // on the installed sqlite3 is the ordinary way, so every unopenable path also
  // cost a full five-second `close()`.
  describe('an unopenable path', () => {
    /** A driver whose open callback never fires: the case the guard exists for. */
    const silentConstructor = () => {
      const db = new MockDatabase();
      const ctor = jest.fn((path) => { db.path = path; return db; });
      return { db, ctor };
    };

    test('fails with SQLITE_CANTOPEN as soon as the driver says so, and names the path', async () => {
      const db = new MockDatabase();
      const ctor = jest.fn((path, mode, openCallback) => {
        db.path = path;
        setImmediate(() => openCallback(Object.assign(
          new Error('SQLITE_CANTOPEN: unable to open database file'),
          { code: 'SQLITE_CANTOPEN' }
        )));
        return db;
      });
      const live = new SQLiteAdapter(ctor, 30000);
      const target = '/data/app.db';

      const startedAt = Date.now();
      await expect(live.connect(`sqlite://${target}`)).rejects.toThrow(/SQLITE_CANTOPEN/);
      const elapsed = Date.now() - startedAt;

      // Well inside the 30 s default, by three orders of magnitude.
      expect(elapsed).toBeLessThan(1000);
      // The path the driver was actually given, so the message is actionable
      // rather than a general "check your URI".
      await expect(live.connect(`sqlite://${target}`))
        .rejects.toThrow(new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    test('a real path that cannot be opened fails fast, and close() does not wait', async () => {
      // Against the real driver, because the claim is about sqlite3: which of the
      // two channels it uses to report a failed open, and when.
      const dir = mkdtempSync(join(tmpdir(), 'anydb-cantopen-'));
      try {
        const bad = join(dir, 'no-such-dir', 'x.db');
        const live = new SQLiteAdapter(realSqlite3.Database, 30000);

        const startedAt = Date.now();
        await expect(live.connect(`sqlite:///${bad.replace(/\\/g, '/')}`))
          .rejects.toThrow(/SQLITE_CANTOPEN/);
        expect(Date.now() - startedAt).toBeLessThan(1000);

        // The half that was the five-second burn: the handle never opened, so
        // there is nothing to hand back and sqlite3 never calls the close
        // callback. `close()` has to know that from the callback path too.
        const closedAt = Date.now();
        await live.close();
        expect(Date.now() - closedAt).toBeLessThan(1000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('a driver that never calls back is bounded by the caller\'s budget', async () => {
      const { db, ctor } = silentConstructor();
      const live = new SQLiteAdapter(ctor, 30000);

      const startedAt = Date.now();
      await expect(live.connect('sqlite:///data/app.db', { timeout: 120 }))
        .rejects.toThrow(/did not report ".*app\.db" as open within \d+ms/);
      const elapsed = Date.now() - startedAt;

      // The caller's 120 ms, not the adapter's 30 s default: a caller who says it
      // has 120 ms must not be held for ten seconds.
      expect(elapsed).toBeLessThan(2000);
      // …and the message says which path and which bound, because "timed out" on
      // a local file is nearly always a path that does not exist.
      expect(db.path).toBe('/data/app.db');
    });

    test('a huge budget cannot turn a bad path into a long stall', async () => {
      // Fake timers, because the assertion is about the *bound* and the bound is
      // ten seconds. Advancing them is how this costs nothing and still pins the
      // number: a caller who asks for twenty-four hours gets the ceiling, not
      // their budget.
      jest.useFakeTimers();
      try {
        const { ctor } = silentConstructor();
        const live = new SQLiteAdapter(ctor, 30000);

        const pending = live.connect('sqlite:///data/app.db', { timeout: 24 * 60 * 60 * 1000 });
        const assertion = expect(pending).rejects.toThrow(/did not report ".*app\.db" as open within 10000ms/);

        await jest.advanceTimersByTimeAsync(9999);
        await jest.advanceTimersByTimeAsync(1);
        await assertion;
      } finally {
        jest.useRealTimers();
      }
    });

    test('a budget of 1ms still lets the driver have a turn of the loop', async () => {
      // The floor. Without it the guard aborts before the open callback can be
      // delivered, and a perfectly good database is reported as unopenable.
      const db = new MockDatabase();
      const ctor = constructorFor(db);
      const live = new SQLiteAdapter(ctor, 30000);
      await expect(live.connect('sqlite:///path/to/database.db', { timeout: 1 })).resolves.toBeUndefined();
    });
  });

  describe('concurrent calls on one shared handle', () => {
  // The cache explicitly permits concurrent use of one adapter, and the guard used
  // to be a single slot on it: two calls put their rejectors in the same field, so
  // an `error` event rejected whichever request happened to be in it and the first
  // `finally` nulled the second's, dropping a real failure on the floor.
    beforeEach(() => connect());

    test('rejects only the call the error belongs to', async () => {
      const started = [];
      mockDb.all.mockImplementation((sql, params, cb) => { started.push(sql); });

      const first = adapter.execute('SELECT 1');
      const second = adapter.execute('SELECT 2');
      await new Promise(resolve => setImmediate(resolve));
      expect(started).toHaveLength(2);

      mockDb.emit('error', new Error('disk I/O error'));
      await expect(first).rejects.toThrow('disk I/O error');
      await expect(second).rejects.toThrow('disk I/O error');
    });

    test('does not let one call tear down another call\'s guard', async () => {
      const outcomes = new Map();
      mockDb.all.mockImplementation((sql, params, cb) => { outcomes.set(sql, cb); });

      const first = adapter.execute('SELECT 1');
      const second = adapter.execute('SELECT 2');
      await new Promise(resolve => setImmediate(resolve));

      // The second call finishes cleanly and clears its own bookkeeping. If the
      // guard were a shared slot, the first call's 'error' would now have
      // nowhere to go and would be lost.
      outcomes.get('SELECT 2')(null, [{ ok: true }]);
      await expect(second).resolves.toEqual([{ ok: true }]);

      outcomes.get('SELECT 1')(new Error('SQLITE_IOERR: disk I/O error'));
      await expect(first).rejects.toThrow('disk I/O error');
    });

    test('forgets its calls once they are done', async () => {
      mockDb.all.mockImplementation((sql, params, cb) => cb(null, []));
      await adapter.execute('SELECT 1');
      expect(adapter.inFlight.size).toBe(0);
    });
  });

  describe('maxRows', () => {
    beforeEach(() => connect());

    test('accumulates through each, which is the streaming form', async () => {
      mockDb.all.mockClear();
      mockDb.each.mockImplementation((sql, params, rowCb, done) => {
        rowCb(null, { id: 1 });
        rowCb(null, { id: 2 });
        done(null);
      });

      const rows = await adapter.execute('SELECT * FROM t', { maxRows: 5 });

      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('stops at the cap and marks the answer, which is a prefix not a sample', async () => {
      mockDb.each.mockImplementation((sql, params, rowCb, done) => {
        for (const id of [1, 2, 3, 4]) rowCb(null, { id });
        done(null);
      });

      const rows = await adapter.execute('SELECT * FROM t', { maxRows: 2 });

      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(rows.truncated).toBe(true);
      expect(JSON.parse(JSON.stringify(rows))).toEqual([{ id: 1 }, { id: 2 }]);
    });

    test('binds values through the streaming form too', async () => {
      mockDb.each.mockImplementation((sql, params, rowCb, done) => done(null));

      await adapter.execute('SELECT * FROM t WHERE a = ?', { params: [1], maxRows: 5 });

      expect(mockDb.each.mock.calls[0][1]).toEqual([1]);
    });

    test('reports a write as a status object, because db.each returns no rows', async () => {
      mockDb.each.mockImplementation((sql, params, rowCb, done) => done(null));

      const rows = await adapter.execute('DELETE FROM t WHERE a = ?', { params: [1], maxRows: 5 });

      // A write never returns rows, so the cap changes nothing about how it is
      // reported — it is still the same status object the uncapped path gives.
      expect(rows).toEqual([{ affectedRows: 1, lastId: 7, command: 'DELETE' }]);
    });

    // `each` reports a failure in its completion callback, and swallowing that
    // turns a failed query into a successful empty result.
    test('does not turn a failure into a successful empty result', async () => {
      mockDb.each.mockImplementation((sql, params, rowCb, done) => {
        done(new Error('SQLITE_ERROR: no such table: t'));
      });

      await expect(adapter.execute('SELECT * FROM t', { maxRows: 5 }))
        .rejects.toThrow('no such table: t');
    });

    test('reports a failure raised on a row', async () => {
      mockDb.each.mockImplementation((sql, params, rowCb, done) => {
        rowCb(new Error('SQLITE_CORRUPT: database disk image is malformed'));
        done(null);
      });

      await expect(adapter.execute('SELECT * FROM t', { maxRows: 5 }))
        .rejects.toThrow('[SQLite corrupt]');
    });

    test('treats maxRows: 0 as no cap rather than as no rows', async () => {
      mockDb.all.mockImplementation((sql, params, cb) => cb(null, [{ id: 1 }]));
      await expect(adapter.execute('SELECT 1', { maxRows: 0 })).resolves.toEqual([{ id: 1 }]);
    });
  });

  describe('isHealthy', () => {
    // The old answer was `!!this.db && !this.aborted`, which reported a handle
    // that had just failed a write — disk full, SQLITE_CORRUPT — as perfectly
    // healthy, which is the assumed-alive case the cache has to avoid.
    test('pings the handle rather than assuming it', async () => {
      await connect();

      await expect(adapter.isHealthy()).resolves.toBe(true);
      expect(mockDb.get).toHaveBeenCalledWith('SELECT 1 AS ok', [], expect.any(Function));
    });

    test('is false with no handle', async () => {
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });

    test('is false after an abort', async () => {
      await connect();
      adapter.abort();
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });

    test('is false once a fatal error has been seen', async () => {
      await connect();
      mockDb.run.mockImplementation((sql, params, cb) => {
        cb.call({}, Object.assign(new Error('SQLITE_FULL: database or disk is full'), {
          code: 'SQLITE_FULL'
        }));
      });

      await adapter.execute('INSERT INTO t (a) VALUES (1)').catch(() => {});

      // A full disk is a property of the handle now, not of the one statement:
      // every later statement fails the same way, and the cache has no other way
      // to know.
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });

    test('does not latch a contention error, which is a property of the moment', async () => {
      await connect();
      mockDb.all.mockImplementation((sql, params, cb) =>
        cb(Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' })));

      await adapter.execute('SELECT 1').catch(() => {});

      // Latching a busy would throw away a good connection over an ordinary
      // write lock.
      await expect(adapter.isHealthy()).resolves.toBe(true);
    });

    test('is false when the driver says the handle is closed', async () => {
      await connect();
      mockDb.open = false;
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });

    test('is false when the ping itself fails', async () => {
      await connect();
      mockDb.get.mockImplementation((sql, params, cb) =>
        cb(new Error('SQLITE_NOTADB: file is not a database')));
      await expect(adapter.isHealthy()).resolves.toBe(false);
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

    // abort() only calls sqlite3_interrupt, which cancels a running statement
    // and leaves the handle open. The old `|| this.aborted` here skipped the
    // close and leaked the handle and its file descriptor for the life of the
    // process.
    test('closes an interrupted handle, which can still be closed', async () => {
      await connect();
      adapter.abort();

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

    test('fails the calls still running on the handle', async () => {
      await connect();
      mockDb.all.mockImplementation(() => { /* never calls back */ });
      const running = adapter.execute('SELECT 1');
      await new Promise(resolve => setImmediate(resolve));

      await adapter.close();

      await expect(running).rejects.toThrow('SQLite connection closed');
    });
  });

  describe('describe', () => {
    // The schema tests reached the *SchemaAdapter class directly, which left
    // the `new …; schema.db = …` wiring in the adapter as untested code.
    test('hands the schema adapter the live handle', async () => {
      await connect();
      mockDb.all.mockImplementation((sql, params, cb) => cb(null, []));

      const out = await adapter.describe({});

      expect(out.database).toBe('sqlite');
      expect(out.tables).toEqual([]);
    });

    test('reports a locked database the same way db_query does', async () => {
      await connect();
      mockDb.all.mockImplementation((sql, params, cb) => {
        if (/pragma_table_xinfo/.test(sql)) return cb(new Error('no such table'));
        return cb(new Error('SQLITE_BUSY: database is locked'));
      });

      await expect(adapter.describe({})).rejects.toThrow('[SQLite locked]');
    });
  });

  // Everything above is against a double. These run against the real driver, so
  // the statements the adapter writes are known to be valid SQL and the counters
  // it reads are known to be where the driver puts them.
  describe('against the real driver', () => {
    let db;

    beforeEach(() => {
      db = new realSqlite3.Database(':memory:', OPEN.READWRITE | OPEN.CREATE);
      db.configure('busyTimeout', 1000);
    });

    afterEach(() => new Promise(resolve => { db.close(() => resolve()); }));

    const exec = (sql) => new Promise((resolve, reject) => {
      db.exec(sql, (err) => (err ? reject(err) : resolve()));
    });

    const attach = () => {
      const adapter = new SQLiteAdapter(realSqlite3.Database, 30000);
      adapter.db = db;
      return adapter;
    };

    it('binds values through a real prepared statement', async () => {
      await exec('CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT)');
      const live = attach();

      await expect(live.execute('INSERT INTO t (id, email) VALUES (?, ?)', {
        params: [1, "a'b; DROP TABLE t"]
      })).resolves.toEqual([{ affectedRows: 1, lastId: 1, command: 'INSERT' }]);

      // The value went in as a value, not as statement text.
      const rows = await live.execute('SELECT email FROM t WHERE id = ?', { params: [1] });
      expect(rows).toEqual([{ email: "a'b; DROP TABLE t" }]);
    });

    it('reports a write with the real changes and lastID', async () => {
      await exec('CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT)');
      const live = attach();

      const inserted = await live.execute("INSERT INTO t (email) VALUES ('a'), ('b')");
      expect(inserted).toEqual([{ affectedRows: 2, lastId: 2, command: 'INSERT' }]);

  // `changes` and `lastID` are only set on the Statement, and only when the call
  // was given a callback — which `db.all()` is not. Reading them off the handle
  // afterwards answers zero, which is what this asserts against.
  //
  // `lastId` is 2 on the DELETE because `sqlite3_last_insert_rowid` is not reset by
  // a statement that inserts nothing. That is the driver's semantics, reported
  // rather than smoothed over.
      await expect(live.execute('DELETE FROM t'))
        .resolves.toEqual([{ affectedRows: 2, lastId: 2, command: 'DELETE' }]);
    });

    it('accumulates a capped result through each', async () => {
      await exec('CREATE TABLE t (id INTEGER)');
      for (let i = 0; i < 10; i++) await exec(`INSERT INTO t VALUES (${i})`);
      const live = attach();

      const rows = await live.execute('SELECT id FROM t ORDER BY id', { maxRows: 3 });

      expect(rows).toHaveLength(3);
      expect(rows.truncated).toBe(true);
      expect(rows.map(r => r.id)).toEqual([0, 1, 2]);
    });

    it('refuses a write on a read-only handle, and says why', async () => {
      const path = join(process.cwd(), '.tmp-anydb-ro.db');
      require('node:fs').rmSync(path, { force: true });
      const file = new realSqlite3.Database(path);
      await new Promise((resolve) => file.close(resolve));

      const ro = new SQLiteAdapter(realSqlite3.Database, 30000);
      await ro.connect(`sqlite://${path.replace(/\\/g, '/')}?mode=ro`);
      try {
        await expect(ro.execute('CREATE TABLE nope (id INTEGER)'))
          .rejects.toThrow('[SQLite read-only]');
        // A read still works, which is the point of asking for read-only.
        await expect(ro.execute('SELECT 1 AS ok')).resolves.toEqual([{ ok: 1 }]);
      } finally {
        await ro.close();
        require('node:fs').rmSync(path, { force: true });
      }
    });
  });
});
