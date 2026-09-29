/**
 * Tool definitions and the argument validator.
 *
 * Both live outside `src/index.js` so a schema can be asserted without
 * spawning a child process, and so `additionalProperties: false` means
 * something: the low-level MCP `Server` validates the request and result
 * envelopes, never the arguments, so `validateArgs` below is the enforcement.
 *
 * The validator is hand-rolled because ajv is only a transitive dependency of
 * the SDK, and this file has to keep working when the package is published and
 * hoisting changes. The subset of JSON Schema the tool surface needs is about a
 * hundred lines; `test_tools.test.js` covers it.
 *
 * TOKEN BUDGET
 *
 * Every `tools/list` response is paid for on every request, by every model,
 * before anything useful has happened, so descriptions state what changes what
 * a model does and leave the rest to the schema. Two consequences: `title` sits
 * at the top level rather than duplicated inside `annotations`, where it would
 * take display precedence; and no number is ever written into prose — each is
 * interpolated from the constant the server enforces, and `test_tools.test.js`
 * fails the build if a description carries a digit with no constant behind it.
 */

import * as registryModule from './registry.js';
import * as resultLimits from './result-limits.js';
import * as mongoAdapterModule from '../adapters/mongodb.js';
import { POLICY_DEFAULTS } from './policy.js';
import { MONGO_ACTIONS as GUARDED_MONGO_ACTIONS } from './safety.js';

/**
 * The statement timeout a call gets when it does not ask for one.
 *
 * Read out of `registry.js` through a namespace import on purpose: a *named*
 * import of a constant that disappears is a `SyntaxError` at module link time,
 * which would take the whole server down over a number in a description. A
 * namespace property that is `undefined` degrades to the policy default instead.
 */
export const DEFAULT_TIMEOUT = Number.isFinite(registryModule.DEFAULT_TIMEOUT)
  ? registryModule.DEFAULT_TIMEOUT
  : POLICY_DEFAULTS.queryTimeoutMs;

/**
 * Bounds the timeout is checked against, by `validateArgs` *and* independently by
 * `registry.js`'s `validateTimeout`. Two gates deliberately: the schema gate
 * produces a message a model can act on, the registry gate is the one still in
 * force for a caller that reaches the registry without going through this file.
 */
export const MIN_TIMEOUT = 1;
export const MAX_TIMEOUT = 24 * 60 * 60 * 1000;

/**
 * Row and byte caps. Defaults come from `./result-limits.js`, which is where
 * `clampResult` applies them; the ceilings have no exported constant because
 * `profiles.js` clamps to a private cap of its own, so they are stated here.
 */
export const DEFAULT_MAX_ROWS = resultLimits.DEFAULT_MAX_ROWS;
export const MAX_MAX_ROWS = 1000000;
export const DEFAULT_MAX_BYTES = resultLimits.DEFAULT_MAX_BYTES;
export const MAX_MAX_BYTES = 64 * 1024 * 1024;

/**
 * MongoDB's `limit`, read from the adapter rather than restated: `limit` is the
 * one argument `db_query` hands straight to a driver cursor.
 */
export const MONGO_DEFAULT_LIMIT = Number.isFinite(mongoAdapterModule.DEFAULT_LIMIT)
  ? mongoAdapterModule.DEFAULT_LIMIT
  : 50;
export const MONGO_MAX_LIMIT = Number.isFinite(mongoAdapterModule.MAX_LIMIT)
  ? mongoAdapterModule.MAX_LIMIT
  : 1000;

/**
 * Every number a description is allowed to contain. `test_tools.test.js` walks the
 * whole `tools/list` payload and checks each digit against this set.
 */
export const LIMITS = Object.freeze({
  timeout: Object.freeze({ min: MIN_TIMEOUT, max: MAX_TIMEOUT, default: DEFAULT_TIMEOUT }),
  rows: Object.freeze({ default: DEFAULT_MAX_ROWS, max: MAX_MAX_ROWS }),
  bytes: Object.freeze({ default: DEFAULT_MAX_BYTES, max: MAX_MAX_BYTES }),
  mongoLimit: Object.freeze({ default: MONGO_DEFAULT_LIMIT, max: MONGO_MAX_LIMIT }),
});

/**
 * MongoDB actions, in the order the read-only guard defines them: reads, then
 * writes. Taken from `safety.js` so the `enum` a model reads and the set the guard
 * enforces cannot be two lists.
 */
export const MONGO_ACTIONS = Object.freeze([...GUARDED_MONGO_ACTIONS]);

/**
 * Output renderings, read from `./result-limits.js`, which is where `formatRows`
 * and `registry.validateScalars` both check them.
 */
export const FORMATS = Object.freeze([...resultLimits.RESULT_FORMATS]);

/** `db_schema`'s two depths. `schema.js` refuses anything else. */
export const DETAILS = Object.freeze(['summary', 'full']);

/**
 * The `profile` / `uri` rule, said once because it is serialised four times over
 * on every `tools/list`. A raw `uri` puts the plaintext password into the model's
 * context window, the JSON-RPC frame and the client's persisted transcript — OWASP
 * `MCP01:2025`. Naming a profile is the fix; the ad-hoc URI is the fallback for a
 * machine with no config file.
 */
const TARGET_HELP =
  'Exactly one of "profile" (a name from db_list) or "uri" (an ad-hoc connection string). '
  + 'Prefer "profile": it keeps the password out of the transcript.';

/**
 * The connection-string shape, for the four tools that accept a raw `uri`. No port
 * number in the example: the shape is what the model needs, and the default port
 * is the driver's business.
 */
const URI_HELP =
  'Connection string, for example postgres://user@host/db, mysql://user@host/db, '
  + 'sqlite:///path/to/app.db, mongodb://host/db or redis://host. Pass "profile" wherever db_list shows one.';

/** `timeout` is declared identically four times; the text is built once. */
const timeoutProperty = (what) => ({
  type: 'integer',
  default: DEFAULT_TIMEOUT,
  minimum: MIN_TIMEOUT,
  maximum: MAX_TIMEOUT,
  description: `Milliseconds before giving up on ${what} (default ${DEFAULT_TIMEOUT}, between ${MIN_TIMEOUT} and ${MAX_TIMEOUT}).`,
});

const profileProperty = () => ({
  type: 'string',
  minLength: 1,
  maxLength: 256,
  description: 'A profile name from db_list. ' + TARGET_HELP,
});

const uriProperty = () => ({
  type: 'string',
  minLength: 1,
  maxLength: 2048,
  description: URI_HELP,
});

/** `params` is the anti-injection argument, so it gets more than one line. */
const paramsProperty = () => ({
  type: 'array',
  maxItems: 1000,
  items: { type: ['string', 'number', 'boolean', 'null'] },
  description:
    'Values bound to placeholders in "query" instead of pasted into it: ? for MySQL and SQLite, $n for '
    + 'PostgreSQL. Prefer this: a bound value never reaches the statement text, the log, or a plan cache. SQL only.',
});

/**
 * The result envelope. Built by `./core/result-limits.js`, returned by
 * `registry.js` from every tool, and required to be an object: the MCP spec types
 * `structuredContent` as a record whenever a tool declares an `outputSchema`.
 * `ok` and `error` are added on top by `src/index.js`, so one schema covers a
 * success and a failure.
 *
 * Most fields carry no description: this block is serialised four times over on
 * every `tools/list`. The field-by-field explanation lives in the server's
 * `instructions`, read once per session; `ok`, `rows` and `truncated` stay
 * described because they change what a model should do next.
 */
const ENVELOPE_PROPERTIES = {
  ok: { type: 'boolean', description: 'False when the call failed; read "error" then.' },
  rows: { type: ['array', 'object', 'null'], description: 'The result. Null if a result limit dropped it.' },
  rowCount: { type: 'integer' },
  truncated: { type: 'boolean', description: 'True when a limit removed something: the result is a prefix, not the answer.' },
  bytes: { type: 'integer' },
  elapsedMs: { type: 'number' },
  profile: { type: ['string', 'null'] },
  driver: { type: ['string', 'null'] },
  limitReason: { type: ['string', 'null'], description: 'maxRows or maxBytes, when the result was truncated.' },
  nextCursor: {},
  timezone: { type: ['string', 'null'] },
  hint: { type: ['string', 'null'] },
  format: { type: 'string', enum: [...FORMATS], description: 'Rendering used for the text content block.' },
};

const ENVELOPE_REQUIRED = Object.freeze([
  'ok', 'rows', 'rowCount', 'truncated', 'bytes', 'elapsedMs', 'format',
]);

/**
 * The `error` member of a failed call. `kind` is a category; `code` is the fact.
 *
 * `destructive` is in the `kind` enum although the registry never emits it: it
 * raises a destructive refusal as `{ kind: 'policy', code: 'DESTRUCTIVE' }`, and
 * `src/index.js`'s `classify()` promotes on `code` before reading `kind`, because
 * the category a model should act on differs from the one the refusal belongs to.
 * Do not delete the member without changing `classify()` first.
 *
 * `code` and `operation` are here because a model needs them: a driver code
 * (`42P01`, `SQLITE_BUSY`) is the one field that is stable across versions and
 * answers "does this retry?", where the prose does not. Neither is required —
 * `error` is present only when `ok` is false, and not every failure has a code.
 */
const ERROR_FIELD = {
  type: 'object',
  description: 'Present only when "ok" is false.',
  properties: {
    kind: {
      type: 'string',
      enum: ['validation', 'policy', 'timeout', 'destructive', 'serialization', 'database', 'internal'],
      description: 'validation: the arguments are wrong. timeout: it ran too long. policy: a read-only or '
        + 'allowlist rule refused it. destructive: a policy refusal whose "code" is DESTRUCTIVE. '
        + 'serialization: the result could not go on the wire. database: the driver.',
    },
    message: { type: 'string' },
    suggestion: { type: 'string', description: 'The next step to try.' },
    // `null` is in the type because `src/index.js`'s `errorField` emits
    // `code: null` on a failure that has none, so the property exists on every
    // failure and a client can read it without an `in` check. `operation` below
    // is typed the same way. Nothing validates `structuredContent` against this
    // schema server-side, so a declared type the producer does not honour only
    // shows up in a client that builds a validator — and it would reject every
    // policy refusal.
    code: {
      type: ['string', 'number', 'null'],
      description: 'Driver code (42P01, SQLITE_BUSY) or policy code (DESTRUCTIVE), or null when there is none.',
    },
    operation: { type: ['string', 'null'], description: 'The tool that failed.' },
    details: { type: 'array', items: { type: 'string' }, description: 'One line per argument problem.' },
  },
  required: ['kind', 'message', 'suggestion'],
};

/**
 * Every `kind` this schema can carry, exported so the test can assert the enum
 * against the registry's `ERROR_KINDS` plus the promotions below. An unlisted
 * `kind` is a hard validation failure for a client that checks
 * `structuredContent`.
 */
export const ERROR_FIELD_KINDS = Object.freeze(Object.freeze(
  ERROR_FIELD.properties.kind.enum
));

/**
 * `kind` values that are NOT in `registry.js`'s `ERROR_KINDS`, and the code that
 * promotes each one. A non-empty list is the honest record of the gap.
 */
export const ERROR_KIND_PROMOTIONS = Object.freeze({
  destructive: 'DESTRUCTIVE',
});

/**
 * Every error code this server raises itself, as opposed to a driver's — the
 * vocabulary an agent is invited to branch on. Not a runtime check: a driver can
 * raise anything.
 */
export const POLICY_ERROR_CODES = Object.freeze([
  'READ_ONLY', 'CODE_EXECUTION', 'DESTRUCTIVE', 'SCHEMA_NOT_ALLOWED', 'TABLE_NOT_ALLOWED',
  'CONNECTION_POLICY', 'ADHOC_URI_DISABLED', 'INVALID_TIMEOUT', 'PROFILE_UNAVAILABLE',
]);

/**
 * @typedef {object} Tool
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {object} inputSchema
 * @property {object} outputSchema
 * @property {object} annotations
 */

/**
 * Freeze a value and everything under it. `ListTools` returns this array by
 * reference, which only holds if nothing can reach in and edit it.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** @type {readonly Tool[]} */
export const TOOLS = deepFreeze([
  {
    name: 'db_list',
    title: 'List connection profiles',
    description:
      'List the connection profiles from the anydb config file (~/.anydb/db.json): name, description, driver, '
      + 'which one is the default, and whether it is read-only. Call this first whenever you do not already know '
      + 'a profile name, then pass the name to the other tools as "profile". The result never contains a '
      + 'connection string, a host, a username or a password -- not masked, absent -- because this text goes into '
      + 'your context window and a config file is writable by anyone who can write files. If there is no config '
      + 'file, use "uri" with the other tools instead.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', description: 'False when the call failed; read "error" then.' },
        configSource: { type: ['string', 'null'], description: 'Path of the config file read, or null.' },
        profiles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              driver: { type: ['string', 'null'] },
              default: { type: 'boolean' },
              readOnly: { type: 'boolean' },
            },
            required: ['name', 'description', 'driver', 'default', 'readOnly'],
          },
          description: 'The profiles, default first. Never a URI, a host or a credential.',
        },        message: { type: 'string', description: 'Present when there is nothing to list.' },
      },
      required: ['ok', 'configSource', 'profiles'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  {
    name: 'db_query',
    title: 'Run a database query',
    description:
      'Run one statement against one database (PostgreSQL, MySQL/MariaDB, SQLite, MongoDB or Redis, inferred from the '
      + 'connection). READ-ONLY BY DEFAULT: writes are refused unless "readOnly" is false, and statements that change '
      + 'schema or privileges additionally require "allowDestructive" to be true. Call db_list and db_schema first so '
      + 'table and column names are not guessed, and prefer "params" over inlining values in "query" so the values '
      + 'never appear in the statement text. Put a LIMIT in every query: results are capped anyway, and a cap you did '
      + 'not ask for is how a table gets silently half-read. MongoDB: "collection" is required and "action" picks the '
      + 'operation -- find, count, distinct, aggregate and explain read; insert, update, updateOne, replace, delete and '
      + 'deleteOne write and need "readOnly": false. Prefer the *One actions: one document, not every match. Redis: '
      + '"query" is a single command such as GET or SCAN.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: profileProperty(),
        uri: uriProperty(),
        query: {
          type: 'string',
          minLength: 1,
          // A statement of nothing but whitespace is a mistake, and `minLength`
          // cannot see it. The pattern is the schema saying so.
          pattern: '\\S',
          maxLength: 200000,
          description: 'One statement only: SQL, a MongoDB filter (JSON object), a MongoDB aggregation pipeline '
            + '(JSON array), or a single Redis command. Multiple statements separated by ";" are refused.',
        },
        params: paramsProperty(),
        collection: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'MongoDB only. Required for every MongoDB action.',
        },
        action: {
          type: 'string',
          enum: [...MONGO_ACTIONS],
          default: 'find',
          description: 'MongoDB only. Reads: find (default), count, distinct, aggregate, explain. Writes: insert, '
            + 'update, updateOne, replace, delete, deleteOne, which need "readOnly": false. "explain" returns the '
            + 'planner output and never runs it. The *One actions touch one document and accept an empty filter; the '
            + 'plural ones refuse one, because there it means the whole collection.',
        },
        update: {
          type: 'string',
          maxLength: 100000,
          description: 'MongoDB only, action "update" or "updateOne". The update document as JSON, for example '
            + '{"$set":{"seen":true}}. "update" applies it to every match, "updateOne" to the first.',
        },
        document: {
          type: 'string',
          maxLength: 100000,
          description: 'MongoDB only, action "replace". The replacement document as JSON, for example {"name":"x"}. '
            + 'It replaces the matched document whole, so fields it omits are gone.',
        },
        field: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'MongoDB only, action "distinct". The field whose distinct values are wanted.',
        },
        sort: {
          type: 'string',
          maxLength: 10000,
          description: 'MongoDB only, action "find". Sort document as JSON, for example {"createdAt":-1}.',
        },
        projection: {
          type: 'string',
          maxLength: 10000,
          description: 'MongoDB only, action "find". Fields to return as JSON, for example {"name":1,"email":1}.',
        },
        upsert: {
          type: 'boolean',
          default: false,
          description: 'MongoDB only, action "update", "updateOne" or "replace". Insert when nothing matches.',
        },
        allowWriteStages: {
          type: 'boolean',
          default: false,
          description: 'MongoDB only, action "aggregate". Permit $out and $merge, which replace a collection.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MONGO_MAX_LIMIT,
          default: MONGO_DEFAULT_LIMIT,
          description: `MongoDB only. Documents to return, at most ${MONGO_MAX_LIMIT}; defaults to ${MONGO_DEFAULT_LIMIT}.`,
        },
        // MongoDB-only, and the descriptions have to say so: nothing verifies a
        // description against what an adapter does with the value, so claiming
        // SQL support here would produce a model that believes it is paginating
        // while it silently re-reads page one.
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: 1000000,
          description: 'MongoDB only. Documents to skip, for pagination. Not used by PostgreSQL, MySQL, SQLite or Redis -- put an OFFSET or a keyset predicate in "query" for those.',
        },
        cursor: {
          type: 'string',
          maxLength: 4096,
          description: 'MongoDB only. An opaque resume token from a previous result\'s "nextCursor". Not used by PostgreSQL, MySQL, SQLite or Redis.',
        },
        readOnly: {
          type: 'boolean',
          default: true,
          description: 'True (the default) allows only reads. False permits writes to existing data.',
        },
        allowDestructive: {
          type: 'boolean',
          default: false,
          description: 'The second gate. With "readOnly": false, required for schema and grant changes (CREATE, '
            + 'ALTER, DROP, TRUNCATE, GRANT, REVOKE) and for MongoDB $out/$merge. Two flags from one caller is a weak '
            + 'boundary; the control that holds is a database role without those privileges.',
        },
        format: {
          type: 'string',
          enum: [...FORMATS],
          default: 'json',
          description: 'How rows are rendered as text. "json" is an array of objects; "jsonl" is one object per line '
            + 'and cheapest for many wide rows; "csv", "tsv" and "markdown" are tables.',
        },
        timeout: timeoutProperty('the statement'),
        maxRows: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_MAX_ROWS,
          default: DEFAULT_MAX_ROWS,
          description: `Rows to return at most (default ${DEFAULT_MAX_ROWS}, ceiling ${MAX_MAX_ROWS}). The response says whether anything was dropped.`,
        },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_MAX_BYTES,
          default: DEFAULT_MAX_BYTES,
          description: `Bytes of result to return at most (default ${DEFAULT_MAX_BYTES}, ceiling ${MAX_MAX_BYTES}).`,
        },
      },
      // The profile/uri xor is not expressible here, and `validateArgs` produces a
      // better message than a JSON pointer would.
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        ...ENVELOPE_PROPERTIES,
        error: ERROR_FIELD,
      },
      required: [...ENVELOPE_REQUIRED],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      // Two identical calls can differ: the result is whatever the database holds
      // right now. Clients use this to decide whether a retry is automatic.
      openWorldHint: true,
    },
  },

  {
    name: 'db_schema',
    title: 'Describe the database structure',
    description:
      'Describe the structure of a database: tables and their columns for SQL, collections with their indexes for '
      + 'MongoDB, keyspace statistics for Redis. Call it before writing a query so names are not guessed -- it is '
      + 'almost always cheaper than a failed query. Runs read-only introspection statements only, never a statement of '
      + 'yours, and "table"/"collection" are bound as parameters wherever the driver allows rather than pasted into '
      + 'SQL. "detail": "full" adds foreign keys, index definitions, primary and unique constraints, row estimates, '
      + 'and inferred field schemas for MongoDB.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: profileProperty(),
        uri: uriProperty(),
        table: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'SQL only. Describe just this table. A name that is not an identifier yields no tables '
            + 'rather than being executed.',
        },
        collection: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'MongoDB only. Describe just this collection.',
        },
        detail: {
          type: 'string',
          enum: [...DETAILS],
          default: 'summary',
          description: '"summary" (default) lists objects and columns. "full" adds constraints, indexes, foreign '
            + 'keys and row estimates -- larger, and worth it before writing anything.',
        },
        timeout: timeoutProperty('the introspection'),
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: ENVELOPE_PROPERTIES.ok,
        database: { type: 'string', description: 'Driver that answered, for example "sqlite".' },
        tables: { type: 'array', items: { type: 'object' }, description: 'SQL tables, views and columns.' },
        collections: { type: 'array', items: { type: 'object' }, description: 'MongoDB collections and indexes.' },
        keyspace: { type: 'array', items: { type: 'object' }, description: 'Redis keyspace statistics.' },
        detail: { type: 'string', enum: [...DETAILS] },
        rowCount: ENVELOPE_PROPERTIES.rowCount,
        truncated: ENVELOPE_PROPERTIES.truncated,
        bytes: ENVELOPE_PROPERTIES.bytes,
        elapsedMs: ENVELOPE_PROPERTIES.elapsedMs,
        profile: ENVELOPE_PROPERTIES.profile,
        driver: ENVELOPE_PROPERTIES.driver,
        limitReason: ENVELOPE_PROPERTIES.limitReason,
        hint: ENVELOPE_PROPERTIES.hint,
        error: ERROR_FIELD,
      },
      required: ['ok', 'database', 'rowCount', 'truncated', 'bytes', 'elapsedMs'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  {
    name: 'db_explain',
    title: 'Explain a query plan',
    description:
      'Return the execution plan for a statement WITHOUT running it. Read-only by construction: the statement is '
      + 'planned and not executed, so this is the safe way to catch a sequential scan over a large table and the '
      + 'cheapest way to find a missing index. ANALYZE variants are refused here on purpose, because "EXPLAIN ANALYZE" '
      + 'runs the statement it plans. MongoDB: pass "collection" and a find filter as "query"; a pipeline cannot be '
      + 'explained, use db_query action "aggregate" with a small limit. Redis has no plans, so this tool refuses it.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: profileProperty(),
        uri: uriProperty(),
        query: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          maxLength: 200000,
          description: 'The statement to plan, without a leading EXPLAIN: this tool adds the right prefix per '
            + 'dialect. Passing EXPLAIN yourself is refused, and so is EXPLAIN ANALYZE in any spelling. For MongoDB it '
            + 'is the find filter as JSON.',
        },
        collection: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'MongoDB only, and required there: a plan is a plan for one collection. Ignored elsewhere, '
            + 'where the statement names its own tables.',
        },
        params: paramsProperty(),
        timeout: timeoutProperty('the planner'),
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        // The same envelope `db_query` returns: `rows` *is* the plan, so there is no
        // second `plan` key.
        ...ENVELOPE_PROPERTIES,
        error: ERROR_FIELD,
      },
      required: [...ENVELOPE_REQUIRED],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  {
    name: 'db_health',
    title: 'Check the connection and its privileges',
    description:
      'Ask the database about itself: reachable or not, server version, the role this server authenticated as, '
      + 'whether that role or the server is read-only, object counts, and this server\'s pool and cache state. Use it '
      + 'instead of guessing at why a connection or a write failed. Note what "readOnly": false does and does not do: '
      + 'it is a request to THIS server, not a security boundary. The boundary is the database role -- a role holding '
      + 'INSERT will succeed whatever these flags say, and a role without them will fail however many are set.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: profileProperty(),
        uri: uriProperty(),
        timeout: timeoutProperty('the diagnostics'),
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: ENVELOPE_PROPERTIES.ok,
        reachable: { type: 'boolean', description: 'False when no connection could be made at all.' },
        database: { type: 'string', description: 'Driver that answered.' },
        serverVersion: { type: ['string', 'null'] },
        role: { type: ['string', 'null'], description: 'The database user this server authenticated as.' },
        readOnlyRole: { type: ['boolean', 'null'], description: 'Whether the role and the server together look '
          + 'read-only, from a read-only probe. Null when the driver cannot answer that.' },
        objects: { type: 'object', description: 'Object counts by kind, for example {"tables":12}.' },
        pool: { type: 'object', description: 'This server\'s connection cache.' },
        drivers: { type: 'object', description: 'Which native drivers are installed and loadable.' },
        profiles: { type: ['integer', 'null'] },
        checks: {
          type: 'array',
          items: { type: 'object' },
          description: 'One {name, ok, detail} per diagnostic. A failed one is a finding, not an error.',
        },
        error: ERROR_FIELD,
      },
      required: ['ok', 'reachable', 'database', 'checks'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
]);

// A name -> tool index, so `findTool` is a Map lookup over a constant rather than
// a scan on the hot path of every tools/list.
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * Look a tool up by name. The MCP `Server` does not validate tool names, so an
 * unknown one arrives here as an ordinary string and callers must handle the
 * undefined rather than assume it is a typo.
 *
 * @param {string} name
 * @returns {object|undefined} The tool, or undefined for an unknown name.
 */
export function findTool(name) {
  if (typeof name !== 'string') return undefined;
  return TOOLS_BY_NAME.get(name);
}

/** Every tool name, in declaration order. Used in the "no such tool" message. */
export const TOOL_NAMES = Object.freeze(TOOLS.map((tool) => tool.name));

/**
 * Render a value inside an error message: short, and never a megabyte. An
 * untrusted value — a table name, a malformed URI — can be any size at all.
 */
function render(value) {
  if (typeof value === 'string') {
    const shown = value.length > 60 ? `${value.slice(0, 60)}…` : value;
    return JSON.stringify(shown);
  }
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return `object with keys ${keys.length > 8 ? `${keys.slice(0, 8).join(', ')}, …` : keys.join(', ') || '(none)'}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value;
}

const typeOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

/** Human names for the types a tool argument is allowed to declare. */
const TYPE_NAMES = {
  string: 'a string',
  number: 'a number',
  integer: 'a whole number',
  boolean: 'true or false',
  array: 'an array',
  object: 'an object',
};

const listTypes = (types) => (Array.isArray(types) ? types.join(' or ') : types);

/**
 * What each `pattern` in this file is for, in words. `\S` exists because
 * `minLength: 1` cannot see a string of nothing but spaces, and `"   "` reaches
 * SQLite as a syntax error about syntax.
 */
const PATTERN_HINTS = {
  '\\S': 'at least one non-whitespace character, got only whitespace',
};

const matchesType = (value, type) => {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
};

/**
 * Check one property against its subschema, appending to `errors`.
 *
 * @returns {boolean} Whether the value passed. A caller that cares must read
 *   the return value, not the length of `errors` before the call: a previous
 *   argument may already have contributed one.
 */
function checkProperty(name, value, spec, toolName, errors) {
  const fail = (message) => {
    errors.push(message);
    return false;
  };
  const expected = (types) => listTypes(types.map((t) => TYPE_NAMES[t] ?? t));

  const declared = spec.type;
  if (declared !== undefined) {
    const types = Array.isArray(declared) ? declared : [declared];
    if (!types.some((type) => matchesType(value, type))) {
      // Which argument, what was wanted, what arrived. "Invalid arguments"
      // sends a model back to the description.
      return fail(`Argument "${name}" of ${toolName} must be ${expected(types)}, got ${typeOf(value)} (${render(value)}).`);
    }
  }

  if (spec.enum !== undefined && !spec.enum.some((allowed) => allowed === value)) {
    return fail(`Argument "${name}" of ${toolName} must be one of: ${spec.enum.join(', ')}. Got ${render(value)}.`);
  }

  if (typeof value === 'string') {
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      fail(`Argument "${name}" of ${toolName} must be at least ${spec.minLength} character${spec.minLength === 1 ? '' : 's'}, got ${value.length}.`);
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      fail(`Argument "${name}" of ${toolName} must be at most ${spec.maxLength} characters, got ${value.length}.`);
    }
    if (spec.pattern !== undefined && !new RegExp(spec.pattern, 'u').test(value)) {
      // The message says what the pattern means, not the regex: `\S` is not
      // actionable. It cannot live in the schema, which has no such key.
      const explained = PATTERN_HINTS[spec.pattern];
      fail(explained
        ? `Argument "${name}" of ${toolName} must contain ${explained}, got ${render(value)}.`
        : `Argument "${name}" of ${toolName} must match ${spec.pattern}, got ${render(value)}.`);
    }
  }

  if (typeof value === 'number') {
    if (spec.minimum !== undefined && value < spec.minimum) {
      fail(`Argument "${name}" of ${toolName} must be at least ${spec.minimum}, got ${value}.`);
    }
    if (spec.maximum !== undefined && value > spec.maximum) {
      fail(`Argument "${name}" of ${toolName} must be at most ${spec.maximum}, got ${value}.`);
    }
  }

  if (Array.isArray(value)) {
    if (spec.minItems !== undefined && value.length < spec.minItems) {
      fail(`Argument "${name}" of ${toolName} must have at least ${spec.minItems} item${spec.minItems === 1 ? '' : 's'}, got ${value.length}.`);
    }
    if (spec.maxItems !== undefined && value.length > spec.maxItems) {
      fail(`Argument "${name}" of ${toolName} must have at most ${spec.maxItems} items, got ${value.length}.`);
    }
    if (spec.items !== undefined && spec.items.type !== undefined) {
      // Only the first offender: 1000 error lines cost more context than the
      // result they are protecting.
      const types = Array.isArray(spec.items.type) ? spec.items.type : [spec.items.type];
      for (let i = 0; i < value.length; i += 1) {
        if (types.some((type) => matchesType(value[i], type))) continue;
        fail(`Argument "${name}[${i}]" of ${toolName} must be ${expected(types)}, got ${typeOf(value[i])} (${render(value[i])}).`);
        break;
      }
    }
  }

  return true;
}

/**
 * Cross-field rules. The `profile`/`uri` xor needs `oneOf` with two `not`
 * branches to express in JSON Schema, and the failure message would be a JSON
 * pointer; written out it is one sentence a model can act on.
 */
const CROSS_FIELD_RULES = {
  db_query: (args) => xor(args, 'profile', 'uri'),
  db_schema: (args) => xor(args, 'profile', 'uri'),
  db_explain: (args) => xor(args, 'profile', 'uri'),
  db_health: (args) => xor(args, 'profile', 'uri'),
};

function xor(args, a, b) {
  const hasA = args[a] !== undefined;
  const hasB = args[b] !== undefined;
  if (hasA !== hasB) return null;
  return hasA
    ? `Give either "${a}" or "${b}", not both. ${TARGET_HELP}`
    : `Give one of "${a}" or "${b}". ${TARGET_HELP}`;
}

/**
 * Validate a call's arguments against a tool's `inputSchema`. This is what makes
 * `additionalProperties: false` mean anything: the MCP `Server` validates the
 * request and result envelopes, never the arguments.
 *
 * Two rules that are not JSON Schema:
 *
 *   - `null` means "not supplied", as JSON clients send it for an absent optional
 *     field and as the registry already treats it. A *required* argument that is
 *     `null` is missing.
 *   - Every problem is collected, not just the first: a model that fixes one
 *     argument per round trip is slow, and the whole list costs a hundred tokens.
 *
 * @param {object} tool - A tool definition, or one from `TOOLS`
 * @param {object} [args] - The caller's `arguments`, which may be anything
 * @returns {{ ok: boolean, value: object, errors: string[] }} `value` is the
 *   cleaned argument object, always safe to use when `ok` is true
 */
export function validateArgs(tool, args) {
  const errors = [];
  const toolName = (tool && tool.name) || 'this tool';
  const schema = tool && tool.inputSchema;

  if (!schema || typeof schema !== 'object') {
    return { ok: false, value: {}, errors: [`${toolName} has no inputSchema to validate against.`] };
  }

  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    return {
      ok: false,
      value: {},
      errors: [`The arguments of ${toolName} must be an object, got ${typeOf(args)} (${render(args)}).`],
    };
  }

  const input = args ?? {};
  const properties = schema.properties ?? {};
  const value = {};

  for (const [name, given] of Object.entries(input)) {
    const spec = Object.prototype.hasOwnProperty.call(properties, name) ? properties[name] : undefined;

    if (spec === undefined) {
      if (schema.additionalProperties === false) {
        const known = Object.keys(properties);
        errors.push(
          `Unknown argument "${name}" for ${toolName}. `
          + (known.length > 0
            ? `It takes: ${known.join(', ')}.`
            : 'It takes no arguments.')
          + ' The argument is not passed to the database; fix the name and call again.'
        );
        continue;
      }
      value[name] = given;
      continue;
    }

    // `null` is "not supplied" rather than a value; see the note above.
    if (given === null) continue;

    // Only copied through when it passed: a value that failed its checks must
    // not reach the registry, or the caller's mistake is reported twice.
    if (checkProperty(name, given, spec, toolName, errors)) value[name] = given;
  }

  for (const name of schema.required ?? []) {
    if (value[name] === undefined) {
      errors.push(`${toolName} requires "${name}". ${requiredHelp(name, properties, toolName)}`);
    }
  }

  if (errors.length === 0) {
    const rule = CROSS_FIELD_RULES[toolName];
    const problem = rule ? rule(value) : null;
    if (problem) errors.push(problem);
  }

  if (errors.length > 0) return { ok: false, value: {}, errors };
  return { ok: true, value, errors: [] };
}

/** A per-argument hint for a missing-required message, where there is one. */
const REQUIRED_HINTS = {
  query: 'It is the statement to run: SQL, a MongoDB filter or pipeline as JSON, or a Redis command.',
  table: 'It names the table or collection to describe.',
  collection: 'Every MongoDB action needs one, for example "users".',
};

function requiredHelp(name, properties, toolName) {
  if (REQUIRED_HINTS[name]) return REQUIRED_HINTS[name];
  const spec = properties[name];
  const types = spec && spec.type ? (Array.isArray(spec.type) ? spec.type : [spec.type]) : [];
  const described = types.map((t) => TYPE_NAMES[t] ?? t).join(' or ');
  return described ? `It must be ${described}.` : `See the ${toolName} description.`;
}
