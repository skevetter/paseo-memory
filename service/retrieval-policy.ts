import type { Database } from "bun:sqlite";
import { RecordKindSchema } from "../shared/lifecycle";
import {
  RETRIEVAL_ABSOLUTE_LIMITS,
  RETRIEVAL_BUDGET_KEYS,
  type RecordKind,
  type RerankMode,
  type RetrievalBudget,
  type RetrievalDetail,
  RetrievalDetailSchema,
  type RetrievalProfileName,
  RetrievalProfileNameSchema,
  type RetrievalRequest,
  RetrievalRequestSchema,
} from "../shared/retrieval";
import { DEFAULT_RUNTIME, type RuntimeConfig, RuntimeConfigSchema } from "../shared/service-api";
import { canonicalBody, MutationError } from "./mutations";
import { sha256 } from "./text";

export interface ResolvedRetrievalPolicy {
  profileName: RetrievalProfileName;
  limits: RetrievalBudget;
  recordKinds: RecordKind[];
  detail: RetrievalDetail;
  maxDetail: RetrievalDetail;
  rerankMode: RerankMode;
  reservedTokens: number;
  reservedChars: number;
  reservedBytes: number;
  policyRevision: number;
}

export class RetrievalPolicies {
  private config: RuntimeConfig = DEFAULT_RUNTIME;
  private policyRevision = 0;

  constructor(private readonly db: Database) {
    const saved = this.db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key='retrieval_policy_config'")
      .get();
    let config = DEFAULT_RUNTIME;
    if (saved) {
      try {
        const parsed = RuntimeConfigSchema.safeParse(JSON.parse(saved.value));
        if (parsed.success) config = parsed.data;
      } catch {
        // Invalid saved settings fall back to bounded defaults, never an unrestricted policy.
      }
    }
    this.configure(config);
  }

  get revision(): number {
    return this.policyRevision;
  }

  get runtime(): RuntimeConfig {
    return this.config;
  }

  configure(config: RuntimeConfig): void {
    const parsed = RuntimeConfigSchema.parse(config);
    const settings = parsed.retrievalPolicy;
    // These arrays express sets; equivalent owner settings must not churn the durable revision.
    const policy = {
      ...settings,
      allowedProfiles: RetrievalProfileNameSchema.options.filter((name) =>
        settings.allowedProfiles.includes(name),
      ),
      profiles: { ...settings.profiles },
    };
    for (const name of RetrievalProfileNameSchema.options) {
      const profile = settings.profiles[name];
      policy.profiles[name] = {
        ...profile,
        allowedRecordKinds: RecordKindSchema.options.filter((kind) =>
          profile.allowedRecordKinds.includes(kind),
        ),
      };
    }
    parsed.retrievalPolicy = policy;
    const hash = sha256(
      canonicalBody({
        retrievalPolicy: policy,
        contextBudgetChars: parsed.contextBudgetChars,
        maxPinned: parsed.maxPinned,
        taskMatches: parsed.taskMatches,
        taskStrictness: parsed.taskStrictness,
        projectMemories: parsed.projectMemories,
        globalMemories: parsed.globalMemories,
        recentSessions: parsed.recentSessions,
        detailLevel: parsed.detailLevel,
        extraInstructions: parsed.extraInstructions,
        usageRanking: parsed.usageRanking,
        staleDays: parsed.staleDays,
      }),
    );
    const revision = this.db
      .transaction(() => {
        const rows = this.db
          .query<{ key: string; value: string }, []>(
            "SELECT key,value FROM meta WHERE key IN ('retrieval_policy_hash','retrieval_policy_revision')",
          )
          .all();
        const previous = rows.find((row) => row.key === "retrieval_policy_revision")?.value;
        const current = previous === undefined ? 0 : Number(previous);
        if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER)
          throw new Error("Invalid durable retrieval policy revision.");
        const unchanged = rows.find((row) => row.key === "retrieval_policy_hash")?.value === hash;
        const next = unchanged && current > 0 ? current : current + 1;
        const save = this.db.query(
          "INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        );
        save.run("retrieval_policy_hash", hash);
        save.run("retrieval_policy_revision", String(next));
        save.run("retrieval_policy_config", JSON.stringify(parsed));
        return next;
      })
      .immediate();
    this.config = parsed;
    this.policyRevision = revision;
  }

  resolve(request?: RetrievalRequest): ResolvedRetrievalPolicy {
    const input = RetrievalRequestSchema.parse(request ?? {});
    const settings = this.config.retrievalPolicy;
    const profileName = input.profile ?? settings.defaultProfile;
    if (!settings.allowedProfiles.includes(profileName))
      throw new MutationError("scope_denied", "The retrieval profile is not allowed by owner policy.", {
        profile: profileName,
        allowedProfiles: [...settings.allowedProfiles],
        policyRevision: this.policyRevision,
      });
    const profile = settings.profiles[profileName];
    const limits: RetrievalBudget = {
      maxTokens: profile.maxTokens,
      maxChars: profile.maxChars,
      maxBytes: profile.maxBytes,
      maxLatencyMs: profile.maxLatencyMs,
      maxCandidates: profile.maxCandidates,
      maxItems: profile.maxItems,
    };
    for (const key of RETRIEVAL_BUDGET_KEYS)
      limits[key] = Math.min(limits[key], input.budget?.[key] ?? limits[key], RETRIEVAL_ABSOLUTE_LIMITS[key]);
    limits.maxChars = Math.min(limits.maxChars, this.config.contextBudgetChars);
    const requestedDetail = input.detail ?? (this.config.detailLevel === "titles" ? "references" : "compact");
    const detail =
      RetrievalDetailSchema.options.indexOf(requestedDetail) <=
      RetrievalDetailSchema.options.indexOf(profile.detail)
        ? requestedDetail
        : profile.detail;
    return {
      profileName,
      limits,
      recordKinds: profile.allowedRecordKinds.filter(
        (kind) => !input.recordKinds || input.recordKinds.includes(kind),
      ),
      detail,
      maxDetail: profile.detail,
      rerankMode: profile.rerankMode,
      reservedTokens: settings.reservedTokens,
      reservedChars: settings.reservedChars,
      reservedBytes: settings.reservedBytes,
      policyRevision: this.policyRevision,
    };
  }
}
