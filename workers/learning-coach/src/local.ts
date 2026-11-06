import type { Env } from "./config/index";
import { createGateway } from "./handlers/gateway";
import { LocalMockProvider, MockSourceResolver, SCENARIOS, type MockScenario } from "./providers/mock";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const scenario = env.MOCK_SCENARIO ?? "success";
    const supported = SCENARIOS.some(value => value === scenario);
    return createGateway({ mode: "local", enabled: env.LOCAL_MOCK_ENABLED === "true" && supported,
      provider: new LocalMockProvider(supported ? scenario as MockScenario : "error"), sources: new MockSourceResolver(),
    }).fetch(request, env);
  },
};
