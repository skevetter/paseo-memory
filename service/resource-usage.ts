import type { Database } from "bun:sqlite";
import {
  type ModelUsageInput,
  ModelUsageInputSchema,
  type ParsedModelUsage,
  type ResourceUsage,
  type UsageTotals,
} from "../shared/resources";
import { type ContextSettlement, ContextSettlementSchema } from "../shared/service-api";
import type { RetrievalAudit } from "./audit";
import { canonicalBody, MutationError } from "./mutations";
import { sha256 } from "./text";

type Stage = ParsedModelUsage["stage"];
type Provenance = ParsedModelUsage["provenance"];
type Status = ParsedModelUsage["status"];
interface StatusRow {
  stage: Stage;
  status: Status;
  n: number;
  without_usage: number;
  without_billing: number;
}
interface TokenRow {
  stage: Stage;
  provenance: Provenance;
  n: number;
  input_tokens: number | null;
  output_tokens: number | null;
}
interface CostRow {
  stage: Stage;
  provenance: Provenance;
  currency: string;
  amount: number;
  n: number;
}
type PreparedFragment = Omit<ParsedModelUsage, "eventId" | "sourceSequence" | "stage" | "status">;

// Source ordinals order immutable cumulative snapshots; receipt order never determines metrics or status.
const OBSERVATIONS = `WITH observations AS (
 SELECT stage,producer_id,attempt_id,provenance,
 row_number() OVER (PARTITION BY producer_id,attempt_id,stage,provenance ORDER BY source_sequence DESC) AS rn,
 first_value(input_tokens) OVER (PARTITION BY producer_id,attempt_id,stage,provenance ORDER BY input_tokens IS NULL,source_sequence DESC) AS input_tokens,
 first_value(output_tokens) OVER (PARTITION BY producer_id,attempt_id,stage,provenance ORDER BY output_tokens IS NULL,source_sequence DESC) AS output_tokens,
 first_value(cost_amount) OVER (PARTITION BY producer_id,attempt_id,stage,provenance ORDER BY cost_amount IS NULL,source_sequence DESC) AS cost_amount,
 first_value(currency) OVER (PARTITION BY producer_id,attempt_id,stage,provenance ORDER BY cost_amount IS NULL,source_sequence DESC) AS currency
 FROM model_usage)
`;

export class ResourceUsageLedger {
  constructor(
    private readonly db: Database,
    private readonly now: () => string,
  ) {}

  record(producerId: string, raw: ModelUsageInput): { recorded: boolean; duplicate: boolean } {
    const input = ModelUsageInputSchema.parse(raw);
    const hash = sha256(canonicalBody(input));
    return this.db
      .transaction(() => {
        const prior = this.db
          .query<{ request_hash: string }, [string, string]>(
            "SELECT request_hash FROM model_usage WHERE producer_id=? AND event_id=?",
          )
          .get(producerId, input.eventId);
        if (prior) {
          if (prior.request_hash !== hash)
            throw new MutationError(
              "request_conflict",
              "This usage event already has a different canonical body.",
            );
          return { recorded: true, duplicate: true };
        }
        this.checkSequence(producerId, input);
        this.checkProviderSource(producerId, input);
        this.checkCurrency(producerId, input);
        this.db
          .query(`INSERT INTO model_usage
    (producer_id,event_id,attempt_id,source_sequence,request_hash,stage,status,provenance,model,input_tokens,output_tokens,cost_amount,currency,source_event_id,retrieval_id,job_id,estimator,duration_ms,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            producerId,
            input.eventId,
            input.attemptId,
            input.sourceSequence,
            hash,
            input.stage,
            input.status,
            input.provenance,
            input.model,
            input.inputTokens,
            input.outputTokens,
            input.costAmount,
            input.currency,
            input.sourceEventId,
            input.retrievalId,
            input.jobId,
            input.estimator,
            input.durationMs,
            this.now(),
          );
        return { recorded: true, duplicate: false };
      })
      .immediate();
  }

  private checkSequence(producerId: string, input: ParsedModelUsage): void {
    const prior = this.db
      .query<{ event_id: string }, [string, string, string, number]>(`SELECT event_id FROM model_usage
   WHERE producer_id=? AND attempt_id=? AND stage=? AND source_sequence=?`)
      .get(producerId, input.attemptId, input.stage, input.sourceSequence);
    if (prior)
      throw new MutationError(
        "request_conflict",
        "One source observation cannot be assigned to different usage events.",
      );
  }

  private checkProviderSource(producerId: string, input: ParsedModelUsage): void {
    if (input.provenance !== "provider_observed") return;
    const prior = this.db
      .query<{ event_id: string }, [string, string]>(
        "SELECT event_id FROM model_usage WHERE producer_id=? AND source_event_id=? AND provenance='provider_observed'",
      )
      .get(producerId, input.sourceEventId as string);
    if (prior)
      throw new MutationError(
        "request_conflict",
        "This provider source event has already been accounted for.",
      );
  }

  private checkCurrency(producerId: string, input: ParsedModelUsage): void {
    if (input.currency === null) return;
    const prior = this.db
      .query<{ currency: string }, [string, string, string, string]>(`SELECT currency FROM model_usage
   WHERE producer_id=? AND attempt_id=? AND stage=? AND provenance=? AND cost_amount IS NOT NULL ORDER BY source_sequence DESC LIMIT 1`)
      .get(producerId, input.attemptId, input.stage, input.provenance);
    if (prior && prior.currency !== input.currency)
      throw new MutationError("request_conflict", "One attempt/provenance cannot change billing currency.");
  }

  prepared(result: RetrievalAudit): void {
    const estimator = result.usage.estimator;
    this.record("memory_runtime", {
      eventId: `prepared:${result.retrievalId}`,
      attemptId: result.retrievalId,
      sourceSequence: 0,
      stage: "memory_input",
      status: "prepared",
      provenance: result.usage.tokenCountIsEstimate ? "estimate" : "local_exact",
      inputTokens: result.usage.tokenCount,
      retrievalId: result.retrievalId,
      estimator: estimator.length <= 200 ? estimator : `sha256:${sha256(estimator)}`,
      durationMs: result.usage.latencyMs,
    });
  }

  settleContext(raw: ContextSettlement): { recorded: boolean; duplicate: boolean } {
    const input = ContextSettlementSchema.parse(raw);
    return this.db
      .transaction(() => {
        const issued = this.db
          .query<{ found: number }, [string, string]>(`SELECT 1 AS found FROM audit_events
    WHERE nonce=? AND kind='inject'
      AND json_extract(CASE WHEN json_valid(detail) THEN detail ELSE '{}' END,'$.retrieval.retrievalId')=?
    LIMIT 1`)
          .get(input.nonce, input.retrievalId);
        const prepared = this.db
          .query<PreparedFragment, [string, string, string]>(`SELECT attempt_id AS attemptId,
     provenance,model,input_tokens AS inputTokens,output_tokens AS outputTokens,cost_amount AS costAmount,
     currency,source_event_id AS sourceEventId,retrieval_id AS retrievalId,job_id AS jobId,
     estimator,duration_ms AS durationMs FROM model_usage
    WHERE producer_id='memory_runtime' AND event_id=? AND attempt_id=? AND retrieval_id=?
      AND stage='memory_input' AND status='prepared' AND source_sequence=0
      AND provenance IN ('local_exact','estimate')`)
          .get(`prepared:${input.retrievalId}`, input.retrievalId, input.retrievalId);
        if (!issued || !prepared)
          throw new MutationError(
            "context_invalidated",
            "No issued agent-create fragment matches this settlement.",
          );
        return this.record("memory_runtime", {
          ...prepared,
          eventId: `settled:${sha256(input.retrievalId)}`,
          sourceSequence: 1,
          stage: "memory_input",
          status: input.status,
        });
      })
      .immediate();
  }

  summary(): ResourceUsage {
    const totals = new Map<Stage, UsageTotals>();
    const get = (stage: Stage) => {
      let found = totals.get(stage);
      if (!found) {
        found = emptyUsage();
        totals.set(stage, found);
      }
      return found;
    };
    for (const row of this.statuses()) addStatus(get(row.stage), row);
    for (const row of this.tokens()) addTokens(get(row.stage), row);
    for (const row of this.costs()) addCost(get(row.stage), row);
    const stages = {
      review: get("review"),
      extraction: get("extraction"),
      consolidation: get("consolidation"),
      validation: get("validation"),
    };
    const maintenance = emptyUsage();
    for (const value of Object.values(stages)) mergeUsage(maintenance, value);
    return {
      observedSince:
        this.db
          .query<{ value: string }, []>("SELECT value FROM meta WHERE key='resource_observation_epoch'")
          .get()?.value ?? null,
      memoryInput: get("memory_input"),
      maintenance,
      providerTurns: get("provider_turn"),
      stages,
      attribution:
        "Fragment counts are not provider billing or causal usefulness; absent provider values remain unknown. Native turn counts are incomplete host observations: missing IDs are omitted and reopened turn IDs can coalesce.",
    };
  }

  private statuses(): StatusRow[] {
    return this.db
      .query<StatusRow, []>(`WITH latest AS (
   SELECT stage,status,row_number() OVER (PARTITION BY producer_id,attempt_id,stage ORDER BY source_sequence DESC) AS rn,
   max(provenance!='unavailable') OVER (PARTITION BY producer_id,attempt_id,stage) AS has_usage,
   max(provenance='provider_observed' AND cost_amount IS NOT NULL) OVER (PARTITION BY producer_id,attempt_id,stage) AS has_billing
   FROM model_usage)
   SELECT stage,status,count(*) AS n,sum(has_usage=0) AS without_usage,sum(has_billing=0) AS without_billing
   FROM latest WHERE rn=1 GROUP BY stage,status`)
      .all();
  }
  private tokens(): TokenRow[] {
    return this.db
      .query<TokenRow, []>(
        `${OBSERVATIONS}SELECT stage,provenance,count(*) AS n,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens FROM observations WHERE rn=1 GROUP BY stage,provenance`,
      )
      .all();
  }
  private costs(): CostRow[] {
    return this.db
      .query<CostRow, []>(
        `${OBSERVATIONS}SELECT stage,provenance,currency,sum(cost_amount) AS amount,count(*) AS n FROM observations WHERE rn=1 AND cost_amount IS NOT NULL GROUP BY stage,provenance,currency`,
      )
      .all();
  }
}

function emptyUsage(): UsageTotals {
  return {
    attempts: 0,
    prepared: 0,
    attached: 0,
    discarded: 0,
    requested: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    unknown: 0,
    inputTokens: { providerObserved: null, localExact: null, estimated: null },
    outputTokens: { providerObserved: null, localExact: null, estimated: null },
    observedCosts: [],
    estimatedCosts: [],
    unavailableBillingAttempts: 0,
    providerObservedAttempts: 0,
    localExactAttempts: 0,
    estimatedAttempts: 0,
    unavailableUsageAttempts: 0,
  };
}
function addStatus(total: UsageTotals, row: StatusRow): void {
  total.attempts += row.n;
  total[row.status] += row.n;
  total.unavailableBillingAttempts += row.without_billing;
  total.unavailableUsageAttempts += row.without_usage;
}
const TOKEN_KEYS = {
  provider_observed: "providerObserved",
  local_exact: "localExact",
  estimate: "estimated",
} as const;
const COVERAGE_KEYS = {
  provider_observed: "providerObservedAttempts",
  local_exact: "localExactAttempts",
  estimate: "estimatedAttempts",
} as const;
function knownSum(left: number | null, right: number | null): number | null {
  if (right === null) return left;
  const sum = (left ?? 0) + right;
  if (!Number.isSafeInteger(sum))
    throw new MutationError("accounting_overflow", "Recorded token totals exceed the exact numeric range.");
  return sum;
}
function addTokens(total: UsageTotals, row: TokenRow): void {
  if (row.provenance === "unavailable") return;
  const key = TOKEN_KEYS[row.provenance];
  total.inputTokens[key] = knownSum(total.inputTokens[key], row.input_tokens);
  total.outputTokens[key] = knownSum(total.outputTokens[key], row.output_tokens);
  total[COVERAGE_KEYS[row.provenance]] += row.n;
}
function addCost(total: UsageTotals, row: Pick<CostRow, "provenance" | "currency" | "amount" | "n">): void {
  const costs = row.provenance === "provider_observed" ? total.observedCosts : total.estimatedCosts;
  const found = costs.find((cost) => cost.currency === row.currency);
  if (found) {
    found.amount += row.amount;
    found.observations += row.n;
  } else costs.push({ currency: row.currency, amount: row.amount, observations: row.n });
  costs.sort((a, b) => a.currency.localeCompare(b.currency));
}
function mergeUsage(target: UsageTotals, source: UsageTotals): void {
  for (const key of [
    "attempts",
    "prepared",
    "attached",
    "discarded",
    "requested",
    "completed",
    "failed",
    "cancelled",
    "unknown",
    "unavailableBillingAttempts",
    "providerObservedAttempts",
    "localExactAttempts",
    "estimatedAttempts",
    "unavailableUsageAttempts",
  ] as const)
    target[key] += source[key];
  for (const key of ["providerObserved", "localExact", "estimated"] as const) {
    target.inputTokens[key] = knownSum(target.inputTokens[key], source.inputTokens[key]);
    target.outputTokens[key] = knownSum(target.outputTokens[key], source.outputTokens[key]);
  }
  for (const cost of source.observedCosts)
    addCost(target, {
      provenance: "provider_observed",
      currency: cost.currency,
      amount: cost.amount,
      n: cost.observations,
    });
  for (const cost of source.estimatedCosts)
    addCost(target, {
      provenance: "estimate",
      currency: cost.currency,
      amount: cost.amount,
      n: cost.observations,
    });
}
