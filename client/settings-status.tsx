import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import type { MemoryStatus } from "../shared/contracts";
import type { InferenceStage, InferenceStageSnapshot } from "../shared/inference";
import { INFERENCE_LATENCY_HISTORY_LIMIT, INFERENCE_STAGES } from "../shared/inference";
import type { ModelIndexStatus, ResourceStatus, ResourceUsage, UsageTotals } from "../shared/resources";
import { TIER_NAMES } from "./settings-options";

type ServiceInfo = MemoryStatus["service"];
type LiveInfo = NonNullable<MemoryStatus["live"]>;

interface RowText {
  hint: string;
  error: string | null;
}

function serviceText(service: ServiceInfo): RowText {
  switch (service.state) {
    case "running":
      return { hint: "Running", error: null };
    case "starting":
      return { hint: "Starting", error: null };
    case "restarting":
      return { hint: service.detail ? `Restarting: ${service.detail}` : "Restarting", error: null };
    case "fatal":
      return { hint: "", error: service.detail ? `Stopped: ${service.detail}` : "Stopped" };
    case "stopped":
      return { hint: "Stopped", error: null };
  }
}

function embedderText({ embedder }: LiveInfo): RowText {
  const name = `${TIER_NAMES[embedder.tier]} · ${embedder.model}`;
  if (embedder.state === "error") return { hint: name, error: embedder.error ?? "The model failed to load." };
  if (embedder.failed > 0) {
    const reason = embedder.indexError ? `: ${embedder.indexError}` : "";
    return { hint: name, error: `${embedder.failed} memories could not be indexed${reason}` };
  }
  if (embedder.pending > 0)
    return { hint: `${name} · Loading (${embedder.pending} left to index)`, error: null };
  if (embedder.state === "loading") return { hint: `${name} · Loading`, error: null };
  return { hint: `${name} · Ready`, error: null };
}

const RERANKER_STATES = { off: "Off", ready: "Ready", loading: "Loading", error: "" } as const;

function rerankerText({ reranker }: LiveInfo): RowText {
  if (reranker.state === "error") return { hint: "", error: reranker.error ?? "The model failed to load." };
  return { hint: RERANKER_STATES[reranker.state], error: null };
}

interface StatusProps {
  status: MemoryStatus | null;
  error: string | null;
}

export function StatusSection({ status, error }: StatusProps) {
  const service = status ? serviceText(status.service) : { hint: "Loading…", error: null };
  return (
    <>
      <SettingsSection title="Status">
        <SettingsCard>
          <SettingsRow
            label="Memory service"
            hint={service.hint || undefined}
            error={error ?? service.error}
          />
          {status?.live ? <LiveRows live={status.live} /> : null}
        </SettingsCard>
      </SettingsSection>
      <ResourceSections resources={status?.resources ?? null} />
    </>
  );
}

function LiveRows({ live }: { live: LiveInfo }) {
  const embedder = embedderText(live);
  const reranker = rerankerText(live);
  const versions = [
    `Memory ${live.version}`,
    `Bun ${live.bunVersion}`,
    `SQLite ${live.sqliteVersion}`,
    `sqlite-vec ${live.sqliteVecVersion}`,
  ].join(" · ");
  return (
    <>
      <SettingsRow label="Versions" hint={versions} />
      <SettingsRow label="Embedding model" hint={embedder.hint} error={embedder.error} />
      <SettingsRow label="Re-ranker" hint={reranker.hint || undefined} error={reranker.error} />
      <SettingsRow
        label="Contents"
        hint={`${live.memories} memories · ${live.projects} projects · ${live.sessions} sessions`}
      />
      <SettingsRow label="Database" hint={live.dbPath} />
    </>
  );
}

const INFERENCE_NAMES: Record<InferenceStage, string> = {
  document_embedding: "Document embedding",
  query_embedding: "Query embedding",
  rerank: "Re-ranking",
};

const MAINTENANCE_STAGES = [
  { key: "review", label: "Review" },
  { key: "extraction", label: "Extraction" },
  { key: "consolidation", label: "Consolidation" },
  { key: "validation", label: "Validation" },
] as const;

function ResourceSections({ resources }: { resources: ResourceStatus | null }) {
  if (!resources) {
    return (
      <SettingsSection title="Resources">
        <SettingsCard>
          <SettingsRow
            label="Resource diagnostics"
            hint="Unavailable until the service reports diagnostics."
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  return (
    <>
      <ProcessSection resources={resources} />
      <InferenceSection resources={resources} />
      <IndexSection indexes={resources.indexes} />
      <UsageSections usage={resources.usage} />
      <FeedbackSection feedback={resources.feedback} />
    </>
  );
}

function ProcessSection({ resources }: { resources: ResourceStatus }) {
  const { process: metrics, observationEpoch } = resources;
  return (
    <SettingsSection title="Local process resources">
      <SettingsCard>
        <SettingsRow
          label="Resource attribution"
          hint="CPU is cumulative since process start; RSS and heap are current process samples, not per-request inference costs."
        />
        <SettingsRow label="Snapshot observed at" hint={resources.observedAt} />
        <SettingsRow label="Observation epoch" hint={observationEpoch ?? "Unknown"} />
        <SettingsRow label="Process uptime" hint={durationText(metrics.uptimeMs)} />
        <SettingsRow
          label="Cumulative CPU"
          hint={`User ${durationText(metrics.cpuUserMicros / 1000)} · System ${durationText(metrics.cpuSystemMicros / 1000)}`}
        />
        <SettingsRow
          label="Process memory"
          hint={`RSS ${bytesText(metrics.rssBytes)} · Heap used ${bytesText(metrics.heapUsedBytes)}`}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function InferenceSection({ resources }: { resources: ResourceStatus }) {
  const queue = resources.inference;
  const latencyInfo = `Percentiles use the latest up to ${INFERENCE_LATENCY_HISTORY_LIMIT} samples per metric. Unknown percentiles are not zero.`;
  return (
    <>
      <SettingsSection title="Local inference">
        <SettingsCard>
          <SettingsRow label="Latency window" hint={latencyInfo} />
          <SettingsRow
            label="Active / concurrency limit"
            hint={`${countText(queue.active)} / ${countText(queue.limits.concurrency)}`}
          />
          <SettingsRow
            label="Pending / queue limit"
            hint={`${countText(queue.pending)} / ${countText(queue.limits.maxPending)}`}
          />
          <SettingsRow
            label="Oldest queued request"
            hint={queue.pending === 0 ? "Queue empty" : durationText(queue.oldestQueuedMs)}
          />
          <SettingsRow label="Re-ranker fingerprint" hint={resources.rerankerFingerprint ?? "Unknown"} />
          <StageRows label="All inference" stage={queue} />
          {INFERENCE_STAGES.map((stage) => (
            <StageRows key={stage} label={INFERENCE_NAMES[stage]} stage={queue.stages[stage]} />
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Retrieval observations">
        <SettingsCard>
          <SettingsRow label="Latency window" hint={latencyInfo} />
          <StageRows label="Retrieval" stage={resources.retrieval} />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

function StageRows({ label, stage }: { label: string; stage: InferenceStageSnapshot }) {
  const { counts, latencyMs } = stage;
  const outcomes = [
    `${countText(counts.completed)} completed`,
    `${countText(counts.failed)} failed`,
    `${countText(counts.cancelled)} cancelled`,
    `${countText(counts.rejected)} rejected`,
  ].join(" · ");
  return (
    <>
      <SettingsRow label={`${label} outcomes`} hint={outcomes} />
      <SettingsRow
        label={`${label} latency`}
        hint={`p50 ${durationText(latencyMs.p50)} · p95 ${durationText(latencyMs.p95)} · ${countText(latencyMs.samples)} samples`}
      />
    </>
  );
}

function IndexSection({ indexes }: { indexes: ResourceStatus["indexes"] }) {
  const { retention } = indexes;
  return (
    <SettingsSection
      title="Model indexes"
      info="A fingerprint change builds a replacement. Retained indexes are read-only; the retention policy bounds retired indexes."
    >
      <SettingsCard>
        <SettingsRow label="Serving (active) fingerprint" hint={indexes.servingFingerprint ?? "Unknown"} />
        <SettingsRow label="Ready fingerprint" hint={indexes.readyFingerprint ?? "Unknown"} />
        <SettingsRow label="Target fingerprint" hint={indexes.targetFingerprint ?? "Unknown"} />
        <SettingsRow
          label="Corpus / eligible records"
          hint={`${countText(indexes.corpusRecords)} / ${countText(indexes.eligibleRecords)}`}
        />
        <SettingsRow label="Current vector entries" hint={countText(indexes.currentEntries)} />
        <SettingsRow label="Database size" hint={bytesText(indexes.databaseBytes)} />
        <SettingsRow
          label="Retired index retention"
          hint={`Maximum ${countText(retention.maxRetired)} indexes · Age limit ${countText(retention.retiredDays)} days · Retained indexes are read-only`}
        />
        {indexes.items.length === 0 ? (
          <SettingsRow label="Index inventory" hint="No indexes reported." />
        ) : null}
      </SettingsCard>
      {indexes.items.map((index) => (
        <IndexCard key={index.fingerprint} index={index} />
      ))}
    </SettingsSection>
  );
}

function IndexCard({ index }: { index: ModelIndexStatus }) {
  return (
    <SettingsCard>
      <SettingsRow label={`Index state: ${index.state}`} hint={index.fingerprint} />
      <SettingsRow label="Index model" hint={`${index.model} · ${countText(index.dims)} dimensions`} />
      <SettingsRow
        label="Index entries / identity"
        hint={`${countText(index.entries)} entries · Generation ${countText(index.generation)} · Identity ${index.identityKnown ? "known" : "unknown"}`}
      />
      <SettingsRow label="SQLite index allocation" hint={bytesText(index.indexBytes)} />
      <SettingsRow
        label="Manifest-declared artifacts"
        hint={`${bytesText(index.artifactBytes)} · Not unique or physical cache usage`}
      />
    </SettingsCard>
  );
}

function UsageSections({ usage }: { usage: ResourceUsage }) {
  return (
    <>
      <SettingsSection title="Usage observation window">
        <SettingsCard>
          <SettingsRow label="Usage attribution" hint={usage.attribution} />
          <SettingsRow label="Usage observed since" hint={usage.observedSince ?? "Unknown"} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Prepared memory fragments">
        <UsageCard
          totals={usage.memoryInput}
          basis="Local exact counts and estimates describe prepared fragments, not the full provider prompt, provider billing or confirmed attachment."
        />
      </SettingsSection>
      <SettingsSection title="Maintenance inference">
        <UsageCard
          totals={usage.maintenance}
          basis="Review, extraction, consolidation and validation usage. Observed provider values, local counts, estimates and unavailable values remain distinct."
        />
      </SettingsSection>
      <MaintenanceDetails stages={usage.stages} />
      <SettingsSection title="Provider turn observations">
        <UsageCard
          totals={usage.providerTurns}
          basis="Recorded provider usage is separate from prepared memory fragments and maintenance. Currency totals are never combined."
        />
      </SettingsSection>
    </>
  );
}

function UsageCard({ totals, basis }: { totals: UsageTotals; basis: string }) {
  const statuses = [
    `${countText(totals.requested)} requested`,
    `${countText(totals.completed)} completed`,
    `${countText(totals.failed)} failed`,
    `${countText(totals.cancelled)} cancelled`,
    `${countText(totals.unknown)} unknown`,
  ].join(" · ");
  return (
    <SettingsCard>
      <SettingsRow label="Usage interpretation" hint={basis} />
      <SettingsRow label="Attempts" hint={`${countText(totals.attempts)} total · ${statuses}`} />
      <SettingsRow
        label="Recorded delivery states"
        hint={`${countText(totals.prepared)} prepared · ${countText(totals.attached)} attached · ${countText(totals.discarded)} discarded`}
      />
      <SettingsRow
        label="Input tokens by provenance"
        hint={`Provider-observed ${countText(totals.inputTokens.providerObserved)} · Local exact ${countText(totals.inputTokens.localExact)} · Estimated ${countText(totals.inputTokens.estimated)}`}
      />
      <SettingsRow
        label="Output tokens by provenance"
        hint={`Provider-observed ${countText(totals.outputTokens.providerObserved)} · Local exact ${countText(totals.outputTokens.localExact)} · Estimated ${countText(totals.outputTokens.estimated)}`}
      />
      <SettingsRow
        label="Usage observation coverage"
        hint={`${countText(totals.providerObservedAttempts)} provider-observed · ${countText(totals.localExactAttempts)} local exact · ${countText(totals.estimatedAttempts)} estimated · ${countText(totals.unavailableUsageAttempts)} unavailable. Provenance counts may overlap.`}
      />
      <SettingsRow
        label="Attempts with unavailable billing"
        hint={countText(totals.unavailableBillingAttempts)}
      />
      <CostRows label="Observed provider billing" costs={totals.observedCosts} />
      <CostRows label="Estimated cost" costs={totals.estimatedCosts} />
    </SettingsCard>
  );
}

function CostRows({ label, costs }: { label: string; costs: UsageTotals["observedCosts"] }) {
  if (costs.length === 0) return <SettingsRow label={label} hint="Unknown (no values reported)" />;
  return (
    <>
      {costs.map((cost) => (
        <SettingsRow
          key={cost.currency}
          label={`${label} (${cost.currency})`}
          hint={`${cost.currency} ${cost.amount} · ${countText(cost.observations)} observations`}
        />
      ))}
    </>
  );
}

function MaintenanceDetails({ stages }: { stages: ResourceUsage["stages"] }) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection title="Maintenance stage details">
      <SettingsCard>
        <SettingsAction
          label="Per-stage usage and billing"
          hint="Inspect review, extraction, consolidation and validation independently."
          actionLabel={open ? "Hide" : "Show"}
          onPress={() => setOpen(!open)}
        />
      </SettingsCard>
      {open
        ? MAINTENANCE_STAGES.map(({ key, label }) => (
            <SettingsSection key={key} title={`${label} usage`}>
              <UsageCard
                totals={stages[key]}
                basis="Recorded per-stage usage; local counts and estimates are not observed provider billing."
              />
            </SettingsSection>
          ))
        : null}
    </SettingsSection>
  );
}

function FeedbackSection({ feedback }: { feedback: ResourceStatus["feedback"] }) {
  return (
    <SettingsSection title="Recorded memory feedback">
      <SettingsCard>
        <SettingsRow
          label="Feedback interpretation"
          hint={`Counts cover surviving records. ${feedback.basis}`}
        />
        <SettingsRow label="Exposures (cumulative)" hint={countText(feedback.exposures)} />
        <SettingsRow label="Opens (cumulative)" hint={countText(feedback.opens)} />
        <SettingsRow label="Applications (current revisions)" hint={countText(feedback.applications)} />
        <SettingsRow
          label="Validated helpful (current revisions)"
          hint={countText(feedback.validatedHelpful)}
        />
        <SettingsRow
          label="Validated harmful (current revisions)"
          hint={countText(feedback.validatedHarmful)}
        />
        <SettingsRow
          label="Assessment sources"
          hint={`${countText(feedback.agentReported)} agent-reported · ${countText(feedback.humanReported)} human-reported · ${countText(feedback.validatorReported)} validator-reported`}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function countText(value: number | null): string {
  return value === null ? "Unknown" : value.toLocaleString();
}

function durationText(milliseconds: number | null): string {
  if (milliseconds === null) return "Unknown";
  let divisor = 1;
  let unit = "ms";
  if (milliseconds >= 3_600_000) {
    divisor = 3_600_000;
    unit = "h";
  } else if (milliseconds >= 60_000) {
    divisor = 60_000;
    unit = "min";
  } else if (milliseconds >= 1000) {
    divisor = 1000;
    unit = "s";
  }
  return `${(milliseconds / divisor).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${unit}`;
}

function bytesText(bytes: number | null): string {
  if (bytes === null) return "Unknown";
  if (bytes < 1024) return `${countText(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  const power = Math.min(Math.floor(Math.log2(bytes) / 10), units.length);
  const value = (bytes / 1024 ** power).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${value} ${units[power - 1]}`;
}
