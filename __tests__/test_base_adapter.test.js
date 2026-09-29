import { BaseAdapter, TimeoutError, withTimeout, TIMEOUT_GRACE_MS, logCloseFailure } from '../src/core/base-adapter.js';

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

describe('logCloseFailure', () => {
  let written;
  let spy;
  let level;

  beforeEach(() => {
    written = [];
    level = process.env.ANYDB_LOG_LEVEL;
    process.env.ANYDB_LOG_LEVEL = 'debug';
    spy = jest.spyOn(console, 'error').mockImplementation((...a) => written.push(a.join(' ')));
  });

  afterEach(() => {
    spy.mockRestore();
    if (level === undefined) delete process.env.ANYDB_LOG_LEVEL;
    else process.env.ANYDB_LOG_LEVEL = level;
  });

  // At debug the stack is logged after the message, so the last line is the
  // stack. Find the line that carries the level instead.
  const record = (event) =>
    written.find((l) => l.includes(event) && !l.includes('.stack')) || '';

  // Closing twice is what the cache does when it evicts an entry a caller still
  // holds, and it is not a fault. A stack trace on stderr for every eviction is
  // what 3.0.0 shipped.
  test.each([
    'pool is closed',
    'Client is closed',
    'Connection closed',
    'not connected',
    'client is closed',
    'server is closed',
    'socket is closed',
  ])('logs "%s" at debug, not error', (message) => {
    expect(logCloseFailure('postgres', new Error(message))).toBe('debug');
    expect(record('adapter_close')).toMatch(/\bdebug\b/);
    expect(record('adapter_close')).not.toMatch(/\berror\b/);
  });

  test('a real teardown failure is still an error', () => {
    const err = new Error('could not reach the server');
    err.code = 'ECONNRESET';
    expect(logCloseFailure('postgres', err)).toBe('error');
    expect(record('adapter_close')).toMatch(/\berror\b/);
    expect(record('adapter_close')).toMatch(/ECONNRESET/);
  });

  test('a close after abort is debug whatever the driver says', () => {
    expect(logCloseFailure('mysql', new Error('permission denied'), { aborted: true })).toBe('debug');
    expect(record('adapter_close')).toMatch(/\bdebug\b/);
    expect(record('adapter_close')).not.toMatch(/\berror\b/);
  });

  test('the adapter name is on the record', () => {
    logCloseFailure('mongodb', new Error('pool is closed'));
    expect(record('adapter_close')).toMatch(/adapter=mongodb/);
  });

  test('a non-Error throw is reported, not rethrown', () => {
    expect(logCloseFailure('sqlite', 'plain string')).toBe('error');
    expect(record('adapter_close')).toMatch(/plain string/);
  });
});
