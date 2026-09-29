/**
 * Unit tests for the tool surface, importing `src/core/tools.js` directly. A
 * `tools/list` payload is a plain object, and asserting it through a spawned
 * process speaking JSON-RPC would be a slow way to check one.
 */

import { TOOLS, TOOL_NAMES, findTool, validateArgs, LIMITS, FORMATS, DETAILS, MONGO_ACTIONS,
  ERROR_FIELD_KINDS, ERROR_KIND_PROMOTIONS, POLICY_ERROR_CODES } from '../src/core/tools.js';
import { MONGO_ACTIONS as GUARDED_ACTIONS } from '../src/core/safety.js';
import { RESULT_FORMATS } from '../src/core/result-limits.js';
import { ERROR_KINDS, registryError, classifyError, suggestionFor } from '../src/core/registry.js';

/** Every numeric constant a description is allowed to quote. */
const ALLOWED_NUMBERS = new Set(Object.values(LIMITS).flatMap((entry) => Object.values(entry)));

/** Every digit run in every description, tool-level and per-property. */
function describedNumbers(tool) {
  const texts = [tool.description, ...Object.values(tool.inputSchema.properties ?? {}).map((p) => p.description ?? '')];
  return texts
    .filter((text) => typeof text === 'string')
    .flatMap((text) => (text.match(/\d+/g) ?? []).map((digits) => Number(digits)));
}

describe('TOOLS', () => {
  test('exposes exactly the five documented tools', () => {
    expect(TOOL_NAMES).toEqual(['db_list', 'db_query', 'db_schema', 'db_explain', 'db_health']);
  });

  test('is frozen, so the ListTools handler can return it directly', () => {
    expect(Object.isFrozen(TOOLS)).toBe(true);
    for (const tool of TOOLS) expect(Object.isFrozen(tool)).toBe(true);
  });

  test.each(TOOL_NAMES)('%s has a name, a title, a description and a schema', (name) => {
    const tool = findTool(name);
    expect(tool).toBeDefined();
    expect(tool.name).toBe(name);
    // `title` sits at the top level, not inside `annotations` where the spec gives
    // it display precedence: the same string twice in a payload every request
    // pays for.
    expect(typeof tool.title).toBe('string');
    expect(tool.title.length).toBeGreaterThan(3);
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(80);
    expect(tool.inputSchema).toMatchObject({ type: 'object' });
    expect(tool.outputSchema).toMatchObject({ type: 'object' });
  });

  test.each(TOOL_NAMES)('%s declares all four annotations', (name) => {
    expect(findTool(name).annotations).toEqual({
      readOnlyHint: expect.any(Boolean),
      destructiveHint: expect.any(Boolean),
      idempotentHint: expect.any(Boolean),
      openWorldHint: expect.any(Boolean),
    });
  });

  test('the annotations say what each tool actually does', () => {
    const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations]));
    // Four of the five only read, which is what a client uses to decide whether to
    // auto-approve.
    for (const name of ['db_list', 'db_schema', 'db_explain', 'db_health']) {
      expect(byName[name].readOnlyHint).toBe(true);
      expect(byName[name].destructiveHint).toBe(false);
    }
    // `db_query` is the only one that can change anything, and its result is
    // whatever the database holds at that moment.
    expect(byName.db_query).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  test.each(TOOL_NAMES)('%s requires only arguments it declares', (name) => {
    const { inputSchema } = findTool(name);
    const properties = Object.keys(inputSchema.properties ?? {});
    for (const required of inputSchema.required ?? []) {
      expect(properties).toContain(required);
    }
  });

  test.each(TOOL_NAMES)('%s closes its input schema to unknown properties', (name) => {
    // `validateArgs` is the enforcement; this asserts the two halves still agree.
    expect(findTool(name).inputSchema.additionalProperties).toBe(false);
  });

  test.each(TOOL_NAMES)('%s describes every enum value it accepts', (name) => {
    const tool = findTool(name);
    const haystack = `${tool.description} ${Object.values(tool.inputSchema.properties ?? {})
      .map((p) => p.description ?? '').join(' ')}`;

    for (const [property, spec] of Object.entries(tool.inputSchema.properties ?? {})) {
      for (const value of spec.enum ?? []) {
        // Every enum value has to appear in the prose too, or the schema admits an
        // action the description never mentioned.
        expect(`${property}:${haystack}`).toContain(value);
      }
    }
  });

  test.each(TOOL_NAMES)('%s quotes no number that is not a constant', (name) => {
    const offenders = describedNumbers(findTool(name))
      .filter((value) => !ALLOWED_NUMBERS.has(value));
    // A hardcoded limit in prose is a promise about a bound that lives somewhere
    // else in the tree.
    expect(offenders).toEqual([]);
  });

  test.each(TOOL_NAMES)('%s defaults every numeric argument to a declared constant', (name) => {
    for (const [property, spec] of Object.entries(findTool(name).inputSchema.properties ?? {})) {
      if (typeof spec.default !== 'number') continue;
      const known = [...ALLOWED_NUMBERS, 0];
      expect({ property, default: known.includes(spec.default) }).toEqual({ property, default: true });
    }
  });

  test('the timeout bounds agree with the ones the registry enforces', () => {
    // Two gates on one number: this schema and `registry.validateTimeout`. A model
    // is told the range in a description, so both ends have to hold.
    for (const name of ['db_query', 'db_schema', 'db_explain', 'db_health']) {
      expect(findTool(name).inputSchema.properties.timeout).toMatchObject({
        type: 'integer',
        minimum: LIMITS.timeout.min,
        maximum: LIMITS.timeout.max,
        default: LIMITS.timeout.default,
      });
    }
  });

  test('the output schema requires an object, and names every field it returns', () => {
    for (const tool of TOOLS) {
      expect(tool.outputSchema.type).toBe('object');
      for (const required of tool.outputSchema.required ?? []) {
        expect(Object.keys(tool.outputSchema.properties ?? {})).toContain(required);
      }
    }
  });

  test('db_list carries no argument and says what happens with no config file', () => {
    const tool = findTool('db_list');
    expect(tool.inputSchema.properties).toEqual({});
    expect(tool.description).toMatch(/db\.json/);
    expect(tool.description).toMatch(/no config file/i);
    // A config file is writable by anyone who can write files, and this text goes
    // into a model context window, so the promise belongs in the description.
    expect(tool.description).toMatch(/never contains a connection string/i);
  });

  test('db_query tells a model that has never seen this server what to do', () => {
    const description = findTool('db_query').description;
    expect(description).toMatch(/read-?only by default/i);
    expect(description).toMatch(/db_list/);
    expect(description).toMatch(/db_schema/);
    expect(description).toMatch(/params/);
    expect(description).toMatch(/LIMIT/);
    // Every MongoDB action, read and write.
    for (const action of MONGO_ACTIONS) expect(description).toContain(action);
  });

  test('db_query is honest about what readOnly and allowDestructive are worth', () => {
    const properties = findTool('db_query').inputSchema.properties;
    expect(properties.readOnly.default).toBe(true);
    expect(properties.allowDestructive.default).toBe(false);
    // Two flags set by the same agent in the same call is a weak boundary, so the
    // description has to say so rather than imply a control that is not there.
    expect(properties.allowDestructive.description).toMatch(/weak boundary/i);
    expect(properties.allowDestructive.description).toMatch(/database role/i);
  });

  test('db_explain says it does not execute the statement', () => {
    const description = findTool('db_explain').description;
    expect(description).toMatch(/WITHOUT running it/i);
    expect(description).toMatch(/ANALYZE/);
  });

  test('db_health says the database role is the boundary, not this server', () => {
    const description = findTool('db_health').description;
    expect(description).toMatch(/boundary is the database role/i);
    expect(description).toMatch(/does not do/i);
  });

  test('the vocabularies come from the modules that enforce them', () => {
    // Both lists live where they are enforced: `format` in `registry.validateScalars`
    // and `result-limits.formatRows`, `action` in `registry.validateQuery` and the
    // read-only guard.
    expect(FORMATS).toEqual([...RESULT_FORMATS]);
    expect(MONGO_ACTIONS).toEqual([...GUARDED_ACTIONS]);
    expect(MONGO_ACTIONS).toContain('explain');
  });

  test('the whole tools/list payload stays small', () => {
    const bytes = Buffer.byteLength(JSON.stringify({ tools: TOOLS }), 'utf8');
    // Reported so growth shows up in a diff rather than in somebody's context
    // window: a `tools/list` is paid for on every request, by every model.
    //
    //   measured:  21,441 bytes for five tools (about 5,400 tokens)
    //   budget:    21,500 bytes, raised from 21,000 for `error.code` and
    //              `error.operation` — the error vocabulary an agent branches on
    //   breakdown: db_query 7.9k (21 arguments), db_explain 4.2k, db_schema 4.1k,
    //              db_health 3.6k, db_list 1.5k
    expect(bytes).toBeLessThan(21500);
    // eslint-disable-next-line no-console
    console.log(`tools/list payload: ${bytes} bytes for ${TOOLS.length} tools`);
  });
});

// The error object. The `kind` enum here and the `kind` the registry raises are
// two lists in two files, and the gap is invisible from either side. `destructive`
// is the member that looks dead from here: `src/index.js` promotes it on the way
// out, and a promotion one merge away from the enum is one merge away from a hard
// validation failure for a client.
describe('the error object', () => {
  /** `error`, from whichever tool declares it. All four that can fail share it. */
  const errorField = () => findTool('db_query').outputSchema.properties.error;

  test('every kind the registry raises is in the schema\'s enum', () => {
    // Anything the server can emit has to be in the enum, or `structuredContent`
    // fails validation on the failure path.
    const missing = [...ERROR_KINDS].filter((kind) => !ERROR_FIELD_KINDS.includes(kind));
    expect(missing).toEqual([]);
  });

  test('every kind in the enum is either a registry kind or a documented promotion', () => {
    // The other direction, which catches a member nothing produces. The allowed set
    // is the registry's list plus this file's promotions, not a second copy.
    const reachable = new Set([...ERROR_KINDS, ...Object.keys(ERROR_KIND_PROMOTIONS)]);
    const unreachable = ERROR_FIELD_KINDS.filter((kind) => !reachable.has(kind));
    expect(unreachable).toEqual([]);
  });

  test('a promoted kind names a code, and that code is one the registry raises', () => {
    for (const [kind, code] of Object.entries(ERROR_KIND_PROMOTIONS)) {
      expect(ERROR_FIELD_KINDS).toContain(kind);
      expect(POLICY_ERROR_CODES).toContain(code);
      // The registry really does raise it that way.
      const error = registryError('Refused: this statement is destructive because it drops a table.', {
        kind: 'policy', code, operation: 'db_query',
      });
      expect(classifyError(error, { operation: 'db_query' })).toMatchObject({ kind: 'policy', code });
    }
  });

  test('a destructive refusal is distinguishable from a read-only refusal by its code', () => {
    // Both are `kind: 'policy'` in the registry. The `code` is what `src/index.js`
    // branches on to choose the destructive advice over the read-only advice; the
    // suggestion tables themselves cannot be imported from a test, so the code is
    // the testable half.
    const destructive = registryError('Refused: this statement is destructive because it drops a table.', {
      kind: 'policy', code: 'DESTRUCTIVE', operation: 'db_query',
    });
    const readOnly = registryError('Read-only mode: this statement was blocked because it writes.', {
      kind: 'policy', code: 'READ_ONLY', operation: 'db_query',
    });

    expect(classifyError(destructive, { operation: 'db_query' })).toMatchObject({ code: 'DESTRUCTIVE' });
    expect(classifyError(readOnly, { operation: 'db_query' })).toMatchObject({ code: 'READ_ONLY' });
    // Same kind, different code: which is the whole point of carrying the code.
    expect(destructive.kind).toBe(readOnly.kind);
    expect(destructive.code).not.toBe(readOnly.code);
    expect(ERROR_KIND_PROMOTIONS.destructive).toBe(destructive.code);
  });

  test('declares code and operation, and says so where a model will read it', () => {
    const field = errorField();
    expect(Object.keys(field.properties).sort())
      .toEqual(['code', 'details', 'kind', 'message', 'operation', 'suggestion']);
    // Neither is required: a validation failure has no code, and requiring one would
    // make the schema something the error path must satisfy rather than describe.
    expect(field.required).toEqual(['kind', 'message', 'suggestion']);
    expect(field.properties.code.description).toMatch(/42P01/);
  });

  test('the code vocabulary this file documents is one the registry really uses', () => {
    // This server's own vocabulary is a closed list, so it can be asserted. A driver
    // code cannot: a driver can raise anything.
    const raised = new Set();
    for (const code of POLICY_ERROR_CODES) {
      raised.add(code);
    }
    expect([...raised].sort()).toEqual([...POLICY_ERROR_CODES].sort());
  });

  test('every tool that can fail declares the same error object', () => {
    // Four tools, one shape: a second definition would be a different contract for a
    // client that validates one tool's result against another's schema.
    const shapes = new Set(
      ['db_query', 'db_schema', 'db_explain', 'db_health']
        .map((name) => JSON.stringify(findTool(name).outputSchema.properties.error))
    );
    expect(shapes.size).toBe(1);
  });

  test('a driver error code survives the trip to the envelope\'s schema', () => {
    // The shape a client sees: the schema admits the `kind` and `code` the registry
    // produces, and the suggestion is chosen by `kind`.
    const error = registryError('relation "users" does not exist', {
      kind: 'database', code: '42P01', operation: 'db_query',
    });
    expect(classifyError(error, { operation: 'db_query', protocol: 'postgres' }))
      .toMatchObject({ kind: 'database', code: '42P01', operation: 'db_query' });
    expect(suggestionFor(error, { driver: 'postgres' })).toMatch(/postgres syntax/);
    for (const [name, value] of Object.entries({ kind: error.kind, code: error.code })) {
      const spec = errorField().properties[name];
      expect(spec.type).toContain(typeof value === 'number' ? 'number' : 'string');
    }
  });
});

describe('findTool', () => {
  test('finds each declared tool', () => {
    for (const name of TOOL_NAMES) expect(findTool(name).name).toBe(name);
  });

  test.each(['db_exec', 'db_query ', 'DB_QUERY', '', 'sql', 'resources/list'])(
    'returns undefined for %p, so nothing runs under a name this server does not have',
    (name) => {
      // The SDK does not validate tool names, only the request envelope, so an unknown
      // name arrives as an ordinary string and must not reach a handler.
      expect(findTool(name)).toBeUndefined();
    }
  );

  test.each([null, undefined, 42, {}, []])('returns undefined for the non-string %p', (name) => {
    expect(findTool(name)).toBeUndefined();
  });
});

describe('validateArgs', () => {
  const query = () => findTool('db_query');
  const list = () => findTool('db_list');

  describe('accepts', () => {
    test('a minimal valid call', () => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT 1' });
      expect(result).toEqual({ ok: true, value: { uri: 'sqlite://:memory:', query: 'SELECT 1' }, errors: [] });
    });

    test('every declared argument at once', () => {
      const args = {
        uri: 'sqlite://:memory:',
        query: 'SELECT * FROM t WHERE a = ?',
        params: [1, 'two', true, null],
        collection: 'users',
        action: 'find',
        update: '{"$set":{"seen":true}}',
        field: 'email',
        sort: '{"createdAt":-1}',
        projection: '{"name":1}',
        upsert: true,
        allowWriteStages: false,
        limit: 10,
        offset: 0,
        cursor: 'eyJvIjoxfQ==',
        readOnly: false,
        allowDestructive: true,
        format: 'jsonl',
        timeout: 1000,
        maxRows: 100,
        maxBytes: 2048,
      };
      const result = validateArgs(query(), args);
      expect(result.errors).toEqual([]);
      expect(result.value).toEqual(args);
    });

    test('a profile instead of a uri', () => {
      expect(validateArgs(query(), { profile: 'local', query: 'SELECT 1' }).ok).toBe(true);
    });

    test('no arguments at all, for a tool that takes none', () => {
      expect(validateArgs(list(), undefined)).toEqual({ ok: true, value: {}, errors: [] });
      expect(validateArgs(list(), {}).ok).toBe(true);
    });

    test('null for an optional argument, which means "not supplied"', () => {
      // JSON clients send it for an absent field, and the registry already treats it
      // as the default. Present-and-wrong would fail a call the server accepts.
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: null });
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ uri: 'sqlite://:memory:', query: 'SELECT 1' });
    });

    test('arguments in any order, and repeated calls', () => {
      const a = validateArgs(query(), { query: 'SELECT 1', uri: 'sqlite://:memory:', readOnly: true });
      const b = validateArgs(query(), { readOnly: true, uri: 'sqlite://:memory:', query: 'SELECT 1' });
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
    });
  });

  describe('rejects unknown properties', () => {
    // `additionalProperties: false` is declared here and enforced by `validateArgs`,
    // which is the only thing in the stack that checks it.
    test('a name that is not in the schema', () => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT 1', bogus: 'x' });
      expect(result.ok).toBe(false);
      expect(result.value).toEqual({});
      expect(result.errors[0]).toContain('Unknown argument "bogus" for db_query');
      expect(result.errors[0]).toContain('It takes:');
    });

    test('a plausible misspelling of a real one', () => {
      // `read_only` and `readOnly` are one character apart and mean opposite things to
      // a reader, so the message has to list what is accepted.
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT 1', read_only: false });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('readOnly');
    });

    test('anything at all on a tool that takes nothing', () => {
      const result = validateArgs(list(), { anything: 1 });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('It takes no arguments');
    });

    test('an argument that belongs to another tool', () => {
      // `table` is real, but on `db_schema` — and `detail` is the reverse.
      expect(validateArgs(findTool('db_explain'), { uri: 'sqlite://:memory:', query: 'SELECT 1', table: 'users' }).ok)
        .toBe(false);
      expect(validateArgs(findTool('db_schema'), { uri: 'sqlite://:memory:', detail: 'full', params: [1] }).ok)
        .toBe(false);
    });
  });

  describe('db_explain accepts the MongoDB arguments its handler needs', () => {
    // The handler needs `collection`, and `validateArgs` enforces
    // `additionalProperties: false` — so a MongoDB explain was refused before the
    // handler ran, and the branch had no caller. A unit test of the branch would
    // have passed: the code was right and the contract was wrong.
    const explain = () => findTool('db_explain');

    test('collection is declared', () => {
      const collection = explain().inputSchema.properties.collection;
      expect(collection).toBeDefined();
      expect(collection.type).toBe('string');
      expect(collection.minLength).toBe(1);
      expect(collection.description).toMatch(/MongoDB only/);
      expect(collection.description).toMatch(/required/);
    });

    test('a MongoDB explain passes validation', () => {
      const result = validateArgs(explain(), {
        uri: 'mongodb://127.0.0.1:27017/anydb',
        collection: 'users',
        query: '{"status":"active"}'
      });
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    });

    test('a MongoDB explain passes validation with a profile and a timeout too', () => {
      const result = validateArgs(explain(), {
        profile: 'atlas', collection: 'users', query: '{}', timeout: 5000, params: []
      });
      expect(result.ok).toBe(true);
    });

    test('collection is still refused where it means nothing', () => {
      // Declared on `db_explain` is not declared on `db_health`.
      expect(validateArgs(findTool('db_health'), { uri: 'sqlite://:memory:', collection: 'c' }).ok).toBe(false);
    });

    test('a non-string collection is still a type error', () => {
      const result = validateArgs(explain(), { uri: 'mongodb://h/d', query: '{}', collection: 7 });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('"collection"');
    });

    test('the query description says what the payload is for MongoDB', () => {
      expect(explain().inputSchema.properties.query.description).toMatch(/MongoDB/);
    });
  });

  describe('rejects missing required arguments', () => {
    test('no query at all', () => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:' });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/requires "query"/);
      expect(result.errors[0]).toMatch(/statement to run/i);
    });

    test('a required argument that is null counts as missing', () => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: null });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/requires "query"/);
    });

    test('db_explain requires a query too', () => {
      expect(validateArgs(findTool('db_explain'), { uri: 'sqlite://:memory:' }).ok).toBe(false);
    });
  });

  describe('rejects the wrong type', () => {
    test.each([
      ['a number where a string belongs', 'query', 123, /must be a string, got number \(123\)/],
      ['an object where a string belongs', 'uri', { a: 1 }, /must be a string, got object/],
      ['a string where a boolean belongs', 'readOnly', 'false', /must be true or false, got string/],
      ['a boolean where a number belongs', 'timeout', true, /must be a whole number, got boolean/],
      ['an object where an array belongs', 'params', { a: 1 }, /must be an array, got object/],
      ['a fractional number where a whole one belongs', 'timeout', 1.5, /must be a whole number, got number/],
      ['an array where a string belongs', 'query', ['SELECT 1'], /must be a string, got array/]
    ])('%s', (_label, key, value, expected) => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT 1', [key]: value });
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toMatch(expected);
    });

    test('NaN is not a number', () => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: Number.NaN });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/"timeout"/);
    });

    test('an element of the wrong type inside params', () => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT ?', params: [1, {}, 3] });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/"params\[1\]"/);
    });
  });

  describe('rejects a value outside an enum', () => {
    test('an unknown MongoDB action, and names every one that exists', () => {
      const result = validateArgs(query(), {
        uri: 'mongodb://h/db', query: '{}', collection: 'c', action: 'drop',
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('"action" of db_query must be one of:');
      // The full list: this message is what a model reads when it guesses an action.
      expect(result.errors[0]).toContain(
        'find, count, distinct, aggregate, explain, insert, update, updateOne, replace, delete, deleteOne'
      );
      expect(result.errors[0]).toContain('Got "drop".');
    });

    // `replace` additionally needs the `document` property: the action is accepted
    // and then refused for a missing argument, which `additionalProperties: false`
    // would otherwise hide.
    test.each(['updateOne', 'replace', 'deleteOne'])('%s is an accepted action', (action) => {
      const result = validateArgs(query(), {
        uri: 'mongodb://h/db', query: '{}', collection: 'c', action,
        update: '{"$set":{"a":1}}',
        document: '{"a":1}',
      });
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    });

    test('the replacement document is declared, because replace requires one', () => {
      const document = query().inputSchema.properties.document;
      expect(document).toBeDefined();
      expect(document.type).toBe('string');
      expect(document.maxLength).toBe(100000);
      expect(document.description).toMatch(/action "replace"/);
    });

    test('the action enum and the guard are the same set, all eleven', () => {
      expect(MONGO_ACTIONS).toEqual([
        'find', 'count', 'distinct', 'aggregate', 'explain',
        'insert', 'update', 'updateOne', 'replace', 'delete', 'deleteOne'
      ]);
      // The enum has to be the guard's set, not merely a superset of it.
      expect(new Set(query().inputSchema.properties.action.enum)).toEqual(new Set(GUARDED_ACTIONS));
    });

    test('the description prose names the three single-document writes', () => {
      // The prose is the only place a model is told the writes exist.
      const text = query().description;
      for (const action of ['insert', 'update', 'updateOne', 'replace', 'delete', 'deleteOne']) {
        expect(text).toContain(action);
      }
      expect(query().inputSchema.properties.action.description).toContain('deleteOne');
    });

    test('an unknown format', () => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT 1', format: 'yaml' });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('json, jsonl, csv, tsv, markdown');
    });

    test('an unknown detail', () => {
      const result = validateArgs(findTool('db_schema'), { uri: 'sqlite://:memory:', detail: 'everything' });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('summary, full');
    });
  });

  describe('rejects a value out of range', () => {
    test.each([
      ['timeout below the floor', { timeout: 0 }, /"timeout".*at least 1, got 0/],
      ['a negative timeout', { timeout: -1 }, /"timeout".*at least 1, got -1/],
      ['a timeout above the ceiling', { timeout: 86400001 }, /"timeout".*at most 86400000, got 86400001/],
      ['a Mongo limit above the ceiling', { limit: 1001 }, /"limit".*at most 1000, got 1001/],
      ['a negative offset', { offset: -1 }, /"offset".*at least 0, got -1/],
      ['maxRows above the ceiling', { maxRows: 1000001 }, /"maxRows".*at most 1000000/],
      ['maxBytes above the ceiling', { maxBytes: 67108865 }, /"maxBytes".*at most 67108864/]
    ])('%s', (_label, extra, expected) => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT 1', ...extra });
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toMatch(expected);
    });

    test.each([
      ['an empty uri', { uri: '', query: 'SELECT 1' }],
      ['an empty profile', { profile: '', query: 'SELECT 1' }],
      ['an empty collection', { uri: 'sqlite://:memory:', query: 'SELECT 1', collection: '' }],
      ['a string past maxLength', { uri: 'sqlite://:memory:', query: 'x'.repeat(200001) }],
      ['more params than maxItems', { uri: 'sqlite://:memory:', query: 'SELECT 1', params: new Array(1001).fill(1) }]
    ])('%s', (_label, args) => {
      expect(validateArgs(query(), args).ok).toBe(false);
    });
  });

  describe('rejects a statement of nothing but whitespace', () => {
    // `minLength: 1` cannot see it, and `"   "` would reach SQLite as a syntax
    // error about syntax.
    test.each(['   ', '\t', '\n', ' \t\n '])('%p', (value) => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: value });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/non-whitespace/);
    });
  });

  describe('enforces exactly one target', () => {
    // The xor is written out because JSON Schema would need `oneOf` with two `not`
    // branches, and the failure message would be a JSON pointer.
    test('both profile and uri', () => {
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', profile: 'local', query: 'SELECT 1' });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/either "profile" or "uri", not both/);
    });

    test('neither', () => {
      const result = validateArgs(query(), { query: 'SELECT 1' });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/Give one of "profile" or "uri"/);
    });

    test.each([
      ['db_query', { query: 'SELECT 1' }],
      ['db_schema', {}],
      ['db_explain', { query: 'SELECT 1' }],
      ['db_health', {}]
    ])('%s enforces it too', (name, extra) => {
      // Built per tool: `db_schema` has no `query`, so a shared fixture would fail on
      // an unknown argument rather than on the xor.
      const args = { uri: 'sqlite://:memory:', ...extra };
      expect(validateArgs(findTool(name), args).ok).toBe(true);
      expect(validateArgs(findTool(name), { ...args, profile: 'p' }).ok).toBe(false);
      expect(validateArgs(findTool(name), extra).ok).toBe(false);
    });

    test('db_list needs no target and is exempt', () => {
      expect(validateArgs(list(), {}).ok).toBe(true);
    });
  });

  describe('reports every problem at once', () => {
    test('four mistakes produce four lines', () => {
      // One round trip instead of four: the whole list costs about a hundred tokens.
      const result = validateArgs(query(), {
        uri: 5, query: 123, timeout: -1, format: 'yaml', bogus: true,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
      for (const argument of ['"uri"', '"query"', '"timeout"', '"format"', '"bogus"']) {
        expect(result.errors.join('\n')).toContain(argument);
      }
    });
  });

  describe('degrades safely', () => {
    test('a tool with no schema is refused rather than trusted', () => {
      const result = validateArgs({ name: 'broken' }, { anything: 1 });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/no inputSchema/);
    });

    test('arguments that are not an object', () => {
      for (const args of ['string', 42, true, ['a']]) {
        const result = validateArgs(query(), args);
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/must be an object/);
      }
    });

    test('a bad argument never reaches the value that is passed on', () => {
      // The registry is called with `result.value`, so a value that failed its checks
      // must not be in it.
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: -1, readOnly: false });
      expect(result.value).toEqual({});
    });

    test('a good argument alongside a bad one is kept out too', () => {
      // All-or-nothing: a partial value is one the handler has to reason about, and
      // the registry reports the same problem again with different wording.
      const result = validateArgs(query(), { uri: 'sqlite://:memory:', query: 'SELECT 1', timeout: 'soon' });
      expect(result.value).toEqual({});
    });
  });
});

describe('LIMITS', () => {
  test('is the single source for every number a description quotes', () => {
    expect(LIMITS.timeout).toEqual({ min: 1, max: 86400000, default: 30000 });
    expect(LIMITS.rows.default).toBeGreaterThan(0);
    expect(LIMITS.bytes.default).toBeGreaterThan(0);
    expect(LIMITS.mongoLimit.default).toBeLessThanOrEqual(LIMITS.mongoLimit.max);
  });

  test('every row and byte limit is inside its own ceiling', () => {
    expect(LIMITS.rows.default).toBeLessThanOrEqual(LIMITS.rows.max);
    expect(LIMITS.bytes.default).toBeLessThanOrEqual(LIMITS.bytes.max);
    expect(LIMITS.timeout.default).toBeGreaterThanOrEqual(LIMITS.timeout.min);
    expect(LIMITS.timeout.default).toBeLessThanOrEqual(LIMITS.timeout.max);
  });
});
