import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  getCantorCompanyId,
  getCantorCompanyInfo,
  getCantorChartOfAccounts,
  getCantorTrialBalance,
  getCantorBudget,
  getCantorBudgetSpecs,
  getCantorDashboard,
  getCantorMonthlyActuals,
  getCantorFelleskostnaderForecast,
  getCantorDashboardWidgets,
  getCantorDimensions,
  getCantorAccountComments,
  type CantorAccountRow,
  type CantorTrialBalanceItem,
  type CantorBudgetLine,
  type CantorMonthlyActualsLine,
} from "../cantor-client.ts";
import { buildCantorReportWebUrl, buildCantorHomeWebUrl } from "../urls.ts";

export function registerCantorTools(server: McpServer): void {
  // 1. Company Information
  server.registerTool(
    "cantor_get_company_info",
    {
      description:
        "Get corporate accounting master info, direct webUrl link, and available fiscal years/periods from Cantor Web Services (cws.obos.no). Strictly read-only.",
      inputSchema: z.object({
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company/cooperative ID. Defaults to the organization configured in the session or STYREROMMET_ORG_ID.",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ company_id }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const info = await getCantorCompanyInfo(companyId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  webUrl: buildCantorHomeWebUrl(companyId),
                  ...info.details,
                  availableFiscalYears: info.availableYears,
                  availablePeriods: info.availablePeriods,
                  reportingUnits: info.units,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching Cantor company info: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 2. Chart of Accounts (Kontoplan)
  server.registerTool(
    "cantor_get_chart_of_accounts",
    {
      description:
        "Get the official chart of accounts (Kontoplan) for the housing cooperative from Cantor. Strictly read-only.",
      inputSchema: z.object({
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company ID. Defaults to the organization configured in STYREROMMET_ORG_ID.",
          ),
        year: z
          .number()
          .optional()
          .describe("Fiscal year (defaults to current year)"),
        period: z.number().optional().describe("Period (1-12, defaults to 12)"),
        account_prefix: z
          .string()
          .optional()
          .describe(
            "Filter by account number prefix (e.g. '1' for assets, '2' for debt/equity, '3' for revenue, '6' for operations, '7' for other costs)",
          ),
        search: z
          .string()
          .optional()
          .describe("Search term for account number or account name"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ company_id, year, period, account_prefix, search }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const res = await getCantorChartOfAccounts(companyId, { year, period });

        let accounts: CantorAccountRow[] = res.accounts;

        if (account_prefix) {
          accounts = accounts.filter((a) =>
            a.kontonr.startsWith(account_prefix),
          );
        }

        if (search) {
          const q = search.toLowerCase();
          accounts = accounts.filter(
            (a) =>
              a.kontonr.toLowerCase().includes(q) ||
              a.kontonavn.toLowerCase().includes(q),
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  oppsett: res.displayName,
                  totalAccountsMatching: accounts.length,
                  accounts,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching Cantor chart of accounts: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 3. Trial Balance (Saldobalanse)
  server.registerTool(
    "cantor_get_trial_balance",
    {
      description:
        "Get the trial balance (saldobalanse) with account balances, prior year figures, changes, and prognosis from Cantor. Strictly read-only.",
      inputSchema: z.object({
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company ID. Defaults to the organization configured in STYREROMMET_ORG_ID.",
          ),
        year: z
          .number()
          .optional()
          .describe("Fiscal year (e.g. 2026, 2025). Defaults to current year."),
        period: z
          .number()
          .optional()
          .describe("Accounting period (1-12, defaults to 12)"),
        year_to_date: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "If true (default), returns year-to-date (hittil i år). If false, returns period figures.",
          ),
        result_only: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, only returns income and expense accounts (resultatregnskap 3000-8999). If false, returns all accounts including balance sheet.",
          ),
        in_use_only: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "If true (default), only returns accounts that have transactions/balances.",
          ),
        account_filter: z
          .string()
          .optional()
          .describe(
            "Filter by account number or account prefix (e.g. '1100', '15', '60')",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      company_id,
      year,
      period,
      year_to_date,
      result_only,
      in_use_only,
      account_filter,
    }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const res = await getCantorTrialBalance(companyId, {
          year,
          period,
          yearToDate: year_to_date,
          resultOnly: result_only,
          inUseOnly: in_use_only,
        });

        let lines: CantorTrialBalanceItem[] = res.lines;
        if (account_filter) {
          const f = account_filter.toLowerCase();
          lines = lines.filter(
            (l) =>
              l.kontonr.toLowerCase().startsWith(f) ||
              l.kontonavn.toLowerCase().includes(f),
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  year: res.year,
                  period: res.period,
                  yearToDate: res.yearToDate,
                  totalAccounts: lines.length,
                  lines,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching Cantor trial balance: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 4. Budget (Budsjett)
  server.registerTool(
    "cantor_get_budget",
    {
      description:
        "Get corporate budget (budsjett) with full year sums, monthly 1-12 distributions, prior year budgets/actuals, and locked status from Cantor. Strictly read-only.",
      inputSchema: z.object({
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company ID. Defaults to the organization configured in STYREROMMET_ORG_ID.",
          ),
        year: z
          .number()
          .optional()
          .describe(
            "Budget fiscal year (e.g. 2026, 2025). Defaults to current year.",
          ),
        period: z.number().optional().describe("Period (1-12, defaults to 12)"),
        account_filter: z
          .string()
          .optional()
          .describe("Filter by account number or prefix (e.g. '1100' or '6')"),
        include_zero_lines: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, includes all 270+ chart accounts even if they have 0 budget and 0 actuals. Defaults to false.",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      company_id,
      year,
      period,
      account_filter,
      include_zero_lines,
    }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const res = await getCantorBudget(companyId, {
          year,
          period,
          includeZeroLines: include_zero_lines,
        });

        let lines: CantorBudgetLine[] = res.lines;
        if (account_filter) {
          const f = account_filter.toLowerCase();
          lines = lines.filter(
            (l) =>
              l.kontonr.toLowerCase().startsWith(f) ||
              l.kontonavn.toLowerCase().includes(f),
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  year: res.year,
                  period: res.period,
                  budgetIsLocked: res.budgetIsLocked,
                  totalAccounts: lines.length,
                  lines,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Error fetching Cantor budget: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // 5. Budget Specifications (Budsjettspesifikasjoner)
  server.registerTool(
    "cantor_get_budget_specifications",
    {
      description:
        "Get detailed line-item specifications/breakdown for a specific budget account from Cantor. Strictly read-only.",
      inputSchema: z.object({
        kontonr: z
          .string()
          .optional()
          .default("6000")
          .describe(
            "Account number to drill into (e.g. '6000', '7700'). Defaults to '6000'",
          ),
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company ID. Defaults to the organization configured in STYREROMMET_ORG_ID.",
          ),
        year: z
          .number()
          .optional()
          .describe("Budget year (defaults to current year)"),
        period: z.number().optional().describe("Period (1-12, defaults to 12)"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ kontonr, company_id, year, period }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const account = kontonr || "6000";
        const res = await getCantorBudgetSpecs(companyId, account, {
          year,
          period,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  kontonr: res.kontonr,
                  year: res.year,
                  totalSpecificationLines: res.lines.length,
                  lines: res.lines,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching Cantor budget specifications: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 6. Dashboard Financial Summary
  server.registerTool(
    "cantor_get_dashboard_summary",
    {
      description:
        "Get executive financial summary and KPI tables (operating income, costs, result, budget variance, liquidity) from Cantor. Strictly read-only.",
      inputSchema: z.object({
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company ID. Defaults to the organization configured in STYREROMMET_ORG_ID.",
          ),
        year: z
          .number()
          .optional()
          .describe("Fiscal year (defaults to current year)"),
        period: z
          .number()
          .optional()
          .describe("Period (1-12, defaults to 9 or latest available)"),
        widget_id: z
          .number()
          .optional()
          .default(150)
          .describe(
            "Widget ID to display. 150 = Resultat boligselskaper (Operating result vs budget), 140 = Balanse konsern, 126 = Likviditetsendring. Defaults to 150.",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ company_id, year, period, widget_id }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const tables = await getCantorDashboard(companyId, {
          year,
          period,
          widgetId: widget_id,
        });

        const reportUrls: Record<string, string> = {
          resultat_150: buildCantorReportWebUrl(150, companyId),
          balanse_140: buildCantorReportWebUrl(140, companyId),
          likviditetsendring_126: buildCantorReportWebUrl(126, companyId),
        };
        if (widget_id) {
          reportUrls[`widget_${widget_id}`] = buildCantorReportWebUrl(
            widget_id,
            companyId,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  year: year || new Date().getFullYear(),
                  period: period || 9,
                  widgetId: widget_id,
                  reportUrls,
                  tables,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching Cantor dashboard summary: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 7. Monthly Actuals and Forecast (Bel1 - Bel12 per account)
  server.registerTool(
    "cantor_get_monthly_actuals",
    {
      description:
        "Get full month-by-month actual costs/revenues (January to December), LTM rolling total, and year-to-date figures for all accounts from Cantor. Strictly read-only.",
      inputSchema: z.object({
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company ID. Defaults to the organization configured in STYREROMMET_ORG_ID.",
          ),
        year: z
          .number()
          .optional()
          .describe("Fiscal year (defaults to current year)"),
        period: z
          .number()
          .optional()
          .describe("Current period cutoff (1-12, defaults to 9)"),
        account_filter: z
          .string()
          .optional()
          .describe(
            "Filter by account number or prefix (e.g. '36' for revenues, '60' for maintenance, '63' for heating/electricity)",
          ),
        include_zero_lines: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, includes accounts with zero amounts across all months. Defaults to false.",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      company_id,
      year,
      period,
      account_filter,
      include_zero_lines,
    }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const res = await getCantorMonthlyActuals(companyId, {
          year,
          period,
          includeZeroLines: include_zero_lines,
        });

        let lines: CantorMonthlyActualsLine[] = res.lines;
        if (account_filter) {
          const f = account_filter.toLowerCase();
          lines = lines.filter(
            (l) =>
              l.kontonr.toLowerCase().startsWith(f) ||
              l.kontonavn.toLowerCase().includes(f),
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  year: res.year,
                  period: res.period,
                  totalAccounts: lines.length,
                  lines,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching Cantor monthly actuals: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 8. OBOS Future Common Cost Forecast (Prognose felleskostnader)
  server.registerTool(
    "cantor_get_felleskostnader_forecast",
    {
      description:
        "Get OBOS's official multi-year forecast and recommended annual percentage increase for common costs (felleskostnader account 3600) from Cantor. Strictly read-only.",
      inputSchema: z.object({
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company ID. Defaults to the organization configured in STYREROMMET_ORG_ID.",
          ),
        year: z
          .number()
          .optional()
          .describe("Base fiscal year (defaults to current year)"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ company_id, year }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const forecast = await getCantorFelleskostnaderForecast(companyId, {
          year,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  baseYear: year || new Date().getFullYear(),
                  account: `${forecast.accountNumber} ${forecast.accountName}`,
                  recommendedAnnualIncreasePercent:
                    forecast.calculatedAnnualIncreasePercent,
                  multiYearProjections: forecast.lines,
                  guidance: forecast.guidanceText,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching Cantor felleskostnader forecast: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 9. Dashboard Widgets Catalog
  server.registerTool(
    "cantor_list_dashboard_widgets",
    {
      description:
        "List all available executive financial dashboard widgets and reports (e.g. Resultat, Balanse, Likviditetsreserve) in Cantor. Each widget includes a direct 'webUrl' link to the dynamic report on cws.obos.no. Strictly read-only.",
      inputSchema: z.object({
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company ID. Defaults to the organization configured in STYREROMMET_ORG_ID.",
          ),
        year: z
          .number()
          .optional()
          .describe("Fiscal year (defaults to current year)"),
        period: z.number().optional().describe("Period (1-12, defaults to 9)"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ company_id, year, period }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const widgets = await getCantorDashboardWidgets(companyId, {
          year,
          period,
        });
        const enrichedWidgets = widgets.map((w) => ({
          ...w,
          webUrl: buildCantorReportWebUrl(w.widgetDataId, companyId),
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  totalWidgetsAvailable: enrichedWidgets.length,
                  widgets: enrichedWidgets,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error listing Cantor dashboard widgets: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 10. Accounting Dimensions
  server.registerTool(
    "cantor_get_dimensions",
    {
      description:
        "Get active accounting dimensions (e.g. Lån, Objekt, Kategorier) configured for the cooperative in Cantor. Strictly read-only.",
      inputSchema: z.object({
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company ID. Defaults to the organization configured in STYREROMMET_ORG_ID.",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ company_id }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const dimensions = await getCantorDimensions(companyId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  dimensions,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Error fetching Cantor dimensions: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // 11. Account Comments (Saldobalanse & Budget Commentary)
  server.registerTool(
    "cantor_get_account_comments",
    {
      description:
        "Get accountant and board commentary / discussion notes for specific accounts or across the whole cooperative in Cantor. Strictly read-only.",
      inputSchema: z.object({
        company_id: z
          .string()
          .optional()
          .describe(
            "OBOS company ID. Defaults to the organization configured in STYREROMMET_ORG_ID.",
          ),
        account: z
          .string()
          .optional()
          .describe(
            "Specific account number (e.g. '7700', '1100'). If omitted or 'all', scans and returns commentary for all accounts that have comments.",
          ),
        year: z
          .number()
          .optional()
          .describe("Fiscal year (defaults to current year)"),
        period: z.number().optional().describe("Period (1-12, defaults to 12)"),
        source: z
          .enum(["saldobalanse", "budget"])
          .optional()
          .default("saldobalanse")
          .describe(
            "Comment source: 'saldobalanse' (actual accounts commentary) or 'budget' (budget line commentary). Defaults to 'saldobalanse'.",
          ),
        year_to_date: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Whether to fetch year-to-date commentary for saldobalanse. Defaults to true.",
          ),
        dim1: z
          .string()
          .optional()
          .describe("Optional dimension filter for budget comments"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      company_id,
      account,
      year,
      period,
      source,
      year_to_date,
      dim1,
    }) => {
      try {
        const companyId = company_id || getCantorCompanyId();
        const res = await getCantorAccountComments(companyId, {
          account,
          year,
          period,
          source,
          yearToDate: year_to_date,
          dim1,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companyId,
                  ...res,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching Cantor account comments: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
