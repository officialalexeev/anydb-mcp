// Asks npm whether it accepts this workflow's identity, and prints why if not.
//
// Publishes nothing. npm's exchange endpoint hands back a publish token
// without consuming it, so the configuration can be tested without burning a
// version number on a diagnostic.
//
// run: node scripts/oidc-check.mjs

const PACKAGE = 'anydb-mcp';
const AUDIENCE = 'npm:registry.npmjs.org';

const notice = (title, message) => console.log(`::notice title=${title}::${message}`);
const error = (line) => console.log(`::error::${line}`);

async function mint() {
  const url = `${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${AUDIENCE}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!res.ok) throw new Error(`minting the OIDC token: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

const token = await mint();
const { sub, aud, repository } = claims(token.id_token ?? token);

notice('subject', sub);
notice('audience', JSON.stringify(aud));
notice('repository', repository);

const res = await fetch(`https://registry.npmjs.org/-/v1/oidc/token/exchange/package/${PACKAGE}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token.id_token ?? token}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const body = (await res.text()).slice(0, 500);

notice('exchange HTTP', String(res.status));
notice('exchange body', body.replace(/\s+/g, ' '));

if (res.ok) {
  notice('result', 'npm accepted the identity. If a release still fails, the mismatch is the Environment name field, which this job does not exercise.');
} else {
  notice('result', 'npm rejected the identity. The Trusted Publisher entry on npmjs.com does not match this workflow.');
  error('expected sub: repo:officialalexeev/anydb-mcp:environment:npm');
  error('expected aud: npm:registry.npmjs.org');
  error('check, in this order at https://www.npmjs.com/settings/anydb-mcp/access/publishers:');
  error('  1. Organization or user = officialalexeev');
  error('  2. Repository          = anydb-mcp');
  error('  3. Workflow filename   = release.yml   (the filename only, with the extension, no path)');
  error('  4. Environment name    = npm           (the subject carries :environment:npm)');
  error('  5. Allowed actions     = npm publish   (entries created since 2026-09-03 allow stage only by default)');
  error('an existing entry cannot be edited. delete it and create it again, then re-run this workflow.');
}
