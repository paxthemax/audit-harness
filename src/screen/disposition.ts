import { fail } from '../core/errors.ts';
import { isArtifactRef, refKey, type AnyRef, type Ref } from '../core/refs.ts';
import {
  DISPOSITIONS,
  POTENTIAL_IMPACTS,
  effectiveImpact,
  impactRank,
  isHighOrCritical,
  isMediumOrAbove,
  type Disposition,
  type PotentialImpact,
} from '../core/values.ts';
import { askList, askUntil, choose, show, type ScreenIO } from './io.ts';

// Disposition inputs per the glossary's disposition table (design/harness-glossary.md, "Dispositions
// and evidence"). The screen asks for exactly what each disposition requires, for the main claim and
// separately for each linked claim with its own potential impact; an agent session submits the same
// fields, checked against the same table (`DISPOSITION_FIELDS`); the controller enforces the glossary
// table when the decision is committed. There is no bulk path: every claim is decided on its own.

export interface NumberedRef {
  n: number;
  ref: AnyRef;
  label: string;
}

export interface DispositionTarget {
  /** "main claim" or "linked claim <id> (<guarantee>)". */
  label: string;
  /** Linked-claim id, or null for the main claim. */
  linked_claim_id: string | null;
  agent_impact: PotentialImpact | null;
  auditor_impact: PotentialImpact | null;
  executable: boolean;
  /** References shown on the screen, selectable by number. */
  refs: NumberedRef[];
  replay_status: string;
  variants: Ref[];
  method: string;
  prerequisites: string[];
  anchor_count: number;
  /** Guarantee of a linked claim (the finding's guarantee when accepted). */
  guarantee: string | null;
}

export interface ImpactInput {
  auditor: PotentialImpact | null;
  auditor_lower_reason: string | null;
  effective: PotentialImpact;
}

/**
 * One claim's disposition inputs, in the shape `dispose_investigation` takes (src/decision/kinds.ts,
 * `DispositionInputs`): the auditor's potential-impact estimate plus the fields the disposition needs.
 */
export interface DispositionInput {
  disposition: Disposition;
  /** The auditor's estimate (null = leave the agent's); below the agent's needs `impact_lower_reason`. */
  potential_impact: PotentialImpact | null;
  impact_lower_reason: string | null;
  [field: string]: unknown;
}

/** What each disposition requires, as shown beside the choice. */
export const DISPOSITION_HELP: Record<Disposition, string> = {
  accepted: 'claim established: severity + the evidence route the potential impact requires',
  rejected: 'claim refuted: decisive evidence, countercondition and scope; High/Critical executable claims also need a positive control that shows the violation',
  no_finding_within_bounds: 'examined, no supported claim: methods, variants, budget, attacker charter, assumptions (never a refutation)',
  triaged_out: 'potential impact low/info confirmed: one-line reason; listed in an appendix, supports no assurance claim',
  disputed: 'competing interpretations and what would distinguish them',
  deferred: 'work stops while the concern stands: residual concern and revisit condition',
};

/** Parse "1,3" (screen numbers) or "ev-0001@2" references. */
export function parseRefs(input: string, refs: NumberedRef[]): { refs: AnyRef[]; problem: string | null } {
  const out: AnyRef[] = [];
  for (const tok of input.split(/[\s,]+/).filter(Boolean)) {
    if (/^\d+$/.test(tok)) {
      const e = refs.find((r) => r.n === Number(tok));
      if (!e) return { refs: [], problem: `no reference numbered ${tok} on this screen` };
      out.push(e.ref);
    } else if (/^[a-z]+-\d+@\d+$/.test(tok)) {
      const [id, rev] = tok.split('@');
      out.push({ record_id: id, revision: Number(rev) });
    } else if (/^sha256:[0-9a-f]{64}$/.test(tok)) {
      out.push({ artifact: tok });
    } else return { refs: [], problem: `"${tok}" is neither a screen number, an id@revision nor an artifact digest` };
  }
  return { refs: out, problem: null };
}

async function askRefs(io: ScreenIO, prompt: string, refs: NumberedRef[], required: boolean): Promise<AnyRef[]> {
  let result: AnyRef[] = [];
  await askUntil(io, `${prompt} (screen numbers or id@rev, comma-separated): `, (a) => {
    if (!a && required) return 'At least one reference is required.';
    const p = parseRefs(a, refs);
    if (p.problem) return p.problem;
    result = p.refs;
    return null;
  });
  return result;
}

async function askText(io: ScreenIO, prompt: string, required = true): Promise<string | null> {
  const a = await askUntil(io, `${prompt}: `, (x) => (required && !x ? 'Required.' : null));
  return a || null;
}

async function askRef(io: ScreenIO, prompt: string, refs: NumberedRef[], dflt: Ref | null): Promise<Ref | null> {
  let result: Ref | null = dflt;
  await askUntil(io, `${prompt}${dflt ? ` [Enter = ${refKey(dflt)}]` : ''}: `, (a) => {
    if (!a) return dflt ? null : 'Required.';
    const p = parseRefs(a, refs);
    if (p.problem) return p.problem;
    if (p.refs.length !== 1 || isArtifactRef(p.refs[0])) return 'Give exactly one record reference.';
    result = p.refs[0] as Ref;
    return null;
  });
  return result;
}

/** Potential impact: default is the higher of agent and auditor; going below the agent needs a reason. */
export async function collectImpact(io: ScreenIO, t: DispositionTarget): Promise<ImpactInput> {
  show(io, `Potential impact for ${t.label}: agent estimate ${t.agent_impact ?? 'none'}; your current estimate ${t.auditor_impact ?? 'none'} ('unknown' counts as high).\n`);
  const a = await askUntil(io, `Your estimate (${POTENTIAL_IMPACTS.join('/')}; Enter keeps ${t.auditor_impact ?? 'none'}): `, (x) =>
    !x || (POTENTIAL_IMPACTS as readonly string[]).includes(x) ? null : `One of ${POTENTIAL_IMPACTS.join(', ')}.`,
  );
  const auditor = (a || t.auditor_impact) as PotentialImpact | null;
  let reason: string | null = null;
  if (auditor && t.agent_impact && impactRank(auditor) < impactRank(t.agent_impact)) {
    reason = await askText(io, `You set ${auditor}, below the agent's ${t.agent_impact}. Record the reason (required)`);
  }
  const effective = effectiveImpact(t.agent_impact, auditor, reason);
  io.write(`  Effective potential impact: ${effective}\n`);
  return { auditor, auditor_lower_reason: reason, effective };
}

// -----------------------------------------------------------------------------------------------
// The disposition table: what each disposition records, in the order the screen asks for it. The interactive screen
// (`collectDisposition`), the agent session (`dispositionFromDecision`) and the agent's template (`dispositionTemplate`)
// all walk this one table, so the three cannot ask for, accept or describe different fields.

/** What a field's applicability, choices and notes depend on. */
export interface FieldContext {
  target: DispositionTarget;
  effective: PotentialImpact;
  /** The claim's values so far (top level). */
  values: Record<string, unknown>;
}

export interface DispositionField {
  key: string;
  /** `derived` is never asked: its value follows from the target (omitted when undefined). */
  type: 'text' | 'list' | 'refs' | 'ref' | 'choice' | 'object' | 'derived';
  /** Screen prompt; the description in the agent's template. */
  label: (t: DispositionTarget) => string;
  /** When the field applies (default: always); `condition` says the same in words. */
  when?: (c: FieldContext) => boolean;
  condition?: string;
  /** choice: every value the field can take; `allowed` narrows them for a claim. */
  options?: readonly string[];
  allowed?: (c: FieldContext) => readonly string[];
  /** list: minimum number of entries. */
  min?: number;
  /** list: value recorded when the answer is empty. */
  fallback?: (t: DispositionTarget) => unknown;
  /** object: its fields, in order. */
  fields?: DispositionField[];
  derive?: (t: DispositionTarget) => unknown;
  /** Notes the screen shows before asking and after the answer. */
  before?: (c: FieldContext) => string | null;
  after?: (c: FieldContext, v: unknown) => string | null;
}

const text = (key: string, label: string, more: Partial<DispositionField> = {}): DispositionField => ({ key, type: 'text', label: () => label, ...more });

export const DISPOSITION_FIELDS: Record<Disposition, DispositionField[]> = {
  accepted: [
    text('severity', 'Severity under the engagement rubric'),
    text('severity_basis', 'Severity basis (rubric criterion applied)'),
    {
      key: 'finding',
      type: 'object',
      label: () => 'The finding',
      fields: [
        {
          key: 'prerequisites',
          type: 'list',
          label: (t) => `Realistic prerequisites you confirm [empty = the investigation's ${t.prerequisites.length} listed]`,
          fallback: (t) => t.prerequisites,
        },
        text('title', 'Finding title'),
        text('mechanism', 'Mechanism'),
        text('impact', 'Impact'),
        text('applicability', 'Applicability (target revision and premises this acceptance covers)'),
        { key: 'guarantee', type: 'derived', label: () => "The linked claim's guarantee", derive: (t) => t.guarantee || undefined },
      ],
    },
    {
      key: 'evidence_route',
      type: 'choice',
      label: () => 'Evidence route',
      options: ['code_argument', 'executable_replay', 'alternative_argument'],
      allowed: (c) => (isMediumOrAbove(c.effective) ? ['executable_replay', 'alternative_argument'] : ['code_argument', 'executable_replay', 'alternative_argument']),
      condition: 'code_argument only below an effective potential impact of medium',
      after: (c, v) =>
        v === 'executable_replay'
          ? `  The controller checks for a clean replay receipt (current replay status: ${c.target.replay_status}).`
          : v === 'code_argument'
            ? `  The code argument uses the investigation's ${c.target.anchor_count} source anchor(s).`
            : null,
    },
    {
      key: 'alternative',
      type: 'object',
      label: () => 'Alternative argument (DEC-004)',
      when: (c) => c.values.evidence_route === 'alternative_argument',
      condition: 'when evidence_route is alternative_argument',
      fields: [
        text('why_impractical', 'Why a runnable PoC is impractical'),
        text('why_sufficient', 'Why the argument establishes the issue'),
        text('limits', 'Stated limits of the argument'),
        text('failed_replays_addressed', 'A replay of this claim FAILED: how your decision addresses it', {
          when: (c) => c.target.replay_status === 'failed',
          condition: 'when a replay of this claim failed',
        }),
      ],
    },
  ],
  rejected: [
    { key: 'decisive_evidence', type: 'refs', label: () => 'Decisive evidence for the countercondition' },
    text('countercondition', 'Countercondition'),
    text('countercondition_scope', 'Scope of the countercondition'),
    {
      key: 'positive_control',
      type: 'ref',
      label: () => 'Positive-control evidence (guard removed, violation shown)',
      when: (c) => c.target.executable && isHighOrCritical(c.effective),
      condition: 'for an executable claim at potential High/Critical impact',
      before: () => '  Executable claim with potential High/Critical impact: a positive control showing the violation is required.',
    },
  ],
  no_finding_within_bounds: [
    {
      key: 'bounds',
      type: 'object',
      label: () => 'Bounds of the examination',
      fields: [
        { key: 'methods', type: 'list', label: (t) => `Methods examined [empty = ${t.method}]`, fallback: (t) => [t.method] },
        {
          key: 'variants_tried',
          type: 'text',
          label: (t) => `Variants tried [${t.variants.length} on the packet: ${t.variants.map(refKey).join(', ') || 'none'}]`,
        },
        text('budget', 'Budget spent / allocation examined'),
        text('attacker_charter', 'Attacker charter examined'),
        { key: 'assumptions', type: 'list', label: () => 'Assumptions examined' },
      ],
    },
  ],
  triaged_out: [
    text('triage_reason', 'One-line reason', {
      before: (c) => {
        const auditor = c.values.potential_impact as PotentialImpact | null;
        if (auditor && ['low', 'info'].includes(auditor) && ['low', 'info'].includes(c.effective)) return null;
        return `  Note: triaged_out needs your confirmed potential impact of low or info (yours: ${auditor ?? 'none'}, effective: ${c.effective}). The controller will refuse it.`;
      },
    }),
  ],
  disputed: [
    { key: 'interpretations', type: 'list', label: () => 'Competing interpretations (at least two)', min: 2 },
    text('distinguishing_check', 'What would distinguish them'),
  ],
  deferred: [text('residual_concern', 'Residual concern'), text('revisit_condition', 'Revisit condition')],
};

function applies(f: DispositionField, c: FieldContext): boolean {
  return f.when ? f.when(c) : true;
}

async function askField(io: ScreenIO, f: DispositionField, c: FieldContext): Promise<unknown> {
  const t = c.target;
  const note = f.before?.(c);
  if (note) io.write(note + '\n');
  let v: unknown;
  switch (f.type) {
    case 'text':
      v = await askText(io, f.label(t));
      break;
    case 'list':
      for (;;) {
        const l = await askList(io, f.label(t));
        if (l.length >= (f.min ?? 0)) {
          v = l.length || !f.fallback ? l : f.fallback(t);
          break;
        }
        io.write(`  At least ${f.min} entries are required.\n`);
      }
      break;
    case 'refs':
      v = await askRefs(io, f.label(t), t.refs, true);
      break;
    case 'ref':
      v = await askRef(io, f.label(t), t.refs, null);
      break;
    case 'choice': {
      const allowed = f.allowed ? f.allowed(c) : f.options!;
      v = await choose(io, f.label(t), allowed.map((r, i) => ({ key: String(i + 1), value: r, label: r })));
      break;
    }
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const sub of f.fields!) {
        if (!applies(sub, c)) continue;
        const sv = await askField(io, sub, c);
        if (sv !== undefined) o[sub.key] = sv;
      }
      v = o;
      break;
    }
    case 'derived':
      v = f.derive!(t);
      break;
  }
  const after = f.after?.(c, v);
  if (after) io.write(after + '\n');
  return v;
}

/** Collect one claim's disposition and the fields the glossary table requires for it. */
export async function collectDisposition(io: ScreenIO, t: DispositionTarget): Promise<{ input: DispositionInput; effective: PotentialImpact }> {
  const impact = await collectImpact(io, t);
  io.write(`Disposition for ${t.label}:\n`);
  const keys = ['1', '2', '3', '4', '5', '6'];
  const disposition = await choose(
    io,
    'Disposition',
    DISPOSITIONS.map((d, i) => ({ key: keys[i], value: d, label: `${d} — ${DISPOSITION_HELP[d]}` })),
  );
  const out: DispositionInput = { disposition, potential_impact: impact.auditor, impact_lower_reason: impact.auditor_lower_reason };
  const c: FieldContext = { target: t, effective: impact.effective, values: out };
  for (const f of DISPOSITION_FIELDS[disposition]) {
    if (!applies(f, c)) continue;
    const v = await askField(io, f, c);
    if (v !== undefined) out[f.key] = v;
  }
  return { input: out, effective: impact.effective };
}

// -----------------------------------------------------------------------------------------------
// The same table for a decision an agent session submits as JSON.

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function refFrom(v: unknown, t: DispositionTarget, path: string): AnyRef {
  if (typeof v === 'string') {
    const p = parseRefs(v.replace(/^\[(\d+)\]$/, '$1'), t.refs);
    if (p.problem || p.refs.length !== 1) fail('invalid_request', `${path}: ${p.problem ?? 'give exactly one reference per entry'}`);
    return p.refs[0];
  }
  if (isObject(v) && typeof v.artifact === 'string') return { artifact: v.artifact };
  if (isObject(v) && typeof v.record_id === 'string' && typeof v.revision === 'number') return { record_id: v.record_id, revision: v.revision };
  return fail('invalid_request', `${path}: a reference is "id@revision", an artifact digest, a presented reference number or {record_id, revision}`);
}

function valueFrom(f: DispositionField, v: unknown, c: FieldContext, path: string, missing: string[]): unknown {
  const t = c.target;
  const absent = v === undefined || v === null || (typeof v === 'string' && !v.trim());
  switch (f.type) {
    case 'text':
      if (absent) return void missing.push(path);
      if (typeof v !== 'string') fail('invalid_request', `${path} must be text`);
      return v.trim();
    case 'list': {
      if (v !== undefined && v !== null && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) fail('invalid_request', `${path} must be a list of strings`);
      const l = ((v as string[] | null | undefined) ?? []).map((x) => x.trim()).filter(Boolean);
      if (l.length < (f.min ?? 0)) fail('invalid_request', `${path} needs at least ${f.min} entries`);
      return l.length || !f.fallback ? l : f.fallback(t);
    }
    case 'refs': {
      if (absent || (Array.isArray(v) && !v.length)) return void missing.push(path);
      const items = Array.isArray(v) ? v : [v];
      return items.map((x, i) => refFrom(x, t, `${path}[${i}]`));
    }
    case 'ref': {
      if (absent) return void missing.push(path);
      const r = refFrom(v, t, path);
      if (isArtifactRef(r)) fail('invalid_request', `${path} must be a record reference`);
      return r;
    }
    case 'choice': {
      const allowed = f.allowed ? f.allowed(c) : f.options!;
      if (absent) return void missing.push(path);
      if (typeof v !== 'string' || !allowed.includes(v)) fail('invalid_request', `${path} must be one of ${allowed.join(', ')} for this claim`);
      return v;
    }
    case 'object': {
      if (absent) v = {};
      if (!isObject(v)) fail('invalid_request', `${path} must be an object`);
      const used = f.fields!.filter((s) => s.type !== 'derived' && applies(s, c)).map((s) => s.key);
      const extra = Object.keys(v).filter((k) => !used.includes(k));
      if (extra.length) fail('invalid_request', `${path} does not take: ${extra.join(', ')} (it takes ${used.join(', ')})`);
      const o: Record<string, unknown> = {};
      for (const s of f.fields!) {
        if (!applies(s, c)) continue;
        const sv = s.type === 'derived' ? s.derive!(t) : valueFrom(s, v[s.key], c, `${path}.${s.key}`, missing);
        if (sv !== undefined) o[s.key] = sv;
      }
      return o;
    }
    case 'derived':
      return f.derive!(t);
  }
}

/**
 * One claim's disposition from a submitted decision object, with exactly the fields `collectDisposition` would ask
 * for (applicability, defaults for empty lists, required answers). `extra` names keys the caller handles itself.
 */
export function dispositionFromDecision(t: DispositionTarget, d: Record<string, unknown>, extra: readonly string[] = []): { input: DispositionInput; effective: PotentialImpact } {
  if (!isObject(d)) fail('invalid_request', `${t.label}: the decision must be an object`);
  const disposition = d.disposition as Disposition;
  if (!DISPOSITIONS.includes(disposition)) fail('invalid_request', `${t.label}: disposition must be one of ${DISPOSITIONS.join(', ')}`);
  if (d.potential_impact !== undefined && d.potential_impact !== null && !(POTENTIAL_IMPACTS as readonly unknown[]).includes(d.potential_impact)) {
    fail('invalid_request', `${t.label}: potential_impact must be one of ${POTENTIAL_IMPACTS.join(', ')} or null`);
  }
  const auditor = ((d.potential_impact as PotentialImpact | null | undefined) ?? t.auditor_impact) as PotentialImpact | null;
  let reason: string | null = null;
  if (auditor && t.agent_impact && impactRank(auditor) < impactRank(t.agent_impact)) {
    if (typeof d.impact_lower_reason !== 'string' || !d.impact_lower_reason.trim()) {
      fail('invalid_request', `${t.label}: potential impact ${auditor} is below the agent's ${t.agent_impact}; impact_lower_reason is required`);
    }
    reason = d.impact_lower_reason.trim();
  }
  const effective = effectiveImpact(t.agent_impact, auditor, reason);
  const out: DispositionInput = { disposition, potential_impact: auditor, impact_lower_reason: reason };
  const c: FieldContext = { target: t, effective, values: out };
  const missing: string[] = [];
  const used: string[] = [];
  for (const f of DISPOSITION_FIELDS[disposition]) {
    // Applicability can depend on earlier answers (the alternative argument follows the route), so walk in order.
    if (!applies(f, c)) continue;
    if (f.type !== 'derived') used.push(f.key);
    const v = f.type === 'derived' ? f.derive!(t) : valueFrom(f, d[f.key], c, f.key, missing);
    if (v !== undefined) out[f.key] = v;
  }
  const known = ['disposition', 'potential_impact', 'impact_lower_reason', ...used, ...extra];
  const unknown = Object.keys(d).filter((k) => !known.includes(k));
  if (unknown.length) fail('invalid_request', `${t.label}: ${disposition} does not take ${unknown.join(', ')} here (it takes ${used.join(', ') || 'nothing else'})`);
  if (missing.length) fail('invalid_request', `${t.label}: ${disposition} needs ${missing.join(', ')}`, { details: { missing } });
  return { input: out, effective };
}

/** A field's placeholder; the condition of an enclosing object is carried into each of its fields. */
function placeholder(f: DispositionField, t: DispositionTarget, outer: string | null = null): unknown {
  const condition = [outer, f.condition].filter(Boolean).join('; ');
  const when = condition ? ` (only ${condition})` : '';
  const label = f.label(t);
  switch (f.type) {
    case 'text':
      return `<${label}${when}>`;
    case 'list':
      return [`<${label}${f.min ? `; at least ${f.min}` : ''}${when}>`];
    case 'refs':
      return [`<${label}: id@revision, artifact digest or a presented reference number${when}>`];
    case 'ref':
      return `<${label}: id@revision or a presented reference number${when}>`;
    case 'choice':
      return `<${label}: one of ${f.options!.join(' | ')}${condition ? `; ${condition}` : ''}>`;
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const s of f.fields!) if (s.type !== 'derived') o[s.key] = placeholder(s, t, condition || null);
      return o;
    }
    case 'derived':
      return undefined;
  }
}

/** JSON skeleton of one claim's decision for each disposition, described from the same table. */
export function dispositionTemplate(t: DispositionTarget): Record<Disposition, Record<string, unknown>> {
  const out = {} as Record<Disposition, Record<string, unknown>>;
  for (const d of DISPOSITIONS) {
    const o: Record<string, unknown> = {
      disposition: d,
      potential_impact: `<null keeps ${t.auditor_impact ?? 'none'} (agent estimate ${t.agent_impact ?? 'none'}), or one of ${POTENTIAL_IMPACTS.join(' | ')}>`,
      impact_lower_reason: `<null, or the reason when your estimate is below the agent's ${t.agent_impact ?? 'none'}>`,
    };
    for (const f of DISPOSITION_FIELDS[d]) {
      const p = placeholder(f, t);
      if (p !== undefined) o[f.key] = p;
    }
    out[d] = o;
  }
  return out;
}
