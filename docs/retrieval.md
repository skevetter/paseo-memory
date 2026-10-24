# Budgeted retrieval

Starting context, `memory_context`, `memory_search` and `memory_get` use the same scoped collection and serialized-fragment budget. References identify canonical memory revisions. Agent proposals remain excluded from ordinary retrieval; explicit reads may return the caller's own candidates, labeled as candidates rather than verified facts.

## Owner policy

The host settings and authenticated internal `configure` API accept `retrievalPolicy` as part of the full runtime configuration. Only the owner assigns allowed profiles, profile limits, record kinds, maximum detail and overhead reservations. Agent requests can narrow these settings, never expand namespace grants or enable an ungranted profile.

Default profile limits, before reservations:

| Profile | Tokens | Characters | UTF-8 bytes | Inference deadline | Candidates | Items | Maximum detail |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| compact | 4096 | 3000 | 9000 | 500 ms | 30 | 20 | compact |
| standard | 8192 | 6000 | 18000 | 750 ms | 60 | 40 | compact |
| evidence | 32768 | 20000 | 60000 | 2000 ms | 120 | 80 | full |

`standard` is the default. Only `compact` and `standard` are initially allowed; `evidence` requires owner opt-in. Compact allows facts, preferences, derived summaries and lessons; standard/evidence additionally allow episodes. Procedure references are excluded by default. Existing title-only settings continue to show ordinary facts as references unless detail is explicitly requested within the owner's maximum. Pins, stable preferences and episode digests retain bounded compact display under their allowed profile detail.

Default reservations are 1024 tokens, 1024 characters and 4096 bytes. They are subtracted before packing. The legacy `contextBudgetChars` remains an additional global hard ceiling, including for a richer profile. The service absolute ceilings are 32768 tokens, 20000 characters, 80000 bytes, 5000 ms, 200 candidates and 100 items. Zero allowances are honored; they do not restore defaults. Owner configuration changes advance a durable policy revision, while equivalent settings and restarts preserve it.

Examples:

```json
{"query":"deployment region","profile":"compact","detail":"compact","budget":{"maxTokens":2000,"maxItems":4}}
```

Use this shape directly with `memory_context`. Search takes `query` at the top level and these profile/detail/budget options under `retrieval`; get takes `ids` at the top level and options under `retrieval`. Search's optional scope/type filters only narrow the signed caller's namespace. Unknown authority fields are rejected. Requesting `evidence` without the owner grant returns `scope_denied`.

## Measurement and assembly

The budget measures the actual serialized context: headings, delimiters, escaped source text, canonical references, evidence citations, tool instructions, owner instructions and omitted-pin notices. Compact content is clipped at Unicode-safe boundaries; whole entries are then selected within all applicable token, character, byte and item limits. No evidence produces an empty fragment, not filler.

A trusted controller can supply `assemblyPrefix` to the internal `agent-context` API. The plugin passes its existing system prompt, then appends the returned context exactly once. Prefix, separator and new fragment are included in `usage.assembledChars`, `assembledBytes` and `assembledTokenCount`; fragment-only measurements remain in `chars`, `bytes` and `tokenCount`. If the prefix already exceeds its allowance, Memory adds no fragment and reports `preexisting_prompt_exceeds_allowance`. It never truncates existing owner instructions to make room.

A matching service-registered raw-fragment tokenizer provides exact fragment counts. Requesting a tokenizer name does not register or trust a tokenizer. Without a matching counter, `tokenCountIsEstimate` is true and `estimator` is `utf8-byte-upper-bound`; unavailable requested counters report `tokenizer_unavailable`. A failed counter causes conservative repacking, not an exact-count claim. The current standalone host adapter does not expose a provider tokenizer, so its counts are estimates. The deterministic WordLevel encoder fixture exercises the exact-counter path; it is not calibration evidence for a chat provider.

These limits cover plugin-assembled known text, not a claim about an entire provider request. Later host/provider framing, hidden instructions and native tool schemas are unknown overhead covered only by the reservation. Trusted controllers can pass their remaining allowance as narrower request budgets. Bridge v1 and Bots context ownership are separate M07 gates; this change does not enable a bridge or infer ownership from environment variables.

## Selection, freshness and privacy

Namespace, current lifecycle, validity, kind and index-fingerprint predicates run before candidate limits and inference. Exact IDs and small exact title/topic matches bypass embeddings and reranking. Hybrid search bounds lexical/vector candidates, fuses deterministically and optionally reranks a bounded set. Native sqlite-vec KNN applies the authorized current-ID subquery before its global `k` limit, rather than filtering a global top-k afterward.

Automatic retrieval reserves bounded pins and unpinned owner preferences before task candidates. Packing prioritizes stable constraints, then task facts and ordinary facts, with topic diversity. Pins do not force an oversized block: omitted pins and other omitted candidates are counted. Session digests are labeled unverified episodes, not task-success proof or executable procedures.

Query embeddings use bounded fingerprinted normalized-query caches and bounded single-flight bookkeeping; keys retain query hashes rather than plaintext. Candidate caches retain IDs/revisions/ranks, not source text, and separate grants, scope, kind, policy and index generations. Source corrections, moves, deletion, validity boundaries and external database writes invalidate or reauthorize cached selections. Usage counters do not flush them.

Before final disclosure, memory references retain searched revisions and requested scope/type filters. Session candidates retain IDs and source-version hashes, then re-read authorized current rows. Changed, deleted, moved or invalidated sources are dropped instead of receiving obsolete relevance scores. Changed owner policy is checked before further reranking and again before disclosure; a request either fails for its newly denied profile or returns an empty `policy_changed` result under the current policy. Model/reranker changes fence obsolete scoring across asynchronous boundaries. Forget/source-forget also clear query cache/flight bookkeeping and fence late completions from repopulating pre-erasure entries.

Deadline expiry returns bounded lexical fallback and marks `deadline_lexical_fallback`. Canceled requests do not disclose or record late selections. Uncancelable backend work may finish internally; Memory drops its result. Native SQL and packing are bounded by candidate/item ceilings but are not preemptible inference tasks; large-corpus latency still requires measurement.

## Native create handoff

Before adding Memory text or new Memory tools to a native agent-create request, the plugin calls the private `context-admit` endpoint with the issued nonce and retrieval ID. Admission requires the actual injection audit, current policy and retrieval generations, exact authorized memory revisions, visible evidence and unchanged selected session digests. Historical issuance without the admission snapshot is not accepted. Genuine tools-only issuance uses a null retrieval ID and does not fabricate a retrieval or prepared fragment.

Admission shares the original create-hook deadline. Revoked, changed, unavailable or late admission leaves the complete original caller request unchanged, including its prompt, MCP servers and environment. The plugin registers its pending agent link only after admission and output selection.

This is authorization at one synchronous service read snapshot, not an atomic host/provider handoff. Revocation or expiry after that snapshot can race the response, hook return or provider dispatch; the supported SDK supplies no atomic lease for these boundaries. Admission does not prove provider consumption and does not enable M07 session ownership or Bridge v1.

## Result and API cutover

A retrieval bundle contains `retrievalId`, `contextText`, `memoryRefs`, `evidenceRefs`, `sessionIds`, `taskIds`, `usage`, `truncated`, `omittedCount`, `omittedPins`, `fallbackReason`, `policyRevision` and `indexGeneration`.

MCP returns the exact budgeted fragment as text and the remaining bundle as `structuredContent.retrieval`, without duplicating `contextText`. Explicit own-candidate reads additionally disclose their state metadata; authorized merge redirects remain metadata. Audit records selected references and measurements, not a duplicate prompt body. Mutation receipts retain their structured lifecycle JSON format.

The internal `agent-context` output uses `context: RetrievalResult | null`, replacing the old `systemPrompt` field. Its plugin caller consumes this bundle directly. No compatibility alias or second injection path remains. M05 itself needed no schema change; M06 upgrades storage to schema v8 for immutable index identity and separate usage/feedback observations.

## Execution and accounting

Document embeddings, query embeddings and reranking share one bounded FIFO scheduler. Defaults are two active and 32 pending operations; hard ceilings are eight and 256. Overload degrades permitted retrieval to lexical results instead of growing an unbounded backlog. Cancelled or closed callers settle promptly, but running backend work retains its physical slot until completion. Queued document and rerank inputs are checked again for revision, namespace, policy and session changes before text reaches the backend.

Pinned model/tokenizer artifacts use revision- and manifest-addressed directories. Verification rejects missing, extra, truncated, corrupt and symlinked artifacts before activation. Runtime/preprocessing fingerprints select separate vector indexes; a replacement never overwrites an old identity. Retired indexes are read-only, capped at two, and pruned when older than seven retired days on readiness or 12-hour history maintenance. These limits govern derived SQLite indexes, not a claim that declared artifact bytes equal unique physical cache usage. Forget purges its rows from all retained indexes.

Diagnostics distinguish process-cumulative CPU/current RSS and heap from per-request cost. Queue and retrieval p50/p95 cover their latest 256 settled samples; an absent sample is unknown, not zero. SQLite index allocation is nullable when `dbstat` is unavailable. Manifest-declared artifact sizes are not a physical cache-space meter.

Memory fragments record locally exact or explicitly estimated input tokens, not observed provider billing. Prepared tool results are not proof of provider consumption. Provider observations, local counts, estimates and unavailable values remain separate, and monetary values retain their currencies. Exposure/open counts are activity, not causal usefulness; factual age and verification do not change on retrieval. Validator feedback requires an actually disclosed canonical reference, authorized current supporting proof and verifier identity/version. Source correction/invalidation retracts supported current hints while retaining historical assessments.

Current validation hints are rechecked after awaited inference and before final ranking and output limits, including exact-match and fallback paths. Expired or corrected support cannot keep an independent target boosted. While invalidation propagation is pending, hint checks follow that proof's bounded ancestry rather than suppressing unrelated valid support.

Trusted internal usage ingestion requires an immutable event identity and explicit nonnegative `sourceSequence` within its producer/attempt/stage. Metrics use the newest non-null source observation, not receipt order or a sum of cumulative snapshots; a genuinely newer correction can decrease a metric. Conflicting reuse of an event or source-order slot is rejected. Currency cannot change within an attempt/provenance. This endpoint is not a model-authorized billing channel.

The native agent-create hook settles a prepared fragment as attached to its known hook output, or discarded, using its issued injection nonce and retrieval ID. Settlement reuses the original attempt and measured tokens; it is not a second token charge or proof that a provider consumed the prompt. Telemetry failure does not discard the actual prompt. MCP results stay prepared when the host cannot acknowledge consumption.

Native turn-end accounting records observed terminal events with unavailable usage rather than inventing token or monetary values from model text or ambiguously scoped `lastUsage`. Coverage is incomplete: missing turn IDs are omitted, and IDs repeated after a provider reopen can coalesce. The locked SDK does not supply an event-correlated provider-session epoch or defensible per-turn billing source. These counts are not a complete model-attempt or billing ledger; the optional Bridge/session ownership gates remain separate.

