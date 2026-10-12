// References identify an exact record revision or artifact hash (design/harness-interface-contracts.md,
// "Contract conventions"). An ID without a revision can find the current record but cannot bind an
// approval or an execution input.

export interface Ref {
  record_id: string;
  revision: number;
  /** Present only when the reference leaves its engagement (cross-engagement refs grant nothing). */
  scope?: string;
}

export interface ArtifactRef {
  artifact: string; // "sha256:<hex>"
}

export type AnyRef = Ref | ArtifactRef;

/** Explicit unknown value with a reason. */
export interface Unknown {
  unknown: true;
  reason: string;
}

export type UnknownOr<T> = T | Unknown;

export function isUnknown(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && (v as Unknown).unknown === true;
}

export function ref(record_id: string, revision: number): Ref {
  return { record_id, revision };
}

export function isArtifactRef(r: AnyRef): r is ArtifactRef {
  return 'artifact' in r;
}

export function refKey(r: AnyRef): string {
  return isArtifactRef(r) ? r.artifact : `${r.scope ? r.scope + '/' : ''}${r.record_id}@${r.revision}`;
}

export function sameRef(a: Ref, b: Ref): boolean {
  return a.record_id === b.record_id && a.revision === b.revision && (a.scope ?? '') === (b.scope ?? '');
}

export function unknown(reason: string): Unknown {
  return { unknown: true, reason };
}
