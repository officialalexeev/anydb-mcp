import { EventEmitter } from 'events';
import { Readable } from 'stream';
import realMysql from 'mysql2/promise';
import { MySQLAdapter, withExecutionLimit } from '../src/adapters/mysql.js';

/**
 * The connection list of a callback-mode pool, which is a ring queue with
 * `.length` and `.get(i)`. Only the surface the driver itself uses is modelled;
 * there is no public API over it, which is the whole point of the next class.
 */
class FakeConnectionQueue {
  constructor() {
    this.items = [];
  }
  get length() { return this.items.length; }
  get(i) { return this.items[i]; }
  push(item) { this.items.push(item); return this.length; }
  removeOne(i) { return this.items.splice(i, 1)[0]; }
}

/** Stands in for mysql2's PoolConnection: an EventEmitter with destroy(). */
class FakePoolConnection extends EventEmitter {
  constructor(pool) {
    super();
    this.pool = pool;
    this.destroyed = false;
  }

/**
 * `PoolConnection#destroy` is `_removeFromPool()` then `super.destroy()`, and the
 * queue splice in `_removeFromPool` is synchronous, so the tests can read
 * `_allConnections.length` straight after `abort()`.
 *
 * It does not emit `'end'`, and this used to. The real connection emits it when
 * the *socket* ends, after `Connection#close()` has called `stream.end()` and the
 * peer has answered — not synchronously inside `destroy()`. Nothing here depended
 * on the invented emit (the adapter's `conn.once('end')` pruning is real and still
 * holds), and a mock that agrees with the assertion rather than with the driver
 * will agree with the next wrong assertion too.
 */
  destroy() {
    this.destroyed = true;
    // `_removeFromPool()` nulls its own back-reference first, so a second
    // destroy() is a no-op rather than a double splice.
    const pool = this.pool;
    if (pool) {
      this.pool = null;
      pool._removeConnection(this);
    }
  }
}

/** Stands in for mysql2's BasePool, the callback-mode pool behind a PromisePool. */
class FakeBasePool extends EventEmitter {
  constructor() {
    super();
    this._allConnections = new FakeConnectionQueue();
    this._freeConnections = new FakeConnectionQueue();
    this._closed = false;
  }

  /** `BasePool#_removeConnection`, which splices both queues. */
  _removeConnection(conn) {
    const drop = (queue) => {
      const at = queue.items.indexOf(conn);
      if (at !== -1) queue.removeOne(at);
    };
    drop(this._allConnections);
    drop(this._freeConnections);
  }

  /** Mirrors BasePool#getConnection: a new connection emits 'connection'. */
  open() {
    const conn = new FakePoolConnection(this);
    this._allConnections.push(conn);
    this.emit('connection', conn);
    this.emit('acquire', conn);
    return conn;
  }

  end(cb) {
    this._closed = true;
    if (typeof cb === 'function') cb();
  }
}

/**
 * Stands in for mysql2/promise's PromisePool: an EventEmitter that forwards
 * 'acquire', 'connection', 'enqueue' and 'release' from the pool behind it
 * (mysql2's inherit_events), and whose `.pool` is that pool.
 */
class FakePromisePool extends EventEmitter {
  constructor(core, query) {
    super();
    this.pool = core;
    this.query = query;
    this.endCalls = 0;
    this.forwarded = {};

    // inherit_events hooks the source lazily: the core pool only learns about
    // an event once the promise pool has a listener for it, and unhooks again
    // when the last one is removed. Modelling that matters here, because the
    // adapter's whole reach into the pool is one such listener.
    const names = ['acquire', 'connection', 'enqueue', 'release'];
    this.on('newListener', (event) => {
      if (names.includes(event) && this.listenerCount(event) === 0) {
        this.forwarded[event] = (...args) => this.emit(event, ...args);
        core.on(event, this.forwarded[event]);
      }
    });
    this.on('removeListener', (event) => {
      if (names.includes(event) && this.listenerCount(event) === 0 && this.forwarded[event]) {
        core.removeListener(event, this.forwarded[event]);
        delete this.forwarded[event];
      }
    });
  }

  openSocket() {
    return this.pool.open();
  }

  end() {
    this.endCalls++;
    return new Promise((resolve, reject) => {
      try {
        this.pool.end((err) => (err ? reject(err) : resolve()));
      } catch (err) {
        reject(err);
      }
    });
  }
}

/**
 * Stands in for the command that `connection.query({sql, values, timeout})`
 * returns when given no callback.
 *
 * A callback makes mysql2 accumulate every row; without one it emits them one at a
 * time with nothing retained, and `stream()` turns those emissions into an
 * object-mode Readable. Modelled because the whole point of the capped path is
 * that the driver keeps nothing, and a double that buffered anyway would make the
 * test pass without the property being true.
 */
class FakeQueryCommand extends EventEmitter {
  constructor({ script = [], hasCallback = false } = {}) {
    super();
    this.script = script;
    this.hasCallback = hasCallback;
    this._rows = [];
    this._resultIndex = 0;
    this._done = false;
    // The driver only reaches the command's `error` through the stream, which is
    // why `stream()` subscribes to it. Modelled so an emitted error destroys the
    // stream and rejects the iteration, as it does there.
    this.on('error', (err) => { this.streamError = err; if (this._stream) this._stream.destroy(err); });
  }

  stream() {
    const source = this;
    this._stream = new Readable({ objectMode: true, read() { source._pump(this); } });
    // As in the driver: every `result` emission is pushed into the Readable, and
    // the command's `error` destroys it. The consumer only ever sees the stream,
    // so the two subscriptions are the whole of `stream()`.
    this.on('result', (row) => {
      if (!this._stream.destroyed) this._stream.push(row);
    });
    return this._stream;
  }

  _pump(stream) {
    if (this._done || this.script.length === 0) {
      this._done = true;
      stream.push(null);
      return;
    }
    const next = this.script.shift();
    this._done = true;
    // `doneInsert` emits `'fields', void 0` before the status packet;
    // `readField` emits the real field list before any row. That is the only
    // thing that tells the two apart, because both are plain objects.
    this.emit('fields', next.fields ?? null);
    for (const row of next.rows ?? []) this._emit(row);
    if (next.error) { this.emit('error', next.error); return; }
    stream.push(null);
  }

  _emit(row) {
    if (this.hasCallback) this._rows.push(row);
    else this.emit('result', row, this._resultIndex);
  }

  /**
   * Feed a result through whatever path this command was built with.
   *
   * `fields` defaults to a one-column list, because a query that returns rows is
   * the case being exercised; pass `null` for a statement with no result set,
   * which is the one that produces a status packet.
   */
  deliver({ rows = [], error = null, fields = [{ name: 'id' }] } = {}) {
    this.emit('fields', fields);
    for (const row of rows) this._emit(row);
    if (error) { this.emit('error', error); return; }
    this._done = true;
    if (this._stream && !this._stream.destroyed) this._stream.push(null);
  }
}

describe('MySQLAdapter', () => {
  let adapter;
  let mockQuery;
  let mockEnd;
  let corePool;
  let mockPool;
  let mockCreatePool;
  let savedEnv;
  let stderr;

  beforeEach(() => {
    savedEnv = process.env.ANYDB_MYSQL_POOL_MAX;
    delete process.env.ANYDB_MYSQL_POOL_MAX;
    stderr = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockQuery = jest.fn().mockResolvedValue([[{ id: 1, name: 'test' }], []]);
    mockEnd = jest.fn().mockResolvedValue();
    corePool = new FakeBasePool();
    mockPool = new FakePromisePool(corePool, mockQuery);
    mockCreatePool = jest.fn(() => mockPool);

    adapter = new MySQLAdapter(mockCreatePool, 30000);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ANYDB_MYSQL_POOL_MAX;
    else process.env.ANYDB_MYSQL_POOL_MAX = savedEnv;
    stderr.mockRestore();
  });

  describe('driver shape', () => {
    // The doubles above are only worth anything if they match the installed
    // driver, and the failure they stand in for was silent: an invented shape
    // let abort() "pass" while doing nothing to a real pool.
    test('a real PromisePool exposes its base pool, not a connection array', async () => {
      const pool = realMysql.createPool({ host: '127.0.0.1', user: 'u' });
      try {
        expect(pool.pool).toBeTruthy();
        expect(typeof pool.pool.forEach).toBe('undefined');
        expect(pool.pool._allConnections.length).toBe(0);
        // The event abort() depends on is forwarded, not merely present: a
        // listener on the promise pool reaches the pool that opens the sockets.
        expect(pool.listenerCount('connection')).toBe(0);
        expect(pool.pool.listenerCount('connection')).toBe(0);
        pool.on('connection', () => {});
        expect(pool.listenerCount('connection')).toBe(1);
        expect(pool.pool.listenerCount('connection')).toBe(1);
        pool.removeAllListeners('connection');
        expect(pool.pool.listenerCount('connection')).toBe(0);
      } finally {
        await pool.end();
      }
    });

    test('the double matches the real pool on the points abort() relies on', () => {
      expect(typeof mockPool.forEach).toBe('undefined');
      expect(typeof mockPool.pool.forEach).toBe('undefined');
      expect(mockPool.pool._allConnections.length).toBe(0);
      expect(mockPool.listenerCount('connection')).toBe(0);
      expect(mockPool.pool.listenerCount('connection')).toBe(0);
    });

    // The driver facts the bounded path depends on, read rather than assumed.
    test('the driver decides whether to keep a row by the presence of a callback', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(process.cwd(), 'node_modules', 'mysql2', 'lib', 'commands', 'query.js'),
        'utf8'
      );
      expect(source).toContain('if (this.onResult)');
      expect(source).toContain("this.emit('result', row, this._resultIndex)");
      expect(source).toContain('stream(options)');
    });

    test('createQuery accepts the options-object form the cap and timeout use', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(process.cwd(), 'node_modules', 'mysql2', 'lib', 'base', 'connection.js'),
        'utf8'
      );
      expect(source).toContain('static createQuery(sql, values, cb, config)');
      // …and the values are escaped by the connection, whichever form it is
      // given in, which is why `query()` and not `execute()` loses nothing.
      expect(source).toContain('const rawSql = this.format(');
    });

    test('BIGINT is only returned as a string when both big-number flags are set', () => {
      const parser = require('node:fs').readFileSync(
        require('node:path').join(process.cwd(), 'node_modules', 'mysql2', 'lib', 'parsers', 'text_parser.js'),
        'utf8'
      );
      expect(parser).toContain('case Types.LONGLONG');
      expect(parser).toContain('if (supportBigNumbers && bigNumberStrings)');

      const packet = require('node:fs').readFileSync(
        require('node:path').join(process.cwd(), 'node_modules', 'mysql2', 'lib', 'packets', 'packet.js'),
        'utf8'
      );
      // Without supportBigNumbers, 14 or more digits are Number()'d and the low
      // bits are gone — silently, and Postgres returns int8 as a string.
      expect(packet).toContain('if (len >= 14 && !supportBigNumbers)');
    });
  });

  // The driver is loaded on demand, not on import

  describe('lazy driver loading', () => {
  // Asserted structurally rather than by timing: the driver name must not appear
  // in a module-scope import, and must be resolved by a dynamic `import()` inside
  // `connect()`. A timing assertion would be flaky in CI and would not say why.
    const source = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'src', 'adapters', 'mysql.js'),
      'utf8'
    );

    test('the adapter does not import mysql2 at module scope', () => {
      expect(source).not.toMatch(/^import\s+\w+\s+from\s+'mysql2/m);
      expect(source).not.toMatch(/require\('mysql2/);
      // It is imported at all, just not eagerly — an assertion that would pass
      // trivially if the driver name had been deleted from the file.
      expect(source).toMatch(/await import\('mysql2\/promise'\)/);
    });

    test('the loader is not called before connect, and connect is what loads it', async () => {
      const a = new MySQLAdapter();
      expect(a.ConnectionFactory).toBeUndefined();

      // Constructing an adapter must not have loaded the driver — that is the
      // whole property, and it is asserted on the instance rather than by timing.
      await a.loadMySQLDriver();
      // The installed driver, not a stub: this is the default path the live job
      // depends on, and it is the only place it is exercised in unit tests.
      expect(a.ConnectionFactory).toBe(realMysql.createPool);

      const resolved = a.ConnectionFactory;
      await a.loadMySQLDriver();
      expect(a.ConnectionFactory).toBe(resolved);
    });

    test('an injected factory is never replaced by the real driver', async () => {
      // The dependency-injection argument that every adapter test in this file
      // relies on has to survive the lazy default, or the whole suite starts
      // opening real sockets. This is that assertion.
      const a = new MySQLAdapter(mockCreatePool, 30000);
      await a.loadMySQLDriver();

      expect(a.ConnectionFactory).toBe(mockCreatePool);
    });

    test('an explicit null reaches the worded refusal, not a lazy fill', async () => {
      // THREE STATES, and the third is the one that is easy to lose. `undefined`
      // means "not supplied, load it"; a function means "supplied, keep it"; an
      // explicit `null` means "this build has no such factory" and must be
      // reported in words rather than quietly repaired by importing mysql2.
      const a = new MySQLAdapter(null, 30000);
      await a.loadMySQLDriver();
      expect(a.ConnectionFactory).toBeNull();

      await expect(a.connect('mysql://u:p@h:3306/db'))
        .rejects.toThrow(/no mysql2 createPool/);
    });
  });

  describe('connect', () => {
    test('creates a pool from the URI', async () => {
      await adapter.connect('mysql://user:password@localhost:3306/database');

      expect(adapter.pool).toBe(mockPool);
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({
        host: 'localhost',
        port: 3306,
        user: 'user',
        password: 'password',
        database: 'database',
        connectTimeout: 5000,
        connectionLimit: 4,
        waitForConnections: true,
        queueLimit: 0,
        enableKeepAlive: true
      }));
    });

    test('asks for a session reset on release, so a stray BEGIN cannot outlive its call', async () => {
      await adapter.connect('mysql://u:p@h/d');
      // mysql2 issues COM_RESET_CONNECTION on every release, which rolls back an
      // open transaction and restores the session's variables. It costs one
      // round trip and defaults to off.
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({ resetOnRelease: true }));
    });

    // A `latin1` default charset silently mis-encodes anything else, and a
    // `local` timezone makes a timestamp mean whatever the server's zone is.
    test('pins the encoding and the timezone', async () => {
      await adapter.connect('mysql://u:p@h/d');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({
        charset: 'UTF8MB4',
        timezone: 'Z'
      }));
    });

    // Without both flags, a BIGINT above 2^53 comes back as a JS number with the
    // low bits gone, while Postgres returns the same column as a string.
    test('returns an oversized BIGINT as a string, matching Postgres', async () => {
      await adapter.connect('mysql://u:p@h/d');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({
        supportBigNumbers: true,
        bigNumberStrings: true
      }));
    });

    test('bounds the pool so one caller cannot exhaust connections', async () => {
      const sized = new MySQLAdapter(mockCreatePool, 30000, 10);
      await sized.connect('mysql://u:p@h/d');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({
        connectionLimit: 10,
        waitForConnections: true
      }));
    });

    test('takes the pool bound from ANYDB_MYSQL_POOL_MAX', async () => {
      process.env.ANYDB_MYSQL_POOL_MAX = '12';
      const sized = new MySQLAdapter(mockCreatePool, 30000);
      await sized.connect('mysql://u:p@h/d');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({ connectionLimit: 12 }));
    });

    test('an explicit bound wins over the environment', async () => {
      process.env.ANYDB_MYSQL_POOL_MAX = '12';
      const sized = new MySQLAdapter(mockCreatePool, 30000, 7);
      await sized.connect('mysql://u:p@h/d');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({ connectionLimit: 7 }));
    });

    test.each(['0', '-3', 'abc', ''])(
      'falls back to the default for the nonsense bound %p',
      async (raw) => {
        process.env.ANYDB_MYSQL_POOL_MAX = raw;
        const sized = new MySQLAdapter(mockCreatePool, 30000);
        await sized.connect('mysql://u:p@h/d');
        expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({ connectionLimit: 4 }));
      }
    );

    test('defaults the port to 3306', async () => {
      await adapter.connect('mysql://user:password@localhost/database');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({ port: 3306 }));
    });

    test('handles a URI without a password', async () => {
      await adapter.connect('mysql://user@localhost:3306/database');
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'user', password: '' })
      );
    });

    test('decodes percent-encoded credentials', async () => {
      await adapter.connect('mysql://user%40corp:p%40ss%3Aword@localhost/db');
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'user@corp', password: 'p@ss:word' })
      );
    });

    test('decodes a percent-encoded database name', async () => {
      await adapter.connect('mysql://user:pass@localhost/my%20db');
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ database: 'my db' })
      );
    });

    test.each([
      'mysql+pymysql://user:password@localhost:3306/database',
      'mysql+mysqldb://user:password@localhost:3306/database',
      'mysql+asyncmy://user:password@localhost:3306/database',
    ])('normalises %s', async (uri) => {
      await adapter.connect(uri);
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'user', password: 'password' })
      );
    });

    test('rejects a malformed URI', async () => {
      await expect(adapter.connect('invalid-uri-format'))
        .rejects.toThrow('Invalid MySQL URI format');
    });
  });

  // Every one of these used to be dropped on the floor, so a URI that said
  // `?ssl-mode=REQUIRED` produced a plaintext connection with no warning.
  describe('query-string parameters', () => {
    test('turns ssl-mode=REQUIRED into a TLS connection', async () => {
      await adapter.connect('mysql://u:p@h/d?ssl-mode=REQUIRED');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({ ssl: {} }));
    });

    test('distinguishes a verifying TLS connection from an encrypted one', async () => {
      await adapter.connect('mysql://u:p@h/d?ssl-mode=VERIFY_CA');
      // `REQUIRED` encrypts and does not authenticate the server. Saying so is
      // the difference between what the user asked for and what they got.
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ ssl: { rejectUnauthorized: true } })
      );
    });

    test('honours ssl-mode=DISABLED as an explicit no-TLS', async () => {
      await adapter.connect('mysql://u:p@h/d?ssl-mode=DISABLED');
      expect(mockCreatePool.mock.calls[0][0].ssl).toBeUndefined();
    });

    test('takes a JSON ssl object', async () => {
      await adapter.connect('mysql://u:p@h/d?ssl=' + encodeURIComponent('{"ca":"-----BEGIN"}'));
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ ssl: { ca: '-----BEGIN' } })
      );
    });

    test('explains a malformed JSON ssl object instead of failing obscurely', async () => {
      await expect(adapter.connect('mysql://u:p@h/d?ssl={oops}'))
        .rejects.toThrow('does not parse');
    });

    test('builds ssl from the ssl_* family', async () => {
      await adapter.connect('mysql://u:p@h/d?ssl_ca=CERT&ssl_verify_identity=false');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({
        ssl: { ca: 'CERT', rejectUnauthorized: false }
      }));
    });

    test('rejects an ssl-mode it does not know, rather than ignoring it', async () => {
      await expect(adapter.connect('mysql://u:p@h/d?ssl-mode=MAYBE'))
        .rejects.toThrow('Unknown MySQL URI parameter "ssl-mode=MAYBE"');
    });

    test('honours charset, collation and timezone', async () => {
      await adapter.connect('mysql://u:p@h/d?charset=latin1&collation=latin1_general_ci&timezone=+02:00');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({
        charset: 'latin1',
        collation: 'latin1_general_ci',
        timezone: '+02:00'
      }));
    });

    test('honours a unix socket', async () => {
      await adapter.connect('mysql://u:p@localhost/d?socket=/tmp/mysql.sock');
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath: '/tmp/mysql.sock' })
      );
    });

    test('honours the pool and connect bounds', async () => {
      await adapter.connect('mysql://u:p@h/d?connectionLimit=9&connect_timeout=1500');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({
        connectionLimit: 9,
        connectTimeout: 1500
      }));
    });

    // A URI parameter that looks like it configures something and does not is
    // the worst kind of silent failure, so it is reported rather than dropped.
    test('warns about a parameter it does not honour', async () => {
      await adapter.connect('mysql://u:p@h/d?replication=true');
      const logged = stderr.mock.calls.map(call => String(call[0])).join('\n');
      expect(logged).toContain('replication');
      expect(logged).toContain('not honoured');
    });

    test('accepts a camelCase spelling of the same idea', async () => {
      await adapter.connect('mysql://u:p@h/d?sslMode=REQUIRED');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({ ssl: {} }));
    });

    test('says nothing when every parameter was honoured', async () => {
      await adapter.connect('mysql://u:p@h/d?ssl-mode=REQUIRED&charset=utf8mb4');
      const logged = stderr.mock.calls.map(call => String(call[0])).join('\n');
      expect(logged).not.toContain('not honoured');
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      await adapter.connect('mysql://user:password@localhost:3306/database');
    });

    test('returns SELECT rows unchanged', async () => {
      const rows = [{ id: 1, name: 'Test' }];
      mockQuery.mockResolvedValue([rows, []]);

      await expect(adapter.execute('SELECT * FROM users')).resolves.toEqual(rows);
    });

    test('wraps a non-SELECT result in an array', async () => {
      const okPacket = {
        affectedRows: 3, insertId: 7, changedRows: 1, warningStatus: 0, info: 'Records: 3'
      };
      mockQuery.mockResolvedValue([okPacket, []]);

      const result = await adapter.execute('UPDATE users SET a = 1');

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([{
        affectedRows: 3, insertId: 7, changedRows: 1, warningStatus: 0, info: 'Records: 3'
      }]);
    });

    test('normalises a missing result to an empty array', async () => {
      mockQuery.mockResolvedValue([undefined, []]);
      await expect(adapter.execute('SET @x = 1')).resolves.toEqual([]);
    });

    test('does not pass a per-query timeout as if it were a values array', async () => {
      await adapter.execute('SELECT 1');
      // mysql2 interprets a second argument as bound values.
      expect(mockQuery.mock.calls[0]).toHaveLength(1);
    });

    test('builds the server-side limit from the caller\'s timeout, not the shared field', async () => {
      // The pool is shared, so a field on the adapter cannot carry per-call
      // state: two overlapping calls would race on which budget reaches MySQL.
      await adapter.execute('SELECT 1', { timeout: 1234 });
      expect(mockQuery.mock.calls[0][0]).toContain('MAX_EXECUTION_TIME(1234)');

      await adapter.execute('SELECT 1', { timeout: 5678 });
      expect(mockQuery.mock.calls[1][0]).toContain('MAX_EXECUTION_TIME(5678)');
    });

    test('falls back to the adapter default when the call names no timeout', async () => {
      await adapter.execute('SELECT 1');
      expect(mockQuery.mock.calls[0][0]).toContain('MAX_EXECUTION_TIME(30000)');
    });

    describe('bound parameters', () => {
      // The `db_query` schema had no `params` argument, so every value had to be
      // inlined into the statement by the model.
      test('binds ? placeholders to the values array', async () => {
        mockQuery.mockResolvedValue([[], []]);

        await adapter.execute('SELECT * FROM users WHERE id = ? AND email = ?', { params: [7, 'a@b.com'] });

        expect(mockQuery.mock.calls[0][0]).toContain('WHERE id = ? AND email = ?');
        expect(mockQuery.mock.calls[0][1]).toEqual([7, 'a@b.com']);
      });

      // query() and not execute(): the latter sends a prepared statement, which
      // MySQL rejects for a number of legal single-statement forms. The values
      // are still escaped — `BaseConnection.query` runs them through
      // `this.format(sql, values)`, i.e. sqlstring.format, before the text goes
      // on the wire — so the choice costs no injection safety.
      test('uses query(), whose values are escaped client-side', async () => {
        mockQuery.mockResolvedValue([[], []]);

        await adapter.execute('SELECT * FROM t WHERE a = ?', { params: ["'; DROP TABLE t; --"] });

        expect(typeof mockQuery).toBe('function');
        expect(adapter.pool.execute).toBeUndefined();
        expect(mockQuery.mock.calls[0][1]).toEqual(["'; DROP TABLE t; --"]);
      });

      test('refuses a params value that is not an array', async () => {
        await expect(adapter.execute('SELECT ?', { params: 'nope' }))
          .rejects.toThrow("'params' must be an array");
      });

      test('refuses undefined rather than sending it as NULL', async () => {
        await expect(adapter.execute('SELECT ?', { params: [undefined] }))
          .rejects.toThrow('contains undefined');
      });

      // sqlstring leaves an unmatched `?` in the text it produces, so MySQL
      // reports a syntax error that names neither the real problem nor the array
      // that is one element short.
      test('names the placeholder and value counts when the bind fails', async () => {
        mockQuery.mockRejectedValue(Object.assign(
          new Error("You have an error in your SQL syntax near '?'"),
          { code: 'ER_PARSE_ERROR' }
        ));

        const error = await adapter.execute('SELECT * FROM t WHERE a = ? AND b = ?', { params: [1] })
          .catch(e => e);

        expect(error.message).toContain('has 2 placeholder(s) and 1 value(s) were supplied');
        expect(error.message).toContain('Add the missing values to "params"');
      });

      test('does not count a ? inside a string literal', async () => {
        mockQuery.mockRejectedValue(Object.assign(
          new Error('You have an error in your SQL syntax'),
          { code: 'ER_PARSE_ERROR' }
        ));

        // Three real placeholders and one literal question mark: a naive count
        // sees four, and reports a bind problem one value short that is not
        // there.
        const error = await adapter.execute("SELECT '?' AS q WHERE a = ? AND b = ? AND c = ?", { params: [1, 2] })
          .catch(e => e);

        expect(error.message).toContain('has 3 placeholder(s) and 2 value(s) were supplied');
      });

      test('leaves a matching count alone, because there is nothing to explain', async () => {
        mockQuery.mockRejectedValue(Object.assign(
          new Error('You have an error in your SQL syntax'),
          { code: 'ER_PARSE_ERROR' }
        ));

        await expect(adapter.execute('SELECT ? FROM t', { params: [1] }))
          .rejects.toThrow('[MySQL SQL syntax error]');
      });
    });

    describe('error classification', () => {
      test.each([
        ['ER_NO_SUCH_TABLE', "Table 'db.nope' doesn't exist", 'table does not exist'],
        ['ER_PARSE_ERROR', 'You have an error in your SQL syntax', 'SQL syntax error'],
        ['ER_ACCESS_DENIED_ERROR', "Access denied for user 'u'@'h'", 'access denied'],
        ['ER_DUP_ENTRY', "Duplicate entry '1' for key 'PRIMARY'", 'duplicate key'],
        ['ER_NO_REFERENCED_ROW', 'a foreign key constraint fails', 'foreign key constraint'],
        ['ER_LOCK_TABLE_FULL', 'table is full', 'table is full'],
      ])('names %s accurately rather than calling it a syntax error', async (code, message, expected) => {
        mockQuery.mockRejectedValue(Object.assign(new Error(message), { code, sqlMessage: message }));

        const error = await adapter.execute('SELECT 1').catch(e => e);
        expect(error.message).toContain(expected);
        expect(error.message).not.toMatch(/Syntax Error/);
        // The driver's own error is kept, so the registry can classify it and
        // the logger can print a stack that leads somewhere.
        expect(error.cause).toBeTruthy();
      });

      test('surfaces an unknown error code instead of discarding it', async () => {
        mockQuery.mockRejectedValueOnce(
          Object.assign(new Error('something odd'), { code: 'ER_SOMETHING_NEW' })
        );
        await expect(adapter.execute('SELECT 1'))
          .rejects.toThrow('[MySQL ER_SOMETHING_NEW]');
      });
    });

    test.each(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT'])(
      'treats %s as a timeout', async (code) => {
        mockQuery.mockRejectedValueOnce(Object.assign(new Error('gone'), { code }));
        await expect(adapter.execute('SELECT 1'))
          .rejects.toThrow(/query exceeded 30000ms timeout/);
      }
    );

    test('names the caller\'s own timeout when it is the one that ran out', async () => {
      mockQuery.mockRejectedValueOnce(
        Object.assign(new Error('gone'), { code: 'ER_QUERY_TIMEOUT' })
      );
      // The message has to be about the budget this call was given, which is the
      // value a shared field could not reliably carry.
      await expect(adapter.execute('SELECT 1', { timeout: 250 }))
        .rejects.toThrow(/query exceeded 250ms timeout/);
    });
  });

  describe('maxRows', () => {
    beforeEach(async () => {
      await adapter.connect('mysql://u:p@h/d');
    });

    /**
     * Give the pool a connection that answers a streamed query.
     *
     * `fields` is the field list the driver emits before the rows, and `null` for
     * a statement with no result set - the one that produces a status packet
     * instead of rows.
     */
    const streamable = (rows, { fields = [{ name: 'id' }] } = {}) => {
      const socket = mockPool.openSocket();
      const command = new FakeQueryCommand({ script: [{ rows, fields }] });
      // `getConnection()` returns a PromisePoolConnection; the callback-mode
      // connection is its `.connection`, and the options-object form of `query`
      // lives there.
      socket.connection = { query: jest.fn(() => command) };
      mockPool.getConnection = jest.fn().mockResolvedValue(socket);
      mockPool.releaseConnection = jest.fn();
      return { socket, command };
    };

    test('reads through the stream when a cap is asked for', async () => {
      const { socket } = streamable([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);

      const rows = await adapter.execute('SELECT * FROM t', { maxRows: 10 });

  // A row is a plain **object**: `TextRow.next` opens with
  // `options.rowsAsArray ? new Array(fields.length) : {}` and assigns each column
  // name onto it. The `RowDataPacket` type is declared `any[] & {...}`, which is
  // true only in `rowsAsArray` mode, so testing a row with `Array.isArray` reads
  // every row as the status packet.
      expect(rows).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
      // The buffered path was not used.
      expect(mockQuery).not.toHaveBeenCalled();
      expect(socket.connection.query.mock.calls[0][0])
        .toMatchObject({ sql: expect.stringContaining('SELECT') });
      expect(mockPool.releaseConnection).toHaveBeenCalledWith(socket);
    });

    test('passes no values, and no callback, so the driver keeps nothing', async () => {
      const { socket } = streamable([{ id: 1 }]);

      await adapter.execute('SELECT 1', { maxRows: 5 });

      const options = socket.connection.query.mock.calls[0][0];
      expect(options.values).toBeUndefined();
      expect(socket.connection.query.mock.calls[1]).toBeUndefined();
    });

    test('passes the bound values through with the statement', async () => {
      const { socket } = streamable([{ id: 42 }]);

      await adapter.execute('SELECT ?', { params: [42], maxRows: 5 });

      expect(socket.connection.query.mock.calls[0][0]).toMatchObject({ values: [42] });
    });

    test('carries a client-side inactivity timeout', async () => {
      const { socket } = streamable([{ id: 1 }]);

      await adapter.execute('SELECT 1', { maxRows: 5, timeout: 1500 });

      expect(socket.connection.query.mock.calls[0][0].timeout).toBe(1500);
    });

    test('stops at the cap and marks the answer, which is a prefix not a sample', async () => {
      const { socket } = streamable([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);

      const rows = await adapter.execute('SELECT * FROM t', { maxRows: 2 });

      expect(rows).toHaveLength(2);
      expect(rows.truncated).toBe(true);
      // The marker is a property, not a row: it must not reach the answer.
      expect(JSON.parse(JSON.stringify(rows))).toEqual([{ id: 1 }, { id: 2 }]);
    });

    test('returns a status object for a write', async () => {
      // A statement with no result set produces one value, the OkPacket, with no
      // field list before it. It is the status object the other backends return,
      // and it must not be mistaken for a row.
      streamable([{ affectedRows: 3, insertId: 7, changedRows: 1, warningStatus: 0, info: '' }],
        { fields: null });

      const rows = await adapter.execute('UPDATE t SET a = 1', { maxRows: 5 });

      expect(rows).toEqual([{
        affectedRows: 3, insertId: 7, changedRows: 1, warningStatus: 0, info: ''
      }]);
    });

    test('falls back to the buffered path when the pool has no connections to lend', async () => {
      mockPool.getConnection = undefined;
      mockQuery.mockResolvedValue([[{ id: 1 }, { id: 2 }, { id: 3 }], []]);

      const rows = await adapter.execute('SELECT * FROM t', { maxRows: 2 });

      // The answer is still capped; only the server-side work is not.
      expect(rows).toHaveLength(2);
      expect(rows.truncated).toBe(true);
    });

    test('reports a streamed failure as the driver described it', async () => {
      const { socket } = streamable([]);
      socket.connection.query = jest.fn(() => new FakeQueryCommand({
        script: [{
          error: Object.assign(new Error("Table 'db.nope' doesn't exist"), {
            code: 'ER_NO_SUCH_TABLE', sqlMessage: "Table 'db.nope' doesn't exist"
          })
        }]
      }));

      await expect(adapter.execute('SELECT * FROM nope', { maxRows: 5 }))
        .rejects.toThrow('table does not exist');
      expect(mockPool.releaseConnection).toHaveBeenCalledWith(socket);
    });
  });

  describe('session state', () => {
    beforeEach(async () => {
      await adapter.connect('mysql://u:p@h/d');
    });

    // A pooled BEGIN holds its row locks until something releases them, which
    // is the statement that owns them or innodb_lock_wait_timeout seconds of
    // every other writer's time.
    test.each(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT s', 'LOCK TABLES t READ'])(
      'refuses %s rather than pinning the pooled connection', async (sql) => {
        await expect(adapter.execute(sql, { readOnly: false }))
          .rejects.toThrow('[MySQL transactions are not supported]');
        expect(mockQuery).not.toHaveBeenCalled();
      }
    );

    test('says what the lock would cost other callers', async () => {
      const error = await adapter.execute('BEGIN', { readOnly: false }).catch(e => e);
      expect(error.message).toContain('keeps its row locks');
      expect(error.message).toContain('pins one connection across calls');
    });
  });

  describe('withExecutionLimit', () => {
    test('places the hint after the leading keyword, where MySQL honours it', () => {
      // Before SELECT the hint is ignored silently, so placement is the whole
      // point of this helper.
      expect(withExecutionLimit('SELECT 1', 1000))
        .toBe('SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1');
    });

    test('skips leading whitespace and comments', () => {
      expect(withExecutionLimit('  -- note\n  SELECT 1', 500))
        .toBe('  -- note\n  SELECT /*+ MAX_EXECUTION_TIME(500) */ 1');
      expect(withExecutionLimit('/* c */ SELECT 1', 500))
        .toBe('/* c */ SELECT /*+ MAX_EXECUTION_TIME(500) */ 1');
    });

    test.each([
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a = 1',
      'SHOW TABLES',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      '',
    ])('leaves %s unannotated', (sql) => {
      expect(withExecutionLimit(sql, 1000)).toBe(sql);
    });

    test('is a no-op for a non-positive timeout', () => {
      expect(withExecutionLimit('SELECT 1', 0)).toBe('SELECT 1');
      expect(withExecutionLimit('SELECT 1', -5)).toBe('SELECT 1');
    });

    test('truncates a fractional timeout to whole milliseconds', () => {
      expect(withExecutionLimit('SELECT 1', 1000.9)).toContain('MAX_EXECUTION_TIME(1000)');
    });
  });

  describe('isHealthy', () => {
    test('is true when the pool answers', async () => {
      await adapter.connect('mysql://u:p@h/d');
      await expect(adapter.isHealthy()).resolves.toBe(true);
    });

    test('is false when the pool has no usable connection', async () => {
      // A server that closed the socket while it was idle looks like this.
      await adapter.connect('mysql://u:p@h/d');
      mockQuery.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'PROTOCOL_CONNECTION_LOST' }));
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });

    test('is false with no pool', async () => {
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });

    test('is false after abort, so the cache rebuilds instead of reusing', async () => {
      await adapter.connect('mysql://u:p@h/d');
      adapter.abort();
      // The pool object is still there on purpose; isHealthy is what says it is
      // no longer safe to hand out.
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });
  });

  describe('describe', () => {
  // The schema tests are driven from here rather than by reaching the
  // *SchemaAdapter class directly, which left the `new …; schema.pool = …` wiring
  // in the adapter untested. The catalogue runs on a checked-out connection,
  // because mysql2 applies no timeout to `pool.query()`.
    const catalogue = (handler) => {
      const socket = mockPool.openSocket();
      socket.connection = { query: jest.fn(handler) };
      mockPool.getConnection = jest.fn().mockResolvedValue(socket);
      mockPool.releaseConnection = jest.fn();
      return socket;
    };

    test('hands the schema adapter the live pool', async () => {
      catalogue(({ sql }, cb) => {
        if (/VERSION\(\)/.test(sql)) return cb(null, [{ version: '8.0.36' }]);
        return cb(null, []);
      });
      await adapter.connect('mysql://u:p@h/d');

      const out = await adapter.describe({});

      expect(out.database).toBe('mysql');
      expect(out.version).toBe('8.0.36');
      expect(out.tables).toEqual([]);
      expect(mockPool.releaseConnection).toHaveBeenCalled();
    });

    test('runs the catalogue scan on a connection of its own, with a timeout', async () => {
      const socket = catalogue(({ sql }, cb) => cb(null, []));
      await adapter.connect('mysql://u:p@h/d');

      await adapter.describe({});

      const options = socket.connection.query.mock.calls[0][0];
      // mysql2 applies no per-query timeout to pool.query(), and a
      // MAX_EXECUTION_TIME hint on an information_schema scan is a hint MySQL may
      // ignore and MariaDB does.
      expect(options.timeout).toBe(30000);
    });

    test('reports a missing table the same way db_query does', async () => {
      catalogue(({ sql }, cb) => {
        if (/VERSION/.test(sql)) return cb(null, []);
        return cb(Object.assign(new Error("Table 'db.nope' doesn't exist"), {
          code: 'ER_NO_SUCH_TABLE',
          sqlMessage: "Table 'db.nope' doesn't exist"
        }));
      });
      await adapter.connect('mysql://u:p@h/d');

      // db_schema used to bypass describeError, so this was a bare code from
      // db_schema and a sentence from db_query.
      await expect(adapter.describe({})).rejects.toThrow('[MySQL table does not exist]');
    });
  });

  describe('abort', () => {
    test('destroys the sockets the pool actually opened', async () => {
      await adapter.connect('mysql://u:p@h/d');
      const sockets = [mockPool.openSocket(), mockPool.openSocket()];

      adapter.abort();

      // The driver's own pool object has no list to walk and no forEach; the
      // `connection` event is the only way to see a socket, so the adapter has
      // to have been listening before the first query.
      for (const socket of sockets) {
        expect(socket.destroyed).toBe(true);
      }
      expect(corePool._allConnections.length).toBe(0);
    });

    test('destroys a socket opened after the abort, instead of leaking it', async () => {
      await adapter.connect('mysql://u:p@h/d');
      adapter.abort();

      const late = mockPool.openSocket();

      expect(late.destroyed).toBe(true);
      expect(corePool._allConnections.length).toBe(0);
    });

    test('keeps the pool so close() can still end it', async () => {
      await adapter.connect('mysql://u:p@h/d');
      adapter.abort();

      expect(adapter.pool).toBe(mockPool);
    });

    test('does not throw on a socket that refuses to close', async () => {
      await adapter.connect('mysql://u:p@h/d');
      const socket = mockPool.openSocket();
      socket.destroy = () => { throw new Error('already destroyed'); };

      expect(() => adapter.abort()).not.toThrow();
      expect(socket).toBeTruthy();
    });

    test('is idempotent', async () => {
      await adapter.connect('mysql://u:p@h/d');
      const socket = mockPool.openSocket();
      const destroy = jest.spyOn(socket, 'destroy');

      adapter.abort();
      adapter.abort();

      expect(destroy).toHaveBeenCalledTimes(1);
    });

    test('is safe with no pool', () => {
      expect(() => adapter.abort()).not.toThrow();
    });
  });

  describe('close', () => {
    test('ends the pool', async () => {
      await adapter.connect('mysql://u:p@h/d');
      await adapter.close();
      expect(mockPool.endCalls).toBe(1);
    });

    test('is a no-op with no pool', async () => {
      await expect(adapter.close()).resolves.not.toThrow();
    });

    test('does not throw when the pool fails to close', async () => {
      mockPool.end = () => Promise.reject(new Error('pool already ended'));
      await adapter.connect('mysql://u:p@h/d');
      await expect(adapter.close()).resolves.not.toThrow();
    });

    test('stops tracking sockets so the pool listener is not left attached', async () => {
      await adapter.connect('mysql://u:p@h/d');
      await adapter.close();
      expect(mockPool.listenerCount('connection')).toBe(0);
      expect(mockPool.pool.listenerCount('connection')).toBe(0);
    });

    test('does not orphan the pool after an abort', async () => {
      await adapter.connect('mysql://u:p@h/d');
      mockPool.openSocket();
      mockPool.openSocket();

      adapter.abort();
      await adapter.close();

      // The pool object is not left running with live bookkeeping or sockets:
      // end() has to have run even though the sockets it would have waited for
      // were force-closed.
      expect(mockPool.endCalls).toBe(1);
      expect(corePool._closed).toBe(true);
      expect(corePool._allConnections.length).toBe(0);
      expect(adapter.pool).toBeNull();
    });

    test('resolves without waiting for a peer that will never answer end()', async () => {
      await adapter.connect('mysql://u:p@h/d');
      adapter.abort();
      // A force-closed socket never answers the Quit command, so the real
      // driver's end() callback can be withheld indefinitely. close() must not
      // become the thing that hangs.
      mockPool.end = () => {
        mockPool.endCalls++;
        return new Promise(() => {});
      };

      await expect(adapter.close()).resolves.toBeUndefined();
      expect(mockPool.endCalls).toBe(1);
    });

    test('releases a connection a query left behind', async () => {
      await adapter.connect('mysql://u:p@h/d');
      const socket = mockPool.openSocket();

      await adapter.close();

      // close() ends the pool rather than dropping the reference, which is what
      // left sockets behind when abort() nulled the field.
      expect(corePool._closed).toBe(true);
      expect(socket.destroyed).toBe(false);
    });
  });
});
