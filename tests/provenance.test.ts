import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Access } from "../service/access";
import { Provenance } from "../service/provenance";
import { migrate } from "../service/schema";
import { openDatabase } from "../service/sqlite";
import { sha256 } from "../service/text";
import type { EvidenceInput } from "../shared/lifecycle";

const OBSERVED_AT = "2026-10-23T16:00:00.000Z";
const SOURCE_AT = "2026-10-20T10:00:00.000Z";
const owner = Access.owner();
const alpha = Access.agent("alpha");
const beta = Access.agent("beta");
let db: Database;
let provenance: Provenance;

beforeEach(() => {
  db = openDatabase(":memory:").db;
  migrate(db);
  provenance = new Provenance(db, () => OBSERVED_AT);
  db.query(`INSERT INTO projects (key, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    "alpha",
    "Alpha",
    SOURCE_AT,
    SOURCE_AT,
  );
  db.query(`INSERT INTO projects (key, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    "beta",
    "Beta",
    SOURCE_AT,
    SOURCE_AT,
  );
});
afterEach(() => db.close());

function seed(
  scope: "global" | "project" = "project",
  projectKey: string | null = "alpha",
  content = "Original observation",
) {
  const title = "Source title";
  const inserted = db
    .query(
      `INSERT INTO memories (scope, project_key, type, title, content, content_hash, created_at, updated_at)
       VALUES (?, ?, 'note', ?, ?, ?, ?, ?)`,
    )
    .run(
      scope,
      scope === "global" ? null : projectKey,
      title,
      content,
      sha256(`${title}\n${content}`),
      SOURCE_AT,
      SOURCE_AT,
    );
  return Number(inserted.lastInsertRowid);
}

function memoryInput(id: number, revision = 1): EvidenceInput {
  return { sourceKind: "memory", sourceRef: `memory:${id}@${revision}`, includeExcerpt: true };
}

function artifactInput(sourceRef = "artifact:receipt", includeExcerpt = true): EvidenceInput {
  return { sourceKind: "artifact", sourceRef, includeExcerpt };
}

function artifact(overrides: Partial<Parameters<Provenance["registerArtifact"]>[1]> = {}) {
  return {
    sourceRef: "artifact:receipt",
    content: "Verified tool result",
    scope: "project" as const,
    projectKey: "alpha",
    allowExcerpt: true,
    ...overrides,
  };
}

describe("canonical memory evidence", () => {
  it("resolves the exact historical revision, keeping source, observation, and storage times distinct", () => {
    const id = seed();
    db.query(
      `UPDATE memories SET content = 'Later correction', content_hash = ?, record_revision = 2,
       updated_at = ? WHERE id = ?`,
    ).run(sha256("Source title\nLater correction"), "2026-10-22T10:00:00.000Z", id);
    const evidence = provenance.resolve(alpha, "agent-alpha", memoryInput(id));
    expect(evidence).toMatchObject({
      status: "resolved",
      sourceHash: sha256("Source title\nOriginal observation"),
      excerpt: "Source title\nOriginal observation",
      sourceEventAt: SOURCE_AT,
      observedAt: OBSERVED_AT,
      storedAt: OBSERVED_AT,
      reason: null,
    });
    expect(provenance.getVisible(alpha, [evidence.evidenceId])).toEqual([evidence]);
    const current = provenance.resolve(alpha, "agent-alpha", memoryInput(id, 2));
    expect(current.sourceHash).toBe(sha256("Source title\nLater correction"));
    expect(current.sourceEventAt).toBe("2026-10-22T10:00:00.000Z");
  });

  it("rechecks the current namespace and prevents former foreign history leaking after a scope move", () => {
    const id = seed();
    const evidence = provenance.resolve(alpha, "agent-alpha", memoryInput(id));
    db.query(`UPDATE memories SET project_key = 'beta', record_revision = 2 WHERE id = ?`).run(id);
    expect(provenance.getVisible(alpha, [evidence.evidenceId])).toEqual([]);
    expect(provenance.resolve(alpha, "agent-alpha", memoryInput(id)).status).toBe("unresolved");
    expect(provenance.resolve(beta, "agent-beta", memoryInput(id)).status).toBe("unresolved");
    expect(provenance.resolve(beta, "agent-beta", memoryInput(id, 2)).status).toBe("resolved");
    expect(provenance.resolve(owner, "owner", memoryInput(id)).excerpt).toBe(
      "Source title\nOriginal observation",
    );
  });

  it("does not turn historical project evidence global when the current record becomes global", () => {
    const id = seed();
    db.query(
      `UPDATE memories SET scope = 'global', project_key = NULL, record_revision = 2 WHERE id = ?`,
    ).run(id);
    const unscoped = Access.agent(null);
    expect(provenance.resolve(unscoped, "agent", memoryInput(id)).status).toBe("unresolved");
    expect(provenance.resolve(unscoped, "agent", memoryInput(id, 2)).status).toBe("resolved");
  });

  it("persists equally unresolved foreign and missing evidence without exposing source content or hashes", () => {
    const id = seed("project", "beta", "Foreign private observation");
    for (const input of [memoryInput(id), memoryInput(99999)]) {
      const evidence = provenance.resolve(alpha, "agent-alpha", input);
      expect(evidence).toMatchObject({
        status: "unresolved",
        reason: "source_unavailable",
        sourceHash: null,
        observedAt: null,
        sourceEventAt: null,
        excerpt: null,
      });
      const stored = db.query(`SELECT * FROM memory_evidence WHERE evidence_id = ?`).get(evidence.evidenceId);
      expect(stored).toMatchObject({
        source_hash: null,
        observed_at: null,
        excerpt: null,
        sensitivity: "private",
      });
      expect(JSON.stringify(stored)).not.toContain("Foreign private observation");
      expect(provenance.getVisible(alpha, [evidence.evidenceId])).toEqual([]);
      expect(provenance.getVisible(owner, [evidence.evidenceId])).toEqual([evidence]);
    }
  });
});

describe("historical evidence integrity and excerpts", () => {
  it("does not substitute current text for a missing canonical revision", () => {
    const id = seed();
    const missing = provenance.resolve(alpha, "agent-alpha", memoryInput(id, 200));
    expect(missing.status).toBe("unresolved");
    expect(missing.excerpt).toBeNull();
    db.query(`DELETE FROM memory_revisions WHERE memory_id = ?`).run(id);
    expect(provenance.resolve(alpha, "agent-alpha", memoryInput(id)).status).toBe("unresolved");
  });

  it("retains legacy unknown metadata without manufacturing an event timestamp", () => {
    const id = seed();
    db.query(
      `UPDATE memory_revisions SET snapshot = ?, legacy_metadata_unknown = 1 WHERE memory_id = ? AND revision = 1`,
    ).run(JSON.stringify({ title: "Legacy title", content: "Legacy observation" }), id);
    const evidence = provenance.resolve(owner, "owner", memoryInput(id));
    expect(evidence.status).toBe("resolved");
    expect(evidence.sourceHash).toBe(sha256("Legacy title\nLegacy observation"));
    expect(evidence.sourceEventAt).toBeNull();
    expect(evidence.observedAt).toBe(OBSERVED_AT);
    db.query(
      `UPDATE memories SET scope='global',project_key=NULL,title='Sanitized',content='Safe current text',record_revision=2 WHERE id=?`,
    ).run(id);
    const denied = provenance.resolve(Access.agent(null), "unscoped", memoryInput(id));
    expect(denied).toMatchObject({ status: "unresolved", excerpt: null, sourceHash: null, observedAt: null });
    expect(provenance.getVisible(Access.agent(null), [evidence.evidenceId])).toEqual([]);
    db.query(`UPDATE memory_revisions SET legacy_metadata_unknown = 0 WHERE memory_id = ?`).run(id);
    expect(provenance.resolve(owner, "owner", memoryInput(id)).status).toBe("unresolved");
  });

  it("leaves mismatched hashes unresolved rather than attesting to a different source", () => {
    const id = seed();
    const evidence = provenance.resolve(alpha, "agent-alpha", {
      ...memoryInput(id),
      sourceHash: "f".repeat(64),
    });
    expect(evidence).toMatchObject({
      status: "unresolved",
      reason: "source_hash_mismatch",
      sourceHash: null,
      observedAt: null,
      excerpt: null,
    });
    expect(provenance.getVisible(alpha, [evidence.evidenceId])).toEqual([evidence]);
  });

  it("rejects corrupt revision snapshots without falling back to current memory", () => {
    const id = seed();
    db.query(`UPDATE memory_revisions SET snapshot = '{' WHERE memory_id = ?`).run(id);
    expect(provenance.resolve(alpha, "agent-alpha", memoryInput(id)).status).toBe("unresolved");
  });

  it("redacts the full source before applying the excerpt ceiling", () => {
    const content = `token=supersecretvalue123 <private>${"hidden ".repeat(150)}</private> ${"public ".repeat(150)}`;
    const id = seed("project", "alpha", content);
    const evidence = provenance.resolve(alpha, "agent-alpha", memoryInput(id));
    expect(evidence.excerpt?.length).toBeLessThanOrEqual(500);
    expect(evidence.excerpt).toContain("token=[REDACTED]");
    expect(evidence.excerpt).toContain("[private]");
    expect(evidence.excerpt).not.toContain("hidden");
    expect(evidence.excerpt).not.toContain("supersecretvalue123");
    expect(evidence.sourceHash).toBe(sha256(`Source title\n${content}`));
    expect(
      provenance.resolve(alpha, "agent-alpha", { ...memoryInput(id), includeExcerpt: false }).excerpt,
    ).toBeNull();
  });

  it("stops materializing previously resolved evidence after source deletion", () => {
    const id = seed();
    const evidence = provenance.resolve(alpha, "agent-alpha", memoryInput(id));
    db.query(`UPDATE memories SET deleted_at = ?, record_revision = 2 WHERE id = ?`).run(OBSERVED_AT, id);
    expect(provenance.getVisible(alpha, [evidence.evidenceId])).toEqual([]);
    expect(provenance.getVisible(owner, [evidence.evidenceId])).toEqual([]);
    expect(provenance.resolve(owner, "owner", memoryInput(id)).status).toBe("unresolved");
  });
});

describe("explicit immutable artifact evidence", () => {
  it("permits owner registration only and obeys namespaces on every read", () => {
    expect(() => provenance.registerArtifact(alpha, artifact())).toThrow("Only the owner");
    const registration = provenance.registerArtifact(owner, artifact({ sourceEventAt: SOURCE_AT }));
    expect(registration.sourceHash).toBe(sha256("Verified tool result"));
    const evidence = provenance.resolve(alpha, "agent-alpha", artifactInput());
    expect(evidence).toMatchObject({
      status: "resolved",
      sourceEventAt: SOURCE_AT,
      excerpt: "Verified tool result",
    });
    expect(provenance.resolve(beta, "agent-beta", artifactInput())).toMatchObject({
      status: "unresolved",
      sourceHash: null,
      observedAt: null,
      excerpt: null,
    });
    expect(provenance.getVisible(beta, [evidence.evidenceId])).toEqual([]);
    expect(provenance.getVisible(alpha, [evidence.evidenceId])).toEqual([evidence]);
  });

  it("preserves missing source time as unknown instead of accepting an invented caller timestamp", () => {
    provenance.registerArtifact(owner, artifact({ scope: "global", projectKey: null }));
    const evidence = provenance.resolve(Access.agent(null), "agent", {
      ...artifactInput(),
      sourceEventAt: SOURCE_AT,
    });
    expect(evidence.sourceEventAt).toBeNull();
    expect(evidence.observedAt).toBe(OBSERVED_AT);
  });

  it("requires both source excerpt permission and an explicit evidence request", () => {
    provenance.registerArtifact(owner, artifact({ allowExcerpt: false }));
    const evidence = provenance.resolve(alpha, "agent-alpha", artifactInput());
    expect(evidence.status).toBe("resolved");
    expect(evidence.excerpt).toBeNull();
    expect(provenance.getVisible(alpha, [evidence.evidenceId])[0]?.excerpt).toBeNull();
    provenance.registerArtifact(owner, artifact({ sourceRef: "artifact:public-excerpt" }));
    expect(
      provenance.resolve(alpha, "agent-alpha", artifactInput("artifact:public-excerpt", false)).excerpt,
    ).toBeNull();
  });

  it("redacts artifact excerpts while hashing the immutable registered bytes", () => {
    const content = "password=supersecret123 <private>private account</private> public result";
    const registration = provenance.registerArtifact(owner, artifact({ content }));
    const evidence = provenance.resolve(alpha, "agent-alpha", artifactInput());
    expect(evidence.sourceHash).toBe(sha256(content));
    expect(evidence.sourceHash).toBe(registration.sourceHash);
    expect(evidence.excerpt).toBe("password=[REDACTED] [private] public result");
  });

  it("allows identical registration replay but rejects content, namespace, permission, or timestamp reuse", () => {
    const original = artifact({ sourceEventAt: SOURCE_AT });
    const registration = provenance.registerArtifact(owner, original);
    expect(provenance.registerArtifact(owner, original)).toEqual(registration);
    for (const changed of [
      { ...original, content: "Different content" },
      { ...original, projectKey: "beta" },
      { ...original, allowExcerpt: false },
      { ...original, sourceEventAt: OBSERVED_AT },
    ]) {
      expect(() => provenance.registerArtifact(owner, changed)).toThrow("already registered");
    }
    expect(provenance.resolve(alpha, "agent-alpha", artifactInput()).excerpt).toBe("Verified tool result");
  });

  it("bounds UTF-8 artifact bytes, not merely JavaScript string length", () => {
    const content = "\u{1f600}".repeat(4096);
    provenance.registerArtifact(owner, artifact({ content }));
    expect(() =>
      provenance.registerArtifact(
        owner,
        artifact({ sourceRef: "artifact:too-large", content: `${content}x` }),
      ),
    ).toThrow("16 KiB");
    const evidence = provenance.resolve(alpha, "agent-alpha", artifactInput());
    expect(evidence.sourceHash).toBe(sha256(content));
    expect(evidence.excerpt?.length).toBeLessThanOrEqual(500);
  });

  it("rejects malformed namespaces and references rather than interpreting them as file or URL adapters", () => {
    expect(() =>
      provenance.registerArtifact(owner, artifact({ scope: "global", projectKey: "alpha" })),
    ).toThrow("namespace");
    expect(() => provenance.registerArtifact(owner, artifact({ projectKey: null }))).toThrow("namespace");
    for (const sourceRef of [
      "file:///etc/passwd",
      "https://example.invalid/result",
      "artifact:../../secret",
      "memory:01@1",
    ]) {
      const evidence = provenance.resolve(owner, "owner", { ...artifactInput(), sourceRef });
      expect(evidence.status).toBe("unresolved");
      expect(evidence.excerpt).toBeNull();
    }
    expect(() =>
      provenance.registerArtifact(owner, artifact({ sourceRef: "artifact:../../secret" })),
    ).toThrow("reference");
  });
});

describe("source forgetting", () => {
  it("blocks every revision of a tombstoned memory, including previously returned evidence", () => {
    const id = seed();
    const evidence = provenance.resolve(alpha, "agent-alpha", memoryInput(id));
    db.query(
      `INSERT INTO memory_tombstones (kind, identifier, forgotten_at, principal_id) VALUES ('memory', ?, ?, ?)`,
    ).run(String(id), OBSERVED_AT, "owner");
    expect(provenance.sourceTombstoned(`memory:${id}@1`)).toBe(true);
    expect(provenance.sourceTombstoned(`memory:${id}@200`)).toBe(true);
    expect(provenance.getVisible(owner, [evidence.evidenceId])).toEqual([]);
    expect(provenance.resolve(owner, "owner", memoryInput(id))).toMatchObject({
      status: "unresolved",
      reason: "source_forgotten",
      excerpt: null,
      observedAt: null,
    });
  });

  it("blocks artifact replay and resolution even when a stale artifact row remains", () => {
    const original = artifact();
    provenance.registerArtifact(owner, original);
    const evidence = provenance.resolve(alpha, "agent-alpha", artifactInput());
    db.query(
      `INSERT INTO memory_tombstones (kind, identifier, forgotten_at, principal_id) VALUES ('source', ?, ?, ?)`,
    ).run(original.sourceRef, OBSERVED_AT, "owner");
    expect(() => provenance.registerArtifact(owner, original)).toThrow("forgotten");
    expect(provenance.resolve(alpha, "agent-alpha", artifactInput())).toMatchObject({
      status: "unresolved",
      reason: "source_forgotten",
      excerpt: null,
      observedAt: null,
    });
    expect(provenance.getVisible(alpha, [evidence.evidenceId])).toEqual([]);
    expect(provenance.getVisible(owner, [evidence.evidenceId])).toEqual([]);
  });

  it("honors a revision-specific source tombstone without erasing unrelated sources", () => {
    const id = seed();
    db.query(`UPDATE memories SET content = 'Corrected', record_revision = 2 WHERE id = ?`).run(id);
    const first = `memory:${id}@1`;
    db.query(
      `INSERT INTO memory_tombstones (kind, identifier, forgotten_at, principal_id) VALUES ('source', ?, ?, ?)`,
    ).run(first, OBSERVED_AT, "owner");
    expect(provenance.sourceTombstoned(first)).toBe(true);
    expect(provenance.sourceTombstoned(`memory:${id}@2`)).toBe(false);
    expect(provenance.resolve(alpha, "agent-alpha", memoryInput(id)).status).toBe("unresolved");
    expect(provenance.resolve(alpha, "agent-alpha", memoryInput(id, 2)).status).toBe("resolved");
  });
});
