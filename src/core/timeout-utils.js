/**
 * Timeout utilities
 */

/**
 * Creates an AbortController with timeout
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {{ controller: AbortController, timerId: NodeJS.Timeout }}
 */
export function createTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timerId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return { controller, timerId };
}

/**
 * Wraps a callback-based operation in a promise with timeout
 * @param {Function} operation - Function that accepts callback (err, result)
 * @param {number} timeoutMs - Timeout in ms
 * @param {string} operationName - Operation name
 * @returns {Promise}
 */
export function callbackWithTimeout(operation, timeoutMs, operationName) {
  return new Promise((resolve, reject) => {
    const { controller, timerId } = createTimeoutController(timeoutMs);

    operation((err, result) => {
      clearTimeout(timerId);
      if (controller.signal.aborted) {
        return; // Ignore result if already timed out
      }
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });

    controller.signal.addEventListener('abort', () => {
      reject(new Error(`Operation "${operationName}" timed out after ${timeoutMs}ms`));
    }, { once: true });
  });
}
