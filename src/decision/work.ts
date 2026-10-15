import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { INVESTIGATION_METHODS, WORK_AUTHORIZATION_KINDS, type WorkAuthorizationKind } from '../core/values.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import { validate } from '../schema/jsonschema.ts';
import { attackerCharterSchema, limitsSchema, type AttackerCharter, type Limits, type WorkAuthorizationBody } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { commitDecision, type DecisionKindDef, type DecisionPayload } from './framework.ts';
import { activeSnapshot, engagement, requirePolicy, textOrNull } from './common.ts';

// Work authorization (stage 04; design/harness-interface-contracts.md `prepare_work`/`authorize_work`;
// FR-07, FR-19, FR-32). Agents and the planner prepare reviewable proposals with no executable grant.
// Only the auditor, on the trusted decision screen, authorizes a bounded allocation of one kind.
// A batch is refused while any of its investigations' audit units lacks a recorded review
// (record_flow_review, DEC-005), while the review queue is at capacity, or beyond the budget.

/** Authorizations that currently grant anything. */
export function currentAuthorizations(store: RecordStore, now: string): ReturnType<RecordStore['heads']> {
  return store.heads('work_authorization').filter((a) => authorizationIsCurrent(a.body, now));
}

export function authorizationIsCurrent(a: WorkAuthorizationBody, now: string): boolean {
  if (a.status !== 'active') return false;
  if (a.validity) {
    const t = Date.parse(now);
    if (t < Date.parse(a.validity.from) || t > Date.parse(a.validity.until)) return false;
  }
  return true;
}

function unitsNotReviewed(store: RecordStore, units: Ref[]): string[] {
  return units
    .map((u) => store.mustHead(u.record_id, 'audit_unit'))
    .filter((u) => u.body.review_status !== 'reviewed')
    .map((u) => `${u.record_id} (${u.body.kind} "${u.body.name}") has no record_flow_review decision`);
}

/** A question is multi-step or cross-flow when it spans units or targets a composition/system invariant. */
function isMultiStepOrCrossFlow(store: RecordStore, units: Ref[]): boolean {
  if (units.length > 1) return true;
  return units.some((u) => ['composition', 'system_invariant'].includes(store.mustHead(u.record_id, 'audit_unit').body.kind));
}

// -----------------------------------------------------------------------------------------------
// prepare_work: a reviewable proposal with coverage and gaps; never a grant.

export interface PrepareWorkPayload {
  kind: WorkAuthorizationKind;
  investigations?: Ref[];
  methods?: string[];
  requested_capabilities?: { tools: string[]; providers: string[]; network: 'denied' | 'rpc_gateway' };
  estimates?: { spend: number; runtime_seconds: number };
}

defineOperation<PrepareWorkPayload>({
  name: 'prepare_work',
  channels: ['auditor', 'worker', 'controller'],
  mutating: true,
  handler(ctx, p) {
    if (!WORK_AUTHORIZATION_KINDS.includes(p?.kind)) fail('invalid_request', 'work kind is required');
    const invs = (p.investigations ?? []).map((r) => ctx.store.get(r, 'investigation'));
    const gaps: string[] = [];
    const units = new Map<string, Ref>();
    let multistep = false;
    for (const inv of invs) {
      for (const u of inv.body.audit_units) units.set(u.record_id, ctx.store.headRef(u.record_id));
      if (p.kind === 'batch') {
        for (const g of unitsNotReviewed(ctx.store, inv.body.audit_units)) gaps.push(`${inv.record_id}: ${g}`);
        if (!inv.body.audit_units.length) gaps.push(`${inv.record_id}: names no audit unit (flow) to review`);
      }
      if (isMultiStepOrCrossFlow(ctx.store, inv.body.audit_units)) multistep = true;
    }
    if (p.kind === 'batch' && !multistep) gaps.push('no high-value multi-step or cross-flow investigation question in this batch');
    const coverage = [...units.values()].map((u) => ({
      audit_unit: u,
      generators: ctx.store.mustHead(u.record_id, 'audit_unit').body.lead_generator_coverage.map((g) => ({ generator: g.generator, status: g.status })),
    }));
    const snapId = activeSnapshot(ctx.store)?.record_id ?? null;
    for (const c of coverage) {
      if (!c.generators.length) gaps.push(`${c.audit_unit.record_id}: no lead generator has run`);
      const unit = ctx.store.mustHead(c.audit_unit.record_id, 'audit_unit');
      for (const g of unit.body.lead_generator_coverage) {
        if (g.status === 'ran' && snapId && !(g.note ?? '').includes(`on ${snapId} `)) gaps.push(`${c.audit_unit.record_id}: generator ${g.generator} last ran on an earlier snapshot`);
        if (g.status === 'not_applicable') gaps.push(`${c.audit_unit.record_id}: generator ${g.generator} did not run (${g.note ?? 'no reason'})`);
      }
    }
    // Units in scope that no proposed question touches stay visible as gaps.
    for (const u of ctx.store.heads('audit_unit')) {
      if (u.body.review_status === 'excluded' || units.has(u.record_id)) continue;
      if (u.body.review_status !== 'reviewed') gaps.push(`${u.record_id} ("${u.body.name}") is ${u.body.review_status} and not covered by this proposal`);
    }
    const ref = ctx.tx.create('work_proposal', {
      kind: p.kind,
      investigations: invs.map((i) => ({ record_id: i.record_id, revision: i.revision })),
      methods: (p.methods ?? [...new Set(invs.map((i) => i.body.method))]).filter((m): m is (typeof INVESTIGATION_METHODS)[number] => INVESTIGATION_METHODS.includes(m as never)),
      requested_capabilities: p.requested_capabilities ?? { tools: [], providers: [], network: 'denied' },
      estimates: p.estimates ?? { spend: 0, runtime_seconds: 0 },
      lead_generator_coverage: coverage,
      includes_multistep_question: multistep,
      gaps,
    });
    return { work_proposal: ref, gaps, includes_multistep_question: multistep };
  },
});

// -----------------------------------------------------------------------------------------------
// authorize_work: a human decision bound to the displayed proposal and investigations.

export interface AuthorizeInputs {
  kind: WorkAuthorizationKind;
  proposal?: Ref | null;
  investigations?: Ref[];
  audit_units?: Ref[];
  methods?: string[];
  attacker_charter?: AttackerCharter | null;
  capabilities: { tools: string[]; providers: string[]; network: 'denied' | 'rpc_gateway' };
  limits: Limits;
  validity?: { from: string; until: string } | null;
  interrupt_conditions?: string[];
}

function inReviewed(p: DecisionPayload, r: Ref): void {
  if (!p.reviewed.some((x) => x.record_id === r.record_id && x.revision === r.revision)) {
    fail('display_required', `${r.record_id}@${r.revision} was not among the reviewed revisions`);
  }
}

function spendCommitted(store: RecordStore, now: string): number {
  return currentAuthorizations(store, now).reduce((s, a) => s + (a.body as WorkAuthorizationBody).limits.spend, 0);
}

const authorizeDef: DecisionKindDef = {
  kind: 'authorize_work',
  check(ctx, p) {
    const policy = requirePolicy(ctx.store);
    const i = p.inputs as unknown as AuthorizeInputs;
    if (!WORK_AUTHORIZATION_KINDS.includes(i?.kind)) fail('invalid_request', 'work authorization kind is required');
    if (engagement(ctx.store).body.closure_status !== 'open') fail('permission_denied', 'the engagement is closed');
    const limitIssues = validate(limitsSchema, i.limits);
    if (limitIssues.length) fail('invalid_request', 'finite resource limits are required', { details: limitIssues });
    if (!Object.values(i.limits).every((v) => Number.isFinite(v))) fail('invalid_request', 'resource limits must be finite');
    if (!i.capabilities || !Array.isArray(i.capabilities.tools) || !Array.isArray(i.capabilities.providers)) {
      fail('invalid_request', 'capabilities (tools, providers, network) are required');
    }
    const unapproved = i.capabilities.providers.filter((x) => !policy.data_policy.approved_providers.includes(x));
    if (unapproved.length) fail('permission_denied', `providers not approved for this engagement: ${unapproved.join(', ')}`);
    if (spendCommitted(ctx.store, ctx.now) + i.limits.spend > policy.budget.total) {
      fail('budget_exhausted', `authorizing ${i.limits.spend} ${policy.budget.unit} exceeds the engagement budget of ${policy.budget.total}`);
    }
    if (i.validity && !(Date.parse(i.validity.from) < Date.parse(i.validity.until))) fail('invalid_request', 'invalid validity window');
    if (i.proposal) inReviewed(p, i.proposal);

    if (i.kind === 'batch') {
      const invs = i.investigations ?? [];
      if (!invs.length) fail('invalid_request', 'a batch admits at least one investigation');
      if (!activeSnapshot(ctx.store)) fail('invalid_request', 'register a target snapshot before authorizing a batch');
      const ready = ctx.store.heads('investigation').filter((x) => x.body.work_state === 'ready_for_review').length;
      if (ready >= policy.capacity.review_queue) {
        fail('review_capacity_reached', `the review queue holds ${ready} packets (capacity ${policy.capacity.review_queue}); new discovery is paused`);
      }
      const charter = i.attacker_charter ?? policy.attacker_charter;
      const charterIssues = validate(attackerCharterSchema, charter);
      if (charterIssues.length) fail('invalid_request', 'invalid attacker charter', { details: charterIssues });
      const beyond = charter.capabilities.filter((c) => !policy.attacker_charter.capabilities.includes(c));
      if (beyond.length) fail('permission_denied', `attacker capabilities beyond the engagement charter need a scope decision: ${beyond.join(', ')}`);
      const methods = i.methods ?? [];
      const problems: string[] = [];
      for (const r of invs) {
        inReviewed(p, r);
        const inv = ctx.store.get(r, 'investigation');
        if (!['proposed', 'blocked', 'ready_for_review'].includes(inv.body.work_state) || inv.body.disposition) {
          problems.push(`${r.record_id} is ${inv.body.work_state}${inv.body.disposition ? ` with disposition ${inv.body.disposition.value}` : ''}`);
        }
        if (methods.length && !methods.includes(inv.body.method)) problems.push(`${r.record_id} uses method ${inv.body.method}, not authorized`);
        if (!inv.body.audit_units.length) problems.push(`${r.record_id} names no audit unit, so its relevant flow cannot have a recorded review`);
        problems.push(...unitsNotReviewed(ctx.store, inv.body.audit_units).map((g) => `${r.record_id}: ${g}`));
      }
      if (problems.length) {
        fail('permission_denied', `batch refused: ${problems.join('; ')}`, { details: { problems } });
      }
    } else if (i.kind === 'exploration') {
      const units = i.audit_units ?? [];
      if (!units.length) fail('invalid_request', 'an exploration names the audit units it explores');
      for (const u of units) inReviewed(p, u);
    } else if (i.kind === 'revalidation' && !activeSnapshot(ctx.store)) {
      fail('invalid_request', 'revalidation needs a registered snapshot');
    }
  },
  apply({ ctx, payload, decision }) {
    const policy = requirePolicy(ctx.store);
    const i = payload.inputs as unknown as AuthorizeInputs;
    const invs = i.kind === 'batch' ? (i.investigations ?? []) : [];
    const reviewed = i.kind === 'exploration' ? (i.audit_units ?? []) : payload.reviewed;
    const auth = ctx.tx.create(
      'work_authorization',
      {
        kind: i.kind,
        decision,
        reviewed,
        // Revalidation is the standing allowance for reruns after a change, so it follows the active snapshot.
        snapshot: i.kind === 'revalidation' ? null : activeSnapshot(ctx.store),
        investigations: invs,
        methods: (i.methods ?? []).filter((m): m is (typeof INVESTIGATION_METHODS)[number] => INVESTIGATION_METHODS.includes(m as never)),
        attacker_charter: i.kind === 'batch' ? (i.attacker_charter ?? policy.attacker_charter) : null,
        capabilities: { tools: i.capabilities.tools, providers: i.capabilities.providers, network: i.capabilities.network === 'rpc_gateway' ? 'rpc_gateway' : 'denied' },
        limits: i.limits,
        validity: i.validity ?? null,
        interrupt_conditions: i.interrupt_conditions ?? [],
        status: 'active',
      },
      [decision],
    );
    const admitted: Ref[] = [];
    for (const r of invs) {
      admitted.push(
        ctx.tx.revise(r.record_id, 'investigation', (b) => ({ ...b, work_state: 'queued', blocked_reason: null, authorization: auth })),
      );
    }
    return { work_authorization: auth, admitted };
  },
};

defineOperation<Omit<DecisionPayload, 'decision_kind'>>({
  name: 'authorize_work',
  channels: ['screen'],
  mutating: true,
  handler(ctx, p) {
    return commitDecision(ctx, { ...p, decision_kind: 'authorize_work' }, authorizeDef);
  },
});

// -----------------------------------------------------------------------------------------------
// L4: the auditor requests another distinguishing check within a current authorization.

export interface RequestCheckPayload {
  investigation: Ref;
  check: string;
}

defineOperation<RequestCheckPayload>({
  name: 'request_check',
  channels: ['screen'],
  mutating: true,
  handler(ctx, p) {
    const inv = ctx.store.get(p.investigation, 'investigation');
    if (ctx.store.headRef(inv.record_id).revision !== p.investigation.revision) fail('stale_dependency', 'the investigation changed; review it again');
    if (inv.body.work_state !== 'ready_for_review') fail('invalid_request', 'only an investigation awaiting review can be sent back for another check');
    const check = textOrNull(p.check);
    if (!check) fail('invalid_request', 'name the missing distinguishing check');
    const auth = inv.body.authorization ? ctx.store.mustHead(inv.body.authorization.record_id, 'work_authorization') : undefined;
    if (!auth || !authorizationIsCurrent(auth.body, ctx.now)) {
      fail('grant_expired', 'the investigation has no current authorization; authorize the check with authorize_work');
    }
    const ref = ctx.tx.revise(inv.record_id, 'investigation', (b) => ({ ...b, work_state: 'queued', next_check: check }));
    return { investigation: ref, work_state: 'queued' };
  },
});

/** Mark a ledger-exhausted or expired authorization (used by the scheduler). */
export function setAuthorizationStatus(ctx: OpContext, id: string, status: WorkAuthorizationBody['status']): Ref {
  return ctx.tx.revise(id, 'work_authorization', (b) => ({ ...b, status }));
}
