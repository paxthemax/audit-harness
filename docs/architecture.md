# Architecture and traceability

This maps the specification in `../framework-design-lab/design/` onto the code. It states plainly what is enforced, what is tested, and what is left to a pilot or an operator choice.

## Delivery sequence status

The [proposal's delivery sequence](../../framework-design-lab/design/audit-harness.md#delivery-sequence) has five steps. Steps 4 and 5 are operator activities; this repository supplies their tooling.

| Step | Status | Where | Test |
|---|---|---|---|
| 1. Walking skeleton: intake, isolated one-job-at-a-time execution, manual investigations, batch authorization, decisions on the trusted screen with captured input, impact-scaled dispositions, one replay package, dependency probes with change handling | Done | all modules | `e2e-milestone.test.ts` (the first adoption milestone: refuted lead, positive control, restart, changed premise, export) |
| 2. Role-specific agent assistance | Done (reference agents; agent host still an operator choice) | `src/agents/`, `src/controller/roles.ts`, broker socket and `reference_agent` adapter in `src/runner/` | `agents.test.ts`, `runner*.test.ts`, `e2e-agents.test.ts` |
| 2. Scheduling across several batches | Done | `src/scheduler/scheduler.ts` | `scheduler.test.ts` |
| 2. Clarification routing | Done | `src/decision/clarifications.ts` | `decision.test.ts` |
| 2. Report export with required-set checks | Done | `src/report/` | `report.test.ts`, `e2e-*.test.ts` |
| 2. Workload and decision-load accounting | Done | `src/metrics/`, `src/evaluation/` | `comprehension.test.ts`, `evaluation.test.ts` |
| 2. Mechanism library, public entries first | Done | `src/library/` | `library.test.ts` |
| 2. Control/recovery checks before accepting conclusions | Done for every scenario the skeleton can exercise; adapter, sandbox and agent-host conformance checks are runnable (`run_conformance`) | `src/runner/conformance.ts` | see "Control and recovery scenarios" below |
| 3. A small property campaign and an integration scenario on the same records | Done | invariant campaigns and adequacy jobs in `src/runner/`, adequacy rule in `src/decision/proposals.ts` | `e2e-property.test.ts`, `e2e-acceptance.test.ts` |
| 4. Comparison against the auditor's ordinary workflow | Tooling done; the pilot itself is the operator's (it needs a human auditor, consented code and targets set before the run) | `src/evaluation/` (frozen evaluation contract, metrics table, canary packets, held-out comparison) | `evaluation.test.ts` |
| 5. Deferred mechanisms added on their triggers | Nothing triggered; each stays deferred with its trigger documented | `docs/operator-choices.md` | — |

## Components

| Spec component | Module | Notes |
|---|---|---|
| Controller | `src/controller/controller.ts`, `basicOps.ts`, `roles.ts` | Sole writer. Every request is checked for contract version, channel, worker grant, idempotency key and expected revisions, then one handler stages records and the controller commits them with an event in one Git commit |
| Engagement store | `src/store/recordStore.ts` | Append-only revision files plus events per engagement; schema-validated on commit and on open; uncommitted files quarantined; corrupt state refuses writes |
| Evidence archive | `src/store/archive.ts` | Content-addressed blobs, verified on every read; trees for snapshots, fixtures and outputs |
| Mechanism library | `src/library/` | A separate store in the `library` scope; written only by `record_transfer` decisions |
| Context builder | `src/context/builder.ts` | Versioned manifests per role, withheld items, challenger exclusions, comment-blind pass |
| Agent workers | `src/agents/` (reference role agents), `src/controller/roles.ts`, worker channel, outbox ingestion in `src/runner/runner.ts` | Role profiles fix each grant's operations; agents run in the sandbox, reach a model only through the broker socket, and only propose |
| Tool broker and execution workers | `src/runner/` | bubblewrap sandbox, Foundry adapters, one job at a time, receipts from the supervisor side |
| Provider broker | `src/runner/provider.ts`, `src/runner/brokerSocket.ts`, `src/runner/anthropic.ts` | Engagement approval, controller-derived data classes, reservations, `outcome_unknown`; a per-attempt socket into the sandbox; an Anthropic adapter as a candidate, unapproved by default |
| Change evaluator | `src/snapshot/` | Snapshots, inventory, diffs, dependency probes, freshness, automatic reruns under the revalidation allowance |
| Report and evaluation | `src/report/`, `src/metrics/`, `src/method/`, `src/evaluation/`, `src/scheduler/`, `src/leads/` | Required set, generated report, export/import, closure; decision-load metrics; method versions; evaluation contract, metrics table, canaries, held-out comparison, control checks; scheduling across batches; lead generators |
| Auditor interface and trusted decision screen | `src/screen/`, `src/cli/`, `src/capture/` | Terminal screen with display receipts; CLI; capture wrapper and Claude Code hook |
| Human decisions | `src/decision/` | Proposals, captured input, clarifications, work authorization, packets and positions, decision kinds, premise revision, fixtures |
| Comprehension records | `src/comprehension/` | KB diagrams, explorations, accounting views, control checklist, lead groups, compositions, function coverage |

## The three invariants

1. **Agents cannot write canonical records.** Agents reach the controller only on the worker channel, through the outbox their sandbox writes, with a per-attempt grant that names its operations (`roles.ts`). The grant is re-checked at commit time. No worker operation can create a decision, a reviewed statement, a finding, an authorization, a library entry or an export. Decisions come only from the `screen` channel.
2. **Approvals bind exact revisions.** Each decision names the revisions it reviewed and a display receipt from the screen that rendered them. The controller refuses with `stale_dependency` if any reviewed record or direct input has a newer revision. Packet decisions also need the same inbound-link digest and evidence watermark that the packet was built with. For potential High/Critical, the receipt must show evidence, challenger and evidence quality opened before the proposed disposition.
3. **Receipts come from the trusted runner.** Only the in-process runner channel can complete attempts and create `trusted_runner` evidence. Its exit status, signals and output hashes come from the supervisor. Auditor-run imports are labelled untrusted and never eligible.

An independent adversarial review of this build found three critical and eight high-severity holes in these invariants (worker reads across engagements, crash recovery resurrecting unacknowledged records, agents editing reviewed coverage, unbound positive controls, author-written challenger positions, among others). All were fixed; `test/review-regressions.test.ts` and the module tests pin each one. A second review of the step 2–5 code (agent execution, broker, scheduler, lead generation, evaluation, property campaigns) found five high and sixteen medium issues, among them source edits that could alter the PoC itself, fixtures that changed the compiled target without overriding a file, URL-sourced content passed to the provider, and reservations below the bill; all are fixed and pinned by `test/review2-regressions.test.ts` and `test/runner-review2.test.ts`. The remaining known limitation, shared authentication of the CLI and the screen, is recorded in [operator-choices.md](operator-choices.md#known-limitation).

## Requirement traceability

"Test" names the test file that exercises the acceptance scenario. "Partial" means the mechanism exists but the scenario is only partly exercised.

| Req | Status | Where | Test |
|---|---|---|---|
| FR-01 snapshot freezing, source-only limitation | Done | `snapshot/register.ts`, `snapshot/source.ts` | `snapshot.test.ts` (dirty checkout), `e2e-milestone.test.ts` |
| FR-02 human scope/policy/budget decisions | Done | `decision/kinds.ts` (`accept_scope_and_policy`), `decision/work.ts`, `runner/jobs.ts` | `decision.test.ts` |
| FR-03 isolated build, partial/unsupported recorded | Done | `runner/adapters.ts`, `snapshot/register.ts` | `runner.test.ts`, `snapshot.test.ts` |
| FR-04 DESIGNED/IMPLEMENTED models | Done (records) | `decision/proposals.ts` (statements, correspondences, comparisons, discrepancies) | `decision.test.ts`, `comprehension.test.ts` |
| FR-05 progressive comparison by flows | Partial | comparison records carry coverage and result; lens guidance is for agents | — |
| FR-06 clarification queue | Done | `decision/clarifications.ts` | `decision.test.ts` |
| FR-07 bounded work authorizations | Done | `decision/work.ts`, `runner/jobs.ts` | `decision.test.ts`, `runner.test.ts` |
| FR-08 role grants, context exposure | Done | `controller/roles.ts`, `context/builder.ts`, `agents/` | `context.test.ts`, `agents.test.ts`, `e2e-agents.test.ts` |
| FR-09 common investigation contract, variants | Done | `decision/proposals.ts`, `decision/packets.ts` | `decision.test.ts`, `e2e-milestone.test.ts` |
| FR-10 separate output, interpretation, state, disposition | Done | record types in `schema/records.ts` | `runner.test.ts`, `decision.test.ts` |
| FR-11 semantic review and adequacy | Done | `approve_semantics`; adequacy needs a detected reviewed fault and never counts when every action reverted (`requireAdequacyEvidence`) | `e2e-property.test.ts` |
| FR-12 exact experiment inputs | Done | job records, fixtures, receipts, export `reproduction/` | `runner.test.ts`, `report.test.ts` |
| FR-13 clean replay, attacker realism | Partial | replay jobs and status; environment-read flags. Replaying with realistic environment values is not automated | `runner.test.ts` |
| FR-14 duplicates and causes | Done | `comprehension/comprehension.ts` | `comprehension.test.ts` |
| FR-15 human-only acceptance bound to displayed revisions | Done | `decision/framework.ts`, `screen/` | `decision.test.ts`, `screen.test.ts` |
| FR-16 retained negative work, impact-scaled evidence | Done | `decision/kinds.ts` | `decision.test.ts`, `e2e-milestone.test.ts` |
| FR-17 probes and freshness, forward review from diff | Done | `snapshot/change.ts`, `snapshot/diff.ts`, `snapshot/reruns.ts` | `snapshot.test.ts`, `e2e-milestone.test.ts` |
| FR-18 pause, cancel, bounded retries, `outcome_unknown` | Done (skeleton) | `runner/jobs.ts`, `runner/provider.ts` | `runner.test.ts` |
| FR-19 review capacity | Done | `authorize_work` refuses a batch at review capacity; the scheduler holds discovery agents | `decision.test.ts`, `scheduler.test.ts` |
| FR-20 fix assessment | Done | `snapshot/decisions.ts` (`assess_fix`) | `snapshot.test.ts` |
| FR-21 reports and PoC packages from decisions | Done | `report/export.ts` | `report.test.ts`, `e2e-milestone.test.ts` |
| FR-22 required set at closure | Done | `report/requiredSet.ts`, `report/closure.ts` | `report.test.ts` |
| FR-23 lessons with counterconditions | Done | `library/lessons.ts` | `library.test.ts` |
| FR-24 isolation of engagements, tool, egress | Done | sandbox, scope checks, `context/builder.ts` | `runner.test.ts`, `context.test.ts`, `report.test.ts` |
| FR-25 measurements | Done (tooling; the pilot is the operator's) | `metrics/metrics.ts`, `evaluation/` (metrics table, canary packets) | `comprehension.test.ts`, `evaluation.test.ts` |
| FR-26 method versioning | Done | `method/methods.ts` | `comprehension.test.ts` |
| FR-28 baseline controls | Done | `comprehension/comprehension.ts`, required set | `comprehension.test.ts`, `context.test.ts` |
| FR-29 seeding in bounded rounds | Done | comprehension reference agent under an `intake` authorization; each agent job is a round counted against `limits.rounds` | `e2e-agents.test.ts`, `runner-agent.test.ts` |
| FR-30 KB diagrams | Done | `comprehension/comprehension.ts` | `comprehension.test.ts` |
| FR-31 explorations | Done | `comprehension/comprehension.ts` | `comprehension.test.ts` |
| FR-32 flow review before batch | Done | `decision/work.ts` | `decision.test.ts` |
| FR-33 attacker charter and trusted-role premise | Done | `accept_scope_and_policy`, report assumptions | `decision.test.ts`, `e2e-milestone.test.ts` |
| FR-34 deterministic inventory, vendored diff, review coverage | Done | `snapshot/inventory.ts`, `comprehension/compositions.ts` | `snapshot.test.ts`, `e2e-milestone.test.ts` |
| FR-35 lead generators with coverage | Done | `leads/generators.ts` (discrepancies, standards, attack-vector sweep, upstream diff, project tests, baseline controls, library, tool signals) | `leads.test.ts` |
| FR-36 compositions, system invariants | Done (shared written stores; configuration writers and callbacks not yet mapped) | `comprehension/compositions.ts` | `e2e-milestone.test.ts`, `e2e-property.test.ts` |
| FR-37 accounting tables | Done | `propose_accounting_view` | `comprehension.test.ts` |
| FR-38 steering, deception, environment sensitivity | Done | `intake/scan.ts`, `intake/visible.ts`, screen rendering | `intake.test.ts`, `screen.test.ts` |
| FR-39 captured input, batched confirmation | Done | `capture/`, `decision/kinds.ts` | `decision.test.ts`, `capture.test.ts` |
| FR-40 unreviewed premises in decisions | Done | `decision/framework.ts` | `decision.test.ts` |
| FR-41 auditor-run commands | Done | `runner/auditorRuns.ts` | `runner.test.ts` |
| FR-42 mechanism library | Done | `library/library.ts` | `library.test.ts` |
| FR-43 expectations pre-step, read-first, intent timing | Done | `decision/proposals.ts`, `decision/common.ts` | `decision.test.ts`, `comprehension.test.ts` |
| NFR-01 human authority | Done | channels and decision framework | `decision.test.ts`, `runner.test.ts` |
| NFR-02 atomic record/event commits, visible conflicts | Done | `store/recordStore.ts`, controller | `core.test.ts`, `decision.test.ts` |
| NFR-05 recoverability | Done (skeleton) | quarantine on open, `verify_store`, reconciliation | `core.test.ts`, `recovery.test.ts`, `runner.test.ts` |
| NFR-10 portability | Done | export bundle, `harness schemas` | `report.test.ts`, `cli.test.ts` |
| NFR-13 honest assurance | Done | report generation refuses whole-system claims | `report.test.ts` |
| NFR-07, NFR-14, NFR-15 | Pilot | targets and ceilings are set by the operator before a pilot | — |

FR-27 (other ecosystems, remote fleets) is `later` and not started.

## Control and recovery scenarios

`harness controls verify [--record]` runs the tests mapped to every scenario on the operator's workstation and records the result in the library scope (pilot step 2). On the development workstation all 21 gates passed on 2026-10-13. The three measurement scenarios (CS-15, CS-16, CS-17) have automated procedures; in a pilot their results are measurements of accepted residual risks, never gates.

| Scenario | Status | Test |
|---|---|---|
| Malicious repository instructions | Flagged at intake; no secret or decision path from the sandbox | `intake.test.ts`, `runner.test.ts` |
| Conflicting worker facts at one revision | Done | `decision.test.ts` |
| Crash after dispatch, after artifact write, before receipt | Done for the skeleton (dead-pid reconciliation, quarantine of uncommitted files) | `runner.test.ts`, `core.test.ts` |
| Provider timeout after acceptance | Done | `runner.test.ts` |
| Pause during a long run | Done (process-group termination); leases are deferred | `runner.test.ts` |
| Changed guard; changed assumption | Done | `snapshot.test.ts`, `decision.test.ts`, `e2e-milestone.test.ts` |
| Evidence changes just before approval | Done | `decision.test.ts` |
| Build failure; unsupported assembly/proxy | Done | `runner.test.ts`, `snapshot.test.ts` |
| Restore on a clean workstation | Done | `recovery.test.ts` |
| Escaping archive, path or report | Done | `report.test.ts`, `recovery.test.ts` |
| Cross-engagement retrieval; secrets in logs | Done (retrieval, redaction support) | `context.test.ts`, `report.test.ts` |
| Refuting evidence linked before approval | Done | `decision.test.ts` |
| NatSpec contradiction; "AI auditors skip" | Done | `intake.test.ts` |
| `tx.origin` / cheatcode-address branches | Flagged; replay with realistic values not automated | `intake.test.ts` |
| Fixture adds a privileged prank | Measured, not gated (Q-014); fixture overrides of target files are listed in packets | `recovery.test.ts` |
| Auditee documentation mirrors a discrepancy | Measured, not gated (Q-021): `measure_auditee_mirroring` records whether a comparison or the auditor surfaced the seeded discrepancy; no safeguard is added | `residual-risks.test.ts` |
| Method change suppresses a lead class | Measured, not gated (Q-024): the held-out comparison reports lead-class drops | `evaluation.test.ts` |
| PoC fails for an unrelated reason; High rejection attempted | Done | `decision.test.ts` |
| Mixed probe outcomes after an update | Done | `snapshot.test.ts` |
| Fix adds a function and changes inherited layout | Done | `snapshot.test.ts` |
| Export omits a deferred high-impact concern | Done | `report.test.ts` |
| Agent paraphrase of the auditor | Done | `decision.test.ts` |
| Sandboxed egress | Done | `runner.test.ts` |
| Adapter and agent-tool conformance checks | Run for `forge_build`, `forge_test` and the reference agent host (all pass), and as a compatibility trial against Claude Code 2.1.296: all five agent-tool conditions pass, condition 1 in terminal-wrapper mode (`harness agent session` captures each typed entry outside the tool before it becomes the agent's task) and condition 4 with the tool's configuration mounted read-only. See [agent-host-trial.md](agent-host-trial.md) | `runner-conformance.test.ts`, `runner-claude.test.ts` |
