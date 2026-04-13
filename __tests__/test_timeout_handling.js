const { TimeoutError, withTimeout } = require('../src/core/base-adapter.js');

describe('Timeout Utilities', () => {
  describe('TimeoutError', () => {
    test('should create TimeoutError with correct properties', () => {
      const error = new TimeoutError('test_operation', 5000);
      
      expect(error.name).toBe('TimeoutError');
      expect(error.message).toBe('Operation "test_operation" timed out after 5000ms');
      expect(error.operation).toBe('test_operation');
      expect(error.timeoutMs).toBe(5000);
    });

    test('should be instance of Error', () => {
      const error = new TimeoutError('db_query', 10000);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('withTimeout', () => {
    test('should resolve if promise completes before timeout', async () => {
      const promise = new Promise(resolve => 
        setTimeout(() => resolve('success'), 50)
      );
      
      const result = await withTimeout(promise, 1000, 'test');
      expect(result).toBe('success');
    });

    test('should reject with TimeoutError if timeout exceeded', async () => {
      const promise = new Promise(resolve => 
        setTimeout(() => resolve('too late'), 1000)
      );
      
      await expect(withTimeout(promise, 50, 'slow_operation'))
        .rejects.toThrow(TimeoutError);
      
      await expect(withTimeout(promise, 50, 'slow_operation'))
        .rejects.toThrow('Operation "slow_operation" timed out after 50ms');
    });

    test('should reject with original error if promise fails before timeout', async () => {
      const promise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('original error')), 50)
      );
      
      await expect(withTimeout(promise, 1000, 'test'))
        .rejects.toThrow('original error');
    });

    test('should not apply timeout if timeoutMs is 0', async () => {
      const promise = Promise.resolve('no timeout');
      const result = await withTimeout(promise, 0, 'test');
      expect(result).toBe('no timeout');
    });

    test('should not apply timeout if timeoutMs is negative', async () => {
      const promise = Promise.resolve('negative timeout');
      const result = await withTimeout(promise, -100, 'test');
      expect(result).toBe('negative timeout');
    });

    test('should clean up timeout timer on success', async () => {
      const promise = Promise.resolve('fast');
      const result = await withTimeout(promise, 1000, 'test');
      expect(result).toBe('fast');
      // Если таймаут не был очищен, тест завис бы
    });

    test('should clean up timeout timer on error', async () => {
      const promise = Promise.reject(new Error('fail'));
      await expect(withTimeout(promise, 1000, 'test'))
        .rejects.toThrow('fail');
      // Если таймаут не был очищен, тест завис бы
    });
  });
});
