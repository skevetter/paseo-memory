# paseo-memory

Local memory for Paseo agents. One SQLite file holds global and project memory. Search combines FTS5 keywords with sqlite-vec vectors from a local embedding model. A small Bun service does the storage and embedding work, and the Paseo plugin supervises it.

## What it does

- **Recall at agent start.** `before("agent.create")` appends a `<paseo-memory>` block to the agent's system prompt. The block holds pinned global memories, pinned project memories, recent agent sessions for the project, and a one-line index of recent memories. The default budget is 6,000 characters.
- **Memory tools for every agent.** The service hosts an MCP server on `127.0.0.1:6797`, and the plugin injects it into each new agent as the `memory` server. Tools: `memory_search`, `memory_get`, `memory_save`, `memory_update`, `memory_delete`, `memory_context`.
- **Session digests.** `on("agent.turn_ended")` records the latest user prompt, the final assistant reply and the edited file paths for each agent. Tool output and reasoning are not stored. New agents in the same project see recent sessions in their context.
- **App UI.** A Memory workspace panel (search, pin, delete, add), a `/remember` slash command, a Memory attachment source for the composer, and a settings screen with service status.

## Requirements

- Paseo 0.11.0-beta.5 or later with plugins enabled.
- [Bun](https://bun.sh) 1.4 or later on the daemon host (`brew install oven-sh/bun/bun`).
- macOS: Homebrew SQLite (`brew install sqlite`). Apple's system SQLite cannot load extensions.
- The plugin's npm dependencies installed in its directory (`npm install`).

## Architecture

- **Plugin process.** Paseo runs plugin server code inside Paseo Helper. On macOS that process has the hardened runtime without `disable-library-validation`, so it cannot load sqlite-vec, onnxruntime-node or any other third-party native library. The plugin therefore stays thin: it resolves Paseo projects, injects context and the MCP server into new agents, records turn digests, and forwards UI RPCs.
- **Memory service.** `service/main.ts` runs under Bun as a child process of the plugin. It owns the SQLite database, sqlite-vec, the embedding model, the MCP endpoint and a small internal HTTP API. Both endpoints listen on one loopback port.
- **Supervision.** The plugin finds `bun` (setting `bunPath`, then `PATH`, `/opt/homebrew/bin/bun`, `~/.bun/bin/bun`), starts the service with `ELECTRON_RUN_AS_NODE` removed from the environment, restarts it with backoff when it exits, and stops it on plugin cleanup. The service exits when the plugin closes its stdin or its parent process disappears.
- **Service path.** The plugin bundle cannot see its own directory. The plugin reads `$PASEO_HOME/config.json`, finds the plugin entry whose directory has a `paseo-plugin.json` with id `paseo-memory`, and runs `<that directory>/service/main.ts`. The `servicePath` setting overrides this.
- **Failure handling.** Every hook and RPC calls the service with a short timeout. `before("agent.create")` has a 1.8 second budget and returns the request unchanged on any failure. A missing bun, a missing SQLite build or a sqlite-vec load failure puts the service in the `fatal` state; the settings screen shows the cause, and the plugin retries every 60 seconds.

## Scopes

- **Global:** user preferences and conventions. Present for every agent.
- **Project:** keyed by Paseo's `projectKey` (the git remote, for example `remote:github.com/owner/repo`). All worktrees and workspaces of one project share it. The key survives project re-adds and matches across hosts that clone the same remote.
- There is no worktree scope. The worktree path is kept on each record for provenance only.

## Storage

`$PASEO_HOME/plugin-data/paseo-memory/memory.db` (WAL). Override the directory with `PASEO_MEMORY_DIR`.

Tables: `memories`, `memory_versions`, `memory_embeddings`, `vec_tables`, `projects`, `project_aliases`, `sessions`, FTS5 indexes `memories_fts` and `sessions_fts`, and one sqlite-vec `vec0` table per embedding model (for example `vec_alibaba_nlp_gte_modernbert_base_768`). Each `vec0` table partitions vectors by `scope_key` (`global` or `project:<hash>`) and uses cosine distance.

sqlite-vec is required. The service refuses to start when it cannot load the extension.

Write path:
1. Strip `<private>...</private>` and redact common secret formats (AWS keys, GitHub and GitLab tokens, Slack tokens, JWTs, bearer tokens, `password=` style pairs).
2. A `topic_key` match in the same scope updates the existing memory and keeps the old text in `memory_versions`.
3. An exact content match increments `duplicate_count`.
4. A near duplicate by cosine similarity in the same scope partition returns `possible_duplicate` with candidates. The agent updates one of them or retries with `force`. The threshold depends on the embedding tier.

Search: FTS5 BM25 (title weighted 5, topic key 3, content 1) fused with vec0 KNN by reciprocal rank fusion (k = 60), then boosted for pinned, recent and project-scoped memories. Vector hits enter fusion only above the tier's search floor.

## Embeddings

The `embeddingTier` setting picks the model. All tiers run locally in the service. The model downloads on first use into `plugin-data/paseo-memory/models/`. Keyword search works while a model downloads or loads.

| Tier | Model | Dims | Runtime | Size |
| --- | --- | --- | --- | --- |
| `zero` | `minishlab/potion-base-8M` | 256 | model2vec in pure TypeScript | 30 MB |
| `low` | `Xenova/bge-small-en-v1.5`, q8, CLS pooling | 384 | transformers.js on onnxruntime-node | 34 MB |
| `medium` (default) | `Alibaba-NLP/gte-modernbert-base`, q8, CLS pooling | 768 | transformers.js on onnxruntime-node | 150 MB |
| `high` | `Xenova/bge-large-en-v1.5`, q8, CLS pooling | 1024 | transformers.js on onnxruntime-node | 337 MB |

The `low` and `high` tiers prefix queries with `Represent this sentence for searching relevant passages: `. Stored memories get no prefix.

Measured under Bun on an Apple Silicon Mac with 15 questions against 16 project notes:

| Tier | Top-1 | MRR | Per embed | RSS |
| --- | --- | --- | --- | --- |
| zero | 11/15 | 0.79 | under 0.1 ms | not measured |
| low | 12/15 | 0.86 | 3.3 ms | 223 MB |
| medium | 15/15 | 1.00 | 7.2 ms | 453 MB |
| high | 14/15 | 0.97 | 13.4 ms | 824 MB |

Each embedding row records its model, dimensions and content hash. Changing the tier restarts the service, creates the new model's `vec0` table, and re-embeds memories that lack a current vector for that model in the background, 16 at a time. Vectors for other models stay, so switching back costs nothing.

Duplicate thresholds and search floors are per tier and live in the `TIERS` table in `service/embedder.ts`, the only place a model is defined. `tests/embedder.test.ts` calibrates them against `tests/fixtures/calibration.ts`.

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

The embedding tests load models from `PASEO_MEMORY_TEST_MODELS` (default: a directory in the system temp dir). The `zero` tier downloads its model there when missing; set `PASEO_MEMORY_SKIP_MODEL=1` to skip it. The `low`, `medium` and `high` tiers are skipped when their model files are absent from that directory; set `PASEO_MEMORY_DOWNLOAD_MODELS=1` to download them instead. The directory uses the transformers.js cache layout (`<org>/<model>/onnx/model_quantized.onnx`).

Run the service by hand:

```bash
bun service/main.ts --data-dir /tmp/pm --port 6797 --tier zero
```

To test against a real daemon without touching the main one, run a scratch daemon with its own home and port:

```bash
H=$TMPDIR/pm-daemon/.paseo; mkdir -p $H
echo '{"version":1,"pluginsEnabled":true,"daemon":{"listen":"127.0.0.1:6899","relay":{"enabled":false},"mcp":{"injectIntoAgents":false}}}' > $H/config.json
paseo daemon run --home $H &
paseo plugin install . --home $H
paseo plugin logs paseo-memory --home $H
paseo run --home $H --provider omp "save a project memory ..."
paseo daemon stop --home $H
```

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| injectContext | true | Append the memory block to new agents' system prompts |
| injectMcp | true | Inject the `memory` MCP server |
| autoCapture | true | Record per-agent session digests |
| embeddingTier | medium | `zero`, `low`, `medium` or `high` (see Embeddings) |
| mcpPort | 6797 | Loopback port for the service (MCP and internal API) |
| contextBudgetChars | 6000 | Size cap for the injected block |
| sessionRetentionDays | 30 | Session digests older than this are pruned |
| mcpDenyProviders | ["pi"] | Providers that do not get the MCP server |
| bunPath | (auto) | Path to `bun` |
| sqlitePath | (auto) | macOS SQLite library with extension loading |
| servicePath | (auto) | Plugin directory or `service/main.ts` |

Settings from v0.1 migrate automatically. `embeddings`, `duplicateThreshold` and `sqliteVecPath` are gone: thresholds are per tier and sqlite-vec always loads from its npm package.

## Not in v0.2

LLM-based extraction or consolidation, reranking, graph memory, cross-host sync, export, a per-agent private scope, and remote embedding backends. See `docs/DESIGN.md`.
