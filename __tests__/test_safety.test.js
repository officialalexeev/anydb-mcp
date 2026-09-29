import {
  inspectQuery, inspectSql, inspectRedisCommand, inspectMongoOperation, stripSqlNoise, hasMultipleStatements,
  inspectDangerousOperators, findWriteStage, baseProtocol, isSqlProtocol, MONGO_ACTIONS, MONGO_READ_ACTIONS,
  MONGO_WRITE_ACTIONS, TOO_DEEP,
} from '../src/core/safety.js';
import { ROUTES } from '../src/core/registry.js';

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

  // EXPLAIN is on the read allowlist, but EXPLAIN ANALYZE runs the statement it
  // plans, so every write reaches the server behind a keyword the guard allows.
  describe('EXPLAIN ANALYZE', () => {
    test.each([
      'EXPLAIN ANALYZE DELETE FROM users',
      'EXPLAIN ANALYZE INSERT INTO log VALUES (1)',
      'EXPLAIN ANALYZE UPDATE accounts SET bal = 0',
      'EXPLAIN ANALYZE VERBOSE DELETE FROM users',
      'EXPLAIN ANALYZE TRUNCATE users',
      'EXPLAIN (ANALYZE, BUFFERS) DELETE FROM users',
      'EXPLAIN (VERBOSE, ANALYZE TRUE) DELETE FROM users',
      'explain analyze delete from users',
      'EXPLAIN\nANALYZE\nDELETE FROM users',
      'EXPLAIN /* what does this cost */ ANALYZE DELETE FROM users',
    ])('blocks %s', (sql) => {
      const result = inspectSql(sql);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/EXPLAIN ANALYZE executes/);
    });

    test.each([
      'EXPLAIN SELECT 1',
      'EXPLAIN SELECT * FROM users WHERE id = 1',
      'EXPLAIN (FORMAT JSON) SELECT 1',
      'EXPLAIN VERBOSE SELECT 1',
    ])('planning is still a read: %s', (sql) => {
      expect(inspectSql(sql).safe).toBe(true);
    });

    test('cannot be hidden in a literal', () => {
      // The option is read off the stripped statement, so a literal that merely
      // mentions it is not a match, and an option list that does not include it
      // plans the statement whatever the statement says.
      expect(inspectSql("SELECT 'EXPLAIN ANALYZE DELETE FROM t' AS note").safe).toBe(true);
      expect(inspectSql("EXPLAIN (FORMAT JSON) SELECT 'ANALYZE' AS note").safe).toBe(true);
    });
  });

  describe('SELECT ... INTO', () => {
    test.each([
      ['SELECT * INTO users_backup FROM users', /INTO/],
      ['SELECT * INTO t2 FROM t1', /INTO/],
      ['select id, name into #tmp from t1', /INTO/],
      ['SELECT * INTO TEMP t FROM t1', /INTO/],
      ['SELECT * INTO TEMPORARY t FROM t1', /INTO/],
      ['SELECT a INTO v FROM t1', /INTO/],
    ])('blocks %s', (sql, pattern) => {
      const result = inspectSql(sql);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(pattern);
    });

    // The specific forms keep their own messages: they are about a file or a
    // variable, not about a table.
    test.each([
      ['SELECT * INTO OUTFILE \'/tmp/x\' FROM users', /OUTFILE/],
      ['SELECT * INTO DUMPFILE \'/tmp/x\' FROM users', /DUMPFILE/],
      ['SELECT id, name INTO @a, @b FROM users', /session variable/],
    ])('blocks %s', (sql, pattern) => {
      const result = inspectSql(sql);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(pattern);
    });

    test.each([
      ['SELECT into_it FROM t', 'a column whose name starts with the word'],
      ['SELECT a, into_it FROM t WHERE into_it > 1', 'the same in a filter'],
      ['SELECT 1 AS "into" FROM t', 'a quoted alias spelled like the keyword'],
      ['SELECT `into` FROM t', 'a backquoted column'],
      ['SELECT * FROM t', 'nothing at all'],
    ])('allows %s (%s)', (sql) => {
      expect(inspectSql(sql).safe).toBe(true);
    });
  });

  describe('data-modifying CTEs', () => {
    test.each([
      'WITH gone AS (DELETE FROM users RETURNING *) SELECT count(*) FROM gone',
      'WITH w AS (INSERT INTO audit VALUES (1) RETURNING *) SELECT * FROM w',
      'WITH u AS (UPDATE t SET c = 1 RETURNING *) SELECT * FROM u',
      'WITH c AS (SELECT 1) DELETE FROM t USING c',
      'WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c',
      'WITH RECURSIVE w AS (DELETE FROM t RETURNING *) SELECT * FROM w',
      'with gone as (delete from users) select * from gone',
    ])('blocks %s', (sql) => {
      const result = inspectSql(sql);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/data-modifying CTE/);
    });

    // The scan covers the whole statement rather than the first keyword after the
    // CTE list, because telling those apart needs a nesting-aware parse, and
    // getting that parse right is the only thing standing between the guard and
    // `WITH gone AS (DELETE FROM users) SELECT count(*) FROM gone`. So a bare
    // mention anywhere is refused, even in a position a parser would reject.
    test('refuses a bare mention of a write keyword anywhere in the statement', () => {
      const sql = 'WITH c AS (SELECT 1) SELECT * FROM c WHERE x IN (SELECT y FROM (CREATE TABLE z (a INT)) q)';
      const result = inspectSql(sql);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/"CREATE"/);
    });

    test.each([
      'WITH recent AS (SELECT 1) SELECT * FROM recent',
      'WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x',
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n < 5) SELECT * FROM t',
      'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b ON true',
      // Scalar functions that share a name with a statement head. A function is
      // followed by its argument list, which is the only way these two words can
      // appear in a read.
      'WITH x AS (SELECT 1) SELECT REPLACE(name, \'a\', \'b\') FROM t',
      'WITH x AS (SELECT 1) SELECT TRUNCATE(price, 2) FROM t',
      // A write keyword inside a literal, a comment or a longer identifier.
      'WITH x AS (SELECT 1) SELECT * FROM created_orders',
      'WITH x AS (SELECT 1) SELECT \'DELETE FROM t\' AS note',
      'WITH x AS (SELECT 1) SELECT * FROM t WHERE c = update_date',
    ])('allows %s', (sql) => {
      expect(inspectSql(sql).safe).toBe(true);
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

    // A pipeline gets the same JavaScript walk a filter does, in every position
    // a stage document can hold an operator.
    test.each([
      ['[{"$addFields":{"x":{"$function":{"body":"function(){return 1}","args":[]}}}}]', 'aggregate', /JavaScript/],
      ['[{"$group":{"_id":"$a","n":{"$accumulator":{"init":"function(){return 0}","accumulate":"function(s){return s}"}}}}]', 'aggregate', /JavaScript/],
      ['[{"$project":{"x":{"$function":{"body":"function(){return 1}","args":[]}}}}]', 'aggregate', /JavaScript/],
      ['[{"$match":{"$expr":{"$function":{"body":"function(){return 1}","args":[]}}}}]', 'aggregate', /JavaScript/],
      ['[{"$lookup":{"from":"o","localField":"a","foreignField":"b","pipeline":[{"$addFields":{"x":{"$function":{"body":"function(){return 1}","args":[]}}}}]}}]', 'aggregate', /JavaScript/],
      ['[{"$facet":{"a":[{"$accumulator":{"init":"function(){return 0}"}}]}}]', 'aggregate', /JavaScript/],
      ['[{"$unionWith":{"coll":"o","pipeline":[{"$where":"true"}]}}]', 'aggregate', /JavaScript/],
      ['[{"$match":{"$where":"true"}}]', 'aggregate', /JavaScript/],
    ])('blocks server-side JS in a pipeline: %s', (payload, action, pattern) => {
      const result = inspectMongoOperation(payload, action);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(pattern);
    });

    test.each([
      ['$where', '{"$where":"this.a == 1"}'],
      ['$expr', '{"$expr":{"$gt":["$a","$b"]}}'],
    ])('blocks %s, which evaluates an expression the guard cannot take apart', (op, payload) => {
      const result = inspectMongoOperation(payload);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(new RegExp(op.replace('$', '\\$')));
    });

    test('blocks $expr inside a pipeline', () => {
      expect(inspectMongoOperation('[{"$match":{"$expr":{"$gt":["$a","$b"]}}}]', 'aggregate').safe).toBe(false);
    });

    test.each(['find', 'count', 'distinct', 'explain'])('walks the %s filter too', (action) => {
      expect(inspectMongoOperation('{"$where":"true"}', action).safe).toBe(false);
      expect(inspectMongoOperation('{"a":{"$function":{"body":"x"}}}', action).safe).toBe(false);
    });

    test('keeps $out and $merge behind allowWriteStages inside a nested pipeline', () => {
      const payload = '[{"$lookup":{"from":"o","localField":"a","foreignField":"b","pipeline":[{"$out":"copy"}]}}]';
      expect(inspectMongoOperation(payload, 'aggregate').safe).toBe(false);
      expect(inspectMongoOperation(payload, 'aggregate', { allowWriteStages: true }).safe).toBe(true);
    });

    // A stage is a key of a stage object. A field that happens to be spelled like
    // a stage is a field, and refusing reads is its own kind of wrong.
    test.each([
      '[{"$match":{"$out":1}}]',
      '[{"$match":{"$merge":true}}]',
      '[{"$project":{"$out":1,"_id":0}}]',
      '[{"$group":{"_id":"$a","$out":{"$sum":1}}}]',
      '[{"$facet":{"a":[{"$match":{"$out":1}}]}}]',
    ])('allows a field named like a write stage: %s', (payload) => {
      expect(inspectMongoOperation(payload, 'aggregate').safe).toBe(true);
    });

    test.each([
      [{ $out: 'copy' }, '$out at the top level of a stage'],
      [{ $merge: { into: 'copy' } }, '$merge at the top level of a stage'],
      [{ $unionWith: { coll: 'o', pipeline: [{ $out: 'copy' }] } }, '$out in a $unionWith pipeline'],
      [{ $lookup: { from: 'o', pipeline: [{ $merge: { into: 'copy' } }] } }, '$merge in a $lookup pipeline'],
      [{ $facet: { a: [{ $facet: { b: [{ $out: 'copy' }] } }] } }, '$out two facets down'],
    ])('still finds the real thing: %j (%s)', (stage) => {
      expect(findWriteStage([stage])).toMatch(/^\$(out|merge)$/);
      expect(inspectMongoOperation(JSON.stringify([stage]), 'aggregate').safe).toBe(false);
    });

    test('refuses a pipeline nested deeper than the guard can walk', () => {
      // 25 levels of $facet, which MongoDB would run happily: its own limit on
      // nested specifications is far higher than the walk's.
      let pipeline = [{ $out: 'copy' }];
      for (let i = 0; i < 25; i++) pipeline = [{ $facet: { a: pipeline } }];
      const result = inspectMongoOperation(JSON.stringify(pipeline), 'aggregate');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/nests deeper/);
      expect(findWriteStage(pipeline)).toBe(TOO_DEEP);
    });

    test('refuses a JavaScript operator nested deeper than the guard can walk', () => {
      let filter = { $where: 'true' };
      for (let i = 0; i < 25; i++) filter = { a: { b: filter } };
      expect(inspectMongoOperation(JSON.stringify(filter)).safe).toBe(false);
    });

    test('still finds a write stage at a depth it can walk', () => {
      // Five levels is inside the limit, so this is a real finding and not a
      // refusal for being too deep to inspect.
      let pipeline = [{ $out: 'copy' }];
      for (let i = 0; i < 5; i++) pipeline = [{ $facet: { a: pipeline } }];
      const result = inspectMongoOperation(JSON.stringify(pipeline), 'aggregate');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/\$out/);
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
      // The registry routes these schemes, so the guard has to understand them too.
      // It fails closed on anything it cannot map, which would refuse a read.
      expect(inspectQuery(proto, query).safe).toBe(expected);
    });

    test('fails closed for an unknown protocol', () => {
      expect(inspectQuery('oracle', 'SELECT 1 FROM dual').safe).toBe(false);
    });

    // An unlisted scheme is not a known dialect, so it gets no guard rules rather
    // than the nearest neighbour's.
    test.each(['mysql+evil', 'mysql+', 'sqlite+evil', 'mysql+nonsense', 'postgres+psycopg2'])(
      'does not treat %s as a known dialect',
      (proto) => {
        expect(baseProtocol(proto)).toBe(proto);
        expect(inspectQuery(proto, 'SELECT 1').safe).toBe(false);
        expect(inspectQuery(proto, 'SELECT 1').reason).toMatch(/cannot be verified/);
      }
    );

    test.each(['mysql+pymysql', 'mysql+mysqldb', 'mysql+asyncmy', 'mysql+aiohttp', 'mysql+aiomysql', 'mysql+cymysql'])(
      '%s is still the MySQL dialect',
      (proto) => {
        expect(baseProtocol(proto)).toBe('mysql');
        expect(inspectQuery(proto, 'SELECT 1').safe).toBe(true);
        expect(inspectQuery(proto, 'DROP TABLE t').safe).toBe(false);
      }
    );

    test('sqlite+pysqlite is still the SQLite dialect', () => {
      expect(baseProtocol('sqlite+pysqlite')).toBe('sqlite');
      expect(inspectQuery('sqlite+pysqlite', 'SELECT 1').safe).toBe(true);
      expect(inspectQuery('sqlite+pysqlite', 'DELETE FROM t').safe).toBe(false);
    });

    test('a non-string protocol fails closed instead of throwing', () => {
      expect(inspectQuery(undefined, 'SELECT 1').safe).toBe(false);
      expect(inspectQuery(null, 'GET k').safe).toBe(false);
    });

    test('rejects a non-string query', () => {
      expect(inspectQuery('postgres', 123).safe).toBe(false);
      expect(inspectQuery('postgres', null).safe).toBe(false);
    });
  });

  describe('the MariaDB family', () => {
    // `isSqlProtocol` is the *guard* on three others, and each returns early when
    // it says no, so a routed scheme missing from SQL_PROTOCOLS skips the profile's
    // `allowedSchemas` / `allowedTables` and the multi-statement scan entirely.
    // These tests are what keeps the one dialect table and SQL_PROTOCOLS in step.

    test.each(['mariadb', 'mariadb+pymysql', 'mariadb+mariadbconnector'])(
      '%s is a SQL protocol, so the allowlist gate runs for it',
      (scheme) => {
        expect(isSqlProtocol(scheme)).toBe(true);
        expect(baseProtocol(scheme)).toBe('mariadb');
      }
    );

    test.each(['mariadb', 'mariadb+pymysql', 'mariadb+mariadbconnector'])(
      '%s reads and writes are both classified',
      (scheme) => {
        expect(inspectQuery(scheme, 'SELECT 1').safe).toBe(true);
        expect(inspectQuery(scheme, 'DROP TABLE t').safe).toBe(false);
        expect(inspectQuery(scheme, 'DELETE FROM t').safe).toBe(false);
      }
    );

    test.each(['mariadb', 'mariadb+pymysql', 'mariadb+mariadbconnector'])(
      '%s refuses server-side code execution too',
      (scheme) => {
        expect(inspectDangerousOperators(scheme, "COPY t TO PROGRAM 'sh'").safe).toBe(false);
        expect(inspectDangerousOperators(scheme, 'DROP TABLE t').safe).toBe(true);
      }
    );

    /**
     * MariaDB inherits MySQL's string-literal rules, so `'x\'` is one literal
     * there and the `;` behind it is text. PostgreSQL runs with
     * standard-conforming strings, so the *same bytes* are a closed literal
     * followed by a second statement. Asserted on `hasMultipleStatements` rather
     * than in prose, because that is the function `registry.validateQuery` runs.
     */
    const MARIADB_LITERAL = "SELECT * FROM logs WHERE note = 'x\\' ; DROP TABLE users; --'";

    test('a MariaDB literal is scanned the way MySQL scans it, not the way PostgreSQL does', () => {
      // One statement to MariaDB, and to MariaDB only.
      expect(stripSqlNoise(MARIADB_LITERAL, { backslashEscapes: true })).not.toMatch(/DROP/);
      expect(hasMultipleStatements(MARIADB_LITERAL, 'mariadb')).toBe(false);
      expect(hasMultipleStatements(MARIADB_LITERAL, 'mysql')).toBe(false);
      expect(hasMultipleStatements(MARIADB_LITERAL, 'mariadb+pymysql')).toBe(false);
      expect(hasMultipleStatements(MARIADB_LITERAL, 'mariadb+mariadbconnector')).toBe(false);

      // Two statements to PostgreSQL, which is the control: the difference above
      // is the dialect and not the scanner.
      expect(stripSqlNoise(MARIADB_LITERAL, { backslashEscapes: false })).toMatch(/DROP/);
      expect(hasMultipleStatements(MARIADB_LITERAL, 'postgres')).toBe(true);
    });

    test('a real second statement is still found once the MariaDB literal closes', () => {
      // The control for the control: the escape rule has to hide the first
      // semicolon and not this one, or it is a blanket exemption.
      const two = "SELECT * FROM logs WHERE note = 'it\\'s' ; DROP TABLE users; --";
      expect(hasMultipleStatements(two, 'mariadb')).toBe(true);
      expect(inspectQuery('mariadb', 'DROP TABLE users').safe).toBe(false);
    });

    test('a multi-statement MariaDB call is refused by the registry gate too', () => {
      for (const scheme of ['mariadb', 'mariadb+pymysql', 'mariadb+mariadbconnector']) {
        expect(hasMultipleStatements('SELECT 1; DELETE FROM t', scheme)).toBe(true);
      }
    });

    test('an unlisted mariadb dialect stays unknown', () => {
      // `mariadb+evil` is a driver nobody has, and it must fail closed rather
      // than be handed MySQL's guard rules.
      expect(baseProtocol('mariadb+evil')).toBe('mariadb+evil');
      expect(isSqlProtocol('mariadb+evil')).toBe(false);
      expect(inspectQuery('mariadb+evil', 'SELECT 1').reason).toMatch(/cannot be verified/);
    });
  });

  describe('every scheme the registry routes as SQL is a SQL protocol', () => {
    // Derived from `ROUTES` rather than listed, so a new route cannot be added
    // without this failing. That is the only version of "keep these in step" that
    // is not a comment.
    const SQL_DRIVERS = new Set(['postgres', 'mysql', 'sqlite']);

    const sqlRoutes = ROUTES.filter((route) => SQL_DRIVERS.has(route.driver));
    const sqlSchemes = sqlRoutes.flatMap((route) => [...route.schemes]);

    test('the SQL routes are not empty, or the assertion below is vacuous', () => {
      expect(sqlSchemes.length).toBeGreaterThan(0);
      expect(sqlSchemes).toContain('mariadb');
    });

    test.each(sqlSchemes)('%s passes isSqlProtocol', (scheme) => {
      expect(isSqlProtocol(scheme)).toBe(true);
    });

    test.each(sqlSchemes)('%s is not left as its own base protocol', (scheme) => {
      // Either the scheme *is* a dialect, or it is an alias for one. A scheme that
      // is neither is a dialect this module has no rules for.
      const base = baseProtocol(scheme);
      expect(base === scheme ? isSqlProtocol(scheme) : true).toBe(true);
    });

    test('a routed scheme on a non-SQL route is deliberately not SQL', () => {
      // The other half, so the assertion above cannot be satisfied by widening
      // `SQL_PROTOCOLS` to everything.
      for (const scheme of ['mongodb', 'mongodb+srv', 'redis', 'rediss', 'redis-cluster', 'redis-sentinel']) {
        expect(isSqlProtocol(scheme)).toBe(false);
      }
    });

    test('the Redis topologies collapse to redis, so the command guard applies', () => {
      // A scheme that stayed itself would be "cannot be verified" for `GET`.
      for (const scheme of ['rediss', 'redis-cluster', 'redis-sentinel']) {
        expect(baseProtocol(scheme)).toBe('redis');
        expect(inspectQuery(scheme, 'GET k').safe).toBe(true);
        expect(inspectQuery(scheme, 'SET k v').safe).toBe(false);
        expect(inspectQuery(scheme, 'FLUSHDB').safe).toBe(false);
      }
    });
  });

  describe('the MongoDB action sets', () => {
    const SINGLE = ['updateOne', 'replace', 'deleteOne'];

    test('all three are in the action set', () => {
      for (const action of SINGLE) expect(MONGO_ACTIONS.has(action)).toBe(true);
    });

    test('all three are writes, so read-only mode refuses them', () => {
      for (const action of SINGLE) {
        expect(MONGO_READ_ACTIONS.has(action)).toBe(false);
        expect(MONGO_WRITE_ACTIONS.has(action)).toBe(true);
        const verdict = inspectMongoOperation('{"a":1}', action);
        expect(verdict.safe).toBe(false);
        expect(verdict.reason).toMatch(/modifies data/);
      }
    });

    test('the read set and the write set partition the action set exactly', () => {
      // Built as a complement, and asserted as one, so a fourth read action
      // cannot be added to the read set and quietly become writable.
      expect([...MONGO_READ_ACTIONS, ...MONGO_WRITE_ACTIONS].sort()).toEqual([...MONGO_ACTIONS].sort());
      expect(MONGO_READ_ACTIONS.size + MONGO_WRITE_ACTIONS.size).toBe(MONGO_ACTIONS.size);
    });

    test('a single-document write is still walked for server-side JavaScript', () => {
      // Being a write is not being exempt: a `$function` in an update document runs
      // server-side whatever the action is called, so the walk happens on the
      // *dangerous* check, which the registry runs in read-only mode too.
      // `inspectMongoOperation` is the wrong entry point: it refuses a write on the
      // action before it ever looks at the payload.
      const withJs = JSON.stringify({ a: { $function: { body: 'function(){return 1}', args: [] } } });
      for (const action of SINGLE) {
        const readOnly = inspectDangerousOperators('mongodb', withJs, { action });
        expect(readOnly.safe).toBe(false);
        expect(readOnly.reason).toMatch(/JavaScript/);

        const writable = inspectDangerousOperators('mongodb', withJs, { action, readOnly: false });
        expect(writable.safe).toBe(false);
        expect(writable.reason).toMatch(/JavaScript/);
      }
    });

    test('an unknown action is still refused by name', () => {
      expect(inspectMongoOperation('{"a":1}', 'drop').safe).toBe(false);
      expect(inspectMongoOperation('{"a":1}', 'drop').reason).toMatch(/unknown MongoDB action/);
    });
  });

  // Server-side code execution is a different risk class from modifying data, so
  // it is refused whether or not the caller asked to write.
  describe('inspectDangerousOperators', () => {
    test('has the same shape as inspectQuery', () => {
      expect(inspectDangerousOperators('postgres', 'SELECT 1')).toEqual({ safe: true, reason: '' });
      expect(inspectDangerousOperators('postgres', 'DROP TABLE t')).toEqual({ safe: true, reason: '' });
    });

    test.each([
      ['postgres', "COPY t FROM PROGRAM 'curl evil'"],
      ['postgres', "COPY (SELECT 1) TO PROGRAM 'sh -c whoami'"],
      ['postgres', "DO $$ BEGIN PERFORM pg_sleep(10); END $$"],
      ['mysql', "COPY t TO PROGRAM 'sh'"],
      ['mysql+pymysql', "DO LANGUAGE plpgsql $$ BEGIN END $$"],
      // MySQL's DO is a documented no-op, and still a statement head.
      ['mysql', "DO 1"],
    ])('refuses code execution on %s: %s', (proto, sql) => {
      const result = inspectDangerousOperators(proto, sql);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/PROGRAM|code block/);
    });

    test.each([
      ['postgres', 'SELECT 1'],
      ['mysql', 'SELECT * FROM t USE INDEX (idx)'],
      ['mysql', "SELECT * FROM t WHERE a = 'TO PROGRAM'"],
      ['postgres', 'DOCTOR'],
      ['postgres', 'SELECT 1 -- TO PROGRAM'],
    ])('allows %s: %s', (proto, sql) => {
      expect(inspectDangerousOperators(proto, sql).safe).toBe(true);
    });

    test('still allows every write that readOnly:false exists for', () => {
      // The opt-in to write a row is not an opt-in to execute code, but it is
      // still an opt-in to write.
      for (const sql of ['DELETE FROM t', 'UPDATE t SET a = 1', 'TRUNCATE t', 'CREATE TABLE t (a INT)']) {
        expect(inspectDangerousOperators('postgres', sql, { readOnly: false }).safe).toBe(true);
      }
    });

    test('refuses server-side JavaScript in a filter', () => {
      const result = inspectDangerousOperators('mongodb', '{"$where":"this.a==1"}', { readOnly: false });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/JavaScript/);
    });

    test('refuses server-side JavaScript in a pipeline', () => {
      const pipeline = '[{"$addFields":{"x":{"$function":{"body":"function(){return 1}","args":[]}}}}]';
      const result = inspectDangerousOperators('mongodb', pipeline, { action: 'aggregate', readOnly: false });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/JavaScript/);
    });

    test('refuses a write stage in a pipeline unless it is allowed', () => {
      const pipeline = '[{"$out":"copy"}]';
      expect(inspectDangerousOperators('mongodb', pipeline, { action: 'aggregate' }).safe).toBe(false);
      expect(inspectDangerousOperators('mongodb', pipeline, { action: 'aggregate', allowWriteStages: true }).safe).toBe(true);
    });

    test('does not refuse a MongoDB write action, only its operators', () => {
      expect(inspectDangerousOperators('mongodb', '{"a":1}', { action: 'update', readOnly: false }).safe).toBe(true);
      expect(inspectDangerousOperators('mongodb', '[{"a":1}]', { action: 'insert', readOnly: false }).safe).toBe(true);
      expect(inspectDangerousOperators('mongodb', '{"a":{"$function":{"body":"x"}}}', { action: 'update' }).safe).toBe(false);
    });

    test('fails closed on a payload it cannot read', () => {
      expect(inspectDangerousOperators('mongodb', 'not json').safe).toBe(false);
      expect(inspectDangerousOperators('mongodb', '42', { action: 'find' }).safe).toBe(false);
      expect(inspectDangerousOperators('postgres', 42).safe).toBe(false);
    });

    test('leaves Redis alone, where a write and code execution are the same command', () => {
      expect(inspectDangerousOperators('redis', 'GET k').safe).toBe(true);
      expect(inspectDangerousOperators('rediss', 'EVAL "return 1" 0').safe).toBe(true);
    });

    test('fails closed for an unknown protocol', () => {
      const result = inspectDangerousOperators('oracle', 'SELECT 1');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/cannot be verified/);
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
    // standard-conforming strings, where the literal ends at the quote after a
    // backslash and the rest is a second statement.
    test.each(['postgres', 'postgresql', 'sqlite', 'sqlite+pysqlite'])(
      'counts the statement a backslash hides on %s',
      (protocol) => {
        expect(hasMultipleStatements("SELECT 'a\\'; DROP TABLE t; --'", protocol)).toBe(true);
        expect(hasMultipleStatements('SELECT "a\\"; DROP TABLE t; --"', protocol)).toBe(true);
      }
    );

    test('leaves MySQL alone, whose server really does read the backslash', () => {
      // MySQL treats 'a\' as an unterminated literal, so the text after it is
      // string content rather than a second statement.
      expect(hasMultipleStatements("SELECT * FROM t WHERE a = 'it\\'s fine' AND b = 1", 'mysql')).toBe(false);
      expect(hasMultipleStatements("SELECT * FROM t WHERE a = 'it\\'s fine' AND b = 1", 'mysql+pymysql')).toBe(false);
    });
  });

  // A dollar-quoted body is a literal, and a scanner that does not know that
  // swallows every semicolon after the body's unquoted `'`. See the note on
  // DOLLAR_QUOTE_PROTOCOLS in safety.js.
  describe('PostgreSQL dollar-quoted strings', () => {
    const SWALLOW = [
      // Every quote character that could open a string is inside the body, and
      // so is the semicolon that separates the two statements.
      ["SELECT $tag$ ' $tag$ ; DELETE FROM users; --", 'single quote'],
      ['SELECT $$ \' $$ ; DELETE FROM users; --', 'untagged body'],
      ['SELECT $q$ " $q$ ; DELETE FROM users; --', 'double quote in the body'],
      ['SELECT $b$ ` $b$ ; DROP TABLE t; --', 'backtick in the body'],
      ['SELECT $b$ [ $b$ ; DELETE FROM t; --', 'bracket in the body'],
    ];

    test.each(SWALLOW)('is not a way to hide a second statement: %s (%s)', (sql) => {
      expect(hasMultipleStatements(sql, 'postgres')).toBe(true);
      expect(hasMultipleStatements(sql, 'postgresql')).toBe(true);
    });

    test.each(SWALLOW)('is not a way to hide a write from the read-only gate: %s (%s)', (sql) => {
      // The body is stripped as the literal it is, so the leading keyword is
      // SELECT and there is nothing else left to match. The refusal that matters
      // is the one above: this is two statements, not one read.
      expect(inspectQuery('postgres', sql).safe).toBe(true);
    });

    // The same attack with a keyword rather than a separator. `INTO` is the one
    // that writes, and it has to be *outside* the body for this to be a read.
    test('a write keyword inside the body is text, and is not a write', () => {
      expect(hasMultipleStatements('SELECT $tag$ INTO backup $tag$', 'postgres')).toBe(false);
      expect(inspectQuery('postgres', 'SELECT $tag$ INTO backup $tag$').safe).toBe(true);
    });

    test('a semicolon inside a balanced body is not a separator, because it is text', () => {
      // One statement, returning the words "; DELETE FROM users;".
      expect(hasMultipleStatements('SELECT $tag$ ; DELETE FROM users; $tag$', 'postgres')).toBe(false);
      expect(inspectQuery('postgres', 'SELECT $tag$ ; DELETE FROM users; $tag$').safe).toBe(true);
    });

    test('an unbalanced body runs to the end, which is what the server does with it', () => {
      // PostgreSQL's own lexer consumes an unterminated dollar-quote to EOF and
      // then rejects the statement, so there is nothing left for a check to find.
      expect(hasMultipleStatements('SELECT $tag$unterminated ; DELETE FROM t', 'postgres')).toBe(false);
    });

    // `$` is a legal *continuation* character in a PostgreSQL identifier, so a
    // `$` that is not a delimiter must not open anything: deleting the text
    // after it would hide a real statement from the checks.
    test.each([
      ['SELECT $1 FROM t', 'a $1 bind placeholder'],
      ['SELECT a$tag$ FROM t', 'an identifier containing $tag$'],
      ['SELECT price$ FROM t', 'an identifier ending in $'],
    ])('%p is untouched (%s)', (sql) => {
      expect(stripSqlNoise(sql, { dollarQuoting: true })).toBe(sql);
      expect(hasMultipleStatements(`${sql} ; DELETE FROM t`, 'postgres')).toBe(true);
    });

    // A comment ends an identifier, so a `$tag$` straight after one really does
    // open a body — and the body can hold the quote that hides the separator.
    test.each([
      'SELECT a--x\n$tag$ \' $t$ ; DELETE FROM t; --',
      'SELECT a/*x*/$tag$ \' $t$ ; DELETE FROM t; --',
    ])('a dollar-quote after a comment is honoured, so %p', (sql) => {
      // Both bodies here are unterminated, so PostgreSQL rejects the statement;
      // what matters is that the scanner agrees rather than reading the tail as SQL.
      expect(hasMultipleStatements(sql, 'postgres')).toBe(false);
      expect(stripSqlNoise(sql, { dollarQuoting: true })).not.toMatch(/DELETE/);
    });

    // SQLite has no dollar quoting, where `$$` is two operators. Deleting the
    // text between them would hide a statement from the scan.
    test.each(['sqlite', 'sqlite+pysqlite', 'mysql', 'mariadb'])(
      '%s keeps its own meaning for $$',
      (protocol) => {
        expect(stripSqlNoise('SELECT 1 $$ 2', { dollarQuoting: false })).toBe('SELECT 1 $$ 2');
        expect(hasMultipleStatements('SELECT 1 $$ ; DELETE FROM t', protocol)).toBe(true);
      }
    );
  });
});
