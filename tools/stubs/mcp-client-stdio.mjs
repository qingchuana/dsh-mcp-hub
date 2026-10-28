/**
 * Test double for the `@modelcontextprotocol/client/stdio` subpath export.
 * The stdio transport lives with the rest of the double so one module instance
 * — and therefore one `__sdk` record — covers all three transports.
 */
export { StdioClientTransport } from './mcp-client.mjs';
