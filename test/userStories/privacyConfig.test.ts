import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupHarness, setupExtension, createHarness, defaultConfig, flush } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import { buildPaths, expandHome, ensureDirs } from '../../src/storage/store';
import { thresholdsMs, readConfig } from '../../src/core/config';
import { TechnicalStore } from '../../src/storage/technicalStore';
import { compileRedactPatterns, redactText } from '../../src/capture/redactText';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function srcText(except: string[] = []): string {
  return walk('src')
    .filter((f) => !except.some((x) => f.replace(/\\/g, '/').includes(x)))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

/**
 * The sanctioned network calls in src (US-7.2 / ADR-032 → ADR-033):
 * src/opencode/serveWatcher.ts does a read-only poll of a localhost `opencode
 * serve`, and src/opencode/serveProcess.ts is the lifecycle half — the same
 * localhost `fetch` when verifying a server, plus a loopback-only spawn of a
 * serve LaLog owns. Loopback-only and never off-limits: one setting turns it
 * off, and neither module ever reads message content or sends a prompt.
 */
const SERVE_WATCHER = 'opencode/serveWatcher.ts';
const SERVE_PROCESS = 'opencode/serveProcess.ts';
const OPENCODE_FILES = [SERVE_WATCHER, SERVE_PROCESS];

test('US-8.1 · all data stays under the data dir; no network code outside the opencode serve modules', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit();
  await h.manager.endSession('user');
  assert.ok(fs.existsSync(path.join(h.dir, 'sessions.jsonl')));
  assert.ok(fs.existsSync(path.join(h.dir, 'active')));
  assert.ok(fs.existsSync(path.join(h.dir, 'technical')));
  const all = srcText();
  assert.ok(!/fetch\s*\(/.test(srcText(OPENCODE_FILES)), 'no fetch() outside the opencode serve modules');
  assert.ok(!/\brequire\s*\(\s*['"](?:http|https|net|dgram|tls)['"]\s*\)/.test(all), 'no network modules');
  assert.ok(!/\bfrom\s+['"](?:http|https|net|dgram|tls)['"]/.test(all), 'no network imports');
  assert.ok(!/axios|node-fetch|undici/.test(all), 'no http client libs');
  // A serve LaLog starts is loopback-only and never leaves the machine.
  assert.ok(!/0\.0\.0\.0/.test(all), 'no routable bind anywhere in src');
  // The carve-out stays narrow and local: localhost only, and one setting away.
  const props = JSON.parse(fs.readFileSync('package.json', 'utf8')).contributes.configuration
    .properties as Record<string, { default?: unknown }>;
  assert.equal(props['lalog.opencode.activity.enabled'].default, true, 'on by default; one setting turns it off');
  assert.match(
    String(props['lalog.opencode.activity.url'].default),
    /^http:\/\/127\.0\.0\.1:\d+$/,
    'the polled URL is localhost by default'
  );
  assert.equal(
    props['lalog.opencode.activity.authPassword'].default,
    undefined,
    'no stored credential: unset makes LaLog generate a random password per serve'
  );
  assert.equal(
    props['lalog.opencode.activity.authPassword'].type,
    'string',
    'an explicit empty string remains the unsecured opt-out'
  );
  assert.equal(props['lalog.opencode.activity.spawnPort'].default, 0, 'opencode picks the port');
});

test('US-8.2 · dataDir is respected (tilde expands to home)', () => {
  const p = buildPaths('~/custom-lalog');
  assert.ok(p.dataDir.startsWith(os.homedir()));
  assert.ok(p.dataDir.endsWith('custom-lalog'));
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('/abs/path'), '/abs/path');
});

test('US-8.2 · extension writes everything under the configured dataDir', async (t) => {
  const ext = await setupExtension(t);
  mockVscode.fireEdit('/ws/a.ts');
  t.mock.timers.tick(2000);
  await flush();
  await mockVscode.commands.executeCommand('lalog.endSession');
  await flush();
  assert.ok(fs.existsSync(path.join(ext.paths.dataDir, 'sessions.jsonl')));
  assert.ok(fs.existsSync(path.join(ext.paths.dataDir, 'active')));
  assert.ok(fs.existsSync(path.join(ext.paths.dataDir, 'reports')));
  assert.ok(fs.existsSync(path.join(ext.paths.dataDir, 'exports')));
  assert.ok(fs.existsSync(path.join(ext.paths.dataDir, 'technical')));
});

test('US-8.3 · redaction replaces matches with [REDACTED] in commands, stdout, diffs', async (t) => {
  const h = setupHarness(t, { config: { captureTerminal: true, captureTerminalStdout: true, captureDiffs: true } });
  await h.start();
  const exec = h.terminalShellStart({
    commandLine: { value: 'export API_KEY=secret123', confidence: 'High', isTrusted: true },
    cwd: { fsPath: h.wsPath },
    read: async function* () { yield 'TOKEN output'; },
  });
  await h.flush();
  h.terminalShellEnd(exec, 0);
  await h.flush();
  mockVscode._openTextContent = 'const key = "TOKEN_VALUE";\n';
  h.save('/ws/secret.ts');
  await h.flush();
  const s = h.manager.getSession()!;
  const entries = new TechnicalStore(h.paths.technicalDir).read(s.id);
  const term = entries.find((e) => e.type === 'terminal') as any;
  assert.ok(term, 'terminal entry');
  assert.ok(!term.commandLine.includes('secret123'), 'command line redacted');
  assert.ok(term.commandLine.includes('[REDACTED]'));
  assert.ok(term.stdout && !term.stdout.includes('TOKEN'), 'stdout redacted');
  assert.ok(term.stdout.includes('[REDACTED]'));
  const diff = entries.find((e) => e.type === 'diff') as any;
  assert.ok(diff, 'diff entry');
  assert.ok(!diff.diff.includes('TOKEN_VALUE'), 'diff redacted');
  assert.ok(diff.diff.includes('[REDACTED]'));
});

test('US-8.3 · redactText: compile, invalid skip, case-insensitive global', () => {
  const pats = compileRedactPatterns(['TOKEN', '[invalid', 'secret']);
  assert.equal(pats.length, 2);
  assert.equal(redactText('my TOKEN and SECRET value', pats), 'my [REDACTED] and [REDACTED] value');
  assert.equal(redactText('key1 key2', compileRedactPatterns(['key'])), '[REDACTED]1 [REDACTED]2');
  assert.equal(redactText('hello', compileRedactPatterns(['NOMATCH'])), 'hello');
  assert.equal(redactText('hello', []), 'hello');
});

test('US-8.4 · closed sessions are append-only JSONL; active snapshot deleted on close', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit();
  const s = h.manager.getSession()!;
  assert.ok(fs.existsSync(h.store.snapshotPath(h.wsKey)), 'active snapshot exists');
  await h.manager.endSession('user');
  assert.ok(!fs.existsSync(h.store.snapshotPath(h.wsKey)), 'snapshot deleted on close');
  const raw = fs.readFileSync(path.join(h.dir, 'sessions.jsonl'), 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.id, s.id);
  assert.equal(parsed.closedReason, 'user');
});

test('US-8.4 · legacy sessions are normalized on read', async (t) => {
  const h = setupHarness(t);
  const legacy = {
    id: 'legacy',
    startedAt: 0,
    lastActivityAt: 0,
    activeMinutes: 0,
    notes: undefined,
    needsDescription: false,
    events: { edits: 3, saves: 1, terminal: 0, topFiles: [] },
  };
  fs.appendFileSync(path.join(h.dir, 'sessions.jsonl'), JSON.stringify(legacy) + '\n');
  const all = await h.closedSessions();
  assert.equal(all.length, 1);
  assert.ok(Array.isArray(all[0].activeSpans));
  assert.ok(Array.isArray(all[0].activityTs));
  assert.ok(Array.isArray(all[0].notes));
  assert.equal(all[0].events.fileops, 0);
  assert.equal(all[0].events.tasks, 0);
  assert.equal(all[0].events.debug, 0);
  assert.equal(all[0].events.edits, 3);
});

test('US-8.5 · capture toggles are honored', async (t) => {
  const h = setupHarness(t, { config: { captureDiffs: false, captureTerminal: false } });
  await h.start();
  mockVscode._openTextContent = 'line1\n';
  h.save('/ws/a.ts');
  const exec = h.terminalShellStart();
  h.terminalShellEnd(exec, 0);
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(new TechnicalStore(h.paths.technicalDir).read(s.id).length, 0, 'no entries when capture off');
  h.manager.dispose();

  const h2 = createHarness(t, { config: { captureDiffs: true, captureTerminal: true } });
  await h2.start();
  mockVscode._openTextContent = 'line1\n';
  h2.save('/ws/a.ts');
  const exec2 = h2.terminalShellStart();
  h2.terminalShellEnd(exec2, 0);
  await h2.flush();
  const s2 = h2.manager.getSession()!;
  assert.equal(new TechnicalStore(h2.paths.technicalDir).read(s2.id).length, 2, 'diff + terminal captured');
  h2.dispose();
});

test('US-8.6 · debugTimeScale divides all time thresholds consistently', () => {
  const base = thresholdsMs(defaultConfig({ debugTimeScale: 1 }));
  const scaled = thresholdsMs(defaultConfig({ debugTimeScale: 60 }));
  assert.equal(scaled.describeAt, Math.round(base.describeAt / 60));
  assert.equal(scaled.wrapAt, Math.round(base.wrapAt / 60));
  assert.equal(scaled.idleGap, Math.round(base.idleGap / 60));
  assert.equal(scaled.idleConfirm, Math.round(base.idleConfirm / 60));
  assert.equal(scaled.grace, Math.round(base.grace / 60));
  assert.equal(scaled.progressAt, Math.round(base.progressAt / 60));
  assert.equal(scaled.staleAfter, Math.round(base.staleAfter / 60));
  assert.equal(scaled.autoEndIdle, Math.round(base.autoEndIdle / 60));
  assert.equal(scaled.maxGraceExtensions, base.maxGraceExtensions, 'counts are not scaled');
});

test('US-8.7 · readConfig defaults diffRetentionDays to 14', () => {
  mockVscode.reset();
  assert.equal(readConfig().diffRetentionDays, 14);
});

/** Seed a sidecar for `id` with the given entries. */
function seedSidecar(
  paths: { technicalDir: string },
  id: string,
  entries: Record<string, unknown>[]
): string {
  const file = path.join(paths.technicalDir, id + '.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

/**
 * Activate against a caller-chosen data dir (setupExtension allocates its own
 * temp dir, which is too late to pre-seed sidecars in).
 */
async function activateAt(t: TestContext, dataDir: string, diffRetentionDays: number): Promise<void> {
  mockVscode.setConfig('lalog', { ...defaultConfig(), dataDir, diffRetentionDays });
  mockVscode.setConfig('lalog.ai', { enabled: false });
  const wsPath = path.join(dataDir, 'workspace');
  fs.mkdirSync(wsPath, { recursive: true });
  mockVscode.setWorkspaceFolders([wsPath]);
  const ctx = {
    subscriptions: [] as any[],
    globalState: { get: () => undefined, update: async () => undefined },
  };
  const { activate } = await import('../../src/extension');
  activate(ctx as any);
  await flush();
  t.after(async () => {
    for (const s of ctx.subscriptions) {
      try {
        s?.dispose?.();
      } catch {
        /* ignore */
      }
    }
    mockVscode.reset();
  });
}

const OLD_DIFF = {
  type: 'diff',
  ts: Date.parse('2026-01-02T10:00:00'),
  path: '/ws/a.ts',
  diff: '--- a\n+++ b\n+x',
  linesAdded: 1,
  linesRemoved: 0,
  newFile: false,
};
const OLD_TERMINAL = {
  type: 'terminal',
  ts: Date.parse('2026-01-02T10:00:00'),
  commandLine: 'npm test',
  exitCode: 0,
  durationMs: 1000,
  confidence: 'high',
};

test('US-8.7 · activation sweeps old diffs but keeps terminal entries', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(Date.parse('2026-09-21T09:00:00'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-sweep-'));
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const mixed = seedSidecar(paths, '20260102-0900-aaaa-bbbb', [OLD_DIFF, OLD_TERMINAL]);
  const allDiffs = seedSidecar(paths, '20260102-1000-cccc-dddd', [OLD_DIFF]);

  await activateAt(t, dir, 14);

  const kept = fs.readFileSync(mixed, 'utf8').split('\n').filter(Boolean);
  assert.equal(kept.length, 1, 'only the terminal entry survived the sweep');
  assert.equal(JSON.parse(kept[0]).type, 'terminal');
  assert.equal(fs.existsSync(allDiffs), false, 'an all-diff sidecar is deleted');
  t.mock.timers.reset();
});

test('US-8.7 · diffRetentionDays 0 keeps every diff', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(Date.parse('2026-09-21T09:00:00'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-sweep-keep-'));
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const file = seedSidecar(paths, '20260102-0900-aaaa-bbbb', [OLD_DIFF]);
  const before = fs.readFileSync(file, 'utf8');

  await activateAt(t, dir, 0);

  assert.equal(fs.existsSync(file), true, 'sidecar untouched when retention is off');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    before,
    'byte-identical — no rewrite happens when retention is off'
  );
  t.mock.timers.reset();
});
