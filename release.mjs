#!/usr/bin/env node
// Local release: publish the current version to every registry whose token is
// available, after gating on typecheck + tests.
//
// Each registry is independent. A registry whose token is unset is skipped and
// reported, never prompted for and never fatal -- so a missing VSCE_PAT degrades
// to "Open VSX only" rather than failing the release. The exit code is non-zero
// only if a publish that was actually attempted failed.
//
// Usage:
//   VSCE_PAT=<token> OVSX_PAT=<token> node release.mjs

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

const REGISTRIES = [
  {
    name: 'VS Code Marketplace',
    id: `${pkg.publisher}.${pkg.name}`,
    token: process.env.VSCE_PAT,
    cmd: 'npx',
    args: ['vsce', 'publish', '--pat', process.env.VSCE_PAT],
  },
  {
    name: 'Open VSX',
    id: 'lawaty.lalog',
    token: process.env.OVSX_PAT,
    cmd: 'npx',
    args: ['ovsx', 'publish'],
  },
];

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const failed = [];

console.log(`LaLog ${pkg.version}\n`);
console.log('Gate: typecheck + tests');
if ((await run('npm', ['run', 'typecheck'])) !== 0 || (await run('npm', ['test'])) !== 0) {
  console.error('\nGate failed - nothing published.');
  process.exit(1);
}

for (const registry of REGISTRIES) {
  console.log(`\n${'='.repeat(60)}\n${registry.name}  (${registry.id})\n${'='.repeat(60)}`);
  if (!registry.token) {
    console.log(`SKIPPED - no token. Set ${registry.id.startsWith('L') ? 'VSCE_PAT' : 'OVSX_PAT'}.`);
    continue;
  }
  if ((await run(registry.cmd, registry.args)) !== 0) failed.push(registry.name);
}

console.log(`\n${'='.repeat(60)}\nSummary\n${'='.repeat(60)}`);
for (const registry of REGISTRIES) {
  const status = failed.includes(registry.name)
    ? 'FAILED'
    : registry.token
      ? 'published'
      : 'skipped (no token)';
  console.log(`  ${registry.name.padEnd(22)} ${status}`);
}
console.log(
  '\nNote: Open VSX indexing lags the publish - /versions can trail by minutes.' +
    ' Check /api/lawaty/lalog/<version> instead.',
);

process.exit(failed.length ? 1 : 0);