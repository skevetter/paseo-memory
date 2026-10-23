import { describe, expect, it } from "bun:test";
import type { PaseoApi } from "../server/host-types";
import { createProjectResolver } from "../server/projects";

interface FakeWorkspace {
  id: string;
  projectId: string;
  workspaceDirectory: string;
}

const PAGE_SIZE = 2;

function fakePaseo(workspaces: FakeWorkspace[], options: { failOnPage?: number; hang?: boolean } = {}) {
  const requested: (string | undefined)[] = [];
  const paseo = {
    workspaces: {
      async list(request?: { page?: { limit: number; cursor?: string } }) {
        requested.push(request?.page?.cursor);
        if (options.hang) return new Promise<never>(() => undefined);
        const start = Number(request?.page?.cursor ?? 0);
        if (options.failOnPage !== undefined && start / PAGE_SIZE === options.failOnPage) {
          throw new Error("daemon unavailable");
        }
        const entries = workspaces.slice(start, start + PAGE_SIZE);
        const next = start + PAGE_SIZE;
        return {
          entries,
          pageInfo: {
            nextCursor: next < workspaces.length ? String(next) : null,
            prevCursor: null,
            hasMore: next < workspaces.length,
          },
        };
      },
    },
    projects: {
      async list() {
        return {
          projects: [
            {
              projectId: "p-late",
              projectKey: "remote:example/late",
              projectDisplayName: "late",
              projectRootPath: "/late",
            },
          ],
        };
      },
    },
  };
  return { paseo: paseo as unknown as PaseoApi, requested };
}

const workspaces: FakeWorkspace[] = [
  { id: "w1", projectId: "p-1", workspaceDirectory: "/work/one" },
  { id: "w2", projectId: "p-2", workspaceDirectory: "/work/two" },
  { id: "w3", projectId: "p-3", workspaceDirectory: "/work/three" },
  { id: "w4", projectId: "p-4", workspaceDirectory: "/work/four" },
  { id: "w5", projectId: "p-late", workspaceDirectory: "/work/five" },
];

describe("project resolver pagination", () => {
  it("finds a workspace that sits on the third page", async () => {
    const { paseo } = fakePaseo(workspaces);
    const resolver = createProjectResolver(
      () => undefined,
      () => undefined,
    );
    const resolution = await resolver.resolve(paseo, { cwd: "/work/five/src", workspaceId: "w5" });
    expect(resolution).toEqual({
      project: { key: "remote:example/late", name: "late", rootPath: "/late", paseoProjectId: "p-late" },
      unresolved: null,
    });
  });

  it("matches by directory across pages when no workspace id is known", async () => {
    const { paseo } = fakePaseo(workspaces);
    const resolver = createProjectResolver(
      () => undefined,
      () => undefined,
    );
    const resolution = await resolver.resolve(paseo, { cwd: "/work/five" });
    expect(resolution.project?.paseoProjectId).toBe("p-late");
  });

  it("stops paging once the workspace id is found", async () => {
    const { paseo, requested } = fakePaseo(workspaces);
    const resolver = createProjectResolver(
      () => undefined,
      () => undefined,
    );
    await resolver.resolve(paseo, { cwd: "/work/one", workspaceId: "w1" });
    expect(requested).toEqual([undefined]);
  });

  it("reports no attached project separately from a failed lookup", async () => {
    const resolver = createProjectResolver(
      () => undefined,
      () => undefined,
    );
    const missing = await resolver.resolve(fakePaseo(workspaces).paseo, { cwd: "/elsewhere" });
    expect(missing).toEqual({ project: null, unresolved: "no_project" });
    const failing = await resolver.resolve(fakePaseo(workspaces, { failOnPage: 1 }).paseo, {
      cwd: "/work/five",
      workspaceId: "w5-failing",
    });
    expect(failing).toEqual({ project: null, unresolved: "lookup_failed" });
  });

  it("does not remember a failed lookup like a definitive answer", async () => {
    const resolver = createProjectResolver(
      () => undefined,
      () => undefined,
    );
    const key = { cwd: "/work/five", workspaceId: "w5" };
    const failing = await resolver.resolve(fakePaseo(workspaces, { failOnPage: 1 }).paseo, key);
    expect(failing.unresolved).toBe("lookup_failed");
    const retry = await resolver.resolve(fakePaseo(workspaces).paseo, key);
    expect(retry.project?.paseoProjectId).toBe("p-late");
  });

  it("gives up at the deadline and reports it", async () => {
    const resolver = createProjectResolver(
      () => undefined,
      () => undefined,
      { deadlineMs: 30 },
    );
    const started = Date.now();
    const resolution = await resolver.resolve(fakePaseo(workspaces, { hang: true }).paseo, {
      cwd: "/work/five",
    });
    expect(resolution).toEqual({ project: null, unresolved: "deadline" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("stops after the page limit instead of walking an endless cursor", async () => {
    const endless = Array.from({ length: 5000 }, (_, i) => ({
      id: `x${i}`,
      projectId: `p-${i}`,
      workspaceDirectory: `/other/${i}`,
    }));
    const { paseo, requested } = fakePaseo(endless);
    const resolver = createProjectResolver(
      () => undefined,
      () => undefined,
    );
    const resolution = await resolver.resolve(paseo, { cwd: "/work/five" });
    expect(resolution).toEqual({ project: null, unresolved: "page_limit" });
    expect(requested.length).toBeLessThanOrEqual(50);
  });
});
