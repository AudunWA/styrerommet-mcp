import type { ToolAnnotations } from "@modelcontextprotocol/server";

/**
 * Standard annotation for read-only queries that do not modify state.
 */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  openWorldHint: true,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/**
 * Updates may overwrite state, add comments, or advance revisions.
 * Do not promise that retries are safe across all upstream services.
 */
export const UPDATE_ANNOTATIONS: ToolAnnotations = {
  openWorldHint: true,
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
};

/**
 * Standard annotation for non-idempotent creations (POST / add).
 */
export const CREATE_ANNOTATIONS: ToolAnnotations = {
  openWorldHint: true,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};

/**
 * Standard annotation for destructive operations (DELETE / remove / permanent changes).
 */
export const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  openWorldHint: true,
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};
