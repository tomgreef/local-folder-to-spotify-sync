import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MatchResult } from "./types.js";

export function writeReport(results: MatchResult[]): string | null {
  const skipped = results.filter((r) => r.kind === "skipped");
  if (skipped.length === 0) return null;

  const dir = resolve(process.cwd(), "reports");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = resolve(dir, `unmatched-${stamp}.csv`);

  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = [
    ["genre", "artist", "title", "score", "reason", "path"].join(","),
    ...skipped.map((r) =>
      [r.local.genre, r.local.artist, r.local.title, String(r.score), r.reason, r.local.path]
        .map(esc)
        .join(","),
    ),
  ];
  writeFileSync(file, rows.join("\n"), "utf8");
  return file;
}
