// Test-only helpers for the trusted screen and capture channel: a scripted terminal and record
// fixtures built through the real operations (plus the decision layer's test fixtures for runner
// evidence). No production bypass is used.

import type { Ref } from '../src/core/refs.ts';
import type { ScreenIO } from '../src/screen/io.ts';
import { openTrustedScreen, type TrustedScreen } from '../src/screen/screen.ts';
import { admittedInvestigation, head, stageEvidence, variantWithOutcome } from './decision-fixtures.ts';
import type { Harness } from './helpers.ts';

export interface ScriptedIO extends ScreenIO {
  /** Everything written, in order. */
  readonly output: string[];
  readonly text: () => string;
  /** Prompts asked, in order. */
  readonly prompts: string[];
}

/** A terminal that answers prompts from a script. `interactive` defaults to true (a real TTY). */
export function scriptedIO(answers: string[], opts: { interactive?: boolean; rows?: number } = {}): ScriptedIO {
  const queue = [...answers];
  const output: string[] = [];
  const prompts: string[] = [];
  const next = (prompt: string): string => {
    prompts.push(prompt);
    output.push(prompt);
    if (!queue.length) throw new Error(`script exhausted at prompt ${JSON.stringify(prompt)}\n--- output so far ---\n${output.join('')}`);
    return queue.shift()!;
  };
  return {
    interactive: opts.interactive ?? true,
    rows: opts.rows ?? 200,
    styled: false,
    output,
    prompts,
    text: () => output.join(''),
    write: (s) => void output.push(s),
    ask: async (p) => next(p),
    edit: async (label) => next(`[edit] ${label}: `),
    close() {},
  };
}

export function screenFor(h: Harness, eid: string, io: ScreenIO): TrustedScreen {
  return openTrustedScreen({ ws: h.ws, key: h.ws.readSecret('auditor.key'), io, engagement: eid, controller: h.controller });
}

export interface HighPacket {
  eid: string;
  inv: Ref;
  packet: Ref;
  guardEvidence: Ref;
  positiveControl: Ref;
  draft: string;
}

/** A ready-for-review, potential-High packet whose rejection is supportable (violating positive control). */
export function readyHighPacket(h: Harness, eid: string): HighPacket {
  const { inv } = admittedInvestigation(h, eid, { impact: 'high' });
  variantWithOutcome(h, eid, inv.record_id, 'refuted');
  const guardEvidence = stageEvidence(h, eid, inv.record_id, 'experiment', 'no_violation_observed');
  const positiveControl = stageEvidence(h, eid, inv.record_id, 'positive_control', 'counterexample');
  const draft = 'AGENT-DRAFT: the nonReentrant guard blocks the nested call.';
  const packet = h.auditor.do(eid, 'submit_review_packet', {
    investigation: head(h, eid, inv.record_id),
    claim: 'callback double payout',
    decision_requested: 'disposition of the callback double-payout claim',
    challenger_position: 'Challenger: the guard covers withdraw;‮ the PoC pranks no privileged role.',
    author_position: 'Author: the nested call reverts at the guard.',
    proposed_disposition: { value: 'rejected', rationale: draft },
  }).packet;
  return { eid, inv: head(h, eid, inv.record_id), packet, guardEvidence, positiveControl, draft };
}

/** Engagement with a flow, captured inputs and three proposed interpretations. */
export function proposedInterpretations(h: Harness, eid: string): { unit: Ref; caps: Ref[]; items: Ref[] } {
  h.auditor.do(eid, 'create_engagement', { name: 'Interp', owner: 'auditor', audit_purpose: 'test' });
  const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'deposit' } }).audit_unit;
  const c1 = h.capture.do(eid, 'capture_input', { text: 'Fee-on-transfer​ tokens are unsupported \x1b[31mred\x1b[0m.' }).captured_input;
  const c2 = h.capture.do(eid, 'capture_input', { text: 'Deposits of zero must revert.' }).captured_input;
  const mk = (cap: Ref, statement: string) =>
    h.auditor.do(eid, 'submit_proposal', {
      kind: 'interpretation',
      body: { captured_inputs: [cap], proposed: { kind: 'intent', affiliation: 'designed', statement, audit_units: [unit] } },
    }).interpretation as Ref;
  const items = [mk(c1, 'fee-on-transfer tokens unsupported'), mk(c2, 'deposit(0) reverts'), mk(c2, 'deposits are never zero')];
  return { unit, caps: [c1, c2], items };
}
