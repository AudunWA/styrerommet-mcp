const LAST_USED_ORG_ID_COOKIE = "last_used_organization_id";

function normalizeOrganizationId(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;

  let normalized = value.trim();
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1);
  }

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original value when it is not URL-encoded.
  }

  return /^\d+$/.test(normalized) ? normalized : undefined;
}

/**
 * Read Styrerommet's last-selected tenant from its browser Cookie header.
 */
export function getOrgIdFromCookieHeader(
  cookieHeader: string | undefined,
): string | undefined {
  if (!cookieHeader) return undefined;

  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;

    const name = cookie.slice(0, separator).trim();
    if (name !== LAST_USED_ORG_ID_COOKIE) continue;

    return normalizeOrganizationId(cookie.slice(separator + 1));
  }

  return undefined;
}

/**
 * Read a tenant number from Styrerommet's post-login URL.
 */
export function getOrgIdFromRequestUrl(
  requestUrl: string | undefined,
): string | undefined {
  if (!requestUrl) return undefined;

  try {
    const url = new URL(requestUrl);
    const queryId =
      normalizeOrganizationId(url.searchParams.get("organizationNumber")) ??
      normalizeOrganizationId(url.searchParams.get("obosCompanyNumber"));
    if (queryId) return queryId;

    return normalizeOrganizationId(url.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1]);
  } catch {
    return undefined;
  }
}
