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