import type { ServicePrincipal } from "./auth";

export interface SourceResolver {
  // Resolve only from server-owned retrieval state and authorize this principal.
  // Future retrieval adapters must return the existing retrieved-source schema.
  resolve(sourceId: string, principal: ServicePrincipal): Promise<unknown | undefined>;
}
