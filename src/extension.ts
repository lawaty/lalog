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
import {
  PdfOptions,
  PdfPreset,
  PdfToggleKey,
  PDF_TOGGLE_KEYS,
  buildPdfModel,
  defaultPdfOptions,
  renderPdfReport,
  resolvePdfOptions,
  savePdfReport,
} from './reporting/pdfReport';
import { ReportRange, rangeStart, rangeEnd, rangeLabel, dayKey } from './reporting/ranges';
import { renderDayDiffs, renderSessionDetail } from './reporting/sessionDetail';
import { exportFilesByDay } from './integrations/legacyExport';
import { LaLogAiService, OpencodePreflightError } from './opencode/service';
import type { AnalysisResult } from './opencode/service';
import { Session } from './core/types';
import { truncateToTotal } from './core/spans';
import { resolveProject } from './core/projects';

let manager: SessionManager;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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
        multiProject: cfg.multiProject,
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
      statusBar.update(null, 0, 0, false, th.idleGap);
      return;
    }
    const today = todayActiveMs(all, Date.now());
    cachedTodayMs = today;
    const now = Date.now();
    statusBar.update(
      manager.getSession(),
      today,
      todayUntrackedMs(all, now),
      manager.isPaused(),
      th.idleGap
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
    const picked = await pickReportRange('LaLog report range');
    if (!picked) return;
    const { range, custom } = picked;
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
        const projectId = scopePick.id || null;

        let content = await generateReport(all, projects, range, {
          projectId,
          activeSession: manager.getSession(),
          custom,
        }, Date.now(), th.idleGap);

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

  registerCommand('lalog.exportPdf', async () => {
    const picked = await pickReportRange('LaLog PDF range');
    if (!picked) return;
    const { range, custom } = picked;
    const projects = projectRegistry.list();
    const scopePick = await vscode.window.showQuickPick(
      [{ label: 'All sessions', id: '' }, ...projects.map((p) => ({ label: p.name, id: p.id }))],
      { title: 'LaLog PDF scope' }
    );
    if (scopePick === undefined) return;
    const presetPick = await vscode.window.showQuickPick(
      [
        { label: 'Personal \u2014 full detail', id: 'personal' as PdfPreset },
        { label: 'Client \u2014 minimal abstract sheet', id: 'client' as PdfPreset },
      ],
      { title: 'LaLog PDF preset' }
    );
    if (presetPick === undefined) return;
    const defaults = defaultPdfOptions(presetPick.id);
    const details: { label: string; id: PdfToggleKey | 'daySeparate' }[] = [
      { label: 'Summary totals', id: 'includeSummaryTotals' },
      { label: 'Per-day totals', id: 'includeDayTotals' },
      { label: 'Time ranges', id: 'includeTimeRanges' },
      { label: 'Descriptions', id: 'includeDescriptions' },
      { label: 'Task types', id: 'includeTaskTypes' },
      { label: 'Projects', id: 'includeProjects' },
      { label: 'Workspaces', id: 'includeWorkspaces' },
      { label: 'Top files', id: 'includeTopFiles' },
      { label: 'Git activity', id: 'includeGit' },
      { label: 'Notes', id: 'includeNotes' },
      { label: 'Inside/outside split', id: 'includeInOutSplit' },
      { label: 'Event counters', id: 'includeEventCounters' },
      { label: 'Hourly log', id: 'includeHourlyLog' },
      { label: 'Start each day on a new page', id: 'daySeparate' },
    ];
    const chosen = await vscode.window.showQuickPick(
      details.map((d) => ({
        label: d.label,
        id: d.id,
        picked: d.id === 'daySeparate' ? defaults.dayMode === 'separate' : defaults[d.id],
      })),
      { canPickMany: true, title: 'Include in PDF', placeHolder: 'Tick what to include' }
    );
    if (chosen === undefined) return;
    const selected = new Set(chosen.map((p) => p.id));
    const toggles: Partial<PdfOptions> = {};
    for (const key of PDF_TOGGLE_KEYS) toggles[key] = selected.has(key);
    toggles.dayMode = selected.has('daySeparate') ? 'separate' : 'grouped';
    const options = resolvePdfOptions(presetPick.id, toggles);
    const projectId = scopePick.id || null;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LaLog: exporting PDF\u2026' },
      async () => {
        const all = await store.loadAll();
        const model = buildPdfModel(all, projects, range, {
          projectId,
          activeSession: manager.getSession(),
          custom,
        }, Date.now(), th.idleGap);
        const buffer = renderPdfReport(model, options, {
          projects,
          idleGapMs: th.idleGap,
        });
        const file = savePdfReport(paths, buffer, { range, projectId, custom });
        await vscode.env.openExternal(vscode.Uri.file(file));
        vscode.window.showInformationMessage(`PDF exported: ${file}`);
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
    const file = path.join(paths.exportsDir, `sessions-${dayKey(Date.now())}.csv`);
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
      await refreshStatus();
    }
  });

  registerCommand('lalog.adjustTrackedTime', async (id: unknown) => {
    const live = manager.getSession();
    const all = await store.loadAll();
    // Palette / Now-box call passes no id: the live session, else the latest
    // closed one. A passed id is matched exactly (ADR-023) — never a fallback.
    const target =
      typeof id === 'string' ? all.find((s) => s.id === id) : live ?? all[all.length - 1];
    if (!target) {
      vscode.window.showInformationMessage(
        typeof id === 'string' ? 'Session not found.' : 'No sessions recorded yet.'
      );
      return;
    }
    const currentMin = Math.round(target.activeMinutes / 60000);
    const answer = await vscode.window.showInputBox({
      title: `Adjust tracked time — ${target.workspaceName}`,
      value: String(currentMin),
      prompt: 'Tracked minutes (reduction only)',
      ignoreFocusOut: true,
      validateInput: (value: string) =>
        /^\d+$/.test(value) && Number(value) <= currentMin
          ? undefined
          : `Enter whole minutes from 0 to ${currentMin}.`,
    });
    if (answer === undefined) return;
    const minutes = Number(answer);
    if (minutes === currentMin) {
      vscode.window.showInformationMessage('No change.');
      return;
    }
    const targetMs = minutes * 60000;
    if (targetMs > target.activeMinutes) {
      vscode.window.showErrorMessage(
        `Tracked time can only be reduced — this session has ${currentMin} min.`
      );
      return;
    }
    if (live && live.id === target.id) {
      // The live session must go through the manager: the next heartbeat save
      // would otherwise write the in-memory total back over the store.
      await manager.adjustTrackedTime(targetMs);
      vscode.window.showInformationMessage(
        'Tracked time adjusted — the session keeps tracking from now.'
      );
      return;
    }
    const res = truncateToTotal(target.activeSpans, target.activeMinutes, target.activityTs, targetMs);
    await store.updateSession(target.id, {
      activeSpans: res.spans,
      activeMinutes: res.activeMinutes,
      activityTs: res.activityTs,
      lastActivityAt: res.tailEnd ?? target.lastActivityAt,
    });
    await refreshStatus();
  });

  registerCommand('lalog.deleteSession', async (id: unknown) => {
    const sessionId = typeof id === 'string' ? id : '';
    if (!sessionId) {
      vscode.window.showInformationMessage('Use the 🗑 button on a session row in the LaLog Sessions panel.');
      return;
    }
    // Defense-in-depth: the live session has no panel row (it only reaches
    // sessions.jsonl when it ends), but never delete it from under the tracker.
    const live = manager.getSession();
    if (live && live.id === sessionId) {
      vscode.window.showInformationMessage(
        'End the session first — the current session is only saved to your history when it ends.'
      );
      return;
    }
    // Exact-id lookup — never fall back to the latest session (see ADR-023).
    const all = await store.loadAll();
    const target = all.find((s) => s.id === sessionId);
    if (!target) return; // stale row / already deleted — silent no-op
    const label = target.description || target.workspaceName;
    const confirm = await vscode.window.showWarningMessage(
      `Delete session "${label}"? This removes it from your history and deletes its technical sidecar. This cannot be undone.`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') return;
    const removed = await store.deleteSession(sessionId);
    if (!removed) return;
    technicalStore.delete(sessionId);
    await refreshStatus();
  });

  registerCommand('lalog.sessionDetail', async (id: unknown) => {
    const sid = typeof id === 'string' ? id : undefined;
    if (!sid) return;
    const all = await store.loadAll();
    const active = manager.getSession();
    const target = all.find((s) => s.id === sid) ?? (active && active.id === sid ? active : undefined);
    if (!target) {
      vscode.window.showInformationMessage('Session not found.');
      return;
    }
    const projects = projectRegistry.list();
    const md = renderSessionDetail({
      session: target,
      project: resolveProject(target, projects),
      technical: technicalStore.read(target.id), // RAW — never filtered by retention
      retentionDays: cfg.diffRetentionDays > 0 ? cfg.diffRetentionDays : null,
      now: Date.now(),
      idleGapMs: th.idleGap,
    });
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  registerCommand('lalog.dayDiffs', async (day: unknown) => {
    const all = await store.loadAll();
    const days = [...new Set(all.map((s) => dayKey(s.startedAt)))].sort().reverse().slice(0, 31);
    if (!days.length) {
      vscode.window.showInformationMessage('No sessions recorded yet.');
      return;
    }
    let pick = typeof day === 'string' && days.includes(day) ? day : undefined;
    if (!pick) {
      const choice = await vscode.window.showQuickPick(
        days.map((d) => ({ label: d, id: d })),
        { title: 'File diffs for day', placeHolder: 'Choose a day' }
      );
      if (!choice) return;
      pick = choice.id;
    }
    const daySessions = all
      .filter((s) => dayKey(s.startedAt) === pick)
      .sort((a, b) => a.startedAt - b.startedAt);
    const md = renderDayDiffs({
      day: pick,
      sessions: daySessions.map((s) => ({ session: s, technical: technicalStore.read(s.id) })),
      retentionDays: cfg.diffRetentionDays > 0 ? cfg.diffRetentionDays : null,
      now: Date.now(),
    });
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  registerCommand('lalog.exportFilesByDay', async () => {
    const all = await store.loadAll();
    const files = await exportFilesByDay(paths, all);
    vscode.window.showInformationMessage(
      files.length ? `Exported ${files.length} day-file(s).` : 'Nothing to export yet.'
    );
  });

  // Rename the implicit project. The new name is picked up everywhere on the
  // next refresh: project names always resolve at render time, never cached.
  registerCommand('lalog.renameProject', async (id: unknown) => {
    const list = projectRegistry.list();
    // Palette fallback targets THIS window's project so a single-mode window
    // can never rename an invisible other-workspace project (ADR-030).
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const wsKey = wsPath ? workspaceKey(wsPath) : undefined;
    const target =
      (typeof id === 'string' ? list.find((p) => p.id === id) : undefined) ??
      (wsKey ? list.find((p) => p.workspaceKeys.includes(wsKey) && !p.archivedAt) : undefined) ??
      list.find((p) => !p.archivedAt) ??
      list[0];
    if (!target) {
      vscode.window.showInformationMessage('No project to rename.');
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'Rename project',
      value: target.name,
      ignoreFocusOut: true,
    });
    if (!name?.trim() || name.trim() === target.name) return;
    projectRegistry.rename(target.id, name.trim());
    await refreshStatus();
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

  // Per-workspace project (ADR-030). Every distinct workspace gets its own
  // project, named from the VS Code workspace name; an already-collapsed legacy
  // record is split once. Both steps are synchronous file rewrites, so no render
  // ever sees a half-written projects.json. Idempotent: safe on every activation.
  if (!cfg.multiProject) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      const wsPath = folder.uri.fsPath;
      const history = await store.loadAll();
      projectRegistry.ensureWorkspaceProject({
        wsKey: workspaceKey(wsPath),
        wsPath,
        vscName: vscode.workspace.name ?? folder.name ?? workspaceName(wsPath),
        history,
      });
      // Heal dangling explicit assignments: a session whose projectId is unknown
      // is re-pointed at whichever project claims ITS OWN workspace key.
      const known = new Set(projectRegistry.list().map((p) => p.id));
      for (const s of history) {
        if (s.projectId && !known.has(s.projectId)) {
          const owner = projectRegistry.list().find((p) => p.workspaceKeys.includes(s.workspaceKey));
          if (owner) await store.updateSession(s.id, { projectId: owner.id });
        }
      }
    }
  }

  // Diffs-only retention sweep: terminal and AI metadata are kept forever.
  if (cfg.diffRetentionDays > 0) {
    technicalStore.pruneDiffEntriesBefore(Date.now() - cfg.diffRetentionDays * 86_400_000);
  }

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

/**
 * Prompt for a report range, plus a validated custom window when picked.
 * Returns undefined when the user cancels or supplies an unusable range.
 */
async function pickReportRange(
  title: string
): Promise<{ range: ReportRange; custom?: { start: number; end: number } } | undefined> {
  const rangePick = await vscode.window.showQuickPick(
    [
      { label: 'Today', id: 'today' as ReportRange },
      { label: 'Yesterday', id: 'yesterday' as ReportRange },
      { label: 'This week', id: 'week' as ReportRange },
      { label: 'This month', id: 'month' as ReportRange },
      { label: 'Last month', id: 'last-month' as ReportRange },
      { label: 'Custom range\u2026', id: 'custom' as ReportRange },
    ],
    { title }
  );
  if (!rangePick) return undefined;
  const range = rangePick.id;
  if (range !== 'custom') return { range };
  const input = await vscode.window.showInputBox({
    title: 'Custom report range',
    placeHolder: 'YYYY-MM-DD...YYYY-MM-DD (max 31 days)',
    value: `${dayKey(Date.now())}...${dayKey(Date.now())}`,
    ignoreFocusOut: true,
  });
  const m = input?.trim().match(/^(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})$/);
  if (!m) {
    vscode.window.showInformationMessage('Custom range needs two dates: YYYY-MM-DD...YYYY-MM-DD');
    return undefined;
  }
  const start = parseDay(m[1]);
  const end = parseDay(m[2]);
  if (end <= start) {
    vscode.window.showInformationMessage('End date must be after start date.');
    return undefined;
  }
  if (calendarDayCount(start, end) > 31) {
    vscode.window.showInformationMessage('Custom range is limited to 31 days.');
    return undefined;
  }
  const endInclusive = new Date(end);
  endInclusive.setDate(endInclusive.getDate() + 1);
  return {
    range,
    custom: {
      start,
      end: new Date(
        endInclusive.getFullYear(),
        endInclusive.getMonth(),
        endInclusive.getDate()
      ).getTime(),
    },
  };
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
