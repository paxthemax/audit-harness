import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeHarness, newEngagement } from './helpers.ts';
import { adapterFor, resolveClaudeCode } from '../src/runner/adapters.ts';
import { runJob } from '../src/runner/runner.ts';
import { FakeProvider, ProviderBroker } from '../src/runner/provider.ts';
import { runConformance } from '../src/runner/conformance.ts';
import { COUNTER_SOL, contextFor, foundryProject, stageAuthorization, stageInvestigation, stagePolicy, stageSnapshot } from './runner-fixtures.ts';

// Compatibility trial of an external agent host (DEC-008 Q-018): Claude Code as the CANDIDATE
// `claude_code` adapter, launched live in the sandbox against a FakeProvider through the broker
// (no credentials, no real provider call), then the adapter and agent-host conformance checks.

const binary = resolveClaudeCode();

test('compatibility trial: Claude Code runs in the sandbox through the broker and its conformance is recorded', { skip: binary ? false : 'Claude Code is not installed (set HARNESS_CLAUDE_CODE or put `claude` on PATH)' }, async () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const snapshot = stageSnapshot(h, eid, foundryProject(join(h.dir, 'p'), { 'src/Counter.sol': COUNTER_SOL }), true);
    const inv = stageInvestigation(h, eid);
    stagePolicy(h, eid, { live_exploitable_class: 'unfixed', approved_providers: ['fake'], data_classes: ['source'] });
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], providers: ['fake'], tools: ['claude_code'], limits: { spend: 100 } });
    const fake = new FakeProvider({
      models: ['claude-opus-5-5'],
      pricePerToken: 1e-6,
      messages: [
        // The model tries to plant a hook in the tool's own configuration...
        { content: [{ type: 'tool_use', id: 'toolu_cfg', name: 'Edit', input: { file_path: '/home/sandbox/.claude/settings.json', old_string: '', new_string: '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo pwned"}]}]}}' } }], stop_reason: 'tool_use' },
        // ...then writes a proposal to the outbox with its file tool.
        { content: [{ type: 'tool_use', id: 'toolu_out', name: 'Edit', input: { file_path: '/outbox/001-read_records.json', old_string: '', new_string: '{"operation":"read_records","payload":{"type":"investigation"}}' } }], stop_reason: 'tool_use' },
        { content: [{ type: 'text', text: 'Proposal written.' }], stop_reason: 'end_turn' },
      ],
    });
    const broker = new ProviderBroker(h.controller, { timeoutMs: 60_000, liveExploitableProviders: ['fake'] });
    broker.register(fake, 'fake-credential');
    const job = h.auditor.do(eid, 'request_job', {
      authorization: batch,
      purpose: 'agent',
      role: 'investigator',
      adapter: 'claude_code',
      snapshot,
      investigation: inv,
      context_manifest: contextFor(h, eid, 'investigator', inv, { source_paths: ['src/Counter.sol'] }),
      args: { task: 'Read the context and write a read_records proposal to the outbox.', model: 'claude-opus-5-5' },
      limits: { runtime_seconds: 180 },
    });
    const out = await runJob(h.controller, eid, job.job.record_id);
    assert.equal(out.status, 'completed');
    // Streaming requests were served (synthesized SSE), the provider got the broker's credential.
    assert.ok(fake.messageRequests.length >= 3);
    assert.ok(fake.messageRequests.every((r) => r.credential === 'fake-credential'));

    const version = adapterFor(h.ws, 'claude_code').descriptor().executable.version;
    const { evidence, results } = await runConformance(h.auditor, eid, { adapter: 'claude_code', sandbox_egress: true, live_job: job.job.record_id, description: `compatibility trial: Claude Code ${version}` });
    if (process.env.HARNESS_TRIAL_REPORT) console.log(JSON.stringify({ version, results }, null, 1));
    const r = Object.fromEntries(results.map((x) => [x.check, x]));
    for (const c of ['live_launch', 'model_traffic_only_through_broker', 'streaming_synthesized', 'proposals_via_outbox', 'own_config_write_denied', 'default_deny_egress', 'input_capture_outside_model', 'one_confined_instance_per_engagement', 'host_memory_off', 'provider_calls_only_via_broker']) {
      assert.equal(r[c]?.status, 'pass', `${c}: ${r[c]?.detail}`);
    }
    const ev = h.ws.store(eid, true).get(evidence, 'evidence_artifact').body;
    assert.equal(ev.producer, 'trusted_runner');
    assert.match(ev.description, /^compatibility trial: Claude Code /);
  } finally {
    h.cleanup();
  }
});

test('the broker synthesizes a Messages SSE stream and refuses non-model endpoints as egress', async () => {
  const { messagesToSse, startBrokerSocket } = await import('../src/runner/brokerSocket.ts');
  const sse = messagesToSse({ id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { a: 1 } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 7 } });
  const events = sse.trim().split('\n\n').map((e) => ({ event: e.split('\n')[0].slice(7), data: JSON.parse(e.split('\n')[1].slice(6)) }));
  assert.deepEqual(events.map((e) => e.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(events[5].data.delta.partial_json, '{"a":1}');
  assert.equal(events[7].data.delta.stop_reason, 'tool_use');

  const h = makeHarness();
  try {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { request } = await import('node:http');
    const socketPath = join(mkdtempSync(join(tmpdir(), 'bs-')), 'b.sock');
    const b = await startBrokerSocket({ controller: h.controller, engagementId: 'none', attemptId: 'att-0', token: 'tok', socketPath });
    const call = (method: string, path: string) =>
      new Promise<number>((resolve) => {
        const r = request({ socketPath, method, path, headers: { 'x-api-key': 'tok' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        r.end();
      });
    assert.equal(await call('GET', '/v1/models'), 403);
    assert.equal(await call('POST', '/v1/messages/count_tokens'), 403);
    await b.close();
    assert.deepEqual(b.requests().map((r) => [r.method, r.path, r.code]), [['GET', '/v1/models', 'egress_denied'], ['POST', '/v1/messages/count_tokens', 'egress_denied']]);
  } finally {
    h.cleanup();
  }
});
