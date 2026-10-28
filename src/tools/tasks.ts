import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId } from "../client.ts";
import { buildTasksWebUrl } from "../urls.ts";

const TASKS_UNSOLVED_QUERY = `query tasksIndexQuery($organizationNumber: ID!) {
  organization: organizationByObosNumber(companyNumber: $organizationNumber) {
    tasks(solved: false) {
      id
      title
      description
      deadline
      solved
      createdAt
      assignedTo {
        id
        name
      }
    }
  }
}`;

const TASKS_SOLVED_QUERY = `query tasksHistoryQuery($organizationNumber: ID!) {
  organization: organizationByObosNumber(companyNumber: $organizationNumber) {
    tasks(solved: true) {
      id
      title
      description
      deadline
      solved
      createdAt
      assignedTo {
        id
        name
      }
    }
  }
}`;

const TASK_DETAIL_QUERY = `query TaskPopover($id: NodeID!) {
  task(id: $id) {
    ...TaskPopover_task
  }
}
fragment TaskPopover_task on Task {
  id
  title
  description
  deadline
  createdBy {
    id
    userId
    firstName
    lastName
  }
  assignedTo {
    id
    name
    userId
    isViewer
    member {
      id
      firstName
    }
  }
  solved
  solvedAt
  solvedBy {
    id
    name
  }
  createdAt
  attachments {
    ...TaskPopover_attachments
  }
  comments {
    id
  }
  parent {
    id
    title
    meeting {
      id
    }
  }
  organization {
    ...AssignedTo_organization
  }
}
fragment TaskPopover_attachments on Attachment {
  id
  contentType
  url
  filename
  date: createdAt
}
fragment AssignedTo_organization on Organization {
  id
  members: executiveMembers {
    id
    roles
    name
    userId
    firstName
  }
}`;

export function registerBoardTaskTools(server: McpServer): void {
  server.registerTool(
    "list_board_tasks",
    {
      description:
        "List all tasks for the board, with direct 'webUrl' links to Styrerommet. Supports listing solved or unsolved (active) tasks.",
      inputSchema: z.object({
        solved: z
          .boolean()
          .default(false)
          .describe(
            "If true, list completed tasks. If false (default), list active unsolved tasks.",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ solved }) => {
      const operationName = solved ? "tasksHistoryQuery" : "tasksIndexQuery";
      const queryText = solved ? TASKS_SOLVED_QUERY : TASKS_UNSOLVED_QUERY;
      const orgId = getOrgId();

      const result = await graphqlQuery<{
        organization?: {
          tasks?: Array<{
            id: string;
            title: string;
            description: string;
            deadline: string | null;
            solved: boolean;
            createdAt: string;
            assignedTo?: { id: string; name: string };
          }>;
        };
      }>(operationName, queryText, { organizationNumber: orgId });

      const tasks = (result.data?.organization?.tasks || []).map((t: any) => ({
        ...t,
        webUrl: buildTasksWebUrl(orgId),
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_task_details",
    {
      description:
        "Get detailed information about a specific task, including full description, assignments, attachments, and direct 'webUrl' link to Styrerommet.",
      inputSchema: z.object({
        id: z.string().optional().describe("The NodeID of the task"),
        taskId: z
          .string()
          .optional()
          .describe("Alias for id: The NodeID of the task"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ id, taskId }) => {
      const targetId = taskId || id;
      if (!targetId) {
        throw new Error("Task id is required");
      }
      const orgId = getOrgId();
      const result = await graphqlQuery("TaskPopover", TASK_DETAIL_QUERY, {
        id: targetId,
      });
      const data = (result.data as any) || {};
      const webUrl = buildTasksWebUrl(orgId);
      return {
        content: [
          { type: "text", text: JSON.stringify({ ...data, webUrl }, null, 2) },
        ],
      };
    },
  );
}
