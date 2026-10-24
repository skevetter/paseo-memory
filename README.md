# paseo-memory

Local memory for Paseo agents. One SQLite file stores global and project memory. Search fuses FTS5 keyword matches and sqlite-vec vectors with reciprocal rank fusion. A local cross-encoder re-ranks the top results. A Bun service handles storage and models, and the Paseo plugin supervises it.

## Features

- **Starting memory:** owner-controlled retrieval profiles bound tokens, characters, bytes, candidates, items and inference time. Stable constraints precede task facts; canonical references and evidence are packed with the complete serialized wrapper. [Retrieval policy and measurement](docs/retrieval.md).
- **MCP tools:** `memory_search`, `memory_get`, `memory_save`, `memory_update`, `memory_delete`, `memory_mutate`, `memory_context`. Agent assertions and corrections become candidates until authorized promotion.
- **Session digests:** each turn records the prompt, the reply and the edited files. Tool output is not stored.
- **Session review:** an idle agent receives one prompt to summarize the session and make up to 3 memory changes, counting creates and updates together.
- **Upkeep:** duplicate suggestions, possible-conflict flags and a stale list. Automatic merges require compatible exact content and namespace; merges retain snapshots and support undo.
- **Lifecycle:** canonical ID/revision references, evidence and validity, compare-and-swap corrections, historical queries, source invalidation and explicit forget. [API and migration limits](docs/lifecycle.md).
- **Audit:** each agent's injected memories, tool calls and reviews.
- **Resources:** bounded local inference, current index fingerprints, process-wide CPU/RSS, queue outcomes and latency samples. Prepared Memory tokens, maintenance observations and provider billing remain separate; unavailable values are not zero.
- **UI:** a Memory panel, a settings screen and a `/remember` command.

## Embeddings

| Tier | Model | Dims |
| --- | --- | --- |
| zero | potion-base-8M | 256 |
| low | bge-small-en-v1.5 | 384 |
| medium (default) | gte-modernbert-base | 768 |
| high | bge-large-en-v1.5 | 1024 |

Models run on the host and download on first use. Model and tokenizer revisions, finite artifact lists, sizes and SHA256 digests are pinned. Downloads activate atomically only after verification; corrupt or unavailable models leave keyword retrieval available rather than loading unchecked weights.

Model/index identity also includes runtime versions, preprocessing, dimensions, pooling, normalization and prefixes. Different fingerprints never share vector entries. Replaced indexes are read-only; at most two retired indexes are retained, and indexes older than seven retired days are pruned on replacement readiness and periodic maintenance. Forget purges the affected rows from every retained index.

Document embeddings, query embeddings and reranking share a bounded queue: two active and 32 pending by default, with absolute limits of eight and 256. Cancellation settles callers promptly, but an uncooperative backend occupies its slot until it actually finishes. Settings reports loading/index failures, queue pressure, latest-256 latency percentiles and nullable usage values. [Execution and accounting limits](docs/retrieval.md#execution-and-accounting).

## Requirements

- Paseo 0.11.0-beta.5 or later, with plugins enabled
- Bun 1.4 or later
- macOS or Linux, arm64 or x64
- macOS: Homebrew SQLite (`brew install sqlite`). Apple's SQLite cannot load extensions.

## Install

Install a release tag from GitHub:

```bash
paseo plugin install git:skevetter/paseo-memory --ref v1.5.1
```

Replace `v1.5.1` with a tag from [Releases](https://github.com/skevetter/paseo-memory/releases). On first start the plugin installs its dependencies with Bun.

## Develop

Use npm or Bun.

```bash
npm install          # or: bun install
npm run typecheck    # or: bun run typecheck
npm run lint         # or: bun run lint
bun test
```
