import * as vscode from 'vscode';
import type { Session } from '../core/types';

/** Snapshot the extension hands the Now provider every second. */
export interface NowSnapshot {
  session: Session | null;
  todayActiveMs: number;
  paused: boolean;
  idleGap: number;
}

/** Serializable session summary sent into the webview. */
interface NowSessionPayload {
  workspaceName: string;
  description: string | undefined;
  activeMinutes: number;
  lastActivityAt: number;
}

/**
 * The pinned "Now" box: a Copilot-style card with the session name or
 * description, a live clock, and End/Pause/Resume buttons. There is no
 * "Start" — a session is always running (or restarted automatically after an
 * End), so the buttons only ever pause/resume/end the always-on tracking.
 */
export class NowViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'lalog.nowView';

  private view: vscode.WebviewView | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private getSnapshot: () => NowSnapshot) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();

    webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === 'pause') void vscode.commands.executeCommand('lalog.pauseSession');
      else if (message?.type === 'resume') void vscode.commands.executeCommand('lalog.resumeSession');
      else if (message?.type === 'end') void vscode.commands.executeCommand('lalog.endSessionRestart');
    });

    if (!this.timer) {
      this.timer = setInterval(() => this.push(), 1000);
    }
    this.push();
  }

  private push(): void {
    if (!this.view) return;
    const snap = this.getSnapshot();
    const now = Date.now();
    const payload: NowSessionPayload | null = snap.session
      ? {
          workspaceName: snap.session.workspaceName,
          description: snap.session.description,
          activeMinutes: snap.session.activeMinutes,
          lastActivityAt: snap.session.lastActivityAt,
        }
      : null;
    void this.view.webview.postMessage({
      type: 'render',
      now,
      session: payload,
      todayActiveMs: snap.todayActiveMs,
      paused: snap.paused,
      idleGap: snap.idleGap,
    });
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
  .card {
    display: flex; flex-direction: column; gap: 6px;
    margin: 8px; padding: 10px 12px;
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-sideBar-border));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
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
  .hidden { display: none; }
</style>
</head>
<body>
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
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  el('btnPause').addEventListener('click', () => vscode.postMessage({ type: 'pause' }));
  el('btnResume').addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
  el('btnEnd').addEventListener('click', () => vscode.postMessage({ type: 'end' }));

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'render') return;
    el('clock').textContent = d.now ? fmtTime(d.now) : '--:--:--';
    el('today').textContent = fmtDur(d.todayActiveMs) + ' today';
    const s = d.session;
    if (s) {
      el('name').textContent = s.workspaceName;
      el('desc').textContent = s.description || '(no description yet)';
      el('desc').classList.toggle('placeholder', !s.description);
      const paused = !!d.paused;
      el('dot').classList.toggle('paused', paused);
      el('status').textContent = paused ? 'paused' : 'tracking';
      const liveMs = paused ? 0 : Math.min(d.now - s.lastActivityAt, d.idleGap);
      const activeMs = s.activeMinutes + liveMs;
      el('active').textContent = (paused ? 'run ' : 'active ') + fmtDur(activeMs);
      el('btnPause').classList.toggle('hidden', paused);
      el('btnResume').classList.toggle('hidden', !paused);
    } else {
      el('name').textContent = 'LaLog';
      el('desc').textContent = 'sessions start automatically';
      el('desc').classList.add('placeholder');
      el('dot').classList.remove('paused');
      el('status').textContent = 'waiting';
      el('active').textContent = '&mdash;';
      el('btnPause').classList.add('hidden');
      el('btnResume').classList.add('hidden');
    }
  });

  function fmtTime(t) {
    const dt = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds());
  }
  function fmtDur(ms) {
    const min = Math.round(ms / 60000);
    const h = Math.floor(min / 60), r = min % 60;
    return h > 0 ? h + 'h ' + r + 'm' : r + 'm';
  }
})();
</script>
</body>
</html>`;
  }
}