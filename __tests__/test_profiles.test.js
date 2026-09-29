import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ProfileStore,
  loadProfileStore,
  writeProfileStore,
  exportProfile,
  injectCredentials,
  stripCredentialFromUri,
  resolveConfigFile,
  resetProfileWarnings,
  CONFIG_BASENAME,
  PROFILE_SCHEMA_URL,
} from '../src/core/profiles.js';

// Every test runs against a throwaway home directory, and none reaches the network.
let root;
let homeBase;   // stands in for the user's home
let home;       // <homeBase>/.anydb, where resolveAnyDbPaths puts db.json
let warnings;

const makeEnv = (extra = {}) => ({ HOME: homeBase, USERPROFILE: homeBase, ...extra });

/**
 * A store pointed at the temporary home, with a captured logger.
 *
 * `env` is merged into a fresh object per call, so a test cannot see a variable
 * another test set. A `dir` moves the config home.
 */
function makeStore({ env = {}, platform = process.platform, dir, ...rest } = {}) {
  return new ProfileStore({
    platform,
    homedirFn: () => homeBase,
    log: (message, detail) => warnings.push({ message, detail }),
    ...rest,
    env: makeEnv(dir ? { ANYDB_HOME: dir, ...env } : env),
  });
}

/** Write a config file, given as a directory or as a path. */
function writeConfig(document, { dir = home, name = CONFIG_BASENAME, platform = process.platform } = {}) {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const file = impl.join(dir, name);
  mkdirSync(impl.dirname(file), { recursive: true });
  writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document, null, 2), 'utf8');
  return file;
}

/** A store already loaded from a freshly written config. */
function loaded(document, options = {}) {
  const file = writeConfig(document, options);
  const store = makeStore(options);
  store.load();
  return { file, store };
}

/** A store pointed at a freshly written config, but not loaded yet. */
function unloaded(document, options = {}) {
  const file = writeConfig(document, options);
  return { file, store: makeStore(options) };
}

/**
 * The error a config file that will not validate throws, or `null`. `loaded()` cannot
 * be used for a deliberately broken document: it calls `load()`, which throws.
 */
function captureLoadError(store) {
  try {
    store.load();
    return null;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'anydb-profiles-'));
  homeBase = path.join(root, 'home');
  home = path.join(homeBase, '.anydb');
  mkdirSync(home, { recursive: true });
  warnings = [];
  resetProfileWarnings();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loading a config file', () => {
  test('a valid file loads and the entries are validated', () => {
    const { store, file } = loaded({
      default: 'prod',
      profiles: {
        prod: {
          description: 'Production read-only reporting. Use for analytics questions.',
          driver: 'postgres',
          uri: 'postgres://readonly@db.example.com:5432/mydb',
          password: { env: 'DB_PASSWORD' },
          readOnly: true,
          maxRows: 1000,
          maxBytes: 262144,
          queryTimeoutMs: 30000,
          connectTimeoutMs: 5000,
          allowedSchemas: ['public'],
          allowedTables: [],
          hosts: ['db.example.com'],
          options: { application_name: 'anydb' },
        },
      },
    });

    expect(store.source).toBe(file);
    expect(store.names).toEqual(['prod']);
    expect(store.defaultName).toBe('prod');

    const entry = store.getEntry('prod');
    expect(entry.driver).toBe('postgres');
    expect(entry.readOnly).toBe(true);
    expect(entry.maxRows).toBe(1000);
    expect(entry.maxBytes).toBe(262144);
    expect(entry.queryTimeoutMs).toBe(30000);
    expect(entry.connectTimeoutMs).toBe(5000);
    expect(entry.allowedSchemas).toEqual(['public']);
    expect(entry.allowedTables).toEqual([]);
    expect(entry.hosts).toEqual(['db.example.com']);
    expect(entry.options).toEqual({ application_name: 'anydb' });
    // Still unresolved: getEntry never turns a reference into a secret.
    expect(entry.password).toEqual({ env: 'DB_PASSWORD' });
  });

  test('a missing file does not throw and leaves the store empty', () => {
    const store = makeStore();
    expect(() => store.load()).not.toThrow();
    expect(store.source).toBeNull();
    expect(store.names).toEqual([]);
    expect(store.defaultName).toBeNull();
    expect(store.list()).toEqual([]);
  });

  test('a missing file is a helpful error from getEntry, naming where it looked', () => {
    const store = makeStore();
    expect(() => store.getEntry('prod')).toThrow(/No profile named "prod"/);
    expect(() => store.getEntry('prod')).toThrow(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  test('malformed JSON names the file and says what is wrong', () => {
    const file = writeConfig('{ "profiles": { "a": }, }');
    const store = makeStore();
    expect(() => store.load()).toThrow(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: not valid JSON`));
  });

  test('load() is idempotent and reload() re-reads', () => {
    const { store, file } = loaded({ profiles: { local: { path: './data/app.db' } } });
    expect(store.load()).toBe(store);
    writeFileSync(file, JSON.stringify({ profiles: { other: { path: './x.db' } } }), 'utf8');
    expect(store.names).toEqual(['local']);
    store.reload();
    expect(store.names).toEqual(['other']);
  });

  test('an unreadable file is reported with the path, not the raw errno', () => {
    const { file } = loaded({ profiles: { a: { path: './a.db' } } });
    const store = makeStore({ fs: { ...require('node:fs'), readFileSync: () => { throw new Error('EACCES: denied'); } } });
    expect(() => store.load()).toThrow(new RegExp(`Could not read the anydb config at ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});

describe('validation', () => {
  const expectRejected = (document, pattern) => {
    const { store, file } = unloaded(document);
    let thrown = null;
    try {
      store.load();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    // Every rejection names the file and the JSON pointer of the bad field.
    expect(thrown.message).toContain(file);
    expect(thrown.message).toMatch(pattern);
  };

  test('profiles must be present and an object', () => {
    expectRejected({ $schema: PROFILE_SCHEMA_URL }, /: profiles is required/);
    expectRejected({ profiles: [] }, /: profiles is required/);
    expectRejected({ profiles: 'x' }, /: profiles is required/);
  });

  test('the root must be an object', () => {
    expectRejected([], /\(root\) must be an object, got array/);
    expectRejected(null, /\(root\) must be an object, got null/);
  });

  test('a profile must be an object', () => {
    expectRejected({ profiles: { a: 'postgres://x' } }, /profiles\.a must be an object, got string/);
    expectRejected({ profiles: { a: ['x'] } }, /profiles\.a must be an object, got array/);
  });

  test('an empty profile name is refused', () => {
    expectRejected({ profiles: { '': { path: './a.db' } } }, /has a profile with an empty name/);
  });

  test.each(['__proto__', 'constructor', 'prototype'])('%s cannot be a profile name', (name) => {
    expectRejected({ profiles: { [name]: { path: './a.db' } } }, /is a reserved name/);
  });

  test('driver must be one of the supported set', () => {
    expectRejected(
      { profiles: { a: { driver: 'cassandra', path: './a.db' } } },
      /profiles\.a\.driver must be one of .*got "cassandra"/
    );
    expectRejected({ profiles: { a: { driver: 7, path: './a.db' } } }, /profiles\.a\.driver must be a string, got number/);
  });

  test('uri must contain a scheme', () => {
    expectRejected({ profiles: { a: { uri: 'db.example.com/mydb' } } }, /profiles\.a\.uri must be a connection string containing/);
  });

  test('uri must use a supported scheme', () => {
    expectRejected(
      { profiles: { a: { uri: 'ftp://files.example.com/x' } } },
      /profiles\.a\.uri scheme "ftp" is not supported/
    );
  });

  test.each([
    'postgres', 'postgresql', 'mysql', 'mariadb', 'sqlite', 'mongodb', 'redis', 'rediss',
    'mongodb+srv', 'mysql+pymysql', 'mysql+mysqldb', 'mysql+asyncmy', 'mysql+aiohttp', 'sqlite+pysqlite',
  ])('accepts %s as a uri scheme', (scheme) => {
    const { store } = loaded({ profiles: { a: { uri: `${scheme}://host/db` } } });
    expect(() => store.load()).not.toThrow();
  });

  test('accepts a sqlite:// uri as an alternative to path', () => {
    const { store } = loaded({ profiles: { a: { uri: 'sqlite:///data/app.db' } } });
    expect(store.getEntry('a').uri).toBe('sqlite:///data/app.db');
  });

  test('path must be a non-empty string', () => {
    expectRejected({ profiles: { a: { path: '   ' } } }, /profiles\.a\.path must be a non-empty string/);
    expectRejected({ profiles: { a: { path: 7 } } }, /profiles\.a\.path must be a non-empty string/);
  });

  test('a profile with neither uri nor path is refused', () => {
    expectRejected(
      { profiles: { a: { description: 'nothing to connect to' } } },
      /profiles\.a must have either "uri" or "path"/
    );
  });

  test('path with a non-sqlite driver is refused', () => {
    expectRejected(
      { profiles: { a: { driver: 'postgres', path: './a.db' } } },
      /profiles\.a\.path is a SQLite field but the driver is "postgres"/
    );
  });

  test('a password on a SQLite profile is refused', () => {
    expectRejected(
      { profiles: { a: { path: './a.db', password: 'secret' } } },
      /profiles\.a\.password is meaningless for a SQLite file/
    );
  });

  test('description must be a string', () => {
    expectRejected({ profiles: { a: { path: './a.db', description: 42 } } }, /profiles\.a\.description must be a string, got number/);
  });

  test('a long description is truncated, not refused', () => {
    const { store } = loaded({ profiles: { a: { path: './a.db', description: 'x'.repeat(900) } } });
    expect(store.getEntry('a').description).toHaveLength(500);
    expect(warnings.some((w) => /truncated/.test(w.message))).toBe(true);
  });

  test('control characters in a description are dropped, tab and newline survive', () => {
    const bell = String.fromCharCode(7);
    const escape = String.fromCharCode(27);
    const del = String.fromCharCode(127);
    const { store } = loaded({ profiles: { a: { path: './a.db', description: `a${bell}b${escape}c${del}d\te\nf` } } });
    expect(store.getEntry('a').description).toBe('a b c d\te\nf');
  });

  test('readOnly must be a boolean', () => {
    expectRejected({ profiles: { a: { path: './a.db', readOnly: 'yes' } } }, /profiles\.a\.readOnly must be true or false, got "yes"/);
  });

  test('allowDestructive must be a boolean', () => {
    expectRejected({ profiles: { a: { path: './a.db', allowDestructive: 1 } } }, /profiles\.a\.allowDestructive must be true or false/);
  });

  test.each(['maxRows', 'maxBytes', 'queryTimeoutMs', 'connectTimeoutMs'])('%s must be a finite positive integer', (field) => {
    const at = new RegExp(`profiles\\.a\\.${field}`);
    expectRejected({ profiles: { a: { path: './a.db', [field]: 0 } } }, new RegExp(`${at.source} must be at least 1`));
    expectRejected({ profiles: { a: { path: './a.db', [field]: -5 } } }, new RegExp(`${at.source} must be at least 1`));
    expectRejected({ profiles: { a: { path: './a.db', [field]: 1.5 } } }, new RegExp(`${at.source} must be an integer`));
    expectRejected({ profiles: { a: { path: './a.db', [field]: '100' } } }, new RegExp(`${at.source} must be a finite number`));
  });

  test('timeouts above the registry maximum are refused, matching registry.js', () => {
    expectRejected(
      { profiles: { a: { path: './a.db', queryTimeoutMs: 86400001 } } },
      /profiles\.a\.queryTimeoutMs must be at most 86400000/
    );
    expectRejected(
      { profiles: { a: { path: './a.db', connectTimeoutMs: 60001 } } },
      /profiles\.a\.connectTimeoutMs must be at most 60000/
    );
  });

  test('the 1 ms floor matches registry.js MIN_TIMEOUT', () => {
    const { store } = loaded({ profiles: { a: { path: './a.db', queryTimeoutMs: 1 } } });
    expect(store.getEntry('a').queryTimeoutMs).toBe(1);
  });

  test('maxRows above the cap is clamped with a warning', () => {
    const { store } = loaded({ profiles: { a: { path: './a.db', maxRows: 50000000 } } });
    expect(store.getEntry('a').maxRows).toBe(1000000);
    expect(warnings.some((w) => /clamped/.test(w.message))).toBe(true);
  });

  test('maxBytes above the cap is clamped', () => {
    const { store } = loaded({ profiles: { a: { path: './a.db', maxBytes: 1e12 } } });
    expect(store.getEntry('a').maxBytes).toBe(67108864);
  });

  test.each(['allowedSchemas', 'allowedTables', 'hosts', 'allowedPaths'])('%s must be an array of non-empty strings', (field) => {
    const at = new RegExp(`profiles\\.a\\.${field}`);
    expectRejected({ profiles: { a: { path: './a.db', [field]: 'public' } } }, new RegExp(`${at.source} must be an array of strings, got string`));
    expectRejected({ profiles: { a: { path: './a.db', [field]: ['ok', 7] } } }, new RegExp(`${at.source}\\[1\\] must be a non-empty string`));
    expectRejected({ profiles: { a: { path: './a.db', [field]: [''] } } }, new RegExp(`${at.source}\\[0\\] must be a non-empty string`));
  });

  test('an over-long name in a list is refused', () => {
    expectRejected(
      { profiles: { a: { path: './a.db', allowedTables: ['t'.repeat(300)] } } },
      /profiles\.a\.allowedTables\[0\] must be at most 256 characters/
    );
  });

  test('an over-long list is truncated with a warning', () => {
    const { store } = loaded({
      profiles: { a: { path: './a.db', allowedTables: Array.from({ length: 500 }, (_, i) => `t${i}`) } },
    });
    expect(store.getEntry('a').allowedTables).toHaveLength(128);
    expect(warnings.some((w) => /list was truncated/.test(w.message))).toBe(true);
  });

  test('options must be a flat object of scalars', () => {
    expectRejected({ profiles: { a: { path: './a.db', options: 'x' } } }, /profiles\.a\.options must be an object/);
    expectRejected(
      { profiles: { a: { path: './a.db', options: { nested: {} } } } },
      /profiles\.a\.options\.nested must be a string, number or boolean/
    );
  });

  test('default must name a profile that exists', () => {
    expectRejected({ default: 7, profiles: { a: { path: './a.db' } } }, /: default must be a profile name as a string, got number/);
    expectRejected(
      { default: 'missing', profiles: { a: { path: './a.db' } } },
      /: default names "missing", which is not in profiles. Available: a/
    );
  });

  test('an unknown top-level key is ignored, not refused', () => {
    const { store } = loaded({
      $schema: PROFILE_SCHEMA_URL,
      profiles: { a: { path: './a.db' } },
      futureThing: 1,
    });
    expect(() => store.load()).not.toThrow();
    expect(warnings.some((w) => w.message.includes('unrecognised top-level key'))).toBe(true);
  });
});

describe('unknown keys are a warning, not a failure', () => {
  test('a key from a newer version is collected, warned about and dropped', () => {
    const { store } = loaded({
      profiles: { a: { path: './a.db', connectionPool: { size: 5 }, futureFlag: true } },
    });

    const entry = store.getEntry('a');
    expect(entry.connectionPool).toBeUndefined();
    expect(entry.futureFlag).toBeUndefined();
    expect(Object.keys(entry).sort()).toEqual(['name', 'path']);

    const warning = warnings.find((w) => w.message.includes('unrecognised profile keys'));
    expect(warning).toBeDefined();
    expect(warning.detail.keys).toBe('connectionPool, futureFlag');
    // A config written for a newer version still loads, which is the point.
    expect(store.names).toEqual(['a']);
  });
});

describe('default handling', () => {
  test('an explicit default is reported and listed first', () => {
    const { store } = loaded({
      default: 'b',
      profiles: { a: { path: './a.db' }, b: { path: './b.db' } },
    });
    expect(store.defaultName).toBe('b');
    expect(store.list().map((row) => row.name)).toEqual(['b', 'a']);
    expect(store.list()[0].default).toBe(true);
    expect(store.list()[1].default).toBe(false);
  });

  test('a file with no default still loads', () => {
    const { store } = loaded({ profiles: { a: { path: './a.db' } } });
    expect(store.defaultName).toBeNull();
    expect(store.list().every((row) => row.default === false)).toBe(true);
  });
});

describe('path resolution', () => {
  test('a relative SQLite path resolves against the config file directory', () => {
    const { store } = loaded({ profiles: { a: { path: './data/app.db' } } });
    expect(store.getEntry('a').path).toBe(path.join(home, 'data', 'app.db'));
  });

  test('an absolute path is left alone', () => {
    const absolute = path.join(root, 'elsewhere.db');
    const { store } = loaded({ profiles: { a: { path: absolute } } });
    expect(store.getEntry('a').path).toBe(absolute);
  });

  test('a parent-relative path is normalised against the config directory', () => {
    const { store } = loaded({ profiles: { a: { path: '../shared/app.db' } } });
    expect(store.getEntry('a').path).toBe(path.resolve(home, '..', 'shared', 'app.db'));
  });

  test('allowedPaths are resolved the same way', () => {
    const { store } = loaded({ profiles: { a: { path: './a.db', allowedPaths: ['./data'] } } });
    expect(store.getEntry('a').allowedPaths).toEqual([path.join(home, 'data')]);
  });

  test('a Windows path resolves with Windows rules', () => {
    const dir = path.win32.join(root, 'win');
    const { store } = loaded({ profiles: { a: { path: './data/app.db' } } }, { dir, platform: 'win32' });
    expect(store.getEntry('a').path).toBe(path.win32.resolve(dir, './data/app.db'));
  });
});

describe('file resolution order', () => {
  test('ANYDB_CONFIG wins over the home directory', () => {
    const other = path.join(root, 'explicit.json');
    writeFileSync(other, JSON.stringify({ profiles: { explicit: { path: './e.db' } } }), 'utf8');
    writeConfig({ profiles: { local: { path: './l.db' } } });

    const store = makeStore({ env: { ANYDB_CONFIG: other } });
    store.load();
    expect(store.source).toBe(path.resolve(other));
    expect(store.names).toEqual(['explicit']);
  });

  test('ANYDB_HOME moves the default config file', () => {
    const moved = path.join(root, 'anydb-home');
    mkdirSync(moved, { recursive: true });
    writeFileSync(path.join(moved, 'db.json'), JSON.stringify({ profiles: { moved: { path: './m.db' } } }), 'utf8');

    const store = makeStore({ env: { ANYDB_HOME: moved } });
    store.load();
    expect(store.names).toEqual(['moved']);
  });

  test('ANYDB_CONFIG still wins over ANYDB_HOME', () => {
    const moved = path.join(root, 'anydb-home');
    const explicit = path.join(root, 'explicit.json');
    mkdirSync(moved, { recursive: true });
    writeFileSync(path.join(moved, 'db.json'), JSON.stringify({ profiles: { moved: { path: './m.db' } } }), 'utf8');
    writeFileSync(explicit, JSON.stringify({ profiles: { explicit: { path: './e.db' } } }), 'utf8');

    const store = makeStore({ env: { ANYDB_HOME: moved, ANYDB_CONFIG: explicit } });
    store.load();
    expect(store.names).toEqual(['explicit']);
  });

  test('a relative ANYDB_CONFIG is resolved to an absolute path', () => {
    const other = path.join(root, 'explicit.json');
    writeFileSync(other, JSON.stringify({ profiles: { explicit: { path: './e.db' } } }), 'utf8');
    const store = makeStore({ env: { ANYDB_CONFIG: other } });
    expect(store.resolveConfigFile()).toBe(other);
  });

  test('the XDG location is a fallback, used only when the default is absent', () => {
    const xdg = path.join(root, 'xdg');
    const xdgFile = path.join(xdg, 'anydb', 'db.json');
    mkdirSync(path.dirname(xdgFile), { recursive: true });
    writeFileSync(xdgFile, JSON.stringify({ profiles: { xdg: { path: './x.db' } } }), 'utf8');

    const store = makeStore({ env: { XDG_CONFIG_HOME: xdg } });
    store.load();
    expect(store.names).toEqual(['xdg']);
    expect(store.source).toBe(xdgFile);

    // Once the default location exists it wins, so a stale XDG copy cannot
    // shadow the file the operator actually wrote.
    writeConfig({ profiles: { local: { path: './l.db' } } });
    const second = makeStore({ env: { XDG_CONFIG_HOME: xdg } });
    second.load();
    expect(second.names).toEqual(['local']);
  });

  test('resolveConfigFile reports where it would look, for either platform', () => {
    // A missing ANYDB_CONFIG target is announced on stderr rather than thrown,
    // so the notice is captured rather than left in the test output.
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveConfigFile({ env: {}, platform: 'linux', homedirFn: () => '/home/tester' }))
        .toBe('/home/tester/.anydb/db.json');
      expect(resolveConfigFile({ env: {}, platform: 'win32', homedirFn: () => 'C:\\Users\\tester' }))
        .toBe('C:\\Users\\tester\\.anydb\\db.json');
      expect(resolveConfigFile({ env: { ANYDB_CONFIG: '/etc/anydb/db.json' }, platform: 'linux', homedirFn: () => '/home/tester' }))
        .toBe('/etc/anydb/db.json');
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('ANYDB_CONFIG points at /etc/anydb/db.json'));
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('list() is what the model sees', () => {
  test('it carries names and no credentials, hosts or paths', () => {
    const { store } = loaded({
      default: 'prod',
      profiles: {
        prod: {
          description: 'Production reporting.',
          driver: 'postgres',
          uri: 'postgres://app:s3cr3t@db.internal:5432/mydb',
          password: { env: 'DB_PASSWORD' },
        },
        local: { description: 'Dev SQLite.', driver: 'sqlite', path: './data/app.db', readOnly: false },
      },
    });

    const listed = store.list();
    expect(listed).toEqual([
      { name: 'prod', description: 'Production reporting.', driver: 'postgres', default: true, readOnly: true },
      { name: 'local', description: 'Dev SQLite.', driver: 'sqlite', default: false, readOnly: false },
    ]);

    const serialised = JSON.stringify(listed);
    expect(serialised).not.toContain('s3cr3t');
    expect(serialised).not.toContain('DB_PASSWORD');
    expect(serialised).not.toContain('postgres://');
    expect(serialised).not.toContain('db.internal');
    expect(serialised).not.toContain('app.db');
    for (const row of listed) {
      expect(Object.keys(row).sort()).toEqual(['default', 'description', 'driver', 'name', 'readOnly']);
    }
  });

  test('a missing description is an empty string and a missing driver is null', () => {
    const { store } = loaded({ profiles: { a: { path: './a.db' } } });
    expect(store.list()[0]).toEqual({ name: 'a', description: '', driver: null, default: false, readOnly: true });
  });

  test('the order is stable between calls', () => {
    const { store } = loaded({ profiles: { b: { path: './b.db' }, a: { path: './a.db' }, c: { path: './c.db' } } });
    expect(store.list().map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(store.list().map((r) => r.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('getEntry', () => {
  test('lists the valid names when one is missing', () => {
    const { store } = loaded({ profiles: { prod: { path: './p.db' }, local: { path: './l.db' } } });
    expect(() => store.getEntry('production')).toThrow(/Available profiles: prod, local/);
  });

  test('has() does not throw for a missing profile', () => {
    const { store } = loaded({ profiles: { local: { path: './l.db' } } });
    expect(store.has('local')).toBe(true);
    expect(store.has('nope')).toBe(false);
  });
});

describe('injectCredentials', () => {
  test('adds a password to a URI that has a username', () => {
    expect(injectCredentials('postgres://app@db.internal:5432/mydb', 'pw'))
      .toBe('postgres://app:pw@db.internal:5432/mydb');
  });

  test('replaces the password in mongodb+srv://user@host', () => {
    expect(injectCredentials('mongodb+srv://user@cluster.example.com/mydb', 'pw'))
      .toBe('mongodb+srv://user:pw@cluster.example.com/mydb');
  });

  test('keeps the empty username form Redis ACLs use', () => {
    expect(injectCredentials('redis://:old@cache.internal:6379', 'new'))
      .toBe('redis://:new@cache.internal:6379');
  });

  test('uses a supplied username when the URI has no userinfo', () => {
    expect(injectCredentials('postgres://db.internal:5432/mydb', 'pw', 'app'))
      .toBe('postgres://app:pw@db.internal:5432/mydb');
  });

  test('refuses a URI with no userinfo and no username to add', () => {
    expect(() => injectCredentials('postgres://db.internal:5432/mydb', 'pw')).toThrow(/has no username/);
  });

  test('percent-encodes a password containing URI delimiters', () => {
    expect(injectCredentials('postgres://app@host/db', 'a@b:c/d'))
      .toBe('postgres://app:a%40b%3Ac%2Fd@host/db');
  });

  test('an @ inside the password does not move the host boundary', () => {
    expect(injectCredentials('postgres://app@host/db', 'p@ss')).toBe('postgres://app:p%40ss@host/db');
  });

  test('an empty password is a no-op', () => {
    expect(injectCredentials('postgres://app@host/db', '')).toBe('postgres://app@host/db');
    expect(injectCredentials('postgres://app@host/db', undefined)).toBe('postgres://app@host/db');
    expect(injectCredentials('postgres://app@host/db', null)).toBe('postgres://app@host/db');
  });

  test('the query string survives the injection', () => {
    expect(injectCredentials('mysql://app@host:3306/db?ssl=true', 'pw'))
      .toBe('mysql://app:pw@host:3306/db?ssl=true');
  });

  test('rejects something that is not a connection string', () => {
    expect(() => injectCredentials('nonsense', 'pw')).toThrow(/expected a connection string/);
    expect(() => injectCredentials('', 'pw')).toThrow(/needs a connection string/);
  });

  test('a non-string password is a programming error, not a crash', () => {
    expect(() => injectCredentials('postgres://app@host/db', 42)).toThrow(/needs the password as a string/);
  });
});

describe('stripCredentialFromUri', () => {
  test('removes the userinfo password and reports it', () => {
    expect(stripCredentialFromUri('postgres://app:s3cr3t@host:5432/db'))
      .toEqual({ uri: 'postgres://app@host:5432/db', password: 's3cr3t' });
  });

  test('removes a credential query parameter and keeps the rest', () => {
    expect(stripCredentialFromUri('redis://host:6379?password=hunter2&db=3'))
      .toEqual({ uri: 'redis://host:6379?db=3', password: 'hunter2' });
  });

  test('removes every credential parameter', () => {
    const { uri } = stripCredentialFromUri('mongodb://host/db?authSource=admin&sslpassword=abc&tls=true');
    expect(uri).toBe('mongodb://host/db?authSource=admin&tls=true');
  });

  test('leaves a URI with no credential alone', () => {
    expect(stripCredentialFromUri('postgres://app@host/db')).toEqual({ uri: 'postgres://app@host/db', password: null });
  });

  test('an @ inside the password is not mistaken for the authority separator', () => {
    const stripped = stripCredentialFromUri('postgres://app:p%40ss@host/db');
    expect(stripped.uri).toBe('postgres://app@host/db');
    expect(stripped.password).toBe('p@ss');
  });
});

describe('toUri', () => {
  test('a SQLite profile becomes an sqlite:// URI', () => {
    const { store } = loaded({ profiles: { a: { path: './data/app.db' } } });
    const expected = process.platform === 'win32'
      ? `sqlite:///${path.join(home, 'data', 'app.db').replace(/\\/g, '/')}`
      : `sqlite://${path.join(home, 'data', 'app.db')}`;
    expect(store.toUri(store.getEntry('a'))).toBe(expected);
  });

  // A drive letter only exists on a Windows filesystem, and building the
  // fixture needs one: `writeConfig` writes the file, and with `platform:
  // 'win32'` over a POSIX temp dir the result is a path with no drive, so
  // `path.win32.resolve` falls back to the real working directory and the
  // assertion compares two unrelated strings. The rule under test is host
  // independent and is covered by the two tests above; this one checks the
  // drive-letter spelling, which cannot be checked off Windows.
  const onWindows = process.platform === 'win32' ? test : test.skip;

  onWindows('a Windows SQLite path keeps the slash before the drive letter', () => {
    const dir = path.win32.join(root, 'win');
    const { store } = loaded({ profiles: { a: { path: './data/app.db' } } }, { dir, platform: 'win32' });
    const uri = store.toUri(store.getEntry('a'));
    // Three slashes, then a drive letter: what `sqlite.js` expects.
    expect(uri).toBe(`sqlite:///${path.win32.resolve(dir, './data/app.db').replace(/\\/g, '/')}`);
  });

  test('the password never appears', () => {
    const { store } = loaded({ profiles: { a: { uri: 'postgres://app:s3cr3t@db.internal:5432/mydb' } } });
    expect(store.toUri(store.getEntry('a'))).toBe('postgres://app@db.internal:5432/mydb');
  });

  test('a name is accepted as well as an entry', () => {
    const { store } = loaded({ profiles: { a: { uri: 'postgres://app@h/db' } } });
    expect(store.toUri('a')).toBe('postgres://app@h/db');
  });
});

describe('writing a config file', () => {
  const writeOptions = () => ({ env: makeEnv(), platform: process.platform });

  test('writeProfileStore round-trips through a ProfileStore', async () => {
    const document = {
      $schema: PROFILE_SCHEMA_URL,
      default: 'local',
      profiles: { local: { driver: 'sqlite', path: './data/app.db', readOnly: true } },
    };
    const target = path.join(root, 'out', 'db.json');
    const file = await writeProfileStore(target, document, writeOptions());

    expect(file).toBe(target);
    // 2-space indent and a trailing newline, so the file diffs cleanly.
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(document, null, 2)}\n`);

    const store = makeStore({ env: { ANYDB_CONFIG: file } });
    store.load();
    expect(store.names).toEqual(['local']);
    expect(store.defaultName).toBe('local');
    expect(store.getEntry('local').path).toBe(path.join(root, 'out', 'data', 'app.db'));
  });

  test('a directory target gets db.json appended', async () => {
    const dir = path.join(root, 'dir-target');
    mkdirSync(dir, { recursive: true });
    const file = await writeProfileStore(dir, { profiles: { a: { path: './a.db' } } }, writeOptions());
    expect(file).toBe(path.join(dir, 'db.json'));
  });

  test('the file is 0600 and the directory 0700', async () => {
    const target = path.join(root, 'modes', 'db.json');
    const file = await writeProfileStore(target, { profiles: { a: { path: './a.db' } } }, writeOptions());
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(file)).toBe(true);
  });

  test('the write is atomic: only the target is left behind', async () => {
    const target = path.join(root, 'atomic', 'db.json');
    const file = await writeProfileStore(target, { profiles: { a: { path: './a.db' } } }, writeOptions());
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  test('a failed serialisation leaves the previous file intact and no temp file', async () => {
    const target = path.join(root, 'existing', 'db.json');
    const document = { profiles: { a: { path: './a.db' } } };
    await writeProfileStore(target, document, writeOptions());

    const circular = {};
    circular.self = circular;
    await expect(writeProfileStore(target, circular, writeOptions())).rejects.toThrow();
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(document);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  test('the contents are never logged', async () => {
    const target = path.join(root, 'quiet', 'db.json');
    await writeProfileStore(target, { profiles: { a: { path: './a.db' } } }, writeOptions());
    expect(JSON.stringify(warnings)).not.toContain('profiles');
  });

  test('exportProfile adds a profile and keeps the rest of the file', async () => {
    const target = path.join(root, 'exported', 'db.json');
    await writeProfileStore(target, { profiles: { existing: { path: './existing.db' } }, default: 'existing' }, writeOptions());

    const result = await exportProfile('prod', {
      description: 'Production.',
      driver: 'postgres',
      uri: 'postgres://app@db.internal:5432/mydb',
      password: { env: 'DB_PASSWORD' },
    }, { ...writeOptions(), file: target });

    expect(result.file).toBe(target);
    expect(Object.keys(result.document.profiles)).toEqual(['existing', 'prod']);
    expect(result.document.default).toBe('existing');

    const store = makeStore({ env: { ANYDB_CONFIG: target } });
    store.load();
    expect(store.names).toEqual(['existing', 'prod']);
  });

  test('the first exported profile becomes the default', async () => {
    const target = path.join(root, 'first', 'db.json');
    const { document } = await exportProfile('only', { path: './only.db' }, { ...writeOptions(), file: target });
    expect(document.default).toBe('only');
  });

  test('exportProfile refuses to write something load() would reject', async () => {
    const target = path.join(root, 'rejected', 'db.json');
    await expect(exportProfile('bad', { description: 'no connection' }, { ...writeOptions(), file: target }))
      .rejects.toThrow(/must have either "uri" or "path"/);
    expect(existsSync(target)).toBe(false);
  });

  test('exportProfile can replace an existing profile in place', async () => {
    const target = path.join(root, 'replace', 'db.json');
    await writeProfileStore(target, { profiles: { a: { path: './a.db' } } }, writeOptions());
    await exportProfile('a', { path: './b.db' }, { ...writeOptions(), file: target });
    const document = JSON.parse(readFileSync(target, 'utf8'));
    expect(Object.keys(document.profiles)).toEqual(['a']);
    expect(document.profiles.a.path).toBe('./b.db');
  });

  test('exportProfile refuses a reserved name', async () => {
    const target = path.join(root, 'reserved', 'db.json');
    await expect(exportProfile('__proto__', { path: './a.db' }, { ...writeOptions(), file: target }))
      .rejects.toThrow(/reserved name/);
  });
});

describe('credential references', () => {
  const SECRET = 'sup3r-s3cret-value';

  /** A loaded store whose single profile `a` points at db.internal with `password`. */
  const withPassword = (password) => loaded({
    profiles: { a: { uri: 'postgres://app@db.internal:5432/mydb', password } },
  }).store;

  describe('env', () => {
    test('reads the named variable', async () => {
      const store = withPassword({ env: 'DB_PASSWORD' });
      const { uri } = await store.resolve('a', { env: { DB_PASSWORD: SECRET } });
      expect(uri).toBe(`postgres://app:${SECRET}@db.internal:5432/mydb`);
    });

    test('an unset variable is an error naming the variable and the profile', async () => {
      const store = withPassword({ env: 'DB_PASSWORD' });
      await expect(store.resolve('a', { env: {} })).rejects.toThrow(/profile "a": password\.env is "DB_PASSWORD"/);
    });

    test('an empty variable is treated as unset, never as an empty password', async () => {
      const store = withPassword({ env: 'DB_PASSWORD' });
      await expect(store.resolve('a', { env: { DB_PASSWORD: '' } })).rejects.toThrow(/unset or empty/);
    });

    test('it never falls back to a literal stored beside it', async () => {
      const store = withPassword({ env: 'MISSING_VAR' });
      await expect(store.resolve('a', { env: { OTHER: 'x' } })).rejects.toThrow(/MISSING_VAR/);
    });
  });

  describe('file', () => {
    test('reads the file and trims one trailing newline', async () => {
      const file = path.join(root, 'db-password');
      writeFileSync(file, `${SECRET}\n`, 'utf8');
      const store = withPassword({ file });
      const { uri } = await store.resolve('a', { env: {} });
      expect(uri).toBe(`postgres://app:${SECRET}@db.internal:5432/mydb`);
    });

    test('only one newline is trimmed', async () => {
      const file = path.join(root, 'two-newlines');
      writeFileSync(file, 'line\n\n', 'utf8');
      const store = withPassword({ file });
      const { uri } = await store.resolve('a', { env: {} });
      expect(uri).toBe('postgres://app:line%0A@db.internal:5432/mydb');
    });

    test('a missing file is an error naming the path', async () => {
      const missing = path.join(root, 'not-here');
      const store = withPassword({ file: missing });
      await expect(store.resolve('a', { env: {} }))
        .rejects.toThrow(new RegExp(`password\\.file "${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" could not be opened`));
    });

    test('a directory is refused', async () => {
      const store = withPassword({ file: home });
      await expect(store.resolve('a', { env: {} })).rejects.toThrow(/is not a regular file/);
    });

    test('an oversized file is refused on its size alone', async () => {
      const big = path.join(root, 'big');
      writeFileSync(big, 'x'.repeat(64 * 1024 + 1), 'utf8');
      const store = withPassword({ file: big });
      await expect(store.resolve('a', { env: {} })).rejects.toThrow(/over the 65536 byte limit/);
    });

    test('a group-readable file warns but still works', async () => {
      if (process.platform === 'win32') return; // permission bits are not modelled there
      const file = path.join(root, 'loose');
      writeFileSync(file, SECRET, 'utf8');
      const store = withPassword({ file });
      const { uri } = await store.resolve('a', { env: {} });
      expect(uri).toBe(`postgres://app:${SECRET}@db.internal:5432/mydb`);
      const warning = warnings.find((w) => w.message.includes('readable beyond its owner'));
      expect(warning).toBeDefined();
      expect(warning.detail.hint).toMatch(/chmod 0400/);
    });
  });

  describe('exec', () => {
    test('runs a real command and trims the trailing newline', async () => {
      const store = withPassword({ exec: [process.execPath, '-e', `process.stdout.write("${SECRET}\\n")`] });
      const { uri } = await store.resolve('a', { env: {} });
      expect(uri).toBe(`postgres://app:${SECRET}@db.internal:5432/mydb`);
    });

    test('shell metacharacters in an argument arrive verbatim, so execFile is not a shell', async () => {
      const marker = path.join(root, 'pwned');
      const canary = `$(node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','x')") && echo boom; whoami`;
      const store = withPassword({ exec: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(canary)})`] });

      const { uri } = await store.resolve('a', { env: {} });
      expect(uri).toBe(`postgres://app:${encodeURIComponent(canary)}@db.internal:5432/mydb`);
      // If a shell had been involved, this file would exist.
      expect(existsSync(marker)).toBe(false);
    });

    test('a semicolon in the output does not start a second command', async () => {
      const store = withPassword({ exec: [process.execPath, '-e', 'process.stdout.write("a; echo pwned")'] });
      const { uri } = await store.resolve('a', { env: {} });
      expect(uri).toBe('postgres://app:a%3B%20echo%20pwned@db.internal:5432/mydb');
    });

    test('a non-zero exit is a clear error that does not quote the output', async () => {
      // The helper reads the secret from a file, so it is the helper's *stderr* that carries
      // it, and `execFile` puts captured stderr in `error.message`.
      const helper = path.join(root, 'fail.js');
      const secretFile = path.join(root, 'fail-secret');
      writeFileSync(secretFile, SECRET, 'utf8');
      writeFileSync(helper, 'process.stderr.write(require("fs").readFileSync(process.argv[2], "utf8")); process.exit(3);\n', 'utf8');

      const store = withPassword({ exec: [process.execPath, helper, secretFile] });
      const error = await store.resolve('a', { env: {} }).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/exited with code 3/);
      expect(error.message).not.toContain(SECRET);
    });

    test('a missing program says so rather than leaking the message', async () => {
      const store = withPassword({ exec: ['anydb-no-such-program-xyz', 'arg'] });
      await expect(store.resolve('a', { env: {} })).rejects.toThrow(/not found on PATH/);
    });

    test('a slow command is stopped at the timeout', async () => {
      const store = withPassword({ exec: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 400 });
      const started = Date.now();
      const error = await store.resolve('a', { env: {} }).catch((e) => e);
      expect(error.message).toMatch(/did not finish within 400ms/);
      expect(Date.now() - started).toBeLessThan(20000);
    });

    test('an injected execFile receives an argv array and a timeout, never a shell string', async () => {
      const calls = [];
      const store = withPassword({ exec: ['helper', 'read', 'op://vault/db/pw'] });
      await store.resolve('a', {
        env: {},
        execFile: (file, args, options, callback) => {
          calls.push({ file, args, options });
          callback(null, 'from-injected\n');
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe('helper');
      expect(calls[0].args).toEqual(['read', 'op://vault/db/pw']);
      expect(calls[0].options).toMatchObject({ timeout: 5000, maxBuffer: 1048576, encoding: 'utf8', windowsHide: true });
      expect(calls[0].options.shell).toBeUndefined();
    });
  });

  describe('keychain', () => {
    test('uses an injected provider when there is one', async () => {
      const store = withPassword({ keychain: 'anydb/db-prod', account: 'readonly' });
      const seen = [];
      const { uri } = await store.resolve('a', {
        env: {},
        keychainProvider: (service, account) => {
          seen.push([service, account]);
          return Promise.resolve(SECRET);
        },
      });
      expect(uri).toBe(`postgres://app:${SECRET}@db.internal:5432/mydb`);
      expect(seen).toEqual([['anydb/db-prod', 'readonly']]);
    });

    test('a provider that throws is reported without its message', async () => {
      const store = withPassword({ keychain: 'anydb/db-prod' });
      const error = await store.resolve('a', {
        env: {},
        keychainProvider: () => Promise.reject(Object.assign(new Error(`boom ${SECRET}`), { code: 'ENOENT' })),
      }).catch((e) => e);
      expect(error.message).toMatch(/the keychain provider failed for anydb\/db-prod/);
      expect(error.message).not.toContain(SECRET);
    });

    test('a provider that returns nothing is an error, not an empty password', async () => {
      const store = withPassword({ keychain: 'anydb/db-prod' });
      await expect(store.resolve('a', { env: {}, keychainProvider: () => Promise.resolve('') }))
        .rejects.toThrow(/returned no value/);
    });

    test('without a provider it names the environment variable to set', async () => {
      const store = withPassword({ keychain: 'anydb/db-prod' });
      const error = await store.resolve('a', { env: {} }).catch((e) => e);
      expect(error.message).toMatch(/ANYDB_KEYCHAIN_CMD/);
      expect(error.message).toMatch(/\{service\}/);
      expect(error.message).toMatch(/\{account\}/);
      expect(error.message).toMatch(/execFile \(no shell\)/);
      expect(error.message).toMatch(/no native keychain dependency|has none built in/);
    });

    test('ANYDB_KEYCHAIN_CMD is the zero-dependency path, with substitution', async () => {
      // `node` rather than `process.execPath`: the template is split on whitespace with no
      // shell, so a program path containing a space cannot be expressed in one.
      const script = path.join(root, 'keychain.js');
      writeFileSync(
        script,
        'const fs = require("fs");\n'
        + 'process.stdout.write(process.argv[2] + "|" + process.argv[3] + "|" + fs.readFileSync(process.argv[4], "utf8"));\n',
        'utf8'
      );
      const secretFile = path.join(root, 'keychain-secret');
      writeFileSync(secretFile, SECRET, 'utf8');

      const store = withPassword({ keychain: 'anydb/db-prod', account: 'readonly' });
      const { uri } = await store.resolve('a', {
        env: { ANYDB_KEYCHAIN_CMD: `node ${script} {service} {account} ${secretFile}` },
      });
      expect(uri).toBe(`postgres://app:anydb%2Fdb-prod%7Creadonly%7C${SECRET}@db.internal:5432/mydb`);
    });

    test('the keychain command is run with execFile and a timeout', async () => {
      const calls = [];
      const store = withPassword({ keychain: 'anydb/db-prod', account: 'ro' });
      await store.resolve('a', {
        env: { ANYDB_KEYCHAIN_CMD: 'op read op://{service}/{account}' },
        execFile: (file, args, options, callback) => {
          calls.push({ file, args, options });
          callback(null, 'secret\n');
        },
      });
      expect(calls[0].file).toBe('op');
      expect(calls[0].args).toEqual(['read', 'op://anydb/db-prod/ro']);
      expect(calls[0].options.timeout).toBe(5000);
    });
  });

  describe('literals and inline passwords', () => {
    test('a literal password works but is discouraged once', async () => {
      const store = withPassword('literal-pw');
      const { uri } = await store.resolve('a', { env: {} });
      expect(uri).toBe('postgres://app:literal-pw@db.internal:5432/mydb');
      expect(warnings.filter((w) => w.message.includes('plain text'))).toHaveLength(1);
    });

    test('a password inside the uri is used when no password field is set', async () => {
      const store = loaded({ profiles: { a: { uri: 'postgres://app:inline@db.internal:5432/mydb' } } }).store;
      const { uri } = await store.resolve('a', { env: {} });
      expect(uri).toBe('postgres://app:inline@db.internal:5432/mydb');
      expect(warnings.some((w) => w.message.includes('inside the connection string'))).toBe(true);
    });

    test('an explicit password field wins over one embedded in the uri', async () => {
      const store = loaded({
        profiles: { a: { uri: 'postgres://app:inline@db.internal:5432/mydb', password: { env: 'DB_PASSWORD' } } },
      }).store;
      const { uri } = await store.resolve('a', { env: { DB_PASSWORD: 'from-ref' } });
      expect(uri).toBe('postgres://app:from-ref@db.internal:5432/mydb');
    });

    test('a profile with no credential resolves to a bare URI', async () => {
      const store = loaded({ profiles: { a: { uri: 'postgres://app@db.internal:5432/mydb' } } }).store;
      const { uri } = await store.resolve('a', { env: {} });
      expect(uri).toBe('postgres://app@db.internal:5432/mydb');
    });
  });

  describe('reference validation', () => {
    const expectRejected = (password, pattern) => {
      const store = unloaded({ profiles: { a: { uri: 'postgres://app@h/db', password } } }).store;
      let thrown = null;
      try {
        store.load();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown.message).toMatch(pattern);
    };

    test('a reference must name exactly one source', () => {
      expectRejected({ env: 'A', file: '/tmp/x' }, /must name exactly one credential source.*found env and file/);
      expectRejected({}, /must name exactly one credential source.*found none/);
    });

    test('env must be a non-empty name', () => {
      expectRejected({ env: '  ' }, /password\.env must be the name of an environment variable/);
      expectRejected({ env: 5 }, /password\.env must be the name of an environment variable/);
    });

    test('file must be a non-empty path', () => {
      expectRejected({ file: '' }, /password\.file must be a path to a file holding the secret/);
    });

    test('exec must be a non-empty array of strings', () => {
      expectRejected({ exec: [] }, /password\.exec must be a non-empty array of arguments/);
      expectRejected({ exec: 'op read x' }, /password\.exec must be a non-empty array of arguments/);
      expectRejected({ exec: [''] }, /password\.exec\[0\] must be the program to run/);
      expectRejected({ exec: ['op', 7] }, /password\.exec\[1\] must be a string, got number/);
    });

    test('keychain must name a service and an account must be a string', () => {
      expectRejected({ keychain: '' }, /password\.keychain must be a keychain service name/);
      expectRejected({ keychain: 'svc', account: 3 }, /password\.account must be a string, got number/);
    });

    test('a misspelled field is refused rather than silently resolving to nothing', () => {
      expectRejected({ environment: 'DB_PASSWORD' }, /must name exactly one credential source.*found none/);
      expectRejected({ env: 'A', prompt: 'hi' }, /password\.prompt is not a recognised credential reference field/);
    });

    test('timeoutMs must be a positive number', () => {
      expectRejected({ env: 'A', timeoutMs: -1 }, /password\.timeoutMs must be a positive number of milliseconds/);
    });

    test('anything that is not a string or a reference is refused', () => {
      expectRejected(7, /must be a password string or a credential reference object/);
      expectRejected(['env'], /must be a password string or a credential reference object/);
      expectRejected(null, /must be a password string or a credential reference object/);
    });
  });

  describe('secrets never leak', () => {
    test('no thrown error mentions a resolved secret', async () => {
      const secretFile = path.join(root, 'secret');
      writeFileSync(secretFile, `${SECRET}\n`, 'utf8');
      const failing = path.join(root, 'failing.js');
      writeFileSync(
        failing,
        'process.stderr.write(require("fs").readFileSync(process.argv[2], "utf8")); process.exit(9);\n',
        'utf8'
      );

      const store = loaded({
        profiles: {
          a: { uri: 'postgres://app@h/db', password: { file: secretFile } },
          b: { uri: 'postgres://app@h/db', password: { env: 'SECRET_ENV' } },
          c: { uri: 'postgres://app@h/db', password: { exec: [process.execPath, failing, secretFile] } },
          d: { uri: 'postgres://app@h/db', password: { env: 'MISSING' } },
          e: { uri: 'postgres://app@h/db', password: { keychain: 'svc' } },
        },
      }).store;

      // `a` and `b` resolve; the rest must all fail without naming the secret.
      expect((await store.resolve('a', { env: {} })).uri).toContain(SECRET);
      expect((await store.resolve('b', { env: { SECRET_ENV: SECRET } })).uri).toContain(SECRET);

      for (const name of ['c', 'd', 'e', 'missing-profile']) {
        const error = await store.resolve(name, { env: { SECRET_ENV: SECRET } }).catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).not.toContain(SECRET);
      }
    });

    test('a keychain provider error message is not passed through', async () => {
      const store = withPassword({ keychain: 'svc' });
      const error = await store.resolve('a', {
        env: {},
        keychainProvider: () => Promise.reject(new Error(`vault said ${SECRET}`)),
      }).catch((e) => e);
      expect(error.message).not.toContain(SECRET);
    });

    test('nothing written to the logger contains a secret', async () => {
      const store = loaded({
        profiles: { a: { uri: 'postgres://app@db.internal:5432/mydb', password: SECRET } },
      }).store;
      await store.resolve('a', { env: {} });
      expect(JSON.stringify(warnings)).not.toContain(SECRET);
    });

    test('list() of a profile holding a secret does not contain it', () => {
      const store = loaded({
        profiles: { a: { uri: `postgres://app:${SECRET}@db.internal:5432/mydb` } },
      }).store;
      expect(JSON.stringify(store.list())).not.toContain(SECRET);
    });

    // An *inline* password in `db.json` is quoted back by the `uri` validation messages, and
    // the registry hands a config error to `db_health`, which the model reads.
    test.each([
      ['no scheme at all', `app:${SECRET}@db.internal:5432/mydb`],
      ['a typo in the scheme', `post gres://app:${SECRET}@db.internal:5432/mydb`],
      ['an unsupported scheme', `ftp://app:${SECRET}@db.internal:5432/mydb`],
      ['a non-string uri', 42],
    ])('a validation error never quotes an inline password: %s', (_label, uri) => {
      const store = unloaded({ profiles: { a: { driver: 'postgres', uri } } }).store;
      const error = captureLoadError(store);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(SECRET);
      // And it still says enough to fix the typo.
      expect(error.message).toMatch(/uri|must be|must start with/);
    });

    test('the redaction leaves a non-credential message alone', () => {
      const store = unloaded({ profiles: { a: { driver: 7 } } }).store;
      const error = captureLoadError(store);
      expect(error.message).toMatch(/must be a string, got number/);
    });
  });
});

describe('resolve()', () => {
  test('returns uri, policy, options and the profile name', async () => {
    const store = loaded({
      default: 'prod',
      profiles: {
        prod: {
          description: 'Production.',
          driver: 'postgres',
          uri: 'postgres://app@db.internal:5432/mydb',
          password: { env: 'DB_PASSWORD' },
          readOnly: true,
          maxRows: 500,
          queryTimeoutMs: 15000,
          allowedSchemas: ['public'],
          options: { application_name: 'anydb' },
        },
      },
    }).store;

    const resolved = await store.resolve('prod', { env: { DB_PASSWORD: 'pw' } });

    expect(Object.keys(resolved).sort()).toEqual(['name', 'options', 'policy', 'uri']);
    expect(resolved.uri).toBe('postgres://app:pw@db.internal:5432/mydb');
    expect(resolved.name).toBe('prod');
    expect(resolved.options).toEqual({ application_name: 'anydb' });
    expect(resolved.policy).toMatchObject({
      readOnly: true,
      maxRows: 500,
      maxBytes: 262144,
      queryTimeoutMs: 15000,
      connectTimeoutMs: 5000,
      allowedSchemas: ['public'],
      allowedTables: [],
      hosts: [],
      allowDestructive: false,
    });
  });

  test('options is an empty object when the profile has none', async () => {
    const store = loaded({ profiles: { a: { uri: 'postgres://app@h/db' } } }).store;
    expect((await store.resolve('a', { env: {} })).options).toEqual({});
  });

  test('loadProfileStore is a one-liner for the common case', () => {
    writeConfig({ profiles: { local: { path: './data/app.db' } } });
    const store = loadProfileStore({ env: makeEnv(), platform: process.platform, homedirFn: () => homeBase });
    expect(store.names).toEqual(['local']);
    expect(store.source).toBe(path.join(home, 'db.json'));
  });
});
