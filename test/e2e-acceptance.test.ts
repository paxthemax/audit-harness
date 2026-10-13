// Delivery step 3 integration scenario and the evaluation plan's third worked walkthrough ("A fix blocks
// legitimate exits"): an exploitable vault, a PoC that demonstrates the double payout, a clean replay,
// acceptance at High on executable replay, a client patch that stops the theft by disabling every
// withdrawal, and a fix assessment that must come out `regressive`, never `fixed`. Real sandboxed
// Foundry runs throughout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './helpers.ts';
import { acceptPolicy, display, head, LIMITS } from './decision-fixtures.ts';
import { runQueue } from '../src/runner/index.ts';
import { computeRequiredSet, requiredRefs } from '../src/report/requiredSet.ts';
import { verifyBundle } from '../src/report/bundle.ts';
import type { Ref } from '../src/core/refs.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const POC = readFileSync(join(FIXTURES, 'vault-poc', 'test', 'ReenterPoC.t.sol'), 'utf8');
const GUARDED = 'function withdraw() external nonReentrant {';

test('integration: accepted High finding on clean replay; a regressive fix is reported as regressive', { timeout: 240_000 }, async () => {
  const h = makeHarness();
  try {
    const eid = 'vault2';
    const store = () => h.ws.store(eid, true);
    const target = join(h.dir, 'target');
    cpSync(join(FIXTURES, 'vault'), target, { recursive: true });
    const vulnerable = readFileSync(join(target, 'src', 'Vault.sol'), 'utf8').replace(GUARDED, 'function withdraw() external {');
    writeFileSync(join(target, 'src', 'Vault.sol'), vulnerable);

    h.auditor.do(eid, 'create_engagement', { name: 'Vault v2', owner: 'auditor', audit_purpose: 'integration scenario' });
    acceptPolicy(h, eid);
    const reg = h.auditor.do(eid, 'register_snapshot', { path: target, label: 'v1' });
    const eng = head(h, eid, 'eng-0001');
    const reval = h.screen.do(eid, 'authorize_work', {
      reviewed: [eng],
      display_receipt: display(h, eid, [eng]),
      inputs: { kind: 'revalidation', capabilities: { tools: ['forge_build', 'forge_test'], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'builds and reruns across snapshots',
      rationale_authorship: 'human_written',
    }).work_authorization as Ref;
    h.auditor.do(eid, 'request_job', { authorization: reval, ...reg.build_request, limits: { runtime_seconds: 120 } });
    await runQueue(h.controller, eid);

    const flow = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal', functions: [{ name: 'Vault.withdraw', reviewed: false }] } }).audit_unit;
    h.screen.do(eid, 'record_decision', {
      decision_kind: 'record_flow_review',
      reviewed: [flow],
      display_receipt: display(h, eid, [flow], [], [flow]),
      inputs: { audit_unit: flow, reviewed_functions: ['Vault.withdraw'] },
      rationale: 'walked the flow',
      rationale_authorship: 'human_written',
    });
    const inv = h.auditor.do(eid, 'submit_proposal', {
      kind: 'investigation',
      body: {
        method: 'scenario',
        question: 'Can a reentrant callback during withdraw pay out more than the entitlement?',
        lead_generator: 'attack_vector_sweep',
        audit_units: [head(h, eid, flow.record_id)],
        guarantees: ['withdraw pays at most the caller balance'],
        potential_impact: 'high',
        anchors: [{ path: 'src/Vault.sol', symbol: 'Vault.withdraw', start: null, length: null, content_digest: null, snapshot: null }],
      },
    }).investigation as Ref;
    const invHead = head(h, eid, inv.record_id);
    const batch = h.screen.do(eid, 'authorize_work', {
      reviewed: [invHead],
      display_receipt: display(h, eid, [invHead]),
      inputs: { kind: 'batch', investigations: [invHead], methods: ['scenario'], capabilities: { tools: ['forge_test'], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'admit',
      rationale_authorship: 'human_written',
    }).work_authorization as Ref;

    const variant = h.auditor.do(eid, 'submit_proposal', {
      kind: 'scenario_variant',
      body: { investigation: { record_id: inv.record_id }, causal_sequence: ['deposit 1 ether', 'withdraw', 're-enter from receive()'], setup_powers: ['test funds the attacker with 1 ether', 'test deposits 5 ether as the victim'], expected_violation: 'attacker ends with at least 2 ether', defeating_condition: 'a reentrancy guard or effects-before-interactions' },
    }).variant as Ref;
    const fx = h.auditor.do(eid, 'submit_fixture', { files: { 'test/ReenterPoC.t.sol': POC }, investigation: inv });
    const args = { match_test: 'test_reentrant_double_payout', expect: [{ test: 'test_reentrant_double_payout', expect: 'violation' }] };
    const snap1 = store().headRef(reg.snapshot.record_id);
    const exp = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', args, snapshot: snap1, fixture: fx.fixture, investigation: inv, variant, limits: { runtime_seconds: 120 } });
    const q = await runQueue(h.controller, eid);
    assert.equal(store().get(q.ran[0].evidence!, 'evidence_artifact').body.structured_result!.result_type, 'counterexample');
    h.auditor.do(eid, 'submit_proposal', { kind: 'scenario_variant', base: head(h, eid, variant.record_id), body: { outcome: 'supports' } });
    // Clean replay: a fresh run of the same package.
    h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'replay', adapter: 'forge_test', args, snapshot: snap1, fixture: fx.fixture, investigation: inv, variant, lineage: exp.job, limits: { runtime_seconds: 120 } });
    const qr = await runQueue(h.controller, eid);
    const replay = store().get(qr.ran[0].evidence!, 'evidence_artifact');
    assert.equal(replay.body.structured_result!.result_type, 'counterexample');
    // A witness probe so the fix revision reruns the PoC automatically.
    h.auditor.do(eid, 'record_probe', { conclusion: head(h, eid, inv.record_id), kind: 'witness_rerun', query: {}, baseline_evidence: q.ran[0].evidence });

    const pkt = h.auditor.do(eid, 'submit_review_packet', {
      investigation: head(h, eid, inv.record_id),
      claim: 'Reentrant double payout in withdraw',
      decision_requested: 'disposition',
      challenger_position: 'Challenger: setup only funds accounts; no privileged power; the payout exceeds the deposit.',
      author_position: 'Author: withdraw pays before clearing the balance; the PoC and its clean replay both pay 2 ether.',
      proposed_disposition: { value: 'accepted', rationale: 'Clean replay demonstrates the excess payout.' },
    }).packet as Ref;
    assert.equal(store().get(pkt, 'review_packet').body.evidence_quality.replay, 'succeeded');
    const ready = head(h, eid, inv.record_id);
    const accepted = h.screen.do(eid, 'record_decision', {
      decision_kind: 'dispose_investigation',
      reviewed: [pkt, ready],
      display_receipt: display(h, eid, [pkt, ready], ['claim', 'evidence', 'challenger', 'evidence_quality', 'proposed_disposition']),
      inputs: {
        packet: pkt,
        investigation: ready,
        disposition: 'accepted',
        severity: 'High',
        evidence_route: 'executable_replay',
        finding: { title: 'Reentrant withdraw pays out more than the balance', mechanism: 'external call before the balance is cleared', impact: 'theft of other depositors\' ether' },
      },
      rationale: 'The clean replay shows the attacker withdrawing twice.',
      rationale_authorship: 'human_written',
    });
    const finding = accepted.findings[0] as Ref;

    // The client's patch: stop the theft by disabling withdrawals entirely.
    const fixTarget = join(h.dir, 'fix');
    cpSync(target, fixTarget, { recursive: true });
    writeFileSync(
      join(fixTarget, 'src', 'Vault.sol'),
      vulnerable.replace('function withdraw() external {\n', 'function withdraw() external {\n        revert("withdrawals disabled");\n'),
    );
    const reg2 = h.auditor.do(eid, 'register_snapshot', { path: fixTarget, label: 'fix-1' });
    h.auditor.do(eid, 'request_job', { authorization: reval, ...reg2.build_request, limits: { runtime_seconds: 120 } });
    h.auditor.do(eid, 'request_job', { authorization: reval, purpose: 'baseline_tests', adapter: 'forge_test', snapshot: reg2.snapshot, args: { match_test: 'test_withdraw_returns_deposit', expect: [{ test: 'test_withdraw_returns_deposit', expect: 'no_violation' }] }, limits: { runtime_seconds: 120 } });
    const q2 = await runQueue(h.controller, eid);
    const ranJobs = q2.ran.map((r) => store().mustHead(r.job, 'job'));
    const rerun = ranJobs.find((j) => j.body.purpose === 'probe');
    assert.ok(rerun, 'the PoC reran on the fix');
    const rerunEvidence = store().get(q2.ran.find((r) => r.job === rerun!.record_id)!.evidence!, 'evidence_artifact');
    assert.equal(rerunEvidence.body.structured_result!.result_type, 'no_violation_observed', 'the attack is blocked');
    const legitRun = q2.ran.find((r) => store().mustHead(r.job, 'job').body.purpose === 'baseline_tests')!;
    const legit = store().get(legitRun.evidence!, 'evidence_artifact');
    assert.equal(legit.body.structured_result!.result_type, 'counterexample', 'legitimate withdrawal now fails');

    const findingHead = head(h, eid, finding.record_id);
    const fixSnap = store().headRef(reg2.snapshot.record_id);
    const fixEvidence = [
      { record_id: rerunEvidence.record_id, revision: rerunEvidence.revision },
      { record_id: legit.record_id, revision: legit.revision },
    ];
    const fix = h.screen.do(eid, 'record_decision', {
      decision_kind: 'assess_fix',
      reviewed: [findingHead, fixSnap, ...fixEvidence],
      display_receipt: display(h, eid, [findingHead, fixSnap, ...fixEvidence]),
      inputs: { finding: findingHead, fix_snapshot: fixSnap, attack_status: 'blocked', legitimate_status: 'regressed', client_response: 'fixed', evidence: fixEvidence },
      rationale: 'The patch blocks the attack only by disabling every withdrawal.',
      rationale_authorship: 'human_written',
    });
    const assessment = store().get(fix.fix_assessment as Ref, 'fix_assessment');
    assert.equal(assessment.body.label, 'regressive');

    // The report states the derived label beside the finding and names both revisions.
    const pre = h.auditor.do(eid, 'prepare_export', { selection: requiredRefs(computeRequiredSet(store())), audience: 'client', redaction_policy: 'none' });
    const report = store().archive.getText(pre.report.artifact);
    assert.match(report, /regressive/);
    assert.match(report, /executable\\?_replay/);
    const rm = pre.report_manifest as Ref;
    const out = join(h.dir, 'export');
    h.screen.do(eid, 'approve_export', { reviewed: [rm], display_receipt: display(h, eid, [rm]), inputs: { report_manifest: rm, payload: pre.payload.artifact, audience: 'client', destination: out }, rationale: 'release', rationale_authorship: 'human_written' });
    h.auditor.do(eid, 'export_bundle', { report_manifest: head(h, eid, rm.record_id), destination: out });
    assert.equal(verifyBundle(out).ok, true);
  } finally {
    h.cleanup();
  }
});
