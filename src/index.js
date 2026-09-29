#!/usr/bin/env node
/**
 * The MCP server: five tools over one connection pool, on stdio.
 *
 * Nothing here runs on import. `createServer(deps)` builds the registry, the
 * `Server` and the two request handlers, reading no file and starting no timer.
 * `main(deps)` adds the process wiring and `connect(transport)`, and the last
 * statement in the file calls it only when this file is the process entry point,
 * so `bin` starts a server and an import does not.
 *
 * The database-touching parts live in `src/core/`, and the schemas in
 * `src/core/tools.js` so they can be unit tested without a process.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as registryModule from './core/registry.js';
import { formatRows as renderResultRows } from './core/result-limits.js';
import { TimeoutError } from './core/base-adapter.js';
import {
  maskUri, describeQuery, log as defaultLog, logError as defaultLogError, logQueryDetail, isDebugEnabled, positiveInt,
} from './core/logging.js';
import { installShutdownHandlers } from './core/connection-cache.js';
import { isAdHocUriAllowed } from './core/policy.js';
import { TOOLS, TOOL_NAMES, findTool, validateArgs, FORMATS } from './core/tools.js';

/**
 * This file's own path, without `import.meta`.
 *
 * `import.meta` is a syntax error the moment this file is compiled to CommonJS,
 * and the test harness does exactly that, so the whole file failed to transform.
 * `__filename` exists in the CommonJS output and the entry script is the
 * fallback; neither is trustworthy unless this file really is the entry point.
 */
const ENTRY_RE = /(^|[\\/])src[\\/]index\.[cm]?js$/;

function ownPath() {
  if (typeof __filename === 'string' && __filename !== '') return __filename;
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return null;
  if (ENTRY_RE.test(entry)) return entry;

  // npm's shim is a `.cmd` on Windows, which passes the real path to node, and a
  // symlink everywhere else, so `argv[1]` is the link at node_modules/.bin and
  // never matches. Without the realpath fallback the installed server cannot find
  // its own package.json and exits before `initialize` -- which is why
  // verify:package failed only on Linux and macOS, and why it failed on the two
  // checks that need a version.
  try {
    const real = realpathSync(entry);
    if (ENTRY_RE.test(real)) return real;
  } catch {
    // Not a path, or not readable. Same answer as no match.
  }
  return null;
}

/**
 * The version this server reports in `initialize`.
 *
 * Read from `package.json` rather than kept as a second copy, and only when
 * `main` did not inject it: a module-scope read is a filesystem read on import.
 *
 * @param {string} [seed] - This file's path, when the caller already knows it
 */
export function readVersion(seed = ownPath()) {
  if (!seed) {
    throw new Error(
      'anydb-mcp could not locate its own package.json to read the version. '
      + 'Pass `version` in the dependencies given to createServer()/main().'
    );
  }
  return JSON.parse(readFileSync(resolvePath(dirname(seed), '..', 'package.json'), 'utf8')).version;
}

/**
 * Sent in the `initialize` result: the one text every model reads once, at
 * session start, before it has decided what to do. Written for a model --
 * imperative, no rationale, nothing hedged.
 */
export const INSTRUCTIONS = [
  'This server runs read-only by default. A statement that writes is refused unless the call sets readOnly: false,',
  'and one that changes schema or grants additionally needs allowDestructive: true. Read-only means only reads and',
  'plan-only statements: INSERT, UPDATE, DELETE, DDL, and server-side code such as COPY ... PROGRAM are refused.',

  'Before writing a query, call db_list to find a profile name, then db_schema to see the tables, columns and types.',
  'Do not guess a table or column name: a wrong name costs a failed round trip and, worse, a confidently wrong',
  'answer. db_explain plans a statement without running it, which is the cheapest way to catch a sequential scan.',

  'Pass "profile", not "uri", whenever db_list shows one. A profile keeps the password out of your context window, out',
  'of the JSON-RPC frames on stdout, and out of the client transcript, which is usually persisted to disk. A URI puts a',
  'plaintext password in all of them, on every call. Use "uri" only when db_list reports no config file.',

  'Prefer "params" over pasting values into "query". A bound value never enters the statement text, so it cannot be',
  'logged, cannot reach a plan cache, and cannot change the shape of a statement. Use ? for MySQL and SQLite, $n for',
  'PostgreSQL.',

  'The real security boundary is the database role, not these flags. readOnly: false is a request to this server. If the',
  'role holds INSERT or DELETE a write succeeds whatever the flags say; if it does not, it fails however many are set.',

  'Put a LIMIT in every query. Results are capped anyway, and a cap you did not ask for is how a table gets half-read',
  'and then reported as complete. For many wide rows ask for format: "jsonl": one object per line, no escaping to read.',

  'Every result carries rowCount, truncated and limitReason. Treat a truncated result as a prefix of the answer and',
  'narrow the query; do not report it as the whole table.',

  'The structured result of every call is one envelope: ok, rows, rowCount, truncated, bytes, elapsedMs, driver,',
  'profile, limitReason, hint, format, and error when ok is false. rows is the answer; the rest is metadata.',

  'Errors come back as text in the result, not as a protocol failure, and end with a SUGGESTION line. Read it.',
].join('\n');

/**
 * After this many milliseconds, start telling the client the call is alive.
 *
 * A silent 30-second query is indistinguishable from a hung server, and a client
 * that cannot tell the difference eventually retries it. The spec's `tasks`
 * extension would be the fuller answer, but it needs state across sessions and
 * this process deliberately keeps none.
 */
const DEFAULT_PROGRESS_MS = 2000;

/**
 * Short phase labels. Never the query text: a progress frame is a log line, and a
 * statement routinely carries a literal that is somebody's personal data.
 */
const PHASES = Object.freeze({ start: 'starting', running: 'still running', finish: 'finishing' });

/**
 * Everything the tool layer needs from `./core/registry.js`, in one place.
 *
 * A factory rather than a module-level constant, because the registry is
 * injected and one is built per `createServer` call. What is *not* imported is
 * any named constant: a missing named export is a `SyntaxError` at module link
 * time, while a namespace property that is `undefined` is an ordinary event.
 */
const registryBridgeFor = (registry, log) => ({
  /**
   * Exposed because two of the five tools need something the bridge does not
   * wrap: `db_list` asks the profile store whether there was a config file, and
   * `db_health` asks for the pool configuration.
   */
  registry,

  /**
   * Fold `{ profile, uri }` into a connection, a policy and a profile name.
   *
   * This is what keeps a password out of the transcript: the *name* travels in
   * the JSON-RPC frame and the credential is resolved here. `extra` carries
   * `{ query }` so the destructive verdict is judged on the statement to be run.
   */
  async resolveTarget(args, extra = {}) {
    if (typeof registry.resolveTarget === 'function') {
      return registry.resolveTarget({ profile: args.profile, uri: args.uri }, { ...args, ...extra });
    }

    // Fallback for a registry with no `resolveTarget`: fold the two ways of
    // naming a target here.
    if (typeof args.profile === 'string') {
      const resolved = await registry.profiles.resolve(args.profile, { log });
      return {
        uri: resolved.uri,
        policy: resolved.policy ?? {},
        profileName: resolved.name,
        entry: registry.profiles.getEntry(args.profile),
        options: resolved.options ?? {},
      };
    }

    if (!isAdHocUriAllowed()) {
      throw toolError(
        'policy',
        'Ad-hoc "uri" arguments are disabled (ANYDB_ALLOW_ADHOC_URI=0), so this call must name a "profile" from db_list. '
        + 'An ad-hoc URI would also put a plaintext password into the transcript.',
        'Call db_list and pass "profile" instead of "uri".'
      );
    }
    return { uri: args.uri, policy: {}, profileName: null, entry: null, options: {} };
  },

  /** Run one statement, or describe a database. Both return the `buildEnvelope`. */
  async run(target, query, options) {
    return unwrapEnvelope(await registry.run(target, query, options));
  },

  async describe(target, options) {
    return unwrapEnvelope(await registry.describe(target, options));
  },

  /** Close every pooled connection. */
  async close() {
    if (typeof registry.close === 'function') await registry.close();
  },

  /**
   * Drop and abort the connection a statement is running on.
   *
   * The key is rebuilt with `normaliseCacheKey` rather than by concatenation: it
   * is a scheme plus a truncated SHA-256 of the URI, so a key built the obvious
   * way would miss and leave the statement running. `abort()` comes before
   * `evict()` because for SQLite only `abort()` interrupts a running statement.
   */
  abandon(uri, protocol) {
    try {
      const key = typeof registryModule.normaliseCacheKey === 'function'
        ? registryModule.normaliseCacheKey(uri, protocol)
        : `${protocol}::${uri}`;
      const entry = registry.cache.entries instanceof Map ? registry.cache.entries.get(key) : null;
      entry?.adapter?.abort?.();
      registry.cache.evict(key);
    } catch {
      /* abandoning is best effort; the caller stops waiting either way */
    }
  },
});

/**
 * Read the one result shape `registry.run` and `registry.describe` have.
 *
 * `buildEnvelope` always returns `{ rows, rowCount, truncated, bytes, … }` and a
 * failure is a *throw*, not a returned `{ ok: false }`. So this is a guard, not a
 * converter: a well-formed envelope passes straight through, anything else
 * becomes a loud internal error.
 */
function unwrapEnvelope(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)
    && typeof raw.rows === 'object' && 'rowCount' in raw) {
    return raw;
  }
  throw internalError(`an injected registry returned ${describeShape(raw)} where a buildEnvelope result was expected`);
}

/** A short, safe description of a value's shape, for an error message. */
function describeShape(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  const keys = Object.keys(value);
  return keys.length === 0 ? 'an object with no keys' : `an object with keys [${keys.slice(0, 6).join(', ')}]`;
}

/**
 * An error this server raises about *itself*, never about a statement.
 *
 * Distinct from `toolError` on purpose: `classify()` would map an unrecognised
 * failure to `kind: 'database'` and tell the model to check the SQL syntax,
 * advice it would act on, against a database that is fine.
 */function internalError(message) {
  return toolError('internal', message,
    'This is a fault in this server or in the registry it was given, not in the statement. '
    + 'The statement was not executed.');
}

/**
 * An error that already knows what class of failure it is.
 *
 * `formatError` reads `.kind` before anything else, so every error this file
 * raises is built here. An error without a kind falls back to matching prose.
 *
 * @param {string} suggestion - The next step for the model
 */
function toolError(kind, message, suggestion) {
  const error = new Error(message);
  error.kind = kind;
  if (suggestion) error.suggestion = suggestion;
  return error;
}

/**
 * The profile list.
 *
 * The contract `ProfileStore#list` already enforces: no URI, no host, no
 * username, no password, not masked. A masked connection string still discloses
 * the host and the database name, and this is the field a model quotes back.
 */
async function handleList(ctx, args, extra, signal, progress) {
  const { bridge, clock } = ctx;
  const started = clock();
  const callId = shortCallId();

  let profiles = [];
  let configSource = null;
  let message = '';

  try {
    // Reloaded per call: a config somebody has just written should be visible
    // without restarting the server, and this is one small read on a tool meant
    // to be called once at session start. The store is reached directly only to
    // answer "was there a file at all".
    const store = bridge.registry.profiles;
    if (store && typeof store.reload === 'function') store.reload();
    profiles = typeof bridge.registry.listProfiles === 'function'
      ? bridge.registry.listProfiles()
      : store.list();
    configSource = store ? store.source : null;

    if (profiles.length === 0) {
      // Said plainly, because "the list is empty" and "there is no config file"
      // lead to different next steps.
      message = configSource
        ? `The anydb config file ${configSource} declares no profiles. Add one, or pass "uri" to the other tools.`
        : 'No anydb config file was found, so there are no profiles. Pass "uri" to db_query, db_schema, db_explain or '
          + 'db_health instead, for example sqlite:///path/to/app.db. To create one, write ~/.anydb/db.json with '
          + '{"profiles":{"local":{"driver":"sqlite","path":"./app.db"}}} and restart the server.';
    }
  } catch (error) {
    return reportFailure(ctx, error, 'db_list', callId, started, args, null, signal);
  }

  const structured = { ok: true, configSource, profiles, ...(message ? { message } : {}) };
  logResult(ctx, callId, 'db_list', { profiles: profiles.length, configSource }, started, true);

  return {
    content: [{
      type: 'text',
    // With no profiles the message *is* the answer. An empty array with the
    // reason buried in a field costs another round trip.
      text: profiles.length === 0 ? message : JSON.stringify(structured, null, 2),
    }],
    structuredContent: structured,
  };
}

/**
 * Keys `db_query` forwards to the registry. Everything else is dropped.
 *
 * A hardcoded allowlist rather than "forward the validated arguments", because
 * the validated arguments include `profile`/`uri` and those must not reach
 * `resolveTarget` (see `targetSpecOf`).
 *
 * A list goes stale invisibly: `document` was once missing here, so the schema
 * declared it, `validateArgs` accepted it, the model sent it, and
 * `adapters/mongodb.js` refused a call that had one. It is therefore asserted
 * against the schema by `__tests__/package_entry.test.js`.
 */const QUERY_OPTION_KEYS = [
  'params', 'collection', 'action', 'update', 'document', 'field', 'sort', 'projection',
  'upsert', 'allowWriteStages', 'limit', 'offset', 'cursor', 'readOnly',
  'allowDestructive', 'format', 'timeout', 'maxRows', 'maxBytes',
];

async function handleQuery(ctx, args, extra, signal, progress) {
  const { bridge, clock, log } = ctx;
  const started = clock();
  const callId = shortCallId();
  const query = args.query;

  let target;
  try {
    // The statement goes with the resolution so the destructive verdict is
    // computed against the statement that is about to run.
    target = await bridge.resolveTarget(args, { query });
  } catch (error) {
    return reportFailure(ctx, error, 'db_query', callId, started, args, null, signal);
  }

  // The *resolved* timeout, from the policy the registry just built, so the
  // effective budget appears in a log rather than only the requested one.
  const timeout = Number.isFinite(target.policy?.queryTimeoutMs) ? target.policy.queryTimeoutMs : effectiveTimeout(args);

  // What `run` is given is the *original* target, not the resolved one: the
  // resolved target carries a credential-bearing URI, and handing that back
  // would make every profile call look ad-hoc and drop the profile's own knobs.
  const spec = targetSpecOf(args);

  log('db_query', {
    uri: maskUri(target.uri),
    query: describeQuery(query),
    timeout,
    readOnly: target.policy?.readOnly !== false,
    maxRows: target.policy?.maxRows ?? null,
    maxBytes: target.policy?.maxBytes ?? null,
    profile: target.profileName,
  }, { event: 'tool_call', callId });

  logQueryDetail(target.uri, query, { profile: target.profileName });
  progress?.report(PHASES.start);

  try {
    // `readOnly` is forwarded exactly as it was given, including as `undefined`:
    // `evaluatePolicy` only lets a *present* value win, so passing a resolved
    // `true` here would override a profile that deliberately sets readOnly:false.
    const outcome = await raceCancellation(
      ctx,
      bridge.run(spec, query, pick(args, QUERY_OPTION_KEYS)),
      signal,
      target.uri
    );
    progress?.report(PHASES.finish);
    return renderRows(ctx, outcome, args.format ?? 'json', started, callId);
  } catch (error) {
    return reportFailure(ctx, error, 'db_query', callId, started, args, target, signal);
  }
}

async function handleSchema(ctx, args, extra, signal, progress) {
  const { bridge, clock, log } = ctx;
  const started = clock();
  const callId = shortCallId();

  let target;
  try {
    target = await bridge.resolveTarget(args);
  } catch (error) {
    return reportFailure(ctx, error, 'db_schema', callId, started, args, null, signal);
  }

  const timeout = effectiveTimeout(args);
  log('db_schema', {
    uri: maskUri(target.uri),
    table: args.table ?? null,
    collection: args.collection ?? null,
    detail: args.detail ?? 'summary',
    timeout,
    profile: target.profileName,
  }, { event: 'tool_call', callId });

  progress?.report(PHASES.start);

  try {
    const outcome = await raceCancellation(
      ctx,
      bridge.describe(targetSpecOf(args), { timeout, ...pick(args, ['table', 'collection', 'detail']) }),
      signal,
      target.uri
    );
    progress?.report(PHASES.finish);

    // The description is the envelope's `rows`: `clampResult` keeps a non-array
    // whole or drops it, because there is no partial schema report to hand back.
    const report = outcome.rows && typeof outcome.rows === 'object' && !Array.isArray(outcome.rows)
      ? outcome.rows
      : {};
    const structured = {
      ok: true,
      ...pick(report, ['tables', 'collections', 'keyspace']),
      database: report.database ?? driverOf(target.uri),
      detail: args.detail ?? 'summary',
      rowCount: outcome.rowCount ?? 0,
      truncated: outcome.truncated === true,
      bytes: outcome.bytes ?? 0,
      elapsedMs: elapsedSince(ctx, started),
      profile: target.profileName,
      driver: outcome.driver ?? driverOf(target.uri),
      limitReason: outcome.limitReason ?? null,
      hint: outcome.hint ?? null,
    };
    logResult(ctx, callId, 'db_schema', { ...countObjects(structured), truncated: structured.truncated }, started, true);

    return {
      content: [{ type: 'text', text: renderResultRows(outcome.rows, 'json') }],
      structuredContent: structured,
    };
  } catch (error) {
    return reportFailure(ctx, error, 'db_schema', callId, started, args, target, signal);
  }
}

/**
 * How to reach a plan, per scheme. The dialect difference is why this cannot be
 * left to the caller: SQLite's bare `EXPLAIN` returns the VDBE bytecode program,
 * and `EXPLAIN QUERY PLAN` is the one that is readable.
 */
const EXPLAIN_PREFIX = Object.freeze({
  postgres: 'EXPLAIN ',
  postgresql: 'EXPLAIN ',
  mysql: 'EXPLAIN ',
  mariadb: 'EXPLAIN ',
  sqlite: 'EXPLAIN QUERY PLAN ',
});

/**
 * `EXPLAIN ANALYZE`, in every spelling that actually executes the statement.
 *
 * Mirrors `safety.js`'s `explainExecutesTheStatement` deliberately: the read-only
 * guard would already refuse it, but its advice is about read-only mode, which
 * sends a model looking for the wrong problem.
 */const EXECUTES_THE_STATEMENT = /^\s*EXPLAIN\b\s*(?:\([^)]*\bANALYZE\b[^)]*\)|ANALYZE\b)/i;

async function handleExplain(ctx, args, extra, signal, progress) {
  const { bridge, clock, log } = ctx;
  const started = clock();
  const callId = shortCallId();

  let target;
  try {
    target = await bridge.resolveTarget(args);
  } catch (error) {
    return reportFailure(ctx, error, 'db_explain', callId, started, args, null, signal);
  }

  const driver = driverOf(target.uri);
  const given = args.query;

  if (EXECUTES_THE_STATEMENT.test(given)) {
    return reportFailure(ctx, toolError(
      'validation',
      '"EXPLAIN ANALYZE" executes the statement it plans, so it is neither an explain nor read-only. Refused here, '
      + 'before anything was sent to the database.',
      'Drop the ANALYZE option and call db_explain again. To time a statement for real, run it with db_query against a '
      + 'database you can afford to modify, and with a limit you are willing to pay for.'
    ), 'db_explain', callId, started, args, target, signal);
  }

  if (/^\s*EXPLAIN\b/i.test(given)) {
    return reportFailure(ctx, toolError(
      'validation',
      'The query already begins with EXPLAIN. This tool adds the right prefix per dialect itself, so "EXPLAIN EXPLAIN …" '
      + 'is not a statement.',
      'Pass the statement without a leading EXPLAIN.'
    ), 'db_explain', callId, started, args, target, signal);
  }

  if (driver === 'redis') {
    return reportFailure(ctx, toolError(
      'validation',
      'Redis has no execution plan, so there is nothing for db_explain to return.',
      'Call db_query with the command itself. To understand a slow key, run COMMAND DOCS <command> or SLOWLOG GET on '
      + 'the server.'
    ), 'db_explain', callId, started, args, target, signal);
  }

  if (driver === 'mongodb' && typeof args.collection !== 'string') {
    return reportFailure(ctx, toolError(
      'validation',
      'A MongoDB explain is a find on one collection, so "collection" is required.',
      'Pass "collection", for example "users", with the filter as "query".'
    ), 'db_explain', callId, started, args, target, signal);
  }

  const timeout = effectiveTimeout(args);
  log('db_explain', {
    uri: maskUri(target.uri),
    query: describeQuery(given),
    timeout,
    collection: args.collection ?? null,
    profile: target.profileName,
  }, { event: 'tool_call', callId });

  progress?.report(PHASES.start);

  // For Mongo the payload is a find filter and the `explain` action *is* the
  // plan; for SQL a fixed literal prefix is prepended. Concatenation is safe
  // because the prefix is ours and the caller's statement is still classified by
  // the read-only guard afterwards.
  const options = pick(args, ['params', 'timeout']);
  const run = driver === 'mongodb'
    ? bridge.run(targetSpecOf(args), given, { ...options, readOnly: true, collection: args.collection, action: 'explain' })
    : bridge.run(targetSpecOf(args), `${EXPLAIN_PREFIX[driver] ?? 'EXPLAIN '}${given}`, { ...options, readOnly: true });

  try {
    const outcome = await raceCancellation(ctx, run, signal, target.uri);
    progress?.report(PHASES.finish);
    logResult(ctx, callId, 'db_explain', { planRows: Array.isArray(outcome.rows) ? outcome.rows.length : 1 }, started, true);

    return {
      content: [{ type: 'text', text: renderResultRows(outcome.rows, 'json') }],
      structuredContent: { ...outcome, ok: true, format: 'json', elapsedMs: elapsedSince(ctx, started) },
    };
  } catch (error) {
    return reportFailure(ctx, error, 'db_explain', callId, started, args, target, signal);
  }
}

/**
 * Read-only probes, one per driver. Each asks the server to *report* a privilege
 * rather than exercising it: a health check that can modify a database is not a
 * health check. Where a driver cannot answer, the field is `null` and the check
 * says why rather than the value being guessed.
 */
const SQL_PROBES = Object.freeze({
  postgres: 'SELECT current_setting(\'server_version\') AS server_version, current_user AS role, '
    + 'pg_is_in_recovery() AS server_read_only, '
    + '(NOT has_database_privilege(current_user, current_database(), \'CREATE\') '
    + 'AND NOT has_table_privilege(current_user, \'pg_class\', \'INSERT\')) AS role_looks_read_only',
  mysql: 'SELECT VERSION() AS server_version, CURRENT_USER() AS role, @@global.read_only AS server_read_only',
  sqlite: 'SELECT sqlite_version() AS server_version',
});

async function handleHealth(ctx, args, extra, signal, progress) {
  const { bridge, clock, log } = ctx;
  const started = clock();
  const callId = shortCallId();
  const timeout = effectiveTimeout(args);
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  let target;
  try {
    target = await bridge.resolveTarget(args);
  } catch (error) {
    return reportFailure(ctx, error, 'db_health', callId, started, args, null, signal);
  }

  const driver = driverOf(target.uri);
  const configuration = typeof bridge.registry.describeConfiguration === 'function'
    ? bridge.registry.describeConfiguration()
    : { cache: {} };

  log('db_health', { uri: maskUri(target.uri), timeout, profile: target.profileName },
    { event: 'tool_call', callId });
  progress?.report(PHASES.start);

  // Step one: is anything there at all? A health check that cannot connect has
  // no business reporting on privileges.
  let database = driver;
  let objects = {};
  try {
    const outcome = await raceCancellation(
      ctx,
      bridge.describe(targetSpecOf(args), { timeout }),
      signal,
      target.uri
    );
    const report = outcome.rows && typeof outcome.rows === 'object' && !Array.isArray(outcome.rows) ? outcome.rows : {};
    database = report.database ?? outcome.driver ?? driver;
    objects = countObjects(report);
    record('connect', true, `Reached the ${database} server and read its catalog.`);
  } catch (error) {
    record('connect', false, errorMessage(error));
    logResult(ctx, callId, 'db_health', { reachable: false }, started, false);
    return {
      content: [{ type: 'text', text: formatError(error, target.uri) }],
      structuredContent: {
        ...healthShell(configuration, driver),
        ok: false,
        reachable: false,
        checks,
        error: errorField(error, target.uri),
      },
      isError: true,
    };
  }

  // Step two: what the server says about itself. A failed probe is a finding,
  // not a failure: a `db_health` that errored because the role cannot read
  // `pg_class` would hide the one fact the caller asked for.
  let serverVersion = null;
  let role = null;
  let readOnlyRole = null;
  const options = { readOnly: true, timeout };

  if (driver === 'redis') {
    // `INFO server` comes back as one string rather than as columns, so the
    // version and the replication role are read out of the text.
    try {
      const outcome = await raceCancellation(
        ctx, bridge.run(targetSpecOf(args), 'INFO server', options), signal, target.uri
      );
      const text = String(firstValue(outcome.rows));
      serverVersion = /^redis_version:(\S+)$/m.exec(text)?.[1] ?? null;
      role = /^role:(\S+)$/m.exec(text)?.[1] ?? null;
      readOnlyRole = role === 'slave' ? true : null;
      record('server', true, `redis ${serverVersion ?? '(version not reported)'} as ${role ?? '(role not reported)'}.`);
    } catch (error) {
      record('server', false, errorMessage(error));
    }
  } else if (driver === 'mongodb') {
    // MongoDB surfaces no version string to a read, and `admin.system.version`
    // has exactly one document on every server, so counting it proves
    // reachability *and* catalog permission at once.
    try {
      const outcome = await raceCancellation(
        ctx, bridge.run(targetSpecOf(args), '{}', { ...options, collection: 'admin.system.version', action: 'count' }),
        signal, target.uri
      );
      const count = Array.isArray(outcome.rows) ? outcome.rows[0]?.count : undefined;
      record('mongo-catalog', true, `Read admin.system.version (${count ?? '?'} document(s)).`);
      record('server', true, 'The MongoDB wire protocol does not surface a version string to a read, so none is reported.');
    } catch (error) {
      record('mongo-catalog', false, errorMessage(error));
    }
  } else if (SQL_PROBES[driver]) {
    try {
      const outcome = await raceCancellation(
        ctx, bridge.run(targetSpecOf(args), SQL_PROBES[driver], options), signal, target.uri
      );
      const row = firstRow(outcome.rows);
      serverVersion = row.server_version === undefined || row.server_version === null ? null : String(row.server_version);
      role = row.role === undefined || row.role === null ? null : String(row.role);
      const reported = row.role_looks_read_only ?? row.server_read_only;
      readOnlyRole = reported === undefined || reported === null
        ? null
        : reported === true || reported === 1 || reported === '1' || reported === 'ON';
      record('server', true, `${database} ${serverVersion ?? '(version not reported)'} as ${role ?? '(role not reported)'}.`);
    } catch (error) {
      record('server', false, errorMessage(error));
    }
  } else {
    record('server', true, `No read-only privilege probe is implemented for driver "${driver}", so none is reported.`);
  }

  const structured = {
    ...healthShell(configuration, driver),
    ok: checks.every((check) => check.ok),
    reachable: true,
    database,
    serverVersion,
    role,
    readOnlyRole,
    objects,
    checks,
  };
  logResult(ctx, callId, 'db_health', { reachable: true, role, readOnlyRole }, started, structured.ok);

  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    ...(structured.ok ? {} : { isError: true }),
  };
}

/** The parts of a health report that do not depend on a connection. */
function healthShell(configuration, driver) {
  const cache = configuration.cache ?? {};
  return {
    database: driver,
    pool: {
      enabled: cache.enabled !== false,
      entries: Number.isInteger(cache.size) ? cache.size : null,
      maxEntries: cache.maxEntries ?? null,
      idleTtlMs: cache.idleTtlMs ?? null,
    },
    drivers: configuration.drivers ?? {},
    profiles: Number.isInteger(configuration.profiles) ? configuration.profiles : null,
  };
}

const firstRow = (rows) => (Array.isArray(rows) && rows[0] && typeof rows[0] === 'object' ? rows[0] : {});
const firstValue = (rows) => (Array.isArray(rows) ? rows[0] : rows);

/**
 * The two MCP request handlers, installed on a `Server`.
 *
 * A function rather than two top-level `setRequestHandler` calls, because the
 * handlers need a `ctx` and there is no single server in the process to hang
 * them off. Pulled out of `createServer` so a test can call them in this process
 * rather than over a stdio pipe.
 *
 * @param {object} ctx - `{ bridge, log, logError, clock, server, progressMs, version }`
 */
export function installRequestHandlers(server, ctx) {
  /** `tools/list`. Returns the frozen constant from `./core/tools.js`. */
  const listTools = async () => ({ tools: TOOLS });

  /**
   * `tools/call`.
   *
   * `extra.signal` is the SDK's `AbortSignal` for this request, aborted when the
   * client sends `notifications/cancelled`. A handler that ignores it leaves a
   * 60-second query running against a pooled connection the user has given up
   * on, with the pool slot checked out for the duration.
   */
  const callTool = async (request, extra) => {
    const name = request?.params?.name;
    const tool = findTool(name);

    // The SDK validates the request envelope and never the tool name, so an
    // unknown name must be refused here rather than reaching `handleQuery`.
    if (!tool) {
      ctx.log('tools/call', { tool: typeof name === 'string' ? name : `<${typeof name}>`, ok: false },
        { event: 'unknown_tool', level: 'warn' });
      return unknownTool(name);
    }

    const args = validateArgs(tool, request?.params?.arguments);
    if (!args.ok) return validationFailure(ctx, name, args.errors, startedAt(ctx));

    const progress = progressReporter(ctx, extra, effectiveTimeout(args.value));
    const handlers = {
      db_list: handleList,
      db_query: handleQuery,
      db_schema: handleSchema,
      db_explain: handleExplain,
      db_health: handleHealth,
    };

    try {
      return await handlers[name](ctx, args.value, extra, extra?.signal, progress);
    } catch (error) {
      // A handler that threw instead of answering: the last line of defence, so
      // a bug in one is an in-band error the model can read rather than a
      // protocol failure the host reports as a crashed tool.
      ctx.logError(name, error, { profile: args.value.profile ?? null, uri: maskUri(args.value.uri ?? '') });
      return failure(ctx, error, name, startedAt(ctx), { uri: args.value.uri });
    } finally {
      progress?.stop();
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, listTools);
  server.setRequestHandler(CallToolRequestSchema, callTool);
  return { listTools, callTool };
}

/**
 * Stop waiting when the client cancels, and stop the work too.
 *
 * Two separate things, and both matter: the *await* is abandoned so the caller
 * gets an answer now, and the connection is aborted and dropped so the statement
 * does not keep running against a pooled socket.
 */
function raceCancellation(ctx, promise, signal, uri) {
  if (!signal) return promise;

  if (signal.aborted) {
    // The work has already started, so its rejection has to be observed and its
    // connection still abandoned, or this leaks what the signal is there to free.
    promise.catch(() => {});
    ctx.bridge.abandon(uri, schemeOf(uri));
    return Promise.reject(cancelledError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      ctx.bridge.abandon(uri, schemeOf(uri));
      reject(cancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

/**
 * A cancellation is reported as a `timeout` because that is the advice that
 * applies: the call did not finish, so the next one has to be cheaper or given
 * longer. The name says which of the two it was.
 */
function cancelledError() {
  return toolError(
    'timeout',
    'The client cancelled this call before it finished. The statement was not left running against the connection pool.',
    'Call again with a narrower query or a larger "limit", or with a longer "timeout" if the work is genuinely needed.'
  );
}

/**
 * A progress reporter, or nothing.
 *
 * Returns `undefined` when the client sent no progress token or when the call is
 * expected to finish inside the threshold, in which case posting anyway would
 * queue a frame nobody needs.
 */
function progressReporter(ctx, extra, timeoutMs) {
  // `extra._meta` is the SDK's own copy of `request.params._meta`.
  const token = extra?._meta?.progressToken;
  if (token === undefined || token === null) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs < ctx.progressMs) return undefined;

  const send = typeof extra.sendNotification === 'function'
    ? extra.sendNotification
    : (notification) => ctx.server.notification(notification);

  let step = 0;
  let timer = null;

  const post = (phase) => {
    step += 1;
    const notification = {
      method: 'notifications/progress',
      params: {
        progressToken: token,
        // `progress` is a count and `total` is deliberately absent: a query has
        // no row count until it has finished, and a client rendering a percentage
        // from a fabricated total renders a wrong one.
        progress: step,
        message: `${phase} (timeout ${timeoutMs}ms)`,
      },
    };
    try {
      // Fire and forget. A progress frame must never delay the result, and a
      // client that cannot accept one still gets its answer.
      Promise.resolve(send(notification)).catch(() => {});
    } catch {
      /* the transport refused; the result is what matters */
    }
  };

  const report = (phase) => {
    if (!phase) return;
    post(phase);
    // The repeating frame is the one that actually helps: the first "starting"
    // only tells the client the call arrived.
    if (timer === null && phase !== PHASES.finish) {
      timer = setInterval(() => post(PHASES.running), ctx.progressMs);
      timer.unref?.();
    }
  };

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { report, stop };
}

/**
 * Render rows as text, and hand the envelope through as `structuredContent`.
 *
 * The text is the *rows*, not the envelope: the rows are the answer, the counters
 * are metadata, and a model reading a text block wants the answer.
 */
function renderRows(ctx, outcome, format, started, callId) {
  const mode = FORMATS.includes(format) ? format : 'json';
  const text = renderResultRows(outcome.rows, mode);
  const structured = {
    ...outcome,
    ok: true,
    format: mode,
    elapsedMs: elapsedSince(ctx, started),
  };

  logResult(ctx, callId, 'db_query', {
    rowCount: structured.rowCount,
    bytes: structured.bytes,
    truncated: structured.truncated,
  }, started, true);

  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/**
 * Turn any thrown value into `DATABASE_ERROR: <cause>` plus a `SUGGESTION:`.
 *
 * Errors come back in-band, as a result with `isError`, not as a protocol
 * failure, so the model can read the message and act on it.
 *
 * The driver code goes in the text block as well as in `structuredContent`,
 * because it is the only part of a failure that is stable across driver
 * versions, locales and translations. It is appended after the message on the
 * same line, so the first token is still `DATABASE_ERROR:` and the
 * `SUGGESTION:` line is still the last.
 */
function formatError(error, uri) {
  const message = errorMessage(error);
  const kind = classify(error, message);
  const suggestion = (error && error.suggestion) || SUGGESTIONS[kind](error, message, uri);
  const code = error && error.code ? ` [${error.code}]` : '';
  return `DATABASE_ERROR: ${message}${code}\nSUGGESTION: ${suggestion}`;
}

const errorMessage = (error) => (error && error.message ? String(error.message) : String(error));

/**
 * The category of a failure, in the order the information gets more reliable: the
 * concrete `TimeoutError` class, the registry's own `code`, the raised `kind`,
 * and for an error with none of those, the prose table.
 *
 * The `code` check matters because the registry reports a destructive refusal as
 * `kind: 'policy'`, and mapping it to `destructive` is what gets the model advice
 * about the missing flag rather than a pointer at the environment.
 */
function classify(error, message) {
  if (error instanceof TimeoutError) return 'timeout';
  if (error && error.code === 'DESTRUCTIVE') return 'destructive';

  const kind = error && error.kind;
  if (typeof kind === 'string' && ERROR_KINDS.has(kind)) return kind;

  // SQLite's own timeout path throws a plain `Error` built by string
  // interpolation, with no kind and no class, so the checks above cannot see it.
  // Prose matching is right here precisely because nothing else is left to read.
  if (/\btimed out\b|\btimeout\b[^.]*\bexceeded\b|exceeded \d+ ?ms|maxTimeMS|SQLITE_BUSY|database is locked/i.test(message)) {
    return 'timeout';
  }
  if (/\bread-?only mode\b|\bis not read-?only\b/i.test(message)) return 'policy';
  if (/\bnot allowed\b|\ballowlist\b|outside every allowed|private, loopback|scheme "/i.test(message)) return 'policy';
  if (/\bdestructive\b/i.test(message) && /allowDestructive|needs both/i.test(message)) return 'destructive';
  if (/serialize|serializ|circular structure|BigInt/i.test(message)) return 'serialization';
  if (/is not supported|must be|is required|requires |expects |expected |unknown mongo|unknown action/i.test(message)) {
    return 'validation';
  }
  return 'database';
}

const ERROR_KINDS = new Set([
  'validation', 'policy', 'timeout', 'destructive', 'serialization', 'database', 'internal',
]);

/**
 * One message per category, each naming the next step. `database` is also the
 * fallback for anything unclassified, so an unanticipated failure still gets an
 * answer rather than an empty suggestion.
 */
const SUGGESTIONS = {
  validation: () =>
    'The arguments are wrong, not the statement. Fix the argument named above and call again; '
    + 'db_schema will confirm the table and column names, and db_list the profile names. Nothing was executed.',

  policy: (error, message) => {
    // `policy.js` and `registry.js` already name the switch that relaxes their
    // refusals, so the reason is carried through rather than restated.
    if (/read-?only/i.test(message)) {
      return 'Nothing was executed. If the write is genuinely intended, retry with "readOnly": false; '
        + 'if it changes schema or grants, also "allowDestructive": true.';
    }
    return 'Nothing was executed. The refusal above is this server\'s policy rather than the database\'s answer, and it '
      + 'names the environment variable or profile field that relaxes it. db_health reports whether the connection and '
      + 'the role are healthy.';
  },

  timeout: (error) => {
    const ms = Number.isFinite(error?.timeoutMs) ? error.timeoutMs : null;
    return 'The statement ran past its budget and was abandoned. Add a LIMIT, narrow the filter, or raise "timeout"'
      + (ms ? ` above ${ms}ms` : '')
      + '. A recursive CTE in SQLite cannot be interrupted and keeps running until it finishes, so bound one with a LIMIT.';
  },

  destructive: () =>
    'A statement that changes schema or privileges needs BOTH "readOnly": false and "allowDestructive": true, and a '
    + 'profile has to set allowDestructive for this to be true at all. Nothing was executed. Both flags come from the same '
    + 'caller, which stops a single mistaken call and not a determined one; the control that holds is a database role '
    + 'that cannot run the statement.',

  serialization: () =>
    'The driver returned a value this server could not put on the wire: a BigInt, a circular structure or a Buffer. '
    + 'Cast it in the query, or select fewer columns. This is a formatting problem, not a syntax problem, and no amount '
    + 'of rewriting the SQL syntax will fix it.',

  // `internal` is in `ERROR_KINDS` and in the schema's enum, so a failure that
  // carries it reaches this table. Without an entry, the error path itself
  // throws a TypeError about the error.
  internal: () =>
    'This is a fault in this server rather than in the statement, and nothing was executed. The detail is on the '
    + 'server\'s stderr with ANYDB_DEBUG=1. Retrying the same call will not help; the statement and the database are '
    + 'not what is wrong.',

  database: (error, message, uri) => {
    const driver = driverOf(uri) || 'database';
    if (/SQLite support is unavailable/i.test(message)) {
      // The message already says how to fix it, so do not send the caller off
      // to check the query instead.
      return 'This is an installation problem, not a query problem. The other four databases are unaffected.';
    }
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
      return `The ${driver} server could not be reached. Check the host, port, and that the service is running.`;
    }
    if (/ECONNRESET|EPIPE|PROTOCOL_CONNECTION_LOST|socket hang up|server closed the connection/i.test(message)) {
      return `The ${driver} connection was dropped. Nothing after that point ran; call again and the pool will reconnect.`;
    }
    if (/access denied|not authorized|insufficient privilege|password authentication|permission denied|ETIMEDOUT.*auth/i
      .test(message)) {
      return 'Authentication or permissions were rejected. Check the credentials the profile resolves to and the grants '
        + 'held by that role.';
    }
    if (/does not exist|no such table|unknown database|unknown table|ns not found|\b42P01\b|\b42703\b|\b42704\b/i
      .test(message)) {
      return 'The referenced object does not exist. Call db_schema to see what this database actually has before retrying.';
    }
    if (/SQLITE_BUSY|database is locked/i.test(message)) {
      return 'The SQLite file is locked by another process. It is a single-writer database: retry, or write from the '
        + 'process that holds it.';
    }
    return isDebugEnabled()
      ? 'The full stack trace is on the server\'s stderr.'
      : `The ${driver} driver reported this. db_health will say whether the connection and the role are healthy, and `
        + 'ANYDB_DEBUG=1 puts the full stack trace on stderr.';
  },
};

/**
 * The `error` member of a failed `structuredContent`.
 *
 * `code` and `operation` are here because `core/tools.js` *declares* them. The
 * SDK validates `structuredContent` against the tool's `outputSchema`, and
 * `undefined` is not `null` to a validator built from that schema, so both are
 * `?? null` rather than conditionally spread. Both are in the text block too,
 * where a model can read them; the reason is on `formatError`.
 */
function errorField(error, uri) {
  const text = formatError(error, uri);
  return {
    kind: classify(error, errorMessage(error)),
    message: errorMessage(error),
    suggestion: text.slice(text.indexOf('SUGGESTION: ') + 'SUGGESTION: '.length),
    // A driver's own code (`42P01`, `SQLITE_BUSY`, `11000`, `ECONNREFUSED`) or
    // one of this server's. `null` rather than omitted, so the property exists
    // on every failure.
    code: error?.code ?? null,
    // The tool that failed, as the registry named it; `null` for a refusal
    // raised in this file before the registry was called.
    operation: error?.operation ?? null,
  };
}

/**
 * The minimum envelope every tool's `outputSchema` requires, so a failure
 * satisfies the same contract a success does.
 */
const ERROR_DEFAULTS = Object.freeze({
  db_list: { configSource: null, profiles: [] },
  db_query: {
    rows: null, rowCount: 0, truncated: false, bytes: 0, format: 'json',
    profile: null, driver: null, limitReason: null, nextCursor: null, timezone: null, hint: null,
  },
  db_schema: {
    database: 'unknown', rowCount: 0, truncated: false, bytes: 0,
    profile: null, driver: null, limitReason: null, hint: null,
  },
  db_explain: {
    rows: null, rowCount: 0, truncated: false, bytes: 0, format: 'json',
    profile: null, driver: null, limitReason: null, nextCursor: null, timezone: null, hint: null,
  },
  db_health: {
    database: 'unknown', reachable: false, checks: [],
    serverVersion: null, role: null, readOnlyRole: null, objects: {}, pool: {}, drivers: {}, profiles: null,
  },
});

/** A refusal for a name this server does not have. */
function unknownTool(name) {
  const message = `Unknown tool ${JSON.stringify(String(name))}.`;
  return {
    content: [{
      type: 'text',
      text: `UNKNOWN_TOOL: there is no tool called ${JSON.stringify(String(name))} on this server. `
        + `It provides: ${TOOL_NAMES.join(', ')}. Nothing was executed.`,
    }],
    structuredContent: {
      ...ERROR_DEFAULTS.db_query,
      ok: false,
      elapsedMs: 0,
      // Built through `errorField` rather than by hand, so an unknown tool name
      // produces the *same* `error` object shape as every other failure.
      error: errorField(toolError('validation', message,
        `Use one of: ${TOOL_NAMES.join(', ')}. Nothing was executed.`)),
    },
    isError: true,
  };
}

/** A refusal that never reached the registry, listing every problem found. */
function validationFailure(ctx, tool, errors, started) {
  const error = toolError('validation', errors.join(' '),
    'Fix the argument named above and call again. Nothing was executed, and nothing was sent to a database.');
  return failure(ctx, error, tool, started, {}, errors);
}

/**
 * Log a failure, then turn it into the result envelope.
 *
 * This is the `logError` call that makes "see stderr for a full stack trace"
 * true: `logError` puts the message at `error` and the stack at `debug`, which
 * is why the suggestion names `ANYDB_DEBUG=1`.
 *
 * `maskUri` masks the *username* as well as the password, deliberately: in an
 * IAM setup the username is the secret half of the credential.
 */
function reportFailure(ctx, error, tool, callId, started, args, target, signal) {
  ctx.logError(tool, error, {
    uri: maskUri(target?.uri ?? args?.uri ?? ''),
    profile: target?.profileName ?? args?.profile ?? null,
    cancelled: signal?.aborted === true,
  });
  return failure(ctx, error, tool, started, { uri: target?.uri ?? args?.uri }, undefined, callId);
}

/** The `tool_result` half of a pair, so a reader can always see how a call ended. */
function logResult(ctx, callId, tool, fields, started, ok) {
  ctx.log(tool, { ...fields, elapsedMs: elapsedSince(ctx, started), ok }, { event: 'tool_result', callId });
}

/** The result envelope for a failure: the success shape, with `ok: false`. */
function failure(ctx, error, tool, started, context = {}, errors, callId) {
  const text = formatError(error, context.uri);
  const structured = {
    ...(ERROR_DEFAULTS[tool] ?? {}),
    ok: false,
    elapsedMs: elapsedSince(ctx, started),
    error: { ...errorField(error, context.uri), ...(errors ? { details: errors } : {}) },
  };
  if (callId !== undefined) {
    ctx.log(tool, { ok: false, kind: structured.error.kind, elapsedMs: structured.elapsedMs },
      { event: 'tool_result', callId, level: 'warn' });
  }
  return { content: [{ type: 'text', text }], structuredContent: structured, isError: true };
}

/**
 * `ctx.clock()` rather than a bare `Date.now()`, so an elapsed time in a test is
 * a number somebody chose rather than one a machine happened to produce.
 */
const startedAt = (ctx) => ctx.clock();
const elapsedSince = (ctx, started) => Math.max(0, ctx.clock() - started);

/** Copy across only the named keys that are present. */
function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * The `{ profile }` or `{ uri }` a call named, without the resolved connection.
 *
 * What goes back to the registry is always the *name* the model sent. Passing
 * the resolved target would put a credential-bearing URI in front of
 * `resolveTarget` a second time, which makes every profile call look ad-hoc: the
 * profile's own `readOnly`, `maxRows` and `hosts` would be dropped.
 */
function targetSpecOf(args) {
  return typeof args?.profile === 'string' ? { profile: args.profile } : { uri: args?.uri };
}

/**
 * The timeout a call will actually get, for the log line and the progress
 * decision. The registry's own resolution is authoritative; this is the pre-call
 * estimate for the tools that do not resolve a target first.
 */function effectiveTimeout(args) {
  if (Number.isFinite(args?.timeout)) return args.timeout;
  return Number.isFinite(registryModule.DEFAULT_TIMEOUT) ? registryModule.DEFAULT_TIMEOUT : 30000;
}

/** Count the objects in a schema report, for the log line and `db_health`. */
function countObjects(report) {
  const counts = {};
  for (const key of ['tables', 'collections', 'keyspace']) {
    if (Array.isArray(report[key])) counts[key] = report[key].length;
  }
  return counts;
}

/** The lowercased URI scheme, or '' for a string that is not a connection string. */
function schemeOf(uri) {
  if (typeof uri !== 'string') return '';
  const marker = uri.indexOf('://');
  return marker === -1 ? '' : uri.slice(0, marker).toLowerCase();
}

/**
 * The driver a scheme lands on.
 *
 * `registry.js` exports `driverFor` for exactly this, and it is the same function
 * that decides the cache key, so a second alias table here would give `mariadb`
 * and `mongodb+srv` a second place to disagree with the routing.
 */function driverOf(uri) {
  if (typeof registryModule.driverFor === 'function') return registryModule.driverFor(schemeOf(uri));
  return schemeOf(uri);
}

/** A short, non-sequential id so two calls in one log can be told apart. */
function shortCallId() {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Errors that mean the transport is gone rather than that a request was bad.
 *
 * `Protocol._onerror` is `this.onerror?.(error)` and `StdioServerTransport`
 * wires `stdin.on('error')` to it, so an EPIPE when the host closes its end of
 * the pipe arrives here. Discarded, the process holds every pooled socket and
 * serves nothing.
 */
const TRANSPORT_DEAD = /EPIPE|ECONNRESET|ERR_STREAM_DESTROYED|ERR_STREAM_WRITE_AFTER_END|ECONNABORTED|write after end|not writable|closed pipe|Channel closed|EPROTO/i;

/** Log a failure that is about to end the process, repeating the stack at `error`. */
function logFatal(ctx, event, thrown) {
  const error = thrown instanceof Error ? thrown : new Error(String(thrown));
  ctx.logError(event, error, { fatal: true });
  if (typeof error.stack === 'string') {
    ctx.log(error.stack, { error: event }, { level: 'error', event: `${event}.stack` });
  }
}

/**
 * Build the registry, the `Server` and the two request handlers.
 *
 * No side effects, by contract: this reads no file, starts no timer, registers
 * no signal handler, opens no socket and connects nothing. Everything below it is
 * reachable from a test in this process, which is the reason it is split out of
 * `main` at all. It also does not *install* the process handlers, because those
 * are a property of the process rather than of a server.
 *
 * @param {object} [deps]
 * @param {object} [deps.registry] - An `AdapterRegistry`; built from `profileStore` if absent
 * @param {object} [deps.profileStore] - A `ProfileStore` for the registry we build
 * @param {object} [deps.transport] - Defaults to `new StdioServerTransport()`
 * @param {Function} [deps.log] - `log(name, detail, options)`; defaults to `core/logging.js`
 * @param {Function} [deps.logError] - `logError(name, error, detail)`
 * @param {object} [deps.env] - Defaults to `process.env`
 * @param {Function} [deps.clock] - `() => number`; defaults to `() => Date.now()`
 * @param {object} [deps.process] - Defaults to `process`. All **five** process
 *   handlers go here: SIGINT, SIGTERM and `beforeExit` by
 *   `core/connection-cache.js#installShutdownHandlers`, the other two here.
 * @param {string} [deps.version] - Defaults to the `package.json` version
 * @returns {{ server, registry, bridge, ctx, version, progressMs, close, start }}
 */
export function createServer(deps = {}) {
  const log = deps.log ?? defaultLog;
  const logError = deps.logError ?? defaultLogError;
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? (() => Date.now());
  const version = deps.version ?? readVersion();
  const progressMs = positiveInt(env.ANYDB_PROGRESS_MS, DEFAULT_PROGRESS_MS);

  /**
   * `log` is passed in rather than left at the default, because the default is a
   * no-op: the registry's one-off warnings are the records that explain a
   * configuration that does not do what somebody expected. An injected
   * `registry` wins over an injected `profileStore`, because a caller who has
   * already built a registry has already chosen what it reads.
   */
  const registry = deps.registry ?? new registryModule.AdapterRegistry({
    log,
    ...(deps.env === undefined ? {} : { env }),
    ...(deps.profileStore === undefined ? {} : { profiles: deps.profileStore }),
  });

  const server = new Server(
    { name: 'anydb-mcp', version },
    {
      capabilities: { tools: {} },
      // The SDK copies `options.instructions` into the initialize result.
      instructions: INSTRUCTIONS,
    }
  );

  const bridge = registryBridgeFor(registry, log);

  /**
   * The one object every handler reads its dependencies from, so that adding a
   * dependency is not a signature change on five handlers.
   */
  const ctx = { bridge, registry, server, log, logError, clock, version, progressMs };

  installRequestHandlers(server, ctx);

  /**
   * Set here rather than by a caller so that a `Server` built by this function is
   * never missing it: the EPIPE case is the one that leaks every pooled socket.
   */
  server.onerror = (error) => {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    const dead = TRANSPORT_DEAD.test(wrapped.message);
    logError('server', wrapped, { fatal: dead, transport: dead });

    if (dead) {
    // A server that cannot serve is worse than one that stops: a client on a
    // dead pipe cannot tell "busy" from "gone", so it waits out its own timeout
    // and may start a *second* server for one session.
      void ctx.closeAndExit(1);
      return;
    }

    // `server.onerror` exits only for transport-class errors, because the SDK
    // routes a malformed client frame through the same handler. Exiting on those
    // would turn one bad request into a denial of service against the session.
    log('server', { continued: true }, { event: 'server_recovered', level: 'warn' });
  };

  server.onclose = () => {
    // The client is gone. Close the connections so the process does not exit
    // holding sockets, but do not exit here: the SDK is still tearing down, and
    // `process.exit` from a transport callback can truncate a response.
    bridge.close().catch(() => {});
  };

  let shuttingDown = false;
  ctx.closeAndExit = async (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await bridge.close();
    } catch {
      /* exiting anyway */
    }
    deps.process?.exit?.(code);
  };
  ctx.close = ctx.closeAndExit;

  /**
   * The cache reaper, the five process handlers, and the transport. Separated
   * from `createServer` so the order -- reap, then listen for the host going
   * away, then connect -- is visible in one place.
   */
  ctx.start = async () => {
    // The reaper starts before the transport, so a connection cached during the
    // very first call is already covered.
    registry.cache.start?.();

    // Every process handler this server installs, resolved once. A signal handler
    // on the real process cannot be un-installed cleanly by a test.
    const proc = deps.process ?? process;

    // SIGINT, SIGTERM and beforeExit: the host going away, and the only place a
    // clean disconnect of every pooled socket happens.
    installShutdownHandlers(registry.cache, log, proc);

    // uncaughtException and unhandledRejection, alongside the three above: five
    // handlers in all. These two stop the process deliberately rather than
    // limping on with an unknown amount of state, which matters more for
    // `unhandledRejection`, where a rejected promise from a driver nobody
    // awaited is normal and Node's default is to terminate.
    proc.on('uncaughtException', (error) => {
      logFatal(ctx, 'uncaughtException', error);
      void ctx.closeAndExit(1);
    });

    proc.on('unhandledRejection', (reason) => {
      logFatal(ctx, 'unhandledRejection', reason);
      void ctx.closeAndExit(1);
    });

    await server.connect(deps.transport ?? new StdioServerTransport());

    logToolList(ctx);
    log('server ready', { version, debug: isDebugEnabled() });
    return ctx;
  };

  return ctx;
}

/**
 * Record what this server exposes, once, at startup.
 *
 * Not decoration: "the model says the tool does not exist" and "this server is
 * exposing two tools because an old build is installed" present identically, and
 * this line is what tells them apart.
 */function logToolList(ctx) {
  const cache = ctx.registry.cache;
  ctx.log('tool list', {
    tools: TOOLS.length,
    names: TOOL_NAMES.join(','),
    progressMs: ctx.progressMs,
    adHocUri: isAdHocUriAllowed(),
    cache: cache.enabled ? `${cache.maxEntries} conn, ${cache.idleTtlMs}ms idle` : 'off',
  });
}

/**
 * The bin's entry point: `createServer`, then the process wiring, then `connect`.
 *
 * Not called by `createServer`, so importing this module builds a server without
 * starting one. `isDirectRun` at the bottom of the file is what decides.
 */
export async function main(deps = {}) {
  const ctx = createServer(deps);
  await ctx.start();
  return ctx;
}

/**
 * Is this file the process entry point?
 *
 * `bin` and `node src/index.js` both land here and both need the server started.
 * Jest, `import 'anydb-mcp/server'` and any other importer must not get one, or a
 * test that imports a constant would hold a registry, a reaper and a stdio
 * transport for the rest of the run.
 *
 * `realpathSync` on both sides, because npm's bin shim reaches the file through
 * `node_modules`, and on a linked install `process.argv[1]` and `__filename` are
 * two spellings of one file. Anything that throws answers "no".
 */
function isDirectRun() {
  const self = ownPath();
  const entry = process.argv[1];
  if (!self || typeof entry !== 'string' || entry === '') return false;
  try {
    const fromEntry = realpathSync(entry);
    const fromModule = realpathSync(self);
    const fold = (value) => (process.platform === 'win32' || process.platform === 'darwin'
      ? value.toLowerCase()
      : value);
    return fold(fromEntry) === fold(fromModule);
  } catch {
    return false;
  }
}

// The one statement in this file with an effect, and it is guarded.
if (isDirectRun()) {
  main().catch((error) => {
    // A failure before `ctx` exists cannot use its logger, and a server that
    // cannot start is the case where a bare stack beats a structured record.
    process.stderr.write(`[anydb] server failed to start: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
