import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { generateTopicCode } from "./topic.js";
import { normalizePublicKeyHex, sanitizeLabel } from "./peer-key.js";
import { TOPIC_CODE_LENGTH, TOPIC_MIN_RECOMMENDED_LENGTH } from "./types.js";

export const DAEMON_NAME = "p2pa-daemon";

export interface DocLinkConfig {
  documentId: string;
  url: string;
}

/**
 * Connection policy.
 *
 * - `strict` — only peers in the allowlist may connect (inbound or outbound).
 * - `open`   — anyone who knows the topic may connect (pre-0.7 behaviour).
 *
 * `strict` is the default for new installs. Existing configs are migrated to
 * `open` so an upgrade never silently severs a working pairing; `p2pa status`
 * and every daemon start warn until the operator moves to `strict`.
 */
export type AuthMode = "strict" | "open";

export const DEFAULT_AUTH_MODE: AuthMode = "strict";
export const LEGACY_AUTH_MODE: AuthMode = "open";

/** An allowlisted peer, keyed by its stable ed25519 public key. */
export interface PeerEntry {
  /** Lowercase hex ed25519 public key (64 chars). */
  pubkey: string;
  /** Human-facing name, sanitized on the way in. */
  label: string;
  /** ISO timestamp of when this peer was allowlisted. */
  addedAt: string;
}

export interface P2paConfig {
  topic: string;
  /** Optional Google Doc living-doc binding (no secrets). */
  doc?: DocLinkConfig;
  /** Connection policy. Absent on pre-0.7 configs — see `resolveAuthMode`. */
  auth?: AuthMode;
  /** Peers permitted to connect when `auth` is `strict`. */
  peers?: PeerEntry[];
}

/** Resolve ~/.p2pa (or a home-scoped P2PA_CONFIG_DIR override). */
export function getConfigDir(): string {
  const override = process.env["P2PA_CONFIG_DIR"];
  if (override && override.trim().length > 0) {
    return resolveConfigDirOverride(override.trim());
  }
  return join(homedir(), ".p2pa");
}

/**
 * Accept P2PA_CONFIG_DIR only if the realpath stays under the realpath of $HOME.
 * Rejects symlink escapes (e.g. ~/link → /tmp).
 */
function resolveConfigDirOverride(override: string): string {
  const home = realpathHome();
  const logical = resolve(override);
  if (logical === "/" || logical === home) {
    throw new Error(
      "P2PA_CONFIG_DIR must be a subdirectory under your home directory",
    );
  }

  // Realpath the longest existing prefix; reject if any existing segment is a symlink escape.
  let current = logical;
  const fsRoot = resolve("/");
  const missing: string[] = [];
  while (!existsSync(current) && current !== fsRoot && current !== dirname(current)) {
    missing.unshift(current.slice(dirname(current).length).replace(/^[\\/]/, ""));
    current = dirname(current);
  }

  if (existsSync(current)) {
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("P2PA_CONFIG_DIR must not traverse a symbolic link");
    }
    const realBase = realpathSync(current);
    const relBase = relative(home, realBase);
    if (relBase.startsWith("..") || isAbsolute(relBase)) {
      throw new Error(
        "P2PA_CONFIG_DIR must stay under your home directory (after realpath)",
      );
    }
    const resolved =
      missing.length === 0 ? realBase : resolve(realBase, ...missing);
    const rel = relative(home, resolved);
    if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
      throw new Error(
        "P2PA_CONFIG_DIR must be a subdirectory under your home directory",
      );
    }
    return resolved;
  }

  const rel = relative(home, logical);
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
    throw new Error(
      "P2PA_CONFIG_DIR must be an absolute path under your home directory",
    );
  }
  return logical;
}

function realpathHome(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return resolve(homedir());
  }
}

export function ensureConfigDir(): string {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on platforms that ignore mode
  }
  return dir;
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getSharedContextPath(): string {
  return join(getConfigDir(), "shared_context.md");
}

export function getDaemonErrorLogPath(): string {
  return join(getConfigDir(), "daemon-error.log");
}

export function getDaemonOutLogPath(): string {
  return join(getConfigDir(), "daemon-out.log");
}

export function readConfig(): P2paConfig | null {
  const path = getConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      typeof (raw as { topic?: unknown }).topic === "string" &&
      (raw as { topic: string }).topic.length > 0
    ) {
      const obj = raw as Record<string, unknown>;
      const config: P2paConfig = { topic: obj["topic"] as string };
      const doc = parseDocLink(obj["doc"]);
      if (doc) config.doc = doc;
      const auth = parseAuthMode(obj["auth"]);
      if (auth) config.auth = auth;
      const peers = parsePeers(obj["peers"]);
      if (peers) config.peers = peers;
      return config;
    }
  } catch {
    // ignore corrupt config
  }
  return null;
}

function parseAuthMode(raw: unknown): AuthMode | undefined {
  return raw === "strict" || raw === "open" ? raw : undefined;
}

/**
 * Parse the allowlist, dropping malformed entries rather than failing the whole
 * config — a hand-edited typo should cost one peer, not the daemon's ability to
 * boot. Duplicate public keys collapse to the first occurrence.
 */
function parsePeers(raw: unknown): PeerEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const peers: PeerEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj["pubkey"] !== "string") continue;
    const pubkey = normalizePublicKeyHex(obj["pubkey"]);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    peers.push({
      pubkey,
      label: sanitizeLabel(typeof obj["label"] === "string" ? obj["label"] : ""),
      addedAt:
        typeof obj["addedAt"] === "string" ? obj["addedAt"] : new Date().toISOString(),
    });
  }
  return peers;
}

function parseDocLink(raw: unknown): DocLinkConfig | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as { documentId?: unknown; url?: unknown };
  if (
    typeof obj.documentId === "string" &&
    obj.documentId.length > 0 &&
    typeof obj.url === "string" &&
    obj.url.length > 0
  ) {
    return { documentId: obj.documentId, url: obj.url };
  }
  return undefined;
}

export function writeConfig(config: P2paConfig): void {
  ensureConfigDir();
  const path = getConfigPath();
  const tmp = join(dirname(path), `.config.${process.pid}.tmp.json`);

  // Rebuild explicitly so only known fields are persisted. Every caller must go
  // through `updateConfig` to avoid dropping a sibling field (notably `peers`).
  const payload: P2paConfig = { topic: config.topic };
  if (config.doc) {
    payload.doc = {
      documentId: config.doc.documentId,
      url: config.doc.url,
    };
  }
  if (config.auth) {
    payload.auth = config.auth;
  }
  if (config.peers) {
    payload.peers = config.peers.map((p) => ({
      pubkey: p.pubkey,
      label: p.label,
      addedAt: p.addedAt,
    }));
  }

  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Read-modify-write the config, preserving every field the mutator leaves
 * alone. This is the only safe way to touch one setting: `writeConfig` persists
 * exactly what it is handed, so a partial object silently drops the rest.
 */
export function updateConfig(mutate: (config: P2paConfig) => P2paConfig): P2paConfig {
  const existing = readConfig();
  const base: P2paConfig = existing ?? { topic: "" };
  const next = mutate({ ...base });
  if (next.topic.length === 0) {
    throw new Error("Refusing to write a config without a pairing topic");
  }
  writeConfig(next);
  return next;
}

/** Persist the topic while preserving doc link, auth mode and allowlist. */
export function writeTopicPreservingRest(topic: string): void {
  const existing = readConfig();
  if (!existing) {
    writeConfig({ topic, auth: DEFAULT_AUTH_MODE, peers: [] });
    return;
  }
  writeConfig({ ...existing, topic });
}

export function setDocLink(doc: DocLinkConfig): void {
  const existing = readConfig();
  if (!existing) {
    throw new Error(
      "No pairing topic yet — run `p2pa start --topic …` or `p2pa mcp` once first.",
    );
  }
  updateConfig((config) => ({ ...config, doc }));
}

export function clearDocLink(): DocLinkConfig | null {
  const existing = readConfig();
  if (!existing) return null;
  const prev = existing.doc ?? null;
  const { doc: _dropped, ...rest } = existing;
  void _dropped;
  writeConfig(rest);
  return prev;
}

/**
 * Resolve topic: explicit arg → env P2PA_TOPIC → saved config → generate.
 * Persists the chosen topic to config.json.
 */
export function ensureTopic(explicit?: string): {
  topic: string;
  generated: boolean;
} {
  ensureConfigDir();

  if (explicit !== undefined && explicit.trim().length > 0) {
    const topic = explicit.trim();
    if (topic.length < TOPIC_MIN_RECOMMENDED_LENGTH) {
      console.error(
        `[p2pa] WARNING: topic is only ${topic.length} chars; prefer ≥${TOPIC_MIN_RECOMMENDED_LENGTH}.`,
      );
    }
    writeTopicPreservingRest(topic);
    return { topic, generated: false };
  }

  const fromEnv = process.env["P2PA_TOPIC"];
  if (fromEnv && fromEnv.trim().length > 0) {
    const topic = fromEnv.trim();
    writeTopicPreservingRest(topic);
    return { topic, generated: false };
  }

  const existing = readConfig();
  if (existing) {
    return { topic: existing.topic, generated: false };
  }

  const topic = generateTopicCode(TOPIC_CODE_LENGTH);
  writeConfig({ topic, auth: DEFAULT_AUTH_MODE, peers: [] });
  return { topic, generated: true };
}

/**
 * Resolve the effective connection policy.
 *
 * A config written before 0.7 has no `auth` field. Defaulting those to `strict`
 * would break a working pairing the moment the user upgrades, so they resolve
 * to `open` and are flagged as legacy; callers surface a warning and point at
 * `p2pa auth strict`.
 */
export function resolveAuthMode(config: P2paConfig | null): {
  mode: AuthMode;
  legacy: boolean;
} {
  if (!config) return { mode: DEFAULT_AUTH_MODE, legacy: false };
  if (config.auth) return { mode: config.auth, legacy: false };
  return { mode: LEGACY_AUTH_MODE, legacy: true };
}

export function setAuthMode(mode: AuthMode): P2paConfig {
  return updateConfig((config) => ({ ...config, auth: mode }));
}

export function listPeers(): PeerEntry[] {
  return readConfig()?.peers ?? [];
}

export function findPeer(pubkey: string): PeerEntry | undefined {
  const normalized = normalizePublicKeyHex(pubkey);
  if (!normalized) return undefined;
  return listPeers().find((p) => p.pubkey === normalized);
}

export type AddPeerResult =
  | { ok: true; peer: PeerEntry; updated: boolean }
  | { ok: false; error: string };

/**
 * Allowlist a peer. Re-adding an existing key refreshes its label instead of
 * creating a duplicate, so re-pairing after a rename is idempotent.
 */
export function addPeer(pubkey: string, label: string): AddPeerResult {
  const normalized = normalizePublicKeyHex(pubkey);
  if (!normalized) {
    return { ok: false, error: "public key must be 64 hex characters" };
  }

  const cleanLabel = sanitizeLabel(label);
  let updated = false;
  let peer: PeerEntry = {
    pubkey: normalized,
    label: cleanLabel,
    addedAt: new Date().toISOString(),
  };

  updateConfig((config) => {
    const peers = [...(config.peers ?? [])];
    const index = peers.findIndex((p) => p.pubkey === normalized);
    if (index >= 0) {
      updated = true;
      peer = { ...peers[index]!, label: cleanLabel };
      peers[index] = peer;
    } else {
      peers.push(peer);
    }
    return { ...config, peers };
  });

  return { ok: true, peer, updated };
}

/** Remove a peer by full public key or by exact label. Returns what was removed. */
export function removePeer(pubkeyOrLabel: string): PeerEntry | null {
  const needle = pubkeyOrLabel.trim();
  const normalized = normalizePublicKeyHex(needle);
  let removed: PeerEntry | null = null;

  updateConfig((config) => {
    const peers = config.peers ?? [];
    const index = normalized
      ? peers.findIndex((p) => p.pubkey === normalized)
      : peers.findIndex((p) => p.label === needle);
    if (index < 0) return config;
    removed = peers[index]!;
    return { ...config, peers: peers.filter((_, i) => i !== index) };
  });

  return removed;
}
