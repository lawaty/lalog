import { AiConfig } from '../core/config';

/** "big-pickle" is an opencode/big-pickle Zen model. Kept as a default, not a constant. */
export const DEFAULT_MODEL = 'opencode/big-pickle';

/**
 * Layered model policy:
 *  - `enabled` gates whether any opencode code path runs (extension-level).
 *  - `model` is user-overridable (stealth models get renamed; free periods end).
 *  - the bridge never hard-codes a model; it always reads this policy.
 */
export interface ModelPolicy {
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export function modelPolicyFrom(cfg: AiConfig): ModelPolicy {
  return {
    model: cfg.model || DEFAULT_MODEL,
    timeoutMs: cfg.timeoutMs || 60000,
    maxRetries: cfg.maxRetries ?? 2,
  };
}
