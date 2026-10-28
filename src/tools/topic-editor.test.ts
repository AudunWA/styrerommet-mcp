import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/server";
import { vibboRegistry } from "../vibbo-registry.ts";
import { reloadVibboTokens } from "../vibbo-client.ts";
import {
  registerTopicDraftTools,
  composeDraftContent,
  topicRevisionToken,
  convertTextToProseMirrorBlocks,
  convertDraftBlocksToMarkdown,
} from "./topics.ts";

const originalFetch = globalThis.fetch;
const previousEnv = {
  cookie: process.env.VIBBO_COOKIE,
  slug: process.env.VIBBO_ORG_SLUG,
  noLogin: process.env.NO_AUTO_LOGIN,
};
test.before(async () => {
  await vibboRegistry.load();
});
test.beforeEach(() => {
  process.env.VIBBO_COOKIE = "mock-cookie";
  process.env.VIBBO_ORG_SLUG = "example-coop";
  process.env.NO_AUTO_LOGIN = "true";
  reloadVibboTokens();
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [
    ["VIBBO_COOKIE", previousEnv.cookie],
    ["VIBBO_ORG_SLUG", previousEnv.slug],
    ["NO_AUTO_LOGIN", previousEnv.noLogin],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture() {
  const content = composeDraftContent(
    "Nøkler",
    "Introduksjon",
    "## Bestill\n\nBruk **skjemaet** nedenfor.",
  );
  const textId = Object.keys(content.blocks)[0]!;
  content.meta.custom = "keep metadata";
  content.blocks.photo = {
    id: "photo",
    type: "image",
    order: 2,
    data: { attachmentId: "shared-photo" },
  };
  content.blocks.form = {
    id: "form",
    type: "form",
    order: 3,
    data: { formId: "Form:published-shared" },
  };
  return {
    id: "Topic:draft",
    slug: "draft",
    title: "Nøkler",
    isPublished: false,
    isClusterTopic: false,
    organization: { id: "Org:123" },
    authorOrganization: { id: "Org:123" },
    article: { blocks: {} },
    draft: { content, updatedAt: "initial" },
    forms: [
      {
        id: "Form:published-shared",
        isClusterForm: false,
        title: "Bestill nøkkel",
        fields: [{ id: "old-field", value: "Antall", required: true }],
        recipientEmailAddress: "",
        attachmentsEnabled: false,
        deliverByMessage: true,
        deliverByEmail: true,
      },
    ],
    textId,
  };
}

function mockApi(topic: any = fixture()) {
  const calls: Array<{ operationName: string; variables: any }> = [];
  const records = new Map<string, any>(
    topic.forms.map((f: any) => [f.id, structuredClone(f)]),
  );
  const state = {
    topic,
    failSave: false,
    failDelete: false,
    partialPage: false,
    partialSave: false,
    afterCreateForm: undefined as (() => void) | undefined,
    deleted: false,
  };
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    calls.push(body);
    const { operationName: op, variables: v } = body;
    let result: any;
    if (op === "getVibboOrgNodeId")
      result = { data: { organization: { id: "Org:123" } } };
    else if (op === "vibboTopicPage")
      result = {
        data: {
          organization: {
            topic: state.deleted ? null : structuredClone(topic),
          },
        },
        ...(state.partialPage
          ? { errors: [{ message: "Partial query failure" }] }
          : {}),
      };
    else if (op === "vibboBrowseTopics")
      result = {
        data: {
          organization: {
            topics: state.deleted
              ? []
              : [
                  {
                    id: topic.id,
                    slug: topic.slug,
                    title: topic.title,
                    isPublished: topic.isPublished,
                  },
                ],
          },
        },
      };
    else if (op === "verifyTopicDraftDeletion")
      result = {
        data: {
          organization: { topics: state.deleted ? [] : [{ id: topic.id }] },
        },
      };
    else if (op === "createForm") {
      const id = `Form:new-${records.size}`;
      const form = {
        ...v.input,
        id,
        isClusterForm: false,
        fields: v.input.fields.map((f: any, i: number) => ({
          ...f,
          id: `${id}-field-${i}`,
        })),
      };
      records.set(id, structuredClone(form));
      topic.forms.push(form);
      state.afterCreateForm?.();
      result = { data: { createForm: { id } } };
    } else if (op === "saveEntityRevision") {
      if (state.failSave)
        result = { data: null, errors: [{ message: "Save failed" }] };
      else {
        topic.draft = {
          content: structuredClone(v.input.content),
          updatedAt: `revision-${calls.length}`,
        };
        result = {
          data: {
            saveEntityRevision: {
              id: `Revision:${calls.length}`,
              ...topic.draft,
            },
          },
          ...(state.partialSave
            ? { errors: [{ message: "Partial save failure" }] }
            : {}),
        };
      }
    } else if (op === "deleteTopic") {
      state.deleted = !state.failDelete;
      result = { data: { deleteTopic: state.failDelete ? false : null } };
    } else throw new Error(`Unexpected API operation ${op}`);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const server = new McpServer({ name: "test", version: "1" });
  registerTopicDraftTools(server);
  const invoke = async (name: string, args: any) => {
    const tool = (server as any)._registeredTools[name];
    const result = await tool.handler(tool.inputSchema.parse(args));
    return { result, value: JSON.parse(result.content[0].text) };
  };
  return {
    state,
    calls,
    records,
    invoke,
    server,
    mutations: () =>
      calls.filter((c) =>
        [
          "createForm",
          "updateForm",
          "saveEntityRevision",
          "deleteTopic",
        ].includes(c.operationName),
      ),
  };
}

const writes = [
  ["vibbo_update_topic_draft", { content: "Updated" }],
  ["vibbo_delete_topic_draft", {}],
  [
    "vibbo_edit_topic_draft_sections",
    { edits: [{ action: "remove", sectionId: "form" }] },
  ],
  [
    "vibbo_add_topic_form_draft",
    {
      title: "Nøkkelbestilling",
      fields: [{ label: "Antall", required: true }],
    },
  ],
  ["vibbo_update_topic_form_draft", { sectionId: "form", title: "Updated" }],
  ["vibbo_remove_topic_form_draft", { sectionId: "form" }],
] as const;

for (const [name, args] of writes) {
  test(`${name} denies published topics, foreign/unknown ownership, cluster topics and partial reads before any mutation`, async () => {
    const variants = [
      { isPublished: true },
      { isPublished: undefined },
      { organization: { id: "Org:other" } },
      { organization: undefined },
      { authorOrganization: { id: "Org:other" } },
      { isClusterTopic: true },
      { isClusterTopic: undefined },
    ];
    for (const overrides of variants) {
      const api = mockApi({ ...fixture(), ...overrides });
      await assert.rejects(
        api.invoke(name, { topicSlug: "draft", ...args }),
        /DENIED/,
      );
      assert.equal(api.mutations().length, 0);
    }
    const api = mockApi();
    api.state.partialPage = true;
    await assert.rejects(
      api.invoke(name, { topicSlug: "draft", ...args }),
      /errors|ambiguous/,
    );
    assert.equal(api.mutations().length, 0);
  });
}

test("read exposes editable sections, Markdown, human field labels and a usable revision token", async () => {
  const api = mockApi();
  const { value } = await api.invoke("vibbo_get_topic_draft", {
    topicSlug: "draft",
  });
  assert.match(value.sections[0].markdown, /\*\*skjemaet\*\*/);
  assert.deepEqual(value.sections[2].form.fields, [
    { label: "Antall", required: true },
  ]);
  assert.equal(value.revisionToken, topicRevisionToken(api.state.topic));
  assert.equal(api.mutations().length, 0);
});

test("single-text update and empty-string clearing preserve the form, image, section position and unknown metadata", async () => {
  const api = mockApi();
  const original = structuredClone(api.state.topic.draft.content);
  await api.invoke("vibbo_update_topic_draft", {
    topicSlug: "draft",
    content: "## Nytt\n\n**Fet** tekst",
    expectedRevision: topicRevisionToken(api.state.topic),
  });
  const content = api.state.topic.draft.content;
  assert.deepEqual(content.blocks.form, original.blocks.form);
  assert.deepEqual(content.blocks.photo, original.blocks.photo);
  assert.equal(content.meta.custom, "keep metadata");
  assert.equal(content.blocks[api.state.topic.textId].order, 1);
  await api.invoke("vibbo_update_topic_draft", {
    topicSlug: "draft",
    content: "",
  });
  assert.deepEqual(
    api.state.topic.draft.content.blocks[api.state.topic.textId].data.content,
    [{ type: "paragraph" }],
  );
  assert.deepEqual(
    api.state.topic.draft.content.blocks.form,
    original.blocks.form,
  );
});

test("multiple text sections require an explicit target and never flatten around a form", async () => {
  const api = mockApi();
  api.state.topic.draft.content.blocks.last = {
    ...Object.values(convertTextToProseMirrorBlocks("After", "last"))[0],
    order: 4,
  };
  await assert.rejects(
    api.invoke("vibbo_update_topic_draft", {
      topicSlug: "draft",
      content: "Ambiguous",
    }),
    /Multiple text sections/,
  );
  assert.equal(api.mutations().length, 0);
  const before = structuredClone(api.state.topic.draft.content);
  await api.invoke("vibbo_update_topic_draft", {
    topicSlug: "draft",
    content: "After updated",
    contentSectionId: "last",
  });
  assert.deepEqual(
    api.state.topic.draft.content.blocks.form,
    before.blocks.form,
  );
  assert.deepEqual(
    api.state.topic.draft.content.blocks[api.state.topic.textId],
    before.blocks[api.state.topic.textId],
  );
  assert.match(
    convertDraftBlocksToMarkdown({
      blocks: { last: api.state.topic.draft.content.blocks.last },
    }),
    /After updated/,
  );
});

test("structured edits insert, move, update and remove sections in one saved revision", async () => {
  const api = mockApi();
  const oldForm = structuredClone(
    api.state.topic.draft.content.blocks.form.data,
  );
  const { value } = await api.invoke("vibbo_edit_topic_draft_sections", {
    topicSlug: "draft",
    edits: [
      {
        action: "insert_text",
        content: "## Etter skjema",
        afterSectionId: "form",
      },
      { action: "move", sectionId: "photo", afterSectionId: null },
      {
        action: "update_text",
        sectionId: api.state.topic.textId,
        content: "Før skjema",
      },
    ],
  });
  assert.deepEqual(
    value.sections.map((s: any) => s.type),
    ["image", "text", "form", "text"],
  );
  assert.deepEqual(api.state.topic.draft.content.blocks.form.data, oldForm);
  assert.equal(api.mutations().length, 1);
  const count = api.mutations().length;
  await assert.rejects(
    api.invoke("vibbo_edit_topic_draft_sections", {
      topicSlug: "draft",
      edits: [
        { action: "remove", sectionId: "photo" },
        { action: "move", sectionId: "form", afterSectionId: "missing" },
      ],
    }),
    /Unknown/,
  );
  assert.ok(api.state.topic.draft.content.blocks.photo);
  assert.equal(api.mutations().length, count);
});

test("adding a form uses actual frontend API shape and creates a reference at the requested position", async () => {
  const api = mockApi();
  const { value } = await api.invoke("vibbo_add_topic_form_draft", {
    topicSlug: "draft",
    title: "Nøkkelbestilling",
    fields: [{ label: "Antall", required: true }, { label: "Kommentar" }],
    afterSectionId: api.state.topic.textId,
  });
  const input = api.calls.find((c) => c.operationName === "createForm")!
    .variables.input;
  assert.equal(input.parentType, "topic");
  assert.equal(input.parentId, "Topic:draft");
  assert.equal(input.organizationId, "Org:123");
  assert.deepEqual(input.fields, [
    { value: "Antall", required: true },
    { value: "Kommentar", required: false },
  ]);
  assert.equal(input.deliverByEmail, true);
  assert.equal(input.deliverByMessage, true);
  assert.equal(value.sections[1].formId, value.formId);
  assert.equal(
    api.state.topic.draft.content.blocks[value.sectionId].data.formId,
    value.formId,
  );
});

test("form changes always copy on write, even when the previous record is shared with a published page", async () => {
  const api = mockApi();
  const prior = structuredClone(api.records.get("Form:published-shared"));
  const { value } = await api.invoke("vibbo_update_topic_form_draft", {
    topicSlug: "draft",
    sectionId: "form",
    title: "Ny tittel",
    recipientEmailAddress: "keys@example.com",
  });
  assert.notEqual(value.formId, prior.id);
  assert.equal(value.replacedFormId, prior.id);
  assert.deepEqual(api.records.get(prior.id), prior);
  assert.equal(
    api.calls.some((c) => c.operationName === "updateForm"),
    false,
  );
  const newInput = api.calls.find((c) => c.operationName === "createForm")!
    .variables.input;
  assert.deepEqual(newInput.fields, [{ value: "Antall", required: true }]);
  assert.equal(newInput.attachmentsEnabled, false);
  assert.equal(newInput.recipientEmailAddress, "keys@example.com");
  assert.equal(
    api.state.topic.draft.content.blocks.form.data.formId,
    value.formId,
  );
});

test("removing a form detaches only the reference, retaining records and prior answers", async () => {
  const api = mockApi();
  const before = structuredClone([...api.records]);
  const { value } = await api.invoke("vibbo_remove_topic_form_draft", {
    topicSlug: "draft",
    sectionId: "form",
  });
  assert.equal(value.retainedFormId, "Form:published-shared");
  assert.equal(api.state.topic.draft.content.blocks.form, undefined);
  assert.deepEqual([...api.records], before);
  assert.deepEqual(
    api.mutations().map((c) => c.operationName),
    ["saveEntityRevision"],
  );
});

test("stale revision tokens and malformed content stop before any mutation", async () => {
  for (const [name, args] of writes.filter(
    ([name]) => name !== "vibbo_delete_topic_draft",
  )) {
    const api = mockApi();
    await assert.rejects(
      api.invoke(name, {
        topicSlug: "draft",
        expectedRevision: "stale",
        ...args,
      }),
      /changed since/,
    );
    assert.equal(api.mutations().length, 0);
  }
  for (const blocks of [
    [],
    {
      broken: {
        type: "form",
        id: "wrong",
        order: 1,
        data: { formId: "other" },
      },
    },
  ]) {
    const api = mockApi();
    api.state.topic.draft.content.blocks = blocks;
    await assert.rejects(
      api.invoke("vibbo_update_topic_draft", {
        topicSlug: "draft",
        title: "Change",
      }),
      /safely read/,
    );
    assert.equal(api.mutations().length, 0);
  }
});

test("placement, field validation and raw JSON reference injection fail before record creation", async () => {
  const api = mockApi();
  await assert.rejects(
    api.invoke("vibbo_add_topic_form_draft", {
      topicSlug: "draft",
      title: "Test",
      fields: [{ label: "Antall" }],
      afterSectionId: "missing",
    }),
    /Unknown/,
  );
  await assert.rejects(
    api.invoke("vibbo_add_topic_form_draft", {
      topicSlug: "draft",
      title: "Test",
      fields: [],
    }),
  );
  await assert.rejects(
    api.invoke("vibbo_update_topic_draft", {
      topicSlug: "draft",
      content: JSON.stringify({
        blocks: {
          injected: {
            type: "form",
            id: "injected",
            order: 2,
            data: { formId: "live-form" },
          },
        },
      }),
    }),
    /Raw JSON/,
  );
  assert.equal(api.mutations().length, 0);
});

test("publication or concurrent draft edits between form creation and reference save prevent the save and expose recovery IDs", async () => {
  for (const publish of [true, false]) {
    const api = mockApi();
    const before = structuredClone(api.state.topic.draft.content);
    api.state.afterCreateForm = () => {
      if (publish) api.state.topic.isPublished = true;
      else api.state.topic.draft.content.meta.ingress = "Concurrent edit";
    };
    const { result, value } = await api.invoke("vibbo_add_topic_form_draft", {
      topicSlug: "draft",
      title: "Test",
      fields: [{ label: "Antall" }],
    });
    assert.equal(result.isError, true);
    assert.ok(value.createdFormId);
    assert.deepEqual(
      api.mutations().map((c) => c.operationName),
      ["createForm"],
    );
    assert.deepEqual(api.state.topic.draft.content.blocks, before.blocks);
  }
});

test("failed and partial saves do not claim success or delete created form records", async () => {
  for (const partial of [true, false]) {
    const api = mockApi();
    api.state.partialSave = partial;
    api.state.failSave = !partial;
    const { result, value } = await api.invoke("vibbo_add_topic_form_draft", {
      topicSlug: "draft",
      title: "Test",
      fields: [{ label: "Antall" }],
    });
    assert.equal(result.isError, true);
    assert.ok(api.records.has(value.createdFormId));
    assert.equal(
      api.calls.some((c) => /delete|updateForm/.test(c.operationName)),
      false,
    );
  }
});

test("two concurrent edits with the same revision token serialize and reject the stale writer", async () => {
  const api = mockApi();
  const token = topicRevisionToken(api.state.topic);
  const results = await Promise.allSettled([
    api.invoke("vibbo_update_topic_draft", {
      topicSlug: "draft",
      title: "First",
      expectedRevision: token,
    }),
    api.invoke("vibbo_update_topic_draft", {
      topicSlug: "Topic:draft",
      title: "Second",
      expectedRevision: token,
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(api.mutations().length, 1);
});

test("Markdown nesting, ordered start, links, escaped syntax and hard breaks produce editor-compatible content", () => {
  const blocks = convertTextToProseMirrorBlocks(
    "# Overskrift\n\n- Først\n  1. **Tre**\n  2. [Fire](https://example.com)\n- Sist\n\nLinje en  \nLinje to med \\*stjerner\\*.",
  );
  const nodes = Object.values(blocks)[0]!.data.content!;
  assert.deepEqual(nodes[0]?.attrs, { level: 2 });
  const nested = nodes[1]?.content?.[0]?.content?.[1];
  assert.equal(nested?.type, "orderedList");
  assert.equal(nested?.attrs, undefined);
  assert.equal(nested?.content?.length, 2);
  const markdown = convertDraftBlocksToMarkdown({ blocks });
  assert.match(markdown, /  1\. \*\*Tre\*\*/);
  assert.match(markdown, /  2\. \[Fire\]/);
  assert.ok(nodes[2]?.content?.some((n) => n.type === "hardBreak"));
  assert.match(
    nodes[2]?.content?.map((n) => n.text ?? "").join("") ?? "",
    /\*stjerner\*/,
  );
  for (const bad of [
    "~~Unsupported strike~~",
    "3. Unsupported numbered start",
    "[link](javascript:alert)",
    "[link](data:text/html)",
    "| A | B |\n| --- | --- |",
    "> quote",
    "```\ncode\n```",
    "<div>HTML</div>",
  ]) {
    assert.throws(() => composeDraftContent("Test", "", bad));
  }
});

test("deletion verifies Vibbo's void response and refuses shared child forms", async () => {
  let api = mockApi();
  api.state.topic.forms[0].isClusterForm = true;
  await assert.rejects(
    api.invoke("vibbo_delete_topic_draft", { topicSlug: "draft" }),
    /shared\/cluster forms/,
  );
  assert.equal(api.mutations().length, 0);
  api = mockApi();
  await assert.rejects(
    api.invoke("vibbo_delete_topic_draft", {
      topicSlug: "draft",
      expectedRevision: "stale",
    }),
    /changed since/,
  );
  assert.equal(api.mutations().length, 0);
  const succeeded = await api.invoke("vibbo_delete_topic_draft", {
    topicSlug: "draft",
  });
  assert.equal(succeeded.value.success, true);
  api = mockApi();
  api.state.failDelete = true;
  await assert.rejects(
    api.invoke("vibbo_delete_topic_draft", { topicSlug: "draft" }),
    /not confirmed/,
  );
});
