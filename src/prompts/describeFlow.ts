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
 * 2. If text was entered: pick a task type — Enter accepts the highlighted default,
 *    or override with Draft-with-AI / background / later.
 *    If no text (Esc or empty): a small QuickPick keeps Same-as-last, AI draft,
 *    background, and later reachable without typing.
 * Esc at the end = skip (flagged needsDescription), never blocks.
 *
 * The old flow asked the QuickPick task type first, so typed descriptions landed
 * in the filter box and were silently discarded on Enter — this "text first"
 * order guarantees a description typed into the box is always submitted.
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
    prompt: 'Enter to save · Esc for task type, AI draft, or background.',
    ignoreFocusOut: true,
  });
  const trimmed = (text ?? '').trim();
  if (!trimmed) return pickNoText(sameAsLast, aiDraft, anonymous, prefill);

  return pickTypeWithText(trimmed, aiDraft, anonymous);
}

/** Type picker shown after text was entered. Enter accepts the default type. */
async function pickTypeWithText(
  text: string,
  aiDraft: (() => Promise<string>) | undefined,
  anonymous: boolean
): Promise<DescribeResult> {
  const typeItems = SESSION_TYPES.map(
    (t) => ({ label: t, t: t as SessionType }) as vscode.QuickPickItem & { t: SessionType | 'ai' | 'background' | 'later' }
  );
  const items: (vscode.QuickPickItem & { t: SessionType | 'ai' | 'background' | 'later' })[] = [...typeItems];
  if (aiDraft) {
    items.push({ label: '$(sparkle) Draft with AI', description: 'opencode rewrites this description', t: 'ai' });
  }
  if (!anonymous) {
    items.push({ label: '$(mute) Keep as background work', detail: 'no description — LaLog stops asking about this session', t: 'background' });
  }
  items.push({ label: '$(clock) Later', detail: 'skip for now, add from backlog', t: 'later' });

  const chosen = await quickPickWithDefault(items, {
    title: 'Task type?',
    placeHolder: 'Enter saves as "other" — pick another type to override.',
  });
  if (!chosen) return { choice: 'skipped' };
  if (chosen.t === 'ai' && aiDraft) return acceptAiDraft(aiDraft, text);
  if (chosen.t === 'background') return { choice: 'background' };
  if (chosen.t === 'later') return { choice: 'later' };
  return { choice: 'described', type: chosen.t as SessionType, text };
}

/**
 * Low-level QuickPick with a pre-selected default so pressing Enter accepts it
 * (instead of closing with undefined and discarding the value).
 */
async function quickPickWithDefault<T extends vscode.QuickPickItem>(
  allItems: T[],
  opts: { title?: string; placeHolder?: string }
): Promise<T | undefined> {
  const defaultItem = allItems[0];
  const qp = vscode.window.createQuickPick<T>();
  qp.title = opts.title;
  qp.placeholder = opts.placeHolder;
  qp.items = allItems;
  qp.activeItems = [defaultItem];
  qp.ignoreFocusOut = true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: T | undefined) => {
      if (done) return;
      done = true;
      qp.hide();
      qp.dispose();
      resolve(value);
    };
    qp.onDidAccept(() => finish(qp.selectedItems[0] ?? qp.activeItems[0]));
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
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
  if (chosen.t === 'same' && sameAsLast) return { choice: 'described', type: 'other', text: sameAsLast };
  if (chosen.t === 'ai' && aiDraft) return acceptAiDraft(aiDraft, prefill);
  if (chosen.t === 'background') return { choice: 'background' };
  return { choice: 'later' };
}

/** Run the AI draft and let the user accept/edit it as an 'other'-type description. */
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
  return { choice: 'described', type: 'other', text: trimmed };
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
