import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import type { BodyByType, RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { engagement } from './common.ts';

// Clarification queue (FR-06; design/audit-harness.md, "Interaction and question design"): one
// decision per clarification, ordered by priority, duplicates coalesced, a capacity the auditor sets.
// A full queue holds lower-priority clarifications without dropping them. Dependent work is blocked
// only while its clarification is open; unrelated work continues. Client questions export as one batch.

const OPEN = new Set(['queued', 'presented']);

export function openClarifications(store: RecordStore): RecordEnvelope<'clarification'>[] {
  return store.heads('clarification').filter((c) => OPEN.has(c.body.status));
}

export function heldClarifications(store: RecordStore): RecordEnvelope<'clarification'>[] {
  return store.heads('clarification').filter((c) => c.body.status === 'held');
}

/** Queue order: higher priority first, then oldest. */
export function queueOrder(list: RecordEnvelope<'clarification'>[]): RecordEnvelope<'clarification'>[] {
  return [...list].sort((a, b) => b.body.priority - a.body.priority || a.record_id.localeCompare(b.record_id, 'en', { numeric: true }));
}

/** Before scope and policy are accepted no capacity is set, so nothing is held. */
function capacity(store: RecordStore): number {
  return engagement(store).body.policy?.capacity.clarification_queue ?? Number.MAX_SAFE_INTEGER;
}

/** Block investigations that depend on an open clarification (dependent work only). */
function blockDependents(ctx: OpContext, clar: Ref, blocks: Ref[]): void {
  for (const r of blocks) {
    const env = ctx.store.head(r.record_id);
    if (env?.type !== 'investigation') continue;
    const cur = ctx.tx.current(r.record_id, 'investigation');
    if (['proposed', 'queued', 'running'].includes(cur.body.work_state)) {
      ctx.tx.revise(r.record_id, 'investigation', (b) => ({
        ...b,
        work_state: 'blocked',
        blocked_reason: `clarification:${clar.record_id}:${b.work_state}`,
      }));
    }
  }
}

/** Release work blocked by a clarification back to the state it was blocked from. */
export function releaseDependents(ctx: OpContext, clarId: string): Ref[] {
  const released: Ref[] = [];
  for (const inv of ctx.store.heads('investigation')) {
    const cur = ctx.tx.current(inv.record_id, 'investigation');
    const m = /^clarification:([^:]+):(\w+)$/.exec(cur.body.blocked_reason ?? '');
    if (cur.body.work_state === 'blocked' && m && m[1] === clarId) {
      const prior = m[2] === 'running' ? 'queued' : (m[2] as 'proposed' | 'queued');
      released.push(ctx.tx.revise(inv.record_id, 'investigation', (b) => ({ ...b, work_state: prior, blocked_reason: null })));
    }
  }
  return released;
}

export function enqueueClarification(ctx: OpContext, body: BodyByType['clarification']): Record<string, unknown> {
  // Coalesce duplicates into the open (or held) clarification with the same key.
  const dup = ctx.store
    .heads('clarification')
    .find((c) => c.body.dedupe_key === body.dedupe_key && (OPEN.has(c.body.status) || c.body.status === 'held'));
  if (dup) {
    const ref = ctx.tx.create('clarification', { ...body, status: 'coalesced' });
    const target = ctx.tx.revise(dup.record_id, 'clarification', (b) => ({
      ...b,
      coalesced: [...b.coalesced, ref],
      blocks: [...b.blocks, ...body.blocks.filter((x) => !b.blocks.some((y) => y.record_id === x.record_id))],
      priority: Math.max(b.priority, body.priority),
    }));
    if (OPEN.has(dup.body.status)) blockDependents(ctx, target, body.blocks);
    return { clarification: ref, coalesced_into: target, status: 'coalesced' };
  }
  const open = queueOrder(openClarifications(ctx.store));
  let status: 'queued' | 'held' = 'queued';
  if (open.length >= capacity(ctx.store)) {
    const lowest = open[open.length - 1];
    if (lowest && body.priority > lowest.body.priority && lowest.body.status === 'queued') {
      // A higher-priority clarification displaces the lowest one, which waits (never dropped).
      ctx.tx.revise(lowest.record_id, 'clarification', (b) => ({ ...b, status: 'held', next_action: 'held: clarification queue at capacity' }));
    } else {
      status = 'held';
    }
  }
  const ref = ctx.tx.create('clarification', {
    ...body,
    status,
    next_action: status === 'held' ? 'held: clarification queue at capacity' : body.next_action,
  });
  // Held clarifications still block their dependent work: it cannot proceed without the answer.
  blockDependents(ctx, ref, body.blocks);
  return { clarification: ref, status };
}

/** After an answer, promote the highest-priority held clarification if there is room. */
export function promoteHeld(ctx: OpContext): Ref | null {
  const open = openClarifications(ctx.store).filter((c) => ctx.tx.current(c.record_id, 'clarification').body.status !== 'answered');
  if (open.length >= capacity(ctx.store)) return null;
  const next = queueOrder(heldClarifications(ctx.store))[0];
  if (!next) return null;
  return ctx.tx.revise(next.record_id, 'clarification', (b) => ({ ...b, status: 'queued', next_action: 'answer on the trusted decision screen' }));
}

defineOperation<Record<string, never>>({
  name: 'clarification_queue',
  channels: ['auditor', 'screen', 'worker', 'controller'],
  mutating: false,
  handler(ctx) {
    return {
      open: queueOrder(openClarifications(ctx.store)).map((c) => ({ ref: { record_id: c.record_id, revision: c.revision }, priority: c.body.priority, issue: c.body.issue, blocks: c.body.blocks })),
      held: queueOrder(heldClarifications(ctx.store)).map((c) => ({ ref: { record_id: c.record_id, revision: c.revision }, priority: c.body.priority, issue: c.body.issue })),
      capacity: capacity(ctx.store),
    };
  },
});

/** Client questions leave as one batch (an archive artifact the auditor can send). */
defineOperation<Record<string, never>>({
  name: 'export_client_questions',
  channels: ['auditor'],
  mutating: true,
  handler(ctx) {
    const qs = queueOrder([...openClarifications(ctx.store), ...heldClarifications(ctx.store)]).filter((c) => c.body.answer_source === 'client');
    if (!qs.length) fail('invalid_request', 'no open client clarifications');
    const doc = {
      format: 'harness.client-questions/1',
      generated_at: ctx.now,
      questions: qs.map((c) => ({
        ref: { record_id: c.record_id, revision: c.revision },
        issue: c.body.issue,
        options: c.body.options,
        recommendation: c.body.recommendation,
      })),
    };
    const art = ctx.archive.putJson(doc);
    ctx.tx.blob(art);
    ctx.tx.event('client_questions_exported', { artifact: art.artifact, count: qs.length });
    return { artifact: art, count: qs.length };
  },
});
