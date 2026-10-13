# Agent-host compatibility trial: Claude Code

Status: trial record, 2026-10-13. **This is not a selection.** The agent host stays an operator choice
(design/audit-harness.md; DEC-008 Q-018 asks that out-of-model capture be checked in compatibility
trials). The candidate is registered as the built-in adapter `claude_code` with version
`0-candidate`, and no engagement uses it unless an authorization lists it as a tool.

## What was tested

- **Tool:** Claude Code `2.1.296 (Claude Code)`. It is a self-contained ELF binary at
  `~/.local/share/mise/installs/claude-code/2.1.296/claude`, and its sha256 is recorded in the
  adapter descriptor.
- **No real credentials and no real provider calls.** The tool talked only to the per-attempt broker
  socket. A `FakeProvider` with scripted Messages responses answered every call. Nothing from
  `~/.claude` or any user configuration was read or mounted. `HOME` in the sandbox is an empty
  directory that is discarded after the attempt.
- **Reproduction:** `test/runner-claude.test.ts`. Both tests skip with a message when the binary is
  absent, and `HARNESS_TRIAL_REPORT=1` prints every check result.
  - "compatibility trial: Claude Code runs in the sandbox through the broker with read-only
    configuration, and its conformance is recorded" (headless). Recorded as trusted-runner
    conformance evidence with the description `compatibility trial: Claude Code 2.1.296 (Claude Code)`.
  - "compatibility trial (terminal-wrapper mode): typed input captured outside the model reaches
    Claude Code as its task". Recorded with the description
    `compatibility trial (terminal-wrapper capture): Claude Code 2.1.296 (Claude Code)`.

### How the tool is launched (`src/runner/adapters.ts`, `claudeCodeAdapter`)

The process runs inside the standard sandbox: bubblewrap with no network, and private pid, mount,
user, uts and ipc namespaces. The mounts are:

- the target read-only at `/target`;
- the scratch copy writable at `/work`;
- `/outbox` writable;
- `/context` read-only, holding the context manifest and its source views;
- `/run/harness` read-only, holding the grant token, `task.json` and `broker.sock`;
- the `claude` binary and the `node` binary, each bound read-only as a single file;
- the forwarder script under `/opt/harness/tools`;
- the tool's own configuration, **read-only** over the fresh `HOME`: `~/.claude/` (holding a
  `settings.json` with `disableAllHooks: true` and `autoMemoryEnabled: false`) and `~/.claude.json`
  (`{}`), bound from `src/runner/sandbox-tools/claude-home/`. `HOME` itself stays a writable tmpfs
  for caches and is discarded after the attempt.

The run steps are:

1. `node /opt/harness/tools/forward.mjs 8787 /run/harness/broker.sock &` starts the in-sandbox TCP
   forwarder to the broker's UNIX socket.
2. The script sets `ANTHROPIC_API_KEY` to the attempt's grant token. The broker accepts the token as
   `x-api-key` and injects the real provider credential itself. The token is valid only for this
   running attempt and is revoked when the attempt completes.
3. It launches the tool with:
   ```
   claude -p <task from task.json> --model <job model> --output-format json --bare --tools Read,Edit \
     --permission-mode acceptEdits --permission-prompts none --add-dir /outbox --add-dir /context \
     --no-session-persistence --strict-mcp-config \
     --settings '{"disableAllHooks":true,"autoMemoryEnabled":false}' \
     --append-system-prompt <outbox protocol>
   ```
4. The environment also sets `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` and the switches
   `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`,
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. Each name, and
   each settings key above, was checked against `--help` or the binary's strings. None was guessed.

**How proposals reach the controller.** The tool writes one JSON request file per proposal under
`/outbox` with its own file tool (`{"operation", "payload"}`). The controller ingests these files in
name order after the tool exits, under the attempt's worker grant, with the normal checks. The
tool's text output is kept as untrusted output in the receipt. It is never treated as evidence.

## The five agent-tool conditions

| Condition | Result | Evidence |
|---|---|---|
| 1. Input capture outside the model | **PASS in terminal-wrapper mode**; not applicable headless | **Terminal-wrapper mode** (the DEC-008 Q-018 fallback): the auditor's typed entry is recorded on the capture channel (`capture_input`, outside the sandbox and outside the model) before the job is requested. The agent job carries `{task: <the captured text>, captured_input: <Ref>}`. `request_job` refuses the job unless the record exists, came from the capture channel, predates the request, and its text equals the task exactly. The live check `typed_input_captured_outside_model` passed. It verified that the record came from the capture channel before the job, that the `task.json` the sandbox received (its digest is recorded with the evidence) holds exactly the captured text, and that the capture key is unreachable from the sandbox. **Headless mode** (`claude -p` with a controller-written task) has no typed input, so the check reports not applicable. The tool's own hooks were **not** used for capture: they stay disabled (condition 4). |
| 2. One confined instance per engagement | **PASS** | Each attempt runs in fresh pid, mount and net namespaces, distinct from each other and from the host (`one_confined_instance_per_engagement`). The runner dispatches one attempt at a time per workspace. |
| 3. Host memory off | **PASS** | `--bare` (no auto-memory and no CLAUDE.md discovery), `autoMemoryEnabled:false` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` are set. `HOME` and `/tmp` are new for every attempt and nothing carries over (`host_memory_off`). `--no-session-persistence` is set. |
| 4. No write access to its own hooks or configuration | **PASS** | `~/.claude/` (with its `settings.json`) and `~/.claude.json` are read-only bind mounts, and **Claude Code still runs `-p` end to end** through the broker with them read-only. In the first run the tool wrote `~/.claude.json` at startup. With the file read-only it still starts and completes; whether it skips that write or ignores the failure was not observed. Evidence: (a) the sandbox probe tries to create files in `~/.claude`, create `~/.claude/hooks` and append to both config files, and every write fails (`no_write_to_hooks_or_config`: "the tool's configuration is mounted read-only"); (b) in the live run, a scripted Read of `~/.claude/settings.json` was denied by the tool's permission policy, and the follow-up scripted Edit setting `disableAllHooks` to `false` was refused by the tool ("File has not been read yet") before it reached the filesystem (`own_config_write_denied`). The read-only mount is shown by (a), not by this run; (c) hooks are also disabled (`--bare`, `disableAllHooks`). The binary, forwarder, grant directory and context are read-only. Remaining caveat: other paths under `HOME` are writable, but the tool reads no configuration from them in this mode, and they are discarded after the attempt. |
| 5. Provider calls only via the provider broker, no raw provider keys | **PASS** | The sandbox has no network and no name resolution (`default_deny_egress`). No provider key is in the environment or the mounts (`provider_calls_only_via_broker`). The broker log shows only `POST /v1/messages` (`model_traffic_only_through_broker`: `3 request(s): POST /v1/messages (stream) -> 200 x3`). The provider saw only the broker's credential. Caveat: the tool holds the attempt's grant token as its API key. The token reaches only this attempt's broker and dies with the attempt. |

## Other conformance results (adapter contract)

| Check | Result | Detail |
|---|---|---|
| scoped reads and writes | PASS | Workspace, secrets and home are invisible. `/target`, `/usr` and the tool binds are read-only. |
| denied capability expansion | PASS | Re-registration and undeclared arguments are refused, and network is denied. |
| unsupported mode handling | PASS | |
| bounded resource use | PASS | Runtime and output limits are enforced. Memory uses `RLIMIT_DATA`; there is no disk quota on `/work` and no CPU-time limit. |
| cancellation | PASS | Process-group termination is confirmed. |
| duplicate delivery | PASS | A redelivered completion created no new evidence or charges. |
| ambiguous completion | NOT APPLICABLE | Exercising it needs a runner crash between staging and commit. |
| artifact provenance | PASS | The receipt names the binary's sha256, and every blob is verified. |
| portable replay | NOT APPLICABLE | Model output is not deterministic. |
| live launch | PASS | 3 turns completed and the tool exited 0. |
| streaming | PASS | See below. |
| proposals via outbox | PASS | 1 entry was written with the tool's `Edit` tool and committed. |

## What works end to end

- **Streaming.** Claude Code always sends `stream: true` to `/v1/messages?beta=true`. The broker now
  synthesizes a well-formed Messages SSE stream (`message_start`, `content_block_start`/`delta`/
  `stop`, `message_delta`, `message_stop`) from **one** non-streamed provider call. That call goes
  through every check: content validation, model and provider approval, data class, reservation,
  accounting and no retry. The tool accepted the synthesized stream, ran its tool loop and finished.
- **Request shape.** The tool's requests were accepted after the broker was extended for them:
  - text/tool_use/tool_result blocks with `cache_control`;
  - a mid-conversation `system` message carrying only `output_config: {effort}`;
  - top-level `thinking`, `output_config`, `context_management` (clearing edits only) and `metadata`;
  - `max_tokens: 128000`.
- **Content refusals.** Image, document and URL content is still refused with `egress_denied`.
- **Tool calls.** A tool_use scripted by the provider ran in the sandbox, and its tool_result came
  back in the next request.
- **Other endpoints.** None were observed. With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and
  `--bare`, the tool made only model calls: no token counting, model listing or telemetry. Any
  other endpoint would be refused with `egress_denied`, and the refusal would be listed in the
  evidence.

## Gaps (reported as found)

1. **Resolved since the first trial run: condition 4.** The first run left `HOME` writable and relied
   on the tool's own policy. The configuration is now bound read-only, and the tool still runs.
2. **Condition 1 is shown only in terminal-wrapper mode, and only at the harness boundary.** The
   wrapper (`harness agent session`, written by the CLI agent) records each entry on the capture
   channel, and the runner proves that the agent received exactly that text. An interactive session
   inside the tool, where the auditor types into Claude Code's own prompt, was **not** trialled. It
   would need the tool's hooks, which condition 4 disables.
3. **Tools in `--bare` mode.** `--bare` offers only `Bash`, `Edit` and `Read`. `--tools
   Read,Write,Edit,Glob,Grep` still yields only `Read` and `Edit`, so there is no `Write`, `Glob` or
   `Grep`, and `--restricted` removes more. Proposals are created with `Edit` and an empty
   `old_string`. Search tools are not available unless `Bash` is allowed. `Bash` would still be
   confined by the sandbox, but it is left off here.
4. **Beta headers.** The broker forwards only an allowlist of request-shaping betas. In an earlier
   probe with the default tool set, the tool also sent `dangerous-tool-use-2026-09-03` and
   `afk-mode-2026-01-31`; these would be dropped and listed. Whether a real provider accepts the
   tool's requests without them was **not** tested, because no real call is allowed.
5. **Real provider path untested.** The Anthropic adapter's mapping is tested only with an injected
   fetch. A live call with real betas, rate limits and long turns is untested.
6. **Reservations are large.** The tool asks for `max_tokens: 128000` on every turn. At the
   reservation ceiling (one input token per byte plus `max_tokens` output at the highest rate), each
   turn reserves several dollars at Opus rates, so batch budgets must allow for it. The tool's own
   `total_cost_usd` comes from its price table and is not authoritative; the harness ledger is.
7. **Request metadata.** `metadata.user_id` carries a per-run device id and a session id (random,
   because `HOME` is fresh). The broker forwards it as-is.
8. **Side models.** A longer real session may call other models for side tasks. The broker refuses
   any model the authorization does not approve, which may break those features.
9. **Streaming is synthesized, not incremental.** Clients get the whole turn at once, which is
   acceptable headless.

## What the operator still decides

- Whether Claude Code (or any other host) becomes the agent host. This trial selects nothing.
- Whether terminal-wrapper capture (one typed entry per agent job) is acceptable as the capture mode,
  or whether interactive sessions inside the tool are needed. Those would need another capture
  mechanism, because hooks stay disabled.
- The beta allowlist, the `max_tokens` cap and the reservation policy for a real provider, and a
  real-provider trial run under an approved data policy.
- Whether `Bash` is offered inside the sandbox, and which tool set agents get.
