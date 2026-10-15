import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { AGENT_SESSION_PRINCIPAL } from '../core/values.ts';
import { getOperation, type Session } from '../controller/controller.ts';
import type { Workspace } from '../controller/workspace.ts';
import type { RecordEnvelope, RecordType } from '../schema/records.ts';
import { spendSummary } from '../runner/index.ts';
import { ledgerTotals } from '../screen/flows.ts';
import { refText } from '../screen/render.ts';
import { runProcessAlive } from '../yolo/ops.ts';
import { runPackets } from '../yolo/report.ts';

// The home view (design/audit-harness.md, "Interaction and question design"): decisions needed, current work and
// spending, material gaps. `harness status` prints it; an agent session (`AgentReviewSession.overview`) presents the same
// computation, so the two cannot list different decisions.

export interface StatusDecision {
  what: string;
  /** The interactive alternative on the trusted screen. */
  command: string;
  /** The record an agent session presents and decides (pkt-…, wprop-…, eng-…, clar-…), when there is one. */
  id: string | null;
  /** The decision kind that settles it, or null (a proposal conflict is no decision). */
  kind: string | null;
  potential_impact: string | null;
  /** Records a generic decision binds, when they differ from `id`. */
  bind: string[];
}

export interface EngagementStatus {
  engagement: RecordEnvelope<'engagement'>;
  /** Header line: engagement, name, closure status, active snapshot, read-first mode. */
  title: string;
  decisions: StatusDecision[];
  work: string[];
  gaps: string[];
}

export interface BatchView {
  batches: { authorization: Ref; kind: string; status: string; investigations: { ref: Ref; work_state: string; disposition: string | null }[]; jobs: Record<string, number>; spend: { used: number; limit: number }; runtime: { used: number; limit: number } }[];
  next_job: Ref | null;
  held: { job: string; reason: string }[];
  review_queue: { ready: number; capacity: number | null; discovery_paused: boolean };
}

export function batchLines(v: BatchView): string[] {
  const out: string[] = [];
  for (const b of v.batches) {
    out.push(
      `Batch ${refText(b.authorization)} (${b.kind}) ${b.status}: spend ${b.spend.used}/${b.spend.limit}; runtime ${b.runtime.used}/${b.runtime.limit} s; jobs ${Object.entries(b.jobs).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; investigations ${b.investigations.map((i) => `${i.ref.record_id} ${i.work_state}${i.disposition ? `/${i.disposition}` : ''}`).join(', ') || 'none'}`,
    );
  }
  out.push(`Next job: ${v.next_job ? refText(v.next_job) : 'none'}`);
  for (const h of v.held) out.push(`Held job ${h.job}: ${h.reason}`);
  const q = v.review_queue;
  out.push(`Review queue: ${q.ready} ready / capacity ${q.capacity ?? 'not set'}${q.discovery_paused ? ' — DISCOVERY PAUSED (review queue full)' : ''}`);
  return out;
}

/** The home view of one engagement, read through `session` (the auditor channel). */
export function engagementStatus(ws: Workspace, session: Session, eid: string): EngagementStatus {
  const all = session.do<{ records: RecordEnvelope[] }>(eid, 'read_records', { limit: 5000 }).records;
  const of = <T extends RecordType>(t: T) => all.filter((r) => r.type === t) as RecordEnvelope<T>[];
  const eng = of('engagement')[0];
  if (!eng) fail('not_found', 'engagement record missing');
  const decisions: StatusDecision[] = [];
  const work: string[] = [];
  const gaps: string[] = [];
  const e = eng.body;
  const add = (what: string, command: string, id: string | null, kind: string | null, more: { potential_impact?: string; bind?: string[] } = {}) =>
    decisions.push({ what, command, id, kind, potential_impact: more.potential_impact ?? null, bind: more.bind ?? [] });
  if (!e.policy) add('Scope and policy not accepted', `harness screen accept_scope_and_policy -e ${eid} --draft policy.json`, eng.record_id, 'accept_scope_and_policy');
  for (const i of of('interpretation').filter((x) => x.body.status === 'proposed')) {
    add(`Interpretation ${i.record_id} awaits confirmation: "${i.body.proposed.statement}"`, `harness screen confirm_interpretations -e ${eid}`, i.record_id, 'confirm_interpretations', {
      bind: [i.record_id, ...i.body.captured_inputs.map((c) => c.record_id)],
    });
  }
  const clars = of('clarification')
    .filter((c) => ['queued', 'presented', 'held'].includes(c.body.status))
    .sort((a, b) => b.body.priority - a.body.priority);
  for (const c of clars) {
    add(`Clarification ${c.record_id} (${c.body.status}, priority ${c.body.priority}): ${c.body.issue}`, `harness screen answer_clarification ${c.record_id} -e ${eid}`, c.record_id, 'answer_clarification');
  }
  const packets = of('review_packet');
  for (const inv of of('investigation').filter((x) => x.body.work_state === 'ready_for_review' && !x.body.disposition)) {
    const p = packets.filter((x) => x.body.investigation.record_id === inv.record_id).pop();
    add(
      `Investigation ${inv.record_id} ready for review (potential impact ${inv.body.potential_impact.effective}): ${inv.body.question}`,
      p ? `harness screen packet ${p.record_id} -e ${eid}` : '(no packet yet)',
      p ? p.record_id : null,
      'dispose_investigation',
      { potential_impact: inv.body.potential_impact.effective },
    );
  }
  const authorized = new Set(of('work_authorization').flatMap((a) => a.body.reviewed.map((r) => r.record_id)));
  for (const wp of of('work_proposal').filter((x) => !authorized.has(x.record_id))) {
    add(`Work proposal ${wp.record_id} (${wp.body.kind}, ${wp.body.investigations.length} investigation(s)) awaits authorization`, `harness screen authorize_work ${wp.record_id} -e ${eid}`, wp.record_id, 'authorize_work');
  }
  const fresh = of('conclusion_freshness');
  const unattested = fresh.filter((f) => f.body.value === 'carried_forward_mechanical' && !f.body.attestation);
  if (unattested.length) {
    add(`${unattested.length} conclusion(s) carried forward mechanically, unattested`, `harness screen attest_carry_forward -e ${eid}`, unattested[0].record_id, 'attest_carry_forward', {
      bind: unattested.filter((f) => f.body.snapshot.record_id === unattested[0].body.snapshot.record_id).map((f) => f.record_id),
    });
  }
  for (const f of fresh.filter((x) => x.body.value === 'affected')) {
    add(`Conclusion ${refText(f.body.conclusion)} is affected by a change (recheck at stage 04)`, `harness screen decide reaffirm --record ${f.body.conclusion.record_id} -e ${eid} --inputs @inputs.json`, f.body.conclusion.record_id, 'reaffirm');
  }
  for (const m of of('report_manifest').filter((x) => x.body.status === 'preview')) add(`Export preview ${m.record_id} for ${m.body.audience}`, `harness screen approve_export ${m.record_id} -e ${eid}`, m.record_id, 'approve_export');
  for (const c of of('proposal_conflict').filter((x) => x.body.status === 'open')) {
    add(`Proposal conflict ${c.record_id} on ${c.body.target} (expected r${c.body.expected_revision}, actual r${c.body.actual_revision})`, `harness show ${c.record_id} -e ${eid}`, c.record_id, null);
  }

  // Current work and spending.
  const delegated = ws.unattendedKinds(eid);
  if (delegated.length) work.push(`UNATTENDED APPROVAL is delegated for: ${delegated.join(', ')} (a human does not decide these; \`harness unattended disable\` withdraws it)`);
  const decided = of('human_decision');
  const unattendedDecisions = decided.filter((d) => d.body.rationale_authorship === 'agent_unattended');
  if (unattendedDecisions.length) {
    work.push(`Decisions made UNATTENDED (no human review): ${unattendedDecisions.map((d) => `${d.record_id} ${d.body.kind}`).join(', ')}`);
  }
  const agentDecisions = decided.filter((d) => d.body.actor === AGENT_SESSION_PRINCIPAL);
  if (agentDecisions.length) {
    work.push(`Decisions recorded through an agent session: ${agentDecisions.map((d) => `${d.record_id} ${d.body.kind}`).join(', ')}`);
  }
  const yolo = of('yolo_run').sort((a, b) => a.record_id.localeCompare(b.record_id, 'en', { numeric: true })).at(-1);
  if (yolo) {
    const y = yolo.body;
    const packets = runPackets(ws.store(eid, true), y);
    const live = y.status !== 'running' ? '' : runProcessAlive(y.process) ? ` until ${y.until}` : ` but its process ${y.process.pid} has ended`;
    work.push(
      `YOLO RUN ${yolo.record_id} ${y.status}${live}${y.exit_reason ? ` (${y.exit_reason})` : ''}: ${y.cycles.length} cycle(s), ${packets.filter((p) => p.candidate).length} candidate finding(s) among ${packets.length} packet(s), none reviewed by a human; report: harness yolo report ${yolo.record_id} -e ${eid}`,
    );
  }
  const ctl = of('control_state')[0];
  if (ctl?.body.paused) work.push(`PAUSED by ${ctl.body.by}: ${ctl.body.reason}`);
  for (const s of ctl?.body.stopped ?? []) if (s.termination === 'unconfirmed') work.push(`Termination UNCONFIRMED for attempt ${refText(s.attempt)}: no overlapping replacement is admitted`);
  const byState = new Map<string, number>();
  for (const i of of('investigation')) byState.set(i.body.work_state, (byState.get(i.body.work_state) ?? 0) + 1);
  work.push(`Investigations by work state: ${[...byState].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  for (const j of of('job').filter((x) => ['queued', 'running', 'outcome_unknown'].includes(x.body.status))) {
    work.push(`Job ${j.record_id} ${j.body.status}: ${j.body.purpose} via ${j.body.adapter.name}${j.body.investigation ? ` for ${j.body.investigation.record_id}` : ''}; attempts ${j.body.attempts.map((a) => a.record_id).join(', ') || 'none'}`);
  }
  const t = ledgerTotals(of('ledger_entry'));
  const unit = e.policy?.budget.unit ?? 'units';
  work.push(`Spending (all ledger entries, ${unit}): actual ${t.spent}; reserved outstanding ${t.reserved}; uncertain ${t.uncertain}; engagement budget ${e.policy ? e.policy.budget.total : 'not set'}`);
  for (const a of of('work_authorization').filter((x) => x.body.status === 'active')) {
    const sp = spendSummary(ws.store(eid, true), a.record_id);
    work.push(
      `Authorization ${a.record_id} (${a.body.kind}) active: limit ${sp.limit}; confirmed ${sp.confirmed}; estimated ${sp.estimated}; uncertain ${sp.uncertain}; remaining ${sp.remaining}; ${a.body.investigations.length} investigation(s)${a.body.validity ? `; valid until ${a.body.validity.until}` : ''}`,
    );
  }
  if (getOperation('batch_status')) {
    for (const l of batchLines(session.do<BatchView>(eid, 'batch_status', {}))) work.push(l);
  }

  // Material gaps.
  if (!e.active_snapshot) gaps.push(`No target snapshot registered (harness snapshot register <path> -e ${eid})`);
  for (const [k, v] of Object.entries(e.ecosystem)) {
    if (v && typeof v === 'object' && 'unknown' in v && v.unknown) gaps.push(`Unknown ${k}: ${'reason' in v ? v.reason : undefined}`);
  }
  for (const u of of('audit_unit')) {
    if (u.body.review_status === 'not_started' || u.body.review_status === 'partial') gaps.push(`Audit unit ${u.record_id} "${u.body.name}" (${u.body.kind}) is ${u.body.review_status}`);
    for (const g of u.body.gaps) gaps.push(`Unit ${u.record_id}: ${g}`);
    const unreviewed = u.body.functions.filter((f) => !f.reviewed);
    if (unreviewed.length) gaps.push(`Unit ${u.record_id}: ${unreviewed.length} function(s) not reviewed: ${unreviewed.map((f) => f.name).join(', ')}`);
  }
  for (const f of of('suspicious_flag').filter((x) => !x.body.acknowledged)) gaps.push(`Suspicious content ${f.record_id} (${f.body.kind}) at ${f.body.path}:${f.body.line}: ${f.body.excerpt}`);
  for (const f of fresh.filter((x) => x.body.value === 'possibly_affected')) gaps.push(`Conclusion ${refText(f.body.conclusion)} possibly affected (flagged, not blocking)`);
  for (const s of of('target_snapshot')) for (const l of s.body.limitations) gaps.push(`Snapshot ${s.record_id}: ${l}`);

  const title = `Engagement ${eid}: ${e.name} [${e.closure_status}]   Active snapshot: ${refText(e.active_snapshot)}${e.read_first && !e.read_first.ended_at ? '   READ-FIRST MODE ACTIVE' : ''}`;
  return { engagement: eng, title, decisions, work, gaps };
}
