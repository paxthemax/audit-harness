import { fail, HarnessError } from '../core/errors.ts';
import { canonicalJson, digest } from '../core/hash.ts';
import type { AnyRef, Ref } from '../core/refs.ts';
import { AUDIT_UNIT_KINDS, impactRank, INVESTIGATION_METHODS, MODEL_AFFILIATIONS, STATEMENT_KINDS } from '../core/values.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import type { BodyByType, LinkedClaim, RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { enqueueClarification } from './clarifications.ts';
import { isTargetSourceEdit } from './packets.ts';
import {
  defaultProofStatus,
  engagement,
  impactField,
  isImpact,
  activeSnapshot,
  proposerOrigin,
  requireAgentAuthored,
  requireWorkerScope,
  textOrNull,
} from './common.ts';

// Proposals: attributed provisional records from agents or the auditor
// (design/harness-interface-contracts.md, `submit_proposal`). A proposal can never create an accepted
// finding, reviewed semantics, a confirmed interpretation, a library entry or a policy change.
// Revisions name their base revision; a stale base never silently wins: the controller retains the
// conflicting proposal and answers `revision_conflict` (design/harness-state-and-execution.md).

export type ProposalKind =
  | 'system_statement'
  | 'investigation'
  | 'scenario_variant'
  | 'clarification'
  | 'interpretation'
  | 'audit_unit'
  | 'property'
  | 'behavioral_correspondence'
  | 'behavioral_comparison'
  | 'behavioral_discrepancy';

export interface ProposalPayload {
  kind: ProposalKind;
  /** For a revision: the exact base revision being revised. */
  base?: Ref | null;
  /** Kind-specific proposed fields; controller-owned fields are ignored or refused. */
  body: Record<string, any>;
  depends_on?: AnyRef[];
}

/** Statement origins a proposal may carry. `auditor_clarification` only arises from captured input + confirmation. */
const PROPOSABLE_ORIGINS = new Set(['documented_claim', 'inferred_candidate', 'source_analysis', 'execution_observation']);

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) fail('invalid_request', `${field} is required`);
  return v;
}
function list<T = string>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function retainConflict(ctx: OpContext, p: ProposalPayload, actual: number): void {
  ctx.tx.create('proposal_conflict', {
    operation: 'submit_proposal',
    target: p.base!.record_id,
    expected_revision: p.base!.revision,
    actual_revision: actual,
    proposal: { kind: p.kind, body: p.body, principal: ctx.principal.principal, request_id: ctx.request.request_id },
    status: 'open',
  });
  ctx.failAfterCommit(
    new HarnessError('revision_conflict', `${p.base!.record_id} is at revision ${actual}, proposal was based on ${p.base!.revision}; both are retained`, {
      ref: p.base!,
      details: { expected: p.base!.revision, actual },
    }),
  );
}

/**
 * Job dispatch revises an investigation or a scenario variant without changing what a proposal about it was based on:
 * `request_job` appends the job link (the round's own job, or an experiment the agent requested earlier in the same
 * round) and `start_attempt` moves an investigation's work to `running`. These happen after the context of the agent
 * round was built, so without a rebase over them an agent's prerequisite review or variant outcome would conflict.
 * Any other change, including a move to `ready_for_review` or a recorded outcome, still conflicts.
 */
function dispatchOnly(type: string, prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const { jobs: _prevJobs, work_state: prevState, blocked_reason: prevReason, ...prevContent } = prev;
  const { jobs: _nextJobs, work_state: nextState, blocked_reason: nextReason, ...nextContent } = next;
  const state = type === 'investigation' && ((prevState === nextState && prevReason === nextReason) || (nextState === 'running' && nextReason === null));
  const stateless = type === 'scenario_variant' && prevState === nextState && prevReason === nextReason;
  return (state || stateless) && canonicalJson(prevContent) === canonicalJson(nextContent);
}

/** Every revision after `base` up to `head` only recorded job dispatch. */
function onlyDispatchSince(store: RecordStore, base: Ref, head: RecordEnvelope): boolean {
  if (!['investigation', 'scenario_variant'].includes(head.type) || !Number.isInteger(base.revision) || base.revision < 1 || base.revision >= head.revision) return false;
  const revisions = store.history(base.record_id).slice(base.revision - 1);
  return revisions.every((env, i) => i === 0 || dispatchOnly(head.type, revisions[i - 1].body as unknown as Record<string, unknown>, env.body as unknown as Record<string, unknown>));
}

defineOperation<ProposalPayload>({
  name: 'submit_proposal',
  channels: ['auditor', 'worker'],
  mutating: true,
  retainConflicts: true,
  handler(ctx, p) {
    if (!p || !p.kind || typeof p.body !== 'object') fail('invalid_request', 'kind and body are required');
    if (engagement(ctx.store).body.closure_status !== 'open') fail('permission_denied', 'the engagement is closed');
    if (p.base) {
      const head = ctx.store.head(p.base.record_id);
      if (!head) fail('not_found', `base ${p.base.record_id} not found`);
      if (head.type !== p.kind) fail('invalid_request', `base is a ${head.type}, not a ${p.kind}`);
      if (head.revision !== p.base.revision) {
        if (!onlyDispatchSince(ctx.store, p.base, head)) {
          retainConflict(ctx, p, head.revision);
          return { conflict: true };
        }
        p = { ...p, base: { record_id: head.record_id, revision: head.revision } };
      }
    }
    const handler = HANDLERS[p.kind];
    if (!handler) fail('invalid_request', `cannot propose a ${p.kind}`);
    return handler(ctx, p);
  },
});

type Handler = (ctx: OpContext, p: ProposalPayload) => Record<string, unknown>;

const HANDLERS: Record<ProposalKind, Handler> = {
  system_statement(ctx, p) {
    const b = p.body;
    let baseOrigin: string | null = null;
    if (p.base) {
      const cur = ctx.store.mustHead(p.base.record_id, 'system_statement');
      if (cur.body.review_status === 'reviewed') {
        fail('permission_denied', 'reviewed semantics change only through revise_premise; propose a contradicting statement instead');
      }
      requireAgentAuthored(ctx, cur.record_id);
      baseOrigin = cur.body.origin;
    }
    const origin = baseOrigin ?? b.origin ?? 'inferred_candidate';
    if (baseOrigin && b.origin && b.origin !== baseOrigin) fail('invalid_request', `a revision keeps the statement's origin (${baseOrigin})`);
    if (origin === 'auditee_statement') {
      if (ctx.principal.channel !== 'auditor') fail('permission_denied', 'auditee statements are relayed by the auditor');
    } else if (baseOrigin) {
      // The origin was checked when the statement was created.
    } else if (!PROPOSABLE_ORIGINS.has(origin)) {
      fail('permission_denied', `origin ${origin} cannot be proposed; auditor clarifications come from captured input and a confirmation decision`);
    }
    if (!STATEMENT_KINDS.includes(b.kind)) fail('invalid_request', 'statement kind is required');
    if (!MODEL_AFFILIATIONS.includes(b.affiliation)) fail('invalid_request', 'model affiliation is required');
    const body: BodyByType['system_statement'] = {
      kind: b.kind,
      affiliation: b.affiliation,
      origin,
      statement: str(b.statement, 'statement'),
      anchors: list(b.anchors),
      audit_units: list(b.audit_units),
      captured_inputs: [],
      confirmation: null,
      intent_timing: null,
      applicability: textOrNull(b.applicability) ?? 'active snapshot',
      supporting: list(b.supporting),
      contradicting: list(b.contradicting),
      review_status: 'provisional',
      owner: textOrNull(b.owner) ?? ctx.principal.principal,
    };
    for (const u of body.audit_units) ctx.store.get(u, 'audit_unit');
    const ref = p.base
      ? ctx.tx.revise(p.base.record_id, 'system_statement', () => body, { depends_on: p.depends_on })
      : ctx.tx.create('system_statement', body, p.depends_on ?? []);
    return { statement: ref };
  },

  investigation(ctx, p) {
    const b = p.body;
    const origin = proposerOrigin(ctx);
    if (p.base) {
      requireWorkerScope(ctx, p.base.record_id);
      const cur = ctx.store.mustHead(p.base.record_id, 'investigation');
      if (cur.body.disposition) fail('permission_denied', 'a disposed investigation is reopened only by a new revision under authorize_work');
      const ref = ctx.tx.revise(p.base.record_id, 'investigation', (prev) => {
        const next = { ...prev };
        if (b.next_check !== undefined) next.next_check = textOrNull(b.next_check);
        if (b.supporting) next.supporting = [...prev.supporting, ...list<AnyRef>(b.supporting)];
        if (b.refuting) next.refuting = [...prev.refuting, ...list<AnyRef>(b.refuting)];
        if (b.anchors) next.anchors = list(b.anchors);
        if (b.prerequisites) next.prerequisites = list(b.prerequisites);
        if (b.potential_impact !== undefined) {
          if (!isImpact(b.potential_impact)) fail('invalid_request', 'invalid potential impact');
          const pi = prev.potential_impact;
          // An agent may raise its estimate but never lower it: an optimistic re-estimate must not
          // lower the evidence bar (glossary, "Setting potential impact").
          const agentEstimate = pi.agent && impactRank(pi.agent) > impactRank(b.potential_impact) ? pi.agent : b.potential_impact;
          next.potential_impact =
            origin === 'agent'
              ? impactField(agentEstimate, pi.auditor, pi.auditor_lower_reason)
              : impactField(pi.agent, b.potential_impact, textOrNull(b.auditor_lower_reason));
        }
        // Prerequisite review and adequacy come from the challenger or the auditor.
        const isChallenger = ctx.principal.channel === 'auditor' || ctx.principal.grant?.role === 'challenger';
        if (b.prerequisite_review || b.adequacy) {
          if (!isChallenger) fail('permission_denied', 'only the challenger or the auditor records prerequisite review and adequacy');
          if (b.adequacy === 'sufficient' && prev.method === 'property') {
            requireAdequacyEvidence(ctx, { record_id: p.base!.record_id, revision: p.base!.revision }, list<AnyRef>(b.adequacy_evidence));
          }
          next.proof_status = {
            ...prev.proof_status,
            ...(b.prerequisite_review ? { prerequisite_review: b.prerequisite_review } : {}),
            ...(b.adequacy ? { adequacy: b.adequacy, adequacy_reason: textOrNull(b.adequacy_reason) } : {}),
          };
          if (next.proof_status.adequacy === 'not_applicable' && !next.proof_status.adequacy_reason) {
            fail('invalid_request', 'adequacy not_applicable needs a reason');
          }
        }
        return next;
      });
      return { investigation: ref };
    }
    if (ctx.principal.channel === 'worker') {
      // A worker may propose a new investigation question; it stays `proposed` until authorize_work.
    }
    if (!INVESTIGATION_METHODS.includes(b.method)) fail('invalid_request', 'method must be hypothesis, property or scenario');
    const units = list<Ref>(b.audit_units);
    for (const u of units) ctx.store.get(u, 'audit_unit');
    const estimate = isImpact(b.potential_impact) ? b.potential_impact : null;
    if (b.potential_impact !== undefined && !estimate) fail('invalid_request', 'invalid potential impact');
    const body: BodyByType['investigation'] = {
      method: b.method,
      question: str(b.question, 'question'),
      executable: b.executable !== false,
      origin,
      lead_generator: str(b.lead_generator ?? 'manual', 'lead_generator'),
      audit_units: units,
      guarantees: list(b.guarantees),
      attacker_capabilities: list(b.attacker_capabilities),
      prerequisites: list(b.prerequisites),
      anchors: list(b.anchors),
      potential_impact:
        origin === 'agent' ? impactField(estimate ?? 'unknown', null, null) : impactField(null, estimate ?? 'unknown', null),
      supporting: list(b.supporting),
      refuting: list(b.refuting),
      variants: [],
      linked_claims: [],
      next_check: textOrNull(b.next_check),
      jobs: [],
      authorization: null,
      work_state: 'proposed',
      blocked_reason: null,
      disposition: null,
      proof_status: defaultProofStatus(),
      probes: [],
      lineage: b.lineage ?? null,
    };
    const ref = ctx.tx.create('investigation', body, p.depends_on ?? []);
    return { investigation: ref, work_state: 'proposed' };
  },

  scenario_variant(ctx, p) {
    const b = p.body;
    if (p.base) {
      // Recording a variant's outcome or the challenger's review of its declared setup powers.
      const cur = ctx.store.mustHead(p.base.record_id, 'scenario_variant');
      requireWorkerScope(ctx, cur.body.investigation.record_id);
      if (ctx.store.mustHead(cur.body.investigation.record_id, 'investigation').body.disposition) {
        fail('permission_denied', 'the investigation has a disposition; its variants are historical');
      }
      const isChallenger = ctx.principal.channel === 'auditor' || ctx.principal.grant?.role === 'challenger';
      const ref = ctx.tx.revise(p.base.record_id, 'scenario_variant', (prev) => {
        const next = { ...prev };
        if (b.outcome !== undefined) next.outcome = b.outcome;
        if (b.countercondition !== undefined) next.countercondition = b.countercondition;
        if (b.jobs) next.jobs = [...prev.jobs, ...list<Ref>(b.jobs)];
        if (b.challenger_review) {
          if (!isChallenger) fail('permission_denied', 'only the challenger or the auditor reviews declared setup powers');
          next.challenger_review = { status: b.challenger_review.status, note: textOrNull(b.challenger_review.note) };
        }
        return next;
      });
      return { variant: ref };
    }
    const inv = ctx.store.mustHead(str(b.investigation?.record_id, 'investigation'), 'investigation');
    requireWorkerScope(ctx, inv.record_id);
    if (inv.body.disposition) fail('permission_denied', 'the investigation already has a disposition');

    // DEC-009 Q-026: a follow-up that needs anything new, or changes a guarantee's or check oracle's
    // meaning, returns to authorize_work as a proposed investigation question.
    const requires = list(b.follow_up_requires);
    if (requires.length) {
      const redirected = HANDLERS.investigation(ctx, {
        kind: 'investigation',
        body: {
          method: inv.body.method,
          question: str(b.question ?? b.expected_violation, 'question'),
          executable: inv.body.executable,
          lead_generator: inv.body.lead_generator,
          audit_units: list(b.audit_units).length ? b.audit_units : inv.body.audit_units,
          guarantees: b.linked_guarantee ? [b.linked_guarantee] : inv.body.guarantees,
          potential_impact: b.potential_impact,
          next_check: `requires: ${requires.join(', ')}`,
          lineage: { record_id: inv.record_id, revision: inv.revision },
        },
      });
      return { redirected_to_authorize_work: true, ...redirected };
    }

    const linkedGuarantee = textOrNull(b.linked_guarantee);
    if (linkedGuarantee && inv.body.guarantees.includes(linkedGuarantee)) {
      fail('invalid_request', 'linked_guarantee must name a guarantee other than the investigation question\'s own');
    }
    const body: BodyByType['scenario_variant'] = {
      investigation: { record_id: inv.record_id, revision: inv.revision },
      previous: b.previous ?? null,
      linked_guarantee: linkedGuarantee,
      linked_claim_id: null,
      causal_sequence: list(b.causal_sequence),
      setup_powers: list(b.setup_powers),
      change_classification: b.previous ? (b.change_classification ?? 'syntactic') : 'initial',
      classified_by: ctx.principal.principal,
      challenger_review: { status: 'pending', note: null },
      expected_violation: str(b.expected_violation, 'expected_violation'),
      defeating_condition: str(b.defeating_condition, 'defeating_condition'),
      jobs: [],
      outcome: null,
      countercondition: null,
      probes: [],
    };
    if (body.previous) ctx.store.get(body.previous, 'scenario_variant');
    if (!body.causal_sequence.length) fail('invalid_request', 'causal_sequence is required');
    let linkedClaimId: string | null = null;
    if (linkedGuarantee) {
      const existing = inv.body.linked_claims.find((c) => c.guarantee === linkedGuarantee);
      linkedClaimId = existing?.id ?? `lc-${inv.body.linked_claims.length + 1}`;
      body.linked_claim_id = linkedClaimId;
    }
    // Parent links live in the body; depends_on holds material inputs only (here: the previous variant).
    const variant = ctx.tx.create('scenario_variant', body, body.previous ? [body.previous] : []);
    const invRef = ctx.tx.revise(inv.record_id, 'investigation', (prev) => {
      const next = { ...prev, variants: [...prev.variants, variant] };
      if (linkedGuarantee) {
        const flow = (b.linked_flow as Ref | undefined) ?? null;
        if (flow) ctx.store.get(flow, 'audit_unit');
        const flowReviewed = flow ? ctx.store.mustHead(flow.record_id, 'audit_unit').body.review_status === 'reviewed' : false;
        const existing = prev.linked_claims.find((c) => c.id === linkedClaimId);
        if (existing) {
          next.linked_claims = prev.linked_claims.map((c) => (c.id === linkedClaimId ? { ...c, variants: [...c.variants, variant] } : c));
        } else {
          const estimate = isImpact(b.potential_impact) ? b.potential_impact : 'unknown';
          const claim: LinkedClaim = {
            id: linkedClaimId!,
            guarantee: linkedGuarantee,
            flow,
            claim: str(b.linked_claim ?? b.expected_violation, 'linked_claim'),
            variants: [variant],
            potential_impact:
              proposerOrigin(ctx) === 'agent' ? impactField(estimate, null, null) : impactField(null, estimate, null),
            disposition: null,
            proof_status: defaultProofStatus(),
            flow_reviewed: flowReviewed,
          };
          next.linked_claims = [...prev.linked_claims, claim];
        }
      }
      return next;
    });
    return { variant, investigation: invRef, linked_claim: linkedClaimId };
  },

  clarification(ctx, p) {
    if (p.base) fail('invalid_request', 'clarifications are answered with answer_clarification, not revised');
    const b = p.body;
    const blocks = list<Ref>(b.blocks);
    for (const r of blocks) ctx.store.get(r);
    return enqueueClarification(ctx, {
      issue: str(b.issue, 'issue'),
      conflicting_facts: list(b.conflicting_facts),
      answer_source: b.answer_source === 'client' ? 'client' : 'auditor',
      options: list(b.options),
      recommendation: textOrNull(b.recommendation),
      owner: textOrNull(b.owner) ?? 'auditor',
      blocks,
      priority: Number.isInteger(b.priority) ? b.priority : 50,
      coalesced: [],
      dedupe_key: textOrNull(b.dedupe_key) ?? digest(String(b.issue).trim().toLowerCase()),
      status: 'queued',
      answer: null,
      next_action: textOrNull(b.next_action) ?? 'answer on the trusted decision screen',
    });
  },

  interpretation(ctx, p) {
    if (p.base) fail('invalid_request', 'interpretations are decided with confirm_interpretations');
    const b = p.body;
    const inputs = list<Ref>(b.captured_inputs);
    if (!inputs.length) fail('invalid_request', 'an interpretation must link the captured input it interprets');
    for (const r of inputs) ctx.store.get(r, 'captured_input');
    const proposed = b.proposed ?? {};
    if (!STATEMENT_KINDS.includes(proposed.kind)) fail('invalid_request', 'proposed.kind is required');
    if (!MODEL_AFFILIATIONS.includes(proposed.affiliation)) fail('invalid_request', 'proposed.affiliation is required');
    const units = list<Ref>(proposed.audit_units);
    for (const u of units) ctx.store.get(u, 'audit_unit');
    const ref = ctx.tx.create(
      'interpretation',
      {
        captured_inputs: inputs,
        proposed: { kind: proposed.kind, affiliation: proposed.affiliation, statement: str(proposed.statement, 'proposed.statement'), audit_units: units },
        status: 'proposed',
        resulting_statement: null,
      },
      inputs,
    );
    return { interpretation: ref, status: 'proposed' };
  },

  audit_unit(ctx, p) {
    const b = p.body;
    if (p.base) {
      const cur = ctx.store.mustHead(p.base.record_id, 'audit_unit');
      requireAgentAuthored(ctx, cur.record_id);
      if (ctx.principal.channel === 'worker' && cur.body.review_status === 'reviewed') {
        fail('permission_denied', 'a reviewed unit changes only through the auditor; propose a new unit or a gap');
      }
      // Coverage facts change the unit's meaning: its earlier review no longer covers this revision.
      const meaning = ['entry_points', 'state_writers', 'dependencies', 'functions', 'gaps'].some((k) => b[k] !== undefined);
      const ref = ctx.tx.revise(p.base.record_id, 'audit_unit', (prev) => {
        // Review flags on functions are set only by record_flow_review decisions.
        const reviewedBefore = new Map(prev.functions.map((f) => [f.name, f.reviewed]));
        const functions = b.functions
          ? list<{ name: string }>(b.functions).map((f) => ({ name: String(f.name), reviewed: meaning ? false : (reviewedBefore.get(String(f.name)) ?? false) }))
          : prev.functions;
        return {
          ...prev,
          ...(b.entry_points ? { entry_points: list<any>(b.entry_points) } : {}),
          ...(b.state_writers ? { state_writers: list<any>(b.state_writers) } : {}),
          ...(b.dependencies ? { dependencies: list<any>(b.dependencies) } : {}),
          ...(b.risk_rationale ? { risk_rationale: String(b.risk_rationale) } : {}),
          ...(b.planned_methods ? { planned_methods: list<any>(b.planned_methods) } : {}),
          ...(b.lead_generator_coverage ? { lead_generator_coverage: list<any>(b.lead_generator_coverage) } : {}),
          functions,
          ...(b.evidence ? { evidence: [...prev.evidence, ...list<AnyRef>(b.evidence)] } : {}),
          // Gaps are only ever added by a proposal, never removed.
          ...(b.gaps ? { gaps: [...prev.gaps, ...list<string>(b.gaps).filter((g) => !prev.gaps.includes(g))] } : {}),
          // review_status and reviewed_revision are decision owned; a change of meaning demotes a review.
          review_status: meaning && prev.review_status === 'reviewed' ? 'partial' : prev.review_status,
        };
      });
      return { audit_unit: ref, review_status_reset: meaning && cur.body.review_status === 'reviewed' };
    }
    if (!AUDIT_UNIT_KINDS.includes(b.kind)) fail('invalid_request', 'audit unit kind is required');
    // New units start unreviewed: function review flags come only from record_flow_review.
    b.functions = list<{ name: string }>(b.functions).map((f) => ({ name: String(f.name), reviewed: false }));
    const ref = ctx.tx.create('audit_unit', {
      kind: b.kind,
      name: str(b.name, 'name'),
      entry_points: list<any>(b.entry_points),
      state_writers: list<any>(b.state_writers),
      dependencies: list<any>(b.dependencies),
      risk_rationale: textOrNull(b.risk_rationale) ?? '',
      planned_methods: list<any>(b.planned_methods),
      lead_generator_coverage: list<any>(b.lead_generator_coverage),
      functions: list<any>(b.functions),
      reviewed_revision: null,
      review_status: 'not_started',
      first_presentation: null,
      evidence: list(b.evidence),
      gaps: list<any>(b.gaps),
    });
    return { audit_unit: ref };
  },

  property(ctx, p) {
    const b = p.body;
    if (p.base) {
      const cur = ctx.store.mustHead(p.base.record_id, 'property');
      requireWorkerScope(ctx, cur.body.investigation?.record_id ?? null);
      if (ctx.principal.channel === 'worker' && !cur.body.investigation) requireAgentAuthored(ctx, cur.record_id);
      // Adequacy comes from the challenger or the auditor, as for investigations.
      if (b.adequacy && !(ctx.principal.channel === 'auditor' || ctx.principal.grant?.role === 'challenger')) {
        fail('permission_denied', 'only the challenger or the auditor records adequacy');
      }
      if (b.adequacy?.status === 'sufficient') requireAdequacyEvidence(ctx, cur.body.investigation, list<AnyRef>(b.adequacy.evidence));
      if (b.adequacy?.status === 'not_applicable' && !textOrNull(b.adequacy.reason)) fail('invalid_request', 'adequacy not_applicable needs a reason');
      // Any revision of a property's meaning makes its semantic approval stale.
      const ref = ctx.tx.revise(p.base.record_id, 'property', (prev) => ({
        ...prev,
        ...(b.actions ? { actions: list(b.actions) } : {}),
        ...(b.check_oracle ? { check_oracle: String(b.check_oracle) } : {}),
        ...(b.units_and_bounds ? { units_and_bounds: String(b.units_and_bounds) } : {}),
        ...(b.excluded_actions ? { excluded_actions: list(b.excluded_actions) } : {}),
        ...(b.fixture ? { fixture: b.fixture } : {}),
        ...(b.adequacy ? { adequacy: b.adequacy } : {}),
        semantic_review:
          b.actions || b.check_oracle || b.units_and_bounds || b.excluded_actions
            ? { decision: prev.semantic_review.decision, status: prev.semantic_review.decision ? 'stale' : 'pending' }
            : prev.semantic_review,
        // A change of meaning also voids adequacy established for the earlier meaning.
        ...(b.actions || b.check_oracle || b.units_and_bounds || b.excluded_actions ? { adequacy: { status: 'pending' as const, reason: 'property meaning changed', evidence: [] } } : {}),
      }));
      return { property: ref };
    }
    const ref = ctx.tx.create('property', {
      investigation: b.investigation ?? null,
      intended_behavior: list(b.intended_behavior),
      actors: list(b.actors),
      actions: list(b.actions),
      units_and_bounds: textOrNull(b.units_and_bounds) ?? '',
      environment_assumptions: list(b.environment_assumptions),
      check_oracle: str(b.check_oracle, 'check_oracle'),
      excluded_actions: list(b.excluded_actions),
      fixture: b.fixture ?? null,
      semantic_review: { decision: null, status: 'pending' },
      adequacy: { status: 'pending', reason: null, evidence: [] },
    });
    return { property: ref };
  },

  behavioral_correspondence(ctx, p) {
    const b = p.body;
    const unit = b.audit_unit as Ref;
    ctx.store.get(unit, 'audit_unit');
    const designed = b.designed === null || b.designed === undefined ? null : list<Ref>(b.designed);
    const implemented = b.implemented === null || b.implemented === undefined ? null : list<Ref>(b.implemented);
    for (const r of [...(designed ?? []), ...(implemented ?? [])]) ctx.store.get(r, 'system_statement');
    const body: BodyByType['behavioral_correspondence'] = {
      audit_unit: unit,
      lens: str(b.lens, 'lens'),
      designed,
      implemented,
      missing_side: designed === null ? 'designed' : implemented === null ? 'implemented' : null,
      conditions: list(b.conditions),
      abstraction_limits: list(b.abstraction_limits),
      evidence: list(b.evidence),
      review_status: 'provisional',
    };
    const deps = [unit, ...(designed ?? []), ...(implemented ?? [])];
    if (p.base) requireAgentAuthored(ctx, p.base.record_id);
    const ref = p.base
      ? ctx.tx.revise(p.base.record_id, 'behavioral_correspondence', () => body, { depends_on: deps })
      : ctx.tx.create('behavioral_correspondence', body, deps);
    return { correspondence: ref };
  },

  behavioral_comparison(ctx, p) {
    const b = p.body;
    const corrs = list<Ref>(b.correspondences);
    // The comparison carries the intent timing of the auditor intent it relies on (DEC-009 Q-023).
    const timings = new Set<'before_walkthrough' | 'after_walkthrough'>();
    for (const c of corrs) {
      const corr = ctx.store.get(c, 'behavioral_correspondence');
      for (const s of corr.body.designed ?? []) {
        const st = ctx.store.get(s, 'system_statement');
        if (st.body.intent_timing) timings.add(st.body.intent_timing);
      }
    }
    const body: BodyByType['behavioral_comparison'] = {
      correspondences: corrs,
      examined: str(b.examined, 'examined'),
      bounds: str(b.bounds, 'bounds'),
      coverage: b.coverage,
      result: b.result,
      supporting: list(b.supporting),
      refuting: list(b.refuting),
      uncertainty: textOrNull(b.uncertainty) ?? '',
      relied_intent_timing: [...timings].sort(),
      owner: textOrNull(b.owner) ?? ctx.principal.principal,
      next_action: textOrNull(b.next_action) ?? '',
    };
    if (p.base) requireAgentAuthored(ctx, p.base.record_id);
    const ref = p.base
      ? ctx.tx.revise(p.base.record_id, 'behavioral_comparison', () => body, { depends_on: corrs })
      : ctx.tx.create('behavioral_comparison', body, corrs);
    return { comparison: ref, relied_intent_timing: body.relied_intent_timing };
  },

  behavioral_discrepancy(ctx, p) {
    const b = p.body;
    const cmp = b.comparison as Ref;
    ctx.store.get(cmp, 'behavioral_comparison');
    const body: BodyByType['behavioral_discrepancy'] = {
      comparison: cmp,
      claims: list(b.claims),
      deviation: str(b.deviation, 'deviation'),
      triggering_conditions: list(b.triggering_conditions),
      evidence: list(b.evidence),
      uncertainty: textOrNull(b.uncertainty) ?? '',
      distinguishing_check: textOrNull(b.distinguishing_check) ?? '',
      clarifications: list(b.clarifications),
      investigations: list(b.investigations),
      disposition: null,
    };
    const deps: AnyRef[] = [cmp, ...body.claims, ...body.investigations];
    if (p.base) requireAgentAuthored(ctx, p.base.record_id);
    const ref = p.base
      ? ctx.tx.revise(p.base.record_id, 'behavioral_discrepancy', () => body, { depends_on: deps })
      : ctx.tx.create('behavioral_discrepancy', body, deps);
    return { discrepancy: ref };
  },
};

// -----------------------------------------------------------------------------------------------
// Captured input (DEC-008 Q-018): the auditor's typed input, verbatim, from a channel the model
// cannot alter. Workers and the agent tool cannot call this.

export interface CaptureInputPayload {
  text: string;
  purpose?: 'conversation' | 'expectations_pre_step' | 'clarification_answer' | 'note';
  audit_unit?: Ref | null;
}

defineOperation<CaptureInputPayload>({
  name: 'capture_input',
  channels: ['capture'],
  mutating: true,
  handler(ctx, p) {
    if (typeof p?.text !== 'string') fail('invalid_request', 'text is required');
    const cap = ctx.principal.capture!;
    const purpose = p.purpose ?? 'conversation';
    if (purpose === 'expectations_pre_step' && !p.audit_unit) fail('invalid_request', 'the expectations pre-step names its flow');
    if (p.audit_unit) ctx.store.get(p.audit_unit, 'audit_unit');
    const ref = ctx.tx.create(
      'captured_input',
      {
        text: p.text,
        content_digest: digest(p.text),
        channel: { name: cap.name, program_digest: cap.program_digest },
        session: cap.session,
        captured_at: ctx.now,
        purpose,
        audit_unit: p.audit_unit ?? null,
      },
      p.audit_unit ? [p.audit_unit] : [],
    );
    return { captured_input: ref };
  },
});

// -----------------------------------------------------------------------------------------------
// Read-first mode (DEC-009 Q-023): presentations of implemented behavior are withheld until it ends.

defineOperation<Record<string, never>>({
  name: 'start_read_first',
  channels: ['auditor', 'screen'],
  mutating: true,
  handler(ctx) {
    const e = engagement(ctx.store);
    if (e.body.read_first && e.body.read_first.ended_at === null) fail('invalid_request', 'read-first mode is already active');
    if (e.body.read_first) fail('invalid_request', 'read-first mode was already used for this engagement');
    const ref = ctx.tx.revise(e.record_id, 'engagement', (b) => ({ ...b, read_first: { started_at: ctx.now, ended_at: null } }));
    return { engagement: ref };
  },
});

defineOperation<Record<string, never>>({
  name: 'end_read_first',
  channels: ['auditor', 'screen'],
  mutating: true,
  handler(ctx) {
    const e = engagement(ctx.store);
    if (!e.body.read_first || e.body.read_first.ended_at !== null) fail('invalid_request', 'read-first mode is not active');
    const ref = ctx.tx.revise(e.record_id, 'engagement', (b) => ({ ...b, read_first: { started_at: b.read_first!.started_at, ended_at: ctx.now } }));
    return { engagement: ref };
  },
});

/**
 * FR-11: a property counts as adequate only with a reviewed relevant fault that the campaign detects
 * (an `adequacy` job: the same campaign against a disposable copy with the fault injected shows a
 * counterexample), and never while its latest campaign had every meaningful action revert.
 */
function requireAdequacyEvidence(ctx: OpContext, investigation: Ref | null, evidence: AnyRef[]): void {
  if (!investigation) fail('evidence_requirement_unmet', 'adequacy needs the property campaign of an investigation');
  const active = activeSnapshot(ctx.store);
  const jobs = ctx.store.heads('job').filter((j) => j.body.investigation?.record_id === investigation.record_id);
  const evs = ctx.store.heads('evidence_artifact').filter((e) => e.body.job && jobs.some((j) => j.record_id === e.body.job!.record_id) && e.body.producer === 'trusted_runner');
  // The current campaign: the latest experiment with campaign statistics on the active snapshot.
  const campaign = evs
    .filter((e) => {
      const job = jobs.find((j) => j.record_id === e.body.job!.record_id);
      return job?.body.purpose === 'experiment' && !!e.body.structured_result?.campaign && (!active || job.body.snapshot.record_id === active.record_id);
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.record_id.localeCompare(b.record_id, 'en', { numeric: true }))
    .at(-1);
  if (!campaign) fail('evidence_requirement_unmet', 'no property campaign of this investigation ran on the active snapshot');
  const stats = campaign.body.structured_result!.campaign!;
  if (stats.runs === 0) {
    fail('evidence_requirement_unmet', `campaign ${campaign.record_id} ran nothing, so it proves nothing`);
  }
  if (stats.all_actions_reverted) {
    fail('evidence_requirement_unmet', `campaign ${campaign.record_id}: every action reverted, so it cannot count as adequate`);
  }
  if (campaign.body.structured_result!.result_type !== 'no_violation_observed') {
    fail('evidence_requirement_unmet', `campaign ${campaign.record_id} is ${campaign.body.structured_result!.result_type}, not a holding property`);
  }
  const campaignJob = campaign.body.job!.record_id;
  const detected = evidence.some((r) => {
    if ('artifact' in r) return false;
    const e = ctx.store.tryGet<'evidence_artifact'>(r);
    if (!e || e.type !== 'evidence_artifact' || !e.body.eligible) return false;
    const job = e.body.job ? ctx.store.head<'job'>(e.body.job.record_id) : undefined;
    return (
      job?.body.purpose === 'adequacy' &&
      job.body.investigation?.record_id === investigation.record_id &&
      job.body.lineage?.record_id === campaignJob &&
      isTargetSourceEdit(ctx.store, job, false) &&
      e.body.structured_result?.result_type === 'counterexample'
    );
  });
  if (!detected) fail('evidence_requirement_unmet', `cite adequacy evidence for campaign ${campaign.record_id}: the same campaign with a reviewed fault injected into a target source must show a counterexample`);
}
