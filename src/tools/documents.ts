import { UPDATE_ANNOTATIONS } from "../annotations.ts";
import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId, downloadFile } from "../client.ts";
import {
  vibboGraphqlQuery,
  getVibboOrgSlug,
  downloadVibboFile,
} from "../vibbo-client.ts";
import { vibboRegistry } from "../vibbo-registry.ts";
import * as path from "node:path";

const DOCUMENTS_QUERY = `query generalAssembliesPage($organizationNumber: ID!) {
  organization: organizationByObosNumber(companyNumber: $organizationNumber) {
    documents {
      filename
      downloadUrl
      contentType
      category {
        code
      }
    }
  }
}`;

export function registerDocumentTools(server: McpServer): void {
  server.registerTool(
    "list_documents",
    {
      description:
        "List shared files in the organization's document archives across Styrerommet (governance, protocols, bylaws) and Vibbo (resident-published documents, husordensregler, vedtekter, brannvern)",
      inputSchema: z.object({
        source: z
          .enum(["ALL", "STYREROMMET", "VIBBO"])
          .default("ALL")
          .describe(
            "Data source to retrieve: ALL (combines Styrerommet and Vibbo documents), STYREROMMET, or VIBBO",
          ),
        categoryCode: z
          .string()
          .optional()
          .describe(
            "Optional category code to filter by (e.g. 'FFKT', 'AARR', 'VEDT', 'HORE')",
          ),
        query: z
          .string()
          .optional()
          .describe("Optional search string to filter documents by filename"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ source, categoryCode, query }) => {
      const src = source ?? "ALL";
      let styrerommetDocs: any[] = [];
      let vibboDocs: any[] = [];

      // 1. Styrerommet documents
      if (src === "ALL" || src === "STYREROMMET") {
        try {
          const result = await graphqlQuery<{
            organization?: {
              documents?: Array<{
                filename: string;
                downloadUrl: string;
                contentType: string;
                category?: { code: string; name?: string };
              }>;
            };
          }>("generalAssembliesPage", DOCUMENTS_QUERY, {
            organizationNumber: getOrgId(),
          });

          styrerommetDocs = (result.data?.organization?.documents || []).map(
            (d) => ({
              ...d,
              source: "styrerommet",
            }),
          );
        } catch (e: any) {
          console.error("Failed to fetch Styrerommet documents:", e.message);
        }
      }

      // 2. Vibbo documents
      if (src === "ALL" || src === "VIBBO") {
        try {
          const op = vibboRegistry.get("vibboDocuments");
          if (op) {
            const result = await vibboGraphqlQuery<{
              organization?: {
                documents?: Array<{
                  filename: string;
                  downloadUrl: string;
                  year?: number | null;
                  category?: { code: string; name?: string };
                }>;
              };
            }>(op.operationName, op.queryText, {
              organizationSlug: getVibboOrgSlug(),
            });

            vibboDocs = (result.data?.organization?.documents || []).map(
              (d) => ({
                ...d,
                source: "vibbo",
              }),
            );
          }
        } catch (e: any) {
          console.error("Failed to fetch Vibbo documents:", e.message);
        }
      }

      let allDocs = [...styrerommetDocs, ...vibboDocs];

      if (categoryCode) {
        const lowerCode = categoryCode.toLowerCase();
        allDocs = allDocs.filter(
          (d) => d.category?.code?.toLowerCase() === lowerCode,
        );
      }

      if (query) {
        const q = query.toLowerCase();
        allDocs = allDocs.filter((d) => d.filename?.toLowerCase().includes(q));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: allDocs.length,
                styrerommetCount: styrerommetDocs.length,
                vibboCount: vibboDocs.length,
                documents: allDocs,
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
    "download_document",
    {
      description:
        "Download a file from either Styrerommet or Vibbo document archives or attachments using its download URL",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe(
            "The document download URL (e.g. '/api/documents/...', 'https://vibbo.no/documents/...' or 'https://styrerommet.no/attachments/...')",
          ),
        filename: z
          .string()
          .optional()
          .describe(
            "The filename to save the downloaded file as (e.g. 'by_laws.pdf')",
          ),
        documentId: z
          .string()
          .optional()
          .describe("Alternative document identifier or URL"),
        outputDir: z
          .string()
          .optional()
          .default("./data/documents")
          .describe(
            "Target directory inside the workspace relative to current dir",
          ),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({ url, filename, documentId, outputDir }) => {
      let targetUrl = url ?? documentId;
      let targetFilename = filename;
      const targetOutputDir = outputDir ?? "./data/documents";

      if (!targetUrl) {
        try {
          const docOp = vibboRegistry.get("vibboDocuments");
          if (docOp) {
            const vRes = await vibboGraphqlQuery<any>(
              docOp.operationName,
              docOp.queryText,
              { organizationSlug: getVibboOrgSlug() },
            );
            const first = vRes.data?.organization?.documents?.[0];
            if (first) {
              targetUrl = first.downloadUrl;
              targetFilename = targetFilename ?? first.filename;
            }
          }
        } catch {}
      }

      if (!targetUrl) {
        return {
          content: [
            { type: "text", text: "No document URL specified or found." },
          ],
          isError: true,
        };
      }

      const safeFilename = (
        targetFilename ||
        path.basename(targetUrl.split("?")[0] || "") ||
        "document.pdf"
      ).replace(/[^a-zA-Z0-9_.-]/g, "_");
      const destPath = path.join(targetOutputDir, safeFilename);

      try {
        if (targetUrl.includes("vibbo.no")) {
          await downloadVibboFile(targetUrl, destPath);
        } else {
          await downloadFile(targetUrl, destPath);
        }
        return {
          content: [
            {
              type: "text",
              text: `Successfully downloaded file to ${destPath}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `Failed to download file: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
