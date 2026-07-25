/**
 * Invite tokens — the pairing primitive.
 *
 * A token bundles everything a peer needs to reach you and to trust you:
 *   - the pairing topic (which swarm to join)
 *   - your public key (which node to allowlist)
 *   - your label (what to call you in the UI and audit trail)
 *
 * Format: `p2pa1.<base64url(payload)>.<checksum>`
 *
 * The checksum is 6 base64url chars of sha256(payload) — it catches truncated
 * or mangled pastes before we surface a confusing "peer never connects" state.
 * It is NOT a MAC: a token is bearer material, not an authenticated message.
 *
 * SECURITY: a token contains the topic, which is the swarm capability secret.
 * Treat it like a password and send it over a channel you already trust.
 */
import { createHash } from "node:crypto";
import {
  MAX_PEER_LABEL_LENGTH,
  normalizePublicKeyHex,
  sanitizeLabel,
} from "./peer-key.js";

export const TOKEN_PREFIX = "p2pa1";
const CHECKSUM_CHARS = 6;

/** Upper bound on an accepted token, to bound work on hostile input. */
export const MAX_TOKEN_LENGTH = 4096;

/** Upper bound on the topic carried inside a token. */
export const MAX_TOPIC_LENGTH = 512;

export interface InvitePayload {
  /** Pairing topic (capability secret for the swarm). */
  topic: string;
  /** Issuer's ed25519 public key, lowercase hex. */
  pubkey: string;
  /** Issuer's self-chosen display name. */
  label: string;
}

export type InviteParseResult =
  | { ok: true; invite: InvitePayload }
  | { ok: false; error: string };

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function checksumOf(encodedPayload: string): string {
  return base64url(createHash("sha256").update(encodedPayload, "utf8").digest()).slice(
    0,
    CHECKSUM_CHARS,
  );
}

/** Build a shareable invite token. */
export function encodeInvite(invite: InvitePayload): string {
  const pubkey = normalizePublicKeyHex(invite.pubkey);
  if (!pubkey) {
    throw new Error("encodeInvite: pubkey must be 64 lowercase hex characters");
  }
  if (invite.topic.length === 0) {
    throw new Error("encodeInvite: topic must not be empty");
  }
  if (invite.topic.length > MAX_TOPIC_LENGTH) {
    throw new Error(`encodeInvite: topic exceeds ${MAX_TOPIC_LENGTH} characters`);
  }

  // Short keys keep the pasteable token compact.
  const payload = JSON.stringify({
    v: 1,
    t: invite.topic,
    k: pubkey,
    l: sanitizeLabel(invite.label),
  });
  const encoded = base64url(Buffer.from(payload, "utf8"));
  return `${TOKEN_PREFIX}.${encoded}.${checksumOf(encoded)}`;
}

/**
 * Parse and validate an invite token.
 *
 * Every field is treated as hostile: the topic is length-capped, the public key
 * must be well-formed hex, and the label is sanitized before it can reach a log
 * line or the Markdown audit trail.
 */
export function decodeInvite(token: string): InviteParseResult {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "token is empty" };
  }
  if (trimmed.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: `token exceeds ${MAX_TOKEN_LENGTH} characters` };
  }

  const parts = trimmed.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `malformed token (expected ${TOKEN_PREFIX}.<payload>.<checksum>)`,
    };
  }

  const [prefix, encoded, checksum] = parts as [string, string, string];
  if (prefix !== TOKEN_PREFIX) {
    return {
      ok: false,
      error: `unsupported token version "${prefix}" (this build understands ${TOKEN_PREFIX})`,
    };
  }
  if (encoded.length === 0) {
    return { ok: false, error: "token payload is empty" };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return { ok: false, error: "token payload is not valid base64url" };
  }
  if (checksumOf(encoded) !== checksum) {
    return {
      ok: false,
      error: "token checksum mismatch — the token looks truncated or altered",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(encoded).toString("utf8"));
  } catch {
    return { ok: false, error: "token payload is not valid JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "token payload is not an object" };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj["v"] !== 1) {
    return { ok: false, error: `unsupported token payload version: ${String(obj["v"])}` };
  }

  const topic = obj["t"];
  if (typeof topic !== "string" || topic.length === 0) {
    return { ok: false, error: "token is missing a topic" };
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    return { ok: false, error: `token topic exceeds ${MAX_TOPIC_LENGTH} characters` };
  }

  const rawPubkey = obj["k"];
  if (typeof rawPubkey !== "string") {
    return { ok: false, error: "token is missing a public key" };
  }
  const pubkey = normalizePublicKeyHex(rawPubkey);
  if (!pubkey) {
    return { ok: false, error: "token public key is not 64 hex characters" };
  }

  const rawLabel = obj["l"];
  const label = sanitizeLabel(
    typeof rawLabel === "string" ? rawLabel.slice(0, MAX_PEER_LABEL_LENGTH * 4) : "",
  );

  return { ok: true, invite: { topic, pubkey, label } };
}
