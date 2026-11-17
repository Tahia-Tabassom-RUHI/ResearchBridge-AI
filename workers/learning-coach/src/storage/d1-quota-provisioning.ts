import type { QuotaAdmissionPolicy, QuotaProvisioningResult, QuotaWindowPolicy, QuotaWindowProvisioning } from "../storage";
import { capacityLimit, dimensionKey, resetBounds, safeInteger, validateProviderPolicy, windowSeconds,
  type ProviderCapacityPolicy } from "../config/provider-policy";
import { canonicalJson, sha256 } from "./request-identity";
import type { D1Binding, D1Statement } from "./d1-quota-admission";

type Receipt = { model: string; version: number; policy_hash: string; topology_hash: string; verified_at: number; revoked: number };
type Window = { id: string; quota_scope_id: string; provider: string; model: string; dimension: string;
  quota_metric: string | null; unit: string; window_seconds: number; window_start: number; window_end: number;
  limit_amount: number; safety_margin: number; reserved_amount: number; consumed_amount: number;
  created_at: number; updated_at: number; retain_until: number; status: string };
const MAX = Number.MAX_SAFE_INTEGER;
const storage = { state: "storage_unavailable" } as const;
const unsafe = { state: "unsafe_change" } as const;
const dimension = (metric: string) => ["input_tokens", "output_tokens"].includes(metric) ? "tokens" : metric;

export async function policyWindows(p: ProviderCapacityPolicy, now: number): Promise<QuotaWindowPolicy[]> {
  return Promise.all(p.dimensions.map(async d => {
    const { start } = resetBounds(d.window, now), seconds = windowSeconds(d.window);
    // Cloudflare allocation is shared across Workers AI models, not multiplied
    // per selected model. The receipt pins the selected model for this stage.
    const model = p.provider === "cloudflare_workers_ai" ? "" : p.model;
    const windowId = `qw1.${await sha256(canonicalJson([p.quotaScopeId, p.provider, model, d.metric, d.unit, seconds, start]))}`;
    return { windowId, model, metric: d.metric, unit: d.unit, capacity: capacityLimit(d), safetyMargin: d.safetyMargin,
      windowStart: start, windowSeconds: seconds };
  }));
}

function validWindow(row: Window, w: QuotaWindowPolicy, p: ProviderCapacityPolicy, now: number): boolean {
  return row.id === w.windowId && row.quota_scope_id === p.quotaScopeId && row.provider === p.provider && row.model === w.model &&
    row.quota_metric === w.metric && row.dimension === dimension(w.metric) && row.unit === w.unit && row.status === "open" &&
    row.window_start === w.windowStart && row.window_seconds === w.windowSeconds && row.window_end === w.windowStart + w.windowSeconds &&
    [row.limit_amount, row.safety_margin, row.reserved_amount, row.consumed_amount, row.created_at, row.updated_at, row.retain_until].every(safeInteger) &&
    row.created_at <= row.updated_at && row.updated_at <= now && row.retain_until >= row.window_end && row.retain_until >= row.updated_at &&
    row.safety_margin <= row.limit_amount;
}

// No gateway composition, provider SDK, networking, scheduling, header parsing,
// holds or implicit default capacity. An omitted binding always fails closed.
export class D1QuotaProvisioning implements QuotaWindowProvisioning {
  constructor(private readonly db: D1Binding | undefined, private readonly clock?: () => number) {}

  async provision(trustedPolicy: unknown): Promise<QuotaProvisioningResult> {
    const db = this.db;
    if (!db) return storage;
    try {
      // Production uses D1 UTC time. Injection is internal and only used by local
      // tests; there is no caller-supplied time or historical range parameter.
      let time: number | undefined;
      if (this.clock) time = this.clock();
      else {
        const clockRead = await db.prepare("SELECT unixepoch() AS now").all<{ now: number }>();
        if (!clockRead.success || clockRead.results.length !== 1) return storage;
        time = clockRead.results[0]?.now;
      }
      if (!safeInteger(time)) return storage;
      const checked = validateProviderPolicy(trustedPolicy, time);
      if (checked.state !== "valid") return checked;
      const p = checked.policy, now = time;
      p.dimensions.sort((a, b) => dimensionKey(a) < dimensionKey(b) ? -1 : dimensionKey(a) > dimensionKey(b) ? 1 : 0);
      const windows = await policyWindows(p, now);
      if (windows.some(w => !safeInteger(w.windowStart + w.windowSeconds + p.retentionSeconds))) return { state: "invalid_policy" };
      const policy: QuotaAdmissionPolicy = { provider: p.provider, model: p.model, quotaScopeId: p.quotaScopeId,
        leaseSeconds: p.leaseSeconds, retentionSeconds: p.retentionSeconds, windows };
      const json = canonicalJson(p), hash = await sha256(json);
      policy.providerPolicy = { version: p.version, hash, reviewAfter: p.reviewAfter };
      const topology = await sha256(canonicalJson(p.dimensions.map(d => [d.metric, d.unit, d.window])));
      const identities = canonicalJson(windows.map(w => w.windowId));
      // Never silently migrate an overlapping legacy/unmanaged allocation to
      // new identities. Even empty legacy windows require an explicit review.
      const unmanaged = `SELECT 1 FROM provider_quota_windows WHERE quota_scope_id = ? AND provider = ?
        AND window_end > ? AND window_start <= ? AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`;
      const reads = await db.batch([
        db.prepare(`SELECT model, version, policy_hash, topology_hash, verified_at,
          EXISTS (SELECT 1 FROM provider_policy_revocations v WHERE v.quota_scope_id = provider_capacity_policies.quota_scope_id
            AND v.provider = provider_capacity_policies.provider) AS revoked FROM provider_capacity_policies
          WHERE quota_scope_id = ? AND provider = ?`).bind(p.quotaScopeId, p.provider),
        ...windows.map(w => db.prepare("SELECT * FROM provider_quota_windows WHERE id = ?").bind(w.windowId)),
        db.prepare(unmanaged).bind(p.quotaScopeId, p.provider, now, now, identities),
      ]);
      if (reads.length !== windows.length + 2 || reads.some(r => !r.success)) return storage;
      if (reads.at(-1)!.results.length) return unsafe;
      const receipt = reads[0]!.results[0] as Receipt | undefined;
      if (receipt?.revoked) return { state: "disabled" };
      if (receipt && (receipt.model !== p.model || receipt.topology_hash !== topology || !safeInteger(receipt.version) ||
          receipt.version > p.version || receipt.verified_at > p.verifiedAt || (receipt.version === p.version && receipt.policy_hash !== hash))) return unsafe;
      const rows = reads.slice(1, -1).map(r => r.results[0] as Window | undefined);
      let changed = !receipt || receipt.policy_hash !== hash;
      for (const [i, w] of windows.entries()) {
        const row = rows[i];
        if (!row) { changed = true; continue; }
        if (!validWindow(row, w, p, now) || w.capacity > row.limit_amount ||
            w.capacity - w.safetyMargin > row.limit_amount - row.safety_margin ||
            row.consumed_amount > w.capacity - w.safetyMargin ||
            row.reserved_amount > w.capacity - w.safetyMargin - row.consumed_amount) return unsafe;
        if (w.capacity !== row.limit_amount || w.safetyMargin !== row.safety_margin) changed = true;
      }
      if (!changed) return { state: "provisioned", policy }; // Zero repeated writes.

      const statements: D1Statement[] = [];
      const expected: ("write" | "check")[] = [];
      // A zero-row conditional write must abort the entire transaction, including
      // earlier dimensions. This unconditional SQL assertion cannot miss a row.
      const write = (s: D1Statement) => {
        statements.push(s, db.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('quota_provisioning_conflict') END AS checked"));
        expected.push("write", "check");
      };
      write(db.prepare(`INSERT INTO provider_capacity_policies
        (quota_scope_id, provider, model, version, policy_hash, topology_hash, policy_json, verified_at, review_after, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
        WHERE NOT EXISTS (SELECT 1 FROM provider_quota_windows WHERE quota_scope_id = ?1 AND provider = ?2
          AND window_end > ?10 AND window_start <= ?10 AND id NOT IN (SELECT value FROM json_each(?11)))
        ON CONFLICT (quota_scope_id, provider) DO UPDATE SET version = excluded.version,
          policy_hash = excluded.policy_hash, policy_json = excluded.policy_json,
          verified_at = excluded.verified_at, review_after = excluded.review_after, updated_at = excluded.updated_at
        WHERE provider_capacity_policies.model = excluded.model AND provider_capacity_policies.topology_hash = excluded.topology_hash
          AND provider_capacity_policies.verified_at <= excluded.verified_at
          AND (provider_capacity_policies.version < excluded.version OR
            (provider_capacity_policies.version = excluded.version AND provider_capacity_policies.policy_hash = excluded.policy_hash))
          AND provider_capacity_policies.updated_at <= excluded.updated_at`)
        .bind(p.quotaScopeId, p.provider, p.model, p.version, hash, topology, json, p.verifiedAt, p.reviewAfter, now, identities));
      for (const [i, w] of windows.entries()) {
        const row = rows[i];
        if (row && row.limit_amount === w.capacity && row.safety_margin === w.safetyMargin) {
          // Recheck unchanged windows inside the transaction, without writing
          // their timestamps/indexes on another dimension's rollover.
          statements.push(db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM provider_quota_windows
            WHERE id = ? AND quota_scope_id = ? AND provider = ? AND model = ? AND quota_metric = ?
              AND unit = ? AND dimension = ? AND window_start = ? AND window_seconds = ? AND window_end = ?
              AND limit_amount = ? AND safety_margin = ? AND status = 'open'
              AND created_at BETWEEN 0 AND updated_at AND updated_at <= ? AND retain_until >= updated_at
              AND retain_until BETWEEN window_end AND ${MAX}
              AND consumed_amount BETWEEN 0 AND limit_amount - safety_margin
              AND consumed_amount = CAST(consumed_amount AS INTEGER)
              AND reserved_amount BETWEEN 0 AND limit_amount - safety_margin - consumed_amount
              AND reserved_amount = CAST(reserved_amount AS INTEGER))
            THEN 1 ELSE json('quota_provisioning_conflict') END AS checked`)
            .bind(w.windowId, p.quotaScopeId, p.provider, w.model, w.metric, w.unit, dimension(w.metric),
              w.windowStart, w.windowSeconds, w.windowStart + w.windowSeconds, w.capacity, w.safetyMargin, now));
          expected.push("check");
          continue;
        }
        write(db.prepare(`INSERT INTO provider_quota_windows
          (id, quota_scope_id, provider, model, dimension, unit, window_seconds, window_start, window_end,
           limit_amount, safety_margin, created_at, updated_at, retain_until, quota_metric)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14)
          ON CONFLICT (id) DO UPDATE SET limit_amount = excluded.limit_amount, safety_margin = excluded.safety_margin,
            updated_at = excluded.updated_at, retain_until = max(provider_quota_windows.retain_until, excluded.retain_until)
          WHERE provider_quota_windows.quota_scope_id = excluded.quota_scope_id AND provider_quota_windows.provider = excluded.provider
            AND provider_quota_windows.model = excluded.model AND provider_quota_windows.dimension = excluded.dimension
            AND provider_quota_windows.quota_metric = excluded.quota_metric AND provider_quota_windows.unit = excluded.unit
            AND provider_quota_windows.window_seconds = excluded.window_seconds AND provider_quota_windows.window_start = excluded.window_start
            AND provider_quota_windows.window_end = excluded.window_end AND provider_quota_windows.status = 'open'
            AND provider_quota_windows.window_start <= ?12 AND ?12 < provider_quota_windows.window_end
            AND provider_quota_windows.created_at BETWEEN 0 AND provider_quota_windows.updated_at
            AND provider_quota_windows.updated_at <= ?12 AND provider_quota_windows.retain_until BETWEEN provider_quota_windows.window_end AND ${MAX}
            AND provider_quota_windows.retain_until >= provider_quota_windows.updated_at
            AND provider_quota_windows.limit_amount BETWEEN ?10 AND ${MAX}
            AND provider_quota_windows.limit_amount = CAST(provider_quota_windows.limit_amount AS INTEGER)
            AND provider_quota_windows.safety_margin BETWEEN 0 AND provider_quota_windows.limit_amount
            AND ?10 - ?11 <= CAST(provider_quota_windows.limit_amount AS INTEGER) - provider_quota_windows.safety_margin
            AND provider_quota_windows.consumed_amount BETWEEN 0 AND ?10 - ?11
            AND provider_quota_windows.consumed_amount = CAST(provider_quota_windows.consumed_amount AS INTEGER)
            AND provider_quota_windows.reserved_amount BETWEEN 0 AND ?10 - ?11 - CAST(provider_quota_windows.consumed_amount AS INTEGER)
            AND provider_quota_windows.reserved_amount = CAST(provider_quota_windows.reserved_amount AS INTEGER)`)
          .bind(w.windowId, p.quotaScopeId, p.provider, w.model, dimension(w.metric), w.unit, w.windowSeconds,
            w.windowStart, w.windowStart + w.windowSeconds, w.capacity, w.safetyMargin, now,
            w.windowStart + w.windowSeconds + p.retentionSeconds, w.metric));
      }
      const result = await db.batch<{ checked: number }>(statements);
      if (result.length !== statements.length || result.some((r, i) => !r.success ||
          (expected[i] === "write" ? r.meta.changes !== 1 : r.meta.changes !== 0 || r.results[0]?.checked !== 1))) return storage;
      return { state: "provisioned", policy };
    } catch (error) {
      // Never retry an uncertain write as an unmetered request. A deliberate
      // retry can inspect the durable receipt/counters without resetting them.
      if (error instanceof Error && (error.message.includes("malformed JSON") || error.message.includes("UNIQUE constraint"))) return { state: "conflict" };
      return storage;
    }
  }
}
