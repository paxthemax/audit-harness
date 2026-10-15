# Audit harness framework

An implementation of the human-led EVM audit harness specified in the design lab at `../framework-design-lab/` ([proposal](../framework-design-lab/design/audit-harness.md)). One human auditor directs agents toward precise security questions, checks their evidence and decides what becomes a finding. The harness is an **evidence workbench**: it records why each lead was accepted or rejected, refuses decisions that rest on stale or unseen evidence, and works out which conclusions a code or premise change reopens.

This repository builds the **walking skeleton** the operator selected as the first version (DEC-008, Q-020): one local controller process that runs jobs one at a time as child processes it owns, append-only Git-backed records validated against schemas, and hash-pinned evidence with receipts from a trusted runner. It keeps the three invariants of that build: agents cannot write canonical records, approvals bind exact revisions, and receipts come from the trusted runner.

## Status

All five steps of the [delivery sequence](../framework-design-lab/design/audit-harness.md#delivery-sequence) have an implementation or, for the operator's own activities, their tooling:

- **Step 1, the walking skeleton:** controller and channels, Git-backed records and evidence, intake and snapshots with a deterministic inventory, sandboxed Foundry builds and tests, manual investigations, batch authorization, the trusted decision screen with display receipts and captured input, impact-scaled dispositions, replay and positive controls, dependency probes and freshness after changes.
- **Step 2:** reference role agents that run in the sandbox and reach a model only through the broker; scheduling across several batches; clarification routing; reports with a controller-computed required set; decision-load accounting; the mechanism library; runnable conformance and control checks.
- **Step 3:** property campaigns with adequacy from a reviewed fault, and an integration scenario through acceptance on a clean replay, a fix assessment and export.
- **Steps 4 and 5:** an evaluation contract, the evaluation plan's metrics table, canary packets and held-out comparisons for method changes; deferred mechanisms stay deferred until their triggers occur.

Operator decisions still open: the model provider (an Anthropic adapter exists but no engagement approves it), the agent host (a reference host exists; an external agent tool must pass the conformance checks), the sandbox (bubblewrap is the working default) and every numeric limit. The pilot comparison against the auditor's ordinary workflow needs a human auditor and targets set before the run. [docs/operator-choices.md](docs/operator-choices.md) lists every default and open choice; [docs/architecture.md](docs/architecture.md) maps requirements and scenarios to code and tests.

## Requirements

- Linux with [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) for the execution sandbox
- Node 25 (pinned in `mise.toml`) and Git
- Foundry (`forge`) with the needed Solidity compilers already in the local `svm` cache; the sandbox has no network

```bash
mise install
npm install          # dev dependencies only: TypeScript and Node types
npm test             # node:test suites
npm run typecheck
```

## Using it

```bash
export HARNESS_WORKSPACE=./workspace
bin/harness init
bin/harness engagement create vault-audit --name "Vault audit" --owner auditor --purpose "pre-launch review"
bin/harness snapshot register ./target -e vault-audit
bin/harness status -e vault-audit                                               # decisions needed, work and spending, gaps
```

Decisions are presented and recorded through an agent (operator decision, 2026-10-14). Start omp or Claude Code in this repository: both read `.mcp.json`, which runs the harness MCP server (`bin/harness mcp`, workspace from `HARNESS_WORKSPACE`). Ask the agent what needs deciding; it presents each item, discusses it with you and records your decision, labelled as made through an agent session. [docs/agent-review.md](docs/agent-review.md) describes the tools, the decision inputs and the provenance labels.

The interactive trusted screen remains available beside the agent path:

```bash
bin/harness screen accept_scope_and_policy -e vault-audit --draft policy.json   # trusted decision screen (needs a terminal)
```

When no auditor is available, for example overnight, an operator can let the harness run itself: `harness yolo run -e vault-audit --charter yolo.json` runs repeated discovery -> test -> report cycles in which role agents seed knowledge, plan and test investigations and the governor admits their batches through the unattended approver, within the charter's limits. It records no disposition: its candidate findings are review packets that wait for the auditor, and `harness yolo report` (or the MCP tool `harness_yolo_report`) lists them. It needs the operator's opt-in (`harness unattended enable --kinds authorize_work[,record_flow_review]`); see [docs/cli.md](docs/cli.md#7-yolo-runs-unattended-discovery-test-and-report-operator-opt-in).

[docs/agent-host-trial.md](docs/agent-host-trial.md) records the compatibility trial of Claude Code as a candidate agent host. [docs/cli.md](docs/cli.md) walks through the auditor's workflow, stage by stage. [docs/contracts.md](docs/contracts.md) publishes the contract-version-1 serialization, hashing and store layout. [docs/architecture.md](docs/architecture.md) maps the specification's components and requirements to modules and tests.

## Layout

| Path | Specification component |
|---|---|
| `src/controller/` | Controller: channels, operation dispatch, idempotency, revision checks, atomic commits |
| `src/store/` | Engagement store and evidence archive (Git-backed, content-addressed) |
| `src/schema/` | Record contracts as JSON Schemas |
| `src/decision/` | Proposals, captured input, clarifications, work authorization, review packets, human decision kinds |
| `src/runner/` | Tool broker, trusted runner and receipt collector, sandbox, adapters, provider broker |
| `src/snapshot/`, `src/intake/` | Target snapshots, inventory, snapshot diffs, dependency probes and freshness (change evaluator); intake scanning |
| `src/report/`, `src/library/`, `src/context/` | Report and export, import, closure; mechanism library and lessons; context builder |
| `src/screen/`, `src/capture/`, `src/cli/` | Trusted decision screen, capture channel, command line |
| `src/review/`, `src/mcp/` | Agent-mediated decisions: the agent review session and the MCP server (`harness mcp`) |
| `src/yolo/` | The yolo governor: unattended discovery -> test -> report runs under an operator charter (operator request 2026-10-14) |
| `src/agents/` | Reference role agents (in-sandbox runtime, tools and prompts per role) |
| `src/scheduler/`, `src/leads/`, `src/evaluation/`, `src/comprehension/`, `src/method/`, `src/metrics/` | Batch scheduling, lead generators, evaluation and control checks, comprehension records, method versions, metrics |

Project memory for developing this repository is the PLUR store in `memory/plur/`. It never holds client audit data or engagement state.
