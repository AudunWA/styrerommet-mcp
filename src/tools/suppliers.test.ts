import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/server";
import {
  registerSupplierTools,
  extractPlainTextFromArticle,
  toDraftRaw,
} from "./suppliers.ts";

test("extractPlainTextFromArticle handles various article formats", () => {
  assert.equal(extractPlainTextFromArticle(null), "");
  assert.equal(extractPlainTextFromArticle(undefined), "");
  assert.equal(extractPlainTextFromArticle(""), "");

  // Draft.js JSON string
  const draftJson = JSON.stringify({
    blocks: [
      { text: "Heisavtale fornyet i 2024." },
      { text: "Kontaktperson er Geir på vakttelefon." },
    ],
    entityMap: {},
  });
  assert.equal(
    extractPlainTextFromArticle(draftJson),
    "Heisavtale fornyet i 2024.\nKontaktperson er Geir på vakttelefon.",
  );

  // Draft.js object
  const draftObj = {
    blocks: [{ text: "Enkelt notat" }],
    entityMap: {},
  };
  assert.equal(extractPlainTextFromArticle(draftObj), "Enkelt notat");

  // Raw plain string
  assert.equal(
    extractPlainTextFromArticle("Dette er en ren tekst"),
    "Dette er en ren tekst",
  );
});

test("toDraftRaw converts plain text to Draft.js RawDraftContentState", () => {
  const empty = toDraftRaw("");
  assert.deepEqual(empty, { blocks: [], entityMap: {} });

  const converted = toDraftRaw("Linje 1\nLinje 2\nLinje 3");
  assert.equal(converted.blocks.length, 3);
  assert.equal(converted.blocks[0].text, "Linje 1");
  assert.equal(converted.blocks[1].text, "Linje 2");
  assert.equal(converted.blocks[2].text, "Linje 3");
  assert.equal(converted.blocks[0].type, "unstyled");

  // If already Draft.js JSON, it preserves it
  const existingDraft = JSON.stringify({
    blocks: [{ key: "k1", text: "Eksisterende", type: "header-two" }],
    entityMap: {},
  });
  const parsed = toDraftRaw(existingDraft);
  assert.equal(parsed.blocks[0].text, "Eksisterende");
  assert.equal(parsed.blocks[0].type, "header-two");
});

test("registerSupplierTools registers all query and write tools", () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerSupplierTools(server);

  // Read registered tool names from server internal capabilities
  const tools = (server as any)._registeredTools || (server as any).tools;
  const toolNames = Object.keys(tools ?? {});

  const expectedTools = [
    "list_suppliers",
    "get_supplier_details",
    "list_supplier_contracts",
    "set_supplier_favourite",
    "update_supplier_notes",
    "add_supplier_contact",
    "update_supplier_contact",
    "remove_supplier_contact",
    "add_supplier_contract",
    "update_supplier_contract",
    "remove_supplier_contract",
    "add_supplier_contract_attachment",
    "remove_supplier_contract_attachment",
    "add_supplier_document",
    "remove_supplier_document",
  ];

  for (const expected of expectedTools) {
    assert.ok(
      toolNames.includes(expected),
      `Expected tool '${expected}' to be registered. Registered: ${toolNames.join(", ")}`,
    );
  }
});
