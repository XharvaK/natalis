// Writes dist/changes.json: the newest 500 commits of this checkout, for the Lar's news-of-her-body note at start.
// Plain Node, no dependencies. A build never fails for this: if git cannot answer, one line goes to stderr and no file
// is written.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIELD = "\u001f";
const LIMIT = 500;

try {
  const output = execFileSync(
    "git",
    ["log", `--max-count=${LIMIT}`, `--format=%H%x1f%P%x1f%s`, "HEAD"],
    { cwd: process.cwd(), encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  const commits = output
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [hash = "", parents = "", ...subject] = line.split(FIELD);
      return { hash, parents: parents.trim() === "" ? [] : parents.trim().split(/\s+/), subject: subject.join(FIELD) };
    });
  if (commits.length === 0) throw new Error("git log named no commits");
  const head = commits[0].hash;
  mkdirSync(join(process.cwd(), "dist"), { recursive: true });
  writeFileSync(
    join(process.cwd(), "dist", "changes.json"),
    `${JSON.stringify({ version: 1, head, commits }, null, 2)}\n`,
    "utf8",
  );
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  console.error(`natalis: dist/changes.json was not written: ${message}`);
}
