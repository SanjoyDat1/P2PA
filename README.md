# P2PA

> Headless, peer-to-peer context synchronization for local AI agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Stop copy-pasting prompts between agents. **P2PA** is a local-first [MCP](https://modelcontextprotocol.io) toolkit that lets multiple LLM agents (Cursor, Claude Code, Claude Desktop, or custom scripts) share structured context, pass messages, and resolve state conflicts over a serverless P2P network.

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
- **RFC 6902 JSON Patch** — Surgical updates instead of full context dumps.
- **Versioned conflict detection** — Concurrent edits to the same state enqueue a collision for the local LLM to resolve.
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

    MCPA <-->|Hyperswarm · NDJSON · JSON Patch| MCPB
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
| `shared_context.md` | Active State + Conflicts + Audit Trail |
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
| `push_context` | Set a top-level key, bump `_version`, sync markdown, broadcast a JSON Patch |
| `patch_context` | Apply an RFC 6902 patch for surgical, low-token updates |
| `pull_context` | Read one key or the entire in-memory state |
| `send_peer_message` | Send a text message into the peer’s audit trail |
| `check_conflicts` | Inspect queued collisions before merging |
| `resolve_conflict` | Resolve the oldest collision: `accept_peer`, `keep_local`, or `custom_merge` |
| `read_context_history` | Read the last *N* lines of the local markdown log |
| `doc_publish` | Push status / plan / agent_log to the linked Google Doc |
| `doc_read_steering` | Read HUMAN directives (optional force poll) |
| `doc_status` | Living-doc link + poll health (no secrets) |

### Conflict flow

1. Each local mutation increments a Lamport-style `_version` clock and includes it in the broadcast patch.
2. Peers apply only **strict successors** (`localVersion + 1`). Equal, missing, or gapped versions → **collision**.
3. Collisions appear under `## Conflicts` in the markdown log and in `check_conflicts`.
4. The agent calls `resolve_conflict` to merge; the Conflicts section clears and the Audit Trail records the resolution.

---

## Local audit log

Every patch, snapshot handshake, peer message, and conflict is written to a human-readable markdown file at `~/.p2pa/shared_context.md`.

The file has three sections:

1. **Active State** — current shared JSON (including `_version`)
2. **Conflicts** — pending collisions awaiting `resolve_conflict` (omitted when empty)
3. **Audit Trail** — append-only history of patches, messages, and resolutions

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
npm run smoke:conflict   # versioned collision + resolve strategies
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
