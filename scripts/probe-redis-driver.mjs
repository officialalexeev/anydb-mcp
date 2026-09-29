// Which layer fails: ours, or the driver's?
//
// Every topology test died with a TypeError from inside node-redis on the first
// command. The adapter builds the options; the driver consumes them. This drives
// the driver with nothing of ours in the path, against the same endpoints the
// topology script exports, and tries every root-node shape on the table - because
// the two clients do not agree on one, which is the whole difficulty: a cluster's
// rootNodes and a sentinel set's sentinelRootNodes are typed differently in the
// same driver, and using the wrong one does not fail at construction.
//
// Reports everything it tried, so the answer arrives whether or not any variant
// works.
//
// Run: node scripts/probe-redis-driver.mjs

import { createCluster, createSentinel } from 'redis';

const CLUSTER = process.env.ANYDB_TEST_REDIS_CLUSTER;
const SENTINEL = process.env.ANYDB_TEST_REDIS_SENTINEL;

const notice = (title, message) => console.log(`::notice title=${title}::${message}`);

const attempt = async (label, make, probe) => {
  const started = Date.now();
  let client;
  try {
    client = make();
    await client.connect();
    const answer = await probe(client);
    notice(`OK  ${label}`, `${Date.now() - started}ms, ${answer}`);
    return true;
  } catch (e) {
    const frame = (e.stack || '').split('\n').slice(1, 3).map((l) => l.trim()).join(' | ');
    notice(`FAIL ${label}`, `${e.constructor.name}: ${e.message} :: ${frame.slice(0, 200)}`);
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
  const u = new URL(CLUSTER.replace('redis-cluster://', 'redis://'));
  const host = u.hostname;
  const port = Number(u.port);
  const byUrl = { url: `redis://${host}:${port}` };
  const byHostPort = { host, port };

  await attempt('cluster rootNodes {url}', () => createCluster({ rootNodes: [byUrl] }),
    (c) => `PING -> ${String(await c.sendCommand(['PING']).catch((e) => `sendCommand: ${e.message}`)).slice(0, 70)}`);
  await attempt('cluster rootNodes {host,port}', () => createCluster({ rootNodes: [byHostPort] }),
    (c) => `PING -> ${String(await c.sendCommand(['PING']).catch((e) => `sendCommand: ${e.message}`)).slice(0, 70)}`);
  await attempt('cluster {url} + useReplicas:false', () => createCluster({ rootNodes: [byUrl], useReplicas: false }),
    (c) => `masters=${c.masters?.length}`);
  await attempt('cluster {host,port} + useReplicas:false', () => createCluster({ rootNodes: [byHostPort], useReplicas: false }),
    (c) => `masters=${c.masters?.length}`);
} else {
  notice('cluster', 'ANYDB_TEST_REDIS_CLUSTER is not set, so this half did not run');
}

if (SENTINEL) {
  const u = new URL(SENTINEL.replace('redis-sentinel://', 'redis://'));
  const host = u.hostname;
  const port = Number(u.port);
  const name = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'mymaster';

  for (const [label, node] of [
    ['{host,port}', { host, port }],
    ['{url}', { url: `redis://${host}:${port}` }],
  ]) {
    await attempt(`sentinel sentinelRootNodes ${label}`,
      () => createSentinel({ name, sentinelRootNodes: [node] }),
      (c) => `isReady=${c.isReady}`);
  }
} else {
  notice('sentinel', 'ANYDB_TEST_REDIS_SENTINEL is not set, so this half did not run');
}
