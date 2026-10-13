# Audit harness framework

This repository implements the audit harness. The design spec lives in `../framework-design-lab/`; read the relevant design and decision records there before implementing a mechanism. Consequential mechanism changes and the open choices (store, runner, model provider, sandbox, agent host, numeric limits) belong to the operator.

## Memory

- Project memory is the isolated PLUR store at `memory/plur/`. Follow `memory/plur/README.md` for the workflow.
- Tools come from `mise.toml`. Its `[env]` points `PLUR_PATH` at the store and disables discovery. `.mcp.json` provides the `plur` MCP server.
- At session start, call `plur_session_start` (no hooks are installed) and open the grounding documents for consequential memories. At the end, call `plur_session_end`.
- Learn useful source-backed lessons automatically with `scope: project:framework`, and review or correct them periodically. If PLUR is unavailable, edit the YAML files directly and say that retrieval was manual.
- Never put client audit data or harness engagement state in this store.

## Building and testing

- TypeScript runs directly on Node 25 through type stripping: use only erasable syntax (no enums, parameter properties or namespaces), import with explicit `.ts` extensions, and keep runtime dependencies at zero.
- `npm test` runs every `node:test` suite; `npm run typecheck` runs `tsc`. Execution tests need `bwrap` and `forge` with cached compilers; the sandbox has no network.
- Every write goes through a controller operation (`defineOperation`) that stages records with `ctx.tx` and commits them atomically. Never write records or archive blobs directly outside tests.
- `depends_on` holds only material inputs; parent links live in record bodies. Decisions go stale when a reviewed record or one of its direct inputs gets a newer revision.
- Open operator choices and implementation defaults are listed in `docs/operator-choices.md`; update it when a default changes.
