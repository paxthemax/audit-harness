import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHarnessError } from '../src/core/errors.ts';
import { refKey, type Ref } from '../src/core/refs.ts';
import { AGENT_SESSION_PRINCIPAL } from '../src/core/values.ts';
import { requireEvidenceFirst } from '../src/decision/framework.ts';
import { AgentReviewSession } from '../src/review/session.ts';
import { engagementStatus } from '../src/review/overview.ts';
import { PACKET_SECTIONS } from '../src/screen/packet.ts';
import { makeHarness, newEngagement, type Harness } from './helpers.ts';
import { acceptPolicy, admittedInvestigation, head, LIMITS, policy, stageEvidence, stageSnapshot, variantWithOutcome } from './decision-fixtures.ts';
import { readyHighPacket } from './screen-fixtures.ts';

const code = (c: string) => (e: unknown) => isHarnessError(e, c as never);
const at = (r: Ref) => `${r.record_id}@${r.revision}`;

function withHarness(fn: (h: Harness) => Promise<void> | void) {
  return async () => {
    const h = makeHarness();
    try {
      await fn(h);
    } finally {
      h.cleanup();
    }
  };
}

function agent(h: Harness): AgentReviewSession {
  return new AgentReviewSession({ ws: h.ws, controller: h.controller, client: { name: 'test-host', version: '1.0' } });
}

/** A ready-for-review packet below High (combined layout). */
function readyMediumPacket(h: Harness, eid: string): { inv: Ref; packet: Ref } {
  const { inv } = admittedInvestigation(h, eid, { impact: 'medium' });
  variantWithOutcome(h, eid, inv.record_id, 'inconclusive');
  stageEvidence(h, eid, inv.record_id, 'experiment', 'inconclusive');
  const packet = h.auditor.do(eid, 'submit_review_packet', {
    investigation: head(h, eid, inv.record_id),
    claim: 'rounding favours the withdrawer',
    decision_requested: 'disposition of the rounding claim',
    challenger_position: 'Challenger: the rounding error is below one wei per call.',
    author_position: 'Author: repeated calls accumulate the error.',
    proposed_disposition: { value: 'deferred', rationale: 'AGENT-DRAFT: defer until the fee model is known.' },
  }).packet as Ref;
  return { inv: head(h, eid, inv.record_id), packet };
}

test(
  'an agent session decides a below-High packet in the combined layout, labelled agent-session with the reported authorship',
  withHarness((h) => {
    const eid = 'rv-medium';
    const fx = readyMediumPacket(h, eid);
    const s = agent(h);
    const pending = s.overview(eid).decisions.find((d) => d.decision_kind === 'dispose_investigation');
    assert.equal(pending?.id, fx.packet.record_id);
    assert.ok(s.engagements().some((e) => e.id === eid && e.decisions_needed > 0));

    const p = s.present(eid, fx.packet.record_id);
    assert.equal(p.kind, 'packet');
    assert.deepEqual(p.presented, [...PACKET_SECTIONS]);
    assert.deepEqual(p.remaining, []);
    assert.ok(p.text.includes('AGENT-DRAFT: defer until the fee model is known.'));
    assert.ok(p.template && 'deferred' in p.template);

    const draft = 'Deferred: the fee model decides whether the error accumulates.';
    // Fields the screen does not ask for, or misses one it does, are refused before anything is recorded.
    assert.throws(() => s.decide(eid, { id: fx.packet.record_id, decision: { disposition: 'deferred', residual_concern: 'x' }, rationale: draft, rationale_authorship: 'human_written' }), code('invalid_request'));
    assert.throws(
      () => s.decide(eid, { id: fx.packet.record_id, decision: { disposition: 'deferred', residual_concern: 'x', revisit_condition: 'y', severity: 'high' }, rationale: draft, rationale_authorship: 'human_written' }),
      code('invalid_request'),
    );
    assert.equal(h.ws.store(eid, true).heads('human_decision').filter((d) => d.body.kind === 'dispose_investigation').length, 0);

    const r = s.decide(eid, {
      id: fx.packet.record_id,
      decision: { disposition: 'deferred', residual_concern: 'error may accumulate across calls', revisit_condition: 'the fee model is documented' },
      rationale: draft,
      rationale_authorship: 'agent_drafted_unedited',
      agent_draft: draft,
    });
    const store = h.ws.store(eid, true);
    const dec = store.get(r.decision, 'human_decision');
    assert.equal(dec.body.actor, AGENT_SESSION_PRINCIPAL);
    assert.equal(dec.created_by.principal, AGENT_SESSION_PRINCIPAL);
    assert.equal(dec.created_by.channel, 'screen');
    assert.equal(dec.body.rationale_authorship, 'agent_drafted_unedited');
    assert.equal(store.mustHead(fx.inv.record_id, 'investigation').body.disposition?.value, 'deferred');
    const receipt = store.get(r.display_receipt, 'display_receipt');
    assert.match(receipt.body.screen.identity, /^harness-agent-session sha256:[0-9a-f]{64} test-host\/1\.0$/);
    assert.equal(receipt.body.screen.session, s.sessionId);
    assert.deepEqual(receipt.body.sections.map((x) => x.section), [...PACKET_SECTIONS]);
    assert.ok(!s.overview(eid).decisions.some((d) => d.id === fx.packet.record_id));
  }),
);

test(
  "a High packet's proposed disposition stays refused until evidence, challenger and evidence quality were presented; deciding needs every required section",
  withHarness((h) => {
    const eid = 'rv-high';
    const fx = readyHighPacket(h, eid);
    const s = agent(h);
    const rejectDecision = {
      disposition: 'rejected',
      decisive_evidence: [at(fx.guardEvidence)],
      countercondition: 'nonReentrant on withdraw',
      countercondition_scope: 'withdraw path at this snapshot',
      positive_control: at(fx.positiveControl),
    };
    const decide = () => s.decide(eid, { id: fx.packet.record_id, decision: rejectDecision, rationale: 'The guard blocks the nested call.', rationale_authorship: 'human_written' });

    assert.throws(() => decide(), code('display_required'), 'nothing presented yet');
    assert.throws(() => s.present(eid, fx.packet.record_id, { section: 'proposed_disposition' }), code('display_required'));
    for (const section of ['claim', 'evidence', 'challenger']) s.present(eid, fx.packet.record_id, { section });
    assert.throws(() => s.present(eid, fx.packet.record_id, { section: 'proposed_disposition' }), code('display_required'));
    const q = s.present(eid, fx.packet.record_id, { section: 'evidence_quality' });
    assert.ok(!q.text.includes(fx.draft));
    const pd = s.present(eid, fx.packet.record_id, { section: 'proposed_disposition' });
    assert.ok(pd.text.includes(fx.draft));
    assert.deepEqual(pd.remaining, ['unreviewed_statements']);
    assert.throws(() => decide(), code('display_required'), 'unreviewed statements not presented');
    s.present(eid, fx.packet.record_id, { section: 'unreviewed_statements' });

    const r = decide();
    const store = h.ws.store(eid, true);
    assert.equal(store.mustHead(fx.inv.record_id, 'investigation').body.disposition?.value, 'rejected');
    const dec = store.get(r.decision, 'human_decision');
    assert.equal(dec.body.actor, AGENT_SESSION_PRINCIPAL);
    assert.equal(dec.body.rationale_authorship, 'human_written');
    const receipt = store.get(r.display_receipt, 'display_receipt');
    requireEvidenceFirst(receipt);
    const order = receipt.body.sections.map((x) => x.section);
    for (const s2 of ['evidence', 'challenger', 'evidence_quality']) assert.ok(order.indexOf(s2) < order.indexOf('proposed_disposition'));
  }),
);

test(
  'a flow review through an agent session marks the listed functions and receipts IMPLEMENTED content when it is presented',
  withHarness((h) => {
    const eid = newEngagement(h, 'rv-flow');
    acceptPolicy(h, eid);
    stageSnapshot(h, eid);
    const unit = h.auditor.do(eid, 'submit_proposal', {
      kind: 'audit_unit',
      body: { kind: 'flow', name: 'withdrawal', functions: [{ name: 'Vault.withdraw' }, { name: 'Vault.deposit' }] },
    }).audit_unit as Ref;
    h.auditor.do(eid, 'submit_proposal', {
      kind: 'system_statement',
      body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'IMPL withdraw pays before updating the balance', audit_units: [unit] },
    });
    const s = agent(h);
    assert.throws(() => s.decide(eid, { id: unit.record_id, decision: { reviewed_functions: ['Vault.withdraw'] }, rationale: 'walked', rationale_authorship: 'human_written' }), code('display_required'));

    const p = s.present(eid, unit.record_id);
    assert.equal(p.kind, 'flow_review');
    assert.ok(p.text.includes('IMPL withdraw pays before updating the balance'));
    const receipted = h.ws.store(eid, true).heads('display_receipt').filter((d) => d.body.implemented_presented_for.some((u) => u.record_id === unit.record_id));
    assert.equal(receipted.length, 1, 'the presentation itself is receipted');

    assert.throws(() => s.decide(eid, { id: unit.record_id, decision: { reviewed_functions: ['Vault.nope'] }, rationale: 'walked', rationale_authorship: 'human_written' }), code('invalid_request'));
    const r = s.decide(eid, { id: unit.record_id, decision: { reviewed_functions: ['Vault.withdraw'], gaps: ['callback ordering not walked'] }, rationale: 'Walked withdraw with the auditor.', rationale_authorship: 'human_written' });
    const store = h.ws.store(eid, true);
    const after = store.mustHead(unit.record_id, 'audit_unit').body;
    assert.equal(after.review_status, 'reviewed');
    assert.deepEqual(after.functions, [
      { name: 'Vault.withdraw', reviewed: true },
      { name: 'Vault.deposit', reviewed: false },
    ]);
    assert.ok(after.gaps.includes('callback ordering not walked'));
    assert.equal(store.get(r.decision, 'human_decision').body.actor, AGENT_SESSION_PRINCIPAL);
  }),
);

test(
  'a work authorization through an agent session needs every limit and admits the kept investigations',
  withHarness((h) => {
    const eid = newEngagement(h, 'rv-work');
    acceptPolicy(h, eid);
    stageSnapshot(h, eid);
    const prop = h.auditor.do(eid, 'prepare_work', { kind: 'intake' }).work_proposal as Ref;
    const s = agent(h);
    const p = s.present(eid, prop.record_id);
    assert.equal(p.kind, 'work_authorization');
    const { spend: _omitted, ...partial } = LIMITS;
    assert.throws(() => s.decide(eid, { id: prop.record_id, decision: { limits: partial }, rationale: 'go', rationale_authorship: 'human_written' }), code('invalid_request'));
    assert.equal(h.ws.store(eid, true).heads('work_authorization').length, 0);
    const r = s.decide(eid, { id: prop.record_id, decision: { limits: LIMITS }, rationale: 'Intake within these limits.', rationale_authorship: 'human_written' });
    const store = h.ws.store(eid, true);
    const auth = store.heads('work_authorization')[0];
    assert.equal(auth.body.status, 'active');
    assert.deepEqual(auth.body.limits, LIMITS);
    assert.equal(store.get(r.decision, 'human_decision').body.actor, AGENT_SESSION_PRINCIPAL);
  }),
);

test(
  'a generic decision: a clarification answered with a relayed capture, bound only after both were presented; status lists the agent-session decision',
  withHarness((h) => {
    const eid = newEngagement(h, 'rv-clar');
    acceptPolicy(h, eid);
    const clar = h.auditor.do(eid, 'submit_proposal', {
      kind: 'clarification',
      body: { issue: 'Are fee-on-transfer tokens supported?', priority: 50, blocks: [], options: [{ option: 'no', consequence: 'accounting uses the sent amount' }] },
    }).clarification as Ref;
    const s = agent(h);
    const statusBefore = engagementStatus(h.ws, h.auditor, eid);
    const pending = s.overview(eid).decisions.find((d) => d.id === clar.record_id);
    assert.equal(pending?.decision_kind, 'answer_clarification');

    const cap = s.captureRelay(eid, { text: 'No, fee-on-transfer tokens are out of scope.', purpose: 'clarification_answer' });
    const capEnv = h.ws.store(eid, true).get(cap, 'captured_input');
    assert.equal(capEnv.created_by.channel, 'capture');
    assert.equal(capEnv.body.channel.name, 'agent-session-relay');

    const args = {
      kind: 'answer_clarification',
      records: [clar.record_id, at(cap)],
      decision: { clarification: clar, answer: 'no', captured_input: cap, as: 'intent' },
      rationale: 'The auditor stated it.',
      rationale_authorship: 'human_written' as const,
    };
    assert.throws(() => s.decide(eid, args), code('display_required'), 'the clarification was not presented');
    const p = s.present(eid, clar.record_id);
    assert.equal(p.kind, 'record');
    assert.equal(p.template?.kind, 'answer_clarification');
    // Item kinds go through their item, never the generic path.
    assert.throws(() => s.decide(eid, { ...args, kind: 'dispose_investigation' }), code('invalid_request'));

    const r = s.decide(eid, args);
    const store = h.ws.store(eid, true);
    assert.equal(store.mustHead(clar.record_id, 'clarification').body.status, 'answered');
    const dec = store.get(r.decision, 'human_decision');
    assert.equal(dec.body.actor, AGENT_SESSION_PRINCIPAL);
    assert.deepEqual(dec.body.reviewed.map(refKey).sort(), [refKey(clar), refKey(cap)].sort());

    // The home view lists decisions recorded through an agent session; it did not before.
    assert.ok(!statusBefore.work.some((l) => l.includes(r.decision.record_id)));
    const statusAfter = engagementStatus(h.ws, h.auditor, eid);
    const line = statusAfter.work.find((l) => l.includes(r.decision.record_id));
    assert.ok(line && line.includes('answer_clarification'));
    assert.deepEqual(statusAfter.work.filter((l) => l !== line), statusBefore.work);
    assert.ok(s.overview(eid).work.includes(line!));
  }),
);

test(
  'the unattended pair rule still refuses agent_unattended from an agent session; scope and policy is then accepted as the agent reports',
  withHarness((h) => {
    const eid = newEngagement(h, 'rv-scope');
    const s = agent(h);
    const p = s.present(eid, 'eng-0001');
    assert.equal(p.kind, 'scope_and_policy');
    assert.throws(
      () => s.decide(eid, { id: 'eng-0001', decision: { policy: policy() }, rationale: 'claims to be unattended', rationale_authorship: 'agent_unattended' as never }),
      code('permission_denied'),
    );
    assert.equal(h.ws.store(eid, true).heads('human_decision').length, 0);
    // A charter that leaves a default capability unanswered is refused, not defaulted.
    const narrowed = policy();
    narrowed.attacker_charter.capabilities = narrowed.attacker_charter.capabilities.slice(1);
    assert.throws(() => s.decide(eid, { id: 'eng-0001', decision: { policy: narrowed }, rationale: 'r', rationale_authorship: 'human_written' }), code('invalid_request'));

    const draft = 'Accept the drafted scope and policy.';
    const edited = 'Accept the drafted scope and policy; the budget is the client-approved one.';
    const r = s.decide(eid, { id: 'eng-0001', decision: { policy: policy() }, rationale: edited, rationale_authorship: 'agent_drafted_edited', agent_draft: draft });
    const store = h.ws.store(eid, true);
    const dec = store.get(r.decision, 'human_decision');
    assert.equal(dec.body.actor, AGENT_SESSION_PRINCIPAL);
    assert.equal(dec.body.rationale_authorship, 'agent_drafted_edited');
    assert.ok(dec.body.edit_diff);
    assert.deepEqual(store.heads('engagement')[0].body.policy, policy());
  }),
);

test(
  'non-decision operations go through the auditor channel; decision operations are refused there',
  withHarness((h) => {
    const eid = newEngagement(h, 'rv-call');
    const s = agent(h);
    assert.throws(() => s.call(eid, 'record_decision', {}), code('permission_denied'));
    const unit = s.call(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal' } });
    assert.ok(unit.commit);
    const { records } = s.records(eid, { type: 'audit_unit' });
    assert.equal(records.length, 1);
    assert.equal(records[0].created_by.channel, 'auditor');
  }),
);
