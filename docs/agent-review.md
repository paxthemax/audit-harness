# Agent-mediated decisions (`harness mcp`)

An agent (omp, Claude Code or any MCP-capable host) presents pending decisions to the auditor, discusses them, and
records them. The auditor talks to the agent; the agent shows each item, answers questions, recommends, and records
the decision the auditor states. This is the decision path for day-to-day review. The interactive trusted screen
(`harness screen …`, [cli.md](cli.md)) and the unattended approver remain available and unchanged.

## Why

Operator decision of 2026-10-14 ([operator-choices.md](operator-choices.md#operator-decisions), "Agent-mediated
decisions"):

1. Pending decisions are presented and recorded **through an agent** instead of the interactive terminal screen.
2. The requirement that a decision is the auditor's **sole** choice is lifted. The harness builds **no** defence that
   binds or proves the human's participation on this path: no confirmation codes, no capture binding, no terminal
   check. Provenance is still **labelled**, so records and `harness status` say that a decision came through an agent
   session.
3. The CLI may become agent-focused. The agent interface is an MCP server, `harness mcp`.

The labels say how a decision was recorded; they do not prove that the auditor took part or read what the agent
presented. Read an agent-session decision as "recorded by an agent on the auditor's key", with the rationale
authorship the agent reported.

## Setup

The workspace must exist (`harness init`): the server reads `secrets/auditor.key` (and `secrets/capture.key` for
relayed input) like the CLI.

`harness mcp` speaks MCP (newline-delimited JSON-RPC 2.0) on stdin and stdout and writes nothing else there;
diagnostics go to stderr. It takes the workspace from `--workspace DIR` or `HARNESS_WORKSPACE` (default
`./workspace`) and opens it on the first tool call, so a missing workspace comes back as a tool error, not a failed
start. Each tool call names its engagement; library-scope kinds use the engagement `library`.

The repository's `.mcp.json` declares the server as `harness`, run through mise so the pinned Node is used:

```json
{
  "mcpServers": {
    "harness": {
      "command": "mise",
      "args": ["exec", "--", "bin/harness", "mcp"],
      "env": { "HARNESS_WORKSPACE": "${HARNESS_WORKSPACE:-./workspace}" }
    }
  }
}
```

- **omp** and **Claude Code** both read the project's `.mcp.json`. Start the host in the repository root (Claude Code
  asks once to approve a project-scoped server). The tools appear under the `harness` server; Claude Code names them
  `mcp__harness__<tool>`.
- **Another workspace:** export `HARNESS_WORKSPACE=/path/to/workspace` before starting the host. The entry passes it
  through and falls back to `./workspace` (relative to the directory the server starts in) when it is unset.
- **Any other MCP host:** register a stdio server with the same command and environment.

Protocol behaviour:

- `initialize` negotiates `2025-06-18`, `2025-03-26` or `2024-11-05` (an unsupported request gets `2025-06-18`),
  offers only tools (`listChanged: false`), names the server `audit-harness`, and sends instructions describing the
  review loop below. The client name and version from `initialize` go into every display receipt.
- Any request other than `initialize` and `ping` before `initialize` is refused with JSON-RPC `-32600`. Unknown
  methods get `-32601`; an unknown tool or malformed `tools/call` params (no tool name, arguments not an object) get
  `-32602`; unparsable lines get `-32700`.
- Wrong tool arguments (missing, unknown, wrong type, not in an enum) come back as a tool result with `isError: true`
  and the code `invalid_request`. Every harness refusal does the same: the result text names the code, the reason,
  the next action and any details, and `structuredContent.error` carries them as JSON.
- Tool calls run one at a time, in arrival order.

## The review loop

1. **Overview.** `harness_overview` without an engagement lists engagements with their closure status, active
   snapshot and the number of decisions needed. With an engagement it returns the home view `harness status`
   prints, from the same computation: each pending decision (`id`, `decision_kind`, `title`, `potential_impact`,
   `lines`), current work and spending, and the gap count with the first 20 gaps. A decision's `lines` name the
   records a generic decision binds ("Present and bind: …") and the interactive screen command. `id` is empty when
   there is nothing to present yet (an investigation without a packet), and `decision_kind` is `none` for a proposal
   conflict, which is no decision.
2. **Present.** `harness_present` returns an item's canonical text with deceptive characters rendered visibly (the
   screen's renderers), a `template` of the `decision` object `harness_decide` expects, and for packets the sections
   `presented` so far and still `remaining`. Every presentation is added to that item's display receipt.
   IMPLEMENTED content shown is receipted when presented, as the CLI does. Give item ids without a revision; an
   `id@revision` is presented as a plain record. The agent should show the auditor the text as returned; the
   harness cannot check that it did.
3. **Discuss.** The agent answers the auditor's questions, with `harness_records` for the records an item cites, and
   may recommend. Records that present IMPLEMENTED behavior are receipted before they are returned, or withheld while
   read-first mode is active, as `harness records` does.
4. **Decide.** The agent fills the template with the auditor's choices and calls `harness_decide` with the rationale
   and its authorship. The session submits the item's display receipt (`record_display`) and then the decision
   through the operation the screen uses. A refusal comes back as a tool error naming the code, the reason and the
   next action.
5. **Request more work.** Instead of a disposition, `harness_request_check` names a missing distinguishing check for
   a packet's investigation; it runs only within a current authorization. New proposals go through `harness_call`
   (for example `submit_proposal`), and `harness_run_jobs` runs queued jobs on the trusted runner.

When a decision needs captured input (a clarification answer, the expectations pre-step, a note), the agent relays
the auditor's words with `harness_capture` first and binds the returned captured input in the decision.

After an unattended yolo run ([cli.md](cli.md#7-yolo-runs-unattended-discovery-test-and-report-operator-opt-in)),
`harness_overview` shows the run and its packets among the pending decisions, and `harness_yolo_report` returns the
run report. Its candidate findings are packets agents drafted and the governor admitted without a human: present and
decide each one as above.

### Items, revisions and re-review

An item (packet, audit unit, work proposal, engagement) keeps its display receipt for the life of the server
process. `harness_decide` refuses an item that was not presented in this session (`display_required`), and one whose
record changed since it was presented (`stale_dependency`). After a `stale_dependency`, `display_required` or
`revision_conflict` refusal the item starts over: present it again (a new receipt over the current revisions) and
decide again. A recorded decision ends the item.

## Tools

| Tool | Arguments | Does |
|---|---|---|
| `harness_overview` | `engagement?` | Without `engagement`: the engagement list. With it: pending decisions, work, gaps |
| `harness_present` | `engagement`, `id`, `section?` | Presents an item (`pkt-…`, `unit-…`, `wprop-…`, `eng-…`) or any other record; `section` presents one packet section |
| `harness_decide` | `engagement`, `id?`, `kind?`, `records?`, `operation?`, `decision`, `rationale`, `rationale_authorship`, `agent_draft?` | Records the decision for item `id`, or a generic decision of `kind` over `records` |
| `harness_request_check` | `engagement`, `id`, `check` | Requests a named distinguishing check (`request_check`) for a packet's investigation (`id`: the packet or the investigation); records no disposition |
| `harness_records` | `engagement`, `type?`, `ids?`, `history?`, `limit?` | Reads records on the auditor channel (with receipting and read-first withholding); returns `records` and `withheld` |
| `harness_call` | `engagement?`, `operation`, `payload` | Any operation open to the auditor channel; decision operations are refused (`permission_denied`). Without `engagement` it runs in the library scope |
| `harness_run_jobs` | `engagement`, `max?` | Runs queued jobs on the trusted runner, as `harness job run`, with the workspace's providers; no provider may receive live-exploitable material |
| `harness_capture` | `engagement`, `text`, `purpose?`, `unit?` | Records the auditor's words as relayed by the agent; returns the `captured_input` reference |
| `harness_yolo_report` | `engagement`, `run?` | The report of an unattended yolo run (the latest, or `run`); nothing in it was reviewed by a human |

`harness_decide` arguments:

- `decision`: the kind-specific inputs below (start from the `template` that `harness_present` returned).
- `rationale`: the decision's rationale text.
- `rationale_authorship`: `human_written` (the auditor dictated it), `agent_drafted_unedited` (the auditor accepted
  the agent's text as is) or `agent_drafted_edited` (the auditor changed the agent's text).
- `agent_draft`: the agent's draft for the two `agent_drafted_*` values. The controller requires it, checks that an
  unedited rationale equals it, and records the edit diff of an edited one.
- `kind`, `records` (`id` or `id@rev`), `operation`: generic decisions only (see below).

`harness_capture` purposes are `conversation` (default), `expectations_pre_step` (needs `unit`),
`clarification_answer` and `note`. The captured input counts as presented in this session, so a generic decision can
bind it.

## The `decision` object per item

Every item refuses keys it does not take and names the ones missing.

### Review packets (`pkt-…`): `dispose_investigation`

`harness_present` without `section` presents every currently available section in canonical order: `claim`,
`evidence`, `challenger`, `evidence_quality`, `unreviewed_statements`, `proposed_disposition`. For potential High or
Critical (`unknown` counts as high; the highest of the packet and its linked claims applies) the proposed
disposition stays locked until `evidence`, `challenger` and `evidence_quality` have been presented; asking for a
locked section is refused (`display_required`) with the lock reason. `harness_decide` is refused until `claim`,
`evidence`, `challenger`, `evidence_quality` and `unreviewed_statements` have been presented in this session. When
`agent_draft` is omitted, the packet's agent-drafted rationale is used only if `proposed_disposition` was presented,
as on the screen.

The packet template is keyed by disposition: one complete skeleton per disposition (`accepted`, `rejected`,
`no_finding_within_bounds`, `triaged_out`, `disputed`, `deferred`). Pick the entry the auditor chose and fill it in.
Each holds the main claim's disposition fields at the top level, `linked_claims` with one entry per linked claim (its
`id` plus its own disposition fields, decided separately; every linked claim needs one), and `accepted_unreviewed`:
the ids (or `id@rev`) of the packet's unreviewed statements the auditor accepts explicitly (every other one stays a
condition of the decision). The session adds the `packet` and `investigation` revisions it presented.

The fields come from the screen's disposition table, `DISPOSITION_FIELDS` in `src/screen/disposition.ts`, which
follows the glossary's [disposition table](../../framework-design-lab/design/harness-glossary.md#dispositions-and-evidence).
Every claim takes `disposition`, `potential_impact` (the auditor's estimate, or null to keep the current one) and
`impact_lower_reason` (required when the estimate is below the agent's). Then:

| `disposition` | Fields |
|---|---|
| `accepted` | `severity`, `severity_basis`, `finding: { prerequisites, title, mechanism, impact, applicability }` (an empty `prerequisites` list means the investigation's own; a linked claim's guarantee is added by the session), `evidence_route`: `executable_replay` (the controller checks for a clean replay receipt) or `alternative_argument` with `alternative: { why_impractical, why_sufficient, limits }` plus `failed_replays_addressed` when a replay of the claim failed; `code_argument` (uses the source anchors) only below an effective impact of medium |
| `rejected` | `decisive_evidence` (a list of references), `countercondition`, `countercondition_scope`; for an executable claim at potential High/Critical, `positive_control` (a record reference): a guard-removed rerun of the same experiment that shows the violation |
| `no_finding_within_bounds` | `bounds: { methods, variants_tried, budget, attacker_charter, assumptions }` (`methods` and `assumptions` are lists; an empty `methods` means the investigation's method) |
| `triaged_out` | `triage_reason` (one line); `potential_impact` must be `low` or `info`, and so must the effective impact |
| `disputed` | `interpretations` (at least two), `distinguishing_check` |
| `deferred` | `residual_concern`, `revisit_condition` |

A reference is `"id@revision"`, an artifact digest (`"sha256:…"`), a reference number shown in the presented packet
(`"3"` or `"[3]"`), or an object `{ "record_id", "revision" }` / `{ "artifact" }`. Fields that do not apply to a claim
(for example `alternative` with another route) are refused.

### Audit units (`unit-…`): `record_flow_review`

The presentation is the flow-review view: the unit, its DESIGNED, IMPLEMENTED and SHARED statements, its
correspondences and the comparisons, as the screen's flow review renders them, and the functions not yet reviewed.
Presenting IMPLEMENTED statements records the unit's first presentation (intent timing).

```json
{ "reviewed_functions": ["withdraw", "redeem"], "gaps": ["callback path through hook not walked"] }
```

`reviewed_functions` lists functions among the unit's unreviewed ones, or is `"all"` (every unreviewed function);
omitted means none. `gaps` is optional. The decision binds the comparisons that were presented.

### Work proposals (`wprop-…`): `authorize_work`

The presentation is the authorization view: the proposal, its investigations, lead-generator coverage per unit,
gaps, and spent, reserved and uncertain cost.

```json
{
  "limits": { "spend": 20, "runtime_seconds": 3600, "concurrency": 1, "child_tasks": 0, "rounds": 4, "retries": 1,
              "repairs_per_variant": 2, "output_bytes": 16777216, "memory_mb": 4096, "processes": 256 },
  "capabilities": { "tools": ["forge_test"], "providers": ["omp-anthropic"], "network": "denied" },
  "validity": null,
  "interrupt_conditions": [],
  "keep": ["inv-0002"]
}
```

Every limit key is required as a finite non-negative number, and nothing is defaulted. `capabilities` defaults to
the proposal's requested ones, `validity` (`{ from, until }` or null) to null, `keep` (investigation ids of the
proposal) to all of them. The decision also takes `attacker_charter` and `audit_units` (a list of
`{ "record_id", "revision" }` unit references), as the screen's `--draft` does. The values above are an example, not
proposals.

### The engagement (`eng-…`): `accept_scope_and_policy`

The presentation is the scope-and-policy view: the engagement, the default attacker charter, the trusted-role premise
(an assumption the report prints) and the mandatory policy fields. `decision` is `{ "policy": { … } }` with the
`EngagementPolicy` fields (`src/schema/records.ts`): `scope`, `exclusions`, `attacker_charter`,
`trusted_role_premise`, `data_policy`, `disclosure_constraints`, `retention`, `severity_rubric`,
`rejection_listing_threshold`, `budget`, `evidence_policy`, `capacity`, `time_plan`. The template starts from the
current policy, or from placeholders for the mandatory fields and the default charter. The charter must keep each
default attacker capability or exclude it with a reason; only the trusted-role premise text has a default. The
controller refuses a policy that lacks a mandatory field.

### Any other record: generic decisions

`harness_present` renders any other record in full (or says it is withheld in read-first mode). A generic
`harness_decide` takes `kind` (any decision kind except the four above, which are refused here and decided through
their item id), `records` (the records it binds, `id` or `id@rev`; when omitted, the record named by `id`),
`operation` and `decision` (the kind's decision inputs, passed to the controller as given, like
`harness screen decide`). `operation` defaults to the kind's own operation where one exists (for example
`revise_premise`, `approve_export`), else `record_decision`; no other value is accepted.

Every bound record must have been presented in this session, in full with `harness_present` or captured with
`harness_capture`; otherwise the decision is refused (`display_required`) with the records still to present.

For a pending clarification, interpretation, export preview or mechanical carry-forward, the presented record's
template is a generic call: `{ "kind", "records", "decision" }` for `answer_clarification`,
`confirm_interpretations`, `approve_export` or `attest_carry_forward`. Other kinds (`close_engagement`, `assess_fix`,
`reaffirm`, `revise_premise`, …) have no template; their inputs are those of the decision kind. There is no bulk
decision.

## Provenance

| What | Value |
|---|---|
| Principal | `agent-session` (`AGENT_SESSION_PRINCIPAL`), recorded as the decision's actor, on the `screen` channel, authenticated by `auditor.key` alone |
| Display receipt identity | `harness-agent-session <screen program digest> <client name>/<client version>` (`unknown/unknown` when the host sent no client info) |
| Display receipt session | `agent-<random token>`, one per server process |
| Rationale authorship | `human_written`, `agent_drafted_unedited` or `agent_drafted_edited`, as the agent reports it; `agent_unattended` stays exclusive to the unattended approver |
| Relayed captured input | capture channel `agent-session-relay`, with the capture program digest and the same session id; it records the auditor's words as the agent relays them, not keystrokes |
| `harness status` | "Decisions recorded through an agent session: dec-… kind, …", beside the unattended line (also in the overview's work list) |

## What the controller still enforces

The agent path changes who presents and records, not the decision rules. Every check the controller applies to a
screen decision applies here:

- **Display receipts:** a decision needs a display receipt from the `screen` channel that covers every reviewed
  revision (`display_required`), and one receipt backs one decision.
- **Evidence-first order:** for potential High/Critical packets, the receipt must show `evidence`, `challenger` and
  `evidence_quality` before `proposed_disposition`.
- **Staleness:** a newer revision of a reviewed record or of a direct input, or new inbound links or evidence on a
  packet, refuses the decision with `stale_dependency`; present the item again and decide on the current revisions.
- **Evidence requirements per disposition:** the disposition table above (`evidence_requirement_unmet`). A refused
  disposition is recorded as a `decision_refused` event.
- **Unreviewed premises:** unreviewed statements in the dependency closure make the decision conditional unless
  accepted explicitly.
- **Budgets and capacity:** every authorization carries finite limits; `authorize_work` is refused at review capacity
  (`review_capacity_reached`); jobs and provider calls run only within a current authorization's limits and spend.
- **Captured input:** decisions that need it (for example a clarification answer) must cite a captured input.

Tests: `test/review.test.ts` (the session against a real workspace) and `test/mcp.test.ts` (the protocol, and the
server end to end).
