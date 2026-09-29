import { EventEmitter } from 'node:events';
import realSqlite3 from 'sqlite3';
import {
  PostgresSchemaAdapter, MySQLSchemaAdapter,
  SQLiteSchemaAdapter, MongoSchemaAdapter, RedisSchemaAdapter,
  parseInfo
} from '../src/core/schema.js';

/**
 * Every description in this file is built against doubles that answer *by shape*,
 * not by call order. These doubles route on the SQL text, so a test says what the
 * database is asked and asserts on the answer.
 */

// Postgres

/**
 * A pg pool that records everything and answers by matching the statement.
 *
 * `connect` is here because `PostgresSchemaAdapter` needs one: `statement_timeout`
 * is a session setting, so `SET` and the catalogue query have to reach the same
 * backend. A double without `connect` takes the fallback branch, which silently
 * skips the timeout and would leave the fix untested.
 */
function postgresPool(handlers) {
  const client = {
    calls: [],
    released: 0,
    query(sql, params) {
      client.calls.push({ sql, params });
      for (const [pattern, reply] of handlers) {
        if (pattern.test(sql)) {
          return Promise.resolve(typeof reply === 'function' ? reply(sql, params) : { rows: reply });
        }
      }
      return Promise.resolve({ rows: [] });
    },
    release() { client.released++; }
  };
  return {
    client,
    pool: {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn((sql, params) => client.query(sql, params)),
      end: jest.fn().mockResolvedValue()
    }
  };
}

const relation = (schema, name, extra = {}) => ({
  table_schema: schema,
  table_name: name,
  table_type: 'BASE TABLE',
  view_definition: null,
  approximate_rows: 100,
  size_bytes: 8192,
  ...extra,
});

const column = (schema, table, name, extra = {}) => ({
  table_schema: schema,
  table_name: table,
  column_name: name,
  data_type: 'text',
  udt_name: 'text',
  is_nullable: true,
  column_default: null,
  is_identity: false,
  is_generated: false,
  ordinal_position: 1,
  ...extra,
});

describe('PostgresSchemaAdapter', () => {
  let handlers;
  let pool;
  let client;
  let adapter;

  const connect = (extra = []) => {
    ({ pool, client } = postgresPool([...handlers, ...extra]));
    adapter = new PostgresSchemaAdapter();
    adapter.pool = pool;
    return adapter;
  };

  const reply = (pattern, rows) => handlers.push([pattern, rows]);

  beforeEach(() => {
    handlers = [];
    reply(/FROM pg_catalog\.pg_namespace/, [{ name: 'public' }, { name: 'auth' }]);
  });

  describe('summary', () => {
    test('groups columns under the table they belong to', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'users'), relation('public', 'orders')]);
      reply(/FROM pg_catalog\.pg_attribute /, [
        column('public', 'users', 'id', { ordinal_position: 1 }),
        column('public', 'users', 'email', { ordinal_position: 2, is_nullable: false, column_default: "''" }),
        column('public', 'orders', 'id', { ordinal_position: 1 }),
      ]);
      connect();

      const out = await adapter.describe({});

      expect(out.database).toBe('postgresql');
      expect(out.detail).toBe('summary');
      expect(out.tables.map(t => t.name)).toEqual(['users', 'orders']);
      expect(out.tables.find(t => t.name === 'users').columns.map(c => c.name)).toEqual(['id', 'email']);
      expect(out.tables.find(t => t.name === 'users').columns[1])
        .toMatchObject({ nullable: false, default: "''" });
      expect(out.schemas).toEqual(['public', 'auth']);
    });

    // The bug: columns were matched on the table NAME alone, so `public.users`
    // and `auth.users` each ended up carrying the union of both tables' columns.
    // The tables query selected the schema and the response threw it away.
    test('never mixes two schemas that share a table name', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'users'), relation('auth', 'users')]);
      reply(/FROM pg_catalog\.pg_attribute /, [
        column('public', 'users', 'id'),
        column('public', 'users', 'email'),
        column('auth', 'users', 'token_hash'),
      ]);
      connect();

      const out = await adapter.describe({});

      const publicUsers = out.tables.find(t => t.schema === 'public' && t.name === 'users');
      const authUsers = out.tables.find(t => t.schema === 'auth' && t.name === 'users');
      expect(publicUsers.columns.map(c => c.name)).toEqual(['id', 'email']);
      expect(authUsers.columns.map(c => c.name)).toEqual(['token_hash']);
    });

    // `pg` returns `int8` as a string so a value past `Number.MAX_SAFE_INTEGER`
    // cannot be rounded, and both of these columns are `int8` — `reltuples` and
    // `pg_total_relation_size`. Passing the string through would have made every
    // table's row count a string in the answer, and a number built from it would
    // have been a rounding of the truth.
    test('reads the int8 row estimate and size as numbers, not as strings', async () => {
      reply(/FROM pg_catalog\.pg_class /, [
        relation('public', 'users', { approximate_rows: '1500', size_bytes: '1048576' }),
      ]);
      reply(/FROM pg_catalog\.pg_attribute /, [column('public', 'users', 'id')]);
      connect();

      const out = await adapter.describe({});

      expect(out.tables[0]).toMatchObject({ approximateRows: 1500, sizeBytes: 1048576 });
    });

    // A size past 2^53 stays the string it arrived as, because that is the only
    // representation of it that is not a lie.
    test('keeps a size too large for a JS number as a string', async () => {
      reply(/FROM pg_catalog\.pg_class /, [
        relation('public', 'wide', { size_bytes: '9223372036854775807' }),
      ]);
      reply(/FROM pg_catalog\.pg_attribute /, [column('public', 'wide', 'id')]);
      connect();

      const out = await adapter.describe({});

      expect(out.tables[0].sizeBytes).toBe('9223372036854775807');
    });

    // `reltuples` is `-1` when the table has never been analysed or vacuumed,
    // which is its documented "unknown" answer. Reported as a row count it would
    // be minus one rows.
    test('leaves out a row estimate the planner never made', async () => {
      reply(/FROM pg_catalog\.pg_class /, [
        relation('public', 'fresh', { approximate_rows: '-1' }),
      ]);
      reply(/FROM pg_catalog\.pg_attribute /, [column('public', 'fresh', 'id')]);
      connect();

      const out = await adapter.describe({});

      expect(out.tables[0]).not.toHaveProperty('approximateRows');
      expect(out.tables[0].sizeBytes).toBe(8192);
    });

    test('scopes the follow-up queries to the page, by (schema, name) pair', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'users'), relation('auth', 'users')]);
      reply(/FROM pg_catalog\.pg_attribute /, []);
      connect();

      await adapter.describe({});

      const columnQuery = client.calls.find(c => /pg_attribute/.test(c.sql));
      // Row-value tuples, so `public.users` cannot pull in `auth.users`. Two
      // parallel IN lists would match every combination.
      expect(columnQuery.sql).toContain("(n.nspname, c.relname) IN (($1, $2), ($3, $4))");
      expect(columnQuery.params.slice(0, 4)).toEqual(['public', 'users', 'auth', 'users']);
    });

    test('reports the real type rather than ARRAY or USER-DEFINED', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'events')]);
      reply(/FROM pg_catalog\.pg_attribute /, [
        column('public', 'events', 'tags', { data_type: 'text[]', udt_name: '_text' }),
        column('public', 'events', 'mood', { data_type: 'mood', udt_name: 'mood' }),
        column('public', 'events', 'at', { data_type: 'timestamp with time zone', udt_name: 'timestamptz' }),
        column('public', 'events', 'body', { data_type: 'jsonb', udt_name: 'jsonb' }),
      ]);
      connect();

      const out = await adapter.describe({});

      expect(out.tables[0].columns.map(c => [c.type, c.udtName])).toEqual([
        ['text[]', '_text'],
        ['mood', 'mood'],
        ['timestamp with time zone', 'timestamptz'],
        ['jsonb', 'jsonb'],
      ]);
    });

    test('excludes the system and temporary schemas', async () => {
      reply(/FROM pg_catalog\.pg_class /, []);
      connect();

      await adapter.describe({});

      const tablesQuery = client.calls.find(c => /FROM pg_catalog.pg_class/.test(c.sql));
      // `pg_toast` and `pg_temp_*` were not excluded, so a database with a
      // temporary table reported a schema of columns as if it were user data.
      expect(tablesQuery.sql).toContain("n.nspname NOT LIKE 'pg\\_%'");
      expect(tablesQuery.sql).toContain("n.nspname <> 'information_schema'");
    });

    test('binds a requested table name as a parameter', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'users')]);
      reply(/FROM pg_catalog\.pg_attribute /, []);
      connect();

      await adapter.describe({ table: 'users' });

      const tablesQuery = client.calls.find(c => /FROM pg_catalog.pg_class/.test(c.sql));
      expect(tablesQuery.sql).toContain('AND c.relname = $1');
      expect(tablesQuery.params[0]).toBe('users');
    });

    test('does not ask for columns when there are no relations', async () => {
      reply(/FROM pg_catalog\.pg_class /, []);
      connect();

      const out = await adapter.describe({});

      expect(out.tables).toEqual([]);
      expect(out.truncated).toBe(false);
      expect(client.calls.some(c => /pg_attribute/.test(c.sql))).toBe(false);
    });

    test('runs the catalogue scan under a server-side statement_timeout', async () => {
      reply(/FROM pg_catalog\.pg_class /, []);
      connect();

      await adapter.describe({});

      // db_schema used to bypass `PostgresAdapter#execute` entirely, so the
      // `SET statement_timeout` that bounds a query never applied to it and a
      // slow catalogue scan was unbounded server-side.
      const timeout = client.calls.find(c => /^SET statement_timeout/.test(c.sql));
      expect(timeout).toBeTruthy();
      expect(timeout.sql).toBe('SET statement_timeout = 30000');
    });

    test('releases the client, so the pool does not run out', async () => {
      reply(/FROM pg_catalog\.pg_class /, []);
      connect();

      await adapter.describe({});

      // One acquisition per statement — the relations page, the schema list and
      // anything else this description needs — and one release for each.
      expect(pool.connect).toHaveBeenCalled();
      expect(client.released).toBe(pool.connect.mock.calls.length);
    });

    test('routes a driver error through describeError when one is supplied', async () => {
      reply(/FROM pg_catalog\.pg_class /, () => { throw Object.assign(new Error('permission denied'), { code: '42501' }); });
      connect();
      adapter.describeError = (err) => new Error(`[Postgres insufficient privilege] ${err.message}`);

      await expect(adapter.describe({})).rejects.toThrow('[Postgres insufficient privilege]');
    });

    test('falls back to its own prefix when no adapter supplied one', async () => {
      reply(/FROM pg_catalog\.pg_class /, () => { throw new Error('nope'); });
      connect();

      await expect(adapter.describe({})).rejects.toThrow('[Postgres schema]');
    });
  });

  describe('pagination', () => {
    test('asks for one row more than the page, so truncated is a fact', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'a')]);
      reply(/FROM pg_catalog\.pg_attribute /, []);
      connect();

      await adapter.describe({ limit: 1 });

      const tablesQuery = client.calls.find(c => /FROM pg_catalog.pg_class/.test(c.sql));
      expect(tablesQuery.params.at(-2)).toBe(2);
    });

    test('reports hasMore rather than a bare truncated flag', async () => {
      const many = Array.from({ length: 4 }, (_, i) => relation('public', `t${i}`));
      reply(/FROM pg_catalog\.pg_class /, many);
      reply(/FROM pg_catalog\.pg_attribute /, []);
      connect();

      const out = await adapter.describe({ limit: 2 });

      expect(out.tables).toHaveLength(2);
      expect(out.truncated).toBe(true);
      expect(out.page).toEqual({ limit: 2, offset: 0, page: 1, returned: 2, hasMore: true, nextOffset: 2 });
    });

    test('does not claim truncation for a database that fits exactly', async () => {
      // `rows.length >= MAX_TABLES` reported truncated: true for a database with
      // exactly 500 tables, which sends the model looking for a 501st.
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'a')]);
      reply(/FROM pg_catalog\.pg_attribute /, []);
      connect();

      const out = await adapter.describe({ limit: 1 });

      expect(out.tables).toHaveLength(1);
      expect(out.truncated).toBe(false);
      expect(out.page.hasMore).toBe(false);
    });

    test('passes the offset through and computes the page number', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'a')]);
      reply(/FROM pg_catalog\.pg_attribute /, []);
      connect();

      const out = await adapter.describe({ offset: 100, limit: 50 });

      const tablesQuery = client.calls.find(c => /FROM pg_catalog.pg_class/.test(c.sql));
      expect(tablesQuery.params.at(-1)).toBe(100);
      expect(out.page).toMatchObject({ offset: 100, page: 3 });
    });

    test('coerces a nonsense limit rather than putting it in the SQL', async () => {
      reply(/FROM pg_catalog\.pg_class /, []);
      connect();

      await adapter.describe({ limit: "1; DROP TABLE t" });

      const tablesQuery = client.calls.find(c => /FROM pg_catalog.pg_class/.test(c.sql));
      // 500, plus the one extra row whose presence is what proves hasMore.
      expect(tablesQuery.params.at(-2)).toBe(501);
    });
  });

  describe('the per-table column cap', () => {
    // MAX_COLUMNS_PER_TABLE was declared in this module and applied in exactly
    // one of the five paths, so Postgres reported the thousandth column while
    // SQLite did not.
    test('caps a wide table and says which table was cut', async () => {
      const wide = Array.from({ length: 130 }, (_, i) =>
        column('public', 'wide', `c${i}`, { ordinal_position: i }));
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'wide')]);
      reply(/FROM pg_catalog\.pg_attribute /, wide);
      connect();

      const out = await adapter.describe({});

      expect(out.tables[0].columns).toHaveLength(100);
      expect(out.tables[0].columnsTruncated).toBe(true);
      expect(out.truncated).toBe(true);
    });

    test('leaves a narrow table unmarked', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'narrow')]);
      reply(/FROM pg_catalog\.pg_attribute /, [column('public', 'narrow', 'id')]);
      connect();

      const out = await adapter.describe({});

      expect(out.tables[0].columnsTruncated).toBeUndefined();
      expect(out.truncated).toBe(false);
    });
  });

  describe('detail: full', () => {
    const full = () => {
      reply(/FROM pg_catalog\.pg_index /, [{
        table_schema: 'public', table_name: 'users', name: 'users_email_key',
        is_unique: true, is_primary: false, method: 'btree',
        definition: 'CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)',
        columns: ['email'], size_bytes: 4096,
      }]);
      reply(/FROM pg_catalog\.pg_constraint /, [
        {
          table_schema: 'public', table_name: 'users', name: 'users_pkey', kind: 'p',
          definition: 'PRIMARY KEY (id)', columns: ['id'],
          referenced_schema: null, referenced_table: null, referenced_columns: null,
          on_delete: null, on_update: null,
        },
        {
          table_schema: 'public', table_name: 'orders', name: 'orders_user_fkey', kind: 'f',
          definition: 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
          columns: ['user_id'],
          referenced_schema: 'public', referenced_table: 'users', referenced_columns: ['id'],
          on_delete: 'c', on_update: 'a',
        },
        {
          table_schema: 'public', table_name: 'orders', name: 'orders_total_check', kind: 'c',
          definition: 'CHECK ((total >= 0))', columns: ['total'],
          referenced_schema: null, referenced_table: null, referenced_columns: null,
          on_delete: null, on_update: null,
        },
        {
          table_schema: 'public', table_name: 'users', name: 'users_email_key', kind: 'u',
          definition: 'UNIQUE (email)', columns: ['email'],
          referenced_schema: null, referenced_table: null, referenced_columns: null,
          on_delete: null, on_update: null,
        },
      ]);
      reply(/FROM pg_catalog\.pg_sequence /, [{
        schema: 'public', name: 'users_id_seq', data_type: 'bigint',
        start_value: 1, increment_by: 1, min_value: 1, max_value: 9223372036854775807,
        cycle: false, cache: 1,
      }]);
      reply(/FROM pg_catalog\.pg_trigger /, [{
        schema: 'public', table_name: 'users', name: 'users_touch',
        definition: 'CREATE TRIGGER users_touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION touch()',
        enabled: true,
      }]);
    };

    test('reports foreign keys, which are the reason to introspect at all', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'orders')]);
      reply(/FROM pg_catalog\.pg_attribute /, [column('public', 'orders', 'user_id')]);
      full();
      connect();

      const out = await adapter.describe({ detail: 'full' });

      expect(out.detail).toBe('full');
      expect(out.tables[0].foreignKeys).toEqual([{
        name: 'orders_user_fkey',
        columns: ['user_id'],
        definition: 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
        referencedTable: 'users',
        referencedSchema: 'public',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      }]);
    });

    test('separates primary keys, unique constraints and checks', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'orders')]);
      reply(/FROM pg_catalog\.pg_attribute /, []);
      full();
      connect();

      const out = await adapter.describe({ detail: 'full' });
      const table = out.tables.find(t => t.name === 'orders');

      expect(table.primaryKey).toBeUndefined();
      expect(table.checks).toEqual([{ name: 'orders_total_check', columns: ['total'], definition: 'CHECK ((total >= 0))' }]);
    });

    test('reports an index by name, columns and method — not a per-column hint', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'users')]);
      reply(/FROM pg_catalog\.pg_attribute /, []);
      full();
      connect();

      const out = await adapter.describe({ detail: 'full' });

      expect(out.tables[0].indexes).toEqual([{
        name: 'users_email_key', columns: ['email'], unique: true, primary: false,
        method: 'btree',
        definition: 'CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)',
        sizeBytes: 4096,
      }]);
      expect(out.tables[0].unique).toEqual([{
        name: 'users_email_key', columns: ['email'], definition: 'UNIQUE (email)',
      }]);
    });

    test('reports sequences and triggers', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'users')]);
      reply(/FROM pg_catalog\.pg_attribute /, []);
      full();
      connect();

      const out = await adapter.describe({ detail: 'full' });

      expect(out.sequences).toEqual([{
        name: 'users_id_seq', schema: 'public', dataType: 'bigint',
        start: 1, increment: 1, min: 1, max: 9223372036854775807, cycle: false, cache: 1,
      }]);
      expect(out.triggers).toEqual([{
        name: 'users_touch', table: 'users', schema: 'public',
        definition: expect.stringContaining('CREATE TRIGGER'), enabled: true,
      }]);
    });

    test('asks for none of it at the summary level', async () => {
      reply(/FROM pg_catalog\.pg_class /, []);
      full();
      connect();

      await adapter.describe({});

      expect(client.calls.some(c => /pg_constraint/.test(c.sql))).toBe(false);
      expect(client.calls.some(c => /pg_index/.test(c.sql))).toBe(false);
    });

    test('survives a database where the wide catalogue is unreadable', async () => {
      reply(/FROM pg_catalog\.pg_class /, [relation('public', 'users')]);
      reply(/FROM pg_catalog\.pg_attribute /, []);
      reply(/FROM pg_catalog\.pg_sequence /, () => { throw new Error('permission denied'); });
      reply(/FROM pg_catalog\.pg_trigger /, () => { throw new Error('permission denied'); });
      connect();

      const out = await adapter.describe({ detail: 'full' });

      expect(out.sequences).toEqual([]);
      expect(out.triggers).toEqual([]);
    });
  });

  test('rejects an unrecognised detail rather than silently returning summary', async () => {
    connect();
    await expect(adapter.describe({ detail: 'everything' }))
      .rejects.toThrow("'detail' must be one of \"summary\", \"full\"");
  });
});

// MySQL

const mysqlColumns = (name) => ({
  TABLE_NAME: name, TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 3,
  ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_0900_ai_ci', TABLE_COMMENT: null,
});

const mysqlColumn = (table, name, extra = {}) => ({
  TABLE_NAME: table, COLUMN_NAME: name, COLUMN_TYPE: 'int', IS_NULLABLE: 'NO',
  COLUMN_KEY: 'PRI', COLUMN_DEFAULT: null, EXTRA: 'auto_increment',
  COLUMN_COMMENT: '', GENERATION_EXPRESSION: '', CHARACTER_SET_NAME: null, ORDINAL_POSITION: 1,
  ...extra,
});

describe('MySQLSchemaAdapter', () => {
  let handlers;
  let adapter;
  let conn;
  let pool;

  const connect = () => {
    const calls = [];
    conn = {
      connection: {
        query: jest.fn(({ sql }, callback) => {
          calls.push(sql);
          for (const [pattern, rows] of handlers) {
            if (pattern.test(sql)) return callback(null, rows);
          }
          return callback(null, []);
        })
      },
      release: jest.fn()
    };
    pool = {
      getConnection: jest.fn().mockResolvedValue(conn),
      releaseConnection: jest.fn(),
      query: jest.fn()
    };
    adapter = new MySQLSchemaAdapter();
    adapter.pool = pool;
    adapter.sql = calls;
    return adapter;
  };

  beforeEach(() => {
    handlers = [];
    handlers.push([/VERSION\(\)/, [{ version: '8.0.36' }]]);
  });

  test('reads the upper-case information_schema column names', async () => {
    handlers.push([/information_schema.TABLES/, [mysqlColumns('users')]]);
    handlers.push([/information_schema.COLUMNS/, [
      mysqlColumn('users', 'id'),
      mysqlColumn('users', 'email', {
        COLUMN_TYPE: 'varchar(80)', IS_NULLABLE: 'YES', COLUMN_KEY: 'UNI', EXTRA: '',
        ORDINAL_POSITION: 2, CHARACTER_SET_NAME: 'utf8mb4',
      }),
    ]]);
    connect();

    const out = await adapter.describe({});

    expect(out.database).toBe('mysql');
    expect(out.version).toBe('8.0.36');
    expect(out.tables[0].approximateRows).toBe(3);
    expect(out.tables[0].collation).toBe('utf8mb4_0900_ai_ci');
    expect(out.tables[0].columns).toEqual([
      { name: 'id', type: 'int', nullable: false, key: 'PRI', default: null, extra: 'auto_increment' },
      {
        name: 'email', type: 'varchar(80)', nullable: true, key: 'UNI', default: null,
        extra: null, characterSet: 'utf8mb4',
      },
    ]);
  });

  test('scopes to the selected database and binds the table name', async () => {
    connect();

    await adapter.describe({ table: 'users' });

    const tables = adapter.sql.find(sql => /information_schema.TABLES/.test(sql));
    expect(tables).toContain('TABLE_SCHEMA = DATABASE()');
    expect(tables).toContain('AND TABLE_NAME = ?');
  });

  test('asks for the column set the page needs, in one query', async () => {
    handlers.push([/information_schema.TABLES/, [mysqlColumns('a'), mysqlColumns('b'), mysqlColumns('c')]]);
    handlers.push([/information_schema.COLUMNS/, []]);
    connect();

    await adapter.describe({});

    const columnQuery = adapter.sql.find(sql => /information_schema.COLUMNS/.test(sql));
    // One round trip for every table on the page, which is the fix for what was
    // a query per table in every other backend.
    expect(columnQuery).toContain('AND TABLE_NAME IN (?, ?, ?)');
  });

  test('caps a wide table and says so', async () => {
    handlers.push([/information_schema.TABLES/, [mysqlColumns('wide')]]);
    handlers.push([/information_schema.COLUMNS/, Array.from({ length: 120 }, (_, i) =>
      mysqlColumn('wide', `c${i}`, { ORDINAL_POSITION: i }))]);
    connect();

    const out = await adapter.describe({});

    expect(out.tables[0].columns).toHaveLength(100);
    expect(out.tables[0].columnsTruncated).toBe(true);
    expect(out.truncated).toBe(true);
  });

  test('runs the catalogue scan on a connection of its own, with a timeout', async () => {
    // mysql2 applies no timeout to pool.query(), and a MAX_EXECUTION_TIME hint on
    // an information_schema scan is a hint MySQL may ignore.
    connect();

    await adapter.describe({});

    const options = conn.connection.query.mock.calls[0][0];
    expect(options).toMatchObject({ timeout: 30000 });
    expect(pool.releaseConnection).toHaveBeenCalledWith(conn);
  });

  test('reports an empty database without asking for columns', async () => {
    handlers.push([/information_schema.TABLES/, []]);
    connect();

    const out = await adapter.describe({});

    expect(out.tables).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  test('paginates', async () => {
    handlers.push([/information_schema.TABLES/, [mysqlColumns('a'), mysqlColumns('b')]]);
    handlers.push([/information_schema.COLUMNS/, []]);
    connect();

    const out = await adapter.describe({ limit: 1, offset: 4 });

    expect(adapter.sql.find(sql => /information_schema.TABLES/.test(sql))).toContain('LIMIT ? OFFSET ?');
    expect(out.page).toMatchObject({ limit: 1, offset: 4, returned: 1, hasMore: true });
  });

  describe('detail: full', () => {
    const wide = () => {
      handlers.push([/information_schema.STATISTICS/, [
        { TABLE_NAME: 'orders', INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'id', INDEX_TYPE: 'BTREE', EXPRESSION: null, COMMENT: '' },
        { TABLE_NAME: 'orders', INDEX_NAME: 'idx_user', NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'user_id', INDEX_TYPE: 'BTREE', EXPRESSION: null, COMMENT: '' },
        { TABLE_NAME: 'orders', INDEX_NAME: 'idx_user', NON_UNIQUE: 1, SEQ_IN_INDEX: 2, COLUMN_NAME: 'created', INDEX_TYPE: 'BTREE', EXPRESSION: null, COMMENT: '' },
      ]]);
      handlers.push([/KEY_COLUMN_USAGE/, [
        {
          TABLE_NAME: 'orders', CONSTRAINT_NAME: 'orders_user_fkey', COLUMN_NAME: 'user_id',
          ORDINAL_POSITION: 1, REFERENCED_TABLE_NAME: 'users', REFERENCED_COLUMN_NAME: 'id',
          UPDATE_RULE: 'CASCADE', DELETE_RULE: 'RESTRICT',
        },
      ]]);
      handlers.push([/CHECK_CONSTRAINTS/, [
        { TABLE_NAME: 'orders', CONSTRAINT_NAME: 'orders_total', CHECK_CLAUSE: '(`total` >= 0)' },
      ]]);
    };

    test('rebuilds an index from its per-column rows, in order', async () => {
      handlers.push([/information_schema.TABLES/, [mysqlColumns('orders')]]);
      handlers.push([/information_schema.COLUMNS/, []]);
      wide();
      connect();

      const out = await adapter.describe({ detail: 'full' });
      const byName = Object.fromEntries(out.tables[0].indexes.map(i => [i.name, i]));

      // COLUMNS.KEY only ever said 'MUL' for a multi-column index. The name and
      // the order are the information a planner decision needs.
      expect(byName.idx_user.columns).toEqual(['user_id', 'created']);
      expect(byName.idx_user.unique).toBe(false);
      expect(out.tables[0].primaryKey).toEqual([{ name: 'PRIMARY', columns: ['id'], definition: null }]);
    });

    test('reports foreign keys with their rules', async () => {
      handlers.push([/information_schema.TABLES/, [mysqlColumns('orders')]]);
      handlers.push([/information_schema.COLUMNS/, []]);
      wide();
      connect();

      const out = await adapter.describe({ detail: 'full' });

      expect(out.tables[0].foreignKeys).toEqual([{
        name: 'orders_user_fkey', columns: ['user_id'], referencedTable: 'users',
        referencedColumns: ['id'], onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      }]);
      expect(out.tables[0].checks).toEqual([{ name: 'orders_total', definition: '(`total` >= 0)' }]);
    });

    test('asks for none of it at the summary level', async () => {
      handlers.push([/information_schema.TABLES/, []]);
      wide();
      connect();

      await adapter.describe({});

      expect(adapter.sql.some(sql => /STATISTICS/.test(sql))).toBe(false);
      expect(adapter.sql.some(sql => /KEY_COLUMN_USAGE/.test(sql))).toBe(false);
    });
  });

  test('rejects an unrecognised detail', async () => {
    connect();
    await expect(adapter.describe({ detail: 'full-ish' })).rejects.toThrow("'detail' must be one of");
  });
});

// SQLite

/**
 * A sqlite3 handle double that answers by matching the SQL.
 *
 * The `pragma_table_xinfo` join is what removed the N+1, so the double has to
 * understand it — and has to be able to fail it, so the per-table fallback path
 * is reachable too.
 */
function sqliteHandle({ objects = [], columns = [], foreignKeys = [], indexes = [], triggers = [], page = {} } = {}) {
  const db = new EventEmitter();
  db.sql = [];
  db.supportsPragmaFunctions = true;
  db.all = jest.fn((sql, params, cb) => {
    db.sql.push({ sql, params });

    // The capability probe, and the capability itself.
    if (/pragma_table_xinfo/.test(sql) && !db.supportsPragmaFunctions) {
      return cb(new Error('no such table: pragma_table_xinfo'));
    }
    if (/FROM sqlite_master/.test(sql) && /pragma_/.test(sql)) {
      const wanted = new Set(params || []);
      if (/pragma_table_xinfo\(/.test(sql)) {
        return cb(null, columns.filter(c => wanted.has(c.table_name)));
      }
      if (/pragma_foreign_key_list\(/.test(sql)) {
        return cb(null, foreignKeys.filter(f => wanted.has(f.table_name)));
      }
      if (/pragma_index_list\(/.test(sql)) {
        return cb(null, indexes.filter(i => wanted.has(i.table_name)));
      }
    }
    // Triggers come from sqlite_master: `pragma_trigger_list` is not a
    // table-valued function and does not exist.
    if (/type = 'trigger'/.test(sql)) {
      const wanted = new Set(params || []);
      return cb(null, triggers.filter(t => wanted.has(t.table_name)));
    }
    if (/FROM sqlite_master/.test(sql)) return cb(null, objects);

    if (/PRAGMA page_count/.test(sql)) return cb(null, [{ page_count: page.count ?? 4 }]);
    if (/PRAGMA page_size/.test(sql)) return cb(null, [{ page_size: page.size ?? 4096 }]);

    // The pre-3.16 path: one PRAGMA per table. The name is quoted inside the
    // pragma body, with its own quotes doubled.
    const pragma = /^PRAGMA ([a-z_]+)(?:\("(.*)"\))?$/.exec(sql);
    if (pragma) {
      const [, which, name] = pragma;
      switch (which) {
        case 'table_info':
          return cb(null, columns.filter(c => c.table_name === name));
        case 'foreign_key_list':
          return cb(null, foreignKeys.filter(f => f.table_name === name).map((f) => ({
            id: f.id, seq: f.seq, table: f.referenced_table, from: f.from_column, to: f.to_column,
            on_update: f.on_update, on_delete: f.on_delete,
          })));
        case 'index_list':
          return cb(null, indexes.filter(i => i.table_name === name).map((i) => ({
            name: i.index_name, unique: i.unique, origin: i.origin, partial: i.partial,
          })));
        case 'index_info':
          return cb(null, indexes.filter(i => i.index_name === name)
            .map((i) => ({ seqno: i.seqno, cid: 0, name: i.column_name })));
        case 'trigger_list':
          return cb(null, triggers.filter(t => t.table_name === name).map((t) => ({ name: t.trigger_name })));
        default:
          return cb(null, []);
      }
    }

    return cb(null, []);
  });
  return db;
}

describe('SQLiteSchemaAdapter', () => {
  let db;
  let adapter;

  const connect = (options) => {
    db = sqliteHandle(options);
    adapter = new SQLiteSchemaAdapter();
    adapter.db = db;
    return adapter;
  };

  const object = (name, type = 'table') => ({ name, type, sql: `CREATE ${type.toUpperCase()} ${name} (…)` });

  const column = (table, name, extra = {}) => ({
    table_name: table, cid: 0, name, type: 'TEXT', notnull: 0, dflt_value: null, pk: 0, hidden: 0, ...extra,
  });

  test('reads the catalogue and every table in one query', async () => {
    connect({
      objects: [object('active_users', 'view'), object('users')],
      columns: [column('users', 'id', { pk: 1, notnull: 1 }), column('users', 'email')],
    });

    const out = await adapter.describe({});

    expect(out.database).toBe('sqlite');
    expect(out.detail).toBe('summary');
    expect(out.tables.map(t => t.name)).toEqual(['active_users', 'users']);
    expect(out.tables[1].columns).toEqual([
      { name: 'id', type: 'TEXT', nullable: false, primaryKey: true, default: null },
      { name: 'email', type: 'TEXT', nullable: true, primaryKey: false, default: null },
    ]);
    expect(out.tables[1].sql).toContain('CREATE TABLE users');
    // The N+1 is gone: the pragma functions answer for every table at once.
    expect(db.sql.filter(call => /PRAGMA "table_info/.test(call.sql))).toHaveLength(0);
  });

  test('excludes internal tables', async () => {
    connect({ objects: [] });

    await adapter.describe({});

    expect(db.sql[0].sql).toContain("name NOT LIKE 'sqlite_%'");
  });

  // table_xinfo reports generated and hidden columns; table_info silently omits
  // them, so a generated column used to be a column a model could not see.
  test('reports a generated column that table_info would hide', async () => {
    connect({
      objects: [object('t')],
      columns: [
        column('t', 'id', { pk: 1 }),
        column('t', 'total', { type: 'INTEGER', hidden: 2 }),
        column('t', 'slug', { type: 'TEXT', hidden: 3 }),
      ],
    });

    const out = await adapter.describe({});

    expect(out.tables[0].columns.map(c => [c.name, c.generated])).toEqual([
      ['id', undefined], ['total', 'VIRTUAL'], ['slug', 'STORED'],
    ]);
  });

  test('caps a wide table and says so', async () => {
    connect({
      objects: [object('wide')],
      columns: Array.from({ length: 130 }, (_, i) => column('wide', `c${i}`, { cid: i })),
    });

    const out = await adapter.describe({});

    expect(out.tables[0].columns).toHaveLength(100);
    expect(out.tables[0].columnsTruncated).toBe(true);
  });

  test('quotes a hostile table name so it cannot break out of a PRAGMA', async () => {
    db = sqliteHandle({ objects: [object('books"; DROP TABLE authors; --')] });
    db.supportsPragmaFunctions = false;
    adapter = new SQLiteSchemaAdapter();
    adapter.db = db;

    const out = await adapter.describe({});

    expect(db.sql.some(call => call.sql === 'PRAGMA table_info("books""; DROP TABLE authors; --")'))
      .toBe(true);
    expect(out.tables[0].columns).toEqual([]);
  });

  test('refuses a name containing a NUL, which would truncate the statement', async () => {
    db = sqliteHandle({ objects: [{ name: 'a\0DROP TABLE t', type: 'table', sql: 'x' }] });
    db.supportsPragmaFunctions = false;
    adapter = new SQLiteSchemaAdapter();
    adapter.db = db;

    const out = await adapter.describe({});

    expect(out.tables[0].columns).toEqual([]);
  });

  test('reports a read that fails', async () => {
    db = sqliteHandle();
    db.all.mockImplementationOnce((sql, params, cb) => cb(new Error('SQLITE_BUSY: database is locked')));
    adapter = new SQLiteSchemaAdapter();
    adapter.db = db;

    await expect(adapter.describe({})).rejects.toThrow('[SQLite schema]');
  });

  test('returns an empty list for an empty database', async () => {
    connect({ objects: [] });

    await expect(adapter.describe({})).resolves.toMatchObject({
      database: 'sqlite',
      detail: 'summary',
      tables: [],
      truncated: false,
      page: { returned: 0, hasMore: false },
    });
  });

  test('paginates, and does not call truncated for an exact fit', async () => {
    connect({ objects: [object('a'), object('b')] });

    const out = await adapter.describe({ limit: 2 });

    expect(out.page).toMatchObject({ limit: 2, hasMore: false });
    expect(out.truncated).toBe(false);
  });

  describe('the pre-3.16 fallback', () => {
    test('asks per table, concurrently, when the pragma functions are absent', async () => {
      db = sqliteHandle({
        objects: [object('a'), object('b'), object('c')],
        columns: [column('a', 'id'), column('b', 'id'), column('c', 'id')],
      });
      db.supportsPragmaFunctions = false;
      adapter = new SQLiteSchemaAdapter();
      adapter.db = db;

      const out = await adapter.describe({});

      expect(out.tables.map(t => t.columns.map(c => c.name))).toEqual([['id'], ['id'], ['id']]);
      expect(db.sql.filter(call => /PRAGMA table_info/.test(call.sql))).toHaveLength(3);
    });

    test('a trigger catalogue that cannot be read does not fail the description', async () => {
      // One unreadable query must not take the other 499 tables with it, and the
      // report has to be honest about what it does not know rather than throwing
      // — the same rule `columnsPerTable` and `detailPerTable` follow for every
      // other leg.
      db = sqliteHandle({
        objects: [object('orders')],
        columns: [column('orders', 'id')],
        triggers: [{ table_name: 'orders', trigger_name: 'orders_ai', sql: 'CREATE TRIGGER …' }],
      });
      db.supportsPragmaFunctions = false;
      adapter = new SQLiteSchemaAdapter();
      adapter.db = db;
      const inner = db.all.getMockImplementation();
      db.all.mockImplementation((sql, params, cb) => {
        if (/type = 'trigger'/.test(sql)) return cb(new Error('SQLITE_ERROR: database table is locked'));
        return inner(sql, params, cb);
      });

      const out = await adapter.describe({ detail: 'full' });

      expect(out.tables[0].name).toBe('orders');
      expect(out.tables[0].columns.map((c) => c.name)).toEqual(['id']);
      expect(out.tables[0].triggers).toBeUndefined();
    });

    test('probes for the functions once per connection', async () => {
      db = sqliteHandle({ objects: [object('t')], columns: [] });
      adapter = new SQLiteSchemaAdapter();
      adapter.db = db;

      await adapter.describe({});
      await adapter.describe({});

      const probes = db.sql.filter(call => /pragma_table_xinfo\('sqlite_master'\)/.test(call.sql));
      expect(probes).toHaveLength(1);
    });

    test('falls back to one PRAGMA per table when the functions are absent', async () => {
      db = sqliteHandle({
        objects: [object('orders')],
        foreignKeys: [
          { table_name: 'orders', id: 0, seq: 0, referenced_table: 'users', from_column: 'user_id', to_column: 'id', on_update: 'CASCADE', on_delete: 'RESTRICT' },
        ],
        indexes: [{ table_name: 'orders', index_name: 'idx_user', unique: 1, origin: 'c', partial: 0, seqno: 0, column_name: 'user_id' }],
        triggers: [{ table_name: 'orders', trigger_name: 'orders_ai', sql: 'CREATE TRIGGER …' }],
        page: { count: 10, size: 4096 },
      });
      db.supportsPragmaFunctions = false;
      adapter = new SQLiteSchemaAdapter();
      adapter.db = db;

      const out = await adapter.describe({ detail: 'full' });

      expect(out.tables[0].foreignKeys).toEqual([{
        referencedTable: 'users', columns: ['user_id'], referencedColumns: ['id'],
        onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      }]);
      expect(out.tables[0].indexes).toEqual([{
        name: 'idx_user', columns: ['user_id'], unique: true, origin: 'c', partial: false,
      }]);
  // The body comes with the trigger now, on this path as well as the modern one:
  // it is read from sqlite_master, which carries it, and the pragma that used to be
  // asked here answered with no rows at all. `definition: null` is what this
  // assertion said before, and is what the old code produced for a trigger that
  // never arrived.
      expect(out.tables[0].triggers).toEqual([{ name: 'orders_ai', definition: 'CREATE TRIGGER …' }]);
      expect(out.file).toEqual({ pageCount: 10, pageSize: 4096, bytes: 40960 });
    });
  });

  describe('detail: full', () => {
    test('reports foreign keys, indexes, triggers and the file size', async () => {
      connect({
        objects: [object('orders')],
        columns: [column('orders', 'user_id')],
        page: { count: 100, size: 4096 },
        foreignKeys: [
          { table_name: 'orders', id: 0, seq: 0, referenced_table: 'users', from_column: 'user_id', to_column: 'id', on_update: 'CASCADE', on_delete: 'RESTRICT' },
        ],
        indexes: [
          { table_name: 'orders', index_name: 'idx_user', unique: 1, origin: 'c', partial: 0, seqno: 0, column_name: 'user_id' },
          { table_name: 'orders', index_name: 'sqlite_autoindex_orders_1', unique: 1, origin: 'pk', partial: 0, seqno: 0, column_name: 'ref' },
        ],
        triggers: [{ table_name: 'orders', trigger_name: 'orders_ai', sql: 'CREATE TRIGGER orders_ai AFTER INSERT ON orders BEGIN SELECT 1; END' }],
      });

      const out = await adapter.describe({ detail: 'full' });

      expect(out.detail).toBe('full');
      expect(out.tables[0].foreignKeys).toEqual([{
        referencedTable: 'users', columns: ['user_id'], referencedColumns: ['id'],
        onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      }]);
      expect(out.tables[0].indexes).toEqual([{
        name: 'idx_user', columns: ['user_id'], unique: true, origin: 'c', partial: false,
      }]);
      expect(out.tables[0].triggers).toEqual([{
        name: 'orders_ai', definition: expect.stringContaining('CREATE TRIGGER'),
      }]);
      expect(out.file).toEqual({ pageCount: 100, pageSize: 4096, bytes: 409600 });
    });

    test('keeps a composite foreign key as one entry', async () => {
      connect({
        objects: [object('t')],
        columns: [],
        foreignKeys: [
          { table_name: 't', id: 0, seq: 0, referenced_table: 'a', from_column: 'x', to_column: 'x', on_update: null, on_delete: null },
          { table_name: 't', id: 0, seq: 1, referenced_table: 'a', from_column: 'y', to_column: 'y', on_update: null, on_delete: null },
          { table_name: 't', id: 1, seq: 0, referenced_table: 'b', from_column: 'z', to_column: 'z', on_update: null, on_delete: null },
        ],
      });

      const out = await adapter.describe({ detail: 'full' });

      expect(out.tables[0].foreignKeys).toHaveLength(2);
      expect(out.tables[0].foreignKeys[0].columns).toEqual(['x', 'y']);
    });

    test('asks for none of it at the summary level', async () => {
      connect({ objects: [object('t')], columns: [] });

      await adapter.describe({});

      expect(db.sql.some(call => /pragma_foreign_key_list/.test(call.sql))).toBe(false);
      expect(db.sql.some(call => /page_count/.test(call.sql))).toBe(false);
    });
  });

  // Everything above in this block runs against a double that answers by matching
  // SQL, which is exactly the kind of double that agrees with a broken
  // implementation: a `sqliteHandle` double had a `case 'trigger_list'` in its
  // switch and answered a list of triggers for a pragma that has never answered
  // one on any SQLite version. So the last two tests run against the real driver,
  // because "the pragma is spelled the way SQLite spells it" is a claim about
  // SQLite and not about this file.
  describe("detail: 'full' against a real in-memory database", () => {
    let db;

    const exec = (sql) => new Promise((resolve, reject) => {
      db.exec(sql, (err) => (err ? reject(err) : resolve()));
    });

    beforeEach(async () => {
      db = new realSqlite3.Database(':memory:');
      await exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
      await exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), ref TEXT)');
      await exec('CREATE INDEX idx_user ON orders(user_id)');
      await exec('CREATE UNIQUE INDEX idx_ref ON orders(ref)');
      await exec('CREATE TRIGGER orders_ai AFTER INSERT ON orders BEGIN SELECT 1; END');

      adapter = new SQLiteSchemaAdapter();
      adapter.db = db;
    });

    afterEach(() => new Promise((resolve) => { db.close(() => resolve()); }));

    const orders = (out) => out.tables.find((t) => t.name === 'orders');

    test('returns the foreign key, the index and the trigger, not just a table list', async () => {
      const out = await adapter.describe({ detail: 'full' });
      const table = orders(out);

      expect(out.database).toBe('sqlite');
      expect(out.detail).toBe('full');

      expect(table.foreignKeys).toEqual([expect.objectContaining({
        referencedTable: 'users',
        columns: ['user_id'],
        referencedColumns: ['id'],
      })]);

      // Both the plain and the unique index, with their columns, and NOT the
      // primary key's implicit one — `table_xinfo` already reports that.
      expect(table.indexes.map((i) => i.name).sort()).toEqual(['idx_ref', 'idx_user']);
      expect(table.indexes.find((i) => i.name === 'idx_ref')).toMatchObject({
        unique: true, columns: ['ref'],
      });
      expect(table.indexes.find((i) => i.name === 'idx_user')).toMatchObject({
        unique: false, columns: ['user_id'],
      });

      // `PRAGMA trigger_list("orders")` answers with zero rows and no error on
      // every version measured, so the report said "this table has no triggers",
      // which is the answer a reader believes.
      expect(table.triggers).toEqual([expect.objectContaining({ name: 'orders_ai' })]);
      expect(table.triggers[0].definition).toContain('CREATE TRIGGER');
    });

    // The same three facts, on the pre-3.16 branch. Forcing it is the only way
    // to reach `detailPerTable`, and it is where the second half of the bug was
    // living: the modern path reads sqlite_master, the fallback was still asking
    // a pragma that answers nothing.
    test('returns all three on the pre-3.16 fallback too', async () => {
      adapter.supportsPragmaFunctions = async () => false;

      const out = await adapter.describe({ detail: 'full' });
      const table = orders(out);

      expect(table.foreignKeys).toEqual([expect.objectContaining({
        referencedTable: 'users', columns: ['user_id'], referencedColumns: ['id'],
      })]);
      expect(table.indexes.map((i) => i.name).sort()).toEqual(['idx_ref', 'idx_user']);
      expect(table.indexes.find((i) => i.name === 'idx_user')).toMatchObject({ columns: ['user_id'] });
      // `definition` is carried on the fallback path too, because sqlite_master
      // has it and the pragma never did.
      expect(table.triggers).toEqual([expect.objectContaining({ name: 'orders_ai' })]);
      expect(table.triggers[0].definition).toContain('CREATE TRIGGER');
    });

  // The claim the fix rests on, measured rather than assumed: four pragmas answer,
  // one does not. If a future SQLite makes `trigger_list` work this test fails and
  // the note in `schema.js` can be corrected rather than the behaviour silently
  // diverging.
    test('four of the five pragmas answer, and trigger_list is the one that does not', async () => {
      const all = (sql) => new Promise((resolve) => db.all(sql, [], (err, rows) => resolve({ err, rows })));

      expect((await all('PRAGMA table_info("orders")')).rows).toHaveLength(3);
      expect((await all('PRAGMA foreign_key_list("orders")')).rows).toHaveLength(1);
      expect((await all('PRAGMA index_list("orders")')).rows).toHaveLength(2);
      expect((await all('PRAGMA index_info("idx_user")')).rows).toHaveLength(1);

      // No error, no rows: the silent failure mode, and the reason a test
      // asserting "no triggers" is worse than useless.
      const triggerList = await all('PRAGMA trigger_list("orders")');
      expect(triggerList.err).toBeFalsy();
      expect(triggerList.rows).toHaveLength(0);

      // …and the table-valued function does not exist at all, which is the error
      // this whole path was rewritten away from.
      const asFunction = await all('SELECT name FROM pragma_trigger_list("orders")');
      // The error is raised inside the native module, so it is an `Error` from
      // another realm and `toBeInstanceOf(Error)` is not the way to look at it.
      expect(String(asFunction.err && asFunction.err.message)).toMatch(/no such table: pragma_trigger_list/);
    });

    // The quoting form. `PRAGMA body("name")` is the only one that works, and
    // the difference is invisible in review.
    test('the body of a pragma is never itself quoted', async () => {
      const all = (sql) => new Promise((resolve) => db.all(sql, [], (err, rows) => resolve({ err, rows })));
      const good = await all('PRAGMA table_info("orders")');
      const doubled = await all('PRAGMA "table_info(""orders"")"');

      expect(good.err).toBeFalsy();
      expect(good.rows).toHaveLength(3);
      // Silently empty, and indistinguishable from a table with no columns.
      expect(doubled.err).toBeFalsy();
      expect(doubled.rows).toHaveLength(0);
    });
  });

});

// MongoDB

  /**
   * A pinned `Db`, which is what the schema adapter is handed. The driver exposes
   * it as `client.db(name)` — a **method** — so a double that put the Db on
   * `client.db` as a property made every assertion here pass against a shape the
   * real driver does not have.
   */
function mongoDb({ collections = [], stats = {}, indexes = [], documents = null } = {}) {
  // One collection double, reused, so a test can inspect what the adapter asked
  // the driver for rather than holding a fresh mock it never sees.
  const collection = {
    indexes: jest.fn(async () => indexes),
    find: jest.fn(() => ({
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue(documents ?? [])
    }))
  };
  return {
    databaseName: 'shop',
    listCollections: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(collections) })),
    command: jest.fn(async ({ collStats }) => {
      if (!(collStats in stats)) throw new Error(`ns does not exist: shop.${collStats}`);
      return { count: 42, size: 8192, storageSize: 4096, totalIndexSize: 1024, avgObjSize: 128, nindexes: 2, ...stats[collStats] };
    }),
    collection: jest.fn(() => collection)
  };
}

/** A `MongoClient` double: `db` is a method on it, as in the driver. */
function mongoClient(options) {
  const db = mongoDb(options);
  return {
    options: { dbName: 'shop' },
    db: Object.assign(jest.fn((name) => db), { databaseName: undefined }),
    pinned: db
  };
}

describe('MongoSchemaAdapter', () => {
  let adapter;
  let client;
  let db;

  const connect = (options) => {
    client = mongoClient(options);
    db = client.pinned;
    adapter = new MongoSchemaAdapter();
    adapter.client = client;
    adapter.db = db;
    return adapter;
  };

  test('lists collections with document counts and indexes', async () => {
    connect({
      collections: [{ name: 'orders' }, { name: 'users' }],
      stats: { orders: {}, users: {} },
      indexes: [{ name: '_id_', key: { _id: 1 }, unique: true }],
    });

    const out = await adapter.describe({});

    expect(out.database).toBe('mongodb');
    expect(out.databaseName).toBe('shop');
    expect(out.collections.map(c => c.name)).toEqual(['orders', 'users']);
    expect(out.collections[0].documents).toBe(42);
    expect(out.collections[0].indexes).toEqual([{ name: '_id_', key: { _id: 1 }, unique: true }]);
  });

  test('describes only the requested collection', async () => {
    connect({ collections: [{ name: 'users' }], stats: { users: {} }, indexes: [] });

    const out = await adapter.describe({ collection: 'users' });

    expect(db.listCollections).toHaveBeenCalledWith({ name: 'users' }, { nameOnly: false });
    expect(out.collections.map(c => c.name)).toEqual(['users']);
  });

  // A collection that does not exist and an empty one used to produce the same
  // confident-looking record, because safeStats swallowed the error.
  test('distinguishes a collection that does not exist from an empty one', async () => {
    connect({ collections: [], stats: {} });

    const out = await adapter.describe({ collection: 'nope' });

    expect(out.collections).toEqual([]);
    expect(out.collectionNotFound).toBe('nope');
  });

  test('still lists a collection whose stats cannot be read, and says why', async () => {
    connect({ collections: [{ name: 'orders' }], stats: {}, indexes: [] });

    const out = await adapter.describe({});

    expect(out.collections[0].documents).toBeNull();
    expect(out.collections[0].statsError).toMatch(/ns does not exist/);
  });

    test('still lists a collection whose indexes cannot be read', async () => {
      connect({ collections: [{ name: 'orders' }], stats: { orders: {} } });
      db.collection('c').indexes = jest.fn().mockRejectedValue(new Error('not authorized'));

      const out = await adapter.describe({});

      expect(out.collections[0].indexes).toEqual([]);
    });

  test('paginates', async () => {
    connect({ collections: [{ name: 'a' }, { name: 'b' }], stats: { a: {}, b: {} }, indexes: [] });

    const out = await adapter.describe({ limit: 1 });

    expect(out.collections).toHaveLength(1);
    expect(out.page).toMatchObject({ limit: 1, hasMore: true, nextOffset: 1 });
  });

  test('reads the pinned database name, or null rather than a guess', async () => {
    connect({ collections: [], stats: {} });
    client.options = {};
    db.databaseName = undefined;

    const out = await adapter.describe({});

    expect(out.databaseName).toBeNull();
  });

  describe('detail: full', () => {
    test('infers field names, types and nesting from a bounded sample', async () => {
      // MongoDB has no catalogue of a document's fields, which is the exact
      // problem db_schema exists to solve.
      connect({
        collections: [{ name: 'orders' }],
        stats: { orders: {} },
        indexes: [],
        documents: [
          { ref: 'A-1', total: 10, placedAt: new Date('2026-01-01'), customer: { id: 7, name: 'Ada' } },
          { ref: 'A-2', total: 20.5, customer: { id: 8, tags: ['a', 'b'] } },
        ],
      });

      const out = await adapter.describe({ detail: 'full' });
      const byName = Object.fromEntries(out.collections[0].fields.map(f => [f.name, f]));

      expect(byName['customer.id']).toMatchObject({ types: ['int'], presentIn: 2 });
      expect(byName['customer.tags[]']).toMatchObject({ types: ['string'] });
      expect(byName.total.types).toEqual(['double', 'int']);
      expect(byName.placedAt.types).toEqual(['date']);
    });

    test('reports the sampling cap, because an inferred schema is a claim about a sample', async () => {
      connect({
        collections: [{ name: 'orders' }],
        stats: { orders: {} },
        indexes: [],
        documents: Array.from({ length: 200 }, (_, i) => ({ i })),
      });

      const out = await adapter.describe({ detail: 'full' });

      expect(db.collection('c').find.mock.results[0].value.limit).toHaveBeenCalledWith(50);
      expect(out.collections[0].fields).toHaveLength(1);
    });

    test('reports a null field as a type rather than dropping it', async () => {
      connect({
        collections: [{ name: 'orders' }], stats: { orders: {} }, indexes: [],
        documents: [{ note: null, n: 1 }],
      });

      const out = await adapter.describe({ detail: 'full' });

      expect(out.collections[0].fields.find(f => f.name === 'note').types).toEqual(['null']);
    });

    test('reports capped, timeseries, sizes and full index detail', async () => {
      connect({
        collections: [{
          name: 'events', type: 'timeseries', options: { timeseries: true },
        }, {
          name: 'logs', type: 'collection', options: { capped: true, size: 4096, max: 100 },
        }],
        stats: { events: { storageSize: 2048, totalIndexSize: 0, avgObjSize: 64, nindexes: 1 }, logs: {} },
        indexes: [
          { name: '_id_', key: { _id: 1 }, unique: true },
          { name: 'at_ttl', key: { at: 1 }, expireAfterSeconds: 0, sparse: true },
          { name: 'geo', key: { loc: '2dsphere' } },
          { name: 'partial', key: { state: 1 }, partialFilterExpression: { state: { $eq: 'open' } } },
        ],
      });

      const out = await adapter.describe({ detail: 'full' });
      const events = out.collections.find(c => c.name === 'events');
      const logs = out.collections.find(c => c.name === 'logs');

      expect(events.timeseries).toBe(true);
      expect(events.storageSizeBytes).toBe(2048);
      expect(logs.capped).toBe(true);
      expect(logs.sizeBytes).toBe(4096);
      expect(logs.maxDocuments).toBe(100);

      const byName = Object.fromEntries(events.indexes.map(i => [i.name, i]));
      // `expireAfterSeconds: 0` on a date field is a schema fact no model infers
      // from `unique: true`.
      expect(byName.at_ttl).toMatchObject({ expireAfterSeconds: 0, sparse: true });
      expect(byName.geo.kind).toBe('geospatial');
      expect(byName.partial.partialFilterExpression).toEqual({ state: { $eq: 'open' } });
    });

    test('samples no fields at the summary level', async () => {
      connect({ collections: [{ name: 'orders' }], stats: { orders: {} }, indexes: [], documents: [{ a: 1 }] });

      await adapter.describe({});

      expect(db.collection('c').find).not.toHaveBeenCalled();
    });
  });
});

// Redis

describe('parseInfo', () => {
  // `client.info()` hands back the server's VerbatimStringReply verbatim
  // (`transformReply: undefined` in the driver's INFO command). The keyspace parse
  // treated the reply as a parsed object, so `Object.entries("db0:keys=12,…")`
  // produced one entry per character and the keyspace was empty on every server.
  test('parses the raw INFO wire format', () => {
    const parsed = parseInfo(
      '# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n\r\n# Keyspace\r\ndb0:keys=12,expires=3,avg_ttl=45000\r\ndb1:keys=1,expires=0,avg_ttl=0\r\n'
    );

    expect(parsed.Server).toEqual({ redis_version: '7.2.4', redis_mode: 'standalone' });
    expect(parsed.Keyspace).toEqual({
      db0: 'keys=12,expires=3,avg_ttl=45000',
      db1: 'keys=1,expires=0,avg_ttl=0',
    });
  });

  test('survives an empty or absent reply', () => {
    expect(parseInfo('')).toEqual({});
    expect(parseInfo(undefined)).toEqual({});
  });
});

describe('RedisSchemaAdapter', () => {
  let adapter;
  let client;

  const INFO = {
    server: '# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n',
    keyspace: '# Keyspace\r\ndb0:keys=12,expires=3,avg_ttl=45000\r\ndb1:keys=1,expires=0,avg_ttl=0\r\n',
    memory: '# Memory\r\nused_memory:1024\r\nused_memory_human:1.00K\r\nmaxmemory_policy:noeviction\r\n',
    replication: '# Replication\r\nrole:master\r\nconnected_slaves:2\r\n',
  };

  const connect = ({ keys = [], types = {}, values = {}, info = {} } = {}) => {
    const replies = { ...INFO, ...info };
    client = {
      info: jest.fn(async (section) => replies[section] ?? ''),
      // node-redis 6.x yields a PAGE per iteration, not a key.
      scanIterator: jest.fn(() => (async function* () {
        for (const key of keys) yield [key];
      })()),
      hScanIterator: jest.fn(() => (async function* () {})()),
      type: jest.fn(async (key) => types[key] ?? 'none'),
      ttl: jest.fn(async () => -1),
      get: jest.fn(async (key) => values[key] ?? null),
      xLen: jest.fn(async () => 0),
      sendCommand: jest.fn(async () => 0)
    };
    adapter = new RedisSchemaAdapter();
    adapter.client = client;
    return adapter;
  };

  test('parses the keyspace section as the raw string node-redis returns', async () => {
    connect({ keys: ['user:1', 'user:2'] });

    const out = await adapter.describe({});

    expect(out.database).toBe('redis');
    expect(out.version).toBe('7.2.4');
    expect(out.mode).toBe('standalone');
    expect(out.keyspace).toEqual({
      db0: { keys: 12, expires: 3, avgTtl: 45000 },
      db1: { keys: 1, expires: 0, avgTtl: 0 },
    });
  });

  test('flattens the pages SCAN yields, not the pages themselves', async () => {
    connect({ keys: ['a', 'b', 'c'] });

    const out = await adapter.describe({});

    expect(out.sampleKeys).toEqual(['a', 'b', 'c']);
  });

  test('degrades to an empty report when INFO is refused', async () => {
    connect();
    client.info = jest.fn().mockRejectedValue(new Error('NOPERM'));

    const out = await adapter.describe({});

    expect(out.keyspace).toEqual({});
    expect(out.version).toBeNull();
    expect(out.sampleKeys).toEqual([]);
    expect(out.note).toMatch(/schemaless/);
  });

  test('caps the key sample', async () => {
    connect({ keys: Array.from({ length: 200 }, (_, i) => `key:${i}`) });

    const out = await adapter.describe({});

    expect(out.sampleKeys).toHaveLength(20);
  });

  // `table`, `collection` and the sample size used to be silently ignored for
  // Redis even though the tool advertises them for every database.
  test('answers a table — a key — instead of ignoring it', async () => {
    connect({ types: { 'user:1': 'hash' } });
    client.hScanIterator = jest.fn(() => (async function* () {
      yield [{ field: 'name', value: 'Ada' }];
    })());
    client.sendCommand = jest.fn(async () => 256);

    const out = await adapter.describe({ table: 'user:1' });

    expect(out.key).toMatchObject({ name: 'user:1', type: 'hash', ttlSeconds: -1, memoryBytes: 256 });
    expect(out.key.sample).toEqual([{ field: 'name', value: 'Ada' }]);
  });

  test('accepts `collection` as the same word the tool uses for MongoDB', async () => {
    connect({ types: { 'a:b': 'string' }, values: { 'a:b': 'hello' } });

    const out = await adapter.describe({ collection: 'a:b' });

    expect(out.key).toMatchObject({ name: 'a:b', type: 'string', value: 'hello' });
  });

  test('pages a set rather than returning all of it', async () => {
    connect({ types: { s: 'set' } });
    client.sendCommand = jest.fn(async () => ['a', 'b', 'c']);

    const out = await adapter.describe({ table: 's', maxRows: 2 });

    expect(client.sendCommand).toHaveBeenCalledWith(['SMEMBERS', 's']);
    expect(out.key.sample).toEqual(['a', 'b']);
  });

  describe('detail: full', () => {
    test('counts key types, which is what a Redis schema is', async () => {
      connect({ keys: ['a', 'b', 'c'], types: { a: 'string', b: 'hash', c: 'string' } });

      const out = await adapter.describe({ detail: 'full' });

      expect(out.keyTypes).toEqual({ counts: { string: 2, hash: 1 }, sampled: 3, complete: true });
    });

    test('reports memory and replication', async () => {
      connect();

      const out = await adapter.describe({ detail: 'full' });

      expect(out.memory).toMatchObject({ used_memory: 1024, maxmemory_policy: 'noeviction' });
      expect(out.replication).toMatchObject({ role: 'master', connected_slaves: 2 });
    });

    test('asks for none of it at the summary level', async () => {
      connect();

      await adapter.describe({});

      expect(client.info).toHaveBeenCalledTimes(2);
    });
  });

  test('rejects an unrecognised detail', async () => {
    connect();
    await expect(adapter.describe({ detail: 'lots' })).rejects.toThrow("'detail' must be one of");
  });
});
