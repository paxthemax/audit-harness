import { defineOperation } from '../controller/controller.ts';
import type { RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';

// Workload, decision-load and outcome measurements (FR-25, NFR-15; design/harness-evaluation.md,
// "Metrics and denominators"). Every figure is computed from records with a recorded metric version,
// so a later definition change never silently alters an earlier comparison. Counts carry their
// denominators: duplicate floods, unresolved candidates and deferred work stay visible. Dwell time and
// inspection depth are reported but never treated as approval signals (NFR-14).

export const METRIC_VERSION = 'metrics/1';

const day = (iso: string) => iso.slice(0, 10);

function minutes(a: string, b: string): number {
  return Math.max(0, (Date.parse(b) - Date.parse(a)) / 60000);
}

export function engagementMetrics(store: RecordStore) {
  const decisions = store.heads('human_decision');
  const byKind: Record<string, number> = {};
  const byDay: Record<string, Record<string, number>> = {};
  for (const d of decisions) {
    byKind[d.body.kind] = (byKind[d.body.kind] ?? 0) + 1;
    const k = day(d.body.decided_at);
    byDay[k] ??= {};
    byDay[k][d.body.kind] = (byDay[k][d.body.kind] ?? 0) + 1;
  }
  const receipts = store.heads('display_receipt').filter((r) => r.created_by.channel === 'screen');
  const activeMinutes = receipts.reduce((s, r) => s + minutes(r.body.started_at, r.body.ended_at), 0);

  // Waiting for the auditor: packet ready → its disposition decision (tracked apart from active work).
  const waiting: number[] = [];
  for (const pkt of store.heads('review_packet')) {
    const inv = store.head<'investigation'>(pkt.body.investigation.record_id);
    const dec = inv?.body.disposition ? store.tryGet<'human_decision'>(inv.body.disposition.decision) : undefined;
    if (dec && dec.body.reviewed.some((r) => r.record_id === pkt.record_id)) waiting.push(minutes(pkt.created_at, dec.body.decided_at));
  }

  const invs = store.heads('investigation');
  const byState: Record<string, number> = {};
  const byDisposition: Record<string, number> = {};
  for (const i of invs) {
    byState[i.body.work_state] = (byState[i.body.work_state] ?? 0) + 1;
    const d = i.body.disposition?.value ?? 'none';
    byDisposition[d] = (byDisposition[d] ?? 0) + 1;
  }
  const freshness = latestFreshness(store);
  const unresolved = invs.filter(
    (i) => !i.body.disposition || ['disputed', 'deferred'].includes(i.body.disposition.value) || ['affected', 'possibly_affected'].includes(freshness.get(i.record_id) ?? ''),
  ).length;

  const attempts = store.heads('attempt');
  const attemptStatus: Record<string, number> = {};
  for (const a of attempts) attemptStatus[a.body.status] = (attemptStatus[a.body.status] ?? 0) + 1;

  const spend = { reserved: 0, actual: 0, uncertain: 0, released: 0 };
  for (const l of store.heads('ledger_entry')) {
    if (l.body.kind === 'reservation') spend.reserved += l.body.spend;
    if (l.body.kind === 'actual') spend.actual += l.body.spend;
    if (l.body.kind === 'uncertain') spend.uncertain += l.body.spend;
    if (l.body.kind === 'release') spend.released += l.body.spend;
  }

  const findings = store.heads('finding');
  const groups = store.heads('lead_group');
  const clar = store.heads('clarification');
  const statusCount = (list: RecordEnvelope<'clarification'>[], s: string) => list.filter((c) => c.body.status === s).length;

  return {
    metric_version: METRIC_VERSION,
    decision_load: {
      total: decisions.length,
      by_kind: byKind,
      by_engagement_day: byDay,
      active_screen_minutes: Number(activeMinutes.toFixed(2)),
      display_receipts: receipts.length,
      waiting_minutes: waiting.length ? { count: waiting.length, total: Number(waiting.reduce((a, b) => a + b, 0).toFixed(2)) } : { count: 0, total: 0 },
    },
    investigations: { total: invs.length, by_work_state: byState, by_disposition: byDisposition, unresolved },
    findings: {
      total: findings.length,
      alternative_route: findings.filter((f) => f.body.evidence_route === 'alternative_argument').length,
      executable_replay: findings.filter((f) => f.body.evidence_route === 'executable_replay').length,
      code_argument: findings.filter((f) => f.body.evidence_route === 'code_argument').length,
    },
    execution: { attempts: attempts.length, by_status: attemptStatus },
    spend,
    duplicates: { groups: groups.length, grouped_leads: groups.reduce((s, g) => s + g.body.members.length, 0) },
    clarifications: { total: clar.length, open: statusCount(clar, 'queued') + statusCount(clar, 'presented'), held: statusCount(clar, 'held'), coalesced: statusCount(clar, 'coalesced') },
    limits: ['Dwell time and screen minutes describe workload; they are never approval or quality signals.'],
  };
}

/** Latest freshness value per conclusion id. */
export function latestFreshness(store: RecordStore): Map<string, string> {
  const out = new Map<string, { at: string; id: string; value: string }>();
  for (const f of store.heads('conclusion_freshness')) {
    const k = f.body.conclusion.record_id;
    const cur = out.get(k);
    if (!cur || f.created_at > cur.at || (f.created_at === cur.at && f.record_id.localeCompare(cur.id, 'en', { numeric: true }) > 0)) {
      out.set(k, { at: f.created_at, id: f.record_id, value: f.body.value });
    }
  }
  return new Map([...out.entries()].map(([k, v]) => [k, v.value]));
}

defineOperation<Record<string, never>>({
  name: 'engagement_metrics',
  channels: ['auditor', 'screen', 'controller'],
  mutating: false,
  handler(ctx) {
    return engagementMetrics(ctx.store);
  },
});
