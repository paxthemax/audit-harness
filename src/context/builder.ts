import { roleProfile } from '../controller/roles.ts';
import { fail } from '../core/errors.ts';
import { isArtifactRef, refKey, type AnyRef, type ArtifactRef, type Ref } from '../core/refs.ts';
import { defineOperation } from '../controller/controller.ts';
import type { Archive } from '../store/archive.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { RecordEnvelope, RecordType } from '../schema/records.ts';
import { retrieveLessons, type RetrievedLesson } from '../library/lessons.ts';
import { retrieveMechanisms, type RetrievedMechanism } from '../library/library.ts';
import { linkedEvidence } from '../decision/packets.ts';
import { engagementHead, freshnessIndex, refOf } from '../report/derive.ts';
import { stripSolidityComments } from './solidity.ts';

// Context builder (design/harness-state-and-execution.md, "Shared knowledge and memory", surface 3
// "Working context"; design/harness-interface-contracts.md, "Controller to agent" and "Context
// builder to provider broker"; FR-24, NFR-11).
//
// Builds a bounded, versioned context manifest for one agent role and stores it in the archive. The
// manifest names the exact record revisions included (with their bodies), what was retrieved from
// engagement lessons and the mechanism library and why, contradictions and unknowns together with the
// claims they qualify, prior outputs intentionally withheld and why, and each record's disputed and
// freshness status so that it survives summarization. Retrieval reads only this engagement's store
// and the library's admitted entries: a reference qualified with another engagement is refused.
//
// For a challenger, the initial context excludes the author's rationale (review packets and author
// positions) and provisional statements on the challenged path; a comment-blind pass replaces cited
// source files with views stripped of comments and NatSpec. Lessons and library entries carry no
// authority: they guide investigation and cannot authorize a finding.

export const CONTEXT_FORMAT = 'harness.context/1';
export const CONTEXT_ROLES = ['investigator', 'challenger', 'property_agent', 'synthesis', 'curator', 'comprehension', 'planner'] as const;
export type ContextRole = (typeof CONTEXT_ROLES)[number];

/** Proposed default bounds (numeric limits are operator choices, not decided). */
export const DEFAULT_CONTEXT_LIMITS = { max_records: 200, max_retrieved: 20, max_source_bytes: 2 * 1024 * 1024 };

export interface ContextSpec {
  role: ContextRole;
  /** The investigation the agent works on (for a challenger: the challenged investigation). */
  investigation?: Ref | null;
  /** Further exact revisions of this engagement to include. */
  include?: Ref[];
  component_classes?: string[];
  standards?: string[];
  keywords?: string[];
  /** Strip comments and NatSpec from included source files. */
  comment_blind?: boolean;
  /** Snapshot paths to include in addition to the investigation's anchors. */
  source_paths?: string[];
  /** Prior outputs to withhold deliberately, with the reason. */
  withhold?: { ref: AnyRef; reason: string }[];
  limits?: Partial<typeof DEFAULT_CONTEXT_LIMITS>;
}

export interface ContextRecord {
  ref: Ref;
  type: RecordType;
  status: {
    review_status: string | null;
    disposition: string | null;
    freshness: string | null;
    disputed: boolean;
    provisional: boolean;
  };
  body: unknown;
}

export interface ContextManifest {
  format: typeof CONTEXT_FORMAT;
  engagement: string;
  role: ContextRole;
  built_at: string;
  investigation: Ref | null;
  snapshot: Ref | null;
  records: ContextRecord[];
  contradictions: { claim: Ref; qualified_by: AnyRef; relation: 'contradicting' | 'refuting' }[];
  unknowns: { ref: Ref; statement: string; qualifies: Ref[] }[];
  retrieved: { query: { component_classes: string[]; standards: string[]; keywords: string[] }; lessons: RetrievedLesson[]; library: RetrievedMechanism[] };
  sources: { path: string; original: string; view: string; comment_blind: boolean }[];
  missing_sources: { path: string; reason: string }[];
  withheld: { ref: AnyRef; reason: string }[];
  status_notes: string[];
  truncated: Ref[];
  limits: typeof DEFAULT_CONTEXT_LIMITS;
  authority_note: string;
}

export interface BuiltContext {
  ref: ArtifactRef;
  manifest: ContextManifest;
  /** Archive blobs written (manifest and stripped source views). */
  blobs: string[];
}

function ownRef(store: RecordStore, r: Ref): Ref {
  if (!r || typeof r.record_id !== 'string' || !Number.isInteger(r.revision)) fail('invalid_request', 'context references must be exact revisions');
  if (r.scope && r.scope !== store.scope) fail('permission_denied', 'context retrieval never reaches another engagement');
  store.get(r);
  return { record_id: r.record_id, revision: r.revision };
}

export function buildContext(store: RecordStore, library: RecordStore | null, archive: Archive, spec: ContextSpec, now = new Date().toISOString()): BuiltContext {
  if (!spec || !(CONTEXT_ROLES as readonly string[]).includes(spec.role)) fail('invalid_request', `role must be one of ${CONTEXT_ROLES.join(', ')}`);
  if (store.scope === 'library') fail('invalid_request', 'context is built for an engagement');
  const limits = { ...DEFAULT_CONTEXT_LIMITS, ...(spec.limits ?? {}) };
  const eng = engagementHead(store);
  const fresh = freshnessIndex(store);
  const challenger = spec.role === 'challenger';

  const wanted = new Map<string, Ref>(); // record_id -> exact revision; order = priority
  const withheld = new Map<string, { ref: AnyRef; reason: string }>();
  const want = (r: Ref) => {
    if (!wanted.has(r.record_id)) wanted.set(r.record_id, r);
  };
  const withhold = (r: AnyRef, reason: string) => withheld.set(isArtifactRef(r) ? r.artifact : r.record_id, { ref: r, reason });

  for (const w of spec.withhold ?? []) {
    if (!w?.ref || !w.reason) fail('invalid_request', 'withheld items need a ref and a reason');
    if (!isArtifactRef(w.ref)) ownRef(store, w.ref);
    withhold(w.ref, w.reason);
  }

  // --- The investigation and its path ----------------------------------------------------------
  let inv: RecordEnvelope<'investigation'> | null = null;
  const pathUnits = new Set<string>();
  const pathFiles = new Set<string>();
  if (spec.investigation) {
    inv = store.get(ownRef(store, spec.investigation), 'investigation');
    want(refOf(inv));
    for (const u of inv.body.audit_units) {
      pathUnits.add(u.record_id);
      const h = store.head(u.record_id);
      if (h) want(refOf(h));
    }
    for (const a of inv.body.anchors) pathFiles.add(a.path);
    for (const v of inv.body.variants) want(store.headRef(v.record_id));
    // What the trusted runner observed for its experiments, replays and controls (not the agent rounds' own
    // receipts): an agent continuing the investigation, or challenging it, reads the results it builds on.
    for (const e of linkedEvidence(store, inv.record_id)) {
      const job = e.body.job ? store.tryGet<'job'>(e.body.job) : undefined;
      if (job?.body.purpose !== 'agent') want(refOf(e));
    }
    for (const r of [...inv.body.supporting, ...inv.body.refuting]) if (!isArtifactRef(r) && !r.scope && store.tryGet(r)) want(r);
    for (const pr of store.heads('property')) if (pr.body.investigation?.record_id === inv.record_id) want(refOf(pr));
    // Statements on the path: same audit units or same cited files.
    for (const s of store.heads('system_statement')) {
      const onPath = s.body.audit_units.some((u) => pathUnits.has(u.record_id)) || s.body.anchors.some((a) => pathFiles.has(a.path));
      if (!onPath || s.body.review_status === 'rejected' || s.body.review_status === 'superseded') continue;
      if (challenger && s.body.review_status === 'provisional') {
        withhold(refOf(s), 'provisional (unreviewed) statement on the challenged path');
        continue;
      }
      want(refOf(s));
    }
    if (challenger) {
      for (const pk of store.heads('review_packet')) {
        if (pk.body.investigation.record_id !== inv.record_id) continue;
        withhold(refOf(pk), "author's packet: proposed disposition and rationale withheld from the challenger");
        if (pk.body.author_position) withhold(pk.body.author_position, "author's position withheld from the challenger");
      }
    }
  }
  for (const r of spec.include ?? []) {
    const own = ownRef(store, r);
    const env = store.get(own);
    if (challenger && env.type === 'system_statement' && (env as RecordEnvelope<'system_statement'>).body.review_status === 'provisional') {
      const s = env as RecordEnvelope<'system_statement'>;
      if (s.body.audit_units.some((u) => pathUnits.has(u.record_id)) || s.body.anchors.some((a) => pathFiles.has(a.path))) {
        withhold(own, 'requested, but withheld: provisional statement on the challenged path');
        continue;
      }
    }
    if (challenger && env.type === 'review_packet' && inv && (env as RecordEnvelope<'review_packet'>).body.investigation.record_id === inv.record_id) {
      withhold(own, "requested, but withheld: author's packet");
      continue;
    }
    want(own);
  }

  // --- Contradictions and unknowns with the claims they qualify -----------------------------------
  const contradictions: ContextManifest['contradictions'] = [];
  const unknowns: ContextManifest['unknowns'] = [];
  for (const r of [...wanted.values()]) {
    const env = store.get(r);
    const qualify = (refs: AnyRef[], relation: 'contradicting' | 'refuting') => {
      for (const q of refs) {
        if (!isArtifactRef(q) && q.scope && q.scope !== store.scope) continue;
        contradictions.push({ claim: r, qualified_by: q, relation });
        if (!isArtifactRef(q) && store.tryGet(q) && !withheld.has(q.record_id)) want(q);
      }
    };
    if (env.type === 'system_statement') qualify((env as RecordEnvelope<'system_statement'>).body.contradicting, 'contradicting');
    if (env.type === 'investigation') qualify((env as RecordEnvelope<'investigation'>).body.refuting, 'refuting');
  }
  for (const s of store.heads('system_statement')) {
    if (s.body.kind !== 'unknown' || s.body.review_status === 'rejected' || s.body.review_status === 'superseded') continue;
    const qualifies = [...wanted.values()].filter((r) => {
      const env = store.get(r);
      const units = env.type === 'system_statement' ? (env as RecordEnvelope<'system_statement'>).body.audit_units : env.type === 'investigation' ? (env as RecordEnvelope<'investigation'>).body.audit_units : [];
      return r.record_id !== s.record_id && units.some((u) => s.body.audit_units.some((x) => x.record_id === u.record_id));
    });
    if (!qualifies.length && !wanted.has(s.record_id)) continue;
    if (withheld.has(s.record_id)) continue;
    unknowns.push({ ref: refOf(s), statement: s.body.statement, qualifies });
    want(refOf(s));
  }

  // --- Bound and render records with their status ----------------------------------------------
  const all = [...wanted.values()].filter((r) => !withheld.has(r.record_id));
  const kept = all.slice(0, limits.max_records);
  const truncated = all.slice(limits.max_records);
  const statusNotes: string[] = [];
  const records: ContextRecord[] = kept.map((r) => {
    const env = store.get(r);
    const b = env.body as unknown as Record<string, unknown>;
    const review = typeof b.review_status === 'string' ? (b.review_status as string) : null;
    const disp = (b.disposition as { value?: string } | null | undefined)?.value ?? null;
    const claimsDisputed = Array.isArray(b.linked_claims) && (b.linked_claims as { disposition: { value: string } | null }[]).some((c) => c.disposition?.value === 'disputed');
    const freshness = fresh.get(r.record_id)?.body.value ?? null;
    const head = store.head(r.record_id)!;
    if (head.revision !== r.revision) statusNotes.push(`${refKey(r)} is not the current revision (current ${head.revision})`);
    if (freshness === 'affected' || freshness === 'possibly_affected') statusNotes.push(`${refKey(r)} is ${freshness} relative to the active snapshot`);
    if (freshness === 'carried_forward_mechanical') statusNotes.push(`${refKey(r)} was carried forward mechanically (not human review)`);
    if (disp === 'disputed' || claimsDisputed) statusNotes.push(`${refKey(r)} is disputed`);
    if (review === 'provisional') statusNotes.push(`${refKey(r)} is provisional (not reviewed by a human)`);
    return {
      ref: r,
      type: env.type,
      status: { review_status: review, disposition: disp, freshness, disputed: disp === 'disputed' || claimsDisputed, provisional: review === 'provisional' },
      body: env.body,
    };
  });

  // --- Retrieval: engagement lessons and admitted library entries ---------------------------------
  const query = { component_classes: spec.component_classes ?? [], standards: spec.standards ?? [], keywords: spec.keywords ?? [] };
  const anyQuery = query.component_classes.length + query.standards.length + query.keywords.length > 0;
  const lessons = anyQuery ? retrieveLessons(store, { ...query, limit: limits.max_retrieved }) : [];
  const mechanisms = anyQuery && library ? retrieveMechanisms(library, { ...query, limit: limits.max_retrieved }) : [];

  // --- Source files from the active snapshot -------------------------------------------------------
  const blobs: string[] = [];
  const sources: ContextManifest['sources'] = [];
  const missing: ContextManifest['missing_sources'] = [];
  const paths = [...new Set([...pathFiles, ...(spec.source_paths ?? [])])];
  // The engagement names the active snapshot by identity; its build revises it, so use the head.
  const snapRef = eng.body.active_snapshot ? store.headRef(eng.body.active_snapshot.record_id) : null;
  if (paths.length) {
    const snap = snapRef ? store.tryGet<'target_snapshot'>(snapRef) : undefined;
    const tree = snap ? archive.getTree(snap.body.tree.artifact) : null;
    let bytes = 0;
    for (const path of paths) {
      const d = tree?.files[path];
      if (!d) {
        missing.push({ path, reason: tree ? 'not in the active snapshot' : 'no active snapshot' });
        continue;
      }
      const text = archive.getText(d);
      bytes += text.length;
      if (bytes > limits.max_source_bytes) {
        missing.push({ path, reason: 'source byte limit reached' });
        continue;
      }
      if (spec.comment_blind) {
        const view = archive.put(stripSolidityComments(text));
        blobs.push(view.artifact);
        sources.push({ path, original: d, view: view.artifact, comment_blind: true });
      } else sources.push({ path, original: d, view: d, comment_blind: false });
    }
  }

  const manifest: ContextManifest = {
    format: CONTEXT_FORMAT,
    engagement: store.scope,
    role: spec.role,
    built_at: now,
    investigation: inv ? refOf(inv) : null,
    snapshot: snapRef,
    records,
    contradictions,
    unknowns,
    retrieved: { query, lessons, library: mechanisms },
    sources,
    missing_sources: missing,
    withheld: [...withheld.values()],
    status_notes: statusNotes,
    truncated,
    limits,
    authority_note: 'Lessons and library entries are guidance only; they carry no approval authority and cannot authorize a finding.',
  };
  const ref = archive.putJson(manifest);
  blobs.push(ref.artifact);
  return { ref, manifest, blobs };
}

defineOperation<ContextSpec>({
  name: 'build_context',
  channels: ['controller', 'auditor', 'worker'],
  mutating: true,
  handler(ctx, spec) {
    if (ctx.principal.channel === 'worker') {
      const g = ctx.principal.grant!;
      if (spec?.role !== roleProfile(g.role).contextRole) fail('permission_denied', `the worker grant is for role ${g.role}`);
      if (g.investigation && spec.investigation?.record_id !== g.investigation.record_id) {
        fail('permission_denied', 'a worker builds context only for its granted investigation');
      }
    }
    const built = buildContext(ctx.store, ctx.ws.store('library', true), ctx.archive, spec, ctx.now);
    for (const b of built.blobs) ctx.tx.blob(b);
    ctx.tx.event('context_built', { role: spec.role, context_manifest: built.ref.artifact });
    return {
      context_manifest: built.ref,
      records: built.manifest.records.length,
      withheld: built.manifest.withheld.length,
      retrieved: built.manifest.retrieved.lessons.length + built.manifest.retrieved.library.length,
      truncated: built.manifest.truncated.length,
    };
  },
});
