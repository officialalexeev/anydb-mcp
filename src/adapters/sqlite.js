import { BaseAdapter, TimeoutError, positiveInt } from '../core/base-adapter.js';
import { logError } from '../core/logging.js';
import { callbackWithTimeout, createTimeoutController } from '../core/timeout-utils.js';
import { SQLiteSchemaAdapter } from '../core/schema.js';

/**
 * sqlite3 ships a native binding built by an install script, and npm blocks install
 * scripts unless they are allow-listed. That allowance lives in the installing
 * project's own npmrc, not ours, so a consumer can end up with a sqlite3 that has
 * no binding. Importing it at module scope would take the whole server down over
 * one optional database, so it is loaded here, and only when a SQLite URI is used.
 */
let sqlite3Promise = null;

async function loadSqlite3() {
  if (!sqlite3Promise) {
    sqlite3Promise = import('sqlite3').catch(() => {
      sqlite3Promise = null;
      throw new Error(
        'SQLite support is unavailable because the sqlite3 native binding was not built. ' +
        'This is expected when npm blocks install scripts. Run ' +
        '`npm install-scripts approve sqlite3` in the project that installed this package, ' +
        'then `npm rebuild sqlite3`. That writes an allowScripts entry into that ' +
        "project's package.json. Setting allow-scripts=sqlite3 in .npmrc only works " +
        'while that package.json has no allowScripts field of its own. ' +
        'The other four databases are unaffected.'
      );
    });
  }
  return sqlite3Promise;
}

/** `sqlite3_open_v2` flags, from SQLite's own header. */
const OPEN = {
  READONLY: 0x00000001,
  READWRITE: 0x00000002,
  CREATE: 0x00000004,
  URI: 0x00000040,
  NOMUTEX: 0x00008000,
  FULLMUTEX: 0x00010000,
  SHAREDCACHE: 0x00020000,
  PRIVATECACHE: 0x00040000,
};

/**
 * How long a contended statement waits for the write lock before giving up.
 *
 * sqlite3's own default is 1000ms, and `PRAGMA busy_timeout` is on the read-only
 * blocklist, so a caller could never raise it: a database whose writer held the
 * lock for two seconds came back SQLITE_BUSY immediately with a thirty-second
 * caller budget still unused. This is the floor instead; the statement timeout
 * still applies above it.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * The ceiling on how long `connect()` waits for the driver to say the file is
 * open. A CEILING, not a duration: the guard is also raced against the budget the
 * call was given, so a caller who asked for 5 s is not held for 10 s, and one who
 * asked for 24 h cannot turn a typo in a path into a 24-hour stall either.
 */
const OPEN_TIMEOUT_MS = 10000;

/**
 * The floor on the open guard. Large enough that a `timeout` of `1`, which
 * `validateArgs` accepts, does not abort before the driver has had one turn of
 * the event loop to answer.
 */
const MIN_OPEN_TIMEOUT_MS = 50;

/** A bound on a promise the driver settles through a callback rather than by
 *  returning. The timer is cleared once the promise settles, so a normal open
 *  leaves nothing behind. */
function withTimeout(promise, ms, message) {
  const { controller, timerId } = createTimeoutController(ms);
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error(message)), { once: true });
    })
  ]).finally(() => {
    if (timerId) clearTimeout(timerId);
  });
}

/**
 * Result codes that mean the *handle* is finished, rather than that one statement
 * failed. A handle that has seen one of these is not handed out again, because
 * every later statement on it fails the same way and the cache has no other way to
 * know.
 *
 * `SQLITE_BUSY` and `SQLITE_LOCKED` are deliberately absent: contention is a
 * property of the moment, not of the handle, and latching those would throw away a
 * good connection over an ordinary write lock.
 */
const FATAL_CODES = new Set([
  'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_IOERR', 'SQLITE_CANTOPEN',
  'SQLITE_MISUSE', 'SQLITE_FULL', 'SQLITE_NOLFS', 'SQLITE_PROTOCOL',
  'SQLITE_DISKIO', 'SQLITE_TOOBIG', 'SQLITE_NOTFOUND',
]);

/** Leading keywords whose statement returns rows rather than a status. */
const ROW_RETURNING = new Set([
  'SELECT', 'WITH', 'VALUES', 'PRAGMA', 'EXPLAIN', 'TABLE', 'SHOW', 'DESCRIBE', 'DESC',
]);

export class SQLiteAdapter extends BaseAdapter {
  /**
   * @param {Function} [databaseClass] - sqlite3.Database, injected by tests.
   *   Left undefined in production so the driver is loaded lazily.
   */
  constructor(databaseClass = undefined, timeout = 30000) {
    super(0, timeout); // SQLite is local, no connection timeout needed
    this.DatabaseClass = databaseClass;
    // Set once the handle has failed in a way no later statement survives.
    this.faulted = null;
    // The statements running on the shared handle right now. A Set rather than a
    // single field, because the connection cache explicitly permits concurrent
    // use of one adapter — see run().
    this.inFlight = new Set();
  }

  /** Resolve the sqlite3 Database class, loading the driver on first use. */
  async loadDatabase() {
    if (!this.DatabaseClass) {
      this.DatabaseClass = (await loadSqlite3()).default.Database;
    }
    return this.DatabaseClass;
  }

  /**
   * @param {string} uri
   * @param {object} [options]
   * @param {number} [options.timeout] - This call's budget, in milliseconds. Used
   *   to bound the wait for the open, so `connect()` cannot outlive the budget
   *   the statement it was opened for was given.
   */
  async connect(uri, options = {}) {
    // Accept dialects other tools emit, e.g. SQLAlchemy's sqlite+pysqlite://
    const withoutScheme = uri.replace(/^sqlite(\+\w+)?:\/\//, '');
    const qIndex = withoutScheme.search(/[?#]/);
    const path = qIndex === -1 ? withoutScheme : withoutScheme.slice(0, qIndex);

    // The query string is honoured rather than stripped. Stripping it at the `?`
    // made `sqlite:///app.db?mode=ro&immutable=1` open the file **read-write**: a
    // caller who explicitly asked for read-only got the opposite, silently.
    const params = readUriParams(qIndex === -1 ? '' : withoutScheme.slice(qIndex));

    if (path === '') {
      throw new Error('SQLite URI must include a file path, for example sqlite:///path/to/db.sqlite or sqlite://:memory:');
    }

    // sqlite:///C:/data.db means the drive-rooted path C:\data.db.
    const normalised = path.replace(/^\/([A-Za-z]:)/, '$1');

    if (params.badMode !== null) {
      throw new Error(
        '[SQLite mode] The URI parameter "' + params.badMode + '" is not a SQLite open mode. '
          + 'Use mode=ro for a read-only handle, or mode=rw / mode=rwc for a writable one '
          + '(SQLite\'s own spellings: ro, rw, rwc). Remove the parameter for the default, '
          + 'which is a read-write handle. Refused rather than ignored: this parameter '
          + 'constrains the handle, and guessing would give a read-only request a write-capable one.'
      );
    }

    const Database = await this.loadDatabase();
    this.DatabaseClass = Database;

    this.faulted = null;
    this.openFailed = false;
    this.aborted = false;
    this.readOnly = params.readOnly;
    this.inMemory = /^:memory:/i.test(normalised);

    // The third argument is the open callback. sqlite3 reports some open failures
    // only through it, and the 'error' listener below catches the rest.
    //
    // `connect()` waits for it because `sqlite3_open_v2` is asynchronous: the
    // handle exists once the constructor returns, but the file is not open yet and
    // `db.open` reads `false` until the first statement has run. Resolving early
    // made an unopenable path fail at the caller's first query rather than at the
    // connect, and made `isHealthy()` report a fine handle as unhealthy, so the
    // cache threw away every connection it had just made.
    let openSettled = false;
    let failOpen = null;
    const opened = new Promise((resolve, reject) => {
      failOpen = (err) => {
        if (openSettled) return;
        openSettled = true;
        reject(err);
      };
      this.db = new Database(normalised, this.openMode(params), (err) => {
        if (openSettled) return;
        openSettled = true;
        failOpen = null;
        if (err) {
          // A handle whose open failed cannot be closed: there is no database to
          // hand back and sqlite3 never calls the close callback. `close()` skips
          // the wait when it sees this, and without the flag every failed connect
          // cost a full five-second close.
          this.openFailed = true;
          this.recordFault(err);
          reject(this.describeError(err, normalised));
          return;
        }
        resolve();
      });
    });

    this.db.on('error', (err) => {
      if (/SQLITE_CANTOPEN|unable to open database/i.test(err.message || '')) {
        // The handle never opened, so close() will never call back.
        this.openFailed = true;
      }
      // A handle that never opened reports its failure here and *not* through
      // the open callback, and `connect()` is waiting on exactly that.
      if (failOpen) failOpen(this.describeError(err, normalised));
      this.recordFault(err);
      // Every statement on this handle is now unanswerable. Each one owns its
      // own rejector, so this rejects all of them and no others.
      for (const call of [...this.inFlight]) call.reject(err);
      this.inFlight.clear();
    });

    // A longer lock wait than sqlite3's 1s default, for the reason above.
    this.db.configure?.(
      'busyTimeout',
      positiveInt(process.env.ANYDB_SQLITE_BUSY_TIMEOUT_MS, DEFAULT_BUSY_TIMEOUT_MS)
    );

    // WAL lets a reader and a writer work at the same time, which is the point of
    // a file-backed database being used by more than one process. Set here rather
    // than left to the caller because PRAGMA is on the read-only blocklist. Skipped
    // on a read-only handle (SQLite cannot write the journal) and in memory.
    //
    // Not awaited. The connection is usable the moment the handle is open, WAL is a
    // concurrency setting rather than a precondition, and awaiting it would make
    // `connect()` block on a PRAGMA the caller never asked for — on a network share,
    // where the journal write can take seconds.
    if (!params.readOnly && !this.inMemory) {
      this.pragma('journal_mode = WAL').catch(() => {
        // A filesystem that cannot do WAL is not a reason to fail the connection;
        // the rollback journal still works, just with coarser locking.
      });
    }

    if (params.unknown.length > 0) {
      this.warnUnsupported(params.unknown);
    }

    // Bounded twice: by the budget this call was given, and by OPEN_TIMEOUT_MS.
    // A driver that never calls back is a hang rather than a failure otherwise,
    // and the floor stops `timeout: 1` from aborting before the driver has had a
    // turn of the event loop.
    const budget = positiveInt(options.timeout, this.queryTimeout);
    const openBudget = Math.min(budget, OPEN_TIMEOUT_MS);
    const openTimeoutMs = Math.max(MIN_OPEN_TIMEOUT_MS, openBudget);
    const guardMessage = `[SQLite cannot open] the driver did not report "${normalised}" as open within `
      + `${openTimeoutMs}ms. That is the path passed to sqlite3, with the leading slash of sqlite:///C:/… removed.`;

    try {
      await withTimeout(opened, openTimeoutMs, guardMessage);
    } catch (err) {
      // The handle the driver never finished opening cannot be closed either, so
      // `close()` is told, or it sits out its own five-second timer on a
      // connection that never existed.
      if (err && err.message === guardMessage) this.openFailed = true;
      throw err;
    }
  }

  /**
   * The flags for `sqlite3_open_v2`, the second constructor argument.
   *
   * `OPEN_FULLMUTEX` because the handle is shared: the connection cache permits
   * concurrent use of one adapter, and a `SQLITE_OPEN_NOMUTEX` handle is not safe
   * to use from two threads. `OPEN_URI` so SQLite's own `file:` parameters keep
   * working. `immutable=1` is taken at face value — SQLite documents it as "the
   * file cannot change", so it is opened read-only here rather than trusting a
   * caller to keep away from it.
   */
  openMode(params) {
    const cache = params.sharedCache
      ? OPEN.SHAREDCACHE
      : (params.privateCache ? OPEN.PRIVATECACHE : 0);
    if (params.readOnly || params.immutable) return OPEN.READONLY | OPEN.URI | OPEN.FULLMUTEX | cache;
    return OPEN.READWRITE | OPEN.CREATE | OPEN.URI | OPEN.FULLMUTEX | cache;
  }

  /**
   * Say something useful about a URI parameter that is not honoured.
   *
   * Reported rather than dropped, because a parameter on a *file path* is the one
   * place where being wrong is destructive. Not fatal: a parameter this server has
   * never heard of is usually harmless, and refusing the connection would be worse
   * than saying so.
   */
  warnUnsupported(names) {
    try {
      logError(
        'sqlite_uri_param_ignored',
        new Error(
          `SQLite URI parameter(s) not honoured and ignored: ${names.join(', ')}. `
          + 'Honoured: mode (ro/rw/rwc), immutable, cache (shared/private).'
        ),
        { adapter: 'sqlite' }
      );
    } catch {
      // Degraded logging must not fail a connection.
    }
  }

  /**
   * Run an operation, racing it against both the query timeout and any 'error'
   * event raised by the database handle.
   *
   * The rejector is per call, not one field on the shared adapter: two concurrent
   * `execute()` calls sharing one slot means an `error` event rejects whichever
   * request happens to be in it, and the first call's `finally` nulls the second's
   * rejector — dropping a real failure on the floor.
   */
  run(operation, timeoutMs, operationName, timeoutMessage) {
    const call = { reject: () => {} };
    const guard = new Promise((_, reject) => {
      call.reject = reject;
    });
    // Nothing else waits on the guard, so do not let it warn as unhandled.
    guard.catch(() => {});
    this.inFlight.add(call);

    const result = callbackWithTimeout(operation, timeoutMs, operationName, timeoutMessage);

    return Promise.race([result, guard]).finally(() => {
      this.inFlight.delete(call);
      // The driver may never call back, so the operation's own timer has to be
      // disarmed here or it outlives us by the full timeout.
      result.cancel?.();
    });
  }

  /**
   * Run one statement.
   *
   * @param {string} sql - Statement text, with sqlite3's own `?` placeholders.
   * @param {object} [options]
   * @param {Array}  [options.params] - Values for the `?` placeholders, in
   *   order. sqlite3 binds them into a prepared statement, so no value is ever
   *   interpolated into the text.
   * @param {number} [options.maxRows] - Accumulate at most this many rows and
   *   mark the answer `truncated`.
   * @param {number} [options.timeout] - This call's budget, in milliseconds.
   */
  async execute(sql, options = {}) {
    refuseSessionState(sql);
    const timeout = this.resolveQueryTimeout(options);
    const params = readParams(options.params);
    const maxRows = readMaxRows(options.maxRows);

    try {
      if (!isRowReturning(sql)) return [await this.runWrite(sql, params, timeout)];
      if (maxRows === null) return await this.runQuery((callback) => this.db.all(sql, params, callback), timeout);
      const { rows, truncated } = await this.runCapped(sql, params, maxRows, timeout);
      return markTruncated(rows, truncated);
    } catch (err) {
      this.recordFault(err);
      throw this.describeError(err);
    }
  }

  /**
   * A statement that changes data, reported the way the other four backends do.
   *
   * `db.all()` answers `[]` for a successful `UPDATE`, so `db_query` returned an
   * empty array where Postgres returned `{affectedRows, command, oid}`.
   *
   * `db.run()`, not `db.all()` with the counters read off the handle. The counters
   * are real but they are not where it looks: sqlite3 sets `lastID` and `changes`
   * on the *Statement*, and only when the call was given a callback — which
   * `db.all()` is not — and finalises the statement immediately afterwards, so
   * reading them from the handle afterwards reliably answers zero. `db.run()` puts
   * them on `this` inside the callback, which is where they are actually set.
   */
  async runWrite(sql, params, timeout) {
    const result = await this.runQuery(
      (callback) => this.db.run(sql, params, function written(err) {
        if (err) callback(err);
        else callback(null, { affectedRows: this?.changes ?? 0, lastId: this?.lastID ?? null });
      }),
      timeout
    );
    return { ...result, command: leadingVerb(sql) };
  }

  runQuery(operation, timeout) {
    // The hardcoded `[]` this replaced meant a caller had to inline every value
    // into the statement text. `db.all` expands an array first argument into the
    // bind list, so the array is the right shape to pass.
    return this.run(
      operation,
      timeout,
      'SQLite query',
      `SQLite query exceeded ${timeout}ms timeout. The database is probably locked by another process or transaction.`
    );
  }

  /**
   * The capped path, through `db.each`.
   *
   * It bounds this process: rows past the cap are counted and dropped here, so the
   * array of parsed rows cannot grow without limit, and that array is what decides
   * whether a response can be produced at all.
   *
   * It does not bound the database's work. `Statement::Work_Each` steps to
   * SQLITE_DONE before any row reaches JavaScript and the row callback's return
   * value is ignored, so the scan cannot be stopped early from here. A true early
   * exit is `stmt.iterate()`, which is better-sqlite3's API, not this driver's. The
   * statement timeout still applies above it.
   */
  async runCapped(sql, params, maxRows, timeout) {
    const rows = [];
    let truncated = false;
    let failure = null;

    await this.runQuery(
      (callback) => this.db.each(
        sql,
        params,
        (err, row) => {
          if (err) {
            failure = err;
            return;
          }
          if (rows.length < maxRows) rows.push(row);
          // The cap is a prefix, not a sample: a row past it is proof the answer
          // is longer than what is being returned.
          else truncated = true;
        },
        (err) => {
          // The row callback's own error arrives here too, after the driver has
          // finished walking. `each` reports a missing table only in the
          // completion callback, and swallowing that would turn a failed query
          // into a successful empty result.
          callback(err ?? failure);
        }
      ),
      timeout
    );

    return { rows, truncated };
  }

  describe(options = {}) {
    const schema = new SQLiteSchemaAdapter(this.connectTimeout, this.resolveQueryTimeout(options));
    schema.db = this.db;
    schema.describeError = (err) => this.describeError(err);
    return schema.describe(options);
  }

  /**
   * Turn a driver error into one a caller can act on.
   *
   * The class and the code both survive, and both matter. Rebuilding a
   * `TimeoutError` as `new Error()` is what made the most likely SQLite failure
   * report itself as a syntax error, because `execute()` catches and re-wraps; by
   * the time `src/index.js` asks `error instanceof TimeoutError` the answer is
   * already no. `SQLITE_BUSY`, `SQLITE_READONLY`, `SQLITE_CANTOPEN` and
   * `SQLITE_NOTADB` are the stable field a caller can branch on.
   *
   * @param {Error} err
   * @param {string} [path] - The path handed to `sqlite3`, for the open failures
   *   where the path is the whole answer
   */
  describeError(err, path) {
    const message = err.message || String(err);
    // `SQLITE_CANTOPEN` is a *path* error above all else: the file does not
    // exist, the directory does not exist, the permissions are wrong, or the
    // caller meant a different file. Naming the path beats "check the file path
    // in the URI" without saying which path it was.
    const where = typeof path === 'string' && path !== '' ? ` Path passed to sqlite3: ${path}.` : '';

    // Already specific, and the only branch that is allowed to change the class.
    if (err instanceof TimeoutError) return err;
    if (/timed out/i.test(message)) return err; // already specific
    if (/SQLITE_BUSY|database is locked/i.test(message)) {
      return described(new Error(`[SQLite locked] ${message}. Another process holds a lock on the database.`), err);
    }
    if (/SQLITE_CANTOPEN|unable to open database/i.test(message)) {
      return described(new Error(
        `[SQLite cannot open] ${message}.${where} `
        + 'Check that the directory exists, that this process may read the file, and that the path is absolute — '
        + 'a relative SQLite path depends on the server\'s working directory.'
      ), err);
    }
    if (/SQLITE_READONLY|attempt to write a readonly database/i.test(message)) {
      return described(new Error(
        `[SQLite read-only] ${message}. This URI opened the database read-only (?mode=ro), `
        + 'which a write cannot override.'
      ), err);
    }
    if (/SQLITE_CORRUPT|SQLITE_NOTADB/i.test(message)) {
      return described(new Error(`[SQLite corrupt] ${message}. The file is not a usable database.`), err);
    }
    if (/SQLITE_ERROR/.test(message)) {
      return described(new Error(`[SQLite error] ${message.replace(/^SQLITE_ERROR:\s*/, '')}`), err);
    }
    return described(new Error(`[SQLite error] ${message}`), err);
  }

  /**
   * A real check, not an assumption.
   *
   * Three things, in increasing cost: a latched fatal error, which is free and
   * catches the important case; the driver's own `open` flag; and one real
   * `SELECT 1`, the only way to learn that a file has gone away from underneath an
   * open descriptor. The round trip costs one statement per checkout, which is
   * what Postgres, MySQL and Redis already do there.
   */
  async isHealthy() {
    if (!this.db || this.aborted) return false;
    if (this.faulted) return false;
    if (this.db.open === false) return false;

    try {
      await this.run(
        (callback) => this.db.get('SELECT 1 AS ok', [], callback),
        Math.min(positiveInt(this.queryTimeout, 2000), 2000),
        'SQLite health check',
        'The SQLite health check did not answer in time.'
      );
      return true;
    } catch {
      return false;
    }
  }

  /** SQLite keeps executing a statement until it is interrupted. */
  abort() {
    if (!this.db) return;
    this.aborted = true;
    try {
      this.db.interrupt();
    } catch {
      // Not every build has interrupt(), and it is not needed when idle.
    }
  }

  /**
   * Latch an error that means this handle is finished.
   *
   * Only the codes that make every *later* statement fail are latched. A busy
   * database or a missing table is a statement problem, not a handle problem, and
   * latching those would discard a good connection over an ordinary error.
   */
  recordFault(err) {
    if (!err) return;
    const code = typeof err.code === 'string'
      ? err.code
      : String(err.message || '').split(':')[0].trim();
    if (FATAL_CODES.has(code)) this.faulted = err.message || code;
  }

  async close() {
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    this.faulted = null;
    for (const call of this.inFlight) call.reject(new Error('SQLite connection closed'));
    this.inFlight.clear();

    // A handle that never opened cannot complete a close: there is no database to
    // hand back and sqlite3 never calls the callback. A handle that was
    // *interrupted* can, and must — `abort()` only calls `sqlite3_interrupt`, which
    // leaves the handle open, so treating `aborted` as "cannot close" leaked the
    // handle and its descriptor for the life of the process.
    //
    // `openFailed` is set from the open callback, the 'error' event and the open
    // guard. Without all three, a path that failed through the callback — the
    // common way on the installed sqlite3 — left this branch untaken and every
    // failed connect still cost a full five-second close.
    if (this.openFailed) return;

    return callbackWithTimeout(
      (callback) => db.close(callback),
      5000,
      'SQLite close'
    ).catch(err => {
      // The result has already been produced, so a stuck close is not worth
      // failing the request over. The stack is kept, which is what makes
      // "ANYDB_DEBUG=1 for a stack trace" true on this path.
      try {
        logError('adapter_close', err, { adapter: 'sqlite' });
      } catch {
        // Degraded logging is still better than a close() that throws.
      }
    });
  }

  /** A PRAGMA, for the settings the tool applies up front. */
  pragma(statement) {
    return new Promise((resolve, reject) => {
      this.db.all(`PRAGMA ${statement}`, [], (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }
}

/**
 * The `?query` parameters of a SQLite URI.
 *
 * `mode`, `immutable` and `cache` are honoured because a caller who wrote one was
 * trying to *constrain* the connection, and silently opening read-write is the
 * opposite of what they asked. An unrecognised parameter is reported rather than
 * dropped: on a URI whose payload is a file path, a parameter that looks like it
 * configures something and does not is a silent failure with a filesystem attached.
 */
function readUriParams(search) {
  const out = { readOnly: false, immutable: false, sharedCache: false, privateCache: false, unknown: [], badMode: null };

  // An unrecognised `mode` THROWS rather than joining `unknown`, and the
  // difference is the whole point of the parameter: a caller who writes it is
  // asking for a handle with fewer powers, so `?mode=roo` must not quietly
  // become read-write. Refusing the connect costs one edit to the URI and the fix
  // is named in the message; dropping the parameter gets the default, which is
  // read-write on purpose.
  //
  // `rw` and `rwc` really are the other two: SQLite documents SQLITE_OPEN_READWRITE
  // as "rw" and "rwc", the second adding CREATE.
  for (const pair of search.replace(/^[?#]/, '').split('&')) {
    if (pair === '') continue;
    const at = pair.indexOf('=');
    const key = decodeURIComponent((at === -1 ? pair : pair.slice(0, at)).replace(/\+/g, ' '));
    const value = at === -1 ? '' : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
    const truthy = !/^(0|false|no|off)$/i.test(value);

    if (key === 'mode') {
      if (/^ro($|[-_])/i.test(value)) out.readOnly = true;
      else if (/^(rw|rwc)$/i.test(value)) out.readOnly = false;
      else if (out.badMode === null) out.badMode = `${key}=${value}`;
    } else if (key === 'immutable') {
      out.immutable = truthy;
    } else if (key === 'cache') {
      if (/^shared$/i.test(value)) out.sharedCache = true;
      else if (/^private$/i.test(value)) out.privateCache = true;
      else out.unknown.push(`${key}=${value}`);
    } else {
      out.unknown.push(`${key}=${value}`);
    }
  }
  return out;
}

/** The values for the statement's `?` placeholders. */
function readParams(params) {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) {
    throw new Error(
      "'params' must be an array of values bound to the statement's ? placeholders, in order, "
      + `got ${typeof params}.`
    );
  }
  if (params.some((value) => value === undefined)) {
    throw new Error(
      "'params' contains undefined, which sqlite3 cannot bind. Use null for SQL NULL, "
      + 'or drop the placeholder and the value together.'
    );
  }
  return params;
}

/** The cap, or null for "no cap". `maxRows: 0` means no cap, not "no rows". */
function readMaxRows(maxRows) {
  const n = Number(maxRows);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * The leading keyword, after any leading whitespace and comments — a statement
 * written as `-- fix later\nUPDATE t SET a = 1` still returns a status, not rows.
 */
function leadingVerb(sql) {
  let text = String(sql ?? '');
  for (;;) {
    const before = text.length;
    text = text.replace(/^\s+/, '');
    if (text.startsWith('--')) text = text.slice(text.indexOf('\n') + 1 || text.length);
    else if (text.startsWith('/*')) {
      const end = text.indexOf('*/');
      text = end === -1 ? '' : text.slice(end + 2);
    }
    if (text.length === before) break;
  }
  return (/^([a-z]+)/i.exec(text) || ['', ''])[1].toUpperCase();
}

/**
 * Carry the driver’s own `code` and `name` onto the rewritten error. The rewrite
 * replaces the error rather than appending, so `code` is the field that must not be
 * lost doing it: `SQLITE_BUSY`, `SQLITE_NOTADB`, `SQLITE_READONLY` and
 * `SQLITE_CANTOPEN` are in SQLite's own documentation and are the only part of a
 * driver error a caller can test rather than read.
 */
function described(replacement, original) {
  const code = typeof original?.code === 'string' ? original.code : undefined;
  if (code !== undefined) {
    replacement.code = code;
    replacement.name = original.name;
  }
  return replacement;
}

function isRowReturning(sql) {
  return ROW_RETURNING.has(leadingVerb(sql));
}

/**
 * Statements that change the state of the handle rather than the database.
 *
 * There is no pool here, which is the usual reason to allow these. It is the same
 * hazard and not a smaller one: one cached adapter is one handle, shared for the
 * life of the cache entry, and a `BEGIN` on call *n* leaves the call *n+1*
 * reading a snapshot nobody asked for while holding a read lock the next writer
 * needs.
 */
const SESSION_STATE = /\b(BEGIN|START\s+TRANSACTION|COMMIT|END\s+TRANSACTION|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

function refuseSessionState(sql) {
  const match = SESSION_STATE.exec(String(sql ?? ''));
  if (!match) return;
  throw new Error(
    `[SQLite transactions are not supported] "${match[1].toUpperCase()}" changes the state of the `
    + 'open handle, so the next caller would inherit it - and an open transaction holds its locks '
    + 'against every other process writing the same file. Every statement runs in its own implicit '
    + 'transaction, which SQLite closes before it answers. Set readOnly:false to write rows; a '
    + 'multi-statement transaction needs a tool that pins one handle across calls, which this server '
    + 'does not have.'
  );
}

/**
 * Mark a result as a prefix of the answer. See `markTruncated` in postgres.js:
 * a truncated answer is a partial answer, and the caller has to be able to tell.
 */
function markTruncated(rows, truncated) {
  if (truncated) {
    Object.defineProperty(rows, 'truncated', { value: true, enumerable: false, configurable: true });
    Object.defineProperty(rows, 'limitReason', { value: 'maxRows', enumerable: false, configurable: true });
  }
  return rows;
}

export { loadSqlite3, OPEN };
