import { MongoAdapter, READ_ACTIONS, ALL_ACTIONS } from '../src/adapters/mongodb.js';

describe('MongoAdapter actions', () => {
  let adapter;
  let collection;
  let db;
  let client;

  const cursor = (overrides = {}) => {
    const c = {
      limit: jest.fn(),
      sort: jest.fn(),
      project: jest.fn(),
      maxTimeMS: jest.fn(),
      toArray: jest.fn().mockResolvedValue([]),
      explain: jest.fn().mockResolvedValue({ queryPlanner: {} }),
      ...overrides
    };
    c.limit.mockReturnValue(c);
    c.sort.mockReturnValue(c);
    c.project.mockReturnValue(c);
    c.maxTimeMS.mockReturnValue(c);
    return c;
  };

  beforeEach(() => {
    const c = cursor();
    collection = {
      find: jest.fn(() => c),
      findOne: jest.fn(),
      countDocuments: jest.fn().mockResolvedValue(0),
      distinct: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) })),
      insertMany: jest.fn().mockResolvedValue({ insertedCount: 0, insertedIds: {} }),
      insertOne: jest.fn().mockResolvedValue({ acknowledged: true, insertedId: 1 }),
      updateMany: jest.fn().mockResolvedValue({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }),
      deleteMany: jest.fn().mockResolvedValue({ acknowledged: true, deletedCount: 0 }),
      __cursor: c
    };
    db = { collection: jest.fn(() => collection) };
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

    test.each(['drop', 'findAndModify', 'truncate', 'remove', '', 42])(
      'rejects the unknown action %p', async (action) => {
        await expect(run('{}', { action })).rejects.toThrow(/Unknown MongoDB action/);
      }
    );

    test('runs a write action', async () => {
      // Whether a write is permitted is the guard's decision, not the
      // adapter's: the adapter must know how to perform one.
      const options = { action: 'delete' };
      await expect(run('{}', options)).resolves.toEqual([{ acknowledged: true, deletedCount: 0 }]);
    });

    test('requires a collection for every action', async () => {
      await expect(adapter.execute('{}', { action: 'count' }))
        .rejects.toThrow('Collection name is required');
    });
  });

  describe('find', () => {
    test('returns documents', async () => {
      collection.__cursor.toArray.mockResolvedValue([{ _id: 1, name: 'a' }]);
      await expect(run('{"name":"a"}')).resolves.toEqual([{ _id: 1, name: 'a' }]);
      expect(collection.find).toHaveBeenCalledWith({ name: 'a' });
    });

    test('applies maxTimeMS', async () => {
      await run('{}');
      expect(collection.__cursor.maxTimeMS).toHaveBeenCalledWith(30000);
    });

    test('applies the limit', async () => {
      await run('{}', { limit: 3 });
      expect(collection.__cursor.limit).toHaveBeenCalledWith(3);
    });

    test('applies a sort when asked', async () => {
      await run('{}', { sort: '{"createdAt":-1}' });
      expect(collection.__cursor.sort).toHaveBeenCalledWith({ createdAt: -1 });
    });

    test('projects only when a projection is given', async () => {
      await run('{}', { projection: '{"name":1}' });
      expect(collection.__cursor.project).toHaveBeenCalledWith({ name: 1 });
    });

    test('does not project by default', async () => {
      await run('{}');
      expect(collection.__cursor.project).not.toHaveBeenCalled();
    });

    test('replaces an oversized document', async () => {
      const huge = { _id: 1, blob: 'x'.repeat(2 * 1024 * 1024) };
      collection.__cursor.toArray.mockResolvedValue([huge]);

      const out = await run('{}');

      expect(out[0]._truncated).toBe(true);
      expect(out[0]._bytes).toBeGreaterThan(1024 * 1024);
      expect(out[0]._keys).toEqual(['_id', 'blob']);
      expect(JSON.stringify(out).length).toBeLessThan(1000);
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
      expect(collection.distinct).toHaveBeenCalledWith('status', {});
    });

    test('distinct requires a field', async () => {
      await expect(run('{}', { action: 'distinct' })).rejects.toThrow('"field" option is required');
    });

    test('explain returns the plan', async () => {
      await expect(run('{}', { action: 'explain' })).resolves.toEqual([{ explain: { queryPlanner: {} } }]);
    });
  });

  describe('aggregate', () => {
    const pipeline = '[{"$match":{"a":1}}]';

    test('runs a pipeline', async () => {
      const toArray = jest.fn().mockResolvedValue([{ n: 1 }]);
      collection.aggregate = jest.fn(() => ({ toArray }));

      await expect(run(pipeline, { action: 'aggregate' })).resolves.toEqual([{ n: 1 }]);
      expect(collection.aggregate).toHaveBeenCalledWith(
        [{ $match: { a: 1 } }],
        expect.objectContaining({ maxTimeMS: 30000 })
      );
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
      const toArray = jest.fn().mockResolvedValue([]);
      collection.aggregate = jest.fn(() => ({ toArray }));

      await expect(run('[{"$out":"copy"}]', { action: 'aggregate', allowWriteStages: true }))
        .resolves.toEqual([]);
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

    test('delete reports the count', async () => {
      collection.deleteMany.mockResolvedValue({ acknowledged: true, deletedCount: 3 });
      await expect(run('{"a":1}', { action: 'delete' }))
        .resolves.toEqual([{ acknowledged: true, deletedCount: 3 }]);
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
      collection.__cursor.toArray.mockRejectedValue(err);
      await expect(run('{}')).rejects.toThrow(pattern);
    });

    test('keeps an unrecognised code visible', async () => {
      collection.__cursor.toArray.mockRejectedValue({ code: 99999, message: 'mystery' });
      await expect(run('{}')).rejects.toThrow('[MongoDB 99999] mystery');
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
