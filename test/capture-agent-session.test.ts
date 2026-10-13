// `harness agent session`: the terminal-wrapper fallback (DEC-008 Q-018) for talking to a harness agent.
// Each typed entry is captured verbatim first; the agent job carries that exact text and the
// captured_input reference; a failed capture is never forwarded. Runs the reference agent in the
// sandbox against a scripted provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import type { Ref } from '../src/core/refs.ts';
import type { RecordEnvelope } from '../src/schema/records.ts';
import { HarnessError } from '../src/core/errors.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { runAgentSession } from '../src/capture/agentSession.ts';
import { captureProgramDigest, WRAPPER_CHANNEL_NAME } from '../src/capture/index.ts';
import { FakeProvider, ProviderBroker } from '../src/runner/index.ts';
import { acceptPolicy, display, head, LIMITS } from './decision-fixtures.ts';
import { makeHarness } from './helpers.ts';
import { scriptedIO } from './screen-fixtures.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

test('agent session: capture first, the job carries the captured text and reference, the round is shown; failed captures are not forwarded', { timeout: 300_000 }, async () => {
  const h = makeHarness();
  try {
    const eid = 'agent-session';
    const target = join(h.dir, 'target');
    cpSync(join(FIXTURES, 'vault'), target, { recursive: true });
    h.auditor.do(eid, 'create_engagement', { name: 'Agent session', owner: 'auditor', audit_purpose: 'test' });
    acceptPolicy(h, eid);
    h.auditor.do(eid, 'register_snapshot', { path: target, label: 'v1' });
    const eng = head(h, eid, 'eng-0001');
    h.screen.do(eid, 'authorize_work', {
      reviewed: [eng],
      display_receipt: display(h, eid, [eng]),
      inputs: { kind: 'intake', capabilities: { tools: ['reference_agent'], providers: ['fake'], network: 'denied' }, limits: { ...LIMITS, rounds: 2 } },
      rationale: 'one seeding round with the auditor',
      rationale_authorship: 'human_written',
    });
    const fake = new FakeProvider({
      name: 'fake',
      models: ['fake-model-1'],
      pricePerToken: 0.00001,
      messages: [
        { content: [tool('c1', 'list_context', {})], stop_reason: 'tool_use' },
        { content: [tool('c2', 'propose_audit_unit', { kind: 'flow', name: 'withdrawal', functions: ['Vault.withdraw'], risk_rationale: 'pays ether ‮out' })], stop_reason: 'tool_use' },
        { content: [{ type: 'text', text: 'ROUND-SUMMARY: seeded the withdrawal flow.' }], stop_reason: 'end_turn' },
      ],
    });
    const broker = new ProviderBroker(h.controller, { timeoutMs: 30_000, liveExploitableProviders: ['fake'] });
    broker.register(fake, 'broker-held-credential');
    broker.activate();

    const entry = '  Seed the withdrawal flow; keep my spacing.  ';
    const io = scriptedIO([entry, '/quit']);
    const store = () => h.ws.store(eid, true);
    const entries = await runAgentSession({ ws: h.ws, engagement: eid, io, role: 'comprehension', model: 'fake-model-1', max_turns: 4, controller: h.controller });
    const out = io.text();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'ran', out);

    // The captured input exists, verbatim, on the capture channel, and was committed before the job.
    const cap = store().get(entries[0].captured!, 'captured_input');
    assert.equal(cap.body.text, entry);
    assert.equal(cap.created_by.channel, 'capture');
    assert.equal(cap.body.channel.name, WRAPPER_CHANNEL_NAME);
    assert.equal(cap.body.channel.program_digest, captureProgramDigest());
    const job = store().get(entries[0].job!, 'job');
    const jobFirst = store().history(job.record_id)[0] as RecordEnvelope<'job'>;
    const capEvent = store().events().find((e) => e.records.some((r) => r.record_id === cap.record_id))!;
    const jobEvent = store().events().find((e) => e.records.some((r) => r.record_id === job.record_id))!;
    assert.ok(capEvent.seq < jobEvent.seq, 'capture committed before the job was requested');
    assert.equal(jobFirst.body.args.task, entry);
    assert.deepEqual(jobFirst.body.args.captured_input, { record_id: cap.record_id, revision: cap.revision } satisfies Ref);
    assert.equal(jobFirst.body.role, 'comprehension');

    // The round summary and the committed proposal are shown, deceptive characters visibly.
    assert.match(out, /Agent \(fake-model-1[^)]*, 3 turn\(s\), stop: end_turn\):\nROUND-SUMMARY: seeded the withdrawal flow\./);
    assert.match(out, /requested: submit_proposal \(001-propose_audit_unit\)/);
    assert.match(out, /proposals committed by the agent's outbox \(1\)[\s\S]*audit_unit unit-\d+@1[\s\S]*withdrawal/);
    assert.match(out, /pays ether ⟦U\+202E[^⟧]*⟧out/);
    assert.ok(!out.includes('‮'));
    assert.equal(store().heads('audit_unit')[0].created_by.channel, 'worker');

    // A failed capture is never forwarded: no new job.
    const jobsBefore = store().heads('job').length;
    const realCall = h.controller.call.bind(h.controller);
    h.controller.call = ((principal, req) => {
      if (req.operation === 'capture_input') throw new HarnessError('store_corrupt', 'simulated capture failure');
      return realCall(principal, req);
    }) as typeof h.controller.call;
    const failing = scriptedIO(['Must not reach the agent', '/quit']);
    const failed = await runAgentSession({ ws: h.ws, engagement: eid, io: failing, role: 'comprehension', model: 'fake-model-1', controller: h.controller });
    h.controller.call = realCall;
    assert.deepEqual(failed.map((e) => e.status), ['not_captured']);
    assert.match(failing.text(), /\[NOT captured: store_corrupt: simulated capture failure; nothing was sent to the agent\]/);
    assert.equal(store().heads('job').length, jobsBefore);
    assert.equal(fake.messageRequests.length, 3, 'the provider saw no further request');
    // A wrong capture key refuses the whole session before any entry.
    const bad = scriptedIO(['Should not reach the agent', '/quit']);
    const res = await runAgentSession({ ws: h.ws, engagement: eid, io: bad, role: 'comprehension', model: 'fake-model-1', controller: h.controller, captureKey: 'wrong' }).catch((e) => e);
    assert.ok(isHarnessError(res, 'permission_denied'), 'a wrong capture key refuses the session');
    assert.equal(store().heads('job').length, jobsBefore);
    // A session without an interactive terminal, or for the tool role, refuses outright.
    await assert.rejects(
      runAgentSession({ ws: h.ws, engagement: eid, io: scriptedIO([], { interactive: false }), role: 'comprehension', model: 'fake-model-1', controller: h.controller }),
      (e) => isHarnessError(e, 'permission_denied'),
    );
    await assert.rejects(
      runAgentSession({ ws: h.ws, engagement: eid, io: scriptedIO([]), role: 'tool', model: 'fake-model-1', controller: h.controller }),
      (e) => isHarnessError(e, 'invalid_request'),
    );
  } finally {
    h.cleanup();
  }
});
