import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { makeHarness } from './helpers.ts';
import { CONTROL_SCENARIOS, runControlChecks } from '../src/evaluation/controls.ts';
import { isHarnessError } from '../src/core/errors.ts';

// Pilot step 2: control scenarios map to tests; a gate failure blocks adoption; results are recorded
// in the library scope as auditor-run checks (never as trusted receipts).

test('every scenario of the evaluation plan is mapped; measurements are never gates', () => {
  assert.equal(CONTROL_SCENARIOS.length, 24);
  for (const id of ['CS-15', 'CS-16', 'CS-17']) assert.equal(CONTROL_SCENARIOS.find((s) => s.id === id)!.kind, 'measurement');
  assert.ok(CONTROL_SCENARIOS.filter((s) => s.kind === 'gate').every((s) => s.tests.length > 0), 'every gate has an automated check');
});

test('a run records its outcome; a pattern that matches no test does not pass', () => {
  const repo = resolve(import.meta.dirname, '..');
  const res = runControlChecks(repo, { only: ['CS-02', 'CS-16'] });
  // CS-16 now has an automated measurement procedure; it stays a measurement, never a gate.
  assert.equal(res.results.find((r) => r.id === 'CS-02')!.status, 'pass');
  assert.equal(res.results.find((r) => r.id === 'CS-16')!.status, 'pass');
  assert.equal(res.results.find((r) => r.id === 'CS-16')!.kind, 'measurement');
  assert.equal(res.complete, false);
  assert.equal(res.adoption_blocked, true, 'a partial run never clears adoption');
  const h = makeHarness();
  try {
    const rec = h.auditor.do('library', 'record_control_checks', { results: res.results, workstation: 'test' });
    assert.equal(rec.adoption_blocked, true);
    assert.ok(rec.unchecked_gates.includes('CS-24'));
    // A failed gate relabelled as a measurement still blocks: kinds come from the controller's table.
    const relabelled = h.auditor.do('library', 'record_control_checks', { results: [{ id: 'CS-02', scenario: 'x', kind: 'measurement', status: 'fail', detail: 'simulated' }] });
    assert.equal(relabelled.adoption_blocked, true);
    const doc = h.ws.store('library', true).archive.getJson<{ provenance: string }>(rec.artifact.artifact);
    assert.match(doc.provenance, /not a trusted-runner receipt/);
    assert.throws(() => h.auditor.do('library', 'record_control_checks', { results: [{ id: 'CS-99', scenario: 'x', kind: 'gate', status: 'pass', detail: '' }] }), (e) => isHarnessError(e, 'invalid_request'));
    const failing = h.auditor.do('library', 'record_control_checks', { results: [{ id: 'CS-02', scenario: 'x', kind: 'gate', status: 'fail', detail: 'simulated' }] });
    assert.equal(failing.adoption_blocked, true);
  } finally {
    h.cleanup();
  }
});
