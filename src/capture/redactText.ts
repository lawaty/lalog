/**
 * Redaction utilities for technical detail capture.
 *
 * Patterns are compiled from the user's `lalog.redactPatterns` config (raw
 * regex source strings). Invalid patterns are silently skipped.
 */

/** Compile user-supplied regex source strings into RegExp objects. */
export function compileRedactPatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'gi'));
    } catch {
      /* skip invalid regex */
    }
  }
  return out;
}

/** Replace all regex matches in text with [REDACTED]. */
export function redactText(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const re of patterns) {
    // Reset lastIndex since we use 'g' flag
    re.lastIndex = 0;
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}
