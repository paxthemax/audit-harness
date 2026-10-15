import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHarnessError } from '../src/core/errors.ts';
import { UNATTENDED_PRINCIPAL } from '../src/core/values.ts';
import { acceptScopeAndPolicyUnattended, authorizeWorkUnattended, openUnattendedScreen, recordFlowReviewUnattended } from '../src/screen/index.ts';
import { makeHarness, newEngagement, type Harness } from './helpers.ts';
import { acceptPolicy, display, head, LIMITS, policy, stageSnapshot } from './decision-fixtures.ts';
import { computeRequiredSet } from '../src/report/requiredSet.ts';

const NOW = '2026-10-14T12:00:00.000Z';

function open(h: Harness, eid: string) {
  return openUnattendedScreen({ ws: h.ws, key: h.ws.readSecret('auditor.key'), engagement: eid, controller: h.controller });
}

function code(c: string) {
  return (e: unknown) => isHarnessError(e, c as never);
}

function withHarness(fn: (h: Harness, eid: string) => Promise<void>) {
  return async () => {
    const h = makeHarness();
    try {
      await fn(h, newEngagement(h));
    } finally {
      h.cleanup();
    }
  };
}

test(
  'unattended approval is off by default: the approver cannot be opened',
  withHarness(async (h, eid) => {
    assert.deepEqual(h.ws.unattendedKinds(eid), []);
    assert.throws(() => open(h, eid), code('permission_denied'));
  }),
);

test(
  'a delegated scope and policy is accepted without a terminal and recorded as unattended',
  withHarness(async (h, eid) => {
    h.ws.setUnattended(eid, ['accept_scope_and_policy'], NOW);
    const { screen, io } = open(h, eid);
    assert.equal(io.interactive, false);
    const out = await acceptScopeAndPolicyUnattended(screen, policy());
    assert.equal(out.status, 'decided');
    const store = h.ws.store(eid, true);
    const decision = store.heads('human_decision')[0];
    assert.equal(decision.body.actor, UNATTENDED_PRINCIPAL);
    assert.equal(decision.body.rationale_authorship, 'agent_unattended');
    assert.match(decision.body.rationale, /No human reviewed this decision/);
    assert.deepEqual(store.heads('engagement')[0].body.policy, policy());
    const receipt = store.heads('display_receipt')[0];
    assert.match(receipt.body.screen.identity, /^harness-unattended-approver /);
    // The adopted trusted-role premise is not presented as human-reviewed.
    const premise = store.heads('system_statement').find((s) => s.body.origin === 'adopted_assumption');
    assert.equal(premise?.body.review_status, 'provisional');
    assert.match(premise?.body.statement ?? '', /no human reviewed this premise/);
  }),
);

test(
  'a draft that leaves a default capability unanswered is refused, not defaulted',
  withHarness(async (h, eid) => {
    h.ws.setUnattended(eid, ['accept_scope_and_policy'], NOW);
    const { screen } = open(h, eid);
    const p = policy();
    p.attacker_charter.capabilities = p.attacker_charter.capabilities.slice(1);
    await assert.rejects(acceptScopeAndPolicyUnattended(screen, p), code('invalid_request'));
    assert.equal(h.ws.store(eid, true).heads('human_decision').length, 0);
  }),
);

test(
  'only the delegated kinds are reachable',
  withHarness(async (h, eid) => {
    acceptPolicy(h, eid);
    stageSnapshot(h, eid);
    const prop = h.auditor.do(eid, 'prepare_work', { kind: 'intake' }).work_proposal;
    h.ws.setUnattended(eid, ['accept_scope_and_policy'], NOW);
    const { screen } = open(h, eid);
    const refused = await authorizeWorkUnattended(screen, prop.record_id, { limits: LIMITS });
    assert.equal(refused.status, 'refused');
    assert.ok(refused.status === 'refused' && refused.error.code === 'permission_denied');
    assert.equal(h.ws.store(eid, true).heads('work_authorization').length, 0);
  }),
);

test(
  'work authorization needs every limit from the draft; with all of them it is recorded as unattended',
  withHarness(async (h, eid) => {
    acceptPolicy(h, eid);
    stageSnapshot(h, eid);
    const prop = h.auditor.do(eid, 'prepare_work', { kind: 'intake' }).work_proposal;
    h.ws.setUnattended(eid, ['authorize_work'], NOW);
    const { screen } = open(h, eid);
    const { spend: _omitted, ...partial } = LIMITS;
    await assert.rejects(authorizeWorkUnattended(screen, prop.record_id, { limits: partial }), code('invalid_request'));
    assert.equal(h.ws.store(eid, true).heads('work_authorization').length, 0);
    const out = await authorizeWorkUnattended(screen, prop.record_id, { limits: LIMITS });
    assert.equal(out.status, 'decided');
    const store = h.ws.store(eid, true);
    const auth = store.heads('work_authorization')[0];
    assert.equal(auth.body.status, 'active');
    const decision = store.heads('human_decision').find((d) => d.body.kind === 'authorize_work');
    assert.equal(decision?.body.actor, UNATTENDED_PRINCIPAL);
    assert.equal(decision?.body.rationale_authorship, 'agent_unattended');
  }),
);

test(
  'agent_unattended authorship belongs to the unattended approver and only to it',
  withHarness(async (h, eid) => {
    const eng = head(h, eid, 'eng-0001');
    // The ordinary screen channel cannot claim it.
    assert.throws(
      () =>
        h.screen.do(eid, 'record_decision', {
          decision_kind: 'accept_scope_and_policy',
          reviewed: [eng],
          display_receipt: display(h, eid, [eng]),
          inputs: { policy: policy() },
          rationale: 'claims to be unattended',
          rationale_authorship: 'agent_unattended',
        }),
      code('permission_denied'),
    );
    // The unattended approver cannot pass as a human.
    h.ws.setUnattended(eid, ['accept_scope_and_policy'], NOW);
    const { screen } = open(h, eid);
    assert.throws(
      () =>
        screen.session.do(eid, 'record_decision', {
          decision_kind: 'accept_scope_and_policy',
          reviewed: [eng],
          display_receipt: screen.session.do(eid, 'record_display', { rendered: [eng], sections: [], started_at: NOW, ended_at: NOW, implemented_presented_for: [] }).display_receipt,
          inputs: { policy: policy() },
          rationale: 'claims to be a human',
          rationale_authorship: 'human_written',
        }),
      code('permission_denied'),
    );
    assert.equal(h.ws.store(eid, true).heads('human_decision').length, 0);
  }),
);

test(
  'withdrawing the delegation stops an already-open approver at the controller',
  withHarness(async (h, eid) => {
    h.ws.setUnattended(eid, ['accept_scope_and_policy'], NOW);
    const { screen } = open(h, eid);
    h.ws.setUnattended(eid, null, NOW);
    assert.deepEqual(h.ws.unattendedKinds(eid), []);
    const refused = await acceptScopeAndPolicyUnattended(screen, policy());
    assert.equal(refused.status, 'refused');
    assert.ok(refused.status === 'refused' && refused.error.code === 'permission_denied');
    assert.equal(h.ws.store(eid, true).heads('human_decision').length, 0);
    assert.throws(() => open(h, eid), code('permission_denied'));
  }),
);

test(
  'only the delegable kinds can be delegated',
  withHarness(async (h, eid) => {
    assert.throws(() => h.ws.setUnattended(eid, ['dispose_investigation' as never], NOW), code('invalid_request'));
    assert.deepEqual(h.ws.unattendedKinds(eid), []);
  }),
);

test(
  'a delegated flow review lifts the batch gate but marks no function reviewed and presents no implemented behavior',
  withHarness(async (h, eid) => {
    acceptPolicy(h, eid);
    stageSnapshot(h, eid);
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal', functions: [{ name: 'Vault.withdraw' }] } }).audit_unit;
    h.auditor.do(eid, 'submit_proposal', {
      kind: 'system_statement',
      body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'withdraw pays first', audit_units: [unit] },
    });
    const inv = h.auditor.do(eid, 'submit_proposal', {
      kind: 'investigation',
      body: { method: 'scenario', question: 'Can withdraw pay twice?', lead_generator: 'manual', audit_units: [unit], guarantees: ['withdraw pays at most the balance'], potential_impact: 'high', anchors: [] },
    }).investigation;
    const prop = h.auditor.do(eid, 'prepare_work', { kind: 'batch', investigations: [head(h, eid, inv.record_id)] }).work_proposal;
    h.ws.setUnattended(eid, ['authorize_work', 'record_flow_review'], NOW);
    const { screen } = open(h, eid);

    const gated = await authorizeWorkUnattended(screen, prop.record_id, { limits: LIMITS });
    assert.ok(gated.status === 'refused' && gated.error.code === 'permission_denied', 'the batch gate holds before the flow review');
    await assert.rejects(recordFlowReviewUnattended(screen, unit.record_id, { reviewed_functions: ['Vault.withdraw'] } as never), code('invalid_request'));

    const out = await recordFlowReviewUnattended(screen, unit.record_id, { gaps: ['callback ordering not walked'] });
    assert.equal(out.status, 'decided');
    const store = h.ws.store(eid, true);
    const reviewed = store.mustHead(unit.record_id, 'audit_unit').body;
    assert.equal(reviewed.review_status, 'reviewed');
    assert.deepEqual(reviewed.functions, [{ name: 'Vault.withdraw', reviewed: false }]);
    assert.ok(reviewed.gaps.includes('callback ordering not walked'));
    assert.ok(reviewed.gaps.some((g) => /^Unattended flow review dec-\d+ at snap-\d+@\d+: no human reviewed this flow$/.test(g)));
    const decision = store.heads('human_decision').find((d) => d.body.kind === 'record_flow_review')!;
    assert.equal(decision.body.actor, UNATTENDED_PRINCIPAL);
    assert.equal(decision.body.rationale_authorship, 'agent_unattended');
    assert.deepEqual(store.mustHead(decision.body.display_receipt.record_id, 'display_receipt').body.implemented_presented_for, []);
    // Closure and the report still treat the unit as not reviewed by a human.
    const coverage = computeRequiredSet(store).items.find((i) => i.key === `audit_unit:${unit.record_id}`)!;
    assert.equal(coverage.incomplete, true);
    assert.equal(coverage.detail.unattended_review, true);

    assert.equal((await authorizeWorkUnattended(screen, prop.record_id, { limits: LIMITS })).status, 'decided');
    assert.equal(h.ws.store(eid, true).mustHead(inv.record_id, 'investigation').body.work_state, 'queued');

    // A later human flow review supersedes it: the gap and the unattended label go.
    const unitHead = head(h, eid, unit.record_id);
    h.screen.do(eid, 'record_decision', {
      decision_kind: 'record_flow_review',
      reviewed: [unitHead],
      display_receipt: display(h, eid, [unitHead]),
      inputs: { audit_unit: unitHead, reviewed_functions: ['Vault.withdraw'] },
      rationale: 'walked the flow',
      rationale_authorship: 'human_written',
    });
    const after = h.ws.store(eid, true);
    assert.deepEqual(after.mustHead(unit.record_id, 'audit_unit').body.gaps, ['callback ordering not walked']);
    assert.equal(computeRequiredSet(after).items.find((i) => i.key === `audit_unit:${unit.record_id}`)!.incomplete, false);
  }),
);

test(
  'the controller refuses function review flags from the unattended approver',
  withHarness(async (h, eid) => {
    acceptPolicy(h, eid);
    stageSnapshot(h, eid);
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal', functions: [{ name: 'Vault.withdraw' }] } }).audit_unit;
    h.ws.setUnattended(eid, ['record_flow_review'], NOW);
    const { screen } = open(h, eid);
    const receipt = screen.session.do(eid, 'record_display', { rendered: [unit], sections: [], started_at: NOW, ended_at: NOW, implemented_presented_for: [] }).display_receipt;
    assert.throws(
      () =>
        screen.session.do(eid, 'record_decision', {
          decision_kind: 'record_flow_review',
          reviewed: [unit],
          display_receipt: receipt,
          inputs: { audit_unit: unit, comparisons: [], gaps: [], reviewed_functions: ['Vault.withdraw'] },
          rationale: 'unattended',
          rationale_authorship: 'agent_unattended',
        }),
      code('permission_denied'),
    );
    assert.equal(h.ws.store(eid, true).mustHead(unit.record_id, 'audit_unit').body.review_status, 'not_started');
  }),
);
