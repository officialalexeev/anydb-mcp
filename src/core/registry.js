import { PostgresAdapter } from '../adapters/postgres.js';
import { MongoAdapter } from '../adapters/mongodb.js';
import { SQLiteAdapter } from '../adapters/sqlite.js';
import { RedisAdapter } from '../adapters/redis.js';
import { MySQLAdapter } from '../adapters/mysql.js';
import { TimeoutError, withTimeout, TIMEOUT_GRACE_MS } from './base-adapter.js';
import { inspectQuery, READ_ONLY_HINT, MONGO_ACTIONS, isSqlProtocol, hasMultipleStatements } from './safety.js';
import { ConnectionCache } from './connection-cache.js';

// Default query timeout: 30 seconds
const DEFAULT_TIMEOUT = 30000;

// Guards against a typo silently disabling the timeout or overflowing setTimeout.
const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 24 * 60 * 60 * 1000;

// A timeout says the statement may still be executing, and a dropped socket
// says the connection cannot be trusted. Either way it leaves the cache. A
// syntax error or a missing table says nothing about the connection.
const DEAD_CONNECTION = /ECONNREFUSED|ECONNRESET|EPIPE|PROTOCOL_CONNECTION_LOST|ClientClosedError|SocketClosedUnexpectedlyError|ENOTFOUND|EAI_AGAIN|server closed the connection|Connection terminated|timed out|timeout|ER_QUERY_TIMEOUT|statement timeout|maxTimeMS|interrupted/i;

export class AdapterRegistry {
  constructor(poolClass = undefined, clientClass = undefined, databaseClass = undefined, redisClientClass = undefined, mysqlConnectionClass = undefined, cache = undefined) {
    this.poolClass = poolClass;
    this.clientClass = clientClass;
    this.databaseClass = databaseClass;
    this.redisClientClass = redisClientClass;
    this.mysqlConnectionClass = mysqlConnectionClass;

    this.cache = cache ?? new ConnectionCache();

    this.mapping = {
      'postgres': (timeout) => new PostgresAdapter(this.poolClass, timeout),
      'postgresql': (timeout) => new PostgresAdapter(this.poolClass, timeout),
      'mongodb': (timeout) => new MongoAdapter(this.clientClass, timeout),
      'sqlite': (timeout) => new SQLiteAdapter(this.databaseClass, timeout),
      'redis': (timeout) => new RedisAdapter(this.redisClientClass, timeout),
      'rediss': (timeout) => new RedisAdapter(this.redisClientClass, timeout),
      'mysql': (timeout) => new MySQLAdapter(this.mysqlConnectionClass, timeout),
      // SQLAlchemy-style URIs. The MySQL adapter rewrites the scheme, but the
      // registry has to route it first.
      'mysql+pymysql': (timeout) => new MySQLAdapter(this.mysqlConnectionClass, timeout),
      'mysql+mysqldb': (timeout) => new MySQLAdapter(this.mysqlConnectionClass, timeout),
      'mysql+asyncmy': (timeout) => new MySQLAdapter(this.mysqlConnectionClass, timeout),
      'mysql+aiohttp': (timeout) => new MySQLAdapter(this.mysqlConnectionClass, timeout),
      'sqlite+pysqlite': (timeout) => new SQLiteAdapter(this.databaseClass, timeout),
    };
  }

  async run(uri, query, options = {}) {
    this.assertUri(uri);

    const protocol = this.extractProtocol(uri);
    const timeout = this.resolveTimeout(options);
    const readOnly = this.resolveReadOnly(options);

    this.assertAdapter(protocol);
    this.validate(query, protocol, options);

    // Checked before connecting, so a rejected statement opens no socket.
    if (readOnly) {
      const verdict = inspectQuery(protocol, query, options);
      if (!verdict.safe) {
        throw new Error(
          `Read-only mode: this statement was blocked because ${verdict.reason}. ${READ_ONLY_HINT}`
        );
      }
    }

    return this.withConnection(uri, protocol, timeout, (adapter) => adapter.execute(query, options));
  }

  /**
   * Describe a database. Caller input is bound as a parameter wherever the
   * driver allows it, so the read-only guard has no user query to inspect.
   */
  async describe(uri, options = {}) {
    this.assertUri(uri);

    const protocol = this.extractProtocol(uri);
    const timeout = this.resolveTimeout(options);

    this.assertAdapter(protocol);
    this.validateTimeout(options);

    for (const key of ['table', 'collection']) {
      if (options[key] !== undefined && typeof options[key] !== 'string') {
        throw new Error(`'${key}' must be a string.`);
      }
    }

    return this.withConnection(uri, protocol, timeout, (adapter) => adapter.describe(options), 'db_schema');
  }

  /**
   * Run one operation on a connection, from the cache when possible. A
   * connection that timed out or lost its socket is discarded; anything else
   * leaves it cached.
   */
  async withConnection(uri, protocol, timeout, work, toolName = 'db_query') {
    const hardLimit = timeout + TIMEOUT_GRACE_MS;
    const key = `${protocol}::${uri}`;
    let active = null;

    const operationPromise = (async () => {
      const { adapter, release } = await this.cache.acquire(
        key,
        async () => {
          const adapter = this.createAdapter(protocol, timeout);
          await adapter.connect(uri);
          return adapter;
        },
        timeout
      );
      active = adapter;

      try {
        return await work(adapter);
      } catch (err) {
        if (DEAD_CONNECTION.test(err?.message || '')) {
          this.cache.evict(key);
          try { adapter.abort(); } catch { /* best effort */ }
        }
        throw err;
      } finally {
        release();
      }
    })();

    return withTimeout(
      operationPromise,
      hardLimit,
      `${toolName} (${protocol})`,
      () => {
        this.cache.evict(key);
        active?.abort();
      }
    );
  }

  createAdapter(protocol, timeout) {
    const factory = this.mapping[protocol];
    return factory(timeout);
  }

  assertUri(uri) {
    if (typeof uri !== 'string' || uri.length === 0) {
      throw new Error("Missing 'uri' argument: expected a connection string such as postgres://user:pass@host:5432/db.");
    }
  }

  assertAdapter(protocol) {
    if (!this.mapping[protocol]) {
      throw new Error(`Protocol "${protocol}" is not supported. Supported: ${Object.keys(this.mapping).join(', ')}`);
    }
  }

  extractProtocol(uri) {
    if (!uri.includes('://')) throw new Error("Invalid URI format. Expected 'protocol://...'");
    return uri.split('://')[0].toLowerCase();
  }

  resolveTimeout(options) {
    if (options.timeout === undefined || options.timeout === null) return DEFAULT_TIMEOUT;
    return options.timeout;
  }

  resolveReadOnly(options) {
    return options.readOnly !== false;
  }

  validate(query, protocol, options) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error("Query must be a non-empty string.");
    }
    // Rejected regardless of readOnly: PostgreSQL's simple query protocol runs
    // every statement in the string, so `SELECT 1; DROP TABLE t` would pass a
    // check that only reads the leading keyword.
    if (isSqlProtocol(protocol) && hasMultipleStatements(query, protocol)) {
      throw new Error(
        'Multiple statements in one call are not supported. Run one statement at a time.'
      );
    }
    if (protocol === 'mongodb' && !options.collection) {
      throw new Error("Missing 'collection' parameter for MongoDB query.");
    }
    if (protocol === 'mongodb' && options.action !== undefined && options.action !== null) {
      // An action that does not exist is an argument error, so it is rejected
      // here rather than being reported as a read-only refusal.
      if (typeof options.action !== 'string' || !MONGO_ACTIONS.has(options.action)) {
        throw new Error(
          `Unknown MongoDB action ${JSON.stringify(options.action)}. ` +
          `Use one of: ${[...MONGO_ACTIONS].join(', ')}.`
        );
      }
    }
    this.validateTimeout(options);
    if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') {
      throw new Error("readOnly must be a boolean.");
    }
  }

  /**
   * The timeout reaches setTimeout and, for PostgreSQL, a SET statement built by
   * string interpolation, so it has to be a real number in range before any
   * adapter sees it. Both tools go through here: `db_schema` skips `validate`,
   * and an unchecked value either disabled the guard or overflowed it.
   */
  validateTimeout(options) {
    const { timeout } = options;
    if (timeout === undefined || timeout === null) return;

    if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
      // String(), not JSON.stringify(): the latter renders NaN and Infinity as
      // "null", which names a value the caller never passed.
      throw new Error(`Timeout must be a number of milliseconds, got ${String(timeout)}.`);
    }
    if (timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) {
      throw new Error(
        `Timeout must be between ${MIN_TIMEOUT} and ${MAX_TIMEOUT} milliseconds. ` +
        `Omit it to use the ${DEFAULT_TIMEOUT}ms default.`
      );
    }
  }

  /** Close every cached connection. */
  async close() {
    await this.cache.closeAll();
  }
}

export { TimeoutError, DEFAULT_TIMEOUT, TIMEOUT_GRACE_MS };
