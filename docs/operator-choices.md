# Open operator choices and implementation defaults

The accepted baseline leaves the store, runner, model provider, sandbox, agent host and numeric limits to the operator ([glossary, "Accepted baseline"](../../framework-design-lab/design/harness-glossary.md#terms)). This implementation needed a working default for each so the walking skeleton runs end to end. None of these defaults is an operator decision. Each is isolated behind a small seam so it can be replaced.

## Operator decisions

| Date | Choice | Decision |
|---|---|---|
| 2026-10-13 | Sandbox | **bubblewrap (`bwrap`)**, the working default, selected by the operator. It passed the default-deny egress and conformance checks on the development workstation. Replacing it later needs the same conformance checks |
| 2026-10-13 | Model provider | **omp's credential gateway** (`omp auth-gateway stdio` from oh-my-pi, version pinned) as the provider broker's upstream. It serves the operator's Claude Team seat as `omp-anthropic` and ChatGPT plan as `omp-openai-codex` from a dedicated omp profile; there are no API keys. The operator accepts that Anthropic's terms do not permit third-party apps to hold Claude logins. On 2026-10-13, Claude calls through omp counted against the Team plan's limits, not extra usage. No fallback in this round. Each engagement still approves each provider separately, and for the live-exploitable class with `--live-providers`. See [Defaults for the omp gateway provider](#defaults-for-the-omp-gateway-provider) and the [live trial](omp-gateway-trial.md) |
| 2026-10-14 | Unattended approval | **Operator-requested deviation from the human-decision invariant** (DEC-007, DEC-008: agents do not decide; every decision comes from the trusted screen). An operator may delegate two operational kinds, `accept_scope_and_policy` and `authorize_work`, per engagement with `harness unattended enable`; it is off by default. The unattended approver applies a draft as written and refuses an incomplete one (no limit or charter answer is defaulted). Its decisions carry the principal `unattended-approver` and the authorship `agent_unattended`, the adopted trusted-role premise is stored `provisional` and marked, and `harness status` lists them. The controller enforces the pairing and the delegation (`commitDecision`); audit judgments (dispositions, interpretations, premise revisions, exports) are never delegated to the unattended approver, and flow reviews are delegable only as the next row describes. That these judgments stay the auditor's sole, human choice was superseded by the "Agent-mediated decisions" row below: they may now be recorded through an agent session, labelled as such. Reports do not yet label these decisions beyond the records themselves. Code: `src/screen/unattended.ts`, `Controller.unattendedApprover`, `unattended_approval` in `harness.json` |
| 2026-10-14 | Unattended flow reviews | **A second deviation, requested for the Mento V3 shadow audit:** `record_flow_review` may also be delegated, but only when named in `--kinds` (`unattended enable` without `--kinds` still delegates only the two kinds above). It exists to lift the batch gate (FR-32) when no human walks the flow. An unattended flow review renders only the unit, so no IMPLEMENTED statement counts as presented and later intent timing is unaffected. It marks no function reviewed, and the controller refuses function review flags from the approver, so every function-coverage gap stays open. It adds a unit gap saying no human reviewed the flow, which `harness status` lists. The report's coverage table labels the unit `reviewed (UNATTENDED: no human review)`, and the required set keeps the unit incomplete, so the engagement cannot close as `closed` until a flow review not made by the unattended approver replaces it (that review also clears the gap). Since the "Agent-mediated decisions" row below, that review may be on the trusted screen or through an agent session; it no longer has to be a human's sole choice. The unit counts as `reviewed` for the batch gate, linked-claim flags and coverage metrics. Code: `recordFlowReviewUnattended`, `src/screen/unattended.ts`; `record_flow_review`, `src/decision/kinds.ts`; `src/report/requiredSet.ts` |
| 2026-10-14 | Agent-mediated decisions | **Decisions are presented and recorded through an agent.** An MCP-capable agent host (omp, Claude Code or another) presents pending decisions to the auditor, discusses them, recommends and records the decision; the interactive terminal screen is no longer the day-to-day decision path. The requirement that a decision is the auditor's **sole** choice is lifted: the harness builds **no** defence that binds or proves the human's participation on this path (no confirmation codes, no capture binding, no terminal checks). Provenance is **labelled**: decisions carry the principal `agent-session` and a display receipt naming the agent client (`harness-agent-session <program digest> <client>/<version>`), the rationale authorship the agent reports (`human_written`, `agent_drafted_unedited`, `agent_drafted_edited`; `agent_unattended` stays the unattended approver's), relayed captured input uses the capture channel `agent-session-relay`, and `harness status` lists decisions recorded through an agent session. MCP is the agent interface (`harness mcp`, declared in `.mcp.json`). The controller's decision rules are unchanged (display receipts, evidence-first order, staleness, evidence requirements, budgets). The existing CLI, the interactive trusted screen (`harness screen …`) and the unattended approver stay as they are. See [agent-review.md](agent-review.md). Code: `src/review/`, `src/mcp/`, `Controller.agentSession` |
| 2026-10-14 | Yolo loop | **Operator request: an agentic, unattended discovery -> test -> report loop** ("yolo mode") for overnight runs while no auditor is available. The operator left its architecture to the implementation; the choice is a **deterministic governor** (`harness yolo run`, harness code in the controller process), not a model in charge, so that sequencing, stop conditions and authority stay bounded and testable, with role agents doing the discovery and testing in the sandbox through the broker. It relaxes loop L5's "Agent discovery cannot self-approve the next batch" (workflow loops, DEC-007): the governor admits the planner agent's batch through the unattended approver, within the operator's charter, and with `flow_reviews: "unattended"` records unattended flow reviews. It runs only when the operator delegated `authorize_work` (and `record_flow_review`) with `harness unattended enable`. Unchanged: agents propose through the worker channel; dispositions, clarification answers, interpretations, premise revisions, exports and closure stay with the auditor (screen or agent session), so a candidate finding is a review packet awaiting a disposition; budgets, review capacity (FR-19), evidence requirements and the run's validity window bound the run. Provenance: a `yolo_run` record with a controller-rendered report; the governor's requests carry the principal `yolo-governor` (controller channel, `GOVERNOR_OPERATIONS` only); its decisions carry `unattended-approver`. See [cli.md](cli.md#7-yolo-runs-unattended-discovery-test-and-report-operator-opt-in). Code: `src/yolo/`, `Controller.governor` |

## Choices the specification leaves open

| Choice | Default in this implementation | Where it lives | What replacing it involves |
|---|---|---|---|
| Store | Append-only Git repositories, one per engagement plus one for the mechanism library, validated against JSON Schemas. This is the walking skeleton the spec prescribes (DEC-008, Q-020) | `src/store/` | A transactional store (for example SQLite) is a [deferred mechanism](../../framework-design-lab/design/harness-state-and-execution.md#deferred-mechanisms). It needs journal-consistent backup and the recovery scenarios before adoption |
| Runner | The controller process runs one job at a time as a child process group it owns | `src/runner/` | Parallel or remote workers bring leases, heartbeats and fencing (deferred mechanisms) |
| Sandbox | **Decided 2026-10-13: bubblewrap.** Network, PID, IPC and UTS namespaces unshared, read-only system and toolchain binds, read-only target snapshot, per-attempt writable scratch, scrubbed environment. Execution is refused when `bwrap` is missing | `src/runner/sandbox.ts` | Any replacement must first demonstrate default-deny egress ([conformance](../../framework-design-lab/design/harness-interface-contracts.md#compatibility-and-conformance)) |
| Model provider | **Decided 2026-10-13: omp's credential gateway** (`omp_gateway` providers in `harness.json`). The provider broker enforces engagement approval, data classes, reservations and `outcome_unknown` accounting for it as for any provider. The Anthropic API adapter remains available; a `FakeProvider` exists for tests only | `src/runner/ompGateway.ts`, `src/runner/provider.ts` | Register another provider adapter in the workspace configuration and approve it per engagement in `accept_scope_and_policy` |
| Agent host | Not selected. A reference host (`reference_agent`) passes every conformance check. Claude Code was trialled as a candidate (`claude_code` adapter) and passes all five agent-tool conditions in terminal-wrapper mode: see [agent-host-trial.md](agent-host-trial.md) for the evidence and the caveats an operator must weigh. The capture channel works as a terminal wrapper (`harness capture`) and as a Claude Code `UserPromptSubmit` hook adapter (`harness capture-hook`) | `src/agents/`, `src/capture/`, `src/runner/` | Choose a host; for Claude Code, weigh the trial's caveats (headless or terminal-wrapper use only, synthesized streaming, dropped beta headers untested against a real provider) |
| Numeric limits | No limit is hard-coded. Every work authorization carries finite spend, runtime, concurrency, child-task, round, retry, repair, output, memory and process limits; review, clarification and decision capacities are set in `accept_scope_and_policy` | `src/decision/work.ts`, `src/schema/records.ts` | The spec's proposed starting values (three investigations per batch, two concurrent agent workers, one heavy experiment, zero child tasks, two repairs per variant) are pilot settings for the operator to set |
| Toolchain | Foundry (`forge`) resolved from `PATH` or `harness.json`; Solidity compilers from the local `svm` cache, bound read-only into the sandbox. Installing compilers is a separate preparation step outside the sandbox. Builds run with `FOUNDRY_LINT_LINT_ON_BUILD=false` (2026-10-14): forge 1.7.0's linter failed mento-core on an import the compiler resolves, and lint is not audit evidence | `src/runner/adapters.ts` | Pin tool images and register further adapters (Slither, Echidna, Medusa, Halmos) under the operator's integration policy |

## Defaults for the omp gateway provider

The broker starts one `omp auth-gateway stdio` child per omp binary and profile and talks to it in JSON lines. The gateway holds the logins; the broker reads and holds no credential for these providers. Agents still reach it only through the per-attempt broker socket. Set it up once:

```sh
OMP_PROFILE=harness omp login anthropic        # the Claude Team seat
OMP_PROFILE=harness omp login openai-codex     # the ChatGPT plan
```

| Rule | Default | Code |
|---|---|---|
| omp version | Pinned (18.10.1 at the decision). A gateway reporting another version is refused until the operator reviews the new version and updates `harness.json` | `OmpGateway`, `src/runner/ompGateway.ts` |
| Logins | A dedicated omp profile (`harness`, through `OMP_PROFILE`) holding only the two logins, not the operator's other omp logins | `harness.json`, `src/runner/ompGateway.ts` |
| Gateway process | Runs outside every sandbox in an empty temporary working directory; its environment is `HOME`, `PATH`, `LANG`, `OMP_PROFILE` and `NO_COLOR` only. It is kept alive only while a request is in flight and restarts after an exit | `src/runner/ompGateway.ts` |
| Providers and models | One broker provider per upstream (`omp-anthropic`, `omp-openai-codex`) so an engagement approves each separately; model ids are `<upstream>/<model>`, and agent jobs accept one `/` in a model id | `OmpGatewayProvider`; `validateAgentArgs`, `src/runner/adapters.ts` |
| Spend | Notional: the API-list equivalent at proposed rates, so reservations, budgets and reports keep working. Claude rates are the list prices of 2026-10-06; GPT-5.6 rates come from third-party listings that disagree, and the higher figure is used. A model without a rate is refused | `PROPOSED_OMP_NOTIONAL_RATES` |
| Plan headroom | No new call while any of the upstream's plan windows is 80% used or more, or the plan reports its limit reached; the reading is at most 60 s old. This leaves room for the operator's own use of the same plan | `PROPOSED_OMP_HEADROOM`, `PROPOSED_OMP_USAGE_TTL_MS` |
| Plan record | Each response artifact carries the plan windows read before the call (labels, used fractions, reset times, plan type; no account identifiers) | `src/runner/provider.ts` |
| Outcomes | A version mismatch, a missing login, a closed plan, a window past the headroom or a 4xx reply is refused before sending (the reservation is released). A 5xx reply (an upstream failure the gateway relays) or a gateway exit after the request was written is `outcome_unknown` (the reservation is held) | `src/runner/ompGateway.ts` |
| Beta headers | Not forwarded; omp sets its own. The broker still records them with the request | `src/runner/ompGateway.ts` |

### Known limitations of the omp gateway

- omp is a third-party binary on the host that holds both logins. The version pin bounds what runs, not what that version does.
- omp adds a short text of its own to Claude requests (a no-tool probe of 2026-10-13 billed 41 input tokens for a message of about 12). The broker's request record does not contain that addition.
- The model identity the broker records is the gateway's (`anthropic/claude-haiku-5-5`), not the provider's dated model id.
- Billing treatment can change without notice. The plan record lets an operator see whether harness calls still move the plan windows.

## Implementation-level defaults worth reviewing

These are smaller rules the specification does not fix. They are stated here so the operator can change them deliberately.

| Rule | Default | Code |
|---|---|---|
| When a challenge is required in a packet | Unless potential impact is `low`/`info` or the proposed disposition is `triaged_out` | `challengeRequired` in `src/decision/packets.ts` |
| What counts as a material change for a decision | Any newer revision of a reviewed record or of one of its direct `depends_on` inputs; new or changed inbound links for packets | `commitDecision` in `src/decision/framework.ts` |
| What counts as a revision conflict for a proposal | A proposal based on an older revision conflicts (retained, `revision_conflict`) unless every later revision of that investigation or scenario variant only recorded job dispatch (a job link appended; for an investigation, the work moved to `running`); then it applies to the current revision. Agent contexts are built before `request_job` links the round's own job, and an agent may request an experiment for a variant before recording its outcome in the same round | `onlyDispatchSince` in `src/decision/proposals.ts` |
| Inbound links of an investigation | Evidence from its jobs or positive controls, discrepancies naming it, clarifications blocking it, statements citing it, its variants, freshness records and probes | `inboundLinks` in `src/decision/packets.ts` |
| What an agent context about an investigation carries | The investigation, its units, variants, supporting and refuting records, properties, the statements on its path and the trusted runner's evidence from its experiment, replay and control jobs (the agent rounds' own receipts are left out), bounded by the context's record limit | `buildContext` in `src/context/builder.ts` |
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
| Wait before re-running the queue while another process runs a job in the workspace (yolo run) | 30 s | `PROPOSED_RUNNER_BUSY_WAIT_MS`, `src/yolo/governor.ts` |
| Records a yolo governor task lists by name (unmapped functions: twice that) | 40 | `TASK_LIST_CAP`, `src/yolo/governor.ts` |

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

Since 2026-10-14 the agent session of `harness mcp` does this on purpose: it runs as the auditor's user inside the agent host, reads the key and opens screen-channel sessions with the principal `agent-session`. The operator accepted this ("Agent-mediated decisions" above); its decisions are labelled, not separated. The separate process or socket above matters only if the operator later wants decisions the agent tool provably cannot make.

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

## Defaults of the audit repository tool

Packaging defaults of `bin/audit` ([audit-repo.md](audit-repo.md)); none changes a harness mechanism:

| Rule | Default | Code |
|---|---|---|
| Framework | Pinned as the `harness/` submodule at this checkout's HEAD, from its `origin` remote; `--link-framework` links a working tree instead and `status` warns that it is not reproducible | `cmdNew`, `src/auditrepo/main.ts` |
| Target mode | `submodule` at `targets/<name>`; `clone` and `path` on request. Without `--ref`, the remote's default branch is pinned | `cmdTarget` |
| Moving checkouts | `setup` moves submodule and clone targets to their pins unless they have tracked local changes; it never clones or moves a path target | `ensureTarget` |
| Snapshots | `setup` registers only an engagement's first snapshot; later ones only on `snapshot`. A root that is off its pin, has uncommitted changes or nested submodules off their pins is refused unless `--allow-dirty` | `cmdSetup`, `register` |
| Agent guard rails | `.claude/settings.json` denies edits to `targets/`, `harness/`, `workspace/` and reads of `workspace/secrets/`; the capture hook is printed for user settings, not installed in the repository | `template/` |
| Capture hook scope | Records only sessions whose `CLAUDE_PROJECT_DIR` is the audit repository or below it; every other session records nothing | `hookCommand` |

## Defaults of the yolo governor

Rules the governor applies that the operator's request did not fix ([cli.md](cli.md#7-yolo-runs-unattended-discovery-test-and-report-operator-opt-in)):

| Rule | Default | Code |
|---|---|---|
| Charter | Every member required, unknown members refused; refused when its round limits cannot cover its own plan or a round's runtime exceeds an authorization's | `parseCharter`, `src/yolo/charter.ts` |
| Authorizations | One intake authorization per run and one batch authorization per cycle, with the charter's limits and capabilities, valid until the run's end | `src/yolo/governor.ts` |
| Batch selection | The planner's batch when all of it can be admitted; otherwise the questions the planner round proposed, then the other admissible proposed questions: those an agent or the auditor proposed before the lead generators' heuristic leads, then by potential impact, then multi-step or cross-flow, then age, up to the charter's batch size | `select`, `admissible` |
| Pipeline per investigation | Investigator rounds; a clean replay of the latest main-claim experiment whose trusted-runner evidence is a counterexample; a challenger round when a challenge is required; a packet round. Both positions are written after the replay, so neither is stale | `nextStep` |
| Failed rounds | Not retried (an `outcome_unknown` call may have run); `max_consecutive_failures` in a row end the run | `round` |
| Clarification blocks | An investigation blocked by a clarification waits for the auditor's answer | `investigate` |
| Agent context sources | Snapshot Solidity files under a policy `scope` entry (a path prefix) and outside every exclusion; a policy path that matches no snapshot file is read relative to the snapshot root by dropping its leading part that repeats the end of the snapshot's `origin_path`; every non-excluded Solidity file when no scope entry matches a path. Then the Solidity files under the charter's `agents.reference_paths` (reference material such as test deployment helpers, not audit scope) | `sources`, `resolvePolicyPath` |
| Agent output per turn and call timeout | The charter's `agents.max_tokens` (required, at most the broker's 128,000; an investigator writes a fixture in one tool call) and `agents.call_timeout_seconds` (required, at most `round_runtime_seconds`), which the run's provider broker applies to every call instead of the proposed 120 s | `round`, `preflight`, `parseCharter` |
| Experiments of the reference investigator | Tests selected with forge's `match_path`, `match_contract`, `match_test`, with an expectation declared per selected test, so attack tests and controls share one experiment | `request_experiment`, `src/agents/tools.ts` |
| Compile failures | A forge_test result whose build failed (compiler errors, or forge refusing incompatible pinned compiler versions) carries the diagnostics from the first error, up to 4,000 characters, so the next round can repair the fixture | `PROPOSED_COMPILER_OUTPUT_CHARS`, `BUILD_FAILURE`, `src/runner/adapters.ts` |
| Operator guidance | The charter's `discovery.focus` lines are appended to comprehension and planner tasks and its `agents.notes` lines to every agent task (both required, either may be empty); each job records the task it ran with | `guided`, `src/yolo/governor.ts` |
| Live-exploitable approval | Each role's provider must be in the charter's `live_providers`: comprehension contexts carry audit units, the others investigations | `preflight` |
| Candidate finding | A packet that proposes `accepted`, or whose support includes a variant with outcome `supports` or a trusted-runner counterexample | `runPackets`, `src/yolo/report.ts` |
| Concurrency and recovery | One governor per engagement, identified by process id and start time; the next run marks a dead one `interrupted` and continues the investigations it admitted while their authorization is valid. Runs on two engagements of one workspace share its one-job-at-a-time runner: a governor waiting for the runner retries every 30 s, so the run holding it keeps it and concurrent runs effectively take turns by run; start them one after the other | `start_yolo_run`, `src/yolo/ops.ts`; `test`; `runUntilDone` |
| Agent record references | A bare record id or `id@revision` an agent passes to a tool becomes an exact reference at the revision its context holds (or the one given); naming a record outside its context is refused to the agent at once | `resolveHandle`, `src/agents/tools.ts` |
| Queued leftovers | Jobs the run queued but never started are cancelled when it ends | `finish` |

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
