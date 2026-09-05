import * as vscode from 'vscode';
import type { Session } from '../core/types';
import { splitActiveMinutes } from '../reporting/spans';

/**
 * The whole LaLog panel in ONE webview view: a scrollable sessions list above
 * and the "Now" box as a fixed, non-scrolling footer at the bottom. This is the
 * only way to get a genuinely pinned prompt-style box (like Copilot Chat's) —
 * a standalone view always gets a resize/move divider, and a box that isn't
 * glued to the view bottom moves when the divided space changes.
 */

export interface PanelNow {
  todayActiveMs: number;
  paused: boolean;
  idleGap: number;
}

interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number | undefined;
  workspaceName: string;
  description: string | null;
  needsDescription: boolean;
  type: string | null;
  closedReason: string | null;
  activeMinutes: number;
  lastActivityAt: number;
  gitBranch: string | null;
  commits: string[];
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

function summarize(s: Session, idleGapMs: number): SessionSummary {
  const split = splitActiveMinutes(s, idleGapMs);
  return {
    id: s.id,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    workspaceName: s.workspaceName,
    description: s.description ?? null,
    needsDescription: !!s.needsDescription,
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

function groupByDay(sessions: Session[], idleGapMs: number): DayGroup[] {
  const map = new Map<string, DayGroup>();
  for (const s of sessions) {
    const day = new Date(s.startedAt).toISOString().slice(0, 10);
    let g = map.get(day);
    if (!g) {
      g = { day, count: 0, totals: 0, sessions: [] };
      map.set(day, g);
    }
    g.count += 1;
    g.totals += s.activeMinutes;
    g.sessions.push(summarize(s, idleGapMs));
  }
  return [...map.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .map((g) => ({ ...g, sessions: g.sessions.sort((a, b) => b.startedAt - a.startedAt) }));
}

export class LaLogPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'lalog.sessionsView';

  private view: vscode.WebviewView | null = null;

  constructor(
    private getSessions: () => Promise<Session[]>,
    private getActive: () => Session | null,
    private getNow: () => PanelNow
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();

    webviewView.webview.onDidReceiveMessage((message: { type?: string; id?: string }) => {
      if (message?.type === 'edit' && typeof message.id === 'string') {
        void vscode.commands.executeCommand('lalog.editSession', message.id);
      } else if (message?.type === 'pause') {
        void vscode.commands.executeCommand('lalog.pauseSession');
      } else if (message?.type === 'resume') {
        void vscode.commands.executeCommand('lalog.resumeSession');
      } else if (message?.type === 'end') {
        void vscode.commands.executeCommand('lalog.endSessionRestart');
      }
    });

    void this.pushState();
  }

  /** Re-render the panel (sessions + Now footer) from fresh data. */
  refresh(): void {
    void this.pushState();
  }

  private async pushState(): Promise<void> {
    if (!this.view) return;
    const sessions = await this.getSessions();
    const now = this.getNow();
    const active = this.getActive();
    void this.view.webview.postMessage({
      type: 'state',
      now: Date.now(),
      groups: groupByDay(sessions, now.idleGap),
      active: active ? summarize(active, now.idleGap) : null,
      todayActiveMs: now.todayActiveMs,
      paused: now.paused,
      idleGap: now.idleGap,
    });
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
  #list { flex: 1 1 auto; overflow-y: auto; padding: 6px 0; }
  #now { flex-shrink: 0; }

  .day { font-weight: 600; display: flex; align-items: center; gap: 6px; padding: 5px 10px 3px; cursor: pointer; }
  .day .caret, .row .caret { width: 12px; flex-shrink: 0; }
  .row { display: flex; align-items: center; gap: 6px; padding: 3px 10px 3px 22px; cursor: pointer; border-radius: 4px; }
  .row:hover, .day:hover { background: var(--vscode-list-hoverBackground); }
  .row .label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .half { opacity: .7; white-space: nowrap; }
  .row.warn { color: var(--vscode-list-warningForeground, var(--vscode-editorWarning-foreground)); }
  .icon { width: 14px; text-align: center; opacity: .85; flex-shrink: 0; }
  .hidden { display: none; }

  .detail { padding: 0 10px 4px 34px; color: var(--vscode-descriptionForeground); }
  .drow { display: flex; align-items: center; gap: 6px; padding: 2px 0; min-width: 0; }
  .drow .label { flex: 1; min-width: 0; }
  .drow .half { opacity: .75; white-space: nowrap; }
  .git-desc { white-space: normal; word-break: break-word; }
  .sub { padding: 0 0 0 14px; }
  .ph { font-style: italic; opacity: .7; }

  .editbtn {
    appearance: none; border: none; background: transparent; color: inherit; cursor: pointer;
    padding: 1px 4px; border-radius: 3px; font-size: 12px; flex-shrink: 0;
  }
  .editbtn:hover { background: var(--vscode-toolbar-hoverBackground); }

  .card {
    display: flex; flex-direction: column; gap: 6px;
    margin: 0 8px 8px; padding: 10px 12px;
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-sideBar-border));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    box-shadow: 0 -1px 3px rgba(0, 0, 0, 0.12);
  }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pill { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #2ea043; }
  .dot.paused { background: #d4a72c; }
  .desc { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .desc.placeholder { font-style: italic; }
  .meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .clock { font-size: 17px; font-weight: 500; color: var(--vscode-foreground); }
  .actions { display: flex; gap: 6px; }
  button {
    flex: 1; appearance: none; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-buttonBackground); color: var(--vscode-buttonForeground); }
  button.primary:hover { background: var(--vscode-buttonHoverBackground); }
  button.danger { background: transparent; border-color: var(--vscode-inputValidation-errorBorder, #f14c4c); color: var(--vscode-errorForeground, #f14c4c); }
  button.danger:hover { background: var(--vscode-inputValidation-errorBackground, rgba(241, 76, 76, 0.15)); }
</style>
</head>
<body>
  <div id="list"></div>
  <div id="now">
    <div class="card">
      <div class="head">
        <span class="name" id="name">LaLog</span>
        <span class="pill"><span class="dot" id="dot"></span><span id="status">&mdash;</span></span>
      </div>
      <div class="desc placeholder" id="desc">no session yet</div>
      <div class="meta">
        <span class="clock" id="clock">&ndash;&ndash;:&ndash;&ndash;:&ndash;&ndash;</span>
        <span id="active">&mdash;</span>
        <span id="today">&mdash;</span>
      </div>
      <div class="actions">
        <button class="primary" id="btnPause">Pause</button>
        <button class="primary hidden" id="btnResume">Resume</button>
        <button class="danger" id="btnEnd" title="End this session &amp; start a fresh one">End</button>
      </div>
    </div>
  </div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const el = (id) => document.getElementById(id);
  const open = { days: new Set(), sessions: new Set(), files: new Set(), notes: new Set() };
  let lastState = null;

  el('btnPause').addEventListener('click', () => vscode.postMessage({ type: 'pause' }));
  el('btnResume').addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
  el('btnEnd').addEventListener('click', () => vscode.postMessage({ type: 'end' }));

  function el2(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderGroups(groups) {
    list.textContent = '';
    if (!groups.length) {
      list.appendChild(el2('div', 'ph', 'no sessions recorded yet'));
      return;
    }
    for (const g of groups) {
      const isOpen = open.days.has(g.day);
      const dayRow = el2('div', 'day');
      dayRow.appendChild(el2('span', 'caret', isOpen ? '&#9660;' : '&#9654;'));
      const dayLabel = g.day + ' \u2014 ' + g.count + ' session' + (g.count > 1 ? 's' : '') + ', ' + fmtDur(g.totals);
      dayRow.appendChild(el2('span', 'label', dayLabel));
      dayRow.addEventListener('click', () => {
        if (isOpen) open.days.delete(g.day); else open.days.add(g.day);
        renderGroups(groups);
      });
      list.appendChild(dayRow);

      if (!isOpen) continue;
      for (const s of g.sessions) list.appendChild(sessionNode(s));
    }
  }

  function sessionNode(s) {
    const wrap = document.createElement('div');
    const sOpen = open.sessions.has(s.id);
    const header = el2('div', 'row' + (s.needsDescription ? ' warn' : ''));
    header.appendChild(el2('span', 'caret', sOpen ? '&#9660;' : '&#9654;'));
    header.appendChild(el2('span', 'icon', s.needsDescription ? '\u26a0' : '\u2713'));
    const label = fmtHM(s.startedAt) + ' \u00b7 ' + s.workspaceName +
      (s.description ? ' \u2014 ' + s.description : s.needsDescription ? ' \u2014 (needs description)' : '');
    header.appendChild(el2('span', 'label', label));
    header.appendChild(el2('span', 'half', fmtDur(s.activeMinutes)));
    const editBtn = el2('button', 'editbtn', '\u270e');
    editBtn.title = 'Edit description';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'edit', id: s.id }); });
    header.appendChild(editBtn);
    header.addEventListener('click', () => {
      if (sOpen) open.sessions.delete(s.id); else open.sessions.add(s.id);
      renderGroups(lastState.groups);
    });
    wrap.appendChild(header);

    if (!sOpen) return wrap;
    const detail = el2('div', 'detail');
    if (s.description) detail.appendChild(drow('\u270e', s.description, 'description'));
    detail.appendChild(drow('\u23f1', 'Active ' + fmtDur(s.split.totalMs), 'in VS Code ' + fmtDur(s.split.vscodeMs) + ' \u00b7 outside VS Code ' + fmtDur(s.split.outsideMs)));
    const metaTxt = (s.type || 'untagged') + (s.closedReason ? ' \u00b7 ' + s.closedReason : '') + ' \u00b7 started ' + fmtHM(s.startedAt);
    detail.appendChild(drow('\ud83d\udee0', metaTxt, s.endedAt ? 'ended ' + fmtHM(s.endedAt) : 'still open'));
    detail.appendChild(drow('\ud83d\udccb', fmtEvents(s.events), null));
    if (s.events.topFiles && s.events.topFiles.length) {
      detail.appendChild(groupRow('\U0001f4c1', s.events.topFiles.length + ' file' + (s.events.topFiles.length > 1 ? 's' : '') + ' worked on', open.files, s.id + ':files', (wrap2) => {
        const files = s.events.topFiles.slice().sort((a, b) => b.edits - a.edits);
        for (const f of files) {
          wrap2.appendChild(drow('\U0001f4c4', f.path, f.edits + ' edit' + (f.edits === 1 ? '' : 's')));
        }
      }));
    }
    if (s.notes.length) {
      detail.appendChild(groupRow('\U0001f4dd', s.notes.length + ' note' + (s.notes.length > 1 ? 's' : ''), open.notes, s.id + ':notes', (wrap2) => {
        const notes = s.notes.slice().sort((a, b) => a.at - b.at);
        for (const n of notes) {
          wrap2.appendChild(drow('\ud83d\udcac', n.text, fmtHM(n.at)));
        }
      }));
    }
    if (s.gitBranch || s.commits.length) {
      const gitRow = el2('div', 'drow');
      gitRow.appendChild(el2('span', 'icon', '\u2387'));
      const labelEl = el2('span', 'label', 'git ' + (s.gitBranch || '') + ' \u00b7 ' + s.commits.length + ' commit' + (s.commits.length === 1 ? '' : 's'));
      gitRow.appendChild(labelEl);
      if (s.commits.length) {
        const desc = el2('div', 'git-desc', s.commits.join(' \u00b7 '));
        gitRow.appendChild(desc);
      }
      detail.appendChild(gitRow);
    }
    wrap.appendChild(detail);
    return wrap;
  }

  function groupRow(icon, label, set, key, fn) {
    const keyOpen = set.has(key);
    const row = el2('div', 'drow');
    row.appendChild(el2('span', 'caret', keyOpen ? '&#9660;' : '&#9654;'));
    row.appendChild(el2('span', 'icon', icon));
    row.appendChild(el2('span', 'label', label));
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      if (keyOpen) set.delete(key); else set.add(key);
      renderGroups(lastState.groups);
    });
    if (keyOpen) {
      const sub = el2('div', 'sub');
      fn(sub);
      row.after(sub);
    }
    return row;
  }

  function drow(icon, label, half) {
    const row = el2('div', 'drow');
    if (icon) row.appendChild(el2('span', 'icon', icon));
    const l = el2('span', 'label', label);
    if (label && label.length > 120) l.classList.add('git-desc');
    row.appendChild(l);
    if (half) {
      const h = el2('span', 'half', half);
      h.style.flexShrink = '0';
      row.appendChild(h);
    }
    return row;
  }

  function fmtEvents(e) {
    const parts = [];
    const push = (n, w) => { if (n) parts.push(n + ' ' + w); };
    push(e.edits, 'edits'); push(e.saves, 'saves'); push(e.terminal, 'terminal');
    push(e.fileops, 'file ops'); push(e.tasks, 'tasks'); push(e.debug, 'debug');
    return parts.length ? parts.join(' \u00b7 ') : 'no events recorded';
  }

  function fmtHM(t) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDur(ms) {
    const min = Math.round(ms / 60000);
    const h = Math.floor(min / 60), r = min % 60;
    return h > 0 ? h + 'h ' + r + 'm' : r + 'm';
  }
  function fmtClock(t) {
    const dt = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds());
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
      const liveMs = paused ? 0 : Math.max(0, Math.min(Date.now() - a.lastActivityAt, st.idleGap));
      el('active').textContent = (paused ? 'run ' : 'active ') + fmtDur(a.activeMinutes + liveMs);
      el('btnPause').classList.toggle('hidden', paused);
      el('btnResume').classList.toggle('hidden', !paused);
    } else {
      el('name').textContent = 'LaLog';
      el('desc').textContent = 'sessions start automatically';
      el('desc').classList.add('placeholder');
      el('dot').classList.remove('paused');
      el('status').textContent = 'waiting';
      el('active').textContent = '\u2014';
      el('btnPause').classList.add('hidden');
      el('btnResume').classList.add('hidden');
    }
    el('today').textContent = fmtDur(st.todayActiveMs) + ' today';
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'state') return;
    lastState = d;
    renderGroups(d.groups);
    renderNow();
  });

  setInterval(() => {
    if (!lastState) return;
    el('clock').textContent = fmtClock(new Date().getTime());
    renderNow();
  }, 1000);
})();
</script>
</body>
</html>`;
  }
}