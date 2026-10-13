// Regression tests for the second adversarial review (decision, scheduler, leads and evaluation
// parts; the runner's broker and interpretation fixes are pinned in test/runner*.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, type Harness } from './helpers.ts';
import { admittedInvestigation, display, head, LIMITS, stageEvidence, variantWithOutcome } from './decision-fixtures.ts';
import { fixtureOverrides, isTargetSourceEdit } from '../src/decision/index-exports.ts';
import { batchStatus } from '../src/scheduler/scheduler.ts';
import { isHarnessError } from '../src/core/errors.ts';
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

function stageJob(h: Harness, eid: string, inv: string, purpose: string, body: Record<string, unknown>): Ref {
  const store = h.ws.store(eid, true);
  const snap = store.mustHead('eng-0001', 'engagement').body.active_snapshot!;
  const res = store.commit({
    records: [
      {
        type: 'job',
        base_revision: 0,
        body: {
          authorization: store.mustHead(inv, 'investigation').body.authorization!,
          context_manifest: null,
          role: 'tool',
          purpose: purpose as never,
          adapter: { name: 'forge_test', version: 'fixture', descriptor: 'fixture' },
          operation: 'test',
          args: {},
          snapshot: snap,
          fixture: null,
          input_digest: 'sha256:' + '3'.repeat(64),
          investigation: { record_id: inv, revision: 1 },
          variant: null,
          limits: LIMITS,
          reservation: { spend: 0, runtime_seconds: 10 },
          lineage: null,
          guard_removal: null,
          status: 'completed',
          attempts: [],
          ...body,
        },
      },
    ],
    events: [],
    principal: { channel: 'runner', principal: 'trusted-runner' },
    origin: { operation: 'test_fixture', request_id: 'f', job: null, attempt: null, decision: null },
    now: new Date().toISOString(),
    message: 'fixture job',
  });
  h.ws.noteCommitted(eid);
  return res.refs[0];
}

test(
  'H1: a guard "removal" that edits a test file or inserts code is not a bound positive control',
  withHarness((h) => {
    const eid = 'g1';
    const { inv } = admittedInvestigation(h, eid);
    const store = () => h.ws.store(eid, true);
    const onTest = stageJob(h, eid, inv.record_id, 'positive_control', { guard_removal: { path: 'test/Exploit.t.sol', find: 'uint gained = 0;', replace: 'uint gained = 1;' } });
    const inserts = stageJob(h, eid, inv.record_id, 'positive_control', { guard_removal: { path: 'src/Vault.sol', find: 'external nonReentrant {', replace: 'external { selfdestruct(payable(msg.sender));' } });
    const removes = stageJob(h, eid, inv.record_id, 'positive_control', { guard_removal: { path: 'src/Vault.sol', find: 'external nonReentrant {', replace: 'external {' } });
    assert.equal(isTargetSourceEdit(store(), store().get(onTest, 'job'), true), false);
    assert.equal(isTargetSourceEdit(store(), store().get(inserts, 'job'), true), false);
    assert.equal(isTargetSourceEdit(store(), store().get(removes, 'job'), true), true);
    // A reviewed fault for adequacy may change code, but only in a target source.
    assert.equal(isTargetSourceEdit(store(), store().get(inserts, 'job'), false), true);
  }),
);

test(
  'H3: a fixture that adds a remapping or a non-test source alters the target even without overriding a file',
  withHarness((h) => {
    const eid = 'g2';
    admittedInvestigation(h, eid);
    const fx = h.auditor.do(eid, 'submit_fixture', { files: { 'remappings.txt': 'dep/=test/evil/', 'src/Extra.sol': '// new source', 'test/Poc.t.sol': '// test' } });
    assert.deepEqual(fx.overrides_target, ['remappings.txt', 'src/Extra.sol']);
    assert.deepEqual(fx.added, ['test/Poc.t.sol']);
    void fixtureOverrides;
  }),
);

test(
  'M4: independence facts are derived, and a position written before later evidence is stale',
  withHarness((h) => {
    const eid = 'g3';
    const { inv } = admittedInvestigation(h, eid, { impact: 'high' });
    const early = h.auditor.do(eid, 'submit_position', { investigation: inv, role: 'challenger', text: 'early challenge' }).position;
    variantWithOutcome(h, eid, inv.record_id, 'refuted');
    stageEvidence(h, eid, inv.record_id, 'experiment', 'no_violation_observed');
    assert.throws(
      () => h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd', challenger_position: early, author_position: 'a' }),
      code('stale_dependency'),
    );
    const late = h.auditor.do(eid, 'submit_position', { investigation: inv, role: 'challenger', text: 'current challenge' }).position;
    assert.ok(h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd', challenger_position: late, author_position: 'a' }).packet);
  }),
);

test(
  'M9: uncertain spend is not counted twice; an outcome_unknown job keeps its batch open',
  withHarness((h) => {
    const eid = 'g4';
    const { inv } = admittedInvestigation(h, eid, { impact: 'low', executable: false, method: 'hypothesis' });
    const store = () => h.ws.store(eid, true);
    const auth = store().mustHead(inv.record_id, 'investigation').body.authorization!;
    const job = stageJob(h, eid, inv.record_id, 'experiment', { status: 'outcome_unknown' });
    void job;
    const st = store();
    const a = st.mustHead(auth.record_id, 'work_authorization');
    // A held reservation labelled uncertain: 400 of 600 runtime seconds.
    st.commit({
      records: [
        { type: 'ledger_entry', base_revision: 0, body: { authorization: auth, attempt: null, kind: 'reservation', spend: 0, runtime_seconds: 400, note: 'held' } },
        { type: 'ledger_entry', base_revision: 0, body: { authorization: auth, attempt: null, kind: 'uncertain', spend: 0, runtime_seconds: 400, note: 'label on the held reservation' } },
      ],
      events: [],
      principal: { channel: 'runner', principal: 'trusted-runner' },
      origin: { operation: 'test_fixture', request_id: 'f', job: null, attempt: null, decision: null },
      now: new Date().toISOString(),
      message: 'fixture ledger',
    });
    h.ws.noteCommitted(eid);
    assert.equal(batchStatus(store(), store().mustHead(a.record_id, 'work_authorization'), new Date().toISOString()), 'active');
  }),
);

test(
  'M12/M16: a decided packet cannot become a canary; a refused High rejection is recorded',
  withHarness((h) => {
    const eid = 'g5';
    const { inv } = admittedInvestigation(h, eid, { impact: 'high' });
    variantWithOutcome(h, eid, inv.record_id, 'refuted');
    const ev = stageEvidence(h, eid, inv.record_id, 'experiment', 'no_violation_observed');
    const pkt = h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd', challenger_position: 'x', author_position: 'y' }).packet as Ref;
    const invHead = head(h, eid, inv.record_id);
    const attempt = () =>
      h.screen.do(eid, 'record_decision', {
        decision_kind: 'dispose_investigation',
        reviewed: [pkt, invHead],
        display_receipt: display(h, eid, [pkt, invHead], ['evidence', 'challenger', 'evidence_quality', 'proposed_disposition']),
        inputs: { packet: pkt, investigation: invHead, disposition: 'rejected', decisive_evidence: [ev], countercondition: 'guard', countercondition_scope: 'withdraw' },
        rationale: 'r',
        rationale_authorship: 'human_written',
      });
    try {
      attempt();
      assert.fail('expected refusal');
    } catch (e) {
      assert.ok(isHarnessError(e, 'evidence_requirement_unmet'));
      assert.equal((e as { committed: boolean }).committed, true, 'the refusal itself is recorded');
    }
    const refused = h.ws.store(eid, true).events().filter((x) => x.kind === 'decision_refused');
    assert.equal(refused.length, 1);
    assert.equal((refused[0].result as { attempted: { disposition: string } }).attempted.disposition, 'rejected');
    assert.equal(h.ws.store(eid, true).heads('human_decision').filter((d) => d.body.kind === 'dispose_investigation').length, 0, 'no decision was recorded');
    // Decide it (deferred), then a canary on it is refused.
    const invNow = head(h, eid, inv.record_id);
    h.screen.do(eid, 'record_decision', { decision_kind: 'dispose_investigation', reviewed: [pkt, invNow], display_receipt: display(h, eid, [pkt, invNow], ['evidence', 'challenger', 'evidence_quality', 'proposed_disposition']), inputs: { packet: pkt, investigation: invNow, disposition: 'deferred', residual_concern: 'c', revisit_condition: 'r' }, rationale: 'r', rationale_authorship: 'human_written' });
    assert.throws(() => h.auditor.do('library', 'register_canary', { engagement: eid, packet: pkt, kind: 'invalid_claim_plausible_narrative' }), code('invalid_request'));
  }),
);
