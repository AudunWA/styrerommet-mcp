import { READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { graphqlQuery, getOrgId } from "../client.ts";
import { buildGeneralAssemblyWebUrl } from "../urls.ts";

const ASSEMBLIES_QUERY = `query generalAssembliesPage($organizationNumber: ID!) {
  organization: organizationByObosNumber(companyNumber: $organizationNumber) {
    id
    name
    obosCompanyNumber
    assemblies: generalAssemblies {
      id
      slug
      date
      endDate
      phase
      location
      ordinary
      year
      signed
      digital
      proposalsEndAt
      inviteScheduledFor
      createdAt
    }
  }
}`;

const ASSEMBLY_DETAIL_QUERY = `query generalAssemblyOwnerPage($obosCompanyNumber: OrganizationID!, $slug: String!) {
  assembly: generalAssembly(organizationId: $obosCompanyNumber, slug: $slug) {
    id
    slug
    date
    phase
    endDate
    ended
    ordinary
    digital
    year
    physicalMeetingDate
    location
    videoLocation
    proposalsEndAt
    proposalsSkipped
    invitationSentAt
    agendaIsVisibleToOwner
    viewerHasSeen
    inSession
    issues {
      ...GeneralAssembly_issues
      ...GeneralAssembly_election_issues
    }
    proposals(createdByViewer: true) {
      ...GeneralAssembly_proposals
    }
    organization {
      id
      obosCompanyNumber
      name
      viewerAsMember {
        id
        personId
        votesInAssembly
      }
      members: executiveMembers {
        id
        name
        roles
        email
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
  }
  viewer {
    id
    personId
    name
    memberships {
      obosCompanyNumber
      roles
    }
  }
}
fragment GeneralAssembly_issues on GeneralAssemblyIssue {
  id
  ...GeneralAssembly_issue
}
fragment GeneralAssembly_issue on GeneralAssemblyIssue {
  title
  description
  ... on GeneralAssemblyIssue {
    suggestedBy
    position
    requiredMajority
    requiredMotionMajority
    multiMotionVoting
    attachments {
      id
      filename
      url
      contentType
    }
    createdAt
    createdBy {
      id
      name
    }
    updatedOnAssembly
    organization {
      id
    }
    motions {
      id
      motion
      createdAt
      updatedAt
      createdOnAssembly
      updatedOnAssembly
    }
    recommendation
    proposal {
      id
      createdBy {
        id
        name
      }
    }
    ...GeneralAssembly_issueResults
    ...GeneralAssembly_motionVote
    ...GeneralAssemblyIssue__Comments
  }
  __typename
}
fragment GeneralAssembly_issueResults on GeneralAssemblyIssue {
  votingResults {
    passed
    issueId
    passedMotionId
    totalVotes
    votesAgainst
    votesFor
    votesBlank
    resolvedByChance
    motionVotes {
      motionId
      passed
      votesFor
    }
  }
}
fragment GeneralAssembly_motionVote on GeneralAssemblyIssue {
  viewerVotes {
    motionId
    vote
  }
}
fragment GeneralAssemblyIssue__Comments on GeneralAssemblyIssue {
  comments {
    id
    content
    createdAt
    createdBy {
      id
      name
      jobTitle
    }
    attachments {
      id
      filename
      url
      contentType
    }
  }
}
fragment GeneralAssembly_election_issues on GeneralAssemblyElectionIssue {
  id
  ...GeneralAssembly_election_issue
}
fragment GeneralAssembly_election_issue on GeneralAssemblyElectionIssue {
  title
  description
  recommendation
  position
  attachments {
    id
    filename
    url
    contentType
  }
  ...GeneralAssembly_election_issue_viewer_votes
  createdAt
  createdBy {
    id
    name
  }
  updatedOnAssembly
  candidates {
    id
    motivation
    createdOnAssembly
    updatedOnAssembly
    roles {
      id
      settingsId
    }
    nominee {
      firstName
      lastName
    }
    nominatedBy {
      name
    }
    resolvedByChance
    votesFor
    electedAs {
      role
      electedFor
      settingsId
      id
    }
  }
  election {
    role
    seats
    id
    electedFor
  }
  __typename
}
fragment GeneralAssembly_election_issue_viewer_votes on GeneralAssemblyElectionIssue {
  viewerVotes {
    role
    issueId
    candidateId
  }
}
fragment GeneralAssembly_proposals on GeneralAssemblyProposal {
  id
  title
  description
  motionProposal
  createdAt
  createdBy {
    id
    name
  }
  accepted
  rejected
  rejectionReason
  attachments {
    id
    filename
    url
    contentType
  }
}`;

export function registerAssemblyTools(server: McpServer): void {
  server.registerTool(
    "list_general_assemblies",
    {
      description:
        "List all annual meetings and general assemblies (Generalforsamlinger / Sameiermøter) for the organization, with direct 'webUrl' links to Styrerommet",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const numericId = getOrgId();
      const result = await graphqlQuery(
        "generalAssembliesPage",
        ASSEMBLIES_QUERY,
        { organizationNumber: numericId },
      );
      const data = result.data as any;
      if (data?.organization?.assemblies) {
        data.organization.assemblies = data.organization.assemblies.map(
          (a: any) => ({
            ...a,
            webUrl: buildGeneralAssemblyWebUrl(a.slug, numericId),
          }),
        );
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "get_general_assembly",
    {
      description:
        "Get detailed information about a specific general assembly by its slug (e.g. '2026'), including direct 'webUrl' link to Styrerommet",
      inputSchema: z.object({
        slug: z
          .string()
          .optional()
          .describe("The slug of the assembly (e.g. '2026', '2025-2')"),
        assemblyId: z
          .string()
          .optional()
          .describe("Alternative slug or assembly ID"),
        id: z.string().optional().describe("Alternative slug or assembly ID"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ slug, assemblyId, id }) => {
      let targetSlug = slug ?? assemblyId ?? id;
      const numericId = getOrgId();
      if (!targetSlug) {
        try {
          const listRes = await graphqlQuery<any>(
            "generalAssembliesPage",
            ASSEMBLIES_QUERY,
            { organizationNumber: numericId },
          );
          targetSlug = listRes.data?.organization?.assemblies?.[0]?.slug;
        } catch {}
      }

      if (!targetSlug) {
        return {
          content: [
            { type: "text", text: "No assembly slug specified or found." },
          ],
          isError: true,
        };
      }

      try {
        const result = await graphqlQuery(
          "generalAssemblyOwnerPage",
          ASSEMBLY_DETAIL_QUERY,
          {
            obosCompanyNumber: numericId,
            slug: targetSlug,
          },
        );
        const data = (result.data as any) || {};
        const webUrl = buildGeneralAssemblyWebUrl(targetSlug, numericId);
        if (data.assembly) {
          data.assembly = {
            ...data.assembly,
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
              text: `Error fetching general assembly ${targetSlug}: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
