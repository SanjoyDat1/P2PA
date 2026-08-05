import {
  constants,
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
import type { TaskView } from "./task.js";
import type {
  AuditEntry,
  AuditPeer,
  ContentionItem,
  ContextState,
  Source,
} from "./types.js";

/**
 * Audit entries kept in the live file.
 *
 * The whole document is re-rendered on every mutation, so an audit trail that
 * grows without limit makes each write proportional to the entire history —
 * the cost climbs quietly until the node is slow for reasons nobody can see.
 * Older entries move to a sidecar instead of being discarded, so the record is
 * still complete.
 */
export const MAX_AUDIT_ENTRIES = 200;

/** Entries trimmed per write, so one write never does an unbounded amount. */
export const MAX_ARCHIVE_BATCH = 500;

/**
 * Byte budget for the live audit section.
 *
 * Counting entries is not enough: a single peer message may be up to
 * MAX_PAYLOAD_BYTES, so 200 large entries would leave a file hundreds of
 * megabytes wide that is re-read and re-written on every mutation.
 */
export const MAX_AUDIT_BYTES = 256 * 1024;

/** Message text kept in an audit entry. The full text stays in the outbox log. */
export const MAX_AUDIT_TEXT = 4_000;

/**
 * Rows rendered in the backlog table.
 *
 * The file is re-rendered whole on every mutation, so an unbounded table makes
 * every write proportional to the entire backlog — the same reasoning that
 * bounds the audit section. The trailing count line is always rendered, so a
 * reader can never mistake a truncated board for the whole one.
 */
export const MAX_BACKLOG_ROWS = 200;

const TITLE = "# P2PA Shared Context";
const ACTIVE_HEADING = "## Active State";
const REPLICA_HEADING = "## Replica State";
const CLAIMS_HEADING = "## Claims";
const BACKLOG_HEADING = "## Backlog";
const CONFLICTS_HEADING = "## Concurrent Updates";
const AUDIT_HEADING = "## Audit Trail";

/**
 * Sectioned Markdown persistence:
 * - ## Active State       — plain JSON view, for humans and for `git diff`
 * - ## Replica State      — the same document plus per-key CRDT stamps
 * - ## Claims             — live leases, rewritten from the CRDT document
 * - ## Backlog            — the task board, rewritten from the CRDT document
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
    parts.audit = this.rotateAudit(parts.audit);
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

  /** Where trimmed audit entries go. Append-only, so rotation stays cheap. */
  get archivePath(): string {
    return this.filePath.replace(/\.md$/, "") + ".archive.md";
  }

  /**
   * Move the oldest entries to the archive once the live section is full.
   *
   * Appending to the sidecar is O(what moved) rather than O(history), which is
   * the whole point — the live file is what gets rewritten on every mutation.
   */
  private rotateAudit(audit: string): string {
    const entries = splitAuditEntries(audit);
    if (
      entries.length <= MAX_AUDIT_ENTRIES &&
      byteLength(entries) <= MAX_AUDIT_BYTES
    ) {
      return audit;
    }

    let overflow = Math.min(
      entries.length - MAX_AUDIT_ENTRIES,
      MAX_ARCHIVE_BATCH,
    );
    // Then keep trimming until the remainder also fits the byte budget.
    while (
      overflow < entries.length - 1 &&
      overflow < MAX_ARCHIVE_BATCH &&
      byteLength(entries.slice(overflow)) > MAX_AUDIT_BYTES
    ) {
      overflow += 1;
    }
    const moved = entries.slice(0, overflow);
    const kept = entries.slice(overflow);

    try {
      appendEntries(this.archivePath, `${moved.join("\n\n")}\n\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Losing history is worse than an oversized file, so keep the entries.
      console.error(`[markdown] could not archive audit entries: ${message}`);
      return audit;
    }
    // Say so in the file, so a reader can see history was moved rather than lost.
    return `${ROTATION_MARKER}\n\n${kept.join("\n\n")}`;
  }

  /** Rewrite ## Claims from the live leases (omit the section when empty). */
  rewriteClaims(views: ClaimView[]): void {
    this.ensureInitialized();
    const parts = readParts(readFileSync(this.filePath, "utf8"));
    parts.claims = formatClaims(views).trim();
    atomicWrite(this.filePath, renderDoc(parts));
  }

  /** Rewrite ## Backlog from the task board (omit the section when empty). */
  rewriteBacklog(views: TaskView[]): void {
    this.ensureInitialized();
    const parts = readParts(readFileSync(this.filePath, "utf8"));
    parts.backlog = formatBacklog(views).trim();
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
    backlog: "",
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

/**
 * The board a human reads.
 *
 * Every interpolated string — task id, title, capability tokens, dependency ids,
 * holder — is peer-authored and goes through `safe()`, which strips `|`,
 * backticks, `#`, brackets and control characters. Without it a title can forge
 * a table row, or open a `##` heading that the section parser then reads as a
 * boundary and silently truncates the file's history at.
 */
function formatBacklog(views: TaskView[]): string {
  if (views.length === 0) return "";
  const shown = views.slice(0, MAX_BACKLOG_ROWS);
  let body =
    "| Task | Status | Pri | Needs | Waiting on | Holder | Title |\n" +
    "| --- | --- | --- | --- | --- | --- | --- |\n";
  for (const view of shown) {
    const needs =
      view.needs.length > 0
        ? view.needs.map((need) => `\`${safe(need)}\``).join(" ")
        : "—";
    const waiting =
      view.blockedBy.length > 0
        ? view.blockedBy.map((dep) => `\`${safe(dep)}\``).join(" ")
        : "—";
    const holder = view.holder === null ? "—" : `\`${safe(view.holder)}\``;
    body +=
      `| \`${safe(view.taskId)}\` | ${safe(view.status)} | ${view.priority} | ` +
      `${needs} | ${waiting} | ${holder} | ${safe(view.title)} |\n`;
  }
  return `${body}\nshowing ${shown.length} of ${views.length} tasks\n`;
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
  BACKLOG_HEADING,
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
  backlog: string;
  contention: string;
  audit: string;
}

/**
 * A file written before the backlog existed simply has no `## Backlog` heading,
 * so it reads as `""` and the section is omitted until there is something to put
 * in it. `sliceSection` is heading-order-independent, so nothing needs migrating.
 */
function readParts(content: string): DocParts {
  return {
    active: sliceSection(content, ACTIVE_HEADING)?.trim() ?? jsonBlock({}),
    replica: sliceSection(content, REPLICA_HEADING)?.trim() ?? replicaBlock([]),
    claims: sliceSection(content, CLAIMS_HEADING)?.trim() ?? "",
    backlog: sliceSection(content, BACKLOG_HEADING)?.trim() ?? "",
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
  if (parts.backlog.length > 0) {
    out += `${BACKLOG_HEADING}\n\n${parts.backlog}\n\n`;
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

/**
 * Split an audit body into whole entries.
 *
 * Entries begin with a `### [` heading and may span several lines, so this
 * cannot be a line split — and peer-supplied text is sanitized upstream
 * precisely so it cannot forge one of these boundaries.
 */
const ROTATION_MARKER =
  "<!-- older entries moved to shared_context.archive.md -->";

function byteLength(entries: string[]): number {
  let total = 0;
  for (const entry of entries) total += Buffer.byteLength(entry, "utf8") + 2;
  return total;
}

function splitAuditEntries(audit: string): string[] {
  const trimmed = audit.trim();
  if (trimmed.length === 0) return [];
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of trimmed.split("\n")) {
    // The marker is regenerated on each rotation; never carry it forward.
    if (line === ROTATION_MARKER) continue;
    if (line.startsWith("### [") && current.length > 0) {
      entries.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) entries.push(current.join("\n").trim());
  return entries.filter((entry) => entry.length > 0);
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

  if (entry.action === "Task Created") {
    const needs =
      entry.needs.length > 0
        ? entry.needs.map((need) => `\`${safe(need)}\``).join(", ")
        : "(none)";
    const deps =
      entry.deps.length > 0
        ? entry.deps.map((dep) => `\`${safe(dep)}\``).join(", ")
        : "(none)";
    return (
      `${head} - [ACTION: Task Created]\n` +
      `- **Task:** \`${safe(entry.taskId)}\`\n` +
      `- **Title:** ${safe(entry.title)}\n` +
      `- **Priority:** ${entry.priority} · **Needs:** ${needs} · **Waiting on:** ${deps}\n`
    );
  }
  if (entry.action === "Task Settled") {
    return (
      `${head} - [ACTION: Task Settled]\n` +
      `- **Task:** \`${safe(entry.taskId)}\`\n` +
      `- **Outcome:** ${safe(entry.status)} (attempt ${entry.attempt})\n` +
      `- **Settled by:** \`${safe(entry.settledBy)}\`\n` +
      (entry.detail !== undefined ? `- **Detail:** ${safe(entry.detail)}\n` : "")
    );
  }

  let block = `${head} - [ACTION: Message]\n- **Content:**\n`;
  // Truncated: an entry is a summary for a human reading the file, and a peer
  // may send up to a megabyte at a time.
  const text =
    entry.text.length > MAX_AUDIT_TEXT
      ? `${entry.text.slice(0, MAX_AUDIT_TEXT)} …[truncated]`
      : entry.text;
  for (const line of text.split(/\r\n|\r|\n|\u2028|\u2029/)) {
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

/**
 * Append to the archive without following a symlink.
 *
 * `resolveContextFile` refuses a symlinked context file, but the sidecar name is
 * derived by string surgery and never went through it — so a planted
 * `shared_context.archive.md` symlink would redirect the append anywhere the
 * user can write.
 */
function appendEntries(filePath: string, body: string): void {
  const fd = openSync(filePath, appendFlags(), 0o600);
  try {
    writeFileSync(fd, body, "utf8");
  } finally {
    closeSync(fd);
  }
}

function appendFlags(): number {
  const { O_APPEND, O_CREAT, O_WRONLY, O_NOFOLLOW } = constants;
  return O_APPEND | O_CREAT | O_WRONLY | (O_NOFOLLOW ?? 0);
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
