import { MongoClient } from 'mongodb';
import { BaseAdapter } from '../core/base-adapter.js';
import { findWriteStage } from '../core/safety.js';
import { MongoSchemaAdapter } from '../core/schema.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_DOCUMENT_BYTES = 1 * 1024 * 1024;

export const READ_ACTIONS = new Set(['find', 'count', 'distinct', 'aggregate', 'explain']);

export const ALL_ACTIONS = new Set([...READ_ACTIONS, 'insert', 'update', 'delete']);

/**
 * $out and $merge replace a collection, so they need an explicit opt-in. The
 * check happens here rather than at the driver call, because a pipeline handed
 * to aggregate() has already been sent. The whole pipeline is walked: a write
 * stage nested inside $facet or $unionWith writes just as surely as a bare one.
 */
function parsePipeline(query, options = {}) {
  let pipeline;
  try {
    pipeline = JSON.parse(query);
  } catch (err) {
    throw new Error(`Aggregate pipeline is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    throw new Error(
      'Aggregate pipeline must be a non-empty JSON array of stages, for example [{"$match":{}}].'
    );
  }

  if (options.allowWriteStages !== true) {
    const stage = findWriteStage(pipeline);
    if (stage) {
      throw new Error(
        `The ${stage} stage writes to a collection and is not allowed. ` +
        'Set allowWriteStages: true to permit it.'
      );
    }
  }

  return pipeline;
}

export class MongoAdapter extends BaseAdapter {
  constructor(clientClass = MongoClient, timeout = 30000) {
    super(5000, timeout);
    this.ClientClass = clientClass;
  }

  async connect(uri) {
    this.client = new this.ClientClass(uri, {
      serverSelectionTimeoutMS: this.connectTimeout,
      connectTimeoutMS: this.connectTimeout,
    });
    await this.client.connect();
    this.db = this.client.db;
  }

  async execute(query, options = {}) {
    const action = resolveAction(options.action);
    if (!options.collection) {
      throw new Error(`Collection name is required for the "${action}" action`);
    }
    const collection = this.db.collection(options.collection);

    // The shape of the call is checked before the driver is invoked, so an
    // argument problem is not reported as a server error.
    switch (action) {
      case 'find': {
        const filter = parseFilter(query);
        return this.guard(async () => this.find(collection, filter, options));
      }
      case 'count': {
        const filter = parseFilter(query);
        return this.guard(async () => [{ count: await collection.countDocuments(filter) }]);
      }
      case 'distinct': {
        const field = requireOption(options, 'field', 'field name');
        const filter = parseFilter(query);
        return this.guard(async () => toArray(await collection.distinct(field, filter)));
      }
      case 'aggregate': {
        const pipeline = parsePipeline(query, options);
        return this.guard(async () => this.runAggregation(collection, pipeline, options));
      }
      case 'explain': {
        const filter = parseFilter(query);
        return this.guard(async () => [{ explain: await collection.find(filter).explain() }]);
      }
      case 'insert': {
        const docs = toDocuments(query);
        return this.guard(async () => toArray(await collection.insertMany(docs), INSERT_FIELDS));
      }
      case 'update': {
        const filter = parseFilter(query);
        const update = parseDocument(
          requireOption(options, 'update', 'update document'),
          'update document'
        );
        const { upsert } = options;
        return this.guard(async () => toArray(
          await collection.updateMany(filter, update, { upsert: upsert === true }),
          UPDATE_FIELDS
        ));
      }
      case 'delete': {
        const filter = parseFilter(query);
        return this.guard(async () => toArray(await collection.deleteMany(filter), DELETE_FIELDS));
      }
      default:
        throw new Error(`Unsupported MongoDB action "${action}"`);
    }
  }

  /** Runs a driver call, translating only genuine server errors. */
  async guard(work) {
    try {
      return await work();
    } catch (err) {
      throw describeMongoError(err, this.queryTimeout);
    }
  }

  async find(collection, filter, options) {
    const cursor = collection.find(filter).limit(resolveLimit(options.limit));
    if (options.sort) cursor.sort(parseDocument(options.sort, 'sort'));
    if (options.projection) cursor.project(parseDocument(options.projection, 'projection'));

    return truncateDocuments(await cursor.maxTimeMS(this.queryTimeout).toArray());
  }

  async runAggregation(collection, pipeline) {
    const rows = await collection
      .aggregate(pipeline, { maxTimeMS: this.queryTimeout, allowDiskUse: false })
      .toArray();
    return truncateDocuments(rows);
  }

  describe(options = {}) {
    const schema = new MongoSchemaAdapter(this.connectTimeout, this.queryTimeout);
    schema.client = this.client;
    return schema.describe(options);
  }

  /** Reads the driver's own topology state, so no round trip. */
  isHealthy() {
    return !!this.client && this.client.topology?.isConnected?.() === true;
  }

  /** Close the client, which cancels any operation still in flight. */
  abort() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.db = null;
    this.aborted = true;
    try {
      client.close(true).catch(() => {});
    } catch {
      // already gone
    }
  }

  async close() {
    if (this.client) {
      const client = this.client;
      this.client = null;
      try {
        await client.close();
      } catch (err) {
        if (!this.aborted) console.error('Warning: MongoDB close() failed:', err.message);
      }
    }
  }
}

function resolveAction(action) {
  if (action === undefined || action === null) return 'find';
  if (typeof action !== 'string' || !ALL_ACTIONS.has(action)) {
    throw new Error(
      `Unknown MongoDB action ${JSON.stringify(action)}. Use one of: ${[...ALL_ACTIONS].join(', ')}.`
    );
  }
  return action;
}

function requireOption(options, key, label = key) {
  const value = options[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`The "${key}" option is required for this action (${label}).`);
  }
  return value;
}

function parseFilter(query) {
  if (query === undefined || query === null || query === '') return {};
  let filter;
  try {
    filter = JSON.parse(query);
  } catch (err) {
    throw new Error(`MongoDB filter is not valid JSON: ${err.message}`);
  }
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error('MongoDB filter must be a JSON object, for example {} or {"status":"active"}.');
  }
  return filter;
}

function parseDocument(value, label) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      throw new Error(`MongoDB ${label} is not valid JSON: ${err.message}`);
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MongoDB ${label} must be a JSON object.`);
  }
  return value;
}

function toDocuments(query) {
  let parsed;
  try {
    parsed = JSON.parse(query);
  } catch (err) {
    throw new Error(`Documents are not valid JSON: ${err.message}`);
  }
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  if (docs.length === 0) {
    throw new Error('Nothing to insert: provide at least one document.');
  }
  if (docs.some(d => d === null || typeof d !== 'object' || Array.isArray(d))) {
    throw new Error('Every document to insert must be a JSON object.');
  }
  return docs;
}

/**
 * Field names are listed explicitly rather than copied off the driver result:
 * some of the driver's own properties are getters and would not survive
 * enumeration.
 */
function toArray(result, fields) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [{ result }];

  const out = {};
  for (const field of fields) {
    out[field] = result[field] ?? null;
  }
  return [out];
}

const INSERT_FIELDS = ['acknowledged', 'insertedCount', 'insertedIds'];
const UPDATE_FIELDS = ['acknowledged', 'matchedCount', 'modifiedCount', 'upsertedCount', 'upsertedId'];
const DELETE_FIELDS = ['acknowledged', 'deletedCount'];

/** A document past MAX_DOCUMENT_BYTES would overflow the caller's context. */
function truncateDocuments(docs) {
  return docs.map(doc => {
    let size;
    try {
      size = Buffer.byteLength(JSON.stringify(doc));
    } catch {
      return doc;
    }
    if (size <= MAX_DOCUMENT_BYTES) return doc;
    return {
      _truncated: true,
      _bytes: size,
      _keys: Object.keys(doc)
    };
  });
}

function resolveLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`MongoDB limit must be a positive number, got ${JSON.stringify(limit)}.`);
  }
  return Math.min(Math.trunc(parsed), MAX_LIMIT);
}

function describeMongoError(err, timeoutMs) {
  const message = (err && err.message) || String(err);
  const code = err && err.code;

  if (code === 50 || /timed out|execution time limit exceeded/i.test(message)) {
    return new Error(`[MongoDB timeout] Query exceeded ${timeoutMs}ms (maxTimeMS)`);
  }
  if (code === 11000 || /E11000/.test(message)) {
    return new Error('[MongoDB duplicate key] A document with the same unique key already exists.');
  }
  if (/Sort exceeded memory limit/.test(message)) {
    return new Error('[MongoDB sort failed] Sort exceeded the 32MB memory limit. Add an index or narrow the filter.');
  }
  if (code === 26 || /ns not found/i.test(message)) {
    return new Error(`[MongoDB collection not found] ${message}`);
  }
  if (/not authorized/i.test(message)) {
    return new Error(`[MongoDB not authorized] ${message}`);
  }
  return new Error(`[MongoDB ${code ?? 'error'}] ${message}`);
}

export { DEFAULT_LIMIT, MAX_LIMIT };
