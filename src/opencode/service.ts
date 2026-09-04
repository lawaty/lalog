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

  constructor(private cfg: AiConfig, cwd?: string) {
    this.bridge = new OpencodeBridge(cfg, cwd);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  async preflight(): Promise<{ ok: boolean; error?: string; hint?: string }> {
    return this.bridge.preflight();
  }

  /** Draft a session description. Returns text or patches the input later. */
  async draftDescription(s: Session): Promise<string> {
    const res = await this.bridge.complete('describe', buildDescribePrompt(s, this.cfg.sendCommitSubjects));
    return res.text.trim();
  }

  /** Generate a short narrative paragraph for a report range. */
  async narrative(rangeLabel: string, sessions: Session[]): Promise<string> {
    const res = await this.bridge.complete(
      'narrative',
      buildReportPrompt(rangeLabel, sessions, this.cfg.sendCommitSubjects)
    );
    return res.text.trim();
  }

  /** Structured work review (wins / improvements / stalls). Null if not parseable. */
  async analyze(rangeLabel: string, sessions: Session[]): Promise<AnalysisResult | null> {
    const res = await this.bridge.complete(
      'analysis',
      buildAnalysisPrompt(rangeLabel, sessions, this.cfg.sendCommitSubjects)
    );
    return parseAnalysis(res.text);
  }
}
