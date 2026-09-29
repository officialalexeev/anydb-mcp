import { log, logError } from './logging.js';

export class TimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

// Every driver words "you closed me already" differently, and a connection that
// is gone is not a fault in the connection.
const ALREADY_GONE =
  /\b(already\s+closed|is\s+closed|not\s+connected|no\s+connection|connection\s+(is\s+)?(closed|lost|ended)|pool\s+is\s+closed|client\s+is\s+closed|socket\s+is\s+closed|server\s+is\s+closed)\b/i;

/**
 * Report a `close()` that threw, at a level that matches what happened.
 *
 * Closing twice is normal rather than exceptional: the cache evicts an entry
 * and disposes it, and a caller that also holds a reference can close the same
 * adapter again. The four drivers word that refusal differently, so the
 * decision used to be a regex in one adapter and absent from the other three,
 * which put a stack trace on stderr for every eviction.
 *
 * A close after `abort()` is expected too -- the teardown is the point.
 *
 * @param {string} adapter - Driver name, for the record's `adapter` field
 * @param {unknown} error - The thrown value
 * @param {object} [options]
 * @param {boolean} [options.aborted=false] - Whether the adapter was aborted
 * @returns {string} The level used, so a caller can assert on it
 */
export function logCloseFailure(adapter, error, { aborted = false } = {}) {
  const message = error && error.message ? String(error.message) : String(error);
  const fields = { adapter };
  if (error && typeof error === 'object') {
    if (error.name && error.name !== 'Error') fields.errName = error.name;
    if (error.code !== undefined) fields.code = error.code;
  }
  fields.aborted = aborted || undefined;

  if (aborted || ALREADY_GONE.test(message)) {
    // Still a record, at debug: the level is what keeps it out of a host's log
    // by default, and anyone investigating a stuck teardown turns debug on.
    log(message, fields, { level: 'debug', event: 'adapter_close' });
    return 'debug';
  }

  logError('adapter_close', error, fields);
  return 'error';
}

/** Headroom the whole-operation guard gets over the database-level timeout, so the
 *  adapter's own error, which names the real cause, surfaces first. */
export const TIMEOUT_GRACE_MS = 500;

/** A whole positive number, or `fallback`. Shared by the adapters and the cache so
 *  a typo in configuration cannot turn a bound into 0, NaN or unbounded. */
export const positiveInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Reject if `promise` has not settled within `timeoutMs`.
 *
 * @param {Function} [onTimeout] - Runs when the guard fires, to tear down work
 *   the caller has given up on
 */
export async function withTimeout(promise, timeoutMs, operationName, onTimeout) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Aborting is best effort; the timeout still has to be reported.
      }
      reject(new TimeoutError(operationName, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export class BaseAdapter {
  constructor(connectTimeout = 5000, queryTimeout = 30000) {
    this.connectTimeout = connectTimeout;
    this.queryTimeout = queryTimeout;
  }

  async connect(uri) { throw new Error("connect() is not implemented"); }
  async execute(query, options) { throw new Error("execute() is not implemented"); }
  async close() { throw new Error("close() is not implemented"); }

  /** Abandon the in-flight statement. Adapters that cannot interrupt a query
   *  leave this a no-op. */
  abort() {}

  /**
   * Whether this connection can still be handed out. Assumed-alive connections are
   * the failure mode the cache has to avoid, since a server can close an idle
   * socket at any time.
   */
  isHealthy() { return true; }

  /**
   * The timeout for one call, read from `options` rather than off the adapter. A
   * cached adapter is shared by concurrent callers, so `queryTimeout` is only the
   * default: writing a per-call value into it let two overlapping calls race, and
   * whichever wrote last set the budget for a statement the other had issued.
   */
  resolveQueryTimeout(options) {
    const perCall = options ? options.timeout : undefined;
    if (Number.isFinite(perCall) && perCall > 0) return perCall;
    return this.queryTimeout;
  }
}
