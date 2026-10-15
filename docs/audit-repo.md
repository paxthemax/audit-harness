# Audit repositories

An audit runs in its own repository, not in a clone of this framework. The audit repository pins the framework as a submodule, records the code under audit and the engagements that audit it in `audit.json`, and keeps the harness workspace beside them. `bin/audit` (the code is in `src/auditrepo/`) creates and maintains that layout, so an auditor or an agent can rebuild the same checkout from a fresh clone with one command.

```
acme-audit/
  audit.json            targets and engagements (committed)
  harness/              this framework, a submodule pinned to a commit
  targets/<name>/       code under audit, pinned to a commit
  workspace/            harness workspace: engagement stores, archive, keys (ignored)
  inputs/               auditor-authored inputs: policy drafts, yolo charters, deployment payloads
  work/                 scratch: PoC tests before they become fixtures
  bin/audit, bin/harness   launchers for the pinned framework (harness defaults to workspace/)
  AGENTS.md, CLAUDE.md, .mcp.json, .claude/settings.json, mise.toml
```

The files come from [`template/`](../template/). Its `AGENTS.md` holds the rules agents follow in an audit repository.

## Creating one

From this framework:

```sh
bin/audit new ../audits/acme                         # framework pinned to this checkout's HEAD, from its origin remote
bin/audit new ../audits/acme --framework-ref v0.2.0  # another commit or tag
bin/audit new ../audits/acme --link-framework        # development: harness/ links to this checkout, uncommitted
```

`new` stages the scaffold in a fresh git repository and does not commit. A pinned framework commit must be pushed to the remote the submodule points at before anyone else can clone the audit. `--link-framework` uses this working tree as is, uncommitted changes included, and `bin/audit status` warns that the result cannot be reproduced from the pin.

`bin/audit framework pin [<ref>]` moves the framework pin of an existing audit repository: it fetches, checks out the ref (by default the remote's default branch) and stages the new gitlink for you to commit after reading the framework's changelog for the range. It reports whether the move is a fast-forward, and refuses a linked framework or one with local changes. `bin/audit status` fails when `harness/` is not at the commit the audit repository pins.

To work from a shared template instead, create one once with `bin/audit new`, commit and push it, then for each audit clone it with `--recurse-submodules` and point `origin` at the audit's own remote.

## Targets

A target is a git repository pinned to a full commit in `audit.json`. Three modes cover the usual ways to hold the code:

| Mode | Where | Pinned by | Use for |
|---|---|---|---|
| `submodule` (default) | `targets/<name>`, committed as a gitlink | The gitlink and `audit.json` (checked to agree) | Most audits: the audit repository alone reproduces the code |
| `clone` | `targets/<name>`, added to `.gitignore` | `audit.json` | Targets you must not record in the audit repository's history, such as a client remote the audit repository's readers cannot reach |
| `path` | An existing checkout anywhere, stored relative to the audit repository | `audit.json`; the tool never clones or moves it | A checkout you manage yourself, e.g. a packaging repository you already cloned |

```sh
bin/audit target add vault https://github.com/acme/vault.git --ref v1.2.0
bin/audit target add vault git@github.com:acme/vault.git --mode clone --ref main
bin/audit target add mento ../../yborg-mento-v3-shadow-audit --mode path
```

`--ref` takes a branch, tag or commit; without it the remote's default branch is pinned. The target's own submodules (Foundry `lib/`, or the sources of a packaging repository) are brought to the commits it pins, recursively. Git runs with the user's configuration, so private remotes use the user's credentials, and with hooks disabled.

`bin/audit target pin <name> [<ref>]` fetches and moves a pin (without a ref it refetches the recorded one). A pin move does not touch the harness: the engagements on that target keep their active snapshots until `bin/audit snapshot` registers new ones, and `bin/audit status` warns until then.

## Engagements and snapshots

A harness engagement has one active snapshot, so each audited Foundry project gets its own engagement. `--root` names the project directory inside the target; one target can feed several engagements:

```sh
bin/audit engagement add mento-core --target mento --root sources/mento-core --name "Mento V3 core" --owner me --purpose "shadow audit"
bin/audit engagement add mento-bold --target mento --root sources/bold/contracts --name "Mento BOLD" --owner me --purpose "shadow audit"
```

`bin/audit snapshot [<id> ...]` registers a snapshot of each engagement's root with the label `<target>/<root>@<commit>`. It refuses when the target is not at its pin, or the root has uncommitted changes or nested submodules off their pins, because the snapshot would then not be the pinned code. `--allow-dirty` freezes the working tree as it is, and the harness records the dirty files. An engagement whose active snapshot already freezes the current commit is skipped unless `--force` is given. `--payload` passes deployment, fork and upstream data through to `harness snapshot register`.

Registration and every other harness write go through the harness CLI in process, so they are controller operations like any other command. A new snapshot still needs its `forge_build` job before agents and tests use it.

## Setup and status

`bin/audit setup` reconciles the repository with `audit.json`, and every step is idempotent:

1. initialize `workspace/` (`harness init`) if it does not exist;
2. bring each submodule and clone target to its pin, fetching it if it is missing; a target with local changes that is off its pin is reported, not overwritten; a path target is only checked;
3. create each engagement missing from the workspace;
4. register the first snapshot of each engagement that has none. Later snapshots are registered only by `bin/audit snapshot`, because a new active snapshot reopens conclusions.

`bin/audit status` is read-only. It checks Node, `bwrap`, `forge`, the framework commit (and its uncommitted changes), the workspace, each target against its pin and each engagement's active snapshot against the code, and prints a fix command for each failure. It exits 1 when anything fails. Both commands take `--json`.

## Agents in an audit repository

- `.mcp.json` runs `bin/harness mcp` on `workspace/`; `.claude/settings.json` enables it and denies agent edits to `targets/`, `harness/` and `workspace/`, and reads of `workspace/secrets/`. These rules live in the repository, so an agent with shell access can still change them; they are guard rails, not a boundary. The boundary is the harness: target code runs only in its sandbox, against frozen snapshots.
- `bin/audit hook -e <id>` prints the Claude Code `UserPromptSubmit` hook that records the auditor's typed prompts as captured input. Install it in user settings, where an agent working in the repository cannot edit it ([cli.md](cli.md)). User settings apply to every session, so the command is guarded: it records only when the session's project directory (`CLAUDE_PROJECT_DIR`) is the audit repository or below it, and exits 0 without recording anywhere else. It runs the pinned framework through `mise exec` from the repository, so it needs `mise trust` there, and gets the repository's Node whatever `PATH` Claude Code started with. Claude Code reads hooks when a session starts.
- The framework's PLUR store is development memory for this repository; an audit repository does not configure it, and audit data stays out of it.
