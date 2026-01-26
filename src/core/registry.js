import { PostgresAdapter } from '../adapters/postgres.js';
import { MongoAdapter } from '../adapters/mongodb.js';
import { SQLiteAdapter } from '../adapters/sqlite.js';
import { RedisAdapter } from '../adapters/redis.js';
import { MySQLAdapter } from '../adapters/mysql.js';

export class AdapterRegistry {
  constructor(poolClass = undefined, clientClass = undefined, databaseClass = undefined, redisClientClass = undefined, mysqlConnectionClass = undefined) {
    this.poolClass = poolClass;
    this.clientClass = clientClass;
    this.databaseClass = databaseClass;
    this.redisClientClass = redisClientClass;
    this.mysqlConnectionClass = mysqlConnectionClass;

    this.mapping = {
      'postgres': () => new PostgresAdapter(this.poolClass),
      'postgresql': () => new PostgresAdapter(this.poolClass),
      'mongodb': () => new MongoAdapter(this.clientClass),
      'sqlite': () => new SQLiteAdapter(this.databaseClass),
      'redis': () => new RedisAdapter(this.redisClientClass),
      'mysql': () => new MySQLAdapter(this.mysqlConnectionClass)
    };
  }

  async run(uri, query, options = {}) {
    const protocol = this.extractProtocol(uri);
    const adapterFactory = this.mapping[protocol];

    if (!adapterFactory) {
      throw new Error(`Protocol "${protocol}" is not supported. Supported: ${Object.keys(this.mapping).join(', ')}`);
    }

    this.validate(query, protocol, options);

    const adapter = adapterFactory();
    await adapter.connect(uri);

    try {
      return await adapter.execute(query, options);
    } catch (err) {
      throw new Error(`[${protocol.toUpperCase()} Execute Error]: ${err.message}`);
    } finally {
      await adapter.close();
    }
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
  }
}