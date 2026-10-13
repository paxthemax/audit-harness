import { fail, HarnessError } from '../core/errors.ts';
import { randomToken } from '../core/hash.ts';
import type { Ref } from '../core/refs.ts';
import { Controller, type Session } from '../controller/controller.ts';
import { ROLE_PROFILES, type RoleProfile } from '../controller/roles.ts';
import type { Workspace } from '../controller/workspace.ts';
import type { RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { presentRecords, WITHHELD_NOTICE } from '../screen/display.ts';
import { InputClosed, show, type ScreenIO } from '../screen/io.ts';
import { recordLines, refText } from '../screen/render.ts';
import { runQueue as defaultRunQueue } from '../runner/index.ts';
import { captureText, openCaptureChannel } from './capture.ts';
import { WRAPPER_CHANNEL_NAME } from './wrapper.ts';

// `harness agent session`: the terminal-wrapper fallback of DEC-008 Q-018 for talking to a harness
// agent. Each entry the auditor types is recorded verbatim on the capture channel FIRST (same channel
// name and program digest as `harness capture`); only then is an agent job requested with that exact
// text as its task and the captured_input reference (the runner checks they match). An entry whose
// capture failed is never sent to an agent. The job runs through the trusted runner; the agent's round
// summary and the proposals its outbox committed (or the refusals) are printed with visible rendering.
// Agent prose itself is not a record: the session cannot tell whether it describes IMPLEMENTED behavior,
// so read-first mode withholds only the recorded proposals, not the summary text.

export const AGENT_SESSION_ADAPTERS = ['reference_agent', 'claude_code'] as const;

export interface AgentSessionOptions {
  ws: Workspace;
  engagement: string;
  io: ScreenIO;
  role: string;
  model: string;
  investigation?: string | null;
  authorization?: string | null;
  adapter?: (typeof AGENT_SESSION_ADAPTERS)[number];
  max_turns?: number | null;
  source_paths?: string[];
  controller?: Controller;
  /** Key overrides (tests); by default read from the workspace secrets by this process. */
  captureKey?: string;
  auditorKey?: string;
  runQueue?: typeof defaultRunQueue;
}

export interface SessionEntry {
  captured: Ref | null;
  job: Ref | null;
  status: 'not_captured' | 'refused' | 'ran' | 'not_run';
}

export function agentRole(role: string): RoleProfile {
  const p = ROLE_PROFILES[role];
  if (!p || p.role === 'tool') fail('invalid_request', `agent role must be one of ${Object.keys(ROLE_PROFILES).filter((r) => r !== 'tool').join(', ')}`);
  return p;
}

/** The named authorization, else the investigation's, else the single active one. */
export function resolveAgentAuthorization(store: RecordStore, named: string | null | undefined, inv: RecordEnvelope<'investigation'> | null): Ref {
  if (named) {
    const [id, rev] = named.split('@');
    return rev ? { record_id: id, revision: Number(rev) } : store.headRef(id);
  }
  if (inv?.body.authorization) return inv.body.authorization;
  const active = store.heads('work_authorization').filter((a) => a.body.status === 'active');
  if (active.length !== 1) fail('invalid_request', `name the work authorization (${active.length} active)`);
  return { record_id: active[0].record_id, revision: active[0].revision };
}

export async function runAgentSession(o: AgentSessionOptions): Promise<SessionEntry[]> {
  if (!o.io.interactive) fail('permission_denied', 'harness agent session records typed input and needs an interactive terminal; it refuses pipes and scripts');
  const profile = agentRole(o.role);
  const adapter = o.adapter ?? 'reference_agent';
  if (!AGENT_SESSION_ADAPTERS.includes(adapter)) fail('invalid_request', `adapter must be one of ${AGENT_SESSION_ADAPTERS.join(', ')}`);
  const controller = o.controller ?? new Controller(o.ws);
  const capture = openCaptureChannel({ ws: o.ws, name: WRAPPER_CHANNEL_NAME, session: `agent-session-${randomToken(8)}`, key: o.captureKey, controller });
  const auditor: Session = controller.auditor(o.auditorKey ?? o.ws.readSecret('auditor.key'));
  const run = o.runQueue ?? defaultRunQueue;
  const io = o.io;
  const eid = o.engagement;
  const store = () => o.ws.store(eid, true);
  const entries: SessionEntry[] = [];

  io.write(`Agent session: role ${profile.role} (${adapter}, model ${o.model}) in engagement ${eid}.\n`);
  io.write(`The agent may not decide: ${profile.mayNotDecide}.\n`);
  io.write('Each entry is recorded verbatim on the capture channel before the agent sees it. One line per entry; "/multi" for a multi-line entry; "/quit" ends.\n');

  for (;;) {
    let text: string;
    try {
      text = await io.ask(`${profile.role}> `);
      if (text === '/quit') break;
      if (text === '/multi') text = await io.edit('Multi-line entry', '');
    } catch (e) {
      if (e instanceof InputClosed) break;
      throw e;
    }
    if (!text.length) continue;

    // 1. Capture first. A failed capture is never forwarded.
    let cap: Ref;
    try {
      cap = captureText(capture, { engagement: eid, text, purpose: 'conversation' });
      io.write(`[captured ${cap.record_id}]\n`);
    } catch (e) {
      if (!(e instanceof HarnessError)) throw e;
      io.write(`[NOT captured: ${e.code}: ${e.message.slice(e.code.length + 2)}; nothing was sent to the agent]\n`);
      entries.push({ captured: null, job: null, status: 'not_captured' });
      continue;
    }

    // 2. Context and agent job bound to the captured text.
    let job: Ref;
    try {
      const s = store();
      const inv = o.investigation ? s.mustHead(o.investigation.split('@')[0], 'investigation') : null;
      const invRef = inv ? { record_id: inv.record_id, revision: inv.revision } : null;
      const snapshot = s.heads('engagement')[0]?.body.active_snapshot;
      if (!snapshot) fail('invalid_request', 'register a target snapshot before running an agent');
      const authorization = resolveAgentAuthorization(s, o.authorization, inv);
      const ctx = auditor.do(eid, 'build_context', {
        role: profile.contextRole,
        investigation: invRef,
        ...(o.source_paths?.length ? { source_paths: o.source_paths } : {}),
      }) as { context_manifest: { artifact: string }; records: number; withheld: number };
      io.write(`[context ${ctx.context_manifest.artifact}: ${ctx.records} records, ${ctx.withheld} withheld]\n`);
      const args: Record<string, unknown> = { task: text, model: o.model, captured_input: cap };
      if (o.max_turns) args.max_turns = o.max_turns;
      const r = auditor.call(eid, 'request_job', {
        authorization,
        purpose: 'agent',
        adapter,
        role: profile.role,
        snapshot,
        investigation: invRef,
        context_manifest: ctx.context_manifest,
        args,
      });
      job = (r.result as { job: Ref }).job ?? r.records.find((x) => x.record_id.startsWith('job-'))!;
      io.write(`[agent job ${refText(job)} queued]\n`);
    } catch (e) {
      if (!(e instanceof HarnessError)) throw e;
      io.write(`[agent job refused: ${e.code}: ${e.message.slice(e.code.length + 2)}; next: ${e.next}]\n`);
      entries.push({ captured: cap, job: null, status: 'refused' });
      continue;
    }

    // 3. Run it through the trusted runner and show what came back.
    const q = await run(controller, eid);
    const mine = q.ran.find((x) => x.job === job.record_id);
    for (const k of q.skipped) io.write(`[job ${k.job} not run: ${k.code}: ${k.reason}]\n`);
    if (!mine) {
      io.write(`[agent job ${job.record_id} did not run (queue stopped: ${q.stopped})]\n`);
      entries.push({ captured: cap, job, status: 'not_run' });
      continue;
    }
    printRound(io, auditor, eid, store(), mine);
    for (const other of q.ran.filter((x) => x !== mine)) {
      io.write(`[also ran: job ${other.job} attempt ${refText(other.attempt)}: ${other.status}; evidence ${refText(other.evidence)}]\n`);
    }
    entries.push({ captured: cap, job, status: 'ran' });
  }
  return entries;
}

function printRound(
  io: ScreenIO,
  auditor: Session,
  eid: string,
  s: RecordStore,
  run: { job: string; attempt: Ref | null; status: string; evidence: Ref | null },
): void {
  io.write(`\n--- agent round: job ${run.job} attempt ${refText(run.attempt)}: ${run.status} ---\n`);
  const ev = run.evidence ? s.tryGet<'evidence_artifact'>(run.evidence) : undefined;
  const stdout = ev?.body.receipt?.stdout.artifact;
  if (stdout && s.archive.has(stdout)) {
    const text = s.archive.getText(stdout);
    let round: { format?: string; final_text?: string; turns?: number; stop?: string; model?: string; queued?: { file: string; operation: string }[] } | null = null;
    try {
      round = JSON.parse(text);
    } catch {
      round = null;
    }
    if (round?.format === 'harness.agent-round/1') {
      show(io, `Agent (${round.model ?? 'model unknown'}, ${round.turns ?? '?'} turn(s), stop: ${round.stop ?? '?'}):\n${round.final_text ?? '(no final text)'}\n`);
      for (const q of round.queued ?? []) show(io, `  requested: ${q.operation} (${q.file})\n`);
    } else show(io, (text.length > 8000 ? `${text.slice(0, 8000)}\n… (${text.length - 8000} more characters in ${stdout})` : text) + '\n');
  } else io.write('(no round summary was recorded)\n');
  for (const l of ev?.body.limitations ?? []) show(io, `  limitation: ${l}\n`);

  const att = run.attempt?.record_id;
  // What the outbox committed under the attempt's grant (provider-call ledger entries are accounting, not proposals).
  const proposals = att ? s.heads().filter((e) => e.created_by.channel === 'worker' && e.origin.attempt?.record_id === att && e.type !== 'ledger_entry') : [];
  io.write(`--- proposals committed by the agent's outbox (${proposals.length}); none is a decision ---\n`);
  const p = presentRecords(auditor, eid, proposals, 'agent-session:proposals');
  for (const e of p.shown) show(io, recordLines(e, '    ').map((l) => `  ${l}`).join('\n') + '\n');
  for (const w of p.withheld) io.write(`  ${w.type} ${w.record_id}@${w.revision} — ${WITHHELD_NOTICE}\n`);
  const refused = att ? s.events().filter((e) => e.kind === 'worker_request_refused' && e.result.attempt === att) : [];
  if (refused.length) {
    io.write(`--- requests the controller refused (${refused.length}) ---\n`);
    for (const r of refused) show(io, `  ${String(r.result.operation ?? 'unparsed')} (${String(r.result.file)}): ${String(r.result.code ?? 'invalid')}: ${String(r.result.reason ?? '')}\n`);
  }
}
