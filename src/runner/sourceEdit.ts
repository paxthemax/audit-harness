import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { posix, resolve, sep } from 'node:path';
import { fail } from '../core/errors.ts';
import type { Archive } from '../store/archive.ts';
import type { JobPurpose } from '../schema/records.ts';

// Source edits on a disposable copy (design/harness-state-and-execution.md, "Replay and semantic
// validity"): a positive control removes the cited guard from the TARGET; an adequacy job injects a
// reviewed fault into the TARGET. Either edit names a file of the snapshot that the job's fixture does
// not touch and that is not a test or script, matches exactly once, and is applied literally. A
// positive control may only remove code. Checked when the job is requested and again before the edit
// is applied.

export interface SourceEdit {
  path: string;
  find: string;
  replace: string;
}

/** Foundry's test and script directories from the default profile of foundry.toml (defaults test/, script/). */
export function foundryTestDirs(toml: string | null): string[] {
  const dirs = new Set(['test', 'script']);
  if (toml) {
    const section = /\[profile\.default\]([\s\S]*?)(?=\n\[|$)/.exec(toml)?.[1] ?? toml;
    for (const key of ['test', 'script']) {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(section);
      if (m) dirs.add(posix.normalize(m[1]).replace(/^\.\/|\/$/g, ''));
    }
  }
  return [...dirs];
}

/** True when `replace` can be obtained from `find` by deleting characters, or is blank or a comment. */
export function isRemovalOnly(find: string, replace: string): boolean {
  if (!replace.trim()) return true;
  if (/^(\s*\/\/[^\n]*(\n|$))+\s*$/.test(replace)) return true;
  if (/^\s*\/\*(?:(?!\*\/)[\s\S])*\*\/\s*$/.test(replace)) return true;
  let i = 0;
  for (const ch of find) if (i < replace.length && ch === replace[i]) i++;
  return i === replace.length;
}

function occurrences(text: string, find: string): number {
  return text.split(find).length - 1;
}

export function validateSourceEdit(
  archive: Archive,
  snapshotTree: string,
  fixtureTree: string | null,
  edit: SourceEdit,
  purpose: JobPurpose,
): void {
  if (!edit || typeof edit.path !== 'string' || typeof edit.find !== 'string' || !edit.find || typeof edit.replace !== 'string') {
    fail('invalid_request', 'guard_removal needs path, find and replace');
  }
  const path = posix.normalize(edit.path);
  if (path !== edit.path || path.startsWith('/') || path.startsWith('..') || path.includes('\\')) fail('invalid_request', `source edit path ${edit.path} is not a normalized relative path`);
  const files = archive.getTree(snapshotTree).files;
  if (!files[path]) fail('invalid_request', `source edit path ${path} is not a file of the snapshot`);
  if (fixtureTree && archive.getTree(fixtureTree).files[path]) fail('invalid_request', `source edit path ${path} is touched by the job's fixture; the edit applies to the target only`);
  const toml = files['foundry.toml'] ? archive.getText(files['foundry.toml']) : null;
  const testDirs = foundryTestDirs(toml);
  if (testDirs.some((d) => path === d || path.startsWith(`${d}/`)) || /\.(t|s)\.sol$/.test(path)) {
    fail('invalid_request', `source edit path ${path} is a test or script; the edit applies to the target's source`);
  }
  const n = occurrences(archive.getText(files[path]), edit.find);
  if (n !== 1) fail('invalid_request', `the edited text occurs ${n} times in ${path}; exactly one is required`);
  if (purpose === 'positive_control' && !isRemovalOnly(edit.find, edit.replace)) {
    fail('invalid_request', 'a positive control only removes the cited guard: replace must be find with characters deleted, blank, or a comment');
  }
}

/** Apply literally (split/join, no `$&`-style expansion), exactly once, inside `work`. */
export function applySourceEdit(work: string, edit: SourceEdit): void {
  const target = resolve(work, edit.path);
  if (!target.startsWith(resolve(work) + sep)) fail('invalid_request', `source edit path escapes the scratch copy: ${edit.path}`);
  if (!existsSync(target)) fail('invalid_request', `source edit file ${edit.path} not found in the scratch copy`);
  const text = readFileSync(target, 'utf8');
  const parts = text.split(edit.find);
  if (parts.length !== 2) fail('invalid_request', `the edited text occurs ${parts.length - 1} times in ${edit.path}; exactly one is required`);
  writeFileSync(target, parts.join(edit.replace));
}
