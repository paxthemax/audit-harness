// Record contracts from design/harness-state-and-execution.md ("Record contracts").
// Each record type has a JSON Schema (enforced by the store on commit) and a TypeScript body type.
// Values come from the glossary (src/core/values.ts).

import * as V from '../core/values.ts';
import type { AnyRef, ArtifactRef, Ref, UnknownOr } from '../core/refs.ts';
import {
  any,
  arr,
  bool,
  int,
  nullable,
  num,
  obj,
  oneOfValues,
  openObj,
  str,
  text,
  unknownOr,
  type Schema,
} from './jsonschema.ts';

export const SCHEMA_VERSION = 1;
export const CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Shared fragments

export const refSchema: Schema = obj({ record_id: text(), revision: int(1), 'scope?': text() });
export const artifactRefSchema: Schema = obj({ artifact: str({ pattern: '^sha256:[0-9a-f]{64}$' }) });
export const anyRefSchema: Schema = any(refSchema, artifactRefSchema);
const refs = arr(refSchema);
const anyRefs = arr(anyRefSchema);
const strings = arr(str());
const isoTime = str({ pattern: '^\\d{4}-\\d{2}-\\d{2}T' });

/** A source anchor: file + content hash of the cited range; line numbers alone are not identity. */
export interface Anchor {
  path: string;
  /** Contract/function symbol when known, e.g. "Vault.withdraw". */
  symbol: string | null;
  /** Byte range in the snapshot file, from compiler `src` or a search. */
  start: number | null;
  length: number | null;
  /** Digest of the cited bytes. */
  content_digest: string | null;
  snapshot: Ref | null;
}
export const anchorSchema: Schema = obj({
  path: text(),
  symbol: nullable(str()),
  start: nullable(int(0)),
  length: nullable(int(0)),
  content_digest: nullable(str()),
  snapshot: nullable(refSchema),
});

export interface PotentialImpactField {
  agent: V.PotentialImpact | null;
  auditor: V.PotentialImpact | null;
  /** Reason the auditor set a value below the agent's estimate. */
  auditor_lower_reason: string | null;
  effective: V.PotentialImpact;
  set_by: 'agent' | 'auditor' | 'controller_default';
}
const impactValues = oneOfValues(V.POTENTIAL_IMPACTS);
export const potentialImpactSchema: Schema = obj({
  agent: nullable(impactValues),
  auditor: nullable(impactValues),
  auditor_lower_reason: nullable(str()),
  effective: impactValues,
  set_by: oneOfValues(['agent', 'auditor', 'controller_default']),
});

export interface ProofStatus {
  provenance: (typeof V.PROVENANCE)[number];
  prerequisite_review: (typeof V.PREREQUISITE_REVIEW)[number];
  adequacy: (typeof V.ADEQUACY)[number];
  adequacy_reason: string | null;
  replay: V.Replay;
  positive_control: V.PositiveControl;
}
export const proofStatusSchema: Schema = obj({
  provenance: oneOfValues(V.PROVENANCE),
  prerequisite_review: oneOfValues(V.PREREQUISITE_REVIEW),
  adequacy: oneOfValues(V.ADEQUACY),
  adequacy_reason: nullable(str()),
  replay: oneOfValues(V.REPLAY),
  positive_control: oneOfValues(V.POSITIVE_CONTROL),
});

export interface DispositionField {
  value: V.Disposition;
  decision: Ref;
}
const dispositionFieldSchema = obj({ value: oneOfValues(V.DISPOSITIONS), decision: refSchema });

export interface Limits {
  /** Spending ceiling in the engagement's budget unit (e.g. USD); 0 forbids paid calls. */
  spend: number;
  runtime_seconds: number;
  concurrency: number;
  child_tasks: number;
  rounds: number;
  retries: number;
  repairs_per_variant: number;
  output_bytes: number;
  memory_mb: number;
  processes: number;
}
export const limitsSchema: Schema = obj({
  spend: num(0),
  runtime_seconds: num(0),
  concurrency: int(1),
  child_tasks: int(0),
  rounds: int(0),
  retries: int(0),
  repairs_per_variant: int(0),
  output_bytes: int(1),
  memory_mb: int(1),
  processes: int(1),
});

export interface AttackerCharter {
  capabilities: string[];
  excluded: { capability: string; reason: string }[];
  raised_roles: string[];
  privileged_roles_trusted: boolean;
  notes: string | null;
}
export const attackerCharterSchema: Schema = obj({
  capabilities: strings,
  excluded: arr(obj({ capability: text(), reason: text() })),
  raised_roles: strings,
  privileged_roles_trusted: bool(),
  notes: nullable(str()),
});

// ---------------------------------------------------------------------------------------------
// Record bodies

export interface EngagementPolicy {
  scope: string[];
  exclusions: { item: string; reason: string }[];
  attacker_charter: AttackerCharter;
  trusted_role_premise: string;
  data_policy: { live_exploitable_class: string; approved_providers: string[]; data_classes: string[] };
  disclosure_constraints: string[];
  retention: { policy: string; backup: string };
  severity_rubric: string;
  rejection_listing_threshold: V.PotentialImpact;
  budget: { unit: string; total: number };
  evidence_policy: string;
  capacity: { review_queue: number; clarification_queue: number; decisions_per_day: number };
  time_plan: string;
}
export const engagementPolicySchema: Schema = obj({
  scope: arr(text(), 1),
  exclusions: arr(obj({ item: text(), reason: text() })),
  attacker_charter: attackerCharterSchema,
  trusted_role_premise: text(),
  data_policy: obj({ live_exploitable_class: text(), approved_providers: strings, data_classes: strings }),
  disclosure_constraints: strings,
  retention: obj({ policy: text(), backup: text() }),
  severity_rubric: text(),
  rejection_listing_threshold: impactValues,
  budget: obj({ unit: text(), total: num(0) }),
  evidence_policy: text(),
  capacity: obj({ review_queue: int(1), clarification_queue: int(1), decisions_per_day: int(1) }),
  time_plan: text(),
});

export interface EngagementBody {
  name: string;
  owner: string;
  audit_purpose: string;
  ecosystem: { language: 'solidity'; chain: UnknownOr<string>; hardfork: UnknownOr<string> };
  /** Null until an `accept_scope_and_policy` decision. */
  policy: EngagementPolicy | null;
  policy_decision: Ref | null;
  active_snapshot: Ref | null;
  read_first: { started_at: string; ended_at: string | null } | null;
  closure_status: 'open' | 'closed' | 'stopped_incomplete';
  closure_decision: Ref | null;
}
const engagementSchema = obj({
  name: text(),
  owner: text(),
  audit_purpose: text(),
  ecosystem: obj({ language: { const: 'solidity' }, chain: unknownOr(text()), hardfork: unknownOr(text()) }),
  policy: nullable(engagementPolicySchema),
  policy_decision: nullable(refSchema),
  active_snapshot: nullable(refSchema),
  read_first: nullable(obj({ started_at: isoTime, ended_at: nullable(isoTime) })),
  closure_status: oneOfValues(['open', 'closed', 'stopped_incomplete']),
  closure_decision: nullable(refSchema),
});

export interface VendoredDependency {
  path: string;
  upstream: UnknownOr<{ name: string; version: string; source: string }>;
  status: 'modified' | 'unmodified' | 'unknown';
  modified_files: string[];
}
export interface TargetSnapshotBody {
  label: string;
  source: {
    kind: 'git' | 'directory';
    origin_path: string;
    commit: UnknownOr<string>;
    dirty_files: string[];
    untracked_included: string[];
  };
  /** Content-addressed tree manifest: JSON {files: {path: digest}} in the archive. */
  tree: ArtifactRef;
  file_count: number;
  dependencies: { name: string; path: string; remapping: string | null }[];
  vendored: VendoredDependency[];
  compiler: UnknownOr<{ version: string; optimizer: boolean; runs: number | null; evm_version: string; via_ir: boolean }>;
  build: UnknownOr<{ job: Ref; status: V.ExecutionStatus; artifacts: ArtifactRef | null }>;
  /** Deterministic scope inventory derived from compiler artifacts. */
  inventory: ArtifactRef | null;
  storage_layouts: ArtifactRef | null;
  deployment: UnknownOr<{ chain_id: number; addresses: { name: string; address: string; implementation: string | null }[] }>;
  fork: UnknownOr<{ chain_id: number; block_number: number; block_hash: string; provenance: string }>;
  source_only: boolean;
  prior_snapshot: Ref | null;
  diff: Ref | null;
  suspicious_flags: Ref[];
  limitations: string[];
}
const targetSnapshotSchema = obj({
  label: text(),
  source: obj({
    kind: oneOfValues(['git', 'directory']),
    origin_path: text(),
    commit: unknownOr(text()),
    dirty_files: strings,
    untracked_included: strings,
  }),
  tree: artifactRefSchema,
  file_count: int(0),
  dependencies: arr(obj({ name: text(), path: text(), remapping: nullable(str()) })),
  vendored: arr(
    obj({
      path: text(),
      upstream: unknownOr(obj({ name: text(), version: text(), source: text() })),
      status: oneOfValues(['modified', 'unmodified', 'unknown']),
      modified_files: strings,
    }),
  ),
  compiler: unknownOr(
    obj({ version: text(), optimizer: bool(), runs: nullable(int(0)), evm_version: text(), via_ir: bool() }),
  ),
  build: unknownOr(
    obj({ job: refSchema, status: oneOfValues(V.EXECUTION_STATUSES), artifacts: nullable(artifactRefSchema) }),
  ),
  inventory: nullable(artifactRefSchema),
  storage_layouts: nullable(artifactRefSchema),
  deployment: unknownOr(
    obj({
      chain_id: int(0),
      addresses: arr(obj({ name: text(), address: text(), implementation: nullable(str()) })),
    }),
  ),
  fork: unknownOr(obj({ chain_id: int(0), block_number: int(0), block_hash: text(), provenance: text() })),
  source_only: bool(),
  prior_snapshot: nullable(refSchema),
  diff: nullable(refSchema),
  suspicious_flags: refs,
  limitations: strings,
});

export type DiffChangeKind = 'file' | 'function' | 'modifier' | 'inheritance' | 'storage_layout' | 'dependency' | 'compiler';
export interface SnapshotDiffBody {
  prior: Ref;
  next: Ref;
  deployed_comparison: UnknownOr<string>;
  changes: {
    kind: DiffChangeKind;
    item: string;
    change: 'added' | 'removed' | 'modified';
    detail: string | null;
    mapping: { kind: 'fix_assessment' | 'audit_unit' | 'unreviewed_change_gap'; ref: Ref | null };
  }[];
}
const snapshotDiffSchema = obj({
  prior: refSchema,
  next: refSchema,
  deployed_comparison: unknownOr(text()),
  changes: arr(
    obj({
      kind: oneOfValues(['file', 'function', 'modifier', 'inheritance', 'storage_layout', 'dependency', 'compiler']),
      item: text(),
      change: oneOfValues(['added', 'removed', 'modified']),
      detail: nullable(str()),
      mapping: obj({
        kind: oneOfValues(['fix_assessment', 'audit_unit', 'unreviewed_change_gap']),
        ref: nullable(refSchema),
      }),
    }),
  ),
});

export interface SystemStatementBody {
  kind: V.StatementKind;
  affiliation: V.ModelAffiliation;
  origin: V.StatementOrigin;
  statement: string;
  anchors: Anchor[];
  audit_units: Ref[];
  captured_inputs: Ref[];
  confirmation: Ref | null;
  intent_timing: V.IntentTiming | null;
  applicability: string;
  supporting: AnyRef[];
  contradicting: AnyRef[];
  review_status: (typeof V.STATEMENT_REVIEW_STATUS)[number];
  owner: string;
}
const systemStatementSchema = obj({
  kind: oneOfValues(V.STATEMENT_KINDS),
  affiliation: oneOfValues(V.MODEL_AFFILIATIONS),
  origin: oneOfValues(V.STATEMENT_ORIGINS),
  statement: text(),
  anchors: arr(anchorSchema),
  audit_units: refs,
  captured_inputs: refs,
  confirmation: nullable(refSchema),
  intent_timing: nullable(oneOfValues(V.INTENT_TIMING)),
  applicability: text(),
  supporting: anyRefs,
  contradicting: anyRefs,
  review_status: oneOfValues(V.STATEMENT_REVIEW_STATUS),
  owner: text(),
});

export interface BehavioralCorrespondenceBody {
  audit_unit: Ref;
  lens: string;
  designed: Ref[] | null;
  implemented: Ref[] | null;
  missing_side: 'designed' | 'implemented' | null;
  conditions: string[];
  abstraction_limits: string[];
  evidence: AnyRef[];
  review_status: (typeof V.STATEMENT_REVIEW_STATUS)[number];
}
const correspondenceSchema = obj({
  audit_unit: refSchema,
  lens: text(),
  designed: nullable(refs),
  implemented: nullable(refs),
  missing_side: nullable(oneOfValues(['designed', 'implemented'])),
  conditions: strings,
  abstraction_limits: strings,
  evidence: anyRefs,
  review_status: oneOfValues(V.STATEMENT_REVIEW_STATUS),
});

export interface BehavioralComparisonBody {
  correspondences: Ref[];
  examined: string;
  bounds: string;
  coverage: (typeof V.COMPARISON_COVERAGE)[number];
  result: (typeof V.COMPARISON_RESULT)[number];
  supporting: AnyRef[];
  refuting: AnyRef[];
  uncertainty: string;
  /** Intent timings of the auditor intent relied on; `after_walkthrough` is shown as a tag. */
  relied_intent_timing: V.IntentTiming[];
  owner: string;
  next_action: string;
}
const comparisonSchema = obj({
  correspondences: refs,
  examined: text(),
  bounds: text(),
  coverage: oneOfValues(V.COMPARISON_COVERAGE),
  result: oneOfValues(V.COMPARISON_RESULT),
  supporting: anyRefs,
  refuting: anyRefs,
  uncertainty: str(),
  relied_intent_timing: arr(oneOfValues(V.INTENT_TIMING)),
  owner: text(),
  next_action: str(),
});

export interface BehavioralDiscrepancyBody {
  comparison: Ref;
  claims: Ref[];
  deviation: string;
  triggering_conditions: string[];
  evidence: AnyRef[];
  uncertainty: string;
  distinguishing_check: string;
  clarifications: Ref[];
  investigations: Ref[];
  disposition: DispositionField | null;
}
const discrepancySchema = obj({
  comparison: refSchema,
  claims: refs,
  deviation: text(),
  triggering_conditions: strings,
  evidence: anyRefs,
  uncertainty: str(),
  distinguishing_check: str(),
  clarifications: refs,
  investigations: refs,
  disposition: nullable(dispositionFieldSchema),
});

export interface AuditUnitBody {
  kind: V.AuditUnitKind;
  name: string;
  entry_points: string[];
  state_writers: string[];
  dependencies: string[];
  risk_rationale: string;
  planned_methods: V.InvestigationMethod[];
  lead_generator_coverage: { generator: string; status: 'ran' | 'not_run' | 'not_applicable'; note: string | null }[];
  /** In-scope functions ("Contract.fn") mapped to this unit, with whether the auditor reviewed them. */
  functions: { name: string; reviewed: boolean }[];
  reviewed_revision: { snapshot: Ref; decision: Ref } | null;
  review_status: V.AuditUnitReviewStatus;
  /** Always null in stored records: derived from display receipts by `firstPresentation()`. */
  first_presentation: { at: string; receipt: Ref } | null;
  evidence: AnyRef[];
  gaps: string[];
}
const auditUnitSchema = obj({
  kind: oneOfValues(V.AUDIT_UNIT_KINDS),
  name: text(),
  entry_points: strings,
  state_writers: strings,
  dependencies: strings,
  risk_rationale: str(),
  planned_methods: arr(oneOfValues(V.INVESTIGATION_METHODS)),
  lead_generator_coverage: arr(
    obj({ generator: text(), status: oneOfValues(['ran', 'not_run', 'not_applicable']), note: nullable(str()) }),
  ),
  functions: arr(obj({ name: text(), reviewed: bool() })),
  reviewed_revision: nullable(obj({ snapshot: refSchema, decision: refSchema })),
  review_status: oneOfValues(V.AUDIT_UNIT_REVIEW_STATUS),
  first_presentation: nullable(obj({ at: isoTime, receipt: refSchema })),
  evidence: anyRefs,
  gaps: strings,
});

export interface ClarificationBody {
  issue: string;
  conflicting_facts: AnyRef[];
  answer_source: 'auditor' | 'client';
  options: { option: string; consequence: string }[];
  recommendation: string | null;
  owner: string;
  blocks: Ref[];
  priority: number;
  coalesced: Ref[];
  /** Coalescing key: duplicates share a key and are merged. */
  dedupe_key: string;
  status: 'queued' | 'held' | 'presented' | 'answered' | 'coalesced' | 'withdrawn';
  answer: { decision: Ref; value: string } | null;
  next_action: string;
}
const clarificationSchema = obj({
  issue: text(),
  conflicting_facts: anyRefs,
  answer_source: oneOfValues(['auditor', 'client']),
  options: arr(obj({ option: text(), consequence: text() })),
  recommendation: nullable(str()),
  owner: text(),
  blocks: refs,
  priority: int(0),
  coalesced: refs,
  dedupe_key: text(),
  status: oneOfValues(['queued', 'held', 'presented', 'answered', 'coalesced', 'withdrawn']),
  answer: nullable(obj({ decision: refSchema, value: text() })),
  next_action: str(),
});

export interface WorkAuthorizationBody {
  kind: V.WorkAuthorizationKind;
  decision: Ref;
  reviewed: Ref[];
  snapshot: Ref | null;
  investigations: Ref[];
  methods: V.InvestigationMethod[];
  attacker_charter: AttackerCharter | null;
  capabilities: { tools: string[]; providers: string[]; network: 'denied' | 'rpc_gateway' };
  limits: Limits;
  validity: { from: string; until: string } | null;
  interrupt_conditions: string[];
  status: 'active' | 'expired' | 'cancelled' | 'exhausted' | 'completed';
}
const workAuthorizationSchema = obj({
  kind: oneOfValues(V.WORK_AUTHORIZATION_KINDS),
  decision: refSchema,
  reviewed: refs,
  snapshot: nullable(refSchema),
  investigations: refs,
  methods: arr(oneOfValues(V.INVESTIGATION_METHODS)),
  attacker_charter: nullable(attackerCharterSchema),
  capabilities: obj({ tools: strings, providers: strings, network: oneOfValues(['denied', 'rpc_gateway']) }),
  limits: limitsSchema,
  validity: nullable(obj({ from: isoTime, until: isoTime })),
  interrupt_conditions: strings,
  status: oneOfValues(['active', 'expired', 'cancelled', 'exhausted', 'completed']),
});

export interface LinkedClaim {
  id: string;
  guarantee: string;
  /** Flow audit unit the linked guarantee lives in, when known. */
  flow: Ref | null;
  claim: string;
  variants: Ref[];
  potential_impact: PotentialImpactField;
  disposition: DispositionField | null;
  proof_status: ProofStatus;
  /** Derived by the controller: false when the flow has no `record_flow_review` decision. */
  flow_reviewed: boolean;
}
const linkedClaimSchema = obj({
  id: text(),
  guarantee: text(),
  flow: nullable(refSchema),
  claim: text(),
  variants: refs,
  potential_impact: potentialImpactSchema,
  disposition: nullable(dispositionFieldSchema),
  proof_status: proofStatusSchema,
  flow_reviewed: bool(),
});

export interface InvestigationBody {
  method: V.InvestigationMethod;
  question: string;
  executable: boolean;
  origin: 'agent' | 'auditor';
  lead_generator: string;
  audit_units: Ref[];
  guarantees: string[];
  attacker_capabilities: string[];
  prerequisites: string[];
  anchors: Anchor[];
  potential_impact: PotentialImpactField;
  supporting: AnyRef[];
  refuting: AnyRef[];
  variants: Ref[];
  linked_claims: LinkedClaim[];
  next_check: string | null;
  jobs: Ref[];
  authorization: Ref | null;
  work_state: V.WorkState;
  blocked_reason: string | null;
  disposition: DispositionField | null;
  proof_status: ProofStatus;
  probes: Ref[];
  lineage: Ref | null;
}
const investigationSchema = obj({
  method: oneOfValues(V.INVESTIGATION_METHODS),
  question: text(),
  executable: bool(),
  origin: oneOfValues(['agent', 'auditor']),
  lead_generator: text(),
  audit_units: refs,
  guarantees: strings,
  attacker_capabilities: strings,
  prerequisites: strings,
  anchors: arr(anchorSchema),
  potential_impact: potentialImpactSchema,
  supporting: anyRefs,
  refuting: anyRefs,
  variants: refs,
  linked_claims: arr(linkedClaimSchema),
  next_check: nullable(str()),
  jobs: refs,
  authorization: nullable(refSchema),
  work_state: oneOfValues(V.WORK_STATES),
  blocked_reason: nullable(str()),
  disposition: nullable(dispositionFieldSchema),
  proof_status: proofStatusSchema,
  probes: refs,
  lineage: nullable(refSchema),
});

export interface ScenarioVariantBody {
  investigation: Ref;
  previous: Ref | null;
  linked_guarantee: string | null;
  linked_claim_id: string | null;
  causal_sequence: string[];
  setup_powers: string[];
  /** Agent self-classification of the change from the previous variant (accepted residual risk Q-014). */
  change_classification: 'initial' | 'syntactic' | 'semantic';
  classified_by: string;
  challenger_review: { status: 'pending' | 'accepted' | 'disputed'; note: string | null };
  expected_violation: string;
  defeating_condition: string;
  jobs: Ref[];
  outcome: V.VariantOutcome | null;
  countercondition: { text: string; evidence: AnyRef[] } | null;
  probes: Ref[];
}
const variantSchema = obj({
  investigation: refSchema,
  previous: nullable(refSchema),
  linked_guarantee: nullable(str()),
  linked_claim_id: nullable(str()),
  causal_sequence: arr(text(), 1),
  setup_powers: strings,
  change_classification: oneOfValues(['initial', 'syntactic', 'semantic']),
  classified_by: text(),
  challenger_review: obj({ status: oneOfValues(['pending', 'accepted', 'disputed']), note: nullable(str()) }),
  expected_violation: text(),
  defeating_condition: text(),
  jobs: refs,
  outcome: nullable(oneOfValues(V.VARIANT_OUTCOMES)),
  countercondition: nullable(obj({ text: text(), evidence: anyRefs })),
  probes: refs,
});

export interface PropertyBody {
  investigation: Ref | null;
  intended_behavior: Ref[];
  actors: string[];
  actions: string[];
  units_and_bounds: string;
  environment_assumptions: string[];
  check_oracle: string;
  excluded_actions: { action: string; reason: string }[];
  fixture: ArtifactRef | null;
  semantic_review: { decision: Ref | null; status: 'pending' | 'approved' | 'stale' };
  adequacy: { status: (typeof V.ADEQUACY)[number]; reason: string | null; evidence: AnyRef[] };
}
const propertySchema = obj({
  investigation: nullable(refSchema),
  intended_behavior: refs,
  actors: strings,
  actions: strings,
  units_and_bounds: str(),
  environment_assumptions: strings,
  check_oracle: text(),
  excluded_actions: arr(obj({ action: text(), reason: text() })),
  fixture: nullable(artifactRefSchema),
  semantic_review: obj({ decision: nullable(refSchema), status: oneOfValues(['pending', 'approved', 'stale']) }),
  adequacy: obj({ status: oneOfValues(V.ADEQUACY), reason: nullable(str()), evidence: anyRefs }),
});

export type JobPurpose =
  | 'build'
  | 'baseline_tests'
  | 'inventory'
  | 'experiment'
  | 'replay'
  | 'positive_control'
  | 'adequacy'
  | 'probe'
  | 'agent';
export interface JobBody {
  authorization: Ref;
  context_manifest: ArtifactRef | null;
  role: string;
  purpose: JobPurpose;
  adapter: { name: string; version: string; descriptor: string };
  operation: string;
  /** Structured arguments; never a shell string. */
  args: Record<string, unknown>;
  snapshot: Ref;
  /** Fixture overlay (tree manifest artifact) applied to a scratch copy; target stays read-only. */
  fixture: ArtifactRef | null;
  input_digest: string;
  investigation: Ref | null;
  variant: Ref | null;
  limits: Limits;
  reservation: { spend: number; runtime_seconds: number };
  lineage: Ref | null;
  /** For a positive control: the cited guard removed from a disposable copy (path + exact bytes). */
  guard_removal: { path: string; find: string; replace: string } | null;
  status: V.ExecutionStatus;
  attempts: Ref[];
}
const jobSchema = obj({
  authorization: refSchema,
  context_manifest: nullable(artifactRefSchema),
  role: text(),
  purpose: oneOfValues(['build', 'baseline_tests', 'inventory', 'experiment', 'replay', 'positive_control', 'adequacy', 'probe', 'agent']),
  adapter: obj({ name: text(), version: text(), descriptor: text() }),
  operation: text(),
  args: openObj('adapter-specific structured arguments'),
  snapshot: refSchema,
  fixture: nullable(artifactRefSchema),
  input_digest: text(),
  investigation: nullable(refSchema),
  variant: nullable(refSchema),
  limits: limitsSchema,
  reservation: obj({ spend: num(0), runtime_seconds: num(0) }),
  lineage: nullable(refSchema),
  guard_removal: nullable(obj({ path: text(), find: text(), replace: str() })),
  status: oneOfValues(V.EXECUTION_STATUSES),
  attempts: refs,
});

export interface AttemptBody {
  job: Ref;
  attempt_no: number;
  status: V.ExecutionStatus;
  started_at: string | null;
  ended_at: string | null;
  pid: number | null;
  reason: string | null;
  receipt: Ref | null;
  actual: { spend: number | null; runtime_seconds: number | null; spend_uncertain: boolean };
  termination: 'not_applicable' | 'confirmed' | 'unconfirmed';
  /** Worker grant for this attempt: only the token's digest is stored. */
  grant: { digest: string; operations: string[]; expires_at: string; revoked: boolean } | null;
}
const attemptSchema = obj({
  job: refSchema,
  attempt_no: int(1),
  status: oneOfValues(V.EXECUTION_STATUSES),
  started_at: nullable(isoTime),
  ended_at: nullable(isoTime),
  pid: nullable(int(0)),
  reason: nullable(str()),
  receipt: nullable(refSchema),
  actual: obj({ spend: nullable(num(0)), runtime_seconds: nullable(num(0)), spend_uncertain: bool() }),
  termination: oneOfValues(['not_applicable', 'confirmed', 'unconfirmed']),
  grant: nullable(obj({ digest: text(), operations: strings, expires_at: isoTime, revoked: bool() })),
});

export interface ExecutionReceipt {
  runner: { identity: string; version: string };
  sandbox: { kind: string; network: 'denied' | 'rpc_gateway'; descriptor: string };
  argv: string[];
  cwd: string;
  executable: { path: string; digest: string | null; version: string | null };
  env_keys: string[];
  started_at: string;
  ended_at: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  stdout: ArtifactRef;
  stderr: ArtifactRef;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  outputs: { path: string; artifact: ArtifactRef }[];
}
const receiptSchema = obj({
  runner: obj({ identity: text(), version: text() }),
  sandbox: obj({ kind: text(), network: oneOfValues(['denied', 'rpc_gateway']), descriptor: str() }),
  argv: arr(str(), 1),
  cwd: str(),
  executable: obj({ path: text(), digest: nullable(str()), version: nullable(str()) }),
  env_keys: strings,
  started_at: isoTime,
  ended_at: isoTime,
  exit_code: nullable(int()),
  signal: nullable(str()),
  timed_out: bool(),
  stdout: artifactRefSchema,
  stderr: artifactRefSchema,
  stdout_truncated: bool(),
  stderr_truncated: bool(),
  outputs: arr(obj({ path: text(), artifact: artifactRefSchema })),
});

export interface StructuredResult {
  result_type: V.ToolResultType;
  mode: string;
  bounds: string | null;
  /** The runner's mechanical interpretation (e.g. which test asserted what); not semantic truth. */
  interpretation: string;
  tests: { name: string; status: 'passed' | 'failed' | 'skipped'; reason: string | null; expect: 'violation' | 'no_violation' | null }[];
  /** Property campaigns (fuzz/invariant): actions attempted and reverted, and the counterexample sequence. */
  campaign?: { runs: number; calls: number; reverts: number; counterexample: string[] | null; all_actions_reverted: boolean; never_succeeded?: string[] } | null;
}
const structuredResultSchema = obj({
  result_type: oneOfValues(V.TOOL_RESULT_TYPES),
  mode: text(),
  bounds: nullable(str()),
  interpretation: str(),
  tests: arr(
    obj({
      name: text(),
      status: oneOfValues(['passed', 'failed', 'skipped']),
      reason: nullable(str()),
      expect: nullable(oneOfValues(['violation', 'no_violation'])),
    }),
  ),
  'campaign?': nullable(
    obj({ runs: int(0), calls: int(0), reverts: int(0), counterexample: nullable(strings), all_actions_reverted: bool(), 'never_succeeded?': strings }),
  ),
});

export interface EvidenceArtifactBody {
  /** The primary content hash (e.g. the packaged result bundle). */
  content: ArtifactRef;
  producer: 'trusted_runner' | 'auditor_run_untrusted' | 'worker_interpretation' | 'auditor_note';
  job: Ref | null;
  attempt: Ref | null;
  receipt: ExecutionReceipt | null;
  snapshot: Ref | null;
  fixture: ArtifactRef | null;
  structured_result: StructuredResult | null;
  environment_sensitive: { flagged: boolean; reads: string[] };
  positive_control_for: Ref | null;
  missing_or_truncated: string[];
  limitations: string[];
  eligible: boolean;
  description: string;
}
const evidenceSchema = obj({
  content: artifactRefSchema,
  producer: oneOfValues(['trusted_runner', 'auditor_run_untrusted', 'worker_interpretation', 'auditor_note']),
  job: nullable(refSchema),
  attempt: nullable(refSchema),
  receipt: nullable(receiptSchema),
  snapshot: nullable(refSchema),
  fixture: nullable(artifactRefSchema),
  structured_result: nullable(structuredResultSchema),
  environment_sensitive: obj({ flagged: bool(), reads: strings }),
  positive_control_for: nullable(refSchema),
  missing_or_truncated: strings,
  limitations: strings,
  eligible: bool(),
  description: str(),
});

export interface DependencyProbeBody {
  kind: V.ProbeKind;
  /** Kind-specific query: {path, symbol} for code_hash; {pattern, paths} for structural_query; etc. */
  query: Record<string, unknown>;
  snapshot: Ref;
  status: 'evaluated' | 'unevaluable' | 'pending';
  result_digest: string | null;
  result_summary: string | null;
  cannot_observe: string[];
  conclusion: Ref | null;
  job: Ref | null;
  /** Evaluation the conclusion was established (or last reaffirmed) against; freshness compares to it. */
  baseline?: { snapshot: Ref; digest: string | null };
  /** Set when a newer probe replaces this one; a superseded probe no longer decides freshness. */
  superseded_by?: Ref | null;
}
const probeSchema = obj({
  kind: oneOfValues(V.PROBE_KINDS),
  query: openObj(),
  snapshot: refSchema,
  status: oneOfValues(['evaluated', 'unevaluable', 'pending']),
  result_digest: nullable(str()),
  result_summary: nullable(str()),
  cannot_observe: strings,
  conclusion: nullable(refSchema),
  job: nullable(refSchema),
  'baseline?': obj({ snapshot: refSchema, digest: nullable(str()) }),
  'superseded_by?': nullable(refSchema),
});

export interface CapturedInputBody {
  text: string;
  content_digest: string;
  channel: { name: string; program_digest: string };
  session: string;
  captured_at: string;
  purpose: 'conversation' | 'expectations_pre_step' | 'clarification_answer' | 'note';
  audit_unit: Ref | null;
}
const capturedInputSchema = obj({
  text: str(),
  content_digest: text(),
  channel: obj({ name: text(), program_digest: text() }),
  session: text(),
  captured_at: isoTime,
  purpose: oneOfValues(['conversation', 'expectations_pre_step', 'clarification_answer', 'note']),
  audit_unit: nullable(refSchema),
});

export interface ReviewPacketBody {
  investigation: Ref;
  potential_impact: V.PotentialImpact;
  claim: string;
  decision_requested: string;
  supporting: AnyRef[];
  refuting: AnyRef[];
  failed_attempts: Ref[];
  variants: { variant: Ref; outcome: V.VariantOutcome | null; linked_guarantee: string | null }[];
  linked_claims: { id: string; guarantee: string; potential_impact: V.PotentialImpact; unreviewed_flow: boolean }[];
  challenge_required: boolean;
  challenger_position: ArtifactRef | null;
  author_position: ArtifactRef | null;
  challenge_independence: { same_model: boolean | null; same_provider: boolean | null; shared_premises: string[]; context: string };
  unreviewed_statements: Ref[];
  evidence_quality: ProofStatus;
  replay_receipt: Ref | null;
  executable_confirmation_requested: boolean;
  proposed_disposition: { value: V.Disposition; rationale: string; authorship: V.RationaleAuthorship } | null;
  next_check: string | null;
  missing_information: string[];
  /** Controller-computed at packet build time. */
  inbound_link_digest: string;
  evidence_watermark: number;
  dependency_digest: string;
  /** Target files that experiment fixtures override (fixtures never alter the target invisibly). */
  fixture_overrides?: { job: Ref; paths: string[] }[];
}
const packetSchema = obj({
  investigation: refSchema,
  potential_impact: impactValues,
  claim: text(),
  decision_requested: text(),
  supporting: anyRefs,
  refuting: anyRefs,
  failed_attempts: refs,
  variants: arr(
    obj({ variant: refSchema, outcome: nullable(oneOfValues(V.VARIANT_OUTCOMES)), linked_guarantee: nullable(str()) }),
  ),
  linked_claims: arr(obj({ id: text(), guarantee: text(), potential_impact: impactValues, unreviewed_flow: bool() })),
  challenge_required: bool(),
  challenger_position: nullable(artifactRefSchema),
  author_position: nullable(artifactRefSchema),
  challenge_independence: obj({
    same_model: nullable(bool()),
    same_provider: nullable(bool()),
    shared_premises: strings,
    context: str(),
  }),
  unreviewed_statements: refs,
  evidence_quality: proofStatusSchema,
  replay_receipt: nullable(refSchema),
  executable_confirmation_requested: bool(),
  proposed_disposition: nullable(
    obj({ value: oneOfValues(V.DISPOSITIONS), rationale: text(), authorship: oneOfValues(V.RATIONALE_AUTHORSHIP) }),
  ),
  next_check: nullable(str()),
  missing_information: strings,
  inbound_link_digest: text(),
  evidence_watermark: int(0),
  dependency_digest: text(),
  'fixture_overrides?': arr(obj({ job: refSchema, paths: strings })),
});

export interface DisplayReceiptBody {
  screen: { identity: string; session: string };
  rendered: Ref[];
  sections: { section: string; opened_at: string }[];
  started_at: string;
  ended_at: string;
  /** Presentations of IMPLEMENTED behavior per audit unit (drives intent timing). */
  implemented_presented_for: Ref[];
}
const displayReceiptSchema = obj({
  screen: obj({ identity: text(), session: text() }),
  rendered: refs,
  sections: arr(obj({ section: text(), opened_at: isoTime })),
  started_at: isoTime,
  ended_at: isoTime,
  implemented_presented_for: refs,
});

export interface HumanDecisionBody {
  kind: V.DecisionKind;
  actor: string;
  reviewed: Ref[];
  dependency_digest: string;
  inbound_link_digest: string | null;
  evidence_watermark: number | null;
  display_receipt: Ref;
  /** Kind-specific inputs, validated by the decision module. */
  inputs: Record<string, unknown>;
  rationale: string;
  rationale_authorship: V.RationaleAuthorship;
  edit_diff: string | null;
  conditional_on: Ref[];
  accepted_unreviewed: Ref[];
  supersedes: Ref | null;
  decided_at: string;
}
const decisionSchema = obj({
  kind: oneOfValues(V.DECISION_KINDS),
  actor: text(),
  reviewed: refs,
  dependency_digest: text(),
  inbound_link_digest: nullable(str()),
  evidence_watermark: nullable(int(0)),
  display_receipt: refSchema,
  inputs: openObj('decision-kind inputs'),
  rationale: text(),
  rationale_authorship: oneOfValues(V.RATIONALE_AUTHORSHIP),
  edit_diff: nullable(str()),
  conditional_on: refs,
  accepted_unreviewed: refs,
  supersedes: nullable(refSchema),
  decided_at: isoTime,
});

export interface FindingBody {
  investigation: Ref;
  linked_claim_id: string | null;
  guarantee: string;
  title: string;
  mechanism: string;
  prerequisites: string[];
  impact: string;
  affected_code: Anchor[];
  severity: string;
  severity_basis: string;
  evidence_route: V.EvidenceRoute;
  acceptance: Ref;
  applicability: string;
  client_responses: { response: V.ClientResponse; text: string; at: string; severity_change: string | null }[];
  fix_assessments: Ref[];
}
const findingSchema = obj({
  investigation: refSchema,
  linked_claim_id: nullable(str()),
  guarantee: text(),
  title: text(),
  mechanism: text(),
  prerequisites: strings,
  impact: text(),
  affected_code: arr(anchorSchema),
  severity: text(),
  severity_basis: text(),
  evidence_route: oneOfValues(V.EVIDENCE_ROUTES),
  acceptance: refSchema,
  applicability: text(),
  client_responses: arr(
    obj({ response: oneOfValues(V.CLIENT_RESPONSES), text: str(), at: isoTime, severity_change: nullable(str()) }),
  ),
  fix_assessments: refs,
});

export interface FixAssessmentBody {
  finding: Ref;
  fix_snapshot: Ref | null;
  attack_status: V.FixAttackStatus;
  legitimate_status: V.FixLegitStatus;
  client_response: V.ClientResponse;
  label: V.FixLabel;
  evidence: AnyRef[];
  residual_issues: string[];
  scope_note: string;
  decision: Ref;
}
const fixAssessmentSchema = obj({
  finding: refSchema,
  fix_snapshot: nullable(refSchema),
  attack_status: oneOfValues(V.FIX_ATTACK_STATUS),
  legitimate_status: oneOfValues(V.FIX_LEGIT_STATUS),
  client_response: oneOfValues(V.CLIENT_RESPONSES),
  label: oneOfValues(V.FIX_LABELS),
  evidence: anyRefs,
  residual_issues: strings,
  scope_note: text(),
  decision: refSchema,
});

export interface ConclusionFreshnessBody {
  conclusion: Ref;
  snapshot: Ref;
  prior_snapshot: Ref;
  value: V.Freshness;
  probes: { probe: Ref; before: string | null; after: string | null; status: 'unchanged' | 'changed' | 'unevaluable' | 'pending' }[];
  unobserved: string[];
  attestation: Ref | null;
  decision: Ref | null;
  /** Why the value was assigned (changed probes, unevaluable probes, the triggering change). */
  reasons?: string[];
}
const freshnessSchema = obj({
  conclusion: refSchema,
  snapshot: refSchema,
  prior_snapshot: refSchema,
  value: oneOfValues(V.FRESHNESS),
  probes: arr(
    obj({
      probe: refSchema,
      before: nullable(str()),
      after: nullable(str()),
      status: oneOfValues(['unchanged', 'changed', 'unevaluable', 'pending']),
    }),
  ),
  unobserved: strings,
  attestation: nullable(refSchema),
  decision: nullable(refSchema),
  'reasons?': strings,
});

export interface ReportManifestBody {
  selection: Ref[];
  artifacts: { artifact: ArtifactRef; path: string }[];
  required_set: { ref: Ref; reason_required: string; included: boolean; omission_reason: string | null }[];
  audience: string;
  redaction_policy: string;
  report: ArtifactRef;
  payload: ArtifactRef;
  status: 'preview' | 'approved' | 'exported' | 'superseded';
  approval: Ref | null;
  export_receipt: ArtifactRef | null;
  limits: string[];
}
const reportManifestSchema = obj({
  selection: refs,
  artifacts: arr(obj({ artifact: artifactRefSchema, path: text() })),
  required_set: arr(
    obj({ ref: refSchema, reason_required: text(), included: bool(), omission_reason: nullable(str()) }),
  ),
  audience: text(),
  redaction_policy: text(),
  report: artifactRefSchema,
  payload: artifactRefSchema,
  status: oneOfValues(['preview', 'approved', 'exported', 'superseded']),
  approval: nullable(refSchema),
  export_receipt: nullable(artifactRefSchema),
  limits: strings,
});

export interface LessonBody {
  statement: string;
  counterconditions: string[];
  applicability: { component_classes: string[]; standards: string[]; compiler_versions: string[] };
  sources: AnyRef[];
  review_status: 'provisional' | 'reviewed' | 'quarantined';
}
const applicabilitySchema = obj({ component_classes: strings, standards: strings, compiler_versions: strings });
const lessonSchema = obj({
  statement: text(),
  counterconditions: strings,
  applicability: applicabilitySchema,
  sources: anyRefs,
  review_status: oneOfValues(['provisional', 'reviewed', 'quarantined']),
});

export interface LibraryEntryBody {
  mechanism: string;
  counterconditions: string[];
  applicability: { component_classes: string[]; standards: string[]; compiler_versions: string[] };
  source:
    | { kind: 'public_reference'; citation: string; admitting_decision: Ref }
    | { kind: 'transfer'; transfer_ref: string };
  status: 'admitted' | 'retired';
}
const libraryEntrySchema = obj({
  mechanism: text(),
  counterconditions: strings,
  applicability: applicabilitySchema,
  source: any(
    obj({ kind: { const: 'public_reference' }, citation: text(), admitting_decision: refSchema }),
    obj({ kind: { const: 'transfer' }, transfer_ref: text() }),
  ),
  status: oneOfValues(['admitted', 'retired']),
});

export interface LibraryTransferBody {
  lesson: Ref | null;
  public_reference: string | null;
  sanitized_text: string;
  confirmations: { client_details_removed: boolean; reuse_permitted: boolean } | null;
  decision: Ref;
  /** Opaque reference carried by the library entry; never names the source engagement. */
  opaque_ref: string;
  entry: string;
}
const libraryTransferSchema = obj({
  lesson: nullable(refSchema),
  public_reference: nullable(str()),
  sanitized_text: text(),
  confirmations: nullable(obj({ client_details_removed: bool(), reuse_permitted: bool() })),
  decision: refSchema,
  opaque_ref: text(),
  entry: text(),
});

export interface SuspiciousFlagBody {
  snapshot: Ref | null;
  path: string;
  offset: number;
  line: number;
  kind:
    | 'bidi_control'
    | 'zero_width'
    | 'confusable'
    | 'instruction_to_ai'
    | 'natspec_contradiction'
    | 'environment_read'
    | 'path_escape'
    | 'executable_content';
  excerpt: string;
  detail: string;
  acknowledged: Ref | null;
}
const suspiciousFlagSchema = obj({
  snapshot: nullable(refSchema),
  path: text(),
  offset: int(0),
  line: int(0),
  kind: oneOfValues([
    'bidi_control',
    'zero_width',
    'confusable',
    'instruction_to_ai',
    'natspec_contradiction',
    'environment_read',
    'path_escape',
    'executable_content',
  ]),
  excerpt: str(),
  detail: str(),
  acknowledged: nullable(refSchema),
});

export interface ControlStateBody {
  paused: boolean;
  reason: string;
  by: 'auditor' | 'controller_policy';
  /** The attempt that was stopped, if any, and whether termination was confirmed. */
  stopped: { attempt: Ref; termination: 'confirmed' | 'unconfirmed' }[];
}
const controlStateSchema = obj({
  paused: bool(),
  reason: text(),
  by: oneOfValues(['auditor', 'controller_policy']),
  stopped: arr(obj({ attempt: refSchema, termination: oneOfValues(['confirmed', 'unconfirmed']) })),
});

export interface LedgerEntryBody {
  authorization: Ref;
  attempt: Ref | null;
  kind: 'reservation' | 'actual' | 'uncertain' | 'release';
  spend: number;
  runtime_seconds: number;
  note: string;
}
const ledgerSchema = obj({
  authorization: refSchema,
  attempt: nullable(refSchema),
  kind: oneOfValues(['reservation', 'actual', 'uncertain', 'release']),
  spend: num(),
  runtime_seconds: num(),
  note: str(),
});

export interface ProposalConflictBody {
  operation: string;
  target: string;
  expected_revision: number | null;
  actual_revision: number | null;
  proposal: Record<string, unknown>;
  status: 'open' | 'rebased' | 'reconciled';
}
const proposalConflictSchema = obj({
  operation: text(),
  target: text(),
  expected_revision: nullable(int(0)),
  actual_revision: nullable(int(0)),
  proposal: openObj(),
  status: oneOfValues(['open', 'rebased', 'reconciled']),
});

export interface InterpretationBody {
  captured_inputs: Ref[];
  proposed: {
    kind: V.StatementKind;
    affiliation: V.ModelAffiliation;
    statement: string;
    audit_units: Ref[];
  };
  status: 'proposed' | 'confirmed' | 'edited' | 'rejected';
  resulting_statement: Ref | null;
}
const interpretationSchema = obj({
  captured_inputs: arr(refSchema, 1),
  proposed: obj({
    kind: oneOfValues(V.STATEMENT_KINDS),
    affiliation: oneOfValues(V.MODEL_AFFILIATIONS),
    statement: text(),
    audit_units: refs,
  }),
  status: oneOfValues(['proposed', 'confirmed', 'edited', 'rejected']),
  resulting_statement: nullable(refSchema),
});

export interface WorkProposalBody {
  kind: V.WorkAuthorizationKind;
  investigations: Ref[];
  methods: V.InvestigationMethod[];
  requested_capabilities: { tools: string[]; providers: string[]; network: 'denied' | 'rpc_gateway' };
  estimates: { spend: number; runtime_seconds: number };
  lead_generator_coverage: { audit_unit: Ref; generators: { generator: string; status: string }[] }[];
  includes_multistep_question: boolean;
  gaps: string[];
}
const workProposalSchema = obj({
  kind: oneOfValues(V.WORK_AUTHORIZATION_KINDS),
  investigations: refs,
  methods: arr(oneOfValues(V.INVESTIGATION_METHODS)),
  requested_capabilities: obj({ tools: strings, providers: strings, network: oneOfValues(['denied', 'rpc_gateway']) }),
  estimates: obj({ spend: num(0), runtime_seconds: num(0) }),
  lead_generator_coverage: arr(
    obj({ audit_unit: refSchema, generators: arr(obj({ generator: text(), status: text() })) }),
  ),
  includes_multistep_question: bool(),
  gaps: strings,
});


// ---------------------------------------------------------------------------------------------
// Comprehension, coverage and improvement records (FR-14, FR-26, FR-28, FR-30, FR-31, FR-37)

export interface KbDiagramBody {
  audit_unit: Ref;
  lens: string;
  affiliation: 'designed' | 'implemented' | 'comparison';
  format: 'mermaid';
  source: ArtifactRef;
  /** The statements (states, transitions) the diagram depicts, at exact revisions. */
  statements: Ref[];
  /** Semantic delta against the previous revision when regenerated; grants no re-review. */
  semantic_delta: { added: string[]; removed: string[]; changed: string[] } | null;
  review_status: 'provisional' | 'reviewed';
}
const kbDiagramSchema = obj({
  audit_unit: refSchema,
  lens: text(),
  affiliation: oneOfValues(['designed', 'implemented', 'comparison']),
  format: { const: 'mermaid' },
  source: artifactRefSchema,
  statements: refs,
  semantic_delta: nullable(obj({ added: strings, removed: strings, changed: strings })),
  review_status: oneOfValues(['provisional', 'reviewed']),
});

export interface ExplorationBody {
  audit_units: Ref[];
  lens: 'purpose' | 'flows' | 'stores' | 'transitions';
  authorization: Ref;
  mode: 'connected_walkthrough';
  rounds: { started_at: string; ended_at: string | null; seen: Ref[] }[];
  /** Optional checkpoints: a skipped checkpoint records neither mastery nor failure. */
  checkpoints: { id: string; prompt: string; status: 'offered' | 'skipped' | 'answered'; captured_input: Ref | null }[];
  status: 'active' | 'paused' | 'completed';
}
const explorationSchema = obj({
  audit_units: arr(refSchema, 1),
  lens: oneOfValues(['purpose', 'flows', 'stores', 'transitions']),
  authorization: refSchema,
  mode: { const: 'connected_walkthrough' },
  rounds: arr(obj({ started_at: isoTime, ended_at: nullable(isoTime), seen: refs })),
  checkpoints: arr(
    obj({
      id: text(),
      prompt: text(),
      status: oneOfValues(['offered', 'skipped', 'answered']),
      captured_input: nullable(refSchema),
    }),
  ),
  status: oneOfValues(['active', 'paused', 'completed']),
});

export interface AccountingViewBody {
  audit_unit: Ref;
  conservation: { relation: string; anchors: Anchor[] }[];
  units: { store: string; unit: string; decimals: number | null }[];
  rounding: { operation: string; anchor: Anchor | null; direction: 'up' | 'down' | 'nearest' | 'unknown'; beneficiary: string }[];
  review_status: 'provisional' | 'reviewed';
}
const accountingViewSchema = obj({
  audit_unit: refSchema,
  conservation: arr(obj({ relation: text(), anchors: arr(anchorSchema) })),
  units: arr(obj({ store: text(), unit: text(), decimals: nullable(int(0)) })),
  rounding: arr(
    obj({
      operation: text(),
      anchor: nullable(anchorSchema),
      direction: oneOfValues(['up', 'down', 'nearest', 'unknown']),
      beneficiary: text(),
    }),
  ),
  review_status: oneOfValues(['provisional', 'reviewed']),
});

export interface ControlItemBody {
  control_id: string;
  title: string;
  source: string;
  applicability: 'applicable' | 'not_applicable' | 'unknown';
  applicability_reason: string | null;
  evidence: AnyRef[];
  exclusions: string[];
  gaps: string[];
}
const controlItemSchema = obj({
  control_id: text(),
  title: text(),
  source: text(),
  applicability: oneOfValues(['applicable', 'not_applicable', 'unknown']),
  applicability_reason: nullable(str()),
  evidence: anyRefs,
  exclusions: strings,
  gaps: strings,
});

export interface LeadGroupBody {
  relation: 'duplicate' | 'shared_cause' | 'chain';
  members: Ref[];
  /** Every member's origin is preserved; consolidation never deletes a lead. */
  origins: { member: Ref; origin: string; lead_generator: string }[];
  proposed_cause: string;
  dissent: string[];
  /** For a chain: the separate investigable claim created for it. */
  chain_investigation: Ref | null;
  status: 'proposed' | 'confirmed' | 'dissolved';
  status_reason: string | null;
}
const leadGroupSchema = obj({
  relation: oneOfValues(['duplicate', 'shared_cause', 'chain']),
  members: arr(refSchema, 2),
  origins: arr(obj({ member: refSchema, origin: text(), lead_generator: text() })),
  proposed_cause: text(),
  dissent: strings,
  chain_investigation: nullable(refSchema),
  status: oneOfValues(['proposed', 'confirmed', 'dissolved']),
  status_reason: nullable(str()),
});

export interface MethodVersionBody {
  component: 'workflow' | 'prompt' | 'retrieval' | 'tool' | 'check' | 'role';
  name: string;
  version: string;
  description: string;
  content: ArtifactRef | null;
  previous: Ref | null;
  status: 'proposed' | 'adopted' | 'rejected' | 'rolled_back' | 'superseded';
  evaluation: {
    summary: string;
    evidence: ArtifactRef | null;
    held_out: { cases: string[]; runs_per_case: number; baseline_failures: string[]; candidate_failures: string[] };
  } | null;
  decision: Ref | null;
}
const methodVersionSchema = obj({
  component: oneOfValues(['workflow', 'prompt', 'retrieval', 'tool', 'check', 'role']),
  name: text(),
  version: text(),
  description: text(),
  content: nullable(artifactRefSchema),
  previous: nullable(refSchema),
  status: oneOfValues(['proposed', 'adopted', 'rejected', 'rolled_back', 'superseded']),
  evaluation: nullable(
    obj({
      summary: text(),
      evidence: nullable(artifactRefSchema),
      held_out: obj({ cases: strings, runs_per_case: int(1), baseline_failures: strings, candidate_failures: strings }),
    }),
  ),
  decision: nullable(refSchema),
});


export interface PositionBody {
  /** Whose position this is: the investigation's author or the challenger (DEC-007; DEC-008 Q-017). */
  role: 'author' | 'challenger';
  investigation: Ref;
  /** Verbatim text in the archive; packets carry it unchanged, never a synthesized summary. */
  content: ArtifactRef;
  /** Derived by the controller from the submitting channel, never self-reported. */
  submitted_by: { channel: 'worker' | 'auditor'; principal: string; worker_role: string | null; job: Ref | null };
  /** Agent-declared model and provider identity, when the agent host exposes it. */
  model: string | null;
  provider: string | null;
  context_manifest: ArtifactRef | null;
  /** Whether the challenger's initial context withheld the author's rationale and provisional statements. */
  initial_context_withheld: boolean | null;
}
const positionSchema = obj({
  role: oneOfValues(['author', 'challenger']),
  investigation: refSchema,
  content: artifactRefSchema,
  submitted_by: obj({ channel: oneOfValues(['worker', 'auditor']), principal: text(), worker_role: nullable(str()), job: nullable(refSchema) }),
  model: nullable(str()),
  provider: nullable(str()),
  context_manifest: nullable(artifactRefSchema),
  initial_context_withheld: nullable(bool()),
});


export interface EvaluationContractBody {
  /** Frozen before a pilot (harness-evaluation.md, "Pilot protocol" step 1). */
  name: string;
  targets: { engagement: string; snapshot: Ref | null; units: string[] }[];
  method_versions: string[];
  models: { provider: string; model: string; settings: string }[];
  tools: string[];
  task_budgets: string;
  data_access: string;
  severity_rubric: string;
  dedup_policy: string;
  labels: { case: string; kind: 'historical_withheld' | 'seeded_fault' | 'repaired_variant' | 'fresh_consented'; held_out: boolean; reference_defects: string[] }[];
  metric_version: string;
  targets_set_before_run: { metric: string; target: string }[];
  status: 'draft' | 'frozen' | 'superseded';
  frozen_at: string | null;
}
const evaluationContractSchema = obj({
  name: text(),
  targets: arr(obj({ engagement: text(), snapshot: nullable(refSchema), units: strings })),
  method_versions: strings,
  models: arr(obj({ provider: text(), model: text(), settings: str() })),
  tools: strings,
  task_budgets: str(),
  data_access: str(),
  severity_rubric: str(),
  dedup_policy: str(),
  labels: arr(
    obj({
      case: text(),
      kind: oneOfValues(['historical_withheld', 'seeded_fault', 'repaired_variant', 'fresh_consented']),
      held_out: bool(),
      reference_defects: strings,
    }),
  ),
  metric_version: text(),
  targets_set_before_run: arr(obj({ metric: text(), target: text() })),
  status: oneOfValues(['draft', 'frozen', 'superseded']),
  frozen_at: nullable(isoTime),
});

export interface CanaryBody {
  /** NFR-14: a seeded packet the auditor reviews like any other; its label is hidden from the screen. */
  engagement: string;
  packet: Ref;
  kind: 'invalid_claim_plausible_narrative' | 'valid_claim_weakened_counterargument';
  /** What catching it means: rejecting/disputing an invalid claim, or not dismissing a valid one. */
  expected: 'not_accepted' | 'not_dismissed';
  outcome: { decision: Ref; disposition: string; caught: boolean } | null;
}
const canarySchema = obj({
  engagement: text(),
  packet: refSchema,
  kind: oneOfValues(['invalid_claim_plausible_narrative', 'valid_claim_weakened_counterargument']),
  expected: oneOfValues(['not_accepted', 'not_dismissed']),
  outcome: nullable(obj({ decision: refSchema, disposition: text(), caught: bool() })),
});

export const RECORD_SCHEMAS = {
  engagement: engagementSchema,
  target_snapshot: targetSnapshotSchema,
  snapshot_diff: snapshotDiffSchema,
  system_statement: systemStatementSchema,
  behavioral_correspondence: correspondenceSchema,
  behavioral_comparison: comparisonSchema,
  behavioral_discrepancy: discrepancySchema,
  audit_unit: auditUnitSchema,
  clarification: clarificationSchema,
  work_proposal: workProposalSchema,
  work_authorization: workAuthorizationSchema,
  investigation: investigationSchema,
  scenario_variant: variantSchema,
  property: propertySchema,
  job: jobSchema,
  attempt: attemptSchema,
  evidence_artifact: evidenceSchema,
  dependency_probe: probeSchema,
  captured_input: capturedInputSchema,
  interpretation: interpretationSchema,
  review_packet: packetSchema,
  display_receipt: displayReceiptSchema,
  human_decision: decisionSchema,
  finding: findingSchema,
  fix_assessment: fixAssessmentSchema,
  conclusion_freshness: freshnessSchema,
  report_manifest: reportManifestSchema,
  lesson: lessonSchema,
  library_entry: libraryEntrySchema,
  library_transfer: libraryTransferSchema,
  suspicious_flag: suspiciousFlagSchema,
  control_state: controlStateSchema,
  ledger_entry: ledgerSchema,
  proposal_conflict: proposalConflictSchema,
  kb_diagram: kbDiagramSchema,
  exploration: explorationSchema,
  accounting_view: accountingViewSchema,
  control_item: controlItemSchema,
  lead_group: leadGroupSchema,
  method_version: methodVersionSchema,
  position: positionSchema,
  evaluation_contract: evaluationContractSchema,
  canary: canarySchema,
} satisfies Record<string, Schema>;

export type RecordType = keyof typeof RECORD_SCHEMAS;
export const RECORD_TYPES = Object.keys(RECORD_SCHEMAS) as RecordType[];

export interface BodyByType {
  engagement: EngagementBody;
  target_snapshot: TargetSnapshotBody;
  snapshot_diff: SnapshotDiffBody;
  system_statement: SystemStatementBody;
  behavioral_correspondence: BehavioralCorrespondenceBody;
  behavioral_comparison: BehavioralComparisonBody;
  behavioral_discrepancy: BehavioralDiscrepancyBody;
  audit_unit: AuditUnitBody;
  clarification: ClarificationBody;
  work_proposal: WorkProposalBody;
  work_authorization: WorkAuthorizationBody;
  investigation: InvestigationBody;
  scenario_variant: ScenarioVariantBody;
  property: PropertyBody;
  job: JobBody;
  attempt: AttemptBody;
  evidence_artifact: EvidenceArtifactBody;
  dependency_probe: DependencyProbeBody;
  captured_input: CapturedInputBody;
  interpretation: InterpretationBody;
  review_packet: ReviewPacketBody;
  display_receipt: DisplayReceiptBody;
  human_decision: HumanDecisionBody;
  finding: FindingBody;
  fix_assessment: FixAssessmentBody;
  conclusion_freshness: ConclusionFreshnessBody;
  report_manifest: ReportManifestBody;
  lesson: LessonBody;
  library_entry: LibraryEntryBody;
  library_transfer: LibraryTransferBody;
  suspicious_flag: SuspiciousFlagBody;
  control_state: ControlStateBody;
  ledger_entry: LedgerEntryBody;
  proposal_conflict: ProposalConflictBody;
  kb_diagram: KbDiagramBody;
  exploration: ExplorationBody;
  accounting_view: AccountingViewBody;
  control_item: ControlItemBody;
  lead_group: LeadGroupBody;
  method_version: MethodVersionBody;
  position: PositionBody;
  evaluation_contract: EvaluationContractBody;
  canary: CanaryBody;
}

/** Short ID prefixes per record type (IDs are engagement-scoped: `<prefix>-<seq>`). */
export const ID_PREFIX: Record<RecordType, string> = {
  engagement: 'eng',
  target_snapshot: 'snap',
  snapshot_diff: 'diff',
  system_statement: 'stmt',
  behavioral_correspondence: 'corr',
  behavioral_comparison: 'cmp',
  behavioral_discrepancy: 'disc',
  audit_unit: 'unit',
  clarification: 'clar',
  work_proposal: 'wprop',
  work_authorization: 'auth',
  investigation: 'inv',
  scenario_variant: 'var',
  property: 'prop',
  job: 'job',
  attempt: 'att',
  evidence_artifact: 'ev',
  dependency_probe: 'probe',
  captured_input: 'cap',
  interpretation: 'interp',
  review_packet: 'pkt',
  display_receipt: 'disp',
  human_decision: 'dec',
  finding: 'find',
  fix_assessment: 'fix',
  conclusion_freshness: 'fresh',
  report_manifest: 'rpt',
  lesson: 'lesson',
  library_entry: 'mech',
  library_transfer: 'xfer',
  suspicious_flag: 'flag',
  control_state: 'ctl',
  ledger_entry: 'ledger',
  proposal_conflict: 'conflict',
  kb_diagram: 'diag',
  exploration: 'expl',
  accounting_view: 'acct',
  control_item: 'ctrl',
  lead_group: 'group',
  method_version: 'method',
  position: 'pos',
  evaluation_contract: 'evalc',
  canary: 'canary',
};

// ---------------------------------------------------------------------------------------------
// Envelope common to every record

export type Channel = 'auditor' | 'screen' | 'capture' | 'worker' | 'runner' | 'controller';

export interface RecordEnvelope<T extends RecordType = RecordType> {
  schema_version: number;
  scope: string;
  record_id: string;
  type: T;
  revision: number;
  created_at: string;
  created_by: { channel: Channel; principal: string };
  origin: { operation: string; request_id: string; job: Ref | null; attempt: Ref | null; decision: Ref | null };
  visibility: 'engagement' | 'library';
  depends_on: AnyRef[];
  body: BodyByType[T];
}

export type AnyRecord = { [T in RecordType]: RecordEnvelope<T> }[RecordType];

export const envelopeSchema: Schema = obj({
  schema_version: int(1),
  scope: text(),
  record_id: text(),
  type: oneOfValues(RECORD_TYPES),
  revision: int(1),
  created_at: isoTime,
  created_by: obj({ channel: oneOfValues(['auditor', 'screen', 'capture', 'worker', 'runner', 'controller']), principal: text() }),
  origin: obj({
    operation: text(),
    request_id: text(),
    job: nullable(refSchema),
    attempt: nullable(refSchema),
    decision: nullable(refSchema),
  }),
  visibility: oneOfValues(['engagement', 'library']),
  depends_on: anyRefs,
  body: openObj('validated against the per-type schema'),
});

export const eventSchema: Schema = obj({
  schema_version: int(1),
  scope: text(),
  seq: int(1),
  event_id: text(),
  at: isoTime,
  kind: text(),
  operation: text(),
  request_id: text(),
  idempotency_key: nullable(str()),
  request_digest: nullable(str()),
  principal: obj({ channel: text(), principal: text() }),
  records: refs,
  result: openObj(),
});

export interface EventEnvelope {
  schema_version: number;
  scope: string;
  seq: number;
  event_id: string;
  at: string;
  kind: string;
  operation: string;
  request_id: string;
  idempotency_key: string | null;
  request_digest: string | null;
  principal: { channel: Channel; principal: string };
  records: Ref[];
  result: Record<string, unknown>;
}

