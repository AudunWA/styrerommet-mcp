import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId, getOrgNodeId } from "../client.ts";

const SEARCH_QUERY = `query globalSearch($query: SearchQuery!, $organizationId: OrganizationID!) {
  search(organizationId: $organizationId, query: $query) {
    items {
      result {
        ... on Issue {
          id
          title
          createdAt
          createdBy {
            id
            name
          }
          meeting {
            id
            location
            date
          }
        }
        ... on Attachment {
          id
          filename
          url
        }
        ... on Task {
          id
          solved
          title
          createdAt
          description
          deadline
          assignedTo {
            id
            name
          }
        }
        ... on NewsletterContent {
          documentId
          title
          fileUrl
        }
        ... on HMSDeviation {
          id
          resolvedAt
          HMSDeviationCreatedAt: createdAt
          HMSDeviationDescription: description
        }
        ... on HMSRoutine {
          HMSRoutineId: id
          key
          deadline
          completedAt
          comments {
            id
            anchor
          }
        }
        typename: __typename
      }
      highlight {
        title
        highlight
        fullName
      }
    }
    total
    suggestions
  }
}`;

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    "search",
    {
      description:
        "Global search across all entities in Styrerommet (meetings, tasks, documents, HMS, etc.)",
      inputSchema: z.object({
        query: z.string().describe("The search query string"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query }) => {
      const orgNodeId = await getOrgNodeId();
      const result = await graphqlQuery("globalSearch", SEARCH_QUERY, {
        query: { text: query },
        organizationId: orgNodeId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );
}
