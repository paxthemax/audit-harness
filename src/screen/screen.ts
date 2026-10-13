import { randomToken } from '../core/hash.ts';
import { fail, HarnessError, isHarnessError } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import type { RationaleAuthorship } from '../core/values.ts';
import { Controller, type CallResult, type Session } from '../controller/controller.ts';
import type { Workspace } from '../controller/workspace.ts';
import type { RecordEnvelope, RecordType } from '../schema/records.ts';
import { screenProgramDigest } from '../capture/program.ts';
import { DisplayLog, implementedUnitsOf, readFirstActive, WITHHELD_NOTICE } from './display.ts';
import { bold, choose, confirmWord, heading, page, show, type ScreenIO } from './io.ts';
import { fullRecordLines, recordLines, refText } from './render.ts';

// The trusted decision screen (design/harness-glossary.md): the authenticated, human-only interface
// that renders bound record revisions, records display receipts and submits decisions. It opens a
// `screen` channel session with the auditor key, and refuses to start unless both input and output
// are an interactive terminal: a pipe, a script or a worker process cannot drive it. Worker sandboxes
// never mount the workspace, so they cannot read the key (docs/cli.md lists what to verify).

export interface OpenScreenOptions {
  ws: Workspace;
  key: string;
  io: ScreenIO;
  engagement: string;
  controller?: Controller;
  /** Clock for receipt timestamps (tests). */
  clock?: () => string;
}

export function openTrustedScreen(o: OpenScreenOptions): TrustedScreen {
  if (!o.io.interactive) {
    fail(
      'permission_denied',
      'the trusted decision screen needs an interactive terminal on both input and output; it refuses pipes, scripts and worker processes',
    );
  }
  const controller = o.controller ?? new Controller(o.ws);
  const identity = `harness-trusted-screen ${screenProgramDigest()}`;
  const session = controller.screen(o.key, identity, `screen-${randomToken(8)}`);
  return new TrustedScreen(session, o.engagement, o.io, o.clock);
}

export interface DecisionRequest {
  /** `record_decision`, or one of the decision-bearing operations (authorize_work, revise_premise, approve_export). */
  operation: string;
  decision_kind: string;
  reviewed: Ref[];
  inputs: Record<string, unknown>;
  /** Agent-drafted rationale available for this decision, if any (shown, never silently used). */
  agent_draft: string | null;
  accepted_unreviewed?: Ref[];
  /** One-line summary of what is being decided, shown before the confirmation key. */
  summary: string[];
}

export type DecisionOutcome =
  | { status: 'decided'; result: Record<string, unknown>; commit: string | null }
  | { status: 'refused'; error: HarnessError; rereview: boolean }
  | { status: 'cancelled' };

export class TrustedScreen {
  readonly session: Session;
  readonly engagement: string;
  readonly io: ScreenIO;
  private readonly clock: () => string;
  log: DisplayLog;

  constructor(session: Session, engagement: string, io: ScreenIO, clock?: () => string) {
    this.session = session;
    this.engagement = engagement;
    this.io = io;
    this.clock = clock ?? (() => new Date().toISOString());
    this.log = new DisplayLog(this.clock);
  }

  /** Start a fresh display (a new receipt) for a new review or a re-review. */
  beginDisplay(): DisplayLog {
    this.log = new DisplayLog(this.clock);
    return this.log;
  }

  // --- reads (through the authenticated screen channel) -------------------------------------------

  get<T extends RecordType>(r: Ref): RecordEnvelope<T> {
    return this.session.do(this.engagement, 'read_records', { refs: [r] }).records[0];
  }

  head<T extends RecordType>(id: string): RecordEnvelope<T> {
    return this.session.do(this.engagement, 'read_records', { ids: [id] }).records[0];
  }

  heads<T extends RecordType>(type: T): RecordEnvelope<T>[] {
    return this.session.do(this.engagement, 'read_records', { type, limit: 5000 }).records;
  }

  tryGet<T extends RecordType>(r: Ref): RecordEnvelope<T> | null {
    try {
      return this.get<T>(r);
    } catch (e) {
      if (isHarnessError(e, 'not_found')) return null;
      throw e;
    }
  }

  /** Artifact bytes as text (archive is read directly: the screen is part of the trusted installation). */
  artifactText(digest: string): string | null {
    const archive = this.session.controller.ws.store(this.engagement, true).archive;
    if (!archive.has(digest)) return null;
    return archive.getText(digest);
  }

  // --- rendering ------------------------------------------------------------------------------------

  /** Read-first mode is active: IMPLEMENTED behavior must not be presented. */
  readFirstActive(): boolean {
    return readFirstActive(this.heads('engagement')[0]);
  }

  /** IMPLEMENTED content that read-first mode withholds right now. */
  withheld(env: RecordEnvelope): boolean {
    return implementedUnitsOf(env).length > 0 && this.readFirstActive();
  }

  /** Render a record summary and note it in the display receipt (withheld during read-first mode). */
  render(env: RecordEnvelope, indent = '  '): void {
    if (this.withheld(env)) {
      this.io.write(`${indent}${env.type} ${env.record_id}@${env.revision} — ${WITHHELD_NOTICE}\n`);
      return;
    }
    show(this.io, recordLines(env, indent).map((l) => indent + l).join('\n') + '\n');
    this.log.rendered(env);
  }

  async pageRecord(env: RecordEnvelope): Promise<void> {
    if (this.withheld(env)) {
      this.io.write(`${env.type} ${env.record_id}@${env.revision} — ${WITHHELD_NOTICE}\n`);
      return;
    }
    await page(this.io, fullRecordLines(env), `${env.type} ${env.record_id}@${env.revision}`);
    this.log.rendered(env);
  }

  async pageArtifact(digest: string): Promise<void> {
    const t = this.artifactText(digest);
    if (t === null) {
      this.io.write(`Artifact ${digest} is not in this engagement's archive (missing material; nothing inferred).\n`);
      return;
    }
    await page(this.io, t.split('\n'), `artifact ${digest}`);
  }

  /** Engagement and snapshot always visible at the top of each screen (auditor guide). */
  banner(title: string): void {
    if (this.engagement === 'library') {
      heading(this.io, title);
      this.io.write('Scope: cross-engagement library (method versions, evaluation contracts); no engagement is in view.\n');
      return;
    }
    const eng = this.session.do(this.engagement, 'read_records', { type: 'engagement' }).records[0] as RecordEnvelope<'engagement'>;
    heading(this.io, title);
    show(this.io, `Engagement: ${this.engagement} (${eng.body.name})   Active snapshot: ${refText(eng.body.active_snapshot)}\n`);
    if (eng.body.read_first && eng.body.read_first.ended_at === null) {
      this.io.write('Read-first mode is active: presentations of IMPLEMENTED behavior are withheld until it ends.\n');
    }
  }

  // --- deciding -------------------------------------------------------------------------------------

  /**
   * Rationale with its authorship: accept the agent draft unedited, edit it, or write your own.
   * The controller computes the edit diff from the draft and the final text.
   */
  async collectRationale(draft: string | null): Promise<{ rationale: string; authorship: RationaleAuthorship; agent_draft: string | null }> {
    if (draft) {
      heading(this.io, 'Agent-drafted rationale (verbatim)');
      show(this.io, draft + '\n');
      const how = await choose(this.io, 'Rationale', [
        { key: 'a', value: 'accept', label: 'Accept the agent draft unedited (recorded as agent_drafted_unedited)' },
        { key: 'e', value: 'edit', label: 'Edit the agent draft (recorded as agent_drafted_edited with the edit diff)' },
        { key: 'w', value: 'write', label: 'Write my own rationale (recorded as human_written)' },
      ]);
      if (how === 'accept') return { rationale: draft, authorship: 'agent_drafted_unedited', agent_draft: draft };
      if (how === 'edit') {
        for (;;) {
          const edited = await this.io.edit('Edit the rationale', draft);
          if (edited.trim() && edited.trim() !== draft.trim()) return { rationale: edited, authorship: 'agent_drafted_edited', agent_draft: draft };
          if (edited.trim() === draft.trim()) {
            this.io.write('  The text is unchanged; it will be recorded as accepted unedited.\n');
            return { rationale: draft, authorship: 'agent_drafted_unedited', agent_draft: draft };
          }
          this.io.write('  A rationale is required.\n');
        }
      }
    }
    for (;;) {
      const own = await this.io.edit('Write your rationale', '');
      if (own.trim()) return { rationale: own, authorship: 'human_written', agent_draft: null };
      this.io.write('  A rationale is required.\n');
    }
  }

  /**
   * Collect the rationale, confirm explicitly, record the display receipt, then submit the decision.
   * Focus ends on the resulting decision or on the conflict explanation.
   */
  async decide(req: DecisionRequest): Promise<DecisionOutcome> {
    const r = await this.collectRationale(req.agent_draft);
    heading(this.io, 'Decision summary');
    show(this.io, [`Kind: ${req.decision_kind}`, ...req.summary, `Reviewed revisions: ${req.reviewed.map(refText).join(', ')}`, `Rationale authorship: ${r.authorship}`].join('\n') + '\n');
    if (!(await confirmWord(this.io, 'Record this decision?'))) {
      this.io.write('Cancelled. Nothing was recorded; the item stays undecided.\n');
      return { status: 'cancelled' };
    }
    let receipt: Ref;
    try {
      receipt = this.session.do(this.engagement, 'record_display', this.log.toPayload()).display_receipt;
    } catch (e) {
      if (!(e instanceof HarnessError)) throw e;
      this.explain(e);
      return { status: 'refused', error: e, rereview: false };
    }
    const payload = {
      decision_kind: req.decision_kind,
      reviewed: req.reviewed,
      display_receipt: receipt,
      inputs: req.inputs,
      rationale: r.rationale,
      rationale_authorship: r.authorship,
      agent_draft: r.agent_draft,
      accepted_unreviewed: req.accepted_unreviewed ?? [],
    };
    let res: CallResult<Record<string, unknown>>;
    try {
      res = this.session.call(this.engagement, req.operation, payload);
    } catch (e) {
      if (!(e instanceof HarnessError)) throw e;
      this.explain(e);
      return { status: 'refused', error: e, rereview: ['stale_dependency', 'display_required', 'revision_conflict'].includes(e.code) };
    }
    heading(this.io, 'Decision recorded');
    show(this.io, `Decision: ${refText(res.result.decision as Ref)}  (display receipt ${refText(receipt)}, commit ${res.commit ?? 'n/a'})\n`);
    const cond = (res.result.conditional_on as Ref[] | undefined) ?? [];
    if (cond.length) show(this.io, `Recorded as CONDITIONAL on unreviewed statements: ${cond.map(refText).join(', ')}\n`);
    for (const [k, v] of Object.entries(res.result)) {
      if (k !== 'decision' && k !== 'conditional_on') show(this.io, `  ${k}: ${JSON.stringify(v)}\n`);
    }
    return { status: 'decided', result: res.result, commit: res.commit };
  }

  /** Plain-language explanation of a refusal: code, reason, what committed, what changed, next action. */
  explain(e: HarnessError): void {
    const j = e.toJSON();
    heading(this.io, `Refused: ${j.code}`);
    show(this.io, `Reason: ${j.reason}\n`);
    this.io.write(`Committed: ${j.committed ? 'yes (see the reason)' : 'no — nothing was recorded'}\n`);
    const d = (j.details ?? {}) as Record<string, any>;
    if (e.code === 'stale_dependency' && Array.isArray(d.changed)) {
      this.io.write('What changed since you reviewed it:\n');
      for (const c of d.changed as { ref: Ref; current: number }[]) {
        let type = '';
        try {
          type = this.head(c.ref.record_id).type + ' ';
        } catch {
          /* unreadable: show the id only */
        }
        show(this.io, `  ${type}${c.ref.record_id}: you reviewed revision ${c.ref.revision}; current revision is ${c.current}\n`);
      }
      this.io.write('Acceptance is disabled until you re-review the current revisions.\n');
    } else if (e.code === 'display_required') {
      if (Array.isArray(d.not_rendered)) show(this.io, `Not rendered on this screen: ${d.not_rendered.map(refText).join(', ')}\n`);
      this.io.write('Open the required sections (evidence-first for potential High/Critical) and decide again.\n');
    } else if (e.code === 'evidence_requirement_unmet' || e.code === 'packet_incomplete') {
      if (Object.keys(d).length) show(this.io, `Still needed: ${JSON.stringify(d, null, 2)}\n`);
      this.io.write('Supply the evidence, request more work, or choose another disposition (dispute or defer).\n');
    } else if (Object.keys(d).length) {
      show(this.io, `Details: ${JSON.stringify(d)}\n`);
    }
    this.io.write(bold(this.io, `Next action: ${j.next}`) + '\n');
  }

  /** After a refusal that a re-review can resolve: offer it. */
  async offerRereview(o: DecisionOutcome): Promise<boolean> {
    if (o.status !== 'refused' || !o.rereview) return false;
    const a = await choose(this.io, 'Re-review', [
      { key: 'r', value: 'r', label: 'Re-render the current revisions and review again' },
      { key: 'q', value: 'q', label: 'Leave the item undecided' },
    ]);
    return a === 'r';
  }
}
