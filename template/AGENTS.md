# Audit repository

This repository is one audit run with the audit harness. The auditor leads it; agents investigate, test and present, and the auditor decides what becomes a finding.

| Path | What it is | Who changes it |
|---|---|---|
| `audit.json` | Targets (code under audit, pinned to a commit) and engagements (one per snapshot root) | `bin/audit` |
| `targets/<name>/` | Target checkouts at their pinned commits | `bin/audit target …` only |
| `harness/` | The harness framework, pinned | Framework releases only |
| `workspace/` | Harness state: engagement record stores, evidence archive, keys (not committed) | Harness commands only |
| `inputs/` | Auditor-authored inputs: policy drafts, yolo charters, deployment payloads | The auditor, or agents at the auditor's request |
| `work/` | Scratch: PoC tests, notes, diagrams before they are proposed to the harness | Anyone |

## Start of session

Run `bin/audit status`. Every FAIL line carries its fix; resolve them before other work. Then `bin/harness status -e <engagement>` (or the `harness_overview` MCP tool) shows decisions needed, running work and gaps.

## Working rules

- **Pinned code is the evidence.** Read targets freely; change what is audited only by moving a pin: `bin/audit target pin <name> <ref>`, then `bin/audit snapshot <engagement>`. The harness diffs the new snapshot and reopens the conclusions it affects.
- **Run target code through the harness** — `bin/harness exec`, harness jobs, agent runs. They execute in the bubblewrap sandbox against the frozen snapshot and produce receipts. Running `forge test` or scripts directly in `targets/` executes untrusted code on the host and produces no evidence.
- **Experiments live in `work/`.** Mirror the snapshot root's layout (`work/poc/test/Exploit.t.sol`) and submit with `bin/harness fixture submit -e <engagement> --investigation inv-N --root work/poc test/Exploit.t.sol`; the harness overlays it onto the snapshot in the sandbox and warns when it overrides a target file.
- **Harness state changes through harness commands**, so every write is a controller operation with an audit trail. Read records with `bin/harness records` and `bin/harness show`.
- **Decisions belong to the auditor.** Present and record them through the `harness` MCP tools, following the server's instructions.
- **`harness/` is the framework, consumed as is.** Its `AGENTS.md` and memory store are for developing the framework; keep audit data out of them. Report a framework bug to the auditor with the failing command and output.
- **Parse `--json` output** from `bin/audit` and `bin/harness`. Exit codes: 0 ok, 1 failed, 2 usage error; the harness adds 3–5 for refusals (`bin/harness help`).

## Reference

- `bin/audit help`, `bin/harness help`: every command.
- `harness/docs/audit-repo.md`: targets, pins, engagements and snapshots in this repository layout.
- `harness/docs/cli.md`: the auditor's workflow stage by stage (scope and policy, work, investigations, packets, reports).
- `harness/docs/agent-review.md`: presenting and recording decisions through an agent.
