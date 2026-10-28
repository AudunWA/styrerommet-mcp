#!/usr/bin/env node
import { loadConfiguration } from "./config.ts";
import { readFileSync } from "node:fs";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--version") {
    console.log(
      JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ).version,
    );
    return;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(
      "Usage: styrerommet-mcp [--auth [mittbygg] | --version | --help]\nWithout arguments, starts the MCP server over stdio.",
    );
    return;
  }
  if (
    args.length &&
    !(
      args[0] === "--auth" &&
      args.length <= 2 &&
      (!args[1] || args[1] === "mittbygg")
    )
  ) {
    throw new Error("Unknown arguments. Use --help for usage.");
  }
  loadConfiguration();
  if (args[0] === "--auth") {
    const { runInteractiveLogin } = await import("./auth/login.ts");
    const result = await runInteractiveLogin(
      args[1] === "mittbygg" ? "mittbygg" : "all",
    );
    if (!result.success) process.exitCode = 1;
    return;
  }
  const { createServer } = await import("./server.ts");
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  const handle = serveStdio(createServer);
  const shutdown = async () => {
    await handle.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Server startup failed",
  );
  process.exitCode = 1;
});
