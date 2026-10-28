/**
 * Integration tests for the dsh-mcp-hub Host half.
 *
 * The plugin is imported with every bare specifier rewritten to a local double,
 * so the whole management surface runs outside DSH against:
 *
 *   - a temporary `$DSH_HOME` (`mcp-hub/servers.json`),
 *   - two in-process MCP servers on ephemeral loopback ports, mirroring
 *     `tools/test-http-server.mjs` (Streamable HTTP) and
 *     `tools/test-sse-server.mjs` (legacy HTTP+SSE),
 *   - `tools/test-stdio-server.mjs` for the stdio transport,
 *   - `tools/stubs/mcp-client.mjs`, a JSON-RPC client double that speaks the
 *     real protocol over those sockets and pipes.
 *
 * Payloads are byte-for-byte the objects `client.js` sends, and the wire key of
 * each Remote method is read back out of `client.js`, so a renamed Host
 * parameter fails here instead of failing on the settings page.
 *
 * No test in this file leaves the machine: every endpoint is 127.0.0.1.
 *
 * Usage: node tools/test-mcp-hub.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { __sdk } from './stubs/mcp-client.mjs';

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let passed = 0;
let failures = 0;
let skipped = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`ok    ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

/**
 * Record a finding the suite cannot fail on: asserting the correct behaviour
 * would need a change to index.js, which is out of scope for a test suite.
 */
function note(text) {
  console.log(`note  ${text}`);
}

/** Report a check that cannot run in this environment without failing the run. */
function skip(what, why) {
  skipped += 1;
  console.log(`skip  ${what} — ${why}`);
}

async function throws(label, operation, expect) {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const matched =
      expect === undefined ? true : expect instanceof RegExp ? expect.test(message) : message.includes(expect);
    check(label, matched, message);
    return message;
  }
  check(label, false, 'did not throw');
  return undefined;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Poll until `predicate` is true; `false` means it never became true. */
async function waitFor(predicate, timeoutMs = 8000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(stepMs);
  }
}

/* ------------------------------------------------------------------ *
 * Scratch home and local MCP fixtures
 * ------------------------------------------------------------------ */

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-hub-test-'));
const HOME = join(scratch, 'home');
process.env.DSH_HOME = HOME;
mkdirSync(HOME, { recursive: true });
const REGISTRY = join(HOME, 'mcp-hub', 'servers.json');
const STDIO_FIXTURE = fileURLToPath(new URL('./test-stdio-server.mjs', import.meta.url));

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(''));
  });
}

/* ---- Streamable HTTP fixture (mirrors tools/test-http-server.mjs) ---- */

const HTTP_TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'slow',
    description: 'Answer after a delay, to exercise long-running calls.',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } }, required: [] },
  },
  {
    name: 'weird/name with spaces',
    description: 'A raw name that has to be normalized before it reaches the model.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: `long-${'y'.repeat(70)}`,
    description: 'A raw name past the 64-character function-name budget.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'multi',
    description: 'Return one block of every content kind.',
    inputSchema: { type: 'object', properties: {} },
  },
  { name: 'empty', description: 'Return no content at all.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'task',
    description: 'A tool that requires task support.',
    execution: { taskSupport: 'required' },
    inputSchema: { type: 'object', properties: {} },
  },
];

const httpFixture = { extra: undefined, requests: [], sessions: 0 };

function httpReply(message, mode) {
  if (message === null || typeof message !== 'object' || message.id === undefined) return undefined;
  const { id, method, params } = message;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: '2025-03-26',
        capabilities: mode === 'notools' ? {} : { tools: { listChanged: false } },
        serverInfo: { name: `hub-test-http-${mode}`, version: '1.0.0' },
        instructions: 'In-process Streamable HTTP fixture for the dsh-mcp-hub suite.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      if (mode === 'dup') return ok({ tools: [HTTP_TOOLS[0], HTTP_TOOLS[0]] });
      if (mode === 'notools') return ok({ tools: [] });
      return ok({ tools: httpFixture.extra === undefined ? HTTP_TOOLS : [...HTTP_TOOLS, httpFixture.extra] });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      switch (name) {
        case 'echo':
          return ok({ content: [{ type: 'text', text: `echo: ${String(args.text)}` }] });
        case 'slow':
          return { delayMs: Number(args.ms ?? 300) };
        case 'multi':
          return ok({
            content: [
              { type: 'text', text: 'line one' },
              { type: 'image', mimeType: 'image/png', data: '' },
              { type: 'resource', resource: { uri: 'file:///tmp/example' } },
              { type: 'audio' },
            ],
          });
        case 'empty':
          return ok({ content: [] });
        default:
          return ok({ content: [{ type: 'text', text: `called ${String(name)}` }] });
      }
    }
    case 'server/discover':
      return ok({
        protocolVersions: ['2025-03-26'],
        serverInfo: { name: `hub-test-http-${mode}`, version: '1.0.0' },
        capabilities: mode === 'notools' ? {} : { tools: {} },
      });
    default:
      return fail(-32601, `method not found: ${String(method)}`);
  }
}

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const mode = url.pathname === '/mcp' ? 'standard' : url.pathname === '/notools' ? 'notools' : url.pathname === '/dup' ? 'dup' : undefined;
  if (mode === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  if (request.method === 'DELETE') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { 'content-type': 'text/plain' });
    response.end('method not allowed');
    return;
  }
  readBody(request)
    .then((body) => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        return;
      }
      httpFixture.requests.push({ mode, headers: request.headers, message });
      const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
      const incoming = request.headers['mcp-session-id'];
      if (typeof incoming === 'string') headers['mcp-session-id'] = incoming;
      else if (message?.method === 'initialize') {
        httpFixture.sessions += 1;
        headers['mcp-session-id'] = `session-${httpFixture.sessions}`;
      }
      const reply = Array.isArray(message)
        ? message.map((entry) => httpReply(entry, mode)).filter(Boolean)
        : httpReply(message, mode);
      if (reply === undefined) {
        response.writeHead(202, headers);
        response.end();
        return;
      }
      if (reply !== null && typeof reply === 'object' && 'delayMs' in reply) {
        const delay = reply.delayMs;
        setTimeout(() => {
          try {
            response.writeHead(200, headers);
            response.end(
              JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `slept ${delay} ms` }] } }),
            );
          } catch {
            /* the caller gave up on the call, which is the expected outcome */
          }
        }, delay);
        return;
      }
      response.writeHead(200, headers);
      response.end(JSON.stringify(reply));
    })
    .catch(() => {
      try {
        response.writeHead(500);
        response.end();
      } catch {
        /* the socket is already gone */
      }
    });
});

/* ---- Legacy HTTP+SSE fixture (mirrors tools/test-sse-server.mjs) ---- */

const SSE_TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: 'Add two integers.',
    inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
  },
  { name: 'empty', description: 'Return no content at all.', inputSchema: { type: 'object', properties: {} } },
];

const sseFixture = { requests: [] };
const sseSessions = new Map();

function sseReply(message) {
  if (message === null || typeof message !== 'object' || message.id === undefined) return undefined;
  const { id, method, params } = message;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hub-test-sse', version: '1.0.0' },
        instructions: 'In-process legacy SSE fixture for the dsh-mcp-hub suite.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: SSE_TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'echo') return ok({ content: [{ type: 'text', text: `echo: ${String(args.text)}` }] });
      if (name === 'add') {
        const sum = Number(args.a) + Number(args.b);
        return ok({ content: [{ type: 'text', text: `${args.a} + ${args.b} = ${sum}` }], structuredContent: { sum } });
      }
      if (name === 'empty') return ok({ content: [] });
      return ok({ content: [{ type: 'text', text: `unknown tool ${String(name)}` }], isError: true });
    }
    /* The SDK probes the modern era first; refusing it keeps the client on the
       legacy handshake this fixture implements, exactly like Burp Suite. */
    case 'server/discover':
      return fail(-32601, 'method not found');
    default:
      return fail(-32601, `method not found: ${String(method)}`);
  }
}

const sseServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/sse') {
    sseFixture.requests.push({ method: 'GET', headers: request.headers });
    const sessionId = randomUUID();
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    response.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
    sseSessions.set(sessionId, response);
    const keepAlive = setInterval(() => {
      try {
        response.write(': keep-alive\n\n');
      } catch {
        /* the stream is gone */
      }
    }, 15_000);
    request.on('close', () => {
      clearInterval(keepAlive);
      sseSessions.delete(sessionId);
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/message') {
    sseFixture.requests.push({ method: 'POST', headers: request.headers });
    readBody(request)
      .then((body) => {
        const stream = sseSessions.get(url.searchParams.get('sessionId') ?? '');
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end('Accepted');
        let message;
        try {
          message = JSON.parse(body);
        } catch {
          return;
        }
        const reply = Array.isArray(message) ? message.map(sseReply).filter(Boolean) : sseReply(message);
        if (stream === undefined || reply === undefined) return;
        for (const entry of Array.isArray(reply) ? reply : [reply]) {
          stream.write(`event: message\ndata: ${JSON.stringify(entry)}\n\n`);
        }
      })
      .catch(() => {});
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

await new Promise((done) => httpServer.listen(0, '127.0.0.1', done));
await new Promise((done) => sseServer.listen(0, '127.0.0.1', done));
const HTTP = `http://127.0.0.1:${String(httpServer.address().port)}`;
const SSE = `http://127.0.0.1:${String(sseServer.address().port)}`;

/** A loopback port nothing is listening on, to exercise refused connections. */
async function closedPort() {
  const probe = createServer(() => {});
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}
const CLOSED = await closedPort();

/**
 * Whether this environment lets a child process be spawned with piped stdio.
 * A Windows file sandbox refuses it, and the suite then skips the end-to-end
 * stdio checks instead of failing on an environment limitation.
 */
async function probeStdio() {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, reason: `${error?.code ?? 'spawn refused'} (synchronous)` });
      return;
    }
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    child.on('error', (error) => done({ ok: false, reason: `${error?.code ?? 'spawn refused'}: ${error?.message ?? String(error)}` }));
    child.on('spawn', () => done({ ok: true }));
    child.on('exit', () => done({ ok: false, reason: 'the probe child exited before it reported a spawn' }));
    setTimeout(() => done({ ok: false, reason: 'the probe child neither spawned nor failed within 5 s' }), 5000).unref?.();
  });
}

const stdioProbe = await probeStdio();

/* ------------------------------------------------------------------ *
 * Load the Host half with doubled specifiers
 * ------------------------------------------------------------------ */

/* Paths are anchored to this file, so the suite runs from any directory. */
const PLUGIN = fileURLToPath(new URL('../index.js', import.meta.url));
const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url));
const generated = join(scratch, 'mcp-hub-host.mjs');
const stub = (name) => new URL(`./stubs/${name}`, import.meta.url).href;
const source = readFileSync(PLUGIN, 'utf8')
  .replace("from '@modelcontextprotocol/client'", `from '${stub('mcp-client.mjs')}'`)
  .replace("from '@modelcontextprotocol/client/stdio'", `from '${stub('mcp-client-stdio.mjs')}'`)
  .replace("from '@deepseek-ai/dsh-home-paths'", `from '${stub('dsh-home-paths.mjs')}'`)
  .replace("from '@deepseek-ai/dsh-mcp-client'", `from '${stub('dsh-mcp-client.mjs')}'`)
  .replace("from '@deepseek-ai/dsh-tools'", `from '${stub('dsh-tools.mjs')}'`)
  .replace("from '@deepseek-ai/dsh-typert-protocol'", `from '${stub('dsh-typert-protocol.mjs')}'`);
check('every bare import specifier was rewritten to a local double', !/from '@(?:deepseek-ai|modelcontextprotocol)\//.test(source));
writeFileSync(generated, source);
const plugin = await import(pathToFileURL(generated).href);

/* ---- A plugin context good enough for the Host half ---- */

const mounted = [];

function mountHub(home) {
  const logs = [];
  const tools = [];
  const effects = [];
  const ctx = {
    logger: {
      info: (line) => logs.push(`info ${String(line)}`),
      warn: (line) => logs.push(`warn ${String(line)}`),
      error: (line) => logs.push(`error ${String(line)}`),
    },
    tools: {
      register(definition) {
        const record = { name: definition?.name, definition, disposed: false };
        tools.push(record);
        return () => {
          record.disposed = true;
        };
      },
    },
    effect(factory, label) {
      const dispose = factory();
      effects.push({ label, dispose });
      return () => {};
    },
  };
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    plugin.apply(ctx);
  } finally {
    process.env.DSH_HOME = previous;
  }
  const record = {
    home,
    ctx,
    logs,
    tools,
    effects,
    hub: ctx.services.mcpHub,
    tool: (name) => tools.find((entry) => entry.name === name && !entry.disposed),
    liveTools: () => tools.filter((entry) => !entry.disposed).map((entry) => entry.name),
    logsText: () => logs.join('\n'),
  };
  mounted.push(record);
  return record;
}

/**
 * Wait for the boot `apply()` already started.
 *
 * `boot()` logs only after it has assigned `this.servers`, so waiting for that
 * line proves the load landed. Calling `boot()` a second time would be simpler
 * but races: a late first load could publish its own (empty) result over a
 * mutation the suite made in between.
 */
async function booted(record) {
  const ready = await waitFor(() => record.logs.some((line) => line.includes('server(s) configured')), 5000);
  if (!ready) note(`the registry at ${record.home} did not report a load within 5 s`);
  return record;
}

async function mountAndBoot(home) {
  return await booted(mountHub(home));
}

async function statusOf(hub, id) {
  const view = await hub.state();
  const row = view.servers.find((entry) => entry.id === id || entry.name === id);
  return row?.status;
}

const registryText = () => readFileSync(REGISTRY, 'utf8');
const registryServers = () => JSON.parse(registryText()).servers;

/* ------------------------------------------------------------------ *
 * 1. Plugin shape and the Remote contract
 * ------------------------------------------------------------------ */

const main = await booted(mountHub(HOME));
const hub = main.hub;
check('apply registers the mcpHub service', hub !== undefined);
check('the plugin name is mcp-hub', plugin.name === 'mcp-hub');
check('the plugin declares the tools dependency', String(plugin.inject) === 'tools');
check('an agent-facing tool is registered', main.tool('mcp_hub')?.definition.name === 'mcp_hub');
check('the plugin registers a disposal effect', main.effects.length === 1 && String(main.effects[0].label).includes('mcp-hub'));
check('registryFile() resolves under $DSH_HOME', plugin.registryFile() === REGISTRY, plugin.registryFile());
check(
  'registryFile() honours an explicit home',
  plugin.registryFile(join(scratch, 'other-home')) === join(scratch, 'other-home', 'mcp-hub', 'servers.json'),
  plugin.registryFile(join(scratch, 'other-home')),
);

const hostSource = readFileSync(PLUGIN, 'utf8');
const REMOTE_METHODS = [...(hostSource.match(/const REMOTE_METHODS = \[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
  (match) => match[1],
);
check('the Remote method list was found', REMOTE_METHODS.length === 12, String(REMOTE_METHODS.length));

const clientSource = readFileSync(CLIENT, 'utf8');
const wires = new Map();
for (const match of clientSource.matchAll(/endpoint\('([A-Za-z]+)'(?:,\s*payload\('([A-Za-z]+)'\))?\)/g)) {
  wires.set(match[1], match[2] === undefined ? [] : ['payload']);
}
check(
  'client.js declares the same Remote methods in the same order',
  [...wires.keys()].join(',') === REMOTE_METHODS.join(','),
  [...wires.keys()].join(','),
);

/* The Typert gateway reads each Remote method's parameter list from
   `Function.prototype.toString`, requires plain unique identifiers, and uses the
   parameter NAME as the wire key the client must send. A default value or
   destructuring there fails at call time with `gateway/signature-invalid`. */
function gatewayParameterNames(fn) {
  const text = Function.prototype.toString.call(fn);
  const open = text.indexOf('(');
  const close = text.indexOf(')', open + 1);
  if (open < 0 || close < 0) return undefined;
  const body = text.slice(open + 1, close).trim();
  if (body.length === 0) return [];
  const names = new Set();
  for (const part of body.split(',').map((entry) => entry.trim())) {
    if (!/^[$A-Z_a-z][$\w]*$/u.test(part) || names.has(part)) return undefined;
    names.add(part);
  }
  return [...names];
}

const signatureFaults = [];
for (const method of REMOTE_METHODS) {
  const names = gatewayParameterNames(hub[method]);
  const expected = wires.get(method);
  if (typeof hub[method] !== 'function') signatureFaults.push(`${method}: not a method`);
  else if (names === undefined) signatureFaults.push(`${method}: rejected by the gateway`);
  else if (expected === undefined) signatureFaults.push(`${method}: missing from client.js`);
  else if (names.join(',') !== expected.join(',')) {
    signatureFaults.push(`${method}: Host takes [${names.join(',')}] but the client sends [${expected.join(',')}]`);
  }
}
check('every Remote method matches the client wire key and the gateway signature rule', signatureFaults.length === 0, signatureFaults.join('; '));

const RESERVED = ['ctx', 'empty', 'invokeRemote', 'methods', 'name', 'namespace', 'has', 'install', 'installDirect', 'installScoped', 'remove'];
check('no Remote method shadows the gateway surface', REMOTE_METHODS.every((method) => !RESERVED.includes(method)));
check('deletion is spelled removeServer', REMOTE_METHODS.includes('removeServer') && !REMOTE_METHODS.includes('remove'));

const MARKER = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const marker = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(hub), MARKER);
check('the prototype carries the Remote marker', marker !== undefined && marker.value?.version === 1);
check(
  'the marker lists every Remote method in declaration order',
  JSON.stringify((marker?.value?.methods ?? []).map((entry) => entry.method)) === JSON.stringify(REMOTE_METHODS),
);
check('the marker marks every method direct', (marker?.value?.methods ?? []).every((entry) => entry.invocation?.kind === 'direct'));

/* ------------------------------------------------------------------ *
 * 2. Config store: first run
 * ------------------------------------------------------------------ */

/* `apply()` already loaded the registry; boot() has to be safe to call again,
   which is what a page reload relies on. Nothing is configured yet, so the
   repeat load cannot race a mutation. */
await hub.boot();
check('the first run does not create a registry file', !existsSync(REGISTRY));
check('a repeated boot() does not change the empty state', (await hub.state()).servers.length === 0);
const emptyState = await hub.state();
check('first-run state lists no server', Array.isArray(emptyState.servers) && emptyState.servers.length === 0);
check('state reports the registry file', emptyState.file === REGISTRY, emptyState.file);
check('state reports the resolved home', emptyState.home === HOME, emptyState.home);
check('state reports exactly the three transports', JSON.stringify(emptyState.transports) === JSON.stringify(['stdio', 'streamable-http', 'sse']));
check('state ships the built-in presets', Array.isArray(emptyState.presets) && emptyState.presets.length === 3);
check(
  'every preset carries an id, a label, a help text and a server record',
  emptyState.presets.every(
    (preset) =>
      typeof preset.id === 'string' &&
      preset.id !== '' &&
      typeof preset.label === 'string' &&
      typeof preset.description === 'string' &&
      typeof preset.server === 'object',
  ),
);
check('lastClientSeen starts at zero', emptyState.lastClientSeen === 0);
check('a healthy registry reports no registry error and no backup', emptyState.registryError === undefined && emptyState.registryBackup === undefined);
check('the state view is JSON-serialisable', JSON.stringify(emptyState).length > 0 && !JSON.stringify(emptyState).includes('undefined'));

/* The presence ping is what lets the agent tool say whether the settings page
   is loaded at all, so it has to be reported before the first heartbeat. */
const coldList = await main.tool('mcp_hub').definition.execute({ action: 'list' });
check('list explains an empty registry', coldList.text.includes('No MCP servers configured'), coldList.text);
check('list reports the registry path', coldList.text.includes(REGISTRY));
check('list reports the settings page as never seen before the first heartbeat', coldList.text.includes('never (settings page not loaded)'));

const beat = await hub.heartbeat();
check('heartbeat answers with a timestamp', typeof beat.at === 'number' && beat.at > 0);
check('heartbeat records presence for state()', (await hub.state()).lastClientSeen === beat.at);
check('a later heartbeat moves the timestamp forward', (await hub.heartbeat()).at >= beat.at);

/* ------------------------------------------------------------------ *
 * 3. Config store: writes, upsert and the atomic publish
 * ------------------------------------------------------------------ */

const transportMark = __sdk.transports.length;
const first = await hub.upsert({
  server: {
    id: 'alpha',
    name: 'alpha',
    transport: 'streamable-http',
    url: `${HTTP}/mcp`,
    description: 'Streamable HTTP fixture.',
    headers: { Authorization: 'Bearer local-token' },
  },
});
check('upsert returns the whole state', Array.isArray(first.servers) && first.servers.length === 1);
check('upsert creates the registry file', existsSync(REGISTRY));
check('the registry document is versioned', JSON.parse(registryText()).version === 1);
check(
  'the registry document is pretty-printed with a trailing newline',
  registryText().endsWith('\n') && registryText().includes('\n  "servers"'),
);
check(
  'upsert wrote the normalized record',
  registryServers()[0].id === 'alpha' && registryServers()[0].transport === 'streamable-http' && registryServers()[0].url === `${HTTP}/mcp`,
);
check(
  'upsert filled every documented default',
  registryServers()[0].enabled === true &&
    registryServers()[0].source === 'manual' &&
    registryServers()[0].toolCallTimeoutMs === 60_000 &&
    registryServers()[0].reconnect.enabled === true &&
    registryServers()[0].reconnect.initialDelayMs === 500 &&
    registryServers()[0].reconnect.maxDelayMs === 30_000 &&
    registryServers()[0].reconnect.maxAttempts === 10 &&
    JSON.stringify(registryServers()[0].args) === '[]',
);
check('upsert kept an object header map intact', registryServers()[0].headers.Authorization === 'Bearer local-token');
check('the atomic publish leaves no temp file behind', readdirSync(join(HOME, 'mcp-hub')).join(',') === 'servers.json', readdirSync(join(HOME, 'mcp-hub')).join(','));
check('upsert built a StreamableHTTPClientTransport', await waitFor(() => __sdk.since('streamable-http', transportMark).length === 1));

/* Overlapping writes used to build the same temp name from Date.now() alone,
   which made persist() reject with ENOENT and could publish a document another
   write was still filling. Writes are serialized now and the temp name carries a
   per-process counter, so a burst has to settle cleanly and leave one file. */
const burstIds = JSON.stringify(registryServers().map((server) => server.id));
const burst = await Promise.allSettled([hub.persist(), hub.persist(), hub.persist(), hub.persist(), hub.persist(), hub.persist()]);
check(
  'a burst of overlapping writes all settle',
  burst.every((entry) => entry.status === 'fulfilled'),
  burst.map((entry) => (entry.status === 'rejected' ? String(entry.reason?.message ?? entry.reason) : '')).filter(Boolean).join('; ') || 'a write rejected',
);
/* Read defensively: a publish that moved a temp file another write was still
   filling would show up here as a broken document, not as a stack trace. */
let burstDocument;
let burstBroken = '';
try {
  burstDocument = JSON.parse(registryText());
} catch (error) {
  burstBroken = error instanceof Error ? error.message : String(error);
}
check(
  'a burst of overlapping writes never truncates the registry',
  burstBroken === '' && JSON.stringify(burstDocument.servers.map((server) => server.id)) === burstIds,
  burstBroken,
);
check('a burst of overlapping writes leaves no temp file behind', readdirSync(join(HOME, 'mcp-hub')).join(',') === 'servers.json', readdirSync(join(HOME, 'mcp-hub')).join(','));

/* `attempt()` publishes `state === 'connected'` before it awaits `sync()`, so
   every assertion about a server's tools waits for the tools themselves. */
check('the http server answered the background connect', await waitFor(async () => (await statusOf(hub, 'alpha'))?.state === 'connected'));
check('the connected server lists the tools it announced', await waitFor(async () => (await statusOf(hub, 'alpha'))?.toolCount === HTTP_TOOLS.length), String((await statusOf(hub, 'alpha'))?.toolCount));
const alphaStatus = await statusOf(hub, 'alpha');
check('the connected server reports its identity and protocol', alphaStatus.serverInfo?.name === 'hub-test-http-standard' && alphaStatus.protocolVersion === '2025-03-26', JSON.stringify(alphaStatus));
check('the connected server reports its instructions', typeof alphaStatus.instructions === 'string' && /in-process/i.test(alphaStatus.instructions), JSON.stringify(alphaStatus.instructions));
check('the connected server reports a connection timestamp', typeof alphaStatus.connectedAt === 'number');
check('the connected server reports its tool count', alphaStatus.toolCount === HTTP_TOOLS.length, String(alphaStatus.toolCount));
check('the connection reached the fixture before the probe did anything else', httpFixture.sessions >= 1);
const alphaInitialize = httpFixture.requests.find((entry) => entry.mode === 'standard' && entry.message?.method === 'initialize');
check('the fixture saw the configured headers', alphaInitialize?.headers?.authorization === 'Bearer local-token');
check('the fixture saw a JSON-RPC initialize', alphaInitialize?.message?.params?.clientInfo?.name === 'dsh-mcp-hub');

/* The bridged tools carry the documented naming contract and the harness
   definition the shipped bridge would have produced. */
const alphaNames = alphaStatus.tools.map((tool) => tool.publicName);
check('tools are bridged as mcp__<server>__<tool>', alphaNames.includes('mcp__alpha__echo'), alphaNames.join(', '));
check('the status rows keep the raw tool name beside the public one', alphaStatus.tools.find((tool) => tool.publicName === 'mcp__alpha__echo')?.name === 'echo');
check('every public name fits the function-name grammar and length budget', alphaNames.every((name) => /^[A-Za-z0-9_-]+$/.test(name) && name.length <= 64), JSON.stringify(alphaNames.filter((name) => !/^[A-Za-z0-9_-]+$/.test(name) || name.length > 64)));
const weirdPublic = alphaNames.find((name) => name.startsWith('mcp__alpha__weird'));
check('a lossy public name is hashed instead of silently truncated', /^mcp__alpha__weird_name_with_spaces_[0-9a-f]{12}$/.test(weirdPublic ?? ''), String(weirdPublic));
const longPublic = alphaNames.find((name) => name.includes('long-y'));
check('an over-long public name is hashed instead of silently truncated', /^mcp__alpha__long-y+_[0-9a-f]{12}$/.test(longPublic ?? '') && longPublic.length === 64, String(longPublic));
check('the public names of one server are unique', new Set(alphaNames).size === alphaNames.length);
check('the bridged tools are registered on the tool registry', main.liveTools().includes('mcp__alpha__echo'));
const bridged = main.tool('mcp__alpha__echo');
check('the bridged definition keeps the raw name and the input schema', bridged?.definition.rawName === 'echo' && bridged?.definition.parameters?.properties?.text !== undefined);
check('a task-requiring tool is flagged for the bridge', main.tool('mcp__alpha__task')?.definition.taskRequired === true);
const bridgedCall = await bridged.definition.call({ text: 'through the bridge' }, {});
check('a bridged tool reaches the MCP server', bridgedCall?.content?.[0]?.text === 'echo: through the bridge', JSON.stringify(bridgedCall));

/* A `list_changed` notification has to refresh the registered generation. */
const alphaClient = hub.runtimes.get('alpha')?.client;
check('the runtime exposes the live client to the plugin', alphaClient !== undefined);
httpFixture.extra = { name: 'latecomer', description: 'Announced after the first listing.', inputSchema: { type: 'object', properties: {} } };
alphaClient.options.listChanged.tools.onChanged();
check('tools/list_changed re-syncs the registry', await waitFor(async () => main.liveTools().includes('mcp__alpha__latecomer')));
httpFixture.extra = undefined;
alphaClient.options.listChanged.tools.onChanged();
check('a second re-sync drops a tool the server no longer lists', await waitFor(async () => !main.liveTools().includes('mcp__alpha__latecomer')));

const updated = await hub.upsert({
  server: {
    id: 'alpha',
    name: 'alpha',
    transport: 'streamable-http',
    url: `${HTTP}/mcp`,
    description: 'Updated description.',
    headers: { Authorization: 'Bearer local-token' },
  },
});
check(
  'upsert updates an existing id in place',
  updated.servers.filter((server) => server.id === 'alpha').length === 1 &&
    updated.servers.find((server) => server.id === 'alpha').description === 'Updated description.',
);
await throws('upsert refuses a name already used by another id', () => hub.upsert({ server: { id: 'alpha-two', name: 'alpha', transport: 'sse', url: `${SSE}/sse` } }), 'already used by');
await throws('upsert requires a server object', () => hub.upsert({}), 'upsert requires a server object');
await throws('upsert rejects a non-record payload', () => hub.upsert({ server: 'nope' }), 'upsert requires a server object');
await throws('upsert rejects an array payload as a command-less stdio server', () => hub.upsert({ server: [] }), 'stdio transport requires a command');
note('normalizeServer\'s "could not be normalized" guard is unreachable through upsert: it spreads the payload into a fresh object first, so an array arrives as `{}` and is refused as a command-less stdio server instead.');
await throws('upsert rejects stdio without a command', () => hub.upsert({ server: { name: 'no-command', transport: 'stdio' } }), 'stdio transport requires a command');
await throws('upsert rejects streamable-http without a url', () => hub.upsert({ server: { name: 'no-url', transport: 'streamable-http' } }), 'streamable-http transport requires a url');
await throws('upsert rejects sse without a url', () => hub.upsert({ server: { name: 'no-url-sse', transport: 'sse' } }), 'sse transport requires a url');
check('a refused upsert writes nothing', (await hub.state()).servers.length === 1, String((await hub.state()).servers.length));

/* Regression: normalizeServer used the object-only stringMap, so the JSON text
   the settings editor sends for `headers`/`env` was stored as an empty map —
   "Test connection" honoured the headers and saving the record threw them away.
   upsert() now coerces the text (coerceMap) before it persists anything. */
const textMaps = await hub.upsert({
  server: {
    id: 'text-maps',
    name: 'text-maps',
    transport: 'sse',
    url: `${SSE}/sse`,
    enabled: false,
    headers: '{\n  "Authorization": "Bearer from-the-editor",\n  "X-Trace": 7\n}',
    env: '{"MCP_HUB_TEST_FLAG":"from-text","N":2}',
  },
});
const storedTextMaps = registryServers().find((server) => server.id === 'text-maps');
check(
  'upsert persists a header map that arrived as JSON text',
  storedTextMaps.headers.Authorization === 'Bearer from-the-editor' && Object.keys(storedTextMaps.headers).length === 2,
  JSON.stringify(storedTextMaps.headers),
);
check('upsert stringifies non-string values inside a JSON-text header map', storedTextMaps.headers['X-Trace'] === '7', JSON.stringify(storedTextMaps.headers));
check(
  'upsert persists an env map that arrived as JSON text',
  storedTextMaps.env.MCP_HUB_TEST_FLAG === 'from-text' && storedTextMaps.env.N === '2',
  JSON.stringify(storedTextMaps.env),
);
const textMapsView = textMaps.servers.find((server) => server.id === 'text-maps');
check('the coerced maps reach the state view unchanged', textMapsView.headers['X-Trace'] === '7' && textMapsView.env.N === '2', JSON.stringify({ headers: textMapsView.headers, env: textMapsView.env }));
check('a JSON-text map does not disturb the rest of the record', storedTextMaps.transport === 'sse' && storedTextMaps.enabled === false && storedTextMaps.url === `${SSE}/sse`);
const blankMaps = await hub.upsert({
  server: { id: 'blank-maps', name: 'blank-maps', transport: 'streamable-http', url: `${HTTP}/notools`, enabled: false, headers: '   ', env: '{}' },
});
check(
  'a blank or empty JSON-text map is stored as an empty map',
  JSON.stringify(blankMaps.servers.find((server) => server.id === 'blank-maps').headers) === '{}' &&
    JSON.stringify(blankMaps.servers.find((server) => server.id === 'blank-maps').env) === '{}',
  JSON.stringify(blankMaps.servers.find((server) => server.id === 'blank-maps').headers),
);

const beforeBadMaps = registryText();
await throws('upsert reports a malformed header text', () => hub.upsert({ server: { name: 'bad-headers', transport: 'sse', url: `${SSE}/sse`, headers: 'not json' } }), 'headers must be a JSON object');
await throws('upsert reports a malformed env text', () => hub.upsert({ server: { name: 'bad-env', transport: 'stdio', command: 'node', env: '{oops' } }), 'env must be a JSON object');
await throws('upsert rejects an array header map', () => hub.upsert({ server: { name: 'array-headers', transport: 'sse', url: `${SSE}/sse`, headers: ['x'] } }), 'headers must be a JSON object');
await throws('upsert rejects a numeric env map', () => hub.upsert({ server: { name: 'number-env', transport: 'stdio', command: 'node', env: 7 } }), 'env must be a JSON object');
check('a rejected header/env map changes nothing on disk', registryText() === beforeBadMaps);
check('a rejected header/env map adds no server', !registryServers().some((server) => ['bad-headers', 'bad-env', 'array-headers', 'number-env'].includes(server.id)));
check('a rejected header/env map registers no runtime', ![...hub.runtimes.keys()].some((id) => id.startsWith('bad-') || id.startsWith('array-') || id.startsWith('number-')));

/* Overlapping Remote mutations used to collide on one temp name as well. */
const mutationBurst = await Promise.allSettled([
  hub.upsert({ server: { id: 'burst-a', name: 'burst-a', transport: 'streamable-http', url: `${HTTP}/notools`, enabled: false } }),
  hub.upsert({ server: { id: 'burst-b', name: 'burst-b', transport: 'sse', url: `${SSE}/sse`, enabled: false } }),
  hub.toggle({ id: 'text-maps', enabled: false }),
  hub.persist(),
]);
check(
  'overlapping Remote mutations all settle',
  mutationBurst.every((entry) => entry.status === 'fulfilled'),
  mutationBurst.map((entry) => (entry.status === 'rejected' ? String(entry.reason?.message ?? entry.reason) : '')).filter(Boolean).join('; ') || 'a mutation failed',
);
check('overlapping Remote mutations leave no temp file behind', readdirSync(join(HOME, 'mcp-hub')).join(',') === 'servers.json', readdirSync(join(HOME, 'mcp-hub')).join(','));
check(
  'overlapping Remote mutations publish every record',
  ['text-maps', 'blank-maps', 'burst-a', 'burst-b'].every((id) => registryServers().some((server) => server.id === id)),
  registryServers().map((server) => server.id).join(','),
);
check('the document a mutation burst left behind is complete', JSON.parse(registryText()).servers.length === (await hub.state()).servers.length);

/* ------------------------------------------------------------------ *
 * 4. stdio configuration, command assembly and the scrubbed child env
 * ------------------------------------------------------------------ */

process.env.MCP_HUB_TEST_SECRET = 'should-not-reach-a-child';
process.env.MCP_HUB_TEST_KEYSTONE = 'dropped-because-the-name-contains-key';
const stdioMark = __sdk.transports.length;
await hub.upsert({
  server: { id: 'env-scrub', name: 'env-scrub', transport: 'stdio', command: process.execPath, args: '--version', reconnect: { enabled: false } },
});
check('a stdio record builds a StdioClientTransport', await waitFor(() => __sdk.since('stdio', stdioMark).length === 1));
const scrubTransport = __sdk.since('stdio', stdioMark)[0];
check('a stdio child env drops the parent DSH_* state', !Object.keys(scrubTransport.env).some((key) => key.startsWith('DSH_')));
check('a stdio child env drops credential-shaped parent names', scrubTransport.env.MCP_HUB_TEST_SECRET === undefined);
const pathKey = Object.keys(scrubTransport.env).find((key) => key.toUpperCase() === 'PATH');
check('a stdio child env keeps ordinary parent names', typeof pathKey === 'string' && scrubTransport.env[pathKey] !== '');
check('a stdio child env drops any parent name merely containing KEY', scrubTransport.env.MCP_HUB_TEST_KEYSTONE === undefined);
note('the parent-env scrub is the substring pattern /KEY|PASSWORD|SECRET|TOKEN/i, so unrelated names such as TOKENIZERS_PARALLELISM or MONKEY are dropped from a stdio child.');
check('the stdio transport received the configured command', scrubTransport.command === process.execPath, String(scrubTransport.command));
await hub.removeServer({ id: 'env-scrub' });

const explicitMark = __sdk.transports.length;
await hub.upsert({
  server: {
    id: 'env-explicit',
    name: 'env-explicit',
    transport: 'stdio',
    command: process.execPath,
    args: ['--version'],
    env: { MCP_HUB_TEST_SECRET: 'explicit-wins' },
    reconnect: { enabled: false },
  },
});
check('a stdio record with an array of args keeps it', await waitFor(() => __sdk.since('stdio', explicitMark).length === 1));
check(
  'an explicitly configured env value is passed through untouched',
  __sdk.since('stdio', explicitMark)[0].env.MCP_HUB_TEST_SECRET === 'explicit-wins',
);
check('an omitted cwd is not passed to the child', __sdk.since('stdio', explicitMark)[0].cwd === undefined);
check('an object env map is persisted as given', registryServers().find((server) => server.id === 'env-explicit').env.MCP_HUB_TEST_SECRET === 'explicit-wins', JSON.stringify(registryServers().find((server) => server.id === 'env-explicit').env));
await hub.removeServer({ id: 'env-explicit' });
delete process.env.MCP_HUB_TEST_SECRET;
delete process.env.MCP_HUB_TEST_KEYSTONE;

await hub.upsert({
  server: {
    id: 'cwd-holder',
    name: 'cwd-holder',
    transport: 'stdio',
    command: 'node',
    args: ['--version'],
    cwd: scratch,
    enabled: false,
    env: { CWD_FLAG: 'kept' },
    headers: { 'x-stdio': 'kept-in-the-registry' },
  },
});
check('a stdio record with a cwd does not connect while disabled', hub.runtimes.has('cwd-holder') === false);
check(
  'a disabled stdio record keeps its env and header maps in the registry',
  registryServers().find((server) => server.id === 'cwd-holder').env.CWD_FLAG === 'kept' &&
    registryServers().find((server) => server.id === 'cwd-holder').headers['x-stdio'] === 'kept-in-the-registry',
);

/* ------------------------------------------------------------------ *
 * 5. Transports: streamable-http, sse and stdio
 * ------------------------------------------------------------------ */

/* ---- legacy HTTP+SSE ---- */
const sseMark = __sdk.transports.length;
await hub.upsert({ server: { id: 'beta', name: 'beta', transport: 'sse', url: `${SSE}/sse`, headers: { 'x-sse-token': 'local' } } });
check('an sse record builds a SSEClientTransport', await waitFor(() => __sdk.since('sse', sseMark).length === 1));
check(
  'the sse transport received the endpoint and its headers',
  __sdk.since('sse', sseMark)[0]?.url === `${SSE}/sse` && __sdk.since('sse', sseMark)[0]?.headers['x-sse-token'] === 'local',
);
check('the sse server connected', await waitFor(async () => (await statusOf(hub, 'beta'))?.state === 'connected'));
check('the sse connection bridged every announced tool', await waitFor(async () => ((await statusOf(hub, 'beta'))?.tools ?? []).length === SSE_TOOLS.length));
check(
  'every documented transport has built its own transport class',
  ['stdio', 'streamable-http', 'sse'].every((kind) => __sdk.transports.some((entry) => entry.kind === kind)),
  __sdk.transports.map((entry) => entry.kind).join(','),
);
const betaStatus = await statusOf(hub, 'beta');
check('the sse connection negotiated the legacy protocol era', betaStatus.protocolVersion === '2024-11-05', JSON.stringify(betaStatus.protocolVersion));
check('the sse connection lists the fixture tools', betaStatus.tools.map((tool) => tool.name).sort().join(',') === 'add,echo,empty');
check('the sse handshake carried the configured headers', sseFixture.requests.some((entry) => entry.method === 'GET' && entry.headers['x-sse-token'] === 'local'));
check('the sse message POST carried the configured headers', sseFixture.requests.some((entry) => entry.method === 'POST' && entry.headers['x-sse-token'] === 'local'));

/* ---- stdio, end to end ---- */
const stdioFixtureMark = __sdk.transports.length;
await hub.upsert({
  server: {
    id: 'delta',
    name: 'delta',
    transport: 'stdio',
    command: process.execPath,
    args: `"${STDIO_FIXTURE}"`,
    cwd: scratch,
    reconnect: { enabled: false },
  },
});
const deltaRow = (await hub.state()).servers.find((server) => server.id === 'delta');
check('a stdio args string is split into an argument list', JSON.stringify(deltaRow.args) === JSON.stringify([STDIO_FIXTURE]), JSON.stringify(deltaRow.args));
check('a stdio record keeps the command and cwd', deltaRow.command === process.execPath && deltaRow.cwd === scratch);
const deltaTransport = await waitFor(() => __sdk.since('stdio', stdioFixtureMark).length === 1)
  ? __sdk.since('stdio', stdioFixtureMark)[0]
  : undefined;
check('the stdio fixture record built a Standard IO transport', deltaTransport !== undefined);
check('the stdio transport received the split arguments', JSON.stringify(deltaTransport?.args) === JSON.stringify([STDIO_FIXTURE]), JSON.stringify(deltaTransport?.args));

if (stdioProbe.ok) {
  check('the stdio server connected', await waitFor(async () => (await statusOf(hub, 'delta'))?.state === 'connected', 10_000));
  check('the stdio server bridged its tool', await waitFor(async () => ((await statusOf(hub, 'delta'))?.tools ?? []).some((tool) => tool.publicName === 'mcp__delta__echo')));
  const stdioCall = await hub.invoke({ id: 'delta', tool: 'echo', args: '{"text":"over stdio"}' });
  check('a stdio tool call answers over the pipes', stdioCall.ok === true && stdioCall.text === 'echo: over stdio', JSON.stringify(stdioCall));
  const stdioReport = await hub.test({ server: { name: 'stdio-probe', transport: 'stdio', command: process.execPath, args: `"${STDIO_FIXTURE}"`, cwd: scratch } });
  check('test drives the stdio transport end to end', stdioReport.ok === true && stdioReport.tools.some((tool) => tool.name === 'echo'), JSON.stringify(stdioReport.error));
  const child = __sdk.transports.find((entry) => entry.kind === 'stdio' && entry.args?.includes(STDIO_FIXTURE))?.transport.child;
  check('the stdio server is a real child process', child !== undefined);
  await hub.removeServer({ id: 'delta' });
  check('removing a stdio server stops its child', child === undefined || child.killed === true || child.exitCode !== null);
} else {
  skip('stdio transport end to end (connect, tools/list, tools/call, child shutdown)', stdioProbe.reason);
  note('this sandbox refuses a piped child_process.spawn, so stdio coverage stops at configuration assembly and the recorded StdioClientTransport options.');
  await hub.removeServer({ id: 'delta' });
}

/* ---- refused connections ---- */
await hub.upsert({
  server: { id: 'gamma', name: 'gamma', transport: 'streamable-http', url: `http://127.0.0.1:${String(CLOSED)}/mcp`, reconnect: { enabled: false } },
});
check('an unreachable server ends up in an error state, not a throw', await waitFor(async () => (await statusOf(hub, 'gamma'))?.state === 'error'));
const gammaError = (await statusOf(hub, 'gamma'))?.error ?? '';
check('the refused connection is recorded as error text', /ECONNREFUSED|refused|connect/i.test(gammaError), gammaError);
check('the failing record stays in the registry', (await hub.state()).servers.some((server) => server.id === 'gamma'));
const closedProbe = await hub.test({ server: { name: 'probe-closed', transport: 'sse', url: `http://127.0.0.1:${String(CLOSED)}/sse` } });
check('a refused sse probe answers with a verdict instead of throwing', closedProbe.ok === false && /ECONNREFUSED|refused|connect/i.test(String(closedProbe.error)), JSON.stringify(closedProbe));

/* ---- a server that lists one tool twice ---- */
await hub.upsert({
  server: { id: 'duplicated', name: 'duplicated', transport: 'streamable-http', url: `${HTTP}/dup`, reconnect: { enabled: false } },
});
check('a server listing one tool twice ends in an error state', await waitFor(async () => (await statusOf(hub, 'duplicated'))?.state === 'error'));
check('the duplication is explained', /listed tool "echo" twice/.test((await statusOf(hub, 'duplicated'))?.error ?? ''), (await statusOf(hub, 'duplicated'))?.error);
check('a failed sync registers no tool at all', !main.liveTools().some((name) => name.startsWith('mcp__duplicated__')));
await hub.removeServer({ id: 'duplicated' });

/* ---- a server without the tools capability ---- */
const nothingClientMark = __sdk.clients.length;
await hub.upsert({ server: { id: 'nothing', name: 'nothing', transport: 'streamable-http', url: `${HTTP}/notools` } });
check('a server without the tools capability still connects', await waitFor(async () => (await statusOf(hub, 'nothing'))?.state === 'connected'));
check('a server without the tools capability reports no tool', (await statusOf(hub, 'nothing'))?.toolCount === 0);
const nothingClient = __sdk.clients.slice(nothingClientMark)[0];

/* ------------------------------------------------------------------ *
 * 6. toggle, reload, removeServer and clearErrors
 * ------------------------------------------------------------------ */

const disabledState = await hub.toggle({ id: 'alpha', enabled: false });
check('toggle disables without deleting the record', disabledState.servers.some((server) => server.id === 'alpha') && disabledState.servers.find((server) => server.id === 'alpha').enabled === false);
check('a disabled server reports a disabled status', disabledState.servers.find((server) => server.id === 'alpha').status.state === 'disabled');
check('a disabled server unregisters its tools', !main.liveTools().some((name) => name.startsWith('mcp__alpha__')));
check('disable persists', registryServers().find((server) => server.id === 'alpha').enabled === false);
await throws('toggle rejects an unknown id', () => hub.toggle({ id: 'ghost', enabled: true }), 'unknown MCP server id');
await throws('toggle rejects a missing id', () => hub.toggle({ enabled: true }), 'unknown MCP server id');

await hub.toggle({ id: 'alpha', enabled: true });
check('re-enabling reconnects', await waitFor(async () => (await statusOf(hub, 'alpha'))?.state === 'connected'));
check('re-enabling re-registers the tools', await waitFor(() => main.liveTools().includes('mcp__alpha__echo')));
const stringEnabled = await hub.toggle({ id: 'alpha', enabled: 'true' });
check('toggle only honours a real boolean', stringEnabled.servers.find((server) => server.id === 'alpha').enabled === false);
await hub.toggle({ id: 'alpha', enabled: true });
await waitFor(async () => (await statusOf(hub, 'alpha'))?.state === 'connected');

const clientsBeforeReload = __sdk.clients.length;
const reloaded = await hub.reload({ id: 'alpha' });
check('reload keeps the record', reloaded.servers.some((server) => server.id === 'alpha'));
check('reload opens a fresh connection', await waitFor(() => __sdk.clients.length > clientsBeforeReload));
check('reload reconnects the server', await waitFor(async () => (await statusOf(hub, 'alpha'))?.state === 'connected'));
await throws('reload rejects an unknown id', () => hub.reload({ id: 'ghost' }), 'unknown MCP server id');
await hub.toggle({ id: 'alpha', enabled: false });
const disabledReload = await hub.reload({ id: 'alpha' });
check('reloading a disabled server does not connect it', disabledReload.servers.find((server) => server.id === 'alpha').status.state === 'disabled');
await hub.toggle({ id: 'alpha', enabled: true });
await waitFor(async () => (await statusOf(hub, 'alpha'))?.state === 'connected');

const cleared = await hub.clearErrors();
check('clearErrors drops the stored error text', !('error' in cleared.servers.find((server) => server.id === 'gamma').status));
check('clearErrors returns a failed server to idle', cleared.servers.find((server) => server.id === 'gamma').status.state === 'idle', cleared.servers.find((server) => server.id === 'gamma').status.state);
check('clearErrors leaves no error detail behind', cleared.servers.find((server) => server.id === 'gamma').status.error === undefined);
check('clearErrors keeps every server', cleared.servers.length === (await hub.state()).servers.length);
check('clearErrors does not disturb a healthy server', cleared.servers.find((server) => server.id === 'alpha').status.state === 'connected');
check('clearErrors does not wake a disabled server', cleared.servers.find((server) => server.id === 'cwd-holder').status.state === 'disabled');
check('clearErrors keeps the bridge of a healthy server', main.liveTools().includes('mcp__alpha__echo'));

const doomedRemoval = await hub.removeServer({ id: 'nothing' });
check('removeServer drops the record', !doomedRemoval.servers.some((server) => server.id === 'nothing'));
check('removeServer persists the removal', !registryServers().some((server) => server.id === 'nothing'));
check('removeServer closed the connection it owned', nothingClient?.closed === true);
await throws('removeServer rejects an unknown id', () => hub.removeServer({ id: 'ghost' }), 'unknown MCP server id');
await throws('removeServer rejects a missing id', () => hub.removeServer({}), 'unknown MCP server id');

/* ------------------------------------------------------------------ *
 * 7. Remote `test` and `invoke`
 * ------------------------------------------------------------------ */

const probeMark = __sdk.transports.length;
const report = await hub.test({ server: { name: 'probe', transport: 'streamable-http', url: `${HTTP}/mcp` } });
check('test connects without saving a record', report.ok === true && !(await hub.state()).servers.some((server) => server.name === 'probe'));
check('test built the StreamableHTTPClientTransport', __sdk.since('streamable-http', probeMark).length === 1);
check('test reports the identity and protocol version', report.serverInfo?.name === 'hub-test-http-standard' && report.protocolVersion === '2025-03-26', JSON.stringify(report));
check('test reports the server capabilities', Array.isArray(report.capabilities) && report.capabilities.includes('tools'));
check('test lists the tools under the public naming contract', report.tools.length === HTTP_TOOLS.length && report.tools.some((tool) => tool.publicName === 'mcp__probe__echo'));
check('test names a lossy tool with the same shape the runtime would', /^mcp__probe__weird_name_with_spaces_[0-9a-f]{12}$/.test(report.tools.find((tool) => tool.name.startsWith('weird'))?.publicName ?? ''));
const repeatedProbe = await hub.test({ server: { name: 'probe', transport: 'streamable-http', url: `${HTTP}/mcp` } });
check('a repeated probe derives the same public names', JSON.stringify(repeatedProbe.tools.map((tool) => tool.publicName)) === JSON.stringify(report.tools.map((tool) => tool.publicName)));
check('test measures the round trip', typeof report.elapsedMs === 'number' && report.elapsedMs >= 0);
check('test did not write the registry', !registryServers().some((server) => server.name === 'probe'));

const sseProbeMark = __sdk.transports.length;
const sseReport = await hub.test({ server: { name: 'probe-sse', transport: 'sse', url: `${SSE}/sse` } });
check('test drives the SSE transport', sseReport.ok === true && __sdk.since('sse', sseProbeMark).length === 1);
check('the sse probe negotiated the legacy era', sseReport.protocolVersion === '2024-11-05', JSON.stringify(sseReport.protocolVersion));
check('the sse probe lists the fixture tools', sseReport.tools.some((tool) => tool.name === 'add' && tool.publicName === 'mcp__probe-sse__add'));

const storedProbe = await hub.test({ server: { id: 'alpha' } });
check('test merges the stored record when only an id is given', storedProbe.ok === true && storedProbe.serverInfo?.name === 'hub-test-http-standard', JSON.stringify(storedProbe));
const overriddenProbe = await hub.test({ server: { id: 'alpha', url: `http://127.0.0.1:${String(CLOSED)}/mcp` } });
check('a draft url wins over the stored record', overriddenProbe.ok === false && typeof overriddenProbe.error === 'string', JSON.stringify(overriddenProbe));
await throws('test requires a server object', () => hub.test({}), 'test requires a server object');
const badTransport = await hub.test({ server: { name: 'x', transport: 'carrier-pigeon', url: `${HTTP}/mcp` } });
check('an unsupported draft transport is a verdict, not a throw', badTransport.ok === false && String(badTransport.error).includes('unsupported transport'), JSON.stringify(badTransport));
const badHeaders = await hub.test({ server: { name: 'x', transport: 'streamable-http', url: `${HTTP}/mcp`, headers: 'not json' } });
check('malformed header JSON is a verdict, not a throw', badHeaders.ok === false && String(badHeaders.error).includes('headers must be a JSON object'), JSON.stringify(badHeaders));
const stringHeaders = await hub.test({ server: { name: 'x', transport: 'streamable-http', url: `${HTTP}/mcp`, headers: '{"X-From-String":"1"}' } });
check('a JSON-text header map is parsed for a probe', stringHeaders.ok === true && httpFixture.requests.some((entry) => entry.headers['x-from-string'] === '1'));

const invokedText = await hub.invoke({ id: 'alpha', tool: 'echo', args: '{"text":"hello invoke"}' });
check('invoke accepts the JSON-text payload the page sends', invokedText.ok === true && invokedText.text === 'echo: hello invoke', JSON.stringify(invokedText));
check('invoke reports its own timing', typeof invokedText.elapsedMs === 'number');
const invokedObject = await hub.invoke({ id: 'beta', tool: 'echo', args: { text: 'object args' } });
check('invoke accepts an object argument payload', invokedObject.ok === true && invokedObject.text === 'echo: object args');
const summed = await hub.invoke({ id: 'beta', tool: 'add', args: '{"a":2,"b":40}' });
check('invoke projects structured content', summed.structuredContent?.sum === 42, JSON.stringify(summed));
const multi = await hub.invoke({ id: 'alpha', tool: 'multi', args: {} });
check(
  'invoke projects every content block kind',
  multi.text === 'line one\n[image image/png]\n[resource file:///tmp/example]\n[audio]',
  JSON.stringify(multi.text),
);
check('an empty result is labelled', (await hub.invoke({ id: 'alpha', tool: 'empty', args: {} })).text === '(empty result)');
const serverError = await hub.invoke({ id: 'beta', tool: 'nope', args: {} });
check('a server-declared tool error is surfaced as a result', serverError.ok === false && serverError.isError === true && serverError.text.includes('unknown tool'), JSON.stringify(serverError));
await throws('invoke requires a tool name', () => hub.invoke({ id: 'alpha' }), 'invoke requires a tool name');
await throws('invoke rejects malformed argument JSON', () => hub.invoke({ id: 'alpha', tool: 'echo', args: '{oops' }), 'arguments must be valid JSON');
await throws('invoke rejects a non-object argument payload', () => hub.invoke({ id: 'alpha', tool: 'echo', args: '[1,2]' }), 'arguments must be a JSON object');
await throws('invoke refuses a server that is not connected', () => hub.invoke({ id: 'gamma', tool: 'echo' }), 'is not connected');
await throws('invoke refuses an unknown id', () => hub.invoke({ id: 'ghost', tool: 'echo' }), 'is not connected');

await hub.upsert({ server: { id: 'slowpoke', name: 'slowpoke', transport: 'streamable-http', url: `${HTTP}/mcp`, toolCallTimeoutMs: 150 } });
check('a per-server tool timeout is stored as given', (await hub.state()).servers.find((server) => server.id === 'slowpoke').toolCallTimeoutMs === 150);
check('the timeout server connected', await waitFor(async () => (await statusOf(hub, 'slowpoke'))?.state === 'connected'));
await throws('a slow tool call is cut off at the configured timeout', () => hub.invoke({ id: 'slowpoke', tool: 'slow', args: '{"ms":600}' }), /aborted|timed out/);
check('the runtime survives a timed-out call', (await statusOf(hub, 'slowpoke'))?.state === 'connected');

/* ------------------------------------------------------------------ *
 * 8. The agent-facing `mcp_hub` tool
 * ------------------------------------------------------------------ */

const tool = main.tool('mcp_hub').definition;
const callTool = (args) => tool.execute(args);
check('the tool advertises every action in an enum', Array.isArray(tool.parameters?.action?.enum) && tool.parameters.action.enum.length === 9 && tool.parameters.action.required === true);
check('the tool declares its output as a text field', tool.output?.schema?.properties?.text !== undefined);
check('the tool renders its result as text', JSON.stringify(tool.output.render({ action: 'list' }, { text: 'x' })).includes('x'));

/* clearErrors only blanked the message; a reload has to re-record it, because
   that failure line is exactly what the agent tool has to show. */
await hub.reload({ id: 'gamma' });
check('reloading a failing server re-records its error', await waitFor(async () => typeof (await statusOf(hub, 'gamma'))?.error === 'string'));

const listText = await callTool({ action: 'list' });
check('list names every configured server with its transport', listText.text.includes('- alpha [streamable-http]') && listText.text.includes('- beta [sse]'), listText.text);
check('list shows the live state and the tool count', /- alpha \[streamable-http\] connected — .*\(7 tools\)/.test(listText.text), listText.text);
check('list shows a refused connection with its error', listText.text.includes('- gamma [streamable-http] error') && listText.text.includes('error:'), listText.text);
check('list reports the settings page as recently seen', /Settings page last seen: \d+s ago\./.test(listText.text), listText.text);
check('tools lists a connected server with raw and public names', (await callTool({ action: 'tools', id: 'alpha' })).text.includes('- mcp__alpha__echo (raw: echo) — '));
check('tools resolves a server by name as well as by id', (await callTool({ action: 'tools', id: 'beta' })).text.includes('mcp__beta__add (raw: add)'));
await throws('tools needs an id', () => callTool({ action: 'tools' }), '`id` is required');
await throws('tools rejects an unknown server', () => callTool({ action: 'tools', id: 'ghost' }), 'unknown MCP server');
await throws('tools refuses a server that is not connected', () => callTool({ action: 'tools', id: 'gamma' }), 'is not connected');

const draftTest = await callTool({ action: 'test', name: 'draft-http', transport: 'streamable-http', url: `${HTTP}/mcp` });
check('test probes an unsaved draft through the tool', draftTest.text.includes('Connected in') && draftTest.text.includes(`${String(HTTP_TOOLS.length)} tool(s)`), draftTest.text);
check('a draft probe is not saved by the tool', !(await hub.state()).servers.some((server) => server.name === 'draft-http'));
const failedTest = await callTool({ action: 'test', name: 'draft-bad', transport: 'streamable-http', url: `http://127.0.0.1:${String(CLOSED)}/mcp` });
check('the tool reports a failed probe instead of throwing', failedTest.text.includes('Connection failed after'), failedTest.text);
const callText = await callTool({ action: 'call', id: 'alpha', tool: 'echo', toolArgs: '{"text":"via the tool"}' });
check('call invokes a tool through the registry', callText.text === 'echo: via the tool', callText.text);
await throws('call needs a tool name', () => callTool({ action: 'call', id: 'alpha' }), '`tool` is required');
await throws('call surfaces bad argument JSON', () => callTool({ action: 'call', id: 'alpha', tool: 'echo', toolArgs: '{' }), 'arguments must be valid JSON');
await throws('call refuses an unknown server', () => callTool({ action: 'call', id: 'ghost', tool: 'echo' }), 'unknown MCP server');

const addText = await callTool({ action: 'add', name: 'added-by-tool', transport: 'streamable-http', url: `${HTTP}/notools` });
check('add saves a server record', addText.text.includes('added-by-tool') && (await hub.state()).servers.some((server) => server.name === 'added-by-tool'));
check('add records the agent as the source', (await hub.state()).servers.find((server) => server.name === 'added-by-tool').source === 'agent');
await throws('add needs a name', () => callTool({ action: 'add', transport: 'sse', url: `${SSE}/sse` }), '`name` is required');
const rewrittenByTool = await callTool({ action: 'add', id: 'alpha', name: 'alpha', transport: 'streamable-http', url: `${HTTP}/mcp` });
check('add on an existing id updates that server in place', rewrittenByTool.text.includes('alpha') && (await hub.state()).servers.filter((server) => server.name === 'alpha').length === 1);
await throws('add refuses a name already used by another id', () => callTool({ action: 'add', id: 'alpha-alias', name: 'alpha', transport: 'streamable-http', url: `${HTTP}/mcp` }), 'already used by');
/* Regression: the agent tool forwards `headers`/`env` as the same JSON text the
   settings editor sends, and that text used to be dropped on the way to disk. */
const headerToolAdd = await callTool({ action: 'add', name: 'headers-by-tool', transport: 'streamable-http', url: `${HTTP}/notools`, headers: '{"X-Agent":"from-the-tool"}', env: '{"AGENT_FLAG":"yes"}' });
const headerToolServer = (await hub.state()).servers.find((server) => server.name === 'headers-by-tool');
check('add stores a header map the agent sent as JSON text', headerToolAdd.text.includes('headers-by-tool') && headerToolServer.headers['X-Agent'] === 'from-the-tool', JSON.stringify(headerToolServer.headers));
check('add stores an env map the agent sent as JSON text', headerToolServer.env.AGENT_FLAG === 'yes', JSON.stringify(headerToolServer.env));
check('the agent-sent maps reach the registry file too', registryServers().find((server) => server.id === 'headers-by-tool').headers['X-Agent'] === 'from-the-tool');
await throws('add surfaces a malformed header map', () => callTool({ action: 'add', name: 'bad-headers-tool', transport: 'streamable-http', url: `${HTTP}/notools`, headers: 'nope' }), 'headers must be a JSON object');
await throws('add surfaces a missing url', () => callTool({ action: 'add', name: 'no-url-tool', transport: 'streamable-http' }), 'requires a url');
await throws('add surfaces a missing stdio command', () => callTool({ action: 'add', name: 'no-cmd-tool', transport: 'stdio' }), 'stdio transport requires a command');
const stdioAddText = await callTool({ action: 'add', name: 'stdio-by-tool', transport: 'stdio', command: 'node', args: '--version' });
const stdioAdded = (await hub.state()).servers.find((server) => server.name === 'stdio-by-tool');
check('add defaults to the stdio shape and splits args', stdioAddText.text.includes('stdio-by-tool') && JSON.stringify(stdioAdded.args) === JSON.stringify(['--version']), JSON.stringify(stdioAdded.args));

const importText = await callTool({ action: 'import', text: `{"mcpServers":{"tool-imported":{"type":"http","url":"${HTTP}/notools","enabled":false}}}` });
check('import reports what it took', importText.text.includes('Imported 1 server(s)') && importText.text.includes('tool-imported'), importText.text);
await throws('import needs a document', () => callTool({ action: 'import' }), '`text` is required');

const removeText = await callTool({ action: 'remove', id: 'added-by-tool' });
check('remove deletes through the tool', removeText.text.includes('Removed MCP server') && !(await hub.state()).servers.some((server) => server.name === 'added-by-tool'));
await throws('remove refuses an unknown server', () => callTool({ action: 'remove', id: 'ghost' }), 'unknown MCP server');

const disableText = await callTool({ action: 'disable', id: 'tool-imported' });
check('disable flips a server off through the tool', disableText.text.includes('Disabled MCP server') && (await hub.state()).servers.find((server) => server.name === 'tool-imported').enabled === false);
const enableText = await callTool({ action: 'enable', id: 'tool-imported' });
check('enable flips it back on through the tool', enableText.text.includes('Enabled MCP server') && (await hub.state()).servers.find((server) => server.name === 'tool-imported').enabled === true);
await throws('disable needs a known server', () => callTool({ action: 'disable', id: 'ghost' }), 'unknown MCP server');
await throws('the tool rejects an unknown action', () => callTool({ action: 'nope' }), 'unsupported action');
await throws('the tool needs an action', () => callTool({}), 'unsupported action');
await hub.removeServer({ id: 'stdio-by-tool' });

/* ------------------------------------------------------------------ *
 * 9. Presets
 * ------------------------------------------------------------------ */

const presetIds = (await hub.state()).presets.map((preset) => preset.id);
check('the shipped presets are burp, burp-stdio and yakit', presetIds.join(',') === 'burp,burp-stdio,yakit', presetIds.join(','));
const presets = (await hub.state()).presets;
check('the Burp preset is the legacy SSE transport on the root path', presets.find((preset) => preset.id === 'burp').server.transport === 'sse' && presets.find((preset) => preset.id === 'burp').server.url === 'http://127.0.0.1:9876');
check('the Yakit preset ships disabled with a placeholder endpoint', presets.find((preset) => preset.id === 'yakit').server.enabled === false && presets.find((preset) => preset.id === 'yakit').server.url === '');
check('the Burp stdio preset ships a java proxy template', presets.find((preset) => preset.id === 'burp-stdio').server.command === 'java');
await throws('applyPreset rejects an unknown preset id', () => hub.applyPreset({ preset: 'nope' }), 'unknown preset');
await throws('applyPreset needs a preset id', () => hub.applyPreset({}), 'unknown preset');

const burpMark = __sdk.transports.length;
const withBurp = await hub.applyPreset({ preset: 'burp' });
const burpRow = withBurp.servers.find((server) => server.name === 'burp');
check('applyPreset stores the preset record', burpRow !== undefined && burpRow.transport === 'sse' && burpRow.url === 'http://127.0.0.1:9876');
check('applyPreset records where the record came from', burpRow.source === 'preset:burp');
check('an enabled preset is dialled immediately', await waitFor(() => __sdk.since('sse', burpMark).length === 1));
check('the preset was persisted', registryServers().some((server) => server.name === 'burp'));

const withBurpAgain = await hub.applyPreset({ preset: 'burp' });
check(
  'applying a preset twice does not overwrite the server of that name',
  withBurpAgain.servers.find((server) => server.name === 'burp').id === 'burp' &&
    withBurpAgain.servers.filter((server) => server.url === 'http://127.0.0.1:9876').length === 2,
);
check('the second copy is suffixed instead of duplicated by id', withBurpAgain.servers.some((server) => server.name === 'burp2'));
await hub.toggle({ id: 'burp2', enabled: false });

const withYakit = await hub.applyPreset({ preset: 'yakit' });
check(
  'a preset that ships disabled stays disabled',
  withYakit.servers.find((server) => server.name === 'yakit').enabled === false && withYakit.servers.find((server) => server.name === 'yakit').status.state === 'disabled',
);
check('a disabled preset gets no runtime at all', hub.runtimes.has('yakit') === false);
await hub.toggle({ id: 'yakit', enabled: true });
check('enabling a placeholder endpoint ends in an error state, not a throw', await waitFor(async () => (await statusOf(hub, 'yakit'))?.state === 'error'));
check('the placeholder error names the missing url', /requires a url/.test((await statusOf(hub, 'yakit'))?.error ?? ''), (await statusOf(hub, 'yakit'))?.error);
await hub.toggle({ id: 'yakit', enabled: false });

const withProxy = await hub.applyPreset({ preset: 'burp-stdio' });
const proxyRow = withProxy.servers.find((server) => server.name === 'burp-proxy');
check(
  'the stdio preset splits its argument string',
  JSON.stringify(proxyRow.args) === JSON.stringify(['-jar', 'C:\\path\\to\\mcp-proxy-all.jar', '--sse-url', 'http://127.0.0.1:9876']),
  JSON.stringify(proxyRow.args),
);
await hub.toggle({ id: 'burp-proxy', enabled: false });
await hub.toggle({ id: 'burp', enabled: false });

/* ------------------------------------------------------------------ *
 * 10. Import and export
 * ------------------------------------------------------------------ */

/* Put the header map back as an object: the editor's JSON text cannot survive
   `upsert` (see the note above), and the export has to be checked against a
   record that really carries headers. */
await hub.upsert({
  server: {
    id: 'alpha',
    name: 'alpha',
    transport: 'streamable-http',
    url: `${HTTP}/mcp`,
    description: 'Updated description.',
    headers: { Authorization: 'Bearer local-token' },
  },
});
const exported = await hub.exportJson();
check('exportJson returns a document and the registry file it mirrors', exported.file === REGISTRY && typeof exported.text === 'string');
const exportedDocument = JSON.parse(exported.text);
check('the exported document carries one entry per server', Object.keys(exportedDocument.mcpServers).length === (await hub.state()).servers.length, exported.text);
check('a streamable-http server exports with the `http` spelling', exportedDocument.mcpServers.alpha.type === 'http' && exportedDocument.mcpServers.alpha.url === `${HTTP}/mcp`);
check('an sse server exports with the `sse` spelling', exportedDocument.mcpServers.beta.type === 'sse' && exportedDocument.mcpServers.beta.url === `${SSE}/sse`);
check('a stdio server exports as a stdio record', exportedDocument.mcpServers['burp-proxy'].type === 'stdio' && exportedDocument.mcpServers['burp-proxy'].command === 'java');
check('headers survive the export', exportedDocument.mcpServers.alpha.headers.Authorization === 'Bearer local-token');
check('a stdio cwd is exported when set and omitted when empty', exportedDocument.mcpServers['cwd-holder'].cwd === scratch && !('cwd' in exportedDocument.mcpServers['burp-proxy']));
check('the export carries no undefined values', !exported.text.includes('undefined'));
check('the exported document is the import format of other MCP clients', Object.values(exportedDocument.mcpServers).every((entry) => entry.type === 'stdio' || entry.type === 'http' || entry.type === 'sse'));
/* The export writes only the fields that matter for each transport, so a record
   that carries the other transport's field loses it in a round trip. */
check('exportJson carries the env of a stdio record', exportedDocument.mcpServers['cwd-holder']?.env?.CWD_FLAG === 'kept', JSON.stringify(exportedDocument.mcpServers['cwd-holder']));
check('exportJson carries the headers of an http record', exportedDocument.mcpServers['text-maps']?.headers?.['X-Trace'] === '7');
check('exportJson omits env for a non-stdio record', !('env' in exportedDocument.mcpServers['text-maps']) && !('env' in exportedDocument.mcpServers['headers-by-tool']));
check(
  'exportJson omits headers for a stdio record',
  exportedDocument.mcpServers['cwd-holder'] !== undefined && !('headers' in exportedDocument.mcpServers['cwd-holder']),
  JSON.stringify(exportedDocument.mcpServers['cwd-holder']),
);
note('exportJson writes one shape per transport (stdio: command/args/env/cwd, http+sse: url/headers), while importJson stores env and headers for any record, so a round trip drops env from an http/sse record and headers from a stdio record. Both fields only affect a stdio child, so this is cosmetic today, but a record that switches to stdio later arrives without them.');

const target = (server) =>
  server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}`.trim() : server.url;
const shapeOf = (view) =>
  view.servers
    .map((server) => ({ name: server.name, transport: server.transport, target: target(server), headers: server.headers, env: server.env }))
    .sort((left, right) => left.name.localeCompare(right.name));
const beforeTrip = shapeOf(await hub.state());

/* The shipped `yakit` preset is a disabled placeholder with an empty url, and
   importJson skips every record that could never connect, so the export→import
   round trip is only lossless for records that have an endpoint. */
const placeholders = (await hub.state())
  .servers.filter((server) => (server.transport === 'stdio' ? server.command === '' : server.url === ''))
  .map((server) => server.name)
  .sort();
check('the registry holds exactly one unconnectable placeholder', JSON.stringify(placeholders) === JSON.stringify(['yakit']), JSON.stringify(placeholders));
const roundTripHome = join(scratch, 'round-trip-home');
const trip = await mountAndBoot(roundTripHome);
const tripImport = await trip.hub.importJson({ text: exported.text });
check('the exported document imports into a fresh home', tripImport.imported === beforeTrip.length - placeholders.length, String(tripImport.imported));
check('a fresh-home import reports the placeholder it skipped', JSON.stringify(tripImport.skipped) === JSON.stringify(placeholders), JSON.stringify(tripImport.skipped));
/* The expectation is derived from the exported document itself, so a field the
   export never wrote cannot be assumed back into existence here. */
const tripExpected = Object.entries(exportedDocument.mcpServers)
  .map(([name, entry]) => {
    const transport = entry.type === 'stdio' ? 'stdio' : entry.type === 'sse' ? 'sse' : 'streamable-http';
    return {
      name,
      transport,
      target: transport === 'stdio' ? `${entry.command ?? ''} ${(entry.args ?? []).join(' ')}`.trim() : entry.url,
      headers: entry.headers ?? {},
      env: entry.env ?? {},
    };
  })
  .filter((entry) => !placeholders.includes(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name));
const tripActual = shapeOf(tripImport.state);
check(
  'the round trip reproduces the document it came from',
  JSON.stringify(tripActual) === JSON.stringify(tripExpected),
  `missing ${JSON.stringify(tripExpected.filter((entry) => !tripActual.some((other) => JSON.stringify(other) === JSON.stringify(entry))))} unexpected ${JSON.stringify(tripActual.filter((entry) => !tripExpected.some((other) => JSON.stringify(other) === JSON.stringify(entry))))}`,
);
check('the round trip writes into the new home', tripImport.state.file === join(roundTripHome, 'mcp-hub', 'servers.json') && existsSync(join(roundTripHome, 'mcp-hub', 'servers.json')));
check('every re-imported server landed enabled', tripImport.state.servers.every((server) => server.enabled === true));
note('exportJson carries only transport, target, args, env, headers and cwd: enabled, id, source, description, reconnect and toolCallTimeoutMs are lost. Importing such a document into a home that does not know the server yet therefore enables it and resets those fields to their defaults.');
note('a round trip is not lossless for a placeholder: readRegistry keeps a record with no endpoint (the shipped `yakit` preset ships one, disabled, for the user to fill in), but importJson skips it because it could never connect — and neither the settings page nor the agent tool mentions `skipped`, so the dropped row is invisible in both halves of the UI.');
/* The round-trip home now dials every fixture; switch it all off before moving
   on, so the retry backoff of the unreachable entries stays quiet. */
for (const server of tripImport.state.servers) {
  await trip.hub.toggle({ id: server.id, enabled: false });
}

/* A matched server keeps the `enabled` flag unless the document carries one. */
await hub.toggle({ id: 'burp', enabled: false });
const reimport = await hub.importJson({ text: exported.text });
check(
  're-importing an export into the same registry creates no duplicate',
  reimport.imported === beforeTrip.length - placeholders.length && (await hub.state()).servers.length === beforeTrip.length,
  `${String(reimport.imported)} imported, ${String((await hub.state()).servers.length)} stored`,
);
check('a same-registry re-import leaves the placeholder untouched', (await hub.state()).servers.some((server) => server.name === 'yakit'));
check('an import keeps the stored id of a matched server', (await hub.state()).servers.find((server) => server.name === 'burp').id === 'burp');
check('an import keeps the stored source of a matched server', (await hub.state()).servers.find((server) => server.name === 'burp').source === 'preset:burp');
check('an import does not switch a disabled server back on when the document is silent', (await hub.state()).servers.find((server) => server.name === 'burp').enabled === false);
const explicitEnable = await hub.importJson({ text: JSON.stringify({ mcpServers: { burp: { type: 'sse', url: `${SSE}/sse`, enabled: true } } }) });
check('an import honours an explicit enabled flag', explicitEnable.imported === 1 && (await hub.state()).servers.find((server) => server.name === 'burp').enabled === true);
note('importJson replaces a matched record with the normalized document, preserving only id, source and — when the document omits `enabled` — the previous flag; description, reconnect and toolCallTimeoutMs fall back to their defaults.');
await hub.toggle({ id: 'burp', enabled: false });

const arrayImport = await hub.importJson({ text: JSON.stringify([{ name: 'arr-http', type: 'streamablehttp', url: `${HTTP}/notools`, enabled: false }]) });
check('import accepts an array document', arrayImport.imported === 1 && (await hub.state()).servers.some((server) => server.name === 'arr-http'));
check('import maps type=streamablehttp onto streamable-http', (await hub.state()).servers.find((server) => server.name === 'arr-http').transport === 'streamable-http');
const singleImport = await hub.importJson({ text: JSON.stringify({ name: 'single-stdio', command: 'node', args: ['--version'], env: { A: 1 }, headers: { 'x-stdio': 'kept-in-the-registry' }, toolCallTimeoutMs: 9_999_999, enabled: false }) });
check('import accepts a single record document', singleImport.imported === 1);
const singleRow = (await hub.state()).servers.find((server) => server.name === 'single-stdio');
check('import defaults a bare command to the stdio transport', singleRow.transport === 'stdio');
check('import stringifies env values', singleRow.env.A === '1', JSON.stringify(singleRow.env));
check('a stdio record keeps a header map in the registry', singleRow.headers['x-stdio'] === 'kept-in-the-registry', JSON.stringify(singleRow.headers));
check('import clamps an over-large tool timeout', singleRow.toolCallTimeoutMs === 600_000, String(singleRow.toolCallTimeoutMs));
check('import ignores a non-positive tool timeout', (await hub.importJson({ text: JSON.stringify({ name: 'zero-timeout', command: 'node', toolCallTimeoutMs: 0, enabled: false }) })).imported === 1 && (await hub.state()).servers.find((server) => server.name === 'zero-timeout').toolCallTimeoutMs === 60_000);
const urlOnly = await hub.importJson({ text: `{"mcpServers":{"url-only":{"url":"${HTTP}/notools","enabled":false}}}` });
check('a bare url is treated as Streamable HTTP', urlOnly.imported === 1 && (await hub.state()).servers.find((server) => server.name === 'url-only').transport === 'streamable-http');
const weirdImport = await hub.importJson({ text: `{"mcpServers":{"My Server!":{"url":"${HTTP}/notools","enabled":false}}}` });
const weirdRow = (await hub.state()).servers.find((server) => server.name.startsWith('My-Server'));
check('an imported name is normalized to the namespace grammar', weirdImport.imported === 1 && /^[A-Za-z0-9_-]{1,32}$/.test(weirdRow?.name ?? ''), String(weirdRow?.name));
check('the imported record keeps the raw document key as its id', weirdRow?.id === 'My Server!', String(weirdRow?.id));
await hub.removeServer({ id: 'My Server!' });

/* A record that can never connect is reported instead of stored: it used to be
   written as a dead stdio row the list kept dialling (and it disagreed with the
   validation upsert already applied). */
const junkImport = await hub.importJson({ text: '{"mcpServers":{"no-endpoint":{"description":"nothing usable"}}}' });check('import skips a record with neither a command nor a url', junkImport.imported === 0 && !(await hub.state()).servers.some((server) => server.name === 'no-endpoint'));
check('import reports the skipped record', JSON.stringify(junkImport.skipped) === JSON.stringify(['no-endpoint']), JSON.stringify(junkImport.skipped));
check('a skipped record is not written to the registry', !registryServers().some((server) => server.name === 'no-endpoint'));
check('a skipped record starts no runtime', ![...hub.runtimes.keys()].includes('no-endpoint'));
const mixedImport = await hub.importJson({ text: `{"mcpServers":{"mixed-ok":{"url":"${HTTP}/notools","enabled":false},"mixed-junk":{"description":"x"}}}` });
check(
  'a mixed import stores the usable record and reports the rest',
  mixedImport.imported === 1 && mixedImport.skipped.length === 1 && (await hub.state()).servers.some((server) => server.name === 'mixed-ok'),
  JSON.stringify({ imported: mixedImport.imported, skipped: mixedImport.skipped }),
);
await hub.removeServer({ id: 'mixed-ok' });

/* A non-record entry (a scalar or an array) is dropped by normalizeServer before
   the endpoint check, so it never reaches the `skipped` report. */
const nonRecordImport = await hub.importJson({ text: '{"mcpServers":{"scalar-entry":42,"array-entry":[]}}' });
check(
  'a non-record entry is neither stored nor counted',
  nonRecordImport.imported === 0 && !(await hub.state()).servers.some((server) => ['scalar-entry', 'array-entry'].includes(server.name)),
  JSON.stringify({ imported: nonRecordImport.imported, skipped: nonRecordImport.skipped }),
);
if (nonRecordImport.skipped.length === 0) {
  note('importJson drops a non-record entry (a scalar or an array) without reporting it: only a record that normalizes but has no endpoint reaches `skipped`, so a document made of such entries imports nothing and says nothing.');
}

await throws('import rejects an empty document', () => hub.importJson({ text: '   ' }), 'nothing to import');
await throws('import rejects malformed JSON', () => hub.importJson({ text: '{oops' }), 'invalid JSON');
await throws('import rejects a document with no server definition', () => hub.importJson({ text: '{"foo":1}' }), 'no server definition found');
await throws('import rejects a scalar document', () => hub.importJson({ text: '42' }), 'no server definition found');
await throws('import rejects a missing document', () => hub.importJson({}), 'nothing to import');

/* ------------------------------------------------------------------ *
 * 11. Loading an existing registry
 * ------------------------------------------------------------------ */

const loadHome = join(scratch, 'load-home');
mkdirSync(join(loadHome, 'mcp-hub'), { recursive: true });
const loadFile = join(loadHome, 'mcp-hub', 'servers.json');
const loadDocument = JSON.stringify(
  {
    version: 1,
    servers: [
      { id: 'loaded-http', name: 'loaded-http', enabled: false, type: 'http', url: `${HTTP}/mcp` },
      { name: 'loaded legacy!', enabled: false, command: 'node', args: '-e "1"', env: { A: 1 }, toolCallTimeoutMs: 9_999_999, reconnect: { enabled: false } },
      { id: 'loaded-sse', name: 'loaded-sse', enabled: true, transport: 'sse', url: `${SSE}/sse` },
      42,
      null,
      'nope',
      [1, 2],
      {},
    ],
  },
  null,
  2,
);
writeFileSync(loadFile, loadDocument);
const loaded = await mountAndBoot(loadHome);
const loadedState = await loaded.hub.state();
check('an existing registry is loaded', loadedState.servers.length === 4, JSON.stringify(loadedState.servers.map((server) => server.name)));
check('non-record entries are dropped instead of crashing the load', loadedState.servers.every((server) => typeof server.name === 'string'));
check(
  'an empty record becomes a positional fallback server',
  loadedState.servers.some((server) => server.name === 'server8' && server.command === ''),
  JSON.stringify(loadedState.servers.map((server) => server.name)),
);
note('an empty object in servers.json is not dropped: it becomes an unusable `server<N>` record (no command, no url) that boot() then dials and reports as an error.');
check('a record without an id falls back to its name', loadedState.servers.find((server) => server.name === 'loaded-legacy-')?.id === 'loaded-legacy-');
check('type=http loads as Streamable HTTP', loadedState.servers.find((server) => server.id === 'loaded-http').transport === 'streamable-http');
const loadedLegacy = loadedState.servers.find((server) => server.name === 'loaded-legacy-');
check('a loaded name is normalized to the namespace grammar', /^[A-Za-z0-9_-]{1,32}$/.test(loadedLegacy.name), loadedLegacy.name);
check('a loaded args string is split', JSON.stringify(loadedLegacy.args) === JSON.stringify(['-e', '1']), JSON.stringify(loadedLegacy.args));
check('a loaded env value is stringified', loadedLegacy.env.A === '1');
check('a loaded timeout is clamped', loadedLegacy.toolCallTimeoutMs === 600_000, String(loadedLegacy.toolCallTimeoutMs));
check('a loaded reconnect policy is honoured and completed', loadedLegacy.reconnect.enabled === false && loadedLegacy.reconnect.maxAttempts === 10);
check('loading does not rewrite the file', readFileSync(loadFile, 'utf8') === loadDocument);
check('boot brings up an enabled server', await waitFor(async () => (await statusOf(loaded.hub, 'loaded-sse'))?.state === 'connected'));
check('boot leaves a disabled server idle', (await loaded.hub.state()).servers.find((server) => server.id === 'loaded-http').status.state === 'disabled');
check('the loaded enabled server bridged its tools', await waitFor(() => loaded.liveTools().includes('mcp__loaded-sse__add')));

const arrayHome = join(scratch, 'array-home');
mkdirSync(join(arrayHome, 'mcp-hub'), { recursive: true });
writeFileSync(join(arrayHome, 'mcp-hub', 'servers.json'), JSON.stringify([{ name: 'arr-loaded', command: 'node', enabled: false }]));
const arrayLoaded = await mountAndBoot(arrayHome);
const arrayState = await arrayLoaded.hub.state();
check('a bare array registry document is accepted', arrayState.servers.length === 1 && arrayState.servers[0].name === 'arr-loaded');
check('a record with neither transport nor url loads as stdio', arrayState.servers[0].transport === 'stdio');

/* ---- corrupt and ill-shaped registries ---- */
const corruptHome = join(scratch, 'corrupt-home');
mkdirSync(join(corruptHome, 'mcp-hub'), { recursive: true });
const corruptFile = join(corruptHome, 'mcp-hub', 'servers.json');
const garbage = '{ "version": 1, "servers": [ { "name": "half-written" ';
writeFileSync(corruptFile, garbage);
const corrupt = await mountAndBoot(corruptHome);
const corruptState = await corrupt.hub.state();
check('a corrupt registry does not throw at boot', corrupt.hub !== undefined);
check('a corrupt registry loads as an empty list', corruptState.servers.length === 0);
check('a corrupt registry leaves the plugin usable', Array.isArray(corruptState.transports));
check('a corrupt registry is left untouched by the load', readFileSync(corruptFile, 'utf8') === garbage);
check(
  'a corrupt registry is reported through state()',
  typeof corruptState.registryError === 'string' && corruptState.registryError.includes(corruptFile),
  String(corruptState.registryError),
);
check('the registry report names the parse failure', corruptState.registryError.includes('is not valid JSON') && /JSON/i.test(corruptState.registryError), String(corruptState.registryError));
check('a corrupt registry warns instead of staying silent', corrupt.logs.some((line) => line.startsWith('warn') && line.includes('is not valid JSON')), corrupt.logsText());
check('the corrupt boot still reports its server count', corrupt.logsText().includes('0 server(s) configured'));
check('no backup exists before the first write', corruptState.registryBackup === undefined, String(corruptState.registryBackup));
check('the corrupt hub kept its own registry path', corruptState.file === corruptFile);

/* The first write over an unreadable document has to keep a copy of it. */
await corrupt.hub.upsert({ server: { id: 'repaired', name: 'repaired', transport: 'streamable-http', url: `${HTTP}/notools`, enabled: false } });
const repaired = JSON.parse(readFileSync(corruptFile, 'utf8'));
check('a write after a corrupt load repairs the file into valid JSON', repaired.version === 1 && repaired.servers.length === 1 && repaired.servers[0].name === 'repaired');
const afterRepair = await corrupt.hub.state();
check(
  'the first write records where the unreadable document went',
  typeof afterRepair.registryBackup === 'string' && afterRepair.registryBackup.startsWith(`${corruptFile}.corrupt-`),
  String(afterRepair.registryBackup),
);
const backupPath = typeof afterRepair.registryBackup === 'string' ? afterRepair.registryBackup : '';
check('the preserved copy sits beside the registry', backupPath !== '' && dirname(backupPath) === dirname(corruptFile));
check('the preserved document is byte-identical to the one that was there', backupPath !== '' && existsSync(backupPath) && readFileSync(backupPath, 'utf8') === garbage);
check('the preservation is announced in the log', corrupt.logs.some((line) => line.includes('unreadable registry preserved as')), corrupt.logsText());
const backupsBefore = readdirSync(join(corruptHome, 'mcp-hub')).filter((name) => name.includes('.corrupt-')).length;
await corrupt.hub.persist();
const backupsAfter = readdirSync(join(corruptHome, 'mcp-hub')).filter((name) => name.includes('.corrupt-')).length;
check('a later write does not preserve the document a second time', backupsBefore === 1 && backupsAfter === 1, `${String(backupsBefore)} then ${String(backupsAfter)}`);
check('the repaired registry is still readable after another write', JSON.parse(readFileSync(corruptFile, 'utf8')).servers[0].name === 'repaired');

/* Observing, not asserting: boot() sets the report but never clears it again. */
await corrupt.hub.boot();
if ((await corrupt.hub.state()).registryError !== undefined) {
  note('boot() sets registryError for an unreadable registry but does not clear it once the file parses again, so a hub that booted against a corrupt file keeps reporting the old parse failure — only clearErrors() or a fresh Host start resets it.');
}
const clearedCorrupt = await corrupt.hub.clearErrors();
check('clearErrors clears the registry error', clearedCorrupt.registryError === undefined, String(clearedCorrupt.registryError));
check('clearErrors keeps the repaired record', clearedCorrupt.servers.length === 1 && clearedCorrupt.servers[0].name === 'repaired');
check('clearErrors keeps the preserved copy path', clearedCorrupt.registryBackup === afterRepair.registryBackup, String(clearedCorrupt.registryBackup));

const shapeHome = join(scratch, 'shape-home');
mkdirSync(join(shapeHome, 'mcp-hub'), { recursive: true });
writeFileSync(join(shapeHome, 'mcp-hub', 'servers.json'), '{"version":1,"servers":"not an array"}');
const badShape = await mountAndBoot(shapeHome);
check('a registry whose servers field is not an array falls back to empty', (await badShape.hub.state()).servers.length === 0);
check('a parseable registry with a bad servers field is not reported as corrupt', (await badShape.hub.state()).registryError === undefined);

const emptyFileHome = join(scratch, 'empty-file-home');
mkdirSync(join(emptyFileHome, 'mcp-hub'), { recursive: true });
writeFileSync(join(emptyFileHome, 'mcp-hub', 'servers.json'), '');
const emptyFile = await mountAndBoot(emptyFileHome);
check('an empty registry file loads as an empty list', (await emptyFile.hub.state()).servers.length === 0);
check('an empty registry file is not rewritten by the load', readFileSync(join(emptyFileHome, 'mcp-hub', 'servers.json'), 'utf8') === '');
check('an empty registry file is reported as unreadable', typeof (await emptyFile.hub.state()).registryError === 'string', String((await emptyFile.hub.state()).registryError));
check('an empty registry file is not backed up by the load', (await emptyFile.hub.state()).registryBackup === undefined);

/* ------------------------------------------------------------------ *
 * Teardown
 * ------------------------------------------------------------------ */

for (const record of [...mounted].reverse()) {
  for (const effect of [...record.effects].reverse()) {
    try {
      await effect.dispose?.();
    } catch {
      /* a hub that is already disposed is fine */
    }
  }
}
for (const stream of sseSessions.values()) stream.destroy();
sseSessions.clear();
httpServer.closeAllConnections?.();
sseServer.closeAllConnections?.();
await Promise.all([
  new Promise((done) => httpServer.close(() => done())),
  new Promise((done) => sseServer.close(() => done())),
]);
await sleep(50);
rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

console.log(`\n${String(passed)} passed, ${String(failures)} failed, ${String(skipped)} skipped`);
console.log(failures === 0 ? 'ALL PASS' : `${String(failures)} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
