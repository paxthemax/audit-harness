import { CONTROL_SCENARIOS, runControlChecks } from '../evaluation/controls.ts';
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import '../index.ts';
import { HarnessError, isHarnessError } from '../core/errors.ts';
import { refKey, type Ref } from '../core/refs.ts';
import { DECISION_KINDS } from '../core/values.ts';
import { ROLE_PROFILES } from '../controller/roles.ts';
import { Controller, getOperation, operationNames, type CallResult, type Session } from '../controller/controller.ts';
import { Workspace } from '../controller/workspace.ts';
import { obj, str, text, arr, openObj } from '../schema/jsonschema.ts';
import {
  CONTRACT_VERSION,
  RECORD_SCHEMAS,
  RECORD_TYPES,
  SCHEMA_VERSION,
  anyRefSchema,
  artifactRefSchema,
  envelopeSchema,
  eventSchema,
  refSchema,
  type RecordEnvelope,
  type RecordType,
} from '../schema/records.ts';
import { CAPTURE_PURPOSES, runCaptureHook, runCaptureWrapper, unitRef, type CapturePurpose } from '../capture/index.ts';
import {
  acceptScopeAndPolicy,
  answerClarification,
  approveExport,
  attestCarryForward,
  authorizeWork,
  confirmInterpretations,
  genericDecision,
  ledgerTotals,
  openTrustedScreen,
  recordFlowReview,
  renderVisible,
  reviewPacket,
  ttyIO,
  adoptMethodVersion,
  evaluationOf,
  freezeEvaluationContract,
  type DecisionOutcome,
  type TrustedScreen,
} from '../screen/index.ts';
import { recordLines, refText } from '../screen/render.ts';
import { InputClosed } from '../screen/io.ts';
import { presentRecords, WITHHELD_NOTICE, type Presented } from '../screen/display.ts';
import { AnthropicProvider, OmpGateway, OmpGatewayProvider, ProviderBroker, runAuditorCommand, runConformance, runQueue, spendSummary } from '../runner/index.ts';
import { AGENT_SESSION_ADAPTERS, runAgentSession } from '../capture/agentSession.ts';

// `harness` command-line interface (docs/cli.md). Non-decision operations go through the auditor
// channel, authenticated with `<workspace>/secrets/auditor.key`. Human decisions go only through the
// trusted decision screen (`harness screen ...`), which needs an interactive terminal. The capture
// commands use the capture channel and key. Every record text printed here passes through visible
// rendering, so deceptive characters and escape sequences in record content cannot act on the terminal.
//
// Exit codes:
//   0  success
//   1  internal error (a bug or an unexpected environment failure)
//   2  usage error (unknown command or option, malformed argument); nothing was sent
//   3  refused by the controller; nothing committed (the error names the code and next action)
//   4  refused by the controller after something committed (e.g. a retained conflict)
//   5  the decision was left undecided on the trusted screen (cancelled; nothing recorded)

export const EXIT = { ok: 0, internal: 1, usage: 2, refused: 3, refused_committed: 4, undecided: 5 } as const;

class UsageError extends Error {}

interface Globals {
  workspace: string;
  json: boolean;
  engagement: string | null;
}

interface Out {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

// -----------------------------------------------------------------------------------------------
// Argument helpers

function extractGlobals(argv: string[], env: NodeJS.ProcessEnv): { g: Globals; rest: string[] } {
  const g: Globals = { workspace: env.HARNESS_WORKSPACE || './workspace', json: false, engagement: env.HARNESS_ENGAGEMENT || null };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (a === '--json') g.json = true;
    else if (a === '--workspace' || a === '-w') g.workspace = need(argv[++i], a);
    else if (a.startsWith('--workspace=')) g.workspace = a.slice(12);
    else if (a === '--engagement' || a === '-e') g.engagement = need(argv[++i], a);
    else if (a.startsWith('--engagement=')) g.engagement = a.slice(13);
    else rest.push(a);
  }
  return { g, rest };
}

function need(v: string | undefined, flag: string): string {
  if (v === undefined) throw new UsageError(`${flag} needs a value`);
  return v;
}

type Opts = NonNullable<ParseArgsConfig['options']>;

function parse<const O extends Opts>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true as const, strict: true as const });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

/** Parse a JSON argument: inline JSON or `@file`. */
function jsonArg(v: string, what: string): any {
  const src = v.startsWith('@') ? readFileSync(v.slice(1), 'utf8') : v;
  try {
    return JSON.parse(src);
  } catch (e) {
    throw new UsageError(`${what} is not valid JSON: ${(e as Error).message}`);
  }
}

/** `--set key=value` pairs; values are parsed as JSON when they parse, else kept as strings. */
function setPairs(pairs: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs ?? []) {
    const i = p.indexOf('=');
    if (i < 1) throw new UsageError(`--set expects key=value, got ${p}`);
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** `id@rev` → exact ref; bare `id` → current head (only for reads and proposals, never approvals). */
function parseRef(spec: string, store?: { headRef(id: string): Ref }): Ref {
  const m = /^([a-z]+-\d+)(?:@(\d+))?$/.exec(spec);
  if (!m) throw new UsageError(`not a record reference: ${spec} (expected id or id@revision)`);
  if (m[2]) return { record_id: m[1], revision: Number(m[2]) };
  if (!store) throw new UsageError(`${spec} needs an exact revision (id@revision)`);
  return store.headRef(m[1]);
}

// -----------------------------------------------------------------------------------------------
// Context

class Cli {
  readonly g: Globals;
  readonly out: Out;
  private wsCache: Workspace | null = null;
  private controllerCache: Controller | null = null;

  constructor(g: Globals, out: Out) {
    this.g = g;
    this.out = out;
  }

  get ws(): Workspace {
    return (this.wsCache ??= Workspace.open(this.g.workspace));
  }

  get controller(): Controller {
    return (this.controllerCache ??= new Controller(this.ws));
  }

  auditor(): Session {
    return this.controller.auditor(this.ws.readSecret('auditor.key'));
  }

  eng(): string {
    if (!this.g.engagement) throw new UsageError('this command needs --engagement <id> (or HARNESS_ENGAGEMENT)');
    return this.g.engagement;
  }

  /** Print untrusted text visibly. */
  print(s: string): void {
    this.out.stdout(renderVisible(s) + (s.endsWith('\n') ? '' : '\n'));
  }

  emit(json: unknown, human: () => void): void {
    if (this.g.json) this.out.stdout(JSON.stringify(json, null, 2) + '\n');
    else human();
  }

  call(op: string, payload: unknown, opts: { idempotency_key?: string } = {}): CallResult<any> {
    return this.auditor().call(this.eng(), op, payload, opts);
  }

  /** Call in the cross-engagement library scope. */
  callLibrary(op: string, payload: unknown): CallResult<any> {
    return this.auditor().call('library', op, payload);
  }

  /** Exact current revision of a record in the engagement (or library) store. */
  headRef(id: string, scope?: string): Ref {
    return parseRef(id, this.ws.store(scope ?? this.eng(), true));
  }

  /** Call an operation through the auditor channel and print its result. */
  callAndShow(op: string, payload: unknown, opts: { idempotency_key?: string; scope?: string } = {}): number {
    const engagement = opts.scope ?? this.eng();
    const r = this.auditor().call(engagement, op, payload, { idempotency_key: opts.idempotency_key });
    this.emit({ ok: true, operation: op, result: r.result, records: r.records, commit: r.commit, replayed: r.replayed ?? null }, () => {
      this.print(`${op}: ok${r.commit ? ` (commit ${r.commit.slice(0, 12)})` : ''}${r.replayed ? ' (idempotent repeat of an earlier request)' : ''}`);
      if (r.records.length) this.print(`records: ${r.records.map(refKey).join(', ')}`);
      this.print(JSON.stringify(r.result, null, 2));
    });
    return EXIT.ok;
  }

  async screen<T>(run: (s: TrustedScreen) => Promise<T>, scope?: string): Promise<T> {
    const io = ttyIO();
    try {
      const s = openTrustedScreen({ ws: this.ws, key: this.ws.readSecret('auditor.key'), io, engagement: scope ?? this.eng(), controller: this.controller });
      return await run(s);
    } finally {
      io.close();
    }
  }
}

function outcomeExit(o: DecisionOutcome): number {
  if (o.status === 'decided') return EXIT.ok;
  if (o.status === 'cancelled') return EXIT.undecided;
  return o.error.committed ? EXIT.refused_committed : EXIT.refused;
}

// -----------------------------------------------------------------------------------------------
// Commands

const PROPOSAL_KINDS: Record<string, string> = {
  statement: 'system_statement',
  investigation: 'investigation',
  variant: 'scenario_variant',
  clarification: 'clarification',
  interpretation: 'interpretation',
  unit: 'audit_unit',
  property: 'property',
  correspondence: 'behavioral_correspondence',
  comparison: 'behavioral_comparison',
  discrepancy: 'behavioral_discrepancy',
};

function cmdInit(cli: Cli): number {
  const ws = Workspace.init(cli.g.workspace);
  cli.emit({ ok: true, workspace: ws.root, secrets: join(ws.root, 'secrets') }, () => {
    cli.print(`Workspace created at ${ws.root}`);
    cli.print(`Secrets (0700): ${join(ws.root, 'secrets')} — auditor.key (CLI and trusted screen), capture.key (capture channel).`);
    cli.print('Never mount the workspace or its secrets into an agent tool or worker sandbox.');
    cli.print('Next: harness engagement create <id> --name ... --owner ... --purpose ...');
  });
  return EXIT.ok;
}

function cmdEngagement(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === 'create') {
    const { values, positionals } = parse(rest, {
      name: { type: 'string' },
      owner: { type: 'string' },
      purpose: { type: 'string' },
      chain: { type: 'string' },
      hardfork: { type: 'string' },
    });
    const id = positionals[0] ?? cli.g.engagement;
    if (!id) throw new UsageError('engagement create <id> --name N --owner O --purpose P');
    cli.g.engagement = id;
    return cli.callAndShow('create_engagement', {
      name: values.name,
      owner: values.owner,
      audit_purpose: values.purpose,
      chain: values.chain ?? null,
      hardfork: values.hardfork ?? null,
    });
  }
  if (sub === 'list') {
    const ids = cli.ws.engagementIds();
    const rows = ids.map((id) => {
      const e = cli.ws.store(id, true).heads('engagement')[0];
      return { id, name: e?.body.name ?? null, closure_status: e?.body.closure_status ?? null };
    });
    cli.emit({ ok: true, engagements: rows }, () => {
      if (!rows.length) cli.print('No engagements. Create one: harness engagement create <id> ...');
      for (const r of rows) cli.print(`${r.id}  ${r.closure_status}  ${r.name}`);
    });
    return EXIT.ok;
  }
  if (sub === 'show') {
    if (rest[0]) cli.g.engagement = rest[0];
    const e = cli.call('read_records', { type: 'engagement' }).result.records[0] as RecordEnvelope<'engagement'>;
    cli.emit({ ok: true, engagement: e }, () => cli.print(JSON.stringify(e, null, 2)));
    return EXIT.ok;
  }
  throw new UsageError('engagement create|list|show');
}

function heads(cli: Cli, type?: RecordType): RecordEnvelope[] {
  return cli.call('read_records', type ? { type, limit: 5000 } : { limit: 5000 }).result.records;
}

/** Home view (design/audit-harness.md, "Interaction and question design"): decisions needed, current work and spending, material gaps. */
function cmdStatus(cli: Cli): number {
  const all = heads(cli);
  const of = <T extends RecordType>(t: T) => all.filter((r) => r.type === t) as RecordEnvelope<T>[];
  const eng = of('engagement')[0];
  if (!eng) throw new HarnessError('not_found', 'engagement record missing');
  const decisions: { what: string; command: string }[] = [];
  const work: string[] = [];
  const gaps: string[] = [];
  const e = eng.body;
  if (!e.policy) decisions.push({ what: 'Scope and policy not accepted', command: `harness screen accept_scope_and_policy -e ${cli.eng()} --draft policy.json` });
  for (const i of of('interpretation').filter((x) => x.body.status === 'proposed')) {
    decisions.push({ what: `Interpretation ${i.record_id} awaits confirmation: "${i.body.proposed.statement}"`, command: `harness screen confirm_interpretations -e ${cli.eng()}` });
  }
  const clars = of('clarification')
    .filter((c) => ['queued', 'presented', 'held'].includes(c.body.status))
    .sort((a, b) => b.body.priority - a.body.priority);
  for (const c of clars) decisions.push({ what: `Clarification ${c.record_id} (${c.body.status}, priority ${c.body.priority}): ${c.body.issue}`, command: `harness screen answer_clarification ${c.record_id} -e ${cli.eng()}` });
  const packets = of('review_packet');
  for (const inv of of('investigation').filter((x) => x.body.work_state === 'ready_for_review' && !x.body.disposition)) {
    const p = packets.filter((x) => x.body.investigation.record_id === inv.record_id).pop();
    decisions.push({
      what: `Investigation ${inv.record_id} ready for review (potential impact ${inv.body.potential_impact.effective}): ${inv.body.question}`,
      command: p ? `harness screen packet ${p.record_id} -e ${cli.eng()}` : '(no packet yet)',
    });
  }
  const authorized = new Set(of('work_authorization').flatMap((a) => a.body.reviewed.map((r) => r.record_id)));
  for (const wp of of('work_proposal').filter((x) => !authorized.has(x.record_id))) {
    decisions.push({ what: `Work proposal ${wp.record_id} (${wp.body.kind}, ${wp.body.investigations.length} investigation(s)) awaits authorization`, command: `harness screen authorize_work ${wp.record_id} -e ${cli.eng()}` });
  }
  const fresh = of('conclusion_freshness');
  const unattested = fresh.filter((f) => f.body.value === 'carried_forward_mechanical' && !f.body.attestation);
  if (unattested.length) decisions.push({ what: `${unattested.length} conclusion(s) carried forward mechanically, unattested`, command: `harness screen attest_carry_forward -e ${cli.eng()}` });
  for (const f of fresh.filter((x) => x.body.value === 'affected')) decisions.push({ what: `Conclusion ${refText(f.body.conclusion)} is affected by a change (recheck at stage 04)`, command: `harness screen decide reaffirm --record ${f.body.conclusion.record_id} -e ${cli.eng()} --inputs @inputs.json` });
  for (const m of of('report_manifest').filter((x) => x.body.status === 'preview')) decisions.push({ what: `Export preview ${m.record_id} for ${m.body.audience}`, command: `harness screen approve_export ${m.record_id} -e ${cli.eng()}` });
  for (const c of of('proposal_conflict').filter((x) => x.body.status === 'open')) decisions.push({ what: `Proposal conflict ${c.record_id} on ${c.body.target} (expected r${c.body.expected_revision}, actual r${c.body.actual_revision})`, command: `harness show ${c.record_id} -e ${cli.eng()}` });

  // Current work and spending.
  const ctl = of('control_state')[0];
  if (ctl?.body.paused) work.push(`PAUSED by ${ctl.body.by}: ${ctl.body.reason}`);
  for (const s of ctl?.body.stopped ?? []) if (s.termination === 'unconfirmed') work.push(`Termination UNCONFIRMED for attempt ${refText(s.attempt)}: no overlapping replacement is admitted`);
  const byState = new Map<string, number>();
  for (const i of of('investigation')) byState.set(i.body.work_state, (byState.get(i.body.work_state) ?? 0) + 1);
  work.push(`Investigations by work state: ${[...byState].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  for (const j of of('job').filter((x) => ['queued', 'running', 'outcome_unknown'].includes(x.body.status))) {
    work.push(`Job ${j.record_id} ${j.body.status}: ${j.body.purpose} via ${j.body.adapter.name}${j.body.investigation ? ` for ${j.body.investigation.record_id}` : ''}; attempts ${j.body.attempts.map((a) => a.record_id).join(', ') || 'none'}`);
  }
  const t = ledgerTotals(of('ledger_entry'));
  const unit = e.policy?.budget.unit ?? 'units';
  work.push(`Spending (all ledger entries, ${unit}): actual ${t.spent}; reserved outstanding ${t.reserved}; uncertain ${t.uncertain}; engagement budget ${e.policy ? e.policy.budget.total : 'not set'}`);
  for (const a of of('work_authorization').filter((x) => x.body.status === 'active')) {
    const sp = spendSummary(cli.ws.store(cli.eng(), true), a.record_id);
    work.push(
      `Authorization ${a.record_id} (${a.body.kind}) active: limit ${sp.limit}; confirmed ${sp.confirmed}; estimated ${sp.estimated}; uncertain ${sp.uncertain}; remaining ${sp.remaining}; ${a.body.investigations.length} investigation(s)${a.body.validity ? `; valid until ${a.body.validity.until}` : ''}`,
    );
  }

  if (getOperation('batch_status')) {
    for (const l of batchLines(cli.call('batch_status', {}).result as BatchView)) work.push(l);
  }

  // Material gaps.
  if (!e.active_snapshot) gaps.push(`No target snapshot registered (harness snapshot register <path> -e ${cli.eng()})`);
  for (const [k, v] of Object.entries(e.ecosystem)) if (v && typeof v === 'object' && (v as { unknown?: boolean }).unknown) gaps.push(`Unknown ${k}: ${(v as { reason: string }).reason}`);
  for (const u of of('audit_unit')) {
    if (u.body.review_status === 'not_started' || u.body.review_status === 'partial') gaps.push(`Audit unit ${u.record_id} "${u.body.name}" (${u.body.kind}) is ${u.body.review_status}`);
    for (const g of u.body.gaps) gaps.push(`Unit ${u.record_id}: ${g}`);
    const unreviewed = u.body.functions.filter((f) => !f.reviewed);
    if (unreviewed.length) gaps.push(`Unit ${u.record_id}: ${unreviewed.length} function(s) not reviewed: ${unreviewed.map((f) => f.name).join(', ')}`);
  }
  for (const f of of('suspicious_flag').filter((x) => !x.body.acknowledged)) gaps.push(`Suspicious content ${f.record_id} (${f.body.kind}) at ${f.body.path}:${f.body.line}: ${f.body.excerpt}`);
  for (const f of fresh.filter((x) => x.body.value === 'possibly_affected')) gaps.push(`Conclusion ${refText(f.body.conclusion)} possibly affected (flagged, not blocking)`);
  for (const s of of('target_snapshot')) for (const l of s.body.limitations) gaps.push(`Snapshot ${s.record_id}: ${l}`);

  cli.emit({ ok: true, engagement: cli.eng(), decisions_needed: decisions, current_work: work, material_gaps: gaps }, () => {
    cli.print(`Engagement ${cli.eng()}: ${e.name} [${e.closure_status}]   Active snapshot: ${refText(e.active_snapshot)}${e.read_first && !e.read_first.ended_at ? '   READ-FIRST MODE ACTIVE' : ''}`);
    if (!e.policy && !e.active_snapshot) cli.print('Empty engagement: no scope, policy or snapshot yet. Progress is not inferred.');
    cli.print(`\nDecisions needed (${decisions.length}):`);
    if (!decisions.length) cli.print('  none');
    for (const d of decisions) cli.print(`  - ${d.what}\n      ${d.command}`);
    cli.print('\nCurrent work and spending:');
    for (const w of work) cli.print(`  - ${w}`);
    cli.print(`\nMaterial gaps (${gaps.length}):`);
    if (!gaps.length) cli.print('  none recorded');
    for (const g of gaps) cli.print(`  - ${g}`);
  });
  return EXIT.ok;
}

/**
 * The auditor interface presents records here. IMPLEMENTED behavior (implemented/shared statements,
 * correspondences mapping implemented statements, implemented/comparison KB diagrams) is withheld while
 * read-first mode is active; otherwise presenting it is recorded with `record_display` on the auditor
 * channel, naming the audit units, so the controller derives intent timing from the first presentation
 * (glossary, "Intent timing"). The receipt is committed before anything is printed.
 */
function present(cli: Cli, envs: RecordEnvelope[], section: string): Presented {
  return presentRecords(cli.auditor(), cli.eng(), envs, section);
}

function withheldLines(cli: Cli, w: { record_id: string; revision: number; type: string }[]): void {
  for (const x of w) cli.print(`${x.type} ${x.record_id}@${x.revision} — ${WITHHELD_NOTICE}`);
}

function cmdRecords(cli: Cli, args: string[]): number {
  const { values } = parse(args, { type: { type: 'string' }, id: { type: 'string', multiple: true }, history: { type: 'boolean' }, limit: { type: 'string' } });
  const payload: Record<string, unknown> = {};
  if (values.type) payload.type = values.type;
  if (values.id) payload.ids = values.id;
  if (values.history) payload.history = true;
  if (values.limit) payload.limit = Number(values.limit);
  const r = cli.call('read_records', payload).result as { records: RecordEnvelope[]; truncated: boolean };
  const p = present(cli, r.records, 'cli:records');
  cli.emit({ ok: true, records: p.shown, truncated: r.truncated, withheld: p.withheld, display_receipt: p.display_receipt }, () => {
    for (const env of p.shown) cli.print(recordLines(env).join('\n'));
    withheldLines(cli, p.withheld);
    cli.print(`(${p.shown.length} record(s) shown${p.withheld.length ? `, ${p.withheld.length} withheld` : ''}${r.truncated ? ', truncated' : ''})`);
  });
  return EXIT.ok;
}

function cmdShow(cli: Cli, args: string[]): number {
  const spec = args[0];
  if (!spec) throw new UsageError('show <id>[@revision]');
  const m = /^([a-z]+-\d+)(?:@(\d+))?$/.exec(spec);
  if (!m) throw new UsageError(`not a record reference: ${spec}`);
  const payload = m[2] ? { refs: [{ record_id: m[1], revision: Number(m[2]) }] } : { ids: [m[1]] };
  const env = cli.call('read_records', payload).result.records[0] as RecordEnvelope;
  const p = present(cli, [env], 'cli:show');
  if (p.withheld.length) {
    throw new HarnessError('permission_denied', `${env.record_id}@${env.revision} presents IMPLEMENTED behavior and is ${WITHHELD_NOTICE}`, {
      ref: { record_id: env.record_id, revision: env.revision },
    });
  }
  cli.emit({ ok: true, record: env, display_receipt: p.display_receipt }, () => cli.print(JSON.stringify(env, null, 2)));
  return EXIT.ok;
}

function cmdPropose(cli: Cli, noun: string, args: string[]): number {
  const kind = PROPOSAL_KINDS[noun];
  const [sub, ...rest] = args;
  if (sub !== 'propose') throw new UsageError(`${noun} propose [--file body.json | --body JSON] [--set k=v ...] [--base id@rev]`);
  const { values } = parse(rest, { file: { type: 'string' }, body: { type: 'string' }, set: { type: 'string', multiple: true }, base: { type: 'string' }, 'idempotency-key': { type: 'string' } });
  const body = {
    ...(values.file ? jsonArg('@' + values.file, '--file') : {}),
    ...(values.body ? jsonArg(values.body, '--body') : {}),
    ...setPairs(values.set),
  };
  const payload: Record<string, unknown> = { kind, body };
  if (values.base) payload.base = parseRef(values.base);
  return cli.callAndShow('submit_proposal', payload, { idempotency_key: values['idempotency-key'] });
}

/** Thin wrapper: `--payload JSON|@file` merged with `--set` pairs and fixed fields. */
function payloadOf(values: { payload?: string; file?: string; set?: string[] }, fixed: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(values.file ? jsonArg('@' + values.file, '--file') : {}),
    ...(values.payload ? jsonArg(values.payload, '--payload') : {}),
    ...setPairs(values.set),
    ...fixed,
  };
}

const PAYLOAD_OPTS = { payload: { type: 'string' }, file: { type: 'string' }, set: { type: 'string', multiple: true }, 'idempotency-key': { type: 'string' } } as const satisfies Opts;

function cmdSnapshot(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub !== 'register') throw new UsageError('snapshot register <path> [--label L] [--payload JSON|@file]');
  const { values, positionals } = parse(rest, { ...PAYLOAD_OPTS, label: { type: 'string' } });
  if (positionals.length !== 1) throw new UsageError('snapshot register needs exactly one source path (deployment, fork and upstream copies go in --payload)');
  const path = resolve(positionals[0]);
  return cli.callAndShow('register_snapshot', payloadOf(values, { path, label: values.label ?? basename(path) }), {
    idempotency_key: values['idempotency-key'] as string | undefined,
  });
}

async function cmdWork(cli: Cli, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'prepare') {
    const { values } = parse(rest, { ...PAYLOAD_OPTS, kind: { type: 'string' }, investigation: { type: 'string', multiple: true }, method: { type: 'string', multiple: true } });
    const store = cli.ws.store(cli.eng(), true);
    const fixed: Record<string, unknown> = {};
    if (values.kind) fixed.kind = values.kind;
    if (values.investigation) fixed.investigations = (values.investigation as string[]).map((s) => parseRef(s, store));
    if (values.method) fixed.methods = values.method;
    return cli.callAndShow('prepare_work', payloadOf(values, fixed));
  }
  if (sub === 'authorize') return cmdScreen(cli, ['authorize_work', ...rest]);
  throw new UsageError('work prepare|authorize');
}

async function cmdJob(cli: Cli, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { values, positionals } = parse(rest, { ...PAYLOAD_OPTS, reason: { type: 'string' }, max: { type: 'string' }, 'live-providers': { type: 'string' } });
  switch (sub) {
    case 'request':
      return cli.callAndShow('request_job', payloadOf(values));
    case 'pause':
    case 'resume':
      return cli.callAndShow(sub, payloadOf(values, values.reason ? { reason: values.reason } : {}));
    case 'cancel':
      return cli.callAndShow('cancel', payloadOf(values, { ...(positionals[0] ? { job: positionals[0] } : {}), ...(values.reason ? { reason: values.reason } : {}) }));
    case 'run': {
      ensureBroker(cli, values['live-providers'] as string | undefined);
      const r = await runQueue(cli.controller, cli.eng(), values.max ? { maxJobs: Number(values.max) } : {});
      cli.emit({ ok: true, result: r }, () => {
        cli.print(`Queue stopped: ${r.stopped}; ${r.ran.length} attempt(s) ran.`);
        for (const a of r.ran) cli.print(`  job ${a.job} attempt ${refText(a.attempt)}: ${a.status}; evidence ${refText(a.evidence)} (eligible: ${a.eligible ? 'yes' : 'no'})`);
        for (const k of r.skipped) cli.print(`  skipped job ${k.job}: ${k.code}: ${k.reason}`);
      });
      return EXIT.ok;
    }
  }
  throw new UsageError('job request|run|pause|cancel|resume');
}

async function cmdScreen(cli: Cli, args: string[]): Promise<number> {
  const [kind, ...rest] = args;
  const { values, positionals } = parse(rest, {
    draft: { type: 'string' },
    snapshot: { type: 'string' },
    destination: { type: 'string' },
    record: { type: 'string', multiple: true },
    inputs: { type: 'string' },
    operation: { type: 'string' },
    evaluation: { type: 'string' },
    rollback: { type: 'boolean' },
  });
  const run = (fn: (s: TrustedScreen) => Promise<DecisionOutcome>) => cli.screen(fn).then(outcomeExit);
  switch (kind) {
    case 'packet':
    case 'dispose_investigation':
      if (!positionals[0]) throw new UsageError('screen packet <packet-id>');
      return run((s) => reviewPacket(s, positionals[0]));
    case 'confirm_interpretations':
      return run((s) => confirmInterpretations(s, positionals));
    case 'answer_clarification':
      return run((s) => answerClarification(s, positionals[0]));
    case 'accept_scope_and_policy':
      return run((s) => acceptScopeAndPolicy(s, values.draft ? jsonArg('@' + values.draft, '--draft') : {}));
    case 'authorize_work':
      if (!positionals[0]) throw new UsageError('screen authorize_work <work-proposal-id> [--draft limits.json]');
      return run((s) => authorizeWork(s, positionals[0], values.draft ? jsonArg('@' + values.draft, '--draft') : {}));
    case 'record_flow_review':
      if (!positionals[0]) throw new UsageError('screen record_flow_review <audit-unit-id>');
      return run((s) => recordFlowReview(s, positionals[0]));
    case 'attest_carry_forward':
      return run((s) => attestCarryForward(s, values.snapshot));
    case 'approve_export':
      if (!positionals[0]) throw new UsageError('screen approve_export <report-manifest-id> [--destination D]');
      return run((s) => approveExport(s, positionals[0], values.destination));
    case 'freeze_evaluation_contract': {
      if (!positionals[0]) throw new UsageError('screen freeze_evaluation_contract <evalc-id>');
      const o = await cli.screen((s) => freezeEvaluationContract(s, positionals[0]), 'library');
      return o.status === 'frozen' ? EXIT.ok : o.status === 'cancelled' ? EXIT.undecided : o.error.committed ? EXIT.refused_committed : EXIT.refused;
    }
    case 'adopt_method_version': {
      if (!positionals[0]) throw new UsageError('screen adopt_method_version <method-id> [--evaluation held-out.json] [--rollback]');
      const ev = values.evaluation ? evaluationOf(jsonArg('@' + values.evaluation, '--evaluation')) : null;
      return cli.screen((s) => adoptMethodVersion(s, positionals[0], ev, !!values.rollback), 'library').then(outcomeExit);
    }
    case 'decide': {
      const k = positionals[0];
      if (!k || !(DECISION_KINDS as readonly string[]).includes(k)) throw new UsageError(`screen decide <kind> --record id[@rev] ... --inputs JSON|@file; kinds: ${DECISION_KINDS.join(', ')}`);
      if (!values.record?.length || !values.inputs) throw new UsageError('screen decide needs --record and --inputs');
      const op = values.operation ?? (['authorize_work', 'revise_premise', 'approve_export'].includes(k) ? k : 'record_decision');
      return run((s) => genericDecision(s, k, values.record as string[], jsonArg(values.inputs as string, '--inputs'), op));
    }
  }
  throw new UsageError(
    'screen packet|confirm_interpretations|answer_clarification|accept_scope_and_policy|authorize_work|record_flow_review|attest_carry_forward|approve_export|freeze_evaluation_contract|adopt_method_version|decide',
  );
}

async function cmdExport(cli: Cli, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'approve') return cmdScreen(cli, ['approve_export', ...rest]);
  const { values, positionals } = parse(rest, { ...PAYLOAD_OPTS, destination: { type: 'string' } });
  if (sub === 'prepare') return cli.callAndShow('prepare_export', payloadOf(values));
  if (sub === 'bundle') {
    const fixed: Record<string, unknown> = {};
    if (positionals[0]) fixed.report_manifest = parseRef(positionals[0], cli.ws.store(cli.eng(), true));
    if (values.destination) fixed.destination = resolve(values.destination as string);
    return cli.callAndShow('export_bundle', payloadOf(values, fixed));
  }
  throw new UsageError('export prepare|approve|bundle');
}

function cmdSchemas(cli: Cli, args: string[]): number {
  const { values } = parse(args, { out: { type: 'string' } });
  if (!values.out) throw new UsageError('schemas --out <dir>');
  const dir = resolve(values.out);
  mkdirSync(join(dir, 'records'), { recursive: true });
  const files: string[] = [];
  const write = (rel: string, title: string, schema: object) => {
    const doc = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `urn:audit-harness:schema:${rel.replace(/\.schema\.json$/, '').replace(/\//g, ':')}:v${SCHEMA_VERSION}`, title, ...schema };
    writeFileSync(join(dir, rel), JSON.stringify(doc, null, 2) + '\n');
    files.push(rel);
  };
  for (const t of RECORD_TYPES) write(`records/${t}.schema.json`, `${t} record body (schema version ${SCHEMA_VERSION})`, RECORD_SCHEMAS[t]);
  write('envelope.schema.json', 'Record envelope common to every record', envelopeSchema);
  write('event.schema.json', 'Operational event envelope', eventSchema);
  write('ref.schema.json', 'Exact record reference', refSchema);
  write('artifact-ref.schema.json', 'Content-addressed artifact reference', artifactRefSchema);
  write('any-ref.schema.json', 'Record or artifact reference', anyRefSchema);
  write(
    'request.schema.json',
    `Controller request envelope (contract version ${CONTRACT_VERSION})`,
    obj({
      contract_version: { const: CONTRACT_VERSION },
      request_id: text(),
      idempotency_key: { anyOf: [str(), { type: 'null' }] },
      engagement_id: text(),
      operation: text(),
      expected_revisions: arr(refSchema),
      payload: openObj('operation-specific payload'),
    }),
  );
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({ contract_version: CONTRACT_VERSION, schema_version: SCHEMA_VERSION, record_types: RECORD_TYPES, files }, null, 2) + '\n',
  );
  cli.emit({ ok: true, out: dir, files: [...files, 'index.json'] }, () => cli.print(`Wrote ${files.length + 1} schema files to ${dir}`));
  return EXIT.ok;
}

async function cmdCapture(cli: Cli, args: string[]): Promise<number> {
  const dash = args.indexOf('--');
  const own = dash >= 0 ? args.slice(0, dash) : args;
  const forward = dash >= 0 ? args.slice(dash + 1) : null;
  const { values } = parse(own, { purpose: { type: 'string' }, unit: { type: 'string' }, once: { type: 'boolean' } });
  const purpose = (values.purpose ?? 'conversation') as CapturePurpose;
  if (!CAPTURE_PURPOSES.includes(purpose)) throw new UsageError(`--purpose must be one of ${CAPTURE_PURPOSES.join(', ')}`);
  if (purpose === 'expectations_pre_step' && !values.unit) throw new UsageError('the expectations pre-step names its flow: --unit <audit-unit-id>');
  const io = ttyIO();
  try {
    const refs = await runCaptureWrapper({
      ws: cli.ws,
      engagement: cli.eng(),
      io,
      purpose,
      audit_unit: values.unit ? unitRef(cli.ws, cli.eng(), values.unit) : null,
      once: values.once ?? purpose !== 'conversation',
      forward: forward?.length ? forward : null,
      controller: cli.controller,
    });
    if (cli.g.json) cli.out.stdout(JSON.stringify({ ok: true, captured: refs }) + '\n');
    return EXIT.ok;
  } finally {
    io.close();
  }
}

async function cmdCaptureHook(cli: Cli): Promise<number> {
  // Never write to stdout: Claude Code adds a UserPromptSubmit hook's stdout to the model's context.
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let ws: Workspace;
  try {
    ws = cli.ws;
    cli.eng();
  } catch (e) {
    cli.out.stderr(`harness capture-hook: ${(e as Error).message}; nothing captured\n`);
    return EXIT.ok;
  }
  return runCaptureHook({ ws, engagement: cli.eng(), input, log: cli.out.stderr });
}

function cmdCall(cli: Cli, args: string[]): number {
  const { values, positionals } = parse(args, { ...PAYLOAD_OPTS, library: { type: 'boolean' } });
  const op = positionals[0];
  if (!op) throw new UsageError(`call <operation> [--payload JSON|@file]; registered: ${operationNames().join(', ')}`);
  const def = getOperation(op);
  if (def && !def.channels.includes('auditor')) {
    throw new HarnessError('permission_denied', `${op} is not available on the auditor channel (channels: ${def.channels.join(', ')}); human decisions use \`harness screen\``, { operation: op });
  }
  const scope = values.library ? 'library' : undefined;
  if (op === 'read_records' && !scope) {
    // Same presentation rule as `records`: IMPLEMENTED behavior is withheld or receipted.
    const r = cli.call('read_records', payloadOf(values)).result as { records: RecordEnvelope[]; truncated: boolean };
    const p = present(cli, r.records, 'cli:call:read_records');
    cli.emit({ ok: true, operation: op, result: { records: p.shown, truncated: r.truncated, withheld: p.withheld }, display_receipt: p.display_receipt }, () => {
      cli.print(JSON.stringify({ records: p.shown, truncated: r.truncated }, null, 2));
      withheldLines(cli, p.withheld);
    });
    return EXIT.ok;
  }
  return cli.callAndShow(op, payloadOf(values), { idempotency_key: values['idempotency-key'] as string | undefined, scope });
}

// -----------------------------------------------------------------------------------------------
// Agents, positions, fixtures, batches

/**
 * The provider broker for agent jobs run by this process. A broker already active in the process is
 * used as is; otherwise one is created with the workspace's configured providers: an external
 * provider's credential is read from `secrets/providers/<name>.key`; `omp_gateway` providers share one
 * `omp auth-gateway stdio` child per binary and profile, which holds the logins itself. Which providers
 * may receive live-exploitable material is an operator choice (`--live-providers`); by default none may.
 */
function ensureBroker(cli: Cli, live: string | undefined): void {
  if (ProviderBroker.active()) return;
  const b = new ProviderBroker(cli.controller, { liveExploitableProviders: live ? live.split(',').filter(Boolean) : [] });
  const gateways = new Map<string, OmpGateway>();
  for (const p of cli.ws.config.providers) {
    if (p.kind === 'external' && p.name === 'anthropic') b.registerFromWorkspace(new AnthropicProvider());
    else if (p.kind === 'omp_gateway') {
      if (!p.omp) throw new UsageError(`provider ${p.name}: an omp_gateway provider needs its omp settings in harness.json`);
      const key = JSON.stringify([p.omp.binary, p.omp.version, p.omp.profile]);
      let gw = gateways.get(key);
      if (!gw) gateways.set(key, (gw = new OmpGateway({ binary: p.omp.binary, version: p.omp.version, profile: p.omp.profile })));
      b.registerSelfAuthenticating(new OmpGatewayProvider(gw, { name: p.name, upstream: p.omp.upstream, models: p.models, rates: p.omp.rates, headroom: p.omp.headroom }));
    }
  }
}

async function cmdAgentSession(cli: Cli, rest: string[]): Promise<number> {
  const { values, positionals } = parse(rest, {
    model: { type: 'string' },
    investigation: { type: 'string' },
    authorization: { type: 'string' },
    adapter: { type: 'string' },
    'max-turns': { type: 'string' },
    'source-path': { type: 'string', multiple: true },
    'live-providers': { type: 'string' },
  });
  const role = positionals[0];
  if (!role || !values.model) throw new UsageError(`agent session <role> --model M [--investigation inv-N] [--authorization auth-N] [--adapter ${AGENT_SESSION_ADAPTERS.join('|')}] [--max-turns N]`);
  const adapter = (values.adapter ?? 'reference_agent') as (typeof AGENT_SESSION_ADAPTERS)[number];
  if (!AGENT_SESSION_ADAPTERS.includes(adapter)) throw new UsageError(`--adapter must be one of ${AGENT_SESSION_ADAPTERS.join(', ')}`);
  ensureBroker(cli, values['live-providers']);
  const io = ttyIO();
  try {
    const entries = await runAgentSession({
      ws: cli.ws,
      engagement: cli.eng(),
      io,
      role,
      model: values.model,
      investigation: values.investigation ?? null,
      authorization: values.authorization ?? null,
      adapter,
      max_turns: values['max-turns'] ? Number(values['max-turns']) : null,
      source_paths: values['source-path'],
      controller: cli.controller,
    });
    if (cli.g.json) cli.out.stdout(JSON.stringify({ ok: true, entries }) + '\n');
    return EXIT.ok;
  } finally {
    io.close();
  }
}

async function cmdAgent(cli: Cli, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'session') return cmdAgentSession(cli, rest);
  if (sub === 'roles') {
    const roles = Object.values(ROLE_PROFILES);
    cli.emit({ ok: true, roles }, () => {
      for (const r of roles) {
        cli.print(`${r.role}\n  receives: ${r.receives}\n  produces: ${r.produces}\n  may not decide: ${r.mayNotDecide}\n  operations: ${r.operations.join(', ') || '(none: the trusted runner executes it)'}`);
      }
    });
    return EXIT.ok;
  }
  if (sub !== 'run') throw new UsageError('agent roles | agent run <role> --task T --model M [--investigation inv-N] [--max-turns N] [--authorization auth-N]');
  const { values, positionals } = parse(rest, {
    task: { type: 'string' },
    model: { type: 'string' },
    investigation: { type: 'string' },
    'max-turns': { type: 'string' },
    authorization: { type: 'string' },
  });
  const role = positionals[0];
  const profile = role ? ROLE_PROFILES[role] : undefined;
  if (!profile || profile.role === 'tool') throw new UsageError(`agent run <role>: one of ${Object.keys(ROLE_PROFILES).filter((r) => r !== 'tool').join(', ')}`);
  if (!values.task || !values.model) throw new UsageError('agent run needs --task and --model');
  const store = cli.ws.store(cli.eng(), true);
  const inv = values.investigation ? store.mustHead(values.investigation.split('@')[0], 'investigation') : null;
  const invRef = inv ? { record_id: inv.record_id, revision: inv.revision } : null;
  const eng = store.heads('engagement')[0];
  if (!eng?.body.active_snapshot) throw new HarnessError('invalid_request', 'register a target snapshot before running an agent');
  // The authorization: named, else the investigation's, else the single current one.
  let authorization: Ref | null = values.authorization ? cli.headRef(values.authorization) : (inv?.body.authorization ?? null);
  if (!authorization) {
    const active = store.heads('work_authorization').filter((a) => a.body.status === 'active');
    if (active.length !== 1) throw new UsageError(`name the work authorization with --authorization (${active.length} active)`);
    authorization = { record_id: active[0].record_id, revision: active[0].revision };
  }
  const ctxRes = cli.call('build_context', { role: profile.contextRole, investigation: invRef }).result as { context_manifest: { artifact: string }; records: number; withheld: number; retrieved: number; truncated: number };
  const args2: Record<string, unknown> = { task: values.task, model: values.model };
  if (values['max-turns']) args2.max_turns = Number(values['max-turns']);
  const job = cli.call('request_job', {
    authorization,
    purpose: 'agent',
    adapter: 'reference_agent',
    role: profile.role,
    snapshot: eng.body.active_snapshot,
    investigation: invRef,
    context_manifest: ctxRes.context_manifest,
    args: args2,
  });
  cli.emit({ ok: true, context: ctxRes, result: job.result, records: job.records }, () => {
    cli.print(`Context for ${profile.contextRole}: ${ctxRes.context_manifest.artifact} (${ctxRes.records} records, ${ctxRes.withheld} withheld, ${ctxRes.retrieved} retrieved, ${ctxRes.truncated} truncated)`);
    cli.print(`Agent job queued: ${JSON.stringify(job.result)}`);
    cli.print(`Role ${profile.role} may not decide: ${profile.mayNotDecide}. Run it with: harness job run -e ${cli.eng()}`);
  });
  return EXIT.ok;
}

function cmdPosition(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  const { values } = parse(rest, { investigation: { type: 'string' }, role: { type: 'string' }, file: { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' } });
  if (sub !== 'submit' || !values.investigation || !values.file || !['author', 'challenger'].includes(values.role ?? '')) {
    throw new UsageError('position submit --investigation inv-N --role author|challenger --file text.md [--model M --provider P]');
  }
  return cli.callAndShow('submit_position', {
    investigation: cli.headRef(values.investigation),
    role: values.role,
    text: readFileSync(values.file, 'utf8'),
    ...(values.model ? { model: values.model } : {}),
    ...(values.provider ? { provider: values.provider } : {}),
  });
}

/** Files under the given paths (directories walked), keyed by their path relative to `root`. */
function inlineFiles(paths: string[], root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (abs: string) => {
    if (statSync(abs).isDirectory()) {
      for (const n of readdirSync(abs).sort()) add(join(abs, n));
      return;
    }
    const rel = relative(root, abs);
    if (rel.startsWith('..') || rel.startsWith(sep)) throw new UsageError(`${abs} is outside --root ${root}`);
    out[rel.split(sep).join('/')] = readFileSync(abs, 'utf8');
  };
  for (const p of paths) add(resolve(p));
  return out;
}

function cmdFixture(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  const { values, positionals } = parse(rest, { investigation: { type: 'string' }, root: { type: 'string' } });
  if (sub !== 'submit' || !positionals.length) throw new UsageError('fixture submit [--investigation inv-N] [--root DIR] <path>...');
  const files = inlineFiles(positionals, resolve(values.root ?? '.'));
  const r = cli.call('submit_fixture', { files, ...(values.investigation ? { investigation: cli.headRef(values.investigation) } : {}) });
  const res = r.result as { fixture: { artifact: string }; overrides_target: string[]; added: string[] };
  cli.emit({ ok: true, result: res, records: r.records, commit: r.commit }, () => fixtureLines(res, Object.keys(files).length).forEach((l) => cli.print(l)));
  if (res.overrides_target.length && cli.g.json) cli.out.stderr(`WARNING: fixture overrides target files: ${res.overrides_target.join(', ')}\n`);
  return EXIT.ok;
}

/** Fixture summary; target overrides come first, as a warning. */
export function fixtureLines(res: { fixture: { artifact: string }; overrides_target: string[]; added: string[] }, files: number): string[] {
  const out: string[] = [];
  if (res.overrides_target.length) {
    out.push(`WARNING: this fixture OVERRIDES ${res.overrides_target.length} target file(s); runs with it do not test the original target bytes, and a setup that edits the target cannot silently support a permissionless claim:`);
    for (const f of res.overrides_target) out.push(`  OVERRIDES TARGET: ${f}`);
  }
  out.push(`Fixture ${res.fixture.artifact}: ${files} file(s)`);
  for (const f of res.added) out.push(`  adds: ${f}`);
  return out;
}

interface BatchView {
  batches: { authorization: Ref; kind: string; status: string; investigations: { ref: Ref; work_state: string; disposition: string | null }[]; jobs: Record<string, number>; spend: { used: number; limit: number }; runtime: { used: number; limit: number } }[];
  next_job: Ref | null;
  held: { job: string; reason: string }[];
  review_queue: { ready: number; capacity: number | null; discovery_paused: boolean };
}

function batchLines(v: BatchView): string[] {
  const out: string[] = [];
  for (const b of v.batches) {
    out.push(
      `Batch ${refText(b.authorization)} (${b.kind}) ${b.status}: spend ${b.spend.used}/${b.spend.limit}; runtime ${b.runtime.used}/${b.runtime.limit} s; jobs ${Object.entries(b.jobs).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; investigations ${b.investigations.map((i) => `${i.ref.record_id} ${i.work_state}${i.disposition ? `/${i.disposition}` : ''}`).join(', ') || 'none'}`,
    );
  }
  out.push(`Next job: ${v.next_job ? refText(v.next_job) : 'none'}`);
  for (const h of v.held) out.push(`Held job ${h.job}: ${h.reason}`);
  const q = v.review_queue;
  out.push(`Review queue: ${q.ready} ready / capacity ${q.capacity ?? 'not set'}${q.discovery_paused ? ' — DISCOVERY PAUSED (review queue full)' : ''}`);
  return out;
}

function cmdBatch(cli: Cli, args: string[]): number {
  if (args[0] === 'status') {
    const v = cli.call('batch_status', {}).result as BatchView;
    cli.emit({ ok: true, ...v }, () => batchLines(v).forEach((l) => cli.print(l)));
    return EXIT.ok;
  }
  if (args[0] === 'reconcile') return cli.callAndShow('reconcile_batches', {});
  throw new UsageError('batch status|reconcile');
}

// -----------------------------------------------------------------------------------------------
// Evaluation, conformance and methods (library scope)

function libraryRef(cli: Cli, id: string): Ref {
  return parseRef(id, cli.ws.store('library', true));
}

function showLibrary(cli: Cli, op: string, payload: unknown): number {
  return cli.callAndShow(op, payload, { scope: 'library' });
}

function cmdEval(cli: Cli, args: string[]): number {
  const [a, b, ...rest] = args;
  if (a === 'contract' && b === 'propose') {
    const { values } = parse(rest, { file: { type: 'string' } });
    if (!values.file) throw new UsageError('eval contract propose --file contract.json');
    return showLibrary(cli, 'propose_evaluation_contract', jsonArg('@' + values.file, '--file'));
  }
  if (a === 'report') {
    const { values } = parse([b, ...rest].filter((x) => x !== undefined), { contract: { type: 'string' }, matches: { type: 'string' } });
    if (!values.contract) throw new UsageError('eval report --contract evalc-N [--matches matches.json]');
    return showLibrary(cli, 'evaluation_report', { contract: libraryRef(cli, values.contract), ...(values.matches ? { matches: jsonArg('@' + values.matches, '--matches') } : {}) });
  }
  if (a === 'canary' && b === 'register') {
    const { values } = parse(rest, { packet: { type: 'string' }, kind: { type: 'string' } });
    if (!values.packet || !values.kind) throw new UsageError('eval canary register -e ENGAGEMENT --packet pkt-N --kind K');
    return showLibrary(cli, 'register_canary', { engagement: cli.eng(), packet: cli.headRef(values.packet), kind: values.kind });
  }
  if (a === 'canary' && b === 'score') return showLibrary(cli, 'score_canaries', {});
  if (a === 'held-out') {
    const { values } = parse([b, ...rest].filter((x) => x !== undefined), { file: { type: 'string' } });
    if (!values.file) throw new UsageError('eval held-out --file cases.json');
    return showLibrary(cli, 'held_out_comparison', jsonArg('@' + values.file, '--file'));
  }
  throw new UsageError('eval contract propose | report | canary register|score | held-out');
}

async function cmdConformance(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { snapshot: { type: 'string' }, 'sandbox-egress': { type: 'boolean' }, description: { type: 'string' } });
  const adapter = positionals[0];
  if (!adapter && !values['sandbox-egress']) throw new UsageError('conformance <adapter> [--snapshot snap-N] [--sandbox-egress] [--description D]');
  const r = await runConformance(cli.auditor(), cli.eng(), {
    ...(adapter ? { adapter } : {}),
    ...(values.snapshot ? { snapshot: cli.headRef(values.snapshot) } : {}),
    ...(values['sandbox-egress'] ? { sandbox_egress: true } : {}),
    ...(values.description ? { description: values.description } : {}),
  });
  cli.emit({ ok: true, result: r }, () => {
    cli.print(`Conformance checks for ${adapter ?? 'the sandbox'} recorded as ${refText(r.evidence)}:`);
    for (const c of r.results) cli.print(`  ${c.status.toUpperCase()}  ${c.check}: ${c.detail}`);
    const failed = r.results.filter((c) => c.status === 'fail').length;
    cli.print(failed ? `${failed} check(s) FAILED: the adapter is not eligible for those capabilities.` : 'No check failed.');
  });
  return EXIT.ok;
}

/** Pilot step 2: run the control and recovery scenarios; a gate failure blocks adoption. */
function cmdControls(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  const { values } = parse(rest, { only: { type: 'string', multiple: true }, record: { type: 'boolean' }, workstation: { type: 'string' } });
  if (sub !== 'verify' && sub !== 'list') throw new UsageError('controls list | controls verify [--only CS-NN ...] [--record] [--workstation NAME]');
  if (sub === 'list') {
    cli.emit({ ok: true, scenarios: CONTROL_SCENARIOS }, () => {
      for (const s of CONTROL_SCENARIOS) cli.print(`${s.id} [${s.kind}] ${s.scenario} (${s.requirements})`);
    });
    return EXIT.ok;
  }
  const repo = resolve(import.meta.dirname, '..', '..');
  const res = runControlChecks(repo, { only: values.only as string[] | undefined });
  let recorded: unknown = null;
  if (values.record) recorded = cli.auditor().do('library', 'record_control_checks', { results: res.results, workstation: values.workstation ?? 'unspecified' });
  cli.emit({ ok: true, ...res, recorded }, () => {
    for (const r of res.results) cli.print(`${r.status.toUpperCase().padEnd(7)} ${r.id} [${r.kind}] ${r.scenario}\n        ${r.detail}`);
    cli.print(
      !res.complete
        ? 'ADOPTION BLOCKED: this was a partial run; every control gate must run and pass (harness-evaluation.md, pilot step 2).'
        : res.adoption_blocked
          ? 'ADOPTION BLOCKED: a control gate did not pass (harness-evaluation.md, pilot step 2).'
          : 'Every control gate passed. Measurement scenarios are pilot work, not gates.',
    );
  });
  return res.adoption_blocked ? EXIT.refused : EXIT.ok;
}

const METHOD_COMPONENTS = ['workflow', 'prompt', 'retrieval', 'tool', 'check', 'role'];

function cmdMethod(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  const { values } = parse(rest, { component: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, description: { type: 'string' }, content: { type: 'string' }, previous: { type: 'string' } });
  if (sub !== 'propose' || !values.component || !values.name || !values.version || !values.description) {
    throw new UsageError(`method propose --component ${METHOD_COMPONENTS.join('|')} --name N --version V --description D [--content file] [--previous method-N]`);
  }
  return showLibrary(cli, 'propose_method_version', {
    component: values.component,
    name: values.name,
    version: values.version,
    description: values.description,
    content: values.content ? readFileSync(values.content, 'utf8') : null,
    previous: values.previous ? libraryRef(cli, values.previous) : null,
  });
}

// -----------------------------------------------------------------------------------------------
// Exploration and comprehension

function cmdExplore(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === 'start') {
    const { values } = parse(rest, { unit: { type: 'string', multiple: true }, lens: { type: 'string' }, authorization: { type: 'string' } });
    if (!values.unit?.length || !values.lens || !values.authorization) throw new UsageError('explore start --unit unit-N [...] --lens purpose|flows|stores|transitions --authorization auth-N');
    return cli.callAndShow('start_exploration', { audit_units: values.unit.map((u) => cli.headRef(u)), lens: values.lens, authorization: cli.headRef(values.authorization) });
  }
  if (sub === 'resume') {
    const id = rest[0];
    if (!id) throw new UsageError('explore resume <expl-id>');
    const r = cli.call('resume_exploration', { exploration: id });
    const res = r.result as { exploration: Ref; changes: { changed: { ref: Ref; current: number }[]; added: Ref[] } };
    cli.emit({ ok: true, result: res, commit: r.commit }, () => {
      cli.print(`What changed since the last round of ${id}:`);
      if (!res.changes.changed.length && !res.changes.added.length) cli.print('  nothing');
      for (const c of res.changes.changed) cli.print(`  changed: ${c.ref.record_id} seen at revision ${c.ref.revision}, now ${c.current}`);
      for (const a of res.changes.added) cli.print(`  added: ${refText(a)}`);
      cli.print(`Continuing: new round opened on ${refText(res.exploration)}.`);
    });
    return EXIT.ok;
  }
  throw new UsageError('explore start|resume');
}

function cmdDiagram(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  const { values } = parse(rest, { unit: { type: 'string' }, lens: { type: 'string' }, affiliation: { type: 'string' }, source: { type: 'string' }, statement: { type: 'string', multiple: true }, base: { type: 'string' } });
  if (sub !== 'propose' || !values.unit || !values.lens || !values.affiliation || !values.source) {
    throw new UsageError('diagram propose --unit unit-N --lens L --affiliation designed|implemented|comparison --source diagram.mmd [--statement stmt-N ...] [--base diag-N@rev]');
  }
  return cli.callAndShow('propose_kb_diagram', {
    audit_unit: cli.headRef(values.unit),
    lens: values.lens,
    affiliation: values.affiliation,
    source: readFileSync(values.source, 'utf8'),
    statements: (values.statement ?? []).map((x) => cli.headRef(x)),
    ...(values.base ? { base: parseRef(values.base) } : {}),
  });
}

const USAGE = `harness — audit harness CLI (see docs/cli.md)

Global: --workspace DIR (or HARNESS_WORKSPACE; default ./workspace)  -e/--engagement ID (or HARNESS_ENGAGEMENT)  --json

  init                                   create a workspace and its secrets
  engagement create <id> --name --owner --purpose [--chain --hardfork]
  engagement list | show [id]
  status                                 home view: decisions needed, current work and spending, material gaps
  records [--type T] [--id ID ...] [--history] [--limit N]
  show <id>[@rev]                        one record, deceptive characters rendered visibly
  snapshot register <path> [--label L] [--payload JSON|@file]
  statement|investigation|variant|clarification|interpretation|unit|property|correspondence|comparison|discrepancy
         propose [--file body.json] [--body JSON] [--set k=v ...] [--base id@rev]
  work prepare --kind K [--investigation id ...] [--method M ...] | work authorize <proposal> [--draft F]
  job request --payload JSON|@file | job run [--max N] [--live-providers P,...] | job pause|resume [--reason R] | job cancel [job-id]
  exec --description D [--snapshot S] [--output DIR ...] -- <argv...>   auditor-run command via the trusted runner (FR-41)
  import-artifact <path> [...] --description D [--snapshot S]   import with an untrusted-receipt label
  packet submit --file packet.json
  screen <kind> ...                      trusted decision screen (interactive terminal only):
         packet <pkt-id> | confirm_interpretations [ids] | answer_clarification [id]
         accept_scope_and_policy --draft policy.json | authorize_work <proposal> [--draft limits.json]
         record_flow_review <unit> | attest_carry_forward [--snapshot S] | approve_export <manifest>
         decide <kind> --record id[@rev] ... --inputs JSON|@file
  export prepare --file F | export approve <manifest> | export bundle <manifest> --destination DIR
  import <bundle-dir>
  capture [--purpose P] [--unit U] [--once] [-- <agent argv...>]
  capture-hook                           Claude Code UserPromptSubmit hook (reads hook JSON on stdin)
  schemas --out DIR                      write every JSON Schema (NFR-10)
  call <operation> [--payload JSON|@file] [--set k=v ...] [--library]
  agent session <role> --model M [--investigation inv-N] [--authorization auth-N] [--adapter reference_agent|claude_code] [--max-turns N] [--live-providers P,...]
         interactive: each entry captured verbatim first, then sent to the agent as its task
  agent roles | agent run <role> --task T --model M [--investigation inv-N] [--max-turns N] [--authorization auth-N]
  position submit --investigation inv-N --role author|challenger --file text.md
  fixture submit [--investigation inv-N] [--root DIR] <path>...
  batch status | batch reconcile
  explore start --unit unit-N --lens L --authorization auth-N | explore resume <expl-id>
  diagram propose --unit unit-N --lens L --affiliation A --source F.mmd [--statement stmt-N ...]
  compositions derive | coverage functions | metrics
  eval contract propose --file F | eval report --contract evalc-N [--matches F] | eval held-out --file F
  eval canary register -e E --packet pkt-N --kind K | eval canary score
  method propose --component C --name N --version V --description D [--content F]
  conformance <adapter> [--snapshot S] [--sandbox-egress]   adapter / agent-host conformance checks (recorded as evidence)
  screen freeze_evaluation_contract <evalc-id> | screen adopt_method_version <method-id> [--evaluation F] [--rollback]

Exit codes: 0 ok; 1 internal error; 2 usage error; 3 refused, nothing committed;
            4 refused after a partial commit; 5 left undecided on the trusted screen.
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out: Out = { stdout: (s) => void process.stdout.write(s), stderr: (s) => void process.stderr.write(s) }): Promise<number> {
  let json = argv.includes('--json');
  try {
    const { g, rest } = extractGlobals(argv, env);
    json = g.json;
    const cli = new Cli(g, out);
    const [cmd, ...args] = rest;
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        out.stdout(USAGE);
        return cmd === undefined ? EXIT.usage : EXIT.ok;
      case 'init':
        return cmdInit(cli);
      case 'engagement':
        return cmdEngagement(cli, args);
      case 'status':
        return cmdStatus(cli);
      case 'records':
        return cmdRecords(cli, args);
      case 'show':
        return cmdShow(cli, args);
      case 'snapshot':
        return cmdSnapshot(cli, args);
      case 'work':
        return await cmdWork(cli, args);
      case 'job':
        return await cmdJob(cli, args);
      case 'exec': {
        const dash = args.indexOf('--');
        if (dash < 0) throw new UsageError('exec --description D [--snapshot id@rev] [--output DIR ...] -- <argv...>');
        const { values } = parse(args.slice(0, dash), { description: { type: 'string' }, snapshot: { type: 'string' }, output: { type: 'string', multiple: true } });
        const argvToRun = args.slice(dash + 1);
        if (!argvToRun.length || !values.description) throw new UsageError('exec --description D [--snapshot id@rev] [--output DIR ...] -- <argv...>');
        const r = await runAuditorCommand(cli.auditor(), cli.eng(), {
          argv: argvToRun,
          description: values.description,
          snapshot: values.snapshot ? parseRef(values.snapshot, cli.ws.store(cli.eng(), true)) : null,
          ...(values.output ? { outputs: values.output } : {}),
        });
        cli.emit({ ok: true, result: r }, () => cli.print(`Auditor-run command recorded as ${refText(r.evidence)} (exit ${r.exit_code}; eligible: ${r.eligible ? 'yes' : 'no'}).`));
        return EXIT.ok;
      }
      case 'import-artifact': {
        const { values, positionals } = parse(args, { ...PAYLOAD_OPTS, description: { type: 'string' }, snapshot: { type: 'string' } });
        if (!positionals.length || !values.description) throw new UsageError('import-artifact <path> [...] --description D [--snapshot id@rev]');
        return cli.callAndShow(
          'import_auditor_artifact',
          payloadOf(values, {
            paths: positionals.map((p) => resolve(p)),
            description: values.description,
            ...(values.snapshot ? { snapshot: parseRef(values.snapshot, cli.ws.store(cli.eng(), true)) } : {}),
          }),
        );
      }
      case 'packet': {
        const [sub, ...r] = args;
        if (sub !== 'submit') throw new UsageError('packet submit --file packet.json');
        const { values } = parse(r, PAYLOAD_OPTS);
        return cli.callAndShow('submit_review_packet', payloadOf(values));
      }
      case 'screen':
        return await cmdScreen(cli, args);
      case 'export':
        return await cmdExport(cli, args);
      case 'import': {
        const { values, positionals } = parse(args, PAYLOAD_OPTS);
        if (!positionals[0]) throw new UsageError('import <bundle-dir>');
        return cli.callAndShow('import_bundle', payloadOf(values, { path: resolve(positionals[0]) }), { scope: cli.g.engagement ?? 'library' });
      }
      case 'capture':
        return await cmdCapture(cli, args);
      case 'capture-hook':
        return await cmdCaptureHook(cli);
      case 'schemas':
        return cmdSchemas(cli, args);
      case 'call':
        return cmdCall(cli, args);
      case 'agent':
        return await cmdAgent(cli, args);
      case 'position':
        return cmdPosition(cli, args);
      case 'fixture':
        return cmdFixture(cli, args);
      case 'batch':
        return cmdBatch(cli, args);
      case 'eval':
        return cmdEval(cli, args);
      case 'conformance':
        return await cmdConformance(cli, args);
      case 'method':
        return cmdMethod(cli, args);
      case 'explore':
        return cmdExplore(cli, args);
      case 'diagram':
        return cmdDiagram(cli, args);
      case 'compositions':
        if (args[0] !== 'derive') throw new UsageError('compositions derive');
        return cli.callAndShow('derive_compositions', {});
      case 'coverage':
        if (args[0] !== 'functions') throw new UsageError('coverage functions');
        return cli.callAndShow('function_coverage', {});
      case 'metrics':
        return cli.callAndShow('engagement_metrics', {});
      case 'controls':
        return cmdControls(cli, args);
      default:
        if (cmd in PROPOSAL_KINDS) return cmdPropose(cli, cmd, args);
        throw new UsageError(`unknown command ${cmd}`);
    }
  } catch (e) {
    return reportError(e, json, out);
  }
}

function reportError(e: unknown, json: boolean, out: Out): number {
  if (e instanceof InputClosed) {
    if (json) out.stdout(JSON.stringify({ ok: false, error: { code: 'input_closed', reason: 'input ended before a decision', committed: false } }) + '\n');
    else out.stderr('\ninput closed: left undecided; nothing further was recorded\n');
    return EXIT.undecided;
  }
  if (e instanceof UsageError) {
    if (json) out.stdout(JSON.stringify({ ok: false, error: { code: 'usage', reason: e.message, committed: false } }) + '\n');
    else out.stderr(`usage error: ${e.message}\n(run \`harness help\`)\n`);
    return EXIT.usage;
  }
  if (isHarnessError(e)) {
    const j = e.toJSON();
    if (json) out.stdout(JSON.stringify({ ok: false, error: j }, null, 2) + '\n');
    else {
      out.stderr(
        renderVisible(
          `error: ${j.code}${j.operation ? ` (operation ${j.operation})` : ''}\n` +
            `  reason: ${j.reason}\n` +
            `  committed: ${j.committed ? 'yes — part of the request was recorded; read the reason' : 'no — nothing was recorded'}\n` +
            `  next: ${j.next}\n` +
            (j.ref ? `  ref: ${typeof j.ref === 'string' ? j.ref : JSON.stringify(j.ref)}\n` : '') +
            (j.details !== undefined ? `  details: ${JSON.stringify(j.details)}\n` : ''),
        ),
      );
    }
    return j.committed ? EXIT.refused_committed : EXIT.refused;
  }
  const msg = (e as Error)?.stack ?? String(e);
  if (json) out.stdout(JSON.stringify({ ok: false, error: { code: 'internal', reason: String((e as Error)?.message ?? e), committed: 'unknown' } }) + '\n');
  out.stderr(`internal error (state of any write in progress: check \`harness status\`):\n${msg}\n`);
  return EXIT.internal;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`internal error: ${String(e)}\n`);
      process.exitCode = EXIT.internal;
    },
  );
}
