import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId, getOrgNodeId } from "../client.ts";
import { buildSupplierWebUrl } from "../urls.ts";
import {
  READ_ONLY_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
} from "../annotations.ts";

const SUPPLIERS_QUERY = `query allSuppliers($obosCompanyNumber: ID!, $options: SuppliersOptions) {
  categories: supplierCategories(obosCompanyNumber: $obosCompanyNumber) {
    id
    categoryId
    name
    subcategories {
      id
      categoryId
      name
    }
  }
  suppliers: suppliers(obosCompanyNumber: $obosCompanyNumber, options: $options) {
    total
    items {
      id
      name
      officialName
      logo
      organizationNumber
      favourite
      categories {
        id
        name
      }
      contacts {
        name
        phoneNumber
        email
      }
      distanceToClient
      obosContracted
      contracts {
        id
        active
        startDate
        renewalDate
        endDate
        description
        ongoingContract
        types
      }
    }
  }
}`;

const SUPPLIER_DETAIL_QUERY = `query supplierPage($obosCompanyNumber: ID!, $supplierId: NodeID!, $months: Int = 12) {
  organization: organizationByObosNumber(companyNumber: $obosCompanyNumber) {
    id
    obosCompanyNumber
  }
  viewer {
    id
    personId
    name
  }
  supplier(obosCompanyNumber: $obosCompanyNumber, supplierId: $supplierId) {
    id
    name
    officialName
    organizationNumber
    categories {
      id
      name
    }
    obosContracted
    discontinued
    logo
    favourite
    article
    attachments {
      id
      filename
      url
      contentType
    }
    ...SupplierContactInfo
    ...SupplierContacts
    ...DetailedSupplierContracts
    monthlySpending(numberOfMonths: $months) {
      lastInvoiceDate
      data {
        month
        amount
      }
      dataUpdatedAt
    }
  }
}
fragment SupplierContactInfo on Supplier {
  contactInfo {
    phoneNumber
    email
    website
    address
    postalCode
    postalArea
    organizationNumber
  }
}
fragment SupplierContacts on Supplier {
  contacts {
    id
    name
    position
    phoneNumber
    email
  }
}
fragment DetailedSupplierContracts on Supplier {
  contracts {
    id
    active
    startDate
    renewalDate
    endDate
    ongoingContract
    description
    types
    attachments {
      id
      filename
      url
      contentType
    }
  }
}`;

const CONTRACTS_QUERY = `query fdvAllSuppliersContractDetail($obosCompanyNumber: ID!, $options: SuppliersOptions) {
  suppliers(obosCompanyNumber: $obosCompanyNumber, options: $options) {
    items {
      id
      name
      logo
      organizationNumber
      obosContracted
      contracts {
        types
        id
        active
        startDate
        renewalDate
        endDate
        description
        ongoingContract
      }
    }
  }
}`;

const SET_SUPPLIER_FAVOURITE_MUTATION = `mutation setSupplierFavourite($input: ChangeSupplierFavouriteInput!) {
  setSupplierFavourite(input: $input) {
    id
    favourite
  }
}`;

const UPDATE_SUPPLIER_ARTICLE_MUTATION = `mutation updateSupplierArticle($input: UpdateSupplierArticleInput!) {
  updateSupplierArticle(input: $input) {
    id
    article
  }
}`;

const ADD_CONTACT_MUTATION = `mutation addContactToSupplier($input: AddSupplierContactInput) {
  addContactToSupplier(input: $input) {
    id
    name
    position
    phoneNumber
    email
  }
}`;

const UPDATE_CONTACT_MUTATION = `mutation updateSupplierContact($input: UpdateSupplierContactInput) {
  updateSupplierContact(input: $input) {
    id
    name
    position
    phoneNumber
    email
  }
}`;

const REMOVE_CONTACT_MUTATION = `mutation removeSupplierContact($supplierContactId: NodeID!) {
  removeSupplierContact(supplierContactId: $supplierContactId) {
    id
  }
}`;

const ADD_CONTRACT_MUTATION = `mutation addSupplierContract($input: AddSupplierContractInput!) {
  addSupplierContract(input: $input) {
    id
    active
    startDate
    renewalDate
    endDate
    ongoingContract
    description
    types
    attachments {
      id
      filename
      url
      contentType
    }
  }
}`;

const UPDATE_CONTRACT_MUTATION = `mutation updateSupplierContract($input: UpdateSupplierContractInput!) {
  updateSupplierContract(input: $input) {
    id
    active
    startDate
    renewalDate
    description
    endDate
    ongoingContract
    types
    attachments {
      id
      filename
      url
      contentType
    }
  }
}`;

const REMOVE_CONTRACT_MUTATION = `mutation removeSupplierContract($supplierContract: RemoveSupplierContractInput!) {
  removeSupplierContract(input: $supplierContract) {
    id
    contracts {
      id
      active
      startDate
      renewalDate
      endDate
      ongoingContract
      description
      types
      attachments {
        id
        filename
        url
        contentType
      }
    }
  }
}`;

const ADD_CONTRACT_ATTACHMENT_MUTATION = `mutation addSupplierContractAttachment($input: SupplierContractAttachmentInput!) {
  addSupplierContractAttachment(input: $input) {
    id
    filename
    url
    contentType
  }
}`;

const REMOVE_CONTRACT_ATTACHMENT_MUTATION = `mutation removeSupplierContractAttachment($input: SupplierContractAttachmentInput!) {
  removeSupplierContractAttachment(input: $input) {
    id
  }
}`;

const ADD_SUPPLIER_ATTACHMENT_MUTATION = `mutation addSupplierAttachment($input: SupplierAttachmentInput!) {
  addSupplierAttachment(input: $input) {
    id
    filename
    url
    contentType
  }
}`;

const REMOVE_SUPPLIER_ATTACHMENT_MUTATION = `mutation removeSupplierAttachment($input: SupplierAttachmentInput!) {
  removeSupplierAttachment(input: $input)
}`;

/**
 * Extract clean readable plain text from a Draft.js RawDraftContentState object or string.
 */
export function extractPlainTextFromArticle(article: unknown): string {
  if (!article) return "";
  if (typeof article === "string") {
    try {
      const parsed = JSON.parse(article);
      if (parsed && Array.isArray(parsed.blocks)) {
        return parsed.blocks.map((b: any) => b.text || "").join("\n");
      }
      return article;
    } catch {
      return article;
    }
  }
  if (
    typeof article === "object" &&
    article !== null &&
    "blocks" in (article as any)
  ) {
    const blocks = (article as any).blocks;
    if (Array.isArray(blocks)) {
      return blocks.map((b: any) => b.text || "").join("\n");
    }
  }
  return String(article);
}

/**
 * Convert user notes (plain text or markdown) to Draft.js RawDraftContentState for Styrerommet.
 */
export function toDraftRaw(text: string): {
  blocks: Array<any>;
  entityMap: Record<string, any>;
} {
  if (!text) {
    return { blocks: [], entityMap: {} };
  }
  if (typeof text === "object" && text !== null && "blocks" in (text as any)) {
    return text as any;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.blocks)) {
      return parsed;
    }
  } catch {
    // text is plain text
  }
  const lines = text.split("\n");
  return {
    blocks: lines.map((line, idx) => ({
      key: `block-${idx}`,
      text: line,
      type: "unstyled",
      depth: 0,
      inlineStyleRanges: [],
      entityRanges: [],
      data: {},
    })),
    entityMap: {},
  };
}

export function registerSupplierTools(server: McpServer): void {
  server.registerTool(
    "list_suppliers",
    {
      description:
        "List all suppliers/vendors for the organization with contact info and categories. Each supplier includes a ready-to-click 'webUrl' link to the supplier page in Styrerommet.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Search string to find specific suppliers by name"),
        favourite: z
          .boolean()
          .optional()
          .describe(
            "If true, only returns 'Våre leverandører' / 'Vår liste' (the cooperative's curated suppliers). WARNING: If omitted or false, it returns the global database (thousands of suppliers).",
          ),
        hasObosContract: z
          .boolean()
          .optional()
          .describe("If true, only returns suppliers with an OBOS contract"),
        onlyActiveSuppliers: z
          .boolean()
          .default(false)
          .describe("If true, filters out discontinued suppliers"),
        invoicingFilter: z
          .enum([
            "AllInvoicedSuppliers",
            "SuppliersInvoicedDuringPastMonth",
            "SuppliersInvoicedDuringPast12Months",
          ])
          .optional()
          .describe("Filter by invoicing status"),
        contractsFilter: z
          .array(z.string())
          .optional()
          .describe(
            "Filter by contract status, e.g. ['SuppliersWithActiveContracts'] or ['SuppliersWithExpiredContracts']",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      query,
      favourite,
      hasObosContract,
      onlyActiveSuppliers,
      invoicingFilter,
      contractsFilter,
    }) => {
      const numericId = getOrgId();
      const result = await graphqlQuery("allSuppliers", SUPPLIERS_QUERY, {
        obosCompanyNumber: numericId,
        options: {
          limit: 1000,
          offset: 0,
          favourite: favourite ?? null,
          query: query ?? null,
          hasObosContract: hasObosContract ?? null,
          onlyActiveSuppliers: onlyActiveSuppliers,
          invoicingFilter: invoicingFilter ?? null,
          contractsFilter: contractsFilter ?? null,
        },
      });
      const data = result.data as any;
      if (data?.suppliers?.items) {
        data.suppliers.items = data.suppliers.items.map((s: any) => ({
          ...s,
          webUrl: buildSupplierWebUrl(s.id, numericId),
        }));
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_supplier_details",
    {
      description:
        "Get detailed information about a specific supplier, including their historical monthly spending, contracts, contacts, and direct 'webUrl' link to Styrerommet.",
      inputSchema: z.object({
        supplierId: z
          .string()
          .describe("The NodeID of the supplier (e.g. 'Supplier:12345')"),
        months: z
          .number()
          .int()
          .default(12)
          .describe(
            "Number of months of spending history to retrieve (defaults to 12)",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ supplierId, months }) => {
      const numericId = getOrgId();
      const result = await graphqlQuery("supplierPage", SUPPLIER_DETAIL_QUERY, {
        obosCompanyNumber: numericId,
        supplierId,
        months,
      });
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(
        data.supplier?.id || supplierId,
        numericId,
      );
      if (data.supplier) {
        data.supplier = {
          ...data.supplier,
          notesText: extractPlainTextFromArticle(data.supplier.article),
          webUrl,
        };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ ...data, webUrl }, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "list_supplier_contracts",
    {
      description:
        "List all suppliers along with their active contracts (start date, renewal date, description) and direct 'webUrl' links to Styrerommet.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Search string to find specific suppliers by name"),
        favourite: z
          .boolean()
          .optional()
          .describe(
            "If true, only returns 'Våre leverandører' / 'Vår liste' (the cooperative's curated suppliers). WARNING: If omitted or false, it returns the global database (thousands of suppliers).",
          ),
        hasObosContract: z
          .boolean()
          .optional()
          .describe("If true, only returns suppliers with an OBOS contract"),
        onlyActiveSuppliers: z
          .boolean()
          .default(false)
          .describe("If true, filters out discontinued suppliers"),
        invoicingFilter: z
          .enum([
            "AllInvoicedSuppliers",
            "SuppliersInvoicedDuringPastMonth",
            "SuppliersInvoicedDuringPast12Months",
          ])
          .optional()
          .describe("Filter by invoicing status"),
        contractsFilter: z
          .array(z.string())
          .optional()
          .describe(
            "Filter by contract status, e.g. ['SuppliersWithActiveContracts'] or ['SuppliersWithExpiredContracts']",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      query,
      favourite,
      hasObosContract,
      onlyActiveSuppliers,
      invoicingFilter,
      contractsFilter,
    }) => {
      const numericId = getOrgId();
      const result = await graphqlQuery(
        "fdvAllSuppliersContractDetail",
        CONTRACTS_QUERY,
        {
          obosCompanyNumber: numericId,
          options: {
            limit: 1000,
            offset: 0,
            favourite: favourite ?? null,
            query: query ?? null,
            hasObosContract: hasObosContract ?? null,
            onlyActiveSuppliers: onlyActiveSuppliers,
            invoicingFilter: invoicingFilter ?? null,
            contractsFilter: contractsFilter ?? null,
          },
        },
      );

      const suppliers = (result.data as any)?.suppliers?.items || [];
      const withContracts = suppliers
        .filter((s: any) => s.contracts && s.contracts.length > 0)
        .map((s: any) => ({
          ...s,
          webUrl: buildSupplierWebUrl(s.id, numericId),
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                allSuppliersCount: suppliers.length,
                suppliersWithContracts: withContracts,
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
    "set_supplier_favourite",
    {
      description:
        "Add or remove a supplier from the cooperative's curated favorites list ('Våre leverandører' / 'Vår liste').",
      inputSchema: z.object({
        supplierId: z
          .string()
          .describe("The NodeID of the supplier (e.g. 'Supplier:1865')"),
        favourite: z
          .boolean()
          .describe(
            "True to mark as favorite ('Våre leverandører'), false to remove",
          ),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({ supplierId, favourite }) => {
      const numericId = getOrgId();
      const result = await graphqlQuery(
        "setSupplierFavourite",
        SET_SUPPLIER_FAVOURITE_MUTATION,
        {
          input: {
            supplierId,
            favourite,
            obosCompanyNumber: numericId,
          },
        },
      );
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(supplierId, numericId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                favourite,
                message: favourite
                  ? "Leverandøren er lagt til i 'Våre leverandører'"
                  : "Leverandøren er fjernet fra 'Våre leverandører'",
                webUrl,
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
    "update_supplier_notes",
    {
      description:
        "Update the board's internal notes (notater) for a supplier in Styrerommet. Supports plain text, markdown, or Draft.js JSON.",
      inputSchema: z.object({
        supplierId: z
          .string()
          .describe("The NodeID of the supplier (e.g. 'Supplier:1865')"),
        notes: z.string().describe("The internal board notes content to save"),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({ supplierId, notes }) => {
      const numericId = getOrgId();
      let organizationId: string;
      try {
        organizationId = await getOrgNodeId();
      } catch {
        organizationId = numericId;
      }
      const draftState = toDraftRaw(notes);
      const result = await graphqlQuery(
        "updateSupplierArticle",
        UPDATE_SUPPLIER_ARTICLE_MUTATION,
        {
          input: {
            organizationId,
            supplierId,
            article: draftState,
          },
        },
      );
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(supplierId, numericId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                notesSaved: notes,
                message: "Notater for leverandøren er oppdatert",
                webUrl,
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
    "add_supplier_contact",
    {
      description: "Add a new contact person to a supplier in Styrerommet.",
      inputSchema: z.object({
        supplierId: z
          .string()
          .describe("The NodeID of the supplier (e.g. 'Supplier:1865')"),
        name: z.string().describe("Full name of the contact person"),
        phoneNumber: z
          .string()
          .optional()
          .describe("Phone number of the contact person"),
        email: z
          .string()
          .optional()
          .describe("Email address of the contact person"),
        position: z
          .string()
          .optional()
          .describe("Job title / role / position of the contact person"),
      }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ supplierId, name, phoneNumber, email, position }) => {
      const numericId = getOrgId();
      const result = await graphqlQuery(
        "addContactToSupplier",
        ADD_CONTACT_MUTATION,
        {
          input: {
            supplierId,
            obosCompanyNumber: numericId,
            name,
            phoneNumber: phoneNumber ?? null,
            email: email ?? null,
            position: position ?? null,
          },
        },
      );
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(supplierId, numericId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                message: `«${name}» er lagt til som kontaktperson`,
                webUrl,
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
    "update_supplier_contact",
    {
      description:
        "Update an existing contact person for a supplier in Styrerommet.",
      inputSchema: z.object({
        supplierContactId: z
          .string()
          .describe(
            "The NodeID of the contact person to update (e.g. 'SupplierContact:12345')",
          ),
        name: z.string().describe("Full name of the contact person"),
        phoneNumber: z
          .string()
          .optional()
          .describe("Phone number of the contact person"),
        email: z
          .string()
          .optional()
          .describe("Email address of the contact person"),
        position: z
          .string()
          .optional()
          .describe("Job title / role / position of the contact person"),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({ supplierContactId, name, phoneNumber, email, position }) => {
      const result = await graphqlQuery(
        "updateSupplierContact",
        UPDATE_CONTACT_MUTATION,
        {
          input: {
            supplierContactId,
            name,
            phoneNumber: phoneNumber ?? null,
            email: email ?? null,
            position: position ?? null,
          },
        },
      );
      const data = (result.data as any) || {};
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                message: `Kontaktpersonen «${name}» er oppdatert`,
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
    "remove_supplier_contact",
    {
      description:
        "Remove/delete a contact person from a supplier in Styrerommet.",
      inputSchema: z.object({
        supplierContactId: z
          .string()
          .describe("The NodeID of the contact person to remove"),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ supplierContactId }) => {
      const result = await graphqlQuery(
        "removeSupplierContact",
        REMOVE_CONTACT_MUTATION,
        {
          supplierContactId,
        },
      );
      const data = (result.data as any) || {};
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                removedContactId: supplierContactId,
                message: "Kontaktpersonen er slettet",
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
    "add_supplier_contract",
    {
      description:
        "Add a new contract (avtale) to a supplier in Styrerommet. Supports start/end date, ongoing contract flag, categories, description, and attachments.",
      inputSchema: z.object({
        supplierId: z
          .string()
          .describe("The NodeID of the supplier (e.g. 'Supplier:1865')"),
        startDate: z.string().describe("Contract start date (YYYY-MM-DD)"),
        endDate: z
          .string()
          .optional()
          .describe(
            "Contract end date (YYYY-MM-DD). Should be omitted or null if ongoingContract is true.",
          ),
        ongoingContract: z
          .boolean()
          .default(false)
          .describe(
            "True if this is an ongoing/continuous contract without a fixed end date (Løpende avtale)",
          ),
        description: z
          .string()
          .optional()
          .describe("Description or comment about the contract"),
        types: z
          .array(z.string())
          .optional()
          .describe(
            "Categories / service areas covered by the contract (e.g. ['Heis', 'Renhold'])",
          ),
        attachmentIds: z
          .array(z.string())
          .optional()
          .describe(
            "Optional list of attachment NodeIDs already uploaded to link to this contract",
          ),
      }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({
      supplierId,
      startDate,
      endDate,
      ongoingContract,
      description,
      types,
      attachmentIds,
    }) => {
      const numericId = getOrgId();
      const startParsed = new Date(startDate);
      const endParsed = endDate ? new Date(endDate) : null;

      const result = await graphqlQuery(
        "addSupplierContract",
        ADD_CONTRACT_MUTATION,
        {
          input: {
            supplierId,
            obosCompanyNumber: numericId,
            details: {
              startDate: isNaN(startParsed.getTime())
                ? startDate
                : startParsed.toISOString(),
              renewalDate: null,
              endDate: ongoingContract
                ? null
                : endParsed && !isNaN(endParsed.getTime())
                  ? endParsed.toISOString()
                  : null,
              description: description ?? "",
              types: types ?? [],
              attachmentIds: attachmentIds ?? [],
            },
          },
        },
      );
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(supplierId, numericId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                message: "Avtalen er lagt til",
                webUrl,
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
    "update_supplier_contract",
    {
      description:
        "Update an existing contract (avtale) for a supplier in Styrerommet.",
      inputSchema: z.object({
        supplierContractId: z
          .string()
          .describe(
            "The NodeID of the contract to update (e.g. 'SupplierContract:12345')",
          ),
        supplierId: z.string().describe("The NodeID of the supplier"),
        startDate: z.string().describe("Contract start date (YYYY-MM-DD)"),
        endDate: z
          .string()
          .optional()
          .describe(
            "Contract end date (YYYY-MM-DD). Should be omitted or null if ongoingContract is true.",
          ),
        ongoingContract: z
          .boolean()
          .default(false)
          .describe(
            "True if this is an ongoing contract without a fixed end date (Løpende avtale)",
          ),
        description: z
          .string()
          .optional()
          .describe("Description or comment about the contract"),
        types: z
          .array(z.string())
          .optional()
          .describe("Categories / service areas covered by the contract"),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({
      supplierContractId,
      supplierId,
      startDate,
      endDate,
      ongoingContract,
      description,
      types,
    }) => {
      const numericId = getOrgId();
      const startParsed = new Date(startDate);
      const endParsed = endDate ? new Date(endDate) : null;

      const result = await graphqlQuery(
        "updateSupplierContract",
        UPDATE_CONTRACT_MUTATION,
        {
          input: {
            supplierContractId,
            supplierId,
            obosCompanyNumber: numericId,
            details: {
              startDate: isNaN(startParsed.getTime())
                ? startDate
                : startParsed.toISOString(),
              renewalDate: null,
              endDate: ongoingContract
                ? null
                : endParsed && !isNaN(endParsed.getTime())
                  ? endParsed.toISOString()
                  : null,
              description: description ?? "",
              types: types ?? [],
            },
          },
        },
      );
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(supplierId, numericId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                message: "Avtalen er oppdatert",
                webUrl,
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
    "remove_supplier_contract",
    {
      description: "Delete/remove a contract from a supplier in Styrerommet.",
      inputSchema: z.object({
        supplierId: z.string().describe("The NodeID of the supplier"),
        contractId: z.string().describe("The NodeID of the contract to delete"),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ supplierId, contractId }) => {
      const numericId = getOrgId();
      const result = await graphqlQuery(
        "removeSupplierContract",
        REMOVE_CONTRACT_MUTATION,
        {
          supplierContract: {
            obosCompanyNumber: numericId,
            supplierId,
            contractId,
          },
        },
      );
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(supplierId, numericId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                deletedContractId: contractId,
                message: "Avtalen er slettet",
                webUrl,
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
    "add_supplier_contract_attachment",
    {
      description:
        "Link an uploaded attachment/file to a supplier contract in Styrerommet.",
      inputSchema: z.object({
        supplierId: z.string().describe("The NodeID of the supplier"),
        contractId: z.string().describe("The NodeID of the contract"),
        attachmentId: z
          .string()
          .describe("The NodeID of the uploaded attachment to link"),
      }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ supplierId, contractId, attachmentId }) => {
      const numericId = getOrgId();
      const result = await graphqlQuery(
        "addSupplierContractAttachment",
        ADD_CONTRACT_ATTACHMENT_MUTATION,
        {
          input: {
            obosCompanyNumber: numericId,
            supplierId,
            contractId,
            attachmentId,
          },
        },
      );
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(supplierId, numericId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                message: "Vedlegget er lagt til avtalen",
                webUrl,
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
    "remove_supplier_contract_attachment",
    {
      description:
        "Remove an attachment/file from a supplier contract in Styrerommet.",
      inputSchema: z.object({
        supplierId: z.string().describe("The NodeID of the supplier"),
        contractId: z.string().describe("The NodeID of the contract"),
        attachmentId: z
          .string()
          .describe("The NodeID of the attachment file to remove"),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ supplierId, contractId, attachmentId }) => {
      const numericId = getOrgId();
      const result = await graphqlQuery(
        "removeSupplierContractAttachment",
        REMOVE_CONTRACT_ATTACHMENT_MUTATION,
        {
          input: {
            obosCompanyNumber: numericId,
            supplierId,
            contractId,
            attachmentId,
          },
        },
      );
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(supplierId, numericId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                removedAttachmentId: attachmentId,
                message: "Vedlegget er fjernet fra avtalen",
                webUrl,
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
    "add_supplier_document",
    {
      description:
        "Link an uploaded document/attachment directly to a supplier in Styrerommet.",
      inputSchema: z.object({
        supplierId: z.string().describe("The NodeID of the supplier"),
        attachmentId: z
          .string()
          .describe("The NodeID of the uploaded document attachment"),
      }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ supplierId, attachmentId }) => {
      const numericId = getOrgId();
      const result = await graphqlQuery(
        "addSupplierAttachment",
        ADD_SUPPLIER_ATTACHMENT_MUTATION,
        {
          input: {
            supplierId,
            obosCompanyNumber: numericId,
            attachmentId,
          },
        },
      );
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(supplierId, numericId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                message: "Dokumentet er lagt til leverandøren",
                webUrl,
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
    "remove_supplier_document",
    {
      description:
        "Remove a document/attachment from a supplier in Styrerommet.",
      inputSchema: z.object({
        supplierId: z.string().describe("The NodeID of the supplier"),
        attachmentId: z
          .string()
          .describe("The NodeID of the document attachment to remove"),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ supplierId, attachmentId }) => {
      const numericId = getOrgId();
      const result = await graphqlQuery(
        "removeSupplierAttachment",
        REMOVE_SUPPLIER_ATTACHMENT_MUTATION,
        {
          input: {
            supplierId,
            obosCompanyNumber: numericId,
            attachmentId,
          },
        },
      );
      const data = (result.data as any) || {};
      const webUrl = buildSupplierWebUrl(supplierId, numericId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...data,
                removedAttachmentId: attachmentId,
                message: "Dokumentet er slettet fra leverandøren",
                webUrl,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
