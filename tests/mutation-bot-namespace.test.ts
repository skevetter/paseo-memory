import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Access, type NamespaceGrants } from "../service/access";
import {
  type MemoryMutations,
  MutationError,
  type MutationPrincipal,
  mutationRequestId,
  ownerMutation,
} from "../service/mutations";
import { MemoryStore } from "../service/store";
import type { MemoryNamespace } from "../shared/namespaces";
import { dataRepo, otherRepo, owner, removeTempDirs, tempDir } from "./helpers";

type Request = Parameters<MemoryMutations["mutate"]>[1];
type Defaults = Pick<MutationPrincipal, "defaultNamespace" | "allowedMutations">;

const alphaBot: MemoryNamespace = { kind: "bot", botId: "alpha" };
const betaBot: MemoryNamespace = { kind: "bot", botId: "beta" };
const dataProject: MemoryNamespace = { kind: "project", projectKey: dataRepo.key };

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore({ path: join(tempDir("pm-bot-ns-"), "memory.db") });
});
afterEach(() => {
  store.close();
  removeTempDirs();
});

function caller(id: string, grants: NamespaceGrants, defaults: Defaults = {}): MutationPrincipal {
  return { id, actorId: id, access: Access.scoped(grants), ...defaults };
}

function create(change: Request["change"] = {}, requestId = mutationRequestId()): Request {
  return {
    requestId,
    operation: "create",
    change: { title: "Bot note", content: "Bot note bounded claim", ...change },
  };
}

function write(principal: MutationPrincipal, input: Request) {
  return store.mutations.mutate(principal, input);
}

function ownerWrite(input: Request) {
  return store.mutations.mutate(ownerMutation(owner), input);
}

function failure(run: () => unknown): MutationError {
  try {
    run();
  } catch (error) {
    if (error instanceof MutationError) return error;
    throw error;
  }
  throw new Error("expected a MutationError");
}

function visibleIds(access: Access, ids: number[]): number[] {
  return store.getVisible(access, ids).map((row) => row.id);
}

describe("bot namespace create and write authorization", () => {
  it("defaults a managed caller's create into its trusted bot namespace", () => {
    const alpha = caller(
      "caller-alpha",
      { write: [alphaBot], read: [alphaBot] },
      { defaultNamespace: alphaBot },
    );
    const beta = caller("caller-beta", { write: [betaBot], read: [betaBot] }, { defaultNamespace: betaBot });

    const made = write(alpha, create());

    expect(store.readCandidate(alpha.access, alpha.actorId, made.memoryRef.id)?.memory.bot_id).toBe(
      alphaBot.botId,
    );
    expect(store.readCandidate(beta.access, alpha.actorId, made.memoryRef.id)).toBeNull();
  });

  it("rejects a foreign bot's write while the owning bot can still update", () => {
    const alpha = caller("caller-alpha", { write: [alphaBot], read: [alphaBot] });
    const beta = caller("caller-beta", { write: [betaBot], read: [betaBot] });
    const made = write(alpha, create({ scope: "bot", botId: alphaBot.botId }));

    const denied = failure(() =>
      write(beta, {
        requestId: mutationRequestId(),
        operation: "update",
        id: made.memoryRef.id,
        expectedRevision: made.memoryRef.revision,
        change: { content: "Foreign edit bounded claim" },
      }),
    );
    expect(denied.code).toBe("scope_denied");

    const updated = write(alpha, {
      requestId: mutationRequestId(),
      operation: "update",
      id: made.memoryRef.id,
      expectedRevision: made.memoryRef.revision,
      change: { content: "Alpha edit bounded claim" },
    });
    expect(updated.memoryRef.revision).toBe(made.memoryRef.revision + 1);
  });

  it("rejects an explicit bot destination outside the caller grant on create and move", () => {
    const alpha = caller(
      "caller-alpha",
      { write: [alphaBot], read: [alphaBot] },
      { defaultNamespace: alphaBot },
    );
    const made = write(alpha, create());

    const createDenied = failure(() => write(alpha, create({ scope: "bot", botId: betaBot.botId })));
    expect(createDenied.code).toBe("scope_denied");

    const moveDenied = failure(() =>
      write(alpha, {
        requestId: mutationRequestId(),
        operation: "update",
        id: made.memoryRef.id,
        expectedRevision: made.memoryRef.revision,
        change: { scope: "bot", botId: betaBot.botId },
      }),
    );
    expect(moveDenied.code).toBe("scope_denied");
    expect(store.readCandidate(alpha.access, alpha.actorId, made.memoryRef.id)?.memory.bot_id).toBe(
      alphaBot.botId,
    );
  });

  it("rejects project metadata for a project outside the caller grant", () => {
    const alpha = caller(
      "caller-alpha",
      { write: [alphaBot], read: [alphaBot] },
      { defaultNamespace: alphaBot },
    );

    const denied = failure(() => write(alpha, create({ project: otherRepo })));

    expect(denied.code).toBe("scope_denied");
  });
});

describe("bot namespace topics, merge and restore", () => {
  it("keeps the same topic key independent across global, project, and bot namespaces", () => {
    const ids = [
      ownerWrite(create({ scope: "global", topicKey: "deploy" })),
      ownerWrite(create({ scope: "project", project: dataRepo, topicKey: "deploy" })),
      ownerWrite(create({ scope: "bot", botId: alphaBot.botId, topicKey: "deploy" })),
      ownerWrite(create({ scope: "bot", botId: betaBot.botId, topicKey: "deploy" })),
    ].map((made) => made.memoryRef.id);

    expect(new Set(ids).size).toBe(4);
    expect(visibleIds(owner, ids)).toHaveLength(4);
  });

  it("refuses a merge whose source and target sit in different bot namespaces", () => {
    const alpha = caller("caller-alpha", {
      write: [alphaBot, betaBot],
      read: [alphaBot, betaBot],
      merge: [alphaBot, betaBot],
    });
    const source = ownerWrite(create({ scope: "bot", botId: alphaBot.botId }));
    const target = ownerWrite(create({ scope: "bot", botId: betaBot.botId }));

    const result = store.mergeAuthorized(alpha.access, {
      sourceId: source.memoryRef.id,
      targetId: target.memoryRef.id,
      sourceRevision: source.memoryRef.revision,
      targetRevision: target.memoryRef.revision,
    });

    expect(result.ok).toBe(false);
    expect(visibleIds(owner, [source.memoryRef.id])).toEqual([source.memoryRef.id]);
  });

  it("merges inside one bot namespace the caller may merge", () => {
    const alpha = caller("caller-alpha", { write: [alphaBot], read: [alphaBot], merge: [alphaBot] });
    const source = ownerWrite(create({ scope: "bot", botId: alphaBot.botId }));
    const target = ownerWrite(create({ scope: "bot", botId: alphaBot.botId, title: "Distinct target note" }));

    const result = store.mergeAuthorized(alpha.access, {
      sourceId: source.memoryRef.id,
      targetId: target.memoryRef.id,
      sourceRevision: source.memoryRef.revision,
      targetRevision: target.memoryRef.revision,
    });

    expect(result.ok).toBe(true);
  });

  it("restores a bot memory only with a restore grant on its namespace", () => {
    const made = ownerWrite(
      create({ scope: "bot", botId: alphaBot.botId, content: "Restore v1 bounded claim" }),
    );
    ownerWrite({
      requestId: mutationRequestId(),
      operation: "update",
      id: made.memoryRef.id,
      expectedRevision: made.memoryRef.revision,
      change: { content: "Restore v2 bounded claim" },
    });
    const beta = caller("caller-beta", { restore: [betaBot] });
    const alpha = caller("caller-alpha", { restore: [alphaBot] });

    expect(store.restoreAuthorized(beta.access, made.memoryRef.id, made.memoryRef.revision)).toBe("denied");
    expect(store.restoreAuthorized(alpha.access, made.memoryRef.id, made.memoryRef.revision)).toBe("ok");
    expect(store.getVisible(owner, [made.memoryRef.id])[0]?.content).toBe("Restore v1 bounded claim");
  });
});

describe("legacy omitted-scope and contradictory destinations", () => {
  it("keeps an ordinary omitted-scope create in the legacy global namespace", () => {
    const globalReader = caller("caller-global", { read: [{ kind: "global" }] });
    const betaReader = caller("caller-beta", { read: [betaBot] });

    const made = ownerWrite(create());

    expect(visibleIds(globalReader.access, [made.memoryRef.id])).toEqual([made.memoryRef.id]);
    expect(visibleIds(betaReader.access, [made.memoryRef.id])).toEqual([]);
  });

  it("does not let project metadata alone move an omitted-scope create out of global", () => {
    const globalReader = caller("caller-global", { read: [{ kind: "global" }] });
    const projectReader = caller("caller-project", { read: [dataProject] });

    const made = ownerWrite(create({ project: dataRepo }));

    expect(visibleIds(globalReader.access, [made.memoryRef.id])).toEqual([made.memoryRef.id]);
    expect(visibleIds(projectReader.access, [made.memoryRef.id])).toEqual([]);
  });

  it("rejects a botId with no explicit scope and no trusted bot default", () => {
    const denied = failure(() => ownerWrite(create({ botId: alphaBot.botId })));
    expect(denied.code).toBe("invalid_input");
  });

  it("rejects a botId that differs from the trusted bot default without an explicit scope", () => {
    const alpha = caller(
      "caller-alpha",
      { write: [alphaBot, betaBot], read: [alphaBot] },
      { defaultNamespace: alphaBot },
    );

    const denied = failure(() => write(alpha, create({ botId: betaBot.botId })));

    expect(denied.code).toBe("invalid_input");
  });

  it("rejects an explicit global scope combined with a botId", () => {
    const denied = failure(() => ownerWrite(create({ scope: "global", botId: alphaBot.botId })));
    expect(denied.code).toBe("invalid_input");
  });
});

describe("bot namespace replay and mutation grants", () => {
  it("does not replay a bot's prior result to a caller without write on that bot", () => {
    const alpha = caller("caller-alpha", { write: [alphaBot], read: [alphaBot] });
    const beta = caller("caller-alpha", { write: [betaBot], read: [betaBot] });
    const request = create({ scope: "bot", botId: alphaBot.botId });
    const made = write(alpha, request);

    expect(failure(() => store.mutations.replay(beta, request)).code).toBe("scope_denied");
    expect(store.mutations.replay(alpha, request)?.memoryRef.id).toBe(made.memoryRef.id);
  });

  it("denies a mutation outside allowedMutations before any replay or write", () => {
    const alpha = caller(
      "caller-alpha",
      { write: [alphaBot], read: [alphaBot] },
      { defaultNamespace: alphaBot },
    );
    const request = create();
    const made = write(alpha, request);

    // An empty allowance must refuse even a replay of a prior successful request.
    const sealed = caller(
      "caller-gamma",
      { write: [alphaBot], read: [alphaBot] },
      { defaultNamespace: alphaBot, allowedMutations: [] },
    );
    expect(failure(() => store.mutations.replay(sealed, request)).code).toBe("scope_denied");

    // A create-only allowance must refuse a forget on the same bot memory.
    const createOnly = caller(
      "caller-delta",
      { write: [alphaBot], read: [alphaBot], delete: [alphaBot] },
      { allowedMutations: ["create"] },
    );
    const forgotten = failure(() =>
      write(createOnly, {
        requestId: mutationRequestId(),
        operation: "forget",
        id: made.memoryRef.id,
        expectedRevision: made.memoryRef.revision,
        change: {},
      }),
    );
    expect(forgotten.code).toBe("scope_denied");
    expect(store.readCandidate(alpha.access, alpha.actorId, made.memoryRef.id)?.memory.content).toBe(
      "Bot note bounded claim",
    );
  });
});
