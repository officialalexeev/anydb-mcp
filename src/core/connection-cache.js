import { positiveInt } from './base-adapter.js';

const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_REAP_INTERVAL_MS = 60 * 1000;
const MAX_IDLE_TTL_MS = 60 * 60 * 1000;

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
    // Creations started but not yet holding an entry, so a burst of calls on a
    // cold URI connects once instead of once per caller.
    this.pending = new Map();
    this.reaper = null;
    this.installed = false;
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
   *
   * The caller's `timeout` comes back with the handle. It is *not* written onto
   * the adapter: concurrent callers share one adapter, and a field on it cannot
   * carry per-call state without one caller's budget landing on another's
   * statement. Adapters read it from `options` (see resolveQueryTimeout).
   */
  async acquire(key, create, timeout) {
    if (!this.enabled) {
      const adapter = await create();
      // Nothing is cached, so the caller owns the connection and has to close it.
      return { adapter, cached: false, timeout, release: () => this.dispose(adapter) };
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
        return {
          adapter: existing.adapter,
          cached: true,
          timeout,
          release: () => this.release(existing)
        };
      }

      this.entries.delete(key);
      await this.dispose(existing.adapter);
    }

    // Cold key. Whoever loses the race for `pending` waits on the winner rather
    // than opening a second pool the map has no room for.
    const slot = this.beginCreate(key, create, timeout);
    const entry = await slot.promise;

    // Exactly one of the racing callers installs the entry, whichever order the
    // microtasks resume in. The rest find it already there.
    const installed = !slot.installed;
    if (installed) {
      slot.installed = true;
      this.entries.set(key, entry);
      this.evictIfFull(entry);
    }
    // Counted per caller, so the entry is not idle while N of them are still
    // running statements on it.
    entry.inFlight++;

    return {
      adapter: entry.adapter,
      cached: !installed,
      timeout,
      release: () => this.release(entry)
    };
  }

  /**
   * Start, or join, the one creation allowed for `key`. The pending marker is
   * dropped as soon as creation settles, for failures as well as successes: a
   * rejected `create` is thrown to every waiter and leaves nothing behind for the
   * next caller to inherit.
   */
  beginCreate(key, create, timeout) {
    const inProgress = this.pending.get(key);
    if (inProgress) return inProgress;

    const slot = { installed: false, promise: null };
    slot.promise = (async () => {
      const adapter = await create();
      // inFlight starts at 0 because every caller in the race adds itself after
      // the await, including the one that ran create().
      return this.stamp({ adapter, key, lastUsed: Date.now(), inFlight: 0 }, timeout);
    })();

    const settled = () => {
      if (this.pending.get(key) === slot) this.pending.delete(key);
    };
    // Handled here as well as by the callers, so a create that rejects with no
    // live waiter cannot surface as an unhandled rejection.
    slot.promise.then(settled, settled);

    this.pending.set(key, slot);
    return slot;
  }

  /** Record that `entry` was just used, and by which call's budget. A cached
   *  adapter was built for an earlier call, so the entry's own record of the
   *  budget is stale even though the adapter's default is not. */
  stamp(entry, timeout) {
    entry.lastUsed = Date.now();
    entry.timeout = timeout;
    return entry;
  }

  /**
   * Note that the caller is done. `entry` is the one it was handed, not whatever
   * currently sits under the same key, so identity is the only valid test for
   * "still mine": a key-existence check passes just as well against a replacement
   * built after this entry was evicted.
   */
  release(entry) {
    if (this.entries.get(entry.key) !== entry) {
      // Evicted while in use, and possibly replaced. Nothing is left to decrement,
      // but the cache may be over its bound with no release pending to shrink it,
      // so the sweep still has to run here.
      this.evictIfFull();
      return;
    }
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    entry.lastUsed = Date.now();
    // Entries skipped while busy become evictable now.
    this.evictIfFull(entry);
  }

  /**
   * Drop a connection and close it. Called when a statement timed out or the
   * socket died, so the entry's state cannot be trusted. Safe to call on an entry
   * that is still in use: the caller is discarding it either way.
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
 * Close cached connections on SIGINT and SIGTERM, so servers that keep state see
 * a clean disconnect rather than an abrupt one.
 *
 * `proc` defaults to the real `process`, and exists as a parameter so a test can
 * route the handlers to a fake and assert what the shutdown actually did.
 *
 * @param {ConnectionCache} cache
 * @param {(event: string, detail: object) => void} [log]
 * @param {{ once: Function, exit: Function }} [proc] - Defaults to `process`
 */
export function installShutdownHandlers(cache, log = () => {}, proc = process) {
  if (cache.installed) return;
  cache.installed = true;

  // The guard covers the *work*, and deliberately not the exit. `closing` makes
  // the work happen once however many signals arrive, so a SIGINT and a SIGTERM
  // landing together cannot run closeAll() on a half-closed pool twice. The exit
  // stays outside it: if closeAll() wedges on a socket that never calls back, a
  // second signal still gets its own shutdown().then(() => exit(0)), and a process
  // that has to be SIGKILLed is a worse failure than a second exit(0) that never
  // runs because the first one ended the process.
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
    proc.once(signal, () => {
      void shutdown(signal).then(() => proc.exit(0));
    });
  }

  // Best effort, and deliberately not awaited: `beforeExit` may fire repeatedly,
  // so the exit is a real risk, and the `closing` flag and `once` bound it to a
  // single attempt either way.
  proc.once('beforeExit', () => { void shutdown(null); });
}
