import * as fs from 'fs';
import * as path from 'path';
import { Session } from '../core/types';
import { fmtDuration } from '../prompts/promptCoordinator';
import { LaLogPaths } from '../storage/store';
import { splitActiveMinutes } from './spans';
import { resolveProject, resolveProjectName, Project } from '../core/projects';
import { hourlyBreakdown, effectiveMs } from './insights';
import { ReportRange, rangeStart, rangeEnd, rangeLabel } from './ranges';

export { ReportRange, rangeStart, rangeEnd, rangeLabel } from './ranges';

export interface ReportOptions {
  /** Scope to this project id (null = all sessions). */
  projectId?: string | null;
  /** The live (in-progress) session, included for today's range when within range. */
  activeSession?: Session | null;
  /** Custom range bounds, required when range === 'custom'. */
  custom?: { start: number; end: number };
}

/** Session-centric markdown report. Sessions are NEVER split across days. */
export async function generateReport(
  sessions: Session[],
  projects: Project[],
  range: ReportRange,
  options: ReportOptions = {},
  now = Date.now(),
  idleGapMs = 15 * 60 * 1000
): Promise<string> {
  const start = options.custom?.start ?? rangeStart(range, now);
  const end = options.custom?.end ?? rangeEnd(range, now);
  const active = options.activeSession;
  const withLive = active && active.startedAt >= start && active.startedAt < end && !active.endedAt;

  let within = sessions.filter((s) => s.startedAt >= start && s.startedAt < end);
  if (options.projectId) {
    within = within.filter((s) => resolveProject(s, projects)?.id === options.projectId);
  }
  const inProgress = withLive && (!options.projectId || resolveProject(active, projects)?.id === options.projectId) ? [active] : [];
  within = [...within, ...inProgress];

  const totalActive = within.reduce((sum, s) => sum + effectiveMs(s, now, idleGapMs), 0);
  const inVscode = within.reduce((sum, s) => sum + splitActiveMinutes(s, idleGapMs).vscodeMs, 0);
  const outside = Math.max(0, totalActive - inVscode);
  const byProject = new Map<string, number>();
  const byWorkspace = new Map<string, number>();
  for (const s of within) {
    const projName = resolveProjectName(s, projects);
    byProject.set(projName, (byProject.get(projName) ?? 0) + effectiveMs(s, now, idleGapMs));
    byWorkspace.set(s.workspaceName, (byWorkspace.get(s.workspaceName) ?? 0) + s.activeMinutes);
  }

  const dayOrder: string[] = [];
  for (const s of within) {
    const dv = new Date(s.startedAt);
    const key = `${dv.getFullYear()}-${String(dv.getMonth() + 1).padStart(2, '0')}-${String(dv.getDate()).padStart(2, '0')}`;
    if (!dayOrder.includes(key)) dayOrder.push(key);
  }
  dayOrder.sort();
  const days = dayOrder.join(', ');

  const lines: string[] = [];
  lines.push(`# LaLog — ${rangeLabel(range)}${scopeSuffix(projects, options.projectId)}`);
  lines.push('');
  lines.push(`**Active time: ${fmtDuration(totalActive)}** across ${within.length} session(s)` + (inProgress.length ? ' *(includes the session in progress)*' : ''));
  if (within.length) {
    lines.push(`In VS Code: ${fmtDuration(inVscode)} · Outside VS Code: ${fmtDuration(outside)}`);
  }
  lines.push('');
  lines.push(`Sessions started: ${days || 'none'}`);
  lines.push('');

  const projSorted = [...byProject.entries()].sort((a, b) => b[1] - a[1]);
  if (projSorted.length) {
    lines.push('## By project');
    for (const [name, ms] of projSorted) {
      lines.push(`- **${name}**: ${fmtDuration(ms)}`);
    }
    lines.push('');
  }

  // Hourly log for single-day ranges: the "I want an hourly report" ask.
  // Count calendar days (DST-safe) rather than dividing ms by 24h.
  if (calendarDayCount(start, end) <= 1 && within.length) {
    lines.push('## Hourly log');
    const hours = hourlyBreakdown(within, projects, start, end);
    for (const h of hours) {
      const from = new Date(h.hourStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      lines.push(`- ${from} — ${fmtDuration(h.ms)} — ${h.projectName}`);
    }
    lines.push('');
  }

  lines.push('## Sessions');
  for (const s of [...within].sort((a, b) => a.startedAt - b.startedAt)) {
    const startTxt = new Date(s.startedAt).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const endTxt = s.endedAt ? new Date(s.endedAt).toLocaleString([], { hour: '2-digit', minute: '2-digit' }) : '(in progress)';
    const desc = s.description ? ` — ${s.description}` : s.anonymous ? ' *(background work)*' : s.needsDescription ? ' *(no description)*' : '';
    const bx = splitActiveMinutes(s, idleGapMs);
    const bxNote = bx.outsideMs > 0 ? ` · *${fmtDuration(bx.vscodeMs)} in Code / ${fmtDuration(bx.outsideMs)} outside*` : '';
    const projTag = resolveProjectName(s, projects);
    lines.push(
      `### ${startTxt} → ${endTxt} · ${fmtDuration(effectiveMs(s, now, idleGapMs))} · ${projTag} · ${s.workspaceName}${s.type ? ` · ${s.type}` : ''}${bxNote}`
    );
    lines.push(desc);
    if (s.events.topFiles.length) {
      const files = s.events.topFiles.slice(0, 5).map((f) => path.basename(f.path)).join(', ');
      lines.push(`*Files: ${files}*`);
    }
    if (s.gitBranch) lines.push(`*Branch: ${s.gitBranch}*`);
    if (s.commits?.length) {
      lines.push(`*Commits: ${s.commits.map((c) => `\`${c.subject}\``).join(', ')}*`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function scopeSuffix(projects: Project[], projectId?: string | null): string {
  if (!projectId) return '';
  const proj = projects.find((p) => p.id === projectId);
  return proj ? ` — ${proj.name}` : '';
}

/** Number of calendar days touched by the half-open interval [start, end). */
export function calendarDayCount(start: number, end: number): number {
  const s = new Date(start);
  const e = new Date(end - 1);
  const sd = new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime();
  const ed = new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime();
  return Math.round((ed - sd) / 86400000) + 1;
}

export interface ReportFileOptions {
  range: ReportRange;
  projectId?: string | null;
  /** Custom range bounds (prefixes the filename with the range start instead of "today"). */
  custom?: { start: number; end: number };
  now?: number;
}

function localStamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Save report to `reports/` with a date-prefixed, deduplicated (non-overwriting) filename. */
export function saveReport(paths: LaLogPaths, content: string, opts: ReportFileOptions): string {
  const now = opts.now ?? Date.now();
  const start = opts.custom?.start ?? rangeStart(opts.range, now);
  const endExclusive = opts.custom ? opts.custom.end : rangeEnd(opts.range, now);
  const stamp = opts.custom
    ? `${localStamp(start)}_${localStamp(endExclusive - 1)}`
    : localStamp(start);
  const rangeKey = opts.range === 'custom' ? 'custom' : opts.range;
  const scope = opts.projectId ? '-' + safeSlug(opts.projectId) : '';
  const base = path.join(paths.reportsDir, `${stamp}-${rangeKey}${scope}.md`);
  let file = base;
  let n = 2;
  while (fs.existsSync(file)) {
    file = path.join(paths.reportsDir, `${stamp}-${rangeKey}${scope}-${n}.md`);
    n += 1;
  }
  fs.writeFileSync(file, content);
  return file;
}

function safeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}