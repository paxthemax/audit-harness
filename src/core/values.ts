// Allowed values from the design lab glossary (design/harness-glossary.md, "Value tables").
// Every document and record uses these exact strings.

export const WORK_STATES = ['proposed', 'queued', 'running', 'blocked', 'ready_for_review', 'closed'] as const;
export const EXECUTION_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'outcome_unknown'] as const;
export const DISPOSITIONS = [
  'accepted',
  'rejected',
  'no_finding_within_bounds',
  'triaged_out',
  'disputed',
  'deferred',
] as const;
export const FRESHNESS = [
  'current',
  'carried_forward_mechanical',
  'possibly_affected',
  'affected',
  'reaffirmed_by_human',
] as const;
export const VARIANT_OUTCOMES = ['supports', 'refuted', 'inconclusive', 'blocked', 'stress_assumption', 'abandoned'] as const;
export const POTENTIAL_IMPACTS = ['critical', 'high', 'medium', 'low', 'info', 'unknown'] as const;
export const EVIDENCE_ROUTES = ['executable_replay', 'alternative_argument', 'code_argument'] as const;
export const POSITIVE_CONTROL = ['not_required', 'pending', 'shows_violation', 'no_violation', 'unavailable'] as const;
export const REPLAY = ['not_required', 'pending', 'succeeded', 'failed', 'unavailable'] as const;
export const PROVENANCE = ['complete', 'incomplete'] as const;
export const PREREQUISITE_REVIEW = ['pending', 'accepted', 'disputed'] as const;
export const ADEQUACY = ['pending', 'sufficient', 'insufficient', 'not_applicable'] as const;
export const TOOL_RESULT_TYPES = [
  'counterexample',
  'no_violation_observed',
  'proved_in_model',
  'inconclusive',
  'unsupported',
  'error',
] as const;
export const COMPARISON_COVERAGE = ['missing_design', 'unexamined_implementation', 'partial', 'examined'] as const;
export const COMPARISON_RESULT = ['undetermined', 'discrepancy', 'no_discrepancy_observed'] as const;
export const FIX_ATTACK_STATUS = ['blocked', 'partly_blocked', 'not_blocked', 'not_assessed'] as const;
export const FIX_LEGIT_STATUS = ['preserved', 'regressed', 'not_assessed'] as const;
export const FIX_LABELS = [
  'fixed',
  'attack_blocked_only',
  'partly_fixed',
  'regressive',
  'not_fixed',
  'acknowledged',
  'not_assessed',
] as const;
export const CLIENT_RESPONSES = ['fixed', 'partially_fixed', 'acknowledged', 'disputed', 'no_response'] as const;
export const RATIONALE_AUTHORSHIP = ['human_written', 'agent_drafted_edited', 'agent_drafted_unedited'] as const;
export const STATEMENT_ORIGINS = [
  'documented_claim',
  'auditor_clarification',
  'auditee_statement',
  'inferred_candidate',
  'adopted_assumption',
  'source_analysis',
  'execution_observation',
] as const;
export const STATEMENT_KINDS = ['intent', 'observed_implementation', 'assumption', 'guarantee', 'unknown'] as const;
export const MODEL_AFFILIATIONS = ['designed', 'implemented', 'shared'] as const;
export const WORK_AUTHORIZATION_KINDS = ['intake', 'exploration', 'batch', 'revalidation', 'method_evaluation'] as const;
export const AUDIT_UNIT_KINDS = [
  'flow',
  'guarantee',
  'boundary',
  'component',
  'composition',
  'system_invariant',
  'upgrade_and_storage_layout',
] as const;
export const AUDIT_UNIT_REVIEW_STATUS = ['not_started', 'partial', 'reviewed', 'excluded'] as const;
export const PROBE_KINDS = [
  'code_hash',
  'structural_query',
  'storage_layout',
  'config_value',
  'witness_rerun',
  'property_rerun',
] as const;
export const INTENT_TIMING = ['before_walkthrough', 'after_walkthrough'] as const;
export const LIBRARY_ENTRY_SOURCES = ['public_reference', 'transfer'] as const;
export const INVESTIGATION_METHODS = ['hypothesis', 'property', 'scenario'] as const;
export const LEAD_GENERATORS = [
  'designed_implemented_discrepancy',
  'applicable_standard',
  'attack_vector_sweep',
  'upstream_diff',
  'project_test_suite',
  'baseline_control',
  'mechanism_library',
  'manual',
  'tool_signal',
  'coverage_gap',
] as const;

// Statement review state is not a glossary table; it records whether a human decision
// turned a provisional statement into reviewed semantics.
export const STATEMENT_REVIEW_STATUS = ['provisional', 'reviewed', 'rejected', 'superseded'] as const;

export const DECISION_KINDS = [
  'accept_scope_and_policy',
  'answer_clarification',
  'confirm_interpretations',
  'approve_semantics',
  'record_flow_review',
  'dispose_investigation',
  'attest_carry_forward',
  'reaffirm',
  'assess_fix',
  'close_engagement',
  'record_transfer',
  'adopt_method_version',
  'choose_import_destination',
  'retention_action',
  // These three keep their own operations but are recorded as human decisions too.
  'authorize_work',
  'revise_premise',
  'approve_export',
] as const;

export type WorkState = (typeof WORK_STATES)[number];
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export type Disposition = (typeof DISPOSITIONS)[number];
export type Freshness = (typeof FRESHNESS)[number];
export type VariantOutcome = (typeof VARIANT_OUTCOMES)[number];
export type PotentialImpact = (typeof POTENTIAL_IMPACTS)[number];
export type EvidenceRoute = (typeof EVIDENCE_ROUTES)[number];
export type PositiveControl = (typeof POSITIVE_CONTROL)[number];
export type Replay = (typeof REPLAY)[number];
export type ToolResultType = (typeof TOOL_RESULT_TYPES)[number];
export type FixAttackStatus = (typeof FIX_ATTACK_STATUS)[number];
export type FixLegitStatus = (typeof FIX_LEGIT_STATUS)[number];
export type FixLabel = (typeof FIX_LABELS)[number];
export type ClientResponse = (typeof CLIENT_RESPONSES)[number];
export type RationaleAuthorship = (typeof RATIONALE_AUTHORSHIP)[number];
export type StatementOrigin = (typeof STATEMENT_ORIGINS)[number];
export type StatementKind = (typeof STATEMENT_KINDS)[number];
export type ModelAffiliation = (typeof MODEL_AFFILIATIONS)[number];
export type WorkAuthorizationKind = (typeof WORK_AUTHORIZATION_KINDS)[number];
export type AuditUnitKind = (typeof AUDIT_UNIT_KINDS)[number];
export type AuditUnitReviewStatus = (typeof AUDIT_UNIT_REVIEW_STATUS)[number];
export type ProbeKind = (typeof PROBE_KINDS)[number];
export type IntentTiming = (typeof INTENT_TIMING)[number];
export type DecisionKind = (typeof DECISION_KINDS)[number];
export type InvestigationMethod = (typeof INVESTIGATION_METHODS)[number];

/** Ordering used for "the higher of" comparisons; `unknown` counts as `high` (glossary). */
const IMPACT_RANK: Record<PotentialImpact, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  unknown: 3,
  critical: 4,
};

export function impactRank(i: PotentialImpact): number {
  return IMPACT_RANK[i];
}

/** True for potential impact Medium and above (with `unknown` treated as `high`). */
export function isMediumOrAbove(i: PotentialImpact): boolean {
  return impactRank(i) >= IMPACT_RANK.medium;
}

/** True for potential impact High or Critical (with `unknown` treated as `high`). */
export function isHighOrCritical(i: PotentialImpact): boolean {
  return impactRank(i) >= IMPACT_RANK.high;
}

/**
 * Effective potential impact: by default the higher of the agent's and the auditor's
 * estimate. The auditor may go below the agent only with a recorded reason.
 */
export function effectiveImpact(
  agent: PotentialImpact | null,
  auditor: PotentialImpact | null,
  auditorLowerReason: string | null,
): PotentialImpact {
  if (agent === null && auditor === null) return 'unknown';
  if (agent === null) return auditor!;
  if (auditor === null) return agent;
  if (impactRank(auditor) < impactRank(agent) && auditorLowerReason && auditorLowerReason.trim()) return auditor;
  return impactRank(auditor) >= impactRank(agent) ? auditor : agent;
}

/** Derived reported fix label (glossary table). */
export function deriveFixLabel(
  attack: FixAttackStatus | null,
  legit: FixLegitStatus | null,
  clientResponse: ClientResponse | null,
  fixSupplied: boolean,
): FixLabel {
  if (!fixSupplied) return clientResponse === 'acknowledged' ? 'acknowledged' : 'not_assessed';
  if (attack === null || attack === 'not_assessed') return 'not_assessed';
  if (attack === 'not_blocked') return 'not_fixed';
  if (legit === 'regressed') return 'regressive';
  if (attack === 'blocked') return legit === 'preserved' ? 'fixed' : 'attack_blocked_only';
  return 'partly_fixed'; // partly_blocked with preserved or not_assessed
}

export const DEFAULT_ATTACKER_CHARTER = {
  description: 'Broad permissionless EVM adversary (DEC-008, Q-015), narrowed per engagement',
  capabilities: [
    'multiple_accounts_and_attacker_contracts',
    'flash_loan_capital_within_real_liquidity',
    'transaction_ordering_within_block',
    'oracle_update_timing_within_feed_rules',
    'griefing_spend',
    'protocol_permitted_callbacks',
  ],
  privileged_roles_trusted: true,
} as const;

/** Accepted residual risks that every report states as limits (DEC-008 Q-014; DEC-009 Q-021, Q-024). */
export const ACCEPTED_RESIDUAL_RISKS = [
  {
    id: 'Q-014',
    statement:
      'Agents classify their own scenario and fixture changes; only the challenger and the auditor check those classifications. The controller does not compare runs against approved limits.',
  },
  {
    id: 'Q-021',
    statement:
      'Documentation the auditee wrote during the engagement was handled like other documentation and may mirror the code; known issues were assessed only where an investigation covered them; contact with the auditee was not recorded.',
  },
  {
    id: 'Q-024',
    statement:
      'Method changes are adopted on the held-out comparison alone; a change that suppresses a lead class absent from the held-out cases may go undetected.',
  },
] as const;
