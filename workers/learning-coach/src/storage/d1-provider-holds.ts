import { capacityLimit, providerPolicyJson, safeInteger, validateProviderPolicy, windowSeconds, type ProviderCapacityPolicy } from "../config/provider-policy";
import type { ExpiredHoldCursor, ProviderHoldDecision, ProviderHoldDenial, ProviderHoldObservation, ProviderHoldResolution,
  ProviderHolds, ProviderHoldView, QuotaMetric } from "../storage";
import type { D1Binding, D1Statement } from "./d1-quota-admission";
import { policyWindows } from "./d1-quota-provisioning";
import { applicableHoldPredicate, currentPolicyPredicate } from "./provider-availability";
import { holdConfidence, holdIdValid, normalizeHoldObservation, normalizeHoldResolution, operationIdValid } from "./provider-hold-evidence";
import { canonicalJson, sha256 } from "./request-identity";

const MAX = Number.MAX_SAFE_INTEGER;
const deny = (state: ProviderHoldDenial["state"]): ProviderHoldDenial => ({ state, retryable: false });
type HoldRow = { hold_key: string; model: string; reason_code: string; source_class: string; evidence_at: number; evidence_hash: string | null;
  hold_until: number | null; confidence: number; policy_version: number | null; revision: number; status: string;
  created_at: number; updated_at: number; retain_until: number; quota_metric: QuotaMetric | null; unit: string | null;
  window_seconds: number | null; quota_window_id: string | null };
type Receipt = { operation_hash: string; quota_scope_id: string; provider: string; model: string; hold_key: string; action: "record" | "resolve"; revision: number };
const view = (h: HoldRow): ProviderHoldView => ({ holdId: h.hold_key, model: h.model, reason: h.reason_code, source: h.source_class,
  observedAt: h.evidence_at, until: h.hold_until, revision: h.revision, metric: h.quota_metric,
  unit: h.unit, windowSeconds: h.window_seconds, windowId: h.quota_window_id });
const assertSQL = "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('provider_hold_conflict') END AS checked";

// Only trusted internal composition can construct this service. It is not
// exposed by a route, browser API, environment enable flag or provider parser.
export class D1ProviderHolds implements ProviderHolds {
  private readonly policy: ProviderCapacityPolicy;
  constructor(private readonly db: D1Binding | undefined, policy: ProviderCapacityPolicy, private readonly clock?: () => number,
    private readonly writeGate?: () => Promise<D1Statement>) {
    this.policy = structuredClone(policy);
  }

  private async time(db: D1Binding): Promise<number> {
    const r = this.clock ? undefined : await db.prepare("SELECT unixepoch() AS now").all<{ now: number }>();
    const now = this.clock ? this.clock() : r?.results[0]?.now;
    if ((!this.clock && (!r?.success || r.results.length !== 1)) || !safeInteger(now)) throw new Error("Clock unavailable");
    return now;
  }
  private clockSQL(now: number): string { return this.clock ? String(now) : "unixepoch()"; }
  private async receipt(db: D1Binding, id: string, hash?: string): Promise<ProviderHoldDecision | undefined> {
    const r = await db.prepare("SELECT * FROM provider_hold_operations WHERE operation_id = ?").bind(id).all<Receipt>();
    if (!r.success) throw new Error("Receipt unavailable");
    const row = r.results[0];
    if (!row) return;
    if (row.quota_scope_id !== this.policy.quotaScopeId || row.provider !== this.policy.provider ||
        !["", this.policy.model].includes(row.model) || (hash !== undefined && hash !== row.operation_hash)) return deny("conflict");
    return { state: row.action === "record" ? "already_recorded" : "already_resolved", holdId: row.hold_key, revision: row.revision };
  }
  async inspectOperation(operationId: string): Promise<ProviderHoldDecision> {
    if (!operationIdValid(operationId)) return deny("invalid_evidence");
    if (!this.db) return deny("storage_unavailable");
    try { return await this.receipt(this.db, operationId) ?? deny("not_found"); }
    catch { return deny("storage_unavailable"); }
  }

  private policyGate(db: D1Binding, p: ProviderCapacityPolicy, hash: string, now: number): D1Statement {
    const predicate = currentPolicyPredicate("?1", "?2", "?3", "?4", "?5", "?6", this.clockSQL(now));
    return db.prepare(`SELECT CASE WHEN ${predicate} THEN 1 ELSE json('provider_hold_policy_conflict') END AS checked`)
      .bind(p.quotaScopeId, p.provider, p.model, p.version, hash, p.reviewAfter);
  }
  private async inspectPolicy(db: D1Binding, p: ProviderCapacityPolicy, hash: string, now: number): Promise<ProviderHoldDenial | undefined> {
    try {
      const r = await this.policyGate(db, p, hash, now).all<{ checked: number }>();
      if (!r.success || r.results[0]?.checked !== 1) return deny("storage_unavailable");
    } catch (error) {
      return deny(error instanceof Error && /malformed JSON/.test(error.message) ? "policy_unavailable" : "storage_unavailable");
    }
  }
  private operation(db: D1Binding, e: ProviderHoldObservation | ProviderHoldResolution, key: string, hash: string,
    action: "record" | "resolve", revision: number, now: number, retain: number): D1Statement {
    return db.prepare(`INSERT INTO provider_hold_operations
      (operation_id, operation_hash, quota_scope_id, provider, model, hold_key, action, revision, recorded_at, retain_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(e.operationId, hash, e.quotaScopeId, e.provider, e.model, key, action, revision, now, retain);
  }
  private async execute(db: D1Binding, e: ProviderHoldObservation | ProviderHoldResolution, hash: string,
    key: string, revision: number, action: "record" | "resolve", statements: D1Statement[], writes: Set<number>): Promise<ProviderHoldDecision> {
    try {
      const r = await db.batch<{ checked: number }>(statements);
      if (r.length !== statements.length || r.some((row, i) => !row.success ||
          (writes.has(i) ? row.meta.changes !== 1 : row.meta.changes !== 0 || row.results[0]?.checked !== 1))) {
        return await this.receipt(db, e.operationId, hash) ?? deny("storage_unavailable");
      }
      return { state: action === "record" ? "recorded" : "resolved", holdId: key, revision };
    } catch (error) {
      // Inspect a possible committed receipt; never blindly repeat an uncertain
      // mutation. Only the original immutable operation can confirm success.
      try {
        const receipt = await this.receipt(db, e.operationId, hash);
        if (receipt) return receipt;
      } catch { return deny("storage_unavailable"); }
      return deny(error instanceof Error && /malformed JSON|UNIQUE constraint/.test(error.message) ? "conflict" : "storage_unavailable");
    }
  }
  private async readHold(db: D1Binding, model: string, key: string): Promise<HoldRow | undefined> {
    const r = await db.prepare(`SELECT * FROM provider_holds WHERE quota_scope_id = ? AND provider = ? AND model = ? AND hold_key = ?`)
      .bind(this.policy.quotaScopeId, this.policy.provider, model, key).all<HoldRow>();
    if (!r.success) throw new Error("Hold unavailable");
    return r.results[0];
  }
  private validRow(row: HoldRow, now: number): boolean {
    return [row.revision, row.evidence_at, row.created_at, row.updated_at, row.retain_until].every(safeInteger) &&
      row.revision > 0 && row.revision < MAX && row.updated_at <= now && row.created_at <= row.updated_at &&
      row.evidence_at <= row.updated_at && row.retain_until >= row.updated_at &&
      (row.hold_until === null || (safeInteger(row.hold_until) && row.retain_until >= row.hold_until)) &&
      [1, 2, 3].includes(row.confidence) && ["active", "released"].includes(row.status);
  }
  private compare(row: HoldRow): { sql: string; values: (string | number | null)[] } {
    return { sql: "revision = ? AND evidence_hash IS ? AND evidence_at = ? AND status = ? AND hold_until IS ? AND confidence = ? AND policy_version IS ? AND updated_at = ?",
      values: [row.revision, row.evidence_hash, row.evidence_at, row.status, row.hold_until, row.confidence, row.policy_version, row.updated_at] };
  }

  async record(input: unknown): Promise<ProviderHoldDecision> {
    const db = this.db;
    if (!db) return deny("storage_unavailable");
    try {
      const now = await this.time(db), valid = validateProviderPolicy(this.policy, now);
      if (valid.state !== "valid") return deny("policy_unavailable");
      const p = valid.policy, e = normalizeHoldObservation(input, p, now);
      if (!e) return deny("invalid_evidence");
      const { operationId: _operation, ...observation } = e;
      const evidenceHash = await sha256(canonicalJson(observation));
      const operationHash = await sha256(canonicalJson(["record", e]));
      const existing = await this.receipt(db, e.operationId, operationHash);
      if (existing) return existing;
      const key = `ph1.${await sha256(canonicalJson([e.quotaScopeId, e.provider, e.model, e.dimension ?? null, e.reason]))}`;
      const old = await this.readHold(db, e.model, key);
      if (old && !this.validRow(old, now)) return deny("conflict");
      const duplicate = old?.status === "active" && old.evidence_hash === evidenceHash;
      if (!duplicate && e.until !== null && e.until <= now) return deny("invalid_evidence");
      if (old && !duplicate && e.observedAt <= old.evidence_at) return deny(e.observedAt === old.evidence_at ? "conflict" : "stale_evidence");
      const hash = await sha256(providerPolicyJson(p));
      // Validate the durable policy even when the supplied in-memory policy is valid.
      const policyProblem = await this.inspectPolicy(db, p, hash, now);
      if (policyProblem) return policyProblem;
      const active = old?.status === "active" && (old.hold_until === null || old.hold_until > now);
      const until = active ? old.hold_until === null || e.until === null ? null : Math.max(old.hold_until, e.until) : e.until;
      const confidence = active ? Math.max(old.confidence, holdConfidence(e.source)) : holdConfidence(e.source);
      const source = active && old.confidence > holdConfidence(e.source) ? old.source_class : e.source;
      const revision = duplicate ? old.revision : (old?.revision ?? 0) + 1;
      const retain = Math.max(old?.retain_until ?? 0, now + p.retentionSeconds, until ?? now);
      const statements: D1Statement[] = [this.policyGate(db, p, hash, now)];
      if (this.writeGate) statements.push(await this.writeGate());
      const writes = new Set<number>();
      const write = (s: D1Statement) => { writes.add(statements.length); statements.push(s, db.prepare(assertSQL)); };
      if (duplicate) {
        const c = this.compare(old);
        statements.push(db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM provider_holds WHERE quota_scope_id = ? AND provider = ?
          AND model = ? AND hold_key = ? AND ${c.sql}) THEN 1 ELSE json('provider_hold_conflict') END AS checked`)
          .bind(p.quotaScopeId, p.provider, e.model, key, ...c.values));
      } else {
        // Bound window evidence must match the persisted scope and period. An
        // indefinite hold cannot be tied to a window and disappear at rollover.
        if (e.dimension?.windowId) {
          statements.push(db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM provider_quota_windows WHERE id = ? AND quota_scope_id = ?
            AND provider = ? AND model = ? AND quota_metric = ? AND unit = ? AND window_seconds = ?
            AND window_start <= ? AND ? < window_end AND ? <= window_end)
            THEN 1 ELSE json('provider_hold_window_conflict') END AS checked`)
            .bind(e.dimension.windowId, p.quotaScopeId, p.provider, e.model, e.dimension.metric, e.dimension.unit,
              e.dimension.windowSeconds, e.observedAt, e.observedAt, e.until));
        }
        statements.push(db.prepare(`SELECT CASE WHEN ? IS NULL OR ? > ${this.clockSQL(now)} THEN 1 ELSE json('provider_hold_expired') END AS checked`)
          .bind(e.until, e.until));
        if (!old) write(db.prepare(`INSERT INTO provider_holds (quota_scope_id, provider, model, status, reason_code, hold_until,
          created_at, updated_at, retain_until, hold_key, source_class, evidence_at, evidence_hash, confidence, policy_version,
          plan, quota_metric, unit, window_seconds, quota_window_id, revision)
          VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'free', ?, ?, ?, ?, 1)`)
          .bind(p.quotaScopeId, p.provider, e.model, e.reason, until, now, now, retain, key, source, e.observedAt,
            evidenceHash, confidence, p.version, e.dimension?.metric ?? null, e.dimension?.unit ?? null,
            e.dimension?.windowSeconds ?? null, e.dimension?.windowId ?? null));
        else {
          const c = this.compare(old);
          write(db.prepare(`UPDATE provider_holds SET status = 'active', hold_until = ?, updated_at = ?, retain_until = ?,
            source_class = ?, evidence_at = ?, evidence_hash = ?, confidence = ?, policy_version = ?, revision = ?
            WHERE quota_scope_id = ? AND provider = ? AND model = ? AND hold_key = ? AND ${c.sql}`)
            .bind(until, now, retain, source, e.observedAt, evidenceHash, confidence, p.version, revision,
              p.quotaScopeId, p.provider, e.model, key, ...c.values));
        }
      }
      write(this.operation(db, e, key, operationHash, "record", revision, now, retain));
      return await this.execute(db, e, operationHash, key, revision, "record", statements, writes);
    } catch { return deny("storage_unavailable"); }
  }

  async resolve(input: unknown): Promise<ProviderHoldDecision> {
    const db = this.db;
    if (!db) return deny("storage_unavailable");
    try {
      const now = await this.time(db), valid = validateProviderPolicy(this.policy, now);
      if (valid.state !== "valid") return deny("policy_unavailable");
      const p = valid.policy, e = normalizeHoldResolution(input, p, now);
      if (!e) return deny("invalid_evidence");
      const hash = await sha256(canonicalJson(["resolve", e]));
      const receipt = await this.receipt(db, e.operationId, hash);
      if (receipt) return receipt;
      const old = await this.readHold(db, e.model, e.holdId);
      if (!old) return deny("not_found");
      if (!this.validRow(old, now) || old.revision !== e.expectedRevision || old.status !== "active") return deny("conflict");
      if (e.observedAt <= old.evidence_at || holdConfidence(e.source) < old.confidence) return deny("stale_evidence");
      if ((e.reason === "capacity_available" && old.quota_metric === null) ||
          (e.reason === "availability_restored" && old.quota_metric !== null) ||
          (e.reason === "policy_reviewed" && p.version <= (old.policy_version ?? 0))) return deny("invalid_evidence");
      if (e.source === "verified_quota" && !old.reason_code.endsWith("_exhausted")) return deny("invalid_evidence");
      if (e.remaining !== undefined) {
        const dimension = p.dimensions.find(d => d.metric === old.quota_metric && d.unit === old.unit && windowSeconds(d.window) === old.window_seconds);
        if (!dimension || e.remaining > capacityLimit(dimension)) return deny("invalid_evidence");
      }
      const policyHash = await sha256(providerPolicyJson(p));
      const policyProblem = await this.inspectPolicy(db, p, policyHash, now);
      if (policyProblem) return policyProblem;
      const c = this.compare(old), revision = old.revision + 1, retain = Math.max(old.retain_until, now + p.retentionSeconds);
      const statements = [this.policyGate(db, p, policyHash, now), db.prepare(`UPDATE provider_holds SET status = 'released',
        updated_at = ?, retain_until = ?, evidence_at = ?, evidence_hash = ?, source_class = ?, confidence = ?, policy_version = ?, revision = ?, plan = 'free'
        WHERE quota_scope_id = ? AND provider = ? AND model = ? AND hold_key = ? AND ${c.sql}`)
        .bind(now, retain, e.observedAt, hash, e.source, holdConfidence(e.source), p.version, revision,
          p.quotaScopeId, p.provider, e.model, e.holdId, ...c.values), db.prepare(assertSQL),
        this.operation(db, e, e.holdId, hash, "resolve", revision, now, retain), db.prepare(assertSQL)];
      return await this.execute(db, e, hash, e.holdId, revision, "resolve", statements, new Set([1, 3]));
    } catch { return deny("storage_unavailable"); }
  }

  async inspectApplicable(): Promise<{ state: "inspected"; holds: ProviderHoldView[]; truncated: boolean } | ProviderHoldDenial> {
    const db = this.db;
    if (!db) return deny("storage_unavailable");
    try {
      const now = await this.time(db), valid = validateProviderPolicy(this.policy, now);
      if (valid.state !== "valid") return deny("policy_unavailable");
      const p = valid.policy, windows = await policyWindows(p, now);
      const policyProblem = await this.inspectPolicy(db, p, await sha256(providerPolicyJson(p)), now);
      if (policyProblem) return policyProblem;
      const r = await db.prepare(`SELECT h.* FROM provider_holds h WHERE ${applicableHoldPredicate("?1", "?2", "?3", "?4", "?5")}
        ORDER BY h.model, h.hold_key LIMIT 65`).bind(p.quotaScopeId, p.provider, p.model, canonicalJson(windows), now).all<HoldRow>();
      if (!r.success) return deny("storage_unavailable");
      return { state: "inspected", holds: r.results.slice(0, 64).map(view), truncated: r.results.length > 64 };
    } catch { return deny("storage_unavailable"); }
  }
  async expired(limit: number, after?: ExpiredHoldCursor): Promise<{ state: "page"; holds: ProviderHoldView[]; nextCursor: ExpiredHoldCursor | null } | ProviderHoldDenial> {
    if (!safeInteger(limit) || limit < 1 || limit > 20 || (after && (!safeInteger(after.until) ||
        !["", this.policy.model].includes(after.model) || !holdIdValid(after.holdId)))) return deny("invalid_evidence");
    const db = this.db;
    if (!db) return deny("storage_unavailable");
    try {
      const now = await this.time(db), p = this.policy;
      if (after && after.until > now) return deny("invalid_evidence");
      const r = await db.prepare(`SELECT * FROM provider_holds WHERE quota_scope_id = ?1 AND provider = ?2
        AND model IN ('', ?3) AND status = 'active' AND hold_until <= ?4
        AND (?5 IS NULL OR (hold_until, model, hold_key) > (?5, ?6, ?7))
        ORDER BY hold_until, model, hold_key LIMIT ?8`)
        .bind(p.quotaScopeId, p.provider, p.model, now, after?.until ?? null, after?.model ?? null, after?.holdId ?? null, limit + 1).all<HoldRow>();
      if (!r.success) return deny("storage_unavailable");
      const rows = r.results.slice(0, limit), last = rows.at(-1);
      return { state: "page", holds: rows.map(view), nextCursor: r.results.length > limit && last ?
        { until: last.hold_until!, model: last.model, holdId: last.hold_key } : null };
    } catch { return deny("storage_unavailable"); }
  }
}
