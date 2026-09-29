import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import { PostgresAdapter } from '../adapters/postgres.js';
import { MongoAdapter } from '../adapters/mongodb.js';
import { SQLiteAdapter } from '../adapters/sqlite.js';
import { RedisAdapter } from '../adapters/redis.js';
import { MySQLAdapter } from '../adapters/mysql.js';
import { TimeoutError, withTimeout, TIMEOUT_GRACE_MS } from './base-adapter.js';
import {
  inspectQuery, inspectDangerousOperators, READ_ONLY_HINT,
  MONGO_ACTIONS, isSqlProtocol, hasMultipleStatements, dollarQuoteDelimiterAt,
} from './safety.js';
import { ConnectionCache } from './connection-cache.js';
import {
  checkConnectionPolicy, classifiesAsDestructive, evaluatePolicy, isAdHocUriAllowed, parseBoolEnv,
} from './policy.js';
import { ProfileStore, loadProfileStore } from './profiles.js';
import { clampResult, buildEnvelope, resolvedTimezone, RESULT_FORMATS } from './result-limits.js';

const DEFAULT_TIMEOUT = 30000;

// A typo here would silently disable the timeout or overflow setTimeout.
const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 24 * 60 * 60 * 1000;

/**
 * Every scheme the registry routes, and the adapter each one lands on. One table,
 * so the routing and the cache key cannot drift: `normaliseCacheKey` collapses
 * through `driverFor`, which reads this.
 *
 * Adding a scheme means four places: this table, `DEFAULT_ALLOWED_SCHEMES` in
 * `./policy.js`, `SCHEME_ALIASES` in `./profiles.js`, and `isSqlProtocol` in
 * `./safety.js`.
 */
export const ROUTES = Object.freeze([
  Object.freeze({
    driver: 'postgres',
    schemes: Object.freeze(['postgres', 'postgresql']),
  }),
  Object.freeze({
    driver: 'mysql',
    // `mariadb` is MariaDB's own scheme and the `+` forms are SQLAlchemy's. All
    // land on one pool: the driver name is the cache key.
    schemes: Object.freeze([
      'mysql', 'mariadb',
      'mysql+pymysql', 'mysql+mysqldb', 'mysql+asyncmy', 'mysql+aiohttp',
      'mysql+aiomysql', 'mysql+cymysql',
      'mariadb+pymysql', 'mariadb+mariadbconnector',
    ]),
  }),
  Object.freeze({
    driver: 'mongodb',
    schemes: Object.freeze(['mongodb', 'mongodb+srv']),
  }),
  Object.freeze({
    driver: 'sqlite',
    schemes: Object.freeze(['sqlite', 'sqlite+pysqlite']),
  }),
  Object.freeze({
    driver: 'redis',
    // `redis-cluster` and `redis-sentinel` were here until 3.0.4. The adapter
    // still implements them, and correctly, but `redis@6` cannot serve a command
    // from either topology - a cluster routes by slot and a keyless command has
    // none, and a sentinel set asks the master for the sentinel list. Measured
    // with no code of ours in the path; see DEFAULT_ALLOWED_SCHEMES for the
    // output. Kept out of both lists so the scheme is refused once, with one
    // sentence, instead of reaching a driver that will fail three different ways.
    schemes: Object.freeze(['redis', 'rediss']),
  }),
]);

/** Every scheme the registry knows, in one flat list, for error messages. */
export const SUPPORTED_PROTOCOLS = Object.freeze(ROUTES.flatMap((route) => [...route.schemes]));

const DRIVER_BY_SCHEME = new Map(ROUTES.flatMap((route) => route.schemes.map((scheme) => [scheme, route.driver])));

/** The driver a scheme collapses to, so `postgres://` and `postgresql://` are one server. */
export const driverFor = (protocol) => DRIVER_BY_SCHEME.get(String(protocol || '').toLowerCase()) ?? String(protocol || '');

/**
 * Every error this module throws carries a machine-readable `kind`, so a caller
 * chooses what to say without matching English prose.
 */
export const ERROR_KINDS = Object.freeze([
  'validation', 'policy', 'timeout', 'database', 'serialization', 'internal',
]);

/**
 * An error carrying the facts a caller needs rather than only a sentence.
 * `facts` is `{ kind, code, operation, timeoutMs, cause }`.
 */
export function registryError(message, facts = {}) {
  const error = new Error(message, facts.cause ? { cause: facts.cause } : undefined);
  error.kind = facts.kind || 'internal';
  if (facts.code !== undefined) error.code = facts.code;
  if (facts.operation !== undefined) error.operation = facts.operation;
  if (facts.timeoutMs !== undefined) error.timeoutMs = facts.timeoutMs;
  return error;
}

// Eviction needs a positive signal: a socket errno, a driver code, or a SQLSTATE
// that means the session is gone. A server-side statement timeout is not one,
// except the two below; MongoDB's `50` is excluded because a `maxTimeMS` abort
// leaves the socket usable.
const DEAD_CODES = new Set([
  // Node socket errors.
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENETRESET', 'EHOSTDOWN', 'ENOTFOUND',
  'EAI_AGAIN', 'EADDRNOTAVAIL', 'EISCONN', 'EPROTO', 'UNEXPECTED_EOF', 'EPROTO',
  // PostgreSQL: the session is gone, or cannot be used.
  'PROTOCOL_CONNECTION_LOST', '57P01', '57P02', '57P03', '08000', '08001', '08003',
  '08004', '08006', '08007', '08P01', '53300',
  // Reusable in principle, but a half-cancelled statement is not a state worth
  // reasoning about, so it is torn down anyway.
  '57014',
  // mysql2.
  'ER_QUERY_TIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT', 'PROTOCOL_ENQUEUE_AFTER_DESTROY',
  // MongoDB.
  'ClientClosedError', 'SocketClosedUnexpectedlyError', 'MongoNetworkError',
  'MongoNetworkTimeoutError', 'MongoNotConnectedError', 'MongoServerSelectionError',
  'MongoTopologyClosedError', 'MongoTopologyDestroyedError',
  // SQLite.
  'SQLITE_INTERRUPT', 'SQLITE_IOERR', 'SQLITE_PROTOCOL', 'SQLITE_NOTADB',
]);

// `err.name` values, for drivers that put the class name there.
const DEAD_NAMES = new Set([
  'ClientClosedError', 'SocketClosedUnexpectedlyError', 'MongoNetworkError',
  'MongoNetworkTimeoutError', 'MongoNotConnectedError', 'MongoServerSelectionError',
  'MongoTopologyClosedError', 'MongoTopologyDestroyedError',
]);

/**
 * The error's own code, or one from the chain of causes behind it.
 *
 * Adapters rewrite driver errors and keep the original as `cause`, so a
 * PostgreSQL `57014` is one link down. Bounded at four links, and cycle-safe:
 * `Error.cause` is writable.
 */
function errorCodeOf(error) {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const code = current.code ?? current.errno;
    if (typeof code === 'string' || typeof code === 'number') return code;
    current = current.cause;
  }
  return undefined;
}

/** The code as an upper-case string, or ''. Numbers are kept: MongoDB's are numeric. */
const codeKey = (error) => {
  const code = errorCodeOf(error);
  if (typeof code === 'string') return code.toUpperCase();
  if (typeof code === 'number') return String(code);
  return '';
};

// Phrasings that mean the connection is *gone*, for errors carrying no code. The
// timeout phrasings are deliberately absent: `TIMEOUT_CODES` and the `TimeoutError`
// check cover those and are narrower.
const DEAD_MESSAGES = [
  /\bconnection (?:closed|terminated|reset|refused|lost)\b/i,
  /\bserver closed the connection\b/i,
  /\bterminating connection due to administrator command\b/i,
  /\bthis socket has been ended by the other party\b/i,
  /\bconnection not open\b/i,
  /\bconnection pool (?:was )?(?:ended|closed)\b/i,
  // The Node socket errnos, for an error that carries a message but no `code`.
  /\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/,
];

/** Whether the connection an error came from can no longer be trusted. */
export function isDeadConnectionError(error) {
  if (!error) return false;
  if (error instanceof TimeoutError) return true;

  if (DEAD_CODES.has(codeKey(error))) return true;
  if (typeof error.name === 'string' && DEAD_NAMES.has(error.name)) return true;

  const message = typeof error.message === 'string' ? error.message : String(error);
  return DEAD_MESSAGES.some((pattern) => pattern.test(message));
}

// A timeout this process raises is a `TimeoutError`. A timeout the *server* raises
// arrives as a code: `57014` is PostgreSQL `query_canceled`, `ER_QUERY_TIMEOUT`
// is MySQL `max_execution_time`, `50` is MongoDB `maxTimeMS`, `SQLITE_INTERRUPT`
// an interrupted SQLite statement.
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ER_QUERY_TIMEOUT', 'SQLITE_INTERRUPT', '57014', '50']);

/** Whether an error is a timeout. Exported so `src/index.js` cannot disagree. */
export function isTimeoutError(error) {
  if (!error) return false;
  if (error instanceof TimeoutError) return true;
  if (error.name === 'TimeoutError') return true;
  return TIMEOUT_CODES.has(codeKey(error));
}

// A `JSON.stringify` failure, or a driver's own serialisation error. `TypeError`
// is the tell: a BigInt, a circular structure and a stack overflow all arrive
// as one.
const SERIALIZATION_MESSAGES = /circular structure|do not know how to serialize|max(?:imum)? call stack size exceeded|converting .* to json|invalid string length|unsupported value in json|json stringify/i;

/**
 * Whether an error is a result that would not turn into JSON, rather than a
 * statement the database refused. With `normalizeForJson` in place this is a
 * backstop for a driver that throws on its own path.
 */
export function isSerializationError(error) {
  if (!error) return false;
  if (error instanceof TypeError) return true;
  const message = typeof error.message === 'string' ? error.message : String(error);
  return SERIALIZATION_MESSAGES.test(message);
}

/** Suggestion text per `error.kind`, with `{driver}` / `{protocol}` substituted. */
export const ERROR_KIND_SUGGESTIONS = Object.freeze({
  validation:
    'The request was rejected before anything was sent to the database. Fix the argument named in the message and retry.',
  policy:
    'The statement was not executed, because a safety or connection-policy check refused it. The message says which check and why; '
    + 'change the policy deliberately rather than by retrying.',
  timeout:
    'The server did not respond within the timeout. Narrow the query, add a LIMIT, or raise the "timeout" argument.',
  serialization:
    'The statement ran, but the result could not be turned into JSON. That is a driver or result-type problem rather than a syntax problem: '
    + 'select fewer columns, add a LIMIT, or cast the offending column to text in the query.',
  database:
    'Check the {driver} syntax and that the object exists. Set ANYDB_DEBUG=1 for a full stack trace.',
  internal:
    'This is a bug in anydb-mcp, not in the statement. Set ANYDB_DEBUG=1 for a full stack trace and please report the message above.',
});

/** The suggestion for an error, by `error.kind`. Exported so `src/index.js` never guesses. */
export function suggestionFor(error, context = {}) {
  const protocol = context.protocol || 'database';
  const driver = context.driver || protocol;
  const template = ERROR_KIND_SUGGESTIONS[error?.kind] ?? ERROR_KIND_SUGGESTIONS.database;
  return template.replaceAll('{driver}', driver).replaceAll('{protocol}', protocol);
}

/**
 * Attach the machine-readable facts to any error that lacks them. Called on
 * everything leaving `run()` / `describe()`; returns the same error.
 *
 * @param {object} context - `{ operation, protocol, driver, timeoutMs }`
 */
export function classifyError(error, context = {}) {
  if (!error || typeof error !== 'object') return error;

  if (!error.kind) {
    if (isTimeoutError(error)) error.kind = 'timeout';
    else if (isSerializationError(error)) error.kind = 'serialization';
    else error.kind = 'database';
  }

  if (error.operation === undefined && context.operation) error.operation = context.operation;
  if (error.timeoutMs === undefined && Number.isFinite(context.timeoutMs) && error.kind === 'timeout') {
    error.timeoutMs = context.timeoutMs;
  }
  if (error.code === undefined) {
    // From the cause chain, not from `error` alone: a rewritten driver error
    // keeps the original as `cause`.
    const code = errorCodeOf(error);
    if (typeof code === 'string' || typeof code === 'number') error.code = code;
  }
  if (context.driver && error.driver === undefined) error.driver = context.driver;

  return error;
}

/**
 * The cache key for a URI: the driver name plus a truncated SHA-256 of the URI
 * with the scheme already collapsed.
 *
 * The digest is not a secret and does not need to be — a rotated password gives a
 * different key, hence a new connection — but a raw URI as the key would hold the
 * plaintext password in a `Map` for the whole idle TTL.
 */
export function normaliseCacheKey(uri, protocol) {
  const driver = driverFor(protocol);
  // The scheme is rewritten to the driver *and* hashed, or two spellings of one
  // server would get two keys. A SQLite URI is left alone: its path is the
  // database.
  const text = typeof uri === 'string' ? uri : String(uri);
  const marker = text.indexOf('://');
  const canonical = marker === -1
    ? text
    : `${driver}://${text.slice(marker + 3)}`;
  return `${driver}::${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

/**
 * Remove comments and string literals while KEEPING quoted identifiers intact.
 * `stripSqlNoise` in `./safety.js` cannot be used: it rewrites every quoted
 * identifier to the word `identifier`.
 *
 * Dollar quoting is not optional, for the opposite reason to `safety.js`: there,
 * not knowing about `$tag$` let a write hide; here it hides a *table reference*
 * from the allowlist. A scanner that opens a literal at the quote inside a body
 * finds no partner and swallows the rest of the statement, so a real
 * `FROM secrets` is never scanned. The quote need not be balanced.
 *
 * @param {boolean} [backslashEscapes] - The MySQL family only
 * @param {boolean} [dollarQuoting] - PostgreSQL only
 */
export function stripLiterals(sql, backslashEscapes = false, dollarQuoting = false) {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if ((ch === '-' && next === '-') || ch === '#') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      out += ' ';
      continue;
    }
    if (dollarQuoting && ch === '$' && !/[A-Za-z0-9_$\u0080-\uFFFF]$/.test(out)) {
      const delimiter = dollarQuoteDelimiterAt(sql, i);
      if (delimiter) {
        const end = sql.indexOf(delimiter, i + delimiter.length);
        out += " '' ";
        i = end === -1 ? n : end + delimiter.length;
        continue;
      }
    }
    if (ch === "'") {
      i++;
      while (i < n) {
        if (backslashEscapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += " '' ";
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}
/** One quoted or bare SQL identifier. */
const IDENTIFIER_SOURCE = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[[^\\]]*\\]|[A-Za-z_][\\w$]*)';
const UNQUOTE_IDENTIFIER = /^(?:"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\])$/;

const unquoteIdentifier = (raw) => {
  const match = UNQUOTE_IDENTIFIER.exec(raw);
  if (!match) return raw;
  const body = match[1] ?? match[2] ?? match[3] ?? '';
  return match[1] !== undefined ? body.replaceAll('""', '"') : (match[2] !== undefined ? body.replaceAll('``', '`') : body);
};

// The keywords a table reference can follow. `USING` is absent because in a join
// `USING (column)` names a column, and `DELETE` is absent because it is always
// followed by `FROM`, which made `DELETE FROM secrets.t` parse as a reference to a
// table called `FROM`.
const SQL_TABLE_KEYWORDS = ['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'TRUNCATE'];

/**
 * Find the table references in a statement.
 *
 * A `(` after one of the keywords is a subquery, found on the next pass; an
 * identifier followed by `=` is a column assignment, which is what keeps MySQL's
 * `ON DUPLICATE KEY UPDATE col = 1` from being read as a table called `col`.
 *
 * @param {string} cleaned - Statement with comments and literals removed
 * @returns {Array<{ schema: string|null, table: string, text: string }>}
 */
export function collectTableReferences(cleaned) {
  const found = [];
  const pattern = new RegExp(
    `\\b(?:${SQL_TABLE_KEYWORDS.join('|')})\\s+(${IDENTIFIER_SOURCE})(?:\\s*\\.\\s*(${IDENTIFIER_SOURCE}))?(?!\\s*=)`,
    'gi'
  );

  let match = pattern.exec(cleaned);
  while (match !== null) {
    // The first identifier is the schema when a second follows: `app.users`.
    const schema = match[2] === undefined ? null : unquoteIdentifier(match[1]);
    const table = schema === null ? unquoteIdentifier(match[1]) : unquoteIdentifier(match[2]);
    found.push({ schema, table, text: schema ? `${schema}.${table}` : table });
    match = pattern.exec(cleaned);
  }

  return found;
}

const asList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []);

const foldsEqual = (a, b) => a.toLowerCase() === b.toLowerCase() || a === b;

/** Whether `name` is in `allowlist`, comparing case-insensitively. `*` allows all. */
const allowedBy = (allowlist, name) =>
  allowlist.some((entry) => entry === '*' || foldsEqual(entry, name));

/** Every `ANYDB_*` variable `describeConfiguration()` reports on. */
export const REPORTED_ENV = Object.freeze([
  'ANYDB_ALLOW_ADHOC_URI', 'ANYDB_ALLOWED_SCHEMES', 'ANYDB_ALLOWED_HOSTS',
  'ANYDB_ALLOW_PRIVATE_HOSTS', 'ANYDB_ALLOW_DESTRUCTIVE', 'ANYDB_DEFAULT_READ_ONLY',
  'ANYDB_MAX_ROWS', 'ANYDB_MAX_BYTES', 'ANYDB_DEFAULT_MAX_ROWS', 'ANYDB_DEFAULT_MAX_BYTES',
  'ANYDB_DEFAULT_QUERY_TIMEOUT_MS', 'ANYDB_DEFAULT_CONNECT_TIMEOUT_MS',
  'ANYDB_STRICT_SQLITE_PATHS', 'ANYDB_ALLOWED_SQLITE_PATHS',
  'ANYDB_CACHE', 'ANYDB_CACHE_MAX', 'ANYDB_CACHE_TTL_MS',
  'ANYDB_CONFIG', 'ANYDB_HOME', 'ANYDB_DEBUG', 'ANYDB_KEYCHAIN_CMD',
]);

/** Masked: `ANYDB_KEYCHAIN_CMD` carries a vault service name, and that is half a credential. */
const MASKED_ENV = new Set(['ANYDB_KEYCHAIN_CMD']);

/** The npm package each driver comes from, for the health report. */
const DRIVER_PACKAGES = Object.freeze({
  postgres: 'pg',
  mysql: 'mysql2',
  mongodb: 'mongodb',
  redis: 'redis',
  sqlite: 'sqlite3',
});

/**
 * A `require` rooted at this package, for the driver probe. Seeded from
 * `__filename`, not `import.meta.url`: the test harness compiles this file to
 * CommonJS with babel, where `import.meta` is a syntax error.
 */
const requireFromHere = (() => {
  const seed = typeof __filename === 'string' && __filename !== ''
    ? __filename
    : (process.argv[1] || path.join(process.cwd(), 'index.js'));
  try {
    return createRequire(seed);
  } catch {
    return createRequire(path.join(process.cwd(), 'index.js'));
  }
})();

/**
 * Load each driver once, to say whether it is usable. `require`, not
 * `require.resolve`: `sqlite3` is native, and an install that skipped its build
 * script resolves fine and still fails to load.
 */
function probeDrivers() {
  const require = requireFromHere;
  const out = {};
  for (const [driver, pkg] of Object.entries(DRIVER_PACKAGES)) {
    try {
      require(pkg);
      out[driver] = { module: pkg, available: true, binding: 'loaded', error: null };
    } catch (error) {
      out[driver] = {
        module: pkg,
        available: false,
        // A native module that resolves but will not load needs a different fix
        // from one that is not installed.
        binding: error && (error.code === 'ERR_DLOPEN_FAILED' || error.code === 'MODULE_NOT_FOUND') ? 'failed' : 'unknown',
        error: error ? String(error.code || error.message).slice(0, 200) : 'unknown error',
      };
    }
  }
  return out;
}

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** The result formats `db_query` / `db_schema` accept. */
export const FORMATS = RESULT_FORMATS;

/** One message a caller can act on, for a missing or duplicated target. */
const TARGET_HINT =
  'Pass "profile" with a name from ~/.anydb/db.json, or "uri" with a connection string such as '
  + 'postgres://user:pass@host:5432/db. Exactly one of the two, not both.';

export class AdapterRegistry {
  /**
   * @param {object} [options]
   * @param {Function} [options.poolClass] - `pg.Pool`; injected by tests
   * @param {Function} [options.clientClass] - `MongoClient`
   * @param {Function} [options.databaseClass] - `sqlite3.Database`
   * @param {Function} [options.redisClientClass] - `redis` client
   * @param {Function} [options.mysqlConnectionClass] - `mysql2` pool
   * @param {ConnectionCache} [options.cache]
   * @param {ProfileStore} [options.profiles] - The `db.json` store
   * @param {object} [options.env] - Defaults to `process.env`
   * @param {Function} [options.log] - `log(message, detail)`; never a secret
   * @param {string} [options.platform] - Defaults to `process.platform`
   * @param {object} [options.dns] - `dns/promises`-shaped resolver
   * @param {'enforce'|'off'} [options.connectionPolicy] - See
   *   `isConnectionPolicyStrict()`; defaults to that rule.
   *
   * The deprecated six-positional form is still accepted, detected by a function
   * in first position or by extra arguments; a `ConnectionCache` in first
   * position is read as `{ cache }`.
   */
  constructor(options = {}, ...positional) {
    if (options instanceof ConnectionCache) {
      // The six-positional form puts the cache sixth, so this is not that.
      options = { cache: options };
    } else if (positional.length > 0 || typeof options === 'function') {
      const [poolClass, clientClass, databaseClass, redisClientClass, mysqlConnectionClass, cache] =
        typeof options === 'function' ? [options, ...positional] : positional;
      options = {
        poolClass, clientClass, databaseClass, redisClientClass, mysqlConnectionClass, cache,
      };
    }

    this.poolClass = options.poolClass;
    this.clientClass = options.clientClass;
    this.databaseClass = options.databaseClass;
    this.redisClientClass = options.redisClientClass;
    this.mysqlConnectionClass = options.mysqlConnectionClass;

    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.log = typeof options.log === 'function' ? options.log : () => {};

    // The cache reads `process.env` for its own bounds, so an injected environment
    // is handed the three settings it looks at rather than ignored.
    this.cache = options.cache ?? new ConnectionCache({
      maxEntries: this.env.ANYDB_CACHE_MAX,
      idleTtlMs: this.env.ANYDB_CACHE_TTL_MS,
      ...(this.env.ANYDB_CACHE === undefined ? {} : { enabled: this.env.ANYDB_CACHE !== '0' }),
    });
    this._warned = new Set();
    this.connectionPolicy = options.connectionPolicy;

    // Loaded eagerly but never more than once: a `db.json` that will not parse has
    // to fail at the call that uses it, and `db_health` needs the count.
    this.profiles = options.profiles ?? new ProfileStore({
      env: this.env,
      platform: this.platform,
      log: this.log,
    });
    this._profilesError = null;
    if (options.profiles === undefined) {
      try {
        this.profiles.load();
      } catch (error) {
        // Reported per call, not thrown: that would take down a server that could
        // still serve anyone passing ad-hoc URIs. Remembered, because `load()`
        // marks itself loaded before it reads the file.
        this._profilesError = String(error && error.message);
        this.log('anydb config could not be read', { error: this._profilesError });
      }
    }

    // One factory per *scheme*, built from ROUTES so the routing and the cache key
    // cannot drift. `mapping` is public: callers read it to ask what a scheme
    // reaches.
    //
    // Synchronous, which is what keeps the *drivers* out of the import path — this
    // module, and `src/lib.js` with it, imports without a database driver loaded.
    // An async factory would move the load into the query path, inside the
    // caller's timeout budget. Laziness lives one level down instead:
    // `MongoAdapter` and `RedisAdapter` resolve their own import in `connect()`.
    this.mapping = {
      postgres: (timeout) => new PostgresAdapter(this.poolClass, timeout),
      mysql: (timeout) => new MySQLAdapter(this.mysqlConnectionClass, timeout),
      mongodb: (timeout) => new MongoAdapter(this.clientClass, timeout),
      sqlite: (timeout) => new SQLiteAdapter(this.databaseClass, timeout),
      redis: (timeout) => new RedisAdapter(this.redisClientClass, timeout),
    };
    for (const route of ROUTES) {
      for (const scheme of route.schemes) {
        this.mapping[scheme] = this.mapping[route.driver];
      }
    }

    this.dns = options.dns;
    this._driverProbe = null;
  }

  /** The scheme→driver table, for a caller that wants to resolve a URI itself. */
  protocolMap() {
    return new Map(SUPPORTED_PROTOCOLS.map((scheme) => [scheme, driverFor(scheme)]));
  }

  /**
   * Fold the two ways of naming a target into one shape. `options.profile` only
   * fills a gap: an explicit `profile` on the target wins, so a spread cannot
   * silently blank it.
   */
  targetSpec(target, options = {}) {
    const spec = isPlainObject(target) ? { ...target } : { uri: target };
    if (spec.profile === undefined && options.profile !== undefined) {
      spec.profile = options.profile;
    }
    return spec;
  }

  /**
   * Resolve what a call is aimed at: a named profile, or a raw URI.
   *
   * Exactly one of the two. Both is refused because the sources carry different
   * policies and silently picking one is how a caller ends up with the weaker.
   * This is the point of `db.json`: a raw `uri` on every call puts the plaintext
   * password in the model's context window and in the client's transcript. A raw
   * `uri` is accepted only when `isAdHocUriAllowed(env)` says so.
   *
   * @param {object} [options] - Per-call options. `query` and `protocol` are
   *   folded into the policy evaluation, so the destructive verdict is computed
   *   against the statement about to run.
   * @returns {Promise<{ uri: string, policy: object, profileName: string|null,
   *   options: object, entry: object|null }>} `options` is the effective per-call
   *   options; `entry` is the profile entry, or null for an ad-hoc URI.
   */
  async resolveTarget(target, options = {}) {
    const callOptions = isPlainObject(options) ? options : {};
    const asTarget = isPlainObject(target) ? target : { uri: target };
    const namedProfile = typeof asTarget.profile === 'string' && asTarget.profile !== '' ? asTarget.profile : null;
    const rawUri = typeof asTarget.uri === 'string' && asTarget.uri !== '' ? asTarget.uri : null;

    if (namedProfile && rawUri) {
      throw registryError(
        `Both "profile" ("${namedProfile}") and "uri" were supplied. A profile already carries its own connection string. ${TARGET_HINT}`,
        { kind: 'validation' }
      );
    }
    if (!namedProfile && !rawUri) {
      throw registryError(`Missing target: no "profile" and no "uri" was supplied. ${TARGET_HINT}`, {
        kind: 'validation',
      });
    }

    let uri;
    let profileName = null;
    let entry = null;
    let profileOptions = {};

    if (namedProfile) {
      let resolved;
      try {
        resolved = await this.profiles.resolve(namedProfile, {
          env: this.env, log: this.log, platform: this.platform,
        });
      } catch (error) {
        // `ProfileStore` writes a good message; all that is missing is the
        // machine-readable half, which is this module's job.
        throw registryError(error.message, {
          kind: 'validation',
          code: 'PROFILE_UNAVAILABLE',
          cause: error,
        });
      }
      uri = resolved.uri;
      profileName = resolved.name;
      entry = this.profiles.getEntry(namedProfile);
      profileOptions = resolved.options ?? {};
    } else {
      if (!isAdHocUriAllowed(this.env)) {
        throw registryError(
          'Ad-hoc connection strings are disabled on this server (ANYDB_ALLOW_ADHOC_URI=0), so every statement has to name a profile. '
          + 'Create a profile in ~/.anydb/db.json — for example '
          + '{"profiles":{"local":{"driver":"sqlite","path":"./app.db"}}} — and pass "profile": "local" instead. '
          + 'Set ANYDB_ALLOW_ADHOC_URI=1 to turn this check off.',
          { kind: 'policy', code: 'ADHOC_URI_DISABLED' }
        );
      }
      uri = rawUri;
    }

    const protocol = this.extractProtocol(uri);
    const effective = { ...profileOptions, ...callOptions, protocol };

    // `evaluatePolicy` reconciles defaults, environment, profile and call
    // arguments, so the precedence is not repeated here. The protocol goes in
    // explicitly because `entry.driver` alone is not enough: a `mariadb` profile
    // would be classified against a scheme `policy.js` does not know, and "not
    // classifiable" reads as "not destructive".
    const policy = evaluatePolicy(entry, {
      query: typeof callOptions.query === 'string' ? callOptions.query : undefined,
      options: effective,
      env: this.env,
    });

    return { uri, policy, profileName, options: effective, entry };
  }

  /** The profiles, as the model sees them: names, descriptions and no credentials. */
  listProfiles() {
    return this.profiles.list();
  }

  /**
   * Run one statement. Every gate runs before a socket is opened, so a refused
   * statement opens no connection.
   *
   * `validateQuery` runs *after* the safety gates on purpose: the semicolon scan
   * counts a `;` inside a PostgreSQL dollar-quoted body, so `DO $$ … ; … $$` would
   * be refused as "multiple statements" and the code-execution gate would never
   * see it. `validate()` still runs all of it, in this order, for a direct caller.
   *
   * @param {string|{profile?: string, uri?: string}} target - A connection
   *   string, or `{ profile }` / `{ uri }`
   * @param {string} query - SQL, MongoDB filter or pipeline JSON, or a Redis command
   * @returns {Promise<object>} The response envelope — see `buildEnvelope`
   */
  async run(target, query, options = {}) {
    const callOptions = isPlainObject(options) ? options : {};
    const startedAt = process.hrtime.bigint();

    const { uri, policy, profileName, options: effective, entry } =
      await this.resolveTarget(this.targetSpec(target, callOptions), { ...callOptions, query });

    // `mariadb` and `mongodb+srv` reach the guards collapsed to a protocol they
    // know; `safety.js` classifies on a fixed set of schemes and would otherwise
    // answer "cannot be verified" for an ordinary MariaDB query.
    const protocol = effective.protocol;
    const guardProtocol = driverFor(protocol);
    const operation = 'db_query';
    const timeout = this.resolveTimeout(options, policy);

    this.assertAdapter(protocol);
    this.validateScalars(effective);
    this.assertQueryIsPresent(query);

    // Unconditional: `readOnly:false` is an opt-in to modify data, not to run
    // code on the database host. `COPY ... TO/FROM PROGRAM` spawns a shell, `DO`
    // runs an anonymous PL/pgSQL block, and MongoDB's `$where` / `$function` /
    // `$accumulator` / `$expr` take a JavaScript body.
    //
    // Defence in depth, not a boundary. The control is the role the database
    // authenticates as: nothing in JavaScript can enforce that.
    const dangerous = inspectDangerousOperators(guardProtocol, query, effective);

    // The read-only gate goes first because its message is the more specific one
    // when both refuse: `{"$where":"1"}` is a write, so the read-only verdict is
    // what the caller needs, with the code-execution verdict appended to it.
    if (this.resolveReadOnly(options, policy)) {
      const verdict = inspectQuery(guardProtocol, query, effective);
      if (!verdict.safe) {
        const both = dangerous.safe
          ? ''
          : ` It is also refused in every mode, because ${dangerous.reason}.`;
        throw registryError(
          `Read-only mode: this statement was blocked because ${verdict.reason}.${both} ${READ_ONLY_HINT}`,
          { kind: 'policy', code: 'READ_ONLY', operation }
        );
      }
    }

    if (!dangerous.safe) {
      throw registryError(
        `Refused: this statement was blocked because ${dangerous.reason}. `
        + 'This is not a read-only check: it applies with readOnly:false too, because opting in to write a row is not opting in to run code on the database host. '
        + 'The control that actually enforces this is the database role — remove EXECUTE on COPY from the login, or remove CREATE on the schema.',
        { kind: 'policy', code: 'CODE_EXECUTION', operation }
      );
    }

    this.validateQuery(query, guardProtocol, effective);

    await this.assertConnectionAllowed(uri, entry, operation);

    this.assertDestructiveAllowed(query, guardProtocol, effective, policy, operation);
    this.assertSqlAllowlist(query, guardProtocol, policy, operation);

    try {
      const data = await this.withConnection(
        uri,
        protocol,
        timeout,
        // The resolved timeout travels in the options, not on the adapter: a cached
        // adapter is shared by concurrent callers.
        (adapter) => adapter.execute(query, { ...effective, timeout }),
        operation
      );

      return buildEnvelope(clampResult(data, { maxRows: policy.maxRows, maxBytes: policy.maxBytes, env: this.env }), {
        elapsedMs: sinceMs(startedAt),
        profile: profileName,
        driver: driverFor(protocol),
        timezone: resolvedTimezone(),
        nextCursor: nextCursorOf(data),
      });
    } catch (error) {
      throw classifyError(error, { operation, protocol, driver: driverFor(protocol), timeoutMs: timeout });
    }
  }

  /**
   * Describe a database. Caller input is bound as a parameter wherever the driver
   * allows it, so the read-only guard has no user query to inspect — but the
   * connection policy still runs, because `db_schema` opens a socket too.
   *
   * @param {object} [options] - `{ table, collection, timeout }`
   * @returns {Promise<object>} The response envelope; `rows` is the description
   */
  async describe(target, options = {}) {
    const callOptions = isPlainObject(options) ? options : {};
    const startedAt = process.hrtime.bigint();

    const { uri, policy, profileName, options: effective, entry } =
      await this.resolveTarget(this.targetSpec(target, callOptions), callOptions);

    const protocol = effective.protocol;
    const operation = 'db_schema';
    const timeout = this.resolveTimeout(options, policy);

    this.assertAdapter(protocol);
    this.validateSchemaOptions(effective);

    this.assertConnectionAllowed(uri, entry, operation);

    try {
      const data = await this.withConnection(
        uri,
        protocol,
        timeout,
        (adapter) => adapter.describe({ ...effective, timeout }),
        operation
      );

      return buildEnvelope(clampResult(data, { maxRows: policy.maxRows, maxBytes: policy.maxBytes, env: this.env }), {
        elapsedMs: sinceMs(startedAt),
        profile: profileName,
        driver: driverFor(protocol),
        timezone: resolvedTimezone(),
      });
    } catch (error) {
      throw classifyError(error, { operation, protocol, driver: driverFor(protocol), timeoutMs: timeout });
    }
  }

  /**
   * Whether a refused `checkConnectionPolicy` verdict is fatal.
   *
   * The check always runs, before any socket is opened; this decides only whether
   * to refuse or to log once and continue. The default is fail-open, because a
   * control that breaks `localhost` on the day it appears gets switched off rather
   * than configured. Same trade `./policy.js` makes for SQLite paths, inverted by
   * `ANYDB_STRICT_SQLITE_PATHS`.
   *
   * @param {object} [options] - `{ connectionPolicy: 'enforce' | 'off' }`
   * @param {object|null} [entry] - The profile entry the target came from
   */
  isConnectionPolicyStrict(options = {}, entry = null) {
    const override = options.connectionPolicy ?? this.connectionPolicy;
    if (override === 'enforce') return true;
    if (override === 'off') return false;
    if (entry !== null && entry !== undefined) return true;
    if (parseBoolEnv(this.env.ANYDB_ALLOW_ADHOC_URI, true) === false) return true;
    return [
      'ANYDB_ALLOWED_HOSTS', 'ANYDB_ALLOWED_SCHEMES', 'ANYDB_ALLOW_PRIVATE_HOSTS',
      'ANYDB_STRICT_SQLITE_PATHS', 'ANYDB_ALLOWED_SQLITE_PATHS',
    ].some((name) => typeof this.env[name] === 'string' && this.env[name].trim() !== '');
  }

  /**
   * Run `checkConnectionPolicy` and act on the verdict.
   *
   * The non-strict pass skips the host checks and only those: the scheme
   * allowlist, the SQLite path allowlist, the profile's `hosts` and
   * `ANYDB_ALLOWED_HOSTS` are pure functions of the URI and the environment, and
   * are still enforced. Only the DNS round trip is dropped.
   *
   * @param {object|null} entry - The profile entry, for its `hosts` / `allowedPaths`
   */
  async assertConnectionAllowed(uri, entry, operation) {
    const strict = this.isConnectionPolicyStrict({}, entry);
    const env = strict ? this.env : { ...this.env, ANYDB_ALLOW_PRIVATE_HOSTS: '1' };

    const verdict = await checkConnectionPolicy(uri, {
      env,
      profile: entry,
      log: this.log,
      platform: this.platform,
      ...(this.dns ? { dns: this.dns } : {}),
    });
    if (verdict.allowed) return;

    if (strict) {
      throw registryError(`Refused by the connection policy: ${verdict.reason}`, {
        kind: 'policy',
        code: 'CONNECTION_POLICY',
        operation,
      });
    }

    this.warnOnce(
      'connection-policy',
      'a connection string was refused by the connection policy, and this server is not enforcing that check',
      {
        scheme: verdict.scheme,
        host: verdict.host,
        reason: verdict.reason,
        hint: 'set ANYDB_ALLOW_ADHOC_URI=0, or ANYDB_ALLOW_PRIVATE_HOSTS=1 for a database on localhost, to enforce it',
      }
    );
  }

  /** One warning per key per process, through the injected logger. */
  warnOnce(key, message, detail = {}) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this.log(message, detail);
  }

  /**
   * The second gate: a statement that changes schema or privileges needs two
   * opt-ins, not one. Collapsing them into `readOnly: false` is the privilege
   * escalation OWASP MCP02:2025 describes.
   *
   * Both flags can be set by the same agent in the same call, which is a weak
   * boundary — it stops one mistaken call, not a determined one. The control that
   * holds is a database role that cannot run the statement.
   */
  assertDestructiveAllowed(query, protocol, options, policy, operation = 'db_query') {
    const verdict = classifiesAsDestructive(query, protocol, options);
    if (!verdict.destructive) return;

    const envAllowed = parseBoolEnv(this.env.ANYDB_ALLOW_DESTRUCTIVE, false);
    const writeOptIn = this.resolveReadOnly(options, policy) === false;
    const destructOptIn = options.allowDestructive === true || policy.allowDestructive === true || envAllowed;

    if (writeOptIn && destructOptIn) return;

    const missing = [];
    if (!writeOptIn) missing.push('"readOnly": false');
    if (!destructOptIn) missing.push('"allowDestructive": true (on the call, or in the profile)');

    throw registryError(
      `Refused: this statement is destructive because ${verdict.reason}. `
      + `It needs ${missing.join(' and ')}. Both are set by the same caller, which is a weak boundary: `
      + 'it stops a single mistaken call, not a determined one. The control that holds is a database role that cannot run this statement at all.',
      { kind: 'policy', code: 'DESTRUCTIVE', operation }
    );
  }

  /**
   * Enforce a profile's `allowedSchemas` / `allowedTables` over a raw SQL string.
   *
   * A heuristic over identifiers, not a parser and not a security boundary: a
   * dynamically constructed name or a bound parameter is invisible to it, it
   * over-refuses (`EXTRACT(x FROM y)`, `FROM DUAL`), and it sees the statement
   * rather than the session, so a `search_path`, synonym or `TEMP` table resolves
   * to something else. The control that holds is a role whose grants say what it
   * may see.
   *
   * An unqualified name is refused when `allowedSchemas` is set: it resolves
   * against `search_path`, which this cannot read.
   */
  assertSqlAllowlist(query, protocol, policy, operation = 'db_query') {
    if (!isSqlProtocol(protocol)) return;

    const schemas = asList(policy.allowedSchemas);
    const tables = asList(policy.allowedTables);
    if (schemas.length === 0 && tables.length === 0) return;

    // `driverFor` is the dialect, not the spelling: `postgres` for `postgresql:`,
    // `mysql` for `mariadb:`. Dollar quoting is PostgreSQL-only, and treating
    // `$$` as an opener elsewhere would delete SQL from the text this reads.
    const driver = driverFor(protocol);
    const cleaned = stripLiterals(
      query,
      driver === 'mysql',
      driver === 'postgres'
    );
    for (const ref of collectTableReferences(cleaned)) {
      if (schemas.length > 0) {
        if (ref.schema === null) {
          throw registryError(
            `Refused: "${ref.table}" is not schema-qualified, and this profile only allows the schemas ${schemas.join(', ')}. `
            + 'An unqualified name resolves against the session search_path, which this check cannot read, so it cannot be verified. '
            + `Write "${schemas[0]}.${ref.table}", or drop allowedSchemas from the profile.`,
            { kind: 'policy', code: 'SCHEMA_NOT_ALLOWED', operation }
          );
        }
        if (!allowedBy(schemas, ref.schema)) {
          throw registryError(
            `Refused: the statement references "${ref.text}" and this profile only allows the schemas ${schemas.join(', ')}.`,
            { kind: 'policy', code: 'SCHEMA_NOT_ALLOWED', operation }
          );
        }
      }
      if (tables.length > 0 && !allowedBy(tables, ref.table) && !allowedBy(tables, ref.text)) {
        throw registryError(
          `Refused: the statement references "${ref.text}" and this profile only allows the tables ${tables.join(', ')}.`,
          { kind: 'policy', code: 'TABLE_NOT_ALLOWED', operation }
        );
      }
    }
  }

  /**
   * Run one operation on a connection, from the cache when possible. A
   * connection that timed out or lost its socket is discarded; anything else stays
   * cached. `timeout` goes to the factory and to the caller, because the cache
   * stamps the budget on the entry, not on the adapter.
   */
  async withConnection(uri, protocol, timeout, work, toolName = 'db_query') {
    const hardLimit = timeout + TIMEOUT_GRACE_MS;
    const key = normaliseCacheKey(uri, protocol);
    let active = null;

    const operationPromise = (async () => {
      const { adapter, release } = await this.cache.acquire(
        key,
        async () => {
          const adapter = this.createAdapter(protocol, timeout);
          await adapter.connect(uri);
          return adapter;
        },
        timeout
      );
      active = adapter;

      try {
        return await work(adapter);
      } catch (err) {
        if (isDeadConnectionError(err)) {
          this.cache.evict(key);
          try { adapter.abort(); } catch { /* best effort */ }
        }
        throw err;
      } finally {
        release();
      }
    })();

    return withTimeout(
      operationPromise,
      hardLimit,
      `${toolName} (${protocol})`,
      () => {
        this.cache.evict(key);
        active?.abort();
      }
    );
  }

  createAdapter(protocol, timeout) {
    const factory = this.mapping[protocol];
    if (!factory) {
      throw registryError(`Protocol "${protocol}" is not supported. Supported: ${SUPPORTED_PROTOCOLS.join(', ')}`, {
        kind: 'validation',
      });
    }
    return factory(timeout);
  }

  /**
   * The URI argument, on its own. Superseded by `resolveTarget()`, which folds it
   * together with `profile`; kept for a caller that wants to reject a missing
   * argument before doing any work.
   */
  assertUri(uri) {
    if (typeof uri !== 'string' || uri.length === 0) {
      throw registryError(
        "Missing 'uri' argument: expected a connection string such as postgres://user:pass@host:5432/db. " + TARGET_HINT,
        { kind: 'validation' }
      );
    }
  }

  assertAdapter(protocol) {
    if (!this.mapping[protocol]) {
      throw registryError(
        `Protocol "${protocol}" is not supported. Supported: ${SUPPORTED_PROTOCOLS.join(', ')}`,
        { kind: 'validation' }
      );
    }
  }

  extractProtocol(uri) {
    if (typeof uri !== 'string' || !uri.includes('://')) {
      throw registryError("Invalid URI format. Expected 'protocol://...'", { kind: 'validation' });
    }
    return uri.split('://')[0].toLowerCase();
  }

  /**
   * The timeout for one call. With a policy present the answer comes from it —
   * `evaluatePolicy` has already folded in the per-call `timeout` and the
   * defaults, in that order.
   */
  resolveTimeout(options = {}, policy = null) {
    if (policy && Number.isFinite(policy.queryTimeoutMs) && policy.queryTimeoutMs > 0) {
      return policy.queryTimeoutMs;
    }
    if (options.timeout === undefined || options.timeout === null) return DEFAULT_TIMEOUT;
    return options.timeout;
  }

  resolveReadOnly(options = {}, policy = null) {
    if (policy && typeof policy.readOnly === 'boolean') return policy.readOnly;
    return options.readOnly !== false;
  }

  /**
   * Validate one call's arguments, cheap numeric and type checks first: the
   * caller who wrote `timeout: 1.5` needs to be told about `1.5`, not about a
   * `;` in a query they will rewrite anyway.
   *
   * @param {string} protocol - Lowercase URI scheme, or a driver name
   */
  validate(query, protocol, options = {}) {
    this.validateScalars(options);
    this.assertQueryIsPresent(query);
    this.validateQuery(query, driverFor(protocol), options);
  }

  /** The query argument itself, before anything is inspected. */
  assertQueryIsPresent(query) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw registryError('Query must be a non-empty string.', { kind: 'validation' });
    }
  }

  /** Every scalar argument, checked. See `validateTimeout` for why. */
  validateScalars(options = {}) {
    this.validateTimeout(options);

    for (const key of ['readOnly', 'allowDestructive', 'allowWriteStages', 'upsert']) {
      if (options[key] !== undefined && typeof options[key] !== 'boolean') {
        throw registryError(`'${key}' must be a boolean, got ${describeValue(options[key])}.`, { kind: 'validation' });
      }
    }

    if (options.params !== undefined && !Array.isArray(options.params)) {
      throw registryError(
        `'params' must be an array of values, got ${describeValue(options.params)}. `
        + 'Pass each placeholder as one element, for example {"params": [42, "x"]}.',
        { kind: 'validation' }
      );
    }

    if (options.format !== undefined && !RESULT_FORMATS.includes(options.format)) {
      throw registryError(
        `'format' must be one of ${RESULT_FORMATS.join(', ')}, got ${describeValue(options.format)}.`,
        { kind: 'validation' }
      );
    }

    for (const key of ['maxRows', 'maxBytes']) {
      const value = options[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw registryError(
          `'${key}' must be a positive whole number, got ${describeValue(value)}. `
          + 'It is a result limit, not a byte or row count expression.',
          { kind: 'validation' }
        );
      }
    }

    const offset = options.offset;
    if (offset !== undefined && offset !== null) {
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        throw registryError(
          `'offset' must be a whole number of rows to skip, zero or more, got ${describeValue(offset)}.`,
          { kind: 'validation' }
        );
      }
    }

    const limit = options.limit;
    if (limit !== undefined && limit !== null) {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
        throw registryError(
          `'limit' must be a positive whole number, got ${describeValue(limit)}.`,
          { kind: 'validation' }
        );
      }
    }
  }

  /**
   * The timeout reaches `setTimeout` and, for PostgreSQL, a `SET
   * statement_timeout` built by string interpolation, so it must be an in-range
   * integer before any adapter sees it. Both tools come through here: `db_schema`
   * skips `validate()`.
   */
  validateTimeout(options = {}) {
    const { timeout } = options;
    if (timeout === undefined || timeout === null) return;

    if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
      // String(), not JSON.stringify(): the latter renders NaN and Infinity as
      // "null", which names a value the caller never passed.
      throw registryError(
        `Timeout must be a number of milliseconds, got ${String(timeout)}.`,
        { kind: 'validation', code: 'INVALID_TIMEOUT' }
      );
    }
    if (!Number.isInteger(timeout)) {
      throw registryError(
        `Timeout must be a whole number of milliseconds, got ${timeout}. `
        + 'It is written into a SET statement_timeout by some drivers, and a fractional value is truncated differently by each one.',
        { kind: 'validation', code: 'INVALID_TIMEOUT' }
      );
    }
    if (timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) {
      throw registryError(
        `Timeout must be between ${MIN_TIMEOUT} and ${MAX_TIMEOUT} milliseconds. `
        + `Omit it to use the ${DEFAULT_TIMEOUT}ms default.`,
        { kind: 'validation', code: 'INVALID_TIMEOUT' }
      );
    }
  }

  /** `db_query`'s statement-shape checks: the semicolon scan, and MongoDB's arguments. */
  validateQuery(query, protocol = '', options = {}) {
    // Rejected regardless of readOnly: the read-only check reads only the leading
    // keyword, so `SELECT 1; DROP TABLE t` would pass it, and PostgreSQL's simple
    // query protocol runs every statement in the string.
    if (isSqlProtocol(protocol) && hasMultipleStatements(query, protocol)) {      throw registryError(
        'Multiple statements in one call are not supported. Run one statement at a time.',
        { kind: 'validation' }
      );
    }
    if (protocol === 'mongodb' && !options.collection) {
      throw registryError("Missing 'collection' parameter for MongoDB query.", { kind: 'validation' });
    }
    if (protocol === 'mongodb' && options.action !== undefined && options.action !== null) {
      // An action that does not exist is an argument error, not a policy one.
      if (typeof options.action !== 'string' || !MONGO_ACTIONS.has(options.action)) {
        throw registryError(
          `Unknown MongoDB action ${JSON.stringify(options.action)}. `
          + `Use one of: ${[...MONGO_ACTIONS].join(', ')}.`,
          { kind: 'validation' }
        );
      }
    }
  }

  /** `db_schema`'s own checks. It never sees a query, so there is nothing to scan. */
  validateSchemaOptions(options = {}) {
    this.validateScalars(options);
    for (const key of ['table', 'collection']) {
      if (options[key] !== undefined && typeof options[key] !== 'string') {
        throw registryError(`'${key}' must be a string, got ${describeValue(options[key])}.`, { kind: 'validation' });
      }
    }
  }

  /**
   * What this server can actually do, for a `db_health` tool.
   *
   * No credential material: no URI, username, password, resolved profile entry or
   * cache key — a cache key is a hash, but a hash of a connection string is still
   * derived from one, so only counts are reported.
   */
  describeConfiguration() {
    let profileCount = 0;
    let profilesSource = null;
    let profilesError = this._profilesError;
    try {
      this.profiles.load();
      profileCount = this.profiles.profiles.size;
      profilesSource = this.profiles.source;
    } catch (error) {
      profilesError = String(error && error.message);
    }

    const env = {};
    for (const name of REPORTED_ENV) {
      const raw = this.env[name];
      if (raw === undefined || raw === '') {
        env[name] = null;
      } else {
        env[name] = MASKED_ENV.has(name) ? '***' : String(raw);
      }
    }

    if (this._driverProbe === null) this._driverProbe = probeDrivers();

    return {
      profiles: profileCount,
      profilesSource,
      cache: {
        enabled: this.cache.enabled !== false,
        size: this.cache.size,
        pending: this.cache.pending ? this.cache.pending.size : 0,
        maxEntries: this.cache.maxEntries,
        idleTtlMs: this.cache.idleTtlMs,
      },
      drivers: this._driverProbe,
      env,
      // Not one of the five documented fields: hiding a `db.json` parse failure
      // behind "0 profiles" sends somebody to the wrong place.
      ...(profilesError ? { profilesError } : {}),
    };
  }

  /** Alias of `describeConfiguration()`, for a `db_health` tool that reads better. */
  health() {
    return this.describeConfiguration();
  }

  /** Close every cached connection. */
  async close() {
    await this.cache.closeAll();
  }
}

/**
 * Wall-clock milliseconds since `startedAt`, by monotonic clock: `Date.now()`
 * can be stepped by NTP mid-query, turning a 3 ms query into a reported −4 000 ms.
 */
function sinceMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

/** A cursor the adapter left on the payload, if any, for `nextCursor`. */
function nextCursorOf(data) {
  if (data && typeof data === 'object' && !Array.isArray(data) && data.nextCursor !== undefined) {
    return data.nextCursor;
  }
  return null;
}

/** Name a value's type for an argument-error message, without echoing a secret. */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return 'an array';
  return `a value of type ${typeof value}`;
}

export { TimeoutError, DEFAULT_TIMEOUT, TIMEOUT_GRACE_MS, loadProfileStore, ProfileStore, clampResult, buildEnvelope };
