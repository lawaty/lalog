/**
 * AI interaction metadata logger.
 *
 * Records char counts and metadata only — never prompt or response text.
 */

import type { TechnicalAiInteraction } from '../core/types';

export interface AiInteractionInput {
  task: string;
  model: string;
  latencyMs: number;
  promptChars: number;
  responseChars: number;
  truncated: boolean;
}

export class AiLog {
  logInteraction(input: AiInteractionInput): TechnicalAiInteraction {
    return {
      type: 'ai',
      ts: Date.now(),
      task: input.task,
      model: input.model,
      latencyMs: input.latencyMs,
      promptChars: input.promptChars,
      responseChars: input.responseChars,
      truncated: input.truncated,
    };
  }
}
