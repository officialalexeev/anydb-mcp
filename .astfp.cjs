// AST fingerprint: comments are not part of the AST, so this is exact.
const fs = require('fs');
const crypto = require('crypto');
const parser = require('@babel/parser');

function literal(node) {
  if (node === null || node === undefined) return String(node);
  if (Array.isArray(node)) return '[' + node.map(literal).join(',') + ']';
  if (typeof node === 'object') {
    const keys = Object.keys(node)
      .filter((k) => !/^(start|end|loc|range|leadingComments|trailingComments|innerComments|comments|extra|tokens|errors)$/.test(k))
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + literal(node[k])).join(',') + '}';
  }
  if (typeof node === 'string') return JSON.stringify(node);
  return String(node);
}

let bad = 0;
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, 'utf8');
  let ast;
  try {
    ast = parser.parse(src, { sourceType: 'unambiguous', errorRecovery: false });
  } catch (e) {
    console.log(f.padEnd(44), 'PARSE ERROR:', e.message);
    bad++;
    continue;
  }
  delete ast.comments;
  delete ast.errors;
  delete ast.tokens;
  const text = literal(ast.program ?? ast);
  const h = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  console.log(f.padEnd(44), h, (text.length / 1024).toFixed(1) + ' KiB ast');
}
process.exit(bad ? 1 : 0);
