import { BaseAdapter, positiveInt, logCloseFailure } from '../core/base-adapter.js';
import { PostgresSchemaAdapter } from '../core/schema.js';

// Concurrent statements one cached connection may have in flight. Same shape of
// knob as MySQL's connectionLimit: fan out harder via ANYDB_PG_POOL_MAX.
const DEFAULT_POOL_MAX = 4;

// Matched to the cache's idle TTL, so a warm socket survives the whole window the
// cache is willing to keep the entry. pg-pool's 10s default empties the pool
// between calls and turns every follow-up query into a TCP handshake plus a
// fresh authentication.
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// SQLSTATE codes worth a plain description. Without these every failure reads as
// a syntax error, which sends the caller looking at the wrong thing.
const ERROR_HINTS = {
  '42601': 'SQL syntax error',
  '42P01': 'relation (table or view) does not exist',
  '42703': 'column does not exist',
  '42704': 'object does not exist',
  '42P07': 'relation already exists',
  '42501': 'insufficient privilege (read-only user?)',
  '23505': 'duplicate key violates a unique constraint',
  '23503': 'foreign key constraint fails',
  '23502': 'not-null constraint fails',
  '23514': 'check constraint fails',
  '40001': 'serialization failure, retry the transaction',
  '40P01': 'deadlock detected',
  '55P03': 'could not obtain a lock on the row',
  '53300': 'too many connections',
  '57014': 'query cancelled by timeout',
  // A `$n` placeholder with no value. pg's own text does not say how many were
  // expected, and this is the one driver error a caller fixes in one argument.
  '42P02': 'no value supplied for a bind placeholder',
};

// Command tags for statements that return a status rather than rows.
const STATUS_COMMANDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MOVE', 'FETCH', 'COPY', 'MERGE',
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT', 'VACUUM',
  'ANALYZE', 'REINDEX', 'CLUSTER', 'CHECKPOINT', 'DISCARD', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'LOCK', 'SET', 'RESET', 'CALL', 'DO',
  'PREPARE', 'EXECUTE', 'DEALLOCATE', 'DECLARE', 'REFRESH', 'REASSIGN',
]);

/**
 * Statements that change the state of the session they run on, and the reasons
 * each one is refused. See `refuseSessionState` for what a pooled `BEGIN` costs
 * the next borrower.
 */
const SESSION_STATE = /\b(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ABORT)\b/i;

/**
 * Statements that can leave a transaction open, so a release has to roll one back.
 * Every other statement runs in an implicit transaction the server closes before
 * answering, and the durable openers are refused above.
 */
const MAY_OPEN_TRANSACTION = /^\s*(call|do)\b/i;

export class PostgresAdapter extends BaseAdapter {
  /**
   * @param {Function} [poolClass] - `pg.Pool`. Left `undefined` it is resolved on
   *   the first `connect()`; see `loadPgDriver`.
   * @param {number} [timeout=30000]
   * @param {Function} [clientClass] - `pg.Client`. A cancel is delivered on a
   *   connection of its own, which the injected pool does not provide.
   * @param {Function} [queryClass] - `pg.Query`. pg only hands back the Query it
   *   is waiting on when there is no callback, and that object is the only thing
   *   a cancel request can be aimed at.
   */
  constructor(poolClass = undefined, timeout = 30000, clientClass = undefined, queryClass = undefined) {
    super(5000, timeout);
    this.PoolClass = poolClass;
    this.ClientClass = clientClass;
    this.QueryClass = queryClass;
    // The (client, query) pairs a cancel can still be aimed at. The pool hands
    // the same client to several callers, so this is per statement, not per pool.
    this.inFlight = new Set();
    this.aborted = false;
  }

  /**
   * The driver, loaded once, on first use.
   *
   * Not a module-scope import: a library consumer loads `src/lib.js` and pays for
   * parsing pg whether or not PostgreSQL is ever touched. Keeping it inside
   * `connect()` also puts it inside the registry's `timeout + grace` budget, so a
   * slow load is reported as a slow connect rather than a slow query.
   *
   * Three states, and the third is not optional: `undefined` is filled in from
   * the driver (the production path), a function is left alone (how the tests
   * inject doubles), and an explicit `null` means "this build has no such
   * constructor" and is *not* filled in, so `connect()` reaches the worded
   * refusal below instead of importing a driver the caller already said is absent.
   */
  async loadPgDriver() {
    if (this.PoolClass === undefined || this.ClientClass === undefined || this.QueryClass === undefined) {
      const driver = await import('pg');
      if (this.PoolClass === undefined) this.PoolClass = driver.Pool;
      if (this.ClientClass === undefined) this.ClientClass = driver.Client;
      if (this.QueryClass === undefined) this.QueryClass = driver.Query;
    }
    return this;
  }

  async connect(uri) {
    await this.loadPgDriver();

    if (typeof this.PoolClass !== 'function') {
      throw new Error(
        '[PostgreSQL driver unavailable] This build has no pg.Pool, so there is nothing to connect with. '
        + 'Install the driver alongside this package, or pass a Pool constructor as the first argument '
        + 'to PostgresAdapter.'
      );
    }

    this.connectionOptions = {
      connectionString: uri,
      connectionTimeoutMillis: this.connectTimeout,
      // Same clock as the cache's idle TTL; see the constant above.
      idleTimeoutMillis: positiveInt(process.env.ANYDB_CACHE_TTL_MS, DEFAULT_IDLE_TIMEOUT_MS),
      // Names this process in pg_stat_activity, so a statement holding a row
      // lock traces back to the tool that asked for it.
      application_name: 'anydb-mcp',
      // Bound the pool the way MySQL's connectionLimit is bounded.
      max: positiveInt(process.env.ANYDB_PG_POOL_MAX, DEFAULT_POOL_MAX),
      // So an intermediary that drops an idle backend drops it on its own terms.
      keepAlive: true,
    };
    this.pool = new this.PoolClass(this.connectionOptions);
  }

  /**
   * Run one statement.
   *
   * @param {string} sql - Statement text. Placeholders are Postgres's own `$1`,
   *   `$2`, …, which is what `options.params` is bound to. Nothing is
   *   interpolated into the statement on the caller's behalf.
   * @param {object} [options]
   * @param {Array}  [options.params] - Values for the `$n` placeholders, in order.
   * @param {number} [options.maxRows] - Stop accumulating rows at this many and
   *   mark the answer `truncated`.
   * @param {number} [options.timeout] - This call's budget, in milliseconds.
   */
  async execute(sql, options = {}) {
    // Snapshotted once for the whole statement: the pool is shared, so
    // this.queryTimeout may not be this call's budget by the time the server
    // reads the setting below.
    const timeout = statementTimeout(this.resolveQueryTimeout(options));
    const params = readParams(options.params);
    const maxRows = readMaxRows(options.maxRows);

    refuseSessionState(sql);

    // statement_timeout is a session setting, so SET and the query must run on
    // the same connection. Two pool.query() calls can land on two different
    // clients, which silently leaves the timeout unenforced.
    const client = await this.pool.connect();

    // Tracked before the statement is built, with no await in between, so no
    // abort can land in the window where the statement is about to run.
    const statement = { client, query: null, sql };
    this.inFlight.add(statement);

    try {
      await client.query(`SET statement_timeout = ${timeout}`);
      const rows = await this.runStatement(client, statement, sql, params, maxRows);
      return rows;
    } catch (err) {
      throw this.describeError(explainBindError(err, params, sql), timeout);
    } finally {
      this.inFlight.delete(statement);
      await this.releaseClean(client, sql);
    }
  }

  /**
   * Submit the statement and shape what comes back. The capped and uncapped paths
   * differ in how pg delivers rows, which the note below spells out.
   */
  async runStatement(client, statement, sql, params, maxRows) {
    if (maxRows === null) {
      const result = await new Promise((resolve, reject) => {
        const query = new this.QueryClass(sql, params, (err, res) => (err ? reject(err) : resolve(res)));
        statement.query = query;
        client.query(query);
      });
      return shapeResult(result);
    }

    // Capped. A callback on the Query makes pg accumulate rows whatever listeners
    // are attached, so the bounded path builds the Query *without* one and waits
    // for `end`; pg then emits each row and keeps none, while the result object
    // still carries `command`, `rowCount` and `fields`. The uncapped path above
    // must wait on the callback rather than the `error` event for the same
    // reason: `handleError` calls the callback and never emits `error`.
    //
    // What this does not bound: the server still runs to completion and pg still
    // reads every row off the socket. What is bounded is the parsed-row array in
    // this process — the part that grows without limit. A real server-side cap is
    // a cursor (`pg-cursor`), which is not a dependency of this package.
    const rows = [];
    let truncated = false;

    const result = await new Promise((resolve, reject) => {
      const query = new this.QueryClass(sql, params);
      query.on('row', (row) => {
        if (rows.length < maxRows) rows.push(row);
        // The cap is a prefix, not a sample: a row past it is still proof the
        // answer is longer than what is being returned.
        else truncated = true;
      });
      query.once('end', (res) => resolve(res));
      query.once('error', (err) => reject(err));
      statement.query = query;
      client.query(query);
    });

    return markTruncated(shapeResult({ ...result, rows }), truncated);
  }

  /**
   * Return the client to the pool with its session state reset.
   *
   * Costs one round trip per call; buys that no caller can leave behind a `SET`,
   * a `search_path`, a `role` or an open transaction for the next borrower.
   * Evicting any client whose session state might have changed instead throws
   * away a warm authenticated socket on every statement that *might* have
   * touched it, which is the cost the connection cache exists to avoid.
   */
  async releaseClean(client, sql) {
    try {
      if (!this.aborted) {
        // `ROLLBACK` only for the two statements that can run server-side code
        // capable of leaving a transaction open; see MAY_OPEN_TRANSACTION.
        if (MAY_OPEN_TRANSACTION.test(String(sql ?? ''))) await client.query('ROLLBACK');
        await client.query('RESET ALL');
      }
      client.release?.();
    } catch {
      // A connection that cannot be reset is not safe to hand on. Destroying it
      // costs one reconnect; leaking its state costs a wrong answer.
      try { client.release?.(true); } catch { /* already gone */ }
    }
  }

  /** One round trip to tell a closed idle connection from a live one. */
  async isHealthy() {
    // An aborted pool is not healthy even though `pool` is still set: the cache
    // has to rebuild rather than hand out a pool it has already given up on.
    if (!this.pool || this.aborted) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ask the server to stop the statement the caller has given up on.
   *
   * Postgres cannot interrupt a running statement in band. The only mechanism is
   * a CancelRequest — a second, unauthenticated connection carrying the backend's
   * process id and secret — which pg exposes as `Client#cancel(target, query)`
   * and which only acts when handed the exact Query the target client is waiting
   * on, hence the hand-built Query in `execute()`.
   *
   * A request, not a guarantee: a statement the server has not started receiving,
   * or one inside a non-interruptible operation, keeps going, and a cancel can
   * arrive after the caller's own guard gave up. What it does guarantee is that
   * this pool is not handed out again and that `close()` will not wait for a
   * statement that turns out to be uninterruptible.
   */
  abort() {
    if (this.aborted) return;
    this.aborted = true;

    for (const { client, query } of this.inFlight) {
      if (!query) continue;
      try {
        new this.ClientClass(this.connectionOptions).cancel(client, query);
      } catch {
        // The cancel connection could not even be attempted. close() will not
        // wait for this statement either way, so there is nothing left to try.
      }
    }
    this.inFlight.clear();
  }

  describe(options = {}) {
    const schema = new PostgresSchemaAdapter(this.connectTimeout, this.resolveQueryTimeout(options));
    schema.pool = this.pool;
    // db_schema asks this describer too, so the same missing relation reads the
    // same way from db_query and db_schema.
    schema.describeError = (err) => this.describeError(err, schema.queryTimeout);
    return schema.describe(options);
  }

  describeError(err, timeout = this.queryTimeout) {
    const code = err && err.code;
    const detail = (err && err.message) || String(err);
    // The driver's error is kept as the cause, so the registry can classify the
    // failure and the logger can print a stack that leads somewhere.
    const withCause = (message) => (err instanceof Error ? new Error(message, { cause: err }) : new Error(message));

    // 57014 is also raised by a manual cancel, so only claim "timeout" when the
    // server actually blamed the timeout.
    if (code === '57014') {
      if (/statement timeout/i.test(detail)) {
        return withCause(`[Postgres timeout] Query exceeded ${timeout}ms (statement_timeout)`);
      }
      return withCause(`[Postgres cancelled] ${detail}`);
    }

    if (code === 'ETIMEDOUT' || /timeout exceeded/i.test(detail)) {
      return withCause(`[Postgres timeout] Query exceeded ${timeout}ms: ${detail}`);
    }

    if (code === 'ECONNREFUSED') {
      return withCause(`[Postgres connection refused] ${detail}`);
    }

    const hint = ERROR_HINTS[code];
    return withCause(`[Postgres ${hint || code || 'error'}] ${detail}`);
  }

  async close() {
    const pool = this.pool;
    if (!pool) return;
    this.pool = null;
    this.inFlight.clear();

    // The reference goes, the pool does not. end() is what releases the pool's
    // clients and timers, so dropping the field without calling it is what leaves
    // them outliving the adapter.
    const ending = pool.end();

    // pg-pool resolves end() only once every client has been released, and a
    // statement that survived the cancel holds its client until the server
    // finishes with it. After an abort, end the pool but do not wait on it.
    if (this.aborted) {
      void Promise.resolve(ending).catch(() => {});
      return;
    }

    try {
      await ending;
    } catch (err) {
      try {
        logCloseFailure('postgres', err, { aborted: this.aborted });
      } catch {
        // Degraded logging is still better than a close() that throws.
      }
    }
  }
}

/** The one per-statement shape: rows, or a single status object. */
function shapeResult(result) {
  // A data-modifying statement returns rows: [] just like an empty SELECT, so
  // the command tag is what tells them apart.
  if (STATUS_COMMANDS.has(result.command)) {
    return [{
      affectedRows: result.rowCount ?? 0,
      command: result.command,
      oid: result.oid ?? null,
    }];
  }
  return Array.isArray(result.rows) ? result.rows : [];
}

/**
 * The values for the statement's `$n` placeholders. `undefined` is refused rather
 * than coerced, because pg would send it as NULL and quietly store one.
 */
function readParams(params) {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) {
    throw new Error(
      "'params' must be an array of values bound to the statement's $1, $2, … placeholders, "
      + `got ${typeof params}.`
    );
  }
  if (params.some((value) => value === undefined)) {
    throw new Error(
      "'params' contains undefined, which Postgres cannot bind. Use null for SQL NULL, "
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
 * Say something useful about a bind failure.
 *
 * pg names both counts but not the fix, and the fix is a one-token edit to
 * `params`, so the placeholders with no value are named explicitly.
 */
function explainBindError(err, params, sql) {
  if (!err || !/\bbind message supplies\b/i.test(err.message || '')) return err;

  const placeholders = new Set();
  const pattern = /\$(\d+)/g;
  let match;
  while ((match = pattern.exec(String(sql ?? ''))) !== null) placeholders.add(match[1]);

  const numbers = [...placeholders].map(Number).sort((a, b) => a - b);
  const required = numbers.length ? numbers[numbers.length - 1] : 0;
  const missing = numbers.filter((n) => n > params.length);

  const explained = new Error(
    `[Postgres bound parameters] The statement has ${required} placeholder(s) `
    + `(${numbers.map((n) => `$${n}`).join(', ')}) and ${params.length} value(s) were supplied`
    + `${missing.length ? `; $${missing.join(', $')} has no value` : ''}. `
    + 'Add the missing values to "params", in placeholder order, or remove the placeholder.'
  );
  explained.code = err.code;
  explained.cause = err;
  return explained;
}

/**
 * Refuse a statement that would change the session, in every read-only mode.
 *
 * A cached client is shared, so a `BEGIN` on call *n* leaves an open transaction
 * for the next borrower, whose `SELECT`s then run inside a foreign transaction
 * holding locks and a snapshot. The registry's dead-connection test matches
 * nothing about a successful `BEGIN`, so the client would sit in the cache for
 * its whole TTL. Refuse rather than leak.
 */
function refuseSessionState(sql) {
  const match = SESSION_STATE.exec(String(sql ?? ''));
  if (!match) return;
  throw new Error(
    `[Postgres transactions are not supported] "${match[1].toUpperCase()}" changes the state of the pooled `
    + 'connection, so the next caller would inherit it. Every statement runs in its own implicit transaction. '
    + 'Set readOnly:false to write rows; a multi-statement transaction needs a tool that pins one connection '
    + 'across calls, which this server does not have.'
  );
}

/**
 * Mark a result as a prefix of the answer.
 *
 * A truncated answer is a *partial* answer and the caller has to be able to
 * tell. The marker is a non-enumerable own property on the rows array: absent
 * from `JSON.stringify`, no effect on length or iteration, and still readable as
 * a plain `truncated` key by `result-limits`.
 */
function markTruncated(rows, truncated) {
  if (truncated) {
    Object.defineProperty(rows, 'truncated', { value: true, enumerable: false, configurable: true });
    Object.defineProperty(rows, 'limitReason', { value: 'maxRows', enumerable: false, configurable: true });
  }
  return rows;
}

/**
 * The value to put in `SET statement_timeout`.
 *
 * Postgres accepts whole milliseconds only and the setting is interpolated as a
 * string, so a fractional value would surface as a query failure rather than a
 * bad argument. The caller's validation checks range and finiteness, not
 * integrality, so truncate here. 0 disables the server-side limit, which is the
 * only safe reading of a value that is not a real duration.
 */
function statementTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return 0;
  return Math.trunc(timeoutMs);
}
