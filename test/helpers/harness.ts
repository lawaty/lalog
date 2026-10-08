// test/helpers/harness.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TestContext } from 'node:test';
import { SessionManager } from '../../src/core/sessionManager';
import { SessionStore } from '../../src/storage/sessionStore';
import { TechnicalStore } from '../../src/storage/technicalStore';
import { buildPaths, ensureDirs, LaLogPaths, workspaceKey } from '../../src/storage/store';
import { thresholdsMs, LaLogConfig, ThresholdsMs, AiConfig, OpencodeActivityConfig } from '../../src/core/config';
import { LaLogPanelProvider } from '../../src/ui/panelView';
import { ProjectRegistry } from '../../src/storage/projectRegistry';
import { mockVscode } from './mockVscode';
import type { Session } from '../../src/core/types';

export const MIN = 60 * 1000;
export const BASE_TIME = Date.parse('2026-09-21T09:00:00');

export function defaultConfig(overrides: Partial<LaLogConfig> = {}): LaLogConfig {
  return {
    dataDir: '~/.lalog',
    describeAfterMinutes: 90,
    wrapAfterMinutes: 210,
    graceMinutes: 30,
    maxGraceExtensions: 3,
    idleGapMinutes: 15,
    idleConfirmAfterMinutes: 100000,
    progressAfterMinutes: 100000,
    autoEndAfterIdleMinutes: 100000,
    staleSessionAfterMinutes: 100000,
    debugTimeScale: 60,
    logTerminalCommands: true,
    redactPatterns: ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'PASS=', 'API_KEY', 'api[-_]?key'],
    captureDiffs: false,
    captureTerminal: false,
    captureTerminalStdout: false,
    captureAiLog: false,
    maxDiffChars: 16000,
    maxStdoutChars: 32000,
    diffRetentionDays: 14,
    ...overrides,
  };
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

export async function tick(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  await flush();
}

export async function waitFor(cond: () => boolean, maxIterations = 2000): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitFor: condition not met');
}

export interface Harness {
  manager: SessionManager;
  store: SessionStore;
  paths: LaLogPaths;
  th: ThresholdsMs;
  cfg: LaLogConfig;
  dir: string;
  wsPath: string;
  wsKey: string;
  wsName: string;
  start(): Promise<void>;
  tick(ms: number): Promise<void>;
  flush(): Promise<void>;
  heartbeat(): Promise<void>;
  edit(file?: string): Promise<void>;
  save(file?: string): void;
  editor(file?: string): void;
  fileop(): void;
  task(): void;
  debugStart(): void;
  debugEnd(): void;
  terminalShellStart(execution?: any): any;
  terminalShellEnd(execution: any, exitCode?: number): void;
  work(seconds: number): Promise<void>;
  driveToWrap(): Promise<void>;
  closedSessions(): Promise<Session[]>;
  activeSnapshot(): Session | null;
  dispose(): void;
}

export function createHarness(
  t: TestContext,
  opts: {
    config?: Partial<LaLogConfig>;
    wsPath?: string;
    dir?: string;
    /** `vscode.workspace.name` for the window; undefined = single-folder window. */
    vscWorkspaceName?: string;
  } = {}
): Harness {
  const cfg = defaultConfig(opts.config);
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-harness-'));
  const paths = buildPaths(dir);
  ensureDirs(paths);
  const th = thresholdsMs(cfg);
  const store = new SessionStore({ paths, th });
  const techStore = new TechnicalStore(paths.technicalDir);
  const wsPath = opts.wsPath ?? path.join(dir, 'workspace');
  fs.mkdirSync(wsPath, { recursive: true });
  const wsKey = workspaceKey(wsPath);
  const wsName = path.basename(wsPath);
  mockVscode.setWorkspaceFolders([wsPath], { name: opts.vscWorkspaceName });
  const manager = new SessionManager(store, th, paths, cfg, techStore);

  const h: Harness = {
    manager,
    store,
    paths,
    th,
    cfg,
    dir,
    wsPath,
    wsKey,
    wsName,
    async start() {
      manager.start();
      await h.flush();
    },
    async tick(ms) {
      t.mock.timers.tick(ms);
      await h.flush();
    },
    async flush() {
      await flush();
    },
    async heartbeat() {
      await h.tick(60 * 1000);
    },
    async edit(file = path.join(wsPath, 'src', 'a.ts')) {
      mockVscode.fireEdit(file);
      await h.tick(2000);
    },
    save(file = path.join(wsPath, 'src', 'a.ts')) {
      mockVscode.fireSave(file);
    },
    editor(file = path.join(wsPath, 'src', 'a.ts')) {
      mockVscode.fireEditorChange(file);
    },
    fileop() {
      mockVscode.fireCreateFiles([path.join(wsPath, 'src', 'new.ts')]);
    },
    task() {
      mockVscode.fireTaskStart();
    },
    debugStart() {
      mockVscode.fireDebugStart();
    },
    debugEnd() {
      mockVscode.fireDebugEnd();
    },
    terminalShellStart(execution?: any) {
      return mockVscode.fireTerminalShellStart(execution);
    },
    terminalShellEnd(execution: any, exitCode?: number) {
      mockVscode.fireTerminalShellEnd(execution, exitCode);
    },
    async work(seconds) {
      const steps = Math.ceil(seconds / 5);
      for (let i = 0; i < steps; i++) {
        await h.edit();
        await h.tick(3000);
      }
    },
    async driveToWrap() {
      for (let i = 0; i < 20 && h.manager.getMachine().state !== 'wrapPending'; i++) {
        if (
          h.manager.getMachine().state === 'describePending' &&
          h.manager.getMachine().activeMinutes < h.th.wrapAt
        ) {
          mockVscode.queueInputBox(`desc ${i}`);
          mockVscode.queueQuickPick('other');
          h.debugEnd();
          await h.flush();
        }
        await h.work(25);
      }
    },
    async closedSessions() {
      const fresh = new SessionStore({ paths, th });
      return fresh.loadAll();
    },
    activeSnapshot() {
      return store.loadActive(wsKey);
    },
    dispose() {
      manager.dispose();
    },
  };
  return h;
}

export function setupHarness(
  t: TestContext,
  opts: {
    config?: Partial<LaLogConfig>;
    wsPath?: string;
    dir?: string;
    vscWorkspaceName?: string;
  } = {}
): Harness {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(BASE_TIME);
  const h = createHarness(t, opts);
  t.after(() => {
    h.dispose();
    t.mock.timers.reset();
    mockVscode.reset();
  });
  return h;
}

export function mockWebviewView() {
  let handler: ((msg: any) => void) | null = null;
  return {
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: (cb: (msg: any) => void) => {
        handler = cb;
        return { dispose() {} };
      },
      postMessage: (msg: any) => {
        mockVscode._webviewMessages.push(msg);
        return Promise.resolve(true);
      },
    },
    _post: (msg: any) => {
      if (handler) handler(msg);
    },
  };
}

export async function activateExtension(
  t: TestContext,
  opts: {
    config?: Partial<LaLogConfig>;
    ai?: Partial<AiConfig>;
    activity?: Partial<OpencodeActivityConfig>;
    /** Pre-existing data dir (for pre-seeded projects.json / sessions.jsonl). */
    dir?: string;
    /** Workspace folder to report; defaults to `<dir>/workspace`. */
    wsPath?: string;
    /** `vscode.workspace.name` for the window; undefined = single-folder window. */
    vscWorkspaceName?: string;
  } = {}
): Promise<{ ctx: any; paths: LaLogPaths; th: ThresholdsMs; dir: string; wsPath: string }> {
  const cfg = defaultConfig(opts.config);
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lalog-ext-'));
  cfg.dataDir = dir;
  mockVscode.setConfig('lalog', cfg);
  mockVscode.setConfig('lalog.ai', {
    enabled: false,
    model: 'opencode/big-pickle',
    opencodePath: 'opencode',
    timeoutMs: 60000,
    maxRetries: 2,
    sendCommitSubjects: true,
    ...opts.ai,
  });
  // `lalog.opencode.activity` is its own namespace. The product default is ON, but a
  // real `activate()` here would then build a live ServeWatcher — global `fetch`, and
  // `manageServe` spawning a real `opencode serve` in a temp workspace. Tests pin it OFF
  // unless they opt in; every other key still falls through to the reader's defaults.
  mockVscode.setConfig('lalog.opencode.activity', { enabled: false, ...opts.activity });
  const wsPath = opts.wsPath ?? path.join(dir, 'workspace');
  fs.mkdirSync(wsPath, { recursive: true });
  mockVscode.setWorkspaceFolders([wsPath], { name: opts.vscWorkspaceName });
  const ctx = {
    subscriptions: [] as any[],
    globalState: { get: () => undefined, update: async () => undefined },
  };
  const { activate } = await import('../../src/extension');
  await activate(ctx as any);
  await flush();
  return { ctx, paths: buildPaths(dir), th: thresholdsMs(cfg), dir, wsPath };
}

export async function setupExtension(
  t: TestContext,
  opts: {
    config?: Partial<LaLogConfig>;
    ai?: Partial<AiConfig>;
    activity?: Partial<OpencodeActivityConfig>;
    dir?: string;
    wsPath?: string;
    vscWorkspaceName?: string;
  } = {}
): Promise<{ ctx: any; paths: LaLogPaths; th: ThresholdsMs; dir: string; wsPath: string }> {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(BASE_TIME);
  const ext = await activateExtension(t, opts);
  t.after(async () => {
    try {
      const { deactivate } = await import('../../src/extension');
      await deactivate();
    } catch {
      /* ignore */
    }
    for (const s of ext.ctx.subscriptions) {
      try {
        s?.dispose?.();
      } catch {
        /* ignore */
      }
    }
    t.mock.timers.reset();
    mockVscode.reset();
  });
  return ext;
}

/** Build a real LaLogPanelProvider over a harness and resolve its webview. */
export function resolvePanel(
  h: Harness,
  opts: { multiProject?: boolean } = {}
): { provider: LaLogPanelProvider; registry: ProjectRegistry; view: any } {
  const registry = new ProjectRegistry(h.paths);
  const provider = new LaLogPanelProvider(
    () => h.store.loadAll(),
    () => h.manager.getSession(),
    () => ({
      todayActiveMs: 0,
      paused: h.manager.isPaused(),
      idleGap: h.th.idleGap,
      wsKey: h.wsKey,
      wsName: h.wsName,
      wsPath: h.wsPath,
      // Harness default is multi mode: the US-5.x stories are about explicit
      // project management. Default-mode tests pass `false` explicitly.
      multiProject: opts.multiProject ?? true,
    }),
    h.store,
    registry,
    (projectId: string | undefined) => h.manager.assignProject(projectId)
  );
  const view = mockWebviewView();
  provider.resolveWebviewView(view);
  return { provider, registry, view };
}