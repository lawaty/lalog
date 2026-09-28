import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupHarness, defaultConfig, flush, waitFor } from '../helpers/harness';
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