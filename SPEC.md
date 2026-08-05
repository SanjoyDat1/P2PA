# P2PA Wire Protocol — Specification v4

**Status:** Draft standard
**Version:** 4 (supported range: 3–4)
**Reference implementation:** [`p2pa`](https://github.com/SanjoyDat1/P2PA) (TypeScript)

This document specifies the P2PA wire protocol completely enough to write an
independent implementation. Everything an implementation must agree on to
interoperate is normative here; anything not specified is a local choice.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHOULD**,
**SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted
as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 1. Scope and design goals

P2PA synchronizes a shared JSON document, task leases, agent presence, and
messages between AI agents running on separate machines, with **no server**.

The protocol is designed around four constraints:

1. **No coordinator.** There is no quorum, no leader, and no consensus round.
   Every conflict resolution rule must therefore be a deterministic function of
   the data, computable identically on every replica with no communication.
2. **Every peer is untrusted input.** Bounds are normative, not advisory. An
   unbounded field is a remote memory-exhaustion primitive.
3. **Partition tolerance over agreement.** Two partitioned nodes may both believe
   they hold the same lease until they can talk again. This is stated rather than
   hidden (§7.4).
4. **Versions must be able to change.** A protocol that cannot be revised without
   a flag day cannot be adopted by anyone else (§4).

### 1.1 What P2PA does not provide

Stating these plainly is part of the specification:

- **No distributed mutual exclusion.** Leases narrow a duplicate-work window to
  the propagation delay. They are not a mutex (§7.4).
- **No confidentiality from the transport's peers.** Every allowlisted peer on a
  topic sees the whole document. There is no per-key access control.
- **No causal consistency across keys.** Each key merges on its own timeline.
  Two keys written together may arrive apart.
- **No liveness detection.** Presence is advisory and timestamp-based (§8.3).

---

## 2. Transport

An implementation **MUST** provide a reliable, ordered, authenticated,
bidirectional byte stream between peers, where each endpoint's long-term
**Ed25519 public key** is cryptographically proven to the other.

The reference implementation uses [Hyperswarm](https://github.com/holepunchto/hyperswarm)
(DHT discovery + NAT traversal, Noise-authenticated streams). Any transport with
the properties above is conformant.

- Peers discover each other on the **discovery key** `SHA-256(topic)`, where
  `topic` is a shared secret string.
- The topic is **discovery material, not an access-control boundary**: it is
  announced on a public DHT. Authorization is §3.
- The public key proven by the transport handshake is the peer's identity for all
  purposes in this document. An implementation **MUST NOT** accept a peer-supplied
  claim of identity in preference to it.

---

## 3. Authorization

Two modes are defined.

| Mode | Behaviour |
|---|---|
| `strict` | Only public keys on a local allowlist may connect, inbound or outbound. **RECOMMENDED.** |
| `open` | Any peer that knows the topic may connect. |

- In `strict` mode an implementation **MUST** refuse the connection **before any
  application frame is exchanged**, so an unauthorized peer can neither read state
  from a snapshot nor write it with an update.
- In `strict` mode, an empty allowlist **MUST** admit nobody. Failing open here is
  a defect.
- An implementation **MUST** re-evaluate the allowlist when it changes and close
  connections to peers that are no longer listed. Connect-time-only checks leave a
  revoked peer's session live indefinitely.

---

## 4. Framing and versioning

### 4.1 Framing

Frames are **NDJSON**: one UTF-8 JSON object per line, terminated by `\n` (U+000A).

- A frame **MUST NOT** exceed `MAX_PAYLOAD_BYTES` = **1 048 576** bytes
  (1 MiB), excluding the terminator.
- A receiver **MUST** close the connection on a frame exceeding that limit
  (`oversized`, §9).
- A receiver **MUST** bound its reassembly buffer. The reference implementation
  closes the connection past `2 × MAX_PAYLOAD_BYTES`.
- A receiver **MUST** ignore a line that is not parseable JSON without closing the
  connection.
- A receiver **MUST** ignore a well-formed frame that fails schema validation
  without closing the connection, **except** as required by §4.3, and except a
  frame whose `v` is above the supported range — that is the one validation
  failure an operator can act on, so it **SHOULD** close with `version-mismatch`
  and name both versions rather than being discarded in silence.
- Unknown fields **MUST** be ignored. Unknown frame `type` values **MUST** be
  ignored. This is what allows additive extension.

### 4.2 Version field

Every frame carries `v`, an integer.

- A receiver **MUST** accept any `v` within its supported range.
- A receiver **MUST NOT** pin `v` to a single value. Doing so makes every frame
  from a peer on another version fail validation, which presents as two connected
  peers that never sync and no diagnostic for either operator.

### 4.3 Negotiation

Both endpoints **MUST** send `hello` as their first frame, before any other.

```json
{
  "type": "hello",
  "v": 4,
  "min": 3,
  "max": 4,
  "node": "a3f9c1b2d4e5f607",
  "caps": ["sig", "chunk", "addr", "presence"],
  "digest": { "state": "9f2c1a0b3d4e5f60", "claims": "0011223344556677" },
  "label": "sanjoy-laptop"
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `min` | int 1–1000 | yes | Oldest version the sender can speak |
| `max` | int 1–1000 | yes | Newest version the sender can speak |
| `node` | string ≤64 | yes | Sender's node id (§5.2). A receiver **MUST** check it against `nodeIdFromPublicKey(transport key)` and close on mismatch. The transport key remains the identity — this only catches a peer that is misconfigured or lying. |
| `caps` | string[] ≤32, each ≤32 chars | yes (absent treated as `[]`) | Capabilities the sender **implements** |
| `digest` | object | no | Replica digests (§5.7) |
| `label` | string ≤64 | no | Human-facing name. Advisory; **MUST NOT** be treated as identity |

Negotiation rules:

1. `effective = min(local.max, remote.max)`
2. `floor = max(local.min, remote.min)`
3. If `effective < floor`, the connection is **incompatible**: the implementation
   **MUST** send `bye` with reason `version-mismatch` and **SHOULD** log a message
   naming both ranges, then close.
4. If `remote.min` or `remote.max` is not a safe integer, `remote.min < 1`, or
   `remote.max < remote.min`, the peer **MUST** be treated as incompatible. An
   implementation **MUST NOT** attempt to repair an invalid range.
5. The active capability set is the **intersection** of both `caps` lists. An
   implementation **MUST NOT** use a capability the peer did not advertise.
6. A capability flag means "I implement this". It **MUST NOT** mean "I require
   this". Requirements are local policy (§6.5).

**Legacy peers.** A v3 peer never sends `hello`; it opens with `snapshot`. An
implementation **MUST** treat the first non-`hello` frame as evidence of a v3 peer
and negotiate `version = 3` with an **empty** capability set. An implementation
**SHOULD** also apply a timeout (reference: 5 s) so a silent peer is still served.

**Downgrading.** A sender **MUST** omit `to`, `corr` and `intent` when the
connection did not negotiate the `addr` capability, and **MUST** omit `part` and
`of` when `version < 4`. Note the first rule is capability-driven, not
version-driven: capabilities are the finer-grained signal, and a peer that
advertises `addr` can read those fields whatever version it settled on. Sending a
field the other side cannot read is not harmless — a receiver validating against a
fixed shape silently drops unknown fields, so the sender would believe it
addressed a message that the receiver treated as a broadcast.

### 4.4 Capabilities

| Token | Meaning |
|---|---|
| `sig` | Understands and verifies per-operation signatures (§6) |
| `chunk` | Understands multi-part snapshots (`part`/`of`) (§6.6) |
| `addr` | Understands addressed messages (`to`/`corr`/`intent`) (§8.4) |
| `presence` | Understands the `@agent/` namespace (§8) |
| `task` | Understands the `@task/` namespace (§7A). **Gating on this is mandatory, not an optimisation** — see §7A.7 |

---

## 5. The replicated document

### 5.1 Model

The document is a map from **key** to **entry**. Each top-level key is an
independent CRDT register carrying its own timestamp. Two agents writing
*different* keys never conflict. Two agents writing the *same* key converge on the
same winner on every replica with no arbitration step.

An **operation** (`op`) is one key and one entry:

```json
{ "key": "plan", "entry": { "kind": "lww", "hlc": {...}, "value": "..." } }
```

Keys **MUST** match `^[A-Za-z0-9._:@/-]{1,256}$`.

The following keys **MUST** be rejected on every path in — wire frames, relayed
snapshots, and the on-disk replica alike: `__proto__`, `constructor`, `prototype`,
and `_version` (the retired v1 counter key, which would otherwise reappear as an
ordinary key and read as meaningful).

### 5.2 Hybrid logical clocks

Every entry carries an HLC stamp:

```json
{ "w": 1769812345678, "c": 3, "n": "a3f9c1b2d4e5f607" }
```

| Field | Meaning |
|---|---|
| `w` | Wall clock, milliseconds since Unix epoch |
| `c` | Counter distinguishing writes within one millisecond |
| `n` | **Node id**: the first 16 lowercase hex characters of the author's public key |

**Total order.** Compare `w`, then `c`, then `n` lexicographically. The `n`
tiebreak is REQUIRED: without it two peers stamping the same millisecond each keep
their own value and never converge.

**Local tick.** `tick()` **MUST** return a stamp strictly greater than every stamp
the node has issued or observed.

**Observation.** On receiving a stamp, a node **MUST** advance its clock to at
least that stamp, subject to §5.3.

### 5.3 Clock bounds (normative)

| Bound | Value | Why |
|---|---|---|
| `MAX_CLOCK_SKEW_MS` | 86 400 000 (24 h) | A stamp further ahead is refused |
| `MAX_HLC_COUNTER` | 1 000 000 | Counter ceiling |
| `NODE_ID_LENGTH` | 16 | Hex chars of node id |

An implementation **MUST** reject a stamp where:
- `w` is not a safe integer, or `w < 0`, or `w > now + MAX_CLOCK_SKEW_MS`
- `c` is not a safe integer, or `c < 0`, or `c >= MAX_HLC_COUNTER`
- `n` is absent, empty, or longer than `NODE_ID_LENGTH`

An implementation **MUST NOT** let an observed stamp push its own clock past
`now + MAX_CLOCK_SKEW_MS`. A clock pinned at the ceiling makes every subsequent
local write unacceptable to every peer, silently removing the node from the swarm.

### 5.4 Entry kinds

#### 5.4.1 `lww` — last-write-wins register

```json
{ "kind": "lww", "hlc": {...}, "value": <any JSON>, "deleted": false }
```

- `value` is omitted when `deleted` is `true` (a tombstone).
- A tombstone **MUST** be retained for `TOMBSTONE_TTL_MS` = **604 800 000** (7 d)
  before collection, so a stale replica cannot resurrect a deleted key.

#### 5.4.2 `orset` — add-wins observed-remove set

```json
{
  "kind": "orset", "hlc": {...},
  "floor": {...},
  "adds": { "<tag>": <any JSON> },
  "removes": ["<tag>"]
}
```

- Each added element gets a **unique tag**. Concurrent adds get distinct tags and
  both survive.
- A remove tombstones specific tags. A re-add gets a fresh tag, so **add wins**.
- `floor` is the highest `lww` stamp this key has carried. A set op stamped at or
  below the floor belongs to a superseded lineage and **MUST** be discarded. This
  is what makes a key that flips between `lww` and `orset` converge regardless of
  delivery order.
- An implementation **MUST** preserve `floor` across validation. Dropping it (for
  example by validating against a schema that does not declare the field) reduces
  the guarantee to single-process scope.
- Tag generation is a local choice. Tags **MUST NOT** be assumed unpredictable: a
  peer may relay another node's tag, so a tag collision **MUST** be resolved by
  content ordering (§5.5), not by insertion order.
- Tags **MUST NOT** be `__proto__`, `constructor`, or `prototype`, and an
  implementation **MUST** reject an entry using one. In languages where objects
  carry a prototype chain these are not ordinary keys: a membership test against
  `__proto__` succeeds via inheritance, so a genuine element is compared against
  the prototype and silently dropped, and assigning to it rewrites the object's
  prototype instead of adding an element. Whether that happens depends on how the
  tag map was constructed, so two replicas can disagree. Implementations
  **SHOULD** additionally build tag maps without a prototype.

#### 5.4.3 `claim` — task lease

See §7.

#### 5.4.4 `task` — backlog entry

See §7A.

A `task` entry is collectable once it is **terminal** and `now - hlc.w` exceeds
`TASK_RETENTION_MS` (7 days). An `open` task **MUST NOT** be collected however old
it is: it is the work queue, and dropping it loses the job rather than the record
of one.

Retention **MUST** comfortably exceed the accepted clock skew (§5.3), or a settled
task collected early is resurrected as `open` by an in-flight op that predates the
completion and an agent redoes the work. A peer offline for longer than the
retention window can still resurrect a settled task; this is the same limitation
tombstones have (§5.4.1) and implementations **MUST NOT** present it as closed.

### 5.5 Merge

For an inbound op on key `K` with entry `E`, against current entry `C`:

1. **Stamp bounds** (§5.3).
2. **Namespace check.** `claim` entries **MUST** appear only under `@claim/`, and
   `@claim/` **MUST** hold only `claim` entries. The same rule binds `task`
   entries to `@task/` and `@task/` to `task` entries. The `@agent/` rule (§8.3)
   is equivalent but is enforced at the validation boundary rather than in merge,
   so it applies to the on-disk replica too.
3. **Lease bounds** (§7.2, §7.5), when `E` is a `claim`; **task bounds** (§7A.2),
   when `E` is a `task`.
4. **Entry size** (§10.1).
5. **Verify signature** if present (§6). An invalid signature **MUST** reject the
   op. Every cheaper check above **MUST** run first: verification is the most
   expensive work an inbound operation can buy, so one that fails a comparison
   must never be able to purchase it.
6. **Key budgets** (§10.1).
7. **Observe** `E.hlc` into the local clock. A rejected op **MUST NOT** reach this
   step — a stamp adopted on the way to being refused still shifts every later
   local write.
5. If `C` is absent, store `E`.
6. If `E` and `C` are both `claim`, apply §7.3.
6a. If `E` and `C` are both `task`, apply §7A.3. A task **MUST NOT** be reported
   as contended: a backlog entry is expected to be written by several nodes, and
   reporting every peer completion as a concurrent update fills the operator's
   record with ordinary traffic.
7. If `E` and `C` are both `orset`, **union**: `adds` merged, `removes` unioned,
   `floor` set to the higher of the two. A union **MUST** be applied even if `E` is
   older than `C` — *unless* `E.hlc` is at or below the floor, in which case `E`
   belongs to a superseded lineage and **MUST** be discarded (§5.4.2).
8. Otherwise (`lww` vs `lww`, or mixed kinds) apply **`entryWins`**:
   1. Higher HLC wins.
   2. On an exact stamp tie, compare **canonical entry content** (§5.6); higher
      wins.
   3. On an exact content tie, an entry carrying a signature wins over one that
      does not. (A v3 relay strips signatures, so one logical write can circulate
      both signed and bare; retaining the verifiable copy is strictly more
      information and is the same decision on every replica.)
9. **The loser of a mixed-kind comparison MUST be discarded.** Storing it is a
   silent data-loss bug: a stale `orset` losing to a live `lww` would replace the
   register's value with the set while the merge reported "ignored", so nothing
   reached the audit trail, and feeding the same two ops in the opposite order
   produced a different document — a permanent divergence with no attacker
   required. One stale operation from any authorized peer was enough to erase a
   key.
10. When the surviving entry is the `orset` and the loser was an `lww`, the
    survivor's `floor` **MUST** be raised to the loser's stamp. In the reverse
    case nothing is stored: the winning `lww`'s own stamp already acts as the
    floor when the two are next compared.

**Locally modifying an entry invalidates its signature.** An implementation
**MUST** strip `by`/`sig` from any entry whose content it rewrites — including
raising `floor` and truncating an over-cap set. Relaying a signature over content
that has since changed causes every peer to reject the op as a forgery.

Merge **MUST** be commutative, associative and idempotent. Every bound applied
during merge **MUST** be a pure function of the merged content, so two replicas
fed the same ops in different orders reach the same document. Refusing an op
because a limit was already reached is **not** commutative and **MUST NOT** be
used where truncation can be made deterministic instead (see §10.2).

### 5.6 Canonical JSON (normative)

Required for signatures and for content tiebreaks. Two implementations **MUST**
produce byte-identical output for the same value.

1. Object keys sorted **ascending by UTF-16 code unit**.
2. No insignificant whitespace.
3. Strings escaped as ECMAScript `JSON.stringify` escapes them.
4. Numbers as `JSON.stringify` renders them.

Canonical **entry** encoding for tiebreaks, per kind — note that `by`, `sig` and
`floor` are excluded:

| Kind | Encoding |
|---|---|
| `lww` | `lww:-` when deleted, else `lww:` + canonicalJson(`value` ?? null) |
| `orset` | `orset:` + canonicalJson(`adds`) + `:` + sorted `removes` joined by `,` |
| `claim` | `claim:<gen>:<ttl>:<r\|a>` (`r` when released) |
| `task` | `task:<status>:<attempts>:` + canonicalJson(entry minus `by`/`sig`) |

Non-integer numbers **SHOULD NOT** be signed: their canonical rendering is
implementation-sensitive across languages.

### 5.7 Replica digests

`hello` MAY carry two digests so that two peers already holding the same document
skip the handshake snapshot entirely — the common case on reconnect, and the
difference between an O(document) transfer per peer and nothing at all.

| Digest | Computation |
|---|---|
| `state` | First 16 hex characters of `SHA-256(canonicalJson(materialized document))`, where the materialized document is the plain-JSON view with tombstones, tags, leases and presence stripped (§5.5) |
| `claims` | First 16 hex characters of `SHA-256` over the lease table: one line per lease, sorted by key, each `key\|gen\|w\|c\|n\|ttl\|released`, joined by `\n`, where `released` is `1` or `0` |
| `tasks` | First 16 hex characters of `SHA-256` over the backlog: one line per task, sorted by key, each `key\|H`, where `H` is the first 16 hex characters of `SHA-256(canonical task content)` (§7A.3), joined by `\n`. **The empty string when there are no tasks** |

Leases and tasks are digested separately because `state` deliberately excludes
them: two replicas that disagree about who holds a task, or about what work
exists, would otherwise look identical.

A digest **MUST** cover the **whole mergeable content** of the entries it
summarizes, never a projection of them. This is not thoroughness for its own
sake. A digest match suppresses the handshake snapshot, so a field left out of a
digest makes two replicas differing only in that field skip the one exchange that
would reconcile them — and neither side then has any reason to send another op.
The divergence is permanent, and it is reported as agreement. It is reachable
with no attacker: two nodes creating the same task id concurrently, one ending up
with a dependency the other lacks and both agreeing on every other field.

`tasks` is OPTIONAL, and a receiver **MUST** treat an absent `tasks` as `""`. A
sender with no tasks **MUST** send `""` rather than the hash of an empty input, so
that a peer predating the namespace — which sends no such field — still matches a
peer that has no tasks. Without this rule every reconnect in a mixed swarm
re-ships the whole document to prove nothing changed.

An implementation **MUST** treat a digest as a hint only. Skipping the snapshot on
a match is an optimisation; a mismatch — including one caused by a peer that
computes digests differently, or lies about them — **MUST** only cause a snapshot
to be sent, never a merge to be skipped or a document to be trusted. A peer
therefore cannot use a forged digest to suppress state it does not want us to
have: at worst it declines to receive ours.

---

## 6. Operation signatures

### 6.1 Why

The transport authenticates each **hop**. §6.4 binds a direct update's stamps to
the sending peer, so nobody can write as somebody else directly.

Snapshots are the gap. A snapshot legitimately relays operations authored by third
parties — that is how a joining peer learns what everyone else has done — so its
entries cannot be bound to the sender. With two nodes that costs nothing. With
three or more, peer B can fabricate an entry stamped with peer C's node id, relay
it to A, and A records it as C's work. For a protocol whose value is an attributed
history, that is a correctness failure.

### 6.2 Fields

Signature metadata travels **on the entry**, not the envelope, so it survives
relay.

| Field | Type | Meaning |
|---|---|---|
| `by` | 64 lowercase hex chars | Author's Ed25519 public key |
| `sig` | base64, 88 chars (64 raw bytes) | Signature over §6.3 |

### 6.3 Signed bytes

```
"p2pa-op-v1" || 0x0A || key || 0x0A || canonicalJson(entry_without_by_sig)
```

UTF-8 encoded. `"p2pa-op-v1"` is a domain separator; without it a signature over
some other structure that serialized identically would verify. The key is inside
the signed bytes so a signature cannot be lifted onto a different key. The stamp
is inside the entry so it cannot be re-dated.

### 6.4 Verification

A verifier **MUST**, for an entry carrying either field:

1. Reject if only one of `by`/`sig` is present.
2. Reject if `nodeIdFromPublicKey(by) != entry.hlc.n`. The signature proves who
   authored the bytes; this proves the bytes claim the same author. Without it a
   valid signature could be paired with any stamp.
3. Reject if `by` is not a valid Ed25519 public key, or `sig` is not 64 bytes.
4. Reject if Ed25519 verification over §6.3 fails.

An entry carrying **neither** field is **unsigned**, which is distinct from
invalid: it is a v3 peer or a legacy relay, and **MUST** remain mergeable under
§6.5.

Verification is the most expensive work an inbound frame can buy (~80 µs of
blocking Ed25519 per operation), so an implementation **MUST** run every cheap
validation — stamp bounds, namespace, lease bounds, entry size — *before* it
verifies, and **MUST NOT** let a rejected operation advance the local clock.

An implementation **SHOULD** close the connection on an operation whose signature
does not verify. Unlike a bound being exceeded, this is not a peer misbehaving by
degree: it is a forgery attempt, and leaving it free makes grinding signatures
cost the attacker nothing.

**Sender binding (all versions).** For a `update` frame, every op's `entry.hlc.n`
**MUST** equal `nodeIdFromPublicKey(sender's transport public key)`. A frame
containing any other stamp **MUST** be rejected in full. `snapshot` frames are
exempt — that is precisely why they are merge-only and never authoritative.

**Own-identity rule (all versions).** A `snapshot` entry stamped with the
**receiver's own** node id **MUST** be rejected. That is not relaying; it is a
peer writing as us, and it would pass the contention check unnoticed.

### 6.5 Policy

| Policy | Behaviour |
|---|---|
| Default | Unsigned ops accepted. REQUIRED for v3 interoperability. |
| `requireSignatures` | Relayed ops without a valid signature rejected. RECOMMENDED once every peer speaks v4. |

The policy **MUST** be operator-reachable. A policy that exists only in the type
system is not a policy: every deployment then runs in the permissive mode with no
way out, and §12.1's relay guarantees are false everywhere. The reference
implementation persists it in `config.json` as `requireSignatures` and exposes
`p2pa auth require-signatures` / `p2pa auth allow-unsigned`.

An implementation **SHOULD** warn at startup when three or more peers are paired
and enforcement is off, since that is exactly the topology where an unsigned relay
becomes forgeable.

### 6.6 Signing scope limitation

A **merged OR-set is not attributable to one author** and **MUST** be stored
unsigned: its contents come from several nodes, so no single signature can speak
for it. Set *deltas* are signed, so membership is verifiable; the merged
aggregate is not. `lww` writes and leases are whole-value writes and remain
end-to-end verifiable after any number of relays.

The same applies to a **merged `task` entry** (§7A.3): once a join has combined
fields from two authors, no single signature covers the result, so it is stored
and relayed unsigned. Under `requireSignatures` (§6.5) such an entry does not
survive a third-party relay and must be learned from a node that wrote it
directly. Because a direct update is always freshly signed, this only affects
handshake snapshots. Re-authoring merged entries locally to keep them signed is
**NOT RECOMMENDED**: it makes every merge produce a new stamped write, amplifying
traffic and churning the descriptor for no correctness gain.

---

## 7. Task leases

### 7.1 Purpose

State sync stops two agents overwriting each other. It does not stop them doing
the same job twice. A lease is a claim over a task id.

### 7.2 Representation

Key: `@claim/<taskId>`, where `taskId` matches `^[A-Za-z0-9._:-]{1,128}$`.

```json
{ "kind": "claim", "hlc": {...}, "gen": 3, "ttl": 300000, "released": false, "note": "refactoring auth" }
```

| Field | Bound |
|---|---|
| `gen` | int, 0 … 999 000 000 (`MAX_ACCEPTED_CLAIM_GEN`) |
| `ttl` | int ms, 1 000 … 3 600 000 |
| `note` | string ≤500 |

The **holder** is `hlc.n`. Expiry is `hlc.w + ttl` — derived from the lease's own
stamp, which the clock rules bound to real time, rather than from a sender-supplied
absolute expiry that could claim a task forever.

### 7.3 Lease merge (join-semilattice)

In order:

1. **Higher `gen` wins.** This is what makes an expired lease safely replaceable:
   the next claimer takes `gen + 1`, so a stale op from the previous generation can
   never reinstate itself.
2. **Within a generation, the *earliest* stamp wins** — first come, first served.
   Note this is the **opposite** of the last-write-wins rule for state, and it is
   deliberate: a later claimant must not be able to steal a lease by writing again.
3. **Within a generation, at the same stamp, `released: true` wins.** Release is
   absorbing.
4. On an exact tie, canonical **lease** content ordering, then
   signed-over-unsigned.

The lease tiebreak encoding is **not** the §5.6 claim encoding, which exists for
`entryWins` and deliberately omits the stamp. It is the seven fields joined by
single spaces:

```
<gen> <ttl> <r|a> <hlc.w> <hlc.c> <hlc.n> <note or empty string>
```

The stamp is included because two leases reaching this rule already agree on
generation and release state, so only the stamp and note can separate them; `note`
is included so two otherwise-identical claims still order deterministically.

A release **MUST** carry the stamp of the claim it ends, not a fresh one. This is
what makes it beat exactly that claim and no other, and it means producing one
requires the holder's node id — which §6.4 only accepts from the holder.

### 7.4 Guarantees and limits (normative statement)

- Once two nodes have exchanged ops, they **agree on the holder**, always.
- Two **partitioned** nodes **MAY** both believe they hold the same lease until
  they reconnect. No protocol without a quorum can avoid this, and P2PA has no
  quorum by design.
- A lease therefore narrows the duplicate-work window to the propagation delay.
  It is **not** a distributed mutex, and an implementation **MUST NOT** present it
  as one.

### 7.5 Timing

| Bound | Value | Purpose |
|---|---|---|
| `MAX_CLAIM_FUTURE_MS` | 60 000 | A lease may not be stamped meaningfully ahead; expiry is derived from the stamp |
| `CLAIM_EXPIRY_GRACE_MS` | 30 000 | Grace before treating another node's lease as lapsed, since clocks disagree |
| `CLAIM_RETENTION_MS` | 86 400 000 | How long an expired lease is retained before collection |

A claimant **SHOULD** wait one propagation window (reference: 250 ms) before
acting on a successful claim when peers are connected, and re-check. A local
"success" cannot yet reflect a peer that claimed microseconds earlier.

---

## 7A. The backlog

### 7A.1 Purpose

A lease is a lock over a task id, and a task id by itself refers to nothing. Two
agents describing the same work differently — `refactor-auth` and `auth-refactor`
— each take a lease and both do the job, so the exclusion a lease provides is
conditional on a shared vocabulary the protocol did not supply. A `task` is that
vocabulary made into an object: what the work is, what it needs, what it waits on,
and what came out of it.

A task **MUST NOT** record who is working on it. `@task/<id>` and `@claim/<id>`
share an id and are **joined when read, never merged**. A `holder` field on a task
would be a second answer to a question §7 already answers, and the two would
disagree the first time a holder crashed — the task saying "held by B" forever
while the lease said "free". Nothing in this section changes §7.

### 7A.2 Representation

Key: `@task/<taskId>`, where `taskId` matches `^[A-Za-z0-9._:-]{1,128}$` — the
same form §7 uses, because the two namespaces are joined by that id.

```json
{
  "kind": "task",
  "hlc": {...},
  "title": "Port the auth module to the new token API",
  "detail": "src/auth/*.ts — keep the public signature stable",
  "needs": ["typescript"],
  "deps": ["build-api"],
  "priority": 7,
  "status": "open",
  "result": {"files": 6},
  "lastError": "index shard 3 timed out",
  "attempts": 1,
  "createdBy": "a3f9c1b2d4e5f607",
  "createdAt": 1785891120023
}
```

| Field | Bound |
|---|---|
| `title` | string, 1 … 200 |
| `detail` | string ≤4 000 |
| `needs` | ≤8 tokens, each 1 … 64 (the §8.2 capability bound, so a requirement and a capability can never differ in length and silently fail to match); **sorted ascending, no duplicates** |
| `deps` | ≤32 task ids, each matching the id pattern; **sorted ascending, no duplicates** |
| `priority` | int, 0 … 9 |
| `status` | one of `open`, `done`, `failed`, `cancelled` |
| `result` | any JSON, ≤16 384 bytes serialized |
| `lastError` | string ≤500 |
| `attempts` | int, 0 … 1 000 (`MAX_ACCEPTED_TASK_ATTEMPTS`) |
| `createdBy` | string, 1 … 16 |
| `createdAt` | int epoch ms, ≥0 and ≤ `now + MAX_CLOCK_SKEW_MS` |

`hlc` is the stamp of the write that last set the **descriptor** (§7A.3);
`hlc.n` is that writer and is **not** the holder. `createdBy` is an attribution
the writer chooses, not one the protocol enforces (§12.2); the verifiable author
of a given write is the signature on the op (§6).

`needs` and `deps` are **sets**, and a set has exactly one encoding here:
deduplicated and sorted ascending by UTF-16 code unit. An entry whose lists are
in any other form **MUST** be rejected at the validation boundary. It **MUST NOT**
be repaired on receipt: repairing rewrites content the author signed, so the
entry would have to be stored unsigned — losing attribution for an honest peer,
and handing anyone a way to strip a signature by replaying the same operation
with its lists shuffled. Refusing costs a well-behaved sender nothing, since the
merge (§7A.3) emits canonical lists. Storing a non-canonical entry verbatim
breaks idempotence: the entry changes the first time it merges with a copy of
itself, which is reported as a change and drops its signature.

Every bound above **MUST** be enforced at the validation boundary, and the
`status`, `attempts`, `priority` and `createdAt` bounds **MUST** additionally be
enforced **wherever an entry is seated without passing through merge** — a
handshake snapshot and an on-disk replica are both untrusted input, and an
implementation that rehydrates from disk by a separate path **MUST** apply them
there too. The same requirement binds §7.2's lease bounds.

### 7A.3 Task merge (join-semilattice)

A task is written by several nodes — created by one, completed by another,
retried by a third — so it **MUST NOT** be a last-write-wins register: a stale
`open` arriving after a completion would reopen finished work. The entry is the
**product** of independent joins:

| Field group | Join |
|---|---|
| `status` | maximum of rank `open(0) < cancelled(1) < failed(2) < done(3)` |
| `attempts` | maximum |
| `deps`, `needs` | union, then truncated to the first N by sort order (§10.2) |
| `title`, `detail`, `priority`, `createdBy`, `createdAt`, `result`, `lastError` | one **descriptor**, taken whole from the entry with the greater `(hlc, canonical descriptor)` |
| `hlc` | the descriptor winner's stamp |

**Terminal precedence is `done` > `failed` > `cancelled`.** `done` outranks
because it is the only terminal carrying a result, and losing a real completion to
a concurrent cancel strands every task waiting on it and causes the work to be
redone. `failed` outranks `cancelled` because the more information-bearing
terminal should survive.

The descriptor is taken **whole**. Merging its fields individually would pair a
title from one write with a priority from another and produce a task neither
author wrote.

`result` and `lastError` travel **inside** the descriptor rather than joining on
their own. A field resolved by last-write-wins needs a stamp of its own, and a
task entry carries exactly one stamp; joining `result` by `(entry stamp, content)`
while the entry's stamp is decided by the descriptor is **not associative**. The
counterexample: a completion stamped 100 merged with a bare descriptor write
stamped 200 leaves the surviving result labelled 200, so a third copy carrying a
result stamped 150 loses — while the other association order lets it win, and the
two replicas never agree again. The consequence, which implementations **MUST**
document rather than hide: a completion can lose its `result` to a concurrent
descriptor write carrying a higher stamp. `status` is joined separately and
monotone, so the task still reads `done` on every replica; only the payload is
lost, and only when two nodes minted the same id independently.

The descriptor tiebreak encoding, used only when two entries carry the same stamp,
is canonical JSON (§5.6) over an object holding `title`, `priority`, `createdBy`
and `createdAt`, plus `detail`, `result` and `lastError` when present.

Each component is a maximum over a total order or a set union, so each is
commutative, associative and idempotent; a product of join-semilattices is a
join-semilattice. Every replica therefore reaches the same task from the same ops
in any delivery order, and re-delivering a completion changes nothing.

The lattice's elements are entries whose `deps` and `needs` are deduplicated,
sorted and inside their caps. An entry outside that set is a non-canonical
encoding of one, and the first merge maps it in — the same treatment §10.2 gives
an over-cap set.

**Signature handling.** The join produces content, never authorship:

- If the merged content equals **both** inputs' content, return whichever carries
  a signature. Identical content implies the same author, because content includes
  `hlc.n` and §6.4 binds `by` to it, and signing is deterministic — so this is the
  same decision on every replica.
- If it equals exactly one input's content, return that input, signature intact.
- Otherwise the entry is a genuine combination with no single author and **MUST**
  be stored unsigned (§6.6).

### 7A.4 Guarantees and limits (normative statement)

- Once two nodes have exchanged ops, they **agree on every field of every task**.
- Two **partitioned** nodes **MAY** each lease and complete the same open task. On
  reconnect the later result wins and the earlier one is lost. The backlog
  inherits §7.4's limit exactly; it is **not** a scheduler with a quorum, and an
  implementation **MUST NOT** present it as one.
- `deps` is **not** a guarantee that work happens in order. It is a guarantee that
  a task whose dependencies are unfinished is not *offered*. A lease may still be
  taken on any id (§7), so an agent that ignores the backlog is not prevented from
  doing anything.
- Because `deps` unions and can never shrink, a dependency that ends `failed` or
  `cancelled` blocks its dependents **permanently**. An implementation **MUST**
  surface this (as `blockedBy`, or equivalent) rather than leave a task that
  mysteriously never comes up. The escape is to cancel the dependent and create a
  replacement.
- An **unknown** dependency — one naming no task on this replica — **MUST** count
  as unsatisfied. A replica that has not finished syncing must not conclude the
  work is clear.
- Abandonment is **observed, not detected**. A lapsed lease over an open task is
  reported when an agent next asks the board for work. Nothing wakes on a timer,
  because P2PA has no failure detector and a timer here would claim a guarantee
  the rest of the protocol does not make.

### 7A.5 Trust — the first namespace that is not owner-bound

| Namespace | Rule |
|---|---|
| `@agent/<id>` | Only the node whose id is in the key may write it (§8.3) |
| `@claim/<id>` | Anyone may claim; only the holder may release (§7.3) |
| `@task/<id>` | **Any authorized peer may create, complete, requeue or cancel any task** |

This asymmetry is deliberate and load-bearing: a peer that could not complete work
it did not create could not be delegated to, which is the whole point. The
consequences are stated in §12.2.

Because merge is monotone, the destructive direction is one-way: a peer can end a
task, not silently reopen one. A malicious `open` arriving after a completion is
discarded by the status join.

### 7A.6 Bounds

| Bound | Value | Purpose |
|---|---|---|
| `MAX_TASK_KEYS` | 500 | Separate budget, so a flood of tasks cannot crowd out shared context. A legibility bound as much as a memory one |
| Eviction at the budget | oldest terminal task, by `(hlc.w, key)` | So the budget is a queue depth, not a lifetime cap |
| `TASK_RETENTION_MS` | 604 800 000 | How long a settled task is retained before collection (§5.4.4) |
| `TASK_MAX_ATTEMPTS` | 3 | Attempts before a task is dead-lettered rather than requeued |

`TASK_RETENTION_MS` alone is not a release valve: it measures from the settling
stamp, so a board of 500 finished tasks stays full for the whole retention window
and every attempt to add work is refused for that long — a single authorized peer
could otherwise wedge task creation swarm-wide. When a write meets the budget, an
implementation **SHOULD** evict the longest-settled task before refusing. Only
**terminal** entries are eligible: evicting an `open` one loses the work rather
than the record of it, which is why an implementation **MUST** refuse rather than
evict when every task on the board is still open — and **MUST** say so, rather
than advising the operator to settle work that is already settled.

Eviction **MUST** apply on the merge path as well as the local one. A flood fills
every node's budget at the same time, which is the case eviction exists for, so a
node that makes room locally and then refuses the peer's copy of the very task it
just admitted reports work as created that no peer can see. Two replicas both at
the cap would also reject each other's entries indefinitely: they never
reconcile, so their digests never match and the whole document re-ships on every
reconnect.

**`MAX_TASK_KEYS` is therefore approximate, not exact, and replicas may hold
different subsets.** Choosing the minimum terminal entry by `(hlc.w, key)` is a
pure function of *one* document, so it needs no coordination to compute — but two
replicas reach the cap holding different documents, so they evict different
entries and stay diverged on which settled tasks they retain. This is a
deliberate trade of exactness for liveness, and an implementation **MUST NOT**
present the cap as a guarantee that two replicas hold the same 500 tasks.
Convergence still holds for every task both replicas retain: eviction drops only
terminal entries, and a dropped entry that arrives again is simply re-admitted.

A task whose `attempts` has reached `TASK_MAX_ATTEMPTS` **MUST NOT** be offered
even when its `status` is still `open`: a peer can send `attempts: 999` with
`status: "open"`, and without this rule the board keeps offering work everybody
has already given up on.

### 7A.7 Interoperability (normative)

`task` is a **new entry kind**, not a new field. §4.1's "unknown fields MUST be
ignored" does not cover it: a kind is discriminated, so a receiver that does not
implement `task` fails validation on the whole frame carrying one, not on the one
operation.

Therefore a sender **MUST NOT** include `task` entries in any frame written to a
connection that did not negotiate the `task` capability:

1. A handshake snapshot **MUST** be filtered **before** chunking, so the `part`/`of`
   counts the receiver checks still describe what it is sent.
2. An `update` **MUST** have its task ops removed, and when **nothing survives**
   the filter the frame **MUST NOT** be written at all — an empty `ops` array
   fails the receiver's minimum-length check and is refused as malformed.

Inbound is **not** gated on the capability. A flag means "I implement this", not
"I require it" (§4.4): anything that validates is merged.

---

## 8. Agent presence

### 8.1 Purpose

Leases say a task is taken. They do not say which agent *should* take it. Routing
work in a swarm needs a directory: role, capabilities, status.

### 8.2 Representation

Key: `@agent/<nodeId>`, where `<nodeId>` **MUST** match `^[0-9a-f]{16}$` — the
exact node-id form from §5.2. A short or malformed id **MUST NOT** own a card
slot: the roster is what agents address each other by, so a card at, say,
`@agent/c` would be a valid entry that any lookup for `c` could resolve to,
delivering a directed message to an unintended peer.

Entry kind **MUST** be `lww`. Value:

```json
{
  "role": "reviewer",
  "capabilities": ["typescript", "tests"],
  "model": "claude-opus-5",
  "status": "idle",
  "task": "refactor-auth",
  "note": "watching CI",
  "at": "2026-07-30T09:14:02.000Z"
}
```

`status` **MUST** be one of `idle`, `working`, `blocked`, `offline`.

| Field | Bound |
|---|---|
| `role` | 1–64 chars, required |
| `capabilities` | ≤32 entries, each ≤64 chars |
| `model` | ≤64 chars |
| `task` | ≤128 chars |
| `note` | ≤200 chars |
| `at` | ISO 8601, ≤64 chars, required. Not validated as a date; an unparseable value renders the card stale (§8.4) rather than rejecting it |

### 8.3 Ownership rule (this is the whole anti-impersonation defence)

An entry under `@agent/<nodeId>` is valid **only if `entry.hlc.n == nodeId`**.

An implementation **MUST** enforce this at the validation boundary, so it applies
to wire frames, relayed snapshots, and the on-disk replica alike. Forging another
agent's card therefore requires stamping as that agent, which §6.4 refuses and a
signature makes infeasible. No new mechanism is introduced.

An implementation **MUST NOT** allow an ordinary key write into `@agent/`; a card
is published through a dedicated operation that derives the key from the node's own
id, so no call shape can write another agent's card.

### 8.4 Liveness

Liveness is **advisory**. A card is **live** when `status != "offline"` and
`now - parse(at) <= PRESENCE_STALE_MS` (**90 000** ms). Agents **SHOULD**
re-announce every `PRESENCE_HEARTBEAT_MS` (**30 000** ms).

An unparseable `at` **MUST** be treated as stale, never as live.

Liveness is derived from the card's own timestamp, not from connection state: a
peer can be connected while its agent is wedged, and a card can be fresh while the
link is briefly down.

---

## 9. Frames

### 9.1 `hello`
See §4.3. **MUST** be first. A second `hello` on one connection **MUST** be ignored.

### 9.2 `update`

```json
{ "type": "update", "v": 4, "ops": [ {...} ] }
```

- 1 … `MAX_OPS_PER_ENVELOPE` (**10 000**) ops; serialized ops ≤ `MAX_PAYLOAD_BYTES`.
- Subject to sender binding (§6.4).

### 9.3 `snapshot`

```json
{ "type": "snapshot", "v": 4, "ops": [ {...} ], "part": 1, "of": 3 }
```

- Sent by both endpoints after negotiation, unless the two hellos' digests match (§5.7).
- 0 … `MAX_OPS_PER_ENVELOPE` ops per part.
- `part` is 1-based. `part`/`of` are omitted when `version < 4`; when `of == 1`
  they MAY be present or absent, and a receiver **MUST** treat their absence as
  `part = 1, of = 1`.
- `of` ≤ `MAX_SNAPSHOT_PARTS` (**512**).
- Merge-only: never authoritative, always merged key-by-key under §5.5. A
  snapshot **MUST NOT** be able to replace a document, delete keys the sender did
  not mention, or overwrite a key it cannot out-stamp.

Receiver requirements:

- **MUST** accept snapshot frames only while the handshake is in progress, and
  **MUST** refuse them once `of` *distinct* parts have been accepted. Parts MAY
  arrive in any order. A snapshot is the one frame carrying stamps the sender did
  not author; admitting one later hands a connected peer a way to keep replaying
  third-party entries.
- **MUST** bound the window with a deadline as well as a part count
  (`SNAPSHOT_WINDOW_MS`, reference **120 000** ms). Counting alone is not enough:
  a peer that declares `of: 512` and sends one part would otherwise hold relay
  rights for the life of the connection.
- **MUST** reject a repeated `part` number. Without this a peer can resend one
  part indefinitely, spending the op budget again on each pass.
- **MUST** close the connection if `of` changes mid-transfer, or if `part > of`.
- **MUST** bound total ops across all parts. Reference:
  `MAX_CRDT_KEYS + MAX_CLAIM_KEYS` = **11 000**.
- **SHOULD** merge each part as it arrives. Merge is commutative and idempotent,
  so nothing needs buffering and a transfer cut short leaves the receiver strictly
  better off.

A sender whose replica exceeds one frame and whose peer lacks `chunk` **MUST NOT**
send an oversized frame. It **SHOULD** log that the document cannot be replicated
to that peer.

### 9.4 `message`

```json
{ "type": "message", "v": 4, "text": "...", "id": "uuid", "to": "<64 hex>", "corr": "abc123", "intent": "ask" }
```

| Field | Bound | Meaning |
|---|---|---|
| `text` | 1 … `MAX_PAYLOAD_BYTES` | Body |
| `id` | ≤64 chars | Delivery id, for ack and dedupe |
| `to` | exactly 64 lowercase hex | Addressee's public key; absent = broadcast |
| `corr` | 1–64 chars | Correlation id tying a reply to its question |
| `intent` | `tell` \| `ask` \| `reply` | What the sender wants |

- A receiver that is **not** the addressee **MUST** drop the frame without
  logging, recording, or raising an event for it.
- `text` is peer-authored. An implementation **MUST** present it to an agent as
  data, never as instructions, and **SHOULD** say so explicitly in the surface it
  exposes.

### 9.5 `ack`

```json
{ "type": "ack", "v": 4, "ids": ["uuid"] }
```

1 … 200 ids. Delivery is **at-least-once** on the wire; the receiver makes it
appear exactly-once by ignoring an id it has already handled while still
acknowledging it, because a duplicate means the previous ack was lost.

Dedupe state **MUST** be scoped **per sender**. A shared id space lets one peer
pre-claim an id so another peer's real message is discarded as a duplicate.

### 9.6 `bye`

```json
{ "type": "bye", "v": 4, "reason": "version-mismatch", "detail": "peer speaks v9, this node speaks v3-v4" }
```

Reasons: `version-mismatch`, `unauthorized`, `rate-limit`, `oversized`,
`malformed`, `slow-consumer`, `shutdown`.

`reason` is 1–64 characters and `detail` at most 500; a frame exceeding either is
silently dropped like any other invalid frame, so an over-long `bye` conveys
nothing.

An implementation **SHOULD** send `bye` before closing for a protocol reason, and
**SHOULD** surface `reason` to the operator. The purpose of this frame is that a
human reading a log learns why two machines will not talk.

---

## 10. Bounds (normative)

Every value here is a defence against a peer, not a tuning parameter.

### 10.1 Document

| Bound | Value |
|---|---|
| `MAX_CRDT_KEYS` | 10 000 (live keys; tombstones excluded) |
| `MAX_CLAIM_KEYS` | 1 000 (separate budget, so leases cannot crowd out context) |
| `MAX_TASK_KEYS` | 500 (separate budget again; see §7A.6) |
| `MAX_SET_ELEMENTS` | 5 000 per set |
| `MAX_SET_TOMBSTONES` | 10 000 per set |
| `MAX_VALUE_BYTES` | 65 536 per entry |
| `MAX_KEY_LENGTH` | 256 |
| `MAX_JSON_DEPTH` | 32 |

Depth **MUST** be checked before anything walks a value: `JSON.parse` will build a
structure deeper than the stack can traverse, so a modest payload can crash a
later serialization pass.

### 10.2 Deterministic truncation

When a set exceeds its element or tombstone cap, an implementation **MUST**
truncate by **sorted tag** rather than refusing the merge. Refusal is not
commutative — whichever op arrived first would survive, so two replicas fed the
same ops in different orders keep different elements forever. Truncation by sorted
tag is a pure function of the merged content.

Tombstoned tags **MUST** be retained during truncation; dropping one resurrects
its element.

### 10.3 Rate and flow control

An implementation **MUST** bound inbound rate per connection and **MUST** respect
outbound backpressure.

| Bound | Reference value |
|---|---|
| Envelope burst / refill | 600 frames / 100 per second |
| Byte burst / refill | 64 MiB / 8 MiB per second |
| Outbound queue ceiling | 8 MiB, then close (`slow-consumer`) |

Two independent buckets are REQUIRED: a flood of tiny valid frames is cheap on
bandwidth but expensive per frame, and one enormous frame is the reverse. Bursts
**MUST** be large enough to admit a legitimate chunked snapshot, or the handshake
trips the limiter protecting it.

Accounting is as important as the buckets:

- A frame **MUST** be charged its **raw on-the-wire length**, including the line
  terminator, **before** any trimming or parsing. Charging the trimmed length lets
  a peer prepend a megabyte of whitespace for the price of the payload.
- A blank or whitespace-only line **MUST** be charged too. Skipping empty lines
  before the accounting lets an endless stream of newlines through for free.

Ignoring a transport's "buffer full" signal is a defect: against a peer that has
stopped reading it grows memory without limit. An implementation **MUST** queue
subsequent frames once the transport reports saturation and **MUST** preserve
frame order across the drain. Gating the queue on "is the queue non-empty" is not
sufficient — the queue never becomes non-empty, so the ceiling is never reached
and the buffering is unbounded in practice.

---

## 11. Conformance vectors

An implementation **SHOULD** reproduce these exactly.

### 11.1 HLC ordering

```
A = {w:100, c:0, n:"aaaa"}   B = {w:100, c:1, n:"aaaa"}   → B > A
C = {w:100, c:0, n:"bbbb"}                                → C > A
D = {w:101, c:0, n:"aaaa"}                                → D > B
```

### 11.2 Canonical JSON

| Input | Output |
|---|---|
| `{"b":1,"a":2}` | `{"a":2,"b":1}` |
| `{"outer":{"z":1,"a":2}}` | `{"outer":{"a":2,"z":1}}` |
| `[1,{"b":1,"a":2}]` | `[1,{"a":2,"b":1}]` |
| `null` | `null` |

### 11.3 Signed bytes

For `key = "plan"`, `entry = {"kind":"lww","hlc":{"w":1,"c":0,"n":"aaaaaaaaaaaaaaaa"},"value":"x"}`:

```
p2pa-op-v1\nplan\n{"hlc":{"c":0,"n":"aaaaaaaaaaaaaaaa","w":1},"kind":"lww","value":"x"}
```

### 11.4 Lease merge

```
{gen:0, w:100, n:"aaaa"} vs {gen:0, w:200, n:"bbbb"}  → first wins  (earliest, FCFS)
{gen:1, w:300, n:"bbbb"} vs {gen:0, w:100, n:"aaaa"}  → first wins  (higher gen)
{gen:1, w:300, n:"bbbb", released:true} vs {gen:1, w:300, n:"bbbb"} → released wins
```

### 11.5 Negotiation

| local | remote | result |
|---|---|---|
| 3–4 | 3–4 | v4 |
| 3–4 | 3–3 | v3 |
| 3–4 | 9–9 | incompatible |
| 3–4 | 5–2 | incompatible (invalid range) |
| caps `[sig,chunk]` | caps `[sig,telepathy]` | `{sig}` |

### 11.6 Task merge

```
status join:      open ⊔ done = done       failed ⊔ cancelled = failed
                  done ⊔ cancelled = done  done ⊔ failed = done
attempts join:    2 ⊔ 5 = 5
deps join:        ["a"] ⊔ ["b"] = ["a","b"]        (sorted)
descriptor:       {w:100,n:"aaaa",title:"X",pri:5} ⊔ {w:200,n:"bbbb",title:"Y",pri:1}
                  → title "Y", priority 1, hlc {w:200,n:"bbbb"}
result:           {w:100,result:"early"} ⊔ {w:200,result:"late"} → "late"
idempotence:      x ⊔ x ≡ x  (content-identical, including signature)
```

Every vector is symmetric: swapping the two operands **MUST** give the same
answer.

Idempotence holds over **canonical** entries — those whose `deps` and `needs` are
deduplicated and sorted (§7A.2). An entry in any other form is refused at the
validation boundary, so it can never be seated and the vector is total over
everything a replica can hold.

---

## 12. Security model

### 12.1 What holds

| Property | Mechanism |
|---|---|
| Only paired peers connect | Allowlist enforced pre-handshake (§3) |
| A peer cannot write as another, directly | Sender binding (§6.4) |
| A peer cannot present a *forged* signature | Verification on merge (§6.4) — holds unconditionally |
| A peer cannot write as another, via relay | Per-op signatures (§6) — **only with `requireSignatures` on** (§6.5); with it off an *unsigned* relayed entry is still accepted |
| A peer cannot write as *us* | Own-identity rule (§6.4) |
| A peer cannot forge an agent card | Ownership rule (§8.3) stops a card in the *wrong slot* unconditionally. A card in its correct slot, fabricated and relayed, is stopped only with `requireSignatures` (§6.5) |
| A peer cannot end another's lease | A release carries the holder's stamp (§7.3), so forging one directly is refused by sender binding; via relay, only with `requireSignatures`. Note a peer *can* legitimately displace a live lease with a higher generation — see §7.4 |
| A peer cannot reopen a settled task | The status join is monotone (§7A.3) — a late `open` is discarded |
| A peer cannot replace the document | Snapshots are merge-only (§9.3) |
| A peer cannot wedge our clock | Skew ceiling (§5.3) |
| A peer cannot exhaust memory | §10 bounds, §10.3 rate and flow control |
| A peer cannot silently drop our sync | Negotiation + `bye` (§4.3, §9.6) |

### 12.2 What does not

- **Confidentiality between paired peers.** Every allowlisted peer sees the whole
  document. There is no per-key access control.
- **Unsigned relays under default policy.** With `requireSignatures` off, a
  three-node swarm permits fabricated attribution in a relayed snapshot. §6.5.
- **Merged OR-set attribution.** §6.6.
- **Lease exclusivity across a partition.** §7.4, and §7A.4 for the backlog,
  which inherits it.
- **Backlog integrity against an authorized peer.** `@task/` is the one namespace
  that is not owner-bound (§7A.5). An authorized peer can mark your work `done`
  with a fabricated `result`, or `cancelled` so nobody picks it up. This widens
  what a peer *inside* the allowlist can do, not who is inside it — such a peer
  could already write any state key and take any lease. `createdBy` is
  peer-chosen and is not an identity; the signature on the op and `hlc.n` are.
  Merge is monotone, so the destructive direction is one-way.
- **Result durability under a concurrent descriptor write.** §7A.3: a completion
  can lose its `result` — never its `done` status — to a concurrent write with a
  higher stamp on the same id.
- **Backlog eviction as a deletion primitive.** §7A.6 lets a write at the budget
  drop the longest-settled task. Because `@task/` is not owner-bound, an
  authorized peer can settle a task of yours and then fill the remaining budget
  with open tasks, leaving that one entry as the only eviction candidate — so its
  own next task operation evicts that entry, without needing you to write
  anything. Before eviction existed the
  same peer had to wait out `TASK_RETENTION_MS`. This is a faster route to an
  outcome §12.2 already grants such a peer (it can overwrite your result outright,
  or cancel the task), not a new class of power, but it is a real capability and
  is recorded here rather than left to be discovered.
- **Topic secrecy.** A leaked topic reveals that a swarm exists and allows
  connection attempts. In `strict` mode it grants no access.
- **Peer-supplied text.** `label`, `note`, `role`, `capabilities`, `text`,
  `corr`, and `bye.reason`/`bye.detail` are peer-authored. They **MUST** be
  sanitized before display — including into operator logs, not only into the
  audit file, since control characters and ANSI escapes can forge log lines or
  drive a terminal — and **MUST NOT** be treated as instructions by an agent.

---

## 13. Version history

| Version | Change |
|---|---|
| 1 | Whole-document counter (`_version`). Could not express concurrent writes. |
| 2 | Per-key CRDT with HLC stamps. Replaced the counter. |
| 3 | Message ids and `ack` for durable delivery. |
| 4 | `hello` negotiation and capabilities; per-op signatures; chunked snapshots; addressed messages with correlation; agent presence; `bye`; rate and flow control. |

Versions 1 and 2 are retired and **MUST NOT** be accepted.

The `@task/` namespace (§7A) is **not** a version. It is negotiated by the `task`
capability, per §14.3 — see the note there.

---

## 14. Extending this protocol

1. **Additive fields** need no version bump; unknown fields are ignored (§4.1).
2. **New frame types** need no version bump; unknown types are ignored (§4.1).
3. **New behaviour negotiated by capability** needs a `caps` token and no version
   bump.
4. **Changed semantics of an existing field** needs a version bump and an entry in
   §13.

Prefer 1–3. A version bump costs every operator an upgrade; a capability flag
costs nothing and degrades cleanly.

**A new entry kind is case 3, never case 1.** §4.1's "unknown fields MUST be
ignored" covers *fields* and *frame types*. An entry `kind` is discriminated, not
additive, so a receiver that does not know it rejects the **whole frame** carrying
it rather than the one operation. A new entry kind therefore always requires a
capability token *and* a sending-side gate that strips it from every frame written
to a peer that lacks the token (§7A.7). Without that gate the new kind does not
degrade — it silently stops the older peer syncing anything at all.

A bump would also buy nothing here: negotiation settles on `min(local.max,
remote.max)`, so a newer node talking to an older one lands on the older version
and would *still* need a per-connection gate to decide whether to send the new
kind. The version would be a second, redundant name for the capability.
