import * as vscode from 'vscode';
import { Session } from '../core/types';
import { fmtDuration } from '../prompts/promptCoordinator';

/** Display-only cap on the "live" estimate so idle time isn't shown as active. */
const LIVE_CAP_MS = 15 * 60 * 1000;

/** Status bar: "▶ <description> · 1h42m" — click for quick actions. */
export class LaLogStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private todayDuration = 0;
  private untrackedMin = 0;

  constructor(private quickActions: () => void) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'lalog.statusAction';
  }

  update(session: Session | null, todayActiveMs: number, untrackedMs: number, paused = false): void {
    this.todayDuration = todayActiveMs;
    this.untrackedMin = Math.round(untrackedMs / 60000);
    if (!session || !session.startedAt) {
      this.item.text = `$(watch) ${fmtDuration(todayActiveMs)} today`;
      this.item.tooltip = this.tooltip(paused);
      this.item.show();
      return;
    }
    const liveMs = paused ? 0 : Math.min(Date.now() - session.lastActivityAt, LIVE_CAP_MS);
    const activeMs = session.activeMinutes + liveMs;
    const desc = session.description ? ` ${session.description}` : '';
    const icon = paused ? '$(debug-pause)' : '$(play)';
    this.item.text = `${icon}${desc} · ${fmtDuration(activeMs)}${paused ? ' · paused' : ''}`;
    this.item.tooltip = this.tooltip(paused);
    this.item.show();
  }

  private tooltip(paused: boolean): string {
    const today = fmtDuration(this.todayDuration);
    const state = paused ? ' · paused' : '';
    const untracked = this.untrackedMin > 0 ? ` · ${this.untrackedMin}m untracked` : '';
    return `LaLog — ${today} today${state}${untracked}\nClick for quick actions`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
