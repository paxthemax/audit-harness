import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { effectiveImpact, type IntentTiming, type PotentialImpact, POTENTIAL_IMPACTS } from '../core/values.ts';
import type { OpContext } from '../controller/controller.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { EngagementBody, PotentialImpactField, ProofStatus, RecordEnvelope } from '../schema/records.ts';

// Helpers shared by proposals, packets, work authorization and decision kinds.

export function engagement(store: RecordStore): RecordEnvelope<'engagement'> {
  const e = store.heads('engagement')[0];
  if (!e) fail('not_found', 'engagement record missing');
  return e;
}

export function requirePolicy(store: RecordStore): NonNullable<EngagementBody['policy']> {
  const e = engagement(store);
  if (!e.body.policy) fail('permission_denied', 'scope and policy have not been accepted (accept_scope_and_policy)');
  return e.body.policy;
}

export function controlState(store: RecordStore): RecordEnvelope<'control_state'> | undefined {
  return store.heads('control_state')[0];
}

export function defaultProofStatus(): ProofStatus {
  return {
    provenance: 'incomplete',
    prerequisite_review: 'pending',
    adequacy: 'pending',
    adequacy_reason: null,
    replay: 'not_required',
    positive_control: 'not_required',
  };
}

export function isImpact(v: unknown): v is PotentialImpact {
  return typeof v === 'string' && (POTENTIAL_IMPACTS as readonly string[]).includes(v);
}

/** Agent/auditor estimate → stored potential-impact field (glossary "Setting potential impact"). */
export function impactField(
  agent: PotentialImpact | null,
  auditor: PotentialImpact | null,
  lowerReason: string | null,
): PotentialImpactField {
  const effective = effectiveImpact(agent, auditor, lowerReason);
  const set_by: PotentialImpactField['set_by'] =
    agent === null && auditor === null ? 'controller_default' : auditor !== null && effective === auditor ? 'auditor' : 'agent';
  return { agent, auditor, auditor_lower_reason: lowerReason, effective, set_by };
}

/** Who proposed: agents propose through the worker channel; everything else is the auditor. */
export function proposerOrigin(ctx: OpContext): 'agent' | 'auditor' {
  return ctx.principal.channel === 'worker' ? 'agent' : 'auditor';
}

/**
 * A worker may only act on its granted investigation (child tasks and new questions go to
 * authorize_work). A grant tied to no investigation (intake, exploration) touches no investigation.
 */
export function requireWorkerScope(ctx: OpContext, investigationId: string | null): void {
  if (ctx.principal.channel !== 'worker') return;
  const g = ctx.principal.grant!;
  if (investigationId === null) return;
  if (!g.investigation || investigationId !== g.investigation.record_id) {
    fail('permission_denied', 'outside the granted investigation question; propose a new investigation for authorize_work');
  }
}

/**
 * Agents revise only what agents wrote: a worker may not overwrite a record the auditor (or the
 * controller) created, such as a relayed auditee statement, an auditor's control item or a unit.
 */
export function requireAgentAuthored(ctx: OpContext, recordId: string): void {
  if (ctx.principal.channel !== 'worker') return;
  const first = ctx.store.history(recordId)[0];
  if (!first || first.created_by.channel !== 'worker') {
    fail('permission_denied', `${recordId} was not written by an agent; propose a new record that contradicts or refines it`);
  }
}

/**
 * Intent timing (glossary): `before_walkthrough` when every captured input behind the intent precedes
 * the first recorded presentation of each affected unit's implemented behavior; otherwise
 * `after_walkthrough`. Derived by the controller, never self-reported.
 */
export function deriveIntentTiming(store: RecordStore, capturedInputs: Ref[], units: Ref[]): IntentTiming {
  const latestCapture = Math.max(
    ...capturedInputs.map((r) => Date.parse(store.get(r, 'captured_input').body.captured_at)),
  );
  for (const u of units) {
    const fp = firstPresentation(store, u.record_id);
    if (fp && Date.parse(fp.at) <= latestCapture) return 'after_walkthrough';
  }
  return 'before_walkthrough';
}

/**
 * First recorded presentation of a unit's implemented behavior: the earliest display receipt that
 * presented its IMPLEMENTED records or KB diagrams, or the start of an exploration round on it.
 */
export function firstPresentation(store: RecordStore, unitId: string): { at: string; source: Ref } | null {
  let best: { at: string; source: Ref } | null = null;
  const consider = (at: string, source: Ref) => {
    if (!best || Date.parse(at) < Date.parse(best.at)) best = { at, source };
  };
  for (const r of store.heads('display_receipt')) {
    if (r.body.implemented_presented_for.some((u) => u.record_id === unitId)) consider(r.created_at, { record_id: r.record_id, revision: r.revision });
  }
  for (const a of store.heads('work_authorization')) {
    if (a.body.kind === 'exploration' && a.body.reviewed.some((u) => u.record_id === unitId)) {
      consider(store.history(a.record_id)[0].created_at, { record_id: a.record_id, revision: 1 });
    }
  }
  return best;
}

/**
 * The active snapshot at its current revision. The engagement names it by identity; the build hook
 * revises the snapshot (inventory, layouts), so the stored ref's revision can lag behind the head.
 */
export function activeSnapshot(store: RecordStore): Ref | null {
  const r = engagement(store).body.active_snapshot;
  return r ? store.headRef(r.record_id) : null;
}

export function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}
