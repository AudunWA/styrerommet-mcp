import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId, getOrgNodeId } from "../client.ts";
import { buildMeetingWebUrl } from "../urls.ts";
import { registry } from "../registry.ts";

const MEETINGS_QUERY = `query adminMeetingsPage($obosCompanyNumber: OrganizationID!) {
  organization(id: $obosCompanyNumber) {
    id
    name
    obosCompanyNumber
    organizationCode
    organizationCodeDescription
    meetings {
      date
      id
      endDate
      ended
      signed
      location
      lockedForSigning
      createdFromTemplate
    }
    systemContacts {
      id
      firstName
      lastName
      jobTitle
      profilePhotoUrl
      phoneNumber
      role
      email
    }
  }
}`;

const MEETING_DETAIL_QUERY = `query meeting($id: NodeID!) {
    meeting(id: $id) {
      id
      date
      invitationUrl
      organization {
        id
        organizationCode
        obosCompanyNumber

        members: executiveMembers(filterOBOS: true) {
          id
          name
          roles
          email
          phoneNumber
          profilePhotoUrl
          firstName
          lastName
        }
        viewerAsMember {
          id
          personId
          userId
          name
          email
          roles
        }

        suggestedIssues: issues(states: [SUGGESTION, FOLLOWUP]) {
          needsFollowUp
          meeting {
            id
            endDate
            ended
            signed
          }
          ...Agenda_suggestedIssues
        }

        templateIssues {
          ...Agenda_suggestedIssues
        }
        meetings {
          id
        }
      }

      ...MeetingDetails_meeting
      ...MeetingMinute_meeting

      ended
      signed
      lockedForSigning
      viewerShouldSign

      issues {
        ...Agenda_issues
        ...Agenda_suggestedIssues
      }
    }
  }
fragment Agenda_suggestedIssues on Issue {
      ...SuggestedIssuesSidebar_issues
    }
fragment SuggestedIssuesSidebar_issues on Issue {
    id
    title
    createdAt
    updatedAt
    description
    parentId
    createdFromTemplateId
    isTemplate
    motion
    createdBy {
      id
      name
    }
  }
fragment MeetingDetails_meeting on Meeting {
        id
        date
        endDate
        location
        videoLocation
        invitationSentAt
        createdFromTemplate
      }
fragment MeetingMinute_meeting on Meeting {
      ...MeetingMinuteSignatureSection_meeting
      protocolUrl
      attendees {
        id
        name
        email
        shouldSign
        attended
        createdAt
        updatedAt
        invitationSentAt

        member {
          id
          name
          email
          roles
          personId
          firstName
          lastName
          profilePhotoUrl
        }
      }
      id
      date
      location
      videoLocation
      description
      organization {
        id
      }
      issues {
        id
        title
        description
        motion
        comment
        resolution
        attachments {
          id
          url
          filename
          contentType
        }
      }
    }
fragment MeetingMinuteSignatureSection_meeting on Meeting {
      id
      signed
      lockedForSigning
      viewerHasSigned
      viewerCanSign
      viewerShouldSign
      requiredSignees {
        id
        member {
          id
          name
        }
        name
      }
      signees {
        id
        name
      }
    }
fragment Agenda_issues on Issue {
      id
      ...AgendaItem_issue
    }
fragment AgendaItem_issue on Issue {
        id
        title
        resolved
        position

        organization {
          id
        }

        ...Issue
      }
fragment Issue on Issue {
  id
  title
  resolved
  description
  motion
  resolution
  informed
  comment
  needsFollowUp
  followUpDescription
  resolvedAt
  isTemplate
  createdAt
  createdBy {
    id
    name
  }
  updatedAt
  createdFromTemplateId
  parentId
  meeting {
    id
    date
  }
  tasks {
    id
    solved
    title
    deadline
    assignedTo {
      id
      name
    }
    comments {
      id
    }
  }
  organization {
    id
  }
  history {
    id
    title
    resolvedAt
    resolution
    resolved
    description
    followUpDescription
    comment
    meeting {
      id
    }
    attachments {
      id
      filename
      url
      contentType
    }
  }
  updatedBy {
    id
    name
  }
  attachments {
    id
    filename
    url
    contentType
  }
  createdFrom {
    id
  }
}`;

export function registerMeetingTools(server: McpServer): void {
  server.registerTool(
    "list_meetings",
    {
      description:
        "List all board meetings (both planned and completed) with dates, locations, signing status, and direct 'webUrl' links to Styrerommet",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const numericId = getOrgId();
      const result = await graphqlQuery("adminMeetingsPage", MEETINGS_QUERY, {
        obosCompanyNumber: numericId,
      });
      const data = result.data as any;
      if (data?.organization?.meetings) {
        data.organization.meetings = data.organization.meetings.map(
          (m: any) => ({
            ...m,
            webUrl: buildMeetingWebUrl(m.id, numericId),
          }),
        );
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "list_planned_meetings",
    {
      description:
        "List scheduled upcoming board meetings with planned dates, meeting IDs, and direct 'webUrl' links to Styrerommet",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const numericId = getOrgId();
      const op = registry.get("plannedMeetings");
      const orgNodeId = await getOrgNodeId();
      const result = await graphqlQuery<{
        organization?: { meetings?: Array<any> };
      }>(
        op?.operationName ?? "plannedMeetings",
        op?.queryText ??
          `query plannedMeetings($organizationId: OrganizationID!) {
          organization(id: $organizationId) {
            meetings: plannedMeetings {
              id
              date
            }
          }
        }`,
        { organizationId: orgNodeId },
      );
      const data = result.data as any;
      if (data?.organization?.meetings) {
        data.organization.meetings = data.organization.meetings.map(
          (m: any) => ({
            ...m,
            webUrl: buildMeetingWebUrl(m.id, numericId),
          }),
        );
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "list_meeting_issues",
    {
      description:
        "List board meeting agenda issues and cases (e.g. Tryg insurance claim, contractor follow-ups, HMS, maintenance)",
      inputSchema: z.object({
        status: z
          .enum(["ALL", "SUGGESTED", "RESOLVED"])
          .default("ALL")
          .describe(
            "Filter issues by status: SUGGESTED (open agenda items awaiting board review), RESOLVED (completed/decided issues), or ALL",
          ),
        query: z
          .string()
          .optional()
          .describe("Optional search string to filter issues by title"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ status, query }) => {
      const s = status ?? "ALL";
      const orgNodeId = await getOrgNodeId();
      let suggested: any[] = [];
      let resolved: any[] = [];

      if (s === "ALL" || s === "SUGGESTED") {
        const op = registry.get("suggestedMeetingIssues");
        if (op) {
          try {
            const res = await graphqlQuery<any>(
              op.operationName,
              op.queryText,
              {
                organizationId: orgNodeId,
              },
            );
            suggested = res.data?.organization?.suggestedIssues ?? [];
          } catch {}
        }
      }

      if (s === "ALL" || s === "RESOLVED") {
        const op = registry.get("resolvedMeetingIssues");
        if (op) {
          try {
            const res = await graphqlQuery<any>(
              op.operationName,
              op.queryText,
              {
                organizationId: orgNodeId,
              },
            );
            resolved = res.data?.organization?.resolvedIssues ?? [];
          } catch {}
        }
      }

      if (query) {
        const q = query.toLowerCase();
        suggested = suggested.filter((i: any) =>
          i.title?.toLowerCase().includes(q),
        );
        resolved = resolved.filter((i: any) =>
          i.title?.toLowerCase().includes(q),
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                totalSuggested: suggested.length,
                totalResolved: resolved.length,
                suggestedIssues: suggested,
                resolvedIssues: resolved,
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
    "get_meeting_issue",
    {
      description:
        "Get full details for a specific board meeting issue, including description text, formal board resolution text, meeting history, and attachment file links",
      inputSchema: z.object({
        issueId: z
          .string()
          .optional()
          .describe(
            "The NodeID of the issue (retrieved via list_meeting_issues)",
          ),
        id: z.string().optional().describe("Alternative ID for the issue"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ issueId, id }) => {
      let targetIssueId = issueId ?? id;
      if (!targetIssueId) {
        try {
          const orgNodeId = await getOrgNodeId();
          const op = registry.get("suggestedMeetingIssues");
          if (op) {
            const res = await graphqlQuery<any>(
              op.operationName,
              op.queryText,
              { organizationId: orgNodeId },
            );
            targetIssueId = res.data?.organization?.suggestedIssues?.[0]?.id;
          }
        } catch {}
      }

      if (!targetIssueId) {
        return {
          content: [{ type: "text", text: "No issueId specified or found." }],
          isError: true,
        };
      }

      try {
        const op = registry.get("getIssue");
        if (!op) {
          throw new Error("getIssue operation not found in registry");
        }
        const result = await graphqlQuery<any>(op.operationName, op.queryText, {
          id: targetIssueId,
        });

        const issue = result.data?.issue;
        if (!issue) {
          return {
            content: [
              {
                type: "text",
                text: `Issue not found for ID: ${targetIssueId}`,
              },
            ],
            isError: true,
          };
        }

        let plainDescription = "";
        if (
          typeof issue.description === "object" &&
          issue.description?.blocks
        ) {
          plainDescription = issue.description.blocks
            .map((b: any) => b.text)
            .filter(Boolean)
            .join("\n\n");
        } else if (typeof issue.description === "string") {
          plainDescription = issue.description;
        }

        const formatted = {
          ...issue,
          descriptionText: plainDescription,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching meeting issue ${targetIssueId}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get_meeting",
    {
      description:
        "Get details of a specific board meeting, including agenda, attendees, protocols, and direct 'webUrl' link to Styrerommet",
      inputSchema: z.object({
        meetingId: z.string().optional().describe("The meeting node ID"),
        id: z.string().optional().describe("Alternative meeting node ID"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ meetingId, id }) => {
      let targetMeetingId = meetingId ?? id;
      const numericId = getOrgId();
      if (!targetMeetingId) {
        try {
          const res = await graphqlQuery<any>(
            "adminMeetingsPage",
            MEETINGS_QUERY,
            { obosCompanyNumber: numericId },
          );
          targetMeetingId = res.data?.organization?.meetings?.[0]?.id;
        } catch {}
      }

      if (!targetMeetingId) {
        return {
          content: [{ type: "text", text: "No meetingId specified or found." }],
          isError: true,
        };
      }

      try {
        const result = await graphqlQuery("meeting", MEETING_DETAIL_QUERY, {
          id: targetMeetingId,
        });
        const data = (result.data as any) || {};
        const webUrl = buildMeetingWebUrl(
          data.meeting?.id || targetMeetingId,
          numericId,
        );
        if (data.meeting) {
          data.meeting = {
            ...data.meeting,
            webUrl,
          };
        }
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
              text: `Error fetching meeting ${targetMeetingId}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
