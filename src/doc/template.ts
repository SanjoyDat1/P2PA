/**
 * Living-doc section template and plain-text parsers.
 * Heading strings are exact — the bridge depends on them.
 */

export const DOC_HEADING_STATUS = "## Status";
export const DOC_HEADING_PLAN = "## Plan";
export const DOC_HEADING_HUMAN = "## HUMAN directives";
export const DOC_HEADING_AGENT_LOG = "## Agent log";

export const DOC_SECTION_HEADINGS = [
  DOC_HEADING_STATUS,
  DOC_HEADING_PLAN,
  DOC_HEADING_HUMAN,
  DOC_HEADING_AGENT_LOG,
] as const;

export type DocSectionId = "status" | "plan" | "human" | "agent_log";

export const SECTION_HEADING: Record<DocSectionId, string> = {
  status: DOC_HEADING_STATUS,
  plan: DOC_HEADING_PLAN,
  human: DOC_HEADING_HUMAN,
  agent_log: DOC_HEADING_AGENT_LOG,
};

export interface DocSections {
  status: string;
  plan: string;
  human: string;
  agent_log: string;
}

/** Initial body written by `p2pa doc create`. */
export function buildDocTemplate(title = "P2PA Mission"): string {
  return (
    `${title}\n\n` +
    `${DOC_HEADING_STATUS}\n` +
    `(agents update — one-line mission status)\n\n` +
    `${DOC_HEADING_PLAN}\n` +
    `- (agents update living plan)\n\n` +
    `${DOC_HEADING_HUMAN}\n` +
    `(humans: append steering directives here — anyone with the link can edit)\n\n` +
    `${DOC_HEADING_AGENT_LOG}\n` +
    `(agents append timestamped updates below)\n`
  );
}

/**
 * Split plain-text doc into section bodies (text under each heading, trim).
 * Unknown leading matter before the first heading is ignored.
 */
export function parseDocSections(plainText: string): DocSections {
  const lines = plainText.replace(/\r\n/g, "\n").split("\n");
  const buckets: Record<DocSectionId, string[]> = {
    status: [],
    plan: [],
    human: [],
    agent_log: [],
  };

  let current: DocSectionId | null = null;
  for (const line of lines) {
    const id = headingToSectionId(line.trim());
    if (id !== null) {
      current = id;
      continue;
    }
    if (current !== null) {
      buckets[current].push(line);
    }
  }

  return {
    status: trimSectionBody(buckets.status),
    plan: trimSectionBody(buckets.plan),
    human: trimSectionBody(buckets.human),
    agent_log: trimSectionBody(buckets.agent_log),
  };
}

function headingToSectionId(line: string): DocSectionId | null {
  for (const [id, heading] of Object.entries(SECTION_HEADING) as [
    DocSectionId,
    string,
  ][]) {
    if (line === heading) return id;
  }
  return null;
}

function trimSectionBody(lines: string[]): string {
  // Drop a single trailing empty line from the join, keep intentional blanks.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }
  while (lines.length > 0 && lines[0] === "") {
    lines = lines.slice(1);
  }
  return lines.join("\n");
}

/** Rebuild full plain text from sections (stable heading order). */
export function serializeDocSections(
  sections: DocSections,
  title = "P2PA Mission",
): string {
  return (
    `${title}\n\n` +
    `${DOC_HEADING_STATUS}\n` +
    `${sections.status}\n\n` +
    `${DOC_HEADING_PLAN}\n` +
    `${sections.plan}\n\n` +
    `${DOC_HEADING_HUMAN}\n` +
    `${sections.human}\n\n` +
    `${DOC_HEADING_AGENT_LOG}\n` +
    `${sections.agent_log}\n`
  );
}

/** Extract a title from the first non-empty line if it is not a heading. */
export function extractDocTitle(plainText: string): string {
  const first = plainText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first || headingToSectionId(first) !== null) {
    return "P2PA Mission";
  }
  return first;
}

export function appendAgentLogLine(
  existingLog: string,
  content: string,
  at: Date = new Date(),
): string {
  const stamp = at.toISOString();
  const line = `[${stamp}] ${content.trim()}`;
  if (existingLog.trim().length === 0) return line;
  return `${existingLog.trimEnd()}\n${line}`;
}
