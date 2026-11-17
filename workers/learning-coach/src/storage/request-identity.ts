import type { ServicePrincipal } from "../auth";
import type { ValidatedTask } from "../contracts/types";
import type { IdempotencyFence, RequestIdentity } from "../storage";

export const hashPattern = /^[0-9a-f]{64}$/;
export const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async (value: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

// Validated JSON only: sorted object keys, ordered arrays, exact strings. No
// whitespace/case/Unicode normalization beyond JSON's decoding of escape syntax.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical value");
}

export async function identifyRequest(principal: ServicePrincipal, requestId: string, task: ValidatedTask, secret: string | undefined): Promise<RequestIdentity> {
  if (!requestIdPattern.test(requestId)) throw new Error("Invalid request identifier");
  if (!secret || !hashPattern.test(secret)) throw new Error("Fingerprint configuration unavailable");
  const bytes = Uint8Array.from(secret.match(/../g)!, p => parseInt(p, 16));
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = canonicalJson({ format: "researchbridge-request-v1", service: principal.serviceId,
    contractVersion: task.request.contract_version, taskId: task.request.task_id,
    responseVersion: task.responseVersion, request: task.request, source: task.source });
  return {
    serviceId: principal.serviceId,
    // The opaque UUID lookup remains stable across fingerprint-key rotation.
    keyHash: await sha256(canonicalJson(["researchbridge-key-v1", principal.serviceId, requestId])),
    payloadHash: hex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))),
    fingerprintKeyId: hex(await crypto.subtle.sign("HMAC", key, encoder.encode("researchbridge-key-identifier-v1"))),
    responseVersion: task.responseVersion,
  };
}

export function validIdentity(identity: RequestIdentity): boolean {
  return typeof identity.serviceId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(identity.serviceId) &&
    [identity.keyHash, identity.payloadHash, identity.fingerprintKeyId].every(v => typeof v === "string" && hashPattern.test(v)) &&
    (identity.responseVersion === "1" || identity.responseVersion === "2");
}
export function validFence(fence: IdempotencyFence): boolean {
  return validIdentity(fence) && requestIdPattern.test(fence.claimId) && hashPattern.test(fence.token) &&
    Number.isSafeInteger(fence.generation) && fence.generation > 0 && fence.generation < Number.MAX_SAFE_INTEGER;
}
