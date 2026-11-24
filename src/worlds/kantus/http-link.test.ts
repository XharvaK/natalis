import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool, ToolContext, WorldBody, WorldEvent } from "../../contracts.js";
import { createKantusWorld, type KantusWorld } from "./kantus-world.js";
import { KANTUS_PLACE } from "./wire.js";

const NOW = Date.UTC(2026, 10, 24, 14);
const STUDIO_TOKEN = ["live", "kantus", "http", "token", "0123456789abcdef"].join("-");

const QUIET: WorldBody = {
  keepPicture: () => {
    throw new Error("no picture in this test");
  },
  outwardHold: () => undefined,
};

const CONTEXT = { thread: KANTUS_PLACE, turnId: "t1", nowMs: NOW, river: {} as never, notebook: {} as never } as ToolContext;

type StreamClient = {
  writeLine: (obj: Record<string, unknown>) => void;
  nextLine: (predicate?: (frame: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};

function toolOf(world: KantusWorld, name: string): Tool {
  const found = world.tools().find((item) => item.spec.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
  token = STUDIO_TOKEN,
  method = "POST",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = method === "POST" ? JSON.stringify(body) : "";
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(token === "" ? {} : { Authorization: `Bearer ${token}` }),
          ...(method === "POST"
            ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
            : {}),
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> });
        });
      },
    );
    req.on("error", reject);
    if (payload !== "") req.write(payload);
    req.end();
  });
}

async function openSessionStream(port: number, token = STUDIO_TOKEN): Promise<{ status: number; client?: StreamClient }> {
  return await new Promise((resolve, reject) => {
    const req: ClientRequest = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/kantus/session",
      method: "POST",
      headers: {
        ...(token === "" ? {} : { Authorization: `Bearer ${token}` }),
        "Content-Type": "application/x-ndjson",
        Accept: "application/x-ndjson",
      },
    });
    req.on("error", reject);
    req.on("response", (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        res.resume();
        req.destroy();
        resolve({ status });
        return;
      }
      const frames: Array<Record<string, unknown>> = [];
      const waiters: Array<() => void> = [];
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl === -1) break;
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (raw === "") continue;
          frames.push(JSON.parse(raw) as Record<string, unknown>);
          for (const notify of waiters.splice(0)) notify();
        }
      });

      const client: StreamClient = {
        writeLine(obj) {
          req.write(`${JSON.stringify(obj)}\n`);
        },
        async nextLine(predicate = () => true, timeoutMs = 3_000) {
          const end = Date.now() + timeoutMs;
          for (;;) {
            const idx = frames.findIndex(predicate);
            if (idx !== -1) {
              const [hit] = frames.splice(idx, 1);
              return hit!;
            }
            const left = end - Date.now();
            if (left <= 0) throw new Error(`Timed out waiting for NDJSON frame; buffered=${JSON.stringify(frames)}`);
            await new Promise<void>((r) => {
              const t = setTimeout(r, Math.min(left, 50));
              waiters.push(() => {
                clearTimeout(t);
                r();
              });
            });
          }
        },
        async close() {
          req.end();
          req.destroy();
          res.destroy();
        },
      };
      resolve({ status, client });
    });
    req.write(`${JSON.stringify({ type: "hello", client: "kantus", mode: "RO", project: "Studio Test", transport: "idle" })}\n`);
  });
}

let dir: string;
let world: KantusWorld | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-kantus-http-"));
});

afterEach(async () => {
  await world?.stop().catch(() => {});
  world = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function startLiveWorld(): Promise<{ world: KantusWorld; port: number; events: WorldEvent[] }> {
  const events: WorldEvent[] = [];
  world = createKantusWorld({
    dir,
    token: STUDIO_TOKEN,
    host: "127.0.0.1",
    port: 0,
    listen: true,
    ownerAlias: "Doc",
    entityName: "Auris",
    nowMs: () => NOW,
  });
  await world.start((event) => events.push(event), QUIET);
  const addr = world.listeningAddress();
  if (!addr) throw new Error("expected live HTTP listener");
  return { world, port: addr.port, events };
}

describe("kantus HTTP/NDJSON StudioLink server", () => {
  it("rejects unauthorized and bad-method requests", async () => {
    const { port } = await startLiveWorld();
    const noAuth = await postJson(port, "/kantus/mode", { mode: "RW" }, "");
    expect(noAuth.status).toBe(401);
    const badAuth = await postJson(port, "/kantus/mode", { mode: "RW" }, "wrong-token");
    expect(badAuth.status).toBe(401);
    const badStream = await openSessionStream(port, "wrong-token");
    expect(badStream.status).toBe(401);
    const getRes = await postJson(port, "/kantus/mode", {}, STUDIO_TOKEN, "GET");
    expect(getRes.status).toBe(405);
    const missing = await postJson(port, "/kantus/unknown", {});
    expect(missing.status).toBe(404);
  });

  it("handshakes as Auris, delivers owner chat, flushes queued outbox says, and answers say()", async () => {
    const { world: live, port, events } = await startLiveWorld();
    const queued = await live.say(KANTUS_PLACE, "Queued while offline.");
    expect(queued).toMatchObject({ ok: true, data: { queued: true } });

    const { status, client } = await openSessionStream(port);
    expect(status).toBe(200);
    const handshake = await client!.nextLine((f) => f["type"] === "handshake");
    expect(handshake["entityName"]).toBe("Auris");

    const flushed = await client!.nextLine((f) => f["type"] === "chat");
    expect(flushed["text"]).toBe("Queued while offline.");

    client!.writeLine({ type: "chat", text: "Give me drums", context: ["Bars 1-4"] });
    await waitFor(() => events.some((e) => e.source === "owner"));
    const ownerMsg = events.find((e) => e.source === "owner");
    expect(ownerMsg).toMatchObject({ place: KANTUS_PLACE, actor: "Doc", source: "owner", wake: true });
    expect(ownerMsg?.text).toContain("Give me drums");
    expect(ownerMsg?.text).toContain("Bars 1-4");

    const sayPromise = live.say(KANTUS_PLACE, "Laid down a pocket on Beat 1.");
    const delivered = await client!.nextLine((f) => f["type"] === "chat");
    expect(delivered["entityName"]).toBe("Auris");
    expect(delivered["text"]).toBe("Laid down a pocket on Beat 1.");
    expect((await sayPromise).ok).toBe(true);

    await client!.close();
    await waitFor(() => live.resting?.() === true);
    expect(live.now()).toContain("detached");
  });

  it("updates mode, dispatches RPCs, surfaces readback PNGs, handles ask cards, and stops in-flight work", async () => {
    const { world: live, port } = await startLiveWorld();
    const { client } = await openSessionStream(port);
    await client!.nextLine((f) => f["type"] === "handshake");

    // In RO, mutating act refuses locally on the world side before sending an RPC.
    expect(await toolOf(live, "kantus_act").run({ op: "transport.start" }, CONTEXT))
      .toMatchObject({ ok: false, refused: { code: "read_only" } });

    expect((await postJson(port, "/kantus/mode", { mode: "RW" })).status).toBe(200);
    expect(live.now()).toContain("mode: RW");

    const readRun = toolOf(live, "kantus_read").run({ op: "state.summary" }, CONTEXT);
    const rpcReq = await client!.nextLine((f) => f["type"] === "rpc");
    expect(rpcReq["op"]).toBe("state.summary");
    await postJson(port, "/kantus/rpc-result", {
      callId: rpcReq["callId"],
      result: { status: "applied", readback: { tempo: 112 } },
    });
    expect(await readRun).toMatchObject({ ok: true, data: { readback: { tempo: 112 } } });

    // Rejected CommandService response maps to a refused receipt.
    const rejRun = toolOf(live, "kantus_act").run({ op: "track.delete", params: { trackId: "t1" } }, CONTEXT);
    const rejReq = await client!.nextLine((f) => f["type"] === "rpc");
    await postJson(port, "/kantus/rpc-result", {
      callId: rejReq["callId"],
      result: { status: "rejected.locked", errorCode: "locked", errorMessage: "Protected track." },
    });
    expect(await rejRun).toMatchObject({ ok: false, refused: { code: "locked", reason: "Protected track." } });

    // Ask card flows over session NDJSON stream.
    const askRun = toolOf(live, "kantus_ask_owner").run({ question: "Replace vocal take?", options: ["Allow", "Deny"] }, CONTEXT);
    const askReq = await client!.nextLine((f) => f["type"] === "ask");
    client!.writeLine({ type: "ask_answer", askId: askReq["askId"], answer: "Deny" });
    expect(await askRun).toMatchObject({ ok: true, data: { answer: "Deny" } });

    // POST /kantus/stop sets STOP mode and aborts an in-flight RPC.
    const pendingAct = toolOf(live, "kantus_act").run({ op: "player.jam" }, CONTEXT);
    await client!.nextLine((f) => f["type"] === "rpc");
    expect((await postJson(port, "/kantus/stop", {})).status).toBe(200);
    expect(await pendingAct).toMatchObject({ ok: false, refused: { code: "stopped" } });
    expect(live.now()).toContain("mode: STOP");

    await client!.close();
  });

  it("syncs Capabilities sheets over POST /kantus/capabilities-sync and rejects traversal", async () => {
    const { world: live, port } = await startLiveWorld();
    const okSync = await postJson(port, "/kantus/capabilities-sync", {
      entries: [{ path: "Content/INDEX.md", text: "# Patches\n\n- Warm Rhodes\n" }],
      full: true,
    });
    expect(okSync).toMatchObject({ status: 200, json: { ok: true, written: 1, removed: 0 } });
    expect(readFileSync(join(live.capabilitiesRoot, "Content", "INDEX.md"), "utf8")).toContain("Warm Rhodes");

    const badSync = await postJson(port, "/kantus/capabilities-sync", {
      entries: [{ path: "../escape.md", text: "nope" }],
      full: false,
    });
    expect(badSync.status).toBe(400);
  });
});
