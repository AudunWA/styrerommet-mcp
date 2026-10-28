import { fetchAuthenticatedDownload } from "./authenticated-download.ts";

import { promptLoginIfNeeded } from "./auth/login.ts";
import { BROWSER_USER_AGENT } from "./user-agent.ts";
import { getOrgIdFromCookieHeader } from "./organization.ts";

const BASE_URL = "https://styrerommet.no/graphql";

function getCookie(): string {
  return process.env.STYREROMMET_COOKIE || "";
}

const HEADERS: Record<string, string> = {
  "Accept-Language": "nb-NO,nb;q=0.9,en-US;q=0.8,en;q=0.7,no;q=0.6,nn;q=0.5",
  Connection: "keep-alive",
  get Cookie() {
    return getCookie();
  },
  DNT: "1",
  Origin: "https://styrerommet.no",
  Referer: "https://styrerommet.no/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent": BROWSER_USER_AGENT,
  accept: "*/*",
  "apollo-require-preflight": "true",
  "content-type": "application/json",
  "x-proxied-service": "",
  "x-proxied-service-name": "styrerommet",
  "x-version": "733",
};

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: Array<string | number>;
  }>;
}

/**
 * Execute a GraphQL query against styrerommet.no.
 * Automatically prompts interactive login if credentials are missing or expired.
 *
 * @throws {Error} if the HTTP request fails or GraphQL returns errors with no data.
 */
export async function graphqlQuery<T = unknown>(
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
  allowRetry = true,
): Promise<GraphQLResponse<T>> {
  if (!process.env.STYREROMMET_COOKIE) {
    if (allowRetry) {
      const ok = await promptLoginIfNeeded(
        "STYREROMMET_COOKIE is not configured",
      );
      if (ok && process.env.STYREROMMET_COOKIE) {
        return graphqlQuery(operationName, query, variables, false);
      }
    }
    throw new Error(
      "Authentication required: STYREROMMET_COOKIE is not set. Please log in or run 'styrerommet-mcp --auth' to configure credentials.",
    );
  }

  const response = await fetch(BASE_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ operationName, query, variables }),
    signal: AbortSignal.timeout(25000),
  });

  const isAuthError =
    response.status === 401 ||
    response.status === 403 ||
    (response.redirected && response.url.includes("/login"));

  if (isAuthError && allowRetry) {
    console.error(
      `[auth] Styrerommet session expired (HTTP ${response.status}). Triggering interactive login...`,
    );
    const ok = await promptLoginIfNeeded("Styrerommet session expired");
    if (ok) {
      return graphqlQuery(operationName, query, variables, false);
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${body.substring(0, 500)}`,
    );
  }

  const result = (await response.json()) as GraphQLResponse<T>;

  const hasAuthError = result.errors?.some(
    (e: any) =>
      /unauthorized|unauthenticated|authentication required|invalid session/i.test(
        e.message,
      ) ||
      e.code === 401 ||
      e.code === 403 ||
      e.errorType === "NOT_LOGGED_IN" ||
      e.extensions?.code === "UNAUTHENTICATED",
  );

  if (hasAuthError && allowRetry) {
    console.error(
      "[auth] GraphQL returned unauthenticated error. Triggering interactive login...",
    );
    const ok = await promptLoginIfNeeded(
      "Styrerommet GraphQL session rejected",
    );
    if (ok) {
      return graphqlQuery(operationName, query, variables, false);
    }
  }

  if (result.errors && !result.data) {
    throw new Error(
      `GraphQL errors: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }

  return result;
}

/**
 * Helper to get the configured organization ID.
 */
export function getOrgId(): string {
  const orgId =
    process.env.STYREROMMET_ORG_ID?.trim() ||
    getOrgIdFromCookieHeader(process.env.STYREROMMET_COOKIE);
  if (!orgId) {
    throw new Error(
      "No OBOS company number is configured or available in the Styrerommet session. Run interactive login or set STYREROMMET_ORG_ID.",
    );
  }
  return orgId;
}

export async function getVibboOrgSlugForOrg(
  orgId: string = getOrgId(),
): Promise<string> {
  const result = await graphqlQuery<{
    organization?: { slug?: string | null };
  }>(
    "getVibboOrgSlugForOrg",
    "query getVibboOrgSlugForOrg($organizationNumber: ID!) { organization: organizationByObosNumber(companyNumber: $organizationNumber) { slug } }",
    { organizationNumber: orgId },
    false,
  );

  const slug = result.data?.organization?.slug?.trim();
  if (!slug) {
    throw new Error(
      "Could not resolve the Vibbo organization slug for OBOS company " +
        orgId +
        ".",
    );
  }
  return slug;
}

let cachedNodeId: string | null = null;

export function reloadClientTokens(): void {
  cachedNodeId = null;
}

/**
 * Resolve and cache the unique GraphQL NodeID (UUID) of the organization.
 * Required by some queries like suppliers that do not accept the numeric ID.
 */
export async function getOrgNodeId(): Promise<string> {
  if (cachedNodeId) return cachedNodeId;

  const result = await graphqlQuery<{ organization?: { id: string } }>(
    "getOrgNodeId",
    `query getOrgNodeId($obosCompanyNumber: ID!) {
      organization: organizationByObosNumber(companyNumber: $obosCompanyNumber) {
        id
      }
    }`,
    { obosCompanyNumber: getOrgId() },
  );

  const id = result.data?.organization?.id;
  if (!id) {
    throw new Error(`Failed to resolve organization NodeID for ${getOrgId()}`);
  }
  cachedNodeId = id;
  return id;
}

/**
 * Download a file from styrerommet.no using the authenticated cookie and headers.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, basename, extname, resolve } from "node:path";

export async function downloadFile(
  url: string,
  destPath: string,
): Promise<void> {
  const response = await fetchAuthenticatedDownload(
    url,
    "https://styrerommet.no",
    HEADERS,
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} failed to download document`);
  }

  const arrayBuffer = await response.arrayBuffer();
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, Buffer.from(arrayBuffer));
}

export interface UploadAttachmentResult {
  id: string;
  fileId?: string;
  organizationId?: string;
  filename: string;
  url: string;
  contentType: string;
  createdBy?: string;
}

export function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mov":
      return "video/quicktime";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

export function getUploadRoute(_contentType?: string): string {
  // Styrerommet item attachments (HMS deviations, contracts, tasks) use /attachment.
  // Specialized endpoints like /image or /video require a directory query parameter.
  return "attachment";
}

/**
 * Upload a binary file as an attachment to styrerommet.no.
 * Automatically chooses the appropriate upload endpoint (/image, /video, or /attachment)
 * and resolves the organization NodeID.
 */
export async function uploadAttachment(
  filePath: string,
  customFilename?: string,
  allowRetry = true,
): Promise<UploadAttachmentResult> {
  const resolvedPath = resolve(process.cwd(), filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(
      `File not found for upload: "${filePath}" (resolved to "${resolvedPath}")`,
    );
  }

  if (!process.env.STYREROMMET_COOKIE) {
    if (allowRetry) {
      const ok = await promptLoginIfNeeded(
        "STYREROMMET_COOKIE is not configured",
      );
      if (ok && process.env.STYREROMMET_COOKIE) {
        return uploadAttachment(filePath, customFilename, false);
      }
    }
    throw new Error(
      "Authentication required: STYREROMMET_COOKIE is not set. Please log in or run 'styrerommet-mcp --auth' to configure credentials.",
    );
  }

  const filename = customFilename || basename(resolvedPath);
  const contentType = getMimeType(filename);
  const route = getUploadRoute(contentType);
  const orgNodeId = await getOrgNodeId();
  const buffer = readFileSync(resolvedPath);

  const url = `https://styrerommet.no/attachments/upload/${route}?filename=${encodeURIComponent(filename)}&organizationId=${encodeURIComponent(orgNodeId)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept-Language":
        "nb-NO,nb;q=0.9,en-US;q=0.8,en;q=0.7,no;q=0.6,nn;q=0.5",
      Connection: "keep-alive",
      Cookie: getCookie(),
      DNT: "1",
      Origin: "https://styrerommet.no",
      Referer: `https://styrerommet.no/${getOrgId()}/hms`,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": BROWSER_USER_AGENT,
      accept: "*/*",
      "content-type": contentType,
    },
    body: buffer,
    signal: AbortSignal.timeout(60000),
  });

  const isAuthError =
    response.status === 401 ||
    response.status === 403 ||
    (response.redirected && response.url.includes("/login"));

  if (isAuthError && allowRetry) {
    console.error(
      `[auth] Styrerommet upload session expired (HTTP ${response.status}). Triggering interactive login...`,
    );
    const ok = await promptLoginIfNeeded("Styrerommet upload session expired");
    if (ok) {
      return uploadAttachment(filePath, customFilename, false);
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Upload failed HTTP ${response.status} ${response.statusText}: ${body.substring(0, 500)}`,
    );
  }

  return (await response.json()) as UploadAttachmentResult;
}
