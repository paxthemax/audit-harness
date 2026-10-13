import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail } from '../core/errors.ts';
import { randomToken, sha256Hex } from '../core/hash.ts';
import { timingSafeEqual } from 'node:crypto';
import { withLock } from '../store/lock.ts';
import { RecordStore } from '../store/recordStore.ts';

// A workspace holds every engagement store, the mechanism library store, the controller's secrets
// and per-attempt scratch space. Worker sandboxes never mount the workspace; they receive only a
// read-only snapshot copy and their own scratch directory.
//
//   <root>/harness.json             workspace configuration (operator choices recorded here)
//   <root>/secrets/                 0700: auditor.key (trusted screen/auditor), capture.key
//   <root>/engagements/<id>/        one Git-backed record store per engagement
//   <root>/library/                 mechanism-library store (library scope)
//   <root>/runs/<attempt>/          scratch for running attempts (not evidence until submitted)

export interface WorkspaceConfig {
  format: 'harness.workspace/1';
  created_at: string;
  /** Sandbox selection is an operator choice; `bwrap` is the proposed local default. */
  sandbox: { kind: 'bwrap'; extra_ro_binds: string[] };
  /** Foundry toolchain location (operator choice); null = resolve `forge` from PATH at registration. */
  tools: { forge: string | null };
  /** Provider policy (operator choice). No real provider is configured by default. */
  providers: ProviderConfig[];
}

export interface ProviderConfig {
  name: string;
  kind: 'fake' | 'external' | 'omp_gateway';
  models: string[];
  /** For `omp_gateway`: the pinned omp binary and the profile holding the harness's logins. */
  omp?: {
    binary: string;
    version: string;
    profile: string;
    upstream: 'anthropic' | 'openai-codex';
    /** Notional USD per million tokens; omitted = the proposed table in src/runner/ompGateway.ts. */
    rates?: Record<string, { input: number; output: number; cache_write: number; cache_read: number }>;
    /** Fraction of any plan window at which new calls are refused; omitted = the proposed default. */
    headroom?: number;
  };
}

const ENGAGEMENT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

export class Workspace {
  readonly root: string;
  readonly config: WorkspaceConfig;
  private stores = new Map<string, RecordStore>();

  private constructor(root: string, config: WorkspaceConfig) {
    this.root = root;
    this.config = config;
  }

  static init(root: string, overrides: Partial<WorkspaceConfig> = {}): Workspace {
    const abs = resolve(root);
    if (existsSync(join(abs, 'harness.json'))) fail('invalid_request', `workspace already exists at ${abs}`);
    mkdirSync(join(abs, 'engagements'), { recursive: true });
    mkdirSync(join(abs, 'runs'), { recursive: true });
    mkdirSync(join(abs, 'secrets'), { recursive: true, mode: 0o700 });
    chmodSync(join(abs, 'secrets'), 0o700);
    for (const k of ['auditor.key', 'capture.key']) {
      writeFileSync(join(abs, 'secrets', k), randomToken() + '\n', { mode: 0o600, flag: 'wx' });
    }
    const config: WorkspaceConfig = {
      format: 'harness.workspace/1',
      created_at: new Date().toISOString(),
      sandbox: { kind: 'bwrap', extra_ro_binds: [] },
      tools: { forge: null },
      providers: [],
      ...overrides,
    };
    writeFileSync(join(abs, 'harness.json'), JSON.stringify(config, null, 2) + '\n');
    RecordStore.init(join(abs, 'library'), 'library');
    return new Workspace(abs, config);
  }

  static open(root: string): Workspace {
    const abs = resolve(root);
    const p = join(abs, 'harness.json');
    if (!existsSync(p)) fail('not_found', `no workspace at ${abs} (run \`harness init\`)`);
    const config = JSON.parse(readFileSync(p, 'utf8')) as WorkspaceConfig;
    if (config.format !== 'harness.workspace/1') fail('unsupported_contract', `unsupported workspace format ${config.format}`);
    return new Workspace(abs, config);
  }

  get lockPath(): string {
    return join(this.root, '.controller.lock');
  }

  get runsDir(): string {
    return join(this.root, 'runs');
  }

  engagementDir(id: string): string {
    if (!ENGAGEMENT_ID.test(id) || id === 'library') fail('invalid_request', `invalid engagement id ${JSON.stringify(id)}`);
    return join(this.root, 'engagements', id);
  }

  hasEngagement(id: string): boolean {
    return RecordStore.exists(this.engagementDir(id));
  }

  engagementIds(): string[] {
    const dir = join(this.root, 'engagements');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((id) => ENGAGEMENT_ID.test(id) && this.hasEngagement(id)).sort();
  }

  /** Open (or reopen when another process committed) the store for a scope. */
  store(scope: string, fresh = false, force = false): RecordStore {
    const dir = scope === 'library' ? join(this.root, 'library') : this.engagementDir(scope);
    const cached = this.stores.get(scope);
    if (cached && !fresh) return cached;
    if (cached && fresh && !force && headOf(dir) === cached.lastCommitSeen) return cached;
    // Opening runs crash recovery (quarantining uncommitted files), so it must never overlap another
    // process's commit: hold the controller lock while (re)loading.
    return withLock(this.lockPath, () => {
      const s = RecordStore.open(dir, scope);
      s.lastCommitSeen = headOf(dir);
      this.stores.set(scope, s);
      return s;
    });
  }

  createEngagementStore(id: string): RecordStore {
    const dir = this.engagementDir(id);
    if (RecordStore.exists(dir)) fail('invalid_request', `engagement ${id} already exists`);
    const s = RecordStore.init(dir, id);
    s.lastCommitSeen = headOf(dir);
    this.stores.set(id, s);
    return s;
  }

  /** Remove an engagement store that holds no committed records yet (a refused create_engagement). */
  discardNewEngagementStore(id: string): void {
    const dir = this.engagementDir(id);
    const s = RecordStore.exists(dir) ? RecordStore.open(dir, id) : null;
    if (s && (s.heads().length || s.events().length)) return; // never discard acknowledged state
    this.stores.delete(id);
    rmSync(dir, { recursive: true, force: true });
  }

  noteCommitted(scope: string): void {
    const s = this.stores.get(scope);
    if (s) s.lastCommitSeen = headOf(s.dir);
  }

  checkSecret(name: 'auditor.key' | 'capture.key', presented: string): boolean {
    const expected = readFileSync(join(this.root, 'secrets', name), 'utf8').trim();
    const a = Buffer.from(sha256Hex(expected));
    const b = Buffer.from(sha256Hex(presented.trim()));
    return timingSafeEqual(a, b);
  }

  readSecret(name: 'auditor.key' | 'capture.key'): string {
    return readFileSync(join(this.root, 'secrets', name), 'utf8').trim();
  }
}

function headOf(dir: string): string {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = join(dir, '.git', head.slice(5));
      if (existsSync(refPath)) return readFileSync(refPath, 'utf8').trim();
      const packed = join(dir, '.git', 'packed-refs');
      if (existsSync(packed)) {
        const line = readFileSync(packed, 'utf8')
          .split('\n')
          .find((l) => l.endsWith(' ' + head.slice(5)));
        if (line) return line.split(' ')[0];
      }
      return '';
    }
    return head;
  } catch {
    return '';
  }
}
