// Redis Cluster and Redis Sentinel, against real ones.
//
// Split out from `test_policy_live.test.js` because the other four backends are
// one container each and these are not: a cluster is three masters, a sentinel
// set is a master, a replica and a sentinel. Neither fits a `services:` block,
// so `scripts/ci-redis-topologies.sh` starts them with `--network host` and this
// file is the only thing that talks to them.
//
// What these prove, and what they do not:
//
//   Proved: that `connectCluster` hands the driver options the driver accepts.
//   The sentinel branch passed `sentinel` and `nodeClient`, which this driver
//   version does not read, and omitted the required `sentinelRootNodes`, so it
//   could never have connected - the unit tests could not see it because they
//   assert against a mock that records whatever it is given. Also proved: that a
//   key written through the topology is readable back through it, that
//   `db_schema` answers, that the adapter reports itself healthy, and that a
//   server refusal comes back as a database error with the server's word intact.
//
//   Not proved: failover. A sentinel promotes a replica and a cluster moves a
//   slot, both take seconds, and neither behaviour lives in this codebase - it is
//   Redis's and the driver's.

import { AdapterRegistry, normaliseCacheKey } from '../src/core/registry.js';

const CLUSTER = process.env.ANYDB_TEST_REDIS_CLUSTER;
const SENTINEL = process.env.ANYDB_TEST_REDIS_SENTINEL;

const HOOK_TIMEOUT = 60000;
const CALL = { timeout: 30000 };

/** The adapter the registry cached for a URI, which is the only place `cluster` is readable. */
const adapterFor = (registry, uri) => registry.cache.entries.get(normaliseCacheKey(uri, 'redis'));

/** For `db_schema` the envelope's `rows` is the report itself, not an array. */
const reportOf = (envelope) => {
  if (Array.isArray(envelope?.rows)) return envelope.rows[0] ?? {};
  if (envelope?.rows && typeof envelope.rows === 'object') return envelope.rows;
  return envelope ?? {};
};

const rowsOf = (envelope) => {
  const rows = envelope?.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`expected an array of rows, got ${JSON.stringify(envelope).slice(0, 200)}`);
  }
  return rows.map((r) => (r && typeof r === 'object' && 'value' in r ? r.value : r));
};

const isError = (envelope) => Boolean(envelope?.isError) || Boolean(envelope?.error);

for (const [label, uri, kind] of [
  ['Redis Cluster', CLUSTER, 'cluster'],
  ['Redis Sentinel', SENTINEL, 'sentinel'],
]) {
  const describeIfStarted = uri ? describe : describe.skip;

  describeIfStarted(`${label} (live)`, () => {
    let registry;

    beforeAll(async () => {
      registry = new AdapterRegistry({ env: {} });
      // PING is what forces the adapter to be constructed and connected, so it
      // is the cheapest way to make the topology do its work.
      await registry.run(uri, 'PING', CALL);
    }, HOOK_TIMEOUT);

    afterAll(async () => {
      if (registry) await registry.close().catch(() => {});
    }, HOOK_TIMEOUT);

    test('connected through the topology, and says so', () => {
      const adapter = adapterFor(registry, uri);
      expect(adapter).toBeDefined();
      // Set by `connectCluster`, and only there. If it were false the URI would
      // have gone to `createClient` instead, which fails with a DNS error about a
      // name that does not exist.
      expect(adapter.cluster).toBe(true);
      expect(adapter.isHealthy()).toBe(true);
    });

    test('a write is readable afterwards', async () => {
      const key = `anydb:topology:${kind}`;
      const value = `v-${kind}`;

      expect(isError(await registry.run(uri, `SET ${key} ${value}`, { readOnly: false, ...CALL }))).toBe(false);
      // A separate call, and a value that was not written by this same code
      // path, so a cached answer cannot pass for a round trip.
      expect(String(rowsOf(await registry.run(uri, `GET ${key}`, { readOnly: true, ...CALL }))[0] ?? ''))
        .toBe(value);
      expect(isError(await registry.run(uri, `DEL ${key}`, { readOnly: false, ...CALL }))).toBe(false);
    });

    test('db_schema describes the keyspace through it', async () => {
      const report = reportOf(await registry.describe(uri, CALL));
      expect(report.database).toBe('redis');
      expect(report).toHaveProperty('keyspace');
    });

    test('a refused command comes back as a database error, not a crash', async () => {
      // WRONGTYPE: a GET against a key holding a list. Proves the error path is
      // reached through this topology, and that the server's word survives --
      // node-redis 6 puts no `code` on a server reply, so the message is the only
      // channel, which is what the documentation now says.
      const key = `anydb:topology:${kind}:list`;
      await registry.run(uri, `DEL ${key}`, { readOnly: false, ...CALL });
      await registry.run(uri, `RPUSH ${key} a b`, { readOnly: false, ...CALL });

      const envelope = await registry.run(uri, `GET ${key}`, { readOnly: true, ...CALL });
      expect(isError(envelope)).toBe(true);
      const text = JSON.stringify(envelope);
      expect(text).toMatch(/WRONGTYPE/);
    });
  });
}

// Said out loud, so a green run of this file is not mistaken for coverage: when
// neither variable is set the describes above are not registered at all, and
// that is a fact about the environment rather than a pass.
if (!CLUSTER && !SENTINEL) {
  describe('the Redis topologies (live)', () => {
    test('did not run: ANYDB_TEST_REDIS_CLUSTER and ANYDB_TEST_REDIS_SENTINEL are unset', () => {
      expect(CLUSTER).toBeUndefined();
      expect(SENTINEL).toBeUndefined();
    });
  });
}
