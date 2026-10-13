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
// separately for each linked claim with its own potential impact; the controller enforces the same
// table when the decision is committed. There is no bulk path: every claim is asked on its own.

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
  switch (disposition) {
    case 'accepted': {
      out.severity = await askText(io, 'Severity under the engagement rubric');
      out.severity_basis = await askText(io, 'Severity basis (rubric criterion applied)');
      const prereq = await askList(io, `Realistic prerequisites you confirm [empty = the investigation's ${t.prerequisites.length} listed]`);
      out.finding = {
        title: await askText(io, 'Finding title'),
        mechanism: await askText(io, 'Mechanism'),
        impact: await askText(io, 'Impact'),
        prerequisites: prereq.length ? prereq : t.prerequisites,
        applicability: await askText(io, 'Applicability (target revision and premises this acceptance covers)'),
        ...(t.guarantee ? { guarantee: t.guarantee } : {}),
      };
      const routes = isMediumOrAbove(impact.effective)
        ? (['executable_replay', 'alternative_argument'] as const)
        : (['code_argument', 'executable_replay', 'alternative_argument'] as const);
      out.evidence_route = await choose(
        io,
        'Evidence route',
        routes.map((r, i) => ({ key: String(i + 1), value: r, label: r })),
      );
      if (out.evidence_route === 'executable_replay') {
        io.write(`  The controller checks for a clean replay receipt (current replay status: ${t.replay_status}).\n`);
      } else if (out.evidence_route === 'alternative_argument') {
        out.alternative = {
          why_impractical: await askText(io, 'Why a runnable PoC is impractical'),
          why_sufficient: await askText(io, 'Why the argument establishes the issue'),
          limits: await askText(io, 'Stated limits of the argument'),
          ...(t.replay_status === 'failed'
            ? { failed_replays_addressed: await askText(io, 'A replay of this claim FAILED: how your decision addresses it') }
            : {}),
        };
      } else {
        io.write(`  The code argument uses the investigation's ${t.anchor_count} source anchor(s).\n`);
      }
      break;
    }
    case 'rejected':
      out.decisive_evidence = await askRefs(io, 'Decisive evidence for the countercondition', t.refs, true);
      out.countercondition = await askText(io, 'Countercondition');
      out.countercondition_scope = await askText(io, 'Scope of the countercondition');
      if (t.executable && isHighOrCritical(impact.effective)) {
        io.write('  Executable claim with potential High/Critical impact: a positive control showing the violation is required.\n');
        out.positive_control = await askRef(io, 'Positive-control evidence (guard removed, violation shown)', t.refs, null);
      }
      break;
    case 'no_finding_within_bounds': {
      const m = await askList(io, `Methods examined [empty = ${t.method}]`);
      out.bounds = {
        methods: m.length ? m : [t.method],
        variants_tried: await askText(io, `Variants tried [${t.variants.length} on the packet: ${t.variants.map(refKey).join(', ') || 'none'}]`),
        budget: await askText(io, 'Budget spent / allocation examined'),
        attacker_charter: await askText(io, 'Attacker charter examined'),
        assumptions: await askList(io, 'Assumptions examined'),
      };
      break;
    }
    case 'triaged_out':
      if (!impact.auditor || !['low', 'info'].includes(impact.auditor) || !['low', 'info'].includes(impact.effective)) {
        io.write(`  Note: triaged_out needs your confirmed potential impact of low or info (yours: ${impact.auditor ?? 'none'}, effective: ${impact.effective}). The controller will refuse it.\n`);
      }
      out.triage_reason = await askText(io, 'One-line reason');
      break;
    case 'disputed': {
      let interp: string[] = [];
      while (interp.length < 2) {
        interp = await askList(io, 'Competing interpretations (at least two)');
        if (interp.length < 2) io.write('  At least two interpretations are required.\n');
      }
      out.interpretations = interp;
      out.distinguishing_check = await askText(io, 'What would distinguish them');
      break;
    }
    case 'deferred':
      out.residual_concern = await askText(io, 'Residual concern');
      out.revisit_condition = await askText(io, 'Revisit condition');
      break;
  }
  return { input: out, effective: impact.effective };
}
