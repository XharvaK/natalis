import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Receipt, Tool, ToolContext, World, WorldEvent } from "../../contracts.js";
import {
  createDiscordWorld,
  splitForDiscord,
  type DiscordWorldOptions,
  type PlatformAttachment,
  type PlatformClient,
  type PlatformMention,
  type PlatformMessage,
} from "./discord-world.js";
import { openShelf, PICTURE_BYTES_MAX, shelfBody } from "../../media/shelf.js";

// Every id here is invented. Tokens are built from parts so no token-shaped literal sits in the source.
const OWNER = "5".repeat(18);
const SELF = "4".repeat(18);
const MARA = "6".repeat(18);
const BOT = "7".repeat(18);
const GENERAL = "8".repeat(18);
const OFF_TOPIC = "2".repeat(18);
const DM_OWNER = "9".repeat(18);
const DM_MARA = "3".repeat(18);
const MSG_MARA = "1".repeat(18);
const CDN_ATTACHMENT = "0".repeat(18);
const EMOJI_ID = "1".repeat(17) + "2";
const FAKE_IDS = [OWNER, SELF, MARA, BOT, GENERAL, OFF_TOPIC, DM_OWNER, DM_MARA, MSG_MARA, CDN_ATTACHMENT, EMOJI_ID];
const TOKEN = ["fake", "bot", "token"].join(".");
const CDN_URL = `https://cdn.discordapp.com/attachments/${GENERAL}/${CDN_ATTACHMENT}/pic.png?ex=abc&hm=def`;

type SentRecord = { channelId: string; text: string; replyTo: string | null; id: string; mentions: string[] };

type Fake = {
  client: PlatformClient;
  sent: SentRecord[];
  reactions: Array<{ channelId: string; messageId: string; emoji: string }>;
  /** Pictures sent with a message: the channel, the name Discord gets, and the size. */
  uploads: Array<{ channelId: string; name: string; bytes: number }>;
  history: PlatformMessage[];
  /** Per send: null succeeds, an Error fails that call. Consumed in order. */
  sendScript: Array<Error | null>;
  loginError: Error | null;
  reactError: Error | null;
  logouts: number;
  deliver(message: PlatformMessage): void;
};

function fakeClient(): Fake {
  const handlers: Array<(message: PlatformMessage) => void> = [];
  let seq = 0;
  const fake: Fake = {
    client: undefined as unknown as PlatformClient,
    sent: [],
    reactions: [],
    uploads: [],
    history: [],
    sendScript: [],
    loginError: null,
    reactError: null,
    logouts: 0,
    deliver(message) {
      for (const handler of handlers) handler(message);
    },
  };
  fake.client = {
    async login() {
      if (fake.loginError) throw fake.loginError;
      return { id: SELF, displayName: "Natalis" };
    },
    async logout() {
      fake.logouts += 1;
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    async fetchRoom(channelId) {
      if (channelId === GENERAL) return { name: "general" };
      if (channelId === OFF_TOPIC) return { name: "off-topic" };
      return null;
    },
    async openDm(userId) {
      return userId === OWNER ? DM_OWNER : DM_MARA;
    },
    async send(channelId, text, replyTo, mentionUserIds = [], files = []) {
      const scripted = fake.sendScript.shift();
      if (scripted) throw scripted;
      seq += 1;
      const id = `30${String(seq).padStart(16, "0")}`;
      fake.sent.push({ channelId, text, replyTo, id, mentions: mentionUserIds });
      for (const file of files) fake.uploads.push({ channelId, name: file.name, bytes: file.bytes.length });
      return id;
    },
    async react(channelId, messageId, emoji) {
      if (fake.reactError) throw fake.reactError;
      fake.reactions.push({ channelId, messageId, emoji });
    },
    async history(channelId, limit) {
      return fake.history.filter((message) => message.channelId === channelId).slice(0, limit);
    },
  };
  return fake;
}

let idSeq = 0;
function incoming(input: {
  id?: string;
  channelId?: string;
  channelKind?: PlatformMessage["channelKind"];
  channelName?: string | null;
  author: { id: string; displayName: string; bot?: boolean };
  content: string;
  attachments?: PlatformAttachment[];
  mentionedUsers?: PlatformMention[];
  replyTo?: string | null;
  createdAtMs?: number;
}): PlatformMessage {
  idSeq += 1;
  const kind = input.channelKind ?? "room";
  return {
    id: input.id ?? `20${String(idSeq).padStart(16, "0")}`,
    channelId: input.channelId ?? (kind === "dm" ? (input.author.id === OWNER ? DM_OWNER : DM_MARA) : GENERAL),
    channelKind: kind,
    channelName: input.channelName !== undefined ? input.channelName : kind === "room" ? "general" : null,
    author: { id: input.author.id, displayName: input.author.displayName, bot: input.author.bot ?? false },
    content: input.content,
    createdAtMs: input.createdAtMs ?? Date.now(),
    attachments: input.attachments ?? [],
    mentionedUsers: input.mentionedUsers ?? [],
    replyToMessageId: input.replyTo ?? null,
  };
}

const OWNER_AUTHOR = { id: OWNER, displayName: "Xharv" };
const MARA_AUTHOR = { id: MARA, displayName: "Mara" };

let dir: string;
let aliasesPath: string;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "natalis-discord-"));
  aliasesPath = join(dir, "aliases.json");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** A fetch that answers 404 unless a test says otherwise, so no test reaches the network. */
const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;

async function startWorld(extra: Partial<DiscordWorldOptions> = {}) {
  const fake = fakeClient();
  const world = createDiscordWorld({
    token: TOKEN,
    ownerUserId: OWNER,
    rooms: [GENERAL],
    aliasesPath,
    client: fake.client,
    fetch: notFound,
    ...extra,
  });
  const events: WorldEvent[] = [];
  const shelf = openShelf(join(dir, "media"));
  await world.start((event) => {
    events.push(event);
  }, shelfBody(shelf, () => Date.now()));
  return { world, fake, events, shelf };
}

/** The tool, called with a context the world never reads (it takes its place from the arguments). */
function toolNamed(world: World, name: string): { run(args: Record<string, unknown>): Promise<Receipt> } {
  const tool: Tool | undefined = world.tools().find((candidate) => candidate.spec.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const context = {} as ToolContext;
  return { run: (args) => tool.run(args, context) };
}

function clockOf(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe("intake", () => {
  it("turns an owner DM into an owner event in the owner's DM place", async () => {
    const { fake, events } = await startWorld();
    fake.deliver(incoming({ channelKind: "dm", author: OWNER_AUTHOR, content: "Hi there" }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      world: "discord",
      place: "discord:dm:owner",
      actor: "owner",
      source: "owner",
      text: "Hi there",
      wake: true,
      data: { messageRefs: ["m1"], attachments: [], mentionsHer: false },
    });
  });

  it("turns a room message from a guest into an outside event in the room's place", async () => {
    const { fake, events } = await startWorld();
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "hello room" }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      place: "discord:room:general",
      actor: "mara",
      source: "outside",
      text: "hello room",
      wake: true,
    });
    expect(events[0]?.data).not.toHaveProperty("flooded");
  });

  it("names a guest's DM by their alias", async () => {
    const { fake, events } = await startWorld();
    fake.deliver(incoming({ channelKind: "dm", author: MARA_AUTHOR, content: "psst" }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(events[0]).toMatchObject({ place: "discord:dm:mara", actor: "mara", source: "outside" });
  });

  it("ignores the Lar's own messages, rooms it does not live in, and other channel kinds", async () => {
    const { fake, events } = await startWorld();
    fake.deliver(incoming({ author: { id: SELF, displayName: "Natalis", bot: true }, content: "my own line" }));
    fake.deliver(incoming({ channelId: OFF_TOPIC, author: MARA_AUTHOR, content: "not my room" }));
    fake.deliver(incoming({ channelKind: "other", channelId: "6".repeat(17) + "1", author: MARA_AUTHOR, content: "thread" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toHaveLength(0);
  });

  it("carries attachments with an opaque handle, never the platform address", async () => {
    const { fake, events } = await startWorld();
    fake.deliver(
      incoming({
        author: MARA_AUTHOR,
        content: "a picture",
        attachments: [{ name: "pic.png", contentType: "image/png", url: CDN_URL }],
      }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    const attachments = events[0]?.data?.attachments as Array<{ name: string; contentType: string; url: string }>;
    expect(attachments).toEqual([{ name: "pic.png", contentType: "image/png", url: "attachment:a1" }]);
  });

  it("rewrites mentions, channels and emoji into names and marks mentions of the Lar", async () => {
    const { fake, events } = await startWorld();
    fake.deliver(
      incoming({
        author: MARA_AUTHOR,
        content: `<@${SELF}> see <#${GENERAL}> and <:wave:${EMOJI_ID}> from <@${OWNER}>`,
        mentionedUsers: [{ id: SELF, displayName: "Natalis" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(events[0]?.text).toBe("@Natalis see #general and :wave: from @owner");
    expect(events[0]?.data?.mentionsHer).toBe(true);
  });

  it("keeps a reply as a ref to the message it answers", async () => {
    const { fake, events } = await startWorld();
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "answering", replyTo: MSG_MARA }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(events[0]?.data?.messageRefs).toEqual(["m1"]);
    expect(events[0]?.data?.replyToRef).toBe("m2");
  });
});

describe("debounce and cap", () => {
  it("merges a burst from one author into one event and keeps every ref", async () => {
    const { fake, events } = await startWorld();
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "a" }));
    await vi.advanceTimersByTimeAsync(500);
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "b" }));
    await vi.advanceTimersByTimeAsync(500);
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "c" }));
    await vi.advanceTimersByTimeAsync(1499);
    expect(events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("a\nb\nc");
    expect(events[0]?.data?.messageRefs).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps separate authors in separate events", async () => {
    const { fake, events } = await startWorld();
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "from mara" }));
    fake.deliver(incoming({ channelKind: "dm", author: OWNER_AUTHOR, content: "from owner" }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(events.map((event) => event.actor).sort()).toEqual(["mara", "owner"]);
  });

  it("flushes a long burst at five seconds even while messages keep coming", async () => {
    const { fake, events } = await startWorld();
    for (let i = 0; i < 5; i += 1) {
      fake.deliver(incoming({ author: MARA_AUTHOR, content: `line ${i}` }));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.data?.messageRefs).toHaveLength(5);
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "after the cap" }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(events).toHaveLength(2);
    expect(events[1]?.text).toBe("after the cap");
  });

  it("flushes pending bursts when the world stops, so no message is lost", async () => {
    const { world, fake, events } = await startWorld();
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "last words" }));
    await world.stop();
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("last words");
    expect(fake.logouts).toBe(1);
  });
});

describe("flood and loop limits", () => {
  it("keeps a flooding guest visible but does not wake the Lar", async () => {
    const { fake, events } = await startWorld();
    for (let i = 0; i < 5; i += 1) {
      fake.deliver(incoming({ author: MARA_AUTHOR, content: `msg ${i}` }));
      await vi.advanceTimersByTimeAsync(1600);
    }
    expect(events).toHaveLength(5);
    expect(events.slice(0, 4).every((event) => event.wake === true)).toBe(true);
    expect(events[4]).toMatchObject({ wake: false, text: "msg 4", data: { flooded: true } });
  });

  it("never floods the owner", async () => {
    const { fake, events } = await startWorld({ guestLimit: { messages: 1, perMs: 20_000 } });
    for (let i = 0; i < 3; i += 1) {
      fake.deliver(incoming({ channelKind: "dm", author: OWNER_AUTHOR, content: `owner ${i}` }));
      await vi.advanceTimersByTimeAsync(1600);
    }
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.wake === true && event.data?.flooded === undefined)).toBe(true);
  });

  it("stops waking the Lar for another bot past the exchange ceiling, and a person resets it", async () => {
    const { fake, events } = await startWorld({ guestLimit: { messages: 100, perMs: 20_000 } });
    const bot = { id: BOT, displayName: "Crier", bot: true };
    for (let i = 0; i < 5; i += 1) {
      fake.deliver(incoming({ author: bot, content: `bot ${i}` }));
      await vi.advanceTimersByTimeAsync(1600);
    }
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "a person speaks" }));
    await vi.advanceTimersByTimeAsync(1600);
    fake.deliver(incoming({ author: bot, content: "bot after a person" }));
    await vi.advanceTimersByTimeAsync(1600);

    const botEvents = events.filter((event) => event.actor === "crier");
    expect(botEvents.map((event) => event.wake)).toEqual([true, true, true, true, false, true]);
    expect(botEvents[4]?.data).toMatchObject({ bot: true, loopCeiling: true });
  });
});

describe("ids stay inside the world", () => {
  it("never shows a platform id in events, receipts, the now board or read_history", async () => {
    const { world, fake, events } = await startWorld();
    fake.history.push(
      incoming({
        id: MSG_MARA,
        author: MARA_AUTHOR,
        content: `<@${OWNER}> look <#${OFF_TOPIC}> <:wave:${EMOJI_ID}> https://discord.com/channels/${GENERAL}/${GENERAL}/${MSG_MARA}`,
        attachments: [{ name: "pic.png", contentType: "image/png", url: CDN_URL }],
      }),
    );
    fake.deliver(
      incoming({
        author: MARA_AUTHOR,
        content: `<@${SELF}> hi <@${OWNER}> ${MSG_MARA}`,
        mentionedUsers: [{ id: SELF, displayName: "Natalis" }],
        attachments: [{ name: "pic.png", contentType: "image/png", url: CDN_URL }],
        replyTo: MSG_MARA,
      }),
    );
    fake.deliver(incoming({ channelKind: "dm", author: OWNER_AUTHOR, content: `dm from owner ${DM_OWNER}` }));
    await vi.advanceTimersByTimeAsync(1500);

    const said = await world.say("discord:room:general", `reply to ${MSG_MARA}`, { replyTo: "m1" });
    const read = await toolNamed(world, "read_history").run({ place: "discord:room:general", limit: 10 });
    const reacted = await toolNamed(world, "react").run({ place: "discord:room:general", message_ref: "m1", emoji: "👍" });

    const blob = JSON.stringify({ events, now: world.now(), said, read, reacted });
    for (const id of FAKE_IDS) expect(blob).not.toContain(id);
    expect(events[0]?.text).toContain("@owner");
  });
});

describe("say", () => {
  it("splits a long reply in order, each message within Discord's limit, with a receipt", async () => {
    const { world, fake } = await startWorld();
    const paragraph = (letter: string) => `${letter.repeat(900)}`;
    const text = ["a", "b", "c", "d", "e"].map(paragraph).join("\n\n");
    const receipt = await world.say("discord:room:general", text);
    expect(receipt).toMatchObject({
      ok: true,
      summary: "Delivered to discord:room:general in 3 message(s).",
      data: { refs: ["m1", "m2", "m3"] },
    });
    expect(fake.sent.map((sent) => sent.text.length)).toEqual([1802, 1802, 900]);
    expect(fake.sent.every((sent) => sent.channelId === GENERAL && sent.replyTo === null)).toBe(true);
  });

  it("replies to a message by its ref", async () => {
    const { world, fake, events } = await startWorld();
    fake.deliver(incoming({ id: MSG_MARA, author: MARA_AUTHOR, content: "question" }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(events[0]?.data?.messageRefs).toEqual(["m1"]);
    const receipt = await world.say("discord:room:general", "an answer", { replyTo: "m1" });
    expect(receipt.ok).toBe(true);
    expect(fake.sent[0]?.replyTo).toBe(MSG_MARA);
  });

  it("keeps refs meaning the same message after a restart", async () => {
    const first = await startWorld();
    first.fake.deliver(incoming({ id: MSG_MARA, author: MARA_AUTHOR, content: "question" }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(first.events[0]?.data?.messageRefs).toEqual(["m1"]);
    await first.world.stop();

    const second = await startWorld();
    const receipt = await second.world.say("discord:room:general", "late answer", { replyTo: "m1" });
    expect(receipt.ok).toBe(true);
    expect(second.fake.sent[0]?.replyTo).toBe(MSG_MARA);
    second.fake.deliver(incoming({ author: MARA_AUTHOR, content: "next" }));
    await vi.advanceTimersByTimeAsync(1500);
    // Numbers are never reused: the new message gets a ref after the ones already handed out.
    expect(second.events[0]?.data?.messageRefs).not.toContain("m1");
  });

  it("turns @alias of a person the Lar knows into a mention that pings only them", async () => {
    const { world, fake } = await startWorld();
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "hi there" }));
    await vi.advanceTimersByTimeAsync(1500);
    const receipt = await world.say("discord:room:general", "@mara look at this, and @nobody-here too; mail@example.org stays");
    expect(receipt.ok).toBe(true);
    expect(fake.sent[0]?.text).toBe(`<@${MARA}> look at this, and @nobody-here too; mail@example.org stays`);
    expect(fake.sent[0]?.mentions).toEqual([MARA]);
    await world.say("discord:room:general", "no pings here");
    expect(fake.sent[1]?.mentions).toEqual([]);
  });

  it("refuses a reply to an unknown ref and sends nothing", async () => {
    const { world, fake } = await startWorld();
    const receipt = await world.say("discord:room:general", "an answer", { replyTo: "m99" });
    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("unknown_reply");
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses an unknown place with a plain reason", async () => {
    const { world, fake } = await startWorld();
    const room = await world.say("discord:room:nowhere", "hello");
    expect(room).toMatchObject({ ok: false, refused: { code: "unknown_place" } });
    const bare = await world.say("nowhere", "hello");
    expect(bare).toMatchObject({ ok: false, refused: { code: "unknown_place" } });
    expect(fake.sent).toHaveLength(0);
  });

  it("delivers to the owner's DM by its place", async () => {
    const { world, fake } = await startWorld();
    const receipt = await world.say("discord:dm:owner", "hello owner");
    expect(receipt.ok).toBe(true);
    expect(fake.sent[0]).toMatchObject({ channelId: DM_OWNER, text: "hello owner" });
  });

  it("gives a refused receipt when Discord fails, with no ids in the reason", async () => {
    const { world, fake } = await startWorld();
    fake.sendScript.push(new Error(`Missing Permissions in ${GENERAL} for user ${SELF}`));
    const receipt = await world.say("discord:room:general", "hello");
    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("send_failed");
    expect(receipt.refused?.reason).toBe("send_failed: Missing Permissions in [id] for user [id]");
    expect(JSON.stringify(receipt)).not.toContain(GENERAL);
  });

  it("reports partial progress when a later message fails", async () => {
    const { world, fake } = await startWorld();
    fake.sendScript.push(null, new Error("Unknown Channel"));
    const text = `${"a".repeat(1500)}\n\n${"b".repeat(1500)}`;
    const receipt = await world.say("discord:room:general", text);
    expect(receipt).toMatchObject({
      ok: false,
      summary: "Sent 1 of 2 message(s) to discord:room:general, then a send failed.",
      data: { refs: ["m1"] },
      refused: { code: "send_failed", reason: "send_failed: Unknown Channel" },
    });
  });

  it("refuses to say anything before the Lar is connected", async () => {
    const fake = fakeClient();
    const world = createDiscordWorld({ token: TOKEN, ownerUserId: OWNER, rooms: [GENERAL], aliasesPath, client: fake.client });
    expect(world.now()).toBe("Discord: not connected (not started).");
    const receipt = await world.say("discord:room:general", "hello");
    expect(receipt).toMatchObject({ ok: false, refused: { code: "not_connected" } });
    expect(fake.sent).toHaveLength(0);
  });
});

describe("tools", () => {
  it("reacts to a message by its ref and validates its arguments", async () => {
    const { world, fake } = await startWorld();
    fake.deliver(incoming({ id: MSG_MARA, author: MARA_AUTHOR, content: "nice" }));
    await vi.advanceTimersByTimeAsync(1500);
    const react = toolNamed(world, "react");

    const ok = await react.run({ place: "discord:room:general", message_ref: "m1", emoji: "👍" });
    expect(ok).toMatchObject({ ok: true, data: { ref: "m1", emoji: "👍" } });
    expect(fake.reactions).toEqual([{ channelId: GENERAL, messageId: MSG_MARA, emoji: "👍" }]);

    const twoWords = await react.run({ place: "discord:room:general", message_ref: "m1", emoji: "two words" });
    expect(twoWords).toMatchObject({ ok: false, refused: { code: "bad_emoji" } });
    const unknown = await react.run({ place: "discord:room:general", message_ref: "m42", emoji: "👍" });
    expect(unknown).toMatchObject({ ok: false, refused: { code: "unknown_message" } });
    const missing = await react.run({ message_ref: "m1", emoji: "👍" });
    expect(missing).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(fake.reactions).toHaveLength(1);
  });

  it("refuses a reaction Discord rejects, with the reason in plain words", async () => {
    const { world, fake } = await startWorld();
    fake.deliver(incoming({ id: MSG_MARA, author: MARA_AUTHOR, content: "nice" }));
    await vi.advanceTimersByTimeAsync(1500);
    fake.reactError = new Error("Unknown Emoji");
    const receipt = await toolNamed(world, "react").run({ place: "discord:room:general", message_ref: "m1", emoji: "👍" });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "react_failed", reason: "react_failed: Unknown Emoji" } });
  });

  it("reads recent history oldest first, with aliases and refs", async () => {
    const { world, fake } = await startWorld();
    const first = Date.UTC(2026, 9, 11, 12, 30);
    const second = Date.UTC(2026, 9, 11, 12, 31);
    // Discord returns newest first.
    fake.history.push(
      incoming({ id: "70".padEnd(18, "0"), author: { id: SELF, displayName: "Natalis" }, content: "second line", createdAtMs: second }),
      incoming({ id: MSG_MARA, author: MARA_AUTHOR, content: "first line", createdAtMs: first, attachments: [{ name: "x.txt", contentType: "text/plain", url: CDN_URL }] }),
    );
    const receipt = await toolNamed(world, "read_history").run({ place: "discord:room:general", limit: 5 });
    expect(receipt).toMatchObject({ ok: true, summary: "Read 2 message(s) from discord:room:general.", data: { count: 2 } });
    expect(receipt.data?.lines).toEqual([
      `[${clockOf(first)} mara m1] first line [attachment: x.txt]`,
      `[${clockOf(second)} you m2] second line`,
    ]);
  });

  it("validates the history limit", async () => {
    const { world } = await startWorld();
    const read = toolNamed(world, "read_history");
    expect(await read.run({ place: "discord:room:general", limit: 51 })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await read.run({ place: "discord:room:general", limit: 0 })).toMatchObject({ ok: false, refused: { code: "bad_args" } });
    expect(await read.run({ place: "discord:room:general" })).toMatchObject({ ok: true });
  });
});

describe("now and lifecycle", () => {
  it("says who the Lar is and where it lives once connected", async () => {
    const { world } = await startWorld({ rooms: [GENERAL, OFF_TOPIC] });
    expect(world.now()).toBe("Discord: connected as Natalis; places: dm:owner, room:general, room:off-topic.");
  });

  it("says the Lar is not connected when login fails, without the token", async () => {
    const fake = fakeClient();
    fake.loginError = new Error(`bad credentials for ${TOKEN}`);
    const world = createDiscordWorld({ token: TOKEN, ownerUserId: OWNER, rooms: [GENERAL], aliasesPath, client: fake.client });
    await expect(world.start(() => {})).rejects.toThrow(/Discord login failed/);
    expect(world.now()).toMatch(/^Discord: not connected \(login failed: /);
    expect(world.now()).not.toContain(TOKEN);
  });

  it("keeps the alias file across restarts so a person keeps the same alias", async () => {
    const first = await startWorld();
    first.fake.deliver(incoming({ author: MARA_AUTHOR, content: "one" }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(first.events[0]?.actor).toBe("mara");
    await first.world.stop();

    const second = await startWorld();
    second.fake.deliver(incoming({ author: { id: MARA, displayName: "Mara K." }, content: "two" }));
    second.fake.deliver(incoming({ author: { id: BOT, displayName: "Mara" }, content: "three" }));
    await vi.advanceTimersByTimeAsync(1500);
    const actors = second.events.map((event) => event.actor).sort();
    expect(actors).toEqual(["mara", "mara-2"]);
  });

  it("refuses a config without an owner", () => {
    expect(() =>
      createDiscordWorld({ token: TOKEN, ownerUserId: "", rooms: [], aliasesPath, client: fakeClient().client }),
    ).toThrow(/owner/);
  });
});

describe("owner places", () => {
  it("counts only the owner's direct message as the owner's place", async () => {
    const { world } = await startWorld();
    expect(world.isOwnerPlace?.("discord:dm:owner")).toBe(true);
    expect(world.isOwnerPlace?.("discord:dm:mara")).toBe(false);
    expect(world.isOwnerPlace?.("discord:room:general")).toBe(false);
  });

  it("follows the owner alias it is given, for places and for delivery", async () => {
    const { world, fake } = await startWorld({ ownerAlias: "boss" });
    expect(world.isOwnerPlace?.("discord:dm:boss")).toBe(true);
    expect(world.isOwnerPlace?.("discord:dm:owner")).toBe(false);
    const receipt = await world.say("discord:dm:boss", "hello boss");
    expect(receipt.ok).toBe(true);
    expect(fake.sent[0]).toMatchObject({ channelId: DM_OWNER, text: "hello boss" });
  });

  it("marks only the read-only history tool as safe while the owner's stop is on", async () => {
    const { world } = await startWorld();
    const safe = world.tools().filter((tool) => tool.spec.safeWhenStopped === true).map((tool) => tool.spec.name);
    expect(safe).toEqual(["read_history"]);
  });
});

describe("splitForDiscord", () => {
  it("keeps a short reply as one message and an empty reply as none", () => {
    expect(splitForDiscord("  hello there  ")).toEqual(["hello there"]);
    expect(splitForDiscord("   \n\n  ")).toEqual([]);
  });

  it("keeps paragraphs together when they fit", () => {
    expect(splitForDiscord("first\n\nsecond\n\nthird")).toEqual(["first\n\nsecond\n\nthird"]);
  });

  it("splits a long run of words at word boundaries and loses nothing", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.every((chunk) => !chunk.startsWith(" ") && !chunk.endsWith(" "))).toBe(true);
    expect(chunks.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it("splits an overlong paragraph at sentence ends before it falls back to words", () => {
    const text = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} ends here.`).join(" ");
    const chunks = splitForDiscord(text);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => chunk.endsWith("here."))).toBe(true);
  });

  it("keeps a fenced code block whole when it fits", () => {
    const chunks = splitForDiscord("Here:\n```js\nconst a = 1;\n```\nDone.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("```js\nconst a = 1;\n```");
  });

  it("cuts an oversized code block into fenced pieces that each stay valid", () => {
    const body = Array.from({ length: 400 }, (_, i) => `line ${i} of the code`).join("\n");
    const chunks = splitForDiscord(`\`\`\`ts\n${body}\n\`\`\``);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect(chunk.startsWith("```ts\n")).toBe(true);
      expect(chunk.endsWith("\n```")).toBe(true);
    }
    const rejoined = chunks.map((chunk) => chunk.slice("```ts\n".length, -"\n```".length)).join("\n");
    expect(rejoined).toBe(body);
  });

  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(1500);
    const chunks = splitForDiscord(text);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

describe("receipts", () => {
  it("a successful say reports how many messages went out", async () => {
    const { world } = await startWorld();
    const receipt: Receipt = await world.say("discord:room:general", "one short line");
    expect(receipt).toEqual({
      ok: true,
      summary: "Delivered to discord:room:general in 1 message(s).",
      data: { refs: ["m1"] },
    });
  });
});

describe("pictures out", () => {
  const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

  it("sends the shelf pictures with the words, named safely for Discord", async () => {
    const { world, fake } = await startWorld();
    const path = join(dir, "picture.bin");
    writeFileSync(path, PNG_BYTES);
    const receipt = await world.say("discord:dm:owner", "Here is the cat.", { files: [{ path, name: "../cat photo.png", mime: "image/png" }] });
    expect(receipt.ok).toBe(true);
    expect(fake.uploads).toEqual([{ channelId: DM_OWNER, name: "cat_photo.png", bytes: PNG_BYTES.length }]);
    expect(fake.sent.map((item) => item.text)).toEqual(["Here is the cat."]);
  });

  it("attaches the pictures to the first message only, when the words are split", async () => {
    const { world, fake } = await startWorld();
    const path = join(dir, "picture.bin");
    writeFileSync(path, PNG_BYTES);
    const long = "A sentence of plain words. ".repeat(120);
    const receipt = await world.say("discord:dm:owner", long, { files: [{ path, name: "one.png", mime: "image/png" }] });
    expect(receipt.ok).toBe(true);
    expect(fake.sent.length).toBeGreaterThan(1);
    expect(fake.uploads).toHaveLength(1);
  });

  it("refuses the whole say when a picture cannot be read, and sends nothing", async () => {
    const { world, fake } = await startWorld();
    const receipt = await world.say("discord:dm:owner", "Look.", { files: [{ path: join(dir, "gone.png"), name: "gone.png", mime: "image/png" }] });
    expect(receipt).toMatchObject({ ok: false, refused: { code: "picture_unreadable" } });
    expect(fake.sent).toEqual([]);
    expect(fake.uploads).toEqual([]);
  });
});

describe("pictures in", () => {
  const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
  /** A host that is not Discord's, built from parts. */
  const OTHER_HOST = ["other", "host"].join(".");
  const PNG_URL = `https://media.discordapp.net/attachments/${GENERAL}/${CDN_ATTACHMENT}/cat.png?ex=1&hm=2`;
  const PICTURE = { name: "cat.png", contentType: "image/png", url: PNG_URL };
  const pngResponse = (bytes: Uint8Array = PNG_BYTES) => new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": "image/png" } });
  const fetchReturning = (make: () => Response) => vi.fn(async () => make()) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  /** Lets the burst's debounce pass and waits for the pictures it was waiting for. */
  async function settle(check: () => void): Promise<void> {
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(check, { timeout: 2000, interval: 10 });
  }

  it("keeps an image attachment on the shelf, and the event line names it", async () => {
    const { fake, events, shelf } = await startWorld({ fetch: fetchReturning(() => pngResponse()) });
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "look", attachments: [PICTURE] }));
    await settle(() => expect(events).toHaveLength(1));

    const [picture] = shelf.list();
    expect(picture).toMatchObject({ mime: "image/png", bytes: PNG_BYTES.length, name: "cat.png", from: { world: "discord", place: "discord:room:general" } });
    expect(events[0]?.text).toBe(`look\n[picture ${picture?.id}: cat.png, 1 KB]`);
    expect(events[0]?.data?.attachments).toEqual([{ name: "cat.png", contentType: "image/png", url: "attachment:a1" }]);
  });

  it("fetches only from Discord's https attachment hosts, and says so when it will not", async () => {
    const fetchFn = fetchReturning(() => pngResponse());
    const { fake, events } = await startWorld({ fetch: fetchFn });
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "look", attachments: [{ name: "cat.png", contentType: "image/png", url: `https://${OTHER_HOST}/cat.png` }] }));
    await settle(() => expect(events).toHaveLength(1));
    expect(events[0]?.text).toBe("look\n[attachment: cat.png (not kept: it is not on Discord's attachment hosts)]");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses plain http and a port, even on a Discord host", async () => {
    const fetchFn = fetchReturning(() => pngResponse());
    const { fake, events } = await startWorld({ fetch: fetchFn });
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "a", attachments: [{ name: "x.png", contentType: "image/png", url: "http://cdn.discordapp.com/x.png" }] }));
    await settle(() => expect(events).toHaveLength(1));
    fake.deliver(incoming({ author: OWNER_AUTHOR, channelKind: "dm", content: "b", attachments: [{ name: "y.png", contentType: "image/png", url: "https://cdn.discordapp.com:8443/y.png" }] }));
    await settle(() => expect(events).toHaveLength(2));
    expect(events.map((event) => event.text)).toEqual([
      "a\n[attachment: x.png (not kept: it is not on Discord's attachment hosts)]",
      "b\n[attachment: y.png (not kept: it is not on Discord's attachment hosts)]",
    ]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not follow a redirect, and sends the request with redirects off", async () => {
    const fetchFn = fetchReturning(() => new Response(null, { status: 302, headers: { location: `https://${OTHER_HOST}/x.png` } }));
    const { fake, events, shelf } = await startWorld({ fetch: fetchFn });
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "look", attachments: [PICTURE] }));
    await settle(() => expect(events).toHaveLength(1));
    expect(events[0]?.text).toBe("look\n[attachment: cat.png (not kept: Discord redirected the download, which is not followed)]");
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(shelf.list()).toEqual([]);
  });

  it("refuses a picture over 8 MiB, from its declared size or from what it sends", async () => {
    const big = new Uint8Array(PICTURE_BYTES_MAX + 1);
    big.set(PNG_BYTES);
    const declared = fetchReturning(() => new Response(Buffer.from(PNG_BYTES), { status: 200, headers: { "content-length": String(PICTURE_BYTES_MAX + 1) } }));
    const sent = fetchReturning(() => new Response(big, { status: 200 }));
    const first = await startWorld({ fetch: declared });
    first.fake.deliver(incoming({ author: MARA_AUTHOR, content: "a", attachments: [PICTURE] }));
    await settle(() => expect(first.events).toHaveLength(1));
    expect(first.events[0]?.text).toBe("a\n[attachment: cat.png (not kept: it is larger than 8 MiB)]");
    await first.world.stop();

    const second = await startWorld({ fetch: sent, aliasesPath: join(dir, "second.json") });
    second.fake.deliver(incoming({ author: MARA_AUTHOR, content: "b", attachments: [PICTURE] }));
    await settle(() => expect(second.events).toHaveLength(1));
    expect(second.events[0]?.text).toBe("b\n[attachment: cat.png (not kept: it is larger than 8 MiB)]");
    expect(second.shelf.list()).toEqual([]);
  });

  it("says why a file that is not a picture was not kept", async () => {
    const { fake, events, shelf } = await startWorld({ fetch: fetchReturning(() => new Response("<html></html>", { status: 200 })) });
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "look", attachments: [PICTURE] }));
    await settle(() => expect(events).toHaveLength(1));
    expect(events[0]?.text).toBe("look\n[attachment: cat.png (not kept: Only PNG, JPEG, GIF and WebP pictures can be kept.)]");
    expect(shelf.list()).toEqual([]);
  });

  it("leaves other attachments as they were: no fetch, and the same event line", async () => {
    const fetchFn = fetchReturning(() => pngResponse());
    const { fake, events } = await startWorld({ fetch: fetchFn });
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "notes", attachments: [{ name: "x.txt", contentType: "text/plain", url: PNG_URL }] }));
    await settle(() => expect(events).toHaveLength(1));
    expect(events[0]?.text).toBe("notes");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("waits for a picture still being fetched when the world stops, so the message is not lost", async () => {
    let release: (response: Response) => void = () => {};
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => {
      release = resolve;
    })) as unknown as typeof fetch;
    const { world, fake, events, shelf } = await startWorld({ fetch: fetchFn });
    fake.deliver(incoming({ author: MARA_AUTHOR, content: "look", attachments: [PICTURE] }));
    await vi.advanceTimersByTimeAsync(1500);
    const stopping = world.stop();
    release(pngResponse());
    await stopping;
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toContain(`[picture ${shelf.list()[0]?.id}: cat.png, 1 KB]`);
  });
});
