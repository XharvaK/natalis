// The Domus world: the Lar's game (The Sims 4). The game's helper, on the summoner's PC, speaks wire contract v1 to
// this listener, so the helper and the game mod change nothing. The world reports what the game shows, offers the
// game's choices by ref, carries the Lar's requested acts out to the helper, and keeps what came back as notes.
// It never chooses an act, ranks needs, or writes rules about what the Lar should do.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { World, WorldBody, WorldEvent } from "../../contracts.js";
import type { AttachmentNow } from "./body.js";
import { gameActTool, type GameActContext } from "./game-act.js";
import { isStopOn } from "../../entity/stop.js";
import { expireDue, pendingCounts, syncActs, type ThreadNote, withdrawUndone, withholdForStop } from "./acts.js";
import { choicesSignature, optionsOf, renderView, viewBrief } from "./options.js";
import {
  checkSnapshot, expireSnapshots, gameSnapshotTool, openSnapshots, SNAPSHOT_PICTURE_NAME, SNAPSHOT_STATUS, settleFailed,
  settleTaken, type SnapshotContext, withdrawSnapshots,
} from "./snapshot.js";
import {
  admitObservation, forgetInDomusFile, forgetText, HeartbeatBook, inTransaction, markSpanUndoneIn, openDomusDb, pruneObservations,
} from "./store.js";
import {
  BODY_LIMIT, canonicalJson, DOMUS_WORLD_ID, gameThreadOf, MIN_TOKEN_BYTES, observationDigest, parseActSync, parseFeed,
  parseHeartbeat, parseObservation, parseSnapshot, parseUndo, type ParsedObservation, SNAPSHOT_BODY_LIMIT, tokenProblem,
  tokensEqual, WireError,
} from "./wire.js";

export const DOMUS_DEFAULT_HOST = "127.0.0.1";
export const DOMUS_DEFAULT_PORT = 3711;
/** Requested acts and plan steps are looked at this often, between the helper's syncs. */
const SWEEP_MS = 5_000;
/** Observations are pruned this often (see pruneObservations). */
const PRUNE_MS = 10 * 60_000;

export type DomusWorldOptions = {
  /** The Lar's folder: its domus/ folder holds the database and the heartbeat state. */
  dir: string;
  /** The helper's token (the value, read by run from the environment). At least 32 bytes; checked at start. */
  token: string;
  host?: string;
  port?: number;
  /** The world's clock. Defaults to Date.now. */
  nowMs?: () => number;
  /** Every other token the body holds (the bot token, the model key). The helper's token must differ from each. */
  otherTokens?: readonly string[];
};

export interface DomusWorld extends World {
  /** Where the listener is bound (the real port, when 0 was asked for); null when it is not listening. */
  listeningAddress(): { host: string; port: number } | null;
  /** The Lar's forget of words: erases them from the game's store, running or not. Returns how many rows were erased. */
  forget(words: string[]): number;
}

const TOKEN_MESSAGE: Record<"missing" | "too_short" | "matches_other", string> = {
  missing: "The Domus helper token is missing, so the listener is not started.",
  too_short: `The Domus helper token must be at least ${MIN_TOKEN_BYTES} bytes, so the listener is not started.`,
  matches_other: "The Domus helper token equals another token this body holds; use a different one. The listener is not started.",
};

const ROUTES = new Set([
  "/domus/observation", "/domus/heartbeat", "/domus/acts/sync", "/domus/snapshot", "/domus/feed", "/domus/undo",
]);

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

/** The request's body, or "too_large" once it passes the limit (the rest is read and dropped). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      total += chunk.length;
      if (total > limit) {
        over = true;
        chunks.length = 0;
        resolve("too_large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on("close", () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

/** The JSON body, when it is sent as application/json and parses; undefined otherwise (the route then answers invalid_body). */
function jsonBody(req: IncomingMessage, raw: Buffer): unknown {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json" || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(new Error(`The Domus listener could not listen on ${host}:${port} (${error.code ?? "error"}).`));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/** The view key of every game view (WorldEvent.view): an older one on a game thread shows its brief in her turn. */
export const GAME_VIEW = "domus";

/** An admitted view becomes one event on its game thread: outside text (the game's), with the choices and their refs. */
function observationEvent(parsed: ParsedObservation, attachment: AttachmentNow, lastChoices: string | undefined): WorldEvent {
  const thread = gameThreadOf(parsed.fields.world);
  const alias = thread.slice(DOMUS_WORLD_ID.length + 1);
  const options = optionsOf(parsed.options ?? []);
  const data: Record<string, unknown> = {
    observationId: parsed.observationId,
    world: parsed.fields.world,
    seq: parsed.fields.seq,
    sourceTimeMs: parsed.fields.sourceTimeMs,
    expiresAtMs: parsed.fields.expiresAtMs,
    ...(parsed.options?.length ? { options: parsed.options } : {}),
    ...(parsed.optionsCut ? { optionsCut: parsed.optionsCut } : {}),
  };
  return {
    world: DOMUS_WORLD_ID,
    place: thread,
    thread,
    actor: "game",
    source: "outside",
    text: renderView({
      world: alias, percepts: parsed.percepts, options, portrait: parsed.normalized.portrait, attachment, lastChoices, optionsCut: parsed.optionsCut,
    }),
    data,
    atMs: parsed.fields.sourceTimeMs,
    wake: true,
    view: GAME_VIEW,
    brief: viewBrief(parsed.percepts),
  };
}

/** The game thread hears once that the game stopped being attached (the helper said so, or went quiet). */
function detachedEvent(thread: string, atMs: number): WorldEvent {
  return { world: DOMUS_WORLD_ID, place: thread, thread, source: "body", text: "The game is no longer attached.", data: { attached: false }, atMs, wake: false };
}

function noteEvent(note: ThreadNote, atMs: number): WorldEvent {
  return { world: DOMUS_WORLD_ID, place: note.thread, thread: note.thread, source: "body", text: note.text, data: note.data, atMs, wake: note.wake };
}

/** Creates the Domus world. Nothing listens until start(); start() checks the token and opens the Lar's Domus folder. */
export function createDomusWorld(options: DomusWorldOptions): DomusWorld {
  const host = options.host ?? DOMUS_DEFAULT_HOST;
  const port = options.port ?? DOMUS_DEFAULT_PORT;
  const nowMs = options.nowMs ?? (() => Date.now());
  const others = [...(options.otherTokens ?? [])];

  let db: DatabaseSync | null = null;
  let book: HeartbeatBook | null = null;
  let server: Server | null = null;
  let emitter: ((event: WorldEvent) => void) | null = null;
  let sweep: ReturnType<typeof setInterval> | null = null;
  let bound: { host: string; port: number } | null = null;
  let lastPruneMs = 0;
  /** The body's way to keep pictures on the shelf. Set at start; a picture the helper sends is kept through it. */
  let keeper: WorldBody | null = null;
  /** The helper session the game was last seen attached under (restored from the state file at start). */
  let lastAttachedSession: string | undefined;
  /** Whether the game thread was already told of the current detach. */
  let detachNoticed = false;
  /** The world the newest admitted view came from; the detach notice goes to its game thread. */
  let lastWorld: string | undefined;
  /** The choices of the last view rendered on each game thread, so a view with the same choices says so instead of listing them again. */
  const choicesShown = new Map<string, string>();

  const deliver = (event: WorldEvent): void => {
    if (!emitter) return;
    try {
      emitter(event);
    } catch (error) {
      console.error(`[domus] a world event was refused: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** What the game_act tool reads on each call: null while the world is not running. */
  const open = (): GameActContext => {
    const current = db;
    const heartbeats = book;
    if (!current || !heartbeats) return null;
    return {
      db: current,
      nowMs,
      attachedSession: (at: number) => heartbeats.attachedSession(at),
      lastAttachedMs: () => heartbeats.lastAttachedAt(),
    };
  };

  /** Whether the game is attached at this moment, as a view or a receipt says it. */
  const attachmentAt = (at: number): AttachmentNow => {
    const heartbeats = requireBook();
    if (heartbeats.attachedSession(at) !== undefined) return { attached: true };
    return { attached: false, lastAttachedMs: heartbeats.lastAttachedAt(), nowMs: at };
  };

  /** Once per detach: when the attached session stops being attached, the game thread hears it one time. */
  function checkAttachment(now: number): void {
    const heartbeats = book;
    if (!heartbeats) return;
    const attached = heartbeats.attachedSession(now);
    if (attached !== undefined) {
      lastAttachedSession = attached;
      detachNoticed = false;
      return;
    }
    if (lastAttachedSession === undefined || detachNoticed) return;
    detachNoticed = true;
    const world = heartbeats.worldOf(lastAttachedSession) ?? lastWorld;
    if (world === undefined) {
      console.error("[domus] the game stopped being attached, but no world is known for its thread; the notice was not given.");
      return;
    }
    deliver(detachedEvent(gameThreadOf(world), now));
  }

  /** What the game_snapshot tool reads on each call: null while the world is not running. */
  const openSnapshot = (): SnapshotContext => {
    const current = db;
    const heartbeats = book;
    if (!current || !heartbeats) return null;
    return { db: current, nowMs, attachedSession: (at: number) => heartbeats.attachedSession(at) };
  };

  function observationRoute(body: unknown, res: ServerResponse): void {
    const now = nowMs();
    const parsed = parseObservation(body, now);
    const result = admitObservation(requireDb(), {
      observationId: parsed.observationId,
      digest: observationDigest(parsed.normalized),
      thread: gameThreadOf(parsed.fields.world),
      world: parsed.fields.world,
      branch: parsed.fields.branch,
      session: parsed.fields.session,
      attachment: parsed.fields.attachment,
      body: parsed.fields.body,
      snapshot: parsed.fields.snapshot,
      seq: parsed.fields.seq,
      sourceTimeMs: parsed.fields.sourceTimeMs,
      expiresAtMs: parsed.fields.expiresAtMs,
      receiptTimeMs: now,
      lineageClass: parsed.fields.lineageClass,
      payloadJson: canonicalJson(parsed.normalized),
    });
    if (result.status === "conflict") {
      send(res, 409, { error: "observation_conflict" });
      return;
    }
    send(res, result.status === "admitted" ? 202 : 200, {
      status: result.status,
      observation_id: parsed.observationId,
      receipt_time_ms: result.receiptTimeMs,
    });
    if (result.status === "admitted") {
      lastWorld = parsed.fields.world;
      const thread = gameThreadOf(parsed.fields.world);
      deliver(observationEvent(parsed, attachmentAt(now), choicesShown.get(thread)));
      choicesShown.set(thread, choicesSignature(optionsOf(parsed.options ?? [])));
    }
  }

  function heartbeatRoute(body: unknown, res: ServerResponse): void {
    const parsed = parseHeartbeat(body);
    const now = nowMs();
    requireBook().record(parsed.helperSession, {
      sentAtMs: parsed.sentAtMs,
      attached: parsed.attached,
      ...(parsed.probeVersion ? { probeVersion: parsed.probeVersion } : {}),
      ...(parsed.world ? { world: parsed.world } : {}),
    }, now);
    checkAttachment(now);
    send(res, 200, { status: "ok" });
  }

  function actsSyncRoute(body: unknown, res: ServerResponse): void {
    const parsed = parseActSync(body);
    const now = nowMs();
    // The summoner's stop reaches the game too: what was requested before it is withdrawn, not handed over.
    const stopped = isStopOn(options.dir);
    const withheld = stopped ? withholdForStop(requireDb(), now) : [];
    const pictures = stopped ? withdrawSnapshots(requireDb(), now) : expireSnapshots(requireDb(), now);
    const result = syncActs(requireDb(), { attachment: parsed.helperSession, events: parsed.events, nowMs: now });
    const snapshots = stopped ? [] : openSnapshots(requireDb(), { helperSession: parsed.helperSession, nowMs: now });
    for (const note of withheld) deliver(noteEvent(note, now));
    for (const note of pictures) deliver(noteEvent(note, now));
    send(res, 200, { status: "ok", applied: result.applied, acts: result.acts, planned: result.planned, snapshots });
    for (const note of result.notes) deliver(noteEvent(note, now));
  }

  function undoRoute(body: unknown, res: ServerResponse): void {
    const parsed = parseUndo(body);
    const now = nowMs();
    const thread = gameThreadOf(parsed.world);
    const span = { thread, ...parsed };
    // The views are undone and the acts and plan steps chosen on them withdrawn, in one transaction.
    const db = requireDb();
    const { observations, withdrawn } = inTransaction(db, () => ({
      observations: markSpanUndoneIn(db, span, now),
      withdrawn: withdrawUndone(db, span, now),
    }));
    send(res, 200, { status: "ok", observations, supports: 0, assertions: 0, episodes: 0, journal: 0 });
    deliver({
      world: DOMUS_WORLD_ID,
      place: thread,
      thread,
      source: "body",
      text: `The game went back to ${new Date(parsed.afterSourceTimeMs).toISOString()}. What happened there after that time did not happen: ${observations} observation(s) were undone.`,
      data: { reason: parsed.reason, observations, afterSourceTimeMs: parsed.afterSourceTimeMs },
      atMs: now,
      wake: false,
    });
    for (const note of withdrawn) deliver(noteEvent(note, now));
  }

  /** The helper's answer to a picture request: the picture goes on the shelf and the request is marked taken, or the reason is kept. */
  function snapshotRoute(body: unknown, res: ServerResponse): void {
    const parsed = parseSnapshot(body);
    const now = nowMs();
    const checked = checkSnapshot(requireDb(), {
      helperSession: parsed.helperSession,
      snapshotId: parsed.snapshotId,
      ...(parsed.pngBase64 !== undefined ? { pngBase64: parsed.pngBase64 } : {}),
      ...(parsed.failed !== undefined ? { failed: parsed.failed } : {}),
    });
    if (!checked.ok) {
      send(res, SNAPSHOT_STATUS[checked.code], { error: checked.code });
      return;
    }
    if (parsed.failed !== undefined) {
      const note = settleFailed(requireDb(), { snapshotId: parsed.snapshotId, failed: parsed.failed, thread: checked.thread, nowMs: now });
      send(res, 200, { status: "ok" });
      deliver(noteEvent(note, now));
      return;
    }
    const shelf = keeper;
    if (shelf === null || checked.bytes === undefined) {
      send(res, SNAPSHOT_STATUS.snapshots_unavailable, { error: "snapshots_unavailable" });
      return;
    }
    let picture: { id: string };
    try {
      picture = shelf.keepPicture({ bytes: checked.bytes, name: SNAPSHOT_PICTURE_NAME, from: { world: DOMUS_WORLD_ID, place: checked.thread } });
    } catch {
      send(res, SNAPSHOT_STATUS.write_failed, { error: "write_failed" });
      return;
    }
    const note = settleTaken(requireDb(), { snapshotId: parsed.snapshotId, thread: checked.thread, pictureId: picture.id, nowMs: now });
    send(res, 200, { status: "ok" });
    deliver(noteEvent(note, now));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const presented = req.headers["x-domus-token"];
      const token = typeof presented === "string" ? presented : "";
      if (!token || !tokensEqual(token, options.token) || others.some((other) => other !== "" && tokensEqual(token, other))) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const path = new URL(req.url ?? "/", "http://listener").pathname;
      if (req.method !== "POST" || !ROUTES.has(path)) {
        req.resume();
        send(res, 404, { error: "not_found" });
        return;
      }
      const raw = await readBody(req, path === "/domus/snapshot" ? SNAPSHOT_BODY_LIMIT : BODY_LIMIT);
      if (raw === "too_large") {
        send(res, 413, { error: "payload_too_large" });
        return;
      }
      const body = jsonBody(req, raw);
      switch (path) {
        case "/domus/observation": return observationRoute(body, res);
        case "/domus/heartbeat": return heartbeatRoute(body, res);
        case "/domus/acts/sync": return actsSyncRoute(body, res);
        case "/domus/undo": return undoRoute(body, res);
        case "/domus/feed": {
          parseFeed(body);
          send(res, 200, { status: "ok", items: [], marks: [] });
          return;
        }
        case "/domus/snapshot": return snapshotRoute(body, res);
      }
    } catch (error) {
      if (error instanceof WireError) {
        send(res, error.status, { error: error.code });
        return;
      }
      internalError(res, error);
    }
  }

  /** The answer to an error nothing else caught: one log line, and a 500 if the reply has not started. Never throws. */
  function internalError(res: ServerResponse, error: unknown): void {
    console.error(`[domus] a request failed: ${error instanceof Error ? error.message : String(error)}`);
    try {
      if (!res.headersSent) send(res, 500, { error: "internal" });
      else res.end();
    } catch {
      // The reply cannot be written; the log line above is the record.
    }
  }

  function requireDb(): DatabaseSync {
    if (!db) throw new Error("The Domus world is not running.");
    return db;
  }

  function requireBook(): HeartbeatBook {
    if (!book) throw new Error("The Domus world is not running.");
    return book;
  }

  function sweepNow(): void {
    if (!db) return;
    try {
      const now = nowMs();
      checkAttachment(now);
      if (isStopOn(options.dir)) for (const note of withholdForStop(db, now)) deliver(noteEvent(note, now));
      for (const note of expireDue(db, now)) deliver(noteEvent(note, now));
      for (const note of isStopOn(options.dir) ? withdrawSnapshots(db, now) : expireSnapshots(db, now)) deliver(noteEvent(note, now));
      if (now - lastPruneMs >= PRUNE_MS) {
        lastPruneMs = now;
        pruneObservations(db, now);
      }
    } catch (error) {
      console.error(`[domus] the timed pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    id: DOMUS_WORLD_ID,

    async start(emit, worldBody) {
      if (server) throw new Error("The Domus world is already started.");
      const problem = tokenProblem(options.token, others);
      if (problem) throw new Error(TOKEN_MESSAGE[problem]);
      db = openDomusDb(options.dir);
      try {
        book = new HeartbeatBook(options.dir);
      } catch (error) {
        db.close();
        db = null;
        throw error;
      }
      emitter = emit;
      keeper = worldBody;
      const latest = book?.latest();
      lastAttachedSession = latest?.attached === true ? latest.session : undefined;
      detachNoticed = false;
      const listener = createServer((req, res) => {
        handle(req, res).catch((error: unknown) => internalError(res, error));
      });
      try {
        await listen(listener, host, port);
      } catch (error) {
        emitter = null;
        db.close();
        db = null;
        book = null;
        throw error;
      }
      server = listener;
      const address = listener.address();
      bound = typeof address === "object" && address !== null ? { host, port: address.port } : { host, port };
      lastPruneMs = nowMs();
      sweep = setInterval(sweepNow, SWEEP_MS);
      sweep.unref();
    },

    async stop() {
      if (!server) return;
      if (sweep) clearInterval(sweep);
      sweep = null;
      emitter = null;
      keeper = null;
      const closing = server;
      server = null;
      bound = null;
      await new Promise<void>((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections();
      });
      db?.close();
      db = null;
      book = null;
    },

    async say(place) {
      return {
        ok: false,
        summary: `Nothing was sent to ${place}: the game takes no words. You act in it with game_act.`,
        refused: { code: "no_words", reason: "The game takes no words from you; act in it with game_act." },
      };
    },

    tools() {
      return [gameActTool(open), gameSnapshotTool(openSnapshot)];
    },

    about() {
      return "The Sims 4 (Domus): your household's game, at domus:<world>, while your summoner's helper is attached.";
    },

    now() {
      if (!db || !book) return "Domus: not running.";
      const at = nowMs();
      const latest = book.latest();
      const pending = pendingCounts(db, at);
      let line: string;
      if (!latest) line = "Domus: the game is not attached; no helper has reported yet.";
      else if (book.attachedAt(at)) line = "Domus: the game is attached.";
      else {
        const since = latest.attached ? latest.receivedAtMs : latest.changedAtMs;
        line = `Domus: the game is not attached since ${new Date(since).toISOString()}.`;
      }
      if (pending.requested > 0) line += ` ${pending.requested} requested act(s) wait for the game.`;
      return line;
    },

    listeningAddress() {
      return bound;
    },

    forget(words) {
      return db ? forgetText(db, words) : forgetInDomusFile(options.dir, words);
    },
  };
}
