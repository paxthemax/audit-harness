import { readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import '../index.ts';
import { fail } from '../core/errors.ts';
import { DECISION_KINDS, POTENTIAL_IMPACTS, type Disposition } from '../core/values.ts';
import { Workspace } from '../controller/workspace.ts';
import { AgentReviewSession, type DecideArgs } from '../review/session.ts';
import { DISPOSITION_FIELDS, type DispositionField } from '../screen/disposition.ts';
import { LIMIT_KEYS } from '../screen/flows.ts';
import { PACKET_SECTIONS, REQUIRED_BEFORE_DECIDING } from '../screen/packet.ts';
import { refText } from '../screen/render.ts';
import { serveMcp, type McpTool, type McpToolResult } from './server.ts';

// `harness mcp`: the agent interface for pending decisions. An MCP host (omp, Claude Code, ...)
// presents items to the auditor, discusses them, and records what the auditor directs through one
// AgentReviewSession. Decisions are labelled as recorded through an agent session; nothing here
// binds or proves the auditor's participation (operator decision 2026-10-14).

export interface HarnessMcpOptions {
  /** Workspace directory (the CLI's `--workspace`, `HARNESS_WORKSPACE`, default `./workspace`). */
  workspace: string;
  input: Readable;
  output: Writable;
  /** Diagnostics only; never protocol traffic. */
  error: Writable;
  clock?: () => string;
}

const RATIONALE_AUTHORSHIP = ['human_written', 'agent_drafted_unedited', 'agent_drafted_edited'] as const;

export const HARNESS_MCP_INSTRUCTIONS = `Audit harness: present pending decisions to the auditor, discuss them, and record the decisions the auditor directs.

Operating guide:
1. Start with harness_overview (no engagement) to list engagements, then harness_overview with an engagement for its pending decisions, work and gaps.
2. Present an item with harness_present before deciding it. Show the auditor the presented text faithfully; it renders deceptive characters visibly, so keep those markers.
3. Packets (pkt-...): for potential High/Critical claims, go through the evidence, the challenger and the evidence quality with the auditor before discussing the proposed disposition. harness_decide refuses a packet until the sections ${REQUIRED_BEFORE_DECIDING.join(', ')} were presented in this session.
4. When the auditor asks for a position, an agent's argument or a record, quote it verbatim from the presented text or harness_records; mark your own summaries as yours.
5. You may recommend. Record only what the auditor directs: the decision inputs and the rationale they choose. Start from the \`template\` harness_present returns.
6. Report rationale_authorship truthfully: human_written when the auditor dictated the rationale, agent_drafted_unedited when they accepted your text as is, agent_drafted_edited when they changed your draft. Pass your draft as agent_draft when you wrote one.
7. When the auditor wants more work on an investigation instead of a disposition, use harness_request_check; it records no disposition.
8. harness_capture records the auditor's own words (clarification answers, expectations) as you relay them; the record is labelled as relayed by an agent session. Never put your own words there.
9. harness_call runs non-decision operations on the auditor channel; harness_run_jobs runs queued work under current authorizations.
10. harness_yolo_report returns the report of an unattended yolo run (harness yolo run). Nothing in it was reviewed by a human: its candidate findings are review packets that still need the auditor's disposition, presented and decided as above.
Errors come back as tool results with a harness error code, the reason and the next action; tell the auditor and follow the next action.`;

const ENGAGEMENT = { type: 'string', description: 'Engagement id (eng-...). Use `library` for library-scope decisions.' };

/** The fields each disposition takes, walked from the table the review session checks decisions against. */
function describeFields(fields: DispositionField[]): string {
  return fields
    .filter((f) => f.type !== 'derived')
    .map((f) => {
      // A choice's condition narrows its values (as in the template); any other condition says when the field applies.
      if (f.type === 'choice') return `${f.key} (${f.options!.join(' | ')}${f.condition ? `; ${f.condition}` : ''})`;
      const shape = f.type === 'object' ? ` {${describeFields(f.fields!)}}` : f.type === 'refs' || f.type === 'list' ? ' []' : '';
      return `${f.key}${shape}${f.condition ? ` [only ${f.condition}]` : ''}`;
    })
    .join(', ');
}

const DECISION_DESCRIPTION = [
  'Kind-specific decision inputs. Start from the `template` harness_present returned for the item.',
  `Packet (pkt-...): the main claim's disposition inputs: disposition (${Object.keys(DISPOSITION_FIELDS).join(' | ')}), potential_impact? (${POTENTIAL_IMPACTS.join(' | ')}; below the agent's estimate needs impact_lower_reason), plus per disposition: ${(Object.entries(DISPOSITION_FIELDS) as [Disposition, DispositionField[]][]).map(([d, fields]) => `${d} -> ${describeFields(fields) || 'nothing else'}`).join('; ')}. References are id@revision (or a presented reference number). Plus linked_claims? ([{id, disposition, ...same fields}]) and accepted_unreviewed? (ids of unreviewed statements the auditor accepts).`,
  "Audit unit (unit-...): { reviewed_functions?: string[] | 'all', gaps?: string[] } -> record_flow_review over the comparisons presented.",
  `Work proposal (wprop-...): { limits: { ${LIMIT_KEYS.join(', ')} } (all required), capabilities?: { tools, providers, network: 'denied' | 'rpc_gateway' }, validity?: { from, until } | null, interrupt_conditions?: string[], keep?: investigation ids to authorize (subset of the proposal; default all) } -> authorize_work.`,
  'Engagement (eng-...): { policy: { scope, exclusions, attacker_charter, trusted_role_premise, data_policy, disclosure_constraints, retention, severity_rubric, rejection_listing_threshold, budget, evidence_policy, capacity, time_plan } } -> accept_scope_and_policy; keep or exclude (with a reason) every default attacker capability.',
  'Anything else (generic decision, give kind and records): the inputs of that decision kind.',
].join('\n');

function schema(properties: Record<string, Record<string, unknown>>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const TOOL_SPECS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'harness_overview',
    description:
      'Without engagement: list engagements (closure status, active snapshot, decisions needed). With engagement: its pending decisions (ids, kinds, titles, potential impact), work in progress and coverage gaps. Start here.',
    inputSchema: schema({ engagement: ENGAGEMENT }, []),
  },
  {
    name: 'harness_present',
    description:
      'Present one item to the auditor: a packet (pkt-...), audit unit flow review (unit-...), work proposal (wprop-...), the engagement scope and policy (eng-...) or any other record id. Returns the canonical text, the `decision` template for harness_decide, and for packets the sections presented so far and still required. Each call is added to the item\'s display receipt.',
    inputSchema: schema(
      {
        engagement: ENGAGEMENT,
        id: { type: 'string', description: 'Record id to present: pkt-..., unit-..., wprop-..., eng-..., or any record id in the engagement.' },
        section: {
          type: 'string',
          enum: [...PACKET_SECTIONS],
          description: 'Packets only: present one section. Omit to present every section currently available, in canonical order (a locked section is refused with its lock reason).',
        },
      },
      ['engagement', 'id'],
    ),
  },
  {
    name: 'harness_decide',
    description:
      'Record the decision the auditor directs for a presented item (id) or a generic decision (kind + records). The display receipt of what was presented is submitted first; the decision is labelled as recorded through an agent session. Present the item first.',
    inputSchema: schema(
      {
        engagement: ENGAGEMENT,
        id: { type: 'string', description: 'Item to decide: pkt-..., unit-..., wprop-... or eng-.... Omit for a generic decision.' },
        kind: { type: 'string', enum: [...DECISION_KINDS], description: 'Generic decision only: the decision kind (e.g. answer_clarification, attest_carry_forward, approve_export, close_engagement, assess_fix, reaffirm, revise_premise).' },
        records: { type: 'array', items: { type: 'string' }, description: 'Generic decision only: records the decision binds, as `id` (current revision) or `id@revision`. Present them first.' },
        operation: { type: 'string', description: 'Generic decision only: the decision-bearing operation, when it differs from the kind\'s default.' },
        decision: { type: 'object', description: DECISION_DESCRIPTION },
        rationale: { type: 'string', description: 'The rationale the auditor chose for the decision.' },
        rationale_authorship: {
          type: 'string',
          enum: [...RATIONALE_AUTHORSHIP],
          description: 'Who wrote the rationale, reported truthfully: human_written = the auditor dictated it; agent_drafted_unedited = the auditor accepted your draft unchanged; agent_drafted_edited = the auditor changed your draft.',
        },
        agent_draft: { type: ['string', 'null'], description: 'Your draft rationale, when you wrote one (agent_drafted_*).' },
      },
      ['engagement', 'decision', 'rationale', 'rationale_authorship'],
    ),
  },
  {
    name: 'harness_request_check',
    description:
      'Send an investigation awaiting review back for another distinguishing check instead of disposing it (within its current work authorization). Records no disposition.',
    inputSchema: schema(
      {
        engagement: ENGAGEMENT,
        id: { type: 'string', description: 'The packet (pkt-...) or investigation id under review.' },
        check: { type: 'string', description: 'The missing distinguishing check, in the auditor\'s terms.' },
      },
      ['engagement', 'id', 'check'],
    ),
  },
  {
    name: 'harness_records',
    description: 'Read records of an engagement with visible rendering; IMPLEMENTED content may be withheld in read-first mode (listed in `withheld`). Use it to quote positions verbatim.',
    inputSchema: schema(
      {
        engagement: ENGAGEMENT,
        type: { type: 'string', description: 'Record type to list (e.g. investigation, packet, work_proposal, clarification, decision).' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Record ids (`id` or `id@revision`).' },
        history: { type: 'boolean', description: 'Include earlier revisions.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of records.' },
      },
      ['engagement'],
    ),
  },
  {
    name: 'harness_call',
    description: 'Run a controller operation on the auditor channel (e.g. propose or queue work, create records). Decision operations are refused here: use harness_decide.',
    inputSchema: schema(
      {
        engagement: { type: 'string', description: 'Engagement id (eng-...); omit to run the operation in the `library` scope (library-level operations).' },
        operation: { type: 'string', description: 'Operation name.' },
        payload: { type: 'object', description: 'Operation payload.' },
      },
      ['operation', 'payload'],
    ),
  },
  {
    name: 'harness_run_jobs',
    description: 'Run queued jobs of the engagement through the trusted runner, within current work authorizations.',
    inputSchema: schema({ engagement: ENGAGEMENT, max: { type: 'integer', minimum: 1, description: 'Maximum number of jobs to run.' } }, ['engagement']),
  },
  {
    name: 'harness_capture',
    description:
      "Record the auditor's own words as you relay them (clarification answers, expectation notes). The record is labelled as relayed by an agent session. Never use it for your own text.",
    inputSchema: schema(
      {
        engagement: ENGAGEMENT,
        text: { type: 'string', description: "The auditor's words, verbatim." },
        purpose: { type: 'string', description: 'What the words are for (e.g. clarification answer, expectation).' },
        unit: { type: ['string', 'null'], description: 'Audit unit (unit-...) the words concern, if any.' },
      },
      ['engagement', 'text'],
    ),
  },
  {
    name: 'harness_yolo_report',
    description:
      'The report of an unattended yolo run (the latest, or `run`): candidate findings, other packets, open questions and the decisions made without a human. Nothing in it is a finding until the auditor disposes its packet.',
    inputSchema: schema({ engagement: ENGAGEMENT, run: { type: 'string', description: 'Yolo run id (yolo-...); omit for the latest run.' } }, ['engagement']),
  },
];

const JSON_TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  null: (v) => v === null,
};

/** Check tool arguments against the tool's (flat) input schema; refusals name the argument. */
function checkArgs(tool: string, inputSchema: Record<string, unknown>, args: Record<string, unknown>): void {
  const properties = inputSchema.properties as Record<string, { type: string | string[]; enum?: readonly string[]; items?: { type: string } }>;
  for (const key of inputSchema.required as string[]) {
    if (args[key] === undefined) fail('invalid_request', `${tool}: missing argument \`${key}\``);
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key];
    if (!prop) fail('invalid_request', `${tool}: unknown argument \`${key}\` (allowed: ${Object.keys(properties).join(', ')})`);
    if (value === undefined) continue;
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    if (!types.some((t) => JSON_TYPE_CHECKS[t](value))) fail('invalid_request', `${tool}: \`${key}\` must be ${types.join(' or ')}`);
    if (prop.enum && !prop.enum.includes(value as string)) fail('invalid_request', `${tool}: \`${key}\` must be one of ${prop.enum.join(', ')}`);
    if (prop.items && !(value as unknown[]).every((v) => JSON_TYPE_CHECKS[prop.items!.type](v))) fail('invalid_request', `${tool}: \`${key}\` must hold only ${prop.items.type} values`);
  }
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

type Handler = (session: AgentReviewSession, args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult;

const HANDLERS: Record<string, Handler> = {
  harness_overview(s, a) {
    if (a.engagement === undefined) {
      const engagements = s.engagements();
      const lines = engagements.length
        ? engagements.map((e) => `- ${e.id} ${e.name}: closure ${e.closure_status}; snapshot ${e.active_snapshot ?? 'none'}; decisions needed ${e.decisions_needed}`)
        : ['No engagements.'];
      return { text: ['Engagements:', ...lines].join('\n'), structured: { engagements } };
    }
    const o = s.overview(a.engagement as string);
    const lines = [o.title, `Pending decisions (${o.decisions.length}):`];
    for (const d of o.decisions) {
      lines.push(`- ${d.id} ${d.decision_kind}${d.potential_impact ? ` [potential impact ${d.potential_impact}]` : ''}: ${d.title}`);
      for (const l of d.lines) lines.push(`    ${l}`);
    }
    if (!o.decisions.length) lines.push('  none');
    lines.push('Work:', ...(o.work.length ? o.work.map((w) => `- ${w}`) : ['  none']));
    lines.push(`Coverage gaps: ${o.gaps.count}`, ...o.gaps.first.map((g) => `- ${g}`));
    return { text: lines.join('\n'), structured: o };
  },
  harness_present(s, a) {
    const p = s.present(a.engagement as string, a.id as string, a.section === undefined ? undefined : { section: a.section as string });
    const lines = [p.text.replace(/\n+$/, '')];
    if (p.presented.length || p.remaining.length) {
      lines.push('', `Presented in this session: ${p.presented.join(', ') || 'none'}`, `Still to present before deciding: ${p.remaining.join(', ') || 'none'}`);
    }
    if (p.template) lines.push('', 'Decision template (the `decision` argument of harness_decide):', json(p.template));
    return { text: lines.join('\n'), structured: p };
  },
  harness_decide(s, a) {
    const { engagement, ...decide } = a;
    const r = s.decide(engagement as string, decide as unknown as DecideArgs);
    const lines = [`Recorded decision ${refText(r.decision)} through an agent session (display receipt ${refText(r.display_receipt)}).`];
    if (r.conditional_on.length) lines.push(`Conditional on: ${r.conditional_on.map((c) => refText(c)).join(', ')}`);
    if (r.commit) lines.push(`Commit: ${r.commit}`);
    lines.push('Result:', json(r.result));
    return { text: lines.join('\n'), structured: r };
  },
  harness_request_check(s, a) {
    const r = s.requestCheck(a.engagement as string, a.id as string, a.check as string);
    return { text: `Check requested; no disposition was recorded.\n${json(r)}`, structured: r };
  },
  harness_records(s, a) {
    const r = s.records(a.engagement as string, {
      type: a.type as string | undefined,
      ids: a.ids as string[] | undefined,
      history: a.history as boolean | undefined,
      limit: a.limit as number | undefined,
    });
    const notice = r.withheld.length ? `\nWithheld (read-first mode): ${r.withheld.join(', ')}` : '';
    return { text: json(r.records) + notice, structured: r };
  },
  harness_call(s, a) {
    const r = s.call((a.engagement as string | undefined) ?? null, a.operation as string, a.payload as Record<string, unknown>);
    return { text: json(r), structured: r };
  },
  async harness_run_jobs(s, a) {
    const r = await s.runJobs(a.engagement as string, a.max === undefined ? undefined : { max: a.max as number });
    return { text: json(r), structured: r };
  },
  harness_capture(s, a) {
    const ref = s.captureRelay(a.engagement as string, {
      text: a.text as string,
      purpose: a.purpose as string | undefined,
      unit: a.unit as string | null | undefined,
    });
    return { text: `Recorded the relayed words as ${refText(ref)} (labelled as relayed by an agent session).`, structured: ref };
  },
  harness_yolo_report(s, a) {
    const r = s.yoloReport(a.engagement as string, a.run as string | undefined);
    const head = `Yolo run ${r.run}: ${r.status}${r.exit_reason ? ` (${r.exit_reason})` : ''}`;
    return { text: r.report ? `${head}\n\n${r.report}` : `${head}\nNo report yet: the run records one with its first cycle.`, structured: r };
  },
};

/** Serve the harness MCP tools over `input`/`output` until input ends. */
export async function runHarnessMcp(opts: HarnessMcpOptions): Promise<void> {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  // Opened on first use so a missing workspace comes back to the agent as an actionable tool error;
  // the client is known only after `initialize`.
  let session: AgentReviewSession | null = null;
  const tools: McpTool[] = TOOL_SPECS.map((spec) => ({
    ...spec,
    async handler(args, ctx) {
      checkArgs(spec.name, spec.inputSchema, args);
      session ??= new AgentReviewSession({ ws: Workspace.open(opts.workspace), client: ctx.client, clock: opts.clock });
      return HANDLERS[spec.name](session, args);
    },
  }));
  await serveMcp({
    name: 'audit-harness',
    version: pkg.version,
    instructions: HARNESS_MCP_INSTRUCTIONS,
    tools,
    input: opts.input,
    output: opts.output,
    log: (line) => void opts.error.write(line + '\n'),
  });
}
