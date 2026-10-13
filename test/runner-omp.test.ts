// The omp credential gateway as the broker's upstream (src/runner/ompGateway.ts), against a stand-in
// gateway process: the broker holds no credential, every call still passes request_provider_call, the
// plan's usage windows gate each call and are archived with the response, and failures map onto the
// broker's outcomes (refused before sending, or outcome unknown after a crash).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHarness, newEngagement } from './helpers.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { Controller } from '../src/controller/controller.ts';
import { referenceAgentAdapter, registerAdapter } from '../src/runner/adapters.ts';
import { ProviderBroker } from '../src/runner/provider.ts';
import { OmpGateway, OmpGatewayProvider } from '../src/runner/ompGateway.ts';
import { spendSummary } from '../src/runner/ledger.ts';
import { COUNTER_SOL, COUNTER_TEST_SOL, contextFor, foundryProject, stageAuthorization, stageInvestigation, stagePolicy, stageSnapshot } from './runner-fixtures.ts';

registerAdapter(referenceAgentAdapter({ name: 'stub_agent_omp', agentDir: fileURLToPath(new URL('./fixtures/agent-stub/', import.meta.url)), registered_by: 'operator' }));

const FAKE_GATEWAY = fileURLToPath(new URL('./fixtures/fake-omp-gateway.ts', import.meta.url));
const PROVIDERS = ['omp-anthropic', 'omp-openai-codex'];
const CLAUDE = 'anthropic/claude-haiku-5-5';
const GPT = 'openai-codex/gpt-5.6-luna';

function setup(env: Record<string, string> = {}, approved: string[] = PROVIDERS) {
  const h = makeHarness();
  const eid = newEngagement(h);
  const snapshot = stageSnapshot(h, eid, foundryProject(join(h.dir, 'project'), { 'src/Counter.sol': COUNTER_SOL, 'test/Counter.t.sol': COUNTER_TEST_SOL }), true);
  const inv = stageInvestigation(h, eid);
  stagePolicy(h, eid, { live_exploitable_class: 'unfixed', approved_providers: approved, data_classes: ['source'] });
  const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], providers: approved, tools: ['forge_test', 'stub_agent_omp'], limits: { spend: 5 } });
  const log = join(h.dir, 'gateway.log');
  const gateway = new OmpGateway({ binary: '/nonexistent/omp', version: '18.10.1', profile: 'harness-test', command: [process.execPath, FAKE_GATEWAY], env: { FAKE_OMP_LOG: log, ...env }, usageTtlMs: 0 });
  const broker = new ProviderBroker(h.controller, { liveExploitableProviders: PROVIDERS });
  broker.registerSelfAuthenticating(new OmpGatewayProvider(gateway, { name: 'omp-anthropic', upstream: 'anthropic', models: [CLAUDE] }));
  broker.registerSelfAuthenticating(new OmpGatewayProvider(gateway, { name: 'omp-openai-codex', upstream: 'openai-codex', models: [GPT] }));
  const job = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'agent', role: 'investigator', adapter: 'stub_agent_omp', snapshot, investigation: inv, context_manifest: contextFor(h, eid, 'investigator', inv), args: { task: 't', model: CLAUDE } });
  const { token, digest } = Controller.newWorkerToken();
  h.runner.do(eid, 'start_attempt', { job: job.job.record_id, grant_digest: digest });
  const session = h.controller.worker(eid, token);
  const call = (model: string, text = 'hi') => {
    const messages_request = h.ws.store(eid, true).archive.putJson({ format: 'harness.provider_messages_request/1', body: { model, max_tokens: 100, messages: [{ role: 'user', content: text }] } });
    const r = session.do(eid, 'request_provider_call', { messages_request });
    return broker.executeMessages(eid, r.call_id);
  };
  const logLines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const done = () => {
    gateway.close();
    h.cleanup();
  };
  return { h, eid, batch, gateway, broker, session, call, logLines, done };
}

test('omp gateway: Claude and GPT calls pass the broker, which holds no credential and archives the plan windows', async () => {
  const S = setup();
  try {
    const claude = await S.call(CLAUDE);
    assert.equal(claude.outcome, 'completed');
    assert.equal(claude.model_returned, CLAUDE);
    assert.deepEqual((claude.body!.content as { text: string }[])[0].text, 'fake gateway reply');
    const archived = S.h.ws.store(S.eid, true).archive.getJson<{ plan: { provider: string; plan_type: string; windows: { label: string; used_fraction: number }[] } }>(claude.response!.artifact);
    assert.equal(archived.plan.provider, 'anthropic');
    assert.equal(archived.plan.plan_type, 'team');
    assert.deepEqual(archived.plan.windows.map((w) => [w.label, w.used_fraction]), [['Claude 5 Hour', 0.1], ['Claude 7 Day', 0.05]]);
    assert.ok(!JSON.stringify(archived).includes('example.invalid'), 'no account identifiers are archived');

    const gpt = await S.call(GPT);
    assert.equal(gpt.outcome, 'completed');
    assert.equal(gpt.spend_status, 'confirmed', 'notional cost from the reported usage');

    const lines = S.logLines();
    const starts = lines.filter((l) => l.start);
    assert.equal(starts.length, 1, 'one gateway process serves both providers');
    assert.equal(starts[0].profile, 'harness-test', 'the dedicated omp profile is selected');
    assert.ok(!starts[0].cwd.startsWith(S.h.dir), 'the gateway runs outside the workspace');
    assert.ok(!starts[0].env_keys.some((k: string) => /KEY|TOKEN|SECRET/.test(k) && k !== 'FAKE_OMP_LOG'), 'no credential is passed to the gateway');
    const sent = lines.filter((l) => l.request?.path === '/v1/messages').map((l) => l.request.body.model);
    assert.deepEqual(sent, [CLAUDE, GPT]);
  } finally {
    S.done();
  }
});

test('omp gateway: a model of an unapproved upstream never reaches the gateway', async () => {
  const S = setup({}, ['omp-anthropic']);
  try {
    const messages_request = S.h.ws.store(S.eid, true).archive.putJson({ format: 'harness.provider_messages_request/1', body: { model: GPT, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
    assert.throws(() => S.session.do(S.eid, 'request_provider_call', { messages_request }), (e) => isHarnessError(e, 'egress_denied'));
    assert.throws(() => new OmpGatewayProvider(S.gateway, { name: 'x', upstream: 'anthropic', models: [GPT] }), /not an anthropic model/);
  } finally {
    S.done();
  }
});

for (const [name, env, reason] of [
  ['an unpinned omp version', { FAKE_OMP_VERSION: '18.11.0' }, /not the pinned version 18\.10\.1/],
  ['a profile without the login', { FAKE_OMP_REPORTS: 'none' }, /has no anthropic login/],
  ['a plan window past the headroom', { FAKE_OMP_USED: '0.85' }, /"Claude 5 Hour" is 85% used; the headroom limit is 80%/],
  ['an error reply', { FAKE_OMP_MODE: 'error' }, /omp gateway returned 400 .*extra usage/],
] as const) {
  test(`omp gateway: ${name} is refused before anything is charged`, async () => {
    const S = setup(env as Record<string, string>);
    try {
      const out = await S.call(CLAUDE);
      assert.equal(out.outcome, 'failed_before_send');
      assert.match(out.reason!, reason);
      assert.equal(out.spend_status, 'released');
      assert.equal(spendSummary(S.h.ws.store(S.eid, true), S.batch.record_id).estimated, 0);
    } finally {
      S.done();
    }
  });
}

test('omp gateway: an upstream failure relayed as 5xx leaves the outcome unknown and the reservation held', async () => {
  const S = setup({ FAKE_OMP_MODE: 'upstream' });
  try {
    const out = await S.call(CLAUDE);
    assert.equal(out.outcome, 'outcome_unknown');
    assert.match(out.reason!, /omp gateway returned 502 .*closed unexpectedly/);
    assert.equal(out.spend_status, 'uncertain');
  } finally {
    S.done();
  }
});

test('omp gateway: a crash after the request was sent leaves the outcome unknown and the reservation held; the next call restarts it', async () => {
  const S = setup({ FAKE_OMP_MODE: 'crash' });
  try {
    const out = await S.call(CLAUDE);
    assert.equal(out.outcome, 'outcome_unknown');
    assert.match(out.reason!, /omp gateway exited/);
    assert.equal(out.spend_status, 'uncertain');
    const again = await S.call(CLAUDE, 'second request');
    assert.equal(again.outcome, 'outcome_unknown');
    assert.equal(S.logLines().filter((l) => l.start).length, 2, 'the gateway was started again');
  } finally {
    S.done();
  }
});

test('omp gateway: a broker without the gateway providers refuses calls for them', () => {
  const S = setup();
  try {
    new ProviderBroker(S.h.controller, { liveExploitableProviders: PROVIDERS }).activate();
    const messages_request = S.h.ws.store(S.eid, true).archive.putJson({ format: 'harness.provider_messages_request/1', body: { model: CLAUDE, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
    assert.throws(() => S.session.do(S.eid, 'request_provider_call', { messages_request }), (e) => isHarnessError(e, 'egress_denied'));
  } finally {
    S.done();
  }
});
