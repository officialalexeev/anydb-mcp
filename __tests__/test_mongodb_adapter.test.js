import * as nodeOs from 'node:os';
import { MongoAdapter, DEFAULT_LIMIT, MAX_LIMIT } from '../src/adapters/mongodb.js';

// Behaviour of individual actions is covered in test_mongodb_actions.test.js.
// This file covers the connection lifecycle, and the two things about it that
// used to be wrong: which database the client is pinned to, and the absence of a
// per-operation timeout.
describe('MongoAdapter connection', () => {
  let adapter;
  let mockClient;
  let mockClientConstructor;
  let db;
  let savedEnv;

  beforeEach(() => {
    savedEnv = {
      socket: process.env.ANYDB_MONGO_SOCKET_TIMEOUT_MS,
      poolMax: process.env.ANYDB_MONGO_POOL_MAX,
      poolMin: process.env.ANYDB_MONGO_POOL_MIN,
      wait: process.env.ANYDB_MONGO_WAIT_QUEUE_MS
    };
    for (const key of Object.keys(savedEnv)) delete process.env[key];

    // In the real driver `client.db` is both callable — `client.db(name)` returns
    // a `Db` — and a property, so `client.db.listCollections(...)` and
    // `client.db()` are both legal. Modelled, because the adapter uses the first
    // form and the schema adapter the second.
    db = {
      databaseName: 'mydb',
      collection: jest.fn(() => ({ find: jest.fn() })),
      listCollections: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) })),
      command: jest.fn().mockResolvedValue({ count: 0 })
    };
    const dbFn = jest.fn((name) => {
      if (name) db.databaseName = name;
      return db;
    });
    Object.assign(dbFn, db);
    mockClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      db: dbFn,
      // The real driver resolves `options.dbName` from the URI at construction
      // and threads it through, so it tracks whichever database was pinned.
      get options() { return { dbName: db.databaseName }; }
    };
    mockClientConstructor = jest.fn(() => mockClient);
    adapter = new MongoAdapter(mockClientConstructor, 30000);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('driver shape', () => {
    // The bounds and the SRV route, read from the installed driver rather than
    // assumed. `socketTimeoutMS` defaulting to 0 is the one that mattered: an
    // individual operation had no client-side bound at all.
    test('the driver bounds are the ones the adapter sets', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(process.cwd(), 'node_modules', 'mongodb', 'src', 'connection_string.ts'),
        'utf8'
      );
      expect(source).toMatch(/socketTimeoutMS:\s*\{[\s\S]{0,200}?default: 0/);
      expect(source).toMatch(/maxPoolSize:\s*\{[\s\S]{0,80}?default: 100/);
      expect(source).toMatch(/waitQueueTimeoutMS:\s*\{[\s\S]{0,200}?default: 0/);
    });

    test('the database name comes from the URI path, and there is no fallback', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(process.cwd(), 'node_modules', 'mongodb', 'src', 'connection_string.ts'),
        'utf8'
      );
      // `client.db()` with no name uses whatever the URI carries, and the URI
      // carries nothing when it has no path — so a URI with no database reads
      // whichever database the server happens to default to.
      expect(source).toMatch(/if \(dbName\) \{\s*urlOptions\.set\('dbName'/);
    });

    test('SRV resolution is the driver\'s, and happens before the connection', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(process.cwd(), 'node_modules', 'mongodb', 'src', 'connection_string.ts'),
        'utf8'
      );
      expect(source).toContain('export async function resolveSRVRecord');
      expect(source).toContain('resolveSrv(hostname)');
    });
  });

  // The driver is loaded on demand, not on import

  describe('lazy driver loading', () => {
  // Asserted structurally rather than by timing: the driver name must not appear
  // in a module-scope import, and must be resolved by a dynamic `import()` inside
  // `connect()`. A timing assertion would be flaky in CI and would not say why.
    const source = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'src', 'adapters', 'mongodb.js'),
      'utf8'
    );

    test('the adapter does not import the mongodb driver at module scope', () => {
      expect(source).not.toMatch(/^import\s+\{[^}]*MongoClient[^}]*\}\s+from\s+'mongodb'/m);
      expect(source).not.toMatch(/require\('mongodb'\)/);
      // It is imported at all, just not eagerly — otherwise this would pass
      // trivially if the driver name had been deleted from the file.
      expect(source).toMatch(/await import\('mongodb'\)/);
    });

    test('the real driver is resolved on the first connect, and only once', async () => {
      const a = new MongoAdapter();
      expect(a.ClientClass).toBeUndefined();

      const resolved = await a.loadMongoClient();
      expect(resolved).toBe(a.ClientClass);
      expect(typeof a.ClientClass).toBe('function');

      await a.loadMongoClient();
      expect(a.ClientClass).toBe(resolved);
    });

    test('an injected constructor is never replaced by the real driver', async () => {
      // Every adapter test injects its own client. If the lazy default overwrote
      // it, the suite would start opening real sockets, so this is the assertion
      // that keeps the whole file's approach working.
      const a = new MongoAdapter(mockClientConstructor, 30000);
      await a.loadMongoClient();
      expect(a.ClientClass).toBe(mockClientConstructor);
    });
  });

  describe('connect', () => {
    test('applies the connection timeouts', async () => {
      await adapter.connect('mongodb://localhost:27017/mydb');

      // `serverSelectionTimeoutMS` bounds picking a server and says nothing
      // about how long a statement may then run. This is the per-operation
      // bound, and it is the one that was missing.
      expect(mockClientConstructor).toHaveBeenCalledWith('mongodb://localhost:27017/mydb', {
        // The driver resolves `os` with `await import('os')`, which rejects under
        // Jest and leaves the handshake metadata empty; the server then refuses
        // the connection with a complaint about a missing `driver` field that
        // names nothing the caller did. The adapter hands the module over
        // instead, and this assertion is what keeps that from being undone.
        runtimeAdapters: { os: nodeOs },
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
        socketTimeoutMS: 30000,
        maxPoolSize: 4,
        minPoolSize: 0,
        waitQueueTimeoutMS: 4000
      });
    });

    test('takes the socket and pool bounds from the environment', async () => {
      process.env.ANYDB_MONGO_SOCKET_TIMEOUT_MS = '9000';
      process.env.ANYDB_MONGO_POOL_MAX = '12';
      process.env.ANYDB_MONGO_POOL_MIN = '2';
      process.env.ANYDB_MONGO_WAIT_QUEUE_MS = '1500';

      await adapter.connect('mongodb://localhost:27017/mydb');

      expect(mockClientConstructor.mock.calls[0][1]).toMatchObject({
        socketTimeoutMS: 9000,
        maxPoolSize: 12,
        minPoolSize: 2,
        waitQueueTimeoutMS: 1500
      });
    });

    test.each(['0', '-1', 'nope', ''])('falls back for the nonsense bound %p', async (raw) => {
      process.env.ANYDB_MONGO_POOL_MAX = raw;
      await adapter.connect('mongodb://localhost:27017/mydb');
      // A zero or negative pool size is a TypeError from the driver, and an
      // unbounded wait queue is the driver's own default, which is forever.
      expect(mockClientConstructor.mock.calls[0][1]).toMatchObject({ maxPoolSize: 4 });
    });

    // The database name has to be pinned: `client.db` with no argument falls
    // back to the URI path, and to the server's default when there is none.
    test('pins the database named in the URI', async () => {
      await adapter.connect('mongodb://localhost:27017/shop');

      expect(mockClient.db).toHaveBeenCalledWith('shop');
      expect(adapter.db).toBe(db);
      expect(adapter.databaseName).toBe('shop');
    });

    // A URI with no database cannot be pinned, and the fallback is a guess: the
    // server's default database, which differs between deployments and is
    // reported as `null` while the query goes there. Refused before a socket is
    // opened.
    test.each([
      ['mongodb://localhost:27017'],
      ['mongodb://localhost:27017/'],
      ['mongodb://user:pw@localhost:27017/?retryWrites=true'],
    ])('refuses the database-less URI %p rather than reading a default', async (uri) => {
      await expect(adapter.connect(uri)).rejects.toThrow('[MongoDB database]');
      expect(mockClientConstructor).not.toHaveBeenCalled();
      expect(adapter.databaseName).toBeUndefined();
    });

    test('decodes a percent-encoded database name', async () => {
      await adapter.connect('mongodb://localhost:27017/my%20shop');
      expect(mockClient.db).toHaveBeenCalledWith('my shop');
    });

    test('carries a SRV URI to the driver unchanged, since it resolves the DNS', async () => {
      // `mongodb+srv://` is the connection string almost everybody pastes out of
      // Atlas. The driver does the SRV lookup itself, so the adapter's only
      // job is to hand it over intact — and to make sure the connect budget
      // covers the lookup, which happens before any socket is opened.
      await adapter.connect('mongodb+srv://cluster0.abcde.mongodb.net/shop');

      expect(mockClientConstructor.mock.calls[0][0]).toBe('mongodb+srv://cluster0.abcde.mongodb.net/shop');
      expect(mockClientConstructor.mock.calls[0][1].serverSelectionTimeoutMS).toBe(5000);
      expect(mockClientConstructor.mock.calls[0][1].connectTimeoutMS).toBe(5000);
    });

    test('keeps the query parameters of a SRV URI', async () => {
      await adapter.connect('mongodb+srv://cluster0.abcde.mongodb.net/shop?retryWrites=true&w=majority');
      expect(mockClientConstructor.mock.calls[0][0]).toContain('retryWrites=true');
      expect(adapter.databaseName).toBe('shop');
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

  describe('describe', () => {
    // The schema tests reached the *SchemaAdapter class directly, which left the
    // `new …; schema.client = …` wiring in the adapter as untested code.
    test('hands the schema adapter the live client', async () => {
      await adapter.connect('mongodb://h/shop');

      const out = await adapter.describe({});

      expect(out.database).toBe('mongodb');
      expect(out.databaseName).toBe('shop');
      expect(out.collections).toEqual([]);
    });

    test('reports a missing collection as missing, not as empty', async () => {
      await adapter.connect('mongodb://h/shop');

      await expect(adapter.describe({ collection: 'nope' })).resolves.toMatchObject({
        collections: [],
        collectionNotFound: 'nope'
      });
    });

    test('reads the collection list without asking for names only, because the options are on it', async () => {
      await adapter.connect('mongodb://h/shop');

      await adapter.describe({});

      // `nameOnly: true` would lose `capped`, `size`, `max` and `timeseries` for
      // free, and would make a collection that does not exist indistinguishable from
      // one whose stats could not be read.
      expect(db.listCollections).toHaveBeenCalledWith({}, { nameOnly: false });
    });
  });
});
