import { execFileSync } from 'node:child_process';

// Git is the walking skeleton's durability and backup layer (DEC-008, Q-020). The controller runs git
// with user configuration, hooks and signing disabled so that repository-provided or personal
// configuration cannot execute code or prompt during a commit.

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'audit-harness controller',
  GIT_AUTHOR_EMAIL: 'controller@audit-harness.invalid',
  GIT_COMMITTER_NAME: 'audit-harness controller',
  GIT_COMMITTER_EMAIL: 'controller@audit-harness.invalid',
  GIT_TERMINAL_PROMPT: '0',
};

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function gitInit(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
}

/** Read-only inspection of a target repository (never commits there). */
export function gitInspect(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}
