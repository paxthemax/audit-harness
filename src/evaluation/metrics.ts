import { latestFreshness } from '../metrics/metrics.ts';
import { fail } from '../core/errors.ts';
import { refKey, type Ref } from '../core/refs.ts';
import { isHighOrCritical, isMediumOrAbove, POTENTIAL_IMPACTS, type PotentialImpact } from '../core/values.ts';
import { defineOperation } from '../controller/controller.ts';
import { failedAttempts } from '../decision/packets.ts';
import type { EvaluationContractBody, RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { refOf } from '../report/derive.ts';
import { EVALUATION_METRICS } from './contract.ts';

// The pilot metrics table (design/harness-evaluation.md, "Metrics and denominators"; FR-25, NFR-14,
// NFR-15). Every metric is computed from records, per engagement, with raw counts and denominators.
// A zero denominator is `not_applicable`, never 0% or 100%. Nothing here is a security score: work
// coverage shows review statuses and never infers "percent secure"; inspection depth is reported
// beside decision quality and is never an approval signal; the Q-024 suppressed-lead-class
// measurement is reported by the held-out comparison, not used as a gate.
//
// Metrics that need material outside the engagement records (a baseline finding set for added
// discovery, the labels of seeded premise changes for change handling) are reported as
// `not_computable` with the reason, rather than estimated.

export const EVALUATION_METRIC_VERSION = 'evaluation/1';

export interface Ratio {
  numerator: number;
  denominator: number;
  value: number | 'not_applicable';
}

export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator === 0 ? 'not_applicable' : Number((numerator / denominator).toFixed(4)) };
}

function sumRatios(rs: Ratio[]): Ratio {
  return ratio(
    rs.reduce((n, r) => n + r.numerator, 0),
    rs.reduce((n, r) => n + r.denominator, 0),
  );
}

const minutes = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 60000);
const round = (n: number) => Number(n.toFixed(2));
const inc = (o: Record<string, number>, k: string, n = 1) => {
  o[k] = (o[k] ?? 0) + n;
};

/** Decision kinds by workflow stage (for active minutes by stage). */
const STAGE_OF: Record<string, string> = {
  accept_scope_and_policy: 'intake',
  authorize_work: 'intake',
  answer_clarification: 'comprehension',
  confirm_interpretations: 'comprehension',
  record_flow_review: 'comprehension',
  approve_semantics: 'semantic_specification',
  revise_premise: 'semantic_specification',
  dispose_investigation: 'validation',
  attest_carry_forward: 'change_review',
  reaffirm: 'change_review',
  assess_fix: 'fix_review',
  approve_export: 'reporting',
  close_engagement: 'reporting',
  retention_action: 'reporting',
  choose_import_destination: 'reporting',
  record_transfer: 'learning',
  adopt_method_version: 'learning',
};

/** Total minutes covered by intervals, merging overlaps so multitasking is not double-counted. */
function mergedMinutes(intervals: [number, number][]): number {
  const s = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total / 60000;
}

interface Candidate {
  investigation: RecordEnvelope<'investigation'>;
  claim: string | null;
  impact: PotentialImpact;
  disposition: string | null;
  executable: boolean;
  positive_control: string;
}

function candidates(store: RecordStore, exclude: Set<string> = new Set()): Candidate[] {
  const out: Candidate[] = [];
  for (const inv of store.heads('investigation')) {
    if (exclude.has(inv.record_id)) continue;
    out.push({
      investigation: inv,
      claim: null,
      impact: inv.body.potential_impact.effective,
      disposition: inv.body.disposition?.value ?? null,
      executable: inv.body.executable,
      positive_control: inv.body.proof_status.positive_control,
    });
    for (const c of inv.body.linked_claims) {
      out.push({
        investigation: inv,
        claim: c.id,
        impact: c.potential_impact.effective,
        disposition: c.disposition?.value ?? null,
        executable: inv.body.executable,
        positive_control: c.proof_status.positive_control,
      });
    }
  }
  return out;
}

export interface DefectMatch {
  case: string;
  reference_defect: string;
  engagement: string;
  finding: Ref;
}

export interface CanaryView {
  engagement: string;
  /** The seeded packet; its investigation is excluded from output metrics (NFR-13). */
  packet?: Ref;
  kind: string;
  outcome: { decision: Ref; disposition: string; caught: boolean } | null;
}

export function engagementEvaluation(store: RecordStore, canaries: CanaryView[], now: string, targets: EvaluationContractBody['targets_set_before_run']) {
  // Canary packets are seeded test material: they measure decision quality and never count as output.
  const canaryInvestigations = new Set(
    canaries
      .filter((c) => c.engagement === store.scope && c.packet)
      .map((c) => store.tryGet<'review_packet'>(c.packet!)?.body.investigation.record_id)
      .filter((x): x is string => !!x),
  );
  const eng = store.heads('engagement')[0];
  const policy = eng?.body.policy ?? null;
  const cands = candidates(store, canaryInvestigations);
  const decisions = store.heads('human_decision');
  const receipts = store.heads('display_receipt').filter((r) => r.created_by.channel === 'screen');
  const findings = store.heads('finding');
  const accepted = findings.filter((f) => {
    const inv = store.head<'investigation'>(f.body.investigation.record_id);
    if (!inv) return false;
    const d = f.body.linked_claim_id === null ? inv.body.disposition : inv.body.linked_claims.find((c) => c.id === f.body.linked_claim_id)?.disposition;
    return d?.value === 'accepted';
  });
  const target = (m: string) => targets.find((t) => t.metric === m)?.target ?? null;

  // --- Resolved-candidate precision ---------------------------------------------------------------
  // Distinct causes: members of a confirmed duplicate group beyond the first count as duplicates.
  const duplicateOf = new Set<string>();
  for (const g of store.heads('lead_group')) {
    if (g.body.relation !== 'duplicate' || g.body.status !== 'confirmed') continue;
    for (const m of g.body.members.slice(1)) duplicateOf.add(m.record_id);
  }
  const excludedUnits = new Set(store.heads('audit_unit').filter((u) => u.body.review_status === 'excluded').map((u) => u.record_id));
  const count: Record<string, number> = {};
  for (const c of cands) {
    const dup = c.claim === null && duplicateOf.has(c.investigation.record_id);
    const outOfScope = c.investigation.body.audit_units.length > 0 && c.investigation.body.audit_units.every((u) => excludedUnits.has(u.record_id));
    if (dup) inc(count, 'duplicates');
    else if (outOfScope) inc(count, 'out_of_scope');
    else inc(count, c.disposition ?? 'no_disposition');
  }
  const acc = count.accepted ?? 0;
  const rej = count.rejected ?? 0;
  const disposed = cands.filter((c) => c.disposition !== null).length;
  const precision = {
    value: ratio(acc, acc + rej),
    distinct_accepted: acc,
    distinct_rejected: rej,
    duplicates: count.duplicates ?? 0,
    out_of_scope: count.out_of_scope ?? 0,
    deferred: count.deferred ?? 0,
    disputed: count.disputed ?? 0,
    triaged_out: count.triaged_out ?? 0,
    no_finding_within_bounds: count.no_finding_within_bounds ?? 0,
    unresolved_no_disposition: count.no_disposition ?? 0,
    adjudication_completeness: ratio(disposed, cands.length),
    note: 'Deferred, disputed, triaged_out and no_finding_within_bounds are neither rejected invalid causes nor automatic negatives.',
    target: target('resolved_candidate_precision'),
  };

  // --- Human effort and decision load --------------------------------------------------------------
  const decisionByReceipt = new Map<string, RecordEnvelope<'human_decision'>>();
  for (const d of decisions) decisionByReceipt.set(d.body.display_receipt.record_id, d);
  const byKind: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  const intervals: [number, number][] = [];
  const minutesByDay: Record<string, number> = {};
  for (const r of receipts) {
    const a = Date.parse(r.body.started_at);
    const b = Date.parse(r.body.ended_at);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
    intervals.push([a, b]);
    const m = (b - a) / 60000;
    const d = decisionByReceipt.get(r.record_id);
    const kind = d?.body.kind ?? 'unattributed';
    inc(byKind, kind, m);
    inc(byStage, d ? (STAGE_OF[kind] ?? 'other') : 'unattributed', m);
    inc(minutesByDay, r.body.started_at.slice(0, 10), m);
  }
  const activeMinutes = mergedMinutes(intervals);
  const roundAll = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));
  const humanEffort = {
    active_minutes: round(activeMinutes),
    by_decision_kind: roundAll(byKind),
    by_stage: roundAll(byStage),
    receipts: receipts.length,
    note: 'Overlapping display intervals are merged (no double-counting). Interruptions and work outside the trusted screen are not recorded.',
  };
  const loadByDay: Record<string, Record<string, number>> = {};
  for (const d of decisions) {
    const day = d.body.decided_at.slice(0, 10);
    loadByDay[day] ??= {};
    inc(loadByDay[day], d.body.kind);
  }
  const ceiling = policy?.capacity.decisions_per_day ?? null;
  const decisionLoad = {
    by_engagement_day: loadByDay,
    active_minutes_by_day: roundAll(minutesByDay),
    ceiling_per_day: ceiling,
    days_over_ceiling:
      ceiling === null ? [] : Object.entries(loadByDay).filter(([, k]) => Object.values(k).reduce((a, b) => a + b, 0) > ceiling).map(([d]) => d),
    target: target('decision_load'),
  };

  // --- Throughput and review burden -----------------------------------------------------------------
  const terminal = ['accepted', 'rejected', 'no_finding_within_bounds', 'triaged_out'];
  const resolvedQuestions = cands.filter((c) => c.disposition !== null && terminal.includes(c.disposition)).length + store.heads('clarification').filter((c) => c.body.status === 'answered').length;
  const hours = activeMinutes / 60;
  const throughput = {
    accepted_findings_per_active_hour: ratio(accepted.length, round(hours)),
    resolved_questions_per_active_hour: ratio(resolvedQuestions, round(hours)),
    accepted_by_impact: Object.fromEntries(POTENTIAL_IMPACTS.map((i) => [i, accepted.filter((f) => store.head<'investigation'>(f.body.investigation.record_id)?.body.potential_impact.effective === i).length])),
    unresolved: cands.filter((c) => c.disposition === null || c.disposition === 'disputed' || c.disposition === 'deferred').length,
  };
  const queue: { packet: Ref; arrived: string; resolved: string | null; age_minutes: number }[] = [];
  for (const pk of store.heads('review_packet')) {
    const arrived = store.history(pk.record_id)[0].created_at;
    const dec = decisions
      .filter((d) => d.body.reviewed.some((r) => r.record_id === pk.record_id))
      .sort((a, b) => a.body.decided_at.localeCompare(b.body.decided_at))[0];
    const resolved = dec?.body.decided_at ?? null;
    queue.push({ packet: refOf(pk), arrived, resolved, age_minutes: round(minutes(arrived, resolved ?? now)) });
  }
  const sweep = queue.flatMap((q) => [
    { t: q.arrived, d: 1 },
    ...(q.resolved ? [{ t: q.resolved, d: -1 }] : []),
  ]).sort((a, b) => a.t.localeCompare(b.t) || a.d - b.d);
  let size = 0;
  let peak = 0;
  for (const e of sweep) {
    size += e.d;
    peak = Math.max(peak, size);
  }
  const resolvedCands = cands.filter((c) => c.disposition !== null).length;
  const reviewBurden = {
    candidate_arrivals: cands.length,
    packets: queue.length,
    open_packets: queue.filter((q) => !q.resolved).length,
    peak_queue_size: peak,
    max_queue_age_minutes: queue.length ? Math.max(...queue.map((q) => q.age_minutes)) : 0,
    human_minutes_per_resolved_candidate: ratio(round(activeMinutes), resolvedCands),
    queue,
  };

  // --- Replay reliability, alternative route, positive controls --------------------------------------
  const required = accepted.filter((f) => {
    const inv = store.head<'investigation'>(f.body.investigation.record_id)!;
    return inv.body.executable && isMediumOrAbove(inv.body.potential_impact.effective);
  });
  const replayed = required.filter((f) => f.body.evidence_route === 'executable_replay' && store.head<'investigation'>(f.body.investigation.record_id)!.body.proof_status.replay === 'succeeded');
  const replay = {
    value: ratio(replayed.length, required.length),
    exceptions_alternative_argument: required.filter((f) => f.body.evidence_route === 'alternative_argument').map(refOf),
    replay_unavailable: required.filter((f) => store.head<'investigation'>(f.body.investigation.record_id)!.body.proof_status.replay === 'unavailable').map(refOf),
  };
  const alt = accepted.filter((f) => f.body.evidence_route === 'alternative_argument');
  const alternativeRoute = {
    value: ratio(alt.length, accepted.length),
    failed_attempts_behind: alt.map((f) => ({ finding: refOf(f), failed_attempts: failedAttempts(store, f.body.investigation.record_id).length })),
  };
  const highRejections = cands.filter((c) => c.disposition === 'rejected' && c.executable && isHighOrCritical(c.impact));
  const refused = store
    .events()
    .filter((e) => {
      const r = (e.result as { refused?: { code?: string } }).refused;
      return e.operation === 'record_decision' && r?.code === 'evidence_requirement_unmet';
    })
    .map((e) => e.event_id);
  // Attempted High/Critical rejections the controller refused for lack of a violating positive control.
  const refusedHighRejections = store.events().filter((e) => {
    const a = (e.result as { attempted?: { disposition?: string; impact?: string } }).attempted;
    return e.kind === 'decision_refused' && a?.disposition === 'rejected' && (a.impact === 'high' || a.impact === 'critical' || a.impact === 'unknown');
  }).length;
  const positiveControl = {
    value: ratio(highRejections.filter((c) => c.positive_control === 'shows_violation').length, highRejections.length + refusedHighRejections),
    refused_high_rejections: refusedHighRejections,
    refused_rejections_recorded: refused,
    note: 'A refused rejection that committed nothing leaves no event; only refusals the controller recorded are listed.',
  };

  // --- Work coverage and adequacy ----------------------------------------------------------------
  const units = store.heads('audit_unit');
  const relevant = units.filter((u) => u.body.review_status !== 'excluded');
  // A review a later change made affected or possibly affected no longer counts as coverage.
  const fresh = latestFreshness(store);
  const done = relevant.filter((u) => u.body.review_status === 'reviewed' && u.body.reviewed_revision !== null && !['affected', 'possibly_affected'].includes(fresh.get(u.record_id) ?? ''));
  const statusCounts: Record<string, number> = {};
  for (const u of units) inc(statusCounts, u.body.review_status);
  const guarantees = relevant.filter((u) => u.body.kind === 'guarantee');
  const blockedUnits = new Set(cands.filter((c) => c.investigation.body.work_state === 'blocked').flatMap((c) => c.investigation.body.audit_units.map((u) => u.record_id)));
  const coverage = {
    units: ratio(done.length, relevant.length),
    guarantees: ratio(guarantees.filter((u) => done.includes(u)).length, guarantees.length),
    by_review_status: statusCounts,
    units_with_blocked_work: [...blockedUnits],
    note: 'Coverage counts reviewed units; it is not a measure of security and never implies a percentage secure.',
  };
  const props = store.heads('property');
  const adequacyStatus: Record<string, number> = {};
  for (const p of props) inc(adequacyStatus, p.body.adequacy.status);
  const controlJobs = new Set(store.heads('job').filter((j) => j.body.purpose === 'positive_control' || j.body.purpose === 'adequacy').map((j) => j.record_id));
  const controlEvidence = store.heads('evidence_artifact').filter((e) => e.body.job && controlJobs.has(e.body.job.record_id) && e.body.structured_result);
  const adequacy = {
    properties_by_adequacy: adequacyStatus,
    faults: ratio(controlEvidence.filter((e) => e.body.structured_result!.result_type === 'counterexample').length, controlEvidence.length),
    surviving_faults: controlEvidence.filter((e) => e.body.structured_result!.result_type !== 'counterexample').map(refOf),
    meaningful_actions: { status: 'not_computable', reason: 'runner results do not yet record meaningful versus reverted actions per campaign' },
  };

  // --- Change handling and carry-forward ----------------------------------------------------------
  const bySnap: Record<string, Record<string, number>> = {};
  const history = new Map<string, { at: string; value: string }[]>();
  for (const f of store.heads('conclusion_freshness')) {
    bySnap[f.body.snapshot.record_id] ??= {};
    inc(bySnap[f.body.snapshot.record_id], f.body.value);
    const h = history.get(f.body.conclusion.record_id) ?? [];
    h.push({ at: f.created_at, value: f.body.value });
    history.set(f.body.conclusion.record_id, h);
  }
  const misses: string[] = [];
  for (const [id, h] of history) {
    h.sort((a, b) => a.at.localeCompare(b.at));
    const i = h.findIndex((x) => x.value === 'carried_forward_mechanical');
    if (i >= 0 && h.slice(i + 1).some((x) => x.value === 'affected')) misses.push(id);
  }
  const carryForward = {
    by_snapshot: bySnap,
    rechecks_completed: decisions.filter((d) => d.body.kind === 'reaffirm').length,
    later_affected_after_carry_forward: misses,
  };

  // --- Cost and latency ---------------------------------------------------------------------------
  const spend: Record<string, Record<string, number>> = {};
  const runtime: Record<string, number> = {};
  for (const l of store.heads('ledger_entry')) {
    const att = l.body.attempt ? store.tryGet<'attempt'>(l.body.attempt) : undefined;
    const job = att ? store.tryGet<'job'>(att.body.job) : undefined;
    const kind = job ? (job.body.purpose === 'agent' ? 'model' : 'compute_and_tools') : 'unattributed';
    spend[kind] ??= {};
    inc(spend[kind], l.body.kind, l.body.spend);
    if (l.body.kind === 'actual') inc(runtime, kind, l.body.runtime_seconds);
  }
  const attemptsRuntime = store.heads('attempt').reduce((s, a) => s + (a.body.actual.runtime_seconds ?? 0), 0);
  const cost = {
    spend_by_kind: spend,
    actual_runtime_seconds_by_kind: runtime,
    attempt_runtime_seconds: attemptsRuntime,
    uncertain_spend_attempts: store.heads('attempt').filter((a) => a.body.actual.spend_uncertain).length,
    human_active_minutes: round(activeMinutes),
    human_wait_minutes: round(queue.filter((q) => q.resolved).reduce((s, q) => s + q.age_minutes, 0)),
    budget: policy?.budget ?? null,
  };

  // --- Decision quality (canaries) and disposition mix ---------------------------------------------
  const mine = canaries.filter((c) => c.engagement === store.scope);
  const presented = mine.filter((c) => c.outcome);
  const byCanaryKind: Record<string, Ratio> = {};
  for (const k of [...new Set(mine.map((c) => c.kind))]) {
    const pres = presented.filter((c) => c.kind === k);
    byCanaryKind[k] = ratio(pres.filter((c) => c.outcome!.caught).length, pres.length);
  }
  const depth = presented.map((c) => {
    const d = store.tryGet<'human_decision'>(c.outcome!.decision);
    const r = d ? store.tryGet<'display_receipt'>(d.body.display_receipt) : undefined;
    return { decision: c.outcome!.decision, sections_opened: r?.body.sections.map((s) => s.section) ?? [] };
  });
  const decisionQuality = {
    caught: ratio(presented.filter((c) => c.outcome!.caught).length, presented.length),
    by_kind: byCanaryKind,
    not_yet_decided: mine.length - presented.length,
    inspection_depth: depth,
    note: 'Inspection depth is reported beside decision quality and is never an approval signal.',
    target: target('decision_quality'),
  };
  const mix: Record<string, Record<string, number>> = {};
  for (const i of POTENTIAL_IMPACTS) mix[i] = {};
  for (const c of cands) inc(mix[c.impact], c.disposition ?? 'no_disposition');

  return {
    engagement: store.scope,
    resolved_candidate_precision: precision,
    human_effort: humanEffort,
    decision_throughput: throughput,
    review_burden: reviewBurden,
    replay_reliability: replay,
    work_coverage: coverage,
    adequacy,
    change_handling: { status: 'not_computable', reason: 'seeded premise changes are labelled outside the engagement records' },
    change_carry_forward: carryForward,
    cost_and_latency: cost,
    decision_quality: decisionQuality,
    decision_load: decisionLoad,
    disposition_mix: mix,
    positive_control_outcomes: positiveControl,
    alternative_route_use: alternativeRoute,
    added_discovery: { status: 'not_computable', reason: "the baseline's finding set is not part of the engagement records" },
    _accepted: accepted.map((f) => f.record_id),
  };
}

export interface EvaluationReport {
  metric_version: string;
  contract: { ref: Ref | null; name: string; metric_version: string };
  generated_at: string;
  engagements: Omit<ReturnType<typeof engagementEvaluation>, '_accepted'>[];
  aggregate: {
    resolved_candidate_precision: Ratio;
    replay_reliability: Ratio;
    work_coverage_units: Ratio;
    alternative_route_use: Ratio;
    positive_control_outcomes: Ratio;
    decision_quality: Ratio;
  };
  known_defect_recall: {
    value: Ratio;
    matched: DefectMatch[];
    invalid_matches: { match: DefectMatch; reason: string }[];
    unmatched_reference_defects: { case: string; reference_defect: string }[];
    unexpected_accepted_findings: { engagement: string; finding: string }[];
    note: string;
  };
  targets_set_before_run: EvaluationContractBody['targets_set_before_run'];
  metrics: readonly string[];
}

/**
 * Compute the metrics table over the contract's target engagements. `matches` is the operator's
 * explicit table matching reference defects (from the contract labels) to accepted findings.
 */
export function evaluationReport(
  stores: RecordStore[],
  contract: EvaluationContractBody,
  opts: { contractRef?: Ref | null; matches?: DefectMatch[]; canaries?: CanaryView[]; now?: string } = {},
): EvaluationReport {
  const now = opts.now ?? new Date().toISOString();
  const per = stores.map((s) => engagementEvaluation(s, opts.canaries ?? [], now, contract.targets_set_before_run));

  // Known-defect recall: reference defects from the frozen labels; matches only to accepted findings.
  const refs = contract.labels.flatMap((l) => l.reference_defects.map((d) => ({ case: l.case, reference_defect: d })));
  const refKeys = new Set(refs.map((r) => `${r.case}\u0000${r.reference_defect}`));
  const acceptedBy = new Map(per.map((p) => [p.engagement, new Set(p._accepted)]));
  const matched: DefectMatch[] = [];
  const invalid: { match: DefectMatch; reason: string }[] = [];
  const matchedKeys = new Set<string>();
  const matchedFindings = new Set<string>();
  for (const m of opts.matches ?? []) {
    const k = `${m.case}\u0000${m.reference_defect}`;
    if (!refKeys.has(k)) invalid.push({ match: m, reason: 'not a reference defect in the frozen labels' });
    else if (!acceptedBy.get(m.engagement)?.has(m.finding?.record_id)) invalid.push({ match: m, reason: 'not an accepted finding of a target engagement' });
    else {
      matched.push(m);
      matchedKeys.add(k);
      matchedFindings.add(`${m.engagement}/${m.finding.record_id}`);
    }
  }
  const unexpected = per.flatMap((p) => p._accepted.filter((f) => !matchedFindings.has(`${p.engagement}/${f}`)).map((f) => ({ engagement: p.engagement, finding: f })));

  return {
    metric_version: EVALUATION_METRIC_VERSION,
    contract: { ref: opts.contractRef ?? null, name: contract.name, metric_version: contract.metric_version },
    generated_at: now,
    engagements: per.map(({ _accepted: _a, ...rest }) => rest),
    aggregate: {
      resolved_candidate_precision: sumRatios(per.map((p) => p.resolved_candidate_precision.value)),
      replay_reliability: sumRatios(per.map((p) => p.replay_reliability.value)),
      work_coverage_units: sumRatios(per.map((p) => p.work_coverage.units)),
      alternative_route_use: sumRatios(per.map((p) => p.alternative_route_use.value)),
      positive_control_outcomes: sumRatios(per.map((p) => p.positive_control_outcomes.value)),
      decision_quality: sumRatios(per.map((p) => p.decision_quality.caught)),
    },
    known_defect_recall: {
      value: ratio(matchedKeys.size, refKeys.size),
      matched,
      invalid_matches: invalid,
      unmatched_reference_defects: refs.filter((r) => !matchedKeys.has(`${r.case}\u0000${r.reference_defect}`)),
      unexpected_accepted_findings: unexpected,
      note: 'Unexpected accepted findings are reported separately and are neither misses nor false positives.',
    },
    targets_set_before_run: contract.targets_set_before_run,
    metrics: EVALUATION_METRICS,
  };
}

defineOperation<{ contract: Ref; matches?: DefectMatch[] }>({
  name: 'evaluation_report',
  channels: ['auditor'],
  mutating: true,
  scope: 'library',
  handler(ctx, p) {
    if (!p?.contract) fail('invalid_request', 'contract is required');
    const c = ctx.store.get(p.contract, 'evaluation_contract');
    if (c.body.status !== 'frozen') fail('invalid_request', `report against a frozen evaluation contract (this one is ${c.body.status})`);
    const stores = c.body.targets.map((t) => {
      if (!ctx.ws.hasEngagement(t.engagement)) fail('not_found', `target engagement ${t.engagement} not found`);
      return ctx.ws.store(t.engagement, true);
    });
    const canaries = ctx.store.heads('canary').map((x) => ({ engagement: x.body.engagement, packet: x.body.packet, kind: x.body.kind, outcome: x.body.outcome }));
    const report = evaluationReport(stores, c.body, { contractRef: refOf(c), matches: p.matches, canaries, now: ctx.now });
    const artifact = ctx.archive.putJson(report);
    ctx.tx.blob(artifact);
    ctx.tx.event('evaluation_report', { artifact: artifact.artifact, contract: refKey(refOf(c)), metric_version: EVALUATION_METRIC_VERSION });
    return { report, artifact };
  },
});
