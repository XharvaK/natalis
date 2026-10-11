// A real Bubblewrap smoke test. It runs only on a Linux host with bwrap installed, and only when
// NATALIS_BWRAP_TEST is "1". Everything else in the sandbox is tested with a fake spawn.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Receipt, Tool, ToolContext, World } from "../../contracts.js";
import { createSandboxWorld } from "./sandbox-world.js";

const enabled = process.env["NATALIS_BWRAP_TEST"] === "1";

describe.skipIf(!enabled)("sandbox with real bwrap", () => {
  let dir: string;
  let world: World;
  let run: Tool;

  const call = (args: Record<string, unknown>): Promise<Receipt> =>
    run.run(args, { thread: "smoke", turnId: "smoke", nowMs: Date.now() } as unknown as ToolContext);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "natalis-bwrap-"));
    // A file in the entity folder, which the sandbox must not see.
    writeFileSync(join(dir, "secret-probe.txt"), "not for the sandbox");
    world = createSandboxWorld({ dir, config: { timeoutSeconds: 30, maxTimeoutSeconds: 60 } });
    await world.start(() => undefined);
    run = world.tools().find((tool) => tool.spec.name === "run") as Tool;
  });

  afterAll(async () => {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a command as the Lar, with its home at /home/lar", async () => {
    const receipt = await call({ command: "echo hello && echo $HOME && pwd" });
    expect(receipt.ok).toBe(true);
    expect(receipt.data?.["stdout"]).toBe("hello\n/home/lar\n/home/lar\n");
  });

  it("keeps what it writes in the home folder between runs", async () => {
    expect((await call({ command: "echo kept > /home/lar/kept.txt" })).ok).toBe(true);
    const receipt = await call({ command: "cat /home/lar/kept.txt" });
    expect(receipt.data?.["stdout"]).toBe("kept\n");
  });

  it("cannot see the entity folder, its files or the host's environment", async () => {
    const probe = join(dir, "secret-probe.txt");
    const receipt = await call({ command: `test -e '${probe}' && echo visible || echo absent; env | wc -l` });
    const [visibility, count] = String(receipt.data?.["stdout"]).trim().split("\n");
    expect(visibility).toBe("absent");
    // clearenv leaves only the four variables the design sets, plus whatever bash adds itself.
    expect(Number(count)).toBeLessThanOrEqual(8);
  });

  it("stops a command that runs past its timeout", async () => {
    const receipt = await call({ command: "sleep 30", timeout_s: 1 });
    expect(receipt.ok).toBe(false);
    expect(receipt.data?.["timedOut"]).toBe(true);
  });
});
