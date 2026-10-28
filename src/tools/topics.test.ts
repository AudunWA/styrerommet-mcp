import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/server";
import {
  convertTextToDraftBlocks,
  convertTextToProseMirrorBlocks,
  convertDraftBlocksToMarkdown,
  composeDraftContent,
  fetchAndVerifyDraftTopic,
  resolveTopic,
  registerTopicDraftTools,
} from "./topics.ts";
import { vibboRegistry } from "../vibbo-registry.ts";

const originalSlug = process.env.VIBBO_ORG_SLUG;
test.after(() => {
  if (originalSlug === undefined) delete process.env.VIBBO_ORG_SLUG;
  else process.env.VIBBO_ORG_SLUG = originalSlug;
});

test.before(async () => {
  process.env.VIBBO_ORG_SLUG = "example-coop";
  await vibboRegistry.load();
});

test("convertTextToDraftBlocks parses plain text, headings, and lists into Draft.js blocks", () => {
  const markdown =
    "# Title Heading\n\n## Subheading\n\nThis is a paragraph.\n\n- Bullet item 1\n* Bullet item 2";
  const blocks = convertTextToDraftBlocks(markdown);

  const blockIds = Object.keys(blocks);
  assert.equal(blockIds.length, 1);
  const container = blocks[blockIds[0]!]!;
  assert.equal(container.type, "text");

  const items = container.data.blocks;
  assert.equal(items.length, 5);
  assert.equal(items[0]!.type, "header-one");
  assert.equal(items[0]!.text, "Title Heading");
  assert.equal(items[1]!.type, "header-two");
  assert.equal(items[1]!.text, "Subheading");
  assert.equal(items[2]!.type, "unstyled");
  assert.equal(items[2]!.text, "This is a paragraph.");
  assert.equal(items[3]!.type, "unordered-list-item");
  assert.equal(items[3]!.text, "Bullet item 1");
  assert.equal(items[4]!.type, "unordered-list-item");
  assert.equal(items[4]!.text, "Bullet item 2");
});

test("convertTextToDraftBlocks handles empty text gracefully", () => {
  const blocks = convertTextToDraftBlocks("");
  const blockIds = Object.keys(blocks);
  assert.equal(blockIds.length, 1);
  assert.equal(blocks[blockIds[0]!]!.data.blocks.length, 1);
  assert.equal(blocks[blockIds[0]!]!.data.blocks[0]!.text, "");
});

test("convertTextToDraftBlocks parses numbered lists into ordered-list-item blocks with numbers stripped", () => {
  const markdown =
    "1. Melding om overdragelse\n2. Styregodkjenning av kjøper\n3. Forkjøpsrett avklares";
  const blocks = convertTextToDraftBlocks(markdown);
  const container = Object.values(blocks)[0]!;
  const items = container.data.blocks;

  assert.equal(items.length, 3);
  assert.equal(items[0]!.type, "ordered-list-item");
  assert.equal(items[0]!.text, "Melding om overdragelse");
  assert.equal(items[1]!.type, "ordered-list-item");
  assert.equal(items[1]!.text, "Styregodkjenning av kjøper");
  assert.equal(items[2]!.type, "ordered-list-item");
  assert.equal(items[2]!.text, "Forkjøpsrett avklares");
});

test("convertTextToDraftBlocks parses nested lists with correct depth", () => {
  const markdown = [
    "- Top bullet",
    "  - Sub bullet 1",
    "  - Sub bullet 2",
    "    - Deep bullet",
  ].join("\n");
  const blocks = convertTextToDraftBlocks(markdown);
  const container = Object.values(blocks)[0]!;
  const items = container.data.blocks;

  assert.equal(items.length, 4);
  assert.equal(items[0]!.text, "Top bullet");
  assert.equal(items[0]!.depth, 0);
  assert.equal(items[1]!.text, "Sub bullet 1");
  assert.equal(items[1]!.depth, 1);
  assert.equal(items[2]!.text, "Sub bullet 2");
  assert.equal(items[2]!.depth, 1);
  assert.equal(items[3]!.text, "Deep bullet");
  assert.equal(items[3]!.depth, 2);
});

test("convertTextToDraftBlocks parses nested ordered lists with correct depth", () => {
  const markdown = [
    "- Outer bullet",
    "  1. Nested step 1",
    "  2. Nested step 2",
  ].join("\n");
  const blocks = convertTextToDraftBlocks(markdown);
  const container = Object.values(blocks)[0]!;
  const items = container.data.blocks;

  assert.equal(items.length, 3);
  assert.equal(items[0]!.type, "unordered-list-item");
  assert.equal(items[0]!.depth, 0);
  assert.equal(items[1]!.type, "ordered-list-item");
  assert.equal(items[1]!.text, "Nested step 1");
  assert.equal(items[1]!.depth, 1);
  assert.equal(items[2]!.type, "ordered-list-item");
  assert.equal(items[2]!.text, "Nested step 2");
  assert.equal(items[2]!.depth, 1);
});

test("convertTextToDraftBlocks extracts inline bold and italic styles into inlineStyleRanges", () => {
  const markdown =
    "**Navn på borettslaget:** Example Housing Cooperative\n\nDette er *kursiv* og **fet** tekst.";
  const blocks = convertTextToDraftBlocks(markdown);
  const container = Object.values(blocks)[0]!;
  const items = container.data.blocks;

  assert.equal(items.length, 2);
  assert.equal(
    items[0]!.text,
    "Navn på borettslaget: Example Housing Cooperative",
  );
  assert.deepEqual(items[0]!.inlineStyleRanges, [
    { offset: 0, length: 21, style: "BOLD" },
  ]);

  assert.equal(items[1]!.text, "Dette er kursiv og fet tekst.");
  assert.deepEqual(items[1]!.inlineStyleRanges, [
    { offset: 9, length: 6, style: "ITALIC" },
    { offset: 19, length: 3, style: "BOLD" },
  ]);
});

test("convertTextToDraftBlocks parses markdown links into entityMap and entityRanges", () => {
  const markdown =
    "Se [vedtektene](https://vibbo.no/example-coop/tema/vedtekter) for regler.";
  const blocks = convertTextToDraftBlocks(markdown);
  const container = Object.values(blocks)[0]!;
  const items = container.data.blocks;
  const entityMap = container.data.entityMap;

  assert.equal(items.length, 1);
  assert.equal(items[0]!.text, "Se vedtektene for regler.");
  assert.equal(items[0]!.entityRanges.length, 1);
  assert.equal(items[0]!.entityRanges[0]!.offset, 3);
  assert.equal(items[0]!.entityRanges[0]!.length, 10);
  const key = items[0]!.entityRanges[0]!.key;
  const entity = entityMap[key.toString()] as any;
  assert.ok(entity);
  assert.equal(entity.type, "LINK");
  assert.equal(entity.data.url, "https://vibbo.no/example-coop/tema/vedtekter");
});

test("convertTextToDraftBlocks ignores horizontal divider rules (---)", () => {
  const markdown = "Første avsnitt.\n\n---\n\nAndre avsnitt.";
  const blocks = convertTextToDraftBlocks(markdown);
  const container = Object.values(blocks)[0]!;
  const items = container.data.blocks;

  assert.equal(items.length, 2);
  assert.equal(items[0]!.text, "Første avsnitt.");
  assert.equal(items[1]!.text, "Andre avsnitt.");
});

test("composeDraftContent formats Markdown and rejects raw JSON block injection", () => {
  const draft = composeDraftContent(
    "Test Title",
    "Intro summary",
    "Line 1\n\nLine 2",
  );
  assert.equal(draft.meta.title, "Test Title");
  assert.equal(draft.meta.ingress, "Intro summary");
  const blockIds = Object.keys(draft.blocks);
  assert.equal(draft.blocks[blockIds[0]!]!.data.type, "doc");
  assert.equal(draft.blocks[blockIds[0]!]!.data.content?.length, 2);

  // Custom JSON blocks passthrough
  const customJson = JSON.stringify({
    blocks: {
      "custom-id": {
        type: "text",
        id: "custom-id",
        order: 1,
        data: { blocks: [], entityMap: {} },
      },
    },
  });
  assert.throws(
    () => composeDraftContent("Title", "Ingress", customJson),
    /Raw JSON blocks/,
  );
});

test("convertTextToProseMirrorBlocks and convertDraftBlocksToMarkdown round-trip headings, lists, bold, italic, and links", () => {
  const markdown = [
    "## Overskrift",
    "",
    "### Underoverskrift",
    "",
    "Vanlig avsnitt med **fet**, *kursiv* og en [lenke](https://vibbo.no/example-coop/tema/forsikring).",
    "",
    "- Punkt 1",
    "- Punkt 2",
    "",
    "1. Steg 1",
    "2. Steg 2",
  ].join("\n");

  const blocks = convertTextToProseMirrorBlocks(markdown);
  const container = Object.values(blocks)[0]!;
  assert.equal(container.data.type, "doc");
  assert.equal(container.data.content?.length, 5);
  assert.equal(container.data.content?.[0]?.type, "heading");
  assert.deepEqual(container.data.content?.[0]?.attrs, { level: 2 });
  assert.equal(container.data.content?.[1]?.type, "heading");
  assert.deepEqual(container.data.content?.[1]?.attrs, { level: 2 });
  assert.equal(container.data.content?.[2]?.type, "paragraph");
  assert.equal(container.data.content?.[3]?.type, "bulletList");
  assert.equal(container.data.content?.[4]?.type, "orderedList");

  const roundTrip = convertDraftBlocksToMarkdown({ blocks });
  assert.match(roundTrip, /## Overskrift/);
  assert.match(roundTrip, /## Underoverskrift/);
  assert.match(
    roundTrip,
    /Vanlig avsnitt med \*\*fet\*\*, \*kursiv\* og en \[lenke\]\(https:\/\/vibbo\.no\/example-coop\/tema\/forsikring\)\./,
  );
  assert.match(roundTrip, /- Punkt 1/);
  assert.match(roundTrip, /- Punkt 2/);
  assert.match(roundTrip, /1\. Steg 1/);
  assert.match(roundTrip, /2\. Steg 2/);
});

test("convertTextToProseMirrorBlocks never combines 'code' mark with 'bold', 'italic', or 'link' (TipTap excludes: '_')", () => {
  const markdown =
    "Polisenr. **`81006605`**, kun `15590179`, og [`elhub.no`](https://elhub.no).";
  const blocks = convertTextToProseMirrorBlocks(markdown);
  const container = Object.values(blocks)[0]!;
  const paragraph = container.data.content?.[0]!;
  assert.equal(paragraph.type, "paragraph");

  for (const textNode of paragraph.content ?? []) {
    const markTypes = (textNode.marks ?? []).map((m) => m.type);
    if (markTypes.includes("code")) {
      assert.deepEqual(
        markTypes,
        ["code"],
        `Expected 'code' mark to never coexist with other marks, got: ${markTypes.join(",")}`,
      );
    }
  }
});

test("fetchAndVerifyDraftTopic accepts unpublished drafts and denies published topics", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.VIBBO_COOKIE;
  process.env.VIBBO_COOKIE = "mock-cookie";

  try {
    // 1. Mock responding with an unpublished draft topic (isPublished: false)
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      if (body.operationName === "getVibboOrgNodeId") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({ data: { organization: { id: "OrgNode:123" } } }),
          json: async () => ({ data: { organization: { id: "OrgNode:123" } } }),
        } as any;
      }
      if (body.operationName === "vibboTopicPage") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              data: {
                organization: {
                  topic: {
                    id: "Topic:draft-1",
                    slug: "my-draft",
                    title: "My Draft Topic",
                    isPublished: false,
                    isClusterTopic: false,
                    organization: { id: "OrgNode:123" },
                    article: { blocks: {} },
                    forms: [],
                    draft: {
                      content: {
                        blocks: {},
                        meta: {
                          title: "My Draft Topic",
                          ingress: "Draft ingress",
                        },
                      },
                    },
                  },
                },
              },
            }),
          json: async () => ({
            data: {
              organization: {
                topic: {
                  id: "Topic:draft-1",
                  slug: "my-draft",
                  title: "My Draft Topic",
                  isPublished: false,
                  isClusterTopic: false,
                  organization: { id: "OrgNode:123" },
                  article: { blocks: {} },
                  forms: [],
                  draft: {
                    content: {
                      blocks: {},
                      meta: {
                        title: "My Draft Topic",
                        ingress: "Draft ingress",
                      },
                    },
                  },
                },
              },
            },
          }),
        } as any;
      }
      throw new Error(`Unexpected operation: ${body.operationName}`);
    }) as typeof fetch;

    const verified = await fetchAndVerifyDraftTopic("my-draft");
    assert.equal(verified.topic.id, "Topic:draft-1");
    assert.equal(verified.topic.isPublished, false);

    // 2. Mock responding with a PUBLISHED topic (isPublished: true)
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      if (body.operationName === "getVibboOrgNodeId") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({ data: { organization: { id: "OrgNode:123" } } }),
          json: async () => ({ data: { organization: { id: "OrgNode:123" } } }),
        } as any;
      }
      if (body.operationName === "vibboTopicPage") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              data: {
                organization: {
                  topic: {
                    id: "Topic:published-1",
                    slug: "published-topic",
                    title: "Published Topic",
                    isPublished: true,
                  },
                },
              },
            }),
          json: async () => ({
            data: {
              organization: {
                topic: {
                  id: "Topic:published-1",
                  slug: "published-topic",
                  title: "Published Topic",
                  isPublished: true,
                },
              },
            },
          }),
        } as any;
      }
      throw new Error(`Unexpected operation: ${body.operationName}`);
    }) as typeof fetch;

    // Must throw an error denying mutation of a published topic
    await assert.rejects(async () => {
      await fetchAndVerifyDraftTopic("published-topic");
    }, /OPERATION DENIED.*already published.*forbidden/i);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.VIBBO_COOKIE = originalCookie;
  }
});

test("vibbo_create_topic_draft creates draft and verifies isPublished is false", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.VIBBO_COOKIE;
  process.env.VIBBO_COOKIE = "mock-cookie";

  const calls: Array<{ op: string; variables: any }> = [];

  try {
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      calls.push({ op: body.operationName, variables: body.variables });

      if (body.operationName === "getVibboOrgNodeId") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({ data: { organization: { id: "OrgNode:123" } } }),
          json: async () => ({ data: { organization: { id: "OrgNode:123" } } }),
        } as any;
      }

      if (body.operationName === "vibboTopicPage") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              organization: {
                topic: {
                  id: "Topic:new-draft",
                  slug: "new-draft-slug",
                  title: "Nytt utkast",
                  isPublished: false,
                  isClusterTopic: false,
                  organization: { id: "OrgNode:123" },
                  article: { blocks: {} },
                  forms: [],
                },
              },
            },
          }),
        } as any;
      }

      if (body.operationName === "createTopic") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              data: {
                createTopic: {
                  id: "Topic:new-draft",
                  slug: "new-draft-slug",
                  title: body.variables.input.title,
                  isPublished: false,
                  isClusterTopic: false,
                  organization: { id: "OrgNode:123" },
                  article: { blocks: {} },
                  forms: [],
                },
              },
            }),
          json: async () => ({
            data: {
              createTopic: {
                id: "Topic:new-draft",
                slug: "new-draft-slug",
                title: body.variables.input.title,
                isPublished: false,
                isClusterTopic: false,
                organization: { id: "OrgNode:123" },
                article: { blocks: {} },
                forms: [],
              },
            },
          }),
        } as any;
      }

      if (body.operationName === "saveEntityRevision") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              data: {
                saveEntityRevision: {
                  id: "Revision:1",
                  updatedAt: new Date().toISOString(),
                },
              },
            }),
          json: async () => ({
            data: {
              saveEntityRevision: {
                id: "Revision:1",
                updatedAt: new Date().toISOString(),
              },
            },
          }),
        } as any;
      }

      throw new Error(`Unexpected operation: ${body.operationName}`);
    }) as typeof fetch;

    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTopicDraftTools(server);

    // Get tool handler
    const tool = (server as any)._registeredTools["vibbo_create_topic_draft"];
    assert.ok(tool, "vibbo_create_topic_draft must be registered");

    const result = await tool.handler({
      title: "Nytt utkast",
      ingress: "Kort introduksjon",
      content: "Dette er innholdet i utkastet.",
    });

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.success, true);
    assert.equal(parsed.topic.slug, "new-draft-slug");
    assert.equal(parsed.topic.isPublished, false);

    // Verify mutations were called with draft inputs
    assert.ok(calls.some((c) => c.op === "createTopic"));
    assert.ok(calls.some((c) => c.op === "saveEntityRevision"));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.VIBBO_COOKIE = originalCookie;
  }
});

test("vibbo_update_topic_draft rejects published topic and allows draft topic", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.VIBBO_COOKIE;
  process.env.VIBBO_COOKIE = "mock-cookie";

  let saveCalls = 0;

  try {
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init?.body || "{}");

      if (body.operationName === "getVibboOrgNodeId") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({ data: { organization: { id: "OrgNode:123" } } }),
          json: async () => ({ data: { organization: { id: "OrgNode:123" } } }),
        } as any;
      }

      if (body.operationName === "vibboTopicPage") {
        const isPublished = body.variables.topicSlug === "published-slug";
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              data: {
                organization: {
                  topic: {
                    id: "Topic:1",
                    slug: body.variables.topicSlug,
                    title: "Topic Title",
                    isPublished,
                    isClusterTopic: false,
                    organization: { id: "OrgNode:123" },
                    article: { blocks: {} },
                    forms: [],
                    draft: {
                      content: {
                        blocks: {},
                        meta: { title: "Topic Title", ingress: "" },
                      },
                    },
                  },
                },
              },
            }),
          json: async () => ({
            data: {
              organization: {
                topic: {
                  id: "Topic:1",
                  slug: body.variables.topicSlug,
                  title: "Topic Title",
                  isPublished,
                  isClusterTopic: false,
                  organization: { id: "OrgNode:123" },
                  article: { blocks: {} },
                  forms: [],
                  draft: {
                    content: {
                      blocks: {},
                      meta: { title: "Topic Title", ingress: "" },
                    },
                  },
                },
              },
            },
          }),
        } as any;
      }

      if (body.operationName === "saveEntityRevision") {
        saveCalls++;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              data: {
                saveEntityRevision: {
                  id: "Revision:2",
                  updatedAt: new Date().toISOString(),
                },
              },
            }),
          json: async () => ({
            data: {
              saveEntityRevision: {
                id: "Revision:2",
                updatedAt: new Date().toISOString(),
              },
            },
          }),
        } as any;
      }

      throw new Error(`Unexpected operation: ${body.operationName}`);
    }) as typeof fetch;

    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTopicDraftTools(server);

    const updateTool = (server as any)._registeredTools[
      "vibbo_update_topic_draft"
    ];

    // 1. Attempting to update a PUBLISHED page must be denied with 0 save calls
    await assert.rejects(async () => {
      await updateTool.handler({
        topicSlug: "published-slug",
        title: "Malicious Edit",
      });
    }, /OPERATION DENIED.*already published/i);
    assert.equal(
      saveCalls,
      0,
      "No mutation must be executed when target is published",
    );

    // 2. Updating an unpublished draft succeeds
    const result = await updateTool.handler({
      topicSlug: "draft-slug",
      title: "Updated Draft Title",
      content: "Updated draft content",
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.success, true);
    assert.equal(parsed.topic.isPublished, false);
    assert.equal(
      saveCalls,
      1,
      "Expected saveEntityRevision to be called once for draft",
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.VIBBO_COOKIE = originalCookie;
  }
});

test("vibbo_delete_topic_draft rejects published topic and allows draft topic", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.VIBBO_COOKIE;
  process.env.VIBBO_COOKIE = "mock-cookie";

  let deleteCalls = 0;

  try {
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init?.body || "{}");

      if (body.operationName === "getVibboOrgNodeId") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({ data: { organization: { id: "OrgNode:123" } } }),
          json: async () => ({ data: { organization: { id: "OrgNode:123" } } }),
        } as any;
      }

      if (body.operationName === "vibboTopicPage") {
        const isPublished = body.variables.topicSlug === "published-slug";
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              data: {
                organization: {
                  topic: {
                    id: "Topic:1",
                    slug: body.variables.topicSlug,
                    title: "Topic Title",
                    isPublished,
                    isClusterTopic: false,
                    organization: { id: "OrgNode:123" },
                    article: { blocks: {} },
                    forms: [],
                  },
                },
              },
            }),
          json: async () => ({
            data: {
              organization: {
                topic: {
                  id: "Topic:1",
                  slug: body.variables.topicSlug,
                  title: "Topic Title",
                  isPublished,
                  isClusterTopic: false,
                  organization: { id: "OrgNode:123" },
                  article: { blocks: {} },
                  forms: [],
                },
              },
            },
          }),
        } as any;
      }

      if (body.operationName === "verifyTopicDraftDeletion") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { organization: { topics: [] } } }),
        } as any;
      }

      if (body.operationName === "deleteTopic") {
        deleteCalls++;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ data: { deleteTopic: true } }),
          json: async () => ({ data: { deleteTopic: true } }),
        } as any;
      }

      throw new Error(`Unexpected operation: ${body.operationName}`);
    }) as typeof fetch;

    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTopicDraftTools(server);

    const deleteTool = (server as any)._registeredTools[
      "vibbo_delete_topic_draft"
    ];

    // 1. Attempting to delete a PUBLISHED page must be denied with 0 delete calls
    await assert.rejects(async () => {
      await deleteTool.handler({
        topicSlug: "published-slug",
      });
    }, /OPERATION DENIED.*already published/i);
    assert.equal(
      deleteCalls,
      0,
      "No delete mutation must be executed when target is published",
    );

    // 2. Deleting an unpublished draft succeeds
    const result = await deleteTool.handler({
      topicSlug: "draft-slug",
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.success, true);
    assert.equal(
      deleteCalls,
      1,
      "Expected deleteTopic to be called once for draft",
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.VIBBO_COOKIE = originalCookie;
  }
});

test("convertDraftBlocksToMarkdown converts Draft.js blocks to markdown formatting", () => {
  const sampleContent = {
    blocks: {
      "block-1": {
        type: "text",
        id: "block-1",
        order: 1,
        data: {
          blocks: [
            { key: "k1", text: "Top Header", type: "header-one" },
            { key: "k2", text: "Section Header", type: "header-two" },
            { key: "k3", text: "Subsection", type: "header-three" },
            { key: "k4", text: "Regular paragraph", type: "unstyled" },
            { key: "k5", text: "Bullet 1", type: "unordered-list-item" },
            { key: "k6", text: "Bullet 2", type: "unordered-list-item" },
            { key: "k7", text: "Step 1", type: "ordered-list-item" },
            { key: "k8", text: "Quote text", type: "blockquote" },
            { key: "k9", text: "const x = 1;", type: "code-block" },
          ],
        },
      },
    },
  };

  const md = convertDraftBlocksToMarkdown(sampleContent);
  assert.match(md, /# Top Header/);
  assert.match(md, /## Section Header/);
  assert.match(md, /### Subsection/);
  assert.match(md, /Regular paragraph/);
  assert.match(md, /- Bullet 1/);
  assert.match(md, /- Bullet 2/);
  assert.match(md, /1\. Step 1/);
  assert.match(md, /> Quote text/);
  assert.match(md, /```\nconst x = 1;\n```/);
});

test("convertDraftBlocksToMarkdown converts inline styles and links to markdown", () => {
  const sampleContent = {
    blocks: {
      "block-1": {
        type: "text",
        id: "block-1",
        order: 1,
        data: {
          blocks: [
            {
              key: "k1",
              text: "Hello bold world with a link here.",
              type: "unstyled",
              inlineStyleRanges: [{ offset: 6, length: 4, style: "BOLD" }],
              entityRanges: [{ offset: 24, length: 4, key: 0 }],
            },
          ],
          entityMap: {
            "0": {
              type: "LINK",
              mutability: "MUTABLE",
              data: { url: "https://example.com" },
            },
          },
        },
      },
    },
  };

  const md = convertDraftBlocksToMarkdown(sampleContent);
  assert.equal(
    md,
    "Hello **bold** world with a [link](https://example.com) here.",
  );
});

test("convertDraftBlocksToMarkdown indents nested list items based on depth", () => {
  const sampleContent = {
    blocks: {
      "block-1": {
        type: "text",
        id: "block-1",
        order: 1,
        data: {
          blocks: [
            {
              key: "k1",
              text: "Top bullet",
              type: "unordered-list-item",
              depth: 0,
            },
            {
              key: "k2",
              text: "Sub bullet",
              type: "unordered-list-item",
              depth: 1,
            },
            {
              key: "k3",
              text: "Sub step",
              type: "ordered-list-item",
              depth: 1,
            },
          ],
        },
      },
    },
  };

  const md = convertDraftBlocksToMarkdown(sampleContent);
  assert.match(md, /- Top bullet/);
  assert.match(md, /  - Sub bullet/);
  assert.match(md, /  1\. Sub step/);
});

test("convertDraftBlocksToMarkdown handles null, empty, and string inputs", () => {
  assert.equal(convertDraftBlocksToMarkdown(null), "");
  assert.equal(convertDraftBlocksToMarkdown(""), "");
  assert.equal(convertDraftBlocksToMarkdown({}), "");
  assert.equal(
    convertDraftBlocksToMarkdown(JSON.stringify({ blocks: {} })),
    "",
  );
});

test("vibbo_list_topic_revisions queries history and returns formatted list", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.VIBBO_COOKIE;
  process.env.VIBBO_COOKIE = "mock-cookie";

  try {
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      if (body.operationName === "getVibboOrgNodeId") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({ data: { organization: { id: "OrgNode:123" } } }),
          json: async () => ({ data: { organization: { id: "OrgNode:123" } } }),
        } as any;
      }
      if (body.operationName === "vibboTopicPage") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              data: {
                organization: {
                  topic: {
                    id: "Topic:target-1",
                    slug: "target-topic",
                    title: "Target Topic",
                    isPublished: true,
                  },
                },
              },
            }),
          json: async () => ({
            data: {
              organization: {
                topic: {
                  id: "Topic:target-1",
                  slug: "target-topic",
                  title: "Target Topic",
                  isPublished: true,
                },
              },
            },
          }),
        } as any;
      }
      if (body.operationName === "revisionHistoryList") {
        assert.equal(body.variables.relatedNodeId, "Topic:target-1");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              data: {
                history: [
                  {
                    id: "Rev:1",
                    updatedAt: "2026-01-01T10:00:00Z",
                    updatedBy: { id: "Member:1", name: "Alice" },
                  },
                  {
                    id: "Rev:2",
                    updatedAt: "2026-01-02T12:00:00Z",
                    updatedBy: { id: "Member:2", name: "Bob" },
                  },
                ],
              },
            }),
          json: async () => ({
            data: {
              history: [
                {
                  id: "Rev:1",
                  updatedAt: "2026-01-01T10:00:00Z",
                  updatedBy: { id: "Member:1", name: "Alice" },
                },
                {
                  id: "Rev:2",
                  updatedAt: "2026-01-02T12:00:00Z",
                  updatedBy: { id: "Member:2", name: "Bob" },
                },
              ],
            },
          }),
        } as any;
      }
      throw new Error(`Unexpected operation: ${body.operationName}`);
    }) as typeof fetch;

    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTopicDraftTools(server);

    const listTool = (server as any)._registeredTools[
      "vibbo_list_topic_revisions"
    ];
    const result = await listTool.handler({ topicSlug: "target-topic" });
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.topic.id, "Topic:target-1");
    assert.equal(parsed.totalRevisions, 2);
    assert.equal(parsed.revisions[0].id, "Rev:1");
    assert.equal(parsed.revisions[0].author, "Alice");
    assert.equal(parsed.revisions[1].id, "Rev:2");
    assert.equal(parsed.revisions[1].author, "Bob");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.VIBBO_COOKIE = originalCookie;
  }
});

test("vibbo_get_topic_revision retrieves revision details and formats markdown", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.VIBBO_COOKIE;
  process.env.VIBBO_COOKIE = "mock-cookie";

  try {
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      if (body.operationName === "entityRevision") {
        assert.equal(body.variables.revisionId, "Rev:123");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              data: {
                revision: {
                  id: "Rev:123",
                  updatedAt: "2026-01-05T14:00:00Z",
                  updatedBy: { id: "Member:3", name: "Charlie" },
                  content: {
                    meta: {
                      title: "Revision Title",
                      ingress: "Revision Ingress summary",
                    },
                    blocks: {
                      b1: {
                        type: "text",
                        id: "b1",
                        order: 1,
                        data: {
                          blocks: [
                            {
                              key: "k1",
                              text: "Heading 1",
                              type: "header-two",
                            },
                            {
                              key: "k2",
                              text: "Paragraph text",
                              type: "unstyled",
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            }),
          json: async () => ({
            data: {
              revision: {
                id: "Rev:123",
                updatedAt: "2026-01-05T14:00:00Z",
                updatedBy: { id: "Member:3", name: "Charlie" },
                content: {
                  meta: {
                    title: "Revision Title",
                    ingress: "Revision Ingress summary",
                  },
                  blocks: {
                    b1: {
                      type: "text",
                      id: "b1",
                      order: 1,
                      data: {
                        blocks: [
                          { key: "k1", text: "Heading 1", type: "header-two" },
                          {
                            key: "k2",
                            text: "Paragraph text",
                            type: "unstyled",
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          }),
        } as any;
      }
      throw new Error(`Unexpected operation: ${body.operationName}`);
    }) as typeof fetch;

    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerTopicDraftTools(server);

    const getRevTool = (server as any)._registeredTools[
      "vibbo_get_topic_revision"
    ];
    const result = await getRevTool.handler({ revisionId: "Rev:123" });
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.revision.id, "Rev:123");
    assert.equal(parsed.revision.author, "Charlie");
    assert.equal(parsed.meta.title, "Revision Title");
    assert.equal(parsed.meta.ingress, "Revision Ingress summary");
    assert.match(parsed.markdown, /## Heading 1/);
    assert.match(parsed.markdown, /Paragraph text/);
    assert.ok(parsed.rawContent);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.VIBBO_COOKIE = originalCookie;
  }
});
