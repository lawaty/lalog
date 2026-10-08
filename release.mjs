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

// --dry-run reports what would be published, with which auth, and stops. Nothing
// is built, tested, or sent - useful for confirming auth resolution before a real
// release, since a publish is not freely repeatable (versions are immutable).
const dryRun = process.argv.includes('--dry-run');

// Microsoft Marketplace accepts either a classic Azure DevOps PAT or a Microsoft
// Entra ID token. Prefer the PAT when present; fall back to Entra ID when
// VSCE_AZURE_CREDENTIAL is set, which hands auth to `az login` / azd / Azure
// PowerShell (see @azure/identity's chain in vsce's auth.js) instead of a secret
// you have to create, rotate, and avoid leaking.
const wantsEntra = /^(1|true|yes)$/i.test(process.env.VSCE_AZURE_CREDENTIAL ?? '');
const vsceAuth = process.env.VSCE_PAT
  ? { how: 'PAT', args: ['vsce', 'publish', '--pat', process.env.VSCE_PAT] }
  : wantsEntra
    ? { how: 'Microsoft Entra ID', args: ['vsce', 'publish', '--azure-credential'] }
    : null;

const REGISTRIES = [
  {
    name: 'VS Code Marketplace',
    id: `${pkg.publisher}.${pkg.name}`,
    auth: vsceAuth,
    unavailable: 'set VSCE_PAT, or set VSCE_AZURE_CREDENTIAL=1 after `az login`',
    args: () => vsceAuth.args,
  },
  {
    name: 'Open VSX',
    id: 'lawaty.lalog',
    auth: process.env.OVSX_PAT ? { how: 'token' } : null,
    unavailable: 'set OVSX_PAT',
    args: () => ['ovsx', 'publish'],
  },
];

function run(argv) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', shell: false });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

const failed = [];

console.log(`LaLog ${pkg.version}${dryRun ? '  (dry run - nothing will be published)' : ''}\n`);

if (dryRun) {
  for (const registry of REGISTRIES) {
    console.log(`\n${'='.repeat(60)}\n${registry.name}  (${registry.id})\n${'='.repeat(60)}`);
    if (!registry.auth) {
      console.log(`SKIPPED - no credentials. ${registry.unavailable}.`);
      continue;
    }
    console.log(`auth: ${registry.auth.how}`);
    console.log(`would run: npx ${registry.args().join(' ')}`);
  }
  console.log('');
  process.exit(0);
}

console.log('Gate: typecheck + tests');
if ((await run(['npm', 'run', 'typecheck'])) !== 0 || (await run(['npm', 'test'])) !== 0) {
  console.error('\nGate failed - nothing published.');
  process.exit(1);
}

for (const registry of REGISTRIES) {
  console.log(`\n${'='.repeat(60)}\n${registry.name}  (${registry.id})\n${'='.repeat(60)}`);
  if (!registry.auth) {
    console.log(`SKIPPED - no credentials. ${registry.unavailable}.`);
    continue;
  }
  console.log(`auth: ${registry.auth.how}`);
  if ((await run(['npx', ...registry.args()])) !== 0) failed.push(registry.name);
}

console.log(`\n${'='.repeat(60)}\nSummary\n${'='.repeat(60)}`);
for (const registry of REGISTRIES) {
  const status = failed.includes(registry.name)
    ? 'FAILED'
    : registry.auth
      ? `published (${registry.auth.how})`
      : 'skipped (no credentials)';
  console.log(`  ${registry.name.padEnd(22)} ${status}`);
}
console.log(
  '\nNote: Open VSX indexing lags the publish - /versions can trail by minutes.' +
    ' Check /api/lawaty/lalog/<version> instead.',
);

process.exit(failed.length ? 1 : 0);