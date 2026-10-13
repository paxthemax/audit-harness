import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { defineOperation } from '../controller/controller.ts';
import type { MethodVersionBody } from '../schema/records.ts';
import { defineDecisionKind, need } from '../decision/framework.ts';
import { textOrNull } from '../decision/common.ts';

// Method versions (FR-26; loop L7; DEC-009 Q-024). Workflow, prompt, retrieval, tool and role changes
// are versioned in the cross-engagement (library) scope. Adoption is an `adopt_method_version`
// decision that follows the held-out comparison: a candidate that fails a retained case the baseline
// passes is refused. Rollback re-adopts an earlier version and never rewrites earlier audit results.
// Accepted residual risk Q-024: no hidden seeded-fault gate, sampled re-investigation or narrowing
// flag applies; a narrowing change absent from the held-out cases can pass.

/** Proposed pilot rule (not an operator decision): a stochastic comparison needs at least this many runs per case. */
export const MIN_RUNS_PER_CASE = 2;

defineOperation<{ component: MethodVersionBody['component']; name: string; version: string; description: string; content?: string | null; previous?: Ref | null }>({
  name: 'propose_method_version',
  channels: ['auditor'],
  mutating: true,
  scope: 'library',
  handler(ctx, p) {
    if (!textOrNull(p.name) || !textOrNull(p.version) || !textOrNull(p.description)) fail('invalid_request', 'name, version and description are required');
    if (p.previous) ctx.store.get(p.previous, 'method_version');
    const dup = ctx.store.heads('method_version').find((m) => m.body.name === p.name && m.body.version === p.version);
    if (dup) fail('invalid_request', `${p.name} ${p.version} already exists as ${dup.record_id}`);
    const content = p.content ? ctx.archive.put(p.content) : null;
    if (content) ctx.tx.blob(content);
    const ref = ctx.tx.create('method_version', {
      component: p.component,
      name: p.name,
      version: p.version,
      description: p.description,
      content,
      previous: p.previous ?? null,
      status: 'proposed',
      evaluation: null,
      decision: null,
    });
    return { method_version: ref };
  },
});

interface AdoptInputs {
  method_version: Ref;
  evaluation?: MethodVersionBody['evaluation'];
  /** Rollback: re-adopt this earlier version of the same method. */
  rollback?: boolean;
}

defineDecisionKind({
  kind: 'adopt_method_version',
  scope: 'library',
  check(ctx, p) {
    const i = p.inputs as unknown as AdoptInputs;
    const mv = ctx.store.get(need<Ref>(p.inputs, 'method_version'), 'method_version');
    if (!p.reviewed.some((r) => r.record_id === mv.record_id && r.revision === mv.revision)) fail('display_required', 'the method version must be rendered');
    if (i.rollback) {
      if (!['adopted', 'superseded', 'rolled_back'].includes(mv.body.status)) fail('invalid_request', 'rollback re-adopts a version that was adopted before');
      return;
    }
    if (mv.body.status !== 'proposed') fail('invalid_request', `method version is ${mv.body.status}`);
    const ev = i.evaluation;
    if (!ev || !ev.held_out || !Array.isArray(ev.held_out.cases) || !ev.held_out.cases.length || !textOrNull(ev.summary)) {
      fail('evidence_requirement_unmet', 'adoption needs the held-out comparison (cases, runs per case, baseline and candidate failures)');
    }
    if (ev.held_out.runs_per_case < MIN_RUNS_PER_CASE) {
      fail('evidence_requirement_unmet', `judge a stochastic method over at least ${MIN_RUNS_PER_CASE} runs per case`);
    }
    // The evaluation must be the controller's own held-out comparison artifact, unchanged.
    if (!ev.evidence || !ctx.archive.has(ev.evidence.artifact)) {
      fail('evidence_requirement_unmet', 'cite the held_out_comparison artifact; a hand-written evaluation is not a held-out comparison');
    }
    const doc = ctx.archive.getJson<{ format?: string; contract?: { record_id: string; revision: number } | null; evaluation?: { held_out?: unknown } }>(ev.evidence.artifact);
    if (doc.format !== 'harness.held-out/1' || !doc.contract) fail('evidence_requirement_unmet', 'the evidence is not a held-out comparison against a frozen contract');
    if (JSON.stringify(doc.evaluation?.held_out) !== JSON.stringify(ev.held_out)) {
      fail('evidence_requirement_unmet', 'the evaluation differs from the recorded held-out comparison');
    }
    const regressions = ev.held_out.candidate_failures.filter((c) => !ev.held_out.baseline_failures.includes(c));
    if (regressions.length) {
      fail('evidence_requirement_unmet', `the candidate fails retained cases the baseline passes: ${regressions.join(', ')}`, { details: { regressions } });
    }
  },
  apply({ ctx, payload, decision }) {
    const i = payload.inputs as unknown as AdoptInputs;
    const mv = ctx.store.get(i.method_version, 'method_version');
    for (const other of ctx.store.heads('method_version')) {
      if (other.record_id !== mv.record_id && other.body.name === mv.body.name && other.body.status === 'adopted') {
        ctx.tx.revise(other.record_id, 'method_version', (b) => ({ ...b, status: i.rollback ? 'rolled_back' : 'superseded' }));
      }
    }
    const ref = ctx.tx.revise(mv.record_id, 'method_version', (b) => ({
      ...b,
      status: 'adopted',
      evaluation: i.rollback ? b.evaluation : (i.evaluation ?? null),
      decision,
    }));
    return { method_version: ref, rollback: !!i.rollback };
  },
});

/** The currently adopted version of a named method, if any. */
export function adoptedMethod(store: import('../store/recordStore.ts').RecordStore, name: string) {
  return store.heads('method_version').find((m) => m.body.name === name && m.body.status === 'adopted');
}
