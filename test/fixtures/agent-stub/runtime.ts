// Test stand-in for src/agents/runtime.ts, written against the same sandbox contract: it reads the
// task and context, calls the provider broker over its UNIX socket (and through the TCP forwarder),
// and turns a scripted tool_use into an outbox request. Plain JavaScript syntax; node: modules only.
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const env = process.env;
const log = (k: string, v: unknown) => process.stdout.write(`STUB ${k} ${JSON.stringify(v)}\n`);

function post(body: unknown, opts: { socketPath?: string; port?: number; headers: Record<string, string> }): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      { method: 'POST', path: '/v1/messages', socketPath: opts.socketPath, host: opts.port ? '127.0.0.1' : undefined, port: opts.port, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...opts.headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(buf || 'null') }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

const task = JSON.parse(readFileSync(env.HARNESS_TASK!, 'utf8'));
const manifest = JSON.parse(readFileSync(`${env.HARNESS_CONTEXT}/manifest.json`, 'utf8'));
const token = readFileSync(env.HARNESS_GRANT_FILE!, 'utf8').trim();
log('task', { role: env.HARNESS_ROLE, model: env.HARNESS_MODEL, job: task.job.record_id, args: task.args, engagement: task.job.engagement });
log('context', { format: manifest.format, role: manifest.role, sources: readdirSync(`${env.HARNESS_CONTEXT}/sources`, { recursive: true }) });

const socketPath = env.HARNESS_BROKER_SOCKET!;
const body = {
  model: env.HARNESS_MODEL,
  max_tokens: 256,
  messages: [{ role: 'user', content: task.args.task }],
  tools: [{ name: 'read_records', description: 'read records', input_schema: { type: 'object' } }],
};
const first = await post(body, { socketPath, headers: { 'x-harness-grant': token } });
log('first', { status: first.status, stop_reason: first.json?.stop_reason, model: first.json?.model, blocks: first.json?.content?.map((b: any) => b.type) });
for (const b of first.json?.content ?? []) {
  if (b.type === 'tool_use') writeFileSync(`${env.HARNESS_OUTBOX}/001-${b.name}.json`, JSON.stringify({ operation: b.name, payload: b.input }));
}

const wrongModel = await post({ ...body, model: 'not-approved-model' }, { socketPath, headers: { 'x-harness-grant': token } });
log('wrong_model', { status: wrongModel.status, code: wrongModel.json?.error?.code });
const noToken = await post(body, { socketPath, headers: {} });
log('no_token', { status: noToken.status, code: noToken.json?.error?.code });
const serverTool = await post({ ...body, tools: [{ type: 'web_fetch_20260209', name: 'web_fetch' }] }, { socketPath, headers: { 'x-harness-grant': token } });
log('server_tool', { status: serverTool.status, code: serverTool.json?.error?.code });

// Through the in-sandbox TCP forwarder, passing the grant as an SDK-style API key.
const fwd = spawn(process.execPath, [env.HARNESS_FORWARDER!, '8787', socketPath], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => fwd.stdout!.once('data', r));
const viaTcp = await post({ ...body, tools: undefined, messages: [{ role: 'user', content: 'second turn' }] }, { port: 8787, headers: { 'x-api-key': token } });
log('via_forwarder', { status: viaTcp.status, stop_reason: viaTcp.json?.stop_reason });
fwd.kill();

let egress = 'blocked';
try {
  await fetch('http://1.1.1.1/', { signal: AbortSignal.timeout(3000) });
  egress = 'reached';
} catch {
  /* expected: no network */
}
log('egress', egress);
