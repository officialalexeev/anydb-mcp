import { RedisAdapter } from '../src/adapters/redis.js';
import { AdapterRegistry } from '../src/core/registry.js';
import { checkConnectionPolicy, DEFAULT_ALLOWED_SCHEMES } from '../src/core/policy.js';
import { baseProtocol, inspectQuery } from '../src/core/safety.js';

describe('RedisAdapter', () => {
  let adapter;
  let mockSendCommand;
  let mockConnect;
  let mockQuit;
  let mockDestroy;
  let mockClient;
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.ANYDB_REDIS_SOCKET_TIMEOUT_MS;
    delete process.env.ANYDB_REDIS_SOCKET_TIMEOUT_MS;

    mockSendCommand = jest.fn().mockResolvedValue('OK');
    mockConnect = jest.fn().mockResolvedValue(undefined);
    mockQuit = jest.fn().mockResolvedValue(undefined);
    mockDestroy = jest.fn();

    mockClient = {
      sendCommand: mockSendCommand,
      connect: mockConnect,
      quit: mockQuit,
      destroy: mockDestroy,
      isReady: true
    };
    adapter = new RedisAdapter(jest.fn(() => mockClient), 30000);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ANYDB_REDIS_SOCKET_TIMEOUT_MS;
    else process.env.ANYDB_REDIS_SOCKET_TIMEOUT_MS = savedEnv;
  });

  const connect = (uri = 'redis://localhost:6379') => adapter.connect(uri);

  describe('driver shape', () => {
    // The two facts the two halves of this adapter rest on, read from the
    // installed driver rather than assumed.
    test('INFO declares no reply transformer, so it is a raw string', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(
          process.cwd(), 'node_modules', '@redis', 'client', 'dist', 'lib', 'commands', 'INFO.js'
        ),
        'utf8'
      );
      // The keyspace parse treated the reply as a parsed object, so
      // `Object.entries("db0:keys=12,…")` produced one entry per character and
      // the keyspace was reported empty on every Redis server on earth.
      expect(source).toContain('transformReply: undefined');
    });

    test('the scan iterators yield a page per iteration, not one key', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(
          process.cwd(), 'node_modules', '@redis', 'client', 'dist', 'lib', 'client', 'index.js'
        ),
        'utf8'
      );
      // `for await (const key of scanIterator())` pushing straight into a result
      // gives an array of arrays on a real server.
      expect(source).toMatch(/async \*scanIterator\(options\) \{[\s\S]{0,400}?yield reply\.keys/);
      expect(source).toMatch(/async \*hScanIterator\(key, options\) \{[\s\S]{0,400}?yield reply\.entries/);
      expect(source).toMatch(/async \*sScanIterator\(key, options\) \{[\s\S]{0,400}?yield reply\.members/);
      expect(source).toMatch(/async \*zScanIterator\(key, options\) \{[\s\S]{0,400}?yield reply\.members/);
    });

    test('HGETALL is decoded only on the typed path, not on sendCommand', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(
          process.cwd(), 'node_modules', '@redis', 'client', 'dist', 'lib', 'commands', 'HGETALL.js'
        ),
        'utf8'
      );
      expect(source).toContain('transformTuplesReply');
      // `client.hGetAll()` applies it; `sendCommand(['HGETALL', k])` does not, so
      // the flat RESP2 array is what arrives.
      const client = require('node:fs').readFileSync(
        require('node:path').join(
          process.cwd(), 'node_modules', '@redis', 'client', 'dist', 'lib', 'client', 'index.js'
        ),
        'utf8'
      );
      // The window is generous because the guard clauses sit between the two
      // points being compared; what matters is that the answer is on its way to
      // the queue with no transformer applied to it on the way.
      expect(client).toMatch(/sendCommand\(args, options\) \{[\s\S]{0,2000}?#queue\.addCommand\(args, opts\)/);
      expect(client).not.toMatch(/sendCommand\(args, options\) \{[\s\S]{0,2000}?transformReply/);
    });
  });

  describe('connect', () => {
    test('passes the URL and the connect timeout through', async () => {
      const factory = jest.fn(() => mockClient);
      const a = new RedisAdapter(factory, 30000);
      await a.connect('redis://localhost:6379');

      expect(factory).toHaveBeenCalledWith(expect.objectContaining({
        url: 'redis://localhost:6379',
        socket: { connectTimeout: 5000, timeout: undefined }
      }));
      expect(mockConnect).toHaveBeenCalled();
    });

    // The socket timeout used to be `this.queryTimeout`, which the cache no
    // longer stamps onto an adapter: a client created by a first call with
    // `timeout: 1000` kept that socket timeout for the life of the cache entry,
    // so every later call — including one that asked for thirty seconds — was cut
    // off at one second by a limit the caller never set.
    test('does not bake the query budget into the socket', async () => {
      const factory = jest.fn(() => mockClient);
      const a = new RedisAdapter(factory, 1000);
      await a.connect('redis://localhost:6379');

      expect(factory.mock.calls[0][0].socket.timeout).toBeUndefined();
      expect(a.resolveQueryTimeout({ timeout: 30000 })).toBe(30000);
    });

    test('still lets a deployment ask for a socket timeout', async () => {
      process.env.ANYDB_REDIS_SOCKET_TIMEOUT_MS = '9000';
      const factory = jest.fn(() => mockClient);
      const a = new RedisAdapter(factory, 30000);
      await a.connect('redis://localhost:6379');

      expect(factory.mock.calls[0][0].socket.timeout).toBe(9000);
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

    describe('cluster and sentinel', () => {
      const clusterFactory = jest.fn(() => ({ connect: jest.fn().mockResolvedValue() }));
      const sentinelFactory = jest.fn(() => ({ connect: jest.fn().mockResolvedValue() }));

      test('builds a cluster client from a redis-cluster:// URI', async () => {
        const a = new RedisAdapter(jest.fn(), 30000, clusterFactory, sentinelFactory);
        await a.connect('redis-cluster://:secret@node1:7000');

        const options = clusterFactory.mock.calls[0][0];
        // A cluster is not a `url`: the root node is how the topology is
        // discovered, and credentials belong in `defaults` because its settings
        // are not inherited by the connections to the nodes it finds.
        expect(options.rootNodes).toEqual([{ url: 'redis://node1:7000' }]);
        expect(options.defaults).toMatchObject({ password: 'secret' });
        expect(a.cluster).toBe(true);
      });

      test('reads the master name from the path of a redis-sentinel:// URI', async () => {
        const a = new RedisAdapter(jest.fn(), 30000, clusterFactory, sentinelFactory);
        await a.connect('redis-sentinel://:pw@sentinel:26379/mymaster');

        expect(sentinelFactory).toHaveBeenCalled();
        expect(sentinelFactory.mock.calls[0][0].name).toBe('mymaster');
        // Credentials go to the sentinels *and* to the master/replica clients,
        // which are two separate connections to two separate processes. The old
        // shape passed them as `sentinel` and `nodeClient`, neither of which this
        // driver version reads, so the password reached nothing.
        expect(sentinelFactory.mock.calls[0][0].sentinelClientOptions).toMatchObject({ password: 'pw' });
        expect(sentinelFactory.mock.calls[0][0].nodeClientOptions).toMatchObject({ password: 'pw' });
      });

      test('passes the driver the option names it actually reads, for both topologies', async () => {
        // The strongest guard available without a cluster: hand the options to the
        // *real* `createSentinel` and `createCluster` and require that they are
        // accepted. A mock cannot do this -- it records whatever it is given,
        // which is how `sentinel:` and `nodeClient:` survived here for so long.
        // The real factory throws `TypeError: Cannot read properties of undefined
        // (reading '0')` on a sentinel set with no `sentinelRootNodes`, which is
        // precisely the bug, so this fails loudly on the old shape.
        const { createSentinel, createCluster: realCluster } = jest.requireActual('redis');
        const accept = (factory, options) => {
          const client = factory(options);
          if (client && typeof client.close === 'function') return client.close().catch(() => {});
          return Promise.resolve();
        };

        for (const [uri, factory] of [
          ['redis-sentinel://:pw@sentinel:26379/mymaster', createSentinel],
          ['redis-cluster://:pw@node1:7000', realCluster],
        ]) {
          const a = new RedisAdapter(jest.fn(), 1000, clusterFactory, sentinelFactory);
          await a.connect(uri);
          const built = uri.startsWith('redis-sentinel')
            ? sentinelFactory.mock.calls[0][0]
            : clusterFactory.mock.calls[0][0];
          await expect(accept(factory, built)).resolves.toBeUndefined();
        }
      });

      test('a sentinel set is given a node to ask about the topology', async () => {
        // `sentinelRootNodes` is required, and its element type is RedisNode -
        // `{host, port}` - not the cluster's `{url}`. Passing the cluster shape
        // here meant no root node was found, the discovery command reached a node
        // that was not a sentinel, and a real sentinel set answered "ERR unknown
        // command 'SENTINEL'". Asserted on its own because neither the driver's
        // error message nor its types name the field at the point of failure.
        const a = new RedisAdapter(jest.fn(), 1000, clusterFactory, sentinelFactory);
        await a.connect('redis-sentinel://sentinel:26379/mymaster');

        expect(sentinelFactory.mock.calls[0][0].sentinelRootNodes)
          .toEqual([{ host: 'sentinel', port: 26379 }]);
      });

      test('a sentinel URI without a port falls back to redis\'s own default', async () => {
        const a = new RedisAdapter(jest.fn(), 1000, clusterFactory, sentinelFactory);
        await a.connect('redis-sentinel://sentinel/mymaster');

        expect(sentinelFactory.mock.calls[0][0].sentinelRootNodes)
          .toEqual([{ host: 'sentinel', port: 26379 }]);
      });

      test('refuses a scheme the driver has no name for, rather than a DNS error about it', async () => {
        // `redis+sentinel://` was handed to `createClient`, which failed with a
        // DNS error naming a host that does not exist.
        await expect(connect('redis+cluster://node:6379'))
          .rejects.toThrow('not a scheme this driver uses');
      });

      test('still reads a bare host:port as a single node, not as a scheme', async () => {
        // Local factories: the shared ones are module-level mocks and an earlier
        // test in this block already called the cluster one.
        const single = jest.fn(() => mockClient);
        const cluster = jest.fn(() => ({ connect: jest.fn() }));
        const a = new RedisAdapter(single, 30000, cluster, jest.fn());
        await a.connect('node:6379');
        expect(single).toHaveBeenCalledWith(expect.objectContaining({ url: 'redis://node:6379' }));
        expect(cluster).not.toHaveBeenCalled();
      });

      test('says plainly when the driver build has no cluster support', async () => {
        // `null`, not `undefined`: an omitted argument is a default parameter, and
        // the default is the driver's real `createCluster`, so passing nothing
        // would be testing the installed driver rather than the guard.
        const a = new RedisAdapter(jest.fn(), 30000, null, null);
        await expect(a.connect('redis-cluster://node:7000'))
          .rejects.toThrow('not supported by this build of the redis driver');
      });

      // The two schemes above were unreachable, and this is the e2e proof of it

      test.each(['redis-cluster', 'redis-sentinel'])(
        '%s:// is admitted by the connection policy, which is what made the code above reachable',
        async (scheme) => {
  // `checkConnectionPolicy` reads the scheme allowlist before anything else, so
  // without an entry in `DEFAULT_ALLOWED_SCHEMES` the connection was refused there
  // and `RedisAdapter.connect()` was never called. That is why `createCluster` and
  // `createSentinel` had coverage and no caller: the capability was implemented,
  // documented, tested, and dead.
          const verdict = await checkConnectionPolicy(`${scheme}://:pw@node.internal:7000/mymaster`, {
            env: { ANYDB_ALLOW_PRIVATE_HOSTS: '1' },
          });

          expect(verdict.allowed).toBe(true);
          expect(verdict.reason).toBe('');
          expect(DEFAULT_ALLOWED_SCHEMES).toContain(scheme);
          // And the guard has to be the Redis one, not a refusal for a protocol
          // it cannot verify — which is what an un-collapsed scheme produced.
          expect(baseProtocol(scheme)).toBe('redis');
          expect(inspectQuery(scheme, 'GET k').safe).toBe(true);
          expect(inspectQuery(scheme, 'SET k v').safe).toBe(false);
        }
      );

      test('the registry routes both schemes to this adapter', () => {
        const registry = new AdapterRegistry({ env: {} });
        for (const scheme of ['redis-cluster', 'redis-sentinel']) {
          expect(typeof registry.mapping[scheme]).toBe('function');
          expect(registry.createAdapter(scheme, 1000).constructor.name).toBe('RedisAdapter');
        }
      });
    });
  });

  // The driver is loaded on demand, not on import

  describe('lazy driver loading', () => {
  // Asserted structurally rather than by timing: the driver name must not appear
  // in a module-scope import, and must be resolved by a dynamic `import()` inside
  // `connect()`. A timing assertion would be flaky in CI and would not say why.
    const source = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'src', 'adapters', 'redis.js'),
      'utf8'
    );

    test('no adapter module imports the redis driver at module scope', () => {
      expect(source).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+'redis'/m);
      expect(source).not.toMatch(/require\('redis'\)/);
      // It is imported at all, just not eagerly — an assertion that would pass
      // trivially if the driver name had been deleted from the file.
      expect(source).toMatch(/await import\('redis'\)/);
    });

    test('the real driver is resolved on the first connect, and only once', async () => {
      const a = new RedisAdapter();
      expect(a.ClientClass).toBeUndefined();

      const first = await a.loadRedisDriver();
      expect(first).toBe(a);
      // The installed driver, not a stub: this is the default path the live job
      // depends on, and it is the only place it is exercised in unit tests.
      expect(typeof a.ClientClass).toBe('function');
      expect(typeof a.ClusterFactory).toBe('function');
      expect(typeof a.SentinelFactory).toBe('function');

      const resolved = a.ClientClass;
      await a.loadRedisDriver();
      expect(a.ClientClass).toBe(resolved);
    });

    test('an injected factory is never replaced by the real driver', async () => {
      // The dependency-injection argument that every adapter test relies on has
      // to survive the lazy default, or the whole suite starts opening sockets.
      const factory = jest.fn(() => mockClient);
      const cluster = jest.fn();
      const a = new RedisAdapter(factory, 30000, cluster, cluster);
      await a.loadRedisDriver();

      expect(a.ClientClass).toBe(factory);
      expect(a.ClusterFactory).toBe(cluster);
    });

    test('an explicit null is left alone, so "this build has no cluster" still says so', async () => {
      const a = new RedisAdapter(jest.fn(), 30000, null, null);
      await a.loadRedisDriver();
      expect(a.ClusterFactory).toBeNull();
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

    // A missing key and a key holding the JSON value `null` both used to come
    // back as `[null]`, and an agent cannot tell those apart.
    test('says a missing key is missing', async () => {
      mockSendCommand.mockResolvedValueOnce(null);
      await expect(adapter.execute('GET missing')).resolves.toEqual([{ _missing: true, reply: null }]);
    });

    test('still decodes a key that genuinely holds the string null', async () => {
      mockSendCommand.mockResolvedValueOnce('null');
      await expect(adapter.execute('GET k')).resolves.toEqual([null]);
    });

    test('returns an empty array for an empty command', async () => {
      await expect(adapter.execute('   ')).resolves.toEqual([]);
      expect(mockSendCommand).not.toHaveBeenCalled();
    });

    test('reports a command error', async () => {
      mockSendCommand.mockRejectedValueOnce(
        Object.assign(new Error('WRONGTYPE Operation against a key'), { name: 'ReplyError' })
      );
      await expect(adapter.execute('LPUSH a b'))
        .rejects.toThrow(/WRONGTYPE/);
    });

    test('mentions the timeout when the socket dies mid-command', async () => {
      mockSendCommand.mockRejectedValueOnce(
        Object.assign(new Error('Socket closed unexpectedly'), { name: 'SocketClosedUnexpectedlyError' }));
      await expect(adapter.execute('GET k'))
        .rejects.toThrow(/client timeout was 30000ms/);
    });

    test('names the caller\'s own timeout, not a shared one', async () => {
      mockSendCommand.mockRejectedValueOnce(
        Object.assign(new Error('Socket closed unexpectedly'), { name: 'SocketClosedUnexpectedlyError' }));
      await expect(adapter.execute('GET k', { timeout: 750 }))
        .rejects.toThrow(/client timeout was 750ms/);
    });

    describe('HGETALL', () => {
      // Under RESP2 the reply is a flat array and under RESP3 a map, and
      // `sendCommand` applies no transformer either way. One answer, whatever
      // the server negotiated.
      test('turns a flat RESP2 array into an object', async () => {
        mockSendCommand.mockResolvedValueOnce(['name', 'Ada', 'id', '1']);
        await expect(adapter.execute('HGETALL user:1'))
          .resolves.toEqual([{ name: 'Ada', id: '1' }]);
      });

      test('leaves a RESP3 map as an object', async () => {
        mockSendCommand.mockResolvedValueOnce({ name: 'Ada' });
        await expect(adapter.execute('HGETALL user:1'))
          .resolves.toEqual([{ name: 'Ada' }]);
      });

      test('unwraps a Map reply', async () => {
        mockSendCommand.mockResolvedValueOnce(new Map([['name', 'Ada']]));
        await expect(adapter.execute('HGETALL user:1'))
          .resolves.toEqual([{ name: 'Ada' }]);
      });

      test('reports an empty hash as no rows, not as an empty document', async () => {
        mockSendCommand.mockResolvedValueOnce([]);
        // `[{}]` would put a document in the answer that does not exist in the
        // database.
        await expect(adapter.execute('HGETALL nothing')).resolves.toEqual([]);
      });

      test('hands back an array it cannot read as pairs rather than half-decoding it', async () => {
        mockSendCommand.mockResolvedValueOnce(['a', 'b', 'c']);
        await expect(adapter.execute('HGETALL odd'))
          .resolves.toEqual([['a', 'b', 'c']]);
      });
    });
  });

  describe('result caps', () => {
    beforeEach(() => connect());

    // Every one of these is on the read-only allowlist and has no syntax for a
    // limit, so a single permitted read is the one place in this tool where an
    // unbounded reply is reachable with no user error at all.
    test.each(['HVALS', 'HKEYS', 'SMEMBERS', 'ZRANGE', 'LRANGE', 'XRANGE'])(
      'caps %s, which returns the whole collection', async (command) => {
        mockSendCommand.mockResolvedValueOnce(Array.from({ length: 1500 }, (_, i) => String(i)));

        const rows = await adapter.execute(`${command} k`);

        expect(rows).toHaveLength(1000);
        expect(rows.truncated).toBe(true);
      }
    );

    // HGETALL is capped by **field**, not by array slot: the flat RESP2 reply is
    // `[field, value, field, value, …]`, so a cap that counted slots would halve
    // the answer's coverage and a cap that counted fields after normalisation is
    // the only one that means what the caller asked.
    test('caps HGETALL by field', async () => {
      const flat = [];
      for (let i = 0; i < 1200; i++) flat.push(`f${i}`, String(i));
      mockSendCommand.mockResolvedValueOnce(flat);

      const rows = await adapter.execute('HGETALL h');

      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0])).toHaveLength(1000);
      expect(rows.truncated).toBe(true);
    });

    test('honours a smaller cap when the caller names one', async () => {
      mockSendCommand.mockResolvedValueOnce(['a', 'b', 'c']);

      const rows = await adapter.execute('SMEMBERS s', { maxRows: 2 });

      expect(rows).toEqual(['a', 'b']);
      expect(rows.truncated).toBe(true);
    });

    test('leaves a command that has its own limit alone', async () => {
      mockSendCommand.mockResolvedValueOnce(['x']);

      const rows = await adapter.execute('LRANGE k 0 10');

      expect(rows).toEqual(['x']);
      expect(rows.truncated).toBeUndefined();
    });

    test('keeps the marker out of the serialised answer', async () => {
      mockSendCommand.mockResolvedValueOnce(['a', 'b', 'c']);
      const rows = await adapter.execute('SMEMBERS s', { maxRows: 1 });
      expect(JSON.parse(JSON.stringify(rows))).toEqual(['a']);
    });

    test('caps a hash, because an object has an unbounded number of fields too', async () => {
      const big = {};
      for (let i = 0; i < 1200; i++) big[`f${i}`] = String(i);
      mockSendCommand.mockResolvedValueOnce(big);

      const rows = await adapter.execute('HGETALL h', { maxRows: 3 });

      expect(Object.keys(rows[0])).toHaveLength(3);
      expect(rows.truncated).toBe(true);
    });

    // Paged, not refused: the server answers HSCAN with a cursor and a page, so
    // a hash too large for one reply is still partly readable.
    test('pages a large hash with the driver\'s own scan iterator', async () => {
      mockClient.hScanIterator = jest.fn(() => (async function* () {
        yield [{ field: 'a', value: '1' }];
        yield [{ field: 'b', value: '2' }];
        yield [{ field: 'c', value: '3' }];
      })());

      const rows = await adapter.execute('HGETALL h', { maxRows: 2 });

      expect(mockSendCommand).not.toHaveBeenCalled();
      expect(rows).toEqual([{ a: '1', b: '2' }]);
      expect(rows.truncated).toBe(true);
    });

    test('pages a set the same way', async () => {
      mockClient.sScanIterator = jest.fn(() => (async function* () {
        yield ['a', 'b', 'c'];
      })());

      const rows = await adapter.execute('SMEMBERS s', { maxRows: 2 });

      expect(rows).toEqual(['a', 'b']);
      expect(rows.truncated).toBe(true);
    });

    // ZSCAN is explicitly unordered and ZRANGE is defined to answer in score
    // order, so substituting one for the other would answer a different question
    // while looking identical.
    test('does not answer a ZRANGE with a ZSCAN', async () => {
      mockSendCommand.mockResolvedValueOnce([['m1', '1'], ['m2', '2']]);

      const rows = await adapter.execute('ZRANGE z 0 -1', { maxRows: 1 });

      expect(mockClient.zScanIterator).toBeUndefined();
      expect(rows).toHaveLength(1);
      expect(rows.truncated).toBe(true);
    });

    test('falls back to the buffered path when the driver has no iterator', async () => {
      mockSendCommand.mockResolvedValueOnce(['a', 'b', 'c']);
      const rows = await adapter.execute('SMEMBERS s', { maxRows: 2 });
      expect(mockSendCommand).toHaveBeenCalled();
      expect(rows).toEqual(['a', 'b']);
    });
  });

  describe('connection state', () => {
    beforeEach(connect);

    // `SELECT 1` retargets every later command for this URI at db1 while the
    // tool still reports db0, and nothing in the response says so.
    test.each(['SELECT 1', 'SWAPDB 0 1', 'MULTI', 'EXEC', 'QUIT', 'RESET', 'FAILOVER', 'CLIENT KILL ID 1'])(
      'refuses %s rather than changing the shared connection', async (command) => {
        await expect(adapter.execute(command, { readOnly: false }))
          .rejects.toThrow('[Redis connection state]');
        expect(mockSendCommand).not.toHaveBeenCalled();
      }
    );

    test('leaves the reading subcommands of a family alone', async () => {
      mockSendCommand.mockResolvedValueOnce('PONG');
      await expect(adapter.execute('CLIENT INFO', { readOnly: false })).resolves.toEqual(['PONG']);
      mockSendCommand.mockResolvedValueOnce('maxmemory');
      await expect(adapter.execute('CONFIG GET maxmemory', { readOnly: false })).resolves.toEqual(['maxmemory']);
    });

    test('refuses the writing subcommand of a family', async () => {
      await expect(adapter.execute('CONFIG SET maxmemory 0', { readOnly: false }))
        .rejects.toThrow('[Redis connection state]');
    });

    test('says what a transaction would need', async () => {
      const error = await adapter.execute('MULTI', { readOnly: false }).catch(e => e);
      expect(error.message).toContain('pins one connection across calls');
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

    // Redis's own command-line rules treat a backslash as an escape outside
    // quotes too, and matching them is what makes this one argument again. It
    // used to be honoured only inside quotes, so the value was silently split in
    // two and the second half was interpreted by Redis as a separate argument.
    test('honours a backslash escape outside quotes', () => {
      expect(adapter.parseCommand('SET k a\\ b')).toEqual(['SET', 'k', 'a b']);
    });

    test('honours a tab escape outside quotes', () => {
      expect(adapter.parseCommand('SET k a\\tb')).toEqual(['SET', 'k', 'a\tb']);
    });

    test('keeps a trailing backslash, because there is nothing after it to escape', () => {
      expect(adapter.parseCommand('SET k a\\')).toEqual(['SET', 'k', 'a\\']);
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

  describe('isHealthy', () => {
    test('reads the client\'s own socket state, so it costs no round trip', async () => {
      await connect();
      expect(adapter.isHealthy()).toBe(true);
    });

    test('is false when the socket is not ready', async () => {
      await connect();
      mockClient.isReady = false;
      expect(adapter.isHealthy()).toBe(false);
    });

    test('is false with no client', () => {
      expect(adapter.isHealthy()).toBe(false);
    });

    test('is false after abort', async () => {
      await connect();
      adapter.abort();
      expect(adapter.isHealthy()).toBe(false);
    });
  });

  describe('describe', () => {
    // The schema tests reached the *SchemaAdapter class directly, which left the
    // `new …; schema.client = …` wiring in the adapter as untested code.
    test('hands the schema adapter the live client', async () => {
      mockClient.info = jest.fn().mockResolvedValue('');
      mockClient.scanIterator = jest.fn(() => (async function* () {})());
      await connect();

      const out = await adapter.describe({});

      expect(out.database).toBe('redis');
      expect(out.keyspace).toEqual({});
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
