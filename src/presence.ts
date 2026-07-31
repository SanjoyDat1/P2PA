/**
 * Who is in the swarm, and what each of them is for.
 *
 * Leases stop two agents doing the same job. They say nothing about *which*
 * agent should do a job, because until now a peer was only a hex fingerprint:
 * nothing recorded that one node is the reviewer, that another has the test
 * suite wired up, that a third is mid-way through a refactor and should not be
 * handed anything else. Two agents can coordinate on a shared document without
 * that. A swarm cannot — routing work needs a directory.
 *
 * A presence card lives in the ordinary CRDT document under `@agent/<nodeId>`,
 * not in a side channel. That gets it persistence, the handshake snapshot,
 * bounds, and the audit trail for free, and it gets the one property that
 * matters: **a card is only valid when the node id in its key matches the node
 * id that stamped it.** Forging another agent's card therefore requires stamping
 * as that agent, which the sender-binding check in `handleInboundOps` already
 * refuses and a signature makes impossible. Impersonation is closed by the same
 * rule that protects leases, rather than by a new mechanism to get wrong.
 *
 * Liveness is advisory. A card carries the time it was written and agents
 * re-announce on a heartbeat, so a node that vanishes goes stale rather than
 * disappearing — there is no failure detector here and pretending otherwise
 * would be worse than saying so.
 */
import { z } from "zod";
import { nodeIdFromPublicKey } from "./hlc.js";
import type { JsonValue } from "./types.js";

/** Presence cards live under this prefix and it holds nothing else. */
export const AGENT_KEY_PREFIX = "@agent/";

/**
 * How long an agent may be silent before it is reported stale.
 *
 * Matched to the default lease duration deliberately. At 90s this was shorter
 * than a default `claim_task` TTL, so an agent that followed the lease guidance
 * exactly — claim, work for five minutes, release — was reported dead to every
 * peer for most of its own task. A presence window tighter than the work it is
 * meant to describe produces false positives as a matter of routine.
 *
 * Being generous costs little: leases, not presence, are what actually stop two
 * agents doing the same job. Presence only advises routing.
 */
export const PRESENCE_STALE_MS = 5 * 60 * 1000;

/** Suggested re-announce interval, comfortably inside the stale window. */
export const PRESENCE_HEARTBEAT_MS = 60_000;

/** Bounds on a card, which arrives from a peer like anything else. */
export const MAX_ROLE_LENGTH = 64;
export const MAX_CAPABILITY_ENTRIES = 32;
export const MAX_CAPABILITY_TEXT = 64;
export const MAX_MODEL_LENGTH = 64;
export const MAX_STATUS_NOTE = 200;

/**
 * What an agent is doing right now.
 *
 * Deliberately coarse. A richer lifecycle would need agreement about transitions
 * that nothing in a serverless network can enforce.
 */
export const AGENT_STATUS = ["idle", "working", "blocked", "offline"] as const;
export type AgentStatus = (typeof AGENT_STATUS)[number];

export interface AgentCard {
  /** What this agent is for, e.g. `reviewer`, `builder`, `planner`. */
  role: string;
  /** What it can do, for routing — free-form tokens agreed between operators. */
  capabilities: string[];
  /** Model or runtime behind it, for humans reading the roster. */
  model?: string;
  status: AgentStatus;
  /** Task id it currently holds, when it holds one. */
  task?: string;
  /** One line of human-facing detail. */
  note?: string;
  /** When the card was written, ISO 8601. Drives staleness. */
  at: string;
}

export const AgentCardSchema = z.object({
  role: z.string().min(1).max(MAX_ROLE_LENGTH),
  capabilities: z
    .array(z.string().min(1).max(MAX_CAPABILITY_TEXT))
    .max(MAX_CAPABILITY_ENTRIES)
    .default([]),
  model: z.string().max(MAX_MODEL_LENGTH).optional(),
  status: z.enum(AGENT_STATUS),
  task: z.string().max(128).optional(),
  note: z.string().max(MAX_STATUS_NOTE).optional(),
  at: z.string().min(1).max(64),
});

export function agentKeyFor(nodeId: string): string {
  return `${AGENT_KEY_PREFIX}${nodeId}`;
}

/**
 * Exact shape of a node id: 16 lowercase hex characters.
 *
 * Enforced on presence keys because the roster is what agents address each other
 * by. A card published at a short id like `@agent/c` would otherwise be a valid
 * roster entry, and any peer resolving "c" could be steered to the wrong node.
 */
export const NODE_ID_PATTERN = /^[0-9a-f]{16}$/;

export function isWellFormedNodeId(nodeId: string): boolean {
  return NODE_ID_PATTERN.test(nodeId);
}

export function nodeIdFromAgentKey(key: string): string | null {
  if (!key.startsWith(AGENT_KEY_PREFIX)) return null;
  const nodeId = key.slice(AGENT_KEY_PREFIX.length);
  return isWellFormedNodeId(nodeId) ? nodeId : null;
}

export function isAgentKey(key: string): boolean {
  return key.startsWith(AGENT_KEY_PREFIX);
}

/**
 * Is this card in the one slot its author is allowed to write?
 *
 * The whole impersonation defence in one line: a card at `@agent/X` is only
 * meaningful if X stamped it. Applied on the wire and on the local write path,
 * because the on-disk replica is treated as untrusted too.
 */
export function isOwnCard(key: string, stampNodeId: string): boolean {
  const owner = nodeIdFromAgentKey(key);
  // `nodeIdFromAgentKey` already rejects a malformed id, so a card can only sit at
  // a full 16-hex slot — there is no short-id card for a lookup to collide with.
  return owner !== null && owner === stampNodeId;
}

/** The key this public key is allowed to publish a card at. */
export function agentKeyForPublicKey(publicKeyHex: string): string {
  return agentKeyFor(nodeIdFromPublicKey(publicKeyHex));
}

export interface AgentView extends AgentCard {
  nodeId: string;
  /** False once the card has aged past `PRESENCE_STALE_MS`. */
  live: boolean;
  /** Age of the card in ms, for callers that want their own threshold. */
  ageMs: number;
  /** True when this is the local node's own card. */
  isSelf: boolean;
}

/** Parse a stored value into a card, or null when it is not one. */
export function parseCard(value: JsonValue | undefined): AgentCard | null {
  if (value === undefined) return null;
  const parsed = AgentCardSchema.safeParse(value);
  return parsed.success ? (parsed.data as AgentCard) : null;
}

/**
 * Render a card for an agent to read.
 *
 * `live` is derived from the card's own timestamp rather than from connection
 * state: a peer can be connected and its agent still wedged, and a card can be
 * fresh while the link is briefly down. The timestamp is what the writer
 * asserted, which is the honest signal to expose.
 */
export function describeCard(
  nodeId: string,
  card: AgentCard,
  now: number,
  selfNodeId: string,
  /**
   * Wall time of the most recent operation this node stamped, from anywhere in
   * the document.
   *
   * An agent that is writing state or taking leases is demonstrably alive, so
   * requiring it to *also* post a heartbeat to avoid being declared dead is both
   * redundant and fragile — it makes liveness depend on an LLM remembering a
   * timer rather than on evidence already in the replica. The card's own
   * timestamp is the floor; real activity raises it.
   */
  lastActivityMs?: number,
): AgentView {
  const written = Date.parse(card.at);
  const cardAt = Number.isFinite(written) ? written : 0;
  const seenAt = Math.max(cardAt, lastActivityMs ?? 0);
  const ageMs = seenAt > 0 ? Math.max(0, now - seenAt) : Number.MAX_SAFE_INTEGER;
  return {
    ...card,
    nodeId,
    ageMs,
    // An explicit `offline` is the agent's own word for it and always wins: it
    // has said it is leaving, whatever its last write suggests.
    live: card.status !== "offline" && ageMs <= PRESENCE_STALE_MS,
    isSelf: nodeId === selfNodeId,
  };
}

/** Build a card for the local node, timestamped now. */
export function buildCard(input: {
  role: string;
  capabilities?: string[];
  model?: string;
  status: AgentStatus;
  task?: string;
  note?: string;
  now?: number;
}): AgentCard {
  return {
    role: input.role.slice(0, MAX_ROLE_LENGTH),
    capabilities: (input.capabilities ?? [])
      .slice(0, MAX_CAPABILITY_ENTRIES)
      .map((cap) => cap.slice(0, MAX_CAPABILITY_TEXT)),
    ...(input.model !== undefined
      ? { model: input.model.slice(0, MAX_MODEL_LENGTH) }
      : {}),
    status: input.status,
    ...(input.task !== undefined ? { task: input.task.slice(0, 128) } : {}),
    ...(input.note !== undefined ? { note: input.note.slice(0, MAX_STATUS_NOTE) } : {}),
    at: new Date(input.now ?? Date.now()).toISOString(),
  };
}

/**
 * Pick agents able to take a piece of work.
 *
 * Advisory: this is a suggestion for whoever is deciding, not an assignment.
 * Nothing here reserves anything — that is what a lease is for.
 */
export function candidatesFor(
  agents: AgentView[],
  capability: string | undefined,
): AgentView[] {
  return agents
    .filter((agent) => agent.live && agent.status === "idle" && !agent.isSelf)
    .filter(
      (agent) => capability === undefined || agent.capabilities.includes(capability),
    )
    .sort((a, b) => a.ageMs - b.ageMs);
}
