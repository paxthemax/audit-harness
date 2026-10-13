// register_snapshot and build ingestion (design/harness-interface-contracts.md, `register_snapshot`;
// design/harness-state-and-execution.md, "Record contracts" and "Evidence invalidation and revision
// changes"; FR-01, FR-03, FR-17, FR-34, FR-38; loop L6).
//
// register_snapshot freezes the source tree, records its identity, dependencies and declared compiler
// settings, runs the intake scan, diffs against the engagement's prior active snapshot, makes the new
// snapshot active and re-evaluates every consequential conclusion's probes. It changes no decision.
// The build is a separate `forge_build` job the runner executes in its sandbox; its completion hook
// (below) derives the inventory and storage layouts, or records a failed build as failed.

import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fail } from '../core/errors.ts';
import { unknown, type Ref } from '../core/refs.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import { onJobCompleted, setEnvironmentScanner, type CompletedJob } from '../runner/hooks.ts';
import type { SuspiciousFlagBody, TargetSnapshotBody } from '../schema/records.ts';
import { isTestOrScriptPath, scanEnvironmentReads, scanFiles } from '../intake/scan.ts';
import { engagementRecord, type SnapshotView } from './common.ts';
import { buildDiffBody } from './diff.ts';
import { deriveInventory, readOutArtifacts } from './inventory.ts';
import { freezeSource, readFoundryConfig, type UpstreamCopy } from './source.ts';
import { recomputeFreshness } from './change.ts';
import { pendingReruns } from './probes.ts';

export interface RegisterSnapshotPayload {
  path: string;
  label: string;
  include_untracked?: boolean | string[];
  deployment?: {
    chain_id: number;
    addresses: { name: string; address: string; implementation?: string | null; proxy?: boolean }[];
  } | null;
  fork?: { chain_id: number; block_number: number; block_hash: string; provenance: string } | null;
  /** Vendored path -> prefetched pristine upstream copy (path, name, version, source). */
  upstream?: Record<string, UpstreamCopy>;
}

/** Proposed build request for a registered snapshot (the runner's `request_job`; purpose `build`). */
export function buildJobSpec(snapshot: Ref): { adapter: string; operation: string; args: Record<string, unknown>; purpose: 'build'; snapshot: Ref } {
  return { adapter: 'forge_build', operation: 'build', args: {}, purpose: 'build', snapshot };
}

function predicted(ctx: OpContext, type: 'target_snapshot' | 'snapshot_diff'): Ref {
  return { record_id: ctx.store.peekNextId(type, 0), revision: 1 };
}

function same(a: Ref, b: Ref): void {
  if (a.record_id !== b.record_id || a.revision !== b.revision) {
    throw new Error(`internal: staged ref ${a.record_id}@${a.revision} differs from predicted ${b.record_id}@${b.revision}`);
  }
}

defineOperation<RegisterSnapshotPayload>({
  name: 'register_snapshot',
  // Auditor only: the controller reads the given host path, so no sandboxed worker may name one.
  channels: ['auditor'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.path || !p.label) fail('invalid_request', 'path and label are required');
    const eng = engagementRecord(ctx.store);
    const priorHead = eng.body.active_snapshot ? ctx.store.mustHead(eng.body.active_snapshot.record_id, 'target_snapshot') : null;
    const priorRef: Ref | null = priorHead ? { record_id: priorHead.record_id, revision: priorHead.revision } : null;

    const frozen = freezeSource(ctx.archive, { path: p.path, include_untracked: p.include_untracked, upstream: p.upstream });
    ctx.tx.blob(frozen.tree);
    for (const d of new Set(Object.values(frozen.manifest.files))) ctx.tx.blob(d);
    const limitations = [...frozen.limitations];

    // Deployment and fork identity (FR-01: missing deployment data is a source-only limitation).
    let deployment: TargetSnapshotBody['deployment'] = unknown('no deployment data supplied');
    let source_only = true;
    if (p.deployment) {
      const d = p.deployment;
      if (!Number.isInteger(d.chain_id) || !Array.isArray(d.addresses) || !d.addresses.length) fail('invalid_request', 'deployment needs chain_id and addresses');
      deployment = {
        chain_id: d.chain_id,
        addresses: d.addresses.map((a) => {
          if (!a?.name || !/^0x[0-9a-fA-F]{40}$/.test(a.address ?? '')) fail('invalid_request', `deployment address entry ${JSON.stringify(a?.name)} is invalid`);
          if (a.proxy && !a.implementation) limitations.push(`model gap: proxy ${a.name} (${a.address}) has no resolved implementation; implementation-specific claims are blocked`);
          return { name: a.name, address: a.address, implementation: a.implementation ?? null };
        }),
      };
      source_only = false;
    } else {
      limitations.push('source-only snapshot: no deployed addresses, proxy implementations or configuration were supplied; deployment-specific claims are blocked, source analysis continues');
    }
    let fork: TargetSnapshotBody['fork'] = unknown('no fork identity supplied');
    if (p.fork) {
      const f = p.fork;
      if (!Number.isInteger(f.chain_id) || !Number.isInteger(f.block_number) || !f.block_hash || !f.provenance) fail('invalid_request', 'fork needs chain_id, block_number, block_hash and provenance');
      fork = { chain_id: f.chain_id, block_number: f.block_number, block_hash: f.block_hash, provenance: f.provenance };
    }

    // Intake scan (FR-38). Flags are suspicious content for review; they never remove scope.
    const snapRef = predicted(ctx, 'target_snapshot');
    const diffRef = priorHead ? predicted(ctx, 'snapshot_diff') : null;
    const scan = scanFiles(Object.entries(frozen.manifest.files).map(([path, d]) => ({ path, bytes: ctx.archive.get(d) })));
    for (const s of scan.skipped) limitations.push(`intake scan: ${s}`);
    const flagRefs = scan.flags.map((f) =>
      ctx.tx.create('suspicious_flag', { snapshot: snapRef, path: f.path, offset: f.offset, line: f.line, kind: f.kind, excerpt: f.excerpt, detail: f.detail, acknowledged: null } satisfies SuspiciousFlagBody),
    );

    const body: TargetSnapshotBody = {
      label: p.label,
      source: frozen.source,
      tree: frozen.tree,
      file_count: Object.keys(frozen.manifest.files).length,
      dependencies: frozen.dependencies,
      vendored: frozen.vendored,
      compiler: frozen.compiler,
      build: unknown('build not yet run: request a forge_build job (purpose build) for this snapshot'),
      inventory: null,
      storage_layouts: null,
      deployment,
      fork,
      source_only,
      prior_snapshot: priorRef,
      diff: diffRef,
      suspicious_flags: flagRefs,
      limitations,
    };
    same(ctx.tx.create('target_snapshot', body), snapRef);
    const view: SnapshotView = { ref: snapRef, body };

    let diffSummary: Record<string, unknown> | null = null;
    if (priorHead && diffRef) {
      const d = buildDiffBody(ctx.store, ctx.archive, { ref: priorRef!, body: priorHead.body }, view);
      same(ctx.tx.create('snapshot_diff', d.body), diffRef);
      diffSummary = {
        diff: diffRef,
        changes: d.body.changes.length,
        unreviewed_change_gaps: d.body.changes.filter((c) => c.mapping.kind === 'unreviewed_change_gap').length,
        function_level: d.function_level,
      };
    }
    ctx.tx.revise(eng.record_id, 'engagement', (b) => ({ ...b, active_snapshot: snapRef }));

    const fresh = recomputeFreshness(ctx, `snapshot ${snapRef.record_id} registered`, { snapshot: view, prior: priorRef });
    ctx.tx.event('snapshot_registered', { snapshot: snapRef, prior: priorRef, flags: flagRefs.length });
    return {
      snapshot: snapRef,
      prior: priorRef,
      diff: diffSummary,
      source_only,
      suspicious_flags: flagRefs.length,
      limitations,
      freshness: countValues(fresh.outcomes.map((o) => o.value)),
      suspended: fresh.suspended,
      build_request: buildJobSpec(snapRef),
      pending_reruns: pendingReruns(ctx.store).length,
    };
  },
});

function countValues(vs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of vs) out[v] = (out[v] ?? 0) + 1;
  return out;
}

// ------------------------------------------------------------------------------------------------
// Build completion: inventory and storage layouts, or a recorded failed build (FR-03).

const BUILD_LINE = /^(build job |inventory: |model gap: .* delegatecall|compiler settings not set in foundry\.toml|foundry\.toml declared)/;

export function ingestBuild(ctx: OpContext, done: CompletedJob): void {
  // Only a build of the snapshot itself describes it: a build with a fixture or a source edit compiled
  // something else and must never rewrite the snapshot's inventory or layouts.
  if (done.job.body.fixture || done.job.body.guard_removal) return;
  const snapId = done.job.body.snapshot.record_id;
  const cur = ctx.tx.current<'target_snapshot'>(snapId, 'target_snapshot');
  const jobRef: Ref = { record_id: done.job.record_id, revision: done.job.revision };
  const out = done.evidenceBody?.receipt?.outputs.find((o) => o.path === 'out' || o.path === 'out/') ?? null;
  const r = done.evidenceBody?.structured_result ?? null;
  const ok = done.job.body.status === 'completed' && done.evidenceBody?.receipt?.exit_code === 0 && !!out && r?.result_type !== 'error';
  const limitations = cur.body.limitations.filter((l) => !BUILD_LINE.test(l));
  let next: TargetSnapshotBody;

  if (!ok) {
    const why = !done.evidenceBody
      ? `no evidence (${done.job.body.status})`
      : done.evidenceBody.receipt?.exit_code !== 0
        ? `exit code ${done.evidenceBody.receipt?.exit_code ?? 'none'}${done.evidenceBody.receipt?.timed_out ? ', timed out' : ''}`
        : !out
          ? 'no out/ tree in the receipt'
          : (r?.interpretation ?? 'error');
    limitations.push(`build job ${done.job.record_id} failed (${why}): no compiler inventory, storage layouts or symbol-level probes for this snapshot; a failed build is never a clean analysis result`);
    next = {
      ...cur.body,
      build: { job: jobRef, status: done.job.body.status === 'completed' ? 'failed' : done.job.body.status, artifacts: out?.artifact ?? null },
      inventory: null,
      storage_layouts: null,
      limitations,
    };
  } else {
    const files = ctx.archive.getTree(cur.body.tree.artifact).files;
    const cfgD = files['foundry.toml'];
    const cfg = readFoundryConfig(cfgD ? ctx.archive.getText(cfgD) : null);
    const { artifacts, problems } = readOutArtifacts(ctx.archive, out!.artifact.artifact);
    const { inventory, layouts } = deriveInventory(artifacts, {
      sourceBytes: (path) => (files[path] ? ctx.archive.get(files[path]) : null),
      testDirs: [cfg.test],
      scriptDirs: [cfg.script],
      libDirs: [...cfg.libs, 'node_modules'],
    });
    inventory.problems.unshift(...problems);
    for (const pr of inventory.problems) limitations.push(`inventory: ${pr}`);
    if (!inventory.contracts.some((c) => c.origin === 'source')) limitations.push('inventory: the build produced no in-scope source contracts');
    // Unresolved proxy implementations are model gaps.
    const deployed = (cur.body.deployment as { addresses?: { name: string; implementation: string | null }[] }).addresses ?? [];
    for (const c of inventory.contracts) {
      if (c.origin !== 'source') continue;
      const fb = c.functions.find((f) => f.kind === 'fallback');
      if (fb && fb.low_level_calls.some((l) => l.kind === 'delegatecall') || (fb && fb.assembly.length && fb.low_level_calls.some((l) => l.in_assembly))) {
        const d = deployed.find((a) => a.name === c.name);
        if (!d?.implementation) limitations.push(`model gap: ${c.name} forwards calls by delegatecall in its fallback and its implementation is unresolved; an upgrade_and_storage_layout audit unit is mandatory`);
      }
    }
    const inv = ctx.archive.putJson(inventory);
    const sl = ctx.archive.putJson(layouts);
    ctx.tx.blob(inv);
    ctx.tx.blob(sl);
    const declared = cur.body.compiler as { unknown?: true; version?: string; evm_version?: string };
    const actual = inventory.compiler;
    if (actual && !declared.unknown && declared.version && !actual.version.startsWith(declared.version)) {
      limitations.push(`foundry.toml declared solc ${declared.version} but the artifacts were compiled with ${actual.version}`);
    }
    next = {
      ...cur.body,
      build: { job: jobRef, status: 'completed', artifacts: out!.artifact },
      inventory: inv,
      storage_layouts: sl,
      compiler: actual ? { version: actual.version, optimizer: actual.optimizer, runs: actual.runs, evm_version: actual.evm_version, via_ir: actual.via_ir } : cur.body.compiler,
      limitations,
    };
  }

  // Diffs that involve this snapshot are recomputed (function-level once both inventories exist).
  const newRef: Ref = { record_id: snapId, revision: cur.revision + 1 };
  let ownDiff = next.diff;
  for (const d of ctx.store.heads('snapshot_diff')) {
    const isNext = d.body.next.record_id === snapId;
    if (!isNext && d.body.prior.record_id !== snapId) continue;
    const otherId = isNext ? d.body.prior.record_id : d.body.next.record_id;
    const other = ctx.tx.current<'target_snapshot'>(otherId, 'target_snapshot');
    const otherView = { ref: { record_id: otherId, revision: other.revision }, body: other.body };
    const thisView = { ref: newRef, body: next };
    const { body } = buildDiffBody(ctx.store, ctx.archive, isNext ? otherView : thisView, isNext ? thisView : otherView);
    if (JSON.stringify(body) === JSON.stringify(d.body)) continue;
    const ref = ctx.tx.revise(d.record_id, 'snapshot_diff', () => body);
    if (isNext) ownDiff = ref;
  }
  next = { ...next, diff: ownDiff };
  same(ctx.tx.revise(snapId, 'target_snapshot', () => next), newRef);

  const eng = ctx.tx.current<'engagement'>(engagementRecord(ctx.store).record_id, 'engagement').body;
  if (eng.active_snapshot?.record_id === snapId) {
    recomputeFreshness(ctx, `build ${ok ? 'completed' : 'failed'} for ${snapId}`, { snapshot: { ref: newRef, body: next }, prior: next.prior_snapshot });
  }
}

onJobCompleted('build', ingestBuild);
onJobCompleted('inventory', ingestBuild);

// ------------------------------------------------------------------------------------------------
// Environment-read scanner for the runner: branch-feeding reads in target sources of a scratch copy.

function scanWorkDir(workDir: string): string[] {
  const out: string[] = [];
  const skip = new Set(['.git', 'out', 'cache', 'broadcast', 'node_modules']);
  const walk = (abs: string) => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (skip.has(name)) continue;
      const p = join(abs, name);
      const rel = relative(workDir, p).split(sep).join('/');
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && rel.endsWith('.sol') && !isTestOrScriptPath(rel) && st.size < 4 * 1024 * 1024) {
        for (const r of scanEnvironmentReads(readFileSync(p, 'utf8'))) {
          if (r.branch) out.push(`${rel}:${r.line} ${r.read}`);
        }
      }
    }
  };
  walk(workDir);
  return out;
}

setEnvironmentScanner(scanWorkDir);
