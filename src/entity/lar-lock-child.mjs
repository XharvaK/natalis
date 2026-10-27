// A tiny child process for the lar lock tests: take the lock and hold it, or say it is busy.
// Run with: node --experimental-strip-types --no-warnings lar-lock-child.mjs <lar folder>

import { acquireLarLock } from "./lar-lock.ts";

const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write("the lar folder is missing\n");
  process.exit(2);
}

try {
  const lock = acquireLarLock(dir);
  process.stdout.write("LOCKED\n");
  const stop = () => {
    lock.release();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setInterval(() => {}, 1000);
} catch (error) {
  process.stdout.write(`BUSY ${error?.name ?? "Error"}\n`);
  process.stderr.write(`${error?.name ?? "Error"}: ${error?.message ?? String(error)}\n`);
  process.exit(0);
}
