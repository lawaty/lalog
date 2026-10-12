import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupHarness, createHarness, defaultConfig, flush, waitFor } from '../helpers/harness';
import { buildPaths, ensureDirs, workspaceKey } from '../../src/storage/store';
import { SessionStore } from '../../src/storage/sessionStore';
import { SessionManager } from '../../src/core/sessionManager';
import { thresholdsMs } from '../../src/core/config';
import { mockVscode } from '../helpers/mockVscode';

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
