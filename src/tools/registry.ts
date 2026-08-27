import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { YnabClient } from "../client.ts";
import { describeFailure } from "../errors.ts";

/** Everything a handler gets besides its own arguments. */
export interface ToolContext {
  readonly client: YnabClient;
}

/**
 * The four MCP behaviour hints. All four are required so that no tool ships
 * without a stated safety posture. See AGENTS.md, "The tool registry".
 */
export interface ToolHints {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** The arguments or result object a raw zod shape describes. */
type Shaped<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

/**
 * A tool, described independently of how it is served. Nothing here mentions
 * JSON-RPC, stdio, or the MCP SDK: the registry is the only adapter.
 */
export interface ToolDefinition<
  Input extends z.ZodRawShape = z.ZodRawShape,
  Output extends z.ZodRawShape = z.ZodRawShape,
> {
  /** snake_case, unique. Namespacing is the client's job, so no prefix. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Input;
  readonly outputSchema: Output;
  readonly annotations: ToolHints;
  /** Returns plain data; the registry turns it into a tool result. */
  handler(args: Shaped<Input>, context: ToolContext): Promise<Shaped<Output>>;
  /**
   * Content blocks to send *instead of* the serialized payload — resource links,
   * where a tool has something better to hand back than a body. Returning
   * `undefined` keeps the default. See AGENTS.md, "The resource layer".
   */
  content?(data: Shaped<Output>): CallToolResult["content"] | undefined;
}

/** A tool definition with its schemas erased, for holding many in one array. */
export type AnyToolDefinition = ToolDefinition;

/** Identity, but it infers `Input` and `Output` so handlers get typed arguments. */
export function defineTool<Input extends z.ZodRawShape, Output extends z.ZodRawShape>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return definition;
}

/**
 * Register every tool on the server, in a fixed order. See AGENTS.md,
 * "The tool registry".
 */
export function registerTools(
  server: McpServer,
  tools: readonly AnyToolDefinition[],
  context: ToolContext,
): void {
  for (const tool of [...tools].sort(byName)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (args: Shaped<z.ZodRawShape>) => {
        try {
          const data = await tool.handler(args, context);
          return toResult(data, tool.content?.(data));
        } catch (error) {
          return toErrorResult(
            describeFailure(error, {
              tool: tool.name,
              args,
              writes: !tool.annotations.readOnlyHint,
            }),
          );
        }
      },
    );
  }
}

/** Codepoint order, not `localeCompare`, which varies with the host locale. */
function byName(a: AnyToolDefinition, b: AnyToolDefinition): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * A tool with an `outputSchema` must return `structuredContent`; the text block
 * repeats it for clients that only read `content`. See AGENTS.md.
 */
function toResult(
  data: Shaped<z.ZodRawShape>,
  content: CallToolResult["content"] | undefined,
): CallToolResult {
  return {
    structuredContent: data,
    content: content ?? [{ type: "text", text: JSON.stringify(data) }],
  };
}

/**
 * A failure the model is meant to recover from, not a JSON-RPC error. No
 * `structuredContent`: an error result is exempt from the output schema.
 */
function toErrorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
