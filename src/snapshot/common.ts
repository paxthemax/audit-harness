// Shared helpers for the snapshot module: the active snapshot, cached inventory and layout reads,
// and which records are consequential conclusions (design/harness-state-and-execution.md,
// "Evidence invalidation and revision changes").

import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import type { OpContext } from '../controller/controller.ts';
import type { Archive } from '../store/archive.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { RecordEnvelope, RecordType, TargetSnapshotBody } from '../schema/records.ts';
import type { Inventory, StorageLayouts } from './inventory.ts';

/** A snapshot body with the ref it has (or will have once the staged transaction commits). */
export interface SnapshotView {
  ref: Ref;
  body: TargetSnapshotBody;
}

/** Record types whose conclusions carry probes and freshness. */
export const CONCLUSION_TYPES = [
  'investigation',
  'scenario_variant',
  'finding',
  'fix_assessment',
  'behavioral_comparison',
  'audit_unit',
] as const satisfies readonly RecordType[];
export type ConclusionType = (typeof CONCLUSION_TYPES)[number];

export function isConclusionType(t: string): t is ConclusionType {
  return (CONCLUSION_TYPES as readonly string[]).includes(t);
}

/**
 * Consequential conclusions (Q-019): refutations and other dispositions, scenario-variant outcomes,
 * coverage claims (reviewed units), accepted findings, fix assessments, comparisons and pending
 * approvals (investigations ready for review).
 */
export function isConsequential(env: RecordEnvelope): boolean {
  switch (env.type) {
    case 'investigation': {
      const b = (env as RecordEnvelope<'investigation'>).body;
      return b.disposition !== null || b.work_state === 'ready_for_review' || b.linked_claims.some((c) => c.disposition !== null);
    }
    case 'scenario_variant':
      return (env as RecordEnvelope<'scenario_variant'>).body.outcome !== null;
    case 'audit_unit':
      return (env as RecordEnvelope<'audit_unit'>).body.review_status === 'reviewed';
    case 'finding':
    case 'fix_assessment':
    case 'behavioral_comparison':
      return true;
    default:
      return false;
  }
}

export function engagementRecord(store: RecordStore): RecordEnvelope<'engagement'> {
  const e = store.heads('engagement')[0];
  if (!e) fail('not_found', 'engagement record not found');
  return e;
}

/** The engagement's active snapshot at its current head revision (staged revisions included). */
export function activeSnapshot(ctx: OpContext): SnapshotView | null {
  const eng = ctx.tx.current<'engagement'>(engagementRecord(ctx.store).record_id, 'engagement').body;
  if (!eng.active_snapshot) return null;
  const cur = ctx.tx.current<'target_snapshot'>(eng.active_snapshot.record_id, 'target_snapshot');
  return { ref: { record_id: eng.active_snapshot.record_id, revision: cur.revision }, body: cur.body };
}

/** Same as `activeSnapshot` for read-only callers (reports, screen). */
export function activeSnapshotOf(store: RecordStore): RecordEnvelope<'target_snapshot'> | null {
  const eng = store.heads('engagement')[0];
  if (!eng?.body.active_snapshot) return null;
  return store.head<'target_snapshot'>(eng.body.active_snapshot.record_id) ?? null;
}

const cache = new Map<string, unknown>();
function cached<T>(archive: Archive, d: string, load: () => T): T {
  const k = `${archive.root}|${d}`;
  if (cache.has(k)) return cache.get(k) as T;
  const v = load();
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  cache.set(k, v);
  return v;
}

export function loadInventory(archive: Archive, snap: TargetSnapshotBody): Inventory | null {
  if (!snap.inventory) return null;
  return cached(archive, snap.inventory.artifact, () => archive.getJson<Inventory>(snap.inventory!.artifact));
}

export function loadLayouts(archive: Archive, snap: TargetSnapshotBody): StorageLayouts | null {
  if (!snap.storage_layouts) return null;
  return cached(archive, snap.storage_layouts.artifact, () => archive.getJson<StorageLayouts>(snap.storage_layouts!.artifact));
}

export function treeFiles(archive: Archive, snap: TargetSnapshotBody): Record<string, string> {
  return cached(archive, snap.tree.artifact, () => archive.getTree(snap.tree.artifact)).files;
}

/** Build state of a snapshot, for probes that need compiler output. */
export function buildState(snap: TargetSnapshotBody): 'completed' | 'failed' | 'pending' {
  const b = snap.build as { status?: string; unknown?: true };
  if (!b || (b as { unknown?: true }).unknown) return 'pending';
  if (b.status === 'completed') return snap.inventory ? 'completed' : 'failed';
  if (b.status === 'queued' || b.status === 'running') return 'pending';
  return 'failed';
}

/** Sequence of the event that created revision 1 of each record (creation order). */
export function creationSeq(store: RecordStore): Map<string, number> {
  const m = new Map<string, number>();
  for (const ev of store.events()) {
    for (const r of ev.records) if (r.revision === 1 && !m.has(r.record_id)) m.set(r.record_id, ev.seq);
  }
  return m;
}
