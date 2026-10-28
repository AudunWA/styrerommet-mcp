import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId } from "../client.ts";

const EXPENSES_LIST_QUERY = `query expensesPage($organizationId: OrganizationID!) {
  expenses: searchExpenses(organizationId: $organizationId) {
    id
    payee
    status
    createdAt
    approvalUrl
    viewerShouldApprove
    lines {
      id
      categoryDescription
      description
      createdAt
      amount
      status
      attachment {
        id
        url
        contentType
        filename
      }
      approvals {
        approved
        rejected
        approvedByName
        approvedAt
      }
    }
  }
}`;

const EXPENSE_DETAIL_QUERY = `query invoiceExpenseDetailsPage($organizationId: OrganizationID!, $expenseId: NodeID!) {
  invoiceExpense(organizationId: $organizationId, expenseId: $expenseId) {
    id
    createdAt
    dueDate
    category
    description
    amount
    approvalStatus
    participants {
      personId
      name
    }
    viewerActions {
      canApprove
      canReject
      canForward
      forwardableMembers {
        id
        personId
        name
      }
    }
    recipient {
      name
      accountNumber
    }
    pendingApprover {
      personId
      name
    }
    statusInfo {
      status
      lastUpdatedAt
      comment {
        text
        action
        createdBy
        createdAt
      }
    }
    attachments {
      id
      name
      downloadUrl
    }
    source {
      attachments {
        id
        filename
        contentType
        url
      }
    }
    steps {
      personId
      name
      state
      stepCompletedAt
    }
  }
}`;

const INVOICE_EXPENSES_LIST_QUERY = `query invoiceExpenseManagementPage($organizationId: OrganizationID!) {
  invoiceExpenses(organizationId: $organizationId) {
    id
    createdAt
    dueDate
    category
    description
    amount
    approvalStatus
    participants {
      personId
      name
    }
    recipient {
      name
      accountNumber
    }
    pendingApprover {
      id
      personId
      name
    }
    statusInfo {
      status
      lastUpdatedAt
    }
  }
}`;

export function registerExpenseTools(server: McpServer): void {
  server.registerTool(
    "list_expenses",
    {
      description:
        "List all out-of-pocket expenses (utlegg) for the organization, including payee, status, lines, and amounts",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await graphqlQuery<{ invoiceExpenses?: Array<any> }>(
          "invoiceExpenseManagementPage",
          INVOICE_EXPENSES_LIST_QUERY,
          { organizationId: getOrgId() },
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(result.data, null, 2) },
          ],
        };
      } catch {
        // Fallback to legacy searchExpenses
        const fallback = await graphqlQuery(
          "expensesPage",
          EXPENSES_LIST_QUERY,
          { organizationId: getOrgId() },
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(fallback.data, null, 2) },
          ],
        };
      }
    },
  );

  server.registerTool(
    "get_expense",
    {
      description:
        "Get detailed information about a specific out-of-pocket expense (utlegg) by its ID",
      inputSchema: z.object({
        expenseId: z
          .string()
          .optional()
          .describe("The expense NodeID (e.g. 'SW52b2ljZUV4cGVuc2U6...')"),
        id: z.string().optional().describe("Alternative ID for the expense"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ expenseId, id }) => {
      let targetId = expenseId ?? id;

      try {
        // 1. Check modern invoiceExpenses
        const modernRes = await graphqlQuery<{ invoiceExpenses?: Array<any> }>(
          "invoiceExpenseManagementPage",
          INVOICE_EXPENSES_LIST_QUERY,
          { organizationId: getOrgId() },
        );
        const modernList = modernRes.data?.invoiceExpenses || [];

        if (!targetId && modernList.length > 0) {
          targetId = modernList[0].id;
        }

        if (targetId) {
          const foundModern = modernList.find(
            (e) => e.id === targetId || e.id?.includes(targetId!),
          );
          if (foundModern) {
            return {
              content: [
                { type: "text", text: JSON.stringify(foundModern, null, 2) },
              ],
            };
          }
        }

        // 2. Check legacy searchExpenses
        let isLegacy = false;
        if (targetId) {
          try {
            const decoded = Buffer.from(targetId, "base64").toString("utf-8");
            if (
              decoded.startsWith("Expense:") ||
              targetId.startsWith("Expense:")
            ) {
              isLegacy = true;
            }
          } catch {}
        }

        if (isLegacy || !targetId) {
          try {
            const listRes = await graphqlQuery<{ expenses?: Array<any> }>(
              "expensesPage",
              EXPENSES_LIST_QUERY,
              { organizationId: getOrgId() },
            );
            const legacyList = listRes.data?.expenses || [];
            if (!targetId && legacyList.length > 0) {
              targetId = legacyList[0].id;
            }
            const foundLegacy = legacyList.find((e) => e.id === targetId);
            if (foundLegacy) {
              return {
                content: [
                  { type: "text", text: JSON.stringify(foundLegacy, null, 2) },
                ],
              };
            }
          } catch {}
        }

        if (!targetId) {
          return {
            content: [
              { type: "text", text: "No expenseId specified or found." },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `Expense "${targetId}" not found.` }],
          isError: true,
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching expense "${targetId}": ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
