/**
 * Unit tests for `src/core/timeout-utils.js`, a shared guard whose contract is
 * the *class* it rejects with. `src/index.js` picks what advice the model gets
 * with `error instanceof TimeoutError` as its first branch, and a plain `Error`
 * reports the likeliest SQLite failure as a syntax problem, so the class is
 * pinned here rather than only the message.
 */

import { callbackWithTimeout, createTimeoutController } from '../src/core/timeout-utils.js';
import { TimeoutError, isDeadConnectionError, isTimeoutError } from '../src/core/registry.js';

describe('callbackWithTimeout', () => {
  describe('the class it rejects with', () => {
    // The load-bearing assertion. `src/index.js` decides what advice the model
    // gets with `error instanceof TimeoutError` as its first branch.
    test('is a TimeoutError, so the timeout branch in the error path is reachable', async () => {
      await expect(callbackWithTimeout(() => {}, 40, 'SQLite query'))
        .rejects.toBeInstanceOf(TimeoutError);
    });

    test('is a TimeoutError with the default message too', async () => {
      const error = await callbackWithTimeout(() => {}, 40, 'SQLite query')
        .catch((err) => err);

      expect(error.name).toBe('TimeoutError');
      expect(error.message).toBe('Operation "SQLite query" timed out after 40ms');
    });

    // A driver-side error is passed through untouched. Re-wrapping it would make
    // every refusal look like a timeout, which is just as wrong.
    test('leaves a driver error as the driver raised it', async () => {
      const raised = Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
      const error = await callbackWithTimeout((cb) => cb(raised), 1000, 'SQLite query')
        .catch((err) => err);

      expect(error).toBe(raised);
      expect(error).not.toBeInstanceOf(TimeoutError);
      expect(error.code).toBe('SQLITE_BUSY');
    });

    test('a timeout is treated as a dead connection, and a lock is not', async () => {
      const timeout = await callbackWithTimeout(() => {}, 40, 'op').catch((err) => err);
      const busy = await callbackWithTimeout(
        (cb) => cb(new Error('SQLITE_BUSY: database is locked')), 1000, 'op'
      ).catch((err) => err);

      // A statement that ran out of time leaves the connection's state unknown, so
      // the cache evicts it. A contended lock is a property of the moment and the
      // connection is still good.
      expect(isDeadConnectionError(timeout)).toBe(true);
      expect(isDeadConnectionError(busy)).toBe(false);
    });

    // `isTimeoutError()` is public and `src/index.js` exports the same shape of
    // answer through it, so both classifiers are asserted together: a structural
    // check and a textual one must never disagree.
    test('both the class and the registry\'s matcher agree', async () => {
      const timeout = await callbackWithTimeout(() => {}, 40, 'op').catch((err) => err);
      expect(isTimeoutError(timeout)).toBe(true);
      expect(isTimeoutError(new Error('SQLITE_CANTOPEN: unable to open database file'))).toBe(false);
    });
  });

  describe('a custom timeout message', () => {
    // `sqlite.js` supplies a better sentence than the default for a locked
    // database, and it has to survive the change of class. It is assigned after
    // construction rather than by widening the constructor, so the structural
    // fields are untouched — which is what the next two tests check.
    test('survives, and is the whole message', async () => {
      const custom = 'SQLite query exceeded 60000ms timeout. The database is probably locked by another process.';
      const error = await callbackWithTimeout(() => {}, 40, 'SQLite query', custom).catch((err) => err);

      expect(error.message).toBe(custom);
      expect(error.message).not.toMatch(/timed out after/);
    });

    test('does not change the class or its fields', async () => {
      const error = await callbackWithTimeout(() => {}, 40, 'SQLite query', 'custom')
        .catch((err) => err);

      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.name).toBe('TimeoutError');
      // The constructor's own arguments are what `operation` and `timeoutMs` hold,
      // so a consumer can still reason about the bound without parsing prose.
      expect(error.operation).toBe('SQLite query');
      expect(error.timeoutMs).toBe(40);
      // And the stack is the constructor's, so it names the construction site.
      expect(typeof error.stack).toBe('string');
      expect(error.stack.length).toBeGreaterThan(0);
    });

    test('is not applied to a driver error, which carries its own message', async () => {
      const error = await callbackWithTimeout(
        (cb) => cb(new Error('no such table: t')), 1000, 'SQLite query', 'custom'
      ).catch((err) => err);
      expect(error.message).toBe('no such table: t');
    });

    test.each([undefined, null, ''])('%p falls back to the default message', async (custom) => {
      const error = await callbackWithTimeout(() => {}, 40, 'op', custom).catch((err) => err);
      expect(error.message).toBe('Operation "op" timed out after 40ms');
    });
  });

  describe('timing', () => {
    test('resolves with the callback result', async () => {
      await expect(callbackWithTimeout((cb) => cb(null, [1, 2]), 1000, 'op')).resolves.toEqual([1, 2]);
    });

    test('rejects only once when the callback and the timer race', async () => {
      let calls = 0;
      const promise = callbackWithTimeout((cb) => {
        setTimeout(() => { calls += 1; cb(null, 'ok'); }, 20);
      }, 200, 'op');

      await expect(promise).resolves.toBe('ok');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(calls).toBe(1);
    });

    // A 60 s budget, resolved on the spot: what is being asserted is that the
    // timer is cleared on the path that settles, not that the wait is short.
    test('leaves no timer behind after resolving', async () => {
      const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      await callbackWithTimeout((cb) => cb(null, 'ok'), 60000, 'op');
      const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      expect(after).toBeLessThanOrEqual(before);
    });

    test('leaves no timer behind after rejecting', async () => {
      const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      await callbackWithTimeout(() => {}, 60, 'op').catch(() => {});
      const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      expect(after).toBeLessThanOrEqual(before);
    });

    test('cancel disarms the timer of an operation that will never call back', async () => {
      const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      callbackWithTimeout(() => {}, 60000, 'abandoned').cancel();
      const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      expect(after).toBeLessThanOrEqual(before);
    });
  });
});

describe('createTimeoutController', () => {
  test('arms a timer only for a positive budget', () => {
    expect(createTimeoutController(1000).timerId).not.toBeNull();
    // `0` and below means "no timeout", and a timer of 0 would be a timeout of one
    // turn of the event loop, which is not what the caller meant.
    for (const ms of [0, -1, NaN]) {
      const { controller, timerId } = createTimeoutController(ms);
      expect(timerId).toBeNull();
      expect(controller.signal.aborted).toBe(false);
    }
  });

  test('aborts when the budget runs out', async () => {
    const { controller } = createTimeoutController(20);
    expect(controller.signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(controller.signal.aborted).toBe(true);
  });
});
