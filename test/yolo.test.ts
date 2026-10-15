// The yolo loop (operator request 2026-10-14): an agentic, unattended discovery -> test -> report run. Role agents
// run in the sandbox through the provider broker (a scripted provider here); the governor sequences them, authorizes
// each cycle's work only through the unattended approver, and leaves every disposition to the auditor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, newEngagement, type Harness } from './helpers.ts';
import { acceptPolicy, decide, head, LIMITS, policy, stageSnapshot, variantWithOutcome, display } from './decision-fixtures.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { UNATTENDED_PRINCIPAL, YOLO_GOVERNOR_PRINCIPAL } from '../src/core/values.ts';
import { FakeProvider, ProviderBroker } from '../src/runner/index.ts';
import { engagementStatus } from '../src/review/overview.ts';
import { resolvePolicyPath, runYolo } from '../src/yolo/governor.ts';
import type { Ref } from '../src/core/refs.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const POC = readFileSync(join(FIXTURES, 'vault-yolo', 'test', 'CallbackDepositPoC.t.sol'), 'utf8');
const NOW = '2026-10-14T20:00:00.000Z';

const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const done = (text: string) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const code = (c: string) => (e: unknown) => isHarnessError(e, c as never);

function charter(overrides: Record<string, unknown> = {}) {
  return {
    duration_seconds: 3600,
    max_cycles: 1,
    max_consecutive_failures: 2,
    live_providers: ['fake'],
    agents: { models: { comprehension: 'fake-model-1', planner: 'fake-model-1', investigator: 'fake-model-1', challenger: 'fake-model-1' }, max_turns: 4, max_tokens: 4096, round_runtime_seconds: 120, call_timeout_seconds: 30, notes: [] as string[], reference_paths: [] as string[] },
    discovery: {
      seed_rounds: 1,
      rounds_per_cycle: 0,
      focus: [] as string[],
      capabilities: { tools: ['forge_build', 'forge_test', 'reference_agent'], providers: ['fake'], network: 'denied' },
      limits: { ...LIMITS, spend: 20, runtime_seconds: 1800, rounds: 2 },
    },
    batch: {
      investigations: 1,
      investigator_rounds: 1,
      capabilities: { tools: ['forge_test', 'reference_agent'], providers: ['fake'], network: 'denied' },
      limits: { ...LIMITS, spend: 20, runtime_seconds: 1800, rounds: 3 },
    },
    flow_reviews: 'unattended',
    ...overrides,
  };
}

function broker(h: Harness, messages: NonNullable<ConstructorParameters<typeof FakeProvider>[0]>['messages'] = []): FakeProvider {
  const fake = new FakeProvider({ name: 'fake', models: ['fake-model-1'], pricePerToken: 0.00001, messages });
  new ProviderBroker(h.controller, { timeoutMs: 30_000, liveExploitableProviders: ['fake'] }).register(fake, 'broker-held-credential');
  return fake;
}

test('a yolo run discovers, tests and reports a candidate finding with no human decision', { timeout: 300_000 }, async () => {
  const h = makeHarness();
  try {
    const eid = 'yolo';
    const store = () => h.ws.store(eid, true);
    const target = join(h.dir, 'target');
    cpSync(join(FIXTURES, 'vault'), target, { recursive: true });
    h.auditor.do(eid, 'create_engagement', { name: 'Unattended vault run', owner: 'auditor', audit_purpose: 'yolo loop' });
    acceptPolicy(h, eid);
    h.auditor.do(eid, 'register_snapshot', { path: target, label: 'v1' });

    // The scripted provider: each step is the model's next response, in the order the governor runs the rounds.
    const fake = broker(h, [
      // Cycle 1, discovery: a comprehension seeding round maps the flow.
      { content: [tool('c1', 'propose_audit_unit', { kind: 'flow', name: 'deposits and withdrawals', functions: ['Vault.deposit', 'Vault.withdraw'], risk_rationale: 'holds and pays out ether' })], stop_reason: 'tool_use' },
      done('Mapped the deposit and withdrawal flow.'),
      // The planner proposes one question and prepares the batch.
      {
        content: [
          tool('p1', 'propose_investigation', {
            method: 'scenario',
            question: 'Is a deposit made from the withdrawal payout callback erased?',
            audit_units: [{ record_id: 'unit-0001', revision: 1 }],
            guarantees: ['every deposit is credited to its depositor'],
            potential_impact: 'medium',
            executable: true,
          }),
          tool('p2', 'prepare_batch', { investigations: ['001-propose_investigation'] }),
        ],
        stop_reason: 'tool_use',
      },
      done('Proposed one batch.'),
      // Test: the investigator writes the PoC and requests the experiment.
      {
        content: [
          tool('i1', 'propose_variant', {
            causal_sequence: ['deposit 1 ether', 'withdraw', 'deposit 1 ether from receive()', 'withdraw clears the balance'],
            setup_powers: ['the test funds the depositor contract with 2 ether'],
            expected_violation: 'the vault holds 1 ether credited to no one',
            defeating_condition: 'withdraw clears the balance before paying out',
          }),
          tool('i2', 'submit_fixture', { files: { 'test/CallbackDepositPoC.t.sol': POC } }),
          tool('i3', 'request_experiment', { fixture: '002-submit_fixture', variant: '001-propose_variant', match_test: 'test_callback_deposit_is_erased', expect: [{ test: 'test_callback_deposit_is_erased', expect: 'violation' }], runtime_seconds: 120 }),
        ],
        stop_reason: 'tool_use',
      },
      done('Queued the PoC.'),
      // The challenger's independent position, after the clean replay.
      { content: [tool('x1', 'submit_challenger_position', { text: 'Reachable by any depositor contract; the setup only funds it; no privileged power is used.' })], stop_reason: 'tool_use' },
      done('Challenge recorded.'),
      // The packet round: the outcome (the variant was revised by its experiment and replay links), a fresh position, the packet.
      {
        content: [
          tool('k1', 'record_variant_outcome', { variant: { record_id: 'var-0001', revision: 3 }, outcome: 'supports' }),
          tool('k2', 'submit_author_position', { text: 'withdraw() zeroes the balance after the external call, erasing a deposit made in the callback; the replay reproduces it.' }),
          tool('k3', 'submit_review_packet', {
            claim: 'A deposit made from the payout callback is held by the vault but credited to no one',
            proposed_disposition: 'accepted',
            rationale: 'The PoC and its clean replay show the vault holding 1 ether that no balance accounts for.',
            author_position: '002-submit_author_position',
            challenger_position: { record_id: 'pos-0001', revision: 1 },
          }),
        ],
        stop_reason: 'tool_use',
      },
      done('Packet submitted.'),
    ]);
    h.ws.setUnattended(eid, ['authorize_work', 'record_flow_review'], NOW);

    const log: string[] = [];
    const c = charter();
    c.discovery.focus = ['deposits made from payout callbacks'];
    c.agents.notes = ['the vault holds ether only'];
    c.agents.reference_paths = ['test/'];
    const r = await runYolo(h.controller, eid, c, { progress: (l) => log.push(l) });
    assert.equal(r.status, 'completed', log.join('\n'));
    assert.equal(r.exit_reason, 'max_cycles');
    assert.equal(r.cycles, 1);
    assert.equal(r.packets, 1);
    assert.equal(r.candidate_findings, 1);
    assert.equal(fake.messageRequests.length, 10, 'comprehension, planner, investigator, challenger and packet rounds, two turns each');

    // The governor built the snapshot, and requested every round and the replay as itself.
    const s = store();
    const snapId = s.heads('engagement')[0].body.active_snapshot!.record_id;
    assert.ok(s.mustHead(snapId, 'target_snapshot').body.inventory, 'the governor built the snapshot');
    const requester = (purpose: string) => s.heads('job').filter((j) => j.body.purpose === purpose).map((j) => s.history(j.record_id)[0].created_by.principal);
    assert.deepEqual([...new Set(requester('agent'))], [YOLO_GOVERNOR_PRINCIPAL]);
    assert.deepEqual(requester('replay'), [YOLO_GOVERNOR_PRINCIPAL]);
    assert.match(requester('experiment')[0], /^worker:investigator:/, 'the agent requested its experiment; the governor did not');
    // The charter's focus reaches discovery rounds only; its notes reach every round.
    const tasks = s.heads('job').filter((j) => j.body.purpose === 'agent').map((j) => ({ role: j.body.role, task: String(j.body.args.task) }));
    assert.ok(tasks.length >= 4 && tasks.every((t) => t.task.includes('- the vault holds ether only')));
    assert.deepEqual(tasks.filter((t) => t.task.includes('- deposits made from payout callbacks')).map((t) => t.role).sort(), ['comprehension', 'planner']);
    // Every context carries the policy scope and then the charter's reference paths.
    for (const j of s.heads('job').filter((x) => x.body.purpose === 'agent')) {
      const manifest = s.archive.getJson<{ sources: { path: string }[] }>(j.body.context_manifest!.artifact);
      assert.deepEqual(manifest.sources.map((x) => x.path).filter((p) => p.endsWith('.sol')).slice(0, 2), ['src/Vault.sol', 'test/Vault.t.sol']);
    }

    // Every decision the run needed came from the unattended approver; nothing was disposed.
    const decisions = s.heads('human_decision');
    assert.deepEqual(
      decisions.filter((d) => d.body.actor === UNATTENDED_PRINCIPAL).map((d) => d.body.kind).sort(),
      ['authorize_work', 'authorize_work', 'record_flow_review'],
    );
    assert.ok(decisions.every((d) => d.body.kind !== 'dispose_investigation'));
    assert.equal(s.heads('finding').length, 0, 'a candidate finding is not a finding');
    const unit = s.mustHead('unit-0001', 'audit_unit');
    assert.equal(unit.body.review_status, 'reviewed');
    assert.ok(unit.body.functions.every((f) => !f.reviewed), 'an unattended flow review marks no function reviewed');

    // The packet waits for the auditor, with a clean replay of the violation.
    const run = s.mustHead(r.run.record_id, 'yolo_run');
    const inv = s.mustHead(run.body.cycles[0].admitted[0].record_id, 'investigation');
    assert.equal(inv.body.work_state, 'ready_for_review');
    assert.equal(inv.body.disposition, null);
    const pkt = s.heads('review_packet').find((p) => p.body.investigation.record_id === inv.record_id)!;
    assert.equal(pkt.body.proposed_disposition?.value, 'accepted');
    assert.equal(pkt.body.proposed_disposition?.authorship, 'agent_drafted_unedited');
    assert.equal(pkt.body.evidence_quality.replay, 'succeeded');
    assert.ok(pkt.body.challenger_position && pkt.body.author_position);
    assert.equal(s.heads('job').filter((j) => j.body.status === 'queued').length, 0, 'nothing the run queued outlives it');

    // The run record and its controller-rendered report.
    assert.equal(run.body.status, 'completed');
    assert.ok(run.body.discovery_authorization);
    assert.equal(run.body.cycles[0].flow_reviews.length, 1);
    const report = s.archive.getText(run.body.report!.artifact);
    assert.match(report, /No human reviewed what this run produced/);
    assert.match(report, /## Candidate findings \(1\)/);
    assert.ok(report.includes(pkt.record_id));
    assert.match(report, /record_flow_review: unit-0001/);
    assert.match(report, /replay succeeded/);

    // The home view (and so the agent session's overview) points at the run.
    const status = engagementStatus(h.ws, h.auditor, eid);
    assert.ok(status.work.some((w) => w.startsWith(`YOLO RUN ${r.run.record_id} completed (max_cycles): 1 cycle(s), 1 candidate finding(s)`)));
    assert.ok(status.decisions.some((d) => d.id === pkt.record_id && d.kind === 'dispose_investigation'));
  } finally {
    h.cleanup();
  }
});

test('the governor does not start without the operator opt-in or with a charter it would have to complete', async () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    acceptPolicy(h, eid);
    stageSnapshot(h, eid);
    broker(h);
    // No delegation: the governor would have no way to authorize work.
    await assert.rejects(runYolo(h.controller, eid, charter()), code('permission_denied'));
    // Unattended flow reviews must be delegated by name.
    h.ws.setUnattended(eid, ['authorize_work'], NOW);
    await assert.rejects(runYolo(h.controller, eid, charter()), (e) => isHarnessError(e, 'permission_denied') && /record_flow_review/.test(e.message));
    h.ws.setUnattended(eid, ['authorize_work', 'record_flow_review'], NOW);
    // Nothing is defaulted: a missing member, or round limits that cannot carry the charter's plan, are refused.
    const { max_consecutive_failures: _dropped, ...partial } = charter();
    await assert.rejects(runYolo(h.controller, eid, partial), (e) => isHarnessError(e, 'invalid_request') && /max_consecutive_failures: required/.test(e.message));
    const tight = charter();
    tight.batch.limits.rounds = 2;
    await assert.rejects(runYolo(h.controller, eid, tight), (e) => isHarnessError(e, 'invalid_request') && /batch\.limits\.rounds 2 cannot cover 3/.test(e.message));
    // A model no provider of its authorization offers.
    const elsewhere = charter();
    elsewhere.agents.models.challenger = 'other-model';
    await assert.rejects(runYolo(h.controller, eid, elsewhere), (e) => isHarnessError(e, 'invalid_request') && /challenger model other-model/.test(e.message));
    assert.equal(h.ws.store(eid, true).heads('yolo_run').length, 0, 'a refused start records nothing');
  } finally {
    h.cleanup();
  }
});

test('the governor reaches only its own operations, and only it records yolo runs', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    acceptPolicy(h, eid);
    const gov = h.controller.governor();
    assert.throws(() => gov.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'x' } }), code('permission_denied'));
    // Open to the controller channel, but not to the governor: pausing, resuming or exporting is the auditor's.
    for (const [op, payload] of [['pause', { reason: 'x' }], ['resume', { reason: 'x' }], ['export_bundle', { report_manifest: 'rpt-0001', destination: h.dir }]] as const) {
      assert.throws(() => gov.do(eid, op, payload), (e) => isHarnessError(e, 'permission_denied') && /the yolo governor may not call/.test(e.message));
    }
    assert.throws(() => gov.do(eid, 'authorize_work', {}), code('permission_denied'));
    assert.throws(() => h.system.do(eid, 'start_yolo_run', { charter: charter() }), code('permission_denied'));
    assert.equal(h.ws.store(eid, true).heads('yolo_run').length, 0);
  } finally {
    h.cleanup();
  }
});

test('discovery pauses at review capacity: the run admits no new work and ends', async () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    acceptPolicy(h, eid, policy({ capacity: { review_queue: 1, clarification_queue: 2, decisions_per_day: 20 } }));
    stageSnapshot(h, eid);
    // One packet already awaits the auditor (capacity 1).
    const flow = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal', functions: [{ name: 'Vault.withdraw', reviewed: false }] } }).audit_unit as Ref;
    decide(h, eid, 'record_flow_review', [flow], { audit_unit: flow, reviewed_functions: ['Vault.withdraw'] });
    const inv = h.auditor.do(eid, 'submit_proposal', {
      kind: 'investigation',
      body: { method: 'scenario', question: 'Can withdraw pay twice?', executable: true, audit_units: [head(h, eid, flow.record_id)], potential_impact: 'low' },
    }).investigation as Ref;
    const invHead = head(h, eid, inv.record_id);
    h.screen.do(eid, 'authorize_work', {
      reviewed: [invHead],
      display_receipt: display(h, eid, [invHead]),
      inputs: { kind: 'batch', investigations: [invHead], methods: ['scenario'], capabilities: { tools: ['forge_test'], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'admit',
      rationale_authorship: 'human_written',
    });
    variantWithOutcome(h, eid, inv.record_id, 'refuted');
    h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'single payout', decision_requested: 'disposition' });

    broker(h);
    h.ws.setUnattended(eid, ['authorize_work', 'record_flow_review'], NOW);
    const r = await runYolo(h.controller, eid, charter());
    assert.equal(r.status, 'completed');
    assert.equal(r.exit_reason, 'review_capacity_reached');
    const s = h.ws.store(eid, true);
    const run = s.mustHead(r.run.record_id, 'yolo_run');
    assert.equal(run.body.discovery_authorization, null, 'no authorization was recorded');
    assert.equal(s.heads('job').length, 0, 'no work was queued');
    assert.match(run.body.cycles[0].notes[0], /discovery paused: 1 packet\(s\) await review/);
  } finally {
    h.cleanup();
  }
});

test('one governor per engagement: a live run blocks a second; a run whose process ended is marked interrupted', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    acceptPolicy(h, eid);
    const gov = h.controller.governor();
    const first = gov.do(eid, 'start_yolo_run', { charter: charter() }).yolo_run as Ref;
    assert.throws(() => gov.do(eid, 'start_yolo_run', { charter: charter() }), (e) => isHarnessError(e, 'invalid_request') && /still running/.test(e.message));
    // The same record as left behind by a governor whose process died.
    const s = h.ws.store(eid, true);
    const cur = s.mustHead(first.record_id, 'yolo_run');
    s.commit({
      records: [{ type: 'yolo_run', record_id: cur.record_id, base_revision: cur.revision, body: { ...cur.body, process: { pid: cur.body.process.pid, start_time: 'not-this-process' } } }],
      events: [],
      principal: { channel: 'controller', principal: 'test-fixture' },
      origin: { operation: 'test_fixture', request_id: 'fixture', job: null, attempt: null, decision: null },
      now: new Date().toISOString(),
      message: 'fixture: a governor process that ended',
    });
    h.ws.noteCommitted(eid);
    const second = gov.do(eid, 'start_yolo_run', { charter: charter() });
    assert.deepEqual(second.interrupted.map((x: Ref) => x.record_id), [first.record_id]);
    const old = h.ws.store(eid, true).mustHead(first.record_id, 'yolo_run');
    assert.equal(old.body.status, 'interrupted');
    assert.match(old.body.exit_reason ?? '', /ended without closing the run/);
  } finally {
    h.cleanup();
  }
});

test('policy paths written from the repository root resolve against a snapshot registered from a subdirectory', () => {
  const origin = '/audits/shadow/sources/bold/contracts';
  const files = ['src/StabilityPool.sol', 'lib/forge-std/src/Test.sol', 'test/SP.t.sol', 'contracts/src/Odd.sol'];
  assert.equal(resolvePolicyPath('sources/bold/contracts/src', origin, files), 'src');
  assert.equal(resolvePolicyPath('sources/bold/contracts/lib', origin, files), 'lib');
  // A path that names snapshot files as written is kept, even where it also repeats the origin's end.
  assert.equal(resolvePolicyPath('contracts/src', origin, files), 'contracts/src');
  assert.equal(resolvePolicyPath('./src/', origin, files), 'src');
  // The origin directory itself is the whole snapshot; an unrelated path stays as written (and matches nothing).
  assert.equal(resolvePolicyPath('sources/bold/contracts', origin, files), '');
  assert.equal(resolvePolicyPath('packages/other/src', origin, files), 'packages/other/src');
});
