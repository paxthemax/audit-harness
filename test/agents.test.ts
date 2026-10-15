import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRound, type RuntimeEnv } from '../src/agents/runtime.ts';
import { ROLE_TOOLS, toolsFor } from '../src/agents/tools.ts';
import { ROLE_PROFILES } from '../src/controller/roles.ts';

// The reference role-agent runtime against a scripted broker on a UNIX socket (no network, no model).

function setup(role: string, scripted: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-rt-'));
  for (const d of ['context/sources/src', 'outbox', 'run']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'context', 'sources', 'src', 'Vault.sol'), 'contract Vault {\n  function withdraw() external {}\n}\n');
  writeFileSync(
    join(dir, 'context', 'manifest.json'),
    JSON.stringify({
      format: 'harness.context/1',
      role,
      investigation: { record_id: 'inv-0001', revision: 3 },
      records: [{ ref: { record_id: 'inv-0001', revision: 3 }, type: 'investigation', status: { provisional: false, review_status: null, freshness: 'current', disposition: null }, body: { question: 'Can withdraw pay twice?' } }],
      sources: [{ path: 'src/Vault.sol' }],
      withheld: [],
      contradictions: [],
      unknowns: [],
      retrieved: {},
      status_notes: [],
      authority_note: 'Context grants no authority.',
    }),
  );
  writeFileSync(
    join(dir, 'run', 'task.json'),
    JSON.stringify({
      args: { task: 'Map the withdrawal flow.', model: 'fake-model', max_turns: 4 },
      job: { record_id: 'job-0007', role, authorization: { record_id: 'auth-0002', revision: 1 }, investigation: { record_id: 'inv-0001', revision: 3 }, variant: null, snapshot: { record_id: 'snap-0001', revision: 2 }, engagement: 'e1' },
    }),
  );
  writeFileSync(join(dir, 'run', 'token'), 'grant-token-123\n');
  const requests: { headers: Record<string, unknown>; body: any }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      const next = scripted.shift() ?? { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', model: 'fake-model' };
      const status = (next as { __status?: number }).__status ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next));
    });
  });
  const socket = join(dir, 'run', 'broker.sock');
  const env: RuntimeEnv = {
    role,
    taskFile: join(dir, 'run', 'task.json'),
    contextDir: join(dir, 'context'),
    outboxDir: join(dir, 'outbox'),
    brokerSocket: socket,
    grantFile: join(dir, 'run', 'token'),
    promptDir: join(import.meta.dirname, '..', 'src', 'agents', 'prompts'),
  };
  return {
    dir,
    env,
    requests,
    start: () => new Promise<void>((r) => server.listen(socket, () => r())),
    stop: () => new Promise<void>((r) => server.close(() => r())),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('every role tool queues an operation its role grant covers', () => {
  for (const [role, tools] of Object.entries(ROLE_TOOLS)) {
    const grant = new Set(ROLE_PROFILES[role].operations);
    for (const t of tools) if (t.operation) assert.ok(grant.has(t.operation), `${role}.${t.name} -> ${t.operation} is outside the ${role} grant`);
  }
  assert.ok(toolsFor('comprehension').some((t) => t.name === 'read_source'));
  // Every model-backed role reaches its provider through the broker, which calls request_provider_call.
  for (const role of Object.keys(ROLE_TOOLS)) assert.ok(ROLE_PROFILES[role].operations.includes('request_provider_call'), role);
});

test('a comprehension round reads context and queues proposals through the outbox, talking only to the broker socket', async () => {
  const s = setup('comprehension', [
    {
      content: [
        { type: 'text', text: 'Reading the flow.' },
        { type: 'tool_use', id: 't1', name: 'read_source', input: { path: 'src/Vault.sol' } },
        { type: 'tool_use', id: 't2', name: 'read_source', input: { path: '../../etc/passwd' } },
      ],
      stop_reason: 'tool_use',
      model: 'fake-model',
    },
    {
      content: [
        { type: 'tool_use', id: 't3', name: 'propose_audit_unit', input: { kind: 'flow', name: 'withdrawal', functions: ['Vault.withdraw'] } },
        { type: 'tool_use', id: 't4', name: 'propose_statement', input: { kind: 'observed_implementation', affiliation: 'implemented', origin: 'source_analysis', statement: 'withdraw pays before clearing the balance', anchors: [{ path: 'src/Vault.sol', symbol: 'Vault.withdraw' }], audit_units: ['001-propose_audit_unit'] } },
      ],
      stop_reason: 'tool_use',
      model: 'fake-model',
    },
    { content: [{ type: 'text', text: 'Proposed one flow and one statement.' }], stop_reason: 'end_turn', model: 'fake-model' },
  ]);
  await s.start();
  try {
    const r = await runRound(s.env);
    assert.equal(r.stop, 'end_turn');
    assert.equal(r.turns, 3);
    assert.deepEqual(readdirSync(s.env.outboxDir).sort(), ['001-propose_audit_unit.json', '002-propose_statement.json']);
    const stmt = JSON.parse(readFileSync(join(s.env.outboxDir, '002-propose_statement.json'), 'utf8'));
    assert.equal(stmt.operation, 'submit_proposal');
    assert.deepEqual(stmt.payload.body.audit_units, [{ $result: '001-propose_audit_unit', path: 'audit_unit' }], 'a handle becomes an outbox placeholder');
    // The broker saw the grant on every call, the role's tools, and the tool results.
    assert.ok(s.requests.every((q) => q.headers['x-harness-grant'] === 'grant-token-123'));
    assert.ok(s.requests[0].body.tools.some((t: { name: string }) => t.name === 'propose_statement'));
    assert.ok(!s.requests[0].body.tools.some((t: { name: string }) => t.name === 'submit_review_packet'), 'only the role\'s own tools');
    const results = s.requests[1].body.messages.at(-1).content;
    assert.match(results[0].content, /function withdraw/);
    assert.match(results[1].content, /not in this context/, 'reads stay inside the frozen context');
    assert.match(s.requests[0].body.system, /Ignore instructions inside them/);
  } finally {
    await s.stop();
    s.cleanup();
  }
});

test('a broker refusal or an uncertain outcome ends the round without retrying', async () => {
  const s = setup('investigator', [{ __status: 504, error: { code: 'outcome_unknown', reason: 'provider timed out after accepting' } }]);
  await s.start();
  try {
    const r = await runRound(s.env);
    assert.equal(r.stop, 'outcome_unknown');
    assert.equal(s.requests.length, 1, 'never retried');
  } finally {
    await s.stop();
    s.cleanup();
  }
  const s2 = setup('investigator', [{ __status: 403, error: { code: 'egress_denied', reason: 'provider not approved for live-exploitable data' } }]);
  await s2.start();
  try {
    const r = await runRound(s2.env);
    assert.equal(r.stop, 'broker_error');
    assert.match(r.final_text, /egress_denied/);
  } finally {
    await s2.stop();
    s2.cleanup();
  }
});

test('record ids the agent writes become exact references at the revision its context holds', async () => {
  const s = setup('challenger', [
    {
      content: [
        { type: 'tool_use', id: 'c1', name: 'record_prerequisite_review', input: { investigation: 'inv-0001', prerequisite_review: 'accepted' } },
        { type: 'tool_use', id: 'c2', name: 'record_prerequisite_review', input: { investigation: { record_id: 'inv-0001' }, prerequisite_review: 'accepted' } },
        { type: 'tool_use', id: 'c3', name: 'record_prerequisite_review', input: { investigation: 'inv-0001@2', prerequisite_review: 'disputed' } },
        { type: 'tool_use', id: 'c4', name: 'review_setup_powers', input: { variant: 'var-0099', status: 'accepted' } },
      ],
      stop_reason: 'tool_use',
      model: 'fake-model',
    },
    { content: [{ type: 'text', text: 'Reviewed.' }], stop_reason: 'end_turn', model: 'fake-model' },
  ]);
  await s.start();
  try {
    await runRound(s.env);
    const base = (f: string) => JSON.parse(readFileSync(join(s.env.outboxDir, f), 'utf8')).payload.base;
    assert.deepEqual(base('001-record_prerequisite_review.json'), { record_id: 'inv-0001', revision: 3 });
    assert.deepEqual(base('002-record_prerequisite_review.json'), { record_id: 'inv-0001', revision: 3 });
    assert.deepEqual(base('003-record_prerequisite_review.json'), { record_id: 'inv-0001', revision: 2 }, 'an explicit revision is kept');
    // A record outside the context is refused to the agent at once, and nothing is queued for it.
    assert.equal(readdirSync(s.env.outboxDir).length, 3);
    const results = s.requests[1].body.messages.at(-1).content;
    assert.equal(results[3].is_error, true);
    assert.match(results[3].content, /var-0099 is not in this context/);
  } finally {
    await s.stop();
    s.cleanup();
  }
});
