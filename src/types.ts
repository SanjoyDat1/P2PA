import { z } from "zod";
import type { Operation } from "fast-json-patch";

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
  | "State Patch"
  | "State Snapshot"
  | "Message"
  | "Conflict Resolution"
  | "Collision Detected";

/** Root key used for masterless conflict detection (integer Lamport-style clock). */
export const VERSION_KEY = "_version";

/** Max queued collisions awaiting LLM resolution. */
export const MAX_CONFLICT_QUEUE = 50;

export type MergeStrategy = "accept_peer" | "keep_local" | "custom_merge";

export interface ConflictItem {
  id: string;
  peerOps: Operation[];
  peerVersion: number | null;
  localState: ContextState;
  localVersion: number;
  detectedAt: string;
}

export interface ConflictResolutionAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Conflict Resolution";
  strategy: MergeStrategy;
  conflictId: string;
  detail: string;
}

export interface CollisionDetectedAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Collision Detected";
  localVersion: number;
  peerVersion: number | null;
  conflictId: string;
}

/** JSON-compatible value stored in shared state (no `any`). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Top-level shared document. */
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

export interface StatePatchAudit {
  source: Source;
  peer?: AuditPeer;
  action: "State Patch";
  ops: Operation[];
}

export interface StateSnapshotAudit {
  source: Source;
  peer?: AuditPeer;
  action: "State Snapshot";
}

export interface MessageAudit {
  source: Source;
  peer?: AuditPeer;
  action: "Message";
  text: string;
}

export type AuditEntry =
  | StatePatchAudit
  | StateSnapshotAudit
  | MessageAudit
  | ConflictResolutionAudit
  | CollisionDetectedAudit;

/** True if a JSON Pointer path touches a reserved object key. */
export function pointerHasReservedSegment(pointer: string): boolean {
  const raw = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  if (raw.length === 0) return false;
  const segments = raw.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.some((seg) =>
    (RESERVED_KEYS as readonly string[]).includes(seg),
  );
}

const JsonPatchOpSchema = z
  .object({
    op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
    path: z.string().min(1),
    from: z.string().optional(),
    value: z.unknown().optional(),
  })
  .superRefine((op, ctx) => {
    if (op.path === "/") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Root document replace via path '/' is not allowed",
      });
    }
    if (pointerHasReservedSegment(op.path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Reserved path segment in path: ${op.path}`,
      });
    }
    if (op.from !== undefined && pointerHasReservedSegment(op.from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Reserved path segment in from: ${op.from}`,
      });
    }
  });

export const JsonPatchArraySchema = z
  .array(JsonPatchOpSchema)
  .min(1)
  .superRefine((ops, ctx) => {
    const serialized = JSON.stringify(ops);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Patch exceeds max size of ${MAX_PAYLOAD_BYTES} bytes`,
      });
    }
  })
  .transform((ops) => ops as Operation[]);

const ContextStateSchema = z
  .record(z.unknown())
  .superRefine((state, ctx) => {
    for (const key of Object.keys(state)) {
      if (isReservedKey(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Reserved key in snapshot: ${key}`,
        });
      }
    }
    const serialized = JSON.stringify(state);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Snapshot exceeds max size of ${MAX_PAYLOAD_BYTES} bytes`,
      });
    }
  })
  .transform((state) => state as ContextState);

/** Zod schema for inbound/outbound NDJSON peer envelopes (Phase 3). */
export const PeerEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("patch"),
    ops: JsonPatchArraySchema,
  }),
  z.object({
    type: z.literal("message"),
    text: z.string().min(1).max(MAX_PAYLOAD_BYTES),
  }),
  z.object({
    type: z.literal("snapshot"),
    state: ContextStateSchema,
  }),
]);

export type PeerEnvelope = z.infer<typeof PeerEnvelopeSchema>;

/** Round-trip through JSON to produce a plain JsonValue (drops non-JSON types). */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function isReservedKey(key: string): boolean {
  return (RESERVED_KEYS as readonly string[]).includes(key);
}

/** Read integer `_version` from state (default 0). */
export function readLocalVersion(state: ContextState): number {
  const raw = state[VERSION_KEY];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Extract intended `_version` from a JSON Patch array.
 * Uses the last `/_version` add/replace. Returns null if missing/invalid
 * or if multiple `/_version` mutations are present (ambiguous / hostile).
 */
export function extractPatchVersion(ops: Operation[]): number | null {
  const versionOps = ops.filter((op) => op.path === `/${VERSION_KEY}`);
  if (versionOps.length !== 1) return null;
  const op = versionOps[0]!;
  if (op.op !== "add" && op.op !== "replace") return null;
  const value = "value" in op ? op.value : undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return null;
}

/** Strip any ops that touch `/_version` (system owns the clock). */
export function stripVersionOps(ops: Operation[]): Operation[] {
  return ops.filter((op) => op.path !== `/${VERSION_KEY}`);
}
