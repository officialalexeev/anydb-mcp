import { PostgresAdapter } from '../adapters/postgres.js';
import { MongoAdapter } from '../adapters/mongodb.js';
import { SQLiteAdapter } from '../adapters/sqlite.js';
import { RedisAdapter } from '../adapters/redis.js';
import { MySQLAdapter } from '../adapters/mysql.js';
import { TimeoutError, withTimeout } from './base-adapter.js';

// Default timeout: 30 seconds
const DEFAULT_TIMEOUT = 30000;

export class AdapterRegistry {
  constructor(poolClass = undefined, clientClass = undefined, databaseClass = undefined, redisClientClass = undefined, mysqlConnectionClass = undefined) {
    this.poolClass = poolClass;
    this.clientClass = clientClass;
    this.databaseClass = databaseClass;
    this.redisClientClass = redisClientClass;
    this.mysqlConnectionClass = mysqlConnectionClass;

    this.mapping = {
      'postgres': (timeout) => new PostgresAdapter(this.poolClass, timeout),
      'postgresql': (timeout) => new PostgresAdapter(this.poolClass, timeout),
      'mongodb': (timeout) => new MongoAdapter(this.clientClass, timeout),
      'sqlite': (timeout) => new SQLiteAdapter(this.databaseClass, timeout),
      'redis': (timeout) => new RedisAdapter(this.redisClientClass, timeout),
      'mysql': (timeout) => new MySQLAdapter(this.mysqlConnectionClass, timeout)
    };
  }

  async run(uri, query, options = {}) {
    const protocol = this.extractProtocol(uri);
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const adapterFactory = this.mapping[protocol];

    if (!adapterFactory) {
      throw new Error(`Protocol "${protocol}" is not supported. Supported: ${Object.keys(this.mapping).join(', ')}`);
    }

    this.validate(query, protocol, options);

    const adapter = adapterFactory(timeout);

    // Global timeout for entire operation (connect + execute + close)
    const operationPromise = (async () => {
      await adapter.connect(uri);
      try {
        return await adapter.execute(query, options);
      } finally {
        await adapter.close();
      }
    })();

    return await withTimeout(
      operationPromise,
      timeout,
      `db_query (${protocol})`
    );
  }

  extractProtocol(uri) {
    if (!uri.includes('://')) throw new Error("Invalid URI format. Expected 'protocol://...'");
    return uri.split('://')[0].toLowerCase();
  }

  validate(query, protocol, options) {
    if (!query || typeof query !== 'string') throw new Error("Query must be a string.");
    if (protocol === 'mongodb' && !options.collection) {
      throw new Error("Missing 'collection' parameter for MongoDB query.");
    }
    // Validate timeout parameter
    if (options.timeout !== undefined) {
      if (typeof options.timeout !== 'number' || options.timeout < 0) {
        throw new Error("Timeout must be a positive number (milliseconds).");
      }
    }
  }
}

export { TimeoutError, DEFAULT_TIMEOUT };