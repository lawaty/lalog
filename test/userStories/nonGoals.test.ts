import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { setupHarness } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function srcFiles(): string {
  // Relative to cwd: npm tests run from the project root.
  return walk('src').map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

test('non-goal · no continue/resume option on a stale session', async (t) => {
  const h = setupHarness(t, { config: { staleSessionAfterMinutes: 60 } });
  await h.start();
  await h.edit();
  await h.tick(60_000);
  await h.flush();
  const closed = await h.closedSessions();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closedReason, 'auto-idle');
  assert.equal(mockVscode.promptCalls().length, 0, 'no continue/resume prompt');
});

test('non-goal · resumeWindowMinutes is absent from config and package.json', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const configProps = pkg.contributes.configuration.properties;
  assert.ok(!Object.keys(configProps).some((k) => k.includes('resumeWindow')), 'no resumeWindowMinutes setting');
  const src = fs.readFileSync('src/core/config.ts', 'utf8');
  assert.ok(!src.includes('resumeWindowMinutes'));
});

test('non-goal · no cloud/telemetry network code in src', () => {
  const src = srcFiles();
  assert.ok(!/fetch\s*\(/.test(src));
  assert.ok(!/\brequire\s*\(\s*['"](?:http|https|net|dgram|tls)['"]\s*\)/.test(src));
  assert.ok(!/\bfrom\s+['"](?:http|https|net|dgram|tls)['"]/.test(src));
});

test('non-goal · no pomodoro timers in production', () => {
  const src = srcFiles();
  assert.ok(!/pomodoro/i.test(src));
});

test('non-goal · never prompt about a closed session (US-3.10 pointer)', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  await h.manager.endSession('user');
  const before = mockVscode.promptCalls().length;
  await h.tick(120_000);
  await h.flush();
  assert.equal(mockVscode.promptCalls().length, before);
});