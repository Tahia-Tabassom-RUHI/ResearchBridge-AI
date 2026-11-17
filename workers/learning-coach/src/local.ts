import type { Env } from "./config/index";
import { createGateway } from "./handlers/gateway";
import { LocalMockProvider, MockSourceResolver, SCENARIOS, type MockScenario } from "./providers/mock";
import { localServices, localProviderServices, type LocalDurableConfig, type LocalProviderConfig } from "./local-services";
import { LocalPolicyMockProvider, POLICY_MOCK_SCENARIOS, type PolicyMockScenario } from "./providers/local-policy-mock";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const scenario = env.MOCK_SCENARIO ?? "success";
    const supported = SCENARIOS.some(value => value === scenario);
    let durable;
    // Explicit local-only composition. A policy configuration never falls back
    // to the legacy mock path when invalid. Production imports neither path.
    try {
      const config = JSON.parse(env.LOCAL_DURABLE_CONFIG ?? "null");
      if (config && Object.hasOwn(config, "policy")) {
        const validScenario = POLICY_MOCK_SCENARIOS.some(s => s === scenario);
        const selected = new LocalPolicyMockProvider(config.policy, validScenario ? scenario as PolicyMockScenario : "error");
        const services = localProviderServices(env, config as LocalProviderConfig, selected);
        return createGateway({ mode: "local", enabled: env.LOCAL_MOCK_ENABLED === "true" && validScenario,
          provider: selected, sources: new MockSourceResolver(), ...services }).fetch(request, env);
      }
    } catch {
      return createGateway({ mode: "local", enabled: false, provider: new LocalMockProvider(),
        sources: new MockSourceResolver() }).fetch(request, env);
    }
    try { durable = localServices(env, JSON.parse(env.LOCAL_DURABLE_CONFIG ?? "null") as LocalDurableConfig)?.durable; }
    catch { /* Invalid trusted configuration remains unavailable. */ }
    return createGateway({ mode: "local", enabled: env.LOCAL_MOCK_ENABLED === "true" && supported,
      provider: new LocalMockProvider(supported ? scenario as MockScenario : "error"), sources: new MockSourceResolver(),
      ...(durable ? { durable } : {}),
    }).fetch(request, env);
  },
};
