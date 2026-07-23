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
  ensureConfigDir,
  ensureTopic,
  getConfigDir,
  getDaemonErrorLogPath,
  getDaemonOutLogPath,
  getSharedContextPath,
  readConfig,
} from "./config.js";

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

  const topicFingerprint = config?.topic
    ? createHash("sha256").update(config.topic).digest("hex").slice(0, 8)
    : null;

  process.stdout.write(
    `p2pa status\n` +
      `  daemon:  ${statusLine}\n` +
      details +
      `  topic:   ${topicFingerprint ? `fingerprint ${topicFingerprint}` : "(none — run p2pa start)"}\n` +
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
  const config = {
    mcpServers: {
      "p2pa": {
        command,
        args: [...argsPrefix, "mcp"],
        env: {
          P2PA_CONFIG_DIR: getConfigDir(),
        },
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
      `- Pairing topic is stored in ${join(getConfigDir(), "config.json")}.\n`,
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
      "mcp",
      "Run the foreground MCP server over stdio (for agents)",
      () => {},
      async () => {
        await cmdMcp();
      },
    )
    .demandCommand(1, "Specify a command: start | stop | status | log | connect | mcp")
    .strict()
    .help()
    .parseAsync();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`p2pa error: ${message}\n`);
  process.exit(1);
});
