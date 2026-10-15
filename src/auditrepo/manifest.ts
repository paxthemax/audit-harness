// The audit repository manifest (`audit.json`): the declarative description of one audit that sits on top of
// the framework (docs/audit-repo.md). It names the code under audit (targets: git checkouts pinned to a commit)
// and the harness engagements that audit them (one engagement per snapshot root, since an engagement has one
// active snapshot). `audit setup` reconciles the checkout and the harness workspace towards it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const MANIFEST = 'audit.json';
export const MANIFEST_FORMAT = 'audit-repo/1';
/** The harness workspace, relative to the audit repository (bin/harness and .mcp.json there assume it). */
export const WORKSPACE = 'workspace';

/** submodule: pinned by the audit repo's gitlink; clone: an ignored checkout pinned by `commit`; path: an existing checkout the tool never moves. */
export type TargetMode = 'submodule' | 'clone' | 'path';
export const TARGET_MODES: readonly TargetMode[] = ['submodule', 'clone', 'path'];

export interface TargetEntry {
  mode: TargetMode;
  /** Remote URL (null for a path target without one). */
  url: string | null;
  /** Checkout location relative to the audit repository (a path target may lie outside it). */
  path: string;
  /** The ref the pin was taken from, for humans and `target pin` without a ref. */
  ref: string | null;
  /** Full commit the checkout must be at. */
  commit: string;
}

export interface EngagementEntry {
  target: string;
  /** Snapshot root inside the target ("" for the target root): the directory with foundry.toml. */
  root: string;
  name: string;
  owner: string;
  purpose: string;
  chain: string | null;
  hardfork: string | null;
}

export interface AuditManifest {
  format: typeof MANIFEST_FORMAT;
  targets: Record<string, TargetEntry>;
  engagements: Record<string, EngagementEntry>;
}

export const TARGET_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** Same rule as the harness workspace (src/controller/workspace.ts). */
export const ENGAGEMENT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

export class ManifestError extends Error {}

export function emptyManifest(): AuditManifest {
  return { format: MANIFEST_FORMAT, targets: {}, engagements: {} };
}

/** The audit repository root: the nearest directory at or above `from` holding audit.json. */
export function findRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, MANIFEST))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function readManifest(root: string): AuditManifest {
  const p = join(root, MANIFEST);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new ManifestError(`cannot read ${p}: ${(e as Error).message}`);
  }
  return validateManifest(raw);
}

export function writeManifest(root: string, m: AuditManifest): void {
  validateManifest(m);
  writeFileSync(join(root, MANIFEST), JSON.stringify(m, null, 2) + '\n');
}

export function validateManifest(raw: unknown): AuditManifest {
  const bad = (why: string): never => {
    throw new ManifestError(`${MANIFEST}: ${why}`);
  };
  const obj = (v: unknown, what: string): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(`${what} must be an object`);
  const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : bad(`${what} must be a string`));
  const strOrNull = (v: unknown, what: string): string | null => (v === null || v === undefined ? null : str(v, what));

  const m = obj(raw, 'the manifest');
  if (m.format !== MANIFEST_FORMAT) bad(`format must be "${MANIFEST_FORMAT}"`);

  const targets: Record<string, TargetEntry> = {};
  for (const [name, v] of Object.entries(obj(m.targets ?? {}, 'targets'))) {
    if (!TARGET_NAME.test(name)) bad(`target name ${JSON.stringify(name)} must match ${TARGET_NAME}`);
    const t = obj(v, `targets.${name}`);
    const mode = str(t.mode, `targets.${name}.mode`) as TargetMode;
    if (!TARGET_MODES.includes(mode)) bad(`targets.${name}.mode must be one of ${TARGET_MODES.join(', ')}`);
    const path = str(t.path, `targets.${name}.path`);
    if (mode !== 'path' && (isAbsolute(path) || path.split('/').includes('..'))) bad(`targets.${name}.path must stay inside the audit repository`);
    const commit = str(t.commit, `targets.${name}.commit`);
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) bad(`targets.${name}.commit must be a full commit hash`);
    const url = strOrNull(t.url, `targets.${name}.url`);
    if (mode !== 'path' && !url) bad(`targets.${name}.url is required for a ${mode} target`);
    targets[name] = { mode, url, path, ref: strOrNull(t.ref, `targets.${name}.ref`), commit };
  }

  const engagements: Record<string, EngagementEntry> = {};
  for (const [id, v] of Object.entries(obj(m.engagements ?? {}, 'engagements'))) {
    if (!ENGAGEMENT_ID.test(id) || id === 'library') bad(`engagement id ${JSON.stringify(id)} must match ${ENGAGEMENT_ID}`);
    const e = obj(v, `engagements.${id}`);
    const target = str(e.target, `engagements.${id}.target`);
    if (!targets[target]) bad(`engagements.${id}.target names unknown target ${JSON.stringify(target)}`);
    const root = str(e.root ?? '', `engagements.${id}.root`);
    if (isAbsolute(root) || root.split('/').includes('..')) bad(`engagements.${id}.root must be a path inside the target`);
    engagements[id] = {
      target,
      root,
      name: str(e.name, `engagements.${id}.name`),
      owner: str(e.owner, `engagements.${id}.owner`),
      purpose: str(e.purpose, `engagements.${id}.purpose`),
      chain: strOrNull(e.chain, `engagements.${id}.chain`),
      hardfork: strOrNull(e.hardfork, `engagements.${id}.hardfork`),
    };
  }
  return { format: MANIFEST_FORMAT, targets, engagements };
}

/** Absolute checkout directory of a target. */
export function targetDir(root: string, t: TargetEntry): string {
  return resolve(root, t.path);
}

/** Absolute snapshot root of an engagement. */
export function engagementDir(root: string, m: AuditManifest, id: string): string {
  const e = m.engagements[id];
  return resolve(targetDir(root, m.targets[e.target]), e.root || '.');
}
