import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { makeHarness, newEngagement, type Harness } from './helpers.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { git } from '../src/store/git.ts';
import { commandAdapter, foundryToolchain, registerAdapter } from '../src/runner/adapters.ts';
import { onJobCompleted } from '../src/runner/hooks.ts';
import { reconcileOnStart, runAuditorCommand, runJob, runQueue } from '../src/runner/runner.ts';
import { FakeProvider, ProviderBroker } from '../src/runner/provider.ts';
import { spendSummary } from '../src/runner/ledger.ts';
import { groupAlive } from '../src/runner/sandbox.ts';
import {
  COUNTER_SOL,
  COUNTER_TEST_SOL,
  foundryProject,
  stageAuthorization,
  stageCrashedAttempt,
  stageInvestigation,
  stagePolicy,
  stageSnapshot,
  contextFor,
} from './runner-fixtures.ts';

registerAdapter(commandAdapter({ name: 'bash_cmd', version: '1', executable: '/usr/bin/bash', purposes: ['experiment', 'agent'] }));

const built: { job: string; outputs: number }[] = [];
onJobCompleted('build', (_ctx, done) => {
  built.push({ job: done.job.record_id, outputs: done.evidenceBody?.receipt?.outputs.length ?? 0 });
});

function setup(files: Record<string, string> = { 'src/Counter.sol': COUNTER_SOL, 'test/Counter.t.sol': COUNTER_TEST_SOL }) {
  const h = makeHarness();
  const eid = newEngagement(h);
  const snapshot = stageSnapshot(h, eid, foundryProject(join(h.dir, 'project'), files));
  const inv = stageInvestigation(h, eid);
  return { h, eid, snapshot, inv };
}

function store(h: Harness, eid: string) {
  return h.ws.store(eid, true);
}

async function waitFor(cond: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a passing forge test produces eligible trusted evidence with a full receipt; build outputs reach hooks', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    const intake = stageAuthorization(h, eid, { kind: 'intake' });
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv] });
    const b = h.auditor.do(eid, 'request_job', { authorization: intake, purpose: 'build', adapter: 'forge_build', snapshot });
    const t = h.auditor.do(eid, 'request_job', {
      authorization: batch,
      purpose: 'experiment',
      adapter: 'forge_test',
      snapshot,
      investigation: inv,
      args: { match_test: 'testIncrements', expect: [{ test: 'CounterTest.testIncrements', expect: 'no_violation' }] },
    });
    const q = await runQueue(h.controller, eid);
    assert.equal(q.stopped, 'idle');
    assert.equal(q.ran.length, 2);

    const s = store(h, eid);
    const evBuild = s.heads('evidence_artifact').find((e) => e.body.job?.record_id === b.job.record_id)!;
    assert.equal(evBuild.body.producer, 'trusted_runner');
    assert.equal(evBuild.body.receipt!.exit_code, 0);
    const out = evBuild.body.receipt!.outputs.find((o) => o.path === 'out')!;
    const tree = s.archive.getTree(out.artifact.artifact);
    const counter = s.archive.getJson<Record<string, unknown>>(tree.files['Counter.sol/Counter.json']);
    for (const k of ['ast', 'abi', 'storageLayout', 'metadata', 'id']) assert.ok(k in counter, `artifact has ${k}`);
    assert.deepEqual(built, [{ job: b.job.record_id, outputs: 1 }]);

    const ev = s.heads('evidence_artifact').find((e) => e.body.job?.record_id === t.job.record_id)!;
    assert.equal(ev.body.eligible, true);
    assert.equal(ev.body.structured_result!.result_type, 'no_violation_observed');
    assert.equal(ev.body.receipt!.sandbox.network, 'denied');
    assert.equal(ev.body.receipt!.sandbox.kind, 'bwrap');
    assert.match(ev.body.receipt!.executable.digest!, /^sha256:/);
    assert.ok(!ev.body.receipt!.env_keys.some((k) => /KEY|TOKEN|SECRET/.test(k)));
    assert.deepEqual(ev.body.structured_result!.tests.map((x) => [x.name, x.status, x.expect]), [['CounterTest.testIncrements()', 'passed', 'no_violation']]);
    // Blobs are git-tracked with the record that references them.
    const tracked = git(s.dir, ['ls-files', 'archive']);
    assert.ok(tracked.includes(ev.body.receipt!.stdout.artifact.slice(7)));
    const att = s.mustHead(ev.body.attempt!.record_id, 'attempt');
    assert.equal(att.body.status, 'completed');
    assert.equal(att.body.grant!.revoked, true);
    assert.equal(s.mustHead(inv.record_id, 'investigation').body.jobs[0].record_id, t.job.record_id);
    // Ledger: reservation released once, actual recorded.
    const sum = spendSummary(s, batch.record_id);
    assert.equal(sum.runtime_seconds.reserved_outstanding, 0);
    assert.ok(sum.runtime_seconds.actual > 0);
  } finally {
    h.cleanup();
  }
});

test('expected-violation PoC: passing shows a counterexample, failing is not a clean result', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv] });
    const poc = (expect: string) =>
      h.auditor.do(eid, 'request_job', {
        authorization: batch,
        purpose: 'experiment',
        adapter: 'forge_test',
        snapshot,
        investigation: inv,
        args: { match_test: expect, expect: [{ test: expect, expect: 'violation' }] },
      });
    const a = poc('testIncrements'); // asserts "the violation" and passes
    const bJob = poc('testDoubleIncrementViolation'); // asserts the violation and fails
    await runQueue(h.controller, eid);
    const s = store(h, eid);
    const ev = (j: string) => s.heads('evidence_artifact').find((e) => e.body.job?.record_id === j)!.body;
    assert.equal(ev(a.job.record_id).structured_result!.result_type, 'counterexample');
    const failed = ev(bJob.job.record_id);
    assert.equal(failed.structured_result!.result_type, 'no_violation_observed');
    assert.match(failed.structured_result!.interpretation, /may indict the fixture/);
    // forge exited 1 (a test failed) but the process completed: the status is not the result.
    assert.equal(failed.receipt!.exit_code, 1);
    assert.equal(s.mustHead(failed.attempt!.record_id, 'attempt').body.status, 'completed');
  } finally {
    h.cleanup();
  }
});

test('the Foundry toolchain environment disables lint-on-build, offline and FFI', () => {
  const h = makeHarness();
  try {
    const env = foundryToolchain(h.ws).env;
    assert.equal(env.FOUNDRY_LINT_LINT_ON_BUILD, 'false');
    assert.equal(env.FOUNDRY_OFFLINE, 'true');
    assert.equal(env.FOUNDRY_FFI, 'false');
  } finally {
    h.cleanup();
  }
});

test('a compilation failure yields result error, a failed attempt and no eligible evidence', async () => {
  const { h, eid, snapshot, inv } = setup({ 'src/Broken.sol': 'pragma solidity 0.8.30; contract Broken { function f() public { x = ; } }\n' });
  try {
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv] });
    const r = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args: {} });
    const out = await runJob(h.controller, eid, r.job.record_id);
    assert.equal(out.status, 'failed');
    const s = store(h, eid);
    const ev = s.get(out.evidence!, 'evidence_artifact').body;
    assert.equal(ev.structured_result!.result_type, 'error');
    assert.equal(ev.eligible, false);
    assert.equal(s.mustHead(r.job.record_id, 'job').body.status, 'failed');
    const invNow = s.mustHead(inv.record_id, 'investigation').body;
    assert.equal(invNow.work_state, 'blocked');
    assert.deepEqual(invNow.refuting, []); // a failed job never means refuted
  } finally {
    h.cleanup();
  }
});

test('network egress from the sandbox is denied and the receipt records network denied', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], tools: ['bash_cmd'] });
    const r = h.auditor.do(eid, 'request_job', {
      authorization: batch,
      purpose: 'experiment',
      adapter: 'bash_cmd',
      snapshot,
      investigation: inv,
      args: { argv: ['-c', 'exec 3<>/dev/tcp/1.1.1.1/80 || exit 42; echo connected'] },
    });
    const out = await runJob(h.controller, eid, r.job.record_id);
    const s = store(h, eid);
    const ev = s.get(out.evidence!, 'evidence_artifact').body;
    assert.equal(ev.receipt!.exit_code, 42);
    assert.equal(ev.receipt!.sandbox.network, 'denied');
    assert.match(s.archive.getText(ev.receipt!.stderr.artifact), /Network is unreachable/);
    assert.ok(!s.archive.getText(ev.receipt!.stdout.artifact).includes('connected'));
    assert.ok(ev.limitations[0].startsWith('egress_denied'));
    assert.ok(ev.limitations.some((l) => /no disk quota on the \/work/.test(l)));
    assert.ok(ev.limitations.some((l) => /processes counted within the sandbox's user namespace|process count NOT enforced/.test(l)));
    assert.match(ev.structured_result!.interpretation, /^egress_denied/);
    assert.match(s.mustHead(r.attempt.record_id, 'attempt').body.reason!, /^egress_denied/);
    assert.ok(s.events().some((e) => e.kind === 'egress_denied'));
  } finally {
    h.cleanup();
  }
});

test('pause terminates the running process group, cancels one attempt and keeps partial output', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], tools: ['bash_cmd'] });
    const r = h.auditor.do(eid, 'request_job', {
      authorization: batch,
      purpose: 'experiment',
      adapter: 'bash_cmd',
      snapshot,
      investigation: inv,
      args: { argv: ['-c', 'echo partial-output; sleep 300 & sleep 300'] },
    });
    const running = runQueue(h.controller, eid);
    await waitFor(() => store(h, eid).mustHead(r.attempt.record_id, 'attempt').body.pid !== null);
    const pid = store(h, eid).mustHead(r.attempt.record_id, 'attempt').body.pid!;
    await new Promise((res) => setTimeout(res, 200));
    const paused = h.auditor.do(eid, 'pause', { reason: 'auditor pause' });
    assert.deepEqual(paused.stopped.map((x: { termination: string }) => x.termination), ['confirmed']);
    assert.equal(groupAlive(pid), false);
    const q = await running;
    assert.equal(q.stopped, 'paused');

    const s = store(h, eid);
    const atts = s.heads('attempt').filter((a) => a.body.job.record_id === r.job.record_id);
    assert.equal(atts.length, 1);
    assert.equal(atts[0].body.status, 'cancelled');
    assert.equal(atts[0].body.termination, 'confirmed');
    const ev = s.get(atts[0].body.receipt!, 'evidence_artifact').body;
    assert.equal(ev.eligible, false);
    assert.equal(ev.structured_result!.result_type, 'inconclusive');
    assert.match(s.archive.getText(ev.receipt!.stdout.artifact), /partial-output/);
    assert.equal(s.mustHead(r.job.record_id, 'job').body.status, 'queued');
    // Paused: no new dispatch, no new requests.
    assert.throws(() => h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'bash_cmd', snapshot, investigation: inv, args: { argv: ['-c', 'true'] } }), (e) => isHarnessError(e, 'permission_denied'));
    assert.equal((await runQueue(h.controller, eid)).stopped, 'paused');
    const resumed = h.auditor.do(eid, 'resume', { reason: 'continue' });
    assert.deepEqual(resumed.suspended, []);
    // The ledger charged the stopped attempt once.
    const ledger = s.heads('ledger_entry').filter((e) => e.body.attempt?.record_id === r.attempt.record_id);
    assert.equal(ledger.filter((e) => e.body.kind === 'actual').length, 1);
    assert.equal(ledger.filter((e) => e.body.kind === 'release').length, 1);
  } finally {
    h.cleanup();
  }
});

test('budget exhaustion refuses dispatch', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], limits: { runtime_seconds: 100 } });
    h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args: { match_test: 'testIncrements' }, limits: { runtime_seconds: 80 } });
    assert.throws(
      () => h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args: { match_test: 'testOther' }, limits: { runtime_seconds: 30 } }),
      (e) => isHarnessError(e, 'budget_exhausted'),
    );
    // Capability outside the grant and a wrong authorization kind are refused too.
    assert.throws(() => h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'bash_cmd', snapshot, investigation: inv, args: {} }), (e) => isHarnessError(e, 'permission_denied'));
    assert.throws(() => h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'build', adapter: 'forge_build', snapshot }), (e) => isHarnessError(e, 'permission_denied'));
  } finally {
    h.cleanup();
  }
});

test('identical input retries as a new attempt of the same job; changed input is a new job with lineage', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], limits: { retries: 1, repairs_per_variant: 1 } });
    const req = { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args: { match_test: 'testIncrements' }, limits: { runtime_seconds: 120 } };
    const first = h.auditor.do(eid, 'request_job', req);
    // While queued, the same request is the same job and attempt (no new reservation).
    const dup = h.auditor.do(eid, 'request_job', req);
    assert.equal(dup.duplicate, true);
    assert.equal(dup.attempt.record_id, first.attempt.record_id);
    await runJob(h.controller, eid, first.job.record_id);
    const retry = h.auditor.do(eid, 'request_job', req);
    assert.equal(retry.retry, true);
    assert.equal(retry.job.record_id, first.job.record_id);
    assert.notEqual(retry.attempt.record_id, first.attempt.record_id);
    await runJob(h.controller, eid, first.job.record_id);
    assert.throws(() => h.auditor.do(eid, 'request_job', req), (e) => isHarnessError(e, 'budget_exhausted'));

    const changed = h.auditor.do(eid, 'request_job', { ...req, args: { match_test: 'testIncrements', fuzz_runs: 10 }, lineage: first.job });
    assert.notEqual(changed.job.record_id, first.job.record_id);
    const s = store(h, eid);
    assert.deepEqual(s.mustHead(changed.job.record_id, 'job').body.lineage, first.job);
    assert.equal(s.mustHead(first.job.record_id, 'job').body.attempts.length, 2);
  } finally {
    h.cleanup();
  }
});

test('a duplicate completion is idempotent: one canonical completion, no duplicate evidence or charges', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv] });
    const r = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args: { match_test: 'testIncrements' } });
    const out = await runJob(h.controller, eid, r.job.record_id);
    const s = store(h, eid);
    const ev = s.get(out.evidence!, 'evidence_artifact').body;
    const before = { ev: s.heads('evidence_artifact').length, ledger: s.heads('ledger_entry').length };
    const again = h.runner.do(eid, 'complete_attempt', {
      attempt: r.attempt.record_id,
      run: { receipt: ev.receipt, result: ev.structured_result, failed: null, missing_or_truncated: [], limitations: [], environment_reads: null, termination: 'not_applicable', blobs: [] },
    });
    assert.equal(again.duplicate, true);
    assert.equal(again.evidence.record_id, out.evidence!.record_id);
    const s2 = store(h, eid);
    assert.deepEqual({ ev: s2.heads('evidence_artifact').length, ledger: s2.heads('ledger_entry').length }, before);
  } finally {
    h.cleanup();
  }
});

test('worker outbox requests run under the attempt grant; requests outside it are refused and recorded', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], tools: ['bash_cmd'] });
    const other = stageInvestigation(h, eid, 'A different question');
    const write = (name: string, v: unknown) => `printf '%s' '${JSON.stringify(v)}' > /outbox/${name}`;
    const script = [
      write('01-read.json', { operation: 'read_records', payload: { type: 'investigation' } }),
      write('02-prepare.json', { operation: 'prepare_work', payload: {} }),
      write('03-decide.json', { operation: 'record_decision', payload: {} }),
      write('04-other.json', {
        operation: 'request_job',
        payload: { authorization: batch.record_id, purpose: 'experiment', adapter: 'bash_cmd', snapshot, investigation: other, args: { argv: ['-c', 'true'] } },
      }),
      'test -r "$HARNESS_GRANT_FILE" && echo grant-readable; true',
    ].join('; ');
    const r = h.auditor.do(eid, 'request_job', {
      authorization: batch,
      purpose: 'agent',
      role: 'investigator',
      context_manifest: contextFor(h, eid, 'investigator', inv),
      adapter: 'bash_cmd',
      snapshot,
      investigation: inv,
      args: { argv: ['-c', script] },
    });
    const out = await runJob(h.controller, eid, r.job.record_id);
    assert.equal(out.status, 'completed');
    const s = store(h, eid);
    const refusals = s.events().filter((e) => e.kind === 'worker_request_refused').map((e) => [e.result.file, e.result.code]);
    assert.deepEqual(refusals, [
      ['02-prepare.json', 'permission_denied'],
      ['03-decide.json', 'permission_denied'],
      ['04-other.json', 'permission_denied'],
    ]);
    const ev = s.get(out.evidence!, 'evidence_artifact').body;
    assert.equal(ev.limitations.filter((l) => /worker request/.test(l)).length, 3);
    // The grant file is not exposed (bash_cmd does not declare grant_in_sandbox) and the grant is revoked now.
    assert.ok(!s.archive.getText(ev.receipt!.stdout.artifact).includes('grant-readable'));
    assert.equal(s.mustHead(r.attempt.record_id, 'attempt').body.grant!.revoked, true);
    assert.equal(s.heads('job').length, 1); // the out-of-question request created nothing
  } finally {
    h.cleanup();
  }
});

test('restart reconciliation marks a running attempt with a dead pid failed and never re-executes it', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv] });
    const r = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args: {} });
    const dead = spawnSync('/usr/bin/true').pid!;
    stageCrashedAttempt(h, eid, r.attempt.record_id, dead);
    // Dispatch is refused while an attempt is recorded running.
    assert.throws(() => h.runner.do(eid, 'start_attempt', { job: r.job.record_id, grant_digest: 'sha256:' + '2'.repeat(64) }));
    const rec = reconcileOnStart(h.controller, eid);
    assert.equal(rec.length, 1);
    const s = store(h, eid);
    const att = s.mustHead(r.attempt.record_id, 'attempt').body;
    assert.equal(att.status, 'failed');
    assert.equal(att.termination, 'confirmed');
    assert.match(att.reason!, /reconciled after runner restart/);
    assert.equal(s.mustHead(r.job.record_id, 'job').body.status, 'failed');
    assert.equal(s.mustHead(r.job.record_id, 'job').body.attempts.length, 1);
    assert.equal(s.heads('evidence_artifact').length, 0);
    assert.equal(s.mustHead(inv.record_id, 'investigation').body.work_state, 'blocked');
    assert.equal(spendSummary(s, batch.record_id).runtime_seconds.reserved_outstanding, 0);
    assert.deepEqual(reconcileOnStart(h.controller, eid), []);
  } finally {
    h.cleanup();
  }
});

test('provider timeout: outcome_unknown, uncertain spend, reservation kept; a retry needs a new reservation', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    stagePolicy(h, eid, { live_exploitable_class: 'unfixed', approved_providers: ['fake'], data_classes: ['source', 'unfixed'] });
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], providers: ['fake'], limits: { retries: 1, spend: 5 } });
    const provider = new FakeProvider({ script: ['hang', 'ok'] });
    const broker = new ProviderBroker(h.controller, { timeoutMs: 100 });
    broker.register(provider, 'secret-credential-xyz');
    const tree = store(h, eid).get(snapshot, 'target_snapshot').body.tree;
    const fileDigest = Object.values(store(h, eid).archive.getTree(tree.artifact).files)[0];
    const payload = { authorization: batch, provider: 'fake', model: 'fake-model-1', data_class: 'source', context: [{ artifact: fileDigest }], max_output_tokens: 100, purpose: 'explain' };

    const first = await broker.call(h.auditor, eid, payload);
    assert.equal(first.outcome, 'outcome_unknown');
    assert.equal(first.spend_status, 'uncertain');
    let sum = spendSummary(store(h, eid), batch.record_id);
    assert.ok(sum.uncertain > 0);
    assert.equal(sum.confirmed, 0);

    const second = await broker.call(h.auditor, eid, payload);
    assert.equal(second.outcome, 'completed');
    assert.match(second.model_returned!, /^fake-model-1@/);
    const s = store(h, eid);
    assert.equal(s.heads('ledger_entry').filter((e) => e.body.kind === 'reservation' && e.body.note.includes('provider_call')).length, 2);
    sum = spendSummary(s, batch.record_id);
    assert.ok(sum.confirmed > 0 && sum.uncertain > 0);
    // Retry cap: no third reservation for the same request.
    assert.throws(() => h.auditor.do(eid, 'request_provider_call', payload), (e) => isHarnessError(e, 'budget_exhausted'));
    // Arbitrary text and unadmitted artifacts are refused; credentials never reach the store.
    assert.throws(() => h.auditor.do(eid, 'request_provider_call', { ...payload, text: 'hi' }), (e) => isHarnessError(e, 'invalid_request'));
    assert.throws(() => h.auditor.do(eid, 'request_provider_call', { ...payload, context: [{ artifact: 'sha256:' + 'f'.repeat(64) }] }), (e) => isHarnessError(e, 'egress_denied'));
    assert.throws(() => h.auditor.do(eid, 'request_provider_call', { ...payload, data_class: 'unfixed' }), (e) => isHarnessError(e, 'egress_denied'));
    assert.equal(spawnSync('git', ['grep', '-q', 'secret-credential-xyz', 'HEAD'], { cwd: s.dir }).status, 1);
    assert.equal(provider.received[0].credential, 'secret-credential-xyz');
  } finally {
    h.cleanup();
  }
});

test('FR-41: an auditor command gets a trusted receipt; an imported artifact is labelled untrusted', async () => {
  const { h, eid, snapshot } = setup();
  try {
    const r = await runAuditorCommand(h.auditor, eid, { argv: ['forge', 'test', '--json', '--offline', '--match-test', 'testIncrements'], description: 'auditor reran the unit test', snapshot });
    const s = store(h, eid);
    const ev = s.get(r.evidence, 'evidence_artifact').body;
    assert.equal(ev.producer, 'trusted_runner');
    assert.equal(ev.receipt!.exit_code, 0);
    assert.equal(ev.job, null);
    await assert.rejects(runAuditorCommand(h.runner, eid, { argv: ['/usr/bin/true'], description: 'x' }), (e) => isHarnessError(e, 'permission_denied'));

    const imp = h.auditor.do(eid, 'import_auditor_artifact', { paths: [join(h.dir, 'project', 'foundry.toml')], description: 'log from my terminal', claimed: { argv: ['forge', 'test'], exit_code: 0 } });
    const iv = store(h, eid).get(imp.evidence, 'evidence_artifact').body;
    assert.equal(iv.producer, 'auditor_run_untrusted');
    assert.equal(iv.eligible, false);
    assert.equal(iv.receipt, null);
    assert.match(iv.limitations[0], /untrusted receipt/);
  } finally {
    h.cleanup();
  }
});

test('positive control: the guard is removed from a disposable copy only, and the rerun shows the violation', async () => {
  const guarded = COUNTER_SOL.replace('function inc() external { n += 1; }', 'function inc() external { require(n < 1, "guard"); n += 1; }');
  const { h, eid, snapshot, inv } = setup({
    'src/Counter.sol': guarded,
    'test/Counter.t.sol': COUNTER_TEST_SOL.replace('c.inc(); require(c.n() == 2', 'c.inc(); c.inc(); require(c.n() == 2'),
  });
  try {
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv] });
    const args = { match_test: 'testDoubleIncrementViolation', expect: [{ test: 'testDoubleIncrementViolation', expect: 'violation' }] };
    const orig = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args });
    const pc = h.auditor.do(eid, 'request_job', {
      authorization: batch,
      purpose: 'positive_control',
      adapter: 'forge_test',
      snapshot,
      investigation: inv,
      args,
      lineage: orig.job,
      guard_removal: { path: 'src/Counter.sol', find: 'require(n < 1, "guard");', replace: '' },
    });
    // A control must name its lineage, remove a guard, and otherwise match the controlled job exactly.
    const bad = (extra: Record<string, unknown>) =>
      assert.throws(
        () => h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'positive_control', adapter: 'forge_test', snapshot, investigation: inv, args, lineage: orig.job, guard_removal: { path: 'src/Counter.sol', find: 'x', replace: '' }, ...extra }),
        (e) => isHarnessError(e, 'invalid_request'),
      );
    bad({ guard_removal: null });
    bad({ lineage: null });
    bad({ args: { ...args, fuzz_runs: 3 } });
    const otherInv = stageInvestigation(h, eid, 'Another question');
    const batch2 = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv, otherInv] });
    assert.throws(
      () => h.auditor.do(eid, 'request_job', { authorization: batch2, purpose: 'positive_control', adapter: 'forge_test', snapshot, investigation: otherInv, args, lineage: orig.job, guard_removal: { path: 'src/Counter.sol', find: 'x', replace: '' } }),
      (e) => isHarnessError(e, 'invalid_request'),
    );
    await runQueue(h.controller, eid);
    const s = store(h, eid);
    const ev = (j: string) => s.heads('evidence_artifact').find((e) => e.body.job?.record_id === j)!.body;
    assert.equal(ev(orig.job.record_id).structured_result!.result_type, 'no_violation_observed');
    const control = ev(pc.job.record_id);
    assert.equal(control.structured_result!.result_type, 'counterexample');
    assert.equal(control.positive_control_for!.record_id, inv.record_id);
    assert.deepEqual(s.mustHead(pc.job.record_id, 'job').body.lineage, orig.job);
    // The snapshot's source is untouched.
    const tree = s.archive.getTree(s.get(snapshot, 'target_snapshot').body.tree.artifact);
    assert.match(s.archive.getText(tree.files['src/Counter.sol']), /require\(n < 1, "guard"\)/);
  } finally {
    h.cleanup();
  }
});
