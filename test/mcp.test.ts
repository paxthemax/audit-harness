import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fail } from '../src/core/errors.ts';
import { runHarnessMcp } from '../src/mcp/harness.ts';
import { serveMcp, type McpTool } from '../src/mcp/server.ts';
import { makeHarness, newEngagement } from './helpers.ts';

type Message = Record<string, any>;

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-host', version: '1.2.3' } } };
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

/** Feed `lines` (objects are serialised, strings sent as is) and return every message the server wrote. */
async function exchange(run: (input: PassThrough, output: PassThrough) => Promise<void>, lines: (Message | string)[]): Promise<Message[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (c: Buffer) => (written += c.toString('utf8')));
  const done = run(input, output);
  for (const l of lines) input.write((typeof l === 'string' ? l : JSON.stringify(l)) + '\n');
  input.end();
  await done;
  assert.ok(written === '' || written.endsWith('\n'), 'every message ends with a newline');
  // Nothing but JSON-RPC messages, one per line.
  return written
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const m = JSON.parse(l) as Message;
      assert.equal(m.jsonrpc, '2.0');
      return m;
    });
}

const byId = (msgs: Message[], id: unknown): Message => {
  const m = msgs.find((x) => x.id === id);
  assert.ok(m, `a response for id ${String(id)}`);
  return m;
};

function fakeTools(seen: { client: unknown }[] = []): McpTool[] {
  return [
    {
      name: 'echo',
      description: 'Echo the arguments.',
      inputSchema: { type: 'object', properties: { word: { type: 'string' } } },
      async handler(args, ctx) {
        seen.push({ client: ctx.client });
        return { text: `echo ${String(args.word)}`, structured: { word: args.word } };
      },
    },
    {
      name: 'refuse',
      description: 'Always refuses.',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        fail('permission_denied', 'not on this channel', { details: { why: 'test' } });
      },
    },
    {
      name: 'crash',
      description: 'Throws a plain error.',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        throw new Error('boom');
      },
    },
  ];
}

const serve = (tools: McpTool[], logs: string[] = []) => (input: PassThrough, output: PassThrough) =>
  serveMcp({ name: 'test-server', version: '9.9.9', instructions: 'Use the tools.', tools, input, output, log: (l) => logs.push(l) });

test('initialize negotiates the protocol version and returns capabilities, server info and instructions', async () => {
  const msgs = await exchange(serve(fakeTools()), [INIT]);
  const r = byId(msgs, 0).result;
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.deepEqual(r.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(r.serverInfo, { name: 'test-server', version: '9.9.9' });
  assert.equal(r.instructions, 'Use the tools.');

  for (const v of ['2025-03-26', '2024-11-05']) {
    const m = await exchange(serve(fakeTools()), [{ ...INIT, params: { ...INIT.params, protocolVersion: v } }]);
    assert.equal(byId(m, 0).result.protocolVersion, v);
  }
  // An unsupported version gets the latest supported one.
  const other = await exchange(serve(fakeTools()), [{ ...INIT, params: { protocolVersion: '2099-01-01' } }]);
  assert.equal(byId(other, 0).result.protocolVersion, '2025-06-18');
  // A second initialize is refused.
  const twice = await exchange(serve(fakeTools()), [INIT, { ...INIT, id: 1 }]);
  assert.equal(byId(twice, 1).error.code, -32600);
});

test('tools/list lists name, description and input schema', async () => {
  const msgs = await exchange(serve(fakeTools()), [INIT, INITIALIZED, { jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const tools = byId(msgs, 1).result.tools;
  assert.deepEqual(
    tools.map((t: Message) => t.name),
    ['echo', 'refuse', 'crash'],
  );
  assert.deepEqual(tools[0], { name: 'echo', description: 'Echo the arguments.', inputSchema: { type: 'object', properties: { word: { type: 'string' } } } });
});

test('tools/call returns text content and structured content, and passes the client from initialize', async () => {
  const seen: { client: unknown }[] = [];
  const msgs = await exchange(serve(fakeTools(seen)), [INIT, INITIALIZED, { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'echo', arguments: { word: 'hi' } } }]);
  const r = byId(msgs, 'a').result;
  assert.deepEqual(r, { content: [{ type: 'text', text: 'echo hi' }], structuredContent: { word: 'hi' } });
  assert.deepEqual(seen, [{ client: { name: 'test-host', version: '1.2.3' } }]);

  // Without clientInfo the client is null.
  const anon: { client: unknown }[] = [];
  await exchange(serve(fakeTools(anon)), [{ ...INIT, params: { protocolVersion: '2025-06-18' } }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }]);
  assert.deepEqual(anon, [{ client: null }]);
});

test('a throwing tool returns an isError result with the harness code, reason and next action', async () => {
  const logs: string[] = [];
  const msgs = await exchange(serve(fakeTools(), logs), [
    INIT,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'refuse', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'crash', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { word: 'after' } } },
  ]);
  const refused = byId(msgs, 1).result;
  assert.equal(refused.isError, true);
  const text = refused.content[0].text as string;
  assert.match(text, /^permission_denied: not on this channel$/m);
  assert.match(text, /^Next: Obtain an appropriate human decision or stop$/m);
  assert.match(text, /"why":"test"/);
  assert.equal(refused.structuredContent.error.code, 'permission_denied');

  const crashed = byId(msgs, 2).result;
  assert.equal(crashed.isError, true);
  assert.equal(crashed.content[0].text, 'error: boom');
  // A failed call does not stop later calls.
  assert.equal(byId(msgs, 3).result.content[0].text, 'echo after');
  assert.ok(logs.some((l) => l.includes('refuse failed')));
});

test('unknown tools and malformed tools/call params are -32602', async () => {
  const msgs = await exchange(serve(fakeTools()), [
    INIT,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: [1] } },
  ]);
  assert.equal(byId(msgs, 1).error.code, -32602);
  assert.match(byId(msgs, 1).error.message, /unknown tool: nope/);
  assert.equal(byId(msgs, 2).error.code, -32602);
  assert.equal(byId(msgs, 3).error.code, -32602);
});

test('unknown methods are -32601; ping answers with an empty result', async () => {
  const msgs = await exchange(serve(fakeTools()), [INIT, { jsonrpc: '2.0', id: 1, method: 'resources/list' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
  assert.equal(byId(msgs, 1).error.code, -32601);
  assert.deepEqual(byId(msgs, 2).result, {});
});

test('parse errors and invalid requests', async () => {
  const msgs = await exchange(serve(fakeTools()), [
    '{not json',
    '[1,2]',
    { jsonrpc: '1.0', id: 5, method: 'ping' },
    { jsonrpc: '2.0', id: 6 },
    { jsonrpc: '2.0', id: 7, method: 'ping', params: [1] },
    '',
  ]);
  assert.deepEqual(msgs[0], { jsonrpc: '2.0', id: null, error: { code: -32700, message: msgs[0].error.message } });
  assert.equal(msgs[1].id, null);
  assert.equal(msgs[1].error.code, -32600);
  assert.equal(byId(msgs, 5).error.code, -32600);
  assert.equal(byId(msgs, 6).error.code, -32600);
  assert.equal(byId(msgs, 7).error.code, -32600);
  assert.equal(msgs.length, 5, 'blank lines are ignored');
});

test('requests before initialize are refused (ping is allowed)', async () => {
  const msgs = await exchange(serve(fakeTools()), [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ]);
  assert.equal(byId(msgs, 1).error.code, -32600);
  assert.match(byId(msgs, 1).error.message, /not initialized/);
  assert.equal(byId(msgs, 2).error.code, -32600);
  assert.deepEqual(byId(msgs, 3).result, {});
});

test('notifications and responses get no response', async () => {
  const msgs = await exchange(serve(fakeTools()), [
    INIT,
    INITIALIZED,
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo', arguments: {} } },
    { jsonrpc: '2.0', method: 'no/such/notification' },
    { jsonrpc: '2.0', id: 42, result: {} },
  ]);
  assert.deepEqual(
    msgs.map((m) => m.id),
    [0],
  );
});

test('end of input resolves once pending tool calls are answered', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (c: Buffer) => (written += c.toString('utf8')));
  const slow: McpTool = {
    name: 'slow',
    description: 'Finishes only after the input has ended.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      if (!input.readableEnded) await once(input, 'end');
      return { text: 'done' };
    },
  };
  const done = serve([slow])(input, output);
  input.end([INIT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow' } }].map((m) => JSON.stringify(m) + '\n').join(''));
  await done;
  const msgs = written.trim().split('\n').map((l) => JSON.parse(l) as Message);
  assert.deepEqual(byId(msgs, 1).result, { content: [{ type: 'text', text: 'done' }] });

  // With nothing pending the promise resolves on end of input alone.
  assert.deepEqual(await exchange(serve(fakeTools()), []), []);
});

test('harness mcp: overview and present an engagement record end to end', async () => {
  const h = makeHarness();
  try {
    const eng = newEngagement(h);
    const engRecord = h.ws.store(eng, true).heads('engagement')[0].record_id;
    const errors = new PassThrough();
    const call = (id: number, name: string, args: Message) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const msgs = await exchange((input, output) => runHarnessMcp({ workspace: h.ws.root, input, output, error: errors }), [
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      call(2, 'harness_overview', {}),
      call(3, 'harness_overview', { engagement: eng }),
      call(4, 'harness_present', { engagement: eng, id: engRecord }),
      call(5, 'harness_present', { engagement: eng }),
    ]);
    const init = byId(msgs, 0).result;
    assert.equal(init.serverInfo.name, 'audit-harness');
    assert.match(init.instructions, /harness_overview/);
    assert.deepEqual(
      byId(msgs, 1).result.tools.map((t: Message) => t.name),
      ['harness_overview', 'harness_present', 'harness_decide', 'harness_request_check', 'harness_records', 'harness_call', 'harness_run_jobs', 'harness_capture', 'harness_yolo_report'],
    );
    // The decision description offers only fields the review session accepts (guarantee is derived).
    const decide = byId(msgs, 1).result.tools.find((t: Message) => t.name === 'harness_decide');
    const decisionHelp = decide.inputSchema.properties.decision.description as string;
    assert.match(decisionHelp, /accepted -> severity, severity_basis, finding \{prerequisites \[\], title, mechanism, impact, applicability\}/);
    assert.doesNotMatch(decisionHelp, /affected_code|guarantee/);

    const list = byId(msgs, 2).result;
    assert.notEqual(list.isError, true, list.content[0].text);
    assert.ok(list.structuredContent.engagements.some((e: Message) => e.id === eng));
    assert.match(list.content[0].text, new RegExp(eng));

    const overview = byId(msgs, 3).result;
    assert.notEqual(overview.isError, true, overview.content[0].text);
    assert.equal(overview.structuredContent.engagement, eng);
    assert.ok(Array.isArray(overview.structuredContent.decisions));
    assert.equal(overview.content[0].text.split('\n')[0], overview.structuredContent.title, 'the title is printed once, as given');
    assert.equal(overview.content[0].text.split(`Engagement ${eng}`).length - 1, 1);

    const presented = byId(msgs, 4).result;
    assert.notEqual(presented.isError, true, presented.content[0].text);
    assert.equal(presented.structuredContent.id, engRecord);
    assert.ok(presented.structuredContent.text.length > 0);
    assert.ok(presented.content[0].text.startsWith(presented.structuredContent.text.replace(/\n+$/, '')));

    // Missing arguments come back as an actionable tool error.
    const missing = byId(msgs, 5).result;
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /^invalid_request: harness_present: missing argument `id`/);
  } finally {
    h.cleanup();
  }
});
