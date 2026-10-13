import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers.ts';
import { admittedInvestigation, display, head, LIMITS } from './decision-fixtures.ts';
import { nextJob } from '../src/scheduler/scheduler.ts';
import '../src/index.ts';
import type { Ref } from '../src/core/refs.ts';

// Scheduling across several batches (delivery step 2; loop L5; FR-19).

function authorizeBatch(h: ReturnType<typeof makeHarness>, eid: string, inv: Ref, extra: Record<string, unknown> = {}) {
  const cur = head(h, eid, inv.record_id);
  return h.screen.do(eid, 'authorize_work', {
    reviewed: [cur],
    display_receipt: display(h, eid, [cur]),
    inputs: { kind: 'batch', investigations: [cur], capabilities: { tools: ['forge_test'], providers: [], network: 'denied' }, limits: { ...LIMITS, spend: 1 }, ...extra },
    rationale: 'second batch',
    rationale_authorship: 'human_written',
  }).work_authorization as Ref;
}

test('batches interleave round-robin and their lifecycle is reconciled from records', () => {
  const h = makeHarness();
  try {
    const eid = 's1';
    const { inv: invA, flow } = admittedInvestigation(h, eid, { impact: 'low', executable: false, method: 'hypothesis' });
    const store = () => h.ws.store(eid, true);
    const authA = store().mustHead(invA.record_id, 'investigation').body.authorization!;
    const invB = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'hypothesis', question: 'second question', audit_units: [head(h, eid, flow.record_id)], potential_impact: 'low', executable: false } }).investigation;
    const authB = authorizeBatch(h, eid, invB);
    const snap = store().heads('engagement')[0].body.active_snapshot!;
    const job = (auth: Ref, inv: Ref, t: string) =>
      h.auditor.do(eid, 'request_job', { authorization: auth, purpose: 'experiment', adapter: 'forge_test', snapshot: store().headRef(snap.record_id), investigation: inv, args: { match_test: t }, limits: { runtime_seconds: 10 } }).job;
    const a1 = job(authA, invA, 'test_a1');
    job(authA, invA, 'test_a2');
    const b1 = job(authB, invB, 'test_b1');
    // Nothing has dispatched yet: the lower authorization id goes first, then the other batch.
    assert.equal(nextJob(store(), new Date().toISOString()).next!.record_id, a1.record_id);
    // Batch A dispatches a1 (the runner starts and completes it); batch B goes next, not a2.
    const att = h.runner.do(eid, 'start_attempt', { job: a1.record_id, grant_digest: 'sha256:' + '2'.repeat(64) }).attempt;
    h.runner.do(eid, 'complete_attempt', { attempt: att.record_id, not_run: 'scheduler test' });
    assert.equal(nextJob(store(), new Date().toISOString()).next!.record_id, b1.record_id, 'the other batch is not starved behind the first');
    const status = h.auditor.do(eid, 'batch_status');
    assert.equal(status.batches.filter((b: { kind: string }) => b.kind === 'batch').length, 2);

    // An expired standing charter holds its jobs.
    const invC = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'hypothesis', question: 'overnight', audit_units: [head(h, eid, flow.record_id)], potential_impact: 'low', executable: false } }).investigation;
    const past = { from: new Date(Date.now() - 3_600_000).toISOString(), until: new Date(Date.now() + 2_000).toISOString() };
    const authC = authorizeBatch(h, eid, invC, { validity: past });
    const c1 = job(authC, invC, 'test_c1');
    const later = new Date(Date.now() + 10_000).toISOString();
    const view = nextJob(store(), later);
    assert.ok(view.held.some((x) => x.job === c1.record_id));
    void authB;
  } finally {
    h.cleanup();
  }
});

test('reconcile_batches records completed batches once every admitted investigation is decided', () => {
  const h = makeHarness();
  try {
    const eid = 's2';
    const { inv } = admittedInvestigation(h, eid, { impact: 'low', executable: false, method: 'hypothesis' });
    const store = () => h.ws.store(eid, true);
    const auth = store().mustHead(inv.record_id, 'investigation').body.authorization!;
    assert.deepEqual(h.auditor.do(eid, 'reconcile_batches').changed, []);
    const pkt = h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd' }).packet;
    const invHead = head(h, eid, inv.record_id);
    h.screen.do(eid, 'record_decision', {
      decision_kind: 'dispose_investigation',
      reviewed: [pkt, invHead],
      display_receipt: display(h, eid, [pkt, invHead]),
      inputs: { packet: pkt, investigation: invHead, disposition: 'accepted', severity: 'Low', evidence_route: 'code_argument', finding: { title: 't', mechanism: 'm', impact: 'i' } },
      rationale: 'r',
      rationale_authorship: 'human_written',
    });
    const res = h.auditor.do(eid, 'reconcile_batches');
    assert.deepEqual(res.changed.map((c: { to: string }) => c.to), ['completed']);
    assert.equal(store().mustHead(auth.record_id, 'work_authorization').body.status, 'completed');
  } finally {
    h.cleanup();
  }
});

test('FR-19: discovery agent jobs are held while the review queue is at capacity', () => {
  const h = makeHarness();
  try {
    const eid = 's3';
    const { inv } = admittedInvestigation(h, eid, { impact: 'low', executable: false, method: 'hypothesis' });
    const store = () => h.ws.store(eid, true);
    // Stage a queued planner job directly (production agent jobs come from request_job with a context manifest).
    const auth = store().mustHead(inv.record_id, 'investigation').body.authorization!;
    const snap = store().heads('engagement')[0].body.active_snapshot!;
    store().commit({
      records: [
        {
          type: 'job',
          base_revision: 0,
          body: {
            authorization: auth,
            context_manifest: null,
            role: 'planner',
            purpose: 'agent',
            adapter: { name: 'reference_agent', version: 'fixture', descriptor: 'fixture' },
            operation: 'run',
            args: {},
            snapshot: store().headRef(snap.record_id),
            fixture: null,
            input_digest: 'sha256:' + '1'.repeat(64),
            investigation: null,
            variant: null,
            limits: LIMITS,
            reservation: { spend: 0, runtime_seconds: 10 },
            lineage: null,
            guard_removal: null,
            status: 'queued',
            attempts: [],
          },
        },
      ],
      events: [],
      principal: { channel: 'controller', principal: 'test-fixture' },
      origin: { operation: 'test_fixture', request_id: 'f', job: null, attempt: null, decision: null },
      now: new Date().toISOString(),
      message: 'fixture planner job',
    });
    h.ws.noteCommitted(eid);
    assert.ok(nextJob(store(), new Date().toISOString()).next, 'dispatchable while the queue has room');
    // Capacity 3 in the fixture policy: fill it with packets.
    h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, inv.record_id), claim: 'c', decision_requested: 'd' });
    for (const q of ['q1', 'q2']) {
      const i = h.auditor.do(eid, 'submit_proposal', { kind: 'investigation', body: { method: 'hypothesis', question: q, audit_units: store().mustHead(inv.record_id, 'investigation').body.audit_units.map((u) => store().headRef(u.record_id)), potential_impact: 'low', executable: false } }).investigation;
      authorizeBatch(h, eid, i);
      h.auditor.do(eid, 'submit_review_packet', { investigation: head(h, eid, i.record_id), claim: 'c', decision_requested: 'd' });
    }
    const view = nextJob(store(), new Date().toISOString());
    assert.equal(view.review_queue.discovery_paused, true);
    assert.equal(view.next, null);
    assert.match(view.held[0].reason, /discovery paused/);
  } finally {
    h.cleanup();
  }
});
