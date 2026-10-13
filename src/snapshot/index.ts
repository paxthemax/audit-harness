// Target snapshots, inventory, snapshot diffs, dependency probes, freshness (loop L6) and fix
// assessment. Importing this module registers `register_snapshot`, `record_probe`, the build and
// probe job-completion hooks, the runner's environment-read scanner, and the decision kinds
// `attest_carry_forward`, `reaffirm` and `assess_fix`.
import './register.ts';
import './probes.ts';
import './change.ts';
import './decisions.ts';
import './reruns.ts';

export type { Inventory, InventoryContract, Callable, StorageLayouts, StorageSlotEntry } from './inventory.ts';
export { deriveInventory, readOutArtifacts, resolveSymbol } from './inventory.ts';
export { activeSnapshotOf, loadInventory, loadLayouts, isConsequential, CONCLUSION_TYPES } from './common.ts';
export { recomputeFreshness, markAffected, currentFreshness, freshnessSummary, affectedPremises } from './change.ts';
export { evaluateProbe, rerunJobSpec, pendingReruns, attachProbeJob, probesFor } from './probes.ts';
export { buildJobSpec, ingestBuild } from './register.ts';
export { scheduleReruns } from './reruns.ts';
export { computeChanges, gaps } from './diff.ts';
