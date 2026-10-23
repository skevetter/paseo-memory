import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { MutationError } from "../service/mutations";
import { RetrievalPolicies } from "../service/retrieval-policy";
import { migrate } from "../service/schema";
import { openDatabase } from "../service/sqlite";
import { memorySettings, runtimeConfig } from "../shared/contracts";
import {
  RETRIEVAL_ABSOLUTE_LIMITS,
  RETRIEVAL_BUDGET_KEYS,
  RetrievalPolicySettingsSchema,
  RetrievalRequestSchema,
} from "../shared/retrieval";
import { DEFAULT_RUNTIME, type RuntimeConfig, RuntimeConfigSchema } from "../shared/service-api";
import { tempDir } from "./helpers";

let db: Database;
let policies: RetrievalPolicies;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  migrate(db);
  policies = new RetrievalPolicies(db);
});
afterEach(() => db.close());

describe("owner retrieval grants", () => {
  it("keeps title-only startup narrow while permitting deliberate compact expansion", () => {
    expect(policies.resolve()).toMatchObject({ profileName: "standard", detail: "references" });
    expect(policies.resolve({ detail: "compact" }).detail).toBe("compact");
    expect(policies.resolve({ detail: "full" }).detail).toBe("compact");
    expect(policies.resolve().recordKinds).toEqual([
      "fact",
      "preference",
      "episode",
      "derived_summary",
      "lesson",
    ]);
    expect(policies.resolve({ profile: "compact" }).recordKinds).not.toContain("episode");
    expect(policies.resolve().recordKinds).not.toContain("procedure_ref");
  });

  it("rejects an ungranted richer profile with a structured scope denial", () => {
    let error: unknown;
    try {
      policies.resolve({ profile: "evidence" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MutationError);
    expect(error).toMatchObject({
      code: "scope_denied",
      details: {
        profile: "evidence",
        allowedProfiles: ["compact", "standard"],
        policyRevision: policies.revision,
      },
    });
  });

  it("permits owner-enabled evidence but retains the global character ceiling", () => {
    const config = structuredClone(DEFAULT_RUNTIME);
    config.retrievalPolicy.allowedProfiles.push("evidence");
    policies.configure(config);
    const evidence = policies.resolve({ profile: "evidence", detail: "full" });
    expect(evidence.detail).toBe("full");
    expect(evidence.limits.maxChars).toBe(config.contextBudgetChars);
    expect(evidence.limits.maxTokens).toBe(config.retrievalPolicy.profiles.evidence.maxTokens);
    expect(evidence.limits.maxBytes).toBe(config.retrievalPolicy.profiles.evidence.maxBytes);
    expect(policies.resolve({ profile: "evidence" }).detail).toBe("references");
  });

  it("uses the owner default profile rather than implicitly granting standard", () => {
    const config = structuredClone(DEFAULT_RUNTIME);
    config.retrievalPolicy.defaultProfile = "compact";
    config.retrievalPolicy.allowedProfiles = ["compact"];
    policies.configure(config);
    expect(policies.resolve().profileName).toBe("compact");
    expect(() => policies.resolve({ profile: "standard" })).toThrow(MutationError);
  });

  it("caps implicit summary display and explicit expansion by profile detail", () => {
    const config = structuredClone(DEFAULT_RUNTIME);
    config.detailLevel = "summaries";
    policies.configure(config);
    expect(policies.resolve().detail).toBe("compact");
    config.retrievalPolicy.profiles.standard.detail = "references";
    policies.configure(config);
    expect(policies.resolve().detail).toBe("references");
    expect(policies.resolve({ detail: "full" }).detail).toBe("references");
    expect(policies.resolve({ detail: "references" }).detail).toBe("references");
  });
});

describe("retrieval budget and kind narrowing", () => {
  it.each([...RETRIEVAL_BUDGET_KEYS])("clamps %s to the owner maximum while honoring zero", (key) => {
    const config = structuredClone(DEFAULT_RUNTIME);
    config.retrievalPolicy.profiles.standard[key] = key === "maxChars" ? 550 : 7;
    policies.configure(config);
    const ownerLimit = config.retrievalPolicy.profiles.standard[key];
    expect(policies.resolve({ budget: { [key]: Number.MAX_SAFE_INTEGER } }).limits[key]).toBe(ownerLimit);
    expect(policies.resolve({ budget: { [key]: 0 } }).limits[key]).toBe(0);
    expect(policies.resolve({ budget: { [key]: 3 } }).limits[key]).toBe(3);
  });

  it("applies the global hard ceiling even when legacy service configuration exceeds absolute limits", () => {
    const config = structuredClone(DEFAULT_RUNTIME);
    config.contextBudgetChars = Number.MAX_SAFE_INTEGER;
    config.retrievalPolicy.allowedProfiles.push("evidence");
    config.retrievalPolicy.profiles.evidence.maxChars = RETRIEVAL_ABSOLUTE_LIMITS.maxChars;
    policies.configure(config);
    expect(policies.resolve({ profile: "evidence" }).limits.maxChars).toBe(
      RETRIEVAL_ABSOLUTE_LIMITS.maxChars,
    );
    config.contextBudgetChars = 500;
    policies.configure(config);
    expect(policies.resolve({ profile: "evidence", budget: { maxChars: 1000 } }).limits.maxChars).toBe(500);
    expect(policies.resolve({ profile: "evidence", budget: { maxChars: 250 } }).limits.maxChars).toBe(250);
  });

  it("intersects record kinds rather than granting requested executable procedures", () => {
    expect(policies.resolve({ recordKinds: ["procedure_ref", "fact"] }).recordKinds).toEqual(["fact"]);
    expect(policies.resolve({ recordKinds: ["procedure_ref"] }).recordKinds).toEqual([]);
    expect(policies.resolve({ recordKinds: [] }).recordKinds).toEqual([]);
    const config = structuredClone(DEFAULT_RUNTIME);
    config.retrievalPolicy.profiles.standard.allowedRecordKinds = ["procedure_ref"];
    policies.configure(config);
    expect(policies.resolve({ recordKinds: ["procedure_ref", "fact"] }).recordKinds).toEqual([
      "procedure_ref",
    ]);
    config.retrievalPolicy.profiles.standard.allowedRecordKinds = [];
    policies.configure(config);
    expect(policies.resolve().recordKinds).toEqual([]);
  });

  it("leaves owner overhead reservations separate from the pre-packing limits", () => {
    const config = structuredClone(DEFAULT_RUNTIME);
    config.retrievalPolicy.reservedTokens = 2000;
    config.retrievalPolicy.reservedChars = 1500;
    config.retrievalPolicy.reservedBytes = 5000;
    policies.configure(config);
    expect(policies.resolve({ budget: { maxTokens: 10, maxChars: 10, maxBytes: 10 } })).toMatchObject({
      limits: { maxTokens: 10, maxChars: 10, maxBytes: 10 },
      reservedTokens: 2000,
      reservedChars: 1500,
      reservedBytes: 5000,
    });
  });

  it("does not expose mutable owner settings through resolved policy values", () => {
    const original = policies.resolve();
    const changed = policies.resolve();
    changed.limits.maxChars = 0;
    changed.recordKinds.length = 0;
    expect(policies.resolve()).toEqual(original);
    const config = structuredClone(DEFAULT_RUNTIME);
    policies.configure(config);
    config.retrievalPolicy.profiles.standard.maxChars = 0;
    config.retrievalPolicy.profiles.standard.allowedRecordKinds.length = 0;
    expect(policies.resolve()).toEqual(original);
  });
});

describe("retrieval boundary validation", () => {
  it.each([
    { namespace: { kind: "global" } },
    { principal: "owner" },
    { grants: ["all"] },
    { scope: "all" },
    { budget: { reservedTokens: 0 } },
    { budget: { maxChars: 1, namespace: "global" } },
  ])("rejects caller-supplied authority and unknown nested fields: %j", (input) => {
    expect(() => RetrievalRequestSchema.parse(input)).toThrow();
  });

  it.each([
    { profile: "unlimited" },
    { detail: "raw" },
    { recordKinds: ["instructions"] },
    { query: "x".repeat(501) },
    { ids: Array.from({ length: 21 }, (_, index) => index + 1) },
    { ids: [0] },
    { ids: [1.5] },
    { tokenizerId: "" },
    { tokenizerId: "x".repeat(201) },
    { budget: { maxTokens: -1 } },
    { budget: { maxBytes: 0.5 } },
    { budget: { maxLatencyMs: Number.POSITIVE_INFINITY } },
    { budget: { maxCandidates: Number.NaN } },
    { budget: { maxItems: Number.MAX_SAFE_INTEGER + 1 } },
  ])("rejects malformed or unbounded retrieval input: %j", (input) => {
    expect(RetrievalRequestSchema.safeParse(input).success).toBe(false);
  });

  it.each([...RETRIEVAL_BUDGET_KEYS])("rejects owner %s above the service absolute ceiling", (key) => {
    const config = structuredClone(DEFAULT_RUNTIME);
    config.retrievalPolicy.profiles.standard[key] = RETRIEVAL_ABSOLUTE_LIMITS[key] + 1;
    const before = policies.resolve();
    expect(() => policies.configure(config)).toThrow();
    expect(policies.resolve()).toEqual(before);
  });

  it("rejects invalid owner defaults and unbounded reservations", () => {
    expect(RetrievalPolicySettingsSchema.safeParse({ defaultProfile: "evidence" }).success).toBe(false);
    expect(RetrievalPolicySettingsSchema.safeParse({ allowedProfiles: [] }).success).toBe(false);
    for (const reservation of ["reservedTokens", "reservedChars", "reservedBytes"])
      expect(
        RetrievalPolicySettingsSchema.safeParse({ [reservation]: Number.MAX_SAFE_INTEGER }).success,
      ).toBe(false);
  });

  it("supports a fully disabled zero-budget owner profile without restoring incidental defaults", () => {
    const config = structuredClone(DEFAULT_RUNTIME);
    for (const key of RETRIEVAL_BUDGET_KEYS) config.retrievalPolicy.profiles.standard[key] = 0;
    config.retrievalPolicy.reservedTokens = 0;
    config.retrievalPolicy.reservedChars = 0;
    config.retrievalPolicy.reservedBytes = 0;
    policies.configure(config);
    const resolved = policies.resolve();
    for (const key of RETRIEVAL_BUDGET_KEYS) expect(resolved.limits[key]).toBe(0);
    expect(resolved).toMatchObject({ reservedTokens: 0, reservedChars: 0, reservedBytes: 0 });
  });

  it("applies the same owner-granted policy through host settings and direct runtime configuration", () => {
    const ownerPolicy = structuredClone(DEFAULT_RUNTIME.retrievalPolicy);
    ownerPolicy.defaultProfile = "evidence";
    ownerPolicy.allowedProfiles.push("evidence");
    ownerPolicy.profiles.evidence.detail = "full";
    const host = runtimeConfig(
      memorySettings.schema.parse({ retrievalPolicy: ownerPolicy, contextBudgetChars: 9000 }),
    );
    policies.configure(host);
    expect(policies.resolve({ detail: "full" })).toMatchObject({
      profileName: "evidence",
      detail: "full",
      limits: { maxChars: 9000 },
    });
    const { retrievalPolicy: _legacyMissing, ...legacy } = DEFAULT_RUNTIME;
    policies.configure(RuntimeConfigSchema.parse(legacy));
    expect(() => policies.resolve({ profile: "evidence" })).toThrow(MutationError);
  });
});

describe("durable policy epochs", () => {
  it("preserves a non-default owner policy and revision across database close and reopen", () => {
    const path = join(tempDir(), "retrieval-policy.db");
    let disk = openDatabase(path).db;
    try {
      migrate(disk);
      const first = new RetrievalPolicies(disk);
      const config = structuredClone(DEFAULT_RUNTIME);
      config.contextBudgetChars = 9500;
      config.detailLevel = "summaries";
      config.retrievalPolicy.allowedProfiles.push("evidence");
      config.retrievalPolicy.defaultProfile = "evidence";
      first.configure(config);
      const expected = first.resolve({ detail: "full" });
      disk.close();
      disk = openDatabase(path).db;
      const resumed = new RetrievalPolicies(disk);
      expect(resumed.resolve({ detail: "full" })).toEqual(expected);
      resumed.configure(config);
      expect(resumed.revision).toBe(expected.policyRevision);
    } finally {
      disk.close();
    }
  });

  it("keeps semantic set ordering and unrelated review settings out of epoch changes", () => {
    const before = policies.revision;
    const reordered = structuredClone(DEFAULT_RUNTIME);
    reordered.retrievalPolicy.allowedProfiles.reverse();
    for (const profile of Object.values(reordered.retrievalPolicy.profiles))
      profile.allowedRecordKinds.reverse();
    reordered.reviewMaxMemories = 8;
    reordered.duplicateMerge = "off";
    policies.configure(reordered);
    expect(policies.revision).toBe(before);
    expect(policies.resolve().policyRevision).toBe(before);
  });

  const relevantChanges: [string, Partial<RuntimeConfig>][] = [
    ["character ceiling", { contextBudgetChars: 500 }],
    ["pins", { maxPinned: 0 }],
    ["task matches", { taskMatches: 0 }],
    ["task strictness", { taskStrictness: "low" }],
    ["project selection", { projectMemories: 0 }],
    ["global selection", { globalMemories: 0 }],
    ["recent sessions", { recentSessions: 0 }],
    ["detail", { detailLevel: "summaries" }],
    ["static instructions", { extraInstructions: "Bounded owner instruction" }],
    ["usage ranking", { usageRanking: false }],
    ["freshness ranking", { staleDays: 30 }],
  ];
  it.each(relevantChanges)("advances once for relevant legacy %s changes", (_name, patch) => {
    const before = policies.revision;
    const config = { ...DEFAULT_RUNTIME, ...patch };
    policies.configure(config);
    expect(policies.resolve().policyRevision).toBe(before + 1);
    policies.configure(config);
    expect(policies.revision).toBe(before + 1);
  });

  it("advances for owner grants, reservations and restored prior policies without reusing an old epoch", () => {
    let revision = policies.revision;
    const config = structuredClone(DEFAULT_RUNTIME);
    config.retrievalPolicy.allowedProfiles.push("evidence");
    policies.configure(config);
    expect(policies.revision).toBe(++revision);
    config.retrievalPolicy.reservedTokens = 2000;
    policies.configure(config);
    expect(policies.revision).toBe(++revision);
    config.retrievalPolicy.profiles.standard.allowedRecordKinds = ["fact"];
    policies.configure(config);
    expect(policies.revision).toBe(++revision);
    policies.configure(DEFAULT_RUNTIME);
    expect(policies.revision).toBe(++revision);
  });

  it("uses existing metadata without changing the database schema version", () => {
    const before = db.query("PRAGMA user_version").get();
    policies.configure({ ...DEFAULT_RUNTIME, extraInstructions: "New instruction" });
    expect(db.query("PRAGMA user_version").get()).toEqual(before);
  });

  it("recovers malformed persisted configuration to bounded defaults without resurrecting grants", () => {
    const config = structuredClone(DEFAULT_RUNTIME);
    config.retrievalPolicy.allowedProfiles.push("evidence");
    policies.configure(config);
    const before = policies.revision;
    db.query("UPDATE meta SET value='not-json' WHERE key='retrieval_policy_config'").run();
    const recovered = new RetrievalPolicies(db);
    expect(recovered.revision).toBe(before + 1);
    expect(recovered.resolve().limits.maxChars).toBe(DEFAULT_RUNTIME.contextBudgetChars);
    expect(() => recovered.resolve({ profile: "evidence" })).toThrow(MutationError);
  });
});
