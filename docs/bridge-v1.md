# Bridge v1

Bridge v1 is a local, authenticated controller interface for explicit bot namespaces, bounded context, execution observations and feedback. It defaults to disabled. Ordinary Memory agents retain global/project access only; bot access requires an explicit registered grant.

## Qualification and rollout

This implementation does not establish paired Paseo Bots compatibility. The approved exact-byte fixture is `tests/fixtures/bridge-v1/contract.json`, SHA256 `e49e9ea7079b4cd6cfa0d18fd902b3d535087f60af71fcb135207cd6de9dfa0e`. Both owners approved its bytes, not a production rollout. Controlled service/hook regressions are not physical host-ordering proof.

Required external gates remain:

- Actual compatible Bots B10 and Memory versions, with both required hooks loaded and exercised together.
- Bots B08 safe evidence/model-usage references and an explicitly trusted current-proof resolver before successful validator acceptance. Private run-artifact paths or digests are not public evidence.
- A supported native credential/config staging path and observed generation bind before any resume/refresh support. The pinned plugin SDK does not prove that path. Managed resume, refresh and import fail closed with fresh-execution guidance; an old bearer is never mapped to the latest epoch.

Keep Bridge disabled for unqualified combinations. Hook guarantees are conditional on the hooks remaining loaded. Unloading plugins, malicious same-user processes, and provider consumption after handoff are not sandboxed by this API.

## Owner configuration and discovery

The owner runtime configuration has a `bridge` object:

- `enabled`: false by default.
- `consumers`: at most 16 explicit policies. Each has `id`, `readNamespaces`, `writeNamespaces`, `functions`, `mutations` and `mutationPurposes`.
- Namespace values are exactly `{kind:"global"}`, `{kind:"project",projectKey}` or `{kind:"bot",botId}`. Read and write grants are independent. Namespace filters and model-supplied arguments can only narrow them.
- Default functions: sessions, context, events, feedback. Default mutations: create and propose, only for `memory_review`. A task-purpose session cannot inherit review mutation authority.
- Lease lifetime: 300 seconds by default, at most 900. Bootstrap lifetime: at most 120 seconds. Terminal-delivery window: at most 24 hours.

Configuration is submitted through the existing authenticated owner runtime configuration route. Disabling/removing a consumer or changing its grants revokes its outstanding leases and tool authority. Re-enabling a disabled consumer rotates its controller credential; it does not revive an old bearer.

Memory writes `bridge-v1.json` beneath its data directory with protocol version, service-instance identity, actual loopback endpoint, enabled state and consumer credential-file references. Descriptor/credential files are private mode 0600; private directories are 0700. Consumers must reread discovery after service or credential changes. Credentials are not returned in capabilities or owner status.

Private owner routes, requiring the existing internal service key:

| Route | Input | Result |
| --- | --- | --- |
| `POST /v1/bridge-status` | `{}` | Current consumer policies/enabled state/credential versions and explicit native qualification limits; no secrets |
| `POST /v1/bridge-rotate` | `{consumerId,expectedVersion,requestId}` | `{consumerId,credentialVersion}`; atomically rotates controller authority and revokes outstanding session/terminal/tool authority |
| `POST /v1/bridge-import-preview` | `{paths,namespace}` | Signed preview, selected file hashes, candidates, duplicates and unsupported content |
| `POST /v1/bridge-import` | `{importId,previewToken,approvedSourceIds}` | Proposed/duplicate counts, canonical memory references and stable source IDs |

Identical rotation/import requests replay their original receipt. Reusing a request ID with changed content conflicts. Rotation republishes discovery; consumers must read the new credential file. These owner controls are not additional public Bridge v1 endpoints.

## Credential roles and create handshake

Controller credentials authorize capabilities and register/bind/renew/release. The controller retains each scoped `sessionToken` for context and active event/feedback calls. A separate signed, purpose-scoped agent MCP credential is staged inactive, then activates only after authenticated observed bind. Neither controller credentials nor session tokens enter agent environment, prompts or MCP configuration.

1. The controller registers immutable origin, intended agent ID, expected identity, ownership and requested namespaces. The returned pending session can prepare controller context before creating the physical agent.
2. Only the nonauthorizing `PASEO_MEMORY_BOOTSTRAP_REF` enters the create environment. Memory's create hook attests actual provider/cwd observations and matching pending registration/config. That callback has no observed actual agent/workspace identity.
3. Bots' authenticated `session_open` gate supplies the actual agent/workspace/provider/cwd identity, checks the intended identity, binds the positive observed session epoch and consumes the reference before provider startup. It must remove the reserved environment key. No agent refresh/config RPC runs against an in-progress pre-native-persistence hook.
4. Memory's later `session_open` gate checks the durable managed claim and current bound authority. Every agent MCP call validates its exact session, epoch, authority fence and credential identity again, including inside mutation transactions.

Initial bind advances the authority fence. Pure TTL renewal preserves it. Release advances the current fence and revokes active rights, while retaining the original bound lease for terminal delivery. A released/expired lease cannot be renewed back into active authority. Intended and actual managed identities remain durably classified across plugin reload or owner disable, so native heuristics do not take over capture/review ownership.

History opens are nonexecuting: no bind, epoch increment, renewal, tool activation or review. They strip reserved bootstrap/standalone nonce environment keys and do not need a live lease. Interactive reopening without qualified credential rollover is refused.

## Public transport

| Endpoint | Authority |
| --- | --- |
| `GET /bridge/v1/capabilities` | Controller |
| `POST /bridge/v1/sessions` (`register`, `bind`, `renew`, `release`) | Controller |
| `POST /bridge/v1/context` | Scoped session token held by controller; pending or bound live lease |
| `POST /bridge/v1/events` | Bound scoped token while active; controller with original bound lease during the fixed terminal window |
| `POST /bridge/v1/feedback` | Same active/terminal split; limited pending discard/unknown reporting |

Transport is loopback HTTP only, rejects browser `Origin`, requires JSON and caps inbound bytes at 16 KiB before parsing. This inbound limit does not truncate context responses. Capabilities advertise the current consumer-granted owner context budget, not absolute ungranted limits. A consumer without context/read grants receives zero context allowance.

Errors use `{error:{code,message,retryable,details?}}`. Invalid credentials/grants use 401/403; request/revision/lease conflicts use 409; unsupported input semantics use 422; unavailable prerequisites use 503. Deterministic budget refusal is 422/nonretryable; temporarily occupied bounded capacity is 503/retryable.

## Context, replay and historical reads

Context uses the shared retrieval coordinator/packer, owner profile ceilings, whole-fragment accounting and honest exact/estimated token labeling. Explicit query, namespace, record-kind and budget fields cannot widen registered authority. `asOf` is explicit historical lexical retrieval, not a claim that old text is currently true. Both historical and current namespaces must be readable; forgotten or deleted sources are not historical escape hatches.

Context receipts store only an identifier, not a second plaintext context copy. Retries reauthorize current lease/grants, policy/source generations and exact selected sources before returning a cached body. Stale results return `context_invalidated` rather than replaying formerly private text. Selected source revisions and actual rendered session versions are preserved through final disclosure checks. Cache/admission limits are bounded independently of request output budgets.

Memory's service-read admission is a linearization point, not an atomic host/provider handoff. Revocation after a successful service snapshot can race hook return or provider dispatch. Prepared, attached, discarded and unknown delivery states must not be interpreted as provider consumption or usefulness.

## Events and feedback

An event is immutable under authenticated consumer + execution identity + session epoch + event ID. Provider turn IDs are observations, not dedupe identity. Exact transport retries return the original receipt; a new transport request for the same immutable event returns duplicate with the same committed `eventRef`. Changed payload fields conflict. Existing committed historical source references remain retryable only while current and historical read authority/tombstones permit them. New events require admissible current sources.

Event payload, normalized source links, bounded processing intent and transport receipt commit atomically. Source forget erases controlled payloads and revokes affected downstream contexts, not just the current result index. Unknown unverified outcomes remain unknown. Successful/verifier/evidence/model-usage claims requiring the unshipped trusted resolver are refused, never silently promoted.

Feedback acknowledges `{protocolVersion:1,retrievalId,status:"accepted"|"duplicate"}`. Each assessment must refer to an exact actually delivered canonical reference under the authenticated origin. New fragments are authorized even when they repeat an already-recorded source assessment. Mixed batches are accepted if any new authorized fact commits, duplicate only when all facts are proven duplicates, and roll back entirely on changed-content conflicts.

Agent reports do not claim human/validator authority. Historical-target feedback can be recorded without boosting the current revision. Exposure/open/application/validated-assessment counters remain distinct; feedback and retrieval do not freshen factual verification. Delivery accounting settles the original prepared attempt once, preserving exact/estimated attribution and unknown billing.

## One-off Markdown import

Import is an explicit owner preview/approval operation, including while Bridge is disabled. It does not recursively scan folders, read private run-artifact JSON, export raw paths through Bridge, or delete/overwrite original Markdown files.

- At most 32 explicit absolute `.md` paths, 64 KiB per file and 128 candidate facts. Symlink files, invalid UTF-8, code blocks, oversized/sensitive facts and unsupported content are reported instead of silently ingested.
- Preview includes file/source hashes, stable source IDs, exact duplicate decisions and counts. Its metadata-only HMAC token expires after 15 minutes. Changed files or duplicate decisions require a fresh preview.
- Only approved source IDs are proposed as unverified candidates, with genuine source-artifact provenance. Resolving an imported artifact is not factual verification or promotion.
- Exact existing duplicates are not mutated. Duplicate races roll back the import. Replay checks exact namespace/revision and source tombstones, so correction/move/forget cannot resurrect a prior import.

The source ID hashes the canonical namespace, canonical file path, file SHA256 and extracted-block ordinal with unambiguous separators. This is stable for identical input, not a cross-file claim-equivalence identifier. Memory becomes the sole writer only after explicit owner migration and a qualified controller cutover; optional Markdown snapshots must not become a competing live memory writer.
