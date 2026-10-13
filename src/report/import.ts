import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail } from '../core/errors.ts';
import { digestJson } from '../core/hash.ts';
import type { Ref } from '../core/refs.ts';
import { defineOperation } from '../controller/controller.ts';
import { defineDecisionKind, need } from '../decision/framework.ts';
import type { Workspace } from '../controller/workspace.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { RECORD_TYPES } from '../schema/records.ts';
import { MANIFEST_PATH, RECEIPT_PATH, readBundleDir, readBundleTar, verifyBundleFiles, type BundleVerification } from './bundle.ts';

// Bundle import (design/harness-interface-contracts.md, `import_bundle`, `choose_import_destination`,
// "Portable report and PoC package").
//
// import_bundle reads a bundle directory or ustar file as bytes, verifies every hash and path, and
// copies the verified payload into a quarantine area of the workspace, `<root>/imports/<id>/`, with
// read-only, non-executable modes. Nothing is executed, installed or extracted by another tool, and
// nothing enters a record store. The quarantine ID is the payload digest's hex.
//
// choose_import_destination (a decision made in the destination engagement) admits a verified
// quarantined bundle into that engagement's archive as inert reference material. Imported record IDs
// stay qualified by their original engagement (`scope`), so they resolve to nothing in the
// destination store and gain no authority; whether imported conclusions remain historical or need
// revalidation is recorded in the decision.

export function importsDir(ws: Workspace): string {
  return join(ws.root, 'imports');
}

export interface ImportedRecordRef extends Ref {
  scope: string;
  type: string;
}

export interface ImportSummary {
  import_id: string;
  payload: string;
  original_engagement: { id: string; name: string };
  records: ImportedRecordRef[];
  files: number;
  receipt_present: boolean;
}

/** Imported record envelopes must look like records of the bundle's own engagement. */
function importedRecords(v: BundleVerification, files: Map<string, Buffer>): { records: ImportedRecordRef[]; problems: string[] } {
  const records: ImportedRecordRef[] = [];
  const problems: string[] = [];
  const eng = v.manifest!.engagement?.id;
  for (const [path, bytes] of files) {
    if (!path.startsWith('records/')) continue;
    let env: { scope?: unknown; record_id?: unknown; revision?: unknown; type?: unknown };
    try {
      env = JSON.parse(bytes.toString('utf8'));
    } catch {
      problems.push(`${path}: not JSON`);
      continue;
    }
    if (env.scope !== eng) problems.push(`${path}: record scope ${String(env.scope)} differs from the bundle's engagement`);
    else if (typeof env.record_id !== 'string' || !Number.isInteger(env.revision) || !RECORD_TYPES.includes(env.type as never)) {
      problems.push(`${path}: not a record envelope`);
    } else if (path !== `records/${env.record_id}/${env.revision}.json`) problems.push(`${path}: path does not match the record identity`);
    else records.push({ record_id: env.record_id, revision: env.revision as number, scope: eng, type: env.type as string });
  }
  return { records, problems };
}

function readAndVerify(path: string): { v: BundleVerification; files: Map<string, Buffer>; records: ImportedRecordRef[] } {
  if (typeof path !== 'string' || !path) fail('invalid_request', 'path to a bundle directory or ustar file is required');
  if (!existsSync(path)) fail('not_found', 'bundle not found');
  const st = lstatSync(path);
  const b = st.isSymbolicLink()
    ? { files: new Map<string, Buffer>(), refused: [{ path: '.', reason: 'bundle path is a symlink' }] }
    : st.isFile()
      ? readBundleTar(path)
      : readBundleDir(path);
  const v = verifyBundleFiles(b);
  const problems = [...v.problems];
  let records: ImportedRecordRef[] = [];
  if (v.manifest) {
    if (typeof v.manifest.engagement?.id !== 'string') problems.push('manifest names no engagement');
    else {
      const r = importedRecords(v, b.files);
      records = r.records;
      problems.push(...r.problems);
    }
  }
  if (problems.length) {
    fail('integrity_failure', 'the bundle failed verification in quarantine; nothing was imported', { details: { problems: problems.slice(0, 100) } });
  }
  return { v, files: b.files, records };
}

defineOperation<{ path: string }>({
  name: 'import_bundle',
  channels: ['auditor'],
  // Writes only the workspace quarantine area, never a record store.
  mutating: false,
  scope: 'either',
  handler(ctx, p) {
    const { v, files, records } = readAndVerify(p?.path);
    const id = v.payload!.slice(7);
    const qdir = join(importsDir(ctx.ws), id);
    if (!existsSync(qdir)) {
      const tmp = `${qdir}.partial-${process.pid}-${Date.now()}`;
      try {
        for (const [rel, bytes] of files) {
          const target = join(tmp, rel);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, bytes, { flag: 'wx', mode: 0o444 });
        }
        renameSync(tmp, qdir);
      } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        throw e;
      }
    }
    const summary: ImportSummary = {
      import_id: id,
      payload: v.payload!,
      original_engagement: { id: v.manifest!.engagement.id, name: String(v.manifest!.engagement.name ?? '') },
      records,
      files: files.size,
      receipt_present: files.has(RECEIPT_PATH),
    };
    return summary;
  },
});

// choose_import_destination inputs:
//   import_id   quarantine ID returned by import_bundle (the payload digest's hex)
//   payload     the payload digest the auditor reviewed
//   treatment   'historical' | 'revalidate'
// The decision is made in the destination engagement. The bundle is re-verified from quarantine.

defineDecisionKind({
  kind: 'choose_import_destination',
  check(ctx, p) {
    const id = need<string>(p.inputs, 'import_id');
    const payload = need<string>(p.inputs, 'payload');
    const treatment = need<string>(p.inputs, 'treatment');
    if (!/^[0-9a-f]{64}$/.test(id)) fail('invalid_request', 'import_id must be a quarantine ID');
    if (payload !== `sha256:${id}`) fail('invalid_request', 'payload does not match the quarantine ID');
    if (treatment !== 'historical' && treatment !== 'revalidate') fail('invalid_request', "treatment must be 'historical' or 'revalidate'");
    const { v } = readAndVerify(join(importsDir(ctx.ws), id));
    if (v.payload !== payload) fail('integrity_failure', 'the quarantined bundle no longer matches its payload digest');
    if (v.manifest!.engagement.id === ctx.store.scope) {
      fail('invalid_request', 'a bundle cannot be imported into an engagement with its original ID; imported identifiers would gain authority');
    }
  },
  apply(d) {
    const { ctx } = d;
    const id = d.payload.inputs.import_id as string;
    const { v, files, records } = readAndVerify(join(importsDir(ctx.ws), id));
    for (const bytes of files.values()) ctx.tx.blob(ctx.archive.put(bytes));
    const manifest = ctx.archive.put(files.get(MANIFEST_PATH)!);
    return {
      imported: {
        payload: v.payload,
        manifest,
        original_engagement: v.manifest!.engagement.id,
        treatment: d.payload.inputs.treatment,
        records,
        authority: 'none: imported identifiers stay scoped to their original engagement',
        digest: digestJson(records),
      },
    };
  },
});

/** Imports admitted into an engagement, from its `choose_import_destination` decisions. */
export function importedBundles(store: RecordStore) {
  return store
    .heads('human_decision')
    .filter((d) => d.body.kind === 'choose_import_destination')
    .map((d) => ({
      decision: { record_id: d.record_id, revision: d.revision },
      payload: d.body.inputs.payload as string,
      treatment: d.body.inputs.treatment as 'historical' | 'revalidate',
    }));
}
