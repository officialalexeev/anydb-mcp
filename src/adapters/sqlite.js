import { BaseAdapter } from '../core/base-adapter.js';
import { callbackWithTimeout } from '../core/timeout-utils.js';
import { SQLiteSchemaAdapter } from '../core/schema.js';

/**
 * sqlite3 ships a native binding built by an install script, and npm 12 blocks
 * install scripts unless they are allow-listed. That allowance lives in the
 * installing project's own npmrc, not ours, so a consumer who installs this
 * package gets a sqlite3 with no binding. Importing it at module scope would
 * take the whole server down over one optional database, so it is loaded here,
 * and only when a SQLite URI is actually used.
 */
let sqlite3Promise = null;

async function loadSqlite3() {
  if (!sqlite3Promise) {
    sqlite3Promise = import('sqlite3').catch(() => {
      sqlite3Promise = null;
      throw new Error(
        'SQLite support is unavailable because the sqlite3 native binding was not built. ' +
        'This is expected when npm blocks install scripts. Run ' +
        '`npm install-scripts approve sqlite3` in the project that installed this package, ' +
        'then `npm rebuild sqlite3`. That writes an allowScripts entry into that ' +
        "project's package.json. Setting allow-scripts=sqlite3 in .npmrc only works " +
        'while that package.json has no allowScripts field of its own. ' +
        'The other four databases are unaffected.'
      );
    });
  }
  return sqlite3Promise;
}

export class SQLiteAdapter extends BaseAdapter {
  /**
   * @param {Function} [databaseClass] - sqlite3.Database, injected by tests.
   *   Left undefined in production so the driver is loaded lazily.
   */
  constructor(databaseClass = undefined, timeout = 30000) {
    super(0, timeout); // SQLite is local, no connection timeout needed
    this.DatabaseClass = databaseClass;
  }

  /** Resolve the sqlite3 Database class, loading the driver on first use. */
  async loadDatabase() {
    if (!this.DatabaseClass) {
      this.DatabaseClass = (await loadSqlite3()).default.Database;
    }
    return this.DatabaseClass;
  }

  async connect(uri) {
    // A SQLite URI is a file path. Drop the scheme and any query string.
    let path = uri.replace(/^sqlite(\+\w+)?:\/\//, '');
    const qIndex = path.search(/[?#]/);
    if (qIndex !== -1) {
      path = path.slice(0, qIndex);
    }
    if (path === '') {
      throw new Error('SQLite URI must include a file path, for example sqlite:///path/to/db.sqlite or sqlite://:memory:');
    }

    // sqlite:///C:/data.db means the drive-rooted path C:\data.db.
    path = path.replace(/^\/([A-Za-z]:)/, '$1');

    const Database = await this.loadDatabase();
    this.DatabaseClass = Database;

    // sqlite3 reports open failures by emitting 'error' and never calling back
    // the pending operation. Without a listener the event becomes an uncaught
    // exception and takes the whole process with it.
    this.pendingReject = null;
    this.openFailed = false;
    this.db = new Database(path);

    this.db.on('error', (err) => {
      if (/SQLITE_CANTOPEN|unable to open database/i.test(err.message || '')) {
        // The handle never opened, so close() will never call back.
        this.openFailed = true;
      }
      if (this.pendingReject) {
        this.pendingReject(err);
        this.pendingReject = null;
      }
    });
  }

  /**
   * Run an operation, racing it against both the query timeout and any
   * 'error' event raised by the database handle.
   */
  run(operation, timeoutMs, operationName, timeoutMessage) {
    const guard = new Promise((_, reject) => {
      this.pendingReject = reject;
    });
    // Nothing else is waiting on the guard, so do not let it warn as unhandled.
    guard.catch(() => {});

    const result = callbackWithTimeout(operation, timeoutMs, operationName, timeoutMessage);

    return Promise.race([result, guard]).finally(() => {
      this.pendingReject = null;
      // The driver may never call back, so the operation's own timer has to be
      // disarmed here or it outlives us by the full timeout.
      result.cancel?.();
    });
  }

  async execute(sql) {
    return this.run(
      (callback) => this.db.all(sql, [], callback),
      this.queryTimeout,
      'SQLite query',
      `SQLite query exceeded ${this.queryTimeout}ms timeout. The database is probably locked by another process or transaction.`
    ).catch(err => {
      throw this.describeError(err);
    });
  }

  describe(options = {}) {
    const schema = new SQLiteSchemaAdapter(this.connectTimeout, this.queryTimeout);
    schema.db = this.db;
    return schema.describe(options);
  }

  describeError(err) {
    const message = err.message || String(err);

    if (/timed out/i.test(message)) return err; // already specific
    if (/SQLITE_BUSY|database is locked/i.test(message)) {
      return new Error(`[SQLite locked] ${message}. Another process holds a lock on the database.`);
    }
    if (/SQLITE_CANTOPEN|unable to open database/i.test(message)) {
      return new Error(`[SQLite cannot open] ${message}. Check the file path in the URI.`);
    }
    if (/SQLITE_READONLY|attempt to write a readonly database/i.test(message)) {
      return new Error(`[SQLite read-only] ${message}`);
    }
    if (/SQLITE_ERROR/.test(message)) {
      return new Error(`[SQLite error] ${message.replace(/^SQLITE_ERROR:\s*/, '')}`);
    }
    return new Error(`[SQLite error] ${message}`);
  }

  /** A local handle cannot be closed by anyone else, so there is nothing to ping. */
  isHealthy() {
    return !!this.db && !this.aborted;
  }

  /** SQLite keeps executing a statement until it is interrupted. */
  abort() {
    if (!this.db) return;
    this.aborted = true;
    try {
      this.db.interrupt();
    } catch {
      // Not every build has interrupt(), and it is not needed when idle.
    }
  }

  async close() {
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    this.pendingReject = null;

    // Neither of these handles can complete a close.
    if (this.openFailed || this.aborted) return;

    return callbackWithTimeout(
      (callback) => db.close(callback),
      5000,
      'SQLite close'
    ).catch(err => {
      // The query result has already been produced, so a stuck close is not
      // worth failing the request over.
      console.error('Warning: SQLite close() did not complete:', err.message);
    });
  }
}
