import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

/**
 * Where anydb keeps its files, resolved for whichever platform is asked about. Environment,
 * platform and home lookup are all injectable, so a test can ask what Windows or macOS would
 * do without being one.
 */

/** Name anydb owns inside a shared parent directory. */
export const APP_NAME = 'anydb';

/** The single config file, as documented in the README. */
export const CONFIG_FILE_NAME = 'db.json';

/** The active query log. Rotation appends `.<n>` to this. */
export const LOG_FILE_NAME = 'anydb.log';

/** A state directory holding query metadata, so 0700 like `~/.ssh`. */
export const DIR_MODE = 0o700;

/** The log file itself, for the same reason as DIR_MODE. */
export const FILE_MODE = 0o600;

export const LOG_SINKS = Object.freeze({
  file: 'file',
  stderr: 'stderr',
  off: 'off',
});

/**
 * `ANYDB_LOG_FILE` values that mean "do not open a file": without the list, `off` would
 * name a log file.
 */
const LOG_FILE_SENTINELS = new Map([
  ['stderr', LOG_SINKS.stderr],
  ['console', LOG_SINKS.stderr],
  ['-', LOG_SINKS.stderr],
  ['off', LOG_SINKS.off],
  ['none', LOG_SINKS.off],
  ['null', LOG_SINKS.off],
  ['0', LOG_SINKS.off],
  ['no', LOG_SINKS.off],
  ['disable', LOG_SINKS.off],
  ['disabled', LOG_SINKS.off],
]);

const nonEmpty = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/** The target platform's separator rules, not the host's. */
const pathApi = (platform) => (platform === 'win32' ? nodePath.win32 : nodePath.posix);

/** homedir() throws on some stripped-down containers, and that is not fatal. */
const safeHomedir = (homedirFn) => {
  try {
    return nonEmpty(typeof homedirFn === 'function' ? homedirFn() : undefined);
  } catch {
    return undefined;
  }
};

/** The home directory: %USERPROFILE% on Windows, $HOME elsewhere, then `os.homedir()`. */
function resolveHomeBase(env, platform, homedirFn) {
  const fromEnv = platform === 'win32'
    ? nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME)
    : nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE);
  // Last resort is the cwd: every path below needs a base.
  return fromEnv ?? safeHomedir(homedirFn) ?? process.cwd();
}

/**
 * Resolve every path anydb uses.
 *
 * @param {object} env - environment to read (default: process.env)
 * @param {string} platform - process.platform value to resolve for
 * @param {Function} homedirFn - home-directory lookup, injectable for tests
 * @returns {{home, configFile, xdgConfigFile, logDir, logFile, logFileMode, legacyHome}}
 */
export function resolveAnyDbPaths(env = process.env, platform = process.platform, homedirFn = os.homedir) {
  const p = pathApi(platform);
  const source = env && typeof env === 'object' ? env : {};
  const homeBase = resolveHomeBase(source, platform, homedirFn);

  // ANYDB_HOME wins, so a config can live outside $HOME entirely.
  const explicitHome = nonEmpty(source.ANYDB_HOME);
  const home = explicitHome ?? p.join(homeBase, `.${APP_NAME}`);

  // ANYDB_CONFIG is an explicit path and outranks the home-derived default.
  const explicitConfig = nonEmpty(source.ANYDB_CONFIG);
  const configFile = explicitConfig ?? p.join(home, CONFIG_FILE_NAME);

  // Secondary lookup only: the dotfile predates the XDG convention, so writes go to `home`.
  const xdgBase = nonEmpty(source.XDG_CONFIG_HOME) ?? p.join(homeBase, '.config');
  const xdgConfigFile = p.join(xdgBase, APP_NAME, CONFIG_FILE_NAME);

  const logDir = resolveLogDir(source, platform, homeBase, p);
  const { logFile, logFileMode } = resolveLogFile(source, logDir, p);

  return {
    home,
    configFile,
    xdgConfigFile,
    logDir,
    logFile,
    logFileMode,
    // Null rather than invented: `~/.anydb` is an odd directory name on Windows.
    legacyHome: platform === 'win32' ? null : p.join(homeBase, `.${APP_NAME}`),
  };
}

/**
 * Log directory. A *state* directory: XDG State Directory on Linux, `~/Library/Logs` on
 * macOS, %LOCALAPPDATA% on Windows.
 */
function resolveLogDir(env, platform, homeBase, p) {
  const explicit = nonEmpty(env.ANYDB_LOG_DIR);
  if (explicit) return explicit;

  if (platform === 'win32') {
    // %LOCALAPPDATA% is the Windows convention, and is not synced into roaming profiles.
    const localAppData = nonEmpty(env.LOCALAPPDATA) ?? p.join(homeBase, 'AppData', 'Local');
    return p.join(localAppData, APP_NAME, 'logs');
  }

  if (platform === 'darwin') {
    // ~/Library/Logs/<app>, where macOS puts its own application logs.
    return p.join(homeBase, 'Library', 'Logs', APP_NAME);
  }

  // XDG_STATE_HOME, defaulting to ~/.local/state.
  const stateHome = nonEmpty(env.XDG_STATE_HOME) ?? p.join(homeBase, '.local', 'state');
  return p.join(stateHome, APP_NAME);
}

/** Log file. A bare name belongs in the log directory; anything path-shaped is used as
 *  given, so a user can point at a volume or a mounted log share. */
function resolveLogFile(env, logDir, p) {
  const raw = nonEmpty(env.ANYDB_LOG_FILE);
  if (!raw) return { logFile: p.join(logDir, LOG_FILE_NAME), logFileMode: LOG_SINKS.file };

  const sentinel = LOG_FILE_SENTINELS.get(raw.trim().toLowerCase());
  if (sentinel) return { logFile: raw.trim(), logFileMode: sentinel };

  // A path is anything carrying a separator, or absolute on a platform that spells it
  // without one. Anything else is a filename.
  const looksLikePath = /[\\/]/.test(raw) || p.isAbsolute(raw);
  return {
    logFile: looksLikePath ? raw : p.join(logDir, raw),
    logFileMode: LOG_SINKS.file,
  };
}

/**
 * Create a directory (and parents) with owner-only permissions. Idempotent. Separate from
 * the resolver on purpose: creating what it resolves turns a read-only filesystem into a
 * startup crash. Throws; the caller decides.
 */
export function ensureDir(dir, mode = DIR_MODE) {
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError('ensureDir requires a directory path');
  }
  // `mode` only reaches directories this call creates, and the umask still filters it.
  fs.mkdirSync(dir, { recursive: true, mode });
  return dir;
}

/**
 * Whether `dir` exists and something can actually be written into it. Read-only,
 * other-owned and full all answer the same way for the logger: carry on without a file.
 * Never throws.
 */
export function writableCheck(dir) {
  try {
    if (typeof dir !== 'string' || dir === '') return false;
    const stats = fs.statSync(dir);
    if (!stats.isDirectory()) return false;

    // A real create-and-delete: access(W_OK) is advisory and says nothing about a full disk.
    const probe = nodePath.join(dir, `.anydb-write-probe-${process.pid}-${randomSuffix()}`);
    try {
      fs.writeFileSync(probe, '', { flag: 'wx', mode: FILE_MODE });
    } finally {
      try { fs.unlinkSync(probe); } catch { /* nothing was created */ }
    }
    return true;
  } catch {
    return false;
  }
}

const randomSuffix = () => Math.random().toString(36).slice(2, 10);
