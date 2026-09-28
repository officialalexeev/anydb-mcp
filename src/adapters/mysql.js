import mysql from 'mysql2/promise';
import { BaseAdapter } from '../core/base-adapter.js';
import { MySQLSchemaAdapter } from '../core/schema.js';

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
]);

export class MySQLAdapter extends BaseAdapter {
  /**
   * @param {Function} connectionFactory - mysql2 pool factory. A pool, not a
   *   single connection: a cached connection is shared by concurrent requests.
   * @param {number} [poolSize=4] - Maximum concurrent statements
   */
  constructor(connectionFactory = mysql.createPool, timeout = 30000, poolSize = 4) {
    super(5000, timeout);
    this.ConnectionFactory = connectionFactory;
    this.poolSize = poolSize;
  }

  async connect(uri) {
    // Accept dialects other tools emit, e.g. SQLAlchemy's mysql+pymysql://
    const normalizedUri = uri.replace(/^mysql\+(?:pymysql|mysqldb|asyncmy|aiohttp)\:\/\//i, 'mysql://');

    let url;
    try {
      url = new URL(normalizedUri);
    } catch {
      throw new Error('Invalid MySQL URI format. Expected: mysql://user:password@host:port/database');
    }

    const config = {
      host: url.hostname,
      port: parseInt(url.port, 10) || 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      connectTimeout: this.connectTimeout,
      // Bound the pool so one caller cannot open sockets without limit.
      connectionLimit: this.poolSize,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
    };

    try {
      this.pool = this.ConnectionFactory(config);
    } catch (err) {
      throw this.describeError(err);
    }
  }

  async execute(sql) {
    try {
      // query() and not execute(): the latter sends a prepared statement, which
      // MySQL rejects for a number of legal single-statement forms.
      const [rows] = await this.pool.query(withExecutionLimit(sql, this.queryTimeout));
      return normalizeRows(rows);
    } catch (err) {
      throw this.describeError(err);
    }
  }

  describe(options = {}) {
    const schema = new MySQLSchemaAdapter(this.connectTimeout, this.queryTimeout);
    schema.pool = this.pool;
    return schema.describe(options);
  }

  /**
   * Name the failure the server actually reported.
   *
   * @returns {Error} A message carrying the driver code and SQL text
   */
  describeError(err) {
    const code = err && err.code;
    const detail = (err && (err.sqlMessage || err.message)) || String(err);

    if (TIMEOUT_CODES.has(code) || /timed out/i.test(detail)) {
      return new Error(`MySQL query exceeded ${this.queryTimeout}ms timeout: ${detail}`);
    }

    if (code === 'ECONNREFUSED') {
      return new Error(`MySQL connection refused at the given host and port: ${detail}`);
    }

    if (code === 'ENOTFOUND') {
      return new Error(`MySQL host not found: ${detail}`);
    }

    const hint = ERROR_HINTS[code];
    const prefix = hint ? `[MySQL ${hint}]` : `[MySQL ${code || 'error'}]`;

    return new Error(`${prefix}: ${detail}`);
  }

  /**
   * One round trip to tell a closed idle connection from a live one.
   */
  async isHealthy() {
    if (!this.pool) return false;
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
   */
  abort() {
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = null;
    this.aborted = true;
    try {
      pool.pool?.forEach?.(conn => conn.destroy());
    } catch {
      // already destroyed
    }
  }

  async close() {
    if (this.pool) {
      const pool = this.pool;
      this.pool = null;
      try {
        await pool.end();
      } catch (err) {
        if (!this.aborted) console.error('Warning: MySQL close() failed:', err.message);
      }
    }
  }
}

/**
 * Add a server-side MAX_EXECUTION_TIME hint so MySQL aborts a slow SELECT and
 * reports ER_QUERY_TIMEOUT. mysql2 does not apply a per-query `timeout` to
 * `query()` calls, so the hint is the only way to bound a statement server-side.
 *
 * The hint has to follow the leading keyword: MySQL ignores one placed before
 * SELECT. Only SELECT is annotated, because MySQL ignores it elsewhere and a
 * CTE's top-level SELECT is not at a fixed offset.
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

  return [{
    affectedRows: rows.affectedRows ?? 0,
    insertId: rows.insertId ?? 0,
    changedRows: rows.changedRows ?? 0,
    warningStatus: rows.warningStatus ?? 0,
    info: rows.info ?? '',
  }];
}
