import { Session } from '../core/types';
import { Project, resolveProject, resolveProjectName } from '../core/projects';
import { splitActiveMinutes } from './spans';
import { rangeStart, rangeEnd, dayKey } from './ranges';
import { DEFAULT_IDLE_GAP_MS } from '../core/config';

export type InsightRange = 'today' | 'week' | 'month';

export interface InsightProject {
  name: string;
  color: string;
  ms: number;
  sessions: number;
}

export interface InsightDay {
  day: string;
  ms: number;
}

export interface InsightTopFile {
  path: string;
  edits: number;
}

/** One project's slice of a single hour cell, with the sessions that produced it. */
export interface HourPart {
  ms: number;
  projectName: string;
  /** Contributing sessions, deduped — the click target for the cell. */
  sessionIds: string[];
}

export interface HourCell {
  ms: number; // dominant part's ms (legacy, unchanged)
  projectName: string; // dominant project (legacy, unchanged)
  color: string; // dominant color (legacy, unchanged)
  /** Per-project slices, sorted ms desc; [] for an empty cell. */
  parts: HourPart[];
}

export interface InsightTimelineDay {
  day: string;
  cells: HourCell[];
}

export interface InsightsSnapshot {
  totalMs: number;
  vscodeMs: number;
  outsideMs: number;
  count: number;
  byProject: InsightProject[];
  byDay: InsightDay[];
  topFiles: InsightTopFile[];
  timeline: InsightTimelineDay[];
}

/** Effective tracked ms for a session (live sessions get a capped live tail). */
export function effectiveMs(s: Session, now: number, idleGapMs: number): number {
  if (s.endedAt) return s.activeMinutes;
  return s.activeMinutes + Math.max(0, Math.min(now - s.lastActivityAt, idleGapMs));
}

/** Start of the LOCAL hour containing t (offsets the collector grid with the day grid). */
const localHourStart = (t: number): number => {
  const d = new Date(t);
  d.setSeconds(0, 0);
  d.setMinutes(0, 0);
  return d.getTime();
};

/** Aggregate sessions over a period into a UI-ready snapshot. */
export function insightsFor(
  sessions: Session[],
  projects: Project[],
  range: InsightRange,
  now = Date.now(),
  idleGapMs = DEFAULT_IDLE_GAP_MS
): InsightsSnapshot {
  const start = rangeStart(range, now);
  const end = rangeEnd(range, now);
  const inRange = sessions.filter((s) => s.startedAt >= start && s.startedAt < end);

  let totalMs = 0;
  let vscodeMs = 0;
  let outsideMs = 0;
  const projMap = new Map<string, InsightProject>();
  const byDayMap = new Map<string, number>();
  const fileMap = new Map<string, number>();

  for (const s of inRange) {
    const ms = effectiveMs(s, now, idleGapMs);
    totalMs += ms;
    const split = splitActiveMinutes(s, idleGapMs);
    vscodeMs += split.vscodeMs;
    outsideMs += Math.max(0, ms - split.vscodeMs);

    const day = dayKey(s.startedAt);
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + ms);

    const proj = resolveProject(s, projects);
    const name = proj?.name ?? s.workspaceName;
    const color = proj?.color ?? '#8a8a8a';
    const cur = projMap.get(name);
    if (cur) {
      cur.ms += ms;
      cur.sessions += 1;
    } else {
      projMap.set(name, { name, color, ms, sessions: 1 });
    }

    for (const f of s.events?.topFiles ?? []) {
      fileMap.set(f.path, (fileMap.get(f.path) ?? 0) + f.edits);
    }
  }

  const timeline = buildTimeline(inRange, projects, start, end, idleGapMs);
  return {
    totalMs,
    vscodeMs,
    outsideMs,
    count: inRange.length,
    byProject: [...projMap.values()].sort((a, b) => b.ms - a.ms),
    byDay: [...byDayMap.entries()]
      .map(([day, ms]) => ({ day, ms }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)),
    topFiles: [...fileMap.entries()]
      .map(([path, edits]) => ({ path, edits }))
      .sort((a, b) => b.edits - a.edits)
      .slice(0, 10),
    timeline,
  };
}

/** One row per day in the period; one cell per local hour, split per project. */
function buildTimeline(
  sessions: Session[],
  projects: Project[],
  start: number,
  end: number,
  idleGapMs: number
): InsightTimelineDay[] {
  // Per day: per-hour accumulated ms by project, with the sessions behind it.
  const days = new Map<string, Map<number, Map<string, { ms: number; color: string; sessionIds: Set<string> }>>>();
  for (const s of sessions) {
    const proj = resolveProject(s, projects);
    const name = proj?.name ?? s.workspaceName;
    const color = proj?.color ?? '#8a8a8a';
    const spans = s.activeSpans?.length
      ? s.activeSpans
      : s.activityTs?.length
      ? reconstructSpans(s.activityTs, idleGapMs)
      : [];
    for (const span of spans) {
      const a = Math.max(span.start, s.startedAt, start);
      const b = Math.min(span.end, s.endedAt ?? end, end);
      if (b <= a) continue;
      let cursor = a;
      while (cursor < b) {
        const hourStart = localHourStart(cursor);
        const hourEnd = hourStart + 3600000;
        const segEnd = Math.min(hourEnd, b);
        const dk = dayKey(cursor);
        let hours = days.get(dk);
        if (!hours) {
          hours = new Map();
          days.set(dk, hours);
        }
        let projHours = hours.get(hourStart);
        if (!projHours) {
          projHours = new Map();
          hours.set(hourStart, projHours);
        }
        const cur = projHours.get(name);
        if (cur) {
          cur.ms += segEnd - cursor;
          cur.sessionIds.add(s.id);
        } else {
          projHours.set(name, { ms: segEnd - cursor, color, sessionIds: new Set([s.id]) });
        }
        cursor = segEnd;
      }
    }
  }

  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, hours]) => {
      const cells: HourCell[] = [];
      // One cell per local hour of that calendar day (24 normally; 23 / 25 on
      // DST transitions), keyed exactly like the collection grid above.
      const dayStart = dayStartMs(day);
      const nextStart = new Date(dayStart);
      nextStart.setDate(nextStart.getDate() + 1);
      let cursor = dayStart;
      while (cursor < nextStart.getTime()) {
        const hourStart = localHourStart(cursor);
        const bucket = hours.get(hourStart);
        if (!bucket) {
          cells.push({ ms: 0, projectName: '', color: 'transparent', parts: [] });
        } else {
          const parts: HourPart[] = [...bucket.entries()]
            .map(([projectName, v]) => ({ ms: v.ms, projectName, sessionIds: [...v.sessionIds] }))
            .sort((a, b) => b.ms - a.ms);
          const dominant = parts[0];
          cells.push({
            ms: dominant.ms,
            projectName: dominant.projectName,
            color: bucket.get(dominant.projectName)!.color,
            parts,
          });
        }
        cursor = hourStart + 3600000;
      }
      return { day, cells };
    });
}

function dayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Rebuild contiguous spans from a legacy activity timestamp stream (gap rule). */
function reconstructSpans(activityTs: number[], idleGapMs: number): { start: number; end: number }[] {
  const ts = [...activityTs].sort((a, b) => a - b);
  const spans: { start: number; end: number }[] = [];
  let runStart: number | null = null;
  let prev: number | null = null;
  for (const t of ts) {
    if (runStart === null) {
      runStart = t;
    } else if (prev !== null && t - prev > idleGapMs) {
      spans.push({ start: runStart, end: prev });
      runStart = t;
    }
    prev = t;
  }
  if (runStart !== null && prev !== null) spans.push({ start: runStart, end: prev });
  return spans;
}

/** Hour-by-hour account of a single day, used for the report hourly log. */
export function hourlyBreakdown(
  sessions: Session[],
  projects: Project[],
  dayStart: number,
  dayEnd: number,
  idleGapMs = DEFAULT_IDLE_GAP_MS
): { hourStart: number; ms: number; projectName: string }[] {
  const hours = new Map<number, { ms: number; projectName: string }>();
  for (const s of sessions) {
    if (s.startedAt >= dayEnd || (s.endedAt ?? dayStart) < dayStart) continue;
    const projName = resolveProjectName(s, projects);
    const spans = s.activeSpans?.length
      ? s.activeSpans
      : s.activityTs?.length
      ? reconstructSpans(s.activityTs, idleGapMs)
      : [];
    for (const span of spans) {
      const a = Math.max(span.start, s.startedAt, dayStart);
      const b = Math.min(span.end, s.endedAt ?? dayEnd, dayEnd);
      if (b <= a) continue;
      let cursor = a;
      while (cursor < b) {
        const hourStart = localHourStart(cursor);
        const segEnd = Math.min(hourStart + 3600000, b);
        const cur = hours.get(hourStart);
        if (cur) {
          cur.ms += segEnd - cursor;
        } else {
          hours.set(hourStart, { ms: segEnd - cursor, projectName: projName });
        }
        cursor = segEnd;
      }
    }
  }
  return [...hours.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hourStart, v]) => ({ hourStart, ms: v.ms, projectName: v.projectName }));
}