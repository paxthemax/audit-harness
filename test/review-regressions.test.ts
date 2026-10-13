// Regression tests for the adversarial review of the walking skeleton. Each test names the finding
// it pins down; together they exercise the three invariants: agents cannot write canonical records,
// approvals bind exact revisions, and receipts come from the trusted runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, type Harness } from './helpers.ts';
import { admittedInvestigation, decide, display, head, LIMITS, stageEvidence, variantWithOutcome } from './decision-fixtures.ts';
import { stageAuthorization } from './runner-fixtures.ts';
import { Controller } from '../src/controller/controller.ts';
import { roleProfile } from '../src/controller/roles.ts';
import { commandAdapter, registerAdapter } from '../src/runner/adapters.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { RecordStore } from '../src/store/recordStore.ts';
import { withLock } from '../src/store/lock.ts';
import type { Ref } from '../src/core/refs.ts';

try {
  registerAdapter(commandAdapter({ name: 'agentcmd', version: '1', executable: '/usr/bin/true', purposes: ['agent', 'experiment', 'positive_control', 'replay'] }));
} catch {
  /* registered by another test file in this process */
}

const code = (c: string) => (e: unknown) => isHarnessError(e, c as never);

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

/** A real worker session: an agent job admitted under an authorization and dispatched (no process runs). */
function workerFor(h: Harness, eid: string, o: { kind?: 'exploration' | 'batch'; role: string; investigation?: Ref | null; investigations?: Ref[] }) {
  const store = h.ws.store(eid, true);
  const snap = store.heads('engagement')[0].body.active_snapshot!;
  const auth = stageAuthorization(h, eid, { kind: o.kind ?? 'exploration', tools: ['agentcmd'], investigations: o.investigations ?? [] });
  // Agent jobs carry a context manifest built by the context builder for their role.
  const ctxm = h.auditor.do(eid, 'build_context', { role: roleProfile(o.role).contextRole, investigation: o.investigation ? store.headRef(o.investigation.record_id) : null });
  const j = h.auditor.do(eid, 'request_job', { authorization: auth, purpose: 'agent', adapter: 'agentcmd', snapshot: store.headRef(snap.record_id), role: o.role, investigation: o.investigation ?? null, context_manifest: ctxm.context_manifest, args: {} });
  const { token, digest } = Controller.newWorkerToken();
  const started = h.runner.do(eid, 'start_attempt', { job: j.job.record_id, grant_digest: digest });
  const session = h.controller.worker(eid, token);
  // One job at a time: the runner completes this attempt (nothing ran) before another worker starts.
  (session as unknown as { done: () => void }).done = () => h.runner.do(eid, 'complete_attempt', { attempt: started.attempt.record_id, not_run: 'test worker finished' });
  return session;
}
const done = (w: unknown) => (w as { done: () => void }).done();

test(
  'C1: a worker cannot read or write another engagement',
  withHarness((h) => {
    admittedInvestigation(h, 'eng-a');
    admittedInvestigation(h, 'eng-b');
    const w = workerFor(h, 'eng-a', { role: 'comprehension' });
    assert.ok(w.do('eng-a', 'read_records', { type: 'investigation' }).records.length);
    assert.throws(() => w.do('eng-b', 'read_records', { type: 'investigation' }), code('permission_denied'));
    assert.throws(() => w.do('library', 'read_records', {}), code('permission_denied'));
  }),
);

test(
  'C3: agents cannot rewrite investigations outside their grant or reviewed coverage; content changes demote a review',
  withHarness((h) => {
    const eid = 'e1';
    const { inv, flow } = admittedInvestigation(h, eid);
    const w = workerFor(h, eid, { role: 'comprehension' });
    assert.throws(
      () => w.do(eid, 'submit_proposal', { kind: 'investigation', base: head(h, eid, inv.record_id), body: { potential_impact: 'low' } }),
      code('permission_denied'),
    );
    assert.throws(
      () => w.do(eid, 'submit_proposal', { kind: 'audit_unit', base: head(h, eid, flow.record_id), body: { functions: [{ name: 'Vault.emergencyDrain', reviewed: true }], gaps: [] } }),
      code('permission_denied'),
    );
    // The auditor may revise a reviewed unit, but a change of meaning demotes its review.
    const res = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', base: head(h, eid, flow.record_id), body: { functions: [{ name: 'Vault.withdraw', reviewed: true }, { name: 'Vault.emergencyDrain', reviewed: true }] } });
    assert.equal(res.review_status_reset, true);
    const unit = h.ws.store(eid, true).mustHead(flow.record_id, 'audit_unit');
    assert.equal(unit.body.review_status, 'partial');
    assert.ok(unit.body.functions.every((f) => !f.reviewed), 'review flags are set only by record_flow_review');
    // New units never arrive pre-reviewed.
    const u2 = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'x', functions: [{ name: 'A.f', reviewed: true }] } }).audit_unit;
    assert.equal(h.ws.store(eid, true).get(u2, 'audit_unit').body.functions[0].reviewed, false);
  }),
);

test(
  'M4/M5: agents revise only agent-written records; adequacy needs the challenger; a challenger cannot read the author narrative',
  withHarness((h) => {
    const eid = 'e2';
    const { inv } = admittedInvestigation(h, eid);
    const relayed = h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', body: { kind: 'intent', affiliation: 'designed', origin: 'auditee_statement', statement: 'withdraw pays once' } }).statement;
    const investigator = workerFor(h, eid, { kind: 'batch', role: 'investigator', investigation: inv, investigations: [inv] });
    assert.throws(
      () => investigator.do(eid, 'submit_proposal', { kind: 'system_statement', base: relayed, body: { kind: 'intent', affiliation: 'designed', origin: 'documented_claim', statement: 'withdraw may pay twice' } }),
      code('permission_denied'),
    );
    // Adequacy comes from the challenger or the auditor.
    const prop = h.auditor.do(eid, 'submit_proposal', { kind: 'property', body: { investigation: inv, check_oracle: 'sum(balances) == totalAssets', actions: ['deposit', 'withdraw'] } }).property;
    assert.throws(
      () => investigator.do(eid, 'submit_proposal', { kind: 'property', base: prop, body: { adequacy: { status: 'sufficient', reason: 'trust me', evidence: [] } } }),
      code('permission_denied'),
    );
    done(investigator);
    // The auditor's control item cannot be flipped to not_applicable by an agent.
    const ctrl = h.auditor.do(eid, 'propose_control_item', { control_id: 'C-1', title: 'Reentrancy', source: 'OWASP SCSVS', applicability: 'applicable' }).control_item;
    const comprehension = workerFor(h, eid, { role: 'comprehension' });
    assert.throws(
      () => comprehension.do(eid, 'propose_control_item', { base: ctrl, control_id: 'C-1', title: 'Reentrancy', source: 'OWASP SCSVS', applicability: 'not_applicable', applicability_reason: 'n/a' }),
      code('permission_denied'),
    );
    done(comprehension);
    // A challenger's reads exclude provisional statements and the author's packet/positions.
    h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'provisional seed' } });
    h.auditor.do(eid, 'submit_position', { investigation: inv, role: 'author', text: 'author narrative' });
    const challenger = workerFor(h, eid, { kind: 'batch', role: 'challenger', investigation: inv, investigations: [inv] });
    const seen = challenger.do(eid, 'read_records', {}).records as { type: string; body: { review_status?: string; role?: string } }[];
    assert.ok(!seen.some((r) => r.type === 'system_statement' && r.body.review_status !== 'reviewed'));
    assert.ok(!seen.some((r) => r.type === 'position' && r.body.role === 'author'));
  }),
);

test(
  'H5: the challenger position comes from a challenger, not from the author',
  withHarness((h) => {
    const eid = 'e3';
    const { inv } = admittedInvestigation(h, eid);
    variantWithOutcome(h, eid, inv.record_id, 'refuted');
    const investigator = workerFor(h, eid, { kind: 'batch', role: 'investigator', investigation: inv, investigations: [inv] });
    assert.throws(() => investigator.do(eid, 'submit_position', { investigation: inv, role: 'challenger', text: 'I, the challenger, agree' }), code('permission_denied'));
    const authorPos = investigator.do(eid, 'submit_position', { investigation: inv, role: 'author', text: 'the guard blocks it' }).position;
    // A worker cannot smuggle a challenger position in as text.
    assert.throws(
      () => investigator.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd', challenger_position: 'I agree', author_position: authorPos }),
      code('permission_denied'),
    );
    done(investigator);
    const challenger = workerFor(h, eid, { kind: 'batch', role: 'challenger', investigation: inv, investigations: [inv] });
    const chPos = challenger.do(eid, 'submit_position', { investigation: inv, role: 'challenger', text: 'the setup pranks no role', model: 'm2', provider: 'p1', initial_context_withheld: true }).position;
    done(challenger);
    const pkt = h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd', challenger_position: chPos, author_position: authorPos }).packet;
    const body = h.ws.store(eid, true).get(pkt, 'review_packet').body;
    assert.match(body.challenge_independence.context, /challenger submitted by worker:challenger/);
    assert.match(body.challenge_independence.context, /withheld/);
  }),
);

test(
  'H1/H2: positive controls are bound to the claim and its experiment; refuting evidence cannot launder into no_finding_within_bounds',
  withHarness((h) => {
    const eid = 'e4';
    const { inv } = admittedInvestigation(h, eid, { impact: 'high', method: 'hypothesis' });
    const refuting = stageEvidence(h, eid, inv.record_id, 'experiment', 'no_violation_observed');
    const bounds = { methods: ['hypothesis'], variants_tried: 'none', budget: '10 USD', attacker_charter: 'default', assumptions: [] };
    const pkt = h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd', challenger_position: 'x', author_position: 'y' }).packet;
    const invHead = head(h, eid, inv.record_id);
    const sections = ['evidence', 'challenger', 'evidence_quality', 'proposed_disposition'];
    assert.throws(() => decide(h, eid, 'dispose_investigation', [pkt, invHead], { packet: pkt, investigation: invHead, disposition: 'no_finding_within_bounds', bounds }, sections), code('evidence_requirement_unmet'));
    assert.throws(
      () => decide(h, eid, 'dispose_investigation', [pkt, invHead], { packet: pkt, investigation: invHead, disposition: 'rejected', decisive_evidence: [refuting], countercondition: 'guard', countercondition_scope: 'withdraw' }, sections),
      code('evidence_requirement_unmet'),
    );
  }),
);

test(
  'M2: a display receipt backs one decision only',
  withHarness((h) => {
    const eid = 'e5';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    const u1 = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'a' } }).audit_unit;
    const u2 = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'b' } }).audit_unit;
    void u1;
    void u2;
    const d1 = { decision_kind: 'confirm_interpretations', rationale: 'r', rationale_authorship: 'human_written' };
    const cap = h.capture.do(eid, 'capture_input', { text: 'x' }).captured_input;
    const i1 = h.auditor.do(eid, 'submit_proposal', { kind: 'interpretation', body: { captured_inputs: [cap], proposed: { kind: 'assumption', affiliation: 'shared', statement: 'a' } } }).interpretation;
    const i2 = h.auditor.do(eid, 'submit_proposal', { kind: 'interpretation', body: { captured_inputs: [cap], proposed: { kind: 'assumption', affiliation: 'shared', statement: 'b' } } }).interpretation;
    const r = display(h, eid, [i1, i2]);
    h.screen.do(eid, 'record_decision', { ...d1, display_receipt: r, reviewed: [i1], inputs: { items: [{ interpretation: i1, choice: 'confirm' }] } });
    assert.throws(() => h.screen.do(eid, 'record_decision', { ...d1, display_receipt: r, reviewed: [i2], inputs: { items: [{ interpretation: i2, choice: 'confirm' }] } }), code('display_required'));
  }),
);

test(
  'M3: after a premise revision, no new job dispatches on the old premise',
  withHarness((h) => {
    const eid = 'e6';
    const { inv } = admittedInvestigation(h, eid, { impact: 'low', executable: false, method: 'hypothesis' });
    const store = () => h.ws.store(eid, true);
    const premise = store().heads('system_statement').find((s) => s.body.origin === 'adopted_assumption')!;
    const pRef = { record_id: premise.record_id, revision: premise.revision };
    h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', base: head(h, eid, inv.record_id), body: { supporting: [pRef] } });
    const r = display(h, eid, [pRef]);
    h.screen.do(eid, 'revise_premise', { reviewed: [pRef], display_receipt: r, inputs: { statement: pRef, new_statement: 'owner not trusted' }, rationale: 'r', rationale_authorship: 'human_written' });
    assert.equal(store().mustHead(inv.record_id, 'investigation').body.work_state, 'blocked');
    const auth = store().mustHead(inv.record_id, 'investigation').body.authorization!;
    const snap = store().heads('engagement')[0].body.active_snapshot!;
    assert.throws(() => h.auditor.do(eid, 'request_job', { authorization: auth, purpose: 'experiment', adapter: 'forge_test', snapshot: store().headRef(snap.record_id), investigation: inv, args: {} }), (e) => isHarnessError(e));
  }),
);

test(
  'L11: an agent cannot lower its own potential-impact estimate',
  withHarness((h) => {
    const eid = 'e7';
    const { inv } = admittedInvestigation(h, eid, { impact: 'high' });
    const investigator = workerFor(h, eid, { kind: 'batch', role: 'investigator', investigation: inv, investigations: [inv] });
    // The investigation was proposed by the auditor (auditor estimate high); the agent raises then tries to lower.
    investigator.do(eid, 'submit_proposal', { kind: 'investigation', base: head(h, eid, inv.record_id), body: { potential_impact: 'critical' } });
    investigator.do(eid, 'submit_proposal', { kind: 'investigation', base: head(h, eid, inv.record_id), body: { potential_impact: 'low' } });
    const pi = h.ws.store(eid, true).mustHead(inv.record_id, 'investigation').body.potential_impact;
    assert.equal(pi.agent, 'critical');
    assert.equal(pi.effective, 'critical');
  }),
);

test(
  'C2: files staged but never committed are not resurrected by recovery',
  withHarness((h) => {
    const eid = 'e8';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    const dir = h.ws.engagementDir(eid);
    const env = JSON.parse(JSON.stringify(h.ws.store(eid, true).mustHead('eng-0001')));
    env.revision = 2;
    env.body.name = 'UNACKNOWLEDGED';
    mkdirSync(join(dir, 'records', 'eng-0001'), { recursive: true });
    writeFileSync(join(dir, 'records', 'eng-0001', '2.json'), JSON.stringify(env));
    execFileSync('git', ['add', 'records/eng-0001/2.json'], { cwd: dir }); // crash after `git add`, before `git commit`
    const s = RecordStore.open(dir, eid);
    assert.equal(s.mustHead('eng-0001').revision, 1);
    assert.deepEqual(s.openReport.quarantined, ['records/eng-0001/2.json']);
    // A later write commits only acknowledged state.
    h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'f' } });
    const tracked = execFileSync('git', ['ls-files', 'records/eng-0001'], { cwd: dir, encoding: 'utf8' });
    assert.doesNotMatch(tracked, /2\.json/);
  }),
);

test(
  'L4/M9/M10: idempotent create retry; refused-but-committed replays stay refused; stale git and controller locks are reclaimed',
  withHarness((h) => {
    const first = h.auditor.call('e9', 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' }, { idempotency_key: 'create-e9' });
    const again = h.auditor.call('e9', 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' }, { idempotency_key: 'create-e9' });
    assert.deepEqual(again.result, first.result);
    assert.ok(again.replayed);
    // A retained revision conflict replays as the same refusal.
    const s = h.auditor.do('e9', 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'f' } }).audit_unit;
    h.auditor.do('e9', 'submit_proposal', { kind: 'audit_unit', base: s, body: { risk_rationale: 'a' } });
    const conflicting = () => h.auditor.call('e9', 'submit_proposal', { kind: 'audit_unit', base: s, body: { risk_rationale: 'b' } }, { idempotency_key: 'k-conf' });
    assert.throws(conflicting, code('revision_conflict'));
    assert.throws(conflicting, code('revision_conflict'));
    // A leftover git index lock from a crashed process does not block writes.
    writeFileSync(join(h.ws.engagementDir('e9'), '.git', 'index.lock'), '');
    h.auditor.do('e9', 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'g' } });
    // An empty controller lock file left by a crash is reclaimed once it is old.
    writeFileSync(h.ws.lockPath, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(h.ws.lockPath, old, old);
    assert.equal(withLock(h.ws.lockPath, () => 'acquired', 3000), 'acquired');
  }),
);

void LIMITS;
