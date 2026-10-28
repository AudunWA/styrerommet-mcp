import fs from "node:fs/promises";
import path from "node:path";

export interface DiscoveredOperation {
  operationName: string;
  operationType: string;
  queryText: string;
}

/** Decode extracted bundle escapes once, preserving escaped backslashes. */
export function decodeQueryText(text: string): string {
  return text.replace(/\\[nt\\"]/g, (escape) => {
    switch (escape) {
      case "\\n": return "\n";
      case "\\t": return "  ";
      case "\\\\": return "\\";
      case '\\"': return '"';
      default: return escape;
    }
  });
}

/**
 * Registry of discovered GraphQL operations from styrerommet.no.
 * Only query operations are allowed — mutations are filtered out for safety.
 */
class OperationRegistry {
  private operations = new Map<string, DiscoveredOperation>();
  private loaded = false;

  /**
   * Load operations from the discovered queries JSON file.
   * Only loads query operations (mutations and subscriptions are excluded).
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    const filePath = path.resolve(
      import.meta.dirname,
      "../data/graphql-discovered-queries.json",
    );

    const content = await fs.readFile(filePath, "utf-8");
    const allOperations = JSON.parse(content) as DiscoveredOperation[];

    // Safety: Only allow query operations
    for (const op of allOperations) {
      if (op.operationType === "query") {
        // Unescape the query text (from JS bundle extraction)
        op.queryText = decodeQueryText(op.queryText);
        this.operations.set(op.operationName, op);
      }
    }

    this.loaded = true;
  }

  /**
   * Get a query operation by name. Returns undefined for unknown or non-query operations.
   */
  get(name: string): DiscoveredOperation | undefined {
    return this.operations.get(name);
  }

  /**
   * Get all available query operation names.
   */
  listQueryNames(): string[] {
    return [...this.operations.keys()].sort();
  }

  /**
   * Check if an operation exists and is a query.
   */
  has(name: string): boolean {
    return this.operations.has(name);
  }

  /**
   * Get total number of available queries.
   */
  get size(): number {
    return this.operations.size;
  }
}

export const registry = new OperationRegistry();
