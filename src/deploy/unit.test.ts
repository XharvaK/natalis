import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const UNIT = join(REPO, "deploy", "natalis@.service");
const SCRIPT = join(REPO, "deploy", "wait-for-dns.sh");

type Run = { code: number | null; stderr: string; ms: number };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-dns-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** Writes a fake getent first on PATH, so the test never asks the host's resolver. */
function fakeGetent(body: string): void {
  const path = join(root, "getent");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

function runScript(host: string, seconds: string, timeout = 10_000): Run {
  const started = Date.now();
  const result = spawnSync("sh", [SCRIPT, host, seconds], {
    cwd: REPO,
    encoding: "utf8",
    timeout,
    env: { ...process.env, PATH: [root, "/bin", "/usr/bin"].join(delimiter) },
    windowsHide: true,
  });
  return { code: result.status, stderr: result.stderr ?? "", ms: Date.now() - started };
}

describe("the natalis user unit", () => {
  it("waits for DNS before it starts the Lar", () => {
    const unit = readFileSync(UNIT, "utf8");

    const pre = /^ExecStartPre=(.*deploy\/wait-for-dns\.sh[ \t]+\S+[ \t]+(\d+)[ \t]*)$/m.exec(unit);
    if (pre === null) throw new Error("the unit has no ExecStartPre that runs deploy/wait-for-dns.sh");
    const preparedAt = unit.indexOf(pre[0]);
    const startedAt = unit.search(/^ExecStart=/m);
    if (startedAt === -1) throw new Error("the unit has no ExecStart=");
    expect(preparedAt).toBeLessThan(startedAt);

    const waitSeconds = Number(pre[2]);
    const timeout = /^TimeoutStartSec=(\d+)[ \t]*$/m.exec(unit);
    if (timeout === null) throw new Error("the unit has no TimeoutStartSec=");
    expect(Number(timeout[1])).toBeGreaterThan(waitSeconds);
  });
});

describe("deploy/wait-for-dns.sh", () => {
  it.skipIf(process.platform === "win32")("gives up after its seconds and says so, without failing the unit", () => {
    fakeGetent("exit 2");
    const run = runScript("example.invalid", "2");
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(5_000);
    expect(run.stderr).toContain("natalis: DNS for example.invalid not ready after 2 s; starting anyway");
  });

  it.skipIf(process.platform === "win32")("returns at once when DNS answers", () => {
    fakeGetent("exit 0");
    const run = runScript("example.invalid", "90");
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(1_000);
    expect(run.stderr).toBe("");
  });

  it.skipIf(process.platform === "win32")("tries again after one failed lookup", () => {
    const counter = join(root, "calls");
    fakeGetent(`n=0\n[ -f '${counter}' ] && n=$(cat '${counter}')\nn=$((n + 1))\necho "$n" > '${counter}'\n[ "$n" -ge 2 ] && exit 0\nexit 2`);
    const run = runScript("example.invalid", "90");
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(readFileSync(counter, "utf8").trim()).toBe("2");
  });

  it.skipIf(process.platform === "win32")(
    "ends by its deadline even when one lookup hangs",
    () => {
      fakeGetent("sleep 30\nexit 2");
      // The spawn timeout is a backstop; the script must finish well under it.
      const run = runScript("example.invalid", "2", 35_000);
      expect(run.ms).toBeLessThan(8_000);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain("natalis: DNS for example.invalid not ready after 2 s; starting anyway");
    },
    40_000,
  );
});
