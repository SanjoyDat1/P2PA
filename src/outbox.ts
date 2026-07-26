/**
 * Messages that outlive a disconnect.
 *
 * `send_peer_message` wrote straight to whatever sockets happened to be open,
 * so a message to a peer who was asleep, mid-restart, or on a train went
 * nowhere — it landed in the local audit trail and was never seen by anyone
 * else. For two people coordinating agents across machines that is the common
 * case, not the edge case: the whole point is to leave word for someone who is
 * not looking right now.
 *
 * A message is therefore queued first and sent second. It stays queued until
 * the recipient acknowledges it, and is replayed whenever that peer next
 * connects. The queue is on disk, so it survives a restart of either side.
 *
 * Bounds exist because this is the one structure that grows while nobody is
 * watching: a peer that never comes back must not grow the file forever.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MAX_PAYLOAD_BYTES } from "./types.js";

/** Messages retained. Oldest are dropped first. */
export const MAX_OUTBOX_MESSAGES = 500;

/** How long an unacknowledged message is retried before being given up on. */
export const MAX_OUTBOX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Inbound ids remembered per sender, so a replay is not logged twice. */
export const MAX_SEEN_PER_PEER = 500;

/** Senders tracked for dedupe. */
export const MAX_SEEN_PEERS = 64;

/** How long writes are batched before hitting disk. */
export const SAVE_DEBOUNCE_MS = 250;

/** Messages pushed to one peer in a single replay. */
export const MAX_REPLAY_BATCH = 100;

export interface OutboxMessage {
  id: string;
  text: string;
  createdAt: string;
  /** Public keys that have confirmed receipt. */
  ackedBy: string[];
  /**
   * Peers this message was addressed to, captured when it was queued.
   *
   * Without it, replay hands a peer paired later the whole retained backlog —
   * conversation it was never party to.
   */
  recipients?: string[];
}

const OutboxFileSchema = z.object({
  version: z.literal(1),
  messages: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        text: z.string().min(1).max(MAX_PAYLOAD_BYTES),
        createdAt: z.string().min(1).max(64),
        ackedBy: z.array(z.string().min(1).max(64)).max(64),
        recipients: z.array(z.string().min(1).max(64)).max(64).optional(),
      }),
    )
    .max(MAX_OUTBOX_MESSAGES),
  // Scoped per sender: a shared list lets one peer evict another's dedupe
  // state, or pre-claim an id so the real message is dropped as a duplicate.
  seen: z.record(z.array(z.string().min(1).max(64)).max(MAX_SEEN_PER_PEER)),
  dropped: z.number().int().min(0).optional(),
});

export interface OutboxSnapshot {
  pending: number;
  oldestPending: string | null;
  seenIds: number;
  /** Messages given up on — dropped at the cap or past the age limit. */
  dropped: number;
}

export class Outbox {
  private messages: OutboxMessage[] = [];
  /** Sender public key → ids already received from it. */
  private seen: Record<string, string[]> = {};
  private dropped = 0;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly filePath: string) {
    this.load();
  }

  get size(): number {
    return this.messages.length;
  }

  /** Queue a message for every peer, then let the caller try to send it now. */
  enqueue(text: string, recipients: string[] = []): OutboxMessage {
    const message: OutboxMessage = {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      ackedBy: [],
      ...(recipients.length > 0 ? { recipients: recipients.slice(0, 64) } : {}),
    };
    this.messages.push(message);
    while (this.messages.length > MAX_OUTBOX_MESSAGES) {
      this.messages.shift();
      this.dropped += 1;
      console.error(
        "[p2pa:outbox] queue is full — dropped the oldest undelivered message",
      );
    }
    // A message the user just sent is durable immediately; only the peer-rate
    // paths are batched.
    this.save(true);
    return message;
  }

  /**
   * Messages this peer has not confirmed.
   *
   * Batched: a peer returning after a long absence should not be handed the
   * entire backlog in one envelope.
   */
  pendingFor(publicKeyHex: string, limit = MAX_REPLAY_BATCH): OutboxMessage[] {
    return this.messages
      .filter((message) => {
        if (message.ackedBy.includes(publicKeyHex)) return false;
        // Addressed to whoever was paired at the time. A peer added later was
        // never a recipient and does not get the backlog.
        if (message.recipients && !message.recipients.includes(publicKeyHex)) {
          return false;
        }
        return true;
      })
      .slice(0, limit);
  }

  /** Record that a peer received these ids. Returns how many were newly acked. */
  ack(publicKeyHex: string, ids: string[]): number {
    let changed = 0;
    const wanted = new Set(ids);
    for (const message of this.messages) {
      if (!wanted.has(message.id)) continue;
      if (message.ackedBy.includes(publicKeyHex)) continue;
      if (message.ackedBy.length >= 64) {
        console.error(
          `[p2pa:outbox] message ${message.id} has hit its acknowledgement cap`,
        );
        continue;
      }
      message.ackedBy.push(publicKeyHex);
      changed += 1;
    }
    if (changed > 0) this.save();
    return changed;
  }

  /**
   * Have we already handled this inbound id?
   *
   * Replay is deliberately at-least-once — a sender that never hears an ack
   * sends again — so the receiver is what makes it look exactly-once.
   */
  isDuplicate(senderPublicKey: string, id: string): boolean {
    return this.seen[senderPublicKey]?.includes(id) === true;
  }

  markSeen(senderPublicKey: string, id: string): void {
    const ids = this.seen[senderPublicKey] ?? [];
    if (ids.includes(id)) return;
    ids.push(id);
    while (ids.length > MAX_SEEN_PER_PEER) ids.shift();
    this.seen[senderPublicKey] = ids;

    const senders = Object.keys(this.seen);
    if (senders.length > MAX_SEEN_PEERS) {
      delete this.seen[senders[0] as string];
    }
    this.save();
  }

  /**
   * Drop messages every current peer has acknowledged, and any that have been
   * retried past the age limit.
   *
   * `recipients` is the current allowlist: a message nobody is still expected
   * to receive has nothing left to wait for.
   */
  prune(recipients: string[], now: number = Date.now()): number {
    const before = this.messages.length;
    let expired = 0;
    this.messages = this.messages.filter((message) => {
      const age = now - Date.parse(message.createdAt);
      if (Number.isFinite(age) && age > MAX_OUTBOX_AGE_MS) {
        expired += 1;
        return false;
      }
      if (recipients.length === 0) return true;
      return !recipients.every((key) => message.ackedBy.includes(key));
    });
    const removed = before - this.messages.length;
    if (expired > 0) {
      this.dropped += expired;
      console.error(
        `[p2pa:outbox] gave up on ${expired} message(s) never confirmed within the retry window`,
      );
    }
    if (removed > 0) this.save();
    return removed;
  }

  status(): OutboxSnapshot {
    return {
      pending: this.messages.length,
      oldestPending: this.messages[0]?.createdAt ?? null,
      seenIds: Object.values(this.seen).reduce((n, ids) => n + ids.length, 0),
      dropped: this.dropped,
    };
  }

  /** Write any batched changes now. Call before shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.dirty) this.write();
  }

  private load(): void {
    const parsed = readFile(this.filePath);
    if (!parsed) return;
    this.messages = parsed.messages;
    this.seen = parsed.seen;
    this.dropped = parsed.dropped ?? 0;
  }

  /**
   * Queue a write.
   *
   * Inbound acks and dedupe marks arrive at whatever rate a peer chooses to
   * send, and each one used to rewrite the whole file synchronously on the
   * Hyperswarm data path — work proportional to the entire queue, per envelope.
   * Those are batched; a message the user just sent still lands immediately.
   */
  private save(immediate = false): void {
    this.dirty = true;
    if (immediate) {
      this.flush();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (this.dirty) this.write();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /**
   * Merge with whatever is on disk, then write.
   *
   * The daemon and `p2pa mcp` can both hold this file open. Each keeps a full
   * in-memory copy, so a blind overwrite silently erases the other's queued
   * messages — losing exactly the durability this exists to provide. Merging
   * first makes concurrent writers additive instead.
   */
  private write(): void {
    this.dirty = false;
    const onDisk = readFile(this.filePath);
    if (onDisk) this.mergeFrom(onDisk);

    const body = JSON.stringify({
      version: 1,
      messages: this.messages,
      seen: this.seen,
      dropped: this.dropped,
    });
    const tmp = join(
      dirname(this.filePath),
      `.outbox-${process.pid}-${Date.now()}.tmp`,
    );
    let handle: number | undefined;
    try {
      // Queued messages are user content; keep them owner-only like the rest
      // of the config directory.
      handle = openSync(tmp, "w", 0o600);
      writeFileSync(handle, body, "utf8");
      // Durable before the rename, so a crash cannot leave a torn file that
      // load() would discard wholesale — taking the queue with it.
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[p2pa:outbox] failed to persist outbox: ${message}`);
      try {
        if (handle !== undefined) closeSync(handle);
        // Otherwise every failed attempt leaves a uniquely-named file behind.
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // best effort
      }
    }
  }

  /** Union another writer's state into ours; nothing is ever dropped by merging. */
  private mergeFrom(other: OutboxFile): void {
    const byId = new Map(this.messages.map((message) => [message.id, message]));
    for (const message of other.messages) {
      const mine = byId.get(message.id);
      if (!mine) {
        byId.set(message.id, message);
        continue;
      }
      // Acknowledgements are facts; take the union.
      for (const key of message.ackedBy) {
        if (!mine.ackedBy.includes(key) && mine.ackedBy.length < 64) {
          mine.ackedBy.push(key);
        }
      }
    }
    this.messages = [...byId.values()]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(-MAX_OUTBOX_MESSAGES);

    for (const [sender, ids] of Object.entries(other.seen)) {
      const mine = this.seen[sender] ?? [];
      for (const id of ids) if (!mine.includes(id)) mine.push(id);
      this.seen[sender] = mine.slice(-MAX_SEEN_PER_PEER);
    }
    this.dropped = Math.max(this.dropped, other.dropped ?? 0);
  }
}

type OutboxFile = z.infer<typeof OutboxFileSchema>;

/** Read and validate the file, or return null when it is absent or unusable. */
function readFile(filePath: string): OutboxFile | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = OutboxFileSchema.safeParse(
      JSON.parse(readFileSync(filePath, "utf8")),
    );
    if (!parsed.success) {
      console.error("[p2pa:outbox] malformed outbox file — starting empty");
      return null;
    }
    return parsed.data;
  } catch {
    console.error("[p2pa:outbox] unreadable outbox file — starting empty");
    return null;
  }
}
