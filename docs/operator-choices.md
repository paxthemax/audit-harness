# Open operator choices and implementation defaults

The accepted baseline leaves the store, runner, model provider, sandbox, agent host and numeric limits to the operator ([glossary, "Accepted baseline"](../../framework-design-lab/design/harness-glossary.md#terms)). This implementation needed a working default for each so the walking skeleton runs end to end. None of these defaults is an operator decision. Each is isolated behind a small seam so it can be replaced.

## Choices the specification leaves open

| Choice | Default in this implementation | Where it lives | What replacing it involves |
|---|---|---|---|
| Store | Append-only Git repositories, one per engagement plus one for the mechanism library, validated against JSON Schemas. This is the walking skeleton the spec prescribes (DEC-008, Q-020) | `src/store/` | A transactional store (for example SQLite) is a [deferred mechanism](../../framework-design-lab/design/harness-state-and-execution.md#deferred-mechanisms). It needs journal-consistent backup and the recovery scenarios before adoption |
| Runner | The controller process runs one job at a time as a child process group it owns | `src/runner/` | Parallel or remote workers bring leases, heartbeats and fencing (deferred mechanisms) |
| Sandbox | bubblewrap (`bwrap`): network, PID, IPC and UTS namespaces unshared, read-only system and toolchain binds, read-only target snapshot, per-attempt writable scratch, scrubbed environment. Execution is refused when `bwrap` is missing | `src/runner/sandbox.ts` | Any replacement must first demonstrate default-deny egress ([conformance](../../framework-design-lab/design/harness-interface-contracts.md#compatibility-and-conformance)) |
| Model provider | None configured. The provider broker enforces engagement approval, data classes, reservations and `outcome_unknown` accounting; a `FakeProvider` exists for tests only | `src/runner/provider.ts` | Register a provider adapter in the workspace configuration and approve it per engagement in `accept_scope_and_policy` |
| Agent host | Not selected. A reference host (`reference_agent`) passes every conformance check. Claude Code was trialled as a candidate (`claude_code` adapter): see [agent-host-trial.md](agent-host-trial.md) for the five conditions and the gaps an operator must weigh. The capture channel works as a terminal wrapper (`harness capture`) and as a Claude Code `UserPromptSubmit` hook adapter (`harness capture-hook`) | `src/agents/`, `src/capture/`, `src/runner/` | Choose a host; for an external tool, close or accept its conformance gaps (typed-input capture outside the model, writable tool config in a discarded HOME) |
| Numeric limits | No limit is hard-coded. Every work authorization carries finite spend, runtime, concurrency, child-task, round, retry, repair, output, memory and process limits; review, clarification and decision capacities are set in `accept_scope_and_policy` | `src/decision/work.ts`, `src/schema/records.ts` | The spec's proposed starting values (three investigations per batch, two concurrent agent workers, one heavy experiment, zero child tasks, two repairs per variant) are pilot settings for the operator to set |
| Toolchain | Foundry (`forge`) resolved from `PATH` or `harness.json`; Solidity compilers from the local `svm` cache, bound read-only into the sandbox. Installing compilers is a separate preparation step outside the sandbox | `src/runner/adapters.ts` | Pin tool images and register further adapters (Slither, Echidna, Medusa, Halmos) under the operator's integration policy |

## Implementation-level defaults worth reviewing

These are smaller rules the specification does not fix. They are stated here so the operator can change them deliberately.

| Rule | Default | Code |
|---|---|---|
| When a challenge is required in a packet | Unless potential impact is `low`/`info` or the proposed disposition is `triaged_out` | `challengeRequired` in `src/decision/packets.ts` |
| What counts as a material change for a decision | Any newer revision of a reviewed record or of one of its direct `depends_on` inputs; new or changed inbound links for packets | `commitDecision` in `src/decision/framework.ts` |
| Inbound links of an investigation | Evidence from its jobs or positive controls, discrepancies naming it, clarifications blocking it, statements citing it, its variants, freshness records and probes | `inboundLinks` in `src/decision/packets.ts` |
| Clarification capacity before scope acceptance | Unbounded (no capacity has been set yet, so nothing is held) | `src/decision/clarifications.ts` |
| Which units a batch's "relevant flow" covers | Every audit unit the investigation names must carry a `record_flow_review` decision, and the investigation must name at least one | `src/decision/work.ts` |
| Multi-step or cross-flow question | An investigation spanning two or more units, or a `composition` or `system_invariant` unit. A batch without one is reported as a gap, not refused | `prepare_work` in `src/decision/work.ts` |
| Intent timing with several captured inputs | `after_walkthrough` if any input was captured at or after the unit's first recorded presentation | `deriveIntentTiming` in `src/decision/common.ts` |
| Disposed investigations | Every disposition closes the work administratively; `disputed` and `deferred` remain unresolved through their disposition value | `dispose_investigation` in `src/decision/kinds.ts` |

## Proposed numeric defaults in code

Each constant below is named `PROPOSED_*` or documented as a proposal where it is defined. None is an operator decision; the operator's pilot settings replace them.

| Default | Value | Where |
|---|---|---|
| Job runtime when a request names none | 600 s (capped by the authorization) | `PROPOSED_JOB_RUNTIME_SECONDS`, `src/runner/jobs.ts` |
| Stop grace period before `SIGKILL` | 2 s | `src/runner/sandbox.ts` |
| Worker grant expiry margin beyond the job runtime | 300 s | `src/runner/jobs.ts` |
| Worker outbox | 64 files, 256 KiB each | `src/runner/runner.ts` |
| Sandbox `/tmp` | 512 MB tmpfs | `src/runner/sandbox.ts` |
| Provider call timeout | 120 s | `src/runner/provider.ts` |
| Context references for the live-exploitable data class | 4 | `src/runner/provider.ts` |
| Inline fixture | 64 files, 1 MiB in total | `src/decision/fixtures.ts` |
| Auditor commands through the receipt collector | 600 s, 16 MiB output, 4 GiB memory, 256 processes | `PROPOSED_AUDITOR_LIMITS`, `src/runner/runner.ts` |
| Runs per held-out case for a stochastic method | at least 2 | `MIN_RUNS_PER_CASE`, `src/method/methods.ts` |
| Context builder | 200 records, 20 retrieved items, 2 MiB of source | `src/context/builder.ts` |
| Intake flags per file | 25 | `src/intake/scan.ts` |
| Foundry settings absent from `foundry.toml` | Foundry 1.x defaults (optimizer off, 200 runs, `via_ir` off) until a build confirms them | `src/snapshot/source.ts` |

## Other defaults introduced by the modules

| Rule | Default | Code |
|---|---|---|
| Disclosure constraints vocabulary | `no_unfixed_findings:<audience or *>`, `no_export:<audience or *>`, `note:<text>`; any other string makes export approval fail closed | `src/report/export.ts` |
| Tools the auditor may run through the receipt collector | `forge`, or an executable under `/usr` | `src/runner/runner.ts` |
| Resource limits the sandbox cannot enforce | Memory is an address-space rlimit rather than a cgroup; disk is bounded only for `/tmp`; CPU time is not limited. Every receipt states this | `src/runner/sandbox.ts` |
| Network egress detection | The sandbox has no network; an attempt is inferred from the error text and recorded as a limitation | `src/runner/adapters.ts` |
| Rerun dispatch | `runQueue` queues pending witness and property reruns under the newest current `revalidation` authorization before each job | `src/snapshot/reruns.ts`, `src/runner/runner.ts` |
| Revalidation authorizations | Not bound to a snapshot, since they are the standing allowance for reruns after a change; they also admit the rebuild and test-suite run of a new snapshot | `src/decision/work.ts`, `src/runner/jobs.ts` |
| Retention | `retention_action` marks dependent evidence unavailable but cannot purge bytes from Git history; purging depends on the store choice | `src/report/closure.ts` |

## Rules added after the adversarial review

An independent review of the first build found authority and recovery holes; each fix is pinned by `test/review-regressions.test.ts` or a module test. Several fixes are rules the specification implies but does not spell out:

| Rule | Default | Code |
|---|---|---|
| Who may revise a record | A worker revises only records an agent first wrote, within its granted investigation; it never revises a `reviewed` unit. Any change to a unit's entry points, writers, dependencies, functions or gaps demotes a `reviewed` unit to `partial`; function review flags are set only by `record_flow_review` | `requireAgentAuthored`, `src/decision/proposals.ts` |
| Positions | The author's and the challenger's positions are `position` records bound to the submitting channel and role. A worker may not submit the other side's position, and only the auditor may enter a position as text (labelled as auditor-entered). Challenge independence is derived from the two records | `submit_position`, `src/decision/packets.ts` |
| Positive controls | Count only when they rerun the same experiment of the same claim (adapter, mode, arguments, fixture and variant) with a guard removed; the runner refuses any other positive-control job | `isBoundPositiveControl`, `src/runner/jobs.ts` |
| Refutation before `no_finding_within_bounds` | Refuted variants, refuting experiment evidence, or recorded refuting references all count | `hasRefutation`, `src/decision/packets.ts` |
| Clean replay | A replay whose fixture overrides target files is not clean (`unavailable`) | `replayStatus`, `src/decision/packets.ts` |
| Display receipts | One receipt backs one decision | `commitDecision`, `src/decision/framework.ts` |
| Challenger reads | A challenger worker cannot read review packets, author positions, interpretations or provisional statements | `read_records`, `src/controller/basicOps.ts` |
| Agent impact estimates | An agent may raise its estimate, never lower it | `src/decision/proposals.ts` |
| Provider data class | Derived by the controller from what the context references; a caller may only make it stricter. Worker calls need a context manifest built by the context builder, and only its sources are admitted | `deriveDataClasses`, `src/runner/provider.ts` |
| Disclosure constraint `no_unfixed_findings` | Approval is refused while any payload file (records, `manifest.json`, `report.md`, reproduction) mentions an unfixed finding, even if the selection omits it with a reason. Redacting the required-set entries for that audience is the alternative | `src/report/export.ts` |

### Known limitation

The trusted decision screen and the auditor CLI authenticate with the same `auditor.key`, and the interactive-terminal requirement is checked by the screen program, not by the controller. Any process running as the auditor's user that can read the key and import the controller could forge a screen session. The skeleton trusts the local operator and host (state-and-execution, "Permissions and isolation"); before an agent tool runs as the auditor's own user, the screen needs a separate process or socket that the agent tool cannot reach.

## Defaults added for delivery steps 2–5

| Rule | Default | Code |
|---|---|---|
| Reference agent round | At most 8 model turns (task may lower it; hard cap 50) and 4096 output tokens per turn | `PROPOSED_MAX_TURNS`, `PROPOSED_MAX_TOKENS`, `src/agents/runtime.ts` |
| Agent rounds | Each new logical agent job under an authorization is one round, counted against `limits.rounds`; retries of identical input are attempts | `src/runner/jobs.ts` |
| Data class of agent-authored text | The strictest class of the attempt's context manifest, since the text derives from that context | `src/runner/brokerSocket.ts` |
| Anthropic adapter | Registered as a candidate; credentials only from `secrets/providers/<name>.key` (0600); a rate table copied for the operator to verify; a model without a rate is refused | `src/runner/anthropic.ts` |
| Sandbox memory limit | `prlimit --data` (V8 cannot start under an address-space limit) | `src/runner/sandbox.ts` |
| Scheduling | Round-robin across authorizations (least recently dispatched first), request order within one; discovery agents (planner, comprehension, synthesis) held at review capacity | `src/scheduler/scheduler.ts` |
| Lead-generator heuristics | Standards detected by selector sets (ERC-20, ERC-4626, ERC-1967); sweep rules for value-sending calls with storage writes, delegatecall, unmodified admin-named writers and inline assembly | `src/leads/generators.ts` |
| Held-out comparison | A side fails a case when at least half its runs fail (a tie is a failure); tuning cases are refused; a lead-class drop is reported, never a gate (Q-024) | `src/evaluation/heldout.ts` |
| Canary labels | Kept in the library store so no engagement view or screen can reveal them | `src/evaluation/canary.ts` |
| Control checks | Recorded as auditor-run results with workstation provenance, not as trusted receipts | `src/evaluation/controls.ts` |
| Snapshot revisions that change nothing material | A build revision that keeps the same frozen tree, source, deployment and fork identity does not make decisions stale | `staleMembers`, `src/decision/framework.ts` |

## Rules added after the second adversarial review

A second independent review covered the agent, broker, scheduler, lead-generation, evaluation and property-campaign code. Its findings are fixed and pinned by `test/review2-regressions.test.ts` and the runner tests.

| Rule | Default | Code |
|---|---|---|
| Guard removal and reviewed faults | Edit only a target source file: present in the snapshot, untouched by the job's fixture, outside the test and script directories. A positive control's edit only removes code (the replacement is a subsequence of the original, blank, or a comment) | `isTargetSourceEdit`, `src/decision/packets.ts`; `src/runner/jobs.ts` |
| What a fixture alters | Any overridden target file, any build-configuration file, and any added file outside the test and script directories; a replay with such a fixture is not clean | `fixtureOverrides`, `src/decision/fixtures.ts` |
| Builds with fixtures | Never rewrite a snapshot's inventory or layouts; build, inventory and baseline-test jobs carry no fixture or source edit | `src/snapshot/register.ts`, `src/runner/jobs.ts` |
| Broker content | Only text, tool-use and tool-result blocks; URL-sourced or other content is refused before anything is sent | `src/runner/provider.ts`, `src/runner/brokerSocket.ts` |
| Broker reservations | A true ceiling (input bytes counted as tokens plus the output maximum at the highest rate); an overrun exhausts the authorization and is reported | `src/runner/anthropic.ts`, `src/runner/provider.ts` |
| Data class of agent context | Live-exploitable whenever the context includes an open investigation, a variant, a discrepancy, evidence, a property, a finding, a packet, a decision or a position | `deriveDataClasses`, `src/runner/provider.ts` |
| Positions | A worker's model and provider come from its attempt's recorded provider calls; whether its initial context withheld the author's material comes from its controller-built manifest. A position written before later experiment evidence or a new variant is stale | `submit_position`, `resolvePosition`, `src/decision/packets.ts` |
| Adequacy | Bound to the latest campaign on the active snapshot, which must have run, held and not had every action revert; the cited fault run must descend from that campaign; a change of the property's meaning resets adequacy | `requireAdequacyEvidence`, `src/decision/proposals.ts` |
| Refused dispositions | A disposition refused for its evidence requirement is recorded as a `decision_refused` event (no decision), so refused High/Critical rejections count in the positive-control metric | `src/decision/framework.ts` |
| Method adoption | Needs the controller's held-out comparison artifact, run against a frozen contract over every held-out case it labels | `src/method/methods.ts`, `src/evaluation/heldout.ts` |
| Canaries | Registered only before the packet is decided; excluded from output metrics | `src/evaluation/canary.ts`, `src/evaluation/metrics.ts` |
| Control checks | Gate or measurement comes from the controller's table; a partial run never clears adoption | `src/evaluation/controls.ts` |
| Lead coverage | Bound to the snapshot it ran on; a later run overwrites it; `prepare_work` reports coverage from an earlier snapshot as a gap | `src/leads/generators.ts`, `src/decision/work.ts` |
| Freezing an evaluation contract | A human decision (`freeze_evaluation_contract`) with rationale and a single-use display receipt | `src/evaluation/contract.ts` |
