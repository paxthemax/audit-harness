import { fail, HarnessError } from '../core/errors.ts';
import { randomToken } from '../core/hash.ts';
import { refKey, type Ref } from '../core/refs.ts';
import { DECISION_KINDS, DEFAULT_ATTACKER_CHARTER, type RationaleAuthorship } from '../core/values.ts';
import { Controller, getOperation, type Session } from '../controller/controller.ts';
import type { Workspace } from '../controller/workspace.ts';
import type { EngagementPolicy, Limits, RecordEnvelope, RecordType } from '../schema/records.ts';
import { captureText, unitRef, type CapturePurpose } from '../capture/capture.ts';
import { captureProgramDigest, screenProgramDigest } from '../capture/program.ts';
import { runQueue } from '../runner/index.ts';
import { DisplayLog, implementedUnitsOf, presentRecords, WITHHELD_NOTICE } from '../screen/display.ts';
import {
  authorizeRequest,
  DEFAULT_TRUSTED_ROLE_PREMISE,
  flowReviewRequest,
  LIMIT_KEYS,
  MANDATORY_POLICY_FIELDS,
  policyFromDraft,
  refOf,
  scopePolicyRequest,
  showFlowReview,
  showWorkProposal,
  type AuthorizeDraft,
} from '../screen/flows.ts';
import { heading, show } from '../screen/io.ts';
import {
  buildPacketModel,
  PACKET_SECTIONS,
  PacketReview,
  packetDecisionFromInputs,
  packetDecisionRequest,
  packetTemplate,
  printSection,
  SECTION_TITLES,
  type PacketSectionId,
} from '../screen/packet.ts';
import { fullRecordLines } from '../screen/render.ts';
import { TrustedScreen, type DecisionRequest } from '../screen/screen.ts';
import { silentIO, type SilentIO } from '../screen/unattended.ts';
import { ensureBroker } from './broker.ts';
import { engagementStatus } from './overview.ts';
import { authorizeTemplate, flowReviewTemplate, recordTemplate, scopePolicyTemplate } from './templates.ts';

// Agent review session (operator decision 2026-10-14): an agent (omp, Claude Code, any MCP host) presents pending
// decisions to the auditor, discusses them and records them, instead of the interactive terminal screen. It reuses the
// trusted screen's model, rendering and submission (the same TrustedScreen class on a non-interactive IO), so what is
// presented, what must be presented before deciding (evidence-first for potential High/Critical packets) and which
// inputs a decision takes are the screen's. Decisions are recorded on the screen channel with the principal
// `agent-session` and the rationale authorship the agent reports. Nothing binds or proves the auditor's participation;
// the provenance is labelled. Every refusal is a HarnessError; nothing is printed.

export interface AgentClient {
  name: string;
  version: string;
}

export interface PendingDecision {
  id: string;
  decision_kind: string;
  title: string;
  potential_impact: string | null;
  lines: string[];
}

export interface Presentation {
  /** Record id presented. */
  id: string;
  /** 'packet' | 'flow_review' | 'work_authorization' | 'scope_and_policy' | 'record'. */
  kind: string;
  /** Canonical text, deceptive characters rendered visibly (the screen's renderers). */
  text: string;
  /** JSON skeleton of the `decision` object `decide` expects for this item. */
  template: Record<string, unknown> | null;
  /** Packets: sections presented so far in this session, in order. */
  presented: string[];
  /** Packets: sections still to present before deciding. */
  remaining: string[];
}

export interface DecideArgs {
  /** Item to decide (pkt-…, unit-…, wprop-…, eng-…); omit for a generic decision. */
  id?: string;
  /** Generic decision kind when no item handler applies. */
  kind?: string;
  /** Generic: records bound by the decision, `id` or `id@rev` (each presented in this session). */
  records?: string[];
  /** Generic: decision-bearing operation (default: the kind's own operation, else record_decision). */
  operation?: string;
  /** Kind-specific inputs (see the presentation's template). */
  decision: Record<string, unknown>;
  rationale: string;
  rationale_authorship: 'human_written' | 'agent_drafted_unedited' | 'agent_drafted_edited';
  agent_draft?: string | null;
}

export interface DecideResult {
  decision: Ref;
  display_receipt: Ref;
  result: Record<string, unknown>;
  commit: string | null;
  conditional_on: Ref[];
}

/** A display log that also keeps the rendered records, so IMPLEMENTED content can be receipted when presented. */
class PresentationLog extends DisplayLog {
  readonly shown: RecordEnvelope[] = [];

  rendered(env: RecordEnvelope | Ref): void {
    super.rendered(env);
    if ('body' in env) this.shown.push(env);
  }
}

interface ItemBase {
  screen: TrustedScreen;
  io: SilentIO;
  log: PresentationLog;
  /** `id@revision` presented; a newer head starts a new item (a re-review). */
  at: string;
  /** IMPLEMENTED records already receipted at presentation. */
  receipted: Set<string>;
}

type Item = ItemBase &
  (
    | { kind: 'packet'; review: PacketReview }
    | { kind: 'flow_review'; unit: RecordEnvelope<'audit_unit'>; comparisons: RecordEnvelope<'behavioral_comparison'>[] | null }
    | { kind: 'work_authorization'; proposal: RecordEnvelope<'work_proposal'>; investigations: RecordEnvelope<'investigation'>[] | null }
    | { kind: 'scope_and_policy'; engagement: RecordEnvelope<'engagement'>; shown: boolean }
  );

const ITEM_KINDS: readonly string[] = ['dispose_investigation', 'record_flow_review', 'authorize_work', 'accept_scope_and_policy'];
const REREVIEW = ['stale_dependency', 'display_required', 'revision_conflict'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(d: Record<string, unknown>, allowed: string[], what: string): void {
  const extra = Object.keys(d).filter((k) => !allowed.includes(k));
  if (extra.length) fail('invalid_request', `${what} takes ${allowed.join(', ')}; refused: ${extra.join(', ')}`);
}

function stringList(v: unknown, path: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) fail('invalid_request', `${path} must be a list of non-empty strings`);
  return (v as string[]).map((x) => x.trim());
}

export class AgentReviewSession {
  readonly ws: Workspace;
  readonly controller: Controller;
  readonly client: AgentClient | null;
  /** Screen-channel session whose decisions carry the principal `agent-session`. */
  readonly agent: Session;
  /** Auditor-channel session for non-decision operations. */
  readonly auditor: Session;
  readonly sessionId: string;
  private readonly clock: () => string;
  private readonly items = new Map<string, Item>();
  /** Records presented in full in this session (`engagement/id@rev`), what a generic decision may bind. */
  private readonly presented = new Map<string, RecordEnvelope>();

  constructor(opts: { ws: Workspace; controller?: Controller; client?: AgentClient | null; clock?: () => string }) {
    this.ws = opts.ws;
    this.controller = opts.controller ?? new Controller(opts.ws);
    this.client = opts.client ?? null;
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.sessionId = `agent-${randomToken(8)}`;
    const key = this.ws.readSecret('auditor.key');
    const client = this.client ? `${this.client.name}/${this.client.version}` : 'unknown/unknown';
    this.agent = this.controller.agentSession(key, `harness-agent-session ${screenProgramDigest()} ${client}`, this.sessionId);
    this.auditor = this.controller.auditor(key);
  }

  // --- overview ------------------------------------------------------------------------------------

  engagements(): { id: string; name: string; closure_status: string; active_snapshot: string | null; decisions_needed: number }[] {
    return this.ws.engagementIds().map((id) => {
      const s = engagementStatus(this.ws, this.auditor, id);
      const e = s.engagement.body;
      return { id, name: e.name, closure_status: e.closure_status, active_snapshot: e.active_snapshot ? refKey(e.active_snapshot) : null, decisions_needed: s.decisions.length };
    });
  }

  overview(engagement: string): { engagement: string; title: string; decisions: PendingDecision[]; work: string[]; gaps: { count: number; first: string[] } } {
    const s = engagementStatus(this.ws, this.auditor, engagement);
    const decisions = s.decisions.map((d) => {
      const lines: string[] = [];
      if (!d.id) lines.push('Nothing to present yet.');
      else if (d.kind === null) lines.push(`Not a decision: read it with harness_present ${d.id}.`);
      else if (d.bind.length) lines.push(`Present and bind: ${d.bind.join(', ')}`);
      if (d.kind === 'answer_clarification') lines.push("Relay the auditor's answer with harness_capture (purpose clarification_answer) and bind the captured input.");
      lines.push(`Interactive alternative: ${d.command}`);
      return { id: d.id ?? '', decision_kind: d.kind ?? 'none', title: d.what, potential_impact: d.potential_impact, lines };
    });
    return { engagement, title: s.title, decisions, work: s.work, gaps: { count: s.gaps.length, first: s.gaps.slice(0, 20) } };
  }

  // --- presenting ----------------------------------------------------------------------------------

  /** Read one record (head, or an exact `id@revision`) through the screen channel. */
  private read(engagement: string, spec: string): RecordEnvelope {
    const m = /^(.+)@(\d+)$/.exec(spec);
    const payload = m ? { refs: [{ record_id: m[1], revision: Number(m[2]) }] } : { ids: [spec] };
    const env = this.agent.do<{ records: RecordEnvelope[] }>(engagement, 'read_records', payload).records[0];
    if (!env) fail('not_found', `${spec} is not a record of ${engagement}`);
    return env;
  }

  private heads<T extends RecordType>(engagement: string, type: T): RecordEnvelope<T>[] {
    return this.agent.do<{ records: RecordEnvelope<T>[] }>(engagement, 'read_records', { type, limit: 5000 }).records;
  }

  /** The item presenting `head`, kept for the life of the session; a newer revision starts a new one. */
  private item(engagement: string, head: RecordEnvelope): Item | null {
    const key = `${engagement}/${head.record_id}`;
    const at = refKey(head);
    const prev = this.items.get(key);
    if (prev && prev.at === at) return prev;
    const io = silentIO();
    const screen = new TrustedScreen(this.agent, engagement, io, this.clock);
    const log = new PresentationLog(this.clock);
    screen.log = log;
    const base: ItemBase = { screen, io, log, at, receipted: new Set() };
    let item: Item;
    switch (head.type) {
      case 'review_packet':
        item = { ...base, kind: 'packet', review: new PacketReview(buildPacketModel(screen, refOf(head)), log) };
        break;
      case 'audit_unit':
        item = { ...base, kind: 'flow_review', unit: head as RecordEnvelope<'audit_unit'>, comparisons: null };
        break;
      case 'work_proposal':
        item = { ...base, kind: 'work_authorization', proposal: head as RecordEnvelope<'work_proposal'>, investigations: null };
        break;
      case 'engagement':
        item = { ...base, kind: 'scope_and_policy', engagement: head as RecordEnvelope<'engagement'>, shown: false };
        break;
      default:
        return null;
    }
    this.items.set(key, item);
    return item;
  }

  /** IMPLEMENTED content shown during a presentation is receipted at once (as the CLI does), naming its units. */
  private receipt(engagement: string, item: Item): void {
    const fresh = item.log.shown.filter((e) => implementedUnitsOf(e).length && !item.receipted.has(refKey(e)));
    const unique = [...new Map(fresh.map((e) => [refKey(e), e])).values()];
    if (!unique.length) return;
    presentRecords(this.agent, engagement, unique, `agent:${item.kind}`);
    for (const e of unique) item.receipted.add(refKey(e));
  }

  present(engagement: string, id: string, opts: { section?: string } = {}): Presentation {
    const head = this.read(engagement, id);
    const item = /@\d+$/.test(id) ? null : this.item(engagement, head);
    if (!item) {
      if (opts.section) fail('invalid_request', 'sections apply to review packets only');
      return this.presentRecord(engagement, head);
    }
    const from = item.io.text().length;
    const out: Presentation = { id: head.record_id, kind: item.kind, text: '', template: null, presented: [], remaining: [] };
    if (item.kind === 'packet') {
      this.presentPacket(item.screen, item.review, opts.section);
      out.template = packetTemplate(item.review.model);
      out.presented = [...new Set(item.log.sections.map((s) => s.section))];
      out.remaining = item.review.missingBeforeDeciding();
    } else {
      if (opts.section) fail('invalid_request', 'sections apply to review packets only');
      if (item.kind === 'flow_review') {
        item.comparisons = showFlowReview(item.screen, item.unit);
        const open = item.unit.body.functions.filter((f) => !f.reviewed).map((f) => f.name);
        item.io.write(`\nFunctions not yet reviewed: ${open.join(', ') || 'none'}\n`);
        out.template = flowReviewTemplate(item.unit);
      } else if (item.kind === 'work_authorization') {
        item.investigations = [...showWorkProposal(item.screen, item.proposal)];
        heading(item.io, 'Finite resource limits (operator choices; nothing is defaulted)');
        item.io.write(`  Every one is required: ${LIMIT_KEYS.join(', ')}\n`);
        out.template = authorizeTemplate(item.proposal);
      } else {
        this.presentScope(item.screen, item.engagement);
        item.shown = true;
        out.template = scopePolicyTemplate(item.engagement);
      }
    }
    this.receipt(engagement, item);
    out.text = item.io.text().slice(from);
    return out;
  }

  private presentPacket(screen: TrustedScreen, review: PacketReview, section: string | undefined): void {
    const m = review.model;
    screen.banner(`Review packet ${m.packet.record_id}@${m.packet.revision} — investigation ${m.investigation.record_id}@${m.investigation.revision}`);
    show(screen.io, m.status_lines.join('\n') + '\n');
    screen.io.write(
      m.evidence_first
        ? `Evidence-first order: potential impact ${m.max_impact}. The proposed disposition stays hidden until the evidence, challenger and evidence-quality sections are presented.\n`
        : `Combined layout: potential impact ${m.max_impact} is below High.\n`,
    );
    if (section !== undefined) {
      if (!(PACKET_SECTIONS as readonly string[]).includes(section)) fail('invalid_request', `section must be one of ${PACKET_SECTIONS.join(', ')}`);
      const id = section as PacketSectionId;
      const s = review.open(id);
      if (!s) fail('display_required', `section ${id} is ${review.lockReason(id)}`, { details: { present_first: review.missingEvidenceFirst() } });
      printSection(screen.io, s, Infinity);
      return;
    }
    // Every available section in canonical order: for potential High/Critical the proposed disposition becomes
    // available only once evidence, challenger and evidence quality were presented, so it always comes after them.
    for (const id of PACKET_SECTIONS) {
      const s = review.open(id);
      if (s) printSection(screen.io, s, Infinity);
      else screen.io.write(`\n[${PACKET_SECTIONS.indexOf(id) + 1}] ${SECTION_TITLES[id]} — LOCKED: ${review.lockReason(id)}\n`);
    }
  }

  private presentScope(screen: TrustedScreen, eng: RecordEnvelope<'engagement'>): void {
    screen.banner('Accept scope and policy');
    screen.render(eng);
    screen.log.opened('engagement');
    heading(screen.io, 'Threat model: default attacker charter (DEC-008 Q-015); keep or exclude (with a reason) each capability');
    for (const c of DEFAULT_ATTACKER_CHARTER.capabilities) screen.io.write(`  - ${c}\n`);
    heading(screen.io, "Trusted-role premise (an ASSUMPTION, printed in the report's assumptions section)");
    show(screen.io, `  ${eng.body.policy?.trusted_role_premise ?? DEFAULT_TRUSTED_ROLE_PREMISE}\n`);
    screen.io.write(`Mandatory policy fields: ${MANDATORY_POLICY_FIELDS.join(', ')}\n`);
  }

  /** Any other record: rendered in full, with the CLI's receipting and read-first withholding of IMPLEMENTED content. */
  private presentRecord(engagement: string, env: RecordEnvelope): Presentation {
    const io = silentIO();
    const p = presentRecords(this.agent, engagement, [env], 'agent:record');
    if (p.withheld.length) {
      io.write(`${env.type} ${env.record_id}@${env.revision} — ${WITHHELD_NOTICE}\n`);
      return { id: env.record_id, kind: 'record', text: io.text(), template: null, presented: [], remaining: [] };
    }
    heading(io, `${env.type} ${env.record_id}@${env.revision}`);
    show(io, fullRecordLines(env).join('\n') + '\n');
    this.presented.set(`${engagement}/${refKey(env)}`, env);
    const template = recordTemplate(env, (type) => this.heads(engagement, type));
    return { id: env.record_id, kind: 'record', text: io.text(), template, presented: [], remaining: [] };
  }

  // --- deciding ------------------------------------------------------------------------------------

  decide(engagement: string, args: DecideArgs): DecideResult {
    if (!isObject(args)) fail('invalid_request', 'decide takes { id?, kind?, records?, operation?, decision, rationale, rationale_authorship, agent_draft? }');
    if (!isObject(args.decision)) fail('invalid_request', 'decision must be an object (see the presentation template)');
    if (typeof args.rationale !== 'string' || !args.rationale.trim()) fail('invalid_request', 'a rationale is required');
    if (typeof args.rationale_authorship !== 'string') fail('invalid_request', 'rationale_authorship is required');
    if (args.agent_draft !== undefined && args.agent_draft !== null && typeof args.agent_draft !== 'string') fail('invalid_request', 'agent_draft must be text or null');
    const head = args.id ? this.read(engagement, args.id) : null;
    if (!head || !['review_packet', 'audit_unit', 'work_proposal', 'engagement'].includes(head.type)) return this.decideGeneric(engagement, args);
    const key = `${engagement}/${head.record_id}`;
    const item = this.items.get(key);
    if (!item) fail('display_required', `${head.record_id} was not presented in this session; present it (harness_present) before deciding`);
    if (item.at !== refKey(head)) {
      this.items.delete(key);
      fail('stale_dependency', `${head.record_id} changed since it was presented (presented ${item.at}, current ${refKey(head)}); present it again and decide again`, {
        details: { changed: [{ ref: refOf(head), presented: item.at }] },
      });
    }
    const req = this.itemRequest(item, args.decision);
    try {
      return this.submit(item.screen, req, args);
    } catch (e) {
      // A re-review starts from a fresh display of the current revisions (as the screen offers it).
      if (e instanceof HarnessError && REREVIEW.includes(e.code)) this.items.delete(key);
      throw e;
    }
  }

  private itemRequest(item: Item, d: Record<string, unknown>): DecisionRequest {
    switch (item.kind) {
      case 'packet': {
        const missing = item.review.missingBeforeDeciding();
        if (missing.length) {
          fail('display_required', `present these sections before deciding: ${missing.join(', ')}`, { details: { missing } });
        }
        return packetDecisionRequest(item.review, packetDecisionFromInputs(item.review.model, d));
      }
      case 'flow_review': {
        if (!item.comparisons) fail('display_required', `present ${item.unit.record_id} before deciding`);
        onlyKeys(d, ['reviewed_functions', 'gaps'], 'a flow review');
        const open = item.unit.body.functions.filter((f) => !f.reviewed).map((f) => f.name);
        const fns = d.reviewed_functions === 'all' ? open : stringList(d.reviewed_functions, 'reviewed_functions');
        const unknown = fns.filter((f) => !open.includes(f));
        if (unknown.length) fail('invalid_request', `not an unreviewed function of ${item.unit.record_id}: ${unknown.join(', ')} (open: ${open.join(', ') || 'none'})`);
        return flowReviewRequest(item.unit, item.comparisons, stringList(d.gaps, 'gaps'), fns);
      }
      case 'work_authorization': {
        if (!item.investigations) fail('display_required', `present ${item.proposal.record_id} before deciding`);
        onlyKeys(d, ['limits', 'capabilities', 'validity', 'interrupt_conditions', 'keep', 'attacker_charter', 'audit_units'], 'a work authorization');
        const given = isObject(d.limits) ? d.limits : fail('invalid_request', `limits must set every limit: ${LIMIT_KEYS.join(', ')}`);
        onlyKeys(given, LIMIT_KEYS, 'limits');
        const limits = {} as Limits;
        const invalid: string[] = [];
        for (const k of LIMIT_KEYS) {
          const v = given[k];
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) limits[k] = v;
          else invalid.push(k);
        }
        if (invalid.length) fail('invalid_request', `every limit is a finite non-negative number (nothing is defaulted); missing or invalid: ${invalid.join(', ')}`);
        const ids = item.investigations.map((i) => i.record_id);
        const keep = d.keep === undefined ? ids : stringList(d.keep, 'keep');
        const foreign = keep.filter((k) => !ids.includes(k));
        if (foreign.length) fail('invalid_request', `keep lists investigations of the proposal only (${ids.join(', ') || 'none'}); refused: ${foreign.join(', ')}`);
        const kept = item.investigations.filter((i) => keep.includes(i.record_id)).map(refOf);
        const { limits: _limits, keep: _keep, ...rest } = d;
        return authorizeRequest(item.proposal, kept, limits, rest as AuthorizeDraft);
      }
      case 'scope_and_policy': {
        if (!item.shown) fail('display_required', `present ${item.engagement.record_id} before deciding`);
        onlyKeys(d, ['policy'], 'scope and policy');
        if (!isObject(d.policy)) fail('invalid_request', 'policy must be an object (see the presentation template)');
        const policy = policyFromDraft(d.policy as Partial<EngagementPolicy>);
        heading(item.io, 'Policy as it will be recorded');
        show(item.io, JSON.stringify(policy, null, 2) + '\n');
        item.log.opened('policy');
        return scopePolicyRequest(item.engagement, policy);
      }
    }
  }

  /** Any other kind: the bound records must have been presented in this session; inputs are passed as given. */
  private decideGeneric(engagement: string, args: DecideArgs): DecideResult {
    const kind = args.kind;
    if (!kind || !(DECISION_KINDS as readonly string[]).includes(kind)) fail('invalid_request', `kind must be one of ${DECISION_KINDS.join(', ')}`);
    if (ITEM_KINDS.includes(kind)) fail('invalid_request', `${kind} is decided through its item: give the id of the review packet, audit unit, work proposal or engagement`);
    const specs = args.records ?? (args.id ? [args.id] : []);
    if (!Array.isArray(specs) || !specs.length || specs.some((s) => typeof s !== 'string')) fail('invalid_request', 'records must list the records the decision binds (id or id@revision)');
    const own = getOperation(kind) ? kind : 'record_decision';
    const operation = args.operation ?? own;
    if (operation !== own && operation !== 'record_decision') fail('invalid_request', `${kind} is recorded with ${own}`);
    const screen = new TrustedScreen(this.agent, engagement, silentIO(), this.clock);
    const reviewed: Ref[] = [];
    const missing: string[] = [];
    for (const spec of specs) {
      const env = this.read(engagement, spec);
      const shown = this.presented.get(`${engagement}/${refKey(env)}`);
      if (!shown) missing.push(refKey(env));
      else {
        screen.log.rendered(shown);
        reviewed.push(refOf(shown));
      }
    }
    if (missing.length) fail('display_required', `present ${missing.join(', ')} (harness_present) before deciding`, { details: { not_presented: missing } });
    screen.log.opened('records');
    screen.log.opened('inputs');
    return this.submit(screen, { operation, decision_kind: kind, reviewed, inputs: args.decision, agent_draft: null, summary: [`Records: ${reviewed.map(refKey).join(', ')}`] }, args);
  }

  private submit(screen: TrustedScreen, req: DecisionRequest, args: DecideArgs): DecideResult {
    const o = screen.submitDecision(req, {
      rationale: args.rationale,
      authorship: args.rationale_authorship as RationaleAuthorship,
      agent_draft: args.agent_draft !== undefined ? args.agent_draft : req.agent_draft,
    });
    if (o.status === 'refused') throw o.error;
    if (o.status !== 'decided') fail('invalid_request', 'the decision was not recorded');
    for (const [k, item] of this.items) if (item.screen === screen) this.items.delete(k);
    return {
      decision: o.result.decision as Ref,
      display_receipt: o.display_receipt,
      result: o.result,
      commit: o.commit,
      conditional_on: (o.result.conditional_on as Ref[] | undefined) ?? [],
    };
  }

  // --- other auditor operations --------------------------------------------------------------------

  /** Request more work on a packet's investigation (a named distinguishing check); no disposition is recorded. */
  requestCheck(engagement: string, id: string, check: string): Record<string, unknown> {
    if (typeof check !== 'string' || !check.trim()) fail('invalid_request', 'name the missing distinguishing check');
    const env = this.read(engagement, id);
    if (env.type !== 'review_packet' && env.type !== 'investigation') fail('invalid_request', `${id} is neither a review packet nor an investigation`);
    // A packet names the investigation it was built for; the check goes to that investigation's current revision.
    const packet = env.type === 'review_packet' ? (env as RecordEnvelope<'review_packet'>) : null;
    const inv = this.read(engagement, packet ? packet.body.investigation.record_id : env.record_id);
    return this.agent.do(engagement, 'request_check', { investigation: refOf(inv), check: check.trim() });
  }

  /** Records through the auditor channel; IMPLEMENTED content is withheld in read-first mode, else receipted. */
  records(engagement: string, q: { type?: string; ids?: string[]; history?: boolean; limit?: number } = {}): { records: RecordEnvelope[]; withheld: string[] } {
    const payload: Record<string, unknown> = {};
    if (q.type) payload.type = q.type;
    if (q.ids) payload.ids = q.ids;
    if (q.history) payload.history = true;
    if (q.limit !== undefined) payload.limit = q.limit;
    const r = this.auditor.do<{ records: RecordEnvelope[] }>(engagement, 'read_records', payload);
    const p = presentRecords(this.auditor, engagement, r.records, 'agent:records');
    return { records: p.shown, withheld: p.withheld.map((w) => `${w.record_id}@${w.revision}`) };
  }

  /** A non-decision operation on the auditor channel (`engagement` null: the library scope). */
  call(engagement: string | null, operation: string, payload: Record<string, unknown>): { result: Record<string, unknown>; records: Ref[]; commit: string | null } {
    const def = getOperation(operation);
    if (!def) fail('invalid_request', `unknown operation ${operation}`);
    if (!def.channels.includes('auditor')) {
      fail('permission_denied', `${operation} is not available on the auditor channel (channels: ${def.channels.join(', ')}); decisions go through harness_decide`, { operation });
    }
    const scope = engagement ?? 'library';
    if (operation === 'read_records' && scope !== 'library') {
      const r = this.auditor.do<{ records: RecordEnvelope[]; truncated: boolean }>(scope, 'read_records', payload ?? {});
      const p = presentRecords(this.auditor, scope, r.records, 'agent:call:read_records');
      return { result: { records: p.shown, truncated: r.truncated, withheld: p.withheld }, records: [], commit: null };
    }
    const r = this.auditor.call<Record<string, unknown>>(scope, operation, payload ?? {});
    return { result: r.result, records: r.records, commit: r.commit };
  }

  /** Run queued jobs (as `harness job run`), with the workspace's providers and no live-exploitable provider. */
  async runJobs(engagement: string, opts: { max?: number } = {}): Promise<Record<string, unknown>> {
    ensureBroker(this.controller);
    const r = await runQueue(this.controller, engagement, opts.max !== undefined ? { maxJobs: opts.max } : {});
    return { ...r };
  }

  /** The report the latest (or named) yolo run recorded: what an unattended run produced, none of it reviewed by a human. */
  yoloReport(engagement: string, run?: string): { run: string; status: string; exit_reason: string | null; report: string | null } {
    const store = this.ws.store(engagement, true);
    const r = run ? store.mustHead(run, 'yolo_run') : store.heads('yolo_run').sort((a, b) => a.record_id.localeCompare(b.record_id, 'en', { numeric: true })).at(-1);
    if (!r) fail('not_found', `no yolo run in ${engagement}`);
    return { run: r.record_id, status: r.body.status, exit_reason: r.body.exit_reason, report: r.body.report ? store.archive.getText(r.body.report.artifact) : null };
  }

  /**
   * Record the auditor's words as the agent relays them (clarification answers, expectation notes) on the capture
   * channel, named `agent-session-relay`. The captured input counts as presented in this session.
   */
  captureRelay(engagement: string, args: { text: string; purpose?: string; unit?: string | null }): Ref {
    if (typeof args?.text !== 'string' || !args.text.trim()) fail('invalid_request', 'text is required');
    const channel = this.controller.capture(this.ws.readSecret('capture.key'), 'agent-session-relay', captureProgramDigest(), this.sessionId);
    const ref = captureText(channel, {
      engagement,
      text: args.text,
      ...(args.purpose ? { purpose: args.purpose as CapturePurpose } : {}),
      audit_unit: args.unit ? unitRef(this.ws, engagement, args.unit) : null,
    });
    const env = this.read(engagement, refKey(ref));
    this.presented.set(`${engagement}/${refKey(env)}`, env);
    return ref;
  }
}
