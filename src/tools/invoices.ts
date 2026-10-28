import { UPDATE_ANNOTATIONS } from "../annotations.ts";
import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId, downloadFile } from "../client.ts";
import { buildInvoiceWebUrl } from "../urls.ts";
import { registry } from "../registry.ts";
import * as path from "node:path";

const SEARCH_INVOICES_QUERY = `query searchInvoices(
  $externalCompanyNumber: OrganizationID!,
  $filters: SearchInvoiceInput!,
  $sortBy: SearchInvoiceSortOrder,
  $sortDirection: SortDirection
) {
  search: searchInvoices(
    organizationId: $externalCompanyNumber
    filters: $filters
    sortBy: $sortBy
    sortDirection: $sortDirection
    failSilently: false
  ) {
    invoices {
      id
      invoiceNumber
      status
      dueDate
      issueDate
      amount
      currency
      autoApproved
      supplierName
      supplier {
        id
        name
        officialName
        logo
      }
      primaryAttachment {
        id
        contentType
        filename
        url
      }
      attachments {
        id
        contentType
        filename
        url
      }
      assigned {
        id
        name
        firstName
        lastName
        roles
        profilePhotoUrl
      }
    }
    total
  }
}`;

const INVOICE_DETAIL_QUERY = `query invoiceDetailQuery($invoiceId: NodeID!, $obosCompanyNumber: OrganizationID!) {
  organization(id: $obosCompanyNumber) {
    id
    accountingEnabled
  }
  invoice(invoiceId: $invoiceId) {
    id
    invoiceNumber
    supplierName
    issueDate
    dueDate
    amount
    currency
    status
    autoApproved
    supplier {
      id
      name
      officialName
      organizationNumber
      logo
    }
    assigned {
      id
      name
      firstName
      lastName
      roles
    }
    primaryAttachment {
      id
      contentType
      filename
      url
    }
    attachments {
      id
      contentType
      filename
      url
    }
  }
}`;

function formatDateToISO(
  dateStr: string | null | undefined,
): string | null | undefined {
  if (!dateStr) return dateStr;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return `${dateStr}T00:00:00Z`;
  }
  return dateStr;
}

export function registerInvoiceTools(server: McpServer): void {
  server.registerTool(
    "search_invoices",
    {
      description:
        "Search and list invoices for the organization. Returns invoice list with pagination. Supports filtering by supplierName (with automatic fallback to in-memory matching if the suppliers registry is empty). Each invoice includes a ready-to-click 'webUrl' link to the invoice preview in Styrerommet.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(15)
          .describe("Number of invoices to return (default 15, max 100)"),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Pagination offset (default 0)"),
        status: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Filter by status (e.g. 'PENDING', 'APPROVED', 'REJECTED')",
          ),
        dateFrom: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Filter: invoices from this date (YYYY-MM-DD or ISO format)",
          ),
        dateTo: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Filter: invoices until this date (YYYY-MM-DD or ISO format)",
          ),
        fromSupplierId: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Filter by supplier ID (NodeID format, e.g. 'U3VwcGxpZXI6Li4u')",
          ),
        supplierName: z
          .string()
          .optional()
          .describe(
            "Case-insensitive supplier name. This performs a fast native GraphQL pre-lookup before fetching invoices.",
          ),
        sortBy: z
          .string()
          .default("ISSUE_DATE")
          .describe("Sort field: ISSUE_DATE, DUE_DATE, AMOUNT, SUPPLIER_NAME"),
        sortDirection: z
          .string()
          .default("DESCENDING")
          .describe("Sort direction: ASCENDING or DESCENDING"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      limit,
      offset,
      status,
      dateFrom,
      dateTo,
      fromSupplierId,
      supplierName,
      sortBy,
      sortDirection,
    }) => {
      let resolvedSupplierId = fromSupplierId ?? null;
      let filterInMemorySupplierName: string | null = null;

      if (supplierName) {
        try {
          const numericId = getOrgId();
          const suppliersRes = await graphqlQuery(
            "allSuppliers",
            `query allSuppliers($obosCompanyNumber: ID!, $options: SuppliersOptions) {
              suppliers(obosCompanyNumber: $obosCompanyNumber, options: $options) {
                items {
                  id
                  name
                  officialName
                }
              }
            }`,
            {
              obosCompanyNumber: numericId,
              options: { limit: 100, query: supplierName },
            },
          );

          const suppliers = (suppliersRes.data as any)?.suppliers?.items || [];
          const matchedSupplier = suppliers.find(
            (s: any) =>
              s.name.toLowerCase().includes(supplierName.toLowerCase()) ||
              (s.officialName &&
                s.officialName
                  .toLowerCase()
                  .includes(supplierName.toLowerCase())),
          );

          if (matchedSupplier) {
            resolvedSupplierId = matchedSupplier.id;
          } else {
            filterInMemorySupplierName = supplierName.toLowerCase();
          }
        } catch {
          filterInMemorySupplierName = supplierName.toLowerCase();
        }
      }

      const formattedDateFrom = formatDateToISO(dateFrom);
      const formattedDateTo = formatDateToISO(dateTo);

      // If we are filtering in memory, we fetch a larger batch so we can filter down to the requested limit
      const fetchLimit = filterInMemorySupplierName
        ? Math.max(limit * 3, 100)
        : limit;

      try {
        const orgId = getOrgId();
        const result = await graphqlQuery(
          "searchInvoices",
          SEARCH_INVOICES_QUERY,
          {
            externalCompanyNumber: orgId,
            filters: {
              status: status ?? null,
              dateFrom: formattedDateFrom ?? null,
              dateTo: formattedDateTo ?? null,
              fromSupplierId: resolvedSupplierId,
              limit: fetchLimit,
              offset: offset ?? 0,
            },
            sortBy: sortBy ?? "ISSUE_DATE",
            sortDirection: sortDirection ?? "DESCENDING",
          },
        );

        let data = result.data as any;
        if (data?.search?.invoices && filterInMemorySupplierName) {
          const matched = data.search.invoices.filter(
            (inv: any) =>
              inv.supplierName &&
              inv.supplierName
                .toLowerCase()
                .includes(filterInMemorySupplierName!),
          );
          data.search.invoices = matched.slice(0, limit);
          data.search.total = matched.length;
        }

        if (data?.search?.invoices) {
          data.search.invoices = data.search.invoices.map((inv: any) => ({
            ...inv,
            webUrl: buildInvoiceWebUrl(inv.id, orgId),
          }));
        }

        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Error searching invoices: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  const COMMENTS_QUERY = `query CommentsQuery($parentId: UnpackedNodeID!) {
  comments(parentId: $parentId) {
    ...Comments_comment
  }
}

fragment Comments_comment on Comment {
  ...Comment_Data
  thread {
    ...Comment_Data
  }
  threadCount
}

fragment Comment_Data on Comment {
  id
  content
  createdBy {
    id
    userId
    firstName
    lastName
    roles
    profilePhotoUrl
    isViewer
  }
  createdAt
  updatedAt
  threadId
  attachments {
    id
    filename
    url
  }
  deletedAt
}`;

  server.registerTool(
    "get_invoice",
    {
      description:
        "Get detailed information about a specific invoice, including attachments, comments, and direct 'webUrl' link to the invoice preview in Styrerommet",
      inputSchema: z.object({
        invoiceId: z
          .string()
          .describe("The invoice node ID (e.g. 'SW52b2ljZTo...')"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ invoiceId }) => {
      const orgId = getOrgId();
      const result = await graphqlQuery(
        "invoiceDetailQuery",
        INVOICE_DETAIL_QUERY,
        {
          invoiceId,
          obosCompanyNumber: orgId,
        },
      );

      let comments = null;
      try {
        const commentsRes = await graphqlQuery<any>(
          "CommentsQuery",
          COMMENTS_QUERY,
          {
            parentId: invoiceId,
          },
        );
        comments = commentsRes.data?.comments || [];
      } catch (err) {
        // Ignore comment fetch errors
      }

      const invoiceData = (result.data as any) || {};
      const webUrl = buildInvoiceWebUrl(
        invoiceData.invoice?.id || invoiceId,
        orgId,
      );
      if (invoiceData.invoice) {
        invoiceData.invoice = {
          ...invoiceData.invoice,
          webUrl,
        };
      }
      const mergedData = {
        ...invoiceData,
        webUrl,
        comments,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(mergedData, null, 2) }],
      };
    },
  );

  server.registerTool(
    "download_invoices",
    {
      description:
        "Download invoice attachment PDFs for a supplier or specific invoice IDs to a directory in the workspace. Automatically falls back to in-memory supplier matching.",
      inputSchema: z.object({
        outputDir: z
          .string()
          .describe(
            "Target directory relative to the workspace (e.g. './data/invoices')",
          ),
        supplierName: z
          .string()
          .optional()
          .describe(
            "Case-insensitive supplier name. This performs a fast native GraphQL pre-lookup before fetching invoices.",
          ),
        invoiceIds: z
          .array(z.string())
          .optional()
          .describe("Specific list of invoice IDs to download"),
        dateFrom: z
          .string()
          .optional()
          .describe(
            "Filter: from invoice issue date (YYYY-MM-DD or ISO format)",
          ),
        dateTo: z
          .string()
          .optional()
          .describe(
            "Filter: until invoice issue date (YYYY-MM-DD or ISO format)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Max number of invoices to search and download"),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({
      outputDir,
      supplierName,
      invoiceIds,
      dateFrom,
      dateTo,
      limit,
    }) => {
      const resolvedInvoiceIds: string[] = [];
      const formattedDateFrom = formatDateToISO(dateFrom);
      const formattedDateTo = formatDateToISO(dateTo);

      if (supplierName) {
        let matchedSupplierId = null;
        let inMemorySearch = false;

        try {
          const numericId = getOrgId();
          const suppliersRes = await graphqlQuery(
            "allSuppliers",
            `query allSuppliers($obosCompanyNumber: ID!, $options: SuppliersOptions) {
              suppliers(obosCompanyNumber: $obosCompanyNumber, options: $options) {
                items {
                  id
                  name
                  officialName
                }
              }
            }`,
            {
              obosCompanyNumber: numericId,
              options: { limit: 100, query: supplierName },
            },
          );

          const suppliers = (suppliersRes.data as any)?.suppliers?.items || [];
          const matchedSupplier = suppliers.find(
            (s: any) =>
              s.name.toLowerCase().includes(supplierName.toLowerCase()) ||
              (s.officialName &&
                s.officialName
                  .toLowerCase()
                  .includes(supplierName.toLowerCase())),
          );

          if (matchedSupplier) {
            matchedSupplierId = matchedSupplier.id;
          } else {
            inMemorySearch = true;
          }
        } catch {
          inMemorySearch = true;
        }

        // Fetch invoices
        const invoicesRes = await graphqlQuery(
          "searchInvoices",
          SEARCH_INVOICES_QUERY,
          {
            externalCompanyNumber: getOrgId(),
            filters: {
              status: null,
              dateFrom: formattedDateFrom ?? null,
              dateTo: formattedDateTo ?? null,
              fromSupplierId: matchedSupplierId,
              limit: inMemorySearch ? Math.max(limit * 3, 150) : limit,
              offset: 0,
            },
            sortBy: "ISSUE_DATE",
            sortDirection: "DESCENDING",
          },
        );

        let foundInvoices = (invoicesRes.data as any)?.search?.invoices || [];
        if (inMemorySearch) {
          foundInvoices = foundInvoices
            .filter(
              (inv: any) =>
                inv.supplierName &&
                inv.supplierName
                  .toLowerCase()
                  .includes(supplierName.toLowerCase()),
            )
            .slice(0, limit);
        }

        for (const inv of foundInvoices) {
          resolvedInvoiceIds.push(inv.id);
        }

        if (resolvedInvoiceIds.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No invoices found for supplier "${supplierName}" in the specified range.`,
              },
            ],
          };
        }
      } else if (invoiceIds && invoiceIds.length > 0) {
        resolvedInvoiceIds.push(...invoiceIds);
      } else {
        return {
          content: [
            {
              type: "text",
              text: "You must provide either 'supplierName' or 'invoiceIds' to download invoices.",
            },
          ],
          isError: true,
        };
      }

      // Download attachments for the resolved invoices
      const downloadedFiles: string[] = [];
      const errors: string[] = [];

      for (const invId of resolvedInvoiceIds) {
        try {
          const detailRes = await graphqlQuery(
            "invoiceDetailQuery",
            INVOICE_DETAIL_QUERY,
            {
              invoiceId: invId,
              obosCompanyNumber: getOrgId(),
            },
          );

          const invoice = (detailRes.data as any)?.invoice;
          if (!invoice) {
            errors.push(`Invoice not found for ID: ${invId}`);
            continue;
          }

          const attachments = [];
          if (invoice.primaryAttachment)
            attachments.push(invoice.primaryAttachment);
          if (invoice.attachments) attachments.push(...invoice.attachments);

          const uniqueAttachments = Array.from(
            new Map(attachments.map((a) => [a.id, a])).values(),
          );

          if (uniqueAttachments.length === 0) {
            errors.push(
              `No attachments found for invoice ${invoice.invoiceNumber} (${invoice.supplierName})`,
            );
            continue;
          }

          for (const att of uniqueAttachments) {
            if (!att.url) continue;
            // Clean filename
            const cleanFilename =
              `${invoice.issueDate}_${invoice.invoiceNumber}_${invoice.supplierName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${att.filename}`.substring(
                0,
                150,
              );
            const destPath = path.join(outputDir, cleanFilename);

            await downloadFile(att.url, destPath);
            downloadedFiles.push(destPath);
          }
        } catch (err: any) {
          errors.push(`Failed for invoice ${invId}: ${err.message}`);
        }
      }

      const report = [
        `Successfully downloaded ${downloadedFiles.length} file(s) to ${outputDir}:`,
        ...downloadedFiles.map((f) => `- ${f}`),
        ...(errors.length > 0
          ? ["\nErrors:", ...errors.map((e) => `- ${e}`)]
          : []),
      ].join("\n");

      return {
        content: [{ type: "text", text: report }],
      };
    },
  );

  server.registerTool(
    "analyze_supplier_costs",
    {
      description:
        "Analyze and aggregate costs by supplier for a given period. Returns a structured Markdown table summarizing total expenditures, invoice counts, and date ranges per supplier.",
      inputSchema: z.object({
        supplierName: z
          .string()
          .optional()
          .describe(
            "Case-insensitive supplier name. This performs a fast native GraphQL pre-lookup before analyzing invoices.",
          ),
        dateFrom: z
          .string()
          .optional()
          .describe("Filter: start date (YYYY-MM-DD or ISO format)"),
        dateTo: z
          .string()
          .optional()
          .describe("Filter: end date (YYYY-MM-DD or ISO format)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(100)
          .describe("Max number of invoices to analyze (default 100)"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ supplierName, dateFrom, dateTo, limit }) => {
      let matchedSupplierId = null;
      let inMemorySearch = false;

      if (supplierName) {
        try {
          const numericId = getOrgId();
          const suppliersRes = await graphqlQuery(
            "allSuppliers",
            `query allSuppliers($obosCompanyNumber: ID!, $options: SuppliersOptions) {
              suppliers(obosCompanyNumber: $obosCompanyNumber, options: $options) {
                items {
                  id
                  name
                  officialName
                }
              }
            }`,
            {
              obosCompanyNumber: numericId,
              options: { limit: 100, query: supplierName },
            },
          );

          const suppliers = (suppliersRes.data as any)?.suppliers?.items || [];
          const matchedSupplier = suppliers.find(
            (s: any) =>
              s.name.toLowerCase().includes(supplierName.toLowerCase()) ||
              (s.officialName &&
                s.officialName
                  .toLowerCase()
                  .includes(supplierName.toLowerCase())),
          );

          if (matchedSupplier) {
            matchedSupplierId = matchedSupplier.id;
          } else {
            inMemorySearch = true;
          }
        } catch {
          inMemorySearch = true;
        }
      }

      const formattedDateFrom = formatDateToISO(dateFrom);
      const formattedDateTo = formatDateToISO(dateTo);

      try {
        // Fetch invoices
        const invoicesRes = await graphqlQuery(
          "searchInvoices",
          SEARCH_INVOICES_QUERY,
          {
            externalCompanyNumber: getOrgId(),
            filters: {
              status: null,
              dateFrom: formattedDateFrom ?? null,
              dateTo: formattedDateTo ?? null,
              fromSupplierId: matchedSupplierId,
              limit: inMemorySearch ? Math.max(limit * 3, 200) : limit,
              offset: 0,
            },
            sortBy: "ISSUE_DATE",
            sortDirection: "DESCENDING",
          },
        );

        let invoices = (invoicesRes.data as any)?.search?.invoices || [];

        if (supplierName && inMemorySearch) {
          invoices = invoices
            .filter(
              (inv: any) =>
                inv.supplierName &&
                inv.supplierName
                  .toLowerCase()
                  .includes(supplierName.toLowerCase()),
            )
            .slice(0, limit);
        }

        if (invoices.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No invoices found in the specified range.`,
              },
            ],
          };
        }

        // Aggregate by supplier
        const aggregation: Record<
          string,
          {
            supplierName: string;
            totalAmount: number;
            invoiceCount: number;
            minDate: string;
            maxDate: string;
            items: Array<{
              invoiceNumber: string;
              date: string;
              amount: number;
              status: string;
            }>;
          }
        > = {};

        for (const inv of invoices) {
          const sName = inv.supplierName || "Unknown";
          const amt = inv.amount || 0;
          const date = inv.issueDate ? inv.issueDate.substring(0, 10) : "";

          if (!aggregation[sName]) {
            aggregation[sName] = {
              supplierName: sName,
              totalAmount: 0,
              invoiceCount: 0,
              minDate: date,
              maxDate: date,
              items: [],
            };
          }

          const agg = aggregation[sName]!;
          agg.totalAmount += amt;
          agg.invoiceCount += 1;
          if (date && (!agg.minDate || date < agg.minDate)) agg.minDate = date;
          if (date && (!agg.maxDate || date > agg.maxDate)) agg.maxDate = date;
          agg.items.push({
            invoiceNumber: inv.invoiceNumber || "N/A",
            date,
            amount: amt,
            status: inv.status || "N/A",
          });
        }

        // Sort by total cost descending
        const sorted = Object.values(aggregation).sort(
          (a, b) => b.totalAmount - a.totalAmount,
        );

        let markdown = `### Supplier Cost Analysis\n`;
        markdown += `Analyzed ${invoices.length} invoices.\n\n`;
        markdown += `| Supplier Name | Total (NOK) | Invoice Count | Period |\n`;
        markdown += `| :--- | :--- | :--- | :--- |\n`;
        for (const agg of sorted) {
          const period =
            agg.minDate === agg.maxDate
              ? agg.minDate
              : `${agg.minDate} to ${agg.maxDate}`;
          markdown += `| **${agg.supplierName}** | ${agg.totalAmount.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ${agg.invoiceCount} | ${period} |\n`;
        }

        for (const agg of sorted.slice(0, 5)) {
          markdown += `\n#### Detailed Invoices for ${agg.supplierName}\n`;
          markdown += `| Invoice # | Issue Date | Amount (NOK) | Status |\n`;
          markdown += `| :--- | :--- | :--- | :--- |\n`;
          // Sort items by date descending
          const sortedItems = agg.items.sort((a, b) =>
            b.date.localeCompare(a.date),
          );
          for (const item of sortedItems) {
            markdown += `| ${item.invoiceNumber} | ${item.date} | ${item.amount.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ${item.status} |\n`;
          }
        }

        return {
          content: [{ type: "text", text: markdown }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error analyzing supplier costs: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_active_invoices",
    {
      description:
        "List active/incoming invoices currently in the board approval workflow in Semine before they are paid or booked. Each invoice includes a ready-to-click 'webUrl' link to the invoice preview in Styrerommet.",
      inputSchema: z.object({
        status: z
          .string()
          .optional()
          .describe(
            "Optional status filter (e.g. 'INCOMING', 'AWAITING_APPROVAL', 'APPROVED')",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ status }) => {
      try {
        const orgId = getOrgId();
        const op = registry.get("activeInvoices");
        const result = await graphqlQuery<any>(
          op?.operationName ?? "activeInvoices",
          op?.queryText ??
            `query activeInvoices($organizationNumber: OrganizationID!, $filters: SearchInvoiceInput!) {
            activeInvoices: searchInvoices(
              organizationId: $organizationNumber
              filters: $filters
              failSilently: false
            ) {
              invoices {
                id
                invoiceNumber
                status
                dueDate
                issueDate
                amount
                currency
                autoApproved
                supplierName
                supplier {
                  id
                  name
                  officialName
                }
              }
              total
            }
          }`,
          {
            organizationNumber: orgId,
            filters: {},
          },
        );

        let invoices = result.data?.activeInvoices?.invoices ?? [];
        if (status) {
          const s = status.toUpperCase();
          invoices = invoices.filter(
            (i: any) => (i.status || "").toUpperCase() === s,
          );
        }

        const enrichedInvoices = invoices.map((i: any) => ({
          ...i,
          webUrl: buildInvoiceWebUrl(i.id, orgId),
        }));

        const totalAmount = enrichedInvoices.reduce(
          (sum: number, i: any) => sum + (i.amount || 0),
          0,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: enrichedInvoices.length,
                  totalAmountNOK: totalAmount,
                  invoices: enrichedInvoices,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching active invoices: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
