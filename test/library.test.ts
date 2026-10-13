import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { makeHarness, newEngagement } from './helpers.ts';
import { decide, statementBody, stageOne } from './report-fixtures.ts';
import { isHarnessError } from '../src/core/errors.ts';
import type { Ref } from '../src/core/refs.ts';
import { retrieveMechanisms } from '../src/library/library.ts';

const sanitized = {
  action: 'admit',
  sanitized_text: 'Share-price inflation via donation before the first deposit lets the first depositor steal later deposits.',
  counterconditions: ['virtual shares/assets offset', 'minimum initial deposit burned to a dead address'],
  applicability: { component_classes: ['erc4626-vault'], standards: ['ERC-4626'], compiler_versions: [] },
};

test('lesson transfers need both confirmations; entries never name the source engagement; another engagement retrieves them', () => {
  const h = makeHarness();
  try {
    const a = newEngagement(h, 'eng-acme');
    const b = newEngagement(h, 'eng-bravo');
    const src = stageOne(h, a, 'system_statement', statementBody({ statement: 'AcmeVault.deposit mints shares from totalAssets()' }));

    const quarantined = h.auditor.do(a, 'propose_lesson', { statement: 'vaults inflate', counterconditions: [], applicability: {}, sources: [] });
    assert.equal(quarantined.review_status, 'quarantined');
    const missing = h.auditor.do(a, 'propose_lesson', { statement: 'x', counterconditions: [], applicability: {}, sources: [{ record_id: 'stmt-9999', revision: 1 }] });
    assert.equal(missing.review_status, 'quarantined');
    const { lesson } = h.auditor.do(a, 'propose_lesson', {
      statement: 'AcmeVault first deposit can be inflated by donation',
      counterconditions: ['Acme added virtual shares in v2'],
      applicability: { component_classes: ['erc4626-vault'], standards: ['ERC-4626'] },
      sources: [src],
    });
    assert.equal(h.ws.store(a, true).mustHead(lesson.record_id, 'lesson').body.review_status, 'provisional');

    // Refusals: no confirmations, one confirmation, a quarantined lesson, the wrong scope.
    for (const confirmations of [undefined, { client_details_removed: true }, { client_details_removed: true, reuse_permitted: false }, { reuse_permitted: true }]) {
      assert.throws(() => decide(h, a, 'record_transfer', [lesson], { ...sanitized, lesson, confirmations }), (e) => isHarnessError(e, 'permission_denied'));
    }
    const both = { client_details_removed: true, reuse_permitted: true };
    assert.throws(() => decide(h, a, 'record_transfer', [quarantined.lesson], { ...sanitized, lesson: quarantined.lesson, confirmations: both }), (e) => isHarnessError(e, 'permission_denied'));
    assert.equal(h.ws.store('library', true).heads('library_entry').length, 0, 'refusals wrote nothing to the library');
    // Agents and the auditor CLI cannot write the library.
    assert.throws(() => h.auditor.do(a, 'record_decision', { decision_kind: 'record_transfer' }), (e) => isHarnessError(e, 'permission_denied'));

    const res = decide(h, a, 'record_transfer', [lesson], { ...sanitized, lesson, confirmations: both });
    const lib = h.ws.store('library', true);
    const entry = lib.mustHead(res.entry.record_id, 'library_entry');
    const envelope = JSON.stringify(entry);
    for (const needle of [a, 'Test engagement', 'Acme', 'acme']) assert.ok(!envelope.includes(needle), `entry envelope contains ${needle}`);
    assert.equal(entry.body.source.kind, 'transfer');
    const libraryHistory = execFileSync('git', ['log', '-p', '--format=%B'], { cwd: lib.dir, encoding: 'utf8' });
    assert.ok(!libraryHistory.includes(a), 'library history names no source engagement');
    for (const ev of lib.events()) assert.ok(!JSON.stringify(ev).includes(a));
    // The transfer record stays in the source engagement and carries the opaque reference.
    const transfer = h.ws.store(a, true).heads('library_transfer')[0];
    assert.equal(transfer.body.entry, entry.record_id);
    assert.equal((entry.body.source as { transfer_ref: string }).transfer_ref, transfer.body.opaque_ref);
    assert.deepEqual(transfer.body.confirmations, both);
    assert.equal(h.ws.store(b, true).heads('library_transfer').length, 0);

    // Engagement B retrieves the admitted entry with its counterconditions.
    const got = h.auditor.do(b, 'retrieve_mechanisms', { standards: ['erc-4626'] }).entries;
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].counterconditions, sanitized.counterconditions);
    assert.equal(got[0].authority, 'none');
    const ctx = h.auditor.do(b, 'build_context', { role: 'investigator', component_classes: ['erc4626-vault'] });
    const manifest = h.ws.store(b, true).archive.getJson<{ retrieved: { library: { counterconditions: string[] }[]; lessons: unknown[] } }>(ctx.context_manifest.artifact);
    assert.equal(manifest.retrieved.library.length, 1);
    assert.deepEqual(manifest.retrieved.library[0].counterconditions, sanitized.counterconditions);
    assert.equal(manifest.retrieved.lessons.length, 0, "B never sees A's lessons");

    assert.deepEqual(h.auditor.do('library', 'reconcile_library', {}).orphans, []);
  } finally {
    h.cleanup();
  }
});

test('public references are admitted, revised and retired in the library scope', () => {
  const h = makeHarness();
  try {
    const e = newEngagement(h, 'eng-one');
    // A public reference is not admitted from an engagement.
    assert.throws(() => decide(h, e, 'record_transfer', [], { ...sanitized, public_reference: 'https://example.org/post-mortem' }), (x) => isHarnessError(x, 'invalid_request'));
    const res = decide(h, 'library', 'record_transfer', [], { ...sanitized, public_reference: 'Public post-mortem: ERC-4626 inflation attacks' });
    const lib = () => h.ws.store('library', true);
    const entry = lib().mustHead(res.entry.record_id, 'library_entry');
    assert.equal(entry.body.source.kind, 'public_reference');
    assert.deepEqual((entry.body.source as { admitting_decision: Ref }).admitting_decision, res.decision);
    assert.equal(lib().heads('library_transfer').length, 1);

    const revised = decide(h, 'library', 'record_transfer', [res.entry], { action: 'revise', entry: res.entry, counterconditions: [...sanitized.counterconditions, 'deposit caps'] });
    assert.equal(lib().mustHead(res.entry.record_id, 'library_entry').body.counterconditions.length, 3);
    // Revising a stale revision is refused.
    assert.throws(() => decide(h, 'library', 'record_transfer', [res.entry], { action: 'retire', entry: res.entry, reason: 'x' }), (x) => isHarnessError(x, 'stale_dependency') || isHarnessError(x, 'revision_conflict'));
    decide(h, 'library', 'record_transfer', [revised.entry], { action: 'retire', entry: revised.entry, reason: 'superseded by a better write-up' });
    assert.equal(retrieveMechanisms(lib(), { standards: ['ERC-4626'] }).length, 0, 'retired entries are not retrieved');
  } finally {
    h.cleanup();
  }
});
