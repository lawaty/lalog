import * as vscode from 'vscode';
import { ThresholdsMs } from '../core/config';
import { Session } from '../core/types';
import { Machine } from '../core/stateMachine';
import { BreakpointKind } from '../core/breakpoints';
import { runDescribeFlow, DescribeResult } from './describeFlow';

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
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(split-horizontal) Wrap session & start a new one', description: `close "${session.workspaceName}"` },
          { label: '$(clock) Extend 30 min', description: 'keep working, longer prompt later' },
          { label: '$(pencil) Add/update description', description: 'describe before wrapping' },
          { label: '$(mute) Skip', description: 'handle in the sessions view' },
        ],
        { title: `Session${desc} at ${activeH} — wrap it up?`, placeHolder: 'Choose', ignoreFocusOut: true }
      );
      if (!pick) return { choice: 'skipped' };
      if (pick.label.includes('Wrap session')) return { choice: 'wrap-new' };
      if (pick.label.includes('Extend 30')) return { choice: 'extend' };
      if (pick.label.includes('description')) return { choice: 'add-description' };
      return { choice: 'skipped' };
    } finally {
      this.release();
    }
  }

  /** Closing-note prompt on recovery (session went idle >2h with no note). */
  async askClosingNote(session: Session): Promise<string | null> {
    if (!(await this.acquire())) return null;
    try {
      const activeH = fmtDuration(session.activeMinutes);
      const text = await vscode.window.showInputBox({
        title: `Unfinished session "${session.workspaceName}" (${activeH} active)`,
        value: session.description ?? '',
        placeHolder: 'closing note (what got done)?',
        prompt: 'Enter to save · Esc to skip — can add later from sessions view.',
        ignoreFocusOut: true,
      });
      return text === undefined ? null : text;
    } finally {
      this.release();
    }
  }

  /** Ask for an optional description of a session that VS Code shutdown ended. */
  async askShutdownDescription(session: Session): Promise<string | null> {
    if (!(await this.acquire())) return null;
    try {
      const activeH = fmtDuration(session.activeMinutes);
      const text = await vscode.window.showInputBox({
        title: `Describe your last session in "${session.workspaceName}" (${activeH} active)`,
        value: session.description ?? '',
        placeHolder: 'optional — e.g. "fixed the payment parsing bug"',
        prompt: 'It was ended when VS Code closed. Optional · Esc to skip — add later from sessions view.',
        ignoreFocusOut: true,
      });
      return text === undefined ? null : text.trim() ? text.trim() : null;
    } finally {
      this.release();
    }
  }

  /** 'Are you still there?' — fired by the heartbeat when a session goes idle. */
  async askStillWorking(session: Session): Promise<'active' | 'end' | null> {
    if (!(await this.acquire())) return null;
    try {
      const activeH = fmtDuration(session.activeMinutes);
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: '$(check) Yes, still working',
            description: 'keep tracking — this idle time counts as outside-VS-Code work',
          },
          {
            label: '$(stop) No, end this session',
            description: `close session (${activeH} active)`,
          },
        ],
        { title: `Are you still there? · ${session.workspaceName}`, placeHolder: 'Idle for a while — still working?', ignoreFocusOut: true }
      );
      if (!pick) return null;
      return pick.label.includes('Yes') ? 'active' : 'end';
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
