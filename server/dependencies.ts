import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const SERVICE_DEPENDENCIES = ["sqlite-vec", "@huggingface/transformers"];
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export function missingDependencies(root: string, exists: (path: string) => boolean): string[] {
  return SERVICE_DEPENDENCIES.filter((name) => !exists(join(root, "node_modules", name, "package.json")));
}

export async function installDependencies(
  bunPath: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await promisify(execFile)(bunPath, ["install", "--production", "--frozen-lockfile"], {
    cwd: root,
    env,
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}
