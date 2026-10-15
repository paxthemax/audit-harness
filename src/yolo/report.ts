import { isArtifactRef, type Ref } from '../core/refs.ts';
import { impactRank } from '../core/values.ts';
import { latestPacket } from '../decision/packets.ts';
import { md, mdBlock } from '../report/escape.ts';
import { spendSummary } from '../runner/ledger.ts';
import type { RecordEnvelope, YoloRunBody } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';

// The yolo run report (operator request 2026-10-14). The controller renders it from records whenever the governor
// records progress, so it cannot say more than the store holds. It is a triage index for the auditor's morning
// review, not the engagement report: nothing in it is a finding until the auditor disposes the packet.

export interface RunPacket {
  packet: RecordEnvelope<'review_packet'>;
  investigation: RecordEnvelope<'investigation'>;
  /** Agents claim a violation: proposed `accepted`, a supporting variant, or trusted-runner counterexample support. */
  candidate: boolean;
}

/** The latest packet of each investigation the run admitted: candidate findings first, then by potential impact. */
export function runPackets(store: RecordStore, run: YoloRunBody): RunPacket[] {
  const out: RunPacket[] = [];
  for (const id of new Set(run.cycles.flatMap((c) => c.admitted.map((r) => r.record_id)))) {
    const packet = latestPacket(store, id);
    if (!packet) continue;
    const counterexample = packet.body.supporting.some((r) => {
      const env = isArtifactRef(r) ? undefined : store.tryGet<'evidence_artifact'>(r);
      return env?.type === 'evidence_artifact' && env.body.structured_result?.result_type === 'counterexample';
    });
    const candidate = packet.body.proposed_disposition?.value === 'accepted' || packet.body.variants.some((v) => v.outcome === 'supports') || counterexample;
    out.push({ packet, investigation: store.mustHead(id, 'investigation'), candidate });
  }
  return out.sort(
    (a, b) =>
      Number(b.candidate) - Number(a.candidate) ||
      impactRank(b.packet.body.potential_impact) - impactRank(a.packet.body.potential_impact) ||
      a.packet.record_id.localeCompare(b.packet.record_id, 'en', { numeric: true }),
  );
}

/** Why an admitted investigation has no packet: its block, or the last refusal of a packet its agents submitted. */
export function missingPacketReason(store: RecordStore, inv: RecordEnvelope<'investigation'>): string {
  if (inv.body.blocked_reason) return `blocked: ${inv.body.blocked_reason}`;
  const attempts = new Set(store.heads('job').filter((j) => j.body.investigation?.record_id === inv.record_id).flatMap((j) => j.body.attempts.map((a) => a.record_id)));
  const refused = store
    .events()
    .filter((e) => e.kind === 'worker_request_refused' && attempts.has(String(e.result.attempt)) && e.result.operation === 'submit_review_packet')
    .at(-1);
  return refused ? `packet refused: ${String(refused.result.code)}: ${String(refused.result.reason)}` : 'no packet submitted';
}

const refList = (refs: Ref[]): string => (refs.length ? refs.map((r) => md(r.record_id)).join(', ') : 'none');

export function renderYoloReport(store: RecordStore, runId: string, run: YoloRunBody, now: string): string {
  const L: string[] = [];
  const packets = runPackets(store, run);
  const candidates = packets.filter((p) => p.candidate);
  const others = packets.filter((p) => !p.candidate);
  const admitted = [...new Set(run.cycles.flatMap((c) => c.admitted.map((r) => r.record_id)))];
  const withPacket = new Set(packets.map((p) => p.investigation.record_id));

  L.push(`# Yolo run ${md(runId)}, engagement ${md(store.scope)}`, '');
  L.push(
    '**No human reviewed what this run produced.** Agents drafted every claim, test and proposed disposition, and the governor authorized the work through the unattended approver. A candidate finding is not a finding until the auditor disposes its packet (through an agent session, `harness_present <packet>`, or `harness screen packet <packet>`).',
    '',
  );
  L.push('| | |', '|---|---|');
  L.push(`| Status | ${md(run.status)}${run.exit_reason ? ` (${md(run.exit_reason)})` : ''} |`);
  L.push(`| Window | ${md(run.started_at)} to ${md(run.until)}${run.ended_at ? `; ended ${md(run.ended_at)}` : ''} |`);
  L.push(`| Cycles | ${run.cycles.length} |`);
  L.push(`| Charter | ${md(run.charter.artifact)} |`);
  L.push(`| Candidate findings | ${candidates.length} |`);
  L.push(`| Rendered | ${md(now)} |`, '');

  L.push(`## Candidate findings (${candidates.length})`, '');
  if (!candidates.length) L.push('None.', '');
  candidates.forEach((p, i) => {
    const b = p.packet.body;
    const inv = p.investigation.body;
    L.push(`### ${i + 1}. ${md(p.packet.record_id)}: ${md(p.investigation.record_id)}, potential impact ${md(b.potential_impact)}`, '');
    if (inv.disposition) L.push(`- **Decided since:** ${md(inv.disposition.value)} (${md(inv.disposition.decision.record_id)})`);
    L.push(`- Question: ${md(inv.question)}`);
    L.push(`- Claim: ${md(b.claim)}`);
    if (b.proposed_disposition) {
      L.push(`- Proposed disposition (agent-drafted, not a decision): ${md(b.proposed_disposition.value)}`, '', mdBlock(b.proposed_disposition.rationale), '');
    }
    const supporting = b.supporting.map((r) => {
      if (isArtifactRef(r)) return md(r.artifact);
      const env = store.tryGet<'evidence_artifact'>(r);
      const t = env?.type === 'evidence_artifact' ? env.body.structured_result?.result_type : null;
      return `${md(r.record_id)}${t ? ` (${md(t)})` : ''}`;
    });
    L.push(`- Supporting: ${supporting.join(', ') || 'none'}; refuting: ${b.refuting.length}`);
    L.push(`- Evidence quality: replay ${md(b.evidence_quality.replay)}${b.replay_receipt ? ` (${md(b.replay_receipt.record_id)})` : ''}; provenance ${md(b.evidence_quality.provenance)}; positive control ${md(b.evidence_quality.positive_control)}`);
    L.push(`- Variants: ${b.variants.map((v) => `${md(v.variant.record_id)} ${md(v.outcome ?? 'no outcome')}`).join(', ') || 'none'}`);
    L.push(`- Challenge: ${b.challenge_required ? 'required' : 'not required'}; challenger position ${b.challenger_position ? 'present' : 'absent'}; ${md(b.challenge_independence.context)}`);
    if (b.unreviewed_statements.length) L.push(`- Unreviewed statements (conditions of any decision unless accepted): ${refList(b.unreviewed_statements)}`);
    for (const o of b.fixture_overrides ?? []) L.push(`- **Fixture overrides target files** (${md(o.job.record_id)}): ${o.paths.map(md).join(', ')}`);
    L.push('');
  });

  L.push(`## Other packets ready for review (${others.length})`, '');
  if (others.length) {
    L.push('| Packet | Investigation | Potential impact | Proposed disposition | Claim |', '|---|---|---|---|---|');
    for (const p of others) {
      const decided = p.investigation.body.disposition ? ` (decided since: ${md(p.investigation.body.disposition.value)})` : '';
      L.push(`| ${md(p.packet.record_id)} | ${md(p.investigation.record_id)}${decided} | ${md(p.packet.body.potential_impact)} | ${md(p.packet.body.proposed_disposition?.value ?? 'none')} | ${md(p.packet.body.claim)} |`);
    }
  } else L.push('None.');
  L.push('');

  const open = admitted.filter((id) => !withPacket.has(id)).map((id) => store.mustHead(id, 'investigation'));
  L.push(`## Admitted investigations without a packet (${open.length})`, '');
  if (open.length) {
    L.push('| Investigation | Work state | Why |', '|---|---|---|');
    for (const inv of open) L.push(`| ${md(inv.record_id)} | ${md(inv.body.work_state)} | ${md(missingPacketReason(store, inv))} |`);
  } else L.push('None.');
  L.push('');

  const questions = store
    .heads('clarification')
    .filter((c) => store.history(c.record_id)[0].created_at >= run.started_at && ['queued', 'presented', 'held'].includes(c.body.status))
    .sort((a, b) => b.body.priority - a.body.priority);
  L.push(`## Questions raised for the auditor (${questions.length})`, '');
  L.push(questions.length ? questions.map((c) => `- ${md(c.record_id)} (${md(c.body.status)}, priority ${c.body.priority}, blocks ${refList(c.body.blocks)}): ${md(c.body.issue)}`).join('\n') : 'None.', '');

  L.push('## Decisions made without a human', '');
  const auths = [run.discovery_authorization, ...run.cycles.map((c) => c.authorization)].filter((r): r is Ref => !!r);
  for (const a of auths) {
    const auth = store.mustHead(a.record_id, 'work_authorization');
    L.push(`- ${md(auth.body.decision.record_id)} authorize_work (${md(auth.body.kind)}): ${md(auth.record_id)}, ${auth.body.investigations.length} investigation(s), valid until ${md(auth.body.validity?.until ?? 'no end')}`);
  }
  for (const c of run.cycles) {
    for (const d of c.flow_reviews) {
      const unit = store.get(d, 'human_decision').body.inputs.audit_unit;
      const unitId = unit && typeof unit === 'object' && 'record_id' in unit ? String(unit.record_id) : 'unknown unit';
      L.push(`- ${md(d.record_id)} record_flow_review: ${md(unitId)} (no function marked reviewed; closure stays incomplete until a human flow review)`);
    }
  }
  if (!auths.length && !run.cycles.some((c) => c.flow_reviews.length)) L.push('None.');
  L.push('');

  L.push('## Work and spend', '');
  if (auths.length) {
    L.push('| Authorization | Kind | Status | Spend confirmed / estimated / uncertain / limit | Runtime committed / limit (s) | Jobs |', '|---|---|---|---|---|---|');
    for (const a of auths) {
      const auth = store.mustHead(a.record_id, 'work_authorization');
      const sp = spendSummary(store, a.record_id);
      const jobs = new Map<string, number>();
      for (const j of store.heads('job').filter((x) => x.body.authorization.record_id === a.record_id)) {
        const k = `${j.body.purpose === 'agent' ? j.body.role : j.body.purpose} ${j.body.status}`;
        jobs.set(k, (jobs.get(k) ?? 0) + 1);
      }
      L.push(
        `| ${md(auth.record_id)} | ${md(auth.body.kind)} | ${md(auth.body.status)} | ${sp.confirmed} / ${sp.estimated} / ${sp.uncertain} / ${sp.limit} | ${sp.runtime_seconds.committed} / ${sp.runtime_seconds.limit} | ${[...jobs].map(([k, n]) => `${md(k)} ${n}`).join(', ') || 'none'} |`,
      );
    }
  } else L.push('No authorization yet.');
  L.push('');

  L.push('## Cycle log', '');
  if (!run.cycles.length) L.push('No cycle yet.', '');
  for (const c of run.cycles) {
    L.push(`### Cycle ${c.n} (${md(c.started_at)} to ${md(c.ended_at ?? 'running')})`, '');
    L.push(`- Proposal ${c.work_proposal ? md(c.work_proposal.record_id) : 'none'}; authorization ${c.authorization ? md(c.authorization.record_id) : 'none'}; admitted ${refList(c.admitted)}`);
    for (const n of c.notes) L.push(`- ${md(n)}`);
    L.push('');
  }
  return L.join('\n');
}
