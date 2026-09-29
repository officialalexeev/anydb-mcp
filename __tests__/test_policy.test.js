import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import {
  checkConnectionPolicy,
  checkSqlitePathPolicy,
  classifiesAsDestructive,
  evaluatePolicy,
  isPrivateAddress,
  ipInCidr,
  parseIp,
  embeddedIpv4,
  parseConnectionUri,
  parseBoolEnv,
  isAdHocUriAllowed,
  allowedSchemes,
  hostMatchesAllowlist,
  isPathWithin,
  isAddressLiteral,
  resetPolicyWarnings,
  DEFAULT_ALLOWED_SCHEMES,
  POLICY_DEFAULTS,
  CREDENTIAL_QUERY_PARAMS,
} from '../src/core/policy.js';

/** A resolver that answers from a table, so nothing in this file touches the network. */
const stubDns = (table) => ({
  lookup: (host, options) => {
    const addresses = table[host];
    if (addresses === undefined) {
      return Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
    }
    return Promise.resolve(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  },
});

const noLog = () => {};
const PUBLIC = stubDns({ 'db.example.com': ['93.184.216.34'], 'ipv6.example.com': ['2606:2800:220:1:248:1893:25c8:1946'] });

// Used by the two filesystem tests below, the only ones that touch a real directory.
let counter = 0;

beforeEach(() => {
  resetPolicyWarnings();
});

describe('ipInCidr', () => {
  test.each([
    ['10.0.0.5', '10.0.0.0/8', true],
    ['10.255.255.255', '10.0.0.0/8', true],
    ['11.0.0.0', '10.0.0.0/8', false],
    ['172.16.0.1', '172.16.0.0/12', true],
    ['172.31.255.255', '172.16.0.0/12', true],
    ['172.32.0.1', '172.16.0.0/12', false],
    ['172.15.255.255', '172.16.0.0/12', false],
    ['192.168.1.1', '192.168.0.0/16', true],
    ['192.169.0.1', '192.168.0.0/16', false],
    ['127.0.0.1', '127.0.0.0/8', true],
    ['169.254.169.254', '169.254.0.0/16', true],
    ['169.255.0.1', '169.254.0.0/16', false],
    ['1.2.3.4', '0.0.0.0/0', true],
    ['255.255.255.255', '255.255.255.255/32', true],
    ['255.255.255.254', '255.255.255.255/32', false],
  ])('%s in %s is %s', (ip, cidr, expected) => {
    expect(ipInCidr(ip, cidr)).toBe(expected);
  });

  test('a bare address is an exact match, not a prefix', () => {
    expect(ipInCidr('10.0.0.1', '10.0.0.1')).toBe(true);
    expect(ipInCidr('10.0.0.2', '10.0.0.1')).toBe(false);
  });

  test.each([
    ['::1', '::1/128', true],
    ['::2', '::1/128', false],
    ['fc00::1', 'fc00::/7', true],
    ['fdff::1', 'fc00::/7', true],
    ['fe00::1', 'fc00::/7', false],
    ['fe80::1', 'fe80::/10', true],
    ['febf::1', 'fe80::/10', true],
    ['fec0::1', 'fe80::/10', false],
    ['2001:db8::1', '2001:db8::/32', true],
    ['2001:db9::1', '2001:db8::/32', false],
    ['2606:2800::1', '::/0', true],
  ])('%s in %s is %s', (ip, cidr, expected) => {
    expect(ipInCidr(ip, cidr)).toBe(expected);
  });

  test('a prefix is compared bit by bit, not byte by byte', () => {
    // /12 covers 172.16 through 172.31, which is a nibble in the second byte.
    expect(ipInCidr('172.16.0.0', '172.16.0.0/12')).toBe(true);
    expect(ipInCidr('172.31.255.255', '172.16.0.0/12')).toBe(true);
    expect(ipInCidr('172.32.0.0', '172.16.0.0/12')).toBe(false);
  });

  test('IPv4 and IPv4-mapped IPv6 agree', () => {
    expect(ipInCidr('::ffff:10.0.0.1', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('10.0.0.1', '::ffff:0:0/96')).toBe(true);
    expect(ipInCidr('::ffff:93.184.216.34', '93.184.216.0/24')).toBe(true);
  });

  test('nonsense on either side is not a match, never a throw', () => {
    expect(ipInCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('10.0.0.1', 'not-a-cidr')).toBe(false);
    expect(ipInCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
    expect(ipInCidr('10.0.0.1', '10.0.0.0/abc')).toBe(false);
    expect(ipInCidr(null, '10.0.0.0/8')).toBe(false);
  });
});

describe('parseIp', () => {
  test.each([
    '1.2.3.4', '0.0.0.0', '255.255.255.255',
    // The shorthand notations inet_aton accepts.
    '1.2.3', '127.1', '127.0.1', '0177.0.0.1', '0x7f.1', '10',
  ])('%s parses as IPv4', (text) => {
    expect(parseIp(text)).not.toBeNull();
  });

  test.each([
    ['1.2.3.4', 4, [1, 2, 3, 4]],
    ['0.0.0.0', 4, [0, 0, 0, 0]],
    ['255.255.255.255', 4, [255, 255, 255, 255]],
    ['1.2.3', 4, [1, 2, 0, 3]],
    ['127.1', 4, [127, 0, 0, 1]],
    ['127.0.1', 4, [127, 0, 0, 1]],
    ['0177.0.0.1', 4, [127, 0, 0, 1]],
    ['0x7f.1', 4, [127, 0, 0, 1]],
    ['10', 4, [0, 0, 0, 10]],
    ['0300.0250.0.1', 4, [192, 168, 0, 1]],
  ])('%s parses as %s', (text, version, bytes) => {
    const parsed = parseIp(text);
    expect(parsed).not.toBeNull();
    expect(parsed.version).toBe(version);
    expect([...parsed.bytes]).toEqual(bytes);
  });

  test.each([
    '', ' ', '1.2.3.4.5', '256.0.0.1', '1.2.3.', '.1.2.3', '1.2.3.4.',
    '08.0.0.1', '1.2.3.-1', '1.2.3.1e3', '0x', '1.2.3.08', '1e9.1.1.1',
  ])('%s is not an address', (text) => {
    expect(parseIp(text)).toBeNull();
  });

  test.each([
    ['::1', 16],
    ['::', 16],
    ['fe80::1', 16],
    ['2001:db8:0:0:0:0:0:1', 16],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', 16],
    ['::ffff:127.0.0.1', 16],
    ['0:0:0:0:0:ffff:7f00:1', 16],
    ['fe80::1%eth0', 16],
  ])('%s parses as an IPv6 address', (text) => {
    const parsed = parseIp(text);
    expect(parsed).not.toBeNull();
    expect(parsed.version).toBe(6);
    expect(parsed.bytes).toHaveLength(16);
  });

  test('the mapped forms all agree byte for byte', () => {
    const a = parseIp('::ffff:127.0.0.1');
    const b = parseIp('::ffff:7f00:1');
    const c = parseIp('0:0:0:0:0:ffff:127.0.0.1');
    expect([...a.bytes]).toEqual([...b.bytes]);
    expect([...a.bytes]).toEqual([...c.bytes]);
  });

  test.each([
    '', ':', '::ffff:', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1::2::3',
    'gggg::1', '1:2:3:4:5:6:7:zzzz', ':::1', '::1%', '::1%%',
  ])('%s is not an IPv6 address', (text) => {
    expect(parseIp(text)).toBeNull();
  });

  test('embeddedIpv4 recognises all three IPv6-wraps-an-IPv4 forms', () => {
    expect([...embeddedIpv4(parseIp('::ffff:10.0.0.1').bytes)]).toEqual([10, 0, 0, 1]);
    expect([...embeddedIpv4(parseIp('::10.0.0.1').bytes)]).toEqual([10, 0, 0, 1]);
    expect([...embeddedIpv4(parseIp('64:ff9b::10.0.0.1').bytes)]).toEqual([10, 0, 0, 1]);
    expect(embeddedIpv4(parseIp('2001:db8::1').bytes)).toBeNull();
  });
});

describe('isAddressLiteral', () => {
  // The rule that separates "an address I can read without asking anybody" from
  // "a string two parsers could read two ways". Only the narrower question may be
  // answered without a resolver.
  test.each([
    '0.0.0.0', '1.2.3.4', '93.184.216.34', '255.255.255.255', '10.0.0.1',
  ])('%s is a literal', (text) => {
    expect(isAddressLiteral(text)).toBe(true);
  });

  test.each([
    '1.2.3', '127.1', '127.0.1', '0177.0.0.1', '0x7f.1', '0x7f000001',
    '2130706433', '127.000.000.001', '010.0.0.1', '0300.0250.0.1', '10',
  ])('%s parses but is not a literal, because a resolver may read it differently', (text) => {
    expect(parseIp(text)).not.toBeNull();
    expect(isAddressLiteral(text)).toBe(false);
  });

  // Every IPv6 spelling is unambiguous, so every one of them is a literal.
  test.each([
    '::1', '::', 'fe80::1', 'fe80::1%eth0', '2001:db8::1', '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '64:ff9b::10.0.0.1',
  ])('%s is a literal', (text) => {
    expect(isAddressLiteral(text)).toBe(true);
  });

  // The one IPv6 spelling with more than one reading: an ambiguous embedded IPv4
  // tail.
  test('an IPv6 address with an ambiguous embedded IPv4 tail is not a literal', () => {
    expect(isAddressLiteral('::ffff:127.000.000.001')).toBe(false);
    expect(isAddressLiteral('::ffff:0177.0.0.1')).toBe(false);
    expect(isAddressLiteral('::ffff:127.0.0.1')).toBe(true);
  });

  test.each(['db.example.com', 'localhost', '', 'example.com.'])(
    '%p is a name, not an address',
    (text) => { expect(isAddressLiteral(text)).toBe(false); }
  );
});

describe('isPrivateAddress', () => {
  test.each([
    '0.0.0.0', '0.1.2.3',
    '10.0.0.0', '10.255.255.255',
    '100.64.0.1',
    '127.0.0.1', '127.1', '127.0.0.53',
    '169.254.169.254', '169.254.0.1',
    '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '192.168.255.255',
    '198.18.0.1',
    '224.0.0.1', '239.255.255.255',
    '255.255.255.255',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each([
    '1.1.1.1', '8.8.8.8', '93.184.216.34',
    '11.0.0.1', '9.255.255.255',
    '100.128.0.1', '99.255.255.255',
    '126.255.255.255', '128.0.0.1',
    '169.253.255.255', '169.255.0.1',
    '172.15.255.255', '172.32.0.1',
    '192.167.255.255', '192.169.0.1',
    '198.17.255.255', '198.20.0.1',
    '223.255.255.255',
  ])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  test.each([
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf:ffff::1', 'ff02::1',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each([
    '2001:db8::1', '2606:2800:220:1:248:1893:25c8:1946', '2a00:1450:4001:81b::200e',
  ])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  // The whole point of resolving before validating: four spellings of one address,
  // and a check that looked at the string would miss three.
  describe('the notations a string comparison misses', () => {
    test.each([
      ['127.0.0.1', 'dotted quad'],
      ['127.1', 'short form'],
      ['0177.0.0.1', 'octal'],
      ['0x7f.0.0.1', 'hex'],
      ['0x7f.1', 'hex and short'],
      ['::ffff:127.0.0.1', 'IPv4-mapped IPv6'],
      ['0:0:0:0:0:ffff:7f00:1', 'IPv4-mapped, expanded'],
      ['::127.0.0.1', 'IPv4-compatible'],
      ['::ffff:7f00:1', 'IPv4-mapped, hex tail'],
      ['64:ff9b::127.0.0.1', 'NAT64 well-known prefix'],
    ])('%s (%s) is blocked', (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    });

    test.each([
      '169.254.169.254', '169.254.169.253',
      '10.1.2.3', '012.1.2.3', '10.1', '0x0a.1.2.3',
      '192.168.0.1', '0300.0250.0.1',
      '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',
    ])('%s is blocked', (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    });

    test('an octal-looking address is read as octal, which is what libc does', () => {
      // 010 is 8, not 10: reading a leading zero as decimal would let an attacker
      // write "010.0.0.1" expecting a blocked 10/8 address and land on a public one.
      expect(isPrivateAddress('010.0.0.1')).toBe(false);
      expect(isPrivateAddress('012.0.0.1')).toBe(true);
    });
  });

  test('an unparseable string is not "private"; it never reaches this check', () => {
    expect(isPrivateAddress('localhost')).toBe(false);
    expect(isPrivateAddress('not-an-address')).toBe(false);
    expect(isPrivateAddress('')).toBe(false);
  });
});

describe('parseConnectionUri', () => {
  test('splits a full connection string', () => {
    expect(parseConnectionUri('postgres://app:pw@db.example.com:5432/mydb?sslmode=require')).toMatchObject({
      scheme: 'postgres',
      user: 'app',
      password: 'pw',
      host: 'db.example.com',
      port: '5432',
      path: '/mydb',
      query: 'sslmode=require',
    });
  });

  test('a bracketed IPv6 host is not mistaken for a port', () => {
    expect(parseConnectionUri('postgres://app@[2001:db8::1]:5432/mydb')).toMatchObject({
      host: '[2001:db8::1]', port: '5432',
    });
    expect(parseConnectionUri('postgres://[::1]/mydb')).toMatchObject({ host: '[::1]', port: '' });
  });

  test('a SQLite URI is a file path, not an authority', () => {
    expect(parseConnectionUri('sqlite:///data/app.db')).toMatchObject({
      scheme: 'sqlite', host: '', filePath: '/data/app.db',
    });
    expect(parseConnectionUri('sqlite://./relative.db')).toMatchObject({ filePath: './relative.db' });
    expect(parseConnectionUri('sqlite://:memory:')).toMatchObject({ filePath: ':memory:' });
    expect(parseConnectionUri('sqlite:///C:/data.db')).toMatchObject({ filePath: 'C:/data.db' });
    expect(parseConnectionUri('sqlite+pysqlite:///data/app.db')).toMatchObject({ filePath: '/data/app.db' });
  });

  test('a fragment is separated from the query', () => {
    expect(parseConnectionUri('postgres://h/db?a=1#frag')).toMatchObject({ query: 'a=1', fragment: 'frag' });
  });

  test.each(['no-scheme', '', '://host', '1bad://host', null, 42])('%s is not a connection string', (uri) => {
    expect(parseConnectionUri(uri)).toBeNull();
  });
});

describe('scheme allowlist', () => {
  test.each([...DEFAULT_ALLOWED_SCHEMES])('%s is allowed by default', async (scheme) => {
    const verdict = await checkConnectionPolicy(`${scheme}://db.example.com/db`, { env: {}, dns: PUBLIC });
    expect(verdict.reason).not.toMatch(/not allowed/);
  });

  test('mariadb is in the default set', () => {
    expect(DEFAULT_ALLOWED_SCHEMES).toContain('mariadb');
    expect(DEFAULT_ALLOWED_SCHEMES).toContain('mongodb+srv');
  });

  test.each([
    'file:///etc/passwd',
    'http://evil.example.com/',
    'ftp://host/x',
    'gopher://host/',
    'ldap://host/',
    'ssh://host/',
  ])('%s is refused by default', async (uri) => {
    const verdict = await checkConnectionPolicy(uri, { env: {}, dns: PUBLIC });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/is not allowed/);
  });

  test('a scheme that is not even shaped like a URI is refused before anything else', async () => {
    // `jdbc:postgresql://host/db` has a colon before the `://`, so the prefix fails
    // the scheme grammar. Refused either way; the message differs.
    const verdict = await checkConnectionPolicy('jdbc:postgresql://host/db', { env: {}, dns: PUBLIC });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/could not be read|is not allowed/);
  });

  test('the refusal message names the allowed set', async () => {
    const verdict = await checkConnectionPolicy('http://host/', { env: {}, dns: PUBLIC });
    expect(verdict.reason).toMatch(/Allowed schemes: .*postgres/);
  });

  test('ANYDB_ALLOWED_SCHEMES replaces the set rather than adding to it', async () => {
    const env = { ANYDB_ALLOWED_SCHEMES: 'postgres, mysql' };
    expect(allowedSchemes(env)).toEqual(new Set(['postgres', 'mysql']));
    expect((await checkConnectionPolicy('redis://db.example.com', { env, dns: PUBLIC })).allowed).toBe(false);
    expect((await checkConnectionPolicy('postgres://db.example.com/db', { env, dns: PUBLIC })).allowed).toBe(true);
  });

  test('an empty override keeps the default set', () => {
    expect(allowedSchemes({ ANYDB_ALLOWED_SCHEMES: '  ' })).toEqual(new Set(DEFAULT_ALLOWED_SCHEMES));
  });
});

describe('host allowlist', () => {
  test('a per-profile hosts list is enforced, case-insensitively', async () => {
    const profile = { name: 'prod', hosts: ['DB.Example.com'] };
    expect((await checkConnectionPolicy('postgres://db.example.com/db', { env: {}, profile, dns: PUBLIC })).allowed).toBe(true);
    const refused = await checkConnectionPolicy('postgres://other.example.com/db', { env: {}, profile, dns: PUBLIC });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toMatch(/is not in the allowed hosts for this profile: DB\.Example\.com/);
  });

  test('ANYDB_ALLOWED_HOSTS is honoured globally', async () => {
    const env = { ANYDB_ALLOWED_HOSTS: 'db.example.com, cache.internal' };
    expect((await checkConnectionPolicy('postgres://db.example.com/db', { env, dns: PUBLIC })).allowed).toBe(true);
    expect((await checkConnectionPolicy('postgres://elsewhere.example.com/db', { env, dns: PUBLIC })).allowed).toBe(false);
  });

  test('both lists apply: the tighter one wins', async () => {
    const env = { ANYDB_ALLOWED_HOSTS: 'db.example.com,cache.internal' };
    const profile = { name: 'prod', hosts: ['db.example.com'] };
    expect((await checkConnectionPolicy('postgres://db.example.com/db', { env, profile, dns: PUBLIC })).allowed).toBe(true);
    expect((await checkConnectionPolicy('postgres://cache.internal/0', { env, profile, dns: PUBLIC })).allowed).toBe(false);
  });

  test('wildcards are narrow on purpose', () => {
    expect(hostMatchesAllowlist('db.example.com', ['*.example.com'])).toBe(true);
    // A leading `*.` does not match the bare domain, so an allowlist cannot widen
    // itself.
    expect(hostMatchesAllowlist('example.com', ['*.example.com'])).toBe(false);
    expect(hostMatchesAllowlist('anything', ['*'])).toBe(true);
    expect(hostMatchesAllowlist('db.example.com.', ['db.example.com'])).toBe(true);
  });

  test('a URI with no host is refused rather than connected to a default', async () => {
    const verdict = await checkConnectionPolicy('postgres:///mydb', { env: {}, dns: PUBLIC });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/has no host/);
  });
});

describe('private-range blocking, after resolution', () => {
  test('a literal address is validated without a DNS lookup', async () => {
    const dns = { lookup: () => { throw new Error('DNS must not be called for a literal address'); } };
    const verdict = await checkConnectionPolicy('postgres://app@10.1.2.3:5432/db', { env: {}, dns });
    expect(verdict.allowed).toBe(false);
    expect(verdict.resolved).toEqual([]);
  });

  test('a public literal is allowed and reported as its own resolution', async () => {
    const verdict = await checkConnectionPolicy('postgres://app@93.184.216.34:5432/db', { env: {}, dns: PUBLIC });
    expect(verdict.allowed).toBe(true);
    expect(verdict.resolved).toEqual(['93.184.216.34']);
  });

  test('a literal in every blocked notation is refused', async () => {
    const dns = { lookup: () => { throw new Error('no DNS'); } };
    for (const host of ['127.0.0.1', '127.1', '0177.0.0.1', '::1', '[::1]', '169.254.169.254', '10.0.0.1', '192.168.1.1', '172.16.0.1']) {
      const uri = `postgres://app@${host}:5432/db`;
      const verdict = await checkConnectionPolicy(uri, { env: {}, dns });
      expect(verdict.allowed).toBe(false);
    }
  });

  test('the cloud metadata address is the case that matters, and it says why', async () => {
    const verdict = await checkConnectionPolicy('postgres://app@169.254.169.254/db', { env: {}, dns: PUBLIC });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/link-local/);
    expect(verdict.reason).toMatch(/metadata/);
    expect(verdict.reason).toMatch(/ANYDB_ALLOW_PRIVATE_HOSTS=1/);
  });

  test('a hostname is resolved and every address it returns is checked', async () => {
    const dns = stubDns({
      'good.example.com': ['93.184.216.34'],
      'mixed.example.com': ['93.184.216.34', '10.0.0.5'],
      'mixed6.example.com': ['2606:2800::1', 'fe80::1'],
      'mapped.example.com': ['::ffff:169.254.169.254'],
    });

    const good = await checkConnectionPolicy('postgres://good.example.com/db', { env: {}, dns });
    expect(good.allowed).toBe(true);
    expect(good.resolved).toEqual(['93.184.216.34']);

    // One good record does not launder one bad one: this is a DNS-rebinding bypass.
    const mixed = await checkConnectionPolicy('postgres://mixed.example.com/db', { env: {}, dns });
    expect(mixed.allowed).toBe(false);
    expect(mixed.reason).toMatch(/resolves to 10\.0\.0\.5/);
    expect(mixed.reason).toMatch(/93\.184\.216\.34, 10\.0\.0\.5/);

    const mixed6 = await checkConnectionPolicy('postgres://mixed6.example.com/db', { env: {}, dns });
    expect(mixed6.allowed).toBe(false);

    const mapped = await checkConnectionPolicy('postgres://mapped.example.com/db', { env: {}, dns });
    expect(mapped.allowed).toBe(false);
  });

  test('an IPv6 hostname is checked too', async () => {
    const good = await checkConnectionPolicy('postgres://ipv6.example.com/db', { env: {}, dns: PUBLIC });
    expect(good.allowed).toBe(true);
    expect(good.resolved).toEqual(['2606:2800:220:1:248:1893:25c8:1946']);
  });

  test('a name that will not resolve is refused, not assumed safe', async () => {
    const verdict = await checkConnectionPolicy('postgres://nowhere.example.com/db', { env: {}, dns: PUBLIC });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/could not be resolved \(ENOTFOUND\)/);
    expect(verdict.reason).toMatch(/no address to check/);
  });

  test('a name that resolves to nothing is refused', async () => {
    const verdict = await checkConnectionPolicy('postgres://empty.example.com/db', {
      env: {},
      dns: { lookup: () => Promise.resolve([]) },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/resolved to no addresses/);
  });

  test('ANYDB_ALLOW_PRIVATE_HOSTS=1 lifts the block and skips the lookup', async () => {
    const dns = { lookup: () => { throw new Error('no DNS is needed once the check is off'); } };
    for (const value of ['1', 'true', 'yes', 'on', 'ON', 'True']) {
      const verdict = await checkConnectionPolicy('postgres://app@127.0.0.1:5432/db', { env: { ANYDB_ALLOW_PRIVATE_HOSTS: value }, dns });
      expect(verdict.allowed).toBe(true);
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      const verdict = await checkConnectionPolicy('postgres://app@127.0.0.1:5432/db', { env: { ANYDB_ALLOW_PRIVATE_HOSTS: value }, dns: PUBLIC });
      expect(verdict.allowed).toBe(false);
    }
  });

  // "Parse as a literal" and "safe to allow without a resolver" are two questions.
  // `010.0.0.1` is the case: read as octal it is a public 8.0.0.1, read as decimal it
  // is a blocked 10.0.0.1. Current glibc refuses the spelling outright, so the
  // connection fails today — but the check is what is supposed to be right.
  test('an ambiguous IPv4 spelling is resolved, not treated as a literal', async () => {
    const calls = [];
    const dns = { lookup: (host) => { calls.push(host); return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })); } };

    const refused = await checkConnectionPolicy('postgres://app@010.0.0.1:5432/db', { env: {}, dns });
    expect(calls).toEqual(['010.0.0.1']);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toMatch(/could not be resolved/);

    // The verdict follows whatever the resolver says: one that reads it as 10.0.0.1
    // is believed.
    const privateByResolvers = { lookup: () => Promise.resolve([{ address: '10.0.0.1', family: 4 }]) };
    const asPrivate = await checkConnectionPolicy('postgres://app@010.0.0.1:5432/db', { env: {}, dns: privateByResolvers });
    expect(asPrivate.allowed).toBe(false);
    expect(asPrivate.reason).toMatch(/10\.0\.0\.1/);
  });

  test.each([
    ['10.0.0.1'], ['0177.0.0.1'], ['0x7f.1'], ['127.1'], ['2130706433'], ['127.000.000.001'],
    ['::ffff:10.0.0.1'], ['::10.0.0.1'], ['64:ff9b::10.0.0.1'], ['::ffff:127.000.000.001'],
  ])('an unambiguous private answer is refused without a lookup: %s', async (host) => {
    const dns = { lookup: () => { throw new Error('no DNS is needed for a private address'); } };
    const verdict = await checkConnectionPolicy(`postgres://app@${host}:5432/db`, { env: {}, dns });
    expect(verdict.allowed).toBe(false);
    expect(verdict.resolved).toEqual([]);
  });

  test.each([
    ['93.184.216.34'],
    ['[2606:2800:220:1:248:1893:25c8:1946]'],
    ['[::ffff:93.184.216.34]'],
  ])('a public literal is still answered without a lookup: %s', async (host) => {
    const dns = { lookup: () => { throw new Error('no DNS is needed for a literal address'); } };
    const verdict = await checkConnectionPolicy(`postgres://app@${host}:5432/db`, { env: {}, dns });
    expect(verdict.allowed).toBe(true);
  });

  // ::1 and fe80:: in their other spellings: being a *literal* is not the same
  // question as being *public, and the literal check must not cost them a round trip.
  test.each(['0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '::ffff:0:0'])
    ('a private IPv6 literal in another spelling is refused without a lookup: %s', async (host) => {
      const dns = { lookup: () => { throw new Error('no DNS is needed for a literal address'); } };
      const verdict = await checkConnectionPolicy(`postgres://app@[${host}]:5432/db`, { env: {}, dns });
      expect(verdict.allowed).toBe(false);
    });
});

describe('SQLite path policy', () => {
  const strict = { ANYDB_STRICT_SQLITE_PATHS: '1' };

  test('unrestricted by default, with a warning that says what the risk is', () => {
    const messages = [];
    const verdict = checkSqlitePathPolicy('/data/app.db', { env: {}, log: (m) => messages.push(m) });
    expect(verdict.allowed).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/any file this process can open/);
      // Once per process.
    checkSqlitePathPolicy('/other.db', { env: {}, log: (m) => messages.push(m) });
    expect(messages).toHaveLength(1);
  });

  test('ANYDB_STRICT_SQLITE_PATHS=1 inverts the default', () => {
    const verdict = checkSqlitePathPolicy('/data/app.db', { env: strict, log: noLog });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/ANYDB_STRICT_SQLITE_PATHS=1 is set/);
    expect(verdict.reason).toMatch(/ANYDB_ALLOWED_SQLITE_PATHS/);
  });

  test('an in-memory database touches no file and is always allowed', () => {
    for (const target of [':memory:', 'file::memory:']) {
      expect(checkSqlitePathPolicy(target, { env: strict, log: noLog }).allowed).toBe(true);
    }
  });

  test('a relative path is refused rather than resolved against the working directory', () => {
    const verdict = checkSqlitePathPolicy('./app.db', { env: {}, log: noLog, platform: 'linux' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/not an absolute path/);
    expect(verdict.reason).toMatch(/resolved against the/);
  });

  test('a per-profile allowedPaths is honoured', () => {
    const profile = { name: 'local', allowedPaths: ['/data/db'] };
    expect(checkSqlitePathPolicy('/data/db/app.db', { env: strict, profile, log: noLog }).allowed).toBe(true);
    expect(checkSqlitePathPolicy('/data/db', { env: strict, profile, log: noLog }).allowed).toBe(true);
    expect(checkSqlitePathPolicy('/etc/shadow', { env: strict, profile, log: noLog }).allowed).toBe(false);
  });

  test('ANYDB_ALLOWED_SQLITE_PATHS is honoured globally', () => {
    const env = { ...strict, ANYDB_ALLOWED_SQLITE_PATHS: '/srv/data, /mnt/other' };
    expect(checkSqlitePathPolicy('/srv/data/app.db', { env, log: noLog }).allowed).toBe(true);
    expect(checkSqlitePathPolicy('/mnt/other/x.db', { env, log: noLog }).allowed).toBe(true);
    expect(checkSqlitePathPolicy('/srv/database/app.db', { env, log: noLog }).allowed).toBe(false);
  });

  // A sibling directory sharing a name prefix is where a private key usually lives.
  test('matching is on a path-segment boundary, not a string prefix', () => {
    const profile = { name: 'local', allowedPaths: ['/data/db'] };
    expect(checkSqlitePathPolicy('/data/db/app.db', { env: strict, profile, log: noLog }).allowed).toBe(true);
    expect(checkSqlitePathPolicy('/data/db2/secret.db', { env: strict, profile, log: noLog }).allowed).toBe(false);
    expect(checkSqlitePathPolicy('/data/db2', { env: strict, profile, log: noLog }).allowed).toBe(false);
    expect(checkSqlitePathPolicy('/data/db-2/app.db', { env: strict, profile, log: noLog }).allowed).toBe(false);
  });

  test('traversal cannot climb out of an allowed directory', () => {
    const profile = { name: 'local', allowedPaths: ['/data/db'] };
    expect(checkSqlitePathPolicy('/data/db/../db2/app.db', { env: strict, profile, log: noLog }).allowed).toBe(false);
    expect(checkSqlitePathPolicy('/data/db/../secrets', { env: strict, profile, log: noLog }).allowed).toBe(false);
  });

  test('isPathWithin is case-insensitive on Windows only', () => {
    expect(isPathWithin('C:/Data/DB/app.db', 'c:/data/db', 'win32')).toBe(true);
    expect(isPathWithin('/data/db/app.db', '/DATA/DB', 'linux')).toBe(false);
    expect(isPathWithin('/data/db/app.db', '/data/db', 'linux')).toBe(true);
  });

  // Containment is a textual test and text cannot see a link, so an allowlisted
  // directory holding a link elsewhere admits it. The only test here that touches
  // the filesystem, because it is the only claim about the filesystem.
  test('a symlink out of the allowlisted directory is refused', () => {
    const real = process.platform === 'win32' ? nodePath.win32 : nodePath.posix;
    const root = real.join(os.tmpdir(), `anydb-policy-${process.pid}-${counter++}`);
    const inside = real.join(root, 'db');
    const outside = real.join(root, 'secrets');
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(real.join(outside, 'id_rsa'), 'PRIVATE KEY');
    try {
      // A junction on Windows, a symbolic link elsewhere. `type` is ignored on
      // Windows, where mklink is a junction either way.
      fs.symlinkSync(outside, real.join(inside, 'link'), 'junction');

      const env = { ANYDB_ALLOWED_SQLITE_PATHS: inside };
      const viaLink = checkSqlitePathPolicy(real.join(inside, 'link', 'id_rsa'), { env, log: noLog });
      expect(viaLink.allowed).toBe(false);
      expect(viaLink.reason).toMatch(/symbolic link/);

      // A real file inside the directory is still allowed, so the check is not
      // simply refusing everything that resolves.
      fs.writeFileSync(real.join(inside, 'app.db'), '');
      const direct = checkSqlitePathPolicy(real.join(inside, 'app.db'), { env, log: noLog });
      expect(direct.allowed).toBe(true);

      // And a file that does not exist yet, which is the ordinary case for a
      // database being created, is checked through its nearest existing parent
      // rather than being waved through.
      const notYet = checkSqlitePathPolicy(real.join(inside, 'new', 'deep', 'app.db'), { env, log: noLog });
      expect(notYet.allowed).toBe(true);
      const notYetOutside = checkSqlitePathPolicy(real.join(inside, 'link', 'new', 'app.db'), { env, log: noLog });
      expect(notYetOutside.allowed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('an allowlist root that is itself a symlink still matches', () => {
    // The real path is resolved on both sides, so an allowlist entry that is a link
    // to a mounted volume still matches. The allowlist is still *textual* first: a
    // path named through the real directory is a different string and is refused.
    const real = process.platform === 'win32' ? nodePath.win32 : nodePath.posix;
    const root = real.join(os.tmpdir(), `anydb-policy-${process.pid}-${counter++}`);
    const mount = real.join(root, 'volume');
    const link = real.join(root, 'db');
    fs.mkdirSync(mount, { recursive: true });
    fs.writeFileSync(real.join(mount, 'app.db'), '');
    try {
      fs.symlinkSync(mount, link, 'junction');
      const env = { ANYDB_ALLOWED_SQLITE_PATHS: link };
      expect(checkSqlitePathPolicy(real.join(link, 'app.db'), { env, log: noLog }).allowed).toBe(true);
      expect(checkSqlitePathPolicy(real.join(link, 'not-created-yet.db'), { env, log: noLog }).allowed).toBe(true);
      expect(checkSqlitePathPolicy(real.join(mount, 'app.db'), { env, log: noLog }).allowed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('checkConnectionPolicy routes a sqlite:// URI through the path gate', async () => {
    const allowed = await checkConnectionPolicy('sqlite:///data/app.db', { env: {}, dns: PUBLIC, log: noLog });
    expect(allowed.allowed).toBe(true);
    expect(allowed.resolved).toEqual([]);
    expect(allowed.host).toBe('');

    const refused = await checkConnectionPolicy('sqlite:///etc/shadow', {
      env: { ANYDB_ALLOWED_SQLITE_PATHS: '/data' },
      dns: PUBLIC,
      log: noLog,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toMatch(/outside every allowed SQLite path/);
  });

  // `platform: 'win32'` selects the Windows path rules, but the fixture also has
  // to exist: the allowlist check resolves both sides against the real
  // filesystem so a symlink cannot leave the tree. A `C:` root cannot be created
  // off Windows, and a POSIX temp dir under `path.win32` is a path with no drive,
  // so `resolve` falls back to the working directory. The host-independent half
  // of this -- an absolute path is not treated as relative -- is covered by the
  // POSIX cases above and below.
  const onWindows = process.platform === 'win32' ? test : test.skip;

  onWindows('the Windows slash before a drive letter is not a relative path', async () => {
    const dir = nodePath.win32.join(os.tmpdir(), `anydb-drive-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      // The allowlist is the fixture directory, so the only thing under test is
      // whether `C:/...` was read as an absolute path or resolved against the
      // working directory. A relative reading would resolve somewhere else and be
      // refused.
      const target = nodePath.win32.join(dir, 'app.db').replace(/\\/g, '/');
      const verdict = await checkConnectionPolicy(`sqlite:///${target}`, {
        env: { ANYDB_ALLOWED_SQLITE_PATHS: dir },
        dns: PUBLIC,
        log: noLog,
        platform: 'win32',
      });
      expect(verdict.allowed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ad-hoc URI switch', () => {
  test('it defaults to on, which is what 2.x did', () => {
    expect(isAdHocUriAllowed({})).toBe(true);
    expect(isAdHocUriAllowed({ ANYDB_ALLOW_ADHOC_URI: '' })).toBe(true);
  });

  test.each(['1', 'true', 'yes', 'on', 'TRUE', 'Yes', ' on '])('%s turns it on', (value) => {
    expect(isAdHocUriAllowed({ ANYDB_ALLOW_ADHOC_URI: value })).toBe(true);
  });

  test.each(['0', 'false', 'no', 'off', 'FALSE', 'No', ' off '])('%s turns it off', (value) => {
    expect(isAdHocUriAllowed({ ANYDB_ALLOW_ADHOC_URI: value })).toBe(false);
  });

  test('a value it does not recognise falls back to the documented default', () => {
    expect(isAdHocUriAllowed({ ANYDB_ALLOW_ADHOC_URI: 'maybe' })).toBe(true);
    expect(parseBoolEnv(undefined, false)).toBe(false);
    expect(parseBoolEnv('nope', true)).toBe(true);
  });
});

describe('classifiesAsDestructive', () => {
  test.each([
    ['DROP TABLE users', 'postgres'],
    ['drop table users', 'postgres'],
    ['TRUNCATE users', 'postgres'],
    ['ALTER TABLE users ADD COLUMN b INT', 'postgres'],
    ['CREATE TABLE t (a INT)', 'postgres'],
    ['CREATE INDEX ix ON t (a)', 'mysql'],
    ['RENAME TABLE a TO b', 'mysql'],
    ['GRANT ALL ON db TO bob', 'postgres'],
    ['REVOKE ALL ON db FROM bob', 'postgres'],
    ['DROP TABLE t', 'postgresql'],
    ['DROP TABLE t', 'mysql+pymysql'],
    ['DROP TABLE t', 'sqlite'],
    ['DROP TABLE t', 'sqlite+pysqlite'],
  ])('%s is destructive', (query, protocol) => {
    expect(classifiesAsDestructive(query, protocol).destructive).toBe(true);
  });

  // The distinction the second gate exists for: `readOnly: false` is what a job
  // needs to append a row, so a second flag for that would make it meaningless.
  // It is the same distinction on every backend. MongoDB's `insert` was briefly
  // in the destructive set -- built from the write-action list rather than from
  // the DDL-like names -- so the same row could be added to Postgres with one
  // flag and to MongoDB with two.
  test.each([
    'DELETE FROM users',
    'UPDATE users SET a = 1',
    'INSERT INTO users (a) VALUES (1)',
    'REPLACE INTO users (a) VALUES (1)',
    'MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN UPDATE SET a = 1',
  ])('%s is a write but not destructive', (query) => {
    expect(classifiesAsDestructive(query, 'postgres').destructive).toBe(false);
  });

  test.each(['insert', 'update', 'updateOne', 'replace', 'delete', 'deleteOne'])(
    'the MongoDB "%s" action is a write, not destructive',
    (action) => {
      expect(classifiesAsDestructive('{}', 'mongodb', { action }).destructive).toBe(false);
    }
  );

  test.each(['drop', 'dropDatabase', 'create', 'createIndex'])(
    'the MongoDB "%s" action is destructive',
    (action) => {
      expect(classifiesAsDestructive('{}', 'mongodb', { action }).destructive).toBe(true);
    }
  );

  test('a $out stage is destructive in every mode', () => {
    expect(classifiesAsDestructive('[{"$out":"c"}]', 'mongodb', { action: 'aggregate' }).destructive).toBe(true);
  });

  test('the reason names the verb', () => {
    const verdict = classifiesAsDestructive('DROP TABLE users', 'postgres');
    expect(verdict.destructive).toBe(true);
    expect(verdict.reason).toMatch(/^DROP changes schema or privileges/);
  });

  test.each([
    'SELECT * FROM users',
    'select id from users where id = 1',
    'SHOW TABLES',
    'EXPLAIN SELECT 1',
  ])('%s is not destructive', (query) => {
    expect(classifiesAsDestructive(query, 'postgres').destructive).toBe(false);
  });

  test('a write hidden inside a CTE is caught by the destructive gate', () => {
    // The leading keyword is not the whole statement, but this one has no
    // destructive verb, so it is a plain write and passes the second gate.
    const query = 'WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone';
    expect(classifiesAsDestructive(query, 'postgres').destructive).toBe(false);
  });

  test('a destructive verb inside a CTE is still caught', () => {
    const query = 'WITH x AS (SELECT 1) DROP TABLE orders';
    expect(classifiesAsDestructive(query, 'postgres').destructive).toBe(true);
  });

  // False positives that scanning the whole statement would produce if the noise
  // were not stripped first.
  test.each([
    ["SELECT 'DROP TABLE users' AS note", 'postgres'],
    ['SELECT * FROM created_orders', 'postgres'],
    ['SELECT COUNT(*) AS delete_count FROM audit', 'postgres'],
    ['SELECT grant_count FROM grants', 'postgres'],
    ['SELECT 1 -- DROP TABLE users', 'postgres'],
    ['SELECT 1 /* DROP TABLE users */', 'postgres'],
    ['SELECT 1 # DROP TABLE users', 'mysql'],
    ['SELECT "drop table" FROM notes', 'postgres'],
    ['SELECT * FROM `drop me`', 'mysql'],
    ["SELECT 'it''s fine' AS s", 'postgres'],
  ])('%s is not destructive', (query, protocol) => {
    expect(classifiesAsDestructive(query, protocol).destructive).toBe(false);
  });

  test('a MySQL conditional comment is destructive, because its contents cannot be read', () => {
    const verdict = classifiesAsDestructive('SELECT 1 /*!40001 , 1 */', 'mysql');
    expect(verdict.destructive).toBe(true);
    expect(verdict.reason).toMatch(/conditional comments/);
  });

  test('a hidden verb in a conditional comment is caught', () => {
    expect(classifiesAsDestructive('SELECT /*!DROP;*/ 1', 'mysql').destructive).toBe(true);
  });

  test('the literal trade-off is documented: a column named create is refused', () => {
    // A false positive is a refusal, the direction this codebase refuses in
    // everywhere else.
    expect(classifiesAsDestructive('SELECT create FROM t', 'postgres').destructive).toBe(true);
    // An underscore is a word character, so the common shapes are not hit.
    expect(classifiesAsDestructive('SELECT created_at, drop_count FROM t', 'postgres').destructive).toBe(false);
  });

  describe('MongoDB', () => {
    // Data writes are what `readOnly: false` is for, and a MongoDB `insert` is
    // the same operation as a SQL `INSERT` -- which the block above already
    // requires only one flag for. These were classified as destructive, built
    // from the write-action list rather than from the names that change a
    // collection's structure, so the same row needed two flags on MongoDB and one
    // on every SQL backend. `scripts/live-adapters.mjs` assumed the SQL rule and
    // failed, which is what surfaced it.
    test.each(['insert', 'update', 'updateOne', 'replace', 'delete', 'deleteOne'])(
      'the %s action is a write, not destructive',
      (action) => {
        expect(classifiesAsDestructive('{"a":1}', 'mongodb', { action }).destructive).toBe(false);
        expect(classifiesAsDestructive('{"a":1}', 'mongodb+srv', { action }).destructive).toBe(false);
      }
    );

    test.each(['drop', 'dropDatabase', 'create', 'createIndex'])(
      'the %s action changes a collection and is destructive',
      (action) => {
        expect(classifiesAsDestructive('{"a":1}', 'mongodb', { action }).destructive).toBe(true);
        expect(classifiesAsDestructive('{"a":1}', 'mongodb+srv', { action }).destructive).toBe(true);
      }
    );

    test.each(['find', 'count', 'distinct', 'aggregate', 'explain'])('the %s action is not', (action) => {
      expect(classifiesAsDestructive('{"a":1}', 'mongodb', { action }).destructive).toBe(false);
    });

    test('the action defaults to find, because the payload does not say', () => {
      expect(classifiesAsDestructive('{"a":1}', 'mongodb').destructive).toBe(false);
    });

    test.each(['$out', '$merge'])('a %s stage is destructive', (stage) => {
      const pipeline = JSON.stringify([{ $match: {} }, { [stage]: 'target' }]);
      expect(classifiesAsDestructive(pipeline, 'mongodb', { action: 'aggregate' }).destructive).toBe(true);
    });

    test('a write stage nested inside a facet is still found', () => {
      const pipeline = JSON.stringify([{ $facet: { a: [{ $out: 'copy' }] } }]);
      expect(classifiesAsDestructive(pipeline, 'mongodb', { action: 'aggregate' }).destructive).toBe(true);
    });

    test('a read-only pipeline is not destructive', () => {
      const pipeline = JSON.stringify([{ $match: { a: 1 } }, { $group: { _id: '$a' } }]);
      expect(classifiesAsDestructive(pipeline, 'mongodb', { action: 'aggregate' }).destructive).toBe(false);
    });

    test('an unparseable payload is decided by the action alone', () => {
      // The payload does not change what the action does, so there is nothing
      // here to read. A write action is still a write, and `readOnly: false` is
      // what it needs.
      expect(classifiesAsDestructive('{not json', 'mongodb', { action: 'insert' }).destructive).toBe(false);
      expect(classifiesAsDestructive('{not json', 'mongodb', { action: 'drop' }).destructive).toBe(true);
      expect(classifiesAsDestructive('{not json', 'mongodb', { action: 'find' }).destructive).toBe(false);
    });
  });

  describe('Redis', () => {
    test.each(['FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'CONFIG SET maxmemory 0', 'DEBUG SLEEP 0', 'MODULE LOAD x', 'CLUSTER RESET', 'MIGRATE h 0 k', 'RESTORE k 0 x', 'REPLICAOF h 1', 'SAVE'])(
      '%s is destructive', (command) => {
        expect(classifiesAsDestructive(command, 'redis').destructive).toBe(true);
        expect(classifiesAsDestructive(command, 'rediss').destructive).toBe(true);
      }
    );

    test.each(['GET key', 'MGET a b', 'SCAN 0', 'HGETALL h', 'INFO', 'TTL k'])('%s is not', (command) => {
      expect(classifiesAsDestructive(command, 'redis').destructive).toBe(false);
    });
  });

  test('a non-string or empty statement is not classified, and says so', () => {
    expect(classifiesAsDestructive('', 'postgres').reason).toMatch(/non-empty string/);
    expect(classifiesAsDestructive(null, 'postgres').reason).toMatch(/non-empty string/);
    expect(classifiesAsDestructive(undefined, 'postgres').destructive).toBe(false);
  });

  test('an unknown protocol is not classifiable, and the reason says so', () => {
    const verdict = classifiesAsDestructive('DROP TABLE t', 'cassandra');
    expect(verdict.destructive).toBe(false);
    expect(verdict.reason).toMatch(/not classifiable/);
  });
});

describe('evaluatePolicy', () => {
  test('a profile that says nothing gets the safe defaults', () => {
    const policy = evaluatePolicy(null, { env: {} });
    expect(policy).toMatchObject({
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
  });

  test('the documented fields are always present, even for an empty profile', () => {
    const policy = evaluatePolicy({}, { env: {} });
    for (const field of Object.keys(POLICY_DEFAULTS)) {
      expect(policy).toHaveProperty(field);
    }
  });

  test('a profile overrides the defaults', () => {
    const policy = evaluatePolicy({ readOnly: false, maxRows: 50, hosts: ['a.example.com'] }, { env: {} });
    expect(policy.readOnly).toBe(false);
    expect(policy.maxRows).toBe(50);
    expect(policy.hosts).toEqual(['a.example.com']);
  });

  test('the environment sits under the profile, and the call sits under both', () => {
    const env = { ANYDB_DEFAULT_MAX_ROWS: '10', ANYDB_DEFAULT_MAX_BYTES: '2048' };
    expect(evaluatePolicy(null, { env }).maxRows).toBe(10);
    expect(evaluatePolicy({ maxRows: 20 }, { env }).maxRows).toBe(20);
    expect(evaluatePolicy({ maxRows: 20 }, { env, options: { maxRows: 30 } }).maxRows).toBe(30);
  });

  test('a nonsense number falls back rather than disabling the limit', () => {
    expect(evaluatePolicy({ maxRows: 'lots' }, { env: {} }).maxRows).toBe(1000);
    expect(evaluatePolicy({ maxRows: 0 }, { env: {} }).maxRows).toBe(1000);
    expect(evaluatePolicy({ maxRows: -1 }, { env: {} }).maxRows).toBe(1000);
  });

  test('a call argument of readOnly:false is honoured, not treated as absent', () => {
    expect(evaluatePolicy({ readOnly: true }, { env: {}, options: { readOnly: false } }).readOnly).toBe(false);
  });

  test('timeout is accepted as an alias for queryTimeoutMs', () => {
    expect(evaluatePolicy(null, { env: {}, options: { timeout: 1234 } }).queryTimeoutMs).toBe(1234);
  });

  describe('the destructive gate', () => {
    const DESTRUCTIVE = 'DROP TABLE users';
    const WRITE = "INSERT INTO users (a) VALUES (1)";

    test('a destructive statement needs readOnly:false AND allowDestructive:true', () => {
      const readOnly = evaluatePolicy({}, { env: {}, query: DESTRUCTIVE, options: { protocol: 'postgres' } });
      expect(readOnly.destructive).toBe(true);
      expect(readOnly.destructiveAllowed).toBe(false);
      expect(readOnly.destructiveBlockReason).toMatch(/need both/);

      const writable = evaluatePolicy({ readOnly: false }, { env: {}, query: DESTRUCTIVE, options: { protocol: 'postgres' } });
      expect(writable.destructiveAllowed).toBe(false);

      const both = evaluatePolicy(
        { readOnly: false, allowDestructive: true },
        { env: {}, query: DESTRUCTIVE, options: { protocol: 'postgres' } }
      );
      expect(both.destructiveAllowed).toBe(true);
      expect(both.destructiveBlockReason).toBe('');
    });

    test('allowDestructive on its own does not open a read-only profile', () => {
      const policy = evaluatePolicy({ allowDestructive: true }, { env: {}, query: DESTRUCTIVE, options: { protocol: 'postgres' } });
      expect(policy.readOnly).toBe(true);
      expect(policy.destructiveAllowed).toBe(false);
    });

    test('a plain write is allowed once readOnly is off, without the second flag', () => {
      const policy = evaluatePolicy({ readOnly: false }, { env: {}, query: WRITE, options: { protocol: 'postgres' } });
      expect(policy.destructive).toBe(false);
      expect(policy.destructiveAllowed).toBe(true);
    });

    test('ANYDB_ALLOW_DESTRUCTIVE is the process-wide opt-in', () => {
      const policy = evaluatePolicy(
        { readOnly: false },
        { env: { ANYDB_ALLOW_DESTRUCTIVE: '1' }, query: DESTRUCTIVE, options: { protocol: 'postgres' } }
      );
      expect(policy.destructiveAllowed).toBe(true);
    });

    test('a MongoDB write needs only the read-only flag, like a SQL write', () => {
      const policy = evaluatePolicy(
        { readOnly: false },
        { env: {}, query: '{"a":1}', options: { protocol: 'mongodb', action: 'delete' } }
      );
      expect(policy.destructive).toBe(false);
      expect(policy.destructiveAllowed).toBe(true);
    });

    test('a MongoDB drop needs both, like a SQL DROP', () => {
      const policy = evaluatePolicy(
        { readOnly: false },
        { env: {}, query: '{"a":1}', options: { protocol: 'mongodb', action: 'drop' } }
      );
      expect(policy.destructive).toBe(true);
      expect(policy.destructiveAllowed).toBe(false);
    });

    test('no query means nothing to classify', () => {
      const policy = evaluatePolicy({ readOnly: false, allowDestructive: true }, { env: {} });
      expect(policy.destructive).toBe(false);
      expect(policy.destructiveAllowed).toBe(true);
    });

    test('the protocol comes from the profile driver when the call does not name one', () => {
      const policy = evaluatePolicy({ driver: 'postgres' }, { env: {}, query: DESTRUCTIVE });
      expect(policy.destructive).toBe(true);
    });
  });
});

describe('helpers', () => {
  test('CREDENTIAL_QUERY_PARAMS covers the names that actually carry secrets', () => {
    expect(CREDENTIAL_QUERY_PARAMS).toContain('password');
    expect(CREDENTIAL_QUERY_PARAMS).toContain('sslpassword');
    expect(CREDENTIAL_QUERY_PARAMS).not.toContain('ssl');
    expect(CREDENTIAL_QUERY_PARAMS).not.toContain('replicaSet');
  });

  test('DEFAULT_ALLOWED_SCHEMES matches the set the registry routes', () => {
    for (const scheme of ['postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'redis', 'rediss', 'mysql+pymysql', 'sqlite+pysqlite']) {
      expect(DEFAULT_ALLOWED_SCHEMES).toContain(scheme);
    }
  });
});
