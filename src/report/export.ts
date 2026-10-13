import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fail } from '../core/errors.ts';
import { digest } from '../core/hash.ts';
import { isArtifactRef, refKey, type AnyRef, type Ref } from '../core/refs.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import { commitDecision, need, type DecisionKindDef, type DecisionPayload } from '../decision/framework.ts';
import { CONTRACT_VERSION, SCHEMA_VERSION, type AnyRecord, type RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import {
  BUNDLE_FORMAT,
  MANIFEST_PATH,
  RECEIPT_PATH,
  unsafePath,
  verifyBundle,
  type BundleManifest,
} from './bundle.ts';
import { artifactsOf, claimInputs, decisionBody, engagementHead, fixLabelOf, refOf, retainedAway } from './derive.ts';
import { md } from './escape.ts';
import { alternativeOf, failedAttemptCount, renderReport } from './render.ts';
import { computeRequiredSet, type RequiredItem } from './requiredSet.ts';

// Report preparation, approval and export (design/harness-interface-contracts.md, `prepare_export`,
// `approve_export`, `export_bundle`, "Portable report and PoC package"; FR-21, FR-22, NFR-10, NFR-13).
//
//   prepare_export  auditor or reporting worker: freezes the selection into an immutable payload in the
//                   archive (report.md, manifest.json, records/, artifacts/, reproduction/, README.md)
//                   and a `report_manifest` record with status `preview`.
//   approve_export  trusted screen only: a human decision of kind `approve_export` (through
//                   commitDecision, not record_decision) binding the payload digest, audience and
//                   permitted destination.
//   export_bundle   auditor (or the controller) performs exactly what the approval authorizes: writes
//                   the payload to the approved local destination plus release-receipt.json, which is
//                   outside the hashed payload.
//
// There is no urgent-disclosure path (DEC-009, Q-025): the full frozen export is the only release.

export interface OmissionReason {
  basis: 'audience' | 'redaction';
  reason: string;
}

export interface PrepareExportPayload {
  /** Frozen selection: exact record revisions of this engagement. */
  selection: Ref[];
  audience: string;
  redaction_policy: string;
  /** Reason for each required item the selection omits, keyed by record ID. */
  omission_reasons?: Record<string, OmissionReason>;
  /** Artifacts withheld from the payload. */
  redact_artifacts?: { artifact: string; reason: string }[];
  /** Optional agent-drafted narrative (archive artifact); rendered in its own labelled section. */
  narrative?: { artifact: string } | null;
  /** A previous preview this one replaces (marked `superseded`). */
  supersedes?: Ref | null;
}

/** The content manifest frozen into manifest.json (the payload identity is its digest). */
export interface ContentManifest extends BundleManifest {
  format: typeof BUNDLE_FORMAT;
  schema_version: number;
  contract_version: number;
  report_manifest: string;
  generated_at: string;
  engagement: { id: string; name: string };
  snapshot: { ref: Ref; label: string; commit: unknown; tree: string } | null;
  audience: string;
  redaction_policy: string;
  selection: Ref[];
  records: { ref: Ref; type: string; path: string; digest: string }[];
  evidence_routes: { finding: Ref; route: string }[];
  required_tools: { name: string; version: string; descriptor: string }[];
  required_set: {
    digest: string;
    items: { key: string; ref: Ref | null; category: string; reason_required: string; generated: boolean; included: boolean; omission_reason: string | null }[];
  };
  absent: { key: string; ref: Ref | null; category: string; omission_reason: string | null }[];
  redactions: { artifact: string; reason: string }[];
  missing_dependencies: { from: Ref; ref: AnyRef; reason: string }[];
  blockers: { key: string; reason: string }[];
  limits: string[];
  files: Record<string, string>;
}

// -----------------------------------------------------------------------------------------------
// prepare_export

defineOperation<PrepareExportPayload>({
  name: 'prepare_export',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    if (!p || !Array.isArray(p.selection)) fail('invalid_request', 'selection must list exact record revisions');
    if (!p.audience?.trim() || !p.redaction_policy?.trim()) fail('invalid_request', 'audience and redaction_policy are required');
    // Only the auditor may supersede, and only a preview: an approved or exported manifest is a
    // release record and stays as it is.
    if (p.supersedes) {
      if (ctx.principal.channel !== 'auditor') fail('permission_denied', 'only the auditor can supersede a preview');
      const old = ctx.store.get(p.supersedes, 'report_manifest');
      if (ctx.store.mustHead(old.record_id, 'report_manifest').revision !== old.revision) fail('revision_conflict', `report manifest ${old.record_id} changed`);
      if (old.body.status !== 'preview') fail('permission_denied', `report manifest ${old.record_id} is ${old.body.status}; only a preview can be superseded`);
    }
    const built = buildPreview(ctx, p);
    if (p.supersedes) {
      ctx.tx.revise(p.supersedes.record_id, 'report_manifest', (b) => ({ ...b, status: 'superseded' }), { expectedRevision: p.supersedes.revision });
    }
    return built;
  },
});

interface FileOut {
  path: string;
  bytes: Buffer;
}

function buildPreview(ctx: OpContext, p: PrepareExportPayload): Record<string, unknown> {
  const store = ctx.store;
  const eng = engagementHead(store);
  if (!eng.body.policy) fail('permission_denied', 'scope and policy have not been accepted (accept_scope_and_policy)');
  const required = computeRequiredSet(store);
  const retained = retainedAway(store);
  const manifestId = store.peekNextId('report_manifest');

  // --- Effective selection: the frozen selection plus what the controller always generates -------
  const effective = new Map<string, Ref>();
  const put = (r: Ref | null | undefined) => {
    if (r && !r.scope) effective.set(refKey(r), { record_id: r.record_id, revision: r.revision });
  };
  for (const r of p.selection) {
    if (!r || typeof r.record_id !== 'string' || !Number.isInteger(r.revision)) fail('invalid_request', 'selection entries must be exact revisions');
    store.get(r); // must exist in this engagement; a foreign scope is refused
    if (r.scope) fail('permission_denied', 'cross-engagement references cannot be selected');
    put(r);
  }
  put(refOf(eng));
  put(eng.body.active_snapshot ? store.headRef(eng.body.active_snapshot.record_id) : null);
  for (const i of required.items) if (i.generated) put(i.ref);
  // Decision rationale travels with what it decided.
  for (const r of [...effective.values()]) {
    const env = store.get(r) as AnyRecord;
    if (env.type === 'finding') {
      put(env.body.acceptance);
      put(store.headRef(env.body.investigation.record_id));
      for (const fa of env.body.fix_assessments) {
        const head = store.head<'fix_assessment'>(fa.record_id);
        if (head) {
          put(refOf(head));
          put(head.body.decision);
        }
      }
    } else if (env.type === 'investigation') {
      put(env.body.disposition?.decision);
      for (const c of env.body.linked_claims) put(c.disposition?.decision);
    }
  }

  // --- Required set against the selection ---------------------------------------------------------
  const reasons = p.omission_reasons ?? {};
  for (const [id, r] of Object.entries(reasons)) {
    if (!r || (r.basis !== 'audience' && r.basis !== 'redaction') || !r.reason?.trim()) {
      fail('invalid_request', `omission reason for ${id} needs basis 'audience' or 'redaction' and a reason`);
    }
  }
  const absent: { item: RequiredItem; reason: string | null }[] = [];
  const itemRows = required.items.map((i) => {
    const included = i.generated || (i.ref !== null && effective.has(refKey(i.ref)));
    const r = !included && i.ref ? reasons[i.ref.record_id] : undefined;
    const omission = included ? null : r ? `${r.basis}: ${r.reason}` : null;
    if (!included) absent.push({ item: i, reason: omission });
    return {
      key: i.key,
      ref: i.ref,
      category: i.category,
      reason_required: `${i.category}: ${i.reason}`,
      generated: i.generated,
      included,
      omission_reason: omission,
    };
  });
  const blockers = required.items.filter((i) => i.blocking).map((i) => ({ key: i.key, reason: `${i.blocking}: ${i.reason}` }));

  // --- Records and artifacts -------------------------------------------------------------------
  const files: FileOut[] = [];
  const add = (path: string, bytes: Buffer | string) => {
    const bad = unsafePath(path);
    if (bad) fail('invalid_request', `bundle path ${path}: ${bad}`);
    if (files.some((f) => f.path === path)) return;
    files.push({ path, bytes: typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes });
  };
  const missing: ContentManifest['missing_dependencies'] = [];
  const recordRows: ContentManifest['records'] = [];
  const included: RecordEnvelope[] = [];
  for (const r of [...effective.values()].sort((a, b) => refKey(a).localeCompare(refKey(b), 'en', { numeric: true }))) {
    const env = store.get(r);
    const by = retained.records.get(env.record_id);
    if (by) {
      missing.push({ from: r, ref: r, reason: `removed under retention decision ${refKey(by)}` });
      continue;
    }
    const path = `records/${env.record_id}/${env.revision}.json`;
    const bytes = Buffer.from(JSON.stringify(env, null, 2) + '\n', 'utf8');
    add(path, bytes);
    recordRows.push({ ref: r, type: env.type, path, digest: digest(bytes) });
    included.push(env);
  }
  const redactions = (p.redact_artifacts ?? []).map((x) => {
    if (!x?.artifact || !x.reason?.trim()) fail('invalid_request', 'each redacted artifact needs a reason');
    return { artifact: x.artifact, reason: x.reason };
  });
  const redacted = new Set(redactions.map((x) => x.artifact));
  const includedKeys = new Set(recordRows.map((r) => refKey(r.ref)));
  for (const env of included) {
    for (const d of env.depends_on) {
      if (!isArtifactRef(d) && !includedKeys.has(refKey(d))) missing.push({ from: refOf(env), ref: d, reason: 'not in the selection' });
    }
    for (const a of artifactsOf(env)) {
      if (redacted.has(a)) continue;
      const by = retained.artifacts.get(a);
      if (by) missing.push({ from: refOf(env), ref: { artifact: a }, reason: `removed under retention decision ${refKey(by)}; not replayable` });
      else if (!ctx.archive.has(a)) missing.push({ from: refOf(env), ref: { artifact: a }, reason: 'not in the archive' });
      else add(`artifacts/sha256/${a.slice(7)}`, ctx.archive.get(a));
    }
  }

  // --- Reproduction ----------------------------------------------------------------------------
  const findings = included.filter((e): e is RecordEnvelope<'finding'> => e.type === 'finding');
  const tools = new Map<string, { name: string; version: string; descriptor: string }>();
  for (const f of findings) reproduction(store, ctx, f, add, tools, redacted, retained.artifacts);

  // --- Narrative (agent-drafted, separated, checked for assurance claims) --------------------------
  let narrative: string | null = null;
  if (p.narrative) {
    narrative = ctx.archive.getText(p.narrative.artifact);
    const bad = assuranceClaims(narrative);
    if (bad.length) fail('invalid_request', 'the narrative states an aggregate or whole-system assurance claim (NFR-13)', { details: { lines: bad } });
  }

  // --- report.md ---------------------------------------------------------------------------------
  const report = renderReport({
    store,
    manifestId,
    generatedAt: ctx.now,
    audience: p.audience,
    redactionPolicy: p.redaction_policy,
    required,
    included: new Set([...includedKeys]),
    absent,
    redactedArtifacts: redactions,
    narrative,
  });
  add('report.md', report);

  const snapEnv = eng.body.active_snapshot ? store.head<'target_snapshot'>(eng.body.active_snapshot.record_id) : undefined;
  const limits = [
    ...required.items.filter((i) => i.category === 'accepted_residual_risk').map((i) => `${i.detail.id}: ${i.reason}`),
    'Target source bytes are not included; obtain the snapshot by its commit and tree digest.',
    'A checksum is not a signature: hashes identify bytes, not the truth of their contents.',
    ...(redactions.length ? ['Redacted artifacts restrict independent reproduction of what depends on them.'] : []),
  ];
  add('README.md', readme(eng, p, absent.length, redactions.length, missing.length, limits));

  const manifest: ContentManifest = {
    format: BUNDLE_FORMAT,
    schema_version: SCHEMA_VERSION,
    contract_version: CONTRACT_VERSION,
    report_manifest: manifestId,
    generated_at: ctx.now,
    engagement: { id: store.scope, name: eng.body.name },
    snapshot: snapEnv
      ? { ref: refOf(snapEnv), label: snapEnv.body.label, commit: snapEnv.body.source.commit, tree: snapEnv.body.tree.artifact }
      : null,
    audience: p.audience,
    redaction_policy: p.redaction_policy,
    selection: p.selection.map((r) => ({ record_id: r.record_id, revision: r.revision })),
    records: recordRows,
    evidence_routes: findings.map((f) => ({ finding: refOf(f), route: f.body.evidence_route })),
    required_tools: [...tools.values()],
    required_set: { digest: required.digest, items: itemRows },
    absent: itemRows.filter((i) => !i.included).map((i) => ({ key: i.key, ref: i.ref, category: i.category, omission_reason: i.omission_reason })),
    redactions,
    missing_dependencies: missing,
    blockers,
    limits,
    files: Object.fromEntries(files.map((f) => [f.path, digest(f.bytes)])),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // --- Freeze into the archive -------------------------------------------------------------------
  const artifacts: { artifact: { artifact: string }; path: string }[] = [];
  for (const f of [...files, { path: MANIFEST_PATH, bytes: manifestBytes }]) {
    const a = ctx.archive.put(f.bytes);
    ctx.tx.blob(a);
    artifacts.push({ artifact: a, path: f.path });
  }
  const reportRef = artifacts.find((a) => a.path === 'report.md')!.artifact;
  const payloadRef = artifacts.find((a) => a.path === MANIFEST_PATH)!.artifact;
  const recordBody = {
    selection: manifest.selection,
    artifacts,
    required_set: itemRows
      .filter((i) => i.ref !== null)
      .map((i) => ({ ref: i.ref!, reason_required: i.reason_required, included: i.included, omission_reason: i.omission_reason })),
    audience: p.audience,
    redaction_policy: p.redaction_policy,
    report: reportRef,
    payload: payloadRef,
    status: 'preview' as const,
    approval: null,
    export_receipt: null,
    limits,
  };
  const ref = ctx.tx.create('report_manifest', recordBody, [...effective.values()]);
  if (ref.record_id !== manifestId) fail('execution_failed', 'report manifest identity changed while staging');
  const unexplained = absent.filter((a) => a.reason === null);
  return {
    report_manifest: ref,
    payload: payloadRef,
    report: reportRef,
    absent: absent.map((a) => ({ key: a.item.key, ref: a.item.ref, category: a.item.category, reason_required: a.item.reason, omission_reason: a.reason })),
    unexplained_omissions: unexplained.map((a) => a.item.key),
    blockers,
  };
}

/** Patterns of whole-system assurance claims refused in the agent narrative (NFR-13). */
const ASSURANCE_PATTERNS: RegExp[] = [
  /\b\d{1,3}(\.\d+)?\s*%\s*(secure|safe|security|safety|coverage|assurance)/i,
  /\b(security|safety|assurance)\s+(score|rating|percentage)\b/i,
  /\b(is|are)\s+(fully|completely|totally|now)?\s*(secure|safe|bug[- ]free|vulnerability[- ]free)\b/i,
  /\bno\s+(remaining\s+)?vulnerabilities\b/i,
];

export function assuranceClaims(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => ASSURANCE_PATTERNS.some((re) => re.test(l)));
}

function readme(
  eng: RecordEnvelope<'engagement'>,
  p: PrepareExportPayload,
  absent: number,
  redacted: number,
  missing: number,
  limits: string[],
): string {
  return [
    `# Export bundle: ${md(eng.body.name)}`,
    '',
    `Audience: ${md(p.audience)}. Redaction policy: ${md(p.redaction_policy)}.`,
    '',
    '## Contents',
    '',
    '- `report.md`: the report. Structured sections are generated from records; any agent narrative is labelled.',
    '- `manifest.json`: the immutable payload inventory: record revisions, artifact paths and hashes, the required set with each absent item and its reason, redactions, missing dependencies and limits.',
    '- `records/<id>/<revision>.json`: the selected record revisions and decision rationale.',
    '- `artifacts/sha256/<hex>`: evidence files addressed by content hash.',
    '- `reproduction/<finding>/`: per-finding reproduction material. Executable PoCs are tests bound to a local fork or chain with structured commands and secret placeholders; alternative-evidence findings carry the argument and attempt history and no reproduction command.',
    '- `release-receipt.json`: written at export, outside the hashed payload; it names the payload digest and the approval.',
    '',
    '## Inspection',
    '',
    '1. Compute the SHA-256 of `manifest.json`; it must equal `payload` in `release-receipt.json`.',
    '2. For each entry of `files` in `manifest.json`, compute the SHA-256 of that file and compare. No other files belong to the payload.',
    '3. Every path is relative and stays inside this directory.',
    '',
    `Required items omitted: ${absent}. Artifacts redacted: ${redacted}. Missing dependencies listed: ${missing}.`,
    '',
    '## Limitations',
    '',
    ...limits.map((l) => `- ${md(l)}`),
    '',
  ].join('\n');
}

const SECRETISH = /(secret|token|key|password|passwd|private|mnemonic|auth)/i;

function reproduction(
  store: RecordStore,
  ctx: OpContext,
  f: RecordEnvelope<'finding'>,
  add: (path: string, bytes: Buffer | string) => void,
  tools: Map<string, { name: string; version: string; descriptor: string }>,
  redacted: Set<string>,
  retainedArtifacts: Map<string, Ref>,
): void {
  const dir = `reproduction/${f.record_id}`;
  const acceptance = decisionBody(store, f.body.acceptance);
  const inputs = claimInputs(acceptance?.inputs, f.body.linked_claim_id);
  const invId = f.body.investigation.record_id;
  const jobs = store.heads('job').filter((j) => j.body.investigation?.record_id === invId);
  const history = jobs.map((j) => ({
    job: refOf(j),
    purpose: j.body.purpose,
    operation: j.body.operation,
    status: j.body.status,
    attempts: store
      .heads('attempt')
      .filter((a) => a.body.job.record_id === j.record_id)
      .map((a) => ({ attempt: refOf(a), status: a.body.status, reason: a.body.reason })),
  }));
  const usable = (a: string) => !redacted.has(a) && !retainedArtifacts.has(a) && ctx.archive.has(a);

  if (f.body.evidence_route === 'alternative_argument') {
    add(
      `${dir}/alternative-evidence.json`,
      JSON.stringify(
        {
          format: 'harness.alternative-evidence/1',
          finding: refOf(f),
          note: 'Accepted on a reviewed alternative argument (DEC-004). There is deliberately no reproduction command.',
          argument: acceptance?.rationale ?? null,
          why_sufficient: alternativeOf(inputs).why_sufficient,
          why_execution_impractical: alternativeOf(inputs).why_impractical,
          remaining_untested: alternativeOf(inputs).limits,
          failed_replays_addressed: alternativeOf(inputs).failed_replays_addressed,
          conditional_on: acceptance?.conditional_on ?? [],
          attempt_history: history,
          failed_attempts: failedAttemptCount(store, invId),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  if (f.body.evidence_route === 'code_argument') {
    add(
      `${dir}/code-argument.json`,
      JSON.stringify({ format: 'harness.code-argument/1', finding: refOf(f), anchors: f.body.affected_code, cited: inputs.anchors ?? null, attempt_history: history }, null, 2) + '\n',
    );
    return;
  }

  // executable_replay: the clean replay the acceptance cited, otherwise the latest completed replay.
  let ev: RecordEnvelope<'evidence_artifact'> | undefined;
  const cited = inputs.replay_receipt as Ref | undefined;
  if (cited && typeof cited === 'object' && 'record_id' in cited) {
    const e = store.tryGet(cited);
    if (e?.type === 'evidence_artifact') ev = e as RecordEnvelope<'evidence_artifact'>;
  }
  if (!ev) {
    const replayJobs = new Set(jobs.filter((j) => j.body.purpose === 'replay' && j.body.status === 'completed').map((j) => j.record_id));
    ev = store.heads('evidence_artifact').filter((e) => e.body.job && replayJobs.has(e.body.job.record_id)).pop();
  }
  const prerequisites: string[] = [];
  const command: Record<string, unknown> = { format: 'harness.reproduction/1', finding: refOf(f), evidence_route: 'executable_replay' };
  const job = ev?.body.job ? store.tryGet<'job'>(ev.body.job) : undefined;
  if (!ev || !job || !ev.body.receipt) {
    prerequisites.push('No clean replay receipt was located in the engagement records; no command is given.');
  } else {
    const receipt = ev.body.receipt;
    const snap = store.tryGet<'target_snapshot'>(job.body.snapshot);
    tools.set(`${job.body.adapter.name}@${job.body.adapter.version}`, job.body.adapter);
    const argv = receipt.argv.map((a) => {
      const eq = a.indexOf('=');
      return eq > 0 && SECRETISH.test(a.slice(0, eq)) ? `${a.slice(0, eq)}=\${SECRET:${a.slice(0, eq).replace(/^-+/, '').toUpperCase()}}` : a;
    });
    const broadcast = argv.some((a) => a === '--broadcast') || /broadcast/i.test(job.body.operation);
    if (broadcast) {
      prerequisites.push('The recorded command could broadcast transactions; it is withheld. A PoC must be a test bound to a local fork or chain.');
    } else {
      command.adapter = job.body.adapter;
      command.operation = job.body.operation;
      command.args = job.body.args;
      command.argv = argv;
      command.cwd = '<working copy of the target snapshot with the fixture overlay>';
      command.env = Object.fromEntries(receipt.env_keys.map((k) => [k, `\${SECRET:${k}}`]));
      command.executable = { path: receipt.executable.path, digest: receipt.executable.digest, version: receipt.executable.version };
    }
    command.replay_evidence = refOf(ev);
    command.target = snap
      ? { snapshot: refOf(snap), label: snap.body.label, commit: snap.body.source.commit, tree: snap.body.tree.artifact, compiler: snap.body.compiler }
      : { snapshot: job.body.snapshot };
    command.expected_observation = ev.body.structured_result?.tests.filter((t) => t.expect !== null) ?? [];
    command.observed = ev.body.structured_result;
    command.setup_powers = job.body.variant ? (store.tryGet<'scenario_variant'>(job.body.variant)?.body.setup_powers ?? []) : [];
    if (job.body.fixture) {
      if (!usable(job.body.fixture.artifact)) prerequisites.push('The fixture is redacted or unavailable; the PoC cannot replay from this package.');
      else {
        const tree = ctx.archive.getTree(job.body.fixture.artifact);
        command.fixture = { tree: job.body.fixture.artifact, path: 'fixture/' };
        for (const [path, d] of Object.entries(tree.files)) {
          if (unsafePath(path)) continue;
          if (usable(d)) add(`${dir}/fixture/${path}`, ctx.archive.get(d));
          else prerequisites.push(`Fixture file ${path} is redacted or unavailable.`);
        }
      }
    }
    if (usable(receipt.stdout.artifact)) add(`${dir}/observed-stdout.txt`, ctx.archive.get(receipt.stdout.artifact));
    const fork = snap && typeof snap.body.fork === 'object' && !('unknown' in snap.body.fork) ? snap.body.fork : null;
    command.fork = fork;
    const forkState = receipt.outputs.find((o) => /fork[-_]?state/i.test(o.path));
    if (forkState && usable(forkState.artifact.artifact)) {
      add(`${dir}/fork-state.json`, ctx.archive.get(forkState.artifact.artifact));
      command.fork_state = 'fork-state.json';
    } else if (fork) {
      prerequisites.push(
        `The touched fork state was not captured; replay needs archive RPC access to chain ${fork.chain_id} at block ${fork.block_number}. No mock is substituted.`,
      );
    }
    if (receipt.env_keys.length) prerequisites.push(`Supply values for the placeholders: ${receipt.env_keys.join(', ')}.`);
  }
  command.prerequisites = prerequisites;
  command.attempt_history = history;
  add(`${dir}/command.json`, JSON.stringify(command, null, 2) + '\n');
}

// -----------------------------------------------------------------------------------------------
// approve_export

/**
 * Disclosure-constraint vocabulary for `engagement.policy.disclosure_constraints` (checked at approval):
 *
 *   no_unfixed_findings:<audience>   the audience may not receive material about a finding whose fix
 *                                    label is not `fixed`; `*` matches every audience
 *   no_export:<audience>             nothing may be released to the audience; `*` matches every audience
 *   note:<free text>                 a recorded note, not checked mechanically
 *
 * Any other constraint cannot be checked, so approval fails closed until it is restated.
 */
export function parseConstraint(c: string): { kind: 'no_unfixed_findings' | 'no_export' | 'note'; audience: string | null } | null {
  const m = /^(no_unfixed_findings|no_export|note):(.+)$/s.exec(c.trim());
  if (!m) return null;
  return { kind: m[1] as 'no_unfixed_findings' | 'no_export' | 'note', audience: m[1] === 'note' ? null : m[2].trim() };
}

export interface ApproveExportInputs {
  report_manifest: Ref;
  payload: string;
  audience: string;
  destination: string;
}

const APPROVE_EXPORT: DecisionKindDef = {
  kind: 'approve_export',
  check(ctx, p) {
    const inputs = p.inputs ?? {};
    if ('urgent' in inputs) fail('invalid_request', 'there is no urgent-disclosure path (DEC-009, Q-025); the full frozen export is the only release');
    const mref = need<Ref>(inputs, 'report_manifest');
    const payload = need<string>(inputs, 'payload');
    const audience = need<string>(inputs, 'audience');
    need<string>(inputs, 'destination');
    if (!p.reviewed.some((r) => r.record_id === mref.record_id && r.revision === mref.revision)) {
      fail('display_required', 'the reviewed revisions must include the report manifest preview');
    }
    const rm = ctx.store.get(mref, 'report_manifest');
    const head = ctx.store.mustHead(mref.record_id, 'report_manifest');
    if (head.revision !== mref.revision) fail('stale_dependency', 'the preview changed after review');
    if (rm.body.status !== 'preview') fail('invalid_request', `report manifest is ${rm.body.status}; approval needs a current preview`);
    if (payload !== rm.body.payload.artifact) fail('stale_dependency', 'the payload digest differs from the frozen preview; a changed payload needs a new preview');
    if (audience !== rm.body.audience) fail('invalid_request', 'the audience differs from the preview; an audience change needs a new preview');
    const manifest = ctx.archive.getJson<ContentManifest>(rm.body.payload.artifact);
    const unexplained = manifest.absent.filter((a) => !a.omission_reason);
    if (unexplained.length) {
      fail('invalid_request', 'required items are omitted without an audience or redaction reason; prepare a new preview with reasons', {
        details: { unexplained: unexplained.map((a) => ({ key: a.key, ref: a.ref, category: a.category })) },
      });
    }
    if (manifest.blockers.length) {
      fail('permission_denied', 'unattested mechanical carry-forward blocks export; record an attest_carry_forward decision first', {
        details: { blockers: manifest.blockers },
      });
    }
    const now = computeRequiredSet(ctx.store);
    if (now.digest !== manifest.required_set.digest) {
      fail('stale_dependency', 'the required set changed after the preview was frozen; prepare a new preview');
    }
    checkDisclosure(ctx.store, rm.body.artifacts.map((a) => ({ path: a.path, text: ctx.archive.getText(a.artifact.artifact) })), audience);
  },
  apply(d) {
    const mref = d.payload.inputs.report_manifest as Ref;
    d.ctx.tx.revise(mref.record_id, 'report_manifest', (b) => ({ ...b, status: 'approved', approval: d.decision }), {
      expectedRevision: mref.revision,
    });
    return { report_manifest: mref, payload: d.payload.inputs.payload, destination: d.payload.inputs.destination };
  },
};

/**
 * Everything that is material about an unfixed finding: the finding, its investigation, the
 * decisions that disposed it, its fix assessments, review packets, variants, jobs, attempts and
 * evidence, identified by record ID, plus the finding's title.
 */
function unfixedMaterial(store: RecordStore): { finding: Ref; fix_label: string; ids: Set<string>; titles: string[] }[] {
  const out: { finding: Ref; fix_label: string; ids: Set<string>; titles: string[] }[] = [];
  for (const f of store.heads('finding')) {
    const label = fixLabelOf(store, f);
    if (label === 'fixed') continue;
    const ids = new Set<string>([f.record_id, f.body.investigation.record_id, f.body.acceptance.record_id]);
    for (const fa of f.body.fix_assessments) ids.add(fa.record_id);
    const inv = store.head<'investigation'>(f.body.investigation.record_id);
    if (inv) {
      if (inv.body.disposition) ids.add(inv.body.disposition.decision.record_id);
      for (const c of inv.body.linked_claims) if (c.disposition) ids.add(c.disposition.decision.record_id);
      for (const r of [...inv.body.supporting, ...inv.body.refuting, ...inv.body.variants, ...inv.body.jobs, ...inv.body.probes]) {
        if (!isArtifactRef(r)) ids.add(r.record_id);
      }
    }
    const invId = f.body.investigation.record_id;
    const jobs = store.heads('job').filter((j) => j.body.investigation?.record_id === invId);
    for (const j of jobs) ids.add(j.record_id);
    const jobIds = new Set(jobs.map((j) => j.record_id));
    for (const a of store.heads('attempt')) if (jobIds.has(a.body.job.record_id)) ids.add(a.record_id);
    for (const e of store.heads('evidence_artifact')) if (e.body.job && jobIds.has(e.body.job.record_id)) ids.add(e.record_id);
    for (const pk of store.heads('review_packet')) if (pk.body.investigation.record_id === invId) ids.add(pk.record_id);
    for (const v of store.heads('scenario_variant')) if (v.body.investigation.record_id === invId) ids.add(v.record_id);
    out.push({ finding: refOf(f), fix_label: label, ids, titles: [f.body.title, md(f.body.title)] });
  }
  return out;
}

function mentions(text: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(text);
}

/**
 * Disclosure constraints are checked against the whole frozen payload: every record file, the
 * manifest (including the required set's reasons and details), report.md, the README and the
 * reproduction material. Under `no_unfixed_findings:<audience>`, any mention of material about a
 * finding whose fix label is not `fixed` refuses the approval; redacting it from the selection is not
 * enough while the required set still names it, so the release waits for the fix (design: approval is
 * refused when such material conflicts with the audience's disclosure constraints).
 */
function checkDisclosure(store: RecordStore, files: { path: string; text: string }[], audience: string): void {
  const policy = engagementHead(store).body.policy;
  const constraints = (policy?.disclosure_constraints ?? []).map((c) => ({ raw: c, parsed: parseConstraint(c) }));
  const unknown = constraints.filter((c) => !c.parsed);
  if (unknown.length) {
    fail('permission_denied', 'disclosure constraints outside the checked vocabulary cannot be verified; restate them', {
      details: { constraints: unknown.map((c) => c.raw), vocabulary: ['no_unfixed_findings:<audience|*>', 'no_export:<audience|*>', 'note:<text>'] },
    });
  }
  const applies = (a: string | null) => a === '*' || a === audience;
  for (const c of constraints) {
    const k = c.parsed!;
    if (k.kind === 'no_export' && applies(k.audience)) fail('permission_denied', `disclosure constraint ${c.raw} forbids release to ${audience}`);
    if (k.kind === 'no_unfixed_findings' && applies(k.audience)) {
      const unfixed: { finding: Ref; fix_label: string; in: string[] }[] = [];
      for (const u of unfixedMaterial(store)) {
        const hits = files
          .filter((f) => [...u.ids].some((id) => f.path.includes(`/${id}/`) || mentions(f.text, id)) || u.titles.some((t) => f.text.includes(t)))
          .map((f) => f.path);
        if (hits.length) unfixed.push({ finding: u.finding, fix_label: u.fix_label, in: hits.slice(0, 20) });
      }
      if (unfixed.length) {
        fail('permission_denied', `material about unfixed findings conflicts with disclosure constraint ${c.raw}`, { details: { unfixed } });
      }
    }
  }
}

defineOperation<DecisionPayload>({
  name: 'approve_export',
  channels: ['screen'],
  mutating: true,
  handler(ctx, p) {
    if (!p || typeof p !== 'object') fail('invalid_request', 'decision payload required');
    return commitDecision(ctx, { ...p, decision_kind: 'approve_export' }, APPROVE_EXPORT);
  },
});

// -----------------------------------------------------------------------------------------------
// export_bundle

/** Absolute destination with symlinks resolved: realpath of the nearest existing ancestor + the rest. */
export function realDestination(p: string): string {
  let head = resolve(p);
  const rest: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    rest.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(head), ...rest);
}

/** Path-boundary containment (not a string prefix): `child` is `root` or lies beneath it. */
export function isWithin(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

export interface ExportBundlePayload {
  report_manifest: Ref;
  destination: string;
}

defineOperation<ExportBundlePayload>({
  name: 'export_bundle',
  channels: ['auditor', 'controller'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.report_manifest || !p.destination) fail('invalid_request', 'report_manifest and destination are required');
    const rm = ctx.store.get(p.report_manifest, 'report_manifest');
    const head = ctx.store.mustHead(rm.record_id, 'report_manifest');
    if (head.revision !== rm.revision) fail('revision_conflict', `report manifest ${rm.record_id} is at revision ${head.revision}`);
    if (rm.body.status !== 'approved' || !rm.body.approval) fail('permission_denied', `report manifest is ${rm.body.status}; only an approved export can be written`);
    const approval = ctx.store.get(rm.body.approval, 'human_decision');
    const inputs = approval.body.inputs as unknown as ApproveExportInputs;
    if (approval.body.kind !== 'approve_export' || inputs.payload !== rm.body.payload.artifact || inputs.report_manifest?.record_id !== rm.record_id) {
      fail('permission_denied', 'the approval does not bind this payload');
    }
    const dest = realDestination(p.destination);
    if (dest !== realDestination(inputs.destination)) fail('permission_denied', 'the destination differs from the approved destination');
    if (isWithin(realpathSync(ctx.ws.root), dest)) fail('permission_denied', 'an export cannot be written inside the harness workspace');
    if (existsSync(dest) && readdirSync(dest).length) fail('invalid_request', 'the destination exists and is not empty');

    const receipt = {
      format: 'harness.release-receipt/1',
      payload: rm.body.payload.artifact,
      report_manifest: refOf(rm),
      approval: rm.body.approval,
      audience: rm.body.audience,
      destination: dest,
      exported_at: ctx.now,
      outcome: 'written_locally',
      note: 'This receipt is outside the hashed payload. Delivery to a third party is a separate action.',
    };
    const tmp = `${dest}.partial-${process.pid}-${Date.now()}`;
    try {
      for (const a of rm.body.artifacts) {
        const bad = unsafePath(a.path);
        if (bad || a.path === RECEIPT_PATH) fail('integrity_failure', `payload path ${a.path} refused`);
        const target = join(tmp, a.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, ctx.archive.get(a.artifact.artifact), { flag: 'wx', mode: 0o644 });
      }
      writeFileSync(join(tmp, RECEIPT_PATH), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
      const v = verifyBundle(tmp);
      if (!v.ok || v.payload !== rm.body.payload.artifact) fail('integrity_failure', 'the written bundle does not verify', { details: v.problems });
      if (existsSync(dest)) rmSync(dest, { recursive: true });
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(tmp, dest);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    // A crash after the rename leaves a written bundle whose manifest still says `approved`; a retry
    // is refused because the destination is not empty, and the receipt in the directory names the
    // approval so the state can be reconciled.
    const receiptRef = ctx.archive.putJson(receipt);
    ctx.tx.blob(receiptRef);
    ctx.tx.revise(rm.record_id, 'report_manifest', (b) => ({ ...b, status: 'exported', export_receipt: receiptRef }), {
      expectedRevision: rm.revision,
    });
    return { destination: dest, payload: rm.body.payload.artifact, export_receipt: receiptRef };
  },
});
