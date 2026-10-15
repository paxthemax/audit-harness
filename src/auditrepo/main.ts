// `audit` — the audit repository tool (docs/audit-repo.md). An audit repository pins this framework as a
// submodule, names the code under audit in audit.json and keeps the harness workspace beside them. This tool
// changes only the audit repository's git checkouts and audit.json; every harness write goes through the harness
// CLI (and so through a controller operation), in process.

import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { main as harnessMain } from '../cli/main.ts';
import { checkoutPinned, checkoutState, git, GitError, gitlink, gitTry, ignorePath, resolveRef } from './git.ts';
import {
  ENGAGEMENT_ID,
  MANIFEST,
  ManifestError,
  TARGET_MODES,
  TARGET_NAME,
  WORKSPACE,
  emptyManifest,
  engagementDir,
  findRoot,
  readManifest,
  targetDir,
  writeManifest,
  type AuditManifest,
  type TargetEntry,
  type TargetMode,
} from './manifest.ts';

/** The framework checkout this tool runs from. */
export const FRAMEWORK_ROOT = resolve(import.meta.dirname, '../..');
const TEMPLATE_DIR = join(FRAMEWORK_ROOT, 'template');

export interface Out {
  stdout(s: string): void;
  stderr(s: string): void;
}

class UsageError extends Error {}

type Level = 'ok' | 'warn' | 'fail';
export interface Check {
  level: Level;
  subject: string;
  message: string;
  /** A command that resolves the check, when there is one. */
  fix?: string;
}

// ------------------------------------------------------------------------------------------------
// Harness CLI, in process

interface HarnessResult {
  code: number;
  json: Record<string, unknown> | null;
  stderr: string;
}

async function harness(root: string, argv: string[]): Promise<HarnessResult> {
  let stdout = '';
  let stderr = '';
  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_WORKSPACE: join(root, WORKSPACE) };
  delete env.HARNESS_ENGAGEMENT;
  const code = await harnessMain([...argv, '--json'], env, { stdout: (s) => void (stdout += s), stderr: (s) => void (stderr += s) });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { code, json, stderr };
}

function harnessReason(r: HarnessResult): string {
  const err = r.json?.error as { code?: string; reason?: string; next?: string } | undefined;
  if (err) return `${err.code}: ${err.reason}${err.next ? ` (next: ${err.next})` : ''}`;
  return r.stderr.trim() || `exit ${r.code}`;
}

interface SnapshotInfo {
  id: string;
  revision: number;
  label: string;
  commit: string | null;
  dirty_files: string[];
}

/** The engagement's active snapshot, or null when it has none; undefined when the engagement does not exist. */
async function activeSnapshot(root: string, id: string): Promise<SnapshotInfo | null | undefined> {
  const e = await harness(root, ['engagement', 'show', id]);
  if (e.code !== 0) return undefined;
  const ref = (e.json?.engagement as { body?: { active_snapshot?: { record_id: string; revision: number } | null } })?.body?.active_snapshot;
  if (!ref) return null;
  const s = await harness(root, ['show', `${ref.record_id}@${ref.revision}`, '-e', id]);
  const body = (s.json?.record as { body?: { label: string; source: { commit: unknown; dirty_files: string[] } } })?.body;
  if (!body) return { id: ref.record_id, revision: ref.revision, label: '?', commit: null, dirty_files: [] };
  return {
    id: ref.record_id,
    revision: ref.revision,
    label: body.label,
    commit: typeof body.source.commit === 'string' ? body.source.commit : null,
    dirty_files: body.source.dirty_files,
  };
}

// ------------------------------------------------------------------------------------------------
// Targets

function targetChecks(root: string, name: string, t: TargetEntry): Check[] {
  const dir = targetDir(root, t);
  const subject = `target ${name}`;
  const st = checkoutState(dir);
  if (!st.present) {
    return [{ level: 'fail', subject, message: `no checkout at ${t.path}`, fix: t.mode === 'path' ? `clone ${t.url ?? 'it'} to ${dir}` : 'bin/audit setup' }];
  }
  const out: Check[] = [];
  if (t.mode === 'submodule') {
    const link = gitlink(root, t);
    if (link !== t.commit) out.push({ level: 'fail', subject, message: `${MANIFEST} pins ${short(t.commit)} but the audit repository records ${link ? short(link) : 'no gitlink'}`, fix: `bin/audit target pin ${name} ${t.commit}` });
  }
  if (st.head !== t.commit) {
    out.push({
      level: 'fail',
      subject,
      message: `checkout is at ${st.head ? short(st.head) : 'no commit'}, pinned ${short(t.commit)}`,
      fix: t.mode === 'path' ? `git -C ${dir} checkout ${t.commit}  (or: bin/audit target pin ${name})` : st.changes.length ? `commit or discard the changes in ${t.path}, then bin/audit setup` : 'bin/audit setup',
    });
  }
  if (st.changes.length) out.push({ level: 'warn', subject, message: `${st.changes.length} uncommitted change(s): ${st.changes.slice(0, 5).join('; ')}${st.changes.length > 5 ? '; …' : ''}` });
  if (st.submodules_off.length) out.push({ level: 'fail', subject, message: `nested submodules not at their pinned commits: ${st.submodules_off.slice(0, 5).join('; ')}`, fix: `git -C ${dir} submodule update --init --recursive` });
  if (!out.length) out.push({ level: 'ok', subject, message: `${t.mode} at ${short(t.commit)}${t.ref ? ` (${t.ref})` : ''}` });
  return out;
}

/** Bring a submodule or clone target to its pin (never a path target, never over local changes). */
function ensureTarget(root: string, name: string, t: TargetEntry): string {
  const dir = targetDir(root, t);
  let st = checkoutState(dir);
  if (t.mode === 'path') {
    if (!st.present) throw new Error(`no checkout at ${dir}; path targets are never cloned by this tool`);
    if (st.head !== t.commit) throw new Error(`checkout is at ${st.head ? short(st.head) : 'no commit'}, pinned ${short(t.commit)}; path targets are never moved by this tool`);
    return 'present';
  }
  let did = 'present';
  if (!st.present) {
    if (t.mode === 'submodule') git(root, ['submodule', 'update', '-q', '--init', '--', t.path]);
    else {
      mkdirSync(dirname(dir), { recursive: true });
      git(root, ['clone', '-q', '--', t.url!, dir]);
    }
    did = 'fetched';
    st = checkoutState(dir);
  }
  if (st.head !== t.commit || st.submodules_off.length) {
    const tracked = st.changes.filter((l) => !l.startsWith('??'));
    if (tracked.length && st.head !== t.commit) throw new Error(`checkout has local changes and is not at the pin; resolve them in ${t.path} first`);
    checkoutPinned(dir, t.commit);
    did = did === 'fetched' ? 'fetched' : 'moved to pin';
  }
  return did;
}

async function cmdTarget(root: string, args: string[], out: Printer): Promise<number> {
  const [sub, ...rest] = args;
  const m = readManifest(root);
  if (sub === 'add') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ref: { type: 'string' }, mode: { type: 'string', default: 'submodule' }, path: { type: 'string' } } });
    const [name, source] = positionals;
    if (!name || !source || positionals.length !== 2) throw new UsageError('target add <name> <url|dir> [--ref R] [--mode submodule|clone|path] [--path P]');
    if (!TARGET_NAME.test(name)) throw new UsageError(`target name must match ${TARGET_NAME}`);
    if (m.targets[name]) throw new UsageError(`target ${name} already exists (use: target pin ${name} <ref>)`);
    const mode = values.mode as TargetMode;
    if (!TARGET_MODES.includes(mode)) throw new UsageError(`--mode must be one of ${TARGET_MODES.join(', ')}`);

    if (mode === 'path') {
      const dir = resolve(source);
      const st = checkoutState(dir);
      if (!st.present || !st.head) throw new UsageError(`${source} is not the top level of a git checkout with a commit (name a subdirectory with engagement add --root)`);
      if (values.ref && resolveRef(dir, values.ref) !== st.head) throw new UsageError(`${source} is not at ${values.ref}; path targets are never moved, check it out yourself`);
      // Relative even outside the repository: sibling checkouts keep working on another machine with the same layout.
      const url = gitTry(dir, ['remote', 'get-url', 'origin'])?.trim() || null;
      m.targets[name] = { mode, url, path: relative(root, dir) || '.', ref: values.ref ?? null, commit: st.head };
    } else {
      const path = values.path ?? `targets/${name}`;
      const dir = resolve(root, path);
      if (existsSync(dir) && readdirSync(dir).length) throw new UsageError(`${path} already exists and is not empty`);
      if (mode === 'submodule') git(root, ['submodule', 'add', '-q', '--name', name, '--', source, path]);
      else {
        mkdirSync(dirname(dir), { recursive: true });
        git(root, ['clone', '-q', '--', source, dir]);
        ignorePath(root, `/${path}/`);
      }
      const ref = values.ref ?? git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      const commit = resolveRef(dir, ref);
      checkoutPinned(dir, commit);
      if (mode === 'submodule') git(root, ['add', '--', path]);
      m.targets[name] = { mode, url: source, path, ref, commit };
    }
    writeManifest(root, m);
    const t = m.targets[name];
    out.result({ ok: true, target: name, ...t }, [`Added ${t.mode} target ${name} at ${t.path}, pinned ${short(t.commit)}${t.ref ? ` (${t.ref})` : ''}.`, `Next: bin/audit engagement add <id> --target ${name} [--root <dir with foundry.toml>] --name … --owner … --purpose …`]);
    return 0;
  }
  if (sub === 'pin') {
    const [name, refArg] = rest;
    const t = name ? m.targets[name] : undefined;
    if (!t) throw new UsageError('target pin <name> [<ref>]  (default: the recorded ref, refetched)');
    const dir = targetDir(root, t);
    const st = checkoutState(dir);
    if (!st.present) throw new UsageError(`target ${name} has no checkout; run bin/audit setup first`);
    let commit: string;
    if (t.mode === 'path') {
      if (refArg) throw new UsageError('a path target is pinned to its current HEAD; check out the ref yourself, then: target pin <name>');
      commit = st.head!;
    } else {
      if (st.changes.some((l) => !l.startsWith('??'))) throw new UsageError(`${t.path} has local changes; resolve them first`);
      const ref = refArg ?? t.ref ?? 'HEAD';
      git(dir, ['fetch', '-q', '--tags', 'origin']);
      commit = resolveRef(dir, ref);
      checkoutPinned(dir, commit);
      if (t.mode === 'submodule') git(root, ['add', '--', t.path]);
      t.ref = ref;
    }
    const prior = t.commit;
    t.commit = commit;
    writeManifest(root, m);
    const ids = Object.entries(m.engagements).filter(([, e]) => e.target === name).map(([id]) => id);
    out.result({ ok: true, target: name, prior, commit, engagements: ids }, [
      prior === commit ? `Target ${name} stays at ${short(commit)}.` : `Target ${name} moved ${short(prior)} -> ${short(commit)}.`,
      ...(prior !== commit && ids.length ? [`The active snapshots of ${ids.join(', ')} are now behind. Register new ones (the harness diffs them and reopens affected conclusions): bin/audit snapshot ${ids.join(' ')}`] : []),
    ]);
    return 0;
  }
  if (sub === 'list') {
    out.result({ ok: true, targets: m.targets }, Object.entries(m.targets).map(([n, t]) => `${n}  ${t.mode}  ${t.path}  ${short(t.commit)}${t.ref ? ` (${t.ref})` : ''}  ${t.url ?? ''}`));
    return 0;
  }
  throw new UsageError('target add|pin|list');
}

// ------------------------------------------------------------------------------------------------
// Engagements, setup, snapshots, status

function cmdEngagement(root: string, args: string[], out: Printer): number {
  const [sub, ...rest] = args;
  if (sub !== 'add') throw new UsageError('engagement add <id> --target T [--root DIR] --name N --owner O --purpose P [--chain C] [--hardfork H]');
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { target: { type: 'string' }, root: { type: 'string', default: '' }, name: { type: 'string' }, owner: { type: 'string' }, purpose: { type: 'string' }, chain: { type: 'string' }, hardfork: { type: 'string' } },
  });
  const id = positionals[0];
  if (!id || !values.target || !values.name || !values.owner || !values.purpose) throw new UsageError('engagement add <id> --target T [--root DIR] --name N --owner O --purpose P [--chain C] [--hardfork H]');
  if (!ENGAGEMENT_ID.test(id)) throw new UsageError(`engagement id must match ${ENGAGEMENT_ID}`);
  const m = readManifest(root);
  if (m.engagements[id]) throw new UsageError(`engagement ${id} is already in ${MANIFEST}`);
  if (!m.targets[values.target]) throw new UsageError(`unknown target ${values.target}`);
  m.engagements[id] = { target: values.target, root: values.root.replace(/\/+$/, ''), name: values.name, owner: values.owner, purpose: values.purpose, chain: values.chain ?? null, hardfork: values.hardfork ?? null };
  writeManifest(root, m);
  const dir = engagementDir(root, m, id);
  const notes = existsSync(join(dir, 'foundry.toml')) ? [] : [`warning: no foundry.toml in ${relative(root, dir) || '.'}; the snapshot root is normally the Foundry project directory`];
  out.result({ ok: true, engagement: id, ...m.engagements[id], notes }, [`Added engagement ${id} on ${values.target}/${values.root || ''}.`, ...notes, 'Next: bin/audit setup']);
  return 0;
}

interface Step {
  subject: string;
  level: Level;
  message: string;
}

async function cmdSetup(root: string, out: Printer): Promise<number> {
  const m = readManifest(root);
  const steps: Step[] = [];
  const fail = (subject: string, e: unknown) => steps.push({ subject, level: 'fail', message: e instanceof GitError ? e.message : String((e as Error).message ?? e) });

  if (!existsSync(join(root, WORKSPACE, 'harness.json'))) {
    const r = await harness(root, ['init']);
    steps.push(r.code === 0 ? { subject: 'workspace', level: 'ok', message: `initialized ${WORKSPACE}/` } : { subject: 'workspace', level: 'fail', message: harnessReason(r) });
    if (r.code !== 0) return out.steps(steps);
  } else steps.push({ subject: 'workspace', level: 'ok', message: 'present' });

  const ready = new Set<string>();
  for (const [name, t] of Object.entries(m.targets)) {
    try {
      steps.push({ subject: `target ${name}`, level: 'ok', message: `${ensureTarget(root, name, t)} at ${short(t.commit)}` });
      ready.add(name);
    } catch (e) {
      fail(`target ${name}`, e);
    }
  }

  for (const [id, e] of Object.entries(m.engagements)) {
    const subject = `engagement ${id}`;
    let snap = await activeSnapshot(root, id);
    if (snap === undefined) {
      const r = await harness(root, ['engagement', 'create', id, '--name', e.name, '--owner', e.owner, '--purpose', e.purpose, ...(e.chain ? ['--chain', e.chain] : []), ...(e.hardfork ? ['--hardfork', e.hardfork] : [])]);
      if (r.code !== 0) {
        steps.push({ subject, level: 'fail', message: `create: ${harnessReason(r)}` });
        continue;
      }
      steps.push({ subject, level: 'ok', message: 'created' });
      snap = null;
    }
    if (snap) {
      steps.push({ subject, level: 'ok', message: `active snapshot ${snap.id} (${snap.label})` });
      continue;
    }
    if (!ready.has(e.target)) {
      steps.push({ subject, level: 'warn', message: `no snapshot registered: target ${e.target} is not ready` });
      continue;
    }
    const reg = await register(root, m, id, {});
    steps.push(reg.ok ? { subject, level: 'ok', message: `registered first snapshot ${reg.snapshot} (${reg.label})` } : { subject, level: 'fail', message: `snapshot: ${reg.reason}` });
  }
  return out.steps(steps, ['Next: bin/audit status, then bin/harness status -e <id> for decisions and work (or ask the agent: harness_overview).']);
}

async function register(root: string, m: AuditManifest, id: string, opts: { label?: string; allowDirty?: boolean; payload?: string }): Promise<{ ok: true; snapshot: string; label: string } | { ok: false; reason: string }> {
  const e = m.engagements[id];
  const t = m.targets[e.target];
  const dir = engagementDir(root, m, id);
  const tst = checkoutState(targetDir(root, t));
  if (!tst.present) return { ok: false, reason: `target ${e.target} has no checkout (bin/audit setup)` };
  if (tst.head !== t.commit) return { ok: false, reason: `target ${e.target} is at ${tst.head ? short(tst.head) : 'no commit'}, pinned ${short(t.commit)} (bin/audit setup, or bin/audit target pin)` };
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { ok: false, reason: `snapshot root ${relative(root, dir)} does not exist` };
  if (!opts.allowDirty) {
    const changes = (gitTry(dir, ['status', '--porcelain=v1', '--', '.']) ?? '').split('\n').filter(Boolean);
    const off = tst.submodules_off;
    if (changes.length || off.length) return { ok: false, reason: `${relative(root, dir)} has ${changes.length} uncommitted change(s) and ${off.length} nested submodule(s) off their pin; the snapshot would not be the pinned code (pass --allow-dirty to freeze the working tree as is; the harness records the dirty files)` };
  }
  const label = opts.label ?? `${e.target}${e.root ? `/${e.root}` : ''}@${short(t.commit)}`;
  const r = await harness(root, ['snapshot', 'register', dir, '-e', id, '--label', label, ...(opts.payload ? ['--payload', opts.payload] : [])]);
  if (r.code !== 0) return { ok: false, reason: harnessReason(r) };
  const res = r.json?.result as { snapshot?: { record_id: string } } | undefined;
  const snap = res?.snapshot?.record_id ?? (await activeSnapshot(root, id))?.id ?? '?';
  return { ok: true, snapshot: snap, label };
}

async function cmdSnapshot(root: string, args: string[], out: Printer): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { label: { type: 'string' }, 'allow-dirty': { type: 'boolean', default: false }, payload: { type: 'string' }, force: { type: 'boolean', default: false } } });
  const m = readManifest(root);
  const ids = positionals.length ? positionals : Object.keys(m.engagements);
  for (const id of ids) if (!m.engagements[id]) throw new UsageError(`unknown engagement ${id}`);
  if (values.label && ids.length > 1) throw new UsageError('--label applies to one engagement');
  const steps: Step[] = [];
  for (const id of ids) {
    const subject = `engagement ${id}`;
    const snap = await activeSnapshot(root, id);
    if (snap === undefined) {
      steps.push({ subject, level: 'fail', message: 'not in the workspace (bin/audit setup)' });
      continue;
    }
    const head = gitTry(engagementDir(root, m, id), ['rev-parse', 'HEAD'])?.trim();
    if (snap && !values.force && snap.commit === head && !snap.dirty_files.length) {
      steps.push({ subject, level: 'ok', message: `${snap.id} already freezes ${short(head!)} (pass --force to register again)` });
      continue;
    }
    const reg = await register(root, m, id, { label: values.label, allowDirty: values['allow-dirty'], payload: values.payload });
    steps.push(reg.ok ? { subject, level: 'ok', message: `registered ${reg.snapshot} (${reg.label})${snap ? `, replacing ${snap.id} as the active snapshot` : ''}` } : { subject, level: 'fail', message: reg.reason });
  }
  return out.steps(steps, ['A new snapshot needs a forge_build job before agents and tests can use it; bin/harness status -e <id> shows the gaps.']);
}

function toolCheck(cmd: string, args: string[], subject: string, need: string): Check {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { level: 'fail', subject, message: `${cmd} not found or not working: ${need}` };
  return { level: 'ok', subject, message: (r.stdout || r.stderr).split('\n')[0].trim() };
}

async function statusChecks(root: string): Promise<Check[]> {
  const checks: Check[] = [];
  let m: AuditManifest;
  try {
    m = readManifest(root);
  } catch (e) {
    return [{ level: 'fail', subject: MANIFEST, message: (e as Error).message }];
  }
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(major >= 25 ? { level: 'ok', subject: 'node', message: process.versions.node } : { level: 'fail', subject: 'node', message: `${process.versions.node}; the harness needs Node >= 25`, fix: 'mise install' });
  checks.push(toolCheck('bwrap', ['--version'], 'bwrap', 'the execution sandbox needs bubblewrap'));
  const forge = toolCheck('forge', ['--version'], 'forge', 'builds and tests need Foundry with cached compilers');
  checks.push(forge.level === 'fail' ? { ...forge, level: 'warn' } : forge);

  const fw = gitTry(FRAMEWORK_ROOT, ['rev-parse', 'HEAD'])?.trim();
  const fwDirty = (gitTry(FRAMEWORK_ROOT, ['status', '--porcelain=v1', '--untracked-files=no']) ?? '').split('\n').filter(Boolean).length;
  const linked = existsSync(join(root, 'harness')) && lstatSync(join(root, 'harness')).isSymbolicLink();
  checks.push({
    level: fwDirty ? 'warn' : 'ok',
    subject: 'framework',
    message: `${linked ? `harness/ -> ${FRAMEWORK_ROOT} (linked development checkout)` : relative(root, FRAMEWORK_ROOT) || FRAMEWORK_ROOT} at ${fw ? short(fw) : 'unknown commit'}${fwDirty ? `, ${fwDirty} uncommitted change(s): results are not reproducible from the pin` : ''}`,
  });

  const wsReady = existsSync(join(root, WORKSPACE, 'harness.json'));
  checks.push(wsReady ? { level: 'ok', subject: 'workspace', message: `${WORKSPACE}/` } : { level: 'fail', subject: 'workspace', message: 'not initialized', fix: 'bin/audit setup' });
  if (!Object.keys(m.targets).length) checks.push({ level: 'warn', subject: 'targets', message: 'none yet', fix: 'bin/audit target add <name> <url> [--ref R]' });
  for (const [name, t] of Object.entries(m.targets)) checks.push(...targetChecks(root, name, t));
  if (!Object.keys(m.engagements).length) checks.push({ level: 'warn', subject: 'engagements', message: 'none yet', fix: 'bin/audit engagement add <id> --target T --name … --owner … --purpose …' });

  for (const [id, e] of Object.entries(m.engagements)) {
    const subject = `engagement ${id}`;
    const snap = wsReady ? await activeSnapshot(root, id) : undefined;
    if (snap === undefined) {
      checks.push({ level: 'fail', subject, message: 'not created in the workspace', fix: 'bin/audit setup' });
      continue;
    }
    if (snap === null) {
      checks.push({ level: 'fail', subject, message: 'no active snapshot', fix: `bin/audit snapshot ${id}` });
      continue;
    }
    const dir = engagementDir(root, m, id);
    const head = gitTry(dir, ['rev-parse', 'HEAD'])?.trim() ?? null;
    if (head && snap.commit !== head) {
      checks.push({ level: 'warn', subject, message: `active snapshot ${snap.id} (${snap.label}) froze ${snap.commit ? short(snap.commit) : 'an unknown commit'}; ${e.target}/${e.root} is now at ${short(head)}`, fix: `bin/audit snapshot ${id}` });
    } else {
      checks.push({ level: snap.dirty_files.length ? 'warn' : 'ok', subject, message: `active snapshot ${snap.id} (${snap.label})${snap.dirty_files.length ? `, frozen with ${snap.dirty_files.length} dirty file(s)` : ''}` });
    }
  }
  return checks;
}

async function cmdStatus(root: string, out: Printer): Promise<number> {
  const checks = await statusChecks(root);
  const ok = !checks.some((c) => c.level === 'fail');
  out.result({ ok, root, framework: FRAMEWORK_ROOT, checks }, [
    ...checks.map((c) => `${c.level === 'ok' ? 'ok  ' : c.level === 'warn' ? 'WARN' : 'FAIL'}  ${c.subject}: ${c.message}${c.fix ? `\n        fix: ${c.fix}` : ''}`),
    ok ? 'Ready. Decisions, work and gaps per engagement: bin/harness status -e <id>' : 'Not ready: resolve the FAIL lines above.',
  ]);
  return ok ? 0 : 1;
}

function cmdHook(root: string, args: string[], out: Printer): number {
  const { values } = parseArgs({ args, options: { engagement: { type: 'string', short: 'e' } } });
  const m = readManifest(root);
  const ids = Object.keys(m.engagements);
  const id = values.engagement ?? (ids.length === 1 ? ids[0] : undefined);
  if (!id || !m.engagements[id]) throw new UsageError(`hook -e <engagement>  (one of: ${ids.join(', ') || 'none yet'})`);
  const settings = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand(root, id), timeout: 30 }] }] } };
  out.result({ ok: true, engagement: id, settings }, [
    '# Records every prompt you type in a Claude Code session started in this repository (or below it) verbatim as',
    '# captured input for this engagement; sessions started anywhere else record nothing.',
    '# Merge into ~/.claude/settings.json (user settings): an agent working in this repository can edit .claude/ here.',
    JSON.stringify(settings, null, 2),
  ]);
  return 0;
}

/**
 * The capture hook's shell command. User settings apply to every Claude Code session, so the command records only when
 * the session's project directory (CLAUDE_PROJECT_DIR) is the audit repository or below it, and otherwise exits 0
 * without reading the prompt. It runs the pinned framework through mise from the repository, so the hook gets the
 * repository's Node whatever PATH Claude Code started with.
 */
export function hookCommand(root: string, engagement: string): string {
  const r = shellWord(root);
  return `case "$CLAUDE_PROJECT_DIR" in ${r}|${r}/*) cd ${r} && exec mise exec -- harness/bin/harness capture-hook --workspace ${shellWord(join(root, WORKSPACE))} --engagement ${engagement};; esac`;
}

/** A path as one shell word: as is when it holds only safe characters, single-quoted otherwise. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// ------------------------------------------------------------------------------------------------
// New audit repository

function cmdNew(args: string[], out: Printer): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { framework: { type: 'string' }, 'framework-ref': { type: 'string' }, 'link-framework': { type: 'boolean', default: false } } });
  const dest = positionals[0];
  if (!dest || positionals.length !== 1) throw new UsageError('new <dir> [--framework URL|DIR] [--framework-ref REF] [--link-framework]');
  const root = resolve(dest);
  if (existsSync(root) && readdirSync(root).length) throw new UsageError(`${dest} exists and is not empty`);
  mkdirSync(root, { recursive: true });
  cpSync(TEMPLATE_DIR, root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  writeManifest(root, emptyManifest());

  const notes: string[] = [];
  let framework: { mode: 'submodule' | 'link'; source: string; commit: string | null };
  if (values['link-framework']) {
    // Development mode: the audit uses this framework checkout, uncommitted changes included.
    const src = realpathSync(values.framework ?? FRAMEWORK_ROOT);
    symlinkSync(src, join(root, 'harness'));
    appendFileSync(join(root, '.git', 'info', 'exclude'), '/harness\n');
    framework = { mode: 'link', source: src, commit: gitTry(src, ['rev-parse', 'HEAD'])?.trim() ?? null };
    notes.push(`harness/ links to ${src} and is not committed: this audit is not reproducible from the repository alone.`);
  } else {
    const source = values.framework ?? (gitTry(FRAMEWORK_ROOT, ['remote', 'get-url', 'origin'])?.trim() || FRAMEWORK_ROOT);
    git(root, ['submodule', 'add', '-q', '--name', 'harness', '--', source, 'harness']);
    const fwDir = join(root, 'harness');
    const ref = values['framework-ref'] ?? (values.framework ? 'HEAD' : git(FRAMEWORK_ROOT, ['rev-parse', 'HEAD']).trim());
    const commit = resolveRef(fwDir, ref);
    git(fwDir, ['checkout', '-q', '--detach', commit]);
    git(root, ['add', '--', 'harness']);
    framework = { mode: 'submodule', source, commit };
    if (!values.framework && (gitTry(FRAMEWORK_ROOT, ['status', '--porcelain=v1', '--untracked-files=no']) ?? '').trim()) {
      notes.push(`this framework checkout has uncommitted changes; the audit pins its last commit ${short(commit)}, which does not contain them.`);
    }
  }
  git(root, ['add', '-A']);
  out.result({ ok: true, root, framework, notes }, [
    `New audit repository at ${root} (framework ${framework.mode}${framework.commit ? ` at ${short(framework.commit)}` : ''}).`,
    ...notes.map((n) => `note: ${n}`),
    'Next:',
    `  cd ${dest} && mise trust && mise install`,
    '  bin/audit target add <name> <url> [--ref <tag|branch|commit>]',
    '  bin/audit engagement add <id> --target <name> [--root <dir>] --name … --owner … --purpose …',
    '  bin/audit setup && git commit -m "Set up the audit"',
  ]);
  return 0;
}

// ------------------------------------------------------------------------------------------------
// Entry point

function short(c: string): string {
  return c.slice(0, 12);
}

class Printer {
  readonly json: boolean;
  readonly o: Out;
  constructor(json: boolean, o: Out) {
    this.json = json;
    this.o = o;
  }
  result(obj: Record<string, unknown>, lines: string[]): void {
    this.o.stdout(this.json ? JSON.stringify(obj) + '\n' : lines.join('\n') + '\n');
  }
  steps(steps: Step[], next: string[] = []): number {
    const ok = !steps.some((s) => s.level === 'fail');
    this.result({ ok, steps }, [...steps.map((s) => `${s.level === 'ok' ? 'ok  ' : s.level === 'warn' ? 'WARN' : 'FAIL'}  ${s.subject}: ${s.message}`), ...(ok ? next : ['Some steps failed; fix them and rerun (every step is idempotent).'])]);
    return ok ? 0 : 1;
  }
}

const USAGE = `audit — audit repository tool (framework: docs/audit-repo.md)

Global: --repo DIR (or AUDIT_ROOT; default: the nearest directory with audit.json)  --json

  new <dir> [--framework URL|DIR] [--framework-ref REF] [--link-framework]
                         create an audit repository pinning this framework as the harness/ submodule
  target add <name> <url|dir> [--ref R] [--mode submodule|clone|path] [--path P]
                         add code under audit, pinned to a commit (default mode: submodule at targets/<name>)
  target pin <name> [<ref>]   move the pin (fetches); then register new snapshots
  target list
  engagement add <id> --target T [--root DIR] --name N --owner O --purpose P [--chain C] [--hardfork H]
                         an engagement audits one snapshot root (the Foundry project directory) of a target
  setup                  idempotent: workspace, target checkouts at their pins, engagements, first snapshots
  snapshot [<id> ...] [--label L] [--allow-dirty] [--payload JSON|@file] [--force]
                         register a snapshot of each engagement's root at the current pin
  status                 read-only checks with a fix for each failure; exit 1 when not ready
  hook [-e ID]           Claude Code settings that record typed prompts as captured input

Exit codes: 0 ok; 1 a step or check failed; 2 usage error.
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, o: Out = { stdout: (s) => void process.stdout.write(s), stderr: (s) => void process.stderr.write(s) }): Promise<number> {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  let rootArg = env.AUDIT_ROOT;
  const ri = args.indexOf('--repo');
  if (ri >= 0) {
    rootArg = args[ri + 1];
    args.splice(ri, 2);
  }
  const out = new Printer(json, o);
  const [cmd, ...rest] = args;
  try {
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      o.stdout(USAGE);
      return cmd ? 0 : 2;
    }
    if (cmd === 'new') return cmdNew(rest, out);
    const root = rootArg ? resolve(rootArg) : findRoot(process.cwd());
    if (!root || !existsSync(join(root, MANIFEST))) throw new UsageError(`no ${MANIFEST} found${rootArg ? ` in ${rootArg}` : ' here or above'}; create a repository with: audit new <dir>`);
    switch (cmd) {
      case 'target':
        return await cmdTarget(root, rest, out);
      case 'engagement':
        return cmdEngagement(root, rest, out);
      case 'setup':
        return await cmdSetup(root, out);
      case 'snapshot':
        return await cmdSnapshot(root, rest, out);
      case 'status':
        return await cmdStatus(root, out);
      case 'hook':
        return cmdHook(root, rest, out);
      default:
        throw new UsageError(`unknown command ${cmd}`);
    }
  } catch (e) {
    const usage = e instanceof UsageError || e instanceof ManifestError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    const reason = (e as Error).message ?? String(e);
    if (json) o.stdout(JSON.stringify({ ok: false, error: { code: usage ? 'usage' : e instanceof GitError ? 'git' : 'internal', reason } }) + '\n');
    else o.stderr(`${usage ? 'usage error' : 'error'}: ${reason}${usage ? '\n(run `audit help`)' : ''}\n`);
    return usage ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`internal error: ${String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
