// Intake scan for analysis-integrity threats (FR-38; design/harness-state-and-execution.md,
// "Permissions and isolation" and "Replay and semantic validity"). The scan flags:
//   - bidirectional-control and zero-width/invisible characters (display deception);
//   - confusable non-Latin letters inside identifiers and mixed-script words;
//   - instruction-like text addressed to AI or auditors (analysis steering);
//   - NatSpec claims a simple check contradicts (a restriction or reentrancy claim on a function
//     that has no such modifier or inline check);
//   - environment reads that can feed branches (`tx.origin`, `block.coinbase`, `block.basefee`,
//     `block.chainid`, `tx.gasprice`, code at the cheatcode address), which make target behavior
//     differ under test;
//   - repository content that configures tools or agents to execute (FFI, agent instruction files).
// Flags are suspicious content for the intake review. A flagged module stays in scope and in
// coverage; acknowledging a flag grants nothing.

import { BIDI_CONTROLS, findDeceptive, renderVisible } from './visible.ts';
import type { SuspiciousFlagBody } from '../schema/records.ts';

export type FlagKind = SuspiciousFlagBody['kind'];

export interface ScanFlag {
  path: string;
  /** UTF-8 byte offset in the file (the compiler's `src` unit). */
  offset: number;
  /** 1-based line; 0 for a flag about the path itself. */
  line: number;
  kind: FlagKind;
  /** The flagged line, with deceptive characters rendered visibly. */
  excerpt: string;
  detail: string;
}

/** Per-file, per-kind cap; one summary flag records how many more were suppressed. */
export const MAX_FLAGS_PER_KIND = 25;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const TEXT_EXT = /\.(sol|md|txt|rst|toml|ya?ml|json|js|ts|py|sh|adoc|html?)$/i;

// ------------------------------------------------------------------------------------------------
// Positions

class Positions {
  private readonly lineStarts: number[] = [0];
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
  }
  line(i: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  lineText(i: number): string {
    const l = this.line(i);
    const start = this.lineStarts[l - 1];
    const end = l < this.lineStarts.length ? this.lineStarts[l] - 1 : this.text.length;
    return this.text.slice(start, end);
  }
  byteOffset(i: number): number {
    return Buffer.byteLength(this.text.slice(0, i), 'utf8');
  }
}

function excerptAt(pos: Positions, i: number): string {
  let t = pos.lineText(i).trim();
  if (t.length > 200) t = t.slice(0, 200) + '…';
  return renderVisible(t);
}

// ------------------------------------------------------------------------------------------------
// Solidity lexical regions: code, comment or string, per UTF-16 index.

export const CODE = 0;
export const COMMENT = 1;
export const STRING = 2;

export function solidityRegions(src: string): Uint8Array {
  const r = new Uint8Array(src.length);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const e = end < 0 ? src.length : end;
      r.fill(COMMENT, i, e);
      i = e;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const e = end < 0 ? src.length : end + 2;
      r.fill(COMMENT, i, e);
      i = e;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const e = Math.min(src.length, j + 1);
      r.fill(STRING, i, e);
      i = e;
    } else {
      i++;
    }
  }
  return r;
}

/** Index of the bracket matching `open` at `start`, counting only code positions. */
function matchBracket(src: string, regions: Uint8Array, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (regions[i] !== CODE) continue;
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ------------------------------------------------------------------------------------------------
// Instruction-like text addressed to AI or auditors

const INSTRUCTION_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\b(?:AI|A\.I\.|LLM|GPT|Claude|automated|machine)\s+(?:auditors?|reviewers?|agents?|assistants?|tools?|scanners?)\b/gi, what: 'addresses AI auditors or tools' },
  { re: /\blanguage\s+models?\b/gi, what: 'addresses a language model' },
  { re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding|your)\s+(?:instructions?|prompts?|context|rules)\b/gi, what: 'asks the reader to ignore its instructions' },
  { re: /\bskip\s+(?:this|the\s+following|these|the)\s+(?:module|file|contract|function|code|section|library|folder|directory)s?\b/gi, what: 'asks the reader to skip code' },
  { re: /\b(?:do\s+not|don'?t|never|no\s+need\s+to)\s+(?:report|flag|audit|review|analy[sz]e|check|mention|look\s+at|investigate)\b/gi, what: 'asks the reader not to report or review' },
  { re: /\b(?:this|the)\s+(?:code|contract|module|function|file|library|logic)\s+(?:is|has\s+been|was)\s+(?:already\s+)?(?:safe|secure|audited|formally\s+verified|bug[- ]free|reviewed|out\s+of\s+scope)\b/gi, what: 'asserts the code is safe or audited' },
  { re: /\b(?:already|previously|fully)\s+audited\b|\b(?:has\s+been|was|is)\s+(?:already\s+)?audited\b/gi, what: 'claims the code was already audited' },
  { re: /\b(?:note|attention|message|instructions?)\s+(?:to|for)\s+(?:the\s+)?(?:auditors?|reviewers?|AI|agents?|assistants?)\b/gi, what: 'addresses auditors directly' },
  { re: /\b(?:auditors?|reviewers?|agents?|assistants?)\s*[:,]\s*(?:please\s+)?(?:skip|ignore|do\s+not|don'?t|disregard)\b/gi, what: 'instructs auditors to skip or ignore' },
  { re: /\byou\s+are\s+(?:an?|the)\s+(?:AI|assistant|auditor|security\s+reviewer|agent)\b/gi, what: 'addresses the reader as an AI' },
  { re: /\b(?:system\s+prompt|as\s+an\s+AI)\b/gi, what: 'prompt-injection phrasing' },
];

// ------------------------------------------------------------------------------------------------
// Environment reads (design/harness-state-and-execution.md, "Replay and semantic validity")

export const CHEATCODE_ADDRESS = '0x7109709ECfa91a80626fF3989D68f67F5b1DD12D';

export interface EnvironmentRead {
  /** Normalized read, e.g. `tx.origin`, `block.chainid`, `cheatcode_address`, `yul:origin()`. */
  read: string;
  /** UTF-16 index in the source. */
  index: number;
  offset: number;
  line: number;
  /** True when the enclosing statement branches (if/require/assert/loop/ternary/revert/comparison). */
  branch: boolean;
  in_assembly: boolean;
  excerpt: string;
}

const ENV_SOL = /\btx\s*\.\s*(origin|gasprice)\b|\bblock\s*\.\s*(coinbase|basefee|blobbasefee|chainid|prevrandao|difficulty)\b|0x7109709ecfa91a80626ff3989d68f67f5b1dd12d|hevm cheat code/gi;
const ENV_YUL = /\b(origin|coinbase|basefee|blobbasefee|chainid|gasprice|prevrandao)\s*\(\s*\)/g;
const BRANCH = /\b(if|require|assert|while|for|revert)\b|\?|==|!=|<=|>=|(?<![=<>-])[<>](?![=<>])|\b(switch|case)\b/;

function assemblyRegions(src: string, regions: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  const re = /\bassembly\b[^{;]*\{/g;
  for (const m of src.matchAll(re)) {
    if (regions[m.index!] !== CODE) continue;
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(src, regions, open, '{', '}');
    out.push([open, close < 0 ? src.length : close]);
  }
  return out;
}

/** The statement around index i: from the previous `;`, `{` or `}` to the next `;` or `{`. */
function statementAround(src: string, regions: Uint8Array, i: number): string {
  let s = i;
  while (s > 0 && !(regions[s - 1] === CODE && ';{}'.includes(src[s - 1]))) s--;
  let e = i;
  while (e < src.length && !(regions[e] === CODE && ';{'.includes(src[e]))) e++;
  // Include the keyword that opens a block, e.g. `if (tx.origin == x) {`.
  return src.slice(s, e);
}

/** Environment reads in Solidity source (comments excluded; the cheatcode marker may be in a string). */
export function scanEnvironmentReads(source: string): EnvironmentRead[] {
  const regions = solidityRegions(source);
  const pos = new Positions(source);
  const asm = assemblyRegions(source, regions);
  const inAsm = (i: number) => asm.some(([a, b]) => i > a && i < b);
  const out: EnvironmentRead[] = [];
  for (const m of source.matchAll(ENV_SOL)) {
    const i = m.index!;
    const isMarker = /hevm cheat code/i.test(m[0]);
    if (regions[i] === COMMENT || (regions[i] === STRING && !isMarker)) continue;
    let read: string;
    if (m[1]) read = `tx.${m[1].toLowerCase()}`;
    else if (m[2]) read = `block.${m[2].toLowerCase()}`;
    else read = 'cheatcode_address';
    const stmt = statementAround(source, regions, i);
    out.push({ read, index: i, offset: pos.byteOffset(i), line: pos.line(i), branch: BRANCH.test(stmt), in_assembly: inAsm(i), excerpt: excerptAt(pos, i) });
  }
  for (const m of source.matchAll(ENV_YUL)) {
    const i = m.index!;
    if (regions[i] !== CODE || !inAsm(i)) continue;
    const stmt = statementAround(source, regions, i);
    out.push({ read: `yul:${m[1]}()`, index: i, offset: pos.byteOffset(i), line: pos.line(i), branch: BRANCH.test(stmt), in_assembly: true, excerpt: excerptAt(pos, i) });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ------------------------------------------------------------------------------------------------
// NatSpec claims contradicted by the function header

const KEYWORDS = new Set([
  'public', 'external', 'internal', 'private', 'view', 'pure', 'payable', 'nonpayable', 'virtual', 'override',
  'returns', 'memory', 'calldata', 'storage', 'constant', 'immutable',
]);
const CLAIM_RESTRICTED = /\bonly\s*(?:the\s+|an?\s+)?(?:owner|admin(?:istrator)?|governance|governor|operator|guardian|manager|minter|role|authori[sz]ed|whitelisted|allowlisted|keeper|controller|timelock|dao)\b|\bonlyOwner\b|\bonly\s+callable\s+by\b|\bcan\s+only\s+be\s+called\s+by\b|\brestricted\s+to\b|\b(?:access[- ]controlled|permissioned|privileged\s+function)\b/i;
const CLAIM_NONREENTRANT = /\bnon-?reentran(?:t|cy)\b|\breentrancy[- ]?(?:guard(?:ed)?|protect(?:ed|ion)?|safe)\b|\bcannot\s+be\s+re-?entered\b|\bprotected\s+against\s+re-?entrancy\b/i;
const MOD_RESTRICTED = /^(?:only\w*|auth\w*|requiresAuth|restricted|isAuthorized|ownerOnly|adminOnly|governance\w*|whenGovernance)$/i;
const MOD_NONREENTRANT = /reentr|^lock$|^locked$|^mutex$|^noReenter/i;
const BODY_RESTRICTED = /msg\.sender\s*[!=]=|[!=]=\s*msg\.sender|_checkOwner\s*\(|_checkRole\s*\(|hasRole\s*\(|_msgSender\(\)\s*[!=]=|[!=]=\s*_msgSender\(\)|requireAuth|isAuthorized\s*\(/;
const BODY_NONREENTRANT = /_nonReentrantBefore|_reentrancyGuard|ReentrancyGuard|\blocked\b|\b_status\b/;

export interface NatspecContradiction {
  function: string;
  index: number;
  claim: 'restricted' | 'non_reentrant';
  claim_text: string;
  modifiers: string[];
}

function natspecBefore(src: string, regions: Uint8Array, i: number): string | null {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0 || regions[j] !== COMMENT) return null;
  // Collect the comment region(s) directly above the function.
  let start = j;
  while (start > 0 && (regions[start - 1] === COMMENT || (/\s/.test(src[start - 1]) && regions[start - 1] === CODE))) start--;
  const block = src.slice(start, j + 1);
  if (!/\/\/\/|\/\*\*/.test(block)) return null;
  return block;
}

export function findNatspecContradictions(src: string): NatspecContradiction[] {
  const regions = solidityRegions(src);
  const out: NatspecContradiction[] = [];
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const i = m.index!;
    if (regions[i] !== CODE) continue;
    const doc = natspecBefore(src, regions, i);
    if (!doc) continue;
    const paramsOpen = i + m[0].length - 1;
    const paramsClose = matchBracket(src, regions, paramsOpen, '(', ')');
    if (paramsClose < 0) continue;
    let k = paramsClose + 1;
    while (k < src.length && !(regions[k] === CODE && (src[k] === '{' || src[k] === ';'))) k++;
    let header = src.slice(paramsClose + 1, k);
    header = header.replace(/\breturns\s*\([^)]*\)/g, ' ').replace(/\boverride\s*\([^)]*\)/g, ' override ');
    const modifiers = [...header.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((x) => x[1]).filter((t) => !KEYWORDS.has(t));
    let body = '';
    if (src[k] === '{') {
      const close = matchBracket(src, regions, k, '{', '}');
      body = src.slice(k, close < 0 ? src.length : close + 1);
    }
    const r = CLAIM_RESTRICTED.exec(doc);
    if (r && !modifiers.some((x) => MOD_RESTRICTED.test(x)) && !BODY_RESTRICTED.test(body)) {
      out.push({ function: m[1], index: i, claim: 'restricted', claim_text: r[0], modifiers });
    }
    const n = CLAIM_NONREENTRANT.exec(doc);
    if (n && !modifiers.some((x) => MOD_NONREENTRANT.test(x)) && !BODY_NONREENTRANT.test(body)) {
      out.push({ function: m[1], index: i, claim: 'non_reentrant', claim_text: n[0], modifiers });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// File scans

/** Test, script and test-tooling paths: environment reads there are not target behavior. */
export function isTestOrScriptPath(path: string): boolean {
  return /(^|\/)(test|tests|script|scripts)\//.test(path) || /\.(t|s)\.sol$/.test(path) || /(^|\/)lib\/forge-std\//.test(path);
}

const AGENT_CONFIG = /(^|\/)(CLAUDE\.md|AGENTS\.md|\.cursorrules|\.windsurfrules|\.clinerules|GEMINI\.md|\.claude\/|\.cursor\/|\.github\/copilot-instructions\.md|\.vscode\/tasks\.json|\.mcp\.json)/;

class Collector {
  readonly flags: ScanFlag[] = [];
  private counts = new Map<string, number>();
  add(f: ScanFlag): void {
    const k = `${f.path}\u0000${f.kind}`;
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    if (n <= MAX_FLAGS_PER_KIND) this.flags.push(f);
  }
  finish(): ScanFlag[] {
    for (const [k, n] of this.counts) {
      if (n > MAX_FLAGS_PER_KIND) {
        const [path, kind] = k.split('\u0000');
        this.flags.push({ path, offset: 0, line: 0, kind: kind as FlagKind, excerpt: '', detail: `${n - MAX_FLAGS_PER_KIND} further ${kind} flags in this file were suppressed (cap ${MAX_FLAGS_PER_KIND})` });
      }
    }
    return this.flags;
  }
}

/** Scan one file's text. `path` decides which checks apply. */
export function scanText(path: string, text: string): ScanFlag[] {
  const c = new Collector();
  scanInto(c, path, text);
  return c.finish();
}

function scanInto(c: Collector, path: string, text: string): void {
  const pos = new Positions(text);
  const isSol = /\.sol$/i.test(path);
  const regions = isSol ? solidityRegions(text) : null;

  // Display deception: bidi controls, invisible characters, confusables.
  for (const d of findDeceptive(text)) {
    if (d.kind === 'bidi_control') {
      c.add({ path, offset: pos.byteOffset(d.index), line: pos.line(d.index), kind: 'bidi_control', excerpt: excerptAt(pos, d.index), detail: `bidirectional control U+${d.code_point.toString(16).toUpperCase().padStart(4, '0')} ${d.name} can reorder the displayed text` });
    } else if (d.kind === 'zero_width') {
      c.add({ path, offset: pos.byteOffset(d.index), line: pos.line(d.index), kind: 'zero_width', excerpt: excerptAt(pos, d.index), detail: `invisible character U+${d.code_point.toString(16).toUpperCase().padStart(4, '0')} ${d.name}` });
    } else if (d.kind === 'confusable') {
      c.add({ path, offset: pos.byteOffset(d.index), line: pos.line(d.index), kind: 'confusable', excerpt: excerptAt(pos, d.index), detail: `confusable letter U+${d.code_point.toString(16).toUpperCase().padStart(4, '0')} ${d.name} inside a mixed-script word` });
    }
  }
  if (isSol && regions) {
    // Non-ASCII letters in code positions (identifiers) even when no ASCII letter is mixed in.
    for (const m of text.matchAll(/[\p{L}\p{N}_$]+/gu)) {
      const i = m.index!;
      if (regions[i] !== CODE || /^[\x00-\x7f]*$/.test(m[0]) || /[A-Za-z]/.test(m[0])) continue;
      c.add({ path, offset: pos.byteOffset(i), line: pos.line(i), kind: 'confusable', excerpt: excerptAt(pos, i), detail: `non-ASCII identifier "${renderVisible(m[0])}" in code` });
    }
  }

  // Instruction-like text: Solidity comments and strings, or any position in documents.
  for (const { re, what } of INSTRUCTION_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const i = m.index!;
      if (regions && regions[i] === CODE) continue;
      c.add({ path, offset: pos.byteOffset(i), line: pos.line(i), kind: 'instruction_to_ai', excerpt: excerptAt(pos, i), detail: `instruction-like text (${what}): "${renderVisible(m[0])}"; treated as data, never as an instruction` });
    }
  }

  if (!isSol || isTestOrScriptPath(path)) return;

  for (const n of findNatspecContradictions(text)) {
    const what = n.claim === 'restricted' ? 'an access restriction' : 'reentrancy protection';
    c.add({
      path,
      offset: pos.byteOffset(n.index),
      line: pos.line(n.index),
      kind: 'natspec_contradiction',
      excerpt: excerptAt(pos, n.index),
      detail: `NatSpec of ${n.function}() claims ${what} ("${renderVisible(n.claim_text)}") but the function has no such modifier or inline check (modifiers: ${n.modifiers.join(', ') || 'none'}); record both as competing statements`,
    });
  }
  for (const r of scanEnvironmentReads(text)) {
    c.add({
      path,
      offset: r.offset,
      line: r.line,
      kind: 'environment_read',
      excerpt: r.excerpt,
      detail: `${r.read === 'cheatcode_address' ? `code at the cheatcode address ${CHEATCODE_ADDRESS}` : r.read}${r.in_assembly ? ' (in assembly)' : ''} ${r.branch ? 'feeds a branch' : 'is read (branch use not determined textually)'}; replay with realistic values and label dependent negative results environment-sensitive`,
    });
  }
}

/** Flags about a path itself (deceptive characters in file names, agent/tool configuration). */
function scanPath(c: Collector, path: string): void {
  for (const d of findDeceptive(path)) {
    if (d.kind === 'bidi_control' || d.kind === 'zero_width' || d.kind === 'control' || d.kind === 'confusable') {
      c.add({ path, offset: 0, line: 0, kind: d.kind === 'confusable' ? 'confusable' : d.kind === 'zero_width' ? 'zero_width' : 'bidi_control', excerpt: renderVisible(path), detail: `file name contains ${d.name}` });
    }
  }
  if (AGENT_CONFIG.test(path)) {
    c.add({ path, offset: 0, line: 0, kind: 'executable_content', excerpt: renderVisible(path), detail: 'repository-provided agent or tool configuration; never loaded or executed by the harness' });
  }
}

export interface ScanInputFile {
  path: string;
  bytes: Uint8Array;
}

/** Scan a frozen tree. Binary and oversized files are skipped and listed. */
export function scanFiles(files: ScanInputFile[]): { flags: ScanFlag[]; skipped: string[] } {
  const c = new Collector();
  const skipped: string[] = [];
  for (const f of files) {
    scanPath(c, f.path);
    if (!TEXT_EXT.test(f.path)) continue;
    if (f.bytes.length > MAX_SCAN_BYTES) {
      skipped.push(`${f.path}: larger than ${MAX_SCAN_BYTES} bytes, not scanned`);
      continue;
    }
    if (f.bytes.includes(0)) {
      skipped.push(`${f.path}: binary content, not scanned`);
      continue;
    }
    const text = Buffer.from(f.bytes).toString('utf8');
    scanInto(c, f.path, text);
    if (/(^|\/)foundry\.toml$/.test(f.path) && /^\s*ffi\s*=\s*true\b/m.test(text)) {
      const i = text.search(/^\s*ffi\s*=\s*true\b/m);
      const pos = new Positions(text);
      c.add({ path: f.path, offset: pos.byteOffset(i), line: pos.line(i), kind: 'executable_content', excerpt: excerptAt(pos, i), detail: 'foundry.toml enables FFI (arbitrary command execution from tests); the sandbox disables it' });
    }
  }
  return { flags: c.finish(), skipped };
}

export { BIDI_CONTROLS, renderVisible };
