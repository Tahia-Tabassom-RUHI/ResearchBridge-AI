import type { D1Binding } from "../storage/d1-quota-admission";

export interface Env {
  COACH_DB?: D1Binding;
  COACH_SERVICE_SECRET?: string;
  LOCAL_MOCK_ENABLED?: string;
  MOCK_SCENARIO?: string;
}
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 100_000;
export const BODY_TIMEOUT_MS = 5_000;
export const PROVIDER_TIMEOUT_MS = 1_000;
export const isLoopback = (url: URL): boolean => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
