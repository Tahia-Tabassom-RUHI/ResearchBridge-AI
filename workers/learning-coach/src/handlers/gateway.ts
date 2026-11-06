import { authenticate } from "../auth";
import { isLoopback, MAX_RESPONSE_BYTES, PROVIDER_TIMEOUT_MS, type Env } from "../config/index";
import { buildResponse, sourceText, validateRequest, validateRequestShape, validateV1Response } from "../contracts/index";
import type { SourceRegistry, ValidatedTask, ResponseVersion } from "../contracts/types";
import { ContractError, HttpError, errorResponse, jsonResponse } from "../errors/index";
import { ProviderFailure, type InferenceProvider, type ProviderResult } from "../providers/types";
import type { SourceResolver } from "../sources";
import { readJson } from "./body";
import type { DurableRequests, BeginDecision } from "../storage/durable-requests";
import type { IdempotencyFence, RequestStatus } from "../storage";

type Options = { mode: "production" } | { mode: "local"; enabled: boolean; provider: InferenceProvider; sources: SourceResolver; timeoutMs?: number; durable?: DurableRequests };
const unavailable = () => new HttpError(503, "invalid_response", "Inference is unavailable; manual learning remains available.");

function requestStatus(requestId: string, result: Exclude<BeginDecision, { state: "ready" }> | RequestStatus): Response {
  const state = result.state;
  const code = state === "completed" ? 200 : ["pending", "reserved", "dispatched"].includes(state) ? 202 :
    state === "expired" ? 410 : state === "invalid_request" ? 400 :
    ["storage_unavailable", "configuration_missing"].includes(state) ? 503 : 409;
  return jsonResponse({ request_id: state === "invalid_request" ? null : requestId, state, retryable: false, replay: "status_only" }, code,
    { "X-ResearchBridge-Request-State": state, "X-ResearchBridge-Replay": "status-only" });
}

async function invoke(provider: InferenceProvider, task: ValidatedTask, timeoutMs: number): Promise<ProviderResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new ProviderFailure("timeout")); controller.abort(); }, timeoutMs);
  });
  try { return await Promise.race([provider.generate(task, controller.signal), deadline]); }
  finally { clearTimeout(timer); }
}

export function createGateway(options: Options) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (options.mode === "local" && !isLoopback(url)) throw unavailable();
        if (url.protocol !== "https:" && !(options.mode === "local" && url.protocol === "http:" && isLoopback(url))) throw new HttpError(400, "invalid_request", "HTTPS is required.");
        if (url.pathname === "/api/health") {
          if (request.method !== "GET") throw new HttpError(405, "invalid_request", "Method not allowed.", { Allow: "GET" });
          return jsonResponse({ status: "ok" });
        }
        if (url.pathname !== "/api/coach/generate") throw new HttpError(404, "invalid_request", "Endpoint not found.");
        if (request.method !== "POST") throw new HttpError(405, "invalid_request", "Method not allowed.", { Allow: "POST" });
        const principal = await authenticate(request, env);
        if (request.headers.has("Origin") || request.headers.has("Sec-Fetch-Site")) throw new HttpError(403, "invalid_request", "This endpoint accepts server-to-server requests only.");
        const input = validateRequestShape(await readJson(request));
        const version = request.headers.get("X-ResearchBridge-Response-Version") ?? "2";
        if (version !== "1" && version !== "2") throw new ContractError("unsupported_version");
        if (version === "1" && input.task_id !== "abstract_explanation") throw new ContractError("invalid_request");
        // No environment flag can enable the production entry point.
        if (options.mode === "production" || !options.enabled) throw unavailable();
        const records = new Map<string, unknown>();
        if (input.task_id !== "term_clarification" && input.input.source.kind === "retrieved_paper") {
          const id = input.input.source.source_id;
          records.set(id, await options.sources.resolve(id, principal));
        }
        const sources: SourceRegistry = records;
        const validated = validateRequest(input, sources);
        const task: ValidatedTask = { request: structuredClone(validated), source: sourceText(validated, sources), responseVersion: version as ResponseVersion };
        const requestId = request.headers.get("X-ResearchBridge-Request-ID") ?? "";
        let fence: IdempotencyFence | undefined;
        if (options.durable) {
          const begun = await options.durable.begin(principal, requestId, task);
          if (begun.state !== "ready") return requestStatus(requestId, begun);
          const authorized = await options.durable.authorizeDispatch(begun.fence);
          if (authorized.state !== "updated") return requestStatus(requestId, authorized);
          const dispatched = await options.durable.dispatch(authorized.fence);
          if (dispatched.state !== "updated") return requestStatus(requestId, dispatched);
          fence = dispatched.fence;
        }
        let result: ProviderResult;
        try { result = await invoke(options.provider, task, options.timeoutMs ?? PROVIDER_TIMEOUT_MS); }
        catch (error) {
          if (fence) await options.durable!.markUnknown(fence);
          if (error instanceof ProviderFailure && error.kind === "timeout") throw new HttpError(504, "invalid_response", "The inference attempt timed out.");
          if (error instanceof ProviderFailure && error.kind === "rate_limit") throw new HttpError(429, "invalid_response", "The inference provider is temporarily rate limited.", { "Retry-After": "30" });
          throw new HttpError(502, "invalid_response", "The inference provider could not complete the request.");
        }
        let response: unknown;
        try {
          response = version === "1" ? validateV1Response(result.output, sourceText(validated, sources)!.abstract) : buildResponse(validated, result.output, sources);
          if (new TextEncoder().encode(JSON.stringify(response)).byteLength > MAX_RESPONSE_BYTES) throw new ContractError("invalid_response");
        } catch (error) {
          if (fence) await options.durable!.markUnknown(fence);
          throw new HttpError(502, error instanceof ContractError ? error.code : "invalid_response", "The inference provider returned an unusable response.");
        }
        if (fence) {
          const completed = await options.durable!.complete(fence);
          if (completed.state !== "updated") return requestStatus(requestId, completed);
        }
        // Mock usage stays internal. It is neither measured consumption nor a quota balance.
        return jsonResponse(response, 200, { "X-ResearchBridge-Inference": "mock", "X-ResearchBridge-Response-Version": version });
      } catch (error) { return errorResponse(error); }
    },
  };
}
