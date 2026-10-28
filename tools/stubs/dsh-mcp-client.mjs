/**
 * Test double for `@deepseek-ai/dsh-mcp-client`.
 *
 * The real bridge wraps one MCP tool into a harness tool definition with
 * canonical result shaping, error surfacing and image projection. The plugin
 * only relies on the definition being registrable and on its `call` reaching
 * the MCP client, so this double keeps exactly that contract and records every
 * spec it was handed, which is how the suite proves what the plugin passed in
 * (public name, raw name, schema, task support).
 */
export const __bridge = { specs: [] };

export function createMcpToolDefinition(_root, spec) {
  __bridge.specs.push(spec);
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    output: spec.outputSchema,
    rawName: spec.rawName,
    taskRequired: spec.taskRequired === true,
    call(args, execution) {
      return spec.call(args, execution);
    },
  };
}
