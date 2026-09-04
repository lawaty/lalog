import * as vscode from 'vscode';
import { ThresholdsMs } from '../core/config';
import { Machine } from './stateMachine';

/**
 * Tracks signals for "natural breakpoints" — moments when interrupting the
 * user costs nothing (terminal command ended, git commit, debug ended,
 * return-from-idle). Delivers these to the PromptCoordinator.
 */
export type BreakpointHandler = (kind: BreakpointKind) => void;

export type BreakpointKind = 'terminal' | 'git-commit' | 'debug' | 'return-idle' | 'force';

export class BreakpointDetector {
  private disposables: vscode.Disposable[] = [];

  constructor(
    private handler: BreakpointHandler,
    private machine: () => Machine,
    private th: ThresholdsMs
  ) {}

  start(): void {
    const api = vscode.window as unknown as {
      onDidEndTerminalShellExecution?: (cb: (e: unknown) => void) => vscode.Disposable;
    };
    if (api.onDidEndTerminalShellExecution) {
      this.disposables.push(
        api.onDidEndTerminalShellExecution((e) => {
          const cmd = (e as { commandLine?: string }).commandLine ?? '';
          this.handler(/git commit/.test(cmd) ? 'git-commit' : 'terminal');
        })
      );
    }
    this.disposables.push(
      vscode.debug.onDidTerminateDebugSession(() => this.handler('debug'))
    );
  }

  /** Check whether we've been idle and then re-engaged (called on each activity). */
  checkReturnIdle(now: number): void {
    const m = this.machine();
    if (!m.lastActivityAt) return;
    if (now - m.lastActivityAt >= this.th.idleGap) {
      this.handler('return-idle');
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
