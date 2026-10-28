/**
 * Cross-check every Client call site against the Host method that receives it.
 *
 * The gateway forwards only the keys the Client actually sends, so a Client that
 * sends `{ dir }` to a Host reading `input.source` produces a silently ignored
 * argument, and a Host reading a key the Client never sends produces "`x` is
 * required". Both are invisible to a harness whose payloads were hand-written,
 * which is exactly how the wire-name bug survived.
 *
 * Usage: node check-remote-payloads.mjs
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));
const PLUGINS = [{ label: basename(PLUGIN_DIR), dir: PLUGIN_DIR }];

/**
 * Return the source between `(` at `open` and its matching `)`.
 * @param text - source to scan.
 * @param open - index of the opening parenthesis.
 */
function argumentText(text, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return '';
}

/**
 * Top-level object-literal keys in a call's argument list, including the keys of
 * object literals spread through a ternary (`...(cond ? { a } : { b })`).
 * @param text - the argument-list source.
 */
function sentKeys(text) {
  const keys = new Set();
  const literals = [];
  /* Collect every brace group that sits at argument depth 0 or inside a spread. */
  let depth = 0;
  let quote = null;
  let spread = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '.' && text.slice(index, index + 3) === '...') spread = true;
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === '{') {
      if (start < 0 && (depth === 0 || spread || text.slice(Math.max(0, index - 1), index) === '?' || text.slice(Math.max(0, index - 1), index) === ':')) start = index;
    } else if (char === '}') {
      if (start >= 0) {
        literals.push(text.slice(start, index + 1));
        start = -1;
        spread = false;
      }
    }
  }
  for (const literal of literals) {
    for (const match of literal.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g)) {
      /* `cond ? undefined : value` is not a key. */
      if (['undefined', 'null', 'true', 'false', 'default'].includes(match[1])) continue;
      keys.add(match[1]);
    }
  }
  return keys;
}

let failed = false;
for (const plugin of PLUGINS) {
  const client = readFileSync(`${plugin.dir}/client.js`, 'utf8');
  const host = readFileSync(`${plugin.dir}/index.js`, 'utf8');
  /* Every method the Host publishes as Remote must be reachable from the page,
     and the page must not call a name the Host does not publish. */
  const published = [...host.matchAll(/const REMOTE_METHODS = \[([\s\S]*?)\]/g)].flatMap((match) => [...match[1].matchAll(/'([\w$]+)'/g)].map((entry) => entry[1]));
  const called = new Set([...client.matchAll(/api\.([\w$]+)\(/g)].map((match) => match[1]));
  /* Host: the keys each Remote method reads off its single parameter. */
  const headers = [...host.matchAll(/\n {2}async (\w+)\((input|payload)\)/g)];
  const hostKeys = new Map();
  for (const [index, match] of headers.entries()) {
    const from = match.index;
    const to = index + 1 < headers.length ? headers[index + 1].index : host.length;
    const body = host.slice(from, to);
    const name = match[2];
    /* `x.key`, `x?.key`, and `const { a, b } = x` all read a payload key. */
    const keys = new Set([
      ...[...body.matchAll(new RegExp(`${name}\\??\\.([A-Za-z_$][\\w$]*)`, 'g'))].map((entry) => entry[1]),
      ...[...body.matchAll(new RegExp(`const \\{([^}]*)\\} = ${name}\\b`, 'g'))].flatMap((entry) =>
        entry[1].split(',').map((part) => part.split(':').at(-1).trim().replace(/^\.\.\./u, '')).filter((part) => /^[A-Za-z_$][\w$]*$/u.test(part)),
      ),
    ]);
    hostKeys.set(match[1], keys);
  }
  /* Client: what each call site actually sends. */
  const calls = new Map();
  for (const match of client.matchAll(/(?:api|ctx\.get\('remote\.\w+'\))\.(\w+)\(/g)) {
    const open = match.index + match[0].length - 1;
    const text = argumentText(client, open);
    if (text.trim() === '') continue;
    const keys = sentKeys(text);
    if (keys.size === 0) continue;
    calls.set(match[1], new Set([...(calls.get(match[1]) ?? []), ...keys]));
  }
  console.log(`\n${plugin.label}  (${String(hostKeys.size)} Remote methods, ${String(calls.size)} call sites with a payload)`);
  const unreachable = published.filter((method) => !called.has(method));
  const phantom = [...called].filter((method) => !published.includes(method));
  if (unreachable.length > 0) failed = true;
  if (phantom.length > 0) failed = true;
  console.log(`  ${unreachable.length === 0 ? 'ok      ' : 'FAIL    '}  every published method is called by the page${unreachable.length === 0 ? '' : `  <-- never called: ${unreachable.join(', ')}`}`);
  console.log(`  ${phantom.length === 0 ? 'ok      ' : 'FAIL    '}  every call names a published method${phantom.length === 0 ? '' : `  <-- not published: ${phantom.join(', ')}`}`);
  for (const [method, keys] of calls) {
    const reads = hostKeys.get(method);
    if (reads === undefined) {
      failed = true;
      console.log(`  FAIL    ${method}: no such Remote method on the Host`);
      continue;
    }
    const ignored = [...keys].filter((key) => !reads.has(key));
    const unsent = [...reads].filter((key) => !keys.has(key));
    if (ignored.length > 0) failed = true;
    console.log(`  ${ignored.length === 0 ? 'ok      ' : 'FAIL    '}  ${method}: sends {${[...keys].join(', ')}}${ignored.length === 0 ? '' : `  <-- Host never reads ${ignored.join(', ')}`}`);
    if (unsent.length > 0) console.log(`          host also reads {${unsent.join(', ')}} (client relies on the optional path)`);
  }
}

console.log(failed ? '\nFAILED' : '\nOK: every payload key the Client sends is read by the Host');
process.exitCode = failed ? 1 : 0;
