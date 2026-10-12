// A small JSON Schema (draft 2020-12 subset) builder and validator. Record schemas are
// declared with these helpers, exported as plain JSON Schema documents (`harness schemas`),
// and enforced by the store before any record is committed.
//
// Supported keywords: type, enum, const, properties, required, additionalProperties (boolean),
// items, anyOf, pattern, minLength, minimum, minItems, description, $id, title.

export type Schema = {
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  anyOf?: Schema[];
  pattern?: string;
  minLength?: number;
  minimum?: number;
  minItems?: number;
  description?: string;
  $id?: string;
  title?: string;
};

export const str = (opts: { minLength?: number; pattern?: string; description?: string } = {}): Schema => ({
  type: 'string',
  ...opts,
});
export const text = (description?: string): Schema => ({ type: 'string', minLength: 1, ...(description ? { description } : {}) });
export const int = (minimum?: number): Schema => ({ type: 'integer', ...(minimum !== undefined ? { minimum } : {}) });
export const num = (minimum?: number): Schema => ({ type: 'number', ...(minimum !== undefined ? { minimum } : {}) });
export const bool = (): Schema => ({ type: 'boolean' });
export const nul = (): Schema => ({ type: 'null' });
export const oneOfValues = (values: readonly string[], description?: string): Schema => ({
  type: 'string',
  enum: values,
  ...(description ? { description } : {}),
});
export const literal = (value: string): Schema => ({ const: value });
export const arr = (items: Schema, minItems?: number): Schema => ({
  type: 'array',
  items,
  ...(minItems !== undefined ? { minItems } : {}),
});
export const any = (...schemas: Schema[]): Schema => ({ anyOf: schemas });
export const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: 'null' }] });
/** Open object: unknown members are permitted (used for tool-specific payloads only). */
export const openObj = (description?: string): Schema => ({ type: 'object', ...(description ? { description } : {}) });

/**
 * Closed object. Keys ending in `?` are optional; all others are required.
 */
export function obj(shape: Record<string, Schema>, description?: string): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const [rawKey, s] of Object.entries(shape)) {
    const optional = rawKey.endsWith('?');
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    properties[key] = s;
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: false, ...(description ? { description } : {}) };
}

/** Explicit unknown: "Unknown values are explicit with a reason; they do not become invented defaults." */
export function unknownOr(s: Schema): Schema {
  return any(s, obj({ unknown: { const: true }, reason: text() }));
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validate(schema: Schema, value: unknown, path = '$'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  check(schema, value, path, issues);
  return issues;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function check(s: Schema, v: unknown, path: string, out: ValidationIssue[]): void {
  if (s.anyOf) {
    const ok = s.anyOf.some((alt) => validate(alt, v, path).length === 0);
    if (!ok) {
      // Report the issues of the closest alternative to keep messages useful.
      const best = s.anyOf
        .map((alt) => validate(alt, v, path))
        .sort((a, b) => a.length - b.length)[0];
      out.push(...(best ?? [{ path, message: 'no alternative matched' }]));
    }
    return;
  }
  if (s.const !== undefined && v !== s.const) {
    out.push({ path, message: `expected constant ${JSON.stringify(s.const)}` });
    return;
  }
  if (s.type) {
    const t = typeOf(v);
    const matches = t === s.type || (s.type === 'number' && t === 'integer');
    if (!matches) {
      out.push({ path, message: `expected ${s.type}, got ${t}` });
      return;
    }
  }
  if (s.enum && !s.enum.includes(v)) {
    out.push({ path, message: `value ${JSON.stringify(v)} not in [${s.enum.join(', ')}]` });
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) out.push({ path, message: `shorter than ${s.minLength}` });
    if (s.pattern && !new RegExp(s.pattern).test(v)) out.push({ path, message: `does not match ${s.pattern}` });
  }
  if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) {
    out.push({ path, message: `below minimum ${s.minimum}` });
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push({ path, message: `fewer than ${s.minItems} items` });
    if (s.items) v.forEach((item, i) => check(s.items!, item, `${path}[${i}]`, out));
  }
  if (s.type === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const req of s.required ?? []) {
      if (!(req in o) || o[req] === undefined) out.push({ path: `${path}.${req}`, message: 'required' });
    }
    for (const [k, val] of Object.entries(o)) {
      const ps = s.properties?.[k];
      if (ps) check(ps, val, `${path}.${k}`, out);
      else if (s.additionalProperties === false) out.push({ path: `${path}.${k}`, message: 'unexpected member' });
    }
  }
}
