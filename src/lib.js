/**
 * The package's library entry point: everything testable, nothing that runs.
 *
 * A pure barrel. Importing it constructs nothing, starts no timer, opens no
 * handle, registers no process handler, reads no file, and does not import
 * `src/index.js` at all. `__tests__/package_entry.test.js` proves that from a
 * child process, because "the process still exits" is the only honest test of
 * "nothing is holding it open".
 *
 * Side-effect-free but not free: `core/registry.js` statically imports all five
 * adapters because it resolves a driver in a synchronous factory, and each
 * adapter resolves its own driver with `await import()` inside `connect()`. So a
 * missing or unbuilt driver surfaces as a connect error rather than an import
 * error, and `scripts/verify-package.mjs` prints the cold import time on every
 * run: a climb back towards the old number means a module-scope `import` of a
 * driver has returned somewhere.
 *
 * Two layers, because a flat barrel has to choose between modules that export the
 * same name, and a wrong choice is invisible at the definition site. The **flat**
 * layer holds the names a caller is most likely to want, and where two modules
 * export the same name the *owning* module wins. The **namespace** layer holds the
 * full surface of every module, so a collision is visible rather than silent:
 * `resultLimits.DEFAULT_MAX_BYTES` and `logging.DEFAULT_MAX_BYTES` are 256 KiB
 * and 5 MiB, and they are different limits. `logging` is namespaced rather than
 * flattened because `log()` has a file sink, so `import { log } from 'anydb-mcp'`
 * would mean "write to my disk" without saying so.
 */

/* eslint-disable no-useless-rename */
/* istanbul ignore file -- a barrel has no runtime logic. Every statement
   Istanbul would count here is the `Object.defineProperty` that Babel's
   CommonJS transform emits for a re-export, so the file measures 0/0. The names
   it re-exports are asserted in `__tests__/package_entry.test.js`. */

export {
  AdapterRegistry,
  DEFAULT_TIMEOUT,
  ERROR_KINDS,
  ERROR_KIND_SUGGESTIONS,
  REPORTED_ENV,
  ROUTES,
  SUPPORTED_PROTOCOLS,
  classifyError,
  collectTableReferences,
  driverFor,
  isDeadConnectionError,
  isSerializationError,
  isTimeoutError,
  normaliseCacheKey,
  registryError,
  stripLiterals,
  suggestionFor,
} from './core/registry.js';

export {
  CONFIG_BASENAME,
  CREDENTIAL_REF_KEYS,
  PROFILE_SCHEMA_URL,
  ProfileStore,
  SUPPORTED_DRIVERS,
  exportProfile,
  injectCredentials,
  loadProfileStore,
  resetProfileWarnings,
  resolveConfigFile,
  stripCredentialFromUri,
  writeProfileStore,
} from './core/profiles.js';

export {
  BLOCKED_IPV4_RANGES,
  BLOCKED_IPV6_RANGES,
  CREDENTIAL_QUERY_PARAMS,
  DEFAULT_ALLOWED_SCHEMES,
  POLICY_DEFAULTS,
  allowedSchemes,
  checkConnectionPolicy,
  checkSqlitePathPolicy,
  classifiesAsDestructive,
  embeddedIpv4,
  evaluatePolicy,
  hostMatchesAllowlist,
  ipInCidr,
  isAdHocUriAllowed,
  isPathWithin,
  isPrivateAddress,
  parseBoolEnv,
  parseConnectionUri,
  parseIp,
  resetPolicyWarnings,
} from './core/policy.js';

export {
  MONGO_READ_ACTIONS,
  READ_ONLY_HINT,
  SQL_PROTOCOLS,
  TOO_DEEP,
  baseProtocol,
  findWriteStage,
  hasMultipleStatements,
  inspectDangerousOperators,
  inspectMongoOperation,
  inspectQuery,
  inspectRedisCommand,
  inspectSql,
  isSqlProtocol,
  stripSqlNoise,
} from './core/safety.js';

export {
  CIRCULAR_MARKER,
  DEPTH_MARKER,
  LIMIT_HINTS,
  MAX_BYTES_ENV,
  MAX_NESTING_DEPTH,
  MAX_ROWS_ENV,
  RESULT_FORMATS,
  buildEnvelope,
  clampResult,
  formatRows,
  measureBytes,
  normalizeForJson,
  resolvedTimezone,
} from './core/result-limits.js';

/**
 * The two default result caps, from the module that *applies* them.
 *
 * Declared here rather than left to `core/tools.js`, because `core/logging.js`
 * has a `DEFAULT_MAX_BYTES` of its own meaning the size at which one log record
 * is truncated. One flat name, one meaning.
 */
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_ROWS } from './core/result-limits.js';

export {
  DETAILS,
  FORMATS,
  LIMITS,
  MAX_MAX_BYTES,
  MAX_MAX_ROWS,
  MAX_TIMEOUT,
  MIN_TIMEOUT,
  MONGO_ACTIONS,
  MONGO_DEFAULT_LIMIT,
  MONGO_MAX_LIMIT,
  TOOLS,
  TOOL_NAMES,
  findTool,
  validateArgs,
} from './core/tools.js';

export { ConnectionCache, installShutdownHandlers } from './core/connection-cache.js';

export { BaseAdapter, TIMEOUT_GRACE_MS, TimeoutError, withTimeout } from './core/base-adapter.js';

/**
 * `positiveInt` is exported from `base-adapter` and not flattened: an
 * identically-behaved copy lives in `core/logging.js`, and two flat exports with
 * one name is the collision this layer exists to avoid. Take `baseAdapter.positiveInt`
 * or `logging.positiveInt`.
 */

/** The full surface of `core/registry.js`, for when the owning module matters. */
export * as registry from './core/registry.js';

/** The `db.json` reader, writer, resolver and credential handling. */
export * as profiles from './core/profiles.js';

/** Connection-string parsing, the host allowlist, and the read-only policy. */
export * as policy from './core/policy.js';

/** The statement inspector: what counts as a write, per dialect and per backend. */
export * as safety from './core/safety.js';

/** Row and byte caps, the response envelope, and the renderers. */
export * as resultLimits from './core/result-limits.js';

/** The five tool schemas, their bounds, and the argument validator. */
export * as tools from './core/tools.js';

/** The LRU/TTL connection cache and its shutdown wiring. */
export * as connectionCache from './core/connection-cache.js';

/** The adapter contract: `withTimeout`, `TimeoutError`, `BaseAdapter`. */
export * as baseAdapter from './core/base-adapter.js';

/**
 * The logger. Namespaced, never flattened, because `log()` writes a file.
 *
 * Importing this namespace is safe -- nothing is written until `log()` is called
 * with a record that passes the level threshold -- but a caller should have to
 * write `logging.log` to see the consequences.
 */
export * as logging from './core/logging.js';

/** The catalogue scanner behind `db_schema`, one adapter per database. */
export * as schema from './core/schema.js';

/** Where the config, the log and the cache live, and with which permissions. */
export * as paths from './core/paths.js';

/** The deadline helpers every adapter shares. */
export * as timeoutUtils from './core/timeout-utils.js';
