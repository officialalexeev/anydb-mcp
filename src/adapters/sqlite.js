import sqlite3 from 'sqlite3';
import { BaseAdapter } from '../core/base-adapter.js';
import { callbackWithTimeout } from '../core/timeout-utils.js';

export class SQLiteAdapter extends BaseAdapter {
  constructor(databaseClass = sqlite3.Database, timeout = 30000) {
    super(0, timeout); // SQLite is local, no connection timeout needed
    this.DatabaseClass = databaseClass;
  }

  async connect(uri) {
    // For SQLite, uri is usually the file path
    // Remove protocol and query parameters
    let path = uri.replace('sqlite://', '');
    const qIndex = path.indexOf('?');
    if (qIndex !== -1) {
      path = path.substring(0, qIndex);
    }
    this.db = new this.DatabaseClass(path);
  }

  async execute(sql) {
    return callbackWithTimeout(
      (callback) => {
        this.db.all(sql, [], callback);
      },
      this.queryTimeout,
      'SQLite query'
    ).catch(err => {
      if (err.message.includes('timed out')) {
        throw new Error(`Query exceeded ${this.queryTimeout}ms timeout`);
      }
      throw new Error(`SQLite Error: ${err.message}`);
    });
  }

  async close() {
    if (!this.db) return;
    
    return callbackWithTimeout(
      (callback) => {
        this.db.close(callback);
      },
      5000, // Close timeout 5 seconds
      'SQLite close'
    ).catch(err => {
      if (err.message.includes('timed out')) {
        // Ignore close timeout
        console.error('Warning: SQLite close() timed out');
      } else {
        throw new Error(`Failed to close SQLite connection: ${err.message}`);
      }
    });
  }
}