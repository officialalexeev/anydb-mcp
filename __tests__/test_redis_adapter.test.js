import { RedisAdapter } from '../src/adapters/redis.js';

describe('RedisAdapter', () => {
  let adapter;
  let mockSendCommand;
  let mockConnect;
  let mockQuit;
  let mockDestroy;
  let mockClient;

  beforeEach(() => {
    mockSendCommand = jest.fn().mockResolvedValue('OK');
    mockConnect = jest.fn().mockResolvedValue(undefined);
    mockQuit = jest.fn().mockResolvedValue(undefined);
    mockDestroy = jest.fn();

    mockClient = { sendCommand: mockSendCommand, connect: mockConnect, quit: mockQuit, destroy: mockDestroy };
    adapter = new RedisAdapter(jest.fn(() => mockClient), 30000);
  });

  const connect = (uri = 'redis://localhost:6379') => adapter.connect(uri);

  describe('connect', () => {
    test('passes the URL and socket timeouts through', async () => {
      const factory = jest.fn(() => mockClient);
      const a = new RedisAdapter(factory, 30000);
      await a.connect('redis://localhost:6379');

      expect(factory).toHaveBeenCalledWith(expect.objectContaining({
        url: 'redis://localhost:6379',
        socket: { connectTimeout: 5000, timeout: 30000 }
      }));
      expect(mockConnect).toHaveBeenCalled();
    });

    test.each([
      ['localhost:6379', 'redis://localhost:6379'],
      ['user:pass@host:6379', 'redis://user:pass@host:6379'],
    ])('adds a missing redis:// prefix to %s', async (input, expected) => {
      const factory = jest.fn(() => mockClient);
      const a = new RedisAdapter(factory, 30000);
      await a.connect(input);
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({ url: expected }));
    });

    test('leaves rediss:// alone for TLS', async () => {
      const factory = jest.fn(() => mockClient);
      const a = new RedisAdapter(factory, 30000);
      await a.connect('rediss://secure:6380');
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({ url: 'rediss://secure:6380' }));
    });

    test('reports a connection failure', async () => {
      mockConnect.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED'
      }));
      await expect(connect()).rejects.toThrow(/ECONNREFUSED/);
    });
  });

  describe('execute', () => {
    beforeEach(() => connect());

    test('sends the command with its arguments', async () => {
      await adapter.execute('HGETALL user:1');
      expect(mockSendCommand).toHaveBeenCalledWith(['HGETALL', 'user:1']);
    });

    test('always returns an array', async () => {
      mockSendCommand.mockResolvedValueOnce('PONG');
      await expect(adapter.execute('PING')).resolves.toEqual(['PONG']);
    });

    test('keeps a reply that is already an array', async () => {
      mockSendCommand.mockResolvedValueOnce(['a', 'b']);
      await expect(adapter.execute('MGET a b')).resolves.toEqual(['a', 'b']);
    });

    test('decodes a JSON string for a value command', async () => {
      mockSendCommand.mockResolvedValueOnce('{"id":1,"name":"Test"}');
      await expect(adapter.execute('GET user:1'))
        .resolves.toEqual([{ id: 1, name: 'Test' }]);
    });

    test('returns a plain string untouched when it is not JSON', async () => {
      mockSendCommand.mockResolvedValueOnce('just text');
      await expect(adapter.execute('GET greeting')).resolves.toEqual(['just text']);
    });

    test('handles a nil reply', async () => {
      mockSendCommand.mockResolvedValueOnce(null);
      await expect(adapter.execute('GET missing')).resolves.toEqual([null]);
    });

    test('returns an empty array for an empty command', async () => {
      await expect(adapter.execute('   ')).resolves.toEqual([]);
      expect(mockSendCommand).not.toHaveBeenCalled();
    });

    test('reports a command error', async () => {
      mockSendCommand.mockRejectedValueOnce(
        Object.assign(new Error('WRONGTYPE Operation against a key'), { name: 'ReplyError' }));
      await expect(adapter.execute('LPUSH a b'))
        .rejects.toThrow(/WRONGTYPE/);
    });

    test('mentions the timeout when the socket dies mid-command', async () => {
      mockSendCommand.mockRejectedValueOnce(
        Object.assign(new Error('Socket closed unexpectedly'), { name: 'SocketClosedUnexpectedlyError' }));
      await expect(adapter.execute('GET k'))
        .rejects.toThrow(/client timeout was 30000ms/);
    });
  });

  describe('parseCommand', () => {
    test('splits on whitespace', () => {
      expect(adapter.parseCommand('GET key')).toEqual(['GET', 'key']);
      expect(adapter.parseCommand('  HSET   h  f   v  ')).toEqual(['HSET', 'h', 'f', 'v']);
    });

    test('keeps a quoted value with spaces intact', () => {
      expect(adapter.parseCommand('SET greeting "hello there world"'))
        .toEqual(['SET', 'greeting', 'hello there world']);
    });

    test('handles single quotes', () => {
      expect(adapter.parseCommand("SET k 'a b'")).toEqual(['SET', 'k', 'a b']);
    });

    test('handles an escaped quote inside a value', () => {
      expect(adapter.parseCommand('SET k "say \\"hi\\""')).toEqual(['SET', 'k', 'say "hi"']);
    });

    test('preserves an intentionally empty value', () => {
      expect(adapter.parseCommand('SET k ""')).toEqual(['SET', 'k', '']);
    });

    test('preserves an empty key argument', () => {
      expect(adapter.parseCommand('GET ""')).toEqual(['GET', '']);
    });

    test('rejects an unbalanced quote instead of silently dropping it', () => {
      expect(() => adapter.parseCommand('SET k "unterminated')).toThrow('Unbalanced quote');
    });
  });

  describe('abort', () => {
    test('destroys the socket', async () => {
      await connect();
      adapter.abort();
      expect(mockDestroy).toHaveBeenCalled();
    });

    test('close() after abort does not also try to quit', async () => {
      await connect();
      adapter.abort();
      await adapter.close();
      expect(mockQuit).not.toHaveBeenCalled();
    });

    test('is safe with no client', () => {
      expect(() => adapter.abort()).not.toThrow();
    });
  });

  describe('close', () => {
    test('quits the connection', async () => {
      await connect();
      await adapter.close();
      expect(mockQuit).toHaveBeenCalled();
    });

    test('does not throw when the client is already closed', async () => {
      mockQuit.mockRejectedValueOnce(new Error('The client is closed'));
      await connect();
      await expect(adapter.close()).resolves.not.toThrow();
    });

    test('is a no-op with no client', async () => {
      await expect(adapter.close()).resolves.not.toThrow();
    });
  });
});
