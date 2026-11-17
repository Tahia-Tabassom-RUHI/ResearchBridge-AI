import type { D1Binding, D1Statement } from "./d1-quota-admission";
import { canonicalJson } from "./request-identity";

// Compare the exact classified rows again inside the mutation transaction.
// Query text and column names come only from internal SELECTs. No public SQL.
export function snapshotGate(db: D1Binding, q: { sql: string; values: (string | number | null)[] }, rows: object[]): D1Statement {
  const keys = Object.keys(rows[0] ?? {}).filter(k => k !== "now");
  if (keys.some(k => !/^[a-z_]+$/.test(k))) throw new Error("Invalid snapshot column");
  const parameter = `?${q.values.length + 1}`;
  // D1 limits expression depth; balance wide reservation/owner comparisons.
  const balanced = (terms: string[]): string => terms.length < 2 ? terms[0] ?? "1" :
    `(${balanced(terms.slice(0, Math.floor(terms.length / 2)))} AND ${balanced(terms.slice(Math.floor(terms.length / 2)))})`;
  const match = balanced(keys.map(k => `q.${k} IS json_extract(e.value, '$.${k}')`));
  return db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM (${q.sql})) = json_array_length(${parameter})
    AND NOT EXISTS (SELECT 1 FROM (${q.sql}) q WHERE NOT EXISTS (SELECT 1 FROM json_each(${parameter}) e WHERE ${match}))
    THEN 1 ELSE json('evidence_resolution_conflict') END AS checked`).bind(...q.values, canonicalJson(rows));
}
