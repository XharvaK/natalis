// The Kantus world: the Lar's DAW studio. Kantus.exe on the summoner's PC speaks the studio wire to a bridge, and the
// bridge is handed to this world as a StudioLink, so the world itself needs no live DAW to be tested. The world reports
// what the studio shows, reads the synced Capabilities/ sheets on this host, runs read-only and analytic studio ops,
// asks before it changes anything, and keeps the Lar's words in an outbox while the studio is closed.
//
// The body keeps no judgment here: the ops are the studio's own, and the tool descriptions say what each group does.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImagePart, Receipt, SayFile, SayResult, Tool, ToolContext, World, WorldBody, WorldEvent } from "../../contracts.js";
import { outwardHoldWords } from "../../entity/privacy.js";
import { writeFileAtomic } from "../../fsutil/write-atomic.js";
import { KANTUS_FOLDER, MAX_READ_LINES, openCapabilities, type CapabilitiesStore } from "./capabilities-store.js";
import { KANTUS_DEFAULT_HOST, KANTUS_DEFAULT_PORT } from "./file.js";
import {
  isActOp, isAnalyzeOp, isReadOp, KANTUS_PLACE, KANTUS_WORLD_ID, LARGE_BODY_LIMIT, MIN_TOKEN_BYTES, tokenProblem,
  type StudioEvent, type StudioLink, type StudioReply, type StudioStatus,
} from "./wire.js";

export { KANTUS_PLACE, KANTUS_WORLD_ID };
/** The file the Lar's words wait in while the studio is detached: <lar>/kantus/outbox.json. */
export const OUTBOX_FILE = "outbox.json";
/** The most messages the outbox keeps. Past it, a say is refused rather than dropping older words. */
export const OUTBOX_MAX = 200;
/** The most bytes the outbox keeps, pictures included; past it, a say is refused rather than filling the disk. */
export const OUTBOX_BYTES_MAX = 64 * 1024 * 1024;
/** The outbox's own version, so a later build can read a file an older one wrote. */
const OUTBOX_VERSION = 1;
/** The most evidence pictures one analysis may hand back. */
const EVIDENCE_MAX = 8;
/** The channel the bridge reads a say on. */
const SAY_CHANNEL = "say";
/** The channel one CommandService request travels on. */
const COMMAND_CHANNEL = "command";
/** The channel an analysis request travels on. */
const ANALYSIS_CHANNEL = "analysis";
/** The channel the Ask Card travels on, and comes back on. */
const ASK_CHANNEL = "ask";
/** The channel a Stage 2 overview travels back to Kantus.exe on. */
const CAPABILITIES_CHANNEL = "capabilities";
/** The channel the summoner's stop travels on. */
const STOP_CHANNEL = "stop";

export type KantusWorldOptions = {
  /** The Lar's folder: its kantus/ folder holds the outbox and the synced capabilities. */
  dir: string;
  /** The studio's token (the value, read by run from the environment). At least 32 bytes; checked at start. */
  token: string;
  /** Where the bridge will listen. Read by the later listener; the world itself does not listen. */
  host?: string;
  port?: number;
  /** The world's clock. Defaults to Date.now. */
  nowMs?: () => number;
  /** Every other token the body holds (the model key, the bot token, the helper's). The studio's token must differ. */
  otherTokens?: readonly string[];
  /** The bridge to Kantus.exe. Without one the studio reads as detached and the cached Capabilities stay readable. */
  link?: StudioLink;
  /** Whether the model can see pictures. Only then do evidence PNGs go to it; they are kept on the shelf either way. */
  vision?: boolean;
};

export interface KantusWorld extends World {
  /** The folder the synced Capabilities/ sheets live in. */
  readonly capabilitiesRoot: string;
  /** What the bridge will listen on. The listener itself is built by a later task. */
  bridgeAddress(): { host: string; port: number };
  /** Delivers the words queued while the studio was detached, oldest first. Returns how many were sent. */
  flushOutbox(): Promise<number>;
}

/** One say waiting for the studio. */
type QueuedSay = { id: string; atMs: number; text: string; replyTo?: string; files?: QueuedFile[] };

/** One file waiting with a say: its name and type, and its bytes as base64, as Kantus.exe reads them. */
type QueuedFile = { name: string; mime: string; base64: string };

const TOKEN_MESSAGE: Record<"missing" | "too_short" | "matches_other", string> = {
  missing: "The Kantus studio token is missing, so the world is not started.",
  too_short: `The Kantus studio token must be at least ${MIN_TOKEN_BYTES} bytes, so the world is not started.`,
  matches_other: "The Kantus studio token equals another token this body holds; use a different one. The world is not started.",
};

function refused(code: string, reason: string, summary = reason): Receipt {
  return { ok: false, summary, refused: { code, reason } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Creates the Kantus world. Nothing listens; start() checks the token and opens the Lar's kantus/ folder. */
export function createKantusWorld(options: KantusWorldOptions): KantusWorld {
  const nowMs = options.nowMs ?? (() => Date.now());
  const others = [...(options.otherTokens ?? [])];
  const caps: CapabilitiesStore = openCapabilities(options.dir);
  const outboxPath = join(options.dir, KANTUS_FOLDER, OUTBOX_FILE);
  const link = options.link;

  let emitter: ((event: WorldEvent) => void) | null = null;
  let keeper: WorldBody | null = null;
  let started = false;
  let unsubscribe: (() => void) | undefined;
  /** The requests sent to the studio and not yet answered, so the summoner's stop can end them all. */
  const inflight = new Set<AbortController>();
  /** The flush in progress, so a say and an attach event never send the same queued words twice. */
  let flushing: Promise<number> | null = null;

  const deliver = (event: WorldEvent): void => {
    if (!emitter) return;
    try {
      emitter(event);
    } catch (error) {
      console.error(`[kantus] a world event was refused: ${messageOf(error)}`);
    }
  };

  /** What the studio is doing now; a link that cannot say reads as detached rather than stopping the board. */
  function statusNow(): StudioStatus {
    if (!link) return { attached: false };
    try {
      return link.status();
    } catch (error) {
      console.error(`[kantus] the studio's status could not be read: ${messageOf(error)}`);
      return { attached: false };
    }
  }

  /** One request to the studio, ended by the summoner's stop as it happens. Never throws. */
  async function rpc(channel: string, payload: Record<string, unknown>): Promise<StudioReply> {
    const current = link;
    if (!current) return { ok: false, code: "studio_detached", reason: "No bridge to Kantus.exe is open, so nothing was asked." };
    const controller = new AbortController();
    inflight.add(controller);
    try {
      return await current.send(channel, payload, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, code: "stopped", reason: "The emergency stop ended the request to the studio." };
      }
      return { ok: false, code: "studio_error", reason: `The studio did not answer (${messageOf(error)}).` };
    } finally {
      inflight.delete(controller);
    }
  }

  function readOutbox(): QueuedSay[] {
    if (!existsSync(outboxPath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(outboxPath, "utf8")) as unknown;
    } catch {
      throw new Error("The Kantus outbox file is damaged, so no words were sent or queued.");
    }
    const record = recordOf(parsed);
    if (record?.["version"] !== OUTBOX_VERSION || !Array.isArray(record["messages"])) {
      throw new Error("The Kantus outbox file is damaged, so no words were sent or queued.");
    }
    return record["messages"].map((item): QueuedSay => {
      const message = recordOf(item);
      if (message === undefined || typeof message["id"] !== "string" || typeof message["text"] !== "string" || typeof message["atMs"] !== "number") {
        throw new Error("The Kantus outbox file is damaged, so no words were sent or queued.");
      }
      const files = Array.isArray(message["files"]) ? message["files"] : undefined;
      return {
        id: message["id"], atMs: message["atMs"], text: message["text"],
        ...(typeof message["replyTo"] === "string" ? { replyTo: message["replyTo"] } : {}),
        ...(files === undefined ? {} : { files: files.map(queuedFile) }),
      };
    });
  }

  function queuedFile(item: unknown): QueuedFile {
    const file = recordOf(item);
    if (file === undefined || typeof file["name"] !== "string" || typeof file["mime"] !== "string" || typeof file["base64"] !== "string") {
      throw new Error("The Kantus outbox file is damaged, so no words were sent or queued.");
    }
    return { name: file["name"], mime: file["mime"], base64: file["base64"] };
  }

  function writeOutbox(messages: readonly QueuedSay[]): void {
    writeFileAtomic(outboxPath, JSON.stringify({ version: OUTBOX_VERSION, messages }, null, 2), { mkdir: true });
  }

  /** Keeps one say for the studio, and says why when it cannot. */
  function queueSay(input: { text: string; replyTo?: string; files?: QueuedFile[] }): { ok: true; id: string } | { ok: false; receipt: Receipt } {
    let pending: QueuedSay[];
    try {
      pending = readOutbox();
    } catch (error) {
      return { ok: false, receipt: refused("outbox_damaged", messageOf(error), "The outbox is damaged, so nothing was queued.") };
    }
    if (pending.length >= OUTBOX_MAX) {
      return {
        ok: false,
        receipt: refused("outbox_full", `The outbox already holds ${OUTBOX_MAX} messages from while the studio was closed.`, "The outbox is full, so nothing was queued."),
      };
    }
    const message: QueuedSay = {
      id: randomUUID(), atMs: nowMs(), text: input.text,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.files === undefined || input.files.length === 0 ? {} : { files: input.files }),
    };
    pending.push(message);
    const bytes = Buffer.byteLength(JSON.stringify({ version: OUTBOX_VERSION, messages: pending }), "utf8");
    if (bytes > OUTBOX_BYTES_MAX) {
      return {
        ok: false,
        receipt: refused("outbox_full", `The outbox would hold ${bytes} bytes, past its ${OUTBOX_BYTES_MAX} byte limit.`, "The outbox is full, so nothing was queued."),
      };
    }
    try {
      writeOutbox(pending);
    } catch (error) {
      return { ok: false, receipt: refused("outbox_failed", `The outbox could not be written (${messageOf(error)}).`, "The words could not be kept for later.") };
    }
    return { ok: true, id: message.id };
  }

  /** What the studio reads for one say: older queued words first, then this one. */
  function sayPayload(message: { text: string; replyTo?: string; files?: QueuedFile[] }): Record<string, unknown> {
    return {
      text: message.text,
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      ...(message.files === undefined || message.files.length === 0 ? {} : { files: message.files }),
    };
  }

  /** Sends what waited in the outbox, oldest first, and stops at the first word the studio does not take. */
  async function flushOnce(): Promise<number> {
    if (!statusNow().attached) return 0;
    let pending: QueuedSay[];
    try {
      pending = readOutbox();
    } catch (error) {
      console.error(`[kantus] ${messageOf(error)}`);
      return 0;
    }
    let sent = 0;
    const left: QueuedSay[] = [];
    for (const message of pending) {
      if (left.length > 0) {
        left.push(message);
        continue;
      }
      const reply = await rpc(SAY_CHANNEL, sayPayload(message));
      if (reply.ok) sent += 1;
      else left.push(message);
    }
    if (sent > 0) writeOutbox(left);
    return sent;
  }

  function flushOutbox(): Promise<number> {
    flushing ??= flushOnce().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  /** What the studio sends unasked: a change of attachment, or a note from the composer pane. */
  function handleStudioEvent(event: StudioEvent): void {
    const at = event.atMs ?? nowMs();
    if (event.channel === "attached" || event.channel === "detached") {
      const attached = event.channel === "attached";
      deliver({
        world: KANTUS_WORLD_ID, place: KANTUS_PLACE, thread: KANTUS_PLACE, source: "body",
        text: attached ? "Kantus studio is attached." : "Kantus studio is detached.",
        data: { attached }, atMs: at, wake: attached,
      });
      if (attached) {
        void flushOutbox().catch((error: unknown) => console.error(`[kantus] the outbox could not be sent: ${messageOf(error)}`));
      }
      return;
    }
    const text = event.payload["text"];
    if (typeof text !== "string" || text.trim() === "") return;
    deliver({
      world: KANTUS_WORLD_ID, place: KANTUS_PLACE, thread: KANTUS_PLACE, actor: "studio", source: "outside",
      text, data: event.payload, atMs: at, wake: event.payload["wake"] !== false,
    });
  }

  /** The refusal a detached studio gives: a read or an ask cannot be held open for a DAW that is not there. */
  function detached(): Receipt {
    return {
      ok: false,
      summary: "Kantus.exe is detached, so the studio could not be reached. The synced Capabilities/ sheets are still here with kantus_cap_read.",
      refused: { code: "studio_detached", reason: "no studio is attached right now" },
      letsTurnEnd: true,
    };
  }

  // -------------------------------------------------------------------------------------------------
  // Tools.

  function capRead(args: Record<string, unknown>): Receipt {
    const path = args["path"];
    if (typeof path !== "string" || path === "") {
      return refused("bad_args", "Give the sheet's path inside Capabilities/, such as Craft/Groove_And_Pocket.md.");
    }
    const query = args["query"];
    if (query !== undefined && typeof query !== "string") return refused("bad_args", "query must be text.");
    for (const key of ["offsetLine", "maxLines"] as const) {
      const value = args[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)) {
        return refused("bad_args", `${key} must be a whole number from 1.`);
      }
    }
    const read = caps.read(path, {
      ...(query === undefined ? {} : { query }),
      ...(args["offsetLine"] === undefined ? {} : { offsetLine: args["offsetLine"] as number }),
      ...(args["maxLines"] === undefined ? {} : { maxLines: args["maxLines"] as number }),
    });
    if (!read.ok) return refused(read.code, read.reason);
    const summary = read.matched !== undefined
      ? `${read.matched} ${read.matched === 1 ? "line" : "lines"} of ${read.path} hold the query; ${read.lines.length} shown.`
      : `Read ${read.lines.length} of ${read.totalLines} lines of ${read.path}${read.nextLine === undefined ? "." : `; more from line ${read.nextLine}.`}`;
    return {
      ok: true,
      summary,
      data: {
        path: read.path, totalLines: read.totalLines, lines: read.lines,
        ...(read.fromLine === undefined ? {} : { fromLine: read.fromLine }),
        ...(read.nextLine === undefined ? {} : { nextLine: read.nextLine }),
        ...(read.matched === undefined ? {} : { matched: read.matched }),
      },
    };
  }

  async function capWriteOverview(args: Record<string, unknown>): Promise<Receipt> {
    const path = args["path"];
    const text = args["text"];
    if (typeof path !== "string" || typeof text !== "string") {
      return refused("bad_args", "Give path (VST3/<Vendor>/<Plugin>/Overview.md) and the text of the overview.");
    }
    const written = caps.writeOverview(path, text);
    if (!written.ok) return refused(written.code, written.reason);
    if (!statusNow().attached) {
      return {
        ok: true,
        summary: `Wrote ${written.path} (${written.bytes} bytes). Kantus.exe is detached, so it reaches the studio at its next capabilities sync.`,
        data: { path: written.path, bytes: written.bytes, synced: false },
      };
    }
    const reply = await rpc(CAPABILITIES_CHANNEL, { op: "write", path: written.path, text });
    if (!reply.ok) {
      return {
        ok: true,
        summary: `Wrote ${written.path} (${written.bytes} bytes), but the studio did not take it (${reply.code}). It stays on this host for the next sync.`,
        data: { path: written.path, bytes: written.bytes, synced: false, studioError: reply.code },
      };
    }
    return {
      ok: true,
      summary: `Wrote ${written.path} (${written.bytes} bytes) and sent it to the studio.`,
      data: { path: written.path, bytes: written.bytes, synced: true },
    };
  }

  async function studioRead(args: Record<string, unknown>): Promise<Receipt> {
    if (!statusNow().attached) return detached();
    const op = args["op"];
    if (typeof op !== "string" || !isReadOp(op)) {
      return refused("unknown_op", "That is not a read-only studio op. kantus_read runs state.get, state.summary, session.arrangementSheet, session.scoreSheet, player.inspectRegion, player.listStyles, library.listPatches, plugin.listCatalog, plugin.listParams, plugin.listPresets, region.read, midi.list, chord.list, marker.list, comment.list, automation.getTrackMode, snapshot.list, render.status, arrange.getState and tool.get.");
    }
    const params = args["params"];
    if (params !== undefined && recordOf(params) === undefined) return refused("bad_args", "params must be an object.");
    const reply = await rpc(COMMAND_CHANNEL, { op, params: params ?? {} });
    if (!reply.ok) return refused(reply.code, reply.reason);
    return { ok: true, summary: `The studio answered ${op}.`, data: reply.data };
  }

  async function studioAnalyze(args: Record<string, unknown>): Promise<Receipt> {
    if (!statusNow().attached) return detached();
    const op = args["op"];
    if (typeof op !== "string" || !isAnalyzeOp(op)) {
      return refused("unknown_op", "That is not an analysis op. kantus_analyze runs analysis.measure, analysis.measureEdit, analysis.evaluate, analysis.lintScore, analysis.masking, analysis.renderEvidence and ui.screenshot.");
    }
    const params = args["params"];
    if (params !== undefined && recordOf(params) === undefined) return refused("bad_args", "params must be an object.");
    const reply = await rpc(ANALYSIS_CHANNEL, { op, params: params ?? {} });
    if (!reply.ok) return refused(reply.code, reply.reason);

    const data: Record<string, unknown> = { ...reply.data };
    const pictures: ImagePart[] = [];
    const kept: Array<{ id: string; name: string; bytes: number }> = [];
    for (const picture of evidenceOf(reply.data)) {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(picture.base64, "base64");
      } catch {
        continue;
      }
      if (bytes.length === 0) continue;
      if (keeper !== null) {
        try {
          const ref = keeper.keepPicture({ bytes, name: picture.name, from: { world: KANTUS_WORLD_ID, place: KANTUS_PLACE } });
          kept.push({ id: ref.id, name: ref.name, bytes: ref.bytes });
          if (options.vision === true) pictures.push({ type: "image", mime: ref.mime, dataBase64: picture.base64 });
        } catch (error) {
          data["pictureError"] = messageOf(error);
        }
      }
    }
    delete data["png_base64"];
    delete data["pngs"];
    if (kept.length > 0) data["pictures"] = kept;
    return {
      ok: true,
      summary: `The studio finished ${op}. Its numbers are in data${kept.length === 0 ? "." : `, and ${kept.length === 1 ? "its picture is" : "its pictures are"} on your shelf.`}`,
      data,
      ...(pictures.length === 0 ? {} : { images: pictures }),
    };
  }

  /** The PNGs a reply carries, whether as one png_base64 or as a list of them. */
  function evidenceOf(data: Record<string, unknown>): Array<{ base64: string; name: string }> {
    const found: Array<{ base64: string; name: string }> = [];
    const one = data["png_base64"];
    if (typeof one === "string" && one !== "") found.push({ base64: one, name: "evidence.png" });
    const many = data["pngs"];
    if (Array.isArray(many)) {
      for (const item of many) {
        const picture = recordOf(item);
        const base64 = picture?.["png_base64"] ?? picture?.["base64"];
        if (typeof base64 !== "string" || base64 === "") continue;
        const name = typeof picture?.["name"] === "string" && picture["name"].trim() !== "" ? picture["name"] : "evidence.png";
        found.push({ base64, name });
        if (found.length >= EVIDENCE_MAX) break;
      }
    }
    return found.slice(0, EVIDENCE_MAX);
  }

  async function studioAct(args: Record<string, unknown>): Promise<Receipt> {
    const status = statusNow();
    if (!status.attached) return detached();
    if (status.mode === "RO") return refused("read_only", "The studio is in RO mode, so nothing was changed. Reads and analyses still run.");
    if (status.mode === "STOP") return refused("studio_stopped", "The studio's STOP is on, so nothing was changed.");
    if (status.transport === "recording") return refused("recording", "The transport is recording, so nothing was changed.");
    const op = args["op"];
    if (typeof op !== "string" || !isActOp(op)) {
      return refused("unknown_op", "That is not a mutating studio op. kantus_act runs batch.apply, the snapshot, player, compose, midi, track, clip, region, plugin, mixer, automation, transport, cycle, marker and comment groups, library.loadPatch, ui.highlight, history.*, render.export and project.save.");
    }
    const params = args["params"];
    if (params !== undefined && recordOf(params) === undefined) return refused("bad_args", "params must be an object.");
    const reply = await rpc(COMMAND_CHANNEL, { op, params: params ?? {} });
    if (!reply.ok) return refused(reply.code, reply.reason);
    return { ok: true, summary: `The studio ran ${op}.`, data: reply.data };
  }

  async function askOwner(args: Record<string, unknown>): Promise<Receipt> {
    if (!statusNow().attached) return detached();
    const question = typeof args["question"] === "string" ? args["question"].trim() : "";
    if (question === "" || question.length > 400) return refused("bad_args", "question must be one line of 1 to 400 characters.");
    const options_ = args["options"];
    let choices: string[] | undefined;
    if (options_ !== undefined) {
      if (!Array.isArray(options_) || options_.length > 4 || options_.some((item) => typeof item !== "string" || item.trim() === "" || item.length > 80)) {
        return refused("bad_args", "options must be at most four short lines of text.");
      }
      choices = options_.map((item) => (item as string).trim());
    }
    const reply = await rpc(ASK_CHANNEL, { question, ...(choices === undefined ? {} : { options: choices }) });
    if (!reply.ok) return refused(reply.code, reply.reason);
    const answer = reply.data["answer"];
    return {
      ok: true,
      summary: typeof answer === "string" && answer !== "" ? `Your summoner answered: ${answer}` : "Your summoner answered, without words.",
      data: reply.data,
    };
  }

  function tool(name: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, unknown>) => Receipt | Promise<Receipt>, extra: Partial<Tool["spec"]> = {}): Tool {
    return {
      spec: { name, description, parameters, ...extra },
      async run(args: Record<string, unknown>, _context: ToolContext): Promise<Receipt> {
        return run(args);
      },
    };
  }

  // -------------------------------------------------------------------------------------------------

  return {
    id: KANTUS_WORLD_ID,
    capabilitiesRoot: caps.root,

    async start(emit, body) {
      if (started) throw new Error("The Kantus world is already started.");
      const problem = tokenProblem(options.token, others);
      if (problem) throw new Error(TOKEN_MESSAGE[problem]);
      mkdirSync(join(options.dir, KANTUS_FOLDER), { recursive: true });
      emitter = emit;
      keeper = body;
      started = true;
      if (link) unsubscribe = link.onEvent(handleStudioEvent);
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      emitter = null;
      keeper = null;
      started = false;
      for (const controller of inflight) controller.abort();
      inflight.clear();
    },

    async onStop() {
      for (const controller of inflight) controller.abort();
      inflight.clear();
      if (!link) return;
      try {
        await link.send(STOP_CHANNEL, { atMs: nowMs() });
      } catch (error) {
        console.error(`[kantus] the emergency stop did not reach the studio: ${messageOf(error)}`);
      }
    },

    async say(place, text, sayOptions): Promise<SayResult> {
      if (place !== KANTUS_PLACE) {
        return refused("no_place", `${place} is not the studio. Kantus has one place, ${KANTUS_PLACE}.`, "That is not the studio, so nothing was sent.");
      }
      if (!started) return refused("not_running", "The Kantus world is not running.", "The Kantus world is not running, so nothing was sent.");
      if (typeof text !== "string" || text.trim() === "") return refused("empty_text", "There are no words to send.");
      const files = sayOptions?.files ?? [];
      // The body's check of what leaves comes first, over the words and every file name.
      const hold = keeper?.outwardHold([text, ...files.map((file) => file.name)]);
      if (hold !== undefined) {
        const words = outwardHoldWords(hold, "the message");
        return { ok: false, summary: words.summary, refused: { code: words.code, reason: words.reason } };
      }
      if (sayOptions?.asVoice === true) {
        return {
          ok: false,
          summary: "Kantus studio chat carries text and pictures, not voice messages.",
          refused: { code: "no_voice", reason: "no_voice: kantus:studio has no voice channel." },
        };
      }
      const read = readSayFiles(files);
      if (!read.ok) return read.receipt;
      const message = {
        text,
        ...(sayOptions?.replyTo === undefined ? {} : { replyTo: sayOptions.replyTo }),
        ...(read.files.length === 0 ? {} : { files: read.files }),
      };

      if (statusNow().attached) {
        // Older words kept while the studio was closed go first, so the order she said them in is kept.
        await flushOutbox();
        const reply = await rpc(SAY_CHANNEL, sayPayload(message));
        if (reply.ok) {
          const ref = typeof reply.data["ref"] === "string" && reply.data["ref"] !== "" ? reply.data["ref"] : randomUUID();
          return {
            ok: true,
            summary: read.files.length === 0 ? "Said it in the studio." : "Said it in the studio, with the picture.",
            data: { refs: [ref] },
          };
        }
        const queued = queueSay(message);
        if (!queued.ok) return queued.receipt;
        return {
          ok: true,
          summary: "The studio went quiet before it answered, so your words wait in the outbox; they reach it when Kantus reconnects.",
          data: { refs: [queued.id], queued: true },
        };
      }

      const queued = queueSay(message);
      if (!queued.ok) return queued.receipt;
      return {
        ok: true,
        summary: "Kantus.exe is detached, so your words wait in the outbox; they reach the studio when it reconnects.",
        data: { refs: [queued.id], queued: true },
      };
    },

    async show(text) {
      if (!statusNow().attached) throw new Error("Kantus.exe is detached, so the studio cannot show anything.");
      const reply = await rpc("show", { text });
      if (!reply.ok) throw new Error(`The studio did not show it (${reply.code}): ${reply.reason}`);
    },

    turnRunning(place, running) {
      if (place !== KANTUS_PLACE || !link) return;
      void link.send("typing", { running }).catch((error: unknown) => {
        console.error(`[kantus] the typing state did not reach the studio: ${messageOf(error)}`);
      });
    },

    isOwnerPlace(place: string): boolean {
      return place === KANTUS_PLACE;
    },

    tools(): Tool[] {
      return [
        tool(
          "kantus_cap_read",
          "Read a synced Capabilities/ sheet from this host: a craft sheet, a playbook, a content index, a plugin overview. " +
            `It works while Kantus.exe is closed. Give a relative path and, for one word or phrase, a query; or read a block with ` +
            `offsetLine and maxLines (at most ${MAX_READ_LINES} lines a call, and the answer says where the next block starts).`,
          {
            type: "object",
            properties: {
              path: { type: "string", description: "The sheet's path inside Capabilities/, such as Craft/Groove_And_Pocket.md." },
              query: { type: "string", description: "Find the lines that hold this text, without case. Do not combine with offsetLine." },
              offsetLine: { type: "number", description: "The 1-based line to start at." },
              maxLines: { type: "number", description: "How many lines to read, at most 250." },
            },
            required: ["path"],
          },
          capRead,
          { effect: "read", safeWhenStopped: true },
        ),
        tool(
          "kantus_cap_write_overview",
          "Write a short overview of one plugin, at VST3/<Vendor>/<Plugin>/Overview.md in the synced Capabilities/. That is the " +
            "only path it writes, and it is sent back to the studio. Use it after reading the plugin's parameters, never in place of them.",
          {
            type: "object",
            properties: {
              path: { type: "string", description: "VST3/<Vendor>/<Plugin>/Overview.md." },
              text: { type: "string", description: "The overview's markdown, at most 32 KiB." },
            },
            required: ["path", "text"],
          },
          capWriteOverview,
          { effect: "write" },
        ),
        tool(
          "kantus_read",
          "Read the studio's own state: the project and the session sheets, a region, the patches and plugin catalogues, tracks' " +
            "automation mode, markers, comments, snapshots and render status. Read-only ops only. While Kantus.exe is closed it refuses, and the cached Capabilities/ sheets are still readable.",
          {
            type: "object",
            properties: {
              op: { type: "string", description: "A read-only CommandService op, such as state.get or session.scoreSheet." },
              params: { type: "object", description: "The op's own fields." },
            },
            required: ["op"],
          },
          studioRead,
          { effect: "read" },
        ),
        tool(
          "kantus_analyze",
          "Ask the studio to measure something and answer with numbers: loudness and true peak, masking between two parts, a " +
            "score check, an evaluation. An evidence picture comes back as a picture you see, and always stays on your shelf. Safe to repeat.",
          {
            type: "object",
            properties: {
              op: { type: "string", description: "analysis.measure, analysis.measureEdit, analysis.evaluate, analysis.lintScore, analysis.masking, analysis.renderEvidence or ui.screenshot." },
              params: { type: "object", description: "The op's own fields." },
            },
            required: ["op"],
          },
          studioAnalyze,
          { effect: "idempotent" },
        ),
        tool(
          "kantus_act",
          "Change something in the studio: play or stop the transport, load a patch, write MIDI, a clip, a region, a track, a " +
            "plugin or a mix move, undo, export, save. It refuses while the studio is in RO, while its STOP is on, and while the " +
            "transport is recording. Ask the summoner first with kantus_ask_owner when the change is not plainly wanted.",
          {
            type: "object",
            properties: {
              op: { type: "string", description: "A mutating CommandService op, such as transport.start or mixer.setTrim." },
              params: { type: "object", description: "The op's own fields." },
            },
            required: ["op"],
          },
          studioAct,
          { effect: "write" },
        ),
        tool(
          "kantus_ask_owner",
          "Ask your summoner a question in the studio's composer pane, with up to four short choices, and wait for the answer. " +
            "Use it before a change that cannot be undone, or when only they know what they want.",
          {
            type: "object",
            properties: {
              question: { type: "string", description: "One line, at most 400 characters." },
              options: { type: "array", items: { type: "string" }, description: "At most four short choices, each at most 80 characters." },
            },
            required: ["question"],
          },
          askOwner,
          { effect: "write" },
        ),
      ];
    },

    resting() {
      return !statusNow().attached;
    },

    now() {
      const status = statusNow();
      if (!status.attached) return "Kantus studio: detached (Windows DAW closed). Cached Capabilities/ available via kantus_cap_read.";
      return `Kantus studio: connected (mode: ${status.mode ?? "unknown"}, project: ${status.project ?? "none"}, transport: ${status.transport ?? "idle"}).`;
    },

    about() {
      return "Kantus is your summoner's DAW studio, connected at kantus:studio (your summoner's studio composer pane). The synced Capabilities/ sheets are readable even while Kantus.exe is closed.";
    },

    forget(words) {
      const needles = words.map((word) => word.trim().toLowerCase()).filter((word) => word !== "");
      if (needles.length === 0) return 0;
      const pending = readOutbox();
      const kept = pending.filter((message) => !needles.some((needle) => message.text.toLowerCase().includes(needle)));
      const erased = pending.length - kept.length;
      if (erased > 0) writeOutbox(kept);
      return erased;
    },

    bridgeAddress() {
      return { host: options.host ?? KANTUS_DEFAULT_HOST, port: options.port ?? KANTUS_DEFAULT_PORT };
    },

    flushOutbox,
  };
}

/** What a say carries to the studio: a picture's bytes go as base64, never its path. */
function readSayFiles(files: readonly SayFile[]): { ok: true; files: QueuedFile[] } | { ok: false; receipt: Receipt } {
  const out: QueuedFile[] = [];
  let total = 0;
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
          receipt: refused("picture_unreadable", `The picture ${file.name} could not be read, so nothing was sent.`, "A picture could not be read, so nothing was sent."),
        };
      }
    }
    total += bytes.length;
    if (total > LARGE_BODY_LIMIT) {
      return {
        ok: false,
        receipt: refused("pictures_too_large", "The pictures together are larger than one studio message allows, so nothing was sent.", "The pictures are too large, so nothing was sent."),
      };
    }
    out.push({ name: file.name, mime: file.mime, base64: Buffer.from(bytes).toString("base64") });
  }
  return { ok: true, files: out };
}
