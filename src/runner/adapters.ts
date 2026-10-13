import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { fail } from '../core/errors.ts';
import { digestFile, digestJson } from '../core/hash.ts';
import type { Workspace } from '../controller/workspace.ts';
import type { JobPurpose, StructuredResult } from '../schema/records.ts';
import type { Bind } from './sandbox.ts';

// Tool adapters (design/harness-interface-contracts.md, "Agent and tool adapter boundary"). Each adapter
// advertises a descriptor before dispatch; the controller records the exact descriptor with the job.
// Adapters are registered only by code the operator runs (built-ins here, `registerAdapter` from the
// operator's integration); nothing read from a repository, record or worker request can register or
// widen one. Arguments are structured; no adapter accepts a shell string.

export interface AdapterDescriptor {
  contract_version: 1;
  name: string;
  version: string;
  registered_by: 'builtin' | 'operator';
  executable: { path: string; digest: string | null; version: string | null };
  ecosystem: string;
  modes: string[];
  purposes: JobPurpose[];
  input_types: string[];
  output_types: string[];
  limits: { runtime_seconds_max: number | null };
  capabilities: { filesystem: string[]; network: 'denied' };
  cancellation: string;
  replay: string;
  /** Whether the attempt's worker grant token is made readable inside the sandbox. */
  grant_in_sandbox: boolean;
  /** Whether the attempt gets the provider broker socket (only when its authorization lists providers). */
  provider_access?: boolean;
  /** Whether the job's context manifest and task file are mounted (/context, /run/harness/task.json). */
  context_mount?: boolean;
  /** Further pinned components (e.g. the agent runtime directory) with their digests. */
  components?: { name: string; path: string; digest: string | null }[];
}

export interface PlanContext {
  role: string;
}

export interface AdapterPlan {
  /** argv inside the sandbox. */
  argv: string[];
  env: Record<string, string>;
  /** Read-only toolchain binds. */
  binds: Bind[];
  /** Output paths (relative to /work) the runner hashes into the archive. */
  outputs: string[];
  mode: string;
  limitations: string[];
}

export interface Observation {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  args: Record<string, unknown>;
  mode: string;
  /**
   * For positive controls and adequacy jobs: the declared tests' results in the checked (lineage)
   * experiment, or null when it has no completed result. A counterexample counts only for a declared
   * test the source edit flipped.
   */
  baseline?: StructuredResult['tests'] | null;
}

export interface Interpretation {
  result: StructuredResult;
  /** Non-null when the attempt failed as an execution (compile failure, crash, timeout). */
  failed: string | null;
  limitations: string[];
  missing: string[];
}

export interface Adapter {
  descriptor(): AdapterDescriptor;
  /** Throws `invalid_request` for arguments outside the adapter's structured schema. */
  validate(args: Record<string, unknown>): void;
  plan(args: Record<string, unknown>, ctx?: PlanContext): AdapterPlan;
  interpret(obs: Observation): Interpretation;
  /** Adjust the scratch copy before the run (e.g. drop write access the target's config grants); returns limitations. */
  prepare?(workDir: string): string[];
}

// -----------------------------------------------------------------------------------------------
// Registry

const operatorAdapters = new Map<string, Adapter>();
const builtinCache = new Map<string, Map<string, Adapter>>();
export const BUILTIN_ADAPTERS = ['forge_build', 'forge_test', 'reference_agent', 'claude_code'] as const;

/** Operator integration only: register an adapter (e.g. a `commandAdapter`). */
export function registerAdapter(adapter: Adapter): void {
  const name = adapter.descriptor().name;
  if ((BUILTIN_ADAPTERS as readonly string[]).includes(name)) throw new Error(`adapter ${name} is built in`);
  if (operatorAdapters.has(name)) throw new Error(`adapter ${name} is already registered`);
  if (adapter.descriptor().registered_by !== 'operator') throw new Error('only operator adapters can be registered');
  operatorAdapters.set(name, adapter);
}

/** Test/operator teardown. */
export function unregisterAdapter(name: string): void {
  operatorAdapters.delete(name);
}

export function adapterFor(ws: Workspace, name: string): Adapter {
  const op = operatorAdapters.get(name);
  if (op) return op;
  if ((BUILTIN_ADAPTERS as readonly string[]).includes(name)) {
    let m = builtinCache.get(ws.root);
    if (!m) {
      const tc = foundryToolchain(ws);
      m = new Map<string, Adapter>([
        ['forge_build', forgeBuildAdapter(tc)],
        ['forge_test', forgeTestAdapter(tc)],
        ['reference_agent', referenceAgentAdapter({ name: 'reference_agent', agentDir: REFERENCE_AGENT_DIR, registered_by: 'builtin' })],
        ['claude_code', claudeCodeAdapter({ binary: resolveClaudeCode() })],
      ]);
      builtinCache.set(ws.root, m);
    }
    return m.get(name)!;
  }
  fail('unsupported', `no registered adapter named ${name}`, { details: { registered: listAdapters() } });
}

export function listAdapters(): string[] {
  return [...BUILTIN_ADAPTERS, ...operatorAdapters.keys()].sort();
}

/** Digest of the exact descriptor recorded with a job. */
export function descriptorDigest(d: AdapterDescriptor): string {
  return digestJson(d);
}

// -----------------------------------------------------------------------------------------------
// Foundry toolchain (location is an operator choice: workspace config, else PATH)

export interface Toolchain {
  forge: string | null;
  forgeVersion: string | null;
  forgeDigest: string | null;
  solcCache: string | null;
  binds: Bind[];
  env: Record<string, string>;
  limitations: string[];
}

const digestCache = new Map<string, string>();

function cachedDigest(path: string): string | null {
  try {
    const st = statSync(path);
    const key = `${path}:${st.size}:${st.mtimeMs}`;
    let d = digestCache.get(key);
    if (!d) {
      d = digestFile(path);
      digestCache.set(key, d);
    }
    return d;
  } catch {
    return null;
  }
}

function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}

export const TOOL_ROOT = '/opt/tools';

export function foundryToolchain(ws: Workspace): Toolchain {
  const limitations: string[] = [];
  const configured = ws.config.tools?.forge ?? null;
  const found = configured ?? which('forge');
  let forge: string | null = null;
  try {
    forge = found ? realpathSync(found) : null;
  } catch {
    forge = null;
  }
  // A mise/asdf shim is a launcher script, not the tool; the operator must point at the real binary.
  if (forge && /shims?\//.test(forge)) limitations.push(`forge resolves to a shim (${forge}); configure tools.forge`);
  let forgeVersion: string | null = null;
  if (forge) {
    try {
      forgeVersion = execFileSync(forge, ['--version'], { encoding: 'utf8', env: {}, timeout: 10000 }).split('\n')[0].trim();
    } catch {
      forgeVersion = null;
    }
  }
  const svmCandidates = [join(homedir(), '.svm'), join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'svm')];
  const solcCache = svmCandidates.find((p) => existsSync(p)) ?? null;
  if (!solcCache) limitations.push('no cached solc compilers found; offline builds can only use compilers already cached');
  const binds: Bind[] = [];
  if (forge) binds.push({ src: dirname(forge), dest: `${TOOL_ROOT}/foundry` });
  if (solcCache) binds.push({ src: solcCache, dest: `${TOOL_ROOT}/share/svm` });
  return {
    forge,
    forgeVersion,
    forgeDigest: forge ? cachedDigest(forge) : null,
    solcCache,
    binds,
    env: {
      HOME: '/home/sandbox',
      PATH: `${TOOL_ROOT}/foundry:/usr/bin`,
      XDG_DATA_HOME: `${TOOL_ROOT}/share`,
      TMPDIR: '/tmp',
      NO_COLOR: '1',
      // Inherited tool configuration cannot re-enable these (env overrides foundry.toml).
      FOUNDRY_OFFLINE: 'true',
      FOUNDRY_FFI: 'false',
      FOUNDRY_DISABLE_NIGHTLY_WARNING: '1',
    },
    limitations,
  };
}

// -----------------------------------------------------------------------------------------------
// Shared interpretation of abnormal ends

function result(
  result_type: StructuredResult['result_type'],
  mode: string,
  interpretation: string,
  tests: StructuredResult['tests'] = [],
  bounds: string | null = null,
): StructuredResult {
  return { result_type, mode, bounds, interpretation, tests };
}

/** An attempt that did not run to completion is never a clean result. */
export function abnormalEnd(obs: Observation): Interpretation | null {
  if (obs.cancelled) {
    return {
      result: result('inconclusive', obs.mode, 'attempt was stopped (pause or cancel) before completion; partial output only'),
      failed: null,
      limitations: [],
      missing: ['run stopped before completion'],
    };
  }
  if (obs.timed_out) {
    return {
      result: result('inconclusive', obs.mode, 'runtime limit reached; the tool did not finish'),
      failed: 'runtime limit reached',
      limitations: [],
      missing: ['run exceeded its runtime limit'],
    };
  }
  if (obs.signal) {
    return {
      result: result('error', obs.mode, `tool terminated by ${obs.signal}; a crash is not evidence`),
      failed: `terminated by ${obs.signal}`,
      limitations: [],
      missing: [],
    };
  }
  return null;
}

const ARG_VALUE = /^[A-Za-z0-9_.*\/\[\]|()^$?+{}:,=-]{1,256}$/;

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !ARG_VALUE.test(v) || v.startsWith('-')) fail('invalid_request', `argument ${key} is not an accepted value`);
  return v;
}

function intArg(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) fail('invalid_request', `argument ${key} must be a non-negative integer`);
  return v;
}

function onlyKeys(args: Record<string, unknown>, allowed: string[]): void {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('invalid_request', 'args must be an object');
  for (const k of Object.keys(args)) if (!allowed.includes(k)) fail('invalid_request', `unsupported argument ${k}`);
}

function forgeDescriptor(tc: Toolchain, name: string, modes: string[], purposes: JobPurpose[], outputs: string[]): AdapterDescriptor {
  return {
    contract_version: 1,
    name,
    version: '1',
    registered_by: 'builtin',
    executable: { path: tc.forge ?? 'forge (unresolved)', digest: tc.forgeDigest, version: tc.forgeVersion },
    ecosystem: 'evm/solidity/foundry',
    modes,
    purposes,
    input_types: ['target_snapshot', 'fixture_tree'],
    output_types: outputs,
    limits: { runtime_seconds_max: null },
    capabilities: { filesystem: ['/target:ro', '/work:rw(scratch copy)', '/outbox:rw'], network: 'denied' },
    cancellation: 'process_group_terminate (SIGTERM, SIGKILL after grace)',
    replay: 'deterministic rerun from snapshot, fixture and pinned toolchain',
    grant_in_sandbox: false,
  };
}

function requireForge(tc: Toolchain): string {
  if (!tc.forge) fail('unsupported', 'forge is not available; configure tools.forge');
  return `${TOOL_ROOT}/foundry/${basename(tc.forge)}`;
}

// -----------------------------------------------------------------------------------------------
// forge_build: compiler artifacts for intake (output contract in hooks.ts)

export function forgeBuildAdapter(tc: Toolchain): Adapter {
  const desc = forgeDescriptor(tc, 'forge_build', ['build'], ['build', 'inventory'], ['out_tree']);
  return {
    descriptor: () => desc,
    validate(args) {
      onlyKeys(args, []);
    },
    plan() {
      return {
        argv: [requireForge(tc), 'build', '--ast', '--extra-output', 'storageLayout', '--out', 'out', '--offline'],
        env: tc.env,
        binds: tc.binds,
        outputs: ['out'],
        mode: 'build',
        limitations: [...tc.limitations],
      };
    },
    interpret(obs) {
      const abnormal = abnormalEnd(obs);
      if (abnormal) return abnormal;
      if (obs.exit_code !== 0) {
        const compile = /Compiler run failed|Error \(\d+\)|ParserError|TypeError/.test(obs.stderr);
        return {
          result: result('error', 'build', compile ? 'compilation failed' : `forge build exited with ${obs.exit_code}`),
          failed: compile ? 'compilation failed' : `forge build exited with ${obs.exit_code}`,
          limitations: [],
          missing: [],
        };
      }
      return {
        result: result('inconclusive', 'build', 'build completed (exit 0); a build checks no audit property, so no violation result applies'),
        failed: null,
        limitations: [],
        missing: [],
      };
    },
  };
}

// -----------------------------------------------------------------------------------------------
// forge_test: unit/PoC tests with declared expectations

export interface TestExpectation {
  /** `Contract.test()`, `Contract.test` or `test` (function name). */
  test: string;
  /**
   * `violation`: the test asserts that the violation happens (a passing test demonstrates it).
   * `no_violation`: the test asserts that the property holds (a failing assertion is a counterexample).
   */
  expect: 'violation' | 'no_violation';
}

const TEST_ARGS = ['match_test', 'match_contract', 'match_path', 'no_match_test', 'fuzz_runs', 'fuzz_seed', 'invariant_runs', 'invariant_depth', 'expect'];

export function forgeTestAdapter(tc: Toolchain): Adapter {
  const desc = forgeDescriptor(
    tc,
    'forge_test',
    ['test'],
    ['baseline_tests', 'experiment', 'replay', 'positive_control', 'adequacy', 'probe'],
    ['test_results_json', 'out_tree'],
  );
  return {
    descriptor: () => desc,
    validate(args) {
      onlyKeys(args, TEST_ARGS);
      for (const k of ['match_test', 'match_contract', 'match_path', 'no_match_test']) stringArg(args, k);
      intArg(args, 'fuzz_runs');
      intArg(args, 'fuzz_seed');
      intArg(args, 'invariant_runs');
      intArg(args, 'invariant_depth');
      expectations(args);
    },
    plan(args) {
      const argv = [requireForge(tc), 'test', '--json', '--offline'];
      const flag = (k: string, f: string) => {
        const v = stringArg(args, k);
        if (v !== null) argv.push(`${f}=${v}`);
      };
      flag('match_test', '--match-test');
      flag('match_contract', '--match-contract');
      flag('match_path', '--match-path');
      flag('no_match_test', '--no-match-test');
      const runs = intArg(args, 'fuzz_runs');
      if (runs !== null) argv.push(`--fuzz-runs=${runs}`);
      const seed = intArg(args, 'fuzz_seed');
      if (seed !== null) argv.push(`--fuzz-seed=${seed}`);
      // Invariant campaign size has no CLI flag; the environment overrides foundry.toml.
      const env = { ...tc.env };
      const iruns = intArg(args, 'invariant_runs');
      if (iruns !== null) env.FOUNDRY_INVARIANT_RUNS = String(iruns);
      const idepth = intArg(args, 'invariant_depth');
      if (idepth !== null) env.FOUNDRY_INVARIANT_DEPTH = String(idepth);
      return { argv, env, binds: tc.binds, outputs: [], mode: 'test', limitations: [...tc.limitations] };
    },
    interpret: interpretForgeTest,
    prepare: downgradeFsPermissions,
  };
}

function expectations(args: Record<string, unknown>): TestExpectation[] {
  const e = args.expect;
  if (e === undefined || e === null) return [];
  if (!Array.isArray(e)) fail('invalid_request', 'expect must be a list of {test, expect}');
  return e.map((x) => {
    if (!x || typeof x.test !== 'string' || !x.test || !['violation', 'no_violation'].includes(x.expect)) {
      fail('invalid_request', 'each expectation needs a test name and expect: violation | no_violation');
    }
    return { test: x.test, expect: x.expect };
  });
}

interface ForgeTestCase {
  status: string;
  reason: string | null;
  counterexample: unknown;
  kind?: { Unit?: unknown; Fuzz?: { runs?: number }; Invariant?: { runs?: number; calls?: number; reverts?: number } };
}

type ForgeJson = Record<string, { test_results: Record<string, ForgeTestCase> }>;

/**
 * forge may print event lines (e.g. invariant failures) besides the result object; exactly one line
 * may be suite-shaped. More than one means the output cannot be trusted (a test could have written
 * a forged document), and the caller treats the run as inconclusive.
 */
function parseForgeJson(stdout: string): { parsed: ForgeJson | null; documents: number } {
  const found: ForgeJson[] = [];
  for (const line of stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))) {
    try {
      const v = JSON.parse(line);
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const suites = Object.values(v);
      if (suites.length && suites.every((x) => x && typeof x === 'object' && typeof (x as { test_results?: unknown }).test_results === 'object')) found.push(v as ForgeJson);
    } catch {
      /* not a JSON line */
    }
  }
  return { parsed: found.length === 1 ? found[0] : null, documents: found.length };
}

/**
 * The target's foundry.toml may grant cheatcode file writes (`fs_permissions`). Foundry does not take
 * that setting from the environment, so the scratch copy's root config is downgraded to read-only.
 */
export function downgradeFsPermissions(workDir: string): string[] {
  const p = join(workDir, 'foundry.toml');
  if (!existsSync(p)) return [];
  const text = readFileSync(p, 'utf8');
  const next = text.replace(/(\baccess\s*=\s*)("read-write"|'read-write'|"write"|'write'|true)/g, '$1"read"');
  if (next === text) return [];
  writeFileSync(p, next);
  return ['fs_permissions write access in the target foundry.toml was downgraded to read in the scratch copy'];
}

function matches(exp: TestExpectation, contract: string, sig: string): boolean {
  const fn = sig.replace(/\(.*$/, '');
  return exp.test === `${contract}.${sig}` || exp.test === `${contract}.${fn}` || exp.test === fn || exp.test === sig;
}

/** A failing call sequence (invariant) or input (fuzz), rendered one step per entry. */
function counterexampleSteps(ce: unknown): string[] | null {
  if (!ce || typeof ce !== 'object') return null;
  const step = (c: Record<string, unknown>) =>
    c.func_name
      ? `${String(c.contract_name ?? '').replace(/^.*:/, '')}.${String(c.func_name)}(${String(c.raw_args ?? c.args ?? '')})${c.sender ? ` from ${String(c.sender)}` : ''}`
      : `calldata ${String(c.calldata ?? '')} args (${String(c.raw_args ?? c.args ?? '')})`;
  const o = ce as { Sequence?: unknown; Single?: Record<string, unknown> };
  if (o.Single) return [step(o.Single)];
  if (Array.isArray(o.Sequence)) {
    const calls = Array.isArray(o.Sequence[1]) ? o.Sequence[1] : o.Sequence;
    return (calls as Record<string, unknown>[]).filter((c) => c && typeof c === 'object').map(step);
  }
  return null;
}

type Campaign = NonNullable<StructuredResult['campaign']>;

export function interpretForgeTest(obs: Observation): Interpretation {
  const abnormal = abnormalEnd(obs);
  if (abnormal) return abnormal;
  const mode = obs.mode;
  const doc = obs.stdout_truncated ? { parsed: null, documents: 0 } : parseForgeJson(obs.stdout);
  if (doc.documents > 1) {
    return {
      result: result('inconclusive', mode, `stdout carried ${doc.documents} test-result documents; forge prints one, so the output may be forged and is not interpreted`),
      failed: null,
      limitations: [],
      missing: ['ambiguous test results: more than one results document on stdout'],
    };
  }
  const parsed = doc.parsed;
  if (!parsed) {
    if (/Compiler run failed|Error \(\d+\)|ParserError|TypeError|DeclarationError/.test(obs.stderr)) {
      return {
        result: result('error', mode, 'compilation failed; no test ran, so this is not evidence either way'),
        failed: 'compilation failed',
        limitations: [],
        missing: [],
      };
    }
    if (obs.exit_code !== 0 && obs.exit_code !== 1) {
      return {
        result: result('error', mode, `forge test exited with ${obs.exit_code} without structured results`),
        failed: `forge test exited with ${obs.exit_code}`,
        limitations: [],
        missing: [],
      };
    }
    // A completed process whose output cannot be parsed never yields "no violation".
    return {
      result: result('inconclusive', mode, 'test results could not be parsed from a completed run; no violation result can be inferred'),
      failed: null,
      limitations: [],
      missing: [obs.stdout_truncated ? 'stdout truncated at the output limit; results unparsed' : 'structured test results missing'],
    };
  }

  const exps = expectations(obs.args);
  const tests: StructuredResult['tests'] = [];
  const notes: string[] = [];
  const kinds = new Set<'counterexample' | 'no_violation_observed' | 'inconclusive'>();
  let setupFailed = false;
  let campaign: Campaign | null = null;
  let anyAllReverted = false;
  let undeclaredFailures = 0;
  const neverSucceeded = new Set<string>();
  const seen = new Set<TestExpectation>();
  const control = obs.baseline !== undefined;
  for (const [suite, body] of Object.entries(parsed)) {
    const contract = suite.includes(':') ? suite.slice(suite.lastIndexOf(':') + 1) : suite;
    for (const [sig, tc] of Object.entries(body.test_results)) {
      const status = tc.status === 'Success' ? 'passed' : tc.status === 'Skipped' ? 'skipped' : 'failed';
      const exp = exps.find((e) => matches(e, contract, sig)) ?? null;
      if (exp) seen.add(exp);
      const name = `${contract}.${sig}`;
      const steps = counterexampleSteps(tc.counterexample);
      let reason = tc.reason ?? null;
      if (steps) reason = `${reason ?? 'failed'}; counterexample: ${steps.join(' -> ').slice(0, 2000)}`;
      tests.push({ name, status, reason, expect: exp?.expect ?? null });

      // Campaign statistics (fuzz runs; invariant runs, calls and reverts; handlers that never succeeded).
      const inv = tc.kind?.Invariant as ({ runs?: number; calls?: number; reverts?: number; metrics?: Record<string, { calls?: number; reverts?: number }> } | undefined);
      const fuzz = tc.kind?.Fuzz;
      const allReverted = !!inv && (inv.calls ?? 0) > 0 && inv.reverts === inv.calls && !steps?.length;
      const stuck = Object.entries(inv?.metrics ?? {})
        .filter(([, m]) => (m.calls ?? 0) > 0 && m.reverts === m.calls)
        .map(([h]) => h.replace(/^.*:/, ''));
      // A broken invariant reports 0 runs/calls at the top level (forge 1.7); its per-handler metrics and
      // the failing sequence show it did run. "No contracts to fuzz" shows neither.
      const metricCalls = Object.values(inv?.metrics ?? {}).reduce((n, m) => n + (m.calls ?? 0), 0);
      const invCalls = Math.max(inv?.calls ?? 0, metricCalls, steps?.length ?? 0);
      const ranCampaign = inv ? invCalls > 0 && ((inv.runs ?? 0) > 0 || !!steps?.length) : fuzz ? (fuzz.runs ?? 0) > 0 || !!steps?.length : true;
      if (inv || fuzz) {
        campaign ??= { runs: 0, calls: 0, reverts: 0, counterexample: null, all_actions_reverted: false, never_succeeded: [] };
        campaign.runs += (inv ?? fuzz)!.runs ?? 0;
        campaign.calls += inv ? invCalls : 0;
        campaign.reverts += inv?.reverts ?? 0;
        if (steps && !campaign.counterexample && exp) campaign.counterexample = steps;
        for (const h of stuck) neverSucceeded.add(h);
        if (allReverted) {
          anyAllReverted = true;
          campaign.all_actions_reverted = true;
          notes.push(`${name}: adequacy insufficient: every action reverted (${inv!.calls} calls, ${inv!.reverts} reverts)`);
        }
      }

      if (/^setUp\(/.test(sig) && status === 'failed') {
        setupFailed = true;
        notes.push(`${contract}.setUp failed (${tc.reason ?? 'no reason'}): the fixture did not reach any assertion`);
        continue;
      }
      if (!exp) {
        // Only declared tests decide; an undeclared failure still makes the run unclean.
        if (status === 'failed') {
          undeclaredFailures++;
          notes.push(`${name} (no declared expectation) failed: ${tc.reason ?? 'no reason'}`);
        }
        continue;
      }
      if (status === 'skipped') {
        kinds.add('inconclusive');
        notes.push(`${name} was skipped`);
        continue;
      }
      if (!ranCampaign) {
        kinds.add('inconclusive');
        notes.push(`${name} did not run its campaign (${inv ? `${inv.runs ?? 0} runs, ${inv.calls ?? 0} calls` : `${fuzz?.runs ?? 0} fuzz runs`}${status === 'failed' ? `; failed: ${tc.reason ?? 'no reason'}` : ''}): no property was exercised`);
        continue;
      }
      // Outcome of the declared test: did this run show the violation?
      let violation: boolean | null;
      if (inv) {
        // An invariant asserts a property: a broken invariant is a violation whether the auditor expects
        // it to hold (`no_violation`) or expects the campaign to break it (`violation`).
        violation = status === 'failed' ? true : allReverted || stuck.length ? null : false;
        if (violation === null) notes.push(`${name} held, but ${allReverted ? 'every action reverted' : `handlers never succeeded: ${stuck.join(', ')}`}: adequacy insufficient`);
      } else if (exp.expect === 'violation') {
        violation = status === 'passed';
      } else {
        violation = status === 'failed';
      }
      if (violation === null) {
        kinds.add('inconclusive');
        continue;
      }
      if (violation && control) {
        // A control or adequacy run counts only where the source edit flipped the checked experiment.
        const before = (obs.baseline ?? []).find((t) => t.name === name);
        const beforeViolation = before ? (inv || exp.expect !== 'violation' ? before.status === 'failed' : before.status === 'passed') : null;
        if (beforeViolation !== false) {
          kinds.add('inconclusive');
          notes.push(`${name} shows the violation, but ${before ? 'so did' : 'it did not run in'} the checked experiment: the edit did not flip it`);
          continue;
        }
      }
      if (violation) {
        kinds.add('counterexample');
        notes.push(
          inv
            ? `${name} invariant broken (${tc.reason ?? 'no reason'}) after ${invCalls} calls: property violated in this campaign`
            : exp.expect === 'violation'
              ? `${name} asserts the violation and passed: violation demonstrated in this run`
              : `${name} asserts the property and failed (${tc.reason ?? 'no reason'}): property violated in this run, unless the fixture is at fault`,
        );
      } else {
        kinds.add('no_violation_observed');
        notes.push(
          inv
            ? `${name} invariant held over ${inv.runs ?? 0} runs / ${inv.calls ?? 0} calls (${inv.reverts ?? 0} reverted)${exp.expect === 'violation' ? '; the expected violation was not found' : ''}`
            : exp.expect === 'violation'
              ? `${name} asserts the violation and failed (${tc.reason ?? 'no reason'}): the violation was not demonstrated; the failure may indict the fixture`
              : `${name} asserts the property and passed: no violation observed within this run${fuzz ? ` (${fuzz.runs ?? 0} fuzz runs)` : ''}`,
        );
      }
    }
  }
  if (campaign) campaign.never_succeeded = [...neverSucceeded].sort();
  const missing = exps.filter((e) => !seen.has(e)).map((e) => `expected test ${e.test} did not run`);
  const anyRan = tests.some((t) => t.status !== 'skipped');

  let type: StructuredResult['result_type'];
  if (!anyRan) {
    type = 'inconclusive';
    notes.push('no test ran');
  } else if (setupFailed) {
    type = 'inconclusive';
  } else if (control && obs.baseline === null) {
    type = 'inconclusive';
    notes.push('the checked experiment has no completed result to compare against');
  } else if (exps.length === 0) {
    // Without declared expectations a failure is not interpreted as a violation.
    const failed = tests.filter((t) => t.status === 'failed');
    type = failed.length || anyAllReverted || neverSucceeded.size ? 'inconclusive' : 'no_violation_observed';
    notes.push(
      failed.length
        ? `${failed.length} test(s) failed without a declared expectation; not interpreted as a violation`
        : 'all tests passed; no expectations were declared, so each passing test is read as its property holding in this run',
    );
  } else if (undeclaredFailures) {
    type = 'inconclusive';
    notes.push(`${undeclaredFailures} undeclared test(s) failed: the run is not clean, and only declared tests decide`);
  } else if (kinds.has('counterexample')) {
    type = 'counterexample';
  } else if (missing.length || kinds.has('inconclusive') || !kinds.has('no_violation_observed')) {
    type = 'inconclusive';
  } else {
    type = 'no_violation_observed';
  }
  // A campaign in which every action (or some handler's every call) reverted never counts as "no violation observed".
  if (type === 'no_violation_observed' && (anyAllReverted || neverSucceeded.size)) type = 'inconclusive';
  const lead = type === 'inconclusive' && anyAllReverted ? 'adequacy insufficient: every action reverted. ' : '';
  const bounds = campaign
    ? `campaign: ${campaign.runs} runs, ${campaign.calls} calls, ${campaign.reverts} reverts`
    : obs.args.fuzz_runs !== undefined
      ? `fuzz runs: ${obs.args.fuzz_runs}`
      : 'executed tests only';
  const res = result(type, mode, `${lead}exit status ${obs.exit_code} (forge exits 1 when any test fails; the status is not the result). ${notes.join('; ')}`, tests, bounds);
  if (campaign) res.campaign = campaign;
  return { result: res, failed: null, limitations: [], missing };
}

// -----------------------------------------------------------------------------------------------
// command: operator-registered generic structured-argv adapter

export interface CommandAdapterSpec {
  name: string;
  version: string;
  /** Absolute host path of the executable (operator-chosen). */
  executable: string;
  purposes: JobPurpose[];
  /** Fixed leading arguments; requests append `args.argv`. */
  argv_prefix?: string[];
  outputs?: string[];
  extra_binds?: Bind[];
  env?: Record<string, string>;
  /** Make the worker grant token readable at /run/harness/grant (agent hosts that call back). */
  grant_in_sandbox?: boolean;
  interpret?: (obs: Observation) => Interpretation;
}

export function commandAdapter(spec: CommandAdapterSpec): Adapter {
  if (!isAbsolute(spec.executable) || !existsSync(spec.executable)) throw new Error(`command adapter executable ${spec.executable} not found`);
  const real = realpathSync(spec.executable);
  const underUsr = real.startsWith('/usr/');
  const inSandbox = underUsr ? real : `${TOOL_ROOT}/${spec.name}/${basename(real)}`;
  const binds: Bind[] = [...(underUsr ? [] : [{ src: dirname(real), dest: `${TOOL_ROOT}/${spec.name}` }]), ...(spec.extra_binds ?? [])];
  const desc: AdapterDescriptor = {
    contract_version: 1,
    name: spec.name,
    version: spec.version,
    registered_by: 'operator',
    executable: { path: real, digest: cachedDigest(real), version: null },
    ecosystem: 'generic',
    modes: ['command'],
    purposes: spec.purposes,
    input_types: ['target_snapshot', 'fixture_tree'],
    output_types: spec.outputs?.length ? ['tree'] : [],
    limits: { runtime_seconds_max: null },
    capabilities: { filesystem: ['/target:ro', '/work:rw(scratch copy)', '/outbox:rw'], network: 'denied' },
    cancellation: 'process_group_terminate (SIGTERM, SIGKILL after grace)',
    replay: 'rerun with identical argv, snapshot and fixture; determinism not guaranteed',
    grant_in_sandbox: !!spec.grant_in_sandbox,
  };
  return {
    descriptor: () => desc,
    validate(args) {
      onlyKeys(args, ['argv']);
      const argv = args.argv ?? [];
      if (!Array.isArray(argv) || argv.length > 256 || argv.some((a) => typeof a !== 'string' || a.length > 4096 || a.includes('\0'))) {
        fail('invalid_request', 'argv must be a list of at most 256 strings');
      }
    },
    plan(args) {
      return {
        argv: [inSandbox, ...(spec.argv_prefix ?? []), ...((args.argv as string[] | undefined) ?? [])],
        env: { HOME: '/home/sandbox', PATH: '/usr/bin', TMPDIR: '/tmp', ...(spec.env ?? {}) },
        binds,
        outputs: spec.outputs ?? [],
        mode: 'command',
        limitations: [],
      };
    },
    interpret(obs) {
      const abnormal = abnormalEnd(obs);
      if (abnormal) return abnormal;
      if (spec.interpret) return spec.interpret(obs);
      if (obs.exit_code !== 0) {
        return {
          result: result('error', 'command', `command exited with ${obs.exit_code}`),
          failed: `command exited with ${obs.exit_code}`,
          limitations: [],
          missing: [],
        };
      }
      return {
        result: result('inconclusive', 'command', 'command completed (exit 0); no property interpretation is registered for it'),
        failed: null,
        limitations: [],
        missing: [],
      };
    },
  };
}

// -----------------------------------------------------------------------------------------------
// reference_agent: the reference agent host (src/agents/runtime.ts) run inside the sandbox

/** The repository's agent runtime directory, mounted read-only at /opt/harness/agent. */
export const REFERENCE_AGENT_DIR = fileURLToPath(new URL('../agents/', import.meta.url));
/** In-sandbox helper scripts (the broker TCP forwarder), mounted read-only at /opt/harness/tools. */
export const SANDBOX_TOOLS_DIR = fileURLToPath(new URL('./sandbox-tools/', import.meta.url));

function dirDigest(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p, `${rel}${name}/`);
      else if (st.isFile()) files[`${rel}${name}`] = cachedDigest(p) ?? '';
    }
  };
  walk(dir, '');
  return digestJson(files);
}

const AGENT_ARGS = ['task', 'model', 'max_turns', 'max_tokens'];

export function referenceAgentAdapter(opts: { name: string; agentDir: string; registered_by: 'builtin' | 'operator'; version?: string }): Adapter {
  const node = realpathSync(process.execPath);
  const agentDir = existsSync(opts.agentDir) ? realpathSync(opts.agentDir) : opts.agentDir;
  const desc: AdapterDescriptor = {
    contract_version: 1,
    name: opts.name,
    version: opts.version ?? '1',
    registered_by: opts.registered_by,
    executable: { path: node, digest: cachedDigest(node), version: process.version },
    ecosystem: 'agent-host/node',
    modes: ['agent'],
    purposes: ['agent'],
    input_types: ['context_manifest', 'task'],
    output_types: ['outbox_requests'],
    limits: { runtime_seconds_max: null },
    capabilities: {
      filesystem: ['/context:ro', '/target:ro', '/work:rw(scratch copy)', '/outbox:rw', '/run/harness:ro', '/opt/harness/agent:ro'],
      network: 'denied',
    },
    cancellation: 'process_group_terminate (SIGTERM, SIGKILL after grace)',
    replay: 'not replayable: model output is not deterministic; outbox requests and provider payload digests are recorded',
    grant_in_sandbox: true,
    provider_access: true,
    context_mount: true,
    components: [
      { name: 'agent_runtime', path: agentDir, digest: dirDigest(agentDir) },
      { name: 'sandbox_tools', path: SANDBOX_TOOLS_DIR, digest: dirDigest(SANDBOX_TOOLS_DIR) },
    ],
  };
  return {
    descriptor: () => desc,
    validate(args) {
      if (!existsSync(join(agentDir, 'runtime.ts'))) fail('unsupported', `agent runtime ${join(agentDir, 'runtime.ts')} is not installed`);
      onlyKeys(args, AGENT_ARGS);
      if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 64 * 1024) fail('invalid_request', 'agent jobs need a task (at most 64 KiB)');
      if (typeof args.model !== 'string' || !/^[A-Za-z0-9._:@-]{1,128}$/.test(args.model)) fail('invalid_request', 'agent jobs name a model');
      intArg(args, 'max_turns');
      intArg(args, 'max_tokens');
    },
    plan(args, ctx) {
      return {
        argv: [`${TOOL_ROOT}/node/${basename(node)}`, '/opt/harness/agent/runtime.ts'],
        env: {
          HOME: '/home/sandbox',
          PATH: `${TOOL_ROOT}/node:/usr/bin`,
          TMPDIR: '/tmp',
          HARNESS_ROLE: ctx?.role ?? 'tool',
          HARNESS_MODEL: String(args.model),
          HARNESS_FORWARDER: '/opt/harness/tools/forward.mjs',
        },
        binds: [
          // The node binary alone, not its installation directory (npm, other tools stay out of reach).
          { src: node, dest: `${TOOL_ROOT}/node/${basename(node)}` },
          { src: agentDir, dest: '/opt/harness/agent' },
          { src: SANDBOX_TOOLS_DIR, dest: '/opt/harness/tools' },
        ],
        outputs: [],
        mode: 'agent',
        limitations: ['agent output is model-generated; its outbox requests are proposals checked by the controller, not evidence'],
      };
    },
    interpret(obs) {
      const abnormal = abnormalEnd(obs);
      if (abnormal) return abnormal;
      if (obs.exit_code !== 0) {
        return { result: result('error', 'agent', `agent runtime exited with ${obs.exit_code}`), failed: `agent runtime exited with ${obs.exit_code}`, limitations: [], missing: [] };
      }
      return {
        result: result('inconclusive', 'agent', 'agent run completed; its results are the outbox requests the controller admitted, not execution evidence'),
        failed: null,
        limitations: [],
        missing: [],
      };
    },
  };
}

// -----------------------------------------------------------------------------------------------
// claude_code: CANDIDATE external agent host (compatibility trial, DEC-008 Q-018). Registered so it
// can be trialled; the agent host remains an operator choice, and no engagement uses it unless an
// authorization lists it. Credentials are never involved: the tool talks to the per-attempt broker
// (through the in-sandbox TCP forwarder) with the attempt's grant token as its API key, and the broker
// injects the real provider credential. Its proposals reach the controller as JSON request files it
// writes under /outbox with its own file tools.

/** Operator override for the binary; otherwise `claude` on PATH. */
export function resolveClaudeCode(): string | null {
  const configured = process.env.HARNESS_CLAUDE_CODE ?? which('claude');
  if (!configured || !existsSync(configured)) return null;
  try {
    return realpathSync(configured);
  } catch {
    return null;
  }
}

/** Settings passed with --settings (verified names in the 2.1.x binary): no hooks, no auto-memory. */
export const CLAUDE_CODE_SETTINGS = { disableAllHooks: true, autoMemoryEnabled: false };

export const OUTBOX_PROTOCOL = [
  'You are running inside the audit harness sandbox. The context manifest is at /context/manifest.json and source views under /context/sources.',
  'To propose anything to the controller, write one JSON file per request under /outbox, named NNN-<operation>.json, containing {"operation": "<name>", "payload": {...}}.',
  'Files are ingested in name order after you exit; a payload may reference an earlier entry\'s result with {"$result": "<earlier file name without .json>", "path": "<dot path>"}.',
  'You have no network access and cannot approve anything; the auditor decides.',
].join(' ');

const CLAUDE_SCRIPT = [
  'set -u',
  'node=/opt/tools/node/node',
  '"$node" /opt/harness/tools/forward.mjs 8787 "$HARNESS_BROKER_SOCKET" >/dev/null 2>&1 &',
  'fwd=$!',
  'for i in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/8787) 2>/dev/null && break; sleep 0.1; done',
  // The grant token is the API key the broker accepts; it is not a provider credential.
  'export ANTHROPIC_API_KEY="$(cat "$HARNESS_GRANT_FILE")"',
  'task="$("$node" -e \'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.HARNESS_TASK, "utf8")).args.task)\')"',
  '/opt/tools/claude/claude -p "$task" --model "$HARNESS_MODEL" --output-format json --bare --tools Read,Edit --permission-mode acceptEdits --permission-prompts none --add-dir /outbox --add-dir /context --no-session-persistence --strict-mcp-config --settings "$CLAUDE_SETTINGS" --append-system-prompt "$HARNESS_OUTBOX_PROTOCOL" </dev/null',
  'rc=$?',
  'kill "$fwd" 2>/dev/null',
  'exit $rc',
].join('\n');

export function claudeCodeAdapter(opts: { binary: string | null; name?: string; registered_by?: 'builtin' | 'operator' }): Adapter {
  const binary = opts.binary;
  const node = realpathSync(process.execPath);
  // The descriptor (a 250 MB binary's digest and its version) is computed on first use only.
  let cached: AdapterDescriptor | null = null;
  const describe = (): AdapterDescriptor => {
    if (cached) return cached;
    let version: string | null = null;
    if (binary) {
      try {
        // Version only, from the binary itself with an empty environment (no config is read).
        version = execFileSync(binary, ['--version'], { encoding: 'utf8', env: { HOME: '/nonexistent', PATH: '/usr/bin' }, timeout: 15000 }).trim();
      } catch {
        version = null;
      }
    }
    cached = {
    contract_version: 1,
    name: opts.name ?? 'claude_code',
    version: '0-candidate',
    registered_by: opts.registered_by ?? 'builtin',
    executable: { path: binary ?? 'claude (not installed)', digest: binary ? cachedDigest(binary) : null, version },
    ecosystem: 'agent-host/claude-code (CANDIDATE; compatibility trial only)',
    modes: ['agent'],
    purposes: ['agent'],
    input_types: ['context_manifest', 'task'],
    output_types: ['outbox_requests'],
    limits: { runtime_seconds_max: null },
    capabilities: { filesystem: ['/context:ro', '/target:ro', '/work:rw(scratch copy)', '/outbox:rw', '/run/harness:ro'], network: 'denied' },
    cancellation: 'process_group_terminate (SIGTERM, SIGKILL after grace)',
    replay: 'not replayable: model output is not deterministic; outbox requests and provider payload digests are recorded',
    grant_in_sandbox: true,
    provider_access: true,
    context_mount: true,
    components: [
      { name: 'node_for_forwarder', path: node, digest: cachedDigest(node) },
      { name: 'sandbox_tools', path: SANDBOX_TOOLS_DIR, digest: dirDigest(SANDBOX_TOOLS_DIR) },
    ],
  };
    return cached;
  };
  return {
    descriptor: describe,
    validate(args) {
      if (!binary) fail('unsupported', 'Claude Code is not installed (set HARNESS_CLAUDE_CODE or put `claude` on PATH)');
      onlyKeys(args, AGENT_ARGS);
      if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 64 * 1024) fail('invalid_request', 'agent jobs need a task (at most 64 KiB)');
      if (typeof args.model !== 'string' || !/^[A-Za-z0-9._:@-]{1,128}$/.test(args.model)) fail('invalid_request', 'agent jobs name a model');
      intArg(args, 'max_turns');
      intArg(args, 'max_tokens');
    },
    plan(args, ctx) {
      return {
        argv: ['/usr/bin/bash', '-c', CLAUDE_SCRIPT],
        env: {
          HOME: '/home/sandbox',
          PATH: `${TOOL_ROOT}/claude:${TOOL_ROOT}/node:/usr/bin`,
          TMPDIR: '/tmp',
          HARNESS_ROLE: ctx?.role ?? 'tool',
          HARNESS_MODEL: String(args.model),
          HARNESS_FORWARDER: '/opt/harness/tools/forward.mjs',
          HARNESS_OUTBOX_PROTOCOL: OUTBOX_PROTOCOL,
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
          CLAUDE_SETTINGS: JSON.stringify(CLAUDE_CODE_SETTINGS),
          // Verified in the binary's strings (2.1.296); each turns off a class of outbound traffic.
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        },
        binds: [
          ...(binary ? [{ src: binary, dest: `${TOOL_ROOT}/claude/claude` }] : []),
          { src: node, dest: `${TOOL_ROOT}/node/node` },
          { src: SANDBOX_TOOLS_DIR, dest: '/opt/harness/tools' },
        ],
        outputs: [],
        mode: 'agent',
        limitations: [
          'CANDIDATE agent host (compatibility trial); its outbox requests are proposals checked by the controller, not evidence',
          'Claude Code receives the attempt grant token as ANTHROPIC_API_KEY; it never sees a provider credential',
        ],
      };
    },
    interpret(obs) {
      const abnormal = abnormalEnd(obs);
      if (abnormal) return abnormal;
      let out: { is_error?: boolean; result?: string; api_error_status?: number | null; num_turns?: number } | null = null;
      for (const line of obs.stdout.split('\n').reverse()) {
        try {
          const v = JSON.parse(line);
          if (v && typeof v === 'object' && v.type === 'result') {
            out = v;
            break;
          }
        } catch {
          /* not the result line */
        }
      }
      if (obs.exit_code !== 0 || !out || out.is_error) {
        const why = out ? `claude reported an error (${out.api_error_status ?? 'no status'}): ${String(out.result ?? '').slice(0, 300)}` : `claude exited with ${obs.exit_code} and no result`;
        return { result: result('error', 'agent', why), failed: why, limitations: [], missing: [] };
      }
      return {
        result: result('inconclusive', 'agent', `Claude Code completed ${out.num_turns ?? '?'} turn(s); its results are the outbox requests the controller admitted, not execution evidence`),
        failed: null,
        limitations: [],
        missing: [],
      };
    },
  };
}
