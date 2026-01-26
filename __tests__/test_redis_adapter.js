const { RedisAdapter } = require('../src/adapters/redis.js');

describe('RedisAdapter', () => {
  let adapter;
  let mockClient;
  let mockConnect;
  let mockGet;
  let mockSet;
  let mockHGetAll;
  let mockHmGet;
  let mockLRange;
  let mockKeys;
  let mockExists;
  let mockDel;
  let mockFlushDb;
  let mockQuit;
  let mockSendCommand;
  let mockCreateClient;

  beforeEach(() => {
    mockConnect = jest.fn().mockResolvedValue();
    mockGet = jest.fn().mockResolvedValue('test_value');
    mockSet = jest.fn().mockResolvedValue('OK');
    mockHGetAll = jest.fn().mockResolvedValue({ field1: 'value1', field2: 'value2' });
    mockHmGet = jest.fn().mockResolvedValue(['value1', 'value2']);
    mockLRange = jest.fn().mockResolvedValue(['item1', 'item2']);
    mockKeys = jest.fn().mockResolvedValue(['key1', 'key2']);
    mockExists = jest.fn().mockResolvedValue(1);
    mockDel = jest.fn().mockResolvedValue(1);
    mockFlushDb = jest.fn().mockResolvedValue('OK');
    mockQuit = jest.fn().mockResolvedValue();
    mockSendCommand = jest.fn().mockResolvedValue('custom_result');

    mockClient = {
      connect: mockConnect,
      get: mockGet,
      set: mockSet,
      hGetAll: mockHGetAll,
      hmGet: mockHmGet,
      lRange: mockLRange,
      KEYS: mockKeys,
      exists: mockExists,
      del: mockDel,
      flushDb: mockFlushDb,
      quit: mockQuit,
      sendCommand: mockSendCommand
    };

    mockCreateClient = jest.fn(() => mockClient);
    adapter = new RedisAdapter(mockCreateClient);
  });

  describe('connect', () => {
    test('should connect to Redis with correct URI', async () => {
      const uri = 'redis://localhost:6379';

      await adapter.connect(uri);

      expect(adapter.client).toBe(mockClient);
      expect(mockConnect).toHaveBeenCalled();
    });

    test('should add redis:// prefix if missing', async () => {
      const uri = 'localhost:6379';

      await adapter.connect(uri);

      expect(adapter.client).toBe(mockClient);
      expect(mockConnect).toHaveBeenCalled();
    });
  });

  describe('parseCommand', () => {
    test('should parse simple command', () => {
      expect(adapter.parseCommand('GET key')).toEqual(['GET', 'key']);
    });

    test('should parse command with spaces', () => {
      expect(adapter.parseCommand('SET key value')).toEqual(['SET', 'key', 'value']);
    });

    test('should parse command with quoted value having spaces', () => {
      expect(adapter.parseCommand('SET key "value with spaces"')).toEqual(['SET', 'key', 'value with spaces']);
    });

    test('should parse command with single quotes', () => {
      expect(adapter.parseCommand("SET key 'value with spaces'")).toEqual(['SET', 'key', 'value with spaces']);
    });

    test('should parse command with mixed quotes', () => {
      expect(adapter.parseCommand('SET key "value \'with\' quotes"')).toEqual(['SET', 'key', "value 'with' quotes"]);
    });

    test('should handle multiple spaces between arguments', () => {
      expect(adapter.parseCommand('SET   key    value')).toEqual(['SET', 'key', 'value']);
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      // Убедимся, что клиент подключен перед выполнением команд
      await adapter.connect('redis://localhost:6379');
    });

    test('should execute GET command and return value', async () => {
      const result = await adapter.execute('GET mykey');

      expect(mockGet).toHaveBeenCalledWith('mykey');
      // В адаптере результат GET оборачивается в массив
      // Если результат - строка и не JSON, то возвращается как есть в массиве
      expect(result).toEqual(['test_value']);
    });

    test('should execute SET command', async () => {
      const result = await adapter.execute('SET mykey myvalue');

      expect(mockSet).toHaveBeenCalledWith('mykey', 'myvalue');
      expect(result).toEqual([{ status: 'OK' }]);
    });

    test('should execute HGETALL command', async () => {
      const result = await adapter.execute('HGETALL myhash');

      expect(mockHGetAll).toHaveBeenCalledWith('myhash');
      expect(result).toEqual([{ field1: 'value1', field2: 'value2' }]);
    });

    test('should execute HMGET command', async () => {
      const result = await adapter.execute('HMGET myhash field1 field2');

      expect(mockHmGet).toHaveBeenCalledWith('myhash', ['field1', 'field2']);
      expect(result).toEqual([['value1', 'value2']]);
    });

    test('should execute LRANGE command', async () => {
      const result = await adapter.execute('LRANGE mylist 0 -1');

      expect(mockLRange).toHaveBeenCalledWith('mylist', 0, -1);
      // LRANGE возвращает массив, который не оборачивается дополнительно
      expect(result).toEqual(['item1', 'item2']);
    });

    test('should execute KEYS command', async () => {
      const result = await adapter.execute('KEYS *');

      expect(mockKeys).toHaveBeenCalledWith('*');
      // Результат KEYS форматируется как массив объектов с ключом key
      expect(result).toEqual([{ key: 'key1' }, { key: 'key2' }]);
    });

    test('should execute EXISTS command', async () => {
      const result = await adapter.execute('EXISTS mykey');

      expect(mockExists).toHaveBeenCalledWith('mykey');
      expect(result).toEqual([{ exists: 1 }]);
    });

    test('should execute DEL command', async () => {
      const result = await adapter.execute('DEL mykey');

      expect(mockDel).toHaveBeenCalledWith('mykey');
      expect(result).toEqual([{ deleted: 1 }]);
    });

    test('should execute FLUSHDB command', async () => {
      const result = await adapter.execute('FLUSHDB');

      expect(mockFlushDb).toHaveBeenCalled();
      expect(result).toEqual([{ flushed: 'OK' }]);
    });

    test('should execute custom command', async () => {
      const result = await adapter.execute('PING');

      expect(mockSendCommand).toHaveBeenCalledWith(['PING']);
      expect(result).toEqual(['custom_result']);
    });

    test('should throw error when command fails', async () => {
      mockGet.mockRejectedValue(new Error('Connection refused'));

      await expect(adapter.execute('GET mykey')).rejects.toThrow(
        'Redis Command Error: Connection refused'
      );
    });
  });

  describe('close', () => {
    test('should quit the client if client exists', async () => {
      await adapter.connect('redis://localhost:6379');

      await adapter.close();

      expect(mockQuit).toHaveBeenCalled();
    });

    test('should not throw error if client does not exist', async () => {
      // Убедимся, что client не существует
      delete adapter.client;

      await expect(adapter.close()).resolves.not.toThrow();
    });
  });
});