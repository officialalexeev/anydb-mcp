/**
 * The timer is left referenced on purpose: an abort guard that lets the process
 * exit before firing would turn a hang into a silent success.
 */
export function createTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timerId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  return { controller, timerId };
}

/**
 * Wrap a node-style callback operation with a timeout.
 *
 * The returned promise carries a `cancel()` that disarms the timer, for callers
 * that abandon the operation by another route, such as a database-level 'error'
 * event.
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
      finish(reject, new Error(
        timeoutMessage || `Operation "${operationName}" timed out after ${timeoutMs}ms`
      ));
    }, { once: true });
  });

  promise.cancel = () => {
    if (timerId) clearTimeout(timerId);
  };

  return promise;
}
