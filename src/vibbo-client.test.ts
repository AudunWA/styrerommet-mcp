import test from "node:test";
import assert from "node:assert/strict";
import { vibboRegistry } from "./vibbo-registry.ts";
import { getVibboOrgSlug } from "./vibbo-client.ts";

test("vibboRegistry loads all discovered read-only queries", async () => {
  await vibboRegistry.load();

  assert.ok(vibboRegistry.size > 0, "Registry should contain operations");
  assert.equal(vibboRegistry.size, 97, "Expected exactly 97 read-only queries");

  // Key queries must exist
  const expectedQueries = [
    "vibboOrganizationPendingApplications",
    "vibboResidentAdministrationPage",
    "vibboResidentStatistics",
    "vibboThreadsQuery",
    "vibboThreadBySlug",
    "vibboThreadMessagesBySlug",
    "vibboBrowseNews",
    "vibboNewsPage",
    "vibboBrowseTopics",
    "vibboTopicPage",
    "vibboBrowsePosts",
    "vibboBrowseCalendars",
    "vibboDocuments",
    "vibboBrowseEvents",
    "vibboEventBySlug",
    "allVibboGroups",
    "vibboProposalsPage",
    "vibboActivityStream",
  ];

  for (const name of expectedQueries) {
    assert.ok(
      vibboRegistry.has(name),
      `Expected registry to have query "${name}"`,
    );
    const op = vibboRegistry.get(name);
    assert.ok(op, `Operation "${name}" should be defined`);
    assert.equal(
      op.operationType,
      "query",
      `Operation "${name}" must be a query`,
    );
    assert.ok(
      op.queryText.length > 0,
      `Query text for "${name}" should not be empty`,
    );
    assert.doesNotMatch(
      op.queryText,
      /\\n/,
      `Query text for "${name}" should have clean newlines instead of literal \\n`,
    );
  }
});

test("vibboRegistry strictly excludes mutations for safety", async () => {
  await vibboRegistry.load();

  const disallowedMutations = [
    "createPost",
    "acceptResidentApplication",
    "rejectResidentApplication",
    "deletePost",
    "sendMessage",
    "createBooking",
    "deleteBooking",
    "publishNews",
    "deleteNews",
    "updateOrganizationExtraData",
  ];

  for (const mut of disallowedMutations) {
    assert.equal(
      vibboRegistry.has(mut),
      false,
      `Mutation "${mut}" MUST NOT be accessible in the query registry`,
    );
    assert.equal(
      vibboRegistry.get(mut),
      undefined,
      `Getting mutation "${mut}" must return undefined`,
    );
  }
});

test("getVibboOrgSlug returns the configured slug", () => {
  const previous = process.env.VIBBO_ORG_SLUG;
  process.env.VIBBO_ORG_SLUG = "example-coop";
  try {
    assert.equal(getVibboOrgSlug(), "example-coop");
  } finally {
    if (previous === undefined) delete process.env.VIBBO_ORG_SLUG;
    else process.env.VIBBO_ORG_SLUG = previous;
  }
});
