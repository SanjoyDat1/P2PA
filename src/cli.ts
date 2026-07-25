#!/usr/bin/env node
/**
 * p2pa — global CLI (Phase 5)
 *
 * Commands:
 *   start [--topic]  Start background Hyperswarm daemon via PM2
 *   stop             Stop the daemon
 *   status           Show daemon + topic status
 *   log              Tail ~/.p2pa/shared_context.md
 *   connect          Print MCP JSON config for Cursor / Claude Desktop
 *   mcp              Run foreground MCP+P2P server (stdio — for agents)
 *   pair [token]     Print your invite token, or accept a peer's
 *   peers            List allowlisted peers (peers remove <x> to revoke)
 *   auth <mode>      Set connection policy: strict | open
 *   doc create|link|unlink|status  Google Docs living-doc bridge
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, createReadStream, statSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  DAEMON_NAME,
  addPeer,
  clearDocLink,
  ensureConfigDir,
  ensureTopic,
  getConfigDir,
  getDaemonErrorLogPath,
  getDaemonOutLogPath,
  getSharedContextPath,
  listPeers,
  readConfig,
  removePeer,
  resolveAuthMode,
  setAuthMode,
  setDocLink,
  writeTopicPreservingRest,
  type AuthMode,
} from "./config.js";
import { loadOrCreateIdentity, setIdentityLabel } from "./identity.js";
import { decodeInvite, encodeInvite } from "./invite.js";
import { shortFingerprint } from "./peer-key.js";
import {
  createGoogleDocsClientFromEnv,
  documentUrl,
  extractDocumentId,
} from "./doc/google-docs-client.js";

const require = createRequire(import.meta.url);
const pm2 = require("pm2") as {
  connect: (cb: (err: Error | null) => void) => void;
  disconnect: () => void;
  start: (
    opts: Record<string, unknown>,
    cb: (err: Error | null, proc: unknown) => void,
  ) => void;
  stop: (name: string, cb: (err: Error | null) => void) => void;
  delete: (name: string, cb: (err: Error | null) => void) => void;
  describe: (
    name: string,
    cb: (err: Error | null, desc: Pm2ProcessDescription[]) => void,
  ) => void;
};

interface Pm2ProcessDescription {
  name?: string;
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    restart_time?: number;
  };
  monit?: { memory?: number; cpu?: number };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INDEX_SCRIPT = join(__dirname, "index.js");

function pm2Connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => (err ? reject(err) : resolve()));
  });
}

function pm2Start(opts: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.start(opts, (err) => (err ? reject(err) : resolve()));
  });
}

function pm2Stop(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.stop(name, (err) => (err ? reject(err) : resolve()));
  });
}

function pm2Delete(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.delete(name, (err) => {
      if (err && !/not found|doesn't exist/i.test(err.message)) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function pm2Describe(name: string): Promise<Pm2ProcessDescription[]> {
  return new Promise((resolve, reject) => {
    pm2.describe(name, (err, desc) => (err ? reject(err) : resolve(desc ?? [])));
  });
}

async function withPm2<T>(fn: () => Promise<T>): Promise<T> {
  await pm2Connect();
  try {
    return await fn();
  } finally {
    pm2.disconnect();
  }
}

function resolveP2paCommand(): { command: string; argsPrefix: string[] } {
  try {
    const which = execFileSync("/bin/sh", ["-c", "command -v p2pa"], {
      encoding: "utf8",
    }).trim();
    if (which.length > 0) {
      return { command: which, argsPrefix: [] };
    }
  } catch {
    // not on PATH
  }
  return {
    command: process.execPath,
    argsPrefix: [fileURLToPath(import.meta.url)],
  };
}

async function cmdStart(topicArg?: string): Promise<void> {
  ensureConfigDir();
  if (!existsSync(INDEX_SCRIPT)) {
    throw new Error(
      `Missing ${INDEX_SCRIPT}. Run \`npm run build\` first (or reinstall the package).`,
    );
  }

  const { topic, generated } = ensureTopic(topicArg);

  await withPm2(async () => {
    await pm2Delete(DAEMON_NAME);
    await pm2Start({
      name: DAEMON_NAME,
      script: INDEX_SCRIPT,
      interpreter: process.execPath,
      cwd: getConfigDir(),
      env: {
        P2PA_DAEMON: "1",
        P2PA_CONFIG_DIR: getConfigDir(),
        PATH: process.env["PATH"],
        HOME: process.env["HOME"],
        USER: process.env["USER"],
        TMPDIR: process.env["TMPDIR"],
        ...(process.env["P2PA_GOOGLE_SA_JSON"] &&
        !process.env["P2PA_GOOGLE_SA_JSON"].trim().startsWith("{")
          ? { P2PA_GOOGLE_SA_JSON: process.env["P2PA_GOOGLE_SA_JSON"] }
          : {}),
        ...(process.env["P2PA_DOC_POLL_MS"]
          ? { P2PA_DOC_POLL_MS: process.env["P2PA_DOC_POLL_MS"] }
          : {}),
      },
      out_file: getDaemonOutLogPath(),
      error_file: getDaemonErrorLogPath(),
      log_date_format: "",
      time: false,
      autorestart: true,
      max_restarts: 10,
      merge_logs: true,
      instances: 1,
      exec_mode: "fork",
    });
  });

  process.stdout.write(
    `✓ p2pa daemon started (${DAEMON_NAME})\n` +
      `  config:  ${getConfigDir()}\n` +
      `  context: ${getSharedContextPath()}\n` +
      `  pairing topic: ${topic}\n` +
      (generated
        ? `  (generated — share this topic with your peer)\n`
        : "") +
      `\n` +
      `Next: run \`p2pa connect\` and add the JSON to Cursor / Claude Desktop.\n` +
      `Watch state: \`p2pa log\`\n`,
  );
}

async function cmdStop(): Promise<void> {
  await withPm2(async () => {
    await pm2Stop(DAEMON_NAME);
    await pm2Delete(DAEMON_NAME);
  });
  process.stdout.write(`✓ Stopped ${DAEMON_NAME}\n`);
}

async function cmdStatus(): Promise<void> {
  const config = readConfig();
  let statusLine = "not running";
  let details = "";

  try {
    await withPm2(async () => {
      const desc = await pm2Describe(DAEMON_NAME);
      const proc = desc[0];
      if (!proc) {
        statusLine = "not running";
        return;
      }
      statusLine = proc.pm2_env?.status ?? "unknown";
      const mem = proc.monit?.memory
        ? `${Math.round(proc.monit.memory / 1024 / 1024)}MB`
        : "?";
      const cpu = proc.monit?.cpu ?? "?";
      details = `  memory: ${mem}  cpu: ${cpu}%  restarts: ${proc.pm2_env?.restart_time ?? 0}\n`;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusLine = `error (${message})`;
  }

  const topicFingerprint = config?.topic ? topicFingerprintOf(config.topic) : null;
  const { mode, legacy } = resolveAuthMode(config);
  const peers = listPeers();
  const identity = loadOrCreateIdentity();

  process.stdout.write(
    `p2pa status\n` +
      `  daemon:  ${statusLine}\n` +
      details +
      `  you:     ${identity.fingerprint} (${identity.label})\n` +
      `  topic:   ${topicFingerprint ? `fingerprint ${topicFingerprint}` : "(none — run p2pa start)"}\n` +
      formatAuthBanner(mode, legacy, peers.length) +
      `  config:  ${getConfigDir()}\n` +
      `  context: ${getSharedContextPath()}\n` +
      `  errors:  ${getDaemonErrorLogPath()}\n`,
  );
}

async function cmdLog(): Promise<void> {
  ensureConfigDir();
  const path = getSharedContextPath();
  if (!existsSync(path)) {
    process.stdout.write(
      `(no log yet at ${path} — start the daemon or MCP server first)\n`,
    );
    return;
  }

  process.stdout.write(`--- tailing ${path} (Ctrl+C to stop) ---\n`);

  const dumpFrom = (start: number): number => {
    const size = statSync(path).size;
    if (size <= start) return start;
    const fd = createReadStream(path, {
      start,
      end: size - 1,
      encoding: "utf8",
    });
    fd.pipe(process.stdout, { end: false });
    return size;
  };

  let offset = dumpFrom(0);

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try {
        offset = dumpFrom(offset);
      } catch {
        // file rotated / removed
      }
    }, 500);
    const onSig = (): void => {
      clearInterval(timer);
      process.stdout.write("\n");
      resolve();
    };
    process.once("SIGINT", onSig);
    process.once("SIGTERM", onSig);
  });
}

function cmdConnect(): void {
  const { command, argsPrefix } = resolveP2paCommand();
  const env: Record<string, string> = {
    P2PA_CONFIG_DIR: getConfigDir(),
  };
  const sa = process.env["P2PA_GOOGLE_SA_JSON"];
  if (sa && sa.trim().length > 0 && !sa.trim().startsWith("{")) {
    env["P2PA_GOOGLE_SA_JSON"] = sa.trim();
  }

  const config = {
    mcpServers: {
      "p2pa": {
        command,
        args: [...argsPrefix, "mcp"],
        env,
      },
    },
  };

  process.stdout.write(
    `Add this to your Claude Desktop config (claude_desktop_config.json)\n` +
      `or Cursor MCP settings:\n\n` +
      `${JSON.stringify(config, null, 2)}\n\n` +
      `Notes:\n` +
      `- \`p2pa mcp\` runs the agent-facing MCP server over stdio.\n` +
      `- Optional: \`p2pa start\` runs a background Hyperswarm daemon\n` +
      `  sharing ~/.p2pa/shared_context.md (prefer one writer at a time).\n` +
      `- Pairing topic is stored in ${join(getConfigDir(), "config.json")}.\n` +
      `- Living doc: set P2PA_GOOGLE_SA_JSON (SA key path) in MCP env, then\n` +
      `  \`p2pa doc create\` and restart MCP so doc_* tools work.\n`,
  );
}

async function cmdMcp(): Promise<void> {
  ensureConfigDir();
  ensureTopic();

  if (!existsSync(INDEX_SCRIPT)) {
    throw new Error(
      `Missing ${INDEX_SCRIPT}. Run \`npm run build\` first (or reinstall the package).`,
    );
  }

  const child = spawn(process.execPath, [INDEX_SCRIPT], {
    stdio: "inherit",
    env: {
      ...process.env,
      P2PA_CONFIG_DIR: getConfigDir(),
      P2PA_DAEMON: "0",
    },
  });

  const forward = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  const code: number = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c ?? 1));
  });
  process.exit(code);
}

function requireGoogleClient() {
  const client = createGoogleDocsClientFromEnv();
  if (!client) {
    throw new Error(
      `Set P2PA_GOOGLE_SA_JSON to a service-account JSON **file path** under your home directory ` +
        `(not inline JSON). Enable Google Docs API + Drive API for that SA.`,
    );
  }
  return client;
}

async function cmdDocCreate(title?: string): Promise<void> {
  ensureConfigDir();
  ensureTopic();
  const client = requireGoogleClient();
  const docTitle = title?.trim() || "P2PA Mission";
  const created = await client.createDoc(docTitle);
  await client.shareAnyoneWriter(created.documentId);
  setDocLink({ documentId: created.documentId, url: created.url });
  process.stdout.write(
    `✓ Living doc created\n` +
      `  url: ${created.url}\n` +
      `  id:  ${created.documentId}\n` +
      `\n` +
      `Anyone with the link can edit (writer). Treat the URL like a capability secret.\n` +
      `Restart \`p2pa mcp\` (or the daemon) so the bridge starts polling.\n` +
      `Agents: doc_publish / doc_read_steering / doc_status\n`,
  );
}

async function cmdDocLink(urlOrId: string): Promise<void> {
  ensureConfigDir();
  ensureTopic();
  const documentId = extractDocumentId(urlOrId);
  if (!documentId) {
    throw new Error("Could not parse a Google Doc id from that URL/id");
  }
  const client = requireGoogleClient();
  // Verify the SA can read the doc before saving the link.
  await client.getDocument(documentId);
  const url = documentUrl(documentId);
  setDocLink({ documentId, url });
  process.stdout.write(
    `✓ Linked living doc\n` +
      `  url: ${url}\n` +
      `  id:  ${documentId}\n` +
      `\n` +
      `Ensure the service account can edit the doc, and prefer “anyone with the link = editor”\n` +
      `so teammates can interrupt. Restart \`p2pa mcp\` to start polling.\n`,
  );
}

function cmdDocUnlink(): void {
  const prev = clearDocLink();
  if (!prev) {
    process.stdout.write("No living doc was linked.\n");
    return;
  }
  process.stdout.write(
    `✓ Unlinked living doc (${prev.documentId})\n` +
      `  (Google credentials unchanged — only the doc binding was cleared)\n`,
  );
}

function cmdDocStatus(): void {
  const config = readConfig();
  const doc = config?.doc;
  const hasSa = createGoogleDocsClientFromEnv() !== null;
  if (!doc) {
    process.stdout.write(
      `p2pa doc status\n` +
        `  linked: false\n` +
        `  sa:     ${hasSa ? "P2PA_GOOGLE_SA_JSON present" : "missing"}\n` +
        `  hint:   p2pa doc create | p2pa doc link <url>\n`,
    );
    return;
  }
  process.stdout.write(
    `p2pa doc status\n` +
      `  linked: true\n` +
      `  url:    ${doc.url}\n` +
      `  id:     ${doc.documentId}\n` +
      `  sa:     ${hasSa ? "P2PA_GOOGLE_SA_JSON present" : "missing (bridge will not start)"}\n`,
  );
}

function formatAuthBanner(mode: AuthMode, legacy: boolean, peerCount: number): string {
  if (mode === "strict") {
    return peerCount === 0
      ? `  auth:    strict (0 peers allowlisted — nobody can connect yet)\n`
      : `  auth:    strict (${peerCount} peer(s) allowlisted)\n`;
  }
  return (
    `  auth:    OPEN${legacy ? " (legacy config)" : ""} — anyone with the topic can read/write\n` +
    `           run \`p2pa auth strict\` after pairing your peers\n`
  );
}

/** `p2pa pair` — print an invite token for this node. */
function cmdPairShow(label?: string): void {
  ensureConfigDir();
  const { topic } = ensureTopic();
  const identity =
    label && label.trim().length > 0
      ? setIdentityLabel(label)
      : loadOrCreateIdentity();

  const token = encodeInvite({
    topic,
    pubkey: identity.publicKeyHex,
    label: identity.label,
  });

  process.stdout.write(
    `Your P2PA invite token\n` +
      `  identity: ${identity.fingerprint} (${identity.label})\n` +
      `  pubkey:   ${identity.publicKeyHex}\n` +
      `\n` +
      `${token}\n` +
      `\n` +
      `Send it to your peer over a channel you trust — it contains the pairing\n` +
      `topic, so treat it like a password.\n` +
      `\n` +
      `Pairing is mutual. Both sides must run:\n` +
      `  p2pa pair <their-token>\n` +
      `\n` +
      `Then restart \`p2pa mcp\` / \`p2pa start\` on a fresh install, or just keep\n` +
      `going — a running node picks up allowlist changes automatically.\n`,
  );
}

/** `p2pa pair <token>` — allowlist the issuer and adopt their topic. */
function cmdPairAccept(token: string, adoptTopic: boolean): void {
  ensureConfigDir();
  const parsed = decodeInvite(token);
  if (!parsed.ok) {
    throw new Error(`Invalid invite token: ${parsed.error}`);
  }
  const { invite } = parsed;

  const identity = loadOrCreateIdentity();
  if (invite.pubkey === identity.publicKeyHex) {
    throw new Error(
      "That is your own invite token — send it to your peer and paste theirs instead.",
    );
  }

  const existing = readConfig();
  const topicDiffers = existing !== null && existing.topic !== invite.topic;
  if (topicDiffers && !adoptTopic) {
    throw new Error(
      `This token is for a different pairing topic than the one you are on ` +
        `(local fingerprint ${topicFingerprintOf(existing.topic)}, token ${topicFingerprintOf(invite.topic)}).\n` +
        `Switching topics leaves your current peers behind. Re-run with --adopt-topic ` +
        `if that is what you want.`,
    );
  }

  if (existing === null || topicDiffers) {
    writeTopicPreservingRest(invite.topic);
  }

  const result = addPeer(invite.pubkey, invite.label);
  if (!result.ok) {
    throw new Error(`Could not allowlist peer: ${result.error}`);
  }

  const { mode, legacy } = resolveAuthMode(readConfig());
  const myToken = encodeInvite({
    topic: invite.topic,
    pubkey: identity.publicKeyHex,
    label: identity.label,
  });

  process.stdout.write(
    `${result.updated ? "✓ Updated" : "✓ Allowlisted"} peer\n` +
      `  ${shortFingerprint(invite.pubkey)} (${invite.label})\n` +
      `  ${invite.pubkey}\n` +
      (topicDiffers ? `  adopted pairing topic ${topicFingerprintOf(invite.topic)}\n` : "") +
      `\n` +
      formatAuthBanner(mode, legacy, listPeers().length) +
      `\n` +
      `Now send YOUR token back so they can allowlist you:\n` +
      `\n` +
      `${myToken}\n` +
      (mode === "open"
        ? `\nOnce both sides have paired, lock the swarm down:\n  p2pa auth strict\n`
        : ""),
  );
}

function topicFingerprintOf(topic: string): string {
  return createHash("sha256").update(topic).digest("hex").slice(0, 8);
}

function cmdPeersList(): void {
  const peers = listPeers();
  const { mode, legacy } = resolveAuthMode(readConfig());
  const identity = loadOrCreateIdentity();

  let out =
    `p2pa peers\n` +
    `  you:     ${identity.fingerprint} (${identity.label})\n` +
    formatAuthBanner(mode, legacy, peers.length) +
    `\n`;

  if (peers.length === 0) {
    out += `  (no peers allowlisted — run \`p2pa pair\` to get started)\n`;
    process.stdout.write(out);
    return;
  }

  for (const peer of peers) {
    out +=
      `  ${shortFingerprint(peer.pubkey)}  ${peer.label}\n` +
      `            ${peer.pubkey}\n` +
      `            added ${peer.addedAt}\n`;
  }
  process.stdout.write(out);
}

function cmdPeersRemove(target: string): void {
  const removed = removePeer(target);
  if (!removed) {
    throw new Error(
      `No allowlisted peer matches "${target}" (use the full public key or the exact label).`,
    );
  }
  process.stdout.write(
    `✓ Removed peer ${shortFingerprint(removed.pubkey)} (${removed.label})\n` +
      `  Running nodes drop the connection automatically.\n`,
  );
}

function cmdAuth(mode: AuthMode): void {
  const config = readConfig();
  if (!config) {
    throw new Error(
      "No pairing topic yet — run `p2pa start --topic …` or `p2pa mcp` once first.",
    );
  }

  const peers = listPeers();
  if (mode === "strict" && peers.length === 0) {
    process.stdout.write(
      `Warning: the allowlist is empty, so strict mode blocks every peer.\n` +
        `Run \`p2pa pair\` first if you expect to connect to someone.\n\n`,
    );
  }

  setAuthMode(mode);
  process.stdout.write(
    mode === "strict"
      ? `✓ auth mode: strict — only the ${peers.length} allowlisted peer(s) may connect\n` +
          `  Running nodes apply this on their next restart.\n`
      : `✓ auth mode: open — anyone who knows your topic may read and write your\n` +
          `  shared context. This is not recommended; prefer \`p2pa auth strict\`.\n`,
  );
}

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName("p2pa")
    .usage("$0 <command> [options]")
    .command(
      "start",
      "Start the background Hyperswarm daemon (PM2)",
      (y) =>
        y.option("topic", {
          type: "string",
          describe: "Pairing topic (generated + saved if omitted)",
        }),
      async (argv) => {
        await cmdStart(argv.topic);
      },
    )
    .command("stop", "Stop the background daemon", () => {}, async () => {
      await cmdStop();
    })
    .command("status", "Show daemon status and pairing topic", () => {}, async () => {
      await cmdStatus();
    })
    .command(
      "log",
      "Tail ~/.p2pa/shared_context.md",
      () => {},
      async () => {
        await cmdLog();
      },
    )
    .command(
      "connect",
      "Print MCP JSON config for Cursor / Claude Desktop",
      () => {},
      () => {
        cmdConnect();
      },
    )
    .command(
      "pair [token]",
      "Print your invite token, or accept a peer's token to allowlist them",
      (y) =>
        y
          .positional("token", {
            type: "string",
            describe: "A peer's invite token (omit to print your own)",
          })
          .option("label", {
            type: "string",
            describe: "Rename this node before printing your token",
          })
          .option("adopt-topic", {
            type: "boolean",
            default: false,
            describe:
              "Accept a token whose pairing topic differs from your current one",
          }),
      (argv) => {
        const token = argv.token;
        if (token !== undefined && token.trim().length > 0) {
          cmdPairAccept(token, argv["adoptTopic"] === true);
          return;
        }
        cmdPairShow(argv.label);
      },
    )
    .command(
      "peers",
      "List allowlisted peers (peers remove <pubkey|label> to revoke)",
      (y) =>
        y.command(
          "remove <peer>",
          "Revoke a peer by public key or exact label",
          (yy) =>
            yy.positional("peer", {
              type: "string",
              describe: "Full public key or exact label",
              demandOption: true,
            }),
          (argv) => {
            cmdPeersRemove(String(argv.peer));
          },
        ),
      (argv) => {
        // Parent handler runs only when no subcommand matched.
        if ((argv._ as (string | number)[]).length <= 1) {
          cmdPeersList();
        }
      },
    )
    .command(
      "auth <mode>",
      "Set the connection policy: strict (allowlist only) or open",
      (y) =>
        y.positional("mode", {
          type: "string",
          choices: ["strict", "open"] as const,
          describe: "strict = allowlisted peers only; open = anyone with the topic",
          demandOption: true,
        }),
      (argv) => {
        cmdAuth(String(argv.mode) as AuthMode);
      },
    )
    .command(
      "mcp",
      "Run the foreground MCP server over stdio (for agents)",
      () => {},
      async () => {
        await cmdMcp();
      },
    )
    .command(
      "doc",
      "Google Docs living-doc bridge (create / link / unlink / status)",
      (y) =>
        y
          .command(
            "create",
            "Create a shared Google Doc, set anyone-with-link writer, save link",
            (yy) =>
              yy.option("title", {
                type: "string",
                describe: "Document title",
                default: "P2PA Mission",
              }),
            async (argv) => {
              await cmdDocCreate(argv.title);
            },
          )
          .command(
            "link <urlOrId>",
            "Bind an existing Google Doc (must be readable by the service account)",
            (yy) =>
              yy.positional("urlOrId", {
                type: "string",
                describe: "Docs URL or document id",
                demandOption: true,
              }),
            async (argv) => {
              await cmdDocLink(String(argv.urlOrId));
            },
          )
          .command(
            "unlink",
            "Clear the saved doc binding (keeps SA credentials)",
            () => {},
            () => {
              cmdDocUnlink();
            },
          )
          .command(
            "status",
            "Show linked doc URL and whether SA credentials are present",
            () => {},
            () => {
              cmdDocStatus();
            },
          )
          .demandCommand(1, "Specify: create | link | unlink | status")
          .strict(),
      () => {
        // nested commands handle work
      },
    )
    .demandCommand(
      1,
      "Specify a command: start | stop | status | log | connect | mcp | pair | peers | auth | doc",
    )
    .strict()
    .help()
    .parseAsync();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`p2pa error: ${message}\n`);
  process.exit(1);
});
