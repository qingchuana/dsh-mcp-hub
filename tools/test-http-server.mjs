/**
 * Minimal MCP server speaking Streamable HTTP (MCP 2025-03-26+): one endpoint
 * that answers JSON-RPC POSTs with either a JSON body or a per-request SSE
 * stream, and carries the session in the `Mcp-Session-Id` header.
 *
 * Used to verify dsh-mcp-hub's `streamable-http` transport.
 *
 * Usage: node test-http-server.mjs [port]   (0 = ephemeral; the bound URL is printed)
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2] ?? 9912);
const sessions = new Set();

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text (Streamable HTTP smoke test).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'slow',
    description: 'Answer after a delay, to exercise long-running calls.',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } }, required: [] },
  },
];

/** @returns {object | undefined} a JSON-RPC reply, or undefined for a notification. */
function handle(message) {
  if (message === null || typeof message !== 'object' || message.id === undefined) return undefined;
  const { id, method, params } = message;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hub-test-http', version: '1.0.0' },
        instructions: 'Streamable HTTP smoke-test server for dsh-mcp-hub.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'echo') return ok({ content: [{ type: 'text', text: `echo: ${String(args.text)}` }] });
      if (name === 'slow') return { slow: Number(args.ms ?? 300) };
      return ok({ content: [{ type: 'text', text: `unknown tool ${String(name)}` }], isError: true });
    }
    case 'server/discover':
      return ok({
        protocolVersions: ['2025-03-26'],
        serverInfo: { name: 'hub-test-http', version: '1.0.0' },
        capabilities: { tools: { listChanged: false } },
      });
    default:
      return fail(-32601, `method not found: ${String(method)}`);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (req.method === 'DELETE') {
    sessions.delete(req.headers['mcp-session-id']);
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET') {
    /* The stream half is optional for this fixture; refusing it keeps the test
       on the JSON-response path. */
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  const body = await readBody(req);
  let message;
  try {
    message = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
    return;
  }
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const incoming = req.headers['mcp-session-id'];
  if (typeof incoming === 'string') headers['Mcp-Session-Id'] = incoming;
  else if (message?.method === 'initialize') {
    const sessionId = randomUUID();
    sessions.add(sessionId);
    headers['Mcp-Session-Id'] = sessionId;
  }
  const reply = Array.isArray(message) ? message.map(handle).filter(Boolean) : handle(message);
  if (reply === undefined) {
    res.writeHead(202, headers);
    res.end();
    return;
  }
  if (reply !== null && typeof reply === 'object' && 'slow' in reply) {
    await new Promise((resolve) => setTimeout(resolve, reply.slow));
    res.writeHead(200, headers);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `slept ${reply.slow} ms` }] } }));
    return;
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify(reply));
});

server.listen(port, '127.0.0.1', () => {
  /* Print the port actually bound, so `0` (an ephemeral port) is usable. */
  const bound = server.address().port;
  console.log(`test Streamable HTTP MCP server listening on http://127.0.0.1:${bound}/mcp`);
});
