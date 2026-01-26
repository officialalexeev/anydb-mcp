import mysql from 'mysql2/promise';
import { BaseAdapter } from '../core/base-adapter.js';

export class MySQLAdapter extends BaseAdapter {
  constructor(connectionClass = mysql.createConnection) {
    super();
    this.ConnectionClass = connectionClass;
  }

  async connect(uri) {
    // Преобразуем URI из формата mysql:// в формат, понятный MySQL
    // Поддержка mysql+pymysql://
    const normalizedUri = uri.replace(/^mysql\+pymysql:\/\//, 'mysql://');

    try {
      const url = new URL(normalizedUri);
      
      const config = {
        host: url.hostname,
        port: parseInt(url.port) || 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.slice(1) // Убираем ведущий слеш
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
      const [rows] = await this.connection.execute(sql);
      return rows;
    } catch (err) {
      throw new Error(`MySQL Syntax Error: ${err.message}`);
    }
  }

  async close() {
    if (this.connection) {
      await this.connection.end();
    }
  }
}