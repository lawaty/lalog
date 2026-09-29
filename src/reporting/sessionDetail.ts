/**
 * Session detail as a markdown document.
 *
 * One pure renderer, no I/O and no internal `Date.now()` — the caller supplies
 * `now`, the raw technical sidecar entries, and the retention window. Every
 * section is derived at render time from the append-only session record
 * (codemap invariant: no cached derived aggregates).
 */

import {
  Session,
  TechnicalEntry,
  TechnicalDiff,
  TechnicalTerminal,
  TechnicalAiInteraction,
} from '../core/types';
import { Project } from '../core/projects';
import { splitActiveMinutes } from './spans';
import { effectiveMs } from './insights';
import { fmtDuration } from '../prompts/promptCoordinator';

/** Max characters of a diff body rendered into the document before eliding. */
export const DIFF_PREVIEW_CHARS = 2000;

const DAY_MS = 86_400_000;

export interface SessionDetailInput {
  session: Session;
  project: Project | null;
  /** Raw sidecar entries, ALL types — terminal and AI entries are never pruned. */
  technical: TechnicalEntry[];
  /** null = retention off (keep every diff). */
  retentionDays: number | null;
  now: number;
  idleGapMs: number;
}

/** Local HH:MM. */
export function fmtHM(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Diffs-only retention view of a session's technical entries. */
export interface DiffRetentionView {
  diffs: TechnicalDiff[];
  agedOut: boolean;
}

export function diffRetentionView(
  technical: TechnicalEntry[],
  session: { startedAt: number; events: { saves: number } },
  retentionDays: number | null,
  now: number
): DiffRetentionView {
  const cutoff = retentionDays && retentionDays > 0 ? now - retentionDays * DAY_MS : null;
  const all = technical.filter((e): e is TechnicalDiff => e.type === 'diff');
  if (cutoff === null) return { diffs: all, agedOut: false };
  const within = all.filter((e) => e.ts >= cutoff);
  if (within.length) return { diffs: within, agedOut: false };
  if (all.length) return { diffs: [], agedOut: true };
  const sessionOld = now - session.startedAt >= retentionDays! * DAY_MS;
  return { diffs: [], agedOut: sessionOld && session.events.saves > 0 };
}

export function renderSessionDetail(d: SessionDetailInput): string {
  const s = d.session;
  const split = splitActiveMinutes(s, d.idleGapMs);
  const out: string[] = [];

  out.push(`# Session detail — ${s.workspaceName}`, '');
  out.push(summaryLine(s, d.project), '');
  out.push(
    `**Active ${fmtDuration(effectiveMs(s, d.now, d.idleGapMs))} — in VS Code ${fmtDuration(split.vscodeMs)} · outside VS Code ${fmtDuration(split.outsideMs)}**`,
    ''
  );

  out.push('## Description', '');
  out.push(s.description || '*(none)*', '');

  out.push('## Updates', '');
  const notes = [...(s.notes ?? [])].sort((a, b) => a.at - b.at);
  if (!notes.length) out.push('*(none recorded.)*');
  for (const n of notes) out.push(`- ${fmtHM(n.at)} — ${n.text}`);
  out.push('');

  out.push('## Activity', '');
  out.push(countersLine(s));
  const activityTs = new Set(s.activityTs ?? []);
  for (const span of s.activeSpans ?? []) {
    const where = activityTs.has(span.end) ? 'in VS Code' : 'outside VS Code';
    out.push(`- ${fmtHM(span.start)}–${fmtHM(span.end)} ${where}`);
  }
  out.push('');

  out.push('## Top files', '');
  const files = s.events?.topFiles ?? [];
  if (!files.length) out.push('*(none recorded.)*');
  for (const f of files) out.push(`- ${f.path} · ${f.edits} edits`);
  out.push('');

  out.push('## Git', '');
  const commits = s.commits ?? [];
  if (!s.gitBranch && !commits.length) out.push('*(none recorded.)*');
  if (s.gitBranch) out.push(`- branch: ${s.gitBranch}`);
  for (const c of commits) out.push(`- commit: ${c.subject}`);
  out.push('');

  out.push('## File changes', '');
  out.push(...fileChanges(diffRetentionView(d.technical, s, d.retentionDays, d.now), d.retentionDays));
  out.push('');

  // Terminal and AI entries are kept forever (ADR-026) — they render even when
  // the diffs they sat next to have aged out of the retention window.
  out.push('## Terminal', '');
  const terminal = d.technical.filter((e): e is TechnicalTerminal => e.type === 'terminal');
  if (!terminal.length) out.push('*(none recorded.)*');
  for (const e of terminal) {
    const cwd = e.cwd ? ` · ${e.cwd}` : '';
    out.push(
      `- ${fmtHM(e.ts)} \`${e.commandLine}\` — exit ${e.exitCode ?? '—'} (${Math.round(e.durationMs / 1000)}s)${cwd}`
    );
  }
  out.push('');

  out.push('## AI interactions', '');
  const ai = d.technical.filter((e): e is TechnicalAiInteraction => e.type === 'ai');
  if (!ai.length) out.push('*(none recorded.)*');
  for (const e of ai) {
    out.push(`- ${fmtHM(e.ts)} ${e.task} · ${e.model} · ${e.promptChars}→${e.responseChars} chars`);
  }
  out.push('');

  return out.join('\n');
}

/** Body of the `## File changes` section — shared by the session and day renderers. */
function fileChanges(view: DiffRetentionView, retentionDays: number | null): string[] {
  if (view.agedOut) {
    return [
      `*(File diffs older than the retention window (${retentionDays} days) are no longer available — see lalog.diffRetentionDays.)*`,
    ];
  }
  if (!view.diffs.length) return ['*(No file changes captured.)*'];
  const lines: string[] = [];
  for (const e of [...view.diffs].sort((a, b) => a.ts - b.ts)) {
    lines.push(`- ${fmtHM(e.ts)} ${e.path} +${e.linesAdded} −${e.linesRemoved}`);
    lines.push('', '```diff', elide(e.diff), '```', '');
  }
  return lines;
}

export interface DayDiffsInput {
  day: string;
  sessions: { session: Session; technical: TechnicalEntry[] }[]; // raw entries
  retentionDays: number | null;
  now: number;
}

/**
 * Every session of one local day, rendered as one File-changes document. Same
 * per-session section body as `renderSessionDetail` (ADR-025) — only the
 * framing differs: no description/activity/git/terminal/AI sections, plus a
 * day-level aged-out banner and a totals footer.
 */
export function renderDayDiffs(d: DayDiffsInput): string {
  const ordered = [...d.sessions].sort((a, b) => a.session.startedAt - b.session.startedAt);
  const views = ordered.map((e) => diffRetentionView(e.technical, e.session, d.retentionDays, d.now));

  const out: string[] = [`# File changes — ${d.day}`, ''];
  if (d.retentionDays !== null && views.some((v) => v.agedOut)) {
    out.push(
      `> Some file diffs for this day are older than the retention window (${d.retentionDays} days) and are no longer available — see lalog.diffRetentionDays.`,
      ''
    );
  }
  if (!ordered.length) out.push('*(No sessions recorded for this day.)*', '');
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i].session;
    out.push(`## ${fmtHM(s.startedAt)} ${s.workspaceName} — ${s.description || '*(no description)*'}`, '');
    out.push(...fileChanges(views[i], d.retentionDays));
    out.push('');
  }

  let added = 0;
  let removed = 0;
  for (const v of views) {
    for (const e of v.diffs) {
      added += e.linesAdded;
      removed += e.linesRemoved;
    }
  }
  const n = ordered.length;
  out.push('---', '', `+${added} −${removed} across ${n} session${n === 1 ? '' : 's'}`);

  return out.join('\n');
}

function summaryLine(s: Session, project: Project | null): string {
  const ended = s.endedAt ? `ended ${fmtHM(s.endedAt)}` : '*still open*';
  return `> ${project ? project.name : '*(no project)*'} · started ${fmtHM(s.startedAt)} · ${ended} · ${s.type ?? '*untagged*'} · closed: ${s.closedReason ?? '*still open*'}`;
}

function countersLine(s: Session): string {
  const e = s.events ?? { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0 };
  return `edits ${e.edits ?? 0} · saves ${e.saves ?? 0} · terminal ${e.terminal ?? 0} · file ops ${e.fileops ?? 0} · tasks ${e.tasks ?? 0} · debug ${e.debug ?? 0}`;
}

function elide(body: string): string {
  if (body.length <= DIFF_PREVIEW_CHARS) return body;
  return body.slice(0, DIFF_PREVIEW_CHARS) + '…';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
