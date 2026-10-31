import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
) as { version: string };
assert.match(version, /^\d+\.\d+\.\d+$/, "Expected a stable package version");

const manifestPath = new URL("manifest.json", root);
const manifest = readFileSync(manifestPath, "utf8");
assert.equal(typeof JSON.parse(manifest).version, "string");
const updated = manifest.replace(
  /("version":\s*")[^"]+/,
  (_, prefix: string) => `${prefix}${version}`,
);
if (manifest !== updated) {
  if (process.argv.includes("--check"))
    throw new Error(
      "manifest.json is out of sync with package.json; run node scripts/sync-version.ts",
    );
  writeFileSync(manifestPath, updated);
}
