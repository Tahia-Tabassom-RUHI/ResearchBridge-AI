import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import "./build-validators.mjs";

for (const [entry, directory] of [["src/index.ts", "production"], ["src/local.ts", "local"]]) {
  mkdirSync(`dist/${directory}`, { recursive: true });
  await build({ entryPoints: [entry], outfile: `dist/${directory}/index.js`,
    bundle: true, format: "esm", platform: "browser", target: "es2022", legalComments: "inline" });
}
const production = readFileSync("dist/production/index.js", "utf8");
if (/LocalMockProvider|Mock definition for local|fixture:retrieved-1|new Function\(/.test(production)) {
  throw new Error("Production bundle contains mock inference or runtime schema compilation.");
}
console.log("Built isolated production and local Worker bundles without network access.");
