import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { BRIDGE_MANAGED_REGISTRY } from "../shared/bridge";

export const BridgeDiscoverySchema = z.strictObject({
  protocolVersion: z.literal(1),
  serverInstanceId: z.string().min(1),
  endpoint: z.url(),
  enabled: z.boolean(),
  controllers: z.array(
    z.strictObject({
      consumerId: z.string().min(1),
      credentialRef: z.string().regex(/^bridge\/credentials\/[a-f0-9]{64}\.json$/),
    }),
  ),
});
export const BRIDGE_DISCOVERY_FILE = "bridge-v1.json";

export class BridgeDiscovery {
  constructor(
    private readonly dataDir: string,
    private readonly serverInstanceId: string,
  ) {}
  managed(agentIds: readonly string[]): void {
    this.directory(join(this.dataDir, "bridge"));
    atomicJson(join(this.dataDir, BRIDGE_MANAGED_REGISTRY), {
      schemaVersion: 1,
      agentIds: [...new Set(agentIds)].sort(),
    });
  }
  publish(
    endpoint: string,
    credentials: readonly { consumerId: string; token: string }[],
    enabled: boolean,
  ): void {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/bridge/v1")
      throw new Error("Bridge discovery requires the actual loopback Bridge endpoint.");
    this.directory(join(this.dataDir, "bridge"));
    this.directory(join(this.dataDir, "bridge", "credentials"));
    const controllers = credentials.map(({ consumerId, token }) => {
      const credentialRef = `bridge/credentials/${createHash("sha256").update(consumerId).digest("hex")}.json`;
      atomicJson(join(this.dataDir, credentialRef), { protocolVersion: 1, consumerId, credential: token });
      return { consumerId, credentialRef };
    });
    const descriptor = BridgeDiscoverySchema.parse({
      protocolVersion: 1,
      serverInstanceId: this.serverInstanceId,
      endpoint,
      enabled,
      controllers,
    });
    this.removeOldCredentials(new Set(controllers.map((controller) => controller.credentialRef)));
    atomicJson(join(this.dataDir, BRIDGE_DISCOVERY_FILE), descriptor);
  }
  stopped(): void {
    const path = join(this.dataDir, BRIDGE_DISCOVERY_FILE);
    if (!existsSync(path)) return;
    const current = BridgeDiscoverySchema.parse(JSON.parse(readFileSync(path, "utf8")));
    // A replaced service owns its own descriptor; old shutdown must not disable it.
    if (current.serverInstanceId === this.serverInstanceId) atomicJson(path, { ...current, enabled: false });
  }
  private removeOldCredentials(current: ReadonlySet<string>): void {
    const path = join(this.dataDir, BRIDGE_DISCOVERY_FILE);
    if (!existsSync(path)) return;
    const previous = BridgeDiscoverySchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!previous.success)
      throw new Error("Existing Bridge discovery is invalid; refusing to overwrite credential provenance.");
    for (const controller of previous.data.controllers)
      if (!current.has(controller.credentialRef))
        rmSync(join(this.dataDir, controller.credentialRef), { force: true });
  }
  private directory(path: string): void {
    if (existsSync(path)) {
      const status = lstatSync(path);
      if (!status.isDirectory() || status.isSymbolicLink())
        throw new Error("Bridge private directory must not be a symlink or regular file.");
    } else mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
}

function atomicJson(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.bridge-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
