#!/usr/bin/env node
// The natalis command line. `natalis chat --dir <entityDir>` opens a conversation with an entity on the terminal.
// Ctrl+C stops the entity cleanly: the river and state are closed and the next start picks up where this one stopped.

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { loadEntityConfig } from "../entity/config.js";
import { openEntity, type Entity } from "../entity/runtime.js";
import { modelFromConfig } from "../model/from-config.js";
import { createSecretScanner } from "../secrets/index.js";
import { createCliWorld } from "../worlds/cli.js";
import { dispatchCommand } from "./commands/index.js";
import { forgetCommand } from "./commands/forget.js";
import { runCommand } from "./commands/run.js";
import { stopCommand } from "./commands/stop.js";

const USAGE = "Usage: natalis chat|run|stop|forget|import|capture|replay|judge|backup|restore|unseal --dir <entity folder>";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "stop") return stopCommand(rest, console.log, console.error);
  if (command === "forget") return forgetCommand(rest, console.log, console.error);
  if (command === "run") return runCommand(rest, console.log, console.error);
  const dispatched = await dispatchCommand(command, rest);
  if (dispatched !== undefined) return dispatched;
  if (command !== "chat") {
    console.error(USAGE);
    return 2;
  }
  const dirArg = flagValue(rest, "--dir");
  if (dirArg === undefined) {
    console.error(USAGE);
    return 2;
  }

  const dir = resolve(dirArg);
  const config = loadEntityConfig(dir);
  // The key is read by reference and registered as a known value, so it never reaches the model or a say.
  const keyName = config.model.apiKeyEnv;
  const key = keyName === undefined ? undefined : process.env[keyName];
  const scanner = createSecretScanner({ knownValues: key !== undefined && key.length >= 8 ? [key] : [] });
  const model = modelFromConfig(config.model);

  const output = process.stdout;
  let rl: ReturnType<typeof createInterface> | undefined;
  const cli = createCliWorld({
    onSay: (_place, text) => {
      output.write(`\n${config.name ?? "Lar"}: ${text}\n`);
      if (rl !== undefined) rl.prompt(true);
    },
  });

  const entity: Entity = await openEntity({ dir, config, model, worlds: [cli], scanner });
  const closed = new Promise<void>((resolveClosed) => {
    rl = createInterface({ input: process.stdin, output, prompt: "you> " });
    rl.on("line", (line) => {
      const text = line.trim();
      if (text === "") {
        rl?.prompt();
        return;
      }
      cli.send(text);
    });
    rl.on("SIGINT", () => rl?.close());
    rl.on("close", () => resolveClosed());
  });

  await entity.start();
  output.write(`Chatting with ${config.name ?? "an unnamed Lar"}. Type a line and press Enter. Ctrl+C stops.\n`);
  rl?.prompt();
  await closed;
  await entity.stop();
  return 0;
}

function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === name) return args[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`natalis: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
