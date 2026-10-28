import { rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("./bin/tsc", import.meta.resolve("typescript/package.json")),
    ),
    "-p",
    "tsconfig.build.json",
  ],
  { cwd: root, stdio: "inherit" },
);
process.exitCode = result.status ?? 1;

if (result.status === 0)
  chmodSync(new URL("../dist/index.js", import.meta.url), 0o755);
