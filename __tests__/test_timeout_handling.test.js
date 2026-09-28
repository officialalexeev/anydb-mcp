import { callbackWithTimeout, createTimeoutController } from '../src/core/timeout-utils.js';

describe('createTimeoutController', () => {
  test('aborts after the timeout', async () => {
    const { controller, timerId } = createTimeoutController(30);
    expect(controller.signal.aborted).toBe(false);
    await new Promise(r => setTimeout(r, 80));
    expect(controller.signal.aborted).toBe(true);
    clearTimeout(timerId);
  });

  test('never fires without a timeout', async () => {
    const { controller, timerId } = createTimeoutController(0);
    await new Promise(r => setTimeout(r, 30));
    expect(controller.signal.aborted).toBe(false);
    if (timerId) clearTimeout(timerId);
  });
});

describe('callbackWithTimeout', () => {
  test('resolves with the callback result', async () => {
    const result = await callbackWithTimeout(
      (cb) => cb(null, [1, 2, 3]), 1000, 'op');
    expect(result).toEqual([1, 2, 3]);
  });

  test('rejects with the callback error', async () => {
    await expect(
      callbackWithTimeout((cb) => cb(new Error('query failed')), 1000, 'op')
    ).rejects.toThrow('query failed');
  });

  test('rejects with a timeout error when the callback never fires', async () => {
    await expect(callbackWithTimeout(() => {}, 40, 'slow_op'))
      .rejects.toThrow('Operation "slow_op" timed out after 40ms');
  });

  test('uses a custom timeout message when given one', async () => {
    await expect(
      callbackWithTimeout(() => {}, 40, 'sqlite', 'SQLite query exceeded 40ms timeout')
    ).rejects.toThrow('SQLite query exceeded 40ms timeout');
  });

  test('ignores a callback that arrives after the timeout', async () => {
    let late;
    const promise = callbackWithTimeout((cb) => { late = cb; }, 40, 'op');

    await expect(promise).rejects.toThrow(/timed out/);
    expect(() => late(null, 'too late')).not.toThrow();
  });

  test('settles only once when the callback and the timeout race', async () => {
    let callbackCount = 0;
    const promise = callbackWithTimeout((cb) => {
      setTimeout(() => { callbackCount++; cb(null, 'ok'); }, 20);
    }, 200, 'op');

    await expect(promise).resolves.toBe('ok');
    await new Promise(r => setTimeout(r, 100));
    expect(callbackCount).toBe(1);
  });

  test.each([0, -1])('does not apply a timeout of %p', async (ms) => {
    const result = await callbackWithTimeout((cb) => cb(null, 'value'), ms, 'op');
    expect(result).toBe('value');
  });

  test('leaves no timer behind after resolving', async () => {
    const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    await callbackWithTimeout((cb) => cb(null, 'ok'), 60000, 'op');
    const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    expect(after).toBeLessThanOrEqual(before);
  });

  test('cancel disarms the timer of an operation that will never call back', async () => {
    const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    const promise = callbackWithTimeout(() => {}, 60000, 'abandoned');

    promise.cancel();

    const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    expect(after).toBeLessThanOrEqual(before);
  });

  test('cancel is safe after the operation already settled', async () => {
    const promise = callbackWithTimeout((cb) => cb(null, 'ok'), 1000, 'op');
    await expect(promise).resolves.toBe('ok');
    expect(() => promise.cancel()).not.toThrow();
  });

  test('cancel is a no-op when no timeout was applied', async () => {
    const promise = callbackWithTimeout((cb) => cb(null, 'ok'), 0, 'op');
    expect(() => promise.cancel()).not.toThrow();
  });
});
