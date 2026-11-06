import type { Env } from "./config/index";
import { HttpError } from "./errors/index";

export interface ServicePrincipal { serviceId: "streamlit" }
const HEX_SECRET = /^[a-f0-9]{64}$/;
const CONTEXT = new TextEncoder().encode("ResearchBridge service authentication");
const bytes = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from(hex.match(/../g)!, part => parseInt(part, 16));

export async function authenticate(request: Request, env: Env): Promise<ServicePrincipal> {
  const expected = env.COACH_SERVICE_SECRET;
  if (!expected || !HEX_SECRET.test(expected)) throw new HttpError(503, "invalid_response", "The gateway is unavailable.");
  const header = request.headers.get("Authorization") ?? "";
  const supplied = /^Bearer ([a-f0-9]{64})$/.exec(header)?.[1];
  const unauthorized = () => new HttpError(401, "invalid_request", "Service authentication is required.", { "WWW-Authenticate": "Bearer" });
  if (!supplied) throw unauthorized();
  // Use platform HMAC verification instead of comparing secret strings in JS.
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const signingKey = await crypto.subtle.importKey("raw", bytes(expected), algorithm, false, ["sign"]);
  const verifyingKey = await crypto.subtle.importKey("raw", bytes(supplied), algorithm, false, ["verify"]);
  const signature = await crypto.subtle.sign("HMAC", signingKey, CONTEXT);
  if (!await crypto.subtle.verify("HMAC", verifyingKey, signature, CONTEXT)) throw unauthorized();
  return { serviceId: "streamlit" };
}
