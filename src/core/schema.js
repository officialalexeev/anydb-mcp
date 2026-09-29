import { BaseAdapter } from '../core/base-adapter.js';
import { callbackWithTimeout } from '../core/timeout-utils.js';

/**
 * Reports the shape of a database so a caller can write a correct query without
 * probing for table and column names. Everything here is a read, and each
 * statement is bounded.
 *
 * Two detail levels. `summary` (the default) answers "what is in here": names,
 * types, nullability, in two round trips. `full` adds what is needed to write a
 * *correct* query rather than a merely valid one: foreign keys, index definitions
 * with names and column order, primary/unique/check constraints, approximate row
 * counts and, for MongoDB, field names and types inferred from a sample.
 *
 * The split is not cosmetic: full introspection of a 500-table database is several
 * extra round trips per table, and making every caller pay for it means most never
 * call it at all.
 */
export class SchemaAdapter extends BaseAdapter {
  async describe(options = {}) {
    throw new Error('describe() is not implemented');
  }

  /**
   * Turn a driver error into something a caller can act on.
   *
   * Every adapter assigns its own `describeError` onto the instance it builds in
   * `describe(options)`, so `db_schema` reports what `db_query` reports. The
   * default below is what a directly-constructed adapter gets.
   */
  describeError(err) {
    const detail = (err && err.message) || String(err);
    return new Error(`[${this.databaseName} schema] ${detail}`);
  }
}

/** How many objects one page of a description carries. */
const MAX_TABLES = 500;

/**
 * Columns per object. A table with 4 000 columns is a log, not a table, and a
 * reader of 4 000 column names has learned nothing. MongoDB has no per-object
 * column query, so this cap is not applied on that path.
 */
const MAX_COLUMNS_PER_TABLE = 100;

/** One extra column per object, fetched so the report can say which were cut. */
const COLUMN_PROBE = 1;

const DETAIL_LEVELS = ['summary', 'full'];
const DEFAULT_DETAIL = 'summary';

/** How many per-object round trips may be in flight at once. */
const FAN_OUT = Math.min(32, positiveInt(process.env.ANYDB_SCHEMA_FAN_OUT, 8));

/**
 * `detail`, validated.
 *
 * An unrecognised level is an argument error rather than a silent default: a
 * caller who asked for `'full'` and got `'summary'` would read a schema with no
 * foreign keys as one that has none.
 */
function readDetail(options = {}) {
  const detail = options.detail === undefined || options.detail === null ? DEFAULT_DETAIL : options.detail;
  if (typeof detail !== 'string' || !DETAIL_LEVELS.includes(detail)) {
    throw new Error(
      `'detail' must be one of ${DETAIL_LEVELS.map((d) => `"${d}"`).join(', ')}, got ${JSON.stringify(detail)}. `
      + '"full" adds foreign keys, indexes, constraints, row estimates and, for MongoDB, sampled field schemas.'
    );
  }
  return detail;
}

/**
 * Pagination. `limit` sets the page size and is itself capped at MAX_TABLES, so a
 * page cannot become the thing the cap exists to prevent; `offset` skips objects;
 * `page` is the 1-based page number. `offset` wins if both are given, because it
 * is the unambiguous one.
 *
 * Every value is coerced to a whole non-negative number here, which is what makes
 * it safe to interpolate into LIMIT/OFFSET below. An adapter is reachable without
 * the registry, and a `LIMIT '1; DROP TABLE t'` in a catalogue query would be a
 * very stupid way to lose an argument.
 */
function readPaging(options = {}) {
  const asCount = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };

  const limit = Math.min(asCount(options.limit, MAX_TABLES) || MAX_TABLES, MAX_TABLES);
  const explicitOffset = asCount(options.offset, 0);
  const page = Math.max(1, asCount(options.page, 1));
  const offset = explicitOffset > 0 ? explicitOffset : (page - 1) * limit;

  return { limit, offset, page: Math.floor(offset / limit) + 1 };
}

/**
 * How the page was cut, reported on every description.
 *
 * `truncated` is true only when something was actually left out. The honest test
 * is whether one more row came back, which is why every listing fetches
 * `limit + 1`; a test like `rows.length >= MAX_TABLES` reports truncation for a
 * database with exactly 500 tables, which is a lie the reader then acts on.
 */
function pageReport(paging, returned, hasMore, extra = {}) {
  return {
    truncated: hasMore === true || extra.truncated === true,
    page: {
      limit: paging.limit,
      offset: paging.offset,
      page: paging.page,
      returned,
      hasMore: hasMore === true,
      nextOffset: hasMore === true ? paging.offset + returned : null,
    },
    ...extra,
  };
}

/** Split a `limit + 1` fetch into the page and the "there is more" flag. */
function splitPage(rows, paging) {
  const hasMore = rows.length > paging.limit;
  return { page: hasMore ? rows.slice(0, paging.limit) : rows, hasMore };
}

/**
 * Run `worker` over `items`, at most `limit` at a time.
 *
 * Neither driver has a batch call, so concurrency is the only lever against the
 * N+1 loops below. The bound matters as much as the concurrency: unbounded
 * fan-out against one server is the socket storm the pool sizes exist to prevent.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A `bigint` column as a number, or as its string when the number would lie.
 *
 * `pg` deliberately hands `int8` back as a string so a value beyond
 * `Number.MAX_SAFE_INTEGER` cannot be silently rounded, and `pg_total_relation_size`
 * is `int8`. The string is kept whenever the conversion is not exact, and a
 * relation measured in petabytes is the only place that happens in practice.
 */
function bigIntAsNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  const text = value.trim();
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return text;
  return n;
}

/**
 * Schemas that belong to the server, not to the user.
 *
 * `NOT LIKE 'pg\_%'` covers `pg_catalog`, `pg_toast`, every `pg_temp_n` and
 * `pg_my_temp_schema`; `information_schema` is named separately because it does
 * not begin with `pg_`. Leaving the `pg_` families in reported a `pg_temp_3`
 * schema of columns as though it were the user's data.
 */
const PG_USER_SCHEMA = `n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'`;

const PG_REL_KINDS = `('r', 'p', 'v', 'm', 'f')`;

const PG_TABLE_TYPE = `CASE c.relkind
       WHEN 'r' THEN 'BASE TABLE' WHEN 'p' THEN 'PARTITIONED TABLE'
       WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
       WHEN 'f' THEN 'FOREIGN TABLE' ELSE c.relkind::text END`;

export class PostgresSchemaAdapter extends SchemaAdapter {
  constructor(connectTimeout = 5000, queryTimeout = 30000) {
    super(connectTimeout, queryTimeout);
    this.pool = null;
    this.databaseName = 'Postgres';
  }

  /**
   * Run one catalogue statement, with a server-side bound and a friendly error.
   *
   * `statement_timeout` is a **session** setting, so `SET` and the statement have
   * to reach the same backend: two `pool.query()` calls can be handed two
   * different clients, and then the catalogue scan runs unbounded. This takes a
   * client from the pool for exactly that reason.
   */
  async run(sql, params = []) {
    const pool = this.pool;
    if (!pool) throw new Error('[Postgres schema] no connection is attached');

    if (typeof pool.connect !== 'function') {
      // A pool that cannot hand out clients cannot be given a session setting.
      // Everything still runs; the bound is the registry's, not the server's.
      const res = await pool.query(sql, params);
      return [res.rows];
    }

    const client = await pool.connect();
    try {
      await client.query(`SET statement_timeout = ${pgStatementTimeout(this.queryTimeout)}`);
      const res = await client.query(sql, params);
      return [res.rows];
    } catch (err) {
      throw this.describeError(err);
    } finally {
      client.release?.();
    }
  }

  async describe(options = {}) {
    const detail = readDetail(options);
    const paging = readPaging(options);
    const table = typeof options.table === 'string' && options.table !== '' ? options.table : null;

    // The non-system schemas are worth having on every call, and they cost one
    // cheap query, so they run alongside the page rather than after it.
    const schemas = this.schemas().catch(() => null);

    // The page of relations. `limit + 1`, so `truncated` is a fact and not a
    // guess about the cap.
    const [tableRows] = await this.run(
      `SELECT n.nspname AS table_schema,
              c.relname AS table_name,
              ${PG_TABLE_TYPE} AS table_type,
              pg_catalog.pg_get_viewdef(c.oid, true) AS view_definition,
              c.reltuples::bigint AS approximate_rows,
              pg_catalog.pg_total_relation_size(c.oid) AS size_bytes
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ${PG_REL_KINDS}
          AND ${PG_USER_SCHEMA}
          ${table ? 'AND c.relname = $1' : ''}
        ORDER BY n.nspname, c.relname
        LIMIT $${table ? 2 : 1} OFFSET $${table ? 3 : 2}`,
      [...(table ? [table] : []), paging.limit + 1, paging.offset]
    );

    const { page: relations, hasMore } = splitPage(tableRows, paging);

    if (relations.length === 0) {
      return {
        database: 'postgresql',
        detail,
        schemas: await schemas,
        tables: [],
        ...pageReport(paging, 0, hasMore),
      };
    }

    const scope = relationScope(relations);
    const wide = detail === 'full' ? this.describeFull(relations, scope, paging) : Promise.resolve(new Map());

    const [columnRows] = await this.run(
      `SELECT n.nspname AS table_schema,
              c.relname AS table_name,
              a.attname AS column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
              t.typname AS udt_name,
              NOT a.attnotnull AS is_nullable,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS column_default,
              a.attidentity <> '' AS is_identity,
              a.attgenerated <> '' AS is_generated,
              a.attnum AS ordinal_position
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attnum > 0
          AND NOT a.attisdropped
          AND c.relkind IN ${PG_REL_KINDS}
          AND ${PG_USER_SCHEMA}
          AND ${scope.clause}
        ORDER BY n.nspname, c.relname, a.attnum
        LIMIT $${scope.from}`,
      [...scope.params, columnRowLimit(paging)]
    );

    const [columns, wideByTable, schemaNames] = await Promise.all([
      Promise.resolve(groupByRelation(columnRows, MAX_COLUMNS_PER_TABLE)),
      wide,
      schemas,
    ]);

    const tables = relations.map((r) => {
      const key = tableKey(r.table_schema, r.table_name);
      const group = columns.get(key) ?? { rows: [], truncated: false };
      const out = {
        name: r.table_name,
        schema: r.table_schema,
        type: r.table_type,
        columns: group.rows.map(pgColumn),
      };
      if (group.truncated) out.columnsTruncated = true;
      // A view's text is the cheapest way to say what it actually selects, and
      // `pg_get_viewdef` is a column the relations query already has.
      if (r.view_definition) out.definition = r.view_definition;
      // `reltuples` is the planner's estimate, so it is labelled approximate, and
      // `-1` is its own documented "never analysed" answer, not a count of -1.
      const approximateRows = bigIntAsNumber(r.approximate_rows);
      if (approximateRows !== null && approximateRows >= 0) out.approximateRows = approximateRows;
      const sizeBytes = bigIntAsNumber(r.size_bytes);
      if (sizeBytes !== null) out.sizeBytes = sizeBytes;
      Object.assign(out, wideByTable.get(key) ?? {});
      return out;
    });

    const columnTruncated = [...columns.values()].some((g) => g.truncated);
    const databaseWide = detail === 'full' ? await this.postgresWideCatalogue() : {};

    return {
      database: 'postgresql',
      detail,
      schemas: schemaNames,
      tables,
      ...pageReport(paging, tables.length, hasMore, {
        truncated: hasMore || columnTruncated,
        ...databaseWide,
      }),
    };
  }

  /** The non-system schemas, so a model can see where it is allowed to look. */
  async schemas() {
    const [rows] = await this.run(
      `SELECT nspname AS name FROM pg_catalog.pg_namespace
        WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%'
        ORDER BY nspname`
    );
    return rows.map((r) => r.name);
  }

  /**
   * Constraints and indexes: two round trips, issued together. `pg_constraint`
   * carries primary keys, foreign keys, unique and check constraints behind a
   * `contype` discriminator, so four catalogue queries become one.
   */
  async describeFull(relations, scope, paging) {
    const [constraints, indexes] = await Promise.all([
      this.run(
        `SELECT n.nspname AS table_schema,
                c.relname AS table_name,
                con.conname AS name,
                con.contype AS kind,
                pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
                (SELECT array_agg(a.attname ORDER BY k.ord)
                   FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_catalog.pg_attribute a
                     ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
                rn.nspname AS referenced_schema,
                rc.relname AS referenced_table,
                (SELECT array_agg(a.attname ORDER BY k.ord)
                   FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_catalog.pg_attribute a
                     ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS referenced_columns,
                con.confdeltype AS on_delete,
                con.confupdtype AS on_update
           FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
           LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
          WHERE con.contype IN ('p', 'f', 'u', 'c')
            AND ${PG_USER_SCHEMA}
            AND ${scope.clause}
          ORDER BY n.nspname, c.relname, con.conname
          LIMIT $${scope.from}`,
        [...scope.params, columnRowLimit(paging)]
      ),
      this.run(
        `SELECT n.nspname AS table_schema,
                c.relname AS table_name,
                ic.relname AS name,
                i.indisunique AS is_unique,
                i.indisprimary AS is_primary,
                am.amname AS method,
                pg_catalog.pg_get_indexdef(i.indexrelid, 0, true) AS definition,
                (SELECT array_agg(a.attname ORDER BY k.ord)
                   FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_catalog.pg_attribute a
                     ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns,
                pg_catalog.pg_relation_size(i.indexrelid) AS size_bytes
           FROM pg_catalog.pg_index i
           JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_catalog.pg_am am ON am.oid = ic.relam
          WHERE ${PG_USER_SCHEMA}
            AND ${scope.clause}
          ORDER BY n.nspname, c.relname, ic.relname
          LIMIT $${scope.from}`,
        [...scope.params, columnRowLimit(paging)]
      ),
    ]);

    const byTable = new Map();
    const slot = (row) => {
      const key = tableKey(row.table_schema, row.table_name);
      if (!byTable.has(key)) byTable.set(key, {});
      return byTable.get(key);
    };

    for (const con of constraints[0]) {
      const entry = slot(con);
      const definition = { name: con.name, columns: con.columns ?? [], definition: con.definition ?? null };
      if (con.kind === 'p') (entry.primaryKey ??= []).push(definition);
      else if (con.kind === 'u') (entry.unique ??= []).push(definition);
      else if (con.kind === 'c') (entry.checks ??= []).push(definition);
      else if (con.kind === 'f') {
        (entry.foreignKeys ??= []).push({
          ...definition,
          referencedTable: con.referenced_table ?? null,
          referencedSchema: con.referenced_schema ?? null,
          referencedColumns: con.referenced_columns ?? [],
          onUpdate: FK_ACTIONS[con.on_update] ?? null,
          onDelete: FK_ACTIONS[con.on_delete] ?? null,
        });
      }
    }

    for (const idx of indexes[0]) {
      (slot(idx).indexes ??= []).push({
        name: idx.name,
        columns: idx.columns ?? [],
        unique: idx.is_unique === true,
        primary: idx.is_primary === true,
        method: idx.method ?? null,
        definition: idx.definition ?? null,
        sizeBytes: bigIntAsNumber(idx.size_bytes),
      });
    }

    return byTable;
  }

  /** Sequences and triggers, which are database-wide rather than per table. */
  async postgresWideCatalogue() {
    const [sequences, triggers] = await Promise.all([
      this.run(
        `SELECT n.nspname AS schema, c.relname AS name,
                s.seqtypid::regtype::text AS data_type,
                s.seqstart AS start_value, s.seqincrement AS increment_by,
                s.seqmin AS min_value, s.seqmax AS max_value,
                s.seqcycle AS cycle, s.seqcache AS cache
           FROM pg_catalog.pg_sequence s
           JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE ${PG_USER_SCHEMA}
          ORDER BY n.nspname, c.relname
          LIMIT ${MAX_TABLES}`
      ).catch(() => [[]]),
      this.run(
        `SELECT n.nspname AS schema, c.relname AS table_name, t.tgname AS name,
                pg_catalog.pg_get_triggerdef(t.oid, true) AS definition,
                t.tgenabled <> 'D' AS enabled
           FROM pg_catalog.pg_trigger t
           JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT t.tgisinternal
            AND ${PG_USER_SCHEMA}
          ORDER BY n.nspname, c.relname, t.tgname
          LIMIT ${MAX_TABLES}`
      ).catch(() => [[]]),
    ]);

    return {
      sequences: sequences[0].map((s) => ({
        name: s.name,
        schema: s.schema,
        dataType: s.data_type,
        start: numberOrNull(s.start_value),
        increment: numberOrNull(s.increment_by),
        min: numberOrNull(s.min_value),
        max: numberOrNull(s.max_value),
        cycle: s.cycle === true,
        cache: numberOrNull(s.cache),
      })),
      triggers: triggers[0].map((t) => ({
        name: t.name,
        table: t.table_name,
        schema: t.schema,
        definition: t.definition,
        enabled: t.enabled === true,
      })),
    };
  }
}

/** `con.confdeltype` / `con.confupdtype`, which are single characters. */
const FK_ACTIONS = {
  a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT',
};

/**
 * How many rows a per-relation column query may fetch.
 *
 * `limit + 1` relations, each allowed `MAX_COLUMNS_PER_TABLE + 1` columns. The
 * extra column per relation is what lets the report name the tables that were
 * cut. The ordering is what makes the arithmetic hold: rows are grouped by
 * relation before they are limited, so a relation cannot eat another's budget.
 */
function columnRowLimit(paging) {
  return (paging.limit + 1) * (MAX_COLUMNS_PER_TABLE + COLUMN_PROBE);
}

/** `(schema, name)` as one comparable string. A NUL cannot occur in either. */
function tableKey(schema, name) {
  return `${schema} ${name}`;
}

/**
 * A `WHERE` fragment restricting a follow-up query to the relations on this
 * page, as row-value tuples of bound parameters.
 *
 * The tuple form is what keeps this correct rather than merely compact: an `IN`
 * over two parallel arrays would match every combination, so `public.users` and
 * `auth.users` would drag in each other's rows again. Nothing is interpolated
 * into the SQL text — only the *shape* of the tuple list is, and the number of
 * `$n` slots is arithmetic, not input.
 */
function relationScope(relations) {
  const tuples = [];
  const params = [];
  for (const r of relations) {
    tuples.push(`($${params.length + 1}, $${params.length + 2})`);
    params.push(r.table_schema, r.table_name);
  }
  return {
    clause: tuples.length ? `(n.nspname, c.relname) IN (${tuples.join(', ')})` : 'FALSE',
    params,
    from: params.length + 1,
  };
}

/**
 * Group rows by their (schema, table) pair and apply the per-table cap.
 *
 * The schema is part of the key, not decoration: matching on the table name alone
 * made `public.users` and `auth.users` each carry the union of both tables'
 * columns — a silent, wrong answer produced by a comparison that never looked at
 * the schema the relations query had already returned.
 */
function groupByRelation(rows, cap) {
  const groups = new Map();
  for (const row of rows) {
    const key = tableKey(row.table_schema, row.table_name);
    let group = groups.get(key);
    if (!group) {
      group = { rows: [], truncated: false };
      groups.set(key, group);
    }
    if (group.rows.length < cap + COLUMN_PROBE) group.rows.push(row);
    else group.truncated = true;
  }
  for (const group of groups.values()) {
    if (group.rows.length > cap) {
      group.rows = group.rows.slice(0, cap);
      group.truncated = true;
    }
  }
  return groups;
}

function pgColumn(c) {
  return {
    name: c.column_name,
    // `format_type` is what the server itself would print: `character
    // varying(80)`, `integer[]`, `timestamp with time zone`. `information_schema`
    // reports all three as `ARRAY` or `USER-DEFINED`, which describes the storage
    // rather than the type.
    type: c.data_type,
    // …and `udt_name` is the underlying type name, the one thing that names an
    // enum (`mood`) or a domain instead of calling it "user-defined".
    udtName: c.udt_name ?? null,    nullable: c.is_nullable === true || c.is_nullable === 'YES',
    default: c.column_default ?? null,
    ...(c.is_identity === true ? { identity: true } : {}),
    ...(c.is_generated === true ? { generated: 'STORED' } : {}),
  };
}

/** Whole milliseconds, or 0, which is the only value that is valid SQL. */
function pgStatementTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return 0;
  return Math.trunc(timeoutMs);
}

export class MySQLSchemaAdapter extends SchemaAdapter {
  constructor(connectTimeout = 5000, queryTimeout = 30000) {
    super(connectTimeout, queryTimeout);
    this.pool = null;
    this.databaseName = 'MySQL';
  }

  /**
   * Run one catalogue statement, with a client-side bound.
   *
   * mysql2 applies no timeout to `pool.query()`, and a `MAX_EXECUTION_TIME` hint on
   * an `information_schema` scan is a hint MySQL may ignore and MariaDB does. So
   * this takes a connection of its own and uses the driver form that does carry
   * one: `query({ sql, values, timeout })`.
   */
  async query(sql, params = []) {
    const pool = this.pool;
    if (!pool) throw new Error('[MySQL schema] no connection is attached');

    if (typeof pool.getConnection !== 'function') {
      const [rows] = await pool.query(sql, params);
      return [rows];
    }

    const conn = await pool.getConnection();
    try {
      const rows = await new Promise((resolve, reject) => {
        conn.connection.query(
          { sql, values: params, timeout: mySqlTimeout(this.queryTimeout) },
          (err, result) => (err ? reject(err) : resolve(result))
        );
      });
      return [rows];
    } catch (err) {
      throw this.describeError(err);
    } finally {
      pool.releaseConnection?.(conn);
    }
  }

  async describe(options = {}) {
    const detail = readDetail(options);
    const paging = readPaging(options);
    const table = typeof options.table === 'string' && options.table !== '' ? options.table : null;

    const version = this.version().catch(() => null);

    const [tableRows] = await this.query(
      `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, ENGINE, TABLE_COLLATION,
              TABLE_COMMENT
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          ${table ? 'AND TABLE_NAME = ?' : ''}
        ORDER BY TABLE_NAME
        LIMIT ? OFFSET ?`,
      [...(table ? [table] : []), paging.limit + 1, paging.offset]
    );

    const { page: tables, hasMore } = splitPage(tableRows, paging);

    if (tables.length === 0) {
      return {
        database: 'mysql',
        detail,
        version: await version,
        tables: [],
        ...pageReport(paging, 0, hasMore),
      };
    }

    const names = tables.map((t) => t.TABLE_NAME);
    const placeholders = names.map(() => '?').join(', ');
    const wideByTable = detail === 'full' ? this.mysqlWideCatalogue(names) : Promise.resolve(new Map());

    const [columnRows] = await this.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY,
              COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, GENERATION_EXPRESSION,
              CHARACTER_SET_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN (${placeholders})
        ORDER BY TABLE_NAME, ORDINAL_POSITION
        LIMIT ?`,
      [...names, columnRowLimit(paging)]
    );

    const [columns, wide, serverVersion] = await Promise.all([
      Promise.resolve(groupByMysqlTable(columnRows, MAX_COLUMNS_PER_TABLE)),
      wideByTable,
      version,
    ]);

    return {
      database: 'mysql',
      detail,
      version: serverVersion,
      tables: tables.map((t) => {
        const key = tableKey('DATABASE()', t.TABLE_NAME);
        const group = columns.get(key) ?? { rows: [], truncated: false };
        const out = {
          name: t.TABLE_NAME,
          type: t.TABLE_TYPE,
          engine: t.ENGINE ?? null,
          // Free: the tables query already returns it. (The Postgres path puts
          // its equivalent in `full`, because getting it there needs a `pg_class`
          // join the summary does not otherwise make.)
          approximateRows: numberOrNull(t.TABLE_ROWS),
          columns: group.rows.map(mysqlColumn),
        };
        if (group.truncated) out.columnsTruncated = true;
        if (t.TABLE_COMMENT) out.comment = t.TABLE_COMMENT;
        if (t.TABLE_COLLATION) out.collation = t.TABLE_COLLATION;
        Object.assign(out, wide.get(key) ?? {});
        return out;
      }),
      ...pageReport(paging, tables.length, hasMore, {
        truncated: hasMore || [...columns.values()].some((g) => g.truncated),
      }),
    };
  }

  async version() {
    const [rows] = await this.query('SELECT VERSION() AS version');
    return rows[0]?.version ?? null;
  }

  /** Indexes, foreign keys and check constraints: three queries, issued together. */
  async mysqlWideCatalogue(names) {
    const placeholders = names.map(() => '?').join(', ');
    const scoped = `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`;

    const [indexRows, fkRows, checkRows] = await Promise.all([
      this.query(
        `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
                INDEX_TYPE, EXPRESSION, COMMENT
           FROM information_schema.STATISTICS
           ${scoped}
          ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        names
      ).catch(() => [[]]),
      this.query(
        `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION,
                k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
                r.UPDATE_RULE, r.DELETE_RULE
           FROM information_schema.KEY_COLUMN_USAGE k
           LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
             ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
            AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
            AND r.TABLE_NAME = k.TABLE_NAME
          ${scoped}
            AND k.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        names
      ).catch(() => [[]]),
      this.query(
        `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, c.CHECK_CLAUSE
           FROM information_schema.TABLE_CONSTRAINTS k
           JOIN information_schema.CHECK_CONSTRAINTS c
             ON c.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
            AND c.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          ${scoped}
            AND k.CONSTRAINT_TYPE = 'CHECK'
          ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME`,
        names
      ).catch(() => [[]]),
    ]);

    const byTable = new Map();
    const slot = (name) => {
      const key = tableKey('DATABASE()', name);
      if (!byTable.has(key)) byTable.set(key, {});
      return byTable.get(key);
    };

    // STATISTICS is one row per index *column*, so an index is rebuilt from its
    // rows in order. `NON_UNIQUE` is 0 for a unique index, including PRIMARY.
    const indexes = new Map();
    for (const row of indexRows[0]) {
      const id = `${row.TABLE_NAME} ${row.INDEX_NAME}`;
      if (!indexes.has(id)) {
        const index = {
          name: row.INDEX_NAME,
          columns: [],
          unique: String(row.NON_UNIQUE) === '0',
          method: row.INDEX_TYPE ?? null,
          ...(row.COMMENT ? { comment: row.COMMENT } : {}),
          // A functional index has no column; its expression is the index.
          ...(row.EXPRESSION ? { expression: row.EXPRESSION } : {}),
        };
        indexes.set(id, index);
        (slot(row.TABLE_NAME).indexes ??= []).push(index);
      }
      if (row.COLUMN_NAME) indexes.get(id).columns.push(row.COLUMN_NAME);
    }

    const foreignKeys = new Map();
    for (const row of fkRows[0]) {
      const id = `${row.TABLE_NAME} ${row.CONSTRAINT_NAME}`;
      if (!foreignKeys.has(id)) {
        const fk = {
          name: row.CONSTRAINT_NAME,
          columns: [],
          referencedTable: row.REFERENCED_TABLE_NAME ?? null,
          referencedColumns: [],
          onUpdate: row.UPDATE_RULE ?? null,
          onDelete: row.DELETE_RULE ?? null,
        };
        foreignKeys.set(id, fk);
        (slot(row.TABLE_NAME).foreignKeys ??= []).push(fk);
      }
      const target = foreignKeys.get(id);
      if (row.COLUMN_NAME) target.columns.push(row.COLUMN_NAME);
      if (row.REFERENCED_COLUMN_NAME) target.referencedColumns.push(row.REFERENCED_COLUMN_NAME);
    }

    for (const row of checkRows[0]) {
      (slot(row.TABLE_NAME).checks ??= []).push({
        name: row.CONSTRAINT_NAME,
        definition: row.CHECK_CLAUSE ?? null,
      });
    }

    // MySQL has no separate primary-key catalogue table: the primary key *is*
    // the PRIMARY index, so it is projected from what was just read rather than
    // queried again.
    for (const [key, entry] of byTable) {
      const primary = (entry.indexes ?? []).find((i) => i.name === 'PRIMARY');
      if (primary) {
        primary.primary = true;
        entry.primaryKey = [{ name: 'PRIMARY', columns: primary.columns, definition: null }];
      } else {
        entry.primaryKey = [];
      }
      byTable.set(key, entry);
    }

    return byTable;
  }
}

/** Whole milliseconds, or 0, which mysql2 reads as "no inactivity timer". */
function mySqlTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return 0;
  return Math.trunc(timeoutMs);
}

function groupByMysqlTable(rows, cap) {
  const groups = new Map();
  for (const row of rows) {
    const key = tableKey('DATABASE()', row.TABLE_NAME);
    let group = groups.get(key);
    if (!group) {
      group = { rows: [], truncated: false };
      groups.set(key, group);
    }
    if (group.rows.length < cap + COLUMN_PROBE) group.rows.push(row);
    else group.truncated = true;
  }
  for (const group of groups.values()) {
    if (group.rows.length > cap) {
      group.rows = group.rows.slice(0, cap);
      group.truncated = true;
    }
  }
  return groups;
}

function mysqlColumn(c) {
  return {
    name: c.COLUMN_NAME,
    type: c.COLUMN_TYPE,
    nullable: c.IS_NULLABLE === 'YES',
    // `COLUMN_KEY` is a per-column hint — 'PRI', 'UNI', 'MUL' — with no index
    // name and no column order, which is what `detail: 'full'` is for.
    key: !c.COLUMN_KEY ? null : c.COLUMN_KEY,
    default: c.COLUMN_DEFAULT ?? null,
    extra: !c.EXTRA ? null : c.EXTRA,
    ...(c.COLUMN_COMMENT ? { comment: c.COLUMN_COMMENT } : {}),
    ...(c.GENERATION_EXPRESSION ? { generated: c.GENERATION_EXPRESSION } : {}),
    ...(c.CHARACTER_SET_NAME ? { characterSet: c.CHARACTER_SET_NAME } : {}),
  };
}

/** How many documents a MongoDB field sample reads. */
const MONGO_SAMPLE = 50;

/** How deep a sampled document is flattened into dotted paths. */
const MONGO_FIELD_DEPTH = 3;

export class SQLiteSchemaAdapter extends SchemaAdapter {
  constructor(connectTimeout = 5000, queryTimeout = 30000) {
    super(connectTimeout, queryTimeout);
    this.db = null;
    this.databaseName = 'SQLite';
  }

  async all(sql, params = [], label = 'SQLite schema') {
    return callbackWithTimeout(
      (cb) => this.db.all(sql, params, cb),
      this.queryTimeout,
      label,
      'Reading the SQLite schema exceeded the timeout. The database file may be locked.'
    ).catch((err) => { throw this.describeError(err); });
  }

  /**
   * A PRAGMA takes an identifier, not a bound parameter, so the name is quoted and
   * embedded quotes doubled. Only a NUL is rejected; anything else is quoted, so a
   * table name containing spaces still works. The names come from sqlite_master and
   * the `table` option filters with a bound parameter, so quoting is what keeps
   * this injection-proof.
   *
   * The body and the name are separate arguments rather than one assembled string,
   * because the name is quoted exactly once: passing a pre-quoted name in and
   * quoting the whole thing again doubled every inner quote and asked SQLite about
   * a table name that did not exist.
   *
   * The *body is never quoted*. `PRAGMA table_info("orders")` answers;
   * `PRAGMA "table_info(""orders"")"` answers with zero rows and no error, and a
   * pragma that quietly returns nothing is indistinguishable from a table with no
   * columns, indexes or foreign keys.
   *
   * @param {string} body - The pragma itself, e.g. `table_info`
   * @param {string} [name] - The identifier it takes, quoted here
   */
  async pragma(body, name, label = 'SQLite schema') {
    const text = name === undefined ? `PRAGMA ${body}` : `PRAGMA ${body}(${quoteIdentifier(name)})`;
    if (/\x00/.test(text)) {
      throw new Error('[SQLite schema] unusable PRAGMA argument');
    }
    return callbackWithTimeout(
      (cb) => this.db.all(text, [], cb),
      this.queryTimeout,
      label
    ).catch((err) => { throw this.describeError(err); });
  }

  /**
   * Whether the table-valued `pragma_*` functions exist. They arrived in SQLite
   * 3.16 (2017). Where they are available every table's columns come back in one
   * query instead of up to 500 serialised round trips; where they are not, the
   * per-table path is the fallback, run concurrently rather than in series, which
   * is the only lever available without the functions. Probed once per
   * connection: it cannot change.
   */
  async supportsPragmaFunctions() {
    if (this._pragmaFunctions !== undefined) return this._pragmaFunctions;
    try {
      await this.all("SELECT 1 FROM pragma_table_xinfo('sqlite_master') LIMIT 1", [], 'SQLite schema probe');
      this._pragmaFunctions = true;
    } catch {
      this._pragmaFunctions = false;
    }
    return this._pragmaFunctions;
  }

  async describe(options = {}) {
    const detail = readDetail(options);
    const paging = readPaging(options);
    const table = typeof options.table === 'string' && options.table !== '' ? options.table : null;

    const objects = await this.all(
      `SELECT name, type, sql FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND name NOT LIKE 'sqlite_%'
          ${table ? 'AND name = ?' : ''}
        ORDER BY type, name
        LIMIT ? OFFSET ?`,
      [...(table ? [table] : []), paging.limit + 1, paging.offset]
    );

    const { page, hasMore } = splitPage(objects, paging);

    if (page.length === 0) {
      return {
        database: 'sqlite',
        detail,
        tables: [],
        ...pageReport(paging, 0, hasMore),
      };
    }

    const names = page.map((o) => o.name);
    const useFunctions = await this.supportsPragmaFunctions();

    const [columns, extra, file] = await Promise.all([
      useFunctions ? this.columnsViaFunctions(names) : this.columnsPerTable(names),
      detail === 'full' ? this.detailFull(names, useFunctions) : Promise.resolve(null),
      detail === 'full' ? this.fileInfo() : Promise.resolve(undefined),
    ]);

    let columnTruncated = false;
    const tables = page.map((object) => {
      const group = columns.get(object.name) ?? { rows: [], truncated: false };
      if (group.truncated) columnTruncated = true;
      const out = {
        name: object.name,
        type: object.type,
        sql: object.sql ?? null,
        columns: group.rows.map(sqliteColumn),
      };
      if (group.truncated) out.columnsTruncated = true;
      if (extra) Object.assign(out, extra.get(object.name) ?? {});
      return out;
    });

    return {
      database: 'sqlite',
      detail,
      ...(file ? { file } : {}),
      tables,
      ...pageReport(paging, tables.length, hasMore, {
        truncated: hasMore || columnTruncated,
      }),
    };
  }

  /**
   * Every table's columns in one query.
   *
   * `table_xinfo` rather than `table_info`: the first also reports generated and
   * hidden columns, which `table_info` silently omits, so a generated column used
   * to be a column a reader could not see. `hidden` is 2 for a VIRTUAL generated
   * column, 3 for a STORED one and 1 for a virtual table's hidden column.
   */
  async columnsViaFunctions(names) {
    const placeholders = names.map(() => '?').join(', ');
    const rows = await this.all(
      `SELECT m.name AS table_name, x.cid, x.name, x.type, x."notnull",
              x.dflt_value, x.pk, x.hidden
         FROM sqlite_master m
         JOIN pragma_table_xinfo(m.name) x
        WHERE m.type IN ('table', 'view')
          AND m.name NOT LIKE 'sqlite_%'
          AND m.name IN (${placeholders})
        ORDER BY m.name, x.cid`,
      names
    );
    return groupByName(rows, MAX_COLUMNS_PER_TABLE);
  }

  /**
   * The fallback for a SQLite older than 3.16: one PRAGMA per table, fanned out.
   *
   * A name that cannot be quoted — a table whose name contains a NUL — yields no
   * columns rather than failing the whole description. SQLite would truncate the
   * statement at the NUL and answer about a *different* table, which is worse
   * than answering about none.
   */
  async columnsPerTable(names) {
    const groups = await mapLimit(names, FAN_OUT, async (name) => {
      const rows = await this.pragma('table_info', name, 'SQLite columns').catch(() => []);
      return [name, Array.isArray(rows) ? rows : []];
    });
    const map = new Map();
    for (const [name, rows] of groups) {
      const truncated = rows.length > MAX_COLUMNS_PER_TABLE;
      map.set(name, { rows: truncated ? rows.slice(0, MAX_COLUMNS_PER_TABLE) : rows, truncated });
    }
    return map;
  }

  /** Foreign keys, indexes and triggers. */
  async detailFull(names, useFunctions) {
    const map = new Map();
    return useFunctions ? this.detailViaFunctions(names, map) : this.detailPerTable(names, map);
  }

  async detailViaFunctions(names, map) {
    const placeholders = names.map(() => '?').join(', ');
    const [foreignKeys, indexes, triggers] = await Promise.all([
      this.all(
        `SELECT m.name AS table_name, f."table" AS referenced_table, f."from" AS from_column,
                f."to" AS to_column, f.on_update, f.on_delete, f.id, f.seq
           FROM sqlite_master m
           JOIN pragma_foreign_key_list(m.name) f
          WHERE m.name IN (${placeholders})
          ORDER BY m.name, f.id, f.seq`,
        names
      ),
      this.all(
        `SELECT m.name AS table_name, il.name AS index_name, il."unique", il.origin, il.partial,
                ii.seqno, ii.name AS column_name
           FROM sqlite_master m
           JOIN pragma_index_list(m.name) il
           LEFT JOIN pragma_index_info(il.name) ii
          WHERE m.name IN (${placeholders})
          ORDER BY m.name, il.name, ii.seqno`,
        names
      ),
      // From sqlite_master, not a pragma function. There is no
      // `pragma_trigger_list` — triggers are not among the table-valued pragma
      // functions — so the N+1 would have come back for triggers only.
      // sqlite_master is both one query and a better source: it carries the
      // trigger body, which `PRAGMA trigger_list` does not. See
      // `detailPerTable` for the same conclusion reached the other way.
      this.all(
        `SELECT tbl_name AS table_name, name AS trigger_name, sql
           FROM sqlite_master
          WHERE type = 'trigger'
            AND tbl_name IN (${placeholders})
          ORDER BY tbl_name, name`,
        names
      ),
    ]);

    // `id` is the constraint's own index within the table, so a composite key
    // is a contiguous run of rows under one id — the way to tell two
    // single-column keys on one table from one two-column key.
    const keys = new Map();
    for (const row of foreignKeys) {
      const id = `${row.table_name} ${row.id}`;
      if (!keys.has(id)) {
        const fk = {
          referencedTable: row.referenced_table,
          columns: [],
          referencedColumns: [],
          onUpdate: row.on_update ?? null,
          onDelete: row.on_delete ?? null,
        };
        keys.set(id, fk);
        (slotFor(map, row.table_name).foreignKeys ??= []).push(fk);
      }
      const fk = keys.get(id);
      if (row.from_column) fk.columns.push(row.from_column);
      // `to` is NULL when the key refers to the implicit primary key.
      if (row.to_column) fk.referencedColumns.push(row.to_column);
    }

    const byIndex = new Map();
    for (const row of indexes) {
      const id = `${row.table_name} ${row.index_name}`;
      if (!byIndex.has(id)) {
        const index = {
          name: row.index_name,
          columns: [],
          unique: row.unique === 1 || row.unique === true,
          origin: row.origin ?? null,
          partial: row.partial === 1 || row.partial === true,
        };
        byIndex.set(id, index);
        // The primary key's own index is redundant: `table_xinfo` already
        // reports which columns are the key.
        if (index.origin !== 'pk') (slotFor(map, row.table_name).indexes ??= []).push(index);
      }
      if (row.column_name) byIndex.get(id).columns.push(row.column_name);
    }

    for (const row of triggers) {
      (slotFor(map, row.table_name).triggers ??= []).push({
        name: row.trigger_name,
        definition: row.sql ?? null,
      });
    }

    return map;
  }

  /** The same information, one table at a time, for a SQLite older than 3.16. */
  async detailPerTable(names, map) {
    // Triggers come from sqlite_master here too, for the reason given in
    // `detailViaFunctions` — and the silent form is the dangerous one:
    // `PRAGMA trigger_list("t")` accepts the quoted argument and answers with
    // zero rows, no error. The other four pragmas work in the same shape, so
    // quoting is not the problem and a report saying "this table has no
    // triggers" looks exactly like a true one.
    //
    // One query for the whole page, with the table names bound as parameters, so
    // it is not the N+1 the other two legs of this method are.
    const triggerRows = await this.all(
      `SELECT tbl_name AS table_name, name AS trigger_name, sql
         FROM sqlite_master
        WHERE type = 'trigger'
          AND tbl_name IN (${names.map(() => '?').join(', ')})
        ORDER BY tbl_name, name`,
      names,
      'SQLite triggers'
    ).catch(() => []);

    const triggersByTable = new Map();
    for (const row of triggerRows ?? []) {
      if (!triggersByTable.has(row.table_name)) triggersByTable.set(row.table_name, []);
      triggersByTable.get(row.table_name).push({ name: row.trigger_name, definition: row.sql ?? null });
    }

    const perTable = await mapLimit(names, FAN_OUT, async (name) => {
      // As in columnsPerTable: a name that cannot be quoted has no details, and
      // one table must not fail the description of the other 499.
      const safe = (body, label) => this.pragma(body, name, label).catch(() => []);
      const [foreignKeys, indexList] = await Promise.all([
        safe('foreign_key_list', 'SQLite foreign keys'),
        safe('index_list', 'SQLite indexes'),
      ]);

      const indexes = await mapLimit(
        (indexList ?? []).filter((i) => i.origin !== 'pk'),
        FAN_OUT,
        async (index) => [
          index,
          await this.pragma('index_info', index.name, 'SQLite index columns').catch(() => []),
        ]
      );

      const keys = new Map();
      for (const fk of foreignKeys ?? []) {
        if (!keys.has(fk.id)) {
          keys.set(fk.id, {
            referencedTable: fk.table,
            columns: [],
            referencedColumns: [],
            onUpdate: fk.on_update ?? null,
            onDelete: fk.on_delete ?? null,
          });
        }
        const key = keys.get(fk.id);
        if (fk.from) key.columns.push(fk.from);
        if (fk.to) key.referencedColumns.push(fk.to);
      }

      return {
        name,
        foreignKeys: [...keys.values()],
        indexes: indexes.map(([index, columns]) => ({
          name: index.name,
          unique: index.unique === 1,
          origin: index.origin ?? null,
          partial: index.partial === 1,
          columns: (columns ?? []).sort((a, b) => a.seqno - b.seqno).map((c) => c.name),
        })),
        triggers: triggersByTable.get(name) ?? [],
      };
    });

    for (const entry of perTable) {
      const target = slotFor(map, entry.name);
      if (entry.foreignKeys.length) target.foreignKeys = entry.foreignKeys;
      if (entry.indexes.length) target.indexes = entry.indexes;
      if (entry.triggers.length) target.triggers = entry.triggers;
    }
    return map;
  }

  /** The file's size, from the page count. */
  async fileInfo() {
    try {
      const pages = await this.pragma('page_count');
      const size = await this.pragma('page_size');
      const pageCount = Number(pages?.[0]?.page_count);
      const pageSize = Number(size?.[0]?.page_size);
      if (!Number.isFinite(pageCount) || !Number.isFinite(pageSize)) return null;
      return { pageCount, pageSize, bytes: pageCount * pageSize };
    } catch {
      return null;
    }
  }
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function groupByName(rows, cap) {
  const groups = new Map();
  for (const row of rows) {
    let group = groups.get(row.table_name);
    if (!group) {
      group = { rows: [], truncated: false };
      groups.set(row.table_name, group);
    }
    if (group.rows.length < cap + COLUMN_PROBE) group.rows.push(row);
    else group.truncated = true;
  }
  for (const group of groups.values()) {
    if (group.rows.length > cap) {
      group.rows = group.rows.slice(0, cap);
      group.truncated = true;
    }
  }
  return groups;
}

function slotFor(map, name) {
  if (!map.has(name)) map.set(name, {});
  return map.get(name);
}

function sqliteColumn(c) {
  const column = {
    name: c.name,
    type: c.type,
    nullable: c.notnull === 0 || c.notnull === false,
    primaryKey: c.pk > 0,
    default: c.dflt_value ?? null,
  };
  if (c.hidden === 2) column.generated = 'VIRTUAL';
  else if (c.hidden === 3) column.generated = 'STORED';
  else if (c.hidden === 1) column.hidden = true;
  return column;
}

export class MongoSchemaAdapter extends SchemaAdapter {
  constructor(connectTimeout = 5000, queryTimeout = 30000) {
    super(connectTimeout, queryTimeout);
    this.client = null;
    // The **pinned** `Db`, handed over by the adapter. It must not be reached for
    // through `this.client.db`: that is a method on `MongoClient`, so
    // `client.db.listCollections` is `undefined`.
    this.db = null;
    this.databaseName = 'MongoDB';
  }

  /** The pinned Db, or an error that says so rather than a TypeError. */
  pinned() {
    if (this.db) return this.db;
    throw new Error('[MongoDB schema] no database is attached');
  }

  async describe(options = {}) {
    const detail = readDetail(options);
    const paging = readPaging(options);
    const wanted = typeof options.collection === 'string' && options.collection !== ''
      ? options.collection
      : null;

    // Not `nameOnly`. The listing's own `options` already carry `capped`, `size`,
    // `max` and `timeseries` for every collection, and an empty result for a named
    // collection then means *it does not exist*, rather than "its stats could not
    // be read".
    //
    // Through `describeError`, like every other backend's first catalogue query:
    // an unauthorized `listCollections` is the single most common reason this
    // call fails.
    let listed;
    try {
      listed = await this.pinned()
        .listCollections(wanted ? { name: wanted } : {}, { nameOnly: false })
        .toArray();
    } catch (err) {
      throw this.describeError(err, this.queryTimeout);
    }

    if (wanted && listed.length === 0) {
      return {
        database: 'mongodb',
        detail,
        databaseName: this.pinnedDatabase(),
        collections: [],
        collectionNotFound: wanted,
        ...pageReport(paging, 0, false),
      };
    }

    const { page: names, hasMore } = splitPage(listed, paging);
    const described = await mapLimit(names, FAN_OUT, (info) => this.describeCollection(info, detail));

    return {
      database: 'mongodb',
      detail,
      databaseName: this.pinnedDatabase(),
      collections: described,
      ...pageReport(paging, described.length, hasMore),
    };
  }

  /** The name the pinned database reports, or null when nothing is attached. */
  pinnedDatabase() {
    const pinned = this.db?.databaseName;
    if (typeof pinned === 'string' && pinned !== '') return pinned;
    const fromOptions = this.client?.options?.dbName;
    return typeof fromOptions === 'string' && fromOptions !== '' ? fromOptions : null;
  }

  async describeCollection(info, detail) {
    const name = info.name;
    const options = info.options ?? {};

    const [stats, indexes] = await Promise.all([
      this.collectionStats(name),
      this.collectionIndexes(name, detail),
    ]);

    const out = {
      name,
      // `null` means the count could not be read, and the reason is reported
      // alongside so an unreadable count is never read as "zero documents".
      documents: stats.error ? null : numberOrNull(stats.count),
      ...(stats.error ? { statsError: stats.error } : {}),
      ...(options.capped ? { capped: true } : {}),
      ...(options.timeseries ? { timeseries: true } : {}),
      indexes,
    };

    if (detail !== 'full') return out;

    return {
      ...out,
      type: info.type ?? 'collection',
      ...(stats.error
        ? {}
        : {
          sizeBytes: numberOrNull(stats.size),
          storageSizeBytes: numberOrNull(stats.storageSize),
          totalIndexSizeBytes: numberOrNull(stats.totalIndexSize),
          averageDocumentSizeBytes: numberOrNull(stats.avgObjSize),
          nindexes: numberOrNull(stats.nindexes),
        }),
      // Last, and deliberately: for a capped collection `options.size` is the
      // ceiling the collection will ever grow to, which is what a caller asking
      // "how big is this" wants, and it is not what `collStats.size` reports.
      ...(options.capped
        ? { sizeBytes: numberOrNull(options.size), maxDocuments: numberOrNull(options.max) }
        : {}),
      fields: await this.sampleFields(name),
    };
  }

  async collectionStats(name) {
    try {
      return await this.pinned().command({ collStats: name });
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  }

  async collectionIndexes(name, detail) {
    try {
      const specs = await this.pinned().collection(name).indexes();
      return specs.map((spec) => {
        const base = { name: spec.name, key: spec.key, unique: !!spec.unique };
        if (detail !== 'full') return base;
        return {
          ...base,
          // A TTL index is a schema fact: it says which field is an expiry, and
          // whether it holds an absolute date or a lifetime. `expireAfterSeconds: 0`
          // on a date field is a pattern no one infers from `unique: true`.
          ...(spec.expireAfterSeconds !== undefined ? { expireAfterSeconds: spec.expireAfterSeconds } : {}),
          ...(spec.sparse !== undefined ? { sparse: spec.sparse } : {}),
          ...(spec.partialFilterExpression ? { partialFilterExpression: spec.partialFilterExpression } : {}),
          ...(spec.weights ? { weights: spec.weights } : {}),
          ...(spec.default_language ? { defaultLanguage: spec.default_language } : {}),
          ...(spec.collation ? { collation: spec.collation } : {}),
          ...(spec.hidden ? { hidden: true } : {}),
          ...(indexKind(spec) ? { kind: indexKind(spec) } : {}),
        };
      });
    } catch {
      // A collection whose indexes cannot be read is still worth listing.
      return [];
    }
  }

  /**
   * Inferred field names, types and nesting, from a bounded sample.
   *
   * MongoDB has no catalogue of a document's fields: the only way to learn that
   * an order carries `shipping.address.postcode` is to read one. That is exactly
   * the guessing `db_schema` exists to stop, so it samples — under
   * `detail: 'full'`, because on 500 collections a sample each is the
   * multi-second call the summary level exists to avoid.
   */
  async sampleFields(name) {
    let documents;
    try {
      documents = await this.pinned().collection(name).find({}, { projection: { _id: 0 } })
        .limit(MONGO_SAMPLE)
        .toArray();
    } catch {
      return null;
    }
    if (!Array.isArray(documents) || documents.length === 0) return [];

    const fields = new Map();

    const visit = (value, prefix, depth) => {
      if (value === null || value === undefined) {
        recordField(fields, prefix, 'null', null);
        return;
      }
      if (depth > MONGO_FIELD_DEPTH) {
        recordField(fields, prefix, bsonType(value), value, true);
        return;
      }
      if (Array.isArray(value)) {
        recordField(fields, prefix, 'array', null);
        // One element is enough to learn a nested field's name, and an array of
        // ten thousand sub-documents is not something to walk.
        if (value.length > 0) visit(value[0], `${prefix}[]`, depth + 1);
        return;
      }
      if (typeof value === 'object' && !(value instanceof Date) && !value._bsontype) {
        for (const [key, child] of Object.entries(value)) {
          visit(child, prefix ? `${prefix}.${key}` : key, depth + 1);
        }
        return;
      }
      recordField(fields, prefix, bsonType(value), value);
    };

    for (const document of documents) visit(document, '', 0);

    return [...fields.values()].map((f) => ({
      name: f.name,
      types: [...f.types].sort(),
      presentIn: f.present,
      samples: f.samples,
      ...(f.truncatedAtDepth ? { truncatedAtDepth: true } : {}),
    }));
  }
}

/** `2dsphere`, `text`, `hashed`: a model needs to know an index is not a lookup key. */
function indexKind(spec) {
  const value = spec.key && typeof spec.key === 'object' ? Object.values(spec.key)[0] : null;
  if (value === '2dsphere' || value === '2d') return 'geospatial';
  if (value === 'text') return 'text';
  if (value === 'hashed') return 'hashed';
  return null;
}

/** The BSON type name of a decoded value, which is what a model can reason about. */
function bsonType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'string': return 'string';
    case 'number': return Number.isInteger(value) ? 'int' : 'double';
    case 'bigint': return 'long';
    case 'boolean': return 'bool';
    case 'object':
      if (value instanceof Date) return 'date';
      if (value._bsontype === 'Decimal128') return 'decimal';
      if (value._bsontype === 'ObjectId') return 'objectId';
      if (value._bsontype === 'Binary') return 'binData';
      return 'object';
    default: return typeof value;
  }
}

function recordField(fields, name, type, value, truncatedAtDepth = false) {
  if (!name) return;
  let field = fields.get(name);
  if (!field) {
    field = { name, types: new Set(), present: 0, samples: [], truncatedAtDepth: false };
    fields.set(name, field);
  }
  field.types.add(type);
  field.present += 1;
  if (truncatedAtDepth) field.truncatedAtDepth = true;
  if (field.samples.length < 3 && value !== null && value !== undefined) {
    const sample = sampleValue(value);
    if (sample !== null && !field.samples.includes(sample)) field.samples.push(sample);
  }
}

/** A short, printable example. Never the value itself if it is bulky. */
function sampleValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return value;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : (text.length > 60 ? `${text.slice(0, 60)}…` : text);
  } catch {
    return null;
  }
}

/** Key names sampled for a summary, and keys walked for a full type census. */
const REDIS_SAMPLE_KEYS = 20;
const REDIS_TYPE_SCAN = 500;

/**
 * `INFO` returns a raw string, not a parsed object.
 *
 * Every call site reads `client.info(...)`, and the keyspace one treated the
 * reply as parsed: `Object.entries("db0:keys=12,…")` yields one entry per
 * *character*, no key is ever named `keyspace`, and the report said the keyspace
 * was empty on every Redis server. The wire format: sections introduced by
 * `# Name`, then `key:value` lines, CRLF-separated.
 */
function parseInfo(raw) {
  const sections = {};
  let current = 'default';
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (text === '') continue;
    if (text.startsWith('#')) {
      current = text.replace(/^#\s*/, '').trim() || 'default';
      continue;
    }
    const at = text.indexOf(':');
    if (at <= 0) continue;
    const key = text.slice(0, at).trim();
    if (!sections[current]) sections[current] = {};
    sections[current][key] = text.slice(at + 1).trim();
  }
  return sections;
}

export class RedisSchemaAdapter extends SchemaAdapter {
  constructor(connectTimeout = 5000, queryTimeout = 30000) {
    super(connectTimeout, queryTimeout);
    this.client = null;
    this.databaseName = 'Redis';
  }

  /**
   * A `table` — or a `collection`, the same word the tool uses for MongoDB — is a
   * key name here, and is answered as one: the type, the TTL, the memory, and a
   * bounded look at the value.
   */
  async describe(options = {}) {
    const detail = readDetail(options);
    const key = typeof options.collection === 'string' && options.collection !== ''
      ? options.collection
      : (typeof options.table === 'string' && options.table !== '' ? options.table : null);
    const sampleSize = Math.min(REDIS_SAMPLE_KEYS, positiveInt(options.maxRows, REDIS_SAMPLE_KEYS));

    // Every section is optional in the sense that a failure in one must not lose
    // the others, and none of them is optional in the sense that the answer may
    // pretend it was read. `unavailable` is what keeps those two apart.
    const unavailable = [];
    const [server, keyspace, memory, replication] = await Promise.all([
      this.safeSection(unavailable, 'server', () => this.client.info('server'), ''),
      this.safeSection(unavailable, 'keyspace', () => this.client.info('keyspace'), ''),
      detail === 'full'
        ? this.safeSection(unavailable, 'memory', () => this.client.info('memory'), '')
        : Promise.resolve(''),
      detail === 'full'
        ? this.safeSection(unavailable, 'replication', () => this.client.info('replication'), '')
        : Promise.resolve(''),
    ]);

    const keyspaceOut = {};
    for (const [name, body] of Object.entries(parseInfo(keyspace).Keyspace ?? {})) {
      const match = /^keys=(\d+),expires=(\d+),avg_ttl=(\d+)/.exec(String(body));
      if (match) {
        keyspaceOut[name] = {
          keys: Number(match[1]),
          expires: Number(match[2]),
          avgTtl: Number(match[3]),
        };
      }
    }

    const out = {
      database: 'redis',
      detail,
      version: infoField(server, 'redis_version'),
      mode: infoField(server, 'redis_mode'),
      keyspace: keyspaceOut,
      // There is no schema to read, so a sample of key names is the next best
      // thing a caller can go on.
      sampleKeys: await this.sampleKeys(sampleSize),
      note: 'Redis is schemaless. Use SCAN to explore; KEYS blocks the server.',
      // Absent when everything was read. Present, and named, when a section
      // failed: an empty `keyspace` because the server refused `INFO` is not the
      // same fact as a server with no keys.
      ...(unavailable.length ? { unavailable } : {}),
    };

    if (key !== null) out.key = await this.describeKey(key, positiveInt(options.maxRows, 5));

    if (detail === 'full') {
      out.keyTypes = await this.keyTypeCensus();
      out.memory = this.infoSubset(memory, [
        'used_memory', 'used_memory_human', 'used_memory_rss', 'used_memory_peak',
        'used_memory_peak_human', 'maxmemory', 'maxmemory_policy', 'mem_fragmentation_ratio',
        'mem_allocator',
      ]);
      out.replication = this.infoSubset(replication, [
        'role', 'connected_slaves', 'master_replid', 'master_sync_in_progress',
      ]);
    }

    return out;
  }

  /**
   * Key names, from SCAN rather than KEYS.
   *
   * `scanIterator` yields one **page** per iteration — an array of keys — not one
   * key. Both shapes are accepted because the page shape is the documented one and
   * a bare value is what an earlier major yielded.
   */
  async sampleKeys(limit) {
    if (limit <= 0) return [];
    return this.safe(async () => {
      const keys = [];
      for await (const page of this.client.scanIterator({ COUNT: 50 })) {
        for (const key of flattenScanPage(page)) {
          keys.push(key);
          if (keys.length >= limit) return keys;
        }
      }
      return keys;
    }, []);
  }

  /** A census of key types, which is what a Redis schema is. */
  async keyTypeCensus() {
    return this.safe(async () => {
      const counts = new Map();
      let sampled = 0;
      for await (const page of this.client.scanIterator({ COUNT: 100 })) {
        for (const key of flattenScanPage(page)) {
          if (sampled >= REDIS_TYPE_SCAN) {
            return { counts: Object.fromEntries(counts), sampled, complete: false };
          }
          sampled++;
          const type = await this.safe(() => this.client.type(key), 'unknown');
          counts.set(type, (counts.get(type) ?? 0) + 1);
        }
      }
      return { counts: Object.fromEntries(counts), sampled, complete: true };
    }, { counts: {}, sampled: 0, complete: false });
  }

  async describeKey(name, sampleLimit) {
    const [type, ttl, memory] = await Promise.all([
      this.safe(() => this.client.type(name), null),
      this.safe(() => this.client.ttl(name), null),
      this.safe(() => this.client.sendCommand(['MEMORY', 'USAGE', name]), null),
    ]);

    const out = { name, type: type ?? null, ttlSeconds: numberOrNull(ttl) };
    if (memory !== null) out.memoryBytes = numberOrNull(memory);

    if (type === 'hash') {
      out.sample = await this.safe(async () => {
        const entries = [];
        for await (const page of this.client.hScanIterator(name, { COUNT: 50 })) {
          for (const entry of flattenScanPage(page)) {
            if (entries.length >= sampleLimit) return entries;
            entries.push({ field: entry?.field, value: entry?.value });
          }
        }
        return entries;
      }, []);
    } else if (type === 'list' || type === 'set' || type === 'zset') {
      // Paged, because these are the unbounded collection reads: LRANGE 0 -1,
      // SMEMBERS and ZRANGE 0 -1 each return the whole thing, from a call a
      // read-only caller is allowed to make. LRANGE's stop is inclusive, so the
      // last index wanted is `limit - 1`; SMEMBERS takes none.
      const command = { list: 'LRANGE', set: 'SMEMBERS', zset: 'ZRANGE' }[type];
      const args = command === 'SMEMBERS' ? [name] : [name, '0', String(Math.max(0, sampleLimit - 1))];
      out.sample = await this.safe(
        () => this.client.sendCommand([command, ...args]).then((reply) => asArray(reply).slice(0, sampleLimit)),
        []
      );
    } else if (type === 'string') {
      out.value = await this.safe(() => this.client.get(name), null);
    } else if (type === 'stream') {
      out.length = numberOrNull(await this.safe(() => this.client.xLen(name), null));
    }
    return out;
  }

  /** A named subset of one INFO section, with numbers as numbers. */
  infoSubset(raw, names) {
    const fields = Object.values(parseInfo(raw))[0] ?? {};
    const out = {};
    for (const name of names) {
      if (fields[name] === undefined) continue;
      const asNumber = Number(fields[name]);
      out[name] = fields[name] !== '' && Number.isFinite(asNumber) ? asNumber : fields[name];
    }
    return Object.keys(out).length ? out : null;
  }

  async safe(fn, fallback) {
    try { return await fn(); } catch { return fallback; }
  }

  /**
   * `safe`, but it says what it could not read.
   *
   * A swallowed failure is a confident-looking empty answer: `INFO keyspace`
   * refused comes back as `keyspace: {}`, which reads exactly like a server with
   * no keys rather than one that would not say.
   */
  async safeSection(unavailable, section, fn, fallback) {
    try { return await fn(); } catch (err) {
      unavailable.push({ section, error: err?.message ?? String(err) });
      return fallback;
    }
  }
}

function infoField(raw, name) {
  for (const fields of Object.values(parseInfo(raw))) {
    if (fields[name] !== undefined) return fields[name];
  }
  return null;
}

/** `scanIterator` yields pages; an earlier major yielded bare values. */
function flattenScanPage(page) {
  return Array.isArray(page) ? page : [page];
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

export { MAX_TABLES, MAX_COLUMNS_PER_TABLE, parseInfo };
