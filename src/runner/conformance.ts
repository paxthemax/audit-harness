import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fail, isHarnessError } from '../core/errors.ts';
import { canonicalJson, digest } from '../core/hash.ts';
import type { Ref } from '../core/refs.ts';
import { defineOperation, type Controller, type Session } from '../controller/controller.ts';
import { git } from '../store/git.ts';
import type { StructuredResult } from '../schema/records.ts';
import { adapterFor, descriptorDigest, registerAdapter, type Adapter } from './adapters.ts';
import { requireMode } from './jobs.ts';
import { BwrapSandbox, type Bind, type Sandbox, type SandboxLimits, type SandboxResult } from './sandbox.ts';

// Conformance checks (design/harness-interface-contracts.md, "Compatibility and conformance"). An
// adapter or host integration is eligible only after demonstrating its declared capabilities; an
// execution sandbox only after demonstrating default-deny egress; an agent tool only after the five
// agent-host conditions. Each check runs concretely where the skeleton can (in the same sandbox profile
// the runner uses for that adapter) and otherwise reports `not_applicable` with the reason. Results are
// recorded as trusted-runner evidence by `runConformance`, through the runner-channel operation
// `record_conformance`.

export interface CheckResult {
  check: string;
  status: 'pass' | 'fail' | 'not_applicable';
  detail: string;
}

const PROBE_LIMITS: SandboxLimits = { runtime_seconds: 20, output_bytes: 64 * 1024, memory_mb: 2048, processes: 64 };

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface Probe {
  res: SandboxResult;
  stdout: string;
  stderr: string;
}

/**
 * Run a bash probe in the sandbox profile the runner gives `adapter`: read-only /target, writable
 * /work and /outbox, the adapter's toolchain binds, and for agent hosts /run/harness and /context.
 */
async function probe(controller: Controller, adapter: Adapter | null, script: string, opts: { limits?: Partial<SandboxLimits>; signal?: AbortSignal; sandbox?: Sandbox } = {}): Promise<Probe> {
  const sandbox = opts.sandbox ?? new BwrapSandbox();
  const dir = mkdtempSync(join(controller.ws.runsDir, 'conformance-'));
  try {
    for (const d of ['target', 'work', 'outbox', 'io', 'harness', 'context']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'target', 'README'), 'conformance probe target\n');
    const desc = adapter?.descriptor();
    const plan = adapter ? adapter.plan(desc?.context_mount ? { task: 'conformance probe', model: 'none' } : {}, { role: 'investigator' }) : null;
    const binds: Bind[] = [
      { src: join(dir, 'target'), dest: '/target' },
      { src: join(dir, 'work'), dest: '/work', writable: true },
      { src: join(dir, 'outbox'), dest: '/outbox', writable: true },
      ...(plan?.binds ?? []),
    ];
    if (desc?.grant_in_sandbox || desc?.context_mount) {
      writeFileSync(join(dir, 'harness', 'token'), 'probe-token', { mode: 0o400 });
      binds.push({ src: join(dir, 'harness'), dest: '/run/harness' });
    }
    if (desc?.context_mount) binds.push({ src: join(dir, 'context'), dest: '/context' });
    const env = { ...(plan?.env ?? { HOME: '/home/sandbox', PATH: '/usr/bin', TMPDIR: '/tmp' }), HARNESS_OUTBOX: '/outbox', HARNESS_TARGET: '/target' };
    const req = {
      argv: ['/usr/bin/bash', '-c', script],
      cwd: '/work',
      binds,
      env,
      limits: { ...PROBE_LIMITS, ...(opts.limits ?? {}) },
      stdoutPath: join(dir, 'io', 'stdout'),
      stderrPath: join(dir, 'io', 'stderr'),
      signal: opts.signal,
    };
    const res = await sandbox.run(req);
    return { res, stdout: readFileSync(req.stdoutPath, 'utf8'), stderr: readFileSync(req.stderrPath, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function result(check: string, ok: boolean, detail: string): CheckResult {
  return { check, status: ok ? 'pass' : 'fail', detail };
}

function na(check: string, detail: string): CheckResult {
  return { check, status: 'not_applicable', detail };
}

/** Paths a sandbox must never see: the workspace's secrets and stores, the operator's home. */
function forbiddenPaths(controller: Controller): string[] {
  const root = controller.ws.root;
  return [join(root, 'secrets'), join(root, 'engagements'), join(root, 'library'), join(homedir(), '.ssh'), homedir(), root];
}

async function scopedReadsWrites(controller: Controller, adapter: Adapter): Promise<CheckResult> {
  const ro = adapter.plan(adapter.descriptor().context_mount ? { task: 'p', model: 'none' } : {}, { role: 'investigator' }).binds.filter((b) => !b.writable).map((b) => b.dest);
  const lines = [
    'bad=0',
    ...forbiddenPaths(controller).map((p) => `test -e ${q(p)} && { echo visible:${q(p)}; bad=1; }`),
    ...['/target', '/usr', ...ro].map((d) => `touch ${q(d + '/.probe')} 2>/dev/null && { echo writable:${q(d)}; bad=1; }`),
    'touch /work/.probe || { echo work-not-writable; bad=1; }',
    'touch /outbox/.probe || { echo outbox-not-writable; bad=1; }',
    'exit $bad',
  ];
  const p = await probe(controller, adapter, lines.join('\n'));
  return result('scoped_reads_writes', p.res.exit_code === 0, p.res.exit_code === 0 ? `workspace, secrets and home invisible; /target, /usr and ${ro.length} toolchain binds read-only; /work and /outbox writable` : p.stdout.trim());
}

function deniedCapabilityExpansion(adapter: Adapter): CheckResult {
  const problems: string[] = [];
  // A repository or worker cannot register or re-register an adapter; only operator code can.
  try {
    registerAdapter({ ...adapter, descriptor: () => ({ ...adapter.descriptor(), registered_by: 'builtin' }) });
    problems.push('a built-in descriptor could be registered again');
  } catch {
    /* refused, as required */
  }
  // Undeclared (permission-bearing) arguments are refused.
  for (const extra of [{ ffi: true }, { network: 'allow' }, { argv_override: ['/bin/sh'] }]) {
    try {
      adapter.validate({ ...(adapter.descriptor().context_mount ? { task: 'p', model: 'none' } : {}), ...extra });
      problems.push(`argument ${Object.keys(extra)[0]} accepted`);
    } catch (e) {
      if (!isHarnessError(e)) problems.push(`argument ${Object.keys(extra)[0]}: ${(e as Error).message}`);
    }
  }
  const env = adapter.plan(adapter.descriptor().context_mount ? { task: 'p', model: 'none' } : {}, { role: 'investigator' }).env;
  if (adapter.descriptor().ecosystem.includes('foundry') && env.FOUNDRY_FFI !== 'false') problems.push('FFI is not disabled in the tool environment');
  if (adapter.descriptor().capabilities.network !== 'denied') problems.push('descriptor declares network access');
  return result('denied_capability_expansion', problems.length === 0, problems.length ? problems.join('; ') : 'registration refused, undeclared arguments refused, network denied, inherited FFI disabled');
}

function unsupportedMode(adapter: Adapter): CheckResult {
  try {
    requireMode(adapter.descriptor(), 'no-such-mode');
    return result('unsupported_mode_handling', false, 'an undeclared mode was accepted');
  } catch (e) {
    return result('unsupported_mode_handling', isHarnessError(e, 'unsupported'), `undeclared mode refused with ${(e as { code?: string }).code ?? (e as Error).message}`);
  }
}

async function boundedResources(controller: Controller, adapter: Adapter): Promise<CheckResult> {
  const t0 = Date.now();
  const slow = await probe(controller, adapter, 'sleep 30', { limits: { runtime_seconds: 1 } });
  const loud = await probe(controller, adapter, 'head -c 200000 /dev/zero | tr "\\0" x', { limits: { output_bytes: 1024 } });
  const ok = slow.res.timed_out && slow.res.termination === 'confirmed' && Date.now() - t0 < 15000 && loud.res.stdout_truncated && loud.res.stdout_bytes === 1024;
  return result(
    'bounded_resource_use',
    ok,
    `runtime limit: timed_out=${slow.res.timed_out}, termination=${slow.res.termination}; output limit: truncated=${loud.res.stdout_truncated} at ${loud.res.stdout_bytes} bytes; ${slow.res.limitations.join('; ')}`,
  );
}

async function cancellation(controller: Controller, adapter: Adapter): Promise<CheckResult> {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300).unref();
  const t0 = Date.now();
  const p = await probe(controller, adapter, 'sleep 30 & sleep 30', { signal: ac.signal });
  const ok = p.res.cancelled && p.res.termination === 'confirmed' && Date.now() - t0 < 10000;
  return result('cancellation', ok, `cancelled=${p.res.cancelled}, termination=${p.res.termination} (acknowledged separately from confirmed termination), ${Date.now() - t0} ms`);
}

function duplicateDelivery(controller: Controller, eid: string, adapterName: string): CheckResult {
  const store = controller.ws.store(eid, true);
  const ev = store
    .heads('evidence_artifact')
    .filter((e) => e.body.attempt && e.body.receipt && e.body.job && store.mustHead(e.body.job.record_id, 'job').body.adapter.name === adapterName)
    .pop();
  if (!ev) return na('duplicate_delivery', `no completed attempt of ${adapterName} in this engagement to redeliver`);
  const before = { ev: store.heads('evidence_artifact').length, ledger: store.heads('ledger_entry').length };
  const b = ev.body;
  const r = controller.runner().do(eid, 'complete_attempt', {
    attempt: b.attempt!.record_id,
    run: { receipt: b.receipt, result: b.structured_result, failed: null, missing_or_truncated: [], limitations: [], environment_reads: null, termination: 'not_applicable', blobs: [] },
  });
  const after = controller.ws.store(eid, true);
  const same = after.heads('evidence_artifact').length === before.ev && after.heads('ledger_entry').length === before.ledger;
  return result('duplicate_delivery', r.duplicate === true && same, `redelivered completion of ${b.attempt!.record_id}: duplicate=${r.duplicate}, no new evidence or ledger entries=${same}`);
}

function artifactProvenance(controller: Controller, eid: string, adapter: Adapter): CheckResult {
  const store = controller.ws.store(eid, true);
  const name = adapter.descriptor().name;
  const ev = store
    .heads('evidence_artifact')
    .filter((e) => e.body.receipt && e.body.job && store.mustHead(e.body.job.record_id, 'job').body.adapter.name === name)
    .pop();
  if (!ev) return na('artifact_provenance', `no evidence from ${name} in this engagement yet`);
  const r = ev.body.receipt!;
  const problems: string[] = [];
  if (ev.body.producer !== 'trusted_runner') problems.push(`producer ${ev.body.producer}`);
  const tracked = git(store.dir, ['ls-files', 'archive']);
  for (const d of [r.stdout.artifact, r.stderr.artifact, ...r.outputs.map((o) => o.artifact.artifact), ev.body.content.artifact]) {
    try {
      store.archive.get(d);
    } catch (e) {
      problems.push(`${d}: ${(e as Error).message}`);
    }
    if (!tracked.includes(d.slice(7))) problems.push(`${d} not committed with its record`);
  }
  if (r.executable.digest !== adapter.descriptor().executable.digest) problems.push('executable digest differs from the registered descriptor');
  const job = store.mustHead(ev.body.job!.record_id, 'job');
  if (store.archive.has(job.body.adapter.descriptor) && descriptorDigest(store.archive.getJson(job.body.adapter.descriptor)) !== descriptorDigest(adapter.descriptor())) {
    problems.push('descriptor recorded with the job differs from the registered one');
  }
  return result('artifact_provenance', problems.length === 0, problems.length ? problems.join('; ') : `${ev.record_id}: supervisor receipt, executable ${r.executable.digest}, every blob hash-verified and committed`);
}

async function portableReplay(controller: Controller, eid: string, adapter: Adapter, snapshot: Ref | null): Promise<CheckResult> {
  const desc = adapter.descriptor();
  if (/not replayable/.test(desc.replay)) return na('portable_replay', desc.replay);
  if (!snapshot) return na('portable_replay', 'no snapshot given to replay against');
  const store = controller.ws.store(eid, true);
  const snap = store.get(snapshot, 'target_snapshot');
  const plan = adapter.plan({}, { role: 'tool' });
  const runs: { result: StructuredResult; outputs: string[] }[] = [];
  for (let i = 0; i < 2; i++) {
    const dir = mkdtempSync(join(controller.ws.runsDir, 'replay-'));
    try {
      store.archive.materialize(snap.body.tree.artifact, join(dir, 'work'), true);
      mkdirSync(join(dir, 'io'));
      const sandbox = new BwrapSandbox();
      const req = {
        argv: plan.argv,
        cwd: '/work',
        binds: [{ src: join(dir, 'work'), dest: '/work', writable: true }, ...plan.binds],
        env: plan.env,
        limits: { ...PROBE_LIMITS, runtime_seconds: 300, output_bytes: 16 * 1024 * 1024 },
        stdoutPath: join(dir, 'io', 'stdout'),
        stderrPath: join(dir, 'io', 'stderr'),
      };
      const res = await sandbox.run(req);
      const interp = adapter.interpret({
        exit_code: res.exit_code,
        signal: res.signal,
        timed_out: res.timed_out,
        cancelled: res.cancelled,
        stdout: readFileSync(req.stdoutPath, 'utf8'),
        stderr: readFileSync(req.stderrPath, 'utf8'),
        stdout_truncated: res.stdout_truncated,
        stderr_truncated: res.stderr_truncated,
        args: {},
        mode: plan.mode,
      });
      const outputs = plan.outputs.flatMap((o) => {
        try {
          const t = store.archive.putTree(join(dir, 'work', o));
          return Object.entries(t.manifest.files)
            .filter(([p]) => !p.startsWith('build-info/'))
            .map(([p, d]) => `${p}=${d}`);
        } catch {
          return [`${o}: missing`];
        }
      });
      runs.push({ result: interp.result, outputs });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const sig = (r: (typeof runs)[number]) => canonicalJson({ type: r.result.result_type, tests: r.result.tests.map((t) => [t.name, t.status]), outputs: r.outputs });
  const same = sig(runs[0]) === sig(runs[1]);
  return result('portable_replay', same, same ? `two fresh runs from the snapshot agree (${runs[0].result.result_type}, ${runs[0].result.tests.length} tests, ${runs[0].outputs.length} output files)` : 'two fresh runs disagree');
}

export async function checkAdapterConformance(controller: Controller, eid: string, adapterName: string, opts: { snapshot?: Ref | null } = {}): Promise<CheckResult[]> {
  const adapter = adapterFor(controller.ws, adapterName);
  return [
    await scopedReadsWrites(controller, adapter),
    deniedCapabilityExpansion(adapter),
    unsupportedMode(adapter),
    await boundedResources(controller, adapter),
    await cancellation(controller, adapter),
    duplicateDelivery(controller, eid, adapterName),
    na('ambiguous_completion', 'needs a runner that dies between staging and commit; reconcile_attempts marks such attempts outcome_unknown, keeps the reservation and never turns staged blobs into evidence'),
    artifactProvenance(controller, eid, adapter),
    await portableReplay(controller, eid, adapter, opts.snapshot ?? null),
  ];
}

/** Default-deny egress, demonstrated: no route out, no name resolution. */
export async function checkSandboxEgress(controller: Controller): Promise<CheckResult> {
  const p = await probe(
    controller,
    null,
    [
      'out=0',
      '(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && { echo reached:1.1.1.1; out=1; }',
      '(exec 3<>/dev/tcp/8.8.8.8/53) 2>/dev/null && { echo reached:8.8.8.8; out=1; }',
      'getent hosts example.com >/dev/null 2>&1 && { echo resolved:example.com; out=1; }',
      'ls /sys/class/net 2>/dev/null | grep -v "^lo$" && out=1',
      'exit $out',
    ].join('\n'),
  );
  return result('default_deny_egress', p.res.exit_code === 0, p.res.exit_code === 0 ? 'no outbound connection or name resolution was possible' : p.stdout.trim());
}

/** The five agent-tool conditions (interface contracts, "Compatibility and conformance"). */
export async function checkAgentHostConformance(controller: Controller, eid: string, adapterName: string): Promise<CheckResult[]> {
  const adapter = adapterFor(controller.ws, adapterName);
  const desc = adapter.descriptor();
  if (!desc.purposes.includes('agent')) return [na('agent_host', `${adapterName} is not an agent host`)];
  const plan = adapter.plan({ task: 'p', model: 'none' }, { role: 'investigator' });
  const out: CheckResult[] = [];

  // 1. Input capture outside the model: the capture channel's key and the workspace secrets are unreachable.
  const capKey = controller.ws.readSecret('capture.key');
  const leak = Object.values(plan.env).some((v) => v.includes(capKey));
  const cap = await probe(controller, adapter, [`test -e ${q(join(controller.ws.root, 'secrets'))} && exit 1`, `grep -rqs ${q(capKey)} /run /context /opt /home /tmp && exit 2`, 'env | grep -q -i capture && exit 3', 'exit 0'].join('\n'));
  out.push(result('input_capture_outside_model', cap.res.exit_code === 0 && !leak, cap.res.exit_code === 0 && !leak ? 'capture key and secrets are not reachable from the agent sandbox; capture runs on the capture channel only' : `capture material reachable (probe exit ${cap.res.exit_code}${leak ? ', key in environment' : ''})`));

  // 2. One confined instance per engagement: each attempt gets its own namespaces; start_attempt
  //    refuses a second running attempt in the workspace.
  const nsScript = 'readlink /proc/self/ns/pid /proc/self/ns/mnt /proc/self/ns/net | tr "\\n" " "';
  const a = await probe(controller, adapter, nsScript);
  const b = await probe(controller, adapter, nsScript);
  const host = ['pid', 'mnt', 'net'].map((n) => {
    try {
      return readFileSync(`/proc/self/ns/${n}`, 'utf8');
    } catch {
      return '';
    }
  });
  const distinct = a.stdout.trim() !== '' && a.stdout !== b.stdout && !host.some((h) => h && a.stdout.includes(h));
  out.push(result('one_confined_instance_per_engagement', distinct, `per-attempt namespaces ${distinct ? 'distinct from each other and the host' : 'shared'}; dispatch runs one attempt at a time per workspace`));

  // 3. Host memory off: nothing written to HOME survives into the next attempt.
  await probe(controller, adapter, 'mkdir -p "$HOME/.memory" && echo remembered > "$HOME/.memory/m" && echo remembered > /tmp/m');
  const mem = await probe(controller, adapter, 'test -e "$HOME/.memory/m" && exit 1; test -e /tmp/m && exit 2; exit 0');
  out.push(result('host_memory_off', mem.res.exit_code === 0, mem.res.exit_code === 0 ? 'HOME and /tmp are fresh for every attempt; no state carries over' : 'state persisted between attempts'));

  // 4. No write access to its own hooks or configuration.
  const cfg = await probe(
    controller,
    adapter,
    [
      'bad=0',
      ...['/opt/harness/agent', '/opt/harness/tools', '/run/harness', '/context'].map((d) => `touch ${d}/.probe 2>/dev/null && { echo writable:${d}; bad=1; }`),
      // The tool's own configuration and hook locations: absent, or present and read-only.
      'for d in "$HOME/.claude"; do if [ -d "$d" ]; then touch "$d/.probe" 2>/dev/null && { echo writable:$d; bad=1; }; mkdir "$d/hooks" 2>/dev/null && { echo writable:$d/hooks; bad=1; }; echo readonly:$d; fi; done',
      'for f in "$HOME/.claude.json" "$HOME/.claude/settings.json"; do if [ -e "$f" ]; then (: >> "$f") 2>/dev/null && { echo writable:$f; bad=1; } || echo readonly:$f; fi; done',
      'for d in "$HOME/.config" "$HOME/.anthropic"; do test -e "$d" && { echo present:$d; bad=1; }; done',
      'exit $bad',
    ].join('\n'),
  );
  const ro = cfg.stdout.split('\n').filter((l) => l.startsWith('readonly:')).map((l) => l.slice(9));
  out.push(
    result(
      'no_write_to_hooks_or_config',
      cfg.res.exit_code === 0,
      cfg.res.exit_code === 0
        ? `agent runtime, tools, grant directory and context are read-only; ${ro.length ? `the tool's configuration is mounted read-only (${ro.join(', ')})` : 'no tool configuration in HOME'}`
        : cfg.stdout.trim(),
    ),
  );

  // 5. Provider calls only through the broker: no network, no provider keys in the environment or mounts.
  const egress = await checkSandboxEgress(controller);
  const keys = await probe(controller, adapter, [`test -e ${q(join(controller.ws.root, 'secrets', 'providers'))} && exit 1`, 'env | cut -d= -f1 | grep -E "API_KEY|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIAL" && exit 2', 'exit 0'].join('\n'));
  out.push(result('provider_calls_only_via_broker', egress.status === 'pass' && keys.res.exit_code === 0 && desc.provider_access === true, `${egress.detail}; provider keys ${keys.res.exit_code === 0 ? 'absent' : 'present'} in the sandbox; model calls go to /run/harness/broker.sock`));
  return out;
}

// -----------------------------------------------------------------------------------------------
// Live launch (compatibility trials): checks derived from the records of a completed agent job

interface MessagesTurn {
  messages?: { role?: string; content?: unknown }[];
}

/**
 * Read what an agent host actually did in a completed attempt: its receipt, the broker's request
 * log and the Messages requests the broker stored. Nothing here is taken from the caller.
 */
export async function checkLiveAgentRun(controller: Controller, eid: string, jobId: string): Promise<CheckResult[]> {
  const store = controller.ws.store(eid, true);
  const job = store.mustHead(jobId, 'job');
  if (job.body.purpose !== 'agent') return [na('live_launch', `${jobId} is not an agent job`)];
  const ev = store
    .heads('evidence_artifact')
    .filter((e) => e.body.job?.record_id === jobId && e.body.receipt)
    .pop();
  if (!ev) return [result('live_launch', false, `${jobId} has no recorded run`)];
  const att = store.mustHead(ev.body.attempt!.record_id, 'attempt');
  const out: CheckResult[] = [];
  out.push(result('live_launch', att.body.status === 'completed' && ev.body.receipt!.exit_code === 0, `attempt ${att.record_id}: ${att.body.status}, exit ${ev.body.receipt!.exit_code}; ${ev.body.structured_result?.interpretation ?? ''}`));

  const brokerLine = ev.body.limitations.find((l) => l.startsWith('broker: ') && /request\(s\)/.test(l)) ?? 'broker: no provider requests';
  const segments = brokerLine.replace(/^broker: \d+ request\(s\): /, '').split('; ');
  const nonModel = segments.some((seg) => !seg.startsWith('POST /v1/messages'));
  out.push(result('model_traffic_only_through_broker', !nonModel && /POST \/v1\/messages/.test(brokerLine), `${brokerLine}; sandbox network: ${ev.body.receipt!.sandbox.network}`));
  out.push(
    /\(stream\) -> 200/.test(brokerLine)
      ? result('streaming_synthesized', true, 'streaming requests were served from one non-streamed, fully checked provider call each')
      : na('streaming_synthesized', 'the tool made no streaming request'),
  );

  const outboxLine = ev.body.limitations.find((l) => l.startsWith('outbox: '));
  const refused = store.events().filter((e) => e.kind === 'worker_request_refused' && e.result.attempt === att.record_id);
  out.push(
    outboxLine
      ? result('proposals_via_outbox', /[1-9]\d* committed/.test(outboxLine), `${outboxLine}${refused.length ? `; refused: ${refused.map((r) => `${r.result.file} ${r.result.code}`).join(', ')}` : ''}`)
      : result('proposals_via_outbox', false, 'the tool wrote no outbox request'),
  );

  // Did the tool try to write its own configuration or hooks, and what happened?
  const calls = store
    .heads('ledger_entry')
    .filter((e) => e.body.attempt?.record_id === att.record_id && e.body.kind === 'reservation' && e.body.note.includes('"mode":"messages"'))
    .map((e) => JSON.parse(e.body.note).provider_call.request as string);
  const turns = calls.flatMap((d) => {
    try {
      return [store.archive.getJson<{ body: MessagesTurn }>(d).body];
    } catch {
      return [];
    }
  });
  const last = turns[turns.length - 1];
  const uses = new Map<string, string>();
  const results = new Map<string, { error: boolean; text: string }>();
  for (const m of last?.messages ?? []) {
    for (const b of Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []) {
      // File-writing tools only (reads are not configuration writes).
      if (b.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(String(b.name))) uses.set(String(b.id), String((b.input as { file_path?: unknown })?.file_path ?? ''));
      if (b.type === 'tool_result') results.set(String(b.tool_use_id), { error: b.is_error === true, text: JSON.stringify(b.content ?? '').slice(0, 160) });
    }
  }
  const configWrites = [...uses].filter(([, path]) => /(^|\/)\.claude(\.json|\/)|\/settings(\.local)?\.json$|hooks/.test(path));
  if (!configWrites.length) out.push(na('own_config_write_denied', 'the run made no attempt to write the tool\'s own configuration'));
  else {
    const allDenied = configWrites.every(([id]) => results.get(id)?.error === true);
    out.push(
      result(
        'own_config_write_denied',
        allDenied,
        `${configWrites.length} attempt(s) to write ${configWrites.map(([, p]) => p).join(', ')}: ${configWrites.map(([id]) => (results.get(id)?.error ? `refused (${results.get(id)!.text})` : 'ALLOWED')).join(', ')}`,
      ),
    );
  }
  out.push(await typedInputCaptured(controller, store, job, ev.body.limitations));
  return out;
}

/**
 * Terminal-wrapper capture (DEC-008 Q-018): the task the sandbox received is exactly what the auditor
 * typed on the capture channel, captured before the job was requested, and the capture key is out of
 * the sandbox's reach.
 */
async function typedInputCaptured(controller: Controller, store: ReturnType<Controller['ws']['store']>, job: { record_id: string; body: { args: Record<string, unknown>; adapter: { name: string } } }, limitations: string[]): Promise<CheckResult> {
  const name = 'typed_input_captured_outside_model';
  const ref = job.body.args.captured_input as Ref | undefined;
  if (!ref) return na(name, 'the job carries no captured input (headless task from the controller)');
  const rec = store.tryGet<'captured_input'>(ref);
  if (!rec || rec.type !== 'captured_input') return result(name, false, `captured input ${ref.record_id}@${ref.revision} not found`);
  const problems: string[] = [];
  if (rec.created_by.channel !== 'capture') problems.push(`recorded on the ${rec.created_by.channel} channel`);
  const jobCreated = store.history(job.record_id)[0].created_at;
  if (Date.parse(rec.created_at) > Date.parse(jobCreated)) problems.push('captured after the job was requested');
  const line = limitations.find((l) => l.startsWith('task: /run/harness/task.json '));
  const taskDigest = line?.split(' ')[2];
  if (!taskDigest) problems.push('no task file digest recorded with the run');
  else {
    const task = store.archive.getJson<{ args?: { task?: unknown } }>(taskDigest);
    if (typeof task.args?.task !== 'string' || digest(task.args.task) !== rec.body.content_digest) problems.push('the task the sandbox received differs from the captured text');
  }
  const capKey = controller.ws.readSecret('capture.key');
  const p = await probe(controller, adapterFor(controller.ws, job.body.adapter.name), [`test -e ${q(join(controller.ws.root, 'secrets'))} && exit 1`, `grep -rqs ${q(capKey)} /run /context /opt /home /tmp && exit 2`, 'exit 0'].join('\n'));
  if (p.res.exit_code !== 0) problems.push('the capture key or secrets are reachable from the sandbox');
  return result(
    name,
    problems.length === 0,
    problems.length
      ? problems.join('; ')
      : `${rec.record_id} recorded on the capture channel (${rec.body.channel.name}) at ${rec.created_at}, before the job; the task in task.json (${taskDigest}) is exactly the captured text (${rec.body.content_digest}); the capture key is unreachable from the sandbox`,
  );
}

// -----------------------------------------------------------------------------------------------
// Recording

export interface ConformancePayload {
  /** Adapter to check; agent hosts also get the agent-host conditions. */
  adapter?: string;
  /** Snapshot for the portable-replay check. */
  snapshot?: Ref | null;
  /** Also demonstrate default-deny egress. */
  sandbox_egress?: boolean;
  /** A completed agent job of this engagement whose run is checked from its records (live launch). */
  live_job?: string;
  description?: string;
}

/** Run conformance checks (auditor-requested) and record them as trusted-runner evidence. */
export async function runConformance(session: Session, eid: string, p: ConformancePayload): Promise<{ evidence: Ref; results: CheckResult[] }> {
  if (session.principal.channel !== 'auditor') fail('permission_denied', 'conformance runs are requested on the auditor channel');
  if (!p.adapter && !p.sandbox_egress) fail('invalid_request', 'name an adapter or ask for the sandbox egress check');
  const controller = session.controller;
  const results: CheckResult[] = [];
  let descriptor: string | null = null;
  if (p.adapter) {
    const adapter = adapterFor(controller.ws, p.adapter);
    descriptor = descriptorDigest(adapter.descriptor());
    results.push(...(await checkAdapterConformance(controller, eid, p.adapter, { snapshot: p.snapshot ?? null })));
    if (adapter.descriptor().purposes.includes('agent')) results.push(...(await checkAgentHostConformance(controller, eid, p.adapter)));
  }
  if (p.sandbox_egress) results.push(await checkSandboxEgress(controller));
  if (p.live_job) results.push(...(await checkLiveAgentRun(controller, eid, p.live_job)));
  const r = controller.runner().do(eid, 'record_conformance', {
    subject: p.adapter ?? 'sandbox',
    descriptor,
    results,
    requested_by: session.principal.principal,
    description: p.description ?? `conformance checks for ${p.adapter ?? 'the sandbox'}`,
  });
  return { evidence: r.evidence, results };
}

defineOperation<{ subject: string; descriptor: string | null; results: CheckResult[]; requested_by: string; description: string }>({
  name: 'record_conformance',
  channels: ['runner'],
  mutating: true,
  handler(ctx, p) {
    if (!Array.isArray(p?.results) || !p.results.length) fail('invalid_request', 'results are required');
    const failed = p.results.filter((r) => r.status === 'fail');
    const content = ctx.archive.putJson({ format: 'harness.conformance/1', subject: p.subject, descriptor: p.descriptor, results: p.results, checked_at: ctx.now });
    ctx.tx.blob(content);
    const evidence = ctx.tx.create('evidence_artifact', {
      content,
      producer: 'trusted_runner',
      job: null,
      attempt: null,
      receipt: null,
      snapshot: null,
      fixture: null,
      structured_result: {
        result_type: failed.length ? 'counterexample' : 'no_violation_observed',
        mode: 'conformance',
        bounds: 'the listed checks only; a passing check is a demonstration, not a proof',
        interpretation: failed.length ? `${failed.length} conformance check(s) failed: ${failed.map((f) => f.check).join(', ')}` : `all applicable conformance checks passed for ${p.subject}`,
        tests: p.results.map((r) => ({ name: r.check, status: r.status === 'pass' ? 'passed' : r.status === 'fail' ? 'failed' : 'skipped', reason: r.detail, expect: 'no_violation' })),
      },
      environment_sensitive: { flagged: false, reads: [] },
      positive_control_for: null,
      missing_or_truncated: [],
      limitations: [
        `requested by ${p.requested_by}; checks run by the trusted runner in the adapter's sandbox profile`,
        ...p.results.filter((r) => r.status === 'not_applicable').map((r) => `${r.check} not applicable: ${r.detail}`),
      ],
      eligible: failed.length === 0,
      description: p.description,
    });
    ctx.tx.event('conformance_recorded', { subject: p.subject, failed: failed.map((f) => f.check) });
    return { evidence, failed: failed.length };
  },
});
