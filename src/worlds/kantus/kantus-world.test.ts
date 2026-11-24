import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutwardHold, Tool, ToolContext, WorldBody } from "../../contracts.js";
import { openShelf, shelfBody } from "../../media/shelf.js";
import { openCapabilities } from "./capabilities-store.js";
import { createKantusWorld, OUTBOX_FILE, type KantusWorld } from "./kantus-world.js";
import { KANTUS_PLACE, type StudioEvent, type StudioLink, type StudioReply, type StudioStatus } from "./wire.js";

const NOW = Date.UTC(2026, 10, 24, 12);
// Built from parts at run time, so no token-shaped literal sits in the source.
const STUDIO_TOKEN = ["studio", "token", "0123456789abcdef", "more"].join("-");
const OTHER_TOKEN = ["other", "token", "fedcba9876543210", "more"].join("-");

class FakeLink implements StudioLink {
  statusValue: StudioStatus = { attached: true, mode: "RW", project: "Late Night Funk", transport: "idle" };
  readonly sent: Array<{ channel: string; payload: Record<string, unknown>; signal?: AbortSignal }> = [];
  readonly handlers = new Map<string, (payload: Record<string, unknown>, signal?: AbortSignal) => StudioReply | Promise<StudioReply>>();
  private readonly events = new Set<(event: StudioEvent) => void>();

  status(): StudioStatus {
    return this.statusValue;
  }

  async send(channel: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<StudioReply> {
    this.sent.push({ channel, payload, ...(signal === undefined ? {} : { signal }) });
    const handler = this.handlers.get(channel);
    return handler ? handler(payload, signal) : { ok: true, data: {} };
  }

  onEvent(handler: (event: StudioEvent) => void): () => void {
    this.events.add(handler);
    return () => {
      this.events.delete(handler);
    };
  }

  emit(event: StudioEvent): void {
    for (const handler of [...this.events]) handler(event);
  }
}

const QUIET: WorldBody = {
  keepPicture: () => {
    throw new Error("this test keeps no pictures");
  },
  outwardHold: () => undefined,
};

function bodyHolding(hold: OutwardHold | undefined, seen: string[] = []): WorldBody {
  return {
    keepPicture: () => {
      throw new Error("this test keeps no pictures");
    },
    outwardHold: (texts) => {
      seen.push(...texts);
      return hold;
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-kantus-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function started(options: { link?: StudioLink; vision?: boolean; body?: WorldBody } = {}): Promise<{ world: KantusWorld; link: FakeLink; events: unknown[] }> {
  const link = (options.link as FakeLink | undefined) ?? new FakeLink();
  const world = createKantusWorld({
    dir, token: STUDIO_TOKEN, nowMs: () => NOW, link,
    ...(options.vision === undefined ? {} : { vision: options.vision }),
  });
  const events: unknown[] = [];
  await world.start((event) => events.push(event), options.body ?? QUIET);
  return { world, link, events };
}

function toolOf(world: KantusWorld, name: string): Tool {
  const tool = world.tools().find((item) => item.spec.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

const CONTEXT = { thread: KANTUS_PLACE, turnId: "t1", nowMs: NOW, river: {} as never, notebook: {} as never } as ToolContext;

function outbox(): { version: number; messages: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, "kantus", OUTBOX_FILE), "utf8")) as { version: number; messages: Array<Record<string, unknown>> };
}

/** The shortest bytes the shelf reads as a PNG. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("the Kantus world's identity", () => {
  it("is the kantus world, with one owner place: the studio", async () => {
    const { world } = await started();
    expect(world.id).toBe("kantus");
    expect(world.isOwnerPlace?.(KANTUS_PLACE)).toBe(true);
    expect(world.isOwnerPlace?.("kantus:elsewhere")).toBe(false);
    expect(world.isOwnerPlace?.("discord:dm:owner")).toBe(false);
    expect(world.about()).toContain("kantus:studio");
    expect(world.bridgeAddress()).toEqual({ host: "127.0.0.1", port: 3721 });
    expect(createKantusWorld({ dir, token: STUDIO_TOKEN, host: "100.64.0.1", port: 3722 }).bridgeAddress())
      .toEqual({ host: "100.64.0.1", port: 3722 });
  });

  it("refuses a token that is missing, too short, or the same as another the body holds", async () => {
    const body = QUIET;
    await expect(createKantusWorld({ dir, token: "", nowMs: () => NOW }).start(() => {}, body)).rejects.toThrow(/missing/);
    await expect(createKantusWorld({ dir, token: "short", nowMs: () => NOW }).start(() => {}, body)).rejects.toThrow(/at least 32 bytes/);
    await expect(
      createKantusWorld({ dir, token: STUDIO_TOKEN, otherTokens: [OTHER_TOKEN, STUDIO_TOKEN], nowMs: () => NOW }).start(() => {}, body),
    ).rejects.toThrow(/equals another token/);
    await expect(createKantusWorld({ dir, token: STUDIO_TOKEN, otherTokens: [OTHER_TOKEN], nowMs: () => NOW }).start(() => {}, body))
      .resolves.toBeUndefined();
  });

  it("starts once, and stops cleanly", async () => {
    const { world } = await started();
    await expect(world.start(() => {}, QUIET)).rejects.toThrow(/already started/);
    await expect(world.stop()).resolves.toBeUndefined();
  });
});

describe("saying something in the studio", () => {
  it("sends the words over the link and returns their ref", async () => {
    const { world, link } = await started();
    link.handlers.set("say", () => ({ ok: true, data: { ref: "studio-message-1" } }));

    const receipt = await world.say(KANTUS_PLACE, "The Rhodes felt flat in chorus two.");

    expect(receipt).toMatchObject({ ok: true, data: { refs: ["studio-message-1"] } });
    expect(link.sent).toEqual([{ channel: "say", payload: { text: "The Rhodes felt flat in chorus two." }, signal: expect.anything() }]);
  });

  it("checks the body's outward hold before anything else, over the words and every file name", async () => {
    const seen: string[] = [];
    const { world, link } = await started({ body: bodyHolding({ kind: "term", term: "harbour", category: "places" }, seen) });

    const receipt = await world.say(KANTUS_PLACE, "Meet me at the harbour.", {
      asVoice: true,
      files: [{ path: join(dir, "shot.png"), name: "shop.png", mime: "image/png" }],
    });

    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("held_privacy");
    expect(seen).toEqual(["Meet me at the harbour.", "shop.png"]);
    expect(link.sent).toEqual([]);
  });

  it("refuses a voice message, since the composer pane carries text and pictures", async () => {
    const { world, link } = await started();
    const receipt = await world.say(KANTUS_PLACE, "Listen to this.", { asVoice: true });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "no_voice" } });
    expect(receipt.summary).toContain("not voice messages");
    expect(link.sent).toEqual([]);
  });

  it("sends a picture's own bytes when the body already read them, and never reads its path", async () => {
    const { world, link } = await started();
    const receipt = await world.say(KANTUS_PLACE, "Here is the bounce.", {
      files: [{ path: join(dir, "not-there.png"), name: "bounce.png", mime: "image/png", bytes: PNG }],
    });

    expect(receipt.ok).toBe(true);
    expect(link.sent[0]?.payload["files"]).toEqual([{ name: "bounce.png", mime: "image/png", base64: PNG.toString("base64") }]);
  });

  it("refuses a picture it cannot read, and sends nothing", async () => {
    const { world, link } = await started();
    const receipt = await world.say(KANTUS_PLACE, "Here is the bounce.", {
      files: [{ path: join(dir, "not-there.png"), name: "bounce.png", mime: "image/png" }],
    });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "picture_unreadable" } });
    expect(link.sent).toEqual([]);
  });

  it("refuses a place that is not the studio, and words that are empty", async () => {
    const { world } = await started();
    expect(await world.say("discord:dm:owner", "Hello.")).toMatchObject({ ok: false, refused: { code: "no_place" } });
    expect(await world.say(KANTUS_PLACE, "   ")).toMatchObject({ ok: false, refused: { code: "empty_text" } });
  });

  it("keeps the words in the outbox while the studio is detached, and sends them on the next attach", async () => {
    const { world, link } = await started();
    link.statusValue = { attached: false };

    const receipt = await world.say(KANTUS_PLACE, "Try a Suitcase tremolo on the Rhodes.");
    expect(receipt).toMatchObject({ ok: true, data: { queued: true } });
    expect(receipt.data?.["refs"]).toHaveLength(1);
    expect(outbox()).toMatchObject({ version: 1, messages: [{ text: "Try a Suitcase tremolo on the Rhodes.", atMs: NOW }] });

    link.statusValue = { attached: true, mode: "RW", project: "Late Night Funk", transport: "idle" };
    link.emit({ channel: "attached", payload: {}, atMs: NOW });
    await world.flushOutbox();

    expect(link.sent.filter((item) => item.channel === "say").map((item) => item.payload["text"]))
      .toEqual(["Try a Suitcase tremolo on the Rhodes."]);
    expect(outbox().messages).toEqual([]);
  });

  it("keeps the words when the studio goes quiet mid-send", async () => {
    const { world, link } = await started();
    link.handlers.set("say", () => ({ ok: false, code: "studio_detached", reason: "the socket closed" }));

    const receipt = await world.say(KANTUS_PLACE, "Hold the Rhodes until I am back.");
    expect(receipt).toMatchObject({ ok: true, data: { queued: true } });
    expect(outbox().messages.map((message) => message["text"])).toEqual(["Hold the Rhodes until I am back."]);
  });

  it("refuses to send before it starts", async () => {
    const world = createKantusWorld({ dir, token: STUDIO_TOKEN, nowMs: () => NOW });
    expect(await world.say(KANTUS_PLACE, "Hello.")).toMatchObject({ ok: false, refused: { code: "not_running" } });
  });
});

describe("the studio's window and its turn state", () => {
  it("shows the body's copy of what the Lar is doing, and rejects while detached", async () => {
    const { world, link } = await started();
    await world.show?.("Reading the score sheet.");
    expect(link.sent.at(-1)).toMatchObject({ channel: "show", payload: { text: "Reading the score sheet." } });

    link.statusValue = { attached: false };
    await expect(world.show?.("Reading the score sheet.")).rejects.toThrow(/detached/);
  });

  it("sends typing only for the studio place", async () => {
    const { world, link } = await started();
    world.turnRunning?.("discord:dm:owner", true);
    world.turnRunning?.(KANTUS_PLACE, true);
    expect(link.sent.filter((item) => item.channel === "typing")).toEqual([
      { channel: "typing", payload: { running: true }, signal: undefined },
    ]);
  });

  it("turns what the studio sends unasked into an event on the studio thread, and delivers composer chat as the owner", async () => {
    const { link, events } = await started();
    link.emit({ channel: "note", payload: { text: "Session saved." }, atMs: NOW });
    expect(events.at(-1)).toMatchObject({
      world: "kantus", place: KANTUS_PLACE, thread: KANTUS_PLACE, actor: "studio", source: "outside", text: "Session saved.",
    });

    link.emit({ channel: "chat", payload: { text: "Add a Rhodes turnaround.", context: ["Bars 5-8"] }, atMs: NOW });
    expect(events.at(-1)).toMatchObject({
      world: "kantus", place: KANTUS_PLACE, thread: KANTUS_PLACE, actor: "owner", source: "owner", wake: true,
    });
    expect(String((events.at(-1) as { text?: string }).text)).toContain("Add a Rhodes turnaround.");
    expect(String((events.at(-1) as { text?: string }).text)).toContain("Bars 5-8");
  });
});

describe("the summoner's stop", () => {
  it("ends an in-flight studio request with a plain refusal, and tells the studio /stop", async () => {
    const { world, link } = await started();
    link.handlers.set("command", (_payload, signal) => new Promise<StudioReply>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("the studio socket was aborted")));
    }));

    const running = toolOf(world, "kantus_read").run({ op: "state.get" }, CONTEXT);
    await world.onStop?.();
    const receipt = await running;

    expect(receipt).toMatchObject({ ok: false, refused: { code: "stopped" } });
    expect(receipt.summary).toBe("The emergency stop ended the request to the studio.");
    expect(link.sent.filter((item) => item.channel === "stop")).toEqual([{ channel: "stop", payload: { atMs: NOW }, signal: undefined }]);
  });
});

describe("the Capabilities tools", () => {
  it("reads a synced sheet with no studio attached, and is safe while the summoner's stop is on", async () => {
    openCapabilities(dir).applySync([{ path: "Craft/Groove_And_Pocket.md", text: "# Groove\n\nGhost notes sit low.\nThe backbeat sits high." }]);
    const world = createKantusWorld({ dir, token: STUDIO_TOKEN, nowMs: () => NOW });
    await world.start(() => {}, QUIET);

    const tool = toolOf(world, "kantus_cap_read");
    expect(tool.spec).toMatchObject({ effect: "read", safeWhenStopped: true });
    const receipt = await tool.run({ path: "Craft/Groove_And_Pocket.md", offsetLine: 3 }, CONTEXT);

    expect(receipt.ok).toBe(true);
    expect(receipt.data).toMatchObject({
      path: "Craft/Groove_And_Pocket.md", totalLines: 4,
      lines: [{ line: 3, text: "Ghost notes sit low." }, { line: 4, text: "The backbeat sits high." }],
    });
  });

  it("finds the lines a query matches, and refuses a path outside the folder", async () => {
    openCapabilities(dir).applySync([{ path: "Playbooks/Masking_Diagnosis.md", text: "Kick and bass share 60 to 110 Hz.\nVocals and keys share 180 to 350 Hz." }]);
    const { world } = await started();
    const tool = toolOf(world, "kantus_cap_read");

    const found = await tool.run({ path: "Playbooks/Masking_Diagnosis.md", query: "hz" }, CONTEXT);
    expect(found.data?.["matched"]).toBe(2);

    // A caller that names the folder, as the studio's own docs do, reaches the same sheet.
    const prefixed = await tool.run({ path: "Capabilities/Playbooks/Masking_Diagnosis.md", query: "hz" }, CONTEXT);
    expect(prefixed.data).toMatchObject({ path: "Playbooks/Masking_Diagnosis.md", matched: 2 });

    const bad = await tool.run({ path: "../entity.json" }, CONTEXT);
    expect(bad).toMatchObject({ ok: false, refused: { code: "bad_path" } });
  });

  it("writes an overview and sends it to an attached studio, and keeps it when the studio is detached", async () => {
    const { world, link } = await started();
    const tool = toolOf(world, "kantus_cap_write_overview");

    const sent = await tool.run({ path: "VST3/Acme_Audio/Tape_Echo/Overview.md", text: "# Tape Echo" }, CONTEXT);
    expect(sent).toMatchObject({ ok: true, data: { synced: true } });
    expect(link.sent.at(-1)).toMatchObject({ channel: "capabilities", payload: { op: "write", path: "VST3/Acme_Audio/Tape_Echo/Overview.md", text: "# Tape Echo" } });
    expect(readFileSync(join(dir, "kantus", "capabilities", "VST3", "Acme_Audio", "Tape_Echo", "Overview.md"), "utf8")).toBe("# Tape Echo");

    link.statusValue = { attached: false };
    const kept = await tool.run({ path: "VST3/Acme_Audio/Tape_Echo/Overview.md", text: "# Tape Echo, revised" }, CONTEXT);
    expect(kept).toMatchObject({ ok: true, data: { synced: false } });
    expect(kept.summary).toContain("next capabilities sync");

    const refusedPath = await tool.run({ path: "Playbooks/Masking_Diagnosis.md", text: "not an overview" }, CONTEXT);
    expect(refusedPath).toMatchObject({ ok: false, refused: { code: "bad_path" } });
  });
});

describe("the studio tools", () => {
  it("refuses a read while detached, and lets the turn end", async () => {
    const world = createKantusWorld({ dir, token: STUDIO_TOKEN, nowMs: () => NOW });
    await world.start(() => {}, QUIET);

    const receipt = await toolOf(world, "kantus_read").run({ op: "state.get" }, CONTEXT);
    expect(receipt).toMatchObject({ ok: false, refused: { code: "studio_detached" }, letsTurnEnd: true });
    expect(receipt.summary).toContain("kantus_cap_read");
  });

  it("runs a read-only op and refuses an op outside its group", async () => {
    const { world, link } = await started();
    link.handlers.set("command", (payload) => ({ ok: true, data: { op: payload["op"], bpm: 84 } }));

    const read = await toolOf(world, "kantus_read").run({ op: "state.get" }, CONTEXT);
    expect(read).toMatchObject({ ok: true, data: { op: "state.get", bpm: 84 } });

    const wrong = await toolOf(world, "kantus_read").run({ op: "transport.start" }, CONTEXT);
    expect(wrong).toMatchObject({ ok: false, refused: { code: "unknown_op" } });
    expect(toolOf(world, "kantus_read").spec.effect).toBe("read");
  });

  it("keeps an analysis's numbers, shelves its picture, and shows it only with vision", async () => {
    const shelf = openShelf(join(dir, "media"));
    const { world, link } = await started({ vision: true, body: shelfBody(shelf, () => NOW, () => undefined) });
    link.handlers.set("analysis", () => ({ ok: true, data: { lufs: -14.2, truePeakDb: -1.1, png_base64: PNG.toString("base64") } }));

    const receipt = await toolOf(world, "kantus_analyze").run({ op: "analysis.measure" }, CONTEXT);
    expect(receipt.ok).toBe(true);
    expect(receipt.data).toMatchObject({ lufs: -14.2, truePeakDb: -1.1 });
    expect(receipt.data?.["png_base64"]).toBeUndefined();
    const pictures = receipt.data?.["pictures"] as Array<{ id: string; name: string; bytes: number }>;
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toMatchObject({ bytes: PNG.length });
    expect(receipt.images).toEqual([{ type: "image", mime: "image/png", dataBase64: PNG.toString("base64") }]);
    expect(toolOf(world, "kantus_analyze").spec.effect).toBe("idempotent");
  });

  it("keeps the picture without sending it to a model that cannot see", async () => {
    const shelf = openShelf(join(dir, "media"));
    const { world, link } = await started({ body: shelfBody(shelf, () => NOW, () => undefined) });
    link.handlers.set("analysis", () => ({ ok: true, data: { png_base64: PNG.toString("base64") } }));

    const receipt = await toolOf(world, "kantus_analyze").run({ op: "ui.screenshot" }, CONTEXT);
    expect(receipt.images).toBeUndefined();
    expect(receipt.data?.["pictures"]).toHaveLength(1);
  });

  it("refuses an act while the studio is read-only, stopped, or recording, and sends it when it may", async () => {
    const { world, link } = await started();
    const act = toolOf(world, "kantus_act");
    expect(act.spec.effect).toBe("write");

    link.statusValue = { attached: true, mode: "RO" };
    expect(await act.run({ op: "transport.start" }, CONTEXT)).toMatchObject({ ok: false, refused: { code: "read_only" } });
    link.statusValue = { attached: true, mode: "STOP" };
    expect(await act.run({ op: "transport.start" }, CONTEXT)).toMatchObject({ ok: false, refused: { code: "studio_stopped" } });
    link.statusValue = { attached: true, mode: "RW", transport: "recording" };
    expect(await act.run({ op: "transport.start" }, CONTEXT)).toMatchObject({ ok: false, refused: { code: "recording" } });
    expect(link.sent.filter((item) => item.channel === "command")).toEqual([]);

    link.statusValue = { attached: true, mode: "RW", transport: "idle" };
    link.handlers.set("command", (payload) => ({ ok: true, data: { op: payload["op"], applied: true } }));
    const done = await act.run({ op: "transport.start" }, CONTEXT);
    expect(done).toMatchObject({ ok: true, data: { op: "transport.start", applied: true } });
    expect(await act.run({ op: "state.get" }, CONTEXT)).toMatchObject({ ok: false, refused: { code: "unknown_op" } });
  });

  it("asks the summoner and reports the answer", async () => {
    const { world, link } = await started();
    link.handlers.set("ask", () => ({ ok: true, data: { answer: "Allow" } }));

    const receipt = await toolOf(world, "kantus_ask_owner").run({ question: "Overwrite the take?", options: ["Allow", "Deny"] }, CONTEXT);
    expect(receipt).toMatchObject({ ok: true, data: { answer: "Allow" } });
    expect(receipt.summary).toContain("Allow");
    expect(link.sent.at(-1)).toMatchObject({ channel: "ask", payload: { question: "Overwrite the take?", options: ["Allow", "Deny"] } });
  });

  it("offers exactly the six tools the wire names, each with its own effect", async () => {
    const { world } = await started();
    expect(world.tools().map((tool) => [tool.spec.name, tool.spec.effect]).sort()).toEqual([
      ["kantus_act", "write"], ["kantus_analyze", "idempotent"], ["kantus_ask_owner", "write"], ["kantus_cap_read", "read"],
      ["kantus_cap_write_overview", "write"], ["kantus_read", "read"],
    ]);
  });
});

describe("the now board and the outbox", () => {
  it("says connected with the studio's mode, project and transport, and detached in plain words", async () => {
    const { world, link } = await started();
    link.statusValue = { attached: true, mode: "RO", project: "Late Night Funk", transport: "playing" };
    expect(world.now()).toBe("Kantus studio: connected (mode: RO, project: Late Night Funk, transport: playing).");
    expect(world.resting?.()).toBe(false);

    link.statusValue = { attached: false };
    expect(world.now()).toBe("Kantus studio: detached (Windows DAW closed). Cached Capabilities/ available via kantus_cap_read.");
    expect(world.resting?.()).toBe(true);
  });

  it("forgets the words waiting in the outbox, and keeps the rest", async () => {
    const { world, link } = await started();
    link.statusValue = { attached: false };
    await world.say(KANTUS_PLACE, "The Rhodes felt flat in chorus two.");
    await world.say(KANTUS_PLACE, "The bass was fine.");

    expect(world.forget?.(["rhodes"])).toBe(1);
    expect(outbox().messages.map((message) => message["text"])).toEqual(["The bass was fine."]);
    expect(world.forget?.(["nothing at all"])).toBe(0);
  });
});
