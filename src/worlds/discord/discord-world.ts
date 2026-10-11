// The Discord world: pure transport. Messages come in as events; her words go out as messages, each with a
// receipt. No judgment lives here: no tone, no emoji rules, no reply caps, no decision about when she may speak.
//
// Ids stay on this side of the line. Places, people and messages reach the entity only as aliases and opaque
// refs (m1, m2 ...). The real ids are held in memory here and in the aliases file, and nowhere else.

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type SendableChannels,
} from "discord.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Receipt, RiverSource, Tool, World, WorldEvent } from "../../contracts.js";
import { createAliasStore, OWNER_ALIAS, type AliasStore } from "./aliases.js";

// ---------------------------------------------------------------------------------------------------
// Platform port: the few calls this world needs. A fake implements it in tests; discord.js implements it
// below. Nothing here is a judgment; each call maps to one platform action.


const MAX_KEPT_REFS = 20_000;

type RefsFile = { version: 1; seq: number; refs: Record<string, [string, string]> };

function readRefs(path: string): RefsFile {
  if (!existsSync(path)) return { version: 1, seq: 0, refs: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RefsFile;
  if (parsed?.version !== 1 || typeof parsed.seq !== "number" || typeof parsed.refs !== "object") {
    throw new Error("The Discord refs file is damaged; not starting, so old refs cannot point at the wrong messages.");
  }
  return parsed;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export type PlatformAuthor = { id: string; displayName: string; bot: boolean };
export type PlatformAttachment = { name: string; contentType: string | null; url: string };
export type PlatformMention = { id: string; displayName: string };

export type PlatformMessage = {
  id: string;
  channelId: string;
  /** "dm" for a direct message, "room" for a server text channel, "other" for anything else. */
  channelKind: "dm" | "room" | "other";
  channelName: string | null;
  author: PlatformAuthor;
  content: string;
  createdAtMs: number;
  attachments: PlatformAttachment[];
  mentionedUsers: PlatformMention[];
  replyToMessageId: string | null;
};

export type PlatformClient = {
  /** Connect and resolve with her own identity once ready. */
  login(token: string): Promise<{ id: string; displayName: string }>;
  logout(): Promise<void>;
  /** Every message the bot can see, unfiltered. The world decides what is in its places. */
  onMessage(handler: (message: PlatformMessage) => void): void;
  /** A room by channel id: its name, or null when it cannot be seen. */
  fetchRoom(channelId: string): Promise<{ name: string } | null>;
  /** The direct-message channel with a user. */
  openDm(userId: string): Promise<string>;
  /** Send one message; resolves with its id. Mentions in the text never ping anyone. */
  /** `mentionUserIds`: the only people this message may ping (never everyone or roles). */
  send(channelId: string, text: string, replyToMessageId: string | null, mentionUserIds?: string[]): Promise<string>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Most recent messages first. */
  history(channelId: string, limit: number): Promise<PlatformMessage[]>;
};

// ---------------------------------------------------------------------------------------------------
// Options and the world.

export type DiscordWorldOptions = {
  token: string;
  ownerUserId: string;
  /** The owner's alias in places ("discord:dm:<alias>"). Defaults to "owner", the entity config's usual alias. */
  ownerAlias?: string;
  /** Channel ids she lives in. */
  rooms: string[];
  /** JSON file holding the alias map. Platform ids live only here. */
  aliasesPath: string;
  /** Where message refs are kept so they mean the same message after a restart. Defaults beside the aliases file. */
  refsPath?: string;
  /** Injected in tests; the discord.js client is used when absent. */
  client?: PlatformClient;
  debounceMs?: number;
  maxDebounceMs?: number;
  guestLimit?: { messages: number; perMs: number };
  botExchangeLimit?: number;
};

const WORLD_ID = "discord";
const PLACE_PREFIX = "discord:";
const DISCORD_LIMIT = 2000;
const HISTORY_DEFAULT = 20;
const HISTORY_MAX = 50;
const ERROR_TEXT_MAX = 200;
const EMOJI_MAX = 32;

function refused(code: string, reason: string, summary: string, data?: Record<string, unknown>): Receipt {
  return { ok: false, summary, ...(data ? { data } : {}), refused: { code, reason: `${code}: ${reason}` } };
}

type Status = "idle" | "starting" | "connected" | "stopped" | "failed";

type Pending = {
  key: string;
  place: string;
  actor: string;
  source: RiverSource;
  bot: boolean;
  startedAtMs: number;
  messages: Array<{ ref: string; text: string; attachments: EventAttachment[]; mentionsHer: boolean; replyToRef: string | null }>;
  flooded: boolean;
  loopCeiling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type EventAttachment = { name: string; contentType: string | null; url: string };

type Target = { ok: true; channelId: string } | { ok: false; receipt: Receipt };

export function createDiscordWorld(options: DiscordWorldOptions): World {
  if (!options.token) throw new Error("Discord world needs a bot token.");
  if (!options.ownerUserId) throw new Error("Discord world needs the owner's user id.");
  if (!options.aliasesPath) throw new Error("Discord world needs a path for its aliases file.");
  const roomIds = new Set(options.rooms.filter((id) => id.length > 0));

  const debounceMs = options.debounceMs ?? 1500;
  const maxDebounceMs = options.maxDebounceMs ?? 5000;
  const guestLimit = options.guestLimit ?? { messages: 4, perMs: 20_000 };
  const botExchangeLimit = options.botExchangeLimit ?? 4;

  const ownerAlias = options.ownerAlias ?? OWNER_ALIAS;
  const aliases: AliasStore = createAliasStore({ path: options.aliasesPath, ownerUserId: options.ownerUserId, ownerAlias });
  const client: PlatformClient = options.client ?? createDiscordJsClient();

  let status: Status = "idle";
  let statusReason = "not started";
  let self: { id: string; name: string } | null = null;
  let emitter: ((event: WorldEvent) => void) | null = null;
  let handlersRegistered = false;
  let liveRoomSlugs: string[] = [];
  let unreachableRooms = 0;

  // Opaque refs for messages. They are kept in a file beside the aliases, so a ref the entity remembers
  // means the same message after a restart. Only the newest MAX_KEPT_REFS are kept; numbers are never reused.
  const refsPath = options.refsPath ?? options.aliasesPath.replace(/\.json$/i, "") + ".refs.json";
  const messageRefs = new Map<string, { channelId: string; messageId: string }>();
  const refOfMessage = new Map<string, string>();
  let messageSeq = 0;
  {
    const stored = readRefs(refsPath);
    messageSeq = stored.seq;
    for (const [ref, [channelId, messageId]] of Object.entries(stored.refs)) {
      messageRefs.set(ref, { channelId, messageId });
      refOfMessage.set(`${channelId}|${messageId}`, ref);
    }
  }
  function saveRefs(): void {
    while (messageRefs.size > MAX_KEPT_REFS) {
      const oldest = messageRefs.keys().next().value as string;
      const target = messageRefs.get(oldest)!;
      messageRefs.delete(oldest);
      refOfMessage.delete(`${target.channelId}|${target.messageId}`);
    }
    const refs: Record<string, [string, string]> = {};
    for (const [ref, target] of messageRefs) refs[ref] = [target.channelId, target.messageId];
    writeJsonAtomic(refsPath, { version: 1, seq: messageSeq, refs });
  }
  const attachmentUrls = new Map<string, string>();
  const attachmentHandles = new Map<string, string>();
  let attachmentSeq = 0;
  const roomSlugs = new Map<string, string>();

  const pending = new Map<string, Pending>();
  const guestHits = new Map<string, number[]>();
  const botRuns = new Map<string, number>();

  function refFor(channelId: string, messageId: string): string {
    const key = `${channelId}|${messageId}`;
    const known = refOfMessage.get(key);
    if (known) return known;
    messageSeq += 1;
    const ref = `m${messageSeq}`;
    refOfMessage.set(key, ref);
    messageRefs.set(ref, { channelId, messageId });
    saveRefs();
    return ref;
  }

  function attachmentHandle(url: string): string {
    const known = attachmentHandles.get(url);
    if (known) return known;
    attachmentSeq += 1;
    const handle = `attachment:a${attachmentSeq}`;
    attachmentHandles.set(url, handle);
    attachmentUrls.set(handle, url);
    return handle;
  }

  /** Sliding window per guest per place. A refused hit is not counted. */
  function admitGuest(key: string, nowMs: number): boolean {
    const recent = (guestHits.get(key) ?? []).filter((at) => nowMs - at < guestLimit.perMs);
    const admitted = recent.length < guestLimit.messages;
    if (admitted) recent.push(nowMs);
    if (recent.length === 0) guestHits.delete(key);
    else guestHits.set(key, recent);
    return admitted;
  }

  function cleanError(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    if (options.token) message = message.split(options.token).join("[token]");
    message = scrubIds(message).replace(/\s+/g, " ").trim();
    return message.slice(0, ERROR_TEXT_MAX) || "unknown error";
  }

  function userLabel(id: string, mentioned: PlatformMention[]): string {
    if (self && id === self.id) return `@${self.name}`;
    const known = aliases.knownUserAlias(id);
    if (known) return `@${known}`;
    const named = mentioned.find((user) => user.id === id);
    if (named) return `@${aliases.userAlias(id, named.displayName)}`;
    return "@someone";
  }

  /** Mentions, channels and emoji become names; any long digit run left over is removed. */
  function readable(content: string, mentioned: PlatformMention[]): string {
    const plain = content
      .replace(/\r\n?/g, "\n")
      .replace(/<a?:(\w+):\d+>/g, ":$1:")
      .replace(/<@&\d+>/g, "@a-role")
      .replace(/<#(\d+)>/g, (_match, id: string) => `#${roomSlugs.get(id) ?? "elsewhere"}`)
      .replace(/<@!?(\d+)>/g, (_match, id: string) => userLabel(id, mentioned));
    return scrubIds(plain).trim();
  }

  function describeAttachments(list: PlatformAttachment[]): EventAttachment[] {
    return list.map((attachment) => ({
      name: scrubIds(attachment.name),
      contentType: attachment.contentType,
      url: attachmentHandle(attachment.url),
    }));
  }

  function authorLabel(author: PlatformAuthor): string {
    if (self && author.id === self.id) return "you";
    return aliases.userAlias(author.id, author.displayName);
  }

  function arm(burst: Pending, nowMs: number): void {
    if (burst.timer) clearTimeout(burst.timer);
    const untilCap = burst.startedAtMs + maxDebounceMs - nowMs;
    const delay = Math.max(0, Math.min(debounceMs, untilCap));
    burst.timer = setTimeout(() => flush(burst.key), delay);
  }

  function flush(key: string): void {
    const burst = pending.get(key);
    if (!burst) return;
    if (burst.timer) clearTimeout(burst.timer);
    pending.delete(key);
    const emit = emitter;
    if (!emit) return;
    const replyToRef = burst.messages.find((message) => message.replyToRef)?.replyToRef ?? null;
    const data: Record<string, unknown> = {
      messageRefs: burst.messages.map((message) => message.ref),
      attachments: burst.messages.flatMap((message) => message.attachments),
      mentionsHer: burst.messages.some((message) => message.mentionsHer),
    };
    if (replyToRef) data.replyToRef = replyToRef;
    if (burst.flooded) data.flooded = true;
    if (burst.loopCeiling) data.loopCeiling = true;
    if (burst.bot) data.bot = true;
    emit({
      world: WORLD_ID,
      place: burst.place,
      actor: burst.actor,
      source: burst.source,
      text: burst.messages.map((message) => message.text).filter(Boolean).join("\n"),
      atMs: burst.startedAtMs,
      wake: !(burst.flooded || burst.loopCeiling),
      data,
    });
  }

  function handleMessage(message: PlatformMessage): void {
    if ((status !== "starting" && status !== "connected") || !self || !emitter) return;
    if (message.author.id === self.id) return;
    const isOwner = message.author.id === options.ownerUserId;
    if (message.channelKind === "room") {
      if (!roomIds.has(message.channelId)) return;
    } else if (message.channelKind !== "dm") {
      return;
    }

    const nowMs = Date.now();
    const actor = aliases.userAlias(message.author.id, message.author.displayName || "person");
    const placeAlias =
      message.channelKind === "dm"
        ? `dm:${actor}`
        : `room:${roomSlugOf(message.channelId, message.channelName)}`;
    const key = `${message.channelId}|${message.author.id}`;

    const flooded = !isOwner && !admitGuest(key, nowMs);
    let loopCeiling = false;
    if (message.author.bot) {
      const run = (botRuns.get(message.channelId) ?? 0) + 1;
      botRuns.set(message.channelId, run);
      loopCeiling = run > botExchangeLimit;
    } else {
      botRuns.delete(message.channelId);
    }

    const ref = refFor(message.channelId, message.id);
    const entry = {
      ref,
      text: readable(message.content, message.mentionedUsers),
      attachments: describeAttachments(message.attachments),
      mentionsHer: message.content.includes(`<@${self.id}>`) || message.content.includes(`<@!${self.id}>`),
      replyToRef: message.replyToMessageId ? refFor(message.channelId, message.replyToMessageId) : null,
    };

    const existing = pending.get(key);
    if (existing && nowMs - existing.startedAtMs >= maxDebounceMs) flush(key);
    let burst = pending.get(key);
    if (!burst) {
      burst = {
        key,
        place: `${PLACE_PREFIX}${placeAlias}`,
        actor,
        source: isOwner ? "owner" : "outside",
        bot: message.author.bot,
        startedAtMs: nowMs,
        messages: [],
        flooded: false,
        loopCeiling: false,
        timer: null,
      };
      pending.set(key, burst);
    }
    burst.messages.push(entry);
    burst.flooded = burst.flooded || flooded;
    burst.loopCeiling = burst.loopCeiling || loopCeiling;
    arm(burst, nowMs);
  }

  function roomSlugOf(channelId: string, channelName: string | null): string {
    const known = roomSlugs.get(channelId);
    if (known) return known;
    const slug = aliases.roomAlias(channelId, channelName ?? "room");
    roomSlugs.set(channelId, slug);
    return slug;
  }

  function notConnected(): Receipt | null {
    if (status === "connected" && self) return null;
    return refused("not_connected", `Discord is not connected (${statusReason}).`, "Not connected to Discord.");
  }

  async function resolveTarget(place: string): Promise<Target> {
    const unknown = (): Target => ({
      ok: false,
      receipt: refused("unknown_place", `no Discord place is called "${place}".`, `There is no Discord place called ${place}.`),
    });
    if (!place.startsWith(PLACE_PREFIX)) return unknown();
    const rest = place.slice(PLACE_PREFIX.length);
    if (rest.startsWith("dm:")) {
      const userId = aliases.userIdForAlias(rest.slice("dm:".length));
      if (!userId) return unknown();
      try {
        return { ok: true, channelId: await client.openDm(userId) };
      } catch (error) {
        const reason = `could not open the direct message (${cleanError(error)}).`;
        return { ok: false, receipt: refused("send_failed", reason, `Could not reach ${place}.`) };
      }
    }
    if (rest.startsWith("room:")) {
      const channelId = aliases.channelIdForRoom(rest.slice("room:".length));
      if (!channelId || !roomIds.has(channelId)) return unknown();
      return { ok: true, channelId };
    }
    return unknown();
  }

  function validEmoji(emoji: string): boolean {
    return emoji.length > 0 && emoji.length <= EMOJI_MAX && !/[\s<>]/.test(emoji);
  }

  function requireText(args: Record<string, unknown>, key: string): string | Receipt {
    const value = args[key];
    if (typeof value !== "string" || value.trim() === "") {
      return refused("bad_args", `${key} must be a non-empty string.`, `The ${key} is missing.`);
    }
    return value.trim();
  }

  async function reactTo(place: string, ref: string, emoji: string): Promise<Receipt> {
    const down = notConnected();
    if (down) return down;
    const target = await resolveTarget(place);
    if (!target.ok) return target.receipt;
    const found = messageRefs.get(ref);
    if (!found || found.channelId !== target.channelId) {
      return refused("unknown_message", `${ref} is not a message in ${place}.`, `I cannot find ${ref} in ${place}.`);
    }
    if (!validEmoji(emoji)) {
      return refused("bad_emoji", "give one emoji, with no spaces.", "That is not one emoji.");
    }
    try {
      await client.react(found.channelId, found.messageId, emoji);
    } catch (error) {
      return refused("react_failed", cleanError(error), `Could not react in ${place}.`);
    }
    return { ok: true, summary: `Reacted with ${emoji} to ${ref} in ${place}.`, data: { ref, emoji } };
  }

  async function readHistory(place: string, limitArg: unknown): Promise<Receipt> {
    const down = notConnected();
    if (down) return down;
    const target = await resolveTarget(place);
    if (!target.ok) return target.receipt;
    const limit = limitArg === undefined ? HISTORY_DEFAULT : parseLimit(limitArg);
    if (limit === null) {
      return refused("bad_args", `limit must be a whole number from 1 to ${HISTORY_MAX}.`, "That limit is not allowed.");
    }
    let messages: PlatformMessage[];
    try {
      messages = await client.history(target.channelId, limit);
    } catch (error) {
      return refused("history_failed", cleanError(error), `Could not read ${place}.`);
    }
    const lines = [...messages].reverse().map((message) => {
      const body = [
        readable(message.content, message.mentionedUsers),
        ...message.attachments.map((attachment) => `[attachment: ${scrubIds(attachment.name)}]`),
      ]
        .filter(Boolean)
        .join(" ");
      const ref = refFor(message.channelId, message.id);
      return `[${clock(message.createdAtMs)} ${authorLabel(message.author)} ${ref}] ${body || "(no text)"}`;
    });
    return {
      ok: true,
      summary: `Read ${lines.length} message(s) from ${place}.`,
      data: { lines, count: lines.length },
    };
  }

  const reactTool: Tool = {
    spec: {
      name: "react",
      description:
        "Put one emoji reaction on a message. Give the place (for example \"discord:room:general\") and the message ref (for example \"m3\") from an event or from read_history.",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string", description: "The Discord place the message is in." },
          message_ref: { type: "string", description: "The message ref, such as m3." },
          emoji: { type: "string", description: "One emoji." },
        },
        required: ["place", "message_ref", "emoji"],
      },
    },
    async run(args) {
      const place = requireText(args, "place");
      if (typeof place !== "string") return place;
      const ref = requireText(args, "message_ref");
      if (typeof ref !== "string") return ref;
      const emoji = requireText(args, "emoji");
      if (typeof emoji !== "string") return emoji;
      return reactTo(place, ref, emoji);
    },
  };

  const readHistoryTool: Tool = {
    spec: {
      name: "read_history",
      // Reading sends nothing out, so it still works while the owner's emergency stop is on.
      safeWhenStopped: true,
      description: `Read the most recent messages in a Discord place, oldest first, as lines with their refs. Up to ${HISTORY_MAX}.`,
      parameters: {
        type: "object",
        properties: {
          place: { type: "string", description: "The Discord place to read." },
          limit: { type: "integer", minimum: 1, maximum: HISTORY_MAX, description: `How many messages, 1 to ${HISTORY_MAX}.` },
        },
        required: ["place"],
      },
    },
    async run(args) {
      const place = requireText(args, "place");
      if (typeof place !== "string") return place;
      return readHistory(place, args.limit);
    },
  };

  return {
    id: WORLD_ID,

    async start(emit) {
      if (status === "starting" || status === "connected") throw new Error("Discord world is already started.");
      emitter = emit;
      status = "starting";
      statusReason = "connecting";
      if (!handlersRegistered) {
        client.onMessage(handleMessage);
        handlersRegistered = true;
      }
      let identity: { id: string; displayName: string };
      try {
        identity = await client.login(options.token);
      } catch (error) {
        const reason = cleanError(error);
        status = "failed";
        statusReason = `login failed: ${reason}`;
        throw new Error(`Discord login failed: ${reason}`);
      }
      self = { id: identity.id, name: identity.displayName || "Natalis" };
      liveRoomSlugs = [];
      unreachableRooms = 0;
      for (const channelId of roomIds) {
        let room: { name: string } | null = null;
        try {
          room = await client.fetchRoom(channelId);
        } catch {
          room = null;
        }
        if (!room) {
          unreachableRooms += 1;
          continue;
        }
        const slug = aliases.roomAlias(channelId, room.name);
        roomSlugs.set(channelId, slug);
        liveRoomSlugs.push(slug);
      }
      status = "connected";
      statusReason = "connected";
    },

    async stop() {
      if (status !== "starting" && status !== "connected") return;
      for (const key of [...pending.keys()]) flush(key);
      emitter = null;
      self = null;
      status = "stopped";
      statusReason = "stopped";
      await client.logout();
    },

    async say(place, text, sayOptions) {
      const down = notConnected();
      if (down) return down;
      const target = await resolveTarget(place);
      if (!target.ok) return target.receipt;
      // "@alias" of a person she knows becomes a real mention; nobody else can be pinged.
      const mentionUserIds = new Set<string>();
      const withMentions = text.replace(/(^|[^\p{L}\p{N}_@.])@([\p{L}\p{N}][\p{L}\p{N}-]*)/gu, (whole, lead: string, alias: string) => {
        const id = aliases.userIdForAlias(alias.toLowerCase());
        if (!id) return whole;
        mentionUserIds.add(id);
        return `${lead}<@${id}>`;
      });
      const chunks = splitForDiscord(withMentions);
      if (chunks.length === 0) return refused("empty_text", "there is no text to send.", "There was nothing to send.");

      let replyId: string | null = null;
      if (sayOptions?.replyTo !== undefined) {
        const found = messageRefs.get(sayOptions.replyTo);
        if (!found || found.channelId !== target.channelId) {
          return refused(
            "unknown_reply",
            `${sayOptions.replyTo} is not a message in ${place}.`,
            `I cannot find ${sayOptions.replyTo} in ${place}, so nothing was sent.`,
          );
        }
        replyId = found.messageId;
      }

      const refs: string[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index] ?? "";
        try {
          const sentId = await client.send(target.channelId, chunk, index === 0 ? replyId : null, [...mentionUserIds]);
          refs.push(refFor(target.channelId, sentId));
          botRuns.set(target.channelId, (botRuns.get(target.channelId) ?? 0) + 1);
        } catch (error) {
          const reason = `send_failed: ${cleanError(error)}`;
          const summary =
            refs.length === 0
              ? `Could not deliver to ${place}.`
              : `Sent ${refs.length} of ${chunks.length} message(s) to ${place}, then a send failed.`;
          return {
            ok: false,
            summary,
            data: { refs },
            refused: { code: "send_failed", reason },
          };
        }
      }
      return {
        ok: true,
        summary: `Delivered to ${place} in ${refs.length} message(s).`,
        data: { refs },
      };
    },

    isOwnerPlace(place) {
      return place === `${PLACE_PREFIX}dm:${ownerAlias}`;
    },

    tools() {
      return [reactTool, readHistoryTool];
    },

    about() {
      const rooms = liveRoomSlugs.map((slug) => `${PLACE_PREFIX}room:${slug}`);
      return (
        `Discord: direct messages with your summoner at ${PLACE_PREFIX}dm:${ownerAlias}, and with people who write to you` +
        (rooms.length === 0 ? "." : `; rooms: ${rooms.join(", ")}.`)
      );
    },

    now() {
      if (status === "connected" && self) {
        const places = [`dm:${ownerAlias}`, ...liveRoomSlugs.map((slug) => `room:${slug}`)];
        const missing = unreachableRooms > 0 ? ` ${unreachableRooms} room(s) not reachable.` : "";
        return `Discord: connected as ${self.name}; places: ${places.join(", ")}.${missing}`;
      }
      return `Discord: not connected (${statusReason}).`;
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Helpers.

/** Long digit runs are platform ids (snowflakes are 17 to 20 digits). They never reach the entity. */
function scrubIds(text: string): string {
  return text.replace(/(?<!\d)\d{17,20}(?!\d)/g, "[id]");
}

function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLimit(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > HISTORY_MAX) return null;
  return n;
}

/** Chop a string into pieces of at most `limit` characters, never ending on a lone high surrogate. */
function hardSlice(text: string, limit: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - 1 > start && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

type Unit = { text: string; sep: string; solo: boolean };
type Segment = { kind: "prose"; text: string } | { kind: "code"; lang: string; body: string };

/** Splits at paragraphs, then lines, sentences and words. Each level keeps its own separator. */
const PROSE_LEVELS: Array<{ sep: string; split: (text: string) => string[] }> = [
  { sep: "\n\n", split: (text) => text.split(/\n[ \t]*\n/) },
  { sep: "\n", split: (text) => text.split("\n") },
  { sep: " ", split: (text) => text.split(/(?<=[.!?])\s+/) },
  { sep: " ", split: (text) => text.split(/\s+/) },
];

function proseUnits(text: string, limit: number, sep: string, level = 0): Unit[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [{ text: trimmed, sep, solo: false }];
  const rung = PROSE_LEVELS[level];
  if (!rung) {
    return hardSlice(trimmed, limit).map((piece, index) => ({ text: piece, sep: index === 0 ? sep : "", solo: false }));
  }
  const parts = rung.split(trimmed).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return proseUnits(trimmed, limit, sep, level + 1);
  return parts.flatMap((part, index) => proseUnits(part, limit, index === 0 ? sep : rung.sep, level + 1));
}

/** Fenced blocks stay whole when they fit; a block that does not fit is cut into fenced pieces of its own. */
function codeUnits(lang: string, body: string, limit: number): Unit[] {
  const open = "```" + lang + "\n";
  const close = "\n```";
  const whole = open + body + close;
  if (whole.length <= limit) return [{ text: whole, sep: "\n\n", solo: false }];

  const room = Math.max(1, limit - open.length - close.length);
  return packLines(body.split("\n"), room).map((text) => ({ text: open + text + close, sep: "", solo: true }));
}

/** Joins lines with newlines while they fit in `room`. A line too long for one block is cut into pieces. */
function packLines(lines: string[], room: number): string[] {
  const out: string[] = [];
  let current = "";
  let open = false;
  for (const line of lines) {
    const parts = line.length <= room ? [line] : hardSlice(line, room);
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      if (!open) {
        current = part;
        open = true;
        continue;
      }
      const glue = index === 0 ? "\n" : "";
      const joined: string = current + glue + part;
      if (joined.length <= room) {
        current = joined;
        continue;
      }
      out.push(current);
      current = part;
    }
  }
  if (open) out.push(current);
  return out;
}

function fenceSegments(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let prose: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const open = /^\s*```([^`]*)$/.exec(lines[index] ?? "");
    if (!open) {
      prose.push(lines[index] ?? "");
      index += 1;
      continue;
    }
    let close = index + 1;
    while (close < lines.length && !/^\s*```\s*$/.test(lines[close] ?? "")) close += 1;
    if (prose.length > 0) {
      segments.push({ kind: "prose", text: prose.join("\n") });
      prose = [];
    }
    segments.push({ kind: "code", lang: (open[1] ?? "").trim(), body: lines.slice(index + 1, close).join("\n") });
    index = close + 1;
  }
  if (prose.length > 0) segments.push({ kind: "prose", text: prose.join("\n") });
  return segments;
}

/**
 * Split a reply into Discord-sized messages (at most 2000 characters each), in order. Paragraphs first, then
 * lines, sentences and words. A fenced code block is kept whole when it fits.
 */
export function splitForDiscord(text: string, limit: number = DISCORD_LIMIT): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const units: Unit[] = [];
  for (const segment of fenceSegments(normalized)) {
    if (segment.kind === "prose") units.push(...proseUnits(segment.text, limit, "\n\n"));
    else units.push(...codeUnits(segment.lang, segment.body, limit));
  }
  return pack(units, limit);
}

/** Joins units into messages: a solo unit stands alone; others join with their separator while they fit. */
function pack(units: Unit[], limit: number): string[] {
  const out: string[] = [];
  let current = "";
  let open = false;
  for (const unit of units) {
    if (unit.solo) {
      if (open) out.push(current);
      open = false;
      out.push(unit.text);
      continue;
    }
    if (!open) {
      current = unit.text;
      open = true;
      continue;
    }
    const joined: string = current + unit.sep + unit.text;
    if (joined.length <= limit) {
      current = joined;
      continue;
    }
    out.push(current);
    current = unit.text;
  }
  if (open) out.push(current);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// discord.js adapter. The only code that touches the library; everything above sees PlatformClient.

function toPlatformMessage(message: Message): PlatformMessage {
  const channel = message.channel;
  const channelKind: PlatformMessage["channelKind"] =
    channel.type === ChannelType.DM ? "dm" : channel.type === ChannelType.GuildText ? "room" : "other";
  return {
    id: message.id,
    channelId: message.channelId,
    channelKind,
    channelName: channel.type === ChannelType.GuildText ? channel.name : null,
    author: {
      id: message.author.id,
      displayName: message.member?.displayName || message.author.displayName || message.author.username,
      bot: message.author.bot,
    },
    content: message.content,
    createdAtMs: message.createdTimestamp,
    attachments: [...message.attachments.values()].map((attachment) => ({
      name: attachment.name ?? "file",
      contentType: attachment.contentType ?? null,
      url: attachment.url,
    })),
    mentionedUsers: [...message.mentions.users.values()].map((user) => ({ id: user.id, displayName: user.displayName })),
    replyToMessageId: message.reference?.messageId ?? null,
  };
}

export function createDiscordJsClient(): PlatformClient {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  async function sendable(channelId: string): Promise<SendableChannels> {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isSendable()) throw new Error("that channel cannot take messages");
    return channel;
  }

  return {
    async login(token) {
      await client.login(token);
      if (!client.isReady()) {
        await new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
      }
      const user = client.user;
      if (!user) throw new Error("no identity after login");
      return { id: user.id, displayName: user.displayName || user.username };
    },
    async logout() {
      await client.destroy();
    },
    onMessage(handler) {
      client.on(Events.MessageCreate, (message) => handler(toPlatformMessage(message)));
    },
    async fetchRoom(channelId) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildText) return null;
      return { name: channel.name };
    },
    async openDm(userId) {
      const user = await client.users.fetch(userId);
      const dm = await user.createDM();
      return dm.id;
    },
    async send(channelId, text, replyToMessageId, mentionUserIds = []) {
      const channel = await sendable(channelId);
      const sent = await channel.send({
        content: text,
        allowedMentions: { parse: [], users: mentionUserIds, repliedUser: false },
        ...(replyToMessageId ? { reply: { messageReference: replyToMessageId, failIfNotExists: false } } : {}),
      });
      return sent.id;
    },
    async react(channelId, messageId, emoji) {
      const channel = await sendable(channelId);
      const message = await channel.messages.fetch(messageId);
      await message.react(emoji);
    },
    async history(channelId, limit) {
      const channel = await sendable(channelId);
      const page = await channel.messages.fetch({ limit });
      return [...page.values()].map(toPlatformMessage);
    },
  };
}
