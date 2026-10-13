import { HarnessError } from '../core/errors.ts';
import { isArtifactRef, refKey, type AnyRef, type Ref } from '../core/refs.ts';
import { impactRank, isHighOrCritical, type PotentialImpact } from '../core/values.ts';
import type { RecordEnvelope } from '../schema/records.ts';
import { WITHHELD_NOTICE, type DisplayLog } from './display.ts';
import { collectDisposition, type DispositionInput, type NumberedRef } from './disposition.ts';
import { askUntil, choose, heading, page, show } from './io.ts';
import { proofLines, recordLines, refText, triState, valueText } from './render.ts';
import type { DecisionOutcome, TrustedScreen } from './screen.ts';

// Review-packet presentation (DEC-008 Q-017; design/harness-interface-contracts.md, "Packet
// presentation"). For potential High/Critical (with `unknown` counting as high), the screen hides the
// agent's proposed disposition until the evidence, the challenger's verbatim counterargument and the
// evidence-quality sections have been opened, and the display receipt records the opening order.
// Every other packet uses DEC-007's combined layout. Challenger and author positions are always the
// verbatim artifacts, never a summary; linked variants are grouped by guarantee; each linked claim is
// shown with its own potential impact and an "unreviewed flow" flag, and decided separately.
//
// The section state machine (`PacketReview`) is pure; `reviewPacket` drives it on a TrustedScreen.

export const PACKET_SECTIONS = ['claim', 'evidence', 'challenger', 'evidence_quality', 'unreviewed_statements', 'proposed_disposition'] as const;
export type PacketSectionId = (typeof PACKET_SECTIONS)[number];

export const SECTION_TITLES: Record<PacketSectionId, string> = {
  claim: 'Claim and decision requested',
  evidence: 'Evidence: supporting, refuting, failed attempts, variants, linked claims',
  challenger: 'Challenger and author positions (verbatim) and independence',
  evidence_quality: 'Evidence quality (proof status)',
  unreviewed_statements: 'Unreviewed agent statements this decision rests on',
  proposed_disposition: "Agent's proposed disposition",
};

/** Sections that must be opened before the proposed disposition is revealed (controller check). */
export const EVIDENCE_FIRST: readonly PacketSectionId[] = ['evidence', 'challenger', 'evidence_quality'];
/** Sections that must be opened before any disposition can be recorded. */
export const REQUIRED_BEFORE_DECIDING: readonly PacketSectionId[] = ['claim', 'evidence', 'challenger', 'evidence_quality', 'unreviewed_statements'];

export interface SectionContent {
  id: PacketSectionId;
  title: string;
  lines: string[];
  /** Record revisions whose content this section renders. */
  records: RecordEnvelope[];
}

export interface PacketModel {
  packet: RecordEnvelope<'review_packet'>;
  investigation: RecordEnvelope<'investigation'>;
  /** Highest potential impact among the packet and its linked claims. */
  max_impact: PotentialImpact;
  evidence_first: boolean;
  sections: Record<PacketSectionId, SectionContent>;
  refs: NumberedRef[];
  status_lines: string[];
  agent_draft: string | null;
}

/** Record and artifact access the model builder needs (TrustedScreen provides it). */
export interface PacketSource {
  get<T extends RecordEnvelope['type']>(r: Ref): RecordEnvelope<T>;
  tryGet<T extends RecordEnvelope['type']>(r: Ref): RecordEnvelope<T> | null;
  heads<T extends RecordEnvelope['type']>(type: T): RecordEnvelope<T>[];
  artifactText(digest: string): string | null;
  /** True for IMPLEMENTED content that read-first mode withholds (optional; default: never). */
  withheld?(env: RecordEnvelope): boolean;
}

export function buildPacketModel(src: PacketSource, packetRef: Ref): PacketModel {
  const packet = src.get<'review_packet'>(packetRef);
  if (packet.type !== 'review_packet') throw new Error(`${refKey(packetRef)} is not a review packet`);
  const p = packet.body;
  const investigation = src.get<'investigation'>(p.investigation);
  const inv = investigation.body;
  const refs: NumberedRef[] = [];
  const number = (ref: AnyRef, label: string): number => {
    const found = refs.find((r) => refText(r.ref) === refText(ref));
    if (found) return found.n;
    const n = refs.length + 1;
    refs.push({ n, ref, label });
    return n;
  };
  const sec = (id: PacketSectionId): SectionContent => ({ id, title: SECTION_TITLES[id], lines: [], records: [] });
  const sections = Object.fromEntries(PACKET_SECTIONS.map((s) => [s, sec(s)])) as Record<PacketSectionId, SectionContent>;

  const describe = (s: SectionContent, ref: AnyRef, indent: string) => {
    const n = number(ref, refText(ref));
    if (isArtifactRef(ref)) {
      s.lines.push(`${indent}[${n}] artifact ${ref.artifact} (view with "v ${n}")`);
      return;
    }
    const env = src.tryGet(ref);
    if (!env) {
      s.lines.push(`${indent}[${n}] ${refKey(ref)} — MISSING: not readable in this engagement`);
      return;
    }
    if (src.withheld?.(env)) {
      s.lines.push(`${indent}[${n}] ${env.type} ${env.record_id}@${env.revision} — ${WITHHELD_NOTICE}`);
      return;
    }
    s.records.push(env);
    const lines = recordLines(env, '    ');
    s.lines.push(`${indent}[${n}] ${lines[0]}`, ...lines.slice(1).map((l) => indent + l));
  };

  // --- claim
  const c = sections.claim;
  c.records.push(packet, investigation);
  number(packetRef, `review_packet ${refKey(packetRef)}`);
  number({ record_id: investigation.record_id, revision: investigation.revision }, `investigation ${investigation.record_id}@${investigation.revision}`);
  c.lines.push(
    `Claim: ${p.claim}`,
    `Decision requested: ${p.decision_requested}`,
    `Investigation question: ${inv.question}`,
    `Method: ${inv.method}   Lead generator: ${inv.lead_generator}`,
    `Affected guarantees: ${inv.guarantees.join('; ') || '(none named)'}`,
    `Attacker capabilities used: ${inv.attacker_capabilities.join('; ') || '(none named)'}`,
    `Realistic prerequisites: ${inv.prerequisites.join('; ') || '(none named)'}`,
    `Potential impact: packet ${p.potential_impact}; investigation effective ${inv.potential_impact.effective} (agent ${valueText(inv.potential_impact.agent)}, auditor ${valueText(inv.potential_impact.auditor)})`,
    `Recommended next check: ${p.next_check ?? '(none)'}`,
    `Missing information: ${p.missing_information.length ? p.missing_information.join('; ') : '(none listed)'}`,
  );

  // --- evidence
  const e = sections.evidence;
  e.lines.push(`Supporting evidence (${p.supporting.length}):`);
  for (const r of p.supporting) describe(e, r, '  ');
  e.lines.push(`Refuting or contradicting evidence (${p.refuting.length}):`);
  if (!p.refuting.length) e.lines.push('  (none recorded)');
  for (const r of p.refuting) describe(e, r, '  ');
  e.lines.push(`Failed attempts (${p.failed_attempts.length}):`);
  if (!p.failed_attempts.length) e.lines.push('  (none recorded)');
  for (const r of p.failed_attempts) describe(e, r, '  ');
  const groups = new Map<string, typeof p.variants>();
  for (const v of p.variants) {
    const g = v.linked_guarantee ?? '';
    groups.set(g, [...(groups.get(g) ?? []), v]);
  }
  e.lines.push(`Scenario variants (${p.variants.length}), every variant with its outcome, grouped by guarantee:`);
  if (!p.variants.length) e.lines.push('  (none recorded)');
  for (const [g, vs] of [...groups].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))) {
    e.lines.push(g === '' ? "  Guarantee: the investigation's own" : `  Guarantee: ${g} (linked variants)`);
    for (const v of vs) {
      e.lines.push(`    Outcome: ${v.outcome ?? 'no outcome recorded'}`);
      describe(e, v.variant, '    ');
    }
  }
  e.lines.push(`Linked claims (${p.linked_claims.length}), each decided separately with its own potential impact:`);
  if (!p.linked_claims.length) e.lines.push('  (none)');
  for (const lc of p.linked_claims) {
    const full = inv.linked_claims.find((x) => x.id === lc.id);
    e.lines.push(
      `  Linked claim ${lc.id} on guarantee ${lc.guarantee}: potential impact ${lc.potential_impact}${lc.unreviewed_flow ? '  [UNREVIEWED FLOW: the flow has no record_flow_review decision]' : '  [flow reviewed]'}`,
    );
    if (full) e.lines.push(`    Claim: ${full.claim}`, `    Flow: ${refText(full.flow)}`);
  }

  // --- challenger (verbatim)
  const ch = sections.challenger;
  ch.lines.push(`Challenge required: ${p.challenge_required ? 'yes' : 'no'}`);
  const verbatim = (label: string, a: { artifact: string } | null) => {
    if (!a) {
      ch.lines.push(`${label}: ${p.challenge_required ? 'MISSING (required)' : 'none supplied'}`);
      return;
    }
    const n = number(a, `${label} ${a.artifact}`);
    const t = src.artifactText(a.artifact);
    if (t === null) {
      ch.lines.push(`${label} [${n}]: MISSING artifact ${a.artifact} (not in the archive)`);
      return;
    }
    ch.lines.push(`${label} [${n}], verbatim from artifact ${a.artifact}:`, ...t.split('\n').map((l) => `  | ${l}`));
  };
  verbatim('Challenger position', p.challenger_position);
  verbatim('Author position', p.author_position);
  const ind = p.challenge_independence;
  ch.lines.push(
    'Challenge independence:',
    `  Same model: ${triState(ind.same_model)}`,
    `  Same provider: ${triState(ind.same_provider)}`,
    `  Shared premises: ${ind.shared_premises.length ? ind.shared_premises.join('; ') : '(none listed)'}`,
    `  Context: ${ind.context || '(not described)'}`,
  );

  // --- evidence quality
  const q = sections.evidence_quality;
  q.lines.push('Proof status of the main claim:', ...proofLines(p.evidence_quality));
  q.lines.push(`Replay receipt: ${refText(p.replay_receipt)}`, `Executable confirmation requested: ${p.executable_confirmation_requested ? 'yes' : 'no'}`);
  if (p.replay_receipt) number(p.replay_receipt, `replay ${refKey(p.replay_receipt)}`);
  for (const lc of inv.linked_claims) q.lines.push(`Proof status of linked claim ${lc.id}:`, ...proofLines(lc.proof_status, '    '));

  // --- unreviewed statements
  const u = sections.unreviewed_statements;
  if (!p.unreviewed_statements.length) u.lines.push('None: no unreviewed agent statement is in this decision\'s dependency closure.');
  else u.lines.push('The decision is recorded as CONDITIONAL on each of these unless you accept it explicitly when deciding:');
  for (const r of p.unreviewed_statements) describe(u, r, '  ');

  // --- proposed disposition
  const pd = sections.proposed_disposition;
  if (!p.proposed_disposition) pd.lines.push('The agent proposed no disposition.');
  else {
    pd.lines.push(
      `Proposed disposition: ${p.proposed_disposition.value}`,
      `Authorship of the draft: ${p.proposed_disposition.authorship}`,
      'Draft rationale (verbatim):',
      ...p.proposed_disposition.rationale.split('\n').map((l) => `  | ${l}`),
    );
  }

  // --- status header: separate dimensions, textual
  let max: PotentialImpact = p.potential_impact;
  for (const lc of p.linked_claims) if (impactRank(lc.potential_impact) > impactRank(max)) max = lc.potential_impact;
  if (impactRank(inv.potential_impact.effective) > impactRank(max)) max = inv.potential_impact.effective;
  const fresh = src
    .heads('conclusion_freshness')
    .filter((f) => f.body.conclusion.record_id === investigation.record_id)
    .pop();
  const status_lines = [
    `Work state: ${inv.work_state}${inv.blocked_reason ? ` (blocked: ${inv.blocked_reason})` : ''}`,
    `Disposition: ${inv.disposition ? `${inv.disposition.value} (${refText(inv.disposition.decision)})` : 'none yet'}`,
    `Freshness: ${fresh ? `${fresh.body.value} (${fresh.record_id}@${fresh.revision})` : inv.disposition ? 'current (no change registered)' : 'not applicable (no conclusion yet)'}`,
    `Proof status: listed field by field in section "${SECTION_TITLES.evidence_quality}"`,
    `Potential impact deciding the presentation order: ${max}${max === 'unknown' ? " ('unknown' counts as high)" : ''}`,
  ];

  return {
    packet,
    investigation,
    max_impact: max,
    evidence_first: isHighOrCritical(max),
    sections,
    refs,
    status_lines,
    agent_draft: p.proposed_disposition?.rationale ?? null,
  };
}

export type SectionState = 'opened' | 'available' | 'locked';

/** Pure section state machine: what may be opened, and when a disposition may be recorded. */
export class PacketReview {
  readonly model: PacketModel;
  readonly log: DisplayLog;

  constructor(model: PacketModel, log: DisplayLog) {
    this.model = model;
    this.log = log;
  }

  state(id: PacketSectionId): SectionState {
    if (this.log.hasOpened(id)) return 'opened';
    if (id === 'proposed_disposition' && this.model.evidence_first && this.missingEvidenceFirst().length) return 'locked';
    return 'available';
  }

  missingEvidenceFirst(): PacketSectionId[] {
    return EVIDENCE_FIRST.filter((s) => !this.log.hasOpened(s));
  }

  lockReason(id: PacketSectionId): string | null {
    if (this.state(id) !== 'locked') return null;
    return `hidden until you open: ${this.missingEvidenceFirst().map((s) => `[${PACKET_SECTIONS.indexOf(s) + 1}] ${s}`).join(', ')} (evidence-first order for potential ${this.model.max_impact})`;
  }

  /** Open a section: returns its content, or null when it is locked. Records the opening and its records. */
  open(id: PacketSectionId): SectionContent | null {
    if (this.state(id) === 'locked') return null;
    const s = this.model.sections[id];
    if (!this.log.hasOpened(id)) this.log.opened(id);
    for (const r of s.records) this.log.rendered(r);
    return s;
  }

  /** Combined layout (below High): every section in canonical order. */
  openAll(): SectionContent[] {
    return PACKET_SECTIONS.map((s) => this.open(s)!);
  }

  /** Sections still to open before a disposition can be recorded. */
  missingBeforeDeciding(): PacketSectionId[] {
    return REQUIRED_BEFORE_DECIDING.filter((s) => !this.log.hasOpened(s));
  }

  /** Next section Enter opens: the first unopened, available one in canonical order. */
  next(): PacketSectionId | null {
    return PACKET_SECTIONS.find((s) => this.state(s) === 'available') ?? null;
  }
}

const SECTION_PREVIEW_LINES = 40;

async function printSection(screen: TrustedScreen, s: SectionContent): Promise<void> {
  const n = PACKET_SECTIONS.indexOf(s.id) + 1;
  heading(screen.io, `[${n}] ${s.title}`);
  show(screen.io, s.lines.slice(0, SECTION_PREVIEW_LINES).join('\n') + '\n');
  if (s.lines.length > SECTION_PREVIEW_LINES) {
    screen.io.write(`(${s.lines.length - SECTION_PREVIEW_LINES} more lines: enter "p ${n}" to page the full section)\n`);
  }
}

export interface PacketDecisionInputs {
  packet: Ref;
  investigation: Ref;
  main: DispositionInput;
  main_effective: PotentialImpact;
  linked_claims: { id: string; input: DispositionInput; effective: PotentialImpact }[];
  accepted_unreviewed: Ref[];
}

/** Collect the main claim's and each linked claim's disposition, and explicit acceptance of unreviewed statements. */
export async function collectPacketDecision(screen: TrustedScreen, m: PacketModel): Promise<PacketDecisionInputs> {
  const p = m.packet.body;
  const inv = m.investigation.body;
  const common = {
    executable: inv.executable,
    refs: m.refs,
    replay_status: p.evidence_quality.replay,
    variants: p.variants.map((v) => v.variant),
    method: inv.method,
    prerequisites: inv.prerequisites,
    anchor_count: inv.anchors.length,
  };
  heading(screen.io, 'Main claim');
  const main = await collectDisposition(screen.io, {
    ...common,
    label: 'the main claim',
    linked_claim_id: null,
    guarantee: null,
    agent_impact: inv.potential_impact.agent,
    auditor_impact: inv.potential_impact.auditor,
  });
  const linked: PacketDecisionInputs['linked_claims'] = [];
  for (const lc of p.linked_claims) {
    const full = inv.linked_claims.find((x) => x.id === lc.id);
    heading(screen.io, `Linked claim ${lc.id}`);
    show(screen.io, `Guarantee: ${lc.guarantee}\nClaim: ${full?.claim ?? '(text not found on the investigation)'}\n`);
    if (lc.unreviewed_flow) screen.io.write('UNREVIEWED FLOW: this claim concerns a flow with no record_flow_review decision.\n');
    const r = await collectDisposition(screen.io, {
      ...common,
      variants: full?.variants ?? common.variants,
      label: `linked claim ${lc.id} (${lc.guarantee})`,
      linked_claim_id: lc.id,
      guarantee: lc.guarantee,
      agent_impact: full?.potential_impact.agent ?? lc.potential_impact,
      auditor_impact: full?.potential_impact.auditor ?? null,
    });
    linked.push({ id: lc.id, input: r.input, effective: r.effective });
  }
  const accepted: Ref[] = [];
  for (const r of p.unreviewed_statements) {
    const a = await choose(screen.io, `Unreviewed statement ${refKey(r)}`, [
      { key: 'c', value: 'c', label: 'Leave it a condition of this decision (default)' },
      { key: 'a', value: 'a', label: 'Accept it explicitly for this decision' },
    ]);
    if (a === 'a') accepted.push(r);
  }
  return {
    packet: { record_id: m.packet.record_id, revision: m.packet.revision },
    investigation: { record_id: m.investigation.record_id, revision: m.investigation.revision },
    main: main.input,
    main_effective: main.effective,
    linked_claims: linked,
    accepted_unreviewed: accepted,
  };
}

/** Decision inputs for `dispose_investigation` (shape: src/decision/kinds.ts, `DisposeInputs`). */
export function disposeInputs(d: PacketDecisionInputs): Record<string, unknown> {
  return {
    packet: d.packet,
    investigation: d.investigation,
    ...d.main,
    linked_claims: d.linked_claims.map((l) => ({ id: l.id, ...l.input })),
  };
}

/** The interactive packet review on the trusted screen. Returns the final outcome. */
export async function reviewPacket(screen: TrustedScreen, packetId: string): Promise<DecisionOutcome> {
  const io = screen.io;
  for (;;) {
    screen.beginDisplay();
    const head = screen.head<'review_packet'>(packetId);
    const model = buildPacketModel(screen, { record_id: head.record_id, revision: head.revision });
    const review = new PacketReview(model, screen.log);
    screen.banner(`Review packet ${head.record_id}@${head.revision} — investigation ${model.investigation.record_id}@${model.investigation.revision}`);
    show(io, model.status_lines.join('\n') + '\n');
    if (!model.evidence_first) {
      io.write(`Combined layout: potential impact ${model.max_impact} is below High.\n`);
      for (const s of review.openAll()) await printSection(screen, s);
    } else {
      io.write(`Evidence-first order: potential impact ${model.max_impact}. The proposed disposition stays hidden until sections 2, 3 and 4 are opened.\n`);
    }
    let decided: DecisionOutcome | null = null;
    for (;;) {
      heading(io, 'Sections');
      PACKET_SECTIONS.forEach((s, i) => {
        const st = review.state(s);
        io.write(`  [${i + 1}] ${SECTION_TITLES[s]} — ${st === 'locked' ? `LOCKED: ${review.lockReason(s)}` : st}\n`);
      });
      const nxt = review.next();
      io.write(`Keys: 1-6 open a section${nxt ? ` (Enter opens [${PACKET_SECTIONS.indexOf(nxt) + 1}])` : ''}; "p N" page section N; "v N" view reference N in full; "d" decide; "m" request more work; "q" leave undecided\n`);
      const a = (await io.ask('> ')).trim();
      if (a === 'q') {
        io.write('Left undecided. Nothing was recorded.\n');
        return { status: 'cancelled' };
      }
      if (a === '' || /^[1-6]$/.test(a)) {
        const id = a === '' ? nxt : PACKET_SECTIONS[Number(a) - 1];
        if (!id) continue;
        const s = review.open(id);
        if (!s) io.write(`Section [${a}] is ${review.lockReason(id)}\n`);
        else await printSection(screen, s);
        continue;
      }
      let m: RegExpMatchArray | null;
      if ((m = a.match(/^p\s*([1-6])$/))) {
        const id = PACKET_SECTIONS[Number(m[1]) - 1];
        const s = review.open(id);
        if (!s) io.write(`Section [${m[1]}] is ${review.lockReason(id)}\n`);
        else await page(io, s.lines, s.title);
        continue;
      }
      if ((m = a.match(/^v\s*(\d+)$/))) {
        const e = model.refs.find((r) => r.n === Number(m![1]));
        if (!e) io.write('No such reference number.\n');
        else if (isArtifactRef(e.ref)) await screen.pageArtifact(e.ref.artifact);
        else {
          const env = screen.tryGet(e.ref);
          if (env) await screen.pageRecord(env);
          else io.write('That record is not readable in this engagement.\n');
        }
        continue;
      }
      if (a === 'm') {
        // Request more work (auditor guide table): name the missing distinguishing check; it runs only
        // within a current authorization. This is not a disposition.
        const check = await askUntil(io, 'Missing distinguishing check: ', (x) => (x ? null : 'Name the check.'));
        try {
          const r = screen.session.do(screen.engagement, 'request_check', {
            investigation: { record_id: model.investigation.record_id, revision: model.investigation.revision },
            check,
          });
          show(io, `Requested. Investigation ${refText(r.investigation)} is ${r.work_state}; no disposition was recorded.\n`);
          return { status: 'cancelled' };
        } catch (e) {
          if (!(e instanceof HarnessError)) throw e;
          screen.explain(e);
          continue;
        }
      }
      if (a === 'd') {
        const missing = review.missingBeforeDeciding();
        if (missing.length) {
          io.write(`Open these sections before deciding: ${missing.map((s) => `[${PACKET_SECTIONS.indexOf(s) + 1}] ${s}`).join(', ')}\n`);
          continue;
        }
        const inputs = await collectPacketDecision(screen, model);
        const summary = [
          `Main claim: ${inputs.main.disposition} (effective potential impact ${inputs.main_effective})`,
          ...inputs.linked_claims.map((l) => `Linked claim ${l.id}: ${l.input.disposition} (effective potential impact ${l.effective})`),
          `Unreviewed statements accepted explicitly: ${inputs.accepted_unreviewed.map(refKey).join(', ') || 'none (decision conditional on them)'}`,
          `Section order recorded: ${screen.log.sections.map((s) => s.section).join(' -> ')}`,
        ];
        decided = await screen.decide({
          operation: 'record_decision',
          decision_kind: 'dispose_investigation',
          reviewed: [inputs.packet, inputs.investigation],
          inputs: disposeInputs(inputs),
          agent_draft: review.state('proposed_disposition') === 'opened' ? model.agent_draft : null,
          accepted_unreviewed: inputs.accepted_unreviewed,
          summary,
        });
        break;
      }
      await askUntil(io, 'Unknown key. Press Enter to continue: ', () => null);
    }
    if (await screen.offerRereview(decided)) continue;
    return decided;
  }
}
