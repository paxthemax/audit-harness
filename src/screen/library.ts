import { HarnessError } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import type { MethodVersionBody, RecordEnvelope } from '../schema/records.ts';
import { choose, confirmWord, heading, page, show } from './io.ts';
import type { DecisionOutcome, TrustedScreen } from './screen.ts';

// Library-scope screens: freezing an evaluation contract before any run (harness-evaluation.md;
// DEC-009 Q-024) and adopting a method version on its held-out comparison (`adopt_method_version`).
// Both render the exact revision they bind and record a display receipt first.

const refOf = (e: RecordEnvelope): Ref => ({ record_id: e.record_id, revision: e.revision });

export type FreezeOutcome = { status: 'frozen'; result: Record<string, unknown> } | { status: 'refused'; error: HarnessError } | { status: 'cancelled' };

/** Render a draft evaluation contract, choose each compared metric individually, then freeze it. */
export async function freezeEvaluationContract(screen: TrustedScreen, contractId: string): Promise<FreezeOutcome> {
  screen.beginDisplay();
  const c = screen.head<'evaluation_contract'>(contractId);
  screen.banner(`Freeze evaluation contract ${c.record_id}@${c.revision} (${c.body.status})`);
  screen.render(c);
  screen.log.opened('contract');
  if (c.body.status !== 'draft') {
    screen.io.write(`Only a draft contract can be frozen; this one is ${c.body.status}. A frozen contract never changes.\n`);
    return { status: 'cancelled' };
  }
  const lines = JSON.stringify(c.body, null, 2).split('\n');
  if ((await choose(screen.io, 'Contract', [{ key: 'p', value: 'p', label: 'page the full contract' }, { key: 'n', value: 'n', label: 'continue' }])) === 'p') {
    await page(screen.io, lines, `evaluation_contract ${c.record_id}@${c.revision}`);
  }
  heading(screen.io, 'Metrics to compare (each needs a target set before the run)');
  const compared: string[] = [];
  if (!c.body.targets_set_before_run.length) screen.io.write('  No target was set before the run: no metric can be compared (an empty list is allowed).\n');
  for (const t of c.body.targets_set_before_run) {
    show(screen.io, `  ${t.metric}: target ${t.target}\n`);
    if ((await choose(screen.io, `Compare ${t.metric}?`, [{ key: 'y', value: 'y', label: 'compare' }, { key: 'n', value: 'n', label: 'report only' }])) === 'y') compared.push(t.metric);
  }
  screen.log.opened('compared_metrics');
  show(screen.io, `Compared metrics: ${compared.join(', ') || 'none'}\n`);
  if (!(await confirmWord(screen.io, 'Freeze this contract? It can then only be superseded.'))) {
    screen.io.write('Cancelled. Nothing was recorded.\n');
    return { status: 'cancelled' };
  }
  const rationale = await screen.collectRationale(null);
  try {
    const receipt = screen.session.do(screen.engagement, 'record_display', screen.log.toPayload()).display_receipt as Ref;
    const r = screen.session.do(screen.engagement, 'freeze_evaluation_contract', {
      reviewed: [refOf(c)],
      display_receipt: receipt,
      inputs: { contract: refOf(c), compared_metrics: compared },
      rationale: rationale.rationale,
      rationale_authorship: rationale.authorship,
      agent_draft: rationale.agent_draft,
    });
    heading(screen.io, 'Contract frozen');
    show(screen.io, `${JSON.stringify(r)}\n`);
    return { status: 'frozen', result: r };
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    screen.explain(e);
    return { status: 'refused', error: e };
  }
}

/** Accept a held_out_comparison result (`{evaluation: …}`) or the evaluation object itself. */
export function evaluationOf(v: unknown): MethodVersionBody['evaluation'] {
  const o = v as { evaluation?: unknown } | null;
  return ((o && typeof o === 'object' && 'evaluation' in o ? o.evaluation : o) ?? null) as MethodVersionBody['evaluation'];
}

/** Render a method version and its held-out comparison, then decide `adopt_method_version`. */
export async function adoptMethodVersion(screen: TrustedScreen, methodId: string, evaluation: MethodVersionBody['evaluation'], rollback = false): Promise<DecisionOutcome> {
  for (;;) {
    screen.beginDisplay();
    const mv = screen.head<'method_version'>(methodId);
    screen.banner(`${rollback ? 'Roll back to' : 'Adopt'} method version ${mv.record_id}@${mv.revision}`);
    screen.render(mv);
    screen.log.opened('method_version');
    if (mv.body.content && (await choose(screen.io, 'Content', [{ key: 'p', value: 'p', label: 'page the version content' }, { key: 'n', value: 'n', label: 'continue' }])) === 'p') {
      await screen.pageArtifact(mv.body.content.artifact);
    }
    heading(screen.io, 'Held-out comparison');
    if (!evaluation) screen.io.write(rollback ? '  (rollback: no new comparison needed)\n' : '  MISSING: adoption needs the held-out comparison (--evaluation file); the controller will refuse.\n');
    else {
      const h = evaluation.held_out;
      const regressions = h.candidate_failures.filter((c) => !h.baseline_failures.includes(c));
      show(
        screen.io,
        [
          `  Summary: ${evaluation.summary}`,
          `  Cases: ${h.cases.length}; runs per case: ${h.runs_per_case}`,
          `  Baseline failures: ${h.baseline_failures.join(', ') || 'none'}`,
          `  Candidate failures: ${h.candidate_failures.join(', ') || 'none'}`,
          `  Regressions (candidate fails where baseline passes): ${regressions.join(', ') || 'none'}`,
          `  Evidence: ${evaluation.evidence?.artifact ?? 'none'}`,
          '  Accepted residual risk Q-024: a change that suppresses a lead class absent from the held-out cases may go undetected.',
        ].join('\n') + '\n',
      );
    }
    screen.log.opened('held_out');
    const o = await screen.decide({
      operation: 'record_decision',
      decision_kind: 'adopt_method_version',
      reviewed: [refOf(mv)],
      inputs: { method_version: refOf(mv), ...(evaluation ? { evaluation } : {}), ...(rollback ? { rollback: true } : {}) },
      agent_draft: null,
      summary: [`${rollback ? 'Roll back to' : 'Adopt'} ${mv.body.name} ${mv.body.version} (${mv.body.component})`],
    });
    if (!(await screen.offerRereview(o))) return o;
  }
}
