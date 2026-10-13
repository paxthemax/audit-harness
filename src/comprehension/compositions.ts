import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { defineOperation } from '../controller/controller.ts';
import type { RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { callableByKey, type Callable, type Inventory } from '../snapshot/inventory.ts';
import { activeSnapshotOf, loadInventory } from '../snapshot/common.ts';

// Compositions and function coverage (FR-36, FR-34; design/harness-auditor-guide.md, "Build enough
// shared understanding"). Two flows whose functions write the same store produce a `composition` unit
// with its own review status. Every in-scope function that maps to no unit, or that the auditor never
// reviewed, is a visible coverage gap at closure.

/** Match a unit's function name ("Vault.withdraw", "Vault.withdraw(uint256)") to inventory callables. */
function matches(c: Callable, name: string): boolean {
  return c.symbol === name || `${c.contract}.${c.name}` === name;
}

function sourceCallables(inv: Inventory): Callable[] {
  return inv.contracts.filter((c) => c.origin === 'source' && c.kind !== 'interface').flatMap((c) => c.functions);
}

/** Storage written by a callable, following internal calls (direct writes only are in the inventory). */
export function transitiveWrites(inv: Inventory, root: Callable): Set<string> {
  const byKey = callableByKey(inv);
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (c: Callable) => {
    if (seen.has(c.key)) return;
    seen.add(c.key);
    for (const w of c.writes) out.add(w);
    for (const e of c.internal_calls) {
      const callee = byKey.get(e.ref);
      if (callee) visit(callee);
    }
    for (const m of c.modifiers) {
      const mod = m.ref ? byKey.get(m.ref) : undefined;
      if (mod) visit(mod);
    }
  };
  visit(root);
  return out;
}

function unitCallables(inv: Inventory, unit: RecordEnvelope<'audit_unit'>): Callable[] {
  const names = [...unit.body.functions.map((f) => f.name), ...unit.body.entry_points];
  return sourceCallables(inv).filter((c) => names.some((n) => matches(c, n)));
}

export interface CompositionCandidate {
  flows: [string, string];
  store: string;
  writers: string[];
}

export function compositionCandidates(store: RecordStore, inv: Inventory): CompositionCandidate[] {
  const flows = store.heads('audit_unit').filter((u) => u.body.kind === 'flow' && u.body.review_status !== 'excluded');
  const writes = flows.map((f) => {
    const map = new Map<string, string[]>();
    for (const c of unitCallables(inv, f)) for (const w of transitiveWrites(inv, c)) map.set(w, [...(map.get(w) ?? []), c.symbol]);
    return { flow: f, map };
  });
  const out: CompositionCandidate[] = [];
  for (let i = 0; i < writes.length; i++) {
    for (let j = i + 1; j < writes.length; j++) {
      for (const [st, writersA] of writes[i].map) {
        const writersB = writes[j].map.get(st);
        if (writersB) out.push({ flows: [writes[i].flow.record_id, writes[j].flow.record_id], store: st, writers: [...new Set([...writersA, ...writersB])].sort() });
      }
    }
  }
  return out;
}

const compositionName = (c: CompositionCandidate) => `composition ${c.flows.join(' + ')} via ${c.store}`;

defineOperation<Record<string, never>>({
  name: 'derive_compositions',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx) {
    const snap = activeSnapshotOf(ctx.store);
    if (!snap) fail('invalid_request', 'no active snapshot');
    const inv = loadInventory(ctx.archive, snap.body);
    if (!inv) fail('unsupported', 'the active snapshot has no inventory (a failed or pending build); compositions cannot be derived', { details: { snapshot: snap.record_id } });
    const existing = new Set(ctx.store.heads('audit_unit').map((u) => u.body.name));
    const created: Ref[] = [];
    const candidates = compositionCandidates(ctx.store, inv);
    for (const c of candidates) {
      const name = compositionName(c);
      if (existing.has(name)) continue;
      existing.add(name);
      created.push(
        ctx.tx.create('audit_unit', {
          kind: 'composition',
          name,
          entry_points: [],
          state_writers: c.writers,
          dependencies: c.flows,
          risk_rationale: `Flows ${c.flows.join(' and ')} both write ${c.store}`,
          planned_methods: [],
          lead_generator_coverage: [],
          functions: c.writers.map((w) => ({ name: w, reviewed: false })),
          reviewed_revision: null,
          review_status: 'not_started',
          first_presentation: null,
          evidence: [],
          gaps: [],
        }),
      );
    }
    return { created, candidates: candidates.length, limitations: ['Writes through local storage pointers and configuration writers/callback entry points are not yet mapped mechanically'] };
  },
});

/** FR-34: in-scope functions that map to no unit, and mapped functions the auditor never reviewed. */
export function functionCoverage(store: RecordStore): { unmapped: string[]; unreviewed: string[]; available: boolean } {
  const snap = activeSnapshotOf(store);
  const inv = snap ? loadInventory(store.archive, snap.body) : null;
  if (!inv) return { unmapped: [], unreviewed: [], available: false };
  const units = store.heads('audit_unit').filter((u) => u.body.review_status !== 'excluded');
  const unmapped: string[] = [];
  const unreviewed: string[] = [];
  for (const c of sourceCallables(inv)) {
    if (!['external', 'public'].includes(c.visibility) || !['function', 'fallback', 'receive'].includes(c.kind)) continue;
    const mapped = units.flatMap((u) => u.body.functions.filter((f) => matches(c, f.name)));
    if (!mapped.length) unmapped.push(c.symbol);
    else if (!mapped.some((f) => f.reviewed)) unreviewed.push(c.symbol);
  }
  return { unmapped: unmapped.sort(), unreviewed: unreviewed.sort(), available: true };
}

defineOperation<Record<string, never>>({
  name: 'function_coverage',
  channels: ['auditor', 'screen', 'worker', 'controller'],
  mutating: false,
  handler(ctx) {
    return functionCoverage(ctx.store);
  },
});
