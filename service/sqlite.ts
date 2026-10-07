// SQLite bootstrap for the service: pick a SQLite build that can load extensions, open the
// database, and load sqlite-vec. sqlite-vec is required; any failure here is fatal.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLoadablePath } from "sqlite-vec";

export const MAC_SQLITE_CANDIDATES = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
];

export class FatalError extends Error {}

// Apple's system SQLite is built without extension loading, so macOS needs a vanilla build.
// Linux Bun ships a SQLite that loads extensions, so nothing is swapped there.
export function resolveSqliteLibrary(
  setting: string | null,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform !== "darwin") return null;
  if (setting) {
    if (!exists(setting)) throw new FatalError(`sqlitePath ${setting} does not exist`);
    return setting;
  }
  const found = MAC_SQLITE_CANDIDATES.find((path) => exists(path));
  if (!found) {
    throw new FatalError(
      `no extension-capable SQLite found (tried ${MAC_SQLITE_CANDIDATES.join(", ")}). ` +
        "Run `brew install sqlite` or set sqlitePath.",
    );
  }
  return found;
}

let configuredLibrary: string | null | undefined;

// Database.setCustomSQLite works once per process and only before the first Database opens.
export function configureSqlite(setting: string | null): string | null {
  const library = resolveSqliteLibrary(setting);
  if (configuredLibrary !== undefined) {
    if (configuredLibrary !== library) {
      throw new FatalError(`SQLite already configured with ${configuredLibrary}; restart to use ${library}`);
    }
    return library;
  }
  if (library) {
    try {
      Database.setCustomSQLite(library);
    } catch (error) {
      throw new FatalError(`cannot use SQLite library ${library}: ${errorText(error)}`);
    }
  }
  configuredLibrary = library;
  return library;
}

export interface OpenedDatabase {
  db: Database;
  sqliteLibrary: string | null;
  sqliteVersion: string;
  sqliteVecVersion: string;
}

export function openDatabase(path: string, sqliteSetting: string | null = null): OpenedDatabase {
  const sqliteLibrary = configureSqlite(sqliteSetting);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.loadExtension(getLoadablePath());
  } catch (error) {
    db.close();
    throw new FatalError(`sqlite-vec failed to load: ${errorText(error)}`);
  }
  const versions = db
    .query<{ sqlite: string; vec: string }, []>(`SELECT sqlite_version() AS sqlite, vec_version() AS vec`)
    .get() ?? { sqlite: "unknown", vec: "unknown" };
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run("PRAGMA foreign_keys = ON");
  return { db, sqliteLibrary, sqliteVersion: versions.sqlite, sqliteVecVersion: versions.vec };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
