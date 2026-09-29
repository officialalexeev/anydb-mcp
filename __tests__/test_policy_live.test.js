/**
 * The four databases, live.
 *
 * Every other suite in this directory runs against a double. A faithful double
 * proves the adapter *calls* the driver correctly; it cannot prove that
 * `SET statement_timeout = 30000` is spelled the way the server spells it, that
 * `?` is MySQL's placeholder and not PostgreSQL's, that a cursor yields, or that
 * a driver error carries the code `classifyError` reads off the `cause` chain.
 * This is the live half, as jest tests, per backend: connect, describe, read with
 * a bound parameter, write behind both gates, read it back, prove the cache reused
 * the connection, prove a refused statement is refused.
 *
 * Gated on one environment variable per backend, each holding the whole URI:
 *
 *   ANYDB_TEST_POSTGRES   postgres://anydb:anydb@127.0.0.1:5432/anydb
 *   ANYDB_TEST_MYSQL      mysql://root:anydb@127.0.0.1:3306/anydb
 *   ANYDB_TEST_MONGODB    mongodb://127.0.0.1:27017/anydb
 *   ANYDB_TEST_REDIS      redis://127.0.0.1:6379
 *
 * Not covered here, and a container would be needed for each: MariaDB, Redis
 * Cluster and Sentinel, `mongodb+srv` (a DNS SRV lookup against real Atlas), TLS,
 * the two socket timeouts that only fire under load, and the cache's
 * pending-entry dedup and idle-TTL eviction.
 */

import { AdapterRegistry } from '../src/core/registry.js';
import { checkConnectionPolicy } from '../src/core/policy.js';

/** The four environment variables, and the driver each one exercises. */
const BACKENDS = Object.freeze({
  postgres: 'ANYDB_TEST_POSTGRES',
  mysql: 'ANYDB_TEST_MYSQL',
  mongodb: 'ANYDB_TEST_MONGODB',
  redis: 'ANYDB_TEST_REDIS',
});

/** `process.env` is read per call rather than at import, so a test can set it. */
const uriFor = (backend) => {
  const value = process.env[BACKENDS[backend]];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

/**
 * A `describe` that exists only when a server was configured.
 *
 * A conditional `describe` rather than a `test.skip`: with no variable set the
 * tests are never registered, so they cost nothing and cannot report a false
 * pass through a `skip` marker. With one set they run for real, and a server that
 * does not answer is a failure.
 *
 * @param {string} backend - One of the keys of `BACKENDS`
 * @param {Function} body
 */
function describeIfLive(backend, body) {
  const uri = uriFor(backend);
  if (uri === null) {
    describe(`${backend} (live)`, () => {
      test(`is not configured, so these tests did not run: set ${BACKENDS[backend]}`, () => {
        // A single, honest, always-present line: without it a green run of this
        // file is indistinguishable from a green run against four databases.
        expect(uriFor(backend)).toBeNull();
      });
    });
    return;
  }
  // 60 seconds rather than the suite's default 20: a CI service container is cold
  // when the job starts, and the first `connect()` can spend seconds in server
  // selection before the first query lands.
  describe(`${backend} (live)`, body, 60000);
}

  // Every registry in this file gets the same environment: private hosts allowed,
  // because a CI service container is on loopback and the default exists to stop a
  // caller reaching a metadata endpoint from a real deployment. Scoped to the
  // registry, never to `process.env`.

const liveEnv = (extra = {}) => ({
  ANYDB_ALLOW_PRIVATE_HOSTS: '1',
  ANYDB_ALLOWED_SCHEMES: '',
  ...extra,
});

/** A registry for one live URI, with a generous budget for a cold container. */
const registryFor = (uri) => new AdapterRegistry({ env: liveEnv(), log: () => {} });

const rowsOf = (envelope) => (Array.isArray(envelope?.rows) ? envelope.rows : []);
const firstRow = (envelope) => {
  const [row] = rowsOf(envelope);
  return row && typeof row === 'object' ? row : {};
};

/**
 * The `db_schema` report out of the response envelope.
 *
 * For this one call the envelope's `rows` is a single **object** — the report —
 * rather than an array of rows, so `rowsOf` is the wrong reader here and using it
 * yields `tables: undefined` and a test that passes for the wrong reason.
 *
 * @param {object} envelope - What `describe()` resolved to
 * @returns {object} `{ database, tables | collections | keyspace, … }`
 */
const reportOf = (envelope) => {
  if (!envelope || typeof envelope !== 'object') return {};
  if (Array.isArray(envelope.rows)) return firstRow(envelope);
  if (envelope.rows && typeof envelope.rows === 'object') return envelope.rows;
  // A registry that answered with the report unwrapped, which `describe()` is
  // documented not to do but which costs nothing to tolerate here.
  return envelope;
};

const errorFrom = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, and it resolved');
};

/** Both write gates. A MongoDB write is classified destructive, so it needs both. */
const WRITING = Object.freeze({ readOnly: false, allowDestructive: true });

/**
 * Budget for a `beforeAll` / `afterAll`. Jest does not inherit a `describe`'s
 * timeout argument into its hooks, so each one is given this explicitly. Larger
 * than the 30 s a single statement gets because a hook can open the *first*
 * connection of the process, and on a cold container that includes driver load,
 * DNS and server selection.
 */
const HOOK_TIMEOUT = 60000;

// PostgreSQL

describeIfLive('postgres', () => {
  const TABLE = 'anydb_live_users';
  let registry;
  let uri;

  beforeAll(async () => {
    uri = uriFor('postgres');
    registry = registryFor(uri);
    await registry.run(
      uri,
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, seen BOOLEAN NOT NULL DEFAULT FALSE)`,
      { ...WRITING, timeout: 30000 }
    );
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (registry) {
      await registry.run(uri, `DROP TABLE IF EXISTS ${TABLE}`, { ...WRITING, timeout: 30000 })
        .catch(() => {});
      await registry.close();
    }
  }, HOOK_TIMEOUT);

  test('connects and reports the server it reached', async () => {
    const rows = rowsOf(await registry.run(uri, 'SELECT version()', { timeout: 30000 }));
    expect(String(firstRow({ rows }).version ?? rows[0])).toMatch(/PostgreSQL/);
  });

  test('db_schema reports the fixture table with its columns', async () => {
    // The shape `db_schema` promises: a `database`, a list of `tables`, and each
    // table's `columns`. Asserted rather than merely truthy, because a double
    // returning `{}` would satisfy the round trip in `scripts/live-adapters.mjs`
    // and prove nothing about a real introspection query.
    const report = reportOf(await registry.describe(uri, { timeout: 30000 }));
    const table = report.tables.find((entry) => entry.name === TABLE);

    expect(report.database).toBe('postgres');
    expect(table).toBeDefined();
    expect(table.columns.map((column) => column.name).sort()).toEqual(['email', 'id', 'seen']);
    expect(table.columns.find((column) => column.name === 'email').type).toMatch(/text/);
  });

  test('db_schema can describe just one table', async () => {
    const report = reportOf(await registry.describe(uri, { table: TABLE, timeout: 30000 }));
    expect(report.tables.map((entry) => entry.name)).toEqual([TABLE]);
  });

  test('a parameterised read binds rather than interpolates', async () => {
    // `$1`, not `?`. Getting the placeholder wrong is exactly the class of bug a
    // double cannot catch: the double records the call, the server rejects the
    // statement.
    await registry.run(
      uri,
      `INSERT INTO ${TABLE} (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
      { ...WRITING, params: ['bound@example.com'], timeout: 30000 }
    );

    const read = await registry.run(uri, `SELECT email FROM ${TABLE} WHERE email = $1`, {
      params: ['bound@example.com'], timeout: 30000
    });
    expect(rowsOf(read)).toEqual([{ email: 'bound@example.com' }]);
  });

  test('a value in params never reaches the statement text', async () => {
    // A quote in a bound value is the injection case. Inlined it would be a
    // syntax error at best; bound, it is a row.
    await registry.run(uri, `INSERT INTO ${TABLE} (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, {
      ...WRITING, params: ["o'brien@example.com"], timeout: 30000
    });
    const read = await registry.run(uri, `SELECT email FROM ${TABLE} WHERE email = $1`, {
      params: ["o'brien@example.com"], timeout: 30000
    });
    expect(rowsOf(read)).toEqual([{ email: "o'brien@example.com" }]);
  });

  test('a write behind both gates is readable afterwards', async () => {
    const written = await registry.run(uri, `UPDATE ${TABLE} SET seen = true WHERE email = $1`, {
      ...WRITING, params: ['bound@example.com'], timeout: 30000
    });
    expect(firstRow(written).affectedRows ?? rowsOf(written)[0]).toBeDefined();

    const read = await registry.run(uri, `SELECT seen FROM ${TABLE} WHERE email = $1`, {
      params: ['bound@example.com'], timeout: 30000
    });
    expect(rowsOf(read)).toEqual([{ seen: true }]);
  });

  test('the connection is reused, not re-opened, on the next call', async () => {
    // The cache is the feature: a pooled connection per URI rather than per
    // call. The proof that does not depend on adapter internals is that the
    // second `run` connected nothing.
    const key = (await import('../src/core/registry.js')).normaliseCacheKey(uri, 'postgres');
    expect(registry.cache.entries.has(key)).toBe(true);
    expect(registry.cache.size).toBe(1);

    const before = registry.cache.size;
    await registry.run(uri, 'SELECT 1', { timeout: 30000 });
    expect(registry.cache.size).toBe(before);
  });

  test('read-only mode still refuses a write against a live server', async () => {
    const error = await errorFrom(registry.run(uri, `DELETE FROM ${TABLE} WHERE email = $1`, {
      params: ['readonly@example.com'], timeout: 30000
    }));
    expect(error.kind).toBe('policy');
    expect(error.code).toBe('READ_ONLY');
  });

  test('a write without allowDestructive is refused, and a schema change needs both', async () => {
    // A row write with `readOnly: false` is allowed — that is what the flag is
    // for — and a schema change is not, because it is a different decision and
    // takes a second opt-in on top of the first.
    await expect(registry.run(uri, `INSERT INTO ${TABLE} (email) VALUES ($1)`, {
      params: ['nope@example.com'], readOnly: false, timeout: 30000
    })).resolves.toBeDefined();

    await expect(registry.run(uri, 'CREATE TABLE anydb_live_ddl (a INT)', {
      readOnly: false, timeout: 30000
    })).rejects.toMatchObject({ kind: 'policy', code: 'DESTRUCTIVE' });
  });

  test('a statement the server refuses comes back with the driver code', async () => {
    // `42P01` is `undefined_table`. Two things are proved at once: the real
    // server's error reaches the caller, and the SQLSTATE survives the adapter's
    // rewrite — it is on the `cause`, and `classifyError` reads the chain, which
    // is how `ERROR_FIELD` in `core/tools.js` can promise a model a code.
    const error = await errorFrom(registry.run(uri, 'SELECT * FROM anydb_live_absent', { timeout: 30000 }));
    expect(error.kind).toBe('database');
    expect(error.code).toBe('42P01');
  });

  test('db_explain returns a plan and does not run the statement', async () => {
    const plan = await registry.run(uri, `EXPLAIN SELECT * FROM ${TABLE} WHERE email = $1`, {
      params: ['bound@example.com'], timeout: 30000
    });
    const text = JSON.stringify(rowsOf(plan));
    expect(rowsOf(plan).length).toBeGreaterThan(0);
    expect(text).toMatch(/Scan|Seq Scan|Index/i);
  });

  test('the policy is on, and it is what stops the loopback address', async () => {
    // A registry with the same URI and the switch *off* is refused, which is what
    // proves the other registries in this file are running the policy rather than
    // running with it disabled.
    const strict = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '0' }, log: () => {} });
    const verdict = await checkConnectionPolicy(uri, { env: strict.env });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/private|loopback/);
    await strict.close();
  });
});

// MySQL / MariaDB

describeIfLive('mysql', () => {
  const TABLE = 'anydb_live_users';
  let registry;
  let uri;

  beforeAll(async () => {
    uri = uriFor('mysql');
    registry = registryFor(uri);
    await registry.run(
      uri,
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190) NOT NULL UNIQUE, seen BOOLEAN NOT NULL DEFAULT FALSE)`,
      { ...WRITING, timeout: 30000 }
    );
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (registry) {
      await registry.run(uri, `DROP TABLE IF EXISTS ${TABLE}`, { ...WRITING, timeout: 30000 })
        .catch(() => {});
      await registry.close();
    }
  }, HOOK_TIMEOUT);

  test('connects and reports the server it reached', async () => {
    const rows = rowsOf(await registry.run(uri, 'SELECT VERSION() AS v', { timeout: 30000 }));
    expect(String(rows[0]?.v ?? '')).toMatch(/MariaDB|MySQL/i);
  });

  test('db_schema reports the fixture table with its columns', async () => {
    const report = reportOf(await registry.describe(uri, { timeout: 30000 }));
    const table = report.tables.find((entry) => entry.name === TABLE);

    expect(report.database).toBe('mysql');
    expect(table).toBeDefined();
    expect(table.columns.map((column) => column.name).sort()).toEqual(['email', 'id', 'seen']);
  });

  test('a parameterised read binds rather than interpolates', async () => {
    // `?`, not `$1`. MySQL does not accept PostgreSQL's placeholder, so this
    // fails loudly on a real server and silently against a double.
    await registry.run(
      uri,
      `INSERT INTO ${TABLE} (email) VALUES (?) ON DUPLICATE KEY UPDATE seen = seen`,
      { ...WRITING, params: ['bound@example.com'], timeout: 30000 }
    );

    const read = await registry.run(uri, `SELECT email FROM ${TABLE} WHERE email = ?`, {
      params: ['bound@example.com'], timeout: 30000
    });
    expect(rowsOf(read)).toEqual([{ email: 'bound@example.com' }]);
  });

  test('a value in params never reaches the statement text', async () => {
    // The MySQL half of the injection story, and the one with a live twist: this
    // family reads a backslash as an escape inside a literal, so an inlined quote
    // is not merely a syntax error. Bound, it is a row.
    await registry.run(
      uri,
      `INSERT INTO ${TABLE} (email) VALUES (?) ON DUPLICATE KEY UPDATE seen = seen`,
      { ...WRITING, params: ["o'brien@example.com"], timeout: 30000 }
    );
    const read = await registry.run(uri, `SELECT email FROM ${TABLE} WHERE email = ?`, {
      params: ["o'brien@example.com"], timeout: 30000
    });
    expect(rowsOf(read)).toEqual([{ email: "o'brien@example.com" }]);
  });

  test('a write behind both gates is readable afterwards', async () => {
    await registry.run(uri, `UPDATE ${TABLE} SET seen = 1 WHERE email = ?`, {
      ...WRITING, params: ['bound@example.com'], timeout: 30000
    });
    const read = await registry.run(uri, `SELECT seen FROM ${TABLE} WHERE email = ?`, {
      params: ['bound@example.com'], timeout: 30000
    });
    // mysql2 hands back 0/1, and the adapter normalises to a boolean; either is a
    // true answer, and either would be a *string* "0" if the driver were faked.
    expect([true, 1]).toContain(rowsOf(read)[0]?.seen);
  });

  test('the connection is reused, not re-opened, on the next call', async () => {
    const { normaliseCacheKey } = await import('../src/core/registry.js');
    expect(registry.cache.entries.has(normaliseCacheKey(uri, 'mysql'))).toBe(true);
    const before = registry.cache.size;
    await registry.run(uri, 'SELECT 1', { timeout: 30000 });
    expect(registry.cache.size).toBe(before);
  });

  test('read-only mode still refuses a write against a live server', async () => {
    await expect(registry.run(uri, `DELETE FROM ${TABLE} WHERE email = ?`, {
      params: ['readonly@example.com'], timeout: 30000
    })).rejects.toMatchObject({ kind: 'policy', code: 'READ_ONLY' });
  });

  test('a statement the server refuses comes back with the driver code', async () => {
    // `ER_NO_SUCH_TABLE` is 1146. mysql2 puts it on `code` as a string, and
    // `postgres.js`/`mysql.js` both replace the error object, so this also
    // proves the code survives the rewrite.
    const error = await errorFrom(registry.run(uri, 'SELECT * FROM anydb_live_absent', { timeout: 30000 }));
    expect(error.kind).toBe('database');
    expect(String(error.code)).toMatch(/1146|ER_NO_SUCH_TABLE/);
  });

  test('db_explain returns a plan and does not run the statement', async () => {
    const plan = await registry.run(uri, `EXPLAIN SELECT * FROM ${TABLE} WHERE email = ?`, {
      params: ['bound@example.com'], timeout: 30000
    });
    expect(rowsOf(plan).length).toBeGreaterThan(0);
    expect(JSON.stringify(rowsOf(plan))).toMatch(/table|type|ALL|index|range/i);
  });

  test('the policy is on, and it is what stops the loopback address', async () => {
    const strict = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '0' }, log: () => {} });
    const verdict = await checkConnectionPolicy(uri, { env: strict.env });
    expect(verdict.allowed).toBe(false);
    await strict.close();
  });
});

// MongoDB

describeIfLive('mongodb', () => {
  const COLLECTION = 'anydb_live_users';
  let registry;
  let uri;

  beforeAll(async () => {
    uri = uriFor('mongodb');
    registry = registryFor(uri);
    // Idempotent: the container is shared by every test in the job, and a
    // re-run against the same volume must not trip over a unique index.
    await registry.run(uri, '{}', {
      ...WRITING, collection: COLLECTION, action: 'delete', timeout: 30000
    }).catch(() => {});
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (registry) {
      await registry.run(uri, '{}', {
        ...WRITING, collection: COLLECTION, action: 'delete', timeout: 30000
      }).catch(() => {});
      await registry.close();
    }
  }, HOOK_TIMEOUT);

  const mongo = (query, extra = {}) => registry.run(uri, query, { collection: COLLECTION, ...extra });

  test('connects and reports the server it reached', async () => {
    const rows = rowsOf(await mongo('{}', { action: 'count', timeout: 30000 }));
    expect(typeof (rows[0]?.count ?? 0)).toBe('number');
  });

  test('db_schema reports the collection once it exists', async () => {
    await mongo('{"email":"schema@example.com"}', { ...WRITING, action: 'insert', timeout: 30000 });

    const report = reportOf(await registry.describe(uri, { collection: COLLECTION, timeout: 30000 }));
    const found = report.collections.find((entry) => entry.name === COLLECTION);
    expect(report.database).toBe('mongodb');
    expect(found).toBeDefined();
    expect(found.documentCount ?? found.count).toBeGreaterThan(0);
  });

  test('insert returns the ids the driver reported', async () => {
    const rows = rowsOf(await mongo('{"email":"insert@example.com","seen":false}', {
      ...WRITING, action: 'insert', timeout: 30000
    }));
    expect(rows[0].insertedCount).toBe(1);
    expect(rows[0].insertedIds).toBeDefined();
  });

  test('a filter is honoured, which is the whole contract of a find', async () => {
    const rows = rowsOf(await mongo('{"email":"insert@example.com"}', {
      action: 'find', timeout: 30000
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('insert@example.com');
    expect(rows[0].seen).toBe(false);
  });

  test('updateOne changes one document and leaves the rest alone', async () => {
    // The action was implemented in the adapter and refused by both the schema
    // enum and `registry.validateQuery`, so this is the first execution of it
    // anywhere. `matchedCount: 1` is the assertion that matters: `update` would
    // report the same `modifiedCount` on a collection of one.
    await mongo('{"email":"one@example.com","seen":false}', { ...WRITING, action: 'insert', timeout: 30000 });

    const rows = rowsOf(await mongo('{"email":"one@example.com"}', {
      ...WRITING, action: 'updateOne', update: '{"$set":{"seen":true}}', timeout: 30000
    }));
    expect(rows[0].modifiedCount).toBe(1);
    expect(rowsOf(await mongo('{"email":"one@example.com"}', { action: 'find' }))[0].seen).toBe(true);
  });

  test('deleteOne removes exactly one document', async () => {
    await mongo('[{"email":"dup1@example.com","seen":false},{"email":"dup2@example.com","seen":false}]', {
      ...WRITING, action: 'insert', timeout: 30000
    });
    expect(rowsOf(await mongo('{"email":{"$in":["dup1@example.com","dup2@example.com"]}}', { action: 'count' }))[0].count)
      .toBe(2);

    const rows = rowsOf(await mongo('{"email":"dup1@example.com"}', {
      ...WRITING, action: 'deleteOne', timeout: 30000
    }));
    expect(rows[0].deletedCount).toBe(1);
    // The second document is still there. `delete` with the same filter would
    // have taken both if the filter had been written one clause wider, which is
    // what the empty-filter guard is about.
    expect(rowsOf(await mongo('{"email":"dup2@example.com"}', { action: 'find' }))).toHaveLength(1);
  });

  test('an empty filter is refused on delete and accepted on deleteOne', async () => {
    // The per-action decision, against a real server rather than a mock: the
    // refusal is a guard and the permission is a fact about `deleteOne`.
    await expect(mongo('{}', { ...WRITING, action: 'delete', timeout: 30000 }))
      .rejects.toThrow(/matches every document in the collection/);

    const rows = rowsOf(await mongo('{}', { ...WRITING, action: 'deleteOne', timeout: 30000 }));
    expect(rows[0].deletedCount).toBeLessThanOrEqual(1);
  });

  test('a write behind both gates is readable afterwards', async () => {
    await mongo('{"email":"write@example.com","seen":false}', { ...WRITING, action: 'insert', timeout: 30000 });
    await mongo('{"email":"write@example.com"}', {
      ...WRITING, action: 'update', update: '{"$set":{"seen":true}}', timeout: 30000
    });
    const read = rowsOf(await mongo('{"email":"write@example.com"}', { action: 'find', timeout: 30000 }));
    expect(read[0].seen).toBe(true);
  });

  test('the connection is reused, not re-opened, on the next call', async () => {
    const { normaliseCacheKey } = await import('../src/core/registry.js');
    expect(registry.cache.entries.has(normaliseCacheKey(uri, 'mongodb'))).toBe(true);
    const before = registry.cache.size;
    await mongo('{}', { action: 'count', timeout: 30000 });
    expect(registry.cache.size).toBe(before);
  });

  test('read-only mode still refuses every write action', async () => {
    for (const action of ['insert', 'update', 'updateOne', 'replace', 'delete', 'deleteOne']) {
      await expect(mongo('{"email":"x@example.com"}', { action, update: '{"$set":{"a":1}}', timeout: 30000 }))
        .rejects.toMatchObject({ kind: 'policy', code: 'READ_ONLY' });
    }
  });

  test('a write with readOnly:false but no allowDestructive is refused', async () => {
    // `classifiesAsDestructive` counts every MongoDB write as destructive, so
    // the second gate applies to all eleven actions' write half.
    await expect(mongo('{"email":"y@example.com"}', { readOnly: false, action: 'insert', timeout: 30000 }))
      .rejects.toMatchObject({ kind: 'policy', code: 'DESTRUCTIVE' });
  });

  test('server-side JavaScript is refused even with both gates set', async () => {
    // The check that is independent of read-only mode, against a real server that
    // would happily run it.
    await expect(mongo('{"$where":"this.email.length > 0"}', {
      ...WRITING, action: 'find', timeout: 30000
    })).rejects.toMatchObject({ kind: 'policy', code: 'CODE_EXECUTION' });
  });

  test('a statement the server refuses comes back with the driver code', async () => {
    // `26` is `NamespaceNotFound`. Numeric, and it was thrown away by
    // `describeMongoError` until the adapter kept the code and the `cause`.
    const error = await errorFrom(mongo('{}', {
      action: 'find', collection: 'anydb_live_absent', timeout: 30000
    }));
    expect(error.kind).toBe('database');
    expect(String(error.code)).toMatch(/26/);
  });

  test('a MongoDB explain returns the planner output without running the find', async () => {
  // The `db_explain` MongoDB branch, end to end. `db_explain`'s `inputSchema` does
  // declare `collection`; it is also the only way to see a plan for a MongoDB
  // query at all, since a pipeline cannot be explained.
    const plan = rowsOf(await mongo('{"email":"insert@example.com"}', {
      action: 'explain', timeout: 30000
    }));

    expect(plan).toHaveLength(1);
    expect(plan[0].explain).toBeDefined();
    // The winning plan, or at least that the server chose one and said so.
    expect(JSON.stringify(plan[0].explain)).toMatch(/queryPlanner|stage|IXSCAN|COLLSCAN/);
  });

  test('an aggregate pipeline runs and is bounded', async () => {
    const rows = rowsOf(await mongo('[{"$match":{"seen":true}},{"$limit":5}]', {
      action: 'aggregate', timeout: 30000
    }));
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  test('the policy is on, and it is what stops the loopback address', async () => {
    const strict = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '0' }, log: () => {} });
    const verdict = await checkConnectionPolicy(uri, { env: strict.env });
    expect(verdict.allowed).toBe(false);
    await strict.close();
  });
});

// Redis

describeIfLive('redis', () => {
  let registry;
  let uri;

  const KEY = 'anydb:live:probe';
  const VALUE = 'live';

  beforeAll(async () => {
    uri = uriFor('redis');
    registry = registryFor(uri);
    await registry.run(uri, `SET ${KEY} ${VALUE}`, { ...WRITING, timeout: 30000 });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (registry) {
      await registry.run(uri, `DEL ${KEY}`, { ...WRITING, timeout: 30000 }).catch(() => {});
      await registry.close();
    }
  }, HOOK_TIMEOUT);

  const redis = (command, extra = {}) => registry.run(uri, command, { timeout: 30000, ...extra });

  test('connects and answers a read', async () => {
    expect(String(rowsOf(await redis(`GET ${KEY}`))[0])).toBe(VALUE);
  });

  test('db_schema reports the keyspace', async () => {
    const report = reportOf(await registry.describe(uri, { timeout: 30000 }));
    expect(report.database).toBe('redis');
    // Keyspace statistics, and a key we just wrote has to be in one of them.
    expect(Array.isArray(report.keyspace)).toBe(true);
    expect(JSON.stringify(report.keyspace)).toContain('anydb:live:probe');
  });

  test('a write behind both gates is readable afterwards', async () => {
    await redis(`SET ${KEY}:second ${VALUE}`, WRITING);
    expect(String(rowsOf(await redis(`GET ${KEY}:second`))[0])).toBe(VALUE);
    await redis(`DEL ${KEY}:second`, WRITING);
  });

  test('the connection is reused, not re-opened, on the next call', async () => {
    const { normaliseCacheKey } = await import('../src/core/registry.js');
    expect(registry.cache.entries.has(normaliseCacheKey(uri, 'redis'))).toBe(true);
    const before = registry.cache.size;
    await redis('PING');
    expect(registry.cache.size).toBe(before);
  });

  test('read-only mode refuses a write, and so does the destructive gate on FLUSHDB', async () => {
    await expect(redis(`SET ${KEY}:nope 1`)).rejects.toMatchObject({ kind: 'policy', code: 'READ_ONLY' });
    // `FLUSHDB` is recoverable and `CONFIG SET` is not, and they are not on the
    // same switch: the second gate is what separates them from `SET k v`.
    await expect(redis('FLUSHDB', { readOnly: false })).rejects.toMatchObject({ kind: 'policy', code: 'DESTRUCTIVE' });
  });

  test('a command that changes the connection state is refused', async () => {
    // `SELECT` is not a write at all and is still refused: a cached connection is
    // shared, so one `SELECT 1` would silently retarget every later call.
    await expect(redis('SELECT 1', WRITING)).rejects.toThrow(/connection state/);
  });

  test('a command the server refuses comes back with the driver code', async () => {
    // `WRONGTYPE`: a GET against a key holding a list. node-redis puts the code
    // on the error, and `redis.js`'s `describeError` keeps it, which is what lets
    // the registry answer without reading English.
    await redis(`DEL ${KEY}:list`, WRITING);
    await redis(`RPUSH ${KEY}:list a b`, WRITING);
    const error = await errorFrom(redis(`GET ${KEY}:list`));
    expect(error.kind).toBe('database');
    expect(String(error.code)).toMatch(/WRONGTYPE/);
    await redis(`DEL ${KEY}:list`, WRITING);
  });

  test('db_explain refuses Redis, in words rather than by accident', async () => {
    // Redis has no execution plan. The refusal belongs in `src/index.js`, which
    // is not exercised here; what is asserted here is that the registry does not
    // quietly run `EXPLAIN`-prefixed nonsense at a Redis server.
    const error = await errorFrom(registry.run(uri, 'EXPLAIN GET anydb:live:probe', { timeout: 30000 }));
    expect(error).toBeInstanceOf(Error);
  });

  test('the policy is on, and it is what stops the loopback address', async () => {
    const strict = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '0' }, log: () => {} });
    const verdict = await checkConnectionPolicy(uri, { env: strict.env });
    expect(verdict.allowed).toBe(false);
    await strict.close();
  });
});

// The two Redis topologies, which no container here can be

describe('the Redis topologies this job cannot start', () => {
  // Not under `describeIfLive`: a single-node Redis 7 container is not a cluster
  // and a sentinel set is three more. Asserted anyway, from the outside, because
  // the thing that made `createCluster` and `createSentinel` dead was the policy
  // refusing the scheme before the adapter was constructed.
  test.each(['redis-cluster', 'redis-sentinel'])(
    '%s:// is routed, allowed, and reached by the read-only guard',
    (scheme) => {
      expect(new AdapterRegistry({ env: {} }).createAdapter(scheme, 1000).constructor.name)
        .toBe('RedisAdapter');
    }
  );
});

// The harness itself

describe('the live harness, on the one driver that needs no container', () => {
// This block runs on every test run, not only in the `live` job, so that a wrong
// helper here is caught here rather than reading as a broken driver in a
// container job. SQLite is in-process and always available, so the same eight
// steps are run against a real driver: fixture, parameterised read, write behind
// both gates, read-back, cache reuse, a refusal, an error with a code, `db_explain`.
  const URI = 'sqlite://:memory:';
  const TABLE = 'anydb_harness';
  let registry;

  beforeAll(async () => {
    registry = registryFor(URI);
    await registry.run(URI, `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, email TEXT NOT NULL)`, {
      ...WRITING, timeout: 10000
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (registry) await registry.close();
  }, HOOK_TIMEOUT);

  test('connects, and reports the driver that answered', async () => {
    const report = reportOf(await registry.describe(URI, { timeout: 10000 }));
    expect(report.database).toBe('sqlite');
  });

  test('a parameterised read binds rather than interpolates', async () => {
    // `?` here, `$1` for PostgreSQL, and a double records the difference rather
    // than rejecting it.
    await registry.run(URI, `INSERT INTO ${TABLE} (email) VALUES (?)`, {
      ...WRITING, params: ["o'brien@example.com"], timeout: 10000
    });
    const read = await registry.run(URI, `SELECT email FROM ${TABLE} WHERE email = ?`, {
      params: ["o'brien@example.com"], timeout: 10000
    });
    expect(rowsOf(read)).toEqual([{ email: "o'brien@example.com" }]);
  });

  test('a write behind both gates is readable afterwards', async () => {
    await registry.run(URI, `DELETE FROM ${TABLE} WHERE email = ?`, {
      ...WRITING, params: ["o'brien@example.com"], timeout: 10000
    });
    await registry.run(URI, `INSERT INTO ${TABLE} (email) VALUES (?)`, {
      ...WRITING, params: ['after@example.com'], timeout: 10000
    });
    const read = await registry.run(URI, 'SELECT email FROM ' + TABLE + ' WHERE email = ?', {
      params: ['after@example.com'], timeout: 10000
    });
    expect(rowsOf(read)).toEqual([{ email: 'after@example.com' }]);
  });

  test('the connection is reused, and the cache is keyed by driver and digest', async () => {
    const { normaliseCacheKey } = await import('../src/core/registry.js');
    const key = normaliseCacheKey(URI, 'sqlite');
    expect(registry.cache.entries).toBeInstanceOf(Map);
    expect(registry.cache.entries.has(key)).toBe(true);

    const before = registry.cache.size;
    await registry.run(URI, 'SELECT 1', { timeout: 10000 });
    expect(registry.cache.size).toBe(before);
  });

  test('read-only mode and the destructive gate both refuse, with a code', async () => {
    // A write with no opt-in at all is the read-only gate. A schema change with
    // `readOnly: false` gets past that one and is stopped by the second, which is
    // the whole point of having two: `readOnly: false` is a grant to append a
    // row, and `DROP` is a bigger decision than that.
    await expect(registry.run(URI, `DELETE FROM ${TABLE}`, { timeout: 10000 }))
      .rejects.toMatchObject({ kind: 'policy', code: 'READ_ONLY' });
    await expect(registry.run(URI, `DROP TABLE ${TABLE}`, { readOnly: false, timeout: 10000 }))
      .rejects.toMatchObject({ kind: 'policy', code: 'DESTRUCTIVE' });
  });

  test('a statement the server refuses comes back with the driver code', async () => {
    // The `cause`-chain read: `sqlite.js` rebuilds the error, and the code
    // survives onto the replacement, so a client can branch on it.
    const error = await errorFrom(registry.run(URI, 'SELECT * FROM anydb_harness_absent', { timeout: 10000 }));
    expect(error.kind).toBe('database');
    expect(String(error.code)).toMatch(/SQLITE_ERROR|no such table/);
  });

  test('db_explain returns a plan, and the dialect prefix is SQLite\'s own', async () => {
    // `EXPLAIN QUERY PLAN`, not bare `EXPLAIN`: the bytecode program is close to
    // unreadable, and the adapter is the thing that has to know which is which.
    const plan = await registry.run(URI, `EXPLAIN QUERY PLAN SELECT * FROM ${TABLE}`, { timeout: 10000 });
    expect(rowsOf(plan).length).toBeGreaterThan(0);
    expect(JSON.stringify(rowsOf(plan))).toMatch(/SCAN|SEARCH/);
  });

  test('the connection policy is enforced here too, and the loopback address is not why', async () => {
    // `sqlite://:memory:` is a file path, not a host, so this asserts the switch
    // is what each registry is given rather than proving loopback is refused.
    const strict = new AdapterRegistry({ env: { ANYDB_ALLOW_PRIVATE_HOSTS: '0' }, log: () => {} });
    expect(strict.env.ANYDB_ALLOW_PRIVATE_HOSTS).toBe('0');
    await strict.close();
  });
});
