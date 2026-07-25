import { z } from "zod";
import type { CrdtOp } from "./crdt.js";
import type { Hlc } from "./hlc.js";

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
  | "Rejected Update";

/**
 * Wire protocol version.
 *
 * Bumped from the `_version`-counter protocol, whose merge rule could not
 * express two writes happening at once. An envelope without it comes from an
 * incompatible build and is refused rather than half-understood.
 */
export const PROTOCOL_VERSION = 2;

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

export type AuditEntry =
  | StateUpdateAudit
  | StateSnapshotAudit
  | MessageAudit
  | ConcurrentUpdateAudit
  | OverrideAudit
  | RejectedUpdateAudit;

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
    entry: z.discriminatedUnion("kind", [LwwEntrySchema, OrSetEntrySchema]),
  })
  .superRefine((op, ctx) => {
    if (isReservedKey(op.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Reserved key is not allowed",
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
