import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { graphqlQuery, getOrgId } from "../client.ts";
import { z } from "zod";

const AUDIT_LOGS_QUERY = `query getAuditLogsByOrganizationId($organizationId: OrganizationID!) {
  getAuditLogsByOrganizationId(organizationId: $organizationId) {
    id
    action
    createdAt
    parent {
      id
      title
    }
    createdBy {
      id
      personId
      name
    }
    payload {
      result
      data {
        action
        ... on UpdateMemberAccountLog {
          accountNumber
          personId
          name
          confirmed
          oldAccountNumber
        }
        ... on ConfirmPaymentOrder {
          paymentOrderId
        }
        ... on CreatePaymentOrder {
          payments {
            amount
            paymentId
            recipient {
              name
              personId
              accountNumberEncoded
            }
          }
        }
        ... on UpdatePaymentsLog {
          updates {
            field
            meta {
              name
              personId
            }
            newValue
            oldValue
            operation
            valueType
          }
        }
        ... on BoardFeeTotalAmountChangeLog {
          assemblyId
          currentTotalAmount
          proposedTotalAmount
          reason
          issueId
        }
        __typename
      }
    }
  }
}`;

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "get_audit_logs",
    {
      description:
        "Get a complete audit log of all significant actions taken in the organization (payments, member updates, board fee changes)",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const result = await graphqlQuery(
        "getAuditLogsByOrganizationId",
        AUDIT_LOGS_QUERY,
        {
          organizationId: getOrgId(),
        },
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );
}
