import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAMEWORK_ROOT, main } from '../src/auditrepo/main.ts';
import { readManifest, validateManifest } from '../src/auditrepo/manifest.ts';

// Local fixture remotes: allow file:// submodules and give commits an identity, for this process only.
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function audit(root: string | null, ...argv: string[]): Promise<{ code: number; json: any; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await main([...argv, '--json', ...(root ? ['--repo', root] : [])], {}, { stdout: (s) => void (stdout += s), stderr: (s) => void (stderr += s) });
  return { code, json: stdout ? JSON.parse(stdout) : null, stderr };
}

/** An upstream target repo: the vault fixture under contracts/, with a nested submodule at contracts/lib/dep. */
function makeUpstream(dir: string): { url: string; dep: string } {
  const dep = join(dir, 'dep');
  mkdirSync(dep, { recursive: true });
  sh(dep, 'init', '-q', '-b', 'main');
  writeFileSync(join(dep, 'Dep.sol'), '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\nlibrary Dep {}\n');
  sh(dep, 'add', '-A');
  sh(dep, 'commit', '-q', '-m', 'dep');

  const up = join(dir, 'upstream');
  mkdirSync(up);
  sh(up, 'init', '-q', '-b', 'main');
  cpSync(join(FRAMEWORK_ROOT, 'test/fixtures/vault'), join(up, 'contracts'), { recursive: true });
  sh(up, 'add', '-A');
  sh(up, 'submodule', 'add', '-q', dep, 'contracts/lib/dep');
  sh(up, 'commit', '-q', '-m', 'v1');
  sh(up, 'tag', 'v1');
  return { url: up, dep };
}

function tmp(): string {
  return mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'auditrepo-test-'));
}

test('audit repository: new, targets in each mode, setup, pin moves and snapshots', async () => {
  const dir = tmp();
  try {
    const { url } = makeUpstream(dir);
    const root = join(dir, 'acme-audit');

    const created = await audit(null, 'new', root, '--link-framework');
    assert.equal(created.code, 0, JSON.stringify(created));
    assert.equal(created.json.framework.mode, 'link');
    assert.ok(lstatSync(join(root, 'harness')).isSymbolicLink());
    for (const f of ['AGENTS.md', 'CLAUDE.md', '.mcp.json', '.claude/settings.json', 'bin/audit', 'bin/harness', 'mise.toml', 'audit.json']) assert.ok(existsSync(join(root, f)), f);
    assert.equal(sh(root, 'status', '--porcelain', '--', 'harness'), '', 'a linked framework is not committed');

    // Submodule target pinned to a tag; its own submodules come along.
    const added = await audit(root, 'target', 'add', 'vault', url, '--ref', 'v1');
    assert.equal(added.code, 0, JSON.stringify(added));
    const v1 = sh(url, 'rev-parse', 'v1');
    assert.equal(added.json.commit, v1);
    assert.match(sh(root, 'ls-files', '-s', 'targets/vault'), new RegExp(`^160000 ${v1} `));
    assert.ok(existsSync(join(root, 'targets/vault/contracts/lib/dep/Dep.sol')), 'nested submodule initialized');

    assert.equal((await audit(root, 'target', 'add', 'vault', url)).code, 2, 'duplicate target name');
    assert.equal((await audit(root, 'engagement', 'add', 'vault-core', '--target', 'nope', '--name', 'n', '--owner', 'o', '--purpose', 'p')).code, 2);
    const eng = await audit(root, 'engagement', 'add', 'vault-core', '--target', 'vault', '--root', 'contracts', '--name', 'Vault core', '--owner', 'auditor', '--purpose', 'test');
    assert.equal(eng.code, 0, JSON.stringify(eng));
    assert.deepEqual(eng.json.notes, []);

    const setup = await audit(root, 'setup');
    assert.equal(setup.code, 0, JSON.stringify(setup));
    const msgs = setup.json.steps.map((s: { subject: string; message: string }) => `${s.subject}: ${s.message}`);
    assert.ok(msgs.includes('workspace: initialized workspace/'), msgs.join('\n'));
    assert.ok(msgs.includes('engagement vault-core: created'), msgs.join('\n'));
    assert.ok(msgs.some((m: string) => /^engagement vault-core: registered first snapshot snap-\d+ \(vault\/contracts@/.test(m)), msgs.join('\n'));

    // Setup is idempotent.
    const again = await audit(root, 'setup');
    assert.equal(again.code, 0);
    assert.ok(again.json.steps.some((s: { message: string }) => /^active snapshot snap-/.test(s.message)));

    const st = await audit(root, 'status');
    const check = (subject: string) => st.json.checks.filter((c: { subject: string }) => c.subject === subject);
    assert.deepEqual(check('target vault').map((c: { level: string }) => c.level), ['ok']);
    assert.deepEqual(check('engagement vault-core').map((c: { level: string }) => c.level), ['ok']);
    const snap1 = (await audit(root, 'snapshot', 'vault-core')).json.steps[0].message as string;
    assert.match(snap1, /already freezes/);

    // Upstream moves; the pin follows only on request, and the active snapshot is then behind.
    appendFileSync(join(url, 'contracts/src/Vault.sol'), '\n// v2\n');
    sh(url, 'commit', '-q', '-am', 'v2');
    const pinned = await audit(root, 'target', 'pin', 'vault', 'main');
    assert.equal(pinned.code, 0, JSON.stringify(pinned));
    assert.equal(pinned.json.commit, sh(url, 'rev-parse', 'main'));
    assert.deepEqual(pinned.json.engagements, ['vault-core']);
    assert.equal(readManifest(root).targets.vault.commit, pinned.json.commit);
    const behind = await audit(root, 'status');
    assert.ok(behind.json.checks.some((c: { subject: string; level: string; fix?: string }) => c.subject === 'engagement vault-core' && c.level === 'warn' && c.fix === 'bin/audit snapshot vault-core'));

    // A dirty snapshot root is refused unless the auditor asks to freeze the working tree.
    writeFileSync(join(root, 'targets/vault/contracts/src/Extra.sol'), '// local\n');
    const dirty = await audit(root, 'snapshot', 'vault-core');
    assert.equal(dirty.code, 1);
    assert.match(dirty.json.steps[0].message, /uncommitted change/);
    rmSync(join(root, 'targets/vault/contracts/src/Extra.sol'));
    const snap2 = await audit(root, 'snapshot', 'vault-core');
    assert.equal(snap2.code, 0, JSON.stringify(snap2));
    assert.match(snap2.json.steps[0].message, /^registered snap-\d+ .*replacing snap-/);

    // Clone mode: an ignored checkout pinned in audit.json, recloned by setup.
    const cl = await audit(root, 'target', 'add', 'vault-clone', url, '--mode', 'clone', '--ref', 'v1');
    assert.equal(cl.code, 0, JSON.stringify(cl));
    assert.ok(readFileSync(join(root, '.gitignore'), 'utf8').includes('/targets/vault-clone/'));
    rmSync(join(root, 'targets/vault-clone'), { recursive: true, force: true });
    const reclone = await audit(root, 'setup');
    assert.equal(reclone.code, 0, JSON.stringify(reclone));
    assert.equal(sh(join(root, 'targets/vault-clone'), 'rev-parse', 'HEAD'), v1);

    // Path mode: an existing checkout elsewhere, never moved by the tool.
    const ext = join(dir, 'ext');
    sh(dir, 'clone', '-q', '--recurse-submodules', url, ext);
    const pa = await audit(root, 'target', 'add', 'vault-ext', ext, '--mode', 'path');
    assert.equal(pa.code, 0, JSON.stringify(pa));
    assert.equal(pa.json.path, '../ext');
    sh(ext, 'checkout', '-q', 'v1');
    const moved = await audit(root, 'status');
    assert.ok(moved.json.checks.some((c: { subject: string; level: string }) => c.subject === 'target vault-ext' && c.level === 'fail'));
    assert.equal((await audit(root, 'target', 'pin', 'vault-ext')).json.commit, v1);

    // A fresh clone of the committed audit repository reaches the same pins with one command.
    sh(root, 'add', '-A');
    sh(root, 'commit', '-q', '-m', 'audit');
    const copy = join(dir, 'copy');
    sh(dir, 'clone', '-q', root, copy);
    rmSync(ext, { recursive: true, force: true });
    const fresh = await audit(copy, 'setup');
    assert.equal(sh(join(copy, 'targets/vault'), 'rev-parse', 'HEAD'), pinned.json.commit);
    assert.ok(existsSync(join(copy, 'targets/vault/contracts/lib/dep/Dep.sol')));
    assert.ok(fresh.json.steps.some((s: { subject: string; level: string }) => s.subject === 'target vault-ext' && s.level === 'fail'), 'a missing path target is reported, not cloned');
    assert.ok(fresh.json.steps.some((s: { subject: string; message: string }) => s.subject === 'engagement vault-core' && /registered first snapshot/.test(s.message)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit new pins the framework as a submodule at the requested commit', async () => {
  const dir = tmp();
  try {
    const fw = join(dir, 'fw');
    mkdirSync(fw);
    sh(fw, 'init', '-q', '-b', 'main');
    writeFileSync(join(fw, 'README.md'), 'one\n');
    sh(fw, 'add', '-A');
    sh(fw, 'commit', '-q', '-m', 'one');
    const first = sh(fw, 'rev-parse', 'HEAD');
    writeFileSync(join(fw, 'README.md'), 'two\n');
    sh(fw, 'commit', '-q', '-am', 'two');

    const root = join(dir, 'a');
    const r = await audit(null, 'new', root, '--framework', fw, '--framework-ref', first);
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.equal(r.json.framework.commit, first);
    assert.match(sh(root, 'ls-files', '-s', 'harness'), new RegExp(`^160000 ${first} `));
    assert.match(readFileSync(join(root, '.gitmodules'), 'utf8'), /path = harness/);
    assert.equal((await audit(null, 'new', root)).code, 2, 'refuses a non-empty directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit.json validation names the offending field', () => {
  const base = { format: 'audit-repo/1', targets: { t: { mode: 'submodule', url: 'u', path: 'targets/t', ref: null, commit: 'a'.repeat(40) } }, engagements: {} };
  assert.doesNotThrow(() => validateManifest(base));
  assert.throws(() => validateManifest({ ...base, format: 'x' }), /format/);
  assert.throws(() => validateManifest({ ...base, targets: { t: { ...base.targets.t, path: '../out' } } }), /inside the audit repository/);
  assert.throws(() => validateManifest({ ...base, targets: { t: { ...base.targets.t, commit: 'abc' } } }), /full commit/);
  assert.throws(() => validateManifest({ ...base, engagements: { e1: { target: 'zz', name: 'n', owner: 'o', purpose: 'p' } } }), /unknown target/);
  assert.throws(() => validateManifest({ ...base, engagements: { library: { target: 't', name: 'n', owner: 'o', purpose: 'p' } } }), /engagement id/);
});
