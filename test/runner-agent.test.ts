import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHarness, newEngagement } from './helpers.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { referenceAgentAdapter, registerAdapter } from '../src/runner/adapters.ts';
import { runJob } from '../src/runner/runner.ts';
import { FakeProvider, ProviderBroker, ProviderRejected } from '../src/runner/provider.ts';
import { AnthropicProvider } from '../src/runner/anthropic.ts';
import { spendSummary } from '../src/runner/ledger.ts';
import { COUNTER_SOL, COUNTER_TEST_SOL, contextFor, foundryProject, stageAuthorization, stageInvestigation, stagePolicy, stageSnapshot } from './runner-fixtures.ts';

// Agent hosts: the reference-agent adapter contract (task, context, outbox, broker socket and TCP
// forwarder), run against a stub runtime with the same contract, plus the Anthropic provider mapping.

registerAdapter(referenceAgentAdapter({ name: 'stub_agent', agentDir: fileURLToPath(new URL('./fixtures/agent-stub/', import.meta.url)), registered_by: 'operator' }));

function setup(providers = ['fake']) {
  const h = makeHarness();
  const eid = newEngagement(h);
  const snapshot = stageSnapshot(h, eid, foundryProject(join(h.dir, 'project'), { 'src/Counter.sol': COUNTER_SOL, 'test/Counter.t.sol': COUNTER_TEST_SOL }), true);
  const inv = stageInvestigation(h, eid);
  stagePolicy(h, eid, { live_exploitable_class: 'unfixed', approved_providers: providers, data_classes: ['source'] });
  const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], providers, tools: ['stub_agent', 'reference_agent'] });
  return { h, eid, snapshot, inv, batch };
}

function stubLines(h: ReturnType<typeof makeHarness>, eid: string, evidence: { record_id: string; revision: number }): Record<string, any> {
  const s = h.ws.store(eid, true);
  const ev = s.get(evidence, 'evidence_artifact').body;
  const out: Record<string, any> = {};
  for (const line of s.archive.getText(ev.receipt!.stdout.artifact).split('\n')) {
    const m = /^STUB (\S+) (.*)$/.exec(line);
    if (m) out[m[1]] = JSON.parse(m[2]);
  }
  return out;
}

const TOOL_USE = { content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_records', input: { type: 'investigation' } }], stop_reason: 'tool_use' };

test('an agent job runs with its task, context and outbox, and reaches the model only through the broker', async () => {
  const { h, eid, snapshot, inv, batch } = setup();
  try {
    const fake = new FakeProvider({ messages: [TOOL_USE, { content: [{ type: 'text', text: 'done' }] }] });
    // An investigator's manifest carries its open investigation: live-exploitable material.
    const broker = new ProviderBroker(h.controller, { timeoutMs: 2000, liveExploitableProviders: ['fake'] });
    broker.register(fake, 'cred-provider-xyz');
    const context_manifest = contextFor(h, eid, 'investigator', inv, { source_paths: ['src/Counter.sol'] });
    const req = { authorization: batch, purpose: 'agent', role: 'investigator', adapter: 'stub_agent', snapshot, investigation: inv, context_manifest, args: { task: 'Can a caller withdraw twice?', model: 'fake-model-1' } };
    // Agent jobs need a builder-made manifest for their own role, and an approved model.
    assert.throws(() => h.auditor.do(eid, 'request_job', { ...req, context_manifest: undefined }), (e) => isHarnessError(e, 'invalid_request'));
    assert.throws(() => h.auditor.do(eid, 'request_job', { ...req, context_manifest: contextFor(h, eid, 'challenger', inv) }), (e) => isHarnessError(e, 'invalid_request'));
    assert.throws(() => h.auditor.do(eid, 'request_job', { ...req, args: { ...req.args, model: 'other-model' } }), (e) => isHarnessError(e, 'permission_denied'));
    assert.throws(() => h.auditor.do(eid, 'request_job', { ...req, args: { ...req.args, shell: 'rm -rf /' } }), (e) => isHarnessError(e, 'invalid_request'));
    const job = h.auditor.do(eid, 'request_job', req);
    const out = await runJob(h.controller, eid, job.job.record_id);
    assert.equal(out.status, 'completed');
    const lines = stubLines(h, eid, out.evidence!);
    assert.deepEqual(lines.task, { role: 'investigator', model: 'fake-model-1', job: job.job.record_id, args: req.args, engagement: eid });
    assert.equal(lines.context.format, 'harness.context/1');
    assert.ok(lines.context.sources.includes('src/Counter.sol'));
    assert.deepEqual(lines.first, { status: 200, stop_reason: 'tool_use', model: 'fake-model-1@fake-2026-10', blocks: ['tool_use'] });
    assert.deepEqual(lines.wrong_model, { status: 403, code: 'egress_denied' });
    assert.deepEqual(lines.no_token, { status: 403, code: 'permission_denied' });
    assert.deepEqual(lines.server_tool, { status: 403, code: 'egress_denied' });
    assert.deepEqual(lines.via_forwarder, { status: 200, stop_reason: 'end_turn' });
    assert.equal(lines.egress, 'blocked');

    // The provider saw the broker's credential, never the grant token; two calls were recorded.
    assert.equal(fake.messageRequests.length, 2);
    assert.ok(fake.messageRequests.every((r) => r.credential === 'cred-provider-xyz'));
    const s = h.ws.store(eid, true);
    const calls = s.heads('ledger_entry').filter((e) => e.body.note.includes('"mode":"messages"'));
    assert.equal(calls.filter((e) => e.body.kind === 'reservation').length, 2);
    assert.equal(calls.filter((e) => e.body.kind === 'actual').length, 2);
    assert.ok(calls.every((e) => JSON.parse(e.body.note).provider_call.data_class === 'unfixed'));
    assert.ok(spendSummary(s, batch.record_id).confirmed > 0);
    // The scripted tool_use became an outbox request committed under the attempt's grant.
    assert.equal(s.events().filter((e) => e.kind === 'worker_request_refused').length, 0);
  } finally {
    h.cleanup();
  }
});

test('a provider timeout through the socket returns outcome_unknown (504) and keeps the reservation', async () => {
  const { h, eid, snapshot, inv, batch } = setup();
  try {
    const broker = new ProviderBroker(h.controller, { timeoutMs: 200, liveExploitableProviders: ['fake'] });
    broker.register(new FakeProvider({ messages: ['hang'] }), 'cred');
    const context_manifest = contextFor(h, eid, 'investigator', inv);
    const job = h.auditor.do(eid, 'request_job', { authorization: batch, purpose: 'agent', role: 'investigator', adapter: 'stub_agent', snapshot, investigation: inv, context_manifest, args: { task: 't', model: 'fake-model-1' } });
    const out = await runJob(h.controller, eid, job.job.record_id);
    const lines = stubLines(h, eid, out.evidence!);
    assert.equal(lines.first.status, 504);
    const s = h.ws.store(eid, true);
    assert.ok(s.heads('ledger_entry').some((e) => e.body.kind === 'uncertain' && e.body.note.includes('"mode":"messages"')));
    assert.ok(spendSummary(s, batch.record_id).uncertain > 0);
  } finally {
    h.cleanup();
  }
});

test('the Anthropic provider maps requests to the Messages API, accounts usage, and needs a 0600 credential', async () => {
  const { h, eid, inv, batch } = setup(['anthropic']);
  try {
    const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      if (JSON.parse(init.body).max_tokens === 1) return { ok: false, status: 400, json: async () => ({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), text: async () => '' };
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'msg_1', type: 'message', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 } }),
        text: async () => '',
      };
    };
    const provider = new AnthropicProvider({ fetch: fetch as never });
    const broker = new ProviderBroker(h.controller, { timeoutMs: 2000 });
    // No credential file: unavailable, never a fallback.
    assert.equal(broker.registerFromWorkspace(provider).available, false);
    const keyDir = join(h.ws.root, 'secrets', 'providers');
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(join(keyDir, 'anthropic.key'), 'sk-test-key\n', { mode: 0o644 });
    chmodSync(join(keyDir, 'anthropic.key'), 0o644);
    assert.match(broker.registerFromWorkspace(provider).reason!, /0600/);
    chmodSync(join(keyDir, 'anthropic.key'), 0o600);
    assert.equal(broker.registerFromWorkspace(provider).available, true);

    const s = h.ws.store(eid, true);
    const src = Object.values(s.archive.getTree(s.heads('target_snapshot')[0].body.tree.artifact).files)[0];
    const r = await broker.call(h.auditor, eid, { authorization: batch, provider: 'anthropic', model: 'claude-opus-5-5', context: [{ artifact: src }], max_output_tokens: 300, purpose: 'Summarize' });
    assert.equal(r.outcome, 'completed');
    assert.equal(r.model_returned, 'claude-opus-5-5');
    assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(seen[0].headers['x-api-key'], 'sk-test-key');
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(seen[0].body.model, 'claude-opus-5-5');
    assert.equal(seen[0].body.max_tokens, 300);
    assert.equal(seen[0].body.messages[0].content.at(-1).text, 'Summarize');
    const sum = spendSummary(h.ws.store(eid, true), batch.record_id);
    assert.equal(sum.confirmed, (1000 * 4 + 500 * 0.2 + 200 * 20) / 1e6);
    // An error response is a definite refusal (nothing billed): rejected, reservation released.
    await assert.rejects(provider.messages({ model: 'claude-opus-5-5', max_tokens: 1, messages: [] }, 'k', new AbortController().signal), (e) => e instanceof ProviderRejected);
    // An unknown model has no rate: refused rather than guessed.
    await assert.rejects(provider.messages({ model: 'claude-unknown', max_tokens: 10, messages: [] }, 'k', new AbortController().signal), (e) => e instanceof ProviderRejected);
    assert.ok(inv);
  } finally {
    h.cleanup();
  }
});

test('agent jobs are rounds: new logical agent jobs past limits.rounds are refused; retries are not rounds', async () => {
  const { h, eid, snapshot, inv } = setup();
  try {
    new ProviderBroker(h.controller).register(new FakeProvider(), 'cred');
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], providers: ['fake'], tools: ['stub_agent'], limits: { rounds: 2, retries: 1 } });
    const context_manifest = contextFor(h, eid, 'investigator', inv);
    const req = (task: string) => ({ authorization: batch, purpose: 'agent', role: 'investigator', adapter: 'stub_agent', snapshot, investigation: inv, context_manifest, args: { task, model: 'fake-model-1' } });
    const first = h.auditor.do(eid, 'request_job', req('round one'));
    h.auditor.do(eid, 'request_job', req('round two'));
    assert.throws(() => h.auditor.do(eid, 'request_job', req('round three')), (e) => isHarnessError(e, 'budget_exhausted') && /round limit/.test((e as Error).message));
    // Identical input while queued is the same job, not a new round.
    assert.equal(h.auditor.do(eid, 'request_job', req('round one')).job.record_id, first.job.record_id);
  } finally {
    h.cleanup();
  }
});
