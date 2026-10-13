import { fail } from '../core/errors.ts';
import { isArtifactRef, refKey, type AnyRef, type Ref } from '../core/refs.ts';
import {
  DEFAULT_ATTACKER_CHARTER,
  DISPOSITIONS,
  EVIDENCE_ROUTES,
  impactRank,
  isHighOrCritical,
  isMediumOrAbove,
  type Disposition,
  type EvidenceRoute,
  type PotentialImpact,
} from '../core/values.ts';
import { validate } from '../schema/jsonschema.ts';
import {
  engagementPolicySchema,
  type Anchor,
  type DispositionField,
  type EngagementPolicy,
  type LinkedClaim,
  type PotentialImpactField,
  type RecordEnvelope,
} from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { promoteHeld, releaseDependents } from './clarifications.ts';
import { activeSnapshot, deriveIntentTiming, engagement, impactField, isImpact, textOrNull } from './common.ts';
import { defineDecisionKind, need, requireEvidenceFirst, type DecisionPayload } from './framework.ts';
import { failedAttempts, hasRefutation, inboundLinks, isBoundPositiveControl, latestPacket, linkedEvidence, positiveControlStatus, replayStatus, type ClaimScope } from './packets.ts';

// Decision kinds owned by the comprehension, clarification and investigation flow
// (design/harness-interface-contracts.md, "Human decision kinds"; glossary "Dispositions and evidence").

function reviewedIncludes(p: DecisionPayload, r: Ref): void {
  if (!p.reviewed.some((x) => x.record_id === r.record_id && x.revision === r.revision)) {
    fail('display_required', `${r.record_id}@${r.revision} must be among the reviewed (rendered) revisions`);
  }
}

// -----------------------------------------------------------------------------------------------
// accept_scope_and_policy (stage 01)

defineDecisionKind({
  kind: 'accept_scope_and_policy',
  check(ctx, p) {
    const e = engagement(ctx.store);
    reviewedIncludes(p, { record_id: e.record_id, revision: e.revision });
    const policy = p.inputs.policy as EngagementPolicy;
    const issues = validate(engagementPolicySchema, policy);
    if (issues.length) fail('invalid_request', 'mandatory scope and policy fields are unresolved', { details: issues });
    // The narrowed charter starts from the broad default (DEC-008 Q-015); extra powers are recorded as raised.
    const extra = policy.attacker_charter.capabilities.filter((c) => !(DEFAULT_ATTACKER_CHARTER.capabilities as readonly string[]).includes(c));
    if (extra.length && !textOrNull(policy.attacker_charter.notes)) {
      fail('invalid_request', `capabilities beyond the default charter need a note explaining them: ${extra.join(', ')}`);
    }
  },
  apply({ ctx, payload, decision }) {
    const policy = payload.inputs.policy as EngagementPolicy;
    const e = engagement(ctx.store);
    const ref = ctx.tx.revise(e.record_id, 'engagement', (b) => ({ ...b, policy, policy_decision: decision }));
    // The trusted-role premise is an adopted assumption the report must list (AR-15).
    const raised = policy.attacker_charter.raised_roles;
    const premise = ctx.tx.create(
      'system_statement',
      {
        kind: 'assumption',
        affiliation: 'shared',
        origin: 'adopted_assumption',
        statement: policy.attacker_charter.privileged_roles_trusted
          ? `${policy.trusted_role_premise}${raised.length ? ` Raised roles (not trusted): ${raised.join(', ')}.` : ''}`
          : `Privileged roles are not trusted for this engagement. ${policy.trusted_role_premise}`,
        anchors: [],
        audit_units: [],
        captured_inputs: [],
        confirmation: decision,
        intent_timing: null,
        applicability: 'whole engagement',
        supporting: [],
        contradicting: [],
        review_status: 'reviewed',
        owner: 'auditor',
      },
      [decision],
    );
    return { engagement: ref, trusted_role_premise: premise };
  },
});

// -----------------------------------------------------------------------------------------------
// answer_clarification: recorded as intent or an assumption, never as observed behavior.

defineDecisionKind({
  kind: 'answer_clarification',
  check(ctx, p) {
    const clar = ctx.store.get(need<Ref>(p.inputs, 'clarification'), 'clarification');
    reviewedIncludes(p, { record_id: clar.record_id, revision: clar.revision });
    if (!['queued', 'presented', 'held'].includes(clar.body.status)) fail('invalid_request', `clarification is ${clar.body.status}`);
    need<string>(p.inputs, 'answer');
    const cap = ctx.store.get(need<Ref>(p.inputs, 'captured_input'), 'captured_input');
    if (cap.created_by.channel !== 'capture') fail('permission_denied', 'the answer must link captured input from the capture channel');
    const as = p.inputs.as ?? 'intent';
    if (!['intent', 'assumption'].includes(as as string)) fail('invalid_request', 'an answer is recorded as intent or an assumption');
  },
  apply({ ctx, payload, decision }) {
    const clarRef = payload.inputs.clarification as Ref;
    const clar = ctx.store.get(clarRef, 'clarification');
    const answer = String(payload.inputs.answer);
    const capRef = payload.inputs.captured_input as Ref;
    const units = (payload.inputs.audit_units as Ref[] | undefined) ?? [];
    const relayed = payload.inputs.relayed_from_auditee === true;
    const isUnknown = answer.trim().toLowerCase() === 'unknown';
    const kind = isUnknown ? 'unknown' : ((payload.inputs.as as 'intent' | 'assumption') ?? 'intent');
    const statement = ctx.tx.create(
      'system_statement',
      {
        kind,
        affiliation: kind === 'intent' ? 'designed' : 'shared',
        origin: relayed ? 'auditee_statement' : 'auditor_clarification',
        statement: isUnknown ? `Unknown: ${clar.body.issue}` : answer,
        anchors: [],
        audit_units: units,
        captured_inputs: [capRef],
        confirmation: decision,
        intent_timing: kind === 'intent' && !relayed ? deriveIntentTiming(ctx.store, [capRef], units) : null,
        applicability: 'active snapshot',
        supporting: [],
        contradicting: [],
        review_status: 'reviewed',
        owner: 'auditor',
      },
      [capRef, decision],
    );
    const updated = ctx.tx.revise(clar.record_id, 'clarification', (b) => ({
      ...b,
      status: 'answered',
      answer: { decision, value: answer },
      next_action: 'answered',
    }));
    for (const c of clar.body.coalesced) {
      ctx.tx.revise(c.record_id, 'clarification', (b) => ({ ...b, answer: { decision, value: answer }, next_action: `answered via ${clar.record_id}` }));
    }
    const released = releaseDependents(ctx, clar.record_id);
    const promoted = promoteHeld(ctx);
    return { statement, clarification: updated, released, promoted };
  },
});

// -----------------------------------------------------------------------------------------------
// confirm_interpretations (DEC-008 Q-018): each agent interpretation of captured input is confirmed,
// edited or rejected individually within one batch. Only then does it become intent or an assumption.

interface InterpretationChoice {
  interpretation: Ref;
  choice: 'confirm' | 'edit' | 'reject';
  edited_statement?: string;
}

defineDecisionKind({
  kind: 'confirm_interpretations',
  check(ctx, p) {
    const items = need<InterpretationChoice[]>(p.inputs, 'items');
    if (!Array.isArray(items) || !items.length) fail('invalid_request', 'items must list each interpretation with its own choice');
    const seen = new Set<string>();
    for (const it of items) {
      const env = ctx.store.get(it.interpretation, 'interpretation');
      reviewedIncludes(p, it.interpretation);
      if (seen.has(env.record_id)) fail('invalid_request', `${env.record_id} appears twice`);
      seen.add(env.record_id);
      if (env.body.status !== 'proposed') fail('invalid_request', `${env.record_id} was already decided`);
      if (!['confirm', 'edit', 'reject'].includes(it.choice)) fail('invalid_request', `choose confirm, edit or reject for ${env.record_id}`);
      if (it.choice === 'edit' && !textOrNull(it.edited_statement)) fail('invalid_request', `edited statement for ${env.record_id} is empty`);
      for (const c of env.body.captured_inputs) {
        if (ctx.store.get(c, 'captured_input').created_by.channel !== 'capture') fail('permission_denied', 'interpretations must link captured input');
      }
    }
  },
  apply({ ctx, payload, decision }) {
    const results: { interpretation: Ref; status: string; statement: Ref | null }[] = [];
    for (const it of payload.inputs.items as InterpretationChoice[]) {
      const env = ctx.store.get(it.interpretation, 'interpretation');
      let statement: Ref | null = null;
      if (it.choice !== 'reject') {
        const pr = env.body.proposed;
        statement = ctx.tx.create(
          'system_statement',
          {
            kind: pr.kind,
            affiliation: pr.affiliation,
            origin: 'auditor_clarification',
            statement: it.choice === 'edit' ? it.edited_statement! : pr.statement,
            anchors: [],
            audit_units: pr.audit_units,
            captured_inputs: env.body.captured_inputs,
            confirmation: decision,
            intent_timing: pr.kind === 'intent' ? deriveIntentTiming(ctx.store, env.body.captured_inputs, pr.audit_units) : null,
            applicability: 'active snapshot',
            supporting: [],
            contradicting: [],
            review_status: 'reviewed',
            owner: 'auditor',
          },
          [...env.body.captured_inputs, decision],
        );
      }
      const status = it.choice === 'confirm' ? 'confirmed' : it.choice === 'edit' ? 'edited' : 'rejected';
      ctx.tx.revise(env.record_id, 'interpretation', (b) => ({ ...b, status, resulting_statement: statement }));
      results.push({ interpretation: it.interpretation, status, statement });
    }
    return { items: results };
  },
});

// -----------------------------------------------------------------------------------------------
// approve_semantics: property / check-oracle meaning. Stale if the oracle or action space changes.

defineDecisionKind({
  kind: 'approve_semantics',
  check(ctx, p) {
    const prop = ctx.store.get(need<Ref>(p.inputs, 'property'), 'property');
    reviewedIncludes(p, { record_id: prop.record_id, revision: prop.revision });
    const actions = p.inputs.actions as string[] | undefined;
    if (actions && JSON.stringify([...actions].sort()) !== JSON.stringify([...prop.body.actions].sort())) {
      fail('stale_dependency', 'the action space differs from the reviewed property');
    }
  },
  apply({ ctx, payload, decision }) {
    const r = payload.inputs.property as Ref;
    const ref = ctx.tx.revise(r.record_id, 'property', (b) => ({ ...b, semantic_review: { decision, status: 'approved' } }));
    return { property: ref };
  },
});

// -----------------------------------------------------------------------------------------------
// record_flow_review (DEC-005; FR-32): the unit becomes `reviewed` at the active snapshot.

defineDecisionKind({
  kind: 'record_flow_review',
  check(ctx, p) {
    const unit = ctx.store.get(need<Ref>(p.inputs, 'audit_unit'), 'audit_unit');
    reviewedIncludes(p, { record_id: unit.record_id, revision: unit.revision });
    if (unit.body.review_status === 'excluded') fail('invalid_request', 'an excluded unit is not reviewed');
    if (!activeSnapshot(ctx.store)) fail('invalid_request', 'register a target snapshot before recording a flow review');
    for (const c of (p.inputs.comparisons as Ref[] | undefined) ?? []) {
      ctx.store.get(c, 'behavioral_comparison');
      reviewedIncludes(p, c);
    }
  },
  apply({ ctx, payload, decision }) {
    const r = payload.inputs.audit_unit as Ref;
    const snapshot = activeSnapshot(ctx.store)!;
    const reviewedFns = new Set((payload.inputs.reviewed_functions as string[] | undefined) ?? []);
    const gaps = (payload.inputs.gaps as string[] | undefined) ?? [];
    const ref = ctx.tx.revise(r.record_id, 'audit_unit', (b) => ({
      ...b,
      review_status: 'reviewed',
      reviewed_revision: { snapshot, decision },
      functions: b.functions.map((f) => (reviewedFns.has(f.name) ? { ...f, reviewed: true } : f)),
      gaps: [...b.gaps, ...gaps.filter((g) => !b.gaps.includes(g))],
    }));
    return { audit_unit: ref, reviewed_at: snapshot };
  },
});

// -----------------------------------------------------------------------------------------------
// dispose_investigation: the impact-scaled disposition table (DEC-008 Q-016), evidence-first order
// at potential High/Critical (Q-017), each linked claim decided separately (DEC-009 Q-026).

export interface DispositionInputs {
  disposition: Disposition;
  /** The auditor's potential-impact estimate; below the agent's needs `impact_lower_reason`. */
  potential_impact?: PotentialImpact | null;
  impact_lower_reason?: string | null;
  severity?: string;
  severity_basis?: string;
  evidence_route?: EvidenceRoute;
  /** rejected */
  decisive_evidence?: AnyRef[];
  countercondition?: string;
  countercondition_scope?: string;
  positive_control?: Ref | null;
  /** no_finding_within_bounds */
  bounds?: { methods: string[]; variants_tried: string; budget: string; attacker_charter: string; assumptions: string[] };
  /** triaged_out */
  triage_reason?: string;
  /** disputed */
  interpretations?: string[];
  distinguishing_check?: string;
  /** deferred */
  residual_concern?: string;
  revisit_condition?: string;
  /** alternative_argument (DEC-004) */
  alternative?: { why_impractical: string; why_sufficient: string; limits: string; failed_replays_addressed?: string };
  /** accepted: the finding's structured content */
  finding?: { title: string; mechanism: string; impact: string; prerequisites?: string[]; affected_code?: Anchor[]; applicability?: string; guarantee?: string };
}

export interface DisposeInputs extends DispositionInputs {
  packet: Ref;
  investigation: Ref;
  linked_claims?: (DispositionInputs & { id: string })[];
}

function effectiveFor(field: PotentialImpactField, d: DispositionInputs): PotentialImpactField {
  const auditor = d.potential_impact ?? field.auditor;
  if (auditor && !isImpact(auditor)) fail('invalid_request', 'invalid potential impact');
  const lower = textOrNull(d.impact_lower_reason);
  if (auditor && field.agent && impactRank(auditor) < impactRank(field.agent) && !lower) {
    fail('invalid_request', `setting potential impact below the agent's estimate (${field.agent}) needs a recorded reason`);
  }
  return impactField(field.agent, auditor ?? null, lower ?? field.auditor_lower_reason);
}

function anchorsOf(inv: RecordEnvelope<'investigation'>, d: DispositionInputs): Anchor[] {
  return d.finding?.affected_code?.length ? d.finding.affected_code : inv.body.anchors;
}

/**
 * Enforce the disposition table for one claim (the investigation question or one linked claim).
 * `executable` follows the investigation; replay and positive control come from runner evidence.
 */
function enforceDisposition(
  store: RecordStore,
  inv: RecordEnvelope<'investigation'>,
  d: DispositionInputs,
  impact: PotentialImpact,
  label: string,
  scope: ClaimScope,
): void {
  if (!DISPOSITIONS.includes(d.disposition)) fail('invalid_request', `${label}: invalid disposition`);
  const unmet = (why: string): never => fail('evidence_requirement_unmet', `${label}: ${why}`);
  switch (d.disposition) {
    case 'accepted': {
      if (!textOrNull(d.severity)) unmet('a severity under the engagement rubric is required');
      if (!d.finding || !textOrNull(d.finding.title) || !textOrNull(d.finding.mechanism) || !textOrNull(d.finding.impact)) {
        fail('invalid_request', `${label}: the finding's title, mechanism and impact are required`);
      }
      const route = d.evidence_route;
      if (!route || !EVIDENCE_ROUTES.includes(route)) unmet('an evidence route is required');
      if (isMediumOrAbove(impact)) {
        if (route === 'code_argument') unmet(`potential impact ${impact} needs executable_replay or alternative_argument, not code_argument`);
        if (route === 'executable_replay' && replayStatus(store, inv.record_id, true, scope) !== 'succeeded') {
          unmet('executable_replay needs a clean replay receipt that demonstrates the violation');
        }
        if (route === 'alternative_argument') {
          const a = d.alternative;
          if (!a || !textOrNull(a.why_impractical) || !textOrNull(a.why_sufficient) || !textOrNull(a.limits)) {
            unmet('alternative_argument needs why a runnable PoC is impractical, why the argument suffices, and its limits (DEC-004)');
          }
          if (replayStatus(store, inv.record_id, false, scope) === 'failed' && !textOrNull(a!.failed_replays_addressed)) {
            unmet('a failed replay of the same claim exists; the decision must address it');
          }
        }
      } else if (route === 'code_argument' && !anchorsOf(inv, d).length) {
        unmet('a code argument needs source anchors');
      }
      return;
    }
    case 'rejected': {
      if (!d.decisive_evidence?.length) unmet('decisive-evidence references are required');
      for (const r of d.decisive_evidence!) if (!isArtifactRef(r)) store.get(r);
      if (!textOrNull(d.countercondition) || !textOrNull(d.countercondition_scope)) unmet('state the countercondition and its scope');
      if (inv.body.executable && isHighOrCritical(impact)) {
        const pc = positiveControlStatus(store, inv.record_id, true, scope);
        if (pc !== 'shows_violation') {
          unmet(`rejecting an executable claim at potential ${impact} impact needs a guard-removed rerun of the same experiment for this claim that shows the violation (positive control: ${pc})`);
        }
        if (d.positive_control) {
          const ev = store.get(d.positive_control, 'evidence_artifact');
          const job = ev.body.job ? store.head<'job'>(ev.body.job.record_id) : undefined;
          if (ev.body.structured_result?.result_type !== 'counterexample' || !job || !isBoundPositiveControl(store, inv.record_id, job)) {
            unmet('the cited positive control is not a guard-removed rerun of this claim\'s experiment that shows the violation');
          }
        }
      }
      return;
    }
    case 'no_finding_within_bounds': {
      const b = d.bounds;
      if (!b || !Array.isArray(b.methods) || !b.methods.length || !textOrNull(b.variants_tried) || !textOrNull(b.budget) || !textOrNull(b.attacker_charter) || !Array.isArray(b.assumptions)) {
        unmet('record the bounds: methods, variants tried, budget, attacker charter and assumptions');
      }
      // A refutation without a violating positive control supports neither rejected nor this.
      if (inv.body.executable && isHighOrCritical(impact)) {
        const refuted = hasRefutation(store, inv, scope);
        const pc = positiveControlStatus(store, inv.record_id, false, scope);
        if ((refuted || pc === 'no_violation') && pc !== 'shows_violation') {
          unmet(`a refutation at potential ${impact} impact without a violating positive control cannot support no_finding_within_bounds; request more work, dispute or defer`);
        }
      }
      return;
    }
    case 'triaged_out': {
      if (!textOrNull(d.triage_reason) || /\n/.test(d.triage_reason!.trim())) unmet('a one-line reason is required');
      if (!d.potential_impact || !['low', 'info'].includes(d.potential_impact)) {
        unmet('triaged_out needs the auditor to confirm a potential impact of low or info');
      }
      if (!['low', 'info'].includes(impact)) unmet(`effective potential impact is ${impact}; triaged_out applies only to low or info`);
      return;
    }
    case 'disputed': {
      if (!Array.isArray(d.interpretations) || d.interpretations.filter((x) => textOrNull(x)).length < 2) unmet('record the competing interpretations');
      if (!textOrNull(d.distinguishing_check)) unmet('record what would distinguish the interpretations');
      return;
    }
    case 'deferred': {
      if (!textOrNull(d.residual_concern) || !textOrNull(d.revisit_condition)) unmet('record the residual concern and a revisit condition');
      return;
    }
  }
}

defineDecisionKind({
  kind: 'dispose_investigation',
  check(ctx, p) {
    const i = p.inputs as unknown as DisposeInputs;
    const packet = ctx.store.get(need<Ref>(p.inputs, 'packet'), 'review_packet');
    const inv = ctx.store.get(need<Ref>(p.inputs, 'investigation'), 'investigation');
    reviewedIncludes(p, i.packet);
    reviewedIncludes(p, i.investigation);
    if (refKey(packet.body.investigation) !== refKey(i.investigation)) fail('stale_dependency', 'the packet was built for another revision of the investigation');
    const latest = latestPacket(ctx.store, inv.record_id);
    if (latest?.record_id !== packet.record_id) fail('stale_dependency', `a newer packet ${latest?.record_id} exists`);
    if (inv.body.work_state !== 'ready_for_review') fail('invalid_request', `investigation is ${inv.body.work_state}, not ready_for_review`);
    if (inv.body.disposition) fail('invalid_request', 'the investigation already has a disposition');

    // New linked evidence since the packet was built makes the approval stale.
    const links = inboundLinks(ctx.store, inv.record_id);
    if (links.digest !== packet.body.inbound_link_digest || links.watermark !== packet.body.evidence_watermark) {
      fail('stale_dependency', 'new evidence or links arrived after the packet was built; review the updated packet', {
        details: { inbound_now: links.refs, watermark_now: links.watermark, watermark_reviewed: packet.body.evidence_watermark },
      });
    }

    const mainImpact = effectiveFor(inv.body.potential_impact, i).effective;
    const claimInputs = new Map((i.linked_claims ?? []).map((c) => [c.id, c]));
    for (const c of inv.body.linked_claims) {
      if (!claimInputs.has(c.id)) fail('invalid_request', `linked claim ${c.id} needs its own disposition in this review`);
    }
    for (const id of claimInputs.keys()) {
      if (!inv.body.linked_claims.some((c) => c.id === id)) fail('invalid_request', `unknown linked claim ${id}`);
    }
    const impacts = [mainImpact, ...inv.body.linked_claims.map((c) => effectiveFor(c.potential_impact, claimInputs.get(c.id)!).effective)];
    if (impacts.some((x) => isHighOrCritical(x))) {
      // DEC-008 Q-017: evidence, challenger and evidence quality before the proposed disposition.
      const receipt = ctx.store.get(p.display_receipt, 'display_receipt');
      requireEvidenceFirst(receipt);
    }
    enforceDisposition(ctx.store, inv, i, mainImpact, 'investigation question', { linkedClaimId: null });
    for (const c of inv.body.linked_claims) {
      const ci = claimInputs.get(c.id)!;
      enforceDisposition(ctx.store, inv, ci, effectiveFor(c.potential_impact, ci).effective, `linked claim ${c.id}`, { linkedClaimId: c.id });
    }
    return { inbound_link_digest: links.digest, evidence_watermark: links.watermark, unreviewed: packet.body.unreviewed_statements };
  },
  apply({ ctx, payload, decision }) {
    const i = payload.inputs as unknown as DisposeInputs;
    const inv = ctx.store.get(i.investigation, 'investigation');
    const disp = (value: Disposition): DispositionField => ({ value, decision });
    const findings: Ref[] = [];
    const mkFinding = (d: DispositionInputs, linked: LinkedClaim | null, impact: PotentialImpact) => {
      const f = d.finding!;
      findings.push(
        ctx.tx.create(
          'finding',
          {
            investigation: i.investigation,
            linked_claim_id: linked?.id ?? null,
            guarantee: linked?.guarantee ?? f.guarantee ?? inv.body.guarantees[0] ?? 'unspecified guarantee',
            title: f.title,
            mechanism: f.mechanism,
            prerequisites: f.prerequisites ?? inv.body.prerequisites,
            impact: f.impact,
            affected_code: anchorsOf(inv, d),
            severity: d.severity!,
            severity_basis: d.severity_basis ?? `engagement rubric; potential impact ${impact}`,
            evidence_route: d.evidence_route!,
            acceptance: decision,
            applicability: f.applicability ?? 'the reviewed target snapshot and premises',
            client_responses: [],
            fix_assessments: [],
          },
          [decision],
        ),
      );
    };
    const mainField = effectiveFor(inv.body.potential_impact, i);
    const main: ClaimScope = { linkedClaimId: null };
    const pcStatus = positiveControlStatus(ctx.store, inv.record_id, inv.body.executable && i.disposition === 'rejected' && isHighOrCritical(mainField.effective), main);
    const replay = replayStatus(ctx.store, inv.record_id, i.disposition === 'accepted' && inv.body.executable && isMediumOrAbove(mainField.effective), main);
    const claimInputs = new Map((i.linked_claims ?? []).map((c) => [c.id, c]));
    const ref = ctx.tx.revise(inv.record_id, 'investigation', (b) => ({
      ...b,
      potential_impact: mainField,
      disposition: disp(i.disposition),
      work_state: 'closed',
      proof_status: { ...b.proof_status, positive_control: pcStatus, replay },
      linked_claims: b.linked_claims.map((c) => {
        const ci = claimInputs.get(c.id)!;
        const field = effectiveFor(c.potential_impact, ci);
        const scope = { linkedClaimId: c.id };
        const proof = {
          ...c.proof_status,
          positive_control: positiveControlStatus(ctx.store, inv.record_id, inv.body.executable && ci.disposition === 'rejected' && isHighOrCritical(field.effective), scope),
          replay: replayStatus(ctx.store, inv.record_id, ci.disposition === 'accepted' && inv.body.executable && isMediumOrAbove(field.effective), scope),
        };
        return { ...c, potential_impact: field, disposition: disp(ci.disposition), proof_status: proof };
      }),
    }));
    if (i.disposition === 'accepted') mkFinding(i, null, mainField.effective);
    for (const c of inv.body.linked_claims) {
      const ci = claimInputs.get(c.id)!;
      if (ci.disposition === 'accepted') mkFinding(ci, c, effectiveFor(c.potential_impact, ci).effective);
    }
    return {
      investigation: ref,
      disposition: i.disposition,
      findings,
      failed_attempts: failedAttempts(ctx.store, inv.record_id),
      evidence: linkedEvidence(ctx.store, inv.record_id).map((e) => ({ record_id: e.record_id, revision: e.revision })),
    };
  },
});

