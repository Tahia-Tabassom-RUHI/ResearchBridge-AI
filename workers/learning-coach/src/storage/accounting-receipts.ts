import { canonicalJson, sha256 } from "./request-identity";
import type { NormalizedFailure, FailureAllocation } from "./failure-usage";
import type { NormalizedUsage } from "./settlement-usage";

export interface ReceiptContext { claimId: string; generation: number; reservationId: string; attemptId: string; provider: string; model: string }
export interface ReceiptWindow { window: string; metric: string | null; unit: string; reserved: number }
// These formats are unchanged from 4D-2/4D-3. Recovery verifies the same receipts
// without reconstructing owner capabilities or trusting only a hash's presence.
export const successReceipt = (context: ReceiptContext, usage: NormalizedUsage, allocations: (ReceiptWindow & { consumed: number })[]) =>
  sha256(canonicalJson({ format: "successful-settlement-v1", ...context, usage, allocations }));
export const failureReceipt = (context: ReceiptContext, failure: NormalizedFailure, allocations: (ReceiptWindow & FailureAllocation)[]) =>
  sha256(canonicalJson({ format: "failure-accounting-v1", ...context, failure, allocations }));
