// Trusted runner module: importing it registers the job, control, auditor-run and provider
// operations. The asynchronous runner entry points live in runner.ts.
import './jobs.ts';
import './auditorRuns.ts';
import './provider.ts';
import './conformance.ts';

export { runJob, runQueue, reconcileOnStart, runAuditorCommand } from './runner.ts';
export { ProviderBroker, FakeProvider } from './provider.ts';
export { spendSummary } from './ledger.ts';
export { registerAdapter, commandAdapter, adapterFor, listAdapters } from './adapters.ts';
export { BwrapSandbox } from './sandbox.ts';
export { AnthropicProvider, PROPOSED_ANTHROPIC_RATES } from './anthropic.ts';
export { OmpGateway, OmpGatewayProvider, PROPOSED_OMP_HEADROOM, PROPOSED_OMP_NOTIONAL_RATES } from './ompGateway.ts';
export { runConformance, checkAdapterConformance, checkAgentHostConformance, checkSandboxEgress } from './conformance.ts';
export { referenceAgentAdapter } from './adapters.ts';
