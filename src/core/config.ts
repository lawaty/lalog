import * as vscode from 'vscode';

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
  askDescriptionOnStart: boolean;
  autoEndAfterIdleMinutes: number;
  resumeWindowMinutes: number;
  debugTimeScale: number;
  logTerminalCommands: boolean;
  redactPatterns: string[];
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
  askDescriptionOnStart: true,
  autoEndAfterIdleMinutes: 120,
  resumeWindowMinutes: 30,
  debugTimeScale: 1,
  logTerminalCommands: true,
  redactPatterns: ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'PASS=', 'API_KEY', 'api[-_]?key'],
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
  resumeWindow: number;
  /** Not a duration — max free 'extend' choices before description is required. */
  maxGraceExtensions: number;
}

export function thresholdsMs(cfg: LaLogConfig): ThresholdsMs {
  const scale = cfg.debugTimeScale || 1;
  const m = (min: number) => Math.round((min * 60 * 1000) / Math.max(1, scale));
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
    autoEndIdle: m(cfg.autoEndAfterIdleMinutes),
    resumeWindow: m(cfg.resumeWindowMinutes),
    maxGraceExtensions: Math.max(1, cfg.maxGraceExtensions),
  };
}
