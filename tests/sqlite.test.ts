import { describe, expect, it } from "bun:test";
import { FatalError, resolveSqliteLibrary } from "../service/sqlite";

const has =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe("resolving the SQLite library", () => {
  it("uses Bun's bundled SQLite on Linux", () => {
    expect(resolveSqliteLibrary(null, "linux", has())).toBeNull();
  });

  it("uses Homebrew SQLite on macOS", () => {
    const brew = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
    expect(resolveSqliteLibrary(null, "darwin", has(brew))).toBe(brew);
    expect(() => resolveSqliteLibrary(null, "darwin", has())).toThrow(FatalError);
  });

  it("honors the override on every platform", () => {
    const lib = "/usr/lib/libsqlite3.so.0";
    expect(resolveSqliteLibrary(lib, "linux", has(lib))).toBe(lib);
    expect(resolveSqliteLibrary(lib, "darwin", has(lib))).toBe(lib);
    expect(() => resolveSqliteLibrary("/missing.so", "linux", has())).toThrow(
      "SQLite override /missing.so does not exist.",
    );
  });
});
