import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messagesInputBytes, ProviderRejected, validateMessagesContent, type MessagesBody, type MessagesResult, type Provider, type ProviderRequest, type ProviderResponse } from './provider.ts';

// omp's credential gateway as the provider broker's upstream (operator decision of 2026-10-13, see
// docs/operator-choices.md). The operator has subscription plans, not API keys: a Claude Team seat and a
// ChatGPT plan. oh-my-pi (`omp`) holds those logins in a dedicated omp profile and serves them through
// `omp auth-gateway stdio`, a child process of the broker, outside every sandbox. The broker holds no
// credential for these providers and never reads the logins. Agents still reach the model only through
// the per-attempt broker socket, and every call still passes `request_provider_call` (grant, approved
// provider and model, data class, reservation, retry cap).
//
// Protocol: JSON lines on stdio. The first line is {"ready":true,"version":V}; a request is
// {"id":N,"path":P,"method":M,"body":B} and its reply {"id":N,"status":S,"body":B}. Stdin stays open
// for the life of the process: omp may exit before flushing a large reply once its stdin closes.
//
// Accounting: a subscription has no per-token price. Spend is NOTIONAL, the API-list equivalent at
// operator-supplied rates, so reservations and budgets keep working and reports can show it. Before
// each call the adapter reads the plan's usage windows (cached briefly) and refuses while any window of
// the upstream is at or above the operator's headroom limit, which leaves room for the operator's own
// interactive use of the same plan. The snapshot is archived with the response.

export interface NotionalRates {
  input: number;
  output: number;
  /** 5-minute cache writes (OpenAI charges none: the input rate). */
  cache_write: number;
  cache_read: number;
}

/**
 * PROPOSED notional rates (USD per million tokens), an operator choice. Claude rates are the API list
 * prices of the cached model table of 2026-10-06. GPT-5.6 rates come from third-party price listings
 * of September 2026 that disagree; the higher figure is used so reservations stay conservative. Check
 * them before relying on spend figures. A model without a rate is refused, never guessed.
 */
export const PROPOSED_OMP_NOTIONAL_RATES: Record<string, NotionalRates> = {
  'anthropic/claude-fable-5-1': { input: 10, output: 50, cache_write: 12.5, cache_read: 0.25 },
  'anthropic/claude-opus-5-5': { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
  'anthropic/claude-sonnet-5-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  'anthropic/claude-haiku-5-5': { input: 0.1, output: 0.5, cache_write: 0.125, cache_read: 0.01 },
  'openai-codex/gpt-5.6-sol': { input: 5, output: 30, cache_write: 5, cache_read: 0.5 },
  'openai-codex/gpt-5.6-terra': { input: 2.5, output: 15, cache_write: 2.5, cache_read: 0.25 },
  'openai-codex/gpt-5.6-luna': { input: 1, output: 6, cache_write: 1, cache_read: 0.1 },
};

/** Proposed headroom (operator choice): no new call while any plan window is this full. */
export const PROPOSED_OMP_HEADROOM = 0.8;
/** Proposed age limit of a usage-window reading. */
export const PROPOSED_OMP_USAGE_TTL_MS = 60_000;
const READY_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 400;

export type OmpUpstream = 'anthropic' | 'openai-codex';

export interface OmpGatewayOptions {
  /** Absolute path of the pinned omp binary. */
  binary: string;
  /** Pinned omp version; a gateway reporting another version is refused. */
  version: string;
  /** The omp profile holding only the harness's logins (OMP_PROFILE). */
  profile: string;
  /** Tests: argv spawned instead of `<binary> auth-gateway stdio`. */
  command?: string[];
  /** Tests: extra environment for the gateway process. */
  env?: Record<string, string>;
  usageTtlMs?: number;
}

export interface GatewayReply {
  status: number;
  body: unknown;
}

/** One plan window as the gateway reports it (no account identifiers are kept). */
export interface PlanWindow {
  id: string;
  label: string;
  used_fraction: number | null;
  resets_at: number | null;
}

export interface PlanSnapshot {
  provider: OmpUpstream;
  fetched_at: number | null;
  plan_type: string | null;
  windows: PlanWindow[];
}

interface UsageReport {
  provider?: string;
  fetchedAt?: number;
  limits?: { id?: string; label?: string; window?: { resetsAt?: number }; amount?: { usedFraction?: number } }[];
  metadata?: { planType?: string; allowed?: boolean; limitReached?: boolean };
}

type Pending = { resolve(v: GatewayReply): void; reject(e: Error): void };

/** The `omp auth-gateway stdio` child process, shared by the providers it serves. */
export class OmpGateway {
  readonly opts: OmpGatewayOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<ChildProcessWithoutNullStreams> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private usageCache: { at: number; reports: UsageReport[] } | null = null;
  private stderrTail = '';

  constructor(opts: OmpGatewayOptions) {
    this.opts = opts;
  }

  private start(): Promise<ChildProcessWithoutNullStreams> {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const argv = this.opts.command ?? [this.opts.binary, 'auth-gateway', 'stdio'];
      // An empty working directory: the gateway never sees a target or the workspace.
      const cwd = mkdtempSync(join(tmpdir(), 'harness-omp-'));
      const env: Record<string, string> = { OMP_PROFILE: this.opts.profile, NO_COLOR: '1', ...(this.opts.env ?? {}) };
      for (const k of ['HOME', 'PATH', 'LANG']) if (process.env[k] !== undefined && env[k] === undefined) env[k] = process.env[k]!;
      const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let ready = false;
      let buf = '';
      const timer = setTimeout(() => {
        if (!ready) {
          child.kill();
          reject(new ProviderRejected(`omp gateway did not report ready within ${READY_TIMEOUT_MS} ms`));
        }
      }, READY_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        this.reset(child, new ProviderRejected(`omp gateway could not start: ${e.message}`));
        if (!ready) reject(new ProviderRejected(`omp gateway could not start: ${e.message}`));
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        const why = `omp gateway exited (${signal ?? `code ${code}`})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`;
        // A request already written may have been accepted upstream: its outcome is unknown.
        this.reset(child, new Error(why));
        if (!ready) reject(new ProviderRejected(why));
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => {
        this.stderrTail = (this.stderrTail + d).slice(-STDERR_TAIL);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: { ready?: boolean; version?: string; id?: number; status?: number; body?: unknown };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (!ready) {
            if (msg.ready !== true) continue;
            ready = true;
            clearTimeout(timer);
            if (msg.version !== this.opts.version) {
              child.kill();
              reject(new ProviderRejected(`omp ${String(msg.version)} is not the pinned version ${this.opts.version}; update the workspace configuration after reviewing the new version`));
              return;
            }
            this.child = child;
            this.refIdle();
            resolve(child);
            continue;
          }
          const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
          if (!p) continue;
          this.pending.delete(msg.id!);
          this.refIdle();
          p.resolve({ status: Number(msg.status), body: msg.body });
        }
      });
    });
    // A failed start may be retried by a later call.
    this.starting.catch(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private reset(child: ChildProcessWithoutNullStreams, err: Error): void {
    if (this.child === child) this.child = null;
    this.starting = null;
    this.usageCache = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(err);
    }
  }

  /** Keep the process alive only while a request is in flight. */
  private refIdle(): void {
    const c = this.child;
    if (!c) return;
    const busy = this.pending.size > 0;
    for (const h of [c, c.stdin, c.stdout, c.stderr] as unknown as { ref(): void; unref(): void }[]) {
      if (busy) h.ref();
      else h.unref();
    }
  }

  async request(path: string, method: 'GET' | 'POST', body: unknown, signal?: AbortSignal): Promise<GatewayReply> {
    const child = await this.start();
    const id = this.nextId++;
    return new Promise<GatewayReply>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(id)) {
          this.refIdle();
          reject(new Error('aborted; the gateway may still complete the request'));
        }
      };
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      this.refIdle();
      signal?.addEventListener('abort', onAbort, { once: true });
      const line = JSON.stringify(method === 'GET' ? { id, path, method } : { id, path, method, body }) + '\n';
      child.stdin.write(line, (err) => {
        // A write the gateway never received sent nothing.
        if (err && this.pending.delete(id)) {
          this.refIdle();
          reject(new ProviderRejected(`could not send the request to the omp gateway: ${err.message}`));
        }
      });
    });
  }

  /** The plan usage reports for every login in the profile, at most `usageTtlMs` old. */
  async usage(signal?: AbortSignal): Promise<UsageReport[]> {
    const ttl = this.opts.usageTtlMs ?? PROPOSED_OMP_USAGE_TTL_MS;
    if (this.usageCache && Date.now() - this.usageCache.at < ttl) return this.usageCache.reports;
    let reply: GatewayReply;
    try {
      reply = await this.request('/v1/usage', 'GET', undefined, signal);
    } catch (e) {
      throw e instanceof ProviderRejected ? e : new ProviderRejected(`omp gateway usage unavailable: ${(e as Error).message}`);
    }
    const reports = (reply.body as { reports?: unknown })?.reports;
    if (reply.status !== 200 || !Array.isArray(reports)) throw new ProviderRejected(`omp gateway usage unavailable (status ${reply.status})`);
    this.usageCache = { at: Date.now(), reports: reports as UsageReport[] };
    return this.usageCache.reports;
  }

  close(): void {
    const c = this.child;
    if (c) {
      this.reset(c, new Error('omp gateway closed'));
      c.kill();
    }
  }
}

export interface OmpGatewayProviderOptions {
  /** Broker provider name, approved per engagement (e.g. `omp-anthropic`). */
  name: string;
  upstream: OmpUpstream;
  /** Gateway model ids, each `<upstream>/<model>`. */
  models: string[];
  rates?: Record<string, NotionalRates>;
  headroom?: number;
}

/** A broker provider served by the omp gateway: one per upstream, so each is approved separately. */
export class OmpGatewayProvider implements Provider {
  /** The gateway authenticates with the omp profile's logins; the broker holds no key. */
  readonly ownCredential = true;
  readonly name: string;
  readonly upstream: OmpUpstream;
  readonly models: string[];
  readonly gateway: OmpGateway;
  private readonly rates: Record<string, NotionalRates>;
  private readonly headroom: number;

  constructor(gateway: OmpGateway, opts: OmpGatewayProviderOptions) {
    this.gateway = gateway;
    this.name = opts.name;
    this.upstream = opts.upstream;
    this.rates = opts.rates ?? PROPOSED_OMP_NOTIONAL_RATES;
    this.headroom = opts.headroom ?? PROPOSED_OMP_HEADROOM;
    if (!(this.headroom > 0 && this.headroom <= 1)) throw new Error(`${opts.name}: headroom must be in (0, 1]`);
    for (const m of opts.models) {
      if (!m.startsWith(`${opts.upstream}/`)) throw new Error(`${opts.name}: model ${m} is not an ${opts.upstream} model`);
    }
    this.models = [...opts.models];
  }

  private rate(model: string): NotionalRates {
    if (!this.models.includes(model)) throw new ProviderRejected(`${this.name} does not offer model ${model}`);
    const r = this.rates[model];
    if (!r) throw new ProviderRejected(`no notional rate configured for model ${model}; refusing rather than guessing its cost`);
    return r;
  }

  maxCost(req: ProviderRequest): number {
    return this.maxMessagesCost(this.toBody(req));
  }

  maxMessagesCost(body: MessagesBody): number {
    const r = this.models.includes(body.model) ? this.rates[body.model] : undefined;
    if (!r) return Number.POSITIVE_INFINITY; // refused by the reservation, never under-reserved
    // The same ceiling as the Anthropic adapter: one token per input byte at the highest input-side rate.
    return (messagesInputBytes(body) * Math.max(r.input, r.cache_write) + body.max_tokens * r.output) / 1e6;
  }

  private toBody(req: ProviderRequest): MessagesBody {
    return {
      model: req.model,
      max_tokens: req.max_output_tokens,
      messages: [
        {
          role: 'user',
          content: [...req.context.map((c) => ({ type: 'text', text: `<context artifact="${c.artifact}">\n${c.text}\n</context>` })), { type: 'text', text: req.purpose }],
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

  /** Read the upstream's plan windows; refuse while the plan is closed or any window is past the headroom. */
  async planHeadroom(signal?: AbortSignal): Promise<PlanSnapshot> {
    const report = (await this.gateway.usage(signal)).find((r) => r.provider === this.upstream);
    if (!report) throw new ProviderRejected(`the omp profile ${this.gateway.opts.profile} has no ${this.upstream} login (no usage report)`);
    const snapshot: PlanSnapshot = {
      provider: this.upstream,
      fetched_at: typeof report.fetchedAt === 'number' ? report.fetchedAt : null,
      plan_type: typeof report.metadata?.planType === 'string' ? report.metadata.planType : null,
      windows: (report.limits ?? []).map((l) => ({
        id: String(l.id ?? ''),
        label: String(l.label ?? l.id ?? ''),
        used_fraction: typeof l.amount?.usedFraction === 'number' ? l.amount.usedFraction : null,
        resets_at: typeof l.window?.resetsAt === 'number' ? l.window.resetsAt : null,
      })),
    };
    if (report.metadata?.allowed === false || report.metadata?.limitReached === true) throw new ProviderRejected(`the ${this.upstream} plan reports its limit reached`);
    const full = snapshot.windows.find((w) => w.used_fraction !== null && w.used_fraction >= this.headroom);
    if (full) {
      throw new ProviderRejected(`${this.upstream} plan window "${full.label}" is ${Math.round(full.used_fraction! * 100)}% used; the headroom limit is ${Math.round(this.headroom * 100)}%`);
    }
    return snapshot;
  }

  async messages(body: MessagesBody, _credential: string, signal: AbortSignal): Promise<MessagesResult> {
    this.rate(body.model);
    validateMessagesContent(body);
    const plan = await this.planHeadroom(signal);
    const reply = await this.gateway.request('/v1/messages', 'POST', body, signal);
    if (reply.status !== 200) {
      // An error reply is a definite outcome: the request was not served.
      const e = (reply.body as { error?: { type?: string; message?: string } } | null)?.error;
      throw new ProviderRejected(`omp gateway returned ${reply.status} (${e?.type ?? 'error'}: ${e?.message ?? ''})`);
    }
    const response = reply.body as Record<string, unknown> | null;
    if (!response || typeof response !== 'object' || !Array.isArray(response.content)) throw new Error('omp gateway returned 200 without a Messages response');
    const usage = (response.usage ?? {}) as Record<string, number>;
    const model = typeof response.model === 'string' ? response.model : body.model;
    return { response, model, usage, cost: this.cost(body.model, usage), plan };
  }

  /** Notional cost from the reported usage at the operator's rates. */
  cost(model: string, usage: Record<string, number>): number {
    const r = this.rate(model);
    const n = (k: string) => (typeof usage[k] === 'number' ? usage[k] : 0);
    return (n('input_tokens') * r.input + n('cache_creation_input_tokens') * r.cache_write + n('cache_read_input_tokens') * r.cache_read + n('output_tokens') * r.output) / 1e6;
  }
}
