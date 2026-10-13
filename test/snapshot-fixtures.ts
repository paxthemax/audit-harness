// Test-only fixtures for the snapshot module. Records the lead's modules normally create
// (investigations, findings, units, authorizations, jobs) are committed straight through
// `store.commit`; a test-only operation stands in for the runner's `complete_attempt` so the build
// and probe completion hooks run in a real controller transaction. Nothing here is production code.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AnyRef, Ref } from '../src/core/refs.ts';
import { defineOperation } from '../src/controller/controller.ts';
import { completionHooks } from '../src/runner/hooks.ts';
import type { PendingRecord } from '../src/store/recordStore.ts';
import type {
  Anchor,
  AuditUnitBody,
  BodyByType,
  EvidenceArtifactBody,
  FindingBody,
  InvestigationBody,
  JobBody,
  JobPurpose,
  Limits,
  RecordEnvelope,
  RecordType,
  StructuredResult,
  WorkAuthorizationBody,
} from '../src/schema/records.ts';
import type { Harness } from './helpers.ts';

export const LIMITS: Limits = {
  spend: 0,
  runtime_seconds: 600,
  concurrency: 1,
  child_tasks: 0,
  rounds: 1,
  retries: 0,
  repairs_per_variant: 0,
  output_bytes: 1_000_000,
  memory_mb: 1024,
  processes: 16,
};

export const FAKE_DECISION: Ref = { record_id: 'dec-0999', revision: 1 };

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

export function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
}

export function gitProject(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  writeFiles(dir, files);
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, '.gitignore'), 'out/\ncache/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** Run a real Foundry build of a test fixture (tests only; production builds are runner jobs). */
export function forgeBuild(dir: string): { ok: boolean; out: string; stderr: string } {
  try {
    execFileSync('forge', ['build', '--ast', '--extra-output', 'storageLayout', '--offline'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: join(dir, 'out'), stderr: '' };
  } catch (e) {
    return { ok: false, out: join(dir, 'out'), stderr: String((e as { stderr?: string }).stderr ?? e) };
  }
}

export const FOUNDRY_TOML = `[profile.default]
src = "src"
out = "out"
solc = "0.8.30"
optimizer = true
optimizer_runs = 200
evm_version = "cancun"
offline = true
`;

/** A small vault. `guard` keeps nonReentrant on withdraw; `fix` adds a base variable and a function. */
export function vaultSource(opts: { guard?: boolean; sweep?: boolean; fix?: boolean } = {}): string {
  const guard = opts.guard ?? true;
  const sweep = opts.sweep ?? true;
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

abstract contract Base {
    uint256 public baseSlot;
${opts.fix ? '    uint256 public fee;\n' : ''}    address internal owner;
    modifier onlyOwner() { require(msg.sender == owner, "owner"); _; }
}

contract Vault is Base {
    mapping(address => uint256) public balances;
    bool private locked;

    modifier nonReentrant() { require(!locked); locked = true; _; locked = false; }

    constructor() { owner = msg.sender; }

    function deposit() external payable { balances[msg.sender] += msg.value; }

    function withdraw(uint256 amt) external${guard ? ' nonReentrant' : ''} {
${opts.fix ? '        require(amt > 0, "zero");\n' : ''}        balances[msg.sender] -= amt;
        (bool ok, ) = msg.sender.call{value: amt}("");
        require(ok);
    }
${sweep ? `
    function sweep(address to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok);
    }
` : ''}${opts.fix ? `
    function emergencyWithdraw() external {
        uint256 b = balances[msg.sender];
        balances[msg.sender] = 0;
        payable(msg.sender).transfer(b);
    }
` : ''}
    function exec(address t, bytes calldata d) public onlyOwner returns (bytes memory) {
        (bool ok, bytes memory r) = t.delegatecall(d);
        require(ok);
        return r;
    }

    function peek(address t) external view returns (uint256 s) {
        assembly { s := extcodesize(t) }
        (bool ok, ) = t.staticcall("");
        ok;
    }
}
`;
}

// ------------------------------------------------------------------------------------------------
// Direct fixture commits

export function commitRecords(h: Harness, eid: string, records: { type: RecordType; body: unknown; depends_on?: AnyRef[]; record_id?: string; base_revision?: number }[]): Ref[] {
  const store = h.ws.store(eid, true);
  const res = store.commit({
    records: records.map((r) => ({ type: r.type, record_id: r.record_id, base_revision: r.base_revision ?? 0, body: r.body, depends_on: r.depends_on ?? [] }) as PendingRecord),
    events: [{ kind: 'test_fixture', operation: 'test_fixture', request_id: `fixture-${Date.now()}`, idempotency_key: null, request_digest: null, result: {} }],
    principal: { channel: 'controller', principal: 'test-fixture' },
    origin: { operation: 'test_fixture', request_id: 'fixture', job: null, attempt: null, decision: null },
    now: new Date().toISOString(),
    message: 'test fixture',
  });
  h.ws.noteCommitted?.(eid);
  return res.refs;
}

export function reviseRecord<T extends RecordType>(h: Harness, eid: string, id: string, type: T, update: (b: BodyByType[T]) => BodyByType[T]): Ref {
  const store = h.ws.store(eid, true);
  const head = store.mustHead(id, type);
  return commitRecords(h, eid, [{ type, record_id: id, base_revision: head.revision, body: update(structuredClone(head.body)), depends_on: head.depends_on }])[0];
}

export function authorizationBody(kind: WorkAuthorizationBody['kind'] = 'revalidation'): WorkAuthorizationBody {
  return {
    kind,
    decision: FAKE_DECISION,
    reviewed: [],
    snapshot: null,
    investigations: [],
    methods: [],
    attacker_charter: null,
    capabilities: { tools: [], providers: [], network: 'denied' },
    limits: LIMITS,
    validity: null,
    interrupt_conditions: [],
    status: 'active',
  };
}

export function investigationBody(over: Partial<InvestigationBody> = {}): InvestigationBody {
  return {
    method: 'hypothesis',
    question: 'Can withdraw be re-entered to drain the vault?',
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
    work_state: 'closed',
    blocked_reason: null,
    disposition: { value: 'rejected', decision: FAKE_DECISION },
    proof_status: { provenance: 'complete', prerequisite_review: 'accepted', adequacy: 'sufficient', adequacy_reason: null, replay: 'not_required', positive_control: 'shows_violation' },
    probes: [],
    lineage: null,
    ...over,
  };
}

export function anchor(path: string, symbol: string | null): Anchor {
  return { path, symbol, start: null, length: null, content_digest: null, snapshot: null };
}

export function findingBody(investigation: Ref, over: Partial<FindingBody> = {}): FindingBody {
  return {
    investigation,
    linked_claim_id: null,
    guarantee: 'withdrawals pay out at most the entitlement',
    title: 'Reentrancy in withdraw',
    mechanism: 'external call before effects',
    prerequisites: [],
    impact: 'drain',
    affected_code: [anchor('src/Vault.sol', 'Vault.withdraw')],
    severity: 'High',
    severity_basis: 'rubric',
    evidence_route: 'code_argument',
    acceptance: FAKE_DECISION,
    applicability: 'reviewed snapshot',
    client_responses: [],
    fix_assessments: [],
    ...over,
  };
}

export function unitBody(over: Partial<AuditUnitBody> = {}): AuditUnitBody {
  return {
    kind: 'flow',
    name: 'withdraw flow',
    entry_points: ['Vault.withdraw'],
    state_writers: [],
    dependencies: [],
    risk_rationale: 'moves funds',
    planned_methods: [],
    lead_generator_coverage: [],
    functions: [{ name: 'Vault.withdraw', reviewed: true }],
    reviewed_revision: null,
    review_status: 'reviewed',
    first_presentation: null,
    evidence: [],
    gaps: [],
    ...over,
  };
}

// ------------------------------------------------------------------------------------------------
// Stand-in for the runner's complete_attempt: stage a job + evidence and run the completion hooks.

export interface CompleteJobPayload {
  snapshot: Ref;
  authorization: Ref;
  purpose: JobPurpose;
  /** Directory to archive as the `out` tree (build), or null. */
  out_dir?: string | null;
  exit_code: number;
  structured_result?: StructuredResult | null;
  /** Existing job to complete (e.g. a probe job attached to a probe); created when absent. */
  job?: string | null;
}

let defined = false;
export function defineTestCompletion(): void {
  if (defined) return;
  defined = true;
  defineOperation<CompleteJobPayload>({
    name: 'test_snapshot_complete_job',
    channels: ['runner'],
    mutating: true,
    handler(ctx, p) {
      const status = p.exit_code === 0 ? 'completed' : 'failed';
      const jobBody: JobBody = {
        authorization: p.authorization,
        context_manifest: null,
        role: 'runner',
        purpose: p.purpose,
        adapter: { name: p.purpose === 'build' ? 'forge_build' : 'forge_test', version: 'test', descriptor: 'test' },
        operation: p.purpose === 'build' ? 'build' : 'test',
        args: {},
        snapshot: p.snapshot,
        fixture: null,
        input_digest: 'test',
        investigation: null,
        variant: null,
        limits: LIMITS,
        reservation: { spend: 0, runtime_seconds: 0 },
        lineage: null,
        guard_removal: null,
        status,
        attempts: [],
      };
      let jobRef: Ref;
      let body = jobBody;
      if (p.job) {
        jobRef = ctx.tx.revise(p.job, 'job', (b) => ({ ...b, status }));
        body = ctx.tx.current<'job'>(p.job, 'job').body;
      } else jobRef = ctx.tx.create('job', jobBody);
      const outputs = [];
      if (p.out_dir) {
        const t = ctx.archive.putTree(p.out_dir);
        for (const d of Object.values(t.manifest.files)) ctx.tx.blob(d);
        ctx.tx.blob(t.ref);
        outputs.push({ path: 'out', artifact: t.ref });
      }
      const empty = ctx.archive.put('');
      ctx.tx.blob(empty);
      const now = ctx.now;
      const evidenceBody: EvidenceArtifactBody = {
        content: empty,
        producer: 'trusted_runner',
        job: jobRef,
        attempt: null,
        receipt: {
          runner: { identity: 'test-runner', version: '0' },
          sandbox: { kind: 'test', network: 'denied', descriptor: '' },
          argv: ['forge'],
          cwd: '/',
          executable: { path: 'forge', digest: null, version: null },
          env_keys: [],
          started_at: now,
          ended_at: now,
          exit_code: p.exit_code,
          signal: null,
          timed_out: false,
          stdout: empty,
          stderr: empty,
          stdout_truncated: false,
          stderr_truncated: false,
          outputs,
        },
        snapshot: p.snapshot,
        fixture: null,
        structured_result: p.structured_result ?? { result_type: p.exit_code === 0 ? 'no_violation_observed' : 'error', mode: 'build', bounds: null, interpretation: p.exit_code === 0 ? 'build ok' : 'compilation failed', tests: [] },
        environment_sensitive: { flagged: false, reads: [] },
        positive_control_for: null,
        missing_or_truncated: [],
        limitations: [],
        eligible: p.exit_code === 0,
        description: 'test job',
      };
      const evidence = ctx.tx.create('evidence_artifact', evidenceBody, [p.snapshot]);
      const env = {
        schema_version: 1,
        scope: ctx.store.scope,
        record_id: jobRef.record_id,
        type: 'job',
        revision: jobRef.revision,
        created_at: now,
        created_by: { channel: 'runner', principal: 'trusted-runner' },
        origin: { operation: 'test', request_id: 'test', job: null, attempt: null, decision: null },
        visibility: 'engagement',
        depends_on: [],
        body: { ...body, status },
      } as RecordEnvelope<'job'>;
      for (const hook of completionHooks(p.purpose)) hook(ctx, { job: env, attempt: { record_id: 'att-9999', revision: 1 }, evidence, evidenceBody });
      return { job: jobRef, evidence };
    },
  });
}

/** Display receipt from the trusted screen for exact revisions, then a decision. */
export function decide(h: Harness, eid: string, kind: string, reviewed: Ref[], inputs: Record<string, unknown>): any {
  const now = new Date().toISOString();
  const { display_receipt } = h.screen.do(eid, 'record_display', { rendered: reviewed, sections: [], started_at: now, ended_at: now });
  return h.screen.do(eid, 'record_decision', {
    decision_kind: kind,
    reviewed,
    display_receipt,
    inputs,
    rationale: 'Reviewed on the trusted screen.',
    rationale_authorship: 'human_written',
  });
}
