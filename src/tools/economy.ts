import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId } from "../client.ts";
import { buildEconomyWebUrl } from "../urls.ts";
import { registry } from "../registry.ts";

const ECONOMY_QUERY = `query economyBankInformation($organizationId: OrganizationID!) {
  organization(id: $organizationId) {
    id
    systemContacts {
      id
      firstName
      lastName
      jobTitle
      role
      email
    }
    accounts {
      type
      name
      accountNumber
      availableAmount
      updatedAt
    }
    loans {
      saldo
      loanType
      bankName
      isObosLoan
      greenLoan
      loanNumber
      loanDescription
      interestRate
      completedPayments
      remainingPayments
      nextPaymentDate
      nextPaymentAmount
      numberOfPayments
      individualPayment
      fixedRate
    }
  }
}`;

const TRANSACTIONS_QUERY = `query transactionsPage($accountNumber: ID!, $obosCompanyNumber: OrganizationID!) {
  organization(id: $obosCompanyNumber) {
    id
    accounts {
      id
      name
      type
      accountNumber
    }
    account(accountNumber: $accountNumber) {
      id
      accountNumber
      availableAmount
      name
      updatedAt
      transactions {
        amount
        text
        bookedDate
      }
      creditDetails {
        grantedAmount
        availableBalance
        usedCredit
        interest
        commission
      }
    }
  }
}`;

const REPAYMENT_PLAN_QUERY = `query repaymentPlan($organizationNumber: OrganizationID!, $loanType: String!, $loanNumber: String!) {
  organization(id: $organizationNumber) {
    id
    loan(loanType: $loanType, loanNumber: $loanNumber) {
      loanNumber
      loanDescription
      loanType
      bankName
      isObosLoan
      greenLoan
      interestRate
      individualPayment
      fixedRate
      nextPaymentDate
      remainingPayments
      numberOfPayments
      saldo
      repaymentPlanTerms {
        termNumber
        dueDate
        deduction
        interest
        fee
        amount
        balance
      }
      repaymentPlanYears {
        year
        deduction
        interest
        fee
        amount
        balance
      }
    }
  }
}`;

export function registerEconomyTools(server: McpServer): void {
  server.registerTool(
    "get_economy",
    {
      description:
        "Get economy overview: bank accounts, balances, loans, system contacts, and direct 'webUrl' link to Styrerommet economy section",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const orgId = getOrgId();
        const result = await graphqlQuery(
          "economyBankInformation",
          ECONOMY_QUERY,
          { organizationId: orgId },
        );
        const data = (result.data as any) || {};
        const webUrl = buildEconomyWebUrl(orgId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...data, webUrl }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching economy overview: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get_transactions",
    {
      description:
        "Get transactions for a specific bank account. Defaults to primary bank account if omitted.",
      inputSchema: z.object({
        accountNumber: z
          .string()
          .optional()
          .describe(
            "The bank account number to get transactions for. Defaults to primary account if omitted.",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ accountNumber }) => {
      let accNum = accountNumber;
      if (!accNum) {
        try {
          const econ = await graphqlQuery<any>(
            "economyBankInformation",
            ECONOMY_QUERY,
            { organizationId: getOrgId() },
          );
          accNum = econ.data?.organization?.accounts?.[0]?.accountNumber;
        } catch {}
      }
      if (!accNum) {
        return {
          content: [
            { type: "text", text: "No bank account found or specified." },
          ],
          isError: true,
        };
      }

      try {
        const result = await graphqlQuery(
          "transactionsPage",
          TRANSACTIONS_QUERY,
          {
            accountNumber: accNum,
            obosCompanyNumber: getOrgId(),
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
              text: `Error fetching transactions for account ${accNum}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get_loan_repayment_plan",
    {
      description:
        "Get detailed amortization schedule and repayment plan (terms and years) for a specific loan. Defaults to the primary loan if omitted.",
      inputSchema: z.object({
        loanType: z
          .string()
          .optional()
          .describe("The type of loan (e.g. 'OBOS_LOAN', 'OTHER_LOAN')"),
        loanNumber: z
          .string()
          .optional()
          .describe("The loan number identifier"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ loanType, loanNumber }) => {
      let lType = loanType;
      let lNum = loanNumber;
      if (!lType || !lNum) {
        try {
          const econ = await graphqlQuery<any>(
            "economyBankInformation",
            ECONOMY_QUERY,
            { organizationId: getOrgId() },
          );
          const firstLoan = econ.data?.organization?.loans?.[0];
          lType = lType ?? firstLoan?.loanType;
          lNum = lNum ?? firstLoan?.loanNumber;
        } catch {}
      }
      if (!lType || !lNum) {
        return {
          content: [
            {
              type: "text",
              text: "No active loan found or specified for repayment plan.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await graphqlQuery(
          "repaymentPlan",
          REPAYMENT_PLAN_QUERY,
          {
            organizationNumber: getOrgId(),
            loanType: lType,
            loanNumber: lNum,
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
              text: `Error fetching repayment plan for loan ${lNum}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "analyze_apartment",
    {
      description:
        "Comprehensive analysis of a single apartment/unit: ownership, occupancy, size, address, and percentage contribution to cooperative's total shared cost income and area",
      inputSchema: z.object({
        apartmentNumber: z
          .union([z.number(), z.string()])
          .describe("The logical apartment number (e.g. 38)"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ apartmentNumber }) => {
      const orgId = getOrgId();
      const aptNum =
        typeof apartmentNumber === "number"
          ? apartmentNumber
          : parseInt(String(apartmentNumber), 10);

      // 1. Fetch all apartments to calculate cooperative totals
      const housingRes = await graphqlQuery<{
        organization?: {
          apartments?: Array<{
            apartmentNumber: number;
            sharedCost: number | null;
            area: number | null;
          }>;
        };
      }>("customHousingPage", HOUSING_LIST_QUERY, { obosCompanyNumber: orgId });

      const apartments = housingRes.data?.organization?.apartments || [];
      let totalSharedCost = 0;
      let totalArea = 0;
      for (const apt of apartments) {
        totalSharedCost += apt.sharedCost || 0;
        totalArea += apt.area || 0;
      }

      // 2. Fetch specific apartment details
      const detailRes = await graphqlQuery<{
        organization?: {
          residence?: {
            id: string;
            apartmentNumber: number;
            unitNumber: string | null;
            residentialNumber: string | null;
            address: string | null;
            rented: boolean;
            extraArea: number | null;
            area: number | null;
            numberOfRooms: number | null;
            apartmentType: string | null;
            buildingType: string | null;
            sharedCost: number | null;
            amountDue: number | null;
            objectType: string | null;
            insuranceCases?: Array<any>;
            nextResidence?: { id: string; apartmentNumber: number } | null;
            previousResidence?: { id: string; apartmentNumber: number } | null;
            owners?: Array<{
              id: string;
              type: string;
              contractStart: string | null;
              contractEnd: string | null;
            }>;
            tenants?: Array<{
              id: string;
              type: string;
              contractStart: string | null;
              contractEnd: string | null;
            }>;
            coresidents?: Array<{ id: string; type: string }>;
            relatives?: Array<{ id: string; type: string }>;
          };
        };
      }>("residencePage", RESIDENCE_DETAIL_QUERY, {
        obosCompanyNumber: orgId,
        apartmentNumber: aptNum,
      });

      const residence = detailRes.data?.organization?.residence;
      if (!residence) {
        return {
          content: [
            { type: "text", text: `Apartment ${apartmentNumber} not found.` },
          ],
          isError: true,
        };
      }

      // Calculate shares
      const monthlyCost = residence.sharedCost || 0;
      const annualCost = monthlyCost * 12;
      const costSharePercent =
        totalSharedCost > 0 ? (monthlyCost / totalSharedCost) * 100 : 0;

      const aptArea = residence.area || 0;
      const areaSharePercent = totalArea > 0 ? (aptArea / totalArea) * 100 : 0;

      // Helper to process and decode residencies
      const processResidencies = (list: typeof residence.owners) => {
        if (!list) return [];
        return list.map((item) => {
          const decoded = decodeResidencyId(item.id);
          return {
            type: item.type,
            contractStart: item.contractStart,
            contractEnd: item.contractEnd,
            personId: decoded?.personId || "N/A",
            name: decoded?.name || "Unknown",
          };
        });
      };

      const decodedOwners = processResidencies(residence.owners);
      const decodedTenants = processResidencies(residence.tenants);
      const decodedCoresidents = processResidencies(
        residence.coresidents as any,
      );
      const decodedRelatives = processResidencies(residence.relatives as any);

      const analysis = {
        apartmentNumber: residence.apartmentNumber,
        unitNumber: residence.unitNumber,
        hNumber: residence.residentialNumber,
        address: residence.address,
        objectType: residence.objectType,
        buildingType: residence.buildingType,
        apartmentType: residence.apartmentType,
        areaM2: residence.area,
        extraAreaM2: residence.extraArea,
        numberOfRooms: residence.numberOfRooms,
        rented: residence.rented,
        insuranceCases: residence.insuranceCases || [],
        adjacentApartments: {
          previous: residence.previousResidence?.apartmentNumber || null,
          next: residence.nextResidence?.apartmentNumber || null,
        },
        finances: {
          monthlySharedCostNok: monthlyCost,
          annualSharedCostNok: annualCost,
          amountDueNok: residence.amountDue || 0,
        },
        shares: {
          monthlySharedCostContributionPercent: parseFloat(
            costSharePercent.toFixed(4),
          ),
          residentialAreaContributionPercent: parseFloat(
            areaSharePercent.toFixed(4),
          ),
          cooperativeTotalMonthlySharedCostNok: parseFloat(
            totalSharedCost.toFixed(2),
          ),
          cooperativeTotalResidentialAreaM2: parseFloat(totalArea.toFixed(2)),
        },
        owners: decodedOwners,
        tenants: decodedTenants,
        coresidents: decodedCoresidents,
        relatives: decodedRelatives,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }],
      };
    },
  );

  server.registerTool(
    "list_apartments",
    {
      description:
        "List all apartments/objects in the cooperative with basic details like number, area, rooms, and shared cost",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const orgId = getOrgId();
      const housingRes = await graphqlQuery(
        "customHousingPage",
        HOUSING_LIST_QUERY,
        { obosCompanyNumber: orgId },
      );

      const apartments =
        (housingRes.data as any)?.organization?.apartments || [];
      return {
        content: [{ type: "text", text: JSON.stringify(apartments, null, 2) }],
      };
    },
  );

  server.registerTool(
    "list_other_objects",
    {
      description:
        "List non-apartment housing objects in the cooperative: commercial units (lokaler), storage units (boder), bicycle garages (sykkelgarasje), and parking spaces",
      inputSchema: z.object({
        includeParkings: z
          .boolean()
          .default(true)
          .describe("Whether to include parking spots"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ includeParkings }) => {
      const orgId = getOrgId();
      const incParkings = includeParkings ?? true;
      const otherOp = registry.get("fetchOtherObjects");
      const otherRes = await graphqlQuery<any>(
        otherOp?.operationName ?? "fetchOtherObjects",
        otherOp?.queryText ??
          `query fetchOtherObjects($obosCompanyNumber: OrganizationID!) {
          organization(id: $obosCompanyNumber) {
            id
            objects: otherObjects {
              id
              address
              objectNumber: apartmentNumber
              type: apartmentType
              objectType
            }
          }
        }`,
        { obosCompanyNumber: orgId },
      );

      let otherObjects = otherRes.data?.organization?.objects ?? [];

      let parkings: any[] = [];
      if (incParkings) {
        const parkOp = registry.get("fetchParkings");
        if (parkOp) {
          const parkRes = await graphqlQuery<any>(
            parkOp.operationName,
            parkOp.queryText,
            { obosCompanyNumber: orgId },
          );
          parkings = parkRes.data?.organization?.objects ?? [];
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                totalOtherObjects: otherObjects.length,
                totalParkings: parkings.length,
                otherObjects,
                parkings,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_other_object_details",
    {
      description:
        "Get detailed information for a specific non-apartment housing object (commercial unit, storage unit, etc.) by its objectNumber",
      inputSchema: z.object({
        objectNumber: z
          .union([z.number(), z.string()])
          .optional()
          .describe("The objectNumber of the unit (e.g. 70003)"),
        id: z.string().optional().describe("Alternative ID or objectNumber"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ objectNumber, id }) => {
      const orgId = getOrgId();
      let rawVal = objectNumber ?? id;
      if (!rawVal) {
        try {
          const listRes = await graphqlQuery<any>(
            "fetchOtherObjects",
            `query fetchOtherObjects($obosCompanyNumber: OrganizationID!) { organization(id: $obosCompanyNumber) { objects: otherObjects { apartmentNumber } } }`,
            { obosCompanyNumber: orgId },
          );
          rawVal = listRes.data?.organization?.objects?.[0]?.apartmentNumber;
        } catch {}
      }

      if (!rawVal) {
        return {
          content: [
            { type: "text", text: "No objectNumber or id specified or found." },
          ],
          isError: true,
        };
      }

      let num =
        typeof rawVal === "number" ? rawVal : parseInt(String(rawVal), 10);
      if (isNaN(num)) {
        try {
          const decoded = Buffer.from(String(rawVal), "base64").toString(
            "utf-8",
          );
          const match = decoded.match(/\d+/);
          if (match) num = parseInt(match[0], 10);
        } catch {}
      }

      try {
        const detailOp = registry.get("otherObjectsDetailPage");
        const result = await graphqlQuery<any>(
          detailOp?.operationName ?? "otherObjectsDetailPage",
          detailOp?.queryText ??
            `query otherObjectsDetailPage($obosCompanyNumber: OrganizationID!, $objectNumber: Int!) {
                    organization(id: $obosCompanyNumber) {
                      id
                      object: housingObject(apartmentNumber: $objectNumber) {
                        id
                        address
                        objectNumber: apartmentNumber
                        type: apartmentType
                      }
                    }
                  }`,
          {
            obosCompanyNumber: orgId,
            objectNumber: num,
          },
        );

        const obj = result.data?.organization?.object;
        if (!obj) {
          return {
            content: [{ type: "text", text: `Object #${rawVal} not found.` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching object details for #${rawVal}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

const HOUSING_LIST_QUERY = `query customHousingPage($obosCompanyNumber: OrganizationID!) {
  organization(id: $obosCompanyNumber) {
    id
    apartments {
      id
      apartmentNumber
      unitNumber
      residentialNumber
      address
      sharedCost
      area
      numberOfRooms
    }
  }
}`;

const RESIDENCE_DETAIL_QUERY = `query residencePage($obosCompanyNumber: OrganizationID!, $apartmentNumber: Int!) {
  organization(id: $obosCompanyNumber) {
    id
    residence: housingObject(apartmentNumber: $apartmentNumber) {
      id
      apartmentNumber
      unitNumber
      residentialNumber
      address
      rented
      extraArea
      area
      numberOfRooms
      apartmentType
      buildingType
      sharedCost
      amountDue
      objectType
      insuranceCases {
        caseNumber
        claimDate
        reasonForClaim
        status
      }
      nextResidence: nextHousingObject {
        id
        apartmentNumber
      }
      previousResidence: previousHousingObject {
        id
        apartmentNumber
      }
      owners: residencies(type: [OWNER, HOUSING_MANAGER, FUTURE_OWNER]) {
        id
        type
        contractStart
        contractEnd
      }
      tenants: residencies(type: TENANT) {
        id
        type
        contractStart
        contractEnd
      }
      coresidents: residencies(type: CORESIDENT) {
        id
        type
      }
      relatives: residencies(type: RELATIVE) {
        id
        type
      }
    }
  }
}`;

function decodeResidencyId(
  id: string,
): {
  type: string;
  orgId: string;
  apartmentNumber: string;
  personId: string;
  name: string;
} | null {
  try {
    const decoded = Buffer.from(id, "base64").toString("utf-8");
    const parts = decoded.split(":");
    if (parts.length >= 6) {
      return {
        type: parts[1] || "",
        orgId: parts[2] || "",
        apartmentNumber: parts[3] || "",
        personId: parts[4] || "",
        name: parts[5] || "",
      };
    }
  } catch {}
  return null;
}
