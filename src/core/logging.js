import fs from 'node:fs';
import nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { resolveAnyDbPaths, ensureDir, LOG_SINKS, FILE_MODE, DIR_MODE } from './paths.js';

const REDACTED = '***';

/** Every line this process writes starts with this, so it is attributable. */
const PREFIX = '[anydb]';

/**
 * Severity order: a record is emitted when its level is at or below the
 * configured threshold, so `error` is the lowest number and `trace` the highest.
 */
export const LOG_LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3, trace: 4 });

export const DEFAULT_LOG_LEVEL = 'info';

export const DEFAULT_FORMAT = 'text';

/** Free-form strings in ordinary detail fields are cut at this many characters. */
export const DEFAULT_MAX_VALUE_LENGTH = 512;

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_BACKUPS = 3;
export const DEFAULT_TTL_DAYS = 30;

/** Sweep for expired rotated files at most this often. */
const TTL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Record keys a field cannot set: they are the framing of the record itself. */
export const RESERVED_KEYS = Object.freeze(['ts', 'level', 'event', 'msg']);

/**
 * Keys a second argument may carry and still be read as an options bag. The test
 * is "every key is one of these", so a bag holding anything else is data.
 */
export const OPTION_KEYS = Object.freeze(['level', 'event', 'callId', 'fields']);

/**
 * Fields that are records in their own right rather than annotations on one: a
 * query is the thing that happened, a `uri` is a detail, so only the latter is cut.
 */
export const UNTRUNCATED_FIELDS = new Set(['query', 'sql', 'statement', 'error', 'stack']);

/**
 * Statement text never reaches the file unless ANYDB_LOG_QUERY_TEXT is on, even
 * when it reached stderr, so the file holds a hash and a length instead.
 */
const FILE_TEXT_FIELDS = ['query', 'sql', 'statement'];

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off', 'disable', 'disabled', 'none']);

const CONTROL_ESCAPES = new Map([['\n', '\\n'], ['\r', '\\r'], ['\t', '\\t'], ['\v', '\\v'], ['\f', '\\f']]);

/** Characters that are not legal unescaped in a line-oriented log. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Anything that makes `k=v` ambiguous to a reader or a regex. */
const NEEDS_QUOTES = /[\s"'\\=]|[\u0000-\u001f\u007f-\u009f]/;

/**
 * Parse a human-written boolean. Configuration is written by hand into launchd
 * units, systemd units, JSON MCP client configs and `.env` files, so `yes` has to
 * mean on.
 */
export function parseBool(raw, fallback = false) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return fallback;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return fallback;
}

/** An environment variable must never be able to remove a bound the code relies on. */
export function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function resolveLogLevel(raw, fallback = DEFAULT_LOG_LEVEL) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, value) ? value : fallback;
}

export function resolveLogFormat(raw, fallback = DEFAULT_FORMAT) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'json' ? 'json' : fallback;
}

/** Only anydb's own switches are read from a `.env`; the rest is not ours. */
const ENV_PREFIX = 'ANYDB_';

/**
 * The subset of dotenv syntax a config file needs: `KEY=value` lines, comments,
 * an optional `export ` prefix, and quotes. Never returns anything derived from
 * the values, because the file holds credentials.
 */
export function parseDotEnv(text) {
  const out = {};
  if (typeof text !== 'string') return out;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends at an inline comment, which is a ` #` so a
      // value containing a hash survives.
      const hash = value.search(/\s+#/);
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

const offValues = new Set(['off', '0', 'false', 'no', 'none', '-', 'disable']);

/**
 * Load `ANYDB_*` variables from a `.env` file into `env`. Two rules: a variable
 * already in the real environment always wins, because an MCP client launches the
 * server with whatever environment its own process had, so the file is a default
 * rather than an override; and only `ANYDB_*` is applied.
 *
 * @returns {string[]} the names that were applied, which is safe to log.
 */
export function loadDotEnv(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicit = typeof options.envFile === 'string' ? options.envFile : env.ANYDB_ENV_FILE;

  if (typeof explicit === 'string' && offValues.has(explicit.trim().toLowerCase())) return [];

  const candidates = explicit
    ? [explicit]
    : [
      // A `.env` beside `~/.anydb` (a dotfile layout), then the cwd, which is
      // where a project-local file lives.
      nodePath.join(nodePath.dirname(resolveAnyDbPaths(env).home), '.env'),
      nodePath.join(cwd, '.env'),
    ];

  for (const candidate of candidates) {
    let text;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      continue; // absent, unreadable, or a directory: try the next candidate
    }
    const applied = [];
    for (const [key, value] of Object.entries(parseDotEnv(text))) {
      if (!key.startsWith(ENV_PREFIX)) continue;
      if (env[key] !== undefined) continue; // the real environment wins
      env[key] = value;
      applied.push(key);
    }
    return applied;
  }
  return [];
}

let envLoaded = false;

/** Idempotent, lazy, never fatal: a bad `.env` is not a reason to refuse to run. */
function ensureEnvLoaded() {
  if (envLoaded) return;
  envLoaded = true;
  try {
    loadDotEnv();
  } catch {
    /* degraded configuration, still a running server */
  }
}

/** Control characters cannot appear in a URI; keeping one would forge a line. */
// eslint-disable-next-line no-control-regex
const URI_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Strip credentials so a connection string is safe to write to a log — MCP clients
 * capture the server's stderr into their own logs. The *whole* userinfo is masked,
 * not just the password: in IAM setups the username is the secret half. A
 * scheme-less `user:secret@host` is masked too, because redaction that depends on
 * a caller's validation is not redaction.
 */
export function maskUri(uri) {
  if (typeof uri !== 'string' || uri.length === 0) return String(uri);

  // Dropped, not escaped: a newline in a URI is either a bug or an attempt to
  // write a second `[anydb]` line, and neither belongs in this string.
  const clean = uri.replace(URI_CONTROL_CHARS, '');
  const schemeEnd = clean.indexOf('://');
  if (schemeEnd === -1) {
    return maskUserinfo(clean, '');
  }

  const scheme = clean.slice(0, schemeEnd + 3);
  let rest = clean.slice(schemeEnd + 3);

  // Dropped rather than parsed: MongoDB and Redis both accept credentials in
  // query parameters, and enumerating them is a list to forget to update.
  const suffixAt = rest.search(/[?#]/);
  let suffix = '';
  if (suffixAt !== -1) {
    suffix = ' <params redacted>';
    rest = rest.slice(0, suffixAt);
  }

  return scheme + maskUserinfo(rest, suffix);
}

/** Replace the `user[:password]@` prefix of an authority with a fixed token. */
function maskUserinfo(authority, suffix) {
  // The last `@` is the delimiter: a percent-encoded `@` may appear in a
  // username, but a host cannot contain a raw one.
  const at = authority.lastIndexOf('@');
  if (at <= 0) return authority + suffix;

  // A userinfo never starts with a path separator, so one that does is a path
  // that happens to contain an `@`, as in `sqlite:///var/db/user@host.db`.
  if (authority.startsWith('/')) return authority + suffix;
  const userinfo = authority.slice(0, at);
  const masked = userinfo.includes(':') ? `${REDACTED}:${REDACTED}` : REDACTED;
  return `${masked}@${authority.slice(at + 1)}${suffix}`;
}

/** Identify a query without echoing it: query text can hold sensitive literals. */
export function describeQuery(query) {
  if (typeof query !== 'string') return `<${typeof query}>`;
  const trimmed = query.trim();
  if (!trimmed) return '<empty>';
  return `${statementVerb(trimmed)} (${trimmed.length} chars)`;
}

/** The leading keyword, uppercased. `{"a":1}` has none, so it is a QUERY. */
export function statementVerb(query) {
  if (typeof query !== 'string') return 'QUERY';
  const trimmed = query.trim();
  if (!trimmed) return 'QUERY';
  return (trimmed.match(/^[a-z]+/i) || ['query'])[0].toUpperCase();
}

/**
 * A stable fingerprint of a statement: 16 hex characters of sha256, enough to
 * prove two runs issued byte-identical statements and short enough to eyeball
 * across a log. A digest, not an encoding — it cannot be turned back into the
 * query, so reproducibility is verifiable from a month-old log.
 */
export function statementHash(query) {
  const text = typeof query === 'string' ? query : String(query ?? '');
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** What goes into a log record instead of the statement itself. */
export function statementSummary(query) {
  const text = typeof query === 'string' ? query : '';
  return {
    hash: statementHash(query),
    bytes: text.length === 0 ? 0 : Buffer.byteLength(text, 'utf8'),
    verb: statementVerb(query),
  };
}

/** Snapshot of every knob, read fresh per record so tests and reconfiguration work. */
function readConfig() {
  ensureEnvLoaded();
  const env = process.env;
  return {
    level: resolveLogLevel(env.ANYDB_LOG_LEVEL, DEFAULT_LOG_LEVEL),
    format: resolveLogFormat(env.ANYDB_LOG_FORMAT, DEFAULT_FORMAT),
    maxValueLength: positiveInt(env.ANYDB_LOG_MAX_VALUE, DEFAULT_MAX_VALUE_LENGTH),
    queryText: parseBool(env.ANYDB_LOG_QUERY_TEXT, false),
    file: {
      ...resolveAnyDbPaths(),
      maxBytes: positiveInt(env.ANYDB_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
      backups: positiveInt(env.ANYDB_LOG_BACKUPS, DEFAULT_BACKUPS),
      ttlDays: positiveInt(env.ANYDB_LOG_TTL_DAYS, DEFAULT_TTL_DAYS),
    },
  };
}

const debugEnabled = () => {
  ensureEnvLoaded();
  return parseBool(process.env.ANYDB_DEBUG, false);
};

export const isDebugEnabled = debugEnabled;

/**
 * The level actually in force. ANYDB_DEBUG=1 is read as a request for debug
 * output and promotes the threshold whatever ANYDB_LOG_LEVEL says — deliberately
 * a different knob: ANYDB_LOG_LEVEL selects how much an operator wants to keep,
 * ANYDB_DEBUG says whether they are debugging now.
 */
function effectiveLevel() {
  const configured = resolveLogLevel(process.env.ANYDB_LOG_LEVEL, DEFAULT_LOG_LEVEL);
  if (!debugEnabled()) return configured;
  return LOG_LEVELS.debug > LOG_LEVELS[configured] ? 'debug' : configured;
}

/** True when a record at `level` should be emitted. */
export function logLevelEnabled(level) {
  ensureEnvLoaded();
  const wanted = resolveLogLevel(level, DEFAULT_LOG_LEVEL);
  return LOG_LEVELS[wanted] <= LOG_LEVELS[effectiveLevel()];
}

/**
 * `JSON.stringify` that cannot throw and cannot loop. A driver error object can
 * hold a socket, and a socket holds the error.
 */
function safeStringify(value) {
  const seen = new WeakSet();
  try {
    const json = JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[circular]';
        seen.add(val);
      }
      return val;
    });
    return json === undefined ? String(value) : json;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Put a value into the record in a shape both renderers can survive. Truncation is
 * applied here and only here, and only to top-level strings that are not a record
 * in their own right: the cap bounds an untrusted annotation so one value cannot
 * fill a log file, it is not meant to be quiet about the event itself.
 */
function normaliseValue(key, value, maxValueLength) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
      if (UNTRUNCATED_FIELDS.has(key)) return value;
      return value.length > maxValueLength ? `${value.slice(0, maxValueLength)}...` : value;
    case 'number':
      // NaN and Infinity serialise to null, naming a value the caller never passed.
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'symbol':
      return value.toString();
    case 'function':
      return `[function ${value.name || 'anonymous'}]`;
    default:
      break;
  }

  if (value instanceof Error) {
    const record = { name: value.name, message: value.message };
    if (value.code !== undefined) record.code = value.code;
    if (typeof value.stack === 'string' && logLevelEnabled('debug')) record.stack = value.stack;
    return record;
  }
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return `[${value.constructor?.name ?? 'buffer'} ${value.length} bytes]`;

  if (Array.isArray(value)) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return value;
  return String(value);
}

/**
 * Render a value for the `k=v` text format. A security control, not cosmetics: a
 * URI or an error message is attacker-influenced, and an unescaped newline in one
 * forges an arbitrary `[anydb]` line that a reader or a log shipper will believe.
 * So control characters are escaped and anything ambiguous is quoted, and exactly
 * one record occupies exactly one line.
 */
function renderTextValue(value) {
  if (typeof value === 'string') {
    // Quoting happens before control escaping: the other order would double-escape
    // every `\n` the quoting itself introduces.
    if (value === '' || NEEDS_QUOTES.test(value)) {
      const quoted = `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      return quoted.replace(CONTROL_CHARS, escapeControl);
    }
    return value.replace(CONTROL_CHARS, escapeControl);
  }
  return renderTextValue(safeStringify(value));
}

function escapeControl(char) {
  const named = CONTROL_ESCAPES.get(char);
  if (named) return named;
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** Escape without quoting, for the message and the event, which read as prose. */
const escapeText = (value) => value.replace(CONTROL_CHARS, escapeControl);

function renderText(record) {
  const parts = [PREFIX, record.ts, record.level];
  // The event is the message unless it was given separately, so the familiar
  // `log('server ready', { version })` does not print its name twice. Both are
  // escaped, for the same reason a value is.
  if (record.event !== record.msg) parts.push(escapeText(record.event));
  parts.push(escapeText(record.msg));
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED_KEYS.includes(key)) continue;
    parts.push(`${key}=${renderTextValue(value)}`);
  }
  return parts.join(' ');
}

const renderJson = (record) => safeStringify(record);

/** Sink state, keyed by the resolved file so a reconfiguration re-opens it. */
let sink = { path: null, lastSweep: 0 };
let sinkFailure = null;
const ensuredDirs = new Set();

/**
 * A logging failure must never take the server down. If the directory or file
 * cannot be written, one warning goes to stderr and logging continues there
 * alone — throwing out of a `log()` call would turn a disk quota problem into an
 * outage. `sinkFailure` only dedupes that warning; every later record retries.
 */
function degradeFileSink(error) {
  const reason = (error && error.code) || 'unknown';
  if (sinkFailure === reason) return;
  sinkFailure = reason;
  // Straight to stderr, not through writeRecord: the sink that just failed must
  // not be asked to report its own failure.
  writeStderr(
    `${PREFIX} ${new Date().toISOString()} warn log_sink ` +
    `file logging disabled (${reason}); continuing with stderr only`
  );
}

function writeStderr(line) {
  try {
    // stderr only: stdout carries MCP protocol traffic and must stay clean.
    console.error(line);
  } catch {
    /* a closed stream is the end of logging, not a reason to throw */
  }
}

/**
 * Move the active file aside. Not compressed: rotation is a rename per slot, and
 * a rename either happens or does not, so a crash can lose at most the file being
 * rotated into `.1` and never a gap in the middle. Compressing would add a read, a
 * rewrite and an unlink per slot to save disk on three files of 5 MiB.
 */
function rotate(logFile, { backups }) {
  // Oldest first: the file about to fall outside the window is discarded, then
  // every remaining slot moves one place older, then the active file becomes .1.
  const overflow = `${logFile}.${backups}`;
  if (fs.existsSync(overflow)) fs.rmSync(overflow, { force: true });
  for (let index = backups - 1; index >= 1; index -= 1) {
    const from = `${logFile}.${index}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${logFile}.${index + 1}`);
  }
  fs.renameSync(logFile, `${logFile}.1`);
}

/** Delete rotated files past the retention window. Best effort by design. */
function sweepExpired(logFile, ttlDays, backups) {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  // Scanned past `backups`, so lowering the backup count later does not strand
  // the files that were already rotated into those slots.
  for (let index = 1; index <= Math.max(backups, 64); index += 1) {
    const candidate = `${logFile}.${index}`;
    try {
      if (fs.statSync(candidate).mtimeMs < cutoff) fs.rmSync(candidate, { force: true });
    } catch {
      /* absent, or unlinkable: nothing to do */
    }
  }
}

function writeFile(line, config, record) {
  const { logFile, logFileMode, maxBytes, backups, ttlDays } = config.file;
  if (logFileMode !== LOG_SINKS.file) return;

  const dir = nodePath.dirname(logFile);
  if (!ensuredDirs.has(dir)) {
    ensureDir(dir, DIR_MODE);
    ensuredDirs.add(dir);
  }

  // Checked on the way in, so the active file never grows past the cap but by one
  // record.
  let size = 0;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    size = 0; // first write to this file
  }
  if (size > 0 && size + Buffer.byteLength(line) + 1 > maxBytes) rotate(logFile, { backups });

  const now = Date.now();
  if (sink.path !== logFile) {
    sink = { path: logFile, lastSweep: 0 };
  }
  if (now - sink.lastSweep > TTL_SWEEP_INTERVAL_MS) {
    sink.lastSweep = now;
    sweepExpired(logFile, ttlDays, backups);
  }

  // Query text is dropped from the file record unless it was asked for, so a
  // retained file holds hashes even when the operator has debugging on.
  const forFile = config.queryText
    ? record
    : Object.fromEntries(Object.entries(record).filter(([key]) => !FILE_TEXT_FIELDS.includes(key)));

  const fileLine = config.format === 'json'
    ? renderJson(forFile)
    : renderText(forFile);

  fs.appendFileSync(logFile, `${fileLine}\n`, { mode: FILE_MODE });
}

function buildRecord(message, fields, options, config) {
  const msg = typeof message === 'string' ? message : String(message);
  const record = {
    ts: new Date().toISOString(),
    level: resolveLogLevel(options.level, 'info'),
    event: typeof options.event === 'string' && options.event !== '' ? options.event : msg,
    msg,
  };

  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_KEYS.includes(key)) continue;
    const normalised = normaliseValue(key, value, config.maxValueLength);
    if (normalised === undefined) continue;
    record[key] = normalised;
  }

  if (options.callId !== undefined) {
    const normalised = normaliseValue('callId', options.callId, config.maxValueLength);
    if (normalised !== undefined) record.callId = normalised;
  }
  return record;
}

function emit(record, config) {
  if (!logLevelEnabled(record.level)) return;
  const line = config.format === 'json' ? renderJson(record) : renderText(record);
  writeStderr(line);
  try {
    writeFile(line, config, record);
  } catch (error) {
    degradeFileSink(error);
  }
}

/** An object is an options bag only if every key in it is an options key. */
const isOptionsBag = (value) => {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => OPTION_KEYS.includes(key));
};

/**
 * Write one record. Two call shapes, both supported:
 *
 *   log('db_query', { uri, rows, durationMs })
 *   log('db_query', { uri, rows }, { level: 'info', event: 'tool_call', callId })
 *   log('db_query', { level: 'error', uri })          // options only
 *
 * `options.fields` is the explicit escape hatch for a bag that has to be both.
 */
export function log(message, detail = {}, options) {
  const config = readConfig();

  let fields;
  let opts;
  if (options !== undefined && options !== null) {
    fields = isPlainObject(detail) ? detail : {};
    opts = isPlainObject(options) ? options : {};
  } else if (isOptionsBag(detail)) {
    fields = isPlainObject(detail.fields) ? detail.fields : {};
    opts = detail;
  } else {
    fields = isPlainObject(detail) ? detail : {};
    opts = {};
  }

  emit(buildRecord(message, fields, opts, config), config);
}

/**
 * Log the statement behind a call, at debug. The full text goes to stderr and
 * nowhere else: the file records `stmt` (hash, byte count, verb) and only carries
 * text when ANYDB_LOG_QUERY_TEXT says so.
 */
export function logQueryDetail(uri, query, fields = {}) {
  // "Debug on" is the dedicated switch or a level low enough to want debug records.
  if (!debugEnabled() && !logLevelEnabled('debug')) return;

  log(
    'query',
    {
      ...(isPlainObject(fields) ? fields : {}),
      uri: maskUri(uri),
      stmt: statementSummary(query),
      query: typeof query === 'string' ? query : String(query ?? ''),
    },
    { level: 'debug', event: 'query' }
  );
}

/**
 * Report a failure with its stack. The message is an `error` record so it shows at
 * the default level; the stack is a separate `debug` record, because a stack is
 * for the operator who turned debugging on and is noise to everyone else.
 */
export function logError(event, error, fields = {}) {
  const message = error && error.message ? String(error.message) : String(error);
  const extra = { ...(isPlainObject(fields) ? fields : {}) };

  if (error && typeof error === 'object') {
    if (error.name && error.name !== 'Error') extra.errName = error.name;
    if (error.code !== undefined) extra.code = error.code;
  }

  log(message, extra, { level: 'error', event: event || 'error' });

  if (error && typeof error.stack === 'string' && logLevelEnabled('debug')) {
    log(error.stack, { error: event || 'error' }, { level: 'debug', event: `${event || 'error'}.stack` });
  }
}

/** Whether query text is permitted into the log file. */
export const queryTextEnabled = () => parseBool(process.env.ANYDB_LOG_QUERY_TEXT, false);
