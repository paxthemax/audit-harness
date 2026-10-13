import { spawn, execFileSync } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, writeSync } from 'node:fs';
import { release } from 'node:os';
import { fail } from '../core/errors.ts';
import { canonicalJson } from '../core/hash.ts';

// Execution sandbox and supervisor (design/harness-state-and-execution.md, "Permissions and isolation",
// "Durable jobs and resource limits"). The sandbox choice is an operator decision; bubblewrap is the
// PROPOSED local default. The supervisor (this process) observes launch, exit, signals, timing and
// stream sizes itself; anything the guest writes is untrusted output. There is no fallback: when the
// sandbox is unavailable the request is refused with `unsupported`.

export interface Bind {
  src: string;
  dest: string;
  writable?: boolean;
}

export interface SandboxLimits {
  runtime_seconds: number;
  /** Cap for each captured stream; excess is discarded and flagged. */
  output_bytes: number;
  memory_mb: number;
  processes: number;
}

export interface SandboxRequest {
  /** argv inside the sandbox; argv[0] is an absolute in-sandbox path. Never a shell string. */
  argv: string[];
  cwd: string;
  binds: Bind[];
  /** The complete environment the guest sees (scrubbed by the caller; recorded as keys only). */
  env: Record<string, string>;
  limits: SandboxLimits;
  stdoutPath: string;
  stderrPath: string;
  /** Called right after spawn with the supervisor-observed process identity. */
  onSpawn?: (p: ProcessIdentity) => void;
  /** In-process cancellation (pause/cancel when the runner shares the controller's process). */
  signal?: AbortSignal;
  graceMs?: number;
}

export interface ProcessIdentity {
  /** The sandbox launcher's pid, which leads its own process group. */
  pid: number;
  pgid: number;
  /** /proc start time of `pid`, used to refuse acting on a recycled pid. */
  start_time: string | null;
}

export interface SandboxResult {
  started_at: string;
  ended_at: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  termination: 'not_applicable' | 'confirmed' | 'unconfirmed';
  identity: ProcessIdentity | null;
  /** Limits the sandbox could not enforce, stated rather than implied. */
  limitations: string[];
}

export interface Sandbox {
  readonly kind: string;
  available(): boolean;
  /** Stable description of the isolation profile, recorded in every receipt. */
  descriptor(req: SandboxRequest): string;
  run(req: SandboxRequest): Promise<SandboxResult>;
}

const BWRAP = '/usr/bin/bwrap';
const PRLIMIT = '/usr/bin/prlimit';
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Proposed size of the guest's tmpfs /tmp (numeric limits are operator choices). */
export const PROPOSED_TMPFS_BYTES = 512 * 1024 * 1024;
/** Proposed grace period between SIGTERM and SIGKILL. */
export const PROPOSED_GRACE_MS = 2000;

/** Read-only system paths visible to the guest. Nothing under $HOME, the workspace or secrets. */
const SYSTEM_RO = ['/usr'];
const ETC_RO = [
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/localtime',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/alternatives',
];

export class BwrapSandbox implements Sandbox {
  readonly kind = 'bwrap';
  private version: string | null | undefined;

  available(): boolean {
    return this.bwrapVersion() !== null;
  }

  bwrapVersion(): string | null {
    if (this.version !== undefined) return this.version;
    try {
      this.version = execFileSync(BWRAP, ['--version'], { encoding: 'utf8', env: {} }).trim();
    } catch {
      this.version = null;
    }
    return this.version;
  }

  descriptor(req: SandboxRequest): string {
    return canonicalJson({
      kind: 'bwrap',
      version: this.bwrapVersion(),
      unshare: ['user', 'ipc', 'pid', 'net', 'uts', 'cgroup'],
      network: 'denied',
      system_ro: [...SYSTEM_RO, ...ETC_RO.filter((p) => existsSync(p))],
      binds: req.binds.map((b) => ({ dest: b.dest, writable: !!b.writable })),
      tmpfs_tmp_bytes: PROPOSED_TMPFS_BYTES,
      limits: req.limits,
      prlimit: existsSync(PRLIMIT),
    });
  }

  args(req: SandboxRequest): { args: string[]; limitations: string[] } {
    const limitations: string[] = [];
    const a = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL'];
    for (const p of SYSTEM_RO) a.push('--ro-bind', p, p);
    for (const name of ['bin', 'sbin', 'lib', 'lib64']) {
      const p = `/${name}`;
      if (!existsSync(p)) continue;
      if (lstatSync(p).isSymbolicLink()) a.push('--symlink', readlinkSync(p), p);
      else a.push('--ro-bind', p, p);
    }
    for (const p of ETC_RO) a.push('--ro-bind-try', p, p);
    a.push('--proc', '/proc', '--dev', '/dev', '--size', String(PROPOSED_TMPFS_BYTES), '--tmpfs', '/tmp');
    a.push('--dir', '/home/sandbox');
    for (const b of req.binds) a.push(b.writable ? '--bind' : '--ro-bind', b.src, b.dest);
    a.push('--clearenv');
    for (const [k, v] of Object.entries(req.env)) a.push('--setenv', k, v);
    a.push('--chdir', req.cwd, '--json-status-fd', '3', '--');
    if (existsSync(PRLIMIT)) {
      // RLIMIT_NPROC counts per user namespace only with per-namespace ucounts (Linux 5.14+); on older
      // kernels it would count every process of the host UID and fail spuriously, so it is omitted.
      const nproc = nprocPerNamespace();
      // RLIMIT_DATA (heap and private writable mappings), not RLIMIT_AS: runtimes such as V8 reserve
      // large PROT_NONE address ranges (WebAssembly guard regions) that an address-space limit would refuse.
      a.push(PRLIMIT, `--data=${req.limits.memory_mb * 1024 * 1024}`, ...(nproc ? [`--nproc=${req.limits.processes}`] : []), '--core=0', '--');
      limitations.push(
        nproc
          ? `enforced: data segment ${req.limits.memory_mb} MB (RLIMIT_DATA on private writable memory, not a cgroup limit); ${req.limits.processes} processes counted within the sandbox's user namespace`
          : `enforced: data segment ${req.limits.memory_mb} MB (RLIMIT_DATA); process count NOT enforced (kernel ${release()} lacks per-namespace process accounting)`,
      );
    } else {
      limitations.push('memory and process-count limits not enforced: prlimit unavailable');
    }
    limitations.push(`not enforced: no disk quota on the /work scratch copy (only /tmp is bounded, at ${PROPOSED_TMPFS_BYTES} bytes); no CPU-time limit beyond the wall-clock runtime limit`);
    return { args: [...a, ...req.argv], limitations };
  }

  run(req: SandboxRequest): Promise<SandboxResult> {
    if (!this.available()) fail('unsupported', 'bubblewrap sandbox is unavailable; refusing to run without isolation');
    if (!req.argv.length || !req.argv[0].startsWith('/')) fail('invalid_request', 'argv[0] must be an absolute path inside the sandbox');
    const { args, limitations } = this.args(req);
    const graceMs = req.graceMs ?? PROPOSED_GRACE_MS;
    return new Promise((resolve, reject) => {
      const started_at = new Date().toISOString();
      const child = spawn(BWRAP, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: {} });
      let identity: ProcessIdentity | null = null;
      let timedOut = false;
      let cancelled = false;
      let killing = false;
      let innerExit: number | null = null;
      let innerPid: number | null = null;
      const out = capture(child.stdout!, req.stdoutPath, req.limits.output_bytes);
      const err = capture(child.stderr!, req.stderrPath, req.limits.output_bytes);
      let status = '';
      (child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => {
        status += d.toString('utf8');
        for (const m of status.matchAll(/"child-pid":\s*(\d+)/g)) innerPid = Number(m[1]);
        for (const m of status.matchAll(/"exit-code":\s*(\d+)/g)) innerExit = Number(m[1]);
      });

      const stop = () => {
        if (killing || !identity) return;
        killing = true;
        signalGroup(identity.pgid, 'SIGTERM');
        setTimeout(() => {
          if (groupAlive(identity!.pgid)) signalGroup(identity!.pgid, 'SIGKILL');
        }, graceMs).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, Math.max(1, req.limits.runtime_seconds * 1000));
      const onAbort = () => {
        cancelled = true;
        stop();
      };
      if (req.signal) {
        if (req.signal.aborted) cancelled = true;
        req.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('spawn', () => {
        identity = { pid: child.pid!, pgid: child.pid!, start_time: procStartTime(child.pid!) };
        try {
          req.onSpawn?.(identity);
        } catch {
          // The caller refused the dispatch (e.g. paused meanwhile): stop at once.
          cancelled = true;
        }
        if (cancelled) stop();
      });
      child.on('close', async (code, sig) => {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        await Promise.all([out.done, err.done]);
        // The launcher exited; confirm no member of its group (or the guest) is still running.
        let termination: SandboxResult['termination'] = 'not_applicable';
        if (identity) {
          const alive = () => groupAlive(identity!.pgid) || (innerPid !== null && pidAlive(innerPid));
          if (alive()) {
            signalGroup(identity.pgid, 'SIGKILL');
            await new Promise((r) => setTimeout(r, 100));
          }
          termination = alive() ? 'unconfirmed' : killing ? 'confirmed' : 'not_applicable';
        }
        // bwrap reports the guest's own exit code on the status fd; the launcher's code otherwise.
        const exitCode = innerExit ?? (sig ? null : code);
        resolve({
          started_at,
          ended_at: new Date().toISOString(),
          exit_code: exitCode,
          signal: sig ?? (exitCode !== null && exitCode > 128 && innerExit !== null ? signalName(exitCode - 128) : null),
          timed_out: timedOut,
          cancelled,
          stdout_bytes: out.bytes(),
          stderr_bytes: err.bytes(),
          stdout_truncated: out.truncated(),
          stderr_truncated: err.truncated(),
          termination,
          identity,
          limitations,
        });
      });
    });
  }
}

function nprocPerNamespace(): boolean {
  const [major, minor] = release().split('.').map((x) => parseInt(x, 10));
  return major > 5 || (major === 5 && minor >= 14);
}

function capture(stream: NodeJS.ReadableStream, path: string, cap: number) {
  const file = createWriteStream(path, { mode: 0o600 });
  let total = 0;
  let written = 0;
  stream.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (written >= cap) return;
    const part = chunk.subarray(0, Math.min(chunk.length, cap - written));
    written += part.length;
    file.write(part);
  });
  const done = new Promise<void>((resolve) => {
    stream.on('end', () => file.end(resolve));
    stream.on('error', () => file.end(resolve));
  });
  return { done, bytes: () => written, truncated: () => total > cap };
}

function signalName(n: number): string | null {
  const names: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM', 25: 'SIGXFSZ' };
  return names[n] ?? `SIG${n}`;
}

// -----------------------------------------------------------------------------------------------
// Process inspection through /proc (supervisor-side; zombies count as terminated)

interface ProcStat {
  state: string;
  pgrp: number;
  start_time: string;
}

function readStat(pid: number): ProcStat | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0], pgrp: Number(rest[2]), start_time: rest[19] };
  } catch {
    return null;
  }
}

export function procStartTime(pid: number): string | null {
  return readStat(pid)?.start_time ?? null;
}

export function pidAlive(pid: number): boolean {
  const s = readStat(pid);
  return !!s && s.state !== 'Z' && s.state !== 'X';
}

/** True when any non-zombie process is still in the group. */
export function groupAlive(pgid: number): boolean {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const s = readStat(Number(name));
    if (s && s.pgrp === pgid && s.state !== 'Z' && s.state !== 'X') return true;
  }
  return false;
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    /* already gone */
  }
}

/**
 * Terminate a recorded sandbox's process group from any process (pause/cancel/reconciliation):
 * SIGTERM, then SIGKILL after the grace period. The recorded start time guards against pid reuse.
 * Synchronous because controller operations are; it blocks for at most about twice `graceMs`.
 */
export function terminateRecorded(identity: ProcessIdentity, graceMs = PROPOSED_GRACE_MS): 'confirmed' | 'unconfirmed' {
  if (!identityAlive(identity)) return 'confirmed';
  if (!groupAlive(identity.pgid)) return 'confirmed';
  signalGroup(identity.pgid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(identity.pgid)) Atomics.wait(sleeper, 0, 0, 20);
  if (groupAlive(identity.pgid)) {
    signalGroup(identity.pgid, 'SIGKILL');
    const killDeadline = Date.now() + graceMs;
    while (Date.now() < killDeadline && groupAlive(identity.pgid)) Atomics.wait(sleeper, 0, 0, 20);
  }
  return groupAlive(identity.pgid) ? 'unconfirmed' : 'confirmed';
}

/** Whether a recorded identity still names a live process group. */
export function identityAlive(identity: ProcessIdentity): boolean {
  const s = readStat(identity.pid);
  if (s && identity.start_time !== null && s.start_time !== identity.start_time) return false; // pid reused
  // Without a recorded start time, act only on a group still led by a sandbox launcher.
  if (identity.start_time === null && !isLauncher(identity.pgid)) return false;
  return groupAlive(identity.pgid);
}

function isLauncher(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0].endsWith('bwrap');
  } catch {
    return false;
  }
}

/** Write a small JSON file atomically enough for supervisor metadata (exclusive create). */
export function writeJsonExclusive(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + '\n');
  } finally {
    closeSync(fd);
  }
}
