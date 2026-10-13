import { spawnSync } from 'node:child_process';
import { fail, HarnessError } from '../core/errors.ts';
import { randomToken } from '../core/hash.ts';
import type { Ref } from '../core/refs.ts';
import type { Controller } from '../controller/controller.ts';
import type { Workspace } from '../controller/workspace.ts';
import { InputClosed, type ScreenIO } from '../screen/io.ts';
import { captureText, openCaptureChannel, type CapturePurpose } from './capture.ts';

// `harness capture`: a terminal wrapper that records what the auditor types, verbatim, before it goes
// anywhere else (DEC-008 Q-018 fallback when an agent host offers no hook). It reads only from an
// interactive terminal. Optionally each captured entry is then piped to an agent-tool command
// (`-- <argv>`, e.g. a non-interactive agent CLI invocation); an entry whose capture failed is NOT
// forwarded, so nothing reaches the agent that the record lacks.

export const WRAPPER_CHANNEL_NAME = 'harness-capture-wrapper';

export interface CaptureWrapperOptions {
  ws: Workspace;
  engagement: string;
  io: ScreenIO;
  purpose: CapturePurpose;
  audit_unit: Ref | null;
  /** Capture one multi-line entry and exit (default for the expectations pre-step and notes). */
  once: boolean;
  /** Agent-tool command each captured entry is piped to on stdin. */
  forward: string[] | null;
  key?: string;
  controller?: Controller;
}

export async function runCaptureWrapper(o: CaptureWrapperOptions): Promise<Ref[]> {
  if (!o.io.interactive) fail('permission_denied', 'harness capture records typed input and needs an interactive terminal; it refuses pipes and scripts');
  const channel = openCaptureChannel({ ws: o.ws, name: WRAPPER_CHANNEL_NAME, session: `wrapper-${randomToken(8)}`, key: o.key, controller: o.controller });
  const io = o.io;
  const captured: Ref[] = [];
  const record = (text: string): boolean => {
    try {
      const ref = captureText(channel, { engagement: o.engagement, text, purpose: o.purpose, audit_unit: o.audit_unit });
      captured.push(ref);
      io.write(`[captured ${ref.record_id}]\n`);
      return true;
    } catch (e) {
      if (!(e instanceof HarnessError)) throw e;
      io.write(`[NOT captured: ${e.code}: ${e.message.slice(e.code.length + 2)}; nothing was forwarded]\n`);
      return false;
    }
  };
  const forward = (text: string) => {
    if (!o.forward?.length) return;
    const r = spawnSync(o.forward[0], o.forward.slice(1), { input: text, stdio: ['pipe', 'inherit', 'inherit'] });
    if (r.error) io.write(`[forward failed: ${r.error.message}]\n`);
  };

  io.write(`Capture channel for engagement ${o.engagement} (purpose ${o.purpose}${o.audit_unit ? `, unit ${o.audit_unit.record_id}@${o.audit_unit.revision}` : ''}).\n`);
  io.write('Everything you enter is recorded verbatim as your own words before anything else sees it.\n');
  if (o.once) {
    if (o.purpose === 'expectations_pre_step') {
      io.write('Expectations pre-step (optional): what should happen in this flow, and what must never happen?\n');
    }
    const text = await io.edit('Your input', '');
    if (!text.length) {
      io.write('Nothing entered; nothing captured.\n');
      return captured;
    }
    if (record(text)) forward(text);
    return captured;
  }
  io.write('One line per entry. "/multi" enters a multi-line entry; "/quit" ends.\n');
  for (;;) {
    let line: string;
    try {
      line = await io.ask('you> ');
    } catch (e) {
      if (e instanceof InputClosed) break;
      throw e;
    }
    if (line === '/quit') break;
    let text = line;
    if (line === '/multi') text = await io.edit('Multi-line entry', '');
    if (!text.length) continue;
    if (record(text)) forward(text);
  }
  return captured;
}
