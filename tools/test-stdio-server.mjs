/**
 * Minimal stdio MCP server (newline-delimited JSON-RPC), used to verify the
 * `stdio` transport of dsh-mcp-hub without installing a third-party server.
 *
 * Usage: node test-stdio-server.mjs
 */
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text (stdio transport smoke test).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
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
        capabilities: { tools: {} },
        serverInfo: { name: 'hub-test-stdio', version: '1.0.0' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      return ok({ content: [{ type: 'text', text: `echo: ${String(params?.arguments?.text)}` }] });
    case 'server/discover':
      return fail(-32601, 'method not found');
    default:
      return fail(-32601, `method not found: ${String(method)}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== '') {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        message = undefined;
      }
      if (message !== undefined) {
        const reply = handle(message);
        if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
      }
    }
    index = buffer.indexOf('\n');
  }
});
