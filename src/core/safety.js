/**
 * Read-only safety guard. Fails closed: a statement is allowed only if its leading
 * keyword is on the read allowlist below.
 */
// EXPLAIN and WITH read on their own, and each can be turned into a write by the
// keyword that follows it (see inspectSql).
const SQL_READ_KEYWORDS = new Set([
  'SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'VALUES', 'TABLE',
]);

// Valid SQL that is not a read, used only to tell a deliberate write from a typo so
// the message can name which it is. Set operators and `TABLE` are absent
// deliberately: neither can be the leading keyword of a write.
const SQL_WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT', 'DROP', 'TRUNCATE',
  'ALTER', 'CREATE', 'RENAME', 'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'BEGIN', 'START', 'LOCK', 'UNLOCK', 'CALL', 'EXEC', 'EXECUTE',
  'DO', 'COPY', 'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER', 'REFRESH',
  'ATTACH', 'DETACH', 'PRAGMA', 'SET', 'RESET', 'USE', 'LOAD', 'INSTALL',
  'UNINSTALL', 'CHECKPOINT', 'DISCARD', 'LISTEN', 'NOTIFY', 'DECLARE', 'PREPARE',
  'DEALLOCATE', 'IMPORT',
]);

// Reads that still write or lock. Order matters: the first match decides the message.
const SQL_WRITE_PATTERNS = [
  { re: /\bINTO\s+(OUTFILE|DUMPFILE)\b/i, reason: 'INTO OUTFILE/DUMPFILE writes to disk' },
  { re: /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE)\b/i, reason: 'row-locking clause (FOR UPDATE/SHARE)' },
  { re: /\bINTO\s+@/i, reason: 'INTO @variable writes a session variable' },
  { re: /\bLOCK\s+IN\s+SHARE\s+MODE\b/i, reason: 'row-locking clause (LOCK IN SHARE MODE)' },
  // `INTO <target>` with no OUTFILE, DUMPFILE or @ in front creates a table, writes
  // a file or assigns a variable, so it does not return the rows the leading SELECT
  // implies. The lookahead keeps the patterns above correct if the list is reordered.
  { re: /\bINTO\b(?!\s*(?:OUTFILE\b|DUMPFILE\b|@))/i, reason: 'INTO <target> creates a table or writes a file instead of returning rows' },
];

// Shapes that run code on the database host. Refused even when readOnly is false:
// the opt-in to write a row is not an opt-in to execute code. `DO` is anchored,
// since it can only be a statement head.
const SQL_CODE_EXECUTION_PATTERNS = [
  { re: /\b(?:TO|FROM)\s+PROGRAM\b/i, reason: 'COPY ... TO/FROM PROGRAM runs a shell command on the database host' },
  { re: /^\s*DO\b/i, reason: 'DO runs an anonymous code block on the database host' },
];

// What follows EXPLAIN: an optional parenthesised option list, or a bare option
// word, matched on text whose literals and comments are already gone.
const EXPLAIN_OPTION_LIST = /^\s*\(([^)]*)\)/;

/**
 * Whether an EXPLAIN runs the statement rather than only planning it.
 *
 * `EXPLAIN ANALYZE` executes in PostgreSQL, MySQL and MariaDB, so
 * `EXPLAIN ANALYZE DELETE FROM users` deletes every row. Both spellings count:
 * `EXPLAIN ANALYZE ...` and `EXPLAIN (ANALYZE, BUFFERS) ...`, where ANALYZE is one
 * option among any and may sit anywhere in the list.
 *
 * The check is blind to the option's value, so `EXPLAIN (ANALYZE FALSE) SELECT 1`
 * is refused too. That costs a read; a per-dialect reading of `FALSE` hands back
 * a write if it is wrong.
 *
 * @param {string} cleaned - Statement with literals and comments removed
 * @returns {boolean}
 */
const explainExecutesTheStatement = (cleaned) => {
  const rest = cleaned.replace(/^EXPLAIN\b/i, '');
  const options = rest.match(EXPLAIN_OPTION_LIST);
  if (options) return /\bANALYZE\b/i.test(options[1]);
  return /^\s*ANALYZE\b/i.test(rest);
};

// `WITH`, then an optional RECURSIVE, then the CTE list.
const CTE_PREFIX = /^\s*WITH\s+(?:RECURSIVE\s+)?/i;

// A CTE body may be a full statement, so `WITH gone AS (DELETE FROM users RETURNING
// *) SELECT count(*) FROM gone` writes behind a leading WITH. Every entry is also in
// SQL_WRITE_KEYWORDS.
const SQL_CTE_WRITE_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT', 'TRUNCATE',
  'DROP', 'ALTER', 'CREATE', 'GRANT', 'REVOKE', 'CALL', 'EXEC', 'EXECUTE', 'COPY',
];

// REPLACE and TRUNCATE are also ordinary scalar functions, and a call is always
// followed by its argument list, so that shape is excluded for those two only.
const SQL_CTE_FUNCTION_WORDS = new Set(['REPLACE', 'TRUNCATE']);

// A word boundary on each side keeps `created_orders` and `truncated` out. The whole
// statement is searched, not just the first keyword after the CTE list: telling
// those apart needs a nesting-aware parse, and skipping it only over-refuses a read.
const SQL_CTE_WRITE = new RegExp(
  `\\b(?:${SQL_CTE_WRITE_KEYWORDS
    .map((word) => (SQL_CTE_FUNCTION_WORDS.has(word) ? `${word}(?!\\s*\\()` : word))
    .join('|')})\\b`,
  'i'
);

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

// Operators that execute server-side JavaScript, reachable from a find() filter
// and from a pipeline: $where and $function take a body, $accumulator runs per group.
const MONGO_JS_OPERATORS = ['$where', '$function', '$accumulator'];

// $expr has no JavaScript of its own, but it evaluates an expression tree that may
// hold $function and nothing outside can be shown not to, so it goes with them.
const MONGO_EXPRESSION_OPERATORS = ['$expr'];

// Operators refused in every mode, read-only or not, in any payload shape.
const MONGO_CODE_OPERATORS = [...MONGO_JS_OPERATORS, ...MONGO_EXPRESSION_OPERATORS];

// MongoDB aggregation stages that replace or create a collection.
const MONGO_WRITE_STAGES = ['$out', '$merge'];

// Operators that carry a nested pipeline, so a write stage or a JavaScript operator
// hides in there as readily as in the outer one.
const MONGO_PIPELINE_OPERATORS = new Set(['$facet', '$unionWith', '$lookup']);

// How deep a payload walk goes. MongoDB's own limit is far higher (100 levels), so
// this bounds the guard's work, not what the server accepts. Running out of depth
// refuses the operation, because "nothing found" leaves a `$out` below the limit
// unexamined.
const MONGO_MAX_DEPTH = 20;

// "Too deep to verify", not "nothing found". A string, because findWriteStage is
// exported and its callers interpolate the result.
export const TOO_DEEP = '(nesting limit exceeded)';

/**
 * PostgreSQL and nothing else. `$$…$$` and `$tag$…$tag$` are the one string form
 * whose body may hold an *unquoted* `'`, so a scanner blind to them opens a literal
 * at that quote and swallows the rest of the statement, semicolons included, and
 * `pg` runs every statement in the string: `Query#requiresPreparation` is false for
 * an empty `values`, so a call with no `params` goes out as a simple query.
 *
 * Switching it on for a dialect without the feature would be the other kind of
 * wrong: SQLite has no dollar quoting, so `$$` there is two operators, and
 * deleting the text between them would hide a statement from the scan.
 */
const DOLLAR_QUOTE_PROTOCOLS = new Set(['postgres', 'postgresql']);
const usesDollarQuoting = (protocol) => DOLLAR_QUOTE_PROTOCOLS.has(baseProtocol(protocol));

/**
 * Whether the last character emitted is one PostgreSQL keeps inside an identifier.
 * `$` is a legal *continuation* character, so `SELECT a$tag$ FROM t` is one column
 * name and no dollar-quote opens. Checked against the output, not the input, because
 * a stripped comment or literal also ends an identifier.
 *
 * @param {string} out - Text emitted so far
 * @returns {boolean}
 */
const isIdentifierTail = (out) => /[A-Za-z0-9_$\u0080-\uFFFF]$/.test(out);

/**
 * The dollar-quote delimiter starting at `index`, or '' when there is none. Two
 * shapes, because that is all PostgreSQL's lexer recognises: `$$` and `$tag$`.
 * Exported for `registry.js`'s `stripLiterals`, the same scanner without the
 * identifier branch.
 *
 * @param {string} sql
 * @param {number} index - Position of the `$`
 * @returns {string} The delimiter including both `$`, or ''
 */
export function dollarQuoteDelimiterAt(sql, index) {
  if (sql[index] !== '$') return '';
  if (sql[index + 1] === '$') return '$$';
  // An identifier cannot start with a digit, so `$1…` is a placeholder, not a tag.
  if (!/[A-Za-z_\u0080-\uFFFF]/.test(sql[index + 1] ?? '')) return '';
  let end = index + 2;
  while (end < sql.length && /[A-Za-z0-9_\u0080-\uFFFF]/.test(sql[end])) end++;
  return sql[end] === '$' ? sql.slice(index, end + 1) : '';
}

/**
 * Remove comments and quoted literals so keyword matching cannot be fooled by
 * `SELECT * FROM created_orders` or `SELECT 'DROP TABLE' AS note`. MySQL conditional
 * comments are executable, so they become a marker rather than nothing.
 *
 * @param {string} sql - Statement to clean
 * @param {object} [options]
 * @param {boolean} [options.backslashEscapes=false] - Whether `\` escapes inside a
 *   literal. The MySQL family only; elsewhere `\` is an ordinary character, and
 *   honouring it would end a literal early and hide a following statement.
 * @param {boolean} [options.dollarQuoting=false] - Whether `$$…$$` is a literal.
 *   PostgreSQL only; see DOLLAR_QUOTE_PROTOCOLS.
 */
export function stripSqlNoise(sql, { backslashEscapes = false, dollarQuoting = false } = {}) {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '#') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
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
    if (dollarQuoting && ch === '$' && !isIdentifierTail(out)) {
      const delimiter = dollarQuoteDelimiterAt(sql, i);
      if (delimiter) {
        const end = sql.indexOf(delimiter, i + delimiter.length);
        // An unterminated body runs to the end, which is what PostgreSQL's own
        // lexer does. The server rejects the statement, so reading the tail as SQL
        // could only invent refusals.
        out += " '' ";
        i = end === -1 ? n : end + delimiter.length;
        continue;
      }
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
 * Whether the dialect treats `\` inside a string literal as an escape. The MySQL
 * family does unless `NO_BACKSLASH_ESCAPES` is set, and MariaDB is in that family.
 * PostgreSQL and SQLite do not, and honouring a backslash there would end a
 * literal early and hide a following statement from the multiple-statement check.
 *
 * @param {string} protocol - Lowercase URI scheme
 * @returns {boolean} True for the MySQL and MariaDB families
 */
const BACKSLASH_ESCAPE_PROTOCOLS = new Set(['mysql', 'mariadb']);
const usesBackslashEscapes = (protocol) => BACKSLASH_ESCAPE_PROTOCOLS.has(baseProtocol(protocol));

/**
 * @param {string} cleaned - Statement with literals and comments removed
 * @returns {string} The keyword that makes it a write, or '' if it reads
 */
const cteWriteKeyword = (cleaned) => {
  const match = cleaned.replace(CTE_PREFIX, '').match(SQL_CTE_WRITE);
  return match ? match[0].toUpperCase() : '';
};

/**
 * Inspect a SQL statement and report whether it is safe to run read-only.
 *
 * @param {string} query - Statement to inspect
 * @param {string} [protocol] - Lowercase URI scheme, which decides how literals
 *   are scanned
 */
export function inspectSql(query, protocol = '') {
  const cleaned = stripSqlNoise(query, {
    backslashEscapes: usesBackslashEscapes(protocol),
    dollarQuoting: usesDollarQuoting(protocol),
  }).trim();
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

  // EXPLAIN and WITH are reads that the keyword *after* them can turn into writes,
  // which is a property of the position, so neither can live in the list above.
  if (firstWord === 'EXPLAIN' && explainExecutesTheStatement(cleaned)) {
    return { safe: false, reason: 'EXPLAIN ANALYZE executes the statement it plans' };
  }
  if (firstWord === 'WITH') {
    const keyword = cteWriteKeyword(cleaned);
    if (keyword) {
      return {
        safe: false,
        reason: `data-modifying CTE: "${keyword}" inside the WITH clause modifies data even though the statement starts with WITH`,
      };
    }
  }

  for (const { re, reason } of SQL_WRITE_PATTERNS) {
    if (re.test(cleaned)) return { safe: false, reason };
  }

  return { safe: true, reason: '' };
}

/** Inspect a Redis command line. */
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
 * The read-only check only reads the leading keyword, so a trailing
 * `; DROP TABLE t` would otherwise pass it. Literals and comments are stripped
 * first, so a semicolon inside them does not count, and on PostgreSQL a
 * dollar-quoted body is stripped as a literal too.
 *
 * @param {string} sql - Statement to inspect
 * @param {string} [protocol] - Lowercase URI scheme, which decides how literals
 *   are scanned
 * @returns {boolean} True if more than one command is present
 */
export function hasMultipleStatements(sql, protocol = '') {
  const stripped = stripSqlNoise(sql, {
    backslashEscapes: usesBackslashEscapes(protocol),
    dollarQuoting: usesDollarQuoting(protocol),
  })
    .replace(/;\s*$/, '')
    .trim();
  return stripped.includes(';');
}

/**
 * Inspect a MongoDB operation.
 *
 * Writes are decided by the action, not by the shape of the payload. The payload
 * is then walked for operators that execute code or write a collection, which is
 * a separate question and is asked of every read action.
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

  return inspectMongoPayload(parsed, action, options);
}

/**
 * Walk a MongoDB payload for operators that execute code or write a collection.
 *
 * A pipeline has two kinds of key, so it needs two walks: any key in a stage
 * document may be an operator ($where in $addFields, $function in a nested
 * $lookup), while $out and $merge are stages only as a top-level key of one.
 *
 * @param {*} payload - Parsed JSON payload
 * @param {string} action - Requested action, which fixes the payload shape
 * @param {object} [options] - Tool options; `allowWriteStages` opts in to $out/$merge
 * @returns {{safe: boolean, reason: string}}
 */
function inspectMongoPayload(payload, action, options = {}) {
  if (action === 'aggregate') {
    if (!Array.isArray(payload) || payload.length === 0) {
      return { safe: false, reason: 'an aggregation pipeline must be a non-empty JSON array of stages' };
    }
    const code = mongoVerdict(findOperator(payload, MONGO_CODE_OPERATORS));
    if (!code.safe) return code;
    // $out and $merge replace a collection, so read-only must not reach them even
    // through a read-only pipeline. Same allowWriteStages flag the adapter
    // enforces, so the two layers cannot disagree about which pipelines write.
    if (options.allowWriteStages === true) return code;
    return mongoVerdict(findStageOperator(payload, MONGO_WRITE_STAGES));
  }

  if (MONGO_FILTER_ACTIONS.has(action)) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { safe: false, reason: 'filter must be a JSON object' };
    }
  } else if (payload === null || typeof payload !== 'object') {
    // A $function in an insert or update document runs server-side whatever the
    // action is called, so the walk below applies to those payloads too.
    return { safe: false, reason: 'the payload must be a JSON object or an array of objects' };
  }
  return mongoVerdict(findOperator(payload, MONGO_CODE_OPERATORS));
}

/** Turn a walk's finding into a verdict. */
const mongoVerdict = (found) =>
  (found ? { safe: false, reason: describeMongoFinding(found) } : { safe: true, reason: '' });

/**
 * Name what the walk found. One place, because the same findings come from
 * filters, pipelines, and the check the registry runs in both modes.
 *
 * @param {string} found - Operator name, or TOO_DEEP
 * @returns {string} The reason to report
 */
function describeMongoFinding(found) {
  if (found === TOO_DEEP) {
    return 'the payload nests deeper than the guard can verify';
  }
  if (MONGO_JS_OPERATORS.includes(found)) {
    return `operator "${found}" executes server-side JavaScript`;
  }
  if (MONGO_WRITE_STAGES.includes(found)) {
    return `the ${found} stage writes to a collection`;
  }
  // $expr. Named separately so the reason says what the risk is.
  return `operator "${found}" evaluates an expression tree that cannot be checked for server-side JavaScript`;
}

/**
 * The pipelines an operator carries inside its own value, if any.
 *
 * Listed rather than guessed, because guessing permissively would leave a `$out`
 * one level down: `$facet` maps a name to a pipeline per key, while $unionWith
 * and $lookup take a `pipeline`. No other aggregation operator nests a pipeline.
 *
 * @param {string} key - Operator key
 * @param {*} value - Its value
 * @returns {Array[]} Nested pipelines, possibly empty
 */
function nestedPipelines(key, value) {
  if (!MONGO_PIPELINE_OPERATORS.has(key)) return [];
  if (key === '$facet') {
    // One pipeline per name; a non-array value is not one the server will run.
    if (value === null || typeof value !== 'object') return [];
    return Object.values(value).filter((entry) => Array.isArray(entry));
  }
  const pipeline = value !== null && typeof value === 'object' ? value.pipeline : null;
  return Array.isArray(pipeline) ? [pipeline] : [];
}

/**
 * Locate a dangerous operator in an aggregation pipeline.
 *
 * A stage is an element of a pipeline array, and a key counts as an operator only
 * when it is a top-level key of one. Keys deeper inside a stage are field names,
 * so `{"$match": {"$out": 1}}` is a read. Write stages nested inside `$facet`,
 * `$unionWith` or `$lookup` are still reached.
 *
 * @param {Array|object} pipeline - Pipeline array, or a single stage
 * @param {string[]} wanted - Operators to look for
 * @param {number} [depth=0] - Current nesting depth
 * @returns {string|null} The operator found, TOO_DEEP, or null
 */
function findStageOperator(pipeline, wanted, depth = 0) {
  if (pipeline === null || typeof pipeline !== 'object') return null;
  if (depth > MONGO_MAX_DEPTH) return TOO_DEEP;
  for (const stage of Array.isArray(pipeline) ? pipeline : [pipeline]) {
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) continue;
    for (const [key, value] of Object.entries(stage)) {
      if (wanted.includes(key)) return key;
      for (const nested of nestedPipelines(key, value)) {
        const found = findStageOperator(nested, wanted, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Locate a write stage anywhere in a pipeline, including nested facets. The
 * MongoDB adapter runs the same check before handing the pipeline to the driver.
 *
 * @param {Array|object} node - Pipeline array, or a single stage
 * @param {number} [depth=0] - Current nesting depth
 * @returns {string|null} The stage name, TOO_DEEP, or null
 */
export function findWriteStage(node, depth = 0) {
  return findStageOperator(node, MONGO_WRITE_STAGES, depth);
}

/**
 * Locate a key anywhere in a document, at any depth. Used for filters, where any
 * key may be an operator and there is no pipeline structure to lean on.
 *
 * @param {*} node - Node to walk
 * @param {string[]} wanted - Operators to look for
 * @param {number} [depth=0] - Current nesting depth
 * @returns {string|null} The operator found, TOO_DEEP, or null
 */
function findOperator(node, wanted, depth = 0) {
  if (node === null || typeof node !== 'object') return null;
  if (depth > MONGO_MAX_DEPTH) return TOO_DEEP;
  for (const [key, value] of Object.entries(node)) {
    if (wanted.includes(key)) return key;
    const nested = findOperator(value, wanted, depth + 1);
    if (nested) return nested;
  }
  return null;
}

// The protocols this module has guard rules for. `mariadb` is here because it is a
// routed driver (`ROUTES` in ./registry.js) and a member of DEFAULT_ALLOWED_SCHEMES.
// A routed SQL scheme missing from this set does not get a worse verdict, it gets
// no verdict at all: every gate that begins with `isSqlProtocol` returns early for
// it, so `registry.assertSqlAllowlist()` skips allowedSchemas / allowedTables.
// `mongodb+srv` and `redis-cluster` are absent because they are routed and are not
// SQL.
const SQL_PROTOCOLS = new Set(['postgres', 'postgresql', 'mysql', 'mariadb', 'sqlite']);

// `scheme` -> the dialect it names. Enumerated rather than matched as
// `mysql+anything`, so the guard and the registry cannot disagree about a scheme
// the registry will not route. Keep in step with `ROUTES` in ./registry.js;
// test_safety.test.js asserts that every routed SQL scheme is one isSqlProtocol
// accepts.
const DIALECT_ALIASES = new Map([
  ['mysql+pymysql', 'mysql'],
  ['mysql+mysqldb', 'mysql'],
  ['mysql+asyncmy', 'mysql'],
  ['mysql+aiohttp', 'mysql'],
  ['mysql+aiomysql', 'mysql'],
  ['mysql+cymysql', 'mysql'],
  // MariaDB's own spellings collapse to `mariadb` and not to `mysql`: it is a
  // different server, and `usesBackslashEscapes` is where that matters most.
  ['mariadb', 'mariadb'],
  ['mariadb+pymysql', 'mariadb'],
  ['mariadb+mariadbconnector', 'mariadb'],
  ['sqlite+pysqlite', 'sqlite'],
]);

// `rediss` is `redis` over TLS, and `redis-cluster` / `redis-sentinel` are the two
// topologies adapters/redis.js builds. The read-only guard is a list of command
// names and does not care how many nodes answered, so all three collapse to `redis`.
const REDIS_SCHEMES = new Set(['rediss', 'redis-cluster', 'redis-sentinel']);

// An unlisted scheme stays itself and lands on the "cannot be verified" fallthrough
// in inspectQuery: failing closed is right, claiming a dialect we cannot verify
// is not.
export const baseProtocol = (protocol) =>
  DIALECT_ALIASES.get(protocol) ?? (REDIS_SCHEMES.has(protocol) ? 'redis' : protocol);

export const isSqlProtocol = (protocol) => SQL_PROTOCOLS.has(baseProtocol(protocol));

export { SQL_PROTOCOLS };

export const MONGO_READ_ACTIONS = new Set(['find', 'count', 'distinct', 'aggregate', 'explain']);

// Read actions that carry a filter rather than a pipeline, derived from the set
// above so the two cannot drift apart.
const MONGO_FILTER_ACTIONS = new Set([...MONGO_READ_ACTIONS].filter((a) => a !== 'aggregate'));

// Every action the tool accepts. The three single-document writes (updateOne,
// replace, deleteOne) sit in the complement of the read set, so they inherit every
// write treatment: refused in read-only mode, walked for server-side JavaScript,
// and classified as destructive by ./policy.js.
export const MONGO_ACTIONS = new Set([
  ...MONGO_READ_ACTIONS, 'insert', 'update', 'updateOne', 'replace', 'delete', 'deleteOne',
]);

/** Every action that modifies data, so ./policy.js holds no second list of names. */
export const MONGO_WRITE_ACTIONS = new Set([...MONGO_ACTIONS].filter((a) => !MONGO_READ_ACTIONS.has(a)));

/**
 * Refuse query shapes that execute code on the database host, in either mode.
 *
 * `readOnly:false` is an opt-in to modify data. It is not an opt-in to run
 * arbitrary code on the host the database runs on. A write is visible, scoped and
 * reversible; code execution is none of those, so this check is independent of
 * read-only mode and the registry is expected to call it for every query.
 *
 * It does not decide whether data may change (that is inspectQuery's job), and it
 * does not refuse a MongoDB write action, though those payloads are still walked so
 * an update document carrying `$function` is refused. A payload it cannot parse
 * fails closed; call inspectQuery first for the specific complaint.
 *
 * Redis is out of scope: there the write and the code execution are the same
 * command, so `EVAL` and `FUNCTION` stay behind the read-only allowlist.
 *
 * @param {string} protocol - Lowercase URI scheme
 * @param {string} query - SQL statement or MongoDB filter/pipeline JSON
 * @param {object} [options] - Tool options; `action` and `allowWriteStages` are read
 * @returns {{safe: boolean, reason: string}}
 */
export function inspectDangerousOperators(protocol, query, options = {}) {
  if (typeof query !== 'string') {
    return { safe: false, reason: 'query must be a string' };
  }

  const base = baseProtocol(protocol);

  if (SQL_PROTOCOLS.has(base)) {
    const cleaned = stripSqlNoise(query, {
      backslashEscapes: usesBackslashEscapes(base),
      dollarQuoting: usesDollarQuoting(base),
    });
    for (const { re, reason } of SQL_CODE_EXECUTION_PATTERNS) {
      if (re.test(cleaned)) return { safe: false, reason };
    }
    return { safe: true, reason: '' };
  }

  if (base === 'mongodb') {
    let parsed;
    try {
      parsed = JSON.parse(query);
    } catch (e) {
      return { safe: false, reason: `payload is not valid JSON: ${e.message}` };
    }
    return inspectMongoPayload(parsed, options.action || 'find', options);
  }

  if (base === 'redis') return { safe: true, reason: '' };

  return { safe: false, reason: `protocol "${protocol}" cannot be verified` };
}

/**
 * Decide whether a query may run in read-only mode.
 *
 * @param {string} protocol - Lowercase URI scheme
 * @param {string} query - SQL, MongoDB filter JSON, or Redis command line
 * @param {object} [options] - Tool options, which decide the MongoDB action
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
