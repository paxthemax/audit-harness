# Audit harness framework

This repository implements the audit harness. The design spec lives in `../framework-design-lab/`; read the relevant design and decision records there before implementing a mechanism. Consequential mechanism changes and the open choices (store, runner, model provider, sandbox, agent host, numeric limits) belong to the operator.

## Memory

- Project memory is the isolated PLUR store at `memory/plur/`. Follow `memory/plur/README.md` for the workflow.
- Tools come from `mise.toml`. Its `[env]` points `PLUR_PATH` at the store and disables discovery. `.mcp.json` provides the `plur` MCP server.
- At session start, call `plur_session_start` (no hooks are installed) and open the grounding documents for consequential memories. At the end, call `plur_session_end`.
- Learn useful source-backed lessons automatically with `scope: project:framework`, and review or correct them periodically. If PLUR is unavailable, edit the YAML files directly and say that retrieval was manual.
- Never put client audit data or harness engagement state in this store.
