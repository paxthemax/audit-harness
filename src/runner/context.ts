import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fail } from '../core/errors.ts';
import { isDigest } from '../core/hash.ts';
import type { ArtifactRef, Ref } from '../core/refs.ts';
import type { Archive } from '../store/archive.ts';
import type { RecordStore } from '../store/recordStore.ts';

// Context manifests as the runner and broker use them (format `harness.context/1`, built by
// src/context/builder.ts). A manifest counts only when the controller's context builder produced it
// for this engagement: an artifact that merely looks like one admits nothing.

export interface ContextManifestView {
  format: string;
  engagement: string;
  role: string;
  investigation: Ref | null;
  records: { ref: Ref; type: string; body: unknown }[];
  sources: { path: string; original: string; view: string }[];
}

export function loadContextManifest(store: RecordStore, m: ArtifactRef | null | undefined): ContextManifestView {
  if (!m || !isDigest(m.artifact)) fail('invalid_request', 'context_manifest must be an artifact reference');
  const built =
    store.events().some((e) => e.result.context_manifest === m.artifact || (e.result.context_manifest as ArtifactRef | undefined)?.artifact === m.artifact) ||
    store.heads('job').some((j) => j.body.context_manifest?.artifact === m.artifact);
  if (!built) fail('egress_denied', `context manifest ${m.artifact} was not built by the controller's context builder`);
  const v = store.archive.getJson<ContextManifestView>(m.artifact);
  if (v.format !== 'harness.context/1' || v.engagement !== store.scope) fail('egress_denied', 'not a context manifest of this engagement');
  return v;
}

/** Write the manifest and its source views read-only under `dest` (/context in the sandbox). */
export function materializeContext(archive: Archive, ref: ArtifactRef, view: ContextManifestView, dest: string): void {
  const base = resolve(dest);
  mkdirSync(resolve(base, 'sources'), { recursive: true });
  writeFileSync(resolve(base, 'manifest.json'), archive.get(ref.artifact), { mode: 0o444 });
  for (const s of view.sources) {
    const target = resolve(base, 'sources', s.path);
    if (!target.startsWith(resolve(base, 'sources') + sep)) fail('integrity_failure', `context source path escapes: ${s.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, archive.get(s.view), { mode: 0o444 });
  }
}
