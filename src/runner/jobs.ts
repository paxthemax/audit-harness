import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, HarnessError } from '../core/errors.ts';
import { canonicalJson, digestJson, isDigest } from '../core/hash.ts';
import type { AnyRef, ArtifactRef, Ref } from '../core/refs.ts';
import type { WorkAuthorizationKind } from '../core/values.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import { grantOperationsFor, ROLE_PROFILES, roleProfile } from '../controller/roles.ts';
import type { Workspace } from '../controller/workspace.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type {
  AttemptBody,
  EvidenceArtifactBody,
  ExecutionReceipt,
  JobBody,
  JobPurpose,
  Limits,
  RecordEnvelope,
  StructuredResult,
  WorkAuthorizationBody,
} from '../schema/records.ts';
import { adapterFor, descriptorDigest, type AdapterDescriptor } from './adapters.ts';
import { completionHooks } from './hooks.ts';
import { loadContextManifest } from './context.ts';
import { validateSourceEdit } from './sourceEdit.ts';
import { ProviderBroker } from './provider.ts';
import { releaseUnexecutedCalls, reserve, settleAttempt } from './ledger.ts';
import { identityAlive, terminateRecorded, type ProcessIdentity } from './sandbox.ts';

// Jobs, attempts and execution control (design/harness-state-and-execution.md, "Durable jobs and
// resource limits"; walking skeleton, DEC-008 Q-020). A logical job has immutable input identity;
// identical input is retried as a new attempt of the same job, changed input is a new job linked by
// lineage. Every attempt reserves its maximum allocation before dispatch, the dispatch intent is
// persisted before spawning, and completion commits once per attempt. Jobs run one at a time per
// workspace; pause and cancel terminate the attempt's process group.
//
// Operations here are synchronous controller transitions. The asynchronous part (preparing scratch,
// running the sandbox, staging blobs) lives in runner.ts and reports back on the runner channel.

/** Work-authorization kinds that admit each job purpose. */
export const KINDS_FOR_PURPOSE: Record<JobPurpose, WorkAuthorizationKind[]> = {
  // A new snapshot is rebuilt and its suite rerun under the standing revalidation allowance (loop L6).
  build: ['intake', 'revalidation'],
  baseline_tests: ['intake', 'revalidation'],
  inventory: ['intake', 'revalidation'],
  experiment: ['batch'],
  replay: ['batch'],
  positive_control: ['batch'],
  adequacy: ['batch'],
  probe: ['revalidation'],
  agent: ['intake', 'exploration', 'batch', 'revalidation', 'method_evaluation'],
};

/** Proposed per-job runtime cap when a request names none (numeric limits are operator choices). */
export const PROPOSED_JOB_RUNTIME_SECONDS = 600;
/** Proposed time a grant outlives its runtime limit, for outbox ingestion. */
export const PROPOSED_GRANT_MARGIN_SECONDS = 300;

const ACTIVE: AttemptBody['status'][] = ['queued', 'running'];

// -----------------------------------------------------------------------------------------------
// Shared checks

export function attemptDir(ws: Workspace, engagementId: string, attemptId: string): string {
  return join(ws.runsDir, engagementId, attemptId);
}

export interface SupervisorRecord extends ProcessIdentity {
  runner_pid: number;
}

/** Supervisor-written process identity for an attempt (never guest-written). */
export function readSupervisor(ws: Workspace, engagementId: string, attemptId: string): SupervisorRecord | null {
  const p = join(attemptDir(ws, engagementId, attemptId), 'supervisor.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SupervisorRecord;
  } catch {
    return null;
  }
}

function recordedIdentity(ctx: OpContext, att: RecordEnvelope<'attempt'>): ProcessIdentity | null {
  const sup = readSupervisor(ctx.ws, ctx.store.scope, att.record_id);
  if (sup) return sup;
  return att.body.pid ? { pid: att.body.pid, pgid: att.body.pid, start_time: null } : null;
}

export function controlState(store: RecordStore): RecordEnvelope<'control_state'> {
  const cs = store.heads('control_state')[0];
  if (!cs) fail('not_found', 'control state missing for this engagement');
  return cs;
}

function requireNotPaused(store: RecordStore): void {
  const cs = controlState(store);
  if (cs.body.paused) fail('permission_denied', `engagement is paused (${cs.body.reason}); no new work is dispatched`);
}

/** The authorization must be current, active and inside its validity window. */
export function currentAuthorization(ctx: OpContext, r: Ref | string): { ref: Ref; body: WorkAuthorizationBody } {
  const id = typeof r === 'string' ? r : r.record_id;
  const head = ctx.store.mustHead(id, 'work_authorization');
  if (typeof r !== 'string' && r.revision !== head.revision) {
    fail('stale_dependency', `work authorization ${id} is at revision ${head.revision}, not ${r.revision}`, { ref: r });
  }
  const b = head.body;
  if (b.status !== 'active') fail('grant_expired', `work authorization ${id} is ${b.status}`, { ref: id });
  const now = Date.parse(ctx.now);
  if (b.validity && (now < Date.parse(b.validity.from) || now > Date.parse(b.validity.until))) {
    fail('grant_expired', `work authorization ${id} is outside its validity window`, { ref: id });
  }
  return { ref: { record_id: id, revision: head.revision }, body: b };
}

/** An investigation's premise is affected while its latest freshness record says so without a decision. */
export function premiseAffected(store: RecordStore, investigationId: string): boolean {
  const recs = store.heads('conclusion_freshness').filter((f) => f.body.conclusion.record_id === investigationId);
  const latest = recs[recs.length - 1];
  return !!latest && latest.body.value === 'affected' && latest.body.decision === null;
}

function requirePremise(store: RecordStore, investigation: Ref | null): void {
  if (investigation && premiseAffected(store, investigation.record_id)) {
    fail('stale_dependency', `investigation ${investigation.record_id} depends on an affected premise; no new iteration is dispatched on it`);
  }
}

function runningAttemptsInWorkspace(ws: Workspace): { engagement: string; attempt: RecordEnvelope<'attempt'> }[] {
  const out: { engagement: string; attempt: RecordEnvelope<'attempt'> }[] = [];
  for (const eid of ws.engagementIds()) {
    for (const a of ws.store(eid, true).heads('attempt')) if (a.body.status === 'running') out.push({ engagement: eid, attempt: a });
  }
  return out;
}

function refOf(env: { record_id: string; revision: number }): Ref {
  return { record_id: env.record_id, revision: env.revision };
}

function sameId(a: Ref | null | undefined, b: Ref | null | undefined): boolean {
  return !!a && !!b && a.record_id === b.record_id;
}

/** Remaining runnable (queued or running) jobs of an investigation, ignoring `exceptJob`. */
function runnableJobs(ctx: OpContext, investigationId: string, exceptJob: string): number {
  return ctx.store
    .heads('job')
    .filter((j) => j.record_id !== exceptJob && sameId(j.body.investigation, { record_id: investigationId, revision: 1 }))
    .filter((j) => ACTIVE.includes(ctx.tx.current(j.record_id, 'job').body.status)).length;
}

function linkJobToInvestigation(ctx: OpContext, investigation: Ref | null, job: Ref, variant: Ref | null): void {
  if (investigation) {
    const inv = ctx.tx.current(investigation.record_id, 'investigation');
    if (!inv.body.jobs.some((j) => j.record_id === job.record_id)) {
      ctx.tx.revise(investigation.record_id, 'investigation', (b) => ({ ...b, jobs: [...b.jobs, job] }));
    }
  }
  if (variant) {
    const v = ctx.tx.current(variant.record_id, 'scenario_variant');
    if (!v.body.jobs.some((j) => j.record_id === job.record_id)) {
      ctx.tx.revise(variant.record_id, 'scenario_variant', (b) => ({ ...b, jobs: [...b.jobs, job] }));
    }
  }
}

function markInvestigationRunning(ctx: OpContext, investigation: Ref | null): void {
  if (!investigation) return;
  const inv = ctx.tx.current(investigation.record_id, 'investigation');
  if (inv.body.work_state === 'queued' || inv.body.work_state === 'blocked') {
    ctx.tx.revise(investigation.record_id, 'investigation', (b) => ({ ...b, work_state: 'running', blocked_reason: null }));
  }
}

/** A failed or cancelled job leaves its investigation `blocked` (never "refuted") when nothing else can run. */
function blockInvestigationIfIdle(ctx: OpContext, job: RecordEnvelope<'job'> | { record_id: string; body: JobBody }, reason: string): void {
  const inv = job.body.investigation;
  if (!inv) return;
  if (runnableJobs(ctx, inv.record_id, job.record_id) > 0) return;
  const cur = ctx.tx.current(inv.record_id, 'investigation');
  if (cur.body.work_state === 'closed' || cur.body.work_state === 'ready_for_review') return;
  ctx.tx.revise(inv.record_id, 'investigation', (b) => ({ ...b, work_state: 'blocked', blocked_reason: reason }));
}

function newAttempt(ctx: OpContext, job: Ref, attempt_no: number): Ref {
  return ctx.tx.create('attempt', {
    job,
    attempt_no,
    status: 'queued',
    started_at: null,
    ended_at: null,
    pid: null,
    reason: null,
    receipt: null,
    actual: { spend: null, runtime_seconds: null, spend_uncertain: false },
    termination: 'not_applicable',
    grant: null,
  });
}

function elapsedSeconds(from: string | null, to: string): number {
  if (!from) return 0;
  return Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
}

// -----------------------------------------------------------------------------------------------
// request_job

/** The requested adapter mode, or `unsupported` (never a silent fallback to another mode). */
export function requireMode(descriptor: AdapterDescriptor, operation: string | undefined): string {
  const mode = operation ?? descriptor.modes[0];
  if (!descriptor.modes.includes(mode)) fail('unsupported', `adapter ${descriptor.name} has no mode ${mode}`, { details: { modes: descriptor.modes } });
  return mode;
}

export interface RequestJobPayload {
  authorization: Ref | string;
  purpose: JobPurpose;
  adapter: string;
  operation?: string;
  args?: Record<string, unknown>;
  snapshot: Ref;
  fixture?: ArtifactRef | null;
  investigation?: Ref | null;
  variant?: Ref | null;
  context_manifest?: ArtifactRef | null;
  role?: string;
  limits?: Partial<Limits>;
  guard_removal?: { path: string; find: string; replace: string } | null;
  /** The earlier job this one changes (fixture repair, positive control); required for changed input. */
  lineage?: Ref | null;
}

const LIMIT_KEYS: (keyof Limits)[] = [
  'spend',
  'runtime_seconds',
  'concurrency',
  'child_tasks',
  'rounds',
  'retries',
  'repairs_per_variant',
  'output_bytes',
  'memory_mb',
  'processes',
];

function jobLimits(auth: Limits, req: Partial<Limits> = {}): Limits {
  const out = { ...auth };
  for (const k of LIMIT_KEYS) {
    const v = req[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !(v >= 0)) fail('invalid_request', `limit ${k} must be a non-negative number`);
    if (v > auth[k]) fail('permission_denied', `limit ${k}=${v} exceeds the authorization's ${auth[k]}`);
    out[k] = v;
  }
  if (req.runtime_seconds === undefined) out.runtime_seconds = Math.min(auth.runtime_seconds, PROPOSED_JOB_RUNTIME_SECONDS);
  return out;
}

defineOperation<RequestJobPayload>({
  name: 'request_job',
  channels: ['auditor', 'worker', 'controller'],
  mutating: true,
  handler(ctx, p) {
    if (!p || typeof p !== 'object') fail('invalid_request', 'payload required');
    if (!p.authorization || !p.purpose || !p.adapter || !p.snapshot) fail('invalid_request', 'authorization, purpose, adapter and snapshot are required');
    if (!(p.purpose in KINDS_FOR_PURPOSE)) fail('invalid_request', `unknown job purpose ${p.purpose}`);
    requireNotPaused(ctx.store);
    const auth = currentAuthorization(ctx, p.authorization);
    if (!KINDS_FOR_PURPOSE[p.purpose].includes(auth.body.kind)) {
      fail('permission_denied', `a ${auth.body.kind} authorization does not admit ${p.purpose} jobs`);
    }
    const investigation = p.investigation ?? null;
    const variant = p.variant ?? null;

    // Worker requests stay inside the granted investigation question.
    if (ctx.principal.channel === 'worker') {
      const g = ctx.principal.grant!;
      if (g.authorization.record_id !== auth.ref.record_id) fail('permission_denied', 'a worker may only request work under its own authorization');
      if ((g.investigation?.record_id ?? null) !== (investigation?.record_id ?? null)) {
        fail('permission_denied', 'outside the granted investigation question; a new question goes through authorize_work');
      }
      if (p.purpose === 'agent') {
        // A child task runs with the requesting worker's own role: no escalation to another profile.
        if (p.role !== undefined && p.role !== g.role) fail('permission_denied', `a ${g.role} worker cannot request a ${p.role} job`);
        const children = ctx.store
          .heads('job')
          .filter((j) => j.body.purpose === 'agent' && sameId(j.body.investigation, investigation) && ctx.store.history(j.record_id)[0].created_by.channel === 'worker');
        if (children.length >= auth.body.limits.child_tasks) fail('budget_exhausted', `child-task limit ${auth.body.limits.child_tasks} reached`);
      }
    }

    // Deterministic tool jobs run as the `tool` role (no grant operations); agent jobs name their role.
    const role = p.role ?? (p.purpose === 'agent' ? (ctx.principal.channel === 'worker' ? ctx.principal.grant!.role : null) : 'tool');
    if (!role || !ROLE_PROFILES[role]) fail('invalid_request', `job role ${role ?? '(none)'} is not a defined role profile`);

    // Agent jobs run with a context manifest the context builder made for their role (and question).
    let contextManifest: ArtifactRef | null = p.context_manifest ?? null;
    if (p.purpose === 'agent') {
      if (!contextManifest && ctx.principal.channel === 'worker') contextManifest = ctx.store.get(ctx.principal.grant!.job, 'job').body.context_manifest;
      if (!contextManifest) fail('invalid_request', 'agent jobs carry a context manifest built by the context builder');
      const view = loadContextManifest(ctx.store, contextManifest);
      const expected = roleProfile(role).contextRole;
      if (view.role !== expected) fail('invalid_request', `the context manifest was built for role ${view.role}, not ${expected}`);
      if (investigation && view.investigation?.record_id !== investigation.record_id) fail('invalid_request', 'the context manifest was built for another investigation');
      const model = (p.args ?? {}).model;
      if (typeof model === 'string') {
        if (!auth.body.capabilities.providers.length) fail('permission_denied', 'the authorization approves no provider for agent model calls');
        const broker = ProviderBroker.active();
        if (broker && !auth.body.capabilities.providers.some((n) => broker.provider(n)?.models.includes(model))) {
          fail('permission_denied', `model ${model} is not offered by a provider this authorization approves`);
        }
      }
    }

    if (auth.body.kind === 'batch' && !investigation) fail('invalid_request', `${p.purpose} jobs under a batch authorization need an investigation`);
    if (investigation) {
      ctx.store.get(investigation, 'investigation');
      const invHead = ctx.store.mustHead(investigation.record_id, 'investigation').body;
      if (invHead.disposition !== null || invHead.work_state === 'closed') {
        fail('invalid_request', `investigation ${investigation.record_id} is ${invHead.disposition ? `disposed (${invHead.disposition.value})` : 'closed'}; no new jobs run on it`);
      }
      if (auth.body.kind === 'batch' && !auth.body.investigations.some((i) => i.record_id === investigation.record_id)) {
        fail('permission_denied', `investigation ${investigation.record_id} is not admitted by authorization ${auth.ref.record_id}`);
      }
      requirePremise(ctx.store, investigation);
    }
    if (variant) {
      const v = ctx.store.get(variant, 'scenario_variant');
      if (!sameId(v.body.investigation, investigation)) fail('invalid_request', 'the variant belongs to another investigation');
    }
    const snapshot = ctx.store.get(p.snapshot, 'target_snapshot');
    if (auth.body.snapshot && auth.body.snapshot.record_id !== snapshot.record_id) {
      fail('permission_denied', `authorization ${auth.ref.record_id} covers snapshot ${auth.body.snapshot.record_id}`);
    }

    if (!auth.body.capabilities.tools.includes(p.adapter)) {
      fail('permission_denied', `tool ${p.adapter} is not within the authorization's capabilities`);
    }
    const adapter = adapterFor(ctx.ws, p.adapter);
    const descriptor = adapter.descriptor();
    if (!descriptor.purposes.includes(p.purpose)) fail('unsupported', `adapter ${p.adapter} does not support ${p.purpose} jobs`);
    const args = p.args ?? {};
    adapter.validate(args);
    const operation = requireMode(descriptor, p.operation);

    for (const a of [p.fixture, contextManifest]) {
      if (!a) continue;
      if (!isDigest(a.artifact)) fail('invalid_request', 'artifact references name a sha256 digest');
      ctx.archive.get(a.artifact);
    }
    if (p.fixture) ctx.archive.getTree(p.fixture.artifact);
    const guard = p.guard_removal ?? null;
    const sourceEdit = p.purpose === 'positive_control' || p.purpose === 'adequacy';
    if (guard && !sourceEdit) fail('invalid_request', 'guard removal (a source edit on a disposable copy) is only for positive-control and adequacy jobs');
    // Intake jobs describe the target itself: never a fixture or an edit.
    if (['build', 'inventory', 'baseline_tests'].includes(p.purpose) && (p.fixture || guard)) {
      fail('invalid_request', `${p.purpose} jobs run on the snapshot as registered: no fixture and no source edit`);
    }
    if (guard) validateSourceEdit(ctx.archive, snapshot.body.tree.artifact, p.fixture?.artifact ?? null, guard, p.purpose);
    if (sourceEdit) {
      // A positive control reruns the lineage experiment with the cited guard removed; an adequacy job
      // reruns the lineage property campaign with a reviewed fault injected. Only the edit differs.
      const what = p.purpose === 'positive_control' ? 'a positive control' : 'an adequacy job';
      if (!guard) fail('invalid_request', `${what} needs guard_removal (the source edit)`);
      if (!p.lineage) fail('invalid_request', `${what} names the job it checks in lineage`);
      const ctl = ctx.store.mustHead(p.lineage.record_id, 'job').body;
      const allowed = p.purpose === 'positive_control' ? ['experiment', 'replay'] : ['experiment'];
      if (!allowed.includes(ctl.purpose)) fail('invalid_request', `${what} checks a job of purpose ${allowed.join(' or ')}, not ${ctl.purpose}`);
      if (!sameId(ctl.investigation, investigation)) fail('invalid_request', 'the checked job belongs to another investigation');
      const same =
        ctl.adapter.name === descriptor.name &&
        ctl.operation === operation &&
        canonicalJson(ctl.args) === canonicalJson(args) &&
        canonicalJson(ctl.fixture) === canonicalJson(p.fixture ?? null) &&
        ctl.snapshot.record_id === snapshot.record_id &&
        (ctl.variant?.record_id ?? null) === (variant?.record_id ?? null);
      if (!same) fail('invalid_request', `${what} must match the checked job (adapter, operation, args, fixture, snapshot, variant); only the source edit differs`);
    }

    const descRef = ctx.archive.putJson(descriptor);
    ctx.tx.blob(descRef);
    const input_digest = digestJson({
      adapter: descriptorDigest(descriptor),
      operation,
      args,
      purpose: p.purpose,
      snapshot: refOf(snapshot),
      fixture: p.fixture ?? null,
      guard_removal: guard,
      context_manifest: contextManifest ?? null,
      investigation: investigation?.record_id ?? null,
      variant: variant?.record_id ?? null,
      role,
    });

    // Identical input: an attempt of the existing job (retry), not a new job.
    const existing = ctx.store
      .heads('job')
      .filter((j) => j.body.input_digest === input_digest)
      .pop();
    if (existing) {
      if (ACTIVE.includes(existing.body.status)) {
        return { job: refOf(existing), attempt: existing.body.attempts[existing.body.attempts.length - 1], input_digest, retry: false, duplicate: true };
      }
      const counted = existing.body.attempts.filter((a) => ctx.store.mustHead(a.record_id, 'attempt').body.status !== 'cancelled').length;
      if (counted >= 1 + existing.body.limits.retries) {
        fail('budget_exhausted', `job ${existing.record_id} reached its retry limit (${existing.body.limits.retries})`);
      }
      const attempt = newAttempt(ctx, refOf(existing), existing.body.attempts.length + 1);
      reserve(ctx, auth, attempt, existing.body.reservation, `reservation for ${existing.record_id} attempt ${existing.body.attempts.length + 1} (retry)`);
      ctx.tx.revise(existing.record_id, 'job', (b) => ({ ...b, status: 'queued', attempts: [...b.attempts, attempt] }));
      linkJobToInvestigation(ctx, investigation, { record_id: existing.record_id, revision: 1 }, variant);
      ctx.tx.event('job_retry_queued', { job: existing.record_id, attempt });
      return { job: { record_id: existing.record_id, revision: existing.revision + 1 }, attempt, input_digest, retry: true };
    }

    // Agent jobs are rounds (FR-29): each new logical agent job under an authorization is one round;
    // retries of identical input (above) are attempts, not rounds.
    if (p.purpose === 'agent') {
      const rounds = ctx.store.heads('job').filter((j) => j.body.purpose === 'agent' && j.body.authorization.record_id === auth.ref.record_id).length;
      if (rounds + 1 > auth.body.limits.rounds) fail('budget_exhausted', `round limit reached: ${rounds} of ${auth.body.limits.rounds} agent rounds used under ${auth.ref.record_id}`);
    }

    // Changed input: a new job linked by lineage; fixture repairs are bounded per variant.
    const lineage = p.lineage ?? null;
    if (lineage) {
      const prev = ctx.store.get(lineage, 'job');
      if (!sameId(prev.body.investigation, investigation)) fail('invalid_request', 'lineage must stay within the investigation');
      if (variant && p.purpose !== 'positive_control' && p.purpose !== 'adequacy') {
        const repairs = ctx.store
          .heads('job')
          .filter((j) => sameId(j.body.variant, variant) && j.body.lineage !== null && j.body.purpose !== 'positive_control' && j.body.purpose !== 'adequacy').length;
        if (repairs >= auth.body.limits.repairs_per_variant) {
          fail('budget_exhausted', `repair limit ${auth.body.limits.repairs_per_variant} reached for variant ${variant.record_id}`);
        }
      }
    }
    const limits = jobLimits(auth.body.limits, p.limits);
    const reservation = { spend: 0, runtime_seconds: limits.runtime_seconds };
    const deps: AnyRef[] = [refOf(snapshot)];
    if (p.fixture) deps.push(p.fixture);
    if (contextManifest) deps.push(contextManifest);
    const jobBody: JobBody = {
      authorization: auth.ref,
      context_manifest: contextManifest ?? null,
      role,
      purpose: p.purpose,
      adapter: { name: descriptor.name, version: descriptor.version, descriptor: descRef.artifact },
      operation,
      args,
      snapshot: refOf(snapshot),
      fixture: p.fixture ?? null,
      input_digest,
      investigation,
      variant,
      limits,
      reservation,
      lineage,
      guard_removal: guard,
      status: 'queued',
      attempts: [],
    };
    const nextJobId = ctx.store.peekNextId('job');
    const jobRef: Ref = { record_id: nextJobId, revision: 1 };
    const attempt = newAttempt(ctx, jobRef, 1);
    jobBody.attempts = [attempt];
    const created = ctx.tx.create('job', jobBody, deps);
    if (created.record_id !== nextJobId) throw new HarnessError('invalid_request', 'job identity could not be reserved');
    reserve(ctx, auth, attempt, reservation, `reservation for ${created.record_id} attempt 1`);
    linkJobToInvestigation(ctx, investigation, created, variant);
    ctx.tx.event('job_queued', { job: created, purpose: p.purpose });
    return { job: created, attempt, input_digest, retry: false };
  },
});

// -----------------------------------------------------------------------------------------------
// start_attempt / record_attempt_pid (runner channel)

export interface StartAttemptPayload {
  job: string;
  /** Digest of the per-attempt worker token; the token itself never reaches the store. */
  grant_digest: string;
}

defineOperation<StartAttemptPayload>({
  name: 'start_attempt',
  channels: ['runner'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.job || !isDigest(p.grant_digest)) fail('invalid_request', 'job and grant_digest are required');
    requireNotPaused(ctx.store);
    const cs = controlState(ctx.store);
    const unconfirmed = cs.body.stopped.filter((s) => s.termination === 'unconfirmed');
    if (unconfirmed.length) {
      fail('stop_unconfirmed', 'a stopped attempt has no confirmed termination; replacement work is refused', { details: { attempts: unconfirmed } });
    }
    const running = runningAttemptsInWorkspace(ctx.ws);
    if (running.length) {
      fail('permission_denied', `one job at a time: attempt ${running[0].attempt.record_id} is running`, { details: { running: running.map((r) => r.attempt.record_id) } });
    }
    const job = ctx.store.mustHead(p.job, 'job');
    if (job.body.status !== 'queued') fail('invalid_request', `job ${p.job} is ${job.body.status}, not queued`);
    const auth = currentAuthorization(ctx, job.body.authorization.record_id);
    requirePremise(ctx.store, job.body.investigation);

    let attemptRef = job.body.attempts[job.body.attempts.length - 1];
    const latest = ctx.store.mustHead(attemptRef.record_id, 'attempt');
    if (latest.body.status !== 'queued') {
      // Interrupted earlier (paused): a fresh attempt with its own reservation.
      attemptRef = newAttempt(ctx, refOf(job), job.body.attempts.length + 1);
      reserve(ctx, auth, attemptRef, job.body.reservation, `reservation for ${job.record_id} attempt ${job.body.attempts.length + 1} (resumed)`);
      ctx.tx.revise(job.record_id, 'job', (b) => ({ ...b, attempts: [...b.attempts, attemptRef] }));
    }
    const expires = new Date(Date.parse(ctx.now) + (job.body.limits.runtime_seconds + PROPOSED_GRANT_MARGIN_SECONDS) * 1000).toISOString();
    const att = ctx.tx.revise(attemptRef.record_id, 'attempt', (b) => ({
      ...b,
      status: 'running',
      started_at: ctx.now,
      grant: { digest: p.grant_digest, operations: grantOperationsFor(job.body.role), expires_at: expires, revoked: false },
    }));
    ctx.tx.revise(job.record_id, 'job', (b) => ({ ...b, status: 'running' }));
    markInvestigationRunning(ctx, job.body.investigation);
    ctx.tx.event('attempt_dispatched', { job: job.record_id, attempt: att });
    return { job: job.record_id, attempt: att, expires_at: expires };
  },
});

defineOperation<{ attempt: string; pid: number }>({
  name: 'record_attempt_pid',
  channels: ['runner'],
  mutating: true,
  handler(ctx, p) {
    const att = ctx.store.mustHead(p.attempt, 'attempt');
    if (att.body.status !== 'running') fail('permission_denied', `attempt ${p.attempt} is ${att.body.status}; stop the process`);
    if (!Number.isInteger(p.pid) || p.pid <= 0) fail('invalid_request', 'pid must be a positive integer');
    return { attempt: ctx.tx.revise(p.attempt, 'attempt', (b) => ({ ...b, pid: p.pid })) };
  },
});

// -----------------------------------------------------------------------------------------------
// complete_attempt (runner channel)

export interface OutboxOutcome {
  file: string;
  operation: string | null;
  status: 'committed' | 'refused' | 'invalid';
  code: string | null;
  reason: string | null;
  records: Ref[];
  /** Digest of the payload after placeholder resolution (null when it never resolved). */
  payload_digest?: string | null;
}

export interface CompleteAttemptPayload {
  attempt: string;
  /** Preparation failed before anything ran (no receipt, no evidence). */
  not_run?: string | null;
  run?: {
    receipt: ExecutionReceipt;
    result: StructuredResult;
    failed: string | null;
    missing_or_truncated: string[];
    limitations: string[];
    /** null: no environment scanner ran. */
    environment_reads: string[] | null;
    termination: AttemptBody['termination'];
    /** Every archive blob the receipt reaches (tree manifests and their members). */
    blobs: string[];
    /** The guest attempted network access, which the sandbox denied. */
    egress_denied?: boolean;
  };
  outbox?: OutboxOutcome[];
}

/** One canonical completion per attempt: a receipt or a terminal status ends it. */
function completionDone(att: RecordEnvelope<'attempt'>): boolean {
  return att.body.receipt !== null || ['completed', 'failed', 'outcome_unknown'].includes(att.body.status);
}

defineOperation<CompleteAttemptPayload>({
  name: 'complete_attempt',
  channels: ['runner'],
  mutating: true,
  handler(ctx, p) {
    const att = ctx.store.mustHead(p?.attempt, 'attempt');
    if (completionDone(att)) {
      const ev = ctx.store.heads('evidence_artifact').find((e) => e.body.attempt?.record_id === att.record_id);
      return { attempt: refOf(att), evidence: ev ? refOf(ev) : null, status: att.body.status, duplicate: true };
    }
    if (att.body.status === 'queued') fail('invalid_request', `attempt ${att.record_id} never started`);
    const job = ctx.store.get(att.body.job, 'job');
    const jobHead = ctx.store.mustHead(job.record_id, 'job');
    const stopped = att.body.status === 'cancelled';
    const run = p.run ?? null;

    let status: AttemptBody['status'];
    let reason: string | null;
    if (stopped) {
      status = 'cancelled';
      reason = att.body.reason;
    } else if (!run) {
      status = 'failed';
      reason = `not run: ${p.not_run ?? 'no execution reported'}`;
    } else if (run.failed) {
      status = 'failed';
      reason = run.failed;
    } else {
      status = 'completed';
      reason = null;
    }
    if (run?.egress_denied && !stopped) reason = `egress_denied: network access attempted and denied${reason ? `; ${reason}` : ''}`;

    let evidence: Ref | null = null;
    let evidenceBody: EvidenceArtifactBody | null = null;
    if (run) {
      const r = run.receipt;
      const blobs = [r.stdout.artifact, r.stderr.artifact, ...r.outputs.map((o) => o.artifact.artifact), ...run.blobs];
      for (const d of blobs) {
        ctx.archive.get(d); // present and matching its hash, or artifact_incomplete / integrity_failure
        ctx.tx.blob(d);
      }
      const missing = [...run.missing_or_truncated];
      if (r.stdout_truncated) missing.push('stdout truncated at the output limit');
      if (r.stderr_truncated) missing.push('stderr truncated at the output limit');
      if (stopped) missing.push(`attempt stopped before completion (${att.body.reason ?? 'stopped'})`);
      const termination = att.body.termination !== 'not_applicable' ? att.body.termination : run.termination;
      if (termination === 'unconfirmed') missing.push('process termination unconfirmed');
      const limitations = [...run.limitations];
      if (run.environment_reads === null) limitations.push('environment-read scan not run (no scanner registered)');
      const complete = status === 'completed' && missing.length === 0;
      const content = ctx.archive.putJson({ format: 'harness.result/1', receipt: r, structured_result: run.result, missing_or_truncated: missing });
      ctx.tx.blob(content);
      evidenceBody = {
        content,
        producer: 'trusted_runner',
        job: refOf(jobHead),
        attempt: refOf(att),
        receipt: r,
        snapshot: job.body.snapshot,
        fixture: job.body.fixture,
        structured_result: run.result,
        environment_sensitive: { flagged: (run.environment_reads ?? []).length > 0, reads: run.environment_reads ?? [] },
        // The controlled experiment is the job's lineage; the decision layer binds the control to it.
        positive_control_for: job.body.purpose === 'positive_control' ? job.body.investigation : null,
        missing_or_truncated: missing,
        limitations,
        // Incomplete receipts and errors (compile failures, crashes) are never eligible evidence.
        eligible: complete && run.result.result_type !== 'error',
        description: `${job.body.purpose} job ${job.record_id} attempt ${att.body.attempt_no} via ${job.body.adapter.name} (${run.result.result_type})`,
      };
      const deps: AnyRef[] = [job.body.snapshot];
      if (job.body.fixture) deps.push(job.body.fixture);
      evidence = ctx.tx.create('evidence_artifact', evidenceBody, deps);
    }

    const outbox = p.outbox ?? [];
    const refused = outbox.filter((o) => o.status !== 'committed');
    if (evidenceBody && refused.length) {
      // Recorded on the evidence too, so packets see what the worker attempted.
      evidenceBody.limitations.push(...refused.map((o) => `worker request ${o.file} (${o.operation ?? 'unparsed'}) refused: ${o.code ?? 'invalid'}`));
    }
    for (const o of refused) ctx.tx.event('worker_request_refused', { attempt: att.record_id, ...o });

    const ended = run?.receipt.ended_at ?? ctx.now;
    const runtime = run ? elapsedSeconds(run.receipt.started_at, run.receipt.ended_at) : 0;
    const attRef = ctx.tx.revise(att.record_id, 'attempt', (b) => ({
      ...b,
      status,
      ended_at: b.ended_at ?? ended,
      reason: stopped ? (run?.egress_denied ? `${b.reason}; egress_denied` : b.reason) : reason,
      receipt: evidence,
      actual: { spend: 0, runtime_seconds: runtime, spend_uncertain: false },
      termination: b.termination !== 'not_applicable' ? b.termination : (run?.termination ?? 'not_applicable'),
      grant: b.grant ? { ...b.grant, revoked: true } : null,
    }));
    settleAttempt(ctx, job.body.authorization, refOf(att), { spend: 0, runtime_seconds: runtime }, `actual for ${job.record_id} attempt ${att.body.attempt_no}`);
    const releasedCalls = releaseUnexecutedCalls(ctx, refOf(att));
    if (releasedCalls.length) ctx.tx.event('provider_reservations_released', { attempt: att.record_id, calls: releasedCalls });

    let jobBody = jobHead.body;
    let jobRevision = jobHead.revision;
    if (!stopped) {
      const r = ctx.tx.revise(job.record_id, 'job', (b) => ({ ...b, status }));
      jobBody = { ...jobHead.body, status };
      jobRevision = r.revision;
      if (status === 'failed') blockInvestigationIfIdle(ctx, { record_id: job.record_id, body: jobBody }, `job ${job.record_id} failed: ${reason}`);
    }
    if (job.body.investigation) linkJobToInvestigation(ctx, job.body.investigation, { record_id: job.record_id, revision: 1 }, job.body.variant);

    const doneJob: RecordEnvelope<'job'> = { ...jobHead, revision: jobRevision, body: jobBody };
    for (const hook of completionHooks(job.body.purpose)) hook(ctx, { job: doneJob, attempt: attRef, evidence, evidenceBody });

    ctx.tx.event('execution_completed', { job: job.record_id, attempt: attRef, status });
    if (run?.egress_denied) ctx.tx.event('egress_denied', { job: job.record_id, attempt: attRef });
    if (evidence && evidenceBody?.eligible) ctx.tx.event('evidence_eligible', { evidence });
    return { attempt: attRef, evidence, status, eligible: evidenceBody?.eligible ?? false, refused_requests: refused.length, released_calls: releasedCalls };
  },
});

// -----------------------------------------------------------------------------------------------
// pause / cancel / resume

function stopAttempt(ctx: OpContext, att: RecordEnvelope<'attempt'>, reason: string): 'confirmed' | 'unconfirmed' | 'not_applicable' {
  let termination: 'confirmed' | 'unconfirmed' | 'not_applicable' = 'not_applicable';
  if (att.body.status === 'running') {
    const identity = recordedIdentity(ctx, att);
    // No recorded process yet: the runner refuses to spawn (or kills) once it sees the stop, but
    // termination stays unconfirmed until resume re-checks.
    termination = identity ? terminateRecorded(identity) : 'unconfirmed';
  }
  const job = ctx.store.get(att.body.job, 'job');
  ctx.tx.revise(att.record_id, 'attempt', (b) => ({
    ...b,
    status: 'cancelled',
    ended_at: ctx.now,
    reason,
    termination,
    grant: b.grant ? { ...b.grant, revoked: true } : null,
  }));
  settleAttempt(ctx, job.body.authorization, refOf(att), { spend: 0, runtime_seconds: elapsedSeconds(att.body.started_at, ctx.now) }, `${reason} (${att.record_id})`);
  return termination;
}

defineOperation<{ reason: string }>({
  name: 'pause',
  channels: ['auditor', 'screen', 'controller'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.reason) fail('invalid_request', 'a reason is required');
    const cs = controlState(ctx.store);
    const stopped: { attempt: Ref; termination: 'confirmed' | 'unconfirmed' }[] = [];
    for (const att of ctx.store.heads('attempt').filter((a) => a.body.status === 'running')) {
      const t = stopAttempt(ctx, att, `paused: ${p.reason}`);
      stopped.push({ attempt: refOf(att), termination: t === 'unconfirmed' ? 'unconfirmed' : 'confirmed' });
      // The interrupted job returns to the queue; it runs again only after an explicit resume.
      ctx.tx.revise(att.body.job.record_id, 'job', (b) => ({ ...b, status: 'queued' }));
    }
    ctx.tx.revise(cs.record_id, 'control_state', (b) => ({
      paused: true,
      reason: p.reason,
      by: ctx.principal.channel === 'controller' ? 'controller_policy' : 'auditor',
      stopped: [...(b.paused ? b.stopped : []), ...stopped],
    }));
    ctx.tx.event('paused', { stopped });
    return { paused: true, stopped };
  },
});

defineOperation<{ job: string; reason: string }>({
  name: 'cancel',
  channels: ['auditor', 'screen', 'controller'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.job || !p.reason) fail('invalid_request', 'job and reason are required');
    const job = ctx.store.mustHead(p.job, 'job');
    if (!ACTIVE.includes(job.body.status)) fail('invalid_request', `job ${p.job} is already ${job.body.status}`);
    const stopped: { attempt: Ref; termination: 'confirmed' | 'unconfirmed' }[] = [];
    for (const a of job.body.attempts) {
      const att = ctx.store.mustHead(a.record_id, 'attempt');
      if (!ACTIVE.includes(att.body.status)) continue;
      const t = stopAttempt(ctx, att, `cancelled: ${p.reason}`);
      if (t !== 'not_applicable') stopped.push({ attempt: refOf(att), termination: t });
    }
    ctx.tx.revise(job.record_id, 'job', (b) => ({ ...b, status: 'cancelled' }));
    blockInvestigationIfIdle(ctx, job, `job ${job.record_id} cancelled: ${p.reason}`);
    const unconfirmed = stopped.filter((s) => s.termination === 'unconfirmed');
    if (unconfirmed.length) {
      const cs = controlState(ctx.store);
      ctx.tx.revise(cs.record_id, 'control_state', (b) => ({ ...b, stopped: [...b.stopped, ...unconfirmed] }));
    }
    ctx.tx.event('job_cancelled', { job: job.record_id, stopped });
    return { job: job.record_id, cancelled: true, stopped };
  },
});

/** Reconcile attempts left `running` without a live supervisor. Never re-executes anything. */
function reconcile(ctx: OpContext): { attempt: string; status: string; reason: string }[] {
  const out: { attempt: string; status: string; reason: string }[] = [];
  for (const att of ctx.store.heads('attempt').filter((a) => a.body.status === 'running')) {
    const sup = readSupervisor(ctx.ws, ctx.store.scope, att.record_id);
    // A supervising runner that is still alive (in another process) owns the attempt.
    if (sup && sup.runner_pid !== process.pid && runnerAlive(sup.runner_pid)) continue;
    if (sup && sup.runner_pid === process.pid && activeHere.has(`${ctx.store.scope}/${att.record_id}`)) continue;
    if (!sup && !att.body.pid && activeHere.has(`${ctx.store.scope}/${att.record_id}`)) continue;
    const identity = recordedIdentity(ctx, att);
    const termination = identity && identityAlive(identity) ? terminateRecorded(identity) : 'confirmed';
    const staged = existsSync(join(attemptDir(ctx.ws, ctx.store.scope, att.record_id), 'staged.json'));
    const status: AttemptBody['status'] = staged ? 'outcome_unknown' : 'failed';
    const reason = staged
      ? 'reconciled after runner restart: output was staged but its completion was never committed; staged blobs are retained as historical material, not evidence'
      : `reconciled after runner restart: no live supervisor; process ${identity ? 'terminated' : 'never recorded'}; nothing was committed`;
    const job = ctx.store.get(att.body.job, 'job');
    ctx.tx.revise(att.record_id, 'attempt', (b) => ({
      ...b,
      status,
      ended_at: ctx.now,
      reason,
      termination,
      grant: b.grant ? { ...b.grant, revoked: true } : null,
    }));
    if (staged) {
      // Outcome unknown: keep the reservation and mark it uncertain.
      ctx.tx.create('ledger_entry', {
        authorization: job.body.authorization,
        attempt: refOf(att),
        kind: 'uncertain',
        spend: job.body.reservation.spend,
        runtime_seconds: job.body.reservation.runtime_seconds,
        note: `outcome unknown for ${att.record_id}; reservation retained`,
      });
    } else {
      settleAttempt(ctx, job.body.authorization, refOf(att), { spend: 0, runtime_seconds: Math.min(job.body.reservation.runtime_seconds, elapsedSeconds(att.body.started_at, ctx.now)) }, `reconciled ${att.record_id}`);
    }
    const jobHead = ctx.store.mustHead(job.record_id, 'job');
    if (jobHead.body.status === 'running') ctx.tx.revise(job.record_id, 'job', (b) => ({ ...b, status }));
    blockInvestigationIfIdle(ctx, jobHead, `job ${job.record_id}: ${reason}`);
    if (termination === 'unconfirmed') {
      const cs = controlState(ctx.store);
      ctx.tx.revise(cs.record_id, 'control_state', (b) => ({ ...b, stopped: [...b.stopped, { attempt: refOf(att), termination }] }));
    }
    out.push({ attempt: att.record_id, status, reason });
  }
  return out;
}

/** Attempts this process is supervising right now (maintained by runner.ts). */
export const activeHere = new Set<string>();

function runnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

defineOperation<Record<string, never>>({
  name: 'reconcile_attempts',
  channels: ['runner', 'controller'],
  mutating: true,
  handler(ctx) {
    const reconciled = reconcile(ctx);
    if (reconciled.length) ctx.tx.event('attempts_reconciled', { reconciled });
    return { reconciled };
  },
});

defineOperation<{ reason: string }>({
  name: 'resume',
  channels: ['auditor', 'screen', 'controller'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.reason) fail('invalid_request', 'a reason is required');
    const cs = controlState(ctx.store);
    if (!cs.body.paused) fail('invalid_request', 'engagement is not paused');
    // Termination must be confirmed before replacement work is admitted.
    const still: Ref[] = [];
    for (const s of cs.body.stopped) {
      if (s.termination === 'confirmed') continue;
      const att = ctx.store.mustHead(s.attempt.record_id, 'attempt');
      const identity = recordedIdentity(ctx, att);
      if (identity && identityAlive(identity) && terminateRecorded(identity) === 'unconfirmed') still.push(s.attempt);
      else ctx.tx.revise(att.record_id, 'attempt', (b) => ({ ...b, termination: 'confirmed' }));
    }
    if (still.length) fail('stop_unconfirmed', 'stopped attempts are still running; resume refused', { details: { attempts: still } });
    const reconciled = reconcile(ctx);
    // Re-validate queued work: authorization validity and input freshness.
    const suspended: { job: string; reason: string }[] = [];
    for (const job of ctx.store.heads('job').filter((j) => j.body.status === 'queued')) {
      try {
        currentAuthorization(ctx, job.body.authorization.record_id);
        requirePremise(ctx.store, job.body.investigation);
      } catch (e) {
        suspended.push({ job: job.record_id, reason: (e as Error).message });
      }
    }
    ctx.tx.revise(cs.record_id, 'control_state', () => ({ paused: false, reason: p.reason, by: ctx.principal.channel === 'controller' ? 'controller_policy' : 'auditor', stopped: [] }));
    ctx.tx.event('resumed', { suspended, reconciled });
    return { resumed: true, suspended, reconciled };
  },
});
