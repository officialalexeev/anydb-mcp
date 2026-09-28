import { BaseAdapter } from '../core/base-adapter.js';
import { callbackWithTimeout } from '../core/timeout-utils.js';

/**
 * Reports the shape of a database so an agent can write a correct query
 * without probing for table and column names.
 *
 * Everything here is a read, and each statement is bounded so that a large
 * catalogue cannot produce a result that overflows the caller's context.
 */
export class SchemaAdapter extends BaseAdapter {
  async describe(options = {}) {
    throw new Error('describe() is not implemented');
  }
}

const MAX_TABLES = 500;
const MAX_COLUMNS_PER_TABLE = 100;

const trim = (list, max) => (list.length > max ? list.slice(0, max) : list);

export class PostgresSchemaAdapter extends SchemaAdapter {
  async describe(options) {
    const tableFilter = options.table;
    const params = tableFilter ? [tableFilter] : [];

    const [tables] = await this.run(
      `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          ${tableFilter ? 'AND table_name = $1' : ''}
        ORDER BY table_schema, table_name
        LIMIT ${MAX_TABLES}`,
      params
    );

    if (tables.length === 0) {
      return { database: 'postgresql', tables: [], truncated: false };
    }

    const names = tables.map(t => t.table_name);
    const [columns] = await this.run(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          ${tableFilter ? 'AND table_name = $1' : ''}
        ORDER BY table_name, ordinal_position
        LIMIT ${MAX_TABLES * MAX_COLUMNS_PER_TABLE}`,
      params
    );

    return {
      database: 'postgresql',
      tables: trim(tables, MAX_TABLES).map(t => ({
        name: t.table_name,
        schema: t.table_schema,
        type: t.table_type,
        columns: columns.filter(c => c.table_name === t.table_name).map(c => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          default: c.column_default ?? null
        }))
      })),
      truncated: tables.length >= MAX_TABLES || columns.length >= MAX_TABLES * MAX_COLUMNS_PER_TABLE
    };
  }

  run(sql, params) {
    return this.pool.query(sql, params).then(r => [r.rows]);
  }
}

export class MySQLSchemaAdapter extends SchemaAdapter {
  // information_schema labels its columns in upper case, and the driver hands
  // the keys back verbatim.
  async describe(options) {
    const where = options.table ? ' AND TABLE_NAME = ?' : '';
    const params = options.table ? [options.table] : [];

    const [tables] = await this.query(
      `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, ENGINE
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()${where}
        ORDER BY TABLE_NAME
        LIMIT ${MAX_TABLES}`,
      params
    );

    if (tables.length === 0) {
      return { database: 'mysql', tables: [], truncated: false };
    }

    const [columns] = await this.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()${where}
        ORDER BY TABLE_NAME, ORDINAL_POSITION
        LIMIT ${MAX_TABLES * MAX_COLUMNS_PER_TABLE}`,
      params
    );

    return {
      database: 'mysql',
      tables: trim(tables, MAX_TABLES).map(t => ({
        name: t.TABLE_NAME,
        type: t.TABLE_TYPE,
        engine: t.ENGINE,
        approximateRows: t.TABLE_ROWS,
        columns: columns.filter(c => c.TABLE_NAME === t.TABLE_NAME).map(c => ({
          name: c.COLUMN_NAME,
          type: c.COLUMN_TYPE,
          nullable: c.IS_NULLABLE === 'YES',
          key: !c.COLUMN_KEY ? null : c.COLUMN_KEY,
          default: c.COLUMN_DEFAULT ?? null,
          extra: !c.EXTRA ? null : c.EXTRA
        }))
      })),
      truncated: tables.length >= MAX_TABLES || columns.length >= MAX_TABLES * MAX_COLUMNS_PER_TABLE
    };
  }

  query(sql, params) {
    return this.pool.query(sql, params);
  }
}

export class SQLiteSchemaAdapter extends SchemaAdapter {
  async describe(options) {
    const objects = await callbackWithTimeout(
      (cb) => this.db.all(
        `SELECT name, type, sql FROM sqlite_master
          WHERE type IN ('table', 'view')
            AND name NOT LIKE 'sqlite_%'
            ${options.table ? 'AND name = ?' : ''}
          ORDER BY type, name
          LIMIT ${MAX_TABLES}`,
        options.table ? [options.table] : [],
        cb
      ),
      this.queryTimeout,
      'SQLite schema',
      'Reading the SQLite schema exceeded the timeout. The database file may be locked.'
    ).catch(err => { throw new Error(`[SQLite schema] ${err.message}`); });

    if (objects.length === 0) {
      return { database: 'sqlite', tables: [], truncated: false };
    }

    // Tables and views, with their CREATE statements, before any per-table
    // PRAGMA runs.
    const tables = [];
    for (const object of objects) {
      tables.push({
        name: object.name,
        type: object.type,
        sql: object.sql ?? null,
        columns: await this.columnsOf(object.name)
      });
    }

    return { database: 'sqlite', tables, truncated: objects.length >= MAX_TABLES };
  }

  async columnsOf(tableName) {
    // PRAGMA takes an identifier, not a bound parameter, so the name is quoted
    // and embedded quotes doubled. The name comes from sqlite_master; the `table`
    // option filters the catalogue with a bound parameter, so quoting is what
    // keeps this injection-proof.
    // Only a NUL is rejected. Anything else is quoted, so a table name
    // containing spaces still works.
    if (typeof tableName !== 'string' || /[\x00]/.test(tableName)) return [];
    const quoted = `"${tableName.replace(/"/g, '""')}"`;
    const rows = await callbackWithTimeout(
      (cb) => this.db.all(`PRAGMA table_info(${quoted})`, [], cb),
      this.queryTimeout,
      'SQLite columns'
    );
    return trim(rows, MAX_COLUMNS_PER_TABLE).map(c => ({
      name: c.name,
      type: c.type,
      nullable: c.notnull === 0,
      primaryKey: c.pk > 0,
      default: c.dflt_value ?? null
    }));
  }
}

export class MongoSchemaAdapter extends SchemaAdapter {
  async describe(options) {
    const wanted = options.collection
      ? [{ name: options.collection }]
      : (await this.client.db.listCollections({}, { nameOnly: true }).toArray()).slice(0, MAX_TABLES);

    const collections = [];
    for (const info of wanted) {
      const stats = await this.safeStats(info.name);
      let indexes = [];
      try {
        indexes = (await this.client.db.collection(info.name).indexes()).map(i => ({
          name: i.name,
          key: i.key,
          unique: !!i.unique
        }));
      } catch {
        // A collection the user cannot read indexes for is still worth listing.
      }
      collections.push({ name: info.name, documents: stats, indexes });
    }

    return {
      database: 'mongodb',
      databaseName: this.client.options?.dbName ?? null,
      collections,
      truncated: !options.collection && collections.length >= MAX_TABLES
    };
  }

  async safeStats(name) {
    try {
      const s = await this.client.db.command({ collStats: name });
      return s.count ?? null;
    } catch {
      return null;
    }
  }
}

export class RedisSchemaAdapter extends SchemaAdapter {
  async describe() {
    const keyspace = [];

    // info('keyspace') parses into { keyspace: 'db0:keys=12,expires=3,...' },
    // so the per-database lines are inside the section body.
    for (const [section, body] of Object.entries(
      await this.safe(() => this.client.info('keyspace'), {})
    )) {
      if (section !== 'keyspace') continue;
      for (const line of String(body).split(/\r?\n/)) {
        const match = /^db(\d+):keys=(\d+),expires=(\d+),avg_ttl=(\d+)/.exec(line.trim());
        if (!match) continue;
        keyspace.push({
          database: Number(match[1]),
          keys: Number(match[2]),
          withExpiry: Number(match[3]),
          averageTtlMs: Number(match[4])
        });
      }
    }

    // There is no schema to read, so a sample of key names is the next best
    // thing an agent can go on.
    const sample = await this.safe(async () => {
      const keys = [];
      for await (const key of this.client.scanIterator({ COUNT: 50 })) {
        keys.push(key);
        if (keys.length >= 20) break;
      }
      return keys;
    }, []);

    return {
      database: 'redis',
      // info('server') comes back as a raw string, unlike the keyspace section.
      version: await this.safe(async () => {
        const server = await this.client.info('server');
        const match = /^redis_version:(\S+)/m.exec(String(server));
        return match ? match[1] : null;
      }, null),
      keyspace,
      sampleKeys: sample,
      note: 'Redis is schemaless. Use SCAN to explore; KEYS blocks the server.'
    };
  }

  async safe(fn, fallback) {
    try { return await fn(); } catch { return fallback; }
  }
}
