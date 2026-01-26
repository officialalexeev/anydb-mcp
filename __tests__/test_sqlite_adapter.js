const { SQLiteAdapter } = require('../src/adapters/sqlite.js');

describe('SQLiteAdapter', () => {
  let adapter;
  let mockDatabase;
  let mockAll;
  let mockClose;

  beforeEach(() => {
    mockAll = jest.fn();
    mockClose = jest.fn();
    
    mockDatabase = {
      all: mockAll,
      close: mockClose
    };
    
    // Создаем мок-конструктор
    const mockDatabaseConstructor = jest.fn(() => mockDatabase);
    
    adapter = new SQLiteAdapter(mockDatabaseConstructor);
  });

  describe('connect', () => {
    test('should create database instance with correct file path', async () => {
      const uri = 'sqlite:///path/to/database.db';
      
      await adapter.connect(uri);
      
      expect(adapter.db).toBe(mockDatabase);
    });

    test('should handle URIs with sqlite:// prefix correctly', async () => {
      const uri = 'sqlite:///C:/databases/test.db';
      
      await adapter.connect(uri);
      
      expect(adapter.db).toBe(mockDatabase);
    });
  });

  describe('execute', () => {
    test('should execute query and return rows', async () => {
      const mockRows = [{ id: 1, name: 'Test' }];
      mockAll.mockImplementation((sql, params, callback) => {
        callback(null, mockRows);
      });
      
      await adapter.connect('sqlite:///path/to/database.db');
      const result = await adapter.execute('SELECT * FROM users');
      
      expect(result).toEqual(mockRows);
    });

    test('should throw error when query fails', async () => {
      const errorMessage = 'no such table: nonexistent_table';
      mockAll.mockImplementation((sql, params, callback) => {
        callback(new Error(errorMessage), null);
      });
      
      await adapter.connect('sqlite:///path/to/database.db');
      
      await expect(adapter.execute('SELECT * FROM nonexistent_table'))
        .rejects.toThrow(`SQLite Error: ${errorMessage}`);
    });
  });

  describe('close', () => {
    test('should close the database if database exists', async () => {
      mockClose.mockImplementation((callback) => {
        callback(null);
      });
      
      await adapter.connect('sqlite:///path/to/database.db');
      
      await expect(adapter.close()).resolves.not.toThrow();
      expect(mockClose).toHaveBeenCalled();
    });

    test('should throw error if closing database fails', async () => {
      const errorMessage = 'failed to close database';
      mockClose.mockImplementation((callback) => {
        callback(new Error(errorMessage));
      });
      
      await adapter.connect('sqlite:///path/to/database.db');
      
      await expect(adapter.close())
        .rejects.toThrow(`Failed to close SQLite connection: ${errorMessage}`);
    });

    test('should not throw error if database does not exist', async () => {
      // Убедимся, что db не существует
      delete adapter.db;
      
      await expect(adapter.close()).resolves.not.toThrow();
    });
  });
});