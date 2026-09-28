/**
 * Minimal, dependency-free PDF 1.4 writer.
 *
 * Deliberately tiny: base-14 fonts only (Helvetica/-Bold/-Oblique with
 * /WinAnsiEncoding), uncompressed content streams, no /Info dictionary (so the
 * bytes are fully deterministic — identical drawing calls produce identical
 * files). Everything is written single-byte, which is what makes the xref
 * offsets exact.
 *
 * Public coordinates are top-down (y measured from the page top) because
 * reports are laid out top to bottom; the PDF's bottom-left origin is an
 * internal detail handled by `pdfY()`.
 */

export type PdfFontName = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique';

export interface PdfTextOptions {
  x: number;
  /** Absolute top-down y. Omit = draw at the cursor and advance it. */
  y?: number;
  size?: number;
  font?: PdfFontName;
  color?: [number, number, number];
  maxWidth?: number;
  lineGap?: number;
}

export interface PdfLineOptions {
  width?: number;
  color?: [number, number, number];
}

export interface PdfRectOptions {
  fill?: [number, number, number];
}

const FONT_RESOURCE: Record<PdfFontName, string> = {
  Helvetica: 'F1',
  'Helvetica-Bold': 'F2',
  'Helvetica-Oblique': 'F3',
};

/** AFM advance widths (per 1000 em) for codes 0x20-0x7E. Helvetica-Oblique shares the upright table. */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
  778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667,
  778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611,
  611, 389, 556, 333, 611, 556, 778, 556, 556, 500,
  389, 280, 389, 584,
];

/** Unicode punctuation WinAnsiEncoding (cp1252) actually covers. Anything else above U+00FF becomes '?'. */
const WIN_ANSI: Record<string, string> = {
  '\u2018': '\u0091',
  '\u2019': '\u0092',
  '\u201c': '\u0093',
  '\u201d': '\u0094',
  '\u2013': '\u0096',
  '\u2014': '\u0097',
  '\u2022': '\u0095',
  '\u2026': '\u0085',
  '\u00a0': '\u00a0',
};

function fmtNum(n: number): string {
  return n.toFixed(2);
}

function fmtColor(c: [number, number, number]): string {
  return `${fmtNum(c[0])} ${fmtNum(c[1])} ${fmtNum(c[2])}`;
}

function toWinAnsi(str: string): string {
  let out = '';
  for (const ch of str) {
    const mapped = WIN_ANSI[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    out += (ch.codePointAt(0) ?? 0) > 0xff ? '?' : ch;
  }
  return out;
}

function escapePdfText(str: string): string {
  return toWinAnsi(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export class PdfDoc {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
  private pages: string[] = [];
  private cursor: number;

  constructor(opts: { width?: number; height?: number; margin?: number } = {}) {
    this.width = opts.width ?? 595.28;
    this.height = opts.height ?? 841.89;
    this.margin = opts.margin ?? 48;
    this.cursor = this.margin;
    this.pages.push('');
  }

  get pageCount(): number {
    return this.pages.length;
  }

  get contentWidth(): number {
    return this.width - 2 * this.margin;
  }

  get contentHeight(): number {
    return this.height - 2 * this.margin;
  }

  get cursorY(): number {
    return this.cursor;
  }

  /** Start a new page; the cursor returns to the top margin. */
  addPage(): void {
    this.pages.push('');
    this.cursor = this.margin;
  }

  /** Add a page when the requested block would overflow the bottom margin. */
  ensureSpace(neededPt: number): boolean {
    if (this.cursor + neededPt <= this.height - this.margin) return false;
    this.addPage();
    return true;
  }

  /**
   * Draw (optionally word-wrapped) text. Without an absolute `y` the text is
   * drawn at the cursor, which advances past the last line; page breaks are
   * inserted automatically. With `y` the cursor is untouched.
   */
  text(str: string, opts: PdfTextOptions): string[] {
    const size = opts.size ?? 10;
    const font = opts.font ?? 'Helvetica';
    const color = opts.color ?? [0, 0, 0];
    const leading = size + (opts.lineGap ?? 2);
    const lines = opts.maxWidth
      ? this.wrapText(str, opts.maxWidth, size, font)
      : str.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let y: number;
      if (opts.y !== undefined) {
        y = opts.y + i * leading;
      } else {
        this.ensureSpace(leading);
        y = this.cursor;
        this.cursor += leading;
      }
      this.ops(
        `${fmtColor(color)} rg BT /${FONT_RESOURCE[font]} ${fmtNum(size)} Tf ` +
          `${fmtNum(opts.x)} ${fmtNum(this.height - y)} Td ` +
          `(${escapePdfText(lines[i])}) Tj ET\n`
      );
    }
    return lines;
  }

  /** Greedy word wrap; a single word wider than `maxWidth` is broken by characters. */
  wrapText(str: string, maxWidth: number, size = 10, font: PdfFontName = 'Helvetica'): string[] {
    const out: string[] = [];
    for (const hard of str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
      const words = hard.trim().split(/\s+/).filter(Boolean);
      if (!words.length) {
        out.push('');
        continue;
      }
      let line = words[0];
      for (let i = 1; i < words.length; i++) {
        const candidate = `${line} ${words[i]}`;
        if (this.measure(candidate, size, font) <= maxWidth) {
          line = candidate;
        } else {
          out.push(line);
          line = words[i];
        }
      }
      while (this.measure(line, size, font) > maxWidth) {
        let cut = line.length;
        while (cut > 1 && this.measure(line.slice(0, cut), size, font) > maxWidth) cut -= 1;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
      out.push(line);
    }
    return out;
  }

  /** Advance width of a string in points. Approximate for characters outside Latin-1. */
  measure(str: string, size = 10, font: PdfFontName = 'Helvetica'): number {
    const widths = font === 'Helvetica-Bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
    let total = 0;
    for (let i = 0; i < str.length; i++) {
      total += widths[str.charCodeAt(i) - 32] ?? 500;
    }
    return (total * size) / 1000;
  }

  line(x1: number, y1: number, x2: number, y2: number, opts: PdfLineOptions = {}): void {
    this.ops(
      `${fmtColor(opts.color ?? [0, 0, 0])} RG ${fmtNum(opts.width ?? 0.5)} w ` +
        `${fmtNum(x1)} ${fmtNum(this.height - y1)} m ${fmtNum(x2)} ${fmtNum(this.height - y2)} l S\n`
    );
  }

  rect(x: number, y: number, w: number, h: number, opts: PdfRectOptions = {}): void {
    this.ops(
      `${fmtColor(opts.fill ?? [0, 0, 0])} rg ` +
        `${fmtNum(x)} ${fmtNum(this.height - y - h)} ${fmtNum(w)} ${fmtNum(h)} re f\n`
    );
  }

  /** Assemble the document. Deterministic: no timestamps, no /Info, no compression. */
  save(): Buffer {
    const pages = this.pages;
    const objCount = 5 + pages.length * 2;
    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let offset = 0;
    const push = (s: string): void => {
      const b = Buffer.from(s, 'latin1');
      chunks.push(b);
      offset += b.length;
    };
    const obj = (id: number, body: string): void => {
      offsets[id] = offset;
      push(`${id} 0 obj\n${body}\nendobj\n`);
    };

    push('%PDF-1.4\n');
    push('%\xe2\xe3\xcf\xd3\n');

    const kids: number[] = [];
    for (let i = 0; i < pages.length; i++) kids.push(6 + i * 2);

    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');
    for (let i = 0; i < pages.length; i++) {
      const pageId = 6 + i * 2;
      obj(
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmtNum(this.width)} ${fmtNum(this.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${pageId + 1} 0 R >>`
      );
      const stream = pages[i];
      obj(pageId + 1, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
    }

    const xrefOffset = offset;
    push(`xref\n0 ${objCount + 1}\n`);
    push('0000000000 65535 f \n');
    for (let id = 1; id <= objCount; id++) {
      push(`${String(offsets[id]).padStart(10, '0')} ${String(0).padStart(5, '0')} n \n`);
    }
    push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return Buffer.concat(chunks);
  }

  private ops(s: string): void {
    this.pages[this.pages.length - 1] += s;
  }
}
