import pg from 'pg';
import { BaseAdapter } from '../core/base-adapter.js';
import { PostgresSchemaAdapter } from '../core/schema.js';

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
};

// Command tags for statements that return a status rather than rows.
const STATUS_COMMANDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MOVE', 'FETCH', 'COPY', 'MERGE',
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT', 'VACUUM',
  'ANALYZE', 'REINDEX', 'CLUSTER', 'CHECKPOINT', 'DISCARD', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'LOCK', 'SET', 'RESET', 'CALL', 'DO',
  'PREPARE', 'EXECUTE', 'DEALLOCATE', 'DECLARE', 'REFRESH', 'REASSIGN',
]);

export class PostgresAdapter extends BaseAdapter {
  constructor(poolClass = pg.Pool, timeout = 30000) {
    super(5000, timeout);
    this.PoolClass = poolClass;
  }

  async connect(uri) {
    this.pool = new this.PoolClass({
      connectionString: uri,
      connectionTimeoutMillis: this.connectTimeout,
      idleTimeoutMillis: 10000,
    });
  }

  async execute(sql) {
    // statement_timeout is a session setting, so SET and the query must run on
    // the same connection. Using pool.query() twice can hand them to two
    // different clients, which silently leaves the timeout unenforced.
    const client = await this.pool.connect();
    try {
      await client.query(`SET statement_timeout = ${this.queryTimeout}`);

      const result = await client.query(sql);

      // A data-modifying statement returns rows: [] just like an empty SELECT,
      // so the command tag is what tells them apart.
      if (STATUS_COMMANDS.has(result.command)) {
        return [{
          affectedRows: result.rowCount ?? 0,
          command: result.command,
          oid: result.oid ?? null,
        }];
      }

      return Array.isArray(result.rows) ? result.rows : [];
    } catch (err) {
      throw this.describeError(err);
    } finally {
      client.release();
    }
  }

  /** One round trip to tell a closed idle connection from a live one. */
  async isHealthy() {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  describe(options = {}) {
    const schema = new PostgresSchemaAdapter(this.connectTimeout, this.queryTimeout);
    schema.pool = this.pool;
    return schema.describe(options);
  }

  describeError(err) {
    const code = err && err.code;
    const detail = (err && err.message) || String(err);

    // 57014 is also raised by a manual cancel, so only claim "timeout" when the
    // server actually blamed the timeout.
    if (code === '57014') {
      if (/statement timeout/i.test(detail)) {
        return new Error(`[Postgres timeout] Query exceeded ${this.queryTimeout}ms (statement_timeout)`);
      }
      return new Error(`[Postgres cancelled] ${detail}`);
    }

    if (code === 'ETIMEDOUT' || /timeout exceeded/i.test(detail)) {
      return new Error(`[Postgres timeout] Query exceeded ${this.queryTimeout}ms: ${detail}`);
    }

    if (code === 'ECONNREFUSED') {
      return new Error(`[Postgres connection refused] ${detail}`);
    }

    const hint = ERROR_HINTS[code];
    return new Error(`[Postgres ${hint || code || 'error'}] ${detail}`);
  }

  async close() {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch (err) {
        console.error('Warning: Postgres close() failed:', err.message);
      }
      this.pool = null;
    }
  }
}
