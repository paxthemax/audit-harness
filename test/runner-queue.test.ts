import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeHarness, newEngagement } from './helpers.ts';
import { commandAdapter, registerAdapter } from '../src/runner/adapters.ts';
import { runJob, runQueue } from '../src/runner/runner.ts';
import { COUNTER_SOL, contextFor, foundryProject, stageAuthorization, stageInvestigation, stageInvestigationState, stagePolicy, stageSnapshot } from './runner-fixtures.ts';

// Queue order across batches (scheduler), discovery holds, and chained worker outbox requests.

registerAdapter(commandAdapter({ name: 'bash_queue', version: '1', executable: '/usr/bin/bash', purposes: ['experiment', 'agent'] }));

function setup() {
  const h = makeHarness();
  const eid = newEngagement(h);
  const snapshot = stageSnapshot(h, eid, foundryProject(join(h.dir, 'project'), { 'src/Counter.sol': COUNTER_SOL }));
  return { h, eid, snapshot };
}

test('jobs of two batch authorizations are interleaved, and a held discovery job is reported', async () => {
  const { h, eid, snapshot } = setup();
  try {
    stagePolicy(h, eid, { live_exploitable_class: 'unfixed', approved_providers: [], data_classes: ['source'] }, { review_queue: 1, clarification_queue: 1, decisions_per_day: 10 });
    const invA = stageInvestigation(h, eid, 'Question A');
    const invB = stageInvestigation(h, eid, 'Question B');
    const ready = stageInvestigation(h, eid, 'Awaiting review');
    stageInvestigationState(h, eid, ready, { work_state: 'ready_for_review' });
    const authA = stageAuthorization(h, eid, { kind: 'batch', investigations: [invA, ready], tools: ['bash_queue'] });
    const authB = stageAuthorization(h, eid, { kind: 'batch', investigations: [invB], tools: ['bash_queue'] });
    const job = (auth: typeof authA, inv: typeof invA, tag: string) =>
      h.auditor.do(eid, 'request_job', { authorization: auth, purpose: 'experiment', adapter: 'bash_queue', snapshot, investigation: inv, args: { argv: ['-c', `echo ${tag}`] }, limits: { runtime_seconds: 60 } }).job.record_id;
    const a1 = job(authA, invA, 'a1');
    const a2 = job(authA, invA, 'a2');
    const b1 = job(authB, invB, 'b1');
    const b2 = job(authB, invB, 'b2');
    // Discovery (planner) work waits while the review queue is at capacity.
    const planner = h.auditor.do(eid, 'request_job', {
      authorization: authA,
      purpose: 'agent',
      role: 'planner',
      adapter: 'bash_queue',
      snapshot,
      investigation: ready,
      context_manifest: contextFor(h, eid, 'planner', ready),
      args: { argv: ['-c', 'echo plan'] },
    }).job.record_id;
    const q = await runQueue(h.controller, eid);
    assert.equal(q.stopped, 'idle');
    assert.deepEqual(q.ran.map((r) => r.job), [a1, b1, a2, b2]);
    assert.equal(q.held.length, 1);
    assert.equal(q.held[0].job, planner);
    assert.match(q.held[0].reason, /discovery paused/);
    assert.equal(h.ws.store(eid, true).mustHead(planner, 'job').body.status, 'queued');
  } finally {
    h.cleanup();
  }
});

test('outbox entries chain through $result placeholders; a placeholder to a refused entry is invalid', async () => {
  const { h, eid, snapshot } = setup();
  try {
    const inv = stageInvestigation(h, eid);
    const batch = stageAuthorization(h, eid, { kind: 'batch', investigations: [inv], tools: ['bash_queue'] });
    const exp = (tag: string, extra: Record<string, unknown> = {}) => ({
      operation: 'request_job',
      payload: { authorization: batch.record_id, purpose: 'experiment', adapter: 'bash_queue', snapshot, investigation: inv, args: { argv: ['-c', `echo ${tag}`] }, limits: { runtime_seconds: 60 }, ...extra },
    });
    const entries: Record<string, unknown> = {
      '001-experiment': exp('first'),
      '002-repair': exp('repaired', { lineage: { $result: '001-experiment', path: 'job' } }),
      '003-plan': { operation: 'prepare_work', payload: {} },
      '004-dependent': exp('dependent', { lineage: { $result: '003-plan', path: 'job' } }),
    };
    const script = Object.entries(entries)
      .map(([name, v]) => `printf '%s' '${JSON.stringify(v)}' > /outbox/${name}.json`)
      .join('; ');
    const agent = h.auditor.do(eid, 'request_job', {
      authorization: batch,
      purpose: 'agent',
      role: 'investigator',
      adapter: 'bash_queue',
      snapshot,
      investigation: inv,
      context_manifest: contextFor(h, eid, 'investigator', inv),
      args: { argv: ['-c', script] },
    });
    await runJob(h.controller, eid, agent.job.record_id);
    const s = h.ws.store(eid, true);
    const jobs = s.heads('job').filter((j) => j.body.purpose === 'experiment');
    assert.equal(jobs.length, 2);
    const [first, repaired] = jobs;
    assert.deepEqual(repaired.body.lineage, { record_id: first.record_id, revision: 1 });
    const refusals = s.events().filter((e) => e.kind === 'worker_request_refused').map((e) => [e.result.file, e.result.status, e.result.reason]);
    assert.equal(refusals.length, 2);
    assert.equal(refusals[0][0], '003-plan.json');
    assert.deepEqual(refusals[1].slice(0, 2), ['004-dependent.json', 'invalid']);
    assert.match(String(refusals[1][2]), /depends on a refused entry/);
  } finally {
    h.cleanup();
  }
});
