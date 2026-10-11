// Builds a ModelPort from a plain config block. The key is read by reference: the config names an environment
// variable, and the value is never written into the config, an error, or a log.

import { withEmulatedTools } from "./emulated-tools.js";
import { createOpenAICompatiblePort } from "./openai-compatible.js";
import type { ModelPort } from "../contracts.js";

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
  const port = createOpenAICompatiblePort({
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey,
    contextTokens: config.contextTokens,
    nativeTools: config.nativeTools,
    effortParam: config.effortParam,
    timeoutMs: config.timeoutMs,
  });
  return config.nativeTools === false ? withEmulatedTools(port) : port;
}
