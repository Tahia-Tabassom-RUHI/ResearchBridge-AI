import { authenticate } from "../auth";
import { isLoopback, MAX_RESPONSE_BYTES, PROVIDER_TIMEOUT_MS, type Env } from "../config/index";
import { buildResponse, sourceText, validateRequest, validateRequestShape, validateV1Response } from "../contracts/index";
import type { SourceRegistry, ValidatedTask, ResponseVersion } from "../contracts/types";
import { ContractError, HttpError, errorResponse, jsonResponse } from "../errors/index";
import { ProviderFailure, type InferenceProvider, type ProviderResult, type ProviderAttempt } from "../providers/types";
import { failedMockUsage, malformedUsageFailure, successfulMockUsage } from "../providers/mock-evidence";
import type { SourceResolver } from "../sources";
import { readJson } from "./body";
import type { DurableRequests, BeginDecision, AccountingDecision } from "../storage/durable-requests";
import type { FailureReport, RequestStatus } from "../storage";
import type { ExecutionEvidence, LocalProviderExecution } from "../providers/local-provider-execution";

type Options = { mode: "production" } | { mode: "local"; enabled: boolean; provider: InferenceProvider; sources: SourceResolver; timeoutMs?: number; durable?: DurableRequests; execution?: LocalProviderExecution };
const unavailable = () => new HttpError(503, "invalid_response", "Inference is unavailable; manual learning remains available.");

function requestStatus(requestId: string, result: Exclude<BeginDecision, { state: "ready" }> | RequestStatus | Exclude<AccountingDecision, { state: "accounted" }>): Response {
  const state = result.state;
  const code = state === "completed" ? 200 : ["pending", "reserved", "dispatched"].includes(state) ? 202 :
    state === "expired" ? 410 : state === "invalid_request" ? 400 :
    ["storage_unavailable", "configuration_missing", "reconciliation_failed"].includes(state) ? 503 : 409;
  return jsonResponse({ request_id: state === "invalid_request" ? null : requestId, state, retryable: false, replay: "status_only" }, code,
    { "X-ResearchBridge-Request-State": state, "X-ResearchBridge-Replay": "status-only" });
}

async function invoke(provider: InferenceProvider, task: ValidatedTask, attempt: ProviderAttempt, timeoutMs: number): Promise<ProviderResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new ProviderFailure("timeout")); controller.abort(); }, timeoutMs);
  });
  try { return await Promise.race([provider.generate(structuredClone(task), controller.signal, structuredClone(attempt)), deadline]); }
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
        const durable = options.durable;
        const trustedProvider = options.execution ? options.execution.accepts(options.provider) :
          options.provider?.identity?.provider === "mock" && options.provider.identity.model === "mock-model";
        if (!durable?.accountingAvailable || !trustedProvider ||
            !Number.isSafeInteger(options.timeoutMs ?? PROVIDER_TIMEOUT_MS) || (options.timeoutMs ?? PROVIDER_TIMEOUT_MS) <= 0) throw unavailable();
        const begun = await durable.begin(principal, requestId, task);
        if (begun.state !== "ready") return requestStatus(requestId, begun);
        const authorized = await durable.authorizeDispatch(begun.fence);
        if (authorized.state !== "updated") return requestStatus(requestId, authorized);
        const owned = await durable.readAttempt(authorized.fence, begun.reservationId);
        if (owned.state !== "owned") return requestStatus(requestId, owned);
        const attempt = owned.attempt;
        if (attempt.provider !== begun.provider || attempt.model !== begun.model || attempt.provider !== options.provider.identity.provider ||
            attempt.model !== options.provider.identity.model) return requestStatus(requestId, { state: "configuration_missing", retryable: false });
        try { options.provider.prepare?.(structuredClone(task)); }
        catch {
          const accounted = await durable.accountFailure(authorized.fence, attempt,
            { category: "PROVEN_PRE_DISPATCH_FAILURE", reason: "preparation_failed" });
          if (accounted.state !== "accounted") return requestStatus(requestId, accounted);
          throw new HttpError(503, "invalid_response", "The local provider could not prepare the request.");
        }
        // Only an acknowledged conditional sent transition permits invocation.
        // There is no atomic transaction spanning D1 and provider execution.
        const execution = await options.execution?.open(authorized.fence, attempt);
        if (options.execution && !execution) return requestStatus(requestId, { state: "storage_unavailable", retryable: false });
        const dispatched = await durable.dispatch(authorized.fence);
        if (dispatched.state !== "updated") return requestStatus(requestId, dispatched);
        const fence = dispatched.fence;
        const providerAttempt: ProviderAttempt = { provider: attempt.provider, model: attempt.model,
          reservationId: attempt.reservationId, attemptId: attempt.attemptId };
        let result: ProviderResult;
        try { result = await invoke(options.provider, task, providerAttempt, options.timeoutMs ?? PROVIDER_TIMEOUT_MS); }
        catch (error) {
          const evidence = await execution?.finish(fence, undefined, error);
          const usage = execution ? evidence?.usage : error instanceof ProviderFailure ? failedMockUsage(error.accounting, attempt) : undefined;
          const failure: FailureReport = error instanceof ProviderFailure && error.kind !== "timeout"
            ? { category: "CONFIRMED_PROVIDER_ERROR", reason: "provider_http_error", httpStatus: error.kind === "rate_limit" ? 429 : 500, ...(usage ? { usage } : {}) }
            : { category: "POSSIBLY_DISPATCHED_FAILURE", reason: error instanceof ProviderFailure ? "request_timeout" : "connection_failure", ...(usage ? { usage } : {}) };
          const accounted = await durable.accountFailure(fence, attempt, failure);
          if (accounted.state !== "accounted") return requestStatus(requestId, accounted);
          if (evidence && !evidence.acknowledged) return requestStatus(requestId, { state: "reconciliation_failed", retryable: false });
          if (error instanceof ProviderFailure && error.kind === "timeout") throw new HttpError(504, "invalid_response", "The inference attempt timed out.");
          if (error instanceof ProviderFailure && error.kind === "rate_limit") throw new HttpError(429, "invalid_response", "The inference provider is temporarily rate limited.");
          throw new HttpError(502, "invalid_response", "The inference provider could not complete the request.");
        }
        const evidence: ExecutionEvidence | undefined = await execution?.finish(fence, result);
        if (evidence) {
          const o = evidence.observation;
          const failed = !o || (o.httpStatus !== null && o.httpStatus >= 400) ||
            ["provider_timeout", "connection_interrupted"].includes(o.classification);
          if (!evidence.acknowledged || failed) {
            const usage = evidence.usage;
            const failure: FailureReport = o?.httpStatus && o.httpStatus >= 400
              ? { category: "CONFIRMED_PROVIDER_ERROR", reason: "provider_http_error", httpStatus: o.httpStatus, ...(usage ? { usage } : {}) }
              : { category: "UNKNOWN_OUTCOME", reason: "ambiguous_response", ...(usage ? { usage } : {}) };
            const accounted = await durable.accountFailure(fence, attempt, failure);
            if (accounted.state !== "accounted") return requestStatus(requestId, accounted);
            if (!evidence.acknowledged) return requestStatus(requestId, { state: "reconciliation_failed", retryable: false });
            const status = o?.classification === "provider_timeout" ? 504 : o?.httpStatus === 429 ? 429 : 502;
            throw new HttpError(status, "invalid_response", "The local provider simulation could not complete the request.");
          }
        }
        let response: unknown;
        try {
          response = version === "1" ? validateV1Response(result.output, sourceText(validated, sources)!.abstract) : buildResponse(validated, result.output, sources);
          if (new TextEncoder().encode(JSON.stringify(response)).byteLength > MAX_RESPONSE_BYTES) throw new ContractError("invalid_response");
        } catch (error) {
          const usage = execution ? evidence?.usage : failedMockUsage(result?.accounting, attempt);
          const accounted = await durable.accountFailure(fence, attempt,
            { category: "INVALID_OR_UNTRUSTED_USAGE", reason: "malformed_response", ...(usage ? { usage } : {}) });
          if (accounted.state !== "accounted") return requestStatus(requestId, accounted);
          throw new HttpError(502, error instanceof ContractError ? error.code : "invalid_response", "The inference provider returned an unusable response.");
        }
        const usage = execution ? evidence?.successUsage : successfulMockUsage(result.accounting, attempt);
        if (!usage) {
          const partial = execution ? evidence?.usage : failedMockUsage(result.accounting, attempt);
          const accounted = await durable.accountFailure(fence, attempt,
            { ...malformedUsageFailure(result.accounting === undefined), ...(partial ? { usage: partial } : {}) });
          if (accounted.state !== "accounted") return requestStatus(requestId, accounted);
          throw new HttpError(502, "invalid_response", "The inference provider returned unusable usage evidence.");
        }
        const settled = await durable.settleSuccess(fence, attempt, usage);
        if (settled.state !== "accounted") return requestStatus(requestId, settled);
        // Mock evidence stays internal; no private response is durably replayed.
        return jsonResponse(response, 200, { "X-ResearchBridge-Inference": "mock", "X-ResearchBridge-Response-Version": version });
      } catch (error) { return errorResponse(error); }
    },
  };
}
