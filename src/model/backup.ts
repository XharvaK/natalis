// A backup model: when the main model cannot answer, one more call goes to the backup. The wrapper is a plain port, so
// the loop above sees the same ModelResponse shape; the response says which model answered (servedBy) so the loop can
// write it into the river. Only a service failure moves the call to the backup: a caller's abort, a refused key or a
// refused request is final and is never sent to another model.

import { ModelError, type ChatMessage, type ModelPort, type ModelRequest, type ModelResponse } from "../contracts.js";

/** The line that stands in for a picture the backup model cannot see. */
export const PICTURE_STAND_IN = "[A picture was here; the backup model cannot see it.]";

/**
 * The failures that mean the service did not answer: rate limits, spent credit or quota, unavailable or unreachable, and
 * no reply in time. A refused key or request is not among them.
 */
const SERVICE_FAILURES: ReadonlySet<string> = new Set(["rate_limit", "out_of_credit", "unavailable", "timeout"]);

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
  /** After the main model fails, how long calls go straight to the backup before the main one is tried again. Default 10 minutes. */
  holdMs?: number;
  /** The clock. Injected in tests. */
  nowMs?: () => number;
};

/** How long, after the main model failed, calls go straight to the backup. A turn's later calls do not wait out the main model's retries again. */
export const BACKUP_HOLD_MS = 10 * 60_000;

export function withBackup(options: BackupOptions): ModelPort {
  const now = options.nowMs ?? Date.now;
  const holdMs = options.holdMs ?? BACKUP_HOLD_MS;
  /** Until this time, the main model is skipped: it failed a moment ago. */
  let skipMainUntil = 0;
  return {
    info: options.primary.info,
    routing: () => ({
      onBackup: now() < skipMainUntil,
      backup: options.backupName,
      ...(options.backupEffort === undefined ? {} : { backupEffort: options.backupEffort }),
    }),
    async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      try {
        if (now() < skipMainUntil) {
          throw new ModelError(
            `the main model failed less than ${Math.round(holdMs / 60_000)} minutes ago, so this call went to the backup`,
            "unavailable",
            0,
          );
        }
        const answer = await options.primary.complete(request, signal);
        skipMainUntil = 0;
        return answer;
      } catch (err) {
        if (!isServiceFailure(err) || signal?.aborted) throw err;
        if (now() >= skipMainUntil) skipMainUntil = now() + holdMs;
        const sent = toBackupRequest(request, options);
        if (options.backupContextTokens !== undefined) {
          const estimate = estimateTokens(sent);
          if (estimate > options.backupContextTokens) {
            throw new ModelError(
              `${err.message}. The backup model (${options.backupName}) was not tried: this request is about ${estimate} tokens, more than its ${options.backupContextTokens}-token context.`,
              err.kind,
              err.attempts,
            );
          }
        }
        let answer: ModelResponse;
        try {
          answer = await options.backup.complete(sent, signal);
        } catch (backupErr) {
          if (backupErr instanceof ModelError) {
            throw new ModelError(
              `${backupErr.message}. The main model failed first: ${err.message}`,
              backupErr.kind,
              backupErr.attempts,
            );
          }
          throw backupErr;
        }
        return { ...answer, servedBy: options.backupName };
      }
    },
  };
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
