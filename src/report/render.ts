import { refKey, type Ref } from '../core/refs.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { RecordEnvelope } from '../schema/records.ts';
import { claimInputs, decisionBody, engagementHead, fixLabelOf, refOf } from './derive.ts';
import { md, mdBlock } from './escape.ts';
import { failedAttempts } from '../decision/packets.ts';
import type { RequiredItem, RequiredSet } from './requiredSet.ts';

// report.md generation. Every structured section is generated from records (design/harness-interface-
// contracts.md, "Portable report and PoC package"); the only prose is an optional agent-drafted
// narrative artifact, rendered in its own clearly labelled section. The report carries no aggregate
// security score and no claim that the system is secure (NFR-13): `no_finding_within_bounds` is
// listed with its bounds and never as a refutation, `triaged_out` supports no assurance claim, and
// mechanical carry-forward is labelled as such.

export interface ReportModel {
  store: RecordStore;
  manifestId: string;
  generatedAt: string;
  audience: string;
  redactionPolicy: string;
  required: RequiredSet;
  /** refKeys of the effective selection (auditor selection plus generated items). */
  included: Set<string>;
  absent: { item: RequiredItem; reason: string | null }[];
  redactedArtifacts: { artifact: string; reason: string }[];
  narrative: string | null;
}

function isIncluded(m: ReportModel, r: Ref | null): boolean {
  return r !== null && m.included.has(refKey(r));
}

function itemsOf(m: ReportModel, cat: RequiredItem['category']): RequiredItem[] {
  return m.required.items.filter((i) => i.category === cat && (i.generated || isIncluded(m, i.ref)));
}

function refText(r: Ref | null | undefined): string {
  return r ? md(refKey(r)) : 'none';
}

export function renderReport(m: ReportModel): string {
  const { store } = m;
  const eng = engagementHead(store);
  const policy = eng.body.policy;
  const out: string[] = [];
  const p = (s = '') => out.push(s);

  p(`# Audit report: ${md(eng.body.name)}`);
  p();
  p(`Engagement \`${md(store.scope)}\` · report manifest ${md(m.manifestId)} · generated ${md(m.generatedAt)} · audience: ${md(m.audience)}`);
  p();
  p('This report is generated from the engagement records. It gives no aggregate security score and makes no claim that the');
  p('system is secure or that every vulnerability was found. A result of `no_finding_within_bounds` means that no supported');
  p('claim emerged within the stated bounds; it is never a refutation. `triaged_out` leads support no assurance claim.');
  p();

  // Scope and methods ------------------------------------------------------------------------
  p('## Scope and methods');
  p();
  p(`- Audit purpose: ${md(eng.body.audit_purpose)}`);
  for (const s of policy?.scope ?? []) p(`- In scope: ${md(s)}`);
  const snap = eng.body.active_snapshot ? store.head<'target_snapshot'>(eng.body.active_snapshot.record_id) : undefined;
  if (snap) {
    const commit = typeof snap.body.source.commit === 'string' ? snap.body.source.commit : `unknown (${snap.body.source.commit.reason})`;
    p(`- Target snapshot: ${md(snap.body.label)} (${refText(refOf(snap))}), commit ${md(commit)}, tree ${md(snap.body.tree.artifact)}`);
    for (const l of snap.body.limitations) p(`- Snapshot limitation: ${md(l)}`);
  } else {
    p('- Target snapshot: none registered');
  }
  const methods = new Map<string, number>();
  for (const inv of store.heads('investigation')) methods.set(inv.body.method, (methods.get(inv.body.method) ?? 0) + 1);
  p(`- Investigation methods used: ${[...methods].map(([k, n]) => `${md(k)} (${n})`).join(', ') || 'none'}`);
  if (policy) p(`- Severity rubric: ${md(policy.severity_rubric)}`);
  p();

  p('### Excluded scope');
  p();
  const excl = itemsOf(m, 'excluded_scope');
  if (!excl.length) p('No exclusions recorded.');
  for (const x of excl) p(`- ${md(x.reason)}${x.detail.reason ? ` — ${md(x.detail.reason)}` : ''}`);
  p();

  // Coverage -----------------------------------------------------------------------------------
  p('## Coverage');
  p();
  p('Each audit unit with its review status and reviewed revision. Comparisons relying on intent the auditor recorded after');
  p('the first presentation of implemented behavior carry the tag `after_walkthrough`.');
  p();
  const units = itemsOf(m, 'audit_unit');
  if (!units.length) p('No audit units recorded.');
  else {
    p('| Audit unit | Kind | Review status | Reviewed revision | Comparisons |');
    p('|---|---|---|---|---|');
    for (const u of units) {
      const d = u.detail as {
        name: string;
        kind: string;
        review_status: string;
        reviewed_revision: { snapshot: Ref; decision: Ref } | null;
        comparisons: { ref: Ref; coverage: string; result: string; intent_timing: string[] }[];
      };
      const rr = d.reviewed_revision ? `snapshot ${refText(d.reviewed_revision.snapshot)}, decision ${refText(d.reviewed_revision.decision)}` : 'not reviewed';
      const cmps =
        d.comparisons
          .map((c) => `${refText(c.ref)} ${md(c.result)}/${md(c.coverage)}${c.intent_timing.includes('after_walkthrough') ? ' \\[after\\_walkthrough\\]' : ''}`)
          .join('; ') || 'none';
      p(`| ${md(d.name)} (${refText(u.ref)}) | ${md(d.kind)} | ${md(d.review_status)} | ${rr} | ${cmps} |`);
    }
  }
  p();

  p('### Baseline controls');
  p();
  p('Each relevant baseline control with examined evidence or a visible gap. Completing this list is not evidence that the system is secure.');
  p();
  const controls = itemsOf(m, 'baseline_control');
  if (!controls.length) p('No baseline controls recorded.');
  for (const c of controls) {
    const d = c.detail as { control_id: string; title: string; source: string; status: string; evidence: unknown[]; gaps: string[]; applicability_reason: string | null };
    p(`- ${md(d.control_id)} ${md(d.title)} (${md(d.source)}; ${refText(c.ref)}): ${md(d.status)}${d.evidence.length ? `; evidence: ${mdValue(d.evidence)}` : ''}${d.gaps.length ? `; gaps: ${d.gaps.map(md).join('; ')}` : ''}${d.applicability_reason ? `; applicability: ${md(d.applicability_reason)}` : ''}`);
  }
  p();
  const diagrams = itemsOf(m, 'kb_diagram_affected');
  if (diagrams.length) {
    p('### Affected diagrams');
    p();
    for (const d of diagrams) p(`- ${refText(d.ref)}: ${md(d.reason)}; changed: ${mdValue(d.detail.changed)}`);
    p();
  }

  // Findings -------------------------------------------------------------------------------------
  const findingItems = [...itemsOf(m, 'accepted_finding'), ...itemsOf(m, 'accepted_linked_claim')];
  const findingEnvs = findingItems
    .map((i) => (i.ref ? store.tryGet(i.ref) : undefined))
    .filter((e): e is RecordEnvelope<'finding'> => !!e && e.type === 'finding');
  const altCount = findingEnvs.filter((f) => f.body.evidence_route === 'alternative_argument').length;
  const failedTotal = findingEnvs.reduce((n, f) => n + failedAttemptCount(store, f.body.investigation.record_id), 0);
  p('## Findings');
  p();
  p(`Accepted findings in this report: ${findingEnvs.length}. Alternative-route confirmations: ${altCount}. Failed attempts across their investigations: ${failedTotal}.`);
  p();
  for (const f of findingEnvs) renderFinding(m, f, p);
  for (const i of findingItems.filter((i) => !findingEnvs.some((f) => i.ref && f.record_id === i.ref.record_id))) {
    p(`- ${md(i.reason)} (${refText(i.ref)})`);
  }
  if (findingItems.length) p();

  const groups = itemsOf(m, 'lead_group');
  if (groups.length) {
    p('### Grouped leads');
    p();
    p('Duplicate and root-cause groups keep every member and its origin; a group never replaces its members.');
    p();
    for (const g of groups) {
      const d = g.detail as { relation: string; status: string; origins: { member: Ref; origin: string; lead_generator: string }[]; proposed_cause: string; dissent: string[]; chain_investigation: Ref | null };
      p(`- ${refText(g.ref)} ${md(d.relation)} (${md(d.status)}): ${md(d.proposed_cause)}`);
      for (const o of d.origins) p(`  - member ${refText(o.member)}: origin ${md(o.origin)}, generator ${md(o.lead_generator)}`);
      if (d.dissent.length) p(`  - dissent: ${d.dissent.map(md).join('; ')}`);
      if (d.chain_investigation) p(`  - chain investigated separately as ${refText(d.chain_investigation)}`);
    }
    p();
  }

  // Unresolved and blocked -----------------------------------------------------------------------
  p('## Unresolved items');
  p();
  p('Unresolved is derived: no current disposition, `disputed`, `deferred`, or freshness `affected`/`possibly_affected`.');
  p();
  const unresolved = itemsOf(m, 'unresolved');
  if (!unresolved.length) p('None in this report.');
  for (const u of unresolved) p(`- ${refText(u.ref)}: ${md(u.reason)}${detailSuffix(u)}`);
  p();
  p('## Blocked and incomplete work');
  p();
  const blocked = itemsOf(m, 'blocked_or_incomplete');
  if (!blocked.length) p('None in this report.');
  for (const b of blocked) p(`- ${refText(b.ref)}: ${md(b.reason)}`);
  p();

  // Assumptions and trust premises ---------------------------------------------------------------
  p('## Assumptions and trust premises');
  p();
  for (const t of itemsOf(m, 'trust_premise')) {
    const d = t.detail as { premise: string; privileged_roles_trusted: boolean; raised_roles: string[] };
    p(`- Trusted-role premise: ${md(d.premise)}. Privileged roles are trusted unless raised: ${d.privileged_roles_trusted ? 'yes' : 'no'}; raised roles: ${d.raised_roles.map(md).join(', ') || 'none'}. Every conclusion in this report depends on this premise.`);
  }
  for (const a of itemsOf(m, 'attacker_charter')) {
    const d = a.detail as { capabilities: string[]; excluded: { capability: string; reason: string }[] };
    p(`- Attacker charter: ${d.capabilities.map(md).join(', ') || 'none'}. Excluded: ${d.excluded.map((x) => `${md(x.capability)} (${md(x.reason)})`).join(', ') || 'none'}. Every conclusion in this report was examined under this charter.`);
  }
  for (const a of itemsOf(m, 'assumption')) {
    const d = a.detail as { statement: string; review_status: string; dependents: Ref[] };
    p(`- Assumption ${refText(a.ref)} (${md(d.review_status)}): ${md(d.statement)}. Dependent conclusions: ${d.dependents.map(refText).join(', ') || 'none recorded'}.`);
  }
  p();

  // Mechanical carry-forward ----------------------------------------------------------------------
  p('## Mechanical carry-forward');
  p();
  const cf = itemsOf(m, 'carry_forward_attestation');
  if (!cf.length) p('None.');
  for (const c of cf) {
    if (c.blocking) p(`- UNATTESTED: ${md(c.reason)}`);
    else {
      const conc = (c.detail.conclusions as Ref[]).map(refText).join(', ');
      p(`- Mechanical attestation ${refText(c.ref)} (labelled mechanical; it is not human review) covers: ${conc}`);
    }
  }
  p();

  p('## Unreviewed changes');
  p();
  const gaps = itemsOf(m, 'unreviewed_change_gap');
  if (!gaps.length) p('None recorded against the active snapshot.');
  for (const g of gaps) p(`- ${refText(g.ref)}: ${md(g.reason)}`);
  p();

  p('## Tool failures and unsupported results');
  p();
  const tf = itemsOf(m, 'tool_failure');
  if (!tf.length) p('None in this report.');
  for (const t of tf) p(`- ${refText(t.ref)}: ${md(t.reason)}`);
  p();

  // Limits --------------------------------------------------------------------------------------
  p('## Accepted residual risks (limits)');
  p();
  for (const r of itemsOf(m, 'accepted_residual_risk')) p(`- ${md(r.detail.id as string)}: ${md(r.reason)}`);
  p();

  p('## Omitted and redacted material');
  p();
  p(`Redaction policy: ${md(m.redactionPolicy)}`);
  p();
  if (!m.absent.length && !m.redactedArtifacts.length) p('No required item is omitted.');
  for (const a of m.absent) {
    p(`- ${md(a.item.category)} ${refText(a.item.ref)}: omitted — ${a.reason ? md(a.reason) : 'NO REASON GIVEN (approval is refused until one is recorded)'}`);
  }
  for (const r of m.redactedArtifacts) p(`- Artifact ${md(r.artifact)} withheld: ${md(r.reason)}. Independent reproduction that needs it is restricted.`);
  p();

  if (m.narrative !== null) {
    p('## Narrative (agent-drafted; not generated from records)');
    p();
    p('The following text was drafted by an agent and carries no authority. The structured sections above are authoritative.');
    p();
    p(mdBlock(m.narrative));
    p();
  }

  // Appendices ----------------------------------------------------------------------------------
  p('## Appendix A: Rejections at or above the listing threshold');
  p();
  p(`Listing threshold: ${md(m.required.rejection_listing_threshold ?? 'not set')}.`);
  p();
  const rej = itemsOf(m, 'rejection_above_threshold');
  if (!rej.length) p('None in this report.');
  for (const r of rej) p(`- ${refText(r.ref)}: ${md(r.reason)}${detailSuffix(r)}`);
  p();
  p('## Appendix B: No finding within bounds');
  p();
  p('Each entry is bounded by the methods, variants, budget, attacker charter and assumptions listed. None is a refutation.');
  p();
  const nf = itemsOf(m, 'no_finding_within_bounds');
  if (!nf.length) p('None in this report.');
  for (const r of nf) p(`- ${refText(r.ref)}: ${md(r.detail.question)} — bounds: ${r.detail.bounds ? mdValue(r.detail.bounds) : 'not recorded'}`);
  p();
  p('## Appendix C: Triaged-out leads');
  p();
  p('These leads were set aside at low potential impact. They support no assurance claim.');
  p();
  const tr = itemsOf(m, 'triaged_out');
  if (!tr.length) p('None in this report.');
  for (const r of tr) p(`- ${refText(r.ref)}: ${md(r.detail.question)}${detailSuffix(r)}`);
  p();
  const views = itemsOf(m, 'accounting_view');
  if (views.length) {
    p('## Appendix D: Accounting views');
    p();
    for (const v of views) {
      const d = v.detail as { audit_unit: Ref; review_status: string; conservation: { relation: string }[]; units: { store: string; unit: string; decimals: number | null }[]; rounding: { operation: string; direction: string; beneficiary: string }[] };
      p(`### ${refText(v.ref)} (audit unit ${refText(d.audit_unit)}, ${md(d.review_status)})`);
      p();
      for (const c of d.conservation) p(`- Conservation: ${md(c.relation)}`);
      for (const u of d.units) p(`- Units: ${md(u.store)} in ${md(u.unit)}${u.decimals === null ? '' : `, ${u.decimals} decimals`}`);
      for (const r of d.rounding) p(`- Rounding: ${md(r.operation)} rounds ${md(r.direction)}, favouring ${md(r.beneficiary)}`);
      p();
    }
  }
  return out.join('\n');
}

/** Structured values as readable text: objects as `key: value` pairs, lists comma-separated. */
function mdValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(mdValue).join(', ') || 'none';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.record_id === 'string' && typeof o.revision === 'number') return md(`${o.record_id}@${o.revision}`);
    return Object.entries(o).map(([k, x]) => `${md(k)}: ${mdValue(x)}`).join('; ');
  }
  return md(v);
}

function detailSuffix(i: RequiredItem): string {
  const inputs = i.detail.inputs as Record<string, unknown> | undefined;
  if (!inputs || !Object.keys(inputs).length) return '';
  return ' — ' + Object.entries(inputs).map(([k, v]) => `${md(k)}: ${mdValue(v)}`).join('; ');
}

/** Failed, cancelled and outcome-unknown attempts of the investigation's jobs (packets' definition). */
export function failedAttemptCount(store: RecordStore, investigationId: string): number {
  return failedAttempts(store, investigationId).length;
}

/** The alternative-argument fields of an acceptance (DispositionInputs.alternative). */
export function alternativeOf(inputs: Record<string, unknown>): { why_impractical: unknown; why_sufficient: unknown; limits: unknown; failed_replays_addressed: unknown } {
  const a = (inputs.alternative ?? {}) as Record<string, unknown>;
  return { why_impractical: a.why_impractical ?? null, why_sufficient: a.why_sufficient ?? null, limits: a.limits ?? null, failed_replays_addressed: a.failed_replays_addressed ?? null };
}

function renderFinding(m: ReportModel, f: RecordEnvelope<'finding'>, p: (s?: string) => void): void {
  const { store } = m;
  const b = f.body;
  const inv = store.head<'investigation'>(b.investigation.record_id);
  const acceptance = decisionBody(store, b.acceptance);
  const inputs = claimInputs(acceptance?.inputs, b.linked_claim_id);
  const responses = b.client_responses;
  const last = responses.length ? responses[responses.length - 1] : null;
  p(`### ${md(b.title)} (${refText(refOf(f))})`);
  p();
  p(`- Severity: ${md(b.severity)} — basis: ${md(b.severity_basis)}`);
  if (inv) p(`- Potential impact: ${md(inv.body.potential_impact.effective)}`);
  p(`- Broken guarantee: ${md(b.guarantee)}${b.linked_claim_id ? ` (linked claim ${md(b.linked_claim_id)})` : ''}`);
  p(`- Mechanism: ${md(b.mechanism)}`);
  p(`- Impact: ${md(b.impact)}`);
  p(`- Prerequisites: ${b.prerequisites.map(md).join('; ') || 'none recorded'}`);
  p(`- Affected code: ${b.affected_code.map((a) => `${md(a.path)}${a.symbol ? ` ${md(a.symbol)}` : ''}${a.content_digest ? ` (${md(a.content_digest)})` : ''}`).join('; ') || 'none recorded'}`);
  p(`- Evidence route: ${md(b.evidence_route)}${b.evidence_route === 'alternative_argument' ? ' (alternative evidence accepted under DEC-004; see reproduction/ for the argument, limits and attempt history)' : ''}`);
  if (b.evidence_route === 'alternative_argument') {
    const alt = alternativeOf(inputs);
    p(`  - Why execution was impractical: ${md(alt.why_impractical ?? 'not recorded')}`);
    p(`  - Why the argument suffices: ${md(alt.why_sufficient ?? 'not recorded')}`);
    p(`  - Remaining untested / limits: ${md(alt.limits ?? 'not recorded')}`);
    if (alt.failed_replays_addressed) p(`  - Failed replay addressed: ${md(alt.failed_replays_addressed)}`);
  }
  p(`- Failed attempts in this investigation: ${failedAttemptCount(store, b.investigation.record_id)}`);
  p(`- Client response: ${last ? `${md(last.response)}${last.text ? ` — ${md(last.text)}` : ''}` : 'none recorded'}`);
  p(`- Fix label: ${md(fixLabelOf(store, f))}${b.fix_assessments.length ? ` (assessments: ${b.fix_assessments.map(refText).join(', ')})` : ''}`);
  p(`- Applicability: ${md(b.applicability)}`);
  const cond = acceptance?.conditional_on ?? [];
  p(`- Acceptance decision: ${refText(b.acceptance)}${cond.length ? ` — CONDITIONAL on unreviewed statements ${cond.map(refText).join(', ')}` : ''}`);
  p();
}
