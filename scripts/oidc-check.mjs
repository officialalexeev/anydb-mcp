// Asks npm whether it accepts this workflow's identity, and prints why if not.
//
// Publishes nothing. npm's exchange endpoint hands back a publish token
// without consuming it, so the configuration can be tested without burning a
// version number on a diagnostic.
//
// run: node scripts/oidc-check.mjs
//
// Job logs are 403 over the public API, so the annotations are the only output
// anyone can read. That makes silence the worst possible outcome: two earlier
// versions of this script died before printing a word and left a bare "exit
// code 1" to debug. Every path below therefore ends in a printed annotation,
// including the ones that are not supposed to happen.

const PACKAGE = 'anydb-mcp';
const AUDIENCE = 'npm:registry.npmjs.org';

const notice = (title, message) => console.log(`::notice title=${title}::${message}`);
const error = (line) => console.log(`::error::${line}`);

async function main() {
  const url = `${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${AUDIENCE}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    });
  } catch (e) {
    throw new Error(`could not reach the token endpoint: ${e.message}`);
  }
  if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

  // GitHub answers with {count, value}; the JWT is in `value`. Passing the whole
  // response along was the bug that killed the first version.
  const minted = await res.json();
  const token = minted.value ?? minted.id_token ?? minted;
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new Error(`unexpected token response: ${JSON.stringify(minted).slice(0, 200)}`);
  }

  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  notice('subject', String(claims.sub));
  notice('audience', JSON.stringify(claims.aud));
  notice('repository', String(claims.repository));

  const exchanged = await fetch(`https://registry.npmjs.org/-/v1/oidc/token/exchange/package/${PACKAGE}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = (await exchanged.text()).slice(0, 500);

  notice('exchange HTTP', String(exchanged.status));
  notice('exchange body', body.replace(/\s+/g, ' '));

  if (exchanged.ok) {
    notice('result', 'npm accepted the identity. If a release still fails, the mismatch is the Environment name field, which this job does not exercise.');
    return;
  }

  notice('result', 'npm rejected the identity. The Trusted Publisher entry on npmjs.com does not match this workflow.');
  error(`expected sub: repo:officialalexeev/anydb-mcp:environment:npm`);
  error(`expected aud: ${AUDIENCE}`);
  error('check, in this order at https://www.npmjs.com/settings/anydb-mcp/access/publishers:');
  error('  1. Organization or user = officialalexeev');
  error('  2. Repository          = anydb-mcp');
  error('  3. Workflow filename   = release.yml   (the filename only, with the extension, no path)');
  error('  4. Environment name    = npm           (the subject carries :environment:npm)');
  error('  5. Allowed actions     = npm publish   (entries created since 2026-09-03 allow stage only by default)');
  error('an existing entry cannot be edited. delete it and create it again, then re-run this workflow.');
}

try {
  await main();
} catch (e) {
  notice('the check itself broke', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  process.exitCode = 0;
}
