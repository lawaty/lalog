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

function srcFiles(except: string[] = []): string {
  // Relative to cwd: npm tests run from the project root.
  return walk('src')
    .filter((f) => !except.some((x) => f.replace(/\\/g, '/').includes(x)))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

function allSrc(): string {
  return walk('src').map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

/**
 * The sanctioned network code paths in src (US-7.2 / ADR-032 → ADR-033):
 * src/opencode/serveWatcher.ts polls a localhost `opencode serve`, and
 * src/opencode/serveProcess.ts is its lifecycle half — the same localhost
 * `fetch` for discovery/readiness verification, plus a child_process spawn of
 * an opencode serve on loopback (which it stops only if it started it).
 * Every other file must stay completely free of network calls.
 */
const SERVE_WATCHER = 'opencode/serveWatcher.ts';
const SERVE_PROCESS = 'opencode/serveProcess.ts';
const OPENCODE_FILES = [SERVE_WATCHER, SERVE_PROCESS];

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

test('non-goal · no cloud/telemetry network code outside the opencode serve modules', () => {
  // The carve-out is exactly the two opencode files: the serve watcher
  // and the lifecycle module that starts/stops a serve LaLog owns. Both speak
  // only to 127.0.0.1. LaLog hosts nothing and talks to nothing else.
  const src = srcFiles(OPENCODE_FILES);
  assert.ok(!/fetch\s*\(/.test(src), 'no fetch() outside the opencode serve modules');
  const all = allSrc();
  assert.ok(!/\brequire\s*\(\s*['"](?:http|https|net|dgram|tls)['"]\s*\)/.test(all));
  assert.ok(!/\bfrom\s+['"](?:http|https|net|dgram|tls)['"]/.test(all));
  // The opencode modules themselves must stay on the global fetch: no http
  // client libs, no node:http, and nothing that could reach a remote host.
  assert.ok(!/axios|node-fetch|undici/.test(all), 'no http client libs');
  assert.ok(!/node:http/.test(all), 'the opencode modules use global fetch, not node:http');
  assert.ok(!/0\.0\.0\.0/.test(all), 'never a routable bind: loopback only');
  const props = JSON.parse(fs.readFileSync('package.json', 'utf8')).contributes.configuration
    .properties as Record<string, { default?: unknown }>;
  assert.equal(props['lalog.opencode.activity.enabled'].default, true, 'on by default; one setting turns it off');
  assert.match(
    String(props['lalog.opencode.activity.url'].default),
    /^http:\/\/127\.0\.0\.1:\d+$/,
    'the polled URL is localhost by default'
  );
  // ADR-033 lifecycle settings, all conservative by default.
  assert.equal(props['lalog.opencode.activity.manageServe'].default, true, 'reuse-or-spawn');
  assert.equal(props['lalog.opencode.activity.spawnPort'].default, 0, 'opencode picks the port');
  assert.equal(props['lalog.opencode.activity.opencodePath'].default, 'opencode');
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