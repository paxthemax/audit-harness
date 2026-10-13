import { digestJson } from '../core/hash.ts';
import { refKey, type Ref } from '../core/refs.ts';
import { ACCEPTED_RESIDUAL_RISKS, type PotentialImpact } from '../core/values.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { RecordEnvelope } from '../schema/records.ts';
import { controlStatus, diagramStatus } from '../comprehension/comprehension.ts';
import {
  atOrAbove,
  claimInputs,
  conditionalOn,
  decisionBody,
  dependentConclusions,
  engagementHead,
  fixLabelOf,
  freshnessIndex,
  refOf,
} from './derive.ts';

// The controller-computed required set (FR-22; design/audit-harness.md, "Confirmation reports and PoC
// packages"; design/harness-state-and-execution.md, "Report manifest"). Every report and every
// closure review is checked against it: an item a selection omits needs an audience or redaction
// reason, and closure needs an explanation for every unresolved or incomplete item.
//
// Items are either *generated* (the controller always writes them into the report from records: scope,
// exclusions, coverage per audit unit, assumptions and trust premises, accepted residual risks,
// unreviewed-change gaps, the mechanical carry-forward attestation) or *selectable* (the auditor's
// frozen selection includes them or gives a reason: findings, unresolved items, blocked work,
// appendix items, tool failures). "Unresolved" is derived here, never stored.

export type RequiredCategory =
  | 'accepted_finding'
  | 'accepted_linked_claim'
  | 'unresolved'
  | 'blocked_or_incomplete'
  | 'rejection_above_threshold'
  | 'no_finding_within_bounds'
  | 'triaged_out'
  | 'assumption'
  | 'trust_premise'
  | 'attacker_charter'
  | 'accepted_residual_risk'
  | 'audit_unit'
  | 'excluded_scope'
  | 'unreviewed_change_gap'
  | 'tool_failure'
  | 'carry_forward_attestation'
  | 'baseline_control'
  | 'kb_diagram_affected'
  | 'lead_group'
  | 'accounting_view';

export interface RequiredItem {
  /** Stable key: `<category>:<record_id>[#claim|:n]`, or `residual:<Q-id>` for non-record items. */
  key: string;
  /** Exact current revision of the record that carries the item; null for accepted residual risks. */
  ref: Ref | null;
  category: RequiredCategory;
  reason: string;
  /** Always written by the controller; the selection cannot omit it. */
  generated: boolean;
  /** Unresolved (glossary): no current disposition, disputed, deferred, affected, possibly affected. */
  unresolved: boolean;
  /** Unperformed or unfinished work: closing as `closed` is refused while any exists. */
  incomplete: boolean;
  /** Blocks closure and export outright (unattested mechanical carry-forward). */
  blocking: string | null;
  detail: Record<string, unknown>;
}

export interface RequiredSet {
  engagement: Ref;
  snapshot: Ref | null;
  rejection_listing_threshold: PotentialImpact | null;
  items: RequiredItem[];
  /** Binds a closure review or preview to exactly this set. */
  digest: string;
}

export function computeRequiredSet(store: RecordStore): RequiredSet {
  const eng = engagementHead(store);
  const policy = eng.body.policy;
  const threshold = policy?.rejection_listing_threshold ?? null;
  const items: RequiredItem[] = [];
  const add = (i: Omit<RequiredItem, 'detail' | 'blocking' | 'unresolved' | 'incomplete' | 'generated'> & Partial<RequiredItem>) =>
    items.push({ generated: false, unresolved: false, incomplete: false, blocking: null, detail: {}, ...i });
  const engRef = refOf(eng);
  const fresh = freshnessIndex(store);

  // --- Scope, trust premises, attacker charter, residual risks (generated) -----------------------
  if (policy) {
    policy.exclusions.forEach((x, n) =>
      add({ key: `excluded_scope:${eng.record_id}:${n}`, ref: engRef, category: 'excluded_scope', generated: true, reason: `excluded: ${x.item}`, detail: x }),
    );
    add({
      key: `trust_premise:${eng.record_id}`,
      ref: engRef,
      category: 'trust_premise',
      generated: true,
      reason: 'privileged roles are trusted unless the auditor raised them',
      detail: {
        premise: policy.trusted_role_premise,
        privileged_roles_trusted: policy.attacker_charter.privileged_roles_trusted,
        raised_roles: policy.attacker_charter.raised_roles,
      },
    });
    add({
      key: `attacker_charter:${eng.record_id}`,
      ref: engRef,
      category: 'attacker_charter',
      generated: true,
      reason: 'attacker charter every conclusion was examined under',
      detail: { capabilities: policy.attacker_charter.capabilities, excluded: policy.attacker_charter.excluded },
    });
  }
  for (const r of ACCEPTED_RESIDUAL_RISKS) {
    add({ key: `residual:${r.id}`, ref: null, category: 'accepted_residual_risk', generated: true, reason: r.statement, detail: { id: r.id } });
  }

  // --- Coverage: every audit unit with review status and reviewed revision (generated) -----------
  const comparisonsByUnit = comparisonIndex(store);
  for (const u of store.heads('audit_unit')) {
    const status = u.body.review_status;
    const cmps = comparisonsByUnit.get(u.record_id) ?? [];
    add({
      key: `audit_unit:${u.record_id}`,
      ref: refOf(u),
      category: 'audit_unit',
      generated: true,
      incomplete: status === 'not_started' || status === 'partial',
      reason: `audit unit ${u.body.name}: ${status}`,
      detail: {
        name: u.body.name,
        kind: u.body.kind,
        review_status: status,
        reviewed_revision: u.body.reviewed_revision,
        gaps: u.body.gaps,
        comparisons: cmps.map((c) => ({
          ref: refOf(c),
          coverage: c.body.coverage,
          result: c.body.result,
          intent_timing: [...new Set(c.body.relied_intent_timing)],
        })),
      },
    });
    if (status === 'excluded') {
      add({ key: `excluded_scope:${u.record_id}`, ref: refOf(u), category: 'excluded_scope', generated: true, reason: `audit unit ${u.body.name} excluded by a scope decision` });
    }
  }

  // --- Baseline controls (FR-28): examined evidence or a visible gap (generated) -----------------
  for (const c of store.heads('control_item')) {
    const status = controlStatus(c.body);
    add({
      key: `baseline_control:${c.record_id}`,
      ref: refOf(c),
      category: 'baseline_control',
      generated: true,
      incomplete: status === 'open_gap' || status === 'applicability_unknown',
      reason: `baseline control ${c.body.control_id}: ${status}`,
      detail: { control_id: c.body.control_id, title: c.body.title, source: c.body.source, status, evidence: c.body.evidence, gaps: c.body.gaps, applicability_reason: c.body.applicability_reason },
    });
  }

  // --- KB diagrams whose depicted statements changed are unresolved coverage items (generated) ----
  for (const d of store.heads('kb_diagram')) {
    const st = diagramStatus(store, d.record_id);
    if (st.status !== 'affected') continue;
    add({
      key: `kb_diagram_affected:${d.record_id}`,
      ref: refOf(d),
      category: 'kb_diagram_affected',
      generated: true,
      unresolved: true,
      reason: `diagram for ${d.body.lens} is affected: depicted statements changed`,
      detail: { audit_unit: d.body.audit_unit, changed: st.changed },
    });
  }

  // --- Duplicate and root-cause groups: every member and origin is kept (generated) --------------
  for (const g of store.heads('lead_group')) {
    if (g.body.status === 'dissolved') continue;
    add({
      key: `lead_group:${g.record_id}`,
      ref: refOf(g),
      category: 'lead_group',
      generated: true,
      reason: `${g.body.relation} group (${g.body.status}) of ${g.body.members.length} leads`,
      detail: { relation: g.body.relation, status: g.body.status, members: g.body.members, origins: g.body.origins, proposed_cause: g.body.proposed_cause, dissent: g.body.dissent, chain_investigation: g.body.chain_investigation },
    });
  }

  // --- Accounting views (optional appendix rows, generated) ---------------------------------------
  for (const v of store.heads('accounting_view')) {
    add({
      key: `accounting_view:${v.record_id}`,
      ref: refOf(v),
      category: 'accounting_view',
      generated: true,
      reason: `accounting view (${v.body.review_status})`,
      detail: { audit_unit: v.body.audit_unit, conservation: v.body.conservation, units: v.body.units, rounding: v.body.rounding, review_status: v.body.review_status },
    });
  }

  // --- Investigations: findings, unresolved items, appendices, blocked work ----------------------
  const findings = store.heads('finding');
  const findingFor = (invId: string, claim: string | null) =>
    findings.find((f) => f.body.investigation.record_id === invId && f.body.linked_claim_id === claim);
  for (const inv of store.heads('investigation')) {
    const iref = refOf(inv);
    const claims: { claim: string | null; disposition: typeof inv.body.disposition; impact: PotentialImpact; label: string }[] = [
      { claim: null, disposition: inv.body.disposition, impact: inv.body.potential_impact.effective, label: inv.body.question },
      ...inv.body.linked_claims.map((c) => ({ claim: c.id, disposition: c.disposition, impact: c.potential_impact.effective, label: c.claim })),
    ];
    for (const c of claims) {
      const suffix = c.claim === null ? '' : `#${c.claim}`;
      const what = c.claim === null ? 'investigation' : `linked claim ${c.claim}`;
      const d = c.disposition?.value ?? null;
      const inputs = claimInputs(decisionBody(store, c.disposition?.decision)?.inputs, c.claim);
      const cond = conditionalOn(store, c.disposition?.decision);
      const detail = { claim: c.claim, question: c.label, potential_impact: c.impact, disposition: d, decision: c.disposition?.decision ?? null, conditional_on: cond };
      // A decision recorded as conditional on unreviewed statements says so wherever it appears.
      const condNote = cond.length ? ` (conditional on unreviewed statements ${cond.map(refKey).join(', ')})` : '';
      if (d === null) {
        add({
          key: `unresolved:${inv.record_id}${suffix}`,
          ref: iref,
          category: 'unresolved',
          unresolved: true,
          incomplete: true,
          reason: `${what} has no current disposition (work state ${inv.body.work_state}; potential impact ${c.impact})`,
          detail,
        });
      } else if (d === 'disputed' || d === 'deferred') {
        add({
          key: `unresolved:${inv.record_id}${suffix}`,
          ref: iref,
          category: 'unresolved',
          unresolved: true,
          reason: `${what} is ${d} (potential impact ${c.impact})${condNote}`,
          detail: { ...detail, inputs: pick(inputs, ['interpretations', 'distinguishing_check', 'residual_concern', 'revisit_condition']) },
        });
      } else if (d === 'accepted') {
        const f = findingFor(inv.record_id, c.claim);
        if (f) {
          add({
            key: `accepted_finding:${f.record_id}`,
            ref: refOf(f),
            category: c.claim === null ? 'accepted_finding' : 'accepted_linked_claim',
            reason: `accepted finding ${f.body.title} (severity ${f.body.severity})${condNote}`,
            detail: { ...detail, severity: f.body.severity, evidence_route: f.body.evidence_route, fix_label: fixLabelOf(store, f) },
          });
        } else {
          add({
            key: `accepted_linked_claim:${inv.record_id}${suffix}`,
            ref: iref,
            category: c.claim === null ? 'accepted_finding' : 'accepted_linked_claim',
            reason: `accepted ${what} without a finding record${condNote}`,
            detail,
          });
        }
      } else if (d === 'rejected') {
        if (threshold && atOrAbove(c.impact, threshold)) {
          add({
            key: `rejection_above_threshold:${inv.record_id}${suffix}`,
            ref: iref,
            category: 'rejection_above_threshold',
            reason: `${what} rejected at potential impact ${c.impact} (listing threshold ${threshold})${condNote}`,
            detail: { ...detail, inputs: pick(inputs, ['countercondition', 'countercondition_scope', 'decisive_evidence', 'positive_control']) },
          });
        }
      } else if (d === 'no_finding_within_bounds') {
        add({
          key: `no_finding_within_bounds:${inv.record_id}${suffix}`,
          ref: iref,
          category: 'no_finding_within_bounds',
          reason: `${what}: no finding within the stated bounds (not a refutation)${condNote}`,
          detail: { ...detail, bounds: inputs.bounds ?? null },
        });
      } else if (d === 'triaged_out') {
        add({
          key: `triaged_out:${inv.record_id}${suffix}`,
          ref: iref,
          category: 'triaged_out',
          reason: `${what} triaged out (supports no assurance claim)${condNote}`,
          detail: { ...detail, inputs: pick(inputs, ['triage_reason']) },
        });
      }
    }
    if (inv.body.work_state === 'blocked') {
      add({
        key: `blocked_or_incomplete:${inv.record_id}`,
        ref: iref,
        category: 'blocked_or_incomplete',
        incomplete: true,
        reason: `investigation blocked: ${inv.body.blocked_reason ?? 'no reason recorded'}`,
      });
    }
  }

  // A discrepancy is resolved by its own terminal disposition, or when an investigation it lists has
  // a terminal disposition; `disputed` and `deferred` stay unresolved (glossary).
  const TERMINAL = ['accepted', 'rejected', 'no_finding_within_bounds', 'triaged_out'];
  for (const disc of store.heads('behavioral_discrepancy')) {
    const d = disc.body.disposition?.value ?? null;
    const viaInvestigation = disc.body.investigations.some((r) => {
      const v = store.head<'investigation'>(r.record_id)?.body.disposition?.value;
      return v !== undefined && TERMINAL.includes(v);
    });
    if (d !== null && TERMINAL.includes(d)) continue;
    if (d === null && viaInvestigation) continue;
    if (d === null || d === 'disputed' || d === 'deferred') {
      add({
        key: `unresolved:${disc.record_id}`,
        ref: refOf(disc),
        category: 'unresolved',
        unresolved: true,
        incomplete: d === null,
        reason: d === null ? 'behavioral discrepancy has no current disposition' : `behavioral discrepancy is ${d}`,
        detail: { deviation: disc.body.deviation, disposition: d },
      });
    }
  }

  // --- Freshness: affected / possibly affected are unresolved; carry-forward is mechanical --------
  const attestations = new Map<string, Ref[]>();
  for (const [conclusionId, f] of fresh) {
    const head = store.head(conclusionId);
    if (!head) continue;
    if (f.body.value === 'affected' || f.body.value === 'possibly_affected') {
      add({
        key: `unresolved:fresh:${conclusionId}`,
        ref: refOf(head),
        category: 'unresolved',
        unresolved: true,
        reason: `conclusion is ${f.body.value} relative to the active snapshot`,
        detail: { freshness: f.body.value, freshness_record: refOf(f), unobserved: f.body.unobserved },
      });
    } else if (f.body.value === 'carried_forward_mechanical') {
      if (f.body.attestation) {
        const k = refKey(f.body.attestation);
        attestations.set(k, [...(attestations.get(k) ?? []), refOf(head)]);
      } else {
        add({
          key: `carry_forward_attestation:${f.record_id}`,
          ref: refOf(f),
          category: 'carry_forward_attestation',
          generated: true,
          blocking: 'unattested mechanical carry-forward',
          reason: `conclusion ${conclusionId} was carried forward mechanically without an attest_carry_forward decision`,
          detail: { conclusion: refOf(head) },
        });
      }
    }
  }
  for (const [k, conclusions] of attestations) {
    const [id, rev] = k.split('@');
    add({
      key: `carry_forward_attestation:${id}`,
      ref: { record_id: id, revision: Number(rev) },
      category: 'carry_forward_attestation',
      generated: true,
      reason: 'mechanical carry-forward attestation (labelled mechanical; not human review)',
      detail: { conclusions },
    });
  }

  // --- Assumptions with the conclusions that depend on them (generated) --------------------------
  for (const s of store.heads('system_statement')) {
    if (s.body.kind !== 'assumption') continue;
    if (s.body.review_status === 'rejected' || s.body.review_status === 'superseded') continue;
    add({
      key: `assumption:${s.record_id}`,
      ref: refOf(s),
      category: 'assumption',
      generated: true,
      reason: `assumption (${s.body.origin}, ${s.body.review_status})`,
      detail: { statement: s.body.statement, review_status: s.body.review_status, dependents: dependentConclusions(store, s.record_id) },
    });
  }

  // --- Unreviewed-change gaps from the diff to the active snapshot (generated) --------------------
  const active = eng.body.active_snapshot;
  for (const diff of store.heads('snapshot_diff')) {
    if (active && diff.body.next.record_id !== active.record_id) continue;
    diff.body.changes.forEach((c, n) => {
      if (c.mapping.kind !== 'unreviewed_change_gap') return;
      add({
        key: `unreviewed_change_gap:${diff.record_id}:${n}`,
        ref: refOf(diff),
        category: 'unreviewed_change_gap',
        generated: true,
        incomplete: true,
        reason: `unreviewed ${c.kind} change ${c.change}: ${c.item}`,
        detail: { change: c },
      });
    });
  }

  // --- Tool failures, unsupported results, unreconciled jobs ----------------------------------
  for (const j of store.heads('job')) {
    if (j.body.status === 'failed') {
      add({ key: `tool_failure:${j.record_id}`, ref: refOf(j), category: 'tool_failure', reason: `job ${j.body.operation} failed`, detail: { purpose: j.body.purpose } });
    } else if (j.body.status === 'outcome_unknown' || j.body.status === 'running' || j.body.status === 'queued') {
      add({
        key: `blocked_or_incomplete:${j.record_id}`,
        ref: refOf(j),
        category: 'blocked_or_incomplete',
        incomplete: true,
        reason: `job ${j.body.operation} is ${j.body.status}`,
      });
    }
  }
  for (const ev of store.heads('evidence_artifact')) {
    const t = ev.body.structured_result?.result_type;
    if (t === 'unsupported' || t === 'error') {
      add({ key: `tool_failure:${ev.record_id}`, ref: refOf(ev), category: 'tool_failure', reason: `tool result ${t}: ${ev.body.structured_result!.mode}` });
    }
  }

  return {
    engagement: engRef,
    snapshot: active,
    rejection_listing_threshold: threshold,
    items,
    digest: digestJson(items.map((i) => [i.key, i.category, i.ref ? refKey(i.ref) : null, i.blocking])),
  };
}

function comparisonIndex(store: RecordStore): Map<string, RecordEnvelope<'behavioral_comparison'>[]> {
  const unitOfCorr = new Map<string, string>();
  for (const c of store.heads('behavioral_correspondence')) unitOfCorr.set(c.record_id, c.body.audit_unit.record_id);
  const out = new Map<string, RecordEnvelope<'behavioral_comparison'>[]>();
  for (const cmp of store.heads('behavioral_comparison')) {
    const units = new Set(cmp.body.correspondences.map((r) => unitOfCorr.get(r.record_id)).filter((x): x is string => !!x));
    for (const u of units) out.set(u, [...(out.get(u) ?? []), cmp]);
  }
  return out;
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Record refs of the set (unique), e.g. for a closure review's `reviewed` list. */
export function requiredRefs(set: RequiredSet): Ref[] {
  const out = new Map<string, Ref>();
  out.set(refKey(set.engagement), set.engagement);
  for (const i of set.items) if (i.ref) out.set(refKey(i.ref), i.ref);
  return [...out.values()];
}

/** Items that need an explanation at closure: unresolved, incomplete or blocking. */
export function needsExplanation(set: RequiredSet): RequiredItem[] {
  return set.items.filter((i) => i.unresolved || i.incomplete || i.blocking);
}
