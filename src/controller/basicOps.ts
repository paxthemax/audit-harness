import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { unknown } from '../core/refs.ts';
import { RECORD_TYPES, type RecordEnvelope, type RecordType } from '../schema/records.ts';
import { defineOperation, type OpContext } from './controller.ts';

// Engagement bootstrap, record reads and display receipts.

export interface CreateEngagementPayload {
  name: string;
  owner: string;
  audit_purpose: string;
  chain?: string | null;
  hardfork?: string | null;
}

defineOperation<CreateEngagementPayload>({
  name: 'create_engagement',
  channels: ['auditor'],
  mutating: true,
  createsStore: true,
  handler(ctx, p) {
    if (!p?.name || !p.owner || !p.audit_purpose) fail('invalid_request', 'name, owner and audit_purpose are required');
    const ref = ctx.tx.create('engagement', {
      name: p.name,
      owner: p.owner,
      audit_purpose: p.audit_purpose,
      ecosystem: {
        language: 'solidity',
        chain: p.chain ? p.chain : unknown('chain not supplied at engagement creation'),
        hardfork: p.hardfork ? p.hardfork : unknown('hardfork not supplied at engagement creation'),
      },
      policy: null,
      policy_decision: null,
      active_snapshot: null,
      read_first: null,
      closure_status: 'open',
      closure_decision: null,
    });
    // The control state starts unpaused so that pause/resume always revise one record.
    ctx.tx.create('control_state', { paused: false, reason: 'engagement created', by: 'auditor', stopped: [] });
    return { engagement: ref };
  },
});

export interface ReadRecordsPayload {
  refs?: Ref[];
  ids?: string[];
  type?: RecordType;
  /** Include every revision rather than heads only. */
  history?: boolean;
  limit?: number;
}

/**
 * Records a worker may read: its own engagement only (the controller refuses other scopes). A
 * challenger's reads honor its initial context: no author narrative (review packets, author positions,
 * agent interpretations) and no provisional statements on the challenged path
 * (design/audit-harness.md, "Agent role classification").
 */
function workerVisible(ctx: OpContext, env: RecordEnvelope): boolean {
  if (ctx.principal.channel !== 'worker') return true;
  // Library entries are reached through the context builder, not engagement reads.
  if (env.visibility !== 'engagement') return false;
  if (ctx.principal.grant?.role === 'challenger') {
    if (env.type === 'review_packet' || env.type === 'interpretation') return false;
    if (env.type === 'position' && (env as RecordEnvelope<'position'>).body.role === 'author') return false;
    if (env.type === 'system_statement' && (env as RecordEnvelope<'system_statement'>).body.review_status !== 'reviewed') return false;
  }
  return true;
}

defineOperation<ReadRecordsPayload>({
  name: 'read_records',
  channels: ['auditor', 'screen', 'worker', 'controller', 'runner'],
  mutating: false,
  scope: 'either',
  handler(ctx, p = {}) {
    if (p.type && !RECORD_TYPES.includes(p.type)) fail('invalid_request', `unknown record type ${p.type}`);
    const limit = Math.min(p.limit ?? 500, 5000);
    let out: RecordEnvelope[] = [];
    if (p.refs) out = p.refs.map((r) => ctx.store.get(r));
    else if (p.ids) out = p.ids.flatMap((id) => (p.history ? ctx.store.history(id) : [ctx.store.mustHead(id)]));
    else out = ctx.store.heads(p.type);
    if (p.type) out = out.filter((r) => r.type === p.type);
    out = out.filter((r) => workerVisible(ctx, r));
    return { records: out.slice(0, limit), truncated: out.length > limit };
  },
});

export interface RecordDisplayPayload {
  rendered: Ref[];
  sections: { section: string; opened_at: string }[];
  started_at: string;
  ended_at: string;
  /** Audit units whose IMPLEMENTED behavior (records or KB diagrams) this display presented. */
  implemented_presented_for?: Ref[];
}

/**
 * Display receipts: the record of which revisions the trusted decision screen (or the auditor
 * interface, when it shows IMPLEMENTED records or KB diagrams) rendered, in what order and when.
 * The first presentation of a unit's implemented behavior fixes the boundary for intent timing.
 */
defineOperation<RecordDisplayPayload>({
  name: 'record_display',
  channels: ['screen', 'auditor'],
  mutating: true,
  scope: 'either',
  handler(ctx, p) {
    if (!Array.isArray(p?.rendered) || !Array.isArray(p.sections)) fail('invalid_request', 'rendered and sections are required');
    for (const r of p.rendered) ctx.store.get(r); // exact revisions must exist
    const presented = p.implemented_presented_for ?? [];
    const eng = ctx.store.heads('engagement')[0];
    if (presented.length && eng?.body.read_first && eng.body.read_first.ended_at === null) {
      fail('permission_denied', 'read-first mode is active: presentations of implemented behavior are withheld until it ends');
    }
    const screen = ctx.principal.screen ?? { identity: 'auditor-interface', session: ctx.request.request_id };
    const receipt = ctx.tx.create(
      'display_receipt',
      {
        screen: { identity: screen.identity, session: screen.session },
        rendered: p.rendered,
        sections: p.sections,
        started_at: p.started_at,
        ended_at: p.ended_at,
        implemented_presented_for: presented,
      },
      p.rendered,
    );
    // The unit's first presentation is derived from these receipts (see firstPresentation in
    // src/decision/common.ts) rather than stored on the unit, so presenting a unit never makes a
    // decision about that unit stale.
    for (const u of presented) ctx.store.get(u, 'audit_unit');
    return { display_receipt: receipt, channel: ctx.principal.channel };
  },
});

/**
 * Verify a store before resuming (design/harness-state-and-execution.md, "Permissions and isolation":
 * restore into an isolated location and verify references and hashes before resuming).
 */
defineOperation<Record<string, never>>({
  name: 'verify_store',
  channels: ['auditor', 'screen', 'controller'],
  mutating: false,
  scope: 'either',
  handler(ctx) {
    const v = ctx.store.verify();
    const dangling: string[] = [];
    for (const env of ctx.store.heads()) {
      for (const d of env.depends_on) {
        if ('artifact' in d) {
          if (!ctx.archive.has(d.artifact)) dangling.push(`${env.record_id} -> ${d.artifact}`);
        } else if (!d.scope && !ctx.store.tryGet(d)) dangling.push(`${env.record_id} -> ${d.record_id}@${d.revision}`);
      }
    }
    const unresolved = ctx.store.heads('attempt').filter((a) => a.body.status === 'running' || a.body.status === 'outcome_unknown').map((a) => a.record_id);
    return { ok: v.ok && dangling.length === 0, problems: [...v.problems, ...dangling.map((d) => `dangling reference ${d}`)], unresolved_attempts: unresolved, quarantined: ctx.store.openReport.quarantined };
  },
});
