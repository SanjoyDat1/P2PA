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
import type { CrdtOp } from "./crdt.js";
import { sanitizeLabel } from "./peer-key.js";
import type { ClaimView } from "./claim.js";
import type {
  AuditEntry,
  AuditPeer,
  ContentionItem,
  ContextState,
  Source,
} from "./types.js";

const TITLE = "# P2PA Shared Context";
const ACTIVE_HEADING = "## Active State";
const REPLICA_HEADING = "## Replica State";
const CLAIMS_HEADING = "## Claims";
const CONFLICTS_HEADING = "## Concurrent Updates";
const AUDIT_HEADING = "## Audit Trail";

/**
 * Sectioned Markdown persistence:
 * - ## Active State       — plain JSON view, for humans and for `git diff`
 * - ## Replica State      — the same document plus per-key CRDT stamps
 * - ## Concurrent Updates — rewritten from the in-memory contention log
 * - ## Audit Trail        — append-only update / message / override history
 *
 * Active State stays first and stays plain because it is the part people read.
 * Replica State carries the stamps that make merge deterministic: without them
 * a restart would re-stamp every key with a fresh clock and a peer holding
 * older writes could beat state it had already lost to.
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

    // The contention log is memory-only — drop any stale section once on boot.
    if (!this.staleConflictsCleared) {
      this.staleConflictsCleared = true;
      const parts = readParts(existing);
      parts.contention = "";
      atomicWrite(this.filePath, renderDoc(parts));
    }
  }

  syncMarkdownLog(
    entry: AuditEntry,
    state?: ContextState,
    replica?: CrdtOp[],
  ): void {
    this.ensureInitialized();
    const parts = readParts(readFileSync(this.filePath, "utf8"));
    if (state !== undefined) parts.active = jsonBlock(state);
    if (replica !== undefined) parts.replica = replicaBlock(replica);
    parts.audit = `${parts.audit}\n\n${renderAuditEntry(entry)}`.trim();
    atomicWrite(this.filePath, renderDoc(parts));
  }

  /**
   * Persist a state change.
   *
   * `replica` should be supplied whenever state moved — the plain view alone
   * cannot be rehydrated without losing every stamp.
   */
  syncStateUpdate(
    source: Source,
    keys: string[],
    state: ContextState,
    replica?: CrdtOp[],
    peer?: AuditPeer,
  ): void {
    this.syncMarkdownLog(
      { source, peer, action: "State Update", keys },
      state,
      replica,
    );
  }

  syncMessage(source: Source, text: string, peer?: AuditPeer): void {
    this.syncMarkdownLog({ source, peer, action: "Message", text });
  }

  syncSnapshot(
    source: Source,
    applied: number,
    ignored: number,
    peer?: AuditPeer,
    state?: ContextState,
    replica?: CrdtOp[],
  ): void {
    this.syncMarkdownLog(
      { source, peer, action: "State Snapshot", applied, ignored },
      state,
      replica,
    );
  }

  /** Rewrite ## Claims from the live leases (omit the section when empty). */
  rewriteClaims(views: ClaimView[]): void {
    this.ensureInitialized();
    const parts = readParts(readFileSync(this.filePath, "utf8"));
    parts.claims = formatClaims(views).trim();
    atomicWrite(this.filePath, renderDoc(parts));
  }

  /** Rewrite ## Concurrent Updates (omit the section when empty). */
  rewriteContention(items: ContentionItem[]): void {
    this.ensureInitialized();
    const parts = readParts(readFileSync(this.filePath, "utf8"));
    parts.contention = formatContentionItems(items).trim();
    atomicWrite(this.filePath, renderDoc(parts));
  }

  readActiveState(): ContextState {
    if (!existsSync(this.filePath)) return {};
    const content = readFileSync(this.filePath, "utf8");
    const section = sliceSection(content, ACTIVE_HEADING);
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

  /**
   * Stamped entries from the last run.
   *
   * Empty for a document written by the retired counter protocol; the caller
   * falls back to `readActiveState` and re-stamps, which is safe because those
   * documents carry no causal history to preserve.
   */
  readReplicaState(): CrdtOp[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf8");
    const section = sliceSection(content, REPLICA_HEADING);
    if (section === undefined) return [];

    const start = section.indexOf("[");
    const end = section.lastIndexOf("]");
    if (start < 0 || end < start) return [];

    try {
      const parsed: unknown = JSON.parse(section.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed as CrdtOp[];
    } catch {
      console.error(
        "[markdown] failed to parse Replica State JSON; re-stamping from Active State",
      );
    }
    return [];
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
  return renderDoc({
    active: jsonBlock(state),
    replica: replicaBlock([]),
    claims: "",
    contention: "",
    audit: "",
  });
}

function jsonBlock(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function replicaBlock(ops: CrdtOp[]): string {
  return (
    "<!-- CRDT stamps. Machine-managed; edit Active State instead. -->\n" +
    "```json\n" +
    JSON.stringify(ops) +
    "\n```"
  );
}

function formatClaims(views: ClaimView[]): string {
  const live = views.filter((view) => view.held);
  if (live.length === 0) return "";
  let body = "| Task | Holder | Expires | Note |\n| --- | --- | --- | --- |\n";
  for (const view of live) {
    body +=
      `| \`${safe(view.taskId)}\` | \`${safe(view.holder)}\` | ` +
      `${safe(view.expiresAt)} | ${view.note ? safe(view.note) : "—"} |\n`;
  }
  return body;
}

function formatContentionItems(items: ContentionItem[]): string {
  if (items.length === 0) return "";
  let body = "";
  for (const item of items) {
    const from =
      item.peerFingerprint === null ? "a local write" : `peer ${safe(item.peerFingerprint)}`;
    body +=
      `### [${formatTimestamp(new Date(item.detectedAt))}] - [ACTION: Concurrent Update]\n` +
      `\`${safe(item.key)}\` was last written by node \`${safe(item.previousNode)}\` and was ` +
      `overwritten by ${from}. Both replicas resolved this the same way, so no ` +
      `action is required; use \`override_context\` to impose a different value.\n` +
      `- **Entry ID:** \`${item.id}\`\n\n`;
  }
  return body;
}

function formatMigratedBlock(oldBody: string): string {
  const trimmed = oldBody.trim();
  if (!trimmed) return "";
  const ts = formatTimestamp(new Date());
  return (
    `### [${ts}] - [SOURCE: Local] - [ACTION: Migrated Log]\n\n` +
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

/** Every heading this document may contain, so bodies can be delimited. */
const SECTION_HEADINGS = [
  ACTIVE_HEADING,
  REPLICA_HEADING,
  CLAIMS_HEADING,
  CONFLICTS_HEADING,
  AUDIT_HEADING,
] as const;

/**
 * Body of one section, delimited by whichever known heading comes next.
 *
 * Index arithmetic against a fixed section order broke as soon as a section was
 * added; this only assumes the headings are distinct.
 */
function sliceSection(content: string, heading: string): string | undefined {
  const start = findHeadingIndex(content, heading);
  if (start < 0) return undefined;

  const afterHeading = start + heading.length;
  const newline = content.indexOf("\n", afterHeading);
  const from = newline >= 0 ? newline + 1 : afterHeading;

  let end = -1;
  for (const other of SECTION_HEADINGS) {
    if (other === heading) continue;
    const relative = findHeadingIndex(content.slice(from), other);
    if (relative < 0) continue;
    const absolute = from + relative;
    if (end < 0 || absolute < end) end = absolute;
  }
  return end < 0 ? content.slice(from) : content.slice(from, end);
}

interface DocParts {
  active: string;
  replica: string;
  claims: string;
  contention: string;
  audit: string;
}

function readParts(content: string): DocParts {
  return {
    active: sliceSection(content, ACTIVE_HEADING)?.trim() ?? jsonBlock({}),
    replica: sliceSection(content, REPLICA_HEADING)?.trim() ?? replicaBlock([]),
    claims: sliceSection(content, CLAIMS_HEADING)?.trim() ?? "",
    contention: sliceSection(content, CONFLICTS_HEADING)?.trim() ?? "",
    audit: sliceSection(content, AUDIT_HEADING)?.trim() ?? "",
  };
}

function renderDoc(parts: DocParts): string {
  let out = `${TITLE}\n\n`;
  out += `${ACTIVE_HEADING}\n${parts.active}\n\n`;
  out += `${REPLICA_HEADING}\n${parts.replica}\n\n`;
  if (parts.claims.length > 0) {
    out += `${CLAIMS_HEADING}\n\n${parts.claims}\n\n`;
  }
  if (parts.contention.length > 0) {
    out += `${CONFLICTS_HEADING}\n\n${parts.contention}\n\n`;
  }
  out += `${AUDIT_HEADING}\n\n`;
  if (parts.audit.length > 0) out += `${parts.audit}\n`;
  return out;
}

/**
 * Render the SOURCE field, including which peer acted when known:
 *   `Local` · `Peer` · `Peer a3f9c1b2` · `Peer a3f9c1b2 (sanjoy-laptop)`
 *
 * Labels are sanitized upstream (`peer-key.ts`), so they cannot inject Markdown
 * structure or line breaks into the audit trail.
 */
function formatSource(entry: AuditEntry): string {
  if (entry.source !== "Peer" || !entry.peer) return entry.source;
  const { fingerprint, label } = entry.peer;
  const suffix = label ? ` (${safe(label)})` : "";
  return `Peer ${safe(fingerprint)}${suffix}`;
}

/**
 * Anything peer-controlled that lands in the audit trail goes through here.
 *
 * Keys, refusal reasons and node ids all originate on the wire. Interpolated
 * raw they can open a second `###` heading — forging an entry attributed to
 * Local — or inject a `##` section heading, which the section parser then reads
 * as a boundary and silently truncates history at.
 */
function safe(value: string): string {
  return sanitizeLabel(value);
}

function renderAuditEntry(entry: AuditEntry): string {
  const ts = formatTimestamp(new Date());
  const head = `### [${ts}] - [SOURCE: ${formatSource(entry)}]`;

  if (entry.action === "State Update") {
    return (
      `${head} - [ACTION: State Update]\n` +
      `- **Keys:** ${entry.keys.map((k) => `\`${safe(k)}\``).join(", ")}\n`
    );
  }
  if (entry.action === "State Snapshot") {
    return (
      `${head} - [ACTION: State Snapshot]\n` +
      `- **Merged:** ${entry.applied} key(s) applied, ${entry.ignored} already current.\n`
    );
  }
  if (entry.action === "Concurrent Update") {
    return (
      `${head} - [ACTION: Concurrent Update]\n` +
      `- **Key:** \`${safe(entry.key)}\`\n` +
      `- **Previously written by:** \`${safe(entry.previousNode)}\`\n` +
      `- **Resolution:** settled by stamp order; identical on every replica.\n`
    );
  }
  if (entry.action === "Override") {
    return (
      `${head} - [ACTION: Override]\n` +
      `- **Keys:** ${entry.keys.map((k) => `\`${safe(k)}\``).join(", ")}\n` +
      `- **Detail:** ${safe(entry.detail)}\n`
    );
  }
  if (entry.action === "Rejected Update") {
    return (
      `${head} - [ACTION: Rejected Update]\n` +
      `- **Reason:** ${safe(entry.reason)}\n` +
      `- **Keys:** ${entry.keys.map((k) => `\`${safe(k)}\``).join(", ") || "(none)"}\n`
    );
  }

  if (entry.action === "Claim") {
    return (
      `${head} - [ACTION: Claim]\n` +
      `- **Task:** \`${safe(entry.taskId)}\`\n` +
      `- **Holder:** \`${safe(entry.holder)}\` (generation ${entry.generation})\n` +
      `- **Expires:** ${safe(entry.expiresAt)}\n`
    );
  }
  if (entry.action === "Release") {
    return (
      `${head} - [ACTION: Release]\n` +
      `- **Task:** \`${safe(entry.taskId)}\`\n` +
      `- **Holder:** \`${safe(entry.holder)}\` (generation ${entry.generation})\n`
    );
  }

  let block = `${head} - [ACTION: Message]\n- **Content:**\n`;
  for (const line of entry.text.split(/\r\n|\r|\n|\u2028|\u2029/)) {
    block += `> ${line}\n`;
  }
  return block;
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
