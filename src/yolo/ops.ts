import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { YOLO_GOVERNOR_PRINCIPAL } from '../core/values.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import { requirePolicy, textOrNull } from '../decision/common.ts';
import { pidAlive, procStartTime } from '../runner/sandbox.ts';
import type { YoloCycle, YoloRunBody } from '../schema/records.ts';
import { parseCharter } from './charter.ts';
import { renderYoloReport } from './report.ts';

// Yolo run records (operator request 2026-10-14): only the governor writes them, on the controller channel. Every
// update re-renders the run report from the store, so the report says what the records say.

function requireGovernor(ctx: OpContext): void {
  if (ctx.principal.principal !== YOLO_GOVERNOR_PRINCIPAL) fail('permission_denied', 'only the yolo governor records yolo runs');
}

/** The governor's process still runs (same pid and start time: a reused pid is not the governor). */
export function runProcessAlive(p: YoloRunBody['process']): boolean {
  return pidAlive(p.pid) && procStartTime(p.pid) === p.start_time;
}

function runningRun(ctx: OpContext, id: unknown) {
  if (typeof id !== 'string') fail('invalid_request', 'run is required');
  const run = ctx.store.mustHead(id, 'yolo_run');
  if (run.body.status !== 'running') fail('invalid_request', `yolo run ${id} is ${run.body.status}`);
  return run;
}

/** Stage a new revision of a run, with the report rendered from the store and the new body. */
function reviseRun(ctx: OpContext, id: string, update: (b: YoloRunBody) => YoloRunBody): Ref {
  return ctx.tx.revise(id, 'yolo_run', (b) => {
    const next = update(b);
    const report = ctx.archive.put(renderYoloReport(ctx.store, id, next, ctx.now));
    ctx.tx.blob(report);
    return { ...next, report };
  });
}

defineOperation<{ charter: unknown }>({
  name: 'start_yolo_run',
  channels: ['controller'],
  mutating: true,
  handler(ctx, p) {
    requireGovernor(ctx);
    const charter = parseCharter(p?.charter);
    requirePolicy(ctx.store);
    // One governor per engagement. A run still marked running whose process is gone was interrupted.
    const interrupted: Ref[] = [];
    for (const r of ctx.store.heads('yolo_run').filter((x) => x.body.status === 'running')) {
      if (runProcessAlive(r.body.process)) fail('invalid_request', `yolo run ${r.record_id} is still running (process ${r.body.process.pid}); stop it first with harness yolo stop`, { ref: r.record_id });
      interrupted.push(reviseRun(ctx, r.record_id, (b) => ({ ...b, status: 'interrupted', ended_at: ctx.now, exit_reason: `interrupted: process ${b.process.pid} ended without closing the run` })));
    }
    const frozen = ctx.archive.putJson(charter);
    ctx.tx.blob(frozen);
    const until = new Date(Date.parse(ctx.now) + charter.duration_seconds * 1000).toISOString();
    const run = ctx.tx.create('yolo_run', {
      charter: frozen,
      status: 'running',
      started_at: ctx.now,
      until,
      ended_at: null,
      exit_reason: null,
      process: { pid: process.pid, start_time: procStartTime(process.pid) },
      discovery_authorization: null,
      cycles: [],
      report: null,
    });
    return { yolo_run: run, until, interrupted };
  },
});

defineOperation<{ run: string; discovery_authorization?: Ref; cycle?: YoloCycle }>({
  name: 'record_yolo_progress',
  channels: ['controller'],
  mutating: true,
  handler(ctx, p) {
    requireGovernor(ctx);
    const run = runningRun(ctx, p?.run);
    if (p.discovery_authorization) ctx.store.get(p.discovery_authorization, 'work_authorization');
    const c = p.cycle;
    if (c) {
      if (c.work_proposal) ctx.store.get(c.work_proposal, 'work_proposal');
      if (c.authorization) ctx.store.get(c.authorization, 'work_authorization');
      for (const d of c.flow_reviews ?? []) ctx.store.get(d, 'human_decision');
      for (const i of c.admitted ?? []) ctx.store.get(i, 'investigation');
    }
    const ref = reviseRun(ctx, run.record_id, (b) => ({
      ...b,
      discovery_authorization: p.discovery_authorization ?? b.discovery_authorization,
      cycles: c ? [...b.cycles.filter((x) => x.n !== c.n), c].sort((x, y) => x.n - y.n) : b.cycles,
    }));
    return { yolo_run: ref };
  },
});

defineOperation<{ run: string; status: 'completed' | 'stopped' | 'failed'; exit_reason: string }>({
  name: 'end_yolo_run',
  channels: ['controller'],
  mutating: true,
  handler(ctx, p) {
    requireGovernor(ctx);
    const run = runningRun(ctx, p?.run);
    if (!['completed', 'stopped', 'failed'].includes(p.status)) fail('invalid_request', 'status must be completed, stopped or failed');
    const exit = textOrNull(p.exit_reason);
    if (!exit) fail('invalid_request', 'an exit reason is required');
    const ref = reviseRun(ctx, run.record_id, (b) => ({ ...b, status: p.status, ended_at: ctx.now, exit_reason: exit }));
    return { yolo_run: ref };
  },
});
