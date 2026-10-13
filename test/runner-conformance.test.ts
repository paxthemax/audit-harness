import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeHarness, newEngagement } from './helpers.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { runQueue } from '../src/runner/runner.ts';
import { checkSandboxEgress, runConformance, type CheckResult } from '../src/runner/conformance.ts';
import { COUNTER_SOL, COUNTER_TEST_SOL, foundryProject, stageAuthorization, stageInvestigation, stageSnapshot } from './runner-fixtures.ts';

// Conformance (interface contracts, "Compatibility and conformance") for forge_build, forge_test and
// the reference agent host, recorded as trusted-runner evidence.

function byCheck(results: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(results.map((r) => [r.check, r]));
}

test('forge_build, forge_test and reference_agent pass their conformance checks; the sandbox denies egress', async () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const snapshot = stageSnapshot(h, eid, foundryProject(join(h.dir, 'project'), { 'src/Counter.sol': COUNTER_SOL, 'test/Counter.t.sol': COUNTER_TEST_SOL }));
    const inv = stageInvestigation(h, eid);
    const intake = stageAuthorization(h, eid, { kind: 'intake' });
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv] });
    h.auditor.do(eid, 'request_job', { authorization: intake, purpose: 'build', adapter: 'forge_build', snapshot });
    h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args: { match_test: 'testIncrements' } });
    await runQueue(h.controller, eid);

    for (const adapter of ['forge_build', 'forge_test']) {
      const { evidence, results } = await runConformance(h.auditor, eid, { adapter, snapshot });
      const r = byCheck(results);
      assert.deepEqual(results.filter((x) => x.status === 'fail'), [], adapter);
      for (const c of ['scoped_reads_writes', 'denied_capability_expansion', 'unsupported_mode_handling', 'bounded_resource_use', 'cancellation', 'duplicate_delivery', 'artifact_provenance', 'portable_replay']) {
        assert.equal(r[c].status, 'pass', `${adapter} ${c}: ${r[c].detail}`);
      }
      assert.equal(r.ambiguous_completion.status, 'not_applicable');
      const ev = h.ws.store(eid, true).get(evidence, 'evidence_artifact').body;
      assert.equal(ev.producer, 'trusted_runner');
      assert.equal(ev.structured_result!.mode, 'conformance');
      assert.equal(ev.eligible, true);
    }

    const agent = await runConformance(h.auditor, eid, { adapter: 'reference_agent', sandbox_egress: true });
    const r = byCheck(agent.results);
    assert.deepEqual(agent.results.filter((x) => x.status === 'fail'), []);
    for (const c of ['input_capture_outside_model', 'one_confined_instance_per_engagement', 'host_memory_off', 'no_write_to_hooks_or_config', 'provider_calls_only_via_broker', 'default_deny_egress', 'scoped_reads_writes']) {
      assert.equal(r[c].status, 'pass', `${c}: ${r[c].detail}`);
    }
    assert.equal(r.portable_replay.status, 'not_applicable');

    assert.equal((await checkSandboxEgress(h.controller)).status, 'pass');
    await assert.rejects(runConformance(h.runner, eid, { adapter: 'forge_test' }), (e) => isHarnessError(e, 'permission_denied'));
  } finally {
    h.cleanup();
  }
});
