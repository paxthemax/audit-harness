import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { fail } from '../core/errors.ts';

// One controller writes at a time: the walking skeleton is a single local controller process
// (DEC-008, Q-020). Each mutating operation holds this lock from read-validate through commit.
//
// A lock whose holder is dead is reclaimed. An empty or unreadable lock file is treated as a holder
// still writing its pid until it is older than STALE_EMPTY_MS. Reclaiming renames the stale file
// aside and checks that the renamed file is the one judged stale, so two waiters cannot both
// reclaim and then both hold the lock.

const held = new Map<string, number>();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const STALE_EMPTY_MS = 2000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(path: string): { pid: number | null; mtime: number } | null {
  try {
    const text = readFileSync(path, 'utf8').trim();
    const pid = /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null;
    return { pid, mtime: statSync(path).mtimeMs };
  } catch {
    return null; // removed concurrently
  }
}

function isStale(o: { pid: number | null; mtime: number }): boolean {
  if (o.pid === null) return Date.now() - o.mtime > STALE_EMPTY_MS;
  return o.pid !== process.pid && !alive(o.pid);
}

/** Move a stale lock aside; returns true only if the file moved is still the stale one. */
function reclaim(path: string, judged: { pid: number | null; mtime: number }): boolean {
  const aside = `${path}.reclaim.${process.pid}.${Date.now()}`;
  try {
    renameSync(path, aside);
  } catch {
    return false; // someone else reclaimed or released it
  }
  const moved = readOwner(aside);
  if (moved && moved.pid === judged.pid && moved.mtime === judged.mtime) {
    rmSync(aside, { force: true });
    return true;
  }
  // We moved a fresh lock taken in between: put it back only if the slot is still free (link fails
  // when it exists, unlike rename, which would clobber a newer holder).
  try {
    linkSync(aside, path);
  } catch {
    /* the slot was taken again; that holder owns the lock */
  }
  rmSync(aside, { force: true });
  return false;
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
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const owner = readOwner(path);
      if (owner && isStale(owner) && reclaim(path, owner)) continue;
      if (Date.now() > deadline) fail('worker_unreachable', `controller lock ${path} held by pid ${owner?.pid ?? 'unknown'}`);
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
