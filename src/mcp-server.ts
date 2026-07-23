import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ContextStore } from "./store.js";
import type { MarkdownLog } from "./markdown-log.js";
import type { P2PNode } from "./p2p.js";
import type { ConflictQueue } from "./conflicts.js";
import {
  commitLocalMutation,
  recordMessage,
  resolveConflict,
} from "./sync.js";
import {
  JsonPatchArraySchema,
  MAX_KEY_LENGTH,
  MAX_PAYLOAD_BYTES,
  VERSION_KEY,
  isReservedKey,
  stripVersionOps,
  toJsonValue,
  type JsonValue,
} from "./types.js";

export interface AppServices {
  store: ContextStore;
  log: MarkdownLog;
  p2p: P2PNode;
  conflicts: ConflictQueue;
}

function formatJsonValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/**
 * Agent-facing MCP layer over stdio (Phase 4).
 * Local mutations bump `_version` and broadcast JSON Patch diffs.
 * Collisions are queued for `resolve_conflict`.
 */
export function createMcpServer(services: AppServices): McpServer {
  const server = new McpServer({
    name: "p2pa",
    version: "0.5.0",
  });

  server.registerTool(
    "push_context",
    {
      description:
        "Set a top-level context key, increment `_version`, rewrite Active State, and broadcast the JSON Patch (including the version bump) to Hyperswarm peers.",
      inputSchema: {
        key: z
          .string()
          .min(1)
          .max(MAX_KEY_LENGTH)
          .refine((k) => !isReservedKey(k) && k !== VERSION_KEY, {
            message: `Reserved or system-managed key is not allowed`,
          })
          .describe("Top-level context key"),
        value: z
          .union([
            z.string().max(MAX_PAYLOAD_BYTES),
            z.number(),
            z.boolean(),
            z.null(),
            z.record(z.unknown()),
            z.array(z.unknown()),
          ])
          .describe("Context value (string or JSON)"),
      },
    },
    async ({ key, value }) => {
      let jsonValue: JsonValue;
      try {
        jsonValue = toJsonValue(value);
      } catch {
        return {
          content: [
            { type: "text" as const, text: "Value is not JSON-serializable." },
          ],
          isError: true,
        };
      }

      const encoded = JSON.stringify(jsonValue);
      if (encoded.length > MAX_PAYLOAD_BYTES) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Value exceeds max size of ${MAX_PAYLOAD_BYTES} bytes.`,
            },
          ],
          isError: true,
        };
      }

      const result = commitLocalMutation(services, (store) => {
        store.setKey(key, jsonValue);
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }

      if (result.ops.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No change for key "${key}" (value already current).`,
            },
          ],
        };
      }

      console.error(
        `[mcp] push_context key=${key} ops=${result.ops.length} v=${services.store.getVersion()} peers=${services.p2p.connectionCount()}`,
      );

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Pushed context key "${key}" (version ${services.store.getVersion()}) as ${result.ops.length} patch op(s). ` +
              `Broadcast to ${services.p2p.connectionCount()} peer(s).\n` +
              JSON.stringify(result.ops, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "patch_context",
    {
      description:
        "Apply an RFC 6902 JSON Patch (system strips `/_version` ops), increment `_version`, sync Markdown, and broadcast the resulting diff.",
      inputSchema: {
        patch: JsonPatchArraySchema.describe(
          'Array of RFC 6902 operations, e.g. [{ "op": "add", "path": "/newKey", "value": "data" }]',
        ),
      },
    },
    async ({ patch }) => {
      const cleaned = stripVersionOps(patch);
      if (cleaned.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Patch is empty after stripping system-managed `/_version` ops.",
            },
          ],
          isError: true,
        };
      }

      const result = commitLocalMutation(services, (store) => {
        store.applyOps(cleaned);
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }

      console.error(
        `[mcp] patch_context ops=${result.ops.length} v=${services.store.getVersion()} peers=${services.p2p.connectionCount()}`,
      );

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Applied patch (version ${services.store.getVersion()}) and broadcast to ` +
              `${services.p2p.connectionCount()} peer(s).\n` +
              JSON.stringify(result.ops, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "check_conflicts",
    {
      description:
        "Inspect the in-memory conflict queue (peer patches that collided with local `_version`). Use before resolve_conflict.",
      inputSchema: {},
    },
    async () => {
      const queue = services.conflicts.list();
      return {
        content: [
          {
            type: "text" as const,
            text:
              queue.length === 0
                ? "No conflicts in queue."
                : JSON.stringify(queue, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "resolve_conflict",
    {
      description:
        "Resolve the oldest queued collision. Strategies: accept_peer (apply peer patch), keep_local (reject peer, bump version), custom_merge (merge custom_state object).",
      inputSchema: {
        merge_strategy: z
          .enum(["accept_peer", "keep_local", "custom_merge"])
          .describe("How to resolve the oldest conflict"),
        custom_state: z
          .string()
          .max(MAX_PAYLOAD_BYTES)
          .optional()
          .describe(
            "JSON object string of keys to overwrite (required for custom_merge)",
          ),
      },
    },
    async ({ merge_strategy, custom_state }) => {
      const result = resolveConflict(services, merge_strategy, custom_state);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }

      console.error(
        `[mcp] resolve_conflict strategy=${result.strategy} id=${result.conflictId} v=${services.store.getVersion()}`,
      );

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Resolved conflict ${result.conflictId} via ${result.strategy}. ` +
              `Local version is now ${services.store.getVersion()}. ` +
              `Remaining conflicts: ${services.conflicts.size}.\n` +
              JSON.stringify(result.ops, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "pull_context",
    {
      description:
        "Pull a context value by key from the in-memory JSON store, or return the entire shared state if no key is provided.",
      inputSchema: {
        key: z
          .string()
          .min(1)
          .optional()
          .describe("Optional top-level key to look up"),
      },
    },
    async ({ key }) => {
      if (key !== undefined) {
        const value = services.store.get(key);
        if (value === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Key "${key}" not found in local context store.`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: formatJsonValue(value) }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(services.store.snapshot(), null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "send_peer_message",
    {
      description:
        "Append a peer message to the Markdown Audit Trail and send it as a direct message event to the connected peer.",
      inputSchema: {
        message: z
          .string()
          .min(1)
          .max(MAX_PAYLOAD_BYTES)
          .describe("Message text to send to the peer"),
      },
    },
    async ({ message }) => {
      recordMessage(services, message, "Local", true);
      console.error(
        `[mcp] send_peer_message peers=${services.p2p.connectionCount()}`,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Sent peer message (${message.length} chars) to ${services.p2p.connectionCount()} peer(s).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "read_context_history",
    {
      description:
        "Read the last N lines of shared_context.md (Active State + Conflicts + Audit Trail).",
      inputSchema: {
        lines: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Number of trailing lines to read (default: 50)"),
      },
    },
    async ({ lines }) => {
      const n = lines ?? 50;
      const history = services.log.readLastLines(n);
      return {
        content: [
          {
            type: "text" as const,
            text: history.length > 0 ? history : "(log is empty)",
          },
        ],
      };
    },
  );

  return server;
}

/** Connect the MCP server to stdio. Must be called after P2P is running. */
export async function startMcpServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] P2PA MCP server ready on stdio");
}
