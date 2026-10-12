import { fail, HarnessError } from '../core/errors.ts';
import { digestJson } from '../core/hash.ts';
import { isArtifactRef, refKey, type AnyRef, type Ref } from '../core/refs.ts';
import type { DecisionKind, RationaleAuthorship } from '../core/values.ts';
import { RATIONALE_AUTHORSHIP } from '../core/values.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { RecordEnvelope } from '../schema/records.ts';

// Human decisions (design/harness-interface-contracts.md, "Human decision kinds";
// design/harness-state-and-execution.md, "Write and approval protocol").
//
// Every decision arrives on the trusted-screen channel with: the exact revisions the auditor reviewed,
// a display receipt showing the screen rendered them, a rationale and its authorship. The controller
// recomputes the dependency digest (and, for packets, the inbound-link digest and evidence
// watermark) itself; stale inputs are refused with `stale_dependency`, missing displays with
// `display_required`. Unreviewed agent statements in the dependency closure are listed and the
// decision is recorded as conditional on them unless the auditor accepts them explicitly.
// No decision kind accepts a bulk request.

export interface DecisionPayload {
  decision_kind: DecisionKind;
  /** Exact revisions the auditor reviewed on the screen. */
  reviewed: Ref[];
  display_receipt: Ref;
  inputs: Record<string, unknown>;
  rationale: string;
  rationale_authorship: RationaleAuthorship;
  /** The agent's draft when authorship is agent_drafted_*; the controller computes the edit diff. */
  agent_draft?: string | null;
  /** Unreviewed statements in the closure the auditor explicitly accepts as conditions. */
  accepted_unreviewed?: Ref[];
  supersedes?: Ref | null;
}

export interface DecisionContext {
  ctx: OpContext;
  payload: DecisionPayload;
  /** Ref the decision record will have once committed (staged in ctx.tx). */
  decision: Ref;
  receipt: RecordEnvelope<'display_receipt'>;
}

export interface DecisionKindDef {
  kind: DecisionKind;
  /** Where the decision is made. Default 'engagement'. */
  scope?: 'engagement' | 'library' | 'either';
  /**
   * Validate the kind's required inputs before anything is staged. Throw `invalid_request`,
   * `evidence_requirement_unmet`, `display_required`, `permission_denied`, etc.
   * Return the inbound-link digest and evidence watermark when the kind binds a review packet.
   */
  check(ctx: OpContext, p: DecisionPayload, receipt: RecordEnvelope<'display_receipt'>): {
    inbound_link_digest?: string | null;
    evidence_watermark?: number | null;
  } | void;
  /** Stage the decision's consequences (new revisions, findings, entries...). Returns a result. */
  apply(d: DecisionContext): Record<string, unknown>;
}

const kinds = new Map<DecisionKind, DecisionKindDef>();

export function defineDecisionKind(def: DecisionKindDef): void {
  if (kinds.has(def.kind)) throw new Error(`decision kind ${def.kind} defined twice`);
  kinds.set(def.kind, def);
}

export function decisionKinds(): DecisionKind[] {
  return [...kinds.keys()];
}

// -----------------------------------------------------------------------------------------------
// Dependency closure helpers

/** Record refs in `depends_on`, transitively, starting from `roots` (exact revisions). */
export function dependencyClosure(store: RecordStore, roots: Ref[], maxDepth = 12): Ref[] {
  const seen = new Map<string, Ref>();
  const visit = (r: Ref, depth: number) => {
    const k = refKey(r);
    if (seen.has(k) || depth > maxDepth) return;
    const env = store.tryGet(r);
    if (!env) return;
    seen.set(k, { record_id: r.record_id, revision: r.revision });
    for (const d of env.depends_on) if (!isArtifactRef(d) && !d.scope) visit(d, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  return [...seen.values()];
}

/** Closure members that have a newer head than the bound revision (material changes). */
export function staleMembers(store: RecordStore, closure: Ref[]): { ref: Ref; current: number }[] {
  const stale: { ref: Ref; current: number }[] = [];
  for (const r of closure) {
    const head = store.head(r.record_id);
    if (head && head.revision !== r.revision) stale.push({ ref: r, current: head.revision });
  }
  return stale;
}

/** System statements in the closure that no human has reviewed. */
export function unreviewedStatements(store: RecordStore, closure: Ref[]): Ref[] {
  return closure.filter((r) => {
    const env = store.tryGet(r);
    if (!env || env.type !== 'system_statement') return false;
    const head = store.head<'system_statement'>(r.record_id)!;
    return head.body.review_status !== 'reviewed';
  });
}

export function dependencyDigest(closure: Ref[]): string {
  return digestJson([...closure].map(refKey).sort());
}

/** Line diff between an agent draft and the final rationale (recorded with agent-drafted rationales). */
export function editDiff(before: string, after: string): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  // LCS-based diff, adequate for short rationales.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

// -----------------------------------------------------------------------------------------------
// Display receipt checks

export function loadReceipt(ctx: OpContext, r: Ref): RecordEnvelope<'display_receipt'> {
  const env = ctx.store.tryGet<'display_receipt'>(r);
  if (!env || env.type !== 'display_receipt') fail('display_required', 'the decision cites no valid display receipt');
  if (env.created_by.channel !== 'screen') {
    fail('display_required', 'decisions need a display receipt from the trusted decision screen');
  }
  return env;
}

/** Every reviewed revision must have been rendered by the cited receipt. */
export function requireRendered(receipt: RecordEnvelope<'display_receipt'>, reviewed: Ref[]): void {
  const rendered = new Set(receipt.body.rendered.map(refKey));
  const missing = reviewed.filter((r) => !rendered.has(refKey(r)));
  if (missing.length) {
    fail('display_required', 'the display receipt does not cover every reviewed revision', {
      details: { not_rendered: missing },
    });
  }
}

/**
 * Evidence-first order (DEC-008, Q-017): for potential High/Critical decisions the receipt must show
 * the evidence, the challenger's counterargument and the evidence-quality sections opened before the
 * proposed disposition was revealed.
 */
export const EVIDENCE_FIRST_SECTIONS = ['evidence', 'challenger', 'evidence_quality'] as const;
export function requireEvidenceFirst(receipt: RecordEnvelope<'display_receipt'>): void {
  const order = receipt.body.sections.map((s) => s.section);
  const proposedAt = order.indexOf('proposed_disposition');
  for (const s of EVIDENCE_FIRST_SECTIONS) {
    const at = order.indexOf(s);
    if (at < 0) fail('display_required', `section "${s}" was not opened before deciding a potential High/Critical packet`);
    if (proposedAt >= 0 && at > proposedAt) {
      fail('display_required', `the proposed disposition was revealed before section "${s}" (evidence-first order)`);
    }
  }
}

// -----------------------------------------------------------------------------------------------
// record_decision

defineOperation<DecisionPayload>({
  name: 'record_decision',
  channels: ['screen'],
  mutating: true,
  scope: 'either',
  handler(ctx, p) {
    if (!p || typeof p !== 'object') fail('invalid_request', 'decision payload required');
    const def = kinds.get(p.decision_kind);
    if (!def) fail('invalid_request', `unknown decision kind ${p.decision_kind}`);
    const scope = def.scope ?? 'engagement';
    if (scope === 'engagement' && ctx.store.scope === 'library') fail('invalid_request', `${p.decision_kind} is decided in an engagement`);
    if (scope === 'library' && ctx.store.scope !== 'library') fail('invalid_request', `${p.decision_kind} is decided in the library scope`);
    return commitDecision(ctx, p, def);
  },
});

/**
 * Shared path for record_decision and the three decision-bearing operations that keep their own
 * names (authorize_work, revise_premise, approve_export).
 */
export function commitDecision(ctx: OpContext, p: DecisionPayload, def: DecisionKindDef): Record<string, unknown> {
  if (ctx.principal.channel !== 'screen') fail('permission_denied', 'human decisions come only from the trusted decision screen');
  if (!Array.isArray(p.reviewed)) fail('invalid_request', 'reviewed must list the exact revisions reviewed');
  if (!p.rationale || !p.rationale.trim()) fail('invalid_request', 'a rationale is required');
  if (!RATIONALE_AUTHORSHIP.includes(p.rationale_authorship)) fail('invalid_request', 'rationale_authorship is required');
  if (Array.isArray((p.inputs as { bulk?: unknown })?.bulk)) fail('invalid_request', 'bulk decisions are refused');
  if (!p.display_receipt) fail('display_required', 'the decision cites no display receipt');

  const receipt = loadReceipt(ctx, p.display_receipt);
  requireRendered(receipt, p.reviewed);

  // Material changes since review: the reviewed revisions and their dependency closure must be current.
  const closure = dependencyClosure(ctx.store, p.reviewed);
  const stale = staleMembers(ctx.store, closure);
  if (stale.length) {
    fail('stale_dependency', 'inputs changed after review; render the current revisions and decide again', {
      details: { changed: stale },
    });
  }

  const bound = def.check(ctx, p, receipt) ?? {};

  let editDiffText: string | null = null;
  if (p.rationale_authorship === 'agent_drafted_unedited') {
    if (!p.agent_draft) fail('invalid_request', 'agent_drafted_unedited needs the agent draft');
    if (p.agent_draft.trim() !== p.rationale.trim()) fail('invalid_request', 'rationale differs from the agent draft; use agent_drafted_edited');
  } else if (p.rationale_authorship === 'agent_drafted_edited') {
    if (!p.agent_draft) fail('invalid_request', 'agent_drafted_edited needs the agent draft to record the edit diff');
    editDiffText = editDiff(p.agent_draft, p.rationale);
    if (!editDiffText) fail('invalid_request', 'rationale equals the agent draft; use agent_drafted_unedited');
  }

  const unreviewed = unreviewedStatements(ctx.store, closure);
  const acceptedSet = new Set((p.accepted_unreviewed ?? []).map(refKey));
  for (const a of p.accepted_unreviewed ?? []) {
    if (!unreviewed.some((u) => refKey(u) === refKey(a))) fail('invalid_request', `${refKey(a)} is not an unreviewed statement in the closure`);
  }
  const conditionalOn = unreviewed.filter((u) => !acceptedSet.has(refKey(u)));

  const decisionBody = {
    kind: p.decision_kind,
    actor: ctx.principal.principal,
    reviewed: p.reviewed,
    dependency_digest: dependencyDigest(closure),
    inbound_link_digest: bound.inbound_link_digest ?? null,
    evidence_watermark: bound.evidence_watermark ?? null,
    display_receipt: p.display_receipt,
    inputs: p.inputs ?? {},
    rationale: p.rationale,
    rationale_authorship: p.rationale_authorship,
    edit_diff: editDiffText,
    conditional_on: conditionalOn,
    accepted_unreviewed: p.accepted_unreviewed ?? [],
    supersedes: p.supersedes ?? null,
    decided_at: ctx.now,
  };
  const deps: AnyRef[] = [...p.reviewed, p.display_receipt];
  const decision = ctx.tx.create('human_decision', decisionBody, deps);
  const result = def.apply({ ctx, payload: p, decision, receipt });
  ctx.tx.event('human_decision', { kind: p.decision_kind, decision });
  return { decision, conditional_on: conditionalOn, ...result };
}

export function requireDecisionKind(kind: DecisionKind): DecisionKindDef {
  const def = kinds.get(kind);
  if (!def) throw new HarnessError('invalid_request', `decision kind ${kind} is not registered`);
  return def;
}

/** Fetch an input field and fail with invalid_request when missing. */
export function need<T>(inputs: Record<string, unknown>, key: string): T {
  const v = inputs?.[key];
  if (v === undefined || v === null || v === '') fail('invalid_request', `decision input "${key}" is required`);
  return v as T;
}
