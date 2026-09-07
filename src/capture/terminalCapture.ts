/**
 * Terminal command execution capture via VS Code shell integration.
 *
 * Captures command line, exit code, duration, and cwd. Stdout capture is
 * opt-in (lalog.captureTerminalStdout) and requires calling execution.read()
 * immediately in the start handler.
 */

import type { TechnicalTerminal } from '../core/types';
import { redactText } from './redactText';

interface InFlightExecution {
  startTs: number;
  commandLine: string;
  confidence: 'low' | 'medium' | 'high';
  cwd: string | undefined;
  stdoutChunks: string[];
  reading: boolean;
}

/**
 * Strip ANSI escape sequences from text.
 * Handles CSI, OSC/DCS/SOS/APC, and single-char escapes.
 */
export function stripAnsi(text: string): string {
  // CSI sequences: ESC [ ... final_byte
  let out = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // OSC/DCS/SOS/APC: ESC ] ... (ST or BEL)
  out = out.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // Single-char escapes (e.g. ESC M = reverse index)
  out = out.replace(/\x1b[^\x1b]/g, '');
  // Strip carriage returns used for line overwriting
  out = out.replace(/\r+\n/g, '\n');
  out = out.replace(/\r[^\n]*/g, '');
  return out;
}

export type NowFn = () => number;

export class TerminalCapture {
  private inFlight: Map<unknown, InFlightExecution> = new Map();
  private pendingReads: Promise<void>[] = [];

  constructor(
    private captureStdout: boolean,
    private maxStdoutChars: number,
    private redactPatterns: RegExp[],
    private now: NowFn = Date.now
  ) {}

  /**
   * Called on onDidStartTerminalShellExecution.
   * Records start timestamp and command metadata. If stdout capture is enabled,
   * begins async collection of execution.read() chunks.
   */
  onStart(execution: {
    commandLine: { value: string; confidence: string; isTrusted: boolean };
    cwd: { fsPath: string } | undefined;
    read: () => AsyncIterable<string>;
  }): void {
    const startTs = this.now();
    const confidence = mapConfidence(execution.commandLine.confidence);
    const entry: InFlightExecution = {
      startTs,
      commandLine: execution.commandLine.value,
      confidence,
      cwd: execution.cwd?.fsPath,
      stdoutChunks: [],
      reading: false,
    };

    // Store keyed by the execution object identity
    this.inFlight.set(execution, entry);

    if (this.captureStdout) {
      entry.reading = true;
      // Fire-and-forget: call read() synchronously in the handler to not miss data
      this.pendingReads.push(this.collectStdout(execution, entry));
    }
  }

  /**
   * Called on onDidEndTerminalShellExecution.
   * Returns the TechnicalTerminal entry or null if no matching start was recorded.
   */
  onEnd(
    execution: unknown,
    exitCode: number | undefined
  ): TechnicalTerminal | null {
    const entry = this.inFlight.get(execution);
    if (!entry) return null;
    this.inFlight.delete(execution);

    const durationMs = this.now() - entry.startTs;

    let stdout: string | undefined;
    if (this.captureStdout && entry.stdoutChunks.length > 0) {
      let raw = entry.stdoutChunks.join('');
      raw = stripAnsi(raw);
      raw = redactText(raw, this.redactPatterns);
      if (raw.length > this.maxStdoutChars) {
        raw = raw.slice(0, this.maxStdoutChars) + '\n...[truncated]';
      }
      stdout = raw;
    }

    const result: TechnicalTerminal = {
      type: 'terminal',
      ts: this.now(),
      commandLine: entry.commandLine,
      exitCode: exitCode ?? null,
      durationMs,
      cwd: entry.cwd,
      confidence: entry.confidence,
    };

    if (stdout !== undefined) {
      result.stdout = stdout;
    }

    return result;
  }

  /** Clear all in-flight executions (called on session end). */
  clearInFlight(): void {
    this.inFlight.clear();
  }

  /** Wait for all pending stdout collection to complete (for testing). */
  async flush(): Promise<void> {
    await Promise.all(this.pendingReads);
    this.pendingReads = [];
  }

  /**
   * Async stdout collection. Must be called synchronously in onStart so
   * execution.read() attaches before any output is produced.
   */
  private async collectStdout(
    execution: { read: () => AsyncIterable<string> },
    entry: InFlightExecution
  ): Promise<void> {
    try {
      for await (const chunk of execution.read()) {
        entry.stdoutChunks.push(chunk);
      }
    } catch {
      // Best-effort: read() may fail if terminal is killed
    }
  }
}

function mapConfidence(confidence: string): 'low' | 'medium' | 'high' {
  switch (confidence) {
    case 'High':
      return 'high';
    case 'Medium':
      return 'medium';
    default:
      return 'low';
  }
}
