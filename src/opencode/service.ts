import { AiConfig } from '../core/config';
import { Session } from '../core/types';
import { OpencodeBridge } from './bridge';
import {
  buildDescribePrompt,
  buildReportPrompt,
  buildAnalysisPrompt,
  parseAnalysis,
} from './prompts';
import { AnalysisResult } from './types';

export { OpencodeBridge } from './bridge';
export { OpencodePreflightError } from './runTransport';
export type { AnalysisResult } from './types';

/**
 * High-level AI operations. Each returns structured results the UI can render.
 * All throw only OpencodePreflightError (actionable setup problems) that the
 * caller surfaces; everything degrades gracefully to a non-AI path.
 */
export class LaLogAiService {
  private bridge: OpencodeBridge;
  private interactionLogger?: (e: { task: string; model: string; latencyMs: number; promptChars: number; responseChars: number; truncated: boolean }) => void;

  constructor(private cfg: AiConfig, cwd?: string) {
    this.bridge = new OpencodeBridge(cfg, cwd);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Set callback for AI interaction logging (char counts only, never text). */
  setInteractionLogger(cb: (e: { task: string; model: string; latencyMs: number; promptChars: number; responseChars: number; truncated: boolean }) => void): void {
    this.interactionLogger = cb;
  }

  async preflight(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    return this.bridge.preflight();
  }

  /** Draft a session description. Returns text or patches the input later. */
  async draftDescription(s: Session): Promise<string> {
    const prompt = buildDescribePrompt(s, this.cfg.sendCommitSubjects);
    const start = Date.now();
    const res = await this.bridge.complete('describe', prompt);
    this.logInteraction('describe', prompt, res.text, Date.now() - start);
    return res.text.trim();
  }

  /** Generate a short narrative paragraph for a report range. */
  async narrative(rangeLabel: string, sessions: Session[]): Promise<string> {
    const prompt = buildReportPrompt(rangeLabel, sessions, this.cfg.sendCommitSubjects);
    const start = Date.now();
    const res = await this.bridge.complete('narrative', prompt);
    this.logInteraction('narrative', prompt, res.text, Date.now() - start);
    return res.text.trim();
  }

  /** Structured work review (wins / improvements / stalls). Null if not parseable. */
  async analyze(rangeLabel: string, sessions: Session[]): Promise<AnalysisResult | null> {
    const prompt = buildAnalysisPrompt(rangeLabel, sessions, this.cfg.sendCommitSubjects);
    const start = Date.now();
    const res = await this.bridge.complete('analysis', prompt);
    this.logInteraction('analysis', prompt, res.text, Date.now() - start);
    return parseAnalysis(res.text);
  }

  private logInteraction(task: string, prompt: string, response: string, latencyMs: number): void {
    if (!this.interactionLogger) return;
    try {
      this.interactionLogger({
        task,
        model: this.cfg.model,
        latencyMs,
        promptChars: prompt.length,
        responseChars: response.length,
        truncated: false,
      });
    } catch {
      /* best-effort */
    }
  }
}
