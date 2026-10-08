# paseo-memory

Local memory for Paseo agents. One SQLite file stores global and project memory. Search fuses FTS5 keyword matches and sqlite-vec vectors with reciprocal rank fusion. A local cross-encoder re-ranks the top results. A Bun service handles storage and models, and the Paseo plugin supervises it.

## Features

- **Starting memory:** each new agent receives memories that match its first prompt, plus pinned, project, global and recent-session entries, within a character budget.
- **MCP tools:** `memory_search`, `memory_get`, `memory_save`, `memory_update`, `memory_delete`, `memory_context`.
- **Session digests:** each turn records the prompt, the reply and the edited files. Tool output is not stored.
- **Session review:** an idle agent receives one prompt to summarize the session and save up to 3 memories.
- **Upkeep:** duplicate suggestions, contradiction flags and a stale list.
- **Audit:** each agent's injected memories, tool calls and reviews.
- **UI:** a Memory panel, a settings screen and a `/remember` command.

## Embeddings

| Tier | Model | Dims |
| --- | --- | --- |
| zero | potion-base-8M | 256 |
| low | bge-small-en-v1.5 | 384 |
| medium (default) | gte-modernbert-base | 768 |
| high | bge-large-en-v1.5 | 1024 |

Models run on the host and download on first use.

## Requirements

- Paseo 0.11.0-beta.5 or later, with plugins enabled
- Bun 1.4 or later
- macOS or Linux, arm64 or x64
- macOS: Homebrew SQLite (`brew install sqlite`). Apple's SQLite cannot load extensions.

## Install

Install a release tag from GitHub:

```bash
paseo plugin install git:skevetter/paseo-memory --ref v1.2.1
```

Replace `v1.2.1` with a tag from [Releases](https://github.com/skevetter/paseo-memory/releases). On first start the plugin installs its dependencies with Bun.

## Develop

Use npm or Bun.

```bash
npm install          # or: bun install
npm run typecheck    # or: bun run typecheck
npm run lint         # or: bun run lint
bun test
```
