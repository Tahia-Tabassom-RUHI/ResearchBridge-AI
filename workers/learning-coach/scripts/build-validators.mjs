import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import standalone from "ajv/dist/standalone/index.js";

const root = new URL("../../../contracts/learning-coach/", import.meta.url);
const definitions = {
  v1Response: "v1/response.schema.json",
  v2Request: "v2/request.schema.json",
  v2Response: "v2/response.schema.json",
  retrievedSource: "v2/retrieved-source.schema.json",
  v2Error: "v2/error.schema.json",
};

// Preserve Python regex end-anchor semantics (end, or before one final LF).
// This changes only compiler input, never the shared schema documents.
function pythonAnchors(value) {
  if (Array.isArray(value)) return value.map(pythonAnchors);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === "pattern" && typeof item === "string" && item.endsWith("$")
        ? item.slice(0, -1) + "(?=\\n?(?![\\s\\S]))"
        : pythonAnchors(item),
    ]));
  }
  return value;
}

const ajv = new Ajv2020({
  strict: false, allErrors: false, ownProperties: true,
  coerceTypes: false, useDefaults: false, removeAdditional: false,
  unicodeRegExp: true, code: { source: true },
});
for (const [name, path] of Object.entries(definitions)) {
  ajv.addSchema(pythonAnchors(JSON.parse(readFileSync(new URL(path, root), "utf8"))), name);
}
const directory = new URL("../.generated/", import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL("validators.cjs", directory), standalone(ajv, Object.fromEntries(Object.keys(definitions).map(name => [name, name]))));
writeFileSync(new URL("validators.d.cts", directory), Object.keys(definitions).map(name => `export function ${name}(value: unknown): boolean;`).join("\n") + "\n");
console.log(`Compiled ${Object.keys(definitions).length} shared schemas to ${fileURLToPath(directory)}`);
