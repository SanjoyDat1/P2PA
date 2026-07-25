/**
 * Pure helpers for peer public keys and labels.
 *
 * Dependency-free on purpose: both `config.ts` and `identity.ts` need these,
 * and `identity.ts` already depends on `config.ts` for the config directory.
 */

/** Length of an ed25519 public key in bytes (64 hex chars). */
export const PUBKEY_BYTES = 32;

/** Length of the identity seed in bytes. */
export const IDENTITY_SEED_BYTES = 32;

/** Max characters for a human-facing peer label. */
export const MAX_PEER_LABEL_LENGTH = 64;

const PUBKEY_HEX = new RegExp(`^[0-9a-f]{${PUBKEY_BYTES * 2}}$`);
const SEED_HEX = new RegExp(`^[0-9a-f]{${IDENTITY_SEED_BYTES * 2}}$`);

/** Control characters (C0 + DEL) — stripped from peer-supplied labels. */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/** Characters that could forge Markdown or CLI structure in the audit trail. */
const STRUCTURAL_CHARS = /[`*_[\]()<>|\\]/g;

/** First 8 hex chars of a public key — safe to log, safe to show in the UI. */
export function shortFingerprint(publicKeyHex: string): string {
  return publicKeyHex.slice(0, 8);
}

/** True if `value` is a syntactically valid lowercase-hex ed25519 public key. */
export function isValidPublicKeyHex(value: string): boolean {
  return PUBKEY_HEX.test(value);
}

/** True if `value` is a syntactically valid lowercase-hex identity seed. */
export function isValidSeedHex(value: string): boolean {
  return SEED_HEX.test(value);
}

/**
 * Normalize a user-supplied public key (accepts mixed case / surrounding space).
 * Returns null when the value is not a well-formed key.
 */
export function normalizePublicKeyHex(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return isValidPublicKeyHex(normalized) ? normalized : null;
}

/**
 * Clamp a label to something safe to render in logs, Markdown and the CLI.
 *
 * Labels arrive from invite tokens, i.e. from whoever issued the token. Without
 * this, a peer could pick a label containing newlines or Markdown headings and
 * forge audit-trail entries attributed to someone else.
 */
export function sanitizeLabel(raw: string): string {
  const cleaned = raw
    .replace(CONTROL_CHARS, " ")
    .replace(STRUCTURAL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PEER_LABEL_LENGTH);
  return cleaned.length > 0 ? cleaned : "unnamed-peer";
}
