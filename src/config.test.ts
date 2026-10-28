import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { getDataDirectory, getEnvPath, loadConfiguration } from "./config.ts";
import { updateEnvFile } from "./auth/login.ts";

test("credentials persist outside the package with private permissions and reload correctly", () => {
  const original = { ...process.env };
  const temp = mkdtempSync(path.join(tmpdir(), "styrerommet-config-"));
  try {
    delete process.env.STYREROMMET_ENV_PATH;
    assert.equal(getEnvPath(), path.join(getDataDirectory(), ".env"));
    process.env.STYREROMMET_ENV_PATH = path.join(temp, "private", ".env");
    updateEnvFile({
      VIBBO_ORG_SLUG: "example-coop",
      STYREROMMET_COOKIE: "session=test; other=value\"'",
    });
    assert.throws(
      () => updateEnvFile({ STYREROMMET_COOKIE: "bad\nINJECTED=value" }),
      /multiline/,
    );
    const parsed = parseEnv(readFileSync(getEnvPath(), "utf8"));
    assert.equal(parsed.STYREROMMET_COOKIE, "session=test; other=value\"'");
    process.env.VIBBO_ORG_SLUG = "";
    loadConfiguration();
    assert.equal(process.env.VIBBO_ORG_SLUG, "example-coop");
    if (process.platform !== "win32") {
      assert.equal(statSync(getEnvPath()).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(getEnvPath())).mode & 0o777, 0o700);
    }
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(temp, { recursive: true, force: true });
  }
});
