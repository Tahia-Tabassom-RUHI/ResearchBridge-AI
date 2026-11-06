import shared from "../../../contracts/learning-coach/fixtures/cases.json";
import { buildResponse, validateRequest, validateResponse, validateV1Response } from "../src/contracts/index";
import { ContractError } from "../src/errors/index";

export interface ContractCase {
  name: string;
  operation: "v1_response" | "v2_request" | "v2_output" | "v2_response";
  request?: unknown; output?: unknown; value?: unknown; abstract?: string;
  verified_sources?: Record<string, unknown>;
  expected_error?: string | null;
}
export const sharedCases = shared.cases as ContractCase[];
export function fixture(name: string): ContractCase {
  const found = sharedCases.find(item => item.name === name);
  if (!found) throw new Error("Fixture not found");
  return structuredClone(found);
}
export function execute(item: ContractCase): unknown {
  const sources = new Map(Object.entries(item.verified_sources ?? {}));
  if (item.operation === "v1_response") return validateV1Response(item.value, item.abstract!);
  if (item.operation === "v2_request") return validateRequest(item.request, sources);
  if (item.operation === "v2_output") return buildResponse(item.request, item.output, sources);
  return validateResponse(item.request, item.value, sources);
}
export function outcome(item: ContractCase): { name: string; valid: boolean; error?: string } {
  try { execute(item); return { name: item.name, valid: true }; }
  catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return { name: item.name, valid: false, error: item.operation === "v1_response" ? "invalid_v1" : error.code };
  }
}

export function boundaryCases(): ContractCase[] {
  const cases: ContractCase[] = [];
  const term = fixture("term_clarification").request as Record<string, unknown>;
  for (const field of ["contract_version", "task_id", "input"]) {
    const request = structuredClone(term); delete request[field];
    cases.push({ name: `missing_${field}`, operation: "v2_request", request });
  }
  for (const version of [null, 2, true, "1", "2.0", "../../x"]) cases.push({ name: `version_${JSON.stringify(version)}`, operation: "v2_request", request: { ...term, contract_version: version } });
  for (const input of [{}, { term: "classification", paper_id: "invented" }, { term: "classification", verified: true }]) cases.push({ name: `term_fields_${JSON.stringify(input)}`, operation: "v2_request", request: { ...term, input } });
  const base = execute(fixture("abstract_one_section")) as { output: { sections: { id: string; explanation: string; supporting_excerpt: string | null }[] }; source_coverage: { origin: string; full_paper_verified: boolean }; contract_version: string };
  const request = fixture("abstract_one_section").request;
  for (const kind of ["coverage", "full_paper", "duplicate_id", "empty", "number", "unbacked", "version", "final_lf_id", "final_cr_id", "final_ls_id"]) {
    const value = structuredClone(base);
    if (kind === "coverage") value.source_coverage.origin = "verified_retrieval";
    if (kind === "full_paper") value.source_coverage.full_paper_verified = true;
    if (kind === "duplicate_id") value.output.sections.push(structuredClone(value.output.sections[0]!));
    if (kind === "empty") value.output.sections = [];
    if (kind === "number") value.output.sections[0]!.explanation = "The abstract reports 99% accuracy.";
    if (kind === "unbacked") value.output.sections[0]!.supporting_excerpt = null;
    if (kind === "version") value.contract_version = "3";
    if (kind.startsWith("final_")) value.output.sections[0]!.id += kind === "final_lf_id" ? "\n" : kind === "final_cr_id" ? "\r" : "\u2028";
    cases.push({ name: kind, operation: "v2_response", request, value });
  }
  for (const [source, excerpt] of [["Straße", "STRASSE"], ["ΟΣ", "οσ"], ["ﬀ", "ff"], ["İ", "i\u0307"], ["Ꭰ", "ꭰ"], ["A\u001cB\u00a0C", "a b c"], ["A\ufeffB", "a b"]]) {
    const legacy = fixture("legacy_v1");
    const pack = legacy.value as Record<string, { explanation: string; supporting_excerpt: string | null }>;
    legacy.abstract += ` ${source}`;
    pack.method = { explanation: "The source includes literal text.", supporting_excerpt: excerpt! };
    cases.push({ ...legacy, name: `legacy_unicode_${source}` });
  }
  for (const [source, claim] of [["٢٠", "٢٠"], ["٢٠", "٢١"], ["A20", "20"], ["20", "A20"], ["20.5%", "20.5%"], ["20.5%", "20.6%"]]) {
    const legacy = fixture("legacy_v1");
    legacy.abstract += ` ${source}`;
    const pack = legacy.value as Record<string, { explanation: string; supporting_excerpt: string | null }>;
    pack.method = { explanation: `The source reports ${claim}.`, supporting_excerpt: source! };
    cases.push({ ...legacy, name: `legacy_numeric_${source}_${claim}` });
  }
  for (const count of [200, 201]) cases.push({ name: `codepoints_${count}`, operation: "v2_request", request: { ...term, input: { term: "🧪".repeat(count) } } });
  const unknown = fixture("unknown_paper_reference");
  cases.push({ ...unknown, name: "prototype_source", request: { contract_version: "2", task_id: "abstract_explanation", input: { source: { kind: "retrieved_paper", source_id: "constructor" } } } });
  cases.push({ ...fixture("retrieved_abstract"), name: "invalid_retrieval", verified_sources: { fixture_source: { title: "unverified" } } });
  return cases;
}
