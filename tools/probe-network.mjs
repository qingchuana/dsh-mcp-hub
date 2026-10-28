/**
 * Probe which network paths can actually fetch a skill archive or a raw
 * SKILL.md on this machine, so the installer is built against a route that
 * works rather than a plausible one.
 *
 * Usage: node tools/probe-network.mjs
 */
const TARGETS = [
  ['direct codeload', 'https://codeload.github.com/anthropics/skills/tar.gz/refs/heads/main'],
  ['direct github archive', 'https://github.com/anthropics/skills/archive/refs/heads/main.tar.gz'],
  ['direct raw', 'https://raw.githubusercontent.com/anthropics/skills/main/README.md'],
  ['ghproxy codeload', 'https://ghproxy.net/https://codeload.github.com/anthropics/skills/tar.gz/refs/heads/main'],
  ['ghproxy github archive', 'https://ghproxy.net/https://github.com/anthropics/skills/archive/refs/heads/main.tar.gz'],
  ['ghproxy raw', 'https://ghproxy.net/https://raw.githubusercontent.com/anthropics/skills/main/README.md'],
  ['gh-proxy archive', 'https://gh-proxy.com/https://github.com/anthropics/skills/archive/refs/heads/main.tar.gz'],
  ['jsdelivr raw', 'https://cdn.jsdelivr.net/gh/anthropics/skills@main/README.md'],
  ['jsdelivr api', 'https://data.jsdelivr.com/v1/packages/gh/anthropics/skills@main'],
];

const proxy = process.env.HTTPS_PROXY ?? 'http://127.0.0.1:7897';

for (const [label, url] of TARGETS) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
    const body = await response.arrayBuffer();
    console.log(`ok    ${label.padEnd(24)} ${String(response.status)} ${String(body.byteLength).padStart(9)} bytes  ${String(Date.now() - started)}ms`);
  } catch (error) {
    const cause = error?.cause?.code ?? error?.cause?.message ?? '';
    console.log(`FAIL  ${label.padEnd(24)} ${String(Date.now() - started)}ms  ${error instanceof Error ? error.message : String(error)} ${String(cause)}`);
  }
}

console.log(`\nproxy candidate: ${proxy}`);
try {
  const response = await fetch('https://codeload.github.com/anthropics/skills/tar.gz/refs/heads/main', { signal: AbortSignal.timeout(20_000) });
  console.log(`env-proxy fetch: ${String(response.status)}`);
} catch (error) {
  console.log(`env-proxy fetch failed: ${error instanceof Error ? error.message : String(error)}`);
}
