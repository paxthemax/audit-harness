# omp gateway provider trial

**Date:** 2026-10-13. **Script:** `scripts/trial-omp-gateway.ts`. **Decision it supports:** the operator's provider choice in [operator-choices.md](operator-choices.md#operator-decisions).

## Setup

- **Upstream:** `omp auth-gateway stdio`, oh-my-pi 18.10.1 (the pinned version), dedicated omp profile `harness`. The profile holds exactly two logins: the operator's Claude Team seat (`omp-anthropic`) and ChatGPT plan (`omp-openai-codex`).
- **Agents:** the reference agent (`reference_agent`) in bubblewrap with no network, reaching the model only through the per-attempt broker socket.
- **Models:** `anthropic/claude-haiku-5-5` and `openai-codex/gpt-5.6-luna`, chosen for low plan usage, not for audit quality.
- **Target:** the synthetic `test/fixtures/vault` contract only, in a throwaway workspace. No client code.
- **Policy:** both providers approved for the engagement, including the live-exploitable class, which this synthetic target allows.

The script played the auditor: it accepted the policy, authorized intake, built the snapshot, reviewed a flow, admitted one investigation and authorized a batch. Four agent rounds ran under those authorizations.

## Results

| Round | Model | Outcome | Provider calls | Data class | Outbox | Notional spend |
|---|---|---|---|---|---|---|
| 1 Comprehension | Claude Haiku 5.5 | Completed, 97 s | 5, all `200` | `source` | 7 entries: 6 committed, 1 refused | $0.0027 |
| 2 Comprehension | GPT-5.6 Luna | Completed, 39 s | 5, all `200` | `source` | 7 entries: 7 committed | $0.0169 |
| 3 Investigator | Claude Haiku 5.5 | **Failed**, 30 s | 4 `200`, then one `502` from the gateway | `unfixed-findings` | 2 entries: 2 refused | $0.0021 |
| 4 Challenger | GPT-5.6 Luna | Completed, 35 s | 6, all `200` | `unfixed-findings` | 2 entries: 1 committed, 1 refused | $0.0140 |

Total notional spend was $0.036; the plans charge nothing per call. The whole run took 3.5 minutes.

### Live agent-run checks

| Check | Round 1 | Round 2 | Round 3 | Round 4 |
|---|---|---|---|---|
| `model_traffic_only_through_broker` | pass | pass | pass | pass |
| `live_launch` | pass | pass | fail (the round failed) | pass |
| `proposals_via_outbox` | pass | pass | fail (nothing committed) | pass |
| `streaming_synthesized`, `own_config_write_denied`, `typed_input_captured_outside_model` | not applicable | not applicable | not applicable | not applicable |

The not-applicable checks follow from the reference agent: it does not stream, has no configuration of its own, and these headless jobs have no typed input.

### Plan windows

The broker read the plan windows before every call and archived the reading with each response. No reading reached the 80% headroom.

| Plan | Before the run | After the run |
|---|---|---|
| Claude Team | 5 hour 77%, 7 day 13%, 7 day Fable 5% | unchanged |
| ChatGPT | 7 days 0% | unchanged |

The Haiku and Luna usage was below one percentage point of every window, so this run cannot show whether harness calls move the windows. The earlier Fable check (0% to 3% while omp alone used Fable) is the evidence that Claude calls through omp count against the Team plan.

### What the agents did

- **Round 1 (Claude):** six implementation and intent statements about `withdraw` and `deposit`. The seventh request, a `propose_kb_diagram`, was refused with `not_found: record undefined@undefined not found`. The agent passed an incomplete reference, and the error text does not say which field.
- **Round 2 (GPT):** an audit unit, "Ether deposit flow", and six statements.
- **Round 3 (Claude):**
  - Four calls succeeded. The fifth came back from the gateway as `502 upstream_error: The socket connection was closed unexpectedly before the response completed`. The reference agent ends a round on a provider error (exit 3), and the broker never retries.
  - The controller refused both outbox entries, two scenario variants whose `linked_guarantee` repeated the investigation question's own guarantee. That is a model error caught by the controller.
- **Round 4 (GPT):** a challenger position stating that `withdraw` is protected by `nonReentrant`, which is correct for this fixture. The controller derived the position's model (`openai-codex/gpt-5.6-luna`) and provider (`omp-openai-codex`) from the broker's records of the attempt. A second request was refused as a `revision_conflict`: it was based on an older revision of the investigation.

## Change made because of the trial

When round 3 ran, a `502` from the gateway was recorded as refused before sending, with the reservation released. A 5xx reply relays an upstream failure, and Anthropic may have served the request, so it is now `outcome_unknown` with the reservation held, as for a timeout. A 4xx reply stays a definite refusal. The change is pinned in `test/runner-omp.test.ts`.

## What the trial shows

- The broker's guarantees hold with the gateway as its upstream. Every model call left through the broker socket. Each call carried a controller-derived data class and a reservation, and the broker held no credential.
- One gateway process served both plans. Claude and GPT tool use worked through the same Anthropic Messages format.
- A Claude author and a GPT challenger give a packet a challenger on a different provider, and both providers are recorded from the broker's records.

## What it does not show

- **Audit quality.** The models were picked for low usage. Model choice per role is an operator setting.
- **Plan-window movement.** The usage was too small to move any window.
- **Retry policy.** Transient upstream errors will recur. A failed round is re-run by the auditor; there is no automatic retry, by design.
- **Untested paths:**
  - streaming from the agent;
  - Sonnet, Opus, Fable or GPT-5.6 Sol behaviour;
  - long runs near the headroom;
  - parallel workers;
  - Claude Code or omp as the agent host.

## Follow-ups

- `propose_kb_diagram` reports `record undefined@undefined` for an incomplete reference; the message should name the field.
