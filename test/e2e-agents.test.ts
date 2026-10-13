// Delivery step 2: role-specific agent assistance, end to end. The reference role-agent runtime
// (src/agents/runtime.ts) runs inside the bwrap sandbox for an `agent` job. It reaches the model only
// through the broker socket (a scripted provider here; the provider choice stays with the operator),
// and everything it writes arrives through the outbox under the attempt's grant: a comprehension
// seeding round (FR-29), an investigator round that chains a variant, a fixture, an experiment and its
// author position, and a challenger round. Agents propose; the auditor still decides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './helpers.ts';
import { acceptPolicy, display, head, LIMITS } from './decision-fixtures.ts';
import { FakeProvider, ProviderBroker, runQueue } from '../src/runner/index.ts';
import { roleProfile } from '../src/controller/roles.ts';
import { isHarnessError } from '../src/core/errors.ts';
import type { Ref } from '../src/core/refs.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const POC = readFileSync(join(FIXTURES, 'vault-poc', 'test', 'ReenterPoC.t.sol'), 'utf8');

const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

test('reference agents run in the sandbox, reach the model only through the broker, and only propose', { timeout: 300_000 }, async () => {
  const h = makeHarness();
  try {
    const eid = 'agents';
    const store = () => h.ws.store(eid, true);
    const target = join(h.dir, 'target');
    cpSync(join(FIXTURES, 'vault'), target, { recursive: true });
    h.auditor.do(eid, 'create_engagement', { name: 'Agent-assisted vault audit', owner: 'auditor', audit_purpose: 'agent assistance' });
    acceptPolicy(h, eid);
    const reg = h.auditor.do(eid, 'register_snapshot', { path: target, label: 'v1' });
    const eng = head(h, eid, 'eng-0001');
    const intake = h.screen.do(eid, 'authorize_work', {
      reviewed: [eng],
      display_receipt: display(h, eid, [eng]),
      inputs: { kind: 'intake', capabilities: { tools: ['forge_build', 'reference_agent'], providers: ['fake'], network: 'denied' }, limits: { ...LIMITS, rounds: 2 } },
      rationale: 'build and two seeding rounds',
      rationale_authorship: 'human_written',
    }).work_authorization as Ref;
    h.auditor.do(eid, 'request_job', { authorization: intake, ...reg.build_request, limits: { runtime_seconds: 120 } });
    await runQueue(h.controller, eid);
    const snap = () => store().headRef(reg.snapshot.record_id);

    // The scripted provider: each step is the model's next Messages response.
    const fake = new FakeProvider({
      name: 'fake',
      models: ['fake-model-1'],
      // The broker reserves a conservative ceiling per call (input bytes as tokens plus max output).
      pricePerToken: 0.00001,
      messages: [
        // Comprehension round.
        { content: [tool('c1', 'list_context', {}), tool('c2', 'read_source', { path: 'src/Vault.sol' })], stop_reason: 'tool_use' },
        {
          content: [
            tool('c3', 'propose_audit_unit', { kind: 'flow', name: 'withdrawal', functions: ['Vault.withdraw', 'Vault.deposit'], risk_rationale: 'pays ether out' }),
            tool('c4', 'propose_statement', { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'withdraw sends ether before clearing balanceOf, under a nonReentrant lock', anchors: [{ path: 'src/Vault.sol', symbol: 'Vault.withdraw' }], audit_units: ['001-propose_audit_unit'] }),
            tool('c5', 'propose_clarification', { issue: 'Should contracts be allowed to deposit and withdraw?', options: [{ option: 'yes', consequence: 'callbacks are in scope' }, { option: 'no', consequence: 'callbacks are out of scope' }], priority: 60 }),
          ],
          stop_reason: 'tool_use',
        },
        { content: [{ type: 'text', text: 'Seeded the withdrawal flow, one implementation statement and one question.' }], stop_reason: 'end_turn' },
        // Investigator round.
        {
          content: [
            tool('i1', 'propose_variant', { causal_sequence: ['deposit 1 ether', 'withdraw', 're-enter from receive()'], setup_powers: ['test funds the attacker with 1 ether', 'test deposits 5 ether as the victim'], expected_violation: 'attacker ends with at least 2 ether', defeating_condition: 'nonReentrant reverts the nested call' }),
            tool('i2', 'submit_fixture', { files: { 'test/ReenterPoC.t.sol': POC } }),
            tool('i3', 'request_experiment', { fixture: '002-submit_fixture', variant: '001-propose_variant', match_test: 'test_reentrant_double_payout', expect: 'violation', runtime_seconds: 120 }),
            tool('i4', 'submit_author_position', { text: 'The nested withdraw should hit the nonReentrant lock; the PoC tests whether it does.' }),
          ],
          stop_reason: 'tool_use',
        },
        { content: [{ type: 'text', text: 'Queued the callback variant and its PoC.' }], stop_reason: 'end_turn' },
        // Challenger round.
        { content: [tool('x1', 'submit_challenger_position', { text: 'Prerequisites hold for any EOA-funded contract; the setup only funds accounts; I found no privileged power.' })], stop_reason: 'tool_use' },
        { content: [{ type: 'text', text: 'Challenge recorded.' }], stop_reason: 'end_turn' },
      ],
    });
    // Investigator and challenger contexts carry open investigations: live-exploitable material, which
    // only providers the operator approved for that class may receive.
    const broker = new ProviderBroker(h.controller, { timeoutMs: 30_000, liveExploitableProviders: ['fake'] });
    broker.register(fake, 'broker-held-credential');

    const agentJob = (role: string, auth: Ref, task: string, investigation: Ref | null = null) => {
      const ctx = h.auditor.do(eid, 'build_context', { role: roleProfile(role).contextRole, investigation: investigation ? store().headRef(investigation.record_id) : null, source_paths: ['src/Vault.sol'] });
      return h.auditor.do(eid, 'request_job', { authorization: auth, purpose: 'agent', adapter: 'reference_agent', role, snapshot: snap(), investigation, context_manifest: ctx.context_manifest, args: { task, model: 'fake-model-1', max_turns: 4 }, limits: { runtime_seconds: 120 } });
    };

    // --- L0 seeding round (comprehension, under the intake authorization) ---
    agentJob('comprehension', intake, 'Seed the withdrawal flow: purpose, states and transitions, with anchors.');
    const r1 = await runQueue(h.controller, eid);
    assert.equal(r1.ran.at(-1)!.status, 'completed');
    const unit = store().heads('audit_unit').find((u) => u.body.name === 'withdrawal')!;
    assert.ok(unit, 'the agent\'s audit unit arrived through the outbox');
    assert.equal(unit.created_by.channel, 'worker');
    assert.equal(unit.body.review_status, 'not_started');
    const stmt = store().heads('system_statement').find((s) => s.body.origin === 'source_analysis')!;
    assert.equal(stmt.body.review_status, 'provisional', 'seeded knowledge stays provisional');
    assert.equal(stmt.body.audit_units[0].record_id, unit.record_id, 'the handle chained to the unit created earlier in the round');
    assert.ok(store().heads('clarification').some((c) => /contracts be allowed/.test(c.body.issue)));
    // The model saw the role prompt and tools; the sandbox never saw the provider credential.
    const first = fake.messageRequests[0];
    const firstBody = first.body as { system: string; tools: { name: string }[] };
    assert.match(firstBody.system, /intake and comprehension agent/);
    assert.ok(firstBody.tools.some((t) => t.name === 'propose_audit_unit'));
    assert.equal(first.credential, 'broker-held-credential');
    assert.ok(!JSON.stringify(fake.messageRequests.map((r) => r.body)).includes('broker-held-credential'), 'credentials never travel in request bodies');
    // Rounds are bounded by the intake authorization (rounds: 2).
    agentJob('comprehension', intake, 'Second round: refine the transitions.');
    assert.throws(() => agentJob('comprehension', intake, 'Third round'), (e) => isHarnessError(e, 'budget_exhausted'));
    h.auditor.do(eid, 'cancel', { job: store().heads('job').filter((j) => j.body.purpose === 'agent' && j.body.status === 'queued').at(-1)!.record_id, reason: 'not needed' });

    // --- The auditor reviews the flow and admits an investigation ---
    const unitRef = { record_id: unit.record_id, revision: unit.revision };
    h.screen.do(eid, 'record_decision', { decision_kind: 'record_flow_review', reviewed: [unitRef], display_receipt: display(h, eid, [unitRef], [], [unitRef]), inputs: { audit_unit: unitRef, reviewed_functions: ['Vault.withdraw', 'Vault.deposit'] }, rationale: 'walked it', rationale_authorship: 'human_written' });
    const inv = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'scenario', question: 'Can a reentrant callback during withdraw pay out twice?', audit_units: [head(h, eid, unit.record_id)], guarantees: ['withdraw pays at most the caller balance'], potential_impact: 'high' } }).investigation as Ref;
    const invHead = head(h, eid, inv.record_id);
    const batch = h.screen.do(eid, 'authorize_work', {
      reviewed: [invHead],
      display_receipt: display(h, eid, [invHead]),
      inputs: { kind: 'batch', investigations: [invHead], methods: ['scenario'], capabilities: { tools: ['forge_test', 'reference_agent'], providers: ['fake'], network: 'denied' }, limits: LIMITS },
      rationale: 'admit with agent assistance',
      rationale_authorship: 'human_written',
    }).work_authorization as Ref;

    // --- Investigator round: variant, fixture, experiment and author position, chained by handles ---
    agentJob('investigator', batch, 'Draft and test the callback scenario.', inv);
    const r2 = await runQueue(h.controller, eid);
    const ranPurposes = r2.ran.map((r) => store().mustHead(r.job, 'job').body.purpose);
    assert.deepEqual(ranPurposes, ['agent', 'experiment'], 'the experiment the agent requested ran after its round');
    const variant = store().heads('scenario_variant')[0];
    assert.equal(variant.body.classified_by.startsWith('worker:investigator:'), true);
    const exp = store().get(r2.ran[1].evidence!, 'evidence_artifact');
    assert.equal(exp.body.producer, 'trusted_runner', 'the agent asked; the trusted runner produced the receipt');
    assert.equal(exp.body.structured_result!.result_type, 'no_violation_observed');
    assert.equal(store().mustHead(exp.body.job!.record_id, 'job').body.variant?.record_id, variant.record_id);
    const authorPos = store().heads('position').find((p) => p.body.role === 'author')!;
    assert.equal(authorPos.body.submitted_by.worker_role, 'investigator');

    // --- Challenger round: an independent position, from a challenger worker ---
    agentJob('challenger', batch, 'Challenge the callback claim independently.', inv);
    await runQueue(h.controller, eid);
    const chPos = store().heads('position').find((p) => p.body.role === 'challenger')!;
    assert.equal(chPos.body.submitted_by.worker_role, 'challenger');
    const challengerRequest = fake.messageRequests.at(-2)!.body as { system: string; tools: { name: string }[] };
    assert.match(challengerRequest.system, /Role: challenger/);
    assert.ok(!challengerRequest.tools.some((t) => t.name === 'submit_author_position'));

    // The agents proposed; nothing is decided. The auditor records the outcome and decides as usual.
    assert.equal(store().heads('human_decision').filter((d) => d.created_by.channel !== 'screen').length, 0);
    assert.equal(store().mustHead(inv.record_id, 'investigation').body.disposition, null);
    h.auditor.do(eid, 'submit_proposal', { kind: 'scenario_variant', base: head(h, eid, variant.record_id), body: { outcome: 'refuted', countercondition: { text: 'nonReentrant', evidence: [{ record_id: exp.record_id, revision: exp.revision }] } } });
    // The investigator's position predates its own experiment result, so it is stale for the packet.
    assert.throws(
      () => h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd', challenger_position: { record_id: chPos.record_id, revision: chPos.revision }, author_position: { record_id: authorPos.record_id, revision: authorPos.revision } }),
      (e) => isHarnessError(e, 'stale_dependency'),
    );
    const pkt = h.auditor.do(eid, 'submit_review_packet', {
      investigation: head(h, eid, inv.record_id),
      claim: 'callback double payout',
      decision_requested: 'disposition',
      challenger_position: { record_id: chPos.record_id, revision: chPos.revision },
      author_position: 'Author (entered by the auditor after the run): the nested withdraw hit the lock; the PoC observed no excess payout.',
    }).packet as Ref;
    const indep = store().get(pkt, 'review_packet').body.challenge_independence;
    assert.match(indep.context, /worker:challenger/);
  } finally {
    h.cleanup();
  }
});
