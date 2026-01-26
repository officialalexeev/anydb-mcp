import pg from 'pg';
import { BaseAdapter } from '../core/base-adapter.js';

export class PostgresAdapter extends BaseAdapter {
  constructor(poolClass = pg.Pool) {
    super();
    this.PoolClass = poolClass;
  }

  async connect(uri) {
    this.pool = new this.PoolClass({ connectionString: uri });
  }

  async execute(sql) {
    try {
      const result = await this.pool.query(sql);
      return result.rows;
    } catch (err) {
      throw new Error(`[${this.constructor.name.replace('Adapter', '')} Execute Error]: ${err.message}`);
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}