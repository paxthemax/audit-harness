import { fail } from '../core/errors.ts';
import type { Controller } from '../controller/controller.ts';
import { AnthropicProvider, OmpGateway, OmpGatewayProvider, ProviderBroker } from '../runner/index.ts';

/**
 * The provider broker for agent jobs run by this process (`harness job run`, `harness agent session`, an agent session's
 * `runJobs`). A broker already active in the process is used as is; otherwise one is created with the workspace's
 * configured providers: an external provider's credential is read from `secrets/providers/<name>.key`; `omp_gateway`
 * providers share one `omp auth-gateway stdio` child per binary and profile, which holds the logins itself. Which
 * providers may receive live-exploitable material is an operator choice (`--live-providers`); by default none may.
 * `timeoutMs` is the limit on one provider call (default: the broker's proposed one).
 */
export function ensureBroker(controller: Controller, liveExploitableProviders: string[] = [], opts: { timeoutMs?: number } = {}): void {
  if (ProviderBroker.active()) return;
  const b = new ProviderBroker(controller, { liveExploitableProviders, timeoutMs: opts.timeoutMs });
  const gateways = new Map<string, OmpGateway>();
  for (const p of controller.ws.config.providers) {
    if (p.kind === 'external' && p.name === 'anthropic') b.registerFromWorkspace(new AnthropicProvider());
    else if (p.kind === 'omp_gateway') {
      if (!p.omp) fail('invalid_request', `provider ${p.name}: an omp_gateway provider needs its omp settings in harness.json`);
      const key = JSON.stringify([p.omp.binary, p.omp.version, p.omp.profile]);
      let gw = gateways.get(key);
      if (!gw) gateways.set(key, (gw = new OmpGateway({ binary: p.omp.binary, version: p.omp.version, profile: p.omp.profile })));
      b.registerSelfAuthenticating(new OmpGatewayProvider(gw, { name: p.name, upstream: p.omp.upstream, models: p.models, rates: p.omp.rates, headroom: p.omp.headroom }));
    }
  }
}
