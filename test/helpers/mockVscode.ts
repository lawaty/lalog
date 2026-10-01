// test/mockVscode.ts
import * as path from 'path';

export interface MockEmitter<T> {
  on(cb: (e: T) => void): { dispose(): void };
  fire(e: T): void;
  clear(): void;
}

export function makeEmitter<T>(): MockEmitter<T> {
  const cbs = new Set<(e: T) => void>();
  return {
    on(cb) {
      cbs.add(cb);
      return { dispose: () => cbs.delete(cb) };
    },
    fire(e) {
      for (const cb of [...cbs]) cb(e);
    },
    clear() {
      cbs.clear();
    },
  };
}

export interface PromptCall {
  kind: 'quickPick' | 'inputBox';
  title?: string;
  value?: string;
  items?: any[];
  canPickMany?: boolean;
}

function pickFrom(items: any[], key: any): any {
  if (key === undefined) return undefined;
  if (key !== null && typeof key === 'object') return key;
  const found = items.find(
    (i) => i.choice === key || i.id === key || i.t === key || i.label === key
  );
  return found ?? { label: String(key) };
}

const allEmitters: MockEmitter<any>[] = [];
function track<T>(e: MockEmitter<T>): MockEmitter<T> {
  allEmitters.push(e);
  return e;
}

// ---- mutable state ----
let workspaceFolders: { uri: { fsPath: string }; name: string }[] | null = null;
/**
 * `vscode.workspace.name`. The harness leaves it unset unless a test opts in —
 * callers fall back to `workspaceFolders[0].name` (the folder basename), which
 * is what real VS Code reports for a single-folder window too. Tests exercise
 * both paths.
 */
let workspaceName: string | undefined;
const configMap = new Map<string, Record<string, unknown>>();
let nextQuickPickItems: any[] = [];
let nextInputBoxTexts: (string | undefined)[] = [];
let quickPickGated = false;
let quickPickGateResolve: ((v: any) => void) | null = null;
let promptCalls: PromptCall[] = [];
let infoMessages: string[] = [];
let errorMessages: string[] = [];
let warningMessages: string[] = [];
let nextWarningChoices: (string | undefined)[] = [];
let warningCalls: { msg: string; options?: any; buttons: string[] }[] = [];
let openTextContent = '';
let openedDocs: { language?: string; content?: string }[] = [];
let shownDocs: any[] = [];
let statusBarItems: any[] = [];
let webviewMessages: any[] = [];
let webviewProvider: any = null;
let openExternalCalls: any[] = [];
const commandRegistry = new Map<string, (...args: any[]) => any>();
let shellExecutionApiAvailable = true;

// ---- emitters ----
const onDidChangeTextDocument = track(makeEmitter<any>());
const onDidSaveTextDocument = track(makeEmitter<any>());
const onDidCreateFiles = track(makeEmitter<any>());
const onDidDeleteFiles = track(makeEmitter<any>());
const onDidRenameFiles = track(makeEmitter<any>());
const onDidChangeWorkspaceFolders = track(makeEmitter<void>());
const onDidChangeActiveTextEditor = track(makeEmitter<any>());
const onDidOpenTerminal = track(makeEmitter<void>());
const onDidCloseTerminal = track(makeEmitter<void>());
let onDidStartTerminalShellExecution = track(makeEmitter<any>());
let onDidEndTerminalShellExecution = track(makeEmitter<any>());
const onDidStartTask = track(makeEmitter<void>());
const onDidStartDebugSession = track(makeEmitter<void>());
const onDidTerminateDebugSession = track(makeEmitter<void>());

export const workspace = {
  get workspaceFolders() {
    return workspaceFolders;
  },
  set workspaceFolders(v) {
    workspaceFolders = v;
  },
  get name() {
    return workspaceName;
  },
  set name(v: string | undefined) {
    workspaceName = v;
  },
  getConfiguration(section: string) {
    return {
      get(key: string) {
        const map = configMap.get(section);
        return map ? map[key] : undefined;
      },
    };
  },
  openTextDocument: async (arg: any) => {
    if (arg && typeof arg === 'object' && !('fsPath' in arg) && !('scheme' in arg)) {
      const doc = { language: arg.language, content: arg.content };
      openedDocs.push(doc);
      return { getText: () => doc.content ?? '', uri: { fsPath: '' } };
    }
    return {
      getText: () => openTextContent,
      uri: { fsPath: typeof arg === 'string' ? arg : arg?.fsPath ?? '' },
    };
  },
  onDidChangeTextDocument: onDidChangeTextDocument.on,
  onDidSaveTextDocument: onDidSaveTextDocument.on,
  onDidCreateFiles: onDidCreateFiles.on,
  onDidDeleteFiles: onDidDeleteFiles.on,
  onDidRenameFiles: onDidRenameFiles.on,
  onDidChangeWorkspaceFolders: onDidChangeWorkspaceFolders.on,
};

export const window = {
  onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.on,
  onDidOpenTerminal: onDidOpenTerminal.on,
  onDidCloseTerminal: onDidCloseTerminal.on,
  get onDidStartTerminalShellExecution() {
    return shellExecutionApiAvailable ? onDidStartTerminalShellExecution.on : undefined;
  },
  get onDidEndTerminalShellExecution() {
    return shellExecutionApiAvailable ? onDidEndTerminalShellExecution.on : undefined;
  },
  showQuickPick: async (items: any[], opts?: any) => {
    promptCalls.push({
      kind: 'quickPick',
      title: opts?.title,
      items,
      canPickMany: opts?.canPickMany === true,
    });
    if (quickPickGated) {
      const v = await new Promise<any>((r) => {
        quickPickGateResolve = r;
      });
      quickPickGated = false;
      return pickFrom(items, v);
    }
    const queued = nextQuickPickItems.shift();
    if (queued === undefined) return undefined;
    if (opts?.canPickMany) {
      const keys = Array.isArray(queued) ? queued : [queued];
      return keys.map((k) => pickFrom(items, k));
    }
    return pickFrom(items, queued);
  },
  showInputBox: async (opts?: any) => {
    promptCalls.push({ kind: 'inputBox', title: opts?.title, value: opts?.value });
    const t = nextInputBoxTexts.shift();
    return t;
  },
  createQuickPick: <T>() => {
    const qp: any = {
      title: '',
      placeholder: '',
      items: [],
      activeItems: [],
      selectedItems: [],
      ignoreFocusOut: false,
      _accept: [] as (() => void)[],
      _hide: [] as (() => void)[],
      onDidAccept(cb: () => void) {
        qp._accept.push(cb);
        return { dispose() {} };
      },
      onDidHide(cb: () => void) {
        qp._hide.push(cb);
        return { dispose() {} };
      },
      show() {
        promptCalls.push({ kind: 'quickPick', title: qp.title, items: qp.items });
        const queued = nextQuickPickItems.shift();
        if (queued !== undefined) {
          const matched = pickFrom(qp.items, queued);
          if (matched) {
            qp.selectedItems = [matched];
            qp.activeItems = [matched];
          }
        }
        for (const cb of [...qp._accept]) cb();
      },
      hide() {
        for (const cb of [...qp._hide]) cb();
      },
      dispose() {},
    };
    return qp;
  },
  withProgress: async (_opts: any, task: () => Promise<any>) => task(),
  showInformationMessage: async (msg: string, ..._rest: any[]) => {
    infoMessages.push(msg);
    return undefined;
  },
  showErrorMessage: async (msg: string, ..._rest: any[]) => {
    errorMessages.push(msg);
    return undefined;
  },
  showWarningMessage: async (msg: string, ...rest: any[]) => {
    warningMessages.push(msg);
    warningCalls.push({
      msg,
      options: rest.find((r) => r && typeof r === 'object'),
      buttons: rest.filter((r) => typeof r === 'string'),
    });
    return nextWarningChoices.shift();
  },
  showTextDocument: async (doc: any, opts?: any) => {
    shownDocs.push({ doc, opts });
    return {};
  },
  createStatusBarItem: () => {
    const item = { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
    statusBarItems.push(item);
    return item;
  },
  registerWebviewViewProvider: (viewType: string, provider: any) => {
    webviewProvider = provider;
    return { dispose() {} };
  },
};

export const tasks = {
  onDidStartTask: onDidStartTask.on,
};

export const debug = {
  onDidStartDebugSession: onDidStartDebugSession.on,
  onDidTerminateDebugSession: onDidTerminateDebugSession.on,
};

export const commands = {
  _registry: commandRegistry,
  registerCommand(id: string, cb: (...args: any[]) => any) {
    commandRegistry.set(id, cb);
    return { dispose() {} };
  },
  executeCommand(id: string, ...args: any[]) {
    const cb = commandRegistry.get(id);
    return cb ? cb(...args) : undefined;
  },
};

export const env = {
  openExternal: async (uri: any) => {
    openExternalCalls.push(uri);
    return true;
  },
};

export const ProgressLocation = { Notification: 1, Window: 2 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: 'file' }),
};
export const Disposable = {
  from: (...d: any[]) => ({
    dispose() {
      for (const x of d) x?.dispose?.();
    },
  }),
};

export const mockVscode = {
  workspace,
  window,
  tasks,
  debug,
  commands,
  env,
  get _config() {
    return configMap;
  },
  get _statusBarItems() {
    return statusBarItems;
  },
  get _webviewMessages() {
    return webviewMessages;
  },
  get _webviewProvider() {
    return webviewProvider;
  },
  get _openExternalCalls() {
    return openExternalCalls;
  },
  get _infoMessages() {
    return infoMessages;
  },
  get _errorMessages() {
    return errorMessages;
  },
  get _warningMessages() {
    return warningMessages;
  },
  get _warningCalls() {
    return warningCalls;
  },
  get _promptCalls() {
    return promptCalls;
  },
  get _openTextContent() {
    return openTextContent;
  },
  set _openTextContent(v: string) {
    openTextContent = v;
  },
  get _openedDocs() {
    return openedDocs;
  },
  get _shownDocs() {
    return shownDocs;
  },

  reset() {
    for (const e of allEmitters) e.clear();
    workspaceFolders = null;
    workspaceName = undefined;
    configMap.clear();
    nextQuickPickItems = [];
    nextInputBoxTexts = [];
    quickPickGated = false;
    quickPickGateResolve = null;
    promptCalls = [];
    infoMessages = [];
    errorMessages = [];
    warningMessages = [];
    nextWarningChoices = [];
    warningCalls = [];
    openTextContent = '';
    openedDocs = [];
    shownDocs = [];
    statusBarItems = [];
    webviewMessages = [];
    webviewProvider = null;
    openExternalCalls = [];
    commandRegistry.clear();
    shellExecutionApiAvailable = true;
    onDidStartTerminalShellExecution = track(makeEmitter<any>());
    onDidEndTerminalShellExecution = track(makeEmitter<any>());
  },

  setConfig(section: string, values: Record<string, unknown>) {
    const existing = configMap.get(section) ?? {};
    configMap.set(section, { ...existing, ...values });
  },

  setWorkspaceFolders(paths: string[], opts?: { name?: string }) {
    workspaceFolders = paths.map((p) => ({
      uri: { fsPath: p },
      name: path.basename(p),
    }));
    // `name` given → a named workspace (.code-workspace / multi-root); left out
    // → single-folder window, where `vscode.workspace.name` is undefined.
    workspaceName = opts?.name;
  },

  setWorkspaceName(name: string | undefined) {
    workspaceName = name;
  },

  setShellExecutionApiAvailable(available: boolean) {
    shellExecutionApiAvailable = available;
  },

  queueQuickPick(item: any) {
    nextQuickPickItems.push(item);
  },
  queueQuickPickMany(keys: any[]) {
    nextQuickPickItems.push(keys);
  },
  queueWarningChoice(choice: string | undefined) {
    nextWarningChoices.push(choice);
  },
  queueInputBox(text: string | undefined) {
    nextInputBoxTexts.push(text);
  },
  gateQuickPick() {
    quickPickGated = true;
  },
  releaseQuickPick(item: any) {
    if (quickPickGateResolve) {
      quickPickGateResolve(item);
      quickPickGateResolve = null;
    }
    quickPickGated = false;
  },
  promptCalls(): PromptCall[] {
    return promptCalls;
  },

  fireEditorChange(fsPath: string) {
    onDidChangeActiveTextEditor.fire({ document: { uri: { fsPath } } });
  },
  fireEdit(fsPath: string) {
    onDidChangeTextDocument.fire({ document: { uri: { scheme: 'file', fsPath } } });
  },
  fireSave(fsPath: string) {
    onDidSaveTextDocument.fire({ uri: { scheme: 'file', fsPath } });
  },
  fireCreateFiles(paths: string[]) {
    onDidCreateFiles.fire({ files: paths.map((p) => ({ fsPath: p })) });
  },
  fireDeleteFiles(paths: string[]) {
    onDidDeleteFiles.fire({ files: paths.map((p) => ({ fsPath: p })) });
  },
  fireRenameFiles() {
    onDidRenameFiles.fire({ files: [] });
  },
  fireTaskStart() {
    onDidStartTask.fire();
  },
  fireDebugStart() {
    onDidStartDebugSession.fire();
  },
  fireDebugEnd() {
    onDidTerminateDebugSession.fire();
  },
  fireTerminalShellStart(execution?: any) {
    const exec =
      execution ?? {
        commandLine: { value: 'git status', confidence: 'High', isTrusted: true },
        cwd: { fsPath: '/ws' },
        read: async function* () {},
      };
    onDidStartTerminalShellExecution.fire({ execution: exec });
    return exec;
  },
  fireTerminalShellEnd(execution: any, exitCode?: number) {
    onDidEndTerminalShellExecution.fire({ execution, exitCode });
  },
  fireTerminalOpen() {
    onDidOpenTerminal.fire();
  },
  fireTerminalClose() {
    onDidCloseTerminal.fire();
  },
};