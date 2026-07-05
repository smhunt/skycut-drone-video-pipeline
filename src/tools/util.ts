import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { UserError } from "../core/errors.js";
import type { ProgressReporter } from "../core/progress.js";

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

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * MCP progress reporter for long-running tools. Returns undefined when the client
 * didn't request progress (no progressToken) — pipelines treat that as a no-op.
 * Notification failures are swallowed; progress must never break the work itself.
 */
export function progressReporter(extra: ToolExtra): ProgressReporter | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  return (progress, total, message) => {
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total, message },
      })
      .catch(() => {});
  };
}
