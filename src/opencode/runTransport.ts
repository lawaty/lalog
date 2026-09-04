import { spawn } from 'child_process';

export interface RunResult {
  text: string;
}

export interface RunOptions {
  binary: string;
  model: string;
  timeoutMs: number;
  cwd?: string;
  title?: string;
}

/** Error thrown when opencode itself is not usable (missing binary, not authed). */
export class OpencodePreflightError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = 'OpencodePreflightError';
  }
}

interface ExecOutcome {
  stdout: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * One-shot transport: `opencode run --format json` as a subprocess.
 * No server, no ports, no auth management — model credentials come from the
 * user's existing `opencode auth login`.
 *
 * `spawn` with `stdio: ['ignore','pipe','pipe']` (stdin closed) is used because
 * `execFile`/`exec` hang waiting on opencode — the raw pipe is drained manually.
 * `args` array with no shell prevents prompt-argument injection.
 */
export async function runOneShot(prompt: string, opts: RunOptions): Promise<RunResult> {
  const args = ['run', '--format', 'json', '--model', opts.model];
  if (opts.title) args.push('--title', opts.title);
  if (opts.cwd) args.push('--dir', opts.cwd);
  args.push(prompt);

  const { stdout, code, signal } = await spawnCapture(opts.binary, args, opts);

  const text = parseRunOutput(stdout);
  if ((code !== 0 || signal) && !text) {
    throw new OpencodePreflightError(
      `opencode exited with code ${code ?? '?'}${signal ? ` (${signal})` : ''}${
        stdout ? `: ${firstError(stdout)}` : ''
      }`,
      authHint(stdout)
    );
  }
  return { text: text?.trim() ?? '' };
}

function spawnCapture(
  binary: string,
  args: string[],
  opts: RunOptions
): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: opts.cwd,
        env: process.env,
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
    }, opts.timeoutMs);

    child.on('error', (e) => {
      clearTimeout(killTimer);
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        reject(
          new OpencodePreflightError(
            `opencode CLI not found at '${binary}'.`,
            'Install opencode (https://opencode.ai/docs) or set lalog.ai.opencodePath.'
          )
        );
        return;
      }
      reject(new OpencodePreflightError(`${err.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (signal === 'SIGTERM') {
        reject(new OpencodePreflightError('opencode request timed out.'));
        return;
      }
      if (stderr && !stdout && /ENOENT|not recognized|command not found/i.test(stderr)) {
        reject(
          new OpencodePreflightError(
            `opencode CLI not found at '${binary}'.`,
            'Install opencode (https://opencode.ai/docs) or set lalog.ai.opencodePath.'
          )
        );
        return;
      }
      resolve({ stdout, code, signal });
    });
  });
}

/** Parse `--format json` JSONL: concatenate `type === "text"` parts. */
export function parseRunOutput(stdout: string): string {
  const texts: string[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev: { type?: string; part?: { type?: string; text?: string } };
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.type === 'text' && ev.part?.type === 'text' && typeof ev.part.text === 'string') {
      texts.push(ev.part.text);
    }
  }
  return texts.join('');
}

function firstError(stdout: string): string {
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t);
      if (ev?.type === 'error') return typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error);
    } catch {
      /* ignore */
    }
  }
  return stdout.slice(0, 500);
}

function authHint(stdout: string): string | undefined {
  if (/auth|login|token|api[ _-]?key|401|403|sign ?in|credentials/i.test(stdout)) {
    return 'Run `opencode auth login` and select OpenCode Zen, then try again.';
  }
  return undefined;
}
