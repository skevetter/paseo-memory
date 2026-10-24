import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import {
  BRIDGE_BOOTSTRAP_ENV,
  BRIDGE_MANAGED_REGISTRY,
  BridgeNativeCreateResultSchema,
  BridgeNativeOpenResultSchema,
  ManagedAgentRegistrySchema,
} from "../shared/bridge";
import { NONCE_ENV } from "../shared/service-api";
import { BRIDGE_DISCOVERY_FILE, BridgeDiscoverySchema } from "./bridge-discovery";
import type { ServiceSupervisor } from "./supervisor";

type Create = PluginBeforeRequests["agent.create"];
type Open = PluginBeforeRequests["agent.session_open"];
interface NativeOptions {
  dataDir: string;
  supervisor: () => ServiceSupervisor;
  enabled: () => boolean;
  injectTools: () => boolean;
  deniedProviders: () => readonly string[];
}

/** The registry scopes managed identities only; fresh service authority still gates every execution. */
export class NativeBridgeHooks {
  private readonly claimed = new Set<string>();
  constructor(private readonly options: NativeOptions) {}
  bootstrap(request: Create): boolean {
    return Object.hasOwn(request.env ?? {}, BRIDGE_BOOTSTRAP_ENV);
  }
  managed(agentId: string): boolean {
    if (this.claimed.has(agentId)) return true;
    const path = join(this.options.dataDir, BRIDGE_MANAGED_REGISTRY);
    if (!existsSync(path)) {
      if (this.options.enabled())
        throw new Error("Memory Bridge managed-identity registry is unavailable; execution is refused.");
      return false;
    }
    const registry = ManagedAgentRegistrySchema.parse(JSON.parse(readFileSync(path, "utf8")));
    for (const id of registry.agentIds) this.claimed.add(id);
    return this.claimed.has(agentId);
  }
  async create(request: Create, milliseconds: number): Promise<Create> {
    const bootstrapRef = request.env?.[BRIDGE_BOOTSTRAP_ENV];
    if (!bootstrapRef) throw new Error("The reserved Memory bootstrap reference is empty.");
    const deadline = Date.now() + milliseconds;
    const descriptor = BridgeDiscoverySchema.parse(
      JSON.parse(readFileSync(join(this.options.dataDir, BRIDGE_DISCOVERY_FILE), "utf8")),
    );
    if (!descriptor.enabled) throw new Error("Memory Bridge is disabled; managed creation is refused.");
    const transport = `${new URL(descriptor.endpoint).origin}/mcp`;
    const servers = withoutMemory(request.config.mcpServers ?? {}, transport);
    const configHash = createHash("sha256")
      .update(JSON.stringify({ ...request.config, mcpServers: servers }))
      .digest("hex");
    const issued = BridgeNativeCreateResultSchema.parse(
      await this.options.supervisor().call(
        "bridge-create",
        {
          bootstrapRef,
          identity: { workspaceId: null, provider: String(request.config.provider), cwd: request.config.cwd },
          configHash,
        },
        milliseconds,
      ),
    );
    if (Date.now() >= deadline)
      throw new Error("Memory Bridge creation admission exceeded the original deadline.");
    if (issued.mcpServer.url !== transport)
      throw new Error(
        "Memory Bridge transport changed during creation; refresh discovery before a fresh execution.",
      );
    const provider = String(request.config.provider).split("/")[0] ?? "";
    if (this.options.injectTools() && !this.options.deniedProviders().includes(provider)) {
      let key = "memory";
      let suffix = 0;
      while (Object.hasOwn(servers, key)) key = `memory_${issued.sessionId.slice(0, 8)}_${++suffix}`;
      servers[key] = issued.mcpServer;
    }
    // Neither the controller credential nor sessionToken enters this config or environment.
    // The bootstrap remains for Bots' observed bind gate, which must remove it before provider launch.
    const env = { ...request.env };
    delete env[NONCE_ENV];
    return { ...request, config: { ...request.config, mcpServers: servers }, env };
  }
  async open(request: Open, milliseconds: number): Promise<Open> {
    if (request.purpose === "history") return history(request);
    const deadline = Date.now() + milliseconds;
    const admitted = BridgeNativeOpenResultSchema.parse(
      await this.options.supervisor().call(
        "bridge-open",
        {
          agentId: request.agentId,
          identity: { workspaceId: request.workspaceId, provider: request.provider, cwd: request.cwd },
          purpose: request.purpose,
          reason: request.reason,
        },
        milliseconds,
      ),
    );
    if (Date.now() >= deadline)
      throw new Error("Memory Bridge opening admission exceeded the original deadline.");
    if (!admitted.managed || !admitted.nonce)
      throw new Error("The managed identity has no current observed Memory lease.");
    this.claimed.add(request.agentId);
    const env = { ...request.env };
    delete env[BRIDGE_BOOTSTRAP_ENV];
    delete env[NONCE_ENV];
    return { ...request, env };
  }
  history(request: Open): Open {
    return history(request);
  }
}

function history(request: Open): Open {
  if (!Object.hasOwn(request.env, BRIDGE_BOOTSTRAP_ENV) && !Object.hasOwn(request.env, NONCE_ENV))
    return request;
  const env = { ...request.env };
  delete env[BRIDGE_BOOTSTRAP_ENV];
  delete env[NONCE_ENV];
  return { ...request, env };
}
function withoutMemory(
  servers: NonNullable<Create["config"]["mcpServers"]>,
  target: string,
): NonNullable<Create["config"]["mcpServers"]> {
  const expected = new URL(target);
  return Object.fromEntries(
    Object.entries(servers).filter(([, server]) => {
      if (server.type === "stdio") return true;
      try {
        const url = new URL(server.url);
        return url.origin !== expected.origin || url.pathname !== expected.pathname;
      } catch {
        return true;
      }
    }),
  );
}
