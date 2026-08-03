/**
 * Per-operation signatures.
 *
 * The transport authenticates each hop: Noise proves who is on the other end of
 * a connection, and `handleInboundOps` binds a direct update's stamps to that
 * peer's node id, so nobody can write as somebody else *directly*.
 *
 * Snapshots are the hole. A snapshot legitimately relays operations authored by
 * third parties — that is how a new peer learns what everyone else has done — so
 * its entries cannot be bound to the sender. With two nodes that costs nothing:
 * the only stamps a peer can relay are its own or yours. With three or more, peer
 * B can fabricate an entry stamped with peer C's node id, relay it to A, and A
 * records it in the audit trail as C's work. For a protocol whose value is an
 * attributed history, "the log blames the wrong agent" is a correctness failure,
 * not a hardening nicety.
 *
 * A signature travels with the entry rather than the envelope, because it has to
 * survive being relayed: an op signed by C stays verifiable no matter how many
 * peers pass it along. The signing key is the node's Hyperswarm identity key —
 * the same one the Noise handshake already proves — so there is no second
 * keypair to distribute, and `by` is checked against `hlc.n` so a signature
 * cannot be lifted onto a stamp it does not belong to.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { nodeIdFromPublicKey } from "./hlc.js";
import type { CrdtEntry, CrdtOp } from "./crdt.js";
import type { JsonValue } from "./types.js";

/**
 * Domain separator.
 *
 * Without it a signature over some other structure that happened to serialize
 * identically would verify here. Versioned so the encoding can change without
 * old signatures becoming ambiguous.
 */
export const SIGNATURE_DOMAIN = "p2pa-op-v1";

/** Raw ed25519 signature length, and therefore its base64 length. */
export const SIGNATURE_BYTES = 64;
export const SIGNATURE_B64_LENGTH = 88;

/** Hex length of an ed25519 public key. */
export const PUBLIC_KEY_HEX_LENGTH = 64;

/**
 * DER prefixes that let `node:crypto` load a raw ed25519 key.
 *
 * Hyperswarm hands out libsodium-shaped keys (secret = seed ‖ public), while
 * `node:crypto` wants PKCS#8 / SPKI. Prepending the fixed ASN.1 header for
 * `id-Ed25519` converts between them with no dependency and no key material
 * derived differently — the public key recovered from the wrapped seed is
 * byte-identical to the one Hyperswarm advertises, which the test suite asserts.
 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Fields that are signature metadata rather than replicated content. */
const UNSIGNED_FIELDS = new Set(["by", "sig"]);

/**
 * The exact bytes a signature covers.
 *
 * The key is included so a signed value cannot be moved to a different key, and
 * the stamp is inside the entry so it cannot be re-dated. `by` and `sig`
 * themselves are excluded — a signature cannot cover itself.
 */
export function signableBytes(op: CrdtOp): Buffer {
  const bare: Record<string, JsonValue> = {};
  for (const [field, value] of Object.entries(op.entry)) {
    if (UNSIGNED_FIELDS.has(field)) continue;
    if (value === undefined) continue;
    bare[field] = value as JsonValue;
  }
  return Buffer.from(
    `${SIGNATURE_DOMAIN}\n${op.key}\n${canonicalJson(bare)}`,
    "utf8",
  );
}

/** Load a signing key from the 32-byte seed behind a Hyperswarm identity. */
export function privateKeyFromSeed(seed: Buffer): ReturnType<typeof createPrivateKey> {
  if (seed.length !== 32) {
    throw new Error(`ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * Load a verifying key from a hex public key.
 *
 * Returns null for anything malformed rather than throwing: the input arrives
 * from a peer, and an unparseable key is an ordinary "does not verify".
 */
function publicKeyFromHex(hex: string): ReturnType<typeof createPublicKey> | null {
  if (hex.length !== PUBLIC_KEY_HEX_LENGTH || !/^[0-9a-f]+$/.test(hex)) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, "hex")]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/**
 * A node's signing identity.
 *
 * Built from the identity seed, so the signing key and the key Noise
 * authenticates are the same key by construction.
 */
export class OpSigner {
  private readonly privateKey: ReturnType<typeof createPrivateKey>;

  constructor(
    seed: Buffer,
    /** Lowercase hex public key matching the seed. */
    readonly publicKeyHex: string,
  ) {
    this.privateKey = privateKeyFromSeed(seed);
  }

  /** Node id this signer authors under, for cross-checking stamps. */
  get nodeId(): string {
    return nodeIdFromPublicKey(this.publicKeyHex);
  }

  /**
   * Attach `by` + `sig` to an op.
   *
   * Refuses to sign an op whose stamp belongs to another node: producing one
   * would be indistinguishable from the forgery this exists to prevent.
   */
  signOp(op: CrdtOp): CrdtOp {
    if (op.entry.hlc.n !== this.nodeId) {
      throw new Error(
        `refusing to sign an op stamped by ${op.entry.hlc.n}; this node is ${this.nodeId}`,
      );
    }
    const bare: CrdtOp = { key: op.key, entry: stripSignature(op.entry) };
    const signature = sign(null, signableBytes(bare), this.privateKey);
    return {
      key: op.key,
      entry: {
        ...bare.entry,
        by: this.publicKeyHex,
        sig: signature.toString("base64"),
      } as CrdtEntry,
    };
  }

  signAll(ops: CrdtOp[]): CrdtOp[] {
    return ops.map((op) => this.signOp(op));
  }
}

/** Remove signature metadata, e.g. before re-signing or comparing content. */
export function stripSignature(entry: CrdtEntry): CrdtEntry {
  if (entry.by === undefined && entry.sig === undefined) return entry;
  const copy = { ...entry } as Record<string, unknown>;
  delete copy["by"];
  delete copy["sig"];
  return copy as unknown as CrdtEntry;
}

export function isSigned(entry: CrdtEntry): boolean {
  return typeof entry.by === "string" && typeof entry.sig === "string";
}

export type VerifyOutcome =
  | { status: "unsigned" }
  | { status: "valid"; author: string }
  | { status: "invalid"; reason: string };

/**
 * Check an op's signature.
 *
 * Three outcomes rather than a boolean: "no signature" and "a signature that
 * does not verify" call for opposite responses. The first is a v3 peer or a
 * relayed legacy entry; the second is an active forgery attempt and costs the
 * sender its connection.
 */
export function verifyOp(op: CrdtOp): VerifyOutcome {
  const { by, sig } = op.entry;
  if (by === undefined && sig === undefined) return { status: "unsigned" };
  if (typeof by !== "string" || typeof sig !== "string") {
    return { status: "invalid", reason: "incomplete signature metadata" };
  }

  // The signature proves who authored the bytes; this proves the bytes claim the
  // same author. Without it a valid signature could be paired with any stamp.
  if (nodeIdFromPublicKey(by) !== op.entry.hlc.n) {
    return {
      status: "invalid",
      reason: "signing key does not match the stamp's node id",
    };
  }

  const publicKey = publicKeyFromHex(by);
  if (!publicKey) return { status: "invalid", reason: "malformed public key" };

  let signature: Buffer;
  try {
    signature = Buffer.from(sig, "base64");
  } catch {
    return { status: "invalid", reason: "malformed signature encoding" };
  }
  if (signature.length !== SIGNATURE_BYTES) {
    return { status: "invalid", reason: "wrong signature length" };
  }

  try {
    const ok = verify(null, signableBytes(op), publicKey, signature);
    return ok
      ? { status: "valid", author: by }
      : { status: "invalid", reason: "signature does not verify" };
  } catch {
    return { status: "invalid", reason: "signature verification failed" };
  }
}
