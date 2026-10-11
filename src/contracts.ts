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

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** JSON Schema object describing a tool's arguments. */
export type JsonSchema = Record<string, unknown>;

export type ToolSpec = { name: string; description: string; parameters: JsonSchema };

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
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Milliseconds from request to full response. */
  latencyMs: number;
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

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "rate_limit" | "unavailable" | "bad_request" | "timeout" | "malformed" | "aborted",
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

export interface River {
  append(row: RiverRowInput): RiverRow;
  read(query: RiverQuery): RiverRow[];
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

export type TurnResult = {
  turnId: string;
  thread: string;
  endedBy: TurnEndReason;
  modelCalls: number;
  toolCalls: number;
  receipts: Array<{ tool: string; receipt: Receipt }>;
  /** Free text the model wrote outside tool calls (her thinking aloud); kept, never sent anywhere. */
  thoughts: string[];
  error?: string;
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
};

export type SayResult = Receipt;

export interface World {
  readonly id: string;
  /** Connect and start sending events. Resolves once the world is ready. */
  start(emit: (event: WorldEvent) => void): Promise<void>;
  stop(): Promise<void>;
  /** Deliver words to a place in this world. The receipt says delivered, or why not. */
  say(place: string, text: string, options?: { replyTo?: string }): Promise<SayResult>;
  /** Extra tools this world offers (react, act_in_game, ...). */
  tools(): Tool[];
  /** One or two plain lines for the now board: connected or not, places open. */
  now(): string;
}
