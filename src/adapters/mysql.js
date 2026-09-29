import { BaseAdapter, positiveInt } from '../core/base-adapter.js';
import { logError } from '../core/logging.js';
import { MySQLSchemaAdapter } from '../core/schema.js';

// Concurrent statements one cached connection may have in flight. Small on
// purpose: the pool is shared by every caller of one URI, and a pool that can
// grow on demand turns a typo into a socket storm.
const DEFAULT_POOL_SIZE = 4;

// Error codes worth a plain description. Without these every failure reads as
// a syntax error, which sends the caller looking at the wrong thing.
const ERROR_HINTS = {
  ER_PARSE_ERROR: 'SQL syntax error',
  ER_SYNTAX_ERROR: 'SQL syntax error',
  ER_NO_SUCH_TABLE: 'table does not exist',
  ER_BAD_TABLE_ERROR: 'table does not exist',
  ER_BAD_FIELD_ERROR: 'column does not exist',
  ER_BAD_DB_ERROR: 'database does not exist',
  ER_NO_DB_ERROR: 'no database selected',
  ER_DUP_ENTRY: 'duplicate key violates a unique constraint',
  ER_NO_REFERENCED_ROW: 'foreign key constraint fails (no parent row)',
  ER_ROW_IS_REFERENCED: 'foreign key constraint fails (row still referenced)',
  ER_ACCESS_DENIED_ERROR: 'access denied (check credentials and grants)',
  ER_DBACCESS_DENIED_ERROR: 'access denied to database',
  ER_TABLEACCESS_DENIED_ERROR: 'access denied to table',
  ER_READ_ONLY_TRANSACTION: 'database or table is read-only',
  ER_LOCK_WAIT_TIMEOUT: 'lock wait timeout (row locked by another transaction)',
  ER_LOCK_DEADLOCK: 'deadlock detected',
  ER_QUERY_TIMEOUT: 'query exceeded the max_execution_time',
  ER_OPTION_PREVENTS_STATEMENT: 'statement blocked by max_execution_time',
  ER_LOCK_TABLE_FULL: 'table is full',
  ER_TOO_MANY_USER_CONNECTIONS: 'too many connections for this user',
};

const TIMEOUT_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ER_QUERY_TIMEOUT',
  'ER_OPTION_PREVENTS_STATEMENT',
  'PROTOCOL_SEQUENCE_TIMEOUT',
]);

/**
 * Statements that change the state of the session they run on.
 *
 * Worse here than in Postgres: a `BEGIN` on a pooled MySQL connection holds its row
 * locks until `innodb_lock_wait_timeout` expires, and with `waitForConnections` the
 * pool then has one fewer connection to give. The `resetOnRelease` below is the
 * belt to this braces.
 */
const SESSION_STATE = /\b(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|LOCK\s+TABLES|UNLOCK\s+TABLES|FLUSH|SET\s+AUTOCOMMIT)\b/i;

/**
 * Query-string parameters this adapter honours. Anything else is *reported*,
 * not ignored: a URI parameter that looks like it configures something and does
 * not is the worst kind of silent failure, and `?ssl-mode=REQUIRED` on a
 * plaintext connection is the one that matters most.
 */
const HONOURED_PARAMS = new Set([
  'ssl', 'ssl-mode', 'ssl_mode',
  'ssl_ca', 'ssl_cert', 'ssl_key', 'ssl_cipher', 'ssl_verify_server_cert', 'ssl_verify_identity',
  'charset', 'collation', 'timezone', 'socket', 'socketpath',
  'connect_timeout', 'connection_limit',
  'named_placeholders', 'rows_as_array', 'multiple_statements', 'date_strings',
  'decimal_numbers', 'big_number_strings', 'support_big_numbers',
  'insecure_auth', 'trace', 'debug', 'compress', 'flags', 'auth_plugins', 'auth_switch_handling',
]);

/** Accepted spellings that mean one thing, folded onto the name used below. */
const PARAM_ALIASES = new Map([
  ['ssl_mode', 'ssl-mode'],
  ['socketpath', 'socket'],
  ['connect_timeout', 'connectTimeout'],
  ['connection_limit', 'connectionLimit'],
  ['named_placeholders', 'namedPlaceholders'],
  ['rows_as_array', 'rowsAsArray'],
  ['multiple_statements', 'multipleStatements'],
  ['date_strings', 'dateStrings'],
  ['decimal_numbers', 'decimalNumbers'],
  ['big_number_strings', 'bigNumberStrings'],
  ['support_big_numbers', 'supportBigNumbers'],
  ['insecure_auth', 'insecureAuth'],
]);

/**
 * `ssl-mode` values: the spelling a Postgres-trained user reaches for. Modes
 * demanding verification become TLS with certificate checking; the permissive
 * ones become TLS without it, because `REQUIRED` and `VERIFY_CA` are not the
 * same promise and an unrecognised mode is refused rather than read as
 * "off" (see `resolveSsl`).
 */
const SSL_MODES = new Set(['DISABLED', 'DISABLE', 'FALSE', '0', 'OFF']);
const SSL_MODES_INSECURE = new Set(['PREFERRED', 'ALLOW', 'TRUE', '1', 'ON']);

export class MySQLAdapter extends BaseAdapter {
  /**
   * @param {Function} [connectionFactory] - mysql2 pool factory. A pool, not a
   *   single connection: a cached connection is shared by concurrent requests.
   *   Left `undefined`, it is resolved on the first `connect()`.
   * @param {number} [poolSize] - Maximum concurrent statements. Falls back to
   *   ANYDB_MYSQL_POOL_MAX, then to the default.
   */
  constructor(connectionFactory = undefined, timeout = 30000, poolSize = undefined) {
    super(5000, timeout);
    this.ConnectionFactory = connectionFactory;
    this.poolSize = positiveInt(poolSize ?? process.env.ANYDB_MYSQL_POOL_MAX, DEFAULT_POOL_SIZE);
    // Sockets the pool has opened, tracked for abort(). See trackPoolSockets().
    this.sockets = new Set();
    this.onConnection = null;
    this.aborted = false;
  }

  /**
   * The driver, loaded once, on first use.
   *
   * Not a module-scope import, so a consumer that only ever asks this package about
   * Postgres does not parse the mysql2 client. Keeping the load inside `connect()`
   * also puts it inside the registry's `timeout + grace` budget, so a slow load is
   * reported as a slow connect rather than a slow query.
   *
   * Three states, and the third is not optional: `undefined` is filled in from the
   * driver (the production path), a function is left alone (how the tests inject
   * doubles), and an explicit `null` means "this build has no such factory" and is
   * *not* filled in, so `connect()` reaches the worded refusal below instead of
   * importing a driver the caller already said is absent.
   */
  async loadMySQLDriver() {
    if (this.ConnectionFactory === undefined) {
      this.ConnectionFactory = (await import('mysql2/promise')).createPool;
    }
    return this;
  }

  async connect(uri) {
    await this.loadMySQLDriver();

    if (typeof this.ConnectionFactory !== 'function') {
      throw new Error(
        '[MySQL driver unavailable] This build has no mysql2 createPool, so there is nothing to connect with. '
        + 'Install the driver alongside this package, or pass a pool factory as the first argument '
        + 'to MySQLAdapter.'
      );
    }

    // Accept dialects other tools emit, e.g. SQLAlchemy's mysql+pymysql://
    const normalizedUri = uri.replace(/^mysql\+(?:pymysql|mysqldb|asyncmy|aiohttp)\:\/\//i, 'mysql://');

    let url;
    try {
      url = new URL(normalizedUri);
    } catch {
      throw new Error('Invalid MySQL URI format. Expected: mysql://user:password@host:port/database');
    }

    const query = readQueryParams(url);

    const config = {
      host: url.hostname,
      port: parseInt(url.port, 10) || 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      connectTimeout: positiveInt(query.connectTimeout ?? query.connect_timeout, this.connectTimeout),
      // Bound the pool so one caller cannot open sockets without limit.
      connectionLimit: positiveInt(
        query.connectionLimit ?? query.connection_limit,
        this.poolSize
      ),
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      // COM_RESET_CONNECTION on every release: rolls back an open transaction and
      // restores session variables, so a `BEGIN` that got through does not hold
      // row locks for the next borrower. One round trip per call, and still only
      // the belt to the SESSION_STATE refusal.
      resetOnRelease: true,
      // Stated rather than inherited. A latin1 default mis-encodes anything else
      // and the corruption only surfaces in a `é`.
      charset: query.charset ?? 'UTF8MB4',
      ...(query.collation ? { collation: query.collation } : {}),
      // UTC by default, so a DATETIME written on one host and read on another is
      // the same instant. mysql2's own default is 'local'.
      timezone: query.timezone ?? 'Z',
      // MySQL 8's default plugin, caching_sha2_password, cannot authenticate over
      // a plaintext channel at all: it asks for the server's RSA public key and
      // encrypts the password with it. mysql2 does that exchange by default, so a
      // plaintext connection to a MySQL 8 server works — but the password is still
      // on the wire, so a URI asking for TLS still gets it.
      // `?insecure-auth=true` turns the exchange off.
      insecureAuth: Boolean(query.insecureAuth ?? query.insecure_auth),
      // Without these, mysql2 returns a JS number for a value above 2^53 and the
      // low bits are gone. Postgres returns int8 as a *string*; with both flags set
      // the two backends agree, at the cost of a JSON consumer that must parse it.
      supportBigNumbers: true,
      bigNumberStrings: true,
      ...(query.namedPlaceholders || query.named_placeholders ? { namedPlaceholders: true } : {}),
      ...(query.dateStrings || query.date_strings ? { dateStrings: true } : {}),
      ...(query.decimalNumbers || query.decimal_numbers ? { decimalNumbers: true } : {}),
      ...(query.rowsAsArray || query.rows_as_array ? { rowsAsArray: true } : {}),
      ...(query.multipleStatements || query.multiple_statements ? { multipleStatements: true } : {}),
      ...(query.debug === '1' || query.debug === 'true' ? { debug: true } : {}),
    };

    if (query.socket) {
      // A unix-socket or named-pipe connection. The host is then a placeholder
      // the server ignores, and there is no TLS or DNS to speak of.
      config.socketPath = query.socket;
    }

    const ssl = resolveSsl(query);
    if (ssl) config.ssl = ssl;

    if (query.unknown.length > 0) {
      this.warnUnsupported(query.unknown);
    }

    try {
      this.pool = this.ConnectionFactory(config);
    } catch (err) {
      throw this.describeError(err);
    }

    this.trackPoolSockets();
  }

  /**
   * Warn about a query-string parameter that is being ignored.
   *
   * Not silent, and not fatal: an unknown parameter is usually harmless (a tool
   * appends one this server has never heard of), but the one that matters is a
   * *security* parameter the user believes was honoured. Refusing the whole
   * connection over `?replication=true` would be worse than saying so.
   */
  warnUnsupported(names) {
    try {
      logError(
        'mysql_uri_param_ignored',
        new Error(
          `MySQL URI parameter(s) not honoured and ignored: ${names.join(', ')}. `
          + `Honoured: ${[...HONOURED_PARAMS].sort().join(', ')}.`
        ),
        { adapter: 'mysql' }
      );
    } catch {
      // Degraded logging must not fail a connection.
    }
  }

  /**
   * Remember every socket the pool opens, because that is the only way to reach
   * them. `mysql2/promise`'s PromisePool exposes no connection list — its `.pool`
   * is the callback-mode BasePool, and that pool's `_allConnections` is internal —
   * so the public `connection` event is the only supported way. Attached before
   * the first query, so no connection can be opened unobserved.
   */
  trackPoolSockets() {
    const pool = this.pool;
    if (!pool || typeof pool.on !== 'function') return;

    this.onConnection = (conn) => {
      if (this.aborted) {
        // The pool opens connections on demand, so anything from here on is a
        // socket nobody is waiting for.
        this.destroySocket(conn);
        return;
      }
      this.sockets.add(conn);
      // The pool already unhooks its own connections on 'end' and 'error';
      // dropping it here too keeps the set from growing for the life of a
      // long-lived cached connection.
      conn.once?.('end', () => this.sockets.delete(conn));
      conn.once?.('error', () => this.sockets.delete(conn));
    };
    pool.on('connection', this.onConnection);
  }

  untrackPoolSockets(pool) {
    if (pool && this.onConnection) {
      pool.off?.('connection', this.onConnection);
    }
    this.onConnection = null;
    this.sockets.clear();
  }

  destroySocket(conn) {
    try {
      conn.destroy();
    } catch {
      // Already destroyed, or the socket closed while we were iterating.
    }
  }

  /**
   * Run one statement.
   *
   * @param {string} sql - Statement text. Placeholders are MySQL's own `?`,
   *   which is what `options.params` is bound to.
   * @param {object} [options]
   * @param {Array}  [options.params] - Values for the `?` placeholders, in order.
   * @param {number} [options.maxRows] - Stream the result and stop accumulating at
   *   this many rows, marking the answer `truncated`.
   * @param {number} [options.timeout] - This call's budget, in milliseconds.
   */
  async execute(sql, options = {}) {
    // Read once, here: the pool is shared, so this.queryTimeout may not be this
    // call's budget by the time the server sees it.
    const timeout = this.resolveQueryTimeout(options);
    const params = readParams(options.params);
    const maxRows = readMaxRows(options.maxRows);

    refuseSessionState(sql);

    const text = withExecutionLimit(sql, timeout);

    try {
      if (maxRows === null) {
        // The buffered path, and the common one: the result arrives whole in one
        // reply, and the code stays a promise and a destructure.
        const [rows] = params.length
          ? await this.pool.query(text, params)
          : await this.pool.query(text);
        return normalizeRows(rows);
      }
      return await this.executeBounded(text, params, maxRows, timeout);
    } catch (err) {
      throw this.describeError(explainBindError(err, params, sql), timeout);
    }
  }

/**
 * The capped path: mysql2's query stream, with a callback deliberately absent.
 *
 * A callback makes mysql2 accumulate every row; without one it emits them one at a
 * time and retains none. `stream()` then hands back an object-mode Readable that
 * pauses the socket when its buffer fills. What this does not bound: the server
 * still runs the statement to completion and mysql2 still reads every row off the
 * socket. The connection is released only after the stream ends, because handing a
 * socket back mid-resultset is how one caller's rows turn up in another's result.
 *
 * How a row is told from a status: by the `fields` event, not by its type. A
 * `TextRow` is a plain object just like the `ResultSetHeader` for a statement with
 * no result set, so `Array.isArray` cannot separate them. `doneInsert` emits
 * `'fields', void 0` before the status while `readField` emits the real field list
 * before any row, so a non-empty payload means "rows from here".
 */
  async executeBounded(text, params, maxRows, timeout) {
    if (typeof this.pool.getConnection !== 'function') {
      // No stream path available (an injected pool that is not mysql2's). The
      // answer is still capped; only the server-side work is not.
      const [rows] = params.length
        ? await this.pool.query(text, params)
        : await this.pool.query(text);
      const normalized = normalizeRows(rows);
      return markTruncated(normalized.slice(0, maxRows), normalized.length > maxRows);
    }

    const conn = await this.pool.getConnection();
    const rows = [];
    let truncated = false;
    let status = null;
    let inRowPhase = false;

    try {
      const command = conn.connection.query({
        sql: text,
        ...(params.length ? { values: params } : {}),
        timeout: inactivityTimeout(timeout),
      });
      // Attached before `stream()` reads: the command has been written to the
      // socket but the server has not answered, so no `fields` event can have
      // been missed.
      command.on?.('fields', (fields) => {
        if (Array.isArray(fields)) inRowPhase = true;
      });
      // No callback: see the note above. `stream()` must be attached before the
      // command can finish, and it is, synchronously; it also wires the
      // command's own `error` to `stream.destroy(err)`.
      for await (const row of command.stream({ highWaterMark: maxRows })) {
        if (!inRowPhase) {
          // No result set: the one value is the OkPacket, and it is the status
          // object the other backends return.
          status = row;
          continue;
        }
        if (rows.length < maxRows) rows.push(row);
        // The cap is a prefix, not a sample: a row past it is proof the answer
        // is longer than what is being returned.
        else truncated = true;
      }
    } finally {
      this.pool.releaseConnection?.(conn);
    }

    if (status && rows.length === 0) return [statusObject(status)];
    return markTruncated(rows, truncated);
  }

  describe(options = {}) {
    const schema = new MySQLSchemaAdapter(this.connectTimeout, this.resolveQueryTimeout(options));
    schema.pool = this.pool;
    // db_schema asks this describer too, so a missing table reads the same way
    // from db_schema and db_query.
    schema.describeError = (err) => this.describeError(err, schema.queryTimeout);
    return schema.describe(options);
  }

  /**
   * Name the failure the server actually reported.
   *
   * @returns {Error} A message carrying the driver code and SQL text
   */
  describeError(err, timeout = this.queryTimeout) {
    const code = err && err.code;
    const detail = (err && (err.sqlMessage || err.message)) || String(err);
    // The driver's own error is kept as the cause, so the registry can classify
    // the failure and the logger can print a stack that leads somewhere.
    const withCause = (message) => (err instanceof Error ? new Error(message, { cause: err }) : new Error(message));

    if (TIMEOUT_CODES.has(code) || /timed out/i.test(detail)) {
      return withCause(`MySQL query exceeded ${timeout}ms timeout: ${detail}`);
    }

    if (code === 'ECONNREFUSED') {
      return withCause(`MySQL connection refused at the given host and port: ${detail}`);
    }

    if (code === 'ENOTFOUND') {
      return withCause(`MySQL host not found: ${detail}`);
    }

    const hint = ERROR_HINTS[code];
    const prefix = hint ? `[MySQL ${hint}]` : `[MySQL ${code || 'error'}]`;

    return withCause(`${prefix}: ${detail}`);
  }

  /**
   * One round trip to tell a closed idle connection from a live one.
   */
  async isHealthy() {
    // An aborted pool is not healthy even though `pool` is still set: the cache
    // has to rebuild rather than hand out a pool whose sockets are being closed.
    if (!this.pool || this.aborted) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Drop the sockets, so the server stops executing a statement the caller has
   * already given up on.
   *
   * The pool object is deliberately kept: `end()` is what releases its bookkeeping
   * and its idle-reaper timer, and disowning it here is what orphaned the pool
   * with live sockets. `aborted` marks the adapter dead instead, and the tracking
   * listener turns that into a rule: a socket opened from now on is destroyed.
   */
  abort() {
    if (this.aborted) return;
    this.aborted = true;

    for (const conn of this.sockets) this.destroySocket(conn);
    this.sockets.clear();
  }

  async close() {
    const pool = this.pool;
    if (!pool) return;
    this.pool = null;
    this.untrackPoolSockets(pool);

    const ending = pool.end();
    if (this.aborted) {
      // abort() force-closed the sockets, so the Quit commands end() enqueues can
      // never be answered and its callback may never arrive. end() still has to
      // run, or the pool's timers outlive this adapter — but waiting on a peer
      // that is not going to answer is how teardown hangs.
      void Promise.resolve(ending).catch(() => {});
      return;
    }

    try {
      await ending;
    } catch (err) {
      // Through the logger rather than console.error: attributable, masked by the
      // same rules as every other record, and the error object survives, which
      // is what makes "ANYDB_DEBUG=1 for a stack trace" true on the abort path.
      try {
        logError('adapter_close', err, { adapter: 'mysql' });
      } catch {
        // Degraded logging is still better than a close() that throws.
      }
    }
  }
}

/**
 * The values for the statement's `?` placeholders.
 *
 * `query()`, not `execute()`. `execute()` sends a prepared statement, and MySQL
 * rejects a number of legal single-statement forms under one — a `SET`, most
 * multi-value `INSERT`s, some DDL — which would be a capability regression for no
 * security gain. Injection safety is unaffected: `query()` runs the statement
 * through `sqlstring.format`, which quotes and escapes every value.
 */
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
      "'params' contains undefined, which MySQL cannot bind. Use null for SQL NULL, "
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

/** Whole milliseconds, or 0, which mysql2 reads as "no inactivity timer". */
function inactivityTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return 0;
  return Math.trunc(timeoutMs);
}

/**
 * Say something useful about a bind failure.
 *
 * sqlstring leaves a `?` with no value in the text it produces, so MySQL then
 * fails with a syntax error naming neither the statement's real problem nor the
 * array that is one element short. Counting placeholders against values turns
 * that into a one-token fix.
 */
function explainBindError(err, params, sql) {
  if (!err) return err;
  const message = String(err.message || '');
  if (!/You have an error in your SQL syntax|ER_PARSE_ERROR|ER_SYNTAX_ERROR/i.test(message)) return err;
  if (params.length === 0) return err;

  const wanted = countPlaceholders(sql);
  if (wanted === params.length) return err;

  const explained = new Error(
    `[MySQL bound parameters] The statement has ${wanted} placeholder(s) and ${params.length} value(s) were supplied`
    + `${wanted > params.length ? `; ${wanted - params.length} placeholder(s) have no value` : ''}. `
    + 'Add the missing values to "params", in placeholder order, or remove the placeholder. '
    + `Server said: ${message}`
  );
  explained.code = err.code;
  explained.cause = err;
  return explained;
}

/** `?` outside string literals and backtick-quoted identifiers. */
function countPlaceholders(sql) {
  const text = String(sql ?? '');
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) {
          if (text[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (char === '?') count++;
    i++;
  }
  return count;
}

/**
 * Refuse a statement that would change the session, in every read-only mode.
 *
 * See SESSION_STATE above for what a pooled `BEGIN` costs other callers. The
 * message is explicit because "transactions are not supported" is a fact about
 * this server's design, not about the caller's query.
 */
function refuseSessionState(sql) {
  const match = SESSION_STATE.exec(String(sql ?? ''));
  if (!match) return;
  throw new Error(
    `[MySQL transactions are not supported] "${match[1].toUpperCase()}" changes the state of the pooled `
    + 'connection, so the next caller would inherit it — and an open transaction keeps its row locks until '
    + 'something releases them. Every statement runs in its own implicit transaction. '
    + 'Set readOnly:false to write rows; a multi-statement transaction needs a tool that pins one connection '
    + 'across calls, which this server does not have.'
  );
}

/**
 * The query string, split into what is honoured and what is not.
 *
 * Everything the driver can be told is passed through rather than dropped, and the
 * residue is collected for the warning. Keys are folded to one spelling first, so
 * a user who misspells `ssl-mode` does not silently get plaintext.
 *
 * Parsed from the raw string rather than `URLSearchParams` for one reason: the form
 * convention turns `+` into a space, and `?timezone=+02:00` is how the offset is
 * spelled. A space where a `+` belongs is an invalid timezone mysql2 rejects with
 * a console warning nobody reads.
 */
function readQueryParams(url) {
  const out = { unknown: [] };
  const search = typeof url.search === 'string' ? url.search : '';
  for (const pair of search.replace(/^\?/, '').split('&')) {
    if (pair === '') continue;
    const at = pair.indexOf('=');
    const rawKey = at === -1 ? pair : pair.slice(0, at);
    const rawValue = at === -1 ? '' : pair.slice(at + 1);

    const key = decodeURIComponent(rawKey).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (!HONOURED_PARAMS.has(key)) {
      out.unknown.push(decodeURIComponent(rawKey));
      continue;
    }
    out[PARAM_ALIASES.get(key) ?? key] = decodeValue(key, rawValue);
  }
  return out;
}

/** `+` is a space under the form convention, right for everything except a numeric
 *  offset like `+02:00`, where it is a sign. Restored for offsets, nowhere else. */
function decodeValue(key, raw) {
  const value = decodeURIComponent(raw.replace(/\+/g, ' '));
  if (key !== 'timezone') return value;
  return value.replace(/^\s(?=\d)/, '+');
}

/**
 * The `ssl` option, from whichever spelling the URI used.
 *
 * An explicit object wins, then `ssl-mode`, then the `ssl_*` family, then nothing.
 * An unrecognised `ssl-mode` throws rather than falling back to plaintext, and the
 * permissive modes yield TLS that does not check the certificate, because
 * `REQUIRED` is what most people type and "it is encrypted" is not the whole of
 * what they asked for.
 */
function resolveSsl(query) {
  if (query.ssl) {
    if (query.ssl === 'false' || query.ssl === '0' || query.ssl === 'off') return false;
    // mysql2 takes a profile name for a string, and an object for a config.
    if (query.ssl.startsWith('{')) {
      try {
        return JSON.parse(query.ssl);
      } catch {
        throw new Error(
          'The MySQL URI parameter "ssl" looks like a JSON object but does not parse. '
          + 'Use ?ssl={"rejectUnauthorized":true} or a profile name such as ?ssl=Amazon RDS.'
        );
      }
    }
    return query.ssl;
  }

  const mode = (query['ssl-mode'] ?? '').toUpperCase();
  if (mode) {
    if (SSL_MODES.has(mode)) return false;
    if (SSL_MODES_INSECURE.has(mode) || mode === 'REQUIRED') return {};
    if (mode === 'VERIFY_CA' || mode === 'VERIFY_IDENTITY') return { rejectUnauthorized: true };
    throw new Error(
      `Unknown MySQL URI parameter "ssl-mode=${mode}". Use DISABLED, PREFERRED, REQUIRED, VERIFY_CA or VERIFY_IDENTITY.`
    );
  }

  const ca = query.ssl_ca;
  if (!ca && !query.ssl_cert) return null;
  return {
    ...(ca ? { ca } : {}),
    ...(query.ssl_cert ? { cert: query.ssl_cert } : {}),
    ...(query.ssl_key ? { key: query.ssl_key } : {}),
    ...(query.ssl_cipher ? { ciphers: query.ssl_cipher } : {}),
    // A boolean, not the string "false" — Node's TLS reads this one strictly and
    // `"false"` is truthy, so an undecoded `?ssl_verify_identity=false` would
    // verify certificates the caller asked it not to.
    rejectUnauthorized: !['false', '0', 'no', 'off'].includes(
      String(query.ssl_verify_identity ?? 'true').toLowerCase()
    ),
  };
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

/**
 * Add a server-side MAX_EXECUTION_TIME hint so MySQL aborts a slow SELECT and
 * reports ER_QUERY_TIMEOUT. mysql2 applies no per-query `timeout` to `query()`, so
 * the hint is the only server-side bound available.
 *
 * The hint has to follow the leading keyword: MySQL ignores one placed before
 * SELECT. Only SELECT is annotated, because a CTE's top-level SELECT is not at a
 * fixed offset.
 */
function withExecutionLimit(sql, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return sql;
  if (typeof sql !== 'string') return sql;

  const keywordStart = skipLeadingNoise(sql);
  const keyword = /^select\s/i.exec(sql.slice(keywordStart));
  if (!keyword) return sql;

  const insertAt = keywordStart + keyword[0].length;
  return `${sql.slice(0, insertAt)}/*+ MAX_EXECUTION_TIME(${Math.trunc(timeoutMs)}) */ ${sql.slice(insertAt)}`;
}

/** Index of the first character after any leading whitespace and comments. */
function skipLeadingNoise(sql) {
  let i = 0;
  for (;;) {
    const before = i;
    while (i < sql.length && /\s/.test(sql[i])) i++;
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (sql[i] === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    }
    if (i === before) return i;
  }
}

export { withExecutionLimit };

/** SELECT yields rows; anything else yields a single status object. */
function normalizeRows(rows) {
  if (Array.isArray(rows)) return rows;
  if (rows === null || rows === undefined) return [];

  return [statusObject(rows)];
}

function statusObject(packet) {
  return {
    affectedRows: packet.affectedRows ?? 0,
    insertId: packet.insertId ?? 0,
    changedRows: packet.changedRows ?? 0,
    warningStatus: packet.warningStatus ?? 0,
    info: packet.info ?? '',
  };
}
