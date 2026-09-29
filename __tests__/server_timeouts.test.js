/**
 * The runaway-statement tests, in a file of their own.
 *
 * SQLite cannot cancel a statement that is already running. `timeout-utils.js`
 * rejects the *caller* after the budget, and `registry.withConnection` calls
 * `adapter.abort()` -- which for SQLite is `db.interrupt()` -- but a long
 * recursive CTE in the C layer does not return to a point where the interrupt
 * flag is checked, so the abandoned statement keeps occupying its handle until it
 * finishes on its own. `README.md` documents this; it is SQLite, not a bug.
 *
 * The abandoned work is *process-wide*, which is why these tests are here. Run in
 * the same server process as the `db_schema` tests, each of the two that followed
 * took 3.4 seconds instead of a few milliseconds. In their own worker the cost is
 * confined to this file.
 *
 * The row counts are also reduced: the assertion is that a statement still running
 * at its deadline produces a timeout error and a *usable next call*, not that
 * SQLite can count to a particular number before anyone interrupts it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = join(process.cwd(), 'src', 'index.js');

/**
 * A recursive CTE that is still counting long after any plausible timeout.
 *
 * Four million rows is comfortably more than the few hundred milliseconds these
 * tests allow on any machine, and the *shape* is what matters: SQLite walks a
 * recursive CTE in C, without returning to the event loop, so the interrupt flag
 * is not observed until it is done.
 */
const RUNAWAY_CTE =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000) SELECT count(*) AS n FROM c';

describe('a statement that runs past its timeout', () => {
  let client;
  let dirs;

  beforeAll(async () => {
    dirs = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      cwd: process.cwd(),
      stderr: 'pipe'
    });
    client = new Client({ name: 'timeout-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    // The child is closed first, so the SQLite handle it is holding is released
    // before the directory it is holding open is removed. On Windows the other
    // order leaves the file locked and the removal silently fails, which is how
    // temp directories accumulate.
    await client?.close();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })
      .catch(() => {})));
  });

  const tempDir = async (prefix) => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  const call = async (args) => {
    const res = await client.callTool({ name: 'db_query', arguments: args });
    return { isError: !!res.isError, text: res.content?.[0]?.text ?? '', structured: res.structuredContent };
  };

  test('reports a timeout and says what to do about it', async () => {
    const { isError, text, structured } = await call({
      uri: 'sqlite://:memory:',
      query: RUNAWAY_CTE,
      timeout: 200
    });

    expect(isError).toBe(true);
    expect(text).toMatch(/^DATABASE_ERROR:/);
    expect(text).toMatch(/SUGGESTION:/);
    expect(structured.error.kind).toBe('timeout');
  }, 30000);

  test('leaves the server able to answer the next call', async () => {
    const dir = await tempDir('anydb-starve-');
    const uri = `sqlite://${join(dir, 's.db').replace(/\\/g, '/')}`;

    await call({ uri, query: RUNAWAY_CTE, timeout: 200 });

    // A *file* database, so this exercises a different connection from the one
    // still running the abandoned CTE. The point is that one dead statement does
    // not take the rest of the server with it.
    const after = await call({ uri, query: 'SELECT 1 AS still_here' });
    expect(after.isError).toBe(false);
    expect(JSON.parse(after.text)).toEqual([{ still_here: 1 }]);
  }, 30000);
});

describe('a call the client cancels', () => {
  let client;
  let dirs;

  beforeAll(async () => {
    dirs = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      cwd: process.cwd(),
      stderr: 'pipe'
    });
    client = new Client({ name: 'cancel-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })
      .catch(() => {})));
  });

  const tempDir = async (prefix) => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  const call = async (args) => {
    const res = await client.callTool({ name: 'db_query', arguments: args });
    return { isError: !!res.isError, text: res.content?.[0]?.text ?? '', structured: res.structuredContent };
  };

  /**
   * The SDK client rejects locally the moment its own signal aborts -- it removes
   * the pending response handler -- so the server's answer is never observed from
   * here. What *is* observable is the effect the cancellation is supposed to have
   * on the server, which is the part that used not to happen at all.
   */
  test('abandons the connection instead of leaving the statement on it', async () => {
    const dir = await tempDir('anydb-cancel-');
    const uri = `sqlite://${join(dir, 'c.db').replace(/\\/g, '/')}`;

    // Open and cache a connection for this URI first, so the cancel has something
    // to abandon.
    await call({ uri, query: 'SELECT 1 AS warm' });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();

    await expect(client.callTool(
      { name: 'db_query', arguments: { uri, query: RUNAWAY_CTE, timeout: 60000 } },
      undefined,
      { signal: controller.signal }
    )).rejects.toThrow(/abort/i);

    // And it aborts promptly, rather than leaving the caller to discover the
    // cancellation when the 60 second budget expires.
    expect(Date.now() - started).toBeLessThan(10000);

    const after = Date.now();
    const result = await call({ uri, query: 'SELECT 1 AS still_here' });
    // A single SQLite handle serialises statements, so if the abandoned one were
    // still on the cached handle this call would queue behind a multi-million-row
    // count and take seconds. A fresh handle answers in milliseconds, which is
    // the observable proof that the connection was dropped and aborted.
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual([{ still_here: 1 }]);
    expect(Date.now() - after).toBeLessThan(2000);
  }, 30000);
});

describe('progress notifications', () => {
  let client;
  let notifications;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      cwd: process.cwd(),
      stderr: 'pipe',
      // One millisecond, so a query that finishes in ten still crosses the
      // threshold: the threshold is a property of the host's patience, which is
      // what the knob is for.
      env: { ...process.env, ANYDB_PROGRESS_MS: '1' }
    });
    client = new Client({ name: 'progress-client', version: '1.0.0' }, { capabilities: {} });
    notifications = [];
    client.setNotificationHandler(
      ProgressNotificationSchema,
      (notification) => { notifications.push(notification.params); }
    );
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client?.close();
  });

  test('a call with a progress token is told the call is alive', async () => {
    notifications.length = 0;
    const res = await client.callTool({
      name: 'db_query',
      arguments: { uri: 'sqlite://:memory:', query: 'SELECT 1 AS ok' },
      _meta: { progressToken: 'probe-1' },
    });

    expect(res.isError).toBeFalsy();
    expect(notifications.length).toBeGreaterThan(0);
    const first = notifications[0];
    expect(first.progressToken).toBe('probe-1');
    // Phase, never the statement: a progress frame is a log line, and a statement
    // routinely carries a literal that is somebody's personal data.
    expect(first.message).not.toMatch(/SELECT/i);
    expect(typeof first.progress).toBe('number');
    // No `total`: a query has no row count until it has finished, and a client
    // that renders a percentage from a fabricated total renders a wrong one.
    expect(first.total).toBeUndefined();
  });

  test('a call with no progress token gets no notification', async () => {
    notifications.length = 0;
    await client.callTool({ name: 'db_query', arguments: { uri: 'sqlite://:memory:', query: 'SELECT 1 AS ok' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(notifications).toEqual([]);
  });
});
