Local memory for Paseo agents. Agents propose durable decisions, conventions and fixes. New agents receive authorized active memories matching their task.

Memory has two scopes. Global memory reaches every agent. Project memory is keyed by git remote, so worktrees share it. Search combines keyword and vector matches, then re-ranks the top results.

An agent reaches global memory and the memory of its own project, never another project. When Paseo cannot resolve an agent's project, the agent reaches global memory only and its start prompt says why. Only the owner panel browses every project.

## How it works

- New agents receive a memory block in their system prompt: matches for the first prompt, pinned memories, recent project and global memories, and recent sessions.
- Agents get MCP tools to search, read, propose and correct memories. Arguments and namespace grants are checked before a write. New assertions and corrections remain candidates until authorized promotion; they are not automatically injected as facts. Missing and inaccessible IDs return the same unavailable result, and denial audits omit request content.
- Each turn records the prompt, the reply and the edited files. Tool output is not stored.
- An idle agent receives one prompt to summarize its session and make up to 3 memory changes. Creates, topic upserts and direct updates share one atomic cap, including concurrent calls. Unchanged, duplicate and failed writes do not use a slot; retrying the same request returns its receipt. The review shows as one collapsed line in the chat.
- A daily job suggests duplicate merges, flags possible conflicts and lists stale memories. Approximate matches remain suggestions. Automatic merging requires equal canonical text, type, namespace, source/agent/provider authority, pin state, record kind, verification and validity. Merges and undo use current revisions, preserve IDs and retain complete history and evidence lineage.
- The Memory panel shows memories, sessions, a review queue and what each agent received.
- Canonical revisions disclose evidence, verification and validity through the lifecycle API. Expired, archived, superseded, rejected and needs-recheck records are excluded from normal recall. Changing a source invalidates dependent summaries; a summary cannot outlive its source.

## Setup

- macOS or Linux, arm64 or x64.
- Bun 1.4 or later on the daemon host.
- macOS: Homebrew SQLite. Apple's SQLite cannot load extensions.
- Paseo 0.11.0-beta.5 or later.

## Settings

The settings screen controls how much memory each agent receives, the session review trigger, the embedding tier and re-ranking, and upkeep. Each setting has help text.

## Data and network

- The plugin starts a Bun child process that serves MCP and an internal API on `127.0.0.1:6797`.
- Data is stored in `$PASEO_HOME/plugin-data/paseo-memory/memory.db`, unless `PASEO_MEMORY_DIR` selects another directory.
- Each memory carries an index generation that changes with its text, type or scope. A vector is stored only if the memory still has the generation the embedder saw, so a memory that moves between projects while it is being indexed never becomes searchable in its old project. A search drops any hit whose scope, text or state changed while it ran.
- A failed embedding batch retries with backoff, up to 5 attempts per memory. Keyword search keeps working, and Settings shows how many memories could not be indexed.
- Schema v7 preserves IDs, original timestamps and v6 index generations. Before migration it checks disk space, creates a WAL-consistent backup next to the database, verifies integrity/schema/foreign keys and writes a JSON report. Older text-only history is explicitly marked as unknown metadata, without invented evidence or authors. An older binary refuses a newer schema. Rollback requires a compatible build or verified backup, not disabling a feature.
- On first start the plugin runs `bun install` in its directory to fetch its runtime packages, about 480 MB.
- Embedding and re-ranking models download from Hugging Face on first use, 30 MB to 337 MB per tier. Those models run on the host. Selected memory and session text enter agent prompts or tool results and may be sent to the configured agent provider.
- Secrets in common formats are redacted before saving.
- The session review uses one agent turn. Its memory-change cap is not a provider-token or cost cap. Each review also allows at most the larger of 20 mutation attempts or twice its change cap, including failed and malformed writes. The cap and receipts survive service restarts. After 15 minutes, the review blocks further changes until its end event; expiry never makes it unrestricted.
- Forget previews enumerate affected records, sources and known agent contexts. Forget purges controlled content and Memory session copies, then retains non-content tombstones to prevent replay. Capture and standalone review remain blocked for affected old agent IDs. Host chat history, already attached prompts, provider requests and exported backups are separate copies; Memory cannot retract them.
