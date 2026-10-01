import * as vscode from 'vscode';
import type { Session } from '../core/types';
import { splitActiveMinutes } from '../reporting/spans';
import { Project, resolveProject } from '../core/projects';
import { SessionStore } from '../storage/sessionStore';
import { ProjectRegistry } from '../storage/projectRegistry';
import {
  insightsFor,
  effectiveMs,
  InsightsSnapshot,
} from '../reporting/insights';
import { rangeStart, rangeEnd, dayKey } from '../reporting/ranges';
import { fmtHM } from '../reporting/sessionDetail';

/**
 * The whole LaLog panel in ONE webview view: tabbed content (Sessions /
 * Insights / Projects) scrolling above, and the pinned "Current Session" box as
 * a fixed, non-scrolling footer at the bottom. This is the only way to get a
 * genuinely pinned prompt-style box (like Copilot Chat's) — a standalone view
 * always gets a resize/move divider, and a box that isn't glued to the view
 * bottom moves when the divided space changes.
 */

export interface PanelNow {
  todayActiveMs: number;
  paused: boolean;
  idleGap: number;
  wsKey: string;
  wsName: string;
  wsPath: string;
  /** `lalog.multiProject`: false = one project per workspace, named from VS Code (ADR-030). */
  multiProject: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  color: string;
  workspaceKeys: string[];
  pathHints: string[];
  archived: boolean;
  weekMs: number;
  sessionCount: number;
}

interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number | undefined;
  workspaceKey: string;
  workspaceName: string;
  description: string | null;
  needsDescription: boolean;
  anonymous: boolean;
  projectId: string | null;
  projectName: string | null;
  projectColor: string | null;
  type: string | null;
  closedReason: string | null;
  activeMinutes: number;
  lastActivityAt: number;
  gitBranch: string | null;
  commits: string[]; // subject lines
  events: {
    edits: number;
    saves: number;
    terminal: number;
    fileops: number;
    tasks: number;
    debug: number;
    topFiles: { path: string; edits: number }[];
  };
  notes: { at: number; text: string }[];
  split: { totalMs: number; vscodeMs: number; outsideMs: number };
}

interface DayGroup {
  day: string;
  count: number;
  totals: number;
  sessions: SessionSummary[];
}

function summarize(s: Session, idleGapMs: number, projects: Project[]): SessionSummary {
  const split = splitActiveMinutes(s, idleGapMs);
  const proj = resolveProject(s, projects);
  return {
    id: s.id,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    workspaceKey: s.workspaceKey,
    workspaceName: s.workspaceName,
    description: s.description ?? null,
    needsDescription: !!s.needsDescription,
    anonymous: !!s.anonymous,
    projectId: proj?.id ?? null,
    projectName: proj?.name ?? null,
    projectColor: proj?.color ?? null,
    type: s.type ?? null,
    closedReason: s.closedReason ?? null,
    activeMinutes: s.activeMinutes,
    lastActivityAt: s.lastActivityAt,
    gitBranch: s.gitBranch ?? null,
    commits: (s.commits ?? []).map((c) => c.subject),
    events: s.events ?? { edits: 0, saves: 0, terminal: 0, fileops: 0, tasks: 0, debug: 0 },
    notes: (s.notes ?? []).map((n) => ({ at: n.at, text: n.text })),
    split: { totalMs: split.totalMs, vscodeMs: split.vscodeMs, outsideMs: split.outsideMs },
  };
}

function groupByDay(sessions: Session[], idleGapMs: number, projects: Project[]): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const s of sessions) {
    const day = dayKey(s.startedAt);
    let g = map.get(day);
    if (!g) {
      g = { day, count: 0, totals: 0, sessions: [] };
      map.set(day, g);
    }
    g.count += 1;
    g.totals += s.activeMinutes;
    g.sessions.push(summarize(s, idleGapMs, projects));
  }
  return [...map.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .map((g) => ({ ...g, sessions: g.sessions.sort((a, b) => b.startedAt - a.startedAt) }));
}

interface InsightsMap {
  today: InsightsSnapshot;
  week: InsightsSnapshot;
  month: InsightsSnapshot;
}

export class LaLogPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'lalog.sessionsView';

  private view: vscode.WebviewView | null = null;
  private insights: InsightsMap = {
    today: emptyInsight(),
    week: emptyInsight(),
    month: emptyInsight(),
  };

  constructor(
    private getSessions: () => Promise<Session[]>,
    private getActive: () => Session | null,
    private getNow: () => PanelNow,
    private store: SessionStore,
    private registry: ProjectRegistry,
    private assignActive: (projectId: string | undefined) => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();

    webviewView.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      this.handleMessage(message);
    });

    void this.pushState();
  }

  /** Re-render the panel (sessions + Now footer) from fresh data. */
  refresh(): void {
    void this.pushState();
  }

  private async pushState(): Promise<void> {
    if (!this.view) return;
    const [sessions, active, now] = await Promise.all([
      this.getSessions(),
      Promise.resolve(this.getActive()),
      Promise.resolve(this.getNow()),
    ]);
    if (!this.view) return; // panel may have been disposed while awaiting
    const projects = this.registry.list();
    const nowTs = Date.now();
    const insSessions = active ? [...sessions, active] : sessions;

    this.insights = {
      today: insightsFor(insSessions, projects, 'today', nowTs, now.idleGap),
      week: insightsFor(insSessions, projects, 'week', nowTs, now.idleGap),
      month: insightsFor(insSessions, projects, 'month', nowTs, now.idleGap),
    };

    const weekStart = rangeStart('week', nowTs);
    const weekEnd = rangeEnd('week', nowTs);
    const weekSessions = sessions.filter((s) => s.startedAt >= weekStart && s.startedAt < weekEnd);

    void this.view.webview.postMessage({
      type: 'state',
      now: nowTs,
      groups: groupByDay(sessions, now.idleGap, projects),
      active: active ? summarize(active, now.idleGap, projects) : null,
      todayActiveMs: now.todayActiveMs,
      paused: now.paused,
      idleGap: now.idleGap,
      // Single mode shows this window's project only (renaming another
      // workspace's project from a different window would be a footgun);
      // multi mode keeps the whole machine's catalog for management.
      projects: (now.multiProject ? projects : projects.filter((p) => p.workspaceKeys.includes(now.wsKey))).map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        workspaceKeys: p.workspaceKeys,
        pathHints: p.pathHints,
        archived: !!p.archivedAt,
        weekMs: weekSessions
          .filter((s) => resolveProject(s, projects)?.id === p.id)
          .reduce((sum, s) => sum + effectiveMs(s, nowTs, now.idleGap), 0),
        sessionCount: sessions.filter((s) => resolveProject(s, projects)?.id === p.id).length,
      })),
      insights: this.insights,
      multiProject: now.multiProject,
      wsKey: now.wsKey,
      wsName: now.wsName,
      wsPath: now.wsPath,
    });
  }

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    const type = message?.type;
    const id = typeof message.id === 'string' ? message.id : undefined;
    const now = this.getNow();
    switch (type) {
      case 'edit':
        if (id) void vscode.commands.executeCommand('lalog.editSession', id);
        return;
      case 'delete':
        if (id) void vscode.commands.executeCommand('lalog.deleteSession', id);
        return;
      case 'openSessionDetail':
        if (id) void vscode.commands.executeCommand('lalog.sessionDetail', id);
        return;
      case 'openHourSessions': {
        const ids = [
          ...new Set(
            (Array.isArray(message.ids) ? message.ids : []).filter((x) => typeof x === 'string')
          ),
        ];
        if (!ids.length) return;
        if (ids.length === 1) {
          void vscode.commands.executeCommand('lalog.sessionDetail', ids[0]);
          return;
        }
        const all = await this.getSessions();
        const active = this.getActive();
        const pool = active ? [...all, active] : all;
        const items = ids
          .map((sid) => pool.find((s) => s.id === sid))
          .filter((s): s is Session => !!s)
          .sort((a, b) => a.startedAt - b.startedAt)
          .map((s) => ({
            label: `${fmtHM(s.startedAt)} · ${s.workspaceName}${s.description ? ' — ' + s.description : ''}`,
            id: s.id,
          }));
        if (!items.length) return;
        const pick = await vscode.window.showQuickPick(items, {
          title: 'Sessions in this hour',
          placeHolder: 'Open session detail',
        });
        if (pick) void vscode.commands.executeCommand('lalog.sessionDetail', pick.id);
        return;
      }
      case 'openDayDiffs': {
        const day = typeof message.day === 'string' ? message.day : undefined;
        if (day) void vscode.commands.executeCommand('lalog.dayDiffs', day);
        return;
      }
      case 'pause':
        void vscode.commands.executeCommand('lalog.pauseSession');
        return;
      case 'resume':
        void vscode.commands.executeCommand('lalog.resumeSession');
        return;
      case 'end':
        void vscode.commands.executeCommand('lalog.endSessionRestart');
        return;
      case 'markAnonymous': {
        if (!id) return;
        const value = message.value === true;
        const sessions = await this.getSessions();
        const s = sessions.find((x) => x.id === id);
        if (!s) return;
        await this.store.updateSession(s.id, {
          anonymous: value ? true : undefined,
          needsDescription: value ? false : s.needsDescription,
        });
        this.refresh();
        return;
      }
      case 'assign': {
        if (!id) return;
        const active = this.getActive();
        const projects = this.registry.list();
        if (active && active.id === id) {
          // Live session: mutate through the manager (in-memory + active snapshot).
          const pick = await vscode.window.showQuickPick(
            [
              { label: '$(circle-slash) No project', id: '' },
              ...projects.map((p) => ({ label: `${p.name}`, id: p.id })),
            ],
            { title: `Assign current session`, placeHolder: 'Choose a project' }
          );
          if (!pick) return;
          this.assignActive(pick.id ? pick.id : undefined);
          this.refresh();
          return;
        }
        const sessions = await this.getSessions();
        const s = sessions.find((x) => x.id === id);
        if (!s) return;
        const pick = await vscode.window.showQuickPick(
          [
            { label: '$(circle-slash) No project', id: '' },
            ...projects.map((p) => ({ label: `${p.name}`, id: p.id })),
          ],
          { title: `Assign session (${s.workspaceName})`, placeHolder: 'Choose a project' }
        );
        if (!pick) return;
        await this.store.updateSession(s.id, {
          projectId: pick.id ? pick.id : undefined,
        });
        this.refresh();
        return;
      }
      case 'newProject': {
        if (!now.multiProject) return;
        const name = await vscode.window.showInputBox({
          title: 'New project',
          placeHolder: 'project name',
          prompt: 'e.g. "LaLog" — it will claim the current workspace.',
          ignoreFocusOut: true,
        });
        if (!name?.trim()) return;
        this.registry.create({ name, workspaceKey: now.wsKey, pathHint: now.wsPath });
        this.refresh();
        return;
      }
      case 'newProjectFromWorkspace': {
        if (!now.multiProject) return;
        this.registry.create({ name: now.wsName || 'Project', workspaceKey: now.wsKey, pathHint: now.wsPath });
        this.refresh();
        return;
      }
      case 'claimWorkspace': {
        if (!now.multiProject) return;
        this.registry.addClaim(String(message.projectId ?? id ?? ''), now.wsKey, now.wsPath);
        this.refresh();
        return;
      }
      case 'archiveProject': {
        if (!now.multiProject) return;
        if (!id) return;
        const p = this.registry.get(id);
        if (p) this.registry.archive(id, !p.archivedAt);
        this.refresh();
        return;
      }
      case 'renameProject': {
        // Always available: renaming this workspace's project is the one
        // project action the default mode needs (the rename sticks).
        if (id) void vscode.commands.executeCommand('lalog.renameProject', id);
        return;
      }
    }
  }

  dispose(): void {
    this.view = null;
  }

  private html(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    height: 100vh; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
  }
  #tabs { display: flex; gap: 2px; padding: 6px 8px 0; flex-shrink: 0; }
  .tab {
    flex: 1; appearance: none; border: 1px solid var(--vscode-button-border, transparent);
    background: transparent; color: var(--vscode-descriptionForeground);
    border-radius: 4px 4px 0 0; padding: 3px 0; cursor: pointer; font-size: 11px;
    letter-spacing: .4px;
  }
  .tab.active { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.15)); color: var(--vscode-foreground); font-weight: 600; }
  .tab:hover:not(.active) { background: var(--vscode-list-hoverBackground); }
  #list { flex: 1 1 auto; overflow-y: auto; padding: 6px 0; }
  #now { flex-shrink: 0; }

  .chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 10px 6px; }
  .chip {
    appearance: none; border: 1px solid var(--vscode-input-border, transparent); background: transparent;
    color: var(--vscode-descriptionForeground); border-radius: 10px; padding: 1px 8px; font-size: 11px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 4px;
    max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .chip.on { background: var(--vscode-button-secondaryBackground); color: var(--vscode-foreground); }
  .chipdot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }

  .day { font-weight: 600; display: flex; align-items: center; gap: 6px; padding: 5px 10px 3px; cursor: pointer; }
  .day .caret, .row .caret { width: 12px; flex-shrink: 0; }
  .day .label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row { display: flex; align-items: center; gap: 6px; padding: 3px 10px 3px 22px; cursor: pointer; border-radius: 4px; }
  .row:hover, .day:hover { background: var(--vscode-list-hoverBackground); }
  .row .label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .half { opacity: .7; white-space: nowrap; }
  .row.warn { color: var(--vscode-list-warningForeground, var(--vscode-editorWarning-foreground)); }
  .row.anon { opacity: .72; }
  .projdot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .icon { min-width: 14px; text-align: center; opacity: .85; flex: 0 0 auto; }
  .hidden { display: none; }

  .updates { padding: 0 10px 2px 34px; }
  .drow { display: flex; align-items: center; gap: 6px; padding: 2px 0; min-width: 0; flex-wrap: wrap; row-gap: 2px; }
  .drow .label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .drow .half { opacity: .75; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .drow.act { cursor: pointer; border-radius: 3px; }
  .drow.act:hover { background: var(--vscode-list-hoverBackground); }
  .git-desc { white-space: normal; word-break: break-word; }
  .sub { padding: 0 0 0 14px; }
  .ph { font-style: italic; opacity: .7; padding: 6px 10px; }

  .editbtn {
    appearance: none; border: none; background: transparent; color: inherit; cursor: pointer;
    padding: 1px 4px; border-radius: 3px; font-size: 12px; flex-shrink: 0;
  }
  .editbtn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .delbtn:hover { background: var(--vscode-inputValidation-errorBackground, var(--vscode-toolbar-hoverBackground)); }

  .card {
    display: flex; flex-direction: column; gap: 6px;
    margin: 0 8px 8px; padding: 10px 12px;
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-sideBar-border));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.12);
    overflow: hidden;
  }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; row-gap: 4px; }
  .name { flex: 1 1 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pill { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; max-width: 100%; font-size: 11px; color: var(--vscode-descriptionForeground); }
  #projname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pillbtn { cursor: pointer; background: none; border: 1px solid var(--vscode-button-border, transparent); border-radius: 10px; padding: 1px 7px; }
  .pillbtn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #2ea043; }
  .dot.paused { background: #d4a72c; }
  .desc { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .desc.placeholder { font-style: italic; }
  .meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; row-gap: 2px; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .meta span { white-space: nowrap; }
  .clock { font-size: 17px; font-weight: 500; color: var(--vscode-foreground); }
  .actions { display: flex; gap: 6px; }
  button {
    flex: 1; appearance: none; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger { background: transparent; border-color: var(--vscode-inputValidation-errorBorder, #f14c4c); color: var(--vscode-errorForeground, #f14c4c); }
  button.danger:hover { background: var(--vscode-inputValidation-errorBackground, rgba(241, 76, 76, 0.15)); }
  button.warn { background: transparent; border-color: var(--vscode-inputValidation-warningBorder, #cca700); color: var(--vscode-editorWarning-foreground, #cca700); }
  button.warn:hover { background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.15)); }
  .sec { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.75; margin-bottom: 2px; }

  .ptoggle { display: flex; gap: 2px; padding: 2px 10px 6px; }
  .ptoggle .tab { border-radius: 4px; }

  .bar { display: flex; align-items: center; gap: 6px; padding: 2px 10px; }
  .bar .name { flex: 0 1 110px; min-width: 0; font-size: 12px; font-weight: 400; }
  .bar .track { flex: 1; height: 10px; border-radius: 5px; background: var(--vscode-editorWidget-border, rgba(128,128,128,.2)); overflow: hidden; }
  .bar .fill { height: 100%; border-radius: 5px; }
  .bar .val { flex: 0 0 52px; text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; }

  .tlwrap { padding: 2px 10px; }
  .tlday { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .tlday .label { flex: 0 1 82px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .tlday.clickable .label { cursor: pointer; }
  .tlday.clickable .label:hover { text-decoration: underline; }
  .tlbar { flex: 1; display: flex; gap: 1px; height: 10px; border-radius: 3px; overflow: hidden; }
  .tlcell { flex: 1; }
  .tlval { flex: 0 0 56px; text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
  .tlaxis { display: flex; gap: 1px; }
  .tlaxis .tlah { flex: 3; font-size: 9px; opacity: .75; }
  .tlkey { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 4px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .tlkeyit { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .loaderwrap {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; padding: 28px 16px; color: var(--vscode-descriptionForeground); font-size: 12px;
  }
  .loaderwrap .note { font-style: italic; opacity: .8; text-align: center; }
  .spinner {
    width: 20px; height: 20px; border-radius: 50%;
    border: 2px solid var(--vscode-button-secondaryBackground, rgba(128,128,128,.25));
    border-top-color: var(--vscode-buttonForeground, #999);
    animation: lalog-spin .8s linear infinite;
  }
  @keyframes lalog-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation-duration: 1.6s; }
  }
</style>
</head>
<body>
  <div id="tabs">
    <button class="tab active" id="tabSessions">Sessions</button>
    <button class="tab" id="tabInsights">Insights</button>
    <button class="tab" id="tabProjects">Projects</button>
  </div>
  <div id="list"></div>
  <div id="now">
    <div class="card">
      <div class="sec">Current Session</div>
      <div class="head">
        <span class="name" id="name">LaLog</span>
        <button id="btnProject" class="pill pillbtn" title="Assign project to current session">
          <span class="projdot" id="projdot"></span><span id="projname">No project</span>
        </button>
        <span class="pill"><span class="dot" id="dot"></span><span id="status">&mdash;</span></span>
      </div>
      <div class="desc placeholder" id="desc">no session yet</div>
      <div class="meta">
        <span class="clock" id="clock">00:00:00</span>
        <span id="active">&mdash;</span>
        <span id="today">&mdash;</span>
      </div>
      <div class="actions">
        <button class="warn" id="btnPause">Pause</button>
        <button class="warn hidden" id="btnResume">Resume</button>
        <button class="danger" id="btnEnd" title="End this session &amp; start a fresh one">End</button>
      </div>
    </div>
  </div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const el = (id) => document.getElementById(id);
  const open = { days: new Set() };
  const userCollapsed = new Set();
  let lastState = null;
  let activeTab = 'sessions';
  let period = 'week';
  let filterProject = null;
  let tlFilter = null;

  function showLoading(message) {
    const wrap = el2('div', 'loaderwrap');
    wrap.appendChild(el2('div', 'spinner'));
    wrap.appendChild(el2('div', 'note', message));
    list.textContent = '';
    list.appendChild(wrap);
    el('status').textContent = 'loading';
    el('desc').textContent = 'loading sessions\u2026';
    el('desc').classList.add('placeholder');
  }

  function render() {
    if (lastState) renderAll();
    else showLoading('Loading your sessions\u2026');
  }

  showLoading('Loading your sessions\u2026');

  el('btnPause').addEventListener('click', () => vscode.postMessage({ type: 'pause' }));
  el('btnResume').addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
  el('btnEnd').addEventListener('click', () => vscode.postMessage({ type: 'end' }));
  el('btnProject').addEventListener('click', () => {
    if (lastState && lastState.active) vscode.postMessage({ type: 'assign', id: lastState.active.id });
  });
  bindTab(el('tabSessions'), 'sessions');
  bindTab(el('tabInsights'), 'insights');
  bindTab(el('tabProjects'), 'projects');

  function bindTab(btn, tab) {
    btn.addEventListener('click', () => { activeTab = tab; render(); });
  }

  function el2(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderAll() {
    setTabs();
    if (activeTab === 'sessions') renderSessions();
    else if (activeTab === 'insights') renderInsights();
    else renderProjects();
    renderNow();
  }

  function setTabs() {
    el('tabSessions').classList.toggle('active', activeTab === 'sessions');
    el('tabInsights').classList.toggle('active', activeTab === 'insights');
    el('tabProjects').classList.toggle('active', activeTab === 'projects');
  }

  function matchesFilter(s) {
    if (!filterProject) return true;
    if (filterProject === 'unassigned') return !s.projectId;
    return s.projectId === filterProject;
  }

  function renderSessions() {
    const st = lastState;
    list.textContent = '';

    const chips = el2('div', 'chips');
    const addChip = (label, dot, key) => {
      const c = el2('button', 'chip' + (filterProject === key ? ' on' : ''), label);
      if (dot) {
        const d = el2('span', 'chipdot');
        d.style.background = dot;
        c.appendChild(d);
      }
      c.addEventListener('click', () => {
        filterProject = filterProject === key ? null : key;
        renderAll();
      });
      chips.appendChild(c);
    };
    addChip('All', null, null);
    const seen = new Set();
    for (const p of st.projects) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      addChip(p.name, p.color, p.id);
    }
    addChip('Unassigned', '#8a8a8a', 'unassigned');
    list.appendChild(chips);

    const groups = st.groups
      .map((g) => ({ ...g, sessions: g.sessions.filter(matchesFilter) }))
      .filter((g) => g.sessions.length);
    renderGroups(groups);
  }

  function renderGroups(groups) {
    if (!groups.length) {
      list.appendChild(el2('div', 'ph', 'no sessions here yet'));
      return;
    }
    // Always show the most recent day unless the user explicitly collapsed it.
    if (!userCollapsed.has(groups[0].day)) open.days.add(groups[0].day);
    for (const g of groups) {
      const isOpen = open.days.has(g.day);
      const dayRow = el2('div', 'day');
      dayRow.appendChild(el2('span', 'caret', isOpen ? '\u25bc' : '\u25b6'));
      const dayLabel = g.day + ' \u2014 ' + g.count + ' session' + (g.count > 1 ? 's' : '') + ', ' + fmtDur(g.totals);
      dayRow.appendChild(el2('span', 'label', dayLabel));
      dayRow.addEventListener('click', () => {
        if (isOpen) { open.days.delete(g.day); userCollapsed.add(g.day); }
        else { open.days.add(g.day); userCollapsed.delete(g.day); }
        renderSessions();
      });
      list.appendChild(dayRow);

      if (!isOpen) continue;
      for (const s of g.sessions) list.appendChild(sessionNode(s));
    }
  }

  function stateIcon(s) {
    if (s.anonymous) return '\u25cb';
    if (s.needsDescription && !s.description) return '\u26a0';
    return '\u2713';
  }

  function sessionNode(s) {
    const wrap = document.createElement('div');
    const cls = 'row' + (s.needsDescription && !s.description && !s.anonymous ? ' warn' : '') + (s.anonymous ? ' anon' : '');
    const header = el2('div', cls);
    header.appendChild(el2('span', 'icon', stateIcon(s)));
    const d = el2('span', 'projdot');
    d.title = 'Assign project';
    d.style.cursor = 'pointer';
    if (s.projectColor) d.style.background = s.projectColor;
    d.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'assign', id: s.id }); });
    header.appendChild(d);
    const label = fmtHM(s.startedAt) + ' \u00b7 ' + s.workspaceName +
      (s.description ? ' \u2014 ' + s.description : s.anonymous ? ' \u2014 background' : s.needsDescription ? ' \u2014 (needs description)' : '');
    header.appendChild(el2('span', 'label', label));
    header.appendChild(el2('span', 'half', fmtDur(s.activeMinutes)));
    const editBtn = el2('button', 'editbtn', '\u270e');
    editBtn.title = 'Edit description';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'edit', id: s.id }); });
    header.appendChild(editBtn);
    const delBtn = el2('button', 'editbtn delbtn', '\ud83d\uddd1');
    delBtn.title = 'Delete session';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'delete', id: s.id }); });
    header.appendChild(delBtn);
    header.title = 'Open session detail';
    header.addEventListener('click', () => vscode.postMessage({ type: 'openSessionDetail', id: s.id }));
    wrap.appendChild(header);

    // One always-visible row per progress-update note, timestamped.
    const updates = el2('div', 'updates');
    for (const n of s.notes.slice().sort((a, b) => a.at - b.at)) {
      updates.appendChild(drow('\ud83d\udcac', n.text, fmtHM(n.at)));
    }
    wrap.appendChild(updates);

    if (s.anonymous) {
      wrap.appendChild(actionRow('\u270e', 'Not background work anymore (allow prompts)', () => vscode.postMessage({ type: 'markAnonymous', id: s.id, value: false })));
    } else if (s.needsDescription && !s.description) {
      wrap.appendChild(actionRow('\u25cb', 'Keep as background work', () => vscode.postMessage({ type: 'markAnonymous', id: s.id, value: true })));
    }
    return wrap;
  }

  function drow(icon, label, half) {
    const row = el2('div', 'drow');
    if (icon) row.appendChild(el2('span', 'icon', icon));
    const l = el2('span', 'label', label);
    if (label && label.length > 120) l.classList.add('git-desc');
    row.appendChild(l);
    if (half) {
      row.appendChild(el2('span', 'half', half));
    }
    return row;
  }

  function actionRow(icon, label, onClick) {
    const row = el2('div', 'drow act');
    row.appendChild(el2('span', 'icon', icon));
    row.appendChild(el2('span', 'label', label));
    row.addEventListener('click', onClick);
    return row;
  }

  function fmtHM(t) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDur(ms) {
    const min = Math.round(ms / 60000);
    const h = Math.floor(min / 60), r = min % 60;
    return h > 0 ? h + 'h ' + r + 'm' : r + 'm';
  }
  function fmtDur2(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p = (n) => String(n).padStart(2, '0');
    return p(h) + ':' + p(m) + ':' + p(s);
  }
  function fmtClock(t) {
    const dt = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds());
  }

  function renderInsights() {
    const st = lastState;
    list.textContent = '';
    const ins = st.insights[period];

    const toggle = el2('div', 'ptoggle');
    for (const p of ['today', 'week', 'month']) {
      const b = el2('button', 'tab' + (period === p ? ' active' : ''), p[0].toUpperCase() + p.slice(1));
      b.addEventListener('click', () => { period = p; renderInsights(); });
      toggle.appendChild(b);
    }
    list.appendChild(toggle);

    list.appendChild(row2('Total active', fmtDur(ins.totalMs), ''));
    list.appendChild(row2('In VS Code', fmtDur(ins.vscodeMs), 'outside ' + fmtDur(ins.outsideMs)));
    list.appendChild(el2('div', 'ph', ins.count + ' session' + (ins.count === 1 ? '' : 's') + ' in this period' + (ins.totalMs && ins.count ? ' \u00b7 ' + fmtDur(ins.totalMs / ins.count) + ' avg' : '')));

    list.appendChild(el2('div', 'sec', 'By project'));
    const max = Math.max(1, ins.byProject[0] ? ins.byProject[0].ms : 1);
    for (const p of ins.byProject) {
      const bar = el2('div', 'bar');
      bar.appendChild(el2('span', 'name', p.name));
      const track = el2('div', 'track');
      const fill = el2('div', 'fill');
      fill.style.background = p.color;
      fill.style.width = Math.max(1, Math.round((p.ms / max) * 100)) + '%';
      track.appendChild(fill);
      bar.appendChild(track);
      bar.appendChild(el2('span', 'val', fmtDur(p.ms)));
      list.appendChild(bar);
    }

    list.appendChild(el2('div', 'sec', 'Timeline'));
    const pal = {};
    for (const p of ins.byProject) pal[p.name] = p.color;

    const chips = el2('div', 'chips');
    const addChip = (label, dot, key) => {
      const c = el2('button', 'chip' + (tlFilter === key ? ' on' : ''), label);
      if (dot) {
        const d = el2('span', 'chipdot');
        d.style.background = dot;
        c.appendChild(d);
      }
      c.addEventListener('click', () => {
        tlFilter = tlFilter === key ? null : key;
        renderInsights();
      });
      chips.appendChild(c);
    };
    addChip('All', null, null);
    for (const p of ins.byProject) addChip(p.name, p.color, p.name);
    list.appendChild(chips);

    const axis = el2('div', 'tlday tlaxis');
    axis.appendChild(el2('span', 'label', ''));
    const axisBar = el2('div', 'tlbar');
    axisBar.style.height = 'auto';
    for (let h = 0; h < 24; h += 3) axisBar.appendChild(el2('span', 'tlah', pad2(h) + ':00'));
    axis.appendChild(axisBar);
    axis.appendChild(el2('span', 'tlval', ''));
    list.appendChild(axis);

    for (const d of ins.timeline) {
      const day = el2('div', 'tlday clickable');
      const dayLabel = el2('span', 'label', d.day);
      dayLabel.title = 'File diffs for this day';
      dayLabel.addEventListener('click', () => vscode.postMessage({ type: 'openDayDiffs', day: d.day }));
      day.appendChild(dayLabel);
      const bar = el2('div', 'tlbar');
      let dayMs = 0;
      for (let h = 0; h < d.cells.length; h++) {
        const c = el2('div', 'tlcell');
        const cell = d.cells[h];
        const visible = (cell && cell.parts ? cell.parts : []).filter((p) => !tlFilter || p.projectName === tlFilter);
        const ms = visible.reduce((sum, p) => sum + p.ms, 0);
        if (ms > 0) {
          const dom = visible.slice().sort((a, b) => b.ms - a.ms)[0];
          c.style.background = pal[dom.projectName] || cell.color || '#8a8a8a';
          c.style.cursor = 'pointer';
          c.title = pad2(h) + ':00 \u2014 ' + visible.map((p) => p.projectName + ' ' + fmtDur(p.ms)).join(' \u00b7 ');
          c.addEventListener('click', () => {
            const ids = [...new Set(visible.flatMap((p) => p.sessionIds))];
            if (ids.length) vscode.postMessage({ type: 'openHourSessions', ids });
          });
        }
        dayMs += ms;
        bar.appendChild(c);
      }
      day.appendChild(bar);
      day.appendChild(el2('span', 'tlval', fmtDur(dayMs)));
      list.appendChild(day);
    }
    const used = Object.keys(pal);
    if (used.length) {
      const key = el2('div', 'tlkey');
      for (const name of used) {
        key.appendChild(el2('span', 'tlkeyit', '\u25cf ' + name));
        key.lastChild.style.color = pal[name];
      }
      list.appendChild(key);
    }

    list.appendChild(el2('div', 'sec', 'Top files'));
    if (!ins.topFiles.length) list.appendChild(el2('div', 'ph', 'no file activity recorded'));
    for (const f of ins.topFiles) {
      list.appendChild(drow('\ud83d\udcc4', f.path, f.edits + ' edit' + (f.edits === 1 ? '' : 's')));
    }
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function row2(a, b, c) {
    const r = el2('div', 'drow');
    r.appendChild(el2('span', 'label', a));
    r.appendChild(el2('span', 'half', b + (c ? ' \u00b7 ' + c : '')));
    return r;
  }

  function renameButton(p) {
    const btn = el2('button', null, 'Rename\u2026');
    btn.style.flex = '0 1 auto';
    btn.addEventListener('click', () => vscode.postMessage({ type: 'renameProject', id: p.id }));
    return btn;
  }

  function projectHead(p) {
    const card = el2('div', 'drow');
    const d = el2('span', 'projdot');
    d.style.background = p.color;
    card.appendChild(d);
    const name = el2('span', 'label', p.name + (p.archived ? ' (archived)' : ''));
    card.appendChild(name);
    return card;
  }

  function projectStats(p) {
    return el2('div', 'sub', fmtDur(p.weekMs) + ' this week \u00b7 ' + p.sessionCount + ' session' + (p.sessionCount === 1 ? '' : 's') + ' \u00b7 ' + p.workspaceKeys.length + ' workspace' + (p.workspaceKeys.length === 1 ? '' : 's'));
  }

  function renderProjects() {
    const st = lastState;
    list.textContent = '';

    // Default mode (ADR-030): each workspace has its own project, so
    // create/claim/archive would be meaningless — the tab is a name + stats
    // and a rename button. Full management lives behind lalog.multiProject.
    if (!st.multiProject) {
      list.appendChild(el2('div', 'sec', 'Project'));
      if (!st.projects.length) {
        list.appendChild(el2('div', 'ph', 'No project yet \u2014 one is created for this workspace automatically.'));
        return;
      }
      for (const p of st.projects) {
        list.appendChild(projectHead(p));
        list.appendChild(projectStats(p));
        const r = el2('div', 'drow');
        r.appendChild(renameButton(p));
        list.appendChild(r);
      }
      return;
    }

    const add = el2('button', null, 'New project\u2026');
    add.addEventListener('click', () => vscode.postMessage({ type: 'newProject' }));
    list.appendChild(addNode(add));
    const fromWs = el2('button', null, 'New project from "' + st.wsName + '"');
    fromWs.addEventListener('click', () => vscode.postMessage({ type: 'newProjectFromWorkspace' }));
    list.appendChild(addNode(fromWs));
    list.appendChild(el2('div', 'sec', 'Projects'));

    if (!st.projects.length) {
      list.appendChild(el2('div', 'ph', 'No projects yet \u2014 create one to group sessions across workspaces.'));
      return;
    }
    for (const p of st.projects) {
      list.appendChild(projectHead(p));

      list.appendChild(projectStats(p));
      if (p.pathHints.length) {
        list.appendChild(el2('div', 'sub', p.pathHints.join(' \u00b7 ')));
      }
      const r = el2('div', 'drow');
      if (!p.workspaceKeys.includes(st.wsKey)) {
        const claim = el2('button', null, 'Add "' + st.wsName + '"');
        claim.style.flex = '0 1 auto';
        claim.addEventListener('click', () => vscode.postMessage({ type: 'claimWorkspace', projectId: p.id }));
        r.appendChild(claim);
      }
      const arch = el2('button', null, p.archived ? 'Restore' : 'Archive');
      arch.style.flex = '0 1 auto';
      arch.addEventListener('click', () => vscode.postMessage({ type: 'archiveProject', id: p.id }));
      r.appendChild(arch);
      r.appendChild(renameButton(p));
      list.appendChild(r);
    }
  }

  function addNode(btn) {
    const w = el2('div', 'drow');
    btn.style.flex = '0 1 auto';
    w.appendChild(btn);
    return w;
  }

  function renderNow() {
    const st = lastState;
    if (!st) return;
    const a = st.active;
    if (a) {
      el('name').textContent = a.workspaceName;
      el('desc').textContent = a.description || '(no description yet)';
      el('desc').classList.toggle('placeholder', !a.description);
      const paused = !!st.paused;
      el('dot').classList.toggle('paused', paused);
      el('status').textContent = paused ? 'paused' : 'tracking';
      el('projname').textContent = a.projectName || 'No project';
      el('projdot').style.background = a.projectColor || 'transparent';
      el('btnProject').classList.remove('hidden');
      const liveMs = paused ? 0 : Math.max(0, Math.min(Date.now() - a.lastActivityAt, st.idleGap));
      el('clock').textContent = fmtDur2(a.activeMinutes + liveMs);
      el('active').textContent = fmtClock(Date.now());
      el('btnPause').classList.toggle('hidden', paused);
      el('btnResume').classList.toggle('hidden', !paused);
    } else {
      el('projname').textContent = 'No project';
      el('projdot').style.background = 'transparent';
      el('btnProject').classList.add('hidden');
      el('name').textContent = 'LaLog';
      el('desc').textContent = 'sessions start automatically';
      el('desc').classList.add('placeholder');
      el('dot').classList.remove('paused');
      el('status').textContent = 'waiting';
      el('clock').textContent = '00:00:00';
      el('active').textContent = fmtClock(Date.now());
      el('btnPause').classList.add('hidden');
      el('btnResume').classList.add('hidden');
    }
    el('today').textContent = fmtDur(st.todayActiveMs) + ' today';
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'state') return;
    lastState = d;
    render();
  });

  setInterval(() => {
    if (!lastState) return;
    renderNow();
  }, 1000);
})();
</script>
</body>
</html>`;
  }
}

function emptyInsight(): InsightsSnapshot {
  return {
    totalMs: 0,
    vscodeMs: 0,
    outsideMs: 0,
    count: 0,
    byProject: [],
    byDay: [],
    topFiles: [],
    timeline: [],
  };
}