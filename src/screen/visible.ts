// Visible rendering of deceptive characters for the trusted decision screen
// (design/harness-interface-contracts.md, "Controller to trusted decision screen";
// design/harness-state-and-execution.md, permissions row "Show target content to the auditor").
//
// Every character that can hide, reorder or disguise text is replaced by a bracketed marker naming
// its code point, so the auditor sees it instead of its effect: bidirectional controls, zero-width
// and other format characters (including Unicode tag characters used for hidden text), control
// characters (so terminal escape sequences print as text and cannot move the cursor, recolor or
// retitle the screen), unusual spaces, and confusable letters inside words that otherwise use Latin
// letters. The marker brackets themselves are escaped, so target text cannot forge a marker.
//
// The screen uses the intake module's `renderVisible` (src/intake/visible.ts), the single naming
// table shared with ingestion flags and reports. This module adds a second, independent classifier as
// a safety net: anything still deceptive in the intake rendering (for example variation selectors, an
// unlisted format character, or a non-Latin letter inside an otherwise Latin word) is replaced too.

import { renderVisible as intakeRenderVisible } from '../intake/visible.ts';

export interface DeceptiveChar {
  index: number;
  code_point: string;
  kind: 'bidi_control' | 'zero_width' | 'format' | 'control' | 'space' | 'confusable' | 'marker_bracket';
  label: string;
}

const OPEN = '⟦'; // ⟦
const CLOSE = '⟧'; // ⟧

const BIDI: Record<number, string> = {
  0x061c: 'ALM',
  0x200e: 'LRM',
  0x200f: 'RLM',
  0x202a: 'LRE',
  0x202b: 'RLE',
  0x202c: 'PDF',
  0x202d: 'LRO',
  0x202e: 'RLO',
  0x2066: 'LRI',
  0x2067: 'RLI',
  0x2068: 'FSI',
  0x2069: 'PDI',
};

const ZERO_WIDTH: Record<number, string> = {
  0x00ad: 'SHY',
  0x034f: 'CGJ',
  0x180e: 'MVS',
  0x200b: 'ZWSP',
  0x200c: 'ZWNJ',
  0x200d: 'ZWJ',
  0x2060: 'WJ',
  0x2061: 'FA',
  0x2062: 'IT',
  0x2063: 'IS',
  0x2064: 'IP',
  0xfeff: 'BOM',
  0x115f: 'HCF',
  0x1160: 'HJF',
  0x3164: 'HF',
  0xffa0: 'HWHF',
};

const CONTROL_NAMES: Record<number, string> = { 0x1b: 'ESC', 0x0d: 'CR', 0x07: 'BEL', 0x08: 'BS', 0x7f: 'DEL', 0x9b: 'CSI', 0x00: 'NUL' };

/** Latin-lookalike letters from other scripts (a representative subset of Unicode confusables). */
const CONFUSABLE = new Set<number>([
  // Cyrillic
  0x0430, 0x0435, 0x043e, 0x0440, 0x0441, 0x0445, 0x0443, 0x0456, 0x0458, 0x0455, 0x04bb, 0x0501, 0x051b, 0x051d,
  0x0410, 0x0412, 0x0415, 0x041a, 0x041c, 0x041d, 0x041e, 0x0420, 0x0421, 0x0422, 0x0425, 0x0406, 0x0408, 0x0405,
  // Greek
  0x03bf, 0x03b1, 0x03bd, 0x03c1, 0x03b9, 0x0391, 0x0392, 0x0395, 0x0396, 0x0397, 0x0399, 0x039a, 0x039c, 0x039d,
  0x039f, 0x03a1, 0x03a4, 0x03a5, 0x03a7,
  // Armenian and others commonly abused
  0x0578, 0x057d, 0x0585, 0x0261, 0x0251, 0x0131, 0x0237,
]);

const LATIN_LETTER = /[A-Za-z]/;
const WORD_CHAR = /[\p{L}\p{N}_$]/u;

function hex(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

function scriptOf(ch: string): string {
  for (const s of ['Cyrillic', 'Greek', 'Armenian', 'Cherokee', 'Latin']) {
    if (new RegExp(`\\p{Script=${s}}`, 'u').test(ch)) return s.toUpperCase();
  }
  return 'OTHER';
}

function classify(ch: string, cp: number, wordHasLatin: boolean): DeceptiveChar['kind'] | null {
  if (ch === OPEN || ch === CLOSE) return 'marker_bracket';
  if (BIDI[cp]) return 'bidi_control';
  if (ZERO_WIDTH[cp]) return 'zero_width';
  if (ch === '\n' || ch === '\t') return null;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 'control';
  if (cp === 0x2028 || cp === 0x2029) return 'control';
  if (/\p{Cf}/u.test(ch)) return 'format'; // includes tag characters U+E0000..E007F
  if (/[︀-️]/u.test(ch) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 'format'; // variation selectors
  if (/\p{Zs}/u.test(ch) && ch !== ' ') return 'space';
  if (cp > 0x7f && /\p{L}/u.test(ch)) {
    if (CONFUSABLE.has(cp)) return 'confusable';
    if (cp >= 0xff01 && cp <= 0xff5e) return 'confusable'; // fullwidth ASCII
    if (cp >= 0x1d400 && cp <= 0x1d7ff) return 'confusable'; // mathematical alphanumerics
    if (wordHasLatin && scriptOf(ch) !== 'LATIN') return 'confusable'; // mixed-script word
  }
  if (cp >= 0xff01 && cp <= 0xff5e) return 'confusable';
  return null;
}

function label(kind: DeceptiveChar['kind'], ch: string, cp: number): string {
  switch (kind) {
    case 'bidi_control':
      return `${hex(cp)} ${BIDI[cp]}`;
    case 'zero_width':
      return `${hex(cp)} ${ZERO_WIDTH[cp]}`;
    case 'control':
      return CONTROL_NAMES[cp] ?? hex(cp);
    case 'space':
      return `${hex(cp)} SPACE`;
    case 'confusable':
      return `${hex(cp)} ${scriptOf(ch)} '${ch}'`;
    case 'marker_bracket':
      return hex(cp);
    default:
      return `${hex(cp)} FORMAT`;
  }
}

/** Every character that `renderVisible` replaces, with its position in the input. */
export function scanDeceptive(text: string): DeceptiveChar[] {
  const out: DeceptiveChar[] = [];
  const chars = [...text];
  // Precompute, per character, whether its word contains a Latin letter (mixed-script detection).
  const wordLatin: boolean[] = new Array(chars.length).fill(false);
  let start = 0;
  for (let i = 0; i <= chars.length; i++) {
    if (i === chars.length || !WORD_CHAR.test(chars[i])) {
      const hasLatin = chars.slice(start, i).some((c) => LATIN_LETTER.test(c));
      for (let j = start; j < i; j++) wordLatin[j] = hasLatin;
      start = i + 1;
    }
  }
  let index = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0)!;
    const kind = classify(ch, cp, wordLatin[i]);
    if (kind) out.push({ index, code_point: hex(cp), kind, label: label(kind, ch, cp) });
    index += ch.length;
  }
  return out;
}

/**
 * Text with every deceptive character replaced by a visible marker, e.g. `⟦U+202E RLO⟧`,
 * `⟦U+200B ZWSP⟧`, `⟦ESC⟧[31m`. Newlines and tabs are kept.
 */
export function renderVisible(text: string): string {
  return replaceFound(intakeRenderVisible(text), true);
}

/** The safety-net classifier alone (no intake naming table). */
export function renderVisibleLocal(text: string): string {
  return replaceFound(text, false);
}

function replaceFound(text: string, keepBrackets: boolean): string {
  const found = scanDeceptive(text).filter((f) => !keepBrackets || f.kind !== 'marker_bracket');
  if (!found.length) return text;
  let out = '';
  let last = 0;
  for (const f of found) {
    out += text.slice(last, f.index);
    const cp = text.codePointAt(f.index)!;
    out += `${OPEN}${f.label}${CLOSE}`;
    last = f.index + (cp > 0xffff ? 2 : 1);
  }
  return out + text.slice(last);
}

/** One-line summary of what was made visible, for a section header. */
export function deceptiveSummary(text: string): string | null {
  const found = scanDeceptive(text).filter((f) => f.kind !== 'marker_bracket');
  if (!found.length) return null;
  const counts = new Map<string, number>();
  for (const f of found) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return `WARNING deceptive characters shown visibly: ${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')}`;
}
