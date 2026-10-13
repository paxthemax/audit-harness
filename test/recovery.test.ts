import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './helpers.ts';
import { admittedInvestigation } from './decision-fixtures.ts';
import { Controller } from '../src/controller/controller.ts';
import { Workspace } from '../src/controller/workspace.ts';
import { isHarnessError } from '../src/core/errors.ts';

// Control and recovery scenarios (design/harness-evaluation.md): restore on a clean workstation, and
// archives or paths designed to escape.

test('restore a backup on a clean workstation: decisions, artifacts and dependencies reconcile; hashes verify; corruption fails closed', () => {
  const h = makeHarness();
  try {
    const eid = 'r1';
    admittedInvestigation(h, eid);
    // Back up: the engagement store is a Git repository (records, events and archive in one history).
    const backup = join(h.dir, 'backup.git');
    execFileSync('git', ['clone', '-q', '--bare', h.ws.engagementDir(eid), backup]);
    // Restore into an isolated, fresh workspace.
    const ws2 = Workspace.init(join(h.dir, 'ws2'));
    execFileSync('git', ['clone', '-q', backup, ws2.engagementDir(eid)]);
    const c2 = new Controller(ws2);
    const auditor2 = c2.auditor(ws2.readSecret('auditor.key'));
    const v = auditor2.do(eid, 'verify_store');
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    const orig = h.ws.store(eid, true);
    const restored = ws2.store(eid, true);
    assert.deepEqual(restored.heads().map((r) => `${r.record_id}@${r.revision}`), orig.heads().map((r) => `${r.record_id}@${r.revision}`));
    assert.equal(restored.heads('human_decision').length, orig.heads('human_decision').length);

    // A corrupted archive blob is detected; it is never served as evidence.
    const blobDir = join(ws2.engagementDir(eid), 'archive', 'sha256');
    const pre = readdirSync(blobDir)[0];
    const blob = join(blobDir, pre, readdirSync(join(blobDir, pre))[0]);
    chmodSync(blob, 0o644);
    writeFileSync(blob, 'tampered');
    const v2 = c2.auditor(ws2.readSecret('auditor.key')).do(eid, 'verify_store');
    assert.equal(v2.ok, false);
    assert.ok(v2.problems.some((p: string) => p.includes('fails its hash')));
  } finally {
    h.cleanup();
  }
});

test('a committed record that fails its schema makes the store refuse writes', () => {
  const h = makeHarness();
  try {
    const eid = 'r2';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    const dir = h.ws.engagementDir(eid);
    // Damage an acknowledged record and commit the damage, as a broken restore might.
    const rec = join(dir, 'records', 'eng-0001', '1.json');
    writeFileSync(rec, JSON.stringify({ schema_version: 1, tampered: true }));
    execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'damage'], { cwd: dir });
    const c2 = new Controller(Workspace.open(h.ws.root));
    const a2 = c2.auditor(h.ws.readSecret('auditor.key'));
    assert.throws(() => a2.do(eid, 'submit_proposal', { kind: 'audit_unit', body: { kind: 'flow', name: 'f' } }), (e) => isHarnessError(e, 'store_corrupt'));
    assert.equal(a2.do(eid, 'verify_store').ok, false);
  } finally {
    h.cleanup();
  }
});

test('fixtures cannot escape their root and every target file they override is listed', () => {
  const h = makeHarness();
  try {
    const eid = 'r3';
    h.auditor.do(eid, 'create_engagement', { name: 'x', owner: 'a', audit_purpose: 'p' });
    const target = join(h.dir, 't');
    cpSync(join(import.meta.dirname, 'fixtures', 'vault'), target, { recursive: true });
    h.auditor.do(eid, 'register_snapshot', { path: target, label: 'v1' });
    for (const bad of ['../evil.sol', '/etc/passwd', 'a/../../b', '.git/config']) {
      assert.throws(() => h.auditor.do(eid, 'submit_fixture', { files: { [bad]: 'x' } }), (e) => isHarnessError(e, 'invalid_request'), bad);
    }
    const fx = h.auditor.do(eid, 'submit_fixture', { files: { 'src/Vault.sol': '// replaced', 'test/New.t.sol': '// new' } });
    assert.deepEqual(fx.overrides_target, ['src/Vault.sol']);
    assert.deepEqual(fx.added, ['test/New.t.sol']);
  } finally {
    h.cleanup();
  }
});
