import { messagesInputBytes, ProviderRejected, validateMessagesContent, type MessagesBody, type MessagesResult, type Provider, type ProviderRequest, type ProviderResponse } from './provider.ts';

// Anthropic Messages API provider: a CANDIDATE adapter. The provider choice remains the operator's;
// registering it approves nothing — an engagement's data policy and a work authorization must name it
// before any call goes out. The project takes no runtime npm dependencies, so this speaks the documented
// HTTP surface directly: POST {base}/v1/messages with `x-api-key`, `anthropic-version: 2023-06-01` and
// `content-type: application/json`; the response's `model` and `usage` are recorded.
//
// The credential is read by the broker process only (ProviderBroker.registerFromWorkspace, from
// <workspace>/secrets/providers/anthropic.key, mode 0600) and is never visible to workers.
//
// Cost accounting uses an operator-supplied rate table (USD per million tokens). The defaults below are
// PROPOSALS copied from the cached model table of 2026-10-06 and must be checked against the current
// pricing page before use; an unknown model has no rate and is refused rather than guessed.

export interface AnthropicRates {
  input: number;
  output: number;
  /** 5-minute cache writes. */
  cache_write: number;
  cache_read: number;
}

export const PROPOSED_ANTHROPIC_RATES: Record<string, AnthropicRates> = {
  'claude-opus-5-5': { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_write: 0.125, cache_read: 0.01 },
};

export const ANTHROPIC_API_VERSION = '2023-06-01';

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface AnthropicProviderOptions {
  baseUrl?: string;
  rates?: Record<string, AnthropicRates>;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: Fetch;
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly models: string[];
  private readonly baseUrl: string;
  private readonly rates: Record<string, AnthropicRates>;
  private readonly fetchFn: Fetch;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.rates = opts.rates ?? PROPOSED_ANTHROPIC_RATES;
    this.models = Object.keys(this.rates);
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
  }

  private rate(model: string): AnthropicRates {
    const r = this.rates[model];
    if (!r) throw new ProviderRejected(`no rate configured for model ${model}; refusing rather than guessing its cost`);
    return r;
  }

  maxCost(req: ProviderRequest): number {
    return this.maxMessagesCost(this.toBody(req));
  }

  maxMessagesCost(body: MessagesBody): number {
    const r = this.rates[body.model];
    if (!r) return Number.POSITIVE_INFINITY; // refused by the reservation, never under-reserved
    // A true ceiling: at most one input token per UTF-8 byte (only text reaches the provider, see
    // validateMessagesContent), billed at the highest input-side rate; thinking bills as output within max_tokens.
    const input = messagesInputBytes(body);
    return (input * Math.max(r.input, r.cache_write) + body.max_tokens * r.output) / 1e6;
  }

  private toBody(req: ProviderRequest): MessagesBody {
    return {
      model: req.model,
      max_tokens: req.max_output_tokens,
      messages: [
        {
          role: 'user',
          content: [
            ...req.context.map((c) => ({ type: 'text', text: `<context artifact="${c.artifact}">\n${c.text}\n</context>` })),
            { type: 'text', text: req.purpose },
          ],
        },
      ],
    };
  }

  async call(req: ProviderRequest, credential: string, signal: AbortSignal): Promise<ProviderResponse> {
    const r = await this.messages(this.toBody(req), credential, signal);
    const content = Array.isArray(r.response.content) ? (r.response.content as { type?: string; text?: string }[]) : [];
    return {
      model: r.model,
      output: content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
      usage: { input_tokens: Number(r.usage.input_tokens ?? 0), output_tokens: Number(r.usage.output_tokens ?? 0) },
      cost: r.cost,
    };
  }

  async messages(body: MessagesBody, credential: string, signal: AbortSignal, opts: { betas?: string[] } = {}): Promise<MessagesResult> {
    this.rate(body.model);
    validateMessagesContent(body);
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchFn(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': credential,
          'anthropic-version': ANTHROPIC_API_VERSION,
          'content-type': 'application/json',
          ...(opts.betas?.length ? { 'anthropic-beta': opts.betas.join(',') } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      // A connection that never opened sent nothing; anything else may have been accepted.
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (code && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)) throw new ProviderRejected(`anthropic unreachable (${code}); nothing was sent`);
      throw e;
    }
    if (!res.ok) {
      // An error response is a definite outcome: the request was not served (and is not billed).
      let detail = '';
      try {
        const j = (await res.json()) as { error?: { type?: string; message?: string } };
        detail = `${j.error?.type ?? 'error'}: ${j.error?.message ?? ''}`;
      } catch {
        detail = `HTTP ${res.status}`;
      }
      throw new ProviderRejected(`anthropic returned ${res.status} (${detail})`);
    }
    const response = (await res.json()) as Record<string, unknown>;
    const usage = (response.usage ?? {}) as Record<string, number>;
    const model = typeof response.model === 'string' ? response.model : body.model;
    return { response, model, usage, cost: this.cost(body.model, usage) };
  }

  /** Cost from the provider-reported usage at the operator's rates. */
  cost(model: string, usage: Record<string, number>): number {
    const r = this.rate(model);
    const n = (k: string) => (typeof usage[k] === 'number' ? usage[k] : 0);
    return (n('input_tokens') * r.input + n('cache_creation_input_tokens') * r.cache_write + n('cache_read_input_tokens') * r.cache_read + n('output_tokens') * r.output) / 1e6;
  }
}
