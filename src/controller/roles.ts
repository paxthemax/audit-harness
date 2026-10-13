// Agent role profiles (design/audit-harness.md, "Agent role classification"; FR-08). Roles are
// reusable task profiles with different context and tool grants, not different models or processes.
// A worker grant for an attempt covers exactly its role's operations; nothing here lets a role decide.

export interface RoleProfile {
  role: string;
  receives: string;
  produces: string;
  mayNotDecide: string;
  /** Controller operations a worker grant for this role covers. */
  operations: string[];
  /** Context-builder role key (see src/context). */
  contextRole: string;
}

const READ = ['read_records', 'clarification_queue'];

export const ROLE_PROFILES: Record<string, RoleProfile> = {
  comprehension: {
    role: 'comprehension',
    receives: 'Snapshot, documents, structural queries',
    produces: 'Assets, actors, states, flow maps, intent/implementation differences, unresolved premises',
    mayNotDecide: 'That developer intent or its own summary is correct',
    operations: [...READ, 'submit_proposal', 'record_probe', 'propose_kb_diagram', 'propose_accounting_view', 'propose_control_item', 'request_provider_call'],
    contextRole: 'comprehension',
  },
  planner: {
    role: 'planner',
    receives: 'Current model, coverage gaps, lead-generator coverage, unresolved leads, remaining budget',
    produces: 'Ranked investigation questions and a proposed batch',
    mayNotDecide: 'Scope expansion, new permissions, or the batch budget',
    operations: [...READ, 'submit_proposal', 'prepare_work', 'request_provider_call'],
    contextRole: 'planner',
  },
  investigator: {
    role: 'investigator',
    receives: 'One investigation question, the attacker charter, local code plus every writer of the storage it reads, and relevant evidence',
    produces: 'Causal claim, counterconditions, scenario variants with outcomes, declared setup powers, trace, next check',
    mayNotDecide: 'Finding validity, final severity, or dismissal of competing evidence',
    operations: [...READ, 'submit_proposal', 'submit_fixture', 'submit_position', 'request_job', 'record_probe', 'submit_review_packet', 'request_provider_call'],
    contextRole: 'investigator',
  },
  property: {
    role: 'property',
    receives: 'Selected question and reviewed semantics',
    produces: 'Versioned fixtures, handlers, reference models, test artifacts and adequacy notes',
    mayNotDecide: 'A changed oracle, narrower attack model, or edited production target',
    operations: [...READ, 'submit_proposal', 'submit_fixture', 'submit_position', 'request_job', 'record_probe', 'request_provider_call'],
    contextRole: 'property_agent',
  },
  challenger: {
    role: 'challenger',
    receives: 'Same snapshot and reviewed premises; initially no author narrative and no provisional statements on the challenged path',
    produces: 'Independent prerequisite check, review of declared setup powers, counterargument, missing evidence',
    mayNotDecide: 'Majority-vote truth or human acceptance',
    operations: [...READ, 'submit_proposal', 'submit_fixture', 'submit_position', 'request_job', 'request_provider_call'],
    contextRole: 'challenger',
  },
  synthesis: {
    role: 'synthesis',
    receives: 'Frozen outputs and disposition records',
    produces: 'Duplicate proposals, cause chains, review packets, draft report prose',
    mayNotDecide: 'Silent deletion or merging of leads, paraphrasing the challenger, structured report fields, new findings, report release',
    operations: [...READ, 'propose_lead_group', 'submit_review_packet', 'prepare_export', 'request_provider_call'],
    contextRole: 'synthesis',
  },
  curator: {
    role: 'curator',
    receives: 'Engagement-local lessons and admitted mechanism-library entries',
    produces: 'Source-linked patterns, counterconditions, retrieval corrections, proposed library transfers',
    mayNotDecide: 'Cross-engagement sharing, policy changes, or turning a memory into a finding',
    operations: [...READ, 'propose_lesson', 'request_provider_call'],
    contextRole: 'curator',
  },
  /** Deterministic tool roles: the trusted runner executes them; they submit nothing themselves. */
  tool: {
    role: 'tool',
    receives: 'A registered adapter operation with structured arguments',
    produces: 'Receipts and artifacts through the trusted runner',
    mayNotDecide: 'Anything',
    operations: [],
    contextRole: 'none',
  },
};

export function roleProfile(role: string): RoleProfile {
  return ROLE_PROFILES[role] ?? ROLE_PROFILES.tool;
}

/** Operations a worker grant for this role may call. Unknown roles get none. */
export function grantOperationsFor(role: string): string[] {
  return [...roleProfile(role).operations];
}
