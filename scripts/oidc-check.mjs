// Asks npm whether it accepts this workflow's identity, and prints why if not.
//
// Publishes nothing. npm's exchange endpoint hands back a short-lived publish
// token without consuming it, so the configuration can be tested before a
// release instead of during one.
//
//   node scripts/oidc-check.mjs            report only, always exits 0
//   node scripts/oidc-check.mjs --require  exit 1 when npm rejects the identity
//
// The release job runs it with --require. npm's own answer to a mismatched
// trusted publisher is a 404 that reads like "no such package", and by the time
// `npm publish` hits that the run has already failed with ENEEDAUTH and nothing
// has been published. Catching it first turns a confusing failure into a
// sentence naming the field that is wrong.
//
// Job logs are 403 over the public API, so the annotations below are the only
// output anyone can read from outside. Every path therefore ends in a printed
// annotation, including the ones that are not supposed to happen.

import process from 'node:process';

const PACKAGE = 'anydb-mcp';
const AUDIENCE = 'npm:registry.npmjs.org';
const STRICT = process.argv.includes('--require');

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
  // response along was the bug that killed the first version of this script.
  const minted = await res.json();
  const token = minted.value ?? minted.id_token ?? minted;
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new Error(`unexpected token response: ${JSON.stringify(minted).slice(0, 200)}`);
  }

  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  notice('OIDC sub', String(claims.sub));
  notice('OIDC aud', JSON.stringify(claims.aud));
  notice('OIDC repository', String(claims.repository));
  notice('OIDC environment_name', JSON.stringify(claims.environment_name ?? null));
  // npm matches the "Workflow filename" field against this claim, not against
  // the subject, so a check run from any file other than the one that publishes
  // can only ever report a mismatch that is not there. That is why this lives in
  // release.yml and not in a workflow of its own.
  notice('OIDC job_workflow_ref', String(claims.job_workflow_ref));
  notice('OIDC actor', String(claims.actor ?? claims.actor_id ?? '(none)'));

  // The /npm/ segment is part of the path. Without it npm answers 404
  // ResourceNotFound, which reads exactly like a missing trusted publisher and
  // sent the first version of this check hunting a configuration that was
  // correct all along.
  const exchanged = await fetch(
    `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(PACKAGE)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  const body = (await exchanged.text()).slice(0, 500);

  notice('exchange HTTP', String(exchanged.status));
  notice('exchange body', body.replace(/\s+/g, ' '));

  if (exchanged.ok) {
    notice('result', 'npm accepted the identity. Trusted publishing is configured correctly.');
    return 0;
  }

  // A 404 here is npm's deliberate choice to hide "this identity is not
  // registered for this package" behind the same answer as "no such package",
  // so the package is known to exist and the entry is what is missing.
  notice('result', 'npm rejected the identity. No trusted publisher on npmjs.com matches this workflow.');
  error(`expected sub : repo:officialalexeev/anydb-mcp:environment:npm`);
  error(`got sub      : ${claims.sub}`);
  error(`expected aud : ${AUDIENCE}`);
  error(`got aud      : ${JSON.stringify(claims.aud)}`);
  error(`subject match means Environment name = npm. Leave it empty and the subject becomes ...:ref: or ...:tag:, which is a different, non-matching identity.`);
  error(`see what is registered: GET https://registry.npmjs.org/-/package/${PACKAGE}/trust  (needs an npm token)`);
  error(`or read it at https://www.npmjs.com/settings/anydb-mcp/access/publishers`);
  error('fields, all case-sensitive:');
  error('  Organization or user = officialalexeev');
  error('  Repository          = anydb-mcp');
  error("  Workflow filename   = release.yml    (the filename only, with the extension, no path)");
  error('  Environment name    = npm            (must match, or must be empty on BOTH sides)');
  error('  Allowed actions     = npm publish    (entries created after 2026-09-03 allow only `npm stage publish` by default)');
  error('an existing connection cannot be edited: delete it, add it again, then re-run.');

  return 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  notice('the check itself broke', e?.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  // A broken check is not a passing check, but it is not a configuration
  // verdict either. Only --require turns this into a hard failure.
  code = STRICT ? 1 : 0;
}
process.exit(code);
