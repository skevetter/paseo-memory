# Design notes

Decisions that the code does not explain on its own. Research sources are listed at the end.

## Why a server plugin with an in-process HTTP MCP server

- The plugin bundle runs through `eval` in a forked child, so `__dirname` and `import.meta.url` are unavailable and the plugin cannot locate its own files to launch a stdio MCP script.
- An HTTP server inside the plugin process needs no path, no Node on `PATH` for the agent, and no second process. Paseo itself injects its own MCP server the same way.
- All writes go through one process, so SQLite never sees two writers.

## Why node:sqlite and no native modules

- The macOS desktop daemon runs plugins under Paseo Helper (Electron 44, Node 24) with the hardened runtime and library validation. Loading a third-party `.node` addon or a SQLite extension dylib fails with a Team ID mismatch. better-sqlite3 and sqlite-vec therefore do not load there.
- `node:sqlite` is built in, supports FTS5, and works in that runtime. On Linux daemons that run plain Node (for example WS3), sqlite-vec can load; the store supports it but does not require it.

## Why model2vec

- Static embeddings need only a tokenizer and a lookup table. The implementation is about 150 lines of TypeScript, loads in about 20 ms and embeds in microseconds, with no ONNX runtime (about 290 MB) and no server.
- Retrieval quality is below transformer models. Fusion with BM25 covers exact identifiers, file paths and ticket keys, where static embeddings are weakest.
- The `Embedder` interface accepts other backends (transformers.js, Ollama, Bedrock Titan) later without schema changes. `memory_embeddings.model` records which model produced each vector, and a model change re-embeds missing rows at startup.

## Project identity

- `projectId` (`prj_<hex>`) is random per daemon and changes when a project is archived and re-added. `projectKey` is derived from the git remote and is stable across worktrees, re-adds and hosts. Memory is keyed by `projectKey`, and `project_aliases` maps the current `projectId` to it for UI RPCs.
- Non-git projects fall back to `path:<root>`.

## Capture

- Agents save memories themselves. This matches Engram and keeps memories curated.
- The turn-end hook stores only a session digest: last prompt, last reply, edited file paths. It never stores tool output or reasoning, and it redacts secrets. Digests are pruned after 30 days.
- The `agent.turn_ended` payload contains the whole timeline. The digest code slices from the last user message and keeps nothing else in memory.

## Hook safety

- `before("agent.create")` blocks agent creation if it throws or runs past 30 seconds. The hook catches every error and returns the request unchanged, and the project lookup has a 2 second cap.
- `systemPrompt` is creation-only. Resumed agents keep the block they were created with; `memory_context` returns a fresh digest on demand.

## Deferred

- Optional LLM extractor at turn end (Mem0-style ADD or UPDATE, never DELETE), reviewed before it becomes durable.
- Cross-encoder reranking.
- Graph entities and relations.
- JSONL export and import, which also covers cross-host sharing.
- Per-agent private scope.

## Sources

- Paseo plugin docs: https://paseo.sh/docs/plugins.md and https://paseo.sh/docs/plugins/reference.md
- Paseo source, getpaseo/paseo: `packages/server/src/server/plugins/` (runtime, compiler, bundle evaluator), `packages/protocol/src/agent-types.ts`, `packages/server/src/server/project-key.ts`
- Engram, Gentleman-Programming/engram: data model, topic-key upserts, FTS5 schema
- sqlite-vec, asg017/sqlite-vec: vec0 partition keys and KNN syntax
- model2vec, MinishLab: potion-base-8M
- Community plugins reviewed: omercnet/paseo-plugins (context-mode), oliexe/paseo-bots, koinzhang/paseo-plugins (inbox), tomgrin10/paseo-smart-session
