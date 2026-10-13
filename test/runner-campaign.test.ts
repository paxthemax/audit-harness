import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHarness, newEngagement } from './helpers.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { runQueue } from '../src/runner/runner.ts';
import { interpretForgeTest } from '../src/runner/adapters.ts';
import { foundryProject, stageAuthorization, stageInvestigation, stageSnapshot } from './runner-fixtures.ts';

// Property campaigns (fuzz and invariant tests) and adequacy jobs, with real forge runs on the vault
// fixture and its handler-based invariant.

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

function vaultProject(dir: string): string {
  cpSync(join(fixtures, 'vault'), dir, { recursive: true });
  cpSync(join(fixtures, 'vault-property', 'test'), join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'foundry.toml'), readFileSync(join(dir, 'foundry.toml'), 'utf8') + '\n[invariant]\nruns = 16\ndepth = 16\nfail_on_revert = false\n');
  return dir;
}

const PROPERTY = { match_contract: 'VaultInvariant', expect: [{ test: 'invariant_vault_holds_what_it_owes', expect: 'no_violation' }] };

test('a holding invariant is no_violation_observed with campaign statistics; an adequacy job with the reviewed fault finds a counterexample', async () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const snapshot = stageSnapshot(h, eid, vaultProject(join(h.dir, 'vault')));
    const inv = stageInvestigation(h, eid, 'Does the vault always hold what it owes?');
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv] });
    const campaign = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args: PROPERTY });
    const fault = { path: 'src/Vault.sol', find: 'balanceOf[msg.sender] = 0;', replace: '' };
    // Adequacy jobs: a source edit, lineage to the campaign, otherwise identical.
    const base = { authorization: batch, purpose: 'adequacy', adapter: 'forge_test', snapshot, investigation: inv, args: PROPERTY, lineage: campaign.job, guard_removal: fault };
    assert.throws(() => h.auditor.do(eid, 'request_job', { ...base, guard_removal: null }), (e) => isHarnessError(e, 'invalid_request'));
    assert.throws(() => h.auditor.do(eid, 'request_job', { ...base, lineage: null }), (e) => isHarnessError(e, 'invalid_request'));
    assert.throws(() => h.auditor.do(eid, 'request_job', { ...base, args: { ...PROPERTY, invariant_runs: 4 } }), (e) => isHarnessError(e, 'invalid_request'));
    const adequacy = h.auditor.do(eid, 'request_job', base);
    // A positive control may not control an adequacy job, and adequacy only checks experiments.
    assert.throws(() => h.auditor.do(eid, 'request_job', { ...base, lineage: adequacy.job }), (e) => isHarnessError(e, 'invalid_request'));

    await runQueue(h.controller, eid);
    const s = h.ws.store(eid, true);
    const ev = (j: string) => s.heads('evidence_artifact').find((e) => e.body.job?.record_id === j)!.body;
    const held = ev(campaign.job.record_id).structured_result!;
    assert.equal(held.result_type, 'no_violation_observed');
    assert.ok(held.campaign!.runs > 0 && held.campaign!.calls > 0 && held.campaign!.reverts < held.campaign!.calls);
    assert.equal(held.campaign!.all_actions_reverted, false);
    assert.equal(held.campaign!.counterexample, null);

    const broken = ev(adequacy.job.record_id).structured_result!;
    assert.equal(broken.result_type, 'counterexample');
    assert.ok(broken.campaign!.counterexample!.length > 0);
    assert.ok(broken.campaign!.counterexample!.every((c) => /^Handler\.(deposit|withdraw)\(/.test(c)), broken.campaign!.counterexample!.join(' | '));
    assert.match(broken.tests[0].reason!, /vault balance != owed|ghost ledger mismatch/);
    // The fault went into the disposable copy only.
    const tree = s.archive.getTree(s.get(snapshot, 'target_snapshot').body.tree.artifact);
    assert.match(s.archive.getText(tree.files['src/Vault.sol']), /balanceOf\[msg\.sender\] = 0;/);
  } finally {
    h.cleanup();
  }
});

test('a campaign whose every action reverted is never no_violation_observed', async () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const dir = foundryProject(join(h.dir, 'locked'), {
      'src/Locked.sol': 'pragma solidity 0.8.30;\ncontract Locked { uint256 public n; function poke() external { revert("locked"); } }\n',
      'test/Locked.t.sol':
        'pragma solidity 0.8.30;\nimport "../src/Locked.sol";\ncontract LockedInvariant {\n  Locked l;\n  function setUp() public { l = new Locked(); }\n  function targetContracts() public view returns (address[] memory t) { t = new address[](1); t[0] = address(l); }\n  function invariant_zero() public view { require(l.n() == 0, "moved"); }\n}\n',
    });
    writeFileSync(join(dir, 'foundry.toml'), readFileSync(join(dir, 'foundry.toml'), 'utf8') + '[invariant]\nruns = 4\ndepth = 8\nfail_on_revert = false\n');
    const snapshot = stageSnapshot(h, eid, dir);
    const inv = stageInvestigation(h, eid);
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv] });
    const job = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args: { expect: [{ test: 'invariant_zero', expect: 'no_violation' }] } });
    await runQueue(h.controller, eid);
    const r = h.ws.store(eid, true).heads('evidence_artifact').find((e) => e.body.job?.record_id === job.job.record_id)!.body.structured_result!;
    assert.equal(r.result_type, 'inconclusive');
    assert.equal(r.campaign!.all_actions_reverted, true);
    assert.equal(r.campaign!.calls, r.campaign!.reverts);
    assert.match(r.interpretation, /^adequacy insufficient: every action reverted/);
  } finally {
    h.cleanup();
  }
});

test('forge output with extra JSON documents and fuzz counterexamples is parsed', () => {
  const results = {
    'test/F.t.sol:FuzzTest': {
      test_results: {
        'testFuzz_fail(uint256)': { status: 'Failure', reason: 'too big', counterexample: { Single: { calldata: '0x52f0', args: '1131', raw_args: '1131' } }, kind: { Fuzz: { runs: 3 } } },
      },
    },
  };
  const stdout = JSON.stringify(results) + '\n' + JSON.stringify({ timestamp: 1, event: 'failure', invariant: 'x' }) + '\n';
  const out = interpretForgeTest({ exit_code: 1, signal: null, timed_out: false, cancelled: false, stdout, stderr: '', stdout_truncated: false, stderr_truncated: false, args: { expect: [{ test: 'testFuzz_fail', expect: 'no_violation' }] }, mode: 'test' });
  assert.equal(out.result.result_type, 'counterexample');
  assert.equal(out.result.campaign!.runs, 3);
  assert.deepEqual(out.result.campaign!.counterexample, ['calldata 0x52f0 args (1131)']);
});
