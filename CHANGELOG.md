# Changelog

## 0.1.0 — 2026-10-14

First release: the walking skeleton of the human-led EVM audit harness (design: `../framework-design-lab/`, DEC-008, Q-020). Contract version 1 ([docs/contracts.md](docs/contracts.md)).

### Included

- **Core:** one local controller that runs jobs one at a time as child processes it owns; append-only Git-backed engagement store and hash-pinned evidence archive; record contracts as JSON Schemas; every write is an atomic controller operation. Worker grants are bound to their engagement and re-validated at commit; crash recovery and stale-lock reclaim.
- **Decisions:** proposals, captured input and batched confirmation, clarification queue, batch authorization with flow review, review packets with bound positions and derived challenge independence, impact-scaled dispositions with claim-bound positive controls, premise revision, comprehension records, method versions and metrics.
- **Execution:** trusted runner and receipt collector; bubblewrap sandbox with no network; Foundry adapters, including property campaigns with adequacy from a reviewed fault; per-attempt provider broker socket with content validation, ceiling reservations and `outcome_unknown` accounting; reference role agents; conformance checks.
- **Change handling:** frozen snapshots, deterministic inventory from compiler artifacts, snapshot diffs, dependency probes and freshness tiers, automatic reruns, fix assessment, intake scan for steering and deceptive characters.
- **Reporting and method:** controller-computed required set, reports, export and quarantined import, closure, mechanism library and lessons, context builder, evaluation contracts, canaries, held-out comparisons, control checks, scheduling across batches, lead generators.
- **Interface:** trusted decision screen with display receipts, capture channel (terminal wrapper and Claude Code `UserPromptSubmit` hook), `harness` CLI.
- **Providers:** omp credential gateway as the provider broker's upstream (`omp-anthropic`, `omp-openai-codex`; omp version pinned, 80% plan headroom, notional spend). A 5xx relayed by the gateway is `outcome_unknown` with the reservation held; a 4xx stays a definite refusal.
- **Agent host:** reference host passes every conformance check; Claude Code passes all five agent-tool conditions in terminal-wrapper mode ([trial](docs/agent-host-trial.md)).

### Operator decisions recorded

- Sandbox: bubblewrap (2026-10-13).
- Model provider: omp's credential gateway (2026-10-13), with the terms and billing caveats in [docs/operator-choices.md](docs/operator-choices.md).

### Still open (not part of this release)

- Agent host selection, and every numeric limit (the `PROPOSED_*` constants are pilot placeholders).
- No engagement approves the Anthropic API adapter.
- The pilot comparison against the auditor's ordinary workflow needs a human auditor and targets set before the run.
- Deferred mechanisms (transactional store, parallel or remote workers, further tool adapters) stay deferred until their triggers occur.

### Verification

`npm run typecheck` clean; `npm test` 153 of 153 passing (bwrap and forge with cached compilers, no network).
