import mysql from 'mysql2/promise';
import { BaseAdapter } from '../core/base-adapter.js';

export class MySQLAdapter extends BaseAdapter {
  constructor(connectionClass = mysql.createConnection, timeout = 30000) {
    super(5000, timeout);
    this.ConnectionClass = connectionClass;
  }

  async connect(uri) {
    // Convert URI from mysql:// format to MySQL-compatible format
    // Supports mysql+pymysql:// prefix
    const normalizedUri = uri.replace(/^mysql\+pymysql:\/\//, 'mysql://');

    try {
      const url = new URL(normalizedUri);

      const config = {
        host: url.hostname,
        port: parseInt(url.port) || 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.slice(1), // Remove leading slash
        connectTimeout: this.connectTimeout,
      };

      this.connection = await this.ConnectionClass(config);
    } catch (err) {
      if (err.code === 'ERR_INVALID_URL_SCHEME' || err.code === 'ERR_INVALID_URL' || err.message.includes('Invalid URL')) {
        throw new Error('Invalid MySQL URI format. Expected: user:password@host:port/database');
      }
      throw err;
    }
  }

  async execute(sql) {
    try {
      // mysql2 supports timeout in query parameters
      const [rows] = await this.connection.execute(sql, [], {
        timeout: this.queryTimeout
      });
      return rows;
    } catch (err) {
      // MySQL timeout error (QUERY_TIMEOUT_ERROR or PROTOCOL_CONNECTION_LOST)
      if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
        throw new Error(`Query exceeded ${this.queryTimeout}ms timeout`);
      }
      throw new Error(`MySQL Syntax Error: ${err.message}`);
    }
  }

  async close() {
    if (this.connection) {
      await this.connection.end();
    }
  }
}