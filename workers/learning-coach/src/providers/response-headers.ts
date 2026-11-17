import type { EvidenceIssue } from "./response-signals";
type Header = { state: "missing" } | { state: "value"; value: string } | { state: "invalid" };
const names = new Set(["retry-after", "date", ...["requests", "tokens"].flatMap(d =>
  ["limit", "remaining", "reset"].map(k => `x-ratelimit-${k}-${d}`))]);
export class ResponseHeaders {
  readonly issues: EvidenceIssue[] = [];
  private readonly values = new Map<string, Header>();
  private invalid = false;
  constructor(input: unknown) {
    if (input === undefined) return;
    if (!Array.isArray(input) || input.length > 128) { this.bad(); return; }
    let size = 0;
    for (const entry of input) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string" ||
          entry[0].length > 128 || entry[1].length > 4096 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry[0]) || /[\r\n\0]/.test(entry[1])) { this.bad(); return; }
      size += entry[0].length + entry[1].length;
      if (size > 16384) { this.bad(); return; }
      const name = entry[0].toLowerCase(); if (!names.has(name)) continue;
      const value = entry[1].replace(/^[ \t]+|[ \t]+$/g, ""), previous = this.values.get(name);
      if (previous && (previous.state !== "value" || previous.value !== value)) {
        this.values.set(name, { state: "invalid" }); this.issues.push("conflicting_headers");
      } else this.values.set(name, { state: "value", value });
    }
  }
  private bad() { this.invalid = true; this.values.clear(); this.issues.push("invalid_headers"); }
  get(name: string): Header { return this.invalid ? { state: "invalid" } : this.values.get(name) ?? { state: "missing" }; }
}
