import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId } from "../client.ts";

const SMS_QUERY = `query smsDispatchesQuery(
  $organizationNumber: OrganizationID!
  $year: Int!
  $status: String
  $query: String
) {
  organization(id: $organizationNumber) {
    id
    smsStatistics(year: $year) {
      dispatchesSentTotal
      billableSms
      dispatchesAvailable
    }
    smsDispatches(year: $year, status: $status, query: $query) {
      dispatchId
      date
      sender
      message
      statistics {
        billable
        recipients
        failed
      }
    }
  }
}`;

const ANNOUNCEMENTS_QUERY = `query dashboardAnnouncements {
  dashboardAnnouncements {
    _id
    title
    description
    imageBlock
    linkUrl
    linkText
    priority
  }
}`;

export function registerCommunicationTools(server: McpServer): void {
  server.registerTool(
    "get_sms_dispatches",
    {
      description:
        "List SMS messages sent to residents in a given year, along with stats and statuses",
      inputSchema: z.object({
        year: z
          .number()
          .int()
          .default(new Date().getFullYear())
          .describe("The year to retrieve SMS logs for"),
        status: z
          .string()
          .optional()
          .describe("Filter by status (e.g. 'SENT', 'FAILED')"),
        query: z
          .string()
          .optional()
          .describe("Filter messages by a search query string"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ year, status, query }) => {
      const targetYear = year ?? new Date().getFullYear();
      const result = await graphqlQuery("smsDispatchesQuery", SMS_QUERY, {
        organizationNumber: getOrgId(),
        year: targetYear,
        status: status ?? null,
        query: query ?? null,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_announcements",
    {
      description:
        "Get general news and dashboard announcements from Styrerommet",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const result = await graphqlQuery(
        "dashboardAnnouncements",
        ANNOUNCEMENTS_QUERY,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );
}
