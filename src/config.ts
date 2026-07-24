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
import { TOPIC_CODE_LENGTH, TOPIC_MIN_RECOMMENDED_LENGTH } from "./types.js";

export const DAEMON_NAME = "p2pa-daemon";

export interface DocLinkConfig {
  documentId: string;
  url: string;
}

export interface P2paConfig {
  topic: string;
  /** Optional Google Doc living-doc binding (no secrets). */
  doc?: DocLinkConfig;
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
      const topic = (raw as { topic: string }).topic;
      const doc = parseDocLink((raw as { doc?: unknown }).doc);
      return doc ? { topic, doc } : { topic };
    }
  } catch {
    // ignore corrupt config
  }
  return null;
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
  const payload: P2paConfig = { topic: config.topic };
  if (config.doc) {
    payload.doc = {
      documentId: config.doc.documentId,
      url: config.doc.url,
    };
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

/** Persist topic while preserving an existing doc link. */
export function writeTopicPreservingDoc(topic: string): void {
  const existing = readConfig();
  if (existing?.doc) {
    writeConfig({ topic, doc: existing.doc });
  } else {
    writeConfig({ topic });
  }
}

export function setDocLink(doc: DocLinkConfig): void {
  const existing = readConfig();
  if (!existing) {
    throw new Error(
      "No pairing topic yet — run `p2pa start --topic …` or `p2pa mcp` once first.",
    );
  }
  writeConfig({ topic: existing.topic, doc });
}

export function clearDocLink(): DocLinkConfig | null {
  const existing = readConfig();
  if (!existing) return null;
  const prev = existing.doc ?? null;
  writeConfig({ topic: existing.topic });
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
    writeTopicPreservingDoc(topic);
    return { topic, generated: false };
  }

  const fromEnv = process.env["P2PA_TOPIC"];
  if (fromEnv && fromEnv.trim().length > 0) {
    const topic = fromEnv.trim();
    writeTopicPreservingDoc(topic);
    return { topic, generated: false };
  }

  const existing = readConfig();
  if (existing) {
    return { topic: existing.topic, generated: false };
  }

  const topic = generateTopicCode(TOPIC_CODE_LENGTH);
  writeConfig({ topic });
  return { topic, generated: true };
}
