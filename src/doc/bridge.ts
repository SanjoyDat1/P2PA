/**
 * Living-doc bridge: Google Docs ↔ P2PA steering.
 *
 * Outbound: agent publish → Docs API only (no store mutation).
 * Inbound: poll HUMAN directives → commitLocalMutation(steering).
 */
import type { SyncServices } from "../sync.js";
import { commitLocalMutation } from "../sync.js";
import { toJsonValue, type JsonValue } from "../types.js";
import type { GoogleDocsClient } from "./google-docs-client.js";
import {
  DocRevisionConflictError,
  hashText,
} from "./google-docs-client.js";
import {
  appendAgentLogLine,
  extractDocTitle,
  parseDocSections,
  serializeDocSections,
  type DocSectionId,
  type DocSections,
} from "./template.js";

export const STEERING_KEY = "steering";
const PUBLISH_MAX_ATTEMPTS = 5;

export type PublishSection = "status" | "plan" | "agent_log";

export interface DocBridgeOptions {
  documentId: string;
  url: string;
  client: GoogleDocsClient;
  services: SyncServices;
  pollIntervalMs?: number;
}

export interface DocBridgeStatus {
  linked: true;
  documentId: string;
  url: string;
  polling: boolean;
  lastPollAt: string | null;
  lastPollOk: boolean | null;
  lastPollError: string | null;
  lastHumanHash: string | null;
}

export interface SteeringValue {
  text: string;
  updatedAt: string;
  docRevision: string;
}

export class DocBridge {
  readonly documentId: string;
  readonly url: string;
  private readonly client: GoogleDocsClient;
  private readonly services: SyncServices;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHumanHash: string | null = null;
  private lastPollAt: string | null = null;
  private lastPollOk: boolean | null = null;
  private lastPollError: string | null = null;
  private pollInFlight = false;

  constructor(options: DocBridgeOptions) {
    this.documentId = options.documentId;
    this.url = options.url;
    this.client = options.client;
    this.services = options.services;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollMs();
  }

  start(): void {
    if (this.timer !== null) return;
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): DocBridgeStatus {
    return {
      linked: true,
      documentId: this.documentId,
      url: this.url,
      polling: this.timer !== null,
      lastPollAt: this.lastPollAt,
      lastPollOk: this.lastPollOk,
      lastPollError: this.lastPollError,
      lastHumanHash: this.lastHumanHash,
    };
  }

  readSteering(): SteeringValue | null {
    const raw = this.services.store.get(STEERING_KEY);
    return parseSteeringValue(raw);
  }

  /** Force one poll; returns latest steering after. */
  async refreshSteering(): Promise<SteeringValue | null> {
    await this.pollOnce();
    return this.readSteering();
  }

  /**
   * Publish with revision-checked RMW retries so concurrent HUMAN edits
   * are re-merged from a fresh snapshot instead of silently clobbered.
   */
  async publish(section: PublishSection, content: string): Promise<void> {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("content must be non-empty");
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
      try {
        const snap = await this.client.getDocument(this.documentId);
        const title = extractDocTitle(snap.plainText);
        const sections = parseDocSections(snap.plainText);

        if (section === "status") {
          sections.status = trimmed;
        } else if (section === "plan") {
          sections.plan = trimmed;
        } else {
          sections.agent_log = appendAgentLogLine(sections.agent_log, trimmed);
        }

        const next = serializeDocSections(sections, title);
        await this.client.setPlainText(
          this.documentId,
          next,
          snap.revisionId,
        );
        return;
      } catch (err) {
        lastError = err;
        if (
          err instanceof DocRevisionConflictError &&
          attempt < PUBLISH_MAX_ATTEMPTS
        ) {
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  private async pollOnce(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const snap = await this.client.getDocument(this.documentId);
      const sections = parseDocSections(snap.plainText);
      const human = sections.human;
      const hash = hashText(human);
      this.lastPollAt = new Date().toISOString();
      this.lastPollOk = true;
      this.lastPollError = null;

      if (this.lastHumanHash === hash) {
        return;
      }

      // Restart / dual-process: skip commit when store already mirrors this HUMAN text.
      const existing = this.readSteering();
      if (existing && existing.docRevision === hash) {
        this.lastHumanHash = hash;
        return;
      }

      const value: SteeringValue = {
        text: human,
        updatedAt: this.lastPollAt,
        docRevision: hash,
      };

      const result = commitLocalMutation(this.services, (store) => {
        store.setKey(STEERING_KEY, toJsonValue(value));
      });
      if (!result.ok) {
        console.error(`[p2pa:doc] failed to commit steering: ${result.error}`);
        // Do not advance lastHumanHash — retry on next poll.
        return;
      }

      this.lastHumanHash = hash;
      if (result.ops.length > 0) {
        console.error(
          `[p2pa:doc] steering updated (${human.length} chars, rev=${hash})`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastPollAt = new Date().toISOString();
      this.lastPollOk = false;
      this.lastPollError = message;
      console.error(`[p2pa:doc] poll failed: ${message}`);
    } finally {
      this.pollInFlight = false;
    }
  }
}

export function defaultPollMs(): number {
  const raw = process.env["P2PA_DOC_POLL_MS"];
  if (raw && raw.trim().length > 0) {
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n >= 1000 && n <= 120_000) {
      return n;
    }
  }
  return 4000;
}

export function parseSteeringValue(raw: JsonValue | undefined): SteeringValue | null {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, JsonValue>;
  if (typeof obj["text"] !== "string") return null;
  if (typeof obj["updatedAt"] !== "string") return null;
  if (typeof obj["docRevision"] !== "string") return null;
  return {
    text: obj["text"],
    updatedAt: obj["updatedAt"],
    docRevision: obj["docRevision"],
  };
}

/** Apply a section update onto a DocSections object (pure helper for tests). */
export function applyPublishToSections(
  sections: DocSections,
  section: PublishSection,
  content: string,
): DocSections {
  const next: DocSections = { ...sections };
  if (section === "status") next.status = content.trim();
  else if (section === "plan") next.plan = content.trim();
  else next.agent_log = appendAgentLogLine(sections.agent_log, content);
  return next;
}

export type { DocSectionId };
