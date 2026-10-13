import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fail } from '../core/errors.ts';
import type { ArtifactRef, Ref } from '../core/refs.ts';
import { defineOperation } from '../controller/controller.ts';
import type { Archive } from '../store/archive.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { activeSnapshot, requireWorkerScope } from './common.ts';
import { readFoundryConfig } from '../snapshot/source.ts';

// Experiment fixtures (design/harness-state-and-execution.md, "Permissions and isolation": "Write
// experiment files"). A fixture is a tree of files the runner overlays on a per-job scratch copy; the
// original target stays read-only. The controller does not judge what a fixture means (agents classify
// their changes and the challenger reviews them; accepted residual risk Q-014), but it never lets a
// fixture alter target files invisibly: every target file a fixture overrides is listed when the
// fixture is submitted and again in each review packet.

/** Proposed bounds for an inline fixture (numeric limits are operator choices). */
export const PROPOSED_FIXTURE_MAX_FILES = 64;
export const PROPOSED_FIXTURE_MAX_BYTES = 1024 * 1024;

function safeRel(p: string): string {
  const norm = posix.normalize(p.replace(/\\/g, '/'));
  if (!p || norm.startsWith('/') || norm === '..' || norm.startsWith('../') || norm.includes('/../') || norm === '.') {
    fail('invalid_request', `fixture path ${JSON.stringify(p)} escapes the fixture root`);
  }
  if (norm.split('/').some((s) => s === '.git')) fail('invalid_request', 'fixtures cannot contain .git');
  return norm;
}

/** Build configuration files: adding one changes what compiles even when no source file is overridden. */
const CONFIG_FILES = new Set(['foundry.toml', 'remappings.txt', '.gitmodules', 'package.json', 'hardhat.config.js', 'hardhat.config.ts']);

/**
 * How a fixture relates to the target. `overrides` lists every path that alters the compiled target:
 * a target file replaced with different content, a build-configuration file, or any added file
 * outside the project's test and script directories (a new source, a remapped dependency).
 * `added` lists the new test/script files, which leave the target itself as it was.
 */
export function fixtureOverrides(archive: Archive, snapshotTree: string, fixtureTree: string): { overrides: string[]; added: string[] } {
  const target = archive.getTree(snapshotTree).files;
  const fx = archive.getTree(fixtureTree).files;
  const cfgDigest = target['foundry.toml'];
  const cfg = readFoundryConfig(cfgDigest ? archive.getText(cfgDigest) : null);
  const testDirs = [cfg.test, cfg.script].map((d) => d.replace(/^\.\//, '').replace(/\/+$/, '') + '/');
  const overrides: string[] = [];
  const added: string[] = [];
  for (const [p, d] of Object.entries(fx)) {
    const base = p.split('/').pop()!;
    if (p in target) {
      if (target[p] !== d) overrides.push(p);
    } else if (CONFIG_FILES.has(base) || !testDirs.some((t) => p.startsWith(t))) {
      overrides.push(p);
    } else {
      added.push(p);
    }
  }
  return { overrides: overrides.sort(), added: added.sort() };
}

/** Overrides for every fixture used by an investigation's jobs. */
export function investigationFixtureOverrides(store: RecordStore, invId: string): { job: Ref; paths: string[] }[] {
  const out: { job: Ref; paths: string[] }[] = [];
  for (const j of store.heads('job')) {
    if (j.body.investigation?.record_id !== invId || !j.body.fixture) continue;
    const snap = store.get(j.body.snapshot, 'target_snapshot');
    const { overrides } = fixtureOverrides(store.archive, snap.body.tree.artifact, j.body.fixture.artifact);
    if (overrides.length) out.push({ job: { record_id: j.record_id, revision: j.revision }, paths: overrides });
  }
  return out;
}

export interface SubmitFixturePayload {
  /** Inline files: relative path -> UTF-8 content. */
  files: Record<string, string>;
  investigation?: Ref | null;
}

defineOperation<SubmitFixturePayload>({
  name: 'submit_fixture',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.files || typeof p.files !== 'object') fail('invalid_request', 'files are required');
    requireWorkerScope(ctx, p.investigation?.record_id ?? ctx.principal.grant?.investigation?.record_id ?? null);
    const entries = Object.entries(p.files);
    if (!entries.length || entries.length > PROPOSED_FIXTURE_MAX_FILES) fail('invalid_request', `a fixture has 1..${PROPOSED_FIXTURE_MAX_FILES} files`);
    const total = entries.reduce((s, [, c]) => s + Buffer.byteLength(String(c)), 0);
    if (total > PROPOSED_FIXTURE_MAX_BYTES) fail('invalid_request', 'fixture exceeds the size bound');
    const dir = mkdtempSync(join(tmpdir(), 'harness-fixture-'));
    try {
      const root = resolve(dir);
      for (const [rel, content] of entries) {
        const safe = safeRel(rel);
        const target = resolve(root, safe);
        if (!target.startsWith(root + sep)) fail('invalid_request', `fixture path ${rel} escapes the fixture root`);
        mkdirSync(dirname(target), { recursive: true });
        if (typeof content !== 'string') fail('invalid_request', `fixture file ${rel} must be text`);
        writeFileSync(target, content);
      }
      const { ref, manifest } = ctx.archive.putTree(root);
      ctx.tx.blob(ref);
      for (const d of Object.values(manifest.files)) ctx.tx.blob(d);
      const snap = activeSnapshot(ctx.store);
      const diff = snap ? fixtureOverrides(ctx.archive, ctx.store.get(snap, 'target_snapshot').body.tree.artifact, ref.artifact) : { overrides: [], added: Object.keys(manifest.files) };
      ctx.tx.event('fixture_submitted', { fixture: ref.artifact, overrides_target: diff.overrides, added: diff.added });
      return { fixture: ref as ArtifactRef, overrides_target: diff.overrides, added: diff.added };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
