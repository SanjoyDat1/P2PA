/**
 * Stable P2PA node identity.
 *
 * A 32-byte seed is persisted to `~/.p2pa/identity.json` (0600); the ed25519
 * keypair used for the Hyperswarm Noise handshake is derived from it at boot.
 * Only the seed is stored — never the expanded secret key — so the file stays
 * small and rotation is a single delete.
 *
 * The public key is this node's permanent address on the swarm. Peers allowlist
 * each other by public key, which is what makes `firewall` in `p2p.ts` a real
 * authentication boundary rather than a hint.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { hostname } from "node:os";
import { join, dirname } from "node:path";
import DHT from "hyperdht";
import { ensureConfigDir, getConfigDir } from "./config.js";
import {
  IDENTITY_SEED_BYTES,
  isValidSeedHex,
  sanitizeLabel,
  shortFingerprint,
} from "./peer-key.js";

export interface KeyPair {
  publicKey: Buffer;
  secretKey: Buffer;
}

export interface Identity {
  /** Derived ed25519 keypair — pass straight to `new Hyperswarm({ keyPair })`. */
  keyPair: KeyPair;
  /** Lowercase hex of `keyPair.publicKey` (64 chars). */
  publicKeyHex: string;
  /** Short display form (first 8 hex chars) for logs and the audit trail. */
  fingerprint: string;
  /** Human-facing name shared with peers during pairing. */
  label: string;
}

interface IdentityFile {
  version: 1;
  seed: string;
  label: string;
  createdAt: string;
}

export function getIdentityPath(): string {
  return join(getConfigDir(), "identity.json");
}

function defaultLabel(): string {
  const fromEnv = process.env["P2PA_PEER_LABEL"];
  if (fromEnv && fromEnv.trim().length > 0) {
    return sanitizeLabel(fromEnv);
  }
  try {
    return sanitizeLabel(hostname());
  } catch {
    return "p2pa-node";
  }
}

function parseIdentityFile(raw: unknown): IdentityFile | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const seed = obj["seed"];
  if (typeof seed !== "string" || !isValidSeedHex(seed)) return null;
  const label =
    typeof obj["label"] === "string" && obj["label"].trim().length > 0
      ? sanitizeLabel(obj["label"])
      : defaultLabel();
  const createdAt =
    typeof obj["createdAt"] === "string" ? obj["createdAt"] : new Date().toISOString();
  return { version: 1, seed, label, createdAt };
}

function readIdentityFile(): IdentityFile | null {
  const path = getIdentityPath();
  if (!existsSync(path)) return null;
  try {
    return parseIdentityFile(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writeIdentityFile(file: IdentityFile): void {
  ensureConfigDir();
  const path = getIdentityPath();
  const tmp = join(dirname(path), `.identity.${process.pid}.tmp.json`);
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on platforms that ignore mode
  }
}

function deriveIdentity(file: IdentityFile): Identity {
  const seed = Buffer.from(file.seed, "hex");
  const derived = DHT.keyPair(seed);
  const publicKey = Buffer.from(derived.publicKey);
  const publicKeyHex = publicKey.toString("hex");
  return {
    keyPair: { publicKey, secretKey: Buffer.from(derived.secretKey) },
    publicKeyHex,
    fingerprint: shortFingerprint(publicKeyHex),
    label: file.label,
  };
}

function freshIdentityFile(label?: string): IdentityFile {
  return {
    version: 1,
    seed: randomBytes(IDENTITY_SEED_BYTES).toString("hex"),
    label: label === undefined ? defaultLabel() : sanitizeLabel(label),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Load the node identity, creating (and persisting) a fresh seed on first run.
 * The returned keypair is stable across restarts, which is what lets a peer's
 * allowlist entry keep matching us.
 */
export function loadOrCreateIdentity(): Identity {
  if (existsSync(getIdentityPath())) {
    const parsed = readIdentityFile();
    if (parsed) return deriveIdentity(parsed);
    console.error(
      "[p2pa:identity] identity.json is unreadable or malformed — generating a new " +
        "identity (peers must re-pair with your new public key)",
    );
  }

  const file = freshIdentityFile();
  writeIdentityFile(file);
  return deriveIdentity(file);
}

/** Rename this node as shown to peers during pairing. Keeps the existing key. */
export function setIdentityLabel(label: string): Identity {
  const existing = readIdentityFile();
  const file: IdentityFile = existing
    ? { ...existing, label: sanitizeLabel(label) }
    : freshIdentityFile(label);
  writeIdentityFile(file);
  return deriveIdentity(file);
}
