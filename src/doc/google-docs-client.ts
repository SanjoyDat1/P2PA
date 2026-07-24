/**
 * Google Docs client interface + real (googleapis) and mock implementations.
 *
 * Credentials: P2PA_GOOGLE_SA_JSON must be a **file path** under $HOME (never inline JSON).
 */
import { createHash } from "node:crypto";
import {
  readFileSync,
  existsSync,
  realpathSync,
  lstatSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { google, type docs_v1, type drive_v3 } from "googleapis";
import { buildDocTemplate } from "./template.js";

export interface CreatedDoc {
  documentId: string;
  url: string;
}

export interface DocSnapshot {
  plainText: string;
  /** Google Docs revision id when available (mock uses a counter string). */
  revisionId: string | null;
}

export interface GoogleDocsClient {
  createDoc(title: string): Promise<CreatedDoc>;
  shareAnyoneWriter(documentId: string): Promise<void>;
  getDocument(documentId: string): Promise<DocSnapshot>;
  /**
   * Replace the entire document body with plain text.
   * When `expectedRevisionId` is set, the write fails if the doc moved (caller should retry).
   * Returns the new revision id when known.
   */
  setPlainText(
    documentId: string,
    plainText: string,
    expectedRevisionId?: string | null,
  ): Promise<string | null>;
}

export class DocRevisionConflictError extends Error {
  constructor(message = "Google Doc revision conflict") {
    super(message);
    this.name = "DocRevisionConflictError";
  }
}

export function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

export function extractDocumentId(urlOrId: string): string | null {
  const trimmed = urlOrId.trim();
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed) && !trimmed.includes("/")) {
    return trimmed;
  }
  const match = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

/**
 * Load SA credentials from P2PA_GOOGLE_SA_JSON (path only, under $HOME).
 * Inline JSON is rejected so keys never land in MCP config / PM2 env dumps.
 */
export function loadServiceAccountJson(): Record<string, unknown> | null {
  const raw = process.env["P2PA_GOOGLE_SA_JSON"];
  if (!raw || raw.trim().length === 0) return null;
  const value = raw.trim();
  if (value.startsWith("{")) {
    console.error(
      "[p2pa:doc] P2PA_GOOGLE_SA_JSON must be a file path, not inline JSON " +
        "(refusing to load credentials from env value)",
    );
    return null;
  }

  let path: string;
  try {
    path = resolveSaKeyPath(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[p2pa:doc] invalid P2PA_GOOGLE_SA_JSON path: ${message}`);
    return null;
  }

  if (!existsSync(path)) return null;
  try {
    if (!lstatSync(path).isFile()) {
      console.error("[p2pa:doc] P2PA_GOOGLE_SA_JSON must point to a regular file");
      return null;
    }
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.error(
        `[p2pa:doc] WARNING: SA key file mode is ${mode.toString(8)}; prefer chmod 600`,
      );
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/** SA key path must realpath to a file under $HOME (same spirit as P2PA_CONFIG_DIR). */
function resolveSaKeyPath(override: string): string {
  const home = realpathHome();
  const logical = resolve(override);
  if (existsSync(logical) && lstatSync(logical).isSymbolicLink()) {
    throw new Error("P2PA_GOOGLE_SA_JSON must not be a symbolic link");
  }
  // Realpath longest existing prefix
  let current = logical;
  const missing: string[] = [];
  const fsRoot = resolve("/");
  while (!existsSync(current) && current !== fsRoot && current !== dirname(current)) {
    missing.unshift(current.slice(dirname(current).length).replace(/^[\\/]/, ""));
    current = dirname(current);
  }
  if (!existsSync(current)) {
    throw new Error("P2PA_GOOGLE_SA_JSON path does not exist");
  }
  if (lstatSync(current).isSymbolicLink()) {
    throw new Error("P2PA_GOOGLE_SA_JSON must not traverse a symbolic link");
  }
  const realBase = realpathSync(current);
  const resolved =
    missing.length === 0 ? realBase : resolve(realBase, ...missing);
  const rel = relative(home, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
    throw new Error("P2PA_GOOGLE_SA_JSON must stay under your home directory");
  }
  return resolved;
}

function realpathHome(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return resolve(homedir());
  }
}

export function createGoogleDocsClientFromEnv(): GoogleDocsClient | null {
  const credentials = loadServiceAccountJson();
  if (!credentials) return null;
  return new RealGoogleDocsClient(credentials);
}

class RealGoogleDocsClient implements GoogleDocsClient {
  private readonly docs: docs_v1.Docs;
  private readonly drive: drive_v3.Drive;

  constructor(credentials: Record<string, unknown>) {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/documents",
        // File-scoped Drive: create/share/update docs this app opens — not full Drive.
        "https://www.googleapis.com/auth/drive.file",
      ],
    });
    this.docs = google.docs({ version: "v1", auth });
    this.drive = google.drive({ version: "v3", auth });
  }

  async createDoc(title: string): Promise<CreatedDoc> {
    const created = await this.docs.documents.create({
      requestBody: { title },
    });
    const documentId = created.data.documentId;
    if (!documentId) {
      throw new Error("Google Docs create returned no documentId");
    }
    const body = buildDocTemplate(title);
    await this.setPlainText(documentId, body, null);
    return { documentId, url: documentUrl(documentId) };
  }

  async shareAnyoneWriter(documentId: string): Promise<void> {
    await this.drive.permissions.create({
      fileId: documentId,
      requestBody: {
        type: "anyone",
        role: "writer",
        allowFileDiscovery: false,
      },
    });
  }

  async getDocument(documentId: string): Promise<DocSnapshot> {
    const res = await this.docs.documents.get({ documentId });
    return {
      plainText: extractPlainTextFromDoc(res.data),
      revisionId: res.data.revisionId ?? null,
    };
  }

  async setPlainText(
    documentId: string,
    plainText: string,
    expectedRevisionId?: string | null,
  ): Promise<string | null> {
    const res = await this.docs.documents.get({ documentId });
    const currentRevision = res.data.revisionId ?? null;
    if (
      expectedRevisionId !== undefined &&
      expectedRevisionId !== null &&
      currentRevision !== null &&
      expectedRevisionId !== currentRevision
    ) {
      throw new DocRevisionConflictError(
        `Doc revision moved (expected ${expectedRevisionId}, got ${currentRevision})`,
      );
    }

    const endIndex = res.data.body?.content
      ? lastBodyEndIndex(res.data.body.content)
      : 1;

    const requests: docs_v1.Schema$Request[] = [];
    if (endIndex > 2) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: 1, endIndex: endIndex - 1 },
        },
      });
    }
    if (plainText.length > 0) {
      requests.push({
        insertText: {
          location: { index: 1 },
          text: plainText.endsWith("\n") ? plainText : `${plainText}\n`,
        },
      });
    }

    if (requests.length === 0) return currentRevision;

    const writeControl =
      expectedRevisionId !== undefined &&
      expectedRevisionId !== null &&
      expectedRevisionId.length > 0
        ? { targetRevisionId: expectedRevisionId }
        : currentRevision
          ? { targetRevisionId: currentRevision }
          : undefined;

    try {
      const updated = await this.docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests,
          ...(writeControl ? { writeControl } : {}),
        },
      });
      return updated.data.writeControl?.targetRevisionId ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/revision|conflict|precondition|410|400/i.test(message)) {
        throw new DocRevisionConflictError(message);
      }
      throw err;
    }
  }
}

function lastBodyEndIndex(
  content: docs_v1.Schema$StructuralElement[],
): number {
  let max = 1;
  for (const el of content) {
    if (typeof el.endIndex === "number" && el.endIndex > max) {
      max = el.endIndex;
    }
  }
  return max;
}

function extractPlainTextFromDoc(doc: docs_v1.Schema$Document): string {
  const content = doc.body?.content;
  if (!content) return "";
  const parts: string[] = [];
  for (const el of content) {
    const paragraph = el.paragraph;
    if (!paragraph?.elements) continue;
    for (const pe of paragraph.elements) {
      if (typeof pe.textRun?.content === "string") {
        parts.push(pe.textRun.content);
      }
    }
  }
  return parts.join("");
}

/** In-memory client for smoke tests (no network). */
export class MockGoogleDocsClient implements GoogleDocsClient {
  readonly docs = new Map<string, string>();
  readonly revisions = new Map<string, number>();
  readonly shared = new Set<string>();
  /** When set, next setPlainText with a mismatched expected revision throws. */
  forceConflictOnce = false;
  private seq = 0;

  async createDoc(title: string): Promise<CreatedDoc> {
    this.seq += 1;
    const documentId = `mock-doc-${this.seq}`;
    this.docs.set(documentId, buildDocTemplate(title));
    this.revisions.set(documentId, 1);
    return { documentId, url: documentUrl(documentId) };
  }

  async shareAnyoneWriter(documentId: string): Promise<void> {
    if (!this.docs.has(documentId)) {
      throw new Error(`Unknown documentId: ${documentId}`);
    }
    this.shared.add(documentId);
  }

  async getDocument(documentId: string): Promise<DocSnapshot> {
    const text = this.docs.get(documentId);
    if (text === undefined) {
      throw new Error(`Unknown documentId: ${documentId}`);
    }
    const rev = this.revisions.get(documentId) ?? 1;
    return { plainText: text, revisionId: String(rev) };
  }

  async setPlainText(
    documentId: string,
    plainText: string,
    expectedRevisionId?: string | null,
  ): Promise<string | null> {
    if (!this.docs.has(documentId)) {
      throw new Error(`Unknown documentId: ${documentId}`);
    }
    const current = String(this.revisions.get(documentId) ?? 1);
    if (this.forceConflictOnce) {
      this.forceConflictOnce = false;
      throw new DocRevisionConflictError("forced conflict");
    }
    if (
      expectedRevisionId !== undefined &&
      expectedRevisionId !== null &&
      expectedRevisionId !== current
    ) {
      throw new DocRevisionConflictError(
        `Doc revision moved (expected ${expectedRevisionId}, got ${current})`,
      );
    }
    this.docs.set(documentId, plainText);
    const next = (this.revisions.get(documentId) ?? 1) + 1;
    this.revisions.set(documentId, next);
    return String(next);
  }

  /** Test helper: simulate a human editing the HUMAN section via full rewrite. */
  simulateHumanEdit(documentId: string, fullPlainText: string): void {
    this.docs.set(documentId, fullPlainText);
    const next = (this.revisions.get(documentId) ?? 1) + 1;
    this.revisions.set(documentId, next);
  }
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
