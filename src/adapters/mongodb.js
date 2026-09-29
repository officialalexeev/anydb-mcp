import { BaseAdapter, positiveInt, logCloseFailure } from '../core/base-adapter.js';
import { findWriteStage, TOO_DEEP } from '../core/safety.js';
import { MongoSchemaAdapter } from '../core/schema.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_DOCUMENT_BYTES = 1 * 1024 * 1024;

/**
 * How much of one oversized value survives.
 *
 * A document over MAX_DOCUMENT_BYTES is clipped per value rather than replaced
 * whole, so a 40 MB `history` array no longer costs the caller the `id` and
 * `email` sitting beside it in the same document.
 */
const MAX_VALUE_CHARS = 8 * 1024;

export const READ_ACTIONS = new Set(['find', 'count', 'distinct', 'aggregate', 'explain']);

export const ALL_ACTIONS = new Set([
  ...READ_ACTIONS, 'insert', 'update', 'updateOne', 'replace', 'delete', 'deleteOne',
]);

/** Actions that modify documents, one or many. */
const WRITE_ACTIONS = new Set(['insert', 'update', 'updateOne', 'replace', 'delete', 'deleteOne']);

/**
 * The *many-document* writes, where an empty filter is a whole collection.
 *
 *   - `deleteMany({})` and `updateMany({}, …)` match every document, so a caller
 *     that means "delete this one row" and writes `{}` has emptied a collection.
 *     Refused outright, and the message says what to write instead.
 *   - `deleteOne({})`, `updateOne({}, …)` and `replaceOne({}, …)` each touch one
 *     document whatever they match: the server picks it and there is no filter to
 *     get wrong.
 *
 * Refusing `{}` on the `*One` forms too would teach the exact behaviour the guard
 * exists to prevent — a caller told "empty filter refused" on `deleteOne` reaches
 * for `delete`, which is refused, or invents a filter it has no basis for. Both
 * are worse than the one document it was asking about.
 */
const MULTI_WRITE_ACTIONS = new Set(['update', 'delete']);

/** The single-document spelling of a `*Many` action, for a message that suggests one. */
const oneDocumentForm = (action) => {
  const found = [...WRITE_ACTIONS].find((name) => name.startsWith(action) && name !== action);
  return found ?? null;
};

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
    // The sentinel means the pipeline nests past the depth the walk follows: too
    // deep to verify, not free of a write stage. Interpolating it produced "the
    // (nesting limit exceeded) stage writes to a collection", which is nonsense to
    // whoever reads it. The refusal still stands; only the reason needed restating.
    if (stage === TOO_DEEP) {
      throw new Error(
        'This pipeline nests too deep for the write-stage check to verify, so it is refused. '
        + 'Flatten it, or set allowWriteStages: true if you are sure it only reads.'
      );
    }
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
  /**
   * @param {Function} [clientClass] - `mongodb`'s `MongoClient`, or a
   *   substitute. Left `undefined`, it is resolved on the first `connect()`.
   * @param {number} [timeout=30000]
   */
  constructor(clientClass = undefined, timeout = 30000) {
    super(5000, timeout);
    this.ClientClass = clientClass;
  }

  /**
   * The driver, loaded once, on first use.
   *
   * Not a module-scope import: the mongodb driver is the most expensive of the five
   * and the only one nobody can make work without, so a process that has never
   * touched a MongoDB should not pay to parse it. Loaded in `connect()` rather than
   * the constructor, which is synchronous, and rather than `execute()`, which is not
   * inside the registry's `timeout + grace` budget.
   */
  async loadMongoClient() {
    if (this.ClientClass === undefined) {
      this.ClientClass = (await import('mongodb')).MongoClient;
    }
    return this.ClientClass;
  }

  async connect(uri) {
    // Pinned explicitly, and **refused** when the URI names no database.
    //
    // `client.db()` with no argument falls back to the URI's path and then to the
    // server's default, so `mongodb://host:27017` reads whatever the server
    // happens to default to while the tool reports `databaseName: null` — a wrong
    // answer that is silent. Refused here, before a socket is opened, rather than
    // pinned to a guess.
    const name = databaseFromUri(uri);
    if (name === null) {
      throw new Error(
        '[MongoDB database] This URI names no database, so every command would go to whatever the '
        + 'server happens to default to while the tool reported none. Put it in the path: '
        + 'mongodb://host:27017/mydb'
      );
    }

    const ClientClass = await this.loadMongoClient();

    // The driver resolves `mongodb+srv://` itself, but SRV resolution is a DNS
    // round trip that happens *before* the connect, so a budget covering only the
    // socket would be spent before the driver opened one. The DNS resolver takes
    // no timeout of its own, so the connect budget covers it and the registry's
    // outer guard is what bounds a resolver that never answers.
    this.client = new ClientClass(uri, {
      serverSelectionTimeoutMS: this.connectTimeout,
      connectTimeoutMS: this.connectTimeout,
      // A bound on an *individual* operation, which `serverSelectionTimeoutMS` is
      // not: that one bounds picking a server. Without this a single aggregation
      // can hold a socket for as long as the server feels like.
      socketTimeoutMS: positiveInt(process.env.ANYDB_MONGO_SOCKET_TIMEOUT_MS, this.queryTimeout),
      // Bounded, like the other four. The driver defaults to 100 sockets per
      // server, which for a cached adapter shared by concurrent callers is a storm
      // waiting for a burst; and with `waitQueueTimeoutMS` at 0 (the driver
      // default) a caller waits in the queue forever.
      maxPoolSize: positiveInt(process.env.ANYDB_MONGO_POOL_MAX, DEFAULT_MONGO_POOL_MAX),
      minPoolSize: positiveInt(process.env.ANYDB_MONGO_POOL_MIN, 0),
      waitQueueTimeoutMS: positiveInt(
        process.env.ANYDB_MONGO_WAIT_QUEUE_MS,
        positiveInt(process.env.ANYDB_MONGO_POOL_MAX, DEFAULT_MONGO_POOL_MAX) * 1000
      ),
    });

    await this.client.connect();

    this.databaseName = name;
    this.db = this.client.db(name);
  }

  /**
   * @param {object} [options]
   * @param {string} [options.action] - One of `ALL_ACTIONS`.
   * @param {Array}  [options.params] - Accepted and ignored. A MongoDB payload is
   *   `JSON.parse`d and handed to a typed driver method, so there is no SQL text
   *   to interpolate a value into and nothing to bind.
   * @param {number} [options.maxRows] - Accumulate at most this many documents
   *   and mark the answer `truncated`.
   * @param {number} [options.limit]  - Ask the *server* for at most this many
   *   documents, where the action supports it. For `aggregate` this appends a
   *   `$limit` stage — see the note in runAggregation.
   * @param {number} [options.offset] - Skip this many documents.
   */
  async execute(query, options = {}) {
    const action = resolveAction(options.action);
    if (!options.collection) {
      throw new Error(`Collection name is required for the "${action}" action`);
    }
    const collection = this.db.collection(options.collection);
    const maxRows = readMaxRows(options.maxRows);

    // The shape of the call is checked before the driver is invoked, so an
    // argument problem is not reported as a server error.
    switch (action) {
      case 'find': {
        const filter = parseFilter(query);
        return this.guard(options, async () => this.find(collection, filter, options, maxRows));
      }
      case 'count': {
        const filter = parseFilter(query);
        return this.guard(options, async () => [{ count: await collection.countDocuments(filter) }]);
      }
      case 'distinct': {
        const field = requireOption(options, 'field', 'field name');
        const filter = parseFilter(query);
        return this.guard(options, async () => this.distinct(collection, field, filter, options, maxRows));
      }
      case 'aggregate': {
        const pipeline = parsePipeline(query, options);
        return this.guard(options, async () => this.runAggregation(collection, pipeline, options, maxRows));
      }
      case 'explain': {
        const filter = parseFilter(query);
        return this.guard(options, async () => [{ explain: await collection.find(filter).explain() }]);
      }
      case 'insert': {
        const docs = toDocuments(query);
        return this.guard(options, async () => toArray(await collection.insertMany(docs), INSERT_FIELDS));
      }
      case 'update': {
        const filter = parseFilter(query, 'update', { required: true });
        const update = parseDocument(
          requireOption(options, 'update', 'update document'),
          'update document'
        );
        const { upsert } = options;
        return this.guard(options, async () => toArray(
          await collection.updateMany(filter, update, { upsert: upsert === true }),
          UPDATE_FIELDS
        ));
      }
      case 'updateOne': {
        const filter = parseFilter(query, 'updateOne', { required: true });
        const update = parseDocument(
          requireOption(options, 'update', 'update document'),
          'update document'
        );
        const { upsert } = options;
        return this.guard(options, async () => toArray(
          await collection.updateOne(filter, update, { upsert: upsert === true }),
          UPDATE_FIELDS
        ));
      }
      case 'replace': {
        const filter = parseFilter(query, 'replace', { required: true });
        const document = parseDocument(requireOption(options, 'document', 'replacement document'), 'replacement document');
        const { upsert } = options;
        return this.guard(options, async () => toArray(
          await collection.replaceOne(filter, document, { upsert: upsert === true }),
          REPLACE_FIELDS
        ));
      }
      case 'delete': {
        const filter = parseFilter(query, 'delete', { required: true });
        return this.guard(options, async () => toArray(await collection.deleteMany(filter), DELETE_FIELDS));
      }
      case 'deleteOne': {
        const filter = parseFilter(query, 'deleteOne', { required: true });
        return this.guard(options, async () => toArray(await collection.deleteOne(filter), DELETE_FIELDS));
      }
      default:
        throw new Error(`Unsupported MongoDB action "${action}"`);
    }
  }

  /** Runs a driver call, translating only genuine server errors. */
  async guard(options, work) {
    try {
      return await work();
    } catch (err) {
      throw describeMongoError(err, this.resolveQueryTimeout(options));
    }
  }

  async find(collection, filter, options, maxRows) {
    const cursor = collection.find(filter);
    cursor.limit(resolveLimit(options.limit));
    if (offsetOf(options) > 0) cursor.skip(offsetOf(options));
    if (options.sort) cursor.sort(parseDocument(options.sort, 'sort'));
    if (options.projection) cursor.project(parseDocument(options.projection, 'projection'));

    return this.collect(cursor, maxRows, { maxTimeMS: this.resolveQueryTimeout(options) });
  }

  /**
   * Bounded accumulation from a cursor, and the reason the `find` and `aggregate`
   * actions are capped without a `$limit`.
   *
   * A cursor is a server-side handle: the driver fetches one batch at a time, so
   * reading `maxRows + 1` documents and stopping bounds this process completely
   * while leaving the pipeline untouched. The extra document is what makes
   * `truncated` a fact rather than a guess, and makes a truncated answer a
   * *prefix* rather than a sample.
   */
  async collect(cursor, maxRows, { maxTimeMS } = {}) {
    if (maxTimeMS) cursor.maxTimeMS?.(maxTimeMS);

    if (maxRows === null) {
      return truncateDocuments(await cursor.toArray());
    }

    const rows = [];
    let truncated = false;

    try {
      for (;;) {
        const document = await cursor.next();
        if (document === null || document === undefined) break;
        if (rows.length < maxRows) rows.push(document);
        else {
          truncated = true;
          break;
        }
      }
    } finally {
      // Stop the server's cursor. Without this the server keeps the result set
      // alive, and on a large aggregation that is a server-side cursor held open
      // until its own timeout expires.
      await cursor.close?.().catch?.(() => {});
    }

    return markTruncated(truncateDocuments(rows), truncated);
  }

  async runAggregation(collection, pipeline, options, maxRows) {
    const limit = explicitLimit(options.limit);
    const offset = offsetOf(options);

    // `options.limit` becomes a `$limit` stage, and only when the caller wrote it.
    // Injecting one *unasked* changes what the pipeline means: after a `$sort` it
    // changes the answer, since the first N sorted rows are not the first N in
    // arrival order, so a cap advertised as "the same query, fewer rows" would
    // quietly be a different query. After `$out`/`$merge` it changes nothing.
    //
    // So a limit the caller wrote is honoured as a stage, and the cap that is always
    // on is applied to what is *collected*, which bounds this process without
    // touching the server's computation. `maxTimeMS` is what bounds the server.
    const stages = [...pipeline];
    if (limit > 0) stages.push({ $limit: limit });
    if (offset > 0) stages.push({ $skip: offset });

    const cursor = collection.aggregate(stages, {
      maxTimeMS: this.resolveQueryTimeout(options),
      allowDiskUse: false,
    });

    return this.collect(cursor, maxRows, { maxTimeMS: this.resolveQueryTimeout(options) });
  }

  /**
   * `distinct`, bounded.
   *
   * The driver has no streaming form and no limit option, so the value list
   * arrives whole and is capped here. `maxTimeMS` is the only thing that bounds
   * the *work*: on a high-cardinality field over a large collection `distinct`
   * can be the most expensive read in the tool, and there is no way to page it.
   */
  async distinct(collection, field, filter, options, maxRows) {
    const values = await collection.distinct(field, filter, { maxTimeMS: this.resolveQueryTimeout(options) });
    if (maxRows === null) return values;
    return markTruncated(values.slice(0, maxRows), values.length > maxRows);
  }

  describe(options = {}) {
    const schema = new MongoSchemaAdapter(this.connectTimeout, this.resolveQueryTimeout(options));
    schema.client = this.client;
    // The pinned Db, not the client. `MongoClient.prototype.db` is a *method*, so
    // a schema scan reaching through `client.db` called `listCollections` on a
    // function — a TypeError on every `db_schema` call against a real server,
    // which no double reproduced.
    schema.db = this.db;
    // db_schema asks this describer too, so the two tools agree.
    schema.describeError = (err) => this.describeError(err, schema.queryTimeout);
    return schema.describe(options);
  }

  /** Reads the driver's own topology state, so no round trip. */
  isHealthy() {
    return !!this.client && this.client.topology?.isConnected?.() === true;
  }

  /**
   * Name the failure the server actually reported, for `db_schema` as well as
   * `db_query`. The schema adapter is handed this so the two tools agree.
   */
  describeError(err, timeout = this.queryTimeout) {
    return describeMongoError(err, timeout);
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
        try {
          logCloseFailure('mongodb', err, { aborted: this.aborted });
        } catch {
          // Degraded logging is still better than a close() that throws.
        }
      }
    }
  }
}

/** The driver's own default is 100 sockets per server; ours is four. */
const DEFAULT_MONGO_POOL_MAX = 4;

/**
 * The database name in the URI, or null when there is none.
 *
 * `mongodb://host/db` → `db`; `mongodb://host` → null, in which case the driver
 * picks the server's default and this server says so rather than pretending
 * otherwise.
 */
function databaseFromUri(uri) {
  // The scheme and the query string go; what is left is `host:port/db`, so the
  // name is whatever follows the first slash. Slicing by *position* rather than
  // by the index of `://` is the obvious mistake here, and it yields the host
  // and the port as the database name — a database that does not exist.
  const rest = String(uri ?? '')
    .replace(/^mongodb\+srv:\/\//i, '')
    .replace(/^mongodb:\/\//i, '')
    .split(/[?#]/)[0];

  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const name = rest.slice(slash + 1);
  return name === '' ? null : decodeURIComponent(name);
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

  /**
   * A write filter, which has to be a JSON object and, for the many-document
   * actions, has to say what it matches. The empty-filter rule is on
   * `MULTI_WRITE_ACTIONS`; this is the enforcement.
   *
   * A *missing* filter is a separate rule and holds for every write, `*One`
   * included: "change some document" with no filter at all is an omission, and the
   * answer to an omission is a question rather than an execution.
   *
   * @param {string} query - The filter as JSON
   * @param {string} [action='find'] - The action, which decides the rule
   * @param {object} [options]
   * @param {boolean} [options.required=false] - Refuse a missing filter as well
   */
function parseFilter(query, action = 'find', { required = false } = {}) {
  if (query === undefined || query === null || query === '') {
    if (!required) return {};
    const single = oneDocumentForm(action);
    if (MULTI_WRITE_ACTIONS.has(action) && single) {
      throw new Error(
        `The "${action}" action needs a filter. An empty filter matches every document in the collection, so it is `
        + `refused. Use {"action":"${single}"} to change one document, or narrow the filter to the documents you mean.`
      );
    }
    throw new Error(
      `The "${action}" action needs a filter, for example {"_id": 42} or {"status":"draft"}. `
      + 'It is the field that says which document to change; without it there is nothing to match against. '
      + 'Pass {} to let the server choose a document.'
    );
  }

  let filter;
  try {
    filter = JSON.parse(query);
  } catch (err) {
    throw new Error(`MongoDB filter is not valid JSON: ${err.message}`);
  }
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error('MongoDB filter must be a JSON object, for example {} or {"status":"active"}.');
  }
  if (MULTI_WRITE_ACTIONS.has(action) && Object.keys(filter).length === 0) {
    const single = oneDocumentForm(action);
    const alternative = single ? `, or use "${single}" to change a single document` : '';
    throw new Error(
      `Refused: an empty filter with the "${action}" action matches every document in the collection`
      + `${alternative}. Add the field you mean.`
    );
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
const REPLACE_FIELDS = ['acknowledged', 'matchedCount', 'modifiedCount', 'upsertedId'];
const DELETE_FIELDS = ['acknowledged', 'deletedCount'];

/**
 * Keep a document that is too large to return whole, but keep most of it.
 *
 * Size is estimated from the value types rather than measured with
 * `JSON.stringify`, because the envelope stringifies again and the old code
 * serialised every document twice on the hot path. It is an estimate, and the point
 * is not the exact byte count but deciding whether to clip.
 *
 * The clip is per value: replacing the whole document with `{_truncated, _bytes,
 * _keys}` left the caller with field names and no values, so the only honest next
 * step was to re-query.
 */
function truncateDocuments(docs) {
  return docs.map(clipDocument);
}

function clipDocument(doc) {
  if (doc === null || typeof doc !== 'object') return doc;

  let size = 0;
  let oversized = false;
  for (const [key, value] of Object.entries(doc)) {
    const weight = weightOf(value);
    size += key.length + weight;
    if (weight > MAX_VALUE_CHARS) oversized = true;
  }
  // A Buffer is not a plain object and must not be walked.
  if (ArrayBuffer.isView(doc)) return doc;
  if (!oversized && size <= MAX_DOCUMENT_BYTES) return doc;

  const out = { _truncated: true, _estimatedBytes: size };
  for (const [key, value] of Object.entries(doc)) {
    out[key] = clipValue(value, key);
  }
  return out;
}

function clipValue(value, key) {
  if (typeof value === 'string' && value.length > MAX_VALUE_CHARS) {
    return {
      _clipped: key,
      _chars: value.length,
      _preview: `${value.slice(0, MAX_VALUE_CHARS)}…`,
    };
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength <= MAX_VALUE_CHARS) return value;
    return { _clipped: key, _bytes: value.byteLength };
  }
  if (Array.isArray(value) && value.length > 32) {
    return {
      _clipped: key,
      _length: value.length,
      _first: value.slice(0, 8).map((entry) => clipValue(entry, key)),
    };
  }
  return value;
}

/** A constant-time estimate of what a value costs, with no serialisation. */
function weightOf(value) {
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (value === null || value === undefined) return 4;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((total, entry) => total + weightOf(entry) + 1, 2);
  if (value instanceof Date) return 24;
  if (typeof value === 'object') return Object.keys(value).reduce((total, key) => total + key.length + 1, 2);
  return 8;
}

/** The cap, or null for "no cap". `maxRows: 0` means no cap, not "no rows". */
function readMaxRows(maxRows) {
  const n = Number(maxRows);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function offsetOf(options) {
  const n = Number(options.offset);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function resolveLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`MongoDB limit must be a positive number, got ${JSON.stringify(limit)}.`);
  }
  return Math.min(Math.trunc(parsed), MAX_LIMIT);
}

/** The same bound, but 0 when the caller named none. See runAggregation. */
function explicitLimit(limit) {
  if (limit === undefined || limit === null) return 0;
  return resolveLimit(limit);
}

/**
 * Mark a result as a prefix of the answer. See `markTruncated` in postgres.js:
 * a truncated answer is a partial answer, and the caller has to be able to tell.
 */
function markTruncated(rows, truncated) {
  if (truncated) {
    Object.defineProperty(rows, 'truncated', { value: true, enumerable: false, configurable: true });
    Object.defineProperty(rows, 'limitReason', { value: 'maxRows', enumerable: false, configurable: true });
  }
  return rows;
}

/**
 * A server error, rewritten to say something a caller can act on.
 *
 * The code and the cause survive, and that is the part that matters. Every branch
 * used to `return new Error('…')` and nothing else, throwing away MongoDB's own
 * code: `50` identifies a `maxTimeMS` abort, `11000` a duplicate key, `26` a
 * missing namespace. Without it, `registry.isTimeoutError()` could only recognise a
 * timeout by matching English phrasings this function had written.
 *
 * @param {Error|object} err
 * @param {number} timeoutMs - The caller's budget, for the timeout message
 */
function describeMongoError(err, timeoutMs) {
  const message = (err && err.message) || String(err);
  const code = err && err.code;

  if (code === 50 || /timed out|execution time limit exceeded/i.test(message)) {
    return described(new Error(`[MongoDB timeout] Query exceeded ${timeoutMs}ms (maxTimeMS)`), err, 50);
  }
  if (code === 11000 || /E11000/.test(message)) {
    return described(new Error('[MongoDB duplicate key] A document with the same unique key already exists.'), err, 11000);
  }
  if (/Sort exceeded memory limit/.test(message)) {
    return described(new Error('[MongoDB sort failed] Sort exceeded the 32MB memory limit. Add an index or narrow the filter.'), err, code);
  }
  if (code === 26 || /ns not found/i.test(message)) {
    return described(new Error(`[MongoDB collection not found] ${message}`), err, code ?? 26);
  }
  if (/not authorized/i.test(message)) {
    return described(new Error(`[MongoDB not authorized] ${message}`), err, code);
  }
  return described(new Error(`[MongoDB ${code ?? 'error'}] ${message}`), err, code);
}

/**
 * Attach what the driver said to the sentence this module wrote. `code` is copied
 * rather than interpolated so a caller can branch on it, which is what
 * `ERROR_FIELD` in `core/tools.js` promises. `cause` is the original, so a stack
 * trace still points at the driver.
 */
function described(error, cause, code) {
  if (cause instanceof Error) {
    Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
  }
  if (code !== undefined && code !== null) error.code = code;
  return error;
}

export { DEFAULT_LIMIT, MAX_LIMIT };
