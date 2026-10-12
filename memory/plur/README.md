# PLUR store guide

This directory is the **isolated, repository-local PLUR store** for developing the audit harness framework. It follows the design lab's memory policy ([DEC-001](../../../framework-design-lab/decisions/DEC-001-knowledge-and-memory.md), [specification](../../../framework-design-lab/design/knowledge-and-memory.md)), which the operator selected for this repository on 2026-10-12.

It is development memory only. It is **not** the harness's operational, engagement, or evidence store, and it must never hold client audit data ([state design](../../../framework-design-lab/design/harness-state-and-execution.md)).

## Files

- `config.yaml`: YAML backend, keyword retrieval (embeddings off), automatic learning and capture, no secondary stores, 2,000-token injection budget.
- `engrams.yaml`: standing lessons under a top-level `engrams:` mapping. PLUR 0.21.5 rejects the design lab's bare top-level list.
- `episodes.yaml`: timestamped events that actually occurred, with source paths in the summaries.
- `history/`: PLUR observational and lifecycle events (JSONL). Keep it with the store.
- `backups/`, `packs/`, and other runtime files are local only. `.gitignore` allowlists the portable files and history.

Each engram carries `knowledge_anchors.path`, relative to the repository root. Anchors under `../framework-design-lab/` point at the design spec. Repository metadata lives under `structured_data.framework` (`record_ids`, `review_status`, `authority`, `approved_by`, `approved_on`, `stale_if`). This is a convention: PLUR stores the fields but does not enforce them.

## Engine and wiring

- `mise.toml` pins `@plur-ai/cli` and `@plur-ai/mcp` at 0.21.5. They are below mise's download-count threshold, so `allow_low_downloads` was set after checking that both packages point to `github.com/plur-ai/plur`.
- `mise.toml` `[env]` sets `PLUR_PATH` to this directory and `PLUR_AUTO_DISCOVER=0`. Inside the mise environment the CLI and MCP open only this store; `~/.plur` is not created.
- `.mcp.json` starts `plur-mcp` through `mise exec`, so Claude Code uses this store when it runs from the repository root.
- No `plur init`, global hooks, folder-trust grants, remotes, or sync are configured. The MCP server's built-in instructions describe a global `~/.plur` store; this repository overrides that.

```bash
mise install                         # once
plur status                          # storage_root must be this directory
plur --fast inject '<task>' --budget 2000 --no-with-default-protocol
plur recall '<query>'
plur timeline
```

Run these from the repository root with mise activated, or prefix them with `mise exec --`.

## Session workflow

1. **Start:** read `AGENTS.md`, then call MCP `plur_session_start` (no hooks are installed) or run `inject` for the task. For any consequential remembered statement, open its grounding document.
2. **During work:** automatically record reusable, source-backed lessons, corrections, and conventions. Use `status: active` and `commitment: leaning`. Set `review_status: unreviewed` and leave the approval fields null. Use `commitment: draft` to quarantine records with incomplete grounding or disputed claims. Always pass `scope: project:framework`.
3. **End or milestone:** call `plur_session_end` or `plur capture` with what actually happened and the paths involved. Briefly review memory after corrections or contradictions.

MCP `plur_learn` does not accept `knowledge_anchors` or `structured_data`. After learning a record through MCP, add its anchors and metadata to the YAML file directly while no PLUR writer is running. Until then, keep the record as `draft`.

Remembering "the design recommends X" needs no approval. Recording "the operator chose X" requires an actual operator decision. Activation, feedback, and recurrence never count as approval.

## Review, correction, and recovery

- Stop PLUR writers (MCP sessions) before hand-editing YAML. Preserve unrelated records. Re-read the file, or run `plur list`, to confirm an edit landed.
- The engine rewrites `engrams.yaml` on access: it adds counters, reflows text, and drops comments. Keep explanations in this README, not in YAML comments.
- To correct a memory, revise or retire it while keeping its rationale, and record an episode about the change.
- If YAML is malformed, PLUR refuses to read it instead of treating the store as empty. Preserve the damaged file and restore it from git or `backups/`. An empty store does not repair an unreadable one.
- The `project:` scope makes PLUR report that the scope is shared. With no remote registered, delivery stays local. Do not register a remote or sync destination until the operator chooses one. A `private` visibility does not protect files that are committed or uploaded.
