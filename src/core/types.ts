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
  /** User chose "keep as background work": no labeling prompts, shown dimmed. */
  anonymous?: boolean;
  /** Manual project override. Absence = derive from workspaceKey claims. */
  projectId?: string;
  events: {
    edits: number;
    saves: number;
    terminal: number;
    fileops: number;
    tasks: number;
    debug: number;
    topFiles: FileTouch[]; // top 10, by edit count
  };
  gitBranch?: string;
  commits?: SessionCommits[];
  closedReason?: ClosedReason;
  /** Contiguous active periods (start/end). Sum equals activeMinutes. */
  activeSpans: ActiveSpan[];
  /** Absolute path to the technical detail sidecar JSONL file (set on first write). */
  technicalSidecar?: string;
  /** Raw timestamps of detected VS Code activity (edits/saves/terminal/etc). */
  activityTs: number[];
}

export type TrackedEvent = 'edit' | 'save' | 'terminal' | 'fileop' | 'editor' | 'debug' | 'task';

/** Unified diff captured at save time. */
export interface TechnicalDiff {
  type: 'diff';
  ts: number;
  path: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  newFile: boolean;
}

/** Terminal command execution captured via shell integration. */
export interface TechnicalTerminal {
  type: 'terminal';
  ts: number;
  commandLine: string;
  exitCode: number | null;
  durationMs: number;
  cwd?: string;
  stdout?: string;
  confidence: 'low' | 'medium' | 'high';
}

/** AI interaction metadata (char counts only — never prompt/response text). */
export interface TechnicalAiInteraction {
  type: 'ai';
  ts: number;
  task: string;
  model: string;
  latencyMs: number;
  promptChars: number;
  responseChars: number;
  truncated: boolean;
}

export type TechnicalEntry = TechnicalDiff | TechnicalTerminal | TechnicalAiInteraction;
