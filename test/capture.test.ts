import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHarnessError } from '../src/core/errors.ts';
import { digest } from '../src/core/hash.ts';
import { captureProgramDigest, HOOK_CHANNEL_NAME, openCaptureChannel, runCaptureHook, runCaptureWrapper, WRAPPER_CHANNEL_NAME } from '../src/capture/index.ts';
import { makeHarness, newEngagement, type Harness } from './helpers.ts';
import { scriptedIO } from './screen-fixtures.ts';

function withHarness(fn: (h: Harness) => Promise<void> | void) {
  return async () => {
    const h = makeHarness();
    try {
      await fn(h);
    } finally {
      h.cleanup();
    }
  };
}

const code = (c: string) => (e: unknown) => isHarnessError(e, c as never);

// Sample UserPromptSubmit input (fields per the Claude Code hooks reference).
const PROMPT = '  Fee-on-transfer tokens are NOT supported.\n\tKeep trailing space ‮ and escapes \x1b[31m verbatim.  ';
const hookJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 'abc123',
    prompt_id: 'p-1',
    transcript_path: '/home/auditor/.claude/projects/x/abc123.jsonl',
    cwd: '/home/auditor/engagement',
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt: PROMPT,
    ...extra,
  });

test(
  'capture hook records the submitted prompt verbatim, once per prompt id, never blocking',
  withHarness((h) => {
    const eid = newEngagement(h);
    const logs: string[] = [];
    const run = (input: string, key?: string) => runCaptureHook({ ws: h.ws, engagement: eid, input, log: (s) => void logs.push(s), key, controller: h.controller });
    assert.equal(run(hookJson()), 0);
    assert.deepEqual(logs, []);
    const store = h.ws.store(eid, true);
    const caps = store.heads('captured_input');
    assert.equal(caps.length, 1);
    const c = caps[0];
    assert.equal(c.body.text, PROMPT);
    assert.equal(c.body.content_digest, digest(PROMPT));
    assert.equal(c.body.channel.name, HOOK_CHANNEL_NAME);
    assert.equal(c.body.channel.program_digest, captureProgramDigest());
    assert.equal(c.body.session, 'claude-code:abc123');
    assert.equal(c.body.purpose, 'conversation');
    assert.equal(c.created_by.channel, 'capture');
    // A repeated delivery of the same prompt id records once.
    assert.equal(run(hookJson()), 0);
    assert.equal(h.ws.store(eid, true).heads('captured_input').length, 1);
    // Failures are logged on stderr and still exit 0: malformed JSON, other events, missing prompt.
    assert.equal(run('not json'), 0);
    assert.equal(run(hookJson({ hook_event_name: 'Stop' })), 0);
    assert.equal(run(JSON.stringify({ session_id: 's' })), 0);
    assert.equal(logs.length, 3);
    assert.equal(h.ws.store(eid, true).heads('captured_input').length, 1);
  }),
);

test(
  'the capture channel refuses a wrong key; the hook reports it and records nothing',
  withHarness((h) => {
    const eid = newEngagement(h);
    assert.throws(() => openCaptureChannel({ ws: h.ws, name: 'x', key: 'wrong-key', controller: h.controller }), code('permission_denied'));
    // The auditor key is not the capture key.
    assert.throws(() => openCaptureChannel({ ws: h.ws, name: 'x', key: h.ws.readSecret('auditor.key'), controller: h.controller }), code('permission_denied'));
    const logs: string[] = [];
    assert.equal(runCaptureHook({ ws: h.ws, engagement: eid, input: hookJson({ prompt_id: 'p-2' }), log: (s) => void logs.push(s), key: 'wrong-key', controller: h.controller }), 0);
    assert.match(logs.join(''), /capture FAILED.*permission_denied/);
    assert.equal(h.ws.store(eid, true).heads('captured_input').length, 0);
    // Other channels cannot capture.
    assert.throws(() => h.auditor.do(eid, 'capture_input', { text: 'x' }), code('permission_denied'));
    assert.throws(() => h.screen.do(eid, 'capture_input', { text: 'x' }), code('permission_denied'));
  }),
);

test(
  'terminal wrapper: verbatim entries, expectations pre-step for a flow, refuses without a terminal',
  withHarness(async (h) => {
    const eid = newEngagement(h);
    const unit = h.auditor.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'deposit' } }).audit_unit;
    const io = scriptedIO(['  first entry  ', '', '/multi', 'line one\nline two', '/quit']);
    const refs = await runCaptureWrapper({ ws: h.ws, engagement: eid, io, purpose: 'conversation', audit_unit: null, once: false, forward: null, controller: h.controller });
    assert.equal(refs.length, 2);
    const store = h.ws.store(eid, true);
    assert.equal(store.get(refs[0], 'captured_input').body.text, '  first entry  ');
    assert.equal(store.get(refs[1], 'captured_input').body.text, 'line one\nline two');
    assert.equal(store.get(refs[0], 'captured_input').body.channel.name, WRAPPER_CHANNEL_NAME);

    const pre = await runCaptureWrapper({
      ws: h.ws,
      engagement: eid,
      io: scriptedIO(['Deposits must never mint shares for zero assets.']),
      purpose: 'expectations_pre_step',
      audit_unit: unit,
      once: true,
      forward: null,
      controller: h.controller,
    });
    const p = h.ws.store(eid, true).get(pre[0], 'captured_input');
    assert.equal(p.body.purpose, 'expectations_pre_step');
    assert.equal(p.body.audit_unit?.record_id, unit.record_id);

    await assert.rejects(
      runCaptureWrapper({ ws: h.ws, engagement: eid, io: scriptedIO([], { interactive: false }), purpose: 'note', audit_unit: null, once: true, forward: null, controller: h.controller }),
      code('permission_denied'),
    );
  }),
);
