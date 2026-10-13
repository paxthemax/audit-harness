// Change evaluation and conclusion freshness, loop L6 (design/harness-workflow-loops.md; design/
// harness-state-and-execution.md, "Evidence invalidation and revision changes"; FR-17).
//
// On a new snapshot (and when the lead calls `recomputeFreshness` for `revise_premise`) every probe
// of every consequential conclusion is re-evaluated against the active snapshot and compared with its
// baseline (the evaluation the conclusion was established or last reaffirmed against):
//   every probe unchanged                                    -> carried_forward_mechanical
//   any probe changed                                        -> affected
//   a probe unevaluable or pending, a probe that cannot      -> possibly_affected
//   observe part of its dependencies, or no probe at all
// Historical decisions and evidence are never changed. Queued work that depends on an affected
// conclusion is suspended (`blocked` with a reason); running attempts finish on their frozen inputs.

import type { Ref } from '../core/refs.ts';
import type { Freshness } from '../core/values.ts';
import type { OpContext } from '../controller/controller.ts';
import { onJobCompleted } from '../runner/hooks.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { ConclusionFreshnessBody, RecordEnvelope } from '../schema/records.ts';
import { activeSnapshot, activeSnapshotOf, CONCLUSION_TYPES, creationSeq, isConsequential, type SnapshotView } from './common.ts';
import { evaluateProbe, isRerun, probesFor, rerunOutcome } from './probes.ts';

type ProbeEntry = ConclusionFreshnessBody['probes'][number];

export interface FreshnessOutcome {
  conclusion: Ref;
  value: Freshness;
  record: Ref | null;
}

export interface RecomputeResult {
  snapshot: Ref | null;
  prior: Ref | null;
  outcomes: FreshnessOutcome[];
  suspended: Ref[];
}

/** Re-evaluate one probe against `snap`, staging a new probe revision when the evaluation differs. */
export function reevaluateProbe(ctx: OpContext, probeId: string, snap: SnapshotView): { ref: Ref; body: RecordEnvelope<'dependency_probe'>['body'] } {
  const cur = ctx.tx.current<'dependency_probe'>(probeId, 'dependency_probe');
  const b = cur.body;
  let next = b;
  if (isRerun(b.kind)) {
    // Reruns are evaluated by probe jobs; keep a result already obtained on this snapshot.
    const onSnap = b.snapshot.record_id === snap.ref.record_id;
    if (!onSnap || (b.status !== 'evaluated' && b.job === null && b.status !== 'pending')) {
      const ev = evaluateProbe(ctx.archive, snap, b.kind, b.query);
      next = { ...b, snapshot: snap.ref, status: ev.status, result_digest: null, result_summary: ev.summary, cannot_observe: ev.cannot_observe, job: null };
    }
  } else {
    const ev = evaluateProbe(ctx.archive, snap, b.kind, b.query);
    next = { ...b, snapshot: snap.ref, status: ev.status, result_digest: ev.digest, result_summary: ev.summary, cannot_observe: ev.cannot_observe };
  }
  // A baseline that could not be evaluated when the probe was recorded is fixed by the first
  // evaluation on that same snapshot (e.g. once its build completes).
  if (next.baseline && next.baseline.digest === null && next.baseline.snapshot.record_id === snap.ref.record_id && next.status === 'evaluated') {
    next = { ...next, baseline: { snapshot: snap.ref, digest: next.result_digest } };
  }
  if (JSON.stringify(next) === JSON.stringify(b)) return { ref: { record_id: probeId, revision: cur.revision }, body: b };
  const ref = ctx.tx.revise(probeId, 'dependency_probe', () => next);
  return { ref, body: next };
}

/** Freshness of one conclusion from its (already re-evaluated) probes. */
export function assess(probes: { ref: Ref; body: RecordEnvelope<'dependency_probe'>['body'] }[]): {
  value: Freshness;
  entries: ProbeEntry[];
  unobserved: string[];
  reasons: string[];
} {
  const entries: ProbeEntry[] = [];
  const unobserved: string[] = [];
  const reasons: string[] = [];
  for (const p of probes) {
    const before = p.body.baseline?.digest ?? null;
    const after = p.body.status === 'evaluated' ? p.body.result_digest : null;
    let status: ProbeEntry['status'];
    if (p.body.status === 'pending') status = 'pending';
    else if (p.body.status === 'unevaluable' || before === null) status = 'unevaluable';
    else status = before === after ? 'unchanged' : 'changed';
    entries.push({ probe: p.ref, before, after, status });
    const id = p.ref.record_id;
    if (status === 'changed') reasons.push(`${id} (${p.body.kind}) changed: ${p.body.result_summary ?? ''}`.trim());
    if (status === 'pending') reasons.push(`${id} (${p.body.kind}) pending: ${p.body.result_summary ?? ''}`.trim());
    if (status === 'unevaluable') reasons.push(`${id} (${p.body.kind}) unevaluable: ${before === null && p.body.status === 'evaluated' ? 'no baseline evaluation' : (p.body.result_summary ?? '')}`.trim());
    for (const c of p.body.cannot_observe) unobserved.push(`${id}: ${c}`);
  }
  if (!probes.length) {
    unobserved.push('no dependency probe is recorded for this conclusion');
    reasons.push('no dependency probe observes this conclusion');
  }
  let value: Freshness;
  if (entries.some((e) => e.status === 'changed')) value = 'affected';
  else if (!probes.length || entries.some((e) => e.status !== 'unchanged') || unobserved.length) value = 'possibly_affected';
  else value = 'carried_forward_mechanical';
  if (value === 'possibly_affected' && unobserved.length && probes.length && entries.every((e) => e.status === 'unchanged')) {
    reasons.push('probes are unchanged but cannot observe every dependency');
  }
  return { value, entries, unobserved, reasons };
}

function freshnessRecordFor(store: RecordStore, conclusionId: string, snapshotId: string): RecordEnvelope<'conclusion_freshness'> | undefined {
  return store.heads('conclusion_freshness').find((f) => f.body.conclusion.record_id === conclusionId && f.body.snapshot.record_id === snapshotId);
}

/** Work that depends on `conclusionId` and is queued (not yet running). */
function dependentQueuedWork(ctx: OpContext, conclusion: RecordEnvelope): string[] {
  const out: string[] = [];
  for (const inv of ctx.store.heads('investigation')) {
    const b = ctx.tx.current<'investigation'>(inv.record_id, 'investigation').body;
    if (b.work_state !== 'queued') continue; // proposed work is not admitted; running attempts finish
    const id = conclusion.record_id;
    const depends =
      inv.record_id === id ||
      b.variants.some((v) => v.record_id === id) ||
      b.audit_units.some((u) => u.record_id === id) ||
      b.lineage?.record_id === id ||
      inv.depends_on.some((d) => 'record_id' in d && d.record_id === id) ||
      (conclusion.type === 'scenario_variant' && (conclusion.body as { investigation: Ref }).investigation.record_id === inv.record_id) ||
      (conclusion.type === 'finding' && (conclusion.body as { investigation: Ref }).investigation.record_id === inv.record_id);
    if (depends) out.push(inv.record_id);
  }
  return out;
}

/**
 * Stage (or revise) the freshness record of one conclusion for `snap`. Returns null when nothing
 * changed. A reaffirmation on the same snapshot stands unless a probe changed after it; an
 * attestation stands only while the value stays `carried_forward_mechanical`.
 */
function stageFreshness(ctx: OpContext, conclusion: RecordEnvelope, snap: SnapshotView, prior: Ref, extraReasons: string[]): FreshnessOutcome {
  const probes = probesFor(ctx.store, conclusion.record_id).map((p) => reevaluateProbe(ctx, p.record_id, snap));
  const a = assess(probes);
  const existing = freshnessRecordFor(ctx.store, conclusion.record_id, snap.ref.record_id);
  let value = a.value;
  let attestation: Ref | null = null;
  let decision: Ref | null = null;
  if (existing) {
    if (existing.body.decision && value !== 'affected') {
      value = existing.body.value;
      decision = existing.body.decision;
    }
    if (existing.body.attestation && value === 'carried_forward_mechanical') attestation = existing.body.attestation;
  }
  const conclusionRef = { record_id: conclusion.record_id, revision: conclusion.revision };
  const body: ConclusionFreshnessBody = {
    conclusion: conclusionRef,
    snapshot: snap.ref,
    prior_snapshot: existing?.body.prior_snapshot ?? prior,
    value,
    probes: a.entries,
    unobserved: a.unobserved,
    attestation,
    decision,
    reasons: [...extraReasons, ...a.reasons],
  };
  const deps = probes.map((p) => p.ref);
  if (existing) {
    // The triggering reason alone does not make a new revision.
    const same = JSON.stringify({ ...existing.body, reasons: undefined }) === JSON.stringify({ ...body, reasons: undefined });
    if (same) return { conclusion: conclusionRef, value, record: null };
    const ref = ctx.tx.revise(existing.record_id, 'conclusion_freshness', () => body, { depends_on: deps });
    return { conclusion: conclusionRef, value, record: ref };
  }
  const ref = ctx.tx.create('conclusion_freshness', body, deps);
  return { conclusion: conclusionRef, value, record: ref };
}

/**
 * Re-run the probes of every consequential conclusion established before the active snapshot and
 * stage their freshness against it. `snapshot`/`prior` default to the engagement's active snapshot
 * and that snapshot's predecessor. Probe-based only: the lead marks conclusions that depend directly
 * on a revised premise itself (see `markAffected`).
 */
export function recomputeFreshness(ctx: OpContext, reason: string, opts: { snapshot?: SnapshotView; prior?: Ref | null } = {}): RecomputeResult {
  const snap = opts.snapshot ?? activeSnapshot(ctx);
  if (!snap) return { snapshot: null, prior: null, outcomes: [], suspended: [] };
  const prior = opts.prior !== undefined ? opts.prior : snap.body.prior_snapshot;
  if (!prior) return { snapshot: snap.ref, prior: null, outcomes: [], suspended: [] };

  // Conclusions established before the snapshot was registered (a staged snapshot is newer than all).
  const seq = creationSeq(ctx.store);
  const snapSeq = seq.get(snap.ref.record_id) ?? Number.POSITIVE_INFINITY;
  const subjects: RecordEnvelope[] = [];
  for (const t of CONCLUSION_TYPES) {
    for (const env of ctx.store.heads(t)) {
      const created = seq.get(env.record_id) ?? 0;
      const hasRecord = !!freshnessRecordFor(ctx.store, env.record_id, snap.ref.record_id);
      if (!hasRecord && created >= snapSeq) continue;
      if (!hasRecord && !isConsequential(env) && !probesFor(ctx.store, env.record_id).length) continue;
      subjects.push(env);
    }
  }

  // Suspension first, so freshness records cite the conclusions' current revisions.
  const outcomes: FreshnessOutcome[] = [];
  const firstPass = subjects.map((c) => ({ c, a: assess(probesFor(ctx.store, c.record_id).map((p) => reevaluateProbe(ctx, p.record_id, snap))) }));
  const suspended: Ref[] = [];
  for (const { c, a } of firstPass) {
    if (a.value !== 'affected') continue;
    for (const invId of dependentQueuedWork(ctx, c)) {
      const cur = ctx.tx.current<'investigation'>(invId, 'investigation');
      if (cur.body.work_state === 'blocked') continue;
      suspended.push(
        ctx.tx.revise(invId, 'investigation', (b) => ({
          ...b,
          work_state: 'blocked',
          blocked_reason: `suspended (L6): depends on ${c.record_id}, whose freshness is affected on ${snap.ref.record_id}; recheck needs authorization`,
        })),
      );
    }
  }
  for (const { c } of firstPass) {
    const cur = ctx.tx.current(c.record_id);
    const env = { ...c, revision: cur.revision, body: cur.body } as RecordEnvelope;
    outcomes.push(stageFreshness(ctx, env, snap, prior, [reason]));
  }
  ctx.tx.event('freshness_recomputed', {
    reason,
    snapshot: snap.ref,
    prior,
    affected: outcomes.filter((o) => o.value === 'affected').length,
    possibly_affected: outcomes.filter((o) => o.value === 'possibly_affected').length,
    carried_forward_mechanical: outcomes.filter((o) => o.value === 'carried_forward_mechanical').length,
    suspended: suspended.length,
  });
  return { snapshot: snap.ref, prior, outcomes, suspended };
}

/**
 * Mark one conclusion `affected` on the active snapshot for a reason no probe observes (for example a
 * revised premise it depends on directly). Its probes are still recorded.
 */
export function markAffected(ctx: OpContext, conclusionId: string, reason: string): FreshnessOutcome | null {
  const snap = activeSnapshot(ctx);
  if (!snap) return null;
  const cur = ctx.tx.current(conclusionId);
  const conclusionRef = { record_id: conclusionId, revision: cur.revision };
  const probes = probesFor(ctx.store, conclusionId).map((p) => reevaluateProbe(ctx, p.record_id, snap));
  const a = assess(probes);
  const existing = freshnessRecordFor(ctx.store, conclusionId, snap.ref.record_id);
  const body: ConclusionFreshnessBody = {
    conclusion: conclusionRef,
    snapshot: snap.ref,
    prior_snapshot: existing?.body.prior_snapshot ?? snap.body.prior_snapshot ?? snap.ref,
    value: 'affected',
    probes: a.entries,
    unobserved: a.unobserved,
    attestation: null,
    decision: null,
    reasons: [reason, ...a.reasons],
  };
  const deps = probes.map((p) => p.ref);
  const record = existing
    ? ctx.tx.revise(existing.record_id, 'conclusion_freshness', () => body, { depends_on: deps })
    : ctx.tx.create('conclusion_freshness', body, deps);
  return { conclusion: conclusionRef, value: 'affected', record };
}

// ------------------------------------------------------------------------------------------------
// Read helpers for the report, screen and runner

export interface CurrentFreshness {
  value: Freshness;
  /** The freshness record for the active snapshot, when one exists. */
  record: Ref | null;
  snapshot: Ref | null;
  prior_snapshot: Ref | null;
  unobserved: string[];
  reasons: string[];
  /** Covered by an `attest_carry_forward` decision (still mechanical, never human review). */
  attested: boolean;
  /** The `reaffirm` decision, when reaffirmed. */
  decision: Ref | null;
}

/**
 * Freshness of a conclusion relative to the active snapshot. A conclusion without a freshness
 * record for the active snapshot was established on it and is `current`.
 */
export function currentFreshness(store: RecordStore, conclusionId: string): CurrentFreshness {
  const active = activeSnapshotOf(store);
  const rec = active ? freshnessRecordFor(store, conclusionId, active.record_id) : undefined;
  if (!rec) {
    return { value: 'current', record: null, snapshot: active ? { record_id: active.record_id, revision: active.revision } : null, prior_snapshot: null, unobserved: [], reasons: [], attested: false, decision: null };
  }
  return {
    value: rec.body.value,
    record: { record_id: rec.record_id, revision: rec.revision },
    snapshot: rec.body.snapshot,
    prior_snapshot: rec.body.prior_snapshot,
    unobserved: rec.body.unobserved,
    reasons: rec.body.reasons ?? [],
    attested: rec.body.attestation !== null,
    decision: rec.body.decision,
  };
}

export interface FreshnessSummaryItem {
  conclusion: Ref;
  type: string;
  value: Freshness;
  record: Ref;
  attested: boolean;
  decision: Ref | null;
  unobserved: string[];
  reasons: string[];
}

export interface FreshnessSummary {
  active_snapshot: Ref | null;
  counts: Record<Freshness, number>;
  items: FreshnessSummaryItem[];
  /** Carried forward but not yet covered by an `attest_carry_forward` decision. */
  carried_unattested: Ref[];
  affected: Ref[];
  possibly_affected: Ref[];
}

/** Freshness of every conclusion that has a record for the active snapshot. */
export function freshnessSummary(store: RecordStore): FreshnessSummary {
  const active = activeSnapshotOf(store);
  const counts: Record<Freshness, number> = { current: 0, carried_forward_mechanical: 0, possibly_affected: 0, affected: 0, reaffirmed_by_human: 0 };
  const items: FreshnessSummaryItem[] = [];
  if (active) {
    for (const f of store.heads('conclusion_freshness')) {
      if (f.body.snapshot.record_id !== active.record_id) continue;
      const c = store.head(f.body.conclusion.record_id);
      counts[f.body.value]++;
      items.push({
        conclusion: f.body.conclusion,
        type: c?.type ?? 'unknown',
        value: f.body.value,
        record: { record_id: f.record_id, revision: f.revision },
        attested: f.body.attestation !== null,
        decision: f.body.decision,
        unobserved: f.body.unobserved,
        reasons: f.body.reasons ?? [],
      });
    }
  }
  return {
    active_snapshot: active ? { record_id: active.record_id, revision: active.revision } : null,
    counts,
    items,
    carried_unattested: items.filter((i) => i.value === 'carried_forward_mechanical' && !i.attested).map((i) => i.record),
    affected: items.filter((i) => i.value === 'affected').map((i) => i.conclusion),
    possibly_affected: items.filter((i) => i.value === 'possibly_affected').map((i) => i.conclusion),
  };
}

/** Conclusions an investigation depends on whose freshness is `affected` (for dispatch refusal). */
export function affectedPremises(store: RecordStore, investigationId: string): Ref[] {
  const inv = store.head<'investigation'>(investigationId);
  if (!inv) return [];
  const ids = new Set<string>([investigationId, ...inv.body.variants.map((v) => v.record_id), ...inv.body.audit_units.map((u) => u.record_id)]);
  if (inv.body.lineage) ids.add(inv.body.lineage.record_id);
  for (const d of inv.depends_on) if ('record_id' in d) ids.add(d.record_id);
  return [...ids]
    .map((id) => ({ id, f: currentFreshness(store, id) }))
    .filter((x) => x.f.value === 'affected')
    .map((x) => ({ record_id: x.id, revision: store.head(x.id)!.revision }));
}

// ------------------------------------------------------------------------------------------------
// Probe jobs: record the rerun outcome and update freshness.

onJobCompleted('probe', (ctx, done) => {
  const probes = ctx.store.heads('dependency_probe').filter((p) => p.body.job?.record_id === done.job.record_id);
  for (const p of probes) {
    const snapRef = done.job.body.snapshot;
    const out = rerunOutcome(done.evidenceBody?.structured_result ?? null);
    // A rerun that errored (e.g. no longer compiles) observed nothing about the conclusion.
    const failed = !done.evidenceBody || done.job.body.status !== 'completed' || done.evidenceBody.structured_result?.result_type === 'error';
    const status = !failed && out.digest ? 'evaluated' : 'unevaluable';
    const cur = ctx.tx.current<'dependency_probe'>(p.record_id, 'dependency_probe').body;
    const snapHead = ctx.tx.current<'target_snapshot'>(snapRef.record_id, 'target_snapshot');
    const ref = { record_id: snapRef.record_id, revision: snapHead.revision };
    ctx.tx.revise(p.record_id, 'dependency_probe', (b) => ({
      ...b,
      snapshot: ref,
      status,
      result_digest: status === 'evaluated' ? out.digest : null,
      result_summary: failed ? `probe job ${done.job.record_id} did not complete (${done.job.body.status})` : out.summary,
      baseline: cur.baseline && cur.baseline.digest === null && cur.baseline.snapshot.record_id === snapRef.record_id && status === 'evaluated' ? { snapshot: ref, digest: out.digest } : b.baseline,
    }));
    const active = activeSnapshot(ctx);
    if (!active || active.ref.record_id !== snapRef.record_id || !p.body.conclusion) continue;
    const existing = freshnessRecordFor(ctx.store, p.body.conclusion.record_id, active.ref.record_id);
    if (!existing) continue;
    const concl = ctx.tx.current(p.body.conclusion.record_id);
    const env = { ...ctx.store.mustHead(p.body.conclusion.record_id), revision: concl.revision, body: concl.body } as RecordEnvelope;
    stageFreshness(ctx, env, active, existing.body.prior_snapshot, [`probe job ${done.job.record_id} completed`]);
  }
});
