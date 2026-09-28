const REDACTED = '***';

/**
 * Strip credentials so a connection string is safe to write to a log.
 *
 * MCP clients capture the server's stderr into their own logs, so anything
 * written there is outside our control.
 */
export function maskUri(uri) {
  if (typeof uri !== 'string' || uri.length === 0) return String(uri);

  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) return uri;

  const scheme = uri.slice(0, schemeEnd + 3);
  let rest = uri.slice(schemeEnd + 3);

  // Dropped rather than parsed: MongoDB and Redis both accept credentials in
  // query parameters.
  const suffixAt = rest.search(/[?#]/);
  let suffix = '';
  if (suffixAt !== -1) {
    suffix = ' <params redacted>';
    rest = rest.slice(0, suffixAt);
  }

  const at = rest.lastIndexOf('@');
  if (at === -1) return scheme + rest + suffix;

  const userinfo = rest.slice(0, at);
  const colon = userinfo.indexOf(':');
  if (colon === -1) return scheme + userinfo + '@' + rest.slice(at + 1) + suffix;

  return `${scheme}${userinfo.slice(0, colon)}:${REDACTED}@${rest.slice(at + 1)}${suffix}`;
}

/**
 * Identify a query without echoing it, since query text can hold sensitive
 * literals.
 */
export function describeQuery(query) {
  if (typeof query !== 'string') return `<${typeof query}>`;
  const trimmed = query.trim();
  if (!trimmed) return '<empty>';
  const verb = (trimmed.match(/^[a-z]+/i) || ['query'])[0].toUpperCase();
  return `${verb} (${trimmed.length} chars)`;
}

const debugEnabled = () => process.env.ANYDB_DEBUG === '1' || process.env.ANYDB_DEBUG === 'true';

/** Stderr only: stdout carries protocol traffic. */
export function log(message, detail = {}) {
  const parts = Object.entries(detail)
    .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}...` : v}`);

  console.error(`[anydb] ${message}${parts.length ? ` ${parts.join(' ')}` : ''}`);
}

export function logQueryDetail(uri, query) {
  if (!debugEnabled()) return;
  log('query', { uri: maskUri(uri), query });
}

export const isDebugEnabled = debugEnabled;
