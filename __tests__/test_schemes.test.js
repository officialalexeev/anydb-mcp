/**
 * A connection scheme has to appear in three lists before it works:
 *
 *   1. `ROUTES` in `registry.js`: or the connection is unroutable
 *   2. `DEFAULT_ALLOWED_SCHEMES` in `policy.js`: or the policy refuses it
 *   3. `SCHEME_ALIASES` in `profiles.js`: or a profile naming it will not validate
 *
 * A scheme missing from (2) or (3) is the worst case: the server *connects* and is
 * then turned away, with a message naming a configuration problem when the
 * connection string was fine. Nothing in the type system connects the three lists,
 * so this file asserts it. Four real SQLAlchemy spellings were each missing from a
 * different list, and each produced a different message.
 */

import { DEFAULT_ALLOWED_SCHEMES, sqlDialect, classifiesAsDestructive, parseConnectionUri }
  from '../src/core/policy.js';
import { ROUTES, SUPPORTED_PROTOCOLS, driverFor } from '../src/core/registry.js';
import { MySQLAdapter } from '../src/adapters/mysql.js';
import { SUPPORTED_DRIVERS, SUPPORTED_URI_SCHEMES } from '../src/core/profiles.js';

/**
 * Schemes the policy allows that `registry.js` does not yet route. Each entry is
 * a `db.json` that validates and then fails with "Protocol … is not supported", so
 * it is written down with a name on it rather than left to be discovered.
 *
 * Empty, and the empty state is the point: the next scheme that lands in the
 * policy and not in `ROUTES` has to be added here deliberately. A scheme that is
 * both routed and listed fails the suite below, because a stale entry is a claim
 * that something is missing when it is not.
 */
const PENDING_ROUTES = Object.freeze([]);

const routed = new Set(SUPPORTED_PROTOCOLS);

describe('connection schemes', () => {
  test('every scheme the policy allows is routed by the registry, or is explicitly pending', () => {
    const unrouted = DEFAULT_ALLOWED_SCHEMES.filter((scheme) => !routed.has(scheme));
    expect([...unrouted].sort()).toEqual([...PENDING_ROUTES].sort());
  });

  test('the pending list holds no scheme that has since been routed', () => {
    // A stale entry is worse than a missing one: it claims something is unfinished.
    const stale = PENDING_ROUTES.filter((scheme) => routed.has(scheme));
    expect(stale).toEqual([]);
  });

  test('the four SQLAlchemy schemes that used to be pending are routed to mysql', () => {
    // Not "the list is empty" but the specific claim, so a future edit that drops one
    // of them names itself in the failure.
    for (const scheme of ['mariadb+pymysql', 'mariadb+mariadbconnector', 'mysql+aiomysql', 'mysql+cymysql']) {
      expect(routed.has(scheme)).toBe(true);
      expect(driverFor(scheme)).toBe('mysql');
    }
  });

  test('the Redis topologies the adapter can build are routed and allowed', () => {
    // `redis.js` builds `createCluster` and `createSentinel` clients for these. With
    // neither entry, `checkConnectionPolicy` refused the connection before the
    // adapter was constructed, so the code had no caller at all.
    for (const scheme of ['redis-cluster', 'redis-sentinel']) {
      expect(routed.has(scheme)).toBe(true);
      expect(driverFor(scheme)).toBe('redis');
      expect(DEFAULT_ALLOWED_SCHEMES).toContain(scheme);
    }
  });

  test('the policy and the registry do not disagree the other way either', () => {
    // The same failure with the sides swapped: an ordinary connection string refused
    // by the policy for a reason that has nothing to do with the statement.
    const unroutable = SUPPORTED_PROTOCOLS.filter((scheme) => !DEFAULT_ALLOWED_SCHEMES.includes(scheme));
    expect(unroutable).toEqual([]);
  });

  test('a profile may name every scheme the policy allows', () => {
    // The third list, and the one a *user* trips over: it rejects a `db.json` at load
    // time with "scheme … is not supported".
    const rejected = DEFAULT_ALLOWED_SCHEMES.filter((scheme) => !SUPPORTED_URI_SCHEMES.has(scheme));
    expect(rejected).toEqual([]);
  });

  test('no scheme appears twice across the policy list and the driver list', () => {
    // The two are unioned for validation, so a duplicate is harmless today, but it is
    // a sign of two lists being edited independently.
    expect(new Set(DEFAULT_ALLOWED_SCHEMES).size).toBe(DEFAULT_ALLOWED_SCHEMES.length);
  });

  test('the union of drivers and aliases is exactly what the validator accepts', () => {
    // Asserted rather than recomputed, so a change to `SCHEME_ALIASES` cannot pass by
    // being reflected in the export but not in the check that uses it.
    expect(SUPPORTED_URI_SCHEMES.has('sqlite+pysqlite')).toBe(true);
    expect(SUPPORTED_URI_SCHEMES.has('mongodb+srv')).toBe(true);
    expect(SUPPORTED_URI_SCHEMES.has('mariadb')).toBe(true);
    expect(SUPPORTED_URI_SCHEMES.has('oracle')).toBe(false);
    // A driver, not an alias: a profile may name it either way.
    expect(SUPPORTED_DRIVERS).toContain('mariadb');
  });

  test('ROUTES covers no scheme that is not on the policy list', () => {
    // Asserts `ROUTES` has not grown an entry the policy was not told about.
    const fromRoutes = ROUTES.flatMap((route) => [...route.schemes]);
    expect(new Set(fromRoutes).size).toBe(fromRoutes.length);
    expect(fromRoutes.filter((scheme) => !DEFAULT_ALLOWED_SCHEMES.includes(scheme))).toEqual([]);
  });
});

describe('the destructive verdict is not protocol-blind', () => {
  // A MariaDB statement must be classified as MariaDB, or the *second* gate — the
  // one keeping `allowDestructive` separate from `readOnly` — reads as "not
  // destructive" for a whole database family. `sqlDialect` collapses through
  // `baseProtocol`, so there is one table answering "which dialect is this
  // scheme" rather than two made to agree.
  const SQL_ALIASES = [
    'mysql', 'mariadb',
    'mysql+pymysql', 'mysql+mysqldb', 'mysql+asyncmy', 'mysql+aiohttp',
    'mysql+aiomysql', 'mysql+cymysql',
    'mariadb+pymysql', 'mariadb+mariadbconnector',
  ];

  test.each(SQL_ALIASES)('%s is classified as a SQL dialect', (scheme) => {
    expect(sqlDialect(scheme)).toBe('mysql');
  });

  test.each(['postgres', 'postgresql'])('%s is classified as postgres', (scheme) => {
    expect(sqlDialect(scheme)).toBe('postgres');
  });

  test.each(['sqlite', 'sqlite+pysqlite'])('%s is classified as sqlite', (scheme) => {
    expect(sqlDialect(scheme)).toBe('sqlite');
  });

  // An unlisted scheme stays unknown rather than being classified as something it is
  // not: matching `mariadb+anything` would hand MySQL's rules to a driver nobody
  // has.
  test.each(['mariadb+evil', 'mysql+evil', 'sqlite+evil', 'oracle', 'rediss', 'mongodb+srv', 'redis-cluster', ''])
    ('%p is not classifiable as SQL', (scheme) => {
      expect(sqlDialect(scheme)).toBeNull();
    });

  test.each(SQL_ALIASES)('%s refuses a DROP as destructive', (scheme) => {
    const verdict = classifiesAsDestructive('DROP TABLE users', scheme);
    expect(verdict.destructive).toBe(true);
    expect(verdict.reason).toMatch(/changes schema or privileges/);
  });

  test.each(SQL_ALIASES)('%s refuses a GRANT as destructive', (scheme) => {
    expect(classifiesAsDestructive('GRANT ALL ON db.* TO someone', scheme).destructive).toBe(true);
  });

  test.each(SQL_ALIASES)('%s still allows a plain write', (scheme) => {
    // The narrow definition: `readOnly: false` is for writing rows, and collapsing
    // that into "destructive" is the escalation this module refuses to make.
    expect(classifiesAsDestructive('DELETE FROM drafts', scheme).destructive).toBe(false);
  });

  // MariaDB reads backslashes as escapes, so a `\'` inside a literal does not end
  // it. Getting that wrong is injection-adjacent, not cosmetic: a destructive verb
  // hidden in what the scanner thinks is a literal would pass.
  test('the MariaDB family reads backslash escapes in a literal', () => {
    const query = "SELECT * FROM logs WHERE note = '\\' ; DROP TABLE users; --'";
    expect(classifiesAsDestructive(query, 'mysql').destructive).toBe(false);
    expect(classifiesAsDestructive(query, 'mariadb').destructive).toBe(false);
    expect(classifiesAsDestructive(query, 'mariadb+pymysql').destructive).toBe(false);
  });

  test('a destructive verb after a MariaDB literal is still found', () => {
    expect(classifiesAsDestructive("SELECT 1; DROP TABLE users", 'mariadb+pymysql').destructive).toBe(true);
  });

  test('a MySQL conditional comment is refused in the MariaDB family too', () => {
    const verdict = classifiesAsDestructive('SELECT /*! STRAIGHT_JOIN */ 1', 'mariadb+mariadbconnector');
    expect(verdict.destructive).toBe(true);
    expect(verdict.reason).toMatch(/conditional comments/);
  });

  test('an unknown protocol still refuses to assert anything', () => {
    const verdict = classifiesAsDestructive('DROP TABLE users', 'oracle');
    expect(verdict.destructive).toBe(false);
    expect(verdict.reason).toMatch(/not classifiable/);
  });
});

describe('scheme parsing for the whole family', () => {
  // An allowed scheme that does not parse is a scheme the policy cannot check.
  test.each([
    'mariadb+pymysql://app:pw@db.internal:3306/shop',
    'mariadb+mariadbconnector://app:pw@db.internal:3306/shop',
    'mysql+aiomysql://app:pw@db.internal:3306/shop',
    'mysql+cymysql://app:pw@db.internal:3306/shop',
  ])('%s splits into the parts a policy check needs', (uri) => {
    const parsed = parseConnectionUri(uri);
    expect(parsed).not.toBeNull();
    expect(parsed.scheme).toBe(uri.slice(0, uri.indexOf('://')));
    expect(parsed.host).toBe('db.internal');
    expect(parsed.port).toBe('3306');
    expect(parsed.user).toBe('app');
    expect(parsed.password).toBe('pw');
  });

  test('the four new schemes are not SQLite, so they are host-checked rather than path-checked', () => {
    // `isSqliteScheme` matches `sqlite` and `sqlite+…` only, so a scheme falling into
    // that branch gets a *path* allowlist verdict for a network connection.
    for (const scheme of ['mariadb+pymysql', 'mysql+aiomysql', 'mariadb+mariadbconnector', 'mysql+cymysql']) {
      const parsed = parseConnectionUri(`${scheme}://db.internal/shop`);
      expect(parsed.filePath).toBe('');
      expect(parsed.host).toBe('db.internal');
    }
  });

  test('every scheme the policy allows is a legal scheme token', () => {
    for (const scheme of DEFAULT_ALLOWED_SCHEMES) {
      expect(parseConnectionUri(`${scheme}://host/db`)).not.toBeNull();
    }
  });

  test('the two Redis topology schemes split into a host, not a file path', () => {
    // `redis-sentinel://…` is the one that would break: its path is the master's
    // name, not a database file.
    for (const scheme of ['redis-cluster', 'redis-sentinel']) {
      const parsed = parseConnectionUri(`${scheme}://:pw@sentinel.internal:26379/mymaster`);
      expect(parsed.filePath).toBe('');
      expect(parsed.host).toBe('sentinel.internal');
      expect(parsed.port).toBe('26379');
      expect(parsed.password).toBe('pw');
    }
  });

  test('the schemes that are now routed all resolve to the driver they claim', () => {
    // Asserted from the route table rather than a list of schemes, so adding a route
    // is enough and nothing has to be remembered in a second place.
    for (const route of ROUTES) {
      for (const scheme of route.schemes) {
        expect(driverFor(scheme)).toBe(route.driver);
      }
    }
  });
});

describe('every MySQL-family spelling reaches the same pool', () => {
  // "It routes" is not "it connects". `mysql.js` rewrites the `mysql+<dialect>`
  // spellings to `mysql://` and parses the rest with `new URL(...)`, so the
  // `mariadb` family and `mysql+aiomysql` / `mysql+cymysql` work only because the
  // URL parser is indifferent to the scheme. Correct and fragile: the URI parses,
  // the adapter hands mysql2 a config with no host, and the caller gets a
  // connection refused against an empty hostname. Driving the adapter with every
  // spelling and comparing the config finds that without a server.
  const SPELLINGS = [
    'mysql', 'mariadb',
    'mysql+pymysql', 'mysql+mysqldb', 'mysql+asyncmy', 'mysql+aiohttp',
    'mysql+aiomysql', 'mysql+cymysql',
    'mariadb+pymysql', 'mariadb+mariadbconnector',
  ];

  const configFor = async (scheme) => {
    const pool = { getConnection: jest.fn(), on: jest.fn() };
    const createPool = jest.fn(() => pool);
    const adapter = new MySQLAdapter(createPool, 30000);
    await adapter.connect(`${scheme}://app:p%40ss@db.internal:3307/shop?connectTimeout=1234`);
    return createPool.mock.calls[0][0];
  };

  test.each(SPELLINGS)('%s produces the same connection config as mysql', async (scheme) => {
    const config = await configFor(scheme);
    expect(config).toMatchObject({
      host: 'db.internal',
      port: 3307,
      user: 'app',
      // A percent-encoded password, because `@` in one is a real thing and `URL` is
      // what splits userinfo from host.
      password: 'p@ss',
      database: 'shop',
      connectTimeout: 1234
    });
  });

  test('and they are the same config, not merely the same shape', async () => {
    const reference = await configFor('mysql');
    for (const scheme of SPELLINGS.filter((name) => name !== 'mysql')) {
      expect({ ...(await configFor(scheme)), uri: undefined }).toEqual({ ...reference, uri: undefined });
    }
  });

  test('an unparseable spelling is refused with the adapter\'s own message', async () => {
    const createPool = jest.fn();
    const adapter = new MySQLAdapter(createPool, 30000);
    await expect(adapter.connect('not a uri')).rejects.toThrow(/Invalid MySQL URI format/);
    expect(createPool).not.toHaveBeenCalled();
  });
});
