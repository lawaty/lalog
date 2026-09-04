import { AiConfig } from '../core/config';
import { OpencodePreflightError, runOneShot, RunOptions } from './runTransport';
import { modelPolicyFrom } from './modelPolicy';
import { LlmBridge, LlmResult } from './types';

/**
 * Optional AI bridge driven by the local opencode CLI (one-shot subprocess).
 * - OFF when `lalog.ai.enabled` is false: nothing is spawned, nothing is sent.
 * - No server lifecycle, no ports, no auth storage — model auth comes from the
 *   user's own `opencode auth login`.
 *
 * Data policy: only the compact Session summary is sent (paths, counters,
 * branch, optional commit subjects). File contents and terminal text are never
 * captured by LaLog, so they are never sent.
 */
export class OpencodeBridge implements LlmBridge {
  private readonly policy;
  private readonly binary: string;
  private readonly sendCommitSubjects: boolean;
  private readonly cwd: string | undefined;

  constructor(cfg: AiConfig, cwd?: string) {
    this.policy = modelPolicyFrom(cfg);
    this.binary = cfg.opencodePath || 'opencode';
    this.sendCommitSubjects = cfg.sendCommitSubjects;
    this.cwd = cwd;
  }

  /** Preflight: confirm the binary exists and the configured model is available. */
  async preflight(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    try {
      const opts: RunOptions = {
        binary: this.binary,
        model: this.policy.model,
        timeoutMs: 15000,
        cwd: this.cwd,
        title: 'LaLog preflight',
      };
      await runOneShot('Reply with exactly: OK', opts);
      return { ok: true };
    } catch (e) {
      if (e instanceof OpencodePreflightError) {
        return { ok: false, error: e.message, hint: e.hint };
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async complete(task: 'describe' | 'narrative' | 'analysis', prompt: string): Promise<LlmResult> {
    const maxRetries = Math.max(0, this.policy.maxRetries);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(500 * attempt);
      try {
        const opts: RunOptions = {
          binary: this.binary,
          model: this.policy.model,
          timeoutMs: this.policy.timeoutMs,
          cwd: this.cwd,
          title: `LaLog ${task}`,
        };
        const res = await runOneShot(prompt, opts);
        if (!res.text.trim()) {
          lastErr = new OpencodePreflightError('Model returned an empty response.');
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (e instanceof OpencodePreflightError) {
          // Spawn/auth errors are not transient — don't retry.
          break;
        }
      }
    }
    throw lastErr;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
