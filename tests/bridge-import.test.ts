import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeFailure } from "../service/bridge-errors";
import type { BridgeImports } from "../service/bridge-import";
import { mutationRequestId, ownerMutation } from "../service/mutations";
import { MemoryStore } from "../service/store";
import type { BridgeImportPreview } from "../shared/bridge-import";
import { silentLogger } from "../shared/log";
import { owner, removeTempDirs, tempDir } from "./helpers";

const ns = { kind: "global" } as const;
const principal = { ...ownerMutation(owner), defaultNamespace: ns };
const T0 = "2026-10-01T00:00:00.000Z";
const LEASE_MS = 15 * 60 * 1000;
const SECRET_FACT = "sk-abcdefghijklmnopqrstuvwx";

let store: MemoryStore;
let dir: string;
let at: string;
let imports: BridgeImports;

beforeEach(() => {
  at = T0;
  dir = tempDir("pm-bridge-import-");
  store = new MemoryStore({ path: join(dir, "memory.db"), now: () => new Date(at) });
  imports = store.startBridge({ secret: "test-secret", dataDir: dir, log: silentLogger }).imports;
});
afterEach(() => store.close());
afterAll(() => removeTempDirs());

function note(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

// Read-only connection so assertions never write through the store.
function rowsOf<T extends object>(sql: string): T[] {
  const db = new Database(join(dir, "memory.db"), { readonly: true });
  try {
    return db.query<T, []>(sql).all();
  } finally {
    db.close();
  }
}

function countOf(table: "memories" | "source_artifacts"): number {
  return rowsOf<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]?.n ?? 0;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof BridgeFailure) return error.bridgeCode;
    throw error;
  }
  return "none";
}

function previewOf(paths: string[]): BridgeImportPreview {
  return imports.preview({ paths, namespace: ns });
}

function importAll(preview: BridgeImportPreview, importId = randomUUID()) {
  return imports.import({
    importId,
    previewToken: preview.previewToken,
    approvedSourceIds: preview.candidates.map((c) => c.sourceId),
  });
}

// Previews and imports one file; returns the first memory ref and the replayable input.
function importedRef(name: string, body: string) {
  const preview = previewOf([note(name, body)]);
  const input = {
    importId: randomUUID(),
    previewToken: preview.previewToken,
    approvedSourceIds: preview.candidates.map((c) => c.sourceId),
  };
  const ref = imports.import(input).memoryRefs[0];
  if (!ref) throw new Error("import produced no memory");
  return { input, ref };
}

it("previews paragraph and bullet facts and ignores headings", () => {
  const path = note("notes.md", "# Title\n\nFirst fact line.\n\n- Second fact\n- Third fact\n");
  const preview = previewOf([path]);
  expect(preview.candidates.map((c) => c.content)).toEqual(["First fact line.", "Second fact", "Third fact"]);
  expect(preview.counts).toEqual({ candidates: 3, duplicates: 0, unsupported: 0 });
  expect(preview.files[0]?.path).toBe(path);
  expect(preview.namespace).toEqual(ns);
  expect(typeof preview.previewToken).toBe("string");
});

it("reports code fences as unsupported and keeps surrounding facts", () => {
  const path = note("fenced.md", "Before fact.\n\n```ts\nconst x = 1;\n```\n\nAfter fact.\n");
  const preview = previewOf([path]);
  expect(preview.candidates.map((c) => c.content)).toEqual(["Before fact.", "After fact."]);
  expect(preview.unsupported.map((u) => u.reason).join("\n")).toContain("code fence");
});

it("reports oversized facts as unsupported", () => {
  const path = note("huge.md", `${"x".repeat(4001)}\n`);
  const preview = previewOf([path]);
  expect(preview.candidates).toEqual([]);
  expect(preview.unsupported.map((u) => u.reason).join("\n")).toContain("oversized fact");
});

it("reports files over 64 KiB as unsupported", () => {
  const path = note("big.md", "a".repeat(64 * 1024 + 1));
  const preview = previewOf([path]);
  expect(preview.candidates).toEqual([]);
  expect(preview.unsupported.map((u) => u.reason)).toContain("file exceeds 64 KiB");
});

it("rejects symlink files without reading their target", () => {
  const target = note("real.md", "A fact.\n");
  const link = join(dir, "link.md");
  symlinkSync(target, link);
  const preview = previewOf([link]);
  expect(preview.candidates).toEqual([]);
  expect(preview.unsupported.map((u) => u.reason)).toContain("symlink files are not imported");
});

it("rejects a tampered preview token as unauthorized", () => {
  const path = note("tamper.md", "Tamper fact.\n");
  const token = previewOf([path]).previewToken;
  const flipped = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
  const code = codeOf(() =>
    imports.import({ importId: randomUUID(), previewToken: flipped, approvedSourceIds: [] }),
  );
  expect(code).toBe("unauthorized");
});

it("imports approved candidates and replays the same body without new writes", () => {
  const path = note("import.md", "Alpha fact.\n\n- Beta fact\n");
  const preview = previewOf([path]);
  const importId = randomUUID();
  const ids = preview.candidates.map((c) => c.sourceId);
  const input = { importId, previewToken: preview.previewToken, approvedSourceIds: ids };
  const result = imports.import(input);
  expect(result.proposed).toBe(2);
  expect(result.duplicates).toBe(0);
  expect(result.sourceIds).toEqual(ids);
  expect(result.memoryRefs).toHaveLength(2);
  const before = countOf("memories");
  expect(imports.import(input)).toEqual(result);
  expect(countOf("memories")).toBe(before);
});

it("rejects a changed body under a reused import id as request_conflict", () => {
  const path = note("conflict.md", "One fact.\n\n- Two fact\n");
  const preview = previewOf([path]);
  const ids = preview.candidates.map((c) => c.sourceId);
  const importId = randomUUID();
  imports.import({ importId, previewToken: preview.previewToken, approvedSourceIds: ids });
  const code = codeOf(() =>
    imports.import({ importId, previewToken: preview.previewToken, approvedSourceIds: ids.slice(0, 1) }),
  );
  expect(code).toBe("request_conflict");
});

it("requires a fresh preview when a file changed after preview", () => {
  const path = note("drift.md", "Original fact.\n");
  const preview = previewOf([path]);
  writeFileSync(path, "Changed fact.\n");
  expect(codeOf(() => importAll(preview))).toBe("revision_conflict");
});

it("requires a fresh preview when a matching memory appears after preview", () => {
  const path = note("plan.md", "Plan fact.\n");
  const preview = previewOf([path]);
  store.mutations.mutate(principal, {
    requestId: mutationRequestId(),
    operation: "propose",
    change: { title: "Plan fact.", content: "Plan fact.", type: "note", recordKind: "fact", scope: "global" },
  });
  expect(codeOf(() => importAll(preview))).toBe("revision_conflict");
});

it("skips exact existing duplicates without mutating them", () => {
  const path = note("dup.md", "Dup fact one.\n\nDup fact two.\n");
  importAll(previewOf([path]));
  const again = previewOf([path]);
  expect(again.counts.duplicates).toBe(2);
  expect(again.candidates.every((c) => c.duplicate !== null)).toBe(true);
  const before = countOf("memories");
  const result = importAll(again);
  expect(result.proposed).toBe(0);
  expect(result.duplicates).toBe(2);
  expect(countOf("memories")).toBe(before);
});

it("reports a repeated fact within one file as unsupported, not a second candidate", () => {
  const path = note("repeat.md", "Repeat fact.\n\n- Repeat fact.\n");
  const preview = previewOf([path]);
  expect(preview.candidates.map((c) => c.content)).toEqual(["Repeat fact."]);
  expect(preview.unsupported.map((u) => u.reason)).toEqual([
    "duplicate of an earlier fact in preview at line 3",
  ]);
  expect(preview.counts).toEqual({ candidates: 1, duplicates: 0, unsupported: 1 });
  importAll(preview);
  expect(countOf("memories")).toBe(1);
});

it("rejects an expired preview token as lease_expired", () => {
  const path = note("lease.md", "Lease fact.\n");
  const preview = previewOf([path]);
  at = new Date(Date.parse(T0) + LEASE_MS + 1000).toISOString();
  expect(codeOf(() => importAll(preview))).toBe("lease_expired");
});

it("does not recreate a forgotten import source and fails replay as context_invalidated", () => {
  const { input, ref } = importedRef("forget.md", "Forget fact.\n");
  store.mutations.mutate(ownerMutation(owner), {
    requestId: `forget:${randomUUID()}`,
    operation: "forget",
    id: ref.id,
    expectedRevision: ref.revision,
  });
  expect(codeOf(() => imports.import(input))).toBe("context_invalidated");
  const fresh = previewOf([join(dir, "forget.md")]);
  expect(fresh.candidates).toEqual([]);
  expect(fresh.unsupported.map((u) => u.reason)).toContain("forgotten source");
});

it("fails replay as context_invalidated after the imported memory is corrected", () => {
  const { input, ref } = importedRef("fix.md", "Fix fact.\n");
  store.mutations.mutate(principal, {
    requestId: mutationRequestId(),
    operation: "update",
    id: ref.id,
    expectedRevision: ref.revision,
    change: { content: "Fix fact corrected." },
  });
  expect(codeOf(() => imports.import(input))).toBe("context_invalidated");
});

it("fails replay as context_invalidated after the imported memory moves namespace", () => {
  const { input, ref } = importedRef("move.md", "Move fact.\n");
  store.mutations.mutate(principal, {
    requestId: mutationRequestId(),
    operation: "update",
    id: ref.id,
    expectedRevision: ref.revision,
    change: {
      scope: "project",
      project: { key: "moved-project", name: "Moved", rootPath: null, paseoProjectId: null },
    },
  });
  expect(codeOf(() => imports.import(input))).toBe("context_invalidated");
});

it("stores imported facts as unverified candidates and leaves source bytes unchanged", () => {
  const path = note("rows.md", "Row fact one.\n\n- Row fact two\n");
  const before = readFileSync(path, "utf8");
  importAll(previewOf([path]));
  const rows = rowsOf<{ state: string; verified_at: string | null }>(
    "SELECT state,verified_at FROM memories ORDER BY id",
  );
  expect(rows.map((row) => row.state)).toEqual(["candidate", "candidate"]);
  expect(rows.every((row) => row.verified_at === null)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(before);
});

it("refuses sensitive facts without persisting them or the token", () => {
  const path = note("secret.md", `Clean fact.\n\nUse ${SECRET_FACT} here.\n`);
  const preview = previewOf([path]);
  expect(preview.unsupported.map((u) => u.reason)).toContain("sensitive content at line 3; not persisted");
  expect(preview.candidates.map((c) => c.content)).toEqual(["Clean fact."]);
  const payload = Buffer.from(preview.previewToken.split(".")[0] ?? "", "base64url").toString("utf8");
  expect(payload).not.toContain(SECRET_FACT);
  importAll(preview);
  const stored = JSON.stringify([
    rowsOf<{ content: string }>("SELECT content FROM source_artifacts"),
    rowsOf<{ content: string }>("SELECT content FROM memories"),
  ]);
  expect(stored).not.toContain(SECRET_FACT);
});

it("rolls back the whole import when a duplicate appears mid-write", () => {
  const path = note("race.md", "Race one.\n\n- Race two\n");
  const preview = previewOf([path]);
  const real = store.mutations.mutate.bind(store.mutations);
  let calls = 0;
  const spy = spyOn(store.mutations, "mutate").mockImplementation((request, body) => {
    calls += 1;
    if (calls === 2) {
      real(request, {
        requestId: mutationRequestId(),
        operation: "propose",
        change: { title: "Race two", content: "Race two", type: "note", recordKind: "fact", scope: "global" },
      });
    }
    return real(request, body);
  });
  try {
    expect(codeOf(() => importAll(preview))).toBe("revision_conflict");
  } finally {
    spy.mockRestore();
  }
  expect(countOf("memories")).toBe(0);
  expect(countOf("source_artifacts")).toBe(0);
});
