import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setupHarness, setupExtension, flush } from '../helpers/harness';
import { mockVscode } from '../helpers/mockVscode';
import { insightsFor, effectiveMs, hourlyBreakdown } from '../../src/reporting/insights';
import { rangeStart, rangeEnd, rangeLabel } from '../../src/reporting/ranges';
import { generateReport, saveReport, calendarDayCount } from '../../src/reporting/report';
import { todayActiveMs, todayUntrackedMs } from '../../src/reporting/aggregate';
import { splitActiveMinutes } from '../../src/reporting/spans';
import { exportFilesByDay } from '../../src/integrations/legacyExport';
import type { Session } from '../../src/core/types';

const MIN = 60 * 1000;
const H = 60 * MIN;

function sessionAt(startedAt: number, activeMinutes: number, extra: Partial<Session> = {}): Session {
  return {
    id: 's' + startedAt,
    workspaceKey: 'ws1',
    workspaceName: 'ws1name',
    startedAt,
    endedAt: startedAt + activeMinutes,
    lastActivityAt: startedAt + activeMinutes,
    activeMinutes,
    notes: [],
    needsDescription: false,
    events: { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0, topFiles: [] },
    activeSpans: [{ start: startedAt, end: startedAt + activeMinutes }],
    activityTs: [],
    ...extra,
  };
}

test('US-6.1 · effectiveMs: closed reports stored minutes; live gets a capped tail', () => {
  const now = Date.parse('2026-09-21T12:00:00');
  const closed = sessionAt(now - 2 * H, 25 * MIN);
  assert.equal(effectiveMs(closed, now, 15 * MIN), 25 * MIN);
  const live = sessionAt(now - 10 * MIN, 5 * MIN, { endedAt: undefined });
  assert.equal(effectiveMs(live, now, 15 * MIN), 10 * MIN);
  assert.equal(effectiveMs(live, now + 30 * MIN, 15 * MIN), 5 * MIN + 15 * MIN);
});

test('US-6.1 · insights totals include a live session with a capped tail', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(30);
  const live = h.manager.getSession()!;
  const now = Date.now();
  const snap = insightsFor([live], [], 'today', now, h.th.idleGap);
  assert.ok(snap.count >= 1);
  assert.ok(snap.totalMs >= live.activeMinutes, 'live tail included');
  assert.ok(snap.totalMs <= live.activeMinutes + h.th.idleGap, 'tail capped at idle gap');
  assert.ok(snap.vscodeMs > 0);
  assert.ok(snap.byDay.length >= 1);
});

test('US-6.1 · in/outside split from active spans', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.work(30);
  const s = h.manager.getSession()!;
  const bx = splitActiveMinutes(s, h.th.idleGap);
  assert.ok(bx.vscodeMs > 0);
  assert.equal(bx.outsideMs, 0);
  const s2 = sessionAt(Date.parse('2026-09-21T09:00:00'), 20 * MIN, {
    activeSpans: [
      { start: Date.parse('2026-09-21T09:00:00'), end: Date.parse('2026-09-21T09:05:00') },
      { start: Date.parse('2026-09-21T09:05:00'), end: Date.parse('2026-09-21T09:20:00') },
    ],
    activityTs: [Date.parse('2026-09-21T09:00:00'), Date.parse('2026-09-21T09:05:00')],
  });
  const bx2 = splitActiveMinutes(s2, 15 * MIN);
  assert.ok(Math.abs(bx2.vscodeMs - 5 * MIN) < 1000);
  assert.ok(Math.abs(bx2.outsideMs - 15 * MIN) < 1000);
});

test('US-6.1 · todayActiveMs and todayUntrackedMs', () => {
  const now = Date.parse('2026-09-21T12:00:00');
  const todayStart = rangeStart('today', now);
  const described = sessionAt(todayStart + H, 30 * MIN, { description: 'x', needsDescription: false });
  const undescribed = sessionAt(todayStart + 2 * H, 20 * MIN, { needsDescription: true });
  const yesterday = sessionAt(todayStart - H, 40 * MIN);
  assert.equal(todayActiveMs([described, undescribed, yesterday], now), 50 * MIN);
  assert.equal(todayUntrackedMs([described, undescribed, yesterday], now), 20 * MIN);
});

test('US-6.2 · period toggles recompute for today/week/month', () => {
  const now = Date.parse('2026-09-24T12:00:00');
  const todayStart = rangeStart('today', now);
  const weekStart = rangeStart('week', now);
  const monthStart = rangeStart('month', now);
  const today = sessionAt(todayStart + H, 30 * MIN);
  const week = sessionAt(weekStart + 2 * H, 20 * MIN);
  const month = sessionAt(monthStart + 3 * H, 10 * MIN);
  const snapToday = insightsFor([today, week, month], [], 'today', now, 15 * MIN);
  const snapWeek = insightsFor([today, week, month], [], 'week', now, 15 * MIN);
  const snapMonth = insightsFor([today, week, month], [], 'month', now, 15 * MIN);
  assert.equal(snapToday.count, 1);
  assert.equal(snapWeek.count, 2);
  assert.equal(snapMonth.count, 3);
});

test('US-6.2 · range math: month boundary, week starts Monday', () => {
  const now = Date.parse('2026-09-24T12:00:00');
  const monthStart = rangeStart('month', now);
  assert.equal(new Date(monthStart).getDate(), 1);
  assert.equal(new Date(monthStart).getMonth(), 8);
  assert.equal(new Date(rangeStart('week', now)).getDay(), 1);
  const todayStart = rangeStart('today', now);
  assert.equal(new Date(todayStart).getHours(), 0);
  assert.equal(new Date(rangeEnd('today', now)).getDate(), 25);
  assert.equal(rangeLabel('today'), 'Today');
});

test('US-6.3 · session-centric report lists totals and per-session detail', async () => {
  const now = Date.parse('2026-09-21T12:00:00');
  const s = sessionAt(rangeStart('today', now) + H, 45 * MIN, {
    workspaceName: 'my-project',
    type: 'feature',
    description: 'Fix login',
    gitBranch: 'fix/login',
    commits: [{ hash: 'abc1234', subject: 'Fix login validation' }],
    events: { edits: 12, saves: 3, terminal: 2, fileops: 1, tasks: 1, debug: 1, topFiles: [{ path: '/ws/auth.ts', edits: 8, firstTouch: 0, lastTouch: 0 }] },
  });
  const content = await generateReport([s], [], 'today', {}, now, 15 * MIN);
  assert.ok(content.includes('Active time: 45m'));
  assert.ok(content.includes('Fix login'));
  assert.ok(content.includes('fix/login'));
  assert.ok(content.includes('Fix login validation'));
  assert.ok(content.includes('auth.ts'));
  assert.ok(content.includes('feature'));
});

test('US-6.4 · custom range, project scope, hourly log, non-overwriting filenames', async () => {
  const now = Date.parse('2026-09-21T12:00:00');
  const start = rangeStart('today', now);
  const end = rangeEnd('today', now);
  const s = sessionAt(start + H, 60 * MIN, { workspaceName: 'ws', type: 'ops' });
  const proj = { id: 'p1', name: 'Client A', color: '#409cd4', workspaceKeys: ['ws1'], pathHints: [], createdAt: 0 };
  const content = await generateReport([s], [proj], 'custom', { custom: { start, end } }, now, 15 * MIN);
  assert.ok(content.includes('Hourly log'));
  assert.ok(content.includes('Client A'));
  const scoped = await generateReport([s], [proj], 'today', { projectId: 'p1' }, now, 15 * MIN);
  assert.ok(scoped.includes('Client A'));
  const scopedOut = await generateReport([s], [proj], 'today', { projectId: 'nope' }, now, 15 * MIN);
  assert.ok(scopedOut.includes('0 session'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-reports-'));
  const paths = { dataDir: dir, activeDir: dir + '/active', sessionsFile: dir + '/sessions.jsonl', exportsDir: dir + '/exports', reportsDir: dir + '/reports', technicalDir: dir + '/technical' };
  fs.mkdirSync(paths.reportsDir, { recursive: true });
  const f1 = saveReport(paths, 'one', { range: 'today', now });
  const f2 = saveReport(paths, 'two', { range: 'today', now });
  assert.notEqual(f1, f2, 'second save does not overwrite');
  assert.ok(fs.existsSync(f1) && fs.existsSync(f2));
  assert.ok(path.basename(f1).startsWith('2026-09-21-today'));
});

test('US-6.4 · hourly log splits a session across hour cells', () => {
  const now = Date.parse('2026-09-21T12:00:00');
  const dayStart = rangeStart('today', now);
  const dayEnd = rangeEnd('today', now);
  const s = sessionAt(dayStart + 10 * H + 30 * MIN, 90 * MIN);
  const hours = hourlyBreakdown([s], [], dayStart, dayEnd);
  assert.ok(hours.length >= 2);
  const total = hours.reduce((sum, hh) => sum + hh.ms, 0);
  assert.equal(total, 90 * MIN);
});

test('US-6.4 · calendarDayCount is DST-safe', () => {
  const start = Date.parse('2026-09-21T00:00:00');
  const end = Date.parse('2026-09-23T00:00:00');
  // half-open [start, end): Sep 21, Sep 22
  assert.equal(calendarDayCount(start, end), 2);
});

test('US-6.5 · CSV export writes sessions-<date>.csv', async (t) => {
  const ext = await setupExtension(t);
  mockVscode.fireEdit('/ws/a.ts');
  t.mock.timers.tick(2000);
  await flush();
  await mockVscode.commands.executeCommand('lalog.endSession');
  await flush();
  await mockVscode.commands.executeCommand('lalog.exportCsv');
  await flush();
  const files = fs.readdirSync(ext.paths.exportsDir);
  const csv = files.find((f) => f.endsWith('.csv'));
  assert.ok(csv, 'csv written');
  const content = fs.readFileSync(path.join(ext.paths.exportsDir, csv!), 'utf8');
  assert.ok(content.includes('"id","startedAt","endedAt"'));
  assert.ok(content.includes('"workspace"'));
});

test('US-6.5 · files_by_day legacy export groups by project slug and day', async (t) => {
  const h = setupHarness(t);
  await h.start();
  await h.edit('/ws/src/auth.ts');
  await h.manager.endSession('user');
  const closed = await h.closedSessions();
  const written = await exportFilesByDay(h.paths, closed);
  assert.ok(written.length >= 1);
  const content = fs.readFileSync(written[0], 'utf8');
  assert.ok(content.includes('auth.ts'));
  assert.ok(content.includes(':'));
});

test('US-6.5 · files_by_day uses local day keys', async (t) => {
  const h = setupHarness(t);
  // 23:30 local: a UTC key would file the edit under the next day.
  t.mock.timers.setTime(new Date(2026, 8, 21, 23, 30).getTime());
  await h.start();
  await h.edit('/ws/src/late.ts');
  await h.manager.endSession('user');
  const closed = await h.closedSessions();
  const written = await exportFilesByDay(h.paths, closed);
  const content = fs.readFileSync(written[0], 'utf8');
  assert.ok(content.includes('2026-09-21:'), 'filed under the local day');
  assert.ok(!content.includes('2026-09-22:'), 'not filed under the UTC day');
});

// ---- US-6.8 · timeline slots carry session identity -------------------------

const NOW = new Date(2026, 8, 21, 20, 0).getTime();

/** `sessionAt`'s second argument is milliseconds of active time, not minutes. */
function ms(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return new Date(2026, 8, 21, h, m).getTime();
}

function day(snap: ReturnType<typeof insightsFor>, day: string) {
  const row = snap.timeline.find((d) => d.day === day);
  assert.ok(row, `timeline has a row for ${day}`);
  return row!;
}

test('US-6.8 · two sessions in one hour collapse into one part with both session ids', () => {
  const a = sessionAt(ms('10:00'), 30 * MIN, { id: 'a-1000' });
  const b = sessionAt(ms('10:20'), 30 * MIN, { id: 'b-1020' });
  const snap = insightsFor([a, b], [], 'today', NOW, 15 * MIN);
  const cell = day(snap, '2026-09-21').cells[10];
  assert.equal(cell.parts.length, 1, 'same project \u2192 one part');
  assert.equal(cell.parts[0].ms, 60 * MIN, 'ms summed across both sessions');
  assert.deepEqual(cell.parts[0].sessionIds.sort(), ['a-1000', 'b-1020']);
  assert.equal(cell.ms, 60 * MIN, 'legacy ms is the dominant (only) part');
  assert.equal(cell.projectName, 'ws1name');
});

test('US-6.8 · two projects in one hour produce parts sorted by ms with dominant legacy fields', () => {
  const a = sessionAt(ms('10:00'), 30 * MIN, { id: 'a-1000', projectId: 'p1' });
  const b = sessionAt(ms('10:00') + 1000, 10 * MIN, { id: 'b-1000', projectId: 'p2' });
  const projects = [
    { id: 'p1', name: 'Client A', color: '#409cd4', workspaceKeys: [], pathHints: [], createdAt: 0 },
    { id: 'p2', name: 'Client B', color: '#2ea043', workspaceKeys: [], pathHints: [], createdAt: 1 },
  ];
  const snap = insightsFor([a, b], projects, 'today', NOW, 15 * MIN);
  const cell = day(snap, '2026-09-21').cells[10];
  assert.equal(cell.parts.length, 2);
  assert.deepEqual(cell.parts.map((p) => p.projectName), ['Client A', 'Client B'], 'sorted ms desc');
  assert.equal(cell.parts[0].ms, 30 * MIN);
  assert.deepEqual(cell.parts[1].sessionIds, ['b-1000']);
  assert.equal(cell.projectName, 'Client A', 'legacy field is the dominant project');
  assert.equal(cell.ms, 30 * MIN);
  assert.equal(cell.color, '#409cd4');
});

test('US-6.8 · an empty hour is a transparent cell with no parts', () => {
  const a = sessionAt(ms('10:00'), 30 * MIN, { id: 'a-1000' });
  const snap = insightsFor([a], [], 'today', NOW, 15 * MIN);
  const cells = day(snap, '2026-09-21').cells;
  const empty = cells[15];
  assert.deepEqual(empty, { ms: 0, projectName: '', color: 'transparent', parts: [] });
  assert.equal(cells[10].parts.length, 1, 'the busy hour still carries its part');
});

test('US-6.8 · a session spanning an hour boundary splits its ms across both cells', () => {
  const s = sessionAt(ms('09:50'), 30 * MIN, { id: 'crossing' });
  const snap = insightsFor([s], [], 'today', NOW, 15 * MIN);
  const cells = day(snap, '2026-09-21').cells;
  assert.equal(cells[9].parts[0].ms, 10 * MIN, '09:50\u201310:00 lands in the 09:00 cell');
  assert.equal(cells[10].parts[0].ms, 20 * MIN, '10:00\u201310:20 lands in the 10:00 cell');
  assert.deepEqual(cells[9].parts[0].sessionIds, ['crossing']);
  assert.deepEqual(cells[10].parts[0].sessionIds, ['crossing']);
});

test('US-6.8 · every timeline part names a project that byProject knows', () => {
  const a = sessionAt(ms('10:00'), 30 * MIN, { id: 'a-1000', projectId: 'p1' });
  const b = sessionAt(ms('11:00'), 20 * MIN, { id: 'b-1100', projectId: 'p2' });
  const c = sessionAt(ms('12:00'), 20 * MIN, { id: 'c-1200' }); // unassigned \u2192 workspace name
  const projects = [
    { id: 'p1', name: 'Client A', color: '#409cd4', workspaceKeys: [], pathHints: [], createdAt: 0 },
    { id: 'p2', name: 'Client B', color: '#2ea043', workspaceKeys: [], pathHints: [], createdAt: 1 },
  ];
  const snap = insightsFor([a, b, c], projects, 'today', NOW, 15 * MIN);
  const names = new Set(snap.byProject.map((p) => p.name));
  const parts = day(snap, '2026-09-21').cells.flatMap((cell) => cell.parts);
  assert.ok(parts.length >= 3, 'parts were built');
  for (const p of parts) {
    assert.ok(names.has(p.projectName), `${p.projectName} is in byProject`);
  }
  assert.equal(snap.byProject.length, 3);
});
