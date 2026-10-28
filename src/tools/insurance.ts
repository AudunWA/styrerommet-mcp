import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId } from "../client.ts";

const INSURANCE_QUERY = `query insurancePage($organizationNumber: OrganizationID!) {
  organization(id: $organizationNumber) {
    id
    name
    organizationNumber
    insurance {
      policy {
        insuranceCompanyName
        insuranceIssuedViaObos
        insuranceCompanyNumber
        policyNumber
        insuranceDocuments {
          date
          category
          url
          type
          fileName
        }
      }
      cases {
        caseNumber
        claimDate
        claimLocation
        status
        reasonForClaim
        claimReporter
      }
    }
  }
}`;

const INSURANCE_CASE_QUERY = `query insuranceCasePage($organizationNumber: OrganizationID!, $caseNumber: Int!) {
  insuranceCase: getInsuranceCase(
    input: {organizationId: $organizationNumber, caseNumber: $caseNumber}
  ) {
    caseNumber
    claimDate
    claimLocation
    status
    reasonForClaim
    claimReporter
    description {
      title
      body
    }
    messages {
      body
      registeredAt
    }
    affectedResidents {
      firstName
      lastName
      unitNumber
      objectNumber
      emailAddress
      phoneNumber
      address
      personId
    }
    phases {
      name
      completed
      completedAt
      status
    }
  }
}`;

export function registerInsuranceTools(server: McpServer): void {
  server.registerTool(
    "get_insurance_overview",
    {
      description:
        "Get detailed information about the organization's insurance policies, renewal documents, and active/historical insurance claims/cases",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const result = await graphqlQuery("insurancePage", INSURANCE_QUERY, {
        organizationNumber: getOrgId(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_insurance_case",
    {
      description:
        "Get full details for a specific insurance claim/case, including messages, damage descriptions, and affected residents",
      inputSchema: z.object({
        caseNumber: z
          .union([z.number(), z.string()])
          .optional()
          .describe(
            "The case number (e.g. 14196, 20692) which can be found in the overview",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ caseNumber }) => {
      let num = caseNumber
        ? typeof caseNumber === "number"
          ? caseNumber
          : parseInt(String(caseNumber), 10)
        : undefined;
      if (!num || isNaN(num)) {
        try {
          const overview = await graphqlQuery<any>(
            "insurancePage",
            INSURANCE_QUERY,
            { organizationNumber: getOrgId() },
          );
          num = overview.data?.organization?.insurance?.cases?.[0]?.caseNumber;
        } catch {}
      }
      if (!num) {
        return {
          content: [
            {
              type: "text",
              text: "No insurance caseNumber specified or found.",
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await graphqlQuery(
          "insuranceCasePage",
          INSURANCE_CASE_QUERY,
          {
            organizationNumber: getOrgId(),
            caseNumber: num,
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
              text: `Error fetching insurance case #${caseNumber}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
