// The contracts every part of Natalis is built against. The model is the mind; everything here is body:
// storage, a model port, tools that act and return receipts. Nothing in these types judges meaning.

// ---------------------------------------------------------------------------------------------------
// Model port: one interface over any OpenAI-compatible service or local server (bring your own key).

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON text as the model wrote it. Parsing and validation happen at the tool, not here. */
  arguments: string;
};

/** A picture the model sees: sent as an image part with its message. Bytes are base64, never a file path. */
export type ImagePart = { type: "image"; mime: string; dataBase64: string };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: ImagePart[] }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: ToolCall[];
      /** Provider fields that carry the model's reasoning to its next call in the same turn. Opaque; never shown. */
      providerState?: Record<string, unknown>;
    }
  | { role: "tool"; toolCallId: string; content: string };

/** JSON Schema object describing a tool's arguments. */
export type JsonSchema = Record<string, unknown>;

/**
 * `safeWhenStopped` is body-only: it lets a world tool run while the owner's emergency stop is on. It is never
 * sent to the model; the runtime strips it from the spec it shows.
 */
export type ToolSpec = { name: string; description: string; parameters: JsonSchema; safeWhenStopped?: boolean };

export type ModelRequest = {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | "required";
  maxOutputTokens?: number;
  /** Provider-neutral effort hint; adapters map it or ignore it. */
  effort?: "low" | "medium" | "high" | "xhigh";
};

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

export type ModelResponse = {
  content: string | null;
  toolCalls: ToolCall[];
  finish: FinishReason;
  /** The token counts the provider reported for this call. Each count is absent when the provider did not send it. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    /** Prompt tokens the provider served from its cache, when it reports them (DeepSeek or OpenAI-style). */
    cacheHitTokens?: number;
    /** Prompt tokens the provider did not serve from its cache, when it reports that count. */
    cacheMissTokens?: number;
  };
  /** Milliseconds from request to full response. */
  latencyMs: number;
  /** The readable summary of the model's reasoning, when the provider sends one. */
  reasoning?: string;
  /** Opaque provider fields to send back with this message on the next call of the same turn. */
  providerState?: Record<string, unknown>;
  /**
   * Set only when a backup model answered in place of the main one: the backup's configured name. The loop writes a
   * river note from it, so the Lar can read which model answered. Absent when the main model answered.
   */
  servedBy?: string;
};

export type ModelInfo = {
  /** Stable id for logs, e.g. "commandcode:meta/muse-spark-1.3-contributor". */
  id: string;
  /** Declared context window in tokens. Context assembly sizes itself from this. */
  contextTokens: number;
  nativeTools: boolean;
};

export interface ModelPort {
  readonly info: ModelInfo;
  /** Retries transient provider failures itself (with backoff); throws ModelError when it gives up. */
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

/**
 * What went wrong with a model call. "out_of_credit" is the provider's refusal for spent credit or quota (HTTP 402, or a
 * 429 that names an insufficient quota): an outage, so the backup is tried and the summoner is told.
 */
export type ModelErrorKind =
  | "auth"
  | "rate_limit"
  | "out_of_credit"
  | "unavailable"
  | "bad_request"
  | "timeout"
  | "malformed"
  | "aborted";

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: ModelErrorKind,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

// ---------------------------------------------------------------------------------------------------
// River: one append-only log of everything the entity lives. Every other view derives from it.

/** Who a row comes from. "outside" text is data, never instructions. */
export type RiverSource = "owner" | "outside" | "self" | "body";

export type RiverKind =
  | "event" // something arrived from a world (a message, an observation, a wake)
  | "say" // the entity said something somewhere
  | "tool_call" // the entity called a tool
  | "receipt" // what a tool call did
  | "turn" // a turn started or ended (data says which and why)
  | "note" // body facts worth keeping (a restart, a model swap)
  | "tombstone"; // something was forgotten here; no text, ever

export type RiverRowInput = {
  thread: string; // e.g. "dm:owner", "room:<alias>", "world:domus", "self"
  kind: RiverKind;
  source: RiverSource;
  place?: string; // where it happened, if somewhere
  actor?: string; // who, as an alias (never a platform id)
  text?: string;
  data?: Record<string, unknown>;
  /** Defaults to now. */
  atMs?: number;
};

/** `forgotten` is true when the text and data were erased; the row itself stays. */
export type RiverRow = RiverRowInput & { seq: number; atMs: number; forgotten?: boolean };

export type RiverQuery = {
  thread?: string;
  kinds?: RiverKind[];
  /** Rows after this seq (exclusive): "what is new since I last looked". */
  sinceSeq?: number;
  /** Rows up to and including this seq. */
  untilSeq?: number;
  /** Rows at or after this time. */
  sinceMs?: number;
  limit?: number;
  /** Newest first when true. */
  newestFirst?: boolean;
};

export type RiverHit = { row: RiverRow; score: number };

/** A count takes a read's thread, kinds and bounds. It has no limit and no order, and reads no rows. */
export type RiverCountQuery = Pick<RiverQuery, "thread" | "kinds" | "sinceSeq" | "untilSeq" | "sinceMs">;

export interface River {
  append(row: RiverRowInput): RiverRow;
  read(query: RiverQuery): RiverRow[];
  /** How many rows a read with the same thread, kinds and bounds would return, counted without reading them. */
  count(query: RiverCountQuery): number;
  /** Full-text search over row text. Tombstoned rows never match. */
  search(text: string, options?: { limit?: number; thread?: string }): RiverHit[];
  /**
   * Erase the text and data of matching rows, keep their seq/time/thread/kind, and append one tombstone row.
   * Returns how many rows were erased. Used by the owner's forget and the entity's own forget.
   */
  forget(match: { seqs?: number[]; text?: string }, by: "owner" | "self", reason: string): number;
  lastSeq(): number;
  close(): void;
}

// ---------------------------------------------------------------------------------------------------
// Notebook: the entity's own folder of plain text, versioned with git. Every write is a commit with a reason.

export type NotebookAuthor = string; // "thread:dm:owner", "reflection", "owner", "importer", "body"

export type NotebookEntry = { path: string; bytes: number; modifiedMs: number; firstLine: string };

export interface Notebook {
  readonly root: string;
  read(path: string): string | null;
  write(path: string, text: string, reason: string, author: NotebookAuthor): Promise<void>;
  /** Replace exactly one occurrence of `find`. Throws NotebookError("not_found" | "ambiguous") otherwise. */
  edit(path: string, find: string, replace: string, reason: string, author: NotebookAuthor): Promise<void>;
  append(path: string, text: string, reason: string, author: NotebookAuthor): Promise<void>;
  /** Moves the file to trash/ (recoverable). Never deletes. */
  remove(path: string, reason: string, author: NotebookAuthor): Promise<void>;
  list(dir?: string): NotebookEntry[];
  /** Plain-text search across notebook files. */
  search(text: string, limit?: number): Array<{ path: string; line: number; text: string }>;
}

export class NotebookError extends Error {
  constructor(
    message: string,
    readonly kind: "bad_path" | "not_found" | "ambiguous" | "private" | "io",
  ) {
    super(message);
    this.name = "NotebookError";
  }
}

// ---------------------------------------------------------------------------------------------------
// Tools: the only way the mind acts. Each returns a receipt it can read.

export type Receipt = {
  ok: boolean;
  /** One short plain sentence of what happened, written for the entity to read. */
  summary: string;
  data?: Record<string, unknown>;
  /** Present when the body refused or held the act; the reason is plain words. */
  refused?: { reason: string; code: string };
  /**
   * Pictures the model should see on its next call, once. The loop sends them and never writes them to the record
   * or back into the tool message.
   */
  images?: ImagePart[];
};

export type ToolContext = {
  thread: string;
  turnId: string;
  nowMs: number;
  river: River;
  notebook: Notebook;
  signal?: AbortSignal;
};

export interface Tool {
  readonly spec: ToolSpec;
  /** `args` is already JSON-parsed; the tool validates its own fields and refuses with a receipt. */
  run(args: Record<string, unknown>, context: ToolContext): Promise<Receipt>;
}

// ---------------------------------------------------------------------------------------------------
// Turn: one waking of one thread. The loop runs until the entity ends it or reaches the ceiling.

export type TurnEndReason = "end_turn" | "no_tool_call" | "ceiling" | "model_error" | "aborted";

/** Token counts as the provider reported them, summed over a turn's calls. A count nobody reported is absent. */
export type TokenCount = { prompt?: number; completion?: number; total?: number };

export type TurnResult = {
  turnId: string;
  thread: string;
  endedBy: TurnEndReason;
  modelCalls: number;
  toolCalls: number;
  receipts: Array<{ tool: string; receipt: Receipt }>;
  /** Free text the model wrote outside tool calls (the Lar's thinking aloud); kept, never sent anywhere. */
  thoughts: string[];
  error?: string;
  /** The kind of model failure when the turn ended on one. */
  errorKind?: ModelErrorKind;
  /** The model port's id, and the effort asked for, as the turn's end row records them. */
  model: string;
  effort?: NonNullable<ModelRequest["effort"]>;
  /** Tokens for every call of the turn that reported any. Absent when no call reported any. */
  tokens?: TokenCount;
  /** Prompt tokens served from the provider's cache, summed over the turn's calls that reported them. Absent when none did. */
  cacheHitTokens?: number;
  /** Prompt tokens not served from the cache, summed over the calls that reported them. Absent when none did. */
  cacheMissTokens?: number;
  /** The part of `tokens` that the backup model answered. Absent when the backup answered no call that reported any. */
  backupTokens?: TokenCount;
  /** True when the backup model answered at least one call of the turn. */
  backupUsed: boolean;
};

export type Ceiling = {
  /** Most model calls in one turn. */
  maxModelCalls: number;
  /** Most tool calls in one turn. */
  maxToolCalls: number;
};

// ---------------------------------------------------------------------------------------------------
// Context: what one turn sees. Sections are assembled by the body and sized from the model window.

export type ContextSection = {
  name: string; // "constitution", "character", "now", "time", "index", "recall", "thread", "event"
  text: string;
  /** Lower is dropped first when the window is short. Core sections are never dropped. */
  priority: number;
  core?: boolean;
};

// ---------------------------------------------------------------------------------------------------
// Secrets: a byte check, never a judgment.

export type SecretHit = { kind: string; start: number; end: number };

export interface SecretScanner {
  scan(text: string): SecretHit[];
  /** Replace every hit and every known vault value with a placeholder. */
  redact(text: string): string;
}

// ---------------------------------------------------------------------------------------------------
// Worlds: where the entity lives (Discord, a game, the command line). A world sends events in and offers
// tools out. It never filters events for relevance; what matters is the mind's judgment.

/**
 * Places are world-prefixed aliases, never platform ids: "discord:dm:owner", "discord:room:general",
 * "cli:owner", "domus:home". The thread of an event is its place unless the world says otherwise.
 */
export type WorldEvent = {
  world: string;
  place: string;
  /** Defaults to `place`. */
  thread?: string;
  /** Alias of who it came from: "owner", a person's alias, "game". Never a platform id. */
  actor?: string;
  source: RiverSource;
  text?: string;
  data?: Record<string, unknown>;
  atMs?: number;
  /** Whether this event wakes its thread. Defaults to true. */
  wake?: boolean;
  /**
   * A full view of the world's state, named by a key that is the same for every event of one kind of view on a thread.
   * A turn shows only the newest row of each key in full; every older row with the key shows its brief instead.
   */
  view?: string;
  /** The short text an older row with the same view key shows in its place. "An earlier view." when there is none. */
  brief?: string;
};

export type SayResult = Receipt;

/** A picture to send with words: a file the body holds on its shelf, named as the Lar named it. */
export type SayFile = { path: string; name: string; mime: string };

export type PictureRef = { id: string; mime: string; bytes: number; name: string };

/** What a world gets from the body: its own way to put a picture on the Lar's shelf. Worlds never write the folder. */
export type WorldBody = {
  keepPicture(input: { bytes: Uint8Array; name: string; from: { world: string; place: string } }): PictureRef;
  /**
   * The body's check of words before they leave the entity: a url, a header, a body, a command, a picture's name.
   * Undefined when nothing holds them. A world refuses the act when this answers, and never sends it anyway.
   */
  outwardHold(texts: readonly string[]): OutwardHold | undefined;
};

/** Why the body holds words before they leave: a word on the summoner's privacy list, or a list that cannot be read. */
export type OutwardHold = { kind: "term"; term: string; category: string } | { kind: "unreadable"; problem: string };

export interface World {
  readonly id: string;
  /** Connect and start sending events; `body` is how a world keeps pictures. Resolves once the world is ready. */
  start(emit: (event: WorldEvent) => void, body: WorldBody): Promise<void>;
  stop(): Promise<void>;
  /**
   * Called once each time the summoner's emergency stop turns on, after the body has noticed it. Outward work this world
   * still has running ends here; its receipt says the stop ended it.
   */
  onStop?(): void | Promise<void>;
  /**
   * Deliver words to a place in this world. Pictures in `files` go with the words; a world that cannot carry them
   * refuses the whole say. The receipt says delivered, or why not.
   */
  say(place: string, text: string, options?: { replyTo?: string; files?: SayFile[] }): Promise<SayResult>;
  /** True when a place is the owner's own place in this world (the owner's DM, the command line). Default: not. */
  isOwnerPlace?(place: string): boolean;
  /** Extra tools this world offers (react, act_in_game, ...). */
  tools(): Tool[];
  /** One or two plain lines for the now board: connected or not, places open. */
  now(): string;
  /** One stable line saying what this world is and which places in it are hers, for "who you are". */
  about?(): string;
  /**
   * The Lar's forget of words, for the text this world keeps outside the river (the runtime calls it after the river and
   * the state). Returns how many rows it erased. A world that keeps no such text does not define it.
   */
  forget?(words: string[]): number;
}
