import { fail } from '../core/errors.ts';
import { isArtifactRef, type Ref } from '../core/refs.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import type { RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { activeSnapshot, deriveIntentTiming, textOrNull } from './common.ts';
import { commitDecision, dependencyClosure, need, type DecisionKindDef, type DecisionPayload } from './framework.ts';

// revise_premise (design/harness-interface-contracts.md): the auditor revises reviewed intent or an
// assumption on the trusted screen. Previous evidence and decisions are preserved; conclusions that
// depend on the premise become `affected`, dependent queued work is suspended, and probe-based
// freshness is recomputed through the registered change handlers (loop L6).

type PremiseHandler = (ctx: OpContext, reason: string) => unknown;
const premiseHandlers: PremiseHandler[] = [];

/** Change handling registers here (the snapshot module re-runs dependency probes). */
export function onPremiseRevised(fn: PremiseHandler): void {
  premiseHandlers.push(fn);
}

const CONCLUSION_TYPES = new Set(['investigation', 'finding', 'fix_assessment', 'behavioral_comparison', 'scenario_variant', 'audit_unit']);

function citesStatement(env: RecordEnvelope, id: string): boolean {
  const b = env.body as unknown as Record<string, unknown>;
  const lists = ['supporting', 'refuting', 'contradicting', 'intended_behavior', 'claims'];
  return lists.some((k) => Array.isArray(b[k]) && (b[k] as unknown[]).some((r) => r && typeof r === 'object' && (r as Ref).record_id === id));
}

/** Records whose dependency closure (or cited support) includes the statement. */
export function dependentsOf(store: RecordStore, statementId: string): RecordEnvelope[] {
  const out: RecordEnvelope[] = [];
  for (const env of store.heads()) {
    if (env.record_id === statementId) continue;
    if (citesStatement(env, statementId)) {
      out.push(env);
      continue;
    }
    const roots = env.depends_on.filter((d): d is Ref => !isArtifactRef(d) && !d.scope);
    if (dependencyClosure(store, roots).some((r) => r.record_id === statementId)) out.push(env);
  }
  return out;
}

const reviseDef: DecisionKindDef = {
  kind: 'revise_premise',
  check(ctx, p) {
    const st = ctx.store.get(need<Ref>(p.inputs, 'statement'), 'system_statement');
    if (!p.reviewed.some((r) => r.record_id === st.record_id && r.revision === st.revision)) {
      fail('display_required', 'the premise must be rendered before it is revised');
    }
    if (!['intent', 'assumption', 'guarantee'].includes(st.body.kind)) fail('invalid_request', 'only intent, assumptions and guarantees are premises');
    if (st.body.review_status !== 'reviewed') fail('invalid_request', 'a provisional statement is confirmed, not revised');
    if (!textOrNull(p.inputs.new_statement)) fail('invalid_request', 'new_statement is required');
    const cap = p.inputs.captured_input as Ref | undefined;
    if (cap && ctx.store.get(cap, 'captured_input').created_by.channel !== 'capture') fail('permission_denied', 'captured input must come from the capture channel');
  },
  apply({ ctx, payload, decision }) {
    const stRef = payload.inputs.statement as Ref;
    const cap = payload.inputs.captured_input as Ref | undefined;
    const before = ctx.store.get(stRef, 'system_statement');
    const revised = ctx.tx.revise(stRef.record_id, 'system_statement', (b) => ({
      ...b,
      statement: String(payload.inputs.new_statement),
      captured_inputs: cap ? [...b.captured_inputs, cap] : b.captured_inputs,
      confirmation: decision,
      intent_timing: b.kind === 'intent' && cap ? deriveIntentTiming(ctx.store, [cap], b.audit_units) : b.intent_timing,
    }));
    const dependents = dependentsOf(ctx.store, stRef.record_id);
    const snapshot = activeSnapshot(ctx.store);
    const affected: Ref[] = [];
    const suspended: Ref[] = [];
    for (const env of dependents) {
      const ref = { record_id: env.record_id, revision: env.revision };
      if (env.type === 'investigation') {
        const inv = env as RecordEnvelope<'investigation'>;
        if (['queued', 'running', 'proposed'].includes(inv.body.work_state) && !inv.body.disposition) {
          suspended.push(
            ctx.tx.revise(env.record_id, 'investigation', (b) => ({ ...b, work_state: 'blocked', blocked_reason: `premise ${stRef.record_id} revised` })),
          );
        }
      }
      // Every dependent conclusion, in progress or decided, is affected: no new iteration is
      // dispatched on the old premise until it is rechecked or reaffirmed.
      if (!CONCLUSION_TYPES.has(env.type) || !snapshot) continue;
      ctx.tx.create(
        'conclusion_freshness',
        {
          conclusion: ref,
          snapshot,
          prior_snapshot: snapshot,
          value: 'affected',
          probes: [],
          unobserved: [`premise ${stRef.record_id} revised from revision ${before.revision}`],
          attestation: null,
          // `decision` is reserved for a reaffirmation; the revising decision is the record's input.
          decision: null,
        },
        [revised, decision],
      );
      affected.push(ref);
    }
    const handlerResults = premiseHandlers.map((h) => h(ctx, `premise ${stRef.record_id} revised`));
    return { statement: revised, affected, suspended, change_handlers: handlerResults.length };
  },
};

defineOperation<Omit<DecisionPayload, 'decision_kind'>>({
  name: 'revise_premise',
  channels: ['screen'],
  mutating: true,
  handler(ctx, p) {
    return commitDecision(ctx, { ...p, decision_kind: 'revise_premise' }, reviseDef);
  },
});
