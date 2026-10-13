import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, newEngagement, type Harness } from './helpers.ts';
import { acceptPolicy, acceptedFinding, decide, decisionStub, investigationBody, stage, stageOne, type Stage } from './report-fixtures.ts';
import { isHarnessError } from '../src/core/errors.ts';
import type { Ref } from '../src/core/refs.ts';
import type { Disposition } from '../src/core/values.ts';
import { defaultProofStatus } from '../src/decision/common.ts';
import { heldOutComparison, suppressedLeadClasses } from '../src/evaluation/heldout.ts';
import type { EvaluationReport } from '../src/evaluation/metrics.ts';

function contractPayload(eid: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'pilot-1',
    targets: [{ engagement: eid, snapshot: null, units: ['withdraw flow'] }],
    method_versions: ['workflow@1'],
    models: [{ provider: 'fake', model: 'fake-1', settings: 'temperature 0' }],
    tools: ['forge'],
    task_budgets: '4h per unit',
    data_access: 'consented code only',
    severity_rubric: 'impact x likelihood',
    dedup_policy: 'root cause',
    labels: [
      { case: 'vault-a', kind: 'seeded_fault', held_out: true, reference_defects: ['D1', 'D2'] },
      { case: 'tune-1', kind: 'repaired_variant', held_out: false, reference_defects: [] },
    ],
    metric_version: 'evaluation/1',
    targets_set_before_run: [{ metric: 'decision_quality', target: 'catch at least 3 of 4 canaries' }],
    ...extra,
  };
}

function render(h: Harness, scope: string, refs: Ref[]): Ref {
  const now = new Date().toISOString();
  return h.screen.do(scope, 'record_display', { rendered: refs, sections: [], started_at: now, ended_at: now }).display_receipt;
}

function freeze(h: Harness, contract: Ref, compared: string[]) {
  return h.screen.do('library', 'freeze_evaluation_contract', {
    reviewed: [contract],
    display_receipt: render(h, 'library', [contract]),
    inputs: { contract, compared_metrics: compared },
    rationale: 'contract reviewed before the run',
    rationale_authorship: 'human_written',
  });
}

/** An investigation and its review packet, not yet decided. */
function packetFor(h: Harness, eid: string, question: string): { packet: Ref; investigation: Ref } {
  const inv = stageOne(h, eid, 'investigation', investigationBody({ question, impact: 'high' }));
  const packet = stageOne(h, eid, 'review_packet', {
    investigation: inv,
    potential_impact: 'high',
    claim: question,
    decision_requested: 'dispose',
    supporting: [],
    refuting: [],
    failed_attempts: [],
    variants: [],
    linked_claims: [],
    challenge_required: true,
    challenger_position: null,
    author_position: null,
    challenge_independence: { same_model: null, same_provider: null, shared_premises: [], context: '' },
    unreviewed_statements: [],
    evidence_quality: defaultProofStatus(),
    replay_receipt: null,
    executable_confirmation_requested: false,
    proposed_disposition: null,
    next_check: null,
    missing_information: [],
    inbound_link_digest: 'sha256:' + '0'.repeat(64),
    evidence_watermark: 0,
    dependency_digest: 'sha256:' + '0'.repeat(64),
  });
  return { packet, investigation: inv };
}

/** The auditor's decision on a packet (fixture for dispose_investigation). */
function decidePacket(h: Harness, eid: string, pk: { packet: Ref; investigation: Ref }, disposition: Disposition): void {
  const dec = decisionStub(h, eid, 'dispose_investigation', { disposition });
  const store = h.ws.store(eid, true);
  const d = store.mustHead(dec.record_id, 'human_decision');
  stage(h, eid, [{ type: 'human_decision', record_id: d.record_id, base_revision: d.revision, body: { ...d.body, reviewed: [pk.packet] } } as Stage]);
  const i = store.mustHead(pk.investigation.record_id, 'investigation');
  stage(h, eid, [
    { type: 'investigation', record_id: i.record_id, base_revision: i.revision, body: { ...i.body, work_state: 'closed', disposition: { value: disposition, decision: { record_id: dec.record_id, revision: 2 } } } } as Stage,
  ]);
}

test('evaluation contracts are frozen on the screen with targets set before the run; frozen contracts never change', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    assert.throws(() => h.auditor.do('library', 'propose_evaluation_contract', contractPayload(eid, { targets_set_before_run: undefined })), (e) => isHarnessError(e, 'invalid_request'));
    assert.throws(() => h.auditor.do('library', 'propose_evaluation_contract', contractPayload('eng-missing')), (e) => isHarnessError(e, 'not_found'));
    const { evaluation_contract: c1 } = h.auditor.do('library', 'propose_evaluation_contract', contractPayload(eid));
    // Freezing is a screen action with a display receipt covering the contract revision.
    const freezePayload = (receipt: Ref, inputs: Record<string, unknown>) => ({
      reviewed: [c1],
      display_receipt: receipt,
      inputs,
      rationale: 'reviewed',
      rationale_authorship: 'human_written',
    });
    assert.throws(() => h.auditor.do('library', 'freeze_evaluation_contract', freezePayload(c1, { contract: c1, compared_metrics: [] })), (e) => isHarnessError(e, 'permission_denied'));
    assert.throws(() => h.screen.do('library', 'freeze_evaluation_contract', freezePayload(render(h, 'library', []), { contract: c1, compared_metrics: [] })), (e) => isHarnessError(e, 'display_required'));
    // Every compared metric needs a target fixed before the run; the list must be explicit.
    assert.throws(() => freeze(h, c1, ['resolved_candidate_precision']), (e) => isHarnessError(e, 'invalid_request'));
    assert.throws(() => h.screen.do('library', 'freeze_evaluation_contract', freezePayload(render(h, 'library', [c1]), { contract: c1 })), (e) => isHarnessError(e, 'invalid_request'));
    const f = freeze(h, c1, ['decision_quality']);
    const lib = () => h.ws.store('library', true);
    assert.equal(lib().mustHead(c1.record_id, 'evaluation_contract').body.status, 'frozen');
    assert.equal(lib().mustHead(f.decision.record_id, 'human_decision').body.kind, 'freeze_evaluation_contract');
    // A frozen contract is never revised; a new contract supersedes it.
    assert.throws(() => h.auditor.do('library', 'propose_evaluation_contract', { ...contractPayload(eid), base: f.evaluation_contract }), (e) => isHarnessError(e, 'permission_denied'));
    const { evaluation_contract: c2 } = h.auditor.do('library', 'propose_evaluation_contract', { ...contractPayload(eid, { name: 'pilot-1b' }), supersedes: f.evaluation_contract });
    const f2 = freeze(h, c2, []);
    assert.equal(f2.superseded.length, 1);
    const old = lib().mustHead(c1.record_id, 'evaluation_contract');
    assert.equal(old.body.status, 'superseded');
    assert.equal(old.body.name, 'pilot-1', 'the superseded contract keeps its content');
  } finally {
    h.cleanup();
  }
});

test('canaries are labelled outside the engagement and scored after the auditor decides; the metrics table reports them', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    acceptPolicy(h, eid);
    const invalidAccepted = packetFor(h, eid, 'Plausible but wrong drain');
    const invalidRejected = packetFor(h, eid, 'Plausible but wrong mint');
    const validDismissed = packetFor(h, eid, 'Real rounding loss');
    stageOne(h, eid, 'investigation', investigationBody({ question: 'open', impact: 'medium' }));
    const reg = (packet: Ref, kind: string) => h.auditor.do('library', 'register_canary', { engagement: eid, packet, kind }).canary;
    reg(invalidAccepted.packet, 'invalid_claim_plausible_narrative');
    reg(invalidRejected.packet, 'invalid_claim_plausible_narrative');
    reg(validDismissed.packet, 'valid_claim_weakened_counterargument');
    // The engagement's own records never show the label.
    const all = h.auditor.do(eid, 'read_records', {}).records;
    assert.ok(!JSON.stringify(all).includes('invalid_claim_plausible_narrative'));
    assert.ok(!all.some((r: { type: string }) => r.type === 'canary'));

    // The auditor decides the packets; a decided packet can no longer become a canary.
    decidePacket(h, eid, invalidAccepted, 'accepted');
    decidePacket(h, eid, invalidRejected, 'rejected');
    decidePacket(h, eid, validDismissed, 'triaged_out');
    const late = packetFor(h, eid, 'Seeded after the fact');
    decidePacket(h, eid, late, 'rejected');
    assert.throws(() => reg(late.packet, 'invalid_claim_plausible_narrative'), (e) => isHarnessError(e, 'invalid_request'));

    const scored = h.auditor.do('library', 'score_canaries', {});
    assert.equal(scored.scored.length, 3);
    assert.deepEqual(scored.scored.map((s: { caught: boolean }) => s.caught), [false, true, false]);

    const { finding } = acceptedFinding(h, eid, 'real issue');
    const extra = acceptedFinding(h, eid, 'unlabelled issue');
    const { evaluation_contract: c } = h.auditor.do('library', 'propose_evaluation_contract', contractPayload(eid));
    assert.throws(() => h.auditor.do('library', 'evaluation_report', { contract: c }), (e) => isHarnessError(e, 'invalid_request'));
    const fc = freeze(h, c, ['decision_quality']).evaluation_contract;
    const res = h.auditor.do<{ report: EvaluationReport; artifact: { artifact: string } }>('library', 'evaluation_report', {
      contract: fc,
      matches: [
        { case: 'vault-a', reference_defect: 'D1', engagement: eid, finding },
        { case: 'vault-a', reference_defect: 'D9', engagement: eid, finding },
      ],
    });
    const r = res.report;
    assert.equal(r.metric_version, 'evaluation/1');
    const e = r.engagements[0];
    assert.deepEqual(e.decision_quality.caught, { numerator: 1, denominator: 3, value: 0.3333 });
    assert.deepEqual(e.decision_quality.by_kind.valid_claim_weakened_counterargument, { numerator: 0, denominator: 1, value: 0 });
    assert.equal(e.decision_quality.target, 'catch at least 3 of 4 canaries');
    // Canary investigations are seeded test material, not output: the accepted invalid claim does not
    // inflate distinct_accepted, and the canary rejection and triage are not counted either.
    assert.equal(e.resolved_candidate_precision.distinct_accepted, 2);
    assert.equal(e.resolved_candidate_precision.distinct_rejected, 1, 'only the non-canary rejection');
    assert.equal(e.resolved_candidate_precision.triaged_out, 0);
    assert.equal(e.resolved_candidate_precision.unresolved_no_disposition, 1);
    assert.equal(e.disposition_mix.high.triaged_out ?? 0, 0);
    // Zero denominators are not_applicable, never 0% or 100%.
    assert.equal(e.replay_reliability.value.value, 'not_applicable');
    assert.equal(e.work_coverage.units.value, 'not_applicable');
    assert.equal(e.positive_control_outcomes.value.denominator, 1, 'the non-canary High rejection');
    // Known-defect recall uses only valid matches against the frozen labels.
    assert.deepEqual(r.known_defect_recall.value, { numerator: 1, denominator: 2, value: 0.5 });
    assert.equal(r.known_defect_recall.invalid_matches.length, 1);
    assert.deepEqual(r.known_defect_recall.unexpected_accepted_findings, [{ engagement: eid, finding: extra.finding.record_id }]);
    assert.ok(!JSON.stringify(r).match(/%\s*secure/i));
    // Stored as an archive artifact and referenced by an event.
    const lib = h.ws.store('library', true);
    assert.ok(lib.archive.has(res.artifact.artifact));
    assert.ok(lib.events().some((ev) => ev.kind === 'evaluation_report' && ev.result.artifact === res.artifact.artifact));
  } finally {
    h.cleanup();
  }
});

test('held-out comparison judges over runs, refuses tuning cases and feeds adopt_method_version; lead-class drops are measured', () => {
  const h = makeHarness();
  try {
    const r = heldOutComparison({
      cases: [
        { case: 'a', held_out: true, runs: [{ baseline: 'pass', candidate: 'pass' }, { baseline: 'pass', candidate: 'fail' }, { baseline: 'pass', candidate: 'pass' }] },
        { case: 'b', held_out: true, runs: [{ baseline: 'fail', candidate: 'fail' }, { baseline: 'pass', candidate: 'fail' }] },
        { case: 'c', held_out: true, runs: [{ baseline: 'pass', candidate: 'pass' }, { baseline: 'pass', candidate: 'pass' }] },
      ],
    });
    assert.deepEqual(r.evaluation.held_out, { cases: ['a', 'b', 'c'], runs_per_case: 2, baseline_failures: ['b'], candidate_failures: ['b'] });
    assert.deepEqual(r.spread[0], { case: 'a', runs: 3, baseline_failed_runs: 0, candidate_failed_runs: 1 });
    assert.deepEqual(r.regressions, []);
    assert.throws(() => heldOutComparison({ cases: [{ case: 't', held_out: false, runs: [{ baseline: 'pass', candidate: 'pass' }] }] }), (e) => isHarnessError(e, 'invalid_request'));
    // Against a contract, a case labelled as tuning is refused even if the input claims held_out.
    assert.throws(
      () => heldOutComparison({ cases: [{ case: 'tune-1', held_out: true, runs: [{ baseline: 'pass', candidate: 'pass' }] }] }, { labels: contractPayload('x').labels as never }),
      (e) => isHarnessError(e, 'invalid_request'),
    );

    const s = suppressedLeadClasses({ reentrancy: 4, rounding: 3, oracle: 1 }, { reentrancy: 4, rounding: 1 });
    assert.deepEqual(s.classes.map((c) => [c.class, c.drop]), [['oracle', 1], ['rounding', 2]]);

    // The operation needs a frozen contract and every held-out case it labels.
    const eid = newEngagement(h);
    const labels = [...contractPayload(eid).labels, { case: 'vault-b', kind: 'fresh_consented', held_out: true, reference_defects: [] }];
    const { evaluation_contract: draft } = h.auditor.do('library', 'propose_evaluation_contract', contractPayload(eid, { labels }));
    const twoRuns = [{ baseline: 'pass', candidate: 'pass' }, { baseline: 'pass', candidate: 'pass' }];
    const cases = [{ case: 'vault-a', held_out: true, runs: twoRuns }, { case: 'vault-b', held_out: true, runs: twoRuns }];
    assert.throws(() => h.auditor.do('library', 'held_out_comparison', { cases }), (e) => isHarnessError(e, 'invalid_request'));
    assert.throws(() => h.auditor.do('library', 'held_out_comparison', { contract: draft, cases }), (e) => isHarnessError(e, 'invalid_request'));
    const contract = freeze(h, draft, []).evaluation_contract;
    assert.throws(
      () => h.auditor.do('library', 'held_out_comparison', { contract, cases: [cases[0]] }),
      (e) => isHarnessError(e, 'invalid_request') && /omits held-out cases/.test(e.message),
    );
    const op = h.auditor.do('library', 'held_out_comparison', {
      contract,
      cases,
      lead_classes: { baseline: { rounding: 2 }, candidate: { rounding: 0 } },
    });
    assert.equal(op.suppressed_lead_classes.classes[0].class, 'rounding');

    // adopt_method_version takes only the recorded comparison: a hand-written evaluation is refused.
    const { method_version } = h.auditor.do('library', 'propose_method_version', { component: 'prompt', name: 'investigator', version: '2', description: 'tighter prompt' });
    const handWritten = { summary: 'looks fine', evidence: null, held_out: op.evaluation.held_out };
    assert.throws(() => decide(h, 'library', 'adopt_method_version', [method_version], { method_version, evaluation: handWritten }), (e) => isHarnessError(e, 'evidence_requirement_unmet'));
    const tampered = { ...op.evaluation, held_out: { ...op.evaluation.held_out, candidate_failures: [], baseline_failures: ['vault-a'] } };
    assert.throws(() => decide(h, 'library', 'adopt_method_version', [method_version], { method_version, evaluation: tampered }), (e) => isHarnessError(e, 'evidence_requirement_unmet'));
    const adopted = decide(h, 'library', 'adopt_method_version', [method_version], { method_version, evaluation: op.evaluation });
    assert.equal(h.ws.store('library', true).mustHead(adopted.method_version.record_id, 'method_version').body.status, 'adopted');
  } finally {
    h.cleanup();
  }
});
