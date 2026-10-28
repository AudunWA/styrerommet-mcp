import { CREATE_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { runInteractiveLogin } from "../auth/login.ts";
import { z } from "zod";

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "login_interactive",
    {
      description:
        "Launch a browser to log into Styrerommet, Arkiv, Vibbo, and Mitt Bygg. Detects the selected cooperative and its Vibbo slug from the authenticated Styrerommet session, then saves session cookies and tokens locally.",
      inputSchema: z.object({}),
      annotations: CREATE_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await runInteractiveLogin();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive authentication failed: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
