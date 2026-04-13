const { AdapterRegistry, TimeoutError, DEFAULT_TIMEOUT } = require('../src/core/registry.js');

describe('AdapterRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  describe('DEFAULT_TIMEOUT', () => {
    test('should be 30000ms', () => {
      expect(DEFAULT_TIMEOUT).toBe(30000);
    });
  });

  describe('extractProtocol', () => {
    test('should correctly extract protocol from URI', () => {
      expect(registry.extractProtocol('postgres://user:pass@host:5432/db')).toBe('postgres');
      expect(registry.extractProtocol('postgresql://user:pass@host:5432/db')).toBe('postgresql');
      expect(registry.extractProtocol('mongodb://user:pass@host:27017/db')).toBe('mongodb');
      expect(registry.extractProtocol('sqlite:///path/to/database.db')).toBe('sqlite');
    });

    test('should throw error for invalid URI format', () => {
      expect(() => {
        registry.extractProtocol('invalid-uri');
      }).toThrow('Invalid URI format. Expected \'protocol://...\'');
    });
  });

  describe('validate', () => {
    test('should validate valid query', () => {
      expect(() => {
        registry.validate('SELECT * FROM table', 'postgres', {});
      }).not.toThrow();
    });

    test('should throw error for empty query', () => {
      expect(() => {
        registry.validate('', 'postgres', {});
      }).toThrow('Query must be a string.');
    });

    test('should throw error for non-string query', () => {
      expect(() => {
        registry.validate(123, 'postgres', {});
      }).toThrow('Query must be a string.');
    });

    test('should throw error for missing collection in MongoDB', () => {
      expect(() => {
        registry.validate('{}', 'mongodb', {});
      }).toThrow('Missing \'collection\' parameter for MongoDB query.');
    });

    test('should not throw error for MongoDB with collection', () => {
      expect(() => {
        registry.validate('{}', 'mongodb', { collection: 'users' });
      }).not.toThrow();
    });

    test('should throw error for invalid timeout (negative)', () => {
      expect(() => {
        registry.validate('SELECT 1', 'postgres', { timeout: -100 });
      }).toThrow('Timeout must be a positive number (milliseconds).');
    });

    test('should throw error for invalid timeout (string)', () => {
      expect(() => {
        registry.validate('SELECT 1', 'postgres', { timeout: '5000' });
      }).toThrow('Timeout must be a positive number (milliseconds).');
    });

    test('should accept valid timeout', () => {
      expect(() => {
        registry.validate('SELECT 1', 'postgres', { timeout: 15000 });
      }).not.toThrow();
    });
  });

  describe('run method', () => {
    test('should throw error for unsupported protocol', async () => {
      await expect(registry.run('unknown://localhost', 'SELECT * FROM table'))
        .rejects.toThrow('Protocol "unknown" is not supported. Supported: postgres, postgresql, mongodb, sqlite, redis, mysql');
    });

    test('should use default timeout when not specified', async () => {
      const mockAdapter = {
        connect: jest.fn().mockResolvedValue(),
        execute: jest.fn().mockResolvedValue([{ result: 1 }]),
        close: jest.fn().mockResolvedValue()
      };

      const registryWithMock = new AdapterRegistry(
        undefined, undefined, undefined, undefined, undefined
      );
      registryWithMock.mapping = {
        'test': () => mockAdapter
      };
      registryWithMock.extractProtocol = () => 'test';
      registryWithMock.validate = () => {};

      // Should complete within default timeout
      const start = Date.now();
      await registryWithMock.run('test://localhost', 'SELECT 1');
      const elapsed = Date.now() - start;
      
      expect(elapsed).toBeLessThan(DEFAULT_TIMEOUT);
    });
  });
});