export type SessionState =
  | 'idle'
  | 'active'
  | 'describePending'
  | 'wrapPending'
  | 'grace';

export type SessionType =
  | 'feature'
  | 'bugfix'
  | 'research'
  | 'refactor'
  | 'review'
  | 'docs'
  | 'ops'
  | 'other';

export type ClosedReason =
  | 'user'
  | 'auto-idle'
  | 'auto-split'
  | 'workspace-switch'
  | 'vscode-shutdown'
  | 'recovery-skip';

export interface FileTouch {
  path: string;
  edits: number;
  firstTouch: number;
  lastTouch: number;
}

export interface SessionCommits {
  hash: string;
  subject: string;
}

/** A contiguous period counted as active (no source tag — classified at filter time). */
export interface ActiveSpan {
  start: number;
  end: number;
}

export interface Session {
  id: string;
  workspaceKey: string;
  workspaceName: string;
  startedAt: number;
  endedAt?: number;
  lastActivityAt: number;
  activeMinutes: number;
  type?: SessionType;
  description?: string;
  notes: { at: number; text: string }[];
  needsDescription: boolean;
  events: {
    edits: number;
    saves: number;
    terminal: number;
    topFiles: FileTouch[]; // top 10, by edit count
  };
  gitBranch?: string;
  commits?: SessionCommits[];
  closedReason?: ClosedReason;
  /** Contiguous active periods (start/end). Sum equals activeMinutes. */
  activeSpans: ActiveSpan[];
  /** Raw timestamps of detected VS Code activity (edits/saves/terminal/etc). */
  activityTs: number[];
}

export type TrackedEvent = 'edit' | 'save' | 'terminal' | 'fileop' | 'editor' | 'debug' | 'task';
