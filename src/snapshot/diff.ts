// Snapshot diffs (design/harness-state-and-execution.md, "Evidence invalidation and revision
// changes": review each revision forward from its diff). File-level changes are always computed;
// function, modifier, inheritance and storage-layout changes when both snapshots have a compiler
// inventory. Every change maps to a fix assessment, a reviewed audit unit, or an unreviewed-change
// gap printed beside the fix status.

import { unknown, type Ref } from '../core/refs.ts';
import type { Archive } from '../store/archive.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { Anchor, DiffChangeKind, SnapshotDiffBody, TargetSnapshotBody } from '../schema/records.ts';
import { loadInventory, loadLayouts, treeFiles } from './common.ts';
import type { Callable, Inventory, InventoryContract, StorageSlotEntry } from './inventory.ts';

export type DiffChange = Omit<SnapshotDiffBody['changes'][number], 'mapping'>;
export type MappedChange = SnapshotDiffBody['changes'][number];

const isUnknown = (v: unknown): boolean => !!v && typeof v === 'object' && (v as { unknown?: unknown }).unknown === true;

/** Contracts whose functions are diffed: target sources and dependencies, not tests or scripts. */
function diffable(c: InventoryContract): boolean {
  return c.origin === 'source' || c.origin === 'dependency';
}

function callablesOf(inv: Inventory): Map<string, { c: InventoryContract; f: Callable }> {
  const m = new Map<string, { c: InventoryContract; f: Callable }>();
  for (const c of inv.contracts) {
    if (!diffable(c)) continue;
    for (const f of [...c.functions, ...c.modifiers]) m.set(f.key, { c, f });
  }
  return m;
}

function layoutDetail(contract: string, before: StorageSlotEntry[], after: StorageSlotEntry[]): string {
  const fmt = (e: StorageSlotEntry) => `${e.label}:${e.type}@${e.slot}+${e.offset}${e.declared_in !== contract ? ` (from ${e.declared_in})` : ''}`;
  const b = new Map(before.map((e) => [`${e.slot}+${e.offset}`, e]));
  const a = new Map(after.map((e) => [`${e.slot}+${e.offset}`, e]));
  const parts: string[] = [];
  const inherited = new Set<string>();
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(k);
    const y = a.get(k);
    if (x && y && x.label === y.label && x.type === y.type && x.declared_in === y.declared_in) continue;
    parts.push(`slot ${k}: ${x ? fmt(x) : '(empty)'} -> ${y ? fmt(y) : '(empty)'}`);
    for (const e of [x, y]) if (e && e.declared_in !== contract) inherited.add(e.declared_in);
  }
  const head = inherited.size ? `INHERITED storage layout change (from ${[...inherited].sort().join(', ')}); ` : '';
  return head + parts.slice(0, 12).join('; ') + (parts.length > 12 ? `; … ${parts.length - 12} more` : '');
}

/** Compute the unmapped changes between two snapshots. */
export function computeChanges(archive: Archive, prior: TargetSnapshotBody, next: TargetSnapshotBody): { changes: DiffChange[]; function_level: boolean } {
  const changes: DiffChange[] = [];
  const pf = treeFiles(archive, prior);
  const nf = treeFiles(archive, next);
  for (const p of [...new Set([...Object.keys(pf), ...Object.keys(nf)])].sort()) {
    if (!(p in nf)) changes.push({ kind: 'file', item: p, change: 'removed', detail: null });
    else if (!(p in pf)) changes.push({ kind: 'file', item: p, change: 'added', detail: null });
    else if (pf[p] !== nf[p]) changes.push({ kind: 'file', item: p, change: 'modified', detail: null });
  }

  // Dependencies and vendored status.
  const pd = new Map(prior.dependencies.map((d) => [d.path, d]));
  const nd = new Map(next.dependencies.map((d) => [d.path, d]));
  for (const p of [...new Set([...pd.keys(), ...nd.keys()])].sort()) {
    const a = pd.get(p);
    const b = nd.get(p);
    if (!b) changes.push({ kind: 'dependency', item: p, change: 'removed', detail: null });
    else if (!a) changes.push({ kind: 'dependency', item: p, change: 'added', detail: b.remapping });
    else if (a.remapping !== b.remapping) changes.push({ kind: 'dependency', item: p, change: 'modified', detail: `remapping ${a.remapping ?? '(none)'} -> ${b.remapping ?? '(none)'}` });
  }
  const pv = new Map(prior.vendored.map((v) => [v.path, v]));
  for (const v of next.vendored) {
    const a = pv.get(v.path);
    if (!a || (a.status === v.status && JSON.stringify(a.modified_files) === JSON.stringify(v.modified_files) && JSON.stringify(a.upstream) === JSON.stringify(v.upstream))) continue;
    if (nd.has(v.path) && pd.has(v.path) && changes.some((c) => c.kind === 'dependency' && c.item === v.path)) continue;
    changes.push({ kind: 'dependency', item: v.path, change: 'modified', detail: `vendored status ${a.status} -> ${v.status}${v.modified_files.length ? ` (${v.modified_files.length} file(s) differ from upstream)` : ''}` });
  }

  // Compiler settings.
  if (!isUnknown(prior.compiler) && !isUnknown(next.compiler)) {
    const a = prior.compiler as Exclude<TargetSnapshotBody['compiler'], { unknown: true }>;
    const b = next.compiler as typeof a;
    // A declared version ("0.8.30") and the compiler's full version ("0.8.30+commit.…") are the same.
    const norm = (k: keyof typeof b, v: unknown) => (k === 'version' ? String(v).split('+')[0] : v);
    const diffs = (Object.keys(b) as (keyof typeof b)[]).filter((k) => norm(k, a[k]) !== norm(k, b[k])).map((k) => `${k}: ${a[k]} -> ${b[k]}`);
    if (diffs.length) changes.push({ kind: 'compiler', item: 'compiler', change: 'modified', detail: diffs.join('; ') });
  } else if (isUnknown(prior.compiler) !== isUnknown(next.compiler)) {
    changes.push({ kind: 'compiler', item: 'compiler', change: 'modified', detail: `compiler settings ${isUnknown(prior.compiler) ? 'unknown -> known' : 'known -> unknown'}` });
  }

  const pi = loadInventory(archive, prior);
  const ni = loadInventory(archive, next);
  if (!pi || !ni) return { changes, function_level: false };

  const pc = callablesOf(pi);
  const nc = callablesOf(ni);
  for (const k of [...new Set([...pc.keys(), ...nc.keys()])].sort()) {
    const a = pc.get(k);
    const b = nc.get(k);
    const kind: DiffChangeKind = (b ?? a)!.f.kind === 'modifier' ? 'modifier' : 'function';
    const item = (b ?? a)!.f.symbol;
    if (!b) changes.push({ kind, item, change: 'removed', detail: a!.f.path });
    else if (!a) changes.push({ kind, item, change: 'added', detail: `${b.f.path} (${b.f.visibility}${b.f.selector ? `, selector ${b.f.selector}` : ''})` });
    else if (a.f.content_digest !== b.f.content_digest || JSON.stringify(a.f.modifiers.map((m) => m.name)) !== JSON.stringify(b.f.modifiers.map((m) => m.name))) {
      const mods = JSON.stringify(a.f.modifiers.map((m) => m.name)) !== JSON.stringify(b.f.modifiers.map((m) => m.name)) ? `modifiers [${a.f.modifiers.map((m) => m.name).join(', ')}] -> [${b.f.modifiers.map((m) => m.name).join(', ')}]` : 'body changed';
      changes.push({ kind, item, change: 'modified', detail: `${b.f.path}: ${mods}` });
    }
  }

  // Inheritance (linearization) per contract, and contracts added or removed.
  const key = (c: InventoryContract) => `${c.path}:${c.name}`;
  const pcs = new Map(pi.contracts.filter(diffable).map((c) => [key(c), c]));
  const ncs = new Map(ni.contracts.filter(diffable).map((c) => [key(c), c]));
  for (const k of [...new Set([...pcs.keys(), ...ncs.keys()])].sort()) {
    const a = pcs.get(k);
    const b = ncs.get(k);
    if (!b) changes.push({ kind: 'inheritance', item: a!.name, change: 'removed', detail: `contract removed from ${a!.path}` });
    else if (!a) changes.push({ kind: 'inheritance', item: b.name, change: 'added', detail: `contract added in ${b.path}; bases: ${b.linearized.slice(1).join(', ') || 'none'}` });
    else if (a.linearized.join(',') !== b.linearized.join(',')) changes.push({ kind: 'inheritance', item: b.name, change: 'modified', detail: `linearization ${a.linearized.join(' > ')} -> ${b.linearized.join(' > ')}` });
  }

  // Storage layouts per contract, compared across every snapshot.
  const pl = loadLayouts(archive, prior);
  const nl = loadLayouts(archive, next);
  if (pl && nl) {
    for (const k of [...new Set([...Object.keys(pl.contracts), ...Object.keys(nl.contracts)])].sort()) {
      const name = k.slice(k.lastIndexOf(':') + 1);
      const path = k.slice(0, k.lastIndexOf(':'));
      const origin = (ni.contracts.find((x) => key(x) === k) ?? pi.contracts.find((x) => key(x) === k))?.origin;
      if (origin === 'test' || origin === 'script') continue;
      const a = pl.contracts[k];
      const b = nl.contracts[k];
      if (!a || !b) continue; // added/removed contracts are reported above
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      changes.push({ kind: 'storage_layout', item: name, change: 'modified', detail: `${path}: ${layoutDetail(name, a, b)}` });
    }
  }
  return { changes, function_level: true };
}

// ------------------------------------------------------------------------------------------------
// Mapping

const baseName = (s: string) => (s.includes('(') ? s.slice(0, s.indexOf('(')) : s);

function sameSymbol(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes('(') && b.includes('(')) return false;
  return baseName(a) === baseName(b);
}

function contractOf(item: string): string {
  return item.includes('.') ? item.slice(0, item.indexOf('.')) : item;
}

/**
 * A finding's affected code covers a change when it cites the changed file, or the changed function
 * or modifier by symbol. A function ADDED by a fix is never covered: it is new code.
 */
export function anchorsCover(anchors: Anchor[], ch: DiffChange): boolean {
  if (ch.change === 'added' && ch.kind !== 'file') return false;
  return anchors.some((a) => {
    if (ch.kind === 'file') return a.path === ch.item;
    if (ch.kind === 'function' || ch.kind === 'modifier') return !!a.symbol && sameSymbol(a.symbol, ch.item);
    return false;
  });
}

/**
 * Map each change to a fix assessment of `next`, a reviewed audit unit, or an unreviewed-change gap.
 * A change ADDED in `next` maps to an audit unit only if that unit was reviewed on `next` itself.
 */
export function mapChanges(store: RecordStore, archive: Archive, next: { ref: Ref; body: TargetSnapshotBody }, prior: TargetSnapshotBody, changes: DiffChange[]): MappedChange[] {
  const fixes = store
    .heads('fix_assessment')
    .filter((f) => f.body.fix_snapshot?.record_id === next.ref.record_id)
    .map((f) => {
      const finding = store.tryGet<'finding'>(f.body.finding);
      return { ref: { record_id: f.record_id, revision: f.revision }, anchors: (finding?.body.affected_code ?? []) as Anchor[] };
    });
  const units = store.heads('audit_unit').filter((u) => u.body.review_status === 'reviewed');
  const invs = [loadInventory(archive, next.body), loadInventory(archive, prior)].filter((x): x is Inventory => !!x);
  const contractsInFile = (path: string) => new Set(invs.flatMap((i) => i.contracts.filter((c) => c.path === path).map((c) => c.name)));

  const unitNames = (u: (typeof units)[number]) => [...u.body.functions.map((f) => f.name), ...u.body.entry_points];
  const unitMentionsContract = (u: (typeof units)[number], contract: string) =>
    unitNames(u).some((n) => n === contract || n.startsWith(contract + '.')) || u.body.dependencies.includes(contract) || u.body.state_writers.some((n) => n.startsWith(contract + '.'));

  return changes.map((ch) => {
    const added = ch.change === 'added';
    // 1. Fix assessments of this snapshot whose finding cites the changed code.
    if (!added || ch.kind === 'file') {
      for (const f of fixes) {
        if (anchorsCover(f.anchors, ch)) return { ...ch, mapping: { kind: 'fix_assessment', ref: f.ref } };
      }
    }
    // 2. Reviewed audit units.
    for (const u of units) {
      if (added && u.body.reviewed_revision?.snapshot.record_id !== next.ref.record_id) continue;
      let hit = false;
      switch (ch.kind) {
        case 'function':
        case 'modifier':
          hit = unitNames(u).some((n) => sameSymbol(n, ch.item));
          break;
        case 'file': {
          const cs = contractsInFile(ch.item);
          hit = u.body.dependencies.includes(ch.item) || u.body.entry_points.includes(ch.item) || [...cs].some((c) => unitNames(u).some((n) => n.startsWith(c + '.')));
          break;
        }
        case 'storage_layout':
          hit = u.body.kind === 'upgrade_and_storage_layout' && unitMentionsContract(u, contractOf(ch.item));
          break;
        case 'inheritance':
          hit = unitMentionsContract(u, contractOf(ch.item));
          break;
        default:
          hit = u.body.dependencies.includes(ch.item);
      }
      if (hit) return { ...ch, mapping: { kind: 'audit_unit', ref: { record_id: u.record_id, revision: u.revision } } };
    }
    return { ...ch, mapping: { kind: 'unreviewed_change_gap', ref: null } };
  });
}

export function buildDiffBody(
  store: RecordStore,
  archive: Archive,
  prior: { ref: Ref; body: TargetSnapshotBody },
  next: { ref: Ref; body: TargetSnapshotBody },
): { body: SnapshotDiffBody; function_level: boolean } {
  const { changes, function_level } = computeChanges(archive, prior.body, next.body);
  const deployedKnown = !isUnknown(next.body.deployment);
  return {
    body: {
      prior: prior.ref,
      next: next.ref,
      deployed_comparison: deployedKnown
        ? unknown('deployment addresses are recorded, but comparison with deployed bytecode needs a fork job; not performed by the walking skeleton')
        : unknown('no deployed implementation known (source-only snapshot)'),
      changes: mapChanges(store, archive, next, prior.body, changes),
    },
    function_level,
  };
}

/** Changes printed as gaps (for the screen and report). */
export function gaps(body: SnapshotDiffBody): MappedChange[] {
  return body.changes.filter((c) => c.mapping.kind === 'unreviewed_change_gap');
}
