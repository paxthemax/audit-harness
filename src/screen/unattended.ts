import { fail } from '../core/errors.ts';
import { randomToken } from '../core/hash.ts';
import type { Ref } from '../core/refs.ts';
import { UNATTENDED_DECISION_KINDS } from '../core/values.ts';
import { Controller } from '../controller/controller.ts';
import type { Workspace } from '../controller/workspace.ts';
import type { EngagementPolicy, Limits } from '../schema/records.ts';
import { authorizeInputs, LIMIT_KEYS, policyFromDraft, refOf, scopePolicyRequest, type AuthorizeDraft } from './flows.ts';
import { InputClosed, type ScreenIO } from './io.ts';
import { screenProgramDigest } from '../capture/program.ts';
import { TrustedScreen, type DecisionOutcome } from './screen.ts';

// The unattended approver: an operator-requested deviation from the human-decision invariant
// (docs/operator-choices.md, 2026-10-14). It applies a draft exactly as written, with no prompts, for the decision
// kinds the operator delegated to it for one engagement in harness.json. It uses the same display receipt and the same
// operations as the trusted screen, but its decisions carry the principal `unattended-approver` and the authorship
// `agent_unattended`, so status and reports can tell them from human decisions. It cannot start unless the operator
// opted in, it never defaults a missing value (a draft that leaves anything unresolved is refused), and it reaches
// no kind outside UNATTENDED_DECISION_KINDS.

/** A terminal that is not one: output is kept, and any question ends the run. */
export type SilentIO = ScreenIO & { readonly text: () => string };

export function silentIO(): SilentIO {
  const out: string[] = [];
  return {
    interactive: false,
    rows: 24,
    styled: false,
    text: () => out.join(''),
    write: (s) => void out.push(s),
    ask: async () => {
      throw new InputClosed();
    },
    edit: async () => {
      throw new InputClosed();
    },
    close() {},
  };
}

export interface OpenUnattendedOptions {
  ws: Workspace;
  key: string;
  engagement: string;
  controller?: Controller;
  clock?: () => string;
}

export function openUnattendedScreen(o: OpenUnattendedOptions): { screen: TrustedScreen; io: SilentIO } {
  const controller = o.controller ?? new Controller(o.ws);
  const io = silentIO();
  const identity = `harness-unattended-approver ${screenProgramDigest()}`;
  const session = controller.unattendedApprover(o.key, o.engagement, identity, `unattended-${randomToken(8)}`);
  return { screen: new TrustedScreen(session, o.engagement, io, o.clock), io };
}

/** Only the delegated kinds, and only when the operator delegated them (the controller re-checks both). */
export function isUnattendedKind(kind: string): boolean {
  return (UNATTENDED_DECISION_KINDS as readonly string[]).includes(kind);
}

export async function acceptScopeAndPolicyUnattended(screen: TrustedScreen, draft: Partial<EngagementPolicy>): Promise<DecisionOutcome> {
  screen.beginDisplay();
  const eng = screen.heads('engagement')[0];
  screen.log.rendered(eng);
  screen.log.opened('engagement');
  // The interactive screen asks about every default capability; here the draft must have answered each one.
  return screen.decideUnattended(scopePolicyRequest(eng, policyFromDraft(draft)));
}

export async function authorizeWorkUnattended(screen: TrustedScreen, proposalId: string, draft: AuthorizeDraft): Promise<DecisionOutcome> {
  screen.beginDisplay();
  const prop = screen.head<'work_proposal'>(proposalId);
  screen.log.rendered(prop);
  screen.log.opened('proposal');
  const kept: Ref[] = [];
  for (const r of prop.body.investigations) {
    const inv = screen.head<'investigation'>(r.record_id);
    if (inv.revision !== r.revision) {
      fail('stale_dependency', `investigation ${inv.record_id} changed since the proposal (bound revision ${r.revision}, current ${inv.revision}); prepare the work again`);
    }
    screen.log.rendered(inv);
    kept.push(refOf(inv));
  }
  screen.log.opened('investigations');
  // Nothing is defaulted: every finite limit must come from the draft.
  const missing = LIMIT_KEYS.filter((k) => draft.limits?.[k] === undefined);
  if (missing.length) fail('invalid_request', `the draft must set every limit; missing: ${missing.join(', ')}`);
  const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, draft.limits![k] as number])) as unknown as Limits;
  const capabilities = draft.capabilities ?? {
    tools: prop.body.requested_capabilities.tools,
    providers: prop.body.requested_capabilities.providers,
    network: prop.body.requested_capabilities.network,
  };
  return screen.decideUnattended({
    operation: 'authorize_work',
    decision_kind: 'authorize_work',
    reviewed: [refOf(prop), ...kept],
    inputs: authorizeInputs(prop, kept, limits, capabilities, draft),
    agent_draft: null,
    summary: [`Admit ${kept.length} investigation(s) bound by the proposal`, `Limits: ${JSON.stringify(limits)}`],
  });
}

export interface FlowReviewDraft {
  /** Gaps to record for the flow, besides the unattended-review gap the controller adds. */
  gaps?: string[];
}

/**
 * Lifts the batch gate (FR-32) for one unit. Only the unit is rendered: no statement, so no IMPLEMENTED behavior counts as
 * presented and later intent timing is unaffected. The controller marks no function reviewed and records a gap saying no
 * human reviewed the flow.
 */
export async function recordFlowReviewUnattended(screen: TrustedScreen, unitId: string, draft: FlowReviewDraft = {}): Promise<DecisionOutcome> {
  const extra = Object.keys(draft).filter((k) => k !== 'gaps');
  if (extra.length) fail('invalid_request', `an unattended flow review draft sets only gaps; refused: ${extra.join(', ')}`);
  const gaps = draft.gaps ?? [];
  if (!Array.isArray(gaps) || gaps.some((g) => typeof g !== 'string' || !g.trim())) fail('invalid_request', 'gaps must be non-empty strings');
  screen.beginDisplay();
  const unit = screen.head<'audit_unit'>(unitId);
  screen.log.rendered(unit);
  screen.log.opened('unit');
  return screen.decideUnattended({
    operation: 'record_decision',
    decision_kind: 'record_flow_review',
    reviewed: [refOf(unit)],
    inputs: { audit_unit: refOf(unit), comparisons: [], gaps, reviewed_functions: [] },
    agent_draft: null,
    summary: [`Unit ${unit.record_id} "${unit.body.name}" becomes reviewed for the batch gate only`, `No function is marked reviewed; gaps added: ${gaps.length} plus the unattended-review gap`],
  });
}
