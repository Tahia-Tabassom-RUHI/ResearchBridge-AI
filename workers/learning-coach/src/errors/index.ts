export const MESSAGES = {
  unsupported_version: "The contract version is not supported.",
  unknown_task: "The Learning Coach task is not supported.",
  invalid_request: "The request does not satisfy the task contract.",
  unknown_source: "The source reference is not in the trusted retrieval context.",
  invalid_source: "The trusted retrieval record is incomplete or invalid.",
  missing_abstract: "An abstract is required; title-only context cannot support this task.",
  invalid_response: "The response does not satisfy the task contract.",
  invalid_evidence: "The response contains unsupported evidence or claims.",
  source_mismatch: "The response does not match the request's source coverage.",
} as const;
export type ErrorCode = keyof typeof MESSAGES;

export class ContractError extends Error {
  constructor(readonly code: ErrorCode) { super(MESSAGES[code]); }
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

export function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", ...headers,
  } });
}

export function errorResponse(error: unknown): Response {
  const known = error instanceof HttpError || error instanceof ContractError;
  const code = known ? error.code : "invalid_response";
  const status = error instanceof HttpError ? error.status : error instanceof ContractError ? 400 : 500;
  return jsonResponse({ contract_version: "2", error: {
    code, message: known ? error.message : "The gateway could not complete the request.", retryable: false,
  } }, status, error instanceof HttpError ? error.headers : {});
}
