# P2PA

> Headless, peer-to-peer context synchronization for local AI agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Stop copy-pasting prompts between agents. **P2PA** is a local-first [MCP](https://modelcontextprotocol.io) toolkit that lets multiple LLM agents (Cursor, Claude Code, Claude Desktop, or custom scripts) share structured context, pass messages, and merge concurrent edits over a serverless P2P network.

Built for founders and engineering teams who want multiplayer AI without leaving their IDE.

---

## The problem

Multi-agent collaboration is still broken in three ways:

1. **Ephemeral silos** — When a local agent finishes a hard task, its working memory dies. Your teammate’s agent starts from zero.
2. **Token bloat** — Many “multi-agent” setups shuttle entire context windows through a central cloud, burning tokens and adding latency.
3. **Walled gardens** — Collaboration often means leaving the terminal for a proprietary dashboard.

## The solution

**P2PA** keeps a shared JSON state buffer on each machine and syncs **only the diffs**:

- **Hyperswarm** — DHT discovery + NAT traversal. No central server.
- **Key-based peer authentication** — Only allowlisted ed25519 keys can connect. No inbound access from a leaked topic.
- **Per-key CRDT merge** — Every key carries its own hybrid logical clock. Two agents writing different keys never conflict; two agents writing the same key resolve to the same winner on every replica, with no arbitration step.
- **Add-wins sets** — Concurrent appends to a list all survive, instead of one agent's entries overwriting the other's.
- **Work-claiming leases** — An agent claims a task before starting it, so two agents never do the same job. Leases expire on their own, so a crashed agent cannot block the backlog.
- **Event-driven, not polling** — An agent can block until the other one actually does something, instead of hoping it remembers to check.
- **Messages survive a disconnect** — Write to a peer whose agent is offline and it is delivered when they return. Nobody has to resend.
- **Human-readable audit log** — Every change lands in `~/.p2pa/shared_context.md`, attributed to the peer that made it.

---

## Architecture

```mermaid
graph TD
    subgraph MachineA [Machine A]
        AgentA[Local agent / Cursor] <-->|stdio MCP| MCPA[p2pa mcp]
        MCPA <--> StoreA[(In-memory state)]
        MCPA -->|Active State + Audit Trail| LogA["~/.p2pa/shared_context.md"]
    end

    subgraph MachineB [Machine B]
        AgentB[Local agent / Cursor] <-->|stdio MCP| MCPB[p2pa mcp]
        MCPB <--> StoreB[(In-memory state)]
        MCPB -->|Active State + Audit Trail| LogB["~/.p2pa/shared_context.md"]
    end

    MCPA <-->|Hyperswarm · NDJSON · CRDT ops| MCPB
```

**Two process modes (same on-disk state):**

| Mode | Command | Use when |
|------|---------|----------|
| **MCP (foreground)** | `p2pa mcp` | Connecting Cursor / Claude — owns clean stdio |
| **Daemon (background)** | `p2pa start` | Optional Hyperswarm sync via PM2 (no MCP stdio) |

Prefer **one writer** at a time. Agents should use `p2pa mcp` via MCP config; use the daemon only when you want background sync without an IDE client.

---

## Quick start

### 1. Install

```bash
npm install -g p2pa
# or from this repo:
npm install && npm run build && npm link
```

Requires **Node.js 18+**.

### 2. Pair two machines

Pairing is **mutual and key-based**: each side allowlists the other's public key, and only allowlisted peers can connect.

On machine A:

```bash
p2pa pair            # prints an invite token — send it to B
```

On machine B:

```bash
p2pa pair <A's token>   # allowlists A, adopts A's topic, prints B's token
```

Back on machine A:

```bash
p2pa pair <B's token>   # allowlists B — pairing complete
p2pa peers              # confirm
```

Then start syncing:

```bash
p2pa start           # background daemon (both machines)
```

An invite token carries the pairing topic, so **treat it like a password** and send it over a channel you already trust. See [Peer authentication](#peer-authentication) for the full model.

### 3. Connect your IDE agent

```bash
p2pa connect
```

Paste the printed JSON into:

- **Cursor** → MCP settings  
- **Claude Desktop** → `claude_desktop_config.json`

That config runs `p2pa mcp` over stdio so tools appear in the agent.

### 4. Watch agents collaborate

```bash
p2pa log          # live tail of the markdown audit log
p2pa status       # daemon online? topic fingerprint?
p2pa stop         # stop the PM2 daemon
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `p2pa start [--topic <code>]` | Start background Hyperswarm daemon (PM2) |
| `p2pa stop` | Stop the daemon |
| `p2pa status` | Daemon status, identity, topic fingerprint, auth mode |
| `p2pa log` | Tail `~/.p2pa/shared_context.md` |
| `p2pa connect` | Print MCP JSON for Cursor / Claude Desktop |
| `p2pa mcp` | Run foreground MCP + P2P server (stdio) |
| `p2pa pair [--label <name>]` | Print your invite token |
| `p2pa pair <token> [--adopt-topic]` | Allowlist a peer from their token |
| `p2pa peers` | List allowlisted peers |
| `p2pa peers remove <pubkey\|label>` | Revoke a peer |
| `p2pa auth <strict\|open>` | Set the connection policy |
| `p2pa doc create [--title]` | Create a Google Doc war room + anyone-with-link edit |
| `p2pa doc link <url>` | Bind an existing Google Doc |
| `p2pa doc unlink` | Clear the doc binding |
| `p2pa doc status` | Show linked doc + whether SA credentials are set |

Config and state live under **`~/.p2pa/`** (mode `0700`):

| Path | Purpose |
|------|---------|
| `config.json` | Pairing topic, auth mode, peer allowlist, optional doc link (`0600`) |
| `identity.json` | This node's 32-byte identity seed (`0600`) — never share |
| `shared_context.md` | Active State + Replica State + Concurrent Updates + Audit Trail |
| `daemon-error.log` | Daemon diagnostics (not mixed into MCP stdout) |

Override the config directory with `P2PA_CONFIG_DIR` (must stay under your home directory).

---

## Peer authentication

### Why the topic alone is not enough

A Hyperswarm topic is a **discovery identifier, not a secret**. `sha256(topic)` is the DHT key your node announces under, and the DHT nodes nearest that key in keyspace necessarily learn it. Anyone who obtains it — by being in that neighbourhood, or because the topic leaked from a shell history, a `ps` listing, or a chat log — could previously connect and get full read/write on your shared context.

P2PA now treats the topic as **discovery only** and authenticates peers by public key.

### How it works

Each install generates a stable ed25519 keypair on first run, derived from a 32-byte seed in `~/.p2pa/identity.json` (`0600`). That public key is your node's permanent address on the swarm.

Hyperswarm's Noise handshake already proves a peer holds the secret key for the public key it presents. P2PA hooks the `firewall` callback — which runs on **both inbound and outbound** connection attempts — and refuses any key that is not on your allowlist. An unauthorized peer is dropped before a single byte of application data is exchanged, so it can neither read your state via the handshake snapshot nor write it via a patch.

> Envelopes are deliberately **not** individually signed. The transport is already authenticated end-to-end to the remote's static key, and P2PA never relays or gossips messages on behalf of a third party, so per-message signatures would add cost without adding a guarantee.

### Auth modes

| Mode | Behaviour |
|------|-----------|
| `strict` | Only allowlisted public keys may connect. **Default for new installs.** |
| `open` | Anyone who knows the topic may connect (pre-0.7 behaviour). |

Upgrading will not sever a working pairing: a config written before this feature has no `auth` field and resolves to `open`, with a warning on every start until you run `p2pa auth strict`.

```bash
p2pa peers          # who can connect, and in which mode
p2pa auth strict    # lock it down (takes effect on next restart)
```

Changing the **allowlist** is picked up live by running nodes — pairing a peer connects it without a restart, and revoking one drops its open connection immediately. Changing the **auth mode** requires a restart.

### Attribution

Every peer-sourced entry in the audit trail now records which peer acted, keyed by the Noise-authenticated public key:

```
### [2026-07-25 10:14:02] - [SOURCE: Peer a3f9c1b2 (sanjoy-laptop)] - [ACTION: State Patch]
```

Labels are peer-supplied and sanitized (control characters and Markdown structure stripped) so a peer cannot forge audit entries through its own name. The fingerprint is the identity; the label is a convenience.

### Rotating

- **A peer's key** — `p2pa peers remove <pubkey>`, then re-pair.
- **Your own key** — delete `~/.p2pa/identity.json` and restart. Every peer must re-pair with your new key.
- **The topic** — `p2pa start --topic <new>` on each machine, or re-pair with `--adopt-topic`.

---

## Living doc (Google Docs steering)

Agents sync machine state over P2P; **humans steer in a shared Google Doc** anyone with the link can edit.

```
Humans edit "## HUMAN directives"  →  poller  →  Active State key `steering`
Agents call doc_publish            →  Status / Plan / Agent log sections
```

### One-time Google setup

1. Create a Google Cloud project; enable **Google Docs API** and **Google Drive API**.
2. Create a **service account**, download its JSON key.
3. Export the path (never commit the key; never put it in shared context):

```bash
export P2PA_GOOGLE_SA_JSON="$HOME/.p2pa/google-sa.json"
# chmod 600 the key file — path only (never paste the JSON into env / MCP config)
```

4. Create or link a doc:

```bash
p2pa doc create --title "Auth refactor war room"
# or: p2pa doc link "https://docs.google.com/document/d/…/edit"
p2pa doc status
```

5. Put `P2PA_GOOGLE_SA_JSON` in your MCP env (`p2pa connect` copies it if already set in your shell), then restart MCP.

Doc sections (exact headings):

| Section | Who writes |
|---------|------------|
| `## Status` | Agents (`doc_publish` section=status) |
| `## Plan` | Agents (`doc_publish` section=plan) |
| `## HUMAN directives` | Humans (append steering; polled into `steering`) |
| `## Agent log` | Agents (append-only via `doc_publish` section=agent_log) |

Agents keep running while you edit. They read steering with `doc_read_steering` or `pull_context` key `steering`.

Optional: `P2PA_DOC_POLL_MS` (default `4000`).

---

## MCP tools

Once connected, agents can call:

| Tool | What it does |
|------|----------------|
| `push_context` | Set a top-level key and broadcast it |
| `delete_context` | Tombstone a key so a stale replica cannot resurrect it |
| `set_add` / `set_remove` | Add-wins set operations for lists two agents both append to |
| `pull_context` | Read one key or the entire in-memory state |
| `send_peer_message` | Send a text message into the peer’s audit trail |
| `check_conflicts` | List recent concurrent updates (already settled; informational) |
| `override_context` | Impose your own values when the automatic winner is wrong by intent |
| `claim_task` | Take a lease on a task so a peer does not start the same work |
| `release_task` | Hand a task back before its lease expires |
| `list_claims` | See which tasks are in flight and who holds them |
| `send_peer_message` | Message your peers; queued and retried if they are offline |
| `outbox_status` | Messages still awaiting confirmation |
| `await_peer_event` | Block until a peer acts, then return what they did |
| `recent_peer_events` | Catch up on peer activity without blocking |
| `sync_health` | Replica id, content hash, peer count — equal hashes mean equal state |
| `read_context_history` | Read the last *N* lines of the local markdown log |
| `doc_publish` | Push status / plan / agent_log to the linked Google Doc |
| `doc_read_steering` | Read HUMAN directives (optional force poll) |
| `doc_status` | Living-doc link + poll health (no secrets) |

### Claiming work

State sync stops two agents overwriting each other; it does not stop them doing
the same job twice. A lease fixes that:

```
Agent A: claim_task("refactor-auth")   → holds it until 14:32
Agent B: claim_task("refactor-auth")   → already held by a3f9c1b2, picks another task
```

- **Exactly one holder.** Two agents racing for the same task converge on one
  winner, in any delivery order, without asking each other.
- **First come, first served.** Within a lease generation the earliest claim
  wins, so an honest agent cannot take a task by simply writing again.
- **Leases expire.** A crashed agent stops blocking the task once its TTL runs
  out; whoever claims next takes the following generation, so a stale op from
  the dead lease can never reinstate it.
- **Release is final.** Handing a task back cannot be undone by a claim that was
  still in flight.

`claim_task` waits one propagation window before answering, so an agent is never
told it owns work it has already lost.

Two honest limitations:

- Two *partitioned* nodes can both believe they hold the same lease until they
  can talk again. No protocol without a quorum can avoid that, and P2PA has no
  quorum by design. The lease narrows duplicate work to the propagation delay —
  it is not a distributed mutex.
- A lease protects against races, not against a hostile peer. An allowlisted
  peer can bid a higher generation and take a live lease, just as it can
  overwrite any state key. Displaced leases surface in `check_conflicts` and the
  audit trail. Pair with peers you trust.

### Leaving word for an offline peer

Messages used to go straight to whatever sockets were open, so anything written
while the other agent was asleep, restarting, or on a train was simply lost.

A message is now queued first and sent second:

```
Agent A: send_peer_message("auth refactor is done")   → nobody online, queued
                    … Agent B starts up …
Agent B: ← receives it automatically on connect
```

- **Queued before sending**, so a socket that drops mid-flight loses nothing.
- **Retried until confirmed.** A message is only dropped once the recipient
  acknowledges it, so "written to the socket" is never mistaken for "received".
- **Delivered exactly once as far as the agent can tell.** Replay is
  at-least-once; the receiver dedupes by message id, so a replay is not logged
  or surfaced twice.
- **Survives a restart of either side** — the queue and the seen-ids are on disk.

Bounded, since a peer that never returns must not grow the file forever: 500
messages, given up after 7 days, replayed 100 at a time. Anything given up on is
counted in `outbox_status` rather than vanishing quietly.

A message is addressed to the peers you were paired with when you sent it, and
replayed only to peers you have actually paired with — a node that joins later
does not receive the earlier conversation.

### Waiting on the other agent

Every other tool is pull-only, which means an agent learns a peer did something
only if it happens to call one — and an LLM does not do that unprompted. So one
agent talks and the other never hears it.

```
Agent B: await_peer_event()                  → blocks
Agent A: claim_task("refactor-auth")
Agent B: ← wakes with { kind: "claim", taskId: "refactor-auth", … }
```

Events carry a `seq`. Pass the highest one you have seen back as `since_seq` and
nothing is missed between calls, even if you were busy when it happened. A
timeout returns an empty list rather than an error — "nothing happened" is an
ordinary answer.

Clients that support MCP resource subscriptions can instead watch
`p2pa://events` and get nudged on each peer action, without parking a tool call.

### How merge works

1. Every local write stamps its key with a hybrid logical clock: wall time, a
   counter, and this node's id.
2. Peers merge each key independently. Writes to **different keys always merge** —
   there is no document-wide version to contend over.
3. Writes to the **same key** resolve by stamp order. The comparison is total and
   identical on every replica, so all peers pick the same winner without talking
   to each other.
4. The losing write is recorded under `## Concurrent Updates` and surfaced by
   `check_conflicts`. Nothing is blocked waiting on it.
5. If the automatic winner is wrong by intent, `override_context` writes the value
   you want; it out-stamps what it replaces and propagates normally.

Stamps are bounded: an entry claiming a clock more than 24h ahead of local time is
refused and recorded, so a peer cannot saturate a replica's clock or use a
handshake snapshot to overwrite state it never held.

Every update, snapshot handshake, peer message, and refusal is written to a human-readable markdown file at `~/.p2pa/shared_context.md`.

The file has five sections:

1. **Active State** — current shared JSON, plain and human-readable
2. **Replica State** — the same document plus per-key stamps (machine-managed)
3. **Claims** — which tasks are in flight and who holds them (omitted when empty)
4. **Concurrent Updates** — recent settled contention (omitted when empty)
5. **Audit Trail** — append-only history of patches, messages, and resolutions

Tail it during development:

```bash
p2pa log
```

---

## Security notes

- In `strict` mode (the default) the **peer allowlist is the access-control boundary** — a topic leak alone no longer grants access. See [Peer authentication](#peer-authentication).
- The **topic is still discovery material, not a secret** — it is announced on the public DHT. Prefer long random topics (auto-generated codes are 22 characters), and avoid `--topic` on the command line, where it lands in shell history and `ps` output. Use `p2pa pair` or `P2PA_TOPIC` instead.
- In `open` mode there is no authentication at all: anyone who learns the topic can read and write your shared state. Only use it to keep a pre-0.7 pairing alive while you migrate.
- **`identity.json` is your node's private key material.** Never copy it between machines — two nodes sharing a keypair cannot be told apart or revoked independently.
- The **Google Doc link is also a capability** — with “anyone with the link = editor,” anyone who has the URL can steer agents via HUMAN directives. Rotate by creating a new doc + `p2pa doc unlink`.
- Service account JSON (`P2PA_GOOGLE_SA_JSON`) must stay on disk / in MCP env only — never in Active State, the Doc, or P2P patches.
- Config directory defaults to `0700`; `config.json` is written as `0600`.
- Do not put credentials or production secrets into shared context.
- Background daemon logs go to `daemon-error.log` so MCP stdout stays a clean JSON-RPC stream.

---

## Development

```bash
git clone <your-repo-url>
cd P2PA
npm install
npm run build
npm test                 # unit + integration suite (offline)
npm run smoke            # Hyperswarm two-node sync (needs internet)
npm run smoke:merge      # concurrent merge, same-key resolution, set adds
npm run smoke:claim      # two agents racing the same backlog
npm run smoke:outbox     # a message left for an offline peer
npm run smoke:doc        # living-doc bridge (mock Google Docs, no keys)
```

`npm test` runs entirely offline — the peer-authentication integration tests spin up an in-process `hyperdht` testnet, so they exercise the real firewall against real connections without touching the public DHT.

Package entrypoint: `p2pa` → `dist/cli.js`.

---

## Roadmap ideas

- Notion / other living-doc adapters  
- Single-writer lock when daemon + MCP both run (partially covered by doc-bridge.lock)  
- Optional Streamable HTTP transport alongside stdio  
- Richer CRDT or vector-clock merge policies  

---

## License

[MIT](./LICENSE)

Built for the next generation of multi-agent development.
