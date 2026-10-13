import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ref } from '../src/core/refs.ts';
import { adoptMethodVersion, evaluationOf, freezeEvaluationContract } from '../src/screen/library.ts';
import { reviewPacket } from '../src/screen/packet.ts';
import { makeHarness, type Harness } from './helpers.ts';
import { readyHighPacket, screenFor, scriptedIO } from './screen-fixtures.ts';

function withHarness(fn: (h: Harness) => Promise<void>) {
  return async () => {
    const h = makeHarness();
    try {
      await fn(h);
    } finally {
      h.cleanup();
    }
  };
}

function proposeContract(h: Harness): Ref {
  return h.auditor.do('library', 'propose_evaluation_contract', {
    name: 'pilot-1',
    targets: [{ engagement: 'eval-target', snapshot: null, units: ['withdraw flow'] }],
    method_versions: ['workflow@1'],
    models: [{ provider: 'fake', model: 'fake-1', settings: 'temperature 0' }],
    tools: ['forge'],
    labels: [{ case: 'vault-a', kind: 'seeded_fault', held_out: true, reference_defects: ['D1'] }],
    metric_version: 'evaluation/1',
    targets_set_before_run: [
      { metric: 'decision_quality', target: 'catch 3 of 4 canaries' },
      { metric: 'review_burden', target: 'under 2h per packet' },
    ],
  }).evaluation_contract as Ref;
}

test(
  'freeze_evaluation_contract: the screen renders the contract, asks each compared metric and freezes with its receipt',
  withHarness(async (h) => {
    h.auditor.do('eval-target', 'create_engagement', { name: 'Target', owner: 'a', audit_purpose: 'p' });
    const contract = proposeContract(h);
    const io = scriptedIO(['n', 'y', 'n', 'yes', 'Targets were set before any run.']);
    const o = await freezeEvaluationContract(screenFor(h, 'library', io), contract.record_id);
    assert.equal(o.status, 'frozen', io.text());
    assert.match(io.text(), /cross-engagement library/);
    const lib = h.ws.store('library', true);
    const c = lib.mustHead(contract.record_id, 'evaluation_contract');
    assert.equal(c.body.status, 'frozen');
    const dec = lib.heads('human_decision').pop()!;
    assert.equal(dec.body.kind, 'freeze_evaluation_contract');
    assert.deepEqual(dec.body.inputs.compared_metrics, ['decision_quality']);
    assert.equal(dec.body.rationale, 'Targets were set before any run.');
    const receipt = lib.heads('display_receipt').pop()!;
    assert.deepEqual(receipt.body.rendered, [contract]);
    assert.equal(receipt.created_by.channel, 'screen');
  }),
);

test(
  'adopt_method_version: the screen shows the held-out comparison and records the decision',
  withHarness(async (h) => {
    h.auditor.do('eval-target', 'create_engagement', { name: 'Target', owner: 'a', audit_purpose: 'p' });
    const contract = proposeContract(h);
    await freezeEvaluationContract(screenFor(h, 'library', scriptedIO(['n', 'n', 'n', 'yes', 'frozen before any run'])), contract.record_id);
    const frozen = h.ws.store('library', true).headRef(contract.record_id);
    const mv = h.auditor.do('library', 'propose_method_version', { component: 'prompt', name: 'investigator', version: '2', description: 'tighter prompt', content: 'You are the investigator.' })
      .method_version as Ref;
    const held = h.auditor.do('library', 'held_out_comparison', {
      contract: frozen,
      cases: [{ case: 'vault-a', held_out: true, runs: [{ baseline: 'pass', candidate: 'pass' }, { baseline: 'pass', candidate: 'pass' }] }],
    });
    const io = scriptedIO(['n', 'Held-out comparison shows no regression.', 'yes']);
    const o = await adoptMethodVersion(screenFor(h, 'library', io), mv.record_id, evaluationOf(held));
    assert.equal(o.status, 'decided', io.text());
    assert.match(io.text(), /Regressions \(candidate fails where baseline passes\): none/);
    assert.match(io.text(), /Q-024/);
    assert.equal(h.ws.store('library', true).mustHead(mv.record_id, 'method_version').body.status, 'adopted');
  }),
);

test(
  'canary labels never appear in the packet review',
  withHarness(async (h) => {
    const eid = 'scr-labels';
    const fx = readyHighPacket(h, eid);
    h.auditor.do('library', 'register_canary', { engagement: eid, packet: fx.packet, kind: 'invalid_claim_plausible_narrative' });
    const io = scriptedIO(['1', '2', '3', '4', '5', '6', 'v 1', 'q']);
    const o = await reviewPacket(screenFor(h, eid, io), fx.packet.record_id);
    assert.equal(o.status, 'cancelled');
    assert.ok(!/canary|invalid_claim_plausible_narrative|not_accepted/i.test(io.text()), 'packet review leaked a canary label');
  }),
);
