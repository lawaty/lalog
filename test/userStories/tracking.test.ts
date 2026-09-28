import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupHarness, createHarness, defaultConfig, flush, BASE_TIME } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import { SessionStore } from '../../src/storage/sessionStore';
import { SessionManager } from '../../src/core/sessionManager';
import { buildPaths, ensureDirs, workspaceKey } from '../../src/storage/store';
import { thresholdsMs } from '../../src/core/config';
import { splitActiveMinutes } from '../../src/reporting/spans';
import { insightsFor, hourlyBreakdown } from '../../src/reporting/insights';
import { LaLogStatusBar } from '../../src/ui/statusBar';
import type { Session } from '../../src/core/types';
import { updateActiveSpan, trimToCutoff } from '../../src/core/spans';
import { isStale } from '../../src/core/stateMachine';

test('US-1.1 · auto-start tracking on open', async (t) => {
  const h = setupHarness(t);
  await h.start();
  const s = h.manager.getSession();
  assert.ok(s, 'a tracked session starts immediately');
  assert.equal(s!.workspaceKey, h.wsKey);
  assert.equal(s!.needsDescription, false);
  assert.equal(s!.events.edits, 0);
});

test('US-1.1 · recovery-skip of a leftover snapshot on reopen', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-recover-'));
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const th = thresholdsMs(defaultConfig());
  const store = new SessionStore({ paths, th });
  const wsPath = path.join(dir, 'workspace');
  fs.mkdirSync(wsPath, { recursive: true });
  const wsKey = workspaceKey(wsPath);
  const leftover = store.newSession(wsKey, 'workspace', 1000);
  leftover.lastActivityAt = 5000;
  store.saveActive(leftover);
  mockVscode.setWorkspaceFolders([wsPath]);
  const manager = new SessionManager(store, th, paths, defaultConfig());
  manager.start();
  await flush();
  const all = await store.loadAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].closedReason, 'recovery-skip');
  assert.equal(all[0].endedAt, 5000);
  assert.equal(all[0].needsDescription, true);
  const cur = manager.getSession();
  assert.ok(cur);
  assert.notEqual(cur!.id, leftover.id);
  assert.equal(mockVscode.promptCalls().length, 0, 'no prompt about the recovered session');
  manager.dispose();
  t.mock.timers.reset();
  mockVscode.reset();
});

test('US-1.1 · event after manual end starts a fresh session (never dropped)', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit();
  const first = h.manager.getSession()!;
  await h.manager.endSession('user');
  assert.equal(h.manager.getSession(), null);
  await h.edit();
  const s = h.manager.getSession()!;
  assert.ok(s);
  assert.notEqual(s.id, first.id);
  assert.equal(s.events.edits, 1, 'the event landed in the fresh session');
});

test('US-1.2 · gaps within idleGap count as active time', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(15); // 3 events, 2 gaps of 5s
  const s = h.manager.getSession()!;
  assert.equal(s.activeMinutes, 10 * 1000);
});

test('US-1.2 · idle gap not counted; endedAt = lastActivityAt', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(15);
  await h.tick(20_000); // 20s idle
  await h.edit();
  const s = h.manager.getSession()!;
  assert.equal(s.activeMinutes, 10 * 1000, 'the 20s gap is not counted');
  await h.manager.endSession('user');
  const closed = (await h.closedSessions())[0];
  assert.equal(closed.endedAt, closed.lastActivityAt);
  const spanSum = closed.activeSpans.reduce((sum, sp) => sum + (sp.end - sp.start), 0);
  assert.equal(spanSum, closed.activeMinutes);
});

test('US-1.3 · idle prompt fires after idleConfirm on the heartbeat', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  await h.start();
  await h.edit();
  mockVscode.queueQuickPick('active');
  await h.tick(60_000);
  await h.flush();
  assert.ok(
    mockVscode.promptCalls().some((c) => c.kind === 'quickPick' && c.title?.includes('Are you still there'))
  );
});

test('US-1.3 · "still working" counts idle as outside-VS-Code active', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  await h.start();
  await h.edit();
  mockVscode.queueQuickPick('active');
  await h.tick(60_000);
  await h.flush();
  const s = h.manager.getSession()!;
  assert.ok(s.activeMinutes >= 50 * 1000, `idle stretch counted, got ${s.activeMinutes}`);
  const bx = splitActiveMinutes(s, h.th.idleGap);
  assert.equal(bx.vscodeMs, 0);
  assert.ok(bx.outsideMs > 0);
});

test('US-1.3 · "I was away" trims and continues the same session', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  await h.start();
  await h.edit();
  mockVscode.queueQuickPick('away');
  await h.tick(60_000);
  await h.flush();
  const s = h.manager.getSession()!;
  assert.ok(s, 'session stays open');
  assert.equal(s.activeMinutes, 0, 'idle window trimmed');
  assert.ok(s.lastActivityAt >= 60 * 1000, 'resumes from now');
});

test('US-1.3 · "No, end" closes trimmed at the prompt moment + fresh starts', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  await h.start();
  h.editor();
  mockVscode.gateQuickPick();
  await h.tick(60_000); // prompt asked at 60s
  await h.flush();
  await h.tick(60_000); // answer arrives later
  await h.flush();
  mockVscode.releaseQuickPick('end');
  await h.flush();
  const closed = await h.closedSessions();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closedReason, 'user');
  assert.equal(closed[0].endedAt, BASE_TIME + 60 * 1000, 'trimmed to the prompt moment');
  await h.edit();
  assert.ok(h.manager.getSession(), 'fresh session starts on next event');
});

test('US-1.3 · showing the idle prompt does not mutate tracked state', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  await h.start();
  await h.work(15);
  const s = h.manager.getSession()!;
  const before = {
    activeMinutes: s.activeMinutes,
    activeSpans: JSON.stringify(s.activeSpans),
    activityTs: JSON.stringify(s.activityTs),
    lastActivityAt: s.lastActivityAt,
  };
  mockVscode.gateQuickPick();
  await h.tick(60_000);
  await h.flush();
  assert.ok(
    mockVscode.promptCalls().some((c) => c.kind === 'quickPick' && c.title?.includes('Are you still there')),
    'idle prompt shown'
  );
  assert.equal(s.activeMinutes, before.activeMinutes, 'activeMinutes unchanged');
  assert.equal(JSON.stringify(s.activeSpans), before.activeSpans, 'activeSpans unchanged');
  assert.equal(JSON.stringify(s.activityTs), before.activityTs, 'activityTs unchanged');
  assert.equal(s.lastActivityAt, before.lastActivityAt, 'lastActivityAt unchanged');
  mockVscode.releaseQuickPick('active');
  await h.flush();
  // Only now is the closed-span sum meaningful: while the run is still open it
  // lives in openSpanStart, not in activeSpans. Answering 'still working'
  // closes it and appends the confirmed idle span.
  const spanSum = s.activeSpans.reduce((sum, sp) => sum + (sp.end - sp.start), 0);
  assert.equal(spanSum, s.activeMinutes);
});

test('US-1.3 · "I was away" trims exactly the [prompt, response] window, not a fixed 15m', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  await h.start();
  await h.work(15);
  const s = h.manager.getSession()!;
  const preTotal = s.activeMinutes;
  mockVscode.gateQuickPick();
  await h.tick(60_000); // prompt asked at T_ask = BASE_TIME + 75s (heartbeat due at +60s
  await h.flush();     // is evaluated with the clock at the end of the tick window)
  const tAsk = BASE_TIME + 75 * 1000;
  await h.tick(3 * 60 * 1000); // respond 3 min later
  mockVscode.releaseQuickPick('away');
  await h.flush();
  const tResp = BASE_TIME + 255 * 1000;
  assert.equal(s.activeMinutes, preTotal, 'pre-prompt total preserved byte-for-byte');
  assert.equal(s.lastActivityAt, tResp, 'resumes from the response instant');
  assert.deepEqual(s.activeSpans, [{ start: BASE_TIME, end: BASE_TIME + 10 * 1000 }]);
  assert.ok(s.activeSpans.every((sp) => sp.end <= tAsk), 'no span extends past T_ask');
  assert.ok(s.activityTs.every((t) => t <= tAsk), 'no activityTs past T_ask');
  const spanSum = s.activeSpans.reduce((sum, sp) => sum + (sp.end - sp.start), 0);
  assert.equal(spanSum, s.activeMinutes);
  assert.notEqual(tResp - tAsk, 15 * 60 * 1000, 'window is not 15 minutes');
});

test('US-1.3 · "I was away" answered instantly trims ~0', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  await h.start();
  await h.work(15);
  const s = h.manager.getSession()!;
  const preTotal = s.activeMinutes;
  mockVscode.gateQuickPick();
  await h.tick(60_000);
  await h.flush();
  mockVscode.releaseQuickPick('away');
  await h.flush();
  assert.equal(s.activeMinutes, preTotal, 'nothing trimmed for an instant response');
  assert.equal(s.lastActivityAt, BASE_TIME + 75 * 1000, 'resumes at the response instant');
  const spanSum = s.activeSpans.reduce((sum, sp) => sum + (sp.end - sp.start), 0);
  assert.equal(spanSum, s.activeMinutes);
});

test('US-1.3 · "I was away" redacts the whole window even with activity between prompt and click', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  await h.start();
  await h.work(15);
  const s = h.manager.getSession()!;
  const preTotal = s.activeMinutes;
  mockVscode.gateQuickPick();
  await h.tick(60_000); // prompt at T_ask = +75s (see Test 2 on the tick window)
  await h.flush();
  const tAsk = BASE_TIME + 75 * 1000;
  await h.edit(); // event at +75s (gap > idleGap, not accrued)
  await h.tick(3000);
  await h.edit(); // event at +80s (accrues 5s)
  await h.tick(3000);
  await h.edit(); // event at +85s (accrues 5s)
  await h.tick(3 * 60 * 1000);
  const accruedBeforeResponse = s.activeMinutes;
  assert.ok(accruedBeforeResponse > preTotal, 'activity between prompt and click accrued time');
  mockVscode.releaseQuickPick('away');
  await h.flush();
  const tResp = BASE_TIME + 267 * 1000;
  assert.equal(s.activeMinutes, preTotal, 'the whole [T_ask, T_resp] window is redacted');
  assert.equal(s.lastActivityAt, tResp);
  assert.ok(s.activeSpans.every((sp) => sp.end <= tAsk));
  assert.ok(s.activityTs.every((t) => t <= tAsk));
  const spanSum = s.activeSpans.reduce((sum, sp) => sum + (sp.end - sp.start), 0);
  assert.equal(spanSum, s.activeMinutes);
});

// idleGap > heartbeat interval: the prompt can appear while the user's contiguous
// run is still open, so the pre-prompt run and the post-prompt run are one span.
// The trim must restore the prompt-time total rather than billing the open run
// up to T_ask — which would be a prompt-moment-sized phantom, the same class of
// bug as a fixed 15-minute adjustment.
test('US-1.3 · "I was away" never invents a threshold-sized amount when the pre-prompt run is still open', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 5, idleGapMinutes: 120 } });
  await h.start();
  h.editor(); // lastActivityAt = BASE_TIME, no time advance
  mockVscode.gateQuickPick();
  await h.tick(60_000); // heartbeat at +60s: idle 60s >= idleConfirm 5s -> prompt
  await h.flush();
  const tAsk = BASE_TIME + 60 * 1000;
  const s = h.manager.getSession()!;
  assert.equal(s.activeMinutes, 0, 'no gap observed yet, nothing accrued at prompt time');
  // Return, then keep typing. Every gap stays < idleGap 120s, so the run opened
  // at BASE_TIME is still open when the user finally clicks.
  await h.tick(7_000);
  h.editor(); // +67s: 67s gap < idleGap -> accrues, run stays open
  await h.tick(1_000);
  h.editor(); // +68s: accrues 1s
  assert.equal(s.activeMinutes, 68_000, 'post-prompt activity accrued');
  assert.deepEqual(s.activeSpans, [], 'still one open run, nothing closed yet');
  await h.tick(2_000);
  mockVscode.releaseQuickPick('away'); // respond at +70s
  await h.flush();
  const tResp = BASE_TIME + 70 * 1000;
  assert.equal(s.activeMinutes, 0, 'trim restores the prompt-time total, inventing nothing');
  assert.equal(s.lastActivityAt, tResp);
  assert.deepEqual(s.activityTs, [BASE_TIME], 'only the pre-prompt event survives');
  assert.deepEqual(s.activeSpans, [], 'a zero-length run is not turned into a span');
  const spanSum = s.activeSpans.reduce((sum, sp) => sum + (sp.end - sp.start), 0);
  assert.equal(spanSum, s.activeMinutes);
  assert.notEqual(tAsk, tResp, 'the away window is non-empty, it just was not billed');
});

test('US-1.3 · "Yes, still working" adds exactly the elapsed idle (7m13s), not 15m', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  await h.start();
  h.editor(); // lastActivityAt = BASE_TIME, no time advance
  mockVscode.gateQuickPick();
  await h.tick(60_000); // prompt at T_ask = +60s
  await h.flush();
  h.editor(); // activity at T_ask → lastActivityAt = +60s
  await h.tick(7 * 60 * 1000 + 13 * 1000); // 7m13s later
  mockVscode.releaseQuickPick('active');
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.activeMinutes, 7 * 60 * 1000 + 13 * 1000, 'added exactly 7m13s, not 15m');
  const bx = splitActiveMinutes(s, h.th.idleGap);
  assert.equal(bx.vscodeMs, 0, 'no VS Code time in the confirmed idle');
  assert.equal(bx.outsideMs, s.activeMinutes, '100% outside VS Code');
  const spanSum = s.activeSpans.reduce((sum, sp) => sum + (sp.end - sp.start), 0);
  assert.equal(spanSum, s.activeMinutes);
});

test('US-1.3 · non-default idleGap changes statusBar live-tail cap and legacy span reconstruction', async (t) => {
  const h = setupHarness(t, { config: { idleGapMinutes: 30 } });
  await h.start();
  await h.edit(); // lastActivityAt = BASE_TIME, now = +2s
  await h.tick(40_000); // now = +42s: past both caps, so 15s→"0m" and 30s→"1m"
  const s = h.manager.getSession()!;
  const sb = new LaLogStatusBar(() => {});
  sb.update(s, 0, 0, false, 15 * 1000);
  const text15 = mockVscode._statusBarItems[0].text;
  sb.update(s, 0, 0, false, 30 * 1000);
  const text30 = mockVscode._statusBarItems[0].text;
  assert.notEqual(text15, text30, 'live-tail cap follows idleGapMs');

  const MIN = 60 * 1000;
  const legacy: Session = {
    id: 'legacy-1',
    workspaceKey: 'ws1',
    workspaceName: 'ws1name',
    startedAt: 0,
    endedAt: 30 * MIN,
    lastActivityAt: 30 * MIN,
    activeMinutes: 30 * MIN,
    notes: [],
    needsDescription: false,
    events: { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] },
    activeSpans: [],
    activityTs: [0, 10 * MIN, 30 * MIN],
  };
  const h15 = hourlyBreakdown([legacy], [], 0, 24 * 3600 * 1000, 15 * MIN);
  const h30 = hourlyBreakdown([legacy], [], 0, 24 * 3600 * 1000, 30 * MIN);
  assert.equal(h15[0].ms, 10 * MIN, '15m gap splits the legacy run');
  assert.equal(h30[0].ms, 30 * MIN, '30m gap keeps the legacy run contiguous');
});

test('US-1.4 · stale cutoff force-closes and starts fresh, no continue option', async (t) => {
  const h = setupHarness(t, { config: { staleSessionAfterMinutes: 60, autoEndAfterIdleMinutes: 120 } });
  await h.start();
  await h.edit(); // lastActivityAt = t0
  await h.tick(60_000); // first heartbeat: exactly staleAfter idle → force close + fresh
  await h.flush();
  const closed = await h.closedSessions();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closedReason, 'auto-idle');
  assert.equal(closed[0].endedAt, closed[0].lastActivityAt);
  const cur = h.manager.getSession();
  assert.ok(cur);
  assert.notEqual(cur!.id, closed[0].id);
  assert.equal(mockVscode.promptCalls().length, 0, 'no continue/resume option offered');
});

test('US-1.4 · staleAfter wins over autoEndIdle', async (t) => {
  const h = setupHarness(t, { config: { staleSessionAfterMinutes: 60, autoEndAfterIdleMinutes: 120 } });
  await h.start();
  await h.edit();
  await h.tick(120_000);
  await h.flush();
  const closed = await h.closedSessions();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closedReason, 'auto-idle');
  assert.equal(closed[0].endedAt, closed[0].lastActivityAt);
  assert.ok(h.manager.getSession(), 'fresh session already running (stale handled it, not auto-end)');
});

test('US-1.4 · answering an old prompt after stale close cannot affect the fresh session', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15, staleSessionAfterMinutes: 120 } });
  await h.start();
  await h.edit();
  mockVscode.gateQuickPick();
  await h.tick(60_000); // heartbeat 1: idle prompt asked (gated), not stale yet
  await h.flush();
  await h.tick(60_000); // heartbeat 2: stale cutoff fires
  await h.flush();
  mockVscode.releaseQuickPick('end');
  await h.flush();
  const closed = await h.closedSessions();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closedReason, 'auto-idle', 'stale close, not the old prompt answer');
  assert.ok(h.manager.getSession(), 'fresh session unaffected');
});

test('US-1.5 · pause freezes the clock (no accrual/events/prompts)', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit();
  await h.tick(5000);
  await h.edit();
  const s = h.manager.getSession()!;
  const before = s.activeMinutes;
  h.manager.pause();
  assert.ok(h.manager.isPaused());
  await h.edit();
  assert.equal(s.events.edits, 2, 'no events while paused');
  assert.equal(s.activeMinutes, before, 'no accrual while paused');
  await h.tick(120_000);
  await h.flush();
  assert.equal(s.activeMinutes, before);
  assert.equal(mockVscode.promptCalls().length, 0);
});

test('US-1.5 · resume counts from now', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit();
  h.manager.pause();
  await h.tick(60_000);
  h.manager.resume();
  assert.ok(!h.manager.isPaused());
  await h.edit();
  const s = h.manager.getSession()!;
  assert.equal(s.events.edits, 2);
  assert.ok(s.activeMinutes < 20 * 1000, 'no giant gap after resume');
});

test('US-1.5 · paused session is persisted on dispose', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit();
  h.manager.pause();
  const id = h.manager.getSession()!.id;
  h.manager.dispose();
  const snap = h.activeSnapshot();
  assert.ok(snap);
  assert.equal(snap!.id, id);
});

test('US-1.6 · end & restart closes and starts fresh', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit();
  const first = h.manager.getSession()!;
  const closed = await h.manager.endAndRestart();
  assert.equal(closed!.id, first.id);
  assert.equal(closed!.closedReason, 'user');
  const cur = h.manager.getSession()!;
  assert.ok(cur);
  assert.notEqual(cur.id, first.id);
});

test('US-1.7 · overnight session is not day-bound', async (t) => {
  const h = setupHarness(t, { config: { idleGapMinutes: 30 } });
  const t0 = Date.parse('2026-09-03T22:00:00');
  t.mock.timers.setTime(t0);
  await h.start();
  await h.work(60);
  t.mock.timers.setTime(Date.parse('2026-09-04T00:30:00'));
  await h.work(60);
  const s = h.manager.getSession()!;
  assert.equal(s.startedAt, t0, 'startedAt never changes across midnight');
  const d = new Date(s.startedAt);
  assert.equal(d.getDate(), 3);
  assert.equal(d.getMonth(), 8);
  const snap = insightsFor([s], [], 'today', Date.parse('2026-09-03T23:00:00'), h.th.idleGap);
  assert.equal(snap.count, 1);
  const snap2 = insightsFor([s], [], 'today', Date.parse('2026-09-04T12:00:00'), h.th.idleGap);
  assert.equal(snap2.count, 0);
});

test('US-1.8 · workspace-scoped tracking with stable keys', async (t) => {
  const h = setupHarness(t);
  await h.start();
  const s1 = h.manager.getSession()!;
  const wsB = path.join(h.dir, 'workspace-b');
  fs.mkdirSync(wsB, { recursive: true });
  mockVscode.setWorkspaceFolders([wsB]);
  await h.manager.openWorkspace();
  const s2 = h.manager.getSession()!;
  assert.notEqual(s1.workspaceKey, s2.workspaceKey);
  assert.equal(s2.workspaceKey, workspaceKey(wsB));
  assert.ok(h.store.loadActive(s1.workspaceKey));
  assert.ok(h.store.loadActive(s2.workspaceKey));
});

test('US-1.9 · abnormal-exit recovery closes leftover as recovery-skip without prompting', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit();
  h.manager.dispose(); // abnormal exit: snapshot left behind
  const h2 = createHarness(t, { dir: h.dir });
  await h2.start();
  const closed = await h2.closedSessions();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closedReason, 'recovery-skip');
  assert.equal(closed[0].endedAt, closed[0].lastActivityAt);
  assert.ok(h2.manager.getSession());
  assert.equal(mockVscode.promptCalls().length, 0);
  h2.dispose();
});

test('US-1.9 · vscode-shutdown session is never reopened or re-probed', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit();
  await h.manager.shutdown();
  const closed = await h.closedSessions();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closedReason, 'vscode-shutdown');
  const h2 = createHarness(t, { dir: h.dir });
  await h2.start();
  const closed2 = await h2.closedSessions();
  assert.equal(closed2.length, 1, 'no recovery-skip of the shutdown session');
  assert.equal(closed2[0].closedReason, 'vscode-shutdown');
  assert.ok(h2.manager.getSession());
  assert.equal(mockVscode.promptCalls().length, 0);
  h2.dispose();
});

test('US-1.2 · span builder opens, extends, and closes runs', () => {
  const IDLE = 15 * 60 * 1000;
  let open: number | null = null;
  open = updateActiveSpan(null, 0, IDLE, open).openSpanStart;
  assert.equal(open, 0);
  const r1 = updateActiveSpan(0, 5 * 60 * 1000, IDLE, open);
  assert.equal(r1.closed, null);
  assert.equal(r1.openSpanStart, 0);
  const r2 = updateActiveSpan(5 * 60 * 1000, 25 * 60 * 1000, IDLE, r1.openSpanStart);
  assert.deepEqual(r2.closed, { start: 0, end: 5 * 60 * 1000 });
  assert.equal(r2.openSpanStart, 25 * 60 * 1000);
});

test('US-1.3 · trimToCutoff caps spans, drops after-window, filters activityTs', () => {
  const MIN = 60 * 1000;
  const r = trimToCutoff(
    [{ start: 0, end: 10 * MIN }, { start: 12 * MIN, end: 15 * MIN }],
    2 * MIN,
    8 * MIN,
    8 * MIN,
    [0, 2 * MIN, 4 * MIN, 6 * MIN, 8 * MIN],
    5 * MIN
  );
  // Documented behavior: closed spans cap at `until`; the open span closes at
  // min(lastActivityAt, until); spans fully after `until` are dropped.
  assert.deepEqual(r.closedSpans, [
    { start: 0, end: 5 * MIN },
    { start: 2 * MIN, end: 5 * MIN },
  ]);
  assert.equal(r.activeMinutes, 8 * MIN);
  assert.deepEqual(r.activityTs, [0, 2 * MIN, 4 * MIN]);
  assert.equal(r.openSpanStart, null);
});

test('US-1.4 · isStale boundary: null, exactly-at, just-under, past', () => {
  const MIN = 60 * 1000;
  assert.equal(isStale(null, 1000, 60 * MIN), false);
  assert.equal(isStale(1000 - 60 * MIN, 1000, 60 * MIN), true);
  assert.equal(isStale(1000 - 60 * MIN + 1, 1000, 60 * MIN), false);
  assert.equal(isStale(1000 - 60 * MIN - 1, 1000, 60 * MIN), true);
});