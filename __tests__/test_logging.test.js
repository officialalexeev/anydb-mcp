import { maskUri, describeQuery, log, logQueryDetail, isDebugEnabled } from '../src/core/logging.js';

const withDebugEnv = (value, fn) => {
  const previous = process.env.ANYDB_DEBUG;
  if (value === undefined) delete process.env.ANYDB_DEBUG;
  else process.env.ANYDB_DEBUG = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.ANYDB_DEBUG;
    else process.env.ANYDB_DEBUG = previous;
  }
};

describe('log sanitisation', () => {
  describe('maskUri', () => {
    test('removes a PostgreSQL password', () => {
      expect(maskUri('postgres://user:s3cr3t@host:5432/db'))
        .toBe('postgres://user:***@host:5432/db');
    });

    test('removes a MySQL password', () => {
      expect(maskUri('mysql://root:letmein@127.0.0.1:3306/mydb'))
        .toBe('mysql://root:***@127.0.0.1:3306/mydb');
    });

    test('removes a Redis password-only URI', () => {
      expect(maskUri('redis://:s3cr3t@host:6379')).toBe('redis://:***@host:6379');
    });

    test('never leaves the password anywhere in the output', () => {
      const masked = maskUri('postgres://user:hunter2@prod.db.internal:5432/analytics');
      expect(masked).not.toContain('hunter2');
    });

    test('redacts the query string, which can carry credentials', () => {
      // MongoDB and Redis both accept credentials in query parameters.
      const masked = maskUri('mongodb://host/db?authMechanismProperties=AWS_SESSION_TOKEN:abc123');
      expect(masked).not.toContain('abc123');
      expect(masked).toContain('redacted');
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

    test('leaves a user with no password alone', () => {
      expect(maskUri('postgres://readonly@host/db')).toBe('postgres://readonly@host/db');
    });

    test('handles a non-URI value without throwing', () => {
      expect(maskUri('')).toBe('');
      expect(maskUri(undefined)).toBe('undefined');
      expect(maskUri(42)).toBe('42');
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
  });
});
describe('log', () => {
  let written;

  beforeEach(() => {
    written = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => written.push(args.join(' ')));
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  test('prefixes output so lines are attributable', () => {
    log('server ready', { version: '1.0.1' });
    expect(written[0]).toBe('[anydb] server ready version=1.0.1');
  });

  test('works with no detail', () => {
    log('bare message');
    expect(written[0]).toBe('[anydb] bare message');
  });

  test('truncates a long value', () => {
    log('query', { text: 'x'.repeat(500) });
    expect(written[0].length).toBeLessThan(200);
    expect(written[0]).toMatch(/\.\.\.$/);
  });

  test('logs query text only when ANYDB_DEBUG is on', () => {
    const uri = 'postgres://user:hunter2@host:5432/db';
    const query = 'SELECT secret FROM users';

    withDebugEnv(undefined, () => logQueryDetail(uri, query));
    expect(written).toHaveLength(0);

    withDebugEnv('1', () => logQueryDetail(uri, query));
    expect(written[0]).toContain('SELECT secret FROM users');
    expect(written[0]).not.toContain('hunter2'); // still masked
  });

  test('treats debug as off for any value other than 1 or true', () => {
    withDebugEnv('yes', () => logQueryDetail('postgres://h/d', 'SELECT 1'));
    expect(written).toHaveLength(0);
  });

  test.each([
    ['1', true], ['true', true], ['0', false], [undefined, false]
  ])('isDebugEnabled with ANYDB_DEBUG=%s', (value, expected) => {
    expect(withDebugEnv(value, () => isDebugEnabled())).toBe(expected);
  });
});