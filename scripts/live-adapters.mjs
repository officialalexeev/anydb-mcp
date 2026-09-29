#!/usr/bin/env node
/**
 * Drive the four non-SQLite adapters against live servers.
 *
 * WHY THIS EXISTS
 * ---------------
 * `__tests__/test_adapters_integration.test.js` says so in its own header:
 *
 *     "What this file cannot do is talk to a real server. There is no PostgreSQL,
 *      MySQL, MongoDB or Redis in this environment, so those four are driven
 *      through the documented shape of their own driver and SQLite runs against
 *      the real one."
 *
 * That is four of five databases with no integration coverage, and `__tests__/README.md`
 * states the consequence: the live check is not automated, so CI has no such
 * servers. A faithful double of `pg` proves the adapter *calls* `pg` correctly; it
 * cannot prove that `statement_timeout` is spelled the way the server spells it,
 * that a MySQL error code reaches `classifyError`, or that a MongoDB cursor
 * actually yields.
 *
 * This script is the live half. It goes through the real `AdapterRegistry` -- the
 * same routing, the same policy, the same cache, the same envelope a tool call
 * gets -- and asserts a round trip per backend: a read, a write, a read-back that
 * has to see the write, and a `describe`.
 *
 * IT IS NOT A SUBSTITUTE FOR THE JEST SUITES
 * -------------------------------------------
 * The jest suites are still not live-aware: they read no environment variable and
 * have no branch that turns on when a server is present. Wiring that up is
 * outstanding work in `__tests__/`, not here. What this script gives CI today is a
 * job that *fails* when a driver is broken against a real server, and it gives
 * whoever writes those tests the env-var names and the fixtures to use.
 *
 *   ANYDB_TEST_POSTGRES   postgres://user:pass@host:5432/db
 *   ANYDB_TEST_MYSQL      mysql://user:pass@host:3306/db
 *   ANYDB_TEST_MONGODB    mongodb://host:27017/db
 *   ANYDB_TEST_REDIS      redis://host:6379
 *
 * A backend whose variable is absent is skipped and named as skipped. One that is
 * present and unreachable is a failure: "I configured it" and "it did not work"
 * are different answers, and only the first is a skip.
 *
 * WHY `ANYDB_ALLOW_PRIVATE_HOSTS` IS SET HERE
 * -------------------------------------------
 * `checkConnectionPolicy` refuses private and loopback addresses by default, and
 * every one of these databases is on `127.0.0.1` in CI. The switch is set for this
 * process only, deliberately: a service container is not a threat model, and the
 * default exists to stop a model reaching a metadata endpoint from a real
 * deployment. A suite that needed the switch in production would not be a suite,
 * it would be a deployment.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdapterRegistry } from '../src/core/registry.js';

const MARKER = '##anydb-live##';

const BACKENDS = [
  {
    name: 'postgres',
    env: 'ANYDB_TEST_POSTGRES',
    // `ci_pg` with a serial column, so a write can be read back in order and the
    // assertion does not depend on the server's default ordering.
    setup: 'CREATE TABLE IF NOT EXISTS anydb_live (id SERIAL PRIMARY KEY, note TEXT NOT NULL)',
    write: "INSERT INTO anydb_live (note) VALUES ('live') RETURNING id",
    read: 'SELECT id, note FROM anydb_live ORDER BY id DESC LIMIT 1',
    readOnly: false,
    destructive: true,
  },
  {
    name: 'mysql',
    env: 'ANYDB_TEST_MYSQL',
    setup: 'CREATE TABLE IF NOT EXISTS anydb_live (id INT AUTO_INCREMENT PRIMARY KEY, note VARCHAR(64) NOT NULL)',
    write: 'INSERT INTO anydb_live (note) VALUES (?)',
    params: ['live'],
    read: 'SELECT id, note FROM anydb_live ORDER BY id DESC LIMIT 1',
    readOnly: false,
    destructive: true,
  },
  {
    name: 'mongodb',
    env: 'ANYDB_TEST_MONGODB',
    setup: null,
    write: '{"note":"live"}',
    // action `insert` returns the id; the read-back is a find.
    read: '{"note":"live"}',
    collection: 'anydb_live',
    readOnly: false,
  },
  {
    name: 'redis',
    env: 'ANYDB_TEST_REDIS',
    setup: null,
    // Redis has no schema, so the round trip is SET then GET, and `describe` is
    // only asked to come back with a keyspace at all.
    write: 'SET anydb:live live',
    read: 'GET anydb:live',
    readOnly: false,
  },
];

let failures = 0;

const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

const rowsOf = (outcome) => (Array.isArray(outcome?.rows) ? outcome.rows : []);
const firstRow = (rows) => (rows[0] && typeof rows[0] === 'object' ? rows[0] : {});

/**
 * One backend, end to end, through the real registry.
 *
 * @param {object} backend - One of `BACKENDS`
 * @param {string} uri
 */
async function drive(backend, uri) {
  const registry = new AdapterRegistry({
    env: { ...process.env, ANYDB_ALLOW_PRIVATE_HOSTS: '1' },
    log: () => {},
  });

  try {
    const protocol = uri.split('://')[0].toLowerCase();
    const policy = { timeout: 20000, readOnly: true };

    if (backend.setup) {
      const created = await registry.run(uri, backend.setup, {
        ...policy, readOnly: false, allowDestructive: true,
      });
      check(`${backend.name}: DDL runs with both gates`, created !== undefined);
    }

    if (backend.name === 'mongodb') {
      const inserted = await registry.run(uri, backend.write, {
        ...policy, readOnly: false, collection: backend.collection, action: 'insert',
      });
      check(`${backend.name}: insert returns an id`, Boolean(rowsOf(inserted)[0]?.insertedId));
    } else {
      const written = await registry.run(uri, backend.write, {
        ...policy, params: backend.params, readOnly: false, allowDestructive: backend.destructive,
      });
      check(`${backend.name}: a write is accepted`, written !== undefined);
    }

    const read = await registry.run(uri, backend.read, {
      ...policy,
      ...(backend.collection ? { collection: backend.collection, action: 'find' } : {}),
    });
    const row = firstRow(rowsOf(read));

    if (backend.name === 'redis') {
      check(`${backend.name}: the read-back sees the write`, String(row) === 'live' || String(rowsOf(read)[0]) === 'live',
        String(rowsOf(read)[0] ?? '').slice(0, 40));
    } else {
      check(`${backend.name}: the read-back sees the write`,
        Object.values(row).some((value) => String(value) === 'live'),
        JSON.stringify(row).slice(0, 60));
    }

    const report = await registry.describe(uri, { timeout: 20000 });
    check(`${backend.name}: describe returns a report`,
      report && typeof report === 'object' && 'database' in report, JSON.stringify(report).slice(0, 60));

    check(`${backend.name}: the cache holds a live connection after all of it`,
      registry.cache.size >= 1, `${registry.cache.size} entries`);
  } finally {
    await registry.close().catch(() => {});
  }
}

console.log('live adapters');
const dir = await mkdtemp(join(tmpdir(), 'anydb-live-'));

try {
  for (const backend of BACKENDS) {
    const uri = process.env[backend.env];
    if (!uri) {
      console.log(`  skip ${backend.name}: ${backend.env} is not set`);
      continue;
    }
    console.log(`\n  ${backend.name} (${uri.replace(/\/\/[^@]*@/, '//***@')})`);
    try {
      await drive(backend, uri);
    } catch (error) {
      // Not skipped: it was configured, and it did not work.
      check(`${backend.name}: round trip`, false, error?.message ?? String(error));
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log('');
console.log(MARKER + JSON.stringify({ failures }));
console.log(failures ? `\n${failures} check(s) failed` : '\nall live adapters answered');
process.exit(failures ? 1 : 0);
