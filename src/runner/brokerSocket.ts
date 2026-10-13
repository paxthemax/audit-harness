import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { rmSync } from 'node:fs';
import { HarnessError } from '../core/errors.ts';
import { sha256Hex } from '../core/hash.ts';
import type { Controller } from '../controller/controller.ts';
import { PROPOSED_ALLOWED_BETAS, ProviderBroker } from './provider.ts';

// Per-attempt provider broker endpoint (design/harness-state-and-execution.md, "Permissions and
// isolation": provider calls go through a broker outside the worker; no raw provider keys inside).
// The sandbox has no network; the runner serves HTTP over a UNIX socket that is mounted into the
// sandbox at /run/harness/broker.sock. One endpoint, `POST /v1/messages`, accepts an Anthropic
// Messages API request and returns a Messages API response. The caller authenticates with the
// attempt's grant token in `x-harness-grant` (or `x-api-key`, so an SDK-based tool can pass it as its
// API key); the token never leaves the broker, which injects the real provider credential itself.
// Every request passes `request_provider_call` on the worker channel, so grant, model approval, data
// class, reservation and retry-cap checks are the controller's. The broker never retries.

/** Proposed request size cap (operator choice). */
export const PROPOSED_BROKER_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

const STATUS: Partial<Record<string, number>> = {
  invalid_request: 400,
  unsupported_contract: 400,
  permission_denied: 403,
  egress_denied: 403,
  grant_expired: 401,
  not_found: 404,
  idempotency_conflict: 409,
  budget_exhausted: 429,
  unsupported: 501,
  execution_failed: 502,
  outcome_unknown: 504,
};

export interface BrokerRequestLog {
  method: string;
  path: string;
  stream: boolean;
  status: number;
  code: string | null;
  call_id: string | null;
  /** Beta headers dropped because they are not on the allowlist. */
  dropped_betas: string[];
}

export interface BrokerSocket {
  path: string;
  /** Requests served (any outcome). */
  served(): number;
  /** Every request the guest made, with the broker's answer (no bodies, no tokens). */
  requests(): BrokerRequestLog[];
  close(): Promise<void>;
}

/**
 * Synthesize an Anthropic Messages SSE stream from a complete (non-streamed) response, so streaming
 * clients work while the provider call itself stays a single, fully checked request.
 */
export function messagesToSse(msg: Record<string, unknown>): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const usage = (msg.usage ?? {}) as Record<string, unknown>;
  const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
  let out = ev('message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
  content.forEach((b, index) => {
    const type = String(b.type);
    if (type === 'text') {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: String(b.text ?? '') } });
    } else if (type === 'tool_use') {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } });
    } else if (type === 'thinking') {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
      out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: String(b.thinking ?? '') } });
      if (b.signature) out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } });
    } else {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: b });
    }
    out += ev('content_block_stop', { type: 'content_block_stop', index });
  });
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason ?? 'end_turn', stop_sequence: msg.stop_sequence ?? null }, usage: { output_tokens: usage.output_tokens ?? 0 } });
  out += ev('message_stop', { type: 'message_stop' });
  return out;
}

function sendError(res: ServerResponse, code: string, reason: string): number {
  // Both the harness error shape and the Messages API error shape; no client retry is invited.
  const status = STATUS[code] ?? 500;
  res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
  res.end(JSON.stringify({ type: 'error', error: { code, reason, type: code, message: reason } }));
  return status;
}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= cap) chunks.push(c);
    });
    req.on('end', () => resolve(size > cap ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function presentedToken(req: IncomingMessage): string | null {
  const h = req.headers;
  const v = h['x-harness-grant'] ?? h['x-api-key'] ?? (typeof h.authorization === 'string' ? h.authorization.replace(/^Bearer\s+/i, '') : undefined);
  return typeof v === 'string' && v ? v.trim() : null;
}

function sameToken(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256Hex(a)), Buffer.from(sha256Hex(b)));
}

export function startBrokerSocket(o: {
  controller: Controller;
  engagementId: string;
  attemptId: string;
  token: string;
  socketPath: string;
}): Promise<BrokerSocket> {
  let served = 0;
  const log: BrokerRequestLog[] = [];
  const inflight = new Set<Promise<void>>();
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    served++;
    const url = new URL(req.url ?? '/', 'http://broker.invalid');
    const entry: BrokerRequestLog = { method: req.method ?? '', path: url.pathname, stream: false, status: 0, code: null, call_id: null, dropped_betas: [] };
    log.push(entry);
    const refuse = (code: string, reason: string) => {
      entry.code = code;
      entry.status = sendError(res, code, reason);
    };
    // Only model calls are served; token counting, model listing, telemetry and anything else is
    // refused as egress (nothing leaves).
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') return refuse('egress_denied', `${req.method} ${url.pathname} is not served by the broker; only POST /v1/messages`);
    const token = presentedToken(req);
    if (!token || !sameToken(token, o.token)) return refuse('permission_denied', 'missing or wrong grant token');
    const body = await readBody(req, PROPOSED_BROKER_MAX_REQUEST_BYTES);
    if (!body) return refuse('invalid_request', `request larger than ${PROPOSED_BROKER_MAX_REQUEST_BYTES} bytes`);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    } catch {
      return refuse('invalid_request', 'request body is not a JSON object');
    }
    const stream = parsed.stream === true;
    entry.stream = stream;
    delete parsed.stream;
    const requested = String(req.headers['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter(Boolean);
    const betas = requested.filter((b) => PROPOSED_ALLOWED_BETAS.includes(b));
    entry.dropped_betas = requested.filter((b) => !PROPOSED_ALLOWED_BETAS.includes(b));
    try {
      const session = o.controller.worker(o.engagementId, token);
      if (session.principal.grant!.attempt.record_id !== o.attemptId) return refuse('permission_denied', 'grant belongs to another attempt');
      const broker = ProviderBroker.active();
      if (!broker) return refuse('unsupported', 'no provider broker is running');
      const store = o.controller.ws.store(o.engagementId, true);
      const stored = store.archive.putJson({ format: 'harness.provider_messages_request/1', body: parsed, ...(betas.length ? { betas } : {}) });
      const { call_id } = session.do(o.engagementId, 'request_provider_call', { messages_request: stored });
      entry.call_id = call_id;
      const out = await broker.executeMessages(o.engagementId, call_id);
      if (out.outcome === 'completed' && out.body) {
        entry.status = 200;
        if (stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-harness-call': call_id });
          res.end(messagesToSse(out.body));
        } else {
          res.writeHead(200, { 'content-type': 'application/json', 'x-harness-call': call_id });
          res.end(JSON.stringify(out.body));
        }
      } else if (out.outcome === 'outcome_unknown') {
        refuse('outcome_unknown', `${out.reason ?? 'outcome unknown'}; the reservation is kept (call ${call_id})`);
      } else {
        refuse('execution_failed', `${out.reason ?? 'the provider refused the request'} (call ${call_id}; nothing was charged)`);
      }
    } catch (e) {
      if (e instanceof HarnessError) return refuse(e.code, e.message.slice(e.code.length + 2));
      refuse('execution_failed', (e as Error).message);
    }
  };
  const server = createServer((req, res) => {
    const p: Promise<void> = handle(req, res).catch((e) => {
      sendError(res, 'execution_failed', (e as Error).message);
    });
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.socketPath, () => {
      resolve({
        path: o.socketPath,
        served: () => served,
        requests: () => log.map((l) => ({ ...l })),
        async close() {
          // Finish in-flight calls so each one's outcome is recorded before the attempt completes.
          await Promise.allSettled([...inflight]);
          await new Promise<void>((r) => server.close(() => r()));
          rmSync(o.socketPath, { force: true });
        },
      });
    });
  });
}
