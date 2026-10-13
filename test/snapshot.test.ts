import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, newEngagement, type Harness } from './helpers.ts';
import { isHarnessError } from '../src/core/errors.ts';
import type { Ref } from '../src/core/refs.ts';
import { deriveInventory, type ArtifactFile } from '../src/snapshot/inventory.ts';
import { currentFreshness, freshnessSummary } from '../src/snapshot/change.ts';
import {
  authorizationBody,
  commitRecords,
  decide,
  defineTestCompletion,
  findingBody,
  forgeBuild,
  FOUNDRY_TOML,
  gitProject,
  investigationBody,
  unitBody,
  vaultSource,
  writeFiles,
} from './snapshot-fixtures.ts';

defineTestCompletion();

function project(h: Harness, name: string, src: string, extra: Record<string, string> = {}): string {
  const dir = join(h.dir, name);
  writeFiles(dir, { 'foundry.toml': FOUNDRY_TOML, 'src/Vault.sol': src, ...extra });
  return dir;
}

function register(h: Harness, eid: string, dir: string, label: string, extra: Record<string, unknown> = {}): any {
  return h.auditor.do(eid, 'register_snapshot', { path: dir, label, ...extra });
}

function build(h: Harness, eid: string, dir: string, snapshot: Ref, auth: Ref, expectOk = true): void {
  const b = forgeBuild(dir);
  assert.equal(b.ok, expectOk, b.stderr);
  h.runner.do(eid, 'test_snapshot_complete_job', { snapshot, authorization: auth, purpose: 'build', out_dir: b.ok ? b.out : null, exit_code: b.ok ? 0 : 1 });
}

function head(h: Harness, eid: string, id: string): any {
  return h.ws.store(eid, true).mustHead(id);
}

function headRef(h: Harness, eid: string, id: string): Ref {
  const e = head(h, eid, id);
  return { record_id: e.record_id, revision: e.revision };
}

function freshnessRecord(h: Harness, eid: string, conclusion: string): any {
  const f = currentFreshness(h.ws.store(eid, true), conclusion);
  assert.ok(f.record, `no freshness record for ${conclusion}`);
  return head(h, eid, f.record!.record_id);
}

// ------------------------------------------------------------------------------------------------

test('inventory from a real forge build: functions, modifiers, storage, assembly, low-level calls, layouts', () => {
  const h = makeHarness();
  try {
    const dir = project(h, 'inv', vaultSource());
    const b = forgeBuild(dir);
    assert.ok(b.ok, b.stderr);
    const artifacts: ArtifactFile[] = [];
    for (const d of readdirSync(b.out)) {
      if (d === 'build-info') continue;
      for (const f of readdirSync(join(b.out, d))) artifacts.push({ path: `${d}/${f}`, json: JSON.parse(readFileSync(join(b.out, d, f), 'utf8')) });
    }
    const { inventory, layouts } = deriveInventory(artifacts, { sourceBytes: (p) => readFileSync(join(dir, p)) });
    // Deterministic for the same artifacts.
    assert.deepEqual(deriveInventory([...artifacts].reverse(), { sourceBytes: (p) => readFileSync(join(dir, p)) }).inventory, inventory);
    assert.deepEqual(inventory.problems, []);
    assert.equal(inventory.compiler?.evm_version, 'cancun');
    assert.equal(inventory.compiler?.optimizer, true);
    const vault = inventory.contracts.find((c) => c.name === 'Vault')!;
    assert.deepEqual(vault.linearized, ['Vault', 'Base']);
    assert.equal(vault.kind, 'contract');
    const withdraw = vault.functions.find((f) => f.name === 'withdraw')!;
    assert.equal(withdraw.signature, 'withdraw(uint256)');
    assert.equal(withdraw.selector, '2e1a7d4d');
    assert.equal(withdraw.visibility, 'external');
    assert.deepEqual(withdraw.modifiers.map((m) => m.name), ['nonReentrant']);
    assert.deepEqual(withdraw.low_level_calls.map((l) => `${l.kind}:${l.target}`), ['call:msg.sender']);
    assert.deepEqual(withdraw.writes, ['Vault.balances']);
    assert.ok(withdraw.content_digest?.startsWith('sha256:'));
    const exec = vault.functions.find((f) => f.name === 'exec')!;
    assert.deepEqual(exec.low_level_calls.map((l) => l.kind), ['delegatecall']);
    assert.equal(exec.modifiers[0].ref, 'src/Vault.sol:Base.onlyOwner()');
    const peek = vault.functions.find((f) => f.name === 'peek')!;
    assert.equal(peek.assembly.length, 1);
    assert.deepEqual(peek.low_level_calls.map((l) => l.kind), ['staticcall']);
    assert.deepEqual(vault.modifiers.map((m) => m.name), ['nonReentrant']);
    assert.deepEqual(vault.modifiers[0].writes, ['Vault.locked']);
    assert.deepEqual(vault.storage_variables.map((v) => v.name), ['balances', 'locked']);
    assert.equal(vault.functions.find((f) => f.name === 'balances')?.signature, 'balances(address)');
    assert.ok(vault.entry_points.some((e) => e.signature === 'baseSlot()' && e.declared_in === 'Base'));
    assert.ok(!vault.entry_points.some((e) => e.signature.startsWith('constructor')));
    assert.deepEqual(vault.low_level_calls.map((l) => l.kind).sort(), ['call', 'call', 'delegatecall', 'staticcall']);
    assert.equal(vault.assembly.length, 1);
    const layout = layouts.contracts['src/Vault.sol:Vault'];
    assert.deepEqual(layout.map((e) => `${e.label}@${e.slot}:${e.declared_in}`), ['baseSlot@0:Base', 'owner@1:Base', 'balances@2:Vault', 'locked@3:Vault']);
  } finally {
    h.cleanup();
  }
});

test('dirty checkout: the snapshot freezes the uncommitted change and lists it; untracked files only on request', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const dir = join(h.dir, 'repo');
    const commit = gitProject(dir, { 'foundry.toml': FOUNDRY_TOML, 'src/Vault.sol': vaultSource() });
    const dirty = vaultSource({ guard: false });
    writeFileSync(join(dir, 'src/Vault.sol'), dirty);
    writeFileSync(join(dir, 'notes.txt'), 'untracked note\n');
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out/junk.json'), '{}');

    const r = register(h, eid, dir, 'dirty');
    const snap = head(h, eid, r.snapshot.record_id);
    assert.equal(snap.body.source.kind, 'git');
    assert.equal(snap.body.source.commit, commit);
    assert.deepEqual(snap.body.source.dirty_files, ['src/Vault.sol']);
    assert.deepEqual(snap.body.source.untracked_included, []);
    const archive = h.ws.store(eid, true).archive;
    const files = archive.getTree(snap.body.tree.artifact).files;
    assert.equal(archive.getText(files['src/Vault.sol']), dirty, 'the uncommitted change is what is frozen');
    assert.ok(!('notes.txt' in files));
    assert.ok(!Object.keys(files).some((f) => f.startsWith('out/') || f.startsWith('.git/')));
    assert.ok(snap.body.limitations.some((l: string) => l.startsWith('dirty checkout')));
    assert.ok(snap.body.limitations.some((l: string) => l.includes('untracked file(s) were not included')));
    // Source-only limitation (FR-01).
    assert.equal(snap.body.source_only, true);
    assert.equal(snap.body.deployment.unknown, true);
    assert.ok(snap.body.limitations.some((l: string) => l.startsWith('source-only snapshot')));
    assert.deepEqual(snap.body.compiler, { version: '0.8.30', optimizer: true, runs: 200, evm_version: 'cancun', via_ir: false });
    assert.equal(head(h, eid, 'eng-0001').body.active_snapshot.record_id, r.snapshot.record_id);

    const r2 = register(h, eid, dir, 'with untracked', { include_untracked: true });
    const snap2 = head(h, eid, r2.snapshot.record_id);
    assert.deepEqual(snap2.body.source.untracked_included, ['notes.txt']);
    assert.ok('notes.txt' in archive.getTree(snap2.body.tree.artifact).files);
    // The second registration diffs against the first.
    const diff = head(h, eid, snap2.body.diff.record_id);
    assert.deepEqual(diff.body.changes.map((c: any) => `${c.kind}:${c.item}:${c.change}:${c.mapping.kind}`), ['file:notes.txt:added:unreviewed_change_gap']);

    // A supplied deployment clears source_only.
    const r3 = register(h, eid, dir, 'deployed', { deployment: { chain_id: 1, addresses: [{ name: 'Vault', address: '0x' + '11'.repeat(20), proxy: true }] } });
    const snap3 = head(h, eid, r3.snapshot.record_id);
    assert.equal(snap3.body.source_only, false);
    assert.ok(snap3.body.limitations.some((l: string) => l.startsWith('model gap: proxy Vault')));
  } finally {
    h.cleanup();
  }
});

test('vendored libraries are compared against prefetched upstream copies (FR-34)', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const lib = 'pragma solidity 0.8.30;\nlibrary L { function f() internal pure returns (uint256) { return 1; } }\n';
    const dir = project(h, 'vend', vaultSource(), { 'lib/mylib/src/L.sol': lib.replace('return 1', 'return 2'), 'lib/other/src/O.sol': lib, 'lib/same/src/S.sol': lib });
    const up = join(h.dir, 'upstream');
    writeFiles(join(up, 'mylib'), { 'src/L.sol': lib, 'README.md': 'x' });
    writeFiles(join(up, 'same'), { 'src/S.sol': lib });
    const r = register(h, eid, dir, 'vendored', {
      upstream: {
        'lib/mylib': { path: join(up, 'mylib'), name: 'mylib', version: '1.0.0', source: 'https://example.invalid/mylib' },
        'lib/same': { path: join(up, 'same'), name: 'same', version: '2.0.0', source: 'https://example.invalid/same' },
      },
    });
    const snap = head(h, eid, r.snapshot.record_id);
    const byPath = Object.fromEntries(snap.body.vendored.map((v: any) => [v.path, v]));
    assert.equal(byPath['lib/mylib'].status, 'modified');
    assert.deepEqual(byPath['lib/mylib'].modified_files, ['README.md (removed)', 'src/L.sol']);
    assert.deepEqual(byPath['lib/mylib'].upstream, { name: 'mylib', version: '1.0.0', source: 'https://example.invalid/mylib' });
    assert.equal(byPath['lib/same'].status, 'unmodified');
    assert.equal(byPath['lib/other'].status, 'unknown');
    assert.equal(byPath['lib/other'].upstream.unknown, true);
    assert.ok(snap.body.limitations.some((l: string) => l.includes('lib/mylib is MODIFIED')));
    assert.deepEqual(snap.body.dependencies.map((d: any) => d.path), ['lib/mylib', 'lib/other', 'lib/same']);
  } finally {
    h.cleanup();
  }
});

test('FR-17: guard removal makes the rejected lead affected; unchanged probes carry forward; unevaluable probes are possibly affected', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const [auth] = commitRecords(h, eid, [{ type: 'work_authorization', body: authorizationBody('revalidation') }]);
    const d1 = project(h, 'v1', vaultSource());
    const s1 = register(h, eid, d1, 'v1').snapshot;
    build(h, eid, d1, s1, auth);
    const snap1 = head(h, eid, s1.record_id);
    assert.equal(snap1.body.build.status, 'completed');
    assert.ok(snap1.body.inventory && snap1.body.storage_layouts);

    const [inv1, inv2, inv3, inv5] = commitRecords(h, eid, [
      { type: 'investigation', body: investigationBody({ question: 'reenter withdraw' }) },
      { type: 'investigation', body: investigationBody({ question: 'deposit accounting' }) },
      { type: 'investigation', body: investigationBody({ question: 'owner sweep' }) },
      { type: 'investigation', body: investigationBody({ question: 'no probes at all' }) },
    ]);
    const [unit] = commitRecords(h, eid, [{ type: 'audit_unit', body: unitBody() }]);
    const [inv4] = commitRecords(h, eid, [{ type: 'investigation', body: investigationBody({ question: 'follow-up', disposition: null, work_state: 'queued', lineage: inv1 }) }]);

    const p1 = h.auditor.do(eid, 'record_probe', { conclusion: inv1, kind: 'code_hash', query: { symbol: 'Vault.withdraw' } });
    assert.equal(p1.status, 'evaluated');
    assert.match(p1.summary, /nonReentrant/);
    assert.deepEqual(p1.cannot_observe, [], 'a call back to msg.sender is the attacker, not a hidden dependency');
    const p2 = h.auditor.do(eid, 'record_probe', { conclusion: inv2, kind: 'code_hash', query: { symbol: 'Vault.deposit' } });
    assert.equal(p2.status, 'evaluated');
    const p3 = h.auditor.do(eid, 'record_probe', { conclusion: inv3, kind: 'code_hash', query: { symbol: 'Vault.sweep' } });
    assert.equal(p3.status, 'evaluated');
    assert.ok(p3.cannot_observe.some((c: string) => c.includes('low-level call to to')));
    const pe = h.auditor.do(eid, 'record_probe', { conclusion: { record_id: unit.record_id, revision: unit.revision }, kind: 'code_hash', query: { symbol: 'Vault.exec' } });
    assert.ok(pe.cannot_observe.some((c: string) => c.startsWith('delegatecall to t')));
    const pl = h.auditor.do(eid, 'record_probe', { conclusion: inv2, kind: 'storage_layout', query: { contract: 'Vault' } });
    assert.equal(pl.status, 'evaluated');
    // A probe on a missing symbol is unevaluable from the start.
    const bad = h.auditor.do(eid, 'record_probe', { conclusion: inv5, kind: 'code_hash', query: { symbol: 'Vault.nope' } });
    assert.equal(bad.status, 'unevaluable');

    // v2 removes the guard and the sweep function.
    const d2 = project(h, 'v2', vaultSource({ guard: false, sweep: false }));
    const r2 = register(h, eid, d2, 'v2');
    // Before the build, symbol probes wait for the inventory: nothing is carried yet.
    assert.equal(currentFreshness(h.ws.store(eid, true), inv1.record_id).value, 'possibly_affected');
    assert.equal(r2.freshness.carried_forward_mechanical ?? 0, 0);
    assert.ok(freshnessRecord(h, eid, inv1.record_id).body.probes.every((p: any) => p.status === 'pending'));
    build(h, eid, d2, r2.snapshot, auth);

    const store = h.ws.store(eid, true);
    assert.equal(currentFreshness(store, inv1.record_id).value, 'affected');
    const f1 = freshnessRecord(h, eid, inv1.record_id);
    assert.equal(f1.body.probes[0].status, 'changed');
    assert.equal(f1.body.prior_snapshot.record_id, s1.record_id);
    assert.equal(currentFreshness(store, inv2.record_id).value, 'carried_forward_mechanical');
    assert.equal(currentFreshness(store, inv3.record_id).value, 'possibly_affected');
    assert.equal(freshnessRecord(h, eid, inv3.record_id).body.probes[0].status, 'unevaluable');
    assert.equal(currentFreshness(store, inv5.record_id).value, 'possibly_affected');
    assert.equal(currentFreshness(store, unit.record_id).value, 'possibly_affected', 'delegatecall target is unobserved');
    // Queued work on the affected premise is suspended; the historical decision is untouched.
    const q = head(h, eid, inv4.record_id);
    assert.equal(q.body.work_state, 'blocked');
    assert.match(q.body.blocked_reason, /inv-0001.*affected/);
    assert.deepEqual(head(h, eid, inv1.record_id).body.disposition, investigationBody().disposition);

    // The diff shows the withdraw change (mapped to the reviewed unit) and the removed function (gap).
    const diff = head(h, eid, head(h, eid, r2.snapshot.record_id).body.diff.record_id);
    const byItem = Object.fromEntries(diff.body.changes.filter((c: any) => c.kind === 'function').map((c: any) => [c.item, c]));
    assert.equal(byItem['Vault.withdraw(uint256)'].change, 'modified');
    assert.match(byItem['Vault.withdraw(uint256)'].detail, /nonReentrant\] -> \[\]/);
    assert.deepEqual(byItem['Vault.withdraw(uint256)'].mapping, { kind: 'audit_unit', ref: { record_id: unit.record_id, revision: unit.revision } });
    assert.equal(byItem['Vault.sweep(address)'].change, 'removed');
    assert.equal(byItem['Vault.sweep(address)'].mapping.kind, 'unreviewed_change_gap');

    const summary = freshnessSummary(store);
    assert.equal(summary.counts.affected, 1);
    assert.equal(summary.counts.carried_forward_mechanical, 1);
    assert.equal(summary.carried_unattested.length, 1);

    // attest_carry_forward covers only carried items and refuses others.
    const fc = freshnessRecord(h, eid, inv2.record_id);
    const fa = freshnessRecord(h, eid, inv1.record_id);
    const pair = { prior_snapshot: s1, snapshot: headRef(h, eid, r2.snapshot.record_id) };
    assert.throws(
      () => decide(h, eid, 'attest_carry_forward', [{ record_id: fc.record_id, revision: fc.revision }, { record_id: fa.record_id, revision: fa.revision }], { ...pair, freshness: [{ record_id: fc.record_id, revision: fc.revision }, { record_id: fa.record_id, revision: fa.revision }] }),
      (e) => isHarnessError(e, 'invalid_request') && /carried_forward_mechanical/.test(e.message),
    );
    assert.throws(
      () => decide(h, eid, 'attest_carry_forward', [], { ...pair, freshness: [{ record_id: fc.record_id, revision: fc.revision }] }),
      (e) => isHarnessError(e, 'display_required'),
    );
    const att = decide(h, eid, 'attest_carry_forward', [{ record_id: fc.record_id, revision: fc.revision }], { ...pair, freshness: [{ record_id: fc.record_id, revision: fc.revision }] });
    assert.match(att.label, /mechanical/);
    const fc2 = freshnessRecord(h, eid, inv2.record_id);
    assert.equal(fc2.body.value, 'carried_forward_mechanical', 'attestation is never human review');
    assert.equal(fc2.body.attestation.record_id, att.decision.record_id);
    assert.equal(freshnessSummary(h.ws.store(eid, true)).carried_unattested.length, 0);

    // reaffirm: one conclusion per decision.
    const f3 = freshnessRecord(h, eid, inv3.record_id);
    const inv3Ref = headRef(h, eid, inv3.record_id);
    const f3Ref = { record_id: f3.record_id, revision: f3.revision };
    assert.throws(
      () => decide(h, eid, 'reaffirm', [inv3Ref, f3Ref], { conclusion: [inv3Ref, headRef(h, eid, inv2.record_id)], reason: 'x' }),
      (e) => isHarnessError(e, 'invalid_request') && /exactly one/.test(e.message),
    );
    assert.throws(() => decide(h, eid, 'reaffirm', [inv3Ref, f3Ref], { conclusion: inv3Ref }), (e) => isHarnessError(e, 'evidence_requirement_unmet'));
    const re = decide(h, eid, 'reaffirm', [inv3Ref, f3Ref], { conclusion: inv3Ref, reason: 'sweep was removed; the owner-only premise no longer applies' });
    assert.equal(re.previous_value, 'possibly_affected');
    assert.equal(currentFreshness(h.ws.store(eid, true), inv3.record_id).value, 'reaffirmed_by_human');
  } finally {
    h.cleanup();
  }
});

test('FR-17/FR-20: a fix that adds a function is an unreviewed-change gap; an inherited layout change is flagged; assess_fix derives labels', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const [auth] = commitRecords(h, eid, [{ type: 'work_authorization', body: authorizationBody('revalidation') }]);
    const d1 = project(h, 'v1', vaultSource());
    const s1 = register(h, eid, d1, 'v1').snapshot;
    build(h, eid, d1, s1, auth);
    const [inv] = commitRecords(h, eid, [{ type: 'investigation', body: investigationBody({ disposition: { value: 'accepted', decision: { record_id: 'dec-0998', revision: 1 } } }) }]);
    const [finding] = commitRecords(h, eid, [{ type: 'finding', body: findingBody(inv) }]);

    const d3 = project(h, 'v3', vaultSource({ fix: true }));
    const s3 = register(h, eid, d3, 'fix').snapshot;
    build(h, eid, d3, s3, auth);
    const snap3 = head(h, eid, s3.record_id);
    const diff = head(h, eid, snap3.body.diff.record_id);
    const changes = diff.body.changes;
    const added = changes.find((c: any) => c.item === 'Vault.emergencyWithdraw()');
    assert.ok(added, 'new function listed');
    assert.equal(added.change, 'added');
    assert.equal(added.mapping.kind, 'unreviewed_change_gap');
    const layout = changes.find((c: any) => c.kind === 'storage_layout' && c.item === 'Vault');
    assert.ok(layout, 'storage layout change listed');
    assert.match(layout.detail, /INHERITED storage layout change \(from Base\)/);
    assert.ok(changes.some((c: any) => c.kind === 'storage_layout' && c.item === 'Base'));
    assert.equal(currentFreshness(h.ws.store(eid, true), finding.record_id).value, 'possibly_affected', 'a finding without probes cannot be carried');

    const findingRef = headRef(h, eid, finding.record_id);
    const fixRef = headRef(h, eid, s3.record_id);
    const ev = { artifact: h.ws.store(eid, true).archive.putJson({ witness: 'reverted', legit: 'withdraw reverted for all users' }).artifact };
    const base = { finding: findingRef, fix_snapshot: fixRef, client_response: 'fixed', evidence: [ev] };
    assert.throws(
      () => decide(h, eid, 'assess_fix', [findingRef, fixRef], { ...base, attack_status: 'blocked', legitimate_status: 'not_assessed' }),
      (e) => isHarnessError(e, 'evidence_requirement_unmet') && /mandatory/.test(e.message),
    );
    assert.throws(() => decide(h, eid, 'assess_fix', [fixRef], { ...base, attack_status: 'blocked', legitimate_status: 'regressed' }), (e) => isHarnessError(e, 'display_required'));
    const r = decide(h, eid, 'assess_fix', [findingRef, fixRef], { ...base, attack_status: 'blocked', legitimate_status: 'regressed', client_response_text: 'patched in v3' });
    assert.equal(r.label, 'regressive');
    assert.match(r.scope_note, /Code outside the diff and the listed findings was not re-reviewed/);
    const fa = head(h, eid, r.fix_assessment.record_id);
    assert.equal(fa.body.attack_status, 'blocked');
    assert.equal(fa.body.legitimate_status, 'regressed');
    const f = head(h, eid, finding.record_id);
    assert.deepEqual(f.body.fix_assessments, [r.fix_assessment]);
    assert.equal(f.body.client_responses[0].text, 'patched in v3');
    // The changed withdraw now maps to the fix assessment; the new function stays a gap beside it.
    const diff2 = head(h, eid, diff.record_id);
    assert.equal(diff2.body.changes.find((c: any) => c.item === 'Vault.withdraw(uint256)').mapping.kind, 'fix_assessment');
    assert.ok(r.unreviewed_change_gaps.some((g: any) => g.item === 'Vault.emergencyWithdraw()'));

    // A declined fix is acknowledged with the client's response.
    const f2 = headRef(h, eid, finding.record_id);
    const ack = decide(h, eid, 'assess_fix', [f2], { finding: f2, fix_snapshot: null, attack_status: 'not_assessed', legitimate_status: 'not_assessed', client_response: 'acknowledged', client_response_text: 'accepted risk', evidence: [] });
    assert.equal(ack.label, 'acknowledged');
  } finally {
    h.cleanup();
  }
});

test('a failed build stays a failed build (FR-03): no inventory, symbol probes unevaluable', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const [auth] = commitRecords(h, eid, [{ type: 'work_authorization', body: authorizationBody('intake') }]);
    const d1 = project(h, 'v1', vaultSource());
    const s1 = register(h, eid, d1, 'v1').snapshot;
    build(h, eid, d1, s1, auth);
    const [inv] = commitRecords(h, eid, [{ type: 'investigation', body: investigationBody() }]);
    h.auditor.do(eid, 'record_probe', { conclusion: inv, kind: 'code_hash', query: { symbol: 'Vault.withdraw' } });
    const h2 = h.auditor.do(eid, 'record_probe', { conclusion: inv, kind: 'code_hash', query: { path: 'src/Vault.sol' } });
    assert.equal(h2.status, 'evaluated');

    const d2 = project(h, 'broken', vaultSource().replace('function deposit()', 'function deposit( {'));
    const s2 = register(h, eid, d2, 'broken').snapshot;
    build(h, eid, d2, s2, auth, false);
    const snap = head(h, eid, s2.record_id);
    assert.equal(snap.body.build.status, 'failed');
    assert.equal(snap.body.inventory, null);
    assert.ok(snap.body.limitations.some((l: string) => /failed build is never a clean analysis result/.test(l)));
    const f = freshnessRecord(h, eid, inv.record_id);
    assert.equal(f.body.value, 'affected', 'the whole-file probe changed');
    assert.deepEqual(f.body.probes.map((p: any) => p.status).sort(), ['changed', 'unevaluable']);
    // The diff falls back to file level.
    const diff = head(h, eid, snap.body.diff.record_id);
    assert.deepEqual(diff.body.changes.map((c: any) => c.kind), ['file']);
  } finally {
    h.cleanup();
  }
});

test('record_probe refuses non-conclusions and stale conclusion revisions; workers need their investigation', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const d1 = project(h, 'v1', vaultSource());
    assert.throws(() => h.auditor.do(eid, 'record_probe', { conclusion: { record_id: 'eng-0001', revision: 1 }, kind: 'code_hash', query: { path: 'x' } }), (e) => isHarnessError(e, 'invalid_request'));
    const [inv] = commitRecords(h, eid, [{ type: 'investigation', body: investigationBody() }]);
    assert.throws(() => h.auditor.do(eid, 'record_probe', { conclusion: inv, kind: 'code_hash', query: { path: 'x' } }), (e) => isHarnessError(e, 'snapshot_required'));
    register(h, eid, d1, 'v1');
    const p = h.auditor.do(eid, 'record_probe', { conclusion: inv, kind: 'config_value', query: { source: 'foundry.toml', key: 'profile.default.optimizer_runs' } });
    assert.equal(p.status, 'evaluated');
    assert.match(p.summary, /= 200/);
    const q = h.auditor.do(eid, 'record_probe', { conclusion: inv, kind: 'structural_query', query: { pattern: 'nonReentrant', paths: ['src'] } });
    assert.match(q.summary, /2 match/);
    const w = h.auditor.do(eid, 'record_probe', { conclusion: inv, kind: 'witness_rerun', query: { args: { match_test: 'testReenter' } } });
    assert.equal(w.status, 'pending');
    assert.throws(() => h.auditor.do(eid, 'record_probe', { conclusion: { ...inv, revision: 9 }, kind: 'code_hash', query: { path: 'x' } }), (e) => isHarnessError(e) );
  } finally {
    h.cleanup();
  }
});

test('witness rerun probes: baseline from trusted evidence, pending job spec on a new snapshot, outcome recorded by the probe hook', async () => {
  const { pendingReruns } = await import('../src/snapshot/probes.ts');
  const { reviseRecord, LIMITS } = await import('./snapshot-fixtures.ts');
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const [auth] = commitRecords(h, eid, [{ type: 'work_authorization', body: authorizationBody('revalidation') }]);
    const s1 = register(h, eid, project(h, 'v1', vaultSource()), 'v1').snapshot;
    const passed = { result_type: 'no_violation_observed', mode: 'test', bounds: null, interpretation: 'reverted', tests: [{ name: 'Poc.testReenter', status: 'passed', reason: null, expect: null }] };
    const base = h.runner.do(eid, 'test_snapshot_complete_job', { snapshot: s1, authorization: auth, purpose: 'probe', exit_code: 0, structured_result: passed });
    const [inv] = commitRecords(h, eid, [{ type: 'investigation', body: investigationBody() }]);
    const p = h.auditor.do(eid, 'record_probe', { conclusion: inv, kind: 'witness_rerun', query: { adapter: 'forge_test', args: { match_test: 'testReenter' } }, baseline_evidence: base.evidence });
    assert.equal(p.status, 'evaluated');

    const s2 = register(h, eid, project(h, 'v2', vaultSource({ guard: false })), 'v2').snapshot;
    const store = h.ws.store(eid, true);
    assert.equal(currentFreshness(store, inv.record_id).value, 'possibly_affected');
    const specs = pendingReruns(store);
    assert.equal(specs.length, 1);
    assert.equal(specs[0].purpose, 'probe');
    assert.equal(specs[0].adapter, 'forge_test');
    assert.deepEqual(specs[0].args, { match_test: 'testReenter' });
    assert.equal(specs[0].snapshot.record_id, s2.record_id);

    // The runner queues the job and links it to the probe; completion records the outcome.
    const jobBody = { authorization: auth, context_manifest: null, role: 'runner', purpose: 'probe', adapter: { name: 'forge_test', version: 't', descriptor: 't' }, operation: 'test', args: specs[0].args, snapshot: s2, fixture: null, input_digest: 't', investigation: null, variant: null, limits: LIMITS, reservation: { spend: 0, runtime_seconds: 0 }, lineage: null, guard_removal: null, status: 'queued', attempts: [] };
    const [job] = commitRecords(h, eid, [{ type: 'job', body: jobBody }]);
    reviseRecord(h, eid, p.probe.record_id, 'dependency_probe', (b) => ({ ...b, job, status: 'pending' }));
    const failed = { ...passed, result_type: 'counterexample', tests: [{ name: 'Poc.testReenter', status: 'failed', reason: 'excess payout', expect: null }] };
    h.runner.do(eid, 'test_snapshot_complete_job', { snapshot: s2, authorization: auth, purpose: 'probe', exit_code: 0, structured_result: failed, job: job.record_id });
    const f = currentFreshness(h.ws.store(eid, true), inv.record_id);
    assert.equal(f.value, 'affected');
    assert.ok(f.reasons.some((r) => /changed/.test(r)));
  } finally {
    h.cleanup();
  }
});

test('workers cannot replace probes or register snapshots; the auditor can replace probes', async () => {
  const { digest } = await import('../src/core/hash.ts');
  const { LIMITS } = await import('./snapshot-fixtures.ts');
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const d1 = project(h, 'v1', vaultSource());
    register(h, eid, d1, 'v1');
    const [auth] = commitRecords(h, eid, [{ type: 'work_authorization', body: authorizationBody('intake') }]);
    const [inv] = commitRecords(h, eid, [{ type: 'investigation', body: investigationBody() }]);
    const guard = h.auditor.do(eid, 'record_probe', { conclusion: inv, kind: 'code_hash', query: { path: 'src/Vault.sol' } });

    // A running attempt whose worker grant covers both operations.
    const snap = head(h, eid, 'snap-0001');
    const jobBody = { authorization: auth, context_manifest: null, role: 'investigator', purpose: 'agent', adapter: { name: 'agent', version: 't', descriptor: 't' }, operation: 'run', args: {}, snapshot: { record_id: snap.record_id, revision: snap.revision }, fixture: null, input_digest: 't', investigation: inv, variant: null, limits: LIMITS, reservation: { spend: 0, runtime_seconds: 0 }, lineage: null, guard_removal: null, status: 'running', attempts: [] };
    const [job] = commitRecords(h, eid, [{ type: 'job', body: jobBody }]);
    const token = 'worker-token-for-test';
    commitRecords(h, eid, [{
      type: 'attempt',
      body: {
        job, attempt_no: 1, status: 'running', started_at: new Date().toISOString(), ended_at: null, pid: null, reason: null, receipt: null,
        actual: { spend: null, runtime_seconds: null, spend_uncertain: false }, termination: 'not_applicable',
        grant: { digest: digest(token), operations: ['record_probe', 'register_snapshot'], expires_at: new Date(Date.now() + 3600_000).toISOString(), revoked: false },
      },
    }]);
    const worker = h.controller.worker(eid, token);

    // L10: no worker reaches the host filesystem through register_snapshot.
    assert.throws(() => worker.do(eid, 'register_snapshot', { path: d1, label: 'w' }), (e) => isHarnessError(e, 'permission_denied'));

    // M7: a worker may add a probe but not supersede the auditor's guard probe.
    const invRef = headRef(h, eid, inv.record_id);
    assert.throws(
      () => worker.do(eid, 'record_probe', { conclusion: invRef, kind: 'config_value', query: { key: 'profile.default.solc' }, replaces: [guard.probe.record_id] }),
      (e) => isHarnessError(e, 'permission_denied') && /only the auditor/.test(e.message),
    );
    assert.equal(head(h, eid, guard.probe.record_id).body.superseded_by ?? null, null);
    const added = worker.do(eid, 'record_probe', { conclusion: invRef, kind: 'config_value', query: { key: 'profile.default.solc' } });
    assert.equal(added.status, 'evaluated');

    // The auditor may replace.
    const repl = h.auditor.do(eid, 'record_probe', { conclusion: invRef, kind: 'code_hash', query: { symbol: 'Vault.withdraw' }, replaces: [guard.probe.record_id] });
    assert.deepEqual(head(h, eid, guard.probe.record_id).body.superseded_by, repl.probe);
  } finally {
    h.cleanup();
  }
});
