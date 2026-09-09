import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readConfig, thresholdsMs, readAiConfig, AiConfig } from './core/config';
import { SessionManager } from './core/sessionManager';
import { SessionStore } from './storage/sessionStore';
import { TechnicalStore } from './storage/technicalStore';
import { buildPaths, ensureDirs, LaLogPaths, workspaceKey, workspaceName } from './storage/store';
import { ProjectRegistry } from './storage/projectRegistry';
import { LaLogPanelProvider } from './ui/panelView';
import { LaLogStatusBar } from './ui/statusBar';
import { todayActiveMs, todayUntrackedMs } from './reporting/aggregate';
import { generateReport, saveReport, calendarDayCount } from './reporting/report';
import { ReportRange, rangeStart, rangeEnd, rangeLabel } from './reporting/ranges';
import { exportFilesByDay } from './integrations/legacyExport';
import { LaLogAiService, OpencodePreflightError } from './opencode/service';
import type { AnalysisResult } from './opencode/service';
import { Session } from './core/types';
import { resolveProject } from './core/projects';

let manager: SessionManager;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = readConfig();
  const paths: LaLogPaths = buildPaths(cfg.dataDir);
  ensureDirs(paths);
  const th = thresholdsMs(cfg);

  const store = new SessionStore({ paths, th });
  const technicalStore = new TechnicalStore(paths.technicalDir);
  manager = new SessionManager(store, th, paths, cfg, technicalStore);
  const projectRegistry = new ProjectRegistry(paths);

  const wsFolder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Lazy AI service so that when `lalog.ai.enabled` is false, no opencode code
  // path is ever instantiated or run (local-only guarantee preserved).
  // Config is read live so toggling the setting takes effect without a reload.
  let aiService: LaLogAiService | null = null;
  let aiServiceCfg: AiConfig | null = null;
  function getAi(): LaLogAiService | null {
    const live = readAiConfig();
    if (!live.enabled) return null;
    if (!aiService || aiServiceCfg !== live) {
      aiService = new LaLogAiService(live, wsFolder());
      aiServiceCfg = live;
      // Wire interaction logger on each new service instance
      aiService.setInteractionLogger((e) => {
        manager.logAiInteraction({
          type: 'ai',
          ts: Date.now(),
          task: e.task,
          model: e.model,
          latencyMs: e.latencyMs,
          promptChars: e.promptChars,
          responseChars: e.responseChars,
          truncated: e.truncated,
        });
      });
    }
    return aiService;
  }

  // When AI is enabled, offer AI drafting inside the describe prompt.
  // (The option's presence is fixed at activation; the report/analysis commands
  // read config live so toggles apply there without a reload.)
  manager.setAiDraft(
    readAiConfig().enabled
      ? async () => {
          const svc = getAi();
          const cur = manager.getSession();
          if (!svc || !cur) throw new Error('No active session');
          return svc.draftDescription(cur);
        }
      : undefined
  );

  const statusBar = new LaLogStatusBar(() => {
    void commands.quickActions();
  });

  // Recompute status bar + panel on state changes.
  manager.setOnStateChanged(() => {
    void refreshStatus();
  });

  let cachedTodayMs = 0;
  const panel = new LaLogPanelProvider(
    () => store.loadAll(),
    () => manager.getSession(),
    () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const p = folder?.uri.fsPath ?? '';
      return {
        todayActiveMs: cachedTodayMs,
        paused: manager.isPaused(),
        idleGap: th.idleGap,
        wsKey: p ? workspaceKey(p) : 'no-workspace',
        wsName: p ? workspaceName(p) : 'No folder',
        wsPath: p,
      };
    },
    store,
    projectRegistry,
    (projectId: string | undefined) => manager.assignProject(projectId)
  );

  async function refreshStatus(): Promise<void> {
    statusBar.loading();
    let all: Session[];
    try {
      all = await store.loadAll();
    } catch {
      statusBar.update(null, 0, 0, false);
      return;
    }
    const today = todayActiveMs(all, Date.now());
    cachedTodayMs = today;
    const now = Date.now();
    statusBar.update(
      manager.getSession(),
      today,
      todayUntrackedMs(all, now),
      manager.isPaused()
    );
    panel.refresh();
  }

  const commands = {
    async quickActions(): Promise<void> {
      const paused = manager.isPaused();
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(pencil) Describe current session', id: 'describe' },
          paused
            ? { label: '$(play) Resume session', id: 'resume' }
            : { label: '$(debug-pause) Pause session', id: 'pause' },
          { label: '$(circle-slash) Keep as background work', id: 'background' },
          { label: '$(check) End & restart session', id: 'end' },
          { label: '$(calendar) Generate report', id: 'report' },
          { label: '$(export) Export sessions CSV', id: 'csv' },
        ],
        { title: 'LaLog' }
      );
      if (!pick) return;
      if (pick.id === 'describe') await vscode.commands.executeCommand('lalog.describeNow');
      if (pick.id === 'pause') await vscode.commands.executeCommand('lalog.pauseSession');
      if (pick.id === 'resume') await vscode.commands.executeCommand('lalog.resumeSession');
      if (pick.id === 'background') await vscode.commands.executeCommand('lalog.background');
      if (pick.id === 'end') await vscode.commands.executeCommand('lalog.endSessionRestart');
      if (pick.id === 'report') await vscode.commands.executeCommand('lalog.report');
      if (pick.id === 'csv') await vscode.commands.executeCommand('lalog.exportCsv');
    },
  };

  function registerCommand(id: string, cb: (...args: unknown[]) => unknown): void {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args) => cb(...args))
    );
  }

  // Status bar click → quick actions panel.
  registerCommand('lalog.statusAction', () => {
    void commands.quickActions();
  });

  registerCommand('lalog.startSession', () => {
    void manager.startFresh();
  });

  registerCommand('lalog.pauseSession', () => {
    manager.pause();
  });

  registerCommand('lalog.resumeSession', () => {
    manager.resume();
  });

  registerCommand('lalog.endSessionRestart', async () => {
    const s = await manager.endAndRestart();
    if (s) {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        try {
          const { annotateSessionWithGit } = await import('./integrations/git');
          await annotateSessionWithGit(s, ws.uri.fsPath);
        } catch {
          /* ignore */
        }
      }
      await refreshStatus();
      vscode.window.showInformationMessage(
        `Session ended: ${fmtActive(s)} — new tracking session started`
      );
    }
  });

  registerCommand('lalog.endSession', async () => {
    const s = await manager.endSession('user');
    if (s) {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        try {
          const { annotateSessionWithGit } = await import('./integrations/git');
          await annotateSessionWithGit(s, ws.uri.fsPath);
        } catch {
          /* ignore */
        }
      }
      await refreshStatus();
      vscode.window.showInformationMessage(`Session ended: ${fmtActive(s)}`);
    }
  });

  async function describeCurrentSession(): Promise<void> {
    const s = manager.getSession();
    if (!s) {
      vscode.window.showInformationMessage('No active session to describe.');
      return;
    }
    manager.presentDescribeNow();
  }

  registerCommand('lalog.report', async () => {
    const rangePick = await vscode.window.showQuickPick(
      [
        { label: 'Today', id: 'today' as ReportRange },
        { label: 'Yesterday', id: 'yesterday' as ReportRange },
        { label: 'This week', id: 'week' as ReportRange },
        { label: 'This month', id: 'month' as ReportRange },
        { label: 'Last month', id: 'last-month' as ReportRange },
        { label: 'Custom range\u2026', id: 'custom' as ReportRange },
      ],
      { title: 'LaLog report range' }
    );
    if (!rangePick) return;
    let custom: { start: number; end: number } | undefined;
    if (rangePick.id === 'custom') {
      const input = await vscode.window.showInputBox({
        title: 'Custom report range',
        placeHolder: 'YYYY-MM-DD...YYYY-MM-DD (max 31 days)',
        value: `${dayStamp(Date.now())}...${dayStamp(Date.now())}`,
        ignoreFocusOut: true,
      });
      const m = input?.trim().match(/^(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})$/);
      if (!m) {
        vscode.window.showInformationMessage('Custom range needs two dates: YYYY-MM-DD...YYYY-MM-DD');
        return;
      }
      const start = parseDay(m[1]);
      const end = parseDay(m[2]);
      if (end <= start) {
        vscode.window.showInformationMessage('End date must be after start date.');
        return;
      }
      if (calendarDayCount(start, end) > 31) {
        vscode.window.showInformationMessage('Custom range is limited to 31 days.');
        return;
      }
      const endInclusive = new Date(end);
      endInclusive.setDate(endInclusive.getDate() + 1);
      custom = { start, end: new Date(endInclusive.getFullYear(), endInclusive.getMonth(), endInclusive.getDate()).getTime() };
    }
    const projects = projectRegistry.list();
    const scopePick = await vscode.window.showQuickPick(
      [{ label: 'All sessions', id: '' }, ...projects.map((p) => ({ label: p.name, id: p.id }))],
      { title: 'LaLog report scope' }
    );
    if (scopePick === undefined) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LaLog: generating report\u2026' },
      async () => {
        const all = await store.loadAll();
        const range = rangePick.id;
        const projectId = scopePick.id || null;

        let content = await generateReport(all, projects, range, {
          projectId,
          activeSession: manager.getSession(),
          custom,
        });

        const svc = getAi();
        if (svc) {
          const inRange = custom
            ? all.filter((s) => s.startedAt >= custom.start && s.startedAt < custom.end && s.endedAt)
            : filterByRange(all, range);
          if (inRange.length) {
            const narrative = await aiTask('narrative', () => svc.narrative(rangeLabel(range), inRange));
            if (narrative) {
              content += `\n## AI Narrative\n\n> Generated by LaLog AI (${readAiConfig().model}). Review before sharing.\n\n${narrative}\n`;
            }
          }
        }

        const file = saveReport(paths, content, { range, projectId, custom });
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    );
  });

  registerCommand('lalog.background', async () => {
    const s = manager.getSession();
    if (!s) {
      vscode.window.showInformationMessage('No active session.');
      return;
    }
    manager.markBackground();
    await refreshStatus();
    vscode.window.showInformationMessage('Kept as background work (anonymous session).');
  });

  registerCommand('lalog.exportCsv', async () => {
    const all = await store.loadAll();
    const projects = projectRegistry.list();
    const rows = [
      [
        'id',
        'startedAt',
        'endedAt',
        'workspace',
        'project',
        'type',
        'activeMinutes',
        'edits',
        'saves',
        'terminal',
        'fileops',
        'tasks',
        'debug',
        'description',
      ],
      ...all.map((s) => {
        const proj = resolveProject(s, projects);
        return [
          s.id,
          iso(s.startedAt),
          s.endedAt ? iso(s.endedAt) : '',
          s.workspaceName,
          proj?.name ?? '',
          s.type ?? '',
          String(s.activeMinutes),
          String(s.events?.edits ?? 0),
          String(s.events?.saves ?? 0),
          String(s.events?.terminal ?? 0),
          String(s.events?.fileops ?? 0),
          String(s.events?.tasks ?? 0),
          String(s.events?.debug ?? 0),
          (s.description ?? '').replace(/"/g, '""'),
        ];
      }),
    ];
    const content = rows.map((r) => '"' + r.join('","') + '"').join('\n');
    const file = path.join(paths.exportsDir, `sessions-${dayStamp(Date.now())}.csv`);
    fs.writeFileSync(file, content);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  registerCommand('lalog.analysis', async () => {
    const svc = getAi();
    if (!svc) {
      vscode.window.showInformationMessage(
        'AI analysis is disabled. Enable it with the "lalog.ai.enabled" setting.'
      );
      return;
    }
    const rangePick = await vscode.window.showQuickPick(
      [
        { label: 'Today', id: 'today' as ReportRange },
        { label: 'Yesterday', id: 'yesterday' as ReportRange },
        { label: 'This week', id: 'week' as ReportRange },
        { label: 'This month', id: 'month' as ReportRange },
        { label: 'Last month', id: 'last-month' as ReportRange },
      ],
      { title: 'LaLog work analysis range' }
    );
    if (!rangePick) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LaLog: running work analysis\u2026' },
      async () => {
        const all = await store.loadAll();
        const inRange = filterByRange(all, rangePick.id);
        if (!inRange.length) {
          vscode.window.showInformationMessage('No sessions in that range.');
          return;
        }
        const result = await aiTask('analysis', () => svc.analyze(rangeLabelOf(rangePick.id), inRange));
        if (!result) return;
        await renderAnalysis(result);
      }
    );
  });

  registerCommand('lalog.showSessions', () => {
    void vscode.commands.executeCommand('lalog.sessionsView.focus');
  });

  registerCommand('lalog.describeNow', () => {
    void describeCurrentSession();
  });

  registerCommand('lalog.editSession', async (id: unknown) => {
    const all = await store.loadAll();
    const target = all.find((s) => s.id === id) ?? all[all.length - 1];
    if (!target) {
      vscode.window.showInformationMessage('No sessions recorded yet.');
      return;
    }
    const desc = await vscode.window.showInputBox({
      title: `Edit session (${target.workspaceName})`,
      value: target.description ?? '',
      prompt: 'Update description',
      ignoreFocusOut: true,
    });
    if (desc !== undefined) {
      const text = desc.trim();
      const notes = [...target.notes];
      if (text && text !== target.description) {
        notes.push({ at: Date.now(), text });
      }
      await store.updateSession(target.id, {
        description: text || undefined,
        needsDescription: !text,
        notes,
      });
      panel.refresh();
    }
  });

  registerCommand('lalog.exportFilesByDay', async () => {
    const all = await store.loadAll();
    const files = await exportFilesByDay(paths, all);
    vscode.window.showInformationMessage(
      files.length ? `Exported ${files.length} day-file(s).` : 'Nothing to export yet.'
    );
  });

  // Sidebar panel: sessions list + fixed "Now" box at the bottom (single
  // webview view — a standalone second view would get its own resize divider).
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(LaLogPanelProvider.viewType, panel)
  );
  context.subscriptions.push(manager, statusBar, panel);

  // Keep the "today" figure fresh even when idle (no state changes to trigger
  // refreshStatus). The Now clock ticks client-side in the webview regardless.
  const todayRefresh = setInterval(() => void refreshStatus(), 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(todayRefresh) });

  // Workspace folder changes: suspend/switch logic.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      manager.suspendForSwitch();
    })
  );

  manager.start();
  void refreshStatus();

  // One-time onboarding hosted in the side panel.
  if (!context.globalState.get<boolean>('lalog.welcomed')) {
    void context.globalState
      .update('lalog.welcomed', true)
      .then(() =>
        vscode.window
          .showInformationMessage(
            'LaLog: tracking your work in the background. Open the panel for sessions, insights, and projects.',
            'Open panel'
          )
          .then((pick) => {
            if (pick) void vscode.commands.executeCommand('lalog.sessionsView.focus');
          })
      );
  }

  // Edge: window focus/visibility doesn't matter; gap model handles AFK.
}

function fmtActive(s: { activeMinutes: number }): string {
  const totalMin = Math.round(s.activeMinutes / 60000);
  const h = Math.floor(totalMin / 60);
  const r = totalMin % 60;
  return h > 0 ? `${h}h ${r}m` : `${r}m`;
}

function filterByRange(sessions: Session[], range: ReportRange): Session[] {
  const start = rangeStart(range, Date.now());
  const end = rangeEnd(range, Date.now());
  return sessions.filter((s) => s.startedAt >= start && s.startedAt < end && s.endedAt);
}

function rangeLabelOf(range: ReportRange): string {
  return rangeLabel(range);
}

function dayStamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDay(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function iso(t: number): string {
  return new Date(t).toISOString();
}

/**
 * Run an AI task, surfacing actionable setup errors and degrading gracefully.
 * Returns the result, or undefined when AI is unavailable/failed.
 */
async function aiTask<T>(kind: 'narrative' | 'analysis', fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OpencodePreflightError) {
      const msg = e.hint ? `${e.message}\n${e.hint}` : e.message;
      const pick = await vscode.window.showWarningMessage(msg, 'OK');
      void pick;
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showWarningMessage(`LaLog AI ${kind} failed: ${msg}`);
    }
    return undefined;
  }
}

function bullet(list: string[] | undefined): string {
  if (!list || !list.length) return '- none';
  return list.map((x) => `- ${x}`).join('\n');
}

async function renderAnalysis(a: AnalysisResult): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# LaLog — Work Analysis

> Generated by LaLog AI. Grounded in your session logs; verify before acting on anything.

## Wins
${bullet(a.wins)}

## Improvements
${bullet(a.improvements)}

## Stalls
${bullet(a.stalls)}

## Summary
${a.summary ?? ''}
`,
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

export async function deactivate(): Promise<void> {
  // End any active session (recorded as 'vscode-shutdown') so it isn't left as a
  // dangling recoverable snapshot. VS Code's deactivate() is synchronous and time-limited.
  await manager.shutdown();
}
