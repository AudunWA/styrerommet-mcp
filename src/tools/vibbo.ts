import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  vibboGraphqlQuery,
  getVibboOrgSlug,
  getVibboOrgNodeId,
} from "../vibbo-client.ts";
import { vibboRegistry } from "../vibbo-registry.ts";
import { buildVibboWebUrl } from "../urls.ts";
import { convertDraftBlocksToMarkdown } from "./topics.ts";

export function registerVibboTools(server: McpServer): void {
  // 1. Pending applications
  server.registerTool(
    "vibbo_get_pending_applications",
    {
      description:
        "List all pending resident applications awaiting board approval or handling on Vibbo (includes applicant name, email, phone, apartment number, and role)",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const op = vibboRegistry.get("vibboOrganizationPendingApplications");
      if (!op) {
        throw new Error(
          "Operation vibboOrganizationPendingApplications not found",
        );
      }
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationSlug: getVibboOrgSlug(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  // 2. Transfer / sublease applications (bruksoverlating / framleie)
  server.registerTool(
    "vibbo_get_transfer_applications",
    {
      description:
        "List sublease / rental transfer applications (bruksoverlating / framleie) on Vibbo with tenant details, contract dates, approval status, and apartment information",
      inputSchema: z.object({
        status: z
          .enum(["ALL", "APPROVED", "PENDING", "REJECTED"])
          .default("ALL")
          .describe("Filter applications by status"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ status }) => {
      const op = vibboRegistry.get("vibboResidentAdministrationPage");
      if (!op) {
        throw new Error("Operation vibboResidentAdministrationPage not found");
      }
      const result = await vibboGraphqlQuery<{
        organization?: {
          transferApplications?: Array<Record<string, any>>;
          transferApplicationChanges?: Array<Record<string, any>>;
        };
      }>(op.operationName, op.queryText, {
        organizationSlug: getVibboOrgSlug(),
      });

      let apps = result.data?.organization?.transferApplications ?? [];
      if (status !== "ALL") {
        apps = apps.filter((a) => a.status === status);
      }

      const output = {
        total: apps.length,
        transferApplications: apps,
        transferApplicationChanges:
          result.data?.organization?.transferApplicationChanges ?? [],
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  );

  // 3. List residents
  server.registerTool(
    "vibbo_list_residents",
    {
      description:
        "List all registered residents on Vibbo with apartment numbers, H-numbers (residentialNumber), street address, email, phone number, and residency type (OWNER, TENANT, etc.)",
      inputSchema: z.object({
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
    async ({ apartmentNumber, query }) => {
      const op = vibboRegistry.get("vibboResidentAdministrationPage");
      if (!op) {
        throw new Error("Operation vibboResidentAdministrationPage not found");
      }
      const result = await vibboGraphqlQuery<{
        organization?: {
          residents?: Array<Record<string, any>>;
        };
      }>(op.operationName, op.queryText, {
        organizationSlug: getVibboOrgSlug(),
      });

      let residents = result.data?.organization?.residents ?? [];

      if (apartmentNumber !== undefined) {
        residents = residents.filter((r) =>
          r.residencies?.some(
            (res: any) => res.apartment?.apartmentNumber === apartmentNumber,
          ),
        );
      }

      if (query) {
        const q = query.toLowerCase();
        residents = residents.filter((r) => {
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
              { count: residents.length, residents },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 4. Resident statistics
  server.registerTool(
    "vibbo_get_resident_statistics",
    {
      description:
        "Get summary statistics on Vibbo adoption, registered residents, and notification consents (push notifications, email consent, SMS consent)",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const op = vibboRegistry.get("vibboResidentStatistics");
      if (!op) {
        throw new Error("Operation vibboResidentStatistics not found");
      }
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationSlug: getVibboOrgSlug(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  // 5. List threads (resident communication with board)
  server.registerTool(
    "vibbo_list_threads",
    {
      description:
        "List message threads between residents and the board on Vibbo, with full conversation messages, correspondent details, attachments, and direct 'webUrl' links",
      inputSchema: z.object({
        status: z
          .enum(["ALL", "ANSWERED", "UNANSWERED", "ARCHIVED"])
          .default("ALL")
          .describe("Filter message threads by status"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Maximum number of threads to return"),
        search: z
          .string()
          .optional()
          .describe("Optional search term across thread titles and bodies"),
        apartmentNumber: z
          .number()
          .int()
          .optional()
          .describe("Filter threads by resident apartment number"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ status, limit, search, apartmentNumber }) => {
      const op = vibboRegistry.get("vibboThreadsQuery");
      if (!op) {
        throw new Error("Operation vibboThreadsQuery not found");
      }
      const orgNodeId = await getVibboOrgNodeId();
      const orgSlug = getVibboOrgSlug();
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationId: orgNodeId,
        boardPerspective: true,
        status: status ?? "ALL",
        limit: limit ?? 15,
        search: search ?? null,
        apartmentNumber: apartmentNumber ?? null,
      });
      const data = result.data as any;
      if (data?.organization?.threads?.threads) {
        data.organization.threads.threads =
          data.organization.threads.threads.map((t: any) => ({
            ...t,
            webUrl: buildVibboWebUrl("meldinger", t.slug, orgSlug),
          }));
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // 6. Get single thread by slug
  server.registerTool(
    "vibbo_get_thread",
    {
      description:
        "Get full details and all messages for a specific Vibbo message thread by thread slug, including direct 'webUrl' link",
      inputSchema: z.object({
        threadSlug: z.string().optional().describe("The slug of the thread"),
        slug: z.string().optional().describe("Alternative slug for the thread"),
        threadId: z
          .string()
          .optional()
          .describe("Alternative ID for the thread"),
        id: z.string().optional().describe("Alternative ID for the thread"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ threadSlug, slug, threadId, id }) => {
      let targetSlug = threadSlug ?? slug ?? threadId ?? id;
      if (!targetSlug) {
        try {
          const op = vibboRegistry.get("vibboThreadsQuery");
          if (op) {
            const orgNodeId = await getVibboOrgNodeId();
            const res = await vibboGraphqlQuery<any>(
              op.operationName,
              op.queryText,
              {
                organizationId: orgNodeId,
                boardPerspective: true,
                status: "ALL",
                limit: 5,
              },
            );
            targetSlug = res.data?.organization?.threads?.threads?.[0]?.slug;
          }
        } catch {}
      }

      if (!targetSlug) {
        return {
          content: [
            { type: "text", text: "No threadSlug specified or found." },
          ],
          isError: true,
        };
      }

      try {
        const op = vibboRegistry.get("vibboThreadBySlug");
        if (!op) {
          throw new Error("Operation vibboThreadBySlug not found");
        }
        const orgNodeId = await getVibboOrgNodeId();
        const orgSlug = getVibboOrgSlug();
        const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
          threadSlug: targetSlug,
          organizationId: orgNodeId,
        });
        const data = (result.data as any) || {};
        const webUrl = buildVibboWebUrl("meldinger", targetSlug, orgSlug);
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
              text: `Error fetching thread ${targetSlug}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 7. News announcements
  server.registerTool(
    "vibbo_list_news",
    {
      description:
        "List published news announcements and board updates sent to residents on Vibbo, with direct 'webUrl' links",
      inputSchema: z.object({
        first: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of news articles to retrieve"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ first }) => {
      const op = vibboRegistry.get("vibboBrowseNews");
      if (!op) {
        throw new Error("Operation vibboBrowseNews not found");
      }
      const orgNodeId = await getVibboOrgNodeId();
      const orgSlug = getVibboOrgSlug();
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationId: orgNodeId,
        first: first ?? 10,
      });
      const data = result.data as any;
      if (data?.organization?.latestNews) {
        data.organization.latestNews = data.organization.latestNews.map(
          (n: any) => ({
            ...n,
            webUrl: buildVibboWebUrl("nyheter", n.slug, orgSlug),
          }),
        );
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // 8. Get news article by slug
  server.registerTool(
    "vibbo_get_news",
    {
      description:
        "Get full content and details for a specific Vibbo news article by its slug, including direct 'webUrl' link",
      inputSchema: z.object({
        newsSlug: z
          .string()
          .optional()
          .describe("The slug of the news article"),
        slug: z
          .string()
          .optional()
          .describe("Alternative slug for the news article"),
        newsId: z
          .string()
          .optional()
          .describe("Alternative ID for the news article"),
        id: z
          .string()
          .optional()
          .describe("Alternative ID for the news article"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ newsSlug, slug, newsId, id }) => {
      let targetSlug = newsSlug ?? slug ?? newsId ?? id;
      if (!targetSlug) {
        try {
          const op = vibboRegistry.get("vibboBrowseNews");
          if (op) {
            const orgNodeId = await getVibboOrgNodeId();
            const res = await vibboGraphqlQuery<any>(
              op.operationName,
              op.queryText,
              {
                organizationId: orgNodeId,
                first: 5,
              },
            );
            targetSlug = res.data?.organization?.latestNews?.[0]?.slug;
          }
        } catch {}
      }

      if (!targetSlug) {
        return {
          content: [{ type: "text", text: "No newsSlug specified or found." }],
          isError: true,
        };
      }

      try {
        const op = vibboRegistry.get("vibboNewsPage");
        if (!op) {
          throw new Error("Operation vibboNewsPage not found");
        }
        const orgNodeId = await getVibboOrgNodeId();
        const orgSlug = getVibboOrgSlug();
        const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
          organizationId: orgNodeId,
          newsSlug: targetSlug,
        });
        const data = (result.data as any) || {};
        const webUrl = buildVibboWebUrl("nyheter", targetSlug, orgSlug);
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
              text: `Error fetching news article ${targetSlug}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 9. List topics / resident handbook
  server.registerTool(
    "vibbo_list_topics",
    {
      description:
        "List all resident handbook information topics published on Vibbo (e.g. vaktmester, husordensregler, vaskeri, ringeklokke, etc.) with direct 'webUrl' links",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const op = vibboRegistry.get("vibboBrowseTopics");
      if (!op) {
        throw new Error("Operation vibboBrowseTopics not found");
      }
      const orgNodeId = await getVibboOrgNodeId();
      const orgSlug = getVibboOrgSlug();
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationId: orgNodeId,
      });
      const data = result.data as any;
      if (data?.organization?.topics) {
        data.organization.topics = data.organization.topics.map((t: any) => ({
          ...t,
          webUrl: buildVibboWebUrl("tema", t.slug, orgSlug),
        }));
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // 10. Get topic content by slug
  server.registerTool(
    "vibbo_get_topic",
    {
      description:
        "Get full content and details of a specific Vibbo resident handbook topic page by slug, including direct 'webUrl' link",
      inputSchema: z.object({
        topicSlug: z.string().optional().describe("The slug of the topic page"),
        slug: z
          .string()
          .optional()
          .describe("Alternative slug for the topic page"),
        topicId: z
          .string()
          .optional()
          .describe("Alternative ID for the topic page"),
        id: z.string().optional().describe("Alternative ID for the topic page"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ topicSlug, slug, topicId, id }) => {
      let targetSlug = topicSlug ?? slug ?? topicId ?? id;
      if (!targetSlug) {
        try {
          const op = vibboRegistry.get("vibboBrowseTopics");
          if (op) {
            const orgNodeId = await getVibboOrgNodeId();
            const res = await vibboGraphqlQuery<any>(
              op.operationName,
              op.queryText,
              {
                organizationId: orgNodeId,
              },
            );
            targetSlug = res.data?.organization?.topics?.[0]?.slug;
          }
        } catch {}
      }

      if (!targetSlug) {
        return {
          content: [{ type: "text", text: "No topicSlug specified or found." }],
          isError: true,
        };
      }

      try {
        const op = vibboRegistry.get("vibboTopicPage");
        if (!op) {
          throw new Error("Operation vibboTopicPage not found");
        }
        const orgNodeId = await getVibboOrgNodeId();
        const orgSlug = getVibboOrgSlug();
        const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
          organizationId: orgNodeId,
          topicSlug: targetSlug,
        });
        const data = (result.data as any) || {};
        if (data.organization?.topic) {
          const topic = data.organization.topic;
          if (topic.article) {
            topic.articleMarkdown = convertDraftBlocksToMarkdown(topic.article);
          }
          if (topic.draft?.content) {
            topic.draftMarkdown = convertDraftBlocksToMarkdown(
              topic.draft.content,
            );
          }
        }
        const webUrl = buildVibboWebUrl("tema", targetSlug, orgSlug);
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
              text: `Error fetching topic ${targetSlug}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 11. List community posts
  server.registerTool(
    "vibbo_list_posts",
    {
      description: "List resident community discussion posts on the Vibbo feed",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Maximum number of posts to return"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      const op = vibboRegistry.get("vibboBrowsePosts");
      if (!op) {
        throw new Error("Operation vibboBrowsePosts not found");
      }
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationSlug: getVibboOrgSlug(),
        limit: limit ?? 20,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  // 12. Shared calendars
  server.registerTool(
    "vibbo_list_calendars",
    {
      description:
        "List shared facility and item calendars available on Vibbo (e.g. rooms, tools) and reservations",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const op = vibboRegistry.get("vibboBrowseCalendars");
      if (!op) {
        throw new Error("Operation vibboBrowseCalendars not found");
      }
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationSlug: getVibboOrgSlug(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  // 13. Resident documents
  server.registerTool(
    "vibbo_list_documents",
    {
      description:
        "List resident documents published on Vibbo (husordensregler, vedtekter, brannvern, etc.) with direct download URLs",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const op = vibboRegistry.get("vibboDocuments");
      if (!op) {
        throw new Error("Operation vibboDocuments not found");
      }
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationSlug: getVibboOrgSlug(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  // 14. Community events (dugnad, meetings, parties)
  server.registerTool(
    "vibbo_list_events",
    {
      description:
        "List community events (e.g. dugnad, summer party, general assembly, info meetings) on Vibbo with dates, locations, publish status, and direct 'webUrl' links",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const op = vibboRegistry.get("vibboBrowseEvents");
      if (!op) {
        throw new Error("Operation vibboBrowseEvents not found");
      }
      const orgNodeId = await getVibboOrgNodeId();
      const orgSlug = getVibboOrgSlug();
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationId: orgNodeId,
        filters: {},
      });
      const data = result.data as any;
      if (data?.vibboEvents?.events) {
        data.vibboEvents.events = data.vibboEvents.events.map((e: any) => ({
          ...e,
          webUrl: buildVibboWebUrl("hendelser", e.slug, orgSlug),
        }));
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // 15. Single event details
  server.registerTool(
    "vibbo_get_event",
    {
      description:
        "Get full details, attendee RSVPs, resident comments, and direct 'webUrl' link for a specific Vibbo event by slug",
      inputSchema: z.object({
        eventSlug: z
          .string()
          .optional()
          .describe("The slug of the event (retrieved via vibbo_list_events)"),
        slug: z.string().optional().describe("Alternative slug for the event"),
        eventId: z.string().optional().describe("Alternative ID for the event"),
        id: z.string().optional().describe("Alternative ID for the event"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ eventSlug, slug, eventId, id }) => {
      let targetSlug = eventSlug ?? slug ?? eventId ?? id;
      if (!targetSlug) {
        try {
          const op = vibboRegistry.get("vibboBrowseEvents");
          if (op) {
            const orgNodeId = await getVibboOrgNodeId();
            const res = await vibboGraphqlQuery<any>(
              op.operationName,
              op.queryText,
              {
                organizationId: orgNodeId,
                filters: {},
              },
            );
            targetSlug = res.data?.vibboEvents?.events?.[0]?.slug;
          }
        } catch {}
      }

      if (!targetSlug) {
        return {
          content: [{ type: "text", text: "No eventSlug specified or found." }],
          isError: true,
        };
      }

      try {
        const op = vibboRegistry.get("vibboEventBySlug");
        if (!op) {
          throw new Error("Operation vibboEventBySlug not found");
        }
        const orgNodeId = await getVibboOrgNodeId();
        const orgSlug = getVibboOrgSlug();
        const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
          organizationId: orgNodeId,
          slug: targetSlug,
        });
        const data = (result.data as any) || {};
        const webUrl = buildVibboWebUrl("hendelser", targetSlug, orgSlug);
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
              text: `Error fetching event ${targetSlug}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // 16. Resident groups (e.g. Hagegruppa, Vaskerigruppa)
  server.registerTool(
    "vibbo_list_groups",
    {
      description:
        "List internal resident interest groups (e.g. Hagegruppa, Vaskerigruppa) configured on Vibbo",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const op = vibboRegistry.get("allVibboGroups");
      if (!op) {
        throw new Error("Operation allVibboGroups not found");
      }
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationSlug: getVibboOrgSlug(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  // 17. Resident General Assembly proposals
  server.registerTool(
    "vibbo_get_assembly_proposals",
    {
      description:
        "List proposals submitted by residents on Vibbo for the General Assembly (Generalforsamling / Årsmøte)",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const op = vibboRegistry.get("vibboProposalsPage");
      if (!op) {
        throw new Error("Operation vibboProposalsPage not found");
      }
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationSlug: getVibboOrgSlug(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  // 18. Live activity stream
  server.registerTool(
    "vibbo_get_activity_stream",
    {
      description:
        "Get the recent live activity stream of posts, comments, and community actions on Vibbo",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Number of recent activity items to retrieve"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      const op = vibboRegistry.get("vibboActivityStream");
      if (!op) {
        throw new Error("Operation vibboActivityStream not found");
      }
      const orgNodeId = await getVibboOrgNodeId();
      const result = await vibboGraphqlQuery(op.operationName, op.queryText, {
        organizationId: orgNodeId,
        limit,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  // 19. Generic Vibbo GraphQL query runner (read-only queries only!)
  server.registerTool(
    "vibbo_graphql",
    {
      description: `Execute any discovered read-only GraphQL query from Vibbo by operation name.
Only query operations are allowed — mutations are strictly blocked for safety.
Use 'vibbo_list_operations' first to see all available queries.`,
      inputSchema: z.object({
        operationName: z
          .string()
          .describe(
            "The Vibbo GraphQL operation name (e.g. 'vibboResidentAdministrationPage', 'vibboBrowseNews'). Use vibbo_list_operations to see all available queries.",
          ),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Variables to pass to the GraphQL query. Note: Some queries require $organizationSlug (for example, 'your-cooperative') while others require $organizationId as the base64 NodeID (e.g. 'T3JnYW5pemF0aW9uOi...').",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operationName, variables }) => {
      const operation = vibboRegistry.get(operationName);
      if (!operation) {
        const suggestion = vibboRegistry
          .listQueryNames()
          .filter((n) => n.toLowerCase().includes(operationName.toLowerCase()))
          .slice(0, 5);

        let errorMsg = `Unknown or disallowed operation: "${operationName}". Only read-only queries are available.`;
        if (suggestion.length > 0) {
          errorMsg += `\n\nDid you mean: ${suggestion.join(", ")}?`;
        }
        errorMsg += `\n\nUse the 'vibbo_list_operations' tool to see all ${vibboRegistry.size} available queries.`;

        return {
          content: [{ type: "text", text: errorMsg }],
          isError: true,
        };
      }

      const result = await vibboGraphqlQuery(
        operationName,
        operation.queryText,
        variables ?? {},
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    },
  );

  // 15. List operations
  server.registerTool(
    "vibbo_list_operations",
    {
      description:
        "List all available read-only Vibbo GraphQL query operations. Use this to discover what queries you can run with the 'vibbo_graphql' tool.",
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
      let names = vibboRegistry.listQueryNames();
      if (filter) {
        const lower = filter.toLowerCase();
        names = names.filter((n) => n.toLowerCase().includes(lower));
      }

      const lines = names.map((name) => {
        const op = vibboRegistry.get(name);
        const varMatch = op?.queryText.match(/(?:query)\s+\w+(?:\(([^)]+)\))?/);
        const vars =
          varMatch && varMatch[1]
            ? varMatch[1].trim().replace(/\s+/g, " ")
            : "(no variables)";
        return `• ${name}  —  ${vars}`;
      });

      const header = filter
        ? `Found ${lines.length} queries matching "${filter}" (out of ${vibboRegistry.size} total):`
        : `All ${vibboRegistry.size} available read-only Vibbo queries:`;

      return {
        content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}` }],
      };
    },
  );

  // 16. Get operation schema
  server.registerTool(
    "vibbo_get_operation_schema",
    {
      description:
        "Get the full GraphQL query text for a specific Vibbo operation, so you can inspect its fields and parameters.",
      inputSchema: z.object({
        operationName: z
          .string()
          .describe("The Vibbo operation name to inspect"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operationName }) => {
      const operation = vibboRegistry.get(operationName);
      if (!operation) {
        return {
          content: [
            {
              type: "text",
              text: `Operation "${operationName}" not found. Use vibbo_list_operations to see available queries.`,
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
