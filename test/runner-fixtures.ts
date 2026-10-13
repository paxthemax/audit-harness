// Test-only helpers for the runner. Work authorizations, snapshots, investigations and the engagement
// policy are created in production by other modules' operations (authorize_work, register_snapshot,
// submit_proposal, accept_scope_and_policy); here they are staged directly through store.commit so
// the runner can be tested in isolation. There is no production bypass.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Ref } from '../src/core/refs.ts';
import type { PendingRecord } from '../src/store/recordStore.ts';
import type { EngagementPolicy, Limits, WorkAuthorizationBody } from '../src/schema/records.ts';
import type { WorkAuthorizationKind } from '../src/core/values.ts';
import type { Harness } from './helpers.ts';

export const LIMITS: Limits = {
  spend: 10,
  runtime_seconds: 3600,
  concurrency: 1,
  child_tasks: 1,
  rounds: 5,
  retries: 1,
  repairs_per_variant: 1,
  output_bytes: 64 * 1024 * 1024,
  memory_mb: 4096,
  processes: 256,
};

export function commit(h: Harness, eid: string, records: PendingRecord[], blobs: string[] = []): Ref[] {
  const store = h.ws.store(eid, true);
  const res = store.commit({
    records,
    events: [{ kind: 'test_fixture', operation: 'test_fixture', request_id: 'test', idempotency_key: null, request_digest: null, result: {} }],
    principal: { channel: 'controller', principal: 'test-fixture' },
    origin: { operation: 'test_fixture', request_id: 'test', job: null, attempt: null, decision: null },
    now: new Date().toISOString(),
    message: 'test fixture',
    blobs,
  });
  h.ws.noteCommitted(eid);
  return res.refs;
}

/** Write a tiny Foundry project (no forge-std): files maps relative paths to contents. */
export function foundryProject(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'foundry.toml'), '[profile.default]\nsrc = "src"\nout = "out"\nlibs = []\noffline = true\n');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

export function stageSnapshot(h: Harness, eid: string, projectDir: string, activate = false): Ref {
  const archive = h.ws.store(eid, true).archive;
  const t = archive.putTree(projectDir, (rel) => !/^(out|cache)(\/|$)/.test(rel));
  const [ref] = commit(
    h,
    eid,
    [
      {
        type: 'target_snapshot',
        base_revision: 0,
        body: {
          label: 'test snapshot',
          source: { kind: 'directory', origin_path: projectDir, commit: { unknown: true, reason: 'test' }, dirty_files: [], untracked_included: [] },
          tree: t.ref,
          file_count: Object.keys(t.manifest.files).length,
          dependencies: [],
          vendored: [],
          compiler: { unknown: true, reason: 'test' },
          build: { unknown: true, reason: 'test' },
          inventory: null,
          storage_layouts: null,
          deployment: { unknown: true, reason: 'test' },
          fork: { unknown: true, reason: 'test' },
          source_only: false,
          prior_snapshot: null,
          diff: null,
          suspicious_flags: [],
          limitations: [],
        },
      },
    ],
    [t.ref.artifact, ...Object.values(t.manifest.files)],
  );
  if (activate) {
    const eng = h.ws.store(eid, true).heads('engagement')[0];
    commit(h, eid, [{ type: 'engagement', record_id: eng.record_id, base_revision: eng.revision, body: { ...eng.body, active_snapshot: ref } }]);
  }
  return ref;
}

export function stageInvestigation(h: Harness, eid: string, question = 'Can a caller withdraw twice?'): Ref {
  const [ref] = commit(h, eid, [
    {
      type: 'investigation',
      base_revision: 0,
      body: {
        method: 'hypothesis',
        question,
        executable: true,
        origin: 'auditor',
        lead_generator: 'manual',
        audit_units: [],
        guarantees: [],
        attacker_capabilities: [],
        prerequisites: [],
        anchors: [],
        potential_impact: { agent: null, auditor: 'high', auditor_lower_reason: null, effective: 'high', set_by: 'auditor' },
        supporting: [],
        refuting: [],
        variants: [],
        linked_claims: [],
        next_check: null,
        jobs: [],
        authorization: null,
        work_state: 'queued',
        blocked_reason: null,
        disposition: null,
        proof_status: {
          provenance: 'incomplete',
          prerequisite_review: 'pending',
          adequacy: 'pending',
          adequacy_reason: null,
          replay: 'not_required',
          positive_control: 'not_required',
        },
        probes: [],
        lineage: null,
      },
    },
  ]);
  return ref;
}

export interface AuthOptions {
  kind?: WorkAuthorizationKind;
  tools?: string[];
  providers?: string[];
  investigations?: Ref[];
  snapshot?: Ref | null;
  limits?: Partial<Limits>;
  status?: WorkAuthorizationBody['status'];
}

/** Stage a work authorization with its human decision (as authorize_work would). */
export function stageAuthorization(h: Harness, eid: string, o: AuthOptions = {}): Ref {
  const now = new Date();
  const store = h.ws.store(eid, true);
  const decisionId = store.peekNextId('human_decision');
  const refs = commit(h, eid, [
    {
      type: 'human_decision',
      base_revision: 0,
      body: {
        kind: 'authorize_work',
        actor: 'auditor',
        reviewed: [],
        dependency_digest: 'sha256:' + '0'.repeat(64),
        inbound_link_digest: null,
        evidence_watermark: null,
        display_receipt: { record_id: 'disp-9999', revision: 1 },
        inputs: { test: true },
        rationale: 'test authorization',
        rationale_authorship: 'human_written',
        edit_diff: null,
        conditional_on: [],
        accepted_unreviewed: [],
        supersedes: null,
        decided_at: now.toISOString(),
      },
    },
    {
      type: 'work_authorization',
      base_revision: 0,
      body: {
        kind: o.kind ?? 'batch',
        decision: { record_id: decisionId, revision: 1 },
        reviewed: [],
        snapshot: o.snapshot ?? null,
        investigations: o.investigations ?? [],
        methods: ['hypothesis'],
        attacker_charter: null,
        capabilities: { tools: o.tools ?? ['forge_build', 'forge_test'], providers: o.providers ?? [], network: 'denied' },
        limits: { ...LIMITS, ...(o.limits ?? {}) },
        validity: { from: new Date(now.getTime() - 60_000).toISOString(), until: new Date(now.getTime() + 3_600_000).toISOString() },
        interrupt_conditions: [],
        status: o.status ?? 'active',
      },
    },
  ]);
  return refs[1];
}

export function stagePolicy(h: Harness, eid: string, data_policy: EngagementPolicy['data_policy'], capacity: EngagementPolicy['capacity'] = { review_queue: 3, clarification_queue: 2, decisions_per_day: 20 }): void {
  const store = h.ws.store(eid, true);
  const eng = store.heads('engagement')[0];
  commit(h, eid, [
    {
      type: 'engagement',
      record_id: eng.record_id,
      base_revision: eng.revision,
      body: {
        ...eng.body,
        policy: {
          scope: ['src'],
          exclusions: [],
          attacker_charter: { capabilities: [], excluded: [], raised_roles: [], privileged_roles_trusted: true, notes: null },
          trusted_role_premise: 'Privileged roles are trusted.',
          data_policy,
          disclosure_constraints: [],
          retention: { policy: 'test', backup: 'git' },
          severity_rubric: 'test',
          rejection_listing_threshold: 'medium',
          budget: { unit: 'USD', total: 100 },
          evidence_policy: 'test',
          capacity,
          time_plan: 'test',
        },
      },
    },
  ]);
}

/** Stage a running attempt for a job as if a previous runner had crashed mid-run. */
export function stageCrashedAttempt(h: Harness, eid: string, attemptId: string, pid: number): void {
  const store = h.ws.store(eid, true);
  const att = store.mustHead(attemptId, 'attempt');
  const job = store.get(att.body.job, 'job');
  const jobHead = store.mustHead(job.record_id, 'job');
  commit(h, eid, [
    {
      type: 'attempt',
      record_id: attemptId,
      base_revision: att.revision,
      body: {
        ...att.body,
        status: 'running',
        started_at: new Date(Date.now() - 5000).toISOString(),
        pid,
        grant: { digest: 'sha256:' + '1'.repeat(64), operations: [], expires_at: new Date(Date.now() + 600_000).toISOString(), revoked: false },
      },
    },
    { type: 'job', record_id: jobHead.record_id, base_revision: jobHead.revision, body: { ...jobHead.body, status: 'running' } },
  ]);
}

export const COUNTER_SOL = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract Counter {
  uint256 public n;
  function inc() external { n += 1; }
}
`;

export const COUNTER_TEST_SOL = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import "../src/Counter.sol";
contract CounterTest {
  Counter c;
  function setUp() public { c = new Counter(); }
  function testIncrements() public { c.inc(); require(c.n() == 1, "n != 1"); }
  function testDoubleIncrementViolation() public { c.inc(); require(c.n() == 2, "violation not reached"); }
}
`;

/** Revise an investigation's head (disposition / work state) as the decision layer would. */
export function stageInvestigationState(h: Harness, eid: string, inv: Ref, patch: Record<string, unknown>): void {
  const head = h.ws.store(eid, true).mustHead(inv.record_id, 'investigation');
  commit(h, eid, [{ type: 'investigation', record_id: head.record_id, base_revision: head.revision, body: { ...head.body, ...patch } as never }]);
}

/** A context manifest built by the controller's context builder for `role` (and investigation). */
export function contextFor(h: Harness, eid: string, role: string, investigation: Ref | null = null, extra: Record<string, unknown> = {}): { artifact: string } {
  return h.auditor.do(eid, 'build_context', { role, investigation, ...extra }).context_manifest;
}
