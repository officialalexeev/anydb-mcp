const { MySQLAdapter } = require('../src/adapters/mysql.js');

describe('MySQLAdapter', () => {
  let adapter;
  let mockConnection;
  let mockExecute;
  let mockEnd;
  let mockCreateConnection;

  beforeEach(() => {
    mockExecute = jest.fn().mockResolvedValue([[{ id: 1, name: 'test' }], []]);
    mockEnd = jest.fn().mockResolvedValue();

    mockConnection = {
      execute: mockExecute,
      end: mockEnd
    };

    mockCreateConnection = jest.fn().mockResolvedValue(mockConnection);
    adapter = new MySQLAdapter(mockCreateConnection);
  });

  describe('connect', () => {
    test('should connect to MySQL with correct URI', async () => {
      const uri = 'mysql://user:password@localhost:3306/database';

      await adapter.connect(uri);

      expect(adapter.connection).toBe(mockConnection);
      expect(mockCreateConnection).toHaveBeenCalledWith({
        host: 'localhost',
        port: 3306,
        user: 'user',
        password: 'password',
        database: 'database'
      });
    });

    test('should handle URI without password', async () => {
      const uri = 'mysql://user@localhost:3306/database';

      await adapter.connect(uri);

      expect(adapter.connection).toBe(mockConnection);
      expect(mockCreateConnection).toHaveBeenCalledWith({
        host: 'localhost',
        port: 3306,
        user: 'user',
        password: '',
        database: 'database'
      });
    });

    test('should remove mysql+pymysql:// prefix', async () => {
      const uri = 'mysql+pymysql://user:password@localhost:3306/database';

      await adapter.connect(uri);

      expect(adapter.connection).toBe(mockConnection);
      expect(mockCreateConnection).toHaveBeenCalledWith({
        host: 'localhost',
        port: 3306,
        user: 'user',
        password: 'password',
        database: 'database'
      });
    });

    test('should throw error for invalid URI format', async () => {
      const uri = 'invalid-uri-format';

      await expect(adapter.connect(uri)).rejects.toThrow('Invalid MySQL URI format');
    });
  });

  describe('execute', () => {
    test('should execute query and return rows', async () => {
      const mockRows = [{ id: 1, name: 'Test' }];
      mockExecute.mockResolvedValue([mockRows, []]);

      await adapter.connect('mysql://user:password@localhost:3306/database');
      const result = await adapter.execute('SELECT * FROM users');

      expect(result).toEqual(mockRows);
      expect(mockExecute).toHaveBeenCalledWith('SELECT * FROM users');
    });

    test('should throw error with SQL syntax info when query fails', async () => {
      const errorMessage = 'Unknown table \'nonexistent_table\'';
      mockExecute.mockRejectedValue(new Error(errorMessage));

      await adapter.connect('mysql://user:password@localhost:3306/database');

      await expect(adapter.execute('SELECT * FROM nonexistent_table')).rejects.toThrow(
        `MySQL Syntax Error: ${errorMessage}`
      );
    });
  });

  describe('close', () => {
    test('should end the connection if connection exists', async () => {
      await adapter.connect('mysql://user:password@localhost:3306/database');

      await adapter.close();

      expect(mockEnd).toHaveBeenCalled();
    });

    test('should not throw error if connection does not exist', async () => {
      // Убедимся, что connection не существует
      expect(adapter.connection).toBeUndefined();

      await expect(adapter.close()).resolves.not.toThrow();
    });
  });
});