import { fail } from '../core/errors.ts';
import { isArtifactRef, refKey, type AnyRef, type Ref } from '../core/refs.ts';
import { deriveFixLabel, impactRank, type FixLabel, type PotentialImpact } from '../core/values.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { freshnessSummary } from '../snapshot/change.ts';
import type { HumanDecisionBody, RecordEnvelope, RecordType } from '../schema/records.ts';

// Derived state shared by the required set, report generation, closure and the context builder.
// Nothing here is stored: "unresolved" in particular is derived, never recorded (glossary).

export function refOf(env: { record_id: string; revision: number }): Ref {
  return { record_id: env.record_id, revision: env.revision };
}

export function engagementHead(store: RecordStore): RecordEnvelope<'engagement'> {
  const e = store.heads('engagement')[0];
  if (!e) fail('not_found', 'engagement record missing');
  return e;
}

/**
 * Freshness of each conclusion relative to the active snapshot, from the snapshot module's
 * `freshnessSummary` (src/snapshot/change.ts): only freshness records computed for the active
 * snapshot count; a conclusion without one is `current`.
 */
export function freshnessIndex(store: RecordStore): Map<string, RecordEnvelope<'conclusion_freshness'>> {
  const out = new Map<string, RecordEnvelope<'conclusion_freshness'>>();
  for (const i of freshnessSummary(store).items) out.set(i.conclusion.record_id, store.get(i.record, 'conclusion_freshness'));
  return out;
}

export function decisionBody(store: RecordStore, r: Ref | null | undefined): HumanDecisionBody | null {
  if (!r) return null;
  const env = store.tryGet<'human_decision'>(r);
  return env && env.type === 'human_decision' ? env.body : null;
}

/**
 * Disposition inputs for one claim (src/decision/kinds.ts, DisposeInputs): the top-level inputs for
 * the investigation question, `inputs.linked_claims[]` keyed by `id` for a linked claim. A linked
 * claim never inherits the parent's inputs.
 */
export function claimInputs(inputs: Record<string, unknown> | undefined, linkedClaimId: string | null): Record<string, unknown> {
  if (!inputs) return {};
  if (linkedClaimId === null) return inputs;
  const claims = Array.isArray(inputs.linked_claims) ? (inputs.linked_claims as Record<string, unknown>[]) : [];
  return claims.find((c) => c && typeof c === 'object' && c.id === linkedClaimId) ?? {};
}

/** Unreviewed statements a decision is conditional on (empty when unconditional or unknown). */
export function conditionalOn(store: RecordStore, r: Ref | null | undefined): Ref[] {
  return decisionBody(store, r)?.conditional_on ?? [];
}

export function fixLabelOf(store: RecordStore, finding: RecordEnvelope<'finding'>): FixLabel {
  const fa = finding.body.fix_assessments;
  if (fa.length) {
    const last = store.tryGet<'fix_assessment'>(fa[fa.length - 1]);
    if (last && last.type === 'fix_assessment') {
      const head = store.head<'fix_assessment'>(last.record_id) ?? last;
      return head.body.label;
    }
  }
  const responses = finding.body.client_responses;
  const lastResponse = responses.length ? responses[responses.length - 1].response : null;
  return deriveFixLabel(null, null, lastResponse, false);
}

export function atOrAbove(i: PotentialImpact, threshold: PotentialImpact): boolean {
  return impactRank(i) >= impactRank(threshold);
}

/** Record types that state a conclusion (used for "conclusions that depend on" a premise). */
export const CONCLUSION_TYPES: readonly RecordType[] = [
  'investigation',
  'finding',
  'behavioral_comparison',
  'behavioral_discrepancy',
  'property',
  'fix_assessment',
];

/**
 * Current conclusions that depend, directly or through other records' `depends_on`, on any revision
 * of `recordId`. Bounded breadth-first walk over current heads.
 */
export function dependentConclusions(store: RecordStore, recordId: string, maxDepth = 8): Ref[] {
  const reverse = reverseIndex(store);
  const out = new Map<string, Ref>();
  const seen = new Set<string>([recordId]);
  let frontier = [recordId];
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of reverse.get(id) ?? []) {
        if (seen.has(dep.record_id)) continue;
        seen.add(dep.record_id);
        next.push(dep.record_id);
        if (CONCLUSION_TYPES.includes(dep.type)) out.set(dep.record_id, refOf(dep));
      }
    }
    frontier = next;
  }
  return [...out.values()].sort((a, b) => a.record_id.localeCompare(b.record_id, 'en', { numeric: true }));
}

const reverseCache = new WeakMap<RecordStore, { seq: number; map: Map<string, RecordEnvelope[]> }>();

function reverseIndex(store: RecordStore): Map<string, RecordEnvelope[]> {
  const cached = reverseCache.get(store);
  if (cached && cached.seq === store.lastSeq()) return cached.map;
  const map = new Map<string, RecordEnvelope[]>();
  for (const h of store.heads()) {
    const targets = new Set<string>();
    for (const d of h.depends_on) if (!isArtifactRef(d) && !d.scope) targets.add(d.record_id);
    for (const t of targets) {
      const list = map.get(t) ?? [];
      list.push(h);
      map.set(t, list);
    }
  }
  reverseCache.set(store, { seq: store.lastSeq(), map });
  return map;
}

/** Artifact digests a record body references (evidence content, streams, outputs, fixtures). */
export function artifactsOf(env: RecordEnvelope): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.artifact === 'string' && /^sha256:[0-9a-f]{64}$/.test(o.artifact)) out.add(o.artifact);
      for (const x of Object.values(o)) walk(x);
    }
  };
  walk(env.body);
  for (const d of env.depends_on) if (isArtifactRef(d)) out.add(d.artifact);
  return [...out];
}

/** Material removed through `retention_action` decisions: artifact digests and record IDs. */
export function retainedAway(store: RecordStore): { artifacts: Map<string, Ref>; records: Map<string, Ref> } {
  const artifacts = new Map<string, Ref>();
  const records = new Map<string, Ref>();
  for (const d of store.heads('human_decision')) {
    if (d.body.kind !== 'retention_action') continue;
    const material = (d.body.inputs.material ?? []) as AnyRef[];
    for (const m of material) {
      if (isArtifactRef(m)) artifacts.set(m.artifact, refOf(d));
      else records.set(m.record_id, refOf(d));
    }
  }
  return { artifacts, records };
}

export function refSet(refs: Ref[]): Set<string> {
  return new Set(refs.map(refKey));
}
