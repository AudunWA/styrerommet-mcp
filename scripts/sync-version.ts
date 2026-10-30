import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
) as { version: string };
assert.match(version, /^\d+\.\d+\.\d+$/, "Expected a stable package version");

const readmePath = new URL("README.md", root);
const readme = readFileSync(readmePath, "utf8");
assert.match(readme, /styrerommet-mcp@\d+\.\d+\.\d+/);
const manifestPath = new URL("manifest.json", root);
const manifest = readFileSync(manifestPath, "utf8");
assert.equal(typeof JSON.parse(manifest).version, "string");

for (const [file, current, updated] of [
  [
    readmePath,
    readme,
    readme.replaceAll(/styrerommet-mcp@\d+\.\d+\.\d+/g, `styrerommet-mcp@${version}`),
  ],
  [
    manifestPath,
    manifest,
    manifest.replace(/("version":\s*")[^"]+/, (_, prefix: string) => `${prefix}${version}`),
  ],
] as const) {
  if (current === updated) continue;
  if (process.argv.includes("--check"))
    throw new Error(
      `${file.pathname} is out of sync with package.json; run node scripts/sync-version.ts`,
    );
  writeFileSync(file, updated);
}
