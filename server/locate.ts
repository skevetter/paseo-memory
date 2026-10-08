import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { PLUGIN_ID } from "../shared/contracts";

export const SERVICE_ENTRY = join("service", "main.ts");

export interface LocateEnv {
  exists(path: string): boolean;
  readFile(path: string): string;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}

export const realLocateEnv: LocateEnv = {
  exists: (path) => existsSync(path) && statSync(path).isFile(),
  readFile: (path) => readFileSync(path, "utf8"),
  env: process.env,
  home: homedir(),
  platform: process.platform,
};

export class LocateError extends Error {}

export function findBun(setting: string, sys: LocateEnv = realLocateEnv): string {
  if (setting) {
    if (!sys.exists(setting)) throw new LocateError(`bun override ${setting} does not exist.`);
    return setting;
  }
  const fromPath = (sys.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "bun"));
  const candidates = [...fromPath, ...bunLocations(sys.home)];
  const found = candidates.find((path) => sys.exists(path));
  if (!found) throw new LocateError(`bun not found. ${bunInstallHint(sys.platform)}`);
  return found;
}

function bunLocations(home: string): string[] {
  return [
    "/opt/homebrew/bin/bun",
    join(home, ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/home/linuxbrew/.linuxbrew/bin/bun",
    join(home, ".local", "bin", "bun"),
  ];
}

export function bunInstallHint(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "Install with `brew install bun`."
    : "Install with `curl -fsSL https://bun.sh/install | bash`.";
}

export interface ServiceLocation {
  entry: string;
  root: string;
  source: string;
}

// The plugin bundle runs through eval with no __dirname, so the default path comes from config.json.
export function resolveServicePath(
  setting: string,
  paseoHome: string,
  sys: LocateEnv = realLocateEnv,
): ServiceLocation {
  if (setting) return locationFromSetting(setting, sys);
  const matches = installedPluginDirs(paseoHome, sys).filter((p) => isMemoryPluginDir(p.dir, sys));
  const best = matches.find((p) => p.id === PLUGIN_ID) ?? matches[0];
  if (!best) {
    throw new LocateError(
      `paseo-memory is not listed in ${join(paseoHome, "config.json")}. Set the service directory override.`,
    );
  }
  return {
    entry: join(best.dir, SERVICE_ENTRY),
    root: best.dir,
    source: `config.json plugins.${best.id}.path`,
  };
}

function locationFromSetting(setting: string, sys: LocateEnv): ServiceLocation {
  if (setting.endsWith(".ts") || setting.endsWith(".js")) {
    if (!sys.exists(setting)) throw new LocateError(`Service override ${setting} does not exist.`);
    return { entry: setting, root: join(setting, "..", ".."), source: "servicePath setting" };
  }
  const entry = join(setting, SERVICE_ENTRY);
  if (!sys.exists(entry)) throw new LocateError(`Service override ${setting} has no ${SERVICE_ENTRY}.`);
  return { entry, root: setting, source: "servicePath setting" };
}

function installedPluginDirs(paseoHome: string, sys: LocateEnv): { id: string; dir: string }[] {
  const configPath = join(paseoHome, "config.json");
  let config: unknown;
  try {
    config = JSON.parse(sys.readFile(configPath));
  } catch (error) {
    throw new LocateError(
      `cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const plugins = asRecord(asRecord(config)?.plugins);
  if (!plugins) return [];
  return Object.entries(plugins).flatMap(([id, value]) => {
    const entry = asRecord(value);
    return typeof entry?.path === "string" && entry.enabled !== false ? [{ id, dir: entry.path }] : [];
  });
}

function isMemoryPluginDir(dir: string, sys: LocateEnv): boolean {
  if (!sys.exists(join(dir, SERVICE_ENTRY))) return false;
  try {
    const manifest: unknown = JSON.parse(sys.readFile(join(dir, "paseo-plugin.json")));
    return asRecord(manifest)?.id === PLUGIN_ID;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
