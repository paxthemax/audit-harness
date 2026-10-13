// The first adoption milestone (design/audit-harness.md, "Delivery sequence"): a complete, replayable,
// resumable investigation under human authority, including a refuted lead and a changed-premise
// exercise. Everything here runs for real: snapshot freezing, the sandboxed Foundry build and PoC
// runs in bwrap without network, receipts, probes, decisions on the screen channel, a simulated
// controller restart, and a second snapshot that reopens the rejected lead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './helpers.ts';
import { acceptPolicy, display, head, LIMITS } from './decision-fixtures.ts';
import { Controller } from '../src/controller/controller.ts';
import { runQueue, reconcileOnStart } from '../src/runner/index.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { computeRequiredSet, requiredRefs } from '../src/report/requiredSet.ts';
import { verifyBundle } from '../src/report/bundle.ts';
import type { Ref } from '../src/core/refs.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const POC = readFileSync(join(FIXTURES, 'vault-poc', 'test', 'ReenterPoC.t.sol'), 'utf8');
const GUARDED = 'function withdraw() external nonReentrant {';

test('adoption milestone: refuted lead with positive control, restart, changed premise reopens it', { timeout: 240_000 }, async () => {
  const h = makeHarness();
  try {
    const eid = 'vault';
    const target = join(h.dir, 'target');
    cpSync(join(FIXTURES, 'vault'), target, { recursive: true });
    const store = () => h.ws.store(eid, true);

    // 01 Scope and limits: engagement, accepted policy, pinned snapshot.
    h.auditor.do(eid, 'create_engagement', { name: 'Vault audit', owner: 'auditor', audit_purpose: 'milestone' });
    acceptPolicy(h, eid);
    const reg = h.auditor.do(eid, 'register_snapshot', { path: target, label: 'v1' });
    assert.equal(reg.source_only, true);
    const snap1 = reg.snapshot as Ref;

    // Intake authorization, then the sandboxed baseline build and the project's own tests.
    const engHead = head(h, eid, 'eng-0001');
    const intake = h.screen.do(eid, 'authorize_work', {
      reviewed: [engHead],
      display_receipt: display(h, eid, [engHead]),
      inputs: { kind: 'intake', capabilities: { tools: ['forge_build', 'forge_test'], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'baseline build and test suite',
      rationale_authorship: 'human_written',
    }).work_authorization;
    h.auditor.do(eid, 'request_job', { authorization: intake, ...reg.build_request, limits: { runtime_seconds: 120 } });
    h.auditor.do(eid, 'request_job', { authorization: intake, purpose: 'baseline_tests', adapter: 'forge_test', snapshot: snap1, args: {}, limits: { runtime_seconds: 120 } });
    const q1 = await runQueue(h.controller, eid);
    assert.equal(q1.ran.length, 2);
    const built = store().mustHead(snap1.record_id, 'target_snapshot');
    assert.ok(built.body.inventory, 'the build produced a deterministic inventory');
    const baseline = store().get(q1.ran[1].evidence!, 'evidence_artifact');
    assert.equal(baseline.body.producer, 'trusted_runner');
    assert.equal(baseline.body.receipt!.sandbox.network, 'denied');

    // 03 Lensing: one flow, reviewed.
    const flow = h.auditor.do(eid, 'submit_proposal', {
      kind: 'audit_unit',
      body: { kind: 'flow', name: 'withdrawal', functions: [{ name: 'Vault.withdraw', reviewed: false }, { name: 'Vault.deposit', reviewed: false }] },
    }).audit_unit;
    h.screen.do(eid, 'record_decision', {
      decision_kind: 'record_flow_review',
      reviewed: [flow],
      display_receipt: display(h, eid, [flow], [], [flow]),
      inputs: { audit_unit: flow, reviewed_functions: ['Vault.withdraw', 'Vault.deposit'] },
      rationale: 'walked the withdrawal flow',
      rationale_authorship: 'human_written',
    });
    // FR-36: a second flow that writes the same store yields a composition unit with its own review status.
    h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'funding', functions: [{ name: 'Vault.deposit', reviewed: false }] } });
    const comps = h.auditor.do(eid, 'derive_compositions');
    assert.equal(comps.created.length, 1);
    const comp = store().get(comps.created[0], 'audit_unit');
    assert.equal(comp.body.kind, 'composition');
    assert.match(comp.body.name, /Vault\.balanceOf/);
    assert.equal(comp.body.review_status, 'not_started');
    const coverage = h.auditor.do(eid, 'function_coverage');
    assert.equal(coverage.available, true);
    assert.deepEqual(coverage.unreviewed, []);

    // 04 Authorize a batch with one high-impact scenario question.
    const inv = h.auditor.do(eid, 'submit_proposal', {
      kind: 'investigation',
      body: {
        method: 'scenario',
        question: 'Can a reentrant callback during withdraw pay out more than the entitlement?',
        executable: true,
        lead_generator: 'attack_vector_sweep',
        audit_units: [head(h, eid, flow.record_id)],
        guarantees: ['withdraw pays at most the caller balance'],
        potential_impact: 'high',
      },
    }).investigation as Ref;
    const invHead = head(h, eid, inv.record_id);
    h.screen.do(eid, 'authorize_work', {
      reviewed: [invHead],
      display_receipt: display(h, eid, [invHead]),
      inputs: { kind: 'batch', investigations: [invHead], methods: ['scenario'], capabilities: { tools: ['forge_test'], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'admit the reentrancy question',
      rationale_authorship: 'human_written',
    });

    // 05 Investigate: a variant, its PoC fixture, the experiment, then the guard-removed positive control.
    const variant = h.auditor.do(eid, 'submit_proposal', {
      kind: 'scenario_variant',
      body: {
        investigation: { record_id: inv.record_id },
        causal_sequence: ['attacker deposits 1 ether', 'withdraw sends ether to the attacker', 'receive() re-enters withdraw'],
        setup_powers: ['test contract funds the attacker with 1 ether', 'test contract deposits 5 ether as the victim'],
        expected_violation: 'attacker ends with at least 2 ether',
        defeating_condition: 'nonReentrant reverts the nested withdraw',
      },
    }).variant as Ref;
    const fx = h.auditor.do(eid, 'submit_fixture', { files: { 'test/ReenterPoC.t.sol': POC }, investigation: inv });
    assert.deepEqual(fx.overrides_target, []);
    const pocArgs = { match_test: 'test_reentrant_double_payout', expect: [{ test: 'test_reentrant_double_payout', expect: 'violation' }] };
    const exp = h.auditor.do(eid, 'request_job', {
      authorization: store().mustHead(inv.record_id, 'investigation').body.authorization,
      purpose: 'experiment',
      adapter: 'forge_test',
      args: pocArgs,
      snapshot: snap1,
      fixture: fx.fixture,
      investigation: inv,
      variant,
      limits: { runtime_seconds: 120 },
    });
    const q2 = await runQueue(h.controller, eid);
    const expEvidence = store().get(q2.ran[0].evidence!, 'evidence_artifact');
    assert.equal(expEvidence.body.structured_result!.result_type, 'no_violation_observed');

    h.auditor.do(eid, 'request_job', {
      authorization: store().mustHead(inv.record_id, 'investigation').body.authorization,
      purpose: 'positive_control',
      adapter: 'forge_test',
      args: pocArgs,
      snapshot: snap1,
      fixture: fx.fixture,
      investigation: inv,
      variant,
      lineage: exp.job,
      guard_removal: { path: 'src/Vault.sol', find: GUARDED, replace: 'function withdraw() external {' },
      limits: { runtime_seconds: 120 },
    });
    const q3 = await runQueue(h.controller, eid);
    const pcEvidence = store().get(q3.ran[0].evidence!, 'evidence_artifact');
    assert.equal(pcEvidence.body.structured_result!.result_type, 'counterexample', 'removing the guard shows the violation');
    assert.ok(readFileSync(join(target, 'src', 'Vault.sol'), 'utf8').includes(GUARDED), 'the original target is untouched');

    h.auditor.do(eid, 'submit_proposal', {
      kind: 'scenario_variant',
      base: head(h, eid, variant.record_id),
      body: { outcome: 'refuted', countercondition: { text: 'nonReentrant on withdraw reverts the nested call', evidence: [q2.ran[0].evidence] } },
    });
    // A dependency probe on the cited guard: the code of Vault.withdraw.
    const probe = h.auditor.do(eid, 'record_probe', { conclusion: head(h, eid, inv.record_id), kind: 'code_hash', query: { symbol: 'Vault.withdraw', path: 'src/Vault.sol' } });
    assert.equal(probe.status, 'evaluated');
    // A witness rerun probe: the PoC itself, baselined on the trusted experiment evidence.
    const witness = h.auditor.do(eid, 'record_probe', { conclusion: head(h, eid, inv.record_id), kind: 'witness_rerun', query: {}, baseline_evidence: q2.ran[0].evidence });
    assert.equal(witness.status, 'evaluated');

    // 06 Review: one combined packet; evidence first because potential impact is high.
    const pkt = h.auditor.do(eid, 'submit_review_packet', {
      investigation: head(h, eid, inv.record_id),
      claim: 'Reentrant double payout in withdraw',
      decision_requested: 'disposition',
      challenger_position: 'Challenger: the nested withdraw hits nonReentrant; the setup only funds accounts, no privileged impersonation.',
      author_position: 'Author: the attack reverts at the guard; with the guard removed the PoC pays out 2 ether.',
      proposed_disposition: { value: 'rejected', rationale: 'The nonReentrant guard defeats this callback path.' },
    }).packet as Ref;
    const packet = store().get(pkt, 'review_packet');
    assert.equal(packet.body.evidence_quality.positive_control, 'shows_violation');
    assert.equal(packet.body.variants.length, 1);
    const invReady = head(h, eid, inv.record_id);
    const sections = ['claim', 'evidence', 'challenger', 'evidence_quality', 'proposed_disposition'];
    const decision = h.screen.do(eid, 'record_decision', {
      decision_kind: 'dispose_investigation',
      reviewed: [pkt, invReady],
      display_receipt: display(h, eid, [pkt, invReady], sections),
      inputs: {
        packet: pkt,
        investigation: invReady,
        disposition: 'rejected',
        decisive_evidence: [q2.ran[0].evidence],
        countercondition: 'nonReentrant on Vault.withdraw',
        countercondition_scope: 'the withdraw callback path at snapshot v1',
      },
      rationale: 'The guard reverts the nested call; the positive control shows the PoC detects the violation without it.',
      rationale_authorship: 'human_written',
    });
    assert.equal(decision.disposition, 'rejected');

    // Resumability: a fresh controller process over the same workspace reconciles and sees everything.
    const restarted = new Controller(h.ws);
    assert.deepEqual(reconcileOnStart(restarted, eid), []);
    const after = restarted.auditor(h.ws.readSecret('auditor.key')).do(eid, 'read_records', { ids: [inv.record_id] }).records[0];
    assert.equal(after.body.disposition.value, 'rejected');
    assert.equal(store().verify().ok, true, 'records, events and archive blobs verify');

    // The standing revalidation allowance for reruns after a change.
    const engNow = head(h, eid, 'eng-0001');
    const reval = h.screen.do(eid, 'authorize_work', {
      reviewed: [engNow],
      display_receipt: display(h, eid, [engNow]),
      inputs: { kind: 'revalidation', capabilities: { tools: ['forge_build', 'forge_test'], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'standing revalidation allowance',
      rationale_authorship: 'human_written',
    }).work_authorization;

    // L6 changed premise: v2 removes the guard (moving the balance update) and adds sweep().
    const target2 = join(h.dir, 'target-v2');
    cpSync(target, target2, { recursive: true });
    const src = readFileSync(join(target2, 'src', 'Vault.sol'), 'utf8')
      .replace(GUARDED, 'function withdraw() external {')
      .replace(/\n}\s*$/, '\n\n    function sweep(address to) external {\n        payable(to).transfer(address(this).balance);\n    }\n}\n');
    writeFileSync(join(target2, 'src', 'Vault.sol'), src);
    const reg2 = h.auditor.do(eid, 'register_snapshot', { path: target2, label: 'v2' });
    assert.ok(reg2.diff.changes > 0);
    h.auditor.do(eid, 'request_job', { authorization: reval, ...reg2.build_request, limits: { runtime_seconds: 120 } });
    const q4 = await runQueue(h.controller, eid);
    // The build ran, then the witness rerun was queued automatically under the revalidation allowance.
    const rerun = q4.ran.map((r) => store().mustHead(r.job, 'job')).find((j) => j.body.purpose === 'probe');
    assert.ok(rerun, 'the PoC was rerun automatically on the new snapshot');
    assert.ok(rerun!.body.fixture, 'with its original fixture');
    const witnessNow = store().mustHead(witness.probe.record_id, 'dependency_probe');
    assert.equal(witnessNow.body.status, 'evaluated');
    assert.notEqual(witnessNow.body.result_digest, witness.result_digest, 'without the guard the PoC now shows the violation');
    const fresh = store()
      .heads('conclusion_freshness')
      .filter((f) => f.body.conclusion.record_id === inv.record_id)
      .sort((a, b) => a.record_id.localeCompare(b.record_id, 'en', { numeric: true }))
      .at(-1)!;
    assert.equal(fresh.body.value, 'affected', 'the rejected lead is reopened by its changed probe');
    const diff = store().get(store().mustHead(reg2.snapshot.record_id, 'target_snapshot').body.diff!, 'snapshot_diff');
    assert.ok(
      diff.body.changes.some((c) => c.item.includes('sweep') && c.mapping.kind === 'unreviewed_change_gap'),
      'the new function is an unreviewed-change gap',
    );
    // No new work dispatches on the old premise.
    assert.throws(
      () => h.auditor.do(eid, 'request_job', { authorization: store().mustHead(inv.record_id, 'investigation').body.authorization, purpose: 'experiment', adapter: 'forge_test', args: pocArgs, snapshot: reg2.snapshot, fixture: fx.fixture, investigation: inv, variant }),
      (e) => isHarnessError(e),
    );

    // 07 Report and close: the controller computes the required set; the report is generated from records.
    const required = computeRequiredSet(store());
    const pre = h.auditor.do(eid, 'prepare_export', { selection: requiredRefs(required), audience: 'client', redaction_policy: 'none' });
    assert.deepEqual(pre.unexplained_omissions, []);
    const report = store().archive.getText(pre.report.artifact);
    assert.match(report, /Privileged roles are trusted/);
    assert.match(report, /classify their own scenario/i, 'accepted residual risks are stated as limits');
    assert.match(report, new RegExp(inv.record_id), 'the rejected high-impact lead and its reopened freshness are listed');
    assert.doesNotMatch(report, /\d+% secure/);
    const out = join(h.dir, 'export');
    const rm = pre.report_manifest as Ref;
    h.screen.do(eid, 'approve_export', {
      reviewed: [rm],
      display_receipt: display(h, eid, [rm]),
      inputs: { report_manifest: rm, payload: pre.payload.artifact, audience: 'client', destination: out },
      rationale: 'release to the client',
      rationale_authorship: 'human_written',
    });
    h.auditor.do(eid, 'export_bundle', { report_manifest: head(h, eid, rm.record_id), destination: out });
    assert.equal(verifyBundle(out).ok, true, 'a recipient can verify every payload hash');
  } finally {
    h.cleanup();
  }
});
