import { MySQLAdapter, withExecutionLimit } from '../src/adapters/mysql.js';

describe('MySQLAdapter', () => {
  let adapter;
  let mockQuery;
  let mockEnd;
  let mockPoolConnections;
  let mockPool;
  let mockCreatePool;

  beforeEach(() => {
    mockQuery = jest.fn().mockResolvedValue([[{ id: 1, name: 'test' }], []]);
    mockEnd = jest.fn().mockResolvedValue();
    mockPoolConnections = [];
    mockPool = {
      query: mockQuery,
      end: mockEnd,
      get pool() { return mockPoolConnections; }
    };
    mockCreatePool = jest.fn(() => mockPool);

    adapter = new MySQLAdapter(mockCreatePool, 30000);
  });

  describe('connect', () => {
    test('creates a pool from the URI', async () => {
      await adapter.connect('mysql://user:password@localhost:3306/database');

      expect(adapter.pool).toBe(mockPool);
      expect(mockCreatePool).toHaveBeenCalledWith({
        host: 'localhost',
        port: 3306,
        user: 'user',
        password: 'password',
        database: 'database',
        connectTimeout: 5000,
        connectionLimit: 4,
        waitForConnections: true,
        queueLimit: 0,
        enableKeepAlive: true
      });
    });

    test('bounds the pool so one caller cannot exhaust connections', async () => {
      const sized = new MySQLAdapter(mockCreatePool, 30000, 10);
      await sized.connect('mysql://u:p@h/d');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({
        connectionLimit: 10,
        waitForConnections: true
      }));
    });

    test('defaults the port to 3306', async () => {
      await adapter.connect('mysql://user:password@localhost/database');
      expect(mockCreatePool).toHaveBeenCalledWith(expect.objectContaining({ port: 3306 }));
    });

    test('handles a URI without a password', async () => {
      await adapter.connect('mysql://user@localhost:3306/database');
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'user', password: '' })
      );
    });

    test('decodes percent-encoded credentials', async () => {
      await adapter.connect('mysql://user%40corp:p%40ss%3Aword@localhost/db');
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'user@corp', password: 'p@ss:word' })
      );
    });

    test('decodes a percent-encoded database name', async () => {
      await adapter.connect('mysql://user:pass@localhost/my%20db');
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ database: 'my db' })
      );
    });

    test.each([
      'mysql+pymysql://user:password@localhost:3306/database',
      'mysql+mysqldb://user:password@localhost:3306/database',
      'mysql+asyncmy://user:password@localhost:3306/database',
    ])('normalises %s', async (uri) => {
      await adapter.connect(uri);
      expect(mockCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'user', password: 'password' })
      );
    });

    test('rejects a malformed URI', async () => {
      await expect(adapter.connect('invalid-uri-format'))
        .rejects.toThrow('Invalid MySQL URI format');
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      await adapter.connect('mysql://user:password@localhost:3306/database');
    });

    test('returns SELECT rows unchanged', async () => {
      const rows = [{ id: 1, name: 'Test' }];
      mockQuery.mockResolvedValue([rows, []]);

      await expect(adapter.execute('SELECT * FROM users')).resolves.toEqual(rows);
    });

    test('wraps a non-SELECT result in an array', async () => {
      const okPacket = {
        affectedRows: 3, insertId: 7, changedRows: 1, warningStatus: 0, info: 'Records: 3'
      };
      mockQuery.mockResolvedValue([okPacket, []]);

      const result = await adapter.execute('UPDATE users SET a = 1');

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([{
        affectedRows: 3, insertId: 7, changedRows: 1, warningStatus: 0, info: 'Records: 3'
      }]);
    });

    test('normalises a missing result to an empty array', async () => {
      mockQuery.mockResolvedValue([undefined, []]);
      await expect(adapter.execute('SET @x = 1')).resolves.toEqual([]);
    });

    test('does not pass a per-query timeout as if it were a values array', async () => {
      await adapter.execute('SELECT 1');
      // mysql2 interprets a second argument as bound values.
      expect(mockQuery.mock.calls[0]).toHaveLength(1);
    });

    describe('error classification', () => {
      test.each([
        ['ER_NO_SUCH_TABLE', "Table 'db.nope' doesn't exist", 'table does not exist'],
        ['ER_PARSE_ERROR', 'You have an error in your SQL syntax', 'SQL syntax error'],
        ['ER_ACCESS_DENIED_ERROR', "Access denied for user 'u'@'h'", 'access denied'],
        ['ER_DUP_ENTRY', "Duplicate entry '1' for key 'PRIMARY'", 'duplicate key'],
        ['ER_NO_REFERENCED_ROW', 'a foreign key constraint fails', 'foreign key constraint'],
        ['ER_TABLEACCESS_DENIED_ERROR', 'SELECT command denied', 'access denied to table'],
      ])('names %s accurately rather than calling it a syntax error', async (code, message, expected) => {
        mockQuery.mockRejectedValue(Object.assign(new Error(message), { code, sqlMessage: message }));

        const error = await adapter.execute('SELECT 1').catch(e => e);
        expect(error.message).toContain(expected);
        expect(error.message).not.toMatch(/Syntax Error/);
      });

      test('surfaces an unknown error code instead of discarding it', async () => {
        mockQuery.mockRejectedValueOnce(
          Object.assign(new Error('something odd'), { code: 'ER_SOMETHING_NEW' })
        );
        await expect(adapter.execute('SELECT 1'))
          .rejects.toThrow('[MySQL ER_SOMETHING_NEW]');
      });
    });

    test.each(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT'])(
      'treats %s as a timeout', async (code) => {
        mockQuery.mockRejectedValueOnce(Object.assign(new Error('gone'), { code }));
        await expect(adapter.execute('SELECT 1'))
          .rejects.toThrow(/query exceeded 30000ms timeout/);
      }
    );
  });

  describe('withExecutionLimit', () => {
    test('places the hint after the leading keyword, where MySQL honours it', () => {
      // Before SELECT the hint is ignored silently, so placement is the whole
      // point of this helper.
      expect(withExecutionLimit('SELECT 1', 1000))
        .toBe('SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1');
    });

    test('skips leading whitespace and comments', () => {
      expect(withExecutionLimit('  -- note\n  SELECT 1', 500))
        .toBe('  -- note\n  SELECT /*+ MAX_EXECUTION_TIME(500) */ 1');
      expect(withExecutionLimit('/* c */ SELECT 1', 500))
        .toBe('/* c */ SELECT /*+ MAX_EXECUTION_TIME(500) */ 1');
    });

    test.each([
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a = 1',
      'SHOW TABLES',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      '',
    ])('leaves %s unannotated', (sql) => {
      expect(withExecutionLimit(sql, 1000)).toBe(sql);
    });

    test('is a no-op for a non-positive timeout', () => {
      expect(withExecutionLimit('SELECT 1', 0)).toBe('SELECT 1');
      expect(withExecutionLimit('SELECT 1', -5)).toBe('SELECT 1');
    });

    test('truncates a fractional timeout to whole milliseconds', () => {
      expect(withExecutionLimit('SELECT 1', 1000.9)).toContain('MAX_EXECUTION_TIME(1000)');
    });
  });

  describe('isHealthy', () => {
    test('is true when the pool answers', async () => {
      await adapter.connect('mysql://u:p@h/d');
      await expect(adapter.isHealthy()).resolves.toBe(true);
    });

    test('is false when the pool has no usable connection', async () => {
      // A server that closed the socket while it was idle looks like this.
      await adapter.connect('mysql://u:p@h/d');
      mockQuery.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'PROTOCOL_CONNECTION_LOST' }));
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });

    test('is false with no pool', async () => {
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });
  });

  describe('abort', () => {
    test('destroys the pooled sockets so the server stops working', async () => {
      const conn = { destroy: jest.fn() };
      mockPoolConnections.push(conn);
      await adapter.connect('mysql://user:password@localhost:3306/database');

      adapter.abort();

      expect(conn.destroy).toHaveBeenCalled();
      expect(adapter.pool).toBeNull();
    });

    test('close() after abort does not also try to end the pool', async () => {
      await adapter.connect('mysql://user:password@localhost:3306/database');
      adapter.abort();
      await adapter.close();
      expect(mockEnd).not.toHaveBeenCalled();
    });

    test('is safe with no pool', () => {
      expect(() => adapter.abort()).not.toThrow();
    });
  });

  describe('close', () => {
    test('ends the pool', async () => {
      await adapter.connect('mysql://user:password@localhost:3306/database');
      await adapter.close();
      expect(mockEnd).toHaveBeenCalled();
    });

    test('is a no-op with no pool', async () => {
      await expect(adapter.close()).resolves.not.toThrow();
    });

    test('does not throw when the pool fails to close', async () => {
      mockEnd.mockRejectedValueOnce(new Error('pool already ended'));
      await adapter.connect('mysql://user:password@localhost:3306/database');
      await expect(adapter.close()).resolves.not.toThrow();
    });
  });
});
