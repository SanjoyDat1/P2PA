/**
 * Version and capability negotiation.
 *
 * The previous wire schema pinned the version with `v: z.literal(3)`, so a peer
 * running any other build had *every* envelope fail validation and get dropped
 * with one line on stderr. Nothing told either operator why two paired machines
 * sat connected and never synced, and shipping a v4 would have silently broken
 * every v3 node in the field. A protocol that cannot be revised is a protocol
 * nobody else can adopt, so negotiation comes first.
 *
 * Each side opens with a `hello` naming the version range it can speak and the
 * capabilities it implements. The effective version is the highest both support;
 * a capability is active only when both advertise it. When the ranges do not
 * overlap the connection is closed with a stated reason instead of degrading
 * into a silent black hole.
 *
 * Everything here is pure so the rules can be tested without a swarm.
 */

/** Version this build speaks and stamps on everything it sends. */
export const PROTOCOL_VERSION = 4;

/**
 * Oldest version this build can still talk to.
 *
 * v3 peers never send `hello` at all, so they are detected by their first frame
 * and served v3 semantics — no signatures, no chunked snapshots, no addressing.
 */
export const MIN_PROTOCOL_VERSION = 3;

/** First version that negotiates, and therefore the first that can be extended. */
export const FIRST_NEGOTIATING_VERSION = 4;

/**
 * Capability flags.
 *
 * A flag means "I implement this", not "I require it". Requirements are policy
 * (see `requireSignatures`), deliberately kept out of negotiation so a stricter
 * peer refuses explicitly rather than appearing incompatible.
 */
export const CAP_SIGNATURES = "sig";
export const CAP_CHUNKED_SNAPSHOT = "chunk";
export const CAP_ADDRESSED_MESSAGES = "addr";
export const CAP_PRESENCE = "presence";

export const LOCAL_CAPABILITIES: readonly string[] = [
  CAP_SIGNATURES,
  CAP_CHUNKED_SNAPSHOT,
  CAP_ADDRESSED_MESSAGES,
  CAP_PRESENCE,
];

/** Max capability tokens accepted in a hello, so the list cannot be a payload. */
export const MAX_CAPABILITIES = 32;

/** Max characters in one capability token. */
export const MAX_CAPABILITY_LENGTH = 32;

/**
 * Reasons a connection is closed, sent in `bye` and shown to the operator.
 *
 * Named rather than numbered: the whole point is that a human reading the log
 * learns why two machines will not talk.
 */
export type CloseReason =
  | "version-mismatch"
  | "unauthorized"
  | "rate-limit"
  | "oversized"
  | "malformed"
  | "slow-consumer"
  | "shutdown";

export interface StateDigest {
  /** `stateHash()` — equal digests mean the documents already match. */
  state: string;
  /** `claimsHash()` — leases are excluded from the state digest. */
  claims: string;
}

/** The opening frame's body, as advertised by a peer. */
export interface HelloBody {
  /** Oldest version the sender can speak. */
  min: number;
  /** Newest version the sender can speak. */
  max: number;
  /** Sender's node id (truncated public key), for cross-checking stamps. */
  node: string;
  /** Capabilities the sender implements. */
  caps: readonly string[];
  /** Digests of the sender's replica, so an already-matching peer skips sync. */
  digest?: StateDigest;
}

export type Negotiation =
  | {
      ok: true;
      /** Version both sides will use for the rest of the connection. */
      version: number;
      /** Capabilities both sides implement. */
      caps: ReadonlySet<string>;
    }
  | { ok: false; reason: CloseReason; detail: string };

export interface LocalProfile {
  min: number;
  max: number;
  caps: readonly string[];
}

export const LOCAL_PROFILE: LocalProfile = {
  min: MIN_PROTOCOL_VERSION,
  max: PROTOCOL_VERSION,
  caps: LOCAL_CAPABILITIES,
};

/**
 * Settle the version and capability set for a connection.
 *
 * Highest common version wins, which is what lets a new build roll out one
 * machine at a time. A malformed range is a mismatch rather than something to
 * repair: guessing what an unparseable peer meant is how silent incompatibility
 * gets reintroduced.
 */
export function negotiate(
  remote: HelloBody,
  local: LocalProfile = LOCAL_PROFILE,
): Negotiation {
  if (
    !Number.isSafeInteger(remote.min) ||
    !Number.isSafeInteger(remote.max) ||
    remote.min < 1 ||
    remote.max < remote.min
  ) {
    return {
      ok: false,
      reason: "version-mismatch",
      detail: `peer advertised an invalid version range (min=${remote.min}, max=${remote.max})`,
    };
  }

  const version = Math.min(local.max, remote.max);
  const floor = Math.max(local.min, remote.min);
  if (version < floor) {
    return {
      ok: false,
      reason: "version-mismatch",
      detail:
        `peer speaks protocol v${remote.min}-v${remote.max}, this node speaks ` +
        `v${local.min}-v${local.max}. Upgrade whichever side is older ` +
        `(\`npm i -g p2pa\`).`,
    };
  }

  // Intersection, not union: acting on a capability the other side lacks is how
  // one node starts sending frames the other will only ever discard.
  const shared = new Set<string>();
  for (const cap of remote.caps.slice(0, MAX_CAPABILITIES)) {
    if (local.caps.includes(cap)) shared.add(cap);
  }

  return { ok: true, version, caps: shared };
}

/**
 * Capabilities to assume for a peer that never sent a hello.
 *
 * A v3 peer opens with its snapshot, so the absence of a hello is itself the
 * version signal. It gets the empty set: every v4 feature is additive, and
 * sending one to a node that will discard it is worse than not using it.
 */
export function legacyNegotiation(): Negotiation {
  return { ok: true, version: MIN_PROTOCOL_VERSION, caps: new Set<string>() };
}

/** Does this negotiated connection carry a given capability? */
export function hasCapability(
  negotiated: Negotiation,
  cap: string,
): boolean {
  return negotiated.ok && negotiated.caps.has(cap);
}

/** Two replicas holding identical documents have nothing to exchange. */
export function digestsMatch(
  local: StateDigest,
  remote: StateDigest | undefined,
): boolean {
  if (!remote) return false;
  return local.state === remote.state && local.claims === remote.claims;
}
