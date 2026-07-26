/**
 * Single-writer locks over files in the config directory.
 *
 * The daemon and `p2pa mcp` both mutate `shared_context.md`, and each holds a
 * full in-memory copy that it rewrites wholesale — so two of them running at
 * once silently overwrite each other's work. That has been a documented
 * "prefer one writer" note rather than anything enforced, which means the
 * failure mode is corruption discovered later rather than an error at startup.
 *
 * A lock records the owning pid. A lock whose owner is gone is stale and gets
 * cleared, so a crash does not leave the tool unusable.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { uptime } from "node:os";
import { ensureConfigDir, getConfigDir } from "./config.js";

export interface LockResult {
  acquired: boolean;
  /** Pid of the live process holding it, when we could not take it. */
  heldBy?: number;
}

function lockPath(name: string): string {
  return join(getConfigDir(), `${name}.lock`);
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Approximate boot time, in seconds.
 *
 * Pids are recycled, so after a reboot a stale lock can name a pid that now
 * belongs to something unrelated — `kill(pid, 0)` then reports it alive and the
 * tool is locked out permanently with no way for the user to recover. A lock
 * written before this boot is stale no matter what its pid says.
 */
function bootId(): number {
  return Math.round(Date.now() / 1000 - uptime());
}

/** Boot ids drift by a second or two between samples; allow for that. */
const BOOT_ID_TOLERANCE_S = 5;

interface LockRecord {
  pid: number;
  boot: number;
}

function parseLock(raw: string): LockRecord | null {
  const [pidText, bootText] = raw.trim().split(/\s+/);
  const pid = Number.parseInt(pidText ?? "", 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const boot = Number.parseInt(bootText ?? "", 10);
  return { pid, boot: Number.isFinite(boot) ? boot : 0 };
}

/** Is the recorded owner genuinely still running? */
function isLive(record: LockRecord): boolean {
  if (record.boot > 0 && Math.abs(record.boot - bootId()) > BOOT_ID_TOLERANCE_S) {
    return false;
  }
  return pidAlive(record.pid);
}

/** Pid currently recorded in the lock, or null when it is absent or stale. */
export function lockHolder(name: string): number | null {
  const path = lockPath(name);
  if (!existsSync(path)) return null;
  try {
    const record = parseLock(readFileSync(path, "utf8"));
    if (!record) return null;
    return isLive(record) ? record.pid : null;
  } catch {
    return null;
  }
}

/**
 * Take a named lock, clearing it first if its owner has died.
 *
 * `wx` does the actual claiming, so two processes racing here cannot both win.
 */
export function acquireLock(name: string): LockResult {
  ensureConfigDir();
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  const path = lockPath(name);

  if (existsSync(path)) {
    let record: LockRecord | null = null;
    try {
      record = parseLock(readFileSync(path, "utf8"));
    } catch {
      record = null;
    }
    if (record && record.pid === process.pid) return { acquired: true };
    if (record && isLive(record)) {
      return { acquired: false, heldBy: record.pid };
    }
    if (!breakStaleLock(path)) {
      // Someone else is already clearing it; let them have it.
      const holder = lockHolder(name);
      return holder === null ? { acquired: false } : { acquired: false, heldBy: holder };
    }
  }

  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, `${process.pid} ${bootId()}\n`, { encoding: "utf8" });
    } finally {
      closeSync(fd);
    }
  } catch {
    // Someone else won the race between the check and the create.
    const holder = lockHolder(name);
    return holder === null ? { acquired: false } : { acquired: false, heldBy: holder };
  }

  // Confirm we are the recorded owner: two processes clearing the same stale
  // lock could otherwise both believe they won, which is precisely the
  // concurrent-writer case this exists to stop.
  const owner = (() => {
    try {
      return parseLock(readFileSync(path, "utf8"))?.pid ?? null;
    } catch {
      return null;
    }
  })();
  if (owner !== process.pid) {
    return owner === null ? { acquired: false } : { acquired: false, heldBy: owner };
  }
  return { acquired: true };
}

/**
 * Clear a lock whose owner is gone, exclusively.
 *
 * Without this, two processes can each read the same stale lock, and the slower
 * one unlinks the *winner's* fresh lock on its way past — leaving both running
 * as writers. The break itself has to be the thing that is raced.
 */
function breakStaleLock(path: string): boolean {
  const breaker = `${path}.break`;
  let fd: number | undefined;
  try {
    fd = openSync(breaker, "wx", 0o600);
  } catch {
    return false;
  }
  try {
    closeSync(fd);
    if (existsSync(path)) unlinkSync(path);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(breaker);
    } catch {
      // best effort
    }
  }
}

/** Release a lock this process owns. Safe to call more than once. */
export function releaseLock(name: string): void {
  const path = lockPath(name);
  if (!existsSync(path)) return;
  try {
    const record = parseLock(readFileSync(path, "utf8"));
    if (record?.pid === process.pid) unlinkSync(path);
  } catch {
    // A lock we cannot read is not one we own.
  }
}

/** Name of the lock guarding writes to the shared context file. */
export const STATE_WRITER_LOCK = "state-writer";
