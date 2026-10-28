import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId } from "../client.ts";
import { vibboGraphqlQuery, getVibboOrgSlug } from "../vibbo-client.ts";
import { vibboRegistry } from "../vibbo-registry.ts";

const RESIDENTS_QUERY = `query residentsPage($obosCompanyNumber: OrganizationID!) {
  organization(id: $obosCompanyNumber) {
    id
    residents(
      types: [OWNER, HOUSING_MANAGER, TENANT, CORESIDENT, RELATIVE, FUTURE_OWNER]
    ) {
      id
      name
      roles
      personId
      firstName
      lastName
      loggedInToVibbo
      primaryResidentType
      electronicConsent
      profilePhotoUrl
      phoneNumber
      email
      residencies {
        id
        type
        contractStart
        contractEnd
        apartment {
          id
          apartmentNumber
          objectType
        }
      }
    }
  }
}`;

export function registerResidentTools(server: McpServer): void {
  server.registerTool(
    "list_residents",
    {
      description:
        "List residents/members of the organization with unified data across Styrerommet and Vibbo (apartment number, H-number, street address, phone, email, owner/tenant role, login status)",
      inputSchema: z.object({
        source: z
          .enum(["ALL", "STYREROMMET", "VIBBO"])
          .default("ALL")
          .describe(
            "Data source to retrieve: ALL (combines Styrerommet and Vibbo data), STYREROMMET, or VIBBO",
          ),
        apartmentNumber: z
          .number()
          .int()
          .optional()
          .describe("Filter residents by logical apartment number (e.g. 38)"),
        query: z
          .string()
          .optional()
          .describe(
            "Filter residents by name, email, or phone number substring",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ source, apartmentNumber, query }) => {
      const src = source ?? "ALL";
      let sResidents: any[] = [];
      let vResidents: any[] = [];

      // Fetch Styrerommet
      if (src === "ALL" || src === "STYREROMMET") {
        try {
          const result = await graphqlQuery<any>(
            "residentsPage",
            RESIDENTS_QUERY,
            { obosCompanyNumber: getOrgId() },
          );
          sResidents = result.data?.organization?.residents || [];
        } catch (e: any) {
          console.error("Styrerommet residents fetch error:", e.message);
        }
      }

      // Fetch Vibbo
      if (src === "ALL" || src === "VIBBO") {
        try {
          const op = vibboRegistry.get("vibboResidentAdministrationPage");
          if (op) {
            const result = await vibboGraphqlQuery<any>(
              op.operationName,
              op.queryText,
              { organizationSlug: getVibboOrgSlug() },
            );
            vResidents = result.data?.organization?.residents || [];
          }
        } catch (e: any) {
          console.error("Vibbo residents fetch error:", e.message);
        }
      }

      let mergedList: any[] = [];

      if (src === "STYREROMMET") {
        mergedList = sResidents.map((sr) => ({
          ...sr,
          apartmentNumber: sr.residencies?.[0]?.apartment?.apartmentNumber,
          source: "styrerommet",
        }));
      } else if (source === "VIBBO") {
        mergedList = vResidents.map((vr) => {
          const vApt = vr.residencies?.[0]?.apartment;
          return {
            ...vr,
            apartmentNumber: vApt?.apartmentNumber,
            address: vApt?.address,
            residentialNumber: vApt?.residentialNumber,
            source: "vibbo",
          };
        });
      } else {
        // ALL: Merge by personId
        const mergedMap = new Map<string, any>();

        for (const sr of sResidents) {
          const key = sr.personId || sr.id;
          mergedMap.set(key, {
            id: sr.id,
            personId: sr.personId,
            name: sr.name,
            firstName: sr.firstName,
            lastName: sr.lastName,
            roles: sr.roles || [],
            primaryResidentType: sr.primaryResidentType,
            loggedInToVibbo: sr.loggedInToVibbo,
            electronicConsent: sr.electronicConsent,
            phoneNumber: sr.phoneNumber,
            email: sr.email,
            apartmentNumber: sr.residencies?.[0]?.apartment?.apartmentNumber,
            sources: ["styrerommet"],
          });
        }

        for (const vr of vResidents) {
          const key = vr.personId || vr.id;
          const vApt = vr.residencies?.[0]?.apartment;
          const existing = mergedMap.get(key);
          if (existing) {
            existing.sources.push("vibbo");
            existing.phoneNumber =
              existing.phoneNumber ||
              vr.phoneNumber ||
              vr.residencies?.[0]?.resident?.phoneNumber;
            existing.email =
              existing.email ||
              vr.email ||
              vr.residencies?.[0]?.resident?.email;
            existing.address = vApt?.address;
            existing.residentialNumber = vApt?.residentialNumber;
            existing.apartmentNumber =
              existing.apartmentNumber ?? vApt?.apartmentNumber;
          } else {
            mergedMap.set(key, {
              id: vr.id,
              personId: vr.personId,
              name: vr.name,
              firstName: vr.firstName,
              lastName: vr.lastName,
              roles: vr.permissions || [],
              primaryResidentType: vr.primaryResidentType,
              phoneNumber:
                vr.phoneNumber || vr.residencies?.[0]?.resident?.phoneNumber,
              email: vr.email || vr.residencies?.[0]?.resident?.email,
              address: vApt?.address,
              residentialNumber: vApt?.residentialNumber,
              apartmentNumber: vApt?.apartmentNumber,
              sources: ["vibbo"],
            });
          }
        }
        mergedList = [...mergedMap.values()];
      }

      // Filter by apartmentNumber
      if (apartmentNumber !== undefined) {
        mergedList = mergedList.filter(
          (r) => r.apartmentNumber === apartmentNumber,
        );
      }

      // Filter by query string
      if (query) {
        const q = query.toLowerCase();
        mergedList = mergedList.filter((r) => {
          const name = (r.name || `${r.firstName} ${r.lastName}`).toLowerCase();
          const email = (r.email || "").toLowerCase();
          const phone = (r.phoneNumber || "").toLowerCase();
          return name.includes(q) || email.includes(q) || phone.includes(q);
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: mergedList.length,
                residents: mergedList,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  const CONTACT_QUERY = `query residentContactQuery($organizationNumber: OrganizationID!, $personId: ID!) {
    organization(id: $organizationNumber) {
      resident: member(personId: $personId) {
        id
        roles
        email
        phoneNumber
        electronicConsent
        hasSmsConsent
        hasEmailConsent
        hasPostEmailConsent
        hasCommentEmailConsent
        flags
      }
    }
  }`;

  server.registerTool(
    "get_resident_contact_details",
    {
      description:
        "Get detailed email, phone number, roles, and communication consents (SMS/email preferences) for a resident by their personId",
      inputSchema: z.object({
        personId: z
          .string()
          .optional()
          .describe(
            "The resident's personId NodeID/UUID (retrieved via list_residents or analyze_apartment)",
          ),
        id: z.string().optional().describe("Alternative ID or personId"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ personId, id }) => {
      let targetPersonId = personId ?? id;
      if (!targetPersonId) {
        try {
          const listRes = await graphqlQuery<any>(
            "residentsPage",
            `query residentsPage($obosCompanyNumber: OrganizationID!) { organization(id: $obosCompanyNumber) { residents(types: [OWNER, HOUSING_MANAGER, TENANT]) { personId } } }`,
            { obosCompanyNumber: getOrgId() },
          );
          targetPersonId = listRes.data?.organization?.residents?.[0]?.personId;
        } catch {}
      }

      if (!targetPersonId) {
        return {
          content: [{ type: "text", text: "No personId specified or found." }],
          isError: true,
        };
      }

      try {
        const result = await graphqlQuery(
          "residentContactQuery",
          CONTACT_QUERY,
          {
            organizationNumber: getOrgId(),
            personId: targetPersonId,
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
              text: `Error fetching resident contact details for ${targetPersonId}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
