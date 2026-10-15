import { DEFAULT_ATTACKER_CHARTER } from '../core/values.ts';
import type { RecordEnvelope } from '../schema/records.ts';
import { DEFAULT_TRUSTED_ROLE_PREMISE, LIMIT_KEYS, MANDATORY_POLICY_FIELDS, refOf } from '../screen/flows.ts';

// JSON skeletons of what `AgentReviewSession.decide` takes for an item, so the agent can fill them in with the auditor.
// Packets take theirs from the screen's disposition table (`packetTemplate`); these cover the other items. Placeholders
// are `<…>` strings; everything else is a value the screen would use by default.

/** `record_flow_review`: the functions the auditor reviewed and the gaps recorded for the flow. */
export function flowReviewTemplate(unit: RecordEnvelope<'audit_unit'>): Record<string, unknown> {
  const open = unit.body.functions.filter((f) => !f.reviewed).map((f) => f.name);
  return {
    reviewed_functions: open.length ? `<"all", or a list of the functions the auditor reviewed among: ${open.join(', ')}; omitted = none>` : [],
    gaps: ['<a gap the auditor records for this flow; omit the list for none>'],
  };
}

/** `authorize_work`: every finite limit (nothing is defaulted), and the investigations kept in the batch. */
export function authorizeTemplate(prop: RecordEnvelope<'work_proposal'>): Record<string, unknown> {
  return {
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, '<finite non-negative number; an operator choice, nothing is defaulted>'])),
    capabilities: {
      tools: prop.body.requested_capabilities.tools,
      providers: prop.body.requested_capabilities.providers,
      network: prop.body.requested_capabilities.network,
    },
    validity: null,
    interrupt_conditions: [],
    keep: prop.body.investigations.map((r) => r.record_id),
  };
}

/** `accept_scope_and_policy`: the policy, with every default attacker capability kept or excluded with a reason. */
export function scopePolicyTemplate(eng: RecordEnvelope<'engagement'>): Record<string, unknown> {
  const current = eng.body.policy as unknown as Record<string, unknown> | null;
  const fields = current ?? Object.fromEntries(MANDATORY_POLICY_FIELDS.map((k) => [k, `<${k}: required (schema: harness schemas, records/engagement)>`]));
  return {
    policy: {
      ...fields,
      attacker_charter: current?.attacker_charter ?? {
        capabilities: [...DEFAULT_ATTACKER_CHARTER.capabilities],
        excluded: [],
        raised_roles: [],
        privileged_roles_trusted: true,
        notes: null,
      },
      trusted_role_premise: current?.trusted_role_premise ?? DEFAULT_TRUSTED_ROLE_PREMISE,
    },
  };
}

/**
 * Generic decisions a presented record usually leads to: `{ kind, records, decision }` as `decide` takes them (the
 * decision inputs are passed to the controller as given, like `harness screen decide`). Null when none applies.
 */
export function recordTemplate(env: RecordEnvelope, all: (type: RecordEnvelope['type']) => RecordEnvelope[]): Record<string, unknown> | null {
  const ref = refOf(env);
  switch (env.type) {
    case 'clarification': {
      const c = env as RecordEnvelope<'clarification'>;
      if (!['queued', 'presented', 'held'].includes(c.body.status)) return null;
      return {
        kind: 'answer_clarification',
        records: [`${c.record_id}@${c.revision}`, '<captured input id@revision carrying the answer (harness_capture, purpose clarification_answer)>'],
        decision: {
          clarification: ref,
          answer: `<one of: ${c.body.options.map((o) => o.option).join(' | ') || '(no options listed)'}; "unknown"; or the auditor's own answer>`,
          captured_input: { record_id: '<cap-…>', revision: 1 },
          as: '<intent | assumption>',
          relayed_from_auditee: false,
        },
      };
    }
    case 'interpretation': {
      const i = env as RecordEnvelope<'interpretation'>;
      if (i.body.status !== 'proposed') return null;
      return {
        kind: 'confirm_interpretations',
        records: [`${i.record_id}@${i.revision}`, ...i.body.captured_inputs.map((c) => `${c.record_id}@${c.revision}`)],
        decision: { items: [{ interpretation: ref, choice: '<confirm | edit | reject>', edited_statement: '<only when the choice is edit>' }] },
      };
    }
    case 'report_manifest': {
      const m = env as RecordEnvelope<'report_manifest'>;
      if (m.body.status !== 'preview') return null;
      return {
        kind: 'approve_export',
        records: [`${m.record_id}@${m.revision}`],
        decision: { report_manifest: ref, payload: m.body.payload.artifact, audience: m.body.audience, destination: '<authorized destination, e.g. a local path>' },
      };
    }
    case 'conclusion_freshness': {
      const f = env as RecordEnvelope<'conclusion_freshness'>;
      if (f.body.value !== 'carried_forward_mechanical' || f.body.attestation) return null;
      const same = (all('conclusion_freshness') as RecordEnvelope<'conclusion_freshness'>[]).filter(
        (x) => x.body.value === 'carried_forward_mechanical' && !x.body.attestation && x.body.snapshot.record_id === f.body.snapshot.record_id && x.body.snapshot.revision === f.body.snapshot.revision,
      );
      return {
        kind: 'attest_carry_forward',
        records: same.map((x) => `${x.record_id}@${x.revision}`),
        decision: { snapshot: f.body.snapshot, prior_snapshot: f.body.prior_snapshot, freshness: same.map(refOf), mechanical: true },
      };
    }
  }
  return null;
}
