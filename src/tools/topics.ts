import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  vibboGraphqlQuery,
  getVibboOrgSlug,
  getVibboOrgNodeId,
} from "../vibbo-client.ts";
import { vibboRegistry } from "../vibbo-registry.ts";
import { buildVibboWebUrl } from "../urls.ts";
import {
  registerStructuredTopicTools,
  withDraftTopic,
  saveTopicDraft,
  draftEditorView,
} from "./topic-editor.ts";
import {
  CREATE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
} from "../annotations.ts";

/**
 * GraphQL operation queries for topic draft management.
 */
export const CREATE_TOPIC_MUTATION = `mutation createTopic($input: CreateTopicInput!) {
  createTopic(input: $input) {
    id
    title
    slug
    isPublished
    isClusterTopic
    organization {
      id
    }
  }
}`;

export const SAVE_ENTITY_REVISION_MUTATION = `mutation saveEntityRevision($input: SaveEntityRevisionInput!) {
  saveEntityRevision(input: $input) {
    id
    updatedAt
    updatedBy {
      id
      name
    }
    content
  }
}`;

export const DELETE_TOPIC_MUTATION = `mutation deleteTopic($topicId: NodeID!) {
  deleteTopic(id: $topicId)
}`;

export const REVISION_HISTORY_QUERY = `query revisionHistoryList($relatedNodeId: UnpackedNodeID!) {
  history: revisionHistoryForRelatedNodeId(relatedNodeId: $relatedNodeId) {
    id
    updatedAt
    updatedBy {
      id
      name
    }
  }
}`;

export const ENTITY_REVISION_QUERY = `query entityRevision($revisionId: NodeID!) {
  revision: revisionById(id: $revisionId) {
    id
    updatedAt
    updatedBy {
      id
      name
    }
    content
  }
}`;

export interface DraftInlineStyleRange {
  offset: number;
  length: number;
  style: string;
}

export interface DraftEntityRange {
  offset: number;
  length: number;
  key: number;
}

export interface DraftBlockItem {
  key: string;
  text: string;
  type: string;
  depth: number;
  inlineStyleRanges: DraftInlineStyleRange[];
  entityRanges: DraftEntityRange[];
  data: Record<string, unknown>;
}

export interface ProseMirrorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorNode[];
  text?: string;
  marks?: ProseMirrorMark[];
}

export interface ProseMirrorDoc {
  type: "doc";
  content: ProseMirrorNode[];
}

export interface DraftBlockContainerData {
  blocks?: DraftBlockItem[];
  entityMap?: Record<string, unknown>;
  type?: "doc";
  content?: ProseMirrorNode[];
  formId?: string;
  [key: string]: unknown;
}

export interface DraftContentPayload {
  blocks: Record<
    string,
    {
      type: string;
      id: string;
      order: number;
      data: DraftBlockContainerData;
    }
  >;
  meta: {
    title: string;
    ingress: string;
    [key: string]: unknown;
  };
}

interface CharNode {
  char: string;
  styles: Set<string>;
  entityKey: number | null;
}

function parseSegment(
  input: string,
  inheritedStyles: Set<string>,
  inheritedEntityKey: number | null,
  registerEntity: (entity: unknown) => number,
  output: CharNode[],
): void {
  let i = 0;
  while (i < input.length) {
    const remaining = input.slice(i);

    // Markdown punctuation escapes must remain literal text.
    if (
      remaining[0] === "\\" &&
      remaining[1] &&
      /[\\`*{}\[\]()#+.\-!_>~]/.test(remaining[1])
    ) {
      output.push({
        char: remaining[1],
        styles: new Set(inheritedStyles),
        entityKey: inheritedEntityKey,
      });
      i += 2;
      continue;
    }

    // 1. Link: [text](url)
    if (inheritedEntityKey === null) {
      const linkMatch = remaining.match(/^\[((?:[^\]]|\\\])+)\]\(([^)]+)\)/);
      if (linkMatch) {
        const linkText = linkMatch[1]!;
        const linkUrl = linkMatch[2]!;
        const relative = /^\/(?!\/)/.test(linkUrl) && !linkUrl.includes("\\");
        let allowed = relative;
        try {
          allowed ||= ["https:", "http:", "mailto:", "tel:"].includes(
            new URL(linkUrl).protocol,
          );
        } catch {
          /* Reject invalid absolute URLs. */
        }
        if (!allowed || /[\u0000-\u0020\u007f]/.test(linkUrl)) {
          throw new Error(
            "Links must use https:, http:, mailto:, tel: or a relative /path without whitespace/control characters.",
          );
        }
        const key = registerEntity({
          type: "LINK",
          mutability: "MUTABLE",
          data: {
            url: linkUrl,
            href: linkUrl,
            target: "_blank",
            rel: "noreferrer noopener",
          },
        });
        parseSegment(linkText, inheritedStyles, key, registerEntity, output);
        i += linkMatch[0]!.length;
        continue;
      }
    }

    // 2. Bold + Italic: ***text*** or ___text___
    const boldItalicMatch = remaining.match(/^(\*\*\*|___)(.+?)\1/);
    if (boldItalicMatch) {
      const nextStyles = new Set(inheritedStyles);
      nextStyles.add("BOLD");
      nextStyles.add("ITALIC");
      parseSegment(
        boldItalicMatch[2]!,
        nextStyles,
        inheritedEntityKey,
        registerEntity,
        output,
      );
      i += boldItalicMatch[0]!.length;
      continue;
    }

    // 3. Bold: **text** or __text__
    const boldMatch = remaining.match(/^(\*\*|__)(.+?)\1/);
    if (boldMatch) {
      const nextStyles = new Set(inheritedStyles);
      nextStyles.add("BOLD");
      parseSegment(
        boldMatch[2]!,
        nextStyles,
        inheritedEntityKey,
        registerEntity,
        output,
      );
      i += boldMatch[0]!.length;
      continue;
    }

    // 4. Strikethrough: ~~text~~
    const strikeMatch = remaining.match(/^~~(.+?)~~/);
    if (strikeMatch) {
      const nextStyles = new Set(inheritedStyles);
      nextStyles.add("STRIKETHROUGH");
      parseSegment(
        strikeMatch[1]!,
        nextStyles,
        inheritedEntityKey,
        registerEntity,
        output,
      );
      i += strikeMatch[0]!.length;
      continue;
    }

    // 5. Italic: *text* or _text_
    const italicMatch = remaining.match(/^(\*|_)([^\s*_]|[^\s*_].*?[^\s*_])\1/);
    if (italicMatch) {
      const delim = italicMatch[1]!;
      const prevChar = i > 0 ? input[i - 1]! : " ";
      if (delim === "_" && /\w/.test(prevChar)) {
        // Skip underscore inside words (snake_case)
      } else {
        const nextStyles = new Set(inheritedStyles);
        nextStyles.add("ITALIC");
        parseSegment(
          italicMatch[2]!,
          nextStyles,
          inheritedEntityKey,
          registerEntity,
          output,
        );
        i += italicMatch[0]!.length;
        continue;
      }
    }

    // 6. Inline code: `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      const codeText = codeMatch[1]!;
      const nextStyles = new Set(inheritedStyles);
      nextStyles.add("CODE");
      for (const ch of codeText) {
        output.push({
          char: ch,
          styles: nextStyles,
          entityKey: inheritedEntityKey,
        });
      }
      i += codeMatch[0]!.length;
      continue;
    }

    // 7. Regular character
    output.push({
      char: input[i]!,
      styles: new Set(inheritedStyles),
      entityKey: inheritedEntityKey,
    });
    i++;
  }
}

function parseInlineMarkdown(
  rawText: string,
  registerEntity: (entity: unknown) => number,
): {
  text: string;
  inlineStyleRanges: DraftInlineStyleRange[];
  entityRanges: DraftEntityRange[];
} {
  const output: CharNode[] = [];
  parseSegment(rawText, new Set(), null, registerEntity, output);

  const text = output.map((c) => c.char).join("");
  const inlineStyleRanges: DraftInlineStyleRange[] = [];
  const entityRanges: DraftEntityRange[] = [];

  const styleNames = ["BOLD", "ITALIC", "STRIKETHROUGH", "CODE"];
  for (const style of styleNames) {
    let activeStart: number | null = null;
    for (let idx = 0; idx < output.length; idx++) {
      const hasStyle = output[idx]!.styles.has(style);
      if (hasStyle && activeStart === null) {
        activeStart = idx;
      } else if (!hasStyle && activeStart !== null) {
        inlineStyleRanges.push({
          offset: activeStart,
          length: idx - activeStart,
          style,
        });
        activeStart = null;
      }
    }
    if (activeStart !== null) {
      inlineStyleRanges.push({
        offset: activeStart,
        length: output.length - activeStart,
        style,
      });
    }
  }

  let activeEntityKey: number | null = null;
  let entityStart: number | null = null;
  for (let idx = 0; idx < output.length; idx++) {
    const key = output[idx]!.entityKey;
    if (key !== activeEntityKey) {
      if (activeEntityKey !== null && entityStart !== null) {
        entityRanges.push({
          offset: entityStart,
          length: idx - entityStart,
          key: activeEntityKey,
        });
      }
      activeEntityKey = key;
      entityStart = key !== null ? idx : null;
    }
  }
  if (activeEntityKey !== null && entityStart !== null) {
    entityRanges.push({
      offset: entityStart,
      length: output.length - entityStart,
      key: activeEntityKey,
    });
  }

  inlineStyleRanges.sort((a, b) => a.offset - b.offset || a.length - b.length);
  entityRanges.sort((a, b) => a.offset - b.offset || a.length - b.length);

  return { text, inlineStyleRanges, entityRanges };
}

function parseInlineProseMirror(rawText: string): ProseMirrorNode[] {
  if (!rawText) return [];
  const entities: Record<number, any> = {};
  let nextKey = 0;
  const output: CharNode[] = [];
  parseSegment(
    rawText,
    new Set(),
    null,
    (entity) => {
      const k = nextKey++;
      entities[k] = entity;
      return k;
    },
    output,
  );

  if (output.length === 0) return [];

  const nodes: ProseMirrorNode[] = [];
  let i = 0;
  while (i < output.length) {
    const first = output[i]!;
    let j = i + 1;
    while (j < output.length) {
      const curr = output[j]!;
      const sameEntity = first.entityKey === curr.entityKey;
      const sameStyles =
        first.styles.size === curr.styles.size &&
        [...first.styles].every((s) => curr.styles.has(s));
      if (!sameEntity || !sameStyles) break;
      j++;
    }

    const segmentText = output
      .slice(i, j)
      .map((c) => c.char)
      .join("");
    const marks: ProseMirrorMark[] = [];

    if (first.styles.has("BOLD")) {
      marks.push({ type: "bold" });
    }
    if (first.styles.has("ITALIC")) {
      marks.push({ type: "italic" });
    }
    if (first.styles.has("STRIKETHROUGH")) {
      throw new Error(
        "Vibbo rejects strikethrough formatting. Remove the ~~ markers or use bold/plain text instead.",
      );
    }
    if (first.entityKey !== null && entities[first.entityKey]) {
      const ent = entities[first.entityKey];
      const href = ent.data?.href || ent.data?.url;
      if (href) {
        marks.push({
          type: "link",
          attrs: {
            href,
            target: "_blank",
            rel: "noopener noreferrer",
          },
        });
      }
    }
    // TipTap's `code` mark has `excludes: "_"` in ProseMirror and throws
    // `RangeError: Invalid collection of marks for node text` if combined with any other mark.
    if (first.styles.has("CODE") && marks.length === 0) {
      marks.push({ type: "code" });
    }

    const node: ProseMirrorNode = {
      type: "text",
      text: segmentText,
    };
    if (marks.length > 0) {
      node.marks = marks;
    }
    nodes.push(node);
    i = j;
  }

  return nodes;
}

/**
 * Helper to convert plain text or markdown into the ProseMirror/TipTap JSON block structure
 * required by Vibbo's `saveEntityRevision` mutation.
 */
export function convertTextToProseMirrorBlocks(
  text: string,
  existingBlockId?: string,
): DraftContentPayload["blocks"] {
  const blockId = existingBlockId || crypto.randomUUID();
  const docContent: ProseMirrorNode[] = [];
  const lists: Array<{
    indent: number;
    node: ProseMirrorNode;
    item: ProseMirrorNode;
  }> = [];
  let paragraphLines: string[] = [];
  let blankAfterListItem = false;
  const inlineLines = (lines: string[]): ProseMirrorNode[] => {
    const result: ProseMirrorNode[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      result.push(
        ...parseInlineProseMirror(line.replace(/(?: {2,}|\\)$/, "").trim()),
      );
      if (i < lines.length - 1) {
        if (/ {2,}$|\\$/.test(line)) result.push({ type: "hardBreak" });
        else result.push({ type: "text", text: " " });
      }
    }
    return result;
  };
  const flushParagraph = () => {
    if (paragraphLines.length)
      docContent.push({
        type: "paragraph",
        content: inlineLines(paragraphLines),
      });
    paragraphLines = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "    ");
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      blankAfterListItem = true;
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      lists.length = 0;
      continue;
    }
    const match = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
    if (match) {
      flushParagraph();
      const indent = match[1]!.length;
      const type = /^\d/.test(match[2]!) ? "orderedList" : "bulletList";
      while (lists.length && lists.at(-1)!.indent > indent) lists.pop();
      if (lists.at(-1)?.indent === indent && lists.at(-1)!.node.type !== type)
        lists.pop();
      if (!lists.length || lists.at(-1)!.indent < indent) {
        const node: ProseMirrorNode = { type, content: [] };
        const start = parseInt(match[2]!, 10);
        if (type === "orderedList" && start !== 1)
          throw new Error(
            "Vibbo numbered lists always start at 1. Start each new numbered list at 1; other start numbers are not preserved by Vibbo.",
          );
        if (lists.length) lists.at(-1)!.item.content!.push(node);
        else docContent.push(node);
        lists.push({ indent, node, item: { type: "listItem", content: [] } });
      }
      const current = lists.at(-1)!;
      const item: ProseMirrorNode = {
        type: "listItem",
        content: [
          { type: "paragraph", content: parseInlineProseMirror(match[3]!) },
        ],
      };
      current.node.content!.push(item);
      current.item = item;
      blankAfterListItem = false;
      continue;
    }
    const last = lists.at(-1);
    const indent = line.length - line.trimStart().length;
    if (last && indent > last.indent) {
      const children = last.item.content!;
      const previous = children.at(-1);
      if (!blankAfterListItem && previous?.type === "paragraph") {
        previous.content = [
          ...(previous.content ?? []),
          { type: "text", text: " " },
          ...parseInlineProseMirror(trimmed),
        ];
      } else {
        children.push({
          type: "paragraph",
          content: parseInlineProseMirror(trimmed),
        });
      }
      blankAfterListItem = false;
      continue;
    }
    lists.length = 0;
    blankAfterListItem = false;
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      docContent.push({
        type: "heading",
        attrs: { level: 2 },
        content: parseInlineProseMirror(heading[2]!),
      });
    } else paragraphLines.push(line);
  }
  flushParagraph();
  if (!docContent.length) docContent.push({ type: "paragraph" });
  return {
    [blockId]: {
      type: "text",
      id: blockId,
      order: 1,
      data: { type: "doc", content: docContent },
    },
  };
}

/**
 * Helper to convert plain text or markdown paragraphs into the Draft.js block structure used by Vibbo.
 */
export function convertTextToDraftBlocks(text: string): Record<
  string,
  {
    type: string;
    id: string;
    order: number;
    data: {
      blocks: DraftBlockItem[];
      entityMap: Record<string, unknown>;
    };
  }
> {
  const blockId = crypto.randomUUID();
  const rawLines = text.split(/\r?\n/);
  const draftBlocks: DraftBlockItem[] = [];
  const entityMap: Record<string, unknown> = {};
  let nextEntityKey = 0;

  const registerEntity = (entity: unknown): number => {
    const key = nextEntityKey++;
    entityMap[key.toString()] = entity;
    return key;
  };

  const createBlock = (
    rawText: string,
    type: string,
    depth = 0,
  ): DraftBlockItem => {
    const parsed = parseInlineMarkdown(rawText, registerEntity);
    return {
      key: Math.random().toString(36).substring(2, 7),
      text: parsed.text,
      type,
      depth,
      inlineStyleRanges: parsed.inlineStyleRanges,
      entityRanges: parsed.entityRanges,
      data: {},
    };
  };

  let currentParagraph = "";

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      draftBlocks.push(createBlock(currentParagraph, "unstyled"));
      currentParagraph = "";
    }
  };

  let inCodeBlock = false;
  let codeBlockLines: string[] = [];

  for (const rawLine of rawLines) {
    if (rawLine.trim().startsWith("```")) {
      if (inCodeBlock) {
        draftBlocks.push({
          key: Math.random().toString(36).substring(2, 7),
          text: codeBlockLines.join("\n"),
          type: "code-block",
          depth: 0,
          inlineStyleRanges: [],
          entityRanges: [],
          data: {},
        });
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        flushParagraph();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(rawLine);
      continue;
    }

    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    // Horizontal rules (--- or *** or ___)
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      continue;
    }

    const leadingWhitespace = rawLine.match(/^([ \t]*)/)?.[1] ?? "";
    const spaceCount = leadingWhitespace.replace(/\t/g, "  ").length;
    const depth = spaceCount >= 2 ? Math.min(4, Math.floor(spaceCount / 2)) : 0;

    if (trimmed.startsWith("#### ")) {
      flushParagraph();
      draftBlocks.push(createBlock(trimmed.substring(5).trim(), "header-four"));
    } else if (trimmed.startsWith("### ")) {
      flushParagraph();
      draftBlocks.push(
        createBlock(trimmed.substring(4).trim(), "header-three"),
      );
    } else if (trimmed.startsWith("## ")) {
      flushParagraph();
      draftBlocks.push(createBlock(trimmed.substring(3).trim(), "header-two"));
    } else if (trimmed.startsWith("# ")) {
      flushParagraph();
      draftBlocks.push(createBlock(trimmed.substring(2).trim(), "header-one"));
    } else if (trimmed.startsWith("> ")) {
      flushParagraph();
      draftBlocks.push(createBlock(trimmed.substring(2).trim(), "blockquote"));
    } else if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph();
      draftBlocks.push(
        createBlock(
          trimmed.replace(/^[-*+]\s+/, "").trim(),
          "unordered-list-item",
          depth,
        ),
      );
    } else if (/^\d+[\.\)]\s+/.test(trimmed)) {
      flushParagraph();
      draftBlocks.push(
        createBlock(
          trimmed.replace(/^\d+[\.\)]\s+/, "").trim(),
          "ordered-list-item",
          depth,
        ),
      );
    } else {
      if (currentParagraph.length > 0) {
        currentParagraph += " " + trimmed;
      } else {
        currentParagraph = trimmed;
      }
    }
  }

  flushParagraph();

  if (draftBlocks.length === 0) {
    draftBlocks.push({
      key: Math.random().toString(36).substring(2, 7),
      text: "",
      type: "unstyled",
      depth: 0,
      inlineStyleRanges: [],
      entityRanges: [],
      data: {},
    });
  }

  return {
    [blockId]: {
      type: "text",
      id: blockId,
      order: 1,
      data: {
        blocks: draftBlocks,
        entityMap,
      },
    },
  };
}

/**
 * Compose draft content matching Vibbo's ProseMirror/TipTap structure required by `saveEntityRevision`.
 */
export function composeDraftContent(
  title: string,
  ingress?: string,
  content?: string,
  existingDraftContent?: any,
  sectionId?: string,
): DraftContentPayload {
  const existing = parseTopicContent(existingDraftContent);
  const blocks = structuredClone(existing.blocks);
  if (content !== undefined) {
    assertMarkdownContent(content);
    const textSections = Object.values(blocks).filter(
      (section) => section.type === "text",
    );
    const target = sectionId ? blocks[sectionId] : textSections[0];
    if (sectionId && (!target || target.type !== "text")) {
      throw new Error(
        `Section '${sectionId}' is not a text section. Read vibbo_get_topic_draft for section IDs.`,
      );
    }
    if (!sectionId && textSections.length > 1) {
      throw new Error(
        "Multiple text sections: specify contentSectionId or use vibbo_edit_topic_draft_sections. Existing sections were preserved.",
      );
    }
    const id = target?.id ?? crypto.randomUUID();
    const replacement = convertTextToProseMirrorBlocks(content, id)[id]!;
    blocks[id] = {
      ...target,
      ...replacement,
      order:
        target?.order ??
        (Object.keys(blocks).length
          ? Math.min(...Object.values(blocks).map((s) => s.order)) - 1
          : 1),
    };
  } else if (sectionId) {
    throw new Error("contentSectionId requires content.");
  }
  return {
    ...existing,
    blocks,
    meta: {
      ...existing.meta,
      title: title.trim(),
      ingress: ingress ?? existing.meta.ingress ?? "",
    },
  };
}

/** Never accept caller-supplied reference IDs through a raw JSON escape hatch. */
export function assertMarkdownContent(content: string): void {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    /* Ordinary Markdown. */
  }
  if (parsed && typeof parsed === "object" && "blocks" in parsed) {
    throw new Error(
      "Raw JSON blocks are no longer accepted. Use Markdown and the draft section/form tools; they preserve existing sections and isolate forms.",
    );
  }
  if (
    /^\s*(?:\|.*\||\|?\s*:?-{3,}:?\s*\|)/m.test(content) ||
    /!\[[^\]]*\]\(/.test(content) ||
    /^\s*(?:>|```|~~~|<\/?[A-Za-z])/m.test(content)
  ) {
    throw new Error(
      "Unsupported Markdown: tables, images, blockquotes, fenced code and HTML are not supported by this editor. Use headings, paragraphs, nested lists, bold, italic, inline code and links. Strikethrough is unsupported.",
    );
  }
}

export function parseTopicContent(value: any): DraftContentPayload {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Cannot safely read topic content: invalid JSON.");
    }
  }
  if (value == null) return { blocks: {}, meta: { title: "", ingress: "" } };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !value.blocks ||
    typeof value.blocks !== "object" ||
    Array.isArray(value.blocks)
  ) {
    throw new Error("Cannot safely read topic sections. No changes made.");
  }
  if (
    value.meta != null &&
    (typeof value.meta !== "object" ||
      Array.isArray(value.meta) ||
      (value.meta.title != null && typeof value.meta.title !== "string") ||
      (value.meta.ingress != null && typeof value.meta.ingress !== "string"))
  ) {
    throw new Error("Cannot safely read topic metadata. No changes made.");
  }
  for (const [id, section] of Object.entries(value.blocks) as [string, any][]) {
    if (
      ["__proto__", "constructor", "prototype"].includes(id) ||
      !section ||
      section.id !== id ||
      typeof section.type !== "string" ||
      !Number.isFinite(section.order) ||
      !section.data ||
      typeof section.data !== "object" ||
      Array.isArray(section.data)
    ) {
      throw new Error(`Cannot safely read section '${id}'. No changes made.`);
    }
  }
  return structuredClone({
    ...value,
    blocks: value.blocks,
    meta: {
      ...value.meta,
      title: value.meta?.title ?? "",
      ingress: value.meta?.ingress ?? "",
    },
  });
}

export function topicDraftContent(topic: any): DraftContentPayload {
  const content = parseTopicContent(topic.draft?.content ?? topic.article);
  if (!content.meta.title) content.meta.title = topic.title;
  return content;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/** A content token, not a server-side compare-and-swap guarantee. */
export function topicRevisionToken(topic: any): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        id: topic.id,
        content: topicDraftContent(topic),
        revisionUpdatedAt: topic.draft?.updatedAt ?? null,
      }),
    )
    .digest("hex");
}

export interface VerifiedDraftTopic {
  topic: any;
  orgNodeId: string;
  orgSlug: string;
}

export function formatDraftBlockToMarkdown(
  item: DraftBlockItem,
  entityMap?: Record<string, any>,
): string {
  const text = item.text ?? "";
  if (!text) return "";

  const inlineStyles =
    (item.inlineStyleRanges as DraftInlineStyleRange[]) ?? [];
  const entityRanges = (item.entityRanges as DraftEntityRange[]) ?? [];

  if (inlineStyles.length === 0 && entityRanges.length === 0) {
    return text;
  }

  const charStyles: Array<Set<string>> = Array.from(
    { length: text.length },
    () => new Set(),
  );
  const charEntities: Array<any | null> = Array.from(
    { length: text.length },
    () => null,
  );

  for (const range of inlineStyles) {
    const end = Math.min(text.length, range.offset + range.length);
    for (let i = range.offset; i < end; i++) {
      charStyles[i]!.add(range.style);
    }
  }

  for (const range of entityRanges) {
    const entity = entityMap ? entityMap[range.key.toString()] : null;
    const end = Math.min(text.length, range.offset + range.length);
    for (let i = range.offset; i < end; i++) {
      charEntities[i] = entity;
    }
  }

  let result = "";
  let i = 0;
  while (i < text.length) {
    const styles = charStyles[i]!;
    const entity = charEntities[i];

    let j = i + 1;
    while (j < text.length) {
      const nextStyles = charStyles[j]!;
      const nextEntity = charEntities[j];
      const sameStyles =
        styles.size === nextStyles.size &&
        [...styles].every((s) => nextStyles.has(s));
      const sameEntity = entity === nextEntity;
      if (!sameStyles || !sameEntity) break;
      j++;
    }

    let segment = text.slice(i, j);

    if (styles.has("CODE")) {
      segment = `\`${segment}\``;
    }
    if (styles.has("BOLD") && styles.has("ITALIC")) {
      segment = `***${segment}***`;
    } else if (styles.has("BOLD")) {
      segment = `**${segment}**`;
    } else if (styles.has("ITALIC")) {
      segment = `*${segment}*`;
    }
    if (styles.has("STRIKETHROUGH")) {
      segment = `~~${segment}~~`;
    }

    if (
      entity &&
      entity.type === "LINK" &&
      (entity.data?.url || entity.data?.href)
    ) {
      const url = entity.data.url || entity.data.href;
      segment = `[${segment}](${url})`;
    }

    result += segment;
    i = j;
  }

  return result;
}

function formatProseMirrorInlineToMarkdown(nodes?: ProseMirrorNode[]): string {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";
  let result = "";
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      result += "  \n";
      continue;
    }
    let segment = node.text ?? "";
    if (!segment) continue;

    const marks = Array.isArray(node.marks) ? node.marks : [];
    const hasCode = marks.some((m) => m.type === "code");
    const hasBold = marks.some((m) => m.type === "bold" || m.type === "strong");
    const hasItalic = marks.some((m) => m.type === "italic" || m.type === "em");
    const hasStrike = marks.some((m) => m.type === "strike");
    const linkMark = marks.find((m) => m.type === "link");

    if (hasCode) {
      segment = `\`${segment}\``;
    } else {
      segment = segment.replace(/[\\*_`\[\]~]/g, "\\$&");
    }
    if (hasBold && hasItalic) {
      segment = `***${segment}***`;
    } else if (hasBold) {
      segment = `**${segment}**`;
    } else if (hasItalic) {
      segment = `*${segment}*`;
    }
    if (hasStrike) {
      segment = `~~${segment}~~`;
    }
    if (linkMark && (linkMark.attrs?.href || linkMark.attrs?.url)) {
      const url = (linkMark.attrs.href || linkMark.attrs.url) as string;
      segment = `[${segment}](${url})`;
    }

    result += segment;
  }
  return result;
}

function convertProseMirrorNodesToMarkdown(
  nodes: ProseMirrorNode[],
  indent = "",
): string[] {
  const lines: string[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case "heading": {
        const level = Number(node.attrs?.level ?? 2);
        const hashes = "#".repeat(Math.min(6, Math.max(1, level)));
        lines.push(
          `${hashes} ${formatProseMirrorInlineToMarkdown(node.content)}`,
        );
        break;
      }
      case "paragraph": {
        lines.push(
          `${indent}${formatProseMirrorInlineToMarkdown(node.content)}`,
        );
        break;
      }
      case "blockquote": {
        const innerLines = convertProseMirrorNodesToMarkdown(
          node.content ?? [],
        );
        lines.push(innerLines.map((l) => `> ${l}`).join("\n"));
        break;
      }
      case "codeBlock": {
        const text = formatProseMirrorInlineToMarkdown(node.content);
        lines.push("```\n" + text + "\n```");
        break;
      }
      case "bulletList": {
        const items = node.content ?? [];
        for (const listItem of items) {
          const itemChildren = listItem.content ?? [];
          for (const child of itemChildren) {
            if (child.type === "paragraph") {
              lines.push(
                `${indent}- ${formatProseMirrorInlineToMarkdown(child.content)}`,
              );
            } else if (
              child.type === "bulletList" ||
              child.type === "orderedList"
            ) {
              lines.push(
                ...convertProseMirrorNodesToMarkdown([child], indent + "  "),
              );
            }
          }
        }
        break;
      }
      case "orderedList": {
        const items = node.content ?? [];
        let counter = Number(node.attrs?.start ?? 1);
        for (const listItem of items) {
          const itemChildren = listItem.content ?? [];
          for (const child of itemChildren) {
            if (child.type === "paragraph") {
              lines.push(
                `${indent}${counter}. ${formatProseMirrorInlineToMarkdown(child.content)}`,
              );
              counter++;
            } else if (
              child.type === "bulletList" ||
              child.type === "orderedList"
            ) {
              lines.push(
                ...convertProseMirrorNodesToMarkdown([child], indent + "  "),
              );
            }
          }
        }
        break;
      }
      default: {
        if (node.content) {
          lines.push(
            ...convertProseMirrorNodesToMarkdown(node.content, indent),
          );
        }
        break;
      }
    }
  }

  return lines;
}

/**
 * Helper to convert Draft.js or ProseMirror/TipTap blocks back into readable Markdown.
 */
export function convertDraftBlocksToMarkdown(content: any): string {
  if (!content) return "";
  let payload = content;
  if (typeof content === "string") {
    try {
      payload = JSON.parse(content);
    } catch {
      return content;
    }
  }

  const rawBlocks = payload.blocks;
  if (!rawBlocks || typeof rawBlocks !== "object") {
    return "";
  }

  const sortedContainers = Object.values(rawBlocks).sort((a: any, b: any) => {
    return (a?.order ?? 0) - (b?.order ?? 0);
  });

  const lines: string[] = [];

  for (const container of sortedContainers as any[]) {
    // Support ProseMirror / TipTap JSON format (`data.type === "doc"`)
    if (
      container?.data?.type === "doc" &&
      Array.isArray(container?.data?.content)
    ) {
      lines.push(...convertProseMirrorNodesToMarkdown(container.data.content));
      continue;
    }

    // Support Draft.js format (`data.blocks`)
    const subBlocks = container?.data?.blocks;
    const entityMap = container?.data?.entityMap;
    if (!Array.isArray(subBlocks)) continue;

    let orderedListCounter = 1;

    for (const item of subBlocks) {
      const formattedText = formatDraftBlockToMarkdown(item, entityMap);
      const type = item.type ?? "unstyled";
      const indent =
        item.depth && item.depth > 0 ? "  ".repeat(item.depth) : "";

      if (type === "ordered-list-item") {
        lines.push(`${indent}${orderedListCounter}. ${formattedText}`);
        orderedListCounter++;
        continue;
      } else {
        orderedListCounter = 1;
      }

      switch (type) {
        case "header-one":
          lines.push(`# ${formattedText}`);
          break;
        case "header-two":
          lines.push(`## ${formattedText}`);
          break;
        case "header-three":
          lines.push(`### ${formattedText}`);
          break;
        case "header-four":
          lines.push(`#### ${formattedText}`);
          break;
        case "unordered-list-item":
          lines.push(`${indent}- ${formattedText}`);
          break;
        case "blockquote":
          lines.push(`> ${formattedText}`);
          break;
        case "code-block":
          lines.push("```\n" + formattedText + "\n```");
          break;
        default:
          lines.push(formattedText);
          break;
      }
    }
  }

  return lines.join("\n\n").trim();
}

/**
 * Resolve a topic by slug or NodeID across vibboTopicPage and vibboBrowseTopics.
 */
export async function resolveTopic(
  topicSlugOrId: string,
): Promise<{ topic: any; orgNodeId: string; orgSlug: string }> {
  const orgNodeId = await getVibboOrgNodeId();
  const orgSlug = getVibboOrgSlug();

  const topicPageOp = vibboRegistry.get("vibboTopicPage");
  let topic: any = null;

  if (topicPageOp) {
    try {
      const pageResult = await vibboGraphqlQuery<{
        organization?: {
          topic?: any;
        };
      }>(topicPageOp.operationName, topicPageOp.queryText, {
        organizationId: orgNodeId,
        topicSlug: topicSlugOrId,
      });
      if (pageResult.errors?.length)
        throw new Error(
          "Topic query returned partial errors; refusing ambiguous state.",
        );
      topic = pageResult.data?.organization?.topic;
    } catch {
      // Slug might be an ID or not directly resolvable by slug
    }
  }

  // If not found by slug directly, search in browse topics
  if (!topic) {
    const browseOp = vibboRegistry.get("vibboBrowseTopics");
    if (browseOp) {
      const browseResult = await vibboGraphqlQuery<{
        organization?: {
          topics?: Array<{
            id: string;
            slug: string;
            title: string;
            isPublished: boolean;
          }>;
        };
      }>(browseOp.operationName, browseOp.queryText, {
        organizationId: orgNodeId,
      });

      const allTopics = browseResult.data?.organization?.topics ?? [];
      const match = allTopics.find(
        (t) => t.slug === topicSlugOrId || t.id === topicSlugOrId,
      );

      if (match) {
        // Found matching topic metadata
        if (topicPageOp && match.slug) {
          const detailRes = await vibboGraphqlQuery<{
            organization?: { topic?: any };
          }>(topicPageOp.operationName, topicPageOp.queryText, {
            organizationId: orgNodeId,
            topicSlug: match.slug,
          });
          if (detailRes.errors?.length)
            throw new Error(
              "Topic detail query returned errors; refusing ambiguous state.",
            );
          topic = detailRes.data?.organization?.topic ?? match;
        } else {
          topic = match;
        }
      }
    }
  }

  if (!topic) {
    if (
      topicSlugOrId.startsWith("VG9waWM6") ||
      topicSlugOrId.startsWith("Topic:")
    ) {
      return {
        topic: { id: topicSlugOrId, slug: "", title: topicSlugOrId },
        orgNodeId,
        orgSlug,
      };
    }

    throw new Error(
      `Topic '${topicSlugOrId}' was not found in cooperative '${orgSlug}'. Use 'vibbo_list_topics' to view existing topics.`,
    );
  }

  return { topic, orgNodeId, orgSlug };
}

/**
 * Pre-flight verification helper: fetches the topic from Vibbo and strictly verifies
 * that the topic is NOT published (isPublished === false).
 *
 * @throws {Error} if topic is not found or is already published.
 */
export async function fetchAndVerifyDraftTopic(
  topicSlugOrId: string,
): Promise<VerifiedDraftTopic> {
  const { topic, orgNodeId, orgSlug } = await resolveTopic(topicSlugOrId);

  if (!topic.id || !topic.slug)
    throw new Error(
      "OPERATION DENIED: Full topic identity could not be verified.",
    );

  // STRICT GUARDRAIL: Mutating published pages is completely prohibited
  if (topic.isPublished === true) {
    throw new Error(
      `OPERATION DENIED: Topic '${topic.title || topic.slug}' is already published (isPublished: true). ` +
        `Mutating (updating or deleting) published pages is strictly forbidden. Only unpublished drafts can be modified.`,
    );
  }

  if (topic.isPublished !== false) {
    throw new Error(
      `OPERATION DENIED: Topic '${topic.title || topic.slug}' has invalid or ambiguous publish status (isPublished: ${topic.isPublished}). Operation aborted for safety.`,
    );
  }

  if (
    topic.organization?.id !== orgNodeId ||
    topic.isClusterTopic !== false ||
    (topic.authorOrganization?.id && topic.authorOrganization.id !== orgNodeId)
  ) {
    throw new Error(
      "OPERATION DENIED: Draft ownership must match the active cooperative and cluster/shared topics cannot be modified.",
    );
  }
  // Validate the entire content before any mutation, including deletes.
  topicDraftContent(topic);
  return { topic, orgNodeId, orgSlug };
}

/**
 * Register tools for creating and modifying "tema" page drafts with strict safety checks.
 */
export function registerTopicDraftTools(server: McpServer): void {
  registerStructuredTopicTools(server);
  // 1. Create topic draft
  server.registerTool(
    "vibbo_create_topic_draft",
    {
      description: `Create a new unpublished "tema" (resident handbook topic) draft on Vibbo.
Safety guarantee: Only creates draft pages (isPublished: false). Publishing a topic is strictly blocked.`,
      inputSchema: z.object({
        title: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe(
            "Title of the new topic draft (required, maximum 200 characters)",
          ),
        ingress: z
          .string()
          .optional()
          .describe("Short introductory text/summary for the topic draft"),
        content: z
          .string()
          .optional()
          .describe(
            "Markdown body: headings (all render as level 2), paragraphs, nested lists (numbered lists start at 1), bold, italic, inline code, links. Strikethrough is unsupported. Use vibbo_add_topic_form_draft after creating the topic. Raw JSON, tables, HTML and embedded images are rejected.",
          ),
        createdFromTemplate: z
          .string()
          .optional()
          .describe(
            "Optional OBOS template identifier if starting from a pre-defined template",
          ),
      }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ title, ingress, content, createdFromTemplate }) => {
      // 1. Payload validation
      const cleanTitle = title.trim();
      if (!cleanTitle) {
        return {
          content: [
            {
              type: "text",
              text: "OPERATION DENIED: A non-empty title is required to create a topic draft.",
            },
          ],
          isError: true,
        };
      }

      const draftContent = composeDraftContent(cleanTitle, ingress, content);
      const orgNodeId = await getVibboOrgNodeId();
      const orgSlug = getVibboOrgSlug();

      // 2. Create the topic draft entity via createTopic mutation
      const createRes = await vibboGraphqlQuery<{
        createTopic?: {
          id: string;
          slug: string;
          title: string;
          isPublished: boolean;
        };
      }>(
        "createTopic",
        CREATE_TOPIC_MUTATION,
        {
          input: {
            authorOrganizationId: orgNodeId,
            organizationId: orgNodeId,
            title: cleanTitle,
            createdFromTemplate: createdFromTemplate ?? null,
          },
        },
        false,
      );

      const createdTopic = createRes.data?.createTopic;
      if (createRes.errors?.length || !createdTopic || !createdTopic.id) {
        throw new Error(
          `Failed to create topic draft: ${createRes.errors?.map((e) => e.message).join("; ") ?? "No data returned"}`,
        );
      }

      // Safety check: verify the created entity is strictly a draft
      if (createdTopic.isPublished !== false) {
        throw new Error(
          `UNEXPECTED STATE: The created topic has isPublished=${createdTopic.isPublished}. Operation aborted.`,
        );
      }

      // Re-fetch ownership/publication immediately before saving. Never blindly delete
      // on failure: a human may have published the new topic in the meantime.
      try {
        if (ingress !== undefined || content !== undefined) {
          await withDraftTopic(
            createdTopic.slug,
            undefined,
            async (verified) => {
              if (verified.topic.id !== createdTopic.id)
                throw new Error("Created topic identity changed.");
              await saveTopicDraft(verified, draftContent);
            },
          );
        }
      } catch (error) {
        throw new Error(
          `Topic '${createdTopic.slug}' (${createdTopic.id}) was created but its content was not confirmed saved. Read the draft before retrying; no automatic deletion was attempted. ${String(error)}`,
        );
      }

      const webUrl = buildVibboWebUrl("tema", createdTopic.slug, orgSlug);

      const output = {
        success: true,
        message:
          "Topic draft successfully created. Add forms with vibbo_add_topic_form_draft; inspect with vibbo_get_topic_draft.",
        topic: {
          id: createdTopic.id,
          slug: createdTopic.slug,
          title: cleanTitle,
          isPublished: false,
          createdFromTemplate: createdFromTemplate ?? null,
          webUrl,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // 2. Update topic draft
  server.registerTool(
    "vibbo_update_topic_draft",
    {
      description: `Modify or update an existing "tema" draft page on Vibbo.
Safety guarantee: Pre-flight checks verify the topic's live state with the API. It is strictly forbidden to mutate published pages (isPublished === true).`,
      inputSchema: z.object({
        topicSlug: z
          .string()
          .describe(
            "The slug (e.g. 'ytnimz') or NodeID of the topic draft to update",
          ),
        title: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Updated draft title (maximum 200 characters)"),
        ingress: z
          .string()
          .optional()
          .describe("Updated introductory summary for the draft topic"),
        content: z
          .string()
          .optional()
          .describe(
            "Markdown for one text section; preserves forms, attachments and other sections. For multiple text sections, specify contentSectionId. Empty string clears the selected text. Raw JSON is rejected. Use vibbo_edit_topic_draft_sections for placement.",
          ),
        contentSectionId: z
          .string()
          .optional()
          .describe(
            "Text section ID from vibbo_get_topic_draft. Required if the draft has multiple text sections.",
          ),
        expectedRevision: z
          .string()
          .optional()
          .describe(
            "revisionToken from vibbo_get_topic_draft; rejects stale edits.",
          ),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({
      topicSlug,
      title,
      ingress,
      content,
      contentSectionId,
      expectedRevision,
    }) =>
      withDraftTopic(topicSlug, expectedRevision, async (verified) => {
        if (
          title === undefined &&
          ingress === undefined &&
          content === undefined
        )
          throw new Error("Provide title, ingress or content to update.");
        const existing = topicDraftContent(verified.topic);
        const draftPayload = composeDraftContent(
          title ?? existing.meta.title,
          ingress,
          content,
          existing,
          contentSectionId,
        );
        const revision = await saveTopicDraft(verified, draftPayload);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  revisionId: revision.id,
                  ...draftEditorView(
                    {
                      ...verified.topic,
                      draft: {
                        content: draftPayload,
                        updatedAt: revision.updatedAt,
                      },
                    },
                    verified.orgSlug,
                  ),
                },
                null,
                2,
              ),
            },
          ],
        };
      }),
  );

  // 3. Delete topic draft
  server.registerTool(
    "vibbo_delete_topic_draft",
    {
      description: `Delete an unpublished "tema" draft page from Vibbo.
Safety guarantee: Pre-flight checks verify the topic's live state with the API. It is strictly forbidden to delete published pages (isPublished === true).`,
      inputSchema: z.object({
        topicSlug: z
          .string()
          .describe(
            "The slug (e.g. 'ytnimz') or NodeID of the topic draft to delete",
          ),
        expectedRevision: z
          .string()
          .optional()
          .describe(
            "revisionToken from vibbo_get_topic_draft; rejects deletion after a stale read.",
          ),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ topicSlug, expectedRevision }) =>
      withDraftTopic(topicSlug, expectedRevision, async (verified) => {
        // No await between this fresh verification and the deletion request.
        const { topic } = await fetchAndVerifyDraftTopic(verified.topic.slug);
        if (
          topic.id !== verified.topic.id ||
          topicRevisionToken(topic) !== topicRevisionToken(verified.topic)
        )
          throw new Error("Draft changed before deletion. Read it again.");
        if (
          !Array.isArray(topic.forms) ||
          topic.forms.some((form: any) => form.isClusterForm !== false)
        ) {
          throw new Error(
            "OPERATION DENIED: Draft deletion requires verified local form records; shared/cluster forms or ambiguous ownership cannot be deleted with the topic.",
          );
        }
        const result = await vibboGraphqlQuery<{
          deleteTopic?: boolean | null;
        }>("deleteTopic", DELETE_TOPIC_MUTATION, { topicId: topic.id }, false);
        // Vibbo's successful deleteTopic response is null. Verify absence instead
        // of mistaking a void response for either success or failure.
        if (
          result.errors?.length ||
          !result.data ||
          !("deleteTopic" in result.data) ||
          result.data.deleteTopic === false
        )
          throw new Error(
            "Draft deletion was not confirmed. Read the topic before retrying.",
          );
        const confirmation = await vibboGraphqlQuery<{
          organization?: { topics?: Array<{ id: string }> };
        }>(
          "verifyTopicDraftDeletion",
          `query verifyTopicDraftDeletion($organizationId: OrganizationID!) {
          organization(id: $organizationId) { topics { id } }
        }`,
          { organizationId: verified.orgNodeId },
          false,
        );
        const remaining = confirmation.data?.organization?.topics;
        if (
          confirmation.errors?.length ||
          !Array.isArray(remaining) ||
          remaining.some((t) => t.id === topic.id)
        )
          throw new Error(
            "Draft deletion could not be verified. Read the topic list before retrying.",
          );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  deletedTopic: {
                    id: topic.id,
                    slug: topic.slug,
                    title: topic.title,
                    isPublished: false,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      }),
  );

  // 4. List topic revisions
  server.registerTool(
    "vibbo_list_topic_revisions",
    {
      description: `List all historical revisions/versions for a Vibbo topic (both published pages and drafts).
Returns revision ID, update timestamp, and author for each revision.`,
      inputSchema: z.object({
        topicSlug: z
          .string()
          .describe(
            "The slug (e.g. 'avfallshandtering') or NodeID of the topic",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ topicSlug }) => {
      const { topic, orgSlug } = await resolveTopic(topicSlug);

      const result = await vibboGraphqlQuery<{
        history?: Array<{
          id: string;
          updatedAt: string;
          updatedBy?: { id: string; name: string } | null;
        }>;
      }>("revisionHistoryList", REVISION_HISTORY_QUERY, {
        relatedNodeId: topic.id,
      });

      const revisions = result.data?.history ?? [];
      const webUrl = topic.slug
        ? buildVibboWebUrl("tema", topic.slug, orgSlug)
        : undefined;

      const output = {
        topic: {
          id: topic.id,
          slug: topic.slug,
          title: topic.title,
          isPublished: topic.isPublished,
          webUrl,
        },
        totalRevisions: revisions.length,
        revisions: revisions.map((rev) => ({
          id: rev.id,
          updatedAt: rev.updatedAt,
          author: rev.updatedBy?.name ?? "Unknown",
          authorId: rev.updatedBy?.id,
        })),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // 5. Get specific topic revision
  server.registerTool(
    "vibbo_get_topic_revision",
    {
      description: `Retrieve the content and metadata of a specific historical revision of a Vibbo topic.
Returns the revision author/date, title, ingress, markdown text, and raw Draft.js blocks.`,
      inputSchema: z.object({
        revisionId: z
          .string()
          .describe(
            "The NodeID of the EntityRevision (e.g. 'RW50aXR5UmV2aXNpb246...')",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ revisionId }) => {
      const result = await vibboGraphqlQuery<{
        revision?: {
          id: string;
          updatedAt: string;
          updatedBy?: { id: string; name: string } | null;
          content?: any;
        };
      }>("entityRevision", ENTITY_REVISION_QUERY, {
        revisionId,
      });

      const rev = result.data?.revision;
      if (!rev) {
        throw new Error(`Revision '${revisionId}' not found.`);
      }

      let contentObj = rev.content;
      if (typeof contentObj === "string") {
        try {
          contentObj = JSON.parse(contentObj);
        } catch {
          // Keep as string
        }
      }

      const meta = contentObj?.meta ?? {};
      const markdown = convertDraftBlocksToMarkdown(contentObj);

      const output = {
        revision: {
          id: rev.id,
          updatedAt: rev.updatedAt,
          author: rev.updatedBy?.name ?? "Unknown",
          authorId: rev.updatedBy?.id,
        },
        meta: {
          title: meta.title ?? "",
          ingress: meta.ingress ?? "",
        },
        markdown,
        rawContent: contentObj,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );
}

export const registerTopicTools = registerTopicDraftTools;
