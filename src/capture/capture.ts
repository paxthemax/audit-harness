import { randomToken } from '../core/hash.ts';
import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { Controller, type Session } from '../controller/controller.ts';
import type { Workspace } from '../controller/workspace.ts';
import { captureProgramDigest } from './program.ts';

// The capture channel (DEC-008 Q-018; design/harness-interface-contracts.md, "Agent tool to capture
// channel"): the auditor's typed input is recorded verbatim through `capture_input`. The channel is
// authenticated by the capture key, which this process reads from the workspace secrets. The process
// runs OUTSIDE the agent tool's confinement; the agent tool must not be able to read the key, run
// this program with altered code, or write its hooks/configuration (docs/cli.md lists the conditions
// to verify). The channel identity is the wrapper/hook name plus the digest of the capture program
// files; the controller stamps the capture time and content digest.

export type CapturePurpose = 'conversation' | 'expectations_pre_step' | 'clarification_answer' | 'note';
export const CAPTURE_PURPOSES: readonly CapturePurpose[] = ['conversation', 'expectations_pre_step', 'clarification_answer', 'note'];

export interface CaptureChannelOptions {
  ws: Workspace;
  /** Channel name, e.g. `harness-capture-wrapper` or `claude-code-userpromptsubmit`. */
  name: string;
  /** Host session identifier (agent-tool session or wrapper run). */
  session?: string;
  /** Key override (tests); by default read from `<ws>/secrets/capture.key`. */
  key?: string;
  controller?: Controller;
}

export function openCaptureChannel(o: CaptureChannelOptions): Session {
  const key = o.key ?? o.ws.readSecret('capture.key');
  const controller = o.controller ?? new Controller(o.ws);
  return controller.capture(key, o.name, captureProgramDigest(), o.session ?? `capture-${randomToken(8)}`);
}

export interface CaptureRequest {
  engagement: string;
  text: string;
  purpose?: CapturePurpose;
  audit_unit?: Ref | null;
  /** Idempotency key so a retried hook delivery records once. */
  idempotency_key?: string;
}

/** Record one verbatim input. The text is passed through unchanged (no trimming or normalization). */
export function captureText(channel: Session, r: CaptureRequest): Ref {
  if (typeof r.text !== 'string') fail('invalid_request', 'captured text must be a string');
  if (r.purpose && !CAPTURE_PURPOSES.includes(r.purpose)) fail('invalid_request', `purpose must be one of ${CAPTURE_PURPOSES.join(', ')}`);
  const payload: Record<string, unknown> = { text: r.text };
  if (r.purpose) payload.purpose = r.purpose;
  if (r.audit_unit) payload.audit_unit = r.audit_unit;
  return channel.call(r.engagement, 'capture_input', payload, r.idempotency_key ? { idempotency_key: r.idempotency_key } : {}).result.captured_input;
}

/** Resolve an audit unit id (optionally `id@rev`) to an exact revision through the capture channel's view. */
export function unitRef(ws: Workspace, engagement: string, spec: string): Ref {
  const [id, rev] = spec.split('@');
  const store = ws.store(engagement, true);
  if (rev) return { record_id: id, revision: Number(rev) };
  const h = store.mustHead(id, 'audit_unit');
  return { record_id: h.record_id, revision: h.revision };
}
