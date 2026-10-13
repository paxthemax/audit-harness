import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { isHarnessError } from '../src/core/errors.ts';
import { refKey, type Ref } from '../src/core/refs.ts';
import { requireEvidenceFirst } from '../src/decision/framework.ts';
import { DisplayLog, implementedUnitsOf } from '../src/screen/display.ts';
import type { RecordEnvelope } from '../src/schema/records.ts';
import { buildPacketModel, PacketReview, PACKET_SECTIONS, reviewPacket, type PacketModel } from '../src/screen/packet.ts';
import { confirmInterpretations, recordFlowReview } from '../src/screen/flows.ts';
import { openTrustedScreen } from '../src/screen/screen.ts';
import { ttyIO } from '../src/screen/tty.ts';
import { renderVisible } from '../src/screen/visible.ts';
import { makeHarness, type Harness } from './helpers.ts';
import { proposedInterpretations, readyHighPacket, screenFor, scriptedIO } from './screen-fixtures.ts';

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

const code = (c: string) => (e: unknown) => isHarnessError(e, c as never);
const at = (r: Ref) => `${r.record_id}@${r.revision}`;

test(
  'high-impact packet: proposed disposition hidden until evidence, challenger and evidence quality are opened; the receipt passes the evidence-first check',
  withHarness(async (h) => {
    const eid = 'scr-high';
    const fx = readyHighPacket(h, eid);
    const store = h.ws.store(eid, true);
    const pkt = store.get(fx.packet, 'review_packet');
    const unreviewed = pkt.body.unreviewed_statements.map(() => 'c');

    // Pure state machine: locked until the three evidence-first sections are opened.
    {
      const io = scriptedIO([]);
      const screen = screenFor(h, eid, io);
      const model = buildPacketModel(screen, fx.packet);
      assert.equal(model.evidence_first, true);
      const review = new PacketReview(model, screen.log);
      assert.equal(review.state('proposed_disposition'), 'locked');
      assert.equal(review.open('proposed_disposition'), null);
      review.open('evidence');
      review.open('challenger');
      assert.equal(review.state('proposed_disposition'), 'locked');
      review.open('evidence_quality');
      assert.equal(review.state('proposed_disposition'), 'available');
      assert.deepEqual(screen.log.sections.map((s) => s.section), ['evidence', 'challenger', 'evidence_quality']);
    }

    // Full keyboard flow on the trusted screen.
    const io = scriptedIO([
      '1', // claim
      '6', // proposed disposition: refused while locked
      '2',
      '3',
      '', // Enter opens the next section: evidence_quality
      '5',
      '6',
      'd',
      '', // keep the impact estimate
      '2', // rejected
      at(fx.guardEvidence),
      'nonReentrant on withdraw',
      'withdraw path at this snapshot',
      at(fx.positiveControl),
      ...unreviewed,
      'w', // write my own rationale
      'The guard blocks the nested call; the guard-removed rerun shows the violation.',
      'yes',
    ]);
    const screen = screenFor(h, eid, io);
    const outcome = await reviewPacket(screen, fx.packet.record_id);
    const out = io.text();
    assert.equal(outcome.status, 'decided', out);
    assert.match(out, /LOCKED: hidden until you open/);
    assert.match(out, /Section \[6\] is hidden until you open/);
    // The agent's draft appears only after section 4 was shown.
    assert.ok(out.indexOf(fx.draft) > out.indexOf('== [4] Evidence quality'), 'draft revealed before evidence quality');
    assert.ok(out.indexOf(fx.draft) > out.indexOf('== [3] Challenger'));
    // Challenger text is verbatim with the deceptive character rendered visibly.
    assert.match(out, /Challenger: the guard covers withdraw;⟦U\+202E[^⟧]*⟧ the PoC pranks no privileged role\./);
    assert.ok(!out.includes('‮'));

    const after = h.ws.store(eid, true);
    const inv = after.mustHead(fx.inv.record_id, 'investigation');
    assert.equal(inv.body.disposition?.value, 'rejected');
    const dec = after.get(inv.body.disposition!.decision, 'human_decision');
    assert.equal(dec.body.rationale_authorship, 'human_written');
    const receipt = after.get(dec.body.display_receipt, 'display_receipt');
    assert.deepEqual(receipt.body.sections.map((s) => s.section), [...PACKET_SECTIONS]);
    assert.equal(receipt.created_by.channel, 'screen');
    requireEvidenceFirst(receipt); // the controller's check passes
  }),
);

test(
  'an out-of-order display receipt is rejected with display_required',
  withHarness((h) => {
    const eid = 'scr-order';
    const fx = readyHighPacket(h, eid);
    const t = new Date().toISOString();
    const reviewed = [fx.packet, fx.inv];
    const receipt = h.screen.do(eid, 'record_display', {
      rendered: reviewed,
      sections: ['claim', 'proposed_disposition', 'evidence', 'challenger', 'evidence_quality'].map((section) => ({ section, opened_at: t })),
      started_at: t,
      ended_at: t,
    }).display_receipt as Ref;
    const env = h.ws.store(eid, true).get(receipt, 'display_receipt');
    assert.throws(() => requireEvidenceFirst(env), code('display_required'));
    assert.throws(
      () =>
        h.screen.do(eid, 'record_decision', {
          decision_kind: 'dispose_investigation',
          reviewed,
          display_receipt: receipt,
          inputs: {
            packet: fx.packet,
            investigation: fx.inv,
            disposition: 'rejected',
            decisive_evidence: [fx.guardEvidence],
            countercondition: 'nonReentrant on withdraw',
            countercondition_scope: 'withdraw path',
          },
          rationale: 'r',
          rationale_authorship: 'human_written',
        }),
      code('display_required'),
    );
  }),
);

test('below High the combined layout opens every section in canonical order', () => {
  const sec = (id: string) => ({ id, title: id, lines: [], records: [] });
  const model = {
    evidence_first: false,
    max_impact: 'medium',
    sections: Object.fromEntries(PACKET_SECTIONS.map((s) => [s, sec(s)])),
  } as unknown as PacketModel;
  const log = new DisplayLog();
  const review = new PacketReview(model, log);
  assert.equal(review.state('proposed_disposition'), 'available');
  review.openAll();
  assert.deepEqual(log.sections.map((s) => s.section), [...PACKET_SECTIONS]);
  assert.deepEqual(review.missingBeforeDeciding(), []);
});

test('deceptive characters render visibly: bidi override, zero-width space, terminal escapes, confusables', () => {
  const s = renderVisible('a‮b c​d \x1b[31mred\x1b[0m pаy ⟦U+0041⟧');
  assert.ok(!/[‮​\x1b]/.test(s));
  assert.match(s, /⟦U\+202E[^⟧]*⟧/);
  assert.match(s, /⟦U\+200B[^⟧]*⟧/);
  assert.match(s, /⟦U\+001B[^⟧]*⟧\[31m/);
  assert.match(s, /⟦U\+0430[^⟧]*⟧/);
  // A literal marker bracket in the input cannot forge a marker.
  assert.ok(!s.includes(' ⟦U+0041⟧'));
  // Safety net beyond the intake table: variation selectors and line separators.
  assert.match(renderVisible('x️y z'), /⟦U\+FE0F[^⟧]*⟧y⟦U\+2028[^⟧]*⟧z/);
  assert.equal(renderVisible('plain ASCII\tand\nnewlines, Straße'), 'plain ASCII\tand\nnewlines, Straße');
});

test(
  'confirm_interpretations: each item beside its captured input, one choice per item in one batch',
  withHarness(async (h) => {
    const eid = 'scr-interp';
    const fx = proposedInterpretations(h, eid);
    const io = scriptedIO(['c', 'e', 'deposit(0) reverts with ZeroAmount', 'r', 'Matches what I said.', 'yes']);
    const screen = screenFor(h, eid, io);
    const calls: { op: string; payload: any }[] = [];
    const orig = screen.session.call.bind(screen.session);
    screen.session.call = ((e: string, op: string, p: unknown, o?: object) => {
      calls.push({ op, payload: p });
      return orig(e, op, p, o);
    }) as typeof screen.session.call;
    const outcome = await confirmInterpretations(screen);
    const out = io.text();
    assert.equal(outcome.status, 'decided', out);
    const decision = calls.find((c) => c.op === 'record_decision')!;
    const items = decision.payload.inputs.items as { interpretation: Ref; choice: string; edited_statement?: string }[];
    assert.equal(items.length, fx.items.length);
    assert.deepEqual(items.map((i) => refKey(i.interpretation)), fx.items.map(refKey));
    assert.deepEqual(items.map((i) => i.choice), ['confirm', 'edit', 'reject']);
    assert.equal(items[1].edited_statement, 'deposit(0) reverts with ZeroAmount');
    // Every interpretation and its captured input were rendered and are bound by the decision.
    for (const r of [...fx.items, ...fx.caps]) assert.ok(decision.payload.reviewed.some((x: Ref) => refKey(x) === refKey(r)));
    // The captured input is shown verbatim with deceptive characters made visible.
    assert.match(out, /Fee-on-transfer⟦U\+200B[^⟧]*⟧ tokens are unsupported ⟦U\+001B[^⟧]*⟧\[31mred/);
    assert.ok(!out.includes('\x1b'));
    const store = h.ws.store(eid, true);
    assert.deepEqual(fx.items.map((r) => store.mustHead(r.record_id, 'interpretation').body.status), ['confirmed', 'edited', 'rejected']);
  }),
);

test(
  'a stale review shows what changed and offers a re-review instead of deciding',
  withHarness(async (h) => {
    const eid = 'scr-stale';
    h.auditor.do(eid, 'create_engagement', { name: 'Stale', owner: 'auditor', audit_purpose: 'test' });
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal' } }).audit_unit as Ref;
    const io = scriptedIO(['', 'Flow reviewed.', 'yes', 'q']);
    const screen = screenFor(h, eid, io);
    // An agent revises the unit after it was rendered but before the decision commits.
    const orig = screen.session.call.bind(screen.session);
    screen.session.call = ((e: string, op: string, p: unknown, o?: object) => {
      if (op === 'record_display') h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', base: unit, body: { risk_rationale: 'changed by an agent' } });
      return orig(e, op, p, o);
    }) as typeof screen.session.call;
    const outcome = await recordFlowReview(screen, unit.record_id);
    const out = io.text();
    assert.equal(outcome.status, 'refused', out);
    assert.match(out, /Refused: stale_dependency/);
    assert.match(out, /audit_unit unit-0001: you reviewed revision 1; current revision is 2/);
    assert.match(out, /Re-render the current revisions/);
    assert.match(out, /Committed: no/);
    assert.equal(h.ws.store(eid, true).heads('human_decision').length, 0);
  }),
);

test(
  'the trusted screen refuses to start without an interactive terminal or with a wrong key',
  withHarness((h) => {
    const eid = 'scr-tty';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    const key = h.ws.readSecret('auditor.key');
    assert.throws(() => openTrustedScreen({ ws: h.ws, key, io: scriptedIO([], { interactive: false }), engagement: eid }), code('permission_denied'));
    const piped = ttyIO(new PassThrough() as unknown as NodeJS.ReadStream, new PassThrough() as unknown as NodeJS.WriteStream);
    assert.equal(piped.interactive, false);
    assert.throws(() => openTrustedScreen({ ws: h.ws, key, io: piped, engagement: eid }), code('permission_denied'));
    assert.throws(() => openTrustedScreen({ ws: h.ws, key: 'not-the-key', io: scriptedIO([]), engagement: eid }), code('permission_denied'));
    // The display receipt names the screen program identity.
    const s = screenFor(h, eid, scriptedIO([]));
    assert.match(s.session.principal.screen!.identity, /^harness-trusted-screen sha256:[0-9a-f]{64}$/);
  }),
);

test('KB diagrams of the implemented model or the comparison present implemented behavior of their unit', () => {
  const unit = { record_id: 'unit-0001', revision: 2 };
  const diagram = (affiliation: string) => ({ type: 'kb_diagram', record_id: 'diag-0001', revision: 1, body: { audit_unit: unit, affiliation } }) as unknown as RecordEnvelope;
  assert.deepEqual(implementedUnitsOf(diagram('implemented')), [unit]);
  assert.deepEqual(implementedUnitsOf(diagram('comparison')), [unit]);
  assert.deepEqual(implementedUnitsOf(diagram('designed')), []);
  const log = new DisplayLog();
  log.rendered(diagram('comparison'));
  assert.deepEqual(log.toPayload().implemented_presented_for, [unit]);
});

test(
  'the trusted screen withholds IMPLEMENTED content during read-first mode and receipts it afterwards',
  withHarness((h) => {
    const eid = 'scr-rf';
    h.auditor.do(eid, 'create_engagement', { name: 'RF', owner: 'a', audit_purpose: 'p' });
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal' } }).audit_unit as Ref;
    const stmt = h.auditor.do(eid, 'submit_proposal', {
      kind: 'system_statement',
      body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'IMPL-TEXT withdraw pays first', audit_units: [unit] },
    }).statement as Ref;
    h.auditor.do(eid, 'start_read_first', {});
    const io = scriptedIO([]);
    const screen = screenFor(h, eid, io);
    const env = screen.get(stmt);
    screen.render(env);
    assert.ok(!io.text().includes('IMPL-TEXT'));
    assert.match(io.text(), /withheld: read-first mode is active/);
    assert.equal(screen.log.refs.length, 0);
    assert.deepEqual(screen.log.toPayload().implemented_presented_for, []);
    h.auditor.do(eid, 'end_read_first', {});
    screen.beginDisplay();
    screen.render(env);
    assert.match(io.text(), /IMPL-TEXT/);
    const receipt = h.screen.do(eid, 'record_display', screen.log.toPayload()).display_receipt as Ref;
    assert.deepEqual(h.ws.store(eid, true).get(receipt, 'display_receipt').body.implemented_presented_for, [unit]);
  }),
);
