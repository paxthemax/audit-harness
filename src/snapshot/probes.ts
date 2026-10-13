// Dependency probes (DEC-008, Q-019; design/harness-state-and-execution.md, "Evidence invalidation
// and revision changes"; glossary "Dependency probe"). A probe is a check that can be re-run,
// recorded with a consequential conclusion:
//   code_hash         digest of the exact source bytes of a symbol (located by the compiler
//                     inventory's `src` ranges) plus its modifiers and statically resolved internal
//                     callees, or of a whole file;
//   structural_query  a declared regex over named paths, or a selection from the inventory;
//   storage_layout    a contract's storage layout;
//   config_value      a key from foundry.toml, the deployment record or the compiler settings;
//   witness_rerun / property_rerun
//                     re-execution as a `probe` job under the engagement's `revalidation`
//                     authorization; the outcome digest is result type plus per-test statuses.
// Every probe records what it cannot observe. "No changed probe" is not proof of irrelevance.

import { fail } from '../core/errors.ts';
import { digestJson } from '../core/hash.ts';
import type { Ref } from '../core/refs.ts';
import { PROBE_KINDS, type ProbeKind } from '../core/values.ts';
import { defineOperation } from '../controller/controller.ts';
import type { Archive } from '../store/archive.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { DependencyProbeBody, JobPurpose, RecordEnvelope, StructuredResult } from '../schema/records.ts';
import { activeSnapshot, buildState, isConclusionType, loadInventory, loadLayouts, treeFiles, type SnapshotView } from './common.ts';
import { CALLER_TARGETS, callableByKey, resolveSymbol, resolveVirtual, type Callable, type Inventory, type InventoryContract } from './inventory.ts';
import { parseToml, tomlGet } from './source.ts';

export interface ProbeEval {
  status: DependencyProbeBody['status'];
  digest: string | null;
  summary: string | null;
  cannot_observe: string[];
}

const RERUN_KINDS: ProbeKind[] = ['witness_rerun', 'property_rerun'];
export const isRerun = (k: ProbeKind) => RERUN_KINDS.includes(k);

function pendingBuild(snap: SnapshotView, what: string): ProbeEval {
  const st = buildState(snap.body);
  if (st === 'failed') return { status: 'unevaluable', digest: null, summary: `the build of ${snap.ref.record_id} failed; no compiler inventory for ${what}`, cannot_observe: [] };
  return { status: 'pending', digest: null, summary: `awaiting the build of ${snap.ref.record_id} (compiler inventory needed for ${what})`, cannot_observe: [] };
}

// ------------------------------------------------------------------------------------------------
// code_hash

function sourceBytes(archive: Archive, snap: SnapshotView, path: string): Buffer | null {
  const d = treeFiles(archive, snap.body)[path];
  return d ? archive.get(d) : null;
}

/** The symbol plus its modifiers and statically resolved internal callees, transitively. */
export function symbolClosure(inv: Inventory, ctxContract: InventoryContract, root: Callable): { members: Callable[]; unobserved: string[] } {
  const byKey = callableByKey(inv);
  const seen = new Map<string, Callable>();
  const unobserved = new Set<string>();
  const queue: Callable[] = [root];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f.key)) continue;
    seen.set(f.key, f);
    const deps: { ref: string | null; name: string; signature: string; virtual: boolean; modifier: boolean }[] = [
      ...f.modifiers.map((m) => ({ ref: m.ref, name: m.name, signature: m.ref ? m.ref.slice(m.ref.lastIndexOf('.') + 1) : `${m.name}()`, virtual: m.virtual, modifier: true })),
      ...f.internal_calls.map((e) => ({ ref: e.ref, name: e.name, signature: e.signature, virtual: e.virtual, modifier: false })),
    ];
    for (const d of deps) {
      let target: Callable | null | undefined = d.ref ? byKey.get(d.ref) : null;
      if (d.virtual) target = resolveVirtual(inv, ctxContract, d.name, d.signature, d.modifier) ?? target;
      if (!target) {
        // A base without an explicit constructor has no code to observe.
        if (d.name !== 'constructor') unobserved.add(`unresolved call edge from ${f.symbol} to ${d.name}`);
        continue;
      }
      if (!target.implemented) {
        unobserved.add(`${target.symbol} has no implementation in the inventory`);
        continue;
      }
      queue.push(target);
    }
  }
  return { members: [...seen.values()], unobserved: [...unobserved] };
}

/** What a set of code members cannot observe: callee code outside them, assembly, dynamic edges. */
export function cannotObserve(members: Callable[]): string[] {
  const out = new Set<string>();
  for (const f of members) {
    for (const e of f.external_calls) out.add(`external call ${e} in ${f.symbol} (callee code not observed)`);
    for (const l of f.low_level_calls) {
      if (l.kind === 'delegatecall' || l.kind === 'callcode') out.add(`${l.kind} to ${l.target} in ${f.symbol} (executed code not observed)`);
      else if (l.in_assembly) out.add(`low-level ${l.kind} in assembly in ${f.symbol} (target not observed)`);
      else if (!CALLER_TARGETS.has(l.target)) out.add(`low-level ${l.kind} to ${l.target} in ${f.symbol} (callee code not observed)`);
    }
    for (const a of f.assembly) out.add(`inline assembly in ${f.symbol} at ${a.start}:${a.length} (semantics not modelled)`);
    for (const u of f.unresolved_calls) out.add(`${u} in ${f.symbol} (dynamic call edge unresolved)`);
  }
  return [...out].sort();
}

function evalCodeHash(archive: Archive, snap: SnapshotView, q: Record<string, unknown>): ProbeEval {
  const path = typeof q.path === 'string' ? q.path : null;
  const symbol = typeof q.symbol === 'string' ? q.symbol : null;
  const include = q.include === 'symbol' ? 'symbol' : 'closure';
  if (!symbol) {
    if (!path) return { status: 'unevaluable', digest: null, summary: 'code_hash needs a path or a symbol', cannot_observe: [] };
    const d = treeFiles(archive, snap.body)[path];
    return d
      ? { status: 'evaluated', digest: d, summary: `file ${path}`, cannot_observe: [] }
      : { status: 'evaluated', digest: digestJson({ absent: path }), summary: `file ${path} is absent`, cannot_observe: [] };
  }
  const inv = loadInventory(archive, snap.body);
  if (!inv) return pendingBuild(snap, symbol);
  const r = resolveSymbol(inv, symbol, path);
  if ('error' in r) return { status: 'unevaluable', digest: null, summary: `symbol not located: ${r.error}`, cannot_observe: [] };
  let members: Callable[] = [];
  let unobserved: string[] = [];
  let parts: [string, string | null][] = [];
  if (!r.callable) {
    // Whole contract plus its bases.
    const cs = [r.contract, ...r.contract.linearized.slice(1).map((n) => inv.contracts.find((c) => c.name === n)).filter((c): c is InventoryContract => !!c)];
    parts = cs.map((c) => [`${c.path}:${c.name}`, c.content_digest]);
    members = cs.flatMap((c) => [...c.functions, ...c.modifiers]);
  } else if (include === 'symbol') {
    members = [r.callable];
    parts = [[r.callable.key, r.callable.content_digest]];
    unobserved = [...r.callable.modifiers.map((m) => `modifier ${m.name} body (include=symbol)`), ...r.callable.internal_calls.map((e) => `internal callee ${e.name} body (include=symbol)`)];
  } else {
    const cl = symbolClosure(inv, r.contract, r.callable);
    members = cl.members;
    unobserved = cl.unobserved;
    parts = members.map((m) => [m.key, m.content_digest]);
  }
  if (parts.some(([, d]) => d === null)) {
    return { status: 'unevaluable', digest: null, summary: `source bytes for ${symbol} are not in the snapshot`, cannot_observe: [] };
  }
  // Cross-check the recorded digest against the frozen bytes (compiler ranges must match the tree).
  if (r.callable) {
    const bytes = sourceBytes(archive, snap, r.callable.path);
    if (!bytes || r.callable.src.start + r.callable.src.length > bytes.length) {
      return { status: 'unevaluable', digest: null, summary: `compiler range for ${symbol} does not fit ${r.callable.path} in the snapshot`, cannot_observe: [] };
    }
  }
  parts.sort((a, b) => a[0].localeCompare(b[0]));
  const label = r.callable ? r.callable.symbol : r.contract.name;
  return {
    status: 'evaluated',
    digest: digestJson(parts),
    summary: `${label}${parts.length > 1 ? ` with ${parts.length - 1} dependenc${parts.length === 2 ? 'y' : 'ies'} (${parts.slice(0, 6).map(([k]) => k.slice(k.lastIndexOf(':') + 1)).filter((k) => k !== label).join(', ')})` : ''}`,
    cannot_observe: [...new Set([...unobserved, ...cannotObserve(members)])].sort(),
  };
}

// ------------------------------------------------------------------------------------------------
// structural_query

const INVENTORY_SELECTIONS = ['functions', 'modifiers', 'storage', 'low_level_calls', 'assembly', 'entry_points', 'inheritance'] as const;

function evalStructural(archive: Archive, snap: SnapshotView, q: Record<string, unknown>): ProbeEval {
  if (typeof q.select === 'string') {
    const sel = q.select as (typeof INVENTORY_SELECTIONS)[number];
    if (!INVENTORY_SELECTIONS.includes(sel)) return { status: 'unevaluable', digest: null, summary: `unknown inventory selection ${sel}`, cannot_observe: [] };
    const inv = loadInventory(archive, snap.body);
    if (!inv) return pendingBuild(snap, `inventory selection ${sel}`);
    const contract = typeof q.contract === 'string' ? q.contract : null;
    const cs = inv.contracts.filter((c) => (contract ? c.name === contract : c.origin === 'source'));
    if (contract && !cs.length) return { status: 'unevaluable', digest: null, summary: `contract ${contract} is not in the inventory`, cannot_observe: [] };
    // Source offsets are left out: they move with unrelated edits.
    const rows = cs.flatMap((c): object[] => {
      switch (sel) {
        case 'functions':
          return c.functions.map((f) => ({ c: c.name, s: f.signature, v: f.visibility, m: f.mutability, mods: f.modifiers.map((x) => x.name) }));
        case 'modifiers':
          return c.modifiers.map((f) => ({ c: c.name, s: f.signature }));
        case 'storage':
          return c.storage_variables.map((v) => ({ c: c.name, n: v.name, t: v.type, mu: v.mutability }));
        case 'low_level_calls':
          return c.low_level_calls.map((l) => ({ c: c.name, in: l.in, k: l.kind, t: l.target }));
        case 'assembly':
          return c.assembly.map((a) => ({ c: c.name, in: a.in }));
        case 'entry_points':
          return c.entry_points.map((e) => ({ c: c.name, s: e.signature, sel: e.selector, d: e.declared_in }));
        case 'inheritance':
          return [{ c: c.name, l: c.linearized }];
      }
    });
    const sorted = rows.map((r) => JSON.stringify(r)).sort();
    return { status: 'evaluated', digest: digestJson(sorted), summary: `${sorted.length} ${sel} row(s)${contract ? ` of ${contract}` : ''}`, cannot_observe: [] };
  }
  if (typeof q.pattern !== 'string' || !Array.isArray(q.paths) || !q.paths.length) {
    return { status: 'unevaluable', digest: null, summary: 'structural_query needs {pattern, paths} or {select}', cannot_observe: [] };
  }
  let re: RegExp;
  try {
    re = new RegExp(q.pattern, `g${typeof q.flags === 'string' ? q.flags.replace(/[^imsu]/g, '') : ''}`);
  } catch (e) {
    return { status: 'unevaluable', digest: null, summary: `invalid pattern: ${(e as Error).message}`, cannot_observe: [] };
  }
  const files = treeFiles(archive, snap.body);
  const paths = (q.paths as unknown[]).map(String);
  const selected = Object.keys(files)
    .filter((f) => paths.some((p) => f === p || f.startsWith(p.replace(/\/$/, '') + '/')))
    .sort();
  const matches: string[] = [];
  for (const f of selected) {
    const text = archive.getText(files[f]);
    for (const m of text.matchAll(re)) matches.push(`${f}\u0000${m[0]}`);
  }
  matches.sort();
  const missing = paths.filter((p) => !selected.some((f) => f === p || f.startsWith(p.replace(/\/$/, '') + '/')));
  return {
    status: 'evaluated',
    digest: digestJson({ files: selected.length, matches }),
    summary: `${matches.length} match(es) in ${selected.length} file(s)${missing.length ? `; absent: ${missing.join(', ')}` : ''}`,
    cannot_observe: [],
  };
}

// ------------------------------------------------------------------------------------------------
// storage_layout and config_value

function evalStorage(archive: Archive, snap: SnapshotView, q: Record<string, unknown>): ProbeEval {
  if (typeof q.contract !== 'string') return { status: 'unevaluable', digest: null, summary: 'storage_layout needs a contract', cannot_observe: [] };
  const layouts = loadLayouts(archive, snap.body);
  if (!layouts) return pendingBuild(snap, `the storage layout of ${q.contract}`);
  const c = q.contract;
  const keys = Object.keys(layouts.contracts).filter((k) => k === c || k.endsWith(':' + c));
  if (keys.length !== 1) {
    return { status: 'unevaluable', digest: null, summary: keys.length ? `contract ${c} is ambiguous (${keys.join(', ')}); use <path>:<Contract>` : `no storage layout for ${c}`, cannot_observe: [] };
  }
  const entries = layouts.contracts[keys[0]];
  return { status: 'evaluated', digest: digestJson(entries), summary: `${keys[0]}: ${entries.length} slot entr${entries.length === 1 ? 'y' : 'ies'}`, cannot_observe: [] };
}

function getPath(v: unknown, key: string): { found: boolean; value: unknown } {
  let o: unknown = v;
  for (const k of key.split('.')) {
    if (Array.isArray(o)) {
      const byName = o.find((x) => x && typeof x === 'object' && (x as { name?: unknown }).name === k);
      if (byName !== undefined) o = byName;
      else if (/^\d+$/.test(k) && Number(k) < o.length) o = o[Number(k)];
      else return { found: false, value: undefined };
    } else if (o && typeof o === 'object' && k in (o as object)) o = (o as Record<string, unknown>)[k];
    else return { found: false, value: undefined };
  }
  return { found: true, value: o };
}

function evalConfig(archive: Archive, snap: SnapshotView, q: Record<string, unknown>): ProbeEval {
  const source = typeof q.source === 'string' ? q.source : 'foundry.toml';
  const key = typeof q.key === 'string' ? q.key : null;
  if (!key) return { status: 'unevaluable', digest: null, summary: 'config_value needs a key', cannot_observe: [] };
  let base: unknown;
  const unk = (v: unknown) => !!v && typeof v === 'object' && (v as { unknown?: unknown }).unknown === true;
  if (source === 'foundry.toml') {
    const d = treeFiles(archive, snap.body)['foundry.toml'];
    base = d ? parseToml(archive.getText(d)) : {};
    if (!d) return { status: 'evaluated', digest: digestJson({ absent: 'foundry.toml' }), summary: 'foundry.toml is absent', cannot_observe: ['effective values come from tool defaults'] };
    const v = tomlGet(base as Record<string, never>, key);
    if (v === undefined) return { status: 'evaluated', digest: digestJson({ absent: key }), summary: `${key} is not set`, cannot_observe: [`effective default of ${key} depends on the tool version`] };
    return { status: 'evaluated', digest: digestJson({ value: v }), summary: `${key} = ${JSON.stringify(v)}`, cannot_observe: [] };
  }
  if (source === 'deployment' || source === 'fork' || source === 'compiler') {
    base = snap.body[source];
    if (unk(base)) {
      if (source === 'compiler' && buildState(snap.body) === 'pending') return pendingBuild(snap, 'compiler settings');
      return { status: 'unevaluable', digest: null, summary: `${source} is unknown for ${snap.ref.record_id}: ${(base as { reason: string }).reason}`, cannot_observe: [] };
    }
    const r = getPath(base, key);
    if (!r.found) return { status: 'evaluated', digest: digestJson({ absent: key }), summary: `${source}.${key} is absent`, cannot_observe: [] };
    return { status: 'evaluated', digest: digestJson({ value: r.value }), summary: `${source}.${key} = ${JSON.stringify(r.value)}`, cannot_observe: [] };
  }
  return { status: 'unevaluable', digest: null, summary: `unknown config source ${source} (use foundry.toml, deployment, fork or compiler)`, cannot_observe: [] };
}

// ------------------------------------------------------------------------------------------------
// Reruns

/** Outcome digest of a rerun: the result type plus each test's status. */
export function rerunOutcome(r: StructuredResult | null): { digest: string | null; summary: string } {
  if (!r) return { digest: null, summary: 'no structured result' };
  const tests = r.tests.map((t) => ({ name: t.name, status: t.status })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    digest: digestJson({ result_type: r.result_type, tests }),
    summary: `${r.result_type}; ${tests.map((t) => `${t.name}=${t.status}`).join(', ') || 'no tests'}`,
  };
}

export interface ProbeJobSpec {
  adapter: string;
  operation: string;
  args: Record<string, unknown>;
  fixture: { artifact: string } | null;
  /** Per-job limits carried from the baseline experiment (within the revalidation allowance). */
  limits: { runtime_seconds?: number };
  purpose: JobPurpose;
  snapshot: Ref;
  /** The probe this job evaluates; attach the queued job with `attachProbeJob`. */
  probe: Ref;
}

/**
 * Request spec for a witness/property rerun on `snapshot`, to be passed to the runner's
 * `request_job` under the engagement's `revalidation` authorization. The query fixes the adapter
 * (default `forge_test`), operation and arguments when the probe is recorded.
 */
export function rerunJobSpec(probe: RecordEnvelope<'dependency_probe'>, snapshot: Ref): ProbeJobSpec {
  if (!isRerun(probe.body.kind)) fail('invalid_request', `probe ${probe.record_id} is a ${probe.body.kind}, not a rerun`);
  const q = probe.body.query;
  return {
    adapter: typeof q.adapter === 'string' ? q.adapter : 'forge_test',
    operation: typeof q.operation === 'string' ? q.operation : 'test',
    args: (q.args && typeof q.args === 'object' ? q.args : {}) as Record<string, unknown>,
    fixture: q.fixture && typeof (q.fixture as { artifact?: unknown }).artifact === 'string' ? { artifact: (q.fixture as { artifact: string }).artifact } : null,
    limits: q.limits && typeof (q.limits as { runtime_seconds?: unknown }).runtime_seconds === 'number' ? { runtime_seconds: (q.limits as { runtime_seconds: number }).runtime_seconds } : {},
    purpose: 'probe',
    snapshot,
    probe: { record_id: probe.record_id, revision: probe.revision },
  };
}

/** Rerun probes waiting for a job on the active snapshot, with their request specs. */
export function pendingReruns(store: RecordStore): ProbeJobSpec[] {
  const eng = store.heads('engagement')[0];
  const active = eng?.body.active_snapshot ? store.head(eng.body.active_snapshot.record_id) : undefined;
  if (!active) return [];
  return store
    .heads('dependency_probe')
    .filter((p) => isRerun(p.body.kind) && !p.body.superseded_by && p.body.status === 'pending' && p.body.job === null)
    .map((p) => rerunJobSpec(p, { record_id: active.record_id, revision: active.revision }));
}

// ------------------------------------------------------------------------------------------------
// Dispatcher

export function evaluateProbe(archive: Archive, snap: SnapshotView, kind: ProbeKind, query: Record<string, unknown>): ProbeEval {
  switch (kind) {
    case 'code_hash':
      return evalCodeHash(archive, snap, query);
    case 'structural_query':
      return evalStructural(archive, snap, query);
    case 'storage_layout':
      return evalStorage(archive, snap, query);
    case 'config_value':
      return evalConfig(archive, snap, query);
    case 'witness_rerun':
    case 'property_rerun':
      return { status: 'pending', digest: null, summary: `rerun on ${snap.ref.record_id} needs a probe job under the revalidation authorization`, cannot_observe: [] };
  }
}

/** Non-superseded probes attached to a conclusion. */
export function probesFor(store: RecordStore, conclusionId: string): RecordEnvelope<'dependency_probe'>[] {
  return store.heads('dependency_probe').filter((p) => p.body.conclusion?.record_id === conclusionId && !p.body.superseded_by);
}

// ------------------------------------------------------------------------------------------------
// record_probe

export interface RecordProbePayload {
  conclusion: Ref;
  kind: ProbeKind;
  query: Record<string, unknown>;
  /** For reruns: the trusted-runner evidence whose structured result is the baseline outcome. */
  baseline_evidence?: Ref | null;
  /** Probe IDs this probe replaces (they stop deciding freshness). Auditor only. */
  replaces?: string[];
}

defineOperation<RecordProbePayload>({
  name: 'record_probe',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.conclusion || !p.kind || !p.query || typeof p.query !== 'object') fail('invalid_request', 'conclusion, kind and query are required');
    if (!PROBE_KINDS.includes(p.kind)) fail('invalid_request', `unknown probe kind ${p.kind}`);
    const concl = ctx.store.get(p.conclusion);
    if (!isConclusionType(concl.type)) fail('invalid_request', `${concl.type} records do not carry dependency probes`);
    const head = ctx.store.mustHead(p.conclusion.record_id);
    if (head.revision !== p.conclusion.revision) {
      fail('revision_conflict', `conclusion ${p.conclusion.record_id} is at revision ${head.revision}`, { details: { expected: p.conclusion.revision, actual: head.revision } });
    }
    if (ctx.principal.channel === 'worker') {
      const inv = ctx.principal.grant?.investigation;
      const related =
        (concl.type === 'investigation' && inv?.record_id === concl.record_id) ||
        (concl.type === 'scenario_variant' && inv?.record_id === (concl.body as { investigation: Ref }).investigation.record_id);
      if (!related) fail('permission_denied', 'a worker may attach probes only to its granted investigation and its variants');
    }
    const snap = activeSnapshot(ctx);
    if (!snap) fail('snapshot_required', 'register a target snapshot before recording probes');

    let ev: ProbeEval;
    let job: Ref | null = null;
    if (isRerun(p.kind) && p.baseline_evidence) {
      const e = ctx.store.get<'evidence_artifact'>(p.baseline_evidence, 'evidence_artifact');
      if (e.body.producer !== 'trusted_runner') fail('invalid_request', 'a rerun baseline must come from trusted-runner evidence');
      if (e.body.snapshot?.record_id !== snap.ref.record_id) fail('invalid_request', `baseline evidence ran on ${e.body.snapshot?.record_id ?? 'no snapshot'}, not the active snapshot ${snap.ref.record_id}`);
      const o = rerunOutcome(e.body.structured_result);
      ev = { status: o.digest ? 'evaluated' : 'unevaluable', digest: o.digest, summary: o.summary, cannot_observe: [] };
      job = e.body.job;
      // The rerun repeats the baseline's exact experiment: adapter, mode, arguments and fixture.
      const base = job ? ctx.store.get<'job'>(job, 'job') : null;
      if (base) {
        p.query = {
          adapter: base.body.adapter.name,
          operation: base.body.operation,
          args: base.body.args,
          limits: { runtime_seconds: base.body.limits.runtime_seconds },
          ...(base.body.fixture ? { fixture: base.body.fixture } : {}),
          ...p.query,
        };
      }
    } else {
      ev = evaluateProbe(ctx.archive, snap, p.kind, p.query);
    }
    const body: DependencyProbeBody = {
      kind: p.kind,
      query: p.query,
      snapshot: snap.ref,
      status: ev.status,
      result_digest: ev.digest,
      result_summary: ev.summary,
      cannot_observe: ev.cannot_observe,
      conclusion: p.conclusion,
      job,
      baseline: { snapshot: snap.ref, digest: ev.status === 'evaluated' ? ev.digest : null },
      superseded_by: null,
    };
    // The conclusion is the probe's parent (in the body); only baseline evidence is a material input.
    const deps = p.baseline_evidence ? [p.baseline_evidence] : [];
    // Workers only add probes: replacing one (e.g. a guard's code_hash with a trivially unchanged
    // probe) would decide a later carry-forward, so only the auditor may supersede probes.
    if (p.replaces?.length && ctx.principal.channel !== 'auditor') {
      fail('permission_denied', 'only the auditor may replace dependency probes; workers can add probes');
    }
    const probe = ctx.tx.create('dependency_probe', body, deps);
    for (const id of p.replaces ?? []) {
      const old = ctx.tx.current<'dependency_probe'>(id, 'dependency_probe');
      if (old.body.conclusion?.record_id !== p.conclusion.record_id) fail('invalid_request', `probe ${id} belongs to another conclusion`);
      ctx.tx.revise(id, 'dependency_probe', (b) => ({ ...b, superseded_by: probe }));
    }
    return { probe, status: ev.status, result_digest: ev.digest, summary: ev.summary, cannot_observe: ev.cannot_observe };
  },
});

/** Link a queued probe job (from the runner's `request_job`) to its probe. */
export function attachProbeJob(ctx: import('../controller/controller.ts').OpContext, probeId: string, job: Ref): Ref {
  return ctx.tx.revise(probeId, 'dependency_probe', (b) => ({ ...b, job, status: 'pending' }));
}
