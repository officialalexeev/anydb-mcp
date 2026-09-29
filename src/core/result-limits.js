/**
 * Result size limits and JSON normalisation.
 *
 * `normalizeForJson` never throws: a throw on the response path reaches the model
 * as an error blaming a statement that already ran. `maxRows` and `maxBytes` are
 * a cost control, and a truncated result is a prefix of the answer, which is why
 * the envelope carries `truncated`, `limitReason` and a `hint`.
 */
export const DEFAULT_MAX_ROWS = 1000;

/** 256 KiB. Comfortably inside one context window; roughly 60–70k tokens of JSON. */
export const DEFAULT_MAX_BYTES = 262144;

/** In a running server `evaluatePolicy` passes the `ANYDB_DEFAULT_*` pair. */
export const MAX_ROWS_ENV = ['ANYDB_MAX_ROWS', 'ANYDB_DEFAULT_MAX_ROWS'];
export const MAX_BYTES_ENV = ['ANYDB_MAX_BYTES', 'ANYDB_DEFAULT_MAX_BYTES'];

/** Rendering formats `formatRows` accepts. Anything else falls back to `json`. */
export const RESULT_FORMATS = Object.freeze(['json', 'jsonl', 'csv', 'tsv', 'markdown']);

export const MAX_NESTING_DEPTH = 40;

export const CIRCULAR_MARKER = '[circular]';

export const DEPTH_MARKER = '[max depth exceeded]';

/** A first positive integer from a list of candidates, or `fallback`. */
function firstPositiveInt(candidates, fallback) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() === '') continue;
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return fallback;
}

const typeName = (value) => {
  if (value === null) return 'null';
  const primitive = typeof value;
  if (primitive !== 'object' && primitive !== 'function') return primitive;
  // A property read can throw on a hostile `Proxy`; the name only lands in a
  // placeholder, so "object" is a fine answer.
  try {
    const ctor = value.constructor;
    return (ctor && typeof ctor.name === 'string' && ctor.name) || 'object';
  } catch {
    return 'object';
  }
};

/** True for a record literal — an object with no class of its own. */
const isPlainRecord = (value) => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isView = (value) =>
  (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value) && !(value instanceof DataView));

/**
 * `NaN` / `±Infinity` as a marker, not `null`: `JSON.stringify` already emits
 * `null` for them, and a NULL is indistinguishable from a real SQL NULL.
 */
const nonFiniteMarker = (value) =>
  Number.isNaN(value) ? '[non-finite: NaN]' : (value > 0 ? '[non-finite: Infinity]' : '[non-finite: -Infinity]');

const pad = (value, width) => String(Math.abs(value)).padStart(width, '0');

/**
 * The UTC offset of `date`, as `+HH:MM` / `-HH:MM`. `+00:00` rather than `Z` so a
 * local wall clock is never read as UTC. Rounded: some engines return fractions.
 */
export function resolvedTimezone(at = new Date()) {
  const total = Math.round(-at.getTimezoneOffset());
  const sign = total < 0 ? '-' : '+';
  const magnitude = Math.abs(total);
  return `${sign}${pad(Math.floor(magnitude / 60), 2)}:${pad(magnitude % 60, 2)}`;
}

/**
 * A `Date` as ISO-8601 in its own local wall clock, with the offset spelled out.
 * Not `toISOString()`: pg parses both `timestamp` (OID 1114, no zone) and
 * `timestamptz` (OID 1184) into a `Date`, and for the bare `timestamp` the
 * stored wall clock lands in the `Date`'s *local* fields, which `toISOString()`
 * shifts by the host's offset. The two differ only in whose offset is printed.
 */
function dateWithOffset(date) {
  const offsetMinutes = Math.round(-date.getTimezoneOffset());
  const sign = offsetMinutes < 0 ? '-' : '+';
  const magnitude = Math.abs(offsetMinutes);
  const stamp =
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}` +
    `T${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}` +
    `.${pad(date.getMilliseconds(), 3)}`;
  return `${stamp}${sign}${pad(Math.floor(magnitude / 60), 2)}:${pad(magnitude % 60, 2)}`;
}

/**
 * Binary data as `{ $binary: "<hex>", $bytes: n }`. `JSON.stringify` would emit a
 * `Buffer`'s internals at roughly double the size of the hex; hex is built in
 * 32 KiB slices so a large `bytea` does not double its peak memory first.
 */
function binaryMarker(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let hex = '';
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    hex += Buffer.from(bytes.subarray(offset, offset + CHUNK)).toString('hex');
  }
  return { $binary: hex, $bytes: bytes.length };
}

function decimalFromLowHigh(low, high) {
  let value = BigInt(high) * 4294967296n + BigInt(low >>> 0);
  if (value < 0n) value += 18446744073709551616n;
  return value.toString();
}

/**
 * BSON values, which have no JSON form a model can use. The same value arrives
 * three ways — a driver instance (`_bsontype`), an extended-JSON literal
 * (`{$numberDecimal: …}`), and the bare `{low, high}` pair — and the `{$…}` keys
 * (the `{$…}` keys count only for a plain record, so a class instance is never
 * mistaken for one; the `{low, high}` rule costs a real two-integer column).
 */
function bsonValue(value) {
  const bsonType = value._bsontype;
  if (typeof bsonType === 'string') {
    if ((bsonType === 'ObjectId' || bsonType === 'ObjectID') && typeof value.toHexString === 'function') {
      try {
        return value.toHexString();
      } catch {
        return `[unserializable: ${bsonType}]`;
      }
    }
    if ((bsonType === 'Decimal128' || bsonType === 'Long' || bsonType === 'Int32')
      && typeof value.toString === 'function') {
      try {
        return value.toString();
      } catch {
        return `[unserializable: ${bsonType}]`;
      }
    }
  }

  if (!isPlainRecord(value)) return undefined;

  if (typeof value.$numberDecimal === 'string') return value.$numberDecimal;
  if (typeof value.$oid === 'string') return value.$oid;
  if (typeof value.$numberLong === 'string' || typeof value.$numberLong === 'number') {
    return String(value.$numberLong);
  }

  const keys = Object.keys(value);
  if (keys.length === 2 && keys.includes('low') && keys.includes('high')
    && Number.isInteger(value.low) && Number.isInteger(value.high)
    && value.low >= 0 && value.low <= 0xffffffff) {
    return decimalFromLowHigh(value.low, value.high);
  }

  return undefined;
}

/**
 * Turn any driver value into something `JSON.stringify` accepts, with every
 * conversion marked. Never throws: a throw here is on the response path, after
 * the statement has already succeeded, and reaches the model as an error that
 * blames the query. The walk is iterative, and `MAX_NESTING_DEPTH` bounds the
 * output too, so a cut is marked with `DEPTH_MARKER` rather than silent.
 */
export function normalizeForJson(value) {
  // The *path* being walked, not everything ever entered: a repeated reference to
  // the same object is not a cycle, and `JSON.stringify` writes it out twice.
  const path = new Set();
  const root = { value: null };
  const stack = [{ parent: root, key: 'value', value, depth: 0 }];

  try {
    while (stack.length > 0) {
      const frame = stack.pop();
      const { parent, key, depth } = frame;

      // An exit marker, pushed before a container's children so it pops after
      // them, taking the container off the path again.
      if (frame.exit !== undefined) {
        path.delete(frame.exit);
        continue;
      }

      try {
        const current = frame.value;
        if (current === null) {
          parent[key] = null;
          continue;
        }

        const type = typeof current;
        if (type === 'string' || type === 'boolean') {
          parent[key] = current;
          continue;
        }
        if (type === 'number') {
          parent[key] = Number.isFinite(current) ? current : nonFiniteMarker(current);
          continue;
        }
        if (type === 'bigint') {
          // `JSON.stringify` throws on a bigint; the decimal string is lossless.
          parent[key] = current.toString();
          continue;
        }
        if (type === 'undefined') {
          // `null` here, key dropped in the object branch below, as `JSON.stringify` does.
          parent[key] = null;
          continue;
        }
        if (type === 'symbol') {
          parent[key] = '[symbol]';
          continue;
        }
        if (type === 'function') {
          parent[key] = `[function ${current.name || 'anonymous'}]`;
          continue;
        }

        if (current instanceof Date) {
          parent[key] = Number.isNaN(current.getTime()) ? '[invalid date]' : dateWithOffset(current);
          continue;
        }
        if (isView(current)) {
          parent[key] = binaryMarker(current);
          continue;
        }
        if (typeof ArrayBuffer !== 'undefined' && current instanceof ArrayBuffer) {
          parent[key] = binaryMarker(new Uint8Array(current));
          continue;
        }
        if (current instanceof Map || current instanceof Set) {
          // An object literal would render as `{}`, a silent lie about the size.
          parent[key] = `[${current.constructor?.name || (current instanceof Set ? 'Set' : 'Map')} ${current.size}]`;
          continue;
        }

        const bson = bsonValue(current);
        if (bson !== undefined) {
          parent[key] = bson;
          continue;
        }

        if (depth >= MAX_NESTING_DEPTH) {
          parent[key] = DEPTH_MARKER;
          continue;
        }
        if (path.has(current)) {
          parent[key] = CIRCULAR_MARKER;
          continue;
        }
        path.add(current);

        if (Array.isArray(current)) {
          const out = new Array(current.length);
          parent[key] = out;
          stack.push({ exit: current });
          for (let i = current.length - 1; i >= 0; i--) {
            stack.push({ parent: out, key: i, value: current[i], depth: depth + 1 });
          }
          continue;
        }
        if (type === 'object') {
          // Pushed back to front so the LIFO stack fills them front to back:
          // `tabulate()` reads `Object.keys`, and column order is the result.
          const entries = Object.entries(current);
          if (entries.length === 0 && !isPlainRecord(current)) {
            // A class instance with no own enumerable properties, which
            // `JSON.stringify` renders as `{}`.
            path.delete(current);
            parent[key] = `[unserializable: ${typeName(current)}]`;
            continue;
          }
          const out = {};
          parent[key] = out;
          stack.push({ exit: current });
          for (let i = entries.length - 1; i >= 0; i--) {
            const [name, child] = entries[i];
            if (child === undefined) continue;
            stack.push({ parent: out, key: name, value: child, depth: depth + 1 });
          }
          continue;
        }

        parent[key] = `[unserializable: ${typeName(current)}]`;
      } catch {
        // A throwing getter, a hostile Proxy, a `toString` that throws: the one
        // undescribable value is replaced, the rest still arrives.
        parent[key] = `[unserializable: ${typeName(frame.value)}]`;
      }
    }
  } catch {
    // A guarantee that depends on every code path being right is not a guarantee.
    return `[unserializable: ${typeName(value)}]`;
  }
  return root.value;
}

const utf8Length = (text) => Buffer.byteLength(text, 'utf8');

/**
 * Size of a value's JSON form, in bytes. UTF-8 length, not `.length`: the budget
 * is about tokens, and a character count and a byte count first disagree on
 * multibyte text. Returns 0 rather than throwing.
 */
export function measureBytes(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? utf8Length(text) : 0;
  } catch {
    return 0;
  }
}

/**
 * The markers an adapter puts on a result it truncated itself.
 *
 * NON-ENUMERABLE on purpose: a row set is a bare array on the wire, and
 * `[{…}, {…}, truncated: true]` is not one. So the marker is readable by direct
 * property access and invisible to `JSON.stringify` — which also means the
 * normalisation walk cannot see it, and this read is the only one that can.
 *
 * @param {*} data - The adapter's payload, un-normalised
 */
function adapterMarks(data) {
  const empty = { truncated: false, limitReason: null, droppedRows: 0, nextCursor: undefined };
  if (data === null || typeof data !== 'object') return empty;

  // A property read can throw on a hostile `Proxy`. A throw counts as "no marker",
  // which under-reports rather than fails a call that succeeded.
  try {
    const truncated = data.truncated === true;
    const rawReason = data.limitReason;
    const rawDropped = data.droppedRows;
    const dropped = Number.isInteger(rawDropped) && rawDropped > 0 ? rawDropped : 0;

    return {
      truncated,
      // The adapter's own words where it gave any. Only the flag is load-bearing.
      limitReason: typeof rawReason === 'string' && rawReason !== '' ? rawReason : null,
      droppedRows: dropped,
      // Left out of the return when absent, keeping the six-key shape unchanged.
      nextCursor: data.nextCursor === undefined ? undefined : data.nextCursor,
    };
  } catch {
    return empty;
  }
}

/**
 * Cap a result by row count and by byte size. A cost control, not a correctness
 * one. An adapter's own truncation is reported even when these limits cut
 * nothing: the adapter saw the row that proved the answer was longer than what
 * it returned, and this function never sees that row.
 *
 * @param {*} data - An array is capped as rows; anything else (a `db_schema`
 *   description, say) is one value, kept whole or dropped — there is no partial
 *   version of it to hand back.
 * @param {object} [limits] - `{ maxRows, maxBytes }`, normally from `./policy.js`
 * @param {object} [limits.env] - Environment to read the two names from
 */
export function clampResult(data, limits = {}) {
  const env = limits.env ?? process.env;
  const maxRows = firstPositiveInt(
    [limits.maxRows, ...MAX_ROWS_ENV.map((name) => env[name])],
    DEFAULT_MAX_ROWS
  );
  const maxBytes = firstPositiveInt(
    [limits.maxBytes, ...MAX_BYTES_ENV.map((name) => env[name])],
    DEFAULT_MAX_BYTES
  );

  // Read off the ORIGINAL payload, before normalisation: the walk cannot see it.
  const marks = adapterMarks(data);
  const asArray = Array.isArray(data);
  const normalised = normalizeForJson(data);
  const limitReason = (reason) => ({ truncated: true, limitReason: reason });
  // Present only when the adapter attached one, keeping the six-key shape.
  const cursor = marks.nextCursor === undefined ? {} : { nextCursor: marks.nextCursor };

  if (!asArray) {
    const bytes = measureBytes(normalised);
    if (bytes > maxBytes) {
      // No prefix of an object is a smaller object. The whole value is dropped
      // with the reason, so the model narrows the request.
      return {
        rows: null, rowCount: 0, bytes: 0, droppedRows: 1 + marks.droppedRows,
        ...limitReason('maxBytes'), ...cursor,
      };
    }
    // A description the adapter already truncated is still a prefix.
    return {
      rows: normalised,
      rowCount: 1,
      truncated: marks.truncated,
      bytes,
      limitReason: marks.truncated ? marks.limitReason : null,
      droppedRows: marks.droppedRows,
      ...cursor,
    };
  }

  let rows = normalised;
  let droppedRows = marks.droppedRows;
  let reason = null;

  if (rows.length > maxRows) {
    rows = rows.slice(0, maxRows);
    droppedRows += rows.length === 0 ? 0 : normalised.length - maxRows;
    reason = 'maxRows';
  }

  // One byte per comma between rows: the size of the array actually returned.
  let bytes = rows.length === 0 ? 2 : 2 + rows.reduce((total, row) => total + measureBytes(row) + 1, -1);
  while (rows.length > 0 && bytes > maxBytes) {
    rows = rows.slice(0, -1);
    droppedRows += 1;
    bytes = rows.length === 0
      ? 2
      : 2 + rows.reduce((total, row) => total + measureBytes(row) + 1, -1);
    reason = 'maxBytes';
  }

  // A single row larger than the whole budget is dropped rather than returned
  // over budget, which may leave nothing behind it.
  return {
    rows,
    rowCount: rows.length,
    // `||` not `&&`: the adapter's truncation stands even when this cut nothing.
    truncated: droppedRows > 0 || marks.truncated,
    bytes,
    // The reason for the cut that actually happened, the adapter's when it cut.
    limitReason: reason ?? (marks.truncated ? marks.limitReason : null),
    droppedRows,
    ...cursor,
  };
}

/** One cell, as text. Nested values are flattened to their JSON form. */
function cellText(value) {
  if (value === null || value === undefined) return '';
  const type = typeof value;
  if (type === 'string') return value;
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

/**
 * Columns for a set of rows: the union of the keys of every plain-object row, in
 * first-seen order, so a `SELECT` that does not return the same columns for every
 * row still lines up. Non-object rows get a single `value` column.
 */
function tabulate(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    if (!isPlainRecord(row)) {
      return { columns: ['value'], cells: rows.map((entry) => [cellText(entry)]) };
    }
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return { columns, cells: rows.map((row) => columns.map((column) => cellText(row[column]))) };
}

/**
 * RFC 4180 quoting: wrapped in `"` when the field holds the delimiter, a quote or
 * a line break, and an embedded quote is doubled. Leading or trailing space is
 * quoted too, because every CSV reader silently drops an unquoted one.
 */
function quoteField(text, delimiter) {
  const needsQuotes = text.includes('"')
    || text.includes(delimiter)
    || text.includes('\n')
    || text.includes('\r')
    || text !== text.trim();
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One record line, RFC 4180 quoted. */
const csvLine = (cells, delimiter) => cells.map((cell) => quoteField(cell, delimiter)).join(delimiter);

const renderCsv = (rows, delimiter, omitted) => {
  const { columns, cells } = tabulate(rows);
  const lines = [csvLine(columns, delimiter), ...cells.map((row) => csvLine(row, delimiter))];
  // Line-oriented, so the cut can be stated in the output. `json` and `jsonl`
  // cannot: a note would make them unparseable, and the envelope carries it.
  if (omitted > 0) {
    lines.push(csvLine(['…', `${omitted} row(s) omitted by a result limit`], delimiter));
  }
  return lines.join('\n');
};

/** GFM pipe table. Pipes and backslashes are escaped; a line break becomes `<br>`. */
const markdownCell = (text) => text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
const renderMarkdown = (rows, omitted) => {
  const { columns, cells } = tabulate(rows);
  const lines = [
    `| ${columns.map(markdownCell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...cells.map((row) => `| ${row.map(markdownCell).join(' | ')} |`),
  ];
  if (omitted > 0) {
    lines.push(`| … | _${omitted} row(s) omitted by a result limit_ |`);
  }
  return lines.join('\n');
};

/** Render `count` of `rows` in `mode`, plus a note about what was left out. */
function renderRows(mode, rows, count, omitted) {
  const kept = rows.slice(0, count);
  if (mode === 'json') return JSON.stringify(kept);
  if (mode === 'jsonl') return kept.map((row) => JSON.stringify(row)).join('\n');
  if (mode === 'csv') return renderCsv(kept, ',', omitted);
  if (mode === 'tsv') return renderCsv(kept, '\t', omitted);
  if (mode === 'markdown') return renderMarkdown(kept, omitted);
  return JSON.stringify(kept);
}

const FALLBACK_NOTES = Object.freeze({
  csv: '# format "csv" needs an array of rows; this result is a single value, so it is rendered as json.',
  tsv: '# format "tsv" needs an array of rows; this result is a single value, so it is rendered as json.',
  markdown: '# format "markdown" needs an array of rows; this result is a single value, so it is rendered as json.',
});

/**
 * Render rows for a text content block.
 *
 * `json` is **compact**, a deliberate change from `JSON.stringify(data, null, 2)`:
 * pretty-printing a 1000-row, 10-column result adds 30–60% of the payload, all of
 * it billed for indentation no model reads.
 *
 * A single value has no table form, so `csv` / `tsv` / `markdown` fall back to
 * `json` with a one-line note.
 *
 * The byte budget is enforced on the *rendered* text too, because CSV quoting
 * inflates; for `json` and `jsonl` that cut is silent, the envelope carries it.
 */
export function formatRows(rows, format = 'json', options = {}) {
  const mode = RESULT_FORMATS.includes(format) ? format : 'json';
  const list = Array.isArray(rows) ? rows : null;

  if (list === null) {
    // A one-row table around a single value would be a lie about its shape.
    if (mode === 'json') return JSON.stringify(rows);
    if (mode === 'jsonl') return `${JSON.stringify(rows)}\n`;
    return `${FALLBACK_NOTES[mode]}\n${JSON.stringify(rows)}`;
  }

  const values = list;
  const budget = firstPositiveInt([options.maxBytes], 0);

  let text = renderRows(mode, values, values.length, 0);
  if (budget <= 0 || utf8Length(text) <= budget) return text;

  // Re-truncate, dropping a quarter of what is left so a result 100x over budget
  // costs a handful of renders. Bounded: `keep` falls by at least one per pass.
  let keep = values.length;
  while (keep > 0 && utf8Length(renderRows(mode, values, keep, values.length - keep)) > budget) {
    keep -= Math.max(1, Math.ceil(keep / 4));
  }
  if (keep < 0) keep = 0;
  return renderRows(mode, values, keep, values.length - keep);
}

export const LIMIT_HINTS = Object.freeze({
  maxRows: 'Add a LIMIT, or an "offset", to continue where this stopped. A truncated result is a prefix of the answer, not the answer.',
  maxBytes: 'Select fewer columns, or add a LIMIT, to bring the result under the byte limit. A truncated result is a prefix of the answer, not the answer.',
});

/**
 * The response every tool returns. In 2.x `db_query` returned a bare array; MCP
 * requires `structuredContent` to be an object, so 3.0 wraps it. `rows` holds
 * exactly what the array used to, and every field is present on every response,
 * so a model never has to check whether a key exists.
 */
export function buildEnvelope(payload = {}, meta = {}) {
  const truncated = payload.truncated === true;
  const reason = truncated ? (payload.limitReason ?? null) : null;
  const dropped = Number.isInteger(payload.droppedRows) ? payload.droppedRows : 0;
  // `meta` first: `registry.js` reads the cursor off the raw adapter return value
  // and passes it in `meta`. The payload copy is the only place it survives — a
  // cursor is not part of a JSON array.
  const nextCursor = meta.nextCursor ?? payload.nextCursor ?? null;

  let hint = meta.hint ?? null;
  if (truncated && hint === null) {
    hint = LIMIT_HINTS[reason] ?? LIMIT_HINTS.maxRows;
    if (dropped > 0) hint += ` ${dropped} row(s) were dropped.`;
    // No adapter sets `nextCursor` in 3.0, so this is dead; a resume token the
    // model can never obtain is worse than none.
    if (nextCursor) hint += ` Pass back "cursor": ${JSON.stringify(nextCursor)} to continue.`;
  }

  return {
    rows: payload.rows === undefined ? null : payload.rows,
    rowCount: Number.isInteger(payload.rowCount) ? payload.rowCount : 0,
    truncated,
    bytes: Number.isFinite(payload.bytes) ? payload.bytes : 0,
    elapsedMs: Number.isFinite(meta.elapsedMs) ? Math.max(0, Math.round(meta.elapsedMs)) : null,
    profile: meta.profile ?? null,
    driver: meta.driver ?? null,
    limitReason: reason,
    nextCursor,
    timezone: meta.timezone ?? resolvedTimezone(),
    hint,
  };
}
