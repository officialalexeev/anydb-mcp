const { AdapterRegistry } = require('../src/core/registry.js');

describe('AdapterRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new AdapterRegistry();
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
  });

  describe('run method', () => {
    test('should throw error for unsupported protocol', async () => {
      await expect(registry.run('unknown://localhost', 'SELECT * FROM table'))
        .rejects.toThrow('Protocol "unknown" is not supported. Supported: postgres, postgresql, mongodb, sqlite, redis, mysql');
    });
  });
});