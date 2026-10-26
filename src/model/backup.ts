// A backup model: when the main model cannot answer, one more call goes to the backup. The wrapper is a plain port, so
// the loop above sees the same ModelResponse shape; the response says which model answered (servedBy) and why the main
// one did not (mainError), so the loop can write both into the river. Only a service failure moves the call to the
// backup: a caller's abort, a refused key or a refused request is final and is never sent to another model.

import { ModelError, type ChatMessage, type QuotaWindow, type ModelPort, type ModelRequest, type ModelResponse } from "../contracts.js";

/** The line that stands in for a picture the backup model cannot see. */
export const PICTURE_STAND_IN = "[A picture was here; the backup model cannot see it.]";

/**
 * The failures that mean the service did not answer: rate limits, spent credit or quota, unavailable or unreachable, and
 * no reply in time. A refused key or request is not among them.
 */
const SERVICE_FAILURES: ReadonlySet<string> = new Set(["rate_limit", "out_of_credit", "unavailable", "timeout"]);

/** How many failed turns a port remembers. Turns run one per thread at a time, so a few are plenty. */
const HELD_TURNS = 16;

/** The same rough size the context assembly uses: characters divided by 4. */
const CHARS_PER_TOKEN = 4;

export type BackupOptions = {
  primary: ModelPort;
  backup: ModelPort;
  /** The backup's configured name, written into servedBy and the river note. */
  backupName: string;
  /** False: the backup gets the request without its pictures, each replaced by PICTURE_STAND_IN. */
  backupSeesPictures: boolean;
  /** Effort for the backup's request. Left out, the request's own effort (the main model's) is used. */
  backupEffort?: ModelRequest["effort"];
  /**
   * The backup's context window in tokens. Left out, the request is sent as it is. When given, a request estimated to
   * be larger is not sent to the backup: the backup is not tried and the error says why, rather than overflowing it.
   */
  backupContextTokens?: number;
};

/**
 * After the main model fails in a turn, the rest of that turn's calls go straight to the backup, so they do not wait out
 * the main model's retries again. The next turn tries the main model first. A call with no turn is never held.
 */
export function withBackup(options: BackupOptions): ModelPort {
  /** The turns whose main model failed, each with that failure, said once more on each call it sends to the backup. */
  const held = new Map<string, { message: string; quota?: QuotaWindow }>();
  return {
    info: options.primary.info,
    routing: () => ({
      // A new turn always tries the main model first, so as a turn starts the main model takes its calls.
      onBackup: false,
      backup: options.backupName,
      ...(options.backupEffort === undefined ? {} : { backupEffort: options.backupEffort }),
    }),
    async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      let mainError: ModelError;
      const earlier = request.turnId === undefined ? undefined : held.get(request.turnId);
      if (earlier !== undefined) {
        mainError = new ModelError(
          `it failed earlier in this turn (${earlier.message}), so this call went to the backup`,
          "unavailable",
          0,
          earlier.quota,
        );
      } else {
        try {
          return await options.primary.complete(request, signal);
        } catch (err) {
          if (!isServiceFailure(err) || signal?.aborted) throw err;
          mainError = err;
          if (request.turnId !== undefined) {
            held.set(request.turnId, err.quota === undefined ? { message: err.message } : { message: err.message, quota: err.quota });
            // Only the newest turns are kept: an older turn has ended long ago.
            for (const turnId of held.keys()) {
              if (held.size <= HELD_TURNS) break;
              held.delete(turnId);
            }
          }
        }
      }
      const sent = toBackupRequest(request, options);
      if (options.backupContextTokens !== undefined) {
        const estimate = estimateTokens(sent);
        if (estimate > options.backupContextTokens) {
          throw new ModelError(
            `${mainError.message}. The backup model (${options.backupName}) was not tried: this request is about ${estimate} tokens, more than its ${options.backupContextTokens}-token context.`,
            mainError.kind,
            mainError.attempts,
            mainError.quota,
          );
        }
      }
      let answer: ModelResponse;
      try {
        answer = await options.backup.complete(sent, signal);
      } catch (backupErr) {
        if (backupErr instanceof ModelError) {
          throw new ModelError(
            `${backupErr.message}. The main model failed first: ${mainError.message}`,
            backupErr.kind,
            backupErr.attempts,
            bothResets(mainError.quota, backupErr.quota),
          );
        }
        throw backupErr;
      }
      // A backup's own backup names itself, and its own reason; this one's reason comes first.
      const why = answer.mainError === undefined
        ? mainError.message
        : `${mainError.message}; then ${options.backupName}: ${answer.mainError}`;
      return { ...answer, servedBy: answer.servedBy ?? options.backupName, mainError: why };
    },
  };
}

/**
 * The window to wait for when both models are out: the earlier reset, since the next turn may be served by either. When
 * either reset is unknown, no reset is given (that model could come back at any time), but a named limit is kept.
 */
export function bothResets(main: QuotaWindow | undefined, backup: QuotaWindow | undefined): QuotaWindow | undefined {
  const limit = backup?.limit ?? main?.limit;
  const resetAtMs =
    main?.resetAtMs !== undefined && backup?.resetAtMs !== undefined ? Math.min(main.resetAtMs, backup.resetAtMs) : undefined;
  if (limit === undefined && resetAtMs === undefined) return undefined;
  return { ...(limit === undefined ? {} : { limit }), ...(resetAtMs === undefined ? {} : { resetAtMs }) };
}

function isServiceFailure(err: unknown): err is ModelError {
  return err instanceof ModelError && SERVICE_FAILURES.has(err.kind);
}

/** The request as the backup gets it: its effort, and no pictures unless the backup can see them. */
function toBackupRequest(request: ModelRequest, options: BackupOptions): ModelRequest {
  const withEffort: ModelRequest =
    options.backupEffort === undefined ? request : { ...request, effort: options.backupEffort };
  return options.backupSeesPictures ? withEffort : withoutPictures(withEffort);
}

/** The same request with each picture replaced by a plain line in the same message. Nothing else changes. */
export function withoutPictures(request: ModelRequest): ModelRequest {
  return {
    ...request,
    messages: request.messages.map((message): ChatMessage => {
      if (message.role !== "user" || message.images === undefined || message.images.length === 0) return message;
      const lines = message.images.map(() => PICTURE_STAND_IN).join("\n");
      const content = message.content.trim() === "" ? lines : `${message.content}\n${lines}`;
      return { role: "user", content };
    }),
  };
}

/**
 * A rough token count for the text of a request: messages, tool-call arguments, tool descriptions, and the output
 * allowance. Pictures are not counted (their size is the model's to say), so a picture-bearing request to a small
 * vision backup can be under-counted.
 */
export function estimateTokens(request: ModelRequest): number {
  let chars = 0;
  for (const message of request.messages) {
    if (message.role === "assistant") {
      chars += (message.content ?? "").length;
      for (const call of message.toolCalls ?? []) chars += call.name.length + call.arguments.length;
    } else {
      chars += message.content.length;
    }
  }
  for (const tool of request.tools ?? []) chars += JSON.stringify(tool).length;
  return Math.ceil(chars / CHARS_PER_TOKEN) + (request.maxOutputTokens ?? 0);
}
