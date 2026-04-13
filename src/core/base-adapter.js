/**
 * Timeout error for operations
 */
export class TimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wraps a promise with a timeout
 * @param {Promise} promise - The original promise
 * @param {number} timeoutMs - Timeout in milliseconds (0 = no timeout)
 * @param {string} operationName - Operation name for error message
 * @returns {Promise} Result of the promise or timeout error
 */
export async function withTimeout(promise, timeoutMs, operationName) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
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
  /**
   * @param {number} [connectTimeout=5000] - Connection timeout in ms
   * @param {number} [queryTimeout=30000] - Query execution timeout in ms
   */
  constructor(connectTimeout = 5000, queryTimeout = 30000) {
    this.connectTimeout = connectTimeout;
    this.queryTimeout = queryTimeout;
  }

  async connect(uri) { throw new Error("connect() is not implemented"); }
  async execute(query, options) { throw new Error("execute() is not implemented"); }
  async close() { throw new Error("close() is not implemented"); }
}