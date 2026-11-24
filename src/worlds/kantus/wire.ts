// The Kantus wire, version 1: what the studio bridge carries between Kantus.exe on the summoner's PC and this world, and
// the words the studio answers with. The transport itself (HTTP and SSE) is built elsewhere; this file holds the shared
// vocabulary: the world's id and place, the token rules, the body limits, the Capabilities path rules and the
// StudioLink port the world is given.

import { createHash, timingSafeEqual } from "node:crypto";

export const KANTUS_WORLD_ID = "kantus";
/** The one place in this world: the summoner's studio composer pane in Kantus.exe. */
export const KANTUS_PLACE = "kantus:studio";
/** Every route but evidence and the capabilities sync reads at most this many bytes of JSON. */
export const BODY_LIMIT = 64 * 1024;
/** The evidence route (a base64 PNG) and the capabilities sync (a whole folder of markdown) read at most this many bytes. */
export const LARGE_BODY_LIMIT = 10 * 1024 * 1024;
/** The studio's token must be at least this many bytes. */
export const MIN_TOKEN_BYTES = 32;

/** A refusal of the wire: the HTTP status and the short error code the studio reads. */
export class WireError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "WireError";
  }
}

export function fail(status: number, code: string): never {
  throw new WireError(status, code);
}

/** A token is compared by its SHA-256 digests, so the comparison takes the same time whatever the lengths. */
export function tokensEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left, "utf8").digest(),
    createHash("sha256").update(right, "utf8").digest(),
  );
}

/**
 * Whether a studio token may be used: present, at least MIN_TOKEN_BYTES bytes, and not equal to any other token the body
 * holds. Returns the plain reason it may not, or null when it may.
 */
export function tokenProblem(token: string, otherTokens: readonly string[]): "missing" | "too_short" | "matches_other" | null {
  if (token.trim() === "") return "missing";
  if (Buffer.byteLength(token, "utf8") < MIN_TOKEN_BYTES) return "too_short";
  if (otherTokens.some((other) => other !== "" && tokensEqual(token, other))) return "matches_other";
  return null;
}

// ---------------------------------------------------------------------------------------------------
// The Capabilities folder: the markdown sheets Kantus.exe exports, read and written by relative path only.

/** A path under Capabilities/: letters, digits, "_", ".", "/" and "-", and nothing else. */
export const CAPABILITY_PATH_PATTERN = /^[A-Za-z0-9_./-]+$/;
/** A capability path is at most this long. */
export const CAPABILITY_PATH_MAX = 300;
/** The one path shape a Stage 2 summary may be written to. */
export const OVERVIEW_PATH_PATTERN = /^VST3\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/Overview\.md$/;

/**
 * A capability path as the folder keeps it: a relative path, segment by segment, with no empty segment (so no leading
 * "/", no "//", no trailing "/"), no "." or ".." segment, and a ".md" file name at the end. A leading "Capabilities/"
 * is dropped, since that is the folder's own name on the summoner's PC and the shell that calls the tool often says it.
 * Throws WireError for every other shape. The returned path is the normalised one: its segments, joined by "/".
 */
export function capabilityPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > CAPABILITY_PATH_MAX
    || !CAPABILITY_PATH_PATTERN.test(value)) fail(400, "bad_path");
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) fail(400, "bad_path");
  if (segments[0] === "Capabilities") segments.shift();
  const last = segments[segments.length - 1] ?? "";
  if (!last.endsWith(".md") || last === ".md") fail(400, "bad_path");
  return segments.join("/");
}

/** The one path a summary may be written to, VST3/<Vendor>/<Plugin>/Overview.md. Throws WireError otherwise. */
export function overviewPath(value: unknown): string {
  const path = capabilityPath(value);
  if (!OVERVIEW_PATH_PATTERN.test(path)) fail(400, "bad_path");
  return path;
}

// ---------------------------------------------------------------------------------------------------
// The studio's operations, in the three groups the tools offer.

/** The read-only CommandService ops kantus_read may run. */
export const READ_OPS: ReadonlySet<string> = new Set([
  "state.get", "state.summary", "session.arrangementSheet", "session.scoreSheet", "player.inspectRegion", "player.listStyles",
  "library.listPatches", "plugin.listCatalog", "plugin.listParams", "plugin.listPresets", "region.read", "midi.list", "chord.list",
  "marker.list", "comment.list", "automation.getTrackMode", "snapshot.list", "render.status", "arrange.getState", "tool.get",
]);

/** The quantitative and visual ops kantus_analyze may run: safe to repeat, so a lost answer may be asked for again. */
export const ANALYZE_OPS: ReadonlySet<string> = new Set([
  "analysis.measure", "analysis.measureEdit", "analysis.evaluate", "analysis.lintScore", "analysis.masking",
  "analysis.renderEvidence", "ui.screenshot",
]);

/** The mutating CommandService ops kantus_act may run, by name. */
export const ACT_OPS: ReadonlySet<string> = new Set([
  "batch.apply", "library.loadPatch", "ui.highlight", "render.export", "project.save",
]);

/** The mutating CommandService ops kantus_act may run, by the group they belong to. */
export const ACT_PREFIXES: readonly string[] = [
  "snapshot.", "player.", "compose.", "midi.", "track.", "clip.", "region.", "plugin.", "mixer.", "automation.", "transport.",
  "cycle.", "marker.", "comment.", "history.",
];

export function isReadOp(op: string): boolean {
  return READ_OPS.has(op);
}

export function isAnalyzeOp(op: string): boolean {
  return ANALYZE_OPS.has(op);
}

/** A mutating op: in an act group, and never one of the reads or analyses that happen to share a prefix. */
export function isActOp(op: string): boolean {
  if (isReadOp(op) || isAnalyzeOp(op)) return false;
  return ACT_OPS.has(op) || ACT_PREFIXES.some((prefix) => op.startsWith(prefix) && op.length > prefix.length);
}

// ---------------------------------------------------------------------------------------------------
// The StudioLink: the one port the world needs. A later task implements it over HTTP and SSE; tests give it a fake.

/** What the studio reports about itself right now. */
export type StudioStatus = {
  /** Whether Kantus.exe is connected to this world at this moment. */
  attached: boolean;
  /** The studio's live mode: RW may act, RO reads only, STOP has the summoner's stop on. */
  mode?: "RW" | "RO" | "STOP";
  /** The open project, by its name. */
  project?: string;
  /** What the transport is doing. */
  transport?: "idle" | "playing" | "recording";
};

/** One thing the studio sends out of its own accord: a note, or a change in whether it is attached. */
export type StudioEvent = { channel: string; payload: Record<string, unknown>; atMs?: number };

/** The studio's answer to one request. */
export type StudioReply =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: string; reason: string };

/**
 * The bridge to Kantus.exe, injected so the world is testable without a live DAW. `send` carries one channel's request
 * and resolves with the studio's answer; `status` says what the studio is doing now; `onEvent` subscribes to what the
 * studio sends unasked, and returns the way to unsubscribe. The optional signal lets the summoner's stop end a request.
 */
export interface StudioLink {
  send(channel: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<StudioReply>;
  status(): StudioStatus;
  onEvent(handler: (event: StudioEvent) => void): () => void;
}
