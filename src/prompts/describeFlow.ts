import * as vscode from 'vscode';
import { Session } from '../core/types';

export type DescribeResult =
  | { choice: 'described'; text: string }
  | { choice: 'background' }
  | { choice: 'later' }
  | { choice: 'skipped' };

export interface DescribeFlowOptions {
  sameAsLast?: string;
  /** Optional AI draft callback (injected). When set, adds a "Draft with AI" option. */
  aiDraft?: () => Promise<string>;
}

/**
 * Text-first describe flow:
 * 1. InputBox for the description (pre-filled from live session data). Enter saves.
 * 2. If text was entered: save directly.
 *    If no text (Esc or empty): a small QuickPick keeps Same-as-last, AI draft,
 *    background, and later reachable without typing.
 * Esc at the end = skip (flagged needsDescription), never blocks.
 */
export async function runDescribeFlow(
  s: Session,
  opts: DescribeFlowOptions = {}
): Promise<DescribeResult> {
  const { sameAsLast, aiDraft } = opts;
  const prefill = buildPrefill(s);
  const anonymous = !!s.anonymous;

  const text = await vscode.window.showInputBox({
    title: 'What are you working on?',
    value: prefill,
    placeHolder: 'what are you doing?',
    prompt: 'Enter to save · Esc for AI draft, background, or later.',
    ignoreFocusOut: true,
  });
  const trimmed = (text ?? '').trim();
  if (!trimmed) return pickNoText(sameAsLast, aiDraft, anonymous, prefill);
  return { choice: 'described', text: trimmed };
}

/** Fallback when no text was entered: reuse-last / AI draft / background / later. */
async function pickNoText(
  sameAsLast: string | undefined,
  aiDraft: (() => Promise<string>) | undefined,
  anonymous: boolean,
  prefill: string
): Promise<DescribeResult> {
  const items: (vscode.QuickPickItem & { t: 'same' | 'ai' | 'background' | 'later' })[] = [];
  if (sameAsLast) {
    items.push({
      label: `$(history) Same as last: "${sameAsLast}"`,
      description: 'reuse description',
      t: 'same',
    });
  }
  if (aiDraft) {
    items.push({
      label: '$(sparkle) Draft with AI',
      description: 'opencode writes a draft description for this session',
      t: 'ai',
    });
  }
  if (!anonymous) {
    items.push({ label: '$(mute) Keep as background work', detail: 'no description — LaLog stops asking about this session', t: 'background' });
  }
  items.push({ label: '$(clock) Later', detail: 'skip for now, add from backlog', t: 'later' });

  const chosen = await vscode.window.showQuickPick(items, {
    title: 'Describe — skip the text?',
    placeHolder: 'Pick an option',
    ignoreFocusOut: true,
  });
  if (!chosen) return { choice: 'skipped' };
  if (chosen.t === 'same' && sameAsLast) return { choice: 'described', text: sameAsLast };
  if (chosen.t === 'ai' && aiDraft) return acceptAiDraft(aiDraft, prefill);
  if (chosen.t === 'background') return { choice: 'background' };
  return { choice: 'later' };
}

/** Run the AI draft and let the user accept/edit it as a description. */
async function acceptAiDraft(aiDraft: () => Promise<string>, prefill: string): Promise<DescribeResult> {
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
    title: 'Describe (AI draft)',
    value: draft ?? prefill,
    placeHolder: 'what are you doing?',
    ignoreFocusOut: true,
    prompt: 'Edit the AI draft, or Esc to skip.',
  });
  if (text === undefined) return { choice: 'skipped' };
  const trimmed = text.trim();
  if (!trimmed) return { choice: 'skipped' };
  return { choice: 'described', text: trimmed };
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
