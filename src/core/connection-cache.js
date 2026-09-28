const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REAP_INTERVAL_MS = 60 * 1000;
const MAX_IDLE_TTL_MS = 60 * 60 * 1000;

const positiveInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export class ConnectionCache {
  constructor(options = {}) {
    // Explicit options go through the same guard as the environment, so a
    // nonsense value cannot remove the bound the cache depends on.
    this.maxEntries = positiveInt(
      options.maxEntries ?? process.env.ANYDB_CACHE_MAX,
      DEFAULT_MAX_ENTRIES
    );
    this.idleTtlMs = Math.min(
      positiveInt(options.idleTtlMs ?? process.env.ANYDB_CACHE_TTL_MS, DEFAULT_IDLE_TTL_MS),
      MAX_IDLE_TTL_MS
    );
    this.reapIntervalMs = positiveInt(options.reapIntervalMs, DEFAULT_REAP_INTERVAL_MS);
    this.enabled = options.enabled ?? process.env.ANYDB_CACHE !== '0';

    this.entries = new Map();
    this.reaper = null;
  }

  get size() {
    return this.entries.size;
  }

  /**
   * Return a live adapter for `key`, reusing a cached one when it is healthy.
   * `create` is expected to have already connected the adapter.
   *
   * `release` takes no arguments and must be called once per acquire. It carries
   * the entry itself rather than the key, so a release that arrives after the
   * entry was evicted and replaced cannot decrement the newer one.
   */
  async acquire(key, create, timeout) {
    if (!this.enabled) {
      const adapter = await create();
      // Nothing is cached, so the caller owns the connection and has to close it.
      return { adapter, cached: false, release: () => this.dispose(adapter) };
    }

    const existing = this.entries.get(key);
    if (existing) {
      // Re-insert so the Map's insertion order doubles as a recency list.
      this.entries.delete(key);
      this.entries.set(key, existing);
      existing.inFlight++;

      let healthy = false;
      try {
        healthy = await existing.adapter.isHealthy();
      } catch {
        healthy = false;
      }

      if (healthy) {
        this.stamp(existing, timeout);
        return { adapter: existing.adapter, cached: true, release: () => this.release(existing) };
      }

      this.entries.delete(key);
      await this.dispose(existing.adapter);
    }

    const adapter = await create();
    const entry = { adapter, key, lastUsed: Date.now(), inFlight: 1 };
    this.stamp(entry, timeout);

    this.entries.set(key, entry);
    this.evictIfFull(entry);

    return { adapter, cached: false, release: () => this.release(entry) };
  }

  /**
   * Apply the current call's timeout. A cached adapter was built for an earlier
   * call, so its budget is stale.
   */
  stamp(entry, timeout) {
    entry.lastUsed = Date.now();
    entry.adapter.queryTimeout = timeout;
    return entry;
  }

  /**
   * Note that the caller is done. `entry` is the one it was handed, not
   * whatever currently sits under the same key.
   */
  release(entry) {
    if (!this.entries.has(entry.key)) return; // evicted while in use
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    entry.lastUsed = Date.now();
    // Entries skipped while busy become evictable now.
    this.evictIfFull(entry);
  }

  /**
   * Drop a connection and close it. Called when a statement timed out or the
   * socket died, so the entry's state cannot be trusted. Safe to call on an
   * entry that is still in use: the caller is discarding it either way.
   */
  evict(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    void this.dispose(entry.adapter);
  }

  /**
   * Close idle least-recently-used entries down to the bound. An entry in use is
   * skipped rather than closed under its caller, and picked up by a later
   * release() or by the sweep. If everything is in use the cache stays above the
   * bound for the duration, which is bounded by the concurrency of one client.
   */
  evictIfFull(protectedEntry) {
    if (this.entries.size <= this.maxEntries) return;

    for (const [key, entry] of [...this.entries]) {
      if (this.entries.size <= this.maxEntries) return;
      if (entry === protectedEntry || entry.inFlight > 0) continue;
      this.entries.delete(key);
      void this.dispose(entry.adapter);
    }
  }

  reap(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.inFlight > 0) continue;
      if (now - entry.lastUsed >= this.idleTtlMs) {
        this.entries.delete(key);
        void this.dispose(entry.adapter);
      }
    }
  }

  start() {
    if (this.reaper || !this.enabled) return;
    this.reaper = setInterval(() => this.reap(), this.reapIntervalMs);
    // A sweep must not be the reason the process stays alive.
    this.reaper.unref?.();
  }

  stop() {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }

  async closeAll() {
    this.stop();
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(e => this.dispose(e.adapter)));
  }

  async dispose(adapter) {
    if (!adapter) return;
    try {
      await adapter.close();
    } catch {
      // Being discarded anyway.
    }
  }
}

/**
 * Close cached connections on SIGINT and SIGTERM, so servers that keep state
 * see a clean disconnect rather than an abrupt one.
 */
export function installShutdownHandlers(cache, log = () => {}) {
  if (cache.installed) return;
  cache.installed = true;

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    cache.stop();
    try {
      await cache.closeAll();
    } catch {
      // Nothing useful to do while exiting.
    }
    if (signal) log('shutting down', { signal });
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void shutdown(signal).then(() => process.exit(0));
    });
  }

  process.once('beforeExit', () => { void shutdown(null); });
}
