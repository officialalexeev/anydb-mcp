const { PostgresAdapter } = require('../src/adapters/postgres.js');

describe('PostgresAdapter', () => {
  let adapter;
  let mockPool;
  let mockQuery;
  let mockEnd;

  beforeEach(() => {
    mockQuery = jest.fn();
    mockEnd = jest.fn();
    
    mockPool = {
      query: mockQuery,
      end: mockEnd
    };
    
    // Создаем мок-конструктор
    const mockPoolConstructor = jest.fn(() => mockPool);
    
    adapter = new PostgresAdapter(mockPoolConstructor);
  });

  describe('connect', () => {
    test('should create pool with correct connection string', async () => {
      const uri = 'postgres://user:pass@localhost:5432/mydb';
      
      await adapter.connect(uri);
      
      expect(adapter.pool).toBe(mockPool);
    });
  });

  describe('execute', () => {
    test('should execute query and return rows', async () => {
      const mockRows = [{ id: 1, name: 'Test' }];
      mockQuery.mockResolvedValue({ rows: mockRows });
      
      await adapter.connect('postgres://user:pass@localhost:5432/mydb');
      const result = await adapter.execute('SELECT * FROM users');
      
      expect(result).toEqual(mockRows);
      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM users');
    });

    test('should throw error with SQL syntax info when query fails', async () => {
      const errorMessage = 'syntax error at or near "FAKE"';
      mockQuery.mockRejectedValue(new Error(errorMessage));
      
      await adapter.connect('postgres://user:pass@localhost:5432/mydb');
      
      await expect(adapter.execute('FAKE QUERY')).rejects.toThrow(
        `[Postgres Execute Error]: ${errorMessage}`
      );
    });
  });

  describe('close', () => {
    test('should end the pool if pool exists', async () => {
      await adapter.connect('postgres://user:pass@localhost:5432/mydb');
      
      await adapter.close();
      
      expect(mockEnd).toHaveBeenCalled();
    });

    test('should not throw error if pool does not exist', async () => {
      // Убедимся, что pool не существует
      expect(adapter.pool).toBeUndefined();
      
      await expect(adapter.close()).resolves.not.toThrow();
    });
  });
});