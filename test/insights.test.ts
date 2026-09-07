import test from 'node:test';
import assert from 'node:assert/strict';
import { insightsFor, effectiveMs, hourlyBreakdown, InsightsSnapshot } from '../src/reporting/insights';
import { rangeStart, rangeEnd } from '../src/reporting/ranges';
import type { Session } from '../src/core/types';
import type { Project } from '../src/core/projects';

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

const NOW = new Date(2026, 5, 15, 12, 0).getTime(); // 2026-06-15 12:00 local
const idleGap = 15 * MIN;

test('effectiveMs: closed sessions report stored activeMinutes', () => {
  const s = sessionAt(NOW - 2 * H, 25 * MIN);
  assert.equal(effectiveMs(s, NOW, idleGap), 25 * MIN);
});

test('effectiveMs: live sessions get a capped live tail', () => {
  const s = sessionAt(NOW - 10 * MIN, 5 * MIN, { endedAt: undefined }); // lastActivityAt = NOW - 5min
  assert.equal(effectiveMs(s, NOW, idleGap), 10 * MIN);
  assert.equal(effectiveMs(s, NOW + idleGap * 2, idleGap), 5 * MIN + idleGap);
});

test('insightsFor today: counts in-range sessions and totals', () => {
  const todayStart = rangeStart('today', NOW);
  const inDay = [sessionAt(todayStart + 1 * H, 30 * MIN), sessionAt(todayStart + 2 * H, 15 * MIN)];
  const yesterday = sessionAt(todayStart - H, 40 * MIN);
  const snap = insightsFor([...inDay, yesterday], [], 'today', NOW, idleGap);
  assert.equal(snap.count, 2);
  assert.equal(snap.totalMs, 45 * MIN);
  assert.equal(snap.byDay.length, 1);
});

test('insightsFor aggregates per-project with derived or explicit mapping', () => {
  const todayStart = rangeStart('today', NOW);
  const proj: Project = { id: 'p1', name: 'Proj', color: '#409cd4', workspaceKeys: ['ws1'], pathHints: [], createdAt: 0 };
  const s1 = sessionAt(todayStart + 1 * H, 30 * MIN);
  const s2 = sessionAt(todayStart + 2 * H, 20 * MIN, { projectId: 'p1' });
  const snap = insightsFor([s1, s2], [proj], 'today', NOW, idleGap);
  const p = snap.byProject.find((x) => x.name === 'Proj');
  assert.ok(p);
  assert.equal(p.ms, 50 * MIN);
  assert.equal(p.sessions, 2);
  assert.equal(p.color, '#409cd4');
});

test('insightsFor splits vscode/outside from active spans', () => {
  const todayStart = rangeStart('today', NOW);
  const s = sessionAt(todayStart + 1 * H, 40 * MIN, {
    activeSpans: [
      { start: todayStart + 1 * H, end: todayStart + 1 * H + 25 * MIN },
      { start: todayStart + 1 * H + 40 * MIN, end: todayStart + 1 * H + 55 * MIN },
    ],
    activityTs: [todayStart + 1 * H, todayStart + 1 * H + 25 * MIN, todayStart + 1 * H + 40 * MIN],
  });
  const snap: InsightsSnapshot = insightsFor([s], [], 'today', NOW, idleGap);
  // lastActivityAt = end of spans → in-range; vscode slice = first span (25m)
  assert.equal(snap.vscodeMs, 25 * MIN);
  assert.equal(snap.outsideMs, 15 * MIN);
});

test('insightsFor timeline has 24 hourly cells for the day', () => {
  const todayStart = rangeStart('today', NOW);
  const s = sessionAt(todayStart + 10 * H, H);
  const snap = insightsFor([s], [], 'today', NOW, idleGap);
  assert.equal(snap.timeline.length, 1);
  assert.equal(snap.timeline[0].cells.length, 24);
  const busy = snap.timeline[0].cells.filter((c) => c.ms > 0);
  assert.ok(busy.length >= 1);
});

test('insightsFor timeline buckets into local hour cells (fractional-offset tz safe)', () => {
  const todayStart = rangeStart('today', NOW);
  // Activity 10:15 → 10:45 local: must land in a single cell and not spill into
  // a neighbour hour (a UTC-aligned grid would misalign in fractional-offset tzs).
  const s = sessionAt(todayStart + 10 * H + 15 * MIN, 30 * MIN, {
    activeSpans: [{ start: todayStart + 10 * H + 15 * MIN, end: todayStart + 10 * H + 45 * MIN }],
  });
  const snap = insightsFor([s], [], 'today', NOW, idleGap);
  const cells = snap.timeline[0].cells;
  const busy = cells.filter((c) => c.ms > 0);
  assert.equal(busy.length, 1, 'exactly one hour cell is busy');
  assert.equal(busy[0].ms, 30 * MIN);
});

test('insightsFor timeline renders the same local-hour grid it collects', () => {
  const todayStart = rangeStart('today', NOW);
  const spans = [
    { start: todayStart + 9 * H + 55 * MIN, end: todayStart + 10 * H + 5 * MIN },
    { start: todayStart + 10 * H + 30 * MIN, end: todayStart + 10 * H + 50 * MIN },
  ];
  const s = sessionAt(todayStart, spans[0].end, { activeSpans: spans });
  const snap = insightsFor([s], [], 'today', NOW, idleGap);
  const cells = snap.timeline[0].cells;
  const busy = cells.filter((c) => c.ms > 0);
  const collected = busy.reduce((sum, c) => sum + c.ms, 0);
  assert.equal(collected, spans.reduce((sum, p) => sum + (p.end - p.start), 0));
});

test('hourlyBreakdown splits a session across hour cells', () => {
  const dayStart = rangeStart('today', NOW);
  const dayEnd = rangeEnd('today', NOW);
  const s = sessionAt(dayStart + 10 * H + 30 * MIN, 90 * MIN); // ends 12:00 local
  const hours = hourlyBreakdown([s], [], dayStart, dayEnd);
  assert.ok(hours.length >= 2);
  const first = hours[0];
  assert.equal(first.projectName, 'ws1name');
  const total = hours.reduce((sum, h) => sum + h.ms, 0);
  assert.equal(total, 90 * MIN);
});

test('ranges: month boundary lands on the 1st', () => {
  const start = rangeStart('month', NOW);
  const d = new Date(start);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getMonth(), 5);
  assert.ok(rangeEnd('month', NOW) - start >= 28 * 86400000);
});

test('ranges: today/week bounds are local calendar midnights', () => {
  const ts = new Date(2026, 5, 15, 12, 0).getTime();
  const todayStart = rangeStart('today', ts);
  const todayEnd = rangeEnd('today', ts);
  const sToday = new Date(todayStart);
  assert.equal(sToday.getHours(), 0);
  assert.equal(sToday.getMinutes(), 0);
  assert.equal(new Date(todayEnd).getDate(), 16, 'today end is next calendar day');
  const yesterday = rangeStart('yesterday', ts);
  const y = new Date(yesterday);
  assert.equal(y.getDate(), 14, 'yesterday is the previous calendar day');
  const weekStart = rangeStart('week', ts);
  assert.equal(new Date(weekStart).getDay(), 1, 'week starts Monday');
});