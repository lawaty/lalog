import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupHarness, createHarness, defaultConfig, flush, waitFor, setupExtension } from '../helpers/harness';
import { buildPaths, ensureDirs, workspaceKey } from '../../src/storage/store';
import { SessionStore } from '../../src/storage/sessionStore';
import { SessionManager } from '../../src/core/sessionManager';
import { thresholdsMs } from '../../src/core/config';
import { mockVscode } from '../helpers/mockVscode';
import type { Session } from '../../src/core/types';

test('regression · loadAll dedupes duplicate ids (never list/count a session twice)', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(60);
  const first = h.manager.getSession()!;
  first.description = 'dup test';
  await h.manager.endSession('user');
  // Simulate an old-version artifact: the same closed session appended twice.
  const file = path.join(h.dir, 'sessions.jsonl');
  const line = fs.readFileSync(file, 'utf8').trim();
  fs.writeFileSync(file, line + '\n' + line + '\n');
  const all = await h.store.loadAll();
  assert.equal(all.length, 1, 'one distinct session returned for the list');
  assert.equal(all[0].id, first.id);
  const counted = all.reduce((sum, s) => sum + s.activeMinutes, 0);
  assert.equal(counted, first.activeMinutes, 'active time counted once');
});

test('regression · leftover snapshot that is already recorded is dropped, not re-appended', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-dedup-'));
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const th = thresholdsMs(defaultConfig());
  const store = new SessionStore({ paths, th });
  const wsPath = path.join(dir, 'workspace');
  fs.mkdirSync(wsPath, { recursive: true });
  const wsKey = workspaceKey(wsPath);
  // A close that appended its line but failed to remove the snapshot (crash edge).
  const s = store.newSession(wsKey, 'workspace', 1000);
  s.activeMinutes = 60_000; // over the 30s floor, so this close really appends
  s.lastActivityAt = 5000;
  await store.close(s, 'vscode-shutdown', 5000);
  store.saveActive(s); // stale snapshot with the SAME id remains
  mockVscode.setWorkspaceFolders([wsPath]);
  const manager = new SessionManager(store, th, paths, defaultConfig());
  manager.start();
  await waitFor(() => manager.getSession() !== null);
  const all = await store.loadAll();
  assert.equal(all.length, 1, 'session not recorded twice');
  assert.equal(all[0].id, s.id);
  assert.equal(all[0].closedReason, 'vscode-shutdown', 'only the original close recorded');
  const loaded = store.loadActive(wsKey);
  assert.ok(loaded, 'a fresh snapshot exists');
  assert.notEqual(loaded!.id, s.id, 'stale snapshot replaced, not duplicated');
  const cur = manager.getSession();
  assert.notEqual(cur!.id, s.id, 'a fresh session starts');
  manager.dispose();
  t.mock.timers.reset();
  mockVscode.reset();
});

test('regression · genuine stale snapshot still recovers exactly once', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-recover-'));
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const th = thresholdsMs(defaultConfig());
  const store = new SessionStore({ paths, th });
  const wsPath = path.join(dir, 'workspace');
  fs.mkdirSync(wsPath, { recursive: true });
  const wsKey = workspaceKey(wsPath);
  const orphan = store.newSession(wsKey, 'workspace', 1000);
  orphan.activeMinutes = 60_000; // over the 30s floor, so recovery records it
  orphan.lastActivityAt = 5000;
  store.saveActive(orphan); // abnormal exit: leftover snapshot, NOT yet recorded
  mockVscode.setWorkspaceFolders([wsPath]);
  const manager = new SessionManager(store, th, paths, defaultConfig());
  manager.start();
  await waitFor(() => manager.getSession() !== null);
  const all = await store.loadAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, orphan.id);
  assert.equal(all[0].closedReason, 'recovery-skip');
  assert.equal(mockVscode.promptCalls().length, 0, 'no prompt about the recovered session');
  manager.dispose();
  t.mock.timers.reset();
  mockVscode.reset();
});

// ---- US-8.8 · a session too short to display is dropped, not written as "0m" ----
// `h.work(n)` fires ceil(n/5) edits 5s apart, so the session ends with
// (steps - 1) * 5s of active time: work(30) = 25s, work(35) = 30s, work(40) = 35s.

test('US-8.8 · a session under 30s of active time is not appended to sessions.jsonl', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(30); // 25s — would render as "0m"
  const s = h.manager.getSession()!;
  assert.equal(s.activeMinutes, 25_000, 'the fixture really is below the 30s floor');
  await h.manager.endSession('user');
  assert.deepEqual(await h.closedSessions(), [], 'nothing was appended to sessions.jsonl');
  assert.equal(
    fs.existsSync(h.paths.sessionsFile) ? fs.readFileSync(h.paths.sessionsFile, 'utf8') : '',
    '',
    'the close wrote no line — the file was never even created'
  );
});

test('US-8.8 · exactly 30s is saved (the boundary is inclusive)', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(35); // 30s exactly
  const s = h.manager.getSession()!;
  assert.equal(s.activeMinutes, 30_000, 'the fixture sits exactly on the floor');
  await h.manager.endSession('user');
  const closed = await h.closedSessions();
  assert.equal(closed.length, 1, '30s is kept, not dropped');
  assert.equal(closed[0].id, s.id);
  assert.equal(closed[0].activeMinutes, 30_000, 'recorded verbatim, not rounded');
});

test('US-8.8 · the drop path still removes the active snapshot (no recovery resurrection)', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(30); // 25s — a close that gets dropped
  const dropped = h.manager.getSession()!;
  assert.ok(h.activeSnapshot(), 'the session is snapshotted while it is active');

  await h.manager.endSession('user');
  assert.equal(h.activeSnapshot(), null, 'the snapshot is gone even though the close was dropped');
  assert.deepEqual(await h.closedSessions(), [], 'and nothing was recorded instead');

  // A surviving snapshot would be re-loaded by loadActive on the next launch and
  // re-enter recovery — dropped again, forever. Reopening the same data dir proves
  // it does not come back.
  h.dispose();
  const h2 = createHarness(t, { dir: h.dir });
  await h2.start();
  assert.deepEqual(await h2.closedSessions(), [], 'the dropped session never reappears');
  const reopened = h2.activeSnapshot();
  assert.ok(reopened, 'a fresh session is tracked instead');
  assert.notEqual(reopened!.id, dropped.id, 'the fresh session is not the dropped one');
  h2.dispose();
});

test('US-8.8 · a normal session well over 30s is unaffected', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(40); // 35s
  const s = h.manager.getSession()!;
  assert.equal(s.activeMinutes, 35_000);
  await h.manager.endSession('user');
  const closed = await h.closedSessions();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, s.id);
  assert.equal(closed[0].closedReason, 'user');
  assert.equal(closed[0].activeMinutes, 35_000, 'nothing about the record is changed by the guard');
  assert.equal(closed[0].events.edits, s.events.edits, 'counters survive untouched');
  assert.equal(h.activeSnapshot(), null, 'the snapshot is removed as it always was');
});

// ---- US-8.9 · one-time backfill: the "0m" rows recorded before the floor ----
// Hand-written JSONL, the same recipe as the tests above: a temp dir, a real
// SessionStore over it, and rows laid down verbatim so the byte-level claims
// (what survives untouched, what the .bak holds) are actually provable.

/** A closed-session line shaped like the ones `close` appends. */
function row(activeMinutes: number, extra: Partial<Session> = {}): string {
  const startedAt = Date.parse('2026-09-21T09:00:00');
  return JSON.stringify({
    id: '20260921-0900-abcd-ef01',
    workspaceKey: 'ws1',
    workspaceName: 'workspace',
    startedAt,
    lastActivityAt: startedAt + 30 * 60_000,
    activeMinutes,
    endedAt: startedAt + 30 * 60_000,
    closedReason: 'auto-idle',
    notes: [],
    needsDescription: false,
    events: { edits: 1, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, opencode: 0, topFiles: [] },
    activeSpans: [],
    activityTs: [startedAt],
    ...extra,
  });
}

/**
 * A SessionStore over a fresh temp dir holding a hand-written sessions.jsonl.
 * `onPruneFiltered` reaches the store's test seam with the file it is pruning —
 * the only way to reproduce the concurrent-append window, which is a few
 * microseconds wide inside a synchronous method.
 */
function storeWith(
  lines?: string[],
  onPruneFiltered?: (sessionsFile: string) => void
): { store: SessionStore; dir: string; sessionsFile: string; bakFile: string; read: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-prune-'));
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const store = new SessionStore({
    paths,
    th: thresholdsMs(defaultConfig()),
    onPruneFiltered: onPruneFiltered ? () => onPruneFiltered(paths.sessionsFile) : undefined,
  });
  if (lines) fs.writeFileSync(paths.sessionsFile, lines.join('\n') + '\n');
  return {
    store,
    dir,
    sessionsFile: paths.sessionsFile,
    bakFile: paths.sessionsFile + '.pre-prune-short.bak',
    read: () => fs.readFileSync(paths.sessionsFile, 'utf8'),
  };
}

test('US-8.9 · sub-30s rows are removed and every other line survives byte-identical', async () => {
  const phantomIdle = row(0, { id: 'phantom-auto-idle' });
  const phantomShutdown = row(12_345, { id: 'phantom-vscode-shutdown' });
  const onTheFloor = row(30_000, { id: 'keep-exactly-30s' });
  const real = row(3_600_000, { id: 'keep-an-hour' });
  const fx = storeWith([phantomIdle, phantomShutdown, onTheFloor, real]);

  assert.equal(fx.store.pruneShortSessions(), 2, 'both phantom rows counted as removed');
  assert.equal(
    fx.read(),
    onTheFloor + '\n' + real + '\n',
    'the sub-floor lines are gone; every other line is byte-identical'
  );
  assert.ok(fx.read().includes(onTheFloor), 'exactly 30s is kept, same as close() decides');
  const kept = await fx.store.loadAll();
  assert.deepEqual(
    kept.map((s) => s.id),
    ['keep-exactly-30s', 'keep-an-hour'],
    'and the pruned history still loads as ordinary sessions'
  );
});

test('US-8.9 · the one-time .bak holds the complete original history', () => {
  const original = [row(0, { id: 'phantom' }), row(45_000, { id: 'keeper' })];
  const fx = storeWith(original);

  assert.equal(fx.store.pruneShortSessions(), 1);
  assert.ok(fs.existsSync(fx.bakFile), 'a backup was written before the rewrite');
  assert.equal(fs.readFileSync(fx.bakFile, 'utf8'), original.join('\n') + '\n', 'it is the complete original');
  assert.equal(fx.read(), row(45_000, { id: 'keeper' }) + '\n', 'and the live file holds only what survived');
});

test('US-8.9 · a second run removes nothing, rewrites nothing, and never clobbers the .bak', () => {
  const fx = storeWith([row(0, { id: 'phantom' }), row(45_000, { id: 'keeper' })]);
  assert.equal(fx.store.pruneShortSessions(), 1);
  const afterFirstRun = fx.read();
  const originalBackup = fs.readFileSync(fx.bakFile, 'utf8');

  assert.equal(fx.store.pruneShortSessions(), 0, 'nothing left to prune');
  assert.equal(fx.read(), afterFirstRun, 'the file is left exactly as it was');

  // A later run that DOES have work must still keep the true original: the
  // backup is written once, not refreshed per run.
  fs.appendFileSync(fx.sessionsFile, row(0, { id: 'later-phantom' }) + '\n');
  assert.equal(fx.store.pruneShortSessions(), 1);
  assert.equal(
    fs.readFileSync(fx.bakFile, 'utf8'),
    originalBackup,
    'the pre-first-run history survives — the .bak is written once and never overwritten'
  );
});

test('US-8.9 · blank, malformed, and unjudgeable lines are all preserved verbatim', () => {
  const broken = '{"id":"truncated","activeMinutes":';
  const noActiveMinutes = '{"id":"legacy-line-without-active-minutes"}';
  const keeper = row(45_000, { id: 'keeper' });
  const original = [row(0, { id: 'phantom' }), '', broken, noActiveMinutes, keeper];
  const fx = storeWith(original);

  assert.equal(fx.store.pruneShortSessions(), 1);
  assert.equal(
    fx.read(),
    ['', broken, noActiveMinutes, keeper].join('\n') + '\n',
    'nothing but the judged phantom row is dropped — a line we cannot judge is never deleted'
  );
});

test('US-8.9 · both lines of a duplicated sub-30s id are dropped', () => {
  const dupA = row(0, { id: 'dup' });
  const dupB = row(4_000, { id: 'dup' });
  const keeper = row(45_000, { id: 'keeper' });
  const fx = storeWith([dupA, dupB, keeper]);

  assert.equal(fx.store.pruneShortSessions(), 2, 'raw-line semantics: no dedupe, so both go');
  assert.equal(fx.read(), keeper + '\n');
  assert.ok(
    fs.readFileSync(fx.bakFile, 'utf8').includes(dupA) && fs.readFileSync(fx.bakFile, 'utf8').includes(dupB),
    'the .bak still holds both duplicate lines, exactly as the original did'
  );
});

test('US-8.9 · a stray .tmp from an interrupted write is cleaned up', () => {
  const fx = storeWith([row(0, { id: 'phantom' }), row(45_000, { id: 'keeper' })]);
  fs.writeFileSync(fx.sessionsFile + '.tmp', 'half-written garbage');

  assert.equal(fx.store.pruneShortSessions(), 1);
  assert.equal(fs.existsSync(fx.sessionsFile + '.tmp'), false, 'the stray tmp is gone');
  assert.equal(fx.read(), row(45_000, { id: 'keeper' }) + '\n');
});

test('US-8.9 · with no sessions file at all the prune is a silent no-op', () => {
  const fx = storeWith(); // nothing ever written

  assert.equal(fx.store.pruneShortSessions(), 0, 'returns 0 and throws nothing');
  assert.equal(fs.existsSync(fx.sessionsFile), false, 'and it does not create the file');
  assert.equal(fs.existsSync(fx.bakFile), false, 'nor a backup of nothing');
});

test('US-8.9 · a history with nothing to prune is not rewritten', () => {
  const lines = [row(30_000, { id: 'a' }), row(45_000, { id: 'b' })];
  const fx = storeWith(lines);
  const before = fs.statSync(fx.sessionsFile);
  // Pin the mtime far in the past so a same-millisecond rewrite cannot hide.
  fs.utimesSync(fx.sessionsFile, new Date(1_000_000), new Date(1_000_000));
  const pinned = fs.statSync(fx.sessionsFile);

  assert.equal(fx.store.pruneShortSessions(), 0);
  assert.equal(fx.read(), lines.join('\n') + '\n', 'content untouched');
  assert.equal(fs.statSync(fx.sessionsFile).mtimeMs, pinned.mtimeMs, 'the file was not rewritten');
  assert.notEqual(before.mtimeMs, pinned.mtimeMs, 'the fixture really did move the mtime');
  assert.equal(fs.existsSync(fx.bakFile), false, 'and no backup is taken of an untouched file');
});

test('US-8.9 · a file that changed mid-prune is skipped, never truncated', () => {
  const phantom = row(0, { id: 'phantom' });
  const keeper = row(45_000, { id: 'keeper' });
  // A second window sharing this dataDir closes a session while we are filtering.
  const fx = storeWith([phantom, keeper], (sessionsFile) => {
    fs.appendFileSync(sessionsFile, row(90_000, { id: 'other-window' }) + '\n');
  });

  assert.equal(fx.store.pruneShortSessions(), 0, 'the rewrite is abandoned');
  assert.equal(
    fx.read(),
    [phantom, keeper, row(90_000, { id: 'other-window' })].join('\n') + '\n',
    'the concurrent append survives, and nothing was pruned on a stale read'
  );
  assert.equal(fs.existsSync(fx.bakFile), false, 'no backup of a file we did not rewrite');
  assert.equal(fs.existsSync(fx.sessionsFile + '.tmp'), false, 'and no half-written tmp left behind');

  // Next activation, uncontended, prunes it for real.
  const retry = new SessionStore({ paths: buildPaths(fx.dir), th: thresholdsMs(defaultConfig()) });
  assert.equal(retry.pruneShortSessions(), 1, 'an uncontended retry prunes it');
  assert.ok(!fx.read().includes(phantom), 'and the other window\'s row is untouched');
});

test('US-8.9 · the re-stat guard also fires when only the mtime moved', () => {
  const phantom = row(0, { id: 'phantom' });
  const keeper = row(45_000, { id: 'keeper' });
  // Same byte length, new mtime — the size half of the guard cannot catch this.
  const fx = storeWith([phantom, keeper], (sessionsFile) => {
    fs.writeFileSync(sessionsFile, fs.readFileSync(sessionsFile, 'utf8').replace('keeper', 'keepER'));
  });

  assert.equal(fx.store.pruneShortSessions(), 0, 'the rewrite is abandoned');
  assert.equal(fs.statSync(fx.sessionsFile).size, (phantom + '\n' + keeper + '\n').length, 'the size really is unchanged');
  assert.ok(fx.read().includes('keepER'), 'the concurrent rewrite survives intact');
});

test('US-8.9 · activation prunes the old rows — silently, before tracking starts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-prune-ext-'));
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const phantom = row(0, { id: 'phantom-before-the-floor' });
  const keeper = row(45_000, { id: 'keeper-before-the-floor' });
  fs.writeFileSync(paths.sessionsFile, [phantom, keeper].join('\n') + '\n');

  const ext = await setupExtension(t, { dir });

  assert.equal(fs.readFileSync(ext.paths.sessionsFile, 'utf8'), keeper + '\n', 'the old "0m" row is gone');
  assert.ok(
    fs.readFileSync(ext.paths.sessionsFile + '.pre-prune-short.bak', 'utf8').includes(phantom),
    'the original history was backed up first'
  );
  assert.equal(mockVscode.promptCalls().length, 0, 'nothing is asked about a closed session');
});

test('US-8.9 · activation still succeeds when the prune throws', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-prune-boom-'));
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const phantom = row(0, { id: 'phantom' });
  fs.writeFileSync(paths.sessionsFile, phantom + '\n');
  // A directory where the atomic write's scratch file goes makes the rewrite
  // fail with EISDIR — the one thing inside the sweep that can throw while the
  // rest of activate() still finds a perfectly readable sessions.jsonl.
  fs.mkdirSync(paths.sessionsFile + '.tmp');

  const ext = await setupExtension(t, { dir });

  assert.ok(ext.ctx.subscriptions.length > 0, 'activate() completed and wired its subscriptions');
  assert.equal(
    fs.readFileSync(ext.paths.sessionsFile, 'utf8'),
    phantom + '\n',
    'the failed prune left the history exactly as it found it'
  );
  assert.equal(mockVscode.promptCalls().length, 0, 'still no prompt about it');
});
