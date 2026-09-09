import * as vscode from 'vscode';
import { ThresholdsMs } from '../core/config';
import { Session } from '../core/types';
import { Machine } from '../core/stateMachine';
import { BreakpointKind } from '../core/breakpoints';
import { runDescribeFlow, DescribeResult } from './describeFlow';
import { buildPrefill } from './describeFlow';

export type WrapResult =
  | { choice: 'wrap-new' }
  | { choice: 'extend' }
  | { choice: 'extend-described' }
  | { choice: 'add-description' }
  | { choice: 'skipped' };

export class PromptCoordinator {
  private visible = false;
  private lastShownAt = 0;
  private readonly minSpacingMs: number;
  /** Injected AI draft callback (optional). Keeps this module free of opencode imports. */
  aiDraft: (() => Promise<string>) | undefined;

  constructor(private th: ThresholdsMs) {
    const scale = Math.max(1, 5400000 / Math.max(1, th.describeAt)); // debugTimeScale-equivalent
    this.minSpacingMs = Math.max(200, (2 * 60 * 1000) / scale);
  }

  /** Only one prompt visible at a time; min spacing between any two. */
  private async acquire(): Promise<boolean> {
    const now = Date.now();
    if (this.visible) return false;
    if (now - this.lastShownAt < this.minSpacingMs) return false;
    this.visible = true;
    this.lastShownAt = now;
    return true;
  }

  private release(): void {
    this.visible = false;
  }

  /** The 90-minute checkpoint — describe what you're doing. Returns result. */
  async askDescribe(
    machine: Machine,
    session: Session,
    breakpoint: BreakpointKind | null,
    sameAsLast?: string
  ): Promise<DescribeResult | null> {
    if (!(await this.acquire())) return null;
    try {
      const result = await runDescribeFlow(session, { sameAsLast, aiDraft: this.aiDraft });
      return result;
    } finally {
      this.release();
    }
  }

  /** The 3.5h wrap prompt. */
  async askWrap(machine: Machine, session: Session, breakpoint: BreakpointKind | null): Promise<WrapResult> {
    if (!(await this.acquire())) return { choice: 'skipped' };
    try {
      const activeH = fmtDuration(session.activeMinutes);
      const desc = session.description ? ` "${session.description}"` : '';
      const items: (vscode.QuickPickItem & { choice: WrapResult['choice'] })[] = [
        { label: '$(split-horizontal) Wrap session & start a new one', description: `close "${session.workspaceName}"`, choice: 'wrap-new' },
        { label: '$(clock) Extend 30 min', description: 'keep working, longer prompt later', choice: 'extend' },
      ];
      if (!session.anonymous) {
        items.push({ label: '$(pencil) Add/update description', description: 'describe before wrapping', choice: 'add-description' });
      }
      items.push({ label: '$(mute) Skip', description: 'handle in the sessions view', choice: 'skipped' });
      const pick = await vscode.window.showQuickPick(items, {
        title: `Session${desc} at ${activeH} — wrap it up?`,
        placeHolder: 'Choose',
        ignoreFocusOut: true,
      });
      if (!pick) return { choice: 'skipped' };
      if (pick.choice === 'wrap-new') return { choice: 'wrap-new' };
      if (pick.choice === 'extend') return { choice: 'extend' };
      if (pick.choice === 'add-description') return { choice: 'add-description' };
      return { choice: 'skipped' };
    } finally {
      this.release();
    }
  }

  /** Periodic progress check — records a timestamped note every progressAt active minutes. */
  async askProgressUpdate(session: Session): Promise<string | null> {
    if (!(await this.acquire())) return null;
    try {
      const text = await vscode.window.showInputBox({
        title: `Progress update · ${session.workspaceName}`,
        value: buildPrefill(session),
        placeHolder: 'what happened in the last hour?',
        prompt: 'Optional · Esc to skip — logged as a note with the current time.',
        ignoreFocusOut: true,
      });
      return text === undefined ? null : text.trim() ? text.trim() : null;
    } finally {
      this.release();
    }
  }

  /** 'Are you still there?' — fired by the heartbeat when a session goes idle. */
  async askStillWorking(session: Session): Promise<'active' | 'away' | 'end' | null> {
    if (!(await this.acquire())) return null;
    try {
      const activeH = fmtDuration(session.activeMinutes);
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: '$(check) Yes, still working',
            description: 'keep tracking — this idle time counts as outside-VS-Code work',
            choice: 'active' as const,
          },
          {
            label: '$(history) I was away and came back',
            description: 'trim the idle time since this prompt and keep tracking',
            choice: 'away' as const,
          },
          {
            label: '$(stop) No, end this session',
            description: `close session (${activeH} active)`,
            choice: 'end' as const,
          },
        ],
        { title: `Are you still there? · ${session.workspaceName}`, placeHolder: 'Idle for a while — still working?', ignoreFocusOut: true }
      );
      if (!pick) return null;
      return pick.choice;
    } finally {
      this.release();
    }
  }
}

export function fmtDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
