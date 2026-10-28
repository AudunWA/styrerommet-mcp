import assert from "node:assert/strict";
import { unzipSync, zipSync, type Zippable } from "fflate";
import manifestTemplate from "../manifest.json" with { type: "json" };
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), "styrerommet-package-"));
const extracted = mkdtempSync(path.join(tmpdir(), "styrerommet-mcpb-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
type PackedPackage = { filename: string; files: { path: string }[] };

function runNpm(args: string[], cwd: string): string {
  // npm.cmd requires a shell on Windows; every argument is controlled by this script.
  const quotedArgs =
    process.platform === "win32"
      ? args.map((arg) => '"' + arg.replaceAll('"', '""') + '"')
      : args;
  return execFileSync(npm, quotedArgs, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, npm_config_cache: path.join(temp, "npm-cache") },
  });
}
try {
  const packages: PackedPackage[] | Record<string, PackedPackage> = JSON.parse(
    runNpm(
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
      root,
    ),
  );
  const [packed] = Object.values(packages);
  assert.ok(packed, "npm pack returned no package");
  const names = packed.files.map((file) => file.path);
  for (const name of names) {
    assert.match(
      name,
      /^(dist\/.+\.js|data\/[\w-]+-discovered-queries\.json|package\.json|README\.md|LICENSE)$/,
    );
    assert.doesNotMatch(name, /\.test\.|\.env|auth-profile|node_modules/);
  }
  for (const name of [
    "dist/index.js",
    "data/graphql-discovered-queries.json",
    "data/vibbo-discovered-queries.json",
    "LICENSE",
  ])
    assert.ok(names.includes(name), `Missing ${name}`);
  const tarball = path.join(temp, packed.filename);
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    temp,
  );
  const installed = path.join(temp, "node_modules", "styrerommet-mcp");
  const metadata: {
    version: string;
    bin: Record<string, string>;
    engines: { node: string };
  } = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  const entrypoint = metadata.bin["styrerommet-mcp"];
  assert.ok(entrypoint, "Package is missing its CLI entrypoint");

  // Bundle the exact production installation, without the repo's dev dependencies.
  const bundle = path.join(temp, "bundle");
  cpSync(installed, bundle, { recursive: true, dereference: true });
  const dependencies = path.join(temp, "node_modules");
  cpSync(dependencies, path.join(bundle, "node_modules"), {
    recursive: true,
    dereference: true,
    filter: (source) =>
      !["styrerommet-mcp", ".bin", ".package-lock.json"].includes(
        path.relative(dependencies, source).split(path.sep)[0] ?? "",
      ),
  });
  const manifest = {
    ...manifestTemplate,
    version: metadata.version,
    compatibility: { runtimes: { node: metadata.engines.node } },
  };
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.name, "styrerommet-mcp");
  assert.ok(manifest.description && manifest.author.name);
  assert.equal(manifest.server.type, "node");
  assert.equal(manifest.server.entry_point, entrypoint);
  assert.equal(manifest.server.mcp_config.command, "node");
  assert.deepEqual(manifest.server.mcp_config.args, [`\${__dirname}/${entrypoint}`]);
  writeFileSync(
    path.join(bundle, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const mcpb = path.join(temp, "styrerommet-mcp.mcpb");
  // MCPB is a ZIP with a root manifest; preserve executable permissions on POSIX.
  const zip: Zippable = {};
  for (const name of readdirSync(bundle, { recursive: true, encoding: "utf8" })) {
    const file = path.join(bundle, name);
    const stat = statSync(file);
    if (stat.isFile())
      zip[name.split(path.sep).join("/")] = [
        readFileSync(file),
        { os: 3, attrs: (stat.mode & 0o777) << 16 },
      ];
  }
  writeFileSync(mcpb, zipSync(zip, { level: 9 }));

  // Run the extracted bundle away from npm's installation so missing dependencies fail.
  const files = unzipSync(readFileSync(mcpb));
  for (const [name, contents] of Object.entries(files)) {
    assert.ok(!path.isAbsolute(name) && !name.split(/[\\/]/).includes(".."));
    assert.match(
      name,
      /^(manifest\.json|node_modules\/.+|dist\/.+\.js|data\/[\w-]+-discovered-queries\.json|package\.json|README\.md|LICENSE)$/,
    );
    assert.doesNotMatch(
      name,
      /(^|\/)\.env(?:\.|$)|auth-profile|node_modules\/(?:@anthropic-ai|@types|typescript|fflate)(?:\/|$)/,
    );
    const destination = path.join(extracted, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  assert.equal(
    JSON.parse(readFileSync(path.join(extracted, "manifest.json"), "utf8")).version,
    metadata.version,
  );
  assert.equal(
    execFileSync(
      process.execPath,
      [path.join(installed, entrypoint), "--version"],
      { encoding: "utf8" },
    ).trim(),
    metadata.version,
  );
  if (process.platform !== "win32") {
    const executable = path.join(
      temp,
      "node_modules",
      ".bin",
      "styrerommet-mcp",
    );
    assert.ok(statSync(executable).mode & 0o111);
    assert.equal(
      execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(),
      metadata.version,
    );
  }
  for (const [label, directory] of [["npm", installed], ["MCPB", extracted]] as const) {
    for (const mode of ["legacy", { pin: "2026-07-28" }] as const) {
      const client = new Client(
        { name: "package-smoke-test", version: "1.0.0" },
        { versionNegotiation: { mode } },
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(directory, entrypoint)],
        cwd: directory,
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          NO_AUTO_LOGIN: "true",
          STYREROMMET_ENV_PATH: path.join(temp, "no-credentials.env"),
        },
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      try {
        await client.connect(transport);
        assert.equal(
          client.getProtocolEra(),
          mode === "legacy" ? "legacy" : "modern",
        );
        const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        assert.ok(tools.length > 100, `Unexpected tool count: ${tools.length}`);
        assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
        for (const tool of tools) {
          assert.equal(tool.inputSchema.type, "object", tool.name);
          assert.equal(
            typeof tool.annotations?.readOnlyHint,
            "boolean",
            tool.name,
          );
          assert.equal(tool.annotations?.openWorldHint, true, tool.name);
        }
        for (const name of [
          "download_document",
          "download_invoices",
          "download_archive_file",
          "download_archive_zip",
          "login_interactive",
        ])
          assert.equal(
            tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint,
            false,
            name,
          );
        const list = await client.callTool({
          name: "list_operations",
          arguments: { filter: "economy" },
        });
        assert.ok(!list.isError);
        assert.match(JSON.stringify(list.content), /economy/i);
        const blocked = await client.callTool({
          name: "graphql",
          arguments: { operationName: "not-a-query" },
        });
        assert.equal(blocked.isError, true);
        const unauthenticated = await client.callTool({
          name: "get_viewer",
          arguments: {},
        });
        assert.equal(unauthenticated.isError, true);
        assert.equal(client.getServerCapabilities()?.resources, undefined);
        console.log(
          `${label}: ${client.getProtocolEra()}, ${tools.length} tools OK`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\nServer stderr: ${stderr}`, {
          cause: error,
        });
      } finally {
        await client.close();
      }
    }
  }
  if (process.env.STYREROMMET_PACKAGE_OUTPUT_DIR) {
    const destination = path.resolve(
      process.env.STYREROMMET_PACKAGE_OUTPUT_DIR,
    );
    mkdirSync(destination, { recursive: true });
    copyFileSync(tarball, path.join(destination, packed.filename));
    copyFileSync(mcpb, path.join(destination, "styrerommet-mcp.mcpb"));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(extracted, { recursive: true, force: true });
}
