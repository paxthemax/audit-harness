// Stable error codes from design/harness-interface-contracts.md, "Errors and reconciliation".

export const ERROR_CODES = {
  invalid_request: 'Correct the request',
  unsupported_contract: 'Use a supported contract version or a compatible registered adapter',
  permission_denied: 'Obtain an appropriate human decision or stop',
  grant_expired: 'Obtain a renewed work authorization',
  revision_conflict: 'Read current eligible state and review the difference',
  stale_dependency: 'Review the changed inputs and decide again',
  idempotency_conflict: 'Reconcile the earlier operation before issuing a genuinely new request',
  budget_exhausted: 'Do not dispatch new work; return completed or partial work and propose a next batch',
  review_capacity_reached: 'Finish or checkpoint admitted work; review the reconciliation packet',
  artifact_incomplete: 'Quarantine the material and supply a new artifact',
  integrity_failure: 'Quarantine the material; preserve the failure and request recovery',
  unsupported: 'Record the capability gap; choose another method under an authorized request',
  execution_failed: 'Diagnose the failed attempt; repair needs an authorized request',
  outcome_unknown: 'Preserve the reservation and reconcile before retrying',
  worker_unreachable: 'Retain the last known state; confirm termination before replacing the worker',
  stop_unconfirmed: 'Confirm termination before admitting replacement work',
  snapshot_required: 'Reload a consistent record view before acting on event-derived state',
  packet_incomplete: 'Supply the missing lists or artifacts named in the error',
  display_required: 'Present the bound revisions and the required sections (trusted screen or agent session), then decide again',
  evidence_requirement_unmet: 'Supply the evidence the disposition requires, or choose another disposition',
  egress_denied: 'The request fell outside the egress policy; nothing was sent',
  not_found: 'Check the reference',
  store_corrupt: 'Writes are stopped; restore from a verified backup',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorDetails {
  operation?: string;
  ref?: unknown;
  committed?: boolean;
  /** Structured details safe to show (never secrets or another engagement's existence). */
  details?: unknown;
}

export class HarnessError extends Error {
  readonly code: ErrorCode;
  readonly operation: string | undefined;
  readonly ref: unknown;
  readonly committed: boolean;
  readonly details: unknown;
  readonly next: string;

  constructor(code: ErrorCode, reason: string, extra: ErrorDetails = {}) {
    super(`${code}: ${reason}`);
    this.name = 'HarnessError';
    this.code = code;
    this.operation = extra.operation;
    this.ref = extra.ref;
    this.committed = extra.committed ?? false;
    this.details = extra.details;
    this.next = ERROR_CODES[code];
  }

  toJSON() {
    return {
      code: this.code,
      reason: this.message.slice(this.code.length + 2),
      operation: this.operation,
      ref: this.ref,
      committed: this.committed,
      next: this.next,
      details: this.details,
    };
  }
}

export function fail(code: ErrorCode, reason: string, extra?: ErrorDetails): never {
  throw new HarnessError(code, reason, extra);
}

export function isHarnessError(e: unknown, code?: ErrorCode): e is HarnessError {
  return e instanceof HarnessError && (code === undefined || e.code === code);
}
