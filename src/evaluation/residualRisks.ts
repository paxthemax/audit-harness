import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { defineOperation } from '../controller/controller.ts';
import type { RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';

// Measurement of accepted residual risk Q-021 (design/harness-evaluation.md, "Control and recovery
// scenarios": "Documentation the auditee writes during the engagement mirrors a seeded discrepancy";
// DEC-009). Auditee statements carry only their origin label, so documentation written mid-engagement
// can mirror the code and a comparison against it finds no discrepancy. The operator accepted that
// risk: this module adds NO safeguard. It records, for a seeded case, whether a comparison or the
// auditor surfaced the seeded discrepancy anyway, so the pilot can measure how often the risk bites.

export interface MirroringSeed {
  /** The pre-engagement documented claim the implementation violates (the seeded discrepancy). */
  original: Ref;
  /** The auditee's mid-engagement documentation that mirrors the implementation. */
  auditee: Ref;
  /** The implementation statement that deviates from the original claim. */
  implementation: Ref;
}

export interface MirroringMeasurement {
  scenario: 'CS-16';
  risk: 'Q-021';
  seed: MirroringSeed;
  /** Comparisons over the seeded implementation, with what they relied on and their result. */
  comparisons: { comparison: Ref; relied_on_original: boolean; relied_on_auditee: boolean; result: string }[];
  surfaced_by_comparison: boolean;
  /** Auditor-created records that point at the seeded pair: a discrepancy, clarification or investigation. */
  surfaced_by_auditor: Ref[];
  surfaced: boolean;
  /** The auditee statement kept its origin label (the only handling Q-021 provides). */
  origin_label_kept: boolean;
  note: string;
}

function refsIn(v: unknown, id: string): boolean {
  return JSON.stringify(v ?? null).includes(`"record_id":"${id}"`);
}

export function measureAuditeeMirroring(store: RecordStore, seed: MirroringSeed): MirroringMeasurement {
  const orig = store.get(seed.original, 'system_statement');
  const aud = store.get(seed.auditee, 'system_statement');
  const impl = store.get(seed.implementation, 'system_statement');
  if (orig.body.affiliation === 'implemented' || aud.body.affiliation === 'implemented') fail('invalid_request', 'original and auditee statements are DESIGNED behavior');
  if (impl.body.affiliation !== 'implemented') fail('invalid_request', 'the implementation statement is IMPLEMENTED behavior');

  const correspondences = store.heads('behavioral_correspondence').filter((c) => (c.body.implemented ?? []).some((r) => r.record_id === impl.record_id));
  const comparisons: MirroringMeasurement['comparisons'] = [];
  for (const cmp of store.heads('behavioral_comparison')) {
    const used = correspondences.filter((c) => cmp.body.correspondences.some((r) => r.record_id === c.record_id));
    if (!used.length) continue;
    const designed = used.flatMap((c) => c.body.designed ?? []);
    comparisons.push({
      comparison: { record_id: cmp.record_id, revision: cmp.revision },
      relied_on_original: designed.some((r) => r.record_id === orig.record_id),
      relied_on_auditee: designed.some((r) => r.record_id === aud.record_id),
      result: cmp.body.result,
    });
  }
  const surfacedByComparison = comparisons.some((c) => c.result === 'discrepancy' && c.relied_on_original);

  const auditorRecords = (types: ('behavioral_discrepancy' | 'clarification' | 'investigation')[]) =>
    types.flatMap((t) => store.heads(t) as RecordEnvelope[]).filter((r) => store.history(r.record_id)[0].created_by.channel === 'auditor');
  const surfacedByAuditor = auditorRecords(['behavioral_discrepancy', 'clarification', 'investigation'])
    .filter((r) => refsIn(r.body, orig.record_id) || refsIn(r.body, impl.record_id) || refsIn(r.depends_on, orig.record_id))
    .map((r) => ({ record_id: r.record_id, revision: r.revision }));

  return {
    scenario: 'CS-16',
    risk: 'Q-021',
    seed,
    comparisons,
    surfaced_by_comparison: surfacedByComparison,
    surfaced_by_auditor: surfacedByAuditor,
    surfaced: surfacedByComparison || surfacedByAuditor.length > 0,
    origin_label_kept: aud.body.origin === 'auditee_statement',
    note: 'A measurement of an accepted residual risk, never a gate. Q-021 adds no handling beyond the origin label.',
  };
}

defineOperation<MirroringSeed>({
  name: 'measure_auditee_mirroring',
  channels: ['auditor'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.original || !p.auditee || !p.implementation) fail('invalid_request', 'original, auditee and implementation are required');
    const m = measureAuditeeMirroring(ctx.store, p);
    const art = ctx.archive.putJson({ format: 'harness.residual-risk-measurement/1', measured_at: ctx.now, ...m });
    ctx.tx.blob(art);
    ctx.tx.event('residual_risk_measured', { scenario: 'CS-16', risk: 'Q-021', surfaced: m.surfaced, artifact: art.artifact });
    return { measurement: m, artifact: art };
  },
});
