import * as vscode from 'vscode';

/** Default idle gap in ms — fallback for reporting/UI when no config value is threaded. */
export const DEFAULT_IDLE_GAP_MS = 15 * 60 * 1000;

/** Raw config values read from VS Code settings (minutes for time fields). */
export interface LaLogConfig {
  dataDir: string;
  describeAfterMinutes: number;
  wrapAfterMinutes: number;
  graceMinutes: number;
  maxGraceExtensions: number;
  idleGapMinutes: number;
  idleConfirmAfterMinutes: number;
  progressAfterMinutes: number;
  autoEndAfterIdleMinutes: number;
  staleSessionAfterMinutes: number;
  debugTimeScale: number;
  logTerminalCommands: boolean;
  redactPatterns: string[];
  captureDiffs: boolean;
  captureTerminal: boolean;
  captureTerminalStdout: boolean;
  captureAiLog: boolean;
  maxDiffChars: number;
  maxStdoutChars: number;
  /** Days to keep captured file diffs; 0 keeps them forever. Terminal/AI entries never expire. */
  diffRetentionDays: number;
  /**
   * Advanced: manage several projects explicitly. Off by default — LaLog keeps
   * one project per workspace, named after the VS Code workspace and renameable
   * (a rename sticks). See ADR-030.
   */
  multiProject: boolean;
}

const DEFAULTS: LaLogConfig = {
  dataDir: '~/.lalog',
  describeAfterMinutes: 90,
  wrapAfterMinutes: 210,
  graceMinutes: 30,
  maxGraceExtensions: 3,
  idleGapMinutes: 15,
  idleConfirmAfterMinutes: 15,
  progressAfterMinutes: 60,
  autoEndAfterIdleMinutes: 120,
  staleSessionAfterMinutes: 60,
  debugTimeScale: 1,
  logTerminalCommands: true,
  redactPatterns: ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'PASS=', 'API_KEY', 'api[-_]?key'],
  captureDiffs: true,
  captureTerminal: true,
  captureTerminalStdout: false,
  captureAiLog: true,
  maxDiffChars: 16000,
  maxStdoutChars: 32000,
  diffRetentionDays: 14,
  multiProject: false,
};

/** Raw AI-config values read from VS Code settings. */
export interface AiConfig {
  enabled: boolean;
  model: string;
  opencodePath: string;
  timeoutMs: number;
  maxRetries: number;
  sendCommitSubjects: boolean;
}

const AI_DEFAULTS: AiConfig = {
  enabled: false,
  model: 'opencode/big-pickle',
  opencodePath: 'opencode',
  timeoutMs: 60000,
  maxRetries: 2,
  sendCommitSubjects: true,
};

export function readAiConfig(): AiConfig {
  const cfg = vscode.workspace.getConfiguration('lalog.ai');
  const out: AiConfig = { ...AI_DEFAULTS };
  (Object.keys(AI_DEFAULTS) as (keyof AiConfig)[]).forEach((k) => {
    const v = cfg.get(k as string);
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  });
  return out;
}

/**
 * Raw `lalog.opencode.activity.*` values. Off by default and independent of
 * `lalog.ai.enabled` (US-7.2): observing an opencode chat must work with AI off.
 */
export interface OpencodeActivityConfig {
  enabled: boolean;
  /** Reuse an already-running serve, else start one we own (ADR-033). */
  manageServe: boolean;
  url: string;
  /** Fast cadence for the per-session activity polls, in seconds. */
  pollIntervalSec: number;
  /**
   * How often the full session list is re-read, in seconds — the only way to
   * notice a brand-new chat, so this is the real detection latency.
   */
  discoverySec: number;
  /** Fixed port for a serve LaLog starts; 0 = let opencode pick. */
  spawnPort: number;
  /** Binary to spawn; mirrors `lalog.ai.opencodePath`. */
  opencodePath: string;
  authUser: string;
  /**
   * Undefined = LaLog generates a random password for a serve it starts.
   * An explicit '' is the opt-out: start the serve unsecured. A value is used
   * verbatim for that serve and for a server LaLog merely observes.
   */
  authPassword?: string;
}

const OPENCODE_ACTIVITY_DEFAULTS: OpencodeActivityConfig = {
  enabled: false,
  manageServe: true,
  url: 'http://127.0.0.1:4096',
  pollIntervalSec: 30,
  discoverySec: 180,
  spawnPort: 0,
  opencodePath: 'opencode',
  authUser: 'opencode',
};

export function readOpencodeActivityConfig(): OpencodeActivityConfig {
  const cfg = vscode.workspace.getConfiguration('lalog.opencode.activity');
  const out: OpencodeActivityConfig = { ...OPENCODE_ACTIVITY_DEFAULTS };
  (Object.keys(OPENCODE_ACTIVITY_DEFAULTS) as (keyof OpencodeActivityConfig)[]).forEach((k) => {
    const v = cfg.get(k as string);
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  });
  const authPassword = cfg.get<string>('authPassword');
  if (typeof authPassword === 'string') out.authPassword = authPassword;
  return out;
}

export function readConfig(): LaLogConfig {
  const cfg = vscode.workspace.getConfiguration('lalog');
  const out: LaLogConfig = { ...DEFAULTS };
  (Object.keys(DEFAULTS) as (keyof LaLogConfig)[]).forEach((k) => {
    const v = cfg.get(k as string);
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  });
  return out;
}

/** All time thresholds resolved to milliseconds with debugTimeScale applied. */
export interface ThresholdsMs {
  idleGap: number;
  idleConfirm: number;
  describeAt: number;
  describeForce: number;
  wrapAt: number;
  wrapForce: number;
  grace: number;
  hardSplit: number;
  progressAt: number;
  autoEndIdle: number;
  /** Hard cutoff: idle ms after which a session is force-closed and restarted (ADR-022). */
  staleAfter: number;
  /** Not a duration — max free 'extend' choices before description is required. */
  maxGraceExtensions: number;
}

export function thresholdsMs(cfg: LaLogConfig): ThresholdsMs {
  const scale = cfg.debugTimeScale || 1;
  const m = (min: number) => Math.round((min * 60 * 1000) / Math.max(1, scale));
  const staleAfter = m(cfg.staleSessionAfterMinutes);
  return {
    idleGap: m(cfg.idleGapMinutes),
    idleConfirm: m(cfg.idleConfirmAfterMinutes),
    describeAt: m(cfg.describeAfterMinutes),
    describeForce: m(cfg.describeAfterMinutes + 30),
    wrapAt: m(cfg.wrapAfterMinutes),
    wrapForce: m(cfg.wrapAfterMinutes + 30),
    grace: m(cfg.graceMinutes),
    hardSplit: m(300),
    progressAt: m(cfg.progressAfterMinutes),
    staleAfter,
    autoEndIdle: Math.min(m(cfg.autoEndAfterIdleMinutes), staleAfter),
    maxGraceExtensions: Math.max(1, cfg.maxGraceExtensions),
  };
}

/** Below this, polling a local HTTP endpoint costs more than it is worth. */
const OPENCODE_POLL_MIN_SEC = 5;

/**
 * Poll interval for the opencode serve watcher, resolved like every other time
 * gate: `debugTimeScale` divides it, a 5s floor keeps it sane, and a ceiling of
 * `idleConfirm / 3` means a few polls can always cross idle confirmation — so a
 * mock-timer test still reaches the idle prompt.
 *
 * This is the **fast** cadence only. The watcher doubles it per quiet poll up
 * to `opencodeSlowPollMs`, and that ceiling is deliberately not re-clamped here:
 * with the default thresholds the two coincide (15 min / 3 = 5 min), and a
 * second `idleConfirm / 3` clamp would only collapse the backoff into a
 * constant under `debugTimeScale` without protecting anything.
 */
export function opencodePollMs(pollIntervalSec: number, cfg: LaLogConfig, th: ThresholdsMs): number {
  const scale = cfg.debugTimeScale || 1;
  const scaled = Math.round((Math.max(OPENCODE_POLL_MIN_SEC, pollIntervalSec) * 1000) / Math.max(1, scale));
  return Math.max(1, Math.min(scaled, Math.floor(th.idleConfirm / 3)));
}

/** Ceiling for the adaptive (quiet) opencode cadence: five minutes. */
const OPENCODE_SLOW_POLL_MS = 5 * 60 * 1000;

/**
 * Slowest cadence the watcher may settle at, scaled like every other time gate.
 * See `opencodePollMs` for why this end is not clamped by `idleConfirm / 3`.
 */
export function opencodeSlowPollMs(cfg: LaLogConfig): number {
  const scale = cfg.debugTimeScale || 1;
  return Math.max(1, Math.round(OPENCODE_SLOW_POLL_MS / Math.max(1, scale)));
}

/**
 * How often the watcher re-lists the serve's sessions, in ms (default 180 s),
 * scaled like every other time gate and clamped to `floor(idleConfirm / 2)`.
 *
 * This is the *only* way a brand-new chat can be noticed (an id LaLog has never
 * seen cannot be fetched), so it is the real detection latency — and the reason
 * it is bounded at half of idle confirmation: a new chat must always be seen
 * well inside the window in which the session may still be idle. The 3-minute
 * default leaves a 5x margin on the 15-minute default and is 6x rarer than the
 * 30 s fast cadence, which is what keeps the load down (measured: a full list is
 * ~164-283 ms of server CPU and ~68 KB, a single session ~48 ms and ~540 B).
 */
export function opencodeDiscoveryMs(
  discoverySec: number,
  cfg: LaLogConfig,
  th: ThresholdsMs
): number {
  const scale = cfg.debugTimeScale || 1;
  const scaled = Math.round((Math.max(1, discoverySec) * 1000) / Math.max(1, scale));
  return Math.max(1, Math.min(scaled, Math.floor(th.idleConfirm / 2)));
}
