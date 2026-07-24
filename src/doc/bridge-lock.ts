/**
 * Single-writer lock so daemon + MCP don't both poll the living doc.
 * Lock file: ~/.p2pa/doc-bridge.lock (pid).
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { ensureConfigDir, getConfigDir } from "../config.js";

function lockPath(): string {
  return join(getConfigDir(), "doc-bridge.lock");
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to become the sole living-doc poller.
 * Returns false if another live process holds the lock.
 */
export function tryAcquireDocBridgeLock(): boolean {
  ensureConfigDir();
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  const path = lockPath();

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      const pid = Number.parseInt(raw, 10);
      if (pid === process.pid) return true;
      if (pidAlive(pid)) {
        return false;
      }
      // Stale lock
      unlinkSync(path);
    } catch {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
  }

  try {
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8" });
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    // Another process won the race
    return false;
  }
}

export function releaseDocBridgeLock(): void {
  const path = lockPath();
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (pid === process.pid) {
      unlinkSync(path);
    }
  } catch {
    // ignore
  }
}
