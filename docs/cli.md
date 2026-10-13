# `harness` command-line reference

The CLI is the auditor's interface to the walking skeleton. It follows the
[auditor workflow guide](../../framework-design-lab/design/harness-auditor-guide.md); names and values come from the
[glossary](../../framework-design-lab/design/harness-glossary.md). Run `bin/harness help` for the command summary.

Three channels are used, each with its own authentication:

| Channel | Used by | Authenticated by |
|---|---|---|
| auditor | every non-decision command | `<workspace>/secrets/auditor.key` |
| trusted decision screen | `harness screen …` (all human decisions) | the auditor key **and** an interactive terminal on stdin and stdout |
| capture | `harness capture`, `harness capture-hook` | `<workspace>/secrets/capture.key` |

Human decisions never go through `harness call`: `record_decision`, `authorize_work`, `revise_premise` and
`approve_export` are screen-only operations, and the screen refuses pipes and scripts.

## Global options and output

- `--workspace DIR` or `HARNESS_WORKSPACE` (default `./workspace`); `-e ID` / `--engagement ID` or `HARNESS_ENGAGEMENT`.
- `--json` prints `{"ok": true, …}` results, or `{"ok": false, "error": {code, reason, committed, next, details}}`, on stdout.
- Every record text printed by the CLI and the screen passes through visible rendering: bidirectional controls,
  zero-width and other format characters, confusable letters and control characters (so terminal escape
  sequences) appear as markers such as `⟦U+202E RIGHT-TO-LEFT OVERRIDE⟧`.
- Errors name the stable code, the reason, whether anything committed, and the allowed next action.

| Exit code | Meaning |
|---|---|
| 0 | success |
| 1 | internal error (check `harness status` for the state of any write in progress) |
| 2 | usage error; nothing was sent |
| 3 | refused by the controller; nothing committed |
| 4 | refused after something committed (for example a retained proposal conflict) |
| 5 | left undecided on the trusted screen; nothing recorded |

## 1. Start an engagement

```sh
harness init                                         # workspace, secrets/ (0700) with auditor.key and capture.key
harness engagement create vault --name "Vault" --owner me --purpose "pre-launch review" [--chain 1 --hardfork cancun]
harness status -e vault                              # home view: decisions needed, current work and spending, material gaps
harness snapshot register ../vault-src -e vault --label v1 [--payload @deployment.json]
harness screen accept_scope_and_policy -e vault --draft policy.json
```

The policy draft is an `EngagementPolicy` (scope, exclusions, data policy, retention, severity rubric,
rejection-listing threshold, budget, evidence policy, capacity, time plan). The screen walks the default attacker
charter capability by capability (keep, or exclude with a reason), asks which privileged roles you raise, and
shows the trusted-role premise as an **assumption** that the report prints. Unresolved mandatory fields are listed
and the controller refuses the decision until the draft supplies them. Numeric limits, budget and capacities are
your choices; the CLI supplies no defaults.

## 2. Build shared understanding

```sh
harness capture -e vault                             # talk-to-agent wrapper: each line recorded verbatim first
harness capture -e vault -- claude -p --continue     # same, piping each captured entry to an agent CLI
harness capture -e vault --purpose expectations_pre_step --unit unit-0003   # optional, before the walkthrough
harness unit propose -e vault --set kind=flow --set name=withdrawal
harness statement propose -e vault --file statement.json
harness screen confirm_interpretations -e vault      # confirm / edit / reject EACH proposed interpretation
harness screen answer_clarification -e vault [clar-0004]
harness screen record_flow_review unit-0003 -e vault
```

`<noun> propose` wraps `submit_proposal`; the body comes from `--file`, `--body JSON` and `--set key=value`
(values parse as JSON when they can), with `--base id@rev` for a revision. Nouns: `statement`, `investigation`,
`variant`, `clarification`, `interpretation`, `unit`, `property`, `correspondence`, `comparison`, `discrepancy`.

The clarification screen shows one clarification, its conflicting facts, the work that depends on it, any prior
answer to the same question and the state of unrelated work. "unknown" is a valid answer. The answer must link
captured input: type it through `harness capture --purpose clarification_answer` (or the hook) first.

Exploration rounds run under a current `exploration` authorization:

```sh
harness explore start -e vault --unit unit-0003 --lens flows --authorization auth-0002
harness explore resume expl-0001 -e vault            # prints what changed since the last round, then opens a new round
harness diagram propose -e vault --unit unit-0003 --lens flows --affiliation designed --source flow.mmd [--statement stmt-0004 ...]
harness compositions derive -e vault                  # composition units from shared written stores (needs the inventory)
harness coverage functions -e vault                   # in-scope functions mapped to no unit, or never reviewed
harness metrics -e vault                              # engagement metrics
```

IMPLEMENTED behavior (implemented or shared statements, correspondences that map implemented statements, and KB
diagrams with affiliation `implemented` or `comparison`) is presented only with a display receipt naming its audit
units. `records`, `show` and `call read_records` record that receipt (auditor channel) before printing, so the
controller derives intent timing from the first presentation. While read-first mode is active (`call
start_read_first` … `call end_read_first`) they withhold those records and say so; the trusted screen does the same.

## 3. Approve a small batch

```sh
harness work prepare -e vault --kind batch --investigation inv-0002 --investigation inv-0005
harness work authorize wprop-0001 -e vault [--draft limits.json]    # = harness screen authorize_work
```

The batch view shows each investigation (keep or remove each), lead-generator coverage per unit, whether a
multi-step or cross-flow question is included, the gaps, and spent / reserved / uncertain cost separately. Each
finite limit is entered (or taken from `--draft`); nothing is defaulted.

## 4. Run work

```sh
harness job request -e vault --payload @job.json
harness job run -e vault [--max N]                   # trusted runner, one job at a time
harness job pause -e vault --reason "..." ; harness job resume -e vault --reason "..."
harness job cancel job-0007 -e vault --reason "..."
harness exec -e vault --description "manual fuzz" [--snapshot snap-0001@1] -- forge test --mt testX
harness import-artifact ./notes.txt -e vault --description "trace I ran locally"   # untrusted-receipt label
```

Agents run as jobs under the batch authorization through the reference agent host:

```sh
harness agent roles                                  # each role: receives, produces, may not decide, operations
harness agent run investigator -e vault --task "Trace the callback path" --model <model> --investigation inv-0002 [--max-turns 8]
harness job run -e vault
harness batch status -e vault                        # batches: status, spend, runtime, jobs; next job; held jobs with reasons; review queue
harness batch reconcile -e vault                     # record batch lifecycle transitions the records imply
```

To talk to a harness agent directly, use the session wrapper (the terminal-wrapper fallback of DEC-008 Q-018):

```sh
harness agent session investigator -e vault --model <model> --investigation inv-0002 [--authorization auth-0003] \
        [--adapter reference_agent|claude_code] [--max-turns 8] [--live-providers P,...]
```

For each entry you type (one line, or `/multi`; `/quit` ends), the session (1) records it verbatim on the capture
channel (same channel name and program digest as `harness capture`), (2) builds the role's context and requests an
agent job whose task is that exact text, with the `captured_input` reference in its args (the runner checks they
match), (3) runs the queue and prints the agent's round summary, the proposals its outbox committed and any requests
the controller refused, all with visible rendering. An entry whose capture failed is never sent to the agent.
Recorded proposals that present IMPLEMENTED behavior are receipted, or withheld during read-first mode; the agent's
own prose is not a record and is shown as is.

`job run` and `agent session` use the process's provider broker; when none is active, one is created with the
workspace's configured external providers (credentials in `secrets/providers/<name>.key`). Which providers may
receive live-exploitable material is an operator choice (`--live-providers`; default none).

`agent run` builds the role's context (`build_context`) and queues an `agent` job on the `reference_agent` adapter.
It uses the investigation's authorization, or the single active one, unless `--authorization` names another. The
authorization must allow the `reference_agent` tool and approve a provider. Model choice and provider remain operator
choices. `harness status` includes the batch view.

## 5. Review an investigation

```sh
harness position submit -e vault --investigation inv-0002 --role challenger --file challenger.md   # verbatim position
harness fixture submit -e vault --investigation inv-0002 [--root DIR] test/Exploit.t.sol ...       # inline fixture files
harness packet submit -e vault --file packet.json    # submit_review_packet; packet_incomplete names what is missing
harness screen packet pkt-0003 -e vault
```

`fixture submit` prints a WARNING first, listing every target file the fixture overrides: runs with it do not test the
original target bytes.

Packet screen keys: `1`–`6` open a section (Enter opens the next one), `p N` pages a whole section, `v N` pages
reference `N` (record JSON or artifact text) in full, `m` requests more work (a named distinguishing check, run
only within a current authorization; not a disposition), `d` decides, `q` leaves the item undecided.

Sections: `[1] claim`, `[2] evidence` (supporting and refuting records, every failed attempt, every variant with
its outcome grouped by guarantee, each linked claim with its own potential impact and an `UNREVIEWED FLOW` flag),
`[3] challenger` (challenger and author positions verbatim from their artifacts, and challenge independence),
`[4] evidence_quality`, `[5] unreviewed_statements`, `[6] proposed_disposition`.

- Potential High or Critical (`unknown` counts as high; the highest of the packet and its linked claims applies):
  section 6 is **locked** until 2, 3 and 4 have been opened; the display receipt records the opening order.
  The agent's draft rationale is offered only if you opened section 6.
- Below High: the combined layout shows all six sections in order.
- Deciding asks, for the main claim and then for each linked claim separately: your potential-impact estimate
  (below the agent's needs a reason), the disposition, and the fields the glossary's disposition table requires.
  Unreviewed statements stay conditions unless you accept each one explicitly. Then the rationale and its
  authorship (accept the agent draft unedited, edit it, or write your own; the controller computes the edit diff),
  a summary, and the explicit confirmation word `yes`.
- A refusal is explained in place: `stale_dependency` lists each changed record with the revision you reviewed and
  the current one; `display_required` names what was not rendered or opened; `evidence_requirement_unmet` names
  what the disposition still needs. Re-review re-renders the current revisions under a new receipt.

Other decision screens: `attest_carry_forward [--snapshot S]` (labelled MECHANICAL; covers only conclusions whose
probes are unchanged), and `decide <kind> --record id[@rev] … --inputs @inputs.json` for any other kind (for
example `reaffirm`, `assess_fix`, `approve_semantics`, `close_engagement`, `record_transfer`): the screen renders
each bound record and the inputs, and asks you to confirm them before deciding. There is no bulk decision.

## 6. Close and export

```sh
harness export prepare -e vault --file selection.json
harness export approve rpt-0001 -e vault [--destination ./out]    # = harness screen approve_export
harness export bundle rpt-0001 -e vault --destination ./out
harness import ./bundle [-e target-engagement]                    # verified in quarantine, execution disabled
```

The approval screen shows the frozen preview, every required item the selection omits with its omission reason
(none given means the approval is refused), the stated limits, and the frozen report text on request.

## Evaluation, methods and conformance (library scope)

```sh
harness eval contract propose --file contract.json            # draft evaluation contract
harness screen freeze_evaluation_contract evalc-0001           # trusted screen: render, choose each compared metric, freeze
harness eval report --contract evalc-0001 [--matches matches.json]
harness eval canary register -e vault --packet pkt-0003 --kind invalid_claim_plausible_narrative
harness eval canary score
harness eval held-out --file cases.json                        # held-out comparison (feeds adoption)
harness method propose --component prompt --name investigator --version 2 --description "..." [--content prompt.md]
harness screen adopt_method_version method-0001 --evaluation held-out.json [--rollback]
harness conformance reference_agent -e vault [--snapshot snap-0001] [--sandbox-egress]
```

Canary labels live only in the library scope: no engagement-scoped command and no packet review shows them.
`--evaluation` takes the `held_out_comparison` result (or its `evaluation` object). Adoption shows the regressions,
and the controller refuses a candidate that fails a case the baseline passes. Accepted residual risk Q-024 is
shown on the adoption screen. `conformance` runs the adapter (and agent-host) checks through the trusted runner and
records them as evidence; each check prints PASS, FAIL or NOT_APPLICABLE.

Before adopting the harness for accepted conclusions, verify the control mechanics (evaluation plan, pilot step 2):

```sh
harness controls list                                   # the 24 control and recovery scenarios, gates and measurements
harness controls verify --record --workstation NAME     # run the mapped tests here; record the result in the library
```

`controls verify` exits 3 when any gate fails: adoption is blocked regardless of finding count. Measurement scenarios
(Q-014, Q-021, Q-024) are pilot work and never gate adoption. The record is auditor-run, not a trusted receipt.

## Other commands

```sh
harness records -e vault [--type investigation] [--id inv-0002 ...] [--history] [--json]
harness show inv-0002@3 -e vault
harness schemas --out schemas/          # JSON Schema of every record body, envelope, event, request and refs (NFR-10)
harness call <operation> -e vault --payload JSON|@file   # any operation open to the auditor channel
```

## Capture channel and agent-tool confinement

Captured input records the auditor's typed words verbatim (no trimming or normalization) with the channel name, a
digest of the capture program files (`bin/harness`, `src/cli/main.ts`, `src/capture/*.ts`), the host session id,
and the controller's time stamp and content digest. Two adapters exist; the agent host itself is an **open
operator choice**:

- **Terminal wrapper** (`harness capture`): reads only from an interactive terminal; `--once` (default for the
  expectations pre-step and notes) records one multi-line entry. With `-- <argv>`, each entry is piped to that
  command only after it was recorded; an entry whose capture failed is not forwarded.
- **Claude Code `UserPromptSubmit` hook** (`harness capture-hook`): reads the hook JSON (`session_id`, `prompt_id`,
  `hook_event_name`, `prompt`, …) on stdin and records `prompt` verbatim. It writes nothing to stdout (Claude Code
  adds a UserPromptSubmit hook's stdout to the model's context), never blocks, always exits 0, and reports failures
  on stderr. A repeated delivery with the same `prompt_id` records once. Configure it where the agent cannot edit it,
  for example in managed or user settings outside the engagement checkout:

  ```json
  { "hooks": { "UserPromptSubmit": [ { "hooks": [ {
      "type": "command",
      "command": "/opt/harness/bin/harness capture-hook --workspace /srv/harness/ws --engagement vault",
      "timeout": 30 } ] } ] } }
  ```

  This contract was checked against the Claude Code hooks reference on 2026-10-12; recheck it when the host
  version changes. A failed hook leaves the prompt unrecorded (stderr shows it), and an interpretation of that
  prompt then has no captured input to link.

The capture and screen processes run **outside** the agent tool's confinement and read keys from the workspace.
This code does not establish that confinement. Before relying on captured input, verify for each engagement:

1. one confined agent-tool instance per engagement;
2. the agent host's own memory is turned off;
3. the agent tool cannot read the workspace (in particular `secrets/`), and cannot write its own hooks or
   configuration, the capture program files, or the hook command's target;
4. provider calls go only through the provider broker, with no raw provider keys in the tool;
5. worker sandboxes never mount the workspace, so no worker process can read the auditor key or reach the screen.

These are the compatibility checks for an agent tool in the interface contracts ("Compatibility and conformance");
they remain conditions to verify, not guarantees this CLI provides.
