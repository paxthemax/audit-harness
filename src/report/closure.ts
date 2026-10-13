import { fail } from '../core/errors.ts';
import { isArtifactRef, refKey, type AnyRef } from '../core/refs.ts';
import { defineDecisionKind, need } from '../decision/framework.ts';
import { artifactsOf, engagementHead, refOf } from './derive.ts';
import { computeRequiredSet, needsExplanation } from './requiredSet.ts';

// Closure and retention decisions (design/harness-interface-contracts.md, "Human decision kinds";
// design/harness-auditor-guide.md, "Close and export"; FR-22).
//
// close_engagement inputs:
//   outcome              'closed' | 'stopped_incomplete'
//   required_set_digest  digest of the required set the closure review showed (computeRequiredSet)
//   explanations         { [record_id]: string } for every unresolved, incomplete or blocking item
//   limitations          string[]; required for `stopped_incomplete`
// The reviewed revisions must include the engagement record. Closing changes only the engagement's
// closure status: no investigation, audit unit or freshness value is touched, so closing cannot mark
// unperformed work complete. While incomplete work exists, only `stopped_incomplete` with explicit
// limitations is accepted. Unattested mechanical carry-forward blocks closure outright.

defineDecisionKind({
  kind: 'close_engagement',
  check(ctx, p) {
    const inputs = p.inputs ?? {};
    const outcome = need<string>(inputs, 'outcome');
    if (outcome !== 'closed' && outcome !== 'stopped_incomplete') fail('invalid_request', "outcome must be 'closed' or 'stopped_incomplete'");
    const eng = engagementHead(ctx.store);
    if (eng.body.closure_status !== 'open') fail('invalid_request', `engagement is already ${eng.body.closure_status}`);
    if (!p.reviewed.some((r) => r.record_id === eng.record_id && r.revision === eng.revision)) {
      fail('display_required', 'the closure review must render the current engagement record');
    }
    const set = computeRequiredSet(ctx.store);
    if (need<string>(inputs, 'required_set_digest') !== set.digest) {
      fail('stale_dependency', 'the required set changed after the closure review; review it again', { details: { current: set.digest } });
    }
    const blocking = set.items.filter((i) => i.blocking);
    if (blocking.length) {
      fail('permission_denied', 'unattested mechanical carry-forward blocks closure', { details: { items: blocking.map((i) => i.key) } });
    }
    const explanations = (inputs.explanations ?? {}) as Record<string, unknown>;
    const pending = needsExplanation(set);
    const unexplained = pending.filter((i) => {
      const e = i.ref ? explanations[i.ref.record_id] : undefined;
      return typeof e !== 'string' || !e.trim();
    });
    if (unexplained.length) {
      fail('invalid_request', 'required items are unexplained in the closure review', {
        details: { unexplained: unexplained.map((i) => ({ key: i.key, ref: i.ref, reason: i.reason })) },
      });
    }
    const incomplete = pending.filter((i) => i.incomplete);
    if (outcome === 'closed' && incomplete.length) {
      fail('permission_denied', "closing cannot mark unperformed work complete; use 'stopped_incomplete' with explicit limitations", {
        details: { incomplete: incomplete.map((i) => i.key) },
      });
    }
    const limitations = inputs.limitations;
    if (outcome === 'stopped_incomplete') {
      if (!Array.isArray(limitations) || !limitations.length || limitations.some((l) => typeof l !== 'string' || !l.trim())) {
        fail('invalid_request', 'stopped_incomplete needs explicit limitations');
      }
    }
  },
  apply(d) {
    const outcome = d.payload.inputs.outcome as 'closed' | 'stopped_incomplete';
    const eng = engagementHead(d.ctx.store);
    const ref = d.ctx.tx.revise(eng.record_id, 'engagement', (b) => ({ ...b, closure_status: outcome, closure_decision: d.decision }));
    return { engagement: ref, closure_status: outcome };
  },
});

// retention_action inputs:
//   material      AnyRef[]: archive artifacts or records the retention policy expires
//   policy_basis  the retention policy clause relied on
// Dependent evidence records are marked ineligible with the removal named in their limitations, and
// every other dependent record is listed in the result. Nothing claims the removed material remains
// replayable. The bytes are not purged from the Git-backed archive history by this decision:
// physical purging depends on the store choice, which is an open operator choice.

defineDecisionKind({
  kind: 'retention_action',
  check(ctx, p) {
    const material = need<AnyRef[]>(p.inputs, 'material');
    need<string>(p.inputs, 'policy_basis');
    if (!Array.isArray(material) || !material.length) fail('invalid_request', 'material must list artifacts or records');
    for (const m of material) {
      if (isArtifactRef(m)) {
        if (!ctx.archive.has(m.artifact)) fail('not_found', `artifact ${m.artifact} is not in this engagement's archive`);
      } else ctx.store.get(m);
    }
  },
  apply(d) {
    const { ctx } = d;
    const material = d.payload.inputs.material as AnyRef[];
    const digests = new Set(material.filter(isArtifactRef).map((m) => m.artifact));
    const ids = new Set(material.filter((m) => !isArtifactRef(m)).map((m) => (m as { record_id: string }).record_id));
    const note = `material removed under retention decision ${refKey(d.decision)} (${String(d.payload.inputs.policy_basis)}); not replayable`;
    const unavailable: AnyRef[] = [];
    for (const h of ctx.store.heads()) {
      const hits =
        artifactsOf(h).some((a) => digests.has(a)) ||
        h.depends_on.some((r) => !isArtifactRef(r) && ids.has(r.record_id)) ||
        ids.has(h.record_id);
      if (!hits) continue;
      if (h.type === 'evidence_artifact') {
        unavailable.push(
          ctx.tx.revise(h.record_id, 'evidence_artifact', (b) => ({
            ...b,
            eligible: false,
            missing_or_truncated: [...b.missing_or_truncated, note],
            limitations: [...b.limitations, note],
          })),
        );
      } else unavailable.push(refOf(h));
    }
    return { unavailable };
  },
});
