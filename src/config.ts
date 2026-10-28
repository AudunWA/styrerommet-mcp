import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function getDataDirectory(): string {
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? process.env.LOCALAPPDATA ||
          path.join(os.homedir(), "AppData", "Local")
        : process.env.XDG_DATA_HOME ||
          path.join(os.homedir(), ".local", "share");
  return path.join(base, "styrerommet-mcp");
}

export function getEnvPath(): string {
  const override = process.env.STYREROMMET_ENV_PATH?.trim();
  return override
    ? path.resolve(override)
    : path.join(getDataDirectory(), ".env");
}

export function loadConfiguration(): void {
  // Desktop clients can send blank optional setup fields.
  for (const key of ["STYREROMMET_ORG_ID", "VIBBO_ORG_SLUG"]) {
    if (process.env[key]?.trim() === "") delete process.env[key];
  }
  const envPath = getEnvPath();
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}
