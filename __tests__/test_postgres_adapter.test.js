import { PostgresAdapter } from '../src/adapters/postgres.js';

describe('PostgresAdapter', () => {
  let adapter;
  let mockQuery;
  let mockRelease;
  let mockEnd;
  let mockClient;
  let mockPool;
  let mockPoolConstructor;

  beforeEach(() => {
    mockQuery = jest.fn();
    mockRelease = jest.fn();
    mockEnd = jest.fn().mockResolvedValue();

    mockClient = { query: mockQuery, release: mockRelease };
    mockPool = { connect: jest.fn().mockResolvedValue(mockClient), end: mockEnd };
    mockPoolConstructor = jest.fn(() => mockPool);

    adapter = new PostgresAdapter(mockPoolConstructor, 30000);
  });

  const connect = () => adapter.connect('postgres://user:pass@localhost:5432/mydb');

  describe('connect', () => {
    test('creates a pool from the connection string', async () => {
      await connect();

      expect(adapter.pool).toBe(mockPool);
      expect(mockPoolConstructor).toHaveBeenCalledWith(expect.objectContaining({
        connectionString: 'postgres://user:pass@localhost:5432/mydb',
        connectionTimeoutMillis: 5000
      }));
    });
  });

  describe('execute', () => {
    test('returns rows unchanged', async () => {
      mockQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 1 }] });

      await connect();
      await expect(adapter.execute('SELECT * FROM users')).resolves.toEqual([{ id: 1 }]);
    });

    test('sets statement_timeout and the query on the same connection', async () => {
      mockQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] });

      await connect();
      await adapter.execute('SELECT 1');

      // statement_timeout is a session setting. Two pool.query() calls could
      // land on different clients, leaving the timeout unenforced.
      expect(mockPool.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.query).toHaveBeenNthCalledWith(1, 'SET statement_timeout = 30000');
      expect(mockClient.query).toHaveBeenNthCalledWith(2, 'SELECT 1');
    });

    test('releases the client back to the pool', async () => {
      mockQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] });

      await connect();
      await adapter.execute('SELECT 1');

      expect(mockRelease).toHaveBeenCalled();
    });

    test('releases the client even when the query fails', async () => {
      mockQuery.mockResolvedValueOnce({}).mockRejectedValueOnce(
        Object.assign(new Error('syntax error'), { code: '42601' })
      );

      await connect();
      await expect(adapter.execute('FAKE')).rejects.toThrow();
      expect(mockRelease).toHaveBeenCalled();
    });

    test('returns a status array for a statement with no rows', async () => {
      mockQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({
        rows: [], command: 'INSERT', oid: 16400, rowCount: 1
      });

      await connect();
      await expect(adapter.execute('INSERT INTO t VALUES (1)')).resolves.toEqual([
        { affectedRows: 1, command: 'INSERT', oid: 16400 }
      ]);
    });

    test('reports a statement timeout', async () => {
      mockQuery.mockResolvedValueOnce({}).mockRejectedValueOnce({
        code: '57014', message: 'canceling statement due to statement timeout'
      });

      await connect();
      await expect(adapter.execute('SLOW')).rejects
        .toThrow('Query exceeded 30000ms (statement_timeout)');
    });

    test('does not claim a timeout for a user cancel', async () => {
      mockQuery.mockResolvedValueOnce({}).mockRejectedValueOnce({
        code: '57014', message: 'canceling statement due to user request'
      });

      await connect();
      await expect(adapter.execute('SELECT 1')).rejects
        .toThrow('[Postgres cancelled]');
    });

    test.each([
      ['42P01', 'relation "nope" does not exist', 'relation (table or view) does not exist'],
      ['42703', 'column "nope" does not exist', 'column does not exist'],
      ['42501', 'permission denied for table users', 'insufficient privilege'],
      ['23505', 'duplicate key value violates unique constraint', 'duplicate key'],
      ['42601', 'syntax error at or near "FAKE"', 'SQL syntax error'],
    ])('names SQLSTATE %s accurately', async (code, message, expected) => {
      mockQuery.mockResolvedValueOnce({}).mockRejectedValueOnce(
        Object.assign(new Error(message), { code })
      );

      await connect();
      await expect(adapter.execute('SELECT 1')).rejects.toThrow(expected);
    });

    test('keeps an unknown SQLSTATE visible', async () => {
      mockQuery.mockResolvedValueOnce({}).mockRejectedValueOnce(
        Object.assign(new Error('mystery'), { code: 'XX000' })
      );

      await connect();
      await expect(adapter.execute('SELECT 1')).rejects.toThrow('[Postgres XX000] mystery');
    });
  });

  describe('close', () => {
    test('ends the pool', async () => {
      await connect();
      await adapter.close();
      expect(mockEnd).toHaveBeenCalled();
    });

    test('is a no-op with no pool', async () => {
      await expect(adapter.close()).resolves.not.toThrow();
    });

    test('does not throw when the pool fails to close', async () => {
      mockEnd.mockRejectedValueOnce(new Error('pool already ended'));
      await connect();
      await expect(adapter.close()).resolves.not.toThrow();
    });
  });
});
