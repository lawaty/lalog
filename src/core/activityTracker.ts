import * as vscode from 'vscode';
import { ThresholdsMs } from '../core/config';
import { TrackedEvent } from '../core/types';
import { Session } from '../core/types';

export type ActivityHandler = (ev: TrackedEvent, filePath?: string, now?: number) => void;

/**
 * Listens to VS Code editor/terminal/task events and forwards them to a handler.
 * Keeps no session state — only the event stream.
 */
export class ActivityTracker {
  private disposables: vscode.Disposable[] = [];
  private editDebounce: Map<string, { timer: NodeJS.Timeout; ts: number }> = new Map();
  private readonly editDelayMs = 2000;

  constructor(
    private handler: ActivityHandler,
    private th: ThresholdsMs,
    private logTerminal: boolean
  ) {}

  start(): void {
    const h = this.handler;

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e?.document) h('editor', e.document.uri.fsPath);
      })
    );

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((ev) => {
        const doc = ev.document;
        if (doc.uri.scheme !== 'file') return;
        const p = doc.uri.fsPath;
        const key = p;
        const existing = this.editDebounce.get(key);
        const now = Date.now();
        if (existing) {
          clearTimeout(existing.timer);
        }
        const timer = setTimeout(() => {
          this.editDebounce.delete(key);
          h('edit', p, now);
        }, this.editDelayMs);
        this.editDebounce.set(key, { timer, ts: now });
      })
    );

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === 'file') h('save', doc.uri.fsPath);
      })
    );

    this.disposables.push(
      vscode.workspace.onDidCreateFiles((ev) => ev.files.forEach((u) => h('fileop', u.fsPath))),
      vscode.workspace.onDidDeleteFiles((ev) => ev.files.forEach((u) => h('fileop', u.fsPath))),
      vscode.workspace.onDidRenameFiles((ev) => h('fileop'))
    );

    if (this.logTerminal) this.installTerminalTracking();

    this.disposables.push(
      vscode.tasks.onDidStartTask(() => h('task')),
      vscode.debug.onDidStartDebugSession(() => h('debug')),
      vscode.debug.onDidTerminateDebugSession(() => h('debug'))
    );
  }

  private installTerminalTracking(): void {
    const h = this.handler;
    const api = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: (
        cb: (e: unknown) => void
      ) => vscode.Disposable;
      onDidEndTerminalShellExecution?: (cb: (e: unknown) => void) => vscode.Disposable;
    };
    // Feature-detect shell-integration API (VS Code >= 1.93)
    if (api.onDidStartTerminalShellExecution) {
      this.disposables.push(api.onDidStartTerminalShellExecution(() => h('terminal')));
      if (api.onDidEndTerminalShellExecution) {
        this.disposables.push(api.onDidEndTerminalShellExecution(() => h('terminal')));
      }
    } else {
      // Fallback: terminal open/close only
      this.disposables.push(vscode.window.onDidOpenTerminal(() => h('terminal')));
      this.disposables.push(vscode.window.onDidCloseTerminal(() => h('terminal')));
    }
  }

  dispose(): void {
    this.editDebounce.forEach((v) => clearTimeout(v.timer));
    this.editDebounce.clear();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
