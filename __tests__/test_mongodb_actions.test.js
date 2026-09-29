import { MongoAdapter, READ_ACTIONS, ALL_ACTIONS } from '../src/adapters/mongodb.js';

describe('MongoAdapter actions', () => {
  let adapter;
  let collection;
  let db;
  let client;
  let findCursor;
  let aggregateCursor;

  /**
   * A cursor that behaves the way the real one does, in the two ways the cap
   * depends on: it is an async iterable with `next()` and `close()`, and
   * `next()` returns `null` at the end rather than throwing.
   */
  const cursor = (documents = [], overrides = {}) => {
    const state = { documents: [...documents], closed: false, maxTimeMS: null, limit: null, skip: null };
    const c = {
      state,
      limit: jest.fn((n) => { state.limit = n; return c; }),
      skip: jest.fn((n) => { state.skip = n; return c; }),
      sort: jest.fn(() => c),
      project: jest.fn(() => c),
      batchSize: jest.fn(() => c),
      maxTimeMS: jest.fn((ms) => { state.maxTimeMS = ms; return c; }),
      toArray: jest.fn(async () => [...state.documents]),
      async next() {
        return state.documents.length ? state.documents.shift() : null;
      },
      close: jest.fn(async () => { state.closed = true; }),
      explain: jest.fn(async () => ({ queryPlanner: {} })),
      ...overrides
    };
    return c;
  };

  beforeEach(() => {
    collection = {
      find: jest.fn(() => findCursor),
      findOne: jest.fn(),
      countDocuments: jest.fn().mockResolvedValue(0),
      distinct: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn(() => aggregateCursor),
      insertMany: jest.fn().mockResolvedValue({ insertedCount: 0, insertedIds: {} }),
      insertOne: jest.fn().mockResolvedValue({ acknowledged: true, insertedId: 1 }),
      updateMany: jest.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }),
      replaceOne: jest.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0, upsertedId: null }),
      deleteMany: jest.fn().mockResolvedValue({ acknowledged: true, deletedCount: 0 }),
      deleteOne: jest.fn().mockResolvedValue({ acknowledged: true, deletedCount: 0 })
    };
    // Fresh cursors per test. A shared one accumulates: a `project` call from an
    // earlier test is still recorded, and a `next()` has already drained the
    // documents a later test is about to assert on.
    findCursor = cursor([{ _id: 1, name: 'a' }]);
    aggregateCursor = cursor([{ n: 1 }]);

    // In the real driver `client.db` is both callable — `client.db(name)` returns
    // a `Db` — and a property, so `client.db.listCollections(...)` and
    // `client.db()` are both legal. Modelled, because the adapter uses the first
    // form and the schema adapter the second.
    const handle = { collection: jest.fn(() => collection) };
    const db = jest.fn(() => handle);
    Object.assign(db, handle);
    client = { connect: jest.fn(), close: jest.fn().mockResolvedValue(), db };

    adapter = new MongoAdapter(jest.fn(() => client), 30000);
  });

  beforeEach(async () => {
    await adapter.connect('mongodb://localhost:27017/shop');
  });

  const run = (query, options = {}) => adapter.execute(query, { collection: 'users', ...options });

  describe('action resolution', () => {
    test('defaults to find', async () => {
      await run('{}');
      expect(collection.find).toHaveBeenCalled();
    });

    test('exposes the read and full action sets', () => {
      expect([...READ_ACTIONS]).toEqual(expect.arrayContaining(['find', 'count', 'distinct', 'aggregate']));
      expect([...ALL_ACTIONS]).toEqual(expect.arrayContaining(['insert', 'update', 'delete']));
    });

    // The `*Many` forms were the only ones that existed, so "delete this one
    // document" had to be written as `deleteMany` with a hand-rolled filter.
    test('offers the single-document forms as well', () => {
      expect([...ALL_ACTIONS]).toEqual(expect.arrayContaining(['updateOne', 'replace', 'deleteOne']));
    });

    test.each(['drop', 'findAndModify', 'truncate', 'remove', '', 42])(
      'rejects the unknown action %p', async (action) => {
        await expect(run('{}', { action })).rejects.toThrow(/Unknown MongoDB action/);
      }
    );

    test('runs a write action', async () => {
      // Whether a write is permitted is the guard's decision, not the
      // adapter's: the adapter must know how to perform one.
      await expect(run('{"a":1}', { action: 'delete' }))
        .resolves.toEqual([{ acknowledged: true, deletedCount: 0 }]);
    });

    test('requires a collection for every action', async () => {
      await expect(adapter.execute('{}', { action: 'count' }))
        .rejects.toThrow('Collection name is required');
    });
  });

  describe('find', () => {
    test('returns documents', async () => {
      await expect(run('{"name":"a"}')).resolves.toEqual([{ _id: 1, name: 'a' }]);
      expect(collection.find).toHaveBeenCalledWith({ name: 'a' });
    });

    test('applies maxTimeMS', async () => {
      await run('{}');
      expect(findCursor.maxTimeMS).toHaveBeenCalledWith(30000);
    });

    test("takes the timeout from the call, not from a field on the shared adapter", async () => {
      await run('{}', { timeout: 1500 });
      expect(findCursor.maxTimeMS).toHaveBeenCalledWith(1500);
    });

    test('applies the limit', async () => {
      await run('{}', { limit: 3 });
      expect(findCursor.limit).toHaveBeenCalledWith(3);
    });

    test('applies a sort when asked', async () => {
      await run('{}', { sort: '{"createdAt":-1}' });
      expect(findCursor.sort).toHaveBeenCalledWith({ createdAt: -1 });
    });

    test('projects only when a projection is given', async () => {
      await run('{}', { projection: '{"name":1}' });
      expect(findCursor.project).toHaveBeenCalledWith({ name: 1 });
    });

    test('does not project by default', async () => {
      await run('{}');
      expect(findCursor.project).not.toHaveBeenCalled();
    });

    test('skips when an offset is given', async () => {
      await run('{}', { offset: 40 });
      expect(findCursor.skip).toHaveBeenCalledWith(40);
    });

    test('clips a document that is too large, but keeps its fields', async () => {
      const huge = { _id: 1, email: 'a@b.com', blob: 'x'.repeat(2 * 1024 * 1024) };
      findCursor.state.documents = [huge];

      const out = await run('{}');

      // The old answer was `{_truncated, _bytes, _keys}` and nothing else: no
      // field value at all, so the only honest next step was to re-query.
      expect(out[0]._truncated).toBe(true);
      expect(out[0]._id).toBe(1);
      expect(out[0].email).toBe('a@b.com');
      expect(out[0].blob).toMatchObject({ _clipped: 'blob' });
      expect(out[0].blob._preview.length).toBeLessThan(9000);
    });

    test('leaves a document that fits alone', async () => {
      const out = await run('{}');
      expect(out[0]._truncated).toBeUndefined();
    });

    test('clips a long string without serialising the document twice', async () => {
      const big = { note: 'x'.repeat(2 * 1024 * 1024), n: 1 };
      findCursor.state.documents = [big];

      const out = await run('{}');

      expect(out[0].note).toMatchObject({ _clipped: 'note', _chars: 2 * 1024 * 1024 });
      expect(out[0].n).toBe(1);
    });
  });

  describe('count, distinct, explain', () => {
    test('count returns a count', async () => {
      collection.countDocuments.mockResolvedValue(17);
      await expect(run('{"a":1}', { action: 'count' })).resolves.toEqual([{ count: 17 }]);
      expect(collection.countDocuments).toHaveBeenCalledWith({ a: 1 });
    });

    test('distinct returns values', async () => {
      collection.distinct.mockResolvedValue(['x', 'y']);
      await expect(run('{}', { action: 'distinct', field: 'status' }))
        .resolves.toEqual(['x', 'y']);
      expect(collection.distinct).toHaveBeenCalledWith('status', {}, expect.any(Object));
    });

    test('distinct requires a field', async () => {
      await expect(run('{}', { action: 'distinct' })).rejects.toThrow('"field" option is required');
    });

    // `distinct` had no limit at all, and the driver's method has no streaming
    // form, so the bound is on the answer rather than on the work.
    test('bounds a distinct list and says the answer is partial', async () => {
      collection.distinct.mockResolvedValue(['a', 'b', 'c', 'd']);

      const values = await run('{}', { action: 'distinct', field: 's', maxRows: 2 });

      expect(values).toEqual(['a', 'b']);
      expect(values.truncated).toBe(true);
    });

    test('gives distinct a server-side time limit, which is the only bound on its work', async () => {
      await run('{}', { action: 'distinct', field: 's', maxRows: 2 });
      expect(collection.distinct.mock.calls[0][2]).toMatchObject({ maxTimeMS: 30000 });
    });

    test('explain returns the plan', async () => {
      await expect(run('{}', { action: 'explain' })).resolves.toEqual([{ explain: { queryPlanner: {} } }]);
    });
  });

  describe('aggregate', () => {
    const pipeline = '[{"$match":{"a":1}}]';

    test('runs a pipeline', async () => {
      await expect(run(pipeline, { action: 'aggregate' })).resolves.toEqual([{ n: 1 }]);
      expect(collection.aggregate).toHaveBeenCalledWith(
        [{ $match: { a: 1 } }],
        expect.objectContaining({ maxTimeMS: 30000 })
      );
    });

  // The tool description promises a limit and none was applied. Appending one
  // unconditionally would be wrong in a different way: a trailing `$limit` after a
  // `$group` is useless for the work, and after a `$sort` it changes the answer,
  // because the first N rows in sorted order are not the first N in arrival order.
    test('appends no $limit the caller did not ask for', async () => {
      await run(pipeline, { action: 'aggregate' });
      expect(collection.aggregate.mock.calls[0][0]).toEqual([{ $match: { a: 1 } }]);
    });

    test('appends a $limit when the caller wrote one', async () => {
      await run(pipeline, { action: 'aggregate', limit: 5 });
      expect(collection.aggregate.mock.calls[0][0]).toEqual([{ $match: { a: 1 } }, { $limit: 5 }]);
    });

    test('appends a $skip for an offset', async () => {
      await run(pipeline, { action: 'aggregate', offset: 20 });
      expect(collection.aggregate.mock.calls[0][0]).toEqual([{ $match: { a: 1 } }, { $skip: 20 }]);
    });

    // The always-on bound is on what is collected, not on what the server
    // computes, so it cannot change the meaning of the pipeline.
    test('caps what it collects without touching the pipeline', async () => {
      aggregateCursor.state.documents = [{ n: 1 }, { n: 2 }, { n: 3 }];

      const rows = await run(pipeline, { action: 'aggregate', maxRows: 2 });

      expect(rows).toHaveLength(2);
      expect(rows.truncated).toBe(true);
      expect(collection.aggregate.mock.calls[0][0]).toEqual([{ $match: { a: 1 } }]);
    });

    test('closes the server cursor after a capped read', async () => {
      aggregateCursor.state.documents = [{ n: 1 }, { n: 2 }, { n: 3 }];
      await run(pipeline, { action: 'aggregate', maxRows: 2 });
      // Without this the server keeps the result set alive, which on a large
      // aggregation is a cursor on the server until its own timeout expires.
      expect(aggregateCursor.close).toHaveBeenCalled();
    });

    test('refuses a $out stage', async () => {
      // $out replaces a collection, so a read-only agent must not reach it.
      await expect(run('[{"$out":"copy"}]', { action: 'aggregate' }))
        .rejects.toThrow(/\$out stage writes to a collection/);
      expect(collection.aggregate).not.toHaveBeenCalled();
    });

    test('refuses a $merge stage', async () => {
      await expect(run('[{"$match":{}},{"$merge":{"into":"x"}}]', { action: 'aggregate' }))
        .rejects.toThrow(/\$merge stage writes to a collection/);
    });

    test('permits write stages when explicitly allowed', async () => {
      await expect(run('[{"$out":"copy"}]', { action: 'aggregate', allowWriteStages: true }))
        .resolves.toEqual([{ n: 1 }]);
      expect(collection.aggregate).toHaveBeenCalled();
    });

    test('refuses a nested write stage even with readOnly off', async () => {
      // The read-only guard is skipped entirely when readOnly is false, so the
      // adapter has to do the walk itself. A $merge inside $facet writes just as
      // surely as a bare one.
      await expect(run('[{"$facet":{"all":[{"$merge":{"into":"copy"}}]}}]', { action: 'aggregate' }))
        .rejects.toThrow(/\$merge stage writes to a collection/);
      expect(collection.aggregate).not.toHaveBeenCalled();
    });

    // `findWriteStage` returns a sentinel rather than a stage name when the
    // pipeline nests past the depth the walk follows, and interpolating that into
    // "the ${stage} stage writes to a collection" produced "the (nesting limit
    // exceeded) stage writes to a collection". The refusal is still right; only
    // the reason was wrong.
    test('says the pipeline nests too deep to verify, not that a stage writes', async () => {
      const depth = 25;
      const pipelineJson = `[${'{"$facet":{"a":['.repeat(depth)}{"$match":{}}${']}}'.repeat(depth)}]`;

      const error = await run(pipelineJson, { action: 'aggregate' }).catch(e => e);

      expect(error.message).toMatch(/nests too deep/);
      expect(error.message).toMatch(/allowWriteStages/);
      expect(error.message).not.toMatch(/nesting limit exceeded\)/);
      expect(collection.aggregate).not.toHaveBeenCalled();
    });

    test.each(['{}', '[]', 'not json', '"str"'])('rejects the pipeline %p', async (q) => {
      await expect(run(q, { action: 'aggregate' })).rejects.toThrow(/pipeline|valid JSON/);
    });
  });

  describe('writes', () => {
    test('insert accepts a single document as a one-element array', async () => {
      collection.insertMany.mockResolvedValue({ acknowledged: true, insertedCount: 1, insertedIds: { 0: 1 } });
      const out = await run('{"a":1}', { action: 'insert' });

      expect(collection.insertMany).toHaveBeenCalledWith([{ a: 1 }]);
      expect(Array.isArray(out)).toBe(true);
      expect(out[0].insertedCount).toBe(1);
    });

    test('insert accepts an array of documents', async () => {
      await run('[{"a":1},{"a":2}]', { action: 'insert' });
      expect(collection.insertMany).toHaveBeenCalledWith([{ a: 1 }, { a: 2 }]);
    });

    test('insert refuses an empty array', async () => {
      await expect(run('[]', { action: 'insert' })).rejects.toThrow('at least one document');
    });

    test('update requires an update document', async () => {
      await expect(run('{"a":1}', { action: 'update' })).rejects.toThrow('"update" option is required');
    });

    test('update applies the update document', async () => {
      collection.updateMany.mockResolvedValue({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null });
      const out = await run('{"a":1}', { action: 'update', update: '{"$set":{"b":2}}' });

      expect(collection.updateMany).toHaveBeenCalledWith({ a: 1 }, { $set: { b: 2 } }, { upsert: false });
      // The shape is fixed by us, not by whatever the driver happened to expose.
      expect(out).toEqual([{
        acknowledged: null, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null
      }]);
    });

    test('update passes upsert only when asked', async () => {
      await run('{"a":1}', { action: 'update', update: '{"$set":{"b":2}}', upsert: true });
      expect(collection.updateMany).toHaveBeenCalledWith(expect.anything(), expect.anything(), { upsert: true });
    });

    test('update accepts an object as well as a JSON string', async () => {
      await run('{"a":1}', { action: 'update', update: { $set: { b: 2 } } });
      expect(collection.updateMany).toHaveBeenCalledWith({ a: 1 }, { $set: { b: 2 } }, { upsert: false });
    });

    test('updateOne changes a single document', async () => {
      collection.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null });
      await run('{"a":1}', { action: 'updateOne', update: '{"$set":{"b":2}}' });
      expect(collection.updateOne).toHaveBeenCalledWith({ a: 1 }, { $set: { b: 2 } }, { upsert: false });
    });

    test('replace replaces a whole document', async () => {
      collection.replaceOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1, upsertedId: null });
      await run('{"_id":1}', { action: 'replace', document: '{"name":"x"}' });
      expect(collection.replaceOne).toHaveBeenCalledWith({ _id: 1 }, { name: 'x' }, { upsert: false });
    });

    test('replace requires a replacement document', async () => {
      await expect(run('{"_id":1}', { action: 'replace' }))
        .rejects.toThrow('"document" option is required');
    });

    test('delete reports the count', async () => {
      collection.deleteMany.mockResolvedValue({ acknowledged: true, deletedCount: 3 });
      await expect(run('{"a":1}', { action: 'delete' }))
        .resolves.toEqual([{ acknowledged: true, deletedCount: 3 }]);
      expect(collection.deleteMany).toHaveBeenCalledWith({ a: 1 });
    });

    test('deleteOne removes at most one document', async () => {
      collection.deleteOne.mockResolvedValue({ acknowledged: true, deletedCount: 1 });
      await expect(run('{"_id":1}', { action: 'deleteOne' }))
        .resolves.toEqual([{ acknowledged: true, deletedCount: 1 }]);
      expect(collection.deleteOne).toHaveBeenCalledWith({ _id: 1 });
    });
  });

  // `deleteMany({})` deletes every document in the collection and `updateMany({},
  // …)` rewrites every one of them, so an empty filter is a legal MongoDB filter
  // and an almost-certain mistake.
  //
  // It is NOT the same mistake on the single-document actions, and the guard is
  // drawn accordingly: `deleteOne({})` removes one document and stops. Refusing
  // `{}` there would be worse than the risk, because a caller told "empty filter
  // refused" on `deleteOne` reaches for `delete`, which *is* refused. The
  // reasoning is on `MULTI_WRITE_ACTIONS` in the adapter; this is the enforcement,
  // both halves.
  describe('empty filters on a write', () => {
    test.each(['update', 'delete'])(
      'refuses an empty filter for %s, which would touch every document', async (action) => {
        const options = { action, update: '{"$set":{"b":2}}', document: '{"a":1}' };
        const error = await run('{}', options).catch(e => e);

        expect(error.message).toMatch(/matches every document in the collection/);
        // The suggestion has to name the *other* action, not this one with `One`
        // stuck on the end — which is what the message used to produce:
        // `use "deleteOneOne"`.
        expect(error.message).toContain(`"${action}One"`);
        expect(error.message).not.toMatch(new RegExp(`"${action}One"` + 'One"'));
      }
    );

    test.each(['updateOne', 'replace', 'deleteOne'])(
      'permits an empty filter for %s, which touches exactly one document', async (action) => {
        // The half of the guard that is *not* a refusal, and the half worth a
        // test: a bounded action with an unbounded-looking filter is not a
        // mistake, and the caller still had to ask for a write.
        const options = { action, update: '{"$set":{"b":2}}', document: '{"a":1}' };
        const rows = await run('{}', options);

        expect(rows).toEqual(expect.any(Array));
        if (action === 'updateOne') expect(collection.updateOne).toHaveBeenCalledWith({}, { $set: { b: 2 } }, { upsert: false });
        if (action === 'replace') expect(collection.replaceOne).toHaveBeenCalledWith({}, { a: 1 }, { upsert: false });
        if (action === 'deleteOne') expect(collection.deleteOne).toHaveBeenCalledWith({});
      }
    );

    test('refuses a missing filter entirely, which is an omission rather than a request', async () => {
      // Separate from the empty filter, and separate per action: for `delete` the
      // reason is the wipe, for `deleteOne` it is that "change some document"
      // with no filter at all is not a question anybody answered.
      const many = await run('', { action: 'delete' }).catch(e => e);
      expect(many.message).toMatch(/needs a filter/);
      expect(many.message).toMatch(/matches every document/);
      expect(many.message).toContain('"deleteOne"');

      const one = await run('', { action: 'deleteOne' }).catch(e => e);
      expect(one.message).toMatch(/needs a filter/);
      expect(one.message).toMatch(/Pass \{\} to let the server choose a document/);
    });

    test('leaves a read action alone, because {} means "everything" there', async () => {
      await expect(run('{}', { action: 'find' })).resolves.toBeTruthy();
      expect(collection.find).toHaveBeenCalledWith({});
    });

    test('leaves a real filter alone', async () => {
      await run('{"a":1}', { action: 'delete' });
      expect(collection.deleteMany).toHaveBeenCalledWith({ a: 1 });
    });
  });

  describe('filter validation', () => {
    test.each(['not json', '[1,2]', '"a string"', '42', 'null'])(
      'rejects the filter %p', async (q) => {
        await expect(run(q)).rejects.toThrow(/JSON/);
      }
    );

    test('treats an empty filter as match everything', async () => {
      await run('');
      expect(collection.find).toHaveBeenCalledWith({});
    });
  });

  describe('error classification', () => {
    test.each([
      [{ code: 50, message: 'operation exceeded time limit' }, /maxTimeMS/],
      [{ code: 11000, message: 'E11000 duplicate key' }, /duplicate key/i],
      [{ code: 26, message: 'ns does not exist' }, /collection not found/i],
      [{ message: 'Sort exceeded memory limit of 33554432 bytes' }, /Add an index/],
      [{ message: 'not authorized on shop' }, /not authorized/i],
    ])('describes %p', async (err, pattern) => {
      findCursor.toArray.mockRejectedValue(err);
      await expect(run('{}')).rejects.toThrow(pattern);
    });

    test('names the caller\'s own timeout, not a shared one', async () => {
      findCursor.toArray.mockRejectedValue({ code: 50, message: 'operation exceeded time limit' });
      await expect(run('{}', { timeout: 700 })).rejects.toThrow('Query exceeded 700ms');
    });

    test('keeps an unrecognised code visible', async () => {
      findCursor.toArray.mockRejectedValue({ code: 99999, message: 'mystery' });
      await expect(run('{}')).rejects.toThrow('[MongoDB 99999] mystery');
    });

  // Every one of these branches used to `return new Error('…')` and nothing else,
  // which threw away MongoDB's own code. `50` is how a `maxTimeMS` abort is
  // identified, and without it `registry.isTimeoutError()` could only recognise a
  // timeout by matching the word "maxTimeMS" in a sentence this file writes.
    test.each([
      [50, 'operation exceeded time limit', /maxTimeMS/],
      [11000, 'E11000 duplicate key', /duplicate key/],
      [26, 'ns not exist', /collection not found/],
      [99999, 'mystery', /MongoDB 99999/],
    ])('keeps driver code %p on the rewritten error', async (code, driverMessage, pattern) => {
      findCursor.toArray.mockRejectedValue({ code, message: driverMessage });
      const error = await run('{}').catch((e) => e);

      expect(error.message).toMatch(pattern);
      expect(error.code).toBe(code);
    });

    test('keeps the driver error as the cause, so the stack still leads somewhere', () => {
      // `ANYDB_DEBUG=1` promises a stack trace worth reading, and
      // `registry.errorCodeOf` reaches further down the chain for a code the
      // rewrite did not copy.
      const original = Object.assign(new Error('operation exceeded time limit'), { code: 50 });
      const rewritten = adapter.describeError(original, 30000);
      expect(rewritten.cause).toBe(original);
    });
  });

  describe('health', () => {
    test('reads the topology state', async () => {
      await adapter.connect('mongodb://h/d');
      client.topology = { isConnected: () => true };
      expect(adapter.isHealthy()).toBe(true);

      client.topology = { isConnected: () => false };
      expect(adapter.isHealthy()).toBe(false);

      client.topology = undefined;
      expect(adapter.isHealthy()).toBe(false);
    });

    test('is unhealthy with no client', () => {
      expect(adapter.isHealthy()).toBe(false);
    });
  });
});
