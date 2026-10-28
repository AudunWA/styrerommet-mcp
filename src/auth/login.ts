import { chromium } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getOrgIdFromCookieHeader,
  getOrgIdFromRequestUrl,
} from "../organization.ts";

const __filename = fileURLToPath(import.meta.url);
import { getDataDirectory, getEnvPath } from "../config.ts";

export function getPersistentAuthProfileDir(): string {
  const override = process.env.STYREROMMET_AUTH_PROFILE_DIR?.trim();
  return override
    ? path.resolve(override)
    : path.join(getDataDirectory(), "auth-profile");
}

/** Read expiry for refresh decisions; token authenticity is checked by the service. */
export function getJwtExpiresAt(token: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Open the dedicated persistent profile used by interactive authentication.
 * Keeping this shared lets services that use OBOS SSO reuse the same IdP session.
 */
export async function launchPersistentAuthContext() {
  const configuredChannel = process.env.STYREROMMET_BROWSER_CHANNEL?.trim();
  const candidateChannels = configuredChannel
    ? [configuredChannel]
    : ["chrome", "msedge", "chrome-beta"];
  const candidateMacPaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Arc.app/Contents/MacOS/Arc",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  const candidateLinuxPaths = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/brave-browser",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ];
  const candidateWindowsPaths = [
    path.join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      process.env.PROGRAMFILES || "C:\\Program Files",
      "BraveSoftware",
      "Brave-Browser",
      "Application",
      "brave.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "BraveSoftware",
      "Brave-Browser",
      "Application",
      "brave.exe",
    ),
  ];

  const userDataDir = getPersistentAuthProfileDir();
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(userDataDir, 0o700);

  const launchOptions = {
    headless: false,
    // Playwright otherwise adds --no-sandbox by default. Keep the browser sandbox
    // enabled while handling the user's OBOS authentication session.
    chromiumSandbox: true,
    args: ["--no-first-run", "--no-default-browser-check"],
    viewport: { width: 1200, height: 900 },
  };

  let context:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  const executableOverride = process.env.STYREROMMET_BROWSER_EXECUTABLE?.trim();
  if (executableOverride) {
    context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      executablePath: path.resolve(executableOverride),
    });
  }

  for (const channel of context ? [] : candidateChannels) {
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        channel,
      });
      break;
    } catch {}
  }

  if (!context) {
    const directPaths =
      process.platform === "darwin"
        ? candidateMacPaths
        : process.platform === "win32"
          ? candidateWindowsPaths
          : candidateLinuxPaths;
    for (const exePath of directPaths) {
      if (fs.existsSync(exePath)) {
        try {
          context = await chromium.launchPersistentContext(userDataDir, {
            ...launchOptions,
            executablePath: exePath,
          });
          break;
        } catch {}
      }
    }
  }

  if (!context) {
    throw new Error(
      "No supported browser could open the persistent authentication profile. Close other MCP login windows and ensure Chrome, Edge, Brave, or Arc is installed.",
    );
  }

  return context;
}

export interface LoginResult {
  success: boolean;
  message: string;
  updatedKeys: string[];
}

let activeLoginPromise: Promise<LoginResult> | null = null;

/**
 * Prompt interactive login if credentials are missing or expired.
 * Deduplicates multiple concurrent calls using an active promise.
 * Outputs diagnostics strictly to stderr so MCP stdio transport is preserved.
 */
export async function promptLoginIfNeeded(reason?: string): Promise<boolean> {
  if (activeLoginPromise) {
    const res = await activeLoginPromise;
    return res.success;
  }

  // Allow disabling auto-prompting in headless/CI environments
  if (process.env.NO_AUTO_LOGIN === "true" || process.env.CI === "true") {
    console.error(
      `[auth] Auto-login skipped (NO_AUTO_LOGIN/CI set). Reason: ${reason || "credentials missing"}`,
    );
    return false;
  }

  console.error(
    `\n[auth] 🔐 ${reason || "Authentication needed"}. Launching browser for login...`,
  );
  activeLoginPromise = runInteractiveLogin();
  try {
    const result = await activeLoginPromise;
    console.error(
      `[auth] ✅ Login successful! Updated keys: ${result.updatedKeys.join(", ")}\n`,
    );
    return result.success;
  } catch (err: any) {
    console.error(`[auth] ❌ Login failed or cancelled: ${err.message}\n`);
    return false;
  } finally {
    activeLoginPromise = null;
  }
}

/**
 * Safely update or append keys in a .env file while preserving existing lines and comments.
 */
export function updateEnvFile(updates: Record<string, string>): string[] {
  const ENV_PATH = getEnvPath();
  let envContent = "";
  if (fs.existsSync(ENV_PATH)) {
    envContent = fs.readFileSync(ENV_PATH, "utf-8");
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) {
      throw new Error("Invalid credential file key or multiline value");
    }
  }
  const quoteValue = (value: string): string => {
    const quote = ['"', "'", "`"].find(
      (delimiter) => !value.includes(delimiter),
    );
    if (!quote)
      throw new Error(
        "Credential value contains every supported quote delimiter",
      );
    return `${quote}${value}${quote}`;
  };
  const lines = envContent.split("\n");
  const updatedKeys: string[] = [];
  const handledKeys = new Set<string>();

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) return line;
    const key = line.slice(0, eqIdx).trim();
    if (key in updates) {
      handledKeys.add(key);
      updatedKeys.push(key);
      const val = updates[key] ?? "";
      return `${key}=${quoteValue(val)}`;
    }
    return line;
  });

  // Append any keys that weren't already present in .env
  for (const [key, rawVal] of Object.entries(updates)) {
    if (!handledKeys.has(key)) {
      const val = rawVal ?? "";
      newLines.push(`${key}=${quoteValue(val)}`);
      updatedKeys.push(key);
    }
  }

  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ENV_PATH, newLines.join("\n"), {
    encoding: "utf-8",
    mode: 0o600,
  });
  if (process.platform !== "win32") fs.chmodSync(ENV_PATH, 0o600);
  return updatedKeys;
}

/**
 * Format a list of Playwright cookies into a standard Cookie header string.
 */
function formatCookieHeader(
  cookies: Array<{ name: string; value: string }>,
): string {
  return cookies
    .map((c) => {
      // Strip outer double quotes if present in value to prevent malforming .env
      const cleanVal =
        c.value.startsWith('"') && c.value.endsWith('"')
          ? c.value.slice(1, -1)
          : c.value;
      return `${c.name}=${cleanVal}`;
    })
    .join("; ");
}

/**
 * Run interactive browser authentication for Styrerommet, Arkiv, Vibbo, and Mitt Bygg.
 */
export async function runInteractiveLogin(
  target: "all" | "mittbygg" = "all",
): Promise<LoginResult> {
  const configuredOrgId =
    process.env.STYREROMMET_ORG_ID?.trim() ||
    getOrgIdFromCookieHeader(process.env.STYREROMMET_COOKIE);
  let orgId = configuredOrgId || "";
  const configuredVibboOrgSlug = process.env.VIBBO_ORG_SLUG?.trim();
  let orgSlug = "";

  if (target === "mittbygg" && !orgId) {
    throw new Error(
      "Set STYREROMMET_ORG_ID or provide a Styrerommet session cookie before signing in to Mitt Bygg.",
    );
  }

  console.error("\n========================================================");
  if (target === "mittbygg") {
    console.error("  OBOS MITT BYGG INTERACTIVE LOGIN");
    console.error("========================================================");
    console.error(
      "Launching your installed browser (Chrome / Edge / Brave / Arc)...",
    );
    console.error(
      "Please log in using BankID or Vipps in the opened browser window.\n",
    );
  } else {
    console.error("  STYREROMMET, VIBBO & MITT BYGG INTERACTIVE LOGIN");
    console.error("========================================================");
    console.error(
      "Launching your installed browser (Chrome / Edge / Brave / Arc)...",
    );
    console.error(
      "Please log in using Vipps, BankID, or phone number in the opened browser window.\n",
    );
  }

  // Reuse a dedicated profile so Vipps/OBOS SSO browser cookies survive between logins.
  const context = await launchPersistentAuthContext();

  console.error(
    "Using the saved browser profile to reuse Vipps/OBOS sign-in state when available.",
  );

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    let styrerommetCookieStr = "";
    let arkivToken = "";
    let arkivCookieStr = "";
    let vibboCookieStr = "";

    if (target === "all") {
      // 1. Open the normal entry point, which redirects authenticated users to their tenant.
      console.error("👉 Opening https://styrerommet.no/ for sign-in ...");
      await page.goto("https://styrerommet.no/", {
        waitUntil: "domcontentloaded",
      });

      // 2. Wait for user to authenticate
      console.error(
        "⏳ Waiting for login completion (Vipps / BankID / SMS code)...",
      );

      // Check periodically for completion (up to 5 minutes)
      const startTime = Date.now();
      const maxTimeoutMs = 5 * 60 * 1000;
      const tenantRedirectGraceMs = 5000;
      let authenticatedWithoutTenant = false;
      let authenticatedAt: number | undefined;

      while (Date.now() - startTime < maxTimeoutMs) {
        if (page.isClosed()) {
          throw new Error(
            "Login window was closed before authentication completed.",
          );
        }

        const currentUrl = page.url();
        const cookies = await context.cookies(["https://styrerommet.no"]);
        const hasSession = cookies.some((c) => {
          if (c.name === "connect.sid") return c.value.length > 5;
          if (c.name === "sesid") {
            try {
              const decoded = Buffer.from(c.value, "base64").toString("utf-8");
              return (
                decoded.includes('"passport"') && decoded.includes('"user"')
              );
            } catch {
              return false;
            }
          }
          return false;
        });

        const isPostLoginUrl =
          !currentUrl.includes("/login") &&
          !currentUrl.includes("/oidc") &&
          !currentUrl.includes("innlogging.obos.no") &&
          !currentUrl.includes("bankid") &&
          !currentUrl.includes("vipps");

        if (hasSession && isPostLoginUrl) {
          authenticatedWithoutTenant = true;
          authenticatedAt ??= Date.now();
          const cookieHeader = formatCookieHeader(cookies);
          const routeOrgId = getOrgIdFromRequestUrl(currentUrl);
          const canUseSessionFallback =
            Date.now() - authenticatedAt >= tenantRedirectGraceMs;
          const selectedOrgId =
            routeOrgId ||
            (canUseSessionFallback && getOrgIdFromCookieHeader(cookieHeader)) ||
            (canUseSessionFallback && configuredOrgId);

          if (selectedOrgId) {
            orgId = selectedOrgId;
            styrerommetCookieStr = cookieHeader;
            console.error(
              "✔ Styrerommet session authenticated for OBOS company " +
                orgId +
                ".",
            );
            break;
          }
        }

        await page.waitForTimeout(1000);
      }

      if (!styrerommetCookieStr) {
        throw new Error(
          authenticatedWithoutTenant
            ? "Authentication succeeded, but no OBOS company number was found in the redirect or last_used_organization_id cookie. Open the selected cooperative in Styrerommet and retry, or set STYREROMMET_ORG_ID explicitly."
            : "Authentication timed out after 5 minutes.",
        );
      }

      process.env.STYREROMMET_ORG_ID = orgId;
      process.env.STYREROMMET_COOKIE = styrerommetCookieStr;

      try {
        const { getVibboOrgSlugForOrg } = await import("../client.ts");
        orgSlug = await getVibboOrgSlugForOrg(orgId);
        console.error(
          "✔ Detected Vibbo organization slug for OBOS company " + orgId + ".",
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (
          (!configuredOrgId || configuredOrgId === orgId) &&
          configuredVibboOrgSlug
        ) {
          orgSlug = configuredVibboOrgSlug;
          console.warn(
            "⚠ Could not resolve the Vibbo slug from Styrerommet; using the configured slug. " +
              reason,
          );
        } else {
          console.warn(
            "⚠ Could not resolve the Vibbo slug from Styrerommet. Vibbo login will be skipped. " +
              reason,
          );
        }
      }
      process.env.VIBBO_ORG_SLUG = orgSlug;

      // 3. Authenticate with Styrerommet Arkiv (Jottacloud)
      console.error(
        `👉 Connecting to File Archive (arkiv.styrerommet.no/web/${orgId}/styre/filer)...`,
      );
      await page.goto(`https://arkiv.styrerommet.no/web/${orgId}/styre/filer`, {
        waitUntil: "domcontentloaded",
      });

      console.error("⏳ Waiting for a valid Arkiv sign-in (up to five minutes)...");
      const arkivStart = Date.now();
      while (Date.now() - arkivStart < 5 * 60 * 1000) {
        const arkivCookies = await context.cookies([
          "https://arkiv.styrerommet.no",
        ]);
        const tokenCookie = arkivCookies.find(
          (c) =>
            c.name === "access_token" &&
            (getJwtExpiresAt(c.value) ?? 0) > Date.now() + 60_000,
        );
        if (tokenCookie) {
          arkivToken = tokenCookie.value;
          arkivCookieStr = formatCookieHeader(arkivCookies);
          console.error("✔ Styrerommet Arkiv token acquired!");
          break;
        }
        await page.waitForTimeout(500);
      }

      if (!arkivToken) {
        throw new Error(
          "Arkiv sign-in did not complete within five minutes. Complete the browser sign-in and retry.",
        );
      }

      // 4. Connect to Vibbo resident platform when its tenant slug is available.
      if (orgSlug) {
        console.error(
          "👉 Connecting to Vibbo (https://vibbo.no/" + orgSlug + ")...",
        );
        await page.goto("https://vibbo.no/" + orgSlug, {
          waitUntil: "domcontentloaded",
        });

        const vibboStart = Date.now();
        while (Date.now() - vibboStart < 15000) {
          const vibboCookies = await context.cookies(["https://vibbo.no"]);
          const sesid = vibboCookies.find(
            (c) => c.name === "sesid" && c.value.length > 10,
          );
          if (sesid) {
            vibboCookieStr = formatCookieHeader(vibboCookies);
            console.error("✔ Vibbo resident portal authenticated!");
            break;
          }

          const loginButton = await page.$(
            "a[href*='login'], button:has-text('Logg inn')",
          );
          if (loginButton) {
            try {
              await loginButton.click();
            } catch {}
          }

          await page.waitForTimeout(1000);
        }

        if (!vibboCookieStr) {
          vibboCookieStr = styrerommetCookieStr;
          console.error("✔ Vibbo: using unified OBOS session cookie.");
        }
      } else {
        console.warn(
          "⚠ Skipping Vibbo login because its organization slug could not be determined. Set VIBBO_ORG_SLUG in .env to enable Vibbo tools.",
        );
      }
    }

    // 5. Connect to Mitt Bygg (OBOS Mitt Bygg)
    console.error(
      `👉 Connecting to Mitt Bygg (https://mittbygg.styrerommet.no/${orgId})...`,
    );
    await page.goto(`https://mittbygg.styrerommet.no/${orgId}`, {
      waitUntil: "domcontentloaded",
    });

    let mittbyggCookieStr = "";
    let clickedLogin = false;
    const mittbyggStart = Date.now();
    const mittbyggTimeoutMs = 120000; // Allow up to 2 minutes for BankID / SSO prompt

    while (Date.now() - mittbyggStart < mittbyggTimeoutMs) {
      if (page.isClosed()) break;

      const currentUrl = page.url();

      // Check if we are successfully on the authenticated org page
      const isOnOrgPage =
        currentUrl.includes(`/${orgId}`) &&
        !currentUrl.includes("callbackUrl") &&
        !currentUrl.includes("login") &&
        !currentUrl.includes("authorize");

      // Verify authenticated status directly in page context via RSC test
      const isAuthedViaFetch = await page
        .evaluate(async (id) => {
          try {
            const res = await fetch(`/${id}`, {
              headers: { Accept: "text/x-component", RSC: "1" },
            });
            return (
              res.status === 200 &&
              !res.redirected &&
              !res.url.includes("callbackUrl")
            );
          } catch {
            return false;
          }
        }, orgId)
        .catch(() => false);

      const mbCookies = await context.cookies([
        "https://mittbygg.styrerommet.no",
      ]);
      const sessionCookie = mbCookies.find(
        (c) =>
          (c.name.includes("session") || c.name.includes("account_data")) &&
          !c.name.includes("oauth"),
      );

      if (isAuthedViaFetch || (isOnOrgPage && sessionCookie)) {
        mittbyggCookieStr = formatCookieHeader(mbCookies);
        console.error("✔ Mitt Bygg authenticated successfully!");
        break;
      }

      // Check if logged out landing page is shown
      const content = await page.content().catch(() => "");
      const isLandingPage =
        content.includes("Velkommen til Mitt bygg") ||
        currentUrl.includes("callbackUrl") ||
        currentUrl.endsWith("styrerommet.no/") ||
        content.includes("Logg inn med BankID");

      if (isLandingPage && !clickedLogin) {
        console.error(
          "👉 Please select your preferred login method (Vipps, BankID, etc.) in the opened browser window...",
        );
        clickedLogin = true;
      }

      await page.waitForTimeout(1000);
    }

    if (!mittbyggCookieStr) {
      const mbCookies = await context.cookies([
        "https://mittbygg.styrerommet.no",
      ]);
      const sessionCookie = mbCookies.find(
        (c) =>
          (c.name.includes("session") || c.name.includes("account_data")) &&
          !c.name.includes("oauth"),
      );
      if (sessionCookie) {
        mittbyggCookieStr = formatCookieHeader(mbCookies);
        console.error("✔ Mitt Bygg session cookie detected.");
      } else {
        console.warn(
          "⚠ Mitt Bygg authentication was not completed within the time limit.",
        );
        console.warn(
          "  (You can use demo mode with companyNumber: 'eksempel', or copy the cookie manually to MITTBYGG_COOKIE in .env).",
        );
      }
    }

    // 6. Update .env file
    const envUpdates: Record<string, string> = {
      STYREROMMET_ORG_ID: orgId,
    };

    if (styrerommetCookieStr) {
      envUpdates.STYREROMMET_COOKIE = styrerommetCookieStr;
    }
    if (vibboCookieStr) {
      envUpdates.VIBBO_COOKIE = vibboCookieStr;
    }
    if (orgSlug) {
      envUpdates.VIBBO_ORG_SLUG = orgSlug;
    } else if (configuredVibboOrgSlug && configuredOrgId !== orgId) {
      envUpdates.VIBBO_ORG_SLUG = "";
    }
    if (mittbyggCookieStr) {
      envUpdates.MITTBYGG_COOKIE = mittbyggCookieStr;
    }
    if (arkivToken) {
      envUpdates.STYREROMMET_ARKIV_TOKEN = arkivToken;
    }
    if (arkivCookieStr) {
      envUpdates.STYREROMMET_ARKIV_COOKIE = arkivCookieStr;
    }

    const updatedKeys = updateEnvFile(envUpdates);

    // Apply updates to current process.env
    for (const [k, v] of Object.entries(envUpdates)) {
      process.env[k] = v;
    }

    // Dynamic reload in memory
    try {
      const { reloadClientTokens } = await import("../client.ts");
      if (typeof reloadClientTokens === "function") reloadClientTokens();
      const { reloadArkivTokens } = await import("../arkiv-client.ts");
      if (typeof reloadArkivTokens === "function") reloadArkivTokens();
      const { reloadVibboTokens } = await import("../vibbo-client.ts");
      if (typeof reloadVibboTokens === "function") reloadVibboTokens();
      const { reloadMittByggTokens } = await import("../mittbygg-client.ts");
      if (typeof reloadMittByggTokens === "function") reloadMittByggTokens();
    } catch {}

    // 7. Display in-browser success message
    const successServices =
      target === "mittbygg"
        ? "<b>OBOS Mitt Bygg</b>"
        : orgSlug
          ? "<b>Styrerommet</b>, <b>Arkiv</b>, <b>Vibbo</b>, and <b>Mitt Bygg</b>"
          : "<b>Styrerommet</b>, <b>Arkiv</b>, and <b>Mitt Bygg</b>";

    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authentication Successful</title>
          <meta charset="utf-8">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 90vh; background: #f0fdf4; color: #166534; margin: 0;">
          <div style="text-align: center; padding: 40px; background: white; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); max-width: 500px;">
            <div style="font-size: 64px; margin-bottom: 16px;">🎉</div>
            <h1 style="margin: 0 0 12px 0; font-size: 24px; color: #15803d;">Authentication Successful!</h1>
            <p style="margin: 0 0 20px 0; color: #4b5563; line-height: 1.5;">
              Fresh tokens and cookies for ${successServices} have been saved to <code>.env</code>.
            </p>
            <div style="font-size: 13px; color: #9ca3af;">Closing browser window in a few seconds...</div>
          </div>
        </body>
      </html>
    `);

    await page.waitForTimeout(3000);
    await context.close();

    console.error("\n========================================================");
    console.error("  SUCCESSFULLY AUTHENTICATED & UPDATED .env");
    console.error("========================================================");
    console.error(`Updated keys: ${updatedKeys.join(", ")}`);
    console.error("The MCP server and tools are ready to use.\n");

    return {
      success: true,
      message: `Authentication succeeded! Updated ${updatedKeys.length} keys in .env: ${updatedKeys.join(", ")}`,
      updatedKeys,
    };
  } catch (error: any) {
    if (context) {
      await context.close().catch(() => {});
    }
    console.error(`\n❌ Authentication failed: ${error.message}`);
    throw error;
  }
}

// Allow direct execution via `node src/auth/login.ts` or `pnpm auth` or `pnpm auth:mittbygg`
const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMainModule) {
  const isMittByggOnly =
    process.argv.includes("mittbygg") || process.argv.includes("--mittbygg");
  runInteractiveLogin(isMittByggOnly ? "mittbygg" : "all")
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
