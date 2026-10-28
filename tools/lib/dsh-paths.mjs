/**
 * Locate the installed DSH application, for checks that validate this plugin
 * against the harness it runs inside.
 *
 * Nothing here is required to *use* the plugin: a machine without a DSH install
 * simply skips those checks. Point `DSH_APP_DIR` (or `DSH_GATEWAY`) at a copy
 * to include it, e.g.
 *
 *   $env:DSH_APP_DIR = 'D:\Apps\DSH Desktop\resources\app'   # PowerShell
 *   DSH_APP_DIR=/opt/DSH\ Desktop/resources/app npm run check
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Relative path of the gateway client inside a DSH installation. */
const GATEWAY_SUFFIX = join('node_modules', '@deepseek-ai', 'dsh-api-gateway', 'lib', 'client.js');

/** Any DSH install worth probing, most explicit first. */
const CANDIDATES = [
  process.env.DSH_APP_DIR,
  /* Portable/unpacked installs (a self-extracted folder next to the desktop
     shortcut) are common, so probe a couple of conventional drives too. */
  'E:/DshDesktop/DSH Desktop/resources/app',
  'D:/DshDesktop/DSH Desktop/resources/app',
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'DSH Desktop', 'resources', 'app'),
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'DSH Desktop', 'resources', 'app'),
  join(process.env.ProgramFiles ?? 'C:/Program Files', 'DSH Desktop', 'resources', 'app'),
  '/Applications/DSH Desktop.app/Contents/Resources/app',
  '/opt/DSH Desktop/resources/app',
].filter((entry) => typeof entry === 'string' && entry !== '');

/**
 * The first candidate that looks like a DSH install.
 *
 * @returns the app directory, or `undefined` when none exists.
 */
export function findAppDir() {
  for (const candidate of CANDIDATES) {
    if (existsSync(join(candidate, 'node_modules', '@deepseek-ai'))) return candidate;
  }
  return undefined;
}

/**
 * The shipped gateway client used to validate Remote contracts.
 *
 * @returns the file path, or `undefined` when the harness is not installed.
 */
export function findGateway() {
  if (typeof process.env.DSH_GATEWAY === 'string' && existsSync(process.env.DSH_GATEWAY)) return process.env.DSH_GATEWAY;
  const app = findAppDir();
  if (app === undefined) return undefined;
  const gateway = join(app, GATEWAY_SUFFIX);
  return existsSync(gateway) ? gateway : undefined;
}

/**
 * Report a check that cannot run here, without failing the run.
 *
 * @param what - the check that needs the harness.
 * @param detail - the path that was looked for.
 */
export function skip(what, detail) {
  console.log(`skip  ${what} — DSH not found${detail === undefined ? '' : ` (${detail})`}; set DSH_APP_DIR or DSH_GATEWAY to include it`);
}
