import { fail } from '../core/errors.ts';
import { randomToken } from '../core/hash.ts';
import type { Ref } from '../core/refs.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import { defineDecisionKind, need, type DecisionPayload } from '../decision/framework.ts';
import { validate } from '../schema/jsonschema.ts';
import { RECORD_SCHEMAS, type LibraryEntryBody, type LibraryTransferBody, type RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { matches, type RetrievalQuery } from './lessons.ts';

// The mechanism library (DEC-009, Q-022; FR-42; design/harness-state-and-execution.md, "Mechanism
// library entry", "Library transfer", and the permissions row "Read or write the mechanism library").
//
// The library is its own record store (scope `library`). Only `record_transfer` decisions on the
// trusted screen write it; agents propose lessons (propose_lesson) but never write the library.
// Engagements read admitted entries through the context builder. Entry content comes only from the
// auditor's sanitized decision inputs, never copied from the lesson, and no structured field of an
// entry (body or envelope) names the source engagement: a transferred entry carries only an opaque
// transfer reference, while the transfer record stays in the source engagement.
//
// record_transfer inputs, by action:
//   admit (lesson; decided in its source engagement)
//     lesson, sanitized_text, counterconditions[], applicability{component_classes, standards,
//     compiler_versions}, confirmations{client_details_removed: true, reuse_permitted: true}
//   admit (public reference; decided in the library scope)
//     public_reference (citation), sanitized_text, counterconditions[], applicability
//   revise (library scope): entry, and any of sanitized_text, counterconditions[], applicability
//   retire (library scope): entry, reason
//
// Cross-store ordering for a lesson admission. The decision and the transfer record commit in the
// engagement store; the entry commits in the library store. The controller commits the engagement
// transaction after the decision handler returns, so the library commit happens first, inside the
// handler and under the workspace-wide controller lock, after every staged engagement record has been
// validated against its schema. If the engagement commit then fails (crash, Git failure), the library
// holds an entry whose opaque reference matches no transfer record. `reconcile_library` lists such
// orphans; the auditor retires each one with a `record_transfer` decision in the library scope. The
// reverse failure (decision committed, no entry) cannot occur, because the entry is committed first.

const ACTIONS = ['admit', 'revise', 'retire'] as const;

function applicabilityOf(v: unknown): LibraryEntryBody['applicability'] {
  const a = (v ?? {}) as Record<string, unknown>;
  const list = (k: string) => {
    const x = a[k] ?? [];
    if (!Array.isArray(x) || x.some((s) => typeof s !== 'string')) fail('invalid_request', `applicability.${k} must be a list of strings`);
    return x as string[];
  };
  if (!v || typeof v !== 'object') fail('invalid_request', 'applicability is required (the sanitized component classes, standards and compiler versions)');
  return { component_classes: list('component_classes'), standards: list('standards'), compiler_versions: list('compiler_versions') };
}

function counterconditionsOf(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s.trim())) {
    fail('invalid_request', 'counterconditions must be given explicitly as sanitized strings (an empty list is allowed)');
  }
  return v as string[];
}

function inReviewed(p: DecisionPayload, r: Ref, what: string): void {
  if (!p.reviewed.some((x) => x.record_id === r.record_id && x.revision === r.revision)) {
    fail('display_required', `the reviewed revisions must include the ${what}`);
  }
}

defineDecisionKind({
  kind: 'record_transfer',
  scope: 'either',
  check(ctx, p) {
    const inputs = p.inputs ?? {};
    const action = need<string>(inputs, 'action');
    if (!(ACTIONS as readonly string[]).includes(action)) fail('invalid_request', `action must be one of ${ACTIONS.join(', ')}`);
    const inLibrary = ctx.store.scope === 'library';
    if (action === 'admit') {
      need<string>(inputs, 'sanitized_text');
      counterconditionsOf(inputs.counterconditions);
      applicabilityOf(inputs.applicability);
      if (inputs.lesson) {
        if (inLibrary) fail('invalid_request', 'a lesson transfer is decided in its source engagement');
        const lessonRef = inputs.lesson as Ref;
        inReviewed(p, lessonRef, 'lesson revision');
        const lesson = ctx.store.get(lessonRef, 'lesson');
        if (lesson.body.review_status === 'quarantined') fail('permission_denied', 'a quarantined lesson (missing source anchors) cannot be transferred');
        const c = inputs.confirmations as { client_details_removed?: unknown; reuse_permitted?: unknown } | undefined;
        if (!c || c.client_details_removed !== true || c.reuse_permitted !== true) {
          fail('permission_denied', 'a lesson transfer needs the auditor to confirm both that client details are removed and that the client agreement allows reuse');
        }
      } else {
        need<string>(inputs, 'public_reference');
        if (!inLibrary) fail('invalid_request', 'a public reference is admitted in the library scope');
      }
      return;
    }
    if (!inLibrary) fail('invalid_request', `${action} of a library entry is decided in the library scope`);
    const entryRef = need<Ref>(inputs, 'entry');
    inReviewed(p, entryRef, 'library entry revision');
    const entry = ctx.store.get(entryRef, 'library_entry');
    if (entry.body.status !== 'admitted') fail('invalid_request', `entry ${entry.record_id} is ${entry.body.status}`);
    if (action === 'revise') {
      if (inputs.counterconditions !== undefined) counterconditionsOf(inputs.counterconditions);
      if (inputs.applicability !== undefined) applicabilityOf(inputs.applicability);
      if (inputs.sanitized_text === undefined && inputs.counterconditions === undefined && inputs.applicability === undefined) {
        fail('invalid_request', 'a revision changes the text, counterconditions or applicability');
      }
    } else need<string>(inputs, 'reason');
  },
  apply(d) {
    const { ctx } = d;
    const inputs = d.payload.inputs;
    const action = inputs.action as (typeof ACTIONS)[number];
    if (action === 'admit' && inputs.lesson) return admitLesson(ctx, d.decision, inputs);
    if (action === 'admit') {
      const entryBody: LibraryEntryBody = {
        mechanism: inputs.sanitized_text as string,
        counterconditions: counterconditionsOf(inputs.counterconditions),
        applicability: applicabilityOf(inputs.applicability),
        source: { kind: 'public_reference', citation: inputs.public_reference as string, admitting_decision: d.decision },
        status: 'admitted',
      };
      const entry = ctx.tx.create('library_entry', entryBody, [d.decision]);
      const transfer = ctx.tx.create(
        'library_transfer',
        {
          lesson: null,
          public_reference: inputs.public_reference as string,
          sanitized_text: inputs.sanitized_text as string,
          confirmations: null,
          decision: d.decision,
          opaque_ref: `xref-${randomToken(16)}`,
          entry: entry.record_id,
        },
        [d.decision],
      );
      return { entry, transfer };
    }
    const entryRef = inputs.entry as Ref;
    const entry = ctx.tx.revise(
      entryRef.record_id,
      'library_entry',
      (b) =>
        action === 'retire'
          ? { ...b, status: 'retired' }
          : {
              ...b,
              mechanism: (inputs.sanitized_text as string | undefined) ?? b.mechanism,
              counterconditions: inputs.counterconditions !== undefined ? counterconditionsOf(inputs.counterconditions) : b.counterconditions,
              applicability: inputs.applicability !== undefined ? applicabilityOf(inputs.applicability) : b.applicability,
            },
      { expectedRevision: entryRef.revision, depends_on: [d.decision] },
    );
    return { entry, action };
  },
});

function admitLesson(ctx: OpContext, decision: Ref, inputs: Record<string, unknown>): Record<string, unknown> {
  const lib = ctx.ws.store('library', true);
  if (lib.corruption) fail('store_corrupt', 'the library store is corrupt; writes refused');
  const entryId = lib.peekNextId('library_entry');
  const opaque = `xref-${randomToken(16)}`;
  const c = inputs.confirmations as { client_details_removed: boolean; reuse_permitted: boolean };
  const transferBody: LibraryTransferBody = {
    lesson: inputs.lesson as Ref,
    public_reference: null,
    sanitized_text: inputs.sanitized_text as string,
    confirmations: { client_details_removed: c.client_details_removed, reuse_permitted: c.reuse_permitted },
    decision,
    opaque_ref: opaque,
    entry: entryId,
  };
  const transfer = ctx.tx.create('library_transfer', transferBody, [inputs.lesson as Ref, decision]);
  // Validate everything the engagement commit will write before the library commit (ordering above).
  for (const r of ctx.tx.records) {
    const issues = validate(RECORD_SCHEMAS[r.type], r.body);
    if (issues.length) fail('invalid_request', `staged ${r.type} fails its schema`, { details: issues.slice(0, 10) });
  }
  const entryBody: LibraryEntryBody = {
    mechanism: inputs.sanitized_text as string,
    counterconditions: counterconditionsOf(inputs.counterconditions),
    applicability: applicabilityOf(inputs.applicability),
    source: { kind: 'transfer', transfer_ref: opaque },
    status: 'admitted',
  };
  // Envelope fields name no engagement: no decision ref, no dependency, a generic commit message.
  const res = lib.commit({
    records: [{ type: 'library_entry', base_revision: 0, body: entryBody, depends_on: [] }],
    events: [
      {
        kind: 'library_entry_admitted',
        operation: 'record_transfer',
        request_id: `xfer-${randomToken(8)}`,
        idempotency_key: null,
        request_digest: null,
        result: { entry: entryId, transfer_ref: opaque },
      },
    ],
    principal: { channel: 'screen', principal: ctx.principal.principal },
    origin: { operation: 'record_transfer', request_id: `xfer-${randomToken(8)}`, job: null, attempt: null, decision: null },
    now: ctx.now,
    message: `record_transfer admit ${entryId}`,
  });
  ctx.ws.noteCommitted('library');
  if (res.refs[0]?.record_id !== entryId) fail('execution_failed', 'library entry identity changed during commit');
  return { entry: { ...res.refs[0], scope: 'library' }, transfer };
}

// -----------------------------------------------------------------------------------------------
// Retrieval

export interface RetrievedMechanism {
  ref: Ref & { scope: 'library' };
  mechanism: string;
  /** Always retrieved with the mechanism they qualify. */
  counterconditions: string[];
  applicability: LibraryEntryBody['applicability'];
  source: { kind: 'public_reference'; citation: string } | { kind: 'transfer' };
  matched_on: string[];
  authority: 'none';
}

/** Admitted entries for a query (keyword retrieval). Entries guide lead generation only. */
export function retrieveMechanisms(library: RecordStore, q: RetrievalQuery): RetrievedMechanism[] {
  if (library.scope !== 'library') fail('invalid_request', 'retrieveMechanisms reads the library store');
  const out: RetrievedMechanism[] = [];
  for (const e of library.heads('library_entry') as RecordEnvelope<'library_entry'>[]) {
    if (e.body.status !== 'admitted') continue;
    const m = matches(q, e.body.applicability, `${e.body.mechanism}\n${e.body.counterconditions.join('\n')}`);
    if (!m.matched) continue;
    out.push({
      ref: { record_id: e.record_id, revision: e.revision, scope: 'library' },
      mechanism: e.body.mechanism,
      counterconditions: e.body.counterconditions,
      applicability: e.body.applicability,
      source: e.body.source.kind === 'public_reference' ? { kind: 'public_reference', citation: e.body.source.citation } : { kind: 'transfer' },
      matched_on: m.on,
      authority: 'none',
    });
  }
  return out.slice(0, q.limit ?? 50);
}

defineOperation<RetrievalQuery>({
  name: 'retrieve_mechanisms',
  channels: ['auditor', 'screen', 'controller'],
  mutating: false,
  scope: 'either',
  handler(ctx, q) {
    return { entries: retrieveMechanisms(ctx.ws.store('library', true), q ?? {}) };
  },
});

/**
 * Entries whose opaque transfer reference matches no transfer record in any engagement: the residue
 * of an engagement commit that failed after its library commit. Only entry refs are returned.
 */
defineOperation<Record<string, never>>({
  name: 'reconcile_library',
  channels: ['auditor', 'controller'],
  mutating: false,
  scope: 'library',
  handler(ctx) {
    const known = new Set<string>();
    for (const id of ctx.ws.engagementIds()) {
      for (const t of ctx.ws.store(id, true).heads('library_transfer')) known.add(t.body.opaque_ref);
    }
    const orphans = ctx.store
      .heads('library_entry')
      .filter((e) => e.body.status === 'admitted' && e.body.source.kind === 'transfer' && !known.has(e.body.source.transfer_ref))
      .map((e) => ({ record_id: e.record_id, revision: e.revision, scope: 'library' }));
    return { orphans, next: orphans.length ? 'retire each orphan with a record_transfer decision in the library scope' : null };
  },
});
