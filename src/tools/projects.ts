import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId } from "../client.ts";

const PROJECTS_LIST_QUERY = `query getAllMaintenanceProjectsQuery($organizationId: OrganizationID!) {
  maintenanceProjects(organizationId: $organizationId) {
    id
    title
    cost
    status
    createdAt
    description
    startDate
    disabled
    category {
      id
      title
    }
    subcategories {
      id
      title
    }
    areas {
      name
      id
      buildingId
      building {
        name
        id
      }
    }
    buildings {
      name
      id
    }
  }
}`;

const PROJECT_DETAIL_QUERY = `query fdvMaintenanceProject($projectId: NodeID!, $organizationNumber: OrganizationID!) {
  project: maintenanceProject(
    projectId: $projectId
    organizationId: $organizationNumber
  ) {
    id
    title
    description
    cost
    status
    startDate
    createdAt
    disabled
    category {
      id
      title
    }
    involved {
      type
      nameOrId
    }
    subcategories {
      id
      title
    }
    buildings {
      id
      name
    }
    areas {
      id
      name
    }
  }
}`;

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "list_maintenance_projects",
    {
      description:
        "List all building and maintenance projects (FDV) for the organization, including cost and status",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const result = await graphqlQuery(
        "getAllMaintenanceProjectsQuery",
        PROJECTS_LIST_QUERY,
        { organizationId: getOrgId() },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_maintenance_project",
    {
      description:
        "Get detailed information about a specific building or maintenance project (FDV) by its ID",
      inputSchema: z.object({
        projectId: z
          .string()
          .describe(
            "The project NodeID (e.g. 'TWFpbnRlbmFuY2VQcm9qZWN0Oi...')",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ projectId }) => {
      try {
        const result = await graphqlQuery(
          "fdvMaintenanceProject",
          PROJECT_DETAIL_QUERY,
          {
            organizationNumber: getOrgId(),
            projectId,
          },
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(result.data, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching maintenance project ${projectId}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
