// The Discord world: pure transport. Messages come in as events; the Lar's words go out as messages, each with a
// receipt. No judgment lives here: no tone, no emoji rules, no reply caps, no decision about when the Lar may speak.
//
// Ids stay on this side of the line. Places, people and messages reach the entity only as aliases and opaque
// refs (m1, m2 ...). The real ids are held in memory here and in the aliases file, and nowhere else.

import { whenText } from "../../entity/when.js";
import {
  ActivityType,
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type Presence,
  type SendableChannels,
  type Typing,
  type User,
  type VoiceState,
} from "discord.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readContacts } from "../../entity/contacts.js";
import type { Receipt, RiverSource, SayFile, Sense, Tool, World, WorldBody, WorldEvent } from "../../contracts.js";
import { formatDuration } from "../../context/time-facts.js";
import { PICTURE_BYTES_MAX } from "../../media/shelf.js";
import { createAliasStore, OWNER_ALIAS, type AliasStore } from "./aliases.js";
import { FILE_BYTES_MAX, plainFileName, saveFile, type FilesHome } from "./files.js";
import { writeFileAtomic } from "../../fsutil/write-atomic.js";
import { VoiceError, type HeardVoiceMessage, type MadeVoiceMessage, type VoiceMessages } from "../../voice/voice-messages.js";

// ---------------------------------------------------------------------------------------------------
// Platform port: the few calls this world needs. A fake implements it in tests; discord.js implements it
// below. Nothing here is a judgment; each call maps to one platform action.


const MAX_KEPT_REFS = 20_000;
/** Message ids remembered to turn away a repeat from a gateway resume; the oldest is dropped first. */
const HANDLED_IDS_CAP = 2000;

type RefsFile = { version: 1; seq: number; refs: Record<string, [string, string]> };

/** Pictures and files asked for by anyone but the summoner, counted per local day. */
type PictureCount = { version: 1; day: string; others: number };

function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function readPictureCount(path: string): PictureCount {
  if (!existsSync(path)) return { version: 1, day: "", others: 0 };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PictureCount;
  if (parsed?.version !== 1 || typeof parsed.day !== "string" || typeof parsed.others !== "number") {
    throw new Error("The Discord picture count file is damaged; not starting, so a restart cannot reset the day's limit.");
  }
  return parsed;
}

function readRefs(path: string): RefsFile {
  if (!existsSync(path)) return { version: 1, seq: 0, refs: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RefsFile;
  if (parsed?.version !== 1 || typeof parsed.seq !== "number" || typeof parsed.refs !== "object") {
    throw new Error("The Discord refs file is damaged; not starting, so old refs cannot point at the wrong messages.");
  }
  return parsed;
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value), { mkdir: true });
}

export type PlatformAuthor = { id: string; displayName: string; bot: boolean };
export type PlatformAttachment = { name: string; contentType: string | null; url: string; durationSecs?: number | null };
export type PlatformMention = { id: string; displayName: string };
export type OutboundFile = { name: string; bytes: Uint8Array };
export type OutboundVoice = { bytes: Uint8Array; durationSecs: number; waveform: string };

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
  /** True when Discord flags the message as a voice message. */
  voice?: boolean;
};

export type PlatformReaction = {
  channelId: string;
  channelKind: "dm" | "room" | "other";
  messageId: string;
  /** The reacted message's author, fetched when the message was not cached. Null when it cannot be read. */
  messageAuthorId: string | null;
  userId: string;
  userDisplayName: string;
  userBot: boolean;
  /** A unicode emoji as is; a custom emoji as :name:. */
  emoji: string;
  added: boolean;
};

export type PlatformEdit = PlatformMessage & { editedAtMs: number | null };

export type PlatformPresence = {
  userId: string;
  status: "online" | "idle" | "dnd" | "offline";
  /** The name of a Playing activity, or null. */
  game: string | null;
  /** A Listening activity named Spotify: details is the track, state the artist. Null otherwise. */
  music: { track: string; artist: string } | null;
  /** What Discord held for this user just before the change, when it had it cached. */
  before?: { status: PlatformPresence["status"]; game: string | null; music: { track: string; artist: string } | null } | null;
};

export type PlatformVoice = {
  userId: string;
  before: { channelName: string } | null;
  after: { channelName: string; othersCount: number } | null;
};

export type PlatformTyping = { userId: string; channelId: string; channelKind: "dm" | "room" | "other" };

export type PlatformClient = {
  /** Connect and resolve with the bot's own identity once ready. */
  login(token: string): Promise<{ id: string; displayName: string }>;
  logout(): Promise<void>;
  /** Every message the bot can see, unfiltered. The world decides what is in its places. */
  onMessage(handler: (message: PlatformMessage) => void): void;
  onReaction(handler: (reaction: PlatformReaction) => void): void;
  onEdit(handler: (edit: PlatformEdit) => void): void;
  onPresence(handler: (presence: PlatformPresence) => void): void;
  onVoice(handler: (voice: PlatformVoice) => void): void;
  onTyping(handler: (typing: PlatformTyping) => void): void;
  /** A room by channel id: its name, or null when it cannot be seen. */
  fetchRoom(channelId: string): Promise<{ name: string } | null>;
  /** The direct-message channel with a user. */
  openDm(userId: string): Promise<string>;
  /** Send one message; resolves with its id. Mentions in the text never ping anyone. */
  /** `mentionUserIds`: the only people this message may ping (never everyone or roles). `files`: pictures to attach. */
  send(
    channelId: string,
    text: string,
    replyToMessageId: string | null,
    mentionUserIds?: string[],
    files?: OutboundFile[],
  ): Promise<string>;
  /** N10: one voice message: an Ogg Opus file with its duration and waveform, and no text. Resolves with its id. */
  sendVoice(channelId: string, voice: OutboundVoice, replyToMessageId: string | null): Promise<string>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Show "typing" in a channel for a few seconds. */
  sendTyping(channelId: string): Promise<void>;
  /** Most recent messages first. */
  history(channelId: string, limit: number): Promise<PlatformMessage[]>;
  /** The Lar's own public status line, beside her name. */
  setStatus(text: string): Promise<void>;
};

// ---------------------------------------------------------------------------------------------------
// Options and the world.

export type DiscordWorldOptions = {
  /** The entity's zone for the dates read_history shows. Default Europe/Istanbul. */
  timeZone?: string;
  /** The clock read_history measures ages against. Default Date.now. */
  nowMs?: () => number;
  token: string;
  ownerUserId: string;
  /** The owner's alias in places ("discord:dm:<alias>"). Defaults to "owner", the entity config's usual alias. */
  ownerAlias?: string;
  /** Channel ids the Lar lives in. */
  rooms: string[];
  /** The channel id of the summoner's window. Left out, the world has no window. */
  windowChannel?: string;
  /**
   * N9: ask Discord for the summoner's presence (a privileged intent the developer portal must allow). Left out, no
   * presence: a bot that asks for an intent the portal refuses cannot log in at all.
   */
  presence?: boolean;
  /** JSON file holding the alias map. Platform ids live only here. */
  aliasesPath: string;
  /**
   * The Lar's contacts file (contacts.json): the people, besides the summoner, who may write to the Lar in a direct message.
   * Read fresh on each direct message. Without a path, or without a file, nobody but the summoner may write in a DM.
   */
  contactsPath?: string;
  /** Where message refs are kept so they mean the same message after a restart. Defaults beside the aliases file. */
  refsPath?: string;
  /** Where the day's count of pictures from others is kept, so a restart does not reset it. Defaults beside the aliases file. */
  picturesPath?: string;
  /** Injected in tests; the discord.js client is used when absent. */
  client?: PlatformClient;
  debounceMs?: number;
  maxDebounceMs?: number;
  /** While the summoner is typing, a burst may wait this long after its first message instead. Default 10_000. */
  typingMaxDebounceMs?: number;
  guestLimit?: { messages: number; perMs: number };
  botExchangeLimit?: number;
  /** A quiet this long between bot messages in a channel ends the run; the next bot message starts a new one. */
  botQuietMs?: number;
  /** Fetches the pictures and files people send. Injected in tests; the global fetch is used when absent. */
  fetch?: typeof fetch;
  /**
   * Where files that are not pictures are saved: the Lar's home folder (they go in its files/ subfolder) and how she sees
   * that folder. Left out, such a file is named in the event and not saved.
   */
  filesHome?: FilesHome;
  /**
   * N10: her voice, when voice.json is beside discord.json. Voice messages people send are heard through it, and a say
   * with asVoice is sent as one. Left out, a voice message is named and not heard, and asVoice is refused.
   */
  voice?: VoiceMessages;
};

const WORLD_ID = "discord";
const PLACE_PREFIX = "discord:";
const DISCORD_LIMIT = 2000;
const HISTORY_DEFAULT = 20;
const HISTORY_MAX = 50;
const ERROR_TEXT_MAX = 200;
const EMOJI_MAX = 32;
/** Discord's own attachment hosts. A picture is fetched from these over https and from nowhere else. */
const PICTURE_HOSTS: ReadonlySet<string> = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const PICTURE_FETCH_MS = 20_000;
/** A voice message bigger than this is not fetched; the same cap as pictures. */
const VOICE_BYTES_MAX = 8 * 1024 * 1024;
/** Pictures and files from anyone but the summoner that the Lar may ask for in one local day. */
const OTHERS_PICTURES_PER_DAY = 50;
/** A loop is a quick back-and-forth. Bots quiet in a channel this long are not in one, so a room of Lares alone is not held for good. */
const BOT_QUIET_MS = 10 * 60 * 1000;
/** Typing shows on the now board this long after the last keypress. */
const TYPING_FRESH_MS = 10_000;
/** A burst waits at least this long after the summoner's last typing signal. */
const TYPING_HOLD_MS = 4_000;
/** New refs are written once, this long after the first of them. */
const REFS_SAVE_DELAY_MS = 1_000;
/** Numbers left unused across a restart, so a ref already shown is never given to another message. */
const REFS_SEQ_GAP = 1_000;
/** How often "typing" is shown again while her turn runs. */
const TYPING_PULSE_MS = 8_000;
/** A turn that never reports its end stops showing typing after this long. */
const TYPING_PULSE_MAX_MS = 15 * 60_000;

/** One line in the body's log for a refused direct message, at most once an hour per author. Never the words or an id. */
const REFUSED_DM_LOG = "[discord] a DM from someone who is not a contact was not admitted.";
const REFUSED_DM_LOG_MS = 60 * 60 * 1000;

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
  messages: Array<{
    ref: string;
    text: string;
    attachments: EventAttachment[];
    mentionsHer: boolean;
    replyToRef: string | null;
    /** One line per attachment the Lar keeps (or cannot keep), when the message has attachments. */
    kept: Promise<string[]> | null;
  }>;
  flooded: boolean;
  loopCeiling: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type EventAttachment = { name: string; contentType: string | null; url: string };

type Target = { ok: true; channelId: string } | { ok: false; receipt: Receipt };

export function createDiscordWorld(options: DiscordWorldOptions): World {
  const nowMs = options.nowMs ?? Date.now;
  if (!options.token) throw new Error("Discord world needs a bot token.");
  if (!options.ownerUserId) throw new Error("Discord world needs the owner's user id.");
  if (!options.aliasesPath) throw new Error("Discord world needs a path for its aliases file.");
  const roomIds = new Set(options.rooms.filter((id) => id.length > 0));

  const debounceMs = options.debounceMs ?? 1500;
  const maxDebounceMs = options.maxDebounceMs ?? 5000;
  const typingMaxDebounceMs = options.typingMaxDebounceMs ?? 10_000;
  const guestLimit = options.guestLimit ?? { messages: 4, perMs: 20_000 };
  const botExchangeLimit = options.botExchangeLimit ?? 4;
  const botQuietMs = options.botQuietMs ?? BOT_QUIET_MS;

  const ownerAlias = options.ownerAlias ?? OWNER_ALIAS;
  const aliases: AliasStore = createAliasStore({ path: options.aliasesPath, ownerUserId: options.ownerUserId, ownerAlias });
  const client: PlatformClient = options.client ?? createDiscordJsClient({ presence: options.presence === true });

  let status: Status = "idle";
  let statusReason = "not started";
  let self: { id: string; name: string } | null = null;
  let emitter: ((event: WorldEvent) => void) | null = null;
  let handlersRegistered = false;
  let liveRoomSlugs: string[] = [];
  let unreachableRooms = 0;
  /** The Lar's public status line, kept so a reconnect sets it again. */
  let lastStatus: string | null = null;
  /** The summoner's presence as last seen after login; null until the first presence event. */
  let presenceState: {
    status: PlatformPresence["status"];
    game: { name: string; sinceMs: number } | null;
    music: { track: string; artist: string } | null;
  } | null = null;
  /** The summoner's voice channel, for the now board. */
  let voiceChannel: string | null = null;
  /** Where the summoner was last seen typing, and when. */
  let typingState: { place: string; atMs: number } | null = null;
  /** Direct-message places where a turn runs and "typing" is shown, with the timer for the next showing. */
  const typingPulses = new Map<string, { timer: ReturnType<typeof setTimeout> | null; startedAtMs: number }>();
  /** Places whose last turnRunning(true) still stands, including one whose channel is still being opened. */
  const typingWanted = new Set<string>();
  /** The edit time last handled for each message id, oldest dropped first. */
  const lastEditAtMs = new Map<string, number>();

  // Opaque refs for messages. They are kept in a file beside the aliases, so a ref the entity remembers
  // means the same message after a restart. Only the newest MAX_KEPT_REFS are kept; numbers are never reused.
  const refsPath = options.refsPath ?? options.aliasesPath.replace(/\.json$/i, "") + ".refs.json";
  const picturesPath = options.picturesPath ?? options.aliasesPath.replace(/\.json$/i, "") + ".pictures.json";
  let pictureCount = readPictureCount(picturesPath);
  const messageRefs = new Map<string, { channelId: string; messageId: string }>();
  const refOfMessage = new Map<string, string>();
  let messageSeq = 0;
  {
    const stored = readRefs(refsPath);
    // After a crash the last second of new refs may be lost; the gap keeps a number already shown from being reused.
    messageSeq = existsSync(refsPath) ? stored.seq + REFS_SEQ_GAP : 0;
    for (const [ref, [channelId, messageId]] of Object.entries(stored.refs)) {
      messageRefs.set(ref, { channelId, messageId });
      refOfMessage.set(`${channelId}|${messageId}`, ref);
    }
  }
  let refsDirty = false;
  let refsTimer: ReturnType<typeof setTimeout> | null = null;
  function saveRefs(): void {
    if (refsTimer !== null) {
      clearTimeout(refsTimer);
      refsTimer = null;
    }
    refsDirty = false;
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
  function scheduleRefsSave(): void {
    refsDirty = true;
    if (refsTimer !== null) return;
    refsTimer = setTimeout(() => {
      refsTimer = null;
      saveRefs();
    }, REFS_SAVE_DELAY_MS);
  }
  const attachmentUrls = new Map<string, string>();
  const attachmentHandles = new Map<string, string>();
  let attachmentSeq = 0;
  const roomSlugs = new Map<string, string>();

  const pending = new Map<string, Pending>();
  /** Bursts that wait for their attachments to be fetched and kept; stop waits for them too. */
  const flushing = new Set<Promise<void>>();
  /** The body's way to keep pictures. Set at start. */
  let keeper: WorldBody | null = null;
  const guestHits = new Map<string, number[]>();
  /** When a refused direct message from each author was last logged. */
  const refusedDmLogged = new Map<string, number>();
  /** Message ids already handled, in arrival order, so a gateway resume cannot hand one over twice. */
  const handledIds = new Set<string>();
  /** Bot messages in a row per channel, and when the last one came. A person's message or a quiet gap ends the run. */
  const botRuns = new Map<string, { count: number; lastAtMs: number }>();
  /** How many times the summoner's emergency stop has turned on, so a voice message being made can tell. */
  let stopCount = 0;
  function countBotMessage(channelId: string, nowMs: number): number {
    const run = botRuns.get(channelId);
    const count = run !== undefined && nowMs - run.lastAtMs < botQuietMs ? run.count + 1 : 1;
    botRuns.set(channelId, { count, lastAtMs: nowMs });
    return count;
  }

  function refFor(channelId: string, messageId: string): string {
    const key = `${channelId}|${messageId}`;
    const known = refOfMessage.get(key);
    if (known) return known;
    messageSeq += 1;
    const ref = `m${messageSeq}`;
    refOfMessage.set(key, ref);
    messageRefs.set(ref, { channelId, messageId });
    scheduleRefsSave();
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

  /** True when the summoner's typing is what holds this burst open. */
  function beingTyped(burst: Pending, nowMs: number): boolean {
    if (burst.source !== "owner" || typingState === null) return false;
    return burst.place === `${PLACE_PREFIX}${typingState.place}` && nowMs - typingState.atMs < TYPING_HOLD_MS;
  }

  /** The longest a burst may wait after its first message. */
  function burstCapMs(burst: Pending, nowMs: number): number {
    return beingTyped(burst, nowMs) ? typingMaxDebounceMs : maxDebounceMs;
  }

  function arm(burst: Pending, nowMs: number): void {
    if (burst.timer) clearTimeout(burst.timer);
    const typed = beingTyped(burst, nowMs);
    const untilCap = burst.startedAtMs + (typed ? typingMaxDebounceMs : maxDebounceMs) - nowMs;
    const hold = typed && typingState !== null ? TYPING_HOLD_MS - (nowMs - typingState.atMs) : 0;
    const delay = Math.max(0, Math.min(typed ? Math.max(debounceMs, hold) : debounceMs, untilCap));
    burst.timer = setTimeout(() => flush(burst.key), delay);
  }

  /** Sends a burst on as one event. A burst with attachments still arriving waits for them; the world's stop waits too. */
  function flush(key: string): Promise<void> {
    const burst = pending.get(key);
    if (!burst) return Promise.resolve();
    if (burst.timer) clearTimeout(burst.timer);
    pending.delete(key);
    if (!burst.messages.some((message) => message.kept !== null)) {
      emitBurst(burst, []);
      return Promise.resolve();
    }
    const sending = Promise.all(burst.messages.map((message) => message.kept ?? Promise.resolve<string[]>([])))
      .then((lines) => emitBurst(burst, lines))
      .catch((error: unknown) => {
        console.error(`[discord] a burst could not be sent: ${error instanceof Error ? error.message : String(error)}`);
      });
    flushing.add(sending);
    void sending.finally(() => flushing.delete(sending));
    return sending;
  }

  function emitBurst(burst: Pending, lines: string[][]): void {
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
    // A burst the flood or loop limit held does not wake the Lar; the lines it leaves in her thread say so.
    if (burst.flooded || burst.loopCeiling) data.heldBy = "a burst";
    if (burst.bot) data.bot = true;
    emit({
      world: WORLD_ID,
      place: burst.place,
      actor: burst.actor,
      source: burst.source,
      text: burst.messages
        .map((message, index) => [message.text, ...(lines[index] ?? [])].filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n"),
      atMs: burst.startedAtMs,
      wake: !(burst.flooded || burst.loopCeiling),
      data,
    });
  }

  /** The contacts as the file says now. A missing file, or no path, is no contacts; a damaged one is none, with the problem. */
  function currentContacts(): { ids: string[]; problem?: string } {
    if (options.contactsPath === undefined) return { ids: [] };
    const load = readContacts(options.contactsPath);
    return load.problem === undefined ? { ids: load.contacts.discord } : { ids: [], problem: load.problem };
  }

  /** The now line's fact about who may write in a direct message, by alias. */
  function whoMayWrite(): string {
    const contacts = currentContacts();
    if (contacts.problem !== undefined) return "Your contacts file cannot be read, so only your summoner may write to you directly.";
    if (contacts.ids.length === 0) return "Nobody but your summoner may write to you directly.";
    const names = contacts.ids.map((id) => aliases.knownUserAlias(id) ?? "a person with no alias yet");
    return `Contacts who may write to you directly: ${names.join(", ")}.`;
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
    if (handledIds.has(message.id)) return;

    const nowMs = Date.now();
    // A direct message from anyone but the summoner and the contacts is not admitted: no event, alias, ref or flood count.
    if (message.channelKind === "dm" && !isOwner && !currentContacts().ids.includes(message.author.id)) {
      const last = refusedDmLogged.get(message.author.id);
      if (last === undefined || nowMs - last >= REFUSED_DM_LOG_MS) {
        refusedDmLogged.set(message.author.id, nowMs);
        console.log(REFUSED_DM_LOG);
      }
      return;
    }
    const actor = aliases.userAlias(message.author.id, message.author.displayName || "person");
    const placeAlias =
      message.channelKind === "dm"
        ? `dm:${actor}`
        : `room:${roomSlugOf(message.channelId, message.channelName)}`;
    const key = `${message.channelId}|${message.author.id}`;

    const flooded = !isOwner && !admitGuest(key, nowMs);
    let loopCeiling = false;
    if (message.author.bot) {
      loopCeiling = countBotMessage(message.channelId, nowMs) > botExchangeLimit;
    } else {
      botRuns.delete(message.channelId);
    }

    const ref = refFor(message.channelId, message.id);
    const entry = {
      ref,
      // A message the flood limit turned away is not fetched and not kept.
      kept: flooded ? null : keptLines(message.attachments, `${PLACE_PREFIX}${placeAlias}`, isOwner, nowMs, message.voice === true),
      text: readable(message.content, message.mentionedUsers),
      attachments: describeAttachments(message.attachments),
      mentionsHer: message.content.includes(`<@${self.id}>`) || message.content.includes(`<@!${self.id}>`),
      replyToRef: message.replyToMessageId ? refFor(message.channelId, message.replyToMessageId) : null,
    };

    const existing = pending.get(key);
    if (existing && nowMs - existing.startedAtMs >= burstCapMs(existing, nowMs)) void flush(key);
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
    // The id is remembered only once the message is admitted and queued, so a refused or failed one can come again (NB-2).
    handledIds.add(message.id);
    if (handledIds.size > HANDLED_IDS_CAP) {
      const oldest = handledIds.values().next().value as string;
      handledIds.delete(oldest);
    }
  }

  /** The world is ready to take an event: starting or connected, with an identity and somewhere to send it. */
  function liveWorld(): { emit: (event: WorldEvent) => void; self: { id: string; name: string } } | null {
    if ((status !== "starting" && status !== "connected") || !self || !emitter) return null;
    return { emit: emitter, self };
  }

  function ownerPlace(): string {
    return `${PLACE_PREFIX}dm:${ownerAlias}`;
  }

  /** "with nobody else there", "with 1 other there", "with N others there". */
  function othersPhrase(count: number): string {
    if (count === 0) return "with nobody else there";
    if (count === 1) return "with 1 other there";
    return `with ${count} others there`;
  }

  function rememberEdit(messageId: string, editedAtMs: number): void {
    lastEditAtMs.delete(messageId);
    lastEditAtMs.set(messageId, editedAtMs);
    while (lastEditAtMs.size > HANDLED_IDS_CAP) {
      const oldest = lastEditAtMs.keys().next().value as string;
      lastEditAtMs.delete(oldest);
    }
  }

  function statusWord(value: PlatformPresence["status"]): string {
    return value === "dnd" ? "do not disturb" : value;
  }

  /** A reaction makes a row only on a message she already has a ref for, in an admitted place. */
  function handleReaction(reaction: PlatformReaction): void {
    const live = liveWorld();
    if (!live) return;
    const ref = refOfMessage.get(`${reaction.channelId}|${reaction.messageId}`);
    if (!ref) return;
    if (reaction.channelKind === "room") {
      if (!roomIds.has(reaction.channelId)) return;
    } else if (reaction.channelKind === "dm") {
      const isOwner = reaction.userId === options.ownerUserId;
      if (!isOwner && !currentContacts().ids.includes(reaction.userId)) return;
    } else {
      return;
    }
    if (reaction.userId === live.self.id) return;
    const isOwner = reaction.userId === options.ownerUserId;
    const at = nowMs();
    if (!isOwner && !admitGuest(`${reaction.channelId}|${reaction.userId}`, at)) return;

    const actor = aliases.userAlias(reaction.userId, reaction.userDisplayName || "person");
    const place =
      reaction.channelKind === "dm"
        ? `dm:${actor}`
        : `room:${roomSlugOf(reaction.channelId, null)}`;
    const mine = reaction.messageAuthorId === live.self.id;
    const target = mine ? `your message ${ref}` : ref;
    const text = reaction.added
      ? `${actor} reacted ${reaction.emoji} to ${target}.`
      : `${actor} took back ${reaction.emoji} on ${target}.`;
    live.emit({
      world: WORLD_ID,
      place: `${PLACE_PREFIX}${place}`,
      actor,
      source: isOwner ? "owner" : "outside",
      text,
      atMs: at,
      wake: false,
      data: {
        sense: { kind: "reaction", ref, emoji: reaction.emoji, mine, added: reaction.added },
        messageRef: ref,
      },
    });
  }

  /** An edit makes a row only on a message she has a ref for, once per edit time. */
  function handleEdit(edit: PlatformEdit): void {
    const live = liveWorld();
    if (!live) return;
    const ref = refOfMessage.get(`${edit.channelId}|${edit.id}`);
    if (!ref) return;
    if (edit.editedAtMs === null) return;
    if (lastEditAtMs.get(edit.id) === edit.editedAtMs) return;
    if (edit.author.id === live.self.id) return;
    const isOwner = edit.author.id === options.ownerUserId;
    if (edit.channelKind === "room") {
      if (!roomIds.has(edit.channelId)) return;
    } else if (edit.channelKind === "dm") {
      if (!isOwner && !currentContacts().ids.includes(edit.author.id)) return;
    } else {
      return;
    }
    const at = nowMs();
    if (!isOwner && !admitGuest(`${edit.channelId}|${edit.author.id}`, at)) return;
    rememberEdit(edit.id, edit.editedAtMs);

    const actor = aliases.userAlias(edit.author.id, edit.author.displayName || "person");
    const place =
      edit.channelKind === "dm"
        ? `dm:${actor}`
        : `room:${roomSlugOf(edit.channelId, edit.channelName)}`;
    live.emit({
      world: WORLD_ID,
      place: `${PLACE_PREFIX}${place}`,
      actor,
      source: isOwner ? "owner" : "outside",
      text: `${actor} edited ${ref}: ${readable(edit.content, edit.mentionedUsers)}`,
      atMs: at,
      wake: !edit.author.bot,
      data: { messageRef: ref, edited: true },
    });
  }

  /** Only the summoner's presence, and only with the option on. The first one after login is the baseline. */
  function handlePresence(presence: PlatformPresence): void {
    const live = liveWorld();
    if (!live) return;
    if (presence.userId !== options.ownerUserId) return;
    if (options.presence !== true) return;
    const at = nowMs();
    if (presenceState === null) {
      // The first change after login: what Discord held before it is the baseline, when it held anything.
      const base = presence.before ?? presence;
      presenceState = {
        status: base.status,
        game: base.game === null ? null : { name: base.game, sinceMs: at },
        music: base.music,
      };
      if (!presence.before) return;
    }

    const previous = presenceState;
    const rows: Array<{ text: string; sense: Sense }> = [];
    if ((previous.game?.name ?? null) !== presence.game) {
      if (previous.game !== null) {
        rows.push({
          text: `Your summoner stopped playing ${previous.game.name}.`,
          sense: { kind: "game", game: previous.game.name, started: false },
        });
      }
      if (presence.game !== null) {
        rows.push({
          text: `Your summoner started playing ${presence.game}.`,
          sense: { kind: "game", game: presence.game, started: true },
        });
      }
    }
    if (previous.status !== presence.status) {
      const next = presence.status;
      if (next === "online") {
        const cameOnline = previous.status === "offline";
        rows.push({
          text: cameOnline ? "Your summoner came online." : "Your summoner is back online.",
          sense: { kind: "status", status: "online", cameOnline },
        });
      } else if (next === "idle") {
        rows.push({ text: "Your summoner went idle.", sense: { kind: "status", status: "idle", cameOnline: false } });
      } else if (next === "dnd") {
        rows.push({ text: "Your summoner set do not disturb.", sense: { kind: "status", status: "dnd", cameOnline: false } });
      } else {
        rows.push({ text: "Your summoner went offline.", sense: { kind: "status", status: "offline", cameOnline: false } });
      }
    }

    const game =
      presence.game === null
        ? null
        : previous.game?.name === presence.game
          ? previous.game
          : { name: presence.game, sinceMs: at };
    presenceState = { status: presence.status, game, music: presence.music };

    for (const row of rows) {
      live.emit({
        world: WORLD_ID,
        place: ownerPlace(),
        actor: ownerAlias,
        source: "body",
        text: row.text,
        atMs: at,
        wake: false,
        data: { sense: row.sense },
      });
    }
  }

  /** Only the summoner's voice state. Joins, leaves and moves are rows; a mute or deafen is nothing. */
  function handleVoice(voice: PlatformVoice): void {
    const live = liveWorld();
    if (!live) return;
    if (voice.userId !== options.ownerUserId) return;
    const at = nowMs();
    if (voice.before === null) {
      if (voice.after === null) return;
      voiceChannel = voice.after.channelName;
      live.emit({
        world: WORLD_ID,
        place: ownerPlace(),
        actor: ownerAlias,
        source: "body",
        text: `Your summoner joined the voice channel ${voice.after.channelName}, ${othersPhrase(voice.after.othersCount)}.`,
        atMs: at,
        wake: false,
        data: { sense: { kind: "voice", joined: true } },
      });
      return;
    }
    if (voice.after === null) {
      voiceChannel = null;
      live.emit({
        world: WORLD_ID,
        place: ownerPlace(),
        actor: ownerAlias,
        source: "body",
        text: `Your summoner left the voice channel ${voice.before.channelName}.`,
        atMs: at,
        wake: false,
        data: { sense: { kind: "voice", joined: false } },
      });
      return;
    }
    voiceChannel = voice.after.channelName;
    live.emit({
      world: WORLD_ID,
      place: ownerPlace(),
      actor: ownerAlias,
      source: "body",
      text: `Your summoner moved to the voice channel ${voice.after.channelName}, ${othersPhrase(voice.after.othersCount)}.`,
      atMs: at,
      wake: false,
    });
  }

  /** The summoner's typing in a place: it shows on the now board and holds her pending burst open. */
  function recordTyping(place: string, at: number): void {
    typingState = { place, atMs: at };
    const burstPlace = `${PLACE_PREFIX}${place}`;
    for (const burst of pending.values()) {
      if (burst.source === "owner" && burst.place === burstPlace) arm(burst, at);
    }
  }

  /** Only the summoner's typing, and only in an admitted place. It makes no row. */
  function handleTyping(typing: PlatformTyping): void {
    if (!liveWorld()) return;
    if (typing.userId !== options.ownerUserId) return;
    const at = nowMs();
    if (typing.channelKind === "dm") {
      recordTyping(`dm:${ownerAlias}`, at);
    } else if (typing.channelKind === "room" && roomIds.has(typing.channelId)) {
      recordTyping(`room:${roomSlugOf(typing.channelId, null)}`, at);
    }
  }

  function stopTypingPulse(place: string): void {
    typingWanted.delete(place);
    const pulse = typingPulses.get(place);
    if (!pulse) return;
    if (pulse.timer !== null) clearTimeout(pulse.timer);
    typingPulses.delete(place);
  }

  function showTyping(
    place: string,
    channelId: string,
    pulse: { timer: ReturnType<typeof setTimeout> | null; startedAtMs: number },
  ): void {
    if (typingPulses.get(place) !== pulse) return;
    const elapsed = nowMs() - pulse.startedAtMs;
    if (elapsed >= TYPING_PULSE_MAX_MS) {
      stopTypingPulse(place);
      return;
    }
    try {
      void client.sendTyping(channelId).catch(() => stopTypingPulse(place));
    } catch {
      stopTypingPulse(place);
      return;
    }
    pulse.timer = setTimeout(
      () => showTyping(place, channelId, pulse),
      Math.min(TYPING_PULSE_MS, TYPING_PULSE_MAX_MS - elapsed),
    );
  }

  /** Show "typing" at once and keep it up while a turn runs; a second true for a running place starts nothing new. */
  function setTurnTyping(place: string, running: boolean): void {
    if (!place.startsWith(`${PLACE_PREFIX}dm:`)) return;
    if (!running) {
      stopTypingPulse(place);
      return;
    }
    if (typingWanted.has(place)) return;
    const userId = aliases.userIdForAlias(place.slice(`${PLACE_PREFIX}dm:`.length));
    if (!userId) return;
    typingWanted.add(place);
    void client.openDm(userId).then(
      (channelId) => {
        if (!typingWanted.has(place)) return;
        const pulse = { timer: null as ReturnType<typeof setTimeout> | null, startedAtMs: nowMs() };
        typingPulses.set(place, pulse);
        showTyping(place, channelId, pulse);
      },
      () => {
        typingWanted.delete(place);
      },
    );
  }

  function stopAllTypingPulses(): void {
    for (const place of [...typingPulses.keys()]) stopTypingPulse(place);
    typingWanted.clear();
  }

  /**
   * Takes one place in today's count for a picture from anyone but the summoner. It counts when it is asked for, kept or
   * not, so a burst cannot fetch past the day's limit. False when the day's limit is reached.
   */
  function takeOthersPlace(nowMs: number): boolean {
    const day = localDay(nowMs);
    if (pictureCount.day !== day) pictureCount = { version: 1, day, others: 0 };
    if (pictureCount.others >= OTHERS_PICTURES_PER_DAY) return false;
    pictureCount = { version: 1, day, others: pictureCount.others + 1 };
    writeJsonAtomic(picturesPath, pictureCount);
    return true;
  }

  /**
   * One line per attachment: a picture kept on the shelf, a file saved in her home, a voice message heard or the reason
   * it was not. Null when there are none.
   */
  function keptLines(
    attachments: PlatformAttachment[],
    place: string,
    fromOwner: boolean,
    nowMs: number,
    voiceMessage = false,
  ): Promise<string[]> | null {
    if (attachments.length === 0) return null;
    const home = options.filesHome;
    return Promise.all(
      attachments.map(async (attachment) => {
        if (voiceMessage && isVoiceAttachment(attachment)) return heardLine(attachment, fromOwner, nowMs);
        const name = scrubIds(attachment.name);
        const picture = (attachment.contentType ?? "").startsWith("image/");
        if (!picture && home === undefined) return `[file: ${name} (not saved: you have no home folder for files)]`;
        if (!fromOwner && !takeOthersPlace(nowMs)) {
          return picture
            ? `[attachment: ${name} (not kept: today's picture limit for others is reached)]`
            : `[file: ${name} (not saved: today's limit for files from others is reached)]`;
        }
        return picture || home === undefined ? keepFromDiscord(attachment, place) : saveFromDiscord(attachment, home);
      }),
    );
  }

  /**
   * Fetches one voice message from Discord and hears it, never keeping the audio. Takes one of the day's places for a
   * message from anyone but the summoner, as a picture or a file does.
   */
  async function heardLine(attachment: PlatformAttachment, fromOwner: boolean, nowMs: number): Promise<string> {
    const known = typeof attachment.durationSecs === "number" && attachment.durationSecs > 0 ? attachment.durationSecs : undefined;
    const voice = options.voice;
    if (voice === undefined) return `${voiceMessageLabel(known)} (not heard: you have no voice organ)`;
    const resting = voice.resting();
    if (resting !== undefined) return `${voiceMessageLabel(known)} (not heard: ${resting})`;
    if (!fromOwner && !takeOthersPlace(nowMs)) {
      return `${voiceMessageLabel(known)} (not heard: today's limit for files from others is reached)`;
    }
    const fetched = await fetchAttachment(attachment.url, options.fetch ?? fetch, VOICE_BYTES_MAX);
    if (!fetched.ok) return `${voiceMessageLabel(known)} (not heard: ${fetched.reason})`;
    let heard: HeardVoiceMessage;
    try {
      heard = await voice.hear(fetched.bytes);
    } catch (error) {
      return `${voiceMessageLabel(known)} (not heard: ${error instanceof Error ? error.message : String(error)})`;
    }
    const seconds = heard.seconds > 0 ? heard.seconds : known;
    const label = voiceMessageLabel(seconds);
    if (heard.text.trim() === "") return `${label} (nothing was heard in it)`;
    const shortened =
      seconds !== undefined && heard.heardSeconds + 0.5 < seconds
        ? ` (only the first ${Math.round(heard.heardSeconds / 60)} min was heard)`
        : "";
    return `${label} ${heard.text}${shortened}`;
  }

  /** The label a voice message shows in an event or in read_history. */
  function voiceMessageLabel(seconds: number | undefined): string {
    return seconds === undefined ? "[voice message]" : `[voice message, ${Math.max(1, Math.round(seconds))} s]`;
  }

  function isVoiceAttachment(attachment: PlatformAttachment): boolean {
    return (attachment.contentType ?? "").toLowerCase().startsWith("audio/") || attachment.name.toLowerCase().endsWith(".ogg");
  }

  /** Fetches one picture from Discord and puts it on the shelf. Never rejects: a picture that is not kept says why. */
  async function keepFromDiscord(attachment: PlatformAttachment, place: string): Promise<string> {
    const name = scrubIds(attachment.name);
    const fetched = await fetchAttachment(attachment.url, options.fetch ?? fetch, PICTURE_BYTES_MAX);
    if (!fetched.ok) return `[attachment: ${name} (not kept: ${fetched.reason})]`;
    if (keeper === null) return `[attachment: ${name} (not kept: the Lar has no shelf right now)]`;
    try {
      const ref = keeper.keepPicture({ bytes: fetched.bytes, name, from: { world: WORLD_ID, place } });
      return `[picture ${ref.id}: ${ref.name}, ${Math.ceil(ref.bytes / 1024)} KB]`;
    } catch (error) {
      return `[attachment: ${name} (not kept: ${cleanError(error)})]`;
    }
  }

  /** Fetches one file from Discord and saves it in her home. Never rejects: a file that is not saved says why. */
  async function saveFromDiscord(attachment: PlatformAttachment, home: FilesHome): Promise<string> {
    const name = scrubIds(attachment.name);
    const fetched = await fetchAttachment(attachment.url, options.fetch ?? fetch, FILE_BYTES_MAX);
    if (!fetched.ok) return `[file: ${name} (not saved: ${fetched.reason})]`;
    try {
      const saved = saveFile(home, name, fetched.bytes);
      return `[file: ${name}, ${sizeText(fetched.bytes.length)}, saved in your home at ${saved.shownAt}]`;
    } catch (error) {
      return `[file: ${name} (not saved: ${cleanError(error)})]`;
    }
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
      // NIT-1: marked retryable, so the turn loop retries it like a thrown read.
      return { ...refused("history_failed", cleanError(error), `Could not read ${place}.`), retryable: true };
    }
    const lines = [...messages].reverse().map((message) => {
      const voiceMessage = message.voice === true;
      const body = [
        readable(message.content, message.mentionedUsers),
        ...message.attachments.map((attachment) =>
          voiceMessage && isVoiceAttachment(attachment)
            ? voiceMessageLabel(
                typeof attachment.durationSecs === "number" && attachment.durationSecs > 0 ? attachment.durationSecs : undefined,
              )
            : `[attachment: ${scrubIds(attachment.name)}]`,
        ),
      ]
        .filter(Boolean)
        .join(" ");
      const ref = refFor(message.channelId, message.id);
      const replyTo = message.replyToMessageId ? refFor(message.channelId, message.replyToMessageId) : null;
      const shownRef = replyTo ? `${ref}, replying to ${replyTo}` : ref;
      return `[${clock(message.createdAtMs, nowMs(), options.timeZone)} ${authorLabel(message.author)} ${shownRef}] ${body || "(no text)"}`;
    });
    return {
      ok: true,
      summary: `Read ${lines.length} message(s) from ${place}.`,
      data: { lines, count: lines.length },
    };
  }

  /**
   * A say with asVoice: the whole text made into a voice message and sent with no text. Every refusal says plainly that
   * nothing was sent; the words are never split, and mentions are not turned into pings.
   */
  async function sayVoice(place: string, text: string, sayOptions: { replyTo?: string; files?: SayFile[] } | undefined): Promise<Receipt> {
    if (sayOptions?.files !== undefined && sayOptions.files.length > 0) {
      return refused(
        "voice_with_files",
        "a voice message carries nothing else, so pictures cannot go with it.",
        "A voice message cannot carry pictures, so nothing was sent.",
      );
    }
    const voice = options.voice;
    if (voice === undefined) {
      return refused(
        "no_voice",
        "you have no voice here: voice.json is not set up beside discord.json.",
        "You have no voice set up, so nothing was sent.",
      );
    }
    const target = await resolveTarget(place);
    if (!target.ok) return target.receipt;
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
    const resting = voice.resting();
    if (resting !== undefined) {
      return refused("voice_resting", `${resting}, so nothing was sent.`, "Your voice is resting, so nothing was sent.");
    }
    const stopsBefore = stopCount;
    let made: MadeVoiceMessage;
    try {
      made = await voice.make(text);
    } catch (error) {
      if (error instanceof VoiceError) {
        const code =
          error.kind === "resting"
            ? "voice_resting"
            : error.kind === "nothing_to_say"
              ? "nothing_to_say"
              : error.kind === "too_long"
                ? "too_long"
                : "voice_failed";
        const summary =
          error.kind === "resting"
            ? "Your voice is resting, so nothing was sent."
            : error.kind === "nothing_to_say"
              ? "Nothing in that can be spoken aloud, so nothing was sent."
              : error.kind === "too_long"
                ? "That is too long for a voice message, so nothing was sent."
                : "Your voice failed, so nothing was sent.";
        return refused(code, `${error.message}; nothing was sent.`, summary);
      }
      return refused("voice_failed", cleanError(error), "Your voice failed, so nothing was sent.");
    }
    if (stopCount > stopsBefore && place !== ownerPlace()) {
      return refused(
        "stopped",
        "your summoner's emergency stop turned on while the voice message was being made; nothing was sent.",
        "The stop turned on, so nothing was sent.",
      );
    }
    let sentId: string;
    try {
      sentId = await client.sendVoice(
        target.channelId,
        { bytes: made.ogg, durationSecs: made.seconds, waveform: made.waveform },
        replyId,
      );
    } catch (error) {
      return refused("send_failed", cleanError(error), `Could not deliver to ${place}.`, { refs: [] });
    }
    const ref = refFor(target.channelId, sentId);
    countBotMessage(target.channelId, Date.now());
    const seconds = Math.max(1, Math.round(made.seconds));
    const leftOut = made.skipped.length > 0 ? ` Left out of speech: ${made.skipped.join("; ")}.` : "";
    return {
      ok: true,
      summary: `Delivered to ${place} as a voice message, ${seconds} s.${leftOut}`,
      data: { refs: [ref], voice: { seconds: made.seconds, skipped: made.skipped } },
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

  const world: World & { turnRunning(place: string, running: boolean): void } = {
    id: WORLD_ID,

    async start(emit, worldBody) {
      if (status === "starting" || status === "connected") throw new Error("Discord world is already started.");
      emitter = emit;
      keeper = worldBody;
      status = "starting";
      statusReason = "connecting";
      if (!handlersRegistered) {
        client.onMessage(handleMessage);
        client.onReaction(handleReaction);
        client.onEdit(handleEdit);
        client.onPresence(handlePresence);
        client.onVoice(handleVoice);
        client.onTyping(handleTyping);
        handlersRegistered = true;
      }
      let identity: { id: string; displayName: string };
      try {
        identity = await client.login(options.token);
      } catch (error) {
        const reason = cleanError(error);
        status = "failed";
        statusReason = `login failed: ${reason}`;
        if (options.presence === true && /disallowed intents/i.test(reason)) {
          throw new Error(
            'Discord login failed: Discord refused the presence intent. Switch on Presence Intent for this bot in the Discord developer portal, or remove "presence" from discord.json.',
          );
        }
        throw new Error(`Discord login failed: ${reason}`);
      }
      self = { id: identity.id, name: identity.displayName || "Natalis" };
      presenceState = null;
      voiceChannel = null;
      typingState = null;
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
      if (lastStatus !== null) {
        try {
          await client.setStatus(lastStatus);
        } catch (error) {
          console.error(`[discord] the status could not be set again after login: ${cleanError(error)}`);
        }
      }
    },

    async stop() {
      if (status !== "starting" && status !== "connected") return;
      // No message is taken from here on. What is pending goes out, pictures and all, before the emitter closes.
      status = "stopped";
      statusReason = "stopped";
      stopAllTypingPulses();
      if (refsDirty) saveRefs();
      for (const key of [...pending.keys()]) void flush(key);
      await Promise.allSettled([...flushing]);
      emitter = null;
      self = null;
      await client.logout();
    },

    async say(place, text, sayOptions) {
      const down = notConnected();
      if (down) return down;
      if (sayOptions?.asVoice === true) return sayVoice(place, text, sayOptions);
      const target = await resolveTarget(place);
      if (!target.ok) return target.receipt;
      // "@alias" of a person the Lar knows becomes a real mention; nobody else can be pinged.
      const mentionUserIds = new Set<string>();
      const withMentions = text.replace(/(^|[^\p{L}\p{N}_@.])@([\p{L}\p{N}][\p{L}\p{N}-]*)/gu, (whole, lead: string, alias: string) => {
        const id = aliases.userIdForAlias(alias.toLowerCase());
        if (!id) return whole;
        mentionUserIds.add(id);
        return `${lead}<@${id}>`;
      });
      const chunks = splitForDiscord(withMentions);
      if (chunks.length === 0) return refused("empty_text", "there is no text to send.", "There was nothing to send.");
      const pictures = readOutboundFiles(sayOptions?.files ?? []);
      if (!pictures.ok) return pictures.receipt;

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
          // The pictures go with the first message only.
          const files = index === 0 && pictures.files.length > 0 ? pictures.files : undefined;
          const sentId = await client.send(target.channelId, chunk, index === 0 ? replyId : null, [...mentionUserIds], files);
          refs.push(refFor(target.channelId, sentId));
          countBotMessage(target.channelId, Date.now());
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

    turnRunning(place, running) {
      setTurnTyping(place, running);
    },

    onStop() {
      stopCount += 1;
    },

    async status(text) {
      if (status !== "connected" || !self) throw new Error(`Discord is not connected (${statusReason}).`);
      lastStatus = text;
      try {
        await client.setStatus(text);
      } catch (error) {
        throw new Error(`Discord would not set the status: ${cleanError(error)}`);
      }
    },

    tools() {
      return [reactTool, readHistoryTool];
    },

    about() {
      const rooms = liveRoomSlugs.map((slug) => `${PLACE_PREFIX}room:${slug}`);
      const voiceLine =
        options.voice === undefined
          ? ""
          : " Voice messages people send you reach you as machine transcripts, which can be wrong. A say with as_voice: true sends your words as a voice message in your own voice.";
      return (
        `Discord: direct messages with your summoner at ${PLACE_PREFIX}dm:${ownerAlias}, and with people who write to you` +
        (rooms.length === 0 ? "." : `; rooms: ${rooms.join(", ")}.`) +
        voiceLine
      );
    },

    now() {
      let line: string;
      if (status === "connected" && self) {
        const at = nowMs();
        const places = [`dm:${ownerAlias}`, ...liveRoomSlugs.map((slug) => `room:${slug}`)];
        const missing = unreachableRooms > 0 ? ` ${unreachableRooms} room(s) not reachable.` : "";
        const first = `Discord: connected as ${self.name}; places: ${places.join(", ")}.${missing} ${whoMayWrite()}`;
        const parts: string[] = [];
        if (options.presence === true) {
          if (presenceState === null) {
            parts.push("presence not known yet");
          } else {
            parts.push(statusWord(presenceState.status));
            if (presenceState.game !== null) {
              parts.push(`playing ${presenceState.game.name} for ${formatDuration(at - presenceState.game.sinceMs)}`);
            }
            if (presenceState.music !== null) {
              parts.push(`listening to ${presenceState.music.track} by ${presenceState.music.artist}`);
            }
          }
        }
        if (voiceChannel !== null) parts.push(`in the voice channel ${voiceChannel}`);
        if (typingState !== null && at - typingState.atMs < TYPING_FRESH_MS) {
          parts.push(`typing in ${typingState.place} now`);
        }
        line = parts.length === 0 ? first : `${first}\nYour summoner: ${parts.join(", ")}.`;
      } else {
        line = `Discord: not connected (${statusReason}).`;
      }
      const resting = options.voice?.resting();
      if (resting !== undefined) line += `\nVoice messages: not now (${resting}).`;
      return line;
    },
  };

  // The summoner's window is a channel of its own: a copy of what the Lar does, never a say. Without a channel there is no show.
  const windowChannel = options.windowChannel;
  if (windowChannel !== undefined && windowChannel !== "") {
    world.show = async (text) => {
      if (status !== "connected" || !self) throw new Error(`Discord is not connected (${statusReason}).`);
      for (const part of splitForDiscord(text)) {
        try {
          await client.send(windowChannel, part, null, []);
        } catch (error) {
          throw new Error(`Discord would not take the window message: ${cleanError(error)}`);
        }
      }
    };
  }
  return world;
}

// ---------------------------------------------------------------------------------------------------
// Helpers.

const PICTURE_EXTENSION: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * The shelf pictures a say carries, read from the files the body holds. A file the body already read and checked brings
 * its own bytes, and those are sent instead of reading the path again. A file that cannot be read refuses the say.
 */
function readOutboundFiles(files: SayFile[]): { ok: true; files: OutboundFile[] } | { ok: false; receipt: Receipt } {
  const out: OutboundFile[] = [];
  for (const file of files) {
    let bytes: Uint8Array;
    if (file.bytes !== undefined) {
      bytes = file.bytes;
    } else {
      try {
        bytes = readFileSync(file.path);
      } catch {
        return {
          ok: false,
          receipt: refused("picture_unreadable", `the picture ${file.name} could not be read from the shelf, so nothing was sent.`, "A picture could not be read, so nothing was sent."),
        };
      }
    }
    out.push({ name: safeFileName(file.name, file.mime), bytes });
  }
  return { ok: true, files: out };
}

/** A file name Discord takes: letters, digits, dash and underscore, with the picture type's extension or the name's own. */
function safeFileName(name: string, mime: string): string {
  const pictureExtension = PICTURE_EXTENSION[mime];
  if (pictureExtension !== undefined) {
    const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
    return `${stem || "picture"}.${pictureExtension}`;
  }
  const { stem, extension } = plainFileName(name);
  return `${stem}${extension || ".bin"}`;
}

/**
 * An attachment's bytes from one of Discord's attachment hosts, or the plain reason it was not fetched. The address is
 * checked before anything is requested: https, one of the two hosts, no port, no userinfo. Redirects are not
 * followed, the size is capped at maxBytes while reading, and it never rejects.
 */
async function fetchAttachment(
  url: string,
  fetchFn: typeof fetch,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, reason: "its address is not usable" };
  }
  if (
    target.protocol !== "https:" ||
    !PICTURE_HOSTS.has(target.hostname) ||
    target.port !== "" ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return { ok: false, reason: "it is not on Discord's attachment hosts" };
  }
  const tooLarge = { ok: false as const, reason: `it is larger than ${maxBytes / 1024 / 1024} MiB` };
  try {
    const response = await fetchFn(target.href, { redirect: "manual", signal: AbortSignal.timeout(PICTURE_FETCH_MS) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { ok: false, reason: "Discord redirected the download, which is not followed" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, reason: `Discord answered ${response.status}` };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      return tooLarge;
    }
    const reader = response.body?.getReader();
    if (reader === undefined) return { ok: false, reason: "nothing came back" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return tooLarge;
      }
      chunks.push(value);
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
  } catch {
    return { ok: false, reason: "it could not be downloaded" };
  }
}

/** A size the way a person reads it: KB under a megabyte, MB with one decimal above. */
function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Long digit runs are platform ids (snowflakes are 17 to 20 digits). They never reach the entity. */
function scrubIds(text: string): string {
  return text.replace(/(?<!\d)\d{17,20}(?!\d)/g, "[id]");
}

/** A message's time as read_history shows it: alone for today, with its date and age for an earlier day. */
function clock(ms: number, nowMs: number = Date.now(), timeZone?: string): string {
  return whenText(ms, nowMs, timeZone);
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
      durationSecs: attachment.duration ?? null,
    })),
    mentionedUsers: [...message.mentions.users.values()].map((user) => ({ id: user.id, displayName: user.displayName })),
    replyToMessageId: message.reference?.messageId ?? null,
    voice: message.flags.has(MessageFlags.IsVoiceMessage),
  };
}

/** The payload that sends one voice message: an Ogg file with its duration and waveform, flagged, with no text. */
export function voiceMessagePayload(voice: OutboundVoice, replyToMessageId: string | null) {
  return {
    files: [
      new AttachmentBuilder(Buffer.from(voice.bytes), { name: "voice-message.ogg" })
        .setDuration(voice.durationSecs)
        .setWaveform(voice.waveform),
    ],
    flags: MessageFlags.IsVoiceMessage as const,
    allowedMentions: { parse: [], repliedUser: false },
    ...(replyToMessageId ? { reply: { messageReference: replyToMessageId, failIfNotExists: false } } : {}),
  };
}

function logDropped(what: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`[discord] ${what}: ${reason}`);
}

async function fetchedMessage(message: Message | PartialMessage): Promise<Message> {
  return message.partial ? await message.fetch() : (message as Message);
}

async function toPlatformReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  added: boolean,
): Promise<PlatformReaction | null> {
  try {
    const full = reaction.partial ? await reaction.fetch() : (reaction as MessageReaction);
    const message = await fetchedMessage(full.message);
    const base = toPlatformMessage(message);
    return {
      channelId: base.channelId,
      channelKind: base.channelKind,
      messageId: base.id,
      messageAuthorId: message.author?.id ?? null,
      userId: user.id,
      userDisplayName: user.displayName || user.username || "person",
      userBot: user.bot ?? false,
      emoji: full.emoji.id ? `:${full.emoji.name ?? "emoji"}:` : (full.emoji.name ?? ""),
      added,
    };
  } catch (error) {
    logDropped("a reaction could not be read", error);
    return null;
  }
}

function presenceParts(presence: Presence): Omit<PlatformPresence, "userId" | "before"> {
  const status: PlatformPresence["status"] =
    presence.status === "online" || presence.status === "idle" || presence.status === "dnd" ? presence.status : "offline";
  const game = presence.activities.find((activity) => activity.type === ActivityType.Playing);
  const spotify = presence.activities.find((activity) => activity.type === ActivityType.Listening && activity.name === "Spotify");
  return {
    status,
    game: game ? game.name : null,
    music: spotify ? { track: spotify.details ?? "", artist: spotify.state ?? "" } : null,
  };
}

function toPlatformPresence(old: Presence | null, presence: Presence): PlatformPresence {
  return { userId: presence.userId, ...presenceParts(presence), before: old ? presenceParts(old) : null };
}

function toPlatformVoice(before: VoiceState, after: VoiceState): PlatformVoice | null {
  if (before.channelId === after.channelId) return null;
  const beforeChannel = before.channel;
  const afterChannel = after.channel;
  const othersCount =
    afterChannel === null ? 0 : afterChannel.members.size - (afterChannel.members.has(after.id) ? 1 : 0);
  return {
    userId: after.id,
    before: beforeChannel ? { channelName: beforeChannel.name } : null,
    after: afterChannel ? { channelName: afterChannel.name, othersCount } : null,
  };
}

function toPlatformTyping(typing: Typing): PlatformTyping {
  const channel = typing.channel;
  const channelKind: PlatformTyping["channelKind"] =
    channel.type === ChannelType.DM ? "dm" : channel.type === ChannelType.GuildText ? "room" : "other";
  return { userId: typing.user.id, channelId: channel.id, channelKind };
}

export function createDiscordJsClient(options: { presence: boolean }): PlatformClient {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageTyping,
      GatewayIntentBits.DirectMessageTyping,
      ...(options.presence ? [GatewayIntentBits.GuildPresences] : []),
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
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
    onReaction(handler) {
      client.on(Events.MessageReactionAdd, (reaction, user) => {
        void toPlatformReaction(reaction, user, true).then((mapped) => {
          if (mapped) handler(mapped);
        });
      });
      client.on(Events.MessageReactionRemove, (reaction, user) => {
        void toPlatformReaction(reaction, user, false).then((mapped) => {
          if (mapped) handler(mapped);
        });
      });
    },
    onEdit(handler) {
      client.on(Events.MessageUpdate, (_old, message) => {
        void (async () => {
          let full: Message;
          try {
            full = await fetchedMessage(message);
          } catch (error) {
            logDropped("an edit could not be read", error);
            return;
          }
          handler({ ...toPlatformMessage(full), editedAtMs: full.editedTimestamp ?? null });
        })();
      });
    },
    onPresence(handler) {
      client.on(Events.PresenceUpdate, (old, presence) => handler(toPlatformPresence(old, presence)));
    },
    onVoice(handler) {
      client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        const voice = toPlatformVoice(oldState, newState);
        if (voice) handler(voice);
      });
    },
    onTyping(handler) {
      client.on(Events.TypingStart, (typing) => handler(toPlatformTyping(typing)));
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
    async send(channelId, text, replyToMessageId, mentionUserIds = [], files = []) {
      const channel = await sendable(channelId);
      const sent = await channel.send({
        content: text,
        allowedMentions: { parse: [], users: mentionUserIds, repliedUser: false },
        ...(replyToMessageId ? { reply: { messageReference: replyToMessageId, failIfNotExists: false } } : {}),
        ...(files.length > 0 ? { files: files.map((file) => ({ attachment: Buffer.from(file.bytes), name: file.name })) } : {}),
      });
      return sent.id;
    },
    async sendVoice(channelId, voice, replyToMessageId) {
      const channel = await sendable(channelId);
      const sent = await channel.send(voiceMessagePayload(voice, replyToMessageId));
      return sent.id;
    },
    async sendTyping(channelId) {
      const channel = await sendable(channelId);
      await channel.sendTyping();
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
    async setStatus(text) {
      const user = client.user;
      if (!user) throw new Error("not connected");
      user.setPresence({
        status: "online",
        activities: [{ type: ActivityType.Custom, name: "Custom Status", state: text }],
      });
    },
  };
}
