/**
 * Read-only safety guard.
 *
 * The default posture is fail-closed: a query is allowed only if its leading
 * keyword is on an explicit read allowlist. Anything unrecognised is rejected,
 * because an allowlist can only be wrong in the safe direction.
 */
// Leading keywords that cannot modify data on their own.
const SQL_READ_KEYWORDS = new Set([
  'SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'VALUES', 'TABLE',
]);

// Statements that are valid SQL but are not read-only. Used only to tell a
// deliberate write apart from a typo, so the message can say which it is.
// Set operators and `TABLE` are absent deliberately: they are not statements,
// and `TABLE t` is a read, so neither can ever be the leading keyword of a write.
const SQL_WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT', 'DROP', 'TRUNCATE',
  'ALTER', 'CREATE', 'RENAME', 'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'BEGIN', 'START', 'LOCK', 'UNLOCK', 'CALL', 'EXEC', 'EXECUTE',
  'DO', 'COPY', 'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER', 'REFRESH',
  'ATTACH', 'DETACH', 'PRAGMA', 'SET', 'RESET', 'USE', 'LOAD', 'INSTALL',
  'UNINSTALL', 'CHECKPOINT', 'DISCARD', 'LISTEN', 'NOTIFY', 'DECLARE', 'PREPARE',
  'DEALLOCATE', 'IMPORT',
]);

// Read queries that still write or lock. Checked inside allowed statements.
const SQL_WRITE_PATTERNS = [
  { re: /\bINTO\s+(OUTFILE|DUMPFILE)\b/i, reason: 'INTO OUTFILE/DUMPFILE writes to disk' },
  { re: /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE)\b/i, reason: 'row-locking clause (FOR UPDATE/SHARE)' },
  { re: /\bINTO\s+@/i, reason: 'INTO @variable writes a session variable' },
  { re: /\bLOCK\s+IN\s+SHARE\s+MODE\b/i, reason: 'row-locking clause (LOCK IN SHARE MODE)' },
];

// Redis commands that only read. Everything else is rejected.
const REDIS_READ_COMMANDS = new Set([
  'GET', 'MGET', 'GETRANGE', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL',
  'DBSIZE', 'RANDOMKEY', 'SCAN', 'INFO', 'PING', 'ECHO', 'OBJECT', 'MEMORY',
  'HLEN', 'HEXISTS', 'HGET', 'HGETALL', 'HKEYS', 'HVALS', 'HMGET', 'HRANDFIELD',
  'LLEN', 'LINDEX', 'LRANGE', 'LPOS',
  'SCARD', 'SISMEMBER', 'SMEMBERS', 'SMISMEMBER', 'SRANDMEMBER', 'SSCAN',
  'ZCARD', 'ZCOUNT', 'ZLEXCOUNT', 'ZMSCORE', 'ZRANDMEMBER', 'ZRANGE',
  'ZRANGEBYLEX', 'ZRANGEBYSCORE', 'ZRANK', 'ZREVRANGE', 'ZREVRANGEBYLEX',
  'ZREVRANGEBYSCORE', 'ZREVRANK', 'ZSCAN', 'ZSCORE',
  'XRANGE', 'XREVRANGE', 'XLEN', 'XINFO',
  'GEODIST', 'GEOHASH', 'GEOPOS', 'GEOSEARCH',
  'BITCOUNT', 'BITPOS', 'PFCOUNT', 'SORT_RO',
]);

// MongoDB operators that execute server-side JavaScript. Reachable from a
// find() filter, so they are a real code-execution path for an agent.
const MONGO_JS_OPERATORS = ['$where', '$function', '$accumulator'];

// MongoDB aggregation stages that replace or create a collection.
const MONGO_WRITE_STAGES = ['$out', '$merge'];

/**
 * Remove comments and quoted literals so keyword matching cannot be fooled by
 * `SELECT * FROM created_orders` or `SELECT 'DROP TABLE' AS note`.
 *
 * MySQL conditional comments (an exclamation mark inside a block comment) are
 * executable, so they are replaced with a marker rather than removed.
 *
 * @param {string} sql - Statement to clean
 * @param {object} [options]
 * @param {boolean} [options.backslashEscapes=false] - Whether a backslash
 *   escapes the next character inside a string literal. Only MySQL does this by
 *   default. PostgreSQL and SQLite run with standard-conforming strings, where
 *   `\` is an ordinary character, so honouring it there would end a literal
 *   early and hide a following statement from the multiple-statement check.
 *   Reading those dialects strictly can only over-count a semicolon, which
 *   refuses a legal query; reading them loosely can under-count it, which lets a
 *   write through.
 */
export function stripSqlNoise(sql, { backslashEscapes = false } = {}) {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '#') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const isConditional = sql[i + 2] === '!';
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) { i = n; break; }
      if (isConditional) out += ' CONDITIONAL_COMMENT ';
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < n) {
        if (backslashEscapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += " '' ";
      continue;
    }
    if (ch === '`') {
      i++;
      while (i < n && sql[i] !== '`') i++;
      i++;
      out += ' identifier ';
      continue;
    }
    if (ch === '[') {
      while (i < n && sql[i] !== ']') i++;
      i++;
      out += ' identifier ';
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Whether the dialect treats a backslash inside a string literal as an escape.
 * MySQL does unless NO_BACKSLASH_ESCAPES is set; PostgreSQL and SQLite do not.
 *
 * @param {string} protocol - Lowercase URI scheme
 * @returns {boolean} True for the MySQL family
 */
const usesBackslashEscapes = (protocol) => baseProtocol(protocol) === 'mysql';

/**
 * Inspect a SQL statement and report whether it is safe to run read-only.
 *
 * @param {string} query - Statement to inspect
 * @param {string} [protocol] - Lowercase URI scheme, which decides how string
 *   literals are scanned
 */
export function inspectSql(query, protocol = '') {
  const cleaned = stripSqlNoise(query, { backslashEscapes: usesBackslashEscapes(protocol) }).trim();
  if (!cleaned) return { safe: false, reason: 'empty statement' };

  if (/\bCONDITIONAL_COMMENT\b/.test(cleaned)) {
    return {
      safe: false,
      reason: 'MySQL conditional comments (/*! ... */) execute server-side and cannot be verified read-only',
    };
  }

  const firstWord = (cleaned.match(/^[a-z]+/i) || [''])[0].toUpperCase();
  if (!SQL_READ_KEYWORDS.has(firstWord)) {
    if (SQL_WRITE_KEYWORDS.has(firstWord)) {
      return { safe: false, reason: `"${firstWord}" modifies data or schema` };
    }
    return {
      safe: false,
      reason: `leading keyword "${firstWord || '(none)'}" is not a recognised read-only statement` +
        (firstWord ? ' (check for a typo)' : ''),
    };
  }

  for (const { re, reason } of SQL_WRITE_PATTERNS) {
    if (re.test(cleaned)) return { safe: false, reason };
  }

  return { safe: true, reason: '' };
}

/**
 * Inspect a Redis command line.
 */
export function inspectRedisCommand(commandStr) {
  const verb = (commandStr.trim().match(/^[a-z]+/i) || [''])[0].toUpperCase();
  if (!verb) return { safe: false, reason: 'empty command' };

  if (REDIS_READ_COMMANDS.has(verb)) return { safe: true, reason: '' };

  return {
    safe: false,
    reason: `Redis command "${verb}" is not read-only`,
  };
}

/**
 * Whether a statement holds more than one command.
 *
 * The read-only check only looks at the leading keyword, so a trailing
 * `; DROP TABLE t` would otherwise pass it. Literals and comments are stripped
 * first, so a semicolon inside them does not count. A semicolon inside a
 * Postgres dollar-quoted body does count, which rejects an unusual but legal
 * statement; that errs towards refusing.
 *
 * @param {string} sql - Statement to inspect
 * @param {string} [protocol] - Lowercase URI scheme, which decides how string
 *   literals are scanned
 * @returns {boolean} True if more than one command is present
 */
export function hasMultipleStatements(sql, protocol = '') {
  const stripped = stripSqlNoise(sql, { backslashEscapes: usesBackslashEscapes(protocol) })
    .replace(/;\s*$/, '')
    .trim();
  return stripped.includes(';');
}

/**
 * Inspect a MongoDB operation.
 *
 * A find filter is JSON; an aggregation pipeline is an array of stages. Writes
 * are decided by the action, not by the shape of the payload.
 *
 * @param {string} query - Filter or pipeline, as JSON
 * @param {string} [action='find'] - Requested action
 * @param {object} [options] - Remaining tool options
 */
export function inspectMongoOperation(query, action = 'find', options = {}) {
  if (!MONGO_ACTIONS.has(action)) {
    return { safe: false, reason: `unknown MongoDB action "${action}"` };
  }
  if (!MONGO_READ_ACTIONS.has(action)) {
    return { safe: false, reason: `the "${action}" action modifies data` };
  }

  let parsed;
  try {
    parsed = JSON.parse(query);
  } catch (e) {
    return { safe: false, reason: `payload is not valid JSON: ${e.message}` };
  }

  if (action === 'aggregate') {
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { safe: false, reason: 'an aggregation pipeline must be a non-empty JSON array of stages' };
    }
    // $out and $merge replace a collection, so a read-only agent must not
    // reach them even through an otherwise read-only pipeline.
    if (options.allowWriteStages !== true) {
      // The whole pipeline is walked, not just its top level: a write stage
      // nested inside $facet or $unionWith writes just as surely as a bare one.
      const stage = findWriteStage(parsed);
      if (stage) {
        return { safe: false, reason: `the ${stage} stage writes to a collection` };
      }
    }
    return { safe: true, reason: '' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { safe: false, reason: 'filter must be a JSON object' };
  }

  const found = findOperator(parsed, MONGO_JS_OPERATORS);
  if (found) {
    return { safe: false, reason: `operator "${found}" executes server-side JavaScript` };
  }

  return { safe: true, reason: '' };
}


/** Locate a write stage anywhere in a pipeline, including nested facets. */
export function findWriteStage(node, depth = 0) {
  if (depth > 20 || node === null || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (MONGO_WRITE_STAGES.includes(key)) return key;
    const nested = findWriteStage(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function findOperator(node, wanted, depth = 0) {
  if (depth > 20 || node === null || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (wanted.includes(key)) return key;
    const nested = findOperator(value, wanted, depth + 1);
    if (nested) return nested;
  }
  return null;
}

const SQL_PROTOCOLS = new Set(['postgres', 'postgresql', 'mysql', 'sqlite']);

// `rediss` is `redis` over TLS. `mysql+pymysql` and `sqlite+pysqlite` are
// SQLAlchemy-style URIs whose scheme collapses to the base driver.
const DIALECT_PREFIX = /^(mysql|sqlite)\+.*$/;

/** Collapse a scheme to the driver the registry routes it to. */
export const baseProtocol = (protocol) =>
  protocol.replace(DIALECT_PREFIX, '$1').replace(/^rediss$/, 'redis');

export const isSqlProtocol = (protocol) => SQL_PROTOCOLS.has(baseProtocol(protocol));

export { SQL_PROTOCOLS };

export const MONGO_READ_ACTIONS = new Set(['find', 'count', 'distinct', 'aggregate', 'explain']);

// Every action the tool accepts.
export const MONGO_ACTIONS = new Set([...MONGO_READ_ACTIONS, 'insert', 'update', 'delete']);

/**
 * Decide whether a query may run in read-only mode.
 *
 * @param {string} protocol - Lowercase URI scheme.
 * @param {string} query - SQL, MongoDB filter JSON, or Redis command line.
 * @param {object} [options] - Tool options, which decide the MongoDB action.
 */
export function inspectQuery(protocol, query, options = {}) {
  if (typeof query !== 'string') {
    return { safe: false, reason: 'query must be a string' };
  }

  const base = baseProtocol(protocol);
  if (SQL_PROTOCOLS.has(base)) return inspectSql(query, base);
  if (base === 'redis') return inspectRedisCommand(query);
  if (base === 'mongodb') {
    return inspectMongoOperation(query, options.action || 'find', options);
  }

  return { safe: false, reason: `protocol "${protocol}" cannot be verified` };
}

export const READ_ONLY_HINT =
  'This server runs read-only by default. Set readOnly:false to run a write or destructive statement.';
