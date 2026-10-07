// Locate the two things the supervisor launches: a bun binary and the service entry point.
//
// The plugin bundle runs through eval, so it has no __dirname or import.meta.url and cannot see
// its own directory. Paseo records every installed plugin's directory (directory, Git and npm
// sources alike) as plugins.<id>.path in $PASEO_HOME/config.json, so the default service path
// is <that directory>/service/main.ts for the entry whose paseo-plugin.json id is paseo-memory.
// Running the service from the plugin directory keeps its node_modules (sqlite-vec,
// transformers.js, onnxruntime-node) resolvable without copying native files anywhere.

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
}

export const realLocateEnv: LocateEnv = {
  exists: (path) => existsSync(path) && statSync(path).isFile(),
  readFile: (path) => readFileSync(path, "utf8"),
  env: process.env,
  home: homedir(),
};

export class LocateError extends Error {}

// Setting first, then PATH, then the Homebrew and bun.sh install locations.
export function findBun(setting: string, sys: LocateEnv = realLocateEnv): string {
  if (setting) {
    if (!sys.exists(setting)) throw new LocateError(`bun override ${setting} does not exist.`);
    return setting;
  }
  const fromPath = (sys.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "bun"));
  const candidates = [...fromPath, "/opt/homebrew/bin/bun", join(sys.home, ".bun", "bin", "bun")];
  const found = candidates.find((path) => sys.exists(path));
  if (!found) throw new LocateError("bun not found. Install with `brew install bun`.");
  return found;
}

export interface ServiceLocation {
  entry: string;
  root: string;
  source: string;
}

// servicePath may name the plugin directory or the entry file itself.
export function resolveServicePath(
  setting: string,
  paseoHome: string,
  sys: LocateEnv = realLocateEnv,
): ServiceLocation {
  if (setting) return locationFromSetting(setting, sys);
  const matches = installedPluginDirs(paseoHome, sys).filter((p) => isMemoryPluginDir(p.dir, sys));
  // Prefer the entry installed under the manifest id, then any other enabled install.
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

// Narrows parsed JSON to a plain object.
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
