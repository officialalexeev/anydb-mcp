import sqlite3 from 'sqlite3';
import { BaseAdapter } from '../core/base-adapter.js';

export class SQLiteAdapter extends BaseAdapter {
  constructor(databaseClass = sqlite3.Database) {
    super();
    this.DatabaseClass = databaseClass;
  }

  async connect(uri) {
    // Для SQLite uri обычно является путем к файлу
    // Удаляем протокол и query параметры
    let path = uri.replace('sqlite://', '');
    const qIndex = path.indexOf('?');
    if (qIndex !== -1) {
      path = path.substring(0, qIndex);
    }
    this.db = new this.DatabaseClass(path);
  }

  async execute(sql) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, [], (err, rows) => {
        if (err) {
          reject(new Error(`SQLite Error: ${err.message}`));
        } else {
          resolve(rows);
        }
      });
    });
  }

  async close() {
    if (this.db) {
      return new Promise((resolve, reject) => {
        this.db.close((err) => {
          if (err) {
            reject(new Error(`Failed to close SQLite connection: ${err.message}`));
          } else {
            resolve();
          }
        });
      });
    }
  }
}