// A real Bubblewrap smoke test. It runs only on a Linux host with bwrap installed, and only when
// NATALIS_BWRAP_TEST is "1". Everything else in the sandbox is tested with a fake spawn.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Receipt, Tool, ToolContext, World } from "../../contracts.js";
import { createSandboxWorld, findIp, findPasta } from "./sandbox-world.js";

const enabled = process.env["NATALIS_BWRAP_TEST"] === "1";
// The wall needs pasta and ip as well as bwrap. Without them the wall tests are skipped, never run unwalled.
const wallTools = enabled && findPasta(undefined) !== undefined && findIp(undefined) !== undefined;

describe.skipIf(!enabled)("sandbox with real bwrap", () => {
  let dir: string;
  let checkout: string;
  let world: World;
  let run: Tool;

  const call = (args: Record<string, unknown>): Promise<Receipt> =>
    run.run(args, { thread: "smoke", turnId: "smoke", nowMs: Date.now() } as unknown as ToolContext);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "natalis-bwrap-"));
    // A file in the entity folder, which the sandbox must not see.
    writeFileSync(join(dir, "secret-probe.txt"), "not for the sandbox");
    // A stand-in checkout for the body: one file the sandbox may read at /body and never write.
    checkout = join(dir, "checkout");
    mkdirSync(checkout);
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "src", "body-probe.txt"), "the checkout is here\n");
    // Not on the allow-list, so the sandbox must not see it at /body.
    writeFileSync(join(checkout, "not-listed.txt"), "not for the sandbox\n");
    // The host network: these tests are about bwrap. The wall has its own block below.
    world = createSandboxWorld({ dir, config: { timeoutSeconds: 30, maxTimeoutSeconds: 60, network: "host" }, bodyDir: checkout });
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

  it("reads the checkout at /body, and cannot write to it", async () => {
    const receipt = await call({ command: "cat /body/src/body-probe.txt; echo written > /body/new.txt 2>/dev/null; echo $?" });
    const [text, writeCode] = String(receipt.data?.["stdout"]).trim().split("\n");
    expect(text).toBe("the checkout is here");
    expect((await call({ command: "cat /body/not-listed.txt 2>/dev/null; echo $?" })).data?.["stdout"]).toBe("1\n");
    expect(writeCode).not.toBe("0");
    expect(existsSync(join(checkout, "new.txt"))).toBe(false);
  });

  it("stops a command that runs past its timeout", async () => {
    const receipt = await call({ command: "sleep 30", timeout_s: 1 });
    expect(receipt.ok).toBe(false);
    expect(receipt.data?.["timedOut"]).toBe(true);
  });
});

/** A private IPv4 address of this host, the first one listed, or undefined when it has none. */
function privateAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const info of entries ?? []) {
      const ipv4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (!ipv4 || info.internal) continue;
      const [a, b] = info.address.split(".").map(Number);
      if (a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168)) return info.address;
    }
  }
  return undefined;
}

/** A TCP server that accepts and closes at once, bound to one address of this host. */
function listenOn(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolveListen, reject) => {
    const server = createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      resolveListen({ server, port: typeof address === "object" && address !== null ? address.port : 0 });
    });
  });
}

describe.skipIf(!wallTools)("sandbox network wall with real pasta and bwrap", () => {
  let dir: string;
  const servers: Server[] = [];
  const worlds: World[] = [];
  let loopbackPort = 0;
  let privateHost: string | undefined;
  let privatePort = 0;

  const callOn = (world: World, args: Record<string, unknown>): Promise<Receipt> => {
    const tool = world.tools().find((candidate) => candidate.spec.name === "run") as Tool;
    return tool.run(args, { thread: "wall", turnId: "wall", nowMs: Date.now() } as unknown as ToolContext);
  };

  /** A bash connect to host:port, with a short timeout so an address that drops packets cannot hang the test. */
  const connect = (host: string, port: number): string => `timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port}'`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "natalis-wall-test-"));
    const loopback = await listenOn("127.0.0.1");
    servers.push(loopback.server);
    loopbackPort = loopback.port;
    const address = privateAddress();
    if (address !== undefined) {
      const priv = await listenOn(address);
      servers.push(priv.server);
      privateHost = address;
      privatePort = priv.port;
    }
    for (const network of ["wall", "host"] as const) {
      const folder = join(dir, network);
      mkdirSync(folder, { recursive: true });
      // The body is off: these tests bind no checkout.
      const world = createSandboxWorld({ dir: folder, config: { timeoutSeconds: 30, maxTimeoutSeconds: 60, network, body: false } });
      await world.start(() => undefined);
      worlds.push(world);
    }
  }, 60_000);

  afterAll(async () => {
    for (const world of worlds) await world.stop();
    for (const server of servers) server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a command in the wall at all, so the refusals below cannot be mistaken for the wall", async () => {
    const receipt = await callOn(worlds[0] as World, { command: "echo walled" });
    expect(receipt.refused).toBeUndefined();
    expect(receipt.ok).toBe(true);
    expect(receipt.data?.["stdout"]).toBe("walled\n");
  });

  it("cannot connect to the host's own loopback service in wall mode", async () => {
    const receipt = await callOn(worlds[0] as World, { command: connect("127.0.0.1", loopbackPort) });
    expect(receipt.refused).toBeUndefined();
    expect(receipt.ok).toBe(false);
  });

  it("cannot connect to the host's private address in wall mode, when the host has one", async () => {
    if (privateHost === undefined) return;
    const receipt = await callOn(worlds[0] as World, { command: connect(privateHost, privatePort) });
    expect(receipt.refused).toBeUndefined();
    expect(receipt.ok).toBe(false);
  });

  it("reaches the host's loopback service in host mode, which shows the probe can detect a reachable port", async () => {
    const receipt = await callOn(worlds[1] as World, { command: connect("127.0.0.1", loopbackPort) });
    expect(receipt.ok).toBe(true);
  });
});
