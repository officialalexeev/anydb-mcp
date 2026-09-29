import realPg from 'pg';
import { PostgresAdapter } from '../src/adapters/postgres.js';

/**
 * Stands in for pg's Query, in the two shapes `execute()` uses.
 *
 * Callback-based (the uncapped path): pg decides whether to keep a row with
 * `this._accumulateRows = this.callback || !this.listeners('row').length` in
 * `handleRowDescription`, so a callback forces accumulation and the result comes
 * back whole. Errors go to the callback and *not* to an `error` event.
 *
 * Event-based (the capped path): no callback, so pg emits `row` for each row and
 * keeps none, and errors arrive as an `error` event with `end` following. This is
 * the shape the real driver uses, and getting it wrong would make the cap a
 * no-op against a live server while passing here.
 */
class FakeQuery {
  constructor(text, values, callback) {
    this.text = text;
    this.values = values;
    this.callback = callback;
    this.listeners = new Map();
  }

  submit() { return null; }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  once(event, handler) { return this.on(event, handler); }

  emit(event, ...args) {
    for (const handler of [...(this.listeners.get(event) || [])]) handler(...args);
  }

  get hasRowListener() { return (this.listeners.get('row') || []).length > 0; }

  /**
   * Deliver a result the way pg does: a row event per row, then `end` with the
   * result object. `pg` only puts the rows in `res.rows` when it accumulated
   * them, and that is exactly the difference the cap depends on.
   */
  deliver({ rows = [], error = null, command = 'SELECT', rowCount } = {}) {
    if (error) {
      // pg's `handleError` calls the callback when there is one and emits
      // `error` when there is not, so the two paths fail differently.
      if (this.callback) this.callback(error);
      else this.emit('error', error);
      this.emit('end', { rows: [], command: null, rowCount: 0 });
      return;
    }
    const accumulates = Boolean(this.callback) || !this.hasRowListener;
    for (const row of rows) this.emit('row', row, null);
    const result = {
      command,
      rowCount: rowCount ?? rows.length,
      oid: 0,
      rows: accumulates ? rows : []
    };
    if (this.callback) this.callback(null, result);
    this.emit('end', result);
  }
}

/**
 * Stands in for pg's Client#query, in both shapes the adapter uses: a string
 * yields a promise, and a Query object is returned as-is with its result
 * delivered to its own listeners. Modelling the second shape matters, because it
 * is the only way to get hold of the object a cancel request needs.
 *
 * Only the statement is scripted. The `SET statement_timeout` and the `RESET ALL`
 * the adapter issues around it always succeed, and scripting them would put an
 * extra entry between the test and the call it means to describe. `{ hang: true }`
 * stands in for a statement the server never finishes, the case abort() is for.
 */
function makeClient() {
  const client = {
    calls: [],
    released: 0,
    destroyed: 0,
    script: [],
    query(arg) {
      client.calls.push(arg);
      if (arg instanceof FakeQuery) {
        const outcome = client.script.shift() ?? { rows: [] };
        if (!outcome.hang) setImmediate(() => arg.deliver(outcome));
        return arg;
      }
      return Promise.resolve({ rows: [] });
    },
    release(destroy) {
      client.released++;
      if (destroy) client.destroyed++;
    }
  };
  return client;
}

/** Stands in for pg.Client, the only thing that can carry a cancel request. */
function makeCancelClient() {
  const cancels = [];
  class CancelClient {
    constructor(options) { this.options = options; }
    cancel(target, query) { cancels.push({ target, query, options: this.options }); }
  }
  CancelClient.cancels = cancels;
  return CancelClient;
}

// Lets every pending microtask and immediate run, so an execute() that has
// awaited its connect and its SET has actually submitted the statement by the
// time the test looks. abort() can only land between those steps.
const drain = async () => {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
};

const CANCELED = { code: '57014', message: 'canceling statement due to user request' };

describe('PostgresAdapter', () => {
  let adapter;
  let client;
  let mockEnd;
  let pool;
  let poolConstructor;
  let CancelClient;
  let savedPoolMax;
  let savedTtl;
  let savedMaxRows;

  beforeEach(() => {
    savedPoolMax = process.env.ANYDB_PG_POOL_MAX;
    savedTtl = process.env.ANYDB_CACHE_TTL_MS;
    savedMaxRows = process.env.ANYDB_MAX_ROWS;
    delete process.env.ANYDB_PG_POOL_MAX;
    delete process.env.ANYDB_CACHE_TTL_MS;
    delete process.env.ANYDB_MAX_ROWS;

    client = makeClient();
    mockEnd = jest.fn().mockResolvedValue();
    pool = {
      connect: jest.fn().mockResolvedValue(client),
      end: mockEnd,
  // `query` is here because `isHealthy()` calls `this.pool.query('SELECT 1')`. A
  // pool double without it makes isHealthy() return false every time.
      query: jest.fn().mockResolvedValue({ rows: [] })
    };
    poolConstructor = jest.fn(() => pool);
    CancelClient = makeCancelClient();

    adapter = new PostgresAdapter(poolConstructor, 30000, CancelClient, FakeQuery);
  });

  afterEach(() => {
    if (savedPoolMax === undefined) delete process.env.ANYDB_PG_POOL_MAX;
    else process.env.ANYDB_PG_POOL_MAX = savedPoolMax;
    if (savedTtl === undefined) delete process.env.ANYDB_CACHE_TTL_MS;
    else process.env.ANYDB_CACHE_TTL_MS = savedTtl;
    if (savedMaxRows === undefined) delete process.env.ANYDB_MAX_ROWS;
    else process.env.ANYDB_MAX_ROWS = savedMaxRows;
  });

  const connect = () => adapter.connect('postgres://user:pass@localhost:5432/mydb');

  /** The statements submitted so far, as the SQL text the adapter sent. */
  const statements = () => client.calls.filter(c => c instanceof FakeQuery).map(c => c.text);

  /** The plain statements — the SET and the reset — in order. */
  const session = () => client.calls.filter(c => typeof c === 'string');

  describe('driver shape', () => {
    // abort() is built on two things the installed pg has to keep providing: an
    // exported Query class, and Client#cancel taking the target and its query.
    test('pg exports a Query that a client hands back for a cancel to target', () => {
      const callback = jest.fn();
      const query = new realPg.Query('SELECT 1', [], callback);

      expect(typeof realPg.Query).toBe('function');
      expect(query.text).toBe('SELECT 1');
      expect(query.callback).toBe(callback);
      expect(typeof query.submit).toBe('function');

      const realClient = new realPg.Client({ connectionString: 'postgres://u:p@127.0.0.1:59999/db' });
      // Handing pg a Query gets the Query back; handing it a string gets a
      // promise, and then there is nothing left to cancel.
      expect(realClient.query(query)).toBe(query);
    });

    test('Client#cancel exists and is asked for a target and its query', () => {
      expect(typeof realPg.Client.prototype.cancel).toBe('function');
      expect(realPg.Client.prototype.cancel.length).toBe(2);
    });

    // The decision the cap rests on, read from the driver rather than assumed:
    // a callback forces accumulation whatever listeners are attached.
    test('a callback is what makes pg keep the rows, not a listener', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(process.cwd(), 'node_modules', 'pg', 'lib', 'query.js'),
        'utf8'
      );
      expect(source).toContain('this._accumulateRows = this.callback || !this.listeners(\'row\').length');
      expect(source).toContain('this.emit(\'row\', row, this._result)');
    });

    test('the double matches those two points', () => {
      expect(new FakeQuery('SELECT 1', [], jest.fn()).text).toBe('SELECT 1');
      expect(typeof new CancelClient({}).cancel).toBe('function');
    });
  });

  // The driver is loaded on demand, not on import

  describe('lazy driver loading', () => {
  // Asserted structurally rather than by timing: the driver name must not appear
  // in a module-scope import, and must be resolved by a dynamic `import()` inside
  // `connect()`. A timing assertion would be flaky in CI and would not say why.
    const source = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'src', 'adapters', 'postgres.js'),
      'utf8'
    );

    test('the adapter does not import pg at module scope', () => {
      expect(source).not.toMatch(/^import\s+\w+\s+from\s+'pg'/m);
      expect(source).not.toMatch(/require\('pg'\)/);
      // It is imported at all, just not eagerly — an assertion that would pass
      // trivially if the driver name had been deleted from the file.
      expect(source).toMatch(/await import\('pg'\)/);
    });

    test('no adapter module imports a SQL driver at module scope', () => {
      // The same two-line treatment, asserted across the pair rather than in one
      // file, because a regression here is most likely to be a copy of one of
      // these adapters reintroducing its own module-scope import.
      const read = (name) => require('node:fs').readFileSync(
        require('node:path').join(process.cwd(), 'src', 'adapters', name), 'utf8'
      );
      for (const [name, driver] of [['mysql.js', 'mysql2'], ['postgres.js', 'pg']]) {
        const text = read(name);
        expect(text).not.toMatch(new RegExp(`^import\\s+\\w+\\s+from\\s+'${driver}`, 'm'));
        expect(text).not.toMatch(new RegExp(`require\\('${driver}`));
        expect(text).toMatch(new RegExp(`await import\\('${driver}`));
      }
    });

    test('the loader is not called before connect, and connect is what loads it', async () => {
      const a = new PostgresAdapter(undefined, 30000, undefined, undefined);
      expect(a.PoolClass).toBeUndefined();
      expect(a.ClientClass).toBeUndefined();
      expect(a.QueryClass).toBeUndefined();

      // Constructing an adapter must not have loaded the driver — that is the
      // whole property, and it is asserted on the instance rather than by timing.
      await a.loadPgDriver();
      // The installed driver, not a stub: this is the default path the live job
      // depends on, and it is the only place it is exercised in unit tests.
      expect(typeof a.PoolClass).toBe('function');
      expect(typeof a.ClientClass).toBe('function');
      expect(typeof a.QueryClass).toBe('function');

      const resolved = a.PoolClass;
      await a.loadPgDriver();
      expect(a.PoolClass).toBe(resolved);
    });

    test('an injected constructor is never replaced by the real driver', async () => {
      // The dependency-injection argument that every adapter test in this file
      // relies on has to survive the lazy default, or the whole suite starts
      // opening real sockets. This is that assertion.
      const poolDouble = jest.fn(() => pool);
      const a = new PostgresAdapter(poolDouble, 30000, CancelClient, FakeQuery);
      await a.loadPgDriver();

      expect(a.PoolClass).toBe(poolDouble);
      expect(a.ClientClass).toBe(CancelClient);
      expect(a.QueryClass).toBe(FakeQuery);
    });

    test('an explicit null reaches the worded refusal, not a lazy fill', async () => {
      // THREE STATES, and the third is the one that is easy to lose. `undefined`
      // means "not supplied, load it"; a function means "supplied, keep it"; an
      // explicit `null` means "this build has no such constructor" and must be
      // reported in words rather than quietly repaired by importing pg.
      const a = new PostgresAdapter(null, 30000, null, null);
      await a.loadPgDriver();
      expect(a.PoolClass).toBeNull();

      await expect(a.connect('postgres://u:p@h:5432/db'))
        .rejects.toThrow(/no pg\.Pool/);
    });

    test('a partial injection fills only what was left out', async () => {
      // The shape `registry.js` produces for a caller who injected only a pool:
      // the two classes the driver supplies are loaded, and the pool is not
      // touched. Collapsing "some were supplied" into "all were" would either
      // drop the injected pool or overwrite it.
      const poolDouble = jest.fn(() => pool);
      const a = new PostgresAdapter(poolDouble, 30000);
      await a.loadPgDriver();

      expect(a.PoolClass).toBe(poolDouble);
      expect(a.ClientClass).toBe(realPg.Client);
      expect(a.QueryClass).toBe(realPg.Query);
    });
  });

  describe('connect', () => {
    test('creates a pool from the connection string', async () => {
      await connect();

      expect(adapter.pool).toBe(pool);
      expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({
        connectionString: 'postgres://user:pass@localhost:5432/mydb',
        connectionTimeoutMillis: 5000
      }));
    });

    test('names the application so a busy backend is attributable', async () => {
      await connect();
      // pg_stat_activity shows this, which is how an operator finds the tool
      // holding a lock instead of an anonymous backend.
      expect(poolConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ application_name: 'anydb-mcp' })
      );
    });

    test('keeps sockets alive across idle periods', async () => {
      await connect();
      expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({ keepAlive: true }));
    });

    test('bounds the pool', async () => {
      await connect();
      expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({ max: 4 }));
    });

    test('takes the pool bound from ANYDB_PG_POOL_MAX', async () => {
      process.env.ANYDB_PG_POOL_MAX = '16';
      await connect();
      expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({ max: 16 }));
    });

    test.each(['0', '-2', 'nope', ''])('falls back for the nonsense bound %p', async (raw) => {
      process.env.ANYDB_PG_POOL_MAX = raw;
      await connect();
      expect(poolConstructor).toHaveBeenCalledWith(expect.objectContaining({ max: 4 }));
    });

    test('reaps idle sockets on the cache TTL, not on pg-pool default of 10s', async () => {
      await connect();

      // The pool holds a connection for five minutes, so a shorter pool idle
      // timeout would empty it between calls and make the next query pay for a
      // handshake the cache was supposed to have saved.
      expect(poolConstructor.mock.calls[0][0].idleTimeoutMillis).toBe(5 * 60 * 1000);
    });

    test('follows a configured cache TTL so the two cannot drift apart', async () => {
      process.env.ANYDB_CACHE_TTL_MS = '120000';
      await connect();
      expect(poolConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ idleTimeoutMillis: 120000 })
      );
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      await connect();
    });

    test('returns rows unchanged', async () => {
      client.script = [{ rows: [{ id: 1 }] }];

      await expect(adapter.execute('SELECT * FROM users')).resolves.toEqual([{ id: 1 }]);
    });

    test('sets statement_timeout and the query on the same connection', async () => {
      client.script = [{ rows: [] }];

      await adapter.execute('SELECT 1');

      // statement_timeout is a session setting. Two pool.query() calls could
      // land on different clients, leaving the timeout unenforced.
      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(session()[0]).toBe('SET statement_timeout = 30000');
      expect(statements()).toEqual(['SELECT 1']);
    });

    test('applies the caller\'s timeout, not a value on the shared adapter', async () => {
      // The pool is shared by concurrent callers, so a field on the adapter
      // cannot carry per-call state without one call's budget landing on
      // another's statement.
      client.script = [{ rows: [] }, { rows: [] }];

      await adapter.execute('SELECT 1', { timeout: 1234 });
      await adapter.execute('SELECT 2', { timeout: 5678 });

      const settings = session().filter(s => s.startsWith('SET statement_timeout'));
      expect(settings).toEqual(['SET statement_timeout = 1234', 'SET statement_timeout = 5678']);
    });

    test('truncates a fractional timeout, which the server would reject', async () => {
      // statement_timeout is interpolated into a SET statement and Postgres only
      // accepts whole milliseconds, so 1.5 is a syntax error there.
      client.script = [{ rows: [] }];

      await adapter.execute('SELECT 1', { timeout: 1.5 });

      expect(session()[0]).toBe('SET statement_timeout = 1');
    });

    test('falls back to the adapter default for a timeout the caller did not give', async () => {
      // options.timeout wins, but a value that is not a usable duration must not
      // become a broken SET: the adapter was built with a real budget and that
      // is the one that applies.
      for (const raw of [0, -1, NaN, Infinity, 'soon']) {
        client.calls.length = 0;
        client.script = [{ rows: [] }];

        await adapter.execute('SELECT 1', { timeout: raw });

        expect(session()[0]).toBe('SET statement_timeout = 30000');
      }
    });

    test('disables the server-side limit when the adapter default is unusable too', async () => {
      const off = new PostgresAdapter(poolConstructor, 0, CancelClient, FakeQuery);
      await off.connect('postgres://u:p@h/d');
      const offClient = makeClient();
      pool.connect.mockResolvedValue(offClient);

      await off.execute('SELECT 1');

      // 0 is the only value that is valid SQL rather than a failure the caller
      // would read as a query error. The caller's own guard is still in front.
      expect(offClient.calls[0]).toBe('SET statement_timeout = 0');
    });

    test('releases the client back to the pool', async () => {
      client.script = [{ rows: [] }];

      await adapter.execute('SELECT 1');

      expect(client.released).toBe(1);
    });

    test('releases the client even when the query fails', async () => {
      client.script = [{ error: Object.assign(new Error('syntax error'), { code: '42601' }) }];

      await expect(adapter.execute('FAKE')).rejects.toThrow();
      expect(client.released).toBe(1);
    });

    test('returns a status array for a statement with no rows', async () => {
      client.script = [{ rows: [], command: 'INSERT', rowCount: 1 }];

      await expect(adapter.execute('INSERT INTO t VALUES (1)')).resolves.toEqual([
        { affectedRows: 1, command: 'INSERT', oid: 0 }
      ]);
    });

    test('reports a statement timeout', async () => {
      client.script = [{ error: { code: '57014', message: 'canceling statement due to statement timeout' } }];

      await expect(adapter.execute('SLOW')).rejects
        .toThrow('Query exceeded 30000ms (statement_timeout)');
    });

    test('names the caller\'s own timeout when the server blamed it', async () => {
      client.script = [{ error: { code: '57014', message: 'canceling statement due to statement timeout' } }];

      await expect(adapter.execute('SLOW', { timeout: 900 }))
        .rejects.toThrow('Query exceeded 900ms (statement_timeout)');
    });

    test('does not claim a timeout for a user cancel', async () => {
      client.script = [{ error: CANCELED }];

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
      client.script = [{ error: Object.assign(new Error(message), { code }) }];

      await expect(adapter.execute('SELECT 1')).rejects.toThrow(expected);
    });

    test('keeps an unknown SQLSTATE visible', async () => {
      client.script = [{ error: Object.assign(new Error('mystery'), { code: 'XX000' }) }];

      await expect(adapter.execute('SELECT 1')).rejects.toThrow('[Postgres XX000] mystery');
    });
  });

  describe('bound parameters', () => {
    beforeEach(async () => {
      await connect();
    });

    // The `db_query` schema had no `params` argument at all, so every value had
    // to be inlined into the statement by the model.
    test('binds $n placeholders to the values array', async () => {
      client.script = [{ rows: [] }];

      await adapter.execute('SELECT * FROM users WHERE id = $1 AND email = $2', { params: [7, 'a@b.com'] });

      const query = client.calls.find(c => c instanceof FakeQuery);
      expect(query.text).toBe('SELECT * FROM users WHERE id = $1 AND email = $2');
      expect(query.values).toEqual([7, 'a@b.com']);
    });

    test('binds nothing when the caller supplies nothing', async () => {
      client.script = [{ rows: [] }];

      await adapter.execute('SELECT 1');

      expect(client.calls.find(c => c instanceof FakeQuery).values).toEqual([]);
    });

    test('refuses a params value that is not an array', async () => {
      await expect(adapter.execute('SELECT $1', { params: 'nope' }))
        .rejects.toThrow("'params' must be an array");
    });

    test('refuses undefined rather than sending it as NULL', async () => {
      // pg would encode `undefined` as NULL and the row would quietly store one.
      await expect(adapter.execute('SELECT $1', { params: [undefined] }))
        .rejects.toThrow('contains undefined');
    });

    test('names the placeholder and value counts when the bind fails', async () => {
      client.script = [{
        error: new Error('bind message supplies 1 parameters, but prepared statement "" requires 2')
      }];

      const error = await adapter.execute('SELECT * FROM t WHERE a = $1 AND b = $2', { params: [1] })
        .catch(e => e);

      // pg's own text names both numbers but not the fix, and the fix is a
      // one-token edit to the array.
      expect(error.message).toContain('has 2 placeholder(s) ($1, $2) and 1 value(s) were supplied');
      expect(error.message).toContain('$2 has no value');
      expect(error.message).toContain('Add the missing values to "params"');
      expect(error.cause).toBeTruthy();
    });
  });

  describe('maxRows', () => {
    beforeEach(async () => {
      await connect();
    });

    // The cap has to stop pg from *keeping* the rows, not just stop this code
    // from pushing them, or a 500 MB result set is still materialised in the
    // driver before the array is trimmed.
    test('builds the Query with no callback, so pg does not accumulate', async () => {
      client.script = [{ rows: [{ id: 1 }, { id: 2 }] }];

      await adapter.execute('SELECT 1', { maxRows: 1 });

      const query = client.calls.find(c => c instanceof FakeQuery);
      expect(query.callback).toBeUndefined();
      expect(query.hasRowListener).toBe(true);
    });

    test('uses the callback path when no cap is asked for', async () => {
      client.script = [{ rows: [{ id: 1 }] }];

      await adapter.execute('SELECT 1');

      const query = client.calls.find(c => c instanceof FakeQuery);
      expect(typeof query.callback).toBe('function');
      expect(query.hasRowListener).toBe(false);
    });

    test('returns the prefix and no truncation marker when the result fits', async () => {
      client.script = [{ rows: [{ id: 1 }, { id: 2 }] }];

      const rows = await adapter.execute('SELECT 1', { maxRows: 5 });

      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(rows.truncated).toBeUndefined();
    });

    test('marks a partial answer, because a truncated answer is a partial answer', async () => {
      client.script = [{ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }];

      const rows = await adapter.execute('SELECT 1', { maxRows: 2 });

      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(rows.truncated).toBe(true);
      expect(rows.limitReason).toBe('maxRows');
    });

    // The marker must not leak into the serialised answer: it is a property, not
    // a row, and the envelope stringifies what it is given.
    test('keeps the marker out of JSON and off the array length', async () => {
      client.script = [{ rows: [{ id: 1 }, { id: 2 }] }];

      const rows = await adapter.execute('SELECT 1', { maxRows: 1 });

      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).toBe('[{"id":1}]');
    });

    test('returns a status object for a capped write, uncapped in practice', async () => {
      client.script = [{ rows: [], command: 'UPDATE', rowCount: 3 }];

      const rows = await adapter.execute('UPDATE t SET a = 1', { maxRows: 1 });

      expect(rows).toEqual([{ affectedRows: 3, command: 'UPDATE', oid: 0 }]);
    });

    test('treats maxRows: 0 as no cap rather than as no rows', async () => {
      client.script = [{ rows: [{ id: 1 }] }];

      const rows = await adapter.execute('SELECT 1', { maxRows: 0 });

      expect(rows).toEqual([{ id: 1 }]);
    });

    test('releases the client even when the capped statement fails', async () => {
      client.script = [{ error: new Error('boom') }];

      await expect(adapter.execute('SELECT 1', { maxRows: 1 })).rejects.toThrow('boom');
      expect(client.released).toBe(1);
    });
  });

  describe('session state', () => {
    beforeEach(async () => {
      await connect();
    });

    // A stray BEGIN attaches an open transaction to a pooled client, and the
    // next borrower inherits it: its SELECTs run inside a foreign transaction
    // holding locks and a snapshot nobody asked for.
    test.each(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT s', 'START TRANSACTION'])(
      'refuses %s rather than leaking it onto the pooled client', async (sql) => {
        await expect(adapter.execute(sql, { readOnly: false }))
          .rejects.toThrow('[Postgres transactions are not supported]');
        expect(client.released).toBe(0);
        expect(client.calls).toHaveLength(0);
      }
    );

    test('says why, and what a real transaction would need', async () => {
      const error = await adapter.execute('BEGIN', { readOnly: false }).catch(e => e);
      expect(error.message).toContain('the next caller would inherit it');
      expect(error.message).toContain('pins one connection across calls');
    });

    test('resets the session before the client goes back to the pool', async () => {
      // The alternative — evicting any client whose state *might* have changed —
      // throws away a warm authenticated socket on every statement, and
      // re-authenticating is the cost the connection cache exists to avoid.
      client.script = [{ rows: [] }];

      await adapter.execute('SELECT 1');

      expect(session()).toEqual([
        'SET statement_timeout = 30000',
        'RESET ALL'
      ]);
    });

    test('rolls back as well for a statement that can leave a transaction open', async () => {
      client.script = [{ rows: [] }];

      await adapter.execute('CALL do_something()', { readOnly: false });

      expect(session()).toContain('ROLLBACK');
    });

    test('destroys rather than reuses a client that cannot be reset', async () => {
      client.query = (arg) => {
        if (typeof arg === 'string' && /RESET ALL/.test(arg)) return Promise.reject(new Error('no connection'));
        if (arg instanceof FakeQuery) {
          arg.deliver({ rows: [] });
          return arg;
        }
        return Promise.resolve({ rows: [] });
      };

      await adapter.execute('SELECT 1');

      // A connection whose state is unknown is not safe to hand to the next
      // caller. Reconnecting costs one handshake; leaking costs a wrong answer.
      expect(client.destroyed).toBe(1);
    });
  });

  describe('abort', () => {
    beforeEach(async () => {
      await connect();
    });

    test('aims a cancel at the statement the caller gave up on', async () => {
      client.script = [{ hang: true }];
      const running = adapter.execute('SELECT pg_sleep(60)');
      await drain();

      adapter.abort();

      expect(CancelClient.cancels).toHaveLength(1);
      // A cancel is a second, unauthenticated connection, so it needs the same
      // connection parameters, and it has to name the exact Query being waited
      // on: pg's cancel is a no-op for anything else.
      expect(CancelClient.cancels[0].target).toBe(client);
      expect(CancelClient.cancels[0].query.text).toBe('SELECT pg_sleep(60)');
      expect(CancelClient.cancels[0].options.connectionString)
        .toBe('postgres://user:pass@localhost:5432/mydb');

      client.calls.filter(c => c instanceof FakeQuery).forEach(q => q.deliver({ error: CANCELED }));
      await expect(running).rejects.toThrow('[Postgres cancelled]');
    });

    test('cancels every statement sharing the pool', async () => {
      client.script = [{ hang: true }, { hang: true }];
      const first = adapter.execute('SELECT pg_sleep(60)');
      const second = adapter.execute('SELECT pg_sleep(60)');
      await drain();

      adapter.abort();

      expect(CancelClient.cancels).toHaveLength(2);
      client.calls.filter(c => c instanceof FakeQuery).forEach(q => q.deliver({ error: CANCELED }));
      await expect(first).rejects.toThrow('[Postgres cancelled]');
      await expect(second).rejects.toThrow('[Postgres cancelled]');
    });

    // The bounded path builds the Query before it is submitted, so a cancel has
    // something to aim at there too.
    test('aims a cancel at a capped statement', async () => {
      client.script = [{ hang: true }];
      const running = adapter.execute('SELECT pg_sleep(60)', { maxRows: 5 });
      await drain();

      adapter.abort();

      expect(CancelClient.cancels).toHaveLength(1);
      expect(CancelClient.cancels[0].query.text).toBe('SELECT pg_sleep(60)');
      client.calls.filter(c => c instanceof FakeQuery).forEach(q => q.deliver({ error: CANCELED }));
      await expect(running).rejects.toThrow('[Postgres cancelled]');
    });

    test('opens no cancel connection when nothing is running', () => {
      adapter.abort();
      expect(CancelClient.cancels).toHaveLength(0);
    });

    test('does not throw when the cancel cannot even be attempted', async () => {
      client.script = [{ hang: true }];
      const running = adapter.execute('SELECT 1');
      await drain();

      const real = adapter.ClientClass;
      adapter.ClientClass = function BrokenCancelClient() { throw new Error('no route to host'); };
      expect(() => adapter.abort()).not.toThrow();
      adapter.ClientClass = real;

      client.calls.filter(c => c instanceof FakeQuery).forEach(q => q.deliver({ error: new Error('abandoned') }));
      await expect(running).rejects.toThrow();
    });

    test('is idempotent', async () => {
      client.script = [{ hang: true }];
      const running = adapter.execute('SELECT 1');
      await drain();

      adapter.abort();
      adapter.abort();

      expect(CancelClient.cancels).toHaveLength(1);
      client.calls.filter(c => c instanceof FakeQuery).forEach(q => q.deliver({ error: new Error('abandoned') }));
      await expect(running).rejects.toThrow();
    });

    test('is safe with no pool', () => {
      expect(() => adapter.abort()).not.toThrow();
    });

    test('reports itself unhealthy, so the cache rebuilds rather than reuses', async () => {
      adapter.abort();
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });
  });

  describe('isHealthy', () => {
    test('is true when the pool answers', async () => {
      await connect();
      await expect(adapter.isHealthy()).resolves.toBe(true);
      expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    });

    test('is false when the server has gone away underneath an idle socket', async () => {
      await connect();
      pool.query.mockRejectedValueOnce(Object.assign(new Error('server closed the connection'), {
        code: '57P01'
      }));
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });

    test('is false with no pool', async () => {
      await expect(adapter.isHealthy()).resolves.toBe(false);
    });
  });

  describe('describe', () => {
  // Driven from here rather than by reaching the *SchemaAdapter class directly and
  // assigning `schema.pool` afterwards, which left the `new …; schema.pool = …`
  // wiring in the adapter untested. The catalogue runs on a checked-out client, not
  // on `pool.query`, because `SET statement_timeout` is a session setting.
    const catalogue = (handlers) => {
      client.query = jest.fn(async (sql, params) => {
        client.calls.push({ sql, params });
        for (const [pattern, rows] of handlers) {
          if (pattern.test(sql)) {
            if (typeof rows === 'function') return rows();
            return { rows };
          }
        }
        return { rows: [] };
      });
    };

    test('hands the schema adapter the live pool', async () => {
      await connect();
      catalogue([
        [/pg_class/, []],
        [/pg_namespace/, [{ name: 'public' }]],
      ]);

      const out = await adapter.describe({});

      expect(pool.connect).toHaveBeenCalled();
      expect(out.database).toBe('postgresql');
      expect(out.schemas).toEqual(['public']);
      expect(out.tables).toEqual([]);
    });

    test('reports a missing relation the same way db_query does', async () => {
      await connect();
      catalogue([
        [/pg_class/, () => {
          throw Object.assign(new Error('relation "nope" does not exist'), { code: '42P01' });
        }],
      ]);

      // db_schema used to bypass describeError entirely, so this was a bare
      // `42P01` while the same failure through db_query was a sentence.
      await expect(adapter.describe({})).rejects.toThrow('[Postgres relation (table or view) does not exist]');
    });

    test('passes the caller\'s timeout to the catalogue scan', async () => {
      await connect();
      catalogue([[/pg_class/, []]]);

      await adapter.describe({ timeout: 1234 });

      expect(client.calls[0].sql).toBe('SET statement_timeout = 1234');
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
      const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockEnd.mockRejectedValueOnce(new Error('pool already ended'));
      await connect();
      await expect(adapter.close()).resolves.not.toThrow();
      logged.mockRestore();
    });

    test('ends the pool after an abort instead of orphaning it', async () => {
      await connect();
      client.script = [{ hang: true }];
      const running = adapter.execute('SELECT pg_sleep(60)');
      await drain();

      adapter.abort();
      await adapter.close();

      // pg-pool only resolves end() once every client has been released, so the
      // pool still has to be ended rather than simply disowned.
      expect(mockEnd).toHaveBeenCalled();
      expect(adapter.pool).toBeNull();

      client.calls.filter(c => c instanceof FakeQuery).forEach(q => q.deliver({ error: new Error('abandoned') }));
      await expect(running).rejects.toThrow();
    });

    test('resolves even when the pool never releases its client', async () => {
      await connect();
      adapter.abort();
      mockEnd.mockImplementationOnce(() => new Promise(() => {}));

      // The hang this avoids is teardown waiting on a backend that is not going
      // to answer, not on the pool's own bookkeeping.
      await expect(adapter.close()).resolves.toBeUndefined();
      expect(mockEnd).toHaveBeenCalled();
    });

    test('forgets the statements it was tracking', async () => {
      await connect();
      client.script = [{ hang: true }];
      const running = adapter.execute('SELECT 1');
      await drain();

      await adapter.close();

      expect(adapter.inFlight.size).toBe(0);
      client.calls.filter(c => c instanceof FakeQuery).forEach(q => q.deliver({ error: new Error('abandoned') }));
      await expect(running).rejects.toThrow();
    });
  });
});
