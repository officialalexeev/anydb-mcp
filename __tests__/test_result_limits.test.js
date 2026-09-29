import { Decimal128, Long, ObjectId } from 'mongodb';
import { getTypeParser } from 'pg-types';

import {
  normalizeForJson, measureBytes, clampResult, formatRows, buildEnvelope,
  DEFAULT_MAX_ROWS, DEFAULT_MAX_BYTES, RESULT_FORMATS, MAX_NESTING_DEPTH,
  CIRCULAR_MARKER, DEPTH_MARKER, resolvedTimezone, LIMIT_HINTS,
} from '../src/core/result-limits.js';

describe('normalizeForJson', () => {
  // Whatever this returns has to survive `JSON.stringify`, so that is the
  // assertion on most of these.
  const survives = (value) => expect(() => JSON.stringify(value)).not.toThrow();

  describe('scalars that JSON cannot express', () => {
    // `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`,
    // and because the stringify sat inside the query's try block that reached
    // the model as "Check the postgres syntax".
    test('a bigint becomes a decimal string', () => {
      expect(normalizeForJson({ id: 9007199254740993n })).toEqual({ id: '9007199254740993' });
      expect(normalizeForJson(10n)).toBe('10');
      expect(normalizeForJson(-1n)).toBe('-1');
      survives(normalizeForJson({ id: 1n }));
    });

    test('a bigint array survives', () => {
      const out = normalizeForJson([1n, 2n]);
      expect(out).toEqual(['1', '2']);
      survives(out);
    });

    test('NaN and Infinity become marked strings, not null', () => {
      // `JSON.stringify` already emits `null` for these, which is worse than a
      // crash: the model gets a NULL where the column holds a number.
      const out = normalizeForJson({ a: NaN, b: Infinity, c: -Infinity });
      expect(out).toEqual({
        a: '[non-finite: NaN]',
        b: '[non-finite: Infinity]',
        c: '[non-finite: -Infinity]'
      });
      expect(JSON.parse(JSON.stringify(out)).a).not.toBeNull();
    });

    // The sentinel costs type fidelity — `"[non-finite: NaN]"` is not a number, so
    // arithmetic on it fails — and buys detectability: `SELECT avg(x)` comes back
    // as NULL, and without a marker nothing says the column was not empty.
    test('the default rendering really is null, which is what the sentinel replaces', () => {
      expect(JSON.stringify({ a: NaN, b: Infinity, c: -Infinity })).toBe('{"a":null,"b":null,"c":null}');
      expect(JSON.stringify([NaN, Infinity])).toBe('[null,null]');

      const out = normalizeForJson({ a: NaN });
      // Every marker is distinguishable from every other, and none of them is
      // the number it replaced or the null JSON would have produced.
      for (const [input, marker] of [[NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity']]) {
        const value = normalizeForJson({ v: input }).v;
        expect(typeof value).toBe('string');
        expect(value).toBe(`[non-finite: ${marker}]`);
        expect(value).not.toBe(String(input));
      }
    });

    test('a non-finite number at the top level is marked too', () => {
      expect(normalizeForJson(NaN)).toBe('[non-finite: NaN]');
    });

    test('an invalid Date is marked rather than emitted as "Invalid Date"', () => {
      expect(normalizeForJson(new Date('nonsense'))).toBe('[invalid date]');
    });

    test('symbols and functions are described, not dropped', () => {
      expect(normalizeForJson({ s: Symbol('x') })).toEqual({ s: '[symbol]' });
      expect(normalizeForJson({ f: function named() {} })).toEqual({ f: '[function named]' });
      survives(normalizeForJson({ s: Symbol('x'), f: () => {} }));
    });

    test('a Map or Set is described rather than rendered as {}', () => {
      expect(normalizeForJson(new Map([['a', 1]]))).toBe('[Map 1]');
      expect(normalizeForJson(new Set([1, 2]))).toBe('[Set 2]');
    });
  });

  describe('binary', () => {
    // `JSON.stringify(Buffer)` emits {"type":"Buffer","data":[1,2,3]}, which is
    // about double the size of the hex and leaks a Node-internal shape into a
    // result a model is meant to read as data. A Postgres bytea hits this.
    test('a Buffer becomes $binary/$bytes', () => {
      expect(normalizeForJson({ blob: Buffer.from([1, 2, 3]) }))
        .toEqual({ blob: { $binary: '010203', $bytes: 3 } });
    });

    test('a typed array becomes $binary/$bytes', () => {
      expect(normalizeForJson(new Uint8Array([0xff, 0x00])))
        .toEqual({ $binary: 'ff00', $bytes: 2 });
    });

    test('a DataView is not a byte list, and is described instead', () => {
      const view = new DataView(new ArrayBuffer(2));
      expect(normalizeForJson(view)).toBe('[unserializable: DataView]');
    });

    test('an ArrayBuffer becomes $binary/$bytes', () => {
      expect(normalizeForJson(new ArrayBuffer(3))).toEqual({ $binary: '000000', $bytes: 3 });
    });

    test('only the view window of a large buffer is converted', () => {
      const big = new Uint8Array(10).fill(7);
      const window = big.subarray(2, 5);
      expect(normalizeForJson(window)).toEqual({ $binary: '070707', $bytes: 3 });
    });

    test('an empty buffer is honest about being empty', () => {
      expect(normalizeForJson(Buffer.alloc(0))).toEqual({ $binary: '', $bytes: 0 });
    });
  });

  describe('BSON', () => {
    test('a Decimal128 instance becomes its decimal string', () => {
      expect(normalizeForJson({ price: Decimal128.fromString('10.99') })).toEqual({ price: '10.99' });
    });

    test('a Long instance becomes its decimal string, not {high, low}', () => {
      // JSON.stringify(Long) gives {"high":…,"low":…,"unsigned":false}, which is
      // meaningless to a model and silently loses the value.
      expect(normalizeForJson({ id: Long.fromString('9007199254740993') }))
        .toEqual({ id: '9007199254740993' });
    });

    test('an ObjectId becomes its hex string', () => {
      const oid = new ObjectId('6aba3e9c596c7e7927bf6e7e');
      expect(normalizeForJson({ _id: oid })).toEqual({ _id: '6aba3e9c596c7e7927bf6e7e' });
    });

    test('extended JSON wrappers are unwrapped', () => {
      expect(normalizeForJson({ $numberDecimal: '10.99' })).toBe('10.99');
      expect(normalizeForJson({ $numberLong: '9007199254740993' })).toBe('9007199254740993');
      expect(normalizeForJson({ $oid: '6aba3e9c596c7e7927bf6e7e' })).toBe('6aba3e9c596c7e7927bf6e7e');
    });

    test('a bare {low, high} pair becomes the 64-bit value it carries', () => {
      expect(normalizeForJson({ low: 1, high: 0 })).toBe('1');
      expect(normalizeForJson({ low: 0, high: 2097152 })).toBe('9007199254740992');
    });

    // The documented cost of the {low, high} rule: a real column shaped that way
    // is read as a number. Asserted, not left in a comment.
    test('a {low, high} record with extra keys is left as an object', () => {
      expect(normalizeForJson({ low: 1, high: 2, unsigned: false })).toEqual({ low: 1, high: 2, unsigned: false });
    });
  });

  describe('Date', () => {
    test('is rendered as ISO-8601 with an explicit offset, never a bare Z', () => {
      const at = new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 678));
      const rendered = normalizeForJson(at);
      expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
      expect(rendered).not.toMatch(/Z$/);
    });

    test('the rendered wall clock is the one the value holds locally', () => {
      // `toISOString()` would move a bare Postgres `timestamp` by the host's
      // offset, so `2024-01-01 12:00` written by the server would come back as
      // a different clock with nothing saying so.
      const at = new Date(2024, 0, 1, 12, 0, 0, 0);
      const rendered = normalizeForJson(at);
      expect(rendered.slice(0, 19)).toBe('2024-01-01T12:00:00');
    });

    test('the offset in the string is the resolved timezone', () => {
      const at = new Date(2024, 5, 1, 12, 0, 0, 0);
      // `YYYY-MM-DDTHH:MM:SS.mmm` is 23 characters, so the offset starts there.
      expect(normalizeForJson(at).slice(23)).toBe(resolvedTimezone(at));
    });

    // Measured against the installed `pg`, the same stored value
    // `2024-01-01 12:00:00` renders as:
    //
    //     host +03:00   local fields 12:00:00   toISOString() 2024-01-01T09:00:00.000Z
    //     host -05:00   local fields 12:00:00   toISOString() 2024-01-01T17:00:00.000Z
    //
    // so `toISOString()` renders the stored value plus the host's offset, and
    // nothing in the response says so. This test asserts the two halves
    // separately rather than the offset, so it holds in any timezone.
    test('agrees with the driver about a bare timestamp and disagrees with toISOString()', () => {
      const at = new Date(2024, 0, 1, 12, 0, 0, 0);
      const rendered = normalizeForJson(at);

      // The stored wall clock, digit for digit.
      expect(rendered.slice(0, 19)).toBe('2024-01-01T12:00:00');
      // And NOT the UTC instant `toISOString()` would have produced, unless the
      // host happens to be at UTC — where the two are the same thing and the
      // difference this guards against does not exist.
      if (at.getTimezoneOffset() !== 0) {
        expect(rendered).not.toBe(at.toISOString());
        expect(rendered).not.toBe(at.toISOString().replace(/Z$/, resolvedTimezone(at)));
      } else {
        expect(rendered).toBe(at.toISOString().replace(/Z$/, resolvedTimezone(at)));
      }
    });

    test('renders a timestamptz instant too, and the rendering round-trips', () => {
      // 2024-01-01T12:00:00Z seen from a host at some non-UTC offset.
      const at = new Date(Date.UTC(2024, 0, 1, 12, 0, 0, 0));
      const rendered = normalizeForJson(at);

      // The local wall clock with the host's offset spelled out, which is the
      // same instant as the UTC form. Read as an offset-bearing string it has to
      // agree with `toISOString()`, which is the property that makes this form
      // lossless for a `timestamptz`.
      expect(Date.parse(rendered)).toBe(at.getTime());
      expect(Date.parse(rendered)).toBe(Date.parse(at.toISOString()));
    });

    test('an offset-bearing string from timestamptz passes through untouched', () => {
      const raw = '2024-01-01T12:00:00.000+02:00';
      expect(normalizeForJson({ seen_at: raw })).toEqual({ seen_at: raw });
    });

    test('resolvedTimezone is always a signed HH:MM', () => {
      expect(resolvedTimezone()).toMatch(/^[+-]\d{2}:\d{2}$/);
      expect(resolvedTimezone(new Date(Date.UTC(2024, 0, 1)))).toMatch(/^[+-]\d{2}:\d{2}$/);
    });
  });

  // The driver fact the whole Date policy rests on, asserted against the
  // installed driver rather than against a comment about it.
  describe("what pg actually hands back for a timestamp", () => {
    const TIMESTAMP = 1114;
    const TIMESTAMPTZ = 1184;

    test('a bare timestamp arrives as a Date whose LOCAL fields are the stored wall clock', () => {
      const parsed = getTypeParser(TIMESTAMP, 'text')('2024-01-01 12:00:00');
      expect(parsed).toBeInstanceOf(Date);
      expect([
        parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate(),
        parsed.getHours(), parsed.getMinutes(), parsed.getSeconds(),
      ]).toEqual([2024, 1, 1, 12, 0, 0]);
    });

    // If this ever stops being true the rendering above is wrong, and it is the
    // one assertion here that cannot be satisfied by the implementation
    // agreeing with itself.
    test('toISOString() moves that wall clock by the host offset, which is the bug avoided', () => {
      const stored = '2024-01-01T12:00:00';
      const parsed = getTypeParser(TIMESTAMP, 'text')(`${stored.slice(0, 10)} 12:00:00`);
      // The offset *at the parsed instant*, not today's: `getTimezoneOffset()`
      // read off `new Date()` is the current one, and a host that is on summer
      // time now was on winter time in January. That difference is a five-hour
      // arithmetic error in a test about offsets, which is precisely the class of
      // bug the other half of this test exists to catch.
      const offsetMinutes = parsed.getTimezoneOffset();
      // `pg` reads the text as LOCAL time, so the instant it builds is the stored
      // wall clock minus the host's offset. `getTimezoneOffset()` is minutes to
      // add to local to reach UTC, hence the sign.
      const asUtc = new Date(Date.parse(`${stored}Z`) + offsetMinutes * 60000).toISOString();

      expect(parsed.toISOString()).toBe(asUtc);
      if (offsetMinutes !== 0) {
        // …and that is NOT the stored wall clock, which is the whole point.
        expect(parsed.toISOString().slice(0, 19)).not.toBe(stored);
        // …while the rendering preserves what the server actually stored.
        expect(normalizeForJson(parsed).slice(0, 19)).toBe(stored);
      }
    });

    test('a timestamptz is a Date too, so both types take the same rendering path', () => {
      expect(getTypeParser(TIMESTAMPTZ, 'text')('2024-01-01 12:00:00+00')).toBeInstanceOf(Date);
    });
  });

  describe('structure', () => {
    test('undefined in an object drops the key, as JSON.stringify does', () => {
      const out = normalizeForJson({ a: 1, b: undefined, c: 2 });
      expect(out).toEqual({ a: 1, c: 2 });
      expect('b' in out).toBe(false);
    });

    test('undefined in an array becomes null, so positions and length survive', () => {
      const out = normalizeForJson([1, undefined, 3]);
      expect(out).toEqual([1, null, 3]);
      expect(out).toHaveLength(3);
    });

    test('key order is preserved', () => {
      // tabulate() reads Object.keys, so a reversed object would render a
      // reversed CSV.
      expect(Object.keys(normalizeForJson({ z: 1, a: 2, m: 3 }))).toEqual(['z', 'a', 'm']);
    });

    test('a cycle is replaced with a marker, not a thrown TypeError', () => {
      const node = { name: 'root' };
      node.self = node;
      node.children = [node];
      expect(normalizeForJson(node)).toEqual({
        name: 'root',
        self: CIRCULAR_MARKER,
        children: [CIRCULAR_MARKER]
      });
    });

    test('two references to the same object are not a cycle', () => {
      const shared = { a: 1 };
      expect(normalizeForJson({ x: shared, y: shared })).toEqual({ x: { a: 1 }, y: { a: 1 } });
    });

    test('a cycle through an array is found', () => {
      const list = [1];
      list.push(list);
      expect(normalizeForJson(list)).toEqual([1, CIRCULAR_MARKER]);
    });

    test('deep nesting is cut, not overflowed', () => {
      // A naive recursive walk blows the stack here, and the failure reached the
      // model as a syntax error on a statement that had run perfectly.
      const DEPTH = 20000;
      const root = {};
      let cursor = root;
      for (let i = 0; i < DEPTH; i++) {
        cursor.next = {};
        cursor = cursor.next;
      }
      cursor.leaf = 'bottom';

      const out = normalizeForJson(root);
      expect(() => JSON.stringify(out)).not.toThrow();
      expect(JSON.stringify(out)).toContain(DEPTH_MARKER);
    });

    test('the depth marker sits at the documented depth', () => {
      let root = {};
      let cursor = root;
      for (let i = 0; i < MAX_NESTING_DEPTH + 5; i++) {
        cursor.next = {};
        cursor = cursor.next;
      }
      expect(JSON.stringify(normalizeForJson(root))).toContain(DEPTH_MARKER);
    });

    test('a throwing getter becomes a placeholder and the rest survives', () => {
      const row = {
        good: 1,
        bad: Object.defineProperty({}, 'boom', { get() { throw new Error('no'); }, enumerable: true })
      };
      const out = normalizeForJson(row);
      expect(out.good).toBe(1);
      expect(() => JSON.stringify(out)).not.toThrow();
    });

    test('a hostile Proxy does not take the whole result down', () => {
      const hostile = new Proxy({}, { ownKeys() { throw new Error('no keys'); } });
      const out = normalizeForJson({ a: 1, hostile });
      expect(out.a).toBe(1);
      expect(() => JSON.stringify(out)).not.toThrow();
    });

    // The guarantee, stated as a test because it is the whole reason the
    // function exists: a throw here blames a statement that already succeeded.
    test('never throws, for anything', () => {
      const values = [
        undefined, null, 0, '', Symbol('s'), () => {}, 1n, NaN,
        new Date('bad'), new Map(), new WeakMap(), Object.create(null),
        { get boom() { throw new Error('x'); } },
        new Proxy({}, { get() { throw new Error('x'); } }),
        JSON.parse('{"__proto__":{"polluted":true}}'),
        new (class Weird { constructor() { this.self = this; } })()
      ];
      for (const value of values) {
        expect(() => normalizeForJson(value)).not.toThrow();
      }
    });

    test('a value that is not a function, object or scalar is still described', () => {
      expect(normalizeForJson({ w: new WeakMap() })).toEqual({ w: '[unserializable: WeakMap]' });
    });

    test('a null-prototype object is handled like any other', () => {
      const bare = Object.create(null);
      bare.a = 1;
      expect(normalizeForJson(bare)).toEqual({ a: 1 });
    });

    test('a sparse array keeps its length', () => {
      const sparse = new Array(4);
      sparse[2] = 'x';
      expect(normalizeForJson(sparse)).toEqual([null, null, 'x', null]);
    });

    test('an empty result stays an empty result', () => {
      expect(normalizeForJson([])).toEqual([]);
      expect(normalizeForJson({})).toEqual({});
    });
  });
});

describe('measureBytes', () => {
  test('is the UTF-8 byte length of the JSON form', () => {
    expect(measureBytes([{ a: 1 }])).toBe(9);
    expect(measureBytes('é')).toBe(4); // two characters, four bytes
  });

  test('is never wrong about a multibyte payload by counting characters', () => {
    expect(measureBytes({ s: '日本語' })).toBeGreaterThan(JSON.stringify({ s: '日本語' }).length);
  });

  test('does not throw on a cycle', () => {
    const node = {};
    node.self = node;
    expect(measureBytes(node)).toBe(0);
  });

  test('measures undefined as zero rather than throwing', () => {
    expect(measureBytes(undefined)).toBe(0);
  });
});

describe('clampResult', () => {
  test('defaults are 1000 rows and 256 KiB', () => {
    expect(DEFAULT_MAX_ROWS).toBe(1000);
    expect(DEFAULT_MAX_BYTES).toBe(262144);
    expect(clampResult([], {}).truncated).toBe(false);
  });

  test('reads ANYDB_MAX_ROWS and ANYDB_MAX_BYTES when no limit is passed', () => {
    const env = { ANYDB_MAX_ROWS: '2', ANYDB_MAX_BYTES: '1000' };
    const out = clampResult([{ a: 1 }, { a: 2 }, { a: 3 }], { env });
    expect(out.rowCount).toBe(2);
    expect(out.truncated).toBe(true);
  });

  test('an explicit limit beats the environment', () => {
    const out = clampResult([{ a: 1 }, { a: 2 }], { maxRows: 5, env: { ANYDB_MAX_ROWS: '1' } });
    expect(out.rowCount).toBe(2);
  });

  test('returns the five documented fields plus the dropped count', () => {
    const out = clampResult([{ a: 1 }], {});
    expect(Object.keys(out).sort()).toEqual(
      ['bytes', 'droppedRows', 'limitReason', 'rowCount', 'rows', 'truncated']
    );
  });

  test('a result inside both limits is untouched', () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const out = clampResult(rows, { maxRows: 10, maxBytes: 10000 });
    expect(out.rows).toEqual(rows);
    expect(out.rowCount).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.limitReason).toBeNull();
    expect(out.droppedRows).toBe(0);
  });

  describe('by row count', () => {
    test('keeps maxRows and says why', () => {
      const out = clampResult([1, 2, 3, 4, 5], { maxRows: 3, maxBytes: 10000 });
      expect(out.rows).toEqual([1, 2, 3]);
      expect(out.rowCount).toBe(3);
      expect(out.truncated).toBe(true);
      expect(out.limitReason).toBe('maxRows');
      expect(out.droppedRows).toBe(2);
    });

    test('a result exactly at the limit is not truncated', () => {
      expect(clampResult([1, 2, 3], { maxRows: 3, maxBytes: 10000 }).truncated).toBe(false);
    });
  });

  describe('by byte count', () => {
    test('drops trailing rows until it fits', () => {
      const rows = [{ a: 'x'.repeat(50) }, { a: 'y'.repeat(50) }, { a: 'z'.repeat(50) }];
      const out = clampResult(rows, { maxRows: 100, maxBytes: 130 });
      expect(out.rowCount).toBe(2);
      expect(out.truncated).toBe(true);
      expect(out.limitReason).toBe('maxBytes');
      expect(out.droppedRows).toBe(1);
      expect(out.bytes).toBeLessThanOrEqual(130);
    });

    // The pathological case: one row bigger than the entire budget must not be
    // able to produce a response the cap was set to prevent.
    test('a single oversized row is dropped, and the count is reported', () => {
      const out = clampResult([{ blob: 'x'.repeat(5000) }], { maxRows: 100, maxBytes: 100 });
      expect(out.rows).toEqual([]);
      expect(out.rowCount).toBe(0);
      expect(out.truncated).toBe(true);
      expect(out.limitReason).toBe('maxBytes');
      expect(out.droppedRows).toBe(1);
    });

    test('the reported bytes are the size of what was actually returned', () => {
      const out = clampResult([{ a: 1 }, { b: 2 }], { maxRows: 100, maxBytes: 1000 });
      expect(out.bytes).toBe(measureBytes(out.rows));
    });
  });

  describe('non-array payloads', () => {
    test('a single value is kept whole and counted as one row', () => {
      const out = clampResult({ database: 'postgres', tables: [] }, { maxBytes: 1000 });
      expect(out.rows).toEqual({ database: 'postgres', tables: [] });
      expect(out.rowCount).toBe(1);
      expect(out.truncated).toBe(false);
    });

    test('one too big for the budget is dropped whole rather than mangled', () => {
      const out = clampResult({ big: 'x'.repeat(500) }, { maxBytes: 100 });
      expect(out.rows).toBeNull();
      expect(out.rowCount).toBe(0);
      expect(out.truncated).toBe(true);
      expect(out.limitReason).toBe('maxBytes');
      expect(out.droppedRows).toBe(1);
    });
  });

  describe('normalisation on the way through', () => {
    test('a bigint in a row is converted, not thrown', () => {
      const out = clampResult([{ n: 1n }], {});
      expect(out.rows).toEqual([{ n: '1' }]);
      expect(() => JSON.stringify(out.rows)).not.toThrow();
    });

    test('a cycle in a row is replaced, not thrown', () => {
      const node = { a: 1 };
      node.self = node;
      expect(() => clampResult([node], {})).not.toThrow();
      expect(clampResult([node], {}).rows).toEqual([{ a: 1, self: CIRCULAR_MARKER }]);
    });
  });

  // Every adapter caps its own result and marks the array it returns, and the
  // marker is invisible to `JSON.stringify` — so `clampResult` has to read it
  // before normalisation, or the envelope reports a cut result as complete.
  describe("an adapter's own truncation markers", () => {
    /**
     * The array exactly as `markTruncated` in `postgres.js` produces it. Built
     * here rather than imported, because the test is about the *contract*, and
     * importing one side of it would make the assertion unable to fail.
     */
    const marked = (rows, { reason = 'maxRows', droppedRows } = {}) => {
      Object.defineProperty(rows, 'truncated', { value: true, enumerable: false, configurable: true });
      Object.defineProperty(rows, 'limitReason', { value: reason, enumerable: false, configurable: true });
      if (droppedRows !== undefined) {
        Object.defineProperty(rows, 'droppedRows', { value: droppedRows, enumerable: false, configurable: true });
      }
      return rows;
    };

    test('the markers really are invisible to JSON, which is why they have to be read directly', () => {
      const rows = marked([{ id: 1 }, { id: 2 }]);
      expect(Object.keys(rows)).toEqual(['0', '1']);
      expect(JSON.stringify(rows)).toBe('[{"id":1},{"id":2}]');
      // A direct read is the only way in, and it is the one `clampResult` uses.
      expect(rows.truncated).toBe(true);
      expect(rows.limitReason).toBe('maxRows');
    });

    // Two rows, a 1000-row limit, and a result the adapter already cut: nothing
    // this function does has anything to cut, and the envelope still has to say
    // the answer was cut.
    test('is reported even when the clamp itself cut nothing', () => {
      const out = clampResult(marked([{ id: 1 }, { id: 2 }]), { maxRows: 1000, maxBytes: 100000 });

      expect(out.rowCount).toBe(2);
      expect(out.rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(out.truncated).toBe(true);
      expect(out.limitReason).toBe('maxRows');
    });

    test('the adapter\'s limitReason is the one reported', () => {
      const out = clampResult(marked([1, 2], { reason: 'maxBytes' }), { maxRows: 1000, maxBytes: 100000 });
      expect(out.truncated).toBe(true);
      expect(out.limitReason).toBe('maxBytes');
    });

    test('an adapter reason is preserved alongside a clamp cut, which wins on the reason', () => {
      // Both happened. The byte cut is the one the caller can act on by changing
      // a limit, so its reason is the one that goes in the envelope — but the
      // result is truncated either way and `droppedRows` counts both.
      const out = clampResult(marked([{ a: 'x'.repeat(400) }], { droppedRows: 900 }), { maxBytes: 50 });
      expect(out.truncated).toBe(true);
      expect(out.limitReason).toBe('maxBytes');
      expect(out.droppedRows).toBe(901);
    });

    test('droppedRows the adapter reported survives when this clamp cut nothing', () => {
      const out = clampResult(marked([{ id: 1 }], { droppedRows: 399999 }), { maxRows: 1000, maxBytes: 100000 });
      expect(out.droppedRows).toBe(399999);
      expect(out.truncated).toBe(true);
    });

    // A `truncated: true` with no reason is still truncated. The flag and the
    // reason are independent facts and only the first is load-bearing.
    test('a bare truncated flag with no reason is still truncated', () => {
      const rows = [{ id: 1 }];
      Object.defineProperty(rows, 'truncated', { value: true, enumerable: false, configurable: true });
      const out = clampResult(rows, { maxRows: 1000, maxBytes: 100000 });
      expect(out.truncated).toBe(true);
      expect(out.limitReason).toBeNull();
    });

    // The markers are non-enumerable, so the normalisation walk cannot see them.
    // The read therefore has to happen on the original payload, and this is the
    // test that fails if somebody moves it after the walk.
    test('an unmarked array that normalises to something truthy is not truncated', () => {
      const out = clampResult([{ truncated: true }], { maxRows: 1000, maxBytes: 100000 });
      // An *enumerable* `truncated` on a row is not a marker; it is a column.
      expect(out.truncated).toBe(false);
      expect(out.limitReason).toBeNull();
    });

    test('a cursor the adapter attached is preserved, and absent otherwise', () => {
      const withCursor = marked([1, 2]);
      Object.defineProperty(withCursor, 'nextCursor', { value: 'eyJvIjoxfQ==', enumerable: false, configurable: true });

      const out = clampResult(withCursor, { maxRows: 1000, maxBytes: 100000 });
      expect(out.nextCursor).toBe('eyJvIjoxfQ==');
      // …and the documented six-key shape is untouched for an adapter that
      // does not paginate, so `nextCursor` is not a field to learn to ignore.
      expect(Object.keys(clampResult([{ a: 1 }], {})).sort()).toEqual(
        ['bytes', 'droppedRows', 'limitReason', 'rowCount', 'rows', 'truncated']
      );
    });

    // The envelope is what the model reads, so the fact has to survive all the
    // way to it.
    test('the envelope reports an adapter truncation and names the cursor', () => {
      const rows = marked([{ id: 1 }], { droppedRows: 12 });
      Object.defineProperty(rows, 'nextCursor', { value: { after: 1 }, enumerable: false, configurable: true });
      const envelope = buildEnvelope(clampResult(rows, { maxRows: 1000, maxBytes: 100000 }), {});

      expect(envelope.truncated).toBe(true);
      expect(envelope.limitReason).toBe('maxRows');
      expect(envelope.nextCursor).toEqual({ after: 1 });
      expect(envelope.hint).toContain('prefix of the answer');
      expect(envelope.hint).toContain('12 row(s) were dropped');
      expect(envelope.hint).toContain('"cursor"');
    });

    test('an explicit meta.nextCursor still wins over the payload', () => {
      const rows = marked([1]);
      Object.defineProperty(rows, 'nextCursor', { value: 'from-payload', enumerable: false, configurable: true });
      const envelope = buildEnvelope(clampResult(rows, {}), { nextCursor: 'from-meta' });
      expect(envelope.nextCursor).toBe('from-meta');
    });

    // A non-array payload is a `db_schema` description, and it can be truncated
    // by the adapter too: a description wider than the cap has been cut.
    test('is reported for a non-array payload as well', () => {
      const description = { database: 'sqlite', tables: new Array(50).fill({ name: 't' }) };
      Object.defineProperty(description, 'truncated', { value: true, enumerable: false, configurable: true });
      Object.defineProperty(description, 'limitReason', { value: 'maxRows', enumerable: false, configurable: true });

      const out = clampResult(description, { maxRows: 1000, maxBytes: 100000 });
      expect(out.rowCount).toBe(1);
      expect(out.truncated).toBe(true);
      expect(out.limitReason).toBe('maxRows');
    });

    // A marker read is a property read, and a hostile Proxy throws on one.
    // Unwrapped it would turn a statement that ran perfectly into an error that
    // blames the query — the one failure this whole module exists to remove,
    // reintroduced by the function that reads the markers.
    test('a marker read that throws is treated as no marker, not as a failed call', () => {
      const hostile = new Proxy([], {
        get(target, key) {
          if (key === 'truncated' || key === 'limitReason' || key === 'droppedRows' || key === 'nextCursor') {
            throw new Error('no marker for you');
          }
          return Reflect.get(target, key);
        }
      });
      hostile.push({ a: 1 });

      let out;
      expect(() => { out = clampResult(hostile, { maxRows: 1000, maxBytes: 100000 }); }).not.toThrow();
      expect(out.truncated).toBe(false);
      expect(out.rows).toEqual([{ a: 1 }]);
    });

    // The most damaging form: a capped result the clamp cannot detect.
    test('a capped result is never reported as complete', () => {
      const out = clampResult(marked(Array.from({ length: 1000 }, (_, i) => ({ i }))), {
        maxRows: 1000, maxBytes: 1048576,
      });
      const envelope = buildEnvelope(out, {});
      expect({ truncated: envelope.truncated, hint: envelope.hint !== null })
        .toEqual({ truncated: true, hint: true });
    });
  });
});

describe('formatRows', () => {
  const rows = [
    { id: 1, name: 'ada' },
    { id: 2, name: 'grace' }
  ];

  test('json is compact, not pretty-printed', () => {
    // Pretty-printing an array of objects adds two bytes of indentation per
    // line: 30-60% of the payload on a wide result, all of it billed.
    expect(formatRows(rows, 'json')).toBe('[{"id":1,"name":"ada"},{"id":2,"name":"grace"}]');
    expect(formatRows(rows, 'json')).not.toContain('\n');
  });

  test('json is the default', () => {
    expect(formatRows(rows)).toBe(formatRows(rows, 'json'));
  });

  test('every documented format is supported', () => {
    for (const format of RESULT_FORMATS) {
      expect(typeof formatRows(rows, format)).toBe('string');
    }
    expect([...RESULT_FORMATS]).toEqual(['json', 'jsonl', 'csv', 'tsv', 'markdown']);
  });

  test('an unknown format falls back to json rather than throwing', () => {
    expect(formatRows(rows, 'yaml')).toBe(formatRows(rows, 'json'));
  });

  describe('jsonl', () => {
    test('is one object per line', () => {
      expect(formatRows(rows, 'jsonl')).toBe('{"id":1,"name":"ada"}\n{"id":2,"name":"grace"}');
    });

    test('a non-array payload is one line, which is still valid jsonl', () => {
      expect(formatRows({ a: 1 }, 'jsonl')).toBe('{"a":1}\n');
    });
  });

  describe('csv', () => {
    test('renders a header and one line per row', () => {
      expect(formatRows(rows, 'csv')).toBe('id,name\n1,ada\n2,grace');
    });

    test('quotes a field containing the delimiter', () => {
      expect(formatRows([{ a: 'x,y' }], 'csv')).toBe('a\n"x,y"');
    });

    test('doubles an embedded quote', () => {
      expect(formatRows([{ a: 'he said "hi"' }], 'csv')).toBe('a\n"he said ""hi"""');
    });

    test('quotes a field containing a line break, RFC 4180 style', () => {
      expect(formatRows([{ a: 'one\ntwo' }], 'csv')).toBe('a\n"one\ntwo"');
      expect(formatRows([{ a: 'one\r\ntwo' }], 'csv')).toBe('a\n"one\r\ntwo"');
    });

    test('quotes a field with leading or trailing whitespace, which readers would drop', () => {
      expect(formatRows([{ a: ' x ' }], 'csv')).toBe('a\n" x "');
    });

    test('quotes a field containing a quote and a comma together', () => {
      expect(formatRows([{ a: 'a"b,c' }], 'csv')).toBe('a\n"a""b,c"');
    });

    test('flattens a nested value to its JSON text', () => {
      expect(formatRows([{ a: { b: [1, 2] } }], 'csv')).toBe('a\n"{""b"":[1,2]}"');
    });

    test('renders null and undefined as an empty field', () => {
      expect(formatRows([{ a: null, b: undefined, c: 1 }], 'csv')).toBe('a,b,c\n,,1');
    });

    test('unions the columns of rows that do not have the same keys', () => {
      expect(formatRows([{ a: 1 }, { b: 2 }], 'csv')).toBe('a,b\n1,\n,2');
    });

    test('a non-object row set gets one value column', () => {
      // A Redis HGETALL is a flat string array, and there is no key to put a
      // cell in.
      expect(formatRows(['one', 'two'], 'csv')).toBe('value\none\ntwo');
    });

    test('an empty row set has no columns to name', () => {
      expect(formatRows([], 'csv')).toBe('');
    });

    test('falls back to json with a note on a non-array payload', () => {
      const out = formatRows({ a: 1 }, 'csv');
      expect(out.startsWith('# format "csv" needs an array of rows')).toBe(true);
      expect(out).toContain('{"a":1}');
    });
  });

  describe('tsv', () => {
    test('is tab-separated', () => {
      expect(formatRows(rows, 'tsv').split('\n')[0]).toBe('id\tname');
      expect(formatRows(rows, 'tsv').split('\n')[1]).toBe('1\tada');
    });

    test('quotes a field containing a tab', () => {
      expect(formatRows([{ a: 'x\ty' }], 'tsv')).toBe('a\n"x\ty"');
    });

    test('doubles an embedded quote, as csv does', () => {
      expect(formatRows([{ a: 'a"b' }], 'tsv')).toBe('a\n"a""b"');
    });

    test('falls back to json with a note on a non-array payload', () => {
      expect(formatRows({ a: 1 }, 'tsv')).toMatch(/^# format "tsv" needs an array of rows/);
    });
  });

  describe('markdown', () => {
    test('is a GFM pipe table with a header rule', () => {
      expect(formatRows(rows, 'markdown'))
        .toBe('| id | name |\n| --- | --- |\n| 1 | ada |\n| 2 | grace |');
    });

    test('escapes a pipe', () => {
      expect(formatRows([{ a: 'x|y' }], 'markdown')).toContain('| x\\|y |');
    });

    test('escapes a backslash before a pipe', () => {
      expect(formatRows([{ a: 'x\\|y' }], 'markdown')).toContain('| x\\\\\\|y |');
    });

    test('turns a line break into <br>', () => {
      expect(formatRows([{ a: 'one\ntwo' }], 'markdown')).toContain('one<br>two');
    });

    test('a non-array payload falls back to json with a note', () => {
      expect(formatRows({ a: 1 }, 'markdown')).toMatch(/^# format "markdown" needs an array of rows/);
    });
  });

  describe('the byte budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ i, note: 'x'.repeat(20) }));

    test('re-truncates when the rendered text is over budget', () => {
      const text = formatRows(many, 'csv', { maxBytes: 200 });
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(200);
    });

    test('says so in the line-oriented formats', () => {
      expect(formatRows(many, 'csv', { maxBytes: 200 })).toMatch(/omitted by a result limit/);
      expect(formatRows(many, 'markdown', { maxBytes: 200 })).toMatch(/row\(s\) omitted/);
    });

    // Adding a note to JSON would make it unparseable, so the machine-readable
    // channel for it is the envelope.
    test('stays parseable when json is re-truncated', () => {
      const text = formatRows(many, 'json', { maxBytes: 200 });
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(200);
      expect(() => JSON.parse(text)).not.toThrow();
      expect(JSON.parse(text).length).toBeLessThan(many.length);
    });

    test('jsonl also stays parseable line by line', () => {
      const text = formatRows(many, 'jsonl', { maxBytes: 200 });
      for (const line of text.split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
    });

    test('a budget larger than the result changes nothing', () => {
      expect(formatRows(rows, 'json', { maxBytes: 100000 })).toBe(formatRows(rows, 'json'));
    });

    test('an impossible budget still returns something', () => {
      expect(typeof formatRows(many, 'csv', { maxBytes: 1 })).toBe('string');
    });
  });
});

describe('buildEnvelope', () => {
  const payload = clampResult([{ a: 1 }], {});

  test('has exactly the documented fields, in order', () => {
    const envelope = buildEnvelope(payload, {});
    expect(Object.keys(envelope)).toEqual([
      'rows', 'rowCount', 'truncated', 'bytes', 'elapsedMs',
      'profile', 'driver', 'limitReason', 'nextCursor', 'timezone', 'hint'
    ]);
  });

  test('every field is present when nothing happened', () => {
    const envelope = buildEnvelope(payload, { elapsedMs: 8, profile: 'prod-ro', driver: 'postgres' });
    expect(envelope).toEqual({
      rows: [{ a: 1 }],
      rowCount: 1,
      truncated: false,
      bytes: 9,
      elapsedMs: 8,
      profile: 'prod-ro',
      driver: 'postgres',
      limitReason: null,
      nextCursor: null,
      timezone: expect.stringMatching(/^[+-]\d{2}:\d{2}$/),
      hint: null
    });
  });

  test('the timezone is resolved when meta does not supply one', () => {
    expect(buildEnvelope(payload, {}).timezone).toBe(resolvedTimezone());
  });

  test('a truncated result carries a reason and a hint', () => {
    const truncated = clampResult([1, 2, 3], { maxRows: 1, maxBytes: 10000 });
    const envelope = buildEnvelope(truncated, {});

    expect(envelope.truncated).toBe(true);
    expect(envelope.limitReason).toBe('maxRows');
    expect(envelope.hint).toContain('LIMIT');
    expect(envelope.hint).toContain('prefix of the answer');
    expect(envelope.hint).toContain('2 row(s) were dropped');
  });

  test('a byte-truncated result says which limit and how to fix it', () => {
    const truncated = clampResult([{ a: 'x'.repeat(400) }], { maxBytes: 50 });
    const envelope = buildEnvelope(truncated, {});
    expect(envelope.limitReason).toBe('maxBytes');
    expect(envelope.hint).toContain(LIMIT_HINTS.maxBytes);
    expect(envelope.hint).toContain('1 row(s) were dropped');
    expect(envelope.rows).toEqual([]);
  });

  test('a cursor is surfaced and named in the hint', () => {
    const truncated = clampResult([1, 2, 3], { maxRows: 1, maxBytes: 10000 });
    const envelope = buildEnvelope(truncated, { nextCursor: { page: 2 } });

    expect(envelope.nextCursor).toEqual({ page: 2 });
    expect(envelope.hint).toContain('"cursor"');
  });

  test('limitReason is null whenever nothing was truncated', () => {
    // A reason with truncated:false is the one combination that would let a
    // model believe it had everything.
    const envelope = buildEnvelope({ ...payload, limitReason: 'maxRows' }, {});
    expect(envelope.truncated).toBe(false);
    expect(envelope.limitReason).toBeNull();
    expect(envelope.hint).toBeNull();
  });

  test('elapsedMs is rounded, and null when there is none', () => {
    expect(buildEnvelope(payload, { elapsedMs: 3.7 }).elapsedMs).toBe(4);
    expect(buildEnvelope(payload, { elapsedMs: -1 }).elapsedMs).toBe(0);
    expect(buildEnvelope(payload, {}).elapsedMs).toBeNull();
  });

  test('an absent payload does not throw', () => {
    expect(() => buildEnvelope()).not.toThrow();
    expect(buildEnvelope().rows).toBeNull();
    expect(buildEnvelope().rowCount).toBe(0);
  });

  test('a status object for a write keeps its documented shape', () => {
    // README.md documents these; the envelope wraps them, it does not reshape
    // them.
    const status = clampResult([{ affectedRows: 3, insertId: 7, changedRows: 1, warningStatus: 0, info: '' }], {});
    expect(buildEnvelope(status, {}).rows)
      .toEqual([{ affectedRows: 3, insertId: 7, changedRows: 1, warningStatus: 0, info: '' }]);
  });

  test('rows holds a db_schema description as one object, not an array', () => {
    const description = clampResult({ database: 'sqlite', tables: [], truncated: false }, {});
    const envelope = buildEnvelope(description, { driver: 'sqlite' });
    expect(envelope.rows).toEqual({ database: 'sqlite', tables: [], truncated: false });
    expect(envelope.rowCount).toBe(1);
  });
});
