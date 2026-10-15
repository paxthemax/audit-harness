import { fail } from '../core/errors.ts';
import { PROPOSED_MAX_TOKENS_CAP } from '../runner/provider.ts';
import { arr, int, literal, obj, oneOfValues, text, validate, type Schema } from '../schema/jsonschema.ts';
import { limitsSchema, type Limits } from '../schema/records.ts';

// The yolo charter: the operator's document for one unattended discovery -> test -> report run
// (docs/operator-choices.md, "Yolo loop"). Like every unattended draft, nothing in it is defaulted: a missing
// or unknown member is refused, and so is a plan the run could not carry out (a round budget too small for
// the rounds the charter itself asks for). Numeric values are the operator's choices.

/** The reference runtime's hard cap on model turns per round (src/agents/runtime.ts). */
const MAX_TURNS_CAP = 50;

export const YOLO_ROLES = ['comprehension', 'planner', 'investigator', 'challenger'] as const;
export type YoloRole = (typeof YOLO_ROLES)[number];

export interface YoloCapabilities {
  tools: string[];
  providers: string[];
  /** Yolo runs never reach a network: an RPC gateway needs its own decision. */
  network: 'denied';
}

export interface YoloCharter {
  /** Wall-clock length of the run; the authorizations it creates are valid until the run's end. */
  duration_seconds: number;
  /** Upper bound on discovery -> test -> report cycles. */
  max_cycles: number;
  /** The run stops after this many consecutive failed agent attempts (provider refusals, crashes). */
  max_consecutive_failures: number;
  /** Providers that may receive live-exploitable material during the run (agent contexts carry units and investigations). */
  live_providers: string[];
  agents: {
    /** The model each role runs on; each must be offered by a provider its authorization lists. */
    models: Record<YoloRole, string>;
    /** Model turns per agent round (the reference runtime caps it at 50). */
    max_turns: number;
    /** Output tokens per model turn: a PoC fixture is written in one tool call, so this bounds its size. */
    max_tokens: number;
    /** Runtime limit of each agent round, in seconds. */
    round_runtime_seconds: number;
    /** The provider broker's limit on one model call; a call still unanswered then is `outcome_unknown`. */
    call_timeout_seconds: number;
    /** The operator's notes appended to every agent task (target quirks, conventions); empty for none. */
    notes: string[];
    /** Snapshot path prefixes every agent context also carries beyond the policy scope (e.g. test deployment helpers). */
    reference_paths: string[];
  };
  discovery: {
    /** Comprehension rounds in the first cycle (0 when the audit units are already mapped). */
    seed_rounds: number;
    /** Comprehension rounds in each later cycle. */
    rounds_per_cycle: number;
    /** The operator's direction for comprehension and planning (areas, attack classes, methods); empty for none. */
    focus: string[];
    /** The run's one intake authorization: comprehension and planner rounds, and the build when the snapshot has none. */
    capabilities: YoloCapabilities;
    limits: Limits;
  };
  batch: {
    /** Investigations admitted per cycle. */
    investigations: number;
    /** Investigator rounds per investigation before the challenge; a challenger round and a packet round follow. */
    investigator_rounds: number;
    /** Each cycle's batch authorization. */
    capabilities: YoloCapabilities;
    limits: Limits;
  };
  /**
   * `reviewed_only`: admit only questions whose audit units have a recorded flow review. `unattended`: lift the batch
   * gate with unattended flow reviews (labelled, closure stays incomplete until a human reviews the flow).
   */
  flow_reviews: 'unattended' | 'reviewed_only';
}

const capabilitiesSchema: Schema = obj({ tools: arr(text()), providers: arr(text()), network: literal('denied') });

export const yoloCharterSchema: Schema = obj({
  duration_seconds: int(1),
  max_cycles: int(1),
  max_consecutive_failures: int(1),
  live_providers: arr(text()),
  agents: obj({
    models: obj(Object.fromEntries(YOLO_ROLES.map((r) => [r, text()]))),
    max_turns: int(1),
    max_tokens: int(1),
    round_runtime_seconds: int(1),
    call_timeout_seconds: int(1),
    notes: arr(text()),
    reference_paths: arr(text()),
  }),
  discovery: obj({ seed_rounds: int(0), rounds_per_cycle: int(0), focus: arr(text()), capabilities: capabilitiesSchema, limits: limitsSchema }),
  batch: obj({ investigations: int(1), investigator_rounds: int(1), capabilities: capabilitiesSchema, limits: limitsSchema }),
  flow_reviews: oneOfValues(['unattended', 'reviewed_only']),
});

/** The charter as written, or `invalid_request` listing every problem (nothing is defaulted). */
export function parseCharter(raw: unknown): YoloCharter {
  const issues = validate(yoloCharterSchema, raw).map((i) => `${i.path}: ${i.message}`);
  if (issues.length) fail('invalid_request', `the yolo charter is incomplete or malformed: ${issues.join('; ')}`, { details: { problems: issues } });
  // The schema above checked every member, so the value has the charter's shape.
  const c = raw as YoloCharter;
  const problems: string[] = [];
  for (const [name, limits] of [['discovery', c.discovery.limits], ['batch', c.batch.limits]] as const) {
    if (!Object.values(limits).every((v) => Number.isFinite(v))) problems.push(`${name}.limits must be finite`);
    if (c.agents.round_runtime_seconds > limits.runtime_seconds) {
      problems.push(`agents.round_runtime_seconds ${c.agents.round_runtime_seconds} exceeds ${name}.limits.runtime_seconds ${limits.runtime_seconds}`);
    }
  }
  if (c.agents.max_turns > MAX_TURNS_CAP) problems.push(`agents.max_turns ${c.agents.max_turns} exceeds the reference runtime's cap of ${MAX_TURNS_CAP}`);
  if (c.agents.max_tokens > PROPOSED_MAX_TOKENS_CAP) problems.push(`agents.max_tokens ${c.agents.max_tokens} exceeds the broker's cap of ${PROPOSED_MAX_TOKENS_CAP}`);
  if (c.agents.call_timeout_seconds > c.agents.round_runtime_seconds) {
    problems.push(`agents.call_timeout_seconds ${c.agents.call_timeout_seconds} exceeds agents.round_runtime_seconds ${c.agents.round_runtime_seconds}`);
  }
  if (!c.discovery.capabilities.tools.includes('reference_agent')) problems.push('discovery.capabilities.tools must include reference_agent');
  for (const t of ['reference_agent', 'forge_test']) if (!c.batch.capabilities.tools.includes(t)) problems.push(`batch.capabilities.tools must include ${t}`);
  // Seeding, later comprehension rounds, and one planner round per cycle.
  const discovery = c.discovery.seed_rounds + (c.max_cycles - 1) * c.discovery.rounds_per_cycle + c.max_cycles;
  if (c.discovery.limits.rounds < discovery) {
    problems.push(
      `discovery.limits.rounds ${c.discovery.limits.rounds} cannot cover the charter's ${discovery} discovery rounds (seed_rounds + (max_cycles - 1) x rounds_per_cycle + one planner round per cycle)`,
    );
  }
  // Per investigation: the investigator rounds, a challenger round and a packet round.
  const batch = c.batch.investigations * (c.batch.investigator_rounds + 2);
  if (c.batch.limits.rounds < batch) {
    problems.push(`batch.limits.rounds ${c.batch.limits.rounds} cannot cover ${batch} rounds (investigations x (investigator_rounds + a challenger round + a packet round))`);
  }
  if (problems.length) fail('invalid_request', `the yolo charter cannot be carried out: ${problems.join('; ')}`, { details: { problems } });
  return c;
}
