const { MongoAdapter } = require('../src/adapters/mongodb.js');

describe('MongoAdapter', () => {
  let adapter;
  let mockClient;
  let mockConnect;
  let mockClose;
  let mockCollection;
  let mockFind;
  let mockLimit;
  let mockToArray;
  let mockDb;

  beforeEach(() => {
    mockConnect = jest.fn().mockResolvedValue();
    mockClose = jest.fn().mockResolvedValue();
    mockFind = jest.fn();
    mockLimit = jest.fn();
    mockToArray = jest.fn();
    
    // Мокаем результаты цепочки вызовов
    mockFind.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ toArray: mockToArray });
    
    mockCollection = {
      find: mockFind
    };
    
    mockDb = {
      collection: jest.fn(() => mockCollection)
    };
    
    mockClient = {
      connect: mockConnect,
      close: mockClose,
      db: mockDb
    };
    
    // Создаем мок-конструктор
    const mockClientConstructor = jest.fn(() => mockClient);
    
    adapter = new MongoAdapter(mockClientConstructor);
  });

  describe('connect', () => {
    test('should connect to MongoDB with correct URI', async () => {
      const uri = 'mongodb://localhost:27017/mydb';
      
      await adapter.connect(uri);
      
      expect(adapter.client).toBe(mockClient);
      expect(adapter.db).toBe(mockDb);
      expect(mockConnect).toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    test('should throw error if collection is not provided', async () => {
      await expect(adapter.execute('{}', {}))
        .rejects.toThrow('Collection name is required for MongoDB');
    });

    test('should execute query and return results', async () => {
      const mockResults = [{ _id: 1, name: 'Test' }];
      mockToArray.mockResolvedValue(mockResults);
      
      const query = '{"name": "Test"}';
      const options = { collection: 'users' };
      
      await adapter.connect('mongodb://localhost:27017/mydb');
      const result = await adapter.execute(query, options);
      
      expect(adapter.db.collection).toHaveBeenCalledWith('users');
      expect(mockCollection.find).toHaveBeenCalledWith({ name: 'Test' });
      expect(result).toEqual(mockResults);
    });

    test('should parse JSON query string correctly', async () => {
      const mockResults = [];
      mockToArray.mockResolvedValue(mockResults);
      
      const query = '{"age": {"$gte": 18}}';
      const options = { collection: 'users' };
      
      await adapter.connect('mongodb://localhost:27017/mydb');
      await adapter.execute(query, options);
      
      expect(mockCollection.find).toHaveBeenCalledWith({ age: { "$gte": 18 } });
    });
  });

  describe('close', () => {
    test('should close the client if client exists', async () => {
      const mockCloseFn = jest.fn().mockResolvedValue();
      const mockClientInstance = {
        close: mockCloseFn
      };
      adapter.client = mockClientInstance;
      
      await adapter.close();
      
      expect(mockCloseFn).toHaveBeenCalled();
    });

    test('should not throw error if client does not exist', async () => {
      // Убедимся, что client не существует
      delete adapter.client;
      
      await expect(adapter.close()).resolves.not.toThrow();
    });
  });
});