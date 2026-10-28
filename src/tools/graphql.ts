import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery } from "../client.ts";
import { registry } from "../registry.ts";

export function registerGraphqlTool(server: McpServer): void {
  server.registerTool(
    "graphql",
    {
      description: `Execute any discovered read-only GraphQL query from Styrerommet by operation name.
Only query operations are allowed — mutations are blocked for safety.
Use 'list_operations' first to see all available queries.`,
      inputSchema: z.object({
        operationName: z
          .string()
          .describe(
            "The GraphQL operation name (e.g. 'economyPage', 'residentsPage'). Use list_operations to see all available queries.",
          ),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Variables to pass to the GraphQL query. Note: Some queries (like suppliers) require the organization's UUID NodeID (e.g. 'T3JnYW5pemF0aW9uOi...') as obosCompanyNumber/organizationNumber rather than the numeric ID (for example, 12345). You can find this NodeID via 'get_viewer'.",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operationName, variables }) => {
      const operation = registry.get(operationName);
      if (!operation) {
        const suggestion = registry
          .listQueryNames()
          .filter((n) => n.toLowerCase().includes(operationName.toLowerCase()))
          .slice(0, 5);

        let errorMsg = `Unknown or disallowed operation: "${operationName}". Only read-only queries are available.`;
        if (suggestion.length > 0) {
          errorMsg += `\n\nDid you mean: ${suggestion.join(", ")}?`;
        }
        errorMsg += `\n\nUse the 'list_operations' tool to see all ${registry.size} available queries.`;

        return {
          content: [{ type: "text", text: errorMsg }],
          isError: true,
        };
      }

      const result = await graphqlQuery(
        operationName,
        operation.queryText,
        variables ?? {},
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "list_operations",
    {
      description:
        "List all available read-only GraphQL query operations. Use this to discover what queries you can run with the 'graphql' tool.",
      inputSchema: z.object({
        filter: z
          .string()
          .optional()
          .describe(
            "Optional filter string to search operation names (case-insensitive)",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ filter }) => {
      let names = registry.listQueryNames();
      if (filter) {
        const lower = filter.toLowerCase();
        names = names.filter((n) => n.toLowerCase().includes(lower));
      }

      const lines = names.map((name) => {
        const op = registry.get(name);
        // Extract the variable signature from the query text
        const varMatch = op?.queryText.match(
          /(?:query|mutation)\s+\w+\(([^)]+)\)/,
        );
        const vars = varMatch ? varMatch[1]!.trim() : "(no variables)";
        return `• ${name}  —  ${vars}`;
      });

      const header = filter
        ? `Found ${lines.length} queries matching "${filter}" (out of ${registry.size} total):`
        : `All ${registry.size} available read-only queries:`;

      return {
        content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}` }],
      };
    },
  );

  server.registerTool(
    "get_operation_schema",
    {
      description:
        "Get the full GraphQL query text for a specific operation, so you can see exactly what fields it returns and what variables it accepts.",
      inputSchema: z.object({
        operationName: z.string().describe("The operation name to inspect"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operationName }) => {
      let operation = registry.get(operationName);
      if (!operation) {
        // Try case-insensitive or substring match
        const lower = operationName.toLowerCase();
        const allNames = registry.listQueryNames();
        const exactCi = allNames.find((n) => n.toLowerCase() === lower);
        if (exactCi) {
          operation = registry.get(exactCi);
        } else {
          const partial = allNames.filter((n) =>
            n.toLowerCase().includes(lower),
          );
          if (partial.length === 1) {
            operation = registry.get(partial[0]!);
          } else if (partial.length > 1) {
            return {
              content: [
                {
                  type: "text",
                  text: `Operation "${operationName}" not found. Did you mean one of these?\n${partial
                    .slice(0, 10)
                    .map((n) => `- ${n}`)
                    .join("\n")}`,
                },
              ],
              isError: true,
            };
          }
        }
      }

      if (!operation) {
        return {
          content: [
            {
              type: "text",
              text: `Operation "${operationName}" not found. Use list_operations to see available queries.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `# ${operationName}\n\nType: ${operation.operationType}\n\n\`\`\`graphql\n${operation.queryText}\n\`\`\``,
          },
        ],
      };
    },
  );
}
