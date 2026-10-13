// A stand-in for `omp auth-gateway stdio` (JSON lines on stdio), so tests never reach a provider.
// Environment: FAKE_OMP_VERSION (reported version), FAKE_OMP_USED (Anthropic 5-hour used fraction),
// FAKE_OMP_REPORTS (both | anthropic | none), FAKE_OMP_MODE (ok | error | upstream | crash, for /v1/messages) and
// FAKE_OMP_LOG (a file that receives one JSON line per start and per request).

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
const log = (o: unknown) => {
  if (env.FAKE_OMP_LOG) appendFileSync(env.FAKE_OMP_LOG, JSON.stringify(o) + '\n');
};
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

log({ start: true, profile: env.OMP_PROFILE ?? null, cwd: process.cwd(), env_keys: Object.keys(env).sort() });
send({ ready: true, version: env.FAKE_OMP_VERSION ?? '18.10.1' });

const window = (id: string, label: string, used: number) => ({
  id,
  label,
  window: { id, label, resetsAt: 1_900_000_000_000 },
  amount: { used: used * 100, limit: 100, usedFraction: used, unit: 'percent' },
  status: 'ok',
});

function reports() {
  const which = env.FAKE_OMP_REPORTS ?? 'both';
  const out: unknown[] = [];
  if (which === 'both' || which === 'anthropic') {
    out.push({ provider: 'anthropic', fetchedAt: 1_800_000_000_000, limits: [window('anthropic:5h', 'Claude 5 Hour', Number(env.FAKE_OMP_USED ?? 0.1)), window('anthropic:7d', 'Claude 7 Day', 0.05)], metadata: { planType: 'team', allowed: true, limitReached: false, email: 'someone@example.invalid' } });
  }
  if (which === 'both') out.push({ provider: 'openai-codex', fetchedAt: 1_800_000_000_000, limits: [window('openai-codex:primary', '7 days', 0)], metadata: { planType: 'plus', allowed: true, limitReached: false } });
  return out;
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line) as { id: number; path: string; method?: string; body?: { model?: string } };
  log({ request: req });
  if (req.path === '/v1/usage') return send({ id: req.id, status: 200, body: { generatedAt: 1_800_000_000_000, reports: reports() } });
  if (req.path !== '/v1/messages') return send({ id: req.id, status: 404, body: { error: { type: 'not_found', message: req.path } } });
  const mode = env.FAKE_OMP_MODE ?? 'ok';
  if (mode === 'crash') process.exit(3);
  if (mode === 'error') return send({ id: req.id, status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Third-party apps now draw from your extra usage' } } });
  if (mode === 'upstream') return send({ id: req.id, status: 502, body: { type: 'error', error: { type: 'upstream_error', message: 'The socket connection was closed unexpectedly before the response completed' } } });
  send({
    id: req.id,
    status: 200,
    body: { id: `msg_fake_${req.id}`, type: 'message', role: 'assistant', model: req.body?.model, content: [{ type: 'text', text: 'fake gateway reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 5 } },
  });
});
