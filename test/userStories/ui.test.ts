import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { setupHarness, setupExtension, resolvePanel, mockWebviewView, flush, waitFor } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import { LaLogStatusBar } from '../../src/ui/statusBar';
import { SessionStore } from '../../src/storage/sessionStore';
import { workspaceKey } from '../../src/storage/store';

function lastState(): any {
  const msgs = mockVscode._webviewMessages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === 'state') return msgs[i];
  }
  return null;
}

function lastStatusBarItem(): any {
  const items = mockVscode._statusBarItems;
  return items[items.length - 1];
}

test('US-4.1 · status bar shows today total when no active session', () => {
  const sb = new LaLogStatusBar(() => {});
  sb.update(null, 90 * 60 * 1000, 5 * 60 * 1000);
  const item = lastStatusBarItem();
  assert.ok(item.text.includes('today'), `text: ${item.text}`);
  assert.ok(item.tooltip.includes('1h 30m today'), `tooltip: ${item.tooltip}`);
  assert.ok(item.tooltip.includes('5m untracked'), `tooltip: ${item.tooltip}`);
});

test('US-4.1 · status bar shows active session context', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(30);
  const s = h.manager.getSession()!;
  s.description = 'fixing auth';
  const sb = new LaLogStatusBar(() => {});
  sb.update(s, 30 * 60 * 1000, 0, false);
  const item = lastStatusBarItem();
  assert.ok(item.text.includes('$(play)'), `text: ${item.text}`);
  assert.ok(item.text.includes('fixing auth'), `text: ${item.text}`);
  assert.ok(item.tooltip.includes('today'), `tooltip: ${item.tooltip}`);
});

test('US-4.2 · quick actions map to commands', async (t) => {
  const ext = await setupExtension(t);
  const wsPath = path.join(ext.paths.dataDir, 'workspace');
  const wsKey = workspaceKey(wsPath);
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const provider = mockVscode._webviewProvider;
  provider.resolveWebviewView(mockWebviewView());
  await flush();

  // Describe
  mockVscode.queueQuickPick('describe');
  mockVscode.queueInputBox('quick desc');
  mockVscode.queueQuickPick('feature');
  await mockVscode.commands.executeCommand('lalog.statusAction');
  await flush();
  assert.equal(store.loadActive(wsKey)!.description, 'quick desc');

  // Pause
  mockVscode.queueQuickPick('pause');
  await mockVscode.commands.executeCommand('lalog.statusAction');
  await waitFor(() => lastState()?.paused === true);

  // Resume
  mockVscode.queueQuickPick('resume');
  await mockVscode.commands.executeCommand('lalog.statusAction');
  await waitFor(() => lastState()?.paused === false);

  // Background
  mockVscode.queueQuickPick('background');
  await mockVscode.commands.executeCommand('lalog.statusAction');
  await waitFor(() => lastState()?.active?.anonymous === true);

  // End & restart
  mockVscode.queueQuickPick('end');
  await mockVscode.commands.executeCommand('lalog.statusAction');
  await flush();
  const all = await store.loadAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].closedReason, 'user');
  assert.ok(store.loadActive(wsKey), 'fresh session started');

  // Report
  mockVscode.queueQuickPick('report');
  mockVscode.queueQuickPick('today');
  mockVscode.queueQuickPick('');
  await mockVscode.commands.executeCommand('lalog.statusAction');
  await waitFor(() => fs.readdirSync(ext.paths.reportsDir).length >= 1);
  const reports = fs.readdirSync(ext.paths.reportsDir);
  assert.ok(reports.length >= 1, 'report file written');

  // CSV
  mockVscode.queueQuickPick('csv');
  await mockVscode.commands.executeCommand('lalog.statusAction');
  await waitFor(() => fs.readdirSync(ext.paths.exportsDir).some((f) => f.endsWith('.csv')));
  const exports = fs.readdirSync(ext.paths.exportsDir);
  assert.ok(exports.some((f) => f.endsWith('.csv')), 'csv written');
});

test('US-4.3 · sessions grouped by day, newest first', async (t) => {
  const h = setupHarness(t);
  t.mock.timers.setTime(Date.parse('2026-09-20T10:00:00'));
  await h.start();
  await h.edit('/ws/a.ts');
  await h.manager.endSession('user');
  t.mock.timers.setTime(Date.parse('2026-09-21T09:30:00'));
  await h.edit('/ws/b.ts');
  await h.manager.endSession('user');
  resolvePanel(h);
  await waitFor(() => lastState() !== null);
  const state = lastState();
  assert.equal(state.groups.length, 2);
  assert.equal(state.groups[0].day, '2026-09-21', 'newest day first');
  assert.equal(state.groups[1].day, '2026-09-20');
  assert.equal(state.groups[0].count, 1);
  assert.equal(state.groups[0].sessions.length, 1);
  assert.equal(state.groups[0].sessions[0].workspaceName, h.wsName);
  assert.ok(state.groups[0].sessions[0].startedAt > state.groups[1].sessions[0].startedAt);
});

test('US-4.4 · session detail includes split, type, reason, events, files, notes, git', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(30);
  const s = h.manager.getSession()!;
  s.description = 'drill down';
  s.type = 'feature';
  s.gitBranch = 'main';
  s.commits = [{ hash: 'abc1234', subject: 'Add thing' }];
  s.notes.push({ at: Date.now(), text: 'a note' });
  await h.manager.endSession('user');
  resolvePanel(h);
  await waitFor(() => lastState() !== null);
  const state = lastState();
  const summary = state.groups[0].sessions[0];
  assert.equal(summary.description, 'drill down');
  assert.equal(summary.type, 'feature');
  assert.equal(summary.closedReason, 'user');
  assert.equal(summary.gitBranch, 'main');
  assert.equal(summary.commits.length, 1);
  assert.equal(summary.notes.length, 1);
  assert.ok(summary.split.totalMs > 0);
  assert.ok(summary.events.edits >= 1);
  assert.ok(summary.events.topFiles.length >= 1);
  assert.ok(summary.startedAt <= summary.endedAt!);
});

test('US-4.4 · detail actions: assign project and background toggle', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(10);
  const { view, registry } = resolvePanel(h);
  await flush();
  const proj = registry.create({ name: 'Client A', workspaceKey: h.wsKey });
  mockVscode.queueQuickPick(proj.id);
  view._post({ type: 'assign', id: h.manager.getSession()!.id });
  await flush();
  assert.equal(h.manager.getSession()!.projectId, proj.id);
  await h.manager.endSession('user');
  const closed = (await h.closedSessions())[0];
  view._post({ type: 'markAnonymous', id: closed.id, value: true });
  await waitFor(() => {
    const raw = fs.readFileSync(path.join(h.dir, 'sessions.jsonl'), 'utf8');
    return raw.includes('"anonymous":true');
  });
  const updated = (await h.closedSessions())[0];
  assert.equal(updated.anonymous, true);
});

test('US-4.5 · Now box data and buttons', async (t) => {
  const ext = await setupExtension(t);
  const provider = mockVscode._webviewProvider;
  const view = mockWebviewView();
  provider.resolveWebviewView(view);
  await flush();
  mockVscode.queueInputBox('now box');
  mockVscode.queueQuickPick('feature');
  await mockVscode.commands.executeCommand('lalog.describeNow');
  await flush();
  const state = lastState();
  assert.ok(state.active, 'live session summarized');
  assert.equal(state.active.description, 'now box');
  assert.equal(state.paused, false);
  assert.ok(state.idleGap > 0, 'idle gap cap provided');
  assert.ok(typeof state.todayActiveMs === 'number');
  view._post({ type: 'pause' });
  await flush();
  assert.equal(lastState().paused, true);
  view._post({ type: 'resume' });
  await flush();
  assert.equal(lastState().paused, false);
  view._post({ type: 'end' });
  await flush();
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const all = await store.loadAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].closedReason, 'user');
  assert.ok(store.loadActive(workspaceKey(path.join(ext.paths.dataDir, 'workspace'))), 'fresh session after End');
});

test('US-4.6 · project filter logic over the sessions list', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(10);
  const { provider, registry } = resolvePanel(h);
  const proj = registry.create({ name: 'Client A' });
  h.manager.assignProject(proj.id);
  await h.manager.endSession('user');
  await h.edit('/ws/other.ts');
  await h.manager.endSession('user');
  provider.refresh();
  await waitFor(() => {
    const st = lastState();
    return st && st.groups.flatMap((g: any) => g.sessions).length === 2;
  });
  const state = lastState();
  assert.ok(state.projects.some((p: any) => p.id === proj.id), 'chips include the project');
  const sessions = state.groups.flatMap((g: any) => g.sessions);
  assert.equal(sessions.length, 2);
  const assigned = sessions.find((s: any) => s.projectId === proj.id);
  const unassigned = sessions.find((s: any) => !s.projectId);
  assert.ok(assigned && unassigned);
  // Replicate the webview's matchesFilter (DOM chips are not host-testable).
  const matchesFilter = (s: any, f: string | null) => {
    if (!f) return true;
    if (f === 'unassigned') return !s.projectId;
    return s.projectId === f;
  };
  assert.equal(sessions.filter((s: any) => matchesFilter(s, null)).length, 2);
  assert.equal(sessions.filter((s: any) => matchesFilter(s, proj.id)).length, 1);
  assert.equal(sessions.filter((s: any) => matchesFilter(s, 'unassigned')).length, 1);
});

async function seedClosedSession(t: any, ext: any, file: string): Promise<void> {
  mockVscode.fireEdit(file);
  t.mock.timers.tick(2000);
  await flush();
  await mockVscode.commands.executeCommand('lalog.endSession');
  await flush();
}

test('US-4.7 · delete a session from the panel with confirmation', async (t) => {
  const ext = await setupExtension(t);
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  await seedClosedSession(t, ext, '/ws/a.ts');
  await seedClosedSession(t, ext, '/ws/b.ts');
  const all = await store.loadAll();
  assert.equal(all.length, 2);
  const target = all[0];

  // A stale duplicate line for the same id must be removed too.
  fs.appendFileSync(ext.paths.sessionsFile, JSON.stringify(target) + '\n');
  const sidecar = path.join(ext.paths.technicalDir, target.id + '.jsonl');
  fs.writeFileSync(sidecar, '{"type":"terminal"}\n');

  const provider = mockVscode._webviewProvider;
  const view = mockWebviewView();
  provider.resolveWebviewView(view);
  await waitFor(() => lastState() !== null);
  const before = lastState();
  assert.ok(before.groups.flatMap((g: any) => g.sessions).some((s: any) => s.id === target.id));
  const todayBefore = before.todayActiveMs;

  mockVscode.queueWarningChoice('Delete');
  view._post({ type: 'delete', id: target.id });
  await waitFor(() => !fs.readFileSync(ext.paths.sessionsFile, 'utf8').includes(target.id));

  const remaining = await store.loadAll();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, all[1].id, 'other session untouched');
  assert.equal(fs.existsSync(sidecar), false, 'technical sidecar deleted');
  assert.equal(mockVscode._warningCalls[0].options?.modal, true);
  assert.ok(mockVscode._warningCalls[0].buttons.includes('Delete'));
  await waitFor(() => {
    const st = lastState();
    return (
      st &&
      !st.groups.flatMap((g: any) => g.sessions).some((s: any) => s.id === target.id) &&
      st.todayActiveMs === todayBefore - target.activeMinutes
    );
  });
  assert.equal(lastState().todayActiveMs, todayBefore - target.activeMinutes);
});

test('US-4.7 · cancel delete is a no-op', async (t) => {
  const ext = await setupExtension(t);
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  await seedClosedSession(t, ext, '/ws/a.ts');
  const all = await store.loadAll();
  assert.equal(all.length, 1);
  const target = all[0];
  const sidecar = path.join(ext.paths.technicalDir, target.id + '.jsonl');
  fs.writeFileSync(sidecar, '{"type":"terminal"}\n');

  const provider = mockVscode._webviewProvider;
  const view = mockWebviewView();
  provider.resolveWebviewView(view);
  await waitFor(() => lastState() !== null);

  mockVscode.queueWarningChoice(undefined);
  view._post({ type: 'delete', id: target.id });
  await waitFor(() => mockVscode._warningCalls.length === 1);
  await flush();
  assert.equal(mockVscode._warningCalls.length, 1, 'confirm was shown');
  assert.ok(fs.readFileSync(ext.paths.sessionsFile, 'utf8').includes(target.id));
  assert.equal((await store.loadAll()).length, 1);
  assert.equal(fs.existsSync(sidecar), true, 'sidecar kept');
  assert.ok(lastState().groups.flatMap((g: any) => g.sessions).some((s: any) => s.id === target.id));
});

test('US-4.7 · live session and unknown ids are not deletable', async (t) => {
  const ext = await setupExtension(t);
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const wsKey = workspaceKey(path.join(ext.paths.dataDir, 'workspace'));
  await seedClosedSession(t, ext, '/ws/a.ts');
  const closed = await store.loadAll();
  assert.equal(closed.length, 1);

  mockVscode.fireEdit('/ws/c.ts');
  t.mock.timers.tick(2000);
  await flush();
  const live = store.loadActive(wsKey)!;
  assert.ok(live, 'live session exists');

  const provider = mockVscode._webviewProvider;
  const view = mockWebviewView();
  provider.resolveWebviewView(view);
  await waitFor(() => lastState() !== null);

  view._post({ type: 'delete', id: live.id });
  await waitFor(() => mockVscode._infoMessages.some((m) => m.includes('End the session first')));
  assert.equal(mockVscode._warningCalls.length, 0, 'no confirm for the live session');
  assert.equal(
    fs.readFileSync(ext.paths.sessionsFile, 'utf8').split('\n').filter(Boolean).length,
    1
  );
  assert.ok(store.loadActive(wsKey), 'live session still tracked');

  view._post({ type: 'delete', id: '20260101-0000-zzzz-ffff' });
  await mockVscode.commands.executeCommand('lalog.deleteSession');
  await waitFor(() => mockVscode._infoMessages.some((m) => m.includes('Sessions panel')));
  await flush();
  assert.equal(mockVscode._warningCalls.length, 0, 'unknown id is a silent no-op');
  assert.equal(
    fs.readFileSync(ext.paths.sessionsFile, 'utf8').split('\n').filter(Boolean).length,
    1
  );
});