import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, newEngagement } from './helpers.ts';
import { isHarnessError } from '../src/core/errors.ts';
import { RecordStore } from '../src/store/recordStore.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('create engagement, read records, idempotency and channel authority', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const recs = h.auditor.do(eid, 'read_records', { type: 'engagement' });
    assert.equal(recs.records.length, 1);
    assert.equal(recs.records[0].body.closure_status, 'open');

    // record_display is a screen/auditor op; capture channel cannot call it
    assert.throws(() => h.capture.do(eid, 'record_display', { rendered: [], sections: [], started_at: 'x', ended_at: 'x' }),
      (e) => isHarnessError(e, 'permission_denied'));

    const now = new Date().toISOString();
    const r1 = h.screen.call(eid, 'record_display', { rendered: [{ record_id: 'eng-0001', revision: 1 }], sections: [], started_at: now, ended_at: now }, { idempotency_key: 'k1' });
    const r2 = h.screen.call(eid, 'record_display', { rendered: [{ record_id: 'eng-0001', revision: 1 }], sections: [], started_at: now, ended_at: now }, { idempotency_key: 'k1' });
    assert.deepEqual(r2.result, r1.result);
    assert.ok(r2.replayed);
    assert.throws(() => h.screen.call(eid, 'record_display', { rendered: [], sections: [], started_at: now, ended_at: now }, { idempotency_key: 'k1' }),
      (e) => isHarnessError(e, 'idempotency_conflict'));
    // stale expected revision conflicts visibly
    assert.throws(() => h.screen.call(eid, 'record_display', { rendered: [], sections: [], started_at: now, ended_at: now }, { expected_revisions: [{ record_id: 'eng-0001', revision: 7 }] }),
      (e) => isHarnessError(e, 'revision_conflict'));
    // bad auditor key
    assert.throws(() => h.controller.auditor('nope'), (e) => isHarnessError(e, 'permission_denied'));
  } finally {
    h.cleanup();
  }
});

test('uncommitted writes are quarantined on open; corrupt store fails closed', () => {
  const h = makeHarness();
  try {
    const eid = newEngagement(h);
    const dir = h.ws.engagementDir(eid);
    mkdirSync(join(dir, 'records', 'inv-0009'), { recursive: true });
    writeFileSync(join(dir, 'records', 'inv-0009', '1.json'), '{"half":');
    const s = RecordStore.open(dir, eid);
    assert.deepEqual(s.openReport.quarantined, ['records/inv-0009/1.json']);
    assert.equal(s.corruption, null);
    // corrupt a committed record
    writeFileSync(join(dir, 'records', 'eng-0001', '1.json'), '{"tampered":true}');
    const s2 = RecordStore.open(dir, eid);
    // tampering an acknowledged file shows up as an uncommitted modification and is restored from git
    assert.equal(s2.corruption, null);
    assert.equal(s2.mustHead('eng-0001', 'engagement').body.closure_status, 'open');
  } finally {
    h.cleanup();
  }
});
