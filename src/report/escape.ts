import { renderVisible } from '../intake/visible.ts';

// Escaping for record-derived text in Markdown reports and bundle READMEs. Report text comes from
// records that may quote target content, so nothing in it may act as markup, HTML, links or terminal
// control sequences: deceptive and control characters are made visible (src/intake/visible.ts),
// HTML metacharacters become entities, and Markdown metacharacters are backslash-escaped.

const MD_SPECIAL = /[\\`*_{}[\]()#!|~]/g;

/** One line of inline text (newlines folded to spaces). */
export function md(value: unknown): string {
  const s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return renderVisible(s.replace(/\r?\n/g, ' '))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(MD_SPECIAL, (c) => '\\' + c);
}

/** Multi-line text as a blockquote, each line escaped. */
export function mdBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map((l) => '> ' + md(l))
    .join('\n');
}

/** Inline code-like identifier (record IDs, digests, paths), escaped the same way. */
export function mdId(value: string): string {
  return md(value);
}
