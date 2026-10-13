import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fail, HarnessError, isHarnessError } from '../core/errors.ts';
import { digestFile, digestJson, randomToken } from '../core/hash.ts';
import type { ArtifactRef, Ref } from '../core/refs.ts';
import { Controller, type Session } from '../controller/controller.ts';
import type { Archive, TreeManifest } from '../store/archive.ts';
import type { ExecutionReceipt, StructuredResult } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { adapterFor, descriptorDigest, TOOL_ROOT, foundryToolchain, type Observation } from './adapters.ts';
import { currentEnvironmentScanner } from './hooks.ts';
import { activeHere, attemptDir, type CompleteAttemptPayload, type OutboxOutcome } from './jobs.ts';
import { scheduleReruns } from '../snapshot/reruns.ts';
import { nextJob } from '../scheduler/scheduler.ts';
import { startBrokerSocket, type BrokerSocket } from './brokerSocket.ts';
import { loadContextManifest, materializeContext } from './context.ts';
import { applySourceEdit, validateSourceEdit } from './sourceEdit.ts';
import { BwrapSandbox, writeJsonExclusive, type Bind, type Sandbox, type SandboxLimits, type SandboxResult } from './sandbox.ts';

// The trusted runner (design/harness-state-and-execution.md, "Write and approval protocol",
// "Durable jobs and resource limits"). It runs outside every sandbox in the controller's own process,
// one attempt at a time: it persists the dispatch intent (start_attempt) before spawning, records the
// process identity, stages stdout/stderr/output trees in the archive (hashed and stored before the
// metadata commit), ingests the worker's outbox under the attempt's grant, and reports one completion
// on the runner channel. Worker processes never see the workspace, secrets or the store.
//
// Attempt scratch:  runs/<engagement>/<attempt>/{target,work,outbox,grant,io}/, supervisor.json,
// staged.json. Only target (read-only), work, outbox and (for agent hosts) grant are mounted.

export const RUNNER_IDENTITY = { identity: 'audit-harness trusted runner', version: '0.1.0' };

/** Proposed outbox bounds (numeric limits are operator choices). */
export const PROPOSED_OUTBOX_MAX_FILES = 64;
export const PROPOSED_OUTBOX_MAX_BYTES = 256 * 1024;

export interface RunOptions {
  sandbox?: Sandbox;
  /** In-process stop for the running attempt (pause/cancel in another process use the recorded pid). */
  signal?: AbortSignal;
  keepScratch?: boolean;
}

export interface AttemptOutcome {
  job: string;
  attempt: Ref | null;
  status: string;
  evidence: Ref | null;
  eligible: boolean;
}

const defaultSandbox = new BwrapSandbox();

/** Guest-side symptoms of a denied connection or name lookup (the sandbox has no network at all). */
const EGRESS_PATTERN = /Network is unreachable|network is unreachable|Temporary failure in name resolution|Could not resolve host|failed to lookup address|dns error|error sending request/;

/** The read-only target is enforced by a read-only bind; the scratch copy is writable. */
function materializeTree(archive: Archive, tree: string, dest: string, writable: boolean): void {
  archive.materialize(tree, dest, writable);
}

/** What the guest asked the broker for, as evidence limitations (every refused endpoint is listed). */
function brokerSummary(b: BrokerSocket | null): string[] {
  if (!b) return [];
  const reqs = b.requests();
  if (!reqs.length) return ['broker: no provider requests'];
  const counts = new Map<string, number>();
  for (const r of reqs) {
    const k = `${r.method} ${r.path}${r.stream ? ' (stream)' : ''} -> ${r.status}${r.code ? ` ${r.code}` : ''}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const dropped = [...new Set(reqs.flatMap((r) => r.dropped_betas))];
  return [
    `broker: ${reqs.length} request(s): ${[...counts].map(([k, n]) => `${k} x${n}`).join('; ')}`,
    ...(dropped.length ? [`broker: beta headers not on the allowlist were dropped: ${dropped.join(', ')}`] : []),
  ];
}

/** The declared tests' results of the checked experiment's latest completed attempt (null if none). */
function lineageBaseline(store: RecordStore, lineage: Ref | null): StructuredResult['tests'] | null {
  if (!lineage) return null;
  const ev = store
    .heads('evidence_artifact')
    .filter((e) => e.body.job?.record_id === lineage.record_id && e.body.structured_result && e.body.attempt && store.mustHead(e.body.attempt.record_id, 'attempt').body.status === 'completed')
    .pop();
  return ev ? ev.body.structured_result!.tests.filter((t) => t.expect !== null) : null;
}

/** Hash a directory into the archive, stopping at `cap` bytes (flagged, never silent). */
function putTreeCapped(archive: Archive, dir: string, cap: number): { ref: ArtifactRef; manifest: TreeManifest; truncated: boolean; blobs: string[] } {
  let total = 0;
  let truncated = false;
  const root = resolve(dir);
  const res = archive.putTree(root, (rel) => {
    const st = lstatSync(join(root, rel));
    if (!st.isFile()) return true;
    if (total + st.size > cap) {
      truncated = true;
      return false;
    }
    total += st.size;
    return true;
  });
  return { ...res, truncated, blobs: [res.ref.artifact, ...Object.values(res.manifest.files)] };
}

function readCapped(path: string, cap: number): string {
  try {
    return readFileSync(path).subarray(0, cap).toString('utf8');
  } catch {
    return '';
  }
}

type Placeholder = { $result: string; path?: string };

function isPlaceholder(v: unknown): v is Placeholder {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Placeholder).$result === 'string';
}

function dig(value: unknown, path: string | undefined): unknown {
  let cur = value;
  for (const k of (path ?? '').split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Proposed bound on a payload after placeholder expansion (4x the per-file outbox limit). */
export const PROPOSED_OUTBOX_MAX_EXPANDED_BYTES = 4 * PROPOSED_OUTBOX_MAX_BYTES;

/**
 * Replace `{$result, path}` placeholders (anywhere in the payload) with earlier entries' results.
 * Expansion is metered as it happens, so a payload that would grow past the bound is refused before
 * it is built.
 */
function resolvePlaceholders(v: unknown, results: Map<string, { ok: boolean; result: unknown }>, budget = { left: PROPOSED_OUTBOX_MAX_EXPANDED_BYTES }): unknown {
  if (isPlaceholder(v)) {
    const prior = results.get(v.$result);
    if (!prior) throw new HarnessError('invalid_request', `placeholder names no earlier outbox entry ${v.$result}`);
    if (!prior.ok) throw new HarnessError('invalid_request', `depends on a refused entry (${v.$result})`);
    const out = dig(prior.result, v.path);
    if (out === undefined) throw new HarnessError('invalid_request', `entry ${v.$result} has no result at ${v.path ?? '(root)'}`);
    budget.left -= JSON.stringify(out).length;
    if (budget.left < 0) throw new HarnessError('invalid_request', `expanded payload over limit (${PROPOSED_OUTBOX_MAX_EXPANDED_BYTES} bytes)`);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolvePlaceholders(x, results, budget));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolvePlaceholders(x, results, budget)]));
  return v;
}

/**
 * Ingest the worker's outbox in filename order under the attempt's grant (normal checks apply). An
 * entry's payload may reference an earlier entry's committed result with `{"$result": "<name>",
 * "path": "<dot path>"}`; a reference to a refused or invalid entry makes the entry invalid.
 */
function ingestOutbox(controller: Controller, engagementId: string, outbox: string, token: string): OutboxOutcome[] {
  if (!existsSync(outbox)) return [];
  const files = readdirSync(outbox)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: OutboxOutcome[] = [];
  const results = new Map<string, { ok: boolean; result: unknown }>();
  const invalid = (file: string, operation: string | null, reason: string): void => {
    out.push({ file, operation, status: 'invalid', code: 'invalid_request', reason, records: [], payload_digest: null });
    results.set(file.slice(0, -5), { ok: false, result: null });
  };
  for (const [i, file] of files.entries()) {
    const path = join(outbox, file);
    const st = lstatSync(path);
    if (i >= PROPOSED_OUTBOX_MAX_FILES || !st.isFile() || st.size > PROPOSED_OUTBOX_MAX_BYTES) {
      invalid(file, null, 'outbox entry over limits or not a regular file');
      continue;
    }
    let req: { operation?: unknown; payload?: unknown; idempotency_key?: unknown };
    try {
      req = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      invalid(file, null, 'unparseable request');
      continue;
    }
    const operation = typeof req.operation === 'string' ? req.operation : null;
    if (!operation) {
      invalid(file, null, 'request names no operation');
      continue;
    }
    let payload: unknown;
    try {
      payload = resolvePlaceholders(req.payload ?? {}, results);
    } catch (e) {
      invalid(file, operation, (e as Error).message.replace(/^invalid_request: /, ''));
      continue;
    }
    const payload_digest = digestJson(payload);
    try {
      // Normal grant checks apply: the worker channel, the grant's operations, its expiry.
      const session = controller.worker(engagementId, token);
      const key = typeof req.idempotency_key === 'string' ? req.idempotency_key : undefined;
      const res = session.call(engagementId, operation, payload, { idempotency_key: key });
      out.push({ file, operation, status: 'committed', code: null, reason: null, records: res.records, payload_digest });
      results.set(file.slice(0, -5), { ok: true, result: res.result });
    } catch (e) {
      const code = e instanceof HarnessError ? e.code : 'invalid_request';
      out.push({ file, operation, status: 'refused', code, reason: (e as Error).message.slice(0, 500), records: [], payload_digest });
      results.set(file.slice(0, -5), { ok: false, result: null });
    }
  }
  return out;
}

/**
 * Dispatch and run one queued job: one attempt, start to recorded completion. Refusals at dispatch
 * (paused, budget, stale authorization, unconfirmed stop) propagate as HarnessErrors.
 */
export async function runJob(controller: Controller, engagementId: string, jobId: string, opts: RunOptions = {}): Promise<AttemptOutcome> {
  const sandbox = opts.sandbox ?? defaultSandbox;
  if (!sandbox.available()) fail('unsupported', `${sandbox.kind} sandbox is unavailable; refusing to run without isolation`);
  const ws = controller.ws;
  const runner = controller.runner();
  const { token, digest } = Controller.newWorkerToken();
  const started = runner.do(engagementId, 'start_attempt', { job: jobId, grant_digest: digest });
  const attempt: Ref = started.attempt;
  const key = `${engagementId}/${attempt.record_id}`;
  activeHere.add(key);
  const dir = attemptDir(ws, engagementId, attempt.record_id);
  const complete = (payload: Omit<CompleteAttemptPayload, 'attempt'>): AttemptOutcome => {
    const r = runner.do(engagementId, 'complete_attempt', { attempt: attempt.record_id, ...payload });
    return { job: jobId, attempt: r.attempt, status: r.status, evidence: r.evidence, eligible: r.eligible ?? false };
  };
  let shortHarness: string | null = null;
  try {
    const store = ws.store(engagementId, true);
    const job = store.mustHead(jobId, 'job');
    rmSync(dir, { recursive: true, force: true });
    for (const d of ['io', 'outbox']) mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });

    // Prepare the read-only target and the writable scratch copy; failures mean nothing ran.
    let adapter;
    let plan;
    let envReads: string[] | null = null;
    let prepLimitations: string[] = [];
    try {
      adapter = adapterFor(ws, job.body.adapter.name);
      if (store.archive.has(job.body.adapter.descriptor)) {
        const recorded = store.archive.getJson(job.body.adapter.descriptor);
        if (descriptorDigest(recorded as never) !== descriptorDigest(adapter.descriptor())) {
          fail('unsupported', 'the adapter descriptor changed since the job was requested; a new job is required');
        }
      }
      const snap = store.get(job.body.snapshot, 'target_snapshot');
      materializeTree(store.archive, snap.body.tree.artifact, join(dir, 'target'), false);
      materializeTree(store.archive, snap.body.tree.artifact, join(dir, 'work'), true);
      if (job.body.fixture) store.archive.materialize(job.body.fixture.artifact, join(dir, 'work'), true);
      if (job.body.guard_removal) {
        // Defense in depth: the edit is re-validated against the snapshot and fixture before it is applied.
        validateSourceEdit(store.archive, snap.body.tree.artifact, job.body.fixture?.artifact ?? null, job.body.guard_removal, job.body.purpose);
        applySourceEdit(join(dir, 'work'), job.body.guard_removal);
      }
      prepLimitations = adapter.prepare?.(join(dir, 'work')) ?? [];
      plan = adapter.plan(job.body.args, { role: job.body.role });
      if (adapter.descriptor().context_mount) {
        if (!job.body.context_manifest) fail('invalid_request', 'agent jobs carry a context manifest');
        const view = loadContextManifest(store, job.body.context_manifest);
        materializeContext(store.archive, job.body.context_manifest, view, join(dir, 'context'));
      }
      const scanner = currentEnvironmentScanner();
      if (scanner) envReads = scanner(join(dir, 'work'));
    } catch (e) {
      return complete({ not_run: (e as Error).message });
    }

    const binds: Bind[] = [
      { src: join(dir, 'target'), dest: '/target' },
      { src: join(dir, 'work'), dest: '/work', writable: true },
      { src: join(dir, 'outbox'), dest: '/outbox', writable: true },
      ...plan.binds,
    ];
    const env: Record<string, string> = { ...plan.env, HARNESS_OUTBOX: '/outbox', HARNESS_TARGET: '/target' };
    const desc0 = adapter.descriptor();
    const auth = store.mustHead(job.body.authorization.record_id, 'work_authorization');
    // UNIX socket paths are limited (~108 bytes); a deep workspace gets a short private directory.
    const harness = join(dir, 'harness', 'broker.sock').length > 100 ? mkdtempSync(join(tmpdir(), 'hh-')) : join(dir, 'harness');
    shortHarness = harness.startsWith(dir) ? null : harness;
    const withBroker = !!desc0.provider_access && auth.body.capabilities.providers.length > 0;
    if (desc0.grant_in_sandbox || desc0.context_mount || withBroker) {
      // /run/harness (read-only): grant token, task file, broker socket.
      mkdirSync(harness, { recursive: true, mode: 0o700 });
      binds.push({ src: harness, dest: '/run/harness' });
    }
    if (desc0.grant_in_sandbox) {
      writeFileSync(join(harness, 'token'), token, { mode: 0o400 });
      env.HARNESS_GRANT_FILE = '/run/harness/token';
    }
    if (desc0.context_mount) {
      const task = {
        args: job.body.args,
        job: {
          record_id: job.record_id,
          role: job.body.role,
          authorization: job.body.authorization,
          investigation: job.body.investigation,
          variant: job.body.variant,
          snapshot: job.body.snapshot,
          engagement: engagementId,
        },
      };
      writeFileSync(join(harness, 'task.json'), JSON.stringify(task, null, 2) + '\n', { mode: 0o444 });
      binds.push({ src: join(dir, 'context'), dest: '/context' });
      env.HARNESS_TASK = '/run/harness/task.json';
      env.HARNESS_CONTEXT = '/context';
    }
    let brokerSocket: BrokerSocket | null = null;
    if (withBroker) {
      brokerSocket = await startBrokerSocket({ controller, engagementId, attemptId: attempt.record_id, token, socketPath: join(harness, 'broker.sock') });
      env.HARNESS_BROKER_SOCKET = '/run/harness/broker.sock';
    }
    const limits: SandboxLimits = {
      runtime_seconds: job.body.limits.runtime_seconds,
      output_bytes: job.body.limits.output_bytes,
      memory_mb: job.body.limits.memory_mb,
      processes: job.body.limits.processes,
    };
    const req = {
      argv: plan.argv,
      cwd: '/work',
      binds,
      env,
      limits,
      stdoutPath: join(dir, 'io', 'stdout'),
      stderrPath: join(dir, 'io', 'stderr'),
      signal: opts.signal,
      onSpawn: (id: { pid: number; pgid: number; start_time: string | null }) => {
        writeJsonExclusive(join(dir, 'supervisor.json'), { ...id, runner_pid: process.pid });
        // Refused when the attempt was stopped meanwhile; the sandbox then stops the process.
        runner.do(engagementId, 'record_attempt_pid', { attempt: attempt.record_id, pid: id.pid });
      },
    };
    // The dispatch may have been stopped between start_attempt and spawn.
    if (ws.store(engagementId, true).mustHead(attempt.record_id, 'attempt').body.status !== 'running') {
      await brokerSocket?.close();
      return complete({ not_run: 'stopped before the process was spawned' });
    }
    let res: SandboxResult;
    try {
      res = await sandbox.run(req);
    } finally {
      // In-flight provider calls finish and record their outcome before the attempt completes.
      await brokerSocket?.close();
    }

    // Stage everything in the archive before the metadata commit.
    const archive = store.archive;
    const stdout = archive.putFile(req.stdoutPath);
    const stderr = archive.putFile(req.stderrPath);
    const outputs: { path: string; artifact: ArtifactRef }[] = [];
    const blobs: string[] = [];
    const missing: string[] = [];
    for (const rel of plan.outputs) {
      const p = join(dir, 'work', rel);
      if (!existsSync(p) || !lstatSync(p).isDirectory()) {
        missing.push(`output ${rel} was not produced`);
        continue;
      }
      const t = putTreeCapped(archive, p, job.body.limits.output_bytes);
      outputs.push({ path: rel, artifact: t.ref });
      blobs.push(...t.blobs);
      if (t.truncated) missing.push(`output ${rel} truncated at ${job.body.limits.output_bytes} bytes`);
      if (t.manifest.refused.length) missing.push(`output ${rel}: ${t.manifest.refused.length} entries refused at ingestion`);
    }
    writeFileSync(join(dir, 'staged.json'), JSON.stringify({ stdout, stderr, outputs }, null, 2));

    const outbox = ingestOutbox(controller, engagementId, join(dir, 'outbox'), token);

    const now = ws.store(engagementId, true).mustHead(attempt.record_id, 'attempt');
    const stopped = now.body.status === 'cancelled';
    const obs: Observation = {
      exit_code: res.exit_code,
      signal: res.signal,
      timed_out: res.timed_out,
      cancelled: res.cancelled || stopped,
      stdout: readCapped(req.stdoutPath, job.body.limits.output_bytes),
      stderr: readCapped(req.stderrPath, job.body.limits.output_bytes),
      stdout_truncated: res.stdout_truncated,
      stderr_truncated: res.stderr_truncated,
      args: job.body.args,
      mode: plan.mode,
      ...(job.body.purpose === 'positive_control' || job.body.purpose === 'adequacy' ? { baseline: lineageBaseline(store, job.body.lineage) } : {}),
    };
    const interp = adapter.interpret(obs);
    const desc = adapter.descriptor();
    const receipt: ExecutionReceipt = {
      runner: RUNNER_IDENTITY,
      sandbox: { kind: sandbox.kind, network: 'denied', descriptor: sandbox.descriptor(req) },
      argv: plan.argv,
      cwd: '/work',
      executable: desc.executable,
      env_keys: Object.keys(env).sort(),
      started_at: res.started_at,
      ended_at: res.ended_at,
      exit_code: res.exit_code,
      signal: res.signal,
      timed_out: res.timed_out,
      stdout,
      stderr,
      stdout_truncated: res.stdout_truncated,
      stderr_truncated: res.stderr_truncated,
      outputs,
    };
    // An egress attempt is an explicit `egress_denied` outcome: the attempt is recorded, nothing was sent.
    const egress = EGRESS_PATTERN.test(obs.stderr) || EGRESS_PATTERN.test(obs.stdout);
    const result = egress
      ? { ...interp.result, interpretation: `egress_denied: the guest attempted network access and the sandbox denied it (nothing was sent). ${interp.result.interpretation}` }
      : interp.result;
    const out = complete({
      run: {
        receipt,
        result,
        failed: res.cancelled && !stopped ? 'stopped by the runner' : interp.failed,
        missing_or_truncated: [...missing, ...interp.missing],
        limitations: [
          ...(egress ? ['egress_denied: the guest attempted network access; the sandbox has no network (default-deny), nothing was sent'] : []),
          ...brokerSummary(brokerSocket),
          ...(outbox.length
            ? [`outbox: ${outbox.length} entr${outbox.length === 1 ? 'y' : 'ies'}: ${['committed', 'refused', 'invalid'].map((st) => `${outbox.filter((o) => o.status === st).length} ${st}`).join(', ')}`]
            : []),
          ...res.limitations,
          ...prepLimitations,
          ...plan.limitations,
          ...interp.limitations,
        ],
        environment_reads: envReads,
        termination: res.termination,
        blobs,
        egress_denied: egress,
      },
      outbox,
    });
    if (!opts.keepScratch) rmSync(dir, { recursive: true, force: true });
    return out;
  } finally {
    if (shortHarness) rmSync(shortHarness, { recursive: true, force: true });
    activeHere.delete(key);
  }
}

export interface QueueResult {
  ran: AttemptOutcome[];
  stopped: 'idle' | 'paused' | 'budget_exhausted' | 'stop_unconfirmed' | 'aborted' | 'max_jobs';
  skipped: { job: string; code: string; reason: string }[];
  /** Queued jobs the scheduler held back at the last pick, with the reason. */
  held: { job: string; reason: string }[];
}

/**
 * Run queued jobs FIFO, one at a time, re-checking pause state before each dispatch. Stops on budget
 * exhaustion or an unconfirmed stop; jobs refused for their own reasons (stale authorization, affected
 * premise) are skipped and stay queued.
 */
export async function runQueue(
  controller: Controller,
  engagementId: string,
  opts: RunOptions & { maxJobs?: number; max?: number; noReruns?: boolean } = {},
): Promise<QueueResult> {
  const maxJobs = opts.maxJobs ?? opts.max;
  const ran: AttemptOutcome[] = [];
  const skipped: QueueResult['skipped'] = [];
  let held: QueueResult['held'] = [];
  const skip = new Set<string>();
  const done = (stopped: QueueResult['stopped']): QueueResult => ({ ran, stopped, skipped, held });
  // Authorization lifecycle (expired / exhausted / completed) is recorded before and after each job.
  const reconcileBatches = () => controller.system().do(engagementId, 'reconcile_batches', {});
  reconcileBatches();
  for (;;) {
    if (opts.signal?.aborted) return done('aborted');
    if (maxJobs !== undefined && ran.length >= maxJobs) return done('max_jobs');
    const cs = controller.ws.store(engagementId, true).heads('control_state')[0];
    if (cs?.body.paused) return done('paused');
    // Loop L6: pending witness/property reruns are queued under the standing revalidation allowance.
    if (!opts.noReruns) scheduleReruns(controller, engagementId);
    const view = nextJob(controller.ws.store(engagementId, true), controller.now(), skip);
    held = view.held;
    const next = view.next;
    if (!next) return done('idle');
    try {
      ran.push(await runJob(controller, engagementId, next.record_id, opts));
    } catch (e) {
      if (isHarnessError(e, 'budget_exhausted')) return done('budget_exhausted');
      if (isHarnessError(e, 'stop_unconfirmed')) return done('stop_unconfirmed');
      if (isHarnessError(e, 'permission_denied') && /paused/.test((e as Error).message)) return done('paused');
      if (!(e instanceof HarnessError)) throw e;
      skip.add(next.record_id);
      skipped.push({ job: next.record_id, code: e.code, reason: e.message });
    }
    reconcileBatches();
  }
}

/** Runner start: reconcile attempts left running by a previous runner (never re-executes them). */
export function reconcileOnStart(controller: Controller, engagementId: string): { attempt: string; status: string; reason: string }[] {
  return controller.runner().do(engagementId, 'reconcile_attempts', {}).reconciled;
}

// -----------------------------------------------------------------------------------------------
// FR-41: auditor commands through the receipt collector

export interface AuditorCommandPayload {
  /** argv[0]: `forge` (the configured Foundry binary) or an absolute path under /usr. */
  argv: string[];
  description: string;
  /** Snapshot materialized as the writable scratch copy at /work (the target itself stays untouched). */
  snapshot?: Ref | null;
  /** Output directories under /work to hash into the archive. */
  outputs?: string[];
  limits?: Partial<SandboxLimits>;
}

/** Proposed defaults for auditor commands (operator choice). */
export const PROPOSED_AUDITOR_LIMITS: SandboxLimits = { runtime_seconds: 600, output_bytes: 16 * 1024 * 1024, memory_mb: 4096, processes: 256 };

/**
 * Run an auditor-supplied argv in the sandbox and record the result as trusted-runner evidence
 * without a job. The caller must hold an authenticated auditor session.
 */
export async function runAuditorCommand(
  session: Session,
  engagementId: string,
  p: AuditorCommandPayload,
  opts: { sandbox?: Sandbox; keepScratch?: boolean } = {},
): Promise<{ evidence: Ref; eligible: boolean; exit_code: number | null }> {
  if (session.principal.channel !== 'auditor') fail('permission_denied', 'auditor commands come only from the auditor channel');
  if (!Array.isArray(p?.argv) || !p.argv.length || p.argv.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    fail('invalid_request', 'argv must be a non-empty list of strings');
  }
  if (!p.description) fail('invalid_request', 'a description is required');
  const controller = session.controller;
  const ws = controller.ws;
  const sandbox = opts.sandbox ?? defaultSandbox;
  if (!sandbox.available()) fail('unsupported', `${sandbox.kind} sandbox is unavailable; refusing to run without isolation`);
  const store = ws.store(engagementId, true);
  const cs = store.heads('control_state')[0];
  if (cs?.body.paused) fail('permission_denied', 'engagement is paused');

  const binds: Bind[] = [];
  let env: Record<string, string> = { HOME: '/home/sandbox', PATH: '/usr/bin', TMPDIR: '/tmp' };
  let argv = [...p.argv];
  let executable: ExecutionReceipt['executable'];
  if (argv[0] === 'forge') {
    const tc = foundryToolchain(ws);
    if (!tc.forge) fail('unsupported', 'forge is not available');
    binds.push(...tc.binds);
    env = { ...tc.env };
    argv[0] = `${TOOL_ROOT}/foundry/forge`;
    executable = { path: tc.forge, digest: tc.forgeDigest, version: tc.forgeVersion };
  } else {
    if (!argv[0].startsWith('/usr/') || argv[0].includes('..')) fail('invalid_request', 'argv[0] must be forge or an absolute path under /usr');
    executable = { path: argv[0], digest: existsSync(argv[0]) ? digestFile(argv[0]) : null, version: null };
  }

  const dir = join(ws.runsDir, engagementId, `auditor-${randomToken(6)}`);
  mkdirSync(join(dir, 'io'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'work'), { recursive: true, mode: 0o700 });
  try {
    if (p.snapshot) {
      const snap = store.get(p.snapshot, 'target_snapshot');
      materializeTree(store.archive, snap.body.tree.artifact, join(dir, 'work'), true);
    }
    binds.unshift({ src: join(dir, 'work'), dest: '/work', writable: true });
    const limits = { ...PROPOSED_AUDITOR_LIMITS, ...(p.limits ?? {}) };
    const req = { argv, cwd: '/work', binds, env, limits, stdoutPath: join(dir, 'io', 'stdout'), stderrPath: join(dir, 'io', 'stderr') };
    const res = await sandbox.run(req);
    const stdout = store.archive.putFile(req.stdoutPath);
    const stderr = store.archive.putFile(req.stderrPath);
    const outputs: { path: string; artifact: ArtifactRef }[] = [];
    const blobs: string[] = [];
    const missing: string[] = [];
    for (const rel of p.outputs ?? []) {
      const abs = resolve(dir, 'work', rel);
      if (!abs.startsWith(resolve(dir, 'work') + sep) || !existsSync(abs) || !lstatSync(abs).isDirectory()) {
        missing.push(`output ${rel} was not produced`);
        continue;
      }
      const t = putTreeCapped(store.archive, abs, limits.output_bytes);
      outputs.push({ path: relative(join(dir, 'work'), abs), artifact: t.ref });
      blobs.push(...t.blobs);
      if (t.truncated) missing.push(`output ${rel} truncated`);
    }
    const receipt: ExecutionReceipt = {
      runner: RUNNER_IDENTITY,
      sandbox: { kind: sandbox.kind, network: 'denied', descriptor: sandbox.descriptor(req) },
      argv,
      cwd: '/work',
      executable,
      env_keys: Object.keys(env).sort(),
      started_at: res.started_at,
      ended_at: res.ended_at,
      exit_code: res.exit_code,
      signal: res.signal,
      timed_out: res.timed_out,
      stdout,
      stderr,
      stdout_truncated: res.stdout_truncated,
      stderr_truncated: res.stderr_truncated,
      outputs,
    };
    const r = controller.runner().do(engagementId, 'record_auditor_command', {
      receipt,
      description: p.description,
      snapshot: p.snapshot ?? null,
      missing_or_truncated: missing,
      limitations: res.limitations,
      termination: res.termination,
      requested_by: session.principal.principal,
      blobs,
    });
    return { evidence: r.evidence, eligible: r.eligible, exit_code: res.exit_code };
  } finally {
    if (!opts.keepScratch) rmSync(dir, { recursive: true, force: true });
  }
}
