/**
 * Smoke test for living-doc bridge (mock Google Docs — no network/keys).
 * Run: npm run smoke:doc
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import {
  DocBridge,
  STEERING_KEY,
  applyPublishToSections,
  parseSteeringValue,
} from "../src/doc/bridge.js";
import {
  MockGoogleDocsClient,
  documentUrl,
  extractDocumentId,
  hashText,
} from "../src/doc/google-docs-client.js";
import {
  appendAgentLogLine,
  buildDocTemplate,
  extractDocTitle,
  parseDocSections,
  serializeDocSections,
} from "../src/doc/template.js";

const LOG_DIR = "./logs/smoke-doc";
const LOG_PATH = `${LOG_DIR}/context.md`;

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  console.error(`${label}: ${cond ? "PASS" : "FAIL"}`);
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    throw new Error(`Assertion failed: ${label}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${label}`);
    }
    await sleep(50);
  }
}

function smokeTemplatePure(): void {
  console.error("[smoke:doc] --- template pure checks ---");

  const built = buildDocTemplate("Round Trip Mission");
  const parsed = parseDocSections(built);
  assert(parsed.status.includes("one-line mission status"), "template status body");
  assert(parsed.plan.includes("living plan"), "template plan body");
  assert(parsed.human.includes("humans:"), "template human body");
  assert(parsed.agent_log.includes("timestamped"), "template agent_log body");

  const title = extractDocTitle(built);
  assert(title === "Round Trip Mission", "extractDocTitle from template");

  const roundTrip = serializeDocSections(parsed, title);
  const again = parseDocSections(roundTrip);
  assert(again.status === parsed.status, "round-trip status");
  assert(again.plan === parsed.plan, "round-trip plan");
  assert(again.human === parsed.human, "round-trip human");
  assert(again.agent_log === parsed.agent_log, "round-trip agent_log");
  assert(extractDocTitle(roundTrip) === title, "round-trip title preserved");

  // CRLF + leading matter ignored before first heading
  const messy =
    "Preface ignored\r\n\r\n" +
    "## Status\r\n" +
    "Ready\r\n\r\n" +
    "## Plan\r\n" +
    "- step\r\n\r\n" +
    "## HUMAN directives\r\n" +
    "Steer me\r\n\r\n" +
    "## Agent log\r\n" +
    "log line\r\n";
  const messyParsed = parseDocSections(messy);
  assert(messyParsed.status === "Ready", "CRLF status parse");
  assert(messyParsed.plan === "- step", "CRLF plan parse");
  assert(messyParsed.human === "Steer me", "CRLF human parse");
  assert(messyParsed.agent_log === "log line", "CRLF agent_log parse");
  assert(extractDocTitle(messy) === "Preface ignored", "title from leading matter");

  // Heading-first doc falls back to default title
  const noTitle = "## Status\nOk\n\n## Plan\n-\n\n## HUMAN directives\n\n\n## Agent log\n";
  assert(extractDocTitle(noTitle) === "P2PA Mission", "default title when heading-first");

  const fixed = new Date("2026-07-23T12:00:00.000Z");
  const first = appendAgentLogLine("", "boot", fixed);
  assert(first === "[2026-07-23T12:00:00.000Z] boot", "appendAgentLogLine empty");
  const second = appendAgentLogLine(first, " next ", fixed);
  assert(
    second ===
      "[2026-07-23T12:00:00.000Z] boot\n[2026-07-23T12:00:00.000Z] next",
    "appendAgentLogLine appends + trims",
  );

  const applied = applyPublishToSections(parsed, "status", "  shipped  ");
  assert(applied.status === "shipped", "applyPublishToSections status trim");
  assert(applied.human === parsed.human, "applyPublishToSections leaves human");
}

function smokeClientHelpers(): void {
  console.error("[smoke:doc] --- client helper checks ---");

  assert(
    extractDocumentId("https://docs.google.com/document/d/abcDEF1234567890_-/edit") ===
      "abcDEF1234567890_-",
    "extractDocumentId from URL",
  );
  assert(
    extractDocumentId("abcDEF1234567890_abcdef") === "abcDEF1234567890_abcdef",
    "extractDocumentId bare id",
  );
  assert(extractDocumentId("not-a-doc") === null, "extractDocumentId rejects short");
  assert(documentUrl("mock-1") === "https://docs.google.com/document/d/mock-1/edit", "documentUrl");
  assert(hashText("a") === hashText("a"), "hashText stable");
  assert(hashText("a") !== hashText("b"), "hashText distinguishes");
}

async function smokeBridge(): Promise<void> {
  console.error("[smoke:doc] --- bridge mock checks ---");

  rmSync(LOG_DIR, { recursive: true, force: true });
  mkdirSync(LOG_DIR, { recursive: true });

  const store = new ContextStore();
  const log = new MarkdownLog(LOG_PATH);
  log.ensureInitialized();

  const client = new MockGoogleDocsClient();
  const created = await client.createDoc("Smoke Mission");
  await client.shareAnyoneWriter(created.documentId);
  assert(client.shared.has(created.documentId), "mock shareAnyoneWriter recorded");

  const bridge = new DocBridge({
    documentId: created.documentId,
    url: created.url,
    client,
    services: { store, log },
    pollIntervalMs: 200,
  });
  bridge.start();

  const statusStarted = bridge.getStatus();
  assert(statusStarted.linked === true, "getStatus linked");
  assert(statusStarted.polling === true, "getStatus polling while started");
  assert(statusStarted.documentId === created.documentId, "getStatus documentId");

  // Empty publish rejected
  let emptyThrew = false;
  try {
    await bridge.publish("status", "   ");
  } catch {
    emptyThrew = true;
  }
  assert(emptyThrew, "publish rejects empty content");

  // Outbound: publish status + plan + agent_log; HUMAN must stay intact.
  await bridge.publish("status", "Building auth");
  await bridge.publish("plan", "- auth\n- tests");
  await bridge.publish("agent_log", "Started smoke test");
  await bridge.publish("agent_log", "Second log line");

  const afterPublish = (await client.getDocument(created.documentId)).plainText;
  const sections = parseDocSections(afterPublish);
  assert(sections.status === "Building auth", "outbound status update");
  assert(sections.plan === "- auth\n- tests", "outbound plan update");
  assert(sections.agent_log.includes("Started smoke test"), "outbound agent_log first");
  assert(sections.agent_log.includes("Second log line"), "outbound agent_log second");
  assert(sections.human.includes("humans:"), "HUMAN section preserved by publish");
  console.error("[smoke:doc] outbound publish ok");

  // Wait for initial poll of template HUMAN (steering seed)
  await waitFor(
    () => parseSteeringValue(store.get(STEERING_KEY)) !== null,
    5_000,
    "initial steering from template HUMAN",
  );
  const hashAfterSeed = store.stateHash();
  assert(hashAfterSeed.length > 0, "state hashed after seed steering");

  // Inbound: simulate human edit → steering via commitLocalMutation
  const title = extractDocTitle(afterPublish);
  const next = serializeDocSections(
    {
      ...sections,
      human: "Do not touch billing.\nShip auth Friday.",
    },
    title,
  );
  client.simulateHumanEdit(created.documentId, next);

  await waitFor(
    () => {
      const s = bridge.readSteering();
      return s !== null && s.text.includes("Do not touch billing");
    },
    5_000,
    "steering text after human edit",
  );

  const steering = bridge.readSteering();
  assert(
    steering !== null && steering.text.includes("Do not touch billing"),
    "inbound steering text",
  );
  assert(store.stateHash() !== hashAfterSeed, "state changed after human steering");

  const md = readFileSync(LOG_PATH, "utf8");
  assert(md.includes("Do not touch billing"), "Active State markdown has steering");

  // Unchanged HUMAN must not bump version again
  const hashStable = store.stateHash();
  await sleep(500);
  assert(store.stateHash() === hashStable, "unchanged HUMAN does not re-commit");

  // Force refresh path
  const refreshed = await bridge.refreshSteering();
  assert(
    refreshed !== null &&
      steering !== null &&
      refreshed.docRevision === steering.docRevision,
    "refreshSteering same revision",
  );

  const okStatus = bridge.getStatus();
  assert(okStatus.lastPollOk === true, "getStatus lastPollOk after success");
  assert(okStatus.lastHumanHash === hashText(steering!.text), "getStatus lastHumanHash");

  // Revision conflict: one forced conflict then retry succeeds
  client.forceConflictOnce = true;
  await bridge.publish("status", "After conflict retry");
  const afterConflict = parseDocSections(
    (await client.getDocument(created.documentId)).plainText,
  );
  assert(
    afterConflict.status === "After conflict retry",
    "publish retries on revision conflict",
  );
  assert(
    afterConflict.human.includes("Do not touch billing"),
    "HUMAN preserved across conflict retry",
  );

  bridge.stop();
  assert(bridge.getStatus().polling === false, "getStatus polling false after stop");

  // Restart: same HUMAN must not bump _version again
  const hashBeforeRestart = store.stateHash();
  const bridge2 = new DocBridge({
    documentId: created.documentId,
    url: created.url,
    client,
    services: { store, log },
    pollIntervalMs: 200,
  });
  bridge2.start();
  await sleep(500);
  assert(
    store.stateHash() === hashBeforeRestart,
    "restart does not re-commit identical steering",
  );
  bridge2.stop();

  console.error("[smoke:doc] inbound steering ok");
}

async function main(): Promise<void> {
  smokeTemplatePure();
  smokeClientHelpers();
  await smokeBridge();
  console.error(`[smoke:doc] PASS (${passed} assertions, ${failed} failed)`);
}

main().catch((err: unknown) => {
  console.error(`[smoke:doc] FAIL (${passed} passed before failure)`, err);
  process.exit(1);
});
