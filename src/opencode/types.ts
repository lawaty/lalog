export interface AnalysisResult {
  wins: string[];
  improvements: string[];
  stalls: string[];
  summary: string;
}

export interface LlmResult {
  text: string;
}

/** The single seam between LaLog and any LLM backend. */
export interface LlmBridge {
  /**
   * Run one AI request. Throws OpencodePreflightError for setup problems and
   * OpencodeRunError for request failures. Returns the assistant's plain text.
   */
  complete(task: 'describe' | 'narrative' | 'analysis', prompt: string): Promise<LlmResult>;
}

/** Marker so the extension can react to setup problems with actionable hints. */
export interface PreflightHint {
  hint?: string;
}
