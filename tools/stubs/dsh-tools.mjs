/**
 * Test double for `@deepseek-ai/dsh-tools`.
 * `defineTool` is an identity function as far as a plugin is concerned: the
 * framework is what projects `parameters` into JSON Schema.
 */
export function defineTool(definition) {
  return definition;
}
