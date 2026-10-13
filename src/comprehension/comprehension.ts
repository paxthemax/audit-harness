import { fail } from '../core/errors.ts';
import { refKey, type AnyRef, type Ref } from '../core/refs.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import type { Anchor, KbDiagramBody, RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { defaultProofStatus, impactField, proposerOrigin, requireAgentAuthored, textOrNull } from '../decision/common.ts';
import { impactRank } from '../core/values.ts';
import { authorizationIsCurrent } from '../decision/work.ts';

// Comprehension lenses and coverage records (DEC-005; design/harness-comprehension-method.md):
// KB diagrams bound to the statements they depict (FR-30), repeatable and resumable explorations with
// optional checkpoints (FR-31), accounting views (FR-37), the baseline control checklist (FR-28) and
// duplicate / root-cause grouping that never loses an origin (FR-14). All are agent or auditor
// proposals; none grants review status.

function list<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

// -----------------------------------------------------------------------------------------------
// KB diagrams (FR-30)

/** `affected` when any depicted statement has a newer revision than the diagram binds. */
export function diagramStatus(store: RecordStore, id: string): { status: 'current' | 'affected'; changed: Ref[] } {
  const d = store.mustHead(id, 'kb_diagram');
  const changed = d.body.statements.filter((r) => (store.head(r.record_id)?.revision ?? r.revision) !== r.revision);
  return { status: changed.length ? 'affected' : 'current', changed };
}

function semanticDelta(prev: Ref[], next: Ref[]): KbDiagramBody['semantic_delta'] {
  const p = new Map(prev.map((r) => [r.record_id, r.revision]));
  const n = new Map(next.map((r) => [r.record_id, r.revision]));
  return {
    added: [...n.keys()].filter((k) => !p.has(k)),
    removed: [...p.keys()].filter((k) => !n.has(k)),
    changed: [...n.entries()].filter(([k, v]) => p.has(k) && p.get(k) !== v).map(([k, v]) => `${k}@${p.get(k)}→${v}`),
  };
}

export interface DiagramPayload {
  base?: Ref | null;
  audit_unit: Ref;
  lens: string;
  affiliation: 'designed' | 'implemented' | 'comparison';
  source: string;
  statements: Ref[];
}

defineOperation<DiagramPayload>({
  name: 'propose_kb_diagram',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    ctx.store.get(p.audit_unit, 'audit_unit');
    const statements = list<Ref>(p.statements);
    for (const r of statements) ctx.store.get(r, 'system_statement');
    if (!textOrNull(p.source)) fail('invalid_request', 'diagram source is required');
    const source = ctx.archive.put(p.source);
    ctx.tx.blob(source);
    if (p.base) {
      requireAgentAuthored(ctx, p.base.record_id);
      const cur = ctx.store.mustHead(p.base.record_id, 'kb_diagram');
      if (cur.revision !== p.base.revision) fail('revision_conflict', `diagram is at revision ${cur.revision}`);
      // Regeneration shows the semantic delta and grants no re-review.
      const ref = ctx.tx.revise(
        cur.record_id,
        'kb_diagram',
        (b) => ({ ...b, source, statements, lens: p.lens ?? b.lens, semantic_delta: semanticDelta(b.statements, statements), review_status: 'provisional' }),
        { depends_on: statements },
      );
      return { diagram: ref, semantic_delta: semanticDelta(cur.body.statements, statements) };
    }
    const ref = ctx.tx.create(
      'kb_diagram',
      { audit_unit: p.audit_unit, lens: p.lens, affiliation: p.affiliation, format: 'mermaid', source, statements, semantic_delta: null, review_status: 'provisional' },
      statements,
    );
    return { diagram: ref };
  },
});

defineOperation<{ diagram: string }>({
  name: 'diagram_status',
  channels: ['auditor', 'screen', 'worker'],
  mutating: false,
  handler(ctx, p) {
    return diagramStatus(ctx.store, p.diagram);
  },
});

// -----------------------------------------------------------------------------------------------
// Explorations (FR-31): connected walkthroughs, repeatable and resumable from any stage.

function exploration(store: RecordStore, id: string): RecordEnvelope<'exploration'> {
  return store.mustHead(id, 'exploration');
}

/** Records about the explored units that changed or appeared since the last round. */
export function explorationChanges(store: RecordStore, id: string): { changed: { ref: Ref; current: number }[]; added: Ref[] } {
  const ex = exploration(store, id);
  const last = ex.body.rounds.at(-1);
  if (!last) return { changed: [], added: [] };
  const changed = last.seen
    .map((r) => ({ ref: r, current: store.head(r.record_id)?.revision ?? r.revision }))
    .filter((x) => x.current !== x.ref.revision);
  const seen = new Set(last.seen.map((r) => r.record_id));
  const units = new Set(ex.body.audit_units.map((u) => u.record_id));
  const since = Date.parse(last.ended_at ?? last.started_at);
  const added: Ref[] = [];
  for (const env of store.heads()) {
    if (seen.has(env.record_id) || Date.parse(env.created_at) <= since) continue;
    const b = env.body as unknown as { audit_units?: Ref[]; audit_unit?: Ref };
    const touches = (b.audit_units ?? []).some((u) => units.has(u.record_id)) || (b.audit_unit && units.has(b.audit_unit.record_id));
    if (touches) added.push({ record_id: env.record_id, revision: env.revision });
  }
  return { changed, added };
}

defineOperation<{ audit_units: Ref[]; lens: 'purpose' | 'flows' | 'stores' | 'transitions'; authorization: Ref }>({
  name: 'start_exploration',
  channels: ['auditor', 'screen'],
  mutating: true,
  handler(ctx, p) {
    const auth = ctx.store.get(p.authorization, 'work_authorization');
    if (auth.body.kind !== 'exploration' || !authorizationIsCurrent(auth.body, ctx.now)) {
      fail('permission_denied', 'an exploration runs under a current `exploration` work authorization');
    }
    const units = list<Ref>(p.audit_units);
    if (!units.length) fail('invalid_request', 'name the audit units to explore');
    for (const u of units) {
      if (!auth.body.reviewed.some((r) => r.record_id === u.record_id)) fail('permission_denied', `${u.record_id} is outside the exploration authorization`);
    }
    const ref = ctx.tx.create('exploration', {
      audit_units: units,
      lens: p.lens,
      authorization: p.authorization,
      mode: 'connected_walkthrough',
      rounds: [{ started_at: ctx.now, ended_at: null, seen: [] }],
      checkpoints: [],
      status: 'active',
    });
    return { exploration: ref };
  },
});

defineOperation<{ exploration: string; seen: Ref[]; end?: boolean; checkpoints?: { id: string; prompt: string }[] }>({
  name: 'record_exploration_round',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    const ex = exploration(ctx.store, p.exploration);
    if (ex.body.status !== 'active') fail('invalid_request', `exploration is ${ex.body.status}`);
    for (const r of list<Ref>(p.seen)) ctx.store.get(r);
    const ref = ctx.tx.revise(ex.record_id, 'exploration', (b) => {
      const rounds = [...b.rounds];
      const last = rounds[rounds.length - 1];
      const seen = new Map([...last.seen, ...list<Ref>(p.seen)].map((r) => [r.record_id, r]));
      rounds[rounds.length - 1] = { ...last, seen: [...seen.values()], ended_at: p.end ? ctx.now : last.ended_at };
      const checkpoints = [
        ...b.checkpoints,
        ...list<{ id: string; prompt: string }>(p.checkpoints).map((c) => ({ id: c.id, prompt: c.prompt, status: 'offered' as const, captured_input: null })),
      ];
      return { ...b, rounds, checkpoints, status: p.end ? 'paused' : b.status };
    });
    return { exploration: ref };
  },
});

defineOperation<{ exploration: string; checkpoint: string; action: 'skip' | 'answer'; captured_input?: Ref }>({
  name: 'exploration_checkpoint',
  channels: ['auditor'],
  mutating: true,
  handler(ctx, p) {
    const ex = exploration(ctx.store, p.exploration);
    const cp = ex.body.checkpoints.find((c) => c.id === p.checkpoint);
    if (!cp || cp.status !== 'offered') fail('invalid_request', 'no offered checkpoint with that id');
    if (p.action === 'answer') {
      if (!p.captured_input) fail('invalid_request', 'an answered checkpoint links the captured answer');
      ctx.store.get(p.captured_input, 'captured_input');
    }
    // A skipped checkpoint records neither mastery nor failure: only that it was skipped.
    const ref = ctx.tx.revise(ex.record_id, 'exploration', (b) => ({
      ...b,
      checkpoints: b.checkpoints.map((c) =>
        c.id === p.checkpoint ? { ...c, status: p.action === 'skip' ? 'skipped' : 'answered', captured_input: p.captured_input ?? null } : c,
      ),
    }));
    return { exploration: ref };
  },
});

/** Resume: show what changed since the last round before continuing, then open a new round. */
defineOperation<{ exploration: string }>({
  name: 'resume_exploration',
  channels: ['auditor', 'screen'],
  mutating: true,
  handler(ctx, p) {
    const ex = exploration(ctx.store, p.exploration);
    if (ex.body.status === 'completed') fail('invalid_request', 'exploration is completed');
    const auth = ctx.store.get(ex.body.authorization, 'work_authorization');
    if (!authorizationIsCurrent(auth.body, ctx.now)) fail('grant_expired', 'the exploration authorization is no longer current');
    const changes = explorationChanges(ctx.store, ex.record_id);
    const ref = ctx.tx.revise(ex.record_id, 'exploration', (b) => ({
      ...b,
      status: 'active',
      rounds: [...b.rounds.map((r, i) => (i === b.rounds.length - 1 && !r.ended_at ? { ...r, ended_at: ctx.now } : r)), { started_at: ctx.now, ended_at: null, seen: [] }],
    }));
    return { exploration: ref, changes };
  },
});

// -----------------------------------------------------------------------------------------------
// Accounting views (FR-37) and baseline controls (FR-28)

defineOperation<{ base?: Ref | null; audit_unit: Ref; conservation?: { relation: string; anchors: Anchor[] }[]; units?: { store: string; unit: string; decimals: number | null }[]; rounding?: { operation: string; anchor: Anchor | null; direction: 'up' | 'down' | 'nearest' | 'unknown'; beneficiary: string }[] }>({
  name: 'propose_accounting_view',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    ctx.store.get(p.audit_unit, 'audit_unit');
    const body = {
      audit_unit: p.audit_unit,
      conservation: list<{ relation: string; anchors: Anchor[] }>(p.conservation),
      units: list<{ store: string; unit: string; decimals: number | null }>(p.units),
      rounding: list<{ operation: string; anchor: Anchor | null; direction: 'up' | 'down' | 'nearest' | 'unknown'; beneficiary: string }>(p.rounding),
      review_status: 'provisional' as const,
    };
    for (const r of body.rounding) if (!textOrNull(r.beneficiary)) fail('invalid_request', `rounding of "${r.operation}" must name who benefits`);
    if (p.base) requireAgentAuthored(ctx, p.base.record_id);
    const ref = p.base
      ? ctx.tx.revise(p.base.record_id, 'accounting_view', () => body, { expectedRevision: p.base.revision })
      : ctx.tx.create('accounting_view', body);
    return { accounting_view: ref };
  },
});

defineOperation<{ base?: Ref | null; control_id: string; title: string; source: string; applicability: 'applicable' | 'not_applicable' | 'unknown'; applicability_reason?: string | null; evidence?: AnyRef[]; exclusions?: string[]; gaps?: string[] }>({
  name: 'propose_control_item',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    if (p.applicability === 'not_applicable' && !textOrNull(p.applicability_reason)) fail('invalid_request', 'not_applicable needs a reason');
    if (p.base) requireAgentAuthored(ctx, p.base.record_id);
    const body = {
      control_id: String(p.control_id),
      title: String(p.title),
      source: String(p.source),
      applicability: p.applicability,
      applicability_reason: textOrNull(p.applicability_reason),
      evidence: list<AnyRef>(p.evidence),
      exclusions: list<string>(p.exclusions),
      gaps: list<string>(p.gaps),
    };
    const ref = p.base
      ? ctx.tx.revise(p.base.record_id, 'control_item', () => body, { expectedRevision: p.base.revision })
      : ctx.tx.create('control_item', body);
    return { control_item: ref, status: controlStatus(body) };
  },
});

/** A relevant control with no examined evidence is an open gap, however many files were visited. */
export function controlStatus(b: { applicability: string; evidence: AnyRef[] }): 'open_gap' | 'evidence_recorded' | 'not_applicable' | 'applicability_unknown' {
  if (b.applicability === 'not_applicable') return 'not_applicable';
  if (b.applicability === 'unknown') return 'applicability_unknown';
  return b.evidence.length ? 'evidence_recorded' : 'open_gap';
}

// -----------------------------------------------------------------------------------------------
// Duplicate and root-cause grouping (FR-14): origins and dissent survive; a chain is its own claim.

defineOperation<{ relation: 'duplicate' | 'shared_cause' | 'chain'; members: Ref[]; proposed_cause: string; dissent?: string[]; chain_question?: string }>({
  name: 'propose_lead_group',
  channels: ['auditor', 'worker'],
  mutating: true,
  handler(ctx, p) {
    const members = list<Ref>(p.members);
    if (members.length < 2) fail('invalid_request', 'a group needs at least two leads');
    const invs = members.map((m) => ctx.store.get(m, 'investigation'));
    let chain: Ref | null = null;
    if (p.relation === 'chain') {
      // A proposed bug chain remains a separate investigable claim.
      const q = textOrNull(p.chain_question);
      if (!q) fail('invalid_request', 'a chain names its own investigation question');
      const units = new Map<string, Ref>();
      for (const i of invs) for (const u of i.body.audit_units) units.set(u.record_id, ctx.store.headRef(u.record_id));
      // A new, unreviewed claim: nothing about evidence quality or impact carries over from members
      // except the highest estimate, which keeps the evidence bar from dropping.
      const highest = invs.map((i) => i.body.potential_impact.effective).sort((a, b) => impactRank(b) - impactRank(a))[0];
      chain = ctx.tx.create('investigation', {
        ...invs[0].body,
        potential_impact: proposerOrigin(ctx) === 'agent' ? impactField(highest, null, null) : impactField(null, highest, null),
        proof_status: defaultProofStatus(),
        anchors: [],
        prerequisites: [],
        next_check: null,
        question: q,
        origin: proposerOrigin(ctx),
        lead_generator: 'manual',
        audit_units: [...units.values()],
        guarantees: [...new Set(invs.flatMap((i) => i.body.guarantees))],
        variants: [],
        linked_claims: [],
        jobs: [],
        authorization: null,
        work_state: 'proposed',
        blocked_reason: null,
        disposition: null,
        probes: [],
        supporting: members,
        refuting: [],
        lineage: members[0],
      });
    }
    const ref = ctx.tx.create(
      'lead_group',
      {
        relation: p.relation,
        members,
        origins: invs.map((i) => ({ member: { record_id: i.record_id, revision: i.revision }, origin: i.body.origin, lead_generator: i.body.lead_generator })),
        proposed_cause: String(p.proposed_cause),
        dissent: list<string>(p.dissent),
        chain_investigation: chain,
        status: 'proposed',
        status_reason: null,
      },
      members,
    );
    return { lead_group: ref, chain_investigation: chain };
  },
});

/** The auditor confirms or dissolves a grouping; members are never deleted, so it is reversible. */
defineOperation<{ lead_group: Ref; status: 'confirmed' | 'dissolved'; reason: string }>({
  name: 'consolidate_leads',
  channels: ['auditor', 'screen'],
  mutating: true,
  handler(ctx, p) {
    const g = ctx.store.get(p.lead_group, 'lead_group');
    if (ctx.store.headRef(g.record_id).revision !== p.lead_group.revision) fail('stale_dependency', 'the group changed; review it again');
    if (!['confirmed', 'dissolved'].includes(p.status)) fail('invalid_request', 'status must be confirmed or dissolved');
    if (!textOrNull(p.reason)) fail('invalid_request', 'a reason is required');
    const ref = ctx.tx.revise(g.record_id, 'lead_group', (b) => ({ ...b, status: p.status, status_reason: p.reason }));
    return { lead_group: ref, members: g.body.members.map(refKey) };
  },
});

export type { OpContext };
