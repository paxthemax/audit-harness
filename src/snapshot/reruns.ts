import { isHarnessError } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { defineOperation, type Controller } from '../controller/controller.ts';
import { onPremiseRevised } from '../decision/premise.ts';
import { authorizationIsCurrent } from '../decision/work.ts';
import { recomputeFreshness } from './change.ts';
import { attachProbeJob, pendingReruns } from './probes.ts';

// Loop L6 wiring. After a change, every PoC and property is rerun automatically on the new snapshot
// within the engagement's standing `revalidation` authorization; reruns beyond that allowance wait for
// authorization (design/harness-state-and-execution.md, "Evidence invalidation and revision changes").
// A premise revision triggers the same probe re-evaluation as a code change.

onPremiseRevised((ctx, reason) => recomputeFreshness(ctx, reason));

defineOperation<{ probe: string; job: Ref }>({
  name: 'attach_probe_job',
  channels: ['controller'],
  mutating: true,
  handler(ctx, p) {
    const probe = ctx.store.mustHead(p.probe, 'dependency_probe');
    const job = ctx.store.get(p.job, 'job');
    if (job.body.purpose !== 'probe') return { attached: false, reason: 'not a probe job' };
    if (probe.body.job?.record_id === job.record_id) return { attached: true, probe: { record_id: probe.record_id, revision: probe.revision } };
    return { attached: true, probe: attachProbeJob(ctx, probe.record_id, { record_id: job.record_id, revision: job.revision }) };
  },
});

export interface RerunSchedule {
  scheduled: { probe: Ref; job: Ref }[];
  waiting: string | null;
}

/** Queue rerun jobs for pending witness/property probes under the current revalidation authorization. */
export function scheduleReruns(controller: Controller, engagementId: string): RerunSchedule {
  const store = controller.ws.store(engagementId, true);
  const specs = pendingReruns(store);
  if (!specs.length) return { scheduled: [], waiting: null };
  const now = controller.now();
  const auth = store
    .heads('work_authorization')
    .filter((a) => a.body.kind === 'revalidation' && authorizationIsCurrent(a.body, now))
    .at(-1);
  if (!auth) return { scheduled: [], waiting: `${specs.length} rerun(s) wait for a revalidation authorization` };
  const sys = controller.system();
  const scheduled: RerunSchedule['scheduled'] = [];
  for (const spec of specs) {
    try {
      const res = sys.do(engagementId, 'request_job', {
        authorization: { record_id: auth.record_id, revision: auth.revision },
        purpose: 'probe',
        adapter: spec.adapter,
        operation: spec.operation,
        args: spec.args,
        snapshot: spec.snapshot,
        fixture: spec.fixture,
        limits: spec.limits,
      });
      sys.do(engagementId, 'attach_probe_job', { probe: spec.probe.record_id, job: res.job });
      scheduled.push({ probe: spec.probe, job: res.job });
    } catch (e) {
      if (isHarnessError(e)) return { scheduled, waiting: `rerun of ${spec.probe.record_id} waits: ${e.message}` };
      throw e;
    }
  }
  return { scheduled, waiting: null };
}
