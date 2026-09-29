import { BaseAdapter, positiveInt, logCloseFailure } from '../core/base-adapter.js';
import { RedisSchemaAdapter } from '../core/schema.js';

/**
 * Reply values worth decoding as JSON before handing them to a caller. `HGETALL`
 * is not here: its reply is a mapping rather than a single document, and it is
 * handled by name in `decodePairs`.
 */
const JSON_REPLY_COMMANDS = new Set(['GET', 'HGET', 'MGET', 'HMGET']);

/**
 * Commands whose reply is a field/value mapping.
 *
 * `sendCommand` does not go through the typed path that applies the driver's reply
 * transformer, so `HGETALL` arrives exactly as the server sent it: a flat
 * `[field, value, …]` under RESP2, already a map under RESP3. Both become the same
 * answer, so a hash does not come back as a raw array while `HGET` comes back as
 * an object.
 */
const PAIR_REPLY_COMMANDS = new Set(['HGETALL']);

/**
 * Reads with no syntax for a limit: `HGETALL`, `HVALS`, `HKEYS`, `SMEMBERS`,
 * `ZRANGE 0 -1`, `LRANGE 0 -1` and `XRANGE - +` each return the whole collection,
 * and every one is on the read-only allowlist. One permitted read is therefore the
 * only place here where an unbounded reply is reachable with no user error at all,
 * so these are capped by default, at the response envelope's own row limit.
 */
const UNBOUNDED_READ_COMMANDS = new Set([
  'HGETALL', 'HVALS', 'HKEYS', 'SMEMBERS', 'ZRANGE', 'ZRANGEBYSCORE',
  'LRANGE', 'XRANGE', 'XREVRANGE',
]);

/** The cap applied to those reads when the caller names none. */
const DEFAULT_COLLECTION_CAP = 1000;

/**
 * The reads that are *paged* rather than sliced, when a cap applies. The SCAN
 * iterators yield one **page** per iteration, so a large hash stays pageable: the
 * server answers with a cursor and a page and this process never holds more than
 * `COUNT` entries.
 *
 * `ZRANGE` is deliberately **not** here. `ZRANGE key 0 -1` answers in score order
 * and `ZSCAN` is explicitly unordered, so substituting one for the other answers a
 * different question while looking identical. `ZRANGE` is sliced and marked
 * `truncated` instead, and the caller can page it with `ZRANGEBYSCORE`. The same
 * applies to `LRANGE` and `XRANGE`, for which node-redis has no scan iterator.
 */
const PAGED_BY_ITERATOR = new Map([
  ['HGETALL', 'hScanIterator'],
  ['HVALS', 'hScanValuesIterator'],
  ['HKEYS', 'hScanNoValuesIterator'],
  ['SMEMBERS', 'sScanIterator'],
]);

/**
 * Commands that change the connection itself, rather than the database.
 *
 * `SELECT` is the one that bites, and it is not a write at all: it changes the
 * database index of the **cached, shared** connection, so every later command for
 * that URI is silently retargeted at db1 while the tool still reports db0. The
 * rest change who the connection is or what it may do, which is the same class of
 * problem: state that outlives the call.
 */
const SESSION_COMMANDS = new Set([
  'SELECT', 'SWAPDB', 'HELLO', 'AUTH', 'RESET', 'QUIT', 'SHUTDOWN', 'MULTI', 'EXEC',
  'DISCARD', 'WATCH', 'UNWATCH', 'READONLY', 'ASKING', 'MONITOR', 'SUBSCRIBE',
  'PSUBSCRIBE', 'SSUBSCRIBE', 'FAILOVER',
]);

/** `CLIENT` and `CONFIG` subcommands that only read; the rest change state. */
const READING_SUBCOMMANDS = {
  client: new Set(['info', 'id', 'list', 'getname', 'no-evict', 'no-touch']),
  config: new Set(['get', 'resetstat']),
};

/** A sentinel for leaving `readPaged` as soon as the cap is reached. */
const STOP = Symbol('stop');

/**
 * The escapes Redis's own command-line rules recognise, in and out of quotes.
 *
 * Treating `\b` as a literal `b` — which is what dropping the backslash and
 * keeping the next character does — silently writes the wrong byte. Anything else
 * escaped is the character itself, so `a\ b` and `"say \"hi\""` still come out as
 * one argument each.
 */
const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' };

function unescapeChar(char) {
  return Object.prototype.hasOwnProperty.call(ESCAPES, char) ? ESCAPES[char] : char;
}

export class RedisAdapter extends BaseAdapter {
  /**
   * @param {Function} [clientClass] - `redis`'s `createClient`, or a substitute.
   *   Left `undefined`, it is resolved on the first `connect()`.
   * @param {number}   [timeout=30000]
   * @param {Function} [clusterFactory] - `createCluster`; injected by tests
   * @param {Function} [sentinelFactory] - `createSentinel`
   */
  constructor(
    clientClass = undefined,
    timeout = 30000,
    clusterFactory = undefined,
    sentinelFactory = undefined
  ) {
    super(5000, timeout);
    this.ClientClass = clientClass;
    this.ClusterFactory = clusterFactory;
    this.SentinelFactory = sentinelFactory;
    this.cluster = false;
  }

  /**
   * The driver, loaded once, on first use.
   *
   * Not a module-scope import: a stdio server pays this on every spawn, before
   * `initialize`, in a protocol whose first message is a handshake. Loaded in
   * `connect()` rather than the constructor, which is synchronous, and rather than
   * `execute()`, which is not inside the registry's `timeout + grace` budget.
   *
   * `undefined` means "not supplied" and is filled in from the driver; an explicit
   * `null` means "this build has no such factory" and is left alone, so
   * `connectCluster` can say so in words.
   */
  async loadRedisDriver() {
    if (this.ClientClass === undefined || this.ClusterFactory === undefined || this.SentinelFactory === undefined) {
      const driver = await import('redis');
      if (this.ClientClass === undefined) this.ClientClass = driver.createClient;
      if (this.ClusterFactory === undefined) this.ClusterFactory = driver.createCluster;
      if (this.SentinelFactory === undefined) this.SentinelFactory = driver.createSentinel;
    }
    return this;
  }

  async connect(uri) {
    await this.loadRedisDriver();

    if (/^redis-(cluster|sentinel):\/\//i.test(uri)) {
      await this.connectCluster(uri);
      return;
    }

    // A scheme that names a topology this adapter does not build, such as
    // `redis+sentinel://`. Prefixing it to `redis://` produced a DNS error about a
    // host that does not exist, which says nothing about the real problem. Only a
    // real scheme is refused: `localhost:6379` and `user:pass@host:6379` have no
    // `//` and are the bare forms below.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) && !/^rediss?:\/\//i.test(uri)) {
      throw new Error(
        `Redis URI scheme "${uri.split('://')[0]}://" is not a scheme this driver uses. `
        + 'Use redis:// or rediss:// for a single node, redis-cluster:// for a cluster, '
        + 'or redis-sentinel:// for a sentinel set.'
      );
    }

    // Tolerate bare `host:port` and `user:pass@host:port` forms.
    if (!/^rediss?:(\/\/|$)/i.test(uri)) {
      uri = `redis://${uri}`;
    }

    this.cluster = false;
    this.client = this.ClientClass({
      url: uri,
      socket: {
        connectTimeout: this.connectTimeout,
        // The socket timeout is deliberately **not** the query budget. It used to
        // be, and that became a live correctness bug once the cache stopped
        // stamping `queryTimeout` onto the adapter: a client created by a first
        // call with `timeout: 1000` kept that socket timeout for the life of the
        // cache entry, so every later call, including one that asked for thirty
        // seconds, was cut off at one second by a limit the caller never set.
        //
        // node-redis has no per-command timeout, so what is left is the
        // socket-level backstop for a connection that has gone quiet. 0 means "no
        // socket timeout"; a deployment that wants one sets
        // ANYDB_REDIS_SOCKET_TIMEOUT_MS.
        timeout: positiveInt(process.env.ANYDB_REDIS_SOCKET_TIMEOUT_MS, 0) || undefined,
      }
    });

    try {
      await this.client.connect();
    } catch (err) {
      throw describeError(err, this.connectTimeout);
    }
  }

  /**
   * Redis Cluster, and Sentinel where the driver can be told how to reach it.
   *
   * Both take separate options and neither takes a `url`: `createCluster` wants
   * `rootNodes` plus per-connection `defaults`, and a sentinel set wants
   * `createSentinel` plus the master's name. A URI naming one of these schemes
   * handed to `createClient` fails with a DNS error about a name that does not
   * exist, which is a very confusing way to learn that support was missing.
   */
  async connectCluster(uri) {
    const sentinel = /^redis-sentinel:/i.test(uri);
    const factory = sentinel ? this.SentinelFactory : this.ClusterFactory;

    if (typeof factory !== 'function') {
      throw new Error(
        `Redis ${sentinel ? 'sentinel' : 'cluster'} is not supported by this build of the redis driver. `
        + 'Use redis:// or rediss:// for a single node.'
      );
    }

    let url;
    try {
      url = new URL(uri);
    } catch {
      throw new Error(`Invalid Redis ${sentinel ? 'sentinel' : 'cluster'} URI format.`);
    }

    const password = decodeURIComponent(url.password);
    const username = decodeURIComponent(url.username);
    const auth = password ? { username: username || undefined, password } : undefined;
    const socket = { connectTimeout: this.connectTimeout };

    this.cluster = true;
    this.client = sentinel
      ? factory({
        // The path is the master's name, which is how a sentinel set is
        // addressed: `redis-sentinel://:pass@sentinel:26379/mymaster`.
        name: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'mymaster',
        ...(auth ? { sentinel: { ...auth, socket } } : {}),
        nodeClient: { socket },
      })
      : factory({
        rootNodes: [{ url: `redis://${url.hostname}${url.port ? `:${url.port}` : ''}` }],
        // Credentials and TLS belong in `defaults`: the root node is only how
        // the topology is discovered, and its settings are not inherited by the
        // connections to the nodes it finds.
        defaults: { ...(auth ? { username: auth.username, password: auth.password } : {}), socket },
      });

    try {
      await this.client.connect();
    } catch (err) {
      throw describeError(err, this.connectTimeout);
    }
  }

  /**
   * Run one command.
   *
   * @param {string} commandStr - One command line, e.g. `HGETALL user:1`.
   * @param {object} [options]
   * @param {number} [options.maxRows] - Cap a collection read at this many
   *   entries and mark the answer `truncated`. Applied to the commands in
   *   UNBOUNDED_READ_COMMANDS, which default to DEFAULT_COLLECTION_CAP.
   * @param {number} [options.timeout] - This call's budget, in milliseconds.
   * @param {Array}  [options.params] - Accepted and ignored, and that is not an
   *   oversight. **This adapter is structurally injection-safe**: the tokeniser
   *   below splits a command line, and the driver writes the command name and
   *   every argument as its own length-prefixed RESP bulk string, so no argument
   *   can become part of another one. There is no statement text to interpolate
   *   into, and therefore nothing to escape.
   */
  async execute(commandStr, options = {}) {
    const parts = this.parseCommand(commandStr);
    if (parts.length === 0) return [];

    const command = parts[0].toUpperCase();
    const args = parts.slice(1);
    const timeout = this.resolveQueryTimeout(options);
    const cap = readMaxRows(options.maxRows, UNBOUNDED_READ_COMMANDS.has(command));

    refuseSessionState(command, args);

    // A collection read with a cap is paged through the driver's SCAN iterators
    // rather than refused, so a hash too large for one reply is still partly
    // readable and the caller can ask for the rest.
    const iteratorName = cap === null ? null : PAGED_BY_ITERATOR.get(command);
    if (iteratorName && args.length > 0 && typeof this.client[iteratorName] === 'function') {
      return this.readPaged(iteratorName, args[0], cap, command);
    }

    let reply;
    try {
      reply = await this.client.sendCommand([command, ...args]);
    } catch (err) {
      throw describeError(err, timeout);
    }

    if (PAIR_REPLY_COMMANDS.has(command)) return hashRows(decodePairs(reply), { cap });

    if (reply === null || reply === undefined) {
      // A missing key is a nil on the wire, and that is the only thing reported
      // here: a key holding the JSON value `null` arrives as the *string* `"null"`,
      // is decoded below, and stays `null` in the answer. Checking after the
      // decode collapsed those two into one, and `[null]` cannot tell "not set"
      // from "set to null" — different facts about the database.
      return [{ _missing: true, reply: null }];
    }

    if (JSON_REPLY_COMMANDS.has(command)) reply = decodeJson(reply);

    if (cap !== null && Array.isArray(reply)) {
      return markTruncated(reply.slice(0, cap), reply.length > cap);
    }
    return Array.isArray(reply) ? reply : [reply];
  }

  /** A capped collection read, paged with the driver's SCAN iterators. */
  async readPaged(iteratorName, key, cap, command) {
    const rows = [];
    let truncated = false;

    try {
      for await (const page of this.client[iteratorName](key, { COUNT: Math.max(10, cap) })) {
        for (const item of Array.isArray(page) ? page : [page]) {
          if (rows.length >= cap) {
            truncated = true;
            throw STOP;
          }
          // HSCAN yields `{field, value}`; SSCAN yields bare values. A page is an
          // array, and a bare value is what an earlier major yielded, so both are
          // accepted.
          rows.push(item);
        }
      }
    } catch (err) {
      if (err !== STOP) throw describeError(err, this.queryTimeout);
    }

    if (!PAIR_REPLY_COMMANDS.has(command)) return markTruncated(rows, truncated);
    return hashRows(
      Object.fromEntries(rows.map((entry) => [entry.field, entry.value])),
      { truncated }
    );
  }

  describe(options = {}) {
    const schema = new RedisSchemaAdapter(this.connectTimeout, this.resolveQueryTimeout(options));
    schema.client = this.client;
    schema.describeError = (err) => this.describeError(err, schema.queryTimeout);
    return schema.describe(options);
  }

  /**
   * Split a command line on whitespace, honouring quotes and backslash escapes.
   *
   * This is a tokeniser, not a parser, and its limits are not the kind of thing a
   * caller learns from a failure:
   *
   *  - It is **binary-unsafe**, and so is the transport it sits on. The input is a
   *    JavaScript string, so an argument holding a NUL is truncated at the NUL by
   *    the driver's own conversion, and invalid UTF-8 has already been replaced with
   *    U+FFFD.
   *  - A backslash escapes the next character **everywhere**, inside a quoted value
   *    and outside one. Honouring it only inside quotes split `SET k a\ b` into two
   *    arguments, with the second half interpreted by Redis as a separate argument;
   *    Redis's own rules treat `\` as an escape outside quotes too.
   *  - A backslash at the very end is a literal backslash: there is nothing after it
   *    to escape.
   *
   * @param {string} commandStr - Raw command line
   * @returns {string[]} Command name followed by its arguments
   */
  parseCommand(commandStr) {
    const args = [];
    let current = '';
    let started = false;
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < commandStr.length; i++) {
      const char = commandStr[i];

      // Outside quotes only: inside one, the branch below consumes it first.
      if (!inQuote && char === '\\' && i + 1 < commandStr.length) {
        current += unescapeChar(commandStr[++i]);
        started = true;
        continue;
      }

      if (inQuote) {
        if (char === '\\' && i + 1 < commandStr.length) current += unescapeChar(commandStr[++i]);
        else if (char === quoteChar) {
          inQuote = false;
          args.push(current);
          current = '';
          started = false;
        } else current += char;
        continue;
      }

      if (char === '"' || char === "'") {
        inQuote = true;
        quoteChar = char;
        started = true;
      } else if (/\s/.test(char)) {
        if (started) {
          args.push(current);
          current = '';
          started = false;
        }
      } else {
        current += char;
        started = true;
      }
    }

    if (inQuote) {
      throw new Error(`Unbalanced quote in Redis command: ${commandStr}`);
    }
    if (started) args.push(current);

    return args;
  }

  /** node-redis tracks its own socket state, so this needs no round trip. */
  isHealthy() {
    if (!this.client || this.aborted) return false;
    return this.client.isReady === true;
  }

  /** For db_schema, so a refused command reads the same as it does in db_query. */
  describeError(err, timeout = this.queryTimeout) {
    return describeError(err, timeout);
  }

  /** Drop the socket, so Redis stops working on an abandoned command. */
  abort() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.aborted = true;
    try {
      client.destroy();
    } catch {
      // already destroyed
    }
  }

  async close() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;

    try {
      await client.quit();
    } catch (err) {
      try {
        logCloseFailure('redis', err, { aborted: this.aborted });
      } catch {
        // Degraded logging is still better than a close() that throws.
      }
    }
  }
}

/** The cap for one call, or null for "no cap". */
function readMaxRows(maxRows, hasDefault) {
  const n = Number(maxRows);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return hasDefault ? DEFAULT_COLLECTION_CAP : null;
}

/**
 * Refuse a command that changes the connection's own state.
 *
 * `SELECT` is the one that bites: a cached connection is shared, so `SELECT 1`
 * retargets every later command for that URI at db1 while the tool still reports
 * db0. Redis transactions need a pinned connection across calls, which this server
 * has no way to arrange. `CLIENT` and `CONFIG` are family names, so only the
 * subcommands that actually change something are refused — `CLIENT INFO` and
 * `CONFIG GET` are reads and stay available.
 */
function refuseSessionState(command, args = []) {
  const name = String(command).toUpperCase();
  const readers = READING_SUBCOMMANDS[name.toLowerCase()];
  // A family name is a command with a subcommand, and only the subcommands that
  // change something are refused: `CLIENT INFO` and `CONFIG GET` are reads.
  const changesState = readers
    ? !readers.has(String(args[0] || '').toLowerCase())
    : SESSION_COMMANDS.has(name);
  if (!changesState) return;
  throw new Error(
    `[Redis connection state] "${name}" changes the state of the cached connection, so every later `
    + 'command for this URI would inherit it — a SELECT alone silently retargets the whole connection at '
    + 'another database. Each URI is therefore pinned to the database its path names. Redis transactions '
    + '(MULTI/EXEC) need a tool that pins one connection across calls, which this server does not have.'
  );
}

/** A JSON document stored as a string, decoded when it parses. */
function decodeJson(reply) {
  if (typeof reply !== 'string') return reply;
  try {
    return JSON.parse(reply);
  } catch {
    return reply;
  }
}

/**
 * `HGETALL`'s two shapes, one answer.
 *
 * RESP2 sends a flat `[field, value, …]` array; RESP3 sends a map. An odd-length
 * array cannot be a field/value list, so it is handed back as it came rather than
 * half-decoded.
 */
function decodePairs(reply) {
  if (reply === null || reply === undefined) return reply;
  if (reply instanceof Map) return Object.fromEntries(reply);
  // The array test has to come before any "is it an object" test, because an
  // array *is* an object: with that order reversed, `typeof reply === 'object'`
  // swallowed the flat RESP2 array whole, so HGETALL answered with the raw
  // `[field, value, …]` it was supposed to normalise, and a cap applied to it
  // counted array slots rather than fields.
  if (!Array.isArray(reply)) return reply;
  if (reply.length % 2 !== 0) return reply;

  const out = {};
  for (let i = 0; i < reply.length; i += 2) out[String(reply[i])] = reply[i + 1];
  return out;
}

/**
 * One hash, as the single row the other backends would return for it.
 *
 * An empty hash is `[]`, not `[{}]`: there are no rows to report, and inventing an
 * empty object would put a document in the answer that does not exist in the
 * database. `cap` and `truncated` are separate because the two callers know
 * different things — the paged one stopped at the cap and so knows; the buffered
 * one has to compare the length.
 */
function hashRows(pairs, { cap = null, truncated = false } = {}) {
  if (pairs === null || pairs === undefined) return [];
  if (typeof pairs !== 'object' || Array.isArray(pairs)) return [pairs];

  const keys = Object.keys(pairs);
  if (keys.length === 0) return [];
  const cut = cap !== null && keys.length > cap;
  if (cut || truncated) {
    const kept = cap === null ? keys : keys.slice(0, cap);
    return markTruncated([Object.fromEntries(kept.map((key) => [key, pairs[key]]))], true);
  }
  return [pairs];
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
 * `cause` is the driver's own error and the stack still leads somewhere. Rebuilding
 * the error as a bare `Error` threw that away, which is what left
 * `registry.isDeadConnectionError` matching English to work out whether a
 * connection had gone.
 *
 * What `cause` does *not* give back is a code for a server reply. An earlier
 * version of this comment listed `MOVED` and `CLUSTERDOWN` as examples of codes
 * "reachable one link down", and they are not: `redis@6` builds every server
 * reply into a `SimpleError` straight from the wire string, with no `code` and no
 * `errno` on it, so `WRONGTYPE`, `NOAUTH`, `MOVED` and `CLUSTERDOWN` all arrive
 * with nothing to copy. Only socket-level failures (`ECONNRESET`, `ETIMEDOUT`)
 * carry a code, because those are Node errnos rather than replies. The message is
 * therefore the only channel for a Redis server error, and the documentation says
 * so rather than promising a field that is always null.
 */
function describeError(err, timeoutMs) {
  const message = (err && err.message) || String(err);
  const name = err && err.name;

  const describe = (text) => {
    const error = new Error(text);
    if (err instanceof Error) {
      Object.defineProperty(error, 'cause', { value: err, configurable: true, writable: true });
    }
    if (err && (typeof err.code === 'string' || typeof err.code === 'number')) error.code = err.code;
    return error;
  };

  if (/timed out|ETIMEDOUT|ClientClosedError|SocketClosedUnexpectedlyError|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND/i.test(`${name} ${message}`)) {
    return describe(`[Redis error] ${message} (client timeout was ${timeoutMs}ms)`);
  }

  return describe(`[Redis ${name || 'error'}] ${message}`);
}
