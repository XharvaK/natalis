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
  /**
   * A backup for when the main model cannot answer (rate limited, unavailable, unreachable or no reply in time). It
   * uses the same baseUrl, key, context size, timeout and tool setting as the main model.
   */
  fallback?: FallbackModelConfig;
};

export type FallbackModelConfig = {
  /** The backup's model name. */
  model: string;
  /** The effort field the backup gets effort in. Left out, the main model's effortParam is used. */
  effortParam?: "reasoning_effort" | null;
  /** True when the backup can see pictures. Otherwise it gets the request without them, and a plain line in their place. */
  vision?: boolean;
  /** The backup's effort, in the same values as the entity's effort. Left out, the request's own effort is used. */
  effort?: NonNullable<ModelRequest["effort"]>;
  /** The backup's context window in tokens. Left out, it is the main model's. A request too big for it is not sent to it. */
  contextTokens?: number;
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
  };
  const primary = withEmulated(createOpenAICompatiblePort(connection), config);
  if (config.fallback === undefined) return primary;
  const backup = withEmulated(
    createOpenAICompatiblePort({
      ...connection,
      model: config.fallback.model,
      effortParam: config.fallback.effortParam ?? config.effortParam,
      contextTokens: config.fallback.contextTokens ?? config.contextTokens,
    }),
    config,
  );
  return withBackup({
    primary,
    backup,
    backupName: config.fallback.model,
    backupSeesPictures: config.fallback.vision === true,
    ...(config.fallback.effort === undefined ? {} : { backupEffort: config.fallback.effort }),
    ...(config.fallback.contextTokens === undefined ? {} : { backupContextTokens: config.fallback.contextTokens }),
  });
}

function withEmulated(port: ModelPort, config: ModelConfig): ModelPort {
  return config.nativeTools === false ? withEmulatedTools(port) : port;
}

/** A world's own model, as entity.json's worldModels gives it. */
export type WorldModelSpec = { model: string; effort?: NonNullable<ModelRequest["effort"]>; vision?: boolean };

/**
 * One port per world that has a model of its own. Each uses the main model's service, key, context and timeout, and
 * falls back to the main model itself (at the entity's effort) when it cannot answer.
 */
export function worldModelsFromConfig(
  main: ModelConfig,
  mainEffort: ModelRequest["effort"] | undefined,
  worlds: Record<string, WorldModelSpec> | undefined,
  env: Record<string, string | undefined> = process.env,
): Record<string, ModelPort> {
  const ports: Record<string, ModelPort> = {};
  for (const [world, spec] of Object.entries(worlds ?? {})) {
    const port = modelFromConfig({
      ...main,
      model: spec.model,
      vision: spec.vision === true,
      fallback: {
        model: main.model,
        ...(mainEffort === undefined ? {} : { effort: mainEffort }),
        ...(main.vision === undefined ? {} : { vision: main.vision }),
      },
    }, env);
    // The look tool is offered on the main model's word; a world model that cannot see gets a plain line instead.
    ports[world] = spec.vision === true
      ? port
      : { info: port.info, complete: (request, signal) => port.complete(withoutPictures(request), signal) };
  }
  return ports;
}
