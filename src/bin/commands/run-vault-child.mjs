// A tiny child for the run tests: run a Lar in this folder until SIGTERM, printing what run says.
// Run with: node --experimental-strip-types --no-warnings run-vault-child.mjs <lar folder>

import { runCommand } from "./run.ts";

const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write("the lar folder is missing\n");
  process.exit(2);
}

const code = await runCommand(
  ["--dir", dir],
  (line) => process.stdout.write(`${line}\n`),
  (line) => process.stderr.write(`${line}\n`),
);
process.exit(code);
