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
    test('applies the current call timeout to a reused connection', async () => {
      const adapter = stubAdapter();
      const create = jest.fn().mockResolvedValue(adapter);

      const first = await cache.acquire(key, create, 30000);
      first.release();

      // A cached adapter was built for an earlier call, so its budget is stale.
      const second = await cache.acquire(key, create, 1500);
      expect(second.adapter.queryTimeout).toBe(1500);
    });

    test('applies the timeout to a newly created connection', async () => {
      const adapter = stubAdapter();
      await cache.acquire(key, jest.fn().mockResolvedValue(adapter), 2500);
      expect(adapter.queryTimeout).toBe(2500);
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

  beforeEach(() => {
    cache = new ConnectionCache({ enabled: true, reapIntervalMs: 0 });
  });

  test('installs signal handlers', () => {
    installShutdownHandlers(cache);
    installShutdownHandlers(cache);
    expect(cache.installed).toBe(true);
  });
});
