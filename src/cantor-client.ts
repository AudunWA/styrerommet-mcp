/**
 * Cantor Web Services (cws.obos.no) Read-Only Client
 *
 * Provides strictly read-only access to OBOS's corporate accounting platform (Cantor),
 * including chart of accounts (kontoplan), trial balance (saldobalanse), budgets (budsjett),
 * budget specifications, and dashboard performance reports.
 *
 * Authentication:
 * Starts at https://styrerommet.no/redirect/cantor?obosCompanyNumber={companyId}. OBOS now completes
 * Cantor sign-in through an OIDC redirect at innlogging.obos.no, so that redirect must run in the
 * persistent browser profile that holds the OBOS identity-provider session. The resulting CWS cookies
 * are kept in memory and refreshed automatically.
 */

import {
  launchPersistentAuthContext,
  promptLoginIfNeeded,
} from "./auth/login.ts";
import { getOrgId } from "./client.ts";
import { BROWSER_USER_AGENT } from "./user-agent.ts";
import { getOrgIdFromCookieHeader } from "./organization.ts";

const STYREROMMET_BASE = "https://styrerommet.no";
const CANTOR_BASE = "https://cws.obos.no/cantor";

interface CantorSession {
  cookie: string;
  companyId: string;
  expiresAt: number; // local timestamp estimate (typically 20-30 min)
}

let cachedSession: CantorSession | null = null;

export function getCantorCompanyId(): string {
  return getOrgIdFromCookieHeader(process.env.STYREROMMET_COOKIE) ?? getOrgId();
}

function parseCookieHeader(
  cookieHeader: string | undefined,
): Array<{ name: string; value: string }> {
  if (!cookieHeader) return [];
  return cookieHeader.split(";").flatMap((part) => {
    const equalsAt = part.indexOf("=");
    if (equalsAt <= 0) return [];
    return [
      {
        name: part.slice(0, equalsAt).trim(),
        value: part.slice(equalsAt + 1).trim(),
      },
    ];
  });
}

function cookieHeaderFromMap(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

/**
 * Complete Cantor's OBOS OIDC redirect in the persistent browser profile. The Styrerommet
 * session cookie alone cannot satisfy innlogging.obos.no; its browser-held identity session is
 * required to receive the CWS callback and establish the ASP.NET session.
 */
async function openCantorBrowserSession(companyId: string): Promise<string> {
  if (process.env.NO_AUTO_LOGIN === "true" || process.env.CI === "true") {
    throw new Error(
      "Cantor sign-in requires the saved OBOS browser session. Run the MCP server interactively or unset NO_AUTO_LOGIN/CI.",
    );
  }

  const context = await launchPersistentAuthContext();
  try {
    const existingStyrerommetCookies = await context.cookies(
      "https://styrerommet.no",
    );
    const existingNames = new Set(
      existingStyrerommetCookies.map((cookie) => cookie.name),
    );
    const missingStyrerommetCookies = parseCookieHeader(
      process.env.STYREROMMET_COOKIE,
    )
      .filter((cookie) => !existingNames.has(cookie.name))
      .map((cookie) => ({
        ...cookie,
        domain: ".styrerommet.no",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "Lax" as const,
      }));
    if (missingStyrerommetCookies.length > 0) {
      await context.addCookies(missingStyrerommetCookies);
    }

    const page = context.pages()[0] ?? (await context.newPage());
    const apiUrl = `${CANTOR_BASE}/api/firma/${encodeURIComponent(companyId)}/details`;
    const redirectUrl = `${STYREROMMET_BASE}/redirect/cantor?obosCompanyNumber=${encodeURIComponent(companyId)}`;
    console.error(
      "[auth] Completing Cantor's OBOS sign-in in the saved browser profile...",
    );

    try {
      await page.goto(redirectUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch {
      // Navigation can time out while the identity provider is waiting for a user action.
    }

    const deadline = Date.now() + 5 * 60 * 1000;
    let promptedForLogin = false;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new Error(
          "The browser window closed before Cantor authentication completed.",
        );
      }

      let pageUrl: URL | undefined;
      try {
        pageUrl = new URL(page.url());
      } catch {}

      if (pageUrl?.hostname === "innlogging.obos.no" && !promptedForLogin) {
        promptedForLogin = true;
        console.error(
          "[auth] Complete the OBOS sign-in in the opened browser if prompted.",
        );
      }

      const isCwsPortal =
        pageUrl?.hostname === "cws.obos.no" &&
        !pageUrl.pathname.startsWith("/cantor/api/obos/");
      if (isCwsPortal) {
        const cwsCookies = await context.cookies(apiUrl);
        if (cwsCookies.some((cookie) => cookie.name === "ASP.NET_SessionId")) {
          const response = await context.request.get(apiUrl, {
            headers: {
              accept: "application/json, text/plain, */*",
              referer: "https://cws.obos.no/",
              "user-agent": BROWSER_USER_AGENT,
            },
            maxRedirects: 0,
            timeout: 15_000,
          });
          if (response.ok()) {
            const cookieMap = new Map(
              cwsCookies.map((cookie) => [cookie.name, cookie.value]),
            );
            const sessionCookie = cookieHeaderFromMap(cookieMap);
            console.error(
              `[auth] Cantor browser session established for company ${companyId}.`,
            );
            return sessionCookie;
          }

          throw new Error(
            `Cantor sign-in reached the portal, but its API returned HTTP ${response.status()}.`,
          );
        }
      }

      await page.waitForTimeout(1000);
    }

    throw new Error(
      "Cantor sign-in did not reach the authenticated portal within five minutes. Complete the OBOS sign-in in the browser and retry.",
    );
  } finally {
    await context.close().catch(() => {});
  }
}

const pendingCantorBrowserSessions = new Map<string, Promise<string>>();

function getCantorBrowserSession(companyId: string): Promise<string> {
  const pending = pendingCantorBrowserSessions.get(companyId);
  if (pending) return pending;

  const session = openCantorBrowserSession(companyId);
  pendingCantorBrowserSessions.set(companyId, session);
  void session
    .finally(() => {
      if (pendingCantorBrowserSessions.get(companyId) === session) {
        pendingCantorBrowserSessions.delete(companyId);
      }
    })
    .catch(() => {});
  return session;
}

/**
 * Authenticates against Cantor using Styrerommet SSO redirect ticket.
 */
export async function getCantorSession(
  companyId: string = getCantorCompanyId(),
  forceRefresh = false,
  allowRetry = true,
): Promise<string> {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedSession &&
    cachedSession.companyId === companyId &&
    cachedSession.expiresAt > now
  ) {
    return cachedSession.cookie;
  }

  if (!process.env.STYREROMMET_COOKIE) {
    if (allowRetry) {
      const ok = await promptLoginIfNeeded(
        "STYREROMMET_COOKIE is not configured for Cantor",
      );
      if (ok && process.env.STYREROMMET_COOKIE) {
        return getCantorSession(companyId, forceRefresh, false);
      }
    }
    throw new Error(
      "STYREROMMET_COOKIE environment variable is not set. Please set it in .env or run 'styrerommet-mcp --auth' to access Cantor Web Services.",
    );
  }

  // 1. Request SSO redirect ticket from Styrerommet
  const redirectRes = await fetch(
    `${STYREROMMET_BASE}/redirect/cantor?obosCompanyNumber=${encodeURIComponent(companyId)}`,
    {
      method: "GET",
      headers: {
        cookie: process.env.STYREROMMET_COOKIE,
        "user-agent": BROWSER_USER_AGENT,
      },
      redirect: "manual",
    },
  );

  const location = redirectRes.headers.get("location");
  if (location) {
    const redirectUrl = new URL(location, STYREROMMET_BASE);
    if (
      redirectUrl.hostname === "cws.obos.no" &&
      redirectUrl.pathname.toLowerCase() === "/cantor/api/obos/login"
    ) {
      const sessionCookie = await getCantorBrowserSession(companyId);
      cachedSession = {
        cookie: sessionCookie,
        companyId,
        expiresAt: Date.now() + 15 * 60 * 1000,
      };
      return sessionCookie;
    }
  }

  const isAuthError =
    redirectRes.status === 401 ||
    redirectRes.status === 403 ||
    (location &&
      (location.includes("/login") || location.includes("innlogging.obos.no")));

  if (isAuthError && allowRetry) {
    console.error(
      "[auth] Cantor SSO session expired. Triggering interactive login...",
    );
    const ok = await promptLoginIfNeeded("Cantor SSO session expired");
    if (ok) {
      return getCantorSession(companyId, true, false);
    }
  }

  if (!location) {
    const body = await redirectRes.text().catch(() => "");
    throw new Error(
      `Failed to obtain Cantor SSO ticket from Styrerommet (status ${redirectRes.status}): ${body.slice(0, 200)}`,
    );
  }

  // 2. Follow ticket exchange to establish Cantor ASP.NET session
  let currentUrl = location;
  const cookies = new Map<string, string>();

  for (let i = 0; i < 5; i++) {
    const res = await fetch(currentUrl, {
      method: "GET",
      headers: {
        cookie: cookieHeaderFromMap(cookies),
        "user-agent": BROWSER_USER_AGENT,
      },
      redirect: "manual",
    });

    const setCookies = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [];
    for (const sc of setCookies) {
      if (sc) {
        const part = sc.split(";")[0];
        if (!part) continue;
        const equalsAt = part.indexOf("=");
        if (equalsAt > 0) {
          cookies.set(part.slice(0, equalsAt), part.slice(equalsAt + 1));
        }
      }
    }

    const nextLoc = res.headers.get("location");
    if (nextLoc && [301, 302, 303, 307].includes(res.status)) {
      currentUrl = new URL(nextLoc, currentUrl).href;
    } else {
      break;
    }
  }

  const sessionCookie = cookieHeaderFromMap(cookies);
  if (!cookies.has("ASP.NET_SessionId")) {
    throw new Error(
      `Failed to establish Cantor session: ASP.NET_SessionId not found. Cookies received: ${[...cookies.keys()].join(", ") || "none"}`,
    );
  }

  cachedSession = {
    cookie: sessionCookie,
    companyId,
    expiresAt: now + 15 * 60 * 1000, // 15 min cache TTL
  };

  return sessionCookie;
}

/**
 * Executes a strictly read-only GET request to the Cantor backend API.
 * Automatically retries once with a fresh session if a 401/403 or redirect occurs.
 */
async function cantorGet<T>(
  path: string,
  queryParams: Record<
    string,
    string | number | boolean | undefined | null
  > = {},
  companyId: string = getCantorCompanyId(),
): Promise<T> {
  const execute = async (
    sessionCookie: string,
  ): Promise<{ ok: boolean; status: number; data?: T; redirect?: boolean }> => {
    const url = new URL(
      path.startsWith("http")
        ? path
        : `${CANTOR_BASE}${path.startsWith("/") ? "" : "/"}${path}`,
    );
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        cookie: sessionCookie,
        accept: "application/json, text/plain, */*",
        referer: "https://cws.obos.no/",
        "user-agent": BROWSER_USER_AGENT,
      },
      redirect: "manual",
    });

    if ([301, 302, 303, 307].includes(res.status)) {
      return { ok: false, status: res.status, redirect: true };
    }

    if (!res.ok) {
      return { ok: false, status: res.status };
    }

    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  };

  let session = await getCantorSession(companyId);
  let res = await execute(session);

  if (!res.ok && (res.status === 401 || res.status === 403 || res.redirect)) {
    // Session expired or redirected back to login, refresh session once
    session = await getCantorSession(companyId, true);
    res = await execute(session);
  }

  if (!res.ok || res.data === undefined) {
    throw new Error(
      `Cantor API GET ${path} failed with HTTP status ${res.status}`,
    );
  }

  return res.data;
}

// -------------------- Public API Methods (Strictly Read-Only) --------------------

export interface CantorCompanyDetails {
  organisasjonsnummer: string;
  firmanavn: string;
  valuta: string;
  rapportansvarlig: string;
  naringsadresse?: string;
  postadresse?: string;
  telefon?: string;
  epost?: string;
  regnskapsforerNavn?: string;
}

export interface CantorDropdowns {
  years: Array<{ id: number; name: string }>;
  periods: Array<{ id: number; name: string; isDefault: boolean }>;
  units: Array<{ id: number; name: string }>;
}

export interface CantorCompanyInfo {
  details: CantorCompanyDetails;
  availableYears: number[];
  availablePeriods: Array<{ id: number; name: string }>;
  units: Array<{ id: number; name: string }>;
}

/**
 * Returns master company information and available fiscal years and periods.
 */
export async function getCantorCompanyInfo(
  companyId: string = getCantorCompanyId(),
): Promise<CantorCompanyInfo> {
  const [details, dropdowns] = await Promise.all([
    cantorGet<CantorCompanyDetails>(
      `/api/firma/${companyId}/details`,
      {},
      companyId,
    ),
    cantorGet<CantorDropdowns>(
      `/api/maindropdowns/${companyId}`,
      {},
      companyId,
    ),
  ]);

  return {
    details,
    availableYears: (dropdowns.years || []).map((y) => y.id),
    availablePeriods: (dropdowns.periods || []).map((p) => ({
      id: p.id,
      name: p.name,
    })),
    units: dropdowns.units || [],
  };
}

export interface CantorAccountRow {
  kontonr: string;
  kontonavn: string;
  virkelig: number;
  rap1?: string | undefined;
  rap2?: string | undefined;
  rap3?: string | undefined;
  rap4?: string | undefined;
  rap5?: string | undefined;
  kontotype?: string | undefined;
  konsKonto?: string | undefined;
}

/**
 * Returns the full chart of accounts (Kontoplan) for the cooperative.
 */
export async function getCantorChartOfAccounts(
  companyId: string = getCantorCompanyId(),
  options: {
    year?: number | undefined;
    period?: number | undefined;
    oppsettId?: string | undefined;
  } = {},
): Promise<{
  oppsettId: string;
  displayName: string;
  accounts: CantorAccountRow[];
}> {
  const year = options.year || new Date().getFullYear();
  const period = options.period || 12;

  let oppsettId = options.oppsettId;
  if (!oppsettId) {
    const setups = await cantorGet<Array<{ id: string; displayName: string }>>(
      `/api/firma/${companyId}/kontoplan-oppsett`,
      {},
      companyId,
    );
    oppsettId = setups?.[0]?.id || "rapportering";
  }

  const data = await cantorGet<{
    oppsettId: string;
    displayName: string;
    rows: Array<Array<string | number>>;
    columns: Array<{ id: number; displayName: string }>;
  }>(
    `/api/ui/firma/${companyId}/kontoplan`,
    {
      oppsettId,
      aar: year,
      periode: period,
    },
    companyId,
  );

  const accounts: CantorAccountRow[] = (data.rows || []).map((r) => ({
    kontonr: String(r[0] ?? ""),
    kontonavn: String(r[1] ?? ""),
    virkelig: typeof r[2] === "number" ? r[2] : parseFloat(String(r[2] || "0")),
    rap1: r[3] ? String(r[3]) : undefined,
    rap2: r[4] ? String(r[4]) : undefined,
    rap3: r[5] ? String(r[5]) : undefined,
    rap4: r[6] ? String(r[6]) : undefined,
    rap5: r[7] ? String(r[7]) : undefined,
    kontotype: r[8] ? String(r[8]) : undefined,
    konsKonto: r[9] ? String(r[9]) : undefined,
  }));

  return {
    oppsettId: data.oppsettId,
    displayName: data.displayName,
    accounts,
  };
}

export interface CantorTrialBalanceItem {
  kontonr: string;
  kontonavn: string;
  konsKonto?: string | undefined;
  virkeligIAr: number;
  virkeligIFjor: number;
  endringIAr: number;
  prognoseIAr: number;
  kommentarer?: string | undefined;
}

/**
 * Parses numeric strings formatted with commas/spaces like "3,337,232.98" or "-455,077.22"
 */
function parseCantorNumber(val: unknown): number {
  if (typeof val === "number") return val;
  if (!val) return 0;
  const str = String(val).replace(/\s+/g, "").replace(/,/g, "");
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

/**
 * Returns trial balance (saldobalanse) for a given year and period.
 */
export async function getCantorTrialBalance(
  companyId: string = getCantorCompanyId(),
  options: {
    year?: number | undefined;
    period?: number | undefined;
    unit?: number | undefined;
    yearToDate?: boolean | undefined;
    resultOnly?: boolean | undefined;
    inUseOnly?: boolean | undefined;
  } = {},
): Promise<{
  year: number;
  period: number;
  yearToDate: boolean;
  lines: CantorTrialBalanceItem[];
}> {
  const year = options.year || new Date().getFullYear();
  const period = options.period || 12;
  const unit = options.unit || 1;
  const hittil = options.yearToDate !== false;
  const kunResultat = options.resultOnly === true;
  const kunKontiIBruk = options.inUseOnly !== false;

  const data = await cantorGet<{
    data: {
      columns: Array<Array<{ name: string; dataType: string }>>;
      rows: Array<{ values: string[]; subRows: unknown }>;
    };
  }>(
    `/api/firma/${companyId}/saldobalanse`,
    {
      aar: year,
      periode: period,
      unit,
      kunResultat,
      kunKontiIBruk,
      hittil,
    },
    companyId,
  );

  const rows = data?.data?.rows || [];
  const lines: CantorTrialBalanceItem[] = rows.map((r) => {
    const v = r.values || [];
    return {
      kontonr: v[0] || "",
      kontonavn: v[1] || "",
      konsKonto: v[2] || undefined,
      virkeligIAr: parseCantorNumber(v[3]),
      virkeligIFjor: parseCantorNumber(v[4]),
      endringIAr: parseCantorNumber(v[5]),
      prognoseIAr: parseCantorNumber(v[6]),
      kommentarer: v[7] || undefined,
    };
  });

  return {
    year,
    period,
    yearToDate: hittil,
    lines,
  };
}

export interface CantorBudgetLine {
  kontonr: string;
  kontonavn: string;
  sumBud: number;
  monthlyBudgets: number[];
  budsjettIFjor: number;
  virkeligIFjor: number;
  prognoseIFjor: number;
  ltm: number;
  budType?: number | undefined;
  comment?: string | undefined;
  subComment?: string | undefined;
}

export interface CantorBudgetResult {
  year: number;
  period: number;
  formType: number;
  budgetIsLocked: boolean;
  lines: CantorBudgetLine[];
}

/**
 * Returns corporate budget (budsjett) for the specified year.
 */
export async function getCantorBudget(
  companyId: string = getCantorCompanyId(),
  options: {
    year?: number | undefined;
    period?: number | undefined;
    includeZeroLines?: boolean | undefined;
  } = {},
): Promise<CantorBudgetResult> {
  const year = options.year || new Date().getFullYear();
  const period = options.period || 12;

  const data = await cantorGet<{
    budgetYear: number;
    formType: number;
    budgetIsLocked: boolean;
    lines: Array<{
      kontonr: string;
      text: string;
      comment?: string;
      subComment?: string;
      sumBud?: { value: number };
      budgets?: Array<{ value: number }>;
      budsjettIFjor?: number;
      virkeligIFjor?: number;
      prognoseIFjor?: number;
      ltm?: number;
      budType?: { value: number };
    }>;
  }>(
    "/api/budget",
    {
      firmanr: companyId,
      year,
      periodId: period,
      dim1: 0,
      dim2: 0,
      dim3: 0,
    },
    companyId,
  );

  const rawLines = data?.lines || [];
  const lines: CantorBudgetLine[] = [];

  for (const l of rawLines) {
    if (!l.kontonr || l.kontonr === "0") continue;

    const sumBud = l.sumBud?.value || 0;
    const monthlyBudgets = (l.budgets || []).map((b) => b.value || 0);
    const budsjettIFjor = l.budsjettIFjor || 0;
    const virkeligIFjor = l.virkeligIFjor || 0;
    const prognoseIFjor = l.prognoseIFjor || 0;
    const ltm = l.ltm || 0;

    const isNonZero =
      sumBud !== 0 ||
      budsjettIFjor !== 0 ||
      virkeligIFjor !== 0 ||
      prognoseIFjor !== 0 ||
      ltm !== 0 ||
      monthlyBudgets.some((m) => m !== 0);

    if (!options.includeZeroLines && !isNonZero) {
      continue;
    }

    lines.push({
      kontonr: l.kontonr,
      kontonavn: l.text,
      sumBud,
      monthlyBudgets,
      budsjettIFjor,
      virkeligIFjor,
      prognoseIFjor,
      ltm,
      budType: l.budType?.value,
      comment: l.comment || undefined,
      subComment: l.subComment || undefined,
    });
  }

  return {
    year: data.budgetYear || year,
    period,
    formType: data.formType,
    budgetIsLocked: !!data.budgetIsLocked,
    lines,
  };
}

export interface CantorBudgetSpecLine {
  lineNo: number;
  text: string;
  sumBud: number;
  monthlyBudgets: number[];
}

/**
 * Returns detailed sub-lines / specifications for a budget account.
 */
export async function getCantorBudgetSpecs(
  companyId: string = getCantorCompanyId(),
  kontonr: string,
  options: {
    year?: number | undefined;
    period?: number | undefined;
    formType?: number | undefined;
  } = {},
): Promise<{
  kontonr: string;
  year: number;
  lines: CantorBudgetSpecLine[];
}> {
  const year = options.year || new Date().getFullYear();
  const period = options.period || 12;
  const formType = options.formType ?? 1;

  const data = await cantorGet<{
    lines?: Array<{
      lineNo: number;
      text: string;
      sumBud?: { value: number };
      budgets?: Array<{ value: number }>;
    }>;
  }>(
    "/api/budgetSpecsData",
    {
      firmanr: companyId,
      year,
      formType,
      periodId: period,
      dim1: 0,
      dim2: 0,
      dim3: 0,
      account: kontonr,
    },
    companyId,
  );

  const lines: CantorBudgetSpecLine[] = (data?.lines || []).map((l) => ({
    lineNo: l.lineNo,
    text: l.text,
    sumBud: l.sumBud?.value || 0,
    monthlyBudgets: (l.budgets || []).map((b) => b.value || 0),
  }));

  return {
    kontonr,
    year,
    lines,
  };
}

export interface CantorDashboardTable {
  title: string;
  subTitle?: string | undefined;
  headers: string[];
  rows: Array<{ label: string; cells: string[] }>;
}

/**
 * Returns financial dashboard widgets (e.g. 150: Resultat, 140: Balanse, 126: Likviditetsendring).
 */
export async function getCantorDashboard(
  companyId: string = getCantorCompanyId(),
  options: {
    year?: number | undefined;
    period?: number | undefined;
    widgetId?: number | undefined;
    unitId?: number | undefined;
  } = {},
): Promise<CantorDashboardTable[]> {
  const year = options.year || new Date().getFullYear();
  const period = options.period || 9;
  const widgetId = options.widgetId ?? 150; // Default: Resultat boligselskaper
  const unitId = options.unitId || 1;

  const data = await cantorGet<{
    id: number;
    title: string;
    subTitle?: string;
    tables?: Array<{
      rows: Array<{
        isHeader?: boolean;
        cells: Array<{ text: string; isNumber: boolean }> | null;
      }>;
    }>;
  }>(
    `/api/dashboarddata/${companyId}/${year}/${period}/${widgetId}`,
    {
      unitId,
      widgetId: -1,
      widgetType: 1,
    },
    companyId,
  );

  const results: CantorDashboardTable[] = [];
  const tables = data?.tables || [];

  for (const t of tables) {
    const rows = t.rows || [];
    let headers: string[] = [];
    const formattedRows: Array<{ label: string; cells: string[] }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r.cells || r.cells.length === 0) continue;
      const texts = r.cells.map((c) => (c?.text || "").trim());

      if (i === 0 && !texts[0]) {
        // First row usually has column headers
        headers = texts.slice(1).filter(Boolean);
        continue;
      }

      if (texts.length > 0) {
        formattedRows.push({
          label: texts[0] || "",
          cells: texts.slice(1),
        });
      }
    }

    results.push({
      title: data.title || `Widget ${widgetId}`,
      subTitle: data.subTitle || undefined,
      headers,
      rows: formattedRows,
    });
  }

  return results;
}

export interface CantorMonthlyActualsLine {
  kontonr: string;
  kontonavn: string;
  monthlyActuals: number[];
  virkeligIAar: number;
  ltm: number;
  budsjettIAar: number;
  budsjettIFjor: number;
}

/**
 * Returns month-by-month (months 1-12) actual costs/revenues and LTM (Last Twelve Months) rolling total per account.
 */
export async function getCantorMonthlyActuals(
  companyId: string = getCantorCompanyId(),
  options: {
    year?: number | undefined;
    period?: number | undefined;
    includeZeroLines?: boolean | undefined;
  } = {},
): Promise<{
  year: number;
  period: number;
  lines: CantorMonthlyActualsLine[];
}> {
  const year = options.year || new Date().getFullYear();
  const period = options.period || 9;

  const data = await cantorGet<{
    lines?: Array<{
      LineNo: number;
      Kontonr: string;
      Kontonavn: string;
      Bel1?: number;
      Bel2?: number;
      Bel3?: number;
      Bel4?: number;
      Bel5?: number;
      Bel6?: number;
      Bel7?: number;
      Bel8?: number;
      Bel9?: number;
      Bel10?: number;
      Bel11?: number;
      Bel12?: number;
      BudsjettIAar?: number;
      BudsjettIFjor?: number;
      VirkeligIAar?: number;
      LTM?: number;
    }>;
  }>(
    "/api/forecast",
    {
      firmanr: companyId,
      year,
      periodId: period,
    },
    companyId,
  );

  const rawLines = data?.lines || [];
  const lines: CantorMonthlyActualsLine[] = [];

  for (const l of rawLines) {
    if (!l.Kontonr || l.Kontonr === "0") continue;

    const monthlyActuals = [
      l.Bel1 || 0,
      l.Bel2 || 0,
      l.Bel3 || 0,
      l.Bel4 || 0,
      l.Bel5 || 0,
      l.Bel6 || 0,
      l.Bel7 || 0,
      l.Bel8 || 0,
      l.Bel9 || 0,
      l.Bel10 || 0,
      l.Bel11 || 0,
      l.Bel12 || 0,
    ];

    const virkeligIAar = l.VirkeligIAar || 0;
    const ltm = l.LTM || 0;
    const budsjettIAar = l.BudsjettIAar || 0;
    const budsjettIFjor = l.BudsjettIFjor || 0;

    const hasValues =
      virkeligIAar !== 0 ||
      ltm !== 0 ||
      budsjettIAar !== 0 ||
      budsjettIFjor !== 0 ||
      monthlyActuals.some((v) => v !== 0);

    if (!options.includeZeroLines && !hasValues) {
      continue;
    }

    lines.push({
      kontonr: l.Kontonr,
      kontonavn: l.Kontonavn,
      monthlyActuals,
      virkeligIAar,
      ltm,
      budsjettIAar,
      budsjettIFjor,
    });
  }

  return {
    year,
    period,
    lines,
  };
}

export interface CantorFelleskostnaderForecast {
  accountNumber: string;
  accountName: string;
  calculatedAnnualIncreasePercent: number;
  lines: Array<{
    year: string;
    calculatedForecast: number;
    adjustment: number;
    newForecast: number;
    yearChangePercent: number;
  }>;
  guidanceText?: string | undefined;
}

/**
 * Returns OBOS's future common costs (felleskostnader) multi-year forecast and recommended increase rate.
 */
export async function getCantorFelleskostnaderForecast(
  companyId: string = getCantorCompanyId(),
  options: {
    year?: number | undefined;
  } = {},
): Promise<CantorFelleskostnaderForecast> {
  const year = options.year || new Date().getFullYear();

  const data = await cantorGet<{
    accountNumber: string;
    accountName: string;
    calculatedForecast: number;
    lines?: Array<{
      year: string;
      calculatedForecast: number;
      adjustment: number;
      newForecast: number;
      yearChange: number;
    }>;
    texts?: string[];
  }>(
    "/api/forecastobos",
    {
      firmanr: companyId,
      year,
    },
    companyId,
  );

  return {
    accountNumber: data.accountNumber,
    accountName: data.accountName,
    calculatedAnnualIncreasePercent: data.calculatedForecast,
    lines: (data.lines || []).map((l) => ({
      year: l.year,
      calculatedForecast: l.calculatedForecast,
      adjustment: l.adjustment,
      newForecast: l.newForecast,
      yearChangePercent: l.yearChange,
    })),
    guidanceText: data.texts?.[8] || undefined,
  };
}

export interface CantorWidgetInfo {
  widgetDataId: number;
  name: string;
  widgetType: number;
  widgetDataType: string;
}

/**
 * Returns the full catalog of executive dashboard widgets available in Cantor.
 */
export async function getCantorDashboardWidgets(
  companyId: string = getCantorCompanyId(),
  options: {
    year?: number | undefined;
    period?: number | undefined;
  } = {},
): Promise<CantorWidgetInfo[]> {
  const year = options.year || new Date().getFullYear();
  const period = options.period || 9;

  const data = await cantorGet<{
    widgetIds?: Array<{
      widgetDataId: number;
      name: string;
      widgetType: number;
      WidgetDataType: string;
    }>;
  }>(
    "/api/dashboarddataIds",
    {
      firmanr: companyId,
      year,
      period,
    },
    companyId,
  );

  const list = data?.widgetIds || [];
  return list.map((w) => ({
    widgetDataId: w.widgetDataId,
    name: w.name,
    widgetType: w.widgetType,
    widgetDataType: w.WidgetDataType,
  }));
}

export interface CantorDimensionInfo {
  dimNr: number;
  navn: string;
  sumNiva: boolean;
}

/**
 * Returns active accounting dimensions configured for the cooperative.
 */
export async function getCantorDimensions(
  companyId: string = getCantorCompanyId(),
): Promise<CantorDimensionInfo[]> {
  const data = await cantorGet<
    Array<{
      dimNr: number;
      navn: string;
      sumNiva: boolean;
    }>
  >(`/api/firma/${companyId}/dimensjoner`, {}, companyId);

  return Array.isArray(data) ? data : [];
}

export interface CantorAccountComment {
  id: number;
  authorId: number;
  authorName: string;
  text: string;
  creationTime: string;
  editable: boolean;
  dimensionTags?: string | undefined;
}

export interface CantorAccountCommentsGroup {
  kontonr: string;
  kontonavn?: string | undefined;
  commentCount: number;
  comments: CantorAccountComment[];
}

export interface CantorAccountCommentsResult {
  year: number;
  period: number;
  source: "saldobalanse" | "budget";
  accountCount: number;
  totalComments: number;
  accounts: CantorAccountCommentsGroup[];
}

/**
 * Returns account comments and discussion notes from Cantor saldobalanse or budget.
 * If account is specified, returns comments for that specific account.
 * If account is omitted, discovers all accounts that have comments for the given year/period and returns them.
 */
export async function getCantorAccountComments(
  companyId: string = getCantorCompanyId(),
  options: {
    account?: string | undefined;
    year?: number | undefined;
    period?: number | undefined;
    source?: "saldobalanse" | "budget" | undefined;
    yearToDate?: boolean | undefined;
    dim1?: string | undefined;
  } = {},
): Promise<CantorAccountCommentsResult> {
  const year = options.year || new Date().getFullYear();
  const period = options.period || 12;
  const source = options.source || "saldobalanse";

  if (options.account && options.account.toLowerCase() !== "all") {
    const acc = options.account.trim();
    if (source === "budget") {
      const data = await cantorGet<{
        Texts?: string[];
        Kommentar?: Array<{
          Id?: number;
          BrukerID?: number;
          Brukernavn?: string;
          Kommentar?: string;
          SistEndret?: string;
          Editable?: boolean;
        }>;
      }>(
        "/api/budgetComment",
        {
          firmanr: companyId,
          year,
          formType: 1,
          kontonr: acc,
          dim1: options.dim1 || "",
        },
        companyId,
      );

      const raw = Array.isArray(data?.Kommentar) ? data.Kommentar : [];
      const comments: CantorAccountComment[] = raw.map((c) => ({
        id: c.Id ?? 0,
        authorId: c.BrukerID ?? 0,
        authorName: c.Brukernavn ?? "",
        text: c.Kommentar ?? "",
        creationTime: c.SistEndret ?? "",
        editable: !!c.Editable,
      }));

      return {
        year,
        period,
        source: "budget",
        accountCount: 1,
        totalComments: comments.length,
        accounts: [
          {
            kontonr: acc,
            commentCount: comments.length,
            comments,
          },
        ],
      };
    } else {
      // saldobalanse
      const data = await cantorGet<{
        Texts?: string[];
        Tema?: Array<{
          id?: number;
          brukerId?: number;
          brukerNavn?: string;
          text?: string;
          creationTime?: string;
          editable?: boolean;
          dimValues?: Array<{ dimNr: string; dimValue: string }>;
        }>;
      }>(
        `/api/firma/${companyId}/saldobalanse/konto/${encodeURIComponent(acc)}/kommentar`,
        {
          aar: year,
          kontoNr: acc,
          periode: period,
          hittil: options.yearToDate !== false,
        },
        companyId,
      );

      const raw = Array.isArray(data?.Tema) ? data.Tema : [];
      const comments: CantorAccountComment[] = raw.map((t) => {
        let dimensionTags: string | undefined;
        if (Array.isArray(t.dimValues) && t.dimValues.length > 0) {
          dimensionTags = t.dimValues
            .map((d) => `${d.dimNr}:${d.dimValue}`)
            .join(" ");
        }
        return {
          id: t.id ?? 0,
          authorId: t.brukerId ?? 0,
          authorName: t.brukerNavn ?? "",
          text: t.text ?? "",
          creationTime: t.creationTime ?? "",
          editable: !!t.editable,
          dimensionTags,
        };
      });

      return {
        year,
        period,
        source: "saldobalanse",
        accountCount: 1,
        totalComments: comments.length,
        accounts: [
          {
            kontonr: acc,
            commentCount: comments.length,
            comments,
          },
        ],
      };
    }
  }

  // If no specific account was requested, scan for accounts with comments
  if (source === "budget") {
    const budget = await getCantorBudget(companyId, { year, period });
    const targetLines = budget.lines.filter(
      (l) => l.comment && l.comment !== "0" && l.comment.trim() !== "",
    );

    const accounts: CantorAccountCommentsGroup[] = await Promise.all(
      targetLines.map(async (l) => {
        try {
          const data = await cantorGet<{
            Kommentar?: Array<{
              Id?: number;
              BrukerID?: number;
              Brukernavn?: string;
              Kommentar?: string;
              SistEndret?: string;
              Editable?: boolean;
            }>;
          }>(
            "/api/budgetComment",
            {
              firmanr: companyId,
              year,
              formType: 1,
              kontonr: l.kontonr,
              dim1: options.dim1 || "",
            },
            companyId,
          );
          const raw = Array.isArray(data?.Kommentar) ? data.Kommentar : [];
          const comments: CantorAccountComment[] = raw.map((c) => ({
            id: c.Id ?? 0,
            authorId: c.BrukerID ?? 0,
            authorName: c.Brukernavn ?? "",
            text: c.Kommentar ?? "",
            creationTime: c.SistEndret ?? "",
            editable: !!c.Editable,
          }));
          return {
            kontonr: l.kontonr,
            kontonavn: l.kontonavn,
            commentCount: comments.length,
            comments,
          };
        } catch {
          return {
            kontonr: l.kontonr,
            kontonavn: l.kontonavn,
            commentCount: 0,
            comments: [],
          };
        }
      }),
    );

    const totalComments = accounts.reduce((acc, a) => acc + a.commentCount, 0);
    return {
      year,
      period,
      source: "budget",
      accountCount: accounts.length,
      totalComments,
      accounts,
    };
  } else {
    const tb = await getCantorTrialBalance(companyId, {
      year,
      period,
      yearToDate: options.yearToDate !== false,
    });
    const targetLines = tb.lines.filter(
      (l) =>
        l.kommentarer && l.kommentarer !== "0" && l.kommentarer.trim() !== "",
    );

    const accounts: CantorAccountCommentsGroup[] = await Promise.all(
      targetLines.map(async (l) => {
        try {
          const data = await cantorGet<{
            Tema?: Array<{
              id?: number;
              brukerId?: number;
              brukerNavn?: string;
              text?: string;
              creationTime?: string;
              editable?: boolean;
              dimValues?: Array<{ dimNr: string; dimValue: string }>;
            }>;
          }>(
            `/api/firma/${companyId}/saldobalanse/konto/${encodeURIComponent(l.kontonr)}/kommentar`,
            {
              aar: year,
              kontoNr: l.kontonr,
              periode: period,
              hittil: options.yearToDate !== false,
            },
            companyId,
          );
          const raw = Array.isArray(data?.Tema) ? data.Tema : [];
          const comments: CantorAccountComment[] = raw.map((t) => {
            let dimensionTags: string | undefined;
            if (Array.isArray(t.dimValues) && t.dimValues.length > 0) {
              dimensionTags = t.dimValues
                .map((d) => `${d.dimNr}:${d.dimValue}`)
                .join(" ");
            }
            return {
              id: t.id ?? 0,
              authorId: t.brukerId ?? 0,
              authorName: t.brukerNavn ?? "",
              text: t.text ?? "",
              creationTime: t.creationTime ?? "",
              editable: !!t.editable,
              dimensionTags,
            };
          });
          return {
            kontonr: l.kontonr,
            kontonavn: l.kontonavn,
            commentCount: comments.length,
            comments,
          };
        } catch {
          return {
            kontonr: l.kontonr,
            kontonavn: l.kontonavn,
            commentCount: 0,
            comments: [],
          };
        }
      }),
    );

    const totalComments = accounts.reduce((acc, a) => acc + a.commentCount, 0);
    return {
      year,
      period,
      source: "saldobalanse",
      accountCount: accounts.length,
      totalComments,
      accounts,
    };
  }
}
