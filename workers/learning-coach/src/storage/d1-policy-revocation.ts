import { isCapacityModel, safeInteger, type CapacityProvider } from "../config/provider-policy";
import type { D1Binding } from "./d1-quota-admission";

export interface PolicyRevocation {
  quotaScopeId: string;
  provider: CapacityProvider;
  model: string;
  expectedPolicyVersion: number;
  expectedGeneration: number; // Zero creates the terminal barrier; subsequent writes require exact CAS.
}
export type RevocationDecision = { state: "revoked"; generation: number } |
  { state: "invalid_request" | "conflict" | "storage_unavailable" };

// Trusted internal administration only; never composed into a public route.
// An acknowledgment is not needed for safety: a possibly committed barrier
// continues blocking dispatch. No operation in this service re-enables a scope.
export class D1PolicyRevocation {
  constructor(private readonly db: D1Binding | undefined) {}

  async revoke(input: PolicyRevocation): Promise<RevocationDecision> {
    if (!input || typeof input.quotaScopeId !== "string" || !/^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,199}$/.test(input.quotaScopeId) ||
        !isCapacityModel(input.provider, input.model) ||
        !safeInteger(input.expectedPolicyVersion) || input.expectedPolicyVersion < 1 ||
        !safeInteger(input.expectedGeneration) || input.expectedGeneration >= Number.MAX_SAFE_INTEGER) return { state: "invalid_request" };
    const db = this.db;
    if (!db) return { state: "storage_unavailable" };
    try {
      const result = await db.batch<{ generation: number }>([db.prepare(`INSERT INTO provider_policy_revocations
        (quota_scope_id, provider, model, policy_version, generation, revoked_at)
        SELECT ?1, ?2, ?3, ?4, 1, unixepoch() FROM provider_capacity_policies p
        WHERE p.quota_scope_id = ?1 AND p.provider = ?2 AND p.model = ?3 AND p.version = ?4
          AND p.updated_at <= unixepoch() AND (?5 = 0 OR EXISTS (
            SELECT 1 FROM provider_policy_revocations v WHERE v.quota_scope_id = ?1 AND v.provider = ?2 AND v.generation = ?5))
        ON CONFLICT (quota_scope_id, provider) DO UPDATE SET generation = generation + 1, revoked_at = unixepoch()
        WHERE provider_policy_revocations.generation = ?5 AND provider_policy_revocations.generation < 9007199254740991
        RETURNING generation`).bind(input.quotaScopeId, input.provider, input.model, input.expectedPolicyVersion, input.expectedGeneration)]);
      if (result.length !== 1 || !result[0]?.success) return { state: "storage_unavailable" };
      if (result[0].meta.changes === 0 && result[0].results.length === 0) return { state: "conflict" };
      const generation = result[0].results[0]?.generation;
      return result[0].meta.changes === 1 && generation === input.expectedGeneration + 1
        ? { state: "revoked", generation } : { state: "storage_unavailable" };
    } catch { return { state: "storage_unavailable" }; }
  }
}
