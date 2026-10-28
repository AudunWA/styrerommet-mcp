import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/server";
import {
  registerHmsTools,
  CUSTOM_HMS_QUERY,
  CREATE_DEVIATION_MUTATION,
  ADD_ATTACHMENT_MUTATION,
  RESOLVE_DEVIATION_MUTATION,
  UNDO_RESOLVE_DEVIATION_MUTATION,
} from "./hms.ts";

test("registerHmsTools registers query and mutation tools on McpServer", () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerHmsTools(server);

  const tools = (server as any)._registeredTools || (server as any).tools;
  const toolNames = Object.keys(tools ?? {});

  const expectedTools = [
    "get_hms_overview",
    "create_hms_deviation",
    "add_attachment_to_hms_deviation",
    "delete_hms_deviation",
    "resolve_hms_deviation",
    "reopen_hms_deviation",
  ];

  for (const expected of expectedTools) {
    assert.ok(
      toolNames.includes(expected),
      `Expected tool '${expected}' to be registered. Registered tools: ${toolNames.join(", ")}`,
    );
  }
});

test("HMS GraphQL query and mutations are valid and structured properly", () => {
  // Query includes attachments on deviations
  assert.ok(CUSTOM_HMS_QUERY.includes("attachments"));
  assert.ok(CUSTOM_HMS_QUERY.includes("deviations"));

  // Create mutation
  assert.ok(
    CREATE_DEVIATION_MUTATION.includes(
      "mutation createDeviation($input: CreateDeviationInput!)",
    ),
  );
  assert.ok(
    CREATE_DEVIATION_MUTATION.includes("createDeviation(input: $input)"),
  );

  // Add attachment mutation
  assert.ok(
    ADD_ATTACHMENT_MUTATION.includes(
      "mutation addAttachment($input: ItemAttachmentInput!)",
    ),
  );
  assert.ok(ADD_ATTACHMENT_MUTATION.includes("addAttachment(input: $input)"));

  // Resolve deviation mutation
  assert.ok(
    RESOLVE_DEVIATION_MUTATION.includes(
      "mutation resolveDeviation($input: ResolveDeviationInput!)",
    ),
  );
  assert.ok(
    RESOLVE_DEVIATION_MUTATION.includes("resolveDeviation(input: $input)"),
  );

  // Undo resolve deviation mutation
  assert.ok(
    UNDO_RESOLVE_DEVIATION_MUTATION.includes(
      "mutation undoResolveDeviation($id: NodeID!)",
    ),
  );
  assert.ok(
    UNDO_RESOLVE_DEVIATION_MUTATION.includes("undoResolveDeviation(id: $id)"),
  );
});

test("create_hms_deviation fails immediately when an attachment file does not exist", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerHmsTools(server);

  const tools = (server as any)._registeredTools || (server as any).tools;
  const createTool = tools["create_hms_deviation"];
  assert.ok(createTool, "create_hms_deviation tool must be registered");

  await assert.rejects(async () => {
    await createTool.handler({
      description: "Test avvik",
      attachments: ["non-existent-file-xyz-123456.pdf"],
    });
  }, /Vedleggsfil ble ikke funnet/i);
});
