// Test-only staging for records that other modules normally create (investigations, dispositions,
// findings, statements, snapshots). Records are committed straight through the store, never through
// a production bypass; decisions under test still go through the screen channel.
import { unknown, type AnyRef, type Ref } from '../src/core/refs.ts';
import { DEFAULT_ATTACKER_CHARTER, type Disposition, type PotentialImpact } from '../src/core/values.ts';
import { defaultProofStatus, impactField } from '../src/decision/common.ts';
import type { BodyByType, EngagementPolicy, RecordType } from '../src/schema/records.ts';
import type { Harness } from './helpers.ts';

export interface Stage<T extends RecordType = RecordType> {
  type: T;
  body: BodyByType[T];
  depends_on?: AnyRef[];
  record_id?: string;
  base_revision?: number;
}

/** Commit records directly to a store (test fixture only). */
export function stage(h: Harness, scope: string, records: Stage[]): Ref[] {
  const store = h.ws.store(scope, true);
  const res = store.commit({
    records: records.map((r) => ({
      type: r.type,
      record_id: r.record_id,
      base_revision: r.base_revision ?? 0,
      body: r.body,
      depends_on: r.depends_on ?? [],
    })) as never,
    events: [{ kind: 'test_fixture', operation: 'test_fixture', request_id: 'fixture', idempotency_key: null, request_digest: null, result: {} }],
    principal: { channel: 'controller', principal: 'test-fixture' },
    origin: { operation: 'test_fixture', request_id: 'fixture', job: null, attempt: null, decision: null },
    now: new Date().toISOString(),
    message: 'test fixture',
  });
  h.ws.noteCommitted(scope);
  return res.refs;
}

export function stageOne<T extends RecordType>(h: Harness, scope: string, type: T, body: BodyByType[T], depends_on: AnyRef[] = []): Ref {
  return stage(h, scope, [{ type, body, depends_on } as Stage])[0];
}

export function policy(overrides: Partial<EngagementPolicy> = {}): EngagementPolicy {
  return {
    scope: ['src/Vault.sol'],
    exclusions: [{ item: 'src/mocks', reason: 'test scaffolding' }],
    attacker_charter: {
      capabilities: [...DEFAULT_ATTACKER_CHARTER.capabilities],
      excluded: [],
      raised_roles: [],
      privileged_roles_trusted: true,
      notes: null,
    },
    trusted_role_premise: 'Privileged roles are trusted unless the auditor raises them',
    data_policy: { live_exploitable_class: 'unpatched', approved_providers: [], data_classes: [] },
    disclosure_constraints: [],
    retention: { policy: 'keep one year', backup: 'local' },
    severity_rubric: 'impact x likelihood',
    rejection_listing_threshold: 'medium',
    budget: { unit: 'USD', total: 0 },
    evidence_policy: 'DEC-004',
    capacity: { review_queue: 5, clarification_queue: 5, decisions_per_day: 20 },
    time_plan: 'two weeks',
    ...overrides,
  };
}

/** Accept scope and policy by revising the engagement record (fixture for the lead's decision). */
export function acceptPolicy(h: Harness, eid: string, overrides: Partial<EngagementPolicy> = {}, active_snapshot: Ref | null = null): Ref {
  const store = h.ws.store(eid, true);
  const eng = store.heads('engagement')[0];
  return stage(h, eid, [
    {
      type: 'engagement',
      record_id: eng.record_id,
      base_revision: eng.revision,
      body: { ...eng.body, policy: policy(overrides), policy_decision: { record_id: 'dec-0000', revision: 1 }, active_snapshot: active_snapshot ?? eng.body.active_snapshot },
    } as Stage,
  ])[0];
}

export function decisionStub(h: Harness, eid: string, kind: 'dispose_investigation' | 'assess_fix', inputs: Record<string, unknown>, rationale = 'fixture', conditional_on: Ref[] = []): Ref {
  return stageOne(h, eid, 'human_decision', {
    kind,
    actor: 'auditor',
    reviewed: [],
    dependency_digest: 'sha256:' + '0'.repeat(64),
    inbound_link_digest: null,
    evidence_watermark: null,
    display_receipt: { record_id: 'disp-0000', revision: 1 },
    inputs,
    rationale,
    rationale_authorship: 'human_written',
    edit_diff: null,
    conditional_on,
    accepted_unreviewed: [],
    supersedes: null,
    decided_at: new Date().toISOString(),
  });
}

export function investigationBody(o: {
  question: string;
  impact?: PotentialImpact;
  disposition?: { value: Disposition; decision: Ref } | null;
  work_state?: BodyByType['investigation']['work_state'];
  audit_units?: Ref[];
  anchors?: BodyByType['investigation']['anchors'];
}): BodyByType['investigation'] {
  return {
    method: 'hypothesis',
    question: o.question,
    executable: true,
    origin: 'agent',
    lead_generator: 'manual',
    audit_units: o.audit_units ?? [],
    guarantees: ['solvency'],
    attacker_capabilities: [],
    prerequisites: [],
    anchors: o.anchors ?? [],
    potential_impact: impactField(o.impact ?? 'high', null, null),
    supporting: [],
    refuting: [],
    variants: [],
    linked_claims: [],
    next_check: null,
    jobs: [],
    authorization: null,
    work_state: o.work_state ?? (o.disposition ? 'closed' : 'queued'),
    blocked_reason: null,
    disposition: o.disposition ?? null,
    proof_status: defaultProofStatus(),
    probes: [],
    lineage: null,
  };
}

/** An accepted investigation with its finding (code_argument route). Returns {investigation, finding}. */
export function acceptedFinding(
  h: Harness,
  eid: string,
  title: string,
  fixLabel: 'fixed' | null = null,
  o: { route?: 'code_argument' | 'alternative_argument'; inputs?: Record<string, unknown>; conditional_on?: Ref[] } = {},
): { investigation: Ref; finding: Ref } {
  const route = o.route ?? 'code_argument';
  const dec = decisionStub(h, eid, 'dispose_investigation', { disposition: 'accepted', severity: 'High', evidence_route: route, ...(o.inputs ?? {}) }, 'fixture', o.conditional_on ?? []);
  const inv = stageOne(h, eid, 'investigation', investigationBody({ question: `Can ${title}?`, impact: 'low', disposition: { value: 'accepted', decision: dec } }));
  const finding = stageOne(
    h,
    eid,
    'finding',
    {
      investigation: inv,
      linked_claim_id: null,
      guarantee: 'solvency',
      title,
      mechanism: 'the withdraw path skips the balance check',
      prerequisites: ['attacker holds shares'],
      impact: 'loss of deposits',
      affected_code: [{ path: 'src/Vault.sol', symbol: 'Vault.withdraw', start: null, length: null, content_digest: null, snapshot: null }],
      severity: 'High',
      severity_basis: 'rubric row 2',
      evidence_route: route,
      acceptance: dec,
      applicability: 'snapshot 1',
      client_responses: [],
      fix_assessments: [],
    },
    [inv, dec],
  );
  if (fixLabel === 'fixed') {
    const fd = decisionStub(h, eid, 'assess_fix', {});
    const fa = stageOne(h, eid, 'fix_assessment', {
      finding,
      fix_snapshot: null,
      attack_status: 'blocked',
      legitimate_status: 'preserved',
      client_response: 'fixed',
      label: 'fixed',
      evidence: [],
      residual_issues: [],
      scope_note: 'fix commit',
      decision: fd,
    });
    const store = h.ws.store(eid, true);
    const f = store.mustHead(finding.record_id, 'finding');
    const rev = stage(h, eid, [{ type: 'finding', record_id: finding.record_id, base_revision: f.revision, body: { ...f.body, fix_assessments: [fa] }, depends_on: f.depends_on } as Stage])[0];
    return { investigation: inv, finding: rev };
  }
  return { investigation: inv, finding };
}

export function statementBody(o: {
  statement: string;
  kind?: BodyByType['system_statement']['kind'];
  review_status?: BodyByType['system_statement']['review_status'];
  audit_units?: Ref[];
  contradicting?: AnyRef[];
}): BodyByType['system_statement'] {
  return {
    kind: o.kind ?? 'observed_implementation',
    affiliation: 'implemented',
    origin: 'source_analysis',
    statement: o.statement,
    anchors: [],
    audit_units: o.audit_units ?? [],
    captured_inputs: [],
    confirmation: null,
    intent_timing: null,
    applicability: 'snapshot 1',
    supporting: [],
    contradicting: o.contradicting ?? [],
    review_status: o.review_status ?? 'provisional',
    owner: 'agent',
  };
}

/** Render `reviewed` on the trusted screen, then decide. */
export function decide<R = any>(
  h: Harness,
  scope: string,
  kind: string,
  reviewed: Ref[],
  inputs: Record<string, unknown>,
  operation = 'record_decision',
): R {
  const now = new Date().toISOString();
  const { display_receipt } = h.screen.do(scope, 'record_display', { rendered: reviewed, sections: [], started_at: now, ended_at: now });
  return h.screen.do<R>(scope, operation, {
    decision_kind: kind,
    reviewed,
    display_receipt,
    inputs,
    rationale: 'reviewed on the trusted screen',
    rationale_authorship: 'human_written',
  });
}

/** A source-only target snapshot whose tree holds `files` (path -> text). */
export function stageSnapshot(h: Harness, eid: string, files: Record<string, string>): Ref {
  const archive = h.ws.store(eid, true).archive;
  const entries = Object.fromEntries(Object.entries(files).map(([p, t]) => [p, archive.put(t).artifact]));
  const tree = archive.putJson({ format: 'harness.tree/1', files: entries, refused: [] });
  return stageOne(h, eid, 'target_snapshot', {
    label: 'initial',
    source: { kind: 'directory', origin_path: '/tmp/target', commit: unknown('directory snapshot'), dirty_files: [], untracked_included: [] },
    tree,
    file_count: Object.keys(files).length,
    dependencies: [],
    vendored: [],
    compiler: unknown('not built'),
    build: unknown('not built'),
    inventory: null,
    storage_layouts: null,
    deployment: unknown('none'),
    fork: unknown('none'),
    source_only: true,
    prior_snapshot: null,
    diff: null,
    suspicious_flags: [],
    limitations: [],
  });
}
