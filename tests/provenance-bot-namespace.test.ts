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
const alphaBot = Access.scoped({ read: [{ kind: "bot", botId: "alpha-bot" }] });
const betaBot = Access.scoped({ read: [{ kind: "bot", botId: "beta-bot" }] });
const projectAlphaOnly = Access.scoped({ read: [{ kind: "project", projectKey: "alpha" }] });
const globalOnly = Access.scoped({ read: [{ kind: "global" }] });
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
});
afterEach(() => db.close());

function seedBot(botId: string, content = "Bot observation") {
  const title = "Bot title";
  const inserted = db
    .query(
      `INSERT INTO memories (scope, project_key, bot_id, type, title, content, content_hash, created_at, updated_at)
       VALUES ('bot', NULL, ?, 'note', ?, ?, ?, ?, ?)`,
    )
    .run(botId, title, content, sha256(`${title}\n${content}`), SOURCE_AT, SOURCE_AT);
  return Number(inserted.lastInsertRowid);
}

function seedProject(content = "Project observation") {
  const title = "Project title";
  const inserted = db
    .query(
      `INSERT INTO memories (scope, project_key, type, title, content, content_hash, created_at, updated_at)
       VALUES ('project', 'alpha', 'note', ?, ?, ?, ?, ?)`,
    )
    .run(title, content, sha256(`${title}\n${content}`), SOURCE_AT, SOURCE_AT);
  return Number(inserted.lastInsertRowid);
}

function memoryInput(id: number, revision = 1): EvidenceInput {
  return { sourceKind: "memory", sourceRef: `memory:${id}@${revision}`, includeExcerpt: true };
}

function artifactInput(sourceRef: string): EvidenceInput {
  return { sourceKind: "artifact", sourceRef, includeExcerpt: true };
}

interface BotArtifactInput {
  sourceRef: string;
  content: string;
  scope: "bot";
  projectKey: null;
  botId: string;
  allowExcerpt: boolean;
}

function botArtifact(
  overrides: { sourceRef?: string; botId?: string; content?: string } = {},
): BotArtifactInput {
  return {
    sourceRef: overrides.sourceRef ?? "artifact:bot-receipt",
    content: overrides.content ?? "Bot tool result",
    scope: "bot" as const,
    projectKey: null,
    botId: overrides.botId ?? "alpha-bot",
    allowExcerpt: true,
  };
}

function registrationError(input: BotArtifactInput): unknown {
  try {
    provenance.registerArtifact(owner, input);
  } catch (error) {
    return error;
  }
  throw new Error("expected artifact registration to fail");
}

describe("bot namespace read authority", () => {
  it("resolves own bot memory and artifact and denies foreign bot, project, global, and agent readers", () => {
    const id = seedBot("alpha-bot");
    provenance.registerArtifact(owner, botArtifact());
    const readers = [betaBot, projectAlphaOnly, globalOnly, Access.agent("alpha")];

    expect(provenance.resolve(alphaBot, "agent-bot", memoryInput(id))).toMatchObject({
      status: "resolved",
      sourceHash: sha256("Bot title\nBot observation"),
    });
    expect(provenance.resolve(alphaBot, "agent-bot", artifactInput("artifact:bot-receipt"))).toMatchObject({
      status: "resolved",
      sourceHash: sha256("Bot tool result"),
    });
    for (const reader of readers) {
      expect(provenance.resolve(reader, "agent", memoryInput(id)).status).toBe("unresolved");
      expect(provenance.resolve(reader, "agent", artifactInput("artifact:bot-receipt")).status).toBe(
        "unresolved",
      );
    }
  });

  it("keeps bot_id separate from project_key in both directions", () => {
    const botId = "alpha";
    const botMemory = seedBot(botId);
    const projectMemory = seedProject();
    const botNamedAlpha = Access.scoped({ read: [{ kind: "bot", botId: "alpha" }] });

    expect(provenance.resolve(botNamedAlpha, "agent", memoryInput(botMemory)).status).toBe("resolved");
    expect(provenance.resolve(projectAlphaOnly, "agent", memoryInput(botMemory)).status).toBe("unresolved");
    expect(provenance.resolve(Access.agent("alpha"), "agent", memoryInput(botMemory)).status).toBe(
      "unresolved",
    );
    expect(provenance.resolve(botNamedAlpha, "agent", memoryInput(projectMemory)).status).toBe("unresolved");
    expect(provenance.resolve(projectAlphaOnly, "agent", memoryInput(projectMemory)).status).toBe("resolved");
  });

  it("keeps historical bot evidence on its revision after a scope move without granting project readers history", () => {
    const id = seedBot("alpha-bot");
    db.query(
      `UPDATE memories SET scope = 'project', project_key = 'alpha', bot_id = NULL, record_revision = 2
       WHERE id = ?`,
    ).run(id);

    const both = Access.scoped({
      read: [
        { kind: "bot", botId: "alpha-bot" },
        { kind: "project", projectKey: "alpha" },
      ],
    });
    expect(provenance.resolve(both, "agent-bot", memoryInput(id, 1)).status).toBe("resolved");
    expect(provenance.resolve(alphaBot, "agent-bot", memoryInput(id, 1)).status).toBe("unresolved");
    expect(provenance.resolve(alphaBot, "agent-bot", memoryInput(id, 2)).status).toBe("unresolved");
    expect(provenance.resolve(projectAlphaOnly, "agent", memoryInput(id, 1)).status).toBe("unresolved");
    expect(provenance.resolve(projectAlphaOnly, "agent", memoryInput(id, 2)).status).toBe("resolved");
  });

  it("keeps a known historical namespace readable under legacy_metadata_unknown=1", () => {
    const id = seedBot("alpha-bot");
    const snapshot = {
      title: "Bot title",
      content: "Bot observation",
      scope: "bot",
      project_key: null,
      bot_id: "alpha-bot",
    };
    db.query(
      `UPDATE memory_revisions SET snapshot = ?, legacy_metadata_unknown = 1 WHERE memory_id = ? AND revision = 1`,
    ).run(JSON.stringify(snapshot), id);

    expect(provenance.resolve(alphaBot, "agent-bot", memoryInput(id))).toMatchObject({
      status: "resolved",
      sourceHash: sha256("Bot title\nBot observation"),
    });
    expect(provenance.resolve(betaBot, "agent-bot", memoryInput(id)).status).toBe("unresolved");
  });
});

describe("bot namespace lifecycle", () => {
  it("treats unknown historical namespace as owner-only under legacy_metadata_unknown=1", () => {
    const id = seedBot("alpha-bot");
    db.query(
      `UPDATE memory_revisions SET snapshot = ?, legacy_metadata_unknown = 1 WHERE memory_id = ? AND revision = 1`,
    ).run(JSON.stringify({ title: "Bot title", content: "Bot observation" }), id);

    expect(provenance.resolve(owner, "owner", memoryInput(id)).status).toBe("resolved");
    expect(provenance.resolve(alphaBot, "agent-bot", memoryInput(id)).status).toBe("unresolved");
  });

  it("stores inaccessible bot evidence with the sentinel namespace and leaks no content or hash", () => {
    const id = seedBot("beta-bot", "Private bot observation");
    const evidence = provenance.resolve(alphaBot, "agent-bot", memoryInput(id));

    expect(evidence).toMatchObject({
      status: "unresolved",
      reason: "source_unavailable",
      sourceHash: null,
    });
    expect(JSON.stringify(evidence)).not.toContain("Private bot observation");
    expect(
      db
        .query(`SELECT scope, project_key, namespace_bot_id FROM memory_evidence WHERE evidence_id = ?`)
        .get(evidence.evidenceId),
    ).toEqual({ scope: "project", project_key: null, namespace_bot_id: null });
  });

  it("rejects re-registering an artifact under another bot namespace while keeping identical retries idempotent", () => {
    const first = provenance.registerArtifact(owner, botArtifact());
    expect(provenance.registerArtifact(owner, botArtifact()).sourceHash).toBe(first.sourceHash);
    expect(registrationError(botArtifact({ botId: "beta-bot" }))).toMatchObject({
      code: "request_conflict",
      message: expect.stringContaining("already registered"),
    });
  });

  it("blocks forgotten bot memories and forgotten artifact sources", () => {
    const id = seedBot("alpha-bot");
    provenance.registerArtifact(owner, botArtifact());
    db.query(
      `INSERT INTO memory_tombstones (kind, identifier, forgotten_at, principal_id) VALUES ('memory', ?, ?, 'owner')`,
    ).run(String(id), OBSERVED_AT);
    db.query(
      `INSERT INTO memory_tombstones (kind, identifier, forgotten_at, principal_id) VALUES ('source', ?, ?, 'owner')`,
    ).run("artifact:bot-receipt", OBSERVED_AT);

    expect(provenance.resolve(alphaBot, "agent-bot", memoryInput(id))).toMatchObject({
      status: "unresolved",
      reason: "source_forgotten",
    });
    expect(provenance.resolve(alphaBot, "agent-bot", artifactInput("artifact:bot-receipt"))).toMatchObject({
      status: "unresolved",
      reason: "source_forgotten",
    });
    expect(registrationError(botArtifact())).toMatchObject({ code: "context_invalidated" });
  });

  it("does not derive namespace from a producer bot_id on existing evidence", () => {
    const id = seedBot("alpha-bot");
    const evidence = provenance.resolve(alphaBot, "agent-bot", memoryInput(id));
    expect(evidence.status).toBe("resolved");
    db.query(`UPDATE memory_evidence SET bot_id = 'producer-bot' WHERE evidence_id = ?`).run(
      evidence.evidenceId,
    );

    expect(provenance.getVisible(alphaBot, [evidence.evidenceId])).toEqual([evidence]);
    expect(provenance.getVisible(betaBot, [evidence.evidenceId])).toEqual([]);
    expect(provenance.getVisible(Access.agent("producer-bot"), [evidence.evidenceId])).toEqual([]);
  });
});
