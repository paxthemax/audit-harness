import { fail, HarnessError } from '../core/errors.ts';
import { digestJson } from '../core/hash.ts';
import { isArtifactRef, refKey, type AnyRef, type ArtifactRef, type Ref } from '../core/refs.ts';
import { DISPOSITIONS, isHighOrCritical, isMediumOrAbove, RATIONALE_AUTHORSHIP, type Disposition } from '../core/values.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import type { PositionBody, ProofStatus, RecordEnvelope, ReviewPacketBody } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { dependencyClosure, unreviewedStatements } from './framework.ts';
import { requireWorkerScope, textOrNull } from './common.ts';
import { fixtureOverrides, investigationFixtureOverrides } from './fixtures.ts';
import { parseProviderNote } from '../runner/ledger.ts';
import { readFoundryConfig } from '../snapshot/source.ts';

// Review packets (design/harness-state-and-execution.md, "Record contracts" and "State transitions";
// DEC-007 combined packet; DEC-008 Q-017 evidence-first order at potential High/Critical).
//
// The controller assembles every list itself — refuting records, failed attempts, every scenario
// variant with its outcome, linked claims with unreviewed-flow flags, unreviewed agent statements —
// so nothing an agent pruned is hidden. It checks completeness, not semantic truth, and computes the
// inbound-link digest and evidence watermark that a later decision must still match.

/** Record types whose arrival changes what the auditor must see before deciding. */
const INBOUND_TYPES = new Set([
  'evidence_artifact',
  'behavioral_discrepancy',
  'clarification',
  'system_statement',
  'scenario_variant',
  'conclusion_freshness',
  'dependency_probe',
]);

function mentions(env: RecordEnvelope, invId: string, guarantees: string[]): boolean {
  if (env.depends_on.some((d) => !isArtifactRef(d) && d.record_id === invId)) return true;
  const b = env.body as unknown as Record<string, unknown>;
  const refsIn = (v: unknown): boolean =>
    Array.isArray(v) && v.some((r) => r && typeof r === 'object' && (r as Ref).record_id === invId);
  switch (env.type) {
    case 'scenario_variant':
      return (b.investigation as Ref).record_id === invId;
    case 'behavioral_discrepancy':
      return refsIn(b.investigations);
    case 'clarification':
      return refsIn(b.blocks);
    case 'conclusion_freshness':
      return (b.conclusion as Ref).record_id === invId;
    case 'dependency_probe':
      return (b.conclusion as Ref | null)?.record_id === invId;
    case 'system_statement':
      // A statement that contradicts the investigation or speaks to its guarantee.
      return refsIn(b.contradicting) || refsIn(b.supporting) || (guarantees.length > 0 && b.kind === 'guarantee' && guarantees.includes(String(b.statement)));
    default:
      return false;
  }
}

/** Evidence linked to an investigation: through its jobs, or explicitly via depends_on. */
export function linkedEvidence(store: RecordStore, invId: string): RecordEnvelope<'evidence_artifact'>[] {
  const jobIds = new Set(
    store
      .heads('job')
      .filter((j) => j.body.investigation?.record_id === invId)
      .map((j) => j.record_id),
  );
  return store
    .heads('evidence_artifact')
    .filter(
      (e) =>
        (e.body.job && jobIds.has(e.body.job.record_id)) ||
        e.body.positive_control_for?.record_id === invId ||
        e.depends_on.some((d) => !isArtifactRef(d) && d.record_id === invId),
    );
}

export interface InboundLinks {
  refs: Ref[];
  digest: string;
  watermark: number;
}

/**
 * Inbound links: refuting evidence, discrepancies, clarifications, statements, variants, freshness and
 * probes linked to the investigation or its guarantee. Their exact revisions form the digest; the
 * evidence watermark counts eligible linked evidence.
 */
export function inboundLinks(store: RecordStore, invId: string): InboundLinks {
  const inv = store.mustHead(invId, 'investigation');
  const linked = new Map<string, Ref>();
  for (const env of store.heads()) {
    if (!INBOUND_TYPES.has(env.type)) continue;
    if (env.type === 'evidence_artifact') continue;
    if (mentions(env, invId, inv.body.guarantees)) linked.set(env.record_id, { record_id: env.record_id, revision: env.revision });
  }
  const evidence = linkedEvidence(store, invId);
  for (const e of evidence) linked.set(e.record_id, { record_id: e.record_id, revision: e.revision });
  const refs = [...linked.values()].sort((a, b) => a.record_id.localeCompare(b.record_id, 'en', { numeric: true }));
  return { refs, digest: digestJson(refs.map(refKey)), watermark: evidence.filter((e) => e.body.eligible).length };
}

function jobOf(store: RecordStore, e: RecordEnvelope<'evidence_artifact'>): RecordEnvelope<'job'> | undefined {
  return e.body.job ? store.head<'job'>(e.body.job.record_id) : undefined;
}

/** Latest eligible trusted-runner evidence of a job purpose for the investigation. */
/**
 * Which claim a job's evidence speaks to: the investigation question (variant absent or not a linked
 * variant) or one linked claim (its variant belongs to that claim).
 */
export type ClaimScope = { linkedClaimId: string | null };

function variantClaim(store: RecordStore, variant: Ref | null): string | null {
  if (!variant) return null;
  return store.head<'scenario_variant'>(variant.record_id)?.body.linked_claim_id ?? null;
}

function inScope(store: RecordStore, job: RecordEnvelope<'job'> | undefined, scope?: ClaimScope): boolean {
  if (!scope) return true;
  return variantClaim(store, job?.body.variant ?? null) === scope.linkedClaimId;
}

export function latestEvidence(store: RecordStore, invId: string, purpose: 'replay' | 'positive_control', scope?: ClaimScope): RecordEnvelope<'evidence_artifact'> | undefined {
  const list = linkedEvidence(store, invId).filter((e) => {
    if (e.body.producer !== 'trusted_runner') return false;
    const job = jobOf(store, e);
    if (job?.body.purpose !== purpose || !inScope(store, job, scope)) return false;
    return purpose === 'positive_control' ? isBoundPositiveControl(store, invId, job) : true;
  });
  return list.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.record_id.localeCompare(b.record_id, 'en', { numeric: true })).at(-1);
}

/**
 * A positive control counts only when it reruns the SAME experiment against a disposable copy with the
 * cited guard removed: it has a guard removal, and its lineage job is an experiment of this
 * investigation with the same adapter, mode, arguments and fixture (state-and-execution, "Replay and
 * semantic validity"; DEC-008 Q-016).
 */
export function isBoundPositiveControl(store: RecordStore, invId: string, job: RecordEnvelope<'job'>): boolean {
  if (job.body.purpose !== 'positive_control' || !job.body.guard_removal || !job.body.lineage) return false;
  if (!isTargetSourceEdit(store, job, true)) return false;
  const base = store.tryGet<'job'>(job.body.lineage);
  if (!base || base.type !== 'job' || base.body.investigation?.record_id !== invId) return false;
  if (!['experiment', 'replay'].includes(base.body.purpose)) return false;
  return (
    base.body.adapter.name === job.body.adapter.name &&
    base.body.operation === job.body.operation &&
    digestJson(base.body.args) === digestJson(job.body.args) &&
    (base.body.fixture?.artifact ?? null) === (job.body.fixture?.artifact ?? null) &&
    (base.body.variant?.record_id ?? null) === (job.body.variant?.record_id ?? null)
  );
}

/** True when `small` can be obtained from `big` by deleting characters. */
function isSubsequence(small: string, big: string): boolean {
  let i = 0;
  for (const ch of big) if (i < small.length && ch === small[i]) i++;
  return i === small.length;
}

/**
 * A guard removal (or a reviewed fault) edits a TARGET source file: one the snapshot contains, the
 * job's fixture does not touch, outside the test and script directories. A guard removal only removes
 * code (the replacement is a subsequence of the original, or blank, or a comment).
 */
export function isTargetSourceEdit(store: RecordStore, job: RecordEnvelope<'job'>, removalOnly: boolean): boolean {
  const g = job.body.guard_removal;
  if (!g) return false;
  const snap = store.tryGet<'target_snapshot'>(job.body.snapshot);
  if (!snap) return false;
  const tree = store.archive.getTree(snap.body.tree.artifact).files;
  if (!(g.path in tree)) return false;
  const cfgDigest = tree['foundry.toml'];
  const cfg = readFoundryConfig(cfgDigest ? store.archive.getText(cfgDigest) : null);
  if ([cfg.test, cfg.script].some((d) => g.path.startsWith(d.replace(/^\.\//, '').replace(/\/+$/, '') + '/'))) return false;
  if (job.body.fixture && g.path in store.archive.getTree(job.body.fixture.artifact).files) return false;
  if (!removalOnly) return true;
  const r = g.replace.trim();
  return r === '' || /^(\/\/[^\n]*|\/\*[\s\S]*\*\/)$/.test(r) || isSubsequence(g.replace, g.find);
}

/** Target files a job's fixture overrides (a replay that alters the target is not a clean replay). */
function fixtureOverridesTarget(store: RecordStore, job: RecordEnvelope<'job'> | undefined): boolean {
  if (!job?.body.fixture) return false;
  const snap = store.tryGet<'target_snapshot'>(job.body.snapshot);
  if (!snap) return true;
  return fixtureOverrides(store.archive, snap.body.tree.artifact, job.body.fixture.artifact).overrides.length > 0;
}

/** Replay status from clean-replay evidence: a demonstrated violation is `succeeded`. */
export function replayStatus(store: RecordStore, invId: string, required: boolean, scope?: ClaimScope): ProofStatus['replay'] {
  const ev = latestEvidence(store, invId, 'replay', scope);
  if (!ev) return required ? 'pending' : 'not_required';
  if (!ev.body.eligible || fixtureOverridesTarget(store, jobOf(store, ev))) return 'unavailable';
  const t = ev.body.structured_result?.result_type;
  if (t === 'counterexample') return 'succeeded';
  return 'failed';
}

/** Any refutation of the claim on record: refuted variants or refuting experiment evidence. */
export function hasRefutation(store: RecordStore, inv: RecordEnvelope<'investigation'>, scope: ClaimScope): boolean {
  const variants = inv.body.variants.map((v) => store.mustHead(v.record_id, 'scenario_variant')).filter((v) => v.body.linked_claim_id === scope.linkedClaimId);
  if (variants.some((v) => v.body.outcome === 'refuted')) return true;
  return linkedEvidence(store, inv.record_id).some((e) => {
    const job = jobOf(store, e);
    const t = e.body.structured_result?.result_type;
    return job?.body.purpose === 'experiment' && inScope(store, job, scope) && (t === 'no_violation_observed' || t === 'proved_in_model');
  }) || (scope.linkedClaimId === null && inv.body.refuting.length > 0);
}

/** Positive control: the guard-removed rerun must show the violation (DEC-008 Q-016). */
export function positiveControlStatus(store: RecordStore, invId: string, required: boolean, scope?: ClaimScope): ProofStatus['positive_control'] {
  const ev = latestEvidence(store, invId, 'positive_control', scope);
  if (!ev) return required ? 'pending' : 'not_required';
  if (!ev.body.eligible) return 'unavailable';
  const t = ev.body.structured_result?.result_type;
  if (t === 'counterexample') return 'shows_violation';
  if (t === 'no_violation_observed') return 'no_violation';
  return 'unavailable';
}

/** Failed attempts of the investigation's jobs (every one is listed in the packet). */
export function failedAttempts(store: RecordStore, invId: string): Ref[] {
  const jobIds = new Set(store.heads('job').filter((j) => j.body.investigation?.record_id === invId).map((j) => j.record_id));
  return store
    .heads('attempt')
    .filter((a) => jobIds.has(a.body.job.record_id) && ['failed', 'cancelled', 'outcome_unknown'].includes(a.body.status))
    .map((a) => ({ record_id: a.record_id, revision: a.revision }));
}

export function evidenceQuality(
  store: RecordStore,
  inv: RecordEnvelope<'investigation'>,
  proposed: Disposition | null,
): ProofStatus {
  const impact = inv.body.potential_impact.effective;
  const replayRequired = inv.body.executable && proposed === 'accepted' && isMediumOrAbove(impact);
  const pcRequired = inv.body.executable && proposed === 'rejected' && isHighOrCritical(impact);
  const evidence = linkedEvidence(store, inv.record_id);
  const provenance =
    evidence.length > 0 && evidence.every((e) => e.body.eligible && e.body.producer === 'trusted_runner' && e.body.missing_or_truncated.length === 0)
      ? 'complete'
      : 'incomplete';
  return {
    provenance,
    prerequisite_review: inv.body.proof_status.prerequisite_review,
    adequacy: inv.body.proof_status.adequacy,
    adequacy_reason: inv.body.proof_status.adequacy_reason,
    replay: replayStatus(store, inv.record_id, replayRequired, { linkedClaimId: null }),
    positive_control: positiveControlStatus(store, inv.record_id, pcRequired, { linkedClaimId: null }),
  };
}

/**
 * Proposed rule (an implementation default, not an operator decision): a challenge is required unless
 * the potential impact is low/info or the proposed disposition is `triaged_out`.
 */
export function challengeRequired(impact: string, proposed: Disposition | null): boolean {
  return !(impact === 'low' || impact === 'info' || proposed === 'triaged_out');
}

export interface PositionView {
  record_id: string;
  revision: number;
  body: PositionBody;
}

/** Challenge independence derived from the position records (never self-reported in the packet). */
function independence(ch: PositionView | null, au: PositionView | null, shared: string[]): ReviewPacketBody['challenge_independence'] {
  const same = (a: string | null | undefined, b: string | null | undefined) => (a && b ? a === b : null);
  const parts: string[] = [];
  if (ch) {
    parts.push(`challenger submitted by ${ch.body.submitted_by.principal}${ch.body.submitted_by.channel === 'auditor' ? ' (entered by the auditor)' : ''}`);
    parts.push(
      ch.body.initial_context_withheld === true
        ? 'initial context withheld the author rationale and provisional statements'
        : ch.body.initial_context_withheld === false
          ? 'initial context did NOT withhold the author rationale'
          : 'initial context exposure not recorded',
    );
  } else parts.push('no challenger position');
  return { same_model: same(ch?.body.model, au?.body.model), same_provider: same(ch?.body.provider, au?.body.provider), shared_premises: shared, context: parts.join('; ') };
}

export interface SubmitPacketPayload {
  investigation: Ref | { record_id: string; revision?: number };
  claim: string;
  decision_requested: string;
  /** Position records (submit_position); the auditor channel may also pass verbatim text. */
  challenger_position?: Ref | ArtifactRef | string | null;
  author_position?: Ref | ArtifactRef | string | null;
  /** Premises the author and challenger share (descriptive); model/provider sameness is derived. */
  shared_premises?: string[];
  proposed_disposition?: { value: Disposition; rationale: string; authorship?: 'agent_drafted_unedited' | 'human_written' } | null;
  executable_confirmation_requested?: boolean;
  next_check?: string | null;
  missing_information?: string[];
}


defineOperation<SubmitPacketPayload>({
  name: 'submit_review_packet',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.investigation) fail('invalid_request', 'investigation is required');
    requireWorkerScope(ctx, p.investigation.record_id);
    const head = ctx.store.mustHead(p.investigation.record_id, 'investigation');
    // A worker may name only the investigation of its grant and gets its current revision (earlier
    // outbox entries of the same round may have revised it); everyone else names an exact revision.
    const expectedRevision = p.investigation.revision ?? (ctx.principal.channel === 'worker' ? head.revision : undefined);
    if (expectedRevision === undefined) fail('invalid_request', 'name the exact investigation revision you reviewed');
    if (head.revision !== expectedRevision) {
      fail('revision_conflict', `investigation is at revision ${head.revision}`, { details: { expected: p.investigation.revision, actual: head.revision } });
    }
    if (head.body.disposition) fail('invalid_request', 'the investigation already has a disposition');
    if (!['running', 'queued', 'blocked', 'ready_for_review'].includes(head.body.work_state)) {
      fail('invalid_request', `an investigation in state ${head.body.work_state} has no admitted work to review`);
    }
    const proposed = p.proposed_disposition ?? null;
    if (proposed && !DISPOSITIONS.includes(proposed.value)) fail('invalid_request', 'invalid proposed disposition');
    if (proposed && !textOrNull(proposed.rationale)) fail('invalid_request', 'a proposed disposition needs a rationale');

    const store = ctx.store;
    const inv = head;
    const missing: string[] = [];
    const variants = inv.body.variants.map((v) => {
      const cur = store.mustHead(v.record_id, 'scenario_variant');
      if (cur.body.outcome === null) missing.push(`outcome of scenario variant ${cur.record_id}`);
      return { variant: { record_id: cur.record_id, revision: cur.revision }, outcome: cur.body.outcome, linked_guarantee: cur.body.linked_guarantee };
    });
    const impact = inv.body.potential_impact.effective;
    const needsChallenge = challengeRequired(impact, proposed?.value ?? null);
    const challengerPos = resolvePosition(ctx, p.challenger_position, 'challenger', inv.record_id);
    const authorPos = resolvePosition(ctx, p.author_position, 'author', inv.record_id);
    const challenger = challengerPos?.body.content ?? null;
    const author = authorPos?.body.content ?? null;
    if (needsChallenge && !challenger) missing.push('challenger position (verbatim artifact)');
    if (needsChallenge && !author) missing.push('author position (verbatim artifact)');
    if (challengerPos && authorPos && challengerPos.body.submitted_by.principal === authorPos.body.submitted_by.principal && challengerPos.body.submitted_by.channel === 'worker') {
      missing.push('a challenger position from a principal other than the author');
    }
    const quality = evidenceQuality(store, inv, proposed?.value ?? null);
    const execConfirm = p.executable_confirmation_requested ?? (proposed?.value === 'accepted' && inv.body.executable);
    const replay = latestEvidence(store, inv.record_id, 'replay');
    if (execConfirm && isMediumOrAbove(impact) && quality.replay !== 'succeeded') {
      missing.push('clean replay receipt for the requested executable confirmation');
    }

    const linkedClaims = inv.body.linked_claims.map((c) => {
      const flowReviewed = c.flow ? store.mustHead(c.flow.record_id, 'audit_unit').body.review_status === 'reviewed' : false;
      return { id: c.id, guarantee: c.guarantee, potential_impact: c.potential_impact.effective, unreviewed_flow: !flowReviewed };
    });

    if (missing.length) {
      throw new HarnessError('packet_incomplete', `the packet is missing: ${missing.join('; ')}`, { details: { missing } });
    }

    // Move to ready_for_review first so the packet binds the investigation's current revision.
    const invRef = ctx.tx.revise(inv.record_id, 'investigation', (b) => ({ ...b, work_state: 'ready_for_review', blocked_reason: null }));
    const evidence = linkedEvidence(store, inv.record_id);
    const supporting: AnyRef[] = [...inv.body.supporting];
    const refuting: AnyRef[] = [...inv.body.refuting];
    for (const e of evidence) {
      const r = { record_id: e.record_id, revision: e.revision };
      const t = e.body.structured_result?.result_type;
      if (t === 'counterexample' && !supporting.some((x) => refKey(x) === refKey(r))) supporting.push(r);
      if ((t === 'no_violation_observed' || t === 'proved_in_model') && !refuting.some((x) => refKey(x) === refKey(r))) refuting.push(r);
    }
    for (const v of variants) {
      if (v.outcome === 'refuted' && !refuting.some((x) => refKey(x) === refKey(v.variant))) refuting.push(v.variant);
      if (v.outcome === 'supports' && !supporting.some((x) => refKey(x) === refKey(v.variant))) supporting.push(v.variant);
    }
    const links = inboundLinks(store, inv.record_id);
    const positions = [challengerPos, authorPos].filter((x): x is PositionView => !!x).map((x) => ({ record_id: x.record_id, revision: x.revision }));
    const included: Ref[] = [invRef, ...variants.map((v) => v.variant), ...evidence.map((e) => ({ record_id: e.record_id, revision: e.revision })), ...positions];
    const closure = dependencyClosure(store, [{ record_id: inv.record_id, revision: inv.revision }, ...included.filter((r) => r.record_id !== inv.record_id)]);
    const unreviewed = unreviewedStatements(store, closure);
    // Statements the investigation itself cites as supporting or refuting are in its closure too.
    for (const r of [...inv.body.supporting, ...inv.body.refuting]) {
      if (isArtifactRef(r)) continue;
      const env = store.tryGet(r);
      if (env?.type === 'system_statement' && store.mustHead(r.record_id, 'system_statement').body.review_status !== 'reviewed' && !unreviewed.some((u) => refKey(u) === refKey(r))) {
        unreviewed.push(r);
      }
    }
    const body: ReviewPacketBody = {
      investigation: invRef,
      potential_impact: impact,
      claim: String(p.claim ?? '').trim() || inv.body.question,
      decision_requested: String(p.decision_requested ?? '').trim() || 'disposition',
      supporting,
      refuting,
      failed_attempts: failedAttempts(store, inv.record_id),
      variants,
      linked_claims: linkedClaims,
      challenge_required: needsChallenge,
      challenger_position: challenger,
      author_position: author,
      challenge_independence: independence(challengerPos, authorPos, Array.isArray(p.shared_premises) ? p.shared_premises : []),
      unreviewed_statements: unreviewed,
      evidence_quality: quality,
      replay_receipt: replay ? { record_id: replay.record_id, revision: replay.revision } : null,
      executable_confirmation_requested: !!execConfirm,
      proposed_disposition: proposed
        ? {
            value: proposed.value,
            rationale: proposed.rationale,
            authorship: ctx.principal.channel === 'worker' ? 'agent_drafted_unedited' : RATIONALE_AUTHORSHIP.includes(proposed.authorship as never) ? proposed.authorship! : 'human_written',
          }
        : null,
      next_check: textOrNull(p.next_check),
      missing_information: Array.isArray(p.missing_information) ? p.missing_information : [],
      inbound_link_digest: links.digest,
      evidence_watermark: links.watermark,
      dependency_digest: digestJson(included.map(refKey).sort()),
      fixture_overrides: investigationFixtureOverrides(store, inv.record_id),
    };
    const packet = ctx.tx.create('review_packet', body, included);
    ctx.tx.event('ready_for_review', { investigation: invRef, packet });
    return { packet, investigation: invRef, work_state: 'ready_for_review' };
  },
});

/** The newest packet for an investigation, if any. */
export function latestPacket(store: RecordStore, invId: string): RecordEnvelope<'review_packet'> | undefined {
  return store
    .heads('review_packet')
    .filter((p) => p.body.investigation.record_id === invId)
    .sort((a, b) => a.record_id.localeCompare(b.record_id, 'en', { numeric: true }))
    .at(-1);
}

// -----------------------------------------------------------------------------------------------
// Positions (DEC-007; DEC-008 Q-017): the author's and the challenger's positions are records bound
// to who submitted them, so an author cannot write "the challenger's" position or claim independence.

export interface SubmitPositionPayload {
  investigation: Ref | { record_id: string };
  role: 'author' | 'challenger';
  text: string;
  model?: string | null;
  provider?: string | null;
  context_manifest?: ArtifactRef | null;
  initial_context_withheld?: boolean | null;
}

const AUTHOR_ROLES = new Set(['investigator', 'property']);

defineOperation<SubmitPositionPayload>({
  name: 'submit_position',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.investigation?.record_id || !['author', 'challenger'].includes(p.role)) fail('invalid_request', 'investigation and role are required');
    if (!textOrNull(p.text)) fail('invalid_request', 'the position text is required');
    const inv = ctx.store.mustHead(p.investigation.record_id, 'investigation');
    requireWorkerScope(ctx, inv.record_id);
    const g = ctx.principal.grant;
    if (ctx.principal.channel === 'worker') {
      if (p.role === 'challenger' && g!.role !== 'challenger') fail('permission_denied', 'only a challenger-role worker submits the challenger position');
      if (p.role === 'author' && !AUTHOR_ROLES.has(g!.role)) fail('permission_denied', `a ${g!.role} worker does not author investigation positions`);
    }
    if (p.context_manifest && !ctx.archive.has(p.context_manifest.artifact)) fail('artifact_incomplete', 'context manifest is not in the archive');
    // Independence facts come from what the controller observed for a worker's attempt, never from
    // the payload: the models the provider returned, and whether the attempt's controller-built context
    // withheld the author's material (a challenger manifest does by construction).
    let model = textOrNull(p.model);
    let provider = textOrNull(p.provider);
    let withheld: boolean | null = typeof p.initial_context_withheld === 'boolean' ? p.initial_context_withheld : null;
    let manifest = p.context_manifest ?? null;
    if (ctx.principal.channel === 'worker') {
      const job = ctx.store.get(g!.job, 'job');
      manifest = job.body.context_manifest;
      const calls = ctx.store
        .heads('ledger_entry')
        .filter((l) => l.body.attempt?.record_id === g!.attempt.record_id)
        .map((l) => parseProviderNote(l.body.note))
        .filter((n): n is NonNullable<typeof n> => !!n && !!n.model_returned);
      const models = [...new Set(calls.map((c) => c.model_returned!))];
      const providers = [...new Set(calls.map((c) => c.provider))];
      model = models.length ? models.join(', ') : null;
      provider = providers.length ? providers.join(', ') : null;
      withheld = null;
      if (manifest && ctx.archive.has(manifest.artifact)) {
        const m = ctx.archive.getJson<{ role?: string; withheld?: unknown[] }>(manifest.artifact);
        withheld = p.role === 'challenger' ? m.role === 'challenger' : null;
      }
    }
    const content = ctx.archive.put(p.text);
    ctx.tx.blob(content);
    const ref = ctx.tx.create('position', {
      role: p.role,
      investigation: { record_id: inv.record_id, revision: inv.revision },
      content,
      submitted_by: {
        channel: ctx.principal.channel === 'worker' ? 'worker' : 'auditor',
        principal: ctx.principal.principal,
        worker_role: g?.role ?? null,
        job: g?.job ?? null,
      },
      model,
      provider,
      context_manifest: manifest,
      initial_context_withheld: withheld,
    });
    return { position: ref };
  },
});

/** Resolve a packet's position input: a position record, or (auditor channel only) verbatim text. */
export function resolvePosition(ctx: OpContext, v: Ref | ArtifactRef | string | null | undefined, role: 'author' | 'challenger', invId: string): PositionView | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || 'artifact' in v) {
    // Positions written outside the harness reach it only through the auditor, labelled as such.
    if (ctx.principal.channel !== 'auditor') fail('permission_denied', `the ${role} position must be a position record (submit_position)`);
    const text = typeof v === 'string' ? v : ctx.archive.getText(v.artifact);
    const content = ctx.archive.put(text);
    ctx.tx.blob(content);
    const inv = ctx.store.mustHead(invId, 'investigation');
    const ref = ctx.tx.create('position', {
      role,
      investigation: { record_id: inv.record_id, revision: inv.revision },
      content,
      submitted_by: { channel: 'auditor', principal: ctx.principal.principal, worker_role: null, job: null },
      model: null,
      provider: null,
      context_manifest: null,
      initial_context_withheld: null,
    });
    return { record_id: ref.record_id, revision: ref.revision, body: ctx.tx.current(ref.record_id, 'position').body };
  }
  const pos = ctx.store.get(v, 'position');
  if (pos.body.role !== role) fail('invalid_request', `${v.record_id} is the ${pos.body.role} position, not the ${role}'s`);
  if (pos.body.investigation.record_id !== invId) fail('invalid_request', `${v.record_id} concerns another investigation`);
  // A position written before later experiment evidence or new variants did not see them: it is stale.
  // (An agent round's own transcript evidence and later outcome labels on seen variants do not count.)
  const newerEvidence = linkedEvidence(ctx.store, invId).filter((e) => {
    const job = e.body.job ? ctx.store.head<'job'>(e.body.job.record_id) : undefined;
    return job?.body.purpose !== 'agent' && e.created_at > pos.created_at;
  });
  const newerVariants = ctx.store
    .heads('scenario_variant')
    .filter((x) => x.body.investigation.record_id === invId && ctx.store.history(x.record_id)[0].created_at > pos.created_at);
  const newer = [...newerEvidence, ...newerVariants].map((x) => x.record_id);
  if (newer.length) {
    fail('stale_dependency', `${v.record_id} predates later work on the investigation (${newer.join(', ')}); submit a current ${role} position`, { details: { newer } });
  }
  return { record_id: pos.record_id, revision: pos.revision, body: pos.body };
}
