import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { truncateToTotal, tailEndOf } from '../../src/core/spans';
import type { ActiveSpan, Session } from '../../src/core/types';
import {
  setupHarness,
  setupExtension,
  resolvePanel,
  mockWebviewView,
  flush,
  waitFor,
  BASE_TIME,
  MIN,
} from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import { SessionStore } from '../../src/storage/sessionStore';
import { workspaceKey } from '../../src/storage/store';

function at(min: number): number {
  return BASE_TIME + min * MIN;
}

function sp(startMin: number, endMin: number): ActiveSpan {
  return { start: at(startMin), end: at(endMin) };
}

function sumOf(spans: ActiveSpan[]): number {
  return spans.reduce((sum, s) => sum + (s.end - s.start), 0);
}

test('US-4.9 · truncateToTotal cuts a single span from its end', () => {
  const res = truncateToTotal([sp(0, 20)], 20 * MIN, [at(0), at(20)], 15 * MIN);
  assert.deepEqual(res.spans, [sp(0, 15)]);
  assert.equal(res.activeMinutes, 15 * MIN);
  assert.equal(res.tailEnd, at(15));
});

test('US-4.9 · a cut spanning spans walks back from the tail and drops emptied spans', () => {
  const spans = [sp(0, 10), sp(12, 20), sp(25, 30)];
  const total = sumOf(spans);
  const whole = truncateToTotal(spans, total, [], 18 * MIN);
  assert.deepEqual(whole.spans, [sp(0, 10), sp(12, 20)], 'the last span is gone entirely');
  assert.equal(whole.activeMinutes, 18 * MIN);
  const deeper = truncateToTotal(spans, total, [], 12 * MIN);
  assert.deepEqual(deeper.spans, [sp(0, 10), sp(12, 14)], 'the cut continues into the span before it');
  assert.equal(deeper.activeMinutes, 12 * MIN);
});

test('US-4.9 · the confirmed-outside window is removed first and post-return work survives', () => {
  const outside = sp(20, 30);
  const spans = [sp(0, 10), outside, sp(35, 40)];
  const total = sumOf(spans);
  const res = truncateToTotal(spans, total, [], total - 5 * MIN, outside);
  assert.deepEqual(res.spans, [sp(0, 10), sp(20, 25), sp(35, 40)]);
  assert.equal(res.activeMinutes, 20 * MIN);
  assert.equal(res.tailEnd, at(40), 'the tail is untouched — work after the return is spared');
});

test('US-4.9 · a cut bigger than the outside window continues backward from the tail', () => {
  const outside = sp(20, 30);
  const spans = [sp(0, 10), outside, sp(35, 40)];
  const total = sumOf(spans);
  const res = truncateToTotal(spans, total, [], 12 * MIN, outside);
  assert.deepEqual(res.spans, [sp(0, 10), sp(35, 37)]);
  assert.equal(res.activeMinutes, 12 * MIN);
  assert.equal(sumOf(res.spans), res.activeMinutes);
});

test('US-4.9 · a stale preferredSuffix is ignored', () => {
  const res = truncateToTotal([sp(0, 10)], 10 * MIN, [], 4 * MIN, sp(50, 60));
  assert.deepEqual(res.spans, [sp(0, 4)]);
  assert.equal(res.activeMinutes, 4 * MIN);
});

test('US-4.9 · a target equal to the total is a no-op copy', () => {
  const spans = [sp(0, 10), sp(12, 20)];
  const res = truncateToTotal(spans, sumOf(spans), [at(1), at(2)], sumOf(spans));
  assert.deepEqual(res.spans, spans);
  assert.equal(res.activeMinutes, sumOf(spans));
  assert.equal(res.tailEnd, at(20));
  assert.notEqual(res.spans, spans, "the caller's array is never mutated");
});

test('US-4.9 · target 0 empties the spans, the tail and the activity log', () => {
  const spans = [sp(0, 10), sp(12, 20)];
  const res = truncateToTotal(spans, sumOf(spans), [at(1), at(2), at(20)], 0);
  assert.deepEqual(res.spans, []);
  assert.equal(res.activeMinutes, 0);
  assert.equal(res.tailEnd, null);
  assert.deepEqual(res.activityTs, []);
  assert.equal(tailEndOf([]), null);
  assert.equal(tailEndOf([sp(0, 10)]), at(10));
});

test('US-4.9 · activityTs is filtered to the new tail and a span never splits at its start', () => {
  const res = truncateToTotal([sp(0, 20)], 20 * MIN, [at(1), at(10), at(18), at(19)], 15 * MIN);
  assert.deepEqual(res.activityTs, [at(1), at(10)], 'timestamps after the new tail end are dropped');
  assert.equal(res.spans[0].start, at(0), 'the start is never moved');
});

test('US-4.9 · growing the total is rejected', () => {
  assert.throws(() => truncateToTotal([sp(0, 10)], 10 * MIN, [], 10 * MIN + 1), RangeError);
  assert.throws(() => truncateToTotal([sp(0, 10)], 10 * MIN, [], -1), RangeError);
});

/** Live session with a wrongly confirmed 'still working', plus a real work run after it. */
async function liveWithWrongConfirm(h: {
  start(): Promise<void>;
  editor(): void;
  work(seconds: number): Promise<void>;
  tick(ms: number): Promise<void>;
  edit(): Promise<void>;
  flush(): Promise<void>;
  manager: { getSession(): Session | null; getMachine(): { state: string } };
}) {
  await h.start();
  h.editor();
  mockVscode.gateQuickPick();
  await h.tick(60_000);
  await h.flush();
  h.editor();
  await h.tick(7 * 60_000 + 13_000);
  mockVscode.releaseQuickPick('active');
  await h.flush();
  const outside = h.manager.getSession()!.activeSpans[0];
  assert.equal(outside.end - outside.start, 7 * 60_000 + 13_000, 'the wrong confirm billed the away window');
  await h.work(20);
  await h.tick(60_000); // a gap past idleGap closes the post-return run too
  await h.edit();
  const s = h.manager.getSession()!;
  const postReturn = s.activeSpans[s.activeSpans.length - 1];
  return { outside, postReturn, live: s };
}

test('US-4.9 · a wrong "still working" is rolled back on the live session, which keeps tracking', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  const { outside, postReturn } = await liveWithWrongConfirm(h);
  // The wrap checkpoint was reached during the seed and its prompt dismissed, so
  // the interval is re-armed and tracking is back in 'active' — the answer to the
  // wrap question counts from that moment, not from the session start.
  assert.equal(h.manager.getMachine().state, 'active', 'a dismissed wrap prompt re-arms the interval');
  const keepMs = postReturn.end - postReturn.start;
  assert.ok(keepMs > 0, 'there is real post-return work to spare');

  const nowBefore = Date.now();
  await h.manager.adjustTrackedTime(keepMs);
  await h.flush();

  const s = h.manager.getSession()!;
  assert.equal(s.activeMinutes, keepMs, 'the away window is gone and the total is the real work');
  assert.equal(h.manager.getMachine().activeMinutes, keepMs);
  assert.deepEqual(s.activeSpans, [postReturn], 'only the post-return span survives, untouched');
  assert.equal(
    s.activeSpans.some((x) => x.start === outside.start && x.end === outside.end),
    false,
    'the outside window is gone'
  );
  assert.equal(sumOf(s.activeSpans), s.activeMinutes);
  assert.equal(s.lastActivityAt, nowBefore, 'the clock restarts from the adjust moment');
  assert.ok(s.activityTs.every((ts) => ts <= postReturn.end), 'activityTs is filtered to the new tail');
  assert.equal(h.manager.getMachine().state, 'active', 'still tracking normally after the correction');

  // Only the new gap accrues, and the next save cannot resurrect the dropped time.
  await h.edit();
  assert.equal(h.manager.getSession()!.activeMinutes, keepMs, 'a zero-length gap adds nothing');
  await h.tick(3000);
  await h.edit();
  assert.equal(h.manager.getSession()!.activeMinutes, keepMs + 5000, '5s after the adjust');
  await h.heartbeat();
  assert.equal(h.activeSnapshot()!.activeMinutes, keepMs + 5000, 'the heartbeat keeps the correction');
});

test('US-4.9 · a continuous run with no closed span is trimmed, not zeroed', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(60);
  const s = h.manager.getSession()!;
  assert.deepEqual(s.activeSpans, [], 'the whole run is still open');
  const total = s.activeMinutes;
  assert.ok(total > 0);
  await h.manager.adjustTrackedTime(total - 30_000);
  await h.flush();
  const after = h.manager.getSession()!;
  assert.equal(after.activeMinutes, total - 30_000, 'the open run is finalized and trimmed by 30s');
  assert.equal(sumOf(after.activeSpans), after.activeMinutes);
});

test('US-4.9 · a second adjustment does not reuse the removed outside window', async (t) => {
  const h = setupHarness(t, { config: { idleConfirmAfterMinutes: 15 } });
  const { postReturn } = await liveWithWrongConfirm(h);
  await h.manager.adjustTrackedTime(postReturn.end - postReturn.start);
  await h.flush();
  await h.manager.adjustTrackedTime(0);
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.activeMinutes, 0);
  assert.deepEqual(s.activeSpans, []);
  assert.equal(h.activeSnapshot()!.activeMinutes, 0);
});

test('US-4.9 · growth is refused by the manager and changes nothing', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(10);
  const total = h.manager.getMachine().activeMinutes;
  await assert.rejects(() => h.manager.adjustTrackedTime(total + MIN), RangeError);
  await assert.rejects(() => h.manager.adjustTrackedTime(-1), RangeError);
  assert.equal(h.manager.getSession()!.activeMinutes, total);
});

/** Close a session carrying real tracked time: edits every 14s, each under the idle gap. */
async function seedTracked(t: any, ext: any, file: string, steps = 20): Promise<Session> {
  for (let i = 0; i < steps; i++) {
    mockVscode.fireEdit(file);
    t.mock.timers.tick(14_000);
    await flush();
  }
  await mockVscode.commands.executeCommand('lalog.endSession');
  await flush();
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const all = await store.loadAll();
  return all[all.length - 1];
}

test('US-4.9 · the row button rewrites a closed session and preserves everything else', async (t) => {
  const ext = await setupExtension(t, { config: { describeAfterMinutes: 100000 } });
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const target = await seedTracked(t, ext, '/ws/a.ts');
  assert.equal(target.activeMinutes, 19 * 14_000);
  await store.updateSession(target.id, { description: 'billing bug' });
  const sidecar = path.join(ext.paths.technicalDir, target.id + '.jsonl');
  fs.writeFileSync(sidecar, '{"type":"terminal"}\n');

  const view = mockWebviewView();
  mockVscode._webviewProvider.resolveWebviewView(view);
  await waitFor(() => view.webview.html.includes('btnAdjust'));

  mockVscode.queueInputBox('1');
  view._post({ type: 'adjust', id: target.id });
  await waitFor(() =>
    mockVscode._promptCalls.some((c) => c.kind === 'inputBox' && c.title?.includes('Adjust tracked time'))
  );
  await waitFor(() => fs.readFileSync(ext.paths.sessionsFile, 'utf8').includes('"activeMinutes":60000'));

  const updated = (await store.loadAll()).find((s) => s.id === target.id)!;
  assert.equal(updated.activeMinutes, 60_000, 'the truncated total is persisted');
  assert.equal(sumOf(updated.activeSpans), 60_000, 'sum(spans) === activeMinutes');
  assert.equal(updated.lastActivityAt, updated.activeSpans[0].end, 'lastActivityAt is the new tail end');
  assert.equal(updated.description, 'billing bug', 'the description survives');
  assert.equal(updated.closedReason, 'user', 'the close reason survives');
  assert.equal(updated.workspaceName, target.workspaceName);
  assert.equal(updated.events.edits, target.events.edits, 'event counters survive');
  assert.equal(fs.existsSync(sidecar), true, 'the technical sidecar is untouched');
});

test('US-4.9 · the Now box adjusts the live session and it keeps tracking', async (t) => {
  const ext = await setupExtension(t, { config: { describeAfterMinutes: 100000 } });
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const wsKey = workspaceKey(path.join(ext.paths.dataDir, 'workspace'));
  const snapshot = () => store.loadActive(wsKey)!;
  for (let i = 0; i < 20; i++) {
    mockVscode.fireEdit('/ws/live.ts');
    t.mock.timers.tick(14_000);
    await flush();
  }
  assert.equal(snapshot().activeMinutes, 19 * 14_000);

  const view = mockWebviewView();
  mockVscode._webviewProvider.resolveWebviewView(view);
  await waitFor(() => view.webview.html.includes('btnAdjust'));

  mockVscode.queueInputBox('2');
  view._post({ type: 'adjustLive' });
  await waitFor(() => snapshot().activeMinutes === 120_000);
  assert.equal(sumOf(snapshot().activeSpans), 120_000, 'sum(spans) === activeMinutes');
  assert.deepEqual(await store.loadAll(), [], 'the live session is never written to the closed log');

  mockVscode.fireEdit('/ws/live.ts');
  t.mock.timers.tick(3000);
  await flush();
  mockVscode.fireEdit('/ws/live.ts');
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(snapshot().activeMinutes, 123_000, 'only the 3s gap after the adjust is counted');
});

test('US-4.9 · cancel, an unchanged value and an increase never write', async (t) => {
  const ext = await setupExtension(t, { config: { describeAfterMinutes: 100000 } });
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const target = await seedTracked(t, ext, '/ws/a.ts');
  const view = mockWebviewView();
  mockVscode._webviewProvider.resolveWebviewView(view);
  await waitFor(() => view.webview.html.includes('btnAdjust'));
  const before = fs.readFileSync(ext.paths.sessionsFile, 'utf8');

  mockVscode.queueInputBox(undefined);
  await mockVscode.commands.executeCommand('lalog.adjustTrackedTime', target.id);
  await flush();
  assert.equal(
    mockVscode._promptCalls.filter((c) => c.title?.includes('Adjust tracked time')).length,
    1,
    'the box was offered once'
  );

  mockVscode.queueInputBox('4');
  await mockVscode.commands.executeCommand('lalog.adjustTrackedTime', target.id);
  await flush();
  assert.ok(mockVscode._infoMessages.some((m) => m.includes('No change')), 'the same value is a no-op');

  mockVscode.queueInputBox('99');
  await mockVscode.commands.executeCommand('lalog.adjustTrackedTime', target.id);
  await flush();
  assert.ok(mockVscode._errorMessages.some((m) => m.includes('only be reduced')), 'growth is refused');

  assert.equal(fs.readFileSync(ext.paths.sessionsFile, 'utf8'), before, 'nothing was written');
  assert.equal((await store.loadAll())[0].activeMinutes, target.activeMinutes);
});

test('US-4.9 · an unknown id is never replaced by the latest session', async (t) => {
  const ext = await setupExtension(t, { config: { describeAfterMinutes: 100000 } });
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const target = await seedTracked(t, ext, '/ws/a.ts');
  mockVscode.queueInputBox('1');
  await mockVscode.commands.executeCommand('lalog.adjustTrackedTime', '20260101-0000-zzzz-ffff');
  await waitFor(() => mockVscode._infoMessages.some((m) => m.includes('Session not found.')));
  assert.equal(
    mockVscode._promptCalls.filter((c) => c.title?.includes('Adjust tracked time')).length,
    0,
    'no input box for a missing session'
  );
  assert.equal((await store.loadAll())[0].activeMinutes, target.activeMinutes);
});

test('US-4.9 · the panel wires both adjust buttons to the command', async (t) => {
  const h = setupHarness(t);
  const { view } = resolvePanel(h);
  const html = view.webview.html;
  assert.ok(html.includes('id="btnAdjust"'), 'the Now box has the adjust button');
  assert.ok(html.includes("type: 'adjust'"), 'the row button posts the adjust message');
  assert.ok(html.includes("type: 'adjustLive'"), 'the Now box posts the live adjust message');
  assert.ok(html.includes('Adjust tracked time'), 'both buttons are titled');
});
