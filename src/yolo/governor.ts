import { setTimeout as sleep } from 'node:timers/promises';
import { functionCoverage } from '../comprehension/compositions.ts';
import { fail, isHarnessError } from '../core/errors.ts';
import { isUnknown, type ArtifactRef, type Ref } from '../core/refs.ts';
import { impactRank, type UnattendedDecisionKind, type YoloRunStatus } from '../core/values.ts';
import type { Controller, Session } from '../controller/controller.ts';
import { roleProfile } from '../controller/roles.ts';
import { engagement, requirePolicy } from '../decision/common.ts';
import { challengeRequired, linkedEvidence, replayStatus } from '../decision/packets.ts';
import { authorizationIsCurrent } from '../decision/work.ts';
import { refOf } from '../report/derive.ts';
import { ensureBroker } from '../review/broker.ts';
import { ProviderBroker, reconcileOnStart, runQueue } from '../runner/index.ts';
import type { Limits, RecordEnvelope, YoloCycle } from '../schema/records.ts';
import type { AuthorizeDraft } from '../screen/flows.ts';
import type { DecisionOutcome, TrustedScreen } from '../screen/screen.ts';
import { authorizeWorkUnattended, openUnattendedScreen, recordFlowReviewUnattended } from '../screen/unattended.ts';
import { buildJobSpec } from '../snapshot/register.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { parseCharter, YOLO_ROLES, type YoloCapabilities, type YoloCharter, type YoloRole } from './charter.ts';
import { missingPacketReason, runPackets } from './report.ts';

// The yolo governor (operator request 2026-10-14): an agentic run of the harness with no human in the loop. Role
// agents do the work (comprehension, planning, investigation, challenge) in the sandbox through the provider broker;
// the governor is deterministic harness code that sequences them, authorizes each cycle's work through the
// unattended approver within the operator's charter, and records the run. Each cycle is discovery -> test -> report:
//
//   discovery  comprehension rounds, lead generators, a planner round; the planner's batch (or, when it proposes none
//              that can be admitted, the highest-impact proposed questions) is admitted by an unattended authorization
//   test       per admitted investigation: investigator rounds, a clean replay of a demonstrated violation, a challenger
//              round, a packet round that submits the review packet
//   report     the controller re-renders the run report from records
//
// The governor never disposes an investigation, answers a clarification, confirms an interpretation, approves an
// export or closes the engagement: candidate findings wait for the auditor. Its state is derived from records, so a
// run interrupted mid-way is continued by the next one while its authorizations are still valid.

/** Proposed wait before re-running the queue while another process runs a job in the workspace (one job at a time). */
export const PROPOSED_RUNNER_BUSY_WAIT_MS = 30_000;
/** Proposed number of records a task lists by name (the context carries the records themselves). */
const TASK_LIST_CAP = 40;

const NO_HUMAN =
  'No human is available until the run ends: do not wait for answers. Raise a clarification only for a consequential missing premise; it blocks the work it names until a human answers.';

export interface YoloOptions {
  /** Stop request (SIGINT/SIGTERM in `harness yolo run`): the running job is stopped and the run ends `stopped`. */
  signal?: AbortSignal;
  /** One line per step, for the operator's log. */
  progress?: (line: string) => void;
}

export interface YoloResult {
  run: Ref;
  status: YoloRunStatus;
  exit_reason: string;
  cycles: number;
  packets: number;
  candidate_findings: number;
  report: ArtifactRef | null;
}

/** Ends the run with this status and exit reason. */
class Stop {
  readonly status: 'completed' | 'stopped' | 'failed';
  readonly exit: string;
  constructor(status: 'completed' | 'stopped' | 'failed', exit: string) {
    this.status = status;
    this.exit = exit;
  }
}

type Step =
  | { kind: 'investigate'; round: number }
  | { kind: 'replay'; experiment: RecordEnvelope<'job'> }
  | { kind: 'challenge' }
  | { kind: 'packet' }
  | { kind: 'done'; why: string };

type Decided = { ok: true; result: Record<string, unknown> } | { ok: false; code: string };

const byId = (a: { record_id: string }, b: { record_id: string }) => a.record_id.localeCompare(b.record_id, 'en', { numeric: true });
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}...` : s);

function refValue(v: unknown, what: string): Ref {
  if (v && typeof v === 'object' && 'record_id' in v && 'revision' in v && typeof v.record_id === 'string' && typeof v.revision === 'number') {
    return { record_id: v.record_id, revision: v.revision };
  }
  fail('invalid_request', `${what} is not a record reference`);
}

/**
 * Run the yolo loop on one engagement until the charter's cycles, its deadline or a stop condition end it. Refuses to
 * start (nothing recorded) when the engagement, the delegation, the providers or the charter do not allow the run.
 */
export async function runYolo(controller: Controller, eid: string, rawCharter: unknown, opts: YoloOptions = {}): Promise<YoloResult> {
  const charter = parseCharter(rawCharter);
  preflight(controller, eid, charter);
  const started = controller.governor().do<{ yolo_run: Ref; until: string; interrupted: Ref[] }>(eid, 'start_yolo_run', { charter });
  const g = new Governor(controller, eid, started.yolo_run.record_id, started.until, charter, opts);
  g.log(`yolo run ${started.yolo_run.record_id} started; runs until ${started.until}`);
  for (const r of started.interrupted) g.log(`yolo run ${r.record_id} was marked interrupted (its process had ended)`);
  let stop: Stop;
  let error: unknown = null;
  try {
    stop = await g.run();
  } catch (e) {
    error = e;
    stop = new Stop('failed', `error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = g.finish(stop);
  if (error) throw error;
  return result;
}

function preflight(controller: Controller, eid: string, charter: YoloCharter): void {
  const s = controller.ws.store(eid, true);
  const eng = engagement(s);
  if (eng.body.closure_status !== 'open') fail('permission_denied', `engagement ${eid} is ${eng.body.closure_status}`);
  const policy = requirePolicy(s);
  if (!eng.body.active_snapshot) fail('invalid_request', `register a target snapshot first (harness snapshot register <path> -e ${eid})`);
  const ctl = s.heads('control_state')[0];
  if (ctl?.body.paused) fail('permission_denied', `engagement ${eid} is paused (${ctl.body.reason}); resume it first`);
  const kinds: UnattendedDecisionKind[] = ['authorize_work', ...(charter.flow_reviews === 'unattended' ? (['record_flow_review'] as const) : [])];
  const missing = kinds.filter((k) => !controller.ws.unattendedKinds(eid).includes(k));
  if (missing.length) {
    fail('permission_denied', `the governor authorizes work through the unattended approver: delegate ${missing.join(', ')} first (harness unattended enable -e ${eid} --kinds ${kinds.join(',')})`);
  }
  const problems: string[] = [];
  for (const p of new Set([...charter.discovery.capabilities.providers, ...charter.batch.capabilities.providers])) {
    if (!policy.data_policy.approved_providers.includes(p)) problems.push(`provider ${p} is not approved by the engagement's data policy`);
  }
  const snap = s.mustHead(eng.body.active_snapshot.record_id, 'target_snapshot');
  if (!snap.body.inventory) {
    const build = snap.body.build;
    if (!isUnknown(build) && build.status === 'failed') problems.push(`the active snapshot's build failed (${build.job.record_id}); fix the target or register a new snapshot`);
    else if (!charter.discovery.capabilities.tools.includes('forge_build')) {
      problems.push('the active snapshot has no completed build: add forge_build to discovery.capabilities.tools (and forge_test for the project tests), or build it first');
    }
  }
  ensureBroker(controller, charter.live_providers, { timeoutMs: charter.agents.call_timeout_seconds * 1000 });
  const broker = ProviderBroker.active()!;
  const notLive = charter.live_providers.filter((p) => !broker.liveExploitableProviders.has(p));
  if (notLive.length) problems.push(`the provider broker already running in this process does not approve ${notLive.join(', ')} for live-exploitable material`);
  if (broker.timeoutMs !== charter.agents.call_timeout_seconds * 1000) {
    problems.push(`the provider broker already running in this process limits a call to ${broker.timeoutMs / 1000} s, not the charter's call_timeout_seconds ${charter.agents.call_timeout_seconds}`);
  }
  for (const role of YOLO_ROLES) {
    const caps = role === 'comprehension' || role === 'planner' ? charter.discovery.capabilities : charter.batch.capabilities;
    const model = charter.agents.models[role];
    const serving = caps.providers.filter((n) => broker.provider(n)?.models.includes(model));
    if (!serving.length) problems.push(`the ${role} model ${model} is not offered by a provider its authorization lists (${caps.providers.join(', ') || 'none'})`);
    else if (!serving.some((n) => charter.live_providers.includes(n))) {
      problems.push(`the ${role} model ${model} runs on ${serving.join(', ')}, which live_providers does not list; ${role} contexts carry live-exploitable material`);
    }
  }
  if (problems.length) fail('invalid_request', `the yolo run cannot start: ${problems.join('; ')}`, { details: { problems } });
}

/** The next step of an investigation's pipeline, derived from the jobs already requested under its authorization. */
function nextStep(s: RecordStore, inv: RecordEnvelope<'investigation'>, authId: string, rounds: number): Step {
  const jobs = s.heads('job').filter((j) => j.body.investigation?.record_id === inv.record_id && j.body.authorization.record_id === authId).sort(byId);
  const agents = jobs.filter((j) => j.body.purpose === 'agent');
  const ch = agents.findIndex((j) => j.body.role === 'challenger');
  const before = (ch < 0 ? agents : agents.slice(0, ch)).filter((j) => j.body.role === 'investigator').length;
  if (ch < 0 && before < rounds) return { kind: 'investigate', round: before + 1 };
  // A clean replay comes before the challenge: positions written before later evidence are stale.
  const experiment = ch < 0 && !jobs.some((j) => j.body.purpose === 'replay') ? violationExperiment(s, inv.record_id) : null;
  if (experiment) return { kind: 'replay', experiment };
  const needsChallenge = challengeRequired(inv.body.potential_impact.effective, null);
  if (needsChallenge && ch < 0) return { kind: 'challenge' };
  if (needsChallenge && !challengerPosition(s, inv.record_id)) return { kind: 'done', why: 'the challenger round produced no position; the packet would be incomplete' };
  const packetRounds = ch < 0 ? before - rounds : agents.slice(ch + 1).filter((j) => j.body.role === 'investigator').length;
  if (packetRounds < 1) return { kind: 'packet' };
  return { kind: 'done', why: `no packet after the packet round (${missingPacketReason(s, inv)})` };
}

/** The latest experiment of the main claim whose trusted-runner evidence demonstrated the violation. */
function violationExperiment(s: RecordStore, invId: string): RecordEnvelope<'job'> | null {
  const evidence = linkedEvidence(s, invId)
    .filter((e) => e.body.producer === 'trusted_runner' && e.body.eligible && e.body.structured_result?.result_type === 'counterexample')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || byId(a, b));
  for (const e of evidence.reverse()) {
    const job = e.body.job ? s.head<'job'>(e.body.job.record_id) : undefined;
    if (job?.body.purpose !== 'experiment') continue;
    if (job.body.variant && s.head<'scenario_variant'>(job.body.variant.record_id)?.body.linked_claim_id) continue;
    return job;
  }
  return null;
}

function challengerPosition(s: RecordStore, invId: string): RecordEnvelope<'position'> | undefined {
  return s.heads('position').filter((p) => p.body.role === 'challenger' && p.body.investigation.record_id === invId).sort(byId).at(-1);
}

class Governor {
  private readonly controller: Controller;
  private readonly gov: Session;
  private readonly eid: string;
  private readonly runId: string;
  private readonly until: string;
  private readonly charter: YoloCharter;
  private readonly signal: AbortSignal | undefined;
  private readonly progress: (line: string) => void;
  private failures = 0;
  private lastFailure = '';
  private cycle: YoloCycle | null = null;
  private unattended: TrustedScreen | null = null;
  private sourceCache: { tree: string; paths: string[] } | null = null;

  constructor(controller: Controller, eid: string, runId: string, until: string, charter: YoloCharter, opts: YoloOptions) {
    this.controller = controller;
    this.gov = controller.governor();
    this.eid = eid;
    this.runId = runId;
    this.until = until;
    this.charter = charter;
    this.signal = opts.signal;
    this.progress = opts.progress ?? (() => undefined);
  }

  private store(): RecordStore {
    return this.controller.ws.store(this.eid, true);
  }

  private now(): string {
    return this.controller.now();
  }

  log(line: string): void {
    this.progress(`[${this.now()}] ${line}`);
  }

  /** A line for the operator's log and for the cycle's notes in the run record and report. */
  private note(line: string): void {
    this.cycle?.notes.push(line);
    this.log(line);
  }

  private persist(): void {
    if (this.cycle) this.gov.do(this.eid, 'record_yolo_progress', { run: this.runId, cycle: this.cycle });
  }

  /** Throws the stop that applies now: an operator stop, a pause, the deadline, or too many failed agent attempts. */
  private checkpoint(): void {
    if (this.signal?.aborted) throw new Stop('stopped', 'stop requested');
    const ctl = this.store().heads('control_state')[0];
    if (ctl?.body.paused) throw new Stop('stopped', `engagement paused: ${ctl.body.reason}`);
    if (Date.parse(this.now()) >= Date.parse(this.until)) throw new Stop('completed', 'deadline');
    if (this.failures >= this.charter.max_consecutive_failures) {
      throw new Stop('failed', `agent_failures: ${this.failures} consecutive failed agent attempts (last: ${this.lastFailure})`);
    }
  }

  async run(): Promise<Stop> {
    reconcileOnStart(this.controller, this.eid);
    try {
      for (let n = 1; n <= this.charter.max_cycles; n++) {
        this.checkpoint();
        this.cycle = { n, started_at: this.now(), ended_at: null, work_proposal: null, authorization: null, flow_reviews: [], admitted: [], notes: [] };
        this.log(`cycle ${n}: discovery`);
        this.persist();
        const found = await this.discover();
        this.persist();
        this.log(`cycle ${n}: test`);
        const worked = await this.test();
        this.cycle.ended_at = this.now();
        this.persist();
        if (!found.batch && !worked) return new Stop('completed', found.why);
      }
      return new Stop('completed', 'max_cycles');
    } catch (e) {
      if (e instanceof Stop) return e;
      throw e;
    }
  }

  /** Close the run: cancel what it queued and never ran, record the end and the final report. */
  finish(stop: Stop): YoloResult {
    this.log(`stopping: ${stop.status} (${stop.exit})`);
    const s = this.store();
    const run = s.mustHead(this.runId, 'yolo_run').body;
    const auths = new Set([run.discovery_authorization, ...run.cycles.map((c) => c.authorization), this.cycle?.authorization ?? null].filter((r): r is Ref => !!r).map((r) => r.record_id));
    for (const j of s.heads('job').filter((x) => x.body.status === 'queued' && auths.has(x.body.authorization.record_id))) {
      try {
        this.gov.do(this.eid, 'cancel', { job: j.record_id, reason: `yolo run ${this.runId} ended (${stop.exit})` });
      } catch (e) {
        if (!isHarnessError(e)) throw e;
        this.note(`${j.record_id} stays queued: ${e.message}`);
      }
    }
    if (this.cycle && !this.cycle.ended_at) {
      this.cycle.ended_at = this.now();
      this.persist();
    }
    this.gov.do(this.eid, 'end_yolo_run', { run: this.runId, status: stop.status, exit_reason: stop.exit });
    const ended = this.store().mustHead(this.runId, 'yolo_run');
    const packets = runPackets(this.store(), ended.body);
    return {
      run: refOf(ended),
      status: ended.body.status,
      exit_reason: stop.exit,
      cycles: ended.body.cycles.length,
      packets: packets.length,
      candidate_findings: packets.filter((p) => p.candidate).length,
      report: ended.body.report,
    };
  }

  // --- discovery -----------------------------------------------------------------------------------

  private async discover(): Promise<{ batch: boolean; why: string }> {
    const s = this.store();
    const capacity = requirePolicy(s).capacity.review_queue;
    const ready = s.heads('investigation').filter((i) => i.body.work_state === 'ready_for_review').length;
    if (ready >= capacity) {
      this.note(`discovery paused: ${ready} packet(s) await review (review queue capacity ${capacity})`);
      return { batch: false, why: 'review_capacity_reached' };
    }
    const disc = await this.discoveryAuthorization();
    if ('why' in disc) return { batch: false, why: disc.why };
    await this.ensureBuilt(disc.auth);
    const rounds = this.cycle!.n === 1 ? this.charter.discovery.seed_rounds : this.charter.discovery.rounds_per_cycle;
    for (let i = 1; i <= rounds; i++) {
      const units = this.units();
      const coverage = functionCoverage(this.store());
      const task = comprehensionTask(this.runId, this.cycle!.n, i, rounds, units.length, coverage.unmapped);
      if (!(await this.round('comprehension', disc.auth, task, null, units))) break;
    }
    const leads = this.call<{ created: Ref[]; ran: string[] }>('generate_leads', {}, 'lead generators');
    if (leads) this.note(`lead generators: ${leads.created.length} new lead(s); ran ${leads.ran.join(', ') || 'none'}`);
    const planner = await this.round('planner', disc.auth, this.plannerTask(), null, this.plannerContext());
    const chosen = this.select(planner);
    if (!chosen.investigations.length) {
      const proposed = this.store().heads('investigation').filter((i) => i.body.work_state === 'proposed' && !i.body.disposition).length;
      this.note(
        proposed
          ? `none of the ${proposed} proposed investigation(s) can be admitted (each needs audit units${this.charter.flow_reviews === 'reviewed_only' ? ' that all have a recorded flow review' : ''})`
          : 'no proposed investigation is left to admit',
      );
      return { batch: false, why: planner ? 'nothing_to_do' : 'discovery_exhausted' };
    }
    return this.admit(chosen);
  }

  /** The run's one intake authorization, created on first use; refused or spent ends discovery for the run. */
  private async discoveryAuthorization(): Promise<{ auth: string } | { why: string }> {
    const s = this.store();
    const existing = s.mustHead(this.runId, 'yolo_run').body.discovery_authorization;
    if (existing) {
      const a = s.mustHead(existing.record_id, 'work_authorization');
      if (authorizationIsCurrent(a.body, this.now())) return { auth: a.record_id };
      this.note(`discovery authorization ${a.record_id} is ${a.body.status}: no further discovery`);
      return { why: 'discovery_exhausted' };
    }
    const d = this.charter.discovery;
    const prop = this.call<{ work_proposal: Ref }>('prepare_work', { kind: 'intake', requested_capabilities: d.capabilities, estimates: { spend: d.limits.spend, runtime_seconds: d.limits.runtime_seconds } }, 'discovery proposal');
    if (!prop) return { why: 'discovery_refused' };
    this.checkpoint();
    const out = await this.decide('discovery authorization', () =>
      authorizeWorkUnattended(this.screen(), prop.work_proposal.record_id, this.authorizeDraft(d.limits, d.capabilities)),
    );
    if (!out.ok) return { why: out.code === 'budget_exhausted' ? 'budget_exhausted' : `discovery_refused: ${out.code}` };
    const auth = refValue(out.result.work_authorization, 'work_authorization');
    this.gov.do(this.eid, 'record_yolo_progress', { run: this.runId, discovery_authorization: auth });
    this.note(`discovery authorization ${auth.record_id} (unattended; valid until ${this.until})`);
    return { auth: auth.record_id };
  }

  /** Build the active snapshot (and run the project's tests) when no build completed yet. */
  private async ensureBuilt(authId: string): Promise<void> {
    const snapId = engagement(this.store()).body.active_snapshot!.record_id;
    if (this.store().mustHead(snapId, 'target_snapshot').body.inventory) return;
    this.log(`building snapshot ${snapId}`);
    const build = this.call<{ job: Ref }>('request_job', { authorization: authId, ...buildJobSpec(this.store().headRef(snapId)) }, 'snapshot build');
    if (build) await this.runUntilDone(build.job.record_id);
    if (!this.store().mustHead(snapId, 'target_snapshot').body.inventory) {
      throw new Stop('failed', `snapshot ${snapId} has no completed build${build ? ` (job ${build.job.record_id})` : ''}; fix the target or register a new snapshot`);
    }
    let tests = '';
    if (this.charter.discovery.capabilities.tools.includes('forge_test')) {
      const t = this.call<{ job: Ref }>('request_job', { authorization: authId, purpose: 'baseline_tests', adapter: 'forge_test', snapshot: this.store().headRef(snapId), args: {} }, 'project test suite');
      if (t) tests = `; project tests ${t.job.record_id} ${(await this.runUntilDone(t.job.record_id)).body.status}`;
    }
    this.note(`snapshot ${snapId} built${tests}`);
  }

  private units(): Ref[] {
    return this.store()
      .heads('audit_unit')
      .filter((u) => u.body.review_status !== 'excluded')
      .sort(byId)
      .map(refOf);
  }

  /**
   * Questions that can join a batch now: those an agent or the auditor proposed ahead of the lead generators'
   * heuristic leads, then highest potential impact first, multi-step or cross-flow ones ahead.
   */
  private admissible(s: RecordStore): RecordEnvelope<'investigation'>[] {
    const reviewedOnly = this.charter.flow_reviews === 'reviewed_only';
    const unitOf = (r: Ref) => s.head<'audit_unit'>(r.record_id);
    const multi = (i: RecordEnvelope<'investigation'>) => i.body.audit_units.length > 1 || i.body.audit_units.some((u) => ['composition', 'system_invariant'].includes(unitOf(u)?.body.kind ?? ''));
    const generated = (i: RecordEnvelope<'investigation'>) => s.history(i.record_id)[0]?.origin.operation === 'generate_leads';
    return s
      .heads('investigation')
      .filter(
        (i) =>
          i.body.work_state === 'proposed' &&
          !i.body.disposition &&
          i.body.audit_units.length > 0 &&
          i.body.audit_units.every((u) => {
            const unit = unitOf(u);
            return !!unit && unit.body.review_status !== 'excluded' && (!reviewedOnly || unit.body.review_status === 'reviewed');
          }),
      )
      .sort(
        (a, b) =>
          Number(generated(a)) - Number(generated(b)) ||
          impactRank(b.body.potential_impact.effective) - impactRank(a.body.potential_impact.effective) ||
          Number(multi(b)) - Number(multi(a)) ||
          byId(a, b),
      );
  }

  /** Units, admissible questions (highest-ranked first) and discrepancies; the context builder bounds the count. */
  private plannerContext(): Ref[] {
    const s = this.store();
    return [...this.units(), ...this.admissible(s).map(refOf), ...s.heads('behavioral_discrepancy').sort(byId).map(refOf)];
  }

  private plannerTask(): string {
    const s = this.store();
    const k = this.charter.batch.investigations;
    const reviewedOnly = this.charter.flow_reviews === 'reviewed_only';
    const reviewed = s.heads('audit_unit').filter((u) => u.body.review_status === 'reviewed').map((u) => `${u.record_id} "${clip(u.body.name, 60)}"`);
    const proposed = this.admissible(s)
      .slice(0, TASK_LIST_CAP)
      .map((i) => `- ${i.record_id} [${i.body.method}, ${i.body.potential_impact.effective}, units ${i.body.audit_units.map((u) => u.record_id).join(' ')}]: ${clip(i.body.question)}`);
    const done = s
      .heads('investigation')
      .filter((i) => i.body.work_state !== 'proposed' || i.body.disposition)
      .sort(byId)
      .slice(-TASK_LIST_CAP)
      .map((i) => `- ${clip(i.body.question)}`);
    return [
      `Yolo run ${this.runId}, cycle ${this.cycle!.n}: planning round. ${NO_HUMAN}`,
      `This cycle admits at most ${k} investigation(s). ${
        reviewedOnly
          ? `Only questions whose audit units all have a recorded flow review can be admitted; reviewed units: ${reviewed.join(', ') || 'none'}.`
          : 'Audit units without a flow review get an unattended one (labelled, no function marked reviewed) so their questions can be admitted.'
      }`,
      proposed.length ? `Proposed questions that can be admitted, highest potential impact first (the records are in your context):\n${proposed.join('\n')}` : 'No proposed question can be admitted yet.',
      done.length ? `Investigated or under review already (do not propose these again):\n${done.join('\n')}` : '',
      `Propose new precise, falsifiable investigation questions where coverage is thin: each names its audit units, the guarantee at stake, the method and a potential-impact estimate; include a multi-step or cross-flow question. Then call prepare_batch with the ${k} investigation(s) to run next, by expected value; proposed questions above count.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * The cycle's batch: the planner's when all of it can be admitted; else the questions the planner round proposed,
   * then the highest-ranked admissible ones.
   */
  private select(planner: RecordEnvelope<'job'> | null): { investigations: RecordEnvelope<'investigation'>[]; proposal: Ref | null } {
    const s = this.store();
    const admissible = this.admissible(s);
    const ok = new Set(admissible.map((i) => i.record_id));
    const proposal = planner ? s.heads('work_proposal').filter((w) => w.body.kind === 'batch' && w.origin.job?.record_id === planner.record_id).sort(byId).at(-1) : undefined;
    const picked = (proposal?.body.investigations ?? []).filter((r) => ok.has(r.record_id)).map((r) => s.mustHead(r.record_id, 'investigation'));
    if (!picked.length && admissible.length) {
      this.note(`${proposal ? `planner proposal ${proposal.record_id} names no question that can be admitted` : `planner round ${planner?.record_id ?? '(none)'} prepared no batch`}; taking the questions it proposed, then the highest-ranked proposed questions`);
    }
    const fresh = planner ? admissible.filter((i) => s.history(i.record_id)[0]?.origin.job?.record_id === planner.record_id) : [];
    const chosen = (picked.length ? picked : [...fresh, ...admissible.filter((i) => !fresh.includes(i))]).slice(0, this.charter.batch.investigations);
    const exact =
      !!proposal &&
      proposal.body.investigations.length === chosen.length &&
      proposal.body.investigations.every((r) => chosen.some((c) => c.record_id === r.record_id && c.revision === r.revision));
    return { investigations: chosen, proposal: exact && proposal ? refOf(proposal) : null };
  }

  /** Unattended flow reviews (when the charter allows them), a proposal, and the cycle's unattended batch authorization. */
  private async admit(sel: { investigations: RecordEnvelope<'investigation'>[]; proposal: Ref | null }): Promise<{ batch: boolean; why: string }> {
    let invs = sel.investigations;
    if (this.charter.flow_reviews === 'unattended') {
      const s = this.store();
      const units = [...new Set(invs.flatMap((i) => i.body.audit_units.map((u) => u.record_id)))].filter((u) => s.mustHead(u, 'audit_unit').body.review_status !== 'reviewed');
      const refused = new Set<string>();
      for (const u of units) {
        this.checkpoint();
        const out = await this.decide(`unattended flow review of ${u}`, () => recordFlowReviewUnattended(this.screen(), u));
        if (!out.ok) {
          refused.add(u);
          continue;
        }
        const d = refValue(out.result.decision, 'decision');
        this.cycle!.flow_reviews.push(d);
        this.note(`unattended flow review of ${u} (${d.record_id}): batch gate lifted; no function marked reviewed`);
      }
      invs = invs.filter((i) => !i.body.audit_units.some((u) => refused.has(u.record_id)));
    }
    if (!invs.length) return { batch: false, why: 'flow_review_refused' };
    let proposal = invs.length === sel.investigations.length ? sel.proposal : null;
    if (!proposal) {
      const b = this.charter.batch;
      const r = this.call<{ work_proposal: Ref }>(
        'prepare_work',
        { kind: 'batch', investigations: invs.map(refOf), requested_capabilities: b.capabilities, estimates: { spend: b.limits.spend, runtime_seconds: b.limits.runtime_seconds } },
        'batch proposal',
      );
      if (!r) return { batch: false, why: 'nothing_to_do' };
      proposal = r.work_proposal;
    }
    this.cycle!.work_proposal = proposal;
    this.checkpoint();
    const id = proposal.record_id;
    const out = await this.decide(`batch authorization of ${id}`, () =>
      authorizeWorkUnattended(this.screen(), id, this.authorizeDraft(this.charter.batch.limits, this.charter.batch.capabilities)),
    );
    if (!out.ok) return { batch: false, why: out.code === 'review_capacity_reached' || out.code === 'budget_exhausted' ? out.code : `batch_refused: ${out.code}` };
    const auth = refValue(out.result.work_authorization, 'work_authorization');
    this.cycle!.authorization = auth;
    this.cycle!.admitted = Array.isArray(out.result.admitted) ? out.result.admitted.map((r) => refValue(r, 'admitted investigation')) : [];
    this.note(`batch ${auth.record_id} admits ${this.cycle!.admitted.map((r) => r.record_id).join(', ')} (unattended; valid until ${this.until})`);
    return { batch: true, why: '' };
  }

  // --- test ----------------------------------------------------------------------------------------

  /**
   * Work every open investigation of the yolo runs' current batches (this run's, and an interrupted run's). Returns how
   * many got a new job: an investigation that only waits (for a human answer, or after its packet round) is no work.
   */
  private async test(): Promise<number> {
    const s = this.store();
    const now = this.now();
    const work: { inv: string; auth: string }[] = [];
    const seen = new Set<string>();
    const runs = s.heads('yolo_run').sort((a, b) => Number(b.record_id === this.runId) - Number(a.record_id === this.runId) || byId(a, b));
    for (const c of runs.flatMap((r) => r.body.cycles)) {
      const auth = c.authorization ? s.mustHead(c.authorization.record_id, 'work_authorization') : null;
      if (!auth || !authorizationIsCurrent(auth.body, now)) continue;
      for (const r of auth.body.investigations) {
        const inv = s.mustHead(r.record_id, 'investigation');
        if (seen.has(inv.record_id) || inv.body.disposition || inv.body.authorization?.record_id !== auth.record_id) continue;
        if (['ready_for_review', 'closed'].includes(inv.body.work_state)) continue;
        seen.add(inv.record_id);
        work.push({ inv: inv.record_id, auth: auth.record_id });
      }
    }
    let progressed = 0;
    for (const w of work) if (await this.investigate(w.inv, w.auth)) progressed += 1;
    return progressed;
  }

  /** Run the investigation's pipeline as far as it goes; true when it requested at least one job. */
  private async investigate(invId: string, authId: string): Promise<boolean> {
    let progressed = false;
    const rounds = this.charter.batch.investigator_rounds;
    for (let guard = 0; guard < rounds + 4; guard++) {
      this.checkpoint();
      const s = this.store();
      const inv = s.mustHead(invId, 'investigation');
      if (inv.body.disposition || ['ready_for_review', 'closed'].includes(inv.body.work_state)) return progressed;
      if (inv.body.blocked_reason?.startsWith('clarification:')) {
        this.note(`${invId} waits for a human answer (${inv.body.blocked_reason})`);
        return progressed;
      }
      const step = nextStep(s, inv, authId, rounds);
      const ref = refOf(inv);
      let job: RecordEnvelope<'job'> | null;
      if (step.kind === 'done') {
        this.note(`${invId}: ${step.why}`);
        return progressed;
      } else if (step.kind === 'investigate') job = await this.round('investigator', authId, investigatorTask(this.runId, inv, step.round, rounds), ref);
      else if (step.kind === 'replay') job = await this.replay(inv, authId, step.experiment);
      else if (step.kind === 'challenge') job = await this.round('challenger', authId, challengerTask(this.runId, inv), ref);
      else job = await this.round('investigator', authId, packetTask(this.runId, s, inv), ref);
      if (!job) return progressed;
      progressed = true;
      const after = this.store().mustHead(invId, 'investigation');
      if (after.body.work_state === 'ready_for_review') this.note(`${invId} is ready for review: ${this.store().heads('review_packet').filter((p) => p.body.investigation.record_id === invId).sort(byId).at(-1)?.record_id ?? 'packet'}`);
    }
    return progressed;
  }

  /** A clean replay of a demonstrated violation: the same experiment, rerun by the trusted runner. */
  private async replay(inv: RecordEnvelope<'investigation'>, authId: string, exp: RecordEnvelope<'job'>): Promise<RecordEnvelope<'job'> | null> {
    this.checkpoint();
    const e = exp.body;
    const req = this.call<{ job: Ref }>(
      'request_job',
      {
        authorization: authId,
        purpose: 'replay',
        adapter: e.adapter.name,
        operation: e.operation,
        args: e.args,
        snapshot: e.snapshot,
        fixture: e.fixture,
        investigation: refOf(inv),
        variant: e.variant,
        limits: { runtime_seconds: e.limits.runtime_seconds },
      },
      `clean replay of ${exp.record_id}`,
    );
    if (!req) return null;
    const job = await this.runUntilDone(req.job.record_id);
    this.note(`${inv.record_id}: clean replay ${job.record_id} of ${exp.record_id}: ${replayStatus(this.store(), inv.record_id, true)}`);
    return job;
  }

  // --- jobs, decisions, calls ----------------------------------------------------------------------

  /**
   * One agent round: the role's context, the job, the queue. A failed round is not retried (an `outcome_unknown` call
   * may have run and been billed; a refusal before sending repeats): it counts toward the charter's failure limit.
   */
  private async round(role: YoloRole, authId: string, task: string, investigation: Ref | null, include: Ref[] = []): Promise<RecordEnvelope<'job'> | null> {
    this.checkpoint();
    const s = this.store();
    const what = `${role} round${investigation ? ` for ${investigation.record_id}` : ''}`;
    const ctx = this.call<{ context_manifest: ArtifactRef }>('build_context', { role: roleProfile(role).contextRole, investigation, include, source_paths: this.sources() }, `${what} context`);
    if (!ctx) return null;
    const req = this.call<{ job: Ref }>(
      'request_job',
      {
        authorization: authId,
        purpose: 'agent',
        adapter: 'reference_agent',
        role,
        snapshot: s.headRef(engagement(s).body.active_snapshot!.record_id),
        investigation,
        context_manifest: ctx.context_manifest,
        args: { task: this.guided(role, task), model: this.charter.agents.models[role], max_turns: this.charter.agents.max_turns, max_tokens: this.charter.agents.max_tokens },
        limits: { runtime_seconds: this.charter.agents.round_runtime_seconds },
      },
      what,
    );
    if (!req) return null;
    const job = await this.runUntilDone(req.job.record_id);
    const summary = this.roundSummary(job);
    this.note(`${what}: ${summary}`);
    if (job.body.status === 'completed') this.failures = 0;
    else if (job.body.status === 'failed') {
      this.failures += 1;
      this.lastFailure = `${what}: ${summary}`;
      this.checkpoint();
    }
    return job;
  }

  /** The task with the charter's guidance: the discovery focus for comprehension and planning, the notes for every role. */
  private guided(role: YoloRole, task: string): string {
    const focus = role === 'comprehension' || role === 'planner' ? this.charter.discovery.focus : [];
    const list = (title: string, lines: string[]) => (lines.length ? `${title}:\n${lines.map((l) => `- ${l}`).join('\n')}` : '');
    return [task, list("The operator's focus for this run", focus), list("The operator's notes", this.charter.agents.notes)].filter(Boolean).join('\n\n');
  }

  /** The job's latest attempt: status, the agent runtime's round summary, and outbox requests the controller refused. */
  private roundSummary(job: RecordEnvelope<'job'>): string {
    const s = this.store();
    const attRef = job.body.attempts.at(-1);
    const att = attRef ? s.head<'attempt'>(attRef.record_id) : undefined;
    const ev = att?.body.receipt ? s.tryGet<'evidence_artifact'>(att.body.receipt) : undefined;
    let round = '';
    try {
      const r: unknown = ev?.body.receipt ? JSON.parse(s.archive.getText(ev.body.receipt.stdout.artifact)) : null;
      if (r && typeof r === 'object' && 'format' in r && r.format === 'harness.agent-round/1' && 'stop' in r && 'turns' in r && 'queued' in r) {
        const queued = Array.isArray(r.queued) ? r.queued.length : 0;
        const brokerError = r.stop === 'broker_error' && 'final_text' in r ? `: ${String(r.final_text)}` : '';
        round = `${String(r.stop)}, ${String(r.turns)} turn(s), ${queued} request(s)${brokerError}`;
      }
    } catch {
      // No round summary (the runtime crashed before writing one); the attempt's reason says why.
    }
    const refused = s
      .events()
      .filter((e) => e.kind === 'worker_request_refused' && e.result.attempt === attRef?.record_id)
      .map((e) => `${String(e.result.operation ?? 'unparsed')} ${String(e.result.code ?? 'invalid')}`);
    const reason = att?.body.reason && job.body.status !== 'completed' ? `; ${att.body.reason}` : '';
    return `${job.record_id} ${job.body.status}${round ? ` (${round})` : ''}${reason}${refused.length ? `; refused: ${refused.join(', ')}` : ''}`;
  }

  /** Run the queue until the job ran; waits while another process holds the runner. */
  private async runUntilDone(jobId: string): Promise<RecordEnvelope<'job'>> {
    for (;;) {
      const r = await runQueue(this.controller, this.eid, { signal: this.signal });
      const job = this.store().mustHead(jobId, 'job');
      if (job.body.status !== 'queued' && job.body.status !== 'running') return job;
      if (r.stopped === 'stop_unconfirmed') throw new Stop('failed', 'stop_unconfirmed: a stopped attempt has no confirmed termination; new work is refused');
      this.checkpoint();
      const skipped = r.skipped.find((k) => k.job === jobId);
      if (job.body.status === 'running' || (skipped && /one job at a time/.test(skipped.reason))) {
        this.log(`runner busy (${skipped?.reason ?? `${jobId} is running in another process`}); waiting`);
        await sleep(PROPOSED_RUNNER_BUSY_WAIT_MS, undefined, { signal: this.signal }).catch(() => undefined);
        continue;
      }
      const held = r.held.find((h) => h.job === jobId);
      this.note(`job ${jobId} did not run: ${skipped ? `${skipped.code}: ${skipped.reason}` : held ? held.reason : `queue stopped (${r.stopped})`}`);
      return job;
    }
  }

  private screen(): TrustedScreen {
    return (this.unattended ??= openUnattendedScreen({ ws: this.controller.ws, key: this.controller.ws.readSecret('auditor.key'), engagement: this.eid, controller: this.controller }).screen);
  }

  private async decide(what: string, decision: () => Promise<DecisionOutcome>): Promise<Decided> {
    try {
      const out = await decision();
      if (out.status === 'decided') return { ok: true, result: out.result };
      this.note(`${what} refused: ${out.status === 'refused' ? out.error.message : 'left undecided'}`);
      return { ok: false, code: out.status === 'refused' ? out.error.code : 'undecided' };
    } catch (e) {
      if (!isHarnessError(e)) throw e;
      this.note(`${what} refused: ${e.message}`);
      return { ok: false, code: e.code };
    }
  }

  /** A governor operation; a refusal is noted and returns null (a pause stops the run). */
  private call<R>(operation: string, payload: unknown, what: string): R | null {
    try {
      return this.gov.do<R>(this.eid, operation, payload);
    } catch (e) {
      if (!isHarnessError(e)) throw e;
      this.note(`${what} refused: ${e.message}`);
      this.checkpoint();
      return null;
    }
  }

  /** The terms of every authorization the run records: the charter's limits, valid from now until the run ends. */
  private authorizeDraft(limits: Limits, capabilities: YoloCapabilities): AuthorizeDraft {
    return { limits, capabilities, validity: { from: this.now(), until: this.until }, interrupt_conditions: [`yolo run ${this.runId}: no new work after ${this.until}`] };
  }

  /**
   * In-scope Solidity sources of the active snapshot (policy scope minus exclusions), then the charter's reference
   * paths (for example test deployment helpers a PoC reuses), for every agent context.
   */
  private sources(): string[] {
    const s = this.store();
    const snap = s.mustHead(engagement(s).body.active_snapshot!.record_id, 'target_snapshot');
    if (this.sourceCache?.tree === snap.body.tree.artifact) return this.sourceCache.paths;
    const policy = requirePolicy(s);
    const files = Object.keys(s.archive.getTree(snap.body.tree.artifact).files).sort();
    const scope = policy.scope.map((p) => resolvePolicyPath(p, snap.body.source.origin_path, files));
    const exclusions = policy.exclusions.map((e) => resolvePolicyPath(e.item, snap.body.source.origin_path, files));
    const kept = files.filter((p) => p.endsWith('.sol') && !exclusions.some((e) => underPath(p, e)));
    const scoped = kept.filter((p) => scope.some((sc) => underPath(p, sc)));
    if (!scoped.length) this.note(`no snapshot file matches the policy scope (${policy.scope.join(', ')}); agents get every Solidity file outside the exclusions`);
    const paths = scoped.length ? scoped : kept;
    const listed = new Set(paths);
    for (const raw of this.charter.agents.reference_paths) {
      const ref = raw.replace(/^\.\//, '').replace(/\/+$/, '');
      const matched = files.filter((p) => p.endsWith('.sol') && underPath(p, ref));
      if (!matched.length) this.note(`reference path ${raw} matches no Solidity file of the snapshot`);
      for (const p of matched) {
        if (listed.has(p)) continue;
        listed.add(p);
        paths.push(p);
      }
    }
    this.sourceCache = { tree: snap.body.tree.artifact, paths };
    return this.sourceCache.paths;
  }
}

/** `path` is `prefix` or lies below it; the empty prefix is the whole snapshot. */
function underPath(path: string, prefix: string): boolean {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * A policy path (scope or exclusion) in the snapshot's own paths. A policy may name paths from the repository root
 * while the snapshot was registered from a subdirectory (`source.origin_path`): when the path as written matches no
 * snapshot file, the longest leading part that repeats the end of the origin path is dropped, so
 * `sources/bold/contracts/src` under `.../sources/bold/contracts` is `src` (an empty result is the whole snapshot).
 */
export function resolvePolicyPath(path: string, originPath: string, files: string[]): string {
  const parts = path.replace(/^\.\//, '').split('/').filter(Boolean);
  const literal = parts.join('/');
  if (files.some((f) => underPath(f, literal))) return literal;
  const origin = originPath.split('/').filter(Boolean);
  for (let k = Math.min(parts.length, origin.length); k > 0; k--) {
    if (parts.slice(0, k).every((p, i) => p === origin[origin.length - k + i])) return parts.slice(k).join('/');
  }
  return literal;
}

// --- tasks --------------------------------------------------------------------------------------------

function comprehensionTask(run: string, cycle: number, round: number, rounds: number, units: number, unmapped: string[]): string {
  return [
    `Yolo run ${run}, cycle ${cycle}: comprehension round ${round} of ${rounds}. ${NO_HUMAN}`,
    units ? `${units} audit unit(s) exist (the records are in your context): extend them or add what is missing; never duplicate one.` : 'No audit unit exists yet.',
    unmapped.length ? `In-scope functions no audit unit maps (${unmapped.length}): ${unmapped.slice(0, 2 * TASK_LIST_CAP).join(', ')}${unmapped.length > 2 * TASK_LIST_CAP ? ', ...' : ''}.` : '',
    'Map each complete value flow as an audit unit with every Contract.function it touches, its entry points and state writers; add compositions of flows that write the same store, and system invariants. Anchor implementation statements to source, and record what you could not observe as gaps.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function investigatorTask(run: string, inv: RecordEnvelope<'investigation'>, round: number, rounds: number): string {
  return [
    `Yolo run ${run}: investigation ${inv.record_id}, investigator round ${round} of ${rounds}. ${NO_HUMAN}`,
    `Question (${inv.body.method}, potential impact ${inv.body.potential_impact.effective}): ${inv.body.question}`,
    round === 1
      ? 'Establish the full causal path and the strongest countercondition. Record a scenario variant (complete causal sequence, every setup power the fixture uses), submit a Foundry PoC fixture and request the experiment; a test that expects the violation asserts that it happens. Run the attack tests and their controls in one experiment with an expectation for every test it selects: an experiment whose only result is no violation counts as refuting evidence.'
      : 'Continue from the evidence in your context: record the outcome trusted-runner evidence supports for each variant, repair a failing fixture, or test the next permitted variant.',
    'Do not submit the review packet in this round: a clean replay and an independent challenge come first.',
  ].join('\n\n');
}

function challengerTask(run: string, inv: RecordEnvelope<'investigation'>): string {
  return [
    `Yolo run ${run}: challenge investigation ${inv.record_id} independently. ${NO_HUMAN}`,
    `Question (potential impact ${inv.body.potential_impact.effective}): ${inv.body.question}`,
    'Check its prerequisites from source, review every declared setup power (review_setup_powers), record your prerequisite review (record_prerequisite_review), then submit your position. Do not request experiments in this round: name any distinguishing check in your position, so that it stays current for the packet.',
  ].join('\n\n');
}

function packetTask(run: string, s: RecordStore, inv: RecordEnvelope<'investigation'>): string {
  const pending = inv.body.variants.map((v) => s.mustHead(v.record_id, 'scenario_variant')).filter((v) => v.body.outcome === null);
  const ch = challengerPosition(s, inv.record_id);
  const replay = replayStatus(s, inv.record_id, false);
  const replayLine = {
    succeeded: 'succeeded: the trusted runner reproduced the violation from the snapshot and the fixture',
    failed: 'failed: the replay did not reproduce the violation',
    unavailable: 'unavailable: the replayed fixture overrides target files, or its receipt is incomplete',
    pending: 'none ran',
    not_required: 'none ran: no experiment demonstrated the violation',
  }[replay];
  return [
    `Yolo run ${run}: investigation ${inv.record_id}, packet round. Testing and the challenge are done. ${NO_HUMAN}`,
    `Question (potential impact ${inv.body.potential_impact.effective}): ${inv.body.question}`,
    [
      `1. Record the outcome of every scenario variant that has none, from trusted-runner evidence (record_variant_outcome): ${pending.map((v) => `{"record_id": "${v.record_id}", "revision": ${v.revision}}`).join(', ') || 'none pending'}.`,
      '2. Submit a fresh author position (submit_author_position).',
      `3. Call submit_review_packet with your claim, proposed disposition and rationale, author_position set to the handle from step 2, and ${
        ch ? `challenger_position {"record_id": "${ch.record_id}", "revision": ${ch.revision}}` : 'no challenger_position (none is required at this potential impact)'
      }.`,
    ].join('\n'),
    `Clean replay: ${replayLine}. A proposed accepted at potential impact medium or above needs a succeeded clean replay; without one, propose another disposition and say what is missing.`,
    'Do not propose variants or request experiments in this round: newer work makes the positions stale and the packet is refused.',
  ].join('\n\n');
}
