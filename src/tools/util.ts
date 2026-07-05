import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UserError } from "../core/errors.js";

/**
 * Wrap a tool handler: expected UserErrors become clean isError results,
 * unexpected errors include the stack trace for debuggability.
 */
export function toolHandler<A extends unknown[]>(
  fn: (...args: A) => Promise<CallToolResult>
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      const text =
        err instanceof UserError
          ? err.message
          : `Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
      return { isError: true, content: [{ type: "text", text }] };
    }
  };
}

export function ok(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}
