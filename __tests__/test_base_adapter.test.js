import { BaseAdapter, TimeoutError, withTimeout, TIMEOUT_GRACE_MS } from '../src/core/base-adapter.js';

describe('BaseAdapter', () => {
  test('carries the connect and query timeouts', () => {
    const adapter = new BaseAdapter(1000, 2000);
    expect(adapter.connectTimeout).toBe(1000);
    expect(adapter.queryTimeout).toBe(2000);
  });

  test('defaults to 5s connect and 30s query', () => {
    const adapter = new BaseAdapter();
    expect(adapter.connectTimeout).toBe(5000);
    expect(adapter.queryTimeout).toBe(30000);
  });

  test.each(['connect', 'execute', 'close'])('leaves %s unimplemented', async (method) => {
    await expect(new BaseAdapter()[method]('x')).rejects.toThrow('is not implemented');
  });

  test('provides a no-op abort so the registry can always call it', () => {
    expect(() => new BaseAdapter().abort()).not.toThrow();
  });
});

describe('TimeoutError', () => {
  test('carries the operation and its budget', () => {
    const error = new TimeoutError('db_query', 5000);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TimeoutError');
    expect(error.message).toBe('Operation "db_query" timed out after 5000ms');
    expect(error.operation).toBe('db_query');
    expect(error.timeoutMs).toBe(5000);
  });
});

describe('withTimeout', () => {
  test('resolves when the promise finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'op')).resolves.toBe('ok');
  });

  test('rejects with TimeoutError when the promise is too slow', async () => {
    // The timer is cleared below, otherwise it outlives the test and keeps the
    // jest worker alive.
    let timer;
    const slow = new Promise(resolve => { timer = setTimeout(() => resolve('late'), 5000); });

    await expect(withTimeout(slow, 40, 'slow_op')).rejects.toThrow(TimeoutError);
    clearTimeout(timer);
  });

  test('passes the original error through unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('original')), 1000, 'op'))
      .rejects.toThrow('original');
  });

  test('reports the original error when it comes first', async () => {
    const failing = new Promise((_, reject) => setTimeout(() => reject(new Error('db down')), 20));
    await expect(withTimeout(failing, 1000, 'op')).rejects.toThrow('db down');
  });

  test.each([0, -1, undefined, null])('does not apply a timeout of %p', async (ms) => {
    await expect(withTimeout(Promise.resolve('ok'), ms, 'op')).resolves.toBe('ok');
  });

  test('calls onTimeout when the guard fires', async () => {
    const onTimeout = jest.fn();
    const stuck = new Promise(() => {});

    await expect(withTimeout(stuck, 40, 'op', onTimeout)).rejects.toThrow(TimeoutError);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  test('does not call onTimeout when the promise wins', async () => {
    const onTimeout = jest.fn();
    await withTimeout(Promise.resolve('ok'), 1000, 'op', onTimeout);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test('still reports the timeout when onTimeout itself throws', async () => {
    const stuck = new Promise(() => {});
    await expect(withTimeout(stuck, 40, 'op', () => { throw new Error('abort failed'); }))
      .rejects.toThrow(TimeoutError);
  });

  test('clears the timer on success', async () => {
    const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    await withTimeout(Promise.resolve('ok'), 60000, 'op');
    const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    expect(after).toBeLessThanOrEqual(before);
  });

  test('a late failure is not unhandled', async () => {
    const onUnhandled = jest.fn();
    process.on('unhandledRejection', onUnhandled);
    const timer = setTimeout(() => {}, 200);
    try {
      const failing = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 60));
      await expect(withTimeout(failing, 20, 'op')).rejects.toThrow(TimeoutError);
      await new Promise(r => setTimeout(r, 150));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('TIMEOUT_GRACE_MS', () => {
  test('the grace window is bounded', () => {
    expect(TIMEOUT_GRACE_MS).toBeGreaterThan(0);
    expect(TIMEOUT_GRACE_MS).toBeLessThan(5000);
  });
});
