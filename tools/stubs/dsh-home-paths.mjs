/**
 * Test double for `@deepseek-ai/dsh-home-paths`.
 *
 * The real module resolves the harness home from configuration or the
 * environment; the suite redirects `$DSH_HOME` to a temp directory, so the same
 * precedence is all this double has to reproduce: configured > `$DSH_HOME` >
 * `~/.dsh`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveDshHome(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured;
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

export function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments);
}

export const DSH_HOME_ENV = 'DSH_HOME';
export const DSH_HOME_DIR_NAME = '.dsh';
export const DEFAULT_DSH_HOME_DISPLAY = '~/.dsh';

export function defaultDshHome() {
  return join(homedir(), DSH_HOME_DIR_NAME);
}

export function dshHomeDisplay(resolvedHome) {
  return resolvedHome === defaultDshHome() ? DEFAULT_DSH_HOME_DISPLAY : '$DSH_HOME';
}
