import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.ts';
import type { Ref } from '../src/core/refs.ts';

// CS-16, a measurement of accepted residual risk Q-021: auditee documentation written during the
// engagement mirrors a seeded discrepancy. The harness keeps only the origin label (no safeguard is
// added); the measurement records whether a comparison or the auditor surfaced the discrepancy.

test('CS-16: a comparison against mirroring auditee documentation misses the seeded discrepancy; the measurement records it', () => {
  const h = makeHarness();
  try {
    const eid = 'q021';
    h.auditor.do(eid, 'create_engagement', { name: 'Q-021 measurement', owner: 'auditor', audit_purpose: 'residual-risk measurement' });
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal' } }).audit_unit as Ref;
    const stmt = (body: Record<string, unknown>) => h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', body: { audit_units: [unit], ...body } }).statement as Ref;
    // The seeded discrepancy: the original documentation promises one payout; the code pays twice under callback.
    const original = stmt({ kind: 'intent', affiliation: 'designed', origin: 'documented_claim', statement: 'withdraw pays out at most once per deposit' });
    const implementation = stmt({ kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'withdraw can pay out twice when the recipient re-enters' });
    // Mid-engagement, the auditee writes documentation that mirrors the code (relayed by the auditor).
    const auditee = stmt({ kind: 'intent', affiliation: 'designed', origin: 'auditee_statement', statement: 'withdraw may pay out again if the recipient calls back; this is intended' });

    // A comparison that relies only on the newest DESIGNED statement finds nothing.
    const corr = h.auditor.do(eid, 'submit_proposal', { kind: 'behavioral_correspondence', body: { audit_unit: unit, lens: 'flows', designed: [auditee], implemented: [implementation] } }).correspondence as Ref;
    h.auditor.do(eid, 'submit_proposal', { kind: 'behavioral_comparison', body: { correspondences: [corr], examined: 'withdraw callback path', bounds: 'single transaction', coverage: 'examined', result: 'no_discrepancy_observed' } });
    const seed = { original, auditee, implementation };
    const missed = h.auditor.do(eid, 'measure_auditee_mirroring', seed).measurement;
    assert.equal(missed.surfaced, false, 'the risk bit: the mirrored documentation hid the discrepancy');
    assert.equal(missed.origin_label_kept, true, 'the only handling Q-021 provides is the origin label');
    assert.equal(missed.comparisons[0].relied_on_auditee, true);

    // The auditor notices the conflict with the original claim and records a discrepancy: surfaced.
    const corr2 = h.auditor.do(eid, 'submit_proposal', { kind: 'behavioral_correspondence', body: { audit_unit: unit, lens: 'flows', designed: [original], implemented: [implementation] } }).correspondence as Ref;
    const cmp2 = h.auditor.do(eid, 'submit_proposal', { kind: 'behavioral_comparison', body: { correspondences: [corr2], examined: 'withdraw callback path', bounds: 'single transaction', coverage: 'examined', result: 'discrepancy' } }).comparison as Ref;
    h.auditor.do(eid, 'submit_proposal', { kind: 'behavioral_discrepancy', body: { comparison: cmp2, claims: [original], deviation: 'pays twice under callback', distinguishing_check: 'reentrancy PoC' } });
    const caught = h.auditor.do(eid, 'measure_auditee_mirroring', seed);
    assert.equal(caught.measurement.surfaced, true);
    assert.equal(caught.measurement.surfaced_by_comparison, true);
    assert.ok(caught.measurement.surfaced_by_auditor.length >= 1);
    // The measurement is recorded for the pilot's denominator, never as a gate.
    const events = h.ws.store(eid, true).events().filter((e) => e.kind === 'residual_risk_measured');
    assert.deepEqual(events.map((e) => (e.result as { surfaced: boolean }).surfaced), [false, true]);
  } finally {
    h.cleanup();
  }
});
