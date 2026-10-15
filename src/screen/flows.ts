import { fail } from '../core/errors.ts';
import { refKey, type Ref } from '../core/refs.ts';
import { DEFAULT_ATTACKER_CHARTER } from '../core/values.ts';
import type { AttackerCharter, EngagementPolicy, Limits, RecordEnvelope } from '../schema/records.ts';
import { askList, askUntil, choose, confirmWord, heading, page, show } from './io.ts';
import { recordLines, refText } from './render.ts';
import type { DecisionOutcome, DecisionRequest, TrustedScreen } from './screen.ts';

// Decision screens other than the review packet (design/harness-interface-contracts.md, "Human
// decision kinds"; design/harness-auditor-guide.md). Each one renders the exact revisions the decision
// binds, collects the kind's inputs item by item (there is no bulk disposition anywhere; the one
// permitted aggregate is the labelled mechanical carry-forward attestation), then records the display
// receipt and submits. A refusal shows what changed and offers a re-review against current revisions.

export const refOf = (e: RecordEnvelope): Ref => ({ record_id: e.record_id, revision: e.revision });

async function withRereview(screen: TrustedScreen, run: () => Promise<DecisionOutcome>): Promise<DecisionOutcome> {
  for (;;) {
    screen.beginDisplay();
    const o = await run();
    if (!(await screen.offerRereview(o))) return o;
  }
}

function nothing(screen: TrustedScreen, what: string): DecisionOutcome {
  screen.io.write(`${what}\n`);
  return { status: 'cancelled' };
}

// -----------------------------------------------------------------------------------------------
// confirm_interpretations: agent-proposed statements beside the captured input they came from;
// confirm, edit or reject EACH item individually, submitted as one batch.

export interface InterpretationChoice {
  interpretation: Ref;
  choice: 'confirm' | 'edit' | 'reject';
  edited_statement?: string;
}

export async function confirmInterpretations(screen: TrustedScreen, ids?: string[]): Promise<DecisionOutcome> {
  return withRereview(screen, async () => {
    screen.banner('Interpretations awaiting confirmation');
    const all = screen.heads('interpretation').filter((i) => i.body.status === 'proposed');
    const items = ids?.length ? all.filter((i) => ids.includes(i.record_id)) : all;
    if (!items.length) return nothing(screen, 'No interpretation is awaiting confirmation.');
    const reviewed: Ref[] = [];
    const choices: InterpretationChoice[] = [];
    items.forEach((it) => reviewed.push(refOf(it)));
    for (const [n, it] of items.entries()) {
      heading(screen.io, `Item ${n + 1} of ${items.length}: ${it.record_id}@${it.revision}`);
      const pr = it.body.proposed;
      show(screen.io, `Agent-proposed statement (${pr.kind}, ${pr.affiliation}; units ${pr.audit_units.map(refKey).join(', ') || 'none'}):\n  ${pr.statement}\n`);
      screen.io.write('Captured input it came from (verbatim):\n');
      for (const c of it.body.captured_inputs) {
        const cap = screen.get<'captured_input'>(c);
        screen.render(cap, '  ');
        reviewed.push(c);
      }
      screen.log.rendered(it);
      const choice = await choose(screen.io, `Your choice for item ${n + 1}`, [
        { key: 'c', value: 'confirm', label: 'Confirm the statement as proposed' },
        { key: 'e', value: 'edit', label: 'Edit the statement' },
        { key: 'r', value: 'reject', label: 'Reject it (it stays an unconfirmed proposal record)' },
      ]);
      const entry: InterpretationChoice = { interpretation: refOf(it), choice };
      if (choice === 'edit') {
        let edited = '';
        while (!edited.trim()) edited = await screen.io.edit(`Edit item ${n + 1}`, pr.statement);
        entry.edited_statement = edited.trim();
      }
      choices.push(entry);
    }
    screen.log.opened('interpretations');
    return screen.decide({
      operation: 'record_decision',
      decision_kind: 'confirm_interpretations',
      reviewed: dedupe(reviewed),
      inputs: { items: choices },
      agent_draft: null,
      summary: choices.map((c, i) => `Item ${i + 1} ${c.interpretation.record_id}: ${c.choice}${c.edited_statement ? ` -> "${c.edited_statement}"` : ''}`),
    });
  });
}

function dedupe(refs: Ref[]): Ref[] {
  const m = new Map(refs.map((r) => [refKey(r), r]));
  return [...m.values()];
}

// -----------------------------------------------------------------------------------------------
// answer_clarification: one clarification, its affected work and current evidence; "unknown" allowed.

export async function answerClarification(screen: TrustedScreen, id?: string): Promise<DecisionOutcome> {
  return withRereview(screen, async () => {
    screen.banner('Clarification');
    const open = screen
      .heads('clarification')
      .filter((c) => ['queued', 'presented', 'held'].includes(c.body.status))
      .sort((a, b) => b.body.priority - a.body.priority || a.record_id.localeCompare(b.record_id, 'en', { numeric: true }));
    const clar = id ? screen.head<'clarification'>(id) : open[0];
    if (!clar) return nothing(screen, 'No clarification is waiting.');
    if (!id && open.length > 1) screen.io.write(`${open.length - 1} more clarification(s) wait in priority order; this is the highest.\n`);
    screen.render(clar);
    screen.log.opened('clarification');
    heading(screen.io, 'Conflicting or missing facts');
    for (const f of clar.body.conflicting_facts) {
      if ('artifact' in f) show(screen.io, `  artifact ${f.artifact}\n`);
      else {
        const env = screen.tryGet(f);
        if (env) screen.render(env);
        else show(screen.io, `  ${refKey(f)} (not readable)\n`);
      }
    }
    heading(screen.io, 'Work that depends on the answer');
    if (!clar.body.blocks.length) screen.io.write('  (none named)\n');
    for (const b of clar.body.blocks) {
      const env = screen.tryGet(b);
      if (env) screen.render(env);
    }
    const prior = screen.heads('clarification').filter((c) => c.record_id !== clar.record_id && c.body.dedupe_key === clar.body.dedupe_key && c.body.answer);
    for (const p of prior) show(screen.io, `Prior answer to the same question (${p.record_id}): ${p.body.answer!.value}\n`);
    const unrelated = screen.heads('investigation').filter((i) => !clar.body.blocks.some((b) => b.record_id === i.record_id));
    screen.io.write(`Unrelated work continues: ${unrelated.length} other investigation(s) (${countBy(unrelated.map((i) => i.body.work_state))}).\n`);

    heading(screen.io, 'Answer');
    clar.body.options.forEach((o, i) => show(screen.io, `  [${i + 1}] ${o.option} — ${o.consequence}\n`));
    screen.io.write('  [u] unknown (the dependent conclusion stays conditional)\n  [t] type a different answer\n');
    const pick = await askUntil(screen.io, 'Answer: ', (a) =>
      a === 'u' || a === 't' || (/^\d+$/.test(a) && Number(a) >= 1 && Number(a) <= clar.body.options.length) ? null : 'Choose an option number, u or t.',
    );
    const answer = pick === 'u' ? 'unknown' : pick === 't' ? (await screen.io.edit('Your answer', '')).trim() : clar.body.options[Number(pick) - 1].option;
    const as = await choose(screen.io, 'Record the answer as', [
      { key: 'i', value: 'intent', label: 'intent (intended behavior; never overwrites observed implementation)' },
      { key: 'a', value: 'assumption', label: 'assumption' },
    ]);
    const relayed = (await choose(screen.io, 'Source', [
      { key: 'm', value: 'me', label: 'my own judgment (auditor_clarification)' },
      { key: 'c', value: 'client', label: 'relayed from the auditee (auditee_statement)' },
    ])) === 'client';
    // The answer links the auditor's captured input (DEC-008 Q-018): pick it from recent captures.
    const caps = screen.heads('captured_input').slice(-8).reverse();
    heading(screen.io, 'Captured input that carries this answer');
    if (!caps.length) return nothing(screen, 'No captured input exists. Type the answer through `harness capture --purpose clarification_answer` first.');
    caps.forEach((c, i) => show(screen.io, `  [${i + 1}] ${c.record_id} ${c.body.captured_at} (${c.body.purpose}): ${c.body.text.slice(0, 120)}\n`));
    const ci = Number(await askUntil(screen.io, 'Captured input number: ', (a) => (/^\d+$/.test(a) && Number(a) >= 1 && Number(a) <= caps.length ? null : 'Choose a listed number.')));
    const cap = caps[ci - 1];
    screen.render(cap);
    return screen.decide({
      operation: 'record_decision',
      decision_kind: 'answer_clarification',
      reviewed: [refOf(clar), refOf(cap)],
      inputs: { clarification: refOf(clar), answer, captured_input: refOf(cap), as, relayed_from_auditee: relayed },
      agent_draft: clar.body.recommendation,
      summary: [`Clarification ${clar.record_id}: ${answer}`, `Recorded as ${as}${relayed ? ', relayed from the auditee' : ''}`, `Captured input ${cap.record_id}`],
    });
  });
}

function countBy(xs: string[]): string {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
}

// -----------------------------------------------------------------------------------------------
// accept_scope_and_policy: narrow the default attacker charter; the trusted-role premise is shown as
// an assumption. Policy fields come from a draft (`--draft policy.json`) and are all rendered.

export const DEFAULT_TRUSTED_ROLE_PREMISE = 'Privileged roles are trusted unless raised.';
/** Policy fields the controller requires before it accepts scope and policy. */
export const MANDATORY_POLICY_FIELDS = ['scope', 'data_policy', 'retention', 'severity_rubric', 'rejection_listing_threshold', 'budget', 'evidence_policy', 'capacity', 'time_plan'] as const;

/** The `accept_scope_and_policy` request for the engagement revision shown. */
export function scopePolicyRequest(eng: RecordEnvelope<'engagement'>, policy: EngagementPolicy): DecisionRequest {
  const charter = policy.attacker_charter;
  return {
    operation: 'record_decision',
    decision_kind: 'accept_scope_and_policy',
    reviewed: [refOf(eng)],
    inputs: { policy },
    agent_draft: null,
    summary: [`Charter keeps ${charter.capabilities.length} capabilities, excludes ${charter.excluded.length}`, `Raised roles: ${charter.raised_roles.join(', ') || 'none'}`],
  };
}

/**
 * A policy from a draft without prompts (unattended approver, agent sessions): the draft must keep or exclude, with a
 * reason, every default attacker capability; nothing is defaulted except the trusted-role premise text.
 */
export function policyFromDraft(draft: Partial<EngagementPolicy>): EngagementPolicy {
  const base = draft.attacker_charter;
  const kept = base ? base.capabilities : [...DEFAULT_ATTACKER_CHARTER.capabilities];
  const excluded = base?.excluded ?? [];
  if (!Array.isArray(kept) || !Array.isArray(excluded)) fail('invalid_request', 'the draft charter lists capabilities and excluded entries');
  const unreasoned = excluded.filter((e) => !e || typeof e.reason !== 'string' || !e.reason.trim());
  if (unreasoned.length) fail('invalid_request', `every excluded capability needs a reason; missing for: ${unreasoned.map((e) => e?.capability).join(', ')}`);
  const unanswered = DEFAULT_ATTACKER_CHARTER.capabilities.filter((c) => !kept.includes(c) && !excluded.some((e) => e.capability === c));
  if (unanswered.length) fail('invalid_request', `the draft charter must keep or exclude (with a reason) every default capability; unanswered: ${unanswered.join(', ')}`);
  const charter: AttackerCharter = {
    capabilities: kept,
    excluded,
    raised_roles: base?.raised_roles ?? [],
    privileged_roles_trusted: base?.privileged_roles_trusted ?? true,
    notes: base?.notes ?? null,
  };
  return { ...draft, attacker_charter: charter, trusted_role_premise: draft.trusted_role_premise ?? DEFAULT_TRUSTED_ROLE_PREMISE } as EngagementPolicy;
}

export async function acceptScopeAndPolicy(screen: TrustedScreen, draft: Partial<EngagementPolicy>): Promise<DecisionOutcome> {
  return withRereview(screen, async () => {
    screen.banner('Accept scope and policy');
    const eng = screen.heads('engagement')[0];
    screen.log.rendered(eng);
    screen.log.opened('engagement');
    const base = draft.attacker_charter;
    heading(screen.io, 'Threat model: default attacker charter (DEC-008 Q-015), narrow it per capability');
    const keep: string[] = [];
    const excluded: AttackerCharter['excluded'] = [...(base?.excluded ?? [])];
    for (const cap of DEFAULT_ATTACKER_CHARTER.capabilities) {
      const pre = base ? (base.capabilities.includes(cap) ? 'k' : 'x') : null;
      const c = await choose(screen.io, `Capability ${cap}${pre ? ` (draft: ${pre === 'k' ? 'keep' : 'exclude'})` : ''}`, [
        { key: 'k', value: 'keep', label: 'keep: this engagement\'s attackers can do this' },
        { key: 'x', value: 'exclude', label: 'exclude (with a reason)' },
      ]);
      if (c === 'keep') keep.push(cap);
      else if (!excluded.some((e) => e.capability === cap)) {
        excluded.push({ capability: cap, reason: await askUntil(screen.io, '  Reason: ', (a) => (a ? null : 'A reason is required.')) });
      }
    }
    const extra = (base?.capabilities ?? []).filter((c) => !(DEFAULT_ATTACKER_CHARTER.capabilities as readonly string[]).includes(c));
    if (extra.length) show(screen.io, `Draft adds capabilities beyond the default: ${extra.join(', ')} (kept; they need a note)\n`);
    heading(screen.io, 'Trusted-role premise (an ASSUMPTION, printed in the report\'s assumptions section)');
    show(screen.io, `  ${draft.trusted_role_premise ?? DEFAULT_TRUSTED_ROLE_PREMISE}\n`);
    const raised = await askList(screen.io, `Roles you raise to attacker (not trusted)${base?.raised_roles?.length ? ` [draft: ${base.raised_roles.join(', ')}]` : ''}`);
    const charter: AttackerCharter = {
      capabilities: [...keep, ...extra],
      excluded,
      raised_roles: raised.length ? raised : (base?.raised_roles ?? []),
      privileged_roles_trusted: base?.privileged_roles_trusted ?? true,
      notes: base?.notes ?? null,
    };
    const policy = { ...draft, attacker_charter: charter, trusted_role_premise: draft.trusted_role_premise ?? DEFAULT_TRUSTED_ROLE_PREMISE } as EngagementPolicy;
    heading(screen.io, 'Policy as it will be recorded');
    const lines = JSON.stringify(policy, null, 2).split('\n');
    show(screen.io, lines.slice(0, 60).join('\n') + '\n');
    if (lines.length > 60 && (await choose(screen.io, 'Policy is long', [{ key: 'p', value: 'p', label: 'page it in full' }, { key: 'n', value: 'n', label: 'continue' }])) === 'p') {
      await page(screen.io, lines, 'policy');
    }
    screen.log.opened('policy');
    const missing = MANDATORY_POLICY_FIELDS.filter((k) => (policy as unknown as Record<string, unknown>)[k] === undefined);
    if (missing.length) screen.io.write(`UNRESOLVED mandatory fields (the controller refuses until supplied in the draft): ${missing.join(', ')}\n`);
    return screen.decide(scopePolicyRequest(eng, policy));
  });
}

// -----------------------------------------------------------------------------------------------
// authorize_work: batch view with lead-generator coverage and spent / reserved / uncertain cost.

export interface AuthorizeDraft {
  limits?: Partial<Limits>;
  capabilities?: { tools: string[]; providers: string[]; network: 'denied' | 'rpc_gateway' };
  validity?: { from: string; until: string } | null;
  interrupt_conditions?: string[];
  attacker_charter?: AttackerCharter | null;
  audit_units?: Ref[];
}

export function ledgerTotals(entries: RecordEnvelope<'ledger_entry'>[]): { spent: number; reserved: number; uncertain: number } {
  let spent = 0;
  let reserved = 0;
  let uncertain = 0;
  for (const e of entries) {
    if (e.body.kind === 'actual') spent += e.body.spend;
    else if (e.body.kind === 'reservation') reserved += e.body.spend;
    else if (e.body.kind === 'release') reserved -= e.body.spend;
    else if (e.body.kind === 'uncertain') uncertain += e.body.spend;
  }
  return { spent, reserved: Math.max(0, reserved), uncertain };
}

/** The `authorize_work` decision inputs, shared by the interactive screen and the unattended approver. */
export function authorizeInputs(
  prop: RecordEnvelope<'work_proposal'>,
  kept: Ref[],
  limits: Limits,
  capabilities: { tools: string[]; providers: string[]; network: 'denied' | 'rpc_gateway' },
  draft: AuthorizeDraft,
): Record<string, unknown> {
  return {
    kind: prop.body.kind,
    proposal: refOf(prop),
    investigations: kept,
    methods: prop.body.methods,
    capabilities,
    limits,
    validity: draft.validity ?? null,
    interrupt_conditions: draft.interrupt_conditions ?? [],
    ...(draft.attacker_charter ? { attacker_charter: draft.attacker_charter } : {}),
    ...(draft.audit_units ? { audit_units: draft.audit_units } : {}),
  };
}

export const LIMIT_KEYS: (keyof Limits)[] = ['spend', 'runtime_seconds', 'concurrency', 'child_tasks', 'rounds', 'retries', 'repairs_per_variant', 'output_bytes', 'memory_mb', 'processes'];

/**
 * The authorization view: the proposal, spending, lead-generator coverage, gaps and each investigation it binds (with a
 * note when one changed since the proposal). Yields each investigation right after it is shown; the view is complete
 * (the investigations section recorded as opened) once the iteration ends.
 */
export function* showWorkProposal(screen: TrustedScreen, prop: RecordEnvelope<'work_proposal'>): Generator<RecordEnvelope<'investigation'>, void, undefined> {
  screen.banner(`Authorize work: proposal ${prop.record_id}@${prop.revision} (${prop.body.kind})`);
  screen.render(prop);
  screen.log.opened('proposal');
  const eng = screen.heads('engagement')[0];
  const unit = eng.body.policy?.budget.unit ?? 'budget units';
  const t = ledgerTotals(screen.heads('ledger_entry'));
  heading(screen.io, 'Spending (from ledger entries)');
  screen.io.write(`  Spent: ${t.spent} ${unit}\n  Reserved: ${t.reserved} ${unit}\n  Uncertain: ${t.uncertain} ${unit}\n  Engagement budget: ${eng.body.policy ? eng.body.policy.budget.total : 'not set (scope and policy not accepted)'}\n`);
  const ready = screen.heads('investigation').filter((i) => i.body.work_state === 'ready_for_review').length;
  screen.io.write(`  Review queue: ${ready} packet(s) waiting; capacity ${eng.body.policy?.capacity.review_queue ?? 'not set'}\n`);
  heading(screen.io, 'Lead-generator coverage per unit');
  for (const c of prop.body.lead_generator_coverage) {
    show(screen.io, `  ${refText(c.audit_unit)}: ${c.generators.map((g) => `${g.generator}=${g.status}`).join(', ') || 'no lead generator has run'}\n`);
  }
  screen.io.write(`  Includes a high-value multi-step or cross-flow question: ${prop.body.includes_multistep_question ? 'yes' : 'NO'}\n`);
  if (prop.body.gaps.length) {
    heading(screen.io, 'Gaps');
    for (const g of prop.body.gaps) show(screen.io, `  - ${g}\n`);
  }
  heading(screen.io, 'Investigations: keep or remove each');
  for (const r of prop.body.investigations) {
    const inv = screen.head<'investigation'>(r.record_id);
    screen.render(inv);
    if (inv.revision !== r.revision) show(screen.io, `  CHANGED since the proposal: proposal bound revision ${r.revision}, current ${inv.revision}\n`);
    yield inv;
  }
  screen.log.opened('investigations');
}

/** The `authorize_work` request for the kept investigations; capabilities default to the proposal's request. */
export function authorizeRequest(prop: RecordEnvelope<'work_proposal'>, kept: Ref[], limits: Limits, draft: AuthorizeDraft): DecisionRequest {
  const capabilities = draft.capabilities ?? {
    tools: prop.body.requested_capabilities.tools,
    providers: prop.body.requested_capabilities.providers,
    network: prop.body.requested_capabilities.network,
  };
  return {
    operation: 'authorize_work',
    decision_kind: 'authorize_work',
    reviewed: [refOf(prop), ...kept],
    inputs: authorizeInputs(prop, kept, limits, capabilities, draft),
    agent_draft: null,
    summary: [`Admit ${kept.length} of ${prop.body.investigations.length} investigation(s): ${kept.map(refKey).join(', ') || 'none'}`, `Limits: ${JSON.stringify(limits)}`],
  };
}

export async function authorizeWork(screen: TrustedScreen, proposalId: string, draft: AuthorizeDraft): Promise<DecisionOutcome> {
  return withRereview(screen, async () => {
    const prop = screen.head<'work_proposal'>(proposalId);
    const kept: Ref[] = [];
    for (const inv of showWorkProposal(screen, prop)) {
      const k = await choose(screen.io, `Admit ${inv.record_id}`, [
        { key: 'y', value: 'y', label: 'admit in this batch' },
        { key: 'n', value: 'n', label: 'remove from this batch' },
      ]);
      if (k === 'y') kept.push(refOf(inv));
    }
    heading(screen.io, 'Finite resource limits (operator choices; nothing is defaulted)');
    const limits = {} as Limits;
    for (const k of LIMIT_KEYS) {
      const d = draft.limits?.[k];
      const a = await askUntil(screen.io, `  ${k}${d !== undefined ? ` [Enter = ${d}]` : ''}: `, (x) =>
        (x === '' && d !== undefined) || (x !== '' && Number.isFinite(Number(x)) && Number(x) >= 0) ? null : 'A finite non-negative number is required.',
      );
      limits[k] = a === '' ? (d as number) : Number(a);
    }
    const req = authorizeRequest(prop, kept, limits, draft);
    const capabilities = req.inputs.capabilities as { tools: string[]; providers: string[]; network: string };
    show(screen.io, `Capabilities: tools ${capabilities.tools.join(', ') || 'none'}; providers ${capabilities.providers.join(', ') || 'none'}; network ${capabilities.network}\n`);
    if (draft.validity) show(screen.io, `Standing charter validity: ${draft.validity.from} to ${draft.validity.until}\n`);
    return screen.decide(req);
  });
}

// -----------------------------------------------------------------------------------------------
// record_flow_review: the DESIGNED/IMPLEMENTED comparison of one flow, its gaps and assumptions.
// Rendering IMPLEMENTED statements records the unit's first presentation (intent timing).

/** The flow-review view: the unit, its DESIGNED / IMPLEMENTED / SHARED statements, correspondences and comparisons. */
export function showFlowReview(screen: TrustedScreen, unit: RecordEnvelope<'audit_unit'>): RecordEnvelope<'behavioral_comparison'>[] {
  screen.banner(`Flow review: ${unit.record_id}@${unit.revision}`);
  screen.render(unit);
  screen.log.opened('unit');
  const corrs = screen.heads('behavioral_correspondence').filter((c) => c.body.audit_unit.record_id === unit.record_id);
  const stmts = screen.heads('system_statement').filter((s) => s.body.audit_units.some((u) => u.record_id === unit.record_id));
  for (const side of ['designed', 'implemented', 'shared'] as const) {
    heading(screen.io, side.toUpperCase());
    const list = stmts.filter((s) => s.body.affiliation === side);
    if (!list.length) screen.io.write('  (none recorded)\n');
    for (const s of list) screen.render(s);
  }
  screen.log.opened('designed_implemented');
  for (const c of corrs) screen.render(c);
  const cmps = screen.heads('behavioral_comparison').filter((c) => c.body.correspondences.some((r) => corrs.some((x) => x.record_id === r.record_id)));
  heading(screen.io, 'Comparisons');
  if (!cmps.length) screen.io.write('  (none recorded)\n');
  for (const c of cmps) {
    screen.render(c);
    if (c.body.relied_intent_timing.includes('after_walkthrough')) screen.io.write('  TAG: relies on after_walkthrough intent\n');
  }
  screen.log.opened('comparisons');
  return cmps;
}

/** The `record_flow_review` request binding the unit and the comparisons that were shown. */
export function flowReviewRequest(unit: RecordEnvelope<'audit_unit'>, cmps: RecordEnvelope<'behavioral_comparison'>[], gaps: string[], reviewedFns: string[]): DecisionRequest {
  return {
    operation: 'record_decision',
    decision_kind: 'record_flow_review',
    reviewed: [refOf(unit), ...cmps.map(refOf)],
    inputs: { audit_unit: refOf(unit), comparisons: cmps.map(refOf), gaps, reviewed_functions: reviewedFns },
    agent_draft: null,
    summary: [`Unit ${unit.record_id} becomes reviewed at the active snapshot`, `Comparisons: ${cmps.length}; gaps added: ${gaps.length}; functions reviewed: ${reviewedFns.length}`],
  };
}

export async function recordFlowReview(screen: TrustedScreen, unitId: string): Promise<DecisionOutcome> {
  return withRereview(screen, async () => {
    const unit = screen.head<'audit_unit'>(unitId);
    const cmps = showFlowReview(screen, unit);
    const gaps = await askList(screen.io, 'Gaps you record for this flow');
    const fns = unit.body.functions.filter((f) => !f.reviewed);
    const reviewedFns: string[] = [];
    for (const f of fns) {
      if ((await choose(screen.io, `Did you review ${f.name}?`, [{ key: 'y', value: 'y', label: 'yes' }, { key: 'n', value: 'n', label: 'no (stays an open gap)' }])) === 'y') reviewedFns.push(f.name);
    }
    return screen.decide(flowReviewRequest(unit, cmps, gaps, reviewedFns));
  });
}

// -----------------------------------------------------------------------------------------------
// attest_carry_forward: the one permitted aggregate, labelled MECHANICAL.

export async function attestCarryForward(screen: TrustedScreen, snapshotId?: string): Promise<DecisionOutcome> {
  return withRereview(screen, async () => {
    screen.banner('Mechanical carry-forward attestation');
    const all = screen.heads('conclusion_freshness').filter((f) => f.body.value === 'carried_forward_mechanical' && !f.body.attestation);
    const items = snapshotId ? all.filter((f) => f.body.snapshot.record_id === snapshotId) : all;
    if (!items.length) return nothing(screen, 'No unattested carried-forward conclusion.');
    const snap = items[0].body.snapshot;
    const prior = items[0].body.prior_snapshot;
    const same = items.filter((f) => refKey(f.body.snapshot) === refKey(snap));
    screen.io.write(
      'MECHANICAL: this attests that the dependency probes of these conclusions are unchanged between the two snapshots.\n' +
        'It is NOT a human review of each conclusion; the report shows them as carried forward mechanically.\n',
    );
    show(screen.io, `Snapshots: ${refText(prior)} -> ${refText(snap)}\n`);
    for (const f of same) screen.render(f);
    screen.log.opened('carried_forward_mechanical');
    return screen.decide({
      operation: 'record_decision',
      decision_kind: 'attest_carry_forward',
      reviewed: same.map(refOf),
      inputs: { snapshot: snap, prior_snapshot: prior, freshness: same.map(refOf), mechanical: true },
      agent_draft: null,
      summary: [`Mechanical attestation of ${same.length} conclusion(s) with unchanged probes`],
    });
  });
}

// -----------------------------------------------------------------------------------------------
// approve_export: the frozen preview, its absent required items and their reasons.

export async function approveExport(screen: TrustedScreen, manifestId: string, destination?: string): Promise<DecisionOutcome> {
  return withRereview(screen, async () => {
    const m = screen.head<'report_manifest'>(manifestId);
    screen.banner(`Approve export: ${m.record_id}@${m.revision} (${m.body.status})`);
    screen.render(m);
    screen.log.opened('preview');
    const absent = m.body.required_set.filter((r) => !r.included);
    heading(screen.io, `Required items the selection omits (${absent.length})`);
    if (!absent.length) screen.io.write('  None: every required item is included.\n');
    for (const a of absent) show(screen.io, `  ${refKey(a.ref)}: required because ${a.reason_required}; omission reason: ${a.omission_reason ?? 'NONE GIVEN (approval will be refused)'}\n`);
    screen.log.opened('required_set');
    if (m.body.limits.length) {
      heading(screen.io, 'Limits stated in the export');
      for (const l of m.body.limits) show(screen.io, `  - ${l}\n`);
    }
    if ((await choose(screen.io, 'Report', [{ key: 'p', value: 'p', label: 'page the frozen report text' }, { key: 'n', value: 'n', label: 'continue' }])) === 'p') {
      await screen.pageArtifact(m.body.report.artifact);
      screen.log.opened('report');
    }
    show(screen.io, `Audience of this preview: ${m.body.audience} (an audience change needs a new preview)\n`);
    const audience = m.body.audience;
    const dest = destination ?? (await askUntil(screen.io, 'Authorized destination (e.g. local path): ', (a) => (a ? null : 'Required.')));
    return screen.decide({
      operation: 'approve_export',
      decision_kind: 'approve_export',
      reviewed: [refOf(m)],
      inputs: { report_manifest: refOf(m), payload: m.body.payload.artifact, audience, destination: dest },
      agent_draft: null,
      summary: [`Export ${m.record_id}@${m.revision} for ${audience} to ${dest}`, `Payload ${m.body.payload.artifact}`],
    });
  });
}

// -----------------------------------------------------------------------------------------------
// Any other decision kind: render each bound record, render the supplied inputs, then decide.

export async function genericDecision(
  screen: TrustedScreen,
  kind: string,
  recordSpecs: string[],
  inputs: Record<string, unknown>,
  operation = 'record_decision',
): Promise<DecisionOutcome> {
  return withRereview(screen, async () => {
    screen.banner(`Decision: ${kind}`);
    const reviewed: Ref[] = [];
    for (const spec of recordSpecs) {
      const [id, rev] = spec.split('@');
      const env = rev ? screen.get({ record_id: id, revision: Number(rev) }) : screen.head(id);
      const head = screen.head(id);
      if (head.revision !== env.revision) show(screen.io, `NOTE: ${id} has a newer revision ${head.revision} than the bound ${env.revision}\n`);
      screen.render(env);
      reviewed.push(refOf(env));
      if ((await choose(screen.io, `Record ${env.record_id}`, [{ key: 'n', value: 'n', label: 'continue' }, { key: 'p', value: 'p', label: 'page the full record' }])) === 'p') {
        await screen.pageRecord(env);
      }
    }
    screen.log.opened('records');
    heading(screen.io, 'Decision inputs as they will be recorded');
    show(screen.io, JSON.stringify(inputs, null, 2) + '\n');
    screen.log.opened('inputs');
    if (!(await confirmWord(screen.io, 'Are these inputs what you decide?', 'inputs'))) return { status: 'cancelled' };
    return screen.decide({ operation, decision_kind: kind, reviewed, inputs, agent_draft: null, summary: [`Records: ${reviewed.map(refKey).join(', ')}`] });
  });
}
