import { createHash } from "node:crypto";

const STOPWORDS = new Set(
  "a an and are as at be by did do does for from how i in is it of on or our so that the this to was we what when where which who why with you".split(
    " ",
  ),
);

export function ftsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .match(/[\p{L}\p{N}_\-./]+/gu)
    ?.map((t) => t.replace(/^[-./]+|[-./]+$/g, ""))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (!tokens || tokens.length === 0) return null;
  return [...new Set(tokens)]
    .slice(0, 16)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" OR ");
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function clipWords(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// RRF k=60, from Cormack, Clarke and Buettcher (SIGIR 2009).
export const RRF_K = 60;

export function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `${hours}h ago` : "just now";
}
