// Which layer fails: ours, or the driver's?
//
// Every topology test currently dies with a TypeError from inside node-redis on
// the first command, for both createCluster and createSentinel. Our adapter
// builds the options; the driver consumes them. This drives the driver with
// nothing of ours in the path, using the same endpoints the topology script
// exports, so the answer is a fact about one layer rather than a guess about
// two.
//
// Run: node scripts/probe-redis-driver.mjs

import { createCluster, createSentinel } from 'redis';

const CLUSTER = process.env.ANYDB_TEST_REDIS_CLUSTER;
const SENTINEL = process.env.ANYDB_TEST_REDIS_SENTINEL;

const notice = (title, message) => console.log(`::notice title=${title}::${message}`);
const report = async (label, make) => {
  const started = Date.now();
  let client;
  try {
    client = make();
    await client.connect();
    // A keyed command, so a cluster has a slot to route to.
    const pong = await client.sendCommand(['PING']).catch((e) => `sendCommand failed: ${e.message}`);
    notice(`${label} connected`, `${Date.now() - started}ms; PING -> ${String(pong).slice(0, 60)}`);
    return true;
  } catch (e) {
    const where = (e.stack || '').split('\n').slice(1, 4).map((l) => l.trim()).join(' | ');
    notice(`${label} FAILED`, `${e.constructor.name}: ${e.message} :: ${where.slice(0, 220)}`);
    return false;
  } finally {
    if (client) {
      await Promise.race([
        Promise.resolve(client.close?.()).catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
  }
};

if (CLUSTER) {
  const { hostname, port } = new URL(CLUSTER.replace('redis-cluster://', 'redis://'));
  const root = { host: hostname, port: Number(port) };
  // Both shapes, because it is not established which one the cluster client wants.
  await report('cluster defaults only', () => createCluster({ rootNodes: [root] }));
  await report('cluster +useReplicas', () => createCluster({ rootNodes: [root], useReplicas: false }));
} else {
  notice('cluster', 'ANYDB_TEST_REDIS_CLUSTER is not set, so this half did not run');
}

if (SENTINEL) {
  const u = new URL(SENTINEL.replace('redis-sentinel://', 'redis://'));
  const root = { host: u.hostname, port: Number(u.port) };
  await report('sentinel', () => createSentinel({
    name: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'mymaster',
    sentinelRootNodes: [root],
  }));
} else {
  notice('sentinel', 'ANYDB_TEST_REDIS_SENTINEL is not set, so this half did not run');
}
