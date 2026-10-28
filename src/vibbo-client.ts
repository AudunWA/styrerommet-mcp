import { fetchAuthenticatedDownload } from "./authenticated-download.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promptLoginIfNeeded } from "./auth/login.ts";
import { BROWSER_USER_AGENT } from "./user-agent.ts";

const BASE_URL = "https://vibbo.no/graphql";

function getCookie(): string {
  return process.env.VIBBO_COOKIE || process.env.STYREROMMET_COOKIE || "";
}

export function getVibboOrgSlug(): string {
  const slug = process.env.VIBBO_ORG_SLUG?.trim();
  if (!slug)
    throw new Error(
      "VIBBO_ORG_SLUG is required. Set your Vibbo organization slug in .env.",
    );
  return slug;
}

function getHeaders(): Record<string, string> {
  const slug = getVibboOrgSlug();
  return {
    "Accept-Language": "nb-NO,nb;q=0.9,en-US;q=0.8,en;q=0.7,no;q=0.6,nn;q=0.5",
    Connection: "keep-alive",
    Cookie: getCookie(),
    DNT: "1",
    Origin: "https://vibbo.no",
    Referer: `https://vibbo.no/${slug}`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": BROWSER_USER_AGENT,
    accept: "*/*",
    "apollo-require-preflight": "true",
    "cache-control": "no-cache",
    "content-type": "application/json",
    pragma: "no-cache",
    "x-proxied-service": "",
    "x-proxied-service-name": "vibbo",
    "x-version": "827",
  };
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: Array<string | number>;
  }>;
}

/**
 * Execute a read-only GraphQL query against vibbo.no.
 * Automatically prompts interactive login if credentials are missing or expired.
 *
 * @throws {Error} if the HTTP request fails or GraphQL returns errors with no data.
 */
export async function vibboGraphqlQuery<T = unknown>(
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
  allowRetry = true,
): Promise<GraphQLResponse<T>> {
  if (!process.env.VIBBO_COOKIE && !process.env.STYREROMMET_COOKIE) {
    if (allowRetry) {
      const ok = await promptLoginIfNeeded(
        "Vibbo session cookie is not configured",
      );
      if (ok && (process.env.VIBBO_COOKIE || process.env.STYREROMMET_COOKIE)) {
        return vibboGraphqlQuery(operationName, query, variables, false);
      }
    }
    throw new Error(
      "Authentication required: VIBBO_COOKIE (or STYREROMMET_COOKIE) is not set. Please log in or run 'styrerommet-mcp --auth'.",
    );
  }

  const cleanQuery = query
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "  ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

  const url = `${BASE_URL}?name=${encodeURIComponent(operationName)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ operationName, query: cleanQuery, variables }),
    signal: AbortSignal.timeout(25000),
  });

  const isAuthError =
    response.status === 401 ||
    response.status === 403 ||
    (response.redirected && response.url.includes("/login"));

  if (isAuthError && allowRetry) {
    console.error(
      `[auth] Vibbo session expired (HTTP ${response.status}). Triggering interactive login...`,
    );
    const ok = await promptLoginIfNeeded("Vibbo session expired");
    if (ok) {
      return vibboGraphqlQuery(operationName, query, variables, false);
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${body.substring(0, 500)}`,
    );
  }

  const result = (await response.json()) as GraphQLResponse<T>;

  const hasAuthError = result.errors?.some((e) =>
    /unauthorized|unauthenticated|authentication required|invalid session/i.test(
      e.message,
    ),
  );

  if (hasAuthError && allowRetry) {
    console.error(
      "[auth] Vibbo GraphQL returned unauthenticated error. Triggering interactive login...",
    );
    const ok = await promptLoginIfNeeded("Vibbo GraphQL session rejected");
    if (ok) {
      return vibboGraphqlQuery(operationName, query, variables, false);
    }
  }

  if (result.errors && !result.data) {
    throw new Error(
      `GraphQL errors: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }

  return result;
}

let cachedNodeId: string | null = null;

export function reloadVibboTokens(): void {
  cachedNodeId = null;
}

/**
 * Resolve and cache the unique GraphQL NodeID (base64 Organization:...) for Vibbo.
 * Required by queries that expect OrganizationID! as NodeID rather than the slug.
 */
export async function getVibboOrgNodeId(): Promise<string> {
  if (cachedNodeId) return cachedNodeId;

  const slug = getVibboOrgSlug();
  const result = await vibboGraphqlQuery<{ organization?: { id: string } }>(
    "getVibboOrgNodeId",
    `query getVibboOrgNodeId($organizationSlug: OrganizationID!) {
      organization(id: $organizationSlug) {
        id
      }
    }`,
    { organizationSlug: slug },
  );

  const id = result.data?.organization?.id;
  if (!id) {
    throw new Error(`Failed to resolve Vibbo organization NodeID for ${slug}`);
  }
  cachedNodeId = id;
  return id;
}

/**
 * Download a file from vibbo.no using the authenticated session.
 */
export async function downloadVibboFile(
  url: string,
  destPath: string,
): Promise<void> {
  const response = await fetchAuthenticatedDownload(
    url,
    "https://vibbo.no",
    getHeaders(),
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} failed to download document`);
  }

  const arrayBuffer = await response.arrayBuffer();
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, Buffer.from(arrayBuffer));
}
