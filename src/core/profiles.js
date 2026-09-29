/**
 * Named connection profiles: the `db.json` store.
 *
 * A `db.json` is a plaintext credential store, so it must be 0600 and anything that can
 * write files can plant a profile. The answer is to keep the *reference* in the file and
 * the *secret* elsewhere: `{"password":{"env":"DB_PASSWORD"}}` and
 * `{"password":{"keychain":"anydb/db"}}` make the file on disk not a credential. A literal
 * `"password"` is still accepted, and warned about once per profile.
 *
 * The other threat is on the other side of this file: `description`, schema names and
 * table names reach the model's context window, so anyone who can write `db.json` can
 * inject instructions through them. That is why description length and list sizes are
 * capped, and why unknown keys are ignored, not obeyed.
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import { execFile as nodeExecFile } from 'node:child_process';
import { evaluatePolicy, parseConnectionUri, CREDENTIAL_QUERY_PARAMS } from './policy.js';
import { resolveAnyDbPaths, ensureDir } from './paths.js';
import { maskUri } from './logging.js';

/** Schema URL written into files this module creates, so an editor offers completion. */
export const PROFILE_SCHEMA_URL = 'https://anydb.dev/schema/db.json';

/** The file name used when a directory is given rather than a path. */
export const CONFIG_BASENAME = 'db.json';

/** Directory mode for the folder holding the config: the same rule as `~/.ssh`. */
const DIR_MODE = 0o700;

/** File mode for the config. A credential store any local account can read is not a credential store. */
const FILE_MODE = 0o600;

/** Drivers a profile may name. The SQLAlchemy aliases are here because `registry.js` routes them. */
export const SUPPORTED_DRIVERS = Object.freeze([
  'postgres', 'postgresql', 'mysql', 'mariadb', 'sqlite', 'mongodb', 'redis', 'rediss',
]);

/**
 * Description cap: the only part of a profile the model reads, so a context cost and a
 * prompt-injection surface. 500 characters is one paragraph.
 */
const MAX_DESCRIPTION = 500;

/** How many names one list may hold, for the same reason: they all reach the model's context. */
const MAX_LIST_ENTRIES = 128;

/** Per-element cap for the same reason. A 64 KB "table name" is not a table name. */
const MAX_NAME_LENGTH = 256;

/** Total profiles, so `list()` cannot be turned into a context flood. */
const MAX_PROFILES = 256;

/** Row ceiling. A cap an order of magnitude above any real report, low enough to bound one response. */
const MAX_ROWS_CAP = 1000000;

/** Byte ceiling. Rows are truncated by the adapter; this is the outer limit, not the enforcement point. */
const MAX_BYTES_CAP = 64 * 1024 * 1024;

/** Mirrors `MIN_TIMEOUT` / `MAX_TIMEOUT` in `registry.js`: 1 ms guards a typo, 24 h guards an overflow. */
const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 24 * 60 * 60 * 1000;

/** A connect that has not finished in a minute is a hang, not a slow database. */
const MAX_CONNECT_TIMEOUT_MS = 60000;

/** A secret file larger than this is a mistake, and reading it would put megabytes in memory. */
const MAX_SECRET_FILE_BYTES = 64 * 1024;

/** Default budget for a credential command. Long enough for `op` to unlock a vault, short enough to fail fast. */
const EXEC_DEFAULT_TIMEOUT_MS = 5000;

/** Cap on a credential command's output. A command that prints more than this is not printing a password. */
const EXEC_MAX_BUFFER = 1024 * 1024;

/** Credential sources, in the shape 1Password CLI and AWS converged on. */
export const CREDENTIAL_REF_KEYS = Object.freeze(['env', 'file', 'exec', 'keychain']);

/**
 * Profile names that are refused: a name becomes a key in a plain object when the file is
 * written, and `__proto__` as a key is a prototype-pollution gadget.
 */
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Keys this module understands. Anything else is warned about and ignored. */
const KNOWN_PROFILE_KEYS = new Set([
  'description', 'driver', 'uri', 'path', 'password', 'username',
  'readOnly', 'maxRows', 'maxBytes', 'queryTimeoutMs', 'connectTimeoutMs',
  'allowedSchemas', 'allowedTables', 'hosts', 'allowedPaths', 'allowDestructive', 'options',
]);

/** Shape of a URI scheme, so `"1abc://x"` is refused rather than treated as a driver. */
const SCHEME_RE_FOR_PROFILES = /^[a-z][a-z0-9+.-]*$/;

/**
 * Schemes a URI may use that are not driver names: the SQLAlchemy aliases `registry.js`
 * routes, MongoDB's SRV form, and the two Redis topologies. The list a *user* trips over,
 * because it is what rejects a `db.json` at load time; `__tests__/test_schemes.test.js`
 * guards it.
 */
const SCHEME_ALIASES = new Set([
  'mongodb+srv', 'sqlite+pysqlite',
  'mysql+pymysql', 'mysql+mysqldb', 'mysql+asyncmy', 'mysql+aiohttp',
  'mysql+aiomysql', 'mysql+cymysql',
  'mariadb+pymysql', 'mariadb+mariadbconnector',
  'redis-cluster', 'redis-sentinel',
]);

/** Every scheme a profile's `"uri"` may use. Exported so the drift test can assert
 *  the same set the validator enforces. */
export const SUPPORTED_URI_SCHEMES = Object.freeze(new Set([
  ...SUPPORTED_DRIVERS, ...SCHEME_ALIASES,
]));

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * `configError` redacts before it throws rather than trusting every caller.
 *
 * The message carries the operator's own file quoted back at them, and one of the fields
 * it quotes is a credential. `maskUri` covers both shapes: a `scheme://` prefix and a
 * bare `user:secret@host`. A message with neither comes back unchanged.
 */
const redactConfigMessage = (message) => {
  if (typeof message !== 'string') return message;
  if (!message.includes('://') && !message.includes('@')) return message;
  return maskUri(message);
};

const configError = (file, pointer, message) =>
  new Error(`${file}: ${pointer} ${redactConfigMessage(message)}`);

const pathImpl = (platform) => (platform === 'win32' ? nodePath.win32 : nodePath.posix);

// One warning per key per process, or a warning stops being read.
const warned = new Set();
function warnOnce(log, key, message, detail = {}) {
  if (warned.has(key)) return;
  warned.add(key);
  if (typeof log === 'function') log(message, detail);
}

/** Forget which warnings have been emitted. Exported for tests. */
export function resetProfileWarnings() {
  warned.clear();
}

/** Remove a single trailing newline, which a secret file conventionally ends with. */
const trimTrailingNewline = (text) => text.replace(/\r?\n$/, '');

/**
 * Split a connection string into the authority and everything after it.
 * @returns {{ scheme, authority, tail }|null}
 */
function splitAuthority(uri) {
  const marker = uri.indexOf('://');
  if (marker === -1) return null;
  const scheme = uri.slice(0, marker + 3);
  const rest = uri.slice(marker + 3);
  const boundary = rest.search(/[/?#]/);
  const at = boundary === -1 ? rest.length : boundary;
  return { scheme, authority: rest.slice(0, at), tail: rest.slice(at) };
}

/**
 * Remove a credential from a connection string, keeping the username.
 *
 * Two places carry a secret and both are handled. The query string is the one that is easy
 * to forget: MongoDB and Redis both accept `?password=` and `?auth=`. The rest of the
 * query is kept, because `?ssl=true` is load-bearing.
 *
 * @returns {{ uri, password }} The stripped string and the secret removed, so a caller can
 *   put it back once it has a source it trusts.
 */
export function stripCredentialFromUri(uri) {
  const parts = splitAuthority(uri);
  if (!parts) return { uri, password: null };

  let { authority, tail } = parts;

  let password = null;
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(':');
    if (colon !== -1) {
      password = decodeURIComponent(userinfo.slice(colon + 1));
      authority = `${userinfo.slice(0, colon)}@${authority.slice(at + 1)}`;
    }
  }

  const question = tail.indexOf('?');
  if (question !== -1) {
    const hash = tail.indexOf('#', question);
    const head = tail.slice(0, question);
    const query = hash === -1 ? tail.slice(question + 1) : tail.slice(question + 1, hash);
    const kept = [];
    for (const pair of query.split('&')) {
      if (pair === '') continue;
      const equals = pair.indexOf('=');
      const key = decodeURIComponent(equals === -1 ? pair : pair.slice(0, equals)).toLowerCase();
      if (CREDENTIAL_QUERY_PARAMS.includes(key)) {
        if (password === null && equals !== -1) password = decodeURIComponent(pair.slice(equals + 1));
        continue;
      }
      kept.push(pair);
    }
    const rebuilt = kept.length > 0 ? `${head}?${kept.join('&')}` : head;
    tail = hash === -1 ? rebuilt : rebuilt + tail.slice(hash);
  }

  return { uri: parts.scheme + authority + tail, password };
}

/**
 * Put a password into a connection string.
 *
 * Redis ACLs have a `default` user with no name, so `redis://:pass@host` is the normal
 * form. A URI with no userinfo and no username to add is refused: every driver
 * authenticates a user before it reads a password. The password is percent-encoded, or an
 * unencoded `@` or `/` moves the authority boundary.
 *
 * @param {string} uri - Connection string, normally one from `stripCredentialFromUri`
 * @param {string} [user] - Username to use when the URI has no userinfo
 */
export function injectCredentials(uri, passwordValue, user) {
  if (typeof uri !== 'string' || uri === '') {
    throw new Error('injectCredentials needs a connection string.');
  }
  if (passwordValue === undefined || passwordValue === null || passwordValue === '') return uri;
  if (typeof passwordValue !== 'string') {
    throw new Error('injectCredentials needs the password as a string.');
  }

  const parts = splitAuthority(uri);
  if (!parts) {
    // Masked for the same reason as `configError`: reached with a URI in hand.
    throw new Error(
      `Cannot attach a password to "${maskUri(uri)}": expected a connection string like scheme://host/… .`
    );
  }

  const { authority, tail } = parts;
  const at = authority.lastIndexOf('@');
  const hadUserinfo = at !== -1;
  const hostpart = hadUserinfo ? authority.slice(at + 1) : authority;
  const userinfo = hadUserinfo ? authority.slice(0, at) : '';
  const colon = userinfo.indexOf(':');
  let name = colon === -1 ? userinfo : userinfo.slice(0, colon);

  if (name === '') {
    if (!hadUserinfo && typeof user === 'string' && user !== '') {
      name = user;
    } else if (!hadUserinfo) {
      throw new Error(
        'Cannot attach a password: the connection string has no username, and every driver ' +
        'authenticates a user before it reads a password. Add one to the profile, for example ' +
        '"uri": "postgres://app@db.internal:5432/mydb".'
      );
    }
  }

  return `${parts.scheme}${name}:${encodeURIComponent(passwordValue)}@${hostpart}${tail}`;
}

/** Read a finite positive integer, refusing anything else. */
function positiveInteger(file, pointer, value, minimum, maximum, cap, log) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw configError(file, pointer, `must be a finite number, got ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw configError(file, pointer, `must be an integer, got ${value}`);
  }
  if (value < minimum) {
    throw configError(file, pointer, `must be at least ${minimum}, got ${value}`);
  }
  if (value > maximum) {
    // Above the hard maximum the value is refused rather than clamped: a timeout of
    // 10^12 ms is always a typo. `cap` only ever makes a limit more conservative.
    throw configError(file, pointer, `must be at most ${maximum}, got ${value}. Omit it to use the default.`);
  }
  if (value > cap) {
    warnOnce(log, `clamp:${pointer}`, 'a profile limit was clamped to its maximum', { field: pointer, from: value, to: cap });
    return cap;
  }
  return value;
}

/** Read an array of short non-empty strings, with the context-budget caps. */
function nameList(file, pointer, value, log) {
  if (!Array.isArray(value)) {
    throw configError(file, pointer, `must be an array of strings, got ${typeof value}`);
  }
  if (value.length > MAX_LIST_ENTRIES) {
    warnOnce(log, `list-size:${pointer}`, 'a profile list was truncated', { field: pointer, from: value.length, to: MAX_LIST_ENTRIES });
  }
  return value.slice(0, MAX_LIST_ENTRIES).map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw configError(file, `${pointer}[${index}]`, 'must be a non-empty string');
    }
    if (item.length > MAX_NAME_LENGTH) {
      throw configError(file, `${pointer}[${index}]`, `must be at most ${MAX_NAME_LENGTH} characters, got ${item.length}`);
    }
    return item;
  });
}

/**
 * Read a description, dropping control characters and truncating.
 *
 * Both halves are for the model: a terminal escape sequence in a printed transcript is an
 * attack on whoever reads the log, and a profile must not dictate how much of the context
 * window it takes.
 */
function description(file, pointer, value, log) {
  if (typeof value !== 'string') {
    throw configError(file, pointer, `must be a string, got ${typeof value}`);
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  if (cleaned.length > MAX_DESCRIPTION) {
    warnOnce(log, `description:${pointer}`, 'a profile description was truncated', { field: pointer, from: cleaned.length, to: MAX_DESCRIPTION });
    return cleaned.slice(0, MAX_DESCRIPTION);
  }
  return cleaned;
}

/**
 * Validate a credential reference.
 *
 * Exactly one source, and no unrecognised fields. Stricter than the rest of the file on
 * purpose: a misspelled `{ "environment": "DB_PASSWORD" }` would resolve to no credential,
 * and surface as an authentication error rather than as a typo.
 * @returns {object|string} The reference, or a literal password
 */
function credentialRef(file, pointer, raw) {
  if (typeof raw === 'string') return raw;
  if (!isPlainObject(raw)) {
    throw configError(file, pointer, 'must be a password string or a credential reference object with one of: '
      + `${CREDENTIAL_REF_KEYS.join(', ')}`);
  }

  const present = CREDENTIAL_REF_KEYS.filter((key) => raw[key] !== undefined);
  if (present.length !== 1) {
    throw configError(file, pointer, `must name exactly one credential source (${CREDENTIAL_REF_KEYS.join(', ')}), `
      + `found ${present.length === 0 ? 'none' : present.join(' and ')}`);
  }
  const [source] = present;

  const known = new Set([...CREDENTIAL_REF_KEYS, 'account', 'timeoutMs']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw configError(file, `${pointer}.${key}`, 'is not a recognised credential reference field');
    }
  }

  if (source === 'env') {
    if (typeof raw.env !== 'string' || raw.env.trim() === '') {
      throw configError(file, `${pointer}.env`, 'must be the name of an environment variable');
    }
  } else if (source === 'file') {
    if (typeof raw.file !== 'string' || raw.file.trim() === '') {
      throw configError(file, `${pointer}.file`, 'must be a path to a file holding the secret');
    }
  } else if (source === 'exec') {
    if (!Array.isArray(raw.exec) || raw.exec.length === 0) {
      throw configError(file, `${pointer}.exec`, 'must be a non-empty array of arguments, for example '
        + '["op", "read", "op://vault/db/password"]');
    }
    raw.exec.forEach((arg, index) => {
      if (typeof arg !== 'string') {
        throw configError(file, `${pointer}.exec[${index}]`, `must be a string, got ${typeof arg}`);
      }
    });
    if (raw.exec[0].trim() === '') {
      throw configError(file, `${pointer}.exec[0]`, 'must be the program to run');
    }
  } else {
    if (typeof raw.keychain !== 'string' || raw.keychain.trim() === '') {
      throw configError(file, `${pointer}.keychain`, 'must be a keychain service name');
    }
    if (raw.account !== undefined && typeof raw.account !== 'string') {
      throw configError(file, `${pointer}.account`, `must be a string, got ${typeof raw.account}`);
    }
  }

  if (raw.timeoutMs !== undefined
    && !(typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0)) {
    throw configError(file, `${pointer}.timeoutMs`, `must be a positive number of milliseconds, got ${String(raw.timeoutMs)}`);
  }

  return raw;
}

/**
 * Collapse a driver or scheme to the family it routes to, for warnings.
 */
const driverFamily = (name) => {
  if (name === 'postgres' || name === 'postgresql') return 'postgres';
  if (name === 'mysql' || name === 'mariadb' || name.startsWith('mysql+') || name.startsWith('mariadb+')) {
    return 'mysql';
  }
  if (name === 'sqlite' || name.startsWith('sqlite+')) return 'sqlite';
  if (name === 'mongodb' || name === 'mongodb+srv') return 'mongodb';
  if (name === 'redis' || name === 'rediss' || name === 'redis-cluster' || name === 'redis-sentinel') return 'redis';
  return name;
};

/**
 * Validate one profile entry.
 * @param {string} file - Config path, for error messages
 * @param {object} ctx - `{ configDir, platform, log }`
 */
function validateProfileEntry(file, name, raw, ctx) {
  const { configDir, platform, log } = ctx;
  const impl = pathImpl(platform);
  const at = (field) => `profiles.${name}.${field}`;

  if (!isPlainObject(raw)) {
    throw configError(file, `profiles.${name}`, `must be an object, got ${Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw}`);
  }

  // Unknown keys warn and are dropped, never merged. A config written for a newer version
  // should still load: refusing to start over an unused key gets the key deleted.
  const unknown = Object.keys(raw).filter((key) => !KNOWN_PROFILE_KEYS.has(key));
  if (unknown.length > 0) {
    warnOnce(log, `unknown-keys:${file}:${name}`, 'ignoring unrecognised profile keys',
      { profile: name, keys: unknown.join(', '), hint: 'this version does not use them; they will not be sent to the driver' });
  }

  const entry = { name };

  if (raw.description !== undefined) {
    entry.description = description(file, at('description'), raw.description, log);
  }

  if (raw.driver !== undefined) {
    if (typeof raw.driver !== 'string') {
      throw configError(file, at('driver'), `must be a string, got ${typeof raw.driver}`);
    }
    const driver = raw.driver.toLowerCase();
    if (!SUPPORTED_DRIVERS.includes(driver)) {
      throw configError(file, at('driver'), `must be one of ${SUPPORTED_DRIVERS.join(', ')}, got "${raw.driver}"`);
    }
    entry.driver = driver;
  }

  if (raw.username !== undefined) {
    if (typeof raw.username !== 'string' || raw.username === '') {
      throw configError(file, at('username'), `must be a non-empty string, got ${JSON.stringify(raw.username)}`);
    }
    entry.username = raw.username;
  }

  if (raw.uri !== undefined) {
    if (typeof raw.uri !== 'string' || !raw.uri.includes('://')) {
      throw configError(file, at('uri'), `must be a connection string containing "://", got ${JSON.stringify(raw.uri)}`);
    }
    const scheme = raw.uri.slice(0, raw.uri.indexOf('://')).toLowerCase();
    if (!SCHEME_RE_FOR_PROFILES.test(scheme)) {
      throw configError(
        file,
        at('uri'),
        // No truncation: cutting a redacted string at 40 could land inside the secret token.
        `must start with a scheme such as postgres://, got "${raw.uri}"`
      );
    }
    if (!SUPPORTED_URI_SCHEMES.has(scheme)) {
      throw configError(file, at('uri'), `scheme "${scheme}" is not supported. Supported: ${[...SUPPORTED_URI_SCHEMES].join(', ')}`);
    }
    entry.uri = raw.uri;
  }

  if (raw.path !== undefined) {
    if (typeof raw.path !== 'string' || raw.path.trim() === '') {
      throw configError(file, at('path'), `must be a non-empty string, got ${JSON.stringify(raw.path)}`);
    }
    // Resolved against the config file's own directory, so a `db.json` committed to a
    // repository can carry `./data/app.db` and work everywhere. The MCP client, not the
    // config's author, sets the working directory.
    entry.path = impl.resolve(configDir, raw.path);
  }

  if (raw.password !== undefined) {
    entry.password = credentialRef(file, at('password'), raw.password);
  }

  if (raw.readOnly !== undefined) {
    if (typeof raw.readOnly !== 'boolean') {
      throw configError(file, at('readOnly'), `must be true or false, got ${JSON.stringify(raw.readOnly)}`);
    }
    entry.readOnly = raw.readOnly;
  }

  if (raw.allowDestructive !== undefined) {
    if (typeof raw.allowDestructive !== 'boolean') {
      throw configError(file, at('allowDestructive'), `must be true or false, got ${JSON.stringify(raw.allowDestructive)}`);
    }
    entry.allowDestructive = raw.allowDestructive;
  }

  if (raw.maxRows !== undefined) {
    entry.maxRows = positiveInteger(file, at('maxRows'), raw.maxRows, 1, Number.MAX_SAFE_INTEGER, MAX_ROWS_CAP, log);
  }
  if (raw.maxBytes !== undefined) {
    entry.maxBytes = positiveInteger(file, at('maxBytes'), raw.maxBytes, 1, Number.MAX_SAFE_INTEGER, MAX_BYTES_CAP, log);
  }
  if (raw.queryTimeoutMs !== undefined) {
    entry.queryTimeoutMs = positiveInteger(file, at('queryTimeoutMs'), raw.queryTimeoutMs, MIN_TIMEOUT, MAX_TIMEOUT, MAX_TIMEOUT, log);
  }
  if (raw.connectTimeoutMs !== undefined) {
    entry.connectTimeoutMs = positiveInteger(file, at('connectTimeoutMs'), raw.connectTimeoutMs, MIN_TIMEOUT, MAX_CONNECT_TIMEOUT_MS, MAX_CONNECT_TIMEOUT_MS, log);
  }

  for (const field of ['allowedSchemas', 'allowedTables', 'hosts']) {
    if (raw[field] !== undefined) {
      entry[field] = nameList(file, at(field), raw[field], log);
    }
  }
  if (raw.allowedPaths !== undefined) {
    entry.allowedPaths = nameList(file, at('allowedPaths'), raw.allowedPaths, log)
      .map((value) => impl.resolve(configDir, value));
  }

  if (raw.options !== undefined) {
    if (!isPlainObject(raw.options)) {
      throw configError(file, at('options'), `must be an object of driver options, got ${typeof raw.options}`);
    }
    // Passed through verbatim, but bounded: `options` is attacker-influenceable.
    const entries = Object.entries(raw.options);
    if (entries.length > 64) {
      throw configError(file, at('options'), `must have at most 64 driver options, got ${entries.length}`);
    }
    for (const [key, value] of entries) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw configError(file, `${at('options')}.${key}`, 'must be a string, number or boolean');
      }
    }
    entry.options = Object.fromEntries(entries);
  }

  if (entry.uri === undefined && entry.path === undefined) {
    throw configError(file, `profiles.${name}`, 'must have either "uri" or "path"; there is nothing to connect to without one. '
      + 'For SQLite use "path": "./data/app.db".');
  }

  if (entry.path !== undefined && entry.driver !== undefined && entry.driver !== 'sqlite') {
    throw configError(file, at('path'), `is a SQLite field but the driver is "${entry.driver}". Use "uri" instead, or set "driver": "sqlite".`);
  }
  if (entry.path !== undefined && entry.password !== undefined) {
    throw configError(file, at('password'), 'is meaningless for a SQLite file, which is opened with the filesystem permissions of this process and has no credentials.');
  }
  if (entry.path !== undefined && entry.uri !== undefined) {
    warnOnce(log, `path-and-uri:${file}:${name}`, 'a profile sets both "path" and "uri"', { profile: name, used: 'uri' });
  }

  if (entry.driver !== undefined && entry.uri !== undefined) {
    const scheme = entry.uri.slice(0, entry.uri.indexOf('://')).toLowerCase();
    if (driverFamily(entry.driver) !== driverFamily(scheme)) {
      warnOnce(log, `driver-mismatch:${file}:${name}`, 'a profile names a driver its URI does not use',
        { profile: name, driver: entry.driver, uriScheme: scheme, used: 'uri' });
    }
  }

  // Read here so `resolve()` can attach a password and `list()` never parses one.
  if (entry.username === undefined && entry.uri !== undefined) {
    const parsed = parseConnectionUri(entry.uri);
    if (parsed && parsed.user) {
      try {
        entry.username = decodeURIComponent(parsed.user);
      } catch {
        entry.username = parsed.user;
      }
    }
  }

  return entry;
}

/** Run a command and return stdout, with no shell anywhere in the path. */
function runCommand(execFileFn, file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // execFile with an argv array, never exec with a string. This is the whole reason no
    // shell is involved: `exec` hands its string to /bin/sh, where a service name or key
    // name out of the config file can carry `; rm -rf ~`.
    execFileFn(file, args, {
      timeout: timeoutMs,
      maxBuffer: EXEC_MAX_BUFFER,
      encoding: 'utf8',
      // No console window per lookup: noise on Windows, and a hint to anything watching.
      windowsHide: true,
    }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/**
 * Describe a command failure without its output.
 *
 * `execFile` puts captured stderr in `error.message`, and stderr from a credential helper
 * can be the credential. The code and the signal are used, never the message.
 */
function describeExecFailure(error, timeoutMs) {
  if (!error) return 'it failed for an unknown reason';
  if (error.killed || error.signal === 'SIGTERM' || error.signal === 'SIGKILL') {
    return `it did not finish within ${timeoutMs}ms and was stopped`;
  }
  if (error.code === 'ENOENT') return 'the program was not found on PATH';
  if (error.code === 'EACCES') return 'the program is not executable by this process';
  if (typeof error.code === 'number') return `it exited with code ${error.code}`;
  if (typeof error.code === 'string') return `it failed with ${error.code}`;
  return 'it failed';
}

/**
 * Turn `ANYDB_KEYCHAIN_CMD` into an argv array.
 *
 * Split on whitespace, with no shell and no quoting: a service or account name containing a
 * space cannot be expressed in a template, and `keychainProvider` covers that case.
 */
function keychainArgv(template, service, account) {
  const substitute = (token) => token
    .replaceAll('{service}', service)
    .replaceAll('{account}', account ?? '');
  return template
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => substitute(token).replace(/^(['"])(.*)\1$/, '$2'));
}

/**
 * Resolve one credential reference into a secret.
 *
 * Everything here holds the secret in a local variable and nowhere else. It is not logged,
 * not attached to an error, and not put in a message: an error thrown by a credential helper
 * is common enough that a leaked secret would outlive the session that caused it. The caller
 * puts the value straight into a connection string, the only place it is needed.
 *
 * @param {object} deps - `{ env, fs, log, keychainProvider, execFile, profile, platform }`
 */
async function resolveCredential(ref, deps) {
  const { env, fs, log, keychainProvider, execFile: execFileFn, profile } = deps;

  if (typeof ref === 'string') {
    // Not an error: a literal password is a 0600 file, as ~/.pgpass has always been.
    warnOnce(log, `literal-password:${profile}`, 'a profile stores its password in plain text',
      { profile, hint: 'use {"password":{"env":"NAME"}}, {"exec":[...]} or {"keychain":"service"} to keep the secret out of the file' });
    return ref;
  }

  if (ref.env !== undefined) {
    const name = ref.env.trim();
    const value = env[name];
    // No fallback: a visible failure beats a mysterious authentication error.
    if (typeof value !== 'string' || value === '') {
      throw new Error(
        `profile "${profile}": password.env is "${name}", but that environment variable is unset or empty. `
        + 'Export it before starting anydb-mcp, or point the profile at another source (file, exec, keychain).'
      );
    }
    return value;
  }

  if (ref.file !== undefined) {
    const target = ref.file;
    let stat;
    try {
      stat = fs.statSync(target);
    } catch (error) {
      throw new Error(`profile "${profile}": password.file "${target}" could not be opened (${error.code || 'unknown error'}).`);
    }
    if (!stat.isFile()) {
      throw new Error(`profile "${profile}": password.file "${target}" is not a regular file.`);
    }
    if (stat.size > MAX_SECRET_FILE_BYTES) {
      throw new Error(`profile "${profile}": password.file "${target}" is ${stat.size} bytes, over the ${MAX_SECRET_FILE_BYTES} byte limit. `
        + 'A file holding a password is small; something else is in there.');
    }
    // A warning, never a refusal: a network mount, a container or a fuse layer reports modes
    // that mean nothing, and refusing a working configuration over an unreliable check is
    // worse than saying so once.
    if (deps.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      warnOnce(log, `secret-file-mode:${target}`, 'a secret file is readable beyond its owner',
        { profile, path: target, mode: `0${(stat.mode & 0o777).toString(8)}`, hint: 'chmod 0400 (or 0600) so only the owner can read it' });
    }
    let text;
    try {
      text = fs.readFileSync(target, { encoding: 'utf8' });
    } catch (error) {
      throw new Error(`profile "${profile}": password.file "${target}" could not be read (${error.code || 'unknown error'}).`);
    }
    // One trailing newline goes; a password with a newline on the end fails to authenticate.
    return trimTrailingNewline(text);
  }

  if (ref.exec !== undefined) {
    const argv = ref.exec;
    const timeoutMs = ref.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS;
    let stdout;
    try {
      stdout = await runCommand(execFileFn, argv[0], argv.slice(1), timeoutMs);
    } catch (error) {
      throw new Error(`profile "${profile}": password.exec [${argv.join(' ')}] did not produce a secret: ${describeExecFailure(error, timeoutMs)}. `
        + 'Its output is deliberately not included, because that output is the secret.');
    }
    return trimTrailingNewline(String(stdout));
  }

  const service = ref.keychain;
  const account = ref.account;

  if (typeof keychainProvider === 'function') {
    let value;
    try {
      value = await keychainProvider(service, account);
    } catch (error) {
      throw new Error(`profile "${profile}": the keychain provider failed for ${service}/${account ?? '(no account)'} `
        + `(${error && error.code ? error.code : 'error'}).`);
    }
    if (typeof value !== 'string' || value === '') {
      throw new Error(`profile "${profile}": the keychain provider returned no value for ${service}/${account ?? '(no account)'}.`);
    }
    return value;
  }

  const template = env.ANYDB_KEYCHAIN_CMD;
  if (typeof template !== 'string' || template.trim() === '') {
    // The zero-dependency escape hatch: a real keychain reader is a native module, and this
    // project takes no runtime dependencies beyond database drivers.
    throw new Error(
      `profile "${profile}": password.keychain needs a keychain reader and this server has none built in. `
      + 'Set ANYDB_KEYCHAIN_CMD to a command template, for example:\n'
      + '  ANYDB_KEYCHAIN_CMD=op read op://{service}/{account}\n'
      + '  ANYDB_KEYCHAIN_CMD=security find-generic-password -s {service} -a {account} -w\n'
      + '{service} and {account} are substituted, the command is run with execFile (no shell), '
      + `and it is stopped after ${ref.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS}ms. `
      + 'Embedding the command in the config is deliberately not supported, so a writable db.json cannot choose what this server executes.'
    );
  }

  const argv = keychainArgv(template, service, account);
  if (argv.length === 0) {
    throw new Error(`profile "${profile}": ANYDB_KEYCHAIN_CMD is set but empty.`);
  }
  const timeoutMs = ref.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS;
  let stdout;
  try {
    stdout = await runCommand(execFileFn, argv[0], argv.slice(1), timeoutMs);
  } catch (error) {
    throw new Error(`profile "${profile}": the keychain command [${argv.join(' ')}] did not produce a secret: `
      + `${describeExecFailure(error, timeoutMs)}.`);
  }
  return trimTrailingNewline(String(stdout));
}

/**
 * Work out which config file to read: `ANYDB_CONFIG`, then `resolveAnyDbPaths(...)`'s
 * `configFile`, then its `xdgConfigFile`. First *existing* one wins: an absent default that
 * shadows a real config is worse.
 * @returns {string|null} An absolute path, or null if there is nothing to read
 */
export function resolveConfigFile({ env = process.env, platform = process.platform, homedirFn = nodeOs.homedir, fs = nodeFs } = {}) {
  const explicit = env.ANYDB_CONFIG;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const file = pathImpl(platform).resolve(explicit.trim());
    if (!fs.existsSync(file)) {
      // Not fatal: a server with no profiles still serves anyone passing ad-hoc URIs.
      console.error(`[anydb] ANYDB_CONFIG points at ${file}, which does not exist; no profiles will be loaded`);
    }
    return file;
  }

  let paths;
  try {
    paths = resolveAnyDbPaths(env, platform, homedirFn);
  } catch {
    return null;
  }
  for (const candidate of [paths && paths.configFile, paths && paths.xdgConfigFile]) {
    if (typeof candidate === 'string' && candidate !== '' && fs.existsSync(candidate)) return candidate;
  }
  return (paths && paths.configFile) || null;
}

/**
 * A validated set of named connections.
 *
 * Every dependency that touches the machine is a constructor option, so a test can point
 * all of them at a temporary directory.
 */
export class ProfileStore {
  /**
   * @param {object} [options]
   * @param {object} [options.env] - Defaults to `process.env`
   * @param {string} [options.platform] - Defaults to `process.platform`
   * @param {Function} [options.homedirFn] - Defaults to `os.homedir`
   * @param {object} [options.fs] - `node:fs`; injected by tests
   * @param {Function} [options.log] - Injected logger, called as `log(message, detail)`
   * @param {Function} [options.keychainProvider] - `(service, account) => Promise<string>`
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.homedirFn = options.homedirFn ?? nodeOs.homedir;
    this.fs = options.fs ?? nodeFs;
    this.log = options.log ?? (() => {});
    this.keychainProvider = options.keychainProvider ?? null;

    this._source = null;
    this._entries = new Map();
    this._defaultName = null;
    this._loaded = false;
  }

  /** Absolute path of the file that was loaded, or null when there was none. */
  get source() {
    return this._source;
  }

  /** Validated entries, with credentials still unresolved. Map order is file order. */
  get profiles() {
    return this._entries;
  }

  /** Profile names, in file order. */
  get names() {
    return [...this._entries.keys()];
  }

  /** The `default` profile, if the file names one that exists. */
  get defaultName() {
    return this._defaultName;
  }

  /** Whether a profile of that name exists. Loads on first use. */
  has(name) {
    this.load();
    return this._entries.has(name);
  }

  /**
   * Read and validate the config file. Idempotent, and safe when there is no config file:
   * `profiles` is empty, `source` stays null, nothing throws. A missing config is not an
   * error condition, and a tool that refuses to start over an optional file is one people
   * disable.
   * @returns {this}
   */
  load() {
    if (this._loaded) return this;
    this._loaded = true;

    const file = this.resolveConfigFile();
    if (!file || !this.fs.existsSync(file)) {
      this._source = null;
      this._entries = new Map();
      this._defaultName = null;
      return this;
    }

    let text;
    try {
      text = this.fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`Could not read the anydb config at ${file}: ${error.code || error.message}`);
    }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(`${file}: not valid JSON (${error.message}). `
        + 'Fix the file, or point ANYDB_CONFIG at a different one. A comma or a trailing comma is the usual cause.');
    }

    const document = this.#validateDocument(raw, file);
    this._entries = document.entries;
    this._defaultName = document.defaultName;
    this._source = file;
    return this;
  }

  /** Force a re-read. Used after the file has been rewritten, or by a watcher. */
  reload() {
    this._loaded = false;
    return this.load();
  }

  /**
   * Where the config would be read from, whether or not it exists.
   * @returns {string|null}
   */
  resolveConfigFile() {
    const explicit = this.env.ANYDB_CONFIG;
    if (typeof explicit === 'string' && explicit.trim() !== '') {
      return pathImpl(this.platform).resolve(explicit.trim());
    }
    let paths;
    try {
      paths = resolveAnyDbPaths(this.env, this.platform, this.homedirFn);
    } catch {
      return null;
    }
    for (const candidate of [paths && paths.configFile, paths && paths.xdgConfigFile]) {
      if (typeof candidate === 'string' && candidate !== '' && this.fs.existsSync(candidate)) return candidate;
    }
    return (paths && paths.configFile) || null;
  }

  /**
   * A validated entry. The error lists the names that do exist, because the caller's actual
   * mistake is almost always a name close to a real one — `prod` for `prod-ro`.
   * @param {string} name
   */
  getEntry(name) {
    this.load();
    const entry = this._entries.get(name);
    if (entry) return entry;

    const known = this.names;
    const where = this._source
      ? `No profile named "${name}" in ${this._source}.`
      : `No profile named "${name}", and no anydb config file was found.`;
    if (known.length === 0) {
      throw new Error(
        `${where} Create ${describeDefaultConfigPath(this.env, this.platform, this.homedirFn)} with something like `
        + '{"profiles":{"local":{"driver":"sqlite","path":"./app.db"}}} and restart the server.'
      );
    }
    throw new Error(`${where} Available profiles: ${known.join(', ')}.`);
  }

  /**
   * The profiles, as the model sees them.
   *
   * The one shape that goes into a context window. It carries a name, a description, a driver,
   * whether it is the default, and whether it is read-only. It does not carry a URI, a
   * username, a password, a resolved credential, a host, or a path — not masked, not hashed,
   * absent, because a masked connection string still discloses the host.
   *
   * @returns {Array<{ name: string, description: string, driver: string|null, default: boolean, readOnly: boolean }>}
   */
  list() {
    this.load();
    const rows = [...this._entries.values()].map((entry) => ({
      name: entry.name,
      description: entry.description ?? '',
      driver: entry.driver ?? null,
      default: entry.name === this._defaultName,
      readOnly: entry.readOnly !== false,
    }));
    // Default first, then alphabetical: deterministic, and the unqualified default comes first.
    rows.sort((a, b) => {
      if (a.default !== b.default) return a.default ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return rows;
  }

  /**
   * The connection string for an entry, with no credential in it: safe to log, show to a
   * model and put in a cache key. `?ssl=true` and `?replicaSet=` are load-bearing.
   * @param {object|string} entry - A validated entry, or a profile name
   */
  toUri(entry) {
    const target = typeof entry === 'string' ? this.getEntry(entry) : entry;
    if (!target) throw new Error('toUri needs a profile entry or a profile name.');

    if (!target.uri) {
      // Three slashes, and the same before a drive letter: what `sqlite.js` expects.
      const value = this.platform === 'win32' ? target.path.replace(/\\/g, '/') : target.path;
      return `sqlite://${value.startsWith('/') ? value : `/${value}`}`;
    }

    return stripCredentialFromUri(target.uri).uri;
  }

  /**
   * A fully-formed connection for a profile, with the credential materialised.
   *
   * Async because credential sources are: an environment read is synchronous, a file, a
   * command and a keychain are not. The returned URI is the only place the secret appears, and
   * `registry.js` keys the connection cache on it deliberately, so a rotated credential gets
   * a new connection rather than one authenticated with the old.
   * @param {string} name
   * @param {object} [resolverDeps] - Overrides for `{ env, fs, log, keychainProvider, execFile }`
   */
  async resolve(name, resolverDeps = {}) {
    const entry = this.getEntry(name);
    const deps = {
      env: resolverDeps.env ?? this.env,
      fs: resolverDeps.fs ?? this.fs,
      log: resolverDeps.log ?? this.log,
      keychainProvider: resolverDeps.keychainProvider ?? this.keychainProvider,
      execFile: resolverDeps.execFile ?? nodeExecFile,
      platform: resolverDeps.platform ?? this.platform,
      profile: entry.name,
    };

    let uri;
    let password = null;

    if (entry.uri) {
      const stripped = stripCredentialFromUri(entry.uri);
      uri = stripped.uri;
      if (stripped.password !== null && entry.password === undefined) {
        // A credential in the connection string is the thing profiles exist to avoid.
        warnOnce(deps.log, `inline-password:${entry.name}`, 'a profile keeps its password inside the connection string',
          { profile: entry.name, hint: 'move it to "password": {"env":"NAME"} so the file stops being a credential' });
        password = stripped.password;
      }
    } else {
      uri = this.toUri(entry);
    }

    if (entry.password !== undefined) {
      // An explicit `password` field wins: it is the one a reference can be written into.
      password = await resolveCredential(entry.password, deps);
    }

    if (password) uri = injectCredentials(uri, password, entry.username);

    return {
      uri,
      // The merged policy, from `./policy.js`: the single place the precedence is reconciled.
      policy: evaluatePolicy(entry, { env: deps.env }),
      options: entry.options ?? {},
      name: entry.name,
    };
  }

  /**
   * Parse and validate the whole document.
   * @returns {{ entries: Map<string, object>, defaultName: string|null }}
   */
  #validateDocument(raw, file) {
    if (!isPlainObject(raw)) {
      throw configError(file, '(root)', `must be an object, got ${Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw}`);
    }
    if (!isPlainObject(raw.profiles)) {
      throw configError(file, 'profiles', 'is required and must be an object of named connections, for example '
        + '{"profiles":{"local":{"driver":"sqlite","path":"./app.db"}}}');
    }

    const names = Object.keys(raw.profiles);
    if (names.length > MAX_PROFILES) {
      warnOnce(this.log, `too-many-profiles:${file}`, 'the config declares more profiles than this version will list',
        { found: names.length, kept: MAX_PROFILES });
    }

    const impl = pathImpl(this.platform);
    const configDir = impl.dirname(file);
    const entries = new Map();

    for (const name of names.slice(0, MAX_PROFILES)) {
      if (name.trim() === '') {
        throw configError(file, 'profiles', 'has a profile with an empty name');
      }
      if (FORBIDDEN_NAMES.has(name)) {
        throw configError(file, `profiles.${name}`, 'is a reserved name and cannot be used as a profile name');
      }
      entries.set(name, validateProfileEntry(file, name, raw.profiles[name], { configDir, platform: this.platform, log: this.log }));
    }

    let defaultName = null;
    if (raw.default !== undefined) {
      if (typeof raw.default !== 'string') {
        throw configError(file, 'default', `must be a profile name as a string, got ${typeof raw.default}`);
      }
      if (!entries.has(raw.default)) {
        throw configError(file, 'default', `names "${raw.default}", which is not in profiles. Available: ${[...entries.keys()].join(', ') || '(none)'}`);
      }
      defaultName = raw.default;
    }

    for (const key of Object.keys(raw)) {
      if (key !== 'default' && key !== 'profiles' && key !== '$schema') {
        warnOnce(this.log, `unknown-top-level:${file}:${key}`, 'ignoring an unrecognised top-level key', { key });
      }
    }

    return { entries, defaultName };
  }
}

/**
 * Open a config file and validate it.
 *
 * @param {object} [options] - The `ProfileStore` constructor options
 * @returns {ProfileStore} Loaded
 */
export function loadProfileStore(options) {
  return new ProfileStore(options).load();
}

function describeDefaultConfigPath(env, platform, homedirFn) {
  if (typeof env.ANYDB_CONFIG === 'string' && env.ANYDB_CONFIG.trim() !== '') {
    return pathImpl(platform).resolve(env.ANYDB_CONFIG.trim());
  }
  try {
    const paths = resolveAnyDbPaths(env, platform, homedirFn);
    return paths.configFile || '~/.anydb/db.json';
  } catch {
    return '~/.anydb/db.json';
  }
}

const isDirectory = (fsImpl, target) => {
  try {
    return fsImpl.statSync(target).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Write a config file.
 *
 * Three properties, all about what happens on a bad day. The file is 0600 and its directory
 * 0700, set explicitly rather than left to the umask. The write is atomic - a temporary file
 * beside it, then a rename - so a reader sees the old file or the new one, never a
 * half-written config that fails to parse at the next startup. And the contents are never
 * logged, and the temporary file is removed if the write fails.
 * @param {string} target - A file path, or a directory to write `db.json` into
 * @param {object} value - The document to write
 * @param {object} [options] - `{ env, platform, homedirFn, fs }`
 * @returns {Promise<string>} The absolute path written
 */
export async function writeProfileStore(target, value, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedirFn = options.homedirFn ?? nodeOs.homedir;
  const fsImpl = options.fs ?? nodeFs;
  const impl = pathImpl(platform);

  const asPath = String(target);
  const asDirectory = /[\\/]$/.test(asPath) || isDirectory(fsImpl, asPath);
  const file = asDirectory ? impl.join(asPath, CONFIG_BASENAME) : impl.resolve(asPath);
  const dir = impl.dirname(file);

  // `ensureDir` owns directory creation. A failure here is a failure to write the config.
  try {
    ensureDir(dir, DIR_MODE);
  } catch (error) {
    throw new Error(`Could not create the anydb config directory ${dir}: ${error.code || error.message}`);
  }
  // Belt and braces: `ensureDir`'s `mode` is filtered by the umask, so a 022 umask leaves 0755.
  fsImpl.mkdirSync(dir, { recursive: true, mode: DIR_MODE });

  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.tmp`;

  let handle;
  try {
    handle = fsImpl.openSync(temporary, 'w', FILE_MODE);
    fsImpl.writeFileSync(handle, text, { encoding: 'utf8' });
    // Flushed before the rename, so a crash cannot leave a renamed-but-empty file.
    if (typeof fsImpl.fsyncSync === 'function') {
      try { fsImpl.fsyncSync(handle); } catch { /* not supported here */ }
    }
  } catch (error) {
    // A half-written temporary file is worse than none: a credential store in a listable directory.
    try { fsImpl.unlinkSync(temporary); } catch { /* nothing to clean up */ }
    throw new Error(`Could not write the anydb config to ${file}: ${error.code || error.message}`);
  } finally {
    if (handle !== undefined) {
      try { fsImpl.closeSync(handle); } catch { /* already closed */ }
    }
  }

  try {
    // The umask is applied at creation, so 0600 can arrive as 0644; setting it again is
    // the only way to be sure. On win32 chmod only touches the read-only bit.
    fsImpl.chmodSync(temporary, FILE_MODE);
  } catch {
    // A filesystem with no permission bits. Nothing to enforce here.
  }

  try {
    fsImpl.renameSync(temporary, file);
  } catch (error) {
    try { fsImpl.unlinkSync(temporary); } catch { /* nothing to clean up */ }
    throw new Error(`Could not replace the anydb config at ${file}: ${error.code || error.message}`);
  }

  return file;
}

/**
 * Add or replace one profile, keeping everything else in the file.
 *
 * The entry is validated first, with the file it is about to be written to named in the
 * error, so `exportProfile` cannot leave behind a document `load()` would refuse. The two
 * directions agree: what it writes is what a `ProfileStore` reads back.
 * @param {string} name - Profile name
 * @param {object} entry - The entry, in `db.json` shape
 * @param {object} [options] - `{ file, env, platform, homedirFn, fs, log, makeDefault }`
 */
export async function exportProfile(name, entry, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedirFn = options.homedirFn ?? nodeOs.homedir;
  const fsImpl = options.fs ?? nodeFs;
  const impl = pathImpl(platform);

  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('exportProfile needs a non-empty profile name.');
  }
  if (FORBIDDEN_NAMES.has(name)) {
    throw new Error(`"${name}" is a reserved name and cannot be used as a profile name.`);
  }

  const store = options.store ?? new ProfileStore({ env, platform, homedirFn, fs: fsImpl, log: options.log });
  const file = options.file ?? store.resolveConfigFile() ?? impl.join(homedirFn(), '.anydb', CONFIG_BASENAME);

  let document = {};
  if (fsImpl.existsSync(file)) {
    let text;
    try {
      text = fsImpl.readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`Could not read the existing anydb config at ${file}: ${error.code || error.message}`);
    }
    if (text.trim() !== '') {
      try {
        document = JSON.parse(text);
      } catch (error) {
        throw new Error(`${file}: not valid JSON (${error.message}), so the profile was not written. Fix the file first.`);
      }
    }
  }
  if (!isPlainObject(document)) document = {};
  if (!isPlainObject(document.profiles)) document.profiles = {};

  validateProfileEntry(file, name, entry, {
    configDir: impl.dirname(impl.resolve(file)),
    platform,
    log: options.log,
  });

  document.profiles = { ...document.profiles, [name]: entry };
  if (options.makeDefault === true) {
    document.default = name;
  } else if (document.default === undefined) {
    // The first profile written becomes the default; a later call leaves a choice alone.
    document.default = name;
  }  const written = await writeProfileStore(file, document, { env, platform, homedirFn, fs: fsImpl });
  return { file: written, document };
}
