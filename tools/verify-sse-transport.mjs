/**
 * Verify the legacy HTTP+SSE transport against tools/test-sse-server.mjs using
 * the exact SDK copy DSH ships, so a plugin-side failure can be told apart from
 * an SDK or protocol failure.
 *
 * Start the fixture first (node tools/test-sse-server.mjs) and, if DSH is not
 * installed in a conventional place, point `DSH_APP_DIR` at it.
 *
 * Usage: node tools/verify-sse-transport.mjs [sse-url]
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findAppDir } from './lib/dsh-paths.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:9911/sse';

const app = findAppDir();
const sdk = app === undefined ? undefined : join(app, 'node_modules', '@modelcontextprotocol', 'client', 'dist', 'index.mjs');
if (sdk === undefined || !existsSync(sdk)) {
  console.log('skip  the shipped MCP SDK was not found; set DSH_APP_DIR to a DSH installation');
  process.exit(0);
}

const { Client, SSEClientTransport } = await import(pathToFileURL(sdk).href);

const client = new Client({ name: 'verify-sse', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
try {
  await client.connect(new SSEClientTransport(new URL(url)));
  console.log('connected:', JSON.stringify(client.getServerVersion()), 'protocol:', client.getNegotiatedProtocolVersion());
  const { tools } = await client.listTools(undefined, { cacheMode: 'refresh' });
  console.log('tools:', tools.map((tool) => tool.name).join(', '));
  const result = await client.callTool({ name: 'echo', arguments: { text: 'hello sse' } }, { timeout: 5000 });
  console.log('call echo ->', JSON.stringify(result.content));
  const sum = await client.callTool({ name: 'add', arguments: { a: 2, b: 40 } }, { timeout: 5000 });
  console.log('call add  ->', JSON.stringify(sum.structuredContent ?? sum.content));
  console.log('SSE TRANSPORT OK');
} catch (error) {
  console.error('SSE TRANSPORT FAILED:', error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
