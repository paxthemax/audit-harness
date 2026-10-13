import { fail } from '../core/errors.ts';
import { defineOperation } from '../controller/controller.ts';
import type { EvaluationContractBody, MethodVersionBody } from '../schema/records.ts';

// Held-out comparison for method changes (FR-26; DEC-009, Q-024; design/harness-evaluation.md,
// "Adoption and controlled improvement"). Produces exactly the `evaluation` shape that the
// `adopt_method_version` decision consumes (src/method/methods.ts).
//
// Judging over runs: a stochastic model runs each case several times. A side fails a case when at
// least half of its runs fail (a tie counts as a failure, so an unstable case never counts as a
// pass). `runs_per_case` is the smallest run count over the cases. The per-case spread (failed runs
// out of runs, for each side) is reported beside the verdict rather than a single result.
//
// Tuning cases are kept apart: a case labelled `held_out: false` (in the input or in the frozen
// contract's labels) is refused in the held-out set.
//
// Suppressed lead classes (accepted residual risk Q-024): `suppressedLeadClasses` reports every lead
// class whose count drops under the candidate. It is a measurement for the evaluation report and
// never a gate on adoption.

export const MAJORITY_RULE = 'a side fails a case when at least half of its runs fail (ties count as failures)';

export interface HeldOutInput {
  cases: { case: string; held_out: boolean; runs: { baseline: 'pass' | 'fail'; candidate: 'pass' | 'fail' }[] }[];
  summary?: string;
}

export interface HeldOutResult {
  evaluation: NonNullable<MethodVersionBody['evaluation']>;
  rule: string;
  spread: { case: string; runs: number; baseline_failed_runs: number; candidate_failed_runs: number }[];
  regressions: string[];
}

export function heldOutComparison(input: HeldOutInput, contract?: Pick<EvaluationContractBody, 'labels'> | null): HeldOutResult {
  if (!input || !Array.isArray(input.cases) || !input.cases.length) fail('invalid_request', 'the held-out comparison needs at least one case');
  const labels = new Map((contract?.labels ?? []).map((l) => [l.case, l]));
  const seen = new Set<string>();
  const spread: HeldOutResult['spread'] = [];
  const baseline: string[] = [];
  const candidate: string[] = [];
  for (const c of input.cases) {
    if (!c?.case || seen.has(c.case)) fail('invalid_request', 'cases must be named and distinct');
    seen.add(c.case);
    if (c.held_out !== true) fail('invalid_request', `case ${c.case} is a tuning case; tuning cases are kept out of the held-out set`);
    const label = labels.get(c.case);
    if (contract && !label) fail('invalid_request', `case ${c.case} is not labelled in the frozen contract`);
    if (label && !label.held_out) fail('invalid_request', `case ${c.case} is labelled as a tuning case in the contract`);
    if (!Array.isArray(c.runs) || !c.runs.length) fail('invalid_request', `case ${c.case} has no runs`);
    for (const r of c.runs) {
      if (!['pass', 'fail'].includes(r?.baseline) || !['pass', 'fail'].includes(r?.candidate)) fail('invalid_request', `case ${c.case}: each run is pass or fail for both sides`);
    }
    const bf = c.runs.filter((r) => r.baseline === 'fail').length;
    const cf = c.runs.filter((r) => r.candidate === 'fail').length;
    spread.push({ case: c.case, runs: c.runs.length, baseline_failed_runs: bf, candidate_failed_runs: cf });
    if (bf * 2 >= c.runs.length) baseline.push(c.case);
    if (cf * 2 >= c.runs.length) candidate.push(c.case);
  }
  const runsPerCase = Math.min(...spread.map((s) => s.runs));
  const regressions = candidate.filter((c) => !baseline.includes(c));
  const summary =
    input.summary?.trim() ||
    `${spread.length} held-out cases, ${runsPerCase}+ runs each; baseline fails ${baseline.length}, candidate fails ${candidate.length}; regressions: ${regressions.join(', ') || 'none'} (${MAJORITY_RULE})`;
  return {
    evaluation: {
      summary,
      evidence: null,
      held_out: { cases: spread.map((s) => s.case), runs_per_case: runsPerCase, baseline_failures: baseline, candidate_failures: candidate },
    },
    rule: MAJORITY_RULE,
    spread,
    regressions,
  };
}

export interface SuppressedClass {
  class: string;
  baseline: number;
  candidate: number;
  drop: number;
}

/** Lead classes whose count drops under the candidate (Q-024 measurement; never a gate). */
export function suppressedLeadClasses(baseline: Record<string, number>, candidate: Record<string, number>): { classes: SuppressedClass[]; note: string } {
  const classes: SuppressedClass[] = [];
  for (const k of [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort()) {
    const b = baseline[k] ?? 0;
    const c = candidate[k] ?? 0;
    if (c < b) classes.push({ class: k, baseline: b, candidate: c, drop: b - c });
  }
  return {
    classes,
    note: 'Measurement of accepted residual risk Q-024: a drop is reported, never used to refuse adoption.',
  };
}

export interface HeldOutPayload extends HeldOutInput {
  /** Frozen evaluation contract whose labels the cases must match. */
  contract?: { record_id: string; revision: number } | null;
  lead_classes?: { baseline: Record<string, number>; candidate: Record<string, number> } | null;
}

defineOperation<HeldOutPayload>({
  name: 'held_out_comparison',
  channels: ['auditor'],
  mutating: true,
  scope: 'library',
  handler(ctx, p) {
    // The held-out set is fixed by a frozen contract: held_out is never self-asserted, and every
    // held-out case of the contract is compared (no cherry-picking).
    if (!p?.contract) fail('invalid_request', 'name the frozen evaluation contract whose held-out cases are compared');
    const contract: EvaluationContractBody = ctx.store.get(p.contract, 'evaluation_contract').body;
    if (contract.status !== 'frozen') fail('invalid_request', 'compare against a frozen evaluation contract');
    const given = new Set((p.cases ?? []).map((c) => c.case));
    const missing = contract.labels.filter((l) => l.held_out && !given.has(l.case)).map((l) => l.case);
    if (missing.length) fail('invalid_request', `the comparison omits held-out cases of the contract: ${missing.join(', ')}`);
    const res = heldOutComparison(p, contract);
    const suppressed = p.lead_classes ? suppressedLeadClasses(p.lead_classes.baseline ?? {}, p.lead_classes.candidate ?? {}) : null;
    // The full comparison (with spread and the Q-024 measurement) is the evaluation's evidence.
    const evidence = ctx.archive.putJson({ format: 'harness.held-out/1', contract: p.contract ?? null, ...res, suppressed_lead_classes: suppressed });
    ctx.tx.blob(evidence);
    ctx.tx.event('held_out_comparison', { evidence: evidence.artifact });
    return { ...res, evaluation: { ...res.evaluation, evidence }, suppressed_lead_classes: suppressed };
  },
});
