// Delivery step 3: a small property campaign over the same records (design/audit-harness.md,
// "Three investigation methods"; harness-evaluation.md, "Accounting property that appears to pass").
// The guarantee is reviewed, the property's semantics approved, the invariant campaign runs in the
// sandbox, and adequacy is established only by a reviewed fault in a disposable copy that the
// campaign detects. A campaign whose every action reverts cannot count as adequate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './helpers.ts';
import { acceptPolicy, display, head, LIMITS } from './decision-fixtures.ts';
import { runQueue } from '../src/runner/index.ts';
import { isHarnessError } from '../src/core/errors.ts';
import type { Ref } from '../src/core/refs.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const INVARIANT = readFileSync(join(FIXTURES, 'vault-property', 'test', 'VaultInvariant.t.sol'), 'utf8');
const ALL_REVERT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "../src/Vault.sol";
contract StuckHandler { uint256 public n; function act() external { n += 1; revert("every action reverts"); } }
contract StuckInvariant {
    Vault vault;
    StuckHandler handler;
    function setUp() public { vault = new Vault(); handler = new StuckHandler(); }
    function targetContracts() public view returns (address[] memory t) { t = new address[](1); t[0] = address(handler); }
    function invariant_trivially_holds() public view { require(address(vault).balance == 0, "never fails"); }
}
`;

test('property campaign: semantics approved, campaign run, adequacy only from a detected reviewed fault', { timeout: 240_000 }, async () => {
  const h = makeHarness();
  try {
    const eid = 'prop';
    const store = () => h.ws.store(eid, true);
    const target = join(h.dir, 'target');
    cpSync(join(FIXTURES, 'vault'), target, { recursive: true });
    h.auditor.do(eid, 'create_engagement', { name: 'Vault property', owner: 'auditor', audit_purpose: 'property campaign' });
    acceptPolicy(h, eid);
    const reg = h.auditor.do(eid, 'register_snapshot', { path: target, label: 'v1' });
    const eng = head(h, eid, 'eng-0001');
    const intake = h.screen.do(eid, 'authorize_work', {
      reviewed: [eng],
      display_receipt: display(h, eid, [eng]),
      inputs: { kind: 'intake', capabilities: { tools: ['forge_build'], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'build',
      rationale_authorship: 'human_written',
    }).work_authorization as Ref;
    h.auditor.do(eid, 'request_job', { authorization: intake, ...reg.build_request, limits: { runtime_seconds: 120 } });
    await runQueue(h.controller, eid);

    // The guarantee, reviewed through captured input and confirmation.
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'system_invariant', name: 'conservation', functions: [{ name: 'Vault.deposit' }, { name: 'Vault.withdraw' }] } }).audit_unit as Ref;
    const cap = h.capture.do(eid, 'capture_input', { text: 'The vault must always hold exactly what depositors are owed.' }).captured_input;
    const interp = h.auditor.do(eid, 'submit_proposal', { kind: 'interpretation', body: { captured_inputs: [cap], proposed: { kind: 'guarantee', affiliation: 'designed', statement: 'vault ether balance == sum of balances owed', audit_units: [unit] } } }).interpretation;
    const confirmed = h.screen.do(eid, 'record_decision', { decision_kind: 'confirm_interpretations', reviewed: [interp], display_receipt: display(h, eid, [interp]), inputs: { items: [{ interpretation: interp, choice: 'confirm' }] }, rationale: 'r', rationale_authorship: 'human_written' });
    const guarantee = confirmed.items[0].statement as Ref;
    h.screen.do(eid, 'record_decision', { decision_kind: 'record_flow_review', reviewed: [head(h, eid, unit.record_id)], display_receipt: display(h, eid, [head(h, eid, unit.record_id)]), inputs: { audit_unit: head(h, eid, unit.record_id) }, rationale: 'r', rationale_authorship: 'human_written' });

    const inv = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'property', question: 'Does the vault always hold exactly what depositors are owed?', audit_units: [head(h, eid, unit.record_id)], guarantees: ['conservation'], potential_impact: 'high' } }).investigation as Ref;
    const prop = h.auditor.do(eid, 'submit_proposal', {
      kind: 'property',
      body: { investigation: inv, intended_behavior: [guarantee], actors: ['depositor'], actions: ['deposit', 'withdraw'], units_and_bounds: 'wei; deposits up to 1 ether each', environment_assumptions: ['plain ether, no fee'], check_oracle: 'ghost ledger of deposits minus withdrawals, kept by the handler independently of the vault', excluded_actions: [] },
    }).property as Ref;
    // Semantic review before the campaign counts.
    h.screen.do(eid, 'record_decision', { decision_kind: 'approve_semantics', reviewed: [prop], display_receipt: display(h, eid, [prop]), inputs: { property: prop, actions: ['deposit', 'withdraw'] }, rationale: 'oracle is independent of the vault', rationale_authorship: 'human_written' });
    const invHead = head(h, eid, inv.record_id);
    const batch = h.screen.do(eid, 'authorize_work', {
      reviewed: [invHead],
      display_receipt: display(h, eid, [invHead]),
      inputs: { kind: 'batch', investigations: [invHead], methods: ['property'], capabilities: { tools: ['forge_test'], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'run the campaign',
      rationale_authorship: 'human_written',
    }).work_authorization as Ref;

    const snap = store().headRef(reg.snapshot.record_id);
    const args = { match_contract: 'VaultInvariant', invariant_runs: 32, invariant_depth: 16, expect: [{ test: 'invariant_vault_holds_what_it_owes', expect: 'no_violation' }] };
    const fx = h.auditor.do(eid, 'submit_fixture', { files: { 'test/VaultInvariant.t.sol': INVARIANT }, investigation: inv });
    const campaign = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', args, snapshot: snap, fixture: fx.fixture, investigation: inv, limits: { runtime_seconds: 180 } });
    const q1 = await runQueue(h.controller, eid);
    const c1 = store().get(q1.ran[0].evidence!, 'evidence_artifact').body.structured_result!;
    assert.equal(c1.result_type, 'no_violation_observed');
    assert.ok(c1.campaign && c1.campaign.calls > 0 && !c1.campaign.all_actions_reverted, 'meaningful actions succeeded');

    // Adequacy is refused without a detected reviewed fault.
    const propHead = () => head(h, eid, prop.record_id);
    assert.throws(() => h.auditor.do(eid, 'submit_proposal', { kind: 'property', base: propHead(), body: { adequacy: { status: 'sufficient', reason: 'looks fine', evidence: [] } } }), (e) => isHarnessError(e, 'evidence_requirement_unmet'));
    // The reviewed fault: the balance is never cleared. The same campaign on a disposable copy must catch it.
    h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'adequacy', adapter: 'forge_test', args, snapshot: snap, fixture: fx.fixture, investigation: inv, lineage: campaign.job, guard_removal: { path: 'src/Vault.sol', find: 'balanceOf[msg.sender] = 0;', replace: '// reviewed fault: balance not cleared' }, limits: { runtime_seconds: 180 } });
    const q2 = await runQueue(h.controller, eid);
    const fault = store().get(q2.ran[0].evidence!, 'evidence_artifact');
    assert.equal(fault.body.structured_result!.result_type, 'counterexample', 'the property detects the reviewed fault');
    assert.ok(fault.body.structured_result!.campaign?.counterexample?.length, 'with the failing call sequence');
    assert.ok(readFileSync(join(target, 'src', 'Vault.sol'), 'utf8').includes('balanceOf[msg.sender] = 0;'), 'the original target is unchanged');
    const ok = h.auditor.do(eid, 'submit_proposal', { kind: 'property', base: propHead(), body: { adequacy: { status: 'sufficient', reason: 'detects the reviewed balance-not-cleared fault', evidence: [{ record_id: fault.record_id, revision: fault.revision }] } } });
    assert.ok(ok.property);

    // A second campaign whose every action reverts can never count as adequate.
    const fx2 = h.auditor.do(eid, 'submit_fixture', { files: { 'test/StuckInvariant.t.sol': ALL_REVERT }, investigation: inv });
    h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', args: { match_contract: 'StuckInvariant', invariant_runs: 8, invariant_depth: 8, expect: [{ test: 'invariant_trivially_holds', expect: 'no_violation' }] }, snapshot: snap, fixture: fx2.fixture, investigation: inv, limits: { runtime_seconds: 120 } });
    const q3 = await runQueue(h.controller, eid);
    const stuck = store().get(q3.ran[0].evidence!, 'evidence_artifact').body.structured_result!;
    assert.equal(stuck.campaign?.all_actions_reverted, true);
    assert.notEqual(stuck.result_type, 'no_violation_observed', 'a campaign that only reverts is not a clean pass');
    assert.throws(
      () => h.auditor.do(eid, 'submit_proposal', { kind: 'property', base: propHead(), body: { adequacy: { status: 'sufficient', reason: 'r', evidence: [{ record_id: fault.record_id, revision: fault.revision }] } } }),
      (e) => isHarnessError(e, 'evidence_requirement_unmet'),
    );
  } finally {
    h.cleanup();
  }
});
