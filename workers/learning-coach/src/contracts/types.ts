export type TaskId = "abstract_explanation" | "learning_hints" | "term_clarification";
export type Source =
  | { kind: "user_abstract"; title: string; abstract?: string | null }
  | { kind: "retrieved_paper"; source_id: string };
export type LearnerContext = { level?: "beginner" | "intermediate" | "advanced"; learning_goal?: string };
export type CoachRequest = {
  contract_version: "2";
  learner_context?: LearnerContext;
} & (
  | { task_id: "abstract_explanation"; input: { source: Source } }
  | { task_id: "learning_hints"; input: { source: Source; question: string } }
  | { task_id: "term_clarification"; input: { term: string } }
);
export type SourceText = { title: string; abstract: string };
export type RetrievedSource = {
  paper_id: string; title: string; abstract?: string | null;
  provenance: { provider: string; record_id: string; retrieved_at: string };
};
export type SourceRegistry = ReadonlyMap<string, unknown>;
export type Coverage = {
  scope: "title_and_abstract" | "general_background";
  origin: "user_supplied" | "verified_retrieval" | "none";
  source_id: string | null;
  full_paper_verified: false;
};
export type Section = { id: string; focus: "research_problem" | "method" | "findings" | "limitations"; explanation: string; supporting_excerpt: string | null };
export type Hint = { hint: string; supporting_excerpt: string | null };
export type CoachResponse = {
  contract_version: "2"; source_coverage: Coverage;
} & (
  | { task_id: "abstract_explanation"; output: { sections: Section[] } }
  | { task_id: "learning_hints"; output: { hints: Hint[] } }
  | { task_id: "term_clarification"; output: { definition: string; example: string } }
);
export type LegacyCard = { explanation: string; supporting_excerpt: string | null };
export type LegacyPack = Record<"research_problem" | "method" | "findings" | "limitations", LegacyCard>;
export type ResponseVersion = "1" | "2";

// Prepared only by the gateway after request/source/response-version validation.
export interface ValidatedTask {
  request: CoachRequest;
  source: SourceText | null;
  responseVersion: ResponseVersion;
}
