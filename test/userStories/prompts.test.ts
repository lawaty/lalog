import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupHarness, defaultConfig, BASE_TIME } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import { PromptCoordinator } from '../../src/prompts/promptCoordinator';
import { newMachine } from '../../src/core/stateMachine';
import { thresholdsMs } from '../../src/core/config';
import { SessionStore } from '../../src/storage/sessionStore';
import { buildPaths } from '../../src/storage/store';

test('US-3.1 · describe held to breakpoint, then force-timed', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95); // describePending
  assert.equal(h.manager.getMachine().state, 'describePending');
  assert.ok(
    !mockVscode.promptCalls().some((c) => c.kind === 'inputBox' && c.title === 'What are you working on?'),
    'held until a breakpoint'
  );
  mockVscode.queueInputBox('fixing auth');
  mockVscode.queueQuickPick('other');
  h.debugEnd();
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.description, 'fixing auth');
  assert.equal(s.type, 'other');
  assert.equal(s.needsDescription, false);
});

test('US-3.1 · describe forced after 30 minutes without a breakpoint', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  assert.equal(h.manager.getMachine().state, 'describePending');
  mockVscode.queueInputBox('forced');
  mockVscode.queueQuickPick('other');
  await h.tick(30_000); // force timer
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.description, 'forced');
});

test('US-3.1 · prompts never stack (one at a time)', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(BASE_TIME);
  const th = thresholdsMs(defaultConfig());
  const pc = new PromptCoordinator(th);
  const store = new SessionStore({ paths: buildPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-pc-'))), th });
  const s = store.newSession('ws', 'ws', 0);
  const m = newMachine();
  mockVscode.queueQuickPick('active');
  const p1 = pc.askStillWorking(s);
  const p2 = pc.askStillWorking(s);
  assert.equal(await p2, null, 'second prompt skipped while one is visible');
  assert.equal(await p1, 'active');
  t.mock.timers.reset();
  mockVscode.reset();
});

test('US-3.2 · text-first describe with pre-fill; Enter saves', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit('/ws/src/auth.ts');
  await h.edit('/ws/src/api.ts');
  await h.work(95);
  mockVscode.queueInputBox('implementing auth');
  mockVscode.queueQuickPick('other');
  h.debugEnd();
  await h.flush();
  const inputCall = mockVscode.promptCalls().find((c) => c.kind === 'inputBox' && c.title === 'What are you working on?');
  assert.ok(inputCall, 'input box appears first');
  assert.ok(inputCall.value.includes('auth.ts'), `pre-filled with top files: ${inputCall.value}`);
  const s = h.manager.getSession()!;
  assert.equal(s.description, 'implementing auth');
  assert.ok(s.notes.some((n) => n.text === 'implementing auth'));
});

test('US-3.2 · empty text falls back to the non-text quick pick', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  mockVscode.queueInputBox('');
  mockVscode.queueQuickPick('later');
  h.debugEnd();
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.needsDescription, true);
});

test('US-3.3 · task type picker defaults to other (Enter accepts)', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  mockVscode.queueInputBox('refactoring');
  h.debugEnd();
  await h.flush();
  const typeCall = mockVscode.promptCalls().find((c) => c.kind === 'quickPick' && c.title === 'Task type?');
  assert.ok(typeCall);
  const labels = typeCall.items.map((i) => i.label);
  for (const ty of ['feature', 'bugfix', 'research', 'refactor', 'review', 'docs', 'ops', 'other']) {
    assert.ok(labels.includes(ty), `offers ${ty}`);
  }
  const s = h.manager.getSession()!;
  assert.equal(s.type, 'other', 'Enter accepts the default');
});

test('US-3.4 · same-as-last offered and fills the session', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.manager.setLastDescriptionProvider(async () => 'previous work');
  await h.work(95);
  mockVscode.queueInputBox('');
  mockVscode.queueQuickPick('same');
  h.debugEnd();
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.description, 'previous work');
  assert.equal(s.type, 'other');
});

test('US-3.5 · background work: anonymous, no more prompts, clears on describe', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  mockVscode.queueInputBox('');
  mockVscode.queueQuickPick('background');
  h.debugEnd();
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.anonymous, true);
  assert.equal(s.needsDescription, false);
  await h.work(95);
  await h.tick(60_000);
  await h.flush();
  const describeCalls = mockVscode.promptCalls().filter((c) => c.kind === 'inputBox' && c.title === 'What are you working on?');
  assert.equal(describeCalls.length, 1, 'no further describe prompts for background work');
  mockVscode.queueInputBox('real description');
  mockVscode.queueQuickPick('feature');
  h.manager.presentDescribeNow();
  await h.flush();
  assert.equal(s.anonymous, false);
  assert.equal(s.description, 'real description');
});

test('US-3.1 · answering re-arms the describe interval from the response moment', async (t) => {
  // wrapAt is pushed out of the way: this is about the describe checkpoint alone.
  const h = setupHarness(t, { config: { wrapAfterMinutes: 100000 } });
  await h.start();
  await h.work(95);
  mockVscode.queueInputBox('first answer');
  mockVscode.queueQuickPick('other');
  h.debugEnd();
  await h.flush();
  assert.equal(h.manager.getSession()!.description, 'first answer');
  const asked = () =>
    mockVscode.promptCalls().filter((c) => c.kind === 'inputBox' && c.title === 'What are you working on?').length;
  assert.equal(asked(), 1);

  // Work on and take a breakpoint well inside a second full interval: the
  // answered checkpoint must stay answered rather than re-asking.
  await h.work(60);
  assert.equal(h.manager.getMachine().state, 'active', 'not immediately pending again');
  h.debugEnd();
  await h.flush();
  assert.equal(asked(), 1, 'a breakpoint does not re-ask the answered prompt');
  h.terminalShellStart({ commandLine: 'ls' });
  h.terminalShellEnd({ commandLine: 'ls' }, 0);
  await h.flush();
  await h.heartbeat();
  assert.equal(asked(), 1, 'still one: the force timer cannot stack a second prompt');

  // Only after a full describe interval of new active work does it come back —
  // exactly once, whether the force timer or a breakpoint delivers it.
  mockVscode.queueInputBox('second answer');
  mockVscode.queueQuickPick('other');
  await h.work(96);
  assert.equal(asked(), 2, 'a fresh interval asks exactly once more');
  assert.equal(h.manager.getSession()!.description, 'second answer');
  await h.work(30);
  h.debugEnd();
  await h.flush();
  assert.equal(asked(), 2, 'and the answer re-arms it again');
});

test('US-3.1 · a deferred description is not re-asked either', async (t) => {
  const h = setupHarness(t, { config: { wrapAfterMinutes: 100000 } });
  await h.start();
  await h.work(95);
  mockVscode.queueInputBox('');
  mockVscode.queueQuickPick('later');
  h.debugEnd();
  await h.flush();
  assert.equal(h.manager.getSession()!.needsDescription, true);
  const asked = () =>
    mockVscode.promptCalls().filter((c) => c.kind === 'inputBox' && c.title === 'What are you working on?').length;
  await h.work(60);
  h.debugEnd();
  await h.flush();
  await h.heartbeat();
  assert.equal(asked(), 1, '"Later" defers, it does not queue another prompt');
});

test('US-3.7 · a skipped wrap prompt does not re-ask on the next breakpoint', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  mockVscode.queueInputBox('long session');
  mockVscode.queueQuickPick('other');
  h.debugEnd();
  await h.flush();
  await h.driveToWrap();
  assert.equal(h.manager.getMachine().state, 'wrapPending');
  const wraps = () => mockVscode.promptCalls().filter((c) => c.title?.includes('wrap it up')).length;
  mockVscode.queueQuickPick('skipped');
  h.debugEnd();
  await h.flush();
  assert.equal(wraps(), 1);
  assert.equal(h.manager.getMachine().graceExtensions, 0, 'skipping costs no free extension');

  await h.work(60);
  h.debugEnd();
  await h.flush();
  h.terminalShellStart({ commandLine: 'ls' });
  h.terminalShellEnd({ commandLine: 'ls' }, 0);
  await h.flush();
  await h.heartbeat();
  assert.equal(wraps(), 1, 'the unanswered wrap prompt is not stacked');
});

test('US-3.6 · later/skip flags needsDescription and continues', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  mockVscode.queueInputBox('');
  mockVscode.queueQuickPick('later');
  h.debugEnd();
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.needsDescription, true);
  assert.equal(s.description, undefined);
  await h.work(30);
  assert.ok(h.manager.getSession(), 'tracking continues');
});

test('US-3.7 · wrap prompt at 3.5h offers wrap-new/extend/add-description/skip', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  mockVscode.queueInputBox('long session');
  mockVscode.queueQuickPick('other');
  h.debugEnd();
  await h.flush();
  await h.driveToWrap();
  assert.equal(h.manager.getMachine().state, 'wrapPending');
  mockVscode.queueQuickPick('wrap-new');
  h.debugEnd();
  await h.flush();
  const wrapCall = mockVscode.promptCalls().find((c) => c.title?.includes('wrap it up'));
  assert.ok(wrapCall);
  const choices = wrapCall.items.map((i) => i.choice);
  assert.ok(choices.includes('wrap-new'));
  assert.ok(choices.includes('extend'));
  assert.ok(choices.includes('add-description'));
  assert.ok(choices.includes('skipped'));
  const closed = await h.closedSessions();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closedReason, 'user');
  assert.ok(h.manager.getSession(), 'fresh session started');
});

test('US-3.8 · extend grants a grace period and re-prompts', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  mockVscode.queueInputBox('long session');
  mockVscode.queueQuickPick('other');
  h.debugEnd();
  await h.flush();
  await h.driveToWrap();
  mockVscode.queueQuickPick('extend');
  h.debugEnd();
  await h.flush();
  assert.equal(h.manager.getMachine().state, 'grace');
  assert.equal(h.manager.getMachine().graceExtensions, 1);
  mockVscode.queueQuickPick('extend');
  await h.tick(60_000);
  await h.flush();
  assert.equal(h.manager.getMachine().graceExtensions, 2);
  assert.equal(h.manager.getMachine().state, 'grace');
});

test('US-3.8 · maxGraceExtensions free extends then a description is required', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  mockVscode.queueInputBox('long session');
  mockVscode.queueQuickPick('other');
  h.debugEnd();
  await h.flush();
  await h.driveToWrap();
  mockVscode.queueQuickPick('extend');
  h.debugEnd();
  await h.flush();
  mockVscode.queueQuickPick('extend');
  await h.tick(60_000);
  await h.flush();
  mockVscode.queueQuickPick('extend');
  await h.tick(60_000);
  await h.flush();
  mockVscode.queueQuickPick('extend');
  mockVscode.queueInputBox('final description');
  mockVscode.queueQuickPick('other');
  await h.tick(60_000);
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.description, 'final description');
  assert.equal(h.manager.getMachine().graceExtensions, 4);
});

test('US-3.9 · progress notes: skip re-arms, first note becomes description', async (t) => {
  const h = setupHarness(t, { config: { progressAfterMinutes: 60, describeAfterMinutes: 100000 } });
  await h.start();
  await h.work(65);
  mockVscode.queueInputBox('did stuff');
  await h.tick(60_000);
  await h.flush();
  const s = h.manager.getSession()!;
  assert.ok(s.notes.some((n) => n.text === 'did stuff'));
  assert.equal(s.description, 'did stuff');
  await h.work(65);
  await h.tick(60_000);
  await h.flush();
  assert.equal(s.notes.length, 1);
  await h.work(65);
  mockVscode.queueInputBox('second note');
  await h.tick(60_000);
  await h.flush();
  assert.equal(s.notes.length, 2);
});

test('US-3.10 · never prompt about a closed session', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(95);
  await h.manager.endSession('user');
  const before = mockVscode.promptCalls().length;
  await h.tick(120_000);
  await h.flush();
  assert.equal(mockVscode.promptCalls().length, before);
});

test('US-3.11 · describe-now opens the flow immediately', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit();
  mockVscode.queueInputBox('now description');
  mockVscode.queueQuickPick('feature');
  h.manager.presentDescribeNow();
  await h.flush();
  const s = h.manager.getSession()!;
  assert.equal(s.description, 'now description');
  assert.equal(s.type, 'feature');
});