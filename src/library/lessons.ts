import { fail } from '../core/errors.ts';
import { isArtifactRef, type AnyRef, type Ref } from '../core/refs.ts';
import { defineOperation } from '../controller/controller.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { LessonBody, RecordEnvelope } from '../schema/records.ts';

// Engagement-local lessons (design/harness-state-and-execution.md, "Shared knowledge and memory";
// FR-23; "Curator to memory interface" in design/harness-interface-contracts.md).
//
// A lesson is source-linked guidance with counterconditions, applicability and a review state. It
// stays in its engagement and has no approval authority: no memory can authorize a finding, and the
// context builder labels every lesson as guidance only. A lesson without resolvable source anchors in
// this engagement is quarantined from consequential use: it is stored, but never retrieved into an
// agent's context and never transferred. Moving a lesson to the mechanism library needs a
// `record_transfer` decision (src/library/library.ts).

export interface ProposeLessonPayload {
  statement: string;
  counterconditions: string[];
  applicability: { component_classes?: string[]; standards?: string[]; compiler_versions?: string[] };
  /** Records or artifacts of this engagement the lesson rests on. */
  sources: AnyRef[];
}

const strings = (v: unknown, field: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) fail('invalid_request', `${field} must be a list of non-empty strings`);
  return v as string[];
};

defineOperation<ProposeLessonPayload>({
  name: 'propose_lesson',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    if (!p?.statement?.trim()) fail('invalid_request', 'statement is required');
    const counterconditions = strings(p.counterconditions, 'counterconditions');
    const applicability = {
      component_classes: strings(p.applicability?.component_classes, 'applicability.component_classes'),
      standards: strings(p.applicability?.standards, 'applicability.standards'),
      compiler_versions: strings(p.applicability?.compiler_versions, 'applicability.compiler_versions'),
    };
    const sources = Array.isArray(p.sources) ? p.sources : [];
    const unresolved: AnyRef[] = [];
    for (const s of sources) {
      if (!s || typeof s !== 'object') fail('invalid_request', 'sources must be record or artifact references');
      if (isArtifactRef(s)) {
        if (!ctx.archive.has(s.artifact)) unresolved.push(s);
      } else {
        if (s.scope && s.scope !== ctx.store.scope) fail('permission_denied', 'a lesson cannot cite another engagement');
        if (!ctx.store.tryGet(s)) unresolved.push(s);
      }
    }
    const anchored = sources.length > 0 && unresolved.length === 0;
    const body: LessonBody = {
      statement: p.statement,
      counterconditions,
      applicability,
      sources,
      review_status: anchored ? 'provisional' : 'quarantined',
    };
    const deps = sources.filter((s) => isArtifactRef(s) || ctx.store.tryGet(s as Ref));
    const lesson = ctx.tx.create('lesson', body, deps);
    return {
      lesson,
      review_status: body.review_status,
      ...(anchored ? {} : { quarantine_reason: sources.length ? 'unresolvable source anchors' : 'no source anchors', unresolved }),
    };
  },
});

export interface RetrievalQuery {
  component_classes?: string[];
  standards?: string[];
  keywords?: string[];
  limit?: number;
}

const norm = (xs: string[] | undefined) => (xs ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** Keyword match over applicability and text; an empty query matches everything. */
export function matches(
  q: RetrievalQuery,
  applicability: { component_classes: string[]; standards: string[] },
  text: string,
): { matched: boolean; on: string[] } {
  const cc = norm(q.component_classes);
  const st = norm(q.standards);
  const kw = norm(q.keywords);
  if (!cc.length && !st.length && !kw.length) return { matched: true, on: ['all'] };
  const on: string[] = [];
  const acc = norm(applicability.component_classes);
  const ast = norm(applicability.standards);
  for (const c of cc) if (acc.includes(c)) on.push(`component_class:${c}`);
  for (const s of st) if (ast.includes(s)) on.push(`standard:${s}`);
  const t = text.toLowerCase();
  for (const k of kw) if (t.includes(k)) on.push(`keyword:${k}`);
  return { matched: on.length > 0, on };
}

export interface RetrievedLesson {
  ref: Ref;
  statement: string;
  counterconditions: string[];
  applicability: LessonBody['applicability'];
  review_status: LessonBody['review_status'];
  sources: AnyRef[];
  matched_on: string[];
  authority: 'none';
}

/** Engagement lessons for a query. Quarantined lessons are never retrieved. */
export function retrieveLessons(store: RecordStore, q: RetrievalQuery): RetrievedLesson[] {
  const out: RetrievedLesson[] = [];
  for (const l of store.heads('lesson') as RecordEnvelope<'lesson'>[]) {
    if (l.body.review_status === 'quarantined') continue;
    const m = matches(q, l.body.applicability, `${l.body.statement}\n${l.body.counterconditions.join('\n')}`);
    if (!m.matched) continue;
    out.push({
      ref: { record_id: l.record_id, revision: l.revision },
      statement: l.body.statement,
      counterconditions: l.body.counterconditions,
      applicability: l.body.applicability,
      review_status: l.body.review_status,
      sources: l.body.sources,
      matched_on: m.on,
      authority: 'none',
    });
  }
  return out.slice(0, q.limit ?? 50);
}
