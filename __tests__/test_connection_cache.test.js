import { ConnectionCache, installShutdownHandlers } from '../src/core/connection-cache.js';

const stubAdapter = (overrides = {}) => ({
  queryTimeout: 0,
  connect: jest.fn().mockResolvedValue(undefined),
  execute: jest.fn().mockResolvedValue([{ ok: 1 }]),
  close: jest.fn().mockResolvedValue(undefined),
  abort: jest.fn(),
  isHealthy: jest.fn().mockResolvedValue(true),
  ...overrides
});

const key = 'postgres://h/d';

describe('ConnectionCache', () => {
  let cache;

  beforeEach(() => {
    cache = new ConnectionCache({ enabled: true, maxEntries: 3, idleTtlMs: 1000, reapIntervalMs: 0 });
  });

  afterEach(() => {
    cache.stop();
  });

  describe('reuse', () => {
    test('creates a connection on first use', async () => {
      const create = jest.fn().mockResolvedValue(stubAdapter());
      const { cached } = await cache.acquire(key, create, 30000);

      expect(create).toHaveBeenCalledTimes(1);
      expect(cached).toBe(false);
    });

    test('reuses a healthy connection', async () => {
      const create = jest.fn().mockResolvedValue(stubAdapter());
      const first = await cache.acquire(key, create, 30000);
      first.release();

      const second = await cache.acquire(key, create, 30000);

      expect(create).toHaveBeenCalledTimes(1);
      expect(second.cached).toBe(true);
      expect(second.adapter).toBe(first.adapter);
    });

    test('verifies a reused connection before handing it over', async () => {
      const adapter = stubAdapter();
      const create = jest.fn().mockResolvedValue(adapter);
      const first = await cache.acquire(key, create, 30000);
      first.release();

      await cache.acquire(key, create, 30000);

      // Assumed-alive connections are the failure mode this guards against.
      expect(adapter.isHealthy).toHaveBeenCalledTimes(1);
    });

    test('rebuilds a connection the server closed while it was idle', async () => {
      const dead = stubAdapter({ isHealthy: jest.fn().mockResolvedValue(false) });
      const fresh = stubAdapter();
      const create = jest.fn()
        .mockResolvedValueOnce(dead)
        .mockResolvedValueOnce(fresh);

      const first = await cache.acquire(key, create, 30000);
      first.release();
      const second = await cache.acquire(key, create, 30000);

      expect(create).toHaveBeenCalledTimes(2);
      expect(second.adapter).toBe(fresh);
      expect(dead.close).toHaveBeenCalled();
    });

    test('treats a health check that throws as unhealthy', async () => {
      const broken = stubAdapter({
        isHealthy: jest.fn(() => { throw new Error('socket gone'); })
      });
      const create = jest.fn()
        .mockResolvedValueOnce(broken)
        .mockResolvedValueOnce(stubAdapter());

      const first = await cache.acquire(key, create, 30000);
      first.release();
      const second = await cache.acquire(key, create, 30000);

      expect(second.adapter).not.toBe(broken);
    });

    test('rebuilds when isHealthy is missing', async () => {
      const legacy = stubAdapter();
      delete legacy.isHealthy;
      const create = jest.fn()
        .mockResolvedValueOnce(legacy)
        .mockResolvedValueOnce(stubAdapter());

      const first = await cache.acquire(key, create, 30000);
      first.release();
      const second = await cache.acquire(key, create, 30000);

      expect(create).toHaveBeenCalledTimes(2);
      expect(second.adapter).not.toBe(legacy);
    });
  });

  describe('timeout propagation', () => {
    test('hands the caller\'s timeout back so the adapter can apply it per call', async () => {
      const adapter = stubAdapter();
      const create = jest.fn().mockResolvedValue(adapter);

      const first = await cache.acquire(key, create, 30000);
      first.release();

      // A cached adapter was built for an earlier call, so the budget it was
      // created with is stale. The per-call value travels with the handle.
      const second = await cache.acquire(key, create, 1500);
      expect(second.timeout).toBe(1500);
    });

    test('leaves the shared adapter\'s own default alone', async () => {
      const adapter = stubAdapter({ queryTimeout: 30000 });
      const create = jest.fn().mockResolvedValue(adapter);

      const first = await cache.acquire(key, create, 30000);
      first.release();
      await cache.acquire(key, create, 1500);

      // Writing the per-call value onto the shared adapter let two overlapping
      // calls race, and whichever wrote last decided the budget for a statement
      // the other had already issued.
      expect(adapter.queryTimeout).toBe(30000);
    });

    test('records the timeout on the entry it belongs to', async () => {
      const adapter = stubAdapter();
      const create = jest.fn().mockResolvedValue(adapter);

      const r = await cache.acquire(key, create, 2500);
      expect(cache.entries.get(key).timeout).toBe(2500);
      r.release();
    });

    test('hands the timeout back when the cache is off', async () => {
      const off = new ConnectionCache({ enabled: false });
      const r = await off.acquire(key, jest.fn().mockResolvedValue(stubAdapter()), 1234);
      expect(r.timeout).toBe(1234);
    });
  });

  describe('concurrent first use', () => {
    test('connects once for a burst of callers on a cold key', async () => {
      const created = [];
      const create = jest.fn().mockImplementation(async () => {
        // A real connect is a round trip, so the window is a real one.
        await new Promise(resolve => setImmediate(resolve));
        const a = stubAdapter();
        created.push(a);
        return a;
      });

      const handles = await Promise.all(
        Array.from({ length: 8 }, () => cache.acquire(key, create, 30000))
      );

      // Without de-duplication every caller missed, every one built a pool, and
      // the last entries.set won: the losers were unreachable and never closed.
      expect(create).toHaveBeenCalledTimes(1);
      expect(created).toHaveLength(1);
      expect(cache.size).toBe(1);
      expect(new Set(handles.map(h => h.adapter)).size).toBe(1);
    });

    test('counts every caller against the one entry', async () => {
      const create = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setImmediate(resolve));
        return stubAdapter();
      });

      const handles = await Promise.all(
        Array.from({ length: 5 }, () => cache.acquire(key, create, 30000))
      );
      expect(cache.entries.get(key).inFlight).toBe(5);

      for (const h of handles) h.release();
      // Idle only once the last of them is done. Anything less and the cache
      // could close a connection out from under a live statement.
      expect(cache.entries.get(key).inFlight).toBe(0);
    });

    test('credits the creation to exactly one of the callers', async () => {
      const create = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setImmediate(resolve));
        return stubAdapter();
      });

      const handles = await Promise.all([
        cache.acquire(key, create, 30000),
        cache.acquire(key, create, 30000)
      ]);

      expect(handles.filter(h => !h.cached)).toHaveLength(1);
    });

    test('does not join a creation in flight for a different key', async () => {
      const create = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setImmediate(resolve));
        return stubAdapter();
      });

      const [a, b] = await Promise.all([
        cache.acquire('a', create, 30000),
        cache.acquire('b', create, 30000)
      ]);

      expect(create).toHaveBeenCalledTimes(2);
      expect(a.adapter).not.toBe(b.adapter);
    });

    test('every waiter sees a failed connect, and the next caller retries', async () => {
      const boom = new Error('connect ECONNREFUSED');
      const create = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setImmediate(resolve));
        if (create.mock.calls.length === 1) throw boom;
        return stubAdapter();
      });

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => cache.acquire(key, create, 30000))
      );

      expect(results.every(r => r.status === 'rejected' && r.reason === boom)).toBe(true);
      expect(cache.size).toBe(0);
      // A pending marker left behind by the failure would make the retry wait on
      // a promise nobody is holding any more.
      expect(cache.pending.size).toBe(0);

      const retry = await cache.acquire(key, create, 30000);
      expect(retry.cached).toBe(false);
      expect(create).toHaveBeenCalledTimes(2);
    });
  });

  describe('capacity', () => {
    test('evicts the least recently used entry when full', async () => {
      const adapters = [];
      const create = jest.fn().mockImplementation(async () => {
        const a = stubAdapter();
        adapters.push(a);
        return a;
      });

      for (const k of ['a', 'b', 'c']) {
        const r = await cache.acquire(k, create, 30000);
        r.release();
      }
      // Touch "a" so "b" becomes the oldest.
      const r = await cache.acquire('a', create, 30000);
      r.release();

      const r4 = await cache.acquire('d', create, 30000);
      r4.release();

      expect(cache.size).toBe(3);
      expect(adapters[1].close).toHaveBeenCalled(); // "b" evicted
      expect(adapters[0].close).not.toHaveBeenCalled(); // "a" survived
    });

    test('does not close an entry that is still in use', async () => {
      const adapters = [];
      const create = jest.fn().mockImplementation(async () => {
        const a = stubAdapter();
        adapters.push(a);
        return a;
      });

      const a = await cache.acquire('a', create, 30000); // never released
      for (const key of ['b', 'c', 'd']) {
        const r = await cache.acquire(key, create, 30000);
        r.release();
      }

      expect(cache.size).toBe(3);
      expect(adapters[0].close).not.toHaveBeenCalled();
      expect(a.adapter).toBe(adapters[0]);
    });

    test('every adapter is either cached or closed, never orphaned', async () => {
      const adapters = [];
      const create = jest.fn().mockImplementation(async () => {
        const a = stubAdapter();
        adapters.push(a);
        return a;
      });

      // Hold one entry open while the cache runs past its bound.
      const held = await cache.acquire('a', create, 30000);
      for (const key of ['b', 'c', 'd', 'e', 'f']) {
        const r = await cache.acquire(key, create, 30000);
        r.release();
      }

      held.release();
      await cache.closeAll();

      // Dropping an entry from the map without closing it would leave an
      // adapter neither cached nor disposed.
      expect(adapters).toHaveLength(6);
      for (const adapter of adapters) {
        expect(adapter.close).toHaveBeenCalled();
      }
    });
  });

  describe('expiry', () => {
    test('closes a connection idle past the TTL', async () => {
      const adapter = stubAdapter();
      const create = jest.fn().mockResolvedValue(adapter);
      const r = await cache.acquire(key, create, 30000);
      r.release();

      cache.reap(Date.now() + 500);
      expect(cache.size).toBe(1);

      cache.reap(Date.now() + 5000);
      expect(cache.size).toBe(0);
      expect(adapter.close).toHaveBeenCalled();
    });

    test('leaves a connection that is busy', async () => {
      const adapter = stubAdapter();
      const create = jest.fn().mockResolvedValue(adapter);
      await cache.acquire(key, create, 30000); // not released

      cache.reap(Date.now() + 999999);
      expect(cache.size).toBe(1);
    });

    test('leaves the sweep timer unref-ed', () => {
      cache.start();
      expect(cache.reaper).not.toBeNull();
      expect(cache.reaper.hasRef()).toBe(false);
      cache.stop();
      expect(cache.reaper).toBeNull();
    });
  });

  describe('eviction', () => {
    test('drops a connection on evict', async () => {
      const adapter = stubAdapter();
      await cache.acquire(key, jest.fn().mockResolvedValue(adapter), 30000);

      cache.evict(key);

      expect(cache.size).toBe(0);
      expect(adapter.close).toHaveBeenCalled();
    });

    test('is a no-op for an unknown key', () => {
      expect(() => cache.evict('nope')).not.toThrow();
    });

    test('rebuilds after an eviction', async () => {
      const create = jest.fn()
        .mockResolvedValueOnce(stubAdapter())
        .mockResolvedValueOnce(stubAdapter());

      const a = await cache.acquire(key, create, 30000);
      a.release();
      cache.evict(key);
      const b = await cache.acquire(key, create, 30000);

      expect(create).toHaveBeenCalledTimes(2);
      expect(b.adapter).not.toBe(a.adapter);
    });

    test('a late release cannot decrement the replacement under the same key', async () => {
      // The key is occupied again by the time the first release lands, so a
      // key-existence check would pass and the newer entry would get the decrement.
      const first = await cache.acquire(key, jest.fn().mockResolvedValue(stubAdapter()), 30000);
      cache.evict(key);
      const second = await cache.acquire(key, jest.fn().mockResolvedValue(stubAdapter()), 30000);
      expect(cache.entries.get(key).inFlight).toBe(1);

      first.release();

      expect(cache.entries.get(key).inFlight).toBe(1);
      second.release();
    });

    test('a release for an evicted entry still shrinks the cache', async () => {
      // maxEntries 1, so a single stale release is the only thing left that can
      // bring the cache back under its bound.
      const small = new ConnectionCache({ enabled: true, maxEntries: 1, reapIntervalMs: 0 });
      const adapters = [];
      const create = jest.fn().mockImplementation(async () => {
        const a = stubAdapter();
        adapters.push(a);
        return a;
      });

      const a = await small.acquire('a', create, 30000);
      const b = await small.acquire('b', create, 30000);
      const c = await small.acquire('c', create, 30000);
      b.release();
      expect(small.size).toBe(3);

      // The registry discards an in-use entry this way: evict, abort, release.
      small.evict('a');
      expect(small.size).toBe(2);

      // Returning early here left the cache above its bound with an idle entry
      // and nothing scheduled to notice.
      a.release();

      expect(small.size).toBe(1);
      expect(adapters[1].close).toHaveBeenCalled(); // "b" retired by the sweep

      c.release();
      await small.closeAll();
    });
  });

  describe('shutdown', () => {
    test('closeAll closes every connection and empties the cache', async () => {
      const adapters = [];
      const create = jest.fn().mockImplementation(async () => {
        const a = stubAdapter();
        adapters.push(a);
        return a;
      });

      for (const k of ['a', 'b', 'c']) {
        const r = await cache.acquire(k, create, 30000);
        r.release();
      }

      await cache.closeAll();

      expect(cache.size).toBe(0);
      for (const a of adapters) expect(a.close).toHaveBeenCalled();
    });

    test('a stubborn connection does not break shutdown', async () => {
      const adapter = stubAdapter({ close: jest.fn().mockRejectedValue(new Error('stuck')) });
      await cache.acquire(key, jest.fn().mockResolvedValue(adapter), 30000);

      await expect(cache.closeAll()).resolves.not.toThrow();
    });

    test('is safe to call twice', async () => {
      await cache.acquire(key, jest.fn().mockResolvedValue(stubAdapter()), 30000);
      await cache.closeAll();
      await expect(cache.closeAll()).resolves.not.toThrow();
    });
  });

  describe('disabled', () => {
    test('creates a fresh connection every time when off', async () => {
      const off = new ConnectionCache({ enabled: false });
      const create = jest.fn().mockImplementation(async () => stubAdapter());

      const a = await off.acquire(key, create, 30000);
      const b = await off.acquire(key, create, 30000);

      expect(create).toHaveBeenCalledTimes(2);
      expect(a.adapter).not.toBe(b.adapter);
      expect(off.size).toBe(0);
    });

    test('does not start a sweep timer when off', () => {
      const off = new ConnectionCache({ enabled: false });
      off.start();
      expect(off.reaper).toBeNull();
    });
  });

  describe('configuration', () => {
    test('clamps an absurd idle TTL', () => {
      const c = new ConnectionCache({ idleTtlMs: 10 ** 12, enabled: true });
      expect(c.idleTtlMs).toBeLessThanOrEqual(60 * 60 * 1000);
    });

    test('falls back to defaults for nonsense values', () => {
      const c = new ConnectionCache({ maxEntries: -1, idleTtlMs: 'abc', enabled: true });
      expect(c.maxEntries).toBeGreaterThan(0);
      expect(c.idleTtlMs).toBeGreaterThan(0);
    });
  });
});

describe('installShutdownHandlers', () => {
  let cache;
  let handlers;
  let onSpy;
  let onceSpy;
  let exitSpy;

  beforeEach(() => {
    cache = new ConnectionCache({ enabled: true, reapIntervalMs: 0 });
    // Recorded rather than registered, so nothing is left on the real process
    // for the rest of this file, or the next one, to trip over.
    handlers = new Map();
    const record = (prefix) => (event, handler) => {
      handlers.set(`${prefix}:${event}`, handler);
      return process;
    };
    onSpy = jest.spyOn(process, 'on').mockImplementation(record('on'));
    onceSpy = jest.spyOn(process, 'once').mockImplementation(record('once'));
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    onSpy.mockRestore();
    onceSpy.mockRestore();
    exitSpy.mockRestore();
    cache.stop();
  });

  // Lets the handler's own awaits run: closeAll resolves over promises, and a
  // macrotask boundary drains all of them.
  const flush = () => new Promise(resolve => setImmediate(resolve));

  const fire = (event, prefix = 'once') => {
    const handler = handlers.get(`${prefix}:${event}`);
    if (!handler) throw new Error(`no handler registered for ${event}`);
    return handler();
  };

  const seed = async (keys) => {
    const adapters = [];
    const create = jest.fn().mockImplementation(async () => {
      const a = stubAdapter();
      adapters.push(a);
      return a;
    });
    for (const k of keys) (await cache.acquire(k, create, 30000)).release();
    return adapters;
  };

  test('starts out uninstalled', () => {
    expect(cache.installed).toBe(false);
  });

  test('installs a handler for each shutdown signal', () => {
    installShutdownHandlers(cache);

    expect(handlers.has('once:SIGINT')).toBe(true);
    expect(handlers.has('once:SIGTERM')).toBe(true);
    expect(handlers.has('once:beforeExit')).toBe(true);
    expect(handlers.size).toBe(3);
  });

  test('installs signal handlers only once', () => {
    installShutdownHandlers(cache);
    installShutdownHandlers(cache);

    expect(cache.installed).toBe(true);
    // A second pass would replace the first pair with handlers nothing calls.
    expect(handlers.size).toBe(3);
  });

  test.each(['SIGINT', 'SIGTERM'])('closes every connection on %s, then exits', async (signal) => {
    const adapters = await seed(['a', 'b']);
    installShutdownHandlers(cache);

    fire(signal);
    await flush();

    for (const a of adapters) expect(a.close).toHaveBeenCalled();
    expect(cache.size).toBe(0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('names the signal it is shutting down for', async () => {
    const log = jest.fn();
    installShutdownHandlers(cache, log);
    await seed([key]);

    fire('SIGTERM');
    await flush();

    expect(log).toHaveBeenCalledWith('shutting down', { signal: 'SIGTERM' });
  });

  test('stops the reaper, so no sweep runs behind the shutdown', async () => {
    cache.start();
    installShutdownHandlers(cache);

    fire('SIGINT');
    await flush();

    expect(cache.reaper).toBeNull();
  });

  test('closes connections on beforeExit without exiting', async () => {
    const adapters = await seed([key]);
    installShutdownHandlers(cache);

    fire('beforeExit');
    await flush();

    expect(adapters[0].close).toHaveBeenCalled();
    // beforeExit is not a shutdown. The process decides when it is finished,
    // and exiting here would cut short whatever else still had work to do.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('a second signal does not close anything twice', async () => {
    const adapters = await seed([key]);
    installShutdownHandlers(cache);

    fire('SIGINT');
    fire('SIGTERM');
    await flush();

    expect(adapters[0].close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(2);
  });

  test('a close that never settles does not stop a later signal from exiting', async () => {
    const stuck = stubAdapter({ close: jest.fn(() => new Promise(() => {})) });
    await cache.acquire(key, jest.fn().mockResolvedValue(stuck), 30000);
    installShutdownHandlers(cache);

    fire('SIGINT');
    await flush();
    expect(exitSpy).not.toHaveBeenCalled();

    // The close is still outstanding, but the second signal returns straight
    // away rather than queueing behind a connection that will never answer.
    fire('SIGTERM');
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('a connection that throws on close does not stop the exit', async () => {
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    const angry = stubAdapter({ close: jest.fn().mockRejectedValue(new Error('stuck')) });
    await cache.acquire(key, jest.fn().mockResolvedValue(angry), 30000);
    installShutdownHandlers(cache);

    fire('SIGINT');
    await flush();

    expect(exitSpy).toHaveBeenCalledWith(0);
    warn.mockRestore();
  });
});
