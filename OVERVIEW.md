Local memory for Paseo agents. Agents save decisions, conventions and fixes, and new agents receive the memories that match their task.

Memory has two scopes. Global memory reaches every agent. Project memory is keyed by git remote, so worktrees share it. Search combines keyword and vector matches, then re-ranks the top results.

## How it works

- New agents receive a memory block in their system prompt: matches for the first prompt, pinned memories, recent project and global memories, and recent sessions.
- Agents get MCP tools to search, read, save, update and delete memories.
- Each turn records the prompt, the reply and the edited files. Tool output is not stored.
- An idle agent receives one prompt to summarize its session and save up to 3 memories. The review shows as one collapsed line in the chat.
- A daily job suggests duplicate merges, flags contradictions and lists stale memories.
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
- Embedding and re-ranking models download from Hugging Face on first use, 30 MB to 337 MB per tier. Models run on the host. No memory content leaves the host.
- Secrets in common formats are redacted before saving.
- The session review uses one agent turn.
