import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHarness, newEngagement } from './helpers.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { Controller } from '../src/controller/controller.ts';
import { interpretForgeTest, referenceAgentAdapter, registerAdapter } from '../src/runner/adapters.ts';
import { runJob, runQueue } from '../src/runner/runner.ts';
import { FakeProvider, manifestDataClass, ProviderBroker } from '../src/runner/provider.ts';
import { AnthropicProvider } from '../src/runner/anthropic.ts';
import { loadContextManifest } from '../src/runner/context.ts';
import { spendSummary } from '../src/runner/ledger.ts';
import { applySourceEdit, isRemovalOnly } from '../src/runner/sourceEdit.ts';
import { COUNTER_SOL, COUNTER_TEST_SOL, commit, contextFor, foundryProject, stageAuthorization, stageInvestigation, stagePolicy, stageSnapshot } from './runner-fixtures.ts';

// Second review: source edits on the target only (H1, H2), broker content and reservation ceilings
// (H4, H5), outbox expansion (M1), unexecuted reservations (M2), manifest data class (M3), forge
// interpretation (M5, M7, M8) and the node binding (L6).

registerAdapter(referenceAgentAdapter({ name: 'stub_agent2', agentDir: fileURLToPath(new URL('./fixtures/agent-stub/', import.meta.url)), registered_by: 'operator' }));

const GUARDED = COUNTER_SOL.replace('function inc() external { n += 1; }', 'function inc() external { require(n < 1, "guard"); n += 1; }');

function setup(files: Record<string, string> = { 'src/Counter.sol': GUARDED, 'test/Counter.t.sol': COUNTER_TEST_SOL }, providers: string[] = []) {
  const h = makeHarness();
  const eid = newEngagement(h);
  const snapshot = stageSnapshot(h, eid, foundryProject(join(h.dir, 'project'), files), true);
  const inv = stageInvestigation(h, eid);
  if (providers.length) stagePolicy(h, eid, { live_exploitable_class: 'unfixed', approved_providers: providers, data_classes: ['source'] });
  const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], providers, tools: ['forge_test', 'stub_agent2'], limits: { spend: 5 } });
  return { h, eid, snapshot, inv, batch };
}

function worker(S: ReturnType<typeof setup>) {
  const { h, eid, snapshot, inv, batch } = S;
  const job = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'agent', role: 'investigator', adapter: 'stub_agent2', snapshot, investigation: inv, context_manifest: contextFor(h, eid, 'investigator', inv), args: { task: 't', model: 'fake-model-1' } });
  const { token, digest } = Controller.newWorkerToken();
  const started = h.runner.do(eid, 'start_attempt', { job: job.job.record_id, grant_digest: digest });
  return { session: h.controller.worker(eid, token), attempt: started.attempt.record_id as string };
}

function messages(S: ReturnType<typeof setup>, body: unknown) {
  return { messages_request: S.h.ws.store(S.eid, true).archive.putJson({ format: 'harness.provider_messages_request/1', body }) };
}

test('H1/H2: source edits name target files untouched by the fixture; positive controls only remove; intake jobs take no edit', () => {
  const S = setup();
  const { h, eid, snapshot, inv, batch } = S;
  try {
    const args = { match_test: 'testDoubleIncrementViolation', expect: [{ test: 'testDoubleIncrementViolation', expect: 'violation' }] };
    const fixtureDir = mkdtempSync(join(h.dir, 'fx-'));
    mkdirSync(join(fixtureDir, 'src'));
    writeFileSync(join(fixtureDir, 'src', 'Counter.sol'), GUARDED);
    const fixture = h.ws.store(eid, true).archive.putTree(fixtureDir).ref;
    const orig = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args });
    const withFx = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args, fixture });
    const pc = (edit: Record<string, string>, extra: Record<string, unknown> = {}) =>
      h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'positive_control', adapter: 'forge_test', snapshot, investigation: inv, args, lineage: orig.job, guard_removal: edit, ...extra });
    const refused = (f: () => unknown, re: RegExp) => assert.throws(f, (e) => isHarnessError(e, 'invalid_request') && re.test((e as Error).message));
    refused(() => pc({ path: 'src/Missing.sol', find: 'x', replace: '' }), /not a file of the snapshot/);
    refused(() => pc({ path: 'test/Counter.t.sol', find: 'require(c.n() == 2, "violation not reached");', replace: '' }), /test or script/);
    refused(() => pc({ path: './src/Counter.sol', find: 'require(n < 1, "guard");', replace: '' }), /normalized/);
    refused(() => pc({ path: 'src/Counter.sol', find: 'require(n < 1, "guard");', replace: 'require(n < 1, "guard"); n += 5;' }), /only removes/);
    refused(() => pc({ path: 'src/Counter.sol', find: 'require(n < 1, "guard");', replace: '' }, { lineage: withFx.job, fixture }), /touched by the job's fixture/);
    // Removal-only replacements are accepted: blank, a comment, or a subsequence.
    pc({ path: 'src/Counter.sol', find: 'require(n < 1, "guard");', replace: '/* guard removed */' });
    assert.ok(isRemovalOnly('require(n < 1, "guard");', ''));
    assert.ok(isRemovalOnly('require(n < 1, "guard");', '// removed'));
    assert.ok(isRemovalOnly('require(a && b);', 'require(a);'));
    assert.ok(!isRemovalOnly('require(a);', 'require(b);'));
    assert.ok(!isRemovalOnly('x;', '/* a */ evil(); /* b */'));
    // An adequacy fault may replace freely, but on the target only.
    const campaign = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args: { ...args, match_test: 'testIncrements' } });
    h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'adequacy', adapter: 'forge_test', snapshot, investigation: inv, args: { ...args, match_test: 'testIncrements' }, lineage: campaign.job, guard_removal: { path: 'src/Counter.sol', find: 'n += 1;', replace: 'n += 2;' } });
    // Intake jobs never carry a fixture or an edit.
    const intake = stageAuthorization(h, eid, { kind: 'intake' });
    refused(() => h.auditor.do(eid, 'request_job', { authorization: intake, purpose: 'build', adapter: 'forge_build', snapshot, fixture }), /no fixture/);
    refused(() => h.auditor.do(eid, 'request_job', { authorization: intake, purpose: 'build', adapter: 'forge_build', snapshot, guard_removal: { path: 'src/Counter.sol', find: 'n += 1;', replace: '' } }), /guard removal|no fixture/);
    // Edits apply literally: no `$&` expansion.
    const work = mkdtempSync(join(h.dir, 'work-'));
    writeFileSync(join(work, 'A.sol'), 'a GUARD b');
    applySourceEdit(work, { path: 'A.sol', find: 'GUARD', replace: "$& $' $`" });
    assert.equal(readFileSync(join(work, 'A.sol'), 'utf8'), "a $& $' $` b");
  } finally {
    h.cleanup();
  }
});

test('H1: the runner re-validates a source edit before applying it (defense in depth)', async () => {
  const S = setup();
  const { h, eid, snapshot, inv, batch } = S;
  try {
    const args = { match_test: 'testDoubleIncrementViolation', expect: [{ test: 'testDoubleIncrementViolation', expect: 'violation' }] };
    const orig = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'experiment', adapter: 'forge_test', snapshot, investigation: inv, args });
    const pc = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'positive_control', adapter: 'forge_test', snapshot, investigation: inv, args, lineage: orig.job, guard_removal: { path: 'src/Counter.sol', find: 'require(n < 1, "guard");', replace: '' } });
    // A record altered behind request_job's back (e.g. restored from a tampered backup) is still refused.
    const head = h.ws.store(eid, true).mustHead(pc.job.record_id, 'job');
    commit(h, eid, [{ type: 'job', record_id: head.record_id, base_revision: head.revision, body: { ...head.body, guard_removal: { path: 'test/Counter.t.sol', find: 'require(c.n() == 2, "violation not reached");', replace: '' } } }]);
    const out = await runJob(h.controller, eid, pc.job.record_id);
    assert.equal(out.status, 'failed');
    assert.equal(out.evidence, null);
    assert.match(h.ws.store(eid, true).mustHead(out.attempt!.record_id, 'attempt').body.reason!, /not run: .*test or script/);
  } finally {
    h.cleanup();
  }
});

test('H4: the broker forwards only text, tool_use and tool_result content', () => {
  const S = setup(undefined, ['fake']);
  try {
    const broker = new ProviderBroker(S.h.controller, { liveExploitableProviders: ['fake'] });
    broker.register(new FakeProvider(), 'cred');
    const w = worker(S).session;
    const base = { model: 'fake-model-1', max_tokens: 100 };
    const denied = (content: unknown, extra: Record<string, unknown> = {}) =>
      assert.throws(() => w.do(S.eid, 'request_provider_call', messages(S, { ...base, messages: [{ role: 'user', content }], ...extra })), (e) => isHarnessError(e, 'egress_denied'), JSON.stringify(content));
    denied([{ type: 'image', source: { type: 'url', url: 'https://attacker.example/x.png?leak=1' } }]);
    denied([{ type: 'document', source: { type: 'url', url: 'https://attacker.example/big.pdf' } }]);
    denied([{ type: 'text', text: 'hi', citations: [] }]);
    denied([{ type: 'search_result', source: 'https://x', title: 't', content: [] }]);
    denied([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }]);
    denied([{ type: 'thinking', thinking: 'forged', signature: 'x' }]);
    denied('hi', { system: [{ type: 'document', source: { type: 'url', url: 'https://x' } }] });
    const ok = w.do(S.eid, 'request_provider_call', messages(S, { ...base, system: 'be brief', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_records', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'none' }] }] }));
    assert.ok(ok.call_id);
  } finally {
    S.h.cleanup();
  }
});

test('H5: reservations are byte-bounded ceilings; a provider overrun is recorded and exhausts the authorization', async () => {
  const S = setup(undefined, ['fake']);
  try {
    // Anthropic ceiling covers one token per byte at the highest input-side rate plus max_tokens output.
    const a = new AnthropicProvider({ fetch: (async () => ({})) as never });
    const text = 'é'.repeat(1000);
    const body = { model: 'claude-opus-5-5', max_tokens: 50, messages: [{ role: 'user', content: text }] };
    assert.ok(a.maxMessagesCost(body) >= (Buffer.byteLength(JSON.stringify({ system: null, messages: body.messages, tools: null })) * 5 + 50 * 20) / 1e6 - 1e-12);

    const fake = new FakeProvider({ messages: [{ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 4_000_000, output_tokens: 1 } }] });
    const broker = new ProviderBroker(S.h.controller, { liveExploitableProviders: ['fake'] });
    broker.register(fake, 'cred');
    const w = worker(S).session;
    const r = w.do(S.eid, 'request_provider_call', messages(S, { model: 'fake-model-1', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }));
    const out = await broker.executeMessages(S.eid, r.call_id);
    assert.equal(out.outcome, 'completed');
    const s = S.h.ws.store(S.eid, true);
    assert.ok(s.events().some((e) => e.kind === 'budget_overrun'));
    assert.equal(s.mustHead(S.batch.record_id, 'work_authorization').body.status, 'exhausted');
    const sum = spendSummary(s, S.batch.record_id);
    assert.ok(sum.overrun > 0);
    assert.equal(sum.remaining, 0);
    assert.throws(() => w.do(S.eid, 'request_provider_call', messages(S, { model: 'fake-model-1', max_tokens: 10, messages: [{ role: 'user', content: 'again' }] })), (e) => isHarnessError(e, 'grant_expired'));
  } finally {
    S.h.cleanup();
  }
});

test('M2: reservations an attempt never executed are released when it completes', () => {
  const S = setup(undefined, ['fake']);
  try {
    const broker = new ProviderBroker(S.h.controller, { liveExploitableProviders: ['fake'] });
    broker.register(new FakeProvider(), 'cred');
    const { session, attempt } = worker(S);
    const r = session.do(S.eid, 'request_provider_call', messages(S, { model: 'fake-model-1', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }));
    assert.ok(spendSummary(S.h.ws.store(S.eid, true), S.batch.record_id).estimated > 0);
    const done = S.h.runner.do(S.eid, 'complete_attempt', { attempt, not_run: 'test' });
    assert.deepEqual(done.released_calls, [r.call_id]);
    assert.equal(spendSummary(S.h.ws.store(S.eid, true), S.batch.record_id).estimated, 0);
    // The released call can no longer run.
    return assert.rejects(broker.executeMessages(S.eid, r.call_id), (e) => isHarnessError(e, 'idempotency_conflict'));
  } finally {
    S.h.cleanup();
  }
});

test('M1: an outbox entry whose placeholders expand past the bound is invalid', async () => {
  const S = setup(undefined, ['fake']);
  const { h, eid, snapshot, inv, batch } = S;
  try {
    new ProviderBroker(h.controller).register(new FakeProvider(), 'cred');
    const N = 3000;
    const fakeSandbox = {
      kind: 'fake',
      available: () => true,
      descriptor: () => 'fake',
      async run(req: { binds: { src: string; dest: string }[]; stdoutPath: string; stderrPath: string }) {
        const outbox = req.binds.find((b) => b.dest === '/outbox')!.src;
        writeFileSync(join(outbox, '001-read.json'), JSON.stringify({ operation: 'read_records', payload: { type: 'engagement' } }));
        writeFileSync(join(outbox, '002-big.json'), JSON.stringify({ operation: 'submit_proposal', payload: { many: Array.from({ length: N }, () => ({ $result: '001-read' })) } }));
        writeFileSync(req.stdoutPath, '');
        writeFileSync(req.stderrPath, '');
        const t = new Date().toISOString();
        return { started_at: t, ended_at: t, exit_code: 0, signal: null, timed_out: false, cancelled: false, stdout_bytes: 0, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false, termination: 'not_applicable', identity: null, limitations: [] };
      },
    };
    const job = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'agent', role: 'investigator', adapter: 'stub_agent2', snapshot, investigation: inv, context_manifest: contextFor(h, eid, 'investigator', inv), args: { task: 't', model: 'fake-model-1' } });
    await runJob(h.controller, eid, job.job.record_id, { sandbox: fakeSandbox as never });
    const refused = h.ws.store(eid, true).events().filter((e) => e.kind === 'worker_request_refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].result.file, '002-big.json');
    assert.match(String(refused[0].result.reason), /expanded payload over limit/);
  } finally {
    h.cleanup();
  }
});

test('M3: a manifest with an open investigation is live-exploitable; source views alone are source', () => {
  const S = setup();
  try {
    const store = () => S.h.ws.store(S.eid, true);
    const inv = contextFor(S.h, S.eid, 'investigator', S.inv, { source_paths: ['src/Counter.sol'] });
    assert.equal(manifestDataClass(store(), 'unfixed', inv, loadContextManifest(store(), inv)), 'unfixed');
    const plain = contextFor(S.h, S.eid, 'planner', null, { source_paths: ['src/Counter.sol'] });
    const view = loadContextManifest(store(), plain);
    assert.ok(view.records.every((r) => r.type === 'target_snapshot' || r.type === 'system_statement') , JSON.stringify(view.records.map((r) => r.type)));
    assert.equal(manifestDataClass(store(), 'unfixed', plain, view), 'source');
  } finally {
    S.h.cleanup();
  }
});

const run = (results: Record<string, unknown>, args: Record<string, unknown>, extra: Partial<Parameters<typeof interpretForgeTest>[0]> = {}, trailing = '') =>
  interpretForgeTest({
    exit_code: 1,
    signal: null,
    timed_out: false,
    cancelled: false,
    stdout: JSON.stringify({ 'test/P.t.sol:P': { test_results: results } }) + '\n' + trailing,
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
    args,
    mode: 'test',
    ...extra,
  }).result;
const E = (test: string, expect = 'no_violation') => ({ expect: [{ test, expect }] });
const ok = (kind: unknown) => ({ status: 'Success', reason: null, counterexample: null, kind });

test('M5/M7: campaigns that did not run, undeclared failures and never-succeeding handlers are inconclusive', () => {
  assert.equal(run({ 'invariant_a()': ok({ Invariant: { runs: 0, calls: 0, reverts: 0 } }) }, E('invariant_a')).result_type, 'inconclusive');
  assert.equal(run({ 'testFuzz_b(uint256)': ok({ Fuzz: { runs: 0 } }) }, E('testFuzz_b')).result_type, 'inconclusive');
  assert.equal(run({ 'testFuzz_v(uint256)': ok({ Fuzz: { runs: 0 } }) }, E('testFuzz_v', 'violation')).result_type, 'inconclusive');
  assert.equal(run({ 'invariant_g()': ok({ Invariant: { runs: 256, calls: 0, reverts: 0, metrics: {} } }) }, E('invariant_g')).result_type, 'inconclusive');
  const noFuzz = run({ 'invariant_c()': { status: 'Failure', reason: 'failed to set up invariant testing environment: No contracts to fuzz.', counterexample: null, kind: { Invariant: { runs: 0, calls: 0, reverts: 0 } } } }, E('invariant_c'));
  assert.equal(noFuzz.result_type, 'inconclusive');
  const undeclared = run({ 'test_ok()': ok({ Unit: { gas: 1 } }), 'invariant_broken()': { status: 'Failure', reason: 'broken', counterexample: { Sequence: [] }, kind: { Invariant: { runs: 1, calls: 5, reverts: 0 } } } }, E('test_ok'));
  assert.equal(undeclared.result_type, 'inconclusive');
  const stuck = run(
    { 'invariant_c()': ok({ Invariant: { runs: 10, calls: 1000, reverts: 999, metrics: { 'test/H.sol:H.deposit': { calls: 500, reverts: 500 }, 'test/H.sol:H.withdraw': { calls: 499, reverts: 499 }, 'test/H.sol:H.noop': { calls: 1, reverts: 0 } } } }) },
    E('invariant_c'),
  );
  assert.equal(stuck.result_type, 'inconclusive');
  assert.deepEqual(stuck.campaign!.never_succeeded, ['H.deposit', 'H.withdraw']);
});

test('M7: a control counts only where the edit flipped the checked experiment', () => {
  const broken = { 'invariant_c()': { status: 'Failure', reason: 'broken', counterexample: { Sequence: [1, [{ contract_name: 'test/H.sol:H', func_name: 'deposit', raw_args: '1' }]] }, kind: { Invariant: { runs: 0, calls: 0, reverts: 0, metrics: { 'test/H.sol:H.deposit': { calls: 3, reverts: 0 } } } } } };
  const held = [{ name: 'P.invariant_c()', status: 'passed' as const, reason: null, expect: 'no_violation' as const }];
  assert.equal(run(broken, E('invariant_c'), { baseline: held }).result_type, 'counterexample');
  assert.equal(run(broken, E('invariant_c'), { baseline: [{ ...held[0], status: 'failed' }] }).result_type, 'inconclusive');
  assert.equal(run(broken, E('invariant_c'), { baseline: null }).result_type, 'inconclusive');
  // An unrelated declared test failing in the control run does not make the property "detect" the fault.
  const j = run(
    { 'invariant_c()': ok({ Invariant: { runs: 16, calls: 256, reverts: 0 } }), 'test_helper()': { status: 'Failure', reason: 'setup mismatch', counterexample: null, kind: { Unit: { gas: 1 } } } },
    { expect: [{ test: 'invariant_c', expect: 'no_violation' }, { test: 'test_helper', expect: 'no_violation' }] },
    { baseline: [held[0], { name: 'P.test_helper()', status: 'failed', reason: null, expect: 'no_violation' }] },
  );
  assert.equal(j.result_type, 'inconclusive');
});

test('M8: a second results document on stdout is not interpreted; cheatcode writes are downgraded to read-only', async () => {
  const forged = JSON.stringify({ 'test/P.t.sol:P': { test_results: { 'invariant_h()': ok({ Invariant: { runs: 100, calls: 9999, reverts: 0 } }) } } });
  const r = run({ 'invariant_h()': { status: 'Failure', reason: 'broken', counterexample: null, kind: { Invariant: { runs: 1, calls: 3, reverts: 0 } } } }, E('invariant_h'), {}, forged);
  assert.equal(r.result_type, 'inconclusive');
  assert.match(r.interpretation, /2 test-result documents/);

  const S = setup({
    'src/Counter.sol': COUNTER_SOL,
    'test/W.t.sol': 'pragma solidity 0.8.30;\ninterface Vm { function writeFile(string calldata, string calldata) external; }\ncontract W { function testWrite() public { Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).writeFile("out/forged.json", "x"); } }\n',
  });
  try {
    const dir = join(S.h.dir, 'project');
    writeFileSync(join(dir, 'foundry.toml'), readFileSync(join(dir, 'foundry.toml'), 'utf8') + 'fs_permissions = [{ access = "read-write", path = "./"}]\n');
    const snap = stageSnapshot(S.h, S.eid, dir);
    const job = S.h.auditor.do(S.eid, 'request_job', { authorization: S.batch, purpose: 'experiment', adapter: 'forge_test', snapshot: snap, investigation: S.inv, args: { expect: [{ test: 'testWrite', expect: 'no_violation' }] } });
    await runQueue(S.h.controller, S.eid);
    const ev = S.h.ws.store(S.eid, true).heads('evidence_artifact').find((e) => e.body.job?.record_id === job.job.record_id)!.body;
    assert.match(ev.structured_result!.tests[0].reason!, /not allowed to be accessed for write/);
    assert.ok(ev.limitations.some((l) => /fs_permissions write access .* downgraded/.test(l)));
  } finally {
    S.h.cleanup();
  }
});

test('a fixture that does not build returns the diagnostics, bounded, so the next round can repair it', () => {
  const interpret = (stderr: string) =>
    interpretForgeTest({ exit_code: 1, signal: null, timed_out: false, cancelled: false, stdout: '', stderr, stdout_truncated: false, stderr_truncated: false, args: E('test_p', 'violation'), mode: 'test' });
  const stderr = `Compiling 3 files with Solc 0.8.30\nError: Compiler run failed:\nError (7576): Undeclared identifier.\n  --> test/poc/P.t.sol:12:9:\n   |\n12 |         foo();\n   |         ^^^\n${'x'.repeat(6000)}`;
  const r = interpret(stderr);
  assert.equal(r.failed, 'compilation failed');
  assert.equal(r.result.result_type, 'error');
  assert.match(r.result.interpretation, /Error \(7576\): Undeclared identifier\.\n {2}--> test\/poc\/P\.t\.sol:12:9:/);
  assert.doesNotMatch(r.result.interpretation, /Compiling 3 files/);
  assert.match(r.result.interpretation, /\[truncated\]$/);
  assert.ok(r.result.interpretation.length < 4300);
  // forge refuses before compiling when one file needs two pinned compiler versions.
  const versions = interpret('Warning: Found unknown `legacy` config for profile `default` defined in foundry.toml.\nError: Found incompatible versions:\ntest/poc/P.t.sol =0.8.24 imports:\n    contracts/tokens/StableTokenV2.sol =0.8.18\n');
  assert.equal(versions.result.result_type, 'error');
  assert.match(versions.result.interpretation, /Compiler output: Error: Found incompatible versions:\ntest\/poc\/P\.t\.sol =0\.8\.24 imports:\n {4}contracts\/tokens\/StableTokenV2\.sol =0\.8\.18$/);
});

test('L6: the agent host binds only the node binary', () => {
  const S = setup();
  try {
    const plan = referenceAgentAdapter({ name: 'x', agentDir: fileURLToPath(new URL('./fixtures/agent-stub/', import.meta.url)), registered_by: 'operator' }).plan({ task: 't', model: 'm' }, { role: 'investigator' });
    const nodeBind = plan.binds.find((b) => b.dest.startsWith('/opt/tools/node'))!;
    assert.equal(nodeBind.src, realpathSync(process.execPath));
    assert.equal(plan.argv[0], nodeBind.dest);
  } finally {
    S.h.cleanup();
  }
});
