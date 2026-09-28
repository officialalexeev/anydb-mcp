import { MongoAdapter, DEFAULT_LIMIT, MAX_LIMIT } from '../src/adapters/mongodb.js';

// Behaviour of individual actions is covered in test_mongodb_actions.test.js.
// This file covers the connection lifecycle.
describe('MongoAdapter connection', () => {
  let adapter;
  let mockClient;
  let mockClientConstructor;

  beforeEach(() => {
    mockClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      db: { collection: jest.fn(() => ({ find: jest.fn() })) }
    };
    mockClientConstructor = jest.fn(() => mockClient);
    adapter = new MongoAdapter(mockClientConstructor, 30000);
  });

  describe('connect', () => {
    test('applies the connection timeouts', async () => {
      await adapter.connect('mongodb://localhost:27017/mydb');

      expect(adapter.db).toBe(mockClient.db);
      expect(mockClientConstructor).toHaveBeenCalledWith('mongodb://localhost:27017/mydb', {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000
      });
    });

    test('reports a server that cannot be selected', async () => {
      mockClient.connect = jest.fn().mockRejectedValue(
        new Error('Server selection timed out after 5000 ms')
      );
      await expect(adapter.connect('mongodb://localhost:27017/mydb'))
        .rejects.toThrow(/Server selection timed out/);
    });
  });

  describe('limits', () => {
    test('exposes the documented bounds', () => {
      expect(DEFAULT_LIMIT).toBe(50);
      expect(MAX_LIMIT).toBe(1000);
    });
  });

  describe('isHealthy', () => {
    test('reads the topology state', async () => {
      await adapter.connect('mongodb://h/d');

      mockClient.topology = { isConnected: () => true };
      expect(adapter.isHealthy()).toBe(true);

      mockClient.topology = { isConnected: () => false };
      expect(adapter.isHealthy()).toBe(false);
    });

    test('is unhealthy when the topology is unknown', async () => {
      await adapter.connect('mongodb://h/d');
      expect(adapter.isHealthy()).toBe(false);
    });

    test('is unhealthy with no client', () => {
      expect(adapter.isHealthy()).toBe(false);
    });
  });

  describe('abort', () => {
    test('closes the client forcibly', async () => {
      await adapter.connect('mongodb://h/d');
      adapter.abort();

      expect(mockClient.close).toHaveBeenCalledWith(true);
      expect(adapter.client).toBeNull();
      expect(adapter.db).toBeNull();
    });

    test('is safe with no client', () => {
      expect(() => adapter.abort()).not.toThrow();
    });
  });

  describe('close', () => {
    test('closes the client', async () => {
      await adapter.connect('mongodb://h/d');
      await adapter.close();
      expect(mockClient.close).toHaveBeenCalled();
    });

    test('does not throw when close fails', async () => {
      mockClient.close = jest.fn().mockRejectedValue(new Error('already closed'));
      await adapter.connect('mongodb://h/d');
      await expect(adapter.close()).resolves.not.toThrow();
    });

    test('is a no-op with no client', async () => {
      await expect(adapter.close()).resolves.not.toThrow();
    });
  });
});
