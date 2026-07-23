import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Operation } from "fast-json-patch";
import type {
  AuditEntry,
  ConflictItem,
  ContextState,
  Source,
} from "./types.js";

const TITLE = "# P2PA Shared Context";
const ACTIVE_HEADING = "## Active State";
const CONFLICTS_HEADING = "## Conflicts";
const AUDIT_HEADING = "## Audit Trail";

/**
 * Sectioned Markdown persistence:
 * - ## Active State  — rewritten JSON snapshot on every state change
 * - ## Conflicts     — rewritten from the in-memory conflict queue
 * - ## Audit Trail   — append-only patch / message / resolution history
 */
export class MarkdownLog {
  private staleConflictsCleared = false;

  constructor(private readonly filePath: string) {}

  ensureInitialized(): void {
    const dir = dirname(this.filePath);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(this.filePath)) {
      atomicWrite(this.filePath, buildSkeleton({}));
      this.staleConflictsCleared = true;
      return;
    }

    const existing = readFileSync(this.filePath, "utf8");
    if (
      findHeadingIndex(existing, ACTIVE_HEADING) < 0 ||
      findHeadingIndex(existing, AUDIT_HEADING) < 0
    ) {
      const migrated = buildSkeleton({}) + formatMigratedBlock(existing);
      atomicWrite(this.filePath, migrated);
      this.staleConflictsCleared = true;
      return;
    }

    // Queue is memory-only — clear any stale Conflicts section once on boot.
    if (!this.staleConflictsCleared) {
      this.staleConflictsCleared = true;
      atomicWrite(this.filePath, rewriteConflictsSection(existing, []));
    }
  }

  syncMarkdownLog(entry: AuditEntry, state?: ContextState): void {
    this.ensureInitialized();
    let content = readFileSync(this.filePath, "utf8");
    if (state !== undefined) {
      content = replaceActiveState(content, state);
    }
    content = appendAuditEntry(content, entry);
    atomicWrite(this.filePath, content);
  }

  syncStatePatch(source: Source, ops: Operation[], state: ContextState): void {
    this.syncMarkdownLog({ source, action: "State Patch", ops }, state);
  }

  syncMessage(source: Source, text: string): void {
    this.syncMarkdownLog({ source, action: "Message", text });
  }

  syncSnapshot(source: Source, state: ContextState): void {
    this.syncMarkdownLog({ source, action: "State Snapshot" }, state);
  }

  /** Rewrite ## Conflicts from the live queue (omit section when empty). */
  rewriteConflicts(items: ConflictItem[]): void {
    this.ensureInitialized();
    const content = readFileSync(this.filePath, "utf8");
    atomicWrite(this.filePath, rewriteConflictsSection(content, items));
  }

  readActiveState(): ContextState {
    if (!existsSync(this.filePath)) return {};
    const content = readFileSync(this.filePath, "utf8");
    const section = sliceActiveSection(content);
    if (section === undefined) return {};

    const start = section.indexOf("{");
    const end = section.lastIndexOf("}");
    if (start < 0 || end < start) return {};

    try {
      const parsed: unknown = JSON.parse(section.slice(start, end + 1));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as ContextState;
      }
    } catch {
      console.error("[markdown] failed to parse Active State JSON; starting empty");
    }
    return {};
  }

  readLastLines(n = 50): string {
    if (!existsSync(this.filePath)) return "";
    return readFileTailLines(this.filePath, n);
  }

  get path(): string {
    return this.filePath;
  }
}

function buildSkeleton(state: ContextState): string {
  return `${TITLE}\n\n${formatActiveSection(state)}\n${AUDIT_HEADING}\n\n`;
}

function formatActiveSection(state: ContextState): string {
  return (
    `${ACTIVE_HEADING}\n` +
    "```json\n" +
    `${JSON.stringify(state, null, 2)}\n` +
    "```\n"
  );
}

function formatConflictsSection(items: ConflictItem[]): string {
  if (items.length === 0) return "";
  let body = `${CONFLICTS_HEADING}\n\n`;
  for (const item of items) {
    const peerLabel =
      item.peerVersion === null ? "(missing)" : String(item.peerVersion);
    body +=
      `### [${formatTimestamp(new Date(item.detectedAt))}] - [ACTION: COLLISION DETECTED]\n` +
      `A state merge conflict occurred.\n` +
      `- **Conflict ID:** \`${item.id}\`\n` +
      `- **Local Version:** ${item.localVersion}\n` +
      `- **Peer Attempted Version:** ${peerLabel}\n` +
      `Run the \`resolve_conflict\` tool to merge state.\n\n`;
  }
  return body;
}

function formatMigratedBlock(oldBody: string): string {
  const trimmed = oldBody.trim();
  if (!trimmed) return "";
  const ts = formatTimestamp(new Date());
  return (
    `### [${ts}] - [SOURCE: Local] - [ACTION: Migrated Phase 1 Log]\n\n` +
    trimmed
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n") +
    "\n\n"
  );
}

function findHeadingIndex(content: string, heading: string): number {
  const pattern = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m");
  const match = pattern.exec(content);
  return match?.index ?? -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Next structural heading after Active State (Conflicts or Audit). */
function nextSectionAfterActive(content: string, from: number): number {
  const slice = content.slice(from);
  const conflictsRel = findHeadingIndex(slice, CONFLICTS_HEADING);
  const auditRel = findHeadingIndex(slice, AUDIT_HEADING);
  const candidates = [conflictsRel, auditRel].filter((i) => i >= 0);
  if (candidates.length === 0) return -1;
  return from + Math.min(...candidates);
}

function sliceActiveSection(content: string): string | undefined {
  const start = findHeadingIndex(content, ACTIVE_HEADING);
  if (start < 0) return undefined;
  const afterHeading = start + ACTIVE_HEADING.length;
  const bodyStart = content.indexOf("\n", afterHeading);
  const from = bodyStart >= 0 ? bodyStart + 1 : afterHeading;
  const end = nextSectionAfterActive(content, from);
  if (end < 0) return content.slice(from);
  return content.slice(from, end);
}

function replaceActiveState(content: string, state: ContextState): string {
  const active = formatActiveSection(state);
  const titleIdx = findHeadingIndex(content, TITLE);
  const conflictsIdx = findHeadingIndex(content, CONFLICTS_HEADING);
  const auditIdx = findHeadingIndex(content, AUDIT_HEADING);

  const head =
    titleIdx >= 0
      ? content.slice(0, titleIdx) + `${TITLE}\n\n`
      : `${TITLE}\n\n`;

  // Preserve Conflicts (if any) + Audit Trail after Active State.
  let rest: string;
  if (conflictsIdx >= 0) {
    rest = content.slice(conflictsIdx);
  } else if (auditIdx >= 0) {
    rest = content.slice(auditIdx);
  } else {
    rest = `${AUDIT_HEADING}\n\n`;
  }

  return `${head}${active}\n${rest}`;
}

function rewriteConflictsSection(
  content: string,
  items: ConflictItem[],
): string {
  const activeIdx = findHeadingIndex(content, ACTIVE_HEADING);
  const conflictsIdx = findHeadingIndex(content, CONFLICTS_HEADING);
  const auditIdx = findHeadingIndex(content, AUDIT_HEADING);

  const before =
    activeIdx >= 0
      ? (() => {
          const end = nextSectionAfterActive(
            content,
            activeIdx + ACTIVE_HEADING.length,
          );
          return end >= 0 ? content.slice(0, end) : content.slice(0, auditIdx >= 0 ? auditIdx : undefined);
        })()
      : `${TITLE}\n\n${formatActiveSection({})}\n`;

  const audit =
    auditIdx >= 0 ? content.slice(auditIdx) : `${AUDIT_HEADING}\n\n`;

  const conflicts = formatConflictsSection(items);
  // Drop any previous Conflicts block by rebuilding from Active + new Conflicts + Audit.
  void conflictsIdx;
  return `${before.trimEnd()}\n\n${conflicts}${audit}`.replace(/\n{3,}/g, "\n\n");
}

function appendAuditEntry(content: string, entry: AuditEntry): string {
  const ts = formatTimestamp(new Date());
  let block: string;

  if (entry.action === "State Patch") {
    block =
      `### [${ts}] - [SOURCE: ${entry.source}] - [ACTION: State Patch]\n` +
      "```json\n" +
      `${JSON.stringify(entry.ops, null, 2)}\n` +
      "```\n\n";
  } else if (entry.action === "State Snapshot") {
    block =
      `### [${ts}] - [SOURCE: ${entry.source}] - [ACTION: State Snapshot]\n` +
      "- **Content:** Full Active State replaced from peer handshake.\n\n";
  } else if (entry.action === "Collision Detected") {
    const peerLabel =
      entry.peerVersion === null ? "(missing)" : String(entry.peerVersion);
    block =
      `### [${ts}] - [SOURCE: ${entry.source}] - [ACTION: COLLISION DETECTED]\n` +
      `A state merge conflict occurred.\n` +
      `- **Conflict ID:** \`${entry.conflictId}\`\n` +
      `- **Local Version:** ${entry.localVersion}\n` +
      `- **Peer Attempted Version:** ${peerLabel}\n` +
      `Run the \`resolve_conflict\` tool to merge state.\n\n`;
  } else if (entry.action === "Conflict Resolution") {
    block =
      `### [${ts}] - [SOURCE: ${entry.source}] - [ACTION: Conflict Resolution]\n` +
      `- **Strategy:** \`${entry.strategy}\`\n` +
      `- **Conflict ID:** \`${entry.conflictId}\`\n` +
      `- **Detail:** ${entry.detail}\n\n`;
  } else {
    block =
      `### [${ts}] - [SOURCE: ${entry.source}] - [ACTION: Message]\n` +
      "- **Content:**\n";
    for (const line of entry.text.split("\n")) {
      block += `> ${line}\n`;
    }
    block += "\n";
  }

  if (findHeadingIndex(content, AUDIT_HEADING) < 0) {
    return `${content.trimEnd()}\n\n${AUDIT_HEADING}\n\n${block}`;
  }
  return content.trimEnd() + "\n\n" + block;
}

function formatTimestamp(date: Date): string {
  const pad = (v: number) => String(v).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = join(
    dirname(filePath),
    `.p2pa-${process.pid}-${Date.now()}.tmp.md`,
  );
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

function readFileTailLines(filePath: string, lineCount: number): string {
  const fd = openSync(filePath, "r");
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return "";
    const window = Math.min(size, Math.max(lineCount * 200, 4096), 2 * 1024 * 1024);
    const start = size - window;
    const buf = Buffer.alloc(window);
    readSync(fd, buf, 0, window, start);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    const usable = start > 0 ? lines.slice(1) : lines;
    return usable.slice(Math.max(0, usable.length - lineCount)).join("\n");
  } finally {
    closeSync(fd);
  }
}
