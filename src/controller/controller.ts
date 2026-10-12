import { fail, HarnessError } from '../core/errors.ts';
import { digest, digestJson, randomToken } from '../core/hash.ts';
import type { AnyRef, Ref } from '../core/refs.ts';
import type { Archive } from '../store/archive.ts';
import { withLock } from '../store/lock.ts';
import type { PendingEvent, PendingRecord, RecordStore } from '../store/recordStore.ts';
import {
  CONTRACT_VERSION,
  type BodyByType,
  type Channel,
  type RecordEnvelope,
  type RecordType,
} from '../schema/records.ts';
import type { Workspace } from './workspace.ts';

// The controller is ordinary program logic, the sole authority for metadata writes, grants and state
// transitions (design/audit-harness.md, "Architecture"). Every request passes the same checks here:
// contract version, channel authority, grant, idempotency, expected revisions; then the operation's
// handler stages records and the controller commits them with one event atomically.
//
// Callers reach the controller only through a Session bound to an authenticated channel. An `actor`
// field inside a payload never confers authority (design/harness-interface-contracts.md).

export interface Request<P = unknown> {
  contract_version: number;
  request_id: string;
  idempotency_key: string | null;
  engagement_id: string;
  operation: string;
  expected_revisions: Ref[];
  payload: P;
}

export interface WorkerGrant {
  attempt: Ref;
  job: Ref;
  authorization: Ref;
  investigation: Ref | null;
  operations: string[];
  role: string;
}

export interface Principal {
  channel: Channel;
  principal: string;
  /** Present on the worker channel. */
  grant?: WorkerGrant;
  /** Present on the trusted-screen channel. */
  screen?: { identity: string; session: string };
  /** Present on the capture channel. */
  capture?: { name: string; program_digest: string; session: string };
}

export interface CallResult<R = unknown> {
  result: R;
  records: Ref[];
  commit: string | null;
  event_seq: number | null;
  /** Set when an idempotent repeat returned the historical commit. */
  replayed?: { event_id: string; state_changed_since: boolean };
}

export interface OperationDef<P = any> {
  name: string;
  channels: Channel[];
  mutating: boolean;
  /** 'engagement' (default), 'library', or 'either' (decided by request.engagement_id). */
  scope?: 'engagement' | 'library' | 'either';
  /** Operation creates the engagement store (create_engagement). */
  createsStore?: boolean;
  /** On an expected-revision mismatch, retain the proposal as a `proposal_conflict` record. */
  retainConflicts?: boolean;
  handler: (ctx: OpContext, payload: P) => unknown;
}

const registry = new Map<string, OperationDef>();

export function defineOperation<P>(def: OperationDef<P>): OperationDef<P> {
  if (registry.has(def.name)) throw new Error(`operation ${def.name} defined twice`);
  registry.set(def.name, def as OperationDef);
  return def;
}

export function operationNames(): string[] {
  return [...registry.keys()].sort();
}

export function getOperation(name: string): OperationDef | undefined {
  return registry.get(name);
}

// -----------------------------------------------------------------------------------------------
// Transactions

export class Tx {
  readonly records: PendingRecord[] = [];
  readonly events: PendingEvent[] = [];
  readonly blobs = new Set<string>();
  private created = new Map<string, number>(); // prefix -> count staged
  private staged = new Map<string, { type: RecordType; revision: number; body: unknown; depends_on: AnyRef[] }>();
  private readonly store: RecordStore;

  constructor(store: RecordStore) {
    this.store = store;
  }

  create<T extends RecordType>(type: T, body: BodyByType[T], depends_on: AnyRef[] = []): Ref {
    const n = this.created.get(type) ?? 0;
    const id = this.store.peekNextId(type, n);
    this.created.set(type, n + 1);
    this.records.push({ type, record_id: undefined, base_revision: 0, body, depends_on } as PendingRecord);
    this.staged.set(id, { type, revision: 1, body, depends_on });
    return { record_id: id, revision: 1 };
  }

  /**
   * Stage a new revision. `update` receives the current (staged or committed) body. When
   * `expectedRevision` is given and differs from the current head, the commit fails with
   * `revision_conflict`.
   */
  revise<T extends RecordType>(
    id: string,
    type: T,
    update: (prev: BodyByType[T]) => BodyByType[T],
    opts: { expectedRevision?: number; depends_on?: AnyRef[] } = {},
  ): Ref {
    const cur = this.current(id, type);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== cur.revision) {
      fail('revision_conflict', `record ${id} is at revision ${cur.revision}, expected ${opts.expectedRevision}`, {
        ref: id,
        details: { expected: opts.expectedRevision, actual: cur.revision },
      });
    }
    const body = update(structuredClone(cur.body));
    const depends_on = opts.depends_on ?? cur.depends_on;
    this.records.push({ type, record_id: id, base_revision: cur.revision, body, depends_on } as PendingRecord);
    this.staged.set(id, { type, revision: cur.revision + 1, body, depends_on });
    return { record_id: id, revision: cur.revision + 1 };
  }

  /** Current body: staged in this transaction, otherwise the committed head. */
  current<T extends RecordType>(id: string, type?: T): { revision: number; body: BodyByType[T]; depends_on: AnyRef[] } {
    const s = this.staged.get(id);
    if (s) {
      if (type && s.type !== type) fail('invalid_request', `record ${id} is a ${s.type}, not a ${type}`);
      return { revision: s.revision, body: s.body as BodyByType[T], depends_on: s.depends_on };
    }
    const h = this.store.mustHead(id, type);
    return { revision: h.revision, body: h.body as BodyByType[T], depends_on: h.depends_on };
  }

  currentRef(id: string): Ref {
    const s = this.staged.get(id);
    if (s) return { record_id: id, revision: s.revision };
    return this.store.headRef(id);
  }

  event(kind: string, result: Record<string, unknown> = {}): void {
    this.events.push({ kind, operation: '', request_id: '', idempotency_key: null, request_digest: null, result });
  }

  blob(ref: { artifact: string } | string): void {
    this.blobs.add(typeof ref === 'string' ? ref : ref.artifact);
  }

  get empty(): boolean {
    return this.records.length === 0 && this.events.length === 0;
  }
}

export interface OpContext {
  ws: Workspace;
  store: RecordStore;
  archive: Archive;
  principal: Principal;
  request: Request;
  now: string;
  tx: Tx;
  controller: Controller;
  /** Commit what is staged, then raise this error (e.g. retained conflicts, recorded refusals). */
  failAfterCommit(err: HarnessError): void;
}

// -----------------------------------------------------------------------------------------------
// Controller

export interface ControllerOptions {
  clock?: () => Date;
}

export class Controller {
  readonly ws: Workspace;
  private readonly clock: () => Date;

  constructor(ws: Workspace, opts: ControllerOptions = {}) {
    this.ws = ws;
    this.clock = opts.clock ?? (() => new Date());
  }

  now(): string {
    return this.clock().toISOString();
  }

  // --- channel constructors -------------------------------------------------------------------

  /** The auditor's own CLI channel (non-decision operations). */
  auditor(key: string): Session {
    if (!this.ws.checkSecret('auditor.key', key)) fail('permission_denied', 'auditor authentication failed');
    return new Session(this, { channel: 'auditor', principal: 'auditor' });
  }

  /** The trusted decision screen channel. Construct only from the screen module. */
  screen(key: string, identity: string, session: string): Session {
    if (!this.ws.checkSecret('auditor.key', key)) fail('permission_denied', 'trusted screen authentication failed');
    return new Session(this, { channel: 'screen', principal: 'auditor', screen: { identity, session } });
  }

  /** Capture channel: a hook or wrapper outside the model's control. */
  capture(key: string, name: string, program_digest: string, session: string): Session {
    if (!this.ws.checkSecret('capture.key', key)) fail('permission_denied', 'capture channel authentication failed');
    return new Session(this, { channel: 'capture', principal: `capture:${name}`, capture: { name, program_digest, session } });
  }

  /** Worker channel: authenticated by the per-attempt grant token. */
  worker(engagementId: string, token: string): Session {
    const store = this.ws.store(engagementId, true);
    const d = digest(token);
    const att = store
      .heads('attempt')
      .find((a) => a.body.grant && a.body.grant.digest === d);
    if (!att || !att.body.grant) fail('permission_denied', 'unknown worker grant');
    const g = att.body.grant;
    if (g.revoked || att.body.status !== 'running') fail('grant_expired', 'worker grant is revoked or its attempt is not running');
    if (Date.parse(g.expires_at) < this.clock().getTime()) fail('grant_expired', 'worker grant expired');
    const job = store.get(att.body.job, 'job');
    return new Session(this, {
      channel: 'worker',
      principal: `worker:${job.body.role}:${att.record_id}`,
      grant: {
        attempt: { record_id: att.record_id, revision: att.revision },
        job: att.body.job,
        authorization: job.body.authorization,
        investigation: job.body.investigation,
        operations: g.operations,
        role: job.body.role,
      },
    });
  }

  /** Trusted runner channel (in-process only; never exposed to sandboxes). */
  runner(): Session {
    return new Session(this, { channel: 'runner', principal: 'trusted-runner' });
  }

  /** The controller acting on its own authority (scheduler, policy stops, exports it authorized). */
  system(): Session {
    return new Session(this, { channel: 'controller', principal: 'controller' });
  }

  static newWorkerToken(): { token: string; digest: string } {
    const token = randomToken();
    return { token, digest: digest(token) };
  }

  // --- dispatch ---------------------------------------------------------------------------------

  call<R = unknown>(principal: Principal, req: Request): CallResult<R> {
    if (req.contract_version !== CONTRACT_VERSION) {
      fail('unsupported_contract', `contract version ${req.contract_version} is not supported`, { operation: req.operation });
    }
    const def = registry.get(req.operation);
    if (!def) fail('invalid_request', `unknown operation ${req.operation}`, { operation: req.operation });
    if (!def.channels.includes(principal.channel)) {
      fail('permission_denied', `operation ${req.operation} is not available on the ${principal.channel} channel`, {
        operation: req.operation,
      });
    }
    if (principal.channel === 'worker') {
      const g = principal.grant!;
      if (!g.operations.includes(req.operation)) {
        fail('permission_denied', `worker grant does not cover ${req.operation}`, { operation: req.operation });
      }
    }
    const scope = def.scope === 'library' ? 'library' : req.engagement_id;
    if (def.scope === 'engagement' && scope === 'library') fail('invalid_request', 'operation needs an engagement scope');
    if (!def.mutating) {
      const store = this.ws.store(scope, true);
      const ctx = this.makeContext(principal, req, store);
      return { result: def.handler(ctx, req.payload) as R, records: [], commit: null, event_seq: null };
    }
    return withLock(this.ws.lockPath, () => this.mutate<R>(def, principal, req, scope));
  }

  private makeContext(principal: Principal, req: Request, store: RecordStore): OpContext & { _deferred: HarnessError | null } {
    const ctx = {
      ws: this.ws,
      store,
      archive: store.archive,
      principal,
      request: req,
      now: this.now(),
      tx: new Tx(store),
      controller: this,
      _deferred: null as HarnessError | null,
      failAfterCommit(err: HarnessError) {
        ctx._deferred = err;
      },
    };
    return ctx;
  }

  private mutate<R>(def: OperationDef, principal: Principal, req: Request, scope: string): CallResult<R> {
    let store: RecordStore;
    if (def.createsStore) {
      if (this.ws.hasEngagement(scope)) fail('invalid_request', `engagement ${scope} already exists`);
      store = this.ws.createEngagementStore(scope);
    } else {
      if (scope !== 'library' && !this.ws.hasEngagement(scope)) fail('not_found', `engagement ${scope} not found`);
      store = this.ws.store(scope, true);
    }
    if (store.corruption) fail('store_corrupt', `store ${scope} is corrupt; writes refused`, { details: store.corruption });
    if (principal.channel === 'worker' && scope !== req.engagement_id) fail('permission_denied', 'worker cannot leave its engagement');

    const requestDigest = digestJson({ operation: req.operation, engagement: req.engagement_id, payload: req.payload, expected: req.expected_revisions });
    if (req.idempotency_key) {
      const prior = store.findEventByKey(req.idempotency_key, principal.principal, req.operation);
      if (prior) {
        if (prior.request_digest !== requestDigest) {
          fail('idempotency_conflict', `idempotency key ${req.idempotency_key} was used for different contents`, {
            operation: req.operation,
          });
        }
        return {
          result: prior.result as R,
          records: prior.records,
          commit: null,
          event_seq: prior.seq,
          replayed: { event_id: prior.event_id, state_changed_since: store.lastSeq() !== prior.seq },
        };
      }
    }

    const ctx = this.makeContext(principal, req, store);

    // Generic expected-revision check: a stale base never silently wins (no last-write-wins).
    for (const exp of req.expected_revisions) {
      const head = store.head(exp.record_id);
      const actual = head?.revision ?? 0;
      if (actual !== exp.revision) {
        const err = new HarnessError('revision_conflict', `record ${exp.record_id} is at revision ${actual}, expected ${exp.revision}`, {
          operation: req.operation,
          ref: exp,
          details: { expected: exp.revision, actual },
        });
        if (def.retainConflicts) {
          ctx.tx.create('proposal_conflict', {
            operation: req.operation,
            target: exp.record_id,
            expected_revision: exp.revision,
            actual_revision: actual,
            proposal: { payload: req.payload as Record<string, unknown>, principal: principal.principal, request_id: req.request_id },
            status: 'open',
          });
          ctx.tx.event('proposal_conflict_retained', { target: exp.record_id });
          this.commitTx(ctx, def, req, principal, requestDigest, { conflict: true });
          throw new HarnessError('revision_conflict', err.message.slice('revision_conflict: '.length), {
            operation: req.operation,
            ref: exp,
            committed: true,
            details: { expected: exp.revision, actual, retained_as: store.peekNextId('proposal_conflict', -1) },
          });
        }
        throw err;
      }
    }

    const result = def.handler(ctx, req.payload);
    const committed = this.commitTx(ctx, def, req, principal, requestDigest, (result ?? {}) as Record<string, unknown>);
    if (ctx._deferred) {
      const d = ctx._deferred;
      throw new HarnessError(d.code, d.message.slice(d.code.length + 2), {
        operation: req.operation,
        ref: d.ref,
        committed: committed.commit !== null,
        details: d.details,
      });
    }
    return { result: result as R, records: committed.records, commit: committed.commit, event_seq: committed.event_seq };
  }

  private commitTx(
    ctx: OpContext,
    def: OperationDef,
    req: Request,
    principal: Principal,
    requestDigest: string,
    result: Record<string, unknown>,
  ): { records: Ref[]; commit: string | null; event_seq: number | null } {
    const events: PendingEvent[] = [
      {
        kind: def.name,
        operation: def.name,
        request_id: req.request_id,
        idempotency_key: req.idempotency_key,
        request_digest: requestDigest,
        result: jsonSafe(result),
      },
      ...ctx.tx.events.map((e) => ({ ...e, operation: def.name, request_id: req.request_id })),
    ];
    const res = ctx.store.commit({
      records: ctx.tx.records,
      events,
      principal: { channel: principal.channel, principal: principal.principal },
      origin: {
        operation: def.name,
        request_id: req.request_id,
        job: principal.grant?.job ?? null,
        attempt: principal.grant?.attempt ?? null,
        decision: null,
      },
      now: ctx.now,
      message: `${def.name} ${req.request_id}`,
      blobs: [...ctx.tx.blobs],
    });
    this.ws.noteCommitted(ctx.store.scope);
    return { records: res.refs, commit: res.commit, event_seq: res.events[0]?.seq ?? null };
  }
}

function jsonSafe(v: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v ?? {}));
}

// -----------------------------------------------------------------------------------------------
// Sessions

export interface CallOptions {
  idempotency_key?: string;
  expected_revisions?: Ref[];
  request_id?: string;
}

let requestCounter = 0;

export class Session {
  readonly controller: Controller;
  readonly principal: Principal;

  constructor(controller: Controller, principal: Principal) {
    this.controller = controller;
    this.principal = principal;
  }

  call<R = any>(engagement: string, operation: string, payload: unknown = {}, opts: CallOptions = {}): CallResult<R> {
    const req: Request = {
      contract_version: CONTRACT_VERSION,
      request_id: opts.request_id ?? `req-${process.pid}-${Date.now()}-${++requestCounter}`,
      idempotency_key: opts.idempotency_key ?? null,
      engagement_id: engagement,
      operation,
      expected_revisions: opts.expected_revisions ?? [],
      payload,
    };
    return this.controller.call<R>(this.principal, req);
  }

  /** Convenience: call and return only the result. */
  do<R = any>(engagement: string, operation: string, payload: unknown = {}, opts: CallOptions = {}): R {
    return this.call<R>(engagement, operation, payload, opts).result;
  }
}

export type { RecordEnvelope };
