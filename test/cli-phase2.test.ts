import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureLines, main } from '../src/cli/main.ts';
import { ROLE_PROFILES } from '../src/controller/roles.ts';
import { makeHarness, type Harness } from './helpers.ts';
import { readyHighPacket } from './screen-fixtures.ts';
import { acceptPolicy, decide, display, head, LIMITS, stageSnapshot } from './decision-fixtures.ts';
import type { Ref } from '../src/core/refs.ts';

/** Run the CLI in-process against the harness workspace and capture its output. */
async function run(h: Harness, args: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { ...process.env, HARNESS_WORKSPACE: h.ws.root, HARNESS_ENGAGEMENT: '' }, { stdout: (s) => void (stdout += s), stderr: (s) => void (stderr += s) });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

/** Engagement with a reviewed flow and one investigation admitted under a batch that approves the fake provider. */
function agentScenario(h: Harness, eid: string): { inv: Ref } {
  h.auditor.do(eid, 'create_engagement', { name: 'Agents', owner: 'auditor', audit_purpose: 'test' });
  acceptPolicy(h, eid);
  stageSnapshot(h, eid);
  const flow = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal' } }).audit_unit;
  decide(h, eid, 'record_flow_review', [flow], { audit_unit: flow });
  const inv = h.auditor.do(eid, 'submit_proposal', {
    kind: 'investigation',
    body: { method: 'scenario', question: 'Can a callback pay out twice?', executable: true, audit_units: [head(h, eid, flow.record_id)], potential_impact: 'high' },
  }).investigation;
  const invHead = head(h, eid, inv.record_id);
  h.screen.do(eid, 'authorize_work', {
    reviewed: [invHead],
    display_receipt: display(h, eid, [invHead]),
    inputs: { kind: 'batch', investigations: [invHead], capabilities: { tools: ['forge_test', 'reference_agent'], providers: ['fake'], network: 'denied' }, limits: LIMITS },
    rationale: 'admit',
    rationale_authorship: 'human_written',
  });
  return { inv: head(h, eid, inv.record_id) };
}

function withHarness(fn: (h: Harness, dir: string) => Promise<void>) {
  return async () => {
    const h = makeHarness();
    const dir = mkdtempSync(join(h.dir, 'files-'));
    try {
      await fn(h, dir);
    } finally {
      h.cleanup();
    }
  };
}

test(
  'agent roles, agent run, positions, fixtures and batch status through the CLI',
  withHarness(async (h, dir) => {
    const eid = 'cli-agents';
    const fx = agentScenario(h, eid);
    let r = await run(h, ['agent', 'roles', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json().roles.map((x: { role: string }) => x.role), Object.keys(ROLE_PROFILES));
    r = await run(h, ['agent', 'roles']);
    assert.match(r.stdout, /challenger\n  receives: [\s\S]*may not decide: Majority-vote truth/);

    r = await run(h, ['agent', 'run', 'investigator', '-e', eid, '--task', 'Trace the callback path', '--model', 'fake-1', '--investigation', fx.inv.record_id, '--max-turns', '3', '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const job = h.ws.store(eid, true).heads('job').filter((j) => j.body.purpose === 'agent').pop()!;
    assert.equal(job.body.role, 'investigator');
    assert.equal(job.body.adapter.name, 'reference_agent');
    assert.deepEqual(job.body.args, { task: 'Trace the callback path', model: 'fake-1', max_turns: 3 });
    assert.equal(job.body.context_manifest?.artifact, r.json().context.context_manifest.artifact);
    assert.equal((await run(h, ['agent', 'run', 'tool', '-e', eid, '--task', 'x', '--model', 'm'])).code, 2);

    const pos = join(dir, 'challenger.md');
    writeFileSync(pos, 'The guard covers withdraw; the PoC pranks no privileged role.');
    r = await run(h, ['position', 'submit', '-e', eid, '--investigation', fx.inv.record_id, '--role', 'challenger', '--file', pos, '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const store = h.ws.store(eid, true);
    const p = store.heads('position').pop()!;
    assert.equal(p.body.role, 'challenger');
    assert.equal(store.archive.getText(p.body.content.artifact), 'The guard covers withdraw; the PoC pranks no privileged role.');

    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'test', 'Exploit.t.sol'), '// fixture test\n');
    r = await run(h, ['fixture', 'submit', '-e', eid, '--investigation', fx.inv.record_id, '--root', dir, join(dir, 'test')]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Fixture sha256:[0-9a-f]{64}: 1 file/);
    assert.match(r.stdout, /adds: test\/Exploit\.t\.sol/);
    assert.ok(!r.stdout.includes('WARNING'));
    // A file outside the project's test/script directories alters the compiled target: shown as an override warning.
    writeFileSync(join(dir, 'Helper.sol'), '// changes the build\n');
    r = await run(h, ['fixture', 'submit', '-e', eid, '--investigation', fx.inv.record_id, '--root', dir, join(dir, 'Helper.sol')]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^WARNING: this fixture OVERRIDES 1 target file[\s\S]*OVERRIDES TARGET: Helper\.sol/);

    r = await run(h, ['batch', 'status', '-e', eid, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json().batches.length, 1);
    assert.ok('discovery_paused' in r.json().review_queue);
    r = await run(h, ['batch', 'status', '-e', eid]);
    assert.match(r.stdout, /Batch auth-\d+@\d+ \(batch\) \w+: spend [\d.]+\/10/);
    assert.match(r.stdout, /Review queue: \d+ ready \/ capacity 3/);
    r = await run(h, ['status', '-e', eid]);
    assert.match(r.stdout, /Batch auth-\d+@\d+ \(batch\)/);
    assert.equal((await run(h, ['batch', 'reconcile', '-e', eid])).code, 0);
  }),
);

test(
  'evaluation, canaries and methods in the library scope; canary labels never reach engagement views',
  withHarness(async (h, dir) => {
    const eid = 'cli-eval';
    const fx = readyHighPacket(h, eid);
    const contract = join(dir, 'contract.json');
    writeFileSync(
      contract,
      JSON.stringify({
        name: 'pilot-1',
        targets: [{ engagement: eid, snapshot: null, units: ['withdraw flow'] }],
        method_versions: ['workflow@1'],
        models: [{ provider: 'fake', model: 'fake-1', settings: 'temperature 0' }],
        tools: ['forge'],
        labels: [{ case: 'vault-a', kind: 'seeded_fault', held_out: true, reference_defects: ['D1'] }],
        metric_version: 'evaluation/1',
        targets_set_before_run: [{ metric: 'decision_quality', target: 'catch 3 of 4 canaries' }],
      }),
    );
    let r = await run(h, ['eval', 'contract', 'propose', '--file', contract, '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.json().result.evaluation_contract.record_id, /^evalc-/);
    // Reporting needs a frozen contract (frozen only on the trusted screen).
    r = await run(h, ['eval', 'report', '--contract', 'evalc-0001']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /frozen evaluation contract/);
    assert.equal((await run(h, ['screen', 'freeze_evaluation_contract', 'evalc-0001'])).code, 3); // no TTY
    // Freezing is a trusted-screen decision; the test drives the screen channel directly.
    const c1 = { record_id: 'evalc-0001', revision: 1 };
    h.screen.do('library', 'freeze_evaluation_contract', {
      reviewed: [c1],
      display_receipt: display(h, 'library', [c1]),
      inputs: { contract: c1, compared_metrics: [] },
      rationale: 'frozen before any run',
      rationale_authorship: 'human_written',
    });
    r = await run(h, ['eval', 'report', '--contract', 'evalc-0001', '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);

    r = await run(h, ['eval', 'canary', 'register', '-e', eid, '--packet', fx.packet.record_id, '--kind', 'invalid_claim_plausible_narrative', '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    r = await run(h, ['eval', 'canary', 'score', '--json']);
    assert.equal(r.code, 0, r.stderr);
    for (const args of [['records', '-e', eid], ['records', '-e', eid, '--json'], ['status', '-e', eid], ['show', fx.packet.record_id, '-e', eid]]) {
      const out = (await run(h, args)).stdout;
      assert.ok(!/canary|invalid_claim_plausible_narrative|not_accepted/.test(out), `${args.join(' ')} leaked a canary label`);
    }

    const cases = join(dir, 'cases.json');
    writeFileSync(cases, JSON.stringify({ contract: { record_id: 'evalc-0001', revision: 2 }, cases: [{ case: 'vault-a', held_out: true, runs: [{ baseline: 'pass', candidate: 'pass' }, { baseline: 'pass', candidate: 'pass' }] }] }));
    r = await run(h, ['eval', 'held-out', '--file', cases, '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.deepEqual(r.json().result.evaluation.held_out.cases, ['vault-a']);
    const content = join(dir, 'prompt.md');
    writeFileSync(content, 'You are the investigator.');
    r = await run(h, ['method', 'propose', '--component', 'prompt', '--name', 'investigator', '--version', '2', '--description', 'tighter prompt', '--content', content, '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(h.ws.store('library', true).mustHead(r.json().result.method_version.record_id, 'method_version').body.status, 'proposed');
    assert.equal((await run(h, ['conformance', '-e', eid])).code, 2);
    r = await run(h, ['conformance', 'no-such-adapter', '-e', eid]);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /committed: no/);
  }),
);

test(
  'exploration start/resume, diagrams, compositions, function coverage and metrics through the CLI',
  withHarness(async (h, dir) => {
    const eid = 'cli-explore';
    h.auditor.do(eid, 'create_engagement', { name: 'Explore', owner: 'a', audit_purpose: 'p' });
    acceptPolicy(h, eid);
    stageSnapshot(h, eid);
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal' } }).audit_unit;
    const receipt = display(h, eid, [unit]);
    const auth = h.screen.do(eid, 'authorize_work', {
      reviewed: [unit],
      display_receipt: receipt,
      inputs: { kind: 'exploration', audit_units: [unit], capabilities: { tools: [], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'explore withdrawal',
      rationale_authorship: 'human_written',
    }).work_authorization;
    let r = await run(h, ['explore', 'start', '-e', eid, '--unit', unit.record_id, '--lens', 'flows', '--authorization', auth.record_id, '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const expl = r.json().result.exploration.record_id;
    const mmd = join(dir, 'flow.mmd');
    writeFileSync(mmd, 'stateDiagram-v2\n  Requested --> Paid');
    r = await run(h, ['diagram', 'propose', '-e', eid, '--unit', unit.record_id, '--lens', 'flows', '--affiliation', 'designed', '--source', mmd, '--json']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    r = await run(h, ['explore', 'resume', expl, '-e', eid]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /What changed since the last round[\s\S]*added: diag-\d+@1[\s\S]*Continuing: new round opened/);
    // Without a compiler inventory the derivation is refused, and the CLI says so.
    r = await run(h, ['compositions', 'derive', '-e', eid]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /error: unsupported[\s\S]*no inventory[\s\S]*committed: no/);
    for (const args of [['coverage', 'functions'], ['metrics']]) {
      r = await run(h, [...args, '-e', eid, '--json']);
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
      assert.equal(r.json().ok, true);
    }
  }),
);

test('fixture overrides of target files are shown first, as a warning', () => {
  const lines = fixtureLines({ fixture: { artifact: 'sha256:' + 'a'.repeat(64) }, overrides_target: ['src/Vault.sol'], added: ['test/Exploit.t.sol'] }, 2);
  assert.match(lines[0], /^WARNING: this fixture OVERRIDES 1 target file/);
  assert.equal(lines[1], '  OVERRIDES TARGET: src/Vault.sol');
  assert.ok(lines.includes('  adds: test/Exploit.t.sol'));
  assert.ok(!fixtureLines({ fixture: { artifact: 'x' }, overrides_target: [], added: [] }, 1).some((l) => l.startsWith('WARNING')));
});
