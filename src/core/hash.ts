import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Serialization and hashing rules for contract version 1 (published in docs/contracts.md):
// canonical JSON = UTF-8, object keys sorted by code unit, no insignificant whitespace,
// `undefined` members dropped, non-finite numbers rejected. Digests are SHA-256, hex encoded,
// written as "sha256:<hex>".

export const HASH_ALGORITHM = 'sha256';

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : serialize(x))).join(',') + ']';
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k])).join(',') + '}';
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof v}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function digest(data: string | Uint8Array): string {
  return `${HASH_ALGORITHM}:${sha256Hex(data)}`;
}

export function digestJson(value: unknown): string {
  return digest(canonicalJson(value));
}

export function digestFile(path: string): string {
  return digest(readFileSync(path));
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function isDigest(s: unknown): s is string {
  return typeof s === 'string' && /^sha256:[0-9a-f]{64}$/.test(s);
}
