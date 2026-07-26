import { z } from "zod";
import type { CrdtOp } from "./crdt.js";
import type { Hlc } from "./hlc.js";
import {
  CLAIM_KEY_PREFIX,
  MAX_ACCEPTED_CLAIM_GEN,
  MAX_CLAIM_TTL_MS,
  MIN_CLAIM_TTL_MS,
  TASK_ID_PATTERN,
} from "./claim.js";

export type Source = "Local" | "Peer";

/**
 * Attribution for a `Peer`-sourced audit entry.
 *
 * The fingerprint is derived from the Noise-authenticated remote public key, so
 * it identifies *which* peer acted — `SOURCE: Peer` alone cannot. The label is
 * peer-supplied and sanitized; treat the fingerprint as the identity.
 */
export interface AuditPeer {
  fingerprint: string;
  label: string | null;
}

export type AuditAction =
  | "State Update"
  | "State Snapshot"
  | "Message"
  | "Concurrent Update"
  | "Override"
  | "Rejected Update"
  | "Claim"
  | "Release";

/**
 * Wire protocol version.
 *
 * v2 replaced the `_version`-counter protocol, whose merge rule could not
 * express two writes happening at once. v3 adds message ids and the `ack`
 * envelope that make delivery durable — a v2 peer would silently never
 * acknowledge anything, so the sender would retry the same message on every
 * reconnect for a week. Refusing outright is the honest failure.
 */
export const PROTOCOL_VERSION = 3;

/** Document key used by the retired counter protocol; dropped on hydrate. */
export const LEGACY_VERSION_KEY = "_version";

/** Max entries retained in the contended-write log. */
export const MAX_CONTENTION_LOG = 50;

/** Max contended-write entries per peer, so one peer cannot flood the log. */
export const MAX_CONTENTION_PER_PEER = 10;

/** Max CRDT ops carried by a single envelope. */
export const MAX_OPS_PER_ENVELOPE = 10_000;

/** JSON-compatible value stored in shared state (no `any`). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Top-level shared document, as agents see it. */
export type ContextState = Record<string, JsonValue>;

/** Max bytes for a single NDJSON line / serialized envelope (1 MiB). */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** Max characters for context keys. */
export const MAX_KEY_LENGTH = 256;

/** Length of auto-generated pairing topics (~131 bits of alphanum entropy). */
export const TOPIC_CODE_LENGTH = 22;

/** Minimum recommended topic length (warn below this). */
export const TOPIC_MIN_RECOMMENDED_LENGTH = 12;

export const RESERVED_KEYS = ["__proto__", "constructor", "prototype"] as const;

export interface CliOptions {
  /**
   * Shared pairing topic (capability secret).
   * Hashed with SHA-256 to a 32-byte Hyperswarm discovery key.
   */
  topic: string;
  /** Path to the Markdown persistence file (under cwd or ~/.p2pa). */
  contextFile: string;
}

/**
 * A write that landed on a key some other node had written.
 *
 * Both replicas pick the same winner from the HLC order, so this records
 * something already settled rather than asking for a decision. It exists so an
 * agent can notice it was overruled and react.
 */
export interface ContentionItem {
  id: string;
  key: string;
  /** Node id that previously held the key. */
  previousNode: string;
  /** Peer fingerprint the winning write arrived from, or null when local. */
  peerFingerprint: string | null;
  /** Value now in effect. */
  winningValue: JsonValue | undefined;
  detectedAt: string;
}

export interface StateUpdateAudit {
  source: Source;
  peer?: AuditPeer;
  action: "State Update";
  keys: string[];
}

export interface StateSnapshotAudit {
  source: Source;
  peer?: AuditPeer;
  action: "State Snapshot";
  applied: number;
  ignored: number;
}

export interface MessageAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Message";
  text: string;
}

export interface ConcurrentUpdateAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Concurrent Update";
  key: string;
  previousNode: string;
}

export interface OverrideAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Override";
  keys: string[];
  detail: string;
}

/**
 * A refused inbound update.
 *
 * Recorded rather than only written to stderr: a peer whose writes are being
 * dropped is otherwise invisible to the agent operating the node.
 */
export interface RejectedUpdateAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Rejected Update";
  reason: string;
  keys: string[];
}

export interface ClaimAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Claim";
  taskId: string;
  holder: string;
  generation: number;
  expiresAt: string;
}

export interface ReleaseAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Release";
  taskId: string;
  holder: string;
  generation: number;
}

export type AuditEntry =
  | StateUpdateAudit
  | StateSnapshotAudit
  | MessageAudit
  | ConcurrentUpdateAudit
  | OverrideAudit
  | RejectedUpdateAudit
  | ClaimAudit
  | ReleaseAudit;

export function isReservedKey(key: string): boolean {
  return (RESERVED_KEYS as readonly string[]).includes(key);
}

const HlcSchema = z.object({
  w: z.number().int().nonnegative(),
  c: z.number().int().nonnegative(),
  n: z.string().min(1).max(64),
});

const LwwEntrySchema = z.object({
  kind: z.literal("lww"),
  hlc: HlcSchema,
  value: z.unknown().optional(),
  deleted: z.boolean().optional(),
});

const ClaimEntrySchema = z.object({
  kind: z.literal("claim"),
  hlc: HlcSchema,
  gen: z.number().int().min(0).max(MAX_ACCEPTED_CLAIM_GEN),
  ttl: z.number().int().min(MIN_CLAIM_TTL_MS).max(MAX_CLAIM_TTL_MS),
  released: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

const OrSetEntrySchema = z.object({
  kind: z.literal("orset"),
  hlc: HlcSchema,
  adds: z.record(z.unknown()),
  removes: z.array(z.string().min(1).max(256)).max(10_000),
});

/** Keys are interpolated into Markdown, so they may not carry structure. */
export const CONTEXT_KEY_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/;

/** Deepest JSON nesting accepted from a peer. */
export const MAX_JSON_DEPTH = 32;

/**
 * Guard recursion before anything walks the value.
 *
 * `JSON.parse` happily builds a structure deeper than the stack can traverse,
 * so a modest payload can crash any later `JSON.stringify`/canonicalize pass.
 */
export function exceedsDepth(value: unknown, limit = MAX_JSON_DEPTH): boolean {
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > limit) return true;
    if (node === null || typeof node !== "object") return false;
    if (Array.isArray(node)) {
      return node.some((item) => walk(item, depth + 1));
    }
    return Object.values(node as Record<string, unknown>).some((item) =>
      walk(item, depth + 1),
    );
  };
  return walk(value, 0);
}

const CrdtOpSchema = z
  .object({
    key: z.string().min(1).max(MAX_KEY_LENGTH).regex(CONTEXT_KEY_PATTERN),
    entry: z.discriminatedUnion("kind", [
      LwwEntrySchema,
      OrSetEntrySchema,
      ClaimEntrySchema,
    ]),
  })
  .superRefine((op, ctx) => {
    if (isReservedKey(op.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Reserved key is not allowed",
      });
    }
    const claimKey = op.key.startsWith(CLAIM_KEY_PREFIX);
    if (claimKey) {
      const taskId = op.key.slice(CLAIM_KEY_PREFIX.length);
      if (!TASK_ID_PATTERN.test(taskId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Malformed task id in lease key",
        });
      }
    }
    // Leases and state never share a key, on any path in — including the
    // on-disk replica, which the runtime treats as untrusted.
    if (claimKey !== (op.entry.kind === "claim")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: claimKey
          ? "Lease namespace accepts only lease entries"
          : "Lease entry outside the lease namespace",
      });
    }
    if (exceedsDepth(op.entry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Entry nests deeper than ${MAX_JSON_DEPTH} levels`,
      });
    }
  });

export const CrdtOpArraySchema = z
  .array(CrdtOpSchema)
  .min(1)
  .max(MAX_OPS_PER_ENVELOPE)
  .superRefine((ops, ctx) => {
    if (JSON.stringify(ops).length > MAX_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Update exceeds max size of ${MAX_PAYLOAD_BYTES} bytes`,
      });
    }
  })
  .transform((ops) => ops as unknown as CrdtOp[]);

/** Inbound/outbound NDJSON peer envelopes. */
export const PeerEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("update"),
    v: z.literal(PROTOCOL_VERSION),
    ops: CrdtOpArraySchema,
  }),
  z.object({
    type: z.literal("message"),
    v: z.literal(PROTOCOL_VERSION),
    text: z.string().min(1).max(MAX_PAYLOAD_BYTES),
    /**
     * Optional so a build without an outbox still interoperates. Present, it
     * lets the receiver drop a replay and confirm receipt.
     */
    id: z.string().min(1).max(64).optional(),
  }),
  z.object({
    type: z.literal("ack"),
    v: z.literal(PROTOCOL_VERSION),
    ids: z.array(z.string().min(1).max(64)).min(1).max(200),
  }),
  z.object({
    type: z.literal("snapshot"),
    v: z.literal(PROTOCOL_VERSION),
    ops: z
      .array(CrdtOpSchema)
      .max(MAX_OPS_PER_ENVELOPE)
      .superRefine((ops, ctx) => {
        if (JSON.stringify(ops).length > MAX_PAYLOAD_BYTES) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Snapshot exceeds max size of ${MAX_PAYLOAD_BYTES} bytes`,
          });
        }
      })
      .transform((ops) => ops as unknown as CrdtOp[]),
  }),
]);

export type PeerEnvelope = z.infer<typeof PeerEnvelopeSchema>;

/** Round-trip through JSON to produce a plain JsonValue (drops non-JSON types). */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export type { Hlc };
