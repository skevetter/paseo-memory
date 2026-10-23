Local memory for Paseo agents. Agents save decisions, conventions and fixes, and new agents receive the memories that match their task.

Memory has two scopes. Global memory reaches every agent. Project memory is keyed by git remote, so worktrees share it. Search combines keyword and vector matches, then re-ranks the top results.

An agent reaches global memory and the memory of its own project, never another project. When Paseo cannot resolve an agent's project, the agent reaches global memory only and its start prompt says why. Only the owner panel browses every project.

## How it works

- New agents receive a memory block in their system prompt: matches for the first prompt, pinned memories, recent project and global memories, and recent sessions.
- Agents get MCP tools to search, read, save, update and delete memories. Arguments are validated before anything runs: a malformed call returns an `invalid_input` error and changes nothing. An id outside the agent's scope reads as not found, and the audit records the denial without the request text.
- Each turn records the prompt, the reply and the edited files. Tool output is not stored.
- An idle agent receives one prompt to summarize its session and make up to 3 memory changes. Creates, topic upserts and direct updates share one atomic cap, including concurrent calls. Unchanged, duplicate and failed writes do not use a slot; retrying the same request returns its receipt. The review shows as one collapsed line in the chat.
- A daily job suggests duplicate merges, flags possible conflicts and lists stale memories. Approximate matches are suggestions only. Automatic merging requires the same canonical title and content, type, namespace, source, agent/provider authority and pin state; it never crosses global/project boundaries. Merges require current revisions, retain both snapshots and can be undone from the merged memory, preserving its ID and history.
- The Memory panel shows memories, sessions, a review queue and what each agent received.

## Setup

- macOS or Linux, arm64 or x64.
- Bun 1.4 or later on the daemon host.
- macOS: Homebrew SQLite. Apple's SQLite cannot load extensions.
- Paseo 0.11.0-beta.5 or later.

## Settings

The settings screen controls how much memory each agent receives, the session review trigger, the embedding tier and re-ranking, and upkeep. Each setting has help text.

## Data and network

- The plugin starts a Bun child process that serves MCP and an internal API on `127.0.0.1:6797`.
- Data is stored in `$PASEO_HOME/plugin-data/paseo-memory/memory.db`.
- Each memory carries an index generation that changes with its text, type or scope. A vector is stored only if the memory still has the generation the embedder saw, so a memory that moves between projects while it is being indexed never becomes searchable in its old project. A search drops any hit whose scope, text or state changed while it ran.
- A failed embedding batch retries with backoff, up to 5 attempts per memory. Keyword search keeps working, and Settings shows how many memories could not be indexed.
- Upgrading to schema v6 first writes a consistent backup next to the database (`memory.db.pre-v6-from-v5.bak`) and marks existing vectors stale. They are rebuilt in the background; keyword search is available meanwhile. A database written by a newer schema is refused, not modified.
- On first start the plugin runs `bun install` in its directory to fetch its runtime packages, about 480 MB.
- Embedding and re-ranking models download from Hugging Face on first use, 30 MB to 337 MB per tier. Models run on the host. No memory content leaves the host.
- Secrets in common formats are redacted before saving.
- The session review uses one agent turn. Its memory-change cap is not a provider-token or cost cap. Each review also allows at most the larger of 20 mutation attempts or twice its change cap, including failed and malformed writes. The cap and receipts survive service restarts. After 15 minutes, the review blocks further changes until its end event; expiry never makes it unrestricted.
- Review receipts and merge snapshots complete the additive v6 schema. Opening an M02-only v6 database backs it up before adding those tables, without invalidating already-current vectors.
