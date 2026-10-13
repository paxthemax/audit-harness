import { isHarnessError } from '../core/errors.ts';
import type { Controller } from '../controller/controller.ts';
import type { Workspace } from '../controller/workspace.ts';
import { captureText, openCaptureChannel } from './capture.ts';

// Claude Code `UserPromptSubmit` hook adapter (agent host is an open operator choice; this is one
// candidate adapter, the terminal wrapper is the fallback per DEC-008 Q-018).
//
// Contract verified against the Claude Code hooks reference (code.claude.com/docs/en/hooks, read
// 2026-10-12): the hook receives JSON on stdin with the common fields (`session_id`, `prompt_id`,
// `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, ...) and `prompt`, the submitted
// text (collapsed pastes arrive expanded, possibly between `<pasted_content>` marker lines, which are
// recorded verbatim as received). On exit 0, plain stdout is ADDED TO THE MODEL'S CONTEXT and a JSON
// stdout can block the prompt; exit 2 blocks the prompt. This adapter therefore never writes to
// stdout, always exits 0, and reports failures on stderr only, so it never blocks or alters the
// prompt. UserPromptSubmit takes no matcher; its default timeout is 30 seconds.

export const HOOK_CHANNEL_NAME = 'claude-code-userpromptsubmit';

export interface HookInput {
  session_id?: string;
  prompt_id?: string;
  hook_event_name?: string;
  prompt?: unknown;
  [k: string]: unknown;
}

export interface CaptureHookOptions {
  ws: Workspace;
  engagement: string;
  /** Raw stdin text. */
  input: string;
  /** Where failures are reported (stderr). Never stdout. */
  log: (s: string) => void;
  key?: string;
  controller?: Controller;
}

/** Record the submitted prompt verbatim. Resolves to the process exit code, which is always 0. */
export function runCaptureHook(o: CaptureHookOptions): 0 {
  try {
    let h: HookInput;
    try {
      h = JSON.parse(o.input) as HookInput;
    } catch {
      o.log('harness capture-hook: stdin is not JSON; nothing captured\n');
      return 0;
    }
    if (h.hook_event_name !== undefined && h.hook_event_name !== 'UserPromptSubmit') {
      o.log(`harness capture-hook: ignoring ${String(h.hook_event_name)} event; nothing captured\n`);
      return 0;
    }
    if (typeof h.prompt !== 'string') {
      o.log('harness capture-hook: hook input has no string "prompt"; nothing captured\n');
      return 0;
    }
    const session = `claude-code:${typeof h.session_id === 'string' ? h.session_id : 'unknown-session'}`;
    const channel = openCaptureChannel({ ws: o.ws, name: HOOK_CHANNEL_NAME, session, key: o.key, controller: o.controller });
    captureText(channel, {
      engagement: o.engagement,
      text: h.prompt,
      purpose: 'conversation',
      idempotency_key: typeof h.prompt_id === 'string' ? `claude-code:${h.session_id ?? ''}:${h.prompt_id}` : undefined,
    });
  } catch (e) {
    const what = isHarnessError(e) ? `${e.code}: ${e.message.slice(e.code.length + 2)}` : String((e as Error)?.message ?? e);
    o.log(`harness capture-hook: capture FAILED, the prompt was not recorded (${what})\n`);
  }
  return 0;
}
