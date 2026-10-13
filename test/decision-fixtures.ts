// Test-only helpers for the decision layer. Records that only the trusted runner creates in
// production (evidence from replay / positive-control jobs) are staged here through store.commit;
// there is no production bypass.

import type { Ref } from '../src/core/refs.ts';
import { DEFAULT_ATTACKER_CHARTER } from '../src/core/values.ts';
import type { EngagementPolicy, Limits, StructuredResult } from '../src/schema/records.ts';
import type { Harness } from './helpers.ts';

export function policy(overrides: Partial<EngagementPolicy> = {}): EngagementPolicy {
  return {
    scope: ['src/Vault.sol'],
    exclusions: [],
    attacker_charter: {
      capabilities: [...DEFAULT_ATTACKER_CHARTER.capabilities],
      excluded: [],
      raised_roles: [],
      privileged_roles_trusted: true,
      notes: null,
    },
    trusted_role_premise: 'Privileged roles are trusted unless the auditor raises them.',
    data_policy: { live_exploitable_class: 'unfixed-findings', approved_providers: ['fake'], data_classes: ['source'] },
    disclosure_constraints: [],
    retention: { policy: 'keep until closure + 90 days', backup: 'git' },
    severity_rubric: 'impact x likelihood (engagement rubric v1)',
    rejection_listing_threshold: 'medium',
    budget: { unit: 'USD', total: 100 },
    evidence_policy: 'DEC-004 with impact scaling',
    capacity: { review_queue: 3, clarification_queue: 2, decisions_per_day: 20 },
    time_plan: '5 days',
    ...overrides,
  };
}

export const LIMITS: Limits = {
  spend: 10,
  runtime_seconds: 600,
  concurrency: 1,
  child_tasks: 0,
  rounds: 5,
  retries: 2,
  repairs_per_variant: 2,
  output_bytes: 1_000_000,
  memory_mb: 2048,
  processes: 64,
};

const now = () => new Date().toISOString();

/** Render `refs` on the trusted screen (opening `sections` in order) and return the receipt ref. */
export function display(h: Harness, eid: string, refs: Ref[], sections: string[] = [], presented: Ref[] = []): Ref {
  const t = now();
  return h.screen.do(eid, 'record_display', {
    rendered: refs,
    sections: sections.map((s) => ({ section: s, opened_at: t })),
    started_at: t,
    ended_at: t,
    implemented_presented_for: presented,
  }).display_receipt;
}

export function head(h: Harness, eid: string, id: string): Ref {
  return h.ws.store(eid, true).headRef(id);
}

/** Decide with a fresh display of exactly the reviewed revisions. */
export function decide(h: Harness, eid: string, kind: string, reviewed: Ref[], inputs: Record<string, unknown>, sections: string[] = [], extra: Record<string, unknown> = {}) {
  const receipt = display(h, eid, reviewed, sections);
  return h.screen.do(eid, 'record_decision', {
    decision_kind: kind,
    reviewed,
    display_receipt: receipt,
    inputs,
    rationale: `decision ${kind}`,
    rationale_authorship: 'human_written',
    ...extra,
  });
}

export function acceptPolicy(h: Harness, eid: string, p: EngagementPolicy = policy()) {
  return decide(h, eid, 'accept_scope_and_policy', [head(h, eid, 'eng-0001')], { policy: p });
}

/** Stage a minimal target snapshot record and set it active (the snapshot module does this for real). */
export function stageSnapshot(h: Harness, eid: string): Ref {
  const store = h.ws.store(eid, true);
  // A one-file target whose guard the positive-control fixtures remove.
  const src = store.archive.put('contract Vault { modifier nonReentrant() { _; } function withdraw() external nonReentrant {} }\n');
  const tree = store.archive.putJson({ format: 'harness.tree/1', files: { 'src/Vault.sol': src.artifact }, refused: [] });
  const res = store.commit({
    records: [
      {
        type: 'target_snapshot',
        base_revision: 0,
        body: {
          label: 'fixture',
          source: { kind: 'directory', origin_path: '/fixture', commit: { unknown: true, reason: 'fixture' }, dirty_files: [], untracked_included: [] },
          tree,
          file_count: 1,
          dependencies: [],
          vendored: [],
          compiler: { unknown: true, reason: 'fixture' },
          build: { unknown: true, reason: 'fixture' },
          inventory: null,
          storage_layouts: null,
          deployment: { unknown: true, reason: 'fixture' },
          fork: { unknown: true, reason: 'fixture' },
          source_only: true,
          prior_snapshot: null,
          diff: null,
          suspicious_flags: [],
          limitations: ['test fixture'],
        },
      },
    ],
    events: [],
    principal: { channel: 'controller', principal: 'test-fixture' },
    origin: { operation: 'test_fixture', request_id: 'fixture', job: null, attempt: null, decision: null },
    now: now(),
    message: 'fixture snapshot',
    blobs: [tree.artifact, src.artifact],
  });
  const snap = res.refs[0];
  const eng = store.mustHead('eng-0001', 'engagement');
  store.commit({
    records: [{ type: 'engagement', record_id: 'eng-0001', base_revision: eng.revision, body: { ...eng.body, active_snapshot: snap } }],
    events: [],
    principal: { channel: 'controller', principal: 'test-fixture' },
    origin: { operation: 'test_fixture', request_id: 'fixture', job: null, attempt: null, decision: null },
    now: now(),
    message: 'fixture active snapshot',
  });
  h.ws.noteCommitted(eid);
  return snap;
}

/**
 * Stage trusted-runner evidence for an investigation as if a job of `purpose` had completed.
 * Production evidence comes only from the runner's complete_attempt.
 */
export function stageEvidence(
  h: Harness,
  eid: string,
  inv: string,
  purpose: 'experiment' | 'replay' | 'positive_control',
  result: StructuredResult['result_type'],
): Ref {
  const store = h.ws.store(eid, true);
  const out = store.archive.put(`${purpose} output ${result} ${Math.random()}`);
  const snap = store.mustHead('eng-0001', 'engagement').body.active_snapshot!;
  const auth = store.mustHead(inv, 'investigation').body.authorization!;
  // A positive control reruns the investigation's latest experiment (same adapter, args and fixture).
  const lineage =
    purpose === 'positive_control'
      ? store
          .heads('job')
          .filter((j) => j.body.investigation?.record_id === inv && j.body.purpose === 'experiment')
          .map((j) => ({ record_id: j.record_id, revision: j.revision }))
          .at(-1) ?? null
      : null;
  const principal = { channel: 'runner' as const, principal: 'trusted-runner' };
  const origin = { operation: 'test_fixture', request_id: 'fixture', job: null, attempt: null, decision: null };
  const job = store.commit({
    records: [
      {
        type: 'job',
        base_revision: 0,
        body: {
          authorization: auth,
          context_manifest: null,
          role: 'investigator',
          purpose,
          adapter: { name: 'forge_test', version: 'fixture', descriptor: 'fixture' },
          operation: 'test',
          args: {},
          snapshot: snap,
          fixture: null,
          input_digest: out.artifact,
          investigation: { record_id: inv, revision: 1 },
          variant: null,
          limits: LIMITS,
          reservation: { spend: 0, runtime_seconds: 60 },
          lineage,
          guard_removal: purpose === 'positive_control' ? { path: 'src/Vault.sol', find: 'external nonReentrant {', replace: 'external {' } : null,
          status: 'completed',
          attempts: [],
        },
      },
    ],
    events: [],
    principal,
    origin,
    now: now(),
    message: 'fixture job',
  }).refs[0];
  const t = now();
  const ev = store.commit({
    records: [
      {
        type: 'evidence_artifact',
        base_revision: 0,
        body: {
          content: out,
          producer: 'trusted_runner',
          job,
          attempt: null,
          receipt: {
            runner: { identity: 'fixture', version: '0' },
            sandbox: { kind: 'bwrap', network: 'denied', descriptor: 'fixture' },
            argv: ['forge', 'test'],
            cwd: '/work',
            executable: { path: 'forge', digest: null, version: null },
            env_keys: [],
            started_at: t,
            ended_at: t,
            exit_code: 0,
            signal: null,
            timed_out: false,
            stdout: out,
            stderr: out,
            stdout_truncated: false,
            stderr_truncated: false,
            outputs: [],
          },
          snapshot: snap,
          fixture: null,
          structured_result: { result_type: result, mode: 'test', bounds: null, interpretation: 'fixture', tests: [] },
          environment_sensitive: { flagged: false, reads: [] },
          positive_control_for: purpose === 'positive_control' ? { record_id: inv, revision: 1 } : null,
          missing_or_truncated: [],
          limitations: [],
          eligible: true,
          description: `${purpose} fixture`,
        },
      },
    ],
    events: [],
    principal,
    origin,
    now: t,
    message: 'fixture evidence',
    blobs: [out.artifact],
  }).refs[0];
  h.ws.noteCommitted(eid);
  return ev;
}

export interface Scenario {
  eid: string;
  flow: Ref;
  inv: Ref;
}

/**
 * Engagement with accepted policy, a fixture snapshot, a reviewed flow and one investigation
 * admitted in a batch. Returns the investigation's current ref.
 */
export function admittedInvestigation(h: Harness, eid: string, opts: { impact?: string; executable?: boolean; method?: string } = {}): Scenario {
  h.auditor.do(eid, 'create_engagement', { name: 'Vault audit', owner: 'auditor', audit_purpose: 'test' });
  acceptPolicy(h, eid);
  stageSnapshot(h, eid);
  const flow = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal', functions: [{ name: 'Vault.withdraw', reviewed: false }] } }).audit_unit;
  decide(h, eid, 'record_flow_review', [flow], { audit_unit: flow, reviewed_functions: ['Vault.withdraw'] });
  const inv = h.auditor.do(eid, 'submit_proposal', {
    kind: 'investigation',
    body: {
      method: opts.method ?? 'scenario',
      question: 'Can a callback during withdraw pay out twice?',
      executable: opts.executable ?? true,
      lead_generator: 'attack_vector_sweep',
      audit_units: [head(h, eid, flow.record_id)],
      guarantees: ['withdrawals pay at most the entitlement'],
      potential_impact: opts.impact ?? 'high',
      anchors: [{ path: 'src/Vault.sol', symbol: 'Vault.withdraw', start: 10, length: 40, content_digest: null, snapshot: null }],
    },
  }).investigation;
  const invHead = head(h, eid, inv.record_id);
  const receipt = display(h, eid, [invHead]);
  h.screen.do(eid, 'authorize_work', {
    reviewed: [invHead],
    display_receipt: receipt,
    inputs: { kind: 'batch', investigations: [invHead], methods: [opts.method ?? 'scenario'], capabilities: { tools: ['forge_test'], providers: [], network: 'denied' }, limits: LIMITS },
    rationale: 'admit the callback question',
    rationale_authorship: 'human_written',
  });
  return { eid, flow: head(h, eid, flow.record_id), inv: head(h, eid, inv.record_id) };
}

/** Add one variant with an outcome (as an agent would) and return its ref. */
export function variantWithOutcome(h: Harness, eid: string, inv: string, outcome: string, extra: Record<string, unknown> = {}): Ref {
  const v = h.auditor.do(eid, 'submit_proposal', {
    kind: 'scenario_variant',
    body: {
      investigation: { record_id: inv },
      causal_sequence: ['deposit 1 ether', 'withdraw with reentrant callback'],
      setup_powers: ['vm.deal attacker 1 ether'],
      expected_violation: 'attacker receives 2 ether',
      defeating_condition: 'nonReentrant guard reverts the nested call',
      ...extra,
    },
  }).variant;
  return h.auditor.do(eid, 'submit_proposal', { kind: 'scenario_variant', base: v, body: { outcome } }).variant;
}
