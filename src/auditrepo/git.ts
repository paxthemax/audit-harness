// Git for the audit repository and its targets. Unlike the record store (src/store/git.ts), these commands run
// with the user's git configuration, because cloning a private target needs the user's credentials. Hooks and
// fsmonitor are disabled on every call, so a target checkout cannot run code through git.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetEntry } from './manifest.ts';

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;
  constructor(args: string[], stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || 'no output'}`);
    this.args = args;
    this.stderr = stderr;
  }
}

const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', [...SAFE, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new GitError(args, String((e as { stderr?: unknown }).stderr ?? (e as Error).message));
  }
}

export function gitTry(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** Resolve a branch, tag or commit to a full commit, preferring the remote-tracking branch over a stale local one. */
export function resolveRef(dir: string, ref: string): string {
  for (const cand of [`refs/remotes/origin/${ref}`, ref]) {
    const c = gitTry(dir, ['rev-parse', '--verify', '-q', `${cand}^{commit}`]);
    if (c) return c.trim();
  }
  // A commit or tag the initial clone did not bring (e.g. not on a branch): fetch it explicitly.
  if (gitTry(dir, ['fetch', '-q', 'origin', ref]) !== null) {
    const c = gitTry(dir, ['rev-parse', '--verify', '-q', 'FETCH_HEAD^{commit}']);
    if (c) return c.trim();
  }
  throw new GitError(['rev-parse', ref], `cannot resolve ${ref} in ${dir}`);
}

/** Detach the checkout at `commit` and bring its own submodules (e.g. Foundry lib/) to the commits it pins. */
export function checkoutPinned(dir: string, commit: string): void {
  if (gitTry(dir, ['cat-file', '-e', `${commit}^{commit}`]) === null) git(dir, ['fetch', '-q', 'origin']);
  git(dir, ['checkout', '-q', '--detach', commit]);
  git(dir, ['submodule', 'update', '-q', '--init', '--recursive']);
}

export interface CheckoutState {
  present: boolean;
  head: string | null;
  /** `git status --porcelain` lines (tracked changes, untracked files, moved nested submodules). */
  changes: string[];
  /** Nested submodules that are not initialized or not at the commit the target pins. */
  submodules_off: string[];
}

/** State of the repository whose top level is `dir`. An empty submodule directory resolves to the enclosing repository, so it counts as absent. */
export function checkoutState(dir: string): CheckoutState {
  const top = existsSync(dir) ? gitTry(dir, ['rev-parse', '--show-toplevel'])?.trim() : null;
  if (!top || realpathSync(top) !== realpathSync(dir)) return { present: false, head: null, changes: [], submodules_off: [] };
  const head = gitTry(dir, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() || null;
  const changes = (gitTry(dir, ['status', '--porcelain=v1']) ?? '').split('\n').filter(Boolean);
  const submodules_off = (gitTry(dir, ['submodule', 'status', '--recursive']) ?? '')
    .split('\n')
    .filter((l) => /^[-+U]/.test(l))
    .map((l) => l.trim());
  return { present: true, head, changes, submodules_off };
}

/** The commit the audit repository's index records for a submodule target (its gitlink), or null. */
export function gitlink(root: string, t: TargetEntry): string | null {
  const line = gitTry(root, ['ls-files', '-s', '--', t.path])?.trim();
  const m = line ? /^160000 ([0-9a-f]+) /.exec(line) : null;
  return m ? m[1] : null;
}

/** Add a line to the audit repository's .gitignore unless it is already there. */
export function ignorePath(root: string, line: string): void {
  const p = join(root, '.gitignore');
  const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (text.split('\n').includes(line)) return;
  appendFileSync(p, (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
}
