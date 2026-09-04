export type SessionState =
  | 'idle'
  | 'untracked'
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
}

export interface Thresholds {
  idleGapMin: number;
  describeAtMin: number;
  describeForceMin: number;
  wrapAtMin: number;
  wrapForceMin: number;
  graceMin: number;
  maxGraceExtensions: number;
  hardSplitMin: number;
  autoEndIdleMin: number;
  resumeWindowMin: number;
  untrackedNudgeMin: number;
}

/** All thresholds in milliseconds, after applying debugTimeScale. */
export interface ResolvedThresholds extends Record<keyof Thresholds, number> {}

export type TrackedEvent = 'edit' | 'save' | 'terminal' | 'fileop' | 'editor' | 'debug' | 'task';
