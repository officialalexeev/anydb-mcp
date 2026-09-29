import { TimeoutError } from './base-adapter.js';

/** The timer is left referenced: an abort guard that let the process exit early
 *  would turn a hang into a silent success. */
export function createTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timerId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  return { controller, timerId };
}

/**
 * Wrap a node-style callback operation with a timeout.
 *
 * Rejects with `TimeoutError`, not a plain `Error`, because callers branch on the
 * class and a plain `Error` reports the likeliest SQLite failure as a syntax
 * problem. `cancel()` is for callers that abandon the operation by another route.
 *
 * @param {Function} operation - Called with a node-style `(err, result)` callback
 * @param {number} timeoutMs - Budget. `0` or less means no timeout at all
 * @param {string} [operationName] - What was being attempted
 * @param {string} [timeoutMessage] - Replaces the default message when given
 * @returns {Promise<*> & { cancel: Function }}
 */
export function callbackWithTimeout(operation, timeoutMs, operationName, timeoutMessage) {
  const { controller, timerId } = createTimeoutController(timeoutMs);
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timerId) clearTimeout(timerId);
      fn(value);
    };

    operation((err, result) => {
      if (controller.signal.aborted) return;
      if (err) finish(reject, err);
      else finish(resolve, result);
    });

    controller.signal.addEventListener('abort', () => {
      const error = new TimeoutError(operationName, timeoutMs);
      if (timeoutMessage) error.message = timeoutMessage;
      finish(reject, error);
    }, { once: true });
  });

  promise.cancel = () => {
    if (timerId) clearTimeout(timerId);
  };

  return promise;
}
