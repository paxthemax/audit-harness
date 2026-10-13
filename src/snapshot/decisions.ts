// Change-handling decision kinds (design/harness-interface-contracts.md, "Human decision kinds":
// `attest_carry_forward`, `reaffirm`, `assess_fix`; design/harness-auditor-guide.md, "Pause, resume
// and review changes"; FR-17, FR-20).
//
//   attest_carry_forward  one labelled MECHANICAL attestation for conclusions whose probes are all
//                         unchanged for a snapshot pair; never recorded as human review.
//   reaffirm              exactly one conclusion per decision, with new evidence or a reason.
//   assess_fix            attack status and legitimate-behavior status recorded separately; the
//                         reported label is derived; scoped review states what was not re-reviewed.

import { fail } from '../core/errors.ts';
import { isArtifactRef, type AnyRef, type Ref } from '../core/refs.ts';
import {
  CLIENT_RESPONSES,
  deriveFixLabel,
  FIX_ATTACK_STATUS,
  FIX_LEGIT_STATUS,
  isMediumOrAbove,
  type ClientResponse,
  type FixAttackStatus,
  type FixLegitStatus,
  type PotentialImpact,
} from '../core/values.ts';
import type { OpContext } from '../controller/controller.ts';
import { defineDecisionKind, need, type DecisionPayload } from '../decision/framework.ts';
import type { FixAssessmentBody, RecordEnvelope } from '../schema/records.ts';
import { activeSnapshot, isConclusionType } from './common.ts';
import { anchorsCover } from './diff.ts';
import { probesFor } from './probes.ts';

function isReviewed(p: DecisionPayload, r: Ref): boolean {
  return p.reviewed.some((x) => x.record_id === r.record_id && x.revision === r.revision);
}

function requireReviewed(p: DecisionPayload, r: Ref, what: string): void {
  if (!isReviewed(p, r)) fail('display_required', `${what} ${r.record_id}@${r.revision} must be among the reviewed (rendered) revisions`);
}

function isRef(v: unknown): v is Ref {
  return !!v && typeof v === 'object' && typeof (v as Ref).record_id === 'string' && Number.isInteger((v as Ref).revision);
}

function needRef(inputs: Record<string, unknown>, key: string): Ref {
  const v = need<unknown>(inputs, key);
  if (Array.isArray(v)) fail('invalid_request', `decision input "${key}" takes one reference, not a list`);
  if (!isRef(v)) fail('invalid_request', `decision input "${key}" must be a record reference {record_id, revision}`);
  return v;
}

// -----------------------------------------------------------------------------------------------
// attest_carry_forward

export interface AttestInputs {
  prior_snapshot: Ref;
  snapshot: Ref;
  /** Exact freshness-record revisions (each `carried_forward_mechanical` for the pair). */
  freshness: Ref[];
}

defineDecisionKind({
  kind: 'attest_carry_forward',
  check(ctx, p) {
    const i = p.inputs as unknown as AttestInputs;
    const prior = needRef(p.inputs, 'prior_snapshot');
    const snap = needRef(p.inputs, 'snapshot');
    ctx.store.get(prior, 'target_snapshot');
    ctx.store.get(snap, 'target_snapshot');
    const active = activeSnapshot(ctx);
    if (!active || active.ref.record_id !== snap.record_id) fail('invalid_request', `snapshot ${snap.record_id} is not the engagement's active snapshot`);
    if (!Array.isArray(i.freshness) || !i.freshness.length) fail('invalid_request', 'freshness must list the carried-forward freshness records the attestation covers');
    const refused: { ref: Ref; reason: string }[] = [];
    const seen = new Set<string>();
    for (const r of i.freshness) {
      if (!isRef(r)) fail('invalid_request', 'freshness entries must be record references');
      if (seen.has(r.record_id)) fail('invalid_request', `freshness record ${r.record_id} is listed twice`);
      seen.add(r.record_id);
      requireReviewed(p, r, 'freshness record');
      const f = ctx.store.get<'conclusion_freshness'>(r, 'conclusion_freshness');
      if (f.body.value !== 'carried_forward_mechanical') refused.push({ ref: r, reason: `freshness is ${f.body.value}; only carried_forward_mechanical conclusions can be attested (affected ones need recheck, others reaffirm one at a time)` });
      else if (f.body.snapshot.record_id !== snap.record_id || f.body.prior_snapshot.record_id !== prior.record_id) refused.push({ ref: r, reason: `belongs to the pair ${f.body.prior_snapshot.record_id} -> ${f.body.snapshot.record_id}` });
      else if (f.body.attestation) refused.push({ ref: r, reason: `already attested by ${f.body.attestation.record_id}` });
    }
    if (refused.length) {
      fail('invalid_request', `attest_carry_forward covers only unattested carried_forward_mechanical conclusions of this snapshot pair; ${refused.length} listed item(s) are not`, { details: { refused } });
    }
  },
  apply({ ctx, payload, decision }) {
    const i = payload.inputs as unknown as AttestInputs;
    const attested = i.freshness.map((r) => ctx.tx.revise(r.record_id, 'conclusion_freshness', (b) => ({ ...b, attestation: decision })));
    return {
      attested,
      label: 'mechanical carry-forward attestation (probes unchanged; not human review)',
    };
  },
});

// -----------------------------------------------------------------------------------------------
// reaffirm

export interface ReaffirmInputs {
  conclusion: Ref;
  evidence?: AnyRef[];
  reason?: string;
}

function currentFreshnessRecord(ctx: OpContext, conclusionId: string): RecordEnvelope<'conclusion_freshness'> | undefined {
  const active = activeSnapshot(ctx);
  if (!active) return undefined;
  return ctx.store.heads('conclusion_freshness').find((f) => f.body.conclusion.record_id === conclusionId && f.body.snapshot.record_id === active.ref.record_id);
}

defineDecisionKind({
  kind: 'reaffirm',
  check(ctx, p) {
    const inp = p.inputs ?? {};
    if ('conclusions' in inp || Array.isArray(inp.conclusion)) fail('invalid_request', 'reaffirm decides exactly one conclusion per decision; bulk reaffirmation is refused');
    const c = needRef(inp, 'conclusion');
    const env = ctx.store.get(c);
    if (!isConclusionType(env.type)) fail('invalid_request', `${env.type} is not a conclusion that carries freshness`);
    requireReviewed(p, c, 'conclusion');
    const f = currentFreshnessRecord(ctx, c.record_id);
    if (!f) fail('invalid_request', `${c.record_id} has no freshness record for the active snapshot (it is current); nothing to reaffirm`);
    requireReviewed(p, { record_id: f.record_id, revision: f.revision }, 'freshness record');
    if (f.body.value === 'reaffirmed_by_human') fail('invalid_request', `${c.record_id} is already reaffirmed by ${f.body.decision?.record_id ?? 'a decision'}`);
    const evidence = (inp.evidence ?? []) as AnyRef[];
    if (!Array.isArray(evidence)) fail('invalid_request', 'evidence must be a list of references');
    const reason = typeof inp.reason === 'string' ? inp.reason.trim() : '';
    if (!evidence.length && !reason) fail('evidence_requirement_unmet', 'reaffirm needs new evidence or a reason');
    for (const e of evidence) {
      if (isArtifactRef(e)) {
        if (!ctx.archive.has(e.artifact)) fail('not_found', `artifact ${e.artifact} is not in the archive`);
        continue;
      }
      ctx.store.get(e);
      requireReviewed(p, e, 'evidence');
    }
  },
  apply({ ctx, payload, decision }) {
    const c = payload.inputs.conclusion as Ref;
    const f = currentFreshnessRecord(ctx, c.record_id)!;
    // The reaffirmed evaluation becomes each probe's new baseline.
    const probeRefs: Ref[] = [];
    for (const pr of probesFor(ctx.store, c.record_id)) {
      if (pr.body.status === 'evaluated' && pr.body.result_digest) {
        probeRefs.push(ctx.tx.revise(pr.record_id, 'dependency_probe', (b) => ({ ...b, baseline: { snapshot: b.snapshot, digest: b.result_digest } })));
      } else probeRefs.push({ record_id: pr.record_id, revision: pr.revision });
    }
    const ref = ctx.tx.revise(
      f.record_id,
      'conclusion_freshness',
      (b) => ({ ...b, value: 'reaffirmed_by_human', decision, reasons: [...(b.reasons ?? []), `reaffirmed by ${decision.record_id} (was ${b.value})`] }),
      { depends_on: probeRefs },
    );
    return { freshness: ref, conclusion: c, previous_value: f.body.value };
  },
});

// -----------------------------------------------------------------------------------------------
// assess_fix

export interface AssessFixInputs {
  finding: Ref;
  /** The separately versioned fix revision; null when the client declined to fix. */
  fix_snapshot: Ref | null;
  attack_status: FixAttackStatus;
  legitimate_status: FixLegitStatus;
  client_response: ClientResponse;
  client_response_text?: string;
  evidence: AnyRef[];
  residual_issues?: string[];
  scope_note?: string;
}

/** Effective potential impact of a finding: its linked claim's, else its investigation's. */
export function findingImpact(ctx: OpContext, finding: RecordEnvelope<'finding'>): PotentialImpact {
  const inv = ctx.store.head<'investigation'>(finding.body.investigation.record_id);
  if (!inv) return 'unknown';
  if (finding.body.linked_claim_id) {
    const lc = inv.body.linked_claims.find((l) => l.id === finding.body.linked_claim_id);
    if (lc) return lc.potential_impact.effective;
  }
  return inv.body.potential_impact.effective;
}

defineDecisionKind({
  kind: 'assess_fix',
  check(ctx, p) {
    const i = p.inputs as unknown as AssessFixInputs;
    const fRef = needRef(p.inputs, 'finding');
    const finding = ctx.store.get<'finding'>(fRef, 'finding');
    requireReviewed(p, fRef, 'finding');
    if (!FIX_ATTACK_STATUS.includes(i.attack_status)) fail('invalid_request', `attack_status must be one of ${FIX_ATTACK_STATUS.join(', ')}`);
    if (!FIX_LEGIT_STATUS.includes(i.legitimate_status)) fail('invalid_request', `legitimate_status must be one of ${FIX_LEGIT_STATUS.join(', ')}`);
    if (!CLIENT_RESPONSES.includes(i.client_response)) fail('invalid_request', `client_response must be one of ${CLIENT_RESPONSES.join(', ')}`);
    const fixSupplied = i.fix_snapshot !== null && i.fix_snapshot !== undefined;
    if (fixSupplied) {
      if (!isRef(i.fix_snapshot)) fail('invalid_request', 'fix_snapshot must be a record reference');
      ctx.store.get(i.fix_snapshot, 'target_snapshot');
      requireReviewed(p, i.fix_snapshot, 'fix snapshot');
    } else if (i.attack_status !== 'not_assessed' || i.legitimate_status !== 'not_assessed') {
      fail('invalid_request', 'without a fix snapshot there is nothing to assess: attack and legitimate-behavior status are not_assessed');
    }
    const impact = findingImpact(ctx, finding);
    if (fixSupplied && isMediumOrAbove(impact) && i.legitimate_status === 'not_assessed') {
      fail('evidence_requirement_unmet', `legitimate-behavior checks are mandatory for Critical, High and Medium findings (potential impact ${impact}); assess legitimate behavior before recording the fix`);
    }
    const evidence = Array.isArray(i.evidence) ? i.evidence : [];
    if (i.evidence !== undefined && !Array.isArray(i.evidence)) fail('invalid_request', 'evidence must be a list');
    if (fixSupplied && (i.attack_status !== 'not_assessed' || i.legitimate_status !== 'not_assessed') && !evidence.length) {
      fail('evidence_requirement_unmet', 'attack and legitimate-behavior statuses need the rerun witness and legitimate-path evidence');
    }
    for (const e of evidence) {
      if (isArtifactRef(e)) {
        if (!ctx.archive.has(e.artifact)) fail('not_found', `artifact ${e.artifact} is not in the archive`);
        continue;
      }
      ctx.store.get(e);
      requireReviewed(p, e, 'evidence');
    }
  },
  apply({ ctx, payload, decision }) {
    const i = payload.inputs as unknown as AssessFixInputs;
    const finding = ctx.store.get<'finding'>(i.finding, 'finding');
    const fixSupplied = !!i.fix_snapshot;
    const label = deriveFixLabel(i.attack_status, i.legitimate_status, i.client_response, fixSupplied);
    let priorSnap: string | null = null;
    if (fixSupplied) priorSnap = ctx.store.mustHead<'target_snapshot'>(i.fix_snapshot!.record_id, 'target_snapshot').body.prior_snapshot?.record_id ?? null;
    const scope = fixSupplied
      ? `Scoped fix review of ${i.fix_snapshot!.record_id}${priorSnap ? ` against ${priorSnap}` : ''}: covers the snapshot diff and finding ${finding.record_id} only. Code outside the diff and the listed findings was not re-reviewed at this revision.`
      : `No fix supplied (client response: ${i.client_response}). Nothing was re-reviewed.`;
    const body: FixAssessmentBody = {
      finding: i.finding,
      fix_snapshot: fixSupplied ? i.fix_snapshot! : null,
      attack_status: i.attack_status,
      legitimate_status: i.legitimate_status,
      client_response: i.client_response,
      label,
      evidence: i.evidence ?? [],
      residual_issues: (i.residual_issues ?? []).map(String),
      scope_note: i.scope_note?.trim() ? `${scope} ${i.scope_note.trim()}` : scope,
      decision,
    };
    const deps: AnyRef[] = [i.finding, ...(i.evidence ?? [])];
    const fa = ctx.tx.create('fix_assessment', body, deps);
    const findingRef = ctx.tx.revise(finding.record_id, 'finding', (b) => ({
      ...b,
      fix_assessments: [...b.fix_assessments, fa],
      client_responses:
        typeof i.client_response_text === 'string'
          ? [...b.client_responses, { response: i.client_response, text: i.client_response_text, at: ctx.now, severity_change: null }]
          : b.client_responses,
    }));

    // The fix snapshot's diff: changes the finding's code covers now map to this assessment; the
    // rest stay unreviewed-change gaps, printed beside the fix status.
    let gapsBeside: { kind: string; item: string; change: string }[] = [];
    let diff: Ref | null = null;
    if (fixSupplied) {
      const d = ctx.store.heads('snapshot_diff').find((x) => x.body.next.record_id === i.fix_snapshot!.record_id);
      if (d) {
        const anchors = finding.body.affected_code;
        let changed = false;
        const changes = d.body.changes.map((ch) => {
          if (ch.mapping.kind !== 'unreviewed_change_gap' || !anchorsCover(anchors, ch)) return ch;
          changed = true;
          return { ...ch, mapping: { kind: 'fix_assessment' as const, ref: fa } };
        });
        diff = changed ? ctx.tx.revise(d.record_id, 'snapshot_diff', (b) => ({ ...b, changes })) : { record_id: d.record_id, revision: d.revision };
        gapsBeside = changes.filter((c) => c.mapping.kind === 'unreviewed_change_gap').map((c) => ({ kind: c.kind, item: c.item, change: c.change }));
      }
    }
    return { fix_assessment: fa, label, finding: findingRef, scope_note: body.scope_note, diff, unreviewed_change_gaps: gapsBeside };
  },
});

