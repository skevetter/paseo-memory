# Design notes

Decisions that the code does not explain on its own. Research sources are listed at the end.

## Why a Bun service next to the plugin

- The macOS desktop app runs plugin server code inside Paseo Helper (Electron 44, Node 24, Team ID 99ZMJMKU9Y) with the hardened runtime. Its entitlements grant `allow-jit` and `allow-unsigned-executable-memory` but not `disable-library-validation`, so `dlopen` of a library signed by another team fails. That blocks `loadExtension(sqlite-vec)`, better-sqlite3 and onnxruntime-node inside the plugin process.
- A child process started from a different binary is not subject to that rule. Homebrew `bun` loads sqlite-vec 0.1.9 and onnxruntime-node on the same machine.
- Bun brings `bun:sqlite` with `Database.setCustomSQLite()`, `Bun.serve` and TypeScript execution without a build step, so the service runs straight from the plugin directory.
- All storage stays in one process, so SQLite never sees two writers.

## Why the service runs from the plugin directory

- The plugin bundle runs through `eval`, so `__dirname` and `import.meta.url` are unavailable and the plugin cannot locate its own files.
- Paseo records every installed plugin's directory in `$PASEO_HOME/config.json` as `plugins.<id>.path`. Directory installs point at the source tree; Git and npm installs point at the managed checkout under `$PASEO_HOME/plugins/<id>/`. The plugin picks the entry whose `paseo-plugin.json` has id `paseo-memory` and which contains `service/main.ts`, preferring the entry installed under that id. The `servicePath` setting overrides the lookup.
- The alternative was to embed a `bun build` bundle of the service in the plugin bundle and write it into the data directory. That was rejected: sqlite-vec is a dylib loaded by path and onnxruntime-node is a native addon that links its own dylib, so neither can live inside a JavaScript string. The written bundle would still need the plugin's `node_modules`, which brings back the path problem.
- Running from the plugin directory resolves `node_modules` normally, keeps one copy of every native file, and picks up source edits on `paseo plugin reload`.

## Process model

- The plugin spawns `bun service/main.ts --data-dir ... --port ... --tier ... --parent-pid <pid>` with the daemon environment minus `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ATTACH_CONSOLE` and `NODE_OPTIONS`.
- The service prints one `@@paseo-memory {"event":"ready"|"fatal",...}` line on stdout and logs to stderr. The plugin forwards both streams to the plugin log.
- Exit code 78 means a configuration problem (no SQLite build, sqlite-vec failure, bad flags). The plugin marks the service `fatal` and retries every 60 seconds. Any other exit restarts with exponential backoff from 1 second to 30 seconds; a run longer than 60 seconds resets the backoff. A service that does not report ready in 20 seconds is killed and restarted.
- The service exits when its stdin closes or its parent pid disappears, so a killed plugin process never leaves a service holding the port.
- Settings that affect the service (tier, port, budget, retention, paths) restart it. Other settings apply in the plugin immediately.

## One port, two APIs

- `/mcp` is the agents' MCP endpoint. Each agent's bearer token is `base64url(caller).HMAC(secret, payload)`, bound to the agent's project key, and verified on every request.
- `/v1/<route>` is the plugin's internal API. It takes `x-paseo-memory-key: HMAC(secret, "paseo-memory/internal-api/v1")`. Agent tokens are HMACs over a different message, so an agent cannot call internal routes.
- Both reject requests with an `Origin` header. Inputs to `/v1` are Zod-validated by the schemas in `shared/service-api.ts`, which the plugin also imports for types.

## Why sqlite-vec is required

- v0.1 scored BLOB vectors by brute-force cosine because the plugin process could not load extensions. The service can, so v0.2 drops the BLOB path rather than carry two vector implementations.
- One `vec0` table exists per model and dimension count. `scope_key` is a partition key (`global` or `project:<16 hex of sha256(projectKey)>`), so KNN for a project reads only that project's and the global partition, and dedupe reads only the memory's own partition.
- `memory_embeddings` records `(memory_id, model, dims, content_hash)`. A missing row or a hash mismatch marks a memory as pending for that model. Edits drop the memory's vectors from every model's table.
- Bun's `changes` count includes rows that the FTS triggers touch, so session pruning counts `RETURNING` rows instead.

## Embedding tiers

- One table, `TIERS` in `service/embedder.ts`, defines each tier: model id, backend, dtype, pooling, dimensions, query and document prefixes, duplicate threshold and search floor. The loader reads nothing else.
- `medium` (gte-modernbert-base) is the default. It had the best retrieval on the 15-question benchmark (15/15 top-1) at 7.2 ms per embed. `high` (bge-large) costs twice the time and memory for slightly lower scores on that benchmark; it is there for users who prefer a larger model.
- `zero` keeps v0.1's pure-TypeScript model2vec embedder. It needs no ONNX runtime and still works when onnxruntime-node cannot load.
- transformers.js loads lazily, so the zero tier never imports onnxruntime-node.
- Models load after the service is listening. Saves made before the model is ready get no vector and enter the background indexer; searches use keywords only until then.
- Transformer models score in a compressed high band (unrelated texts around 0.4 to 0.6) while static embeddings spread wide (unrelated texts near 0.0 to 0.2), so one threshold cannot serve both. The calibration fixture has restatements that must reach the duplicate threshold, distinct facts from the same topic that must stay below it, and query triples where the relevant memory must clear the search floor and outrank an unrelated one.

## Project identity

- `projectId` (`prj_<hex>`) is random per daemon and changes when a project is archived and re-added. `projectKey` is derived from the git remote and is stable across worktrees, re-adds and hosts. Memory is keyed by `projectKey`, and `project_aliases` maps the current `projectId` to it for UI RPCs.
- Non-git projects fall back to `path:<root>`.
- MCP callers carry only the project key. The service looks up the project name in `projects` and falls back to the key itself.

## Capture

- Agents save memories themselves. This matches Engram and keeps memories curated.
- The turn-end hook stores only a session digest: last prompt, last reply, edited file paths. It never stores tool output or reasoning, and it redacts secrets. Digests are pruned after 30 days.
- The `agent.turn_ended` payload contains the whole timeline. The plugin slices from the last user message and sends only the digest to the service.

## Hook safety

- `before("agent.create")` blocks agent creation if it throws or runs past 30 seconds. The hook has a 1.8 second overall deadline, the project lookup has 1 second of it, and every failure returns the request unchanged.
- `systemPrompt` is creation-only. Resumed agents keep the block they were created with; `memory_context` returns a fresh digest on demand.

## Lint rules

- Biome enforces cognitive complexity 10, at most 4 parameters, and 80 non-blank lines per function. Functions that need more inputs take one options object; long flows are split into named helpers (`saveNow` into topic update, exact duplicate, near duplicate and insert steps, for example).

## Deferred

- Optional LLM extractor at turn end (Mem0-style ADD or UPDATE, never DELETE), reviewed before it becomes durable.
- Cross-encoder reranking.
- Graph entities and relations.
- JSONL export and import, which also covers cross-host sharing.
- Per-agent private scope.
- Remote embedding backends (Ollama, Bedrock Titan).

## Sources

- Paseo plugin docs: https://paseo.sh/docs/plugins.md and https://paseo.sh/docs/plugins/reference.md
- Paseo source, getpaseo/paseo: `packages/server/src/server/plugins/` (runtime, compiler, bundle evaluator), `packages/protocol/src/agent-types.ts`, `packages/server/src/server/project-key.ts`
- Engram, Gentleman-Programming/engram: data model, topic-key upserts, FTS5 schema
- sqlite-vec, asg017/sqlite-vec: vec0 partition keys and KNN syntax
- Bun SQLite docs: `Database.setCustomSQLite` and `loadExtension`
- transformers.js, huggingface/transformers.js: feature-extraction pipeline, dtype and pooling options
- Models: minishlab/potion-base-8M, Xenova/bge-small-en-v1.5, Alibaba-NLP/gte-modernbert-base, Xenova/bge-large-en-v1.5
- Community plugins reviewed: omercnet/paseo-plugins (context-mode), oliexe/paseo-bots, koinzhang/paseo-plugins (inbox), tomgrin10/paseo-smart-session
