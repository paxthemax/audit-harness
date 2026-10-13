import type { Ref } from '../core/refs.ts';
import type { OpContext } from '../controller/controller.ts';
import type { JobPurpose, RecordEnvelope } from '../schema/records.ts';

// Seam between the trusted runner and modules that consume completed jobs (snapshot inventory,
// probe reruns, replay/positive-control status). Hooks run inside the runner's `complete_attempt`
// transaction, so their staged records commit atomically with the attempt's completion.
//
// Build output contract: a `forge_build` job's evidence receipt lists
//   outputs: [{ path: 'out', artifact: <tree manifest> }]
// where the tree holds Foundry's `out/**/*.json` artifacts produced with `--ast` and
// `extra_output = ["storageLayout"]` (one JSON per contract, with `ast`, `abi`, `storageLayout`,
// `metadata` and `id` members), plus `build-info` when Foundry emits it.

export interface CompletedJob {
  job: RecordEnvelope<'job'>;
  attempt: Ref;
  /** The trusted-runner evidence record staged for this attempt (null when nothing ran). */
  evidence: Ref | null;
  evidenceBody: RecordEnvelope<'evidence_artifact'>['body'] | null;
}

export type CompletionHook = (ctx: OpContext, done: CompletedJob) => void;

const hooks = new Map<JobPurpose, CompletionHook[]>();

export function onJobCompleted(purpose: JobPurpose, hook: CompletionHook): void {
  const list = hooks.get(purpose) ?? [];
  list.push(hook);
  hooks.set(purpose, list);
}

export function completionHooks(purpose: JobPurpose): CompletionHook[] {
  return hooks.get(purpose) ?? [];
}

// Environment-read scanner seam (design/harness-state-and-execution.md, "Replay and semantic
// validity"): the snapshot module may register a source scanner that lists deterministic environment
// reads (`tx.origin`, `block.coinbase`, `block.basefee`, `block.chainid`, gas price, code at fixed
// addresses such as the cheatcode address) visible in an attempt's scratch copy. The runner flags
// results as environment-sensitive when it returns any. Until one is registered, results say the scan
// did not run.

export type EnvironmentScanner = (workDir: string) => string[];

let environmentScanner: EnvironmentScanner | null = null;

export function setEnvironmentScanner(fn: EnvironmentScanner | null): void {
  environmentScanner = fn;
}

export function currentEnvironmentScanner(): EnvironmentScanner | null {
  return environmentScanner;
}
