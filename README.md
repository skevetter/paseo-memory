# paseo-memory

Shared memory for Paseo agents, stored locally. One SQLite file holds global and project memory. Search combines FTS5 keywords with sqlite-vec vectors from a local embedding model, and an optional local cross-encoder re-ranks the best matches. A small Bun service does the storage and model work, and the Paseo plugin supervises it.

## What it does

- **Recall at agent start.** `before("agent.create")` appends a `<paseo-memory>` block to the agent's system prompt. It opens with "Relevant to this task": memories that match the agent's first message, or its title, branch and folder when there is no first message. Then come pinned memories, the project's most used and recently touched memories, recent agent sessions with their review summaries, and global memory. Each list has its own count, the whole block has a character budget (6,000 by default), and the lists show titles only unless the detail setting asks for short summaries.
- **Memory tools for every agent.** The service hosts an MCP server on `127.0.0.1:6797`, and the plugin injects it into each new agent as the `memory` server. Tools: `memory_search`, `memory_get`, `memory_save`, `memory_update`, `memory_delete`, `memory_context`.
- **Session digests.** `on("agent.turn_ended")` records the latest user prompt, the final assistant reply and the edited file paths for each agent. Failed turns (an error outcome, an empty reply, or a `[System Error]` banner) are skipped. Tool output and reasoning are not stored.
- **Background session review.** After an agent with at least 2 completed turns has been idle for the idle time (10 minutes by default), or after every N turns, the plugin sends it one review message. The agent searches memory, saves or updates up to 3 durable memories, and replies with a session summary. The summary and the saved and updated memories are stored on the session digest and used in later agents' Recent sessions. In the chat the review collapses to one line by default.
- **Upkeep.** A daily job, also run from the panel, finds likely duplicates (same type and scope above the tier's duplicate threshold, or the same `topic_key`) and possible contradictions (the same pair, but with differing numbers or values). Duplicates are suggested for merging, or merged automatically if you choose. Contradictions are only flagged. Memories that nobody used, edited or kept for 60 days are listed as stale.
- **Audit per agent.** Each agent's injected memories and sessions, its task query and task matches, every memory tool call with its results (ids, scores, statuses), and its reviews are recorded under the agent's Paseo id. Memory content is not copied into the audit log.
- **Usage signals.** A memory counts as shown when it is injected or appears in the top 5 of an agent's search, and as opened when the agent then fetches it with `memory_get`. Memories that agents open rank a little higher; memories shown 10 times and never opened rank a little lower. Use count and last use also give a small ranking boost and drive the stale list.
- **App UI.** A Memory workspace panel with four tabs: Memories (search, add), This agent (what the agent was given, its task matches, every tool call and review), Sessions (with review summaries), and Review (duplicates, contradictions and stale memories, with Merge, Keep both, Keep and Archive). Clicking a memory opens its detail view: full content, metadata, usage, version history with restore, edit in place, delete, and "Merge into #n" for close duplicates. Also a `/remember` slash command, a Memory attachment source for the composer, timeline rows for reviews, and a settings screen with service status.

## Requirements

- Paseo 0.11.0-beta.5 or later with plugins enabled.
- [Bun](https://bun.sh) 1.4 or later on the daemon host (`brew install oven-sh/bun/bun`).
- macOS: Homebrew SQLite (`brew install sqlite`). Apple's system SQLite cannot load extensions.
- The plugin's npm dependencies installed in its directory (`npm install`).

## Architecture

- **Plugin process.** Paseo runs plugin server code inside Paseo Helper. On macOS that process has the hardened runtime without `disable-library-validation`, so it cannot load sqlite-vec, onnxruntime-node or any other third-party native library. The plugin therefore stays thin: it resolves Paseo projects, keeps first messages from new workspaces, injects context and the MCP server into new agents, records turn digests, schedules session reviews, and forwards UI RPCs.
- **Memory service.** `service/main.ts` runs under Bun as a child process of the plugin. It owns the SQLite database, sqlite-vec, the embedding model, the MCP endpoint and a small internal HTTP API. Both endpoints listen on one loopback port.
- **Supervision.** The plugin finds `bun` (setting `bunPath`, then `PATH`, `/opt/homebrew/bin/bun`, `~/.bun/bin/bun`), starts the service with `ELECTRON_RUN_AS_NODE` removed from the environment, restarts it with backoff when it exits, and stops it on plugin cleanup. The service exits when the plugin closes its stdin or its parent process disappears.
- **Service path.** The plugin bundle cannot see its own directory. The plugin reads `$PASEO_HOME/config.json`, finds the plugin entry whose directory has a `paseo-plugin.json` with id `paseo-memory`, and runs `<that directory>/service/main.ts`. The `servicePath` setting overrides this.
- **Failure handling.** Every hook and RPC calls the service with a short timeout. `before("agent.create")` has a 1.8 second budget and returns the request unchanged on any failure; a task search that would exceed the budget is dropped and the block keeps its general lists. A missing bun, a missing SQLite build, a sqlite-vec load failure or a port held by another program puts the service in the `fatal` state; the settings screen shows the cause, and the plugin retries every 60 seconds.
- **Logs.** Info lines go to stdout, warnings and errors to stderr, each prefixed with `info`, `warn` or `error`. `paseo plugin logs paseo-memory` shows startup lines on the stdout stream.

## Scopes

- **Global:** user preferences and conventions. Present for every agent.
- **Project:** keyed by Paseo's `projectKey` (the git remote, for example `remote:github.com/owner/repo`). All worktrees and workspaces of one project share it. The key survives project re-adds and matches across hosts that clone the same remote.
- There is no worktree scope. The worktree path is kept on each record for provenance only.

## Storage

`$PASEO_HOME/plugin-data/paseo-memory/memory.db` (WAL). Override the directory with `PASEO_MEMORY_DIR`.

Tables: `memories`, `memory_versions`, `memory_embeddings`, `vec_tables`, `projects`, `project_aliases`, `sessions`, `agent_links`, `audit_events`, `upkeep_dismissed`, FTS5 indexes `memories_fts` and `sessions_fts` (sessions include the review summary and outcomes), and one sqlite-vec `vec0` table per embedding model (for example `vec_alibaba_nlp_gte_modernbert_base_768`). Each `vec0` table partitions vectors by `scope_key` (`global` or `project:<hash>`) and uses cosine distance.

sqlite-vec is required. The service refuses to start when it cannot load the extension.

Write path:
1. Content over 4,000 characters is rejected with a tool error. Agents are asked to stay under about 800.
2. Strip `<private>...</private>` and redact common secret formats (AWS keys, GitHub and GitLab tokens, Slack tokens, JWTs, bearer tokens, `password=` style pairs).
3. A `topic_key` match in the same scope updates the existing memory and keeps the old text in `memory_versions`.
4. An exact content match increments `duplicate_count`.
5. A near duplicate by cosine similarity in the same scope partition with the same type returns `near_duplicate` with the existing id, and nothing is saved; the agent calls `memory_update` instead. Close matches of another type return `possible_duplicate` with candidates. `force` saves anyway. The threshold depends on the embedding tier.

Search: FTS5 BM25 (title weighted 5, topic key 3, content 1) fused with vec0 KNN by reciprocal rank fusion (k = 60), then boosted for pinned, recent, used and project-scoped memories, and with usage ranking on, for how often agents open a memory they were shown. Vector hits enter fusion only above the tier's search floor. With re-ranking on, the top 30 fused candidates are rescored by the cross-encoder (each keeps its boost) and the top k return. A re-ranker that fails to load or score leaves the fused order.

Merging a duplicate keeps the target unchanged and soft-deletes the source with a `merged_into` pointer; `memory_get` on the old id names the target.

## Embeddings

The `embeddingTier` setting picks the model. All tiers run locally in the service. The model downloads on first use into `plugin-data/paseo-memory/models/`. Keyword search works while a model downloads or loads.

| Tier | Model | Dims | Runtime | Size |
| --- | --- | --- | --- | --- |
| `zero` | `minishlab/potion-base-8M` | 256 | model2vec in pure TypeScript | 30 MB |
| `low` | `Xenova/bge-small-en-v1.5`, q8, CLS pooling | 384 | transformers.js on onnxruntime-node | 34 MB |
| `medium` (default) | `Alibaba-NLP/gte-modernbert-base`, q8, CLS pooling | 768 | transformers.js on onnxruntime-node | 150 MB |
| `high` | `Xenova/bge-large-en-v1.5`, q8, CLS pooling | 1024 | transformers.js on onnxruntime-node | 337 MB |

The `low` and `high` tiers prefix queries with `Represent this sentence for searching relevant passages: `. Stored memories get no prefix.

Measured under Bun on an Apple Silicon Mac in 1.0 with 15 questions against 16 project notes:

| Tier | Top-1 | MRR | Per embed | RSS |
| --- | --- | --- | --- | --- |
| zero | 11/15 | 0.79 | under 0.1 ms | not measured |
| low | 12/15 | 0.86 | 3.3 ms | 223 MB |
| medium | 15/15 | 1.00 | 7.2 ms | 453 MB |
| high | 14/15 | 0.97 | 13.4 ms | 824 MB |

Each embedding row records its model, dimensions and content hash. Changing the tier restarts the service, creates the new model's `vec0` table, and re-embeds memories that lack a current vector for that model in the background, 16 at a time. Vectors for other models stay, so switching back costs nothing.

Duplicate thresholds and search floors are per tier and live in the `TIERS` table in `service/embedder.ts`, the only place a model is defined. `tests/embedder.test.ts` calibrates them against `tests/fixtures/calibration.ts`.

## Re-ranking

The `rerank` setting controls `Alibaba-NLP/gte-reranker-modernbert-base` (q8, 150 MB, transformers.js `AutoModelForSequenceClassification`). `auto` turns it on for the medium and high tiers and off for zero and low, so the zero tier never loads the ONNX runtime. `on` and `off` override that.

`npm run bench` runs the store's full search path on `BENCHMARK` in `tests/fixtures/calibration.ts`: 39 queries (13 paraphrases, 13 with no shared content words, 13 near misses next to keyword-heavy distractors) over 50 memories. Results from an Apple Silicon Mac, top 10 per search:

| Tier | Top-1 | MRR | Top-1 (paraphrase / no overlap / near miss) | ms per search | Added by re-rank |
| --- | --- | --- | --- | --- | --- |
| zero | 23/39 | 0.703 | 8 / 4 / 11 | 0.2 | |
| zero + re-rank | 35/39 | 0.923 | 12 / 10 / 13 | 55.4 | +55.2 ms |
| low | 29/39 | 0.825 | 10 / 6 / 13 | 2.5 | |
| low + re-rank | 36/39 | 0.923 | 12 / 11 / 13 | 37.6 | +35.1 ms |
| medium | 32/39 | 0.887 | 12 / 7 / 13 | 4.9 | |
| medium + re-rank | 37/39 | 0.974 | 12 / 12 / 13 | 39.1 | +34.2 ms |
| high | 34/39 | 0.911 | 12 / 9 / 13 | 11.8 | |
| high + re-rank | 35/39 | 0.936 | 13 / 9 / 13 | 40.0 | +28.3 ms |

Re-ranking improves every tier, mostly on queries that share no words with the answer. It costs 30 to 60 ms per search and about 150 MB of memory.

## Provider support

- MCP tools: Claude, Codex, OpenCode, Oh My Pi and ACP providers (including Hermes). Pi does not support MCP and is skipped through the `mcpDenyProviders` setting.
- Context block: Claude, Codex, OpenCode, Oh My Pi and Pi honor `systemPrompt`. ACP providers ignore it, so they get memory through the tools only.
- Internal agents (commit and PR generation) are skipped.

## Security

- The service listens on loopback only and rejects requests that carry an `Origin` header.
- Each injected agent gets an HMAC-signed bearer token that binds it to its project key. The secret is in `plugin-data/paseo-memory/mcp-secret` (mode 0600). An agent cannot read or write another project's memory by changing the token.
- The internal API takes a separate key derived from the same secret. Agent tokens do not work there.
- Server plugin code and the service are trusted and unsandboxed, like every Paseo plugin.

## Install

```bash
npm install
npm run typecheck
paseo plugin install /path/to/paseo-memory
```

Git installs run `npm ci --omit=dev` through the manifest's `build` step.

## Develop

```bash
npm run typecheck   # plugin (Node types) and service (Bun types)
npm run lint        # Biome
npm test            # bun test
```

`npm run lint:fix` applies safe fixes and `npm run format` formats the tree.

The embedding tests load models from `PASEO_MEMORY_TEST_MODELS` (default: a directory in the system temp dir). The `zero` tier downloads its model there when missing; set `PASEO_MEMORY_SKIP_MODEL=1` to skip it. The `low`, `medium` and `high` tiers and the re-ranker are skipped when their model files are absent from that directory; set `PASEO_MEMORY_DOWNLOAD_MODELS=1` to download them instead. The directory uses the transformers.js cache layout (`<org>/<model>/onnx/model_quantized.onnx`). `npm run bench` reads the same directory.

Run the service by hand:

```bash
bun service/main.ts --data-dir /tmp/pm --port 6797 --tier zero --rerank off
```

To test against a real daemon without touching the main one, run a scratch daemon with its own home and port:

```bash
H=$TMPDIR/pm-daemon/.paseo; mkdir -p $H
echo '{"version":1,"pluginsEnabled":true,"daemon":{"listen":"127.0.0.1:6899","relay":{"enabled":false},"mcp":{"injectIntoAgents":false}},"agents":{"providers":{"omp":{"enabled":true}}}}' > $H/config.json
paseo daemon run --home $H &
paseo plugin install . --home $H
paseo plugin logs paseo-memory --home $H
paseo run --home $H --provider omp "save a project memory ..."
paseo daemon stop --home $H
```

The scratch daemon's memory service needs its own port while another daemon's service holds 6797. Write `mcpPort` through the `settings.memory.write` plugin RPC (for example from a small `DaemonClient` script); until then the scratch service reports that the port is in use and stays stopped.

To exercise the first-message match, create the workspace with a first agent through `DaemonClient.createWorkspace({ source, agent: { provider, cwd, initialPrompt } })`. `paseo run --new-workspace` creates the workspace without the prompt, so its agents match by title, branch and folder.

## Settings

Counts, the budget and the review, upkeep and ranking settings take effect for the next agent without a service restart. The settings screen groups them as Starting memory, Session review, Search and Upkeep, with the service paths, port and retention in a collapsed Advanced section.

| Setting | Default | Meaning |
| --- | --- | --- |
| injectContext | true | Inject the memory block into new agents' system prompts |
| contextBudgetChars | 6000 | Size cap for the injected block (500 to 20,000) |
| maxPinned | 10 | Pinned memories in the block (0 to 50) |
| taskMatches | 5 | Memories in "Relevant to this task" (0 to 50) |
| taskStrictness | medium | `low`, `medium` or `high`; picks the per-tier task floors |
| projectMemories | 15 | Project memories in the block (0 to 50) |
| globalMemories | 8 | Global memories in the block (0 to 50) |
| recentSessions | 3 | Recent sessions in the block (0 to 20) |
| detailLevel | titles | `titles` or `summaries`; pinned memories always include their text |
| extraInstructions | (empty) | Text appended to the memory instructions, up to 2,000 characters |
| injectMcp | true | Inject the `memory` MCP server |
| autoCapture | true | Record per-agent session digests |
| reviewTrigger | idle | `off`, `idle` or `turns` |
| reviewIdleMinutes | 10 | Idle time before a review (1 to 240) |
| reviewEveryTurns | 8 | Turns between reviews in `turns` mode (2 to 100) |
| reviewMaxMemories | 3 | Saves allowed in one review, enforced by the service (0 to 10) |
| reviewDisplay | collapsed | `collapsed`, `full` or `hidden`; how a review shows in the chat |
| duplicateMerge | suggest | `off`, `suggest` or `auto` |
| staleDays | 60 | Days without use, edit or Keep before a memory is stale (7 to 365) |
| usageRanking | true | Rank by how often agents open the memories they are shown |
| embeddingTier | medium | `zero`, `low`, `medium` or `high` (see Embeddings) |
| rerank | auto | `auto`, `on` or `off` (see Re-ranking) |
| mcpPort | 6797 | Loopback port for the service (MCP and internal API) |
| sessionRetentionDays | 30 | Session digests and audit events older than this are pruned |
| mcpDenyProviders | ["pi"] | Providers that do not get the MCP server and are never reviewed |
| bunPath | (auto) | Path to `bun` |
| sqlitePath | (auto) | macOS SQLite library with extension loading |
| servicePath | (auto) | Plugin directory or `service/main.ts` |

Settings migrate automatically: v1 keys (`embeddings`, `duplicateThreshold`, `sqliteVecPath`) are dropped, v2 settings gain `rerank`, and v3 settings keep their values and gain the 1.2 settings with their defaults. The database moves to schema v5 on first start: new usage, review and archive columns, and rebuilt `sessions_fts` and `memories_fts` indexes in which "." no longer counts as part of a word, so the last word of a sentence matches a keyword search.

## Not in 1.2

Recall for each new user message (no Paseo hook can change a message before the agent reads it), graph memory, cross-host sync, export, a per-agent private scope, and remote embedding backends. See `docs/DESIGN.md`.
