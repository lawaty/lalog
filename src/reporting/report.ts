import * as fs from 'fs';
import * as path from 'path';
import { Session } from '../core/types';
import { fmtDuration } from '../prompts/promptCoordinator';
import { LaLogPaths } from '../storage/store';

export type ReportRange = 'today' | 'yesterday' | 'week' | 'month' | 'last-month' | 'custom';

/** Session-centric markdown report. Sessions are NEVER split across days. */
export async function generateReport(
  sessions: Session[],
  range: ReportRange,
  now = Date.now()
): Promise<string> {
  const start = rangeStart(range, now);
  const end = rangeEnd(range, now);
  const within = sessions.filter(
    (s) => s.startedAt >= start && s.startedAt < end && s.endedAt
  );

  const totalActive = within.reduce((sum, s) => sum + s.activeMinutes, 0) * 60000;
  const byProject = new Map<string, number>();
  for (const s of within) {
    byProject.set(s.workspaceName, (byProject.get(s.workspaceName) ?? 0) + s.activeMinutes * 60000);
  }

  const dayOrder: string[] = [];
  for (const s of within) {
    const d = s.startedAt;
    const key = new Date(d).toISOString().slice(0, 10);
    if (!dayOrder.includes(key)) dayOrder.push(key);
  }
  dayOrder.sort();
  const days = dayOrder.join(', ');

  const lines: string[] = [];
  lines.push(`# LaLog — ${rangeLabel(range)}`);
  lines.push('');
  lines.push(`**Active time: ${fmtDuration(totalActive)}** across ${within.length} session(s)`);
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

  lines.push('## Sessions');
  for (const s of [...within].sort((a, b) => a.startedAt - b.startedAt)) {
    const start = new Date(s.startedAt).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const end = s.endedAt ? new Date(s.endedAt).toLocaleString([], { hour: '2-digit', minute: '2-digit' }) : '?';
    const desc = s.description ? ` — ${s.description}` : s.needsDescription ? ' *(no description)*' : '';
    lines.push(
      `### ${start} → ${end} · ${fmtDuration(s.activeMinutes * 60000)} · ${s.workspaceName}${s.type ? ` · ${s.type}` : ''}`
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

export function rangeStart(r: ReportRange, now: number): number {  const d = new Date(now);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  switch (r) {
    case 'today':
      return startOfDay;
    case 'yesterday':
      return startOfDay - 86400000;
    case 'week': {
      const day = d.getDay() || 7; // Monday = 1
      return startOfDay - (day - 1) * 86400000;
    }
    case 'month':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    case 'last-month':
      return new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    case 'custom':
      return 0;
  }
}

export function rangeEnd(r: ReportRange, now: number): number {
  const d = new Date(now);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  switch (r) {
    case 'today':
      return startOfDay + 86400000;
    case 'yesterday':
      return startOfDay;
    case 'week': {
      const day = d.getDay() || 7;
      return startOfDay - (day - 1) * 86400000 + 7 * 86400000;
    }
    case 'month':
      return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    case 'last-month':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    case 'custom':
      return Number.MAX_SAFE_INTEGER;
  }
}

export function rangeLabel(r: ReportRange): string {
  switch (r) {
    case 'today':
      return 'Today';
    case 'yesterday':
      return 'Yesterday';
    case 'week':
      return 'This Week';
    case 'month':
      return 'This Month';
    case 'last-month':
      return 'Last Month';
    case 'custom':
      return 'Custom';
  }
}

/** Save report and return its path. */
export function saveReport(paths: LaLogPaths, content: string, now = Date.now()): string {
  const d = new Date(now);
  const file = path.join(paths.reportsDir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.md`);
  fs.writeFileSync(file, content);
  return file;
}
