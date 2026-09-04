import * as vscode from 'vscode';
import { Session, SessionType } from '../core/types';

export const SESSION_TYPES: SessionType[] = [
  'feature',
  'bugfix',
  'research',
  'refactor',
  'review',
  'docs',
  'ops',
  'other',
];

export type DescribeResult =
  | { choice: 'described'; type: SessionType; text: string }
  | { choice: 'later' }
  | { choice: 'skipped' };

export interface DescribeFlowOptions {
  sameAsLast?: string;
  /** Optional AI draft callback (injected). When set, adds a "Draft with AI" option. */
  aiDraft?: () => Promise<string>;
}

/**
 * Two-step ~5 second flow:
 * 1. QuickPick task type.
 * 2. Pre-filled input box from live session data (top files + git branch).
 * Esc any step = skip (flagged needsDescription), never blocks.
 */
export async function runDescribeFlow(
  s: Session,
  opts: DescribeFlowOptions = {}
): Promise<DescribeResult> {
  const { sameAsLast, aiDraft } = opts;
  const prefill = buildPrefill(s);

  const pickItems: (vscode.QuickPickItem & { t: SessionType | 'same' | 'later' | 'ai' })[] = [
    ...SESSION_TYPES.map((t) => ({ label: t, t } as vscode.QuickPickItem & { t: SessionType })),
  ];
  if (sameAsLast) {
    pickItems.unshift({
      label: `$(history) Same as last: "${sameAsLast}"`,
      description: 'reuse description',
      t: 'same',
    } as vscode.QuickPickItem & { t: SessionType | 'same' });
  }
  if (aiDraft) {
    pickItems.unshift({
      label: '$(sparkle) Draft with AI',
      description: 'opencode writes a draft description for this session',
      t: 'ai',
    } as vscode.QuickPickItem & { t: SessionType | 'ai' });
  }
  pickItems.push({ label: '$(clock) Later', detail: 'skip for now, add from backlog', t: 'later' } as vscode.QuickPickItem & {
    t: SessionType | 'later';
  });

  const chosen = await vscode.window.showQuickPick(pickItems, {
    title: 'What are you working on?',
    placeHolder: 'Pick task type',
    ignoreFocusOut: true,
  });
  if (!chosen) return { choice: 'skipped' };
  if (chosen.t === 'later') return { choice: 'later' };
  if (chosen.t === 'ai' && aiDraft) {
    const draft = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LaLog: drafting description with AI…' },
      async () => {
        try {
          return await aiDraft();
        } catch {
          return undefined;
        }
      }
    );
    const text = await vscode.window.showInputBox({
      title: `Describe (AI draft)`,
      value: draft ?? prefill,
      placeHolder: 'what are you doing?',
      ignoreFocusOut: true,
      prompt: 'Edit the AI draft, or Esc to skip.',
    });
    if (text === undefined) return { choice: 'skipped' };
    const trimmed = text.trim();
    if (!trimmed) return { choice: 'skipped' };
    return { choice: 'described', type: 'other', text: trimmed };
  }
  if (chosen.t === 'same' && sameAsLast) {
    return { choice: 'described', type: 'other', text: sameAsLast };
  }
  const type = chosen.t as SessionType;

  const text = await vscode.window.showInputBox({
    title: `Describe (${type})`,
    value: prefill,
    placeHolder: 'what are you doing?',
    ignoreFocusOut: true,
    prompt: 'Enter to accept · Esc to skip — you can add it later from the sessions view.',
  });
  if (text === undefined) return { choice: 'skipped' };
  const trimmed = text.trim();
  if (!trimmed) return { choice: 'skipped' };

  return { choice: 'described', type, text: trimmed };
}

/** Deterministic pre-fill from live session data. */
export function buildPrefill(s: Session): string {
  const top = s.events.topFiles.slice(0, 3).map((f) => baseName(f.path));
  let str = s.gitBranch ? `[${s.gitBranch}] ` : '';
  if (top.length) str += top.join(', ');
  if (s.events.terminal && !top.length) str += '(terminal work)';
  return str.trim();
}

export function baseName(p: string): string {
  const clean = p.replace(/\\/g, '/');
  return clean.substring(clean.lastIndexOf('/') + 1) || clean;
}
