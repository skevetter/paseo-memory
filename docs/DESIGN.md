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
- The service writes info lines to stdout and warnings and errors to stderr, each prefixed with `info`, `warn` or `error`, plus one `@@paseo-memory {"event":"ready"|"fatal",...}` line on stdout. The plugin parses each line's level, logs it under its own tag on the matching stream, and keeps its own info lines on stdout too. 1.0 wrote everything to stderr, so Paseo's log view showed normal startup lines as errors.
- Exit code 78 means a configuration problem (no SQLite build, sqlite-vec failure, bad flags, the port held by another program). The plugin marks the service `fatal` and retries every 60 seconds. Any other exit restarts with exponential backoff from 1 second to 30 seconds; a run longer than 60 seconds resets the backoff. A service that does not report ready in 20 seconds is killed and restarted.
- The service exits when its stdin closes or its parent pid disappears, so a killed plugin process never leaves a service holding the port.
- Service restarts are reserved for settings the process is built around: tier, re-rank, port, retention and paths. Starting-memory counts, the budget, task strictness, detail level, extra instructions, the review save cap, duplicate merge mode, the stale window and usage ranking live in the running service. The plugin pushes them through the `configure` route when settings change and again each time the service reports ready, so a restart never runs with stale values.

## One port, two APIs

- `/mcp` is the agents' MCP endpoint. Each agent's bearer token is `base64url(caller).HMAC(secret, payload)`, where the caller holds the project key, the provider and a random nonce. It is verified on every request.
- `/v1/<route>` is the plugin's internal API. It takes `x-paseo-memory-key: HMAC(secret, "paseo-memory/internal-api/v1")`. Agent tokens are HMACs over a different message, so an agent cannot call internal routes.
- Both reject requests with an `Origin` header. Inputs to `/v1` are Zod-validated by the schemas in `shared/service-api.ts`, which the plugin also imports for types.

## Why sqlite-vec is required

- v0.1 scored BLOB vectors by brute-force cosine because the plugin process could not load extensions. The service can, so 1.0 drops the BLOB path rather than carry two vector implementations.
- One `vec0` table exists per model and dimension count. `scope_key` is a partition key (`global` or `project:<16 hex of sha256(projectKey)>`), so KNN for a project reads only that project's and the global partition, and dedupe reads only the memory's own partition.
- `memory_embeddings` records `(memory_id, model, dims, content_hash)`. A missing row or a hash mismatch marks a memory as pending for that model. Edits drop the memory's vectors from every model's table.
- Bun's `changes` count includes rows that the FTS triggers touch, so session pruning counts `RETURNING` rows instead.
- Both FTS5 indexes use `porter unicode61 tokenchars '_-/'`. Through schema v4, "." was a token character too, so a sentence's last word was indexed with its period ("backoff.") and a search for "backoff" missed it. Schema v5 drops and recreates `memories_fts` and its triggers, then refills it from live memories with rowid set to the memory id, so ids and soft-deleted rows stay as they were. A dotted query such as "config.ts" becomes a two-word phrase and still matches. On the benchmark, zero-tier top-1 without re-ranking went from 22/39 to 23/39 (MRR 0.690 to 0.703); every other row is unchanged.

## Embedding tiers

- One table, `TIERS` in `service/embedder.ts`, defines each tier: model id, backend, dtype, pooling, dimensions, query and document prefixes, duplicate threshold and search floor. The loader reads nothing else.
- `medium` (gte-modernbert-base) is the default. It had the best retrieval on the 15-question benchmark (15/15 top-1) at 7.2 ms per embed. `high` (bge-large) costs twice the time and memory for slightly lower scores on that benchmark; it is there for users who prefer a larger model.
- `zero` keeps v0.1's pure-TypeScript model2vec embedder. It needs no ONNX runtime and still works when onnxruntime-node cannot load.
- transformers.js loads lazily, so the zero tier never imports onnxruntime-node.
- Models load after the service is listening. Saves made before the model is ready get no vector and enter the background indexer; searches use keywords only until then.
- Transformer models score in a compressed high band (unrelated texts around 0.4 to 0.6) while static embeddings spread wide (unrelated texts near 0.0 to 0.2), so one threshold cannot serve both. The calibration fixture has restatements that must reach the duplicate threshold, distinct facts from the same topic that must stay below it, and query triples where the relevant memory must clear the search floor and outrank an unrelated one.

## Re-ranking

- `Alibaba-NLP/gte-reranker-modernbert-base` reads the query and each candidate together, which fixes the failure mode of single-vector search: queries that share no words with the answer and near-miss distractors that share many. It pairs with the medium embedder (same ModernBERT tokenizer family) and has a q8 ONNX export.
- It rescores the top 30 fused candidates, not the whole store: 30 pairs take about 35 ms on Apple Silicon. Each candidate keeps its pinned, recency, usage and project boost as a multiplier on the re-ranker probability, so a pinned memory still wins a tie.
- `auto` turns it on for medium and high only. The zero tier exists to avoid the ONNX runtime, and the low tier is for small machines. The benchmark shows re-ranking also helps those tiers (zero goes from 23/39 to 35/39 top-1), so users can choose `on`.
- Loading failure, scoring failure or a single candidate keeps the fused order. The status RPC reports the re-ranker state.
- `tests/fixtures/calibration.ts` `BENCHMARK` holds 50 memories in topic clusters with near-miss siblings and 39 queries: 13 paraphrases, 13 with no content word shared with the answer, and 13 whose wording overlaps a distractor more than the answer. `bench/retrieval.ts` runs the real store search on it per tier, with and without re-ranking.

## Agent audit and the nonce link

- `before("agent.create")` runs before Paseo assigns the agent id, but the MCP token must be minted there because `mcpServers` is part of the creation config. The `agent-context` route mints a random 96-bit nonce, signs it into the caller token, inserts an `agent_links` row (nonce, project, provider), and records the `inject` event (memory ids, session ids, characters, budget) under the nonce.
- The create hook also sets `PASEO_MEMORY_NONCE` in the request's `env`. Paseo passes that environment to `before("agent.session_open")`, which runs with reason `create` and carries the new agent id. That hook calls `link-agent` with the nonce, agent id and workspace id. This link is exact. It does not block session opening: the call is fire-and-forget, and the hook returns nothing.
- Fallback: the plugin keeps the nonces it minted in memory (cwd, provider, time). If `agent.created` or the first `agent.turn_ended` arrives for an agent that is not linked, it takes the oldest unclaimed nonce with the same cwd and provider from the last two minutes. Two agents created at once in the same directory with the same provider could swap under this fallback; the exact path makes that rare.
- Every MCP call resolves the caller's agent id from `agent_links` by nonce, so saves made after the link carry the agent id even though the token was signed without it. Resumed agents keep their token, so their calls stay bound to the same audit trail.
- `audit_events` stores the kind and a compact JSON detail: search query (redacted, at most 200 characters), scope and result ids with scores; `get` ids and found ids; save id, status and candidate ids; update and delete id and outcome. Titles are joined at read time, so deleting a memory removes its title from the audit view too.
- Events and links older than `sessionRetentionDays` are pruned with the session digests.

## Usage and quality

- A use is an injection into an agent, a place in the top 5 of an agent's `memory_search`, or a `memory_get`. Searches from the app UI and the attachment picker do not count, so browsing does not inflate the signal.
- 1.2 splits use into `shown` and `opened`. Shown counts injections and top-5 search hits. Opened counts a `memory_get` of a memory that the same agent was shown earlier, read from that agent's audit trail. A fetch of an id the user pasted is a use but not an open.
- Ranking adds up to 4% for use (full at 31 uses, log scale) next to the pinned, recency and project boosts. With usage ranking on, the result is multiplied by up to 1.06 for the open rate (opened divided by shown), and by 0.95 for a memory shown 10 or more times and never opened. The factor applies after RRF in search and to the starting project and global lists. It is small on purpose: it breaks ties between similar matches and never outweighs relevance.
- Recency counts from the later of the last edit and the last use. The starting block ranks unpinned project memories by recency plus half the log of use count, times the same usage factor.
- Stale means unpinned and neither edited, used nor kept for the stale window (60 days by default). The Review tab lists those oldest first with Keep, which sets `kept_at`, and Archive, which soft-deletes the memory and sets `archived_at`.
- A save that is a near duplicate of a memory with the same type in the same partition returns that memory's id as `near_duplicate` and stores nothing. 1.0 returned candidates and left the decision to the agent, which usually retried with `force` and created a second row.
- The 4,000 character cap is enforced in the store for saves and updates. The tool error tells the agent to save one fact under 800 characters or split it.
- Turns with a failed outcome, an empty reply or an error banner reply are not digested. 1.0 stored `[System Error]` text and showed it to the next agent as recent work.

## Project identity

- `projectId` (`prj_<hex>`) is random per daemon and changes when a project is archived and re-added. `projectKey` is derived from the git remote and is stable across worktrees, re-adds and hosts. Memory is keyed by `projectKey`, and `project_aliases` maps the current `projectId` to it for UI RPCs.
- Non-git projects fall back to `path:<root>`.
- MCP callers carry only the project key. The service looks up the project name in `projects` and falls back to the key itself.

## Capture

- Agents save memories themselves. This matches Engram and keeps memories curated. The plugin runs no LLM of its own.
- The turn-end hook stores only a session digest: last prompt, last reply, edited file paths. It never stores tool output or reasoning, and it redacts secrets. Digests are pruned after 30 days.
- The `agent.turn_ended` payload contains the whole timeline. The plugin slices from the last user message and sends only the digest to the service.
- The tool descriptions and server instructions ask agents to search before saving, save only decisions, root causes, conventions, config and user corrections, prefer `topic_key` upserts, and keep content under about 800 characters.

## Task-aware starting memory

- No plugin hook can change a user message before the agent reads it; `agent.turn_started` carries only the agent and turn id. Starting memory is therefore matched once, at creation. Per-message recall needs harness hooks (Claude Code `UserPromptSubmit`, omp extensions) and is future work.
- `before("workspace.create")` sees the creation request, including `firstAgentContext.prompt` when a workspace is created with a first agent. The plugin keeps the prompt for 2 minutes with the request's source directory, project id and worktree slug, and returns the request unchanged.
- The `agent.create` that follows runs in the new workspace's directory, which for a worktree did not exist when the request arrived. Matching tries, in order: the agent's cwd is inside a directory workspace's path; the agent's cwd contains the worktree slug; the request's project id equals the agent's Paseo project, or the request's source directory is the project root. Paths are compared after `realpath`, because macOS reaches temp and home folders through symlinks. A matched prompt is taken once. The CLI's `paseo run --new-workspace` creates the workspace without the prompt, so its agents fall back to names.
- Without a first prompt, the query is the agent title, the branch (read from `.git/HEAD`, following a worktree's `gitdir` pointer, skipping main, master, develop, dev and trunk) and the folder name, with separators turned into spaces and repeats removed.
- The query runs through the normal hybrid search for project and global memory. A hit counts as a task match only when every signal it has clears its floor: the re-ranker probability (`RERANK_TASK_FLOOR`) and the cosine similarity (`taskFloor` in `TIERS`). Keyword-only hits pass only when no model is loaded and strictness is low. The floors are calibrated in `tests/embedder.test.ts` on the benchmark corpus: at least 80% of relevant memories clear the medium floor and at least 90% of each query's median unrelated memory stays under it. In the scratch daemon a names query ("Quick chore pm task recall") scored 0.55 on the re-ranker against an unrelated memory; requiring the vector floor as well removed it.
- The search gets what is left of the 1.8 second hook budget after the project lookup, minus 400 ms for building the block. A slower search is abandoned, the block keeps its general lists, and the audit notes why.
- "Relevant to this task" comes first, then pinned memories, project memory, recent sessions and global memory. A task match is not listed again further down. The audit `inject` event records the query (redacted, at most 200 characters), its source and the injected matches with scores.

## Background session review

- The agent's own model already has the session in context, so it writes the summary and the memories. The plugin only decides when to ask.
- The scheduler lives in the plugin process. After a completed turn with a usable reply it counts the turn. With at least 2 counted turns it starts a timer: the idle time in idle mode, or 5 seconds after every N turns in turns mode. `agent.turn_started` cancels the timer; failed and canceled turns schedule nothing; `agent.archived` and `agent.closed` drop the agent. Archive is not a trigger because an archived agent cannot answer. A daemon restart loses pending timers, which only costs one review.
- When the timer fires the plugin reads the agent snapshot. It skips, with an audit `review` event, an agent that is archived, closed, in error, busy, or waiting on a permission. Providers in `mcpDenyProviders` are never scheduled, and the service declines agents whose injection had no memory tools. Plan mode and read-only agents are reviewed: they can still call `memory_save`.
- The review is one message through `paseo.agents.ref(id).send()`. The SDK names this `ref`; there is no `agents.get`. The first line is `[paseo-memory:review v1 <display>]`, and the agent is asked to start its reply with `[paseo-memory:review-reply v1 <display>]`, then `Summary:`, `Saved:` and `Updated:` lines or `Nothing to save`.
- `review-start` opens a window for the agent's nonce. Saves inside it that create or update a row count toward the cap, and the next save past the cap is a tool error. The window closes when the review turn ends, or after 15 minutes.
- At the end the plugin sends the reply to `review-end`. The saved and updated ids come from the audit trail of the window, not from the reply, which can be wrong. The parsed summary goes to `sessions.summary` and a line per memory to `sessions.outcomes`; both are in `sessions_fts` and in the Recent sessions lines. The audit `review` event holds the trigger, the ids, the duration and the summary, or the skip reason.
- A user message sent during a review is queued by Paseo. The review is not canceled; the user's turn starts after it and resets the timer like any turn. The review does use a turn and some of the agent's context, which the setting hint says.
- Visibility: the client registers timeline transformers for user and assistant messages. Collapsed removes the marked prompt and replaces the marked reply with one plugin row ("Memory review: saved #14, updated #9") that expands to the summary. Hidden removes both. Full changes nothing. The mode travels in the marker, because a transformer cannot read settings, so changing the setting affects later reviews only. Assistant text written before the tool calls and the tool calls themselves stay visible, because a transformer sees one item at a time and cannot tell which turn an unmarked item belongs to.

## Upkeep

- Candidate pairs: two live memories of the same type in the same partition whose vectors are at or above the tier's duplicate threshold, or two memories with the same `topic_key` where one is global or both are in the same project. Pairs the user marked "Keep both" are stored in `upkeep_dismissed` and skipped.
- Contradiction heuristic: each side states a value the other does not. Values are numbers with optional units, versions, `code spans` and quoted strings. "The service port is 6797" and "The service port is 6798" contradict; two restatements with the same numbers are duplicates. Contradictions are listed in the Review tab and never merged automatically.
- Suggest lists duplicates with a Merge action that uses the 1.1 merge. Automatic merges into the more used memory, or the newer one on a tie. The source keeps its rows and versions, is soft-deleted with `merged_into`, and an audit `merge` event is written under the `upkeep` nonce.
- The job runs once after the model loads and the indexer catches up, then daily, and on demand from the Review tab.

## Hook safety

- `before("agent.create")` blocks agent creation if it throws or runs past 30 seconds. The hook has a 1.8 second overall deadline, the project lookup has 1 second of it, and every failure returns the request unchanged.
- `systemPrompt` is creation-only. Resumed agents keep the block they were created with; `memory_context` returns a fresh digest on demand.

## Lint rules

- Biome enforces cognitive complexity 10, at most 4 parameters, and 80 non-blank lines per function. Functions that need more inputs take one options object; long flows are split into named helpers (`saveNow` into topic update, exact duplicate, near duplicate and insert steps, for example).

## Deferred

- Per-message recall, which needs a harness hook that sees each user message.
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
- Models: minishlab/potion-base-8M, Xenova/bge-small-en-v1.5, Alibaba-NLP/gte-modernbert-base, Xenova/bge-large-en-v1.5, Alibaba-NLP/gte-reranker-modernbert-base
- Community plugins reviewed: omercnet/paseo-plugins (context-mode), oliexe/paseo-bots, koinzhang/paseo-plugins (inbox), tomgrin10/paseo-smart-session
