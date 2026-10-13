import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, type Harness } from './helpers.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { acceptPolicy, admittedInvestigation, decide, display, head, LIMITS } from './decision-fixtures.ts';
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

test(
  'FR-30: a changed transition marks its diagram affected; regeneration shows a semantic delta and grants no re-review',
  withHarness((h) => {
    const eid = 'c1';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal' } }).audit_unit;
    const t1 = h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'Requested -> Paid on withdraw()' } }).statement;
    const t2 = h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'Paid -> Cleared after transfer' } }).statement;
    const d = h.auditor.do(eid, 'propose_kb_diagram', { audit_unit: unit, lens: 'transitions', affiliation: 'implemented', source: 'stateDiagram-v2\n  Requested --> Paid\n  Paid --> Cleared', statements: [t1, t2] }).diagram;
    assert.equal(h.auditor.do(eid, 'diagram_status', { diagram: d.record_id }).status, 'current');
    const t1b = h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', base: t1, body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'Requested -> Paid only when not paused' } }).statement;
    const st = h.auditor.do(eid, 'diagram_status', { diagram: d.record_id });
    assert.equal(st.status, 'affected');
    assert.deepEqual(st.changed.map((r: Ref) => r.record_id), [t1.record_id]);
    const regen = h.auditor.do(eid, 'propose_kb_diagram', { base: d, audit_unit: unit, lens: 'transitions', affiliation: 'implemented', source: 'stateDiagram-v2\n  Requested --> Paid: not paused', statements: [t1b] });
    assert.deepEqual(regen.semantic_delta.removed, [t2.record_id]);
    assert.equal(regen.semantic_delta.changed.length, 1);
    assert.equal(h.ws.store(eid, true).mustHead(d.record_id, 'kb_diagram').body.review_status, 'provisional');
  }),
);

test(
  'FR-31: an exploration resumed after a change shows what changed; a skipped checkpoint records no mastery or failure',
  withHarness((h) => {
    const eid = 'c2';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    acceptPolicy(h, eid);
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'deposit' } }).audit_unit;
    const s = h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'deposit mints shares', audit_units: [unit] } }).statement;
    const r = display(h, eid, [unit]);
    const auth = h.screen.do(eid, 'authorize_work', {
      reviewed: [unit],
      display_receipt: r,
      inputs: { kind: 'exploration', audit_units: [unit], capabilities: { tools: [], providers: [], network: 'denied' }, limits: LIMITS },
      rationale: 'explore deposit',
      rationale_authorship: 'human_written',
    }).work_authorization;
    const ex = h.auditor.do(eid, 'start_exploration', { audit_units: [unit], lens: 'flows', authorization: auth }).exploration;
    h.auditor.do(eid, 'record_exploration_round', { exploration: ex.record_id, seen: [s], end: true, checkpoints: [{ id: 'cp1', prompt: 'Who receives the shares?' }] });
    h.auditor.do(eid, 'exploration_checkpoint', { exploration: ex.record_id, checkpoint: 'cp1', action: 'skip' });
    // The exploration start counts as a presentation of the unit (intent timing boundary).
    const cap = h.capture.do(eid, 'capture_input', { text: 'Shares go to the receiver argument.' }).captured_input;
    // A premise changes while paused.
    h.auditor.do(eid, 'submit_proposal', { kind: 'system_statement', base: s, body: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'deposit mints shares to receiver', audit_units: [unit] } });
    const resumed = h.auditor.do(eid, 'resume_exploration', { exploration: ex.record_id });
    assert.deepEqual(resumed.changes.changed.map((c: { ref: Ref }) => c.ref.record_id), [s.record_id]);
    const body = h.ws.store(eid, true).mustHead(ex.record_id, 'exploration').body;
    assert.equal(body.checkpoints[0].status, 'skipped');
    assert.equal(body.rounds.length, 2);
    const interp = h.auditor.do(eid, 'submit_proposal', { kind: 'interpretation', body: { captured_inputs: [cap], proposed: { kind: 'intent', affiliation: 'designed', statement: 'shares go to receiver', audit_units: [unit] } } }).interpretation;
    const res = decide(h, eid, 'confirm_interpretations', [interp], { items: [{ interpretation: interp, choice: 'confirm' }] });
    assert.equal(h.ws.store(eid, true).get(res.items[0].statement, 'system_statement').body.intent_timing, 'after_walkthrough');
  }),
);

test(
  'FR-14: grouping preserves every origin and dissent; a chain becomes its own investigable claim; consolidation is reversible',
  withHarness((h) => {
    const eid = 'c3';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal' } }).audit_unit;
    const a = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'hypothesis', question: 'reentrancy in withdraw', audit_units: [unit], lead_generator: 'attack_vector_sweep' } }).investigation;
    const b = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'hypothesis', question: 'state updated after external call', audit_units: [unit], lead_generator: 'tool_signal' } }).investigation;
    const g = h.auditor.do(eid, 'propose_lead_group', { relation: 'shared_cause', members: [a, b], proposed_cause: 'CEI violation in withdraw', dissent: ['tool signal may also cover sweep()'] });
    const group = h.ws.store(eid, true).get(g.lead_group, 'lead_group');
    assert.deepEqual(group.body.origins.map((o) => o.lead_generator).sort(), ['attack_vector_sweep', 'tool_signal']);
    const chain = h.auditor.do(eid, 'propose_lead_group', { relation: 'chain', members: [a, b], proposed_cause: 'reentrancy then stale balance', chain_question: 'Does reentrancy plus the stale balance drain the vault?' });
    assert.equal(h.ws.store(eid, true).get(chain.chain_investigation, 'investigation').body.work_state, 'proposed');
    h.auditor.do(eid, 'consolidate_leads', { lead_group: g.lead_group, status: 'confirmed', reason: 'same root cause' });
    h.auditor.do(eid, 'consolidate_leads', { lead_group: head(h, eid, g.lead_group.record_id), status: 'dissolved', reason: 'different guards' });
    assert.equal(h.ws.store(eid, true).heads('investigation').length, 3); // nothing deleted
  }),
);

test(
  'FR-28 and FR-37: controls without evidence are open gaps; rounding rows name who benefits',
  withHarness((h) => {
    const eid = 'c4';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'share conversion' } }).audit_unit;
    const c = h.auditor.do(eid, 'propose_control_item', { control_id: 'SCSVS-ARCH-1', title: 'Reentrancy protections', source: 'OWASP SCSVS', applicability: 'applicable' });
    assert.equal(c.status, 'open_gap');
    assert.throws(() => h.auditor.do(eid, 'propose_control_item', { control_id: 'X', title: 'Oracle', source: 'OWASP SCSVS', applicability: 'not_applicable' }), code('invalid_request'));
    assert.throws(
      () => h.auditor.do(eid, 'propose_accounting_view', { audit_unit: unit, rounding: [{ operation: 'shares = assets * supply / total', anchor: null, direction: 'down', beneficiary: '' }] }),
      code('invalid_request'),
    );
    const v = h.auditor.do(eid, 'propose_accounting_view', {
      audit_unit: unit,
      conservation: [{ relation: 'sum(balances) == totalAssets', anchors: [] }],
      units: [{ store: 'totalAssets', unit: 'asset wei', decimals: 18 }],
      rounding: [{ operation: 'convertToShares', anchor: null, direction: 'down', beneficiary: 'vault (existing holders)' }],
    });
    assert.ok(v.accounting_view);
  }),
);

test(
  'FR-26: a method change that fails a retained case is refused; adoption follows the held-out comparison and can be rolled back',
  withHarness((h) => {
    const lib = 'library';
    // A frozen evaluation contract fixes the held-out cases (they are never self-asserted).
    const contract = h.auditor.do(lib, 'propose_evaluation_contract', {
      name: 'prompt comparison',
      targets: [],
      method_versions: [],
      models: [],
      tools: [],
      task_budgets: 'fixed',
      data_access: 'consented code only',
      severity_rubric: 'engagement rubric v1',
      dedup_policy: 'root cause',
      labels: ['c1', 'c2', 'c3'].map((c) => ({ case: c, kind: 'seeded_fault', held_out: true, reference_defects: [] })),
      metric_version: 'evaluation/1',
      targets_set_before_run: [],
    }).evaluation_contract as Ref;
    h.screen.do(lib, 'freeze_evaluation_contract', { reviewed: [contract], display_receipt: display(h, lib, [contract]), inputs: { contract, compared_metrics: [] }, rationale: 'freeze before the run', rationale_authorship: 'human_written' });
    const frozen = head(h, lib, contract.record_id);
    const runs = (baseline: string[], candidate: string[]) =>
      ['c1', 'c2', 'c3'].map((c) => ({ case: c, held_out: true, runs: [0, 1, 2].map(() => ({ baseline: baseline.includes(c) ? 'fail' : 'pass', candidate: candidate.includes(c) ? 'fail' : 'pass' })) }));
    const compare = (candidateFailures: string[]) => h.auditor.do(lib, 'held_out_comparison', { contract: frozen, cases: runs(['c3'], candidateFailures) }).evaluation;
    // A comparison that omits a held-out case is refused (no cherry-picking).
    assert.throws(() => h.auditor.do(lib, 'held_out_comparison', { contract: frozen, cases: runs(['c3'], []).slice(0, 2) }), code('invalid_request'));
    const v1 = h.auditor.do(lib, 'propose_method_version', { component: 'prompt', name: 'investigator-prompt', version: '1', description: 'baseline' }).method_version;
    const adopt = (mv: Ref, inputs: Record<string, unknown>) => {
      const r = display(h, lib, [mv]);
      return h.screen.do(lib, 'record_decision', { decision_kind: 'adopt_method_version', reviewed: [mv], display_receipt: r, inputs: { method_version: mv, ...inputs }, rationale: 'r', rationale_authorship: 'human_written' });
    };
    // A hand-written evaluation is not a held-out comparison.
    assert.throws(() => adopt(v1, { evaluation: { summary: 's', evidence: null, held_out: { cases: ['c1', 'c2', 'c3'], runs_per_case: 3, baseline_failures: ['c3'], candidate_failures: ['c3'] } } }), code('evidence_requirement_unmet'));
    adopt(v1, { evaluation: compare(['c3']) });
    const v2 = h.auditor.do(lib, 'propose_method_version', { component: 'prompt', name: 'investigator-prompt', version: '2', description: 'narrower checks', previous: head(h, lib, v1.record_id) }).method_version;
    // Fails retained case c1 that the baseline passes: refused.
    assert.throws(() => adopt(v2, { evaluation: compare(['c1']) }), code('evidence_requirement_unmet'));
    adopt(v2, { evaluation: compare([]) });
    const store = () => h.ws.store(lib, true);
    assert.equal(store().mustHead(v1.record_id, 'method_version').body.status, 'superseded');
    adopt(head(h, lib, v1.record_id), { rollback: true });
    assert.equal(store().mustHead(v1.record_id, 'method_version').body.status, 'adopted');
    assert.equal(store().mustHead(v2.record_id, 'method_version').body.status, 'rolled_back');
  }),
);

test(
  'FR-25/NFR-15: metrics count decisions per kind and day with a metric version; unresolved work stays in the denominator',
  withHarness((h) => {
    const eid = 'c5';
    admittedInvestigation(h, eid);
    const m = h.auditor.do(eid, 'engagement_metrics');
    assert.equal(m.metric_version, 'metrics/1');
    assert.ok(m.decision_load.by_kind.accept_scope_and_policy >= 1);
    assert.ok(m.decision_load.by_kind.authorize_work >= 1);
    assert.equal(m.investigations.unresolved, 1);
    assert.equal(m.investigations.by_work_state.queued, 1);
  }),
);
