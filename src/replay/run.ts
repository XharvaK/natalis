// `natalis replay`: copies an entity, cuts the copy to the moment the events begin, opens it on a virtual clock, and
// feeds it the events one at a time. Every say and every wake it schedules is written to transcript.jsonl. Nothing
// is delivered to any world, and the original entity folder is never written.

import { existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ModelPort, SecretScanner, WorldEvent } from "../contracts.js";
import { loadEntityConfig, type EntityConfig } from "../entity/config.js";
import { openEntity } from "../entity/runtime.js";
import { modelFromConfig, modelKeyEnvs } from "../model/from-config.js";
import { createSecretScanner } from "../secrets/index.js";
import { copyForReplay } from "./copy.js";
import { readEventFile, TRANSCRIPT_FILE, type CapturedEvent } from "./files.js";
import { replayModel } from "./model.js";
import { ReplayRecorder, ReplayWorld } from "./world.js";

const DEFAULT_MAX_MODEL_FAILURES = 3;
const DEFAULT_RETRY_DELAYS_MS = [1_000];

export type ReplayOptions = {
  /** The entity folder to copy. It is only read. */
  dir: string;
  eventsPath: string;
  /** The run folder. Must not exist, or be empty. Gets entity/ and transcript.jsonl. */
  outDir: string;
  /** A replacement entity.json, such as another model. */
  configPath?: string;
  /** Builds the model from the copy's config. Defaults to the real one from entity.json. */
  modelFor?: (config: EntityConfig) => ModelPort;
  scanner?: SecretScanner;
  /** Failed model calls before the replay stops. */
  maxModelFailures?: number;
  retryDelaysMs?: number[];
};

export type ReplayResult = {
  entityDir: string;
  transcriptPath: string;
  eventsFed: number;
  eventsTotal: number;
  says: number;
  wakes: number;
  modelFailures: number;
  /** Set when the replay stopped before the last event. Plain words. */
  stoppedEarly?: string;
  /** The copy's river last seq when the replay ended. */
  lastSeq: number;
};

export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  const events = readEventFile(options.eventsPath);
  if (events.length === 0) throw new Error("The events file holds no events, so there is nothing to replay.");
  const outDir = resolve(options.outDir);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} is not empty. Choose a new output folder.`);
  }
  const entityDir = join(outDir, "entity");
  const transcriptPath = join(outDir, TRANSCRIPT_FILE);
  const first = events[0] as CapturedEvent;

  await copyForReplay({
    from: resolve(options.dir),
    to: entityDir,
    cutAtMs: first.atMs,
    ...(options.configPath === undefined ? {} : { configPath: resolve(options.configPath) }),
  });
  const config = loadEntityConfig(entityDir);
  const inner = options.modelFor === undefined ? modelFromConfig(config.model) : options.modelFor(config);
  const scanner = options.scanner ?? scannerForConfig(config);

  const recorder = new ReplayRecorder(transcriptPath, first.atMs);
  const worlds = new Map<string, ReplayWorld>();
  for (const event of events) {
    if (!worlds.has(event.world)) worlds.set(event.world, new ReplayWorld(event.world, recorder, worlds.size === 0));
  }

  // A model that keeps failing would keep the entity retrying forever. After a few failed calls, the replay stops.
  const maxFailures = options.maxModelFailures ?? DEFAULT_MAX_MODEL_FAILURES;
  let failures = 0;
  let giveUp: (reason: string) => void = () => undefined;
  const gaveUp = new Promise<string>((resolveGive) => {
    giveUp = resolveGive;
  });
  const model = replayModel(inner, (message) => {
    failures += 1;
    if (failures >= maxFailures) {
      giveUp(`the model failed ${failures} times; the last error: ${message.slice(0, 200)}`);
    }
  });

  const entity = await openEntity({
    dir: entityDir,
    config,
    model,
    worlds: [...worlds.values()],
    nowMs: () => recorder.now(),
    scanner,
    retryDelaysMs: options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
    purpose: "replay",
  });

  let fed = 0;
  let stoppedEarly: string | undefined;
  let lastSeq = 0;
  try {
    await entity.start();
    for (const event of events) {
      recorder.advanceTo(event.atMs);
      const world = worlds.get(event.world);
      if (world === undefined) throw new Error(`No replay world for ${event.world}.`);
      world.feed(toWorldEvent(event));
      fed += 1;
      const outcome = await Promise.race([entity.idle().then(() => undefined), gaveUp]);
      if (outcome !== undefined) {
        stoppedEarly = outcome;
        break;
      }
    }
    lastSeq = entity.river.lastSeq();
  } finally {
    await entity.stop();
  }

  return {
    entityDir,
    transcriptPath,
    eventsFed: fed,
    eventsTotal: events.length,
    says: recorder.counts().says,
    wakes: recorder.counts().wakes,
    modelFailures: failures,
    ...(stoppedEarly === undefined ? {} : { stoppedEarly }),
    lastSeq,
  };
}

function toWorldEvent(event: CapturedEvent): WorldEvent {
  const out: WorldEvent = {
    world: event.world,
    place: event.place,
    thread: event.thread,
    source: event.source,
    atMs: event.atMs,
  };
  if (event.actor !== undefined) out.actor = event.actor;
  if (event.text !== undefined) out.text = event.text;
  if (event.data !== undefined) out.data = event.data;
  return out;
}

/** The secret scanner, knowing the model keys the environment holds. The keys are read by reference only. */
function scannerForConfig(config: EntityConfig): SecretScanner {
  const keys = modelKeyEnvs(config.model, config.worldModels)
    .map((name) => process.env[name])
    .filter((key): key is string => key !== undefined && key.length >= 8);
  return createSecretScanner({ knownValues: keys });
}
