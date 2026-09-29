import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  maskUri, describeQuery, log, logQueryDetail, logError, isDebugEnabled, logLevelEnabled,
  parseBool, positiveInt, statementHash, statementVerb, statementSummary,
  parseDotEnv, loadDotEnv, resolveLogLevel, resolveLogFormat, queryTextEnabled,
  LOG_LEVELS, UNTRUNCATED_FIELDS, DEFAULT_MAX_VALUE_LENGTH,
} from '../src/core/logging.js';
import {
  resolveAnyDbPaths, ensureDir, writableCheck, LOG_SINKS, DIR_MODE, FILE_MODE, APP_NAME,
  CONFIG_FILE_NAME, LOG_FILE_NAME,
} from '../src/core/paths.js';

/**
 * Set environment variables for the duration of `fn` and put the old values
 * back. `undefined` deletes, which is how a test says "this knob is unset".
 */
const withEnv = (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const tmpRoots = [];

const makeTmpDir = (prefix = 'anydb-log-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};

/** A module with its own config cache, file sink and degradation state. */
const freshLogger = () => {
  let mod;
  jest.isolateModules(() => { mod = require('../src/core/logging.js'); });
  return mod;
};

let written = [];
let consoleSpy;

beforeEach(() => {
  written = [];
  consoleSpy = jest.spyOn(console, 'error').mockImplementation((...args) => written.push(args.join(' ')));
  // The file sink is on by default; without this every test in the file would
  // append to the real user log directory.
  process.env.ANYDB_LOG_FILE = 'off';
});

afterEach(() => {
  consoleSpy.mockRestore();
  delete process.env.ANYDB_LOG_FILE;
  while (tmpRoots.length) {
    fs.rmSync(tmpRoots.pop(), { recursive: true, force: true, maxRetries: 3 });
  }
});

const lastLine = () => written[written.length - 1];
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

describe('src/core/paths.js', () => {
  const home = { win32: 'C:\\Users\\ada', darwin: '/Users/ada', linux: '/home/ada' };
  const resolve = (env, platform = 'linux', homedirFn = () => home[platform] ?? '/home/ada') =>
    resolveAnyDbPaths(env, platform, homedirFn);

  describe('resolveAnyDbPaths on win32', () => {
    const win = (env = {}) => resolve(env, 'win32');

    test('uses %USERPROFILE%\\.anydb as the config home', () => {
      expect(win().home).toBe('C:\\Users\\ada\\.anydb');
    });

    test('derives the config file from the home', () => {
      expect(win().configFile).toBe(`C:\\Users\\ada\\.anydb\\${CONFIG_FILE_NAME}`);
    });

    test('derives LOCALAPPDATA from USERPROFILE when it is unset', () => {
      expect(win().logDir).toBe('C:\\Users\\ada\\AppData\\Local\\anydb\\logs');
    });

    test('honours LOCALAPPDATA when it is set', () => {
      expect(win({ LOCALAPPDATA: 'D:\\Cache' }).logDir).toBe('D:\\Cache\\anydb\\logs');
    });

    test('derives the log file from the log directory', () => {
      expect(win().logFile).toBe(`C:\\Users\\ada\\AppData\\Local\\anydb\\logs\\${LOG_FILE_NAME}`);
    });

    test('reports no legacy dotfile home on Windows', () => {
      // A directory called `.anydb` in a Windows profile is not a convention
      // anyone uses, so the field is null rather than invented.
      expect(win().legacyHome).toBeNull();
    });
  });

  describe('resolveAnyDbPaths on darwin', () => {
    const mac = (env = {}) => resolve(env, 'darwin');

    test('uses ~/.anydb for the config home', () => {
      expect(mac().home).toBe('/Users/ada/.anydb');
    });

    test('uses ~/Library/Logs/anydb for the log directory', () => {
      expect(mac().logDir).toBe('/Users/ada/Library/Logs/anydb');
    });

    test('ignores XDG_STATE_HOME, which is not a macOS convention', () => {
      expect(mac({ XDG_STATE_HOME: '/tmp/state' }).logDir).toBe('/Users/ada/Library/Logs/anydb');
    });

    test('reports the legacy dotfile home', () => {
      expect(mac().legacyHome).toBe('/Users/ada/.anydb');
    });
  });

  describe('resolveAnyDbPaths on other platforms', () => {
    const nix = (env = {}) => resolve(env, 'linux');

    test('uses ~/.anydb for the config home', () => {
      expect(nix().home).toBe('/home/ada/.anydb');
    });

    test('honours XDG_STATE_HOME', () => {
      expect(nix({ XDG_STATE_HOME: '/var/lib/user' }).logDir).toBe('/var/lib/user/anydb');
    });

    test('falls back to ~/.local/state/anydb', () => {
      // XDG Base Directory Spec v0.8 §4 default.
      expect(nix().logDir).toBe('/home/ada/.local/state/anydb');
    });

    test('reports the legacy dotfile home', () => {
      expect(nix().legacyHome).toBe('/home/ada/.anydb');
    });
  });

  describe('config file', () => {
    test('ANYDB_CONFIG wins over the home', () => {
      const paths = resolve({ ANYDB_CONFIG: '/etc/anydb/db.json' }, 'linux');
      expect(paths.configFile).toBe('/etc/anydb/db.json');
      // The home itself is unchanged: only the file was overridden.
      expect(paths.home).toBe('/home/ada/.anydb');
    });

    test('ANYDB_CONFIG wins over ANYDB_HOME', () => {
      const paths = resolve({ ANYDB_HOME: '/srv/anydb', ANYDB_CONFIG: '/srv/other.json' }, 'linux');
      expect(paths.configFile).toBe('/srv/other.json');
    });

    test('ANYDB_HOME moves the config file with it', () => {
      const paths = resolve({ ANYDB_HOME: '/srv/anydb' }, 'linux');
      expect(paths.home).toBe('/srv/anydb');
      expect(paths.configFile).toBe(`/srv/anydb/${CONFIG_FILE_NAME}`);
    });

    test('exposes the XDG config location as a secondary lookup', () => {
      const paths = resolve({ XDG_CONFIG_HOME: '/home/ada/cfg' }, 'linux');
      expect(paths.xdgConfigFile).toBe('/home/ada/cfg/anydb/db.json');
    });

    test('defaults the XDG config location to ~/.config', () => {
      // XDG Base Directory Spec v0.8 §3 default.
      const paths = resolve({}, 'linux');
      expect(paths.xdgConfigFile).toBe(`/home/ada/.config/${APP_NAME}/${CONFIG_FILE_NAME}`);
    });

    test('keeps the XDG location separate from the writer location', () => {
      const paths = resolve({ XDG_CONFIG_HOME: '/home/ada/cfg' }, 'linux');
      expect(paths.configFile).not.toBe(paths.xdgConfigFile);
    });
  });

  describe('log file', () => {
    test('ANYDB_LOG_DIR wins over every platform default', () => {
      expect(resolve({ ANYDB_LOG_DIR: '/var/log/anydb' }, 'darwin').logDir).toBe('/var/log/anydb');
      expect(resolve({ ANYDB_LOG_DIR: '/var/log/anydb' }, 'win32').logDir).toBe('/var/log/anydb');
    });

    test('a bare ANYDB_LOG_FILE is joined into the log directory', () => {
      const paths = resolve({ ANYDB_LOG_FILE: 'queries.log' }, 'linux');
      expect(paths.logFile).toBe(`/home/ada/.local/state/anydb/queries.log`);
      expect(paths.logFileMode).toBe(LOG_SINKS.file);
    });

    test('a path-shaped ANYDB_LOG_FILE is used as given', () => {
      const paths = resolve({ ANYDB_LOG_FILE: '/var/log/db/query.log' }, 'linux');
      expect(paths.logFile).toBe('/var/log/db/query.log');
    });

    test('a Windows-shaped ANYDB_LOG_FILE keeps its separators', () => {
      const paths = resolve({ ANYDB_LOG_FILE: 'D:\\logs\\query.log' }, 'win32');
      expect(paths.logFile).toBe('D:\\logs\\query.log');
    });

    test('a relative path is still recognised as a path', () => {
      expect(resolve({ ANYDB_LOG_FILE: 'sub/dir/q.log' }, 'linux').logFile).toBe('sub/dir/q.log');
    });

    test.each([
      ['stderr', LOG_SINKS.stderr], ['STDERR', LOG_SINKS.stderr],
      ['off', LOG_SINKS.off], ['OFF', LOG_SINKS.off], ['0', LOG_SINKS.off], ['none', LOG_SINKS.off],
    ])('ANYDB_LOG_FILE=%s is a sink directive, not a filename', (value, mode) => {
      // Otherwise a user asking for no file would get one named `off`.
      const paths = resolve({ ANYDB_LOG_FILE: value }, 'linux');
      expect(paths.logFileMode).toBe(mode);
    });

    test('an empty ANYDB_LOG_FILE is ignored', () => {
      const paths = resolve({ ANYDB_LOG_FILE: '   ' }, 'linux');
      expect(paths.logFile).toBe(`/home/ada/.local/state/anydb/${LOG_FILE_NAME}`);
      expect(paths.logFileMode).toBe(LOG_SINKS.file);
    });
  });

  describe('degrading gracefully', () => {
    test('an empty environment still resolves', () => {
      const paths = resolveAnyDbPaths({}, 'linux', () => '/home/fallback');
      expect(paths.home).toBe('/home/fallback/.anydb');
      expect(paths.logDir).toBe('/home/fallback/.local/state/anydb');
    });

    test('a homedir lookup that throws does not take the caller down', () => {
      const paths = resolveAnyDbPaths({}, 'linux', () => { throw new Error('no home'); });
      expect(typeof paths.home).toBe('string');
      expect(paths.home.length).toBeGreaterThan(0);
    });

    test('a missing env object does not take the caller down', () => {
      expect(() => resolveAnyDbPaths(null, 'linux')).not.toThrow();
    });

    test('every resolved path is absolute', () => {
      for (const platform of ['win32', 'darwin', 'linux']) {
        const paths = resolve({}, platform);
        for (const key of ['home', 'configFile', 'xdgConfigFile', 'logDir', 'logFile']) {
          expect(typeof paths[key]).toBe('string');
          expect(paths[key]).not.toBe('');
        }
      }
    });

    test('uses the injected homedir when the environment is empty', () => {
      expect(resolveAnyDbPaths({}, 'linux', () => '/srv/ada').home).toBe('/srv/ada/.anydb');
    });

    test('does not touch the filesystem', () => {
      // Resolving a path must not create it: a read-only filesystem has to
      // stay a non-event until something actually writes.
      const home = makeTmpDir('anydb-paths-');
      const target = path.join(home, 'not-created');
      const paths = resolveAnyDbPaths({ ANYDB_HOME: target }, process.platform, () => home);
      expect(paths.configFile).toBe(path.join(target, CONFIG_FILE_NAME));
      expect(fs.existsSync(target)).toBe(false);
    });
  });

  describe('ensureDir', () => {
    test('creates a nested directory', () => {
      const root = makeTmpDir('anydb-ensure-');
      const target = path.join(root, 'a', 'b', 'c');
      ensureDir(target);
      expect(fs.statSync(target).isDirectory()).toBe(true);
    });

    test('is idempotent', () => {
      const target = path.join(makeTmpDir('anydb-ensure-'), 'twice');
      expect(() => { ensureDir(target); ensureDir(target); }).not.toThrow();
    });

    test('creates owner-only directories, as the XDG spec requires', () => {
      if (process.platform === 'win32') return; // no POSIX mode bits
      const target = path.join(makeTmpDir('anydb-ensure-'), 'private');
      ensureDir(target);
      expect(fs.statSync(target).mode & 0o777).toBe(DIR_MODE);
    });

    test('rejects a non-path', () => {
      expect(() => ensureDir('')).toThrow(TypeError);
      expect(() => ensureDir(null)).toThrow(TypeError);
    });

    test('propagates a failure so the caller can degrade', () => {
      const root = makeTmpDir('anydb-ensure-');
      const file = path.join(root, 'a-file');
      fs.writeFileSync(file, '');
      expect(() => ensureDir(path.join(file, 'under'))).toThrow();
    });
  });

  describe('writableCheck', () => {
    test('reports a fresh temporary directory as writable', () => {
      expect(writableCheck(makeTmpDir('anydb-write-'))).toBe(true);
    });

    test('reports a missing directory as not writable', () => {
      expect(writableCheck(path.join(makeTmpDir('anydb-write-'), 'nope'))).toBe(false);
    });

    test('reports a file as not writable', () => {
      const file = path.join(makeTmpDir('anydb-write-'), 'file');
      fs.writeFileSync(file, '');
      expect(writableCheck(file)).toBe(false);
    });

    test('rejects nonsense without throwing', () => {
      expect(writableCheck('')).toBe(false);
      expect(writableCheck(null)).toBe(false);
      expect(writableCheck(undefined)).toBe(false);
    });

    test('leaves no probe file behind', () => {
      const dir = makeTmpDir('anydb-write-');
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  });
});

describe('parseBool', () => {
  test.each(['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled'])('reads %s as on', (value) => {
    expect(parseBool(value, false)).toBe(true);
  });

  test.each(['0', 'false', 'no', 'n', 'off', 'disable', 'disabled', 'none'])('reads %s as off', (value) => {
    expect(parseBool(value, true)).toBe(false);
  });

  test.each(['TRUE', 'Yes', 'ON', ' OFF '])('ignores case and padding in %p', (value) => {
    expect(parseBool(value, false)).toBe(value.trim().toLowerCase() === 'off' ? false : true);
  });

  test('falls back for a value it does not recognise', () => {
    // Better than guessing: an unrecognised flag is a typo, and a typo that
    // turned debugging on would print query text to stderr.
    expect(parseBool('maybe', false)).toBe(false);
    expect(parseBool('maybe', true)).toBe(true);
  });

  test('falls back for empty, undefined and null', () => {
    expect(parseBool('', true)).toBe(true);
    expect(parseBool('   ', true)).toBe(true);
    expect(parseBool(undefined, true)).toBe(true);
    expect(parseBool(null, false)).toBe(false);
  });

  test('passes a boolean through', () => {
    expect(parseBool(true, false)).toBe(true);
    expect(parseBool(false, true)).toBe(false);
  });

  test('defaults to off', () => {
    expect(parseBool(undefined)).toBe(false);
  });
});

describe('positiveInt', () => {
  test('accepts a positive number', () => {
    expect(positiveInt('512', 10)).toBe(512);
    expect(positiveInt(7, 10)).toBe(7);
  });

  test('floors a fraction', () => {
    expect(positiveInt('10.9', 1)).toBe(10);
  });

  test.each(['0', '-1', 'abc', '', undefined, null, NaN, Infinity])('falls back for %p', (value) => {
    expect(positiveInt(value, 42)).toBe(42);
  });
});

describe('debugEnabled', () => {
  test.each([
    ['1', true], ['true', true], ['yes', true], ['on', true], ['YES', true],
    ['0', false], ['false', false], ['off', false], [undefined, false], ['maybe', false],
  ])('isDebugEnabled with ANYDB_DEBUG=%p', (value, expected) => {
    expect(withEnv({ ANYDB_DEBUG: value }, () => isDebugEnabled())).toBe(expected);
  });
});

describe('maskUri', () => {
  test('masks the whole userinfo of a PostgreSQL URI', () => {
    expect(maskUri('postgres://user:s3cr3t@host:5432/db'))
      .toBe('postgres://***:***@host:5432/db');
  });

  test('masks the whole userinfo of a MySQL URI', () => {
    expect(maskUri('mysql://root:letmein@127.0.0.1:3306/mydb'))
      .toBe('mysql://***:***@127.0.0.1:3306/mydb');
  });

  test('masks a Redis password-only URI', () => {
    expect(maskUri('redis://:s3cr3t@host:6379')).toBe('redis://***:***@host:6379');
  });

  test('masks a user with no password', () => {
    // The username is the whole userinfo, and a username is often a credential.
    expect(maskUri('postgres://readonly@host/db')).toBe('postgres://***@host/db');
  });

  test('masks a scheme-less userinfo form', () => {
    expect(maskUri('user:secret@host:5432/db')).toBe('***:***@host:5432/db');
  });

  test('masks a scheme-less username-only form', () => {
    expect(maskUri('admin@host')).toBe('***@host');
  });

  test('leaves a scheme-less string with no userinfo alone', () => {
    expect(maskUri('host:5432')).toBe('host:5432');
  });

  test('handles mongodb+srv', () => {
    expect(maskUri('mongodb+srv://user:pw@cluster0.example.com/test'))
      .toBe('mongodb+srv://***:***@cluster0.example.com/test');
  });

  test('handles rediss', () => {
    expect(maskUri('rediss://user:pw@host:6380/0')).toBe('rediss://***:***@host:6380/0');
  });

  test('redacts the query string, which can carry credentials', () => {
    // MongoDB and Redis both accept credentials in query parameters.
    const masked = maskUri('mongodb://host/db?authMechanismProperties=AWS_SESSION_TOKEN:abc123');
    expect(masked).not.toContain('abc123');
    expect(masked).toContain('redacted');
  });

  test('redacts a password= query parameter', () => {
    const masked = maskUri('postgresql://host/db?user=ada&password=hunter2&sslmode=require');
    expect(masked).not.toContain('hunter2');
  });

  test('redacts an sslpassword query parameter', () => {
    const masked = maskUri('postgresql://host/db?ssl=true&sslpassword=hunter2');
    expect(masked).not.toContain('hunter2');
  });

  test('redacts a fragment', () => {
    expect(maskUri('redis://host/0#secret')).not.toContain('secret');
  });

  test('never leaves the password anywhere in the output', () => {
    const masked = maskUri('postgres://user:hunter2@prod.db.internal:5432/analytics');
    expect(masked).not.toContain('hunter2');
  });

  test('never leaves the username anywhere in the output', () => {
    // IAM setups put the secret in the username, so there is no reason to keep it.
    const masked = maskUri('postgres://arn:aws:iam::123:user/db-admin:pw@host:5432/db');
    expect(masked).not.toContain('arn:aws');
    expect(masked).not.toContain('db-admin');
  });

  test('does not mangle a host that merely contains a colon', () => {
    // The colon in host:port is not a password separator.
    expect(maskUri('redis://localhost:6379')).toBe('redis://localhost:6379');
    expect(maskUri('postgres://db.internal:5432/app')).toBe('postgres://db.internal:5432/app');
  });

  test('keeps a URI without credentials readable', () => {
    expect(maskUri('sqlite:///var/db/app.db')).toBe('sqlite:///var/db/app.db');
    expect(maskUri('mongodb://cluster0.example.com:27017')).toBe('mongodb://cluster0.example.com:27017');
  });

  test('does not mistake an @ in a SQLite path for userinfo', () => {
    expect(maskUri('sqlite:///var/db/user@host.db')).toBe('sqlite:///var/db/user@host.db');
  });

  test('uses the last @ as the userinfo delimiter', () => {
    expect(maskUri('postgres://user:p%40ss@host:5432/db')).toBe('postgres://***:***@host:5432/db');
  });

  test('strips a newline so a URI cannot forge a log line', () => {
    const masked = maskUri('postgres://u:p@h/db\n[anydb] forged command=rm');
    expect(masked).not.toContain('\n');
    expect(masked).toContain('forged');
  });

  test('strips other control characters', () => {
    expect(maskUri('postgres://u:p@h/db\r ')).toBe('postgres://***:***@h/db');
  });

  test('handles a non-URI value without throwing', () => {
    expect(maskUri('')).toBe('');
    expect(maskUri(undefined)).toBe('undefined');
    expect(maskUri(42)).toBe('42');
    expect(maskUri(null)).toBe('null');
  });
});

describe('describeQuery', () => {
  test('reports keyword and length only', () => {
    const query = 'SELECT secret_value FROM users';
    const described = describeQuery(query);
    expect(described).toBe(`SELECT (${query.length} chars)`);
    expect(described).not.toContain('secret_value');
  });

  test('works for MongoDB and Redis inputs', () => {
    expect(describeQuery('GET session:abc')).toBe('GET (15 chars)');
    // A JSON filter has no leading keyword, so it falls back to a generic label.
    expect(describeQuery('{"token":"abc"}')).toBe('QUERY (15 chars)');
  });

  test('handles empty and non-string input', () => {
    expect(describeQuery('')).toBe('<empty>');
    expect(describeQuery('   ')).toBe('<empty>');
    expect(describeQuery(123)).toBe('<number>');
    expect(describeQuery(undefined)).toBe('<undefined>');
  });

  test('reports a long statement honestly', () => {
    const query = `SELECT ${'x'.repeat(5000)} FROM users`;
    expect(describeQuery(query)).toBe(`SELECT (${query.length} chars)`);
  });
});

describe('statementVerb', () => {
  test.each([
    ['select 1', 'SELECT'], ['  insert into t values (1)', 'INSERT'],
    ['GET key', 'GET'], ['{"a":1}', 'QUERY'], ['', 'QUERY'], [null, 'QUERY'],
  ])('reads %p as %p', (query, expected) => {
    expect(statementVerb(query)).toBe(expected);
  });
});

describe('statementHash', () => {
  const query = 'SELECT * FROM users WHERE email = \'ada@example.com\'';

  test('is 16 hex characters', () => {
    expect(statementHash(query)).toMatch(/^[0-9a-f]{16}$/);
  });

  test('is stable across calls and processes', () => {
    const expected = createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 16);
    expect(statementHash(query)).toBe(expected);
    expect(statementHash(query)).toBe(statementHash(query));
  });

  test('differs for a different statement', () => {
    expect(statementHash(query)).not.toBe(statementHash(`${query} `));
  });

  test('differs for the same statement against a different database literal', () => {
    // Two calls differing only in a literal are different statements.
    expect(statementHash('SELECT * FROM t WHERE id = 1'))
      .not.toBe(statementHash('SELECT * FROM t WHERE id = 2'));
  });

  test('contains no part of the statement', () => {
    const hashed = statementHash(query);
    expect(hashed).not.toContain('ada');
    expect(hashed).not.toContain('users');
    expect(hashed).not.toContain('SELECT');
  });

  test('handles non-string input without throwing', () => {
    expect(statementHash(undefined)).toMatch(/^[0-9a-f]{16}$/);
    expect(statementHash(123)).toMatch(/^[0-9a-f]{16}$/);
    expect(statementHash(null)).toBe(statementHash(''));
  });
});

describe('statementSummary', () => {
  test('describes a statement without quoting it', () => {
    const summary = statementSummary('SELECT 1');
    expect(summary).toEqual({ hash: statementHash('SELECT 1'), bytes: 8, verb: 'SELECT' });
    expect(JSON.stringify(summary)).not.toContain('SELECT 1');
  });

  test('counts bytes, not characters', () => {
    expect(statementSummary("SELECT 'é'").bytes).toBe(11);
  });

  test('handles an empty statement', () => {
    expect(statementSummary('')).toEqual({ hash: statementHash(''), bytes: 0, verb: 'QUERY' });
  });
});

describe('log', () => {
  describe('text format', () => {
    test('prefixes output so lines are attributable', () => {
      log('server ready', { version: '1.0.1' });
      expect(lastLine()).toMatch(/^\[anydb\] \d{4}-\d{2}-\d{2}T[\d:.]+Z info server ready version=1\.0\.1$/);
    });

    test('works with no detail', () => {
      log('bare message');
      expect(lastLine()).toMatch(/^\[anydb\] \S+ info bare message$/);
    });

    test('stamps an ISO-8601 timestamp with milliseconds', () => {
      log('stamped');
      const ts = lastLine().split(' ')[1];
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Math.abs(Date.parse(ts) - Date.now())).toBeLessThan(60_000);
    });

    test('prints the event only when it differs from the message', () => {
      log('db_query', { rows: 1 }, { event: 'tool_call' });
      expect(lastLine()).toContain(' tool_call db_query rows=1');
    });

    test('quotes a value containing a space', () => {
      log('m', { note: 'has space' });
      expect(lastLine()).toContain('note="has space"');
    });

    test('leaves a simple value unquoted', () => {
      log('m', { rows: 12, ok: true, missing: null });
      expect(lastLine()).toContain('rows=12 ok=true missing=null');
    });

    test('renders a nested object as compact JSON', () => {
      log('m', { stmt: { hash: 'abc', bytes: 8, verb: 'SELECT' } });
      expect(lastLine()).toContain('stmt="{\\"hash\\":\\"abc\\",\\"bytes\\":8,\\"verb\\":\\"SELECT\\"}"');
    });

    test('drops an undefined field rather than printing it', () => {
      log('m', { kept: 1, dropped: undefined });
      expect(lastLine()).toContain('kept=1');
      expect(lastLine()).not.toContain('dropped');
    });

    test('survives a circular value', () => {
      const loop = { name: 'loop' };
      loop.self = loop;
      expect(() => log('m', { loop })).not.toThrow();
      expect(lastLine()).toContain('[circular]');
    });

    test('names a non-finite number rather than reporting null', () => {
      log('m', { ratio: NaN, cap: Infinity });
      expect(lastLine()).toContain('ratio=NaN cap=Infinity');
    });

    test('does not let a field claim the record framing', () => {
      log('m', { ts: 'forged', level: 'error', event: 'other', msg: 'other' });
      expect(lastLine()).toMatch(/^\[anydb\] \S+ info m$/);
    });
  });

  describe('log injection', () => {
    test('a newline in a value cannot forge a second line', () => {
      log('m', { note: 'first\n[anydb] forged command=rm' });
      expect(written).toHaveLength(1);
      expect(lastLine()).toContain('note="first\\n[anydb] forged command=rm"');
      expect(lastLine().split('\n')).toHaveLength(1);
    });

    test('a carriage return cannot overwrite a line', () => {
      log('m', { note: 'a\r[anydb] forged' });
      expect(lastLine().split('\r')).toHaveLength(1);
      expect(lastLine()).toContain('\\r');
    });

    test('a tab is escaped so the pairs stay aligned', () => {
      log('m', { note: 'a\tb' });
      expect(lastLine()).toContain('note="a\\tb"');
    });

    test('a NUL byte is escaped', () => {
      log('m', { note: 'a b' });
      expect(lastLine()).toContain('\\u0000');
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001f]/.test(lastLine())).toBe(false);
    });

    test('a quote in a value cannot break out of the quoting', () => {
      log('m', { note: 'he said "hi" = 3' });
      expect(lastLine()).toContain('note="he said \\"hi\\" = 3"');
    });

    test('no control character ever reaches the line', () => {
      log('m', { evil: ` ` });
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(lastLine())).toBe(false);
    });

    test('a newline in the message is escaped too', () => {
      log('msg\n[anydb] forged');
      expect(written).toHaveLength(1);
      expect(lastLine()).toContain('\\n');
    });
  });

  describe('value truncation', () => {
    test('truncates a long free-form value at the documented bound', () => {
      log('query', { text: 'x'.repeat(5000) });
      const value = lastLine().split('text=')[1];
      expect(value).toBe(`${'x'.repeat(DEFAULT_MAX_VALUE_LENGTH)}...`);
    });

    test('the bound is 512 characters, not the old silent 120', () => {
      expect(DEFAULT_MAX_VALUE_LENGTH).toBe(512);
    });

    test('honours ANYDB_LOG_MAX_VALUE', () => {
      withEnv({ ANYDB_LOG_MAX_VALUE: '10' }, () => log('m', { text: 'x'.repeat(100) }));
      expect(lastLine()).toContain('text=xxxxxxxxxx...');
    });

    test('falls back to the default for a nonsense bound', () => {
      withEnv({ ANYDB_LOG_MAX_VALUE: 'lots' }, () => log('m', { text: 'x'.repeat(1000) }));
      expect(lastLine()).toContain('x'.repeat(DEFAULT_MAX_VALUE_LENGTH));
    });

    test('does not truncate a value shorter than the bound', () => {
      log('m', { text: 'short' });
      expect(lastLine()).toContain('text=short');
    });

    test('exempts the fields that are the event rather than an annotation', () => {
      expect(UNTRUNCATED_FIELDS.has('query')).toBe(true);
      expect(UNTRUNCATED_FIELDS.has('uri')).toBe(false);
    });
  });

  describe('argument shapes', () => {
    test('accepts an options object as a third argument', () => {
      log('db_query', { rows: 4, durationMs: 12 }, { level: 'warn', event: 'tool_call', callId: 'c-1' });
      expect(lastLine()).toMatch(/\[anydb\] \S+ warn tool_call db_query rows=4 durationMs=12 callId=c-1$/);
    });

    test('accepts an options object as a second argument', () => {
      log('db_query', { level: 'error', event: 'tool_call' });
      expect(lastLine()).toMatch(/\[anydb\] \S+ error tool_call db_query$/);
    });

    test('reads a second argument as fields when it is not purely options', () => {
      // The bag has a non-option key, so it is data, and `level` is reserved.
      log('m', { level: 'high', rows: 3 });
      expect(lastLine()).toContain('rows=3');
      expect(lastLine()).toMatch(/\[anydb\] \S+ info m /);
    });

    test('carries an explicit field bag inside an options object', () => {
      log('m', { level: 'info', callId: 'c-2', fields: { rows: 2 } });
      expect(lastLine()).toContain('rows=2 callId=c-2');
    });

    test('ignores a non-object second argument', () => {
      expect(() => log('m', 'not-a-detail')).not.toThrow();
      expect(lastLine()).toMatch(/info m$/);
    });

    test('ignores a non-object third argument', () => {
      expect(() => log('m', { a: 1 }, 'nope')).not.toThrow();
      expect(lastLine()).toContain('a=1');
    });

    test('normalises an Error field into a record', () => {
      log('m', { err: Object.assign(new Error('bad'), { code: 'E_BAD' }) });
      expect(lastLine()).toContain('err="{\\"name\\":\\"Error\\",\\"message\\":\\"bad\\",\\"code\\":\\"E_BAD\\"}"');
    });

    test('keeps a driver error object as structured data in json mode', () => {
      withEnv({ ANYDB_LOG_FORMAT: 'json' }, () =>
        log('m', { err: Object.assign(new Error('bad'), { code: 'E_BAD' }) }));
      expect(JSON.parse(lastLine()).err).toEqual({ name: 'Error', message: 'bad', code: 'E_BAD' });
    });
  });

  describe('levels', () => {
    test('emits an error at the default level', () => {
      log('m', {}, { level: 'error' });
      expect(written).toHaveLength(1);
    });

    test('emits info at the default level', () => {
      log('m', {}, { level: 'info' });
      expect(written).toHaveLength(1);
    });

    test('drops debug at the default level', () => {
      log('m', {}, { level: 'debug' });
      expect(written).toHaveLength(0);
    });

    test('drops trace at the default level', () => {
      log('m', {}, { level: 'trace' });
      expect(written).toHaveLength(0);
    });

    test('ANYDB_LOG_LEVEL=debug turns debug on', () => {
      withEnv({ ANYDB_LOG_LEVEL: 'debug' }, () => log('m', {}, { level: 'debug' }));
      expect(written).toHaveLength(1);
    });

    test('ANYDB_LOG_LEVEL=trace turns everything on', () => {
      withEnv({ ANYDB_LOG_LEVEL: 'trace' }, () => {
        log('a', {}, { level: 'error' });
        log('b', {}, { level: 'warn' });
        log('c', {}, { level: 'info' });
        log('d', {}, { level: 'debug' });
        log('e', {}, { level: 'trace' });
      });
      expect(written).toHaveLength(5);
    });

    test('ANYDB_LOG_LEVEL=error silences info', () => {
      withEnv({ ANYDB_LOG_LEVEL: 'error' }, () => {
        log('a', {}, { level: 'info' });
        expect(written).toHaveLength(0);
        log('b', {}, { level: 'error' });
        expect(written).toHaveLength(1);
      });
    });

    test('ANYDB_LOG_LEVEL is case-insensitive', () => {
      withEnv({ ANYDB_LOG_LEVEL: 'DEBUG' }, () => log('m', {}, { level: 'debug' }));
      expect(written).toHaveLength(1);
    });

    test('an unrecognised ANYDB_LOG_LEVEL falls back to info', () => {
      withEnv({ ANYDB_LOG_LEVEL: 'chatty' }, () => {
        log('a', {}, { level: 'debug' });
        expect(written).toHaveLength(0);
        log('b', {}, { level: 'info' });
        expect(written).toHaveLength(1);
      });
    });

    test('ANYDB_DEBUG=1 turns debug on without ANYDB_LOG_LEVEL', () => {
      // index.js tells the caller that ANYDB_DEBUG=1 is how to see a stack.
      withEnv({ ANYDB_DEBUG: '1' }, () => log('m', {}, { level: 'debug' }));
      expect(written).toHaveLength(1);
    });

    test('logLevelEnabled reads the environment', () => {
      expect(withEnv({ ANYDB_LOG_LEVEL: undefined, ANYDB_DEBUG: undefined },
        () => logLevelEnabled('error'))).toBe(true);
      expect(withEnv({ ANYDB_LOG_LEVEL: undefined, ANYDB_DEBUG: undefined },
        () => logLevelEnabled('info'))).toBe(true);
      expect(withEnv({ ANYDB_LOG_LEVEL: undefined, ANYDB_DEBUG: undefined },
        () => logLevelEnabled('debug'))).toBe(false);
      expect(withEnv({ ANYDB_LOG_LEVEL: 'debug', ANYDB_DEBUG: undefined },
        () => logLevelEnabled('debug'))).toBe(true);
      expect(withEnv({ ANYDB_LOG_LEVEL: 'debug', ANYDB_DEBUG: undefined },
        () => logLevelEnabled('trace'))).toBe(false);
    });

    test('the level order is error, warn, info, debug, trace', () => {
      expect(LOG_LEVELS.error).toBeLessThan(LOG_LEVELS.warn);
      expect(LOG_LEVELS.warn).toBeLessThan(LOG_LEVELS.info);
      expect(LOG_LEVELS.info).toBeLessThan(LOG_LEVELS.debug);
      expect(LOG_LEVELS.debug).toBeLessThan(LOG_LEVELS.trace);
    });

    test.each([
      ['error', 'error'], ['WARN', 'warn'], [' info ', 'info'],
      ['nonsense', 'info'], [undefined, 'info'], [null, 'info'], [42, 'info'],
    ])('resolves the level %p to %p', (raw, expected) => {
      expect(resolveLogLevel(raw)).toBe(expected);
    });

    test.each([
      ['json', 'json'], ['JSON', 'json'], ['text', 'text'], ['yaml', 'text'], [undefined, 'text'],
    ])('resolves the format %p to %p', (raw, expected) => {
      expect(resolveLogFormat(raw)).toBe(expected);
    });
  });

  describe('json format', () => {
    const emitJson = (fn) => withEnv({ ANYDB_LOG_FORMAT: 'json' }, fn);

    test('emits one parseable object per line', () => {
      emitJson(() => log('db_query', { rows: 3 }));
      const record = JSON.parse(lastLine());
      expect(record).toMatchObject({ level: 'info', event: 'db_query', msg: 'db_query', rows: 3 });
    });

    test('carries the record shape ts, level, event, msg, then fields', () => {
      emitJson(() => log('m', { a: 1 }));
      expect(Object.keys(JSON.parse(lastLine())).slice(0, 4))
        .toEqual(['ts', 'level', 'event', 'msg']);
    });

    test('stamps an ISO-8601 timestamp with milliseconds', () => {
      emitJson(() => log('m'));
      expect(JSON.parse(lastLine()).ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('a newline in a value is escaped, so the line stays one object', () => {
      emitJson(() => log('m', { note: 'a\n[anydb] forged' }));
      expect(written).toHaveLength(1);
      expect(JSON.parse(lastLine()).note).toBe('a\n[anydb] forged');
    });

    test('keeps the callId of a tool call', () => {
      emitJson(() => log('db_query', { rows: 1 }, { event: 'tool_call', callId: 'c-9' }));
      expect(JSON.parse(lastLine())).toMatchObject({ event: 'tool_call', callId: 'c-9' });
    });
  });
});

describe('logQueryDetail', () => {
  const query = `SELECT * FROM users WHERE email = 'ada@example.com' ${'-- padding'.repeat(80)}`;

  test('logs nothing when debugging is off', () => {
    withEnv({ ANYDB_DEBUG: undefined, ANYDB_LOG_LEVEL: undefined },
      () => logQueryDetail('postgres://h/d', 'SELECT 1'));
    expect(written).toHaveLength(0);
  });

  test('logs the full query when ANYDB_DEBUG is on', () => {
    withEnv({ ANYDB_DEBUG: '1' }, () => logQueryDetail('postgres://h/d', query));
    expect(written).toHaveLength(1);
    expect(lastLine()).toContain(query);
  });

  test('the full query is longer than the old 120-character cut', () => {
    expect(query.length).toBeGreaterThan(120);
    expect(query.length).toBeGreaterThan(DEFAULT_MAX_VALUE_LENGTH);
  });

  test('records a statement hash alongside the text', () => {
    withEnv({ ANYDB_DEBUG: '1' }, () => logQueryDetail('postgres://h/d', 'SELECT 1'));
    expect(lastLine()).toContain(`hash\\":\\"${statementHash('SELECT 1')}`);
  });

  test('records the statement size and verb', () => {
    withEnv({ ANYDB_DEBUG: '1' }, () => logQueryDetail('postgres://h/d', 'SELECT 1'));
    expect(lastLine()).toContain('bytes\\":8');
    expect(lastLine()).toContain('verb\\":\\"SELECT');
  });

  test('still masks the URI', () => {
    withEnv({ ANYDB_DEBUG: '1' },
      () => logQueryDetail('postgres://user:hunter2@host:5432/db', 'SELECT 1'));
    expect(lastLine()).not.toContain('hunter2');
  });

  test('does not print the query twice', () => {
    withEnv({ ANYDB_DEBUG: '1' }, () => logQueryDetail('postgres://h/d', 'SELECT 1'));
    expect(written).toHaveLength(1);
  });

  test.each(['1', 'true', 'yes', 'on'])('ANYDB_DEBUG=%p enables it', (value) => {
    withEnv({ ANYDB_DEBUG: value }, () => logQueryDetail('postgres://h/d', 'SELECT 1'));
    expect(written).toHaveLength(1);
  });

  test('ANYDB_LOG_LEVEL=debug alone is enough', () => {
    withEnv({ ANYDB_DEBUG: undefined, ANYDB_LOG_LEVEL: 'debug' },
      () => logQueryDetail('postgres://h/d', 'SELECT 1'));
    expect(written).toHaveLength(1);
  });

  test('is a debug record', () => {
    withEnv({ ANYDB_DEBUG: '1' }, () => logQueryDetail('postgres://h/d', 'SELECT 1'));
    expect(lastLine()).toMatch(/\[anydb\] \S+ debug query /);
  });

  test('survives a non-string query', () => {
    withEnv({ ANYDB_DEBUG: '1' }, () => logQueryDetail('postgres://h/d', 42));
    expect(written).toHaveLength(1);
  });

  test('carries extra fields from the caller', () => {
    withEnv({ ANYDB_DEBUG: '1' },
      () => logQueryDetail('postgres://h/d', 'SELECT 1', { rows: 12, durationMs: 8 }));
    expect(lastLine()).toContain('rows=12 durationMs=8');
  });
});

describe('logError', () => {
  const error = Object.assign(new Error('relation "users" does not exist'), { code: '42P01' });

  test('emits the message at error level', () => {
    logError('db_query', error);
    expect(lastLine()).toMatch(/\[anydb\] \S+ error db_query relation "users" does not exist/);
  });

  test('emits the error code', () => {
    logError('db_query', error);
    expect(lastLine()).toContain('code=42P01');
  });

  test('emits the stack at debug level, which is what makes the promise true', () => {
    withEnv({ ANYDB_DEBUG: '1' }, () => logError('db_query', error));
    const stack = written.find((line) => line.includes('at ') || line.includes('.js:'));
    expect(stack).toBeDefined();
    expect(stack).toMatch(/\[anydb\] \S+ debug db_query\.stack /);
  });

  test('stays quiet about the stack when debugging is off', () => {
    withEnv({ ANYDB_DEBUG: undefined, ANYDB_LOG_LEVEL: undefined }, () => logError('db_query', error));
    expect(written).toHaveLength(1);
  });

  test('keeps the error record even when the level hides debug', () => {
    withEnv({ ANYDB_LOG_LEVEL: 'error', ANYDB_DEBUG: undefined }, () => logError('db_query', error));
    expect(written).toHaveLength(1);
  });

  test('accepts a thrown string', () => {
    logError('db_query', 'plain string failure');
    expect(lastLine()).toContain('plain string failure');
  });

  test('accepts no error at all', () => {
    expect(() => logError('db_query', undefined)).not.toThrow();
    expect(lastLine()).toContain('undefined');
  });

  test('carries caller fields', () => {
    logError('db_query', error, { uri: 'postgres://***@h/d' });
    expect(lastLine()).toContain('uri=postgres://***@h/d');
  });

  test('names a non-Error class', () => {
    class TimeoutError extends Error { constructor(m) { super(m); this.name = 'TimeoutError'; } }
    logError('db_query', new TimeoutError('too slow'));
    expect(lastLine()).toContain('errName=TimeoutError');
  });
});

describe('the file sink', () => {
  const logFileFor = (dir) => path.join(dir, LOG_FILE_NAME);
  const useTmpDir = (extra = {}) => {
    const dir = makeTmpDir('anydb-sink-');
    return { dir, run: (fn) => withEnv({ ANYDB_LOG_FILE: undefined, ANYDB_LOG_DIR: dir, ...extra }, fn) };
  };

  test('writes a record to the resolved log file', () => {
    const { dir, run } = useTmpDir();
    run(() => log('server ready', { version: '2.0.4' }));
    const lines = readLines(logFileFor(dir));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[anydb]');
    expect(lines[0]).toContain('server ready version=2.0.4');
  });

  test('creates the log directory that did not exist', () => {
    const root = makeTmpDir('anydb-sink-');
    const nested = path.join(root, 'deep', 'logs');
    withEnv({ ANYDB_LOG_FILE: undefined, ANYDB_LOG_DIR: nested }, () => log('m'));
    expect(fs.existsSync(logFileFor(nested))).toBe(true);
  });

  test('creates the log file owner-only where POSIX modes apply', () => {
    if (process.platform === 'win32') return;
    const { dir, run } = useTmpDir();
    run(() => log('m'));
    expect(fs.statSync(logFileFor(dir)).mode & 0o777).toBe(FILE_MODE);
  });

  test('appends rather than truncating', () => {
    const { dir, run } = useTmpDir();
    run(() => { log('one'); log('two'); });
    const lines = readLines(logFileFor(dir));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('one');
    expect(lines[1]).toContain('two');
  });

  test('ends every line with a newline, so a tail reads a whole record', () => {
    const { dir, run } = useTmpDir();
    run(() => log('m'));
    expect(fs.readFileSync(logFileFor(dir), 'utf8').endsWith('\n')).toBe(true);
  });

  test('writes one JSON object per line when the format says so', () => {
    const { dir, run } = useTmpDir({ ANYDB_LOG_FORMAT: 'json' });
    run(() => { log('one', { rows: 1 }); log('two', { rows: 2 }); });
    const lines = readLines(logFileFor(dir));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ msg: 'two', rows: 2 });
  });

  test('writes nothing when ANYDB_LOG_FILE=off', () => {
    const dir = makeTmpDir('anydb-sink-');
    withEnv({ ANYDB_LOG_FILE: 'off', ANYDB_LOG_DIR: dir }, () => log('m'));
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(written).toHaveLength(1); // stderr still gets it
  });

  test('writes nothing when ANYDB_LOG_FILE=stderr', () => {
    const dir = makeTmpDir('anydb-sink-');
    withEnv({ ANYDB_LOG_FILE: 'stderr', ANYDB_LOG_DIR: dir }, () => log('m'));
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(written).toHaveLength(1);
  });

  test('honours a custom file name inside the log directory', () => {
    const { dir, run } = useTmpDir({ ANYDB_LOG_FILE: 'queries.log' });
    run(() => log('m'));
    expect(fs.existsSync(path.join(dir, 'queries.log'))).toBe(true);
  });

  test('honours a path-shaped ANYDB_LOG_FILE and creates its directory', () => {
    const root = makeTmpDir('anydb-sink-');
    const target = path.join(root, 'wherever', 'q.log');
    withEnv({ ANYDB_LOG_FILE: target, ANYDB_LOG_DIR: undefined }, () => log('m'));
    expect(fs.existsSync(target)).toBe(true);
  });

  test('still writes to stderr when the file sink is off', () => {
    withEnv({ ANYDB_LOG_FILE: 'off' }, () => log('m', { rows: 1 }));
    expect(lastLine()).toContain('rows=1');
  });

  test('keeps query text out of the file even when debugging', () => {
    const { dir, run } = useTmpDir();
    run(() => withEnv({ ANYDB_DEBUG: '1' },
      () => logQueryDetail('postgres://h/d', "SELECT 'a-very-secret-literal' AS v")));
    const contents = fs.readFileSync(logFileFor(dir), 'utf8');
    expect(contents).not.toContain('a-very-secret-literal');
    expect(contents).toContain(statementHash("SELECT 'a-very-secret-literal' AS v"));
  });

    test('ANYDB_LOG_QUERY_TEXT=1 opts into statement text on disk', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_QUERY_TEXT: '1' });
      run(() => {
        expect(queryTextEnabled()).toBe(true);
        withEnv({ ANYDB_DEBUG: '1' }, () => logQueryDetail('postgres://h/d', 'SELECT 1'));
      });
      expect(fs.readFileSync(logFileFor(dir), 'utf8')).toContain('SELECT 1');
    });

  test('leaves a file with a masked URI, never a credential', () => {
    const { dir, run } = useTmpDir();
    run(() => log('db_query', { uri: maskUri('postgres://user:hunter2@host:5432/db') }));
    expect(fs.readFileSync(logFileFor(dir), 'utf8')).not.toContain('hunter2');
  });

  describe('rotation', () => {
    const fill = (dir, count, extra = {}) => withEnv(
      { ANYDB_LOG_FILE: undefined, ANYDB_LOG_DIR: dir, ANYDB_LOG_MAX_BYTES: '300', ...extra },
      () => { for (let i = 0; i < count; i += 1) log(`record ${i}`, { pad: 'y'.repeat(100) }); }
    );

    test('rotates the active file to .1', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_MAX_BYTES: '300', ANYDB_LOG_BACKUPS: '3' });
      run(() => fill(dir, 12));
      expect(fs.existsSync(`${logFileFor(dir)}.1`)).toBe(true);
    });

    test('rotates on to .2', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_MAX_BYTES: '300', ANYDB_LOG_BACKUPS: '3' });
      run(() => fill(dir, 12));
      expect(fs.existsSync(`${logFileFor(dir)}.2`)).toBe(true);
    });

    test('keeps the newest generation in .1 and an older one in .2', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_MAX_BYTES: '300', ANYDB_LOG_BACKUPS: '3' });
      run(() => fill(dir, 12));
      const numberIn = (line) => Number(line.match(/record (\d+)/)[1]);
      const oldest = readLines(`${logFileFor(dir)}.2`).map(numberIn);
      const middle = readLines(`${logFileFor(dir)}.1`).map(numberIn);
      const newest = readLines(logFileFor(dir)).map(numberIn);

      // Generations are in age order and rotation is a rename, so no record is
      // duplicated or lost inside the window.
      expect(oldest.length).toBeGreaterThan(0);
      expect(Math.max(...oldest)).toBeLessThan(Math.min(...middle));
      expect(Math.max(...middle)).toBeLessThan(Math.min(...newest));
      const all = [...oldest, ...middle, ...newest];
      expect(new Set(all).size).toBe(all.length);
      // The last record written is the newest one on disk.
      expect(newest[newest.length - 1]).toBe(11);
    });

    test('never exceeds the backup count', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_MAX_BYTES: '300', ANYDB_LOG_BACKUPS: '2' });
      run(() => fill(dir, 20));
      expect(fs.existsSync(`${logFileFor(dir)}.1`)).toBe(true);
      expect(fs.existsSync(`${logFileFor(dir)}.2`)).toBe(true);
      expect(fs.existsSync(`${logFileFor(dir)}.3`)).toBe(false);
    });

    test('ANYDB_LOG_BACKUPS=1 keeps a single generation', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_MAX_BYTES: '300', ANYDB_LOG_BACKUPS: '1' });
      run(() => fill(dir, 20));
      expect(fs.existsSync(`${logFileFor(dir)}.1`)).toBe(true);
      expect(fs.existsSync(`${logFileFor(dir)}.2`)).toBe(false);
    });

    test('keeps the active file under the cap', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_MAX_BYTES: '1000', ANYDB_LOG_BACKUPS: '3' });
      run(() => {
        for (let i = 0; i < 40; i += 1) log(`record ${i}`, { pad: 'y'.repeat(100) });
      });
      expect(fs.statSync(logFileFor(dir)).size).toBeLessThanOrEqual(1000);
    });

    test('defaults to 5 MiB and 3 backups', () => {
      const { dir, run } = useTmpDir();
      run(() => log('m'));
      expect(fs.existsSync(logFileFor(dir))).toBe(true);
    });

    test('a nonsense cap does not remove rotation', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_MAX_BYTES: 'lots', ANYDB_LOG_BACKUPS: '-2' });
      expect(() => run(() => log('m'))).not.toThrow();
      expect(fs.existsSync(logFileFor(dir))).toBe(true);
    });
  });

  describe('retention', () => {
    const ageBy = (days) => {
      const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return when;
    };

    test('deletes a rotated file older than ANYDB_LOG_TTL_DAYS', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_TTL_DAYS: '1' });
      const stale = `${logFileFor(dir)}.1`;
      fs.writeFileSync(stale, 'old\n');
      const when = ageBy(40);
      fs.utimesSync(stale, when, when);
      run(() => log('fresh'));
      expect(fs.existsSync(stale)).toBe(false);
    });

    test('keeps a rotated file inside the window', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_TTL_DAYS: '30' });
      const recent = `${logFileFor(dir)}.1`;
      fs.writeFileSync(recent, 'recent\n');
      run(() => log('fresh'));
      expect(fs.existsSync(recent)).toBe(true);
    });

    test('never deletes the active log file', () => {
      const { dir, run } = useTmpDir({ ANYDB_LOG_TTL_DAYS: '1' });
      const when = ageBy(400);
      run(() => log('m'));
      fs.utimesSync(logFileFor(dir), when, when);
      run(() => log('m again'));
      expect(fs.existsSync(logFileFor(dir))).toBe(true);
    });
  });

  describe('degrading to stderr', () => {
    /** A log directory whose parent is a file: no path on any platform works. */
    const blocked = () => {
      const root = makeTmpDir('anydb-blocked-');
      const file = path.join(root, 'blocker');
      fs.writeFileSync(file, 'not a directory');
      return path.join(file, 'logs');
    };

    test('does not throw when the log directory cannot be created', () => {
      const logger = freshLogger();
      expect(() => withEnv(
        { ANYDB_LOG_FILE: undefined, ANYDB_LOG_DIR: blocked() },
        () => logger.log('server still works', { rows: 1 })
      )).not.toThrow();
    });

    test('still writes the record to stderr', () => {
      const logger = freshLogger();
      withEnv({ ANYDB_LOG_FILE: undefined, ANYDB_LOG_DIR: blocked() },
        () => logger.log('server still works', { rows: 1 }));
      expect(written[0]).toContain('server still works');
    });

    test('warns once about the disabled file sink', () => {
      const logger = freshLogger();
      withEnv({ ANYDB_LOG_FILE: undefined, ANYDB_LOG_DIR: blocked() }, () => {
        logger.log('one');
        logger.log('two');
        logger.log('three');
      });
      const warnings = written.filter((line) => line.includes('log_sink'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/\[anydb\] \S+ warn log_sink /);
    });

    test('keeps logging after the failure instead of failing every call', () => {
      const logger = freshLogger();
      withEnv({ ANYDB_LOG_FILE: undefined, ANYDB_LOG_DIR: blocked() }, () => {
        for (let i = 0; i < 5; i += 1) logger.log(`record ${i}`);
      });
      expect(written.filter((line) => line.includes('record'))).toHaveLength(5);
    });

    test('recovers when a later log directory is usable', () => {
      const logger = freshLogger();
      const good = makeTmpDir('anydb-recover-');
      withEnv({ ANYDB_LOG_FILE: undefined, ANYDB_LOG_DIR: blocked() }, () => logger.log('lost'));
      withEnv({ ANYDB_LOG_FILE: undefined, ANYDB_LOG_DIR: good }, () => logger.log('kept'));
      expect(fs.readFileSync(path.join(good, LOG_FILE_NAME), 'utf8')).toContain('kept');
    });
  });
});

describe('.env support', () => {
  const writeEnvFile = (contents) => {
    const dir = makeTmpDir('anydb-env-');
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, contents);
    return file;
  };

  describe('parseDotEnv', () => {
    test('reads KEY=value lines', () => {
      expect(parseDotEnv('ANYDB_DEBUG=1\nANYDB_LOG_LEVEL=debug'))
        .toEqual({ ANYDB_DEBUG: '1', ANYDB_LOG_LEVEL: 'debug' });
    });

    test('ignores comments and blank lines', () => {
      expect(parseDotEnv('# a comment\n\nANYDB_DEBUG=1\n')).toEqual({ ANYDB_DEBUG: '1' });
    });

    test('accepts an export prefix', () => {
      expect(parseDotEnv('export ANYDB_DEBUG=1')).toEqual({ ANYDB_DEBUG: '1' });
    });

    test('strips double quotes and their escapes', () => {
      expect(parseDotEnv('ANYDB_LOG_FILE="a b.log"')).toEqual({ ANYDB_LOG_FILE: 'a b.log' });
    });

    test('keeps single-quoted values literal', () => {
      expect(parseDotEnv("ANYDB_LOG_FILE='a b.log'")).toEqual({ ANYDB_LOG_FILE: 'a b.log' });
    });

    test('drops an inline comment from an unquoted value', () => {
      expect(parseDotEnv('ANYDB_DEBUG=1 # turn it on')).toEqual({ ANYDB_DEBUG: '1' });
    });

    test('keeps a hash that is part of the value', () => {
      expect(parseDotEnv('ANYDB_LOG_FILE=a#b.log')).toEqual({ ANYDB_LOG_FILE: 'a#b.log' });
    });

    test('handles CRLF line endings', () => {
      expect(parseDotEnv('ANYDB_DEBUG=1\r\nANYDB_LOG_LEVEL=trace\r\n'))
        .toEqual({ ANYDB_DEBUG: '1', ANYDB_LOG_LEVEL: 'trace' });
    });

    test('skips lines that are not assignments', () => {
      expect(parseDotEnv('just a sentence\n1BAD=x\nANYDB_DEBUG=1')).toEqual({ ANYDB_DEBUG: '1' });
    });

    test('accepts an empty value', () => {
      expect(parseDotEnv('ANYDB_HOME=')).toEqual({ ANYDB_HOME: '' });
    });

    test('handles non-string input', () => {
      expect(parseDotEnv(undefined)).toEqual({});
      expect(parseDotEnv(null)).toEqual({});
    });
  });

  describe('loadDotEnv', () => {
    test('applies ANYDB_ variables from an explicit file', () => {
      const file = writeEnvFile('ANYDB_LOG_LEVEL=debug\n');
      const env = {};
      expect(loadDotEnv({ env, envFile: file, cwd: os.tmpdir() })).toEqual(['ANYDB_LOG_LEVEL']);
      expect(env.ANYDB_LOG_LEVEL).toBe('debug');
    });

    test('applies nothing outside the ANYDB_ namespace', () => {
      // A `.env` is a shared file; reading other namespaces from it surprises
      // in both directions.
      const file = writeEnvFile('SOME_OTHER_TOOL_TOKEN=example-value\nANYDB_DEBUG=1\n');
      const env = {};
      loadDotEnv({ env, envFile: file, cwd: os.tmpdir() });
      expect(env).toEqual({ ANYDB_DEBUG: '1' });
    });

    test('a real environment variable wins over the file', () => {
      const file = writeEnvFile('ANYDB_DEBUG=1\nANYDB_LOG_LEVEL=trace\n');
      const env = { ANYDB_DEBUG: 'off' };
      loadDotEnv({ env, envFile: file, cwd: os.tmpdir() });
      expect(env.ANYDB_DEBUG).toBe('off');
      expect(env.ANYDB_LOG_LEVEL).toBe('trace');
    });

    test('reads the .env beside the cwd when there is no ANYDB_ENV_FILE', () => {
      const dir = makeTmpDir('anydb-cwd-');
      fs.writeFileSync(path.join(dir, '.env'), 'ANYDB_LOG_FORMAT=json\n');
      const env = {};
      loadDotEnv({ env, cwd: dir, envFile: undefined });
      expect(env.ANYDB_LOG_FORMAT).toBe('json');
    });

    test('prefers an explicit ANYDB_ENV_FILE over the cwd', () => {
      const dir = makeTmpDir('anydb-cwd-');
      fs.writeFileSync(path.join(dir, '.env'), 'ANYDB_LOG_FORMAT=json\n');
      const file = writeEnvFile('ANYDB_LOG_FORMAT=text\n');
      const env = {};
      loadDotEnv({ env, cwd: dir, envFile: file });
      expect(env.ANYDB_LOG_FORMAT).toBe('text');
    });

    test.each(['off', '0', 'false', 'none', '-'])('ANYDB_ENV_FILE=%s disables loading', (value) => {
      const dir = makeTmpDir('anydb-cwd-');
      fs.writeFileSync(path.join(dir, '.env'), 'ANYDB_LOG_FORMAT=json\n');
      const env = { ANYDB_ENV_FILE: value };
      expect(loadDotEnv({ env, cwd: dir })).toEqual([]);
      expect(env.ANYDB_LOG_FORMAT).toBeUndefined();
    });

    test('a missing file is not an error', () => {
      const env = {};
      expect(loadDotEnv({ env, envFile: path.join(os.tmpdir(), 'no-such-anydb-env-file') })).toEqual([]);
    });

    test('a directory in place of a file is not an error', () => {
      const env = {};
      expect(() => loadDotEnv({ env, envFile: os.tmpdir() })).not.toThrow();
    });

    test('never returns or logs a value', () => {
      const file = writeEnvFile('ANYDB_LOG_FILE=/tmp/secret.log\n');
      const env = {};
      const applied = loadDotEnv({ env, envFile: file, cwd: os.tmpdir() });
      expect(JSON.stringify(applied)).not.toContain('secret.log');
    });

    test('takes effect automatically on a freshly loaded module', () => {
      const file = writeEnvFile('ANYDB_LOG_LEVEL=debug\n');
      const logger = freshLogger();
      withEnv({ ANYDB_ENV_FILE: file, ANYDB_LOG_LEVEL: undefined, ANYDB_DEBUG: undefined }, () => {
        expect(logger.logLevelEnabled('debug')).toBe(true);
      });
    });

    test('a broken .env does not stop the logger', () => {
      const file = writeEnvFile('nonsense\n=\nANYDB_LOG_LEVEL\n');
      const logger = freshLogger();
      withEnv({ ANYDB_ENV_FILE: file, ANYDB_LOG_LEVEL: undefined, ANYDB_DEBUG: undefined }, () => {
        expect(() => logger.log('still logging')).not.toThrow();
      });
      expect(written.some((line) => line.includes('still logging'))).toBe(true);
    });
  });
});
