import { UPDATE_ANNOTATIONS } from "../annotations.ts";
import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import * as path from "node:path";
import {
  getArchivePath,
  searchArchive,
  getRecentArchiveFiles,
  downloadArchiveFile,
  readArchiveFileText,
  listArchiveFileRevisions,
  downloadArchiveZip,
  formatPathItem,
  formatBytes,
  normalizeArchivePath,
  getArkivOrgId,
  type FormattedArchiveItem,
  type ArchiveFileRevision,
} from "../arkiv-client.ts";

export function registerArchiveTools(server: McpServer): void {
  server.registerTool(
    "list_archive_files",
    {
      description:
        "List files and folders in the Styrerommet file archive (arkiv.styrerommet.no / Jottacloud). Strictly read-only. Each item includes a direct 'webUrl' link to the file/folder in arkiv.styrerommet.no.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe(
            "Archive path to list (e.g. '', '/', '/Nybygget', '/resources/{orgId}', '{orgId}-archive', '{orgId}-maintenance'). Defaults to the cooperative's main folder /resources/${orgId}",
          ),
        recursive: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, recursively lists subfolders (up to 3 levels deep)",
          ),
        sort: z
          .enum([
            "NAME_ASC",
            "NAME_DESC",
            "DATE_ASC",
            "DATE_DESC",
            "SIZE_ASC",
            "SIZE_DESC",
          ])
          .optional()
          .default("NAME_ASC")
          .describe("Sort order for listed files and folders"),
        include_deleted: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, also includes deleted/trash items in the directory listing. Defaults to false.",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ path: inputPath, recursive, sort, include_deleted }) => {
      try {
        const resolvedPath = normalizeArchivePath(inputPath);

        // Special case: if user asked for "/resources" directly, list sibling repositories
        if (resolvedPath === "/resources") {
          const orgId = getArkivOrgId();
          const siblingPaths = [
            `/resources/${orgId}`,
            `/resources/${orgId}-arkiv`,
            `/resources/${orgId}-vedlikehold`,
          ];
          const entries: FormattedArchiveItem[] = [];
          for (const sp of siblingPaths) {
            try {
              const item = await getArchivePath(sp, { includeChildren: false });
              entries.push(formatPathItem(item));
            } catch {
              // sibling might not exist or be accessible
            }
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { currentPath: "/resources", items: entries },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (!recursive) {
          const item = await getArchivePath(resolvedPath, {
            sort,
            includeChildren: true,
            includeDeleted: include_deleted,
          });
          const isFolder = item.type === 2;
          const items = (item.childrenList || []).map(formatPathItem);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    currentPath: item.path,
                    name: item.name,
                    type: isFolder ? "folder" : "file",
                    itemsCount: items.length,
                    items,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Recursive traversal (maxDepth = 3, maxItems = 300)
        const allItems: FormattedArchiveItem[] = [];
        const queue: Array<{ path: string; depth: number }> = [
          { path: resolvedPath, depth: 0 },
        ];
        const MAX_DEPTH = 3;
        const MAX_ITEMS = 300;

        while (queue.length > 0 && allItems.length < MAX_ITEMS) {
          const current = queue.shift()!;
          if (current.depth > MAX_DEPTH) continue;

          try {
            const item = await getArchivePath(current.path, {
              sort,
              includeChildren: true,
            });
            for (const child of item.childrenList || []) {
              allItems.push(formatPathItem(child));
              if (
                child.type === 2 &&
                current.depth + 1 <= MAX_DEPTH &&
                allItems.length < MAX_ITEMS
              ) {
                queue.push({ path: child.path, depth: current.depth + 1 });
              }
            }
          } catch {
            // continue on folder read errors
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  rootPath: resolvedPath,
                  recursive: true,
                  totalItems: allItems.length,
                  items: allItems,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to list archive files: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "search_archive_files",
    {
      description:
        "Full-text search (FTS) across files, folders, and inside document contents (PDF, Word .docx, text) in the Styrerommet file archive. Case-insensitive. Each match includes a direct 'webUrl'. Note: Norwegian characters (æ, ø, å) must be spelled with proper letters (not ASCII-folded). Multi-word queries match OR with relevance ranking; exact phrases can be quoted (\"phrase\"). Avoid colons (like ext: or type:) and isolated hyphens.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Search query or phrase. Searches both file/folder names and document contents (PDF/DOCX text). Case-insensitive. Use proper Norwegian characters ('Sør', not 'Sor'). Quotes \"...\" enforce exact phrase. Avoid 'ext:' or isolated dashes.",
          ),
        scopePath: z
          .string()
          .optional()
          .describe(
            "Optional path to limit search scope (e.g. '/resources/{orgId}' for main archive, '{orgId}-archive' for general assembly archive, or a specific subfolder). Defaults to main cooperative archive.",
          ),
        pageSize: z
          .number()
          .optional()
          .default(50)
          .describe("Max number of search results to return (default 50)."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, scopePath, pageSize }) => {
      try {
        const results = await searchArchive(query, {
          scopePath,
          pageSize,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  totalMatches: results.length,
                  results,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Search failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get_archive_file_details",
    {
      description:
        "Get detailed metadata for a specific file or folder in the Styrerommet file archive, including direct 'webUrl' link. Strictly read-only.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Archive path of the file or folder (e.g. '/resources/{orgId}/Example cooperative - ownership shares.pdf')",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ path: inputPath }) => {
      try {
        const item = await getArchivePath(inputPath, { includeChildren: true });
        const details = {
          ...formatPathItem(item),
          downloadLink: item.downloadLink,
          thumbLink: item.thumbLink,
          owner: item.owner,
          children: (item.childrenList || []).map(formatPathItem),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to get archive file details: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "download_archive_file",
    {
      description:
        "Download a file from the Styrerommet file archive to the local workspace. Strictly read-only.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe(
            "Archive file path to download (e.g. '/resources/{orgId}/Example cooperative - ownership shares.pdf')",
          ),
        fileId: z.string().optional().describe("Alternative file path or ID"),
        outputDir: z
          .string()
          .optional()
          .default("./data/arkiv")
          .describe(
            "Directory inside workspace to save the file (default: './data/arkiv')",
          ),
        filename: z
          .string()
          .optional()
          .describe(
            "Optional custom filename to save as. Defaults to original file name",
          ),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({ path: inputPath, fileId, outputDir, filename }) => {
      try {
        const rawPath = inputPath ?? fileId;
        if (!rawPath) {
          return {
            content: [
              { type: "text", text: "Archive path or fileId is required." },
            ],
            isError: true,
          };
        }
        const resolvedPath = normalizeArchivePath(rawPath);
        const outDir = outputDir ?? "./data/arkiv";
        const baseName = filename ?? path.basename(resolvedPath);
        const cleanFilename = baseName.replace(
          /[^a-zA-Z0-9_.\-\sáæøåÁÆØÅ]/g,
          "_",
        );
        const destPath = path.join(outDir, cleanFilename);

        const result = await downloadArchiveFile(resolvedPath, destPath);
        return {
          content: [
            {
              type: "text",
              text: `Successfully downloaded archive file to ${result.destPath} (${formatBytes(result.bytesDownloaded)})`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to download archive file: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "read_archive_file",
    {
      description:
        "Read the text content of a text or document file from the Styrerommet archive directly into memory. Strictly read-only.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Archive file path to read (e.g. txt, csv, md, json, docx, etc.)",
          ),
        maxBytes: z
          .number()
          .optional()
          .default(100000)
          .describe("Maximum bytes to read (default 100,000 bytes)"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ path: inputPath, maxBytes }) => {
      try {
        const resolvedPath = normalizeArchivePath(inputPath);
        const result = await readArchiveFileText(resolvedPath, maxBytes);
        return {
          content: [
            {
              type: "text",
              text: result.text,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to read archive file: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 6. File Revisions History
  server.registerTool(
    "get_archive_file_revisions",
    {
      description:
        "List previous versions/revisions of a file in the Styrerommet archive (with revision ID, timestamp, size, checksum, and download URL). Strictly read-only.",
      inputSchema: z.object({
        path: z.string().describe("Archive file path to inspect revisions for"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ path: inputPath }) => {
      try {
        const resolvedPath = normalizeArchivePath(inputPath);
        const revisions = await listArchiveFileRevisions(resolvedPath);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  filePath: resolvedPath,
                  totalRevisions: revisions.length,
                  revisions,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to list file revisions: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 7. Download Folder or Multiple Files as ZIP
  server.registerTool(
    "download_archive_zip",
    {
      description:
        "Download an entire folder or collection of files from the Styrerommet archive as a single .zip file. Strictly read-only.",
      inputSchema: z.object({
        paths: z
          .union([z.string(), z.array(z.string())])
          .describe(
            "Archive folder path (e.g. '/Main building (Example Street 10)') or array of paths to download as ZIP",
          ),
        output_path: z
          .string()
          .optional()
          .describe(
            "Local target destination path (e.g. './data/arkiv/nybygg.zip'). Defaults to ./data/arkiv/<folder_name>.zip",
          ),
      }),
      annotations: UPDATE_ANNOTATIONS,
    },
    async ({ paths: inputPaths, output_path }) => {
      try {
        const result = await downloadArchiveZip(inputPaths, output_path);
        return {
          content: [
            {
              type: "text",
              text: `Successfully downloaded archive ZIP to ${result.destPath} (${formatBytes(result.bytesDownloaded)})`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to download archive ZIP: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
