import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { fail } from '../core/errors.ts';

// One controller writes at a time: the walking skeleton is a single local controller process
// (DEC-008, Q-020). Each mutating operation holds this lock from read-validate through commit.
// A lock left by a dead process is reclaimed.

const held = new Map<string, number>();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function withLock<T>(path: string, fn: () => T, timeoutMs = 15000): T {
  const depth = held.get(path) ?? 0;
  if (depth > 0) {
    held.set(path, depth + 1);
    try {
      return fn();
    } finally {
      held.set(path, held.get(path)! - 1);
    }
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let owner = NaN;
      try {
        owner = Number(readFileSync(path, 'utf8'));
      } catch {
        /* removed concurrently */
      }
      if (Number.isFinite(owner) && owner !== process.pid && !alive(owner)) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() > deadline) fail('worker_unreachable', `controller lock ${path} held by pid ${owner}`);
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  held.set(path, 1);
  try {
    return fn();
  } finally {
    held.delete(path);
    rmSync(path, { force: true });
  }
}
