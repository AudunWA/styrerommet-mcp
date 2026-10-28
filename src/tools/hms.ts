import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  READ_ONLY_ANNOTATIONS,
  CREATE_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
} from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  graphqlQuery,
  getOrgId,
  getOrgNodeId,
  uploadAttachment,
  type UploadAttachmentResult,
} from "../client.ts";
import { buildHmsWebUrl } from "../urls.ts";

export const CUSTOM_HMS_QUERY = `query customHmsOverview($organizationNumber: OrganizationID!) {
  organization(id: $organizationNumber) {
    id
    obosCompanyNumber
    HMSSetup {
      updatedAt
    }
    routines(active: true) {
      id
      name
      key
      frequency
      recommendedFrequency
      lastCompletedAt
      deadline
    }
    riskAreas {
      key
      name
      description
      isCustom
      routineKeys
    }
    deviations {
      id
      description
      createdAt
      resolvedAt
      createdBy {
        id
        name
      }
      attachments {
        id
        filename
        url
        contentType
      }
    }
  }
}`;

export const CREATE_DEVIATION_MUTATION = `mutation createDeviation($input: CreateDeviationInput!) {
  createDeviation(input: $input) {
    id
    __typename
  }
}`;

export const ADD_ATTACHMENT_MUTATION = `mutation addAttachment($input: ItemAttachmentInput!) {
  addAttachment(input: $input) {
    id
    filename
    url
    contentType
    __typename
  }
}`;

export const REMOVE_DEVIATION_MUTATION = `mutation removeDeviation($input: RemoveDeviationInput!) {
  removeDeviation(input: $input)
}`;

export const RESOLVE_DEVIATION_MUTATION = `mutation resolveDeviation($input: ResolveDeviationInput!) {
  resolveDeviation(input: $input) {
    id
    resolvedAt
  }
}`;

export const UNDO_RESOLVE_DEVIATION_MUTATION = `mutation undoResolveDeviation($id: NodeID!) {
  undoResolveDeviation(id: $id) {
    id
    resolvedAt
  }
}`;

export function registerHmsTools(server: McpServer): void {
  server.registerTool(
    "get_hms_overview",
    {
      description:
        "Get organization's HMS (Health, Safety, and Environment) setup, active safety/maintenance routines, risk areas, and deviations/issues",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const result = await graphqlQuery("customHmsOverview", CUSTOM_HMS_QUERY, {
        organizationNumber: getOrgId(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "create_hms_deviation",
    {
      description:
        "Create a new HMS deviation (avvik) in Styrerommet, with optional attachments (PDF, images, video).",
      inputSchema: z.object({
        description: z
          .string()
          .describe(
            "Beskrivelse av avviket som har blitt oppdaget (f.eks. 'Defekt lysrør i fellesbod i oppgang B'). Dette er teksten som vises i Styrerommet.",
          ),
        attachments: z
          .array(z.string())
          .optional()
          .describe(
            "Liste over lokale filstier (f.eks. PDF, bilder, video) som skal lastes opp og knyttes til avviket",
          ),
      }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ description, attachments }) => {
      // 1. Gather all file paths
      const filePaths = (attachments ?? [])
        .filter(
          (p): p is string => typeof p === "string" && p.trim().length > 0,
        )
        .map((p) => p.trim());

      // 2. Validate upfront that all attachment files exist locally
      for (const p of filePaths) {
        const resolved = resolve(process.cwd(), p);
        if (!existsSync(resolved)) {
          throw new Error(
            `Vedleggsfil ble ikke funnet: "${p}" (full sti: "${resolved}")`,
          );
        }
      }

      // 3. Resolve IDs
      const orgNodeId = await getOrgNodeId();
      const numericOrgId = getOrgId();

      // 4. Create the deviation
      const deviationRes = await graphqlQuery<{
        createDeviation: { id: string };
      }>("createDeviation", CREATE_DEVIATION_MUTATION, {
        input: {
          organizationId: orgNodeId,
          description: description.trim(),
        },
      });

      const deviationId = deviationRes.data?.createDeviation?.id;
      if (!deviationId) {
        throw new Error(
          "Opprettelse av HMS-avvik feilet: Ingen avviks-ID returnert fra Styrerommet",
        );
      }

      // 5. Upload and link attachments if any
      const uploadedAttachments: Array<
        UploadAttachmentResult & { linked: boolean; error?: string }
      > = [];
      const attachmentErrors: string[] = [];

      for (const p of filePaths) {
        try {
          const uploadRes = await uploadAttachment(p);
          const linkRes = await graphqlQuery<{
            addAttachment: {
              id: string;
              filename: string;
              url: string;
              contentType: string;
            };
          }>("addAttachment", ADD_ATTACHMENT_MUTATION, {
            input: {
              parentType: "deviation",
              attachmentId: uploadRes.id,
              parentId: deviationId,
            },
          });

          uploadedAttachments.push({
            ...(linkRes.data?.addAttachment ?? uploadRes),
            linked: true,
          });
        } catch (err: any) {
          const errorMsg = `Kunne ikke laste opp/knytte vedlegg "${p}": ${err.message}`;
          attachmentErrors.push(errorMsg);
          uploadedAttachments.push({
            id: "",
            filename: p,
            url: "",
            contentType: "",
            linked: false,
            error: err.message,
          });
        }
      }

      const output = {
        success: true,
        deviation: {
          id: deviationId,
          description: description.trim(),
        },
        attachments: uploadedAttachments,
        ...(attachmentErrors.length > 0 ? { attachmentErrors } : {}),
        webUrl: buildHmsWebUrl(numericOrgId),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  server.registerTool(
    "add_attachment_to_hms_deviation",
    {
      description:
        "Upload and attach a local file (e.g. PDF, image) to an existing HMS deviation in Styrerommet.",
      inputSchema: z.object({
        deviationId: z
          .string()
          .describe(
            "The NodeID of the HMS deviation (e.g. 'SE1TRGV2aWF0aW9uOlpa...')",
          ),
        filePath: z.string().describe("Local file path to the attachment"),
        filename: z
          .string()
          .optional()
          .describe("Optional custom filename to use when uploading"),
      }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ deviationId, filePath, filename }) => {
      const numericOrgId = getOrgId();
      const uploadRes = await uploadAttachment(filePath, filename);
      const linkRes = await graphqlQuery<{
        addAttachment: {
          id: string;
          filename: string;
          url: string;
          contentType: string;
        };
      }>("addAttachment", ADD_ATTACHMENT_MUTATION, {
        input: {
          parentType: "deviation",
          attachmentId: uploadRes.id,
          parentId: deviationId,
        },
      });

      const output = {
        success: true,
        deviationId,
        attachment: linkRes.data?.addAttachment ?? uploadRes,
        webUrl: buildHmsWebUrl(numericOrgId),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  server.registerTool(
    "delete_hms_deviation",
    {
      description: "Delete an HMS deviation (avvik) in Styrerommet.",
      inputSchema: z.object({
        deviationId: z
          .string()
          .describe(
            "The NodeID of the HMS deviation to delete (e.g. 'SE1TRGV2aWF0aW9uOlpa...')",
          ),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ deviationId }) => {
      const result = await graphqlQuery(
        "removeDeviation",
        REMOVE_DEVIATION_MUTATION,
        {
          input: { id: deviationId },
        },
      );

      const output = {
        success: true,
        deviationId,
        message: "HMS-avvik ble slettet",
        result: result.data,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  server.registerTool(
    "resolve_hms_deviation",
    {
      description:
        "Mark an HMS deviation (avvik) as resolved in Styrerommet with a resolution comment (løsningsnotater) describing how and when it was resolved.",
      inputSchema: z.object({
        deviationId: z
          .string()
          .describe(
            "The NodeID of the HMS deviation to resolve (e.g. 'SE1TRGV2aWF0aW9uOlpa...')",
          ),
        comment: z
          .string()
          .describe(
            "Løsningsnotater - beskrivelse av hvordan og når avviket ble løst (vises i Styrerommet)",
          ),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({ deviationId, comment }) => {
      const numericOrgId = getOrgId();
      const result = await graphqlQuery<{
        resolveDeviation: { id: string; resolvedAt: string };
      }>("resolveDeviation", RESOLVE_DEVIATION_MUTATION, {
        input: {
          id: deviationId,
          comment: comment.trim(),
        },
      });

      const resolvedData = result.data?.resolveDeviation;
      const output = {
        success: true,
        deviationId: resolvedData?.id ?? deviationId,
        resolvedAt: resolvedData?.resolvedAt ?? new Date().toISOString(),
        comment: comment.trim(),
        message: "HMS-avvik ble markert som løst",
        webUrl: buildHmsWebUrl(numericOrgId),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  server.registerTool(
    "reopen_hms_deviation",
    {
      description:
        "Reopen a previously resolved HMS deviation in Styrerommet (undo resolve).",
      inputSchema: z.object({
        deviationId: z
          .string()
          .describe(
            "The NodeID of the HMS deviation to reopen (e.g. 'SE1TRGV2aWF0aW9uOlpa...')",
          ),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({ deviationId }) => {
      const numericOrgId = getOrgId();
      const result = await graphqlQuery<{
        undoResolveDeviation: { id: string; resolvedAt: string | null };
      }>("undoResolveDeviation", UNDO_RESOLVE_DEVIATION_MUTATION, {
        id: deviationId,
      });

      const reopenedData = result.data?.undoResolveDeviation;
      const output = {
        success: true,
        deviationId: reopenedData?.id ?? deviationId,
        resolvedAt: reopenedData?.resolvedAt,
        message: "HMS-avvik ble gjenåpnet",
        webUrl: buildHmsWebUrl(numericOrgId),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );
}
