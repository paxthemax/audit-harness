import { isArtifactRef, isUnknown, refKey, type AnyRef, type Ref } from '../core/refs.ts';
import type { ProofStatus, RecordEnvelope } from '../schema/records.ts';

// Plain-text rendering of records for the trusted decision screen. Output is a list of lines that the
// caller writes through `show()`, which makes deceptive characters visible. Status is always textual
// and separated by dimension (design/harness-state-and-execution.md, "State transitions": work state,
// disposition, evidence quality and freshness are separate fields); there is no combined "verified"
// label anywhere on the screen.

export function refText(r: AnyRef | null | undefined): string {
  if (!r) return '(none)';
  return isArtifactRef(r) ? `artifact ${r.artifact}` : refKey(r);
}

export function valueText(v: unknown): string {
  if (v === null || v === undefined) return '(none)';
  if (isUnknown(v)) return `unknown (${v.reason})`;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function triState(v: boolean | null): string {
  return v === null ? 'unknown' : v ? 'yes' : 'no';
}

/** Proof status fields, each named, never collapsed into one verdict. */
export function proofLines(p: ProofStatus, indent = '  '): string[] {
  return [
    `${indent}Provenance: ${p.provenance}`,
    `${indent}Prerequisite review: ${p.prerequisite_review}`,
    `${indent}Adequacy: ${p.adequacy}${p.adequacy_reason ? ` (reason: ${p.adequacy_reason})` : ''}`,
    `${indent}Replay: ${p.replay}`,
    `${indent}Positive control: ${p.positive_control}`,
  ];
}

export function header(env: RecordEnvelope): string {
  return `${env.type} ${env.record_id}@${env.revision}  [created ${env.created_at} by ${env.created_by.channel}:${env.created_by.principal}]`;
}

/** A compact, type-aware summary of a record. Unknown types fall back to their JSON body. */
export function recordLines(env: RecordEnvelope, indent = '  '): string[] {
  const out = [header(env)];
  const add = (label: string, v: unknown) => out.push(`${indent}${label}: ${valueText(v)}`);
  const b = env.body as any;
  switch (env.type) {
    case 'evidence_artifact':
      add('Producer', b.producer);
      add('Description', b.description || '(no description)');
      add('Eligible as evidence', b.eligible ? 'yes' : 'no');
      add('Result type', b.structured_result?.result_type ?? 'none recorded');
      if (b.structured_result?.interpretation) add('Runner interpretation (mechanical)', b.structured_result.interpretation);
      if (b.receipt) add('Command', b.receipt.argv.join(' '));
      if (b.receipt) add('Exit', `${valueText(b.receipt.exit_code)}${b.receipt.signal ? ` signal ${b.receipt.signal}` : ''}${b.receipt.timed_out ? ' (timed out)' : ''}`);
      add('Content', refText(b.content));
      if (b.missing_or_truncated?.length) add('Missing or truncated', b.missing_or_truncated.join('; '));
      if (b.limitations?.length) add('Limitations', b.limitations.join('; '));
      break;
    case 'attempt':
      add('Job', refText(b.job));
      add('Attempt number', b.attempt_no);
      add('Execution status', b.status);
      add('Reason', b.reason);
      add('Receipt', refText(b.receipt));
      add('Termination', b.termination);
      break;
    case 'scenario_variant':
      add('Outcome', b.outcome ?? 'no outcome recorded');
      add('Linked guarantee', b.linked_guarantee ?? '(parent guarantee)');
      add('Causal sequence', '');
      b.causal_sequence.forEach((s: string, i: number) => out.push(`${indent}  ${i + 1}. ${s}`));
      add('Setup powers declared by the agent', b.setup_powers.length ? b.setup_powers.join('; ') : '(none declared)');
      add('Change classification (agent-classified, Q-014)', `${b.change_classification} by ${b.classified_by}`);
      add('Challenger review of the classification', `${b.challenger_review.status}${b.challenger_review.note ? ` — ${b.challenger_review.note}` : ''}`);
      add('Expected violation', b.expected_violation);
      add('Defeating condition', b.defeating_condition);
      if (b.countercondition) add('Countercondition', b.countercondition.text);
      break;
    case 'system_statement':
      add('Statement', b.statement);
      add('Kind / affiliation / origin', `${b.kind} / ${b.affiliation} / ${b.origin}`);
      add('Review status', b.review_status);
      add('Intent timing', b.intent_timing ?? '(not intent)');
      add('Applicability', b.applicability);
      for (const a of b.anchors ?? []) out.push(`${indent}Anchor: ${a.path}${a.symbol ? ` ${a.symbol}` : ''}${a.start !== null ? ` bytes ${a.start}+${a.length}` : ''}`);
      break;
    case 'captured_input':
      add('Captured at', b.captured_at);
      add('Channel', `${b.channel.name} (${b.channel.program_digest})`);
      add('Purpose', b.purpose);
      add('Content digest', b.content_digest);
      out.push(`${indent}Text (verbatim):`);
      for (const l of String(b.text).split('\n')) out.push(`${indent}| ${l}`);
      break;
    case 'clarification':
      add('Issue', b.issue);
      add('Status', b.status);
      add('Answer source', b.answer_source);
      add('Priority', b.priority);
      b.options.forEach((o: any, i: number) => out.push(`${indent}Option ${i + 1}: ${o.option} — consequence: ${o.consequence}`));
      add('Recommendation', b.recommendation ?? '(none)');
      add('Next action', b.next_action);
      break;
    case 'investigation':
      add('Question', b.question);
      add('Method', b.method);
      add('Lead generator', b.lead_generator);
      add('Guarantees', b.guarantees.join('; ') || '(none)');
      add('Prerequisites', b.prerequisites.join('; ') || '(none)');
      add('Work state', b.work_state + (b.blocked_reason ? ` (blocked: ${b.blocked_reason})` : ''));
      add('Disposition', b.disposition ? `${b.disposition.value} by ${refText(b.disposition.decision)}` : 'none');
      add('Potential impact (effective)', `${b.potential_impact.effective} [agent ${valueText(b.potential_impact.agent)}, auditor ${valueText(b.potential_impact.auditor)}]`);
      break;
    case 'audit_unit':
      add('Name', b.name);
      add('Kind', b.kind);
      add('Review status', b.review_status);
      add('Risk rationale', b.risk_rationale);
      add('Gaps', b.gaps.join('; ') || '(none)');
      break;
    case 'conclusion_freshness':
      add('Conclusion', refText(b.conclusion));
      add('Freshness', b.value);
      add('Snapshots', `${refText(b.prior_snapshot)} -> ${refText(b.snapshot)}`);
      for (const p of b.probes) out.push(`${indent}Probe ${refText(p.probe)}: ${p.status}`);
      if (b.unobserved.length) add('Probes cannot observe', b.unobserved.join('; '));
      break;
    default:
      for (const l of JSON.stringify(b, null, 2).split('\n')) out.push(indent + l);
  }
  return out;
}

/** Full record JSON for the pager (one step away from the decision). */
export function fullRecordLines(env: RecordEnvelope): string[] {
  return JSON.stringify(env, null, 2).split('\n');
}
