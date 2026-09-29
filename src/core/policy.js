/**
 * Connection policy: SSRF gating, SQLite path gating, and a second gate for
 * destructive statements.
 *
 * `db_query` takes a `uri` on every call, so whoever influences the model's output
 * chooses where this server sends packets and which local files it opens. Both are
 * default-deny: `postgres://…@169.254.169.254/…` is a cloud-metadata reader and
 * `sqlite:///etc/shadow` is a `SELECT` against a file the server can read. An
 * allowlist can only be wrong in the safe direction.
 *
 * RESOLVE, THEN VALIDATE
 * The address that actually gets connected to is the one that gets checked. A name
 * is resolved once with `dns.lookup(host, { all: true, verbatim: true })` and *every*
 * address returned is validated, because validating the supplied string by hand
 * misses the octal, hex, short-form and IPv4-mapped spellings that all mean 127.0.0.1.
 * A name that cannot be resolved is refused. None of this is a sandbox: a caller who
 * can edit `db.json` or set the environment owns the process.
 */

import * as nodeDns from 'node:dns/promises';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { baseProtocol, stripSqlNoise, findWriteStage, MONGO_WRITE_ACTIONS } from './safety.js';

/**
 * One numeric component of an IPv4 address. A leading zero is octal and a `0x`
 * prefix is hex, because that is what `inet_aton` does.
 * @returns {number|null} The value, or null if it is not a number at all
 */
function parseNumericPart(text) {
  if (text === '') return null;

  let radix = 10;
  let digits = text;
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
    radix = 16;
    digits = text.slice(2);
  } else if (text.length > 1 && text[0] === '0') {
    radix = 8;
    digits = text.slice(1);
  }

  if (digits === '') return null;
  if (radix === 10 && !/^[0-9]+$/.test(digits)) return null;
  if (radix === 8 && !/^[0-7]+$/.test(digits)) return null;

  const value = Number.parseInt(digits, radix);
  return Number.isFinite(value) ? value : null;
}

/**
 * An IPv4 address, including the shorthand forms `inet_aton` accepts. A non-final
 * component must fit in one byte; the last one fills every remaining byte, so
 * `127.1` is 127.0.0.1 and `127` is 0.0.0.127.
 * @returns {Uint8Array|null} Four bytes, or null
 */
function parseIpv4(text) {
  if (text.includes(':')) return null;

  const parts = text.split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  const values = [];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const limit = isLast ? 256 ** (5 - parts.length) : 256;
    const value = parseNumericPart(parts[i]);
    if (value === null || value < 0 || value >= limit) return null;
    values.push(value);
  }

  const bytes = new Uint8Array(4);
  for (let i = 0; i < values.length - 1; i++) bytes[i] = values[i];

  const last = values[values.length - 1];
  const tailBytes = 5 - parts.length;
  for (let i = 0; i < tailBytes; i++) {
    bytes[3 - i] = (last >>> (8 * i)) & 0xff;
  }
  return bytes;
}

/**
 * An IPv6 address, including the `::ffff:127.0.0.1` mapped form and a `%zone`
 * suffix. `::` is expanded by counting groups; anything that does not add up to
 * exactly eight is rejected.
 * @returns {Uint8Array|null} Sixteen bytes, or null
 */
function parseIpv6(text) {
  let s = text;

  // A zone id is a scope label, not part of the address, and an empty one is refused.
  const percent = s.indexOf('%');
  if (percent !== -1) {
    const zone = s.slice(percent + 1);
    if (zone === '' || zone.includes('%')) return null;
    s = s.slice(0, percent);
  }
  if (s === '' || !s.includes(':')) return null;

  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const split = (part) => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]);
  const tailGroups = halves.length === 2 ? split(halves[1]) : [];

  // More than eight groups cannot be fixed by the `::` expansion.
  const missing = 8 - head.length - tailGroups.length;
  if (halves.length === 2 && missing < 0) return null;

  const groups = halves.length === 2
    ? [...head, ...new Array(missing).fill('0'), ...tailGroups]
    : head;
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    // Padded before the split: `1` is 0x0001, not 0x0100.
    const value = group.padStart(4, '0');
    bytes[i * 2] = Number.parseInt(value.slice(0, 2), 16);
    bytes[i * 2 + 1] = Number.parseInt(value.slice(2), 16);
  }
  return bytes;
}

/**
 * Parse a textual address into bytes.
 * @returns {{ version: 4|6, bytes: Uint8Array }|null}
 */
export function parseIp(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (s === '') return null;
  if (s.includes(':')) {
    const bytes = parseIpv6(s);
    return bytes ? { version: 6, bytes } : null;
  }
  const bytes = parseIpv4(s);
  return bytes ? { version: 4, bytes } : null;
}

const CANONICAL_IPV4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

const isCanonicalIpv4 = (text) => CANONICAL_IPV4.test(text) && parseIpv4(text) !== null;

/**
 * Whether a host string is an address literal every parser reads the same way.
 *
 * `parseIp` above is deliberately permissive: the right rule for refusing and the
 * wrong rule for allowing, since `010.0.0.1` is 8.0.0.1 here and 10.0.0.1 to a
 * parser reading a leading zero as decimal. Only a canonical dotted quad skips the
 * resolver. Every IPv6 spelling is unambiguous, except for an ambiguous IPv4 tail.
 */
export function isAddressLiteral(text) {
  const parsed = parseIp(text);
  if (!parsed) return false;
  if (parsed.version === 6) {
    if (!text.includes('.')) return true;
    return isCanonicalIpv4(text.slice(text.lastIndexOf(':') + 1));
  }
  return isCanonicalIpv4(text);
}

const unbracket = (host) =>
  (typeof host === 'string' && host.startsWith('[') && host.endsWith(']')) ? host.slice(1, -1) : host;

/**
 * Re-express a four-byte address as its IPv4-mapped IPv6 form, so both sides of a
 * comparison live in one family. `base` is carried through so `prefix` survives.
 */
const asMappedV6 = (base, v4) => {
  const bytes = new Uint8Array(16);
  bytes[10] = 0xff;
  bytes[11] = 0xff;
  bytes.set(v4, 12);
  return { ...base, version: 6, bytes };
};

const asV4 = (base) => ({ ...base, version: 4, bytes: base.bytes.slice(12) });

const first12Zero = (bytes) => {
  for (let i = 0; i < 12; i++) if (bytes[i] !== 0) return false;
  return true;
};

const zeroPrefix = (bytes, n) => {
  for (let i = 0; i < n; i++) if (bytes[i] !== 0) return false;
  return true;
};

/**
 * The IPv4 address an IPv6 address carries: the mapped form `::ffff:a.b.c.d`, the
 * deprecated compatible form `::a.b.c.d`, or the NAT64 prefix `64:ff9b::a.b.c.d`.
 * @returns {Uint8Array|null} Four bytes, or null
 */
export function embeddedIpv4(bytes) {
  if (!bytes || bytes.length !== 16) return null;
  const mapped = zeroPrefix(bytes, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = first12Zero(bytes);
  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
    && zeroPrefix(bytes.subarray(4, 12), 8);
  if (!mapped && !compatible && !nat64) return null;
  return bytes.slice(12);
}

/**
 * IPv4 ranges refused by default. The ones that matter are RFC 1918, loopback, and
 * the RFC 3927 link-local block whose `169.254.169.254` member is the cloud
 * metadata endpoint. `ANYDB_ALLOW_PRIVATE_HOSTS=1` lifts all of it.
 */
export const BLOCKED_IPV4_RANGES = Object.freeze([
  '0.0.0.0/8', // "this network", and the wildcard bind address
  '10.0.0.0/8', // RFC 1918
  '100.64.0.0/10', // RFC 6598 carrier-grade NAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // RFC 3927 link-local, cloud metadata
  '172.16.0.0/12', // RFC 1918
  '192.0.0.0/24', // RFC 6890 IETF protocol assignments
  '192.168.0.0/16', // RFC 1918
  '198.18.0.0/15', // RFC 2544 benchmarking
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, and 255.255.255.255
]);

/** IPv6 ranges refused by default. `::1`, `fc00::/7` and `fe80::/10` are required; multicast is here for the same reason as IPv4. */
export const BLOCKED_IPV6_RANGES = Object.freeze([
  '::/128', // unspecified
  '::1/128', // loopback
  'fc00::/7', // RFC 4193 unique local
  'fe80::/10', // link-local
  'ff00::/8', // multicast
]);

function compileCidr(cidr) {
  const slash = cidr.indexOf('/');
  const base = slash === -1 ? cidr : cidr.slice(0, slash);
  const parsed = parseIp(base);
  if (!parsed) return null;

  const bits = parsed.version === 4 ? 32 : 128;
  let prefix = bits;
  if (slash !== -1) {
    const text = cidr.slice(slash + 1);
    if (!/^\d{1,3}$/.test(text)) return null;
    prefix = Number(text);
    if (prefix > bits) return null;
  }
  return { version: parsed.version, bytes: parsed.bytes, prefix };
}

const COMPILED_IPV4 = BLOCKED_IPV4_RANGES.map(compileCidr).filter(Boolean);
const COMPILED_IPV6 = BLOCKED_IPV6_RANGES.map(compileCidr).filter(Boolean);

const isMatched = (address, compiled) => {
  let left = address;
  let right = compiled;
  // Across families: lift v4 into ::ffff:0:0/96 and a compatible v6 down to four bytes.
  if (left.version !== right.version) {
    if (left.version === 6 && first12Zero(left.bytes)) left = asV4(left);
    if (left.version === 4) left = asMappedV6(left, left.bytes);
    if (right.version === 4) right = asMappedV6(right, right.bytes);
  }

  // One byte at a time, because a prefix can end in the middle of one. Stepping
  // by 8 here — bits, not bytes — quietly matches every /128.
  for (let i = 0; i < right.bytes.length; i++) {
    const take = Math.max(0, Math.min(8, right.prefix - i * 8));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if ((left.bytes[i] & mask) !== (right.bytes[i] & mask)) return false;
  }
  return true;
};

/**
 * Whether an address is inside a CIDR block. Exported because address maths reads
 * as correct and is not: a `/0` has to match everything and a `/32` has to match
 * one address. A bare address is an exact match.
 */
export function ipInCidr(ip, cidr) {
  const address = parseIp(ip);
  const compiled = compileCidr(cidr);
  if (!address || !compiled) return false;
  return isMatched(address, compiled);
}

/**
 * Whether an address is private, loopback, link-local or otherwise not routable on
 * the public internet. An address that does not parse is reported as *not* private:
 * it goes to DNS and is re-checked.
 */
export function isPrivateAddress(ip) {
  const parsed = parseIp(ip);
  if (!parsed) return false;

  if (parsed.version === 4) {
    return COMPILED_IPV4.some((cidr) => isMatched(parsed, cidr));
  }

  // An IPv6 address that wraps an IPv4 one is judged by that address.
  const inner = embeddedIpv4(parsed.bytes);
  if (inner) return COMPILED_IPV4.some((cidr) => isMatched({ version: 4, bytes: inner }, cidr));

  return COMPILED_IPV6.some((cidr) => isMatched(parsed, cidr));
}

/**
 * Schemes accepted unless `ANYDB_ALLOWED_SCHEMES` says otherwise. The SQLAlchemy aliases are
 * here because they are real spellings that `registry.js` routes.
 *
 * Adding a scheme means adding it in three places: this list, `ROUTES` in
 * `./registry.js` (or the connection is unroutable) and `SCHEME_ALIASES` in
 * `./profiles.js` (or a profile naming it will not validate).
 */
export const DEFAULT_ALLOWED_SCHEMES = Object.freeze([
  'postgres', 'postgresql',
  'mysql', 'mariadb',
  'sqlite', 'sqlite+pysqlite',
  'mongodb', 'mongodb+srv',
  'redis', 'rediss', 'redis-cluster', 'redis-sentinel',
  'mysql+pymysql', 'mysql+mysqldb', 'mysql+asyncmy', 'mysql+aiohttp', 'mysql+aiomysql', 'mysql+cymysql',
  'mariadb+pymysql', 'mariadb+mariadbconnector',
]);

/**
 * A family label for the SQL dialect a scheme names, or null for one this file does not know.
 * `baseProtocol` in `./safety.js` owns the only alias table in the codebase; this only
 * labels the result. An unlisted scheme stays unknown rather than matching a prefix, because
 * the registry's schema and table gates begin with `isSqlProtocol`.
 * @returns {string|null} `postgres`, `mysql`, `sqlite`, or null
 */
const DIALECT_FAMILY = Object.freeze({
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  // MariaDB is a different server, but its grammar is a superset of MySQL's.
  mariadb: 'mysql',
  sqlite: 'sqlite',
});

export function sqlDialect(scheme) {
  return DIALECT_FAMILY[baseProtocol(String(scheme || '').toLowerCase())] ?? null;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;
const isSqliteScheme = (scheme) => scheme === 'sqlite' || scheme.startsWith('sqlite+');

/**
 * Split a connection string into the parts a policy check needs. Deliberately permissive:
 * never throws, never discards a part it might need, because the drivers do the real parsing
 * and disagree. @returns the parts, or null unless the string is `scheme://…`.
 */
export function parseConnectionUri(uri) {
  if (typeof uri !== 'string') return null;
  const marker = uri.indexOf('://');
  if (marker === -1) return null;

  const scheme = uri.slice(0, marker).toLowerCase();
  if (!SCHEME_RE.test(scheme)) return null;

  let rest = uri.slice(marker + 3);

  let fragment = '';
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }

  let query = '';
  const question = rest.indexOf('?');
  if (question !== -1) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }

  // A SQLite URI is a file path, not a network address: its authority is empty.
  if (isSqliteScheme(scheme)) {
    return {
      scheme,
      host: '',
      port: '',
      userinfo: '',
      user: '',
      password: null,
      path: rest,
      query,
      fragment,
      // Same transform as `sqlite.js`, so the path checked is the path opened.
      filePath: rest.replace(/^\/([A-Za-z]:)/, '$1'),
    };
  }

  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);

  // The *last* `@` separates userinfo: a password may contain an unescaped `@`.
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? '' : authority.slice(0, at);
  const hostport = at === -1 ? authority : authority.slice(at + 1);

  let host = hostport;
  let port = '';
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    if (close === -1) return null;
    host = hostport.slice(0, close + 1);
    const tail = hostport.slice(close + 1);
    if (tail.startsWith(':')) port = tail.slice(1);
    else if (tail !== '') return null;
  } else {
    const colon = hostport.lastIndexOf(':');
    if (colon !== -1) {
      host = hostport.slice(0, colon);
      port = hostport.slice(colon + 1);
    }
  }

  const colon = userinfo.indexOf(':');
  return {
    scheme,
    host,
    port,
    userinfo,
    user: colon === -1 ? userinfo : userinfo.slice(0, colon),
    password: colon === -1 ? null : userinfo.slice(colon + 1),
    path,
    query,
    fragment,
    filePath: '',
  };
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

/**
 * Read a boolean out of the environment. An unrecognised value falls back to the
 * documented default: a typo in a hardening switch must not read as a decision.
 */
export function parseBoolEnv(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === '') return fallback;
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return fallback;
}

/** Split a comma-separated environment list, dropping blanks. */
function parseListEnv(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(',').map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * Whether a caller may pass a raw `uri` instead of naming a profile.
 *
 * Defaults to on: 2.x only had raw URIs, and turning it off in a patch release would break every
 * existing configuration. `ANYDB_ALLOW_ADHOC_URI=0` is the whole switch; after that every
 * statement has to name something an operator wrote.
 */
export function isAdHocUriAllowed(env = process.env) {
  return parseBoolEnv(env.ANYDB_ALLOW_ADHOC_URI, true);
}

export function allowedSchemes(env = process.env) {
  const override = parseListEnv(env.ANYDB_ALLOWED_SCHEMES);
  return new Set(override.length > 0 ? override : DEFAULT_ALLOWED_SCHEMES);
}

const normaliseHost = (host) => String(host).toLowerCase().replace(/\.$/, '');

/**
 * Match a host against an allowlist. Two wildcards, and only two: `*` on its own means
 * every host, and a leading `*.` matches subdomains but not the bare domain, so
 * `*.example.com` permits `db.example.com` and not `example.com`.
 */
export function hostMatchesAllowlist(host, list) {
  const target = normaliseHost(unbracket(host));
  return list.some((raw) => {
    const entry = normaliseHost(raw);
    if (entry === '*') return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      return target.endsWith(suffix) && target.length > suffix.length;
    }
    return target === entry;
  });
}

export const CREDENTIAL_QUERY_PARAMS = Object.freeze([
  'password', 'passwd', 'pwd', 'pass',
  'auth', 'token', 'secret', 'apikey', 'api_key', 'access_token',
  'sslpassword', 'ssl_password', 'sslcert', 'sslkey',
]);

/**
 * Whether an absolute path sits inside a directory. Matched on a path-segment boundary,
 * never on a string prefix: allowlisting `C:\Users\me\db` and then matching
 * `C:\Users\me\db2` hands the caller a sibling directory, where a private key lives.
 */
export function isPathWithin(candidate, root, platform = process.platform) {
  const impl = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const left = impl.normalize(impl.resolve(candidate));
  const right = impl.normalize(impl.resolve(root));
  if (left === right) return true;

  const a = platform === 'win32' ? left.toLowerCase() : left;
  const b = platform === 'win32' ? right.toLowerCase() : right;
  const prefix = b.endsWith(impl.sep) ? b : b + impl.sep;
  return a.startsWith(prefix);
}

/**
 * The real location of a path, or null when the filesystem will not say.
 *
 * Containment is a textual test and text cannot see a symbolic link, so an allowlisted
 * `/srv/db` holding a link to `/etc` would otherwise admit `/srv/db/shadow`. The deepest
 * existing ancestor is used, so a path that does not exist yet is still checked.
 */
function realpathNearestExisting(target, platform) {
  const impl = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  let current = target;
  const tail = [];
  for (;;) {
    try {
      const real = nodeFs.realpathSync(current);
      return tail.length === 0 ? real : impl.join(real, ...tail.reverse());
    } catch (error) {
      // ENOENT and ENOTDIR are ordinary on the way up a tree; anything else means
      // "cannot be checked", so the caller refuses.
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        const parent = impl.dirname(current);
        if (parent === current) return null;
        tail.push(impl.basename(current));
        current = parent;
        continue;
      }
      return null;
    }
  }
}

// One warning per reason per process. Reset between tests.
const warned = new Set();
const warnOnce = (log, key, message, detail = {}) => {
  if (warned.has(key)) return;
  warned.add(key);
  if (typeof log === 'function') log(message, detail);
};

/** Forget which warnings have already been emitted. Exported for tests. */
export function resetPolicyWarnings() {
  warned.clear();
}

/**
 * Gate a SQLite file path.
 *
 * `sqlite://` turns a query tool into a reader for any file the process can open, and a
 * `SELECT` is all it takes, so a path has to be named in advance by the profile or the
 * environment. The default is to allow, a compatibility compromise; the risk is announced
 * once, and `ANYDB_STRICT_SQLITE_PATHS=1` inverts the default.
 */
export function checkSqlitePathPolicy(filePath, { env = process.env, profile = null, log = () => {}, platform = process.platform } = {}) {
  const impl = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const raw = typeof filePath === 'string' ? filePath : '';

  // An in-memory database touches no file. Checked before normalisation.
  if (raw === '' || raw === ':memory:' || /^file::memory:/.test(raw)) {
    return { allowed: true, reason: '', path: raw, matched: null };
  }

  const target = impl.normalize(raw);

  if (!impl.isAbsolute(target)) {
    return {
      allowed: false,
      reason: `"${filePath}" is not an absolute path. A relative SQLite path depends on the ` +
        "server's working directory, which is not something a caller should be able to steer. " +
        'Use an absolute path, or a "path" field in a profile, which is resolved against the ' +
        'directory holding db.json.',
      path: target,
      matched: null,
    };
  }

  const roots = [];
  if (profile && Array.isArray(profile.allowedPaths)) {
    for (const root of profile.allowedPaths) {
      roots.push({ value: root, source: `profile "${profile.name}" allowedPaths` });
    }
  }
  for (const root of parseListEnv(env.ANYDB_ALLOWED_SQLITE_PATHS)) {
    roots.push({ value: root, source: 'ANYDB_ALLOWED_SQLITE_PATHS' });
  }

  if (roots.length === 0) {
    if (parseBoolEnv(env.ANYDB_STRICT_SQLITE_PATHS, false)) {
      return {
        allowed: false,
        reason: `"${target}" is not in a SQLite path allowlist and ANYDB_STRICT_SQLITE_PATHS=1 is set, ` +
          'so every file must be named in advance. Add the directory to ANYDB_ALLOWED_SQLITE_PATHS, or ' +
          'add "allowedPaths" to the profile that owns this database. Unset the variable to accept any path.',
        path: target,
        matched: null,
      };
    }
    warnOnce(
      log,
      'sqlite-path-unrestricted',
      'SQLite paths are not restricted, so any file this process can open can be read ' +
        'through sqlite://, including SSH keys and cloud credentials. Set ANYDB_STRICT_SQLITE_PATHS=1 ' +
        'to require an allowlist, or ANYDB_ALLOWED_SQLITE_PATHS to name the directories in use.',
      { risk: 'local file disclosure', escapeHatch: 'ANYDB_STRICT_SQLITE_PATHS=0' }
    );
    return { allowed: true, reason: '', path: target, matched: null };
  }

  for (const root of roots) {
    if (!isPathWithin(target, root.value, platform)) continue;

    // Textual containment passed. A symlink *inside* the allowlisted directory is still
    // textually inside it, so both sides are resolved through their nearest existing
    // ancestor: a symlinked allowlist prefix still matches, a link out of the tree does not.
    const realTarget = realpathNearestExisting(target, platform);
    const realRoot = realpathNearestExisting(root.value, platform);
    if (realTarget !== null && realRoot !== null && isPathWithin(realTarget, realRoot, platform)) {
      return { allowed: true, reason: '', path: target, matched: root.value };
    }

    warnOnce(
      log,
      'sqlite-path-symlink',
      'A SQLite path matched an allowlist entry as text but not on the filesystem, which means a ' +
        'symbolic link inside the allowlisted directory points outside it. The path was refused.',
      { risk: 'local file disclosure', path: target, matched: root.value }
    );
    return {
      allowed: false,
      reason: `"${target}" is inside "${root.value}" as text but not on the filesystem: a symbolic ` +
        'link in that directory leads somewhere else, or the path could not be resolved at all. ' +
        'Name the directory the file really lives in, and remove the link.',
      path: target,
      matched: null,
    };
  }

  const listed = roots.map((root) => `${root.value} (${root.source})`).join(', ');
  return {
    allowed: false,
    reason: `"${target}" is outside every allowed SQLite path: ${listed}. A path matches only when it ` +
      'is the directory itself or sits inside it on a path-segment boundary, so "C:/data/app2.db" does ' +
      'not match "C:/data/app.db".',
    path: target,
    matched: null,
  };
}

const verdict = (allowed, reason, host, scheme, resolved) => ({ allowed, reason, host, scheme, resolved });

/**
 * Ask the injected resolver for every address a name maps to. `all` so no record can
 * hide behind whichever answer arrived first.
 */
async function resolveAll(dns, host) {
  const impl = dns && typeof dns.lookup === 'function' ? dns : nodeDns;
  const answer = await impl.lookup(host, { all: true, verbatim: true });
  const list = Array.isArray(answer) ? answer : [answer];
  return list
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.address))
    .filter((address) => typeof address === 'string' && address !== '');
}

/**
 * Decide whether a connection string may be opened.
 *
 * @param {string} uri - The connection string the caller wants to use
 * @param {object} [options] - `{ env, profile, dns, log, platform }`
 * @returns {Promise<{ allowed, reason, host, scheme, resolved }>} `resolved` is every address
 *   the host was found to have, and is empty unless a name resolved.
 */
export async function checkConnectionPolicy(uri, { env = process.env, profile = null, dns = nodeDns, log = () => {}, platform = process.platform } = {}) {
  const parsed = parseConnectionUri(uri);
  if (!parsed) {
    return verdict(
      false,
      'The connection string could not be read. Expected scheme://host/… , for example ' +
      'postgres://user@host:5432/db or sqlite:///path/to/app.db.',
      '',
      '',
      []
    );
  }

  const { scheme, host, filePath } = parsed;

  const schemes = allowedSchemes(env);
  if (!schemes.has(scheme)) {
    return verdict(
      false,
      `Scheme "${scheme}" is not allowed. Allowed schemes: ${[...schemes].join(', ')}. ` +
      'This is an allowlist, so anything not named is refused; set ANYDB_ALLOWED_SCHEMES to change it.',
      host,
      scheme,
      []
    );
  }

  if (isSqliteScheme(scheme)) {
    const sqlite = checkSqlitePathPolicy(filePath, { env, profile, log, platform });
    return verdict(sqlite.allowed, sqlite.reason, '', scheme, []);
  }

  const bare = normaliseHost(unbracket(host));
  if (bare === '') {
    return verdict(
      false,
      'The connection string has no host. A host is what gets validated, so a URI without one is refused ' +
      'rather than connected to whatever a driver defaults to.',
      host,
      scheme,
      []
    );
  }

  // Profile first, then the process-wide list. Both must pass; the per-profile list is tighter.
  const profileHosts = profile && Array.isArray(profile.hosts) ? profile.hosts : [];
  if (profileHosts.length > 0 && !hostMatchesAllowlist(bare, profileHosts)) {
    return verdict(
      false,
      `Host "${bare}" is not in the allowed hosts for this profile: ${profileHosts.join(', ')}.`,
      host,
      scheme,
      []
    );
  }

  const globalHosts = parseListEnv(env.ANYDB_ALLOWED_HOSTS);
  if (globalHosts.length > 0 && !hostMatchesAllowlist(bare, globalHosts)) {
    return verdict(
      false,
      `Host "${bare}" is not in ANYDB_ALLOWED_HOSTS: ${globalHosts.join(', ')}.`,
      host,
      scheme,
      []
    );
  }

  if (parseBoolEnv(env.ANYDB_ALLOW_PRIVATE_HOSTS, false)) {
    // Skipping the lookup is the point: the caller has accepted the private ranges.
    return verdict(true, '', host, scheme, []);
  }

  // The private check comes first and covers every spelling, canonical or not, so
  // `0177.0.0.1` and `::ffff:10.0.0.1` are refused without a round trip. Only the
  // *allow* is narrowed to a spelling every parser reads the same way; see
  // isAddressLiteral, and `010.0.0.1`.
  if (parseIp(bare) && isPrivateAddress(bare)) {
    return verdict(
      false,
      `"${bare}" is a private, loopback or link-local address, which is refused by default. ` +
      'A caller that chooses the connection string must not be able to point the server at the ' +
      'internal network or at a cloud metadata endpoint. Set ANYDB_ALLOW_PRIVATE_HOSTS=1 to allow ' +
      'them, which is the normal setting for a database running on localhost.',
      host,
      scheme,
      []
    );
  }
  if (isAddressLiteral(bare)) return verdict(true, '', host, scheme, [bare]);

  let addresses;
  try {
    addresses = await resolveAll(dns, bare);
  } catch (error) {
    const code = error && (error.code || error.errno);
    return verdict(
      false,
      `Host "${bare}" could not be resolved${code ? ` (${code})` : ''}, and an unresolvable host is ` +
        'refused because there is no address to check. If the name is correct, check DNS; if the ' +
        'database is on this machine, use its address and set ANYDB_ALLOW_PRIVATE_HOSTS=1.',
      host,
      scheme,
      []
    );
  }

  if (addresses.length === 0) {
    return verdict(
      false,
      `Host "${bare}" resolved to no addresses, so there is nothing to validate.`,
      host,
      scheme,
      []
    );
  }

  // Every address, not the first: one routable plus one loopback record is a DNS-rebinding bypass.
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return verdict(
        false,
        `Host "${bare}" resolves to ${address}, which is a private, loopback or link-local address. ` +
        `All of its addresses were checked: ${addresses.join(', ')}. Set ANYDB_ALLOW_PRIVATE_HOSTS=1 to allow.`,
        host,
        scheme,
        addresses
      );
    }
  }

  return verdict(true, '', host, scheme, addresses);
}

/** Verbs that change schema or privileges rather than data. */
const DESTRUCTIVE_SQL_VERBS = Object.freeze([
  'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'RENAME', 'GRANT', 'REVOKE',
]);

// Built from the list above so the two cannot drift apart.
const DESTRUCTIVE_SQL_RE = new RegExp(`\\b(?:${DESTRUCTIVE_SQL_VERBS.join('|')})\\b`, 'i');

/** `baseProtocol` collapses `rediss` to `redis` but leaves `mongodb+srv` alone. */
const MONGO_SCHEMES = new Set(['mongodb', 'mongodb+srv']);

/**
 * MongoDB actions that write. Built from `MONGO_WRITE_ACTIONS` in `./safety.js` so
 * the two lists cannot drift.
 */
const DESTRUCTIVE_MONGO_ACTIONS = Object.freeze(new Set([
  ...MONGO_WRITE_ACTIONS, 'drop', 'dropdatabase', 'create', 'createindex',
].map((action) => action.toLowerCase())));

/**
 * Redis commands that destroy data or reconfigure the server.
 *
 * Not about read-only: the guard in `safety.js` already refuses every command outside
 * its read allowlist. This is the second gate, and `CONFIG SET` or `MODULE LOAD`
 * should not sit behind the same switch as `SET k v`.
 */
const DESTRUCTIVE_REDIS_COMMANDS = Object.freeze([
  'FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'DEBUG', 'CONFIG', 'SCRIPT', 'MODULE',
  'CLUSTER', 'MIGRATE', 'RESTORE', 'REPLICAOF', 'SLAVEOF', 'SAVE', 'BGSAVE', 'BGREWRITEAOF',
]);

/**
 * Decide whether a statement is destructive.
 *
 * "Destructive" is deliberately narrower than "writes". `readOnly: false` is granted
 * when a job needs to append a row; letting a model drop a schema is a much bigger
 * decision, and collapsing the two is OWASP MCP02:2025.
 *
 * The whole cleaned statement is scanned, not just the leading keyword: `WITH gone
 * AS (DELETE FROM t RETURNING *) SELECT * FROM gone` starts with `WITH` and still
 * deletes. The cost is a false positive on a column named `create`, the direction
 * this codebase refuses in everywhere else.
 * @param {string} [options.action] - MongoDB action; the payload alone does not say
 *   what will happen to a MongoDB write
 */
export function classifiesAsDestructive(query, protocol = '', options = {}) {
  if (typeof query !== 'string' || query.trim() === '') {
    return { destructive: false, reason: 'query must be a non-empty string to be classified' };
  }

  const base = baseProtocol(String(protocol || '').toLowerCase());

  if (MONGO_SCHEMES.has(base)) {
    const action = String(options.action ?? 'find').toLowerCase();
    if (DESTRUCTIVE_MONGO_ACTIONS.has(action)) {
      return { destructive: true, reason: `the MongoDB "${action}" action writes to a collection` };
    }
    // $out and $merge replace a collection; `findWriteStage` walks nested facets.
    const stage = findWriteStage(safeJsonParse(query));
    if (stage) {
      return { destructive: true, reason: `the ${stage} aggregation stage replaces a collection` };
    }
    return { destructive: false, reason: '' };
  }

  if (base === 'redis') {
    const verb = (query.trim().match(/^[a-z]+/i) || [''])[0].toUpperCase();
    if (DESTRUCTIVE_REDIS_COMMANDS.includes(verb)) {
      return { destructive: true, reason: `the Redis ${verb} command destroys data or reconfigures the server` };
    }
    return { destructive: false, reason: '' };
  }

  // `base` answers "MongoDB or Redis?" and `dialect` answers "which SQL grammar?",
  // both through the alias table in `./safety.js`. Unknown stays unknown.
  const dialect = sqlDialect(base);
  if (dialect === null) {
    return {
      destructive: false,
      reason: `protocol "${protocol}" is not classifiable, so nothing can be asserted about this statement`,
    };
  }

  // The same scanner the read-only guard uses, with the same two dialect questions: a
  // backslash escape in a MySQL literal, a dollar-quoted body a PostgreSQL literal.
  const cleaned = stripSqlNoise(query, {
    backslashEscapes: dialect === 'mysql',
    dollarQuoting: dialect === 'postgres',
  });

  // MySQL conditional comments are executable, so their contents cannot be read.
  if (/\bCONDITIONAL_COMMENT\b/.test(cleaned)) {
    return {
      destructive: true,
      reason: 'MySQL conditional comments (/*! ... */) execute server-side and cannot be verified',
    };
  }

  const match = cleaned.match(DESTRUCTIVE_SQL_RE);
  if (!match) return { destructive: false, reason: '' };

  return {
    destructive: true,
    reason: `${match[0].toUpperCase()} changes schema or privileges rather than data`,
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The policy a profile starts from. Read-only by default: an unconsidered
 *  permission reads as "no". */
export const POLICY_DEFAULTS = Object.freeze({
  readOnly: true,
  maxRows: 1000,
  maxBytes: 262144,
  queryTimeoutMs: 30000,
  connectTimeoutMs: 5000,
  allowedSchemas: [],
  allowedTables: [],
  hosts: [],
  allowedPaths: [],
  allowDestructive: false,
});

const pick = (...values) => values.find((value) => value !== undefined && value !== null);
const positiveInt = (value, fallback) =>
  Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback;

/**
 * Merge every source of authority into the policy one call runs under.
 *
 * Precedence, lowest first: the defaults above, the environment, the profile entry, then this
 * call's arguments. The environment sits under the profile on purpose, so an operator can
 * loosen a limit without editing every profile.
 * @returns {object} The documented policy fields, plus `allowDestructive`,
 *   `allowedPaths` and the destructive verdict. The extra fields are additive.
 */
export function evaluatePolicy(profileEntry = null, { query, options = {}, env = process.env } = {}) {
  const entry = profileEntry || {};
  const call = options || {};

  const policy = {
    readOnly: Boolean(pick(
      call.readOnly,
      entry.readOnly,
      parseBoolEnv(env.ANYDB_DEFAULT_READ_ONLY, POLICY_DEFAULTS.readOnly)
    )),
    maxRows: positiveInt(pick(call.maxRows, entry.maxRows,
      parseIntEnv(env.ANYDB_DEFAULT_MAX_ROWS, POLICY_DEFAULTS.maxRows)), POLICY_DEFAULTS.maxRows),
    maxBytes: positiveInt(pick(call.maxBytes, entry.maxBytes,
      parseIntEnv(env.ANYDB_DEFAULT_MAX_BYTES, POLICY_DEFAULTS.maxBytes)), POLICY_DEFAULTS.maxBytes),
    queryTimeoutMs: positiveInt(pick(call.queryTimeoutMs, call.timeout, entry.queryTimeoutMs,
      parseIntEnv(env.ANYDB_DEFAULT_QUERY_TIMEOUT_MS, POLICY_DEFAULTS.queryTimeoutMs)), POLICY_DEFAULTS.queryTimeoutMs),
    connectTimeoutMs: positiveInt(pick(call.connectTimeoutMs, entry.connectTimeoutMs,
      parseIntEnv(env.ANYDB_DEFAULT_CONNECT_TIMEOUT_MS, POLICY_DEFAULTS.connectTimeoutMs)), POLICY_DEFAULTS.connectTimeoutMs),
    allowedSchemas: pick(call.allowedSchemas, entry.allowedSchemas, POLICY_DEFAULTS.allowedSchemas),
    allowedTables: pick(call.allowedTables, entry.allowedTables, POLICY_DEFAULTS.allowedTables),
    hosts: pick(entry.hosts, POLICY_DEFAULTS.hosts),
    allowedPaths: pick(entry.allowedPaths, POLICY_DEFAULTS.allowedPaths),
    allowDestructive: Boolean(pick(
      call.allowDestructive,
      entry.allowDestructive,
      parseBoolEnv(env.ANYDB_ALLOW_DESTRUCTIVE, POLICY_DEFAULTS.allowDestructive)
    )),
  };

  const protocol = pick(call.protocol, entry.driver, '');
  const verdict = typeof query === 'string'
    ? classifiesAsDestructive(query, protocol, call)
    : { destructive: false, reason: '' };

  policy.destructive = verdict.destructive;
  policy.destructiveReason = verdict.reason;
  policy.destructiveAllowed = verdict.destructive ? policy.allowDestructive && !policy.readOnly : true;
  policy.destructiveBlockReason = policy.destructiveAllowed
    ? ''
    : `This statement is destructive because ${verdict.reason}. Destructive statements need both ` +
      'readOnly: false and allowDestructive: true, and a profile must set allowDestructive for this to ' +
      'be true at all.';

  return policy;
}

function parseIntEnv(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}
