import fs from "node:fs/promises";
import path from "node:path";
import { getOrgId } from "./client.ts";
import { BROWSER_USER_AGENT } from "./user-agent.ts";
import { getCantorBudget, getCantorTrialBalance } from "./cantor-client.ts";
import {
  buildMittByggWebUrl,
  buildMittByggMaintenancePlanWebUrl,
  buildMittByggConditionWebUrl,
  buildMittByggBuildingPartWebUrl,
  buildMittByggTasksWebUrl,
  buildMittByggDocumentsWebUrl,
  buildMittByggCompanyWebUrl,
  buildMittByggConditionReportWebUrl,
} from "./urls.ts";

const BASE_URL = "https://mittbygg.styrerommet.no";

export function getMittByggCookie(): string {
  return process.env.MITTBYGG_COOKIE || process.env.STYREROMMET_COOKIE || "";
}

export function getMittByggOrgId(): string {
  return getOrgId();
}

export function reloadMittByggTokens(): void {
  // Hook for dynamic environment updates
}

/**
 * Clean up string values by unquoting if necessary.
 */
function cleanCookie(val: string): string {
  let trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse React Server Components (RSC) text/x-component payload stream.
 * Extracts individual JSON payload lines and resolves RSC Flight binary/text chunks (T<hex_length>,).
 */
export function parseRscStream(raw: Buffer | string): Map<string, unknown> {
  const buf = typeof raw === "string" ? Buffer.from(raw, "utf-8") : raw;
  const entries = new Map<string, unknown>();
  let pos = 0;
  const len = buf.length;

  while (pos < len) {
    // Skip empty lines / whitespace
    while (pos < len && (buf[pos] === 0x0a || buf[pos] === 0x0d)) {
      pos++;
    }
    if (pos >= len) break;

    // Directives starting with ':' like ':HL'
    if (buf[pos] === 0x3a) {
      const nextNl = buf.indexOf(0x0a, pos);
      pos = nextNl === -1 ? len : nextNl + 1;
      continue;
    }

    const colonIdx = buf.indexOf(0x3a, pos);
    if (colonIdx === -1) break;

    const id = buf.subarray(pos, colonIdx).toString("utf-8").trim();
    if (!id || id.includes("\n") || id.includes(" ") || id.length > 20) {
      const nextNl = buf.indexOf(0x0a, pos);
      pos = nextNl === -1 ? len : nextNl + 1;
      continue;
    }

    const afterColon = colonIdx + 1;
    if (buf[afterColon] === 0x54 /* 'T' */) {
      // Text chunk: id:T<hex_length>,<content>
      const commaIdx = buf.indexOf(0x2c /* ',' */, afterColon);
      if (commaIdx !== -1) {
        const hexLen = buf.subarray(afterColon + 1, commaIdx).toString("utf-8");
        const chunkLen = parseInt(hexLen, 16);
        if (!isNaN(chunkLen)) {
          const contentStart = commaIdx + 1;
          const content = buf
            .subarray(contentStart, contentStart + chunkLen)
            .toString("utf-8");
          entries.set(id, content);
          pos = contentStart + chunkLen;
          continue;
        }
      }
    }

    // Regular line chunk up to \n
    const nextNl = buf.indexOf(0x0a, afterColon);
    const lineBuf =
      nextNl === -1
        ? buf.subarray(afterColon)
        : buf.subarray(afterColon, nextNl);
    pos = nextNl === -1 ? len : nextNl + 1;

    const trimmed = lineBuf.toString("utf-8").trim();
    if (
      !trimmed ||
      trimmed.startsWith("I[") ||
      trimmed.startsWith('"$S') ||
      trimmed === "X"
    ) {
      continue;
    }

    try {
      entries.set(id, JSON.parse(trimmed));
    } catch {
      entries.set(id, trimmed);
    }
  }

  return entries;
}

/**
 * Recursively clean and normalize RSC data structures (e.g. converting $D date strings to ISO strings).
 */
export function sanitizeRscData(node: unknown): unknown {
  if (typeof node === "string") {
    if (node.startsWith("$D")) {
      return node.slice(2);
    }
    if (node === "$undefined") {
      return undefined;
    }
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeRscData(item));
  }
  if (node !== null && typeof node === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node)) {
      if (key !== "children" && key !== "className") {
        clean[key] = sanitizeRscData(val);
      } else {
        clean[key] = sanitizeRscData(val);
      }
    }
    return clean;
  }
  return node;
}

/**
 * Fetch a Mitt Bygg page using Next.js React Server Components (RSC).
 */
export async function fetchMittByggRsc(
  subPath: string,
  companyNumber: string = getMittByggOrgId(),
): Promise<Map<string, unknown>> {
  const cleanSubPath = subPath.replace(/^\/+|\/+$/g, "");
  const targetPath = cleanSubPath
    ? `/${companyNumber}/${cleanSubPath}`
    : `/${companyNumber}`;
  const url = `${BASE_URL}${targetPath}`;

  const cookieHeader = cleanCookie(getMittByggCookie());

  const response = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "text/x-component",
      RSC: "1",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    signal: AbortSignal.timeout(25000),
  });

  const buf = Buffer.from(await response.arrayBuffer());
  const text = buf.toString("utf-8");

  const isAuthRedirect =
    response.status === 401 ||
    response.status === 403 ||
    (response.redirected && response.url.includes("login")) ||
    (response.redirected && response.url.includes("callbackUrl")) ||
    text.includes("Logg inn med BankID") ||
    text.includes("Velkommen til Mitt bygg") ||
    text.includes("/?callbackUrl=");

  if (isAuthRedirect && companyNumber !== "eksempel") {
    throw new Error(
      `Authentication required for Mitt Bygg (${companyNumber}). ` +
        `Please run 'styrerommet-mcp --auth mittbygg' (or 'pnpm auth') to log in, or set MITTBYGG_COOKIE in .env. ` +
        `(Tip: You can specify companyNumber: "eksempel" to view the live demo data without logging in).`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} fetching Mitt Bygg from ${url}: ${text.substring(0, 300)}`,
    );
  }

  return parseRscStream(buf);
}

/**
 * Helper to recursively search an object for a target key or predicate.
 */
function findInNode(
  node: unknown,
  predicate: (val: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const match = findInNode(item, predicate);
      if (match) return match;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (predicate(obj)) {
    return obj;
  }
  for (const val of Object.values(obj)) {
    const match = findInNode(val, predicate);
    if (match) return match;
  }
  return null;
}

/**
 * 1. Maintenance Plan (vedlikeholdsplan)
 */
export async function getMittByggMaintenancePlan(companyNumber?: string) {
  const org = companyNumber ?? getMittByggOrgId();
  const entries = await fetchMittByggRsc("vedlikeholdsplan", org);

  let planProps: Record<string, unknown> | null = null;
  for (const entry of entries.values()) {
    const match = findInNode(
      entry,
      (obj) =>
        Array.isArray(obj["measures"]) && Array.isArray(obj["recommendations"]),
    );
    if (match) {
      planProps = match;
      break;
    }
  }

  if (!planProps) {
    throw new Error(
      "Failed to parse maintenance plan from Mitt Bygg response.",
    );
  }

  const sanitized = sanitizeRscData(planProps) as Record<string, unknown>;

  return {
    companyNumber: org,
    webUrl: buildMittByggMaintenancePlanWebUrl(org),
    buildings: sanitized["buildings"] ?? [],
    measures: sanitized["measures"] ?? [],
    recommendations: sanitized["recommendations"] ?? [],
    newestRehab: sanitized["newestRehab"] ?? [],
    changeLog: sanitized["changeLog"] ?? [],
    isReadOnly: sanitized["isReadOnly"] ?? false,
    useProjectCostModel: sanitized["useProjectCostModel"] ?? true,
  };
}

/**
 * 2. Condition Overview (tilstand)
 */
export async function getMittByggCondition(companyNumber?: string) {
  const org = companyNumber ?? getMittByggOrgId();
  const entries = await fetchMittByggRsc("tilstand", org);

  let conditionProps: Record<string, unknown> | null = null;
  for (const entry of entries.values()) {
    const match = findInNode(
      entry,
      (obj) => "currentScore" in obj && Array.isArray(obj["rows"]),
    );
    if (match) {
      conditionProps = match;
      break;
    }
  }

  const sanitized = conditionProps
    ? (sanitizeRscData(conditionProps) as Record<string, unknown>)
    : null;

  return {
    companyNumber: org,
    webUrl: buildMittByggConditionWebUrl(org),
    currentScore: sanitized?.["currentScore"] ?? null,
    urgentMeasures: sanitized?.["rows"] ?? [],
  };
}

/**
 * 3. Building Parts List (bygningsdel)
 */
export async function getMittByggBuildingParts(companyNumber?: string) {
  const org = companyNumber ?? getMittByggOrgId();
  const entries = await fetchMittByggRsc("bygningsdel", org);

  const parts: Array<{
    part: string;
    label: string;
    status: string;
    webUrl: string;
  }> = [];

  const seen = new Set<string>();

  function search(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(search);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (
      typeof obj["part"] === "string" &&
      typeof obj["label"] === "string" &&
      typeof obj["status"] === "string"
    ) {
      if (!seen.has(obj["part"])) {
        seen.add(obj["part"]);
        parts.push({
          part: obj["part"],
          label: obj["label"],
          status: obj["status"],
          webUrl: buildMittByggBuildingPartWebUrl(obj["part"], org),
        });
      }
    }
    for (const val of Object.values(obj)) {
      search(val);
    }
  }

  for (const entry of entries.values()) {
    search(entry);
  }

  return {
    companyNumber: org,
    webUrl: buildMittByggBuildingPartWebUrl(undefined, org),
    totalBuildingParts: parts.length,
    buildingParts: parts,
  };
}

/**
 * 4. Building Part Details (bygningsdel/[type])
 */
export async function getMittByggBuildingPartDetails(
  partType: string,
  companyNumber?: string,
) {
  const org = companyNumber ?? getMittByggOrgId();
  const entries = await fetchMittByggRsc(`bygningsdel/${partType}`, org);

  // Extract table rows, checklist, and history
  const historyRows: any[] = [];
  function searchRows(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(searchRows);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj["rows"])) {
      historyRows.push(...obj["rows"]);
    }
    for (const val of Object.values(obj)) {
      searchRows(val);
    }
  }

  for (const entry of entries.values()) {
    searchRows(entry);
  }

  return {
    companyNumber: org,
    partType,
    webUrl: buildMittByggBuildingPartWebUrl(partType, org),
    historyRecords: sanitizeRscData(historyRows),
  };
}

/**
 * 5. Tasks (oppgaver)
 */
export async function getMittByggTasks(companyNumber?: string) {
  const org = companyNumber ?? getMittByggOrgId();
  const entries = await fetchMittByggRsc("oppgaver", org);

  let tasksProps: Record<string, unknown> | null = null;
  for (const entry of entries.values()) {
    const match = findInNode(entry, (obj) => Array.isArray(obj["tasks"]));
    if (match) {
      tasksProps = match;
      break;
    }
  }

  const sanitized = tasksProps
    ? (sanitizeRscData(tasksProps) as Record<string, unknown>)
    : null;

  return {
    companyNumber: org,
    webUrl: buildMittByggTasksWebUrl(org),
    totalTasks: Array.isArray(sanitized?.["tasks"])
      ? (sanitized?.["tasks"] as any[]).length
      : 0,
    tasks: sanitized?.["tasks"] ?? [],
    users: sanitized?.["users"] ?? [],
  };
}

/**
 * 6. Documents (dokumenter)
 */
export async function getMittByggDocuments(companyNumber?: string) {
  const org = companyNumber ?? getMittByggOrgId();
  const entries = await fetchMittByggRsc("dokumenter", org);

  let docProps: Record<string, unknown> | null = null;
  for (const entry of entries.values()) {
    const match = findInNode(entry, (obj) => Array.isArray(obj["documents"]));
    if (match) {
      docProps = match;
      break;
    }
  }

  const sanitized = docProps
    ? (sanitizeRscData(docProps) as Record<string, unknown>)
    : null;

  return {
    companyNumber: org,
    webUrl: buildMittByggDocumentsWebUrl(org),
    documents: sanitized?.["documents"] ?? [],
  };
}

/**
 * 7. Company & Building Property Information (om-selskapet)
 */
export async function getMittByggCompanyInfo(companyNumber?: string) {
  const org = companyNumber ?? getMittByggOrgId();
  const entries = await fetchMittByggRsc("om-selskapet", org);

  let slides: any[] = [];
  function searchSlides(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(searchSlides);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj["slides"])) {
      slides = obj["slides"] as any[];
      return;
    }
    for (const val of Object.values(obj)) {
      searchSlides(val);
    }
  }

  for (const entry of entries.values()) {
    searchSlides(entry);
    if (slides.length > 0) break;
  }

  return {
    companyNumber: org,
    webUrl: buildMittByggCompanyWebUrl(org),
    buildings: sanitizeRscData(slides),
  };
}

/**
 * 8. Condition Report from Anticimex (bygningsrapport)
 */
export async function getMittByggConditionReport(companyNumber?: string) {
  const org = companyNumber ?? getMittByggOrgId();
  const entries = await fetchMittByggRsc("bygningsrapport", org);

  let reportProps: Record<string, unknown> | null = null;
  for (const entry of entries.values()) {
    const match = findInNode(
      entry,
      (obj) => "aggregate" in obj && Array.isArray(obj["mainElements"]),
    );
    if (match) {
      reportProps = match;
      break;
    }
  }

  if (!reportProps) {
    return {
      companyNumber: org,
      webUrl: buildMittByggConditionReportWebUrl(org),
      hasConditionReport: false,
      message:
        "Ingen tilstandsrapport (Anticimex) er bestilt eller fullført for dette bygget ennå.",
      aggregate: null,
      mainElementsCount: 0,
      mainElements: [],
      buildingPartTypes: [],
    };
  }

  const sanitized = sanitizeRscData(reportProps) as Record<string, unknown>;

  return {
    companyNumber: org,
    webUrl: buildMittByggConditionReportWebUrl(org),
    hasConditionReport: true,
    aggregate: sanitized["aggregate"],
    mainElementsCount: Array.isArray(sanitized["mainElements"])
      ? sanitized["mainElements"].length
      : 0,
    mainElements: sanitized["mainElements"] ?? [],
    buildingPartTypes: sanitized["buildingPartTypes"] ?? [],
  };
}

/**
 * 9. Combined Overview / Dashboard
 */
export async function getMittByggOverview(companyNumber?: string) {
  const org = companyNumber ?? getMittByggOrgId();

  // Parallel fetch condition and maintenance plan for the overview
  const [condition, plan] = await Promise.all([
    getMittByggCondition(org).catch(() => null),
    getMittByggMaintenancePlan(org).catch(() => null),
  ]);

  return {
    companyNumber: org,
    webUrl: buildMittByggWebUrl("", org),
    conditionScore: condition?.currentScore ?? null,
    urgentMeasures: condition?.urgentMeasures ?? [],
    totalPlannedMeasures: Array.isArray(plan?.measures)
      ? plan.measures.length
      : 0,
    measures: (plan?.measures as any[]) ?? [],
    recommendationsCount: Array.isArray(plan?.recommendations)
      ? plan.recommendations.length
      : 0,
    recommendations: (plan?.recommendations as any[]) ?? [],
    buildingsCount: Array.isArray(plan?.buildings) ? plan.buildings.length : 0,
    buildings: (plan?.buildings as any[]) ?? [],
  };
}

/**
 * Action IDs for Mitt Bygg Next.js Server Actions.
 */
export const MITTBYGG_ACTION_IDS = {
  createMeasure: "40e4efac9404f781a324813b17a59dce4f3e7a0420",
  updateMeasure: "40891907052c4ab77c6f8f8415d5c4ec74f422eff3",
  deleteMeasure: "600d6b3649da746d2b32271e2bae8959b9341086f6",
  createMeasureFromRecommendation: "6097de03ad7ce0a5ec05b26ff5d3ac8cc76c1a0f86",
  markRecommendationNotPrioritized:
    "78ecc5b9b9f51e5be9523e3361bd81f74380e83291",
  reactivateRecommendation: "6015e03c0a49f4cbf44734948359fb521fdea7a183",
  updateUserAssignedToTask: "6068a1ca789a5f2a0ce8c2f247cbf8db038023e51d",
  updateBuildingName: "60362fa8f01424a626200654e8337674ea92fef973",
  markBuildingPartRelevant: "6030fa6706b681a1ca7c29fff71d553dadfe35e341",
  markBuildingPartIrrelevant: "70fb97ecb8da2931a63b3b7447522862c7d65b499d",
  updateTaskStatusAndComment: "60630bbf7d17278f6eef45801e7c7a0436e3953fae",
  updateTaskCommentAndYear: "60c0b1068d31f690f2b13a687472e025d6e3a8f3b4",
  createTask: "40524ec8d27e6c6ff9a085203ae67793640e28ac1f",
  addHistoryUserEntry: "60763d333b3a39b25a7e09faf11f6d26bf7dba821c",
  updateHistoryUserEntry: "40a58488ab42430929e8829107421efa47244f16c1",
  deleteHistoryUserEntry: "404a2c1de7023ac05925142e8f425c4ab17430be48",
  deleteDocument: "4035876cd69d0101c9ae23ceb21dd4d781451e9bf5",
  updateDocument: "40db95868b9bc911bb00074f7276ecc7a778f9e82c",
  uploadDocumentFile: "40bd5643c74628f959a926cb66aa35ef37468e2325",
  analyzeDocument: "40c4ce0f7611abc48b6a7a5c731d1d6b36507c00ff",
  saveDocument: "403753355aae362c33062def7bf3c83bbb33480cec",
  discardDocumentUpload: "407a0c23133eea62bd06e369fea169a066199f8ea0",
} as const;

export type MittByggActionName = keyof typeof MITTBYGG_ACTION_IDS;

const dynamicActionCache = new Map<string, string>();

export function getMittByggActionId(actionKeyOrId: string): string {
  return (
    dynamicActionCache.get(actionKeyOrId) ??
    (MITTBYGG_ACTION_IDS as Record<string, string>)[actionKeyOrId] ??
    actionKeyOrId
  );
}

export async function refreshMittByggActionIds(
  subPath: string = "vedlikeholdsplan",
  companyNumber: string = getMittByggOrgId(),
): Promise<Map<string, string>> {
  const cookieHeader = cleanCookie(getMittByggCookie());
  const cleanSubPath = subPath.replace(/^\/+|\/+$/g, "");
  const targetPath = cleanSubPath
    ? `/${companyNumber}/${cleanSubPath}`
    : `/${companyNumber}`;
  const url = `${BASE_URL}${targetPath}`;

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/x-component",
        RSC: "1",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    const matches =
      text.match(/_next\/static\/chunks\/[a-zA-Z0-9_\-]+\.js/g) || [];
    const uniqueChunks = Array.from(new Set(matches));

    for (const chunkPath of uniqueChunks) {
      try {
        const chunkRes = await fetch(`${BASE_URL}/${chunkPath}`, {
          signal: AbortSignal.timeout(8000),
        });
        const chunkText = await chunkRes.text();
        const re =
          /createServerReference\)?\(\s*[\x22\x27]([a-f0-9]+)[\x22\x27]\s*,[^,]+,[^,]+,[^,]+,[\x22\x27]([^\x22\x27]+)[\x22\x27]\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(chunkText)) !== null) {
          const hash = m[1];
          const name = m[2];
          if (!hash || !name) continue;
          if (name === "submitAction") {
            if (chunkText.includes("priceEstimateSize")) {
              dynamicActionCache.set("createTask", hash);
            } else if (chunkText.includes("submitCommentAndYear")) {
              dynamicActionCache.set("updateTaskStatusAndComment", hash);
            }
          } else {
            if (name === "createMeasureAction")
              dynamicActionCache.set("createMeasure", hash);
            else if (name === "updateMeasureAction")
              dynamicActionCache.set("updateMeasure", hash);
            else if (name === "deleteMeasureAction")
              dynamicActionCache.set("deleteMeasure", hash);
            else if (name === "createMeasureFromRecommendationAction")
              dynamicActionCache.set("createMeasureFromRecommendation", hash);
            else if (name === "markRecommendationNotPrioritizedAction")
              dynamicActionCache.set("markRecommendationNotPrioritized", hash);
            else if (name === "reactivateRecommendationAction")
              dynamicActionCache.set("reactivateRecommendation", hash);
            else if (name === "updateUserAssignedToTaskAction")
              dynamicActionCache.set("updateUserAssignedToTask", hash);
            else if (name === "updateBuildingNameAction")
              dynamicActionCache.set("updateBuildingName", hash);
            else if (name === "markRelevantAction")
              dynamicActionCache.set("markBuildingPartRelevant", hash);
            else if (name === "markIrrelevantAction")
              dynamicActionCache.set("markBuildingPartIrrelevant", hash);
            else if (name === "submitCommentAndYear")
              dynamicActionCache.set("updateTaskCommentAndYear", hash);
            else if (name === "addHistoryUserEntryAction")
              dynamicActionCache.set("addHistoryUserEntry", hash);
            else if (name === "updateHistoryUserEntryAction")
              dynamicActionCache.set("updateHistoryUserEntry", hash);
            else if (name === "deleteHistoryUserEntryAction")
              dynamicActionCache.set("deleteHistoryUserEntry", hash);
            else if (name === "deleteDocumentAction")
              dynamicActionCache.set("deleteDocument", hash);
            else if (name === "updateDocumentAction")
              dynamicActionCache.set("updateDocument", hash);
            else if (name === "uploadDocumentFileAction")
              dynamicActionCache.set("uploadDocumentFile", hash);
            else if (name === "analyzeDocumentAction")
              dynamicActionCache.set("analyzeDocument", hash);
            else if (name === "saveDocumentAction")
              dynamicActionCache.set("saveDocument", hash);
            else if (name === "discardDocumentUploadAction")
              dynamicActionCache.set("discardDocumentUpload", hash);
            dynamicActionCache.set(name, hash);
          }
        }
      } catch {
        // ignore individual chunk failures
      }
    }
  } catch {
    // ignore page fetch failure
  }

  return dynamicActionCache;
}

/**
 * Invoke a Next.js Server Action on Mitt Bygg via HTTP POST with Next-Action header.
 * Supports both JSON array arguments and React Flight RPC FormData.
 * Automatically self-heals action hashes if a Next.js production deployment updated them.
 */
export async function invokeMittByggServerAction<T = unknown>(
  actionKeyOrId: keyof typeof MITTBYGG_ACTION_IDS | string,
  args: unknown[] | FormData,
  subPath: string = "vedlikeholdsplan",
  companyNumber: string = getMittByggOrgId(),
  retryCount: number = 0,
): Promise<T> {
  const cleanSubPath = subPath.replace(/^\/+|\/+$/g, "");
  const targetPath = cleanSubPath
    ? `/${companyNumber}/${cleanSubPath}`
    : `/${companyNumber}`;
  const url = `${BASE_URL}${targetPath}`;
  const cookieHeader = cleanCookie(getMittByggCookie());

  const actionId = getMittByggActionId(actionKeyOrId);
  const isFormData =
    typeof FormData !== "undefined" && args instanceof FormData;

  const headers: Record<string, string> = {
    "User-Agent": BROWSER_USER_AGENT,
    "Next-Action": actionId,
    Accept: "text/x-component",
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };

  if (!isFormData) {
    headers["Content-Type"] = "text/plain;charset=UTF-8";
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: isFormData ? args : JSON.stringify(args),
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    if (
      response.status === 404 &&
      retryCount === 0 &&
      (errText.includes("Server action not found") || errText.includes("404"))
    ) {
      await refreshMittByggActionIds(subPath, companyNumber);
      return invokeMittByggServerAction<T>(
        actionKeyOrId,
        args,
        subPath,
        companyNumber,
        retryCount + 1,
      );
    }
    throw new Error(
      `Server Action failed (HTTP ${response.status} ${response.statusText}): ${errText.slice(0, 300)}`,
    );
  }

  const buf = Buffer.from(await response.arrayBuffer());
  const entries = parseRscStream(buf);

  // Check for action validation error or response object
  for (const entry of entries.values()) {
    if (
      entry &&
      typeof entry === "object" &&
      ("success" in entry ||
        "fields" in entry ||
        "validationErrors" in entry ||
        "actionId" in entry ||
        "file" in entry)
    ) {
      return sanitizeRscData(entry) as T;
    }
  }

  return { success: true } as T;
}

export interface CreateMeasureInput {
  companyNumber?: string | undefined;
  buildingPartType: string;
  buildingScope?: "allBuildings" | "selectedBuildings" | undefined;
  buildingIds?: string[] | undefined;
  year: string | number;
  cost?: string | number | undefined;
  status?: "planned" | "started" | undefined;
  title: string;
  description: string;
}

export async function createMittByggMeasure(params: CreateMeasureInput) {
  const org = params.companyNumber ?? getMittByggOrgId();
  const payload = {
    companyNumber: org,
    buildingPartType: params.buildingPartType,
    buildingScope: params.buildingScope ?? "allBuildings",
    buildingIds: (params.buildingIds ?? []).map(String),
    year: String(params.year),
    cost: params.cost != null ? String(params.cost) : "",
    status: params.status ?? "planned",
    title: params.title.trim(),
    description: params.description.trim(),
  };

  const result = await invokeMittByggServerAction<{
    success: boolean;
    fields?: Record<string, string[]>;
  }>(MITTBYGG_ACTION_IDS.createMeasure, [payload], "vedlikeholdsplan", org);

  if (result && result.success === false) {
    const fieldErrors = Object.entries(result.fields ?? {})
      .map(([k, errs]) => `${k}: ${errs.join(", ")}`)
      .join("; ");
    throw new Error(`Feil ved opprettelse av tiltak: ${fieldErrors}`);
  }

  return {
    success: true,
    companyNumber: org,
    message: `Tiltak "${params.title}" ble opprettet i vedlikeholdsplanen for ${org}.`,
    measure: payload,
  };
}

export interface UpdateMeasureInput extends CreateMeasureInput {
  id: number;
}

export async function updateMittByggMeasure(params: UpdateMeasureInput) {
  const org = params.companyNumber ?? getMittByggOrgId();
  const payload = {
    id: params.id,
    companyNumber: org,
    buildingPartType: params.buildingPartType,
    buildingScope: params.buildingScope ?? "allBuildings",
    buildingIds: (params.buildingIds ?? []).map(String),
    year: String(params.year),
    cost: params.cost != null ? String(params.cost) : "",
    status: params.status ?? "planned",
    title: params.title.trim(),
    description: params.description.trim(),
  };

  const result = await invokeMittByggServerAction<{
    success: boolean;
    fields?: Record<string, string[]>;
  }>(MITTBYGG_ACTION_IDS.updateMeasure, [payload], "vedlikeholdsplan", org);

  if (result && result.success === false) {
    const fieldErrors = Object.entries(result.fields ?? {})
      .map(([k, errs]) => `${k}: ${errs.join(", ")}`)
      .join("; ");
    throw new Error(`Feil ved oppdatering av tiltak: ${fieldErrors}`);
  }

  return {
    success: true,
    companyNumber: org,
    message: `Tiltak #${params.id} ("${params.title}") ble oppdatert.`,
    measure: payload,
  };
}

export async function deleteMittByggMeasure(
  measureId: number,
  companyNumber?: string,
) {
  const org = companyNumber ?? getMittByggOrgId();
  await invokeMittByggServerAction(
    MITTBYGG_ACTION_IDS.deleteMeasure,
    [org, measureId],
    "vedlikeholdsplan",
    org,
  );

  return {
    success: true,
    companyNumber: org,
    measureId,
    message: `Tiltak #${measureId} ble slettet fra vedlikeholdsplanen.`,
  };
}

export async function assignMittByggTask(
  taskId: number,
  userId: number | null,
  companyNumber?: string,
) {
  const org = companyNumber ?? getMittByggOrgId();
  await invokeMittByggServerAction(
    MITTBYGG_ACTION_IDS.updateUserAssignedToTask,
    [userId, taskId],
    "oppgaver",
    org,
  );

  return {
    success: true,
    companyNumber: org,
    taskId,
    assignedToUserId: userId,
    message: userId
      ? `Oppgave #${taskId} er nå tildelt bruker #${userId}.`
      : `Tildeling for oppgave #${taskId} er fjernet.`,
  };
}

export async function dismissMittByggRecommendation(
  buildingPartType: string,
  recommendedYear: number,
  reason: string,
  companyNumber?: string,
) {
  const org = companyNumber ?? getMittByggOrgId();
  await invokeMittByggServerAction(
    MITTBYGG_ACTION_IDS.markRecommendationNotPrioritized,
    [org, buildingPartType, recommendedYear, reason],
    "vedlikeholdsplan",
    org,
  );

  return {
    success: true,
    companyNumber: org,
    buildingPartType,
    recommendedYear,
    reason,
    message: `Anbefaling for ${buildingPartType} (${recommendedYear}) ble markert som nedprioritert.`,
  };
}

export async function reactivateMittByggRecommendation(
  changeId: number,
  companyNumber?: string,
) {
  const org = companyNumber ?? getMittByggOrgId();
  await invokeMittByggServerAction(
    MITTBYGG_ACTION_IDS.reactivateRecommendation,
    [org, changeId],
    "vedlikeholdsplan",
    org,
  );

  return {
    success: true,
    companyNumber: org,
    changeId,
    message: `Anbefaling (endring #${changeId}) ble gjenaktivert.`,
  };
}

export interface CreateMeasureFromRecommendationInput {
  companyNumber?: string | undefined;
  buildingPartType: string;
  endOfLifeYear: number;
  buildingScope?: "allBuildings" | "selectedBuildings" | undefined;
  buildingIds?: string[] | undefined;
  year: string | number;
  cost?: string | number | undefined;
  status?: "planned" | "started" | undefined;
  title: string;
  description: string;
}

export async function createMittByggMeasureFromRecommendation(
  params: CreateMeasureFromRecommendationInput,
) {
  const org = params.companyNumber ?? getMittByggOrgId();
  const measurePayload = {
    companyNumber: org,
    buildingPartType: params.buildingPartType,
    buildingScope: params.buildingScope ?? "allBuildings",
    buildingIds: (params.buildingIds ?? []).map(String),
    year: String(params.year),
    cost: params.cost != null ? String(params.cost) : "",
    status: params.status ?? "planned",
    title: params.title.trim(),
    description: params.description.trim(),
  };

  const recommendationIdentity = {
    buildingPartType: params.buildingPartType,
    endOfLifeYear: params.endOfLifeYear,
    source: "recommendation",
  };

  const result = await invokeMittByggServerAction<{
    success: boolean;
    fields?: Record<string, string[]>;
  }>(
    MITTBYGG_ACTION_IDS.createMeasureFromRecommendation,
    [measurePayload, recommendationIdentity],
    "vedlikeholdsplan",
    org,
  );

  if (result && result.success === false) {
    const fieldErrors = Object.entries(result.fields ?? {})
      .map(([k, errs]) => `${k}: ${errs.join(", ")}`)
      .join("; ");
    throw new Error(
      `Feil ved opprettelse av tiltak fra anbefaling: ${fieldErrors}`,
    );
  }

  return {
    success: true,
    companyNumber: org,
    message: `Anbefaling for ${params.buildingPartType} (${params.endOfLifeYear}) ble lagt til i vedlikeholdsplanen som tiltak "${params.title}".`,
    measure: measurePayload,
  };
}

export async function updateMittByggBuildingName(
  buildingId: number,
  displayName: string,
  companyNumber?: string,
) {
  const org = companyNumber ?? getMittByggOrgId();
  await invokeMittByggServerAction(
    MITTBYGG_ACTION_IDS.updateBuildingName,
    [buildingId, displayName.trim()],
    "om-selskapet",
    org,
  );

  return {
    success: true,
    companyNumber: org,
    buildingId,
    displayName: displayName.trim(),
    message: displayName.trim()
      ? `Bygningsnavn for bygg #${buildingId} ble endret til "${displayName.trim()}".`
      : `Bygningsnavn for bygg #${buildingId} ble tilbakestilt til standard Kartverket-navn.`,
  };
}

export async function setMittByggBuildingPartRelevance(
  buildingPartType: string,
  relevant: boolean,
  companyNumber?: string,
) {
  const org = companyNumber ?? getMittByggOrgId();
  const actionId = relevant
    ? MITTBYGG_ACTION_IDS.markBuildingPartRelevant
    : MITTBYGG_ACTION_IDS.markBuildingPartIrrelevant;

  await invokeMittByggServerAction(
    actionId,
    [org, buildingPartType],
    "bygningsdel",
    org,
  );

  return {
    success: true,
    companyNumber: org,
    buildingPartType,
    relevant,
    message: relevant
      ? `Bygningsdel "${buildingPartType}" er markert som relevant for eiendommen.`
      : `Bygningsdel "${buildingPartType}" er markert som IKKE relevant for eiendommen.`,
  };
}

export interface UpdateTaskInput {
  taskId: number;
  status: "notStarted" | "handled" | "handling" | "planning" | "disregarded";
  comment: string;
  year?: number | undefined;
  companyNumber?: string | undefined;
}

export async function updateMittByggTask(params: UpdateTaskInput) {
  const org = params.companyNumber ?? getMittByggOrgId();
  const fd = new FormData();
  fd.append("_1_actionId", String(params.taskId));
  fd.append("_1_comment", params.comment.trim());
  fd.append("_1_status", params.status);

  let actionId: string = MITTBYGG_ACTION_IDS.updateTaskStatusAndComment;
  if (params.year != null) {
    fd.append("_1_year", String(params.year));
    actionId = MITTBYGG_ACTION_IDS.updateTaskCommentAndYear;
  }
  fd.append("0", JSON.stringify([{}, "$K1"]));

  const result = await invokeMittByggServerAction<{
    success: boolean;
    validationErrors?: Record<string, string[]>;
  }>(actionId, fd, "oppgaver", org);

  if (result && result.success === false) {
    const errs = Object.entries(result.validationErrors ?? {})
      .map(([k, msgs]) => `${k}: ${msgs.join(", ")}`)
      .join("; ");
    throw new Error(`Feil ved oppdatering av oppgave: ${errs}`);
  }

  return {
    success: true,
    companyNumber: org,
    taskId: params.taskId,
    status: params.status,
    comment: params.comment.trim(),
    year: params.year ?? null,
    message: `Oppgave #${params.taskId} ble oppdatert med status "${params.status}"${params.year != null ? ` og år ${params.year}` : ""}.`,
  };
}

export interface UpdateDocumentInput {
  documentId: number;
  title: string;
  buildingPartTypes?: string[] | undefined;
  documentType?: string | null | undefined;
  year?: number | undefined;
  summary?: string | undefined;
  tags?: string[] | undefined;
  companyNumber?: string | undefined;
}

export async function updateMittByggDocument(params: UpdateDocumentInput) {
  const org = params.companyNumber ?? getMittByggOrgId();
  const payload = {
    companyNumber: org,
    documentId: params.documentId,
    title: params.title.trim(),
    buildingPartTypes: params.buildingPartTypes ?? [],
    documentType: params.documentType ?? null,
    documentYear: params.year != null ? String(params.year) : "",
    summary: params.summary ?? "",
    tags: params.tags ?? [],
  };

  const result = await invokeMittByggServerAction<{
    success: boolean;
    fields?: Record<string, string[]>;
  }>(MITTBYGG_ACTION_IDS.updateDocument, [payload], "dokumenter", org);

  if (result && result.success === false) {
    const errs = Object.entries(result.fields ?? {})
      .map(([k, msgs]) => `${k}: ${msgs.join(", ")}`)
      .join("; ");
    throw new Error(`Feil ved oppdatering av dokument: ${errs}`);
  }

  return {
    success: true,
    companyNumber: org,
    documentId: params.documentId,
    title: params.title.trim(),
    message: `Dokument #${params.documentId} ("${params.title.trim()}") ble oppdatert.`,
  };
}

export async function deleteMittByggDocument(
  documentId: number,
  companyNumber?: string,
) {
  const org = companyNumber ?? getMittByggOrgId();
  await invokeMittByggServerAction(
    MITTBYGG_ACTION_IDS.deleteDocument,
    [{ companyNumber: org, documentId }],
    "dokumenter",
    org,
  );

  return {
    success: true,
    companyNumber: org,
    documentId,
    message: `Dokument #${documentId} ble slettet fra Mitt Bygg arkiv.`,
  };
}

export interface CreateTaskInput {
  title: string;
  yearToFix: number;
  assignedToUserId?: number | string | undefined;
  buildingPartType?: string | undefined;
  priceEstimateSize: "small" | "medium" | "large" | "extraLarge" | "unknown";
  description?: string | undefined;
  checkpointElementId?: number | string | undefined;
  companyNumber?: string | undefined;
}

export async function createMittByggTask(params: CreateTaskInput) {
  const org = params.companyNumber ?? getMittByggOrgId();
  const fd = new FormData();
  fd.append("_1_title", params.title.trim());
  fd.append("_1_yearToFix", String(params.yearToFix));
  fd.append(
    "_1_assignedToUserId",
    params.assignedToUserId != null ? String(params.assignedToUserId) : "-1",
  );
  if (params.buildingPartType) {
    fd.append("_1_buildingPartType", params.buildingPartType);
  }
  fd.append("_1_priceEstimateSize", params.priceEstimateSize);
  fd.append("_1_description", (params.description ?? "").trim());
  if (params.checkpointElementId != null) {
    fd.append("_1_checkpointElementId", String(params.checkpointElementId));
  }
  fd.append("_1_companyNumber", org);
  fd.append("0", JSON.stringify(["$K1"]));

  const result = await invokeMittByggServerAction<{
    success: boolean;
    actionId?: number;
    validationErrors?: Record<string, string[]>;
    error?: string;
  }>("createTask", fd, "oppgaver", org);

  if (result && result.success === false) {
    const errs = result.validationErrors
      ? Object.entries(result.validationErrors)
          .map(([k, msgs]) => `${k}: ${msgs.join(", ")}`)
          .join("; ")
      : (result.error ?? "Ukjent valideringsfeil");
    throw new Error(`Feil ved opprettelse av oppgave: ${errs}`);
  }

  return {
    success: true,
    companyNumber: org,
    taskId: result.actionId ?? null,
    title: params.title.trim(),
    yearToFix: params.yearToFix,
    priceEstimateSize: params.priceEstimateSize,
    buildingPartType: params.buildingPartType ?? null,
    assignedToUserId:
      params.assignedToUserId != null ? Number(params.assignedToUserId) : null,
    message: `Oppgave "${params.title.trim()}" (år ${params.yearToFix}) ble opprettet for selskap ${org}${result.actionId ? ` med oppgave-ID #${result.actionId}` : ""}.`,
  };
}

export interface AddBuildingPartHistoryInput {
  buildingPartType: string;
  year: number | string;
  type: "maintenance" | "rehabilitation";
  desc?: string | undefined;
  buildingIds?: Array<number | string> | undefined;
  companyNumber?: string | undefined;
}

export async function addMittByggBuildingPartHistory(
  params: AddBuildingPartHistoryInput,
) {
  const org = params.companyNumber ?? getMittByggOrgId();
  const fd = new FormData();
  fd.append("_1_companyNumber", org);
  fd.append("_1_buildingPartType", params.buildingPartType);
  fd.append("_1_year", String(params.year));
  fd.append("_1_type", params.type);
  if (params.desc) {
    fd.append("_1_desc", params.desc.trim());
  }
  if (params.buildingIds && params.buildingIds.length > 0) {
    for (const bId of params.buildingIds) {
      fd.append("_1_buildingIds", String(bId));
    }
  }
  fd.append("0", JSON.stringify([{}, "$K1"]));

  const result = await invokeMittByggServerAction<{
    success: boolean;
    syncStarted?: boolean;
    validationErrors?: Record<string, string[]>;
  }>("addHistoryUserEntry", fd, `bygningsdel/${params.buildingPartType}`, org);

  if (result && result.success === false) {
    const errs = Object.entries(result.validationErrors ?? {})
      .map(([k, msgs]) => `${k}: ${msgs.join(", ")}`)
      .join("; ");
    throw new Error(`Feil ved registrering av historikk: ${errs}`);
  }

  return {
    success: true,
    companyNumber: org,
    buildingPartType: params.buildingPartType,
    year: params.year,
    type: params.type,
    desc: params.desc?.trim() ?? "",
    syncStarted: result?.syncStarted ?? false,
    message: `Historikk for ${params.buildingPartType} (${params.year}, ${params.type === "rehabilitation" ? "rehabilitering" : "vedlikehold"}) ble registrert for selskap ${org}.`,
  };
}

export interface UpdateBuildingPartHistoryInput {
  historyId: number;
  year: number | string;
  type: "maintenance" | "rehabilitation";
  desc?: string | undefined;
  buildingIds?: Array<number | string> | undefined;
  companyNumber?: string | undefined;
}

export async function updateMittByggBuildingPartHistory(
  params: UpdateBuildingPartHistoryInput,
) {
  const org = params.companyNumber ?? getMittByggOrgId();
  const payload = {
    historyId: params.historyId,
    companyNumber: org,
    year: String(params.year),
    type: params.type,
    desc: params.desc?.trim() ?? "",
    buildingIds: params.buildingIds
      ? params.buildingIds.map(String)
      : undefined,
  };

  const result = await invokeMittByggServerAction<{
    success: boolean;
    syncStarted?: boolean;
    validationErrors?: Record<string, string[]>;
  }>("updateHistoryUserEntry", [payload], "bygningsdel", org);

  if (result && result.success === false) {
    const errs = Object.entries(result.validationErrors ?? {})
      .map(([k, msgs]) => `${k}: ${msgs.join(", ")}`)
      .join("; ");
    throw new Error(`Feil ved oppdatering av historikk: ${errs}`);
  }

  return {
    success: true,
    companyNumber: org,
    historyId: params.historyId,
    year: params.year,
    type: params.type,
    message: `Historikkoppføring #${params.historyId} ble oppdatert.`,
  };
}

export async function deleteMittByggBuildingPartHistory(
  historyId: number,
  companyNumber?: string,
) {
  const org = companyNumber ?? getMittByggOrgId();
  const fd = new FormData();
  fd.append("_1_historyId", String(historyId));
  fd.append("_1_companyNumber", org);
  fd.append("0", JSON.stringify(["$K1"]));

  await invokeMittByggServerAction(
    "deleteHistoryUserEntry",
    fd,
    "bygningsdel",
    org,
  );

  return {
    success: true,
    companyNumber: org,
    historyId,
    message: `Historikkoppføring #${historyId} ble slettet fra Mitt Bygg.`,
  };
}

export interface UploadDocumentFileInput {
  file: Blob | File;
  fileName: string;
  companyNumber?: string;
}

export interface UploadedFileResult {
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export interface DocumentAnalysisResult {
  isRelevant?: boolean;
  irrelevanceReason?: string | null;
  title?: string;
  buildingPartTypes?: string[];
  documentType?: string | null;
  documentYear?: number | string | null;
  summary?: string;
  tags?: string[];
}

export interface SaveDocumentInput {
  fileUrl: string;
  title: string;
  buildingPartTypes?: string[];
  documentType?: string | null;
  documentYear?: number | string | null;
  summary?: string;
  tags?: string[];
  buildingPartHistoryId?: number | null;
  companyNumber?: string;
}

export async function uploadMittByggDocumentFile(
  file: Blob | File,
  fileName: string,
  companyNumber?: string,
): Promise<{ success: boolean; file?: UploadedFileResult; error?: string }> {
  const org = companyNumber ?? getMittByggOrgId();
  const fd = new FormData();
  fd.append("_1_file", file, fileName);
  fd.append("_1_companyNumber", org);
  fd.append("_1_consentProcessData", "consentProcessData");
  fd.append("0", JSON.stringify(["$K1"]));

  const result = await invokeMittByggServerAction<{
    success: boolean;
    file?: UploadedFileResult;
    error?: string;
  }>("uploadDocumentFile", fd, "dokumenter", org);

  if (result && result.success === false) {
    throw new Error(result.error ?? "Feil ved opplasting av fil");
  }

  return result;
}

export async function analyzeMittByggDocument(
  fileUrl: string,
  companyNumber?: string,
): Promise<DocumentAnalysisResult> {
  const org = companyNumber ?? getMittByggOrgId();
  const result = await invokeMittByggServerAction<DocumentAnalysisResult>(
    "analyzeDocument",
    [{ companyNumber: org, fileUrl }],
    "dokumenter",
    org,
  );
  return result ?? {};
}

export async function saveMittByggDocument(
  params: SaveDocumentInput,
): Promise<{
  success: boolean;
  documentId?: number;
  documentType?: string;
  fields?: Record<string, string[]>;
}> {
  const org = params.companyNumber ?? getMittByggOrgId();
  const payload = {
    companyNumber: org,
    fileUrl: params.fileUrl,
    title: params.title.trim(),
    buildingPartTypes: params.buildingPartTypes ?? [],
    documentType: params.documentType ?? null,
    documentYear:
      params.documentYear != null ? String(params.documentYear) : "",
    summary: params.summary ?? "",
    tags: params.tags ?? [],
    buildingPartHistoryId: params.buildingPartHistoryId ?? null,
  };

  const result = await invokeMittByggServerAction<{
    success: boolean;
    documentId?: number;
    documentType?: string;
    fields?: Record<string, string[]>;
  }>("saveDocument", [payload], "dokumenter", org);

  if (result && result.success === false) {
    const errs = Object.entries(result.fields ?? {})
      .map(([k, msgs]) => `${k}: ${msgs.join(", ")}`)
      .join("; ");
    throw new Error(`Feil ved lagring av dokument: ${errs}`);
  }

  return result;
}

export async function discardMittByggDocumentUpload(
  fileUrl: string,
  companyNumber?: string,
) {
  const org = companyNumber ?? getMittByggOrgId();
  await invokeMittByggServerAction(
    "discardDocumentUpload",
    [{ companyNumber: org, fileUrl }],
    "dokumenter",
    org,
  );
  return { success: true };
}

export interface UploadAndSaveDocumentInput {
  filePath?: string | undefined;
  fileBase64?: string | undefined;
  fileName: string;
  mimeType?: string | undefined;
  title?: string | undefined;
  buildingPartTypes?: string[] | undefined;
  documentType?: string | null | undefined;
  year?: number | undefined;
  summary?: string | undefined;
  tags?: string[] | undefined;
  buildingPartHistoryId?: number | null | undefined;
  autoAnalyze?: boolean | undefined;
  analyzeOnly?: boolean | undefined;
  companyNumber?: string | undefined;
}

export async function uploadMittByggDocument(
  params: UploadAndSaveDocumentInput,
) {
  const org = params.companyNumber ?? getMittByggOrgId();

  let fileBuffer: Buffer;
  let detectedFileName = params.fileName;

  if (params.filePath) {
    fileBuffer = await fs.readFile(params.filePath);
    if (!detectedFileName) {
      detectedFileName = path.basename(params.filePath);
    }
  } else if (params.fileBase64) {
    fileBuffer = Buffer.from(params.fileBase64, "base64");
  } else {
    throw new Error(
      "Enten filePath eller fileBase64 må oppgis for dokumentopplasting.",
    );
  }

  const ext = path.extname(detectedFileName).toLowerCase();
  let mimeType = params.mimeType;
  if (!mimeType) {
    switch (ext) {
      case ".pdf":
        mimeType = "application/pdf";
        break;
      case ".png":
        mimeType = "image/png";
        break;
      case ".jpg":
      case ".jpeg":
        mimeType = "image/jpeg";
        break;
      case ".webp":
        mimeType = "image/webp";
        break;
      case ".docx":
        mimeType =
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        break;
      case ".doc":
        mimeType = "application/msword";
        break;
      case ".xlsx":
        mimeType =
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        break;
      case ".xls":
        mimeType = "application/vnd.ms-excel";
        break;
      default:
        mimeType = "application/octet-stream";
    }
  }

  const fileBlob = new File([new Uint8Array(fileBuffer)], detectedFileName, {
    type: mimeType,
  });

  // 1. Upload file
  const uploadResult = await uploadMittByggDocumentFile(
    fileBlob,
    detectedFileName,
    org,
  );
  if (!uploadResult.file?.url) {
    throw new Error(
      "Opplasting feilet: Ingen fil-URL returnert fra Mitt Bygg.",
    );
  }

  const fileUrl = uploadResult.file.url;

  // 2. AI Analysis (if enabled or if analyzeOnly)
  let analysis: DocumentAnalysisResult | null = null;
  if (params.autoAnalyze !== false || params.analyzeOnly) {
    try {
      analysis = await analyzeMittByggDocument(fileUrl, org);
    } catch {
      // Graceful fallback if analysis fails
    }
  }

  // 3. If analyzeOnly, discard and return analysis
  if (params.analyzeOnly) {
    await discardMittByggDocumentUpload(fileUrl, org).catch(() => {});
    return {
      analyzeOnly: true,
      companyNumber: org,
      file: uploadResult.file,
      analysis,
      message: `Filen "${detectedFileName}" ble analysert og deretter forkastet (ikke lagret i arkivet).`,
    };
  }

  // 4. Save document with resolved metadata
  const titleToSave =
    params.title?.trim() ||
    analysis?.title?.trim() ||
    path.parse(detectedFileName).name;

  const buildingPartsToSave =
    params.buildingPartTypes && params.buildingPartTypes.length > 0
      ? params.buildingPartTypes
      : (analysis?.buildingPartTypes ?? []);

  const documentTypeToSave =
    params.documentType ?? analysis?.documentType ?? null;

  const documentYearToSave =
    params.year != null
      ? params.year
      : analysis?.documentYear != null
        ? Number(analysis.documentYear)
        : null;

  const summaryToSave =
    params.summary?.trim() || analysis?.summary?.trim() || "";

  const tagsToSave =
    params.tags && params.tags.length > 0
      ? params.tags
      : (analysis?.tags ?? []);

  const saveResult = await saveMittByggDocument({
    fileUrl,
    title: titleToSave,
    buildingPartTypes: buildingPartsToSave,
    documentType: documentTypeToSave,
    documentYear: documentYearToSave,
    summary: summaryToSave,
    tags: tagsToSave,
    buildingPartHistoryId: params.buildingPartHistoryId ?? null,
    companyNumber: org,
  });

  return {
    success: true,
    companyNumber: org,
    documentId: saveResult.documentId ?? null,
    title: titleToSave,
    documentType: documentTypeToSave,
    documentYear: documentYearToSave,
    buildingPartTypes: buildingPartsToSave,
    summary: summaryToSave,
    tags: tagsToSave,
    file: uploadResult.file,
    analysis,
    message: `Dokument "${titleToSave}" ble lastet opp og lagret i Mitt Bygg arkiv (ID #${saveResult.documentId ?? "ukjent"}).`,
  };
}

export interface AnalyzeMaintenanceFinancingOptions {
  companyNumber?: string | undefined;
  horizonYears?: number | undefined;
}

export async function analyzeMaintenanceFinancing(
  options: AnalyzeMaintenanceFinancingOptions = {},
) {
  const org = options.companyNumber ?? getMittByggOrgId();
  const currentYear = new Date().getFullYear();
  const horizon = options.horizonYears ?? 10;
  const endYear = currentYear + horizon;

  // 1. Fetch Maintenance Plan
  const plan = await getMittByggMaintenancePlan(org);

  // 2. Fetch Cantor data (with graceful degradation if expired/unconfigured)
  let cantorAvailable = false;
  let totalCash = 0;
  let bankAccounts: Array<{ account: string; name: string; balance: number }> =
    [];
  let totalDebt = 0;
  let annualBudgetedMaintenance = 0;
  let maintenanceLines: Array<{
    account: string;
    name: string;
    budgeted: number;
    previousYearActual?: number;
  }> = [];

  try {
    const [budget, tb] = await Promise.all([
      getCantorBudget(),
      getCantorTrialBalance(),
    ]);

    cantorAvailable = true;

    // Cash in 19xx
    const bankLines = tb.lines.filter((l) => l.kontonr.startsWith("19"));
    totalCash = bankLines.reduce((sum, l) => sum + (l.virkeligIAr ?? 0), 0);
    bankAccounts = bankLines.map((b) => ({
      account: b.kontonr,
      name: b.kontonavn ?? "",
      balance: b.virkeligIAr ?? 0,
    }));

    // Debt in 22xx
    const debtLines = tb.lines.filter((l) => l.kontonr.startsWith("22"));
    totalDebt = Math.abs(
      debtLines.reduce((sum, l) => sum + (l.virkeligIAr ?? 0), 0),
    );

    // Budgeted maintenance in 66xx
    const mLines = budget.lines.filter((l) => l.kontonr.startsWith("66"));
    annualBudgetedMaintenance = mLines.reduce(
      (sum, l) => sum + (l.sumBud ?? 0),
      0,
    );
    maintenanceLines = mLines
      .filter((m) => (m.sumBud ?? 0) > 0 || (m.virkeligIFjor ?? 0) > 0)
      .map((m) => ({
        account: m.kontonr,
        name: m.kontonavn ?? "",
        budgeted: m.sumBud ?? 0,
        previousYearActual: m.virkeligIFjor,
      }));
  } catch {
    cantorAvailable = false;
  }

  // 3. Process Maintenance Measures and Recommendations by year
  const yearlyMap = new Map<
    number,
    {
      year: number;
      measuresCost: number;
      measuresCount: number;
      measures: Array<{
        id: number;
        title: string;
        cost: number;
        buildingPart: string;
        status: string;
      }>;
      recommendationsCost: number;
      recommendationsCount: number;
      recommendations: Array<{
        buildingPart: string;
        eolYear: number;
        estimatedCost: number;
      }>;
    }
  >();

  for (let y = currentYear; y <= endYear; y++) {
    yearlyMap.set(y, {
      year: y,
      measuresCost: 0,
      measuresCount: 0,
      measures: [],
      recommendationsCost: 0,
      recommendationsCount: 0,
      recommendations: [],
    });
  }

  for (const m of plan.measures as any[]) {
    const y = Number(m.year);
    if (!isNaN(y) && yearlyMap.has(y)) {
      const entry = yearlyMap.get(y)!;
      const cost = Number(m.cost) || 0;
      entry.measuresCost += cost;
      entry.measuresCount += 1;
      entry.measures.push({
        id: m.id,
        title: m.title ?? "",
        cost,
        buildingPart: m.buildingPartType ?? "",
        status: m.status ?? "planned",
      });
    }
  }

  for (const r of plan.recommendations as any[]) {
    const y = Number(r.eolYear);
    if (!isNaN(y) && yearlyMap.has(y)) {
      const entry = yearlyMap.get(y)!;
      const cost = Number(r.estimatedCost?.point) || 0;
      entry.recommendationsCost += cost;
      entry.recommendationsCount += 1;
      entry.recommendations.push({
        buildingPart: r.buildingPartType ?? "",
        eolYear: y,
        estimatedCost: cost,
      });
    }
  }

  // 4. Synthesis & Gap Calculation
  let cumulativeNeed = 0;
  let runningCash = totalCash;

  const timeline = Array.from(yearlyMap.values()).map((row) => {
    const totalExpectedCost = row.measuresCost + row.recommendationsCost;
    cumulativeNeed += totalExpectedCost;

    const netOperatingFunding = cantorAvailable ? annualBudgetedMaintenance : 0;
    const netYearGap = totalExpectedCost - netOperatingFunding;

    if (cantorAvailable) {
      runningCash = runningCash - Math.max(0, netYearGap);
      if (runningCash < 0) {
        runningCash = 0;
      }
    }

    return {
      year: row.year,
      plannedMeasuresCost: row.measuresCost,
      plannedMeasuresCount: row.measuresCount,
      recommendationsEstimatedCost: row.recommendationsCost,
      recommendationsCount: row.recommendationsCount,
      totalExpectedCost,
      annualBudgetedAllowance: netOperatingFunding,
      netFundingGap: netYearGap,
      projectedCashReservesEndOfYear: cantorAvailable
        ? Math.round(runningCash)
        : null,
      measures: row.measures,
      recommendations: row.recommendations,
    };
  });

  const totalPlannedMeasuresCost = timeline.reduce(
    (acc, t) => acc + t.plannedMeasuresCost,
    0,
  );
  const totalRecommendationsCost = timeline.reduce(
    (acc, t) => acc + t.recommendationsEstimatedCost,
    0,
  );
  const totalCombinedRequirement =
    totalPlannedMeasuresCost + totalRecommendationsCost;

  // Strategic Insights
  const insights: string[] = [];
  if (cantorAvailable) {
    if (totalCash > totalCombinedRequirement) {
      insights.push(
        `Likviditetsreserven på kr ${Math.round(totalCash).toLocaleString("no-NO")} er tilstrekkelig til å dekke samtlige planlagte tiltak og anbefalinger (kr ${Math.round(totalCombinedRequirement).toLocaleString("no-NO")}) over den valgte horisonten uten låneopptak.`,
      );
    } else {
      const deficitYear = timeline.find(
        (t) => t.projectedCashReservesEndOfYear === 0,
      )?.year;
      if (deficitYear) {
        insights.push(
          `Likviditetsreserven vil tømmes i ${deficitYear} dersom alle OBOS-anbefalinger iverksettes uten lånefinansiering eller økning i felleskostnader.`,
        );
      }
      insights.push(
        `Nåværende årlig vedlikeholdsbudsjett (konto 66xx) er på kr ${Math.round(annualBudgetedMaintenance).toLocaleString("no-NO")}. Totalt forventet kapitalbehov over ${horizon} år er kr ${Math.round(totalCombinedRequirement).toLocaleString("no-NO")}.`,
      );
    }
  } else {
    insights.push(
      "Cantor-regnskapssynkronisering er for øyeblikket ikke tilgjengelig (sesjon utløpt eller ikke konfigurert). For å se likviditetsreserve (konto 19xx) og automatisk gap-analyse, kjør 'pnpm auth' eller sett STYREROMMET_COOKIE i .env.",
    );
  }

  return {
    companyNumber: org,
    horizonYears: horizon,
    period: `${currentYear}–${endYear}`,
    cantorAccountingDataAvailable: cantorAvailable,
    financialSnapshot: cantorAvailable
      ? {
          totalCashReserves: Math.round(totalCash),
          bankAccounts,
          longTermDebt: Math.round(totalDebt),
          annualOperatingMaintenanceBudget: Math.round(
            annualBudgetedMaintenance,
          ),
          budgetedMaintenanceAccounts: maintenanceLines,
        }
      : null,
    maintenanceSummary: {
      totalPlannedMeasuresCost,
      totalRecommendationsEstimatedCost: totalRecommendationsCost,
      totalCombinedRequirement,
    },
    insights,
    timeline,
  };
}
