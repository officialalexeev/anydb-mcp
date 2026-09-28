import { inspectQuery, inspectSql, inspectRedisCommand, inspectMongoOperation, stripSqlNoise, hasMultipleStatements } from '../src/core/safety.js';

describe('read-only safety guard', () => {
  describe('stripSqlNoise', () => {
    test('removes string literals', () => {
      expect(stripSqlNoise("SELECT 'DROP TABLE t' AS s")).not.toMatch(/DROP/);
    });

    test('removes line and block comments', () => {
      expect(stripSqlNoise('SELECT 1 -- DROP TABLE t')).not.toMatch(/DROP/);
      expect(stripSqlNoise('SELECT 1 /* DROP TABLE t */')).not.toMatch(/DROP/);
      expect(stripSqlNoise('SELECT 1 # DROP TABLE t')).not.toMatch(/DROP/);
    });

    test('reads MySQL string escapes, which is what its server does', () => {
      const out = stripSqlNoise("SELECT * FROM t WHERE a = 'it\\'s fine' AND b = 1", { backslashEscapes: true });
      expect(out).toContain('b = 1');
    });

    test('ends a Postgres string at the quote, since a backslash is literal', () => {
      // standard_conforming_strings is on, so 'it\' is a complete literal and
      // what follows is real SQL. Treating the backslash as an escape here is
      // what let a trailing statement hide from hasMultipleStatements.
      const out = stripSqlNoise("SELECT * FROM t WHERE a = 'it\\'; DROP TABLE t; --'");
      expect(out).toMatch(/DROP TABLE t/);
    });

    test('handles doubled single quotes', () => {
      const out = stripSqlNoise("SELECT 'it''s fine' AS s");
      expect(out).toContain('s');
    });

    test('replaces quoted identifiers rather than leaving their contents', () => {
      expect(stripSqlNoise('SELECT * FROM `drop me`')).not.toMatch(/drop me/);
    });

    test('keeps MySQL conditional comments detectable as executable', () => {
      expect(stripSqlNoise('SELECT 1 /*!40001 , 1 */')).toMatch(/CONDITIONAL_COMMENT/);
    });
  });

  describe('inspectSql', () => {
    test.each([
      'SELECT * FROM users',
      'select id from users where id = 1',
      'SHOW TABLES',
      'SHOW CREATE TABLE users',
      'DESCRIBE users',
      'DESC users',
      'EXPLAIN SELECT 1',
      'WITH recent AS (SELECT 1) SELECT * FROM recent',
      'VALUES (1), (2)',
    ])('allows %s', (sql) => {
      expect(inspectSql(sql).safe).toBe(true);
    });

    test.each([
      'DROP TABLE users',
      'DROP DATABASE production',
      'TRUNCATE users',
      'DELETE FROM users',
      'INSERT INTO users (a) VALUES (1)',
      'UPDATE users SET a = 1',
      'CREATE TABLE t (a INT)',
      'ALTER TABLE users ADD COLUMN b INT',
      'GRANT ALL ON db TO bob',
      'REVOKE ALL ON db FROM bob',
      'COPY users TO PROGRAM \'rm -rf /\'',
      'VACUUM',
      'PRAGMA journal_mode = WAL',
      'SET ROLE admin',
      'CALL do_something()',
      'LOCK TABLE users',
    ])('blocks %s', (sql) => {
      expect(inspectSql(sql).safe).toBe(false);
    });

    test.each([
      ['SELECT * FROM created_orders', 'a table name with a write keyword in it'],
      ['SELECT COUNT(*) AS delete_count FROM audit', 'an alias that looks like a write'],
      ["SELECT * FROM t WHERE note = 'deleted'", 'a write keyword inside a literal'],
      ['SELECT 1 -- DROP TABLE t', 'a write keyword inside a comment'],
      ['SELECT 1 /* DROP TABLE t */', 'a write keyword inside a block comment']
    ])('allows %s (%s)', (sql) => {
      expect(inspectSql(sql).safe).toBe(true);
    });

    test('blocks a write hidden in a MySQL conditional comment', () => {
      // The comment body is executed by the server, so it cannot be waved off.
      const result = inspectSql('SELECT 1 /*!40001 ,(SELECT 1) */');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/conditional comment/i);
    });

    test.each([
      ['SELECT * INTO OUTFILE \'/tmp/x\' FROM users', /OUTFILE/],
      ['SELECT * INTO DUMPFILE \'/tmp/x\' FROM users', /DUMPFILE/],
      ['SELECT * FROM users FOR UPDATE', /row-locking/],
      ['SELECT * FROM users FOR SHARE', /row-locking/],
      ['SELECT * FROM users FOR NO KEY UPDATE', /row-locking/],
      ['SELECT * FROM users LOCK IN SHARE MODE', /LOCK IN SHARE MODE/],
    ])('blocks %s', (sql, pattern) => {
      const result = inspectSql(sql);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(pattern);
    });

    test('blocks an empty or comment-only statement', () => {
      expect(inspectSql('').safe).toBe(false);
      expect(inspectSql('   ').safe).toBe(false);
      expect(inspectSql('-- nothing here').safe).toBe(false);
    });

    test('distinguishes a typo from a deliberate write', () => {
      expect(inspectSql('SELEC 1').reason).toMatch(/typo/i);
      expect(inspectSql('DROP TABLE t').reason).toMatch(/modifies data or schema/i);
    });
  });

  describe('inspectRedisCommand', () => {
    test.each([
      'GET key', 'MGET a b c', 'HGETALL user:1', 'HMGET h a b', 'LRANGE l 0 -1',
      'SCAN 0 MATCH user:* COUNT 100', 'TTL key', 'EXISTS a', 'DBSIZE',
      'ZRANGE z 0 -1 WITHSCORES', 'SMEMBERS s', 'XLEN stream',
    ])('allows %s', (cmd) => {
      expect(inspectRedisCommand(cmd).safe).toBe(true);
    });

    test.each([
      'SET k v', 'DEL k', 'FLUSHDB', 'FLUSHALL', 'KEYS *', 'CONFIG GET maxmemory',
      'SHUTDOWN NOSAVE', 'EVAL "return 1" 0', 'INCR counter', 'HSET h f v',
      'EXPIRE k 10', 'LPUSH l a', 'SADD s a', 'ZADD z 1 m', 'MOVE k 1',
      'DEBUG SLEEP 5', 'SCRIPT LOAD x', 'CLUSTER MEET 1.2.3.4 6379',
    ])('blocks %s', (cmd) => {
      expect(inspectRedisCommand(cmd).safe).toBe(false);
    });

    test('blocks KEYS because it blocks the server on a large keyspace', () => {
      expect(inspectRedisCommand('KEYS *').safe).toBe(false);
    });

    test('allows the non-blocking alternative', () => {
      expect(inspectRedisCommand('SCAN 0 MATCH user:* COUNT 100').safe).toBe(true);
    });

    test('blocks an empty command', () => {
      expect(inspectRedisCommand('   ').safe).toBe(false);
    });
  });

  describe('inspectMongoOperation', () => {
    test.each([
      ['{}', 'find'],
      ['{"status":"active"}', 'find'],
      ['{"age":{"$gt":21}}', 'find'],
      ['{"$and":[{"a":1},{"b":2}]}', 'find'],
      ['{"nested":{"deep":{"$in":[1,2,3]}}}', 'find'],
      ['[{"$match":{}}]', 'aggregate'],
      ['[{"$match":{}},{"$group":{"_id":"$a"}}]', 'aggregate']
    ])('allows %s as %s', (payload, action) => {
      expect(inspectMongoOperation(payload, action)).toEqual({ safe: true, reason: '' });
    });

    test('defaults to the find action', () => {
      expect(inspectMongoOperation('{}').safe).toBe(true);
      expect(inspectMongoOperation('{}', undefined).safe).toBe(true);
    });

    test.each(['insert', 'update', 'delete'])('blocks the %s action', (action) => {
      const result = inspectMongoOperation('{}', action);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/modifies data/);
    });

    test('rejects an unknown action', () => {
      expect(inspectMongoOperation('{}', 'drop').safe).toBe(false);
    });

    test.each(['$where', '$function', '$accumulator'])('blocks server-side JS via %s', (op) => {
      const result = inspectMongoOperation(JSON.stringify({ [op]: 'this.a == 1' }));
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/JavaScript/);
    });

    test('finds a nested JavaScript operator', () => {
      expect(inspectMongoOperation('{"a":{"b":{"$where":"1"}}}').safe).toBe(false);
    });

    test('rejects invalid JSON', () => {
      const result = inspectMongoOperation('not json');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/valid JSON/i);
    });

    test.each([['[1,2]'], ['"a string"'], ['null'], ['42']])('rejects the filter %s', (filter) => {
      expect(inspectMongoOperation(filter, 'find').safe).toBe(false);
    });

    test.each(['$out', '$merge'])('blocks the %s stage', (stage) => {
      const result = inspectMongoOperation(JSON.stringify([{ $match: {} }, { [stage]: 'target' }]), 'aggregate');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(new RegExp(stage.replace('$', '\\$')));
    });

    test('permits write stages when explicitly allowed', () => {
      expect(inspectMongoOperation('[{"$out":"t"}]', 'aggregate', { allowWriteStages: true }).safe).toBe(true);
    });

    test('blocks a write stage nested deeper in the pipeline', () => {
      const result = inspectMongoOperation('[{"$facet":{"a":[{"$merge":{"into":"x"}}]}}]', 'aggregate');
      expect(result.safe).toBe(false);
    });

    test('rejects an empty or non-array pipeline', () => {
      expect(inspectMongoOperation('[]', 'aggregate').safe).toBe(false);
      expect(inspectMongoOperation('{}', 'aggregate').safe).toBe(false);
    });
  });

  describe('inspectQuery routing', () => {
    test.each(['postgres', 'postgresql', 'mysql', 'sqlite'])('routes %s to the SQL check', (proto) => {
      expect(inspectQuery(proto, 'DROP TABLE t').safe).toBe(false);
    });

    test('routes redis and mongodb to their own checks', () => {
      expect(inspectQuery('redis', 'SET a b').safe).toBe(false);
      expect(inspectQuery('mongodb', '{"$where":"1"}').safe).toBe(false);
    });

    test.each([
      ['rediss', 'GET k', true],
      ['mysql+pymysql', 'SELECT 1', true],
      ['mysql+pymysql', 'DROP TABLE t', false],
      ['sqlite+pysqlite', 'SELECT 1', true],
      ['sqlite+pysqlite', 'DELETE FROM t', false]
    ])('collapses %s to its base driver (%s)', (proto, query, expected) => {
      // The registry routes these schemes, so the guard has to understand them
      // too. It fails closed on anything it cannot map, which would refuse a
      // legitimate read.
      expect(inspectQuery(proto, query).safe).toBe(expected);
    });

    test('fails closed for an unknown protocol', () => {
      expect(inspectQuery('oracle', 'SELECT 1 FROM dual').safe).toBe(false);
    });

    test('rejects a non-string query', () => {
      expect(inspectQuery('postgres', 123).safe).toBe(false);
      expect(inspectQuery('postgres', null).safe).toBe(false);
    });
  });

  describe('hasMultipleStatements', () => {
    test.each([
      ['SELECT 1; DROP TABLE t', true],
      ['SELECT 1;SELECT 2', true],
      ['SELECT 1;\nDELETE FROM t', true],
      ['SELECT 1;', false],
      ['SELECT 1 ;  ', false],
      ["SELECT ';' AS s", false],
      ['SELECT 1 -- ; DROP TABLE t', false],
      ['SELECT "a;b" FROM t', false],
      ['SELECT 1', false]
    ])('%p -> %p', (sql, expected) => {
      expect(hasMultipleStatements(sql)).toBe(expected);
    });

    // The guard reads only the leading keyword, so a semicolon hidden inside a
    // literal is the whole attack. PostgreSQL and SQLite run with
    // standard-conforming strings, where a backslash does not escape the quote
    // after it, so the literal ends there and the rest is a second statement.
    test.each(['postgres', 'postgresql', 'sqlite', 'sqlite+pysqlite'])(
      'counts the statement a backslash hides on %s',
      (protocol) => {
        expect(hasMultipleStatements("SELECT 'a\\'; DROP TABLE t; --'", protocol)).toBe(true);
        expect(hasMultipleStatements('SELECT "a\\"; DROP TABLE t; --"', protocol)).toBe(true);
      }
    );

    test('leaves MySQL alone, whose server really does read the backslash', () => {
      // MySQL treats 'a\' as an unterminated literal, so the text after it is
      // string content rather than a second statement. Refusing it here would
      // reject a legal single-statement query.
      expect(hasMultipleStatements("SELECT * FROM t WHERE a = 'it\\'s fine' AND b = 1", 'mysql')).toBe(false);
      expect(hasMultipleStatements("SELECT * FROM t WHERE a = 'it\\'s fine' AND b = 1", 'mysql+pymysql')).toBe(false);
    });
  });
});
