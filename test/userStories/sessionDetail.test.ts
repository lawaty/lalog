import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { setupExtension, mockWebviewView, flush, waitFor } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import {
  renderSessionDetail,
  renderDayDiffs,
  diffRetentionView,
  fmtHM,
  DIFF_PREVIEW_CHARS,
} from '../../src/reporting/sessionDetail';
import { dayKey } from '../../src/reporting/ranges';
import { SessionStore } from '../../src/storage/sessionStore';
import type { Session, TechnicalEntry, TechnicalDiff } from '../../src/core/types';

const MIN = 60_000;
const IDLE = 15 * MIN;

function sessionAt(startedAt: number, extra: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    workspaceKey: 'ws1',
    workspaceName: 'my-project',
    startedAt,
    endedAt: startedAt + 30 * MIN,
    lastActivityAt: startedAt + 30 * MIN,
    activeMinutes: 30 * MIN,
    notes: [],
    needsDescription: false,
    events: { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] },
    activeSpans: [],
    activityTs: [],
    ...extra,
  };
}

function diffEntry(ts: number, over: Partial<TechnicalDiff> = {}): TechnicalDiff {
  return {
    type: 'diff',
    ts,
    path: '/ws/src/auth.ts',
    diff: '--- a\n+++ b\n+added\n-removed',
    linesAdded: 3,
    linesRemoved: 1,
    newFile: false,
    ...over,
  };
}

test('US-4.4 · session detail renders every section', () => {
  const start = new Date(2026, 8, 21, 9, 0).getTime();
  const s = sessionAt(start, {
    description: 'Fix login',
    type: 'bugfix',
    closedReason: 'user',
    gitBranch: 'fix/login',
    commits: [{ hash: 'abc1234', subject: 'Validate tokens' }],
    notes: [
      { at: start + 20 * MIN, text: 'second update' },
      { at: start + 10 * MIN, text: 'first update' },
    ],
    events: {
      edits: 12,
      saves: 3,
      terminal: 2,
      fileops: 1,
      tasks: 1,
      debug: 1,
      topFiles: [{ path: '/ws/src/auth.ts', edits: 8, firstTouch: start, lastTouch: start + 20 * MIN }],
    },
    activeSpans: [
      { start, end: start + 10 * MIN },
      { start: start + 10 * MIN, end: start + 20 * MIN },
    ],
    activityTs: [start + 10 * MIN],
  });
  const technical: TechnicalEntry[] = [
    diffEntry(start + 5 * MIN),
    {
      type: 'terminal',
      ts: start + 6 * MIN,
      commandLine: 'npm test',
      exitCode: 1,
      durationMs: 4200,
      cwd: '/ws',
      confidence: 'high',
    },
    {
      type: 'ai',
      ts: start + 7 * MIN,
      task: 'describe',
      model: 'opencode/big-pickle',
      latencyMs: 1500,
      promptChars: 200,
      responseChars: 50,
      truncated: false,
    },
  ];

  const md = renderSessionDetail({
    session: s,
    project: null,
    technical,
    retentionDays: null,
    now: start + 30 * MIN,
    idleGapMs: IDLE,
  });

  assert.ok(md.startsWith('# Session detail — my-project'), 'title names the workspace');
  assert.ok(md.includes('> *(no project)* · started 09:00 · ended 09:30 · bugfix · closed: user'), 'summary line');
  assert.ok(md.includes('**Active 30m — in VS Code 10m · outside VS Code 10m**'), 'activity split');
  assert.ok(md.includes('## Description\n\nFix login'));
  assert.ok(md.includes('- 09:10 — first update'), 'updates are timestamped');
  assert.ok(md.includes('- 09:20 — second update'));
  assert.ok(
    md.indexOf('first update') < md.indexOf('second update'),
    'updates sorted oldest first'
  );
  assert.ok(
    md.includes('edits 12 · saves 3 · terminal 2 · file ops 1 · tasks 1 · debug 1'),
    'event counters'
  );
  assert.ok(md.includes('- 09:00–09:10 in VS Code'), 'span ending at an activity ts');
  assert.ok(md.includes('- 09:10–09:20 outside VS Code'), 'span not ending at an activity ts');
  assert.ok(md.includes('- /ws/src/auth.ts · 8 edits'), 'top files use the full path');
  assert.ok(md.includes('- branch: fix/login'));
  assert.ok(md.includes('- commit: Validate tokens'));
  assert.ok(md.includes('- 09:05 /ws/src/auth.ts +3 \u22121'), 'diff line with +N/-N');
  assert.ok(md.includes('```diff'));
  assert.ok(md.includes('- 09:06 `npm test` — exit 1 (4s) · /ws'), 'terminal line');
  assert.ok(
    md.includes('- 09:07 describe · opencode/big-pickle · 200\u219250 chars'),
    'AI interaction line'
  );
});

test('US-4.4 · empty technical entries report no file changes captured', () => {
  const start = new Date(2026, 8, 21, 9, 0).getTime();
  const md = renderSessionDetail({
    session: sessionAt(start),
    project: null,
    technical: [],
    retentionDays: 14,
    now: start + 30 * MIN,
    idleGapMs: IDLE,
  });
  assert.ok(md.includes('## File changes\n\n*(No file changes captured.)*'));
  assert.ok(md.includes('*(none recorded.)*'), 'empty sections say so');
});

test('US-4.4 · diffRetentionView covers all four branches', () => {
  const now = new Date(2026, 8, 21, 9, 0).getTime();
  const old = now - 30 * 86_400_000;
  const fresh = now - 1 * 86_400_000;
  const session = { startedAt: old, events: { saves: 5 } };

  const off = diffRetentionView([diffEntry(old)], session, null, now);
  assert.equal(off.diffs.length, 1, 'retention off keeps every diff');
  assert.equal(off.agedOut, false);

  const inWindow = diffRetentionView([diffEntry(old), diffEntry(fresh)], session, 14, now);
  assert.equal(inWindow.diffs.length, 1, 'only diffs inside the window');
  assert.equal(inWindow.diffs[0].ts, fresh);
  assert.equal(inWindow.agedOut, false);

  const stale = diffRetentionView([diffEntry(old)], session, 14, now);
  assert.equal(stale.diffs.length, 0);
  assert.equal(stale.agedOut, true, 'diffs exist but all are older than the cutoff');

  const swept = diffRetentionView([], session, 14, now);
  assert.equal(swept.diffs.length, 0);
  assert.equal(swept.agedOut, true, 'old session with saves>0 and no diffs left');

  const readOnly = diffRetentionView([], { startedAt: old, events: { saves: 0 } }, 14, now);
  assert.equal(readOnly.agedOut, false, 'read-only old session is not a false positive');

  const recent = diffRetentionView([], { startedAt: fresh, events: { saves: 5 } }, 14, now);
  assert.equal(recent.agedOut, false, 'recent session is not aged out');
});

test('US-4.4 · oversized diff bodies are capped', () => {
  const start = new Date(2026, 8, 21, 9, 0).getTime();
  const body = 'x'.repeat(DIFF_PREVIEW_CHARS + 500);
  const md = renderSessionDetail({
    session: sessionAt(start),
    project: null,
    technical: [diffEntry(start + MIN, { diff: body })],
    retentionDays: null,
    now: start + 30 * MIN,
    idleGapMs: IDLE,
  });
  assert.ok(md.includes('x'.repeat(DIFF_PREVIEW_CHARS) + '…'), 'body capped with an ellipsis');
  assert.ok(!md.includes('x'.repeat(DIFF_PREVIEW_CHARS + 1)), 'nothing past the cap is rendered');
});

test('US-4.4 · terminal entries survive an aged-out diff window', () => {
  const start = new Date(2020, 0, 2, 9, 0).getTime();
  const now = new Date(2026, 8, 21, 9, 0).getTime();
  const technical: TechnicalEntry[] = [
    {
      type: 'terminal',
      ts: start + 5 * MIN,
      commandLine: 'git push origin main',
      exitCode: 0,
      durationMs: 9000,
      confidence: 'high',
    },
  ];
  const md = renderSessionDetail({
    session: sessionAt(start, { events: { edits: 1, saves: 2, terminal: 1, fileops: 0, tasks: 0, debug: 0, topFiles: [] } }),
    project: null,
    technical,
    retentionDays: 14,
    now,
    idleGapMs: IDLE,
  });
  assert.ok(md.includes('`git push origin main`'), 'terminal command still rendered');
  assert.ok(
    md.includes(
      '*(File diffs older than the retention window (14 days) are no longer available — see lalog.diffRetentionDays.)*'
    ),
    'aged-out note rendered'
  );
  assert.ok(!md.includes('```diff'), 'no diff body in an aged-out document');
});

test('US-4.8 · fmtHM is local and zero-padded', () => {
  assert.equal(fmtHM(new Date(2026, 8, 21, 9, 5).getTime()), '09:05');
  assert.equal(fmtHM(new Date(2026, 8, 21, 23, 30).getTime()), '23:30');
});

test('US-4.8 · clicking a session row opens its detail document', async (t) => {
  const ext = await setupExtension(t, { config: { captureDiffs: true } });
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  mockVscode.fireEdit('/ws/a.ts');
  t.mock.timers.tick(2000);
  await flush();
  mockVscode._openTextContent = 'line1\nline2\n';
  mockVscode.fireSave('/ws/a.ts');
  await flush();
  await mockVscode.commands.executeCommand('lalog.endSession');
  await flush();
  const all = await store.loadAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].workspaceName, 'workspace');

  const provider = mockVscode._webviewProvider;
  const view = mockWebviewView();
  provider.resolveWebviewView(view);
  await waitFor(() => mockVscode._webviewMessages.some((m: any) => m.type === 'state'));
  const before = mockVscode._openedDocs.length;
  view._post({ type: 'openSessionDetail', id: all[0].id });
  await waitFor(() => mockVscode._openedDocs.length === before + 1);

  const doc = mockVscode._openedDocs[mockVscode._openedDocs.length - 1];
  assert.equal(doc.language, 'markdown');
  const content = doc.content!;
  assert.ok(content.includes('# Session detail — workspace'), 'workspace name in the title');
  assert.ok(content.includes('## Updates'), 'updates section');
  assert.ok(content.includes('## File changes'), 'file changes section');
  assert.ok(content.includes('/ws/a.ts'), 'the captured diff is rendered');
  assert.ok(content.includes('```diff'), 'diff body present');
  assert.equal(mockVscode._shownDocs.length, 1, 'the document was shown');
  assert.equal(mockVscode._shownDocs[0].opts?.preview, true, 'shown as a preview tab');
});

test('US-4.8 · an unknown session id opens nothing', async (t) => {
  await setupExtension(t);
  const before = mockVscode._openedDocs.length;
  await mockVscode.commands.executeCommand('lalog.sessionDetail', 'nope-not-a-session');
  await flush();
  await mockVscode.commands.executeCommand('lalog.sessionDetail');
  await flush();
  assert.equal(mockVscode._openedDocs.length, before, 'no document opened');
  assert.ok(
    mockVscode._infoMessages.some((m) => m.includes('Session not found')),
    'told the session was not found'
  );
});

test('US-8.7 · the command honours diffRetentionDays', async (t) => {
  const ext = await setupExtension(t, { config: { captureDiffs: true, diffRetentionDays: 14 } });
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const old = new Date(2026, 8, 1, 9, 0).getTime();
  // A back-dated session whose sidecar holds a diff from before the window.
  fs.mkdirSync(ext.paths.technicalDir, { recursive: true });
  fs.appendFileSync(
    ext.paths.sessionsFile,
    JSON.stringify({
      id: '20260901-0900-abcd-ef01',
      workspaceKey: 'ws1',
      workspaceName: 'workspace',
      startedAt: old,
      endedAt: old + 30 * MIN,
      lastActivityAt: old + 30 * MIN,
      activeMinutes: 30 * MIN,
      notes: [],
      needsDescription: false,
      events: { edits: 1, saves: 1, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] },
      activeSpans: [{ start: old, end: old + 30 * MIN }],
      activityTs: [old],
    }) + '\n'
  );
  fs.writeFileSync(
    path.join(ext.paths.technicalDir, '20260901-0900-abcd-ef01.jsonl'),
    JSON.stringify(diffEntry(old + MIN)) + '\n'
  );
  assert.equal((await store.loadAll()).length, 1);

  await mockVscode.commands.executeCommand('lalog.sessionDetail', '20260901-0900-abcd-ef01');
  await waitFor(() => mockVscode._openedDocs.length > 0);
  let content = mockVscode._openedDocs[mockVscode._openedDocs.length - 1].content!;
  assert.ok(
    content.includes(
      '*(File diffs older than the retention window (14 days) are no longer available — see lalog.diffRetentionDays.)*'
    ),
    'aged-out note for a back-dated diff'
  );
  assert.ok(!content.includes('```diff'), 'no diff body rendered');
});

test('US-8.7 · diffRetentionDays 0 shows every diff', async (t) => {
  const ext = await setupExtension(t, { config: { captureDiffs: false, diffRetentionDays: 0 } });
  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const old = new Date(2026, 8, 1, 9, 0).getTime();
  fs.mkdirSync(ext.paths.technicalDir, { recursive: true });
  const id = '20260901-0900-abcd-ef02';
  fs.appendFileSync(
    ext.paths.sessionsFile,
    JSON.stringify({
      id,
      workspaceKey: 'ws1',
      workspaceName: 'workspace',
      startedAt: old,
      endedAt: old + 30 * MIN,
      lastActivityAt: old + 30 * MIN,
      activeMinutes: 30 * MIN,
      notes: [],
      needsDescription: false,
      events: { edits: 1, saves: 1, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] },
      activeSpans: [{ start: old, end: old + 30 * MIN }],
      activityTs: [old],
    }) + '\n'
  );
  fs.writeFileSync(
    path.join(ext.paths.technicalDir, id + '.jsonl'),
    JSON.stringify(diffEntry(old + MIN)) + '\n'
  );
  assert.equal((await store.loadAll()).length, 1);

  await mockVscode.commands.executeCommand('lalog.sessionDetail', id);
  await waitFor(() => mockVscode._openedDocs.length > 0);
  const content = mockVscode._openedDocs[mockVscode._openedDocs.length - 1].content!;
  assert.ok(content.includes('```diff'), 'the old diff is still shown');
  assert.ok(!content.includes('no longer available'), 'no aged-out note');
});

// ---- US-6.9 · file diffs for a day -----------------------------------------

function lastState(): any {
  const msgs = mockVscode._webviewMessages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === 'state') return msgs[i];
  }
  return null;
}

/** Write a closed-session line plus its technical sidecar. */
function seedSession(
  sessionsFile: string,
  technicalDir: string,
  s: Partial<Session> & { id: string; startedAt: number }
): void {
  fs.mkdirSync(technicalDir, { recursive: true });
  const full = sessionAt(s.startedAt, {
    id: s.id,
    workspaceName: s.workspaceName ?? 'workspace',
    description: s.description,
    projectId: s.projectId,
    events: s.events ?? {
      edits: 1,
      saves: 1,
      terminal: 0,
      fileops: 0,
      tasks: 0,
      debug: 0,
      topFiles: [],
    },
  });
  fs.appendFileSync(sessionsFile, JSON.stringify(full) + '\n');
}

test('US-6.9 · renderDayDiffs frames a day: per-session sections, banner, totals footer', () => {
  const now = new Date(2026, 8, 21, 9, 0).getTime();
  const fresh = sessionAt(new Date(2026, 8, 21, 10, 0).getTime(), {
    id: 'fresh',
    description: 'Feature work',
  });
  const late = sessionAt(new Date(2026, 8, 21, 23, 30).getTime(), { id: 'late' });
  const md = renderDayDiffs({
    day: '2026-09-21',
    // deliberately out of order — the renderer sorts by start
    sessions: [
      { session: late, technical: [diffEntry(late.startedAt + MIN, { path: '/ws/late.ts', linesAdded: 2, linesRemoved: 1 })] },
      { session: fresh, technical: [diffEntry(fresh.startedAt + MIN, { path: '/ws/a.ts', linesAdded: 5, linesRemoved: 4 })] },
    ],
    retentionDays: 14,
    now,
  });
  assert.ok(md.startsWith('# File changes — 2026-09-21'), 'day heading');
  assert.ok(md.includes('## 10:00 my-project — Feature work'), 'described header');
  assert.ok(md.includes('## 23:30 my-project — *(no description)*'), 'undescribed header');
  assert.ok(md.indexOf('## 10:00') < md.indexOf('## 23:30'), 'sessions sorted by start');
  assert.ok(md.includes('- 10:01 /ws/a.ts +5 \u22124'), 'diff line with counts');
  assert.ok(md.includes('```diff'), 'diff body shared with the session renderer');
  assert.ok(md.endsWith('+7 \u22125 across 2 sessions'), 'footer totals over both sessions');
  assert.ok(!md.includes('no longer available'), 'no aged-out banner for a fresh day');

  // A day whose diffs have all aged out: banner, per-session notes, empty totals.
  const oldStart = new Date(2020, 0, 2, 10, 0).getTime();
  const oldA = sessionAt(oldStart, { id: 'old-a' });
  const oldB = sessionAt(oldStart + 13 * 60 * MIN, { id: 'old-b' });
  const oldMd = renderDayDiffs({
    day: '2020-01-02',
    sessions: [
      { session: oldA, technical: [diffEntry(oldStart + MIN)] },
      { session: oldB, technical: [] },
    ],
    retentionDays: 14,
    now,
  });
  assert.ok(
    oldMd.includes(
      '> Some file diffs for this day are older than the retention window (14 days) and are no longer available \u2014 see lalog.diffRetentionDays.'
    ),
    'day-level aged-out banner'
  );
  assert.ok(oldMd.includes('*(File diffs older than the retention window (14 days) are no longer available'), 'aged-out note for the first session');
  assert.ok(oldMd.includes('*(No file changes captured.)*'), 'the second session never captured a diff');
  assert.ok(!oldMd.includes('```diff'), 'no diff bodies');
  assert.ok(oldMd.endsWith('+0 \u22120 across 2 sessions'), 'footer totals');
});

test('US-6.9 · lalog.dayDiffs with a day argument opens that day\'s diffs', async (t) => {
  const ext = await setupExtension(t, { config: { captureDiffs: false, diffRetentionDays: 14 } });
  const day = '2026-09-21';
  const freshStart = new Date(2026, 8, 21, 10, 0).getTime();
  const lateStart = new Date(2026, 8, 21, 23, 30).getTime();
  const oldStart = new Date(2026, 8, 1, 11, 0).getTime();
  seedSession(ext.paths.sessionsFile, ext.paths.technicalDir, { id: 'fresh-1', startedAt: freshStart });
  seedSession(ext.paths.sessionsFile, ext.paths.technicalDir, { id: 'late-1', startedAt: lateStart });
  seedSession(ext.paths.sessionsFile, ext.paths.technicalDir, { id: 'old-1', startedAt: oldStart });
  fs.writeFileSync(
    path.join(ext.paths.technicalDir, 'fresh-1.jsonl'),
    JSON.stringify(diffEntry(freshStart + MIN, { path: '/ws/fresh.ts', linesAdded: 5, linesRemoved: 4 })) + '\n'
  );
  fs.writeFileSync(
    path.join(ext.paths.technicalDir, 'late-1.jsonl'),
    JSON.stringify(diffEntry(lateStart + MIN, { path: '/ws/late.ts', linesAdded: 1, linesRemoved: 2 })) + '\n'
  );
  fs.writeFileSync(
    path.join(ext.paths.technicalDir, 'old-1.jsonl'),
    JSON.stringify(diffEntry(oldStart + MIN, { path: '/ws/old.ts' })) + '\n'
  );

  await mockVscode.commands.executeCommand('lalog.dayDiffs', day);
  await waitFor(() => mockVscode._openedDocs.length > 0);
  const content = mockVscode._openedDocs[mockVscode._openedDocs.length - 1].content!;
  assert.ok(content.startsWith(`# File changes \u2014 ${day}`), 'titled with the requested day');
  assert.ok(content.includes('## 10:00 workspace'), 'the 10:00 session is in the document');
  assert.ok(content.includes('## 23:30 workspace'), 'the 23:30 session is in the document');
  assert.ok(!content.includes('old.ts'), 'a different day is excluded');
  assert.ok(content.includes('- 10:01 /ws/fresh.ts +5 \u22124'), 'fresh diff counts');
  assert.ok(content.includes('- 23:31 /ws/late.ts +1 \u22122'), 'late diff counts');
  assert.ok(content.endsWith('+6 \u22126 across 2 sessions'), 'footer totals');

  // A day that does not exist in the log falls back to the day picker.
  mockVscode.queueQuickPick(undefined);
  await mockVscode.commands.executeCommand('lalog.dayDiffs', '1999-01-01');
  await flush();
  assert.equal(mockVscode._openedDocs.length, 1, 'cancelling the picker opens nothing');
});

test('US-6.9 · lalog.dayDiffs without a day picks one and flags aged-out sessions', async (t) => {
  const ext = await setupExtension(t, { config: { diffRetentionDays: 14 } });
  const oldStart = new Date(2026, 8, 1, 11, 0).getTime();
  const day = dayKey(oldStart);
  seedSession(ext.paths.sessionsFile, ext.paths.technicalDir, { id: 'old-1', startedAt: oldStart });
  fs.writeFileSync(
    path.join(ext.paths.technicalDir, 'old-1.jsonl'),
    JSON.stringify(diffEntry(oldStart + MIN)) + '\n'
  );

  mockVscode.queueQuickPick(day);
  await mockVscode.commands.executeCommand('lalog.dayDiffs');
  await waitFor(() => mockVscode._openedDocs.length > 0);
  const content = mockVscode._openedDocs[mockVscode._openedDocs.length - 1].content!;
  assert.ok(content.startsWith(`# File changes \u2014 ${day}`), 'picker selected the day');
  const picks = mockVscode._promptCalls.filter((c) => c.title === 'File diffs for day');
  assert.equal(picks.length, 1, 'the day picker was shown');
  assert.deepEqual(
    (picks[0].items as { id: string }[]).map((i) => i.id),
    [day],
    'only days that have sessions are offered'
  );
  assert.ok(
    content.includes('> Some file diffs for this day are older than the retention window (14 days)'),
    'day-level aged-out banner'
  );
  assert.ok(
    content.includes('*(File diffs older than the retention window (14 days) are no longer available'),
    'per-session aged-out note'
  );
});

test('US-6.9 · the day-diffs doc, the Sessions tab, and the timeline agree on one 23:30 session', async (t) => {
  const ext = await setupExtension(t);
  await mockVscode.commands.executeCommand('lalog.endSession'); // close the activation session
  await flush();
  const late = new Date(2026, 8, 21, 23, 30).getTime();
  t.mock.timers.setTime(late);
  mockVscode.fireEdit('/ws/late.ts');
  t.mock.timers.tick(2000);
  mockVscode.fireEdit('/ws/late.ts');
  t.mock.timers.tick(3000);
  await flush();
  await mockVscode.commands.executeCommand('lalog.endSession');
  await flush();

  const store = new SessionStore({ paths: ext.paths, th: ext.th });
  const all = await store.loadAll();
  const s = all[all.length - 1];
  assert.equal(s.startedAt, late, 'fixture really is a session that starts at 23:30 local');
  const day = dayKey(s.startedAt);
  assert.equal(day, '2026-09-21', 'a UTC day key would file it under 2026-09-22');

  const view = mockWebviewView();
  mockVscode._webviewProvider.resolveWebviewView(view);
  await waitFor(() => lastState() !== null);
  const st = lastState();
  assert.equal(st.groups[0].day, day, 'Sessions tab agrees on the day');
  assert.ok(
    st.insights.today.timeline.some((d: any) => d.day === day),
    'insights timeline agrees on the day'
  );

  await mockVscode.commands.executeCommand('lalog.dayDiffs', day);
  await waitFor(() => mockVscode._openedDocs.length > 0);
  const content = mockVscode._openedDocs[mockVscode._openedDocs.length - 1].content!;
  assert.ok(content.startsWith(`# File changes \u2014 ${day}`), 'day-diffs doc agrees on the day');
  assert.ok(content.includes('## 23:30 workspace'), 'the late session is in that day');
});
