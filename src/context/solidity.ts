// Comment-blind view of Solidity source for a challenger's comment-blind pass (design/harness-
// interface-contracts.md, "Agent and tool adapter boundary": a challenger "can strip comments and
// NatSpec"). Removes `//` line comments (including `///` NatSpec) and `/* */` block comments
// (including `/** */` NatSpec) while leaving string literals intact: a `//` or `/*` inside "..." or
// '...' (also unicode"..." and hex"...") is code, not a comment. Newlines inside removed comments are
// kept so line numbers in anchors still match the original file.

export function stripSolidityComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"' || c === "'") {
      // String literal: copy through the matching unescaped quote. Solidity forbids raw newlines in
      // string literals, so an unescaped newline ends an unterminated literal (no comment is hidden).
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const d = src[i];
        if (d === '\\' && i + 1 < n) {
          out += d + src[i + 1];
          i += 2;
          continue;
        }
        out += d;
        i++;
        if (d === quote || d === '\n') break;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      // Line comment: drop up to (not including) the line break. A backslash does not continue it.
      i += 2;
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      // Block comment: keep only line breaks. Block comments do not nest in Solidity.
      i += 2;
      let closed = false;
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      // Keep tokens on either side apart: `a/*x*/b` must not become `ab`.
      if (closed) out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
