export class TimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Headroom the whole-operation guard gets over the database-level timeout, so
 * the adapter's own error, which names the real cause, surfaces first.
 */
export const TIMEOUT_GRACE_MS = 500;

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

  /**
   * Abandon the in-flight statement. Adapters that cannot interrupt a query
   * leave this as a no-op.
   */
  abort() {}

  /**
   * Whether this connection can still be handed out. Assumed-alive connections
   * are the failure mode the cache has to avoid, since a server can close an
   * idle socket at any time.
   */
  isHealthy() { return true; }
}
