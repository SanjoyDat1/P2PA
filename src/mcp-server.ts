import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ContextStore } from "./store.js";
import type { MarkdownLog } from "./markdown-log.js";
import type { P2PNode } from "./p2p.js";
import type { ContentionLog } from "./conflicts.js";
import type { DocBridge } from "./doc/bridge.js";
import {
  commitLocalMutation,
  overrideKeys,
  recordMessage,
} from "./sync.js";
import {
  MAX_KEY_LENGTH,
  MAX_PAYLOAD_BYTES,
  LEGACY_VERSION_KEY,
  isReservedKey,
  toJsonValue,
  type JsonValue,
} from "./types.js";

export interface AppServices {
  store: ContextStore;
  log: MarkdownLog;
  p2p: P2PNode;
  contention: ContentionLog;
  /** Optional Google Docs living-doc bridge. */
  doc?: DocBridge;
}

function formatJsonValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

const contextKeySchema = z
  .string()
  .min(1)
  .max(MAX_KEY_LENGTH)
  .refine((k) => !isReservedKey(k) && k !== LEGACY_VERSION_KEY, {
    message: "Reserved or retired key is not allowed",
  });

const contextValueSchema = z.union([
  z.string().max(MAX_PAYLOAD_BYTES),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(z.unknown()),
  z.array(z.unknown()),
]);

/**
 * Agent-facing MCP layer over stdio.
 *
 * Writes are per-key CRDT operations: two agents writing different keys never
 * contend, and two agents writing the same key converge on the same winner
 * without either being asked to arbitrate.
 */
export function createMcpServer(services: AppServices): McpServer {
  const server = new McpServer({
    name: "p2pa",
    version: "0.7.0",
  });

  server.registerTool(
    "push_context",
    {
      description:
        "Set a top-level context key and broadcast it to peers. Concurrent writes " +
        "to different keys always merge; concurrent writes to the same key resolve " +
        "to the newest stamp, identically on every peer.",
      inputSchema: {
        key: contextKeySchema.describe("Top-level context key"),
        value: contextValueSchema.describe("Context value (string or JSON)"),
      },
    },
    async ({ key, value }) => {
      let jsonValue: JsonValue;
      try {
        jsonValue = toJsonValue(value);
      } catch {
        return errorResult("Value is not JSON-serializable.");
      }
      if (JSON.stringify(jsonValue).length > MAX_PAYLOAD_BYTES) {
        return errorResult(`Value exceeds max size of ${MAX_PAYLOAD_BYTES} bytes.`);
      }

      const result = commitLocalMutation(services, (store) =>
        store.setKey(key, jsonValue),
      );
      if (!result.ok) return errorResult(result.error);

      console.error(
        `[mcp] push_context key=${key} peers=${services.p2p.connectionCount()} state=${services.store.stateHash()}`,
      );
      return textResult(
        `Set "${key}". Broadcast to ${services.p2p.connectionCount()} peer(s). ` +
          `State hash ${services.store.stateHash()}.`,
      );
    },
  );

  server.registerTool(
    "delete_context",
    {
      description:
        "Remove a top-level context key. The removal is tombstoned, so a peer " +
        "holding an older copy cannot resurrect it.",
      inputSchema: { key: contextKeySchema.describe("Top-level context key") },
    },
    async ({ key }) => {
      if (services.store.get(key) === undefined) {
        return errorResult(`Key "${key}" is not present.`);
      }
      const result = commitLocalMutation(services, (store) => store.deleteKey(key));
      if (!result.ok) return errorResult(result.error);

      console.error(`[mcp] delete_context key=${key}`);
      return textResult(
        `Deleted "${key}". Broadcast to ${services.p2p.connectionCount()} peer(s).`,
      );
    },
  );

  server.registerTool(
    "set_add",
    {
      description:
        "Add an element to a set-valued key. Use this instead of push_context for " +
        "lists two agents both append to — concurrent adds all survive, where a " +
        "whole-list write would drop the other agent's entries.",
      inputSchema: {
        key: contextKeySchema.describe("Set-valued context key"),
        value: contextValueSchema.describe("Element to add"),
      },
    },
    async ({ key, value }) => {
      const result = commitLocalMutation(services, (store) =>
        store.addToSet(key, toJsonValue(value)),
      );
      if (!result.ok) return errorResult(result.error);

      const current = services.store.get(key);
      console.error(`[mcp] set_add key=${key}`);
      return textResult(
        `Added to set "${key}". Now ${Array.isArray(current) ? current.length : 0} element(s).`,
      );
    },
  );

  server.registerTool(
    "set_remove",
    {
      description:
        "Remove every copy of an element from a set-valued key. A concurrent add " +
        "of the same element on another peer wins (add-wins).",
      inputSchema: {
        key: contextKeySchema.describe("Set-valued context key"),
        value: contextValueSchema.describe("Element to remove"),
      },
    },
    async ({ key, value }) => {
      let removed = false;
      const result = commitLocalMutation(services, (store) => {
        const op = store.removeFromSet(key, toJsonValue(value));
        removed = op !== null;
        return op;
      });
      if (!result.ok) return errorResult(result.error);
      if (!removed) return errorResult(`No matching element in set "${key}".`);

      console.error(`[mcp] set_remove key=${key}`);
      return textResult(`Removed from set "${key}".`);
    },
  );

  server.registerTool(
    "check_conflicts",
    {
      description:
        "List recent concurrent updates — keys where a write landed on top of " +
        "another node's write. These are already settled identically on every " +
        "peer and need no action; consult them to notice you were overruled.",
      inputSchema: {},
    },
    async () => {
      const items = services.contention.list();
      return textResult(
        items.length === 0
          ? "No concurrent updates recorded."
          : JSON.stringify(items, null, 2),
      );
    },
  );

  server.registerTool(
    "override_context",
    {
      description:
        "Impose your own values on keys, overriding how a concurrent update was " +
        "settled. Use when the automatic winner is correct by stamp order but " +
        "wrong by intent — e.g. to write a merge of both sides.",
      inputSchema: {
        values: z
          .string()
          .max(MAX_PAYLOAD_BYTES)
          .describe('JSON object of key → value, e.g. {"plan":"merged text"}'),
        reason: z
          .string()
          .max(1000)
          .optional()
          .describe("Why the automatic resolution was overridden"),
      },
    },
    async ({ values, reason }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(values);
      } catch {
        return errorResult("values is not valid JSON.");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return errorResult("values must be a JSON object.");
      }

      const clean: Record<string, JsonValue> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isReservedKey(key) || key === LEGACY_VERSION_KEY) continue;
        clean[key] = toJsonValue(value);
      }

      const result = overrideKeys(services, clean, reason ?? "agent override");
      if (!result.ok) return errorResult(result.error);

      console.error(`[mcp] override_context keys=${Object.keys(clean).length}`);
      return textResult(
        `Overrode ${Object.keys(clean).length} key(s). ` +
          `State hash ${services.store.stateHash()}.`,
      );
    },
  );

  server.registerTool(
    "sync_health",
    {
      description:
        "Replica identity, content hash, peer count, and recent contention. Two " +
        "peers reporting the same state hash hold the same document.",
      inputSchema: {},
    },
    async () => {
      return textResult(
        JSON.stringify(
          {
            nodeId: services.store.nodeId,
            stateHash: services.store.stateHash(),
            keys: Object.keys(services.store.snapshot()).length,
            connectedPeers: services.p2p.connectionCount(),
            blockedConnections: services.p2p.blockedConnections,
            concurrentUpdates: services.contention.size,
          },
          null,
          2,
        ),
      );
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

  server.registerTool(
    "doc_publish",
    {
      description:
        "Publish to the linked Google Doc living surface. Use status/plan to replace those sections, or agent_log to append a timestamped line. Uses revision-checked retries so concurrent HUMAN edits are re-merged; agents are not paused.",
      inputSchema: {
        section: z
          .enum(["status", "plan", "agent_log"])
          .describe("Which doc section to update"),
        content: z
          .string()
          .min(1)
          .max(MAX_PAYLOAD_BYTES)
          .describe("Section body (status/plan) or log line (agent_log)"),
      },
    },
    async ({ section, content }) => {
      if (!services.doc) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No living doc linked (or Google credentials missing). " +
                "Run `p2pa doc create` or `p2pa doc link` and set P2PA_GOOGLE_SA_JSON.",
            },
          ],
          isError: true,
        };
      }
      try {
        await services.doc.publish(section, content);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
      console.error(`[mcp] doc_publish section=${section}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `Published to ${section} on ${services.doc.url}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "doc_read_steering",
    {
      description:
        "Read the latest HUMAN directives mirrored into Active State key `steering`. Pass refresh=true to force a Google Doc poll first.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("If true, poll the Google Doc before reading"),
      },
    },
    async ({ refresh }) => {
      if (!services.doc) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No living doc linked (or Google credentials missing). " +
                "Run `p2pa doc create` or `p2pa doc link` and set P2PA_GOOGLE_SA_JSON.",
            },
          ],
          isError: true,
        };
      }
      try {
        const steering =
          refresh === true
            ? await services.doc.refreshSteering()
            : services.doc.readSteering();
        if (!steering) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No steering yet (HUMAN directives empty or not polled).",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(steering, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "doc_status",
    {
      description:
        "Show living-doc link status (URL, poll health). Never returns credentials.",
      inputSchema: {},
    },
    async () => {
      if (!services.doc) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  linked: false,
                  hint: "Run p2pa doc create|link and set P2PA_GOOGLE_SA_JSON",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(services.doc.getStatus(), null, 2),
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
