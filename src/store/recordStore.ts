import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail, HarnessError } from '../core/errors.ts';
import { randomToken } from '../core/hash.ts';
import type { AnyRef, Ref } from '../core/refs.ts';
import { validate } from '../schema/jsonschema.ts';
import {
  envelopeSchema,
  eventSchema,
  ID_PREFIX,
  RECORD_SCHEMAS,
  SCHEMA_VERSION,
  type BodyByType,
  type Channel,
  type EventEnvelope,
  type RecordEnvelope,
  type RecordType,
} from '../schema/records.ts';
import { Archive } from './archive.ts';
import { git, gitInit } from './git.ts';

// Append-only, Git-backed record store for one scope (an engagement or the mechanism library).
//
// Layout:  records/<record_id>/<revision>.json   one immutable file per revision
//          events/<seq>.json                     one event per committed operation (monotonic)
//          archive/sha256/..                     content-addressed evidence blobs
//
// A commit writes the new revision files and the event, then makes one Git commit: that commit is
// the atomic record/event transaction (NFR-02). Files written but not committed (a crash between
// write and commit) were never acknowledged; on open they are moved to quarantine/ and reported.
// Corrupt committed records fail closed: the store refuses writes (NFR-05).

export interface PendingRecord<T extends RecordType = RecordType> {
  type: T;
  /** Omit for a new record; the store assigns `<prefix>-<seq>`. */
  record_id?: string;
  /** Expected current head revision: 0 for a new record. */
  base_revision: number;
  body: BodyByType[T];
  depends_on?: AnyRef[];
  visibility?: 'engagement' | 'library';
}

export interface PendingEvent {
  kind: string;
  operation: string;
  request_id: string;
  idempotency_key: string | null;
  request_digest: string | null;
  result: Record<string, unknown>;
}

export interface CommitInput {
  records: PendingRecord[];
  events: PendingEvent[];
  principal: { channel: Channel; principal: string };
  origin: { operation: string; request_id: string; job: Ref | null; attempt: Ref | null; decision: Ref | null };
  now: string;
  message: string;
  /** Archive blobs referenced by these records (git-tracked in the same commit). */
  blobs?: string[];
}

export interface CommitResult {
  refs: Ref[];
  events: EventEnvelope[];
  commit: string;
}

export interface OpenReport {
  quarantined: string[];
  orphaned_blobs: number;
}

export class RecordStore {
  readonly dir: string;
  readonly scope: string;
  readonly archive: Archive;
  private revisions = new Map<string, RecordEnvelope[]>();
  private eventList: EventEnvelope[] = [];
  private seqByPrefix = new Map<string, number>();
  private corrupt: string | null = null;
  openReport: OpenReport = { quarantined: [], orphaned_blobs: 0 };
  /** Git HEAD this in-memory view reflects (used to detect commits by another process). */
  lastCommitSeen = '';

  private constructor(dir: string, scope: string) {
    this.dir = dir;
    this.scope = scope;
    this.archive = new Archive(join(dir, 'archive'));
  }

  static exists(dir: string): boolean {
    return existsSync(join(dir, '.git')) && existsSync(join(dir, 'store.json'));
  }

  static init(dir: string, scope: string): RecordStore {
    if (RecordStore.exists(dir)) fail('invalid_request', `store already exists at ${dir}`);
    mkdirSync(join(dir, 'records'), { recursive: true });
    mkdirSync(join(dir, 'events'), { recursive: true });
    gitInit(dir);
    writeFileSync(join(dir, '.git', 'info', 'exclude'), 'quarantine/\narchive/tmp/\n.lock\n');
    writeFileSync(
      join(dir, 'store.json'),
      JSON.stringify({ format: 'harness.store/1', scope, schema_version: SCHEMA_VERSION, store_id: randomToken(8) }, null, 2) + '\n',
    );
    git(dir, ['add', 'store.json']);
    git(dir, ['commit', '-q', '-m', `init store ${scope}`]);
    return RecordStore.open(dir, scope);
  }

  static open(dir: string, scope: string): RecordStore {
    if (!RecordStore.exists(dir)) fail('not_found', `no store at ${dir}`);
    const meta = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'));
    if (meta.scope !== scope) fail('store_corrupt', `store at ${dir} belongs to another scope`);
    const s = new RecordStore(dir, scope);
    s.recoverUncommitted();
    s.load();
    return s;
  }

  // ------------------------------------------------------------------------------------------
  // Recovery and loading

  /**
   * Quarantine uncommitted record/event files left by a crashed commit (caller holds the controller
   * lock). Returns true when anything was moved, so the caller reloads its view.
   */
  recoverIfDirty(): boolean {
    this.removeStaleGitLocks();
    const status = git(this.dir, ['status', '--porcelain=v1', '-uall', '--', 'records', 'events', 'store.json']);
    if (!status.trim()) return false;
    this.recoverUncommitted();
    return true;
  }

  /**
   * Git lock files can only be stale here: every Git operation on a store runs under the controller
   * lock, which the caller holds. A leftover lock from a crashed process would otherwise block every
   * write, including recording a pause.
   */
  private removeStaleGitLocks(): void {
    for (const rel of ['index.lock', 'HEAD.lock', 'refs/heads/main.lock', 'packed-refs.lock']) {
      rmSync(join(this.dir, '.git', rel), { force: true });
    }
  }

  private recoverUncommitted(): void {
    this.removeStaleGitLocks();
    // Unstage first: a crash between `git add` and `git commit` leaves files in the index, and
    // restoring from the index would resurrect them. Only HEAD is acknowledged.
    git(this.dir, ['reset', '-q']);
    const status = git(this.dir, ['status', '--porcelain=v1', '-uall', '--', 'records', 'events', 'store.json']);
    const paths = status
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3));
    if (paths.length) {
      const qdir = join(this.dir, 'quarantine', new Date().toISOString().replace(/[:.]/g, '-'));
      for (const p of paths) {
        const src = join(this.dir, p);
        if (!existsSync(src)) continue;
        const dst = join(qdir, p);
        mkdirSync(dirname(dst), { recursive: true });
        renameSync(src, dst);
      }
      // Restore anything a crash may have modified in place (records are append-only, so this only
      // undoes damage, never acknowledged history).
      git(this.dir, ['checkout', 'HEAD', '--', '.']);
      this.openReport.quarantined = [...this.openReport.quarantined, ...paths];
    }
    const archiveStatus = git(this.dir, ['status', '--porcelain=v1', '-uall', '--', 'archive/sha256']);
    this.openReport.orphaned_blobs = archiveStatus.split('\n').filter((l) => l.startsWith('??')).length;
  }

  private load(): void {
    const recDir = join(this.dir, 'records');
    for (const id of readdirSync(recDir).sort()) {
      const revs: RecordEnvelope[] = [];
      const files = readdirSync(join(recDir, id))
        .filter((f) => f.endsWith('.json'))
        .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
      for (const f of files) {
        const rel = `records/${id}/${f}`;
        let env: RecordEnvelope;
        try {
          env = JSON.parse(readFileSync(join(recDir, id, f), 'utf8'));
        } catch {
          this.corrupt = `unparseable ${rel}`;
          continue;
        }
        const issues = this.issuesFor(env);
        if (issues.length || env.record_id !== id || `${env.revision}.json` !== f || env.scope !== this.scope) {
          this.corrupt = `invalid ${rel}: ${issues.map((i) => `${i.path} ${i.message}`).join('; ') || 'identity mismatch'}`;
          continue;
        }
        revs.push(env);
      }
      revs.forEach((r, i) => {
        if (r.revision !== i + 1) this.corrupt = `gap in revisions of ${id}`;
      });
      this.revisions.set(id, revs);
      this.noteId(id);
    }
    const evDir = join(this.dir, 'events');
    for (const f of readdirSync(evDir).sort()) {
      try {
        const ev = JSON.parse(readFileSync(join(evDir, f), 'utf8')) as EventEnvelope;
        if (validate(eventSchema, ev).length) this.corrupt = `invalid event ${f}`;
        this.eventList.push(ev);
      } catch {
        this.corrupt = `unparseable event ${f}`;
      }
    }
    this.eventList.forEach((e, i) => {
      if (e.seq !== i + 1) this.corrupt = `event sequence gap at ${e.seq}`;
    });
  }

  private noteId(id: string): void {
    const m = /^(.*)-(\d+)$/.exec(id);
    if (!m) return;
    const cur = this.seqByPrefix.get(m[1]) ?? 0;
    this.seqByPrefix.set(m[1], Math.max(cur, Number(m[2])));
  }

  private issuesFor(env: RecordEnvelope) {
    const issues = validate(envelopeSchema, env);
    if (issues.length) return issues;
    const schema = RECORD_SCHEMAS[env.type];
    return validate(schema, env.body, `$.body(${env.type})`);
  }

  get corruption(): string | null {
    return this.corrupt;
  }

  // ------------------------------------------------------------------------------------------
  // Reads

  head<T extends RecordType = RecordType>(id: string): RecordEnvelope<T> | undefined {
    const revs = this.revisions.get(id);
    return revs?.[revs.length - 1] as RecordEnvelope<T> | undefined;
  }

  mustHead<T extends RecordType>(id: string, type?: T): RecordEnvelope<T> {
    const h = this.head<T>(id);
    if (!h) fail('not_found', `record ${id} not found`, { ref: id });
    if (type && h.type !== type) fail('invalid_request', `record ${id} is a ${h.type}, not a ${type}`, { ref: id });
    return h;
  }

  get<T extends RecordType = RecordType>(r: Ref, type?: T): RecordEnvelope<T> {
    if (!r || typeof r !== 'object' || typeof r.record_id !== 'string' || !Number.isInteger(r.revision)) {
      fail('invalid_request', `not an exact record reference (expected {"record_id", "revision"}): ${JSON.stringify(r) ?? String(r)}`, { ref: r });
    }
    if (r.scope && r.scope !== this.scope) fail('permission_denied', 'cross-scope reference grants no access', { ref: r });
    const env = this.revisions.get(r.record_id)?.[r.revision - 1];
    if (!env) fail('not_found', `record ${r.record_id}@${r.revision} not found`, { ref: r });
    if (type && env.type !== type) fail('invalid_request', `record ${r.record_id} is a ${env.type}, not a ${type}`);
    return env as RecordEnvelope<T>;
  }

  tryGet<T extends RecordType = RecordType>(r: Ref): RecordEnvelope<T> | undefined {
    return this.revisions.get(r.record_id)?.[r.revision - 1] as RecordEnvelope<T> | undefined;
  }

  history(id: string): RecordEnvelope[] {
    return [...(this.revisions.get(id) ?? [])];
  }

  /** Current heads, optionally of one type. */
  heads<T extends RecordType>(type?: T): RecordEnvelope<T>[] {
    const out: RecordEnvelope<T>[] = [];
    for (const revs of this.revisions.values()) {
      const h = revs[revs.length - 1];
      if (h && (!type || h.type === type)) out.push(h as RecordEnvelope<T>);
    }
    return out.sort((a, b) => a.record_id.localeCompare(b.record_id, 'en', { numeric: true }));
  }

  headRef(id: string): Ref {
    const h = this.mustHead(id);
    return { record_id: h.record_id, revision: h.revision };
  }

  events(): readonly EventEnvelope[] {
    return this.eventList;
  }

  lastSeq(): number {
    return this.eventList.length;
  }

  findEventByKey(key: string, principal: string, operation: string): EventEnvelope | undefined {
    return this.eventList.find(
      (e) => e.idempotency_key === key && e.principal.principal === principal && e.operation === operation,
    );
  }

  peekNextId(type: RecordType, offset = 0): string {
    const prefix = ID_PREFIX[type];
    return `${prefix}-${String((this.seqByPrefix.get(prefix) ?? 0) + 1 + offset).padStart(4, '0')}`;
  }

  // ------------------------------------------------------------------------------------------
  // Commit

  commit(input: CommitInput): CommitResult {
    if (this.corrupt) fail('store_corrupt', `store ${this.scope} is corrupt (${this.corrupt}); writes refused`);
    const written: string[] = [];
    let committed = false;
    const newEnvs: RecordEnvelope[] = [];
    const pendingHeads = new Map<string, number>();
    const pendingSeq = new Map<string, number>();
    try {
      for (const p of input.records) {
        let id = p.record_id;
        if (!id) {
          const prefix = ID_PREFIX[p.type];
          const next = (pendingSeq.get(prefix) ?? this.seqByPrefix.get(prefix) ?? 0) + 1;
          pendingSeq.set(prefix, next);
          id = `${prefix}-${String(next).padStart(4, '0')}`;
          if (p.base_revision !== 0) fail('invalid_request', 'a new record must have base revision 0');
        }
        const current = pendingHeads.get(id) ?? this.head(id)?.revision ?? 0;
        if (current !== p.base_revision) {
          fail('revision_conflict', `record ${id} is at revision ${current}, expected ${p.base_revision}`, {
            ref: id,
            details: { expected: p.base_revision, actual: current },
          });
        }
        const existing = this.head(id);
        if (existing && existing.type !== p.type) fail('invalid_request', `record ${id} type cannot change`);
        const env: RecordEnvelope = {
          schema_version: SCHEMA_VERSION,
          scope: this.scope,
          record_id: id,
          type: p.type,
          revision: current + 1,
          created_at: input.now,
          created_by: input.principal,
          origin: input.origin,
          visibility: p.visibility ?? (this.scope === 'library' ? 'library' : 'engagement'),
          depends_on: p.depends_on ?? [],
          body: p.body,
        };
        const issues = this.issuesFor(env);
        if (issues.length) {
          fail('invalid_request', `record ${id} (${p.type}) fails its schema`, { details: issues.slice(0, 20) });
        }
        pendingHeads.set(id, env.revision);
        newEnvs.push(env);
      }
      const evs: EventEnvelope[] = input.events.map((e, i) => ({
        schema_version: SCHEMA_VERSION,
        scope: this.scope,
        seq: this.eventList.length + 1 + i,
        event_id: `evt-${this.scope}-${this.eventList.length + 1 + i}`,
        at: input.now,
        kind: e.kind,
        operation: e.operation,
        request_id: e.request_id,
        idempotency_key: e.idempotency_key,
        request_digest: e.request_digest,
        principal: input.principal,
        records: newEnvs.map((n) => ({ record_id: n.record_id, revision: n.revision })),
        result: e.result,
      }));
      for (const ev of evs) {
        const issues = validate(eventSchema, ev);
        if (issues.length) fail('invalid_request', 'event fails its schema', { details: issues });
      }
      for (const env of newEnvs) {
        const rel = `records/${env.record_id}/${env.revision}.json`;
        mkdirSync(join(this.dir, 'records', env.record_id), { recursive: true });
        writeFileSync(join(this.dir, rel), JSON.stringify(env, null, 2) + '\n', { flag: 'wx' });
        written.push(rel);
      }
      for (const ev of evs) {
        const rel = `events/${String(ev.seq).padStart(8, '0')}.json`;
        writeFileSync(join(this.dir, rel), JSON.stringify(ev, null, 2) + '\n', { flag: 'wx' });
        written.push(rel);
      }
      const blobs = (input.blobs ?? []).map((d) => this.archive.pathOf(d).slice(this.dir.length + 1));
      this.removeStaleGitLocks();
      git(this.dir, ['add', '--', ...written, ...blobs]);
      git(this.dir, ['commit', '-q', '-m', input.message]);
      committed = true;
      const commit = git(this.dir, ['rev-parse', 'HEAD']).trim();
      for (const env of newEnvs) {
        const revs = this.revisions.get(env.record_id) ?? [];
        revs.push(env);
        this.revisions.set(env.record_id, revs);
        this.noteId(env.record_id);
      }
      this.eventList.push(...evs);
      return { refs: newEnvs.map((n) => ({ record_id: n.record_id, revision: n.revision })), events: evs, commit };
    } catch (e) {
      if (committed) {
        // The commit landed; only bookkeeping after it failed. Never roll back acknowledged files.
        throw new HarnessError('execution_failed', `committed, but reloading state failed: ${(e as Error).message}; reopen the store`, { committed: true });
      }
      // Nothing was acknowledged: remove files of this attempt and unstage them.
      for (const rel of written) rmSync(join(this.dir, rel), { force: true });
      try {
        git(this.dir, ['reset', '-q']);
      } catch {
        /* best effort */
      }
      if (e instanceof HarnessError) throw e;
      throw new HarnessError('execution_failed', `commit failed: ${(e as Error).message}`);
    }
  }

  /** Full verification used after restore: records, events and every archive blob. */
  verify(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    if (this.corrupt) problems.push(this.corrupt);
    for (const d of this.archive.verifyAll()) problems.push(`archive blob ${d} fails its hash`);
    const fsck = (() => {
      try {
        git(this.dir, ['fsck', '--no-progress']);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    })();
    if (fsck) problems.push(`git fsck: ${fsck}`);
    return { ok: problems.length === 0, problems };
  }
}
