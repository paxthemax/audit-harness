import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import type { OpContext } from '../controller/controller.ts';
import type { RecordStore } from '../store/recordStore.ts';
import type { LedgerEntryBody, WorkAuthorizationBody } from '../schema/records.ts';

// Resource ledger (design/harness-state-and-execution.md, "Durable jobs and resource limits"). The
// controller reserves the maximum permitted allocation before dispatch; completion records the actual
// use and releases the reservation once; an external request with an unknown outcome keeps its
// reservation and adds an `uncertain` entry. A local ledger cannot guarantee exactly-once provider
// billing, so spending is reported as estimated, confirmed and uncertain separately.
//
// Entry semantics (amounts are non-negative):
//   reservation  held allocation             release  ends a reservation (once per attempt/call)
//   actual       recorded use                uncertain  part of a held reservation whose outcome is unknown
// Provider-call entries carry a JSON note `{"provider_call": {...}}` with the call identity.

export interface Amount {
  spend: number;
  runtime_seconds: number;
}

export interface LedgerTotals {
  reserved: Amount;
  released: Amount;
  actual: Amount;
  uncertain: Amount;
  /** Outstanding reservations plus actual use: what counts against the limits. */
  committed: Amount;
}

function zero(): Amount {
  return { spend: 0, runtime_seconds: 0 };
}

function add(a: Amount, b: { spend: number; runtime_seconds: number }): void {
  a.spend += b.spend;
  a.runtime_seconds += b.runtime_seconds;
}

/** Committed entries for an authorization plus entries staged in the current transaction. */
export function ledgerEntries(store: RecordStore, authorizationId: string, ctx?: OpContext): LedgerEntryBody[] {
  const out = store
    .heads('ledger_entry')
    .filter((e) => e.body.authorization.record_id === authorizationId)
    .map((e) => e.body);
  if (ctx) {
    for (const r of ctx.tx.records) {
      if (r.type === 'ledger_entry' && (r.body as LedgerEntryBody).authorization.record_id === authorizationId) {
        out.push(r.body as LedgerEntryBody);
      }
    }
  }
  return out;
}

export function ledgerTotals(entries: LedgerEntryBody[]): LedgerTotals {
  const t: LedgerTotals = { reserved: zero(), released: zero(), actual: zero(), uncertain: zero(), committed: zero() };
  for (const e of entries) {
    const bucket = e.kind === 'reservation' ? t.reserved : e.kind === 'release' ? t.released : e.kind === 'actual' ? t.actual : t.uncertain;
    add(bucket, e);
  }
  t.committed = {
    spend: t.reserved.spend - t.released.spend + t.actual.spend,
    runtime_seconds: t.reserved.runtime_seconds - t.released.runtime_seconds + t.actual.runtime_seconds,
  };
  return t;
}

/** Reserve before dispatch, refusing with `budget_exhausted` when the limits would be exceeded. */
export function reserve(
  ctx: OpContext,
  auth: { ref: Ref; body: WorkAuthorizationBody },
  attempt: Ref | null,
  amount: Amount,
  note: string,
): Ref {
  const t = ledgerTotals(ledgerEntries(ctx.store, auth.ref.record_id, ctx));
  const limits = auth.body.limits;
  if (t.committed.spend + amount.spend > limits.spend + 1e-9 || t.committed.runtime_seconds + amount.runtime_seconds > limits.runtime_seconds + 1e-9) {
    fail('budget_exhausted', `authorization ${auth.ref.record_id} cannot reserve ${JSON.stringify(amount)}`, {
      details: { committed: t.committed, limits: { spend: limits.spend, runtime_seconds: limits.runtime_seconds }, requested: amount },
    });
  }
  return ctx.tx.create('ledger_entry', { authorization: auth.ref, attempt, kind: 'reservation', ...amount, note });
}

/**
 * Record an attempt's actual use and release its reservations, once. Returns false when the attempt
 * was already settled (duplicate completions do not create new charges).
 */
export function settleAttempt(ctx: OpContext, authorization: Ref, attempt: Ref, actual: Amount, note: string): boolean {
  const entries = ledgerEntries(ctx.store, authorization.record_id, ctx).filter((e) => e.attempt?.record_id === attempt.record_id && !isProviderNote(e.note));
  if (entries.some((e) => e.kind === 'release' || e.kind === 'actual')) return false;
  const held = ledgerTotals(entries).reserved;
  ctx.tx.create('ledger_entry', { authorization, attempt, kind: 'actual', ...actual, note });
  if (held.spend || held.runtime_seconds) {
    ctx.tx.create('ledger_entry', { authorization, attempt, kind: 'release', ...held, note: `release: ${note}` });
  }
  return true;
}

export interface ProviderNote {
  provider_call: {
    id: string;
    provider: string;
    model_requested: string;
    request: string;
    data_class: string;
    response?: string | null;
    model_returned?: string | null;
    /** On an `actual` entry: whether the provider confirmed the cost (false = the reservation was charged as an estimate). */
    confirmed?: boolean;
    outcome?: 'completed' | 'outcome_unknown' | 'failed_before_send' | 'not_executed';
    /** `messages`: an agent host's Messages API call through the broker socket. */
    mode?: 'messages';
  };
}

export function isProviderNote(note: string): boolean {
  return note.startsWith('{"provider_call"');
}

export function parseProviderNote(note: string): ProviderNote['provider_call'] | null {
  if (!isProviderNote(note)) return null;
  try {
    return (JSON.parse(note) as ProviderNote).provider_call;
  } catch {
    return null;
  }
}

export interface SpendSummary {
  authorization: string;
  limit: number;
  /** Outstanding reservations whose outcome is not uncertain, plus actual spend charged at the estimate. */
  estimated: number;
  /** Actual spend the provider (or a local tool) confirmed. */
  confirmed: number;
  /** Held reservations for requests whose outcome is unknown. */
  uncertain: number;
  /** Never negative; spending beyond the limit is reported in `overrun`. */
  remaining: number;
  /** Committed spend beyond the authorization's limit (a provider billed more than reserved). */
  overrun: number;
  runtime_seconds: { limit: number; committed: number; actual: number; reserved_outstanding: number };
}

export function spendSummary(store: RecordStore, authorization: Ref | string): SpendSummary {
  const id = typeof authorization === 'string' ? authorization : authorization.record_id;
  const auth = store.mustHead(id, 'work_authorization');
  const entries = ledgerEntries(store, id);
  const t = ledgerTotals(entries);
  let confirmed = 0;
  let estimatedActual = 0;
  for (const e of entries) {
    if (e.kind !== 'actual') continue;
    const call = parseProviderNote(e.note);
    if (call && call.confirmed === false) estimatedActual += e.spend;
    else confirmed += e.spend;
  }
  const outstanding = t.reserved.spend - t.released.spend;
  return {
    authorization: id,
    limit: auth.body.limits.spend,
    estimated: round(outstanding - t.uncertain.spend + estimatedActual),
    confirmed: round(confirmed),
    uncertain: round(t.uncertain.spend),
    remaining: round(Math.max(0, auth.body.limits.spend - t.committed.spend)),
    overrun: round(Math.max(0, t.committed.spend - auth.body.limits.spend)),
    runtime_seconds: {
      limit: auth.body.limits.runtime_seconds,
      committed: round(t.committed.runtime_seconds),
      actual: round(t.actual.runtime_seconds),
      reserved_outstanding: round(t.reserved.runtime_seconds - t.released.runtime_seconds),
    },
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Provider reservations an attempt made but never executed (no outcome recorded) are released when
 * the attempt completes, so estimated spend covers only what may actually have been billed.
 */
export function releaseUnexecutedCalls(ctx: OpContext, attempt: Ref): string[] {
  const entries = ctx.store.heads('ledger_entry').filter((e) => parseProviderNote(e.body.note) && e.body.attempt?.record_id === attempt.record_id);
  const byCall = new Map<string, { reservation: LedgerEntryBody | null; settled: boolean }>();
  for (const e of entries) {
    const id = parseProviderNote(e.body.note)!.id;
    const cur = byCall.get(id) ?? { reservation: null, settled: false };
    if (e.body.kind === 'reservation') cur.reservation = e.body;
    else cur.settled = true;
    byCall.set(id, cur);
  }
  const released: string[] = [];
  for (const [id, c] of byCall) {
    if (!c.reservation || c.settled) continue;
    const note = parseProviderNote(c.reservation.note)!;
    ctx.tx.create('ledger_entry', {
      authorization: c.reservation.authorization,
      attempt,
      kind: 'release',
      spend: c.reservation.spend,
      runtime_seconds: c.reservation.runtime_seconds,
      note: JSON.stringify({ provider_call: { ...note, outcome: 'not_executed' } } satisfies ProviderNote),
    });
    released.push(id);
  }
  return released;
}
