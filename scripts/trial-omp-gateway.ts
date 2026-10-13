// Live trial of the omp gateway as the provider broker's upstream (docs/omp-gateway-trial.md).
// It makes REAL model calls on the operator's plans through the dedicated omp profile, against the
// synthetic vault fixture only (never client code), in a throwaway workspace:
//
//   1. comprehension round on Claude, 2. comprehension round on GPT,
//   3. investigator round on Claude, 4. challenger round on GPT (the same investigation),
//
// and records, per round, the attempt, the provider calls the broker admitted, the plan windows the
// gateway reported, what the agent proposed, and the live agent-run conformance checks. Run:
//
//   node scripts/trial-omp-gateway.ts [--claude M] [--gpt M] [--profile P] [--omp BIN] [--version V] [--out FILE] [--keep]

import { cpSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { makeHarness } from '../test/helpers.ts';
import { acceptPolicy, display, head, LIMITS, policy } from '../test/decision-fixtures.ts';
import { checkLiveAgentRun } from '../src/runner/conformance.ts';
import { OmpGateway, OmpGatewayProvider, ProviderBroker, runQueue } from '../src/runner/index.ts';
import { roleProfile } from '../src/controller/roles.ts';
import type { Ref } from '../src/core/refs.ts';

const { values } = parseArgs({
  options: {
    claude: { type: 'string', default: 'anthropic/claude-haiku-5-5' },
    gpt: { type: 'string', default: 'openai-codex/gpt-5.6-luna' },
    profile: { type: 'string', default: 'harness' },
    omp: { type: 'string' },
    version: { type: 'string', default: '18.10.1' },
    out: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
const ompBin = values.omp ?? realpathSync(execFileSync('sh', ['-c', 'command -v omp'], { encoding: 'utf8' }).trim());
const PROVIDERS = ['omp-anthropic', 'omp-openai-codex'];
const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures');

const h = makeHarness();
const gateway = new OmpGateway({ binary: ompBin, version: values.version!, profile: values.profile! });
const summary: Record<string, unknown> = { started_at: new Date().toISOString(), omp: { binary: ompBin, version: values.version, profile: values.profile }, models: { claude: values.claude, gpt: values.gpt }, rounds: [] as unknown[] };

const planOf = async () =>
  (await gateway.usage()).map((r) => ({
    provider: r.provider,
    plan_type: r.metadata?.planType ?? null,
    windows: (r.limits ?? []).map((l) => `${l.label}: ${Math.round((l.amount?.usedFraction ?? NaN) * 100)}%`),
  }));

try {
  summary.plan_before = await planOf();
  const eid = 'omp-trial';
  const store = () => h.ws.store(eid, true);
  const target = join(h.dir, 'target');
  cpSync(join(FIXTURES, 'vault'), target, { recursive: true });
  h.auditor.do(eid, 'create_engagement', { name: 'omp gateway trial (synthetic vault)', owner: 'auditor', audit_purpose: 'provider trial' });
  acceptPolicy(h, eid, policy({ data_policy: { live_exploitable_class: 'unfixed-findings', approved_providers: PROVIDERS, data_classes: ['source'] } }));
  const reg = h.auditor.do(eid, 'register_snapshot', { path: target, label: 'v1' });
  const eng = head(h, eid, 'eng-0001');
  const intake = h.screen.do(eid, 'authorize_work', {
    reviewed: [eng],
    display_receipt: display(h, eid, [eng]),
    inputs: { kind: 'intake', capabilities: { tools: ['forge_build', 'reference_agent'], providers: PROVIDERS, network: 'denied' }, limits: { ...LIMITS, rounds: 2, runtime_seconds: 3600 } },
    rationale: 'build and two seeding rounds, one per provider',
    rationale_authorship: 'human_written',
  }).work_authorization as Ref;
  h.auditor.do(eid, 'request_job', { authorization: intake, ...reg.build_request, limits: { runtime_seconds: 300 } });
  await runQueue(h.controller, eid);
  const snap = () => store().headRef(reg.snapshot.record_id);

  const broker = new ProviderBroker(h.controller, { timeoutMs: 180_000, liveExploitableProviders: PROVIDERS });
  broker.registerSelfAuthenticating(new OmpGatewayProvider(gateway, { name: 'omp-anthropic', upstream: 'anthropic', models: [values.claude!] }));
  broker.registerSelfAuthenticating(new OmpGatewayProvider(gateway, { name: 'omp-openai-codex', upstream: 'openai-codex', models: [values.gpt!] }));

  const round = async (label: string, role: string, auth: Ref, model: string, task: string, investigation: Ref | null = null) => {
    const ctx = h.auditor.do(eid, 'build_context', { role: roleProfile(role).contextRole, investigation: investigation ? store().headRef(investigation.record_id) : null, source_paths: ['src/Vault.sol'] });
    const job = h.auditor.do(eid, 'request_job', { authorization: auth, purpose: 'agent', adapter: 'reference_agent', role, snapshot: snap(), investigation, context_manifest: ctx.context_manifest, args: { task, model, max_turns: 8 }, limits: { runtime_seconds: 600 } });
    const t0 = Date.now();
    const ran = await runQueue(h.controller, eid);
    const s = store();
    const agentRun = ran.ran.find((r) => r.job === job.job.record_id);
    const attempt = agentRun?.attempt ? s.mustHead(agentRun.attempt.record_id, 'attempt') : null;
    const calls = s
      .heads('ledger_entry')
      .filter((e) => attempt && e.body.attempt?.record_id === attempt.record_id && e.body.kind !== 'reservation' && e.body.kind !== 'release' && e.body.note.includes('provider_call'))
      .map((e) => {
        const c = JSON.parse(e.body.note).provider_call;
        const plan = c.response ? (s.archive.getJson<{ plan?: { windows: { label: string; used_fraction: number }[] } }>(c.response).plan ?? null) : null;
        return { call_id: c.id as string, provider: c.provider, model_requested: c.model_requested, model_returned: c.model_returned ?? null, outcome: c.outcome, data_class: c.data_class, notional_usd: Number(e.body.spend.toFixed(4)), plan_before_call: plan?.windows.map((w) => `${w.label}: ${Math.round(w.used_fraction * 100)}%`) ?? null };
      });
    const evidence = attempt ? s.heads('evidence_artifact').find((e) => e.body.attempt?.record_id === attempt.record_id) : undefined;
    const outbox = evidence?.body.limitations.find((l) => l.startsWith('outbox: ')) ?? 'outbox: none';
    const proposals_refused = attempt
      ? s
          .events()
          .filter((e) => e.kind === 'worker_request_refused' && (e.result as { attempt?: string }).attempt === attempt.record_id)
          .map((e) => `${(e.result as { file: string }).file}: ${(e.result as { reason: string }).reason}`)
      : [];
    const callIds = new Set(calls.map((c) => c.call_id));
    const refused = s.events().filter((e) => e.kind === 'provider_call_outcome' && callIds.has((e.result as { call_id: string }).call_id) && (e.result as { outcome: string }).outcome !== 'completed').map((e) => e.result);
    const conformance = (await checkLiveAgentRun(h.controller, eid, job.job.record_id)).map((r) => `${r.check}: ${r.status}`);
    const entry = { label, role, model, job: job.job.record_id, attempt: attempt?.record_id ?? null, status: attempt?.body.status ?? agentRun?.status ?? 'not run', reason: attempt?.body.reason ?? null, seconds: Math.round((Date.now() - t0) / 1000), provider_calls: calls, outbox, proposals_refused, refused_calls: refused, conformance, other_jobs_run: ran.ran.filter((r) => r.job !== job.job.record_id).map((r) => `${s.mustHead(r.job, 'job').body.purpose}: ${r.status}`) };
    (summary.rounds as unknown[]).push(entry);
    console.error(`[trial] ${label}: ${entry.status}, ${calls.length} call(s), ${outbox}`);
    return entry;
  };

  await round('1 comprehension / Claude', 'comprehension', intake, values.claude!, 'Seed the withdrawal flow: purpose, states and transitions, with anchors. Propose an audit unit for it.');
  await round('2 comprehension / GPT', 'comprehension', intake, values.gpt!, 'Seed the deposit flow: purpose, states and transitions, with anchors. Propose an audit unit for it.');

  // The auditor reviews a flow and admits an investigation (the script plays the auditor).
  const units = store().heads('audit_unit');
  const unit = units.find((u) => /withdraw/i.test(u.body.name)) ?? units[0] ?? store().get(h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'withdrawal' } }).audit_unit as Ref, 'audit_unit');
  const unitRef = { record_id: unit.record_id, revision: unit.revision };
  h.screen.do(eid, 'record_decision', { decision_kind: 'record_flow_review', reviewed: [unitRef], display_receipt: display(h, eid, [unitRef], [], [unitRef]), inputs: { audit_unit: unitRef, reviewed_functions: ['Vault.withdraw', 'Vault.deposit'] }, rationale: 'trial: flow walked', rationale_authorship: 'human_written' });
  const inv = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'scenario', question: 'Can a reentrant callback during withdraw pay out twice?', audit_units: [head(h, eid, unit.record_id)], guarantees: ['withdraw pays at most the caller balance'], potential_impact: 'high' } }).investigation as Ref;
  const invHead = head(h, eid, inv.record_id);
  const batch = h.screen.do(eid, 'authorize_work', {
    reviewed: [invHead],
    display_receipt: display(h, eid, [invHead]),
    inputs: { kind: 'batch', investigations: [invHead], methods: ['scenario'], capabilities: { tools: ['forge_test', 'reference_agent'], providers: PROVIDERS, network: 'denied' }, limits: { ...LIMITS, runtime_seconds: 3600 } },
    rationale: 'trial: admit with agent assistance on both providers',
    rationale_authorship: 'human_written',
  }).work_authorization as Ref;

  await round('3 investigator / Claude', 'investigator', batch, values.claude!, 'Draft the callback scenario, write a Foundry PoC fixture for it, request the experiment, and record your author position.', inv);
  await round('4 challenger / GPT', 'challenger', batch, values.gpt!, 'Challenge the callback claim independently and record your challenger position.', inv);

  summary.positions = store()
    .heads('position')
    .map((p) => ({ role: p.body.role, submitted_by: p.body.submitted_by.worker_role ?? p.body.submitted_by.channel, model: p.body.model, provider: p.body.provider, text: store().archive.getText(p.body.content.artifact).slice(0, 400) }));
  summary.plan_after = await planOf();
} catch (e) {
  summary.error = (e as Error).stack ?? String(e);
} finally {
  gateway.close();
  summary.finished_at = new Date().toISOString();
  summary.workspace = values.keep ? h.dir : null;
  const text = JSON.stringify(summary, null, 2);
  if (values.out) writeFileSync(values.out, text + '\n');
  console.log(text);
  if (!values.keep) h.cleanup();
}
