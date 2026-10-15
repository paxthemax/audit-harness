// Freezing a target source tree into a content-addressed snapshot (FR-01, FR-34;
// design/harness-state-and-execution.md, "Record contracts", row "Target snapshot").
//
// The tree is hashed into the archive with `putTree`: `.git`, Foundry build output (`out/`,
// `cache/`, `broadcast/`) are excluded; `lib/` dependencies are included; symlinks and special
// files are refused and listed. For a git checkout the commit is recorded together with the dirty
// files (whose working-tree contents are what is frozen) and the untracked files that were
// included. Target git is only inspected read-only (`gitInspect`); nothing in the target runs.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fail } from '../core/errors.ts';
import { digest } from '../core/hash.ts';
import { unknown, type Unknown } from '../core/refs.ts';
import type { Archive, TreeManifest } from '../store/archive.ts';
import { gitInspect } from '../store/git.ts';
import type { TargetSnapshotBody, VendoredDependency } from '../schema/records.ts';

// ------------------------------------------------------------------------------------------------
// Minimal TOML reader (foundry.toml): tables, dotted keys, strings, numbers, booleans, arrays.
// Inline tables are kept as their raw text. Enough for compiler settings, not a general parser.

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };

export function parseToml(text: string): Record<string, TomlValue> {
  const root: Record<string, TomlValue> = {};
  let table: Record<string, TomlValue> = root;
  const lines = text.split(/\r?\n/);
  const setPath = (obj: Record<string, TomlValue>, path: string[], v: TomlValue) => {
    let o = obj;
    for (const k of path.slice(0, -1)) {
      if (typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {};
      o = o[k] as Record<string, TomlValue>;
    }
    o[path[path.length - 1]] = v;
  };
  const keyPath = (k: string) => k.split('.').map((x) => x.trim().replace(/^["']|["']$/g, ''));
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]).trim();
    if (!line) continue;
    const t = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (t) {
      table = root;
      for (const k of keyPath(t[1])) {
        if (typeof table[k] !== 'object' || Array.isArray(table[k])) table[k] = {};
        table = table[k] as Record<string, TomlValue>;
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let raw = line.slice(eq + 1).trim();
    // Multi-line arrays.
    while (raw.startsWith('[') && bracketDepth(raw) > 0 && i + 1 < lines.length) {
      raw += ' ' + stripComment(lines[++i]).trim();
    }
    setPath(table, keyPath(key), parseValue(raw));
  }
  return root;
}

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function bracketDepth(s: string): number {
  let d = 0;
  let q: string | null = null;
  for (const c of s) {
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '[') d++;
    else if (c === ']') d--;
  }
  return d;
}

function parseValue(raw: string): TomlValue {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const q = raw[0];
    const end = raw.indexOf(q, 1);
    const body = raw.slice(1, end < 0 ? undefined : end);
    return q === '"' ? body.replace(/\\(["\\])/g, '$1') : body;
  }
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (/^[+-]?\d[\d_]*$/.test(raw)) return Number(raw.replace(/_/g, ''));
  if (/^[+-]?\d[\d_]*\.\d+$/.test(raw)) return Number(raw.replace(/_/g, ''));
  if (raw.startsWith('[')) {
    const inner = raw.slice(1, raw.lastIndexOf(']'));
    const items: TomlValue[] = [];
    let cur = '';
    let depth = 0;
    let q: string | null = null;
    for (const c of inner) {
      if (q) {
        cur += c;
        if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") q = c;
      if (c === '[' || c === '{') depth++;
      if (c === ']' || c === '}') depth--;
      if (c === ',' && depth === 0) {
        if (cur.trim()) items.push(parseValue(cur.trim()));
        cur = '';
      } else cur += c;
    }
    if (cur.trim()) items.push(parseValue(cur.trim()));
    return items;
  }
  return raw;
}

/** Look up a dotted key (e.g. `profile.default.optimizer_runs`). */
export function tomlGet(doc: Record<string, TomlValue>, key: string): TomlValue | undefined {
  let o: TomlValue | undefined = doc;
  for (const k of key.split('.')) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    o = (o as Record<string, TomlValue>)[k];
  }
  return o;
}

// ------------------------------------------------------------------------------------------------
// Foundry project configuration

export interface FoundryConfig {
  present: boolean;
  doc: Record<string, TomlValue>;
  src: string;
  out: string;
  cache: string;
  libs: string[];
  test: string;
  script: string;
  remappings: string[];
}

export function readFoundryConfig(text: string | null): FoundryConfig {
  const doc = text ? parseToml(text) : {};
  const p = (k: string) => tomlGet(doc, `profile.default.${k}`);
  const s = (k: string, d: string) => (typeof p(k) === 'string' ? (p(k) as string) : d);
  const libs = Array.isArray(p('libs')) ? (p('libs') as TomlValue[]).map(String) : ['lib'];
  const remappings = Array.isArray(p('remappings')) ? (p('remappings') as TomlValue[]).map(String) : [];
  return {
    present: text !== null,
    doc,
    src: s('src', 'src'),
    out: s('out', 'out'),
    cache: s('cache_path', 'cache'),
    libs,
    test: s('test', 'test'),
    script: s('script', 'script'),
    remappings,
  };
}

/**
 * Effective compiler settings declared in foundry.toml, or explicit unknown. Foundry 1.x defaults
 * (optimizer off, 200 runs, via_ir off) are applied only when a solc version and EVM version are
 * pinned, and every defaulted key is returned in `defaulted`. The build hook later replaces this
 * with the settings the compiler actually recorded in its artifact metadata.
 */
export function compilerFromConfig(cfg: FoundryConfig): { compiler: TargetSnapshotBody['compiler']; defaulted: string[] } {
  if (!cfg.present) return { compiler: unknown('no foundry.toml; compiler settings are known only after a build'), defaulted: [] };
  const p = (k: string) => tomlGet(cfg.doc, `profile.default.${k}`);
  const version = p('solc') ?? p('solc_version');
  const evm = p('evm_version');
  if (typeof version !== 'string' || !version) {
    return { compiler: unknown('foundry.toml does not pin a solc version (auto-detection depends on pragmas and installed compilers); known after a build'), defaulted: [] };
  }
  if (typeof evm !== 'string' || !evm) {
    return { compiler: unknown(`foundry.toml pins solc ${version} but not evm_version (the default depends on the Foundry release); known after a build`), defaulted: [] };
  }
  const defaulted: string[] = [];
  const optimizer = typeof p('optimizer') === 'boolean' ? (p('optimizer') as boolean) : (defaulted.push('optimizer=false'), false);
  const runs = typeof p('optimizer_runs') === 'number' ? (p('optimizer_runs') as number) : (defaulted.push('optimizer_runs=200'), 200);
  const via_ir = typeof p('via_ir') === 'boolean' ? (p('via_ir') as boolean) : (defaulted.push('via_ir=false'), false);
  return { compiler: { version, optimizer, runs, evm_version: evm, via_ir }, defaulted };
}

export function parseRemappings(text: string | null): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='));
}

export function parseGitmodules(text: string | null): { name: string; path: string; url: string | null }[] {
  if (!text) return [];
  const out: { name: string; path: string; url: string | null }[] = [];
  let cur: { name: string; path: string; url: string | null } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    const h = /^\[submodule\s+"(.+)"\]$/.exec(l);
    if (h) {
      cur = { name: h[1], path: '', url: null };
      out.push(cur);
      continue;
    }
    const kv = /^(\w+)\s*=\s*(.+)$/.exec(l);
    if (kv && cur) {
      if (kv[1] === 'path') cur.path = kv[2].trim();
      if (kv[1] === 'url') cur.url = kv[2].trim();
    }
  }
  return out.filter((s) => s.path);
}

// ------------------------------------------------------------------------------------------------
// Freezing

export interface UpstreamCopy {
  /** Local path of a prefetched pristine upstream copy. */
  path: string;
  name: string;
  version: string;
  source: string;
}

export interface FreezeInput {
  path: string;
  /** true: include every untracked file; a list: include just those (snapshot-relative paths). */
  include_untracked?: boolean | string[];
  /** Vendored path (snapshot-relative) -> prefetched upstream copy. */
  upstream?: Record<string, UpstreamCopy>;
}

export interface FrozenSource {
  tree: { artifact: string };
  manifest: TreeManifest;
  source: TargetSnapshotBody['source'];
  dependencies: TargetSnapshotBody['dependencies'];
  vendored: VendoredDependency[];
  compiler: TargetSnapshotBody['compiler'];
  config: FoundryConfig;
  limitations: string[];
}

function splitZ(s: string | null): string[] {
  return (s ?? '').split('\0').filter(Boolean);
}

/** Paths relative to `root` of every regular file under `dir`, excluding `.git`. */
function listFiles(dir: string, root: string, skip: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs).sort()) {
      if (name === '.git') continue;
      const p = join(abs, name);
      const rel = relative(root, p).split(sep).join('/');
      if (skip(rel)) continue;
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(rel);
    }
  };
  walk(dir);
  return out;
}

export function freezeSource(archive: Archive, input: FreezeInput): FrozenSource {
  if (!input?.path || typeof input.path !== 'string') fail('invalid_request', 'path is required');
  const root = resolve(input.path);
  if (!existsSync(root) || !statSync(root).isDirectory()) fail('invalid_request', `source path ${input.path} is not a directory`);
  const limitations: string[] = [];
  const readText = (rel: string): string | null => {
    const p = join(root, rel);
    try {
      return lstatSync(p).isFile() ? readFileSync(p, 'utf8') : null;
    } catch {
      return null;
    }
  };
  const config = readFoundryConfig(readText('foundry.toml'));
  const strip = (d: string) => d.replace(/^\.\//, '').replace(/\/$/, '');
  const buildDirs = new Set([strip(config.out), strip(config.cache), 'broadcast', 'out', 'cache']);

  // Git identity (read-only inspection of the target).
  const top = gitInspect(root, ['rev-parse', '--show-toplevel']);
  const isGit = top !== null;
  let commit: string | Unknown = unknown('not a git checkout');
  let dirty: string[] = [];
  let untracked: string[] = [];
  let ignored: string[] = [];
  if (isGit) {
    const head = gitInspect(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (head && head.trim()) {
      commit = head.trim();
      dirty = splitZ(gitInspect(root, ['diff', 'HEAD', '--name-only', '--relative', '-z', '--no-renames']));
    } else {
      commit = unknown('git repository has no commits');
      dirty = splitZ(gitInspect(root, ['ls-files', '-z']));
    }
    untracked = splitZ(gitInspect(root, ['ls-files', '-z', '--others', '--exclude-standard']));
    ignored = splitZ(gitInspect(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']));
  }

  const want = input.include_untracked;
  const untrackedSet = new Set(untracked);
  const includeUntracked = (rel: string) => want === true || (Array.isArray(want) && want.includes(rel));
  if (Array.isArray(want)) {
    for (const w of want) if (!untrackedSet.has(w)) fail('invalid_request', `include_untracked names ${w}, which is not an untracked file`);
  }
  const depRoots = [...config.libs.map(strip), ...Object.keys(input.upstream ?? {}).map(strip)];
  const underDep = (rel: string) => depRoots.some((d) => rel === d || rel.startsWith(d + '/'));
  // A directory on the way to a dependency root (node_modules for node_modules/@scope/pkg) must be walked even when
  // ignored; its other contents are still excluded one by one.
  const leadsToDep = (rel: string) => depRoots.some((d) => d.startsWith(rel + '/'));
  const excludedIgnored: string[] = [];
  const isIgnored = (rel: string) =>
    ignored.some((g) => (g.endsWith('/') ? rel === g.slice(0, -1) || rel.startsWith(g) : rel === g));

  const filter = (rel: string): boolean => {
    const first = rel.split('/')[0];
    if (rel.split('/').includes('.git')) return false;
    if (buildDirs.has(rel) || (buildDirs.has(first) && rel === first)) return false;
    if (isGit) {
      if (untrackedSet.has(rel) && !includeUntracked(rel)) return false;
      if (isIgnored(rel) && !underDep(rel) && !leadsToDep(rel)) {
        excludedIgnored.push(rel);
        return false;
      }
    }
    return true;
  };
  const { ref, manifest } = archive.putTree(root, filter);
  const included = isGit ? untracked.filter((u) => includeUntracked(u) && manifest.files[u]) : [];
  const excludedUntracked = isGit ? untracked.filter((u) => !includeUntracked(u)) : [];
  if (excludedUntracked.length) {
    limitations.push(`${excludedUntracked.length} untracked file(s) were not included: ${excludedUntracked.slice(0, 10).join(', ')}${excludedUntracked.length > 10 ? ', …' : ''}`);
  }
  const ignoredReported = excludedIgnored.filter((p) => !buildDirs.has(p.split('/')[0]));
  if (ignoredReported.length) {
    limitations.push(`${ignoredReported.length} git-ignored path(s) were not included: ${ignoredReported.slice(0, 10).join(', ')}${ignoredReported.length > 10 ? ', …' : ''}`);
  }
  for (const r of manifest.refused) limitations.push(`refused at ingestion: ${r.path} (${r.reason})`);
  if (dirty.length) limitations.push(`dirty checkout: ${dirty.length} file(s) differ from commit ${typeof commit === 'string' ? commit.slice(0, 12) : '(none)'}; the snapshot freezes their working-tree contents`);

  // Dependencies and remappings.
  const remappings = [...parseRemappings(readText('remappings.txt')), ...config.remappings];
  const gitmodules = parseGitmodules(readText('.gitmodules'));
  const depPaths = new Map<string, string>(); // path -> name
  for (const m of gitmodules) depPaths.set(strip(m.path), m.name.split('/').pop() ?? m.name);
  for (const lib of config.libs.map(strip)) {
    const abs = join(root, lib);
    if (!existsSync(abs) || !lstatSync(abs).isDirectory()) continue;
    for (const name of readdirSync(abs).sort()) {
      if (lstatSync(join(abs, name)).isDirectory()) depPaths.set(`${lib}/${name}`, name);
    }
  }
  for (const v of Object.keys(input.upstream ?? {})) depPaths.set(strip(v), strip(v).split('/').pop()!);
  const dependencies: TargetSnapshotBody['dependencies'] = [...depPaths.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, name]) => ({ name, path, remapping: remappings.find((r) => strip(r.split('=')[1] ?? '').startsWith(path)) ?? null }));
  for (const r of remappings) {
    const target = strip(r.split('=')[1] ?? '');
    if (target && !dependencies.some((d) => target.startsWith(d.path))) {
      dependencies.push({ name: r.split('=')[0].replace(/\/$/, ''), path: target, remapping: r });
    }
  }
  if (!remappings.length && depPaths.size) {
    limitations.push('no explicit remappings: Foundry auto-detects them at build time, so the effective remappings are known only from the build');
  }

  // Vendored dependencies against prefetched upstream copies (FR-34).
  const vendored: VendoredDependency[] = [];
  for (const [path] of [...depPaths.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const up = input.upstream?.[path] ?? input.upstream?.[path + '/'];
    if (!up) {
      vendored.push({ path, upstream: unknown('no prefetched pristine upstream copy supplied; vendored code not verified'), status: 'unknown', modified_files: [] });
      limitations.push(`vendored dependency ${path} was not verified against an upstream release`);
      continue;
    }
    const upRoot = resolve(up.path);
    if (!existsSync(upRoot) || !statSync(upRoot).isDirectory()) fail('invalid_request', `upstream copy for ${path} (${up.path}) is not a directory`);
    const ours = new Map<string, string>();
    for (const [rel, d] of Object.entries(manifest.files)) if (rel.startsWith(path + '/')) ours.set(rel.slice(path.length + 1), d);
    const skip = (rel: string) => buildDirs.has(rel);
    const theirs = new Map<string, string>();
    for (const rel of listFiles(upRoot, upRoot, skip)) theirs.set(rel, digest(readFileSync(join(upRoot, rel))));
    const modified: string[] = [];
    for (const [rel, d] of ours) {
      if (!theirs.has(rel)) modified.push(`${rel} (added)`);
      else if (theirs.get(rel) !== d) modified.push(rel);
    }
    for (const rel of theirs.keys()) if (!ours.has(rel)) modified.push(`${rel} (removed)`);
    modified.sort();
    vendored.push({ path, upstream: { name: up.name, version: up.version, source: up.source }, status: modified.length ? 'modified' : 'unmodified', modified_files: modified });
    if (modified.length) {
      limitations.push(`vendored dependency ${path} is MODIFIED relative to upstream ${up.name}@${up.version}: ${modified.length} file(s) differ`);
    }
  }

  const { compiler, defaulted } = compilerFromConfig(config);
  if (defaulted.length) limitations.push(`compiler settings not set in foundry.toml were taken as Foundry 1.x defaults until a build confirms them: ${defaulted.join(', ')}`);
  if (typeof commit !== 'string' && isGit) limitations.push(commit.reason);

  return {
    tree: ref,
    manifest,
    source: {
      kind: isGit ? 'git' : 'directory',
      origin_path: root,
      commit,
      dirty_files: dirty.sort(),
      untracked_included: included.sort(),
    },
    dependencies,
    vendored,
    compiler,
    config,
    limitations,
  };
}
