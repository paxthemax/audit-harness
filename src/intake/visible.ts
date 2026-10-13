// Visible rendering of deceptive characters for intake flags, reports and the trusted screen
// (design/harness-state-and-execution.md, "Permissions and isolation", row "Show target content to
// the auditor"; FR-38). Every character that can reorder, hide or disguise text is replaced by a
// bracketed marker that names it, e.g. `⟦U+202E RIGHT-TO-LEFT OVERRIDE⟧`. Control characters are
// rendered the same way, so terminal escape sequences print as text instead of acting. A literal
// marker bracket in the input is itself rendered as a marker, so target text cannot forge one.

export type DeceptiveKind = 'bidi_control' | 'zero_width' | 'control' | 'space' | 'confusable' | 'marker_bracket';

export interface DeceptiveChar {
  /** UTF-16 index in the input. */
  index: number;
  code_point: number;
  kind: DeceptiveKind;
  name: string;
}

const OPEN = '⟦';
const CLOSE = '⟧';

export const BIDI_CONTROLS: Record<number, string> = {
  0x061c: 'ARABIC LETTER MARK',
  0x200e: 'LEFT-TO-RIGHT MARK',
  0x200f: 'RIGHT-TO-LEFT MARK',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
};

export const INVISIBLE_CHARS: Record<number, string> = {
  0x00ad: 'SOFT HYPHEN',
  0x034f: 'COMBINING GRAPHEME JOINER',
  0x115f: 'HANGUL CHOSEONG FILLER',
  0x1160: 'HANGUL JUNGSEONG FILLER',
  0x17b4: 'KHMER VOWEL INHERENT AQ',
  0x17b5: 'KHMER VOWEL INHERENT AA',
  0x180e: 'MONGOLIAN VOWEL SEPARATOR',
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x2060: 'WORD JOINER',
  0x2061: 'FUNCTION APPLICATION',
  0x2062: 'INVISIBLE TIMES',
  0x2063: 'INVISIBLE SEPARATOR',
  0x2064: 'INVISIBLE PLUS',
  0x3164: 'HANGUL FILLER',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE',
  0xffa0: 'HALFWIDTH HANGUL FILLER',
};

const UNUSUAL_SPACES: Record<number, string> = {
  0x00a0: 'NO-BREAK SPACE',
  0x1680: 'OGHAM SPACE MARK',
  0x2028: 'LINE SEPARATOR',
  0x2029: 'PARAGRAPH SEPARATOR',
  0x202f: 'NARROW NO-BREAK SPACE',
  0x205f: 'MEDIUM MATHEMATICAL SPACE',
  0x3000: 'IDEOGRAPHIC SPACE',
};

const CONTROL_NAMES: Record<number, string> = {
  0x00: 'NULL',
  0x07: 'BELL',
  0x08: 'BACKSPACE',
  0x0b: 'LINE TABULATION',
  0x0c: 'FORM FEED',
  0x0d: 'CARRIAGE RETURN',
  0x1b: 'ESCAPE',
  0x7f: 'DELETE',
  0x9b: 'CONTROL SEQUENCE INTRODUCER',
  0x9d: 'OPERATING SYSTEM COMMAND',
};

/** Common Latin look-alikes (skeleton letter in the value). */
export const CONFUSABLE_LETTERS: Record<number, [string, string]> = {
  0x0430: ['a', 'CYRILLIC SMALL LETTER A'],
  0x0435: ['e', 'CYRILLIC SMALL LETTER IE'],
  0x043e: ['o', 'CYRILLIC SMALL LETTER O'],
  0x0440: ['p', 'CYRILLIC SMALL LETTER ER'],
  0x0441: ['c', 'CYRILLIC SMALL LETTER ES'],
  0x0443: ['y', 'CYRILLIC SMALL LETTER U'],
  0x0445: ['x', 'CYRILLIC SMALL LETTER HA'],
  0x0456: ['i', 'CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I'],
  0x0458: ['j', 'CYRILLIC SMALL LETTER JE'],
  0x0455: ['s', 'CYRILLIC SMALL LETTER DZE'],
  0x0501: ['d', 'CYRILLIC SMALL LETTER KOMI DE'],
  0x04bb: ['h', 'CYRILLIC SMALL LETTER SHHA'],
  0x0410: ['A', 'CYRILLIC CAPITAL LETTER A'],
  0x0412: ['B', 'CYRILLIC CAPITAL LETTER VE'],
  0x0415: ['E', 'CYRILLIC CAPITAL LETTER IE'],
  0x041a: ['K', 'CYRILLIC CAPITAL LETTER KA'],
  0x041c: ['M', 'CYRILLIC CAPITAL LETTER EM'],
  0x041d: ['H', 'CYRILLIC CAPITAL LETTER EN'],
  0x041e: ['O', 'CYRILLIC CAPITAL LETTER O'],
  0x0420: ['P', 'CYRILLIC CAPITAL LETTER ER'],
  0x0421: ['C', 'CYRILLIC CAPITAL LETTER ES'],
  0x0422: ['T', 'CYRILLIC CAPITAL LETTER TE'],
  0x0425: ['X', 'CYRILLIC CAPITAL LETTER HA'],
  0x03b1: ['a', 'GREEK SMALL LETTER ALPHA'],
  0x03bf: ['o', 'GREEK SMALL LETTER OMICRON'],
  0x03bd: ['v', 'GREEK SMALL LETTER NU'],
  0x03c1: ['p', 'GREEK SMALL LETTER RHO'],
  0x03b9: ['i', 'GREEK SMALL LETTER IOTA'],
  0x03ba: ['k', 'GREEK SMALL LETTER KAPPA'],
  0x03c5: ['u', 'GREEK SMALL LETTER UPSILON'],
  0x0391: ['A', 'GREEK CAPITAL LETTER ALPHA'],
  0x0392: ['B', 'GREEK CAPITAL LETTER BETA'],
  0x0395: ['E', 'GREEK CAPITAL LETTER EPSILON'],
  0x0397: ['H', 'GREEK CAPITAL LETTER ETA'],
  0x0399: ['I', 'GREEK CAPITAL LETTER IOTA'],
  0x039a: ['K', 'GREEK CAPITAL LETTER KAPPA'],
  0x039c: ['M', 'GREEK CAPITAL LETTER MU'],
  0x039d: ['N', 'GREEK CAPITAL LETTER NU'],
  0x039f: ['O', 'GREEK CAPITAL LETTER OMICRON'],
  0x03a1: ['P', 'GREEK CAPITAL LETTER RHO'],
  0x03a4: ['T', 'GREEK CAPITAL LETTER TAU'],
  0x03a7: ['X', 'GREEK CAPITAL LETTER CHI'],
  0x0131: ['i', 'LATIN SMALL LETTER DOTLESS I'],
  0x0261: ['g', 'LATIN SMALL LETTER SCRIPT G'],
};

const NON_LATIN_LETTER = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\p{Script=Coptic}]/u;

function hex(cp: number): string {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

/** Name of a code point when it is not plain Latin, for markers and flag details. */
function confusableName(cp: number, ch: string): string {
  const known = CONFUSABLE_LETTERS[cp];
  if (known) return `${known[1]} (looks like "${known[0]}")`;
  if (cp >= 0xff01 && cp <= 0xff5e) return `FULLWIDTH ${String.fromCharCode(cp - 0xfee0)}`;
  if (cp >= 0x1d400 && cp <= 0x1d7ff) return 'MATHEMATICAL ALPHANUMERIC SYMBOL';
  for (const s of ['Cyrillic', 'Greek', 'Armenian', 'Cherokee', 'Coptic']) {
    if (new RegExp(`\\p{Script=${s}}`, 'u').test(ch)) return `${s.toUpperCase()} LETTER`;
  }
  return 'NON-LATIN LETTER';
}

function isConfusableLetter(cp: number, ch: string): boolean {
  if (CONFUSABLE_LETTERS[cp]) return true;
  if (cp >= 0xff01 && cp <= 0xff5e) return true; // fullwidth ASCII
  if (cp >= 0x1d400 && cp <= 0x1d7ff) return true; // mathematical alphanumerics
  return NON_LATIN_LETTER.test(ch);
}

/** Classify one code point (excluding confusables, which depend on context). */
export function classifyChar(cp: number): { kind: DeceptiveKind; name: string } | null {
  if (BIDI_CONTROLS[cp]) return { kind: 'bidi_control', name: BIDI_CONTROLS[cp] };
  if (INVISIBLE_CHARS[cp]) return { kind: 'zero_width', name: INVISIBLE_CHARS[cp] };
  if (cp >= 0xfe00 && cp <= 0xfe0f) return { kind: 'zero_width', name: `VARIATION SELECTOR-${cp - 0xfe00 + 1}` };
  if (cp >= 0xe0000 && cp <= 0xe007f) return { kind: 'zero_width', name: 'TAG CHARACTER' };
  if (cp === 0x0a || cp === 0x09) return null;
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
    return { kind: 'control', name: CONTROL_NAMES[cp] ?? 'CONTROL CHARACTER' };
  }
  if (UNUSUAL_SPACES[cp]) return { kind: 'space', name: UNUSUAL_SPACES[cp] };
  if (cp >= 0x2000 && cp <= 0x200a) return { kind: 'space', name: 'TYPOGRAPHIC SPACE' };
  if (cp === 0x27e6 || cp === 0x27e7) return { kind: 'marker_bracket', name: cp === 0x27e6 ? 'LEFT WHITE SQUARE BRACKET' : 'RIGHT WHITE SQUARE BRACKET' };
  return null;
}

/**
 * Find every deceptive character. Confusable letters are reported only inside a word that also
 * contains ASCII letters (a mixed-script word), so ordinary non-English prose is left alone.
 */
export function findDeceptive(text: string): DeceptiveChar[] {
  const out: DeceptiveChar[] = [];
  const chars = Array.from(text);
  let index = 0;
  const indices: number[] = [];
  for (const ch of chars) {
    indices.push(index);
    index += ch.length;
  }
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0)!;
    // CR immediately before LF is an ordinary line ending.
    if (cp === 0x0d && chars[i + 1] === '\n') continue;
    const c = classifyChar(cp);
    if (c) out.push({ index: indices[i], code_point: cp, ...c });
  }
  // Mixed-script words.
  const word = /[\p{L}\p{N}_$]+/gu;
  for (const m of text.matchAll(word)) {
    const w = m[0];
    if (!/[A-Za-z]/.test(w) && !/[\u{1d400}-\u{1d7ff}Ａ-ｚ]/u.test(w)) continue;
    let off = m.index!;
    for (const ch of w) {
      const cp = ch.codePointAt(0)!;
      if (cp > 0x7f && isConfusableLetter(cp, ch)) {
        out.push({ index: off, code_point: cp, kind: 'confusable', name: confusableName(cp, ch) });
      }
      off += ch.length;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export function markerFor(cp: number, name: string): string {
  return `${OPEN}U+${hex(cp)} ${name}${CLOSE}`;
}

/**
 * Render text with every deceptive character replaced by a visible marker. Newlines and tabs are
 * kept; a CR that ends a CRLF line ending is kept; every other control character is a marker.
 */
export function renderVisible(text: string): string {
  const found = findDeceptive(text);
  if (!found.length) return text;
  let out = '';
  let last = 0;
  for (const d of found) {
    if (d.index < last) continue;
    out += text.slice(last, d.index) + markerFor(d.code_point, d.name);
    last = d.index + String.fromCodePoint(d.code_point).length;
  }
  return out + text.slice(last);
}

/** True when the text contains anything `renderVisible` would mark. */
export function hasDeceptive(text: string): boolean {
  return findDeceptive(text).length > 0;
}
