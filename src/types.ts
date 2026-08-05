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
import {
  MAX_CAPABILITIES,
  MAX_CAPABILITY_LENGTH,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "./protocol.js";
import {
  PUBLIC_KEY_HEX_LENGTH,
  SIGNATURE_B64_LENGTH,
} from "./signing.js";
import { MAX_CAPABILITY_TEXT, isAgentKey, isOwnCard } from "./presence.js";
import { NODE_ID_LENGTH } from "./hlc.js";
import {
  MAX_ACCEPTED_TASK_ATTEMPTS,
  MAX_TASK_DEPS,
  MAX_TASK_DETAIL,
  MAX_TASK_ERROR,
  MAX_TASK_NEEDS,
  MAX_TASK_PRIORITY,
  MAX_TASK_RESULT_BYTES,
  MAX_TASK_TITLE,
  MIN_TASK_PRIORITY,
  TASK_KEY_PREFIX,
  TASK_STATUS,
} from "./task.js";

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
  | "Release"
  | "Task Created"
  | "Task Settled";

/**
 * Wire protocol version.
 *
 * v2 replaced the `_version`-counter protocol, whose merge rule could not
 * express two writes happening at once. v3 adds message ids and the `ack`
 * envelope that make delivery durable. v4 adds the `hello` handshake, so a
 * version difference is negotiated instead of silently dropping every frame,
 * plus per-op signatures, chunked snapshots and addressed messages.
 *
 * Re-exported from `protocol.ts`, which owns negotiation.
 */
export { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION };

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

export interface TaskCreatedAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Task Created";
  taskId: string;
  title: string;
  priority: number;
  needs: string[];
  deps: string[];
}

/**
 * A task reaching an outcome.
 *
 * `settledBy` is the node that wrote the outcome, which is not necessarily the
 * node that held the lease and not necessarily the creator — any allowlisted
 * peer may settle any task, and the audit trail is where that is visible.
 */
export interface TaskSettledAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Task Settled";
  taskId: string;
  status: string;
  attempt: number;
  settledBy: string;
  detail?: string;
}

export type AuditEntry =
  | StateUpdateAudit
  | StateSnapshotAudit
  | MessageAudit
  | ConcurrentUpdateAudit
  | OverrideAudit
  | RejectedUpdateAudit
  | ClaimAudit
  | ReleaseAudit
  | TaskCreatedAudit
  | TaskSettledAudit;

export function isReservedKey(key: string): boolean {
  return (RESERVED_KEYS as readonly string[]).includes(key);
}

const HlcSchema = z.object({
  w: z.number().int().nonnegative(),
  c: z.number().int().nonnegative(),
  n: z.string().min(1).max(64),
});

/**
 * Signature metadata, accepted on every entry kind.
 *
 * Bounded to exact lengths so a peer cannot use either field as free payload
 * space. Both are optional: a v3 peer sends neither, and an unsigned entry is
 * still merged under the sender-binding rules that predate signatures.
 */
const SignatureFieldsSchema = {
  by: z
    .string()
    .length(PUBLIC_KEY_HEX_LENGTH)
    .regex(/^[0-9a-f]+$/)
    .optional(),
  sig: z.string().length(SIGNATURE_B64_LENGTH).optional(),
};

const LwwEntrySchema = z.object({
  kind: z.literal("lww"),
  hlc: HlcSchema,
  value: z.unknown().optional(),
  deleted: z.boolean().optional(),
  ...SignatureFieldsSchema,
});

const ClaimEntrySchema = z.object({
  kind: z.literal("claim"),
  hlc: HlcSchema,
  gen: z.number().int().min(0).max(MAX_ACCEPTED_CLAIM_GEN),
  ttl: z.number().int().min(MIN_CLAIM_TTL_MS).max(MAX_CLAIM_TTL_MS),
  released: z.boolean().optional(),
  note: z.string().max(500).optional(),
  ...SignatureFieldsSchema,
});

/**
 * A backlog entry.
 *
 * Every field here arrives from a peer, including the ones a human reads, so
 * every field is bounded. `needs` shares `MAX_CAPABILITY_TEXT` with a presence
 * card deliberately: a requirement token and a capability token that could
 * differ in length would silently stop matching at the boundary between them.
 */
const TaskEntrySchema = z.object({
  kind: z.literal("task"),
  hlc: HlcSchema,
  title: z.string().min(1).max(MAX_TASK_TITLE),
  detail: z.string().max(MAX_TASK_DETAIL).optional(),
  needs: z
    .array(z.string().min(1).max(MAX_CAPABILITY_TEXT))
    .max(MAX_TASK_NEEDS)
    .optional(),
  deps: z.array(z.string().regex(TASK_ID_PATTERN)).max(MAX_TASK_DEPS).optional(),
  priority: z.number().int().min(MIN_TASK_PRIORITY).max(MAX_TASK_PRIORITY),
  status: z.enum(TASK_STATUS),
  result: z.unknown().optional(),
  lastError: z.string().max(MAX_TASK_ERROR).optional(),
  attempts: z.number().int().min(0).max(MAX_ACCEPTED_TASK_ATTEMPTS),
  createdBy: z.string().min(1).max(NODE_ID_LENGTH),
  createdAt: z.number().int().nonnegative(),
  ...SignatureFieldsSchema,
});

const OrSetEntrySchema = z.object({
  kind: z.literal("orset"),
  hlc: HlcSchema,
  /**
   * Highest lww stamp this key has carried.
   *
   * Declared because Zod strips fields it does not know: without it every
   * inbound set entry lost its floor at the validation boundary, so the guard
   * that makes a key flipping between `lww` and `orset` converge regardless of
   * delivery order held inside one process and nowhere else. A relayed set op
   * could then union a superseded lineage back into a register that had already
   * moved past it.
   */
  floor: HlcSchema.optional(),
  /**
   * Element tags.
   *
   * Tags are peer-chosen and used as object keys, so the reserved JavaScript
   * property names are refused here: `__proto__` in particular behaves as an
   * inherited accessor rather than an ordinary key, which silently dropped
   * elements and could rewrite an object's prototype during merge.
   */
  adds: z.record(
    z.string().min(1).max(256).refine((tag) => !isReservedKey(tag), {
      message: "Reserved property name is not allowed as a set tag",
    }),
    z.unknown(),
  ),
  removes: z
    .array(
      z.string().min(1).max(256).refine((tag) => !isReservedKey(tag), {
        message: "Reserved property name is not allowed as a set tag",
      }),
    )
    .max(10_000),
  ...SignatureFieldsSchema,
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
      TaskEntrySchema,
    ]),
  })
  .superRefine((op, ctx) => {
    if (isReservedKey(op.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Reserved key is not allowed",
      });
    }
    // The retired counter protocol's key. Refused locally since v2, but it used
    // to merge happily when it arrived from a peer or off disk — so a v1 document
    // could reintroduce it as an ordinary key and it would sit in the materialized
    // state looking meaningful. Rejected on every path in, as SPEC §5.1 says.
    if (op.key === LEGACY_VERSION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Key belonged to the retired counter protocol",
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
    const taskKey = op.key.startsWith(TASK_KEY_PREFIX);
    if (taskKey) {
      const taskId = op.key.slice(TASK_KEY_PREFIX.length);
      if (!TASK_ID_PATTERN.test(taskId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Malformed task id in task key",
        });
      }
    }
    // Tasks and state never share a key either, on any path in.
    if (taskKey !== (op.entry.kind === "task")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: taskKey
          ? "Task namespace accepts only task entries"
          : "Task entry outside the task namespace",
      });
    }
    // A result is a handover, not a payload channel. Checked on the serialized
    // form because that is what rides every snapshot from here on.
    if (
      op.entry.kind === "task" &&
      op.entry.result !== undefined &&
      JSON.stringify(op.entry.result).length > MAX_TASK_RESULT_BYTES
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Task result exceeds ${MAX_TASK_RESULT_BYTES} bytes; ` +
          `publish the payload with push_context and reference it from the result`,
      });
    }
    // A presence card is only meaningful in the one slot its author owns.
    // Checked here so a forged card is refused at the validation boundary, on
    // every path in — wire, snapshot relay, and the on-disk replica alike.
    if (isAgentKey(op.key)) {
      if (op.entry.kind !== "lww") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Agent namespace accepts only presence cards",
        });
      } else if (!isOwnCard(op.key, op.entry.hlc.n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Presence card is stamped by a node other than the one it describes",
        });
      }
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

/**
 * Version field.
 *
 * A range, never a literal. Pinning it to one number meant a peer on any other
 * build had every frame fail validation and get dropped with a single stderr
 * line — two paired machines would sit connected and never sync, with nothing to
 * tell either operator why, and no version could ever be added without breaking
 * every node already deployed. Frames are accepted across the supported range
 * and `protocol.ts` settles which version the connection actually speaks.
 */
const VersionSchema = z
  .number()
  .int()
  .min(MIN_PROTOCOL_VERSION)
  .max(PROTOCOL_VERSION);

/** Max snapshot parts in one handshake, bounding a chunked transfer. */
export const MAX_SNAPSHOT_PARTS = 512;

/** Max recipients addressable by a single message. */
export const MAX_MESSAGE_RECIPIENT_LENGTH = PUBLIC_KEY_HEX_LENGTH;

/** Max characters in a correlation id. */
export const MAX_CORRELATION_LENGTH = 64;

const SnapshotOpsSchema = z
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
  .transform((ops) => ops as unknown as CrdtOp[]);

/** Inbound/outbound NDJSON peer envelopes. */
export const PeerEnvelopeSchema = z.discriminatedUnion("type", [
  /**
   * Opening frame, sent by both sides before anything else.
   *
   * Absent on a v3 peer, which is exactly how one is recognised.
   */
  z.object({
    type: z.literal("hello"),
    v: VersionSchema,
    /** Oldest and newest version the sender can speak. */
    min: z.number().int().min(1).max(1_000),
    max: z.number().int().min(1).max(1_000),
    /** Sender's node id, cross-checked against the stamps it later sends. */
    node: z.string().min(1).max(64),
    caps: z
      .array(z.string().min(1).max(MAX_CAPABILITY_LENGTH))
      .max(MAX_CAPABILITIES)
      .default([]),
    /** Replica digests, so two already-matching peers skip the snapshot. */
    digest: z
      .object({
        state: z.string().max(64),
        claims: z.string().max(64),
        /**
         * Backlog digest. Absent from a peer that predates the `@task/`
         * namespace, which is why it is optional and why an empty backlog
         * hashes to the empty string — otherwise every mixed swarm would
         * mismatch and re-ship the whole document on every reconnect.
         */
        tasks: z.string().max(64).optional(),
      })
      .optional(),
    /** Human-facing label, sanitized before display. Never an identity. */
    label: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal("update"),
    v: VersionSchema,
    ops: CrdtOpArraySchema,
  }),
  z.object({
    type: z.literal("message"),
    v: VersionSchema,
    text: z.string().min(1).max(MAX_PAYLOAD_BYTES),
    /**
     * Optional so a build without an outbox still interoperates. Present, it
     * lets the receiver drop a replay and confirm receipt.
     */
    id: z.string().min(1).max(64).optional(),
    /**
     * Intended recipient's public key.
     *
     * Absent means "everyone on this topic", which is all v3 could express. A
     * receiver that is not the addressee drops the frame without logging it, so
     * a directed question does not surface in every other agent's feed.
     */
    to: z.string().length(MAX_MESSAGE_RECIPIENT_LENGTH).regex(/^[0-9a-f]+$/).optional(),
    /** Ties a reply to the question that prompted it. */
    corr: z.string().min(1).max(MAX_CORRELATION_LENGTH).optional(),
    /** What the sender wants: a statement, a question, or an answer. */
    intent: z.enum(["tell", "ask", "reply"]).optional(),
  }),
  z.object({
    type: z.literal("ack"),
    v: VersionSchema,
    ids: z.array(z.string().min(1).max(64)).min(1).max(200),
  }),
  z.object({
    type: z.literal("snapshot"),
    v: VersionSchema,
    ops: SnapshotOpsSchema,
    /**
     * Position in a chunked transfer, 1-based, both omitted by a v3 peer.
     *
     * A replica larger than `MAX_PAYLOAD_BYTES` used to be untransmittable: the
     * whole document went out as one frame, the receiver's framing check
     * destroyed the connection over it, and because the snapshot is sent on every
     * connect the two nodes retried that forever and never converged. Merging is
     * commutative and idempotent, so each part is applied as it lands and nothing
     * has to be buffered.
     */
    part: z.number().int().min(1).max(MAX_SNAPSHOT_PARTS).optional(),
    of: z.number().int().min(1).max(MAX_SNAPSHOT_PARTS).optional(),
  }),
  /**
   * Graceful close with a stated reason.
   *
   * The point is the operator: "peer speaks v5, this node speaks v4" in the log
   * beats a connection that drops with no explanation.
   */
  z.object({
    type: z.literal("bye"),
    v: VersionSchema,
    reason: z.string().min(1).max(64),
    detail: z.string().max(500).optional(),
  }),
]);

export type PeerEnvelope = z.infer<typeof PeerEnvelopeSchema>;

/** Round-trip through JSON to produce a plain JsonValue (drops non-JSON types). */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export type { Hlc };
