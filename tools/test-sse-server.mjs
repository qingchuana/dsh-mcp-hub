/**
 * Minimal MCP server speaking the legacy HTTP+SSE transport (MCP 2024-11-05).
 *
 * This exists only to verify `dsh-mcp-hub`'s `sse` transport without needing
 * Burp Suite or Yakit on the machine: it behaves like the SSE-only servers
 * those tools expose — a GET event stream that announces its POST endpoint via
 * an `endpoint` event, and a separate POST endpoint for outbound messages.
 *
 * Usage: node test-sse-server.mjs [port]   (0 = ephemeral; the bound URL is printed)
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2] ?? 9911);
/** @type {Map<string, import('node:http').ServerResponse>} */
const sessions = new Map();

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text (SSE transport smoke test).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: 'Add two integers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
    },
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
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hub-test-sse', version: '1.0.0' },
        instructions: 'SSE transport smoke-test server for dsh-mcp-hub.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'echo') return ok({ content: [{ type: 'text', text: `echo: ${String(args.text)}` }] });
      if (name === 'add') {
        const sum = Number(args.a) + Number(args.b);
        return ok({ content: [{ type: 'text', text: `${args.a} + ${args.b} = ${sum}` }], structuredContent: { sum } });
      }
      return ok({ content: [{ type: 'text', text: `unknown tool ${String(name)}` }], isError: true });
    }
    /* The SDK probes the modern era first; refusing it makes the client fall
       back to the legacy `initialize` handshake this server implements. */
    case 'server/discover':
      return fail(-32601, 'method not found');
    default:
      return fail(-32601, `method not found: ${String(method)}`);
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (req.method === 'GET' && url.pathname === '/sse') {
    const sessionId = randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
    sessions.set(sessionId, res);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sessions.delete(sessionId);
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/message') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const stream = sessions.get(url.searchParams.get('sessionId') ?? '');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('Accepted');
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return;
      }
      const reply = Array.isArray(message) ? message.map(handle).filter(Boolean) : handle(message);
      if (stream === undefined || reply === undefined) return;
      for (const entry of Array.isArray(reply) ? reply : [reply]) {
        stream.write(`event: message\ndata: ${JSON.stringify(entry)}\n\n`);
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  /* Print the port actually bound, so `0` (an ephemeral port) is usable. */
  const bound = server.address().port;
  console.log(`test SSE MCP server listening on http://127.0.0.1:${bound}/sse`);
});
