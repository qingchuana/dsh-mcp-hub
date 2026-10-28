/**
 * Check this plugin's Remote contract against the shipped gateway:
 *   1. method names must not collide with the reserved namespace surface;
 *   2. each method's parameter list must satisfy the SRC signature rule the
 *      gateway enforces — plain unique identifiers, no destructuring, defaults
 *      or rest (dsh-api-gateway/lib/index.js:1458 `methodParameterNames`);
 *   3. the Host parameter NAME becomes the wire key, so it must equal the wire
 *      each Client descriptor sends.
 *
 * Skipped when no DSH installation is found (see tools/lib/dsh-paths.mjs).
 *
 * Usage: node tools/check-reserved-names.mjs
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGateway, skip } from './lib/dsh-paths.mjs';

const GATEWAY = findGateway();
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));
const PLUGINS = [
  { dir: PLUGIN_DIR, host: join(PLUGIN_DIR, 'index.js'), client: join(PLUGIN_DIR, 'client.js') },
];

if (GATEWAY === undefined) {
  skip('the Remote contract checks', PLUGIN_DIR);
  process.exit(0);
}

const source = readFileSync(GATEWAY, 'utf8');

/** Names the gateway refuses outright. */
const reserved = new Set(['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace']);

/** Prototype members parsed from the shipped class body. */
const classStart = source.indexOf('var RemoteNamespaceService = class');
const classEnd = source.indexOf('\n\t\t};', classStart);
const body = source.slice(classStart, classEnd);
for (const match of body.matchAll(/^\t{3}(?:get |set )?([A-Za-z_$][\w$]*)\s*[(;=]/gm)) reserved.add(match[1]);
/* `assertMethodAvailable` tests `method in RemoteNamespaceService.prototype`,
   and `in` walks the whole chain, so every Object.prototype string key is
   reserved as well. */
for (const key of Object.getOwnPropertyNames(Object.prototype)) reserved.add(key);

console.log('reserved names:', [...reserved].sort().join(', '));

let failed = false;
for (const plugin of PLUGINS) {
  const pluginSource = readFileSync(plugin.host, 'utf8');
  const clientSource = readFileSync(plugin.client, 'utf8');
  const listStart = pluginSource.indexOf('const REMOTE_METHODS = [');
  const listEnd = pluginSource.indexOf('];', listStart);
  const methods = [...pluginSource.slice(listStart, listEnd).matchAll(/'([\w$]+)'/g)].map((match) => match[1]);
  const collisions = methods.filter((name) => reserved.has(name));
  const label = basename(plugin.dir);
  /* The wire each Client descriptor sends, taken from its own payload helper. */
  const helper = /function payload\([^)]*\) \{\s*return \[\{ name: '([\w$]+)', wire: '([\w$]+)'/u.exec(clientSource);
  const wire = helper?.[2];
  console.log(`\n${label} (${String(methods.length)} methods, client wire ${JSON.stringify(wire)})`);
  if (wire === undefined) {
    failed = true;
    console.error('  FAIL: could not read the client payload helper');
  }
  for (const name of methods) {
    const header = new RegExp(`\\n  async ${name}\\(([^)]*)\\)`).exec(pluginSource);
    if (header === null) {
      failed = true;
      console.error(`  MISSING  ${name}: no matching \`async ${name}(...)\` in index.js`);
      continue;
    }
    const body = header[1].trim();
    const parts = body === '' ? [] : body.split(',').map((part) => part.trim());
    const names = new Set();
    let verdict = 'ok';
    for (const part of parts) {
      if (!/^[$A-Z_a-z][$\w]*$/u.test(part) || names.has(part)) verdict = 'SIGNATURE';
      names.add(part);
    }
    /* `endpoint('x')` sends nothing; `endpoint('x', payload(...))` sends one value. */
    const call = new RegExp(`endpoint\\('${name}'(\\)|,)`).exec(clientSource);
    const sends = call?.[1] === ',' ? 1 : 0;
    if (call === null) verdict = 'NO-DESCRIPTOR';
    else if (parts.length !== sends) verdict = 'WIRE-COUNT';
    else if (sends === 1 && parts[0] !== wire) verdict = 'WIRE-NAME';
    if (verdict !== 'ok') failed = true;
    console.log(`  ${verdict === 'ok' ? 'ok      ' : 'FAIL    '}  ${name}(${body})${verdict === 'ok' ? '' : `  <-- ${verdict}: the client sends ${String(sends)} value(s) as ${JSON.stringify(wire)}`}`);
  }
  if (collisions.length > 0) {
    failed = true;
    console.error(`  FAIL: ${collisions.join(', ')} would be refused by $mount`);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('\nOK: no method name is reserved, every SRC signature is valid, and the wires line up');
}
