import * as vscode from 'vscode';
import { readConfig, thresholdsMs, readAiConfig, AiConfig } from './core/config';
import { SessionManager } from './core/sessionManager';
import { SessionStore } from './storage/sessionStore';
import { buildPaths, ensureDirs, LaLogPaths } from './storage/store';
import { SessionsTreeProvider, SessionTreeItem } from './ui/sessionsView';
import { NowViewProvider } from './ui/nowView';
import { LaLogStatusBar } from './ui/statusBar';
import { todayActiveMs, todayUntrackedMs } from './reporting/aggregate';
import { generateReport, ReportRange, saveReport, rangeStart, rangeEnd, rangeLabel } from './reporting/report';
import { exportFilesByDay } from './integrations/legacyExport';
import { LaLogAiService, OpencodePreflightError } from './opencode/service';
import type { AnalysisResult } from './opencode/service';
import { Session } from './core/types';

let manager: SessionManager;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = readConfig();
  const paths: LaLogPaths = buildPaths(cfg.dataDir);
  ensureDirs(paths);
  const th = thresholdsMs(cfg);

  const store = new SessionStore({ paths, th });
  manager = new SessionManager(store, th, paths, cfg.askDescriptionOnStart);

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

  const treeProvider = new SessionsTreeProvider(async () => store.loadAll(), th);
  const statusBar = new LaLogStatusBar(() => {
    void commands.quickActions();
  });

  // Recompute status bar on state changes.
  manager.setOnStateChanged(() => {
    void refreshStatus();
  });

  let cachedTodayMs = 0;
  const nowView = new NowViewProvider(() => ({
    session: manager.getSession(),
    todayActiveMs: cachedTodayMs,
    paused: manager.isPaused(),
    idleGap: th.idleGap,
  }));

  async function refreshStatus(): Promise<void> {
    const all = await store.loadAll();
    const today = todayActiveMs(all, Date.now());
    cachedTodayMs = today;
    const now = Date.now();
    statusBar.update(
      manager.getSession(),
      today,
      todayUntrackedMs(all, now),
      manager.isPaused()
    );
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
          { label: '$(check) End & restart session', id: 'end' },
          { label: '$(calendar) Generate report', id: 'report' },
        ],
        { title: 'LaLog' }
      );
      if (!pick) return;
      if (pick.id === 'describe') await vscode.commands.executeCommand('lalog.describeNow');
      if (pick.id === 'pause') await vscode.commands.executeCommand('lalog.pauseSession');
      if (pick.id === 'resume') await vscode.commands.executeCommand('lalog.resumeSession');
      if (pick.id === 'end') await vscode.commands.executeCommand('lalog.endSessionRestart');
      if (pick.id === 'report') await vscode.commands.executeCommand('lalog.report');
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
    const s = await manager.endSessionWithNote('user');
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
      ],
      { title: 'LaLog report range' }
    );
    if (!rangePick) return;
    const all = await store.loadAll();

    const svc = getAi();
    let content = await generateReport(all, rangePick.id);
    if (svc) {
      const inRange = filterByRange(all, rangePick.id);
      if (inRange.length) {
        const narrative = await aiTask('narrative', () =>
          svc.narrative(rangeLabelOf(rangePick.id), inRange)
        );
        if (narrative) {
          content += `\n## AI Narrative\n\n> Generated by LaLog AI (${readAiConfig().model}). Review before sharing.\n\n${narrative}\n`;
        }
      }
    }
    const file = saveReport(paths, content);
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
    const all = await store.loadAll();
    const inRange = filterByRange(all, rangePick.id);
    if (!inRange.length) {
      vscode.window.showInformationMessage('No sessions in that range.');
      return;
    }
    const result = await aiTask('analysis', () => svc.analyze(rangeLabelOf(rangePick.id), inRange));
    if (!result) return;
    await renderAnalysis(result);
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
      treeProvider.refresh();
    }
  });

  registerCommand('lalog.exportFilesByDay', async () => {
    const all = await store.loadAll();
    const files = await exportFilesByDay(paths, all);
    vscode.window.showInformationMessage(
      files.length ? `Exported ${files.length} day-file(s).` : 'Nothing to export yet.'
    );
  });

  // Sidebar view registration.
  const viewId = 'lalog.sessionsView';
  const treeView = vscode.window.createTreeView(viewId, {
    treeDataProvider: treeProvider,
  });
  context.subscriptions.push(treeView);
  treeProvider.refresh();

  const nowViewId = NowViewProvider.viewType;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(nowViewId, nowView)
  );

  context.subscriptions.push(manager, statusBar, nowView);

  // Keep the "today" figure fresh even when idle (no state changes to trigger
  // refreshStatus) — the Now clock ticks regardless, from the provider's timer.
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
  // dangling recoverable snapshot. VS Code's deactivate() is synchronous and
  // time-limited, so the optional description is collected on next launch.
  await manager.shutdown();
}
