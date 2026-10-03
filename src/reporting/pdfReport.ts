import * as fs from 'fs';
import * as path from 'path';
import { Session } from '../core/types';
import { Project, resolveProject, resolveProjectName } from '../core/projects';
import { effectiveMs, hourlyBreakdown } from './insights';
import { splitActiveMinutes } from './spans';
import { ReportRange, rangeStart, rangeEnd, rangeLabel, dayKey } from './ranges';
import { fmtDuration } from '../prompts/promptCoordinator';
import { ReportFileOptions, localStamp, safeSlug } from './report';
import { LaLogPaths } from '../storage/store';
import { DEFAULT_IDLE_GAP_MS } from '../core/config';
import { PdfDoc } from './pdf';

export type PdfPreset = 'personal' | 'client';

/** One of the 13 boolean content toggles (excludes `preset` and `dayMode`). */
export type PdfToggleKey = Exclude<
  keyof PdfOptions,
  'preset' | 'dayMode'
>;

export const PDF_TOGGLE_KEYS: PdfToggleKey[] = [
  'includeSummaryTotals',
  'includeDayTotals',
  'includeTimeRanges',
  'includeDescriptions',
  'includeTaskTypes',
  'includeProjects',
  'includeWorkspaces',
  'includeTopFiles',
  'includeGit',
  'includeNotes',
  'includeInOutSplit',
  'includeEventCounters',
  'includeHourlyLog',
];

export interface PdfOptions {
  preset: PdfPreset;
  /** 'grouped' = one section per day, flowing continuously; 'separate' = each day starts on a fresh page. */
  dayMode: 'grouped' | 'separate';
  includeSummaryTotals: boolean;
  includeDayTotals: boolean;
  includeTimeRanges: boolean; // "09:00-10:30" prefix on rows
  includeDescriptions: boolean;
  includeTaskTypes: boolean;
  includeProjects: boolean;
  includeWorkspaces: boolean;
  includeTopFiles: boolean;
  includeGit: boolean; // branch + commit subjects
  includeNotes: boolean;
  includeInOutSplit: boolean;
  includeEventCounters: boolean;
  includeHourlyLog: boolean;
}

const PERSONAL: PdfOptions = {
  preset: 'personal',
  dayMode: 'grouped',
  includeSummaryTotals: true,
  includeDayTotals: true,
  includeTimeRanges: true,
  includeDescriptions: true,
  includeTaskTypes: true,
  includeProjects: true,
  includeWorkspaces: true,
  includeTopFiles: true,
  includeGit: true,
  includeNotes: true,
  includeInOutSplit: true,
  includeEventCounters: true,
  includeHourlyLog: true,
};

const CLIENT: PdfOptions = {
  preset: 'client',
  dayMode: 'separate',
  includeSummaryTotals: true,
  includeDayTotals: true,
  includeTimeRanges: true,
  includeDescriptions: true,
  includeTaskTypes: false,
  includeProjects: true,
  includeWorkspaces: false,
  includeTopFiles: false,
  includeGit: false,
  includeNotes: false,
  includeInOutSplit: false,
  includeEventCounters: false,
  includeHourlyLog: false,
};

export function pdfPresets(): { personal: PdfOptions; client: PdfOptions } {
  return { personal: { ...PERSONAL }, client: { ...CLIENT } };
}

export function defaultPdfOptions(preset: PdfPreset): PdfOptions {
  return { ...pdfPresets()[preset] };
}

/** Overlay explicit toggles onto the preset defaults; `preset` is always the given one. */
export function resolvePdfOptions(preset: PdfPreset, toggles: Partial<PdfOptions>): PdfOptions {
  return { ...defaultPdfOptions(preset), ...toggles, preset };
}

export interface PdfDayBucket {
  day: string;
  sessions: Session[];
  totalMs: number;
}

export interface PdfModel {
  rangeLabel: string;
  scopeLabel: string;
  days: PdfDayBucket[]; // ascending by local day key
  totalMs: number;
  sessionCount: number;
  vscodeMs: number;
  outsideMs: number;
  /** The `now` the model was built with, so rendering stays free of hidden `Date.now()` calls. */
  now: number;
}

export interface PdfScopeOptions {
  projectId?: string | null;
  custom?: { start: number; end: number };
  /** Live session, folded in when within range (mirrors ReportOptions.activeSession). */
  activeSession?: Session | null;
}

/** Range/scope selection for the PDF layer; content toggles live in PdfOptions. */
export function buildPdfModel(
  sessions: Session[],
  projects: Project[],
  range: ReportRange,
  options: PdfScopeOptions = {},
  now = Date.now(),
  idleGapMs = DEFAULT_IDLE_GAP_MS
): PdfModel {
  const start = options.custom?.start ?? rangeStart(range, now);
  const end = options.custom?.end ?? rangeEnd(range, now);
  let within = sessions.filter((s) => s.startedAt >= start && s.startedAt < end);
  if (options.projectId) {
    within = within.filter((s) => resolveProject(s, projects)?.id === options.projectId);
  }
  const active = options.activeSession;
  if (
    active &&
    !active.endedAt &&
    active.startedAt >= start &&
    active.startedAt < end &&
    (!options.projectId || resolveProject(active, projects)?.id === options.projectId)
  ) {
    within = [...within, active];
  }

  const byDay = new Map<string, Session[]>();
  let totalMs = 0;
  let vscodeMs = 0;
  let outsideMs = 0;
  for (const s of within) {
    const ms = effectiveMs(s, now, idleGapMs);
    const inCode = splitActiveMinutes(s, idleGapMs).vscodeMs;
    totalMs += ms;
    vscodeMs += inCode;
    outsideMs += Math.max(0, ms - inCode);
    const day = dayKey(s.startedAt);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(s);
    else byDay.set(day, [s]);
  }

  const days = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, list]) => ({
      day,
      sessions: [...list].sort((a, b) => a.startedAt - b.startedAt),
      totalMs: list.reduce((sum, s) => sum + effectiveMs(s, now, idleGapMs), 0),
    }));

  return {
    rangeLabel: rangeLabel(range),
    scopeLabel: projects.find((p) => p.id === options.projectId)?.name ?? 'All sessions',
    days,
    totalMs,
    sessionCount: within.length,
    vscodeMs,
    outsideMs,
    now,
  };
}

/** Rendering context the model itself does not carry: project names and the idle gap. */
export interface PdfRenderContext {
  projects?: Project[];
  idleGapMs?: number;
}

const GRAY: [number, number, number] = [0.45, 0.45, 0.45];
const DIM: [number, number, number] = [0.35, 0.35, 0.35];
const HEADING_FILL: [number, number, number] = [0.92, 0.92, 0.92];
const INDENT = 12;

export function renderPdfReport(
  model: PdfModel,
  options: PdfOptions,
  ctx: PdfRenderContext = {}
): Buffer {
  const projects = ctx.projects ?? [];
  const now = model.now;
  const idleGapMs = ctx.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const doc = new PdfDoc();
  const left = doc.margin;
  const right = doc.width - doc.margin;

  const detail = (str: string): void => {
    doc.text(str, { x: left + INDENT, size: 9, color: DIM, maxWidth: doc.contentWidth - INDENT });
  };

  const heading = (day: string, total: string | null): void => {
    doc.ensureSpace(24);
    const y = doc.cursorY;
    doc.rect(left - 4, y - 3, doc.contentWidth + 8, 18, { fill: HEADING_FILL });
    if (total) doc.text(total, { x: right - doc.measure(total, 10), y: y + 4, size: 10 });
    doc.text(day, { x: left, size: 12, font: 'Helvetica-Bold' });
  };

  const sessionRow = (s: Session): void => {
    const head: string[] = [];
    if (options.includeTimeRanges) {
      head.push(s.endedAt ? `${hm(s.startedAt)}-${hm(s.endedAt)}` : `${hm(s.startedAt)}-now`);
    }
    head.push(fmtDuration(effectiveMs(s, now, idleGapMs)));
    if (options.includeTaskTypes && s.type) head.push(s.type);
    if (options.includeProjects) head.push(resolveProjectName(s, projects));
    if (options.includeWorkspaces) head.push(s.workspaceName);
    doc.text(head.join(' · '), { x: left, size: 10, font: 'Helvetica-Bold', maxWidth: doc.contentWidth });

    if (options.includeDescriptions) {
      const desc = s.description
        ? s.description
        : s.anonymous
          ? '(background work)'
          : s.needsDescription
            ? '(no description)'
            : '';
      if (desc) detail(desc);
    }
    if (options.includeTopFiles && s.events?.topFiles?.length) {
      detail(`Files: ${s.events.topFiles.slice(0, 5).map((f) => path.basename(f.path)).join(', ')}`);
    }
    if (options.includeGit) {
      if (s.gitBranch) detail(`Branch: ${s.gitBranch}`);
      if (s.commits?.length) detail(`Commits: ${s.commits.map((c) => c.subject).join(', ')}`);
    }
    if (options.includeNotes) {
      for (const n of s.notes) detail(`Note ${hm(n.at)}: ${n.text}`);
    }
    if (options.includeInOutSplit) {
      const bx = splitActiveMinutes(s, idleGapMs);
      detail(`${fmtDuration(bx.vscodeMs)} in VS Code / ${fmtDuration(bx.outsideMs)} outside`);
    }
    if (options.includeEventCounters) detail(eventCounters(s));
  };

  doc.text(`LaLog — ${model.rangeLabel}`, {
    x: left,
    size: 16,
    font: 'Helvetica-Bold',
    lineGap: 4,
  });
  doc.text(model.scopeLabel, { x: left, size: 10, font: 'Helvetica-Oblique', color: GRAY });
  if (options.includeSummaryTotals) {
    doc.text(`Active time: ${fmtDuration(model.totalMs)} across ${model.sessionCount} session(s)`, {
      x: left,
      size: 10,
      maxWidth: doc.contentWidth,
    });
    if (options.includeInOutSplit) {
      doc.text(`In VS Code: ${fmtDuration(model.vscodeMs)} · Outside: ${fmtDuration(model.outsideMs)}`, {
        x: left,
        size: 10,
        color: GRAY,
        maxWidth: doc.contentWidth,
      });
    }
  }

  for (let i = 0; i < model.days.length; i++) {
    if (options.dayMode === 'separate' && i > 0) doc.addPage();
    const day = model.days[i];
    heading(day.day, options.includeDayTotals ? fmtDuration(day.totalMs) : null);
    for (const s of day.sessions) sessionRow(s);
  }

  if (options.includeHourlyLog && model.days.length === 1) {
    const start = dayStartMs(model.days[0].day);
    const hours = hourlyBreakdown(model.days[0].sessions, projects, start, nextDayMs(start), idleGapMs);
    if (hours.length) {
      doc.ensureSpace(20);
      doc.text('Hourly log', { x: left, size: 11, font: 'Helvetica-Bold' });
      for (const h of hours) {
        doc.text(`- ${hm(h.hourStart)} — ${fmtDuration(h.ms)} — ${h.projectName}`, {
          x: left + INDENT,
          size: 9,
          color: DIM,
          maxWidth: doc.contentWidth - INDENT,
        });
      }
    }
  }

  return doc.save();
}

/** Save to `reports/` with `saveReport`'s date-prefixed, non-overwriting filename and a .pdf extension. */
export function savePdfReport(paths: LaLogPaths, content: Buffer, opts: ReportFileOptions): string {
  const now = opts.now ?? Date.now();
  const start = opts.custom?.start ?? rangeStart(opts.range, now);
  const endExclusive = opts.custom ? opts.custom.end : rangeEnd(opts.range, now);
  const stamp = opts.custom
    ? `${localStamp(start)}_${localStamp(endExclusive - 1)}`
    : localStamp(start);
  const rangeKey = opts.range === 'custom' ? 'custom' : opts.range;
  const scope = opts.projectId ? '-' + safeSlug(opts.projectId) : '';
  const base = path.join(paths.reportsDir, `${stamp}-${rangeKey}${scope}.pdf`);
  let file = base;
  let n = 2;
  while (fs.existsSync(file)) {
    file = path.join(paths.reportsDir, `${stamp}-${rangeKey}${scope}-${n}.pdf`);
    n += 1;
  }
  fs.writeFileSync(file, content);
  return file;
}

function eventCounters(s: Session): string {
  const parts: string[] = [];
  const push = (n: number | undefined, word: string): void => {
    if (n) parts.push(`${n} ${word}`);
  };
  push(s.events?.edits, 'edits');
  push(s.events?.saves, 'saves');
  push(s.events?.terminal, 'terminal');
  push(s.events?.fileops, 'fileop');
  push(s.events?.tasks, 'task');
  push(s.events?.debug, 'debug');
  push(s.events?.opencode, 'opencode');
  return parts.length ? parts.join(' · ') : 'no events recorded';
}

function hm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function nextDayMs(ms: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
