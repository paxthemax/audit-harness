import { commitDecision, type DecisionKindDef, type DecisionPayload } from '../decision/framework.ts';
import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { defineOperation } from '../controller/controller.ts';
import { loadReceipt, requireRendered } from '../decision/framework.ts';
import type { EvaluationContractBody } from '../schema/records.ts';

// Evaluation contracts (design/harness-evaluation.md, "Pilot protocol" step 1; FR-25, FR-26).
//
// A pilot spans engagements, so its contract lives in the library scope. The auditor drafts it with
// `propose_evaluation_contract` and freezes it on the trusted screen with `freeze_evaluation_contract`
// before the run: target revisions, method versions, models, tools, budgets, data access, severity
// rubric, deduplication policy, labels (tuning cases kept apart from held-out cases) and the metric
// version. A frozen contract never changes; a corrected contract is a new record that supersedes it,
// and the superseded one keeps its content (only its status moves to `superseded` when the new one is
// frozen).
//
// Quantitative targets are set before the comparative run: freezing names every metric the operator
// wants compared, and each needs a target in `targets_set_before_run`. The list may be empty, but it
// must be given explicitly. This module supplies no target values.

export const EVALUATION_METRICS = [
  'resolved_candidate_precision',
  'known_defect_recall',
  'added_discovery',
  'human_effort',
  'decision_throughput',
  'review_burden',
  'replay_reliability',
  'work_coverage',
  'adequacy',
  'change_handling',
  'cost_and_latency',
  'decision_quality',
  'decision_load',
  'disposition_mix',
  'positive_control_outcomes',
  'change_carry_forward',
  'alternative_route_use',
] as const;
export type EvaluationMetric = (typeof EVALUATION_METRICS)[number];

const LABEL_KINDS = ['historical_withheld', 'seeded_fault', 'repaired_variant', 'fresh_consented'] as const;

export type ProposeContractPayload = Omit<EvaluationContractBody, 'status' | 'frozen_at'> & {
  /** Revise this draft in place (a frozen contract cannot be revised). */
  base?: Ref | null;
  /** Start a new contract that supersedes this frozen one once frozen. */
  supersedes?: Ref | null;
};

function strList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail('invalid_request', `${field} must be a list of strings`);
  return v as string[];
}

defineOperation<ProposeContractPayload>({
  name: 'propose_evaluation_contract',
  channels: ['auditor'],
  mutating: true,
  scope: 'library',
  handler(ctx, p) {
    if (!p?.name?.trim() || !p.metric_version?.trim()) fail('invalid_request', 'name and metric_version are required');
    if (!Array.isArray(p.targets_set_before_run)) {
      fail('invalid_request', 'targets_set_before_run must be given explicitly (an empty list is allowed)');
    }
    for (const t of p.targets_set_before_run) {
      if (!t || !(EVALUATION_METRICS as readonly string[]).includes(t.metric) || typeof t.target !== 'string' || !t.target.trim()) {
        fail('invalid_request', `each target names a metric from ${EVALUATION_METRICS.join(', ')} and a target`);
      }
    }
    if (!Array.isArray(p.targets) || !Array.isArray(p.labels) || !Array.isArray(p.models)) fail('invalid_request', 'targets, labels and models are lists');
    for (const t of p.targets) {
      if (!t?.engagement || !ctx.ws.hasEngagement(t.engagement)) fail('not_found', `target engagement ${String(t?.engagement)} not found`);
      if (t.snapshot) ctx.ws.store(t.engagement, true).get(t.snapshot, 'target_snapshot');
      strList(t.units, 'targets[].units');
    }
    const cases = new Set<string>();
    for (const l of p.labels) {
      if (!l?.case || cases.has(l.case)) fail('invalid_request', 'each label names a distinct case');
      cases.add(l.case);
      if (!(LABEL_KINDS as readonly string[]).includes(l.kind) || typeof l.held_out !== 'boolean') fail('invalid_request', `label ${l.case}: kind and held_out are required`);
      strList(l.reference_defects, `labels[${l.case}].reference_defects`);
    }
    const body: EvaluationContractBody = {
      name: p.name,
      targets: p.targets.map((t) => ({ engagement: t.engagement, snapshot: t.snapshot ?? null, units: t.units })),
      method_versions: strList(p.method_versions, 'method_versions'),
      models: p.models,
      tools: strList(p.tools, 'tools'),
      task_budgets: p.task_budgets ?? '',
      data_access: p.data_access ?? '',
      severity_rubric: p.severity_rubric ?? '',
      dedup_policy: p.dedup_policy ?? '',
      labels: p.labels,
      metric_version: p.metric_version,
      targets_set_before_run: p.targets_set_before_run,
      status: 'draft',
      frozen_at: null,
    };
    if (p.base) {
      const cur = ctx.store.get(p.base, 'evaluation_contract');
      if (cur.body.status !== 'draft') fail('permission_denied', `contract ${cur.record_id} is ${cur.body.status}; a frozen contract never changes — propose a superseding one`);
      return { evaluation_contract: ctx.tx.revise(cur.record_id, 'evaluation_contract', () => body, { expectedRevision: p.base.revision }) };
    }
    const deps: Ref[] = [];
    if (p.supersedes) {
      const old = ctx.store.get(p.supersedes, 'evaluation_contract');
      if (old.body.status !== 'frozen') fail('invalid_request', 'only a frozen contract is superseded; revise a draft in place');
      deps.push(p.supersedes);
    }
    return { evaluation_contract: ctx.tx.create('evaluation_contract', body, deps) };
  },
});

export interface FreezeContractPayload {
  contract: Ref;
  display_receipt: Ref;
  /** Every metric the operator wants compared; each needs a target set before the run. May be empty. */
  compared_metrics: string[];
}

/**
 * Freezing is the operator's decision on the trusted screen, recorded through the common decision
 * path: the rendered contract revision, a single-use display receipt, a rationale and its authorship.
 */
const freezeDef: DecisionKindDef = {
  kind: 'freeze_evaluation_contract',
  scope: 'library',
  check(ctx, p) {
    const i = p.inputs as { contract?: Ref; compared_metrics?: unknown };
    if (!i?.contract) fail('invalid_request', 'contract is required');
    if (!Array.isArray(i.compared_metrics)) fail('invalid_request', 'compared_metrics must be given explicitly (an empty list is allowed)');
    const compared = i.compared_metrics as string[];
    const unknownMetrics = compared.filter((m) => !(EVALUATION_METRICS as readonly string[]).includes(m));
    if (unknownMetrics.length) fail('invalid_request', 'unknown metrics', { details: { unknown: unknownMetrics } });
    if (!p.reviewed.some((r) => r.record_id === i.contract!.record_id && r.revision === i.contract!.revision)) fail('display_required', 'the contract must be rendered');
    const c = ctx.store.get(i.contract, 'evaluation_contract');
    if (c.body.status !== 'draft') fail('invalid_request', `contract is ${c.body.status}`);
    const targeted = new Set(c.body.targets_set_before_run.map((t) => t.metric));
    const missing = compared.filter((m) => !targeted.has(m));
    if (missing.length) fail('invalid_request', 'every compared metric needs a target set before the run', { details: { missing } });
  },
  apply({ ctx, payload, decision }) {
    const i = payload.inputs as { contract: Ref; compared_metrics: string[] };
    const c = ctx.store.get(i.contract, 'evaluation_contract');
    const frozen = ctx.tx.revise(c.record_id, 'evaluation_contract', (b) => ({ ...b, status: 'frozen', frozen_at: ctx.now }), {
      expectedRevision: c.revision,
      depends_on: [...c.depends_on, decision],
    });
    const superseded: Ref[] = [];
    for (const d of c.depends_on) {
      if (!('record_id' in d)) continue;
      const old = ctx.store.head<'evaluation_contract'>(d.record_id);
      if (old?.type === 'evaluation_contract' && old.body.status === 'frozen') {
        superseded.push(ctx.tx.revise(old.record_id, 'evaluation_contract', (b) => ({ ...b, status: 'superseded' })));
      }
    }
    return { evaluation_contract: frozen, compared_metrics: i.compared_metrics, superseded };
  },
};

defineOperation<Omit<DecisionPayload, 'decision_kind'>>({
  name: 'freeze_evaluation_contract',
  channels: ['screen'],
  mutating: true,
  scope: 'library',
  handler(ctx, p) {
    return commitDecision(ctx, { ...p, decision_kind: 'freeze_evaluation_contract' }, freezeDef);
  },
});
