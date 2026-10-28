import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { vibboGraphqlQuery } from "../vibbo-client.ts";
import { buildVibboWebUrl } from "../urls.ts";
import {
  CREATE_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
} from "../annotations.ts";
import {
  SAVE_ENTITY_REVISION_MUTATION,
  fetchAndVerifyDraftTopic,
  topicDraftContent,
  topicRevisionToken,
  composeDraftContent,
  convertDraftBlocksToMarkdown,
  parseTopicContent,
  assertMarkdownContent,
  canonicalJson,
} from "./topics.ts";
import type { DraftContentPayload, VerifiedDraftTopic } from "./topics.ts";

export const CREATE_FORM_MUTATION = `mutation createForm($input: CreateFormInput!) {
  createForm(input: $input) { id }
}`;

const locks = new Map<string, Promise<void>>();

/** Serialize aliases of the same topic within this server; recheck after waiting. */
export async function withDraftTopic<T>(
  slug: string,
  expectedRevision: string | undefined,
  action: (verified: VerifiedDraftTopic) => Promise<T>,
): Promise<T> {
  const initial = await fetchAndVerifyDraftTopic(slug);
  const key = `${initial.orgNodeId}:${initial.topic.id}`;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await previous;
  try {
    const fresh = await fetchAndVerifyDraftTopic(initial.topic.slug);
    if (
      fresh.topic.id !== initial.topic.id ||
      fresh.orgNodeId !== initial.orgNodeId
    )
      throw new Error("Topic identity changed. Read the draft again.");
    if (
      expectedRevision &&
      topicRevisionToken(fresh.topic) !== expectedRevision
    )
      throw new Error(
        "Draft changed since it was read. Use vibbo_get_topic_draft and retry with its revisionToken.",
      );
    return await action(fresh);
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

export async function saveTopicDraft(
  verified: VerifiedDraftTopic,
  content: DraftContentPayload,
) {
  parseTopicContent(content);
  if (!content.meta.title.trim() || content.meta.title.length > 200)
    throw new Error("Draft title must contain 1–200 characters.");
  const fresh = await fetchAndVerifyDraftTopic(verified.topic.slug);
  if (
    fresh.orgNodeId !== verified.orgNodeId ||
    fresh.topic.id !== verified.topic.id ||
    topicRevisionToken(fresh.topic) !== topicRevisionToken(verified.topic)
  ) {
    throw new Error(
      "Draft changed during this operation. Read it again before retrying; no revision was saved.",
    );
  }
  // Do not automatically replay write requests after an authentication error.
  const result = await vibboGraphqlQuery<{
    saveEntityRevision?: { id: string; updatedAt?: string; content?: unknown };
  }>(
    "saveEntityRevision",
    SAVE_ENTITY_REVISION_MUTATION,
    {
      input: {
        organizationId: fresh.orgNodeId,
        relatedNodeId: fresh.topic.id,
        content,
      },
    },
    false,
  );
  if (result.errors?.length || !result.data?.saveEntityRevision?.id) {
    throw new Error(
      "Draft save was not confirmed. Read the draft before retrying. " +
        (result.errors?.map((e) => e.message).join("; ") ??
          "Missing revision ID."),
    );
  }
  const revision = result.data.saveEntityRevision;
  if (
    revision.content != null &&
    canonicalJson(parseTopicContent(revision.content)) !==
      canonicalJson(parseTopicContent(content))
  ) {
    throw new Error(
      "Saved content differs from the requested draft. Read the draft before making further changes.",
    );
  }
  return revision;
}

function ordered(content: DraftContentPayload) {
  return Object.values(content.blocks).sort((a, b) => a.order - b.order);
}

export function draftEditorView(topic: any, orgSlug: string) {
  const content = topicDraftContent(topic);
  const definitions = new Map<string, any>(
    (topic.forms ?? []).map((f: any) => [f.id, f]),
  );
  const referenced = new Set<string>();
  const sections = ordered(content).map((section) => {
    if (section.type === "text")
      return {
        id: section.id,
        type: section.type,
        order: section.order,
        markdown: convertDraftBlocksToMarkdown({
          blocks: { [section.id]: section },
        }),
      };
    if (section.type === "form") {
      const formId = section.data.formId;
      if (typeof formId === "string") referenced.add(formId);
      const form =
        typeof formId === "string" ? definitions.get(formId) : undefined;
      return {
        id: section.id,
        type: section.type,
        order: section.order,
        formId,
        form: form
          ? {
              title: form.title,
              fields: form.fields?.map((f: any) => ({
                label: f.value,
                required: f.required === true,
              })),
              attachmentsEnabled: form.attachmentsEnabled,
              recipientEmailAddress: form.recipientEmailAddress,
              deliverByMessage: form.deliverByMessage,
              deliverByEmail: form.deliverByEmail,
            }
          : null,
      };
    }
    return {
      id: section.id,
      type: section.type,
      order: section.order,
      data: section.data,
    };
  });
  return {
    topic: {
      id: topic.id,
      slug: topic.slug,
      title: content.meta.title,
      ingress: content.meta.ingress,
      isPublished: topic.isPublished,
      webUrl: buildVibboWebUrl("tema", topic.slug, orgSlug),
    },
    revisionToken: topicRevisionToken(topic),
    sections,
    unreferencedForms: (topic.forms ?? [])
      .filter((f: any) => !referenced.has(f.id))
      .map((f: any) => ({ id: f.id, title: f.title })),
  };
}

const topicSlug = z
  .string()
  .min(1)
  .describe(
    "Slug or NodeID of an unpublished topic. Published topics (including their drafts) are refused.",
  );
const expectedRevision = z
  .string()
  .optional()
  .describe(
    "revisionToken from vibbo_get_topic_draft; prevents overwriting a stale draft.",
  );
const afterSectionId = z
  .string()
  .nullable()
  .optional()
  .describe(
    "Place after this section ID; null inserts at the beginning; omitted appends at the end.",
  );
const title = z.string().trim().min(1).max(200);
const fields = z
  .array(
    z
      .object({
        label: z.string().trim().min(1),
        required: z.boolean().optional().default(false),
      })
      .strict(),
  )
  .min(1)
  .max(100);
const email = z.union([z.string().trim().email(), z.literal("")]);
const formOptions = {
  title,
  fields,
  recipientEmailAddress: email
    .optional()
    .describe(
      "External recipient email, or empty string for none. Defaults to none.",
    ),
  attachmentsEnabled: z
    .boolean()
    .optional()
    .describe("Allow resident file attachments; defaults to false."),
  deliverByMessage: z
    .boolean()
    .optional()
    .describe("Deliver responses as board messages; defaults to true."),
  deliverByEmail: z
    .boolean()
    .optional()
    .describe("Deliver responses by email; defaults to true."),
};

type FormDefinition = {
  title: string;
  fields: Array<{ label: string; required?: boolean }>;
  recipientEmailAddress?: string | undefined;
  attachmentsEnabled?: boolean | undefined;
  deliverByMessage?: boolean | undefined;
  deliverByEmail?: boolean | undefined;
};

function insertSection(
  content: DraftContentPayload,
  section: DraftContentPayload["blocks"][string],
  after: string | null | undefined,
) {
  const sections = ordered(content);
  if (after !== undefined && after !== null && !content.blocks[after])
    throw new Error(
      `Unknown afterSectionId '${after}'. Read vibbo_get_topic_draft.`,
    );
  const index =
    after === undefined
      ? sections.length
      : after === null
        ? 0
        : sections.findIndex((s) => s.id === after) + 1;
  sections.splice(index, 0, section);
  // Reindex numeric order only; every existing section's ID and data is retained.
  sections.forEach((s, i) => {
    content.blocks[s.id] = { ...s, order: i + 1 };
  });
}

function formSection(verified: VerifiedDraftTopic, sectionId: string) {
  const content = topicDraftContent(verified.topic);
  const section = content.blocks[sectionId];
  if (
    !section ||
    section.type !== "form" ||
    typeof section.data.formId !== "string"
  )
    throw new Error(
      `Section '${sectionId}' is not a form section. Read vibbo_get_topic_draft.`,
    );
  return { content, section };
}

async function createFormRecord(
  verified: VerifiedDraftTopic,
  definition: FormDefinition,
) {
  // Defend direct calls too; the SDK normally performs this validation.
  const valid = z.object(formOptions).strict().parse(definition);
  const result = await vibboGraphqlQuery<{ createForm?: { id: string } }>(
    "createForm",
    CREATE_FORM_MUTATION,
    {
      input: {
        organizationId: verified.orgNodeId,
        parentType: "topic",
        parentId: verified.topic.id,
        title: valid.title,
        fields: valid.fields.map((f) => ({
          value: f.label,
          required: f.required,
        })),
        recipientEmailAddress: valid.recipientEmailAddress ?? "",
        attachmentsEnabled: valid.attachmentsEnabled ?? false,
        deliverByMessage: valid.deliverByMessage ?? true,
        deliverByEmail: valid.deliverByEmail ?? true,
      },
    },
    false,
  );
  if (result.errors?.length || !result.data?.createForm?.id)
    throw new Error(
      "Form creation was not confirmed. Inspect associated forms before retrying; the server may have created a record. " +
        (result.errors?.map((e) => e.message).join("; ") ?? "Missing form ID."),
    );
  const id = result.data.createForm.id;
  // Defense against an anomalous API response: never attach a pre-existing ID.
  if ((verified.topic.forms ?? []).some((f: any) => f.id === id))
    throw new Error(
      "Form creation returned an existing ID. No draft reference was changed.",
    );
  return {
    id,
    title: valid.title,
    fields: valid.fields.map((f) => ({ value: f.label, required: f.required })),
    recipientEmailAddress: valid.recipientEmailAddress ?? "",
    attachmentsEnabled: valid.attachmentsEnabled ?? false,
    deliverByMessage: valid.deliverByMessage ?? true,
    deliverByEmail: valid.deliverByEmail ?? true,
  };
}

function response(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function registerStructuredTopicTools(server: McpServer): void {
  server.registerTool(
    "vibbo_get_topic_draft",
    {
      description:
        "Read an unpublished Tema draft as ordered editable sections, formatted Markdown, form definitions and a revisionToken. Start here before editing. No raw editor JSON is needed.",
      inputSchema: z.object({ topicSlug }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      const verified = await fetchAndVerifyDraftTopic(args.topicSlug);
      return response({
        ...draftEditorView(verified.topic, verified.orgSlug),
        editing: {
          text: "Use vibbo_update_topic_draft for one text section or vibbo_edit_topic_draft_sections for insert/update/remove/move operations.",
          forms:
            "Use vibbo_add_topic_form_draft, vibbo_update_topic_form_draft and vibbo_remove_topic_form_draft with section IDs. Updating creates a separate form and leaves prior forms/answers unchanged.",
          markdown:
            "Headings (all render as level 2), paragraphs, nested bullet/numbered lists (start at 1), **bold**, *italic*, `inline code`, [links](https://example.com). Strikethrough, tables, HTML, images, blockquotes and fenced code are rejected.",
        },
      });
    },
  );

  const edits = z
    .array(
      z.discriminatedUnion("action", [
        z
          .object({
            action: z.literal("insert_text"),
            content: z.string(),
            afterSectionId,
          })
          .strict(),
        z
          .object({
            action: z.literal("update_text"),
            sectionId: z.string(),
            content: z.string(),
          })
          .strict(),
        z
          .object({ action: z.literal("remove"), sectionId: z.string() })
          .strict(),
        z
          .object({
            action: z.literal("move"),
            sectionId: z.string(),
            afterSectionId: z.string().nullable(),
          })
          .strict(),
      ]),
    )
    .min(1)
    .max(100);
  server.registerTool(
    "vibbo_edit_topic_draft_sections",
    {
      description:
        "Edit draft sections in order: insert_text, update_text, remove, or move. Text uses Markdown. Other sections are preserved. Removing a section only detaches it from this draft; associated forms, attachments and calendars are never deleted. Read vibbo_get_topic_draft for section IDs.",
      inputSchema: z.object({ topicSlug, expectedRevision, edits }),
      annotations: { ...UPDATE_ANNOTATIONS, idempotentHint: false },
    },
    async (args) =>
      withDraftTopic(
        args.topicSlug,
        args.expectedRevision,
        async (verified) => {
          const content = topicDraftContent(verified.topic);
          const changes: Array<{ action: string; sectionId: string }> = [];
          for (const edit of edits.parse(args.edits)) {
            if (edit.action === "insert_text") {
              assertMarkdownContent(edit.content);
              const generated = composeDraftContent(
                content.meta.title,
                content.meta.ingress,
                edit.content,
              );
              const section = Object.values(generated.blocks)[0]!;
              insertSection(content, section, edit.afterSectionId);
              changes.push({ action: edit.action, sectionId: section.id });
            } else {
              const section = content.blocks[edit.sectionId];
              if (!section)
                throw new Error(
                  `Unknown section '${edit.sectionId}'. No edits saved.`,
                );
              if (edit.action === "update_text") {
                content.blocks = composeDraftContent(
                  content.meta.title,
                  content.meta.ingress,
                  edit.content,
                  content,
                  edit.sectionId,
                ).blocks;
              } else if (edit.action === "remove") {
                delete content.blocks[edit.sectionId];
              } else {
                if (edit.afterSectionId === edit.sectionId)
                  throw new Error("Cannot move a section after itself.");
                delete content.blocks[edit.sectionId];
                insertSection(content, section, edit.afterSectionId);
              }
              changes.push({ action: edit.action, sectionId: edit.sectionId });
            }
          }
          const revision = await saveTopicDraft(verified, content);
          return response({
            success: true,
            revisionId: revision.id,
            changes,
            ...draftEditorView(
              {
                ...verified.topic,
                draft: { content, updatedAt: revision.updatedAt },
              },
              verified.orgSlug,
            ),
          });
        },
      ),
  );

  server.registerTool(
    "vibbo_add_topic_form_draft",
    {
      description:
        "Add a resident form to an unpublished Tema draft. Supply title and fields with label/required, plus optional delivery settings. Creates a new isolated form record and inserts its section. Never publishes, submits answers or edits existing forms. On partial failure inspect createdFormId before retrying.",
      inputSchema: z.object({
        topicSlug,
        expectedRevision,
        afterSectionId,
        ...formOptions,
      }),
      annotations: CREATE_ANNOTATIONS,
    },
    async (args) =>
      withDraftTopic(
        args.topicSlug,
        args.expectedRevision,
        async (verified) => {
          const content = topicDraftContent(verified.topic);
          // Validate placement before creating a separate API record.
          const section = {
            id: crypto.randomUUID(),
            type: "form",
            order: 1,
            data: {} as { formId?: string },
          };
          insertSection(content, section, args.afterSectionId);
          const {
            topicSlug: _slug,
            expectedRevision: _revision,
            afterSectionId: _after,
            ...definition
          } = args;
          const form = await createFormRecord(verified, definition);
          content.blocks[section.id]!.data.formId = form.id;
          try {
            const revision = await saveTopicDraft(verified, content);
            return response({
              success: true,
              formId: form.id,
              sectionId: section.id,
              revisionId: revision.id,
              ...draftEditorView(
                {
                  ...verified.topic,
                  forms: [...(verified.topic.forms ?? []), form],
                  draft: { content, updatedAt: revision.updatedAt },
                },
                verified.orgSlug,
              ),
            });
          } catch (error) {
            return {
              ...response({
                success: false,
                createdFormId: form.id,
                sectionId: section.id,
                message: `Form record created; draft insertion was not confirmed. Read the draft and associated forms before retrying. No record was deleted. ${String(error)}`,
              }),
              isError: true,
            };
          }
        },
      ),
  );

  const optionalFormOptions = Object.fromEntries(
    Object.entries(formOptions).map(([key, schema]) => [
      key,
      schema.optional(),
    ]),
  ) as {
    [K in keyof typeof formOptions]: z.ZodOptional<(typeof formOptions)[K]>;
  };
  server.registerTool(
    "vibbo_update_topic_form_draft",
    {
      description:
        "Change a form on an unpublished draft using its sectionId. Creates a NEW isolated form and replaces this draft reference; NEVER updates an existing form record or its submissions. Omitted settings are retained; fields replaces the whole label/required list. Previous answers remain on the old form ID. Read the draft after partial failure.",
      inputSchema: z.object({
        topicSlug,
        expectedRevision,
        sectionId: z.string(),
        ...optionalFormOptions,
      }),
      annotations: CREATE_ANNOTATIONS,
    },
    async (args) =>
      withDraftTopic(
        args.topicSlug,
        args.expectedRevision,
        async (verified) => {
          const { content, section } = formSection(verified, args.sectionId);
          const old = (verified.topic.forms ?? []).find(
            (f: any) => f.id === section.data.formId,
          );
          if (!old || !Array.isArray(old.fields))
            throw new Error(
              "Cannot read the current form definition. No form was created.",
            );
          if (
            ![
              "title",
              "fields",
              "recipientEmailAddress",
              "attachmentsEnabled",
              "deliverByMessage",
              "deliverByEmail",
            ].some((key) => (args as any)[key] !== undefined)
          )
            throw new Error("Provide at least one form setting to change.");
          const definition: FormDefinition = {
            title: args.title ?? old.title,
            fields:
              args.fields ??
              old.fields.map((f: any) => ({
                label: f.value,
                required: f.required === true,
              })),
            recipientEmailAddress:
              args.recipientEmailAddress ?? old.recipientEmailAddress ?? "",
            attachmentsEnabled:
              args.attachmentsEnabled ?? old.attachmentsEnabled ?? false,
            deliverByMessage:
              args.deliverByMessage ?? old.deliverByMessage ?? true,
            deliverByEmail: args.deliverByEmail ?? old.deliverByEmail ?? true,
          };
          const form = await createFormRecord(verified, definition);
          section.data.formId = form.id;
          try {
            const revision = await saveTopicDraft(verified, content);
            return response({
              success: true,
              formId: form.id,
              replacedFormId: old.id,
              sectionId: section.id,
              revisionId: revision.id,
              previousSubmissionsRetained: true,
              ...draftEditorView(
                {
                  ...verified.topic,
                  forms: [...verified.topic.forms, form],
                  draft: { content, updatedAt: revision.updatedAt },
                },
                verified.orgSlug,
              ),
            });
          } catch (error) {
            return {
              ...response({
                success: false,
                createdFormId: form.id,
                replacedFormId: old.id,
                message: `Replacement form created; reference save was not confirmed. Inspect the draft before retrying. The prior form and answers were not changed. ${String(error)}`,
              }),
              isError: true,
            };
          }
        },
      ),
  );

  server.registerTool(
    "vibbo_remove_topic_form_draft",
    {
      description:
        "Remove a form section from an unpublished topic draft. Only removes this draft reference; never deletes the form record or previous answers. Use sectionId from vibbo_get_topic_draft.",
      inputSchema: z.object({
        topicSlug,
        expectedRevision,
        sectionId: z.string(),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async (args) =>
      withDraftTopic(
        args.topicSlug,
        args.expectedRevision,
        async (verified) => {
          const { content, section } = formSection(verified, args.sectionId);
          delete content.blocks[section.id];
          const revision = await saveTopicDraft(verified, content);
          return response({
            success: true,
            removedSectionId: section.id,
            retainedFormId: section.data.formId,
            revisionId: revision.id,
            ...draftEditorView(
              {
                ...verified.topic,
                draft: { content, updatedAt: revision.updatedAt },
              },
              verified.orgSlug,
            ),
          });
        },
      ),
  );
}
