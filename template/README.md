# Audit

An audit run with the [audit harness](harness/README.md). `harness/` pins the framework; `audit.json` names the code under audit and the engagements that audit it.

## Start

```sh
git clone --recurse-submodules <this repository> && cd <it>     # or: git submodule update --init --recursive
mise trust && mise install                                       # Node 25, Foundry; puts bin/ on PATH
bin/audit setup                                                  # workspace, target checkouts, engagements, first snapshots
bin/audit status                                                 # read-only checks, each failure with its fix
```

The first time, add what is audited:

```sh
bin/audit target add vault https://github.com/acme/vault.git --ref v1.2.0          # submodule at targets/vault
bin/audit engagement add vault-core --target vault --root contracts \
  --name "Vault core" --owner "<auditor>" --purpose "pre-launch review"
bin/audit setup
git commit -am "Pin the audit target"
```

Requirements: Linux with `bwrap`, Git, Foundry with the needed compilers in the `svm` cache (the sandbox has no network).

## Working

Start Claude Code or omp here. `.mcp.json` runs the harness MCP server against `workspace/`; ask the agent what needs deciding. `AGENTS.md` holds the rules agents follow in this repository. To record your typed prompts as captured input, merge the output of `bin/audit hook -e <engagement>` into your user settings.

The harness CLI is `bin/harness` (`harness` on PATH under mise). See `harness/docs/cli.md` for the workflow and `harness/docs/audit-repo.md` for targets, pins and snapshots.

## What is committed

`audit.json`, the target and framework pins, `inputs/` and `work/`. `workspace/` is not: each engagement store under `workspace/engagements/` is its own git repository; back it up by adding a remote there.
