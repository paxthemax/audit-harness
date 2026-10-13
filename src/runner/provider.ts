import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fail, HarnessError } from '../core/errors.ts';
import { digestJson, isDigest, randomToken } from '../core/hash.ts';
import type { ArtifactRef, Ref } from '../core/refs.ts';
import { defineOperation, type Controller, type OpContext, type Session } from '../controller/controller.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { currentAuthorization } from './jobs.ts';
import { loadContextManifest, type ContextManifestView } from './context.ts';
import { ledgerEntries, parseProviderNote, reserve, type ProviderNote } from './ledger.ts';

// Provider broker (design/harness-state-and-execution.md, "Permissions and isolation" and "Durable
// jobs and resource limits"; design/harness-interface-contracts.md, "Context builder to provider
// broker"). The model provider is an OPEN operator choice: this module defines the broker interface and
// a FakeProvider for tests; anthropic.ts is a candidate adapter that only an engagement's policy and a
// work authorization can approve. Agent hosts reach the broker through brokerSocket.ts (Messages mode).
//
// The broker holds provider credentials in its own memory, outside workers and the record store; a
// self-authenticating provider (ompGateway.ts) keeps its own logins outside every sandbox instead. A
// call is admitted only with authorized context references (artifact digests the controller already
// admitted in this engagement), an approved provider and data class, and a reservation of the maximum
// cost. A timeout after the request may have been accepted records `outcome_unknown` with an
// `uncertain` ledger entry and keeps the reservation; the broker never retries, and a replacement
// call needs a new reservation within the retry cap.

export interface ProviderRequest {
  model: string;
  /** Resolved bytes of the admitted context references, in order. */
  context: { artifact: string; text: string }[];
  max_output_tokens: number;
  purpose: string;
}

export interface ProviderResponse {
  /** Model identity the provider reports (may differ from the requested model). */
  model: string;
  output: string;
  usage: { input_tokens: number; output_tokens: number };
  /** Billed cost when the provider reports it; null means the reservation is charged as an estimate. */
  cost: number | null;
}

/** An Anthropic Messages API request as an agent host sends it through the broker socket. */
export interface MessagesBody {
  model: string;
  max_tokens: number;
  system?: unknown;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: unknown;
  output_config?: unknown;
  stop_sequences?: string[];
  metadata?: unknown;
  context_management?: unknown;
}

export interface MessagesResult {
  /** The provider's Messages API response object, returned to the agent unchanged. */
  response: Record<string, unknown>;
  model: string;
  usage: Record<string, unknown>;
  cost: number | null;
  /** Plan usage windows observed before the call (subscription providers), archived with the response. */
  plan?: unknown;
}

export interface Provider {
  readonly name: string;
  readonly models: string[];
  /** The provider authenticates itself (a credential gateway such as omp's); the broker holds no key. */
  readonly ownCredential?: boolean;
  /** Upper bound on the cost of a request (the reservation). */
  maxCost(req: ProviderRequest): number;
  call(req: ProviderRequest, credential: string, signal: AbortSignal): Promise<ProviderResponse>;
  /** Messages mode (agent hosts): upper bound on the cost of a Messages request. */
  maxMessagesCost?(body: MessagesBody): number;
  messages?(body: MessagesBody, credential: string, signal: AbortSignal, opts?: { betas?: string[] }): Promise<MessagesResult>;
}

export type FakeMessagesStep = Record<string, unknown> | 'hang' | 'refuse';

/** Test provider: scripted behaviours, deterministic output, charges per token. */
export class FakeProvider implements Provider {
  readonly name: string;
  readonly models: string[];
  readonly script: ('ok' | 'hang' | 'refuse')[];
  /** Scripted Messages API responses (content blocks, stop_reason, usage...), consumed in order. */
  readonly messagesScript: FakeMessagesStep[];
  readonly received: { req: ProviderRequest; credential: string }[] = [];
  readonly messageRequests: { body: MessagesBody; credential: string }[] = [];
  private readonly pricePerToken: number;

  constructor(opts: { name?: string; models?: string[]; script?: ('ok' | 'hang' | 'refuse')[]; messages?: FakeMessagesStep[]; pricePerToken?: number } = {}) {
    this.name = opts.name ?? 'fake';
    this.models = opts.models ?? ['fake-model-1'];
    this.script = opts.script ?? [];
    this.messagesScript = opts.messages ?? [];
    this.pricePerToken = opts.pricePerToken ?? 0.001;
  }

  maxCost(req: ProviderRequest): number {
    const input = req.context.reduce((n, c) => n + Buffer.byteLength(c.text), 0) + Buffer.byteLength(req.purpose);
    return (input + req.max_output_tokens) * this.pricePerToken;
  }

  call(req: ProviderRequest, credential: string, signal: AbortSignal): Promise<ProviderResponse> {
    const behaviour = this.script.shift() ?? 'ok';
    if (behaviour === 'refuse') return Promise.reject(new ProviderRejected('fake provider refused before accepting the request'));
    this.received.push({ req, credential });
    if (behaviour === 'hang') return hang(signal);
    const input = req.context.reduce((n, c) => n + Math.ceil(c.text.length / 4), 0);
    const output = `fake answer for ${req.purpose} over ${req.context.length} reference(s)`;
    return Promise.resolve({
      model: `${req.model}@fake-2026-10`,
      output,
      usage: { input_tokens: input, output_tokens: Math.ceil(output.length / 4) },
      cost: (input + Math.ceil(output.length / 4)) * this.pricePerToken,
    });
  }

  maxMessagesCost(body: MessagesBody): number {
    return (messagesInputBytes(body) + body.max_tokens) * this.pricePerToken;
  }

  messages(body: MessagesBody, credential: string, signal: AbortSignal): Promise<MessagesResult> {
    const step = this.messagesScript.shift() ?? { content: [{ type: 'text', text: 'fake reply' }], stop_reason: 'end_turn' };
    if (step === 'refuse') return Promise.reject(new ProviderRejected('fake provider refused before accepting the request'));
    this.messageRequests.push({ body, credential });
    if (step === 'hang') return hang(signal);
    const input = Math.ceil(JSON.stringify(body.messages).length / 4);
    const usage = { input_tokens: input, output_tokens: 20, ...((step.usage as object) ?? {}) } as Record<string, number>;
    const response = {
      id: `msg_fake_${this.messageRequests.length}`,
      type: 'message',
      role: 'assistant',
      model: `${body.model}@fake-2026-10`,
      stop_reason: 'end_turn',
      stop_sequence: null,
      ...step,
      usage,
    };
    return Promise.resolve({ response, model: String(response.model), usage, cost: (usage.input_tokens + usage.output_tokens) * this.pricePerToken });
  }
}

function hang<T>(signal: AbortSignal): Promise<T> {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
}

/** A provider error known to precede acceptance: nothing was sent, the reservation is released. */
export class ProviderRejected extends Error {}

// -----------------------------------------------------------------------------------------------
// Broker registry: one broker per controller process holds the credentials.

interface Registered {
  provider: Provider;
  /** null: the provider is registered but unavailable (no credential), with the reason. */
  credential: string | null;
  unavailable: string | null;
}

let activeBroker: ProviderBroker | null = null;

/** Proposed policy values (operator choices). */
export const PROPOSED_PROVIDER_TIMEOUT_MS = 120_000;
export const PROPOSED_LIVE_EXPLOITABLE_MAX_REFS = 4;

export interface MessagesOutcome extends ProviderCallResult {
  /** The provider's response object (completed calls only). */
  body: Record<string, unknown> | null;
  reason: string | null;
}

export class ProviderBroker {
  readonly controller: Controller;
  readonly timeoutMs: number;
  /** Providers the operator approved for the live-exploitable data class (restricts further). */
  readonly liveExploitableProviders: Set<string>;
  private readonly providers = new Map<string, Registered>();

  constructor(controller: Controller, opts: { timeoutMs?: number; liveExploitableProviders?: string[] } = {}) {
    this.controller = controller;
    this.timeoutMs = opts.timeoutMs ?? PROPOSED_PROVIDER_TIMEOUT_MS;
    this.liveExploitableProviders = new Set(opts.liveExploitableProviders ?? []);
    activeBroker = this;
  }

  static active(): ProviderBroker | null {
    return activeBroker;
  }

  /** Make this broker the process's broker (tests run several). */
  activate(): void {
    activeBroker = this;
  }

  register(provider: Provider, credential: string): void {
    this.providers.set(provider.name, { provider, credential, unavailable: null });
  }

  /**
   * Register with the credential at `<workspace>/secrets/providers/<name>.key` (mode 0600), read by
   * this process only. A missing key leaves the provider `unavailable`; it never falls back.
   */
  registerFromWorkspace(provider: Provider): { available: boolean; reason: string | null } {
    const path = join(this.controller.ws.root, 'secrets', 'providers', `${provider.name}.key`);
    let reason: string | null = null;
    let credential: string | null = null;
    if (!existsSync(path)) reason = `provider ${provider.name} unavailable: no credential at secrets/providers/${provider.name}.key`;
    else if ((statSync(path).mode & 0o077) !== 0) reason = `provider ${provider.name} unavailable: secrets/providers/${provider.name}.key must be mode 0600`;
    else credential = readFileSync(path, 'utf8').trim() || null;
    if (!credential && !reason) reason = `provider ${provider.name} unavailable: empty credential file`;
    this.providers.set(provider.name, { provider, credential, unavailable: reason });
    return { available: credential !== null, reason };
  }

  /** Register a provider that authenticates itself; the broker reads and holds no credential for it. */
  registerSelfAuthenticating(provider: Provider): void {
    if (!provider.ownCredential) throw new Error(`provider ${provider.name} does not authenticate itself`);
    this.providers.set(provider.name, { provider, credential: null, unavailable: null });
  }

  provider(name: string): Provider | null {
    return this.providers.get(name)?.provider ?? null;
  }

  /** Why a registered provider cannot be used, or null when it can. */
  unavailable(name: string): string | null {
    const r = this.providers.get(name);
    return r ? r.unavailable : `provider ${name} is not configured with the provider broker`;
  }

  providerNames(): string[] {
    return [...this.providers.keys()];
  }

  /** Request (reserve) and execute a call; the session's channel decides what it may reference. */
  async call(session: Session, engagementId: string, payload: ProviderCallPayload): Promise<ProviderCallResult> {
    const { call_id } = session.do(engagementId, 'request_provider_call', payload);
    return this.execute(engagementId, call_id);
  }

  /** Execute an admitted call once and record its outcome. Never retries. */
  async execute(engagementId: string, callId: string): Promise<ProviderCallResult> {
    const { body: _b, reason: _r, ...rest } = await this.run(engagementId, callId);
    return rest;
  }

  /** Execute an admitted Messages-mode call (broker socket) and return the response body too. */
  async executeMessages(engagementId: string, callId: string): Promise<MessagesOutcome> {
    return this.run(engagementId, callId);
  }

  private async run(engagementId: string, callId: string): Promise<MessagesOutcome> {
    const store = this.controller.ws.store(engagementId, true);
    const pending = findCall(store, callId);
    if (!pending) fail('not_found', `provider call ${callId} not found`);
    if (pending.outcome) fail('idempotency_conflict', `provider call ${callId} already has outcome ${pending.outcome}; a new call needs a new reservation`);
    const reg = this.providers.get(pending.note.provider);
    if (!reg || reg.unavailable !== null || (!reg.credential && !reg.provider.ownCredential)) {
      fail('unsupported', reg?.unavailable ?? `provider ${pending.note.provider} is not registered with the broker`);
    }
    const credential = reg.credential ?? '';
    const messagesMode = pending.note.mode === 'messages';
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve('timeout');
      }, this.timeoutMs);
    });
    let outcome: RecordOutcomePayload;
    let body: Record<string, unknown> | null = null;
    try {
      if (messagesMode) {
        if (!reg.provider.messages) fail('unsupported', `provider ${reg.provider.name} has no Messages mode`);
        const stored = store.archive.getJson<{ body: MessagesBody; betas?: string[] }>(pending.note.request);
        const req = stored.body;
        validateMessagesContent(req);
        const r = await Promise.race([reg.provider.messages(req, credential, ac.signal, { betas: stored.betas ?? [] }), timeout]);
        if (r === 'timeout') {
          outcome = { call_id: callId, outcome: 'outcome_unknown', reason: `no response within ${this.timeoutMs} ms; the provider may have accepted the request` };
        } else {
          body = r.response;
          const response = store.archive.putJson({ format: 'harness.provider_messages_response/1', response: r.response, usage: r.usage, ...(r.plan !== undefined ? { plan: r.plan } : {}) });
          outcome = { call_id: callId, outcome: 'completed', response, model_returned: r.model, cost: r.cost };
        }
      } else {
        const spec = store.archive.getJson<{ model: string; context: string[]; max_output_tokens: number; purpose: string }>(pending.note.request);
        const req: ProviderRequest = {
          model: spec.model,
          context: spec.context.map((d) => ({ artifact: d, text: store.archive.getText(d) })),
          max_output_tokens: spec.max_output_tokens,
          purpose: spec.purpose,
        };
        const r = await Promise.race([reg.provider.call(req, credential, ac.signal), timeout]);
        if (r === 'timeout') {
          outcome = { call_id: callId, outcome: 'outcome_unknown', reason: `no response within ${this.timeoutMs} ms; the provider may have accepted the request` };
        } else {
          const response = store.archive.putJson({ format: 'harness.provider_response/1', model: r.model, output: r.output, usage: r.usage });
          outcome = { call_id: callId, outcome: 'completed', response, model_returned: r.model, cost: r.cost };
        }
      }
    } catch (e) {
      if (e instanceof HarnessError) throw e;
      outcome =
        e instanceof ProviderRejected
          ? { call_id: callId, outcome: 'failed_before_send', reason: e.message }
          : { call_id: callId, outcome: 'outcome_unknown', reason: `transport failure after sending: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
    const recorded: ProviderCallResult = this.controller.runner().do(engagementId, 'record_provider_outcome', outcome);
    return { ...recorded, body, reason: outcome.reason ?? null };
  }
}

// -----------------------------------------------------------------------------------------------
// Operations

export interface ProviderCallPayload {
  /** Required off the worker channel; a worker charges its grant's authorization. */
  authorization?: Ref | string;
  provider: string;
  model: string;
  /** Optional and only ever stricter: the controller derives the data class from the artifacts. */
  data_class?: string;
  /** Authorized context references: members of the context manifest (required for workers). */
  context: ArtifactRef[];
  /** Built by the context builder; a worker defaults to its job's manifest. */
  context_manifest?: ArtifactRef | null;
  max_output_tokens: number;
  purpose: string;
}

export interface ProviderCallResult {
  call_id: string;
  outcome: 'completed' | 'outcome_unknown' | 'failed_before_send';
  response: ArtifactRef | null;
  model_returned: string | null;
  spend_status: 'confirmed' | 'estimated' | 'uncertain' | 'released';
}

interface PendingCall {
  note: ProviderNote['provider_call'];
  authorization: Ref;
  attempt: Ref | null;
  reserved: number;
  outcome: string | null;
}

function findCall(store: RecordStore, callId: string): PendingCall | null {
  const entries = store.heads('ledger_entry').filter((e) => parseProviderNote(e.body.note)?.id === callId);
  const res = entries.find((e) => e.body.kind === 'reservation');
  if (!res) return null;
  const settled = entries.find((e) => e.body.kind !== 'reservation');
  return {
    note: parseProviderNote(res.body.note)!,
    authorization: res.body.authorization,
    attempt: res.body.attempt,
    reserved: res.body.spend,
    outcome: settled ? (parseProviderNote(settled.body.note)?.outcome ?? settled.body.kind) : null,
  };
}

/** Digests referenced by committed records of this engagement (directly or as members of referenced trees). */
function mentionedByRecords(ctx: OpContext, d: string): boolean {
  const seen = new Set<string>();
  for (const env of ctx.store.heads()) {
    for (const m of JSON.stringify(env.body).matchAll(/sha256:[0-9a-f]{64}/g)) seen.add(m[0]);
    for (const dep of env.depends_on) if ('artifact' in dep) seen.add(dep.artifact);
  }
  if (seen.has(d)) return true;
  for (const t of seen) {
    try {
      if (Object.values(ctx.archive.getTree(t).files).includes(d)) return true;
    } catch {
      /* not a tree manifest, or not in the archive */
    }
  }
  return false;
}

const TERMINAL = ['rejected', 'no_finding_within_bounds', 'triaged_out'];
const LIVE_TYPES = ['finding', 'review_packet', 'human_decision', 'position'];

/**
 * Data class derived by the controller (never only caller-declared): material about vulnerabilities
 * not yet fixed or resolved is live-exploitable; snapshot source is `source`; anything unrecognised is
 * treated as live-exploitable.
 */
export function deriveDataClasses(store: RecordStore, liveClass: string, digests: string[], manifest: ContextManifestView | null, manifestDigest: string | null): Map<string, string> {
  const open = new Map<string, boolean>();
  const isOpen = (invId: string): boolean => {
    if (open.has(invId)) return open.get(invId)!;
    const inv = store.head<'investigation'>(invId);
    let res = true;
    const disp = inv?.body.disposition?.value ?? null;
    if (disp && TERMINAL.includes(disp)) res = false;
    else if (disp === 'accepted') {
      const findings = store.heads('finding').filter((f) => f.body.investigation.record_id === invId);
      res = findings.some((f) => !f.body.fix_assessments.some((fa) => store.head<'fix_assessment'>(fa.record_id)?.body.label === 'fixed'));
    }
    open.set(invId, res);
    return res;
  };
  const evidenceOpen = (body: { job?: Ref | null }): boolean => {
    if (!body.job) return false;
    const job = store.tryGet<'job'>(body.job);
    return !!job?.body.investigation && isOpen(job.body.investigation.record_id);
  };
  const live = new Set<string>();
  const addAll = (v: unknown) => {
    for (const m of JSON.stringify(v).matchAll(/sha256:[0-9a-f]{64}/g)) live.add(m[0]);
  };
  for (const env of store.heads()) {
    if (LIVE_TYPES.includes(env.type as string) || (env.type === 'evidence_artifact' && evidenceOpen(env.body as { job: Ref | null }))) {
      addAll(env.body);
      addAll(env.depends_on);
    }
  }
  const source = new Set<string>();
  for (const s of store.heads('target_snapshot')) {
    try {
      for (const d of Object.values(store.archive.getTree(s.body.tree.artifact).files)) source.add(d);
    } catch {
      /* missing tree: nothing classified as source */
    }
  }
  for (const s of manifest?.sources ?? []) {
    if (!live.has(s.original)) {
      source.add(s.original);
      source.add(s.view);
    }
  }
  const manifestLive = !!manifest && (manifest.records.some((r) => !sourceOnlyRecord(r)) || !!(manifest as { contradictions?: unknown[] }).contradictions?.length);
  const out = new Map<string, string>();
  for (const d of digests) {
    if (d === manifestDigest) out.set(d, manifestLive ? liveClass : 'source');
    else if (live.has(d) || !source.has(d)) out.set(d, liveClass);
    else out.set(d, 'source');
  }
  return out;
}

defineOperation<ProviderCallPayload>({
  name: 'request_provider_call',
  channels: ['worker', 'auditor', 'controller'],
  mutating: true,
  handler(ctx, p) {
    if (p && (p as { messages_request?: unknown }).messages_request !== undefined) return messagesCall(ctx, p as unknown as MessagesCallPayload);
    const allowed = ['authorization', 'provider', 'model', 'data_class', 'context', 'context_manifest', 'max_output_tokens', 'purpose'];
    for (const k of Object.keys(p ?? {})) {
      if (!allowed.includes(k)) fail('invalid_request', `provider calls accept only authorized context references; unsupported field ${k}`);
    }
    if (!p.provider || !p.model || !p.purpose || !Array.isArray(p.context) || !p.context.length) {
      fail('invalid_request', 'provider, model, purpose and context references are required');
    }
    if (!Number.isInteger(p.max_output_tokens) || p.max_output_tokens <= 0) fail('invalid_request', 'max_output_tokens must be a positive integer');
    const cs = ctx.store.heads('control_state')[0];
    if (cs?.body.paused) fail('permission_denied', 'engagement is paused');

    let authRef: Ref | string;
    let attempt: Ref | null = null;
    const worker = ctx.principal.channel === 'worker' ? ctx.principal.grant! : null;
    if (worker) {
      authRef = worker.authorization.record_id;
      attempt = worker.attempt;
    } else {
      if (!p.authorization) fail('invalid_request', 'authorization is required');
      authRef = p.authorization;
    }
    const auth = currentAuthorization(ctx, authRef);

    const eng = ctx.store.heads('engagement')[0];
    const policy = eng?.body.policy;
    if (!policy) fail('permission_denied', 'no accepted data policy: provider calls are refused');
    const dp = policy.data_policy;
    if (!dp.approved_providers.includes(p.provider) || !auth.body.capabilities.providers.includes(p.provider)) {
      fail('permission_denied', `provider ${p.provider} is not approved for this engagement and authorization`);
    }
    const broker = ProviderBroker.active();
    const provider = broker?.provider(p.provider);
    if (!broker || !provider) fail('unsupported', `provider ${p.provider} is not configured with the provider broker`);
    const why = broker.unavailable(p.provider);
    if (why) fail('unsupported', why);
    if (!provider.models.includes(p.model)) fail('unsupported', `model ${p.model} is not offered by ${p.provider}`);

    // Admission: a worker's references must lie inside a context manifest the context builder made
    // (being mentioned by some record admits nothing). The auditor may also cite material that
    // committed records reference.
    const manifestRef = p.context_manifest ?? (worker ? ctx.store.get(worker.job, 'job').body.context_manifest : null);
    if (worker && !manifestRef) fail('egress_denied', 'worker provider calls carry a context manifest built by the context builder');
    const manifest = manifestRef ? loadContextManifest(ctx.store, manifestRef) : null;
    if (worker && manifest && worker.investigation && manifest.investigation?.record_id !== worker.investigation.record_id) {
      fail('egress_denied', 'the context manifest was built for another investigation');
    }
    const inManifest = (d: string) => !!manifestRef && (d === manifestRef.artifact || manifest!.sources.some((s) => s.original === d || s.view === d));
    for (const c of p.context) {
      if (!c || !isDigest(c.artifact)) fail('invalid_request', 'context entries must be artifact references');
      if (!ctx.archive.has(c.artifact)) fail('egress_denied', `context ${c.artifact} is not in the archive`);
      const ok = inManifest(c.artifact) || (!worker && !manifest && mentionedByRecords(ctx, c.artifact));
      if (!ok) fail('egress_denied', `context ${c.artifact} is outside the authorized context`);
    }

    // The controller derives the data class; a caller may only declare the stricter live class.
    const classes = deriveDataClasses(ctx.store, dp.live_exploitable_class, p.context.map((c) => c.artifact), manifest, manifestRef?.artifact ?? null);
    const derivedLive = [...classes.values()].includes(dp.live_exploitable_class);
    if (p.data_class !== undefined && !dp.data_classes.includes(p.data_class) && p.data_class !== dp.live_exploitable_class) {
      fail('egress_denied', `data class ${p.data_class} is not approved for egress`);
    }
    const dataClass = derivedLive || p.data_class === dp.live_exploitable_class ? dp.live_exploitable_class : 'source';
    if (dataClass !== dp.live_exploitable_class && !dp.data_classes.includes(dataClass)) fail('egress_denied', `data class ${dataClass} is not approved for egress`);
    if (dataClass === dp.live_exploitable_class) {
      if (!broker.liveExploitableProviders.has(p.provider)) fail('egress_denied', `${p.provider} is not approved for the live-exploitable class (${dataClass})`);
      if (p.context.length > PROPOSED_LIVE_EXPLOITABLE_MAX_REFS) fail('egress_denied', 'live-exploitable material goes out with minimal context only');
    }

    const spec = { model: p.model, context: p.context.map((c) => c.artifact), max_output_tokens: p.max_output_tokens, purpose: p.purpose };
    const request = ctx.archive.putJson({ format: 'harness.provider_request/1', provider: p.provider, data_class: dataClass, ...spec });
    ctx.tx.blob(request);
    const requestIdentity = digestJson({ provider: p.provider, ...spec });

    // Retries of the same request are bounded; each needs its own reservation.
    const prior = ledgerEntries(ctx.store, auth.ref.record_id).filter((e) => e.kind === 'reservation' && parseProviderNote(e.note)?.request === request.artifact);
    if (prior.length >= 1 + auth.body.limits.retries) {
      fail('budget_exhausted', `retry cap reached for this provider request (${prior.length} reservation(s)); reconcile the earlier calls`);
    }
    const maxCost = provider.maxCost({ ...spec, context: p.context.map((c) => ({ artifact: c.artifact, text: ctx.archive.getText(c.artifact) })) });
    const call_id = `call-${randomToken(8)}`;
    const note: ProviderNote = {
      provider_call: { id: call_id, provider: p.provider, model_requested: p.model, request: request.artifact, data_class: dataClass },
    };
    const reservation = reserve(ctx, auth, attempt, { spend: maxCost, runtime_seconds: 0 }, JSON.stringify(note));
    ctx.tx.event('provider_call_reserved', { call_id, request_identity: requestIdentity, reservation, data_class: dataClass });
    return { call_id, reservation, max_cost: maxCost, request, data_class: dataClass };
  },
});

/** UTF-8 bytes of everything a Messages request sends: an upper bound on its input tokens. */
export function messagesInputBytes(body: Pick<MessagesBody, 'system' | 'messages' | 'tools'>): number {
  return Buffer.byteLength(JSON.stringify({ system: body.system ?? null, messages: body.messages, tools: body.tools ?? null }));
}

const BLOCK_KEYS: Record<string, string[]> = {
  text: ['type', 'text', 'cache_control'],
  tool_use: ['type', 'id', 'name', 'input', 'cache_control'],
  tool_result: ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'],
  // Model-produced reasoning echoed back on the assistant side (no external content).
  thinking: ['type', 'thinking', 'signature'],
  redacted_thinking: ['type', 'data'],
};

function refuseBlock(where: string, why: string): never {
  fail('egress_denied', `${where}: ${why}; only text, tool_use and tool_result content is sent (nothing was sent)`);
}

function checkTextBlocks(v: unknown, where: string): void {
  if (typeof v === 'string') return;
  if (!Array.isArray(v)) refuseBlock(where, 'content must be a string or text blocks');
  v.forEach((b, i) => {
    if (!b || typeof b !== 'object' || (b as { type?: unknown }).type !== 'text') refuseBlock(`${where}[${i}]`, `block type ${(b as { type?: unknown })?.type}`);
    checkBlock(b as Record<string, unknown>, `${where}[${i}]`, 'user');
  });
}

function checkBlock(b: Record<string, unknown>, where: string, role: string): void {
  const type = String(b.type);
  const keys = BLOCK_KEYS[type];
  if (!keys) refuseBlock(where, `block type ${type} (images, documents, search results and URL sources are refused)`);
  if ((type === 'thinking' || type === 'redacted_thinking') && role !== 'assistant') refuseBlock(where, `${type} blocks come only from the assistant`);
  for (const k of Object.keys(b)) if (!keys.includes(k)) refuseBlock(where, `field ${k} on a ${type} block`);
  if (type === 'text' && typeof b.text !== 'string') refuseBlock(where, 'text must be a string');
  if (type === 'tool_use' && (typeof b.name !== 'string' || !b.input || typeof b.input !== 'object')) refuseBlock(where, 'malformed tool_use');
  if (type === 'tool_result' && b.content !== undefined) checkTextBlocks(b.content, `${where}.content`);
}

/**
 * Content the broker forwards: text, tool_use and tool_result blocks (and the assistant's own
 * reasoning blocks). Anything that could make the provider fetch or ingest outside material — images,
 * documents, `source` objects, URLs as content, citations, search results — is refused with
 * `egress_denied` before anything is sent.
 */
function isEffortOnly(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => k === 'effort') && typeof (v as { effort?: unknown }).effort === 'string';
}

export function validateMessagesContent(body: Pick<MessagesBody, 'system' | 'messages'>): void {
  if (body.system !== undefined) checkTextBlocks(body.system, 'system');
  if (!Array.isArray(body.messages)) fail('invalid_request', 'messages must be a list');
  body.messages.forEach((m, i) => {
    const msg = m as { role?: unknown; content?: unknown };
    if (!msg || typeof msg !== 'object') refuseBlock(`messages[${i}]`, 'not an object');
    for (const k of Object.keys(msg)) {
      if (k === 'role' || k === 'content') continue;
      // A per-message effort setting (mid-conversation system message) carries no content.
      if (k === 'output_config' && msg.role === 'system' && isEffortOnly((msg as { output_config?: unknown }).output_config)) continue;
      refuseBlock(`messages[${i}]`, `field ${k}`);
    }
    if (msg.role === 'system') {
      // Mid-conversation operator text: text only.
      checkTextBlocks(msg.content ?? [], `messages[${i}].content`);
      return;
    }
    if (msg.role !== 'user' && msg.role !== 'assistant') refuseBlock(`messages[${i}]`, `role ${String(msg.role)}`);
    if (typeof msg.content === 'string') return;
    if (!Array.isArray(msg.content)) refuseBlock(`messages[${i}]`, 'content must be a string or blocks');
    msg.content.forEach((b, j) => {
      if (!b || typeof b !== 'object' || Array.isArray(b)) refuseBlock(`messages[${i}].content[${j}]`, 'not a block');
      checkBlock(b as Record<string, unknown>, `messages[${i}].content[${j}]`, String(msg.role));
    });
  });
}

// -----------------------------------------------------------------------------------------------
// Messages mode: an agent host's request arriving through the per-attempt broker socket

export interface MessagesCallPayload {
  /** The request body as the broker socket stored it in the archive. */
  messages_request: ArtifactRef;
}

const MESSAGES_KEYS = ['model', 'max_tokens', 'system', 'messages', 'tools', 'tool_choice', 'thinking', 'output_config', 'stop_sequences', 'metadata', 'context_management'];
/** Proposed ceiling on one Messages request's output tokens (operator choice; the reservation covers it). */
export const PROPOSED_MAX_TOKENS_CAP = 128_000;

/**
 * Beta headers the broker passes to the provider (a proposal, operator choice): request-shaping
 * features only. Any other beta is dropped and listed, so no beta can enable a server-side fetch.
 */
export const PROPOSED_ALLOWED_BETAS = [
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'effort-2025-11-24',
  'prompt-caching-scope-2026-01-05',
  'thinking-token-count-2026-05-13',
  'mid-conversation-system-2026-04-07',
  'per-turn-control-2026-07-01',
];

/** Context management may only clear earlier content (no summarizing service, no external content). */
function checkContextManagement(v: unknown): void {
  const edits = (v as { edits?: unknown })?.edits;
  if (!v || typeof v !== 'object' || Object.keys(v).some((k) => k !== 'edits') || !Array.isArray(edits)) fail('invalid_request', 'context_management must be {edits: [...]}');
  for (const e of edits) {
    const t = String((e as { type?: unknown })?.type ?? '');
    if (!/^clear_(thinking|tool_uses)_\d{8}$/.test(t)) fail('egress_denied', `context_management edit ${t} is not permitted; only clearing edits are`);
  }
}

/**
 * Only snapshot source views, reviewed statements and lesson/library material may be `source`. A
 * manifest carrying anything else — investigations, scenario variants, discrepancies, evidence,
 * properties, findings, packets, decisions, positions — is about possible vulnerabilities and is
 * live-exploitable.
 */
function sourceOnlyRecord(r: { type: string; body: unknown }): boolean {
  if (r.type === 'target_snapshot' || r.type === 'lesson' || r.type === 'library_entry') return true;
  return r.type === 'system_statement' && (r.body as { review_status?: string } | null)?.review_status === 'reviewed';
}

/** The strictest class over the manifest and every source it carries. */
export function manifestDataClass(store: RecordStore, liveClass: string, ref: ArtifactRef, view: ContextManifestView): string {
  if (view.records.some((r) => !sourceOnlyRecord(r))) return liveClass;
  if ((view as { contradictions?: unknown[] }).contradictions?.length) return liveClass;
  const digests = [ref.artifact, ...view.sources.flatMap((s) => [s.original, s.view])];
  const classes = deriveDataClasses(store, liveClass, digests, view, ref.artifact);
  return [...classes.values()].includes(liveClass) ? liveClass : 'source';
}

function messagesCall(ctx: OpContext, p: MessagesCallPayload) {
  for (const k of Object.keys(p)) if (k !== 'messages_request') fail('invalid_request', `unsupported field ${k}`);
  const worker = ctx.principal.channel === 'worker' ? ctx.principal.grant! : null;
  if (!worker) fail('permission_denied', 'Messages-mode calls come from an attempt through its broker socket');
  const cs = ctx.store.heads('control_state')[0];
  if (cs?.body.paused) fail('permission_denied', 'engagement is paused');
  if (!p.messages_request || !isDigest(p.messages_request.artifact)) fail('invalid_request', 'messages_request must be an artifact reference');
  const stored = ctx.archive.getJson<{ format: string; body: MessagesBody }>(p.messages_request.artifact);
  if (stored.format !== 'harness.provider_messages_request/1') fail('invalid_request', 'not a Messages request artifact');
  const body = stored.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('invalid_request', 'request body must be a JSON object');
  for (const k of Object.keys(body)) {
    // Streaming is synthesized by the broker socket, which calls the provider without streaming.
    if (k === 'stream') fail('unsupported', 'streaming is requested from the broker socket, not inside the stored body');
    if (!MESSAGES_KEYS.includes(k)) fail('invalid_request', `unsupported request field ${k}`);
  }
  if (body.context_management !== undefined) checkContextManagement(body.context_management);
  const betas = (stored as { betas?: unknown }).betas;
  if (betas !== undefined && (!Array.isArray(betas) || betas.some((b) => !PROPOSED_ALLOWED_BETAS.includes(String(b))))) fail('egress_denied', 'a beta outside the broker allowlist was requested');
  if (typeof body.model !== 'string' || !body.model) fail('invalid_request', 'model is required');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0 || body.max_tokens > PROPOSED_MAX_TOKENS_CAP) {
    fail('invalid_request', `max_tokens must be a positive integer up to ${PROPOSED_MAX_TOKENS_CAP}`);
  }
  if (!Array.isArray(body.messages) || !body.messages.length) fail('invalid_request', 'messages are required');
  // Server-side tools (web search/fetch, code execution, MCP) would act outside the sandbox.
  for (const t of body.tools ?? []) {
    const type = (t as { type?: unknown })?.type;
    if (type !== undefined && type !== 'custom') fail('egress_denied', `server-side tool ${String(type)} is not permitted; only client tools run, inside the sandbox`);
  }
  validateMessagesContent(body);

  const auth = currentAuthorization(ctx, worker.authorization.record_id);
  const eng = ctx.store.heads('engagement')[0];
  const policy = eng?.body.policy;
  if (!policy) fail('permission_denied', 'no accepted data policy: provider calls are refused');
  const dp = policy.data_policy;
  const broker = ProviderBroker.active();
  if (!broker) fail('unsupported', 'no provider broker is running');
  // Map the requested model onto a provider this authorization and the engagement approve.
  const candidates = auth.body.capabilities.providers.filter((n) => dp.approved_providers.includes(n));
  const providerName = candidates.find((n) => {
    const pr = broker.provider(n);
    return !!pr && !!pr.messages && pr.models.includes(body.model);
  });
  if (!providerName) fail('egress_denied', `model ${body.model} is not offered by any provider approved for this authorization`);
  const why = broker.unavailable(providerName);
  if (why) fail('unsupported', why);
  const provider = broker.provider(providerName)!;

  // Everything the attempt sends derives from its context: classify at the manifest's class.
  const job = ctx.store.get(worker.job, 'job');
  if (!job.body.context_manifest) fail('egress_denied', 'provider calls need the job to carry a context manifest');
  const view = loadContextManifest(ctx.store, job.body.context_manifest);
  const dataClass = manifestDataClass(ctx.store, dp.live_exploitable_class, job.body.context_manifest, view);
  if (dataClass === dp.live_exploitable_class) {
    if (!broker.liveExploitableProviders.has(providerName)) fail('egress_denied', `${providerName} is not approved for the live-exploitable class (${dataClass})`);
  } else if (!dp.data_classes.includes(dataClass)) fail('egress_denied', `data class ${dataClass} is not approved for egress`);

  ctx.tx.blob(p.messages_request);
  const prior = ledgerEntries(ctx.store, auth.ref.record_id).filter((e) => e.kind === 'reservation' && parseProviderNote(e.note)?.request === p.messages_request.artifact);
  if (prior.length >= 1 + auth.body.limits.retries) {
    fail('budget_exhausted', `retry cap reached for this provider request (${prior.length} reservation(s)); reconcile the earlier calls`);
  }
  const maxCost = provider.maxMessagesCost ? provider.maxMessagesCost(body) : 0;
  const call_id = `call-${randomToken(8)}`;
  const note: ProviderNote = {
    provider_call: { id: call_id, provider: providerName, model_requested: body.model, request: p.messages_request.artifact, data_class: dataClass, mode: 'messages' },
  };
  const reservation = reserve(ctx, auth, worker.attempt, { spend: maxCost, runtime_seconds: 0 }, JSON.stringify(note));
  ctx.tx.event('provider_call_reserved', { call_id, mode: 'messages', provider: providerName, data_class: dataClass, reservation });
  return { call_id, reservation, max_cost: maxCost, request: p.messages_request, data_class: dataClass, provider: providerName };
}

interface RecordOutcomePayload {
  call_id: string;
  outcome: 'completed' | 'outcome_unknown' | 'failed_before_send';
  response?: ArtifactRef;
  model_returned?: string;
  cost?: number | null;
  reason?: string;
}

defineOperation<RecordOutcomePayload>({
  name: 'record_provider_outcome',
  channels: ['runner'],
  mutating: true,
  handler(ctx, p): ProviderCallResult {
    const call = findCall(ctx.store, p.call_id);
    if (!call) fail('not_found', `provider call ${p.call_id} not found`);
    if (call.outcome) fail('idempotency_conflict', `provider call ${p.call_id} already recorded as ${call.outcome}`);
    const base = { ...call.note, outcome: p.outcome };
    const entry = (kind: 'actual' | 'uncertain' | 'release', spend: number, extra: Partial<ProviderNote['provider_call']> = {}) =>
      ctx.tx.create('ledger_entry', {
        authorization: call.authorization,
        attempt: call.attempt,
        kind,
        spend,
        runtime_seconds: 0,
        note: JSON.stringify({ provider_call: { ...base, ...extra } } satisfies ProviderNote),
      });
    let spend_status: ProviderCallResult['spend_status'];
    if (p.outcome === 'completed') {
      if (!p.response) throw new HarnessError('invalid_request', 'a completed call records its response');
      ctx.archive.get(p.response.artifact);
      ctx.tx.blob(p.response);
      const confirmed = typeof p.cost === 'number';
      const actual = confirmed ? p.cost! : call.reserved;
      entry('actual', actual, { response: p.response.artifact, model_returned: p.model_returned ?? null, confirmed });
      entry('release', call.reserved);
      spend_status = confirmed ? 'confirmed' : 'estimated';
      if (actual > call.reserved + 1e-12) {
        // The reservation was meant as a ceiling. Record the overrun and stop further spending.
        const auth = ctx.store.mustHead(call.authorization.record_id, 'work_authorization');
        if (auth.body.status === 'active') ctx.tx.revise(auth.record_id, 'work_authorization', (b) => ({ ...b, status: 'exhausted' }));
        ctx.tx.event('budget_overrun', { call_id: p.call_id, reserved: call.reserved, actual, authorization: call.authorization.record_id });
      }
    } else if (p.outcome === 'outcome_unknown') {
      // The reservation stays held; reconcile before any replacement.
      entry('uncertain', call.reserved);
      spend_status = 'uncertain';
    } else {
      entry('release', call.reserved);
      spend_status = 'released';
    }
    ctx.tx.event('provider_call_outcome', { call_id: p.call_id, outcome: p.outcome, reason: p.reason ?? null });
    return {
      call_id: p.call_id,
      outcome: p.outcome,
      response: p.response ?? null,
      model_returned: p.model_returned ?? null,
      spend_status,
    };
  },
});
