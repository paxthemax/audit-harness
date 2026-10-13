import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, type Harness } from './helpers.ts';
import { isHarnessError } from '../src/core/errors.ts';
import {
  acceptPolicy,
  admittedInvestigation,
  decide,
  display,
  head,
  LIMITS,
  policy,
  stageEvidence,
  stageSnapshot,
  variantWithOutcome,
} from './decision-fixtures.ts';
import type { Ref } from '../src/core/refs.ts';

function withHarness(fn: (h: Harness) => void) {
  return () => {
    const h = makeHarness();
    try {
      fn(h);
    } finally {
      h.cleanup();
    }
  };
}

const code = (c: string) => (e: unknown) => isHarnessError(e, c as never);

function submitPacket(h: Harness, eid: string, inv: Ref, proposed: { value: string; rationale: string } | null, extra: Record<string, unknown> = {}) {
  return h.auditor.do(eid, 'submit_review_packet', {
    investigation: head(h, eid, inv.record_id),
    claim: 'callback double payout',
    decision_requested: 'disposition',
    challenger_position: 'Challenger: the nonReentrant guard covers withdraw; the PoC setup pranks no privileged role.',
    author_position: 'Author: the nested call reverts at the guard.',
    proposed_disposition: proposed,
    ...extra,
  });
}

/** Decide a packet with an evidence-first display. */
function dispose(h: Harness, eid: string, packet: Ref, inv: Ref, inputs: Record<string, unknown>, sections = ['claim', 'evidence', 'challenger', 'evidence_quality', 'proposed_disposition']) {
  const invHead = head(h, eid, inv.record_id);
  return decide(h, eid, 'dispose_investigation', [packet, invHead], { packet, investigation: invHead, ...inputs }, sections);
}

test(
  'decisions need the trusted screen, a covering display receipt and current inputs',
  withHarness((h) => {
    const eid = 'e1';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    const eng = head(h, eid, 'eng-0001');
    // Auditor CLI channel cannot decide.
    assert.throws(() => h.auditor.do(eid, 'record_decision', {}), code('permission_denied'));
    // Receipt that does not render the reviewed revision.
    const other = display(h, eid, []);
    assert.throws(
      () => h.screen.do(eid, 'record_decision', { decision_kind: 'accept_scope_and_policy', reviewed: [eng], display_receipt: other, inputs: { policy: policy() }, rationale: 'r', rationale_authorship: 'human_written' }),
      code('display_required'),
    );
    // Missing mandatory policy fields.
    assert.throws(() => decide(h, eid, 'accept_scope_and_policy', [eng], { policy: { ...policy(), severity_rubric: undefined } }), code('invalid_request'));
    // Bulk requests are refused.
    assert.throws(() => decide(h, eid, 'accept_scope_and_policy', [eng], { policy: policy(), bulk: [1, 2] }), code('invalid_request'));
    const res = acceptPolicy(h, eid);
    assert.ok(res.trusted_role_premise);
    // The engagement changed: a decision citing the old revision is stale.
    assert.throws(() => decide(h, eid, 'accept_scope_and_policy', [eng], { policy: policy() }), code('stale_dependency'));
    const premise = h.ws.store(eid, true).mustHead(res.trusted_role_premise.record_id, 'system_statement');
    assert.equal(premise.body.origin, 'adopted_assumption');
    assert.equal(premise.body.review_status, 'reviewed');
  }),
);

test(
  'agent paraphrase cannot become an auditor clarification; interpretations are confirmed per item with derived intent timing',
  withHarness((h) => {
    const eid = 'e2';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    acceptPolicy(h, eid);
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'deposit' } }).audit_unit;
    // FR-39: a proposal cannot carry the auditor_clarification origin.
    assert.throws(
      () => h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', body: { kind: 'intent', affiliation: 'designed', origin: 'auditor_clarification', statement: 'fee tokens unsupported' } }),
      code('permission_denied'),
    );
    // Expectations pre-step: captured before any presentation of the unit's implemented behavior.
    const before = h.capture.do(eid, 'capture_input', { text: 'Deposits must never mint shares for zero assets.', purpose: 'expectations_pre_step', audit_unit: unit }).captured_input;
    display(h, eid, [unit], [], [unit]); // walkthrough presents IMPLEMENTED behavior
    const after = h.capture.do(eid, 'capture_input', { text: 'Fee-on-transfer tokens are unsupported.' }).captured_input;
    const i1 = h.auditor.do(eid, 'submit_proposal', { kind: 'interpretation', body: { captured_inputs: [before], proposed: { kind: 'intent', affiliation: 'designed', statement: 'deposit(0) mints no shares', audit_units: [unit] } } }).interpretation;
    const i2 = h.auditor.do(eid, 'submit_proposal', { kind: 'interpretation', body: { captured_inputs: [after], proposed: { kind: 'intent', affiliation: 'designed', statement: 'fee-on-transfer tokens unsupported', audit_units: [unit] } } }).interpretation;
    const i3 = h.auditor.do(eid, 'submit_proposal', { kind: 'interpretation', body: { captured_inputs: [after], proposed: { kind: 'assumption', affiliation: 'shared', statement: 'tokens are standard ERC-20', audit_units: [] } } }).interpretation;
    const res = decide(h, eid, 'confirm_interpretations', [i1, i2, i3], {
      items: [
        { interpretation: i1, choice: 'confirm' },
        { interpretation: i2, choice: 'edit', edited_statement: 'fee-on-transfer and rebasing tokens are unsupported' },
        { interpretation: i3, choice: 'reject' },
      ],
    });
    const store = h.ws.store(eid, true);
    const [r1, r2, r3] = res.items;
    assert.equal(r3.status, 'rejected');
    assert.equal(r3.statement, null);
    const s1 = store.get(r1.statement, 'system_statement');
    const s2 = store.get(r2.statement, 'system_statement');
    assert.equal(s1.body.origin, 'auditor_clarification');
    assert.equal(s1.body.intent_timing, 'before_walkthrough');
    assert.equal(s2.body.intent_timing, 'after_walkthrough');
    assert.equal(s2.body.statement, 'fee-on-transfer and rebasing tokens are unsupported');
    // Worker-less capture channel cannot be used by the auditor channel.
    assert.throws(() => h.auditor.do(eid, 'capture_input', { text: 'x' }), code('permission_denied'));
  }),
);

test(
  'clarification queue: capacity holds without dropping, duplicates coalesce, answers release blocked work',
  withHarness((h) => {
    const eid = 'e3';
    const { inv } = admittedInvestigation(h, eid);
    const ask = (issue: string, priority: number, blocks: Ref[] = []) =>
      h.auditor.do(eid, 'submit_proposal', { kind: 'clarification', body: { issue, priority, blocks, options: [{ option: 'yes', consequence: 'accounting uses received amount' }] } });
    const c1 = ask('Are fee-on-transfer tokens supported?', 50, [inv]);
    assert.equal(c1.status, 'queued');
    assert.equal(h.ws.store(eid, true).mustHead(inv.record_id, 'investigation').body.work_state, 'blocked');
    const dup = ask('are fee-on-transfer tokens supported?', 60);
    assert.equal(dup.status, 'coalesced');
    ask('May users control the callback recipient?', 40);
    const held = ask('Is pause allowed to delay withdrawals?', 10);
    assert.equal(held.status, 'held'); // capacity 2
    const q = h.auditor.do(eid, 'clarification_queue');
    assert.equal(q.open.length, 2);
    assert.equal(q.held.length, 1);
    // Answer the first with captured input; dependent work returns to queued and the held one is promoted.
    const cap = h.capture.do(eid, 'capture_input', { text: 'unknown', purpose: 'clarification_answer' }).captured_input;
    const clar = head(h, eid, c1.clarification.record_id);
    const res = decide(h, eid, 'answer_clarification', [clar], { clarification: clar, answer: 'unknown', captured_input: cap });
    assert.equal(res.released.length, 1);
    assert.ok(res.promoted);
    const store = h.ws.store(eid, true);
    assert.equal(store.mustHead(inv.record_id, 'investigation').body.work_state, 'queued');
    assert.equal(store.get(res.statement, 'system_statement').body.kind, 'unknown');
  }),
);

test(
  'FR-32: a batch is refused until its flow has a recorded review',
  withHarness((h) => {
    const eid = 'e4';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    acceptPolicy(h, eid);
    stageSnapshot(h, eid);
    const flow = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal' } }).audit_unit;
    const other = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'liquidation' } }).audit_unit;
    const inv = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'hypothesis', question: 'q', audit_units: [flow], potential_impact: 'medium' } }).investigation;
    const prep = h.auditor.do(eid, 'prepare_work', { kind: 'batch', investigations: [inv] });
    assert.ok(prep.gaps.some((g: string) => g.includes('no record_flow_review')));
    assert.ok(prep.gaps.some((g: string) => g.includes(other.record_id)));
    const authorize = () => {
      const invHead = head(h, eid, inv.record_id);
      const r = display(h, eid, [invHead]);
      return h.screen.do(eid, 'authorize_work', {
        reviewed: [invHead],
        display_receipt: r,
        inputs: { kind: 'batch', investigations: [invHead], capabilities: { tools: ['forge_test'], providers: [], network: 'denied' }, limits: LIMITS },
        rationale: 'r',
        rationale_authorship: 'human_written',
      });
    };
    assert.throws(authorize, code('permission_denied'));
    decide(h, eid, 'record_flow_review', [flow], { audit_unit: flow });
    const ok = authorize();
    assert.equal(ok.admitted.length, 1);
    assert.equal(h.ws.store(eid, true).mustHead(inv.record_id, 'investigation').body.work_state, 'queued');
    // Unbounded or over-budget authorizations are refused.
    const inv2 = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'hypothesis', question: 'q2', audit_units: [head(h, eid, flow.record_id)] } }).investigation;
    const r2 = display(h, eid, [inv2]);
    assert.throws(
      () => h.screen.do(eid, 'authorize_work', { reviewed: [inv2], display_receipt: r2, inputs: { kind: 'batch', investigations: [inv2], capabilities: { tools: [], providers: [], network: 'denied' }, limits: { ...LIMITS, spend: 1000 } }, rationale: 'r', rationale_authorship: 'human_written' }),
      code('budget_exhausted'),
    );
    assert.throws(
      () => h.screen.do(eid, 'authorize_work', { reviewed: [inv2], display_receipt: r2, inputs: { kind: 'batch', investigations: [inv2], capabilities: { tools: [], providers: ['unapproved-llm'], network: 'denied' }, limits: LIMITS }, rationale: 'r', rationale_authorship: 'human_written' }),
      code('permission_denied'),
    );
  }),
);

test(
  'packets list every variant and need verbatim positions; incomplete packets are refused',
  withHarness((h) => {
    const eid = 'e5';
    const { inv } = admittedInvestigation(h, eid);
    const v = h.auditor.do(eid, 'submit_proposal', {
      kind: 'scenario_variant',
      body: { investigation: { record_id: inv.record_id }, causal_sequence: ['a'], setup_powers: [], expected_violation: 'x', defeating_condition: 'y' },
    }).variant;
    assert.throws(() => submitPacket(h, eid, inv, null), code('packet_incomplete'));
    h.auditor.do(eid, 'submit_proposal', { kind: 'scenario_variant', base: v, body: { outcome: 'refuted' } });
    assert.throws(
      () => h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd', proposed_disposition: { value: 'rejected', rationale: 'guard' } }),
      code('packet_incomplete'),
    );
    const res = submitPacket(h, eid, inv, { value: 'rejected', rationale: 'guard' });
    const pkt = h.ws.store(eid, true).get(res.packet, 'review_packet');
    assert.equal(pkt.body.variants.length, 1);
    assert.equal(pkt.body.evidence_quality.positive_control, 'pending');
    assert.ok(pkt.body.challenger_position);
    assert.equal(h.ws.store(eid, true).archive.getText(pkt.body.challenger_position!.artifact).startsWith('Challenger:'), true);
  }),
);

test(
  'High-impact rejection needs a violating positive control and evidence-first display',
  withHarness((h) => {
    const eid = 'e6';
    const { inv } = admittedInvestigation(h, eid, { impact: 'high' });
    variantWithOutcome(h, eid, inv.record_id, 'refuted');
    const guardEvidence = stageEvidence(h, eid, inv.record_id, 'experiment', 'no_violation_observed');
    // PoC failed for an unrelated reason: the guard-removed rerun shows no violation.
    stageEvidence(h, eid, inv.record_id, 'positive_control', 'no_violation_observed');
    let pkt = submitPacket(h, eid, inv, { value: 'rejected', rationale: 'guard blocks it' }).packet;
    const reject = {
      disposition: 'rejected',
      decisive_evidence: [guardEvidence],
      countercondition: 'nonReentrant on withdraw',
      countercondition_scope: 'withdraw path at this snapshot',
    };
    assert.throws(() => dispose(h, eid, pkt, inv, reject), code('evidence_requirement_unmet'));
    // no_finding_within_bounds cannot launder the refutation either.
    assert.throws(
      () => dispose(h, eid, pkt, inv, { disposition: 'no_finding_within_bounds', bounds: { methods: ['scenario'], variants_tried: '1', budget: '10 USD', attacker_charter: 'default', assumptions: [] } }),
      code('evidence_requirement_unmet'),
    );
    // New linked evidence after the packet makes the approval stale.
    stageEvidence(h, eid, inv.record_id, 'positive_control', 'counterexample');
    assert.throws(() => dispose(h, eid, pkt, inv, reject), code('stale_dependency'));
    pkt = submitPacket(h, eid, inv, { value: 'rejected', rationale: 'guard blocks it' }).packet;
    // Proposed disposition revealed before the evidence: refused.
    assert.throws(
      () => dispose(h, eid, pkt, inv, reject, ['proposed_disposition', 'evidence', 'challenger', 'evidence_quality']),
      code('display_required'),
    );
    const ok = dispose(h, eid, pkt, inv, reject);
    assert.equal(ok.disposition, 'rejected');
    const after = h.ws.store(eid, true).mustHead(inv.record_id, 'investigation');
    assert.equal(after.body.disposition?.value, 'rejected');
    assert.equal(after.body.proof_status.positive_control, 'shows_violation');
    assert.equal(after.body.work_state, 'closed');
  }),
);

test(
  'acceptance evidence route scales with potential impact',
  withHarness((h) => {
    const eid = 'e7';
    const { inv } = admittedInvestigation(h, eid, { impact: 'high' });
    variantWithOutcome(h, eid, inv.record_id, 'supports');
    stageEvidence(h, eid, inv.record_id, 'replay', 'error');
    // A failed replay: executable confirmation cannot be requested, so the packet is incomplete.
    assert.throws(() => submitPacket(h, eid, inv, { value: 'accepted', rationale: 'double payout' }), code('packet_incomplete'));
    const pkt = submitPacket(h, eid, inv, { value: 'accepted', rationale: 'double payout' }, { executable_confirmation_requested: false }).packet;
    const finding = { title: 'Reentrant double payout', mechanism: 'callback before state update', impact: 'loss of funds' };
    assert.throws(() => dispose(h, eid, pkt, inv, { disposition: 'accepted', severity: 'High', evidence_route: 'code_argument', finding }), code('evidence_requirement_unmet'));
    assert.throws(() => dispose(h, eid, pkt, inv, { disposition: 'accepted', severity: 'High', evidence_route: 'executable_replay', finding }), code('evidence_requirement_unmet'));
    const alt = { why_impractical: 'fork state unavailable', why_sufficient: 'trace shows ordering', limits: 'not executed end to end' };
    // The failed replay must be addressed.
    assert.throws(() => dispose(h, eid, pkt, inv, { disposition: 'accepted', severity: 'High', evidence_route: 'alternative_argument', alternative: alt, finding }), code('evidence_requirement_unmet'));
    const res = dispose(h, eid, pkt, inv, { disposition: 'accepted', severity: 'High', evidence_route: 'alternative_argument', alternative: { ...alt, failed_replays_addressed: 'replay failed on missing archive state' }, finding });
    assert.equal(res.findings.length, 1);
    const f = h.ws.store(eid, true).get(res.findings[0], 'finding');
    assert.equal(f.body.evidence_route, 'alternative_argument');
  }),
);

test(
  'low-impact acceptance on a code argument; triage needs auditor-confirmed low impact; auditor may lower impact only with a reason',
  withHarness((h) => {
    const eid = 'e8';
    const { inv } = admittedInvestigation(h, eid, { impact: 'low', executable: false, method: 'hypothesis' });
    const pkt = h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'event missing', decision_requested: 'disposition' }).packet;
    assert.throws(() => dispose(h, eid, pkt, inv, { disposition: 'triaged_out', triage_reason: 'cosmetic' }), code('evidence_requirement_unmet'));
    const res = dispose(h, eid, pkt, inv, { disposition: 'accepted', severity: 'Low', evidence_route: 'code_argument', finding: { title: 'Missing event', mechanism: 'no event on withdraw', impact: 'monitoring gap' } });
    assert.equal(res.findings.length, 1);
  }),
);

test(
  'linked variants create linked claims flagged for unreviewed flows, each disposed separately',
  withHarness((h) => {
    const eid = 'e9';
    const { inv } = admittedInvestigation(h, eid, { impact: 'medium' });
    const otherFlow = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'liquidation' } }).audit_unit;
    variantWithOutcome(h, eid, inv.record_id, 'refuted');
    const lv = variantWithOutcome(h, eid, inv.record_id, 'supports', {
      linked_guarantee: 'liquidations cannot be blocked',
      linked_flow: otherFlow,
      linked_claim: 'reentrant withdraw blocks liquidation',
      potential_impact: 'low',
    });
    // A follow-up needing a new capability is redirected to authorize_work as a new question.
    const redirected = h.auditor.do(eid, 'submit_proposal', {
      kind: 'scenario_variant',
      body: { investigation: { record_id: inv.record_id }, causal_sequence: ['x'], expected_violation: 'e', defeating_condition: 'd', follow_up_requires: ['new attacker power'], question: 'Can a keeper grief?' },
    });
    assert.equal(redirected.redirected_to_authorize_work, true);
    assert.equal(redirected.work_state, 'proposed');
    const store = h.ws.store(eid, true);
    const invNow = store.mustHead(inv.record_id, 'investigation');
    assert.equal(invNow.body.linked_claims.length, 1);
    assert.equal(invNow.body.linked_claims[0].flow_reviewed, false);
    assert.ok(store.get(lv, 'scenario_variant').body.linked_claim_id);
    const pkt = submitPacket(h, eid, inv, { value: 'no_finding_within_bounds', rationale: 'nothing' }).packet;
    const p = store.get(pkt, 'review_packet');
    assert.equal(p.body.linked_claims[0].unreviewed_flow, true);
    const bounds = { methods: ['scenario'], variants_tried: '2', budget: '10 USD', attacker_charter: 'default', assumptions: [] };
    assert.throws(() => dispose(h, eid, pkt, inv, { disposition: 'no_finding_within_bounds', bounds }), code('invalid_request'));
    const res = dispose(h, eid, pkt, inv, {
      disposition: 'no_finding_within_bounds',
      bounds,
      linked_claims: [{ id: 'lc-1', disposition: 'deferred', residual_concern: 'liquidation flow unreviewed', revisit_condition: 'after liquidation flow review' }],
    });
    assert.equal(res.disposition, 'no_finding_within_bounds');
    const done = h.ws.store(eid, true).mustHead(inv.record_id, 'investigation');
    assert.equal(done.body.linked_claims[0].disposition?.value, 'deferred');
  }),
);

test(
  'conflicting proposals at the same base: one commits, the other is retained and conflicts visibly',
  withHarness((h) => {
    const eid = 'e10';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    const s = h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'withdraw updates balance after transfer' } }).statement;
    h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', base: s, body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'A: balance updated after transfer' } });
    try {
      h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', base: s, body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'B: balance updated before transfer' } });
      assert.fail('expected conflict');
    } catch (e) {
      assert.ok(isHarnessError(e, 'revision_conflict'));
      assert.equal((e as { committed: boolean }).committed, true);
    }
    const conflicts = h.auditor.do(eid, 'read_records', { type: 'proposal_conflict' }).records;
    assert.equal(conflicts.length, 1);
    assert.match(JSON.stringify(conflicts[0].body.proposal), /B: balance updated before transfer/);
  }),
);

test(
  'agent-drafted rationale records its edit diff; revise_premise marks dependents affected',
  withHarness((h) => {
    const eid = 'e11';
    const { inv } = admittedInvestigation(h, eid, { impact: 'low', executable: false, method: 'hypothesis' });
    const store = () => h.ws.store(eid, true);
    const premise = store().heads('system_statement').find((s) => s.body.origin === 'adopted_assumption')!;
    const premiseRef = { record_id: premise.record_id, revision: premise.revision };
    // Investigation cites the premise and an unreviewed seeded statement as support.
    const seeded = h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'only the owner can sweep' } });
    h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', base: head(h, eid, inv.record_id), body: { supporting: [premiseRef, seeded.statement] } });
    const pkt = h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd' }).packet;
    const invHead = head(h, eid, inv.record_id);
    const receipt = display(h, eid, [pkt, invHead]);
    const res = h.screen.do(eid, 'record_decision', {
      decision_kind: 'dispose_investigation',
      reviewed: [pkt, invHead],
      display_receipt: receipt,
      inputs: { packet: pkt, investigation: invHead, disposition: 'deferred', residual_concern: 'admin can drain', revisit_condition: 'if roles raised' },
      rationale: 'Deferred: admin trust premise holds for now.',
      agent_draft: 'Deferred: admin trust holds.',
      rationale_authorship: 'agent_drafted_edited',
    });
    const dec = store().get(res.decision, 'human_decision');
    // FR-40: the decision rests on a provisional agent statement and is recorded as conditional on it.
    assert.ok(dec.body.conditional_on.some((r) => r.record_id === seeded.statement.record_id));
    assert.match(dec.body.edit_diff!, /^- Deferred: admin trust holds\./m);
    assert.match(dec.body.edit_diff!, /^\+ Deferred: admin trust premise holds for now\./m);
    // Revise the trusted-role premise: the deferred investigation becomes affected.
    const r = display(h, eid, [premiseRef]);
    const rev = h.screen.do(eid, 'revise_premise', { reviewed: [premiseRef], display_receipt: r, inputs: { statement: premiseRef, new_statement: 'The owner role is raised: not trusted.' }, rationale: 'client says owner is an EOA', rationale_authorship: 'human_written' });
    assert.ok(rev.affected.some((a: Ref) => a.record_id === inv.record_id));
    const fresh = store().heads('conclusion_freshness').find((f) => f.body.conclusion.record_id === inv.record_id)!;
    assert.equal(fresh.body.value, 'affected');
  }),
);

test(
  'FR-19: a full review queue refuses new batches without discarding admitted work',
  withHarness((h) => {
    const eid = 'e12';
    const { inv, flow } = admittedInvestigation(h, eid, { impact: 'low', executable: false, method: 'hypothesis' });
    // Fill the review queue (capacity 3 in the fixture policy) with packets awaiting the auditor.
    h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd' });
    const more: Ref[] = [];
    for (let i = 0; i < 3; i++) {
      const q = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'hypothesis', question: `q${i}`, audit_units: [head(h, eid, flow.record_id)], potential_impact: 'low', executable: false } }).investigation;
      more.push(q);
    }
    const authorize = (r: Ref) => {
      const cur = head(h, eid, r.record_id);
      return h.screen.do(eid, 'authorize_work', {
        reviewed: [cur],
        display_receipt: display(h, eid, [cur]),
        inputs: { kind: 'batch', investigations: [cur], capabilities: { tools: [], providers: [], network: 'denied' }, limits: { ...LIMITS, spend: 1 } },
        rationale: 'r',
        rationale_authorship: 'human_written',
      });
    };
    for (const r of more.slice(0, 2)) {
      authorize(r);
      h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, r.record_id), claim: 'c', decision_requested: 'd' });
    }
    assert.throws(() => authorize(more[2]), code('review_capacity_reached'));
    // Admitted work is kept: every packet still awaits review.
    const ready = h.ws.store(eid, true).heads('investigation').filter((i) => i.body.work_state === 'ready_for_review');
    assert.equal(ready.length, 3);
  }),
);
