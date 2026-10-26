// Builds a ModelPort from a plain config block. The key is read by reference: the config names an environment
// variable, and the value is never written into the config, an error, or a log.

import { withEmulatedTools } from "./emulated-tools.js";
import { createOpenAICompatiblePort, type OpenAICompatibleOptions } from "./openai-compatible.js";
import { withBackup, withoutPictures } from "./backup.js";
import type { ModelPort, ModelRequest } from "../contracts.js";

export type ModelConfig = {
  baseUrl: string;
  model: string;
  /** Name of the environment variable holding the key. Omit for a keyless local server. */
  apiKeyEnv?: string;
  contextTokens: number;
  nativeTools?: boolean;
  effortParam?: "reasoning_effort" | null;
  timeoutMs?: number;
  /** True when the model can see pictures. Only then is the look tool offered to the Lar. Never assumed. */
  vision?: boolean;
  /** Send provider cache marks on the parts of a prompt that stay the same (see cache-marks.ts). Default false. */
  cacheMarks?: boolean;
  /**
   * A backup for when the main model cannot answer (rate limited, out of credit, unavailable, unreachable or no reply in
   * time). Left to itself it uses the main model's service, key, headers, context size, timeout and tool setting; it can
   * name a service of its own, and a backup of its own.
   */
  fallback?: FallbackModelConfig;
  /** What the provider charges for this model, for the cost on the now board. Absent by default: no cost is shown. */
  price?: ModelPrice;
  /** The protocol: "chat" (/chat/completions, the default) or "responses" (/responses, for a model served only there). */
  api?: "chat" | "responses";
  /** Extra request headers the service asks for, such as a workspace id, a session id or a user agent. Never the key. */
  headers?: Record<string, string>;
  /** Wire values for the entity's efforts when this model's levels differ, e.g. { "xhigh": "max" }. This model's only. */
  effortMap?: EffortMap;
  /**
   * Ask for replies as a stream (chat protocol only), so a model that goes silent is noticed after idleTimeoutMs and its
   * backup can answer. timeoutMs still bounds the whole call. Default false.
   */
  stream?: boolean;
  /**
   * With stream on: the longest silence before a call fails as a timeout. Default 120000. A backup without a stream that
   * inherits it uses it to cap its first try only; after a cut the next try gets the full timeoutMs.
   */
  idleTimeoutMs?: number;
};

/** The entity's efforts mapped to the values one model takes on the wire. */
export type EffortMap = Partial<Record<NonNullable<ModelRequest["effort"]>, string>>;

/** A price per million tokens, in whatever currency the summoner uses. Only the summoner sets it. */
export type ModelPrice = { inputPerMillion: number; outputPerMillion: number };

export type FallbackModelConfig = {
  /** The backup's model name. */
  model: string;
  /** What the backup's provider charges for it, per million tokens. Absent by default: its tokens are not priced. */
  price?: ModelPrice;
  /** The effort field the backup gets effort in. Left out, the main model's effortParam is used. */
  effortParam?: "reasoning_effort" | null;
  /** True when the backup can see pictures. Otherwise it gets the request without them, and a plain line in their place. */
  vision?: boolean;
  /** Cache marks for the backup. Left out, the main model's setting is used. */
  cacheMarks?: boolean;
  /** The backup's effort, in the same values as the entity's effort. Left out, the request's own effort is used. */
  effort?: NonNullable<ModelRequest["effort"]>;
  /** The backup's context window in tokens. Left out, it is the main model's. A request too big for it is not sent to it. */
  contextTokens?: number;
  /** The backup's protocol. Left out, the main model's. */
  api?: "chat" | "responses";
  /** The backup's own effort map. Left out, none: the main model's map is not used for another model. */
  effortMap?: EffortMap;
  /**
   * The backup's own service. Given, the backup takes no key and no headers from the model above it: it uses only its own
   * apiKeyEnv and headers, so one service's key or workspace id never reaches another. Left out, the service above it.
   */
  baseUrl?: string;
  /** The backup's key variable. With no baseUrl of its own, left out means the key of the model above it. */
  apiKeyEnv?: string;
  /** The backup's request headers. With no baseUrl of its own, left out means the headers of the model above it. */
  headers?: Record<string, string>;
  /** Streaming for the backup. Left out, the setting of the model above it (a responses model never streams). */
  stream?: boolean;
  /** A backup for this backup, tried when it cannot answer either. Its settings fall back to this backup's. */
  fallback?: FallbackModelConfig;
};

export function modelFromConfig(
  config: ModelConfig,
  env: Record<string, string | undefined> = process.env,
): ModelPort {
  let apiKey: string | undefined;
  if (config.apiKeyEnv) {
    const value = env[config.apiKeyEnv];
    if (value === undefined || value === "") {
      throw new Error(
        `Model config names the environment variable ${config.apiKeyEnv} for its key, but it is not set.`,
      );
    }
    apiKey = value;
  }
  const connection: OpenAICompatibleOptions = {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey,
    contextTokens: config.contextTokens,
    nativeTools: config.nativeTools,
    effortParam: config.effortParam,
    timeoutMs: config.timeoutMs,
    cacheMarks: config.cacheMarks,
    api: config.api,
    headers: config.headers,
    effortMap: config.effortMap,
    stream: config.stream,
    idleTimeoutMs: config.idleTimeoutMs,
  };
  const primary = withEmulated(createOpenAICompatiblePort(connection), config);
  if (config.fallback === undefined) return primary;
  // The backup is a model block of its own, built the same way, so a backup of the backup chains on behind it.
  const backup = modelFromConfig(backupConfig(config, config.fallback), env);
  return withBackup({
    primary,
    backup,
    backupName: config.fallback.model,
    backupSeesPictures: config.fallback.vision === true,
    ...(config.fallback.effort === undefined ? {} : { backupEffort: config.fallback.effort }),
    ...(config.fallback.contextTokens === undefined ? {} : { backupContextTokens: config.fallback.contextTokens }),
  });
}

/**
 * Every key variable the model block, its backup chain and the worlds' backup chains name: the main model's first, each
 * once. The secret scanner learns all of their values, not only the main model's.
 */
export function modelKeyEnvs(main: ModelConfig, worlds?: Record<string, WorldModelSpec>): string[] {
  const names: string[] = [];
  const walk = (config: ModelConfig): void => {
    if (config.apiKeyEnv !== undefined && !names.includes(config.apiKeyEnv)) names.push(config.apiKeyEnv);
    if (config.fallback !== undefined) walk(backupConfig(config, config.fallback));
  };
  walk(main);
  const { fallback: _mainChain, ...service } = main;
  for (const spec of Object.values(worlds ?? {})) {
    if (spec.fallback !== undefined) walk(backupConfig(service, spec.fallback));
  }
  return names;
}

/** The backup as a model block: its own settings, and those of the model above it where it names none. */
function backupConfig(above: ModelConfig, backup: FallbackModelConfig): ModelConfig {
  const ownService = backup.baseUrl !== undefined;
  const apiKeyEnv = ownService ? backup.apiKeyEnv : (backup.apiKeyEnv ?? above.apiKeyEnv);
  const headers = ownService ? backup.headers : (backup.headers ?? above.headers);
  const api = backup.api ?? above.api;
  const cacheMarks = backup.cacheMarks ?? above.cacheMarks;
  const effortParam = backup.effortParam === undefined ? above.effortParam : backup.effortParam;
  const stream = backup.stream ?? above.stream;
  return {
    baseUrl: backup.baseUrl ?? above.baseUrl,
    model: backup.model,
    contextTokens: backup.contextTokens ?? above.contextTokens,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(headers === undefined ? {} : { headers }),
    ...(above.nativeTools === undefined ? {} : { nativeTools: above.nativeTools }),
    ...(effortParam === undefined ? {} : { effortParam }),
    ...(above.timeoutMs === undefined ? {} : { timeoutMs: above.timeoutMs }),
    ...(above.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: above.idleTimeoutMs }),
    ...(stream === undefined ? {} : { stream }),
    ...(cacheMarks === undefined ? {} : { cacheMarks }),
    ...(api === undefined ? {} : { api }),
    ...(backup.effortMap === undefined ? {} : { effortMap: backup.effortMap }),
    ...(backup.vision === undefined ? {} : { vision: backup.vision }),
    ...(backup.fallback === undefined ? {} : { fallback: backup.fallback }),
  };
}

function withEmulated(port: ModelPort, config: ModelConfig): ModelPort {
  return config.nativeTools === false ? withEmulatedTools(port) : port;
}

/** A world's own model, as entity.json's worldModels gives it. */
export type WorldModelSpec = {
  model: string;
  effort?: NonNullable<ModelRequest["effort"]>;
  vision?: boolean;
  /** The world model's protocol. Left out, the main model's. */
  api?: "chat" | "responses";
  /** The world model's own effort map. Left out, none. */
  effortMap?: EffortMap;
  /** The world model's own backup chain. Left out, its backup is the main model at the entity's effort. */
  fallback?: FallbackModelConfig;
};

/**
 * One port per world that has a model of its own. Each uses the main model's service, key, headers, context and timeout, and
 * falls back to its own backup chain when it names one, otherwise to the main model itself (at the entity's effort).
 */
export function worldModelsFromConfig(
  main: ModelConfig,
  mainEffort: ModelRequest["effort"] | undefined,
  worlds: Record<string, WorldModelSpec> | undefined,
  env: Record<string, string | undefined> = process.env,
): Record<string, ModelPort> {
  const ports: Record<string, ModelPort> = {};
  for (const [world, spec] of Object.entries(worlds ?? {})) {
    const { effortMap: mainEffortMap, ...service } = main;
    const port = modelFromConfig({
      ...service,
      model: spec.model,
      vision: spec.vision === true,
      ...(spec.api === undefined ? {} : { api: spec.api }),
      ...(spec.effortMap === undefined ? {} : { effortMap: spec.effortMap }),
      fallback: spec.fallback ?? {
        model: main.model,
        api: main.api ?? "chat",
        ...(mainEffortMap === undefined ? {} : { effortMap: mainEffortMap }),
        ...(mainEffort === undefined ? {} : { effort: mainEffort }),
        ...(main.vision === undefined ? {} : { vision: main.vision }),
      },
    }, env);
    // The look tool is offered on the main model's word; a world model that cannot see gets a plain line instead.
    ports[world] = spec.vision === true
      ? port
      : {
        info: port.info,
        complete: (request, signal) => port.complete(withoutPictures(request), signal),
        ...(port.routing === undefined ? {} : { routing: port.routing }),
      };
  }
  return ports;
}
