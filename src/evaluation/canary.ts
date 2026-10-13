import { fail } from '../core/errors.ts';
import type { Ref } from '../core/refs.ts';
import { defineOperation } from '../controller/controller.ts';
import type { CanaryBody, RecordEnvelope } from '../schema/records.ts';
import type { RecordStore } from '../store/recordStore.ts';

// Canary packets (NFR-14; design/harness-evaluation.md, "Pilot protocol"). The operator seeds a packet
// through the normal operations (an invalid claim with a plausible narrative, or a valid claim with a
// deliberately weakened counterargument) and labels it here. The auditor reviews it like any other
// packet; afterwards `score_canaries` records whether it was caught.
//
// Where the label lives: the library store. Labels must never be visible from the engagement, and the
// engagement store is what the trusted screen renders, what `read_records` returns and what the
// context builder reads. The library store is a separate record store: engagement reads never reach
// it, workers are confined to their engagement and see only `engagement`-visibility records, and the
// library's only engagement-facing path (mechanism retrieval) returns admitted `library_entry` records
// alone. Nothing is written to the engagement when a canary is registered or scored. The canary
// record does name its engagement inside the library; it is evaluation metadata, never a library
// entry, so the rule that entries never name a source engagement is unaffected.

const EXPECTED: Record<CanaryBody['kind'], CanaryBody['expected']> = {
  invalid_claim_plausible_narrative: 'not_accepted',
  valid_claim_weakened_counterargument: 'not_dismissed',
};

const DISMISSALS = ['rejected', 'no_finding_within_bounds', 'triaged_out'];

/** Whether a disposition catches a canary of the given expectation. */
export function caught(expected: CanaryBody['expected'], disposition: string): boolean {
  return expected === 'not_accepted' ? disposition !== 'accepted' : !DISMISSALS.includes(disposition);
}

defineOperation<{ engagement: string; packet: Ref; kind: CanaryBody['kind'] }>({
  name: 'register_canary',
  channels: ['auditor'],
  mutating: true,
  scope: 'library',
  handler(ctx, p) {
    if (!p?.engagement || !ctx.ws.hasEngagement(p.engagement)) fail('not_found', 'engagement not found');
    if (!EXPECTED[p.kind]) fail('invalid_request', `kind must be one of ${Object.keys(EXPECTED).join(', ')}`);
    const store = ctx.ws.store(p.engagement, true);
    const pkt = store.get(p.packet, 'review_packet');
    // The catch rate is fixed before outcomes are known: a decided packet cannot become a canary.
    const inv = store.mustHead(pkt.body.investigation.record_id, 'investigation');
    if (inv.body.disposition) fail('invalid_request', `${p.packet.record_id} was already decided; canaries are registered before the auditor reviews them`);
    if (ctx.store.heads('canary').some((c) => c.body.engagement === p.engagement && c.body.packet.record_id === p.packet.record_id)) {
      fail('invalid_request', 'that packet is already a canary');
    }
    const canary = ctx.tx.create('canary', { engagement: p.engagement, packet: p.packet, kind: p.kind, expected: EXPECTED[p.kind], outcome: null });
    return { canary };
  },
});

/** The decision that disposed the packet's investigation having reviewed (some revision of) the packet. */
function decisionFor(store: RecordStore, packet: Ref): { decision: Ref; disposition: string } | null {
  const pkt = store.tryGet<'review_packet'>(packet);
  if (!pkt) return null;
  const inv = store.head<'investigation'>(pkt.body.investigation.record_id);
  const d = inv?.body.disposition;
  if (!d) return null;
  const dec = store.tryGet<'human_decision'>(d.decision);
  if (!dec || !dec.body.reviewed.some((r) => r.record_id === packet.record_id)) return null;
  return { decision: d.decision, disposition: d.value };
}

defineOperation<Record<string, never>>({
  name: 'score_canaries',
  channels: ['auditor'],
  mutating: true,
  scope: 'library',
  handler(ctx) {
    const scored: { canary: Ref; caught: boolean }[] = [];
    const pending: Ref[] = [];
    for (const c of ctx.store.heads('canary') as RecordEnvelope<'canary'>[]) {
      if (c.body.outcome) continue;
      if (!ctx.ws.hasEngagement(c.body.engagement)) continue;
      const hit = decisionFor(ctx.ws.store(c.body.engagement, true), c.body.packet);
      if (!hit) {
        pending.push({ record_id: c.record_id, revision: c.revision });
        continue;
      }
      const ok = caught(c.body.expected, hit.disposition);
      const ref = ctx.tx.revise(c.record_id, 'canary', (b) => ({ ...b, outcome: { decision: hit.decision, disposition: hit.disposition, caught: ok } }));
      scored.push({ canary: ref, caught: ok });
    }
    return { scored, pending };
  },
});
