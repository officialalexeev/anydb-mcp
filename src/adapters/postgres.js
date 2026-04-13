import pg from 'pg';
import { BaseAdapter } from '../core/base-adapter.js';

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
    try {
      // Set statement_timeout at session level
      const timeoutSeconds = Math.ceil(this.queryTimeout / 1000);
      await this.pool.query(`SET statement_timeout = ${timeoutSeconds * 1000}`);

      const result = await this.pool.query(sql);
      return result.rows;
    } catch (err) {
      // PostgreSQL timeout error (code 57014)
      if (err.code === '57014') {
        throw new Error(`Query exceeded ${this.queryTimeout}ms timeout (statement_timeout)`);
      }
      throw new Error(`[Postgres Execute Error]: ${err.message}`);
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}