import type { Ref } from '../core/refs.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import type { RecordEnvelope, WorkAuthorizationBody } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { authorizationIsCurrent } from '../decision/work.ts';
import { engagement } from '../decision/common.ts';
import { ledgerEntries, ledgerTotals } from '../runner/ledger.ts';

// Scheduling across several batches (design/audit-harness.md, delivery step 2; loop L5;
// design/harness-state-and-execution.md, "State transitions" and "Durable jobs and resource limits").
//
// - Jobs still run one at a time; the scheduler only chooses which queued job goes next. It
//   interleaves authorizations round-robin (oldest dispatch first), so one batch's long queue cannot
//   starve another, and inside an authorization keeps request order.
// - New discovery pauses when the review queue reaches its capacity (FR-19): agent jobs that would
//   produce new leads (planner, comprehension, synthesis) wait; admitted investigation work and
//   revalidation reruns continue, so admitted work is finished or checkpointed, never dropped.
// - Batch lifecycle is reconciled from records: a lapsed validity window expires an authorization,
//   spent limits exhaust it, and a batch whose admitted investigations are all decided and whose jobs
//   are all terminal is completed. Completed execution is not completed audit coverage.

const DISCOVERY_ROLES = new Set(['planner', 'comprehension', 'synthesis']);
// `outcome_unknown` is unresolved until reconciled, so it keeps a batch open.
const TERMINAL_JOB = new Set(['completed', 'failed', 'cancelled']);

export interface SchedulerView {
  next: RecordEnvelope<'job'> | null;
  /** Jobs held back and why (discovery paused, authorization not current). */
  held: { job: string; reason: string }[];
  review_queue: { ready: number; capacity: number | null; discovery_paused: boolean };
}

function reviewQueue(store: RecordStore): SchedulerView['review_queue'] {
  const ready = store.heads('investigation').filter((i) => i.body.work_state === 'ready_for_review').length;
  const capacity = engagement(store).body.policy?.capacity.review_queue ?? null;
  return { ready, capacity, discovery_paused: capacity !== null && ready >= capacity };
}

/** Last dispatch time per authorization (from its jobs' attempts), for round-robin fairness. */
function lastDispatch(store: RecordStore): Map<string, string> {
  const jobAuth = new Map(store.heads('job').map((j) => [j.record_id, j.body.authorization.record_id]));
  const out = new Map<string, string>();
  for (const a of store.heads('attempt')) {
    const auth = jobAuth.get(a.body.job.record_id);
    if (!auth || !a.body.started_at) continue;
    if ((out.get(auth) ?? '') < a.body.started_at) out.set(auth, a.body.started_at);
  }
  return out;
}

export function nextJob(store: RecordStore, now: string, skip: Set<string> = new Set()): SchedulerView {
  const rq = reviewQueue(store);
  const held: SchedulerView['held'] = [];
  const auths = new Map(store.heads('work_authorization').map((a) => [a.record_id, a]));
  const queued = store
    .heads('job')
    .filter((j) => j.body.status === 'queued' && !skip.has(j.record_id))
    .sort((a, b) => a.record_id.localeCompare(b.record_id, 'en', { numeric: true }));
  const eligible: RecordEnvelope<'job'>[] = [];
  for (const j of queued) {
    const auth = auths.get(j.body.authorization.record_id);
    if (!auth || !authorizationIsCurrent(auth.body, now)) {
      held.push({ job: j.record_id, reason: `authorization ${j.body.authorization.record_id} is ${auth?.body.status ?? 'missing'} or outside its validity window` });
      continue;
    }
    if (rq.discovery_paused && j.body.purpose === 'agent' && DISCOVERY_ROLES.has(j.body.role)) {
      held.push({ job: j.record_id, reason: `discovery paused: ${rq.ready} packets await review (capacity ${rq.capacity})` });
      continue;
    }
    eligible.push(j);
  }
  if (!eligible.length) return { next: null, held, review_queue: rq };
  // Round-robin: the authorization dispatched least recently goes first; then request order.
  const last = lastDispatch(store);
  const byAuth = new Map<string, RecordEnvelope<'job'>[]>();
  for (const j of eligible) {
    const k = j.body.authorization.record_id;
    byAuth.set(k, [...(byAuth.get(k) ?? []), j]);
  }
  const order = [...byAuth.keys()].sort((a, b) => (last.get(a) ?? '').localeCompare(last.get(b) ?? '') || a.localeCompare(b, 'en', { numeric: true }));
  return { next: byAuth.get(order[0])![0], held, review_queue: rq };
}

function spent(store: RecordStore, auth: RecordEnvelope<'work_authorization'>): { spend: number; runtime_seconds: number } {
  // An `uncertain` entry labels a reservation that is still held, so it is already inside `committed`.
  const t = ledgerTotals(ledgerEntries(store, auth.record_id));
  return { spend: t.committed.spend, runtime_seconds: t.committed.runtime_seconds };
}

/** The lifecycle status an authorization should have now, from records. */
export function batchStatus(store: RecordStore, auth: RecordEnvelope<'work_authorization'>, now: string): WorkAuthorizationBody['status'] {
  const b = auth.body;
  if (b.status !== 'active') return b.status;
  if (b.validity && Date.parse(now) > Date.parse(b.validity.until)) return 'expired';
  const jobs = store.heads('job').filter((j) => j.body.authorization.record_id === auth.record_id);
  const live = jobs.some((j) => !TERMINAL_JOB.has(j.body.status));
  const used = spent(store, auth);
  if (!live && (used.spend >= b.limits.spend && b.limits.spend > 0 || used.runtime_seconds >= b.limits.runtime_seconds)) return 'exhausted';
  if (b.kind === 'batch' && b.investigations.length && !live) {
    const decided = b.investigations.every((r) => {
      const inv = store.head<'investigation'>(r.record_id);
      return !!inv && (inv.body.disposition !== null || inv.body.work_state === 'closed');
    });
    if (decided) return 'completed';
  }
  return 'active';
}

export interface BatchSummary {
  authorization: Ref;
  kind: string;
  status: WorkAuthorizationBody['status'];
  investigations: { ref: Ref; work_state: string; disposition: string | null }[];
  jobs: Record<string, number>;
  spend: { used: number; limit: number };
  runtime: { used: number; limit: number };
}

export function batchSummaries(store: RecordStore, now: string): BatchSummary[] {
  return store.heads('work_authorization').map((a) => {
    const jobs: Record<string, number> = {};
    for (const j of store.heads('job').filter((x) => x.body.authorization.record_id === a.record_id)) jobs[j.body.status] = (jobs[j.body.status] ?? 0) + 1;
    const used = spent(store, a);
    return {
      authorization: { record_id: a.record_id, revision: a.revision },
      kind: a.body.kind,
      status: batchStatus(store, a, now),
      investigations: a.body.investigations.map((r) => {
        const inv = store.head<'investigation'>(r.record_id)!;
        return { ref: { record_id: inv.record_id, revision: inv.revision }, work_state: inv.body.work_state, disposition: inv.body.disposition?.value ?? null };
      }),
      jobs,
      spend: { used: used.spend, limit: a.body.limits.spend },
      runtime: { used: used.runtime_seconds, limit: a.body.limits.runtime_seconds },
    };
  });
}

/** Record lifecycle transitions the records already imply (controller authority, no decision). */
defineOperation<Record<string, never>>({
  name: 'reconcile_batches',
  channels: ['controller', 'auditor'],
  mutating: true,
  handler(ctx: OpContext) {
    const changed: { authorization: Ref; from: string; to: string }[] = [];
    for (const a of ctx.store.heads('work_authorization')) {
      const next = batchStatus(ctx.store, a, ctx.now);
      if (next !== a.body.status) {
        const ref = ctx.tx.revise(a.record_id, 'work_authorization', (b) => ({ ...b, status: next }));
        changed.push({ authorization: ref, from: a.body.status, to: next });
      }
    }
    return { changed };
  },
});

defineOperation<Record<string, never>>({
  name: 'batch_status',
  channels: ['auditor', 'screen', 'controller'],
  mutating: false,
  handler(ctx: OpContext) {
    const view = nextJob(ctx.store, ctx.now);
    return {
      batches: batchSummaries(ctx.store, ctx.now),
      next_job: view.next ? { record_id: view.next.record_id, revision: view.next.revision } : null,
      held: view.held,
      review_queue: view.review_queue,
    };
  },
});
