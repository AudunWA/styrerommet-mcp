import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId } from "../client.ts";

const QUERY = `query userWithOrganizationQuery($obosCompanyNumber: OrganizationID!) {
  viewer {
    id
    name
    firstName
    personId
    lastName
    hasHousingCompanyRoles
    admin
    developer
    flags
    profilePhotoUrl
  }
  organization(id: $obosCompanyNumber) {
    id
    status
    obosCompanyNumber
    organizationNumber
    name
    slug
    obosEnabled
    onProperty
    apartmentsCount
    modulesAvailable
    intendedForTest
    organizationCode
    isHBEF
    usesSmarterMail
    viewerAsMember {
      id
      userId
      phoneNumber
      email
      roles
      permissions
    }
  }
}`;

export function registerViewerTools(server: McpServer): void {
  server.registerTool(
    "get_viewer",
    {
      description:
        "Get the current user's info, organization details, roles, and permissions",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const result = await graphqlQuery("userWithOrganizationQuery", QUERY, {
        obosCompanyNumber: getOrgId(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );
}
