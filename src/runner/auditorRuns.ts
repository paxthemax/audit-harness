import { existsSync, lstatSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { fail } from '../core/errors.ts';
import type { AnyRef, Ref } from '../core/refs.ts';
import { defineOperation } from '../controller/controller.ts';
import type { ExecutionReceipt, StructuredResult } from '../schema/records.ts';

// Auditor-run artifacts (FR-41; design/harness-state-and-execution.md, "Write and approval protocol").
// A command the auditor routes through the receipt collector (runner.ts `runAuditorCommand`) is
// recorded with the trusted runner's receipt; files the auditor ran elsewhere are imported with an
// explicit untrusted-receipt label and never borrow the trusted runner's provenance.

export interface RecordAuditorCommandPayload {
  receipt: ExecutionReceipt;
  description: string;
  snapshot: Ref | null;
  missing_or_truncated: string[];
  limitations: string[];
  termination: 'not_applicable' | 'confirmed' | 'unconfirmed';
  requested_by: string;
  blobs: string[];
}

defineOperation<RecordAuditorCommandPayload>({
  name: 'record_auditor_command',
  channels: ['runner'],
  mutating: true,
  handler(ctx, p) {
    const r = p.receipt;
    for (const d of [r.stdout.artifact, r.stderr.artifact, ...r.outputs.map((o) => o.artifact.artifact), ...p.blobs]) {
      ctx.archive.get(d);
      ctx.tx.blob(d);
    }
    if (p.snapshot) ctx.store.get(p.snapshot, 'target_snapshot');
    const missing = [...p.missing_or_truncated];
    if (r.stdout_truncated) missing.push('stdout truncated at the output limit');
    if (r.stderr_truncated) missing.push('stderr truncated at the output limit');
    if (r.timed_out) missing.push('runtime limit reached');
    if (p.termination === 'unconfirmed') missing.push('process termination unconfirmed');
    const crashed = r.signal !== null && !r.timed_out;
    const result: StructuredResult = {
      result_type: crashed || (r.exit_code !== 0 && !r.timed_out) ? 'error' : 'inconclusive',
      mode: 'auditor_command',
      bounds: null,
      interpretation: `auditor-supplied command; exit status ${r.exit_code}${r.signal ? `, signal ${r.signal}` : ''}. The runner observed the execution but did not interpret its output`,
      tests: [],
    };
    const content = ctx.archive.putJson({ format: 'harness.result/1', receipt: r, structured_result: result, missing_or_truncated: missing });
    ctx.tx.blob(content);
    const eligible = missing.length === 0 && result.result_type !== 'error';
    const deps: AnyRef[] = p.snapshot ? [p.snapshot] : [];
    const evidence = ctx.tx.create(
      'evidence_artifact',
      {
        content,
        producer: 'trusted_runner',
        job: null,
        attempt: null,
        receipt: r,
        snapshot: p.snapshot,
        fixture: null,
        structured_result: result,
        environment_sensitive: { flagged: false, reads: [] },
        positive_control_for: null,
        missing_or_truncated: missing,
        limitations: [`auditor-run command requested by ${p.requested_by}, routed through the trusted runner`, ...p.limitations, 'environment-read scan not run'],
        eligible,
        description: p.description,
      },
      deps,
    );
    ctx.tx.event('auditor_command_recorded', { evidence });
    if (eligible) ctx.tx.event('evidence_eligible', { evidence });
    return { evidence, eligible };
  },
});

export interface ImportAuditorArtifactPayload {
  /** Absolute paths of files or directories on the auditor's machine. */
  paths: string[];
  description: string;
  /** What the auditor says they ran; recorded as an untrusted claim. */
  claimed?: { argv?: string[]; exit_code?: number | null; ran_at?: string | null; environment?: string | null };
  snapshot?: Ref | null;
}

defineOperation<ImportAuditorArtifactPayload>({
  name: 'import_auditor_artifact',
  channels: ['auditor'],
  mutating: true,
  handler(ctx, p) {
    if (!Array.isArray(p?.paths) || !p.paths.length) fail('invalid_request', 'paths are required');
    if (!p.description) fail('invalid_request', 'a description is required');
    if (p.snapshot) ctx.store.get(p.snapshot, 'target_snapshot');
    const files: Record<string, string> = {};
    const trees: Record<string, string> = {};
    for (const path of p.paths) {
      if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path)) fail('invalid_request', `not an existing absolute path: ${path}`);
      const st = lstatSync(path);
      const name = basename(path);
      if (files[name] || trees[name]) fail('invalid_request', `duplicate name ${name}`);
      if (st.isSymbolicLink()) fail('invalid_request', `symlink refused at ingestion: ${path}`);
      if (st.isDirectory()) {
        const t = ctx.archive.putTree(path);
        trees[name] = t.ref.artifact;
        ctx.tx.blob(t.ref);
        for (const d of Object.values(t.manifest.files)) ctx.tx.blob(d);
      } else if (st.isFile()) {
        const a = ctx.archive.putFile(path);
        files[name] = a.artifact;
        ctx.tx.blob(a);
      } else fail('invalid_request', `special file refused: ${path}`);
    }
    const content = ctx.archive.putJson({ format: 'harness.auditor_import/1', files, trees, claimed: p.claimed ?? null });
    ctx.tx.blob(content);
    const evidence = ctx.tx.create(
      'evidence_artifact',
      {
        content,
        producer: 'auditor_run_untrusted',
        job: null,
        attempt: null,
        receipt: null,
        snapshot: p.snapshot ?? null,
        fixture: null,
        structured_result: null,
        environment_sensitive: { flagged: false, reads: [] },
        positive_control_for: null,
        missing_or_truncated: ['no trusted execution receipt'],
        limitations: [
          'untrusted receipt: the trusted runner did not observe this execution; the command, exit status and environment are the auditor\'s claims',
        ],
        eligible: false,
        description: p.description,
      },
      p.snapshot ? [p.snapshot] : [],
    );
    return { evidence, files, trees };
  },
});
