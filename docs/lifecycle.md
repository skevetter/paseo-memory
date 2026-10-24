# Evidence, revisions and lifecycle

Memory references are `{id, revision}`. Numeric IDs survive migration. Canonical history records complete snapshots for every authoritative change, including scope, pin, state, validity and verification. Retrieval counters do not create factual revisions or verify facts.

## Authority and mutations

Ordinary agent saves and corrections become **candidates**, excluded from search and automatic context. An agent can explicitly fetch its own candidates by ID. An owner can inspect candidates through `memory.lifecycle` and accept or reject them with `memory.mutate`. Changes to preferences, promotion, erasure and merge undo require the corresponding owner authority. Owner assertions may be active but remain unverified without evidence or explicit owner validation. Verification records validation, not a calibrated probability of truth.

The internal `POST /v1/mutate` route and owner `memory.mutate` RPC use the same domain as the signed `memory_mutate` MCP tool. A model never supplies its authenticated principal. Existing save/update/delete tools use this domain too; delete means archive, not erasure. Automatic exact merges and owner undo use the same mutation ledger.

```json
{
  "requestId": "deployment-region-correction-1",
  "operation": "update",
  "id": 42,
  "expectedRevision": 3,
  "reason": "The deployment configuration changed",
  "evidenceRefs": [],
  "change": { "content": "The deployment region is west." }
}
```

Operations are create, propose, update, supersede, archive, restore, merge, undo_merge, promote, reject and forget. Existing-record operations require `expectedRevision`; merge/supersede also require `change.target: {id, revision}`. Undo requires the current source revision, `change.mergeId` and the current target reference. Restore names `change.sourceRevision` and creates a candidate for revalidation, rather than silently upgrading historical authority. Each operation accepts only its relevant change fields.

Merge undo restores the source's pre-merge disposition. It does not promote a candidate or rejected assertion; formerly active sources with invalid supporting evidence return as needs-recheck. Unknown legacy dispositions restore conservatively as candidates.

The receipt contains `memoryRef`, resulting `state`, `evidenceValidation` and evidence IDs. Same principal/request ID and canonical body return the committed receipt, including at an exhausted review cap. Changed-body reuse returns `request_conflict`. Concurrent stale writers receive `revision_conflict`, the current revision and a bounded diff. Current grants and forget tombstones are checked before replay. The legacy update wrapper can load one expected revision when omitted; it never retries an overwrite indefinitely. New mutation callers supply it explicitly.

Durable mutation and review-slot settlement share a transaction. Failed, duplicate and unchanged operations do not consume a successful-mutation slot. Attempts have an independent cap. Index inference happens after commit.

## Evidence and freshness

Allowed source adapters are:

- `memory:<id>@<revision>`: an exact canonical snapshot. Both current and known historical namespaces must be readable. Unknown legacy namespaces are owner-only.
- `artifact:<opaque-id>`: an immutable artifact explicitly registered by the owner through `memory.evidence.artifact`. Artifacts are limited to 16 KiB UTF-8. Excerpts are opt-in, redacted and bounded to 500 characters.

These adapters do not fetch arbitrary URLs or filesystem paths. A missing, inaccessible or hash-mismatched citation remains unresolved, without an invented excerpt, observation time or source hash. Source event time, observation time and storage time are distinct. Historical evidence remains an observation of its named revision; it does not make a corrected or expired source current again.

Record kind is separate from existing topic types: fact, preference, episode, derived_summary, lesson and procedure_ref. A procedure reference names a Bots-owned playbook rather than an executable copy. Unsupported lessons remain candidates.

Normal retrieval includes active records only, within their validity bounds. Timestamps are interpreted as instants, including legacy strings without milliseconds; new mutation timestamps normalize to UTC milliseconds. Superseded, archived, rejected, candidate and needs-recheck records are excluded. Pins do not override these rules.

A correction or source invalidation marks explicit dependents needs-recheck and cancels affected queued consolidation jobs. Propagation uses durable batches of at most 128 descendants. Pending work is suppressed immediately, including after restart. Retrieval also checks source revisions and validity transitively, so a summary cannot outlive an expired source. Dependency expansion is bounded to 1,024 source revisions; larger graphs are excluded rather than partially trusted.

Supplying new evidence replaces the current revision's support set. Promotion also replaces support, and claim-changing edits without new evidence do not inherit proof for an older claim. Prior evidence remains available on historical revisions. Restores use the selected historical revision's support unless replacement evidence is supplied.

The owner historical RPC `memory.historical` accepts `{id, asOf}`. It checks current access, the historical namespace, the historical state/validity and the source revisions valid at that instant. Partial legacy snapshots remain available as explicitly unknown history, not fabricated active historical facts.

## Archive, source invalidation and forget

Archive retains content and accessible history. Supersession retains the old claim and its replacement relation. Owner restore and merge undo create new revisions and recheck current authority and evidence.

`memory.source.invalidate` marks affected evidence unresolved and records for recheck. `memory.forget.preview` enumerates records, source evidence and potentially affected known agent sessions, including authors and injection/context/get/search disclosures. `memory.mutate` with forget, or `memory.source.forget`, removes affected records, canonical and legacy history, excerpts, artifacts, feedback, vectors, merge snapshots and associated Memory session digests/audit disclosures. Capture and standalone review remain blocked for affected old agent IDs, so a delayed turn cannot rebuild an erased digest; start a fresh agent context. Non-content receipts and tombstones prevent delayed source ingestion or request replay from resurrecting content. Source-forget request IDs are idempotent, and its count includes erased dependent records. A preview over 10,000 records refuses the operation rather than performing a partial erasure.

Erasure revokes affected signed tool contexts before subsequent reads, writes or receipt replay, including callers without a linked agent and stateless signed credentials. Known agent IDs and content-producing mutation principals remain invalidated too. Closing a review window never restores a forgotten caller's capability; a new authorized context is required.

Known context exposure includes transitive session copies: if Alice reads a fact and Bob later receives Alice's digest through injection, `memory_context` or session search, both contexts are included in the forget preview and revoked. Their controlled digests are erased; unrelated and denied-read contexts are not included merely because they share a project. Cycles are deduplicated. Preview and erasure fail closed before changes when the caller/agent/session graph exceeds 10,000 nodes; they never report a partial erasure as complete. This requires retained disclosure and identity records; it cannot reconstruct unrecorded or externally copied content.

Native agent creation re-admits an issued fragment before selecting its hook output. Forget before that admission rejects the stale text and tools, preserves the caller's original request and does not register a stale pending link. Admission checks actual issuance, current source authority and selected session versions; it is independent of accounting telemetry.

Forgetting cannot retract already attached prompts, host chat history or provider requests. Affected sessions need fresh authorized context for subsequent managed execution; deleting host history or restarting a session is a separate host action. External source systems and previously exported backups are separate copies. This is logical service erasure, not a forensic-erasure promise for SQLite pages, filesystem snapshots or copies held outside Memory.

Native admission is current at its service read snapshot. Later revocation or expiry can race the admission response, hook return or provider dispatch because the supported SDK has no atomic handoff lease. This boundary does not provide provider-consumption proof or M07 session ownership.

## Schema v7 and rollback

Migration preserves existing IDs, timestamps, namespace assignments, usage metadata and v6 index generations. Existing removed records become archived or superseded. Legacy preferences keep their preference kind but receive no fabricated verification. Old text versions are imported with `legacy_metadata_unknown`; the current complete row is also recorded without inventing an author or evidence.

Before a write migration, Memory checks free space, writes a WAL-consistent `VACUUM INTO` backup, verifies its integrity, schema and foreign keys, and writes a private JSON report beside it. For a v6 database these are `memory.db.pre-v7-from-v6.bak` and its `.json` report; a unique suffix avoids overwriting an existing backup. Backup and report failures refuse migration. The migration itself is transactional. Reopening v7 does not rewrite history or create another migration backup.

Keep the verified backup independently. An older binary refuses a newer schema. Disabling a feature does not reverse migration: rollback requires a compatible binary or restoring a verified database backup while its service is stopped. Do not replace only the main SQLite file while WAL transactions are live.
