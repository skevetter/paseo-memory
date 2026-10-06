# paseo-memory

Lightweight, native memory for Paseo agents. One SQLite file, global and project scopes, keyword plus semantic search, and no native dependencies.

## What it does

- **Recall at agent start.** `before("agent.create")` appends a `<paseo-memory>` block to the agent's system prompt. The block holds pinned global memories, pinned project memories, recent agent sessions for the project, and a one-line index of recent memories. The default budget is 6,000 characters.
- **Memory tools for every agent.** The plugin hosts an MCP server on `127.0.0.1:6797` and injects it into each new agent as the `memory` server. Tools: `memory_search`, `memory_get`, `memory_save`, `memory_update`, `memory_delete`, `memory_context`.
- **Session digests.** `on("agent.turn_ended")` records the latest user prompt, the final assistant reply and the edited file paths for each agent. Tool output and reasoning are not stored. New agents in the same project see recent sessions in their context.
- **App UI.** A Memory workspace panel (search, pin, delete, add), a `/remember` slash command, a Memory attachment source for the composer, and a settings screen with status.

## Scopes

- **Global:** user preferences and conventions. Present for every agent.
- **Project:** keyed by Paseo's `projectKey` (the git remote, for example `remote:github.com/owner/repo`). All worktrees and workspaces of one project share it. The key survives project re-adds and matches across hosts that clone the same remote.
- There is no worktree scope. The worktree path is kept on each record for provenance only.

## Storage

`$PASEO_HOME/plugin-data/paseo-memory/memory.db` (WAL). Override with `PASEO_MEMORY_DIR`.

Tables: `memories`, `memory_versions`, `memory_embeddings`, `projects`, `project_aliases`, `sessions`, plus FTS5 indexes `memories_fts` and `sessions_fts`.

Write path:
1. Strip `<private>...</private>` and redact common secret formats (AWS keys, GitHub and GitLab tokens, Slack tokens, JWTs, bearer tokens, `password=` style pairs).
2. `topic_key` match in the same scope updates the existing memory and keeps the old text in `memory_versions`.
3. Exact content match increments `duplicate_count`.
4. A near-duplicate by cosine similarity (default 0.92) returns `possible_duplicate` with candidates. The agent updates one of them or retries with `force`.

Search: FTS5 BM25 (title weighted 5, topic key 3, content 1) fused with vector similarity by reciprocal rank fusion (k = 60), then boosted for pinned, recent and project-scoped memories.

## Embeddings

The default embedder is model2vec `minishlab/potion-base-8M` (MIT, 256 dimensions), implemented in pure TypeScript: a WordPiece tokenizer and a mean of static token vectors. The 30 MB model downloads once into `plugin-data/paseo-memory/models/`. Embedding takes under 0.1 ms per text. Set Semantic search to Off in settings for keyword search only.

Vectors are stored as BLOBs and scored by brute-force cosine, which is fast for tens of thousands of memories. The store can use sqlite-vec (`vec0` with a scope partition key) when the extension loads. The macOS desktop daemon blocks third-party native libraries (hardened runtime), so the BLOB path is the default.

## Provider support

- MCP tools: Claude, Codex, OpenCode, Oh My Pi and ACP providers (including Hermes). Pi does not support MCP and is skipped through the `mcpDenyProviders` setting.
- Context block: Claude, Codex, OpenCode, Oh My Pi and Pi honor `systemPrompt`. ACP providers ignore it, so they get memory through the tools only.
- Internal agents (commit and PR generation) are skipped.

## Security

- The MCP server listens on loopback only and rejects requests that carry an `Origin` header.
- Each injected agent gets an HMAC-signed bearer token that binds it to its project key. The secret is in `plugin-data/paseo-memory/mcp-secret` (mode 0600). An agent cannot read or write another project's memory by changing the token.
- Server plugin code is trusted and unsandboxed, like every Paseo plugin.

## Install

```bash
npm install
npm run typecheck
paseo plugin install /path/to/paseo-memory
```

Requires Paseo 0.11.0-beta.5 or later with plugins enabled.

## Develop

```bash
npm run typecheck
npm test
```

The embedding tests download the model once into the system temp directory. Set `PASEO_MEMORY_TEST_MODELS` to reuse a local copy, or `PASEO_MEMORY_SKIP_MODEL=1` to skip them.

To test against a real daemon without touching the main one, run a scratch daemon with its own home and port:

```bash
H=$TMPDIR/pm-daemon/.paseo; mkdir -p $H
echo '{"version":1,"pluginsEnabled":true,"daemon":{"listen":"127.0.0.1:6899","relay":{"enabled":false}}}' > $H/config.json
paseo daemon run --home $H &
paseo plugin install . --home $H
paseo run --home $H --provider claude "save a project memory ..."
paseo daemon stop --home $H
```

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| injectContext | true | Append the memory block to new agents' system prompts |
| injectMcp | true | Inject the `memory` MCP server |
| autoCapture | true | Record per-agent session digests |
| embeddings | model2vec | `off` for keyword search only |
| mcpPort | 6797 | Loopback port for the MCP server |
| contextBudgetChars | 6000 | Size cap for the injected block |
| sessionRetentionDays | 30 | Session digests older than this are pruned |
| duplicateThreshold | 0.92 | Cosine similarity that triggers `possible_duplicate` |
| mcpDenyProviders | ["pi"] | Providers that do not get the MCP server |

## Not in v0.1

LLM-based extraction or consolidation, reranking, graph memory, cross-host sync, export, and a per-agent private scope. See `docs/DESIGN.md`.
