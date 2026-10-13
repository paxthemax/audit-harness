import { fail } from '../core/errors.ts';
import type { AnyRef, Ref } from '../core/refs.ts';
import type { PotentialImpact } from '../core/values.ts';
import { defineOperation, type OpContext } from '../controller/controller.ts';
import type { AuditUnitBody, RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';
import { defaultProofStatus, impactField } from '../decision/common.ts';
import { controlStatus } from '../comprehension/comprehension.ts';
import { retrieveMechanisms, type RetrievedMechanism } from '../library/library.ts';
import { activeSnapshotOf, loadInventory } from '../snapshot/common.ts';
import type { Callable, Inventory } from '../snapshot/inventory.ts';

// Lead generation per audit unit (FR-35; design/audit-harness.md, "Three investigation methods",
// "Lead generation"). Deterministic generators turn records into proposed investigation questions
// and record, for every unit, which generators ran: DESIGNED/IMPLEMENTED discrepancies, applicable
// standards (claims, when documentation claims conformance), an attack-vector sweep per component
// class, upstream diffs of vendored code, the project's own test suite, the baseline control
// checklist and mechanism-library retrieval. A lead is a proposal: it stays `proposed` until the
// auditor authorizes it, and generator coverage is not review coverage.

export const GENERATORS = [
  'designed_implemented_discrepancy',
  'applicable_standard',
  'attack_vector_sweep',
  'upstream_diff',
  'project_test_suite',
  'baseline_control',
  'mechanism_library',
  'tool_signal',
] as const;
export type Generator = (typeof GENERATORS)[number];

export interface Lead {
  generator: Generator;
  /** Stable key so a rerun does not duplicate a lead. */
  key: string;
  question: string;
  method: 'hypothesis' | 'property' | 'scenario';
  potential_impact: PotentialImpact;
  functions: string[];
  guarantees: string[];
  anchors: { path: string; symbol: string | null }[];
  supporting: AnyRef[];
  /** Counterconditions retrieved with a library mechanism or lesson (never separated from it). */
  counterconditions: string[];
}

// --- standards ------------------------------------------------------------------------------------

const STANDARDS: { name: string; class: string; selectors: string[]; min: number; leads: { q: string; impact: PotentialImpact; method: Lead['method'] }[] }[] = [
  {
    name: 'ERC-4626',
    class: 'vault',
    selectors: ['6e553f65', 'ba087652', 'c6e6f592', '07a2d13a', 'ef8b30f7', '4cdad506', '38d52e0f'],
    min: 3,
    leads: [
      { q: 'Do share conversions round in the vault\'s favor in every direction (deposit/mint/withdraw/redeem and their previews)?', impact: 'medium', method: 'property' },
      { q: 'Can a first depositor inflate the share price (donation) so later deposits round to zero shares?', impact: 'high', method: 'scenario' },
      { q: 'Do preview functions match what the corresponding actions actually do, including fees?', impact: 'medium', method: 'property' },
    ],
  },
  {
    name: 'ERC-20',
    class: 'token',
    selectors: ['a9059cbb', '23b872dd', '095ea7b3', '70a08231', '18160ddd', 'dd62ed3e'],
    min: 4,
    leads: [
      { q: 'Do transfer and transferFrom conform to ERC-20 return values, events and allowance semantics?', impact: 'medium', method: 'hypothesis' },
      { q: 'Is total supply conserved across transfers, mints and burns?', impact: 'high', method: 'property' },
    ],
  },
  {
    name: 'ERC-1967 / upgradeable proxy',
    class: 'proxy',
    selectors: ['3659cfe6', '4f1ef286'],
    min: 1,
    leads: [
      { q: 'Can storage layouts of successive implementations collide with the proxy or each other?', impact: 'high', method: 'hypothesis' },
      { q: 'Can the implementation be initialized or upgraded by an unauthorized caller?', impact: 'critical', method: 'hypothesis' },
    ],
  },
];

function detectStandards(inv: Inventory): { contract: string; standard: (typeof STANDARDS)[number] }[] {
  const out: { contract: string; standard: (typeof STANDARDS)[number] }[] = [];
  for (const c of inv.contracts) {
    if (c.origin !== 'source' || c.kind !== 'contract') continue;
    const sels = new Set(c.entry_points.map((e) => e.selector).filter(Boolean));
    for (const s of STANDARDS) if (s.selectors.filter((x) => sels.has(x)).length >= s.min) out.push({ contract: c.name, standard: s });
  }
  return out;
}

// --- attack-vector sweep ----------------------------------------------------------------------------

const ADMIN_NAME = /^(set|upgrade|sweep|rescue|pause|unpause|mint|burn|withdrawAll|emergency|grant|revoke|transferOwnership|initialize)/i;

function sweep(inv: Inventory): Omit<Lead, 'supporting' | 'counterconditions'>[] {
  const out: Omit<Lead, 'supporting' | 'counterconditions'>[] = [];
  for (const c of inv.contracts) {
    if (c.origin !== 'source' || c.kind === 'interface') continue;
    for (const f of c.functions) {
      if (!['external', 'public'].includes(f.visibility) || f.kind === 'getter') continue;
      const anchor = [{ path: f.path, symbol: `${f.contract}.${f.name}` }];
      const valueCalls = f.low_level_calls.filter((l) => ['call', 'send', 'transfer'].includes(l.kind) && !l.in_assembly);
      if ((valueCalls.length || f.external_calls.length) && f.writes.length) {
        out.push({
          generator: 'attack_vector_sweep',
          key: `reentrancy:${f.key}`,
          question: `Can a callback during ${f.symbol} re-enter while ${f.writes.join(', ')} still holds a stale value, breaking an accounting guarantee?`,
          method: 'scenario',
          potential_impact: 'high',
          functions: [`${f.contract}.${f.name}`],
          guarantees: [`${f.contract} accounting stays consistent across external calls`],
          anchors: anchor,
        });
      }
      if (f.low_level_calls.some((l) => l.kind === 'delegatecall')) {
        out.push({
          generator: 'attack_vector_sweep',
          key: `delegatecall:${f.key}`,
          question: `Can a caller influence the delegatecall target or data in ${f.symbol}?`,
          method: 'hypothesis',
          potential_impact: 'critical',
          functions: [`${f.contract}.${f.name}`],
          guarantees: ['only intended code executes in the contract\'s storage context'],
          anchors: anchor,
        });
      }
      if (ADMIN_NAME.test(f.name) && f.writes.length && !f.modifiers.length && f.kind === 'function') {
        out.push({
          generator: 'attack_vector_sweep',
          key: `access:${f.key}`,
          question: `Can an unprivileged caller invoke ${f.symbol}, which changes ${f.writes.join(', ')} with no modifier?`,
          method: 'hypothesis',
          potential_impact: 'high',
          functions: [`${f.contract}.${f.name}`],
          guarantees: ['privileged state changes are restricted to their roles'],
          anchors: anchor,
        });
      }
      if (f.assembly.length) {
        out.push({
          generator: 'attack_vector_sweep',
          key: `assembly:${f.key}`,
          question: `Does the inline assembly in ${f.symbol} preserve memory safety and the intended storage effects?`,
          method: 'hypothesis',
          potential_impact: 'medium',
          functions: [`${f.contract}.${f.name}`],
          guarantees: [],
          anchors: anchor,
        });
      }
    }
  }
  return out;
}

// --- generation --------------------------------------------------------------------------------------

function unitsFor(store: RecordStore, functions: string[]): RecordEnvelope<'audit_unit'>[] {
  return store
    .heads('audit_unit')
    .filter((u) => u.body.review_status !== 'excluded' && u.body.functions.some((f) => functions.some((n) => f.name === n || f.name.startsWith(`${n}(`))));
}

export interface GenerationResult {
  leads: Lead[];
  ran: Generator[];
  not_applicable: { generator: Generator; reason: string }[];
}

export function generateLeads(store: RecordStore, library: RecordStore | null, only?: Generator[]): GenerationResult {
  const want = new Set(only ?? GENERATORS);
  const leads: Lead[] = [];
  const ran: Generator[] = [];
  const na: GenerationResult['not_applicable'] = [];
  const snap = activeSnapshotOf(store);
  const inv = snap ? loadInventory(store.archive, snap.body) : null;
  const add = (l: Omit<Lead, 'supporting' | 'counterconditions'> & Partial<Pick<Lead, 'supporting' | 'counterconditions'>>) =>
    leads.push({ supporting: [], counterconditions: [], ...l });

  if (want.has('designed_implemented_discrepancy')) {
    ran.push('designed_implemented_discrepancy');
    for (const d of store.heads('behavioral_discrepancy')) {
      if (d.body.investigations.length || d.body.disposition) continue;
      add({ generator: 'designed_implemented_discrepancy', key: `disc:${d.record_id}`, question: `Does the deviation "${d.body.deviation}" let an attacker break the designed behavior?`, method: 'hypothesis', potential_impact: 'unknown', functions: [], guarantees: [], anchors: [], supporting: [{ record_id: d.record_id, revision: d.revision }] });
    }
  }
  if (want.has('applicable_standard') || want.has('attack_vector_sweep')) {
    if (!inv) {
      if (want.has('applicable_standard')) na.push({ generator: 'applicable_standard', reason: 'no compiler inventory for the active snapshot (build pending or failed)' });
      if (want.has('attack_vector_sweep')) na.push({ generator: 'attack_vector_sweep', reason: 'no compiler inventory for the active snapshot (build pending or failed)' });
    } else {
      if (want.has('applicable_standard')) {
        ran.push('applicable_standard');
        for (const { contract, standard } of detectStandards(inv)) {
          const fns = inv.contracts.find((c) => c.name === contract)!.functions.filter((f) => ['external', 'public'].includes(f.visibility)).map((f) => `${f.contract}.${f.name}`);
          for (const l of standard.leads) {
            add({ generator: 'applicable_standard', key: `std:${standard.name}:${contract}:${l.q}`, question: `${contract} (${standard.name}): ${l.q}`, method: l.method, potential_impact: l.impact, functions: fns, guarantees: [`${standard.name} conformance`], anchors: [{ path: inv.contracts.find((c) => c.name === contract)!.path, symbol: contract }] });
          }
        }
      }
      if (want.has('attack_vector_sweep')) {
        ran.push('attack_vector_sweep');
        for (const l of sweep(inv)) add(l);
      }
    }
  }
  if (want.has('upstream_diff')) {
    if (!snap) na.push({ generator: 'upstream_diff', reason: 'no active snapshot' });
    else {
      ran.push('upstream_diff');
      for (const v of snap.body.vendored.filter((x) => x.status === 'modified')) {
        add({ generator: 'upstream_diff', key: `vendored:${v.path}`, question: `Do the local modifications of vendored ${v.path} (${v.modified_files.join(', ')}) change security-relevant behavior of the upstream release?`, method: 'hypothesis', potential_impact: 'unknown', functions: [], guarantees: [], anchors: v.modified_files.map((p) => ({ path: p, symbol: null })) });
      }
    }
  }
  if (want.has('project_test_suite')) {
    const suites = store.heads('job').filter((j) => j.body.purpose === 'baseline_tests' && j.body.status === 'completed' && !!snap && j.body.snapshot.record_id === snap.record_id);
    if (!suites.length) na.push({ generator: 'project_test_suite', reason: 'the project test suite has not run' });
    else {
      ran.push('project_test_suite');
      for (const ev of store.heads('evidence_artifact').filter((e) => e.body.job && suites.some((s) => s.record_id === e.body.job!.record_id))) {
        for (const t of ev.body.structured_result?.tests ?? []) {
          if (t.status !== 'failed') continue;
          add({ generator: 'project_test_suite', key: `test:${t.name}`, question: `Why does the project's own test ${t.name} fail (${t.reason ?? 'no reason'}): a target defect, a stale test, or a fixture problem?`, method: 'hypothesis', potential_impact: 'unknown', functions: [], guarantees: [], anchors: [], supporting: [{ record_id: ev.record_id, revision: ev.revision }] });
        }
      }
    }
  }
  if (want.has('baseline_control')) {
    ran.push('baseline_control');
    for (const c of store.heads('control_item')) {
      if (controlStatus(c.body) !== 'open_gap') continue;
      add({ generator: 'baseline_control', key: `control:${c.body.control_id}`, question: `Is baseline control ${c.body.control_id} (${c.body.title}) satisfied? No examined evidence is recorded.`, method: 'hypothesis', potential_impact: 'unknown', functions: [], guarantees: [c.body.title], anchors: [], supporting: [{ record_id: c.record_id, revision: c.revision }] });
    }
  }
  if (want.has('mechanism_library')) {
    if (!library || !inv) na.push({ generator: 'mechanism_library', reason: !library ? 'no mechanism library' : 'no inventory to derive component classes' });
    else {
      ran.push('mechanism_library');
      const classes = new Set<string>();
      const standards = new Set<string>();
      for (const { standard } of detectStandards(inv)) {
        classes.add(standard.class);
        standards.add(standard.name);
      }
      if (inv.contracts.some((c) => c.origin === 'source' && c.functions.some((f) => f.mutability === 'payable'))) classes.add('ether_vault');
      const hits: RetrievedMechanism[] = retrieveMechanisms(library, { component_classes: [...classes], standards: [...standards], keywords: [] });
      for (const m of hits) {
        add({ generator: 'mechanism_library', key: `mech:${m.ref.record_id}`, question: `Does the mechanism "${m.mechanism}" apply here (matched on ${m.matched_on.join(', ')})?`, method: 'hypothesis', potential_impact: 'unknown', functions: [], guarantees: [], anchors: [], counterconditions: m.counterconditions });
      }
    }
  }
  if (want.has('tool_signal')) {
    ran.push('tool_signal');
    for (const f of store.heads('suspicious_flag')) {
      if (f.body.kind !== 'environment_read' && f.body.kind !== 'natspec_contradiction') continue;
      add({ generator: 'tool_signal', key: `flag:${f.body.path}:${f.body.offset}`, question: f.body.kind === 'environment_read' ? `Does the environment read at ${f.body.path}:${f.body.line} (${f.body.detail}) change behavior under test or in production?` : `Does the NatSpec claim at ${f.body.path}:${f.body.line} contradict the code (${f.body.detail})?`, method: 'hypothesis', potential_impact: 'unknown', functions: [], guarantees: [], anchors: [{ path: f.body.path, symbol: null }], supporting: [{ record_id: f.record_id, revision: f.revision }] });
    }
  }
  return { leads, ran, not_applicable: na };
}

defineOperation<{ generators?: Generator[] }>({
  name: 'generate_leads',
  channels: ['auditor', 'controller'],
  mutating: true,
  handler(ctx: OpContext, p) {
    const only = p?.generators;
    if (only && only.some((g) => !(GENERATORS as readonly string[]).includes(g))) fail('invalid_request', `generators must be among ${GENERATORS.join(', ')}`);
    let library: RecordStore | null = null;
    try {
      library = ctx.ws.store('library', true);
    } catch {
      library = null;
    }
    const res = generateLeads(ctx.store, library, only);
    // Do not duplicate a lead already proposed by an earlier run (same question).
    const existing = new Set(ctx.store.heads('investigation').map((i) => i.body.question));
    const created: { investigation: Ref; generator: Generator; units: string[] }[] = [];
    for (const l of res.leads) {
      if (existing.has(l.question)) continue;
      existing.add(l.question);
      const units = unitsFor(ctx.store, l.functions).map((u) => ({ record_id: u.record_id, revision: u.revision }));
      const ref = ctx.tx.create('investigation', {
        method: l.method,
        question: l.question,
        executable: l.method !== 'hypothesis' || l.generator === 'attack_vector_sweep',
        origin: 'agent',
        lead_generator: l.generator,
        audit_units: units,
        guarantees: l.guarantees,
        attacker_capabilities: [],
        prerequisites: l.counterconditions.length ? l.counterconditions.map((c) => `countercondition: ${c}`) : [],
        anchors: l.anchors.map((a) => ({ path: a.path, symbol: a.symbol, start: null, length: null, content_digest: null, snapshot: null })),
        potential_impact: impactField(l.potential_impact, null, null),
        supporting: l.supporting,
        refuting: [],
        variants: [],
        linked_claims: [],
        next_check: units.length ? null : 'map this lead to an audit unit before authorizing it',
        jobs: [],
        authorization: null,
        work_state: 'proposed',
        blocked_reason: null,
        disposition: null,
        proof_status: defaultProofStatus(),
        probes: [],
        lineage: null,
      });
      created.push({ investigation: ref, generator: l.generator, units: units.map((u) => u.record_id) });
    }
    // Record per-unit generator coverage: which generators ran for each scoped unit.
    for (const u of ctx.store.heads('audit_unit')) {
      if (u.body.review_status === 'excluded') continue;
      // Coverage describes one snapshot: this run's outcome replaces any earlier one for each generator.
      const snapId = activeSnapshotOf(ctx.store)?.record_id ?? 'no snapshot';
      const cov = new Map(u.body.lead_generator_coverage.map((c) => [c.generator, c]));
      for (const g of res.ran) cov.set(g, { generator: g, status: 'ran', note: `ran on ${snapId} at ${ctx.now}` });
      for (const n of res.not_applicable) cov.set(n.generator, { generator: n.generator, status: 'not_applicable', note: `${n.reason} (on ${snapId})` });
      const next: AuditUnitBody['lead_generator_coverage'] = [...cov.values()].sort((a, b) => a.generator.localeCompare(b.generator));
      if (JSON.stringify(next) !== JSON.stringify(u.body.lead_generator_coverage)) {
        ctx.tx.revise(u.record_id, 'audit_unit', (b) => ({ ...b, lead_generator_coverage: next }));
      }
    }
    return { created, ran: res.ran, not_applicable: res.not_applicable, leads_seen: res.leads.length };
  },
});

export type { Callable };
