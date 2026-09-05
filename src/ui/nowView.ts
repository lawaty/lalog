import * as vscode from 'vscode';
import type { Session } from '../core/types';
import { fmtDuration } from '../prompts/promptCoordinator';
import { splitActiveMinutes } from '../reporting/spans';
import type { ThresholdsMs } from '../core/config';

export class NowView implements vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private session: Session | null = null;
  private th: ThresholdsMs;
  private todayActiveMs = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(th: ThresholdsMs) {
    this.th = th;
    this.timer = setInterval(() => this._onDidChangeTreeData.fire(undefined), 1000);
  }

  update(session: Session | null, todayActiveMs: number): void {
    this.session = session;
    this.todayActiveMs = todayActiveMs;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const now = new Date();
    const items: vscode.TreeItem[] = [];

    const clock = new vscode.TreeItem(`$(clock) ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    clock.description = `${fmtDuration(this.todayActiveMs)} tracked today`;
    clock.tooltip = 'Current time';
    items.push(clock);

    const s = this.session;
    if (s) {
      const liveMs = Math.min(Date.now() - s.lastActivityAt, this.th.idleGap);
      const activeMs = s.activeMinutes + liveMs;
      const desc = s.description ? s.description : s.needsDescription ? '(needs description)' : '';
      const session = new vscode.TreeItem(
        `$(play) ${s.workspaceName}${desc ? ` · ${desc}` : ''}`
      );
      session.description = fmtDuration(activeMs);
      session.tooltip = `Active ${fmtDuration(activeMs)} · tracking since ${new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      const split = splitActiveMinutes(s, this.th.idleGap);
      if (split.outsideMs > 0) {
        session.description += ` · ${fmtDuration(split.outsideMs)} out`;
      }
      session.command = {
        command: 'lalog.endSession',
        title: 'End session',
      };
      items.push(session);
    } else {
      const idle = new vscode.TreeItem('$(mute) No active session');
      idle.description = 'Start one to track work';
      idle.command = {
        command: 'lalog.startSession',
        title: 'Start session',
      };
      idle.tooltip = 'Start a tracking session for this workspace';
      items.push(idle);
    }

    return items;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}